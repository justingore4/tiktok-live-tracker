(function initializeStreamSessionCoordinator(root, factory) {
  const streamSessionCoordinator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamSessionCoordinator;
  }

  root.TikTokLiveTrackerStreamSessionCoordinator =
    streamSessionCoordinator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamSessionCoordinatorModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.stream-session";
    const MESSAGE_VERSION = 1;
    const COMMAND_TYPES = Object.freeze({
      GET_STREAM_SESSION: "get_stream_session",
      START_STREAM: "start_stream",
      END_STREAM: "end_stream",
      END_STREAM_WITHOUT_REPORT: "end_stream_without_report",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.GET_STREAM_SESSION]: ["type"],
      [COMMAND_TYPES.START_STREAM]: ["type"],
      [COMMAND_TYPES.END_STREAM]: ["streamId", "type"],
      [COMMAND_TYPES.END_STREAM_WITHOUT_REPORT]: ["streamId", "type"],
    });
    const REQUIRED_STREAM_SESSION_METHODS = Object.freeze([
      "createStreamSessionState",
      "hydrateStreamSessionState",
      "startStream",
      "endStream",
    ]);

    class StreamSessionCoordinatorError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "StreamSessionCoordinatorError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new StreamSessionCoordinatorError(code, message, { cause });
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Stream-session coordinator options are required.");
      }

      const { createId, now, stateStore, streamSession } = options;
      const validStreamSession =
        streamSession &&
        REQUIRED_STREAM_SESSION_METHODS.every(
          (methodName) => typeof streamSession[methodName] === "function",
        ) &&
        streamSession.IDENTITY_SOURCES &&
        streamSession.IDENTITY_SOURCES.LOCAL_SESSION === "local_session";

      if (!validStreamSession) {
        throw new TypeError("A valid stream-session module is required.");
      }

      if (
        !stateStore ||
        typeof stateStore.loadState !== "function" ||
        typeof stateStore.saveState !== "function"
      ) {
        throw new TypeError(
          "stateStore must provide Promise-based loadState and saveState methods.",
        );
      }

      if (typeof createId !== "function") {
        throw new TypeError("createId must be a function.");
      }

      if (typeof now !== "function") {
        throw new TypeError("now must be a function.");
      }

      return { createId, now, stateStore, streamSession };
    }

    function validateCommand(command) {
      if (!isPlainRecord(command) || typeof command.type !== "string") {
        fail(
          "INVALID_COMMAND",
          "A stream-session command object with a type is required.",
        );
      }

      const expectedKeys = COMMAND_KEYS[command.type];

      if (!expectedKeys) {
        fail(
          "UNKNOWN_COMMAND",
          `Stream-session command ${command.type} is not supported.`,
        );
      }

      const actualKeys = Object.keys(command).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail(
          "INVALID_COMMAND",
          `Stream-session command ${command.type} has an invalid shape.`,
        );
      }

      if (
        [
          COMMAND_TYPES.END_STREAM,
          COMMAND_TYPES.END_STREAM_WITHOUT_REPORT,
        ].includes(command.type) &&
        (typeof command.streamId !== "string" ||
          command.streamId.trim() === "")
      ) {
        fail(
          "INVALID_COMMAND",
          "end_stream streamId must be a non-empty string.",
        );
      }

      return command.type;
    }

    function cloneSerializable(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function snapshotCommand(command) {
      validateCommand(command);

      try {
        return cloneSerializable(command);
      } catch (_error) {
        fail(
          "INVALID_COMMAND",
          "The stream-session command must contain only JSON-serializable values.",
        );
      }
    }

    function createStreamSessionCoordinator(options) {
      const { createId, now, stateStore, streamSession } =
        validateDependencies(options);
      let loaded = false;
      let canonicalState = null;
      let commandTail = Promise.resolve();

      async function ensureLoaded() {
        if (loaded) {
          return;
        }

        const storedState = await stateStore.loadState();

        const candidateState = storedState === null
          ? streamSession.createStreamSessionState()
          : streamSession.hydrateStreamSessionState(storedState);
        canonicalState = streamSession.hydrateStreamSessionState(
          candidateState,
        );
        loaded = true;
      }

      function cloneCanonicalState() {
        return streamSession.hydrateStreamSessionState(canonicalState);
      }

      function createResponse(result = null) {
        return {
          state: cloneCanonicalState(),
          result: result === null ? null : cloneSerializable(result),
        };
      }

      function generateStartInput() {
        let streamId;
        let startedAt;

        try {
          streamId = createId();
        } catch (error) {
          fail(
            "STREAM_ID_GENERATION_FAILED",
            "Could not create a local stream identifier.",
            error,
          );
        }

        try {
          startedAt = now();
        } catch (error) {
          fail(
            "STREAM_TIME_GENERATION_FAILED",
            "Could not record the stream start time.",
            error,
          );
        }

        return {
          streamId,
          startedAt,
          identitySource: streamSession.IDENTITY_SOURCES.LOCAL_SESSION,
        };
      }

      async function startStream() {
        if (canonicalState.activeSession !== null) {
          return createResponse({ status: "already_active" });
        }

        const candidate = cloneCanonicalState();
        const result = streamSession.startStream(
          candidate,
          generateStartInput(),
        );

        await stateStore.saveState(candidate);
        canonicalState = candidate;

        return createResponse(result);
      }

      async function endStream(command) {
        const candidate = cloneCanonicalState();
        const result = streamSession.endStream(candidate, {
          streamId: command.streamId,
        });

        if (result.status === "already_ended") {
          return createResponse(result);
        }

        await stateStore.saveState(candidate);
        canonicalState = candidate;

        return createResponse(result);
      }

      async function executeCommand(command) {
        const commandType = validateCommand(command);

        await ensureLoaded();

        switch (commandType) {
          case COMMAND_TYPES.GET_STREAM_SESSION:
            return createResponse();
          case COMMAND_TYPES.START_STREAM:
            return startStream();
          case COMMAND_TYPES.END_STREAM:
          case COMMAND_TYPES.END_STREAM_WITHOUT_REPORT:
            return endStream(command);
          default:
            fail(
              "UNKNOWN_COMMAND",
              `Stream-session command ${commandType} is not supported.`,
            );
        }
      }

      function dispatch(command) {
        let commandSnapshot;

        try {
          commandSnapshot = snapshotCommand(command);
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() =>
          executeCommand(commandSnapshot),
        );

        commandTail = execution.catch(() => undefined);
        return execution;
      }

      return Object.freeze({ dispatch });
    }

    return Object.freeze({
      COMMAND_TYPES,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      StreamSessionCoordinatorError,
      createStreamSessionCoordinator,
    });
  },
);
