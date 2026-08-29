(function initializeInventoryImportProtocol(root, factory) {
  const inventoryImportProtocol = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = inventoryImportProtocol;
  }

  root.TikTokLiveTrackerInventoryImportProtocol = inventoryImportProtocol;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createInventoryImportProtocolModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.inventory-import";
    const MESSAGE_VERSION = 1;
    const COMMAND_TYPES = Object.freeze({
      GET_IMPORT_STATUS: "get_import_status",
      GET_ACTIVE_BASELINE_PREVIEW: "get_active_baseline_preview",
      PREVIEW_GOOGLE_SHEET: "preview_google_sheet",
      CONFIRM_GOOGLE_SHEET_IMPORT: "confirm_google_sheet_import",
      ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET:
        "add_active_stream_skus_from_google_sheet",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.GET_IMPORT_STATUS]: ["type"],
      [COMMAND_TYPES.GET_ACTIVE_BASELINE_PREVIEW]: ["type"],
      [COMMAND_TYPES.PREVIEW_GOOGLE_SHEET]: ["spreadsheetId", "type"],
      [COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT]: ["previewToken", "type"],
      [COMMAND_TYPES.ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET]: [
        "spreadsheetId",
        "type",
      ],
    });
    const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
    const PREVIEW_TOKEN_PATTERN =
      /^inventory-preview:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    class InventoryImportProtocolError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "InventoryImportProtocolError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new InventoryImportProtocolError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function hasExactKeys(value, expectedKeys) {
      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      return actualKeys.length === sortedExpectedKeys.length &&
        actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
    }

    function validateCommand(command) {
      if (!isPlainRecord(command) || typeof command.type !== "string") {
        fail(
          "INVALID_COMMAND",
          "An inventory-import command object with a type is required.",
        );
      }

      const expectedKeys = COMMAND_KEYS[command.type];

      if (!expectedKeys) {
        fail(
          "UNKNOWN_COMMAND",
          `Inventory-import command ${command.type} is not supported.`,
        );
      }

      if (!hasExactKeys(command, expectedKeys)) {
        fail(
          "INVALID_COMMAND",
          `Inventory-import command ${command.type} has an invalid shape.`,
        );
      }

      if (
        [
          COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
          COMMAND_TYPES.ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
        ].includes(command.type) &&
        (
          typeof command.spreadsheetId !== "string" ||
          !SPREADSHEET_ID_PATTERN.test(command.spreadsheetId)
        )
      ) {
        fail(
          "INVALID_SPREADSHEET_ID",
          "The Google Sheets spreadsheet ID is invalid.",
        );
      }

      if (
        command.type === COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT &&
        (
          typeof command.previewToken !== "string" ||
          !PREVIEW_TOKEN_PATTERN.test(command.previewToken)
        )
      ) {
        fail(
          "INVALID_PREVIEW_TOKEN",
          "The inventory preview token is invalid.",
        );
      }

      return command;
    }

    function cloneSerializable(value) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_error) {
        fail(
          "INVALID_MESSAGE",
          "Inventory-import messages must contain only JSON-serializable values.",
        );
      }
    }

    function snapshotCommand(command) {
      validateCommand(command);
      const snapshot = cloneSerializable(command);
      validateCommand(snapshot);
      return snapshot;
    }

    function validateInventoryImportMessage(message) {
      if (
        !isPlainRecord(message) ||
        !hasExactKeys(message, ["channel", "command", "version"]) ||
        message.channel !== MESSAGE_CHANNEL
      ) {
        fail(
          "INVALID_MESSAGE",
          "The inventory-import message has an invalid shape.",
        );
      }

      if (!Number.isSafeInteger(message.version) || message.version < 1) {
        fail(
          "INVALID_MESSAGE",
          "The inventory-import message version must be a positive integer.",
        );
      }

      if (message.version !== MESSAGE_VERSION) {
        fail(
          "UNSUPPORTED_MESSAGE_VERSION",
          `Inventory-import message version ${message.version} is not supported.`,
        );
      }

      return snapshotCommand(message.command);
    }

    function createInventoryImportMessage(command) {
      const message = {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        command: snapshotCommand(command),
      };

      validateInventoryImportMessage(message);
      return message;
    }

    return Object.freeze({
      COMMAND_TYPES,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      PREVIEW_TOKEN_PATTERN,
      SPREADSHEET_ID_PATTERN,
      InventoryImportProtocolError,
      createInventoryImportMessage,
      validateCommand,
      validateInventoryImportMessage,
    });
  },
);
