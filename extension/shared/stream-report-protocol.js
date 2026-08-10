(function initializeStreamReportProtocol(root, factory) {
  const streamReportProtocol = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamReportProtocol;
  }

  root.TikTokLiveTrackerStreamReportProtocol = streamReportProtocol;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamReportProtocolModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.stream-report";
    const MESSAGE_VERSION = 1;
    const REPORT_ID_PATTERN =
      /^stream-report:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const COMMAND_TYPES = Object.freeze({
      LIST_REPORTS: "list_reports",
      GET_REPORT: "get_report",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.LIST_REPORTS]: ["type"],
      [COMMAND_TYPES.GET_REPORT]: ["reportId", "type"],
    });

    class StreamReportProtocolError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StreamReportProtocolError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new StreamReportProtocolError(code, message);
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
      return actualKeys.length === sortedExpectedKeys.length &&
        actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
    }

    function validateCommand(command) {
      if (!isPlainRecord(command) || typeof command.type !== "string") {
        fail(
          "INVALID_COMMAND",
          "A stream-report command object with a type is required.",
        );
      }

      const expectedKeys = COMMAND_KEYS[command.type];

      if (!expectedKeys) {
        fail(
          "UNKNOWN_COMMAND",
          `Stream-report command ${command.type} is not supported.`,
        );
      }

      if (!hasExactKeys(command, expectedKeys)) {
        fail(
          "INVALID_COMMAND",
          `Stream-report command ${command.type} has an invalid shape.`,
        );
      }

      if (
        command.type === COMMAND_TYPES.GET_REPORT &&
        (
          typeof command.reportId !== "string" ||
          !REPORT_ID_PATTERN.test(command.reportId)
        )
      ) {
        fail("INVALID_REPORT_ID", "The stream report ID is invalid.");
      }

      return command;
    }

    function cloneSerializable(value) {
      try {
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          fail(
            "INVALID_MESSAGE",
            "Stream-report messages must contain only JSON-serializable values.",
          );
        }

        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof StreamReportProtocolError) {
          throw error;
        }

        fail(
          "INVALID_MESSAGE",
          "Stream-report messages must contain only JSON-serializable values.",
        );
      }
    }

    function snapshotCommand(command) {
      validateCommand(command);
      const snapshot = cloneSerializable(command);
      validateCommand(snapshot);
      return snapshot;
    }

    function validateStreamReportMessage(message) {
      if (
        !hasExactKeys(message, ["channel", "command", "version"]) ||
        message.channel !== MESSAGE_CHANNEL
      ) {
        fail("INVALID_MESSAGE", "The stream-report message has an invalid shape.");
      }

      if (!Number.isSafeInteger(message.version) || message.version < 1) {
        fail(
          "INVALID_MESSAGE",
          "The stream-report message version must be a positive integer.",
        );
      }

      if (message.version !== MESSAGE_VERSION) {
        fail(
          "UNSUPPORTED_MESSAGE_VERSION",
          `Stream-report message version ${message.version} is not supported.`,
        );
      }

      return snapshotCommand(message.command);
    }

    function createStreamReportMessage(command) {
      const message = {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        command: snapshotCommand(command),
      };

      validateStreamReportMessage(message);
      return message;
    }

    return Object.freeze({
      COMMAND_TYPES,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      REPORT_ID_PATTERN,
      StreamReportProtocolError,
      createStreamReportMessage,
      validateCommand,
      validateStreamReportMessage,
    });
  },
);
