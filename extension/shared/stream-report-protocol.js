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
    const MAX_ACTIVE_REPORTS = 5;
    const MAX_ARCHIVED_REPORTS = 25;
    const MAX_TOTAL_REPORTS =
      MAX_ACTIVE_REPORTS + MAX_ARCHIVED_REPORTS;
    const REPORT_ID_PATTERN =
      /^stream-report:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const COMMAND_TYPES = Object.freeze({
      LIST_REPORTS: "list_reports",
      LIST_ARCHIVED_REPORTS: "list_archived_reports",
      GET_REPORT: "get_report",
      ARCHIVE_REPORTS: "archive_reports",
      RESTORE_REPORTS: "restore_reports",
      DELETE_ARCHIVED_REPORTS: "delete_archived_reports",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.LIST_REPORTS]: ["type"],
      [COMMAND_TYPES.LIST_ARCHIVED_REPORTS]: ["type"],
      [COMMAND_TYPES.GET_REPORT]: ["reportId", "type"],
      [COMMAND_TYPES.ARCHIVE_REPORTS]: ["reportIds", "type"],
      [COMMAND_TYPES.RESTORE_REPORTS]: ["reportIds", "type"],
      [COMMAND_TYPES.DELETE_ARCHIVED_REPORTS]: ["reportIds", "type"],
    });
    const REPORT_ID_LIST_COMMANDS = new Set([
      COMMAND_TYPES.ARCHIVE_REPORTS,
      COMMAND_TYPES.RESTORE_REPORTS,
      COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
    ]);

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

      if (REPORT_ID_LIST_COMMANDS.has(command.type)) {
        if (
          !Array.isArray(command.reportIds) ||
          command.reportIds.length < 1 ||
          command.reportIds.length > MAX_ARCHIVED_REPORTS ||
          command.reportIds.some(
            (reportId) =>
              typeof reportId !== "string" ||
              !REPORT_ID_PATTERN.test(reportId),
          ) ||
          new Set(command.reportIds).size !== command.reportIds.length
        ) {
          fail(
            "INVALID_REPORT_IDS",
            `reportIds must contain 1 to ${MAX_ARCHIVED_REPORTS} unique stream report IDs.`,
          );
        }
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
      MAX_ACTIVE_REPORTS,
      MAX_ARCHIVED_REPORTS,
      MAX_TOTAL_REPORTS,
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
