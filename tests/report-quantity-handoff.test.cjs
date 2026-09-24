const assert = require("node:assert/strict");
const test = require("node:test");
const reconciliation = require("../extension/shared/reconciliation.js");
const streamReport = require("../extension/shared/stream-report.js");
const importer = require("../extension/shared/inventory-sheet-import.js");
const handoff = require("../extension/shared/report-quantity-handoff.js");
const spreadsheetId = "synthetic-sheet-1234567890";
const streamId = "local-stream:11111111-1111-4111-8111-111111111111";
const headers = [...importer.REQUIRED_HEADERS];
const inventory = [
  { sku: "TEE-M", item: "Tee", style: "Red", size: "M", quantityOnHandAtImport: 5, unitCostCents: 500 },
  { sku: "TEE-L", item: "Tee", style: "Red", size: "L", quantityOnHandAtImport: 4, unitCostCents: 600 },
  { sku: "HAT-OS", item: "Hat", style: "", size: "OS", quantityOnHandAtImport: 0, unitCostCents: 700 },
];
function makeReport() {
  const state = reconciliation.createReconciliationState(inventory);
  ["TEE-M", "TEE-M", "TEE-L", "HAT-OS"].forEach((sku, index) => {
    const key = { streamId, variationNumber: index + 1 };
    reconciliation.mapVariation(state, { ...key, sku });
    reconciliation.recordPaymentComplete(state, { ...key, soldPriceCents: 1500 });
  });
  return streamReport.createStreamReport({ reconciliation, reconciliationState: state, streamId,
    startedAt: "2026-09-22T00:00:00.000Z", endedAt: "2026-09-22T01:00:00.000Z", generatedAt: "2026-09-22T01:00:01.000Z" });
}
function row(sku, columnOrder = headers, quantity) {
  const entry = inventory.find((item) => item.sku === sku);
  const values = { ...entry, quantity_on_hand_at_import: quantity ?? entry.quantityOnHandAtImport,
    unit_cost: entry.unitCostCents / 100 };
  return columnOrder.map((header) => values[header]);
}
function layout(values, headerRowNumber = 1) {
  return { spreadsheetId, sheetTitle: "Inventory", values, headerRowNumber,
    quantityColumnNumber: values[headerRowNumber - 1].indexOf("quantity_on_hand_at_import") + 1 };
}
function basicLayout() { return layout([headers, row("TEE-M"), row("HAT-OS"), row("TEE-L")]); }
function clone(value) { return structuredClone(value); }
function assertCode(action, code) { assert.throws(action, (error) => error.code === code); }

test("quantity handoff preserves nonalphabetical physical order and consecutive leading/interior spacers", () => {
  const report = makeReport();
  const source = layout([headers, [], row("TEE-M"), [], [], row("HAT-OS"), row("TEE-L"), [], []]);
  assert.deepEqual(handoff.createQuantityHandoff(report, source), {
    text: "\r\n3\r\n\r\n\r\n0\r\n3", sheetTitle: "Inventory", startCell: "E2", endCell: "E7",
    rowCount: 6, itemCount: 3, alreadyApplied: false,
  });
});

test("quantity handoff derives reordered column and header row without including headers or trailing blanks", () => {
  const columns = ["quantity_on_hand_at_import", "size", "sku", "unit_cost", "style", "item"];
  const source = layout([[], [], columns, [], row("TEE-L", columns), [], row("TEE-M", columns), row("HAT-OS", columns), []], 3);
  const result = handoff.createQuantityHandoff(makeReport(), source);
  assert.equal(result.startCell, "A4");
  assert.equal(result.endCell, "A8");
  assert.equal(result.text, "\r\n3\r\n\r\n3\r\n0");
  assert.doesNotMatch(result.text, /\t|sku|quantity/);
});

test("quantity handoff ignores G+ formulas and retains G-only leading/interior spacers with byte-identical output", () => {
  const columns = ["quantity_on_hand_at_import", "size", "sku", "unit_cost", "style", "item"];
  const source = layout([[], [], columns, [], row("TEE-L", columns), [], row("TEE-M", columns), row("HAT-OS", columns), []], 3);
  const report = makeReport();
  const expected = handoff.createQuantityHandoff(report, source);
  const extended = clone(source);
  extended.values = extended.values.map((entry, index) => [
    ...Array.from({ length: 6 }, (_, column) => entry[column] ?? ""),
    index === 2 ? "Total Inventory Cost" : "=SUM(A:A)",
    "=A1*D1",
  ]);
  extended.values[4].push(...Array(20_000).fill("Personal data"));
  const before = clone(extended);
  const actual = handoff.createQuantityHandoff(report, extended);
  assert.deepEqual(actual, expected);
  assert.deepEqual(Buffer.from(actual.text), Buffer.from(expected.text));
  assert.equal(actual.startCell, "A4");
  assert.equal(actual.endCell, "A8");
  assert.deepEqual(extended, before);
});

test("quantity handoff ignores trailing G-only rows beyond the row cap but still bounds the relevant A:F extent", () => {
  const source = basicLayout();
  const expected = handoff.createQuantityHandoff(makeReport(), source);
  while (source.values.length <= 1_001) source.values.push(["", "", "", "", "", "", "=SUM(E:E)"]);
  assert.deepEqual(handoff.createQuantityHandoff(makeReport(), source), expected);
  source.values[1_001][5] = 1;
  assertCode(() => handoff.createQuantityHandoff(makeReport(), source), "INVALID_QUANTITY_LAYOUT");
});

test("quantity handoff accepts an item on the final supported physical row and rejects one after it", () => {
  const source = layout([headers, row("TEE-M"), row("HAT-OS"), ...Array.from({ length: 997 }, () => []), row("TEE-L")]);
  const result = handoff.createQuantityHandoff(makeReport(), source);
  assert.equal(result.endCell, "E1001");
  assert.equal(result.rowCount, 1_000);
  source.values.splice(3, 0, []);
  assertCode(() => handoff.createQuantityHandoff(makeReport(), source), "INVALID_QUANTITY_LAYOUT");
});

test("quantity handoff uses exact size SKUs and existing oversold replacement clamping", () => {
  const report = makeReport();
  const result = handoff.createQuantityHandoff(report, basicLayout());
  assert.equal(result.text, "3\r\n0\r\n3");
  assert.equal(report.inventory.find((item) => item.sku === "HAT-OS").requiresRecount, true);
  assert.equal(report.inventory.find((item) => item.sku === "HAT-OS").replacementQuantity, 0);
});

test("quantity handoff recognizes one globally applied result without deducting sales again", () => {
  const source = layout([headers, row("TEE-M", headers, 3), row("HAT-OS"), row("TEE-L", headers, 3)]);
  const result = handoff.createQuantityHandoff(makeReport(), source);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.text, "3\r\n0\r\n3");
  assert.deepEqual(handoff.createQuantityHandoff(makeReport(), source), result);
});

test("quantity handoff rejects mixed applied/opening vectors and unexplained restocks", () => {
  for (const quantities of [[5, 3], [3, 4], [6, 4], [2, 3], [4, 4]]) {
    const source = layout([headers, row("TEE-M", headers, quantities[0]), row("TEE-L", headers, quantities[1]), row("HAT-OS")]);
    assertCode(() => handoff.createQuantityHandoff(makeReport(), source), "QUANTITY_STOCK_CONFLICT");
  }
});

test("quantity handoff rejects missing, extra, duplicate SKUs and mismatched item details", () => {
  const report = makeReport();
  const missing = basicLayout(); missing.values.pop();
  assertCode(() => handoff.createQuantityHandoff(report, missing), "QUANTITY_SKU_MISMATCH");
  const extra = basicLayout(); extra.values.push(["NEW-XL", "New", "", "XL", 1, 1]);
  assertCode(() => handoff.createQuantityHandoff(report, extra), "QUANTITY_SKU_MISMATCH");
  const duplicate = basicLayout(); duplicate.values.push(row("TEE-M"));
  assertCode(() => handoff.createQuantityHandoff(report, duplicate), "INVALID_INVENTORY_SHEET");
  for (const [column, value] of [[1, "Renamed tee"], [2, "Blue"], [3, "S"]]) {
    const changed = basicLayout(); changed.values[1][column] = value;
    assertCode(() => handoff.createQuantityHandoff(report, changed), "QUANTITY_ITEM_MISMATCH");
  }
});

test("quantity handoff rejects formulas, unsafe quantities, invalid rows and noncanonical headers", () => {
  for (const [column, value] of [[4, "=5"], [1, "=CONCAT(1,2)"], [5, "=5"], [4, -1], [4, 1.5], [4, Number.MAX_SAFE_INTEGER + 1]]) {
    const source = basicLayout(); source.values[1][column] = value;
    assertCode(() => handoff.createQuantityHandoff(makeReport(), source), "INVALID_INVENTORY_SHEET");
  }
  for (const header of ["SKU", " sku ", "quantity_on_hand_at_import "]) {
    const source = basicLayout(); source.values[0] = [...headers];
    source.values[0][header.startsWith("quantity") ? 4 : 0] = header;
    assertCode(() => handoff.createQuantityHandoff(makeReport(), source), "INVALID_INVENTORY_SHEET");
  }
  const missingHeader = basicLayout(); missingHeader.values[0] = [...headers.slice(0, 5), "notes", "unit_cost"];
  assertCode(() => handoff.createQuantityHandoff(makeReport(), missingHeader), "INVALID_INVENTORY_SHEET");
});

test("quantity handoff ignores valid Sheet/report-only cost differences and leaves reports/full exports unchanged", () => {
  const report = makeReport();
  const corrected = streamReport.correctReportUnitCost(report, { sku: "TEE-M", unitCostCents: 2000 });
  const source = basicLayout(); source.values[1][5] = 9.25;
  const reportBefore = clone(corrected), sourceBefore = clone(source);
  const tsvBefore = streamReport.serializeInventoryTsv(corrected);
  const csvBefore = streamReport.serializeInventoryCsv(corrected);
  assert.equal(handoff.createQuantityHandoff(corrected, source).text, "3\r\n0\r\n3");
  assert.deepEqual(corrected, reportBefore);
  assert.deepEqual(source, sourceBefore);
  assert.equal(streamReport.serializeInventoryTsv(corrected), tsvBefore);
  assert.equal(streamReport.serializeInventoryCsv(corrected), csvBefore);
});

test("quantity handoff rejects altered header metadata, malformed reports and layouts beyond existing limits", () => {
  for (const changes of [{ headerRowNumber: 2 }, { quantityColumnNumber: 4 }, { sheetTitle: "Other" }, { spreadsheetId: "bad" }]) {
    assertCode(() => handoff.createQuantityHandoff(makeReport(), { ...basicLayout(), ...changes }), "INVALID_QUANTITY_LAYOUT");
  }
  const source = basicLayout(); while (source.values.length <= 1001) source.values.push([]);
  source.values[1001] = row("TEE-L");
  assertCode(() => handoff.createQuantityHandoff(makeReport(), source), "INVALID_QUANTITY_LAYOUT");
  for (const values of [null, [...basicLayout().values, null], [...basicLayout().values, , []]]) {
    assertCode(() => handoff.createQuantityHandoff(makeReport(), { ...basicLayout(), values }), "INVALID_QUANTITY_LAYOUT");
  }
  const report = clone(makeReport()); report.inventory[0].replacementQuantity = 999;
  assertCode(() => handoff.createQuantityHandoff(report, basicLayout()), "INVALID_REPORT");
});
