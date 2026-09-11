(function initializeStreamSessionController(root, factory) {
  const streamSessionController = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamSessionController;
  }

  root.TikTokLiveTrackerStreamSessionController = streamSessionController;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamSessionControllerModule() {
    "use strict";

    const PHASES = Object.freeze({
      IDLE: "idle",
      LOADING: "loading",
      READY: "ready",
      SAVING: "saving",
      ERROR: "error",
    });
    const OPERATIONS = Object.freeze({
      LOAD: "load",
      START: "start",
      END: "end",
    });

    class StreamSessionControllerError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StreamSessionControllerError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new StreamSessionControllerError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function cloneSerializable(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Controller options are required.");
      }

      const { client } = options;
      const validClient =
        client &&
        [
          "endStream",
          "getSession",
          "startStream",
        ].every(
          (methodName) => typeof client[methodName] === "function",
        );

      if (!validClient) {
        throw new TypeError(
          "client must provide getSession, startStream, and endStream methods.",
        );
      }

      return client;
    }

    function requireResponse(value) {
      if (
        !isPlainRecord(value) ||
        !isPlainRecord(value.state) ||
        !(value.result === null || isPlainRecord(value.result)) ||
        value.state.version !== 1 ||
        !(
          value.state.activeSession === null ||
          isPlainRecord(value.state.activeSession)
        )
      ) {
        fail(
          "INVALID_CLIENT_RESPONSE",
          "The stream-session service returned invalid data.",
        );
      }

      const activeSession = value.state.activeSession;

      if (
        activeSession !== null &&
        (
          typeof activeSession.streamId !== "string" ||
          activeSession.streamId.trim() === "" ||
          typeof activeSession.startedAt !== "string" ||
          Number.isNaN(Date.parse(activeSession.startedAt)) ||
          activeSession.identitySource !== "local_session"
        )
      ) {
        fail(
          "INVALID_CLIENT_RESPONSE",
          "The stream-session service returned invalid data.",
        );
      }

      return cloneSerializable(value);
    }

    function normalizeError(error, scope) {
      const knownCode =
        error && typeof error.code === "string" && error.code.trim() !== "";
      const knownMessage =
        error &&
        typeof error.message === "string" &&
        error.message.trim() !== "";

      return {
        scope,
        code: knownCode ? error.code : "STREAM_SESSION_FAILED",
        message: knownCode && knownMessage
          ? error.message
          : scope === OPERATIONS.LOAD
            ? "The active tracker stream could not be restored. Nothing was changed."
            : "The tracker stream change could not be saved. Nothing was changed.",
      };
    }

    function createStreamSessionController(options) {
      const client = validateDependencies(options);
      const listeners = new Set();
      let phase = PHASES.IDLE;
      let operation = null;
      let error = null;
      let activeSession = null;
      let resumed = false;
      let started = false;
      let activePromise = null;
      let retryDescriptor = null;

      function createSnapshot() {
        return {
          phase,
          operation,
          busy: phase === PHASES.LOADING || phase === PHASES.SAVING,
          error: error === null ? null : { ...error },
          activeSession:
            activeSession === null ? null : cloneSerializable(activeSession),
          resumed,
        };
      }

      function publish() {
        listeners.forEach((listener) => {
          try {
            listener(createSnapshot());
          } catch (_error) {
            // A UI subscriber must not interrupt persistence or other listeners.
          }
        });
      }

      function transition(nextPhase, nextOperation, nextError = null) {
        phase = nextPhase;
        operation = nextOperation;
        error = nextError;
        publish();
      }

      function acceptResponse(response, nextResumed) {
        const parsed = requireResponse(response);

        activeSession = parsed.state.activeSession;
        resumed = activeSession === null ? false : nextResumed;
      }

      function failOperation(descriptor, failure) {
        retryDescriptor = descriptor;
        transition(
          PHASES.ERROR,
          descriptor.operation,
          normalizeError(failure, descriptor.operation),
        );
        return createSnapshot();
      }

      async function perform(descriptor) {
        transition(
          descriptor.operation === OPERATIONS.LOAD
            ? PHASES.LOADING
            : PHASES.SAVING,
          descriptor.operation,
        );

        try {
          const response = await descriptor.execute();

          acceptResponse(response, descriptor.nextResumed);
          retryDescriptor = null;
          transition(PHASES.READY, descriptor.operation);
          return createSnapshot();
        } catch (failure) {
          return failOperation(descriptor, failure);
        }
      }

      function begin(descriptor) {
        if (activePromise) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current stream-session operation to finish.",
          );
        }

        const execution = Promise.resolve().then(() => perform(descriptor));
        const tracked = execution.finally(() => {
          if (activePromise === tracked) {
            activePromise = null;
          }
        });

        activePromise = tracked;
        return tracked;
      }

      function createLoadDescriptor() {
        return Object.freeze({
          operation: OPERATIONS.LOAD,
          nextResumed: false,
          execute: () => client.getSession(),
        });
      }

      function start() {
        if (started) {
          return activePromise ?? Promise.resolve(createSnapshot());
        }

        started = true;
        return begin(createLoadDescriptor());
      }

      function startNewStream() {
        if (activePromise || phase !== PHASES.READY) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current stream-session operation to finish.",
          );
        }

        if (activeSession !== null) {
          fail(
            "STREAM_ALREADY_ACTIVE",
            "Resume or end the active tracker stream before starting another.",
          );
        }

        return begin(
          Object.freeze({
            operation: OPERATIONS.START,
            nextResumed: true,
            execute: () => client.startStream(),
          }),
        );
      }

      function resumeActiveStream() {
        if (activePromise || phase !== PHASES.READY) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current stream-session operation to finish.",
          );
        }

        if (activeSession === null) {
          fail("NO_ACTIVE_STREAM", "There is no tracker stream to resume.");
        }

        resumed = true;
        publish();
        return createSnapshot();
      }

      function endActiveStream() {
        if (activePromise || phase !== PHASES.READY) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current stream-session operation to finish.",
          );
        }

        if (activeSession === null) {
          fail("NO_ACTIVE_STREAM", "There is no tracker stream to end.");
        }

        const streamId = activeSession.streamId;

        return begin(
          Object.freeze({
            operation: OPERATIONS.END,
            nextResumed: false,
            execute: () => client.endStream({ streamId }),
          }),
        );
      }

      function retry() {
        if (activePromise || retryDescriptor === null) {
          return activePromise ?? Promise.resolve(createSnapshot());
        }

        return begin(retryDescriptor);
      }

      function subscribe(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("subscribe requires a listener function.");
        }

        listeners.add(listener);
        try {
          listener(createSnapshot());
        } catch (_error) {
          // Match later publications: a faulty observer cannot stop the app.
        }
        let subscribed = true;

        return function unsubscribe() {
          if (!subscribed) {
            return;
          }

          subscribed = false;
          listeners.delete(listener);
        };
      }

      return Object.freeze({
        endActiveStream,
        getSnapshot: createSnapshot,
        resumeActiveStream,
        retry,
        start,
        startNewStream,
        subscribe,
      });
    }

    return {
      OPERATIONS,
      PHASES,
      StreamSessionControllerError,
      createStreamSessionController,
    };
  },
);
