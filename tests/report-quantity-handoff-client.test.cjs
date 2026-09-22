"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const protocol = require("../extension/shared/stream-report-protocol.js");
const clientModule = require("../extension/report/stream-report-client.js");
const REPORT = "stream-report:11111111-1111-4111-8111-111111111111";
const TOKEN = "quantity-handoff:22222222-2222-4222-8222-222222222222";
const SHEET = "1Synthetic_quantity_sheet_123";
const preview = () => ({ reportId: REPORT, token: TOKEN, spreadsheetId: SHEET,
  sheetTitle: "Inventory", startCell: "E2", range: "E2:E5", rowCount: 4,
  itemCount: 2, alreadyApplied: false });
function client(options = {}) {
  return clientModule.createStreamReportClient({
    runtime: { async sendMessage() { return { ok: true, data: preview() }; } },
    protocol, streamReport: { hydrateStreamReport: (value) => value }, ...options,
  });
}

test("quantity commands have strict ID/token-only contracts and reject caller data", () => {
  const prepare = { type: protocol.COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF, reportId: REPORT, spreadsheetId: SHEET };
  const copy = { type: protocol.COMMAND_TYPES.COPY_QUANTITY_HANDOFF, reportId: REPORT, token: TOKEN };
  for (const command of [prepare, copy]) {
    assert.deepEqual(protocol.createStreamReportMessage(command).command, command);
    for (const field of ["text", "layout", "range", "report", "baselineId"]) {
      assert.throws(() => protocol.validateCommand({ ...command, [field]: "injected" }), { code: "INVALID_COMMAND" });
    }
  }
  for (const spreadsheetId of ["", "short", "https://docs.google.com/sheets/", "x".repeat(201), null, 1]) {
    assert.throws(() => protocol.validateCommand({ ...prepare, spreadsheetId }), { code: "INVALID_SPREADSHEET_ID" });
  }
  for (const token of ["", "arbitrary", "inventory-preview:22222222-2222-4222-8222-222222222222", null]) {
    assert.throws(() => protocol.validateCommand({ ...copy, token }), { code: "INVALID_QUANTITY_HANDOFF_TOKEN" });
  }
});

test("quantity client returns detached preview and numeric-only clipboard payload", async () => {
  const sent = [];
  const data = preview();
  const c = client({ runtime: { async sendMessage(message) {
    sent.push(message.command);
    return { ok: true, data: message.command.type === "copy_quantity_handoff" ? { ...data, text: "\r\n0\r\n\r\n3" } : data };
  } } });
  const first = await c.prepareQuantityHandoff({ reportId: REPORT, spreadsheetId: SHEET });
  first.range = "changed";
  assert.equal(data.range, "E2:E5");
  const copied = await c.copyQuantityHandoff({ reportId: REPORT, token: TOKEN });
  assert.equal(copied.text, "\r\n0\r\n\r\n3");
  assert.deepEqual(sent, [
    { type: "prepare_quantity_handoff", reportId: REPORT, spreadsheetId: SHEET },
    { type: "copy_quantity_handoff", reportId: REPORT, token: TOKEN },
  ]);
});

test("quantity client rejects changed identity and unsupported or inconsistent target metadata", async () => {
  const invalid = [
    { reportId: REPORT.replace("11111111", "22222222") }, { token: "bad" },
    { spreadsheetId: "1Other_synthetic_quantity_123" }, { sheetTitle: "Other" },
    { startCell: "E1" }, { range: "E2:F5" }, { range: "E2:E6" },
    { startCell: "ZZZ2", range: "ZZZ2:ZZZ5" },
    { startCell: "E1", range: "E1:E4" },
    { range: "E2:E1002", rowCount: 1001 },
    { rowCount: 0 }, { rowCount: 1.5 }, { itemCount: 0 }, { itemCount: 5 },
    { alreadyApplied: "false" }, { text: "not allowed in preview" },
    { internalSecret: "not allowed" },
  ];
  for (const overrides of invalid) {
    const c = client({ runtime: { async sendMessage() { return { ok: true, data: { ...preview(), ...overrides } }; } } });
    await assert.rejects(c.prepareQuantityHandoff({ reportId: REPORT, spreadsheetId: SHEET }), { code: "INVALID_RESPONSE" });
  }
});

test("quantity copy client refuses malformed values, formula/tab output, and changed tokens", async () => {
  for (const text of ["0\n3", "\n0\n\n3\n", "\n=1\n\n3", "\n1\t2\n\n3", "\n-1\n\n3", "\n1.5\n\n3", "\n9007199254740992\n\n3", "\n01\n\n3", null]) {
    const c = client({ runtime: { async sendMessage() { return { ok: true, data: { ...preview(), text } }; } } });
    await assert.rejects(c.copyQuantityHandoff({ reportId: REPORT, token: TOKEN }), { code: "INVALID_RESPONSE" });
  }
  const c = client({ runtime: { async sendMessage() { return { ok: true, data: { ...preview(), token: TOKEN.replace("22222222", "33333333"), text: "\n0\n\n3" } }; } } });
  await assert.rejects(c.copyQuantityHandoff({ reportId: REPORT, token: TOKEN }), { code: "INVALID_RESPONSE" });
});

test("only quantity preparation gets the longer Sheets timeout; ordinary requests remain unchanged", async () => {
  const timers = [];
  const cleared = [];
  const c = client({ runtime: { async sendMessage(message) {
    if (message.command.type === "get_library_capacity") return { ok: true, data: { usedBytes: 0, maxBytes: 100, totalReports: 0, maxReports: 30 } };
    return { ok: true, data: message.command.type === "copy_quantity_handoff" ? { ...preview(), text: "\n0\n\n3" } : preview() };
  } }, setTimeoutImpl(callback, ms) { timers.push(ms); return timers.length; }, clearTimeoutImpl(id) { cleared.push(id); } });
  await c.prepareQuantityHandoff({ reportId: REPORT, spreadsheetId: SHEET });
  await c.copyQuantityHandoff({ reportId: REPORT, token: TOKEN });
  await c.getLibraryCapacity();
  assert.deepEqual(timers, [90_000, 10_000, 10_000]);
  assert.deepEqual(cleared, [1, 2, 3]);
});

test("hung preparation and service failures cannot return stale success", async () => {
  let expire;
  const c = client({ runtime: { sendMessage: () => new Promise(() => {}) },
    setTimeoutImpl(callback) { expire = callback; return 1; }, clearTimeoutImpl() {} });
  const pending = c.prepareQuantityHandoff({ reportId: REPORT, spreadsheetId: SHEET });
  await Promise.resolve();
  expire();
  await assert.rejects(pending, { code: "REPORT_REQUEST_TIMEOUT" });
  const failure = client({ runtime: { async sendMessage() { return { ok: false, error: { code: "QUANTITY_HANDOFF_STALE", message: "Verify again." } }; } } });
  await assert.rejects(failure.copyQuantityHandoff({ reportId: REPORT, token: TOKEN }), { code: "QUANTITY_HANDOFF_STALE" });
});
