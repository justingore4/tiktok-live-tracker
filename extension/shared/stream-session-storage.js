(function initializeStreamSessionStorage(root, factory) {
  const streamSessionStorage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamSessionStorage;
  }

  root.TikTokLiveTrackerStreamSessionStorage = streamSessionStorage;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamSessionStorageModule() {
    "use strict";

    const STORAGE_KEY = "tiktokLiveTracker.streamSession";
    const STORAGE_SCHEMA_VERSION = 1;

    class StreamSessionStorageError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "StreamSessionStorageError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new StreamSessionStorageError(code, message, { cause });
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function requireExactKeys(value, expectedKeys) {
      if (!isPlainRecord(value)) {
        fail(
          "INVALID_STORAGE_ENVELOPE",
          "The stored stream-session value must be an object.",
        );
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail(
          "INVALID_STORAGE_ENVELOPE",
          "The stored stream-session value must contain exactly: " +
            `${sortedExpectedKeys.join(", ")}.`,
        );
      }
    }

    function hydrateState(streamSession, candidate) {
      try {
        return streamSession.hydrateStreamSessionState(candidate);
      } catch (error) {
        const unsupportedVersion =
          error?.code === "UNSUPPORTED_STREAM_SESSION_STATE_VERSION";

        fail(
          unsupportedVersion
            ? "UNSUPPORTED_STREAM_SESSION_VERSION"
            : "INVALID_STREAM_SESSION_STATE",
          unsupportedVersion
            ? "The stored stream-session state version is not supported."
            : "The stored stream-session state is invalid.",
          error,
        );
      }
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Stream-session storage options are required.");
      }

      const { storageArea, streamSession } = options;

      if (
        !storageArea ||
        typeof storageArea.get !== "function" ||
        typeof storageArea.set !== "function"
      ) {
        throw new TypeError(
          "storageArea must provide Promise-based get and set methods.",
        );
      }

      if (
        !streamSession ||
        typeof streamSession.hydrateStreamSessionState !== "function"
      ) {
        throw new TypeError(
          "streamSession must provide hydrateStreamSessionState.",
        );
      }

      return { storageArea, streamSession };
    }

    function createStreamSessionStateStore(options) {
      const { storageArea, streamSession } = validateDependencies(options);

      async function loadState() {
        let storedValues;

        try {
          storedValues = await storageArea.get(STORAGE_KEY);
        } catch (error) {
          fail(
            "STORAGE_READ_FAILED",
            "Could not read the active stream from browser storage.",
            error,
          );
        }

        if (!isPlainRecord(storedValues)) {
          fail(
            "STORAGE_READ_FAILED",
            "Browser storage returned an invalid response.",
          );
        }

        if (!Object.prototype.hasOwnProperty.call(storedValues, STORAGE_KEY)) {
          return null;
        }

        const envelope = storedValues[STORAGE_KEY];

        requireExactKeys(envelope, ["schemaVersion", "sessionState"]);

        if (
          !Number.isSafeInteger(envelope.schemaVersion) ||
          envelope.schemaVersion < 1
        ) {
          fail(
            "INVALID_STORAGE_ENVELOPE",
            "The stream-session storage schema version must be a safe integer.",
          );
        }

        if (envelope.schemaVersion !== STORAGE_SCHEMA_VERSION) {
          fail(
            "UNSUPPORTED_STORAGE_VERSION",
            `Stream-session storage schema version ${envelope.schemaVersion} is not supported.`,
          );
        }

        return hydrateState(streamSession, envelope.sessionState);
      }

      async function saveState(state) {
        const sessionState = hydrateState(streamSession, state);
        const envelope = {
          schemaVersion: STORAGE_SCHEMA_VERSION,
          sessionState,
        };

        try {
          await storageArea.set({ [STORAGE_KEY]: envelope });
        } catch (error) {
          fail(
            "STORAGE_WRITE_FAILED",
            "Could not save the active stream to browser storage.",
            error,
          );
        }
      }

      return Object.freeze({ loadState, saveState });
    }

    return Object.freeze({
      STORAGE_KEY,
      STORAGE_SCHEMA_VERSION,
      StreamSessionStorageError,
      createStreamSessionStateStore,
    });
  },
);
