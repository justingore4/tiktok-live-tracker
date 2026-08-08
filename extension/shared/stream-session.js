(function initializeStreamSession(root, factory) {
  const streamSession = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamSession;
  }

  root.TikTokLiveTrackerStreamSession = streamSession;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamSessionModule() {
    "use strict";

    const STREAM_SESSION_STATE_VERSION = 1;
    const LOCAL_STREAM_ID_PREFIX = "local-stream:";
    const LOCAL_STREAM_ID_PATTERN =
      /^local-stream:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const IDENTITY_SOURCES = Object.freeze({
      LOCAL_SESSION: "local_session",
    });

    class StreamSessionError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StreamSessionError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new StreamSessionError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function requireExactKeys(value, expectedKeys, path) {
      if (!isPlainRecord(value)) {
        fail("INVALID_STREAM_SESSION_STATE", `${path} must be an object.`);
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail(
          "INVALID_STREAM_SESSION_STATE",
          `${path} must contain exactly: ${sortedExpectedKeys.join(", ")}.`,
        );
      }
    }

    function requireLocalStreamId(value, path) {
      if (
        typeof value !== "string" ||
        value !== value.trim() ||
        !LOCAL_STREAM_ID_PATTERN.test(value)
      ) {
        fail(
          "INVALID_STREAM_SESSION_STATE",
          `${path} must be a non-empty local stream identifier.`,
        );
      }

      return value;
    }

    function requireCanonicalTimestamp(value, path) {
      if (typeof value !== "string") {
        fail(
          "INVALID_STREAM_SESSION_STATE",
          `${path} must be a UTC ISO timestamp.`,
        );
      }

      const parsed = new Date(value);

      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString() !== value
      ) {
        fail(
          "INVALID_STREAM_SESSION_STATE",
          `${path} must be a UTC ISO timestamp.`,
        );
      }

      return value;
    }

    function hydrateActiveSession(value, path = "state.activeSession") {
      requireExactKeys(
        value,
        ["identitySource", "startedAt", "streamId"],
        path,
      );

      if (value.identitySource !== IDENTITY_SOURCES.LOCAL_SESSION) {
        fail(
          "INVALID_STREAM_SESSION_STATE",
          `${path}.identitySource must be local_session.`,
        );
      }

      return {
        streamId: requireLocalStreamId(value.streamId, `${path}.streamId`),
        startedAt: requireCanonicalTimestamp(
          value.startedAt,
          `${path}.startedAt`,
        ),
        identitySource: IDENTITY_SOURCES.LOCAL_SESSION,
      };
    }

    function createStreamSessionState() {
      return {
        version: STREAM_SESSION_STATE_VERSION,
        activeSession: null,
      };
    }

    function hydrateStreamSessionState(candidate) {
      requireExactKeys(candidate, ["activeSession", "version"], "state");

      if (!Number.isSafeInteger(candidate.version) || candidate.version < 1) {
        fail(
          "INVALID_STREAM_SESSION_STATE",
          "state.version must be a positive safe integer.",
        );
      }

      if (candidate.version !== STREAM_SESSION_STATE_VERSION) {
        fail(
          "UNSUPPORTED_STREAM_SESSION_STATE_VERSION",
          `Stream-session state version ${candidate.version} is not supported.`,
        );
      }

      return {
        version: STREAM_SESSION_STATE_VERSION,
        activeSession: candidate.activeSession === null
          ? null
          : hydrateActiveSession(candidate.activeSession),
      };
    }

    function requireMutableState(state) {
      hydrateStreamSessionState(state);
      return state;
    }

    function requireStartInput(input) {
      requireExactKeys(
        input,
        ["identitySource", "startedAt", "streamId"],
        "start input",
      );

      return hydrateActiveSession(input, "start input");
    }

    function requireEndInput(input) {
      requireExactKeys(input, ["streamId"], "end input");

      return requireLocalStreamId(input.streamId, "end input.streamId");
    }

    function startStream(state, input) {
      const mutableState = requireMutableState(state);

      if (mutableState.activeSession !== null) {
        fail(
          "ACTIVE_STREAM_ALREADY_EXISTS",
          "End the active stream before starting another one.",
        );
      }

      mutableState.activeSession = requireStartInput(input);

      return { status: "started" };
    }

    function endStream(state, input) {
      const mutableState = requireMutableState(state);
      const streamId = requireEndInput(input);

      if (mutableState.activeSession === null) {
        return { status: "already_ended" };
      }

      if (mutableState.activeSession.streamId !== streamId) {
        fail(
          "ACTIVE_STREAM_MISMATCH",
          "The requested stream is no longer the active stream.",
        );
      }

      mutableState.activeSession = null;

      return { status: "ended" };
    }

    return Object.freeze({
      IDENTITY_SOURCES,
      LOCAL_STREAM_ID_PREFIX,
      LOCAL_STREAM_ID_PATTERN,
      STREAM_SESSION_STATE_VERSION,
      StreamSessionError,
      createStreamSessionState,
      endStream,
      hydrateStreamSessionState,
      startStream,
    });
  },
);
