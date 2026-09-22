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
    const MAX_REPORT_DISPLAY_NAME_LENGTH = 80;
    const MAX_OFFLINE_MAPPING_CHANGES = 1000;
    const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const REPORT_ID_PATTERN =
      /^stream-report:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const QUANTITY_HANDOFF_TOKEN_PATTERN =
      /^quantity-handoff:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const COMMAND_TYPES = Object.freeze({
      LIST_REPORTS: "list_reports",
      LIST_ARCHIVED_REPORTS: "list_archived_reports",
      GET_LIBRARY_CAPACITY: "get_library_capacity",
      GET_REPORT: "get_report",
      PREPARE_QUANTITY_HANDOFF: "prepare_quantity_handoff",
      COPY_QUANTITY_HANDOFF: "copy_quantity_handoff",
      LIST_PAYMENT_FIXING_ORDERS: "list_payment_fixing_orders",
      RESOLVE_PAYMENT_FIXING_ORDER: "resolve_payment_fixing_order",
      LIST_REPORT_UNIT_COSTS: "list_report_unit_costs",
      UPDATE_REPORT_UNIT_COST: "update_report_unit_cost",
      GET_OFFLINE_EDITOR_DATA: "get_offline_editor_data",
      SAVE_OFFLINE_EDITOR_MAPPINGS: "save_offline_editor_mappings",
      RENAME_REPORT: "rename_report",
      ARCHIVE_REPORTS: "archive_reports",
      RESTORE_REPORTS: "restore_reports",
      DELETE_REPORTS: "delete_reports",
      DELETE_ARCHIVED_REPORTS: "delete_archived_reports",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.LIST_REPORTS]: ["type"],
      [COMMAND_TYPES.LIST_ARCHIVED_REPORTS]: ["type"],
      [COMMAND_TYPES.GET_LIBRARY_CAPACITY]: ["type"],
      [COMMAND_TYPES.GET_REPORT]: ["reportId", "type"],
      [COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF]: ["reportId", "spreadsheetId", "type"],
      [COMMAND_TYPES.COPY_QUANTITY_HANDOFF]: ["reportId", "token", "type"],
      [COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS]: ["reportId", "type"],
      [COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER]: [
        "reportId",
        "resolution",
        "soldPriceCents",
        "type",
        "variationNumber",
      ],
      [COMMAND_TYPES.LIST_REPORT_UNIT_COSTS]: ["reportId", "type"],
      [COMMAND_TYPES.UPDATE_REPORT_UNIT_COST]: [
        "reportId",
        "sku",
        "type",
        "unitCostCents",
      ],
      [COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA]: ["reportId", "type"],
      [COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS]: [
        "changes",
        "reportId",
        "type",
      ],
      [COMMAND_TYPES.RENAME_REPORT]: ["displayName", "reportId", "type"],
      [COMMAND_TYPES.ARCHIVE_REPORTS]: ["reportIds", "type"],
      [COMMAND_TYPES.RESTORE_REPORTS]: ["reportIds", "type"],
      [COMMAND_TYPES.DELETE_REPORTS]: ["reportIds", "type"],
      [COMMAND_TYPES.DELETE_ARCHIVED_REPORTS]: ["reportIds", "type"],
    });
    const REPORT_ID_LIST_COMMANDS = new Set([
      COMMAND_TYPES.ARCHIVE_REPORTS,
      COMMAND_TYPES.RESTORE_REPORTS,
      COMMAND_TYPES.DELETE_REPORTS,
      COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
    ]);
    const NOTIFICATION_TYPES = Object.freeze({
      REPORT_LIBRARY_CHANGED: "report_library_changed",
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

    function validateMappingSku(value) {
      return value === null ||
        (typeof value === "string" && SKU_PATTERN.test(value));
    }

    function validateOfflineMappingChanges(changes) {
      const changeKeys = Array.isArray(changes) ? Object.keys(changes) : [];

      if (
        !Array.isArray(changes) ||
        changes.length < 1 ||
        changes.length > MAX_OFFLINE_MAPPING_CHANGES ||
        changeKeys.length !== changes.length ||
        changeKeys.some((key, index) => key !== String(index))
      ) {
        fail(
          "INVALID_MAPPING_CHANGES",
          `changes must contain 1 to ${MAX_OFFLINE_MAPPING_CHANGES} dense mapping corrections.`,
        );
      }

      const expectedKeys = [
        "expectedSku",
        "expectedStatus",
        "sku",
        "variationNumber",
      ];
      const seenVariationNumbers = new Set();

      changes.forEach((change) => {
        if (
          !hasExactKeys(change, expectedKeys) ||
          !Number.isSafeInteger(change.variationNumber) ||
          change.variationNumber < 1 ||
          !["payment_complete", "canceled"].includes(
            change.expectedStatus,
          ) ||
          !validateMappingSku(change.expectedSku) ||
          !validateMappingSku(change.sku) ||
          seenVariationNumbers.has(change.variationNumber)
        ) {
          fail(
            "INVALID_MAPPING_CHANGES",
            "Each mapping correction must contain one unique variation, supported status, expected SKU, and replacement SKU.",
          );
        }

        seenVariationNumbers.add(change.variationNumber);
      });
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
        [
          COMMAND_TYPES.GET_REPORT,
          COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF,
          COMMAND_TYPES.COPY_QUANTITY_HANDOFF,
          COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS,
          COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER,
          COMMAND_TYPES.LIST_REPORT_UNIT_COSTS,
          COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
          COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
          COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
          COMMAND_TYPES.RENAME_REPORT,
        ].includes(command.type) &&
        (
          typeof command.reportId !== "string" ||
          !REPORT_ID_PATTERN.test(command.reportId)
        )
      ) {
        fail("INVALID_REPORT_ID", "The stream report ID is invalid.");
      }

      if (command.type === COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF &&
          (typeof command.spreadsheetId !== "string" ||
           !/^[A-Za-z0-9_-]{20,200}$/.test(command.spreadsheetId))) {
        fail("INVALID_SPREADSHEET_ID", "Enter a valid Google Sheet link or ID.");
      }

      if (command.type === COMMAND_TYPES.COPY_QUANTITY_HANDOFF &&
          (typeof command.token !== "string" ||
           !QUANTITY_HANDOFF_TOKEN_PATTERN.test(command.token))) {
        fail("INVALID_QUANTITY_HANDOFF_TOKEN", "Verify the Sheet again before copying quantities.");
      }

      if (command.type === COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER) {
        if (
          !Number.isSafeInteger(command.variationNumber) ||
          command.variationNumber < 1
        ) {
          fail(
            "INVALID_VARIATION_NUMBER",
            "variationNumber must be a positive safe integer.",
          );
        }

        if (!["payment_complete", "canceled"].includes(command.resolution)) {
          fail(
            "INVALID_PAYMENT_RESOLUTION",
            "resolution must be payment_complete or canceled.",
          );
        }

        if (
          (
            command.resolution === "payment_complete" &&
            (
              !Number.isSafeInteger(command.soldPriceCents) ||
              command.soldPriceCents < 1
            )
          ) ||
          (
            command.resolution === "canceled" &&
            command.soldPriceCents !== null
          )
        ) {
          fail(
            "INVALID_SOLD_PRICE",
            "A completed order requires a positive sold price; a canceled order requires null.",
          );
        }
      }

      if (command.type === COMMAND_TYPES.UPDATE_REPORT_UNIT_COST) {
        if (
          typeof command.sku !== "string" ||
          command.sku.length < 1 ||
          command.sku.length > 64 ||
          command.sku !== command.sku.trim() ||
          /[\u0000-\u001f\u007f]/.test(command.sku)
        ) {
          fail(
            "INVALID_SKU",
            "sku must be an exact non-empty inventory SKU of at most 64 characters.",
          );
        }

        if (
          !Number.isSafeInteger(command.unitCostCents) ||
          command.unitCostCents < 0
        ) {
          fail(
            "INVALID_UNIT_COST",
            "unitCostCents must be a nonnegative safe integer.",
          );
        }
      }

      if (command.type === COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS) {
        validateOfflineMappingChanges(command.changes);
      }

      if (
        command.type === COMMAND_TYPES.RENAME_REPORT &&
        command.displayName !== null &&
        (
          typeof command.displayName !== "string" ||
          command.displayName.length < 1 ||
          command.displayName.length > MAX_REPORT_DISPLAY_NAME_LENGTH ||
          command.displayName !== command.displayName.trim() ||
          /[\u0000-\u001f\u007f]/.test(command.displayName)
        )
      ) {
        fail(
          "INVALID_REPORT_DISPLAY_NAME",
          `displayName must be null or a trimmed name of at most ${MAX_REPORT_DISPLAY_NAME_LENGTH} characters.`,
        );
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

    function createReportLibraryChangedNotification() {
      return {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        event: { type: NOTIFICATION_TYPES.REPORT_LIBRARY_CHANGED },
      };
    }

    function isReportLibraryChangedNotification(message) {
      return (
        hasExactKeys(message, ["channel", "event", "version"]) &&
        message.channel === MESSAGE_CHANNEL &&
        message.version === MESSAGE_VERSION &&
        hasExactKeys(message.event, ["type"]) &&
        message.event.type === NOTIFICATION_TYPES.REPORT_LIBRARY_CHANGED
      );
    }

    return Object.freeze({
      COMMAND_TYPES,
      MAX_ACTIVE_REPORTS,
      MAX_ARCHIVED_REPORTS,
      MAX_OFFLINE_MAPPING_CHANGES,
      MAX_REPORT_DISPLAY_NAME_LENGTH,
      MAX_TOTAL_REPORTS,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      NOTIFICATION_TYPES,
      QUANTITY_HANDOFF_TOKEN_PATTERN,
      REPORT_ID_PATTERN,
      StreamReportProtocolError,
      createStreamReportMessage,
      createReportLibraryChangedNotification,
      isReportLibraryChangedNotification,
      validateCommand,
      validateStreamReportMessage,
    });
  },
);
