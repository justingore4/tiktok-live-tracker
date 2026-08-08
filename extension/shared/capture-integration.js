(function initializeCaptureIntegration(root, factory) {
  const captureIntegration = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = captureIntegration;
  }

  root.TikTokLiveTrackerCaptureIntegration = captureIntegration;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createCaptureIntegrationModule() {
    "use strict";

    class CaptureIntegrationError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "CaptureIntegrationError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new CaptureIntegrationError(code, message, { cause });
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
        throw new TypeError("Capture-integration options are required.");
      }

      const {
        activeStreamCoordinator,
        captureProtocol,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      } = options;

      if (
        !captureProtocol ||
        !captureProtocol.EVENT_TYPES ||
        typeof captureProtocol.createCaptureMessage !== "function" ||
        typeof captureProtocol.validateCaptureMessage !== "function"
      ) {
        throw new TypeError("A valid capture protocol is required.");
      }

      if (
        !reconciliationCoordinator ||
        !reconciliationCoordinator.COMMAND_TYPES ||
        reconciliationCoordinator.COMMAND_TYPES.OBSERVE_VARIATIONS !==
          "observe_variations" ||
        reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE !==
          "record_payment_complete"
      ) {
        throw new TypeError("A valid reconciliation coordinator module is required.");
      }

      if (!stateCoordinator || typeof stateCoordinator.dispatch !== "function") {
        throw new TypeError("A reconciliation state coordinator is required.");
      }

      if (
        !streamSession ||
        typeof streamSession.hydrateStreamSessionState !== "function"
      ) {
        throw new TypeError("A valid stream-session module is required.");
      }

      if (
        !streamSessionCoordinator ||
        !streamSessionCoordinator.COMMAND_TYPES ||
        streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION !==
          "get_stream_session"
      ) {
        throw new TypeError("A valid stream-session coordinator module is required.");
      }

      if (
        !activeStreamCoordinator ||
        typeof activeStreamCoordinator.dispatch !== "function"
      ) {
        throw new TypeError("An active-stream coordinator is required.");
      }

      return {
        activeStreamCoordinator,
        captureProtocol,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      };
    }

    function createCaptureIntegration(options) {
      const {
        activeStreamCoordinator,
        captureProtocol,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      } = validateDependencies(options);
      let eventTail = Promise.resolve();

      function snapshotEvent(event) {
        return captureProtocol.validateCaptureMessage(
          captureProtocol.createCaptureMessage(event),
        );
      }

      async function resolveActiveStreamId() {
        const response = await activeStreamCoordinator.dispatch({
          type:
            streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION,
        });
        let state;

        try {
          state = streamSession.hydrateStreamSessionState(response?.state);
        } catch (error) {
          fail(
            "ACTIVE_STREAM_STATE_UNAVAILABLE",
            "The active tracker stream could not be verified.",
            error,
          );
        }

        if (state.activeSession === null) {
          fail(
            "NO_ACTIVE_STREAM",
            "Start or resume a tracker stream before capturing Sold Items.",
          );
        }

        return state.activeSession.streamId;
      }

      async function executeEvent(event) {
        const streamId = await resolveActiveStreamId();
        let command;

        switch (event.type) {
          case captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES.OBSERVE_VARIATIONS,
              streamId,
              variationNumbers: event.variationNumbers,
            };
            break;
          case captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
              streamId,
              variationNumber: event.variationNumber,
              soldPriceCents: event.soldPriceCents,
            };
            break;
          default:
            fail(
              "UNKNOWN_CAPTURE_EVENT",
              `Capture event ${event.type} is not supported.`,
            );
        }

        await stateCoordinator.dispatch(command);

        return { status: "accepted" };
      }

      function dispatch(event) {
        let eventSnapshot;

        try {
          eventSnapshot = snapshotEvent(event);
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = eventTail.then(() => executeEvent(eventSnapshot));

        eventTail = execution.catch(() => undefined);
        return execution;
      }

      return Object.freeze({ dispatch });
    }

    return Object.freeze({
      CaptureIntegrationError,
      createCaptureIntegration,
    });
  },
);
