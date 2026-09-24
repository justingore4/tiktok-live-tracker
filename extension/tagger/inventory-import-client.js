(function initializeInventoryImportClient(root, factory) {
  const inventoryImportClient = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = inventoryImportClient;
  }

  root.TikTokLiveTrackerInventoryImportClient = inventoryImportClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createInventoryImportClientModule() {
    "use strict";

    const FIXED_INVENTORY_RANGE = "'Inventory'!A:F";
    const DEFAULT_SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
    const GOOGLE_SHEETS_HOST = "docs.google.com";
    const GOOGLE_SHEETS_PATH_PATTERN =
      /^\/spreadsheets(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]{20,200})(?:\/(?:edit|view|preview|copy))?\/?$/;
    const BASELINE_ID_PATTERN =
      /^inventory-baseline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const FINGERPRINT_PATTERN = /^fnv1a64:[0-9a-f]{16}$/;
    const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const INVENTORY_TEXT_LIMITS = Object.freeze({
      item: 160,
      style: 160,
      size: 80,
    });
    const UNSAFE_CONTROL_CHARACTER_PATTERN =
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

    class InventoryImportClientError extends Error {
      constructor(code, message, options = {}) {
        super(message);
        this.name = "InventoryImportClientError";
        this.code = code;
        this.issues = Array.isArray(options.issues)
          ? options.issues.map((issue) => ({ ...issue }))
          : [];
      }
    }

    function fail(code, message, options) {
      throw new InventoryImportClientError(code, message, options);
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

    function cloneSerializable(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function parseGoogleSheetReference(
      value,
      spreadsheetIdPattern = DEFAULT_SPREADSHEET_ID_PATTERN,
    ) {
      if (typeof value !== "string" || value.trim() === "") {
        fail(
          "INVALID_SPREADSHEET_REFERENCE",
          "Enter a Google Sheet ID or sharing link.",
        );
      }

      const reference = value.trim();
      if (spreadsheetIdPattern.test(reference)) {
        return reference;
      }

      let url;
      try {
        url = new URL(reference);
      } catch (_error) {
        fail(
          "INVALID_SPREADSHEET_REFERENCE",
          "Enter the exact Sheet ID or a docs.google.com spreadsheet sharing link.",
        );
      }

      if (
        url.protocol !== "https:" ||
        url.hostname !== GOOGLE_SHEETS_HOST ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        fail(
          "INVALID_SPREADSHEET_REFERENCE",
          "Use an HTTPS sharing link from docs.google.com.",
        );
      }

      const pathMatch = GOOGLE_SHEETS_PATH_PATTERN.exec(url.pathname);
      if (!pathMatch || !spreadsheetIdPattern.test(pathMatch[1])) {
        fail(
          "INVALID_SPREADSHEET_REFERENCE",
          "The Google Sheets sharing link does not contain a valid Sheet ID.",
        );
      }

      return pathMatch[1];
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Inventory-import client options are required.");
      }

      const { runtime, protocol } = options;
      if (!runtime || typeof runtime.sendMessage !== "function") {
        throw new TypeError("runtime must provide sendMessage.");
      }

      if (
        !isPlainRecord(protocol) ||
        typeof protocol.createInventoryImportMessage !== "function" ||
        !isPlainRecord(protocol.COMMAND_TYPES) ||
        !(protocol.SPREADSHEET_ID_PATTERN instanceof RegExp) ||
        !(protocol.PREVIEW_TOKEN_PATTERN instanceof RegExp)
      ) {
        throw new TypeError("A valid inventory-import protocol is required.");
      }

      return { runtime, protocol };
    }

    function isValidSummary(value) {
      return hasExactKeys(value, [
        "rowCount",
        "totalInventoryCostCents",
        "totalQuantityOnHandAtImport",
      ]) &&
        Number.isSafeInteger(value.rowCount) &&
        value.rowCount > 0 &&
        Number.isSafeInteger(value.totalInventoryCostCents) &&
        value.totalInventoryCostCents >= 0 &&
        Number.isSafeInteger(value.totalQuantityOnHandAtImport) &&
        value.totalQuantityOnHandAtImport >= 0;
    }

    function isValidInventoryRow(row) {
      return hasExactKeys(row, [
        "item",
        "quantityOnHandAtImport",
        "size",
        "sku",
        "style",
        "unitCostCents",
      ]) &&
        typeof row.sku === "string" &&
        SKU_PATTERN.test(row.sku) &&
        typeof row.item === "string" &&
        row.item.length > 0 &&
        row.item.length <= INVENTORY_TEXT_LIMITS.item &&
        typeof row.style === "string" &&
        row.style.length <= INVENTORY_TEXT_LIMITS.style &&
        typeof row.size === "string" &&
        row.size.length > 0 &&
        row.size.length <= INVENTORY_TEXT_LIMITS.size &&
        [row.item, row.style, row.size].every(
          (value) =>
            value === value.normalize("NFC").trim().replace(/\s+/g, " ") &&
            !value.startsWith("=") &&
            !UNSAFE_CONTROL_CHARACTER_PATTERN.test(value),
        ) &&
        Number.isSafeInteger(row.quantityOnHandAtImport) &&
        row.quantityOnHandAtImport >= 0 &&
        Number.isSafeInteger(row.unitCostCents) &&
        row.unitCostCents >= 0;
    }

    function inventoryMatchesSummary(inventory, summary) {
      const seenSkus = new Set();
      const seenIdentities = new Set();
      let totalQuantityOnHandAtImport = 0n;
      let totalInventoryCostCents = 0n;

      for (const row of inventory) {
        const identity = [row.item, row.style, row.size]
          .map((value) => value.toLocaleLowerCase("en-US"))
          .join("\u0000");

        if (seenSkus.has(row.sku) || seenIdentities.has(identity)) {
          return false;
        }

        seenSkus.add(row.sku);
        seenIdentities.add(identity);
        totalQuantityOnHandAtImport += BigInt(row.quantityOnHandAtImport);
        totalInventoryCostCents +=
          BigInt(row.quantityOnHandAtImport) * BigInt(row.unitCostCents);
      }

      return (
        totalQuantityOnHandAtImport <= BigInt(Number.MAX_SAFE_INTEGER) &&
        totalInventoryCostCents <= BigInt(Number.MAX_SAFE_INTEGER) &&
        Number(totalQuantityOnHandAtImport) ===
          summary.totalQuantityOnHandAtImport &&
        Number(totalInventoryCostCents) === summary.totalInventoryCostCents
      );
    }

    function isValidIssue(issue) {
      return hasExactKeys(issue, ["code", "column", "message", "rowNumber"]) &&
        typeof issue.code === "string" &&
        issue.code.trim() !== "" &&
        issue.code.length <= 80 &&
        (
          issue.column === null ||
          (typeof issue.column === "string" && issue.column.length <= 80)
        ) &&
        typeof issue.message === "string" &&
        issue.message.trim() !== "" &&
        issue.message.length <= 500 &&
        (
          issue.rowNumber === null ||
          (Number.isSafeInteger(issue.rowNumber) && issue.rowNumber > 0)
        );
    }

    function parseSuccess(commandType, data, protocol) {
      const commandTypes = protocol.COMMAND_TYPES;
      if (commandType === commandTypes.GET_IMPORT_STATUS) {
        if (
          !hasExactKeys(data, [
            "baselineId",
            "ready",
            "sourceFingerprint",
            "summary",
          ]) ||
          typeof data.ready !== "boolean"
        ) {
          fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
        }

        if (!data.ready) {
          if (
            data.baselineId !== null ||
            data.sourceFingerprint !== null ||
            data.summary !== null
          ) {
            fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
          }
        } else if (
          typeof data.baselineId !== "string" ||
          !BASELINE_ID_PATTERN.test(data.baselineId) ||
          typeof data.sourceFingerprint !== "string" ||
          !FINGERPRINT_PATTERN.test(data.sourceFingerprint) ||
          !isValidSummary(data.summary)
        ) {
          fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
        }

        return cloneSerializable(data);
      }

      if (commandType === commandTypes.PREVIEW_GOOGLE_SHEET) {
        if (
          hasExactKeys(data, ["issues", "status"]) &&
          data.status === "invalid" &&
          Array.isArray(data.issues) &&
          data.issues.length > 0 &&
          data.issues.length <= 100 &&
          data.issues.every(isValidIssue)
        ) {
          fail(
            "INVALID_INVENTORY_SHEET",
            "The Inventory tab contains values that must be fixed before import.",
            { issues: data.issues },
          );
        }

        if (
          !hasExactKeys(data, [
            "contractVersion",
            "expiresAt",
            "fingerprint",
            "inventory",
            "previewToken",
            "range",
            "spreadsheetId",
            "status",
            "summary",
          ]) ||
          data.status !== "ready" ||
          data.contractVersion !== 1 ||
          typeof data.previewToken !== "string" ||
          !protocol.PREVIEW_TOKEN_PATTERN.test(data.previewToken) ||
          typeof data.spreadsheetId !== "string" ||
          !protocol.SPREADSHEET_ID_PATTERN.test(data.spreadsheetId) ||
          data.range !== FIXED_INVENTORY_RANGE ||
          typeof data.fingerprint !== "string" ||
          !FINGERPRINT_PATTERN.test(data.fingerprint) ||
          typeof data.expiresAt !== "string" ||
          Number.isNaN(Date.parse(data.expiresAt)) ||
          new Date(data.expiresAt).toISOString() !== data.expiresAt ||
          !Array.isArray(data.inventory) ||
          data.inventory.length === 0 ||
          data.inventory.length > 1_000 ||
          !data.inventory.every(isValidInventoryRow) ||
          !isValidSummary(data.summary) ||
          data.summary.rowCount !== data.inventory.length
        ) {
          fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
        }

        const preview = cloneSerializable(data);
        delete preview.status;
        return preview;
      }

      if (
        commandType ===
          commandTypes.ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET
      ) {
        if (
          hasExactKeys(data, ["issues", "status"]) &&
          data.status === "invalid" &&
          Array.isArray(data.issues) &&
          data.issues.length > 0 &&
          data.issues.length <= 100 &&
          data.issues.every(isValidIssue)
        ) {
          fail(
            "INVALID_INVENTORY_SHEET",
            "The Inventory tab contains values that must be fixed before new SKUs can be added.",
            { issues: data.issues },
          );
        }

        const validStatus = ["extended", "already_current"].includes(
          data?.status,
        );
        const validAddedSkus =
          Array.isArray(data?.addedSkus) &&
          data.addedSkus.length <= 1_000 &&
          data.addedSkus.every(
            (sku) => typeof sku === "string" && SKU_PATTERN.test(sku),
          ) &&
          new Set(data.addedSkus).size === data.addedSkus.length;

        if (
          !hasExactKeys(data, [
            "addedSkus",
            "baselineId",
            "sourceFingerprint",
            "status",
            "summary",
          ]) ||
          !validStatus ||
          typeof data.baselineId !== "string" ||
          !BASELINE_ID_PATTERN.test(data.baselineId) ||
          typeof data.sourceFingerprint !== "string" ||
          !FINGERPRINT_PATTERN.test(data.sourceFingerprint) ||
          !isValidSummary(data.summary) ||
          !validAddedSkus ||
          (data.status === "extended" && data.addedSkus.length === 0) ||
          (data.status === "already_current" && data.addedSkus.length !== 0)
        ) {
          fail(
            "INVALID_RESPONSE",
            "The inventory-import service returned invalid data.",
          );
        }

        return cloneSerializable(data);
      }

      if (commandType === commandTypes.GET_ACTIVE_BASELINE_PREVIEW) {
        if (
          !hasExactKeys(data, [
            "baselineId",
            "inventory",
            "ready",
            "summary",
          ]) ||
          typeof data.ready !== "boolean"
        ) {
          fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
        }

        if (!data.ready) {
          if (
            data.baselineId !== null ||
            data.inventory !== null ||
            data.summary !== null
          ) {
            fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
          }
        } else if (
          typeof data.baselineId !== "string" ||
          !BASELINE_ID_PATTERN.test(data.baselineId) ||
          !Array.isArray(data.inventory) ||
          data.inventory.length < 1 ||
          data.inventory.length > 1_000 ||
          !data.inventory.every(isValidInventoryRow) ||
          !isValidSummary(data.summary) ||
          data.summary.rowCount !== data.inventory.length ||
          !inventoryMatchesSummary(data.inventory, data.summary)
        ) {
          fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
        }

        return cloneSerializable(data);
      }

      if (
        !hasExactKeys(data, [
          "baselineId",
          "sourceFingerprint",
          "status",
          "summary",
        ]) ||
        data.status !== "imported" ||
        typeof data.baselineId !== "string" ||
        !BASELINE_ID_PATTERN.test(data.baselineId) ||
        typeof data.sourceFingerprint !== "string" ||
        !FINGERPRINT_PATTERN.test(data.sourceFingerprint) ||
        !isValidSummary(data.summary)
      ) {
        fail("INVALID_RESPONSE", "The inventory-import service returned invalid data.");
      }

      const confirmation = cloneSerializable(data);
      delete confirmation.status;
      return confirmation;
    }

    function parseResponse(response, commandType, protocol) {
      if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
        fail("INVALID_RESPONSE", "The inventory-import service returned an invalid response.");
      }

      if (response.ok) {
        if (!hasExactKeys(response, ["data", "ok"]) || !isPlainRecord(response.data)) {
          fail("INVALID_RESPONSE", "The inventory-import service returned an invalid response.");
        }

        return parseSuccess(commandType, response.data, protocol);
      }

      if (
        !hasExactKeys(response, ["error", "ok"]) ||
        !hasExactKeys(response.error, ["code", "message"]) ||
        typeof response.error.code !== "string" ||
        response.error.code.trim() === "" ||
        response.error.code.length > 80 ||
        typeof response.error.message !== "string" ||
        response.error.message.trim() === "" ||
        response.error.message.length > 500
      ) {
        fail("INVALID_RESPONSE", "The inventory-import service returned an invalid response.");
      }

      fail(response.error.code, response.error.message);
    }

    function createInventoryImportClient(options) {
      const { runtime, protocol } = validateDependencies(options);
      let commandTail = Promise.resolve();

      async function sendCommand(command) {
        let message;
        try {
          message = protocol.createInventoryImportMessage(command);
        } catch (error) {
          fail(error?.code ?? "INVALID_CLIENT_COMMAND", error?.message ?? "The inventory-import command is invalid.");
        }

        let response;
        try {
          response = await runtime.sendMessage(message);
        } catch (_error) {
          fail("RUNTIME_MESSAGE_FAILED", "Could not reach the inventory-import service.");
        }

        return parseResponse(response, command.type, protocol);
      }

      function enqueue(command) {
        const execution = commandTail.then(() => sendCommand(command));
        commandTail = execution.catch(() => undefined);
        return execution;
      }

      function getImportStatus() {
        return enqueue({ type: protocol.COMMAND_TYPES.GET_IMPORT_STATUS });
      }

      function getActiveBaselinePreview() {
        return enqueue({
          type: protocol.COMMAND_TYPES.GET_ACTIVE_BASELINE_PREVIEW,
        });
      }

      function previewReference(reference) {
        let spreadsheetId;
        try {
          spreadsheetId = parseGoogleSheetReference(
            reference,
            protocol.SPREADSHEET_ID_PATTERN,
          );
        } catch (error) {
          return Promise.reject(error);
        }

        return previewSpreadsheetId(spreadsheetId);
      }

      function previewSpreadsheetId(spreadsheetId) {
        return enqueue({
          type: protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
          spreadsheetId,
        });
      }

      function normalizeReference(reference) {
        return parseGoogleSheetReference(
          reference,
          protocol.SPREADSHEET_ID_PATTERN,
        );
      }

      function confirmPreview(previewToken) {
        return enqueue({
          type: protocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT,
          previewToken,
        });
      }

      function addActiveStreamSkusReference(reference) {
        let spreadsheetId;

        try {
          spreadsheetId = normalizeReference(reference);
        } catch (error) {
          return Promise.reject(error);
        }

        return enqueue({
          type:
            protocol.COMMAND_TYPES
              .ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
          spreadsheetId,
        });
      }

      return Object.freeze({
        addActiveStreamSkusReference,
        confirmPreview,
        getActiveBaselinePreview,
        getImportStatus,
        normalizeReference,
        previewReference,
        previewSpreadsheetId,
      });
    }

    return Object.freeze({
      FIXED_INVENTORY_RANGE,
      InventoryImportClientError,
      createInventoryImportClient,
      parseGoogleSheetReference,
    });
  },
);
