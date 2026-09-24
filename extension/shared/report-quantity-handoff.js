(function initializeReportQuantityHandoff(root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(
    node ? require("./inventory-sheet-import.js") : root.TikTokLiveTrackerInventorySheetImport,
    node ? require("./stream-report.js") : root.TikTokLiveTrackerStreamReport,
    node ? require("./google-sheets-inventory-import.js") : root.TikTokLiveTrackerGoogleSheetsInventoryImport,
  );
  if (node) module.exports = api;
  root.TikTokLiveTrackerReportQuantityHandoff = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createReportQuantityHandoffModule(inventorySheetImport, streamReport, googleImport) {
  "use strict";

  class ReportQuantityHandoffError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ReportQuantityHandoffError";
      this.code = code;
    }
  }
  function fail(code, message) { throw new ReportQuantityHandoffError(code, message); }
  function isBlank(value) {
    return value === undefined || value === null || typeof value === "string" && value.trim() === "";
  }
  function columnLabel(number) {
    let result = "";
    while (number > 0) {
      number -= 1;
      result = String.fromCharCode(65 + number % 26) + result;
      number = Math.floor(number / 26);
    }
    return result;
  }

  function createQuantityHandoff(report, layout) {
    const hydrated = streamReport.hydrateStreamReport(report);
    if (!layout || layout.sheetTitle !== "Inventory" ||
        typeof layout.spreadsheetId !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(layout.spreadsheetId)) {
      fail("INVALID_QUANTITY_LAYOUT", "The complete Inventory layout is unavailable or exceeds the supported size. Verify the Sheet again.");
    }
    let values;
    try {
      values = inventorySheetImport.projectInventoryColumns(layout.values);
    } catch (error) {
      if (!(error instanceof inventorySheetImport.InventorySheetImportError)) throw error;
      fail("INVALID_QUANTITY_LAYOUT", "The complete Inventory layout is unavailable or exceeds the supported size. Verify the Sheet again.");
    }
    if (values.length > googleImport.MAX_SHEET_ROWS ||
        values.some((row) => row.length > googleImport.MAX_SHEET_COLUMNS) ||
        values.reduce((total, row) => total + row.length, 0) > googleImport.MAX_CELL_SLOTS) {
      fail("INVALID_QUANTITY_LAYOUT", "The complete Inventory layout is unavailable or exceeds the supported size. Verify the Sheet again.");
    }
    const parsed = inventorySheetImport.parseInventorySheet(values);
    const headerIndex = values.findIndex((row) => !row.every(isBlank));
    const quantityColumn = values[headerIndex].indexOf("quantity_on_hand_at_import") + 1;
    if (layout.headerRowNumber !== headerIndex + 1 || layout.quantityColumnNumber !== quantityColumn) {
      fail("INVALID_QUANTITY_LAYOUT", "The Inventory header position changed. Verify the Sheet again.");
    }
    const bySku = new Map(hydrated.inventory.map((entry) => [entry.sku, entry]));
    if (parsed.inventory.length !== bySku.size || parsed.inventory.some((entry) => !bySku.has(entry.sku))) {
      fail("QUANTITY_SKU_MISMATCH", "The Sheet and report must contain exactly the same SKUs. Reconcile missing or extra items before copying quantities.");
    }
    let matchesOpening = true;
    let matchesReplacement = true;
    for (const entry of parsed.inventory) {
      const saved = bySku.get(entry.sku);
      if (["item", "style", "size"].some((field) => saved[field] !== entry[field])) {
        fail("QUANTITY_ITEM_MISMATCH", `The Sheet details for SKU ${entry.sku} differ from the report. Reconcile its item, style, and size before copying quantities.`);
      }
      matchesOpening &&= entry.quantityOnHandAtImport === saved.openingQuantity;
      matchesReplacement &&= entry.quantityOnHandAtImport === saved.replacementQuantity;
    }
    // Accept one known whole inventory state, not a row-by-row mix that could
    // silently overwrite restocks or a partially applied older handoff. Never
    // subtract sales from quantities that may already have been updated.
    if (!matchesOpening && !matchesReplacement) {
      fail("QUANTITY_STOCK_CONFLICT", "Sheet quantities do not match this report's opening stock or its complete updated quantities. Reconcile restocks, earlier updates, or partial pastes before continuing.");
    }
    const skuColumn = values[headerIndex].indexOf("sku");
    const lastRowIndex = values.length - 1;
    const lines = values.slice(headerIndex + 1, lastRowIndex + 1).map((row) =>
      row.every(isBlank) ? "" : String(bySku.get(row[skuColumn].trim()).replacementQuantity));
    const column = columnLabel(quantityColumn);
    return {
      text: lines.join("\r\n"), sheetTitle: "Inventory",
      startCell: `${column}${headerIndex + 2}`, endCell: `${column}${lastRowIndex + 1}`,
      rowCount: lines.length, itemCount: parsed.inventory.length, alreadyApplied: matchesReplacement,
    };
  }

  return Object.freeze({ ReportQuantityHandoffError, createQuantityHandoff });
});
