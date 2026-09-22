const assert = require("node:assert/strict");
const test = require("node:test");
const googleImport = require("../extension/shared/google-sheets-inventory-import.js");
const inventorySheetImport = require("../extension/shared/inventory-sheet-import.js");
const spreadsheetId = "synthetic-sheet-1234567890";
const headers = [...inventorySheetImport.REQUIRED_HEADERS];
const values = [headers, [], ["TEE-M", "Tee", "Red", "M", 5, 5], [], [], ["TEE-L", "Tee", "Red", "L", 4, 6], []];
function payload(rows = values) {
  return { spreadsheetId, sheets: [{ properties: { title: "Inventory", sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } }, data: [{
    startRow: 0, startColumn: 0, rowData: rows.map((row) => ({ values: row.map((value) =>
      value == null ? {} : { userEnteredValue: { [typeof value === "number" ? "numberValue" : "stringValue"]: value } }) })),
  }] }] };
}
function harness(responsePayload = payload(), options = {}) {
  const calls = { fetch: [], auth: [], writes: [] };
  const service = googleImport.createGoogleSheetsInventoryImportService({
    inventorySheetImport, oauthClientId: "123456789-synthetic.apps.googleusercontent.com",
    identityApi: { async getAuthToken(args) { calls.auth.push(args); if (options.authError) throw options.authError; return { token: "synthetic-token" }; }, async removeCachedAuthToken() {} },
    async fetchImpl(url, request) {
      calls.fetch.push({ url, request });
      return options.response ?? { status: 200, async text() { return JSON.stringify(responsePayload); } };
    },
    async assertNoActiveStream() {}, async assertActiveStream() {},
    async createBaseline(value) { calls.writes.push(value); }, async extendStreamBaseline(value) { calls.writes.push(value); },
    async getActiveBaseline() { return null; }, now: () => 1,
    createUuid: () => "11111111-1111-4111-8111-111111111111",
  });
  return { service, calls };
}

test("fresh layout read preserves physical blank rows and requests the whole Inventory tab with unchanged read-only authorization", async () => {
  const { service, calls } = harness();
  const result = await service.readInventoryLayout(spreadsheetId);
  assert.deepEqual(result, { spreadsheetId, sheetTitle: "Inventory", values, headerRowNumber: 1, quantityColumnNumber: 5 });
  assert.deepEqual(calls.auth, [{ interactive: true }]);
  assert.equal(calls.fetch.length, 1);
  const url = new URL(calls.fetch[0].url);
  assert.equal(url.searchParams.get("ranges"), "'Inventory'");
  assert.equal(url.searchParams.get("fields"), googleImport.LAYOUT_GRID_FIELDS);
  assert.equal(calls.fetch[0].request.method, "GET");
  assert.equal(calls.fetch[0].request.credentials, "omit");
  assert.deepEqual(calls.writes, []);
});

test("layout header metadata follows actual row and recognized reordered quantity column", async () => {
  const reordered = ["size", "quantity_on_hand_at_import", "sku", "style", "unit_cost", "item"];
  const { service } = harness(payload([[], reordered, [], ["M", 2, "TEE-M", "Red", 5, "Tee"]]));
  const result = await service.readInventoryLayout(spreadsheetId);
  assert.equal(result.headerRowNumber, 2);
  assert.equal(result.quantityColumnNumber, 2);
  assert.deepEqual(result.values[0], []);
  assert.deepEqual(result.values[2], []);
});

test("layout validation does not change ordinary import parsing, response fields, or preview behavior", async () => {
  const { service, calls } = harness();
  const preview = await service.previewGoogleSheet(spreadsheetId);
  assert.equal(preview.status, "ready");
  assert.equal(preview.inventory.length, 2);
  assert.equal(new URL(calls.fetch[0].url).searchParams.get("fields"), googleImport.GRID_FIELDS);
  const layout = await service.readInventoryLayout(spreadsheetId);
  assert.equal(layout.values.length, values.length);
  assert.equal(preview.inventory.some((entry) => Object.hasOwn(entry, "rowNumber")), false);
  assert.deepEqual(calls.writes, []);
});

test("layout reader rejects wrong identities, ambiguous blocks, shifted/truncated ranges, merges and unsupported sheets", async () => {
  const mutations = [
    (p) => { p.spreadsheetId = "another-sheet-1234567890"; },
    (p) => { p.sheets.push(structuredClone(p.sheets[0])); },
    (p) => { p.sheets[0].data.push(structuredClone(p.sheets[0].data[0])); },
    (p) => { p.sheets[0].data[0].startRow = 1; },
    (p) => { p.sheets[0].data[0].startColumn = 1; },
    (p) => { delete p.sheets[0].properties.gridProperties; },
    (p) => { p.sheets[0].properties.gridProperties.rowCount = 2; },
    (p) => { p.sheets[0].properties.gridProperties.columnCount = 5; },
    (p) => { p.sheets[0].merges = [{ startRowIndex: 1, endRowIndex: 3 }]; },
    (p) => { p.sheets[0].properties.sheetType = "DATA_SOURCE"; },
  ];
  for (const mutate of mutations) {
    const p = payload(); mutate(p);
    await assert.rejects(harness(p).service.readInventoryLayout(spreadsheetId), { code: "UNSUPPORTED_INVENTORY_LAYOUT" });
  }
});

test("layout reader rejects formulas, duplicates, bad headers and any data outside supported columns", async () => {
  const duplicate = payload([...values, values[2]]);
  const formula = payload(); formula.sheets[0].data[0].rowData[2].values[4].userEnteredValue = { formulaValue: "=5" };
  const wrongHeader = payload(); wrongHeader.sheets[0].data[0].rowData[0].values[0].userEnteredValue.stringValue = " sku ";
  const extraData = payload(); extraData.sheets[0].data[0].rowData[3].values = [{}, {}, {}, {}, {}, {}, { userEnteredValue: { stringValue: "extra" } }];
  for (const p of [duplicate, formula, wrongHeader, extraData]) {
    await assert.rejects(harness(p).service.readInventoryLayout(spreadsheetId), { code: "INVALID_INVENTORY_SHEET" });
  }
  await assert.rejects(harness(formula).service.readInventoryLayout(spreadsheetId), (error) => {
    assert.equal(error.code, "INVALID_INVENTORY_SHEET");
    assert.match(error.message, /Inventory row 3 \(quantity_on_hand_at_import\):.*value, not a formula/);
    assert.doesNotMatch(error.message, /=5|synthetic-token|userEnteredValue/);
    return true;
  });
  await assert.rejects(harness(duplicate).service.readInventoryLayout(spreadsheetId), (error) => {
    assert.equal(error.code, "INVALID_INVENTORY_SHEET");
    assert.match(error.message, /Inventory row 8 \(sku\):.*duplicates Inventory row 3/);
    assert.match(error.message, /1 additional validation issue/);
    return true;
  });
});

test("layout reader preserves physical row, slot and byte bounds without truncating", async () => {
  const tooManyRows = payload();
  tooManyRows.sheets[0].properties.gridProperties.rowCount = 2000;
  while (tooManyRows.sheets[0].data[0].rowData.length <= googleImport.MAX_SHEET_ROWS) tooManyRows.sheets[0].data[0].rowData.push({});
  await assert.rejects(harness(tooManyRows).service.readInventoryLayout(spreadsheetId), { code: "INVENTORY_SHEET_TOO_LARGE" });
  const tooManySlots = payload();
  tooManySlots.sheets[0].properties.gridProperties.columnCount = googleImport.MAX_SHEET_COLUMNS;
  tooManySlots.sheets[0].data[0].rowData = [{ values: Array(11000).fill({}) }, { values: Array(11000).fill({}) }];
  await assert.rejects(harness(tooManySlots).service.readInventoryLayout(spreadsheetId), { code: "INVENTORY_SHEET_TOO_LARGE" });
  const oversized = { status: 200, headers: { get: () => String(googleImport.MAX_RESPONSE_CHARACTERS + 1) }, async text() { throw new Error("must not read"); } };
  await assert.rejects(harness(payload(), { response: oversized }).service.readInventoryLayout(spreadsheetId), { code: "INVENTORY_SHEET_TOO_LARGE" });
});

test("layout authorization, invalid ID, and malformed response failures never return a partial layout", async () => {
  const auth = harness(payload(), { authError: new Error("synthetic cancellation") });
  await assert.rejects(auth.service.readInventoryLayout(spreadsheetId), { code: "GOOGLE_AUTH_FAILED" });
  assert.deepEqual(auth.calls.fetch, []);
  const invalid = harness();
  await assert.rejects(invalid.service.readInventoryLayout("bad"), { code: "INVALID_SPREADSHEET_ID" });
  assert.deepEqual(invalid.calls.auth, []);
  await assert.rejects(harness(payload(), { response: { status: 200, async text() { return '{"spreadsheetId":'; } } }).service.readInventoryLayout(spreadsheetId), { code: "INVALID_GOOGLE_SHEETS_RESPONSE" });
});
