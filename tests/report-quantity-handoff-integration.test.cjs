"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationStorage = require("../extension/shared/reconciliation-storage.js");
const reports = require("../extension/shared/stream-report.js");
const reportStorage = require("../extension/shared/stream-report-storage.js");
const protocol = require("../extension/shared/stream-report-protocol.js");
const clientModule = require("../extension/report/stream-report-client.js");
const streamProtocol = require("../extension/shared/stream-session-coordinator.js");
const importProtocol = require("../extension/shared/inventory-import-protocol.js");
const EXTENSION = path.join(__dirname, "..", "extension");
const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const BASELINE = "inventory-baseline:22222222-2222-4222-8222-222222222222";
const SHEET = "1Synthetic_quantity_sheet_123";
const OTHER_SHEET = "1Other_synthetic_quantity_123";
const REPORT_URL = "chrome-extension://quantity-test/report/report.html";
const PANEL_URL = "chrome-extension://quantity-test/tagger/sidepanel.html";
const HEADER = ["sku", "item", "style", "size", "quantity_on_hand_at_import", "unit_cost"];
const ITEMS = [
  { sku: "Z-TEE-M", item: "Tee", style: "red", size: "M", quantityOnHandAtImport: 5, unitCostCents: 200 },
  { sku: "A-TEE-L", item: "Tee", style: "red", size: "L", quantityOnHandAtImport: 4, unitCostCents: 250 },
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const row = (item, quantity = item.quantityOnHandAtImport) =>
  [item.sku, item.item, item.style, item.size, quantity, item.unitCostCents / 100];
const sheetRows = () => [HEADER, [], row(ITEMS[0]), [], [], row(ITEMS[1]), [], []];

function grid(rows = sheetRows(), spreadsheetId = SHEET) {
  return { spreadsheetId, sheets: [{
    properties: { title: "Inventory", sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } },
    data: [{ startRow: 0, startColumn: 0, rowData: rows.map((cells) => ({
      values: cells.map((value) => ({ userEnteredValue: typeof value === "object" ? value
        : typeof value === "number" ? { numberValue: value } : { stringValue: value } })),
    })) }],
  }] };
}

function fixture(options = {}) {
  const state = reconciliation.createReconciliationState([]);
  reconciliation.createInventoryBaseline(state, {
    baselineId: BASELINE, sourceFingerprint: "fnv1a64:1234567890abcdef", inventory: ITEMS,
  });
  for (const [index, item] of ITEMS.entries()) {
    reconciliation.mapVariation(state, { streamId: STREAM, variationNumber: index + 1, sku: item.sku });
    reconciliation.recordPaymentComplete(state, {
      streamId: STREAM, variationNumber: index + 1, soldPriceCents: 1500,
    });
  }
  options.beforeReport?.(state);
  const report = reports.createStreamReport({ reconciliation, reconciliationState: state,
    streamId: STREAM, startedAt: "2026-09-20T01:00:00.000Z", endedAt: "2026-09-20T02:00:00.000Z",
    generatedAt: "2026-09-20T02:00:00.000Z" });
  options.afterReport?.(state, report);
  const storage = {
    [reconciliationStorage.STORAGE_KEY]: { schemaVersion: reconciliationStorage.STORAGE_SCHEMA_VERSION, reconciliationState: state },
    [reportStorage.STORAGE_KEY]: { schemaVersion: reportStorage.STORAGE_SCHEMA_VERSION, records: [{
      reportId: report.reportId, lifecycleStatus: "finalized", archived: false, report,
    }] },
  };
  return { state, report, storage };
}

function worker(options = {}) {
  const prepared = options.fixture ?? fixture();
  const storage = options.storage ?? clone(prepared.storage);
  const sessionStorage = {};
  const fetchCalls = [];
  const writes = [];
  const errors = [];
  let context;
  let listener;
  let now = Date.parse("2026-09-22T00:00:00Z");
  let uuid = 10;
  function inWorker(value) {
    context.__json = JSON.stringify(value);
    return vm.runInContext("JSON.parse(__json)", context);
  }
  const area = (values) => ({
    async get(key) { return inWorker(Object.hasOwn(values, key) ? { [key]: values[key] } : {}); },
    async set(next) { writes.push(clone(next)); Object.assign(values, clone(next)); },
    async remove(key) { delete values[key]; },
    async setAccessLevel() {},
  });
  const sandbox = {
    AbortController, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    console: { error: (...args) => errors.push(args.map(String)) },
    fetch: async (url, request) => {
      fetchCalls.push({ url, method: request.method });
      if (options.beforeFetch) await options.beforeFetch(fetchCalls.length);
      const payload = options.payload ? options.payload(fetchCalls.length, url) : grid();
      return { status: options.httpStatus ?? 200, headers: { get: () => null }, async text() { return JSON.stringify(payload); } };
    },
    chrome: {
      identity: { async getAuthToken() { if (options.authError) throw new Error("Synthetic auth refusal"); return "synthetic-token"; }, async removeCachedAuthToken() {} },
      storage: { local: area(storage), session: area(sessionStorage) },
      sidePanel: { async setPanelBehavior() {} },
      runtime: { id: "quantity-test", getURL: (name) => `chrome-extension://quantity-test/${name}`,
        getManifest: () => ({ oauth2: { client_id: "12345-test.apps.googleusercontent.com" } }),
        onMessage: { addListener: (value) => { listener = value; } }, async sendMessage() {} },
    },
  };
  sandbox.importScripts = (...names) => names.forEach((name) =>
    vm.runInContext(fs.readFileSync(path.join(EXTENSION, name), "utf8"), context, { filename: name }));
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXTENSION, "service-worker.js"), "utf8"), context);
  const send = (message, url = REPORT_URL) => new Promise((resolve) => {
    assert.equal(listener(inWorker(message), inWorker({ id: "quantity-test", url }),
      (response) => resolve(clone(response))), true);
  });
  const client = clientModule.createStreamReportClient({ runtime: { sendMessage: send }, protocol, streamReport: reports });
  return { prepared, storage, fetchCalls, writes, errors, send, client,
    advance: (milliseconds) => { now += milliseconds; } };
}

const prepare = (h, spreadsheetId = SHEET) => h.client.prepareQuantityHandoff({ reportId: h.prepared.report.reportId, spreadsheetId });
const copy = (h, token) => h.client.copyQuantityHandoff({ reportId: h.prepared.report.reportId, token });
const startMessage = () => ({ channel: streamProtocol.MESSAGE_CHANNEL,
  version: streamProtocol.MESSAGE_VERSION, command: { type: streamProtocol.COMMAND_TYPES.START_STREAM } });

test("quantity handoff uses actual client/worker/Sheets GET in current physical order without writes", async () => {
  const h = worker();
  const before = clone(h.storage);
  const fullExport = reports.serializeInventoryTsv(h.prepared.report);
  const preview = await prepare(h);
  assert.deepEqual(Object.keys(preview).sort(), ["reportId", "token", "spreadsheetId", "sheetTitle", "startCell", "range", "rowCount", "itemCount", "alreadyApplied"].sort());
  assert.equal(preview.startCell, "E2");
  assert.equal(preview.range, "E2:E6");
  assert.equal(preview.rowCount, 5);
  assert.equal(preview.itemCount, 2);
  assert.equal(preview.alreadyApplied, false);
  const output = await copy(h, preview.token);
  assert.equal(output.text, "\r\n4\r\n\r\n\r\n3");
  assert.deepEqual(await copy(h, preview.token), output, "Repeated copies do not subtract again");
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0].method, "GET");
  assert.equal(new URL(h.fetchCalls[0].url).searchParams.get("ranges"), "'Inventory'");
  assert.deepEqual(h.storage, before);
  assert.deepEqual(h.writes, []);
  assert.equal(reports.serializeInventoryTsv(h.prepared.report), fullExport);
  assert.deepEqual(h.errors, []);
});

test("quantity handoff derives a shifted header and reordered quantity column", async () => {
  const rows = [[], [], [HEADER[4], ...HEADER.slice(0, 4), HEADER[5]], [],
    [5, ...row(ITEMS[0]).slice(0, 4), 2], [], [4, ...row(ITEMS[1]).slice(0, 4), 2.5]];
  const h = worker({ payload: () => grid(rows) });
  const preview = await prepare(h);
  assert.equal(preview.startCell, "A4");
  assert.equal(preview.range, "A4:A7");
  assert.equal((await copy(h, preview.token)).text, "\r\n4\r\n\r\n3");
});

test("already-applied entire quantity vector is recognized without another deduction", async () => {
  const h = worker({ payload: () => grid([HEADER, row(ITEMS[1], 3), [], row(ITEMS[0], 4)]) });
  const preview = await prepare(h);
  assert.equal(preview.alreadyApplied, true);
  assert.equal((await copy(h, preview.token)).text, "3\r\n\r\n4");
});

test("quantity preparation rejects malformed, incomplete, conflicting, and mismatched Sheets", async () => {
  const cases = [
    ["missing", [HEADER, row(ITEMS[0])]],
    ["duplicate", [HEADER, row(ITEMS[0]), row(ITEMS[0]), row(ITEMS[1])]],
    ["extra", [HEADER, ...ITEMS.map((item) => row(item)), ["EXTRA", "Extra", "", "OS", 1, 1]]],
    ["restock", [HEADER, row(ITEMS[0], 7), row(ITEMS[1])]],
    ["mixed previous paste", [HEADER, row(ITEMS[0], 4), row(ITEMS[1])]],
    ["unsafe", [HEADER, row(ITEMS[0], Number.MAX_SAFE_INTEGER + 1), row(ITEMS[1])]],
    ["formula", [HEADER, row(ITEMS[0], { formulaValue: "=5" }), row(ITEMS[1])]],
    ["partial blank", [HEADER, [], ["" , "Orphan"], ...ITEMS.map((item) => row(item))]],
  ];
  for (const [label, rows] of cases) {
    const h = worker({ payload: () => grid(rows) });
    await assert.rejects(prepare(h), (error) => error.code !== "INTERNAL_ERROR", label);
    assert.deepEqual(h.writes, [], label);
  }
  const wrong = worker({ payload: () => grid(sheetRows(), OTHER_SHEET) });
  await assert.rejects(prepare(wrong));
});

test("report corrections invalidate a preparation and a fresh quantity copy never includes costs", async () => {
  const h = worker();
  const prepared = await prepare(h);
  await h.client.updateReportUnitCost({ reportId: prepared.reportId, sku: ITEMS[0].sku, unitCostCents: 999 });
  await assert.rejects(copy(h, prepared.token), { code: "QUANTITY_HANDOFF_STALE" });
  const refreshed = await prepare(h);
  assert.equal((await copy(h, refreshed.token)).text, "\r\n4\r\n\r\n\r\n3");
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.storage[reconciliationStorage.STORAGE_KEY].reconciliationState.inventoryBaselines.at(-1).inventory[0].unitCostCents, 200);
});

test("report-only mapping correction changes quantities without requiring canonical mapping edits", async () => {
  const h = worker();
  const prepared = await prepare(h);
  const beforeState = clone(h.storage[reconciliationStorage.STORAGE_KEY]);
  const response = await h.send(protocol.createStreamReportMessage({
    type: protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS, reportId: prepared.reportId,
    changes: [{ variationNumber: 1, expectedStatus: "payment_complete", expectedSku: ITEMS[0].sku, sku: ITEMS[1].sku }],
  }));
  assert.equal(response.ok, true, JSON.stringify(response));
  await assert.rejects(copy(h, prepared.token), { code: "QUANTITY_HANDOFF_STALE" });
  const refreshed = await prepare(h);
  assert.equal((await copy(h, refreshed.token)).text, "\r\n5\r\n\r\n\r\n2");
  assert.deepEqual(h.storage[reconciliationStorage.STORAGE_KEY], beforeState);
});

test("preparations expire, are replaced on another verification, and never survive worker restart", async () => {
  const h = worker();
  const first = await prepare(h);
  const second = await prepare(h);
  await assert.rejects(copy(h, first.token), { code: "QUANTITY_HANDOFF_EXPIRED" });
  h.advance(10 * 60 * 1000);
  await assert.rejects(copy(h, second.token), { code: "QUANTITY_HANDOFF_EXPIRED" });
  const third = await prepare(h);
  const restarted = worker({ storage: h.storage });
  await assert.rejects(copy(restarted, third.token), { code: "QUANTITY_HANDOFF_EXPIRED" });
  assert.equal(JSON.stringify(h.storage).includes("quantity-handoff:"), false);
  assert.equal(JSON.stringify(h.storage).includes(SHEET), false);
});

test("failed verification of a changed link invalidates a prior preparation", async () => {
  const h = worker({ payload: (call) => grid(sheetRows(), call === 1 ? SHEET : SHEET) });
  const preview = await prepare(h);
  await assert.rejects(prepare(h, OTHER_SHEET));
  await assert.rejects(copy(h, preview.token), { code: "QUANTITY_HANDOFF_EXPIRED" });
});

test("quantity handoff rejects active/newer sessions before Sheet access or copying", async () => {
  const h = worker();
  const preview = await prepare(h);
  const response = await h.send(startMessage(), PANEL_URL);
  assert.equal(response.ok, true, JSON.stringify(response));
  await assert.rejects(copy(h, preview.token), { code: "ACTIVE_STREAM_ALREADY_EXISTS" });
  await assert.rejects(prepare(h), { code: "ACTIVE_STREAM_ALREADY_EXISTS" });
  assert.equal(h.fetchCalls.length, 1);
});

test("new inventory import invalidates an existing prepared handoff without overwriting the report", async () => {
  const h = worker();
  const preview = await prepare(h);
  const oldReport = clone(h.storage[reportStorage.STORAGE_KEY]);
  const imported = await h.send(importProtocol.createInventoryImportMessage({ type: importProtocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET, spreadsheetId: SHEET }), PANEL_URL);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const confirmed = await h.send(importProtocol.createInventoryImportMessage({ type: importProtocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT, previewToken: imported.data.previewToken }), PANEL_URL);
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  await assert.rejects(copy(h, preview.token), { code: "QUANTITY_REPORT_STALE" });
  assert.deepEqual(h.storage[reportStorage.STORAGE_KEY], oldReport);
});

test("canonical payments newer than the saved report fail closed instead of establishing a stale preparation", async () => {
  const f = fixture({ afterReport(state) {
    reconciliation.observePaymentStatuses(state, { streamId: STREAM,
      statuses: [{ variationNumber: 3, observedPaymentStatus: "canceled" }] });
  } });
  const h = worker({ fixture: f });
  await assert.rejects(prepare(h), { code: "QUANTITY_REPORT_STALE" });
  assert.equal(h.fetchCalls.length, 0);
  assert.deepEqual(h.writes, []);
});

test("new canonical price conflicts invalidate an otherwise unchanged saved sale", async () => {
  const h = worker({ fixture: fixture({ afterReport(state) {
    reconciliation.recordPaymentComplete(state, { streamId: STREAM, variationNumber: 1, soldPriceCents: 5000 });
  } }) });
  await assert.rejects(prepare(h), { code: "QUANTITY_REPORT_STALE" });
  assert.equal(h.fetchCalls.length, 0);
});

test("a known newer report or missing baseline lineage refuses old quantity export", async () => {
  const newer = fixture();
  const newerRecord = clone(newer.storage[reportStorage.STORAGE_KEY].records[0]);
  newerRecord.reportId = newerRecord.reportId.replace("11111111", "99999999");
  newerRecord.report.reportId = newerRecord.reportId;
  newerRecord.report.metadata.streamId = newerRecord.report.metadata.streamId.replace("11111111", "99999999");
  newerRecord.report.metadata.endedAt = "2026-09-21T02:00:00.000Z";
  newerRecord.report.metadata.generatedAt = "2026-09-21T02:00:00.000Z";
  newer.storage[reportStorage.STORAGE_KEY].records.push(newerRecord);
  const h = worker({ fixture: newer });
  await assert.rejects(prepare(h), { code: "QUANTITY_REPORT_STALE" });
  assert.equal(h.fetchCalls.length, 0);
  const missing = fixture();
  delete missing.storage[reconciliationStorage.STORAGE_KEY];
  const unavailable = worker({ fixture: missing });
  await assert.rejects(prepare(unavailable));
  assert.equal(unavailable.fetchCalls.length, 0);
  assert.deepEqual(unavailable.writes, []);
});

test("oversold stock keeps the authoritative zero clamp and saved recount warning", async () => {
  const h = worker({ fixture: fixture({ beforeReport(state) {
    for (let variationNumber = 3; variationNumber <= 8; variationNumber += 1) {
      reconciliation.mapVariation(state, { streamId: STREAM, variationNumber, sku: ITEMS[0].sku });
      reconciliation.recordPaymentComplete(state, { streamId: STREAM, variationNumber, soldPriceCents: 1500 });
    }
  } }) });
  const prepared = await prepare(h);
  assert.equal((await copy(h, prepared.token)).text, "\r\n0\r\n\r\n\r\n3");
  assert.equal(h.prepared.report.warnings.some((warning) => warning.code === "inventory_recount_required"), true);
  assert.deepEqual(h.writes, []);
});

test("unfinished, unmapped, and conflicting report exports remain blocked", async () => {
  for (const beforeReport of [
    (state) => reconciliation.mapVariation(state, { streamId: STREAM, variationNumber: 3, sku: ITEMS[0].sku }),
    (state) => reconciliation.recordPaymentComplete(state, { streamId: STREAM, variationNumber: 3, soldPriceCents: 1200 }),
    (state) => reconciliation.recordPaymentComplete(state, { streamId: STREAM, variationNumber: 1, soldPriceCents: 1200 }),
  ]) {
    const h = worker({ fixture: fixture({ beforeReport }) });
    await assert.rejects(prepare(h), { code: "QUANTITY_REPORT_NOT_READY" });
    assert.equal(h.fetchCalls.length, 0);
  }
});

test("authentication and permission failures never return prepared text or write data", async () => {
  for (const options of [{ authError: true }, { httpStatus: 403 }]) {
    const h = worker(options);
    await assert.rejects(prepare(h), (error) => /GOOGLE/.test(error.code));
    assert.deepEqual(h.writes, []);
  }
});

test("report-only quantity commands reject unauthorized pages before authentication", async () => {
  const h = worker();
  for (const url of [PANEL_URL, "https://example.test", "chrome-extension://quantity-test/report/other.html"]) {
    const response = await h.send(protocol.createStreamReportMessage({
      type: protocol.COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF, reportId: h.prepared.report.reportId, spreadsheetId: SHEET,
    }), url);
    assert.equal(response.error.code, "UNAUTHORIZED_MESSAGE_SENDER");
  }
  assert.equal(h.fetchCalls.length, 0);
});

test("a delayed read remains serialized with session Start and copy rejects the changed session", async () => {
  let release;
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = worker({ beforeFetch: async () => { entered(); await gate; } });
  const preparing = prepare(h);
  await reached;
  const starting = h.send(startMessage(), PANEL_URL);
  release();
  const preview = await preparing;
  assert.equal((await starting).ok, true);
  await assert.rejects(copy(h, preview.token), { code: "ACTIVE_STREAM_ALREADY_EXISTS" });
});
