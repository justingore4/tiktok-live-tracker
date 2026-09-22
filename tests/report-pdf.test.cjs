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

test("PDF presentation retains existing metrics and canceled SKU summary above canceled-only details", () => {
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
  assert.deepEqual(model.tables.map((table) => table.rows.length), [3, 3, 4, 1, 1]);
  assert.deepEqual(model.tables.map((table) => table.key), ["performance", "inventory", "variations", "canceledSummary", "canceled"]);
  assert.deepEqual(model.tables[0].rows[0].map((cell) => cell.text), [
    "SKU-0001", "Café winter collection - Long-sleeve tee - limited edition", "OS", "1", "$5.00", "$15.00", "$15.00", "$5.00", "1.0%", "66.7%", "+$10.00",
  ]);
  assert.deepEqual(model.tables[1].rows[0].map((cell) => cell.text), [
    "SKU-0001", "Café winter collection", "Long-sleeve tee - limited edition", "OS", "$5.00", "100", "3", "97", "0",
  ]);
  assert.deepEqual(model.tables[2].rows.at(-1).map((cell) => cell.text), [
    "#4", "Canceled", "Unmapped", "Not selected", "—", "—", "—", "—", "—",
  ]);
  assert.deepEqual(model.tables[3].rows[0].map((cell) => cell.text), [
    "Unmapped", "Not selected", "—", "1",
  ]);
  assert.deepEqual(model.tables[4].rows[0].map((cell) => cell.text), [
    "#4", "Canceled", "Unmapped", "Not selected", "—", "—",
  ]);
  assert.equal(model.tables[4].count, "1 canceled order");
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

test("PDF table headings match their corresponding report tables", () => {
  const html = fs.readFileSync(path.join(root, "extension/report/report.html"), "utf8");
  const model = pdf.createReportPresentation(makePdfRecord());
  for (const [index, className] of ["performance-table", "inventory-table", "sales-table", "canceled-sku-summary-table", "canceled-orders-table"].entries()) {
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
  assert.equal(model.tables[3].count, "1 canceled order");
  assert.equal(model.tables[3].note, model.tables[2].note);
  assert.deepEqual(model.tables[3].rows, []);
  assert.equal(model.tables[3].emptyHidden, true, "Legacy cancellation totals must not be presented as no cancellations");
  assert.ok(!model.tables.some((table) => table.key === "canceledSummary"), "Missing legacy detail must not invent a SKU summary");
  assert.equal(model.performers.length, 2);
  assert.equal(model.performers[0].rows[0].description, "Not enough mapped completed-sale data.");
  assert.deepEqual(model.warnings, []);
});

test("PDF canceled-only rows include every reference mapping in variation order without money columns", () => {
  const record = makePdfRecord();
  record.report.canceledOrders = [
    { variationNumber: 12, mapped: true, ...record.report.inventory[0] },
    { variationNumber: 4, sku: null },
    { variationNumber: 8, mapped: true, ...record.report.inventory[1] },
  ];
  record.report.totals.canceledOrderCount = 3;
  record.report.totals.totalSalesCount = 6;
  const before = structuredClone(record);
  const model = pdf.createReportPresentation(deepFreeze(record));
  const table = model.tables.find((entry) => entry.key === "canceled");
  assert.equal(table.title, "Canceled orders");
  assert.equal(table.eyebrow, "Canceled variations");
  assert.equal(table.count, "3 canceled orders");
  assert.deepEqual(table.headers, ["Variation", "Status", "SKU", "Item", "Style", "Size"]);
  assert.deepEqual(table.rows.map((row) => row[0].text), ["#4", "#8", "#12"]);
  assert.deepEqual(table.rows[2].map((cell) => cell.text), [
    "#12", "Canceled", "SKU-0001", "Café winter collection", "Long-sleeve tee - limited edition", "OS",
  ]);
  assert.ok(table.rows.every((row) => row.length === 6 && row[1].text === "Canceled"));
  assert.deepEqual(model.tables[2].rows.map((row) => row[0].text), ["#1", "#2", "#3", "#4", "#8", "#12"]);
  assert.ok(model.tables[2].rows.every((row) => row.length === 9));
  assert.deepEqual(model.metrics, reportPage.createSummaryMetrics(record.report));
  assert.deepEqual(record, before);
});

test("PDF canceled-only empty state shows no orders without inventing rows or legacy notices", () => {
  const record = makePdfRecord({ rows: 0 });
  record.report.canceledOrders = [];
  record.report.totals.canceledOrderCount = 0;
  record.report.totals.totalSalesCount = 0;
  const model = pdf.createReportPresentation(record);
  const table = model.tables.find((entry) => entry.key === "canceled");
  assert.ok(!model.tables.some((entry) => entry.key === "canceledSummary"), "Empty cancellations need only the existing detail empty state");
  assert.equal(table.count, "0 canceled orders");
  assert.deepEqual(table.rows, []);
  assert.equal(table.empty, "No canceled orders were captured for this stream.");
  assert.equal(table.emptyHidden, false);
  assert.equal(table.note, "");
});

test("PDF canceled SKU summary groups exact SKUs and puts unmapped cancellations last", () => {
  const record = makePdfRecord();
  record.report.canceledOrders = [
    { variationNumber: 9, mapped: true, sku: "BAPE-TEE-M", item: "BAPE TEE", style: "RED CAMO", size: "M" },
    { variationNumber: 5, mapped: false, sku: null },
    { variationNumber: 7, mapped: true, sku: "BAPE-TEE-L", item: "BAPE TEE", style: "RED CAMO", size: "L" },
    { variationNumber: 4, mapped: true, sku: "BAPE-TEE-M", item: "BAPE TEE", style: "RED CAMO", size: "M" },
    { variationNumber: 8, mapped: false, sku: null },
  ];
  record.report.totals.canceledOrderCount = 5;
  record.report.totals.totalSalesCount = 8;
  const before = structuredClone(record);
  const model = pdf.createReportPresentation(deepFreeze(record));
  const summaryIndex = model.tables.findIndex((table) => table.key === "canceledSummary");
  const summary = model.tables[summaryIndex];
  assert.equal(model.tables[summaryIndex + 1].key, "canceled");
  assert.equal(summary.title, "Canceled orders by SKU");
  assert.deepEqual(summary.headers, ["SKU", "Item", "Style", "Canceled"]);
  assert.deepEqual(summary.rows.map((row) => row.map((cell) => cell.text)), [
    ["BAPE-TEE-L", "BAPE TEE", "RED CAMO", "1"],
    ["BAPE-TEE-M", "BAPE TEE", "RED CAMO", "2"],
    ["Unmapped", "Not selected", "—", "2"],
  ]);
  assert.ok(summary.rows.every((row) => row[3].className.includes("number-cell")));
  assert.deepEqual(model.metrics, reportPage.createSummaryMetrics(record.report));
  assert.deepEqual(record, before, "The summary must not alter saved orders, totals, or inventory");
});

test("PDF canceled SKU summary omits Unmapped when every cancellation has an item", () => {
  const record = makePdfRecord();
  record.report.canceledOrders = [
    { variationNumber: 4, mapped: true, ...record.report.inventory[1] },
    { variationNumber: 6, mapped: true, ...record.report.inventory[1] },
  ];
  record.report.totals.canceledOrderCount = 2;
  const summary = pdf.createReportPresentation(record).tables.find((table) => table.key === "canceledSummary");
  assert.equal(summary.rows.length, 1);
  assert.deepEqual(summary.rows[0].map((cell) => cell.text), [
    record.report.inventory[1].sku, record.report.inventory[1].item, record.report.inventory[1].style, "2",
  ]);
  assert.ok(!summary.rows.some((row) => row[0].text === "Unmapped"));
});

test("empty and legacy direct PDFs omit the SKU summary heading without replacing their existing notices", async () => {
  const { jsPDF } = require("../extension/vendor/jspdf/jspdf.umd.min.js");
  for (const legacy of [false, true]) {
    const record = makePdfRecord({ rows: 0 });
    if (legacy) {
      delete record.report.canceledOrders;
    } else {
      record.report.canceledOrders = [];
      record.report.totals.canceledOrderCount = 0;
      record.report.totals.totalSalesCount = 0;
    }
    const texts = [];
    function RecordingPdf(options) {
      const document = new jsPDF(options);
      const originalText = document.text;
      document.text = function recordText(value, ...args) {
        texts.push(...[value].flat());
        return originalText.call(this, value, ...args);
      };
      return document;
    }
    const bytes = await pdf.generateReportPdf(record, { fonts, jsPDF: RecordingPdf });
    assert.ok(Buffer.from(bytes).toString("latin1").startsWith("%PDF-"));
    assert.ok(!texts.some((value) => value.includes("Canceled orders by SKU")));
    assert.ok(texts.includes("Canceled orders"));
    const content = texts.join(" ");
    assert.equal(content.includes("No canceled orders were captured for this stream."), !legacy);
    assert.equal(content.includes("Individual item details for 1 canceled variation"), legacy);
  }
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
  const record = makePdfRecord({ rows: 180, longName: true, allWarnings: true });
  record.report.canceledOrders = Array.from({ length: 180 }, (_, index) => ({
    variationNumber: 360 - index, mapped: true, ...record.report.inventory[index],
  }));
  record.report.totals.canceledOrderCount = 180;
  record.report.totals.totalSalesCount = 360;
  deepFreeze(record);
  const { autoTable } = require("../extension/vendor/jspdf-autotable/jspdf.plugin.autotable.min.js");
  const calls = [];
  const continuedTables = new Set();
  const bytes = await pdf.generateReportPdf(record, {
    fonts,
    autoTable(document, settings) {
      calls.push(settings);
      const willDrawPage = settings.willDrawPage;
      const tableIndex = calls.length - 1;
      settings.willDrawPage = (data) => {
        if (data.pageNumber > 1) continuedTables.add(tableIndex);
        willDrawPage(data);
      };
      autoTable(document, settings);
    },
  });
  assert.deepEqual(calls.map((call) => call.body.length), [180, 180, 360, 180, 180]);
  assert.ok(calls.every((call) => call.showHead === "everyPage" && call.rowPageBreak === "avoid"));
  assert.equal(calls[0].body.at(-1)[0].content, "SKU-0180");
  assert.equal(calls[1].body.at(-1)[0].content, "SKU-0180");
  assert.equal(calls[2].body.at(-1)[0].content, "#360");
  assert.deepEqual(calls[3].head, [["SKU", "Item", "Style", "Canceled"]]);
  assert.equal(calls[3].body[0][0].content, "SKU-0001");
  assert.equal(calls[3].body.at(-1)[0].content, "SKU-0180");
  assert.ok(calls[3].body.every((row) => row.length === 4 && row[3].content === "1"));
  assert.equal(calls[4].body[0][0].content, "#181");
  assert.equal(calls[4].body.at(-1)[0].content, "#360");
  assert.ok(calls[4].body.every((row) => row.length === 6));
  assert.ok(continuedTables.has(2), "Combined variations must span pages without truncation");
  assert.ok(continuedTables.has(3), "Canceled SKU summary must span pages without truncation");
  assert.ok(continuedTables.has(4), "Canceled-only rows must span pages without truncation");
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
  const tableHeaders = [];
  const options = { autoTable(document, settings) {
    tableHeaders.push(settings.head[0]);
    autoTable(document, settings);
  } };
  await context.TikTokLiveTrackerReportPdf.generateReportPdf(makePdfRecord(), options);
  await context.TikTokLiveTrackerReportPdf.generateReportPdf(makePdfRecord(), options);
  assert.equal(tableHeaders.length, 10, "Every report in a batch must include all five tables");
  assert.deepEqual(Array.from(tableHeaders[3]), ["SKU", "Item", "Style", "Canceled"]);
  assert.deepEqual(Array.from(tableHeaders[8]), ["SKU", "Item", "Style", "Canceled"]);
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
