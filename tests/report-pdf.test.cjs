const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const pdf = require("../extension/report/report-pdf.js");
const reportPage = require("../extension/report/report-page.js");
const { makePdfRecord } = require("./helpers/report-pdf-fixtures.cjs");

const root = path.join(__dirname, "..");
const fonts = {
  normal: fs.readFileSync(path.join(root, "extension/vendor/fonts/DejaVuSans.ttf")).toString("base64"),
  bold: fs.readFileSync(path.join(root, "extension/vendor/fonts/DejaVuSans-Bold.ttf")).toString("base64"),
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("PDF presentation uses the existing report metrics, names, notices and every printed table", () => {
  const record = makePdfRecord({ allWarnings: true });
  const original = structuredClone(record);
  const model = pdf.createReportPresentation(deepFreeze(record));
  assert.equal(model.name, record.displayName);
  assert.deepEqual(model.metrics, reportPage.createSummaryMetrics(record.report));
  assert.equal(model.started, reportPage.formatTimestamp(record.report.metadata.startedAt));
  assert.equal(model.ended, reportPage.formatTimestamp(record.report.metadata.endedAt));
  assert.equal(model.warnings.length, 7);
  assert.equal(model.warnings[4], "Completed sales have no item assigned. Metrics are incomplete. Count: 1.");
  assert.equal(model.warnings[6], "More units were allocated than starting stock. Check oversold units and recount stock. Oversold: 2. SKU: SKU-0001.");
  assert.deepEqual(model.tables.map((table) => table.rows.length), [3, 3, 4]);
  assert.deepEqual(model.tables[0].rows[0].map((cell) => cell.text), [
    "SKU-0001", "Café winter collection - Long-sleeve tee - limited edition", "OS", "1", "$5.00", "$15.00", "$15.00", "$5.00", "1.0%", "66.7%", "+$10.00",
  ]);
  assert.deepEqual(model.tables[1].rows[0].map((cell) => cell.text), [
    "SKU-0001", "Café winter collection", "Long-sleeve tee - limited edition", "OS", "$5.00", "100", "3", "97", "0",
  ]);
  assert.deepEqual(model.tables[2].rows.at(-1).map((cell) => cell.text), [
    "#4", "Canceled", "Unmapped", "Not selected", "—", "—", "—", "—", "—",
  ]);
  assert.equal(model.performers.length, 3);
  assert.equal(model.performers[0].rows.length, 2);
  assert.match(model.performers[0].rows[0].description, /SKU-0001/);
  assert.equal(model.footer[0], "Stream reference: local-stream:synthetic-pdf-verification-only");
  assert.deepEqual(record, original, "Presentation must not mutate saved report or inventory data");
  const content = JSON.stringify(model);
  for (const excluded of ["synthetic-secret-not-for-pdf", "private.invalid", "synthetic-private-buyer", "Correct Item Mapping", "Print / Save as PDF", "Download Updated Inventory CSV"]) {
    assert.ok(!content.includes(excluded), `${excluded} must not appear in print content`);
  }
});

test("PDF table headings match all three printed report tables", () => {
  const html = fs.readFileSync(path.join(root, "extension/report/report.html"), "utf8");
  const model = pdf.createReportPresentation(makePdfRecord());
  for (const [index, className] of ["performance-table", "inventory-table", "sales-table"].entries()) {
    const table = html.match(new RegExp(`<table class="data-table ${className}">([\\s\\S]*?)<\\/table>`))[1];
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((entry) => entry[1].replace(/\s+/g, " ").trim());
    assert.deepEqual(model.tables[index].headers, headers);
  }
});

test("PDF presentation preserves older report fallbacks, canceled detail notices, and empty sections", () => {
  const record = makePdfRecord({ rows: 0 });
  delete record.displayName;
  delete record.report.canceledOrders;
  record.report.topProducts = {};
  record.report.warnings = [];
  const model = pdf.createReportPresentation(record);
  assert.equal(model.name, reportPage.formatTimestamp(record.report.metadata.startedAt));
  assert.notEqual(model.name, reportPage.formatTimestamp(record.report.metadata.endedAt));
  assert.equal(model.started, reportPage.formatTimestamp(record.report.metadata.startedAt));
  assert.equal(model.ended, reportPage.formatTimestamp(record.report.metadata.endedAt));
  assert.equal(model.tables[2].count, "1 variation");
  assert.equal(model.tables[2].note, "Individual item details for 1 canceled variation were not saved in this older report. The canceled total is still included above.");
  assert.equal(model.performers.length, 2);
  assert.equal(model.performers[0].rows[0].description, "Not enough mapped completed-sale data.");
  assert.deepEqual(model.warnings, []);
});

test("direct PDF generation returns real PDF bytes with fonts and never mutates its frozen record", async () => {
  const record = deepFreeze(makePdfRecord({ longName: true, allWarnings: true }));
  const before = JSON.stringify(record);
  const bytes = await pdf.generateReportPdf(record, { fonts });
  assert.ok(bytes instanceof Uint8Array);
  const raw = Buffer.from(bytes).toString("latin1");
  assert.ok(raw.startsWith("%PDF-"));
  assert.match(raw, /\/FontFile2/);
  assert.match(raw, /\/ToUnicode/);
  assert.match(raw, /%%EOF/);
  assert.equal(JSON.stringify(record), before);
});

test("long PDFs retain all rows, repeat headings and use automatic table pagination", async () => {
  const record = deepFreeze(makePdfRecord({ rows: 180, longName: true, allWarnings: true }));
  const { autoTable } = require("../extension/vendor/jspdf-autotable/jspdf.plugin.autotable.min.js");
  const calls = [];
  const bytes = await pdf.generateReportPdf(record, {
    fonts,
    autoTable(document, settings) {
      calls.push(settings);
      autoTable(document, settings);
    },
  });
  assert.deepEqual(calls.map((call) => call.body.length), [180, 180, 181]);
  assert.ok(calls.every((call) => call.showHead === "everyPage" && call.rowPageBreak === "avoid"));
  assert.equal(calls[0].body.at(-1)[0].content, "SKU-0180");
  assert.equal(calls[1].body.at(-1)[0].content, "SKU-0180");
  assert.equal(calls[2].body.at(-1)[0].content, "#181");
  const pages = Buffer.from(bytes).toString("latin1").match(/\/Type \/Page\b/g) ?? [];
  assert.ok(pages.length > 6, `Expected multiple pages, received ${pages.length}`);
});

test("unsupported characters fail clearly instead of silently disappearing from PDFs", async () => {
  const record = makePdfRecord();
  record.displayName = "Test 中文 📦";
  await assert.rejects(pdf.generateReportPdf(record, { fonts }), /font cannot display.*Use Print \/ Save as PDF/);
});

test("missing report data, fonts, or PDF dependencies produce actionable failures", async () => {
  assert.throws(() => pdf.createReportPresentation(null), /saved report is unavailable/);
  await assert.rejects(pdf.generateReportPdf(makePdfRecord(), { fonts: {} }), /fonts are unavailable/);
  await assert.rejects(pdf.generateReportPdf(makePdfRecord(), { jsPDF: {}, fonts }), /PDF library is unavailable/);
});

test("loading report-page helpers in the side panel does not mount the report editor", () => {
  const source = fs.readFileSync(path.join(root, "extension/report/report-page.js"), "utf8");
  let queries = 0;
  vm.runInNewContext(source, {
    document: { readyState: "complete", querySelector(selector) { queries += 1; assert.equal(selector, "#report-content"); return null; } },
    addEventListener() {},
  });
  assert.equal(queries, 1);
});

test("browser PDF generation fetches only bundled local fonts and reuses them for a batch", async () => {
  const source = fs.readFileSync(path.join(root, "extension/report/report-pdf.js"), "utf8");
  const { jsPDF } = require("../extension/vendor/jspdf/jspdf.umd.min.js");
  const { autoTable } = require("../extension/vendor/jspdf-autotable/jspdf.plugin.autotable.min.js");
  const fetched = [];
  const context = {
    TikTokLiveTrackerStreamReportPage: reportPage, jspdf: { jsPDF },
    chrome: { runtime: { getURL(value) { return `chrome-extension://synthetic/${value}`; } } },
    async fetch(url) {
      fetched.push(url);
      const bytes = Buffer.from(url.endsWith("-Bold.ttf") ? fonts.bold : fonts.normal, "base64");
      return { ok: true, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
  };
  vm.runInNewContext(source, context);
  await context.TikTokLiveTrackerReportPdf.generateReportPdf(makePdfRecord(), { autoTable });
  await context.TikTokLiveTrackerReportPdf.generateReportPdf(makePdfRecord(), { autoTable });
  assert.deepEqual(fetched.sort(), [
    "chrome-extension://synthetic/vendor/fonts/DejaVuSans-Bold.ttf",
    "chrome-extension://synthetic/vendor/fonts/DejaVuSans.ttf",
  ]);
});

test("bundled browser UMD libraries generate a PDF without remote dependencies or eval", async () => {
  const context = vm.createContext({
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    navigator: { userAgent: "synthetic-test" },
    document: { createElement() { return {}; } },
    atob(value) { return Buffer.from(value, "base64").toString("binary"); },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
    TikTokLiveTrackerStreamReportPage: reportPage,
  }, { codeGeneration: { strings: false, wasm: false } });
  context.window = context;
  context.self = context;
  for (const name of [
    "extension/vendor/jspdf/jspdf.umd.min.js",
    "extension/vendor/jspdf-autotable/jspdf.plugin.autotable.min.js",
    "extension/report/report-pdf.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name });
  }
  const bytes = await context.TikTokLiveTrackerReportPdf.generateReportPdf(makePdfRecord(), { fonts });
  assert.ok(Buffer.from(bytes).toString("latin1").startsWith("%PDF-"));
});
