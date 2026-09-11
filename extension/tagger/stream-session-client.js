(function initializeStreamSessionClient(root, factory) {
  const streamSessionClient = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamSessionClient;
  }

  root.TikTokLiveTrackerStreamSessionClient = streamSessionClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamSessionClientModule() {
    "use strict";

    const REQUIRED_COMMAND_TYPES = Object.freeze([
      "GET_STREAM_SESSION",
      "START_STREAM",
      "END_STREAM",
    ]);
    const START_STATUSES = new Set(["started", "already_active"]);
    const LOCAL_STREAM_ID_PATTERN =
      /^local-stream:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const REPORT_ID_PATTERN =
      /^stream-report:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    class StreamSessionClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StreamSessionClientError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new StreamSessionClientError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function hasExactKeys(value, expectedKeys) {
      if (!isPlainRecord(value)) {
        return false;
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      return (
        actualKeys.length === sortedExpectedKeys.length &&
        actualKeys.every((key, index) => key === sortedExpectedKeys[index])
      );
    }

    function cloneSerializable(value, code, message) {
      try {
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          fail(code, message);
        }

        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof StreamSessionClientError) {
          throw error;
        }

        fail(code, message);
      }
    }

    function requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim() === "") {
        fail(
          "INVALID_CLIENT_COMMAND",
          `${fieldName} must be a non-empty string.`,
        );
      }

      return value.trim();
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Stream-session client options are required.");
      }

      const { runtime, protocol } = options;

      if (!runtime || typeof runtime.sendMessage !== "function") {
        throw new TypeError("runtime must provide sendMessage.");
      }

      if (
        !isPlainRecord(protocol) ||
        typeof protocol.MESSAGE_CHANNEL !== "string" ||
        protocol.MESSAGE_CHANNEL.trim() === "" ||
        !Number.isSafeInteger(protocol.MESSAGE_VERSION) ||
        protocol.MESSAGE_VERSION < 1 ||
        !isPlainRecord(protocol.COMMAND_TYPES)
      ) {
        throw new TypeError("A valid stream-session message protocol is required.");
      }

      const commandValues = REQUIRED_COMMAND_TYPES.map(
        (commandName) => protocol.COMMAND_TYPES[commandName],
      );

      if (
        commandValues.some(
          (commandType) =>
            typeof commandType !== "string" || commandType.trim() === "",
        ) ||
        new Set(commandValues).size !== commandValues.length
      ) {
        throw new TypeError(
          "The stream-session protocol is missing required command types.",
        );
      }

      return { runtime, protocol };
    }

    function isValidSession(value) {
      const startedAt = value?.startedAt;
      const parsedStartedAt =
        typeof startedAt === "string" ? new Date(startedAt) : null;

      return (
        hasExactKeys(value, ["identitySource", "startedAt", "streamId"]) &&
        typeof value.streamId === "string" &&
        LOCAL_STREAM_ID_PATTERN.test(value.streamId) &&
        parsedStartedAt !== null &&
        !Number.isNaN(parsedStartedAt.getTime()) &&
        parsedStartedAt.toISOString() === startedAt &&
        value.identitySource === "local_session"
      );
    }

    function isValidState(value) {
      return (
        hasExactKeys(value, ["activeSession", "version"]) &&
        value.version === 1 &&
        (value.activeSession === null || isValidSession(value.activeSession))
      );
    }

    function isValidResult(commandType, result, commandTypes, state) {
      if (commandType === commandTypes.GET_STREAM_SESSION) {
        return result === null;
      }

      if (commandType === commandTypes.START_STREAM) {
        return hasExactKeys(result, ["status"]) &&
          START_STATUSES.has(result.status) &&
          state.activeSession !== null;
      }

      if (commandType !== commandTypes.END_STREAM || state.activeSession !== null) {
        return false;
      }

      if (hasExactKeys(result, ["status"])) {
        return ["already_ended", "ended"].includes(result.status);
      }

      if (
        !hasExactKeys(result, [
          "reportId",
          "reportLifecycleStatus",
          "status",
        ])
      ) {
        return false;
      }

      const noReport = result.reportId === null &&
        result.reportLifecycleStatus === null;
      const savedReport =
        typeof result.reportId === "string" &&
        REPORT_ID_PATTERN.test(result.reportId) &&
        ["finalized", "pending_end"].includes(
          result.reportLifecycleStatus,
        );

      return (noReport || savedReport) &&
        ["already_ended", "ended"].includes(result.status);
    }

    function parseResponse(response, commandType, commandTypes) {
      try {
        if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
          fail(
            "INVALID_RESPONSE",
            "The stream-session service returned an invalid response.",
          );
        }

        if (response.ok) {
          if (
            !hasExactKeys(response, ["data", "ok"]) ||
            !hasExactKeys(response.data, ["result", "state"]) ||
            !isValidState(response.data.state) ||
            !isValidResult(
              commandType,
              response.data.result,
              commandTypes,
              response.data.state,
            )
          ) {
            fail(
              "INVALID_RESPONSE",
              "The stream-session service returned an invalid response.",
            );
          }

          return cloneSerializable(
            response.data,
            "INVALID_RESPONSE",
            "The stream-session service returned an invalid response.",
          );
        }

        if (
          !hasExactKeys(response, ["error", "ok"]) ||
          !hasExactKeys(response.error, ["code", "message"]) ||
          typeof response.error.code !== "string" ||
          response.error.code.trim() === "" ||
          typeof response.error.message !== "string" ||
          response.error.message.trim() === ""
        ) {
          fail(
            "INVALID_RESPONSE",
            "The stream-session service returned an invalid response.",
          );
        }

        throw new StreamSessionClientError(
          response.error.code,
          response.error.message,
        );
      } catch (error) {
        if (error instanceof StreamSessionClientError) {
          throw error;
        }

        fail(
          "INVALID_RESPONSE",
          "The stream-session service returned an invalid response.",
        );
      }
    }

    function createStreamSessionClient(options) {
      const { runtime, protocol } = validateDependencies(options);
      let commandTail = Promise.resolve();

      async function sendCommand(command) {
        const envelope = {
          channel: protocol.MESSAGE_CHANNEL,
          version: protocol.MESSAGE_VERSION,
          command,
        };
        let response;

        try {
          response = await runtime.sendMessage(envelope);
        } catch (_error) {
          fail(
            "RUNTIME_MESSAGE_FAILED",
            "Could not reach the stream-session service.",
          );
        }

        return parseResponse(
          response,
          command.type,
          protocol.COMMAND_TYPES,
        );
      }

      function enqueueCommand(createCommand) {
        let command;

        try {
          command = cloneSerializable(
            createCommand(),
            "INVALID_CLIENT_COMMAND",
            "The stream-session command must contain only JSON-serializable values.",
          );
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() => sendCommand(command));

        commandTail = execution.catch(() => undefined);
        return execution;
      }

      function getSession() {
        return enqueueCommand(() => ({
          type: protocol.COMMAND_TYPES.GET_STREAM_SESSION,
        }));
      }

      function startStream() {
        return enqueueCommand(() => ({
          type: protocol.COMMAND_TYPES.START_STREAM,
        }));
      }

      function endStream(optionsValue) {
        return enqueueCommand(() => {
          if (!hasExactKeys(optionsValue, ["streamId"])) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "Command options must contain exactly: streamId.",
            );
          }

          return {
            type: protocol.COMMAND_TYPES.END_STREAM,
            streamId: requireNonEmptyString(optionsValue.streamId, "streamId"),
          };
        });
      }

      return Object.freeze({
        endStream,
        getSession,
        startStream,
      });
    }

    return {
      StreamSessionClientError,
      createStreamSessionClient,
    };
  },
);
