const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");
const clientModule = require("../extension/report/stream-report-client.js");
const reportPage = require("../extension/report/report-page.js");

const REPORT_ID = "stream-report:11111111-1111-4111-8111-111111111111";
const SECOND_REPORT_ID = "stream-report:22222222-2222-4222-8222-222222222222";
const STARTED_AT = "2026-08-10T01:00:00.000Z";
const ENDED_AT = "2026-08-10T02:00:00.000Z";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toLocaleLowerCase("en-US");
    this.children = [];
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.className = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.clicked = false;
    this.removed = false;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  focus() {}

  click() {
    this.clicked = true;
    this.listeners.get("click")?.({ currentTarget: this });
  }

  remove() {
    this.removed = true;
  }
}

const REPORT_SELECTORS = [
  "#action-feedback",
  "#completed-sales-rows",
  "#completed-sales-disclosure",
  "#copy-inventory",
  "#copy-sku-counts",
  "#download-inventory",
  "#inventory-rows",
  "#most-profitable-items",
  "#most-profitable-products",
  "#most-profitable-products-card",
  "#most-sold-items",
  "#most-sold-products",
  "#most-sold-products-card",
  "#performance-empty",
  "#performance-row-count",
  "#performance-rows",
  "#print-report",
  "#report-content",
  "#report-definitions",
  "#report-error",
  "#report-error-message",
  "#report-generated-at",
  "#report-loading",
  "#report-warnings",
  "#retry-report",
  "#sales-count",
  "#sales-empty",
  "#sku-count-list",
  "#stream-ended",
  "#stream-reference",
  "#stream-started",
  "#summary-grid",
  "#warnings-section",
];

class FakeDocument {
  constructor() {
    this.elements = new Map(
      REPORT_SELECTORS.map((selector) => [selector, new FakeElement()]),
    );
    this.createdTags = [];
    this.body = new FakeElement("body");
    this.title = "";
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  createElement(tagName) {
    this.createdTags.push(tagName.toLocaleLowerCase("en-US"));
    return new FakeElement(tagName);
  }
}

function createReport(overrides = {}) {
  const malicious = '<img src=x onerror="stealOAuthToken()">';
  const base = {
    reportId: REPORT_ID,
    metadata: {
      streamId: "local-stream:11111111-1111-4111-8111-111111111111",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      generatedAt: ENDED_AT,
      inventoryBaselineId: "baseline-1",
      activeBiddingVariationNumber: null,
    },
    completeness: { status: "provisional", reasonCodes: ["unmapped_completed_sales"] },
    totals: {
      completedPaymentCount: 2,
      totalSalesCount: 3,
      completedGmvCents: 2500,
      grossProfitCents: 900,
      unmappedCompletedCount: 1,
      canceledOrderCount: 1,
      paymentFixingCount: 0,
      attributedGmvDisplay: "$30.00",
    },
    topItems: {
      mostSold: {
        metric: "sold_quantity",
        value: 1,
        items: [
          { sku: "SKU-A", item: malicious, style: "black", size: "L" },
          { sku: "SKU-B", item: "Tie tee", style: "blue", size: "M" },
        ],
      },
      mostProfitable: {
        metric: "gross_profit_cents",
        value: 900,
        items: [{ sku: "SKU-A", item: malicious, style: "black", size: "L" }],
      },
    },
    topProducts: {
      mostSold: {
        metric: "sold_quantity",
        value: 2,
        items: [{ item: "Tie tee", style: "black", skus: ["SKU-A", "SKU-B"] }],
      },
      mostProfitable: null,
    },
    itemPerformance: [
      {
        sku: "SKU-A",
        item: malicious,
        style: "black",
        size: "L",
        soldQuantity: 1,
        revenueCents: 1500,
        costOfGoodsCents: 600,
        grossProfitCents: 900,
      },
    ],
    completedSales: [
      {
        variationNumber: 12,
        mapped: true,
        sku: "SKU-A",
        item: malicious,
        style: "black",
        size: "L",
        soldPriceCents: 1500,
        unitCostCents: 600,
        grossProfitCents: 900,
        conflicts: [],
      },
      {
        variationNumber: 13,
        mapped: false,
        sku: null,
        item: null,
        style: null,
        size: null,
        soldPriceCents: 1000,
        unitCostCents: null,
        grossProfitCents: null,
        conflicts: [],
      },
    ],
    inventory: [
      {
        sku: "SKU-A",
        item: malicious,
        style: "black",
        size: "L",
        unitCostCents: 600,
        openingQuantity: 1,
        streamSoldQuantity: 1,
        baselineSoldQuantity: 2,
        pendingQuantity: 1,
        replacementQuantity: 0,
        oversoldQuantity: 2,
      },
    ],
    inventoryUpdateLines: ["SKU: SKU-A Updated count: 0"],
    sheetRows: [
      {
        sku: "SKU-A",
        item: malicious,
        style: "black",
        size: "L",
        quantity_on_hand_at_import: 0,
        unit_cost: "6.00",
      },
    ],
    warnings: [
      { code: "unmapped_completed_sales", count: 1, sku: null },
      { code: "inventory_recount_required", count: 2, sku: "SKU-A" },
    ],
    oauthToken: "secret-oauth-token",
    sourceSheetUrl: "https://docs.google.com/private-sheet",
    buyerName: "private-buyer",
  };

  return { ...base, ...overrides };
}

function allText(element) {
  return [
    element.textContent,
    ...element.children.map(allText),
  ].join(" ");
}

function createClient(options = {}) {
  return clientModule.createStreamReportClient({
    runtime: options.runtime,
    protocol,
    streamReport: options.streamReport ?? {
      hydrateStreamReport(report) {
        if (!report || report.reportId !== REPORT_ID) {
          throw new Error("invalid report");
        }
        return report;
      },
    },
    setTimeoutImpl: options.setTimeoutImpl ?? setTimeout,
    clearTimeoutImpl: options.clearTimeoutImpl ?? clearTimeout,
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
  });
}

test("packaged report surface is local, printable, and exposes the required actions", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const source = fs.readFileSync(path.join(directory, "report-page.js"), "utf8");

  assert.match(html, /Print \/ Save as PDF/);
  assert.match(html, /Copy Updated Inventory/);
  assert.match(html, /Download Updated Inventory CSV/);
  assert.match(html, /Copy SKU Counts/);
  assert.match(html, /duplicate the <strong>Inventory<\/strong> tab as a backup/);
  assert.match(html, /click cell <strong>A1<\/strong>/);
  assert.match(html, /Cmd\+V/);
  assert.match(html, /Ctrl\+V/);
  assert.match(
    html,
    /<script src="\.\.\/shared\/tiktok-fee-calculator\.js"><\/script>[\s\S]*?<script src="report-page\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(html, /report-state-badge|report-state-description/);
  assert.doesNotMatch(source, /\bFinal\b|\bProvisional\b/);
  assert.match(css, /@media print/);
  assert.match(css, /display:\s*table-header-group/);
  assert.match(css, /break-inside:\s*avoid/);
  assert.match(
    css,
    /\.summary-card-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;[\s\S]*?\.summary-card-row-value\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.doesNotMatch(
    css,
    /\.sku-count-list\s*\{[^}]*break-inside:\s*avoid/s,
  );
});

test("completed orders use one collapsed native disclosure that always prints in full", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const detailsTag = html.match(
    /<details\s+id="completed-sales-disclosure"[^>]*>/,
  )?.[0];
  const summary = html.match(
    /<summary[\s\S]*?id="completed-sales-toggle"[\s\S]*?<\/summary>/,
  )?.[0];
  const contentStart = html.indexOf('id="completed-sales-content"');
  const nextSection = html.indexOf('<section class="report-section"', contentStart);
  const content = html.slice(contentStart, nextSection);
  const printCss = css.slice(css.indexOf("@media print"));

  assert.ok(detailsTag);
  assert.doesNotMatch(detailsTag, /\sopen(?:\s|=|>)/);
  assert.ok(summary);
  assert.match(summary, /aria-controls="completed-sales-content"/);
  assert.match(summary, /<h2\s+id="sales-title"[^>]*>/);
  assert.equal((summary.match(/<h2\b/g) ?? []).length, 1);
  assert.match(summary, /id="sales-count"/);
  assert.equal((html.match(/id="completed-sales-content"/g) ?? []).length, 1);
  assert.equal((html.match(/id="completed-sales-rows"/g) ?? []).length, 1);
  assert.equal((html.match(/id="sales-empty"/g) ?? []).length, 1);
  assert.match(content, /class="data-table sales-table"/);
  assert.match(content, /aria-labelledby="sales-title"/);
  assert.match(content, /id="completed-sales-rows"/);
  assert.match(content, /id="sales-empty"/);
  assert.match(css, /\.completed-sales-toggle:focus-visible/);
  assert.match(
    printCss,
    /#completed-sales-disclosure:not\(\[open\]\)\s*>\s*#completed-sales-content\s*\{\s*display:\s*block\s*!important;/,
  );
  assert.match(
    printCss,
    /#completed-sales-toggle::after\s*\{\s*display:\s*none\s*!important;/,
  );
  assert.doesNotMatch(
    printCss,
    /#completed-sales-toggle\s*\{[^}]*display:\s*none/s,
  );
});

test("completed orders open for printing and restore their prior disclosure state", () => {
  const document = new FakeDocument();
  const disclosure = document.querySelector("#completed-sales-disclosure");
  const controller = reportPage.createPrintDisclosureController(document);

  disclosure.open = false;
  controller.prepare();
  assert.equal(disclosure.open, true);
  controller.prepare();
  controller.restore();
  assert.equal(disclosure.open, false);

  disclosure.open = true;
  controller.prepare();
  controller.restore();
  assert.equal(disclosure.open, true);
});

test("report rendering preserves text, renders SKU and product ties, and never creates markup from values", () => {
  const document = new FakeDocument();
  const report = createReport();

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  assert.equal(document.querySelector("#most-sold-items").children.length, 2);
  assert.equal(document.querySelector("#most-sold-products").children.length, 1);
  assert.equal(document.querySelector("#most-sold-products-card").hidden, false);
  assert.equal(document.querySelector("#most-profitable-products-card").hidden, true);
  assert.equal(document.querySelector("#completed-sales-rows").children.length, 2);
  assert.equal(document.querySelector("#performance-rows").children.length, 1);
  assert.equal(document.querySelector("#inventory-rows").children.length, 1);
  assert.equal(document.querySelector("#summary-grid").children.length, 10);
  assert.match(
    allText(document.querySelector("#summary-grid")),
    /TikTok 6% Fees[\s\S]*Fees paid:[\s\S]*≈\$2[\s\S]*GMV after fees:[\s\S]*≈\$28/,
  );
  assert.equal(document.createdTags.includes("img"), false);
  assert.match(
    allText(document.querySelector("#completed-sales-rows")),
    /<img src=x onerror="stealOAuthToken\(\)">/,
  );
  assert.equal(document.querySelector("#sku-count-list").textContent, "SKU: SKU-A Updated count: 0");
});

test("post-stream AOV uses Gross Item Sales divided by completed sales", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 3,
      totalSalesCount: 8,
      completedGmvCents: 1000,
      grossProfitCents: 400,
      unmappedCompletedCount: 0,
      canceledOrderCount: 4,
      paymentFixingCount: 1,
      attributedGmvDisplay: "$12.00",
    },
  }));
  const aov = metrics.find((metric) => metric.label === "AOV");
  const grossItemSales = metrics.find(
    (metric) => metric.label === "Gross Item Sales",
  );

  assert.deepEqual(aov, {
    label: "AOV",
    value: "$3.33",
    note: "Completed-sale average; shipping excluded",
  });
  assert.deepEqual(grossItemSales, {
    label: "Gross Item Sales",
    value: "$10.00",
    note: "Captured completed-order prices",
  });
  assert.equal(
    reportPage.DEFAULT_DEFINITIONS.find(
      (definition) => definition.term === "Gross Item Sales",
    )?.description,
    "The sum of captured sold prices for orders marked Payment complete. Buyer-paid shipping is not included.",
  );
});

test("post-stream AOV displays zero when there are no completed sales", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 0,
      totalSalesCount: 5,
      completedGmvCents: 0,
      grossProfitCents: 0,
      unmappedCompletedCount: 0,
      canceledOrderCount: 4,
      paymentFixingCount: 1,
      attributedGmvDisplay: "$0.00",
    },
  }));
  const aov = metrics.find((metric) => metric.label === "AOV");

  assert.equal(aov.value, "$0.00");
});

test("post-stream TikTok fee card rounds both compact-GMV values to approximate whole dollars", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 2,
      totalSalesCount: 3,
      completedGmvCents: 2500,
      grossProfitCents: 900,
      unmappedCompletedCount: 1,
      canceledOrderCount: 1,
      paymentFixingCount: 0,
      attributedGmvDisplay: "$6.83K",
    },
  }));

  assert.deepEqual(
    metrics.find((metric) => metric.label === "TikTok 6% Fees"),
    {
      label: "TikTok 6% Fees",
      rows: [
        { label: "Fees paid:", value: "≈$410" },
        { label: "GMV after fees:", value: "≈$6,420" },
      ],
      note: "Approximate values calculated from Total GMV",
    },
  );
  assert.equal(
    reportPage.DEFAULT_DEFINITIONS.find(
      (definition) => definition.term === "TikTok 6% Fees",
    )?.description,
    "Approximate fees paid and GMV after fees, calculated from TikTok Attributed GMV at 6% and rounded to the nearest whole dollar.",
  );
});

test("post-stream TikTok fee card displays em dashes when Total GMV was not captured", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 0,
      totalSalesCount: 0,
      completedGmvCents: 0,
      grossProfitCents: 0,
      unmappedCompletedCount: 0,
      canceledOrderCount: 0,
      paymentFixingCount: 0,
      attributedGmvDisplay: null,
    },
  }));
  const feeCard = metrics.find((metric) => metric.label === "TikTok 6% Fees");

  assert.deepEqual(feeCard.rows, [
    { label: "Fees paid:", value: "—" },
    { label: "GMV after fees:", value: "—" },
  ]);
});

test("inventory payloads use the exact six columns, retain zero, and omit unrelated secrets", () => {
  const report = createReport();
  const tsv = reportPage.serializeInventoryTsv(report);
  const csv = reportPage.serializeInventoryCsv(report);
  const counts = reportPage.buildSkuCountText(report);
  const expectedHeader =
    "sku\titem\tstyle\tsize\tquantity_on_hand_at_import\tunit_cost";

  assert.equal(tsv.split("\n")[0], expectedHeader);
  assert.match(tsv, /SKU-A[^\n]*\t0\t6\.00/);
  assert.match(csv, /quantity_on_hand_at_import/);
  assert.equal(counts, "SKU: SKU-A Updated count: 0");

  for (const secret of [
    report.oauthToken,
    report.sourceSheetUrl,
    report.buyerName,
  ]) {
    assert.equal(tsv.includes(secret), false);
    assert.equal(csv.includes(secret), false);
    assert.equal(counts.includes(secret), false);
  }
});

test("long inventory renders every row and keeps the simple count list complete", () => {
  const inventory = Array.from({ length: 1000 }, (_, index) => ({
    sku: `SKU-${String(index).padStart(4, "0")}`,
    item: "Long inventory item",
    style: "style",
    size: "OS",
    unitCostCents: 100,
    openingQuantity: 2,
    streamSoldQuantity: 0,
    baselineSoldQuantity: 0,
    pendingQuantity: 0,
    replacementQuantity: 2,
    oversoldQuantity: 0,
  }));
  const document = new FakeDocument();
  const report = createReport({
    inventory,
    inventoryUpdateLines: inventory.map(
      ({ sku }) => `SKU: ${sku} Updated count: 2`,
    ),
    sheetRows: inventory.map((entry) => ({
      sku: entry.sku,
      item: entry.item,
      style: entry.style,
      size: entry.size,
      quantity_on_hand_at_import: 2,
      unit_cost: "1.00",
    })),
  });

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  assert.equal(document.querySelector("#inventory-rows").children.length, 1000);
  assert.equal(
    document.querySelector("#sku-count-list").textContent.split("\n").length,
    1000,
  );
});

test("CSV download uses a local Blob URL, stable filename, and revokes the URL", () => {
  const document = new FakeDocument();
  let blobParts = null;
  let revoked = null;
  class FakeBlob {
    constructor(parts, options) {
      blobParts = parts;
      this.type = options.type;
    }
  }
  const filename = reportPage.downloadCsv(
    document,
    {
      Blob: FakeBlob,
      URL: {
        createObjectURL() {
          return "blob:local-report";
        },
        revokeObjectURL(value) {
          revoked = value;
        },
      },
      setTimeout(callback) {
        callback();
      },
    },
    createReport(),
    "sku,item\r\nSKU-A,Example\r\n",
  );

  assert.match(filename, /^TikTok-LIVE-Updated-Inventory_/);
  assert.deepEqual(blobParts, ["sku,item\r\nSKU-A,Example\r\n"]);
  assert.equal(revoked, "blob:local-report");
});

test("stream report client strictly parses list and hydrates an exact GET response", async () => {
  const sent = [];
  const report = createReport();
  const client = createClient({
    runtime: {
      async sendMessage(message) {
        sent.push(message);
        if (message.command.type === protocol.COMMAND_TYPES.LIST_REPORTS) {
          return {
            ok: true,
            data: {
              reports: [
                {
                  reportId: REPORT_ID,
                  startedAt: STARTED_AT,
                  endedAt: ENDED_AT,
                  completeness: "provisional",
                  completedPaymentCount: 2,
                  totalSalesCount: 3,
                  completedGmvCents: 2500,
                  attributedGmvDisplay: "$30.00",
                },
              ],
            },
          };
        }
        return {
          ok: true,
          data: {
            reportId: REPORT_ID,
            lifecycleStatus: "finalized",
            report,
          },
        };
      },
    },
  });

  const listing = await client.listReports();
  const record = await client.getReport({ reportId: REPORT_ID });

  assert.equal(listing.reports[0].reportId, REPORT_ID);
  assert.deepEqual(record.report, report);
  assert.equal(sent[0].channel, protocol.MESSAGE_CHANNEL);
  assert.equal(sent[0].version, protocol.MESSAGE_VERSION);
  assert.deepEqual(sent[1].command, {
    type: protocol.COMMAND_TYPES.GET_REPORT,
    reportId: REPORT_ID,
  });
});

test("stream report client lists archived reports and strictly echoes archive mutations", async () => {
  const sentCommands = [];
  const summary = {
    reportId: REPORT_ID,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    completeness: "provisional",
    completedPaymentCount: 2,
    totalSalesCount: 3,
    completedGmvCents: 2500,
    attributedGmvDisplay: "$30.00",
  };
  const client = createClient({
    runtime: {
      async sendMessage(message) {
        sentCommands.push(message.command);

        if (
          message.command.type ===
          protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS
        ) {
          return { ok: true, data: { reports: [summary] } };
        }

        return {
          ok: true,
          data: { reportIds: [...message.command.reportIds] },
        };
      },
    },
  });

  assert.deepEqual(await client.listArchivedReports(), { reports: [summary] });
  assert.deepEqual(
    await client.archiveReports({ reportIds: [REPORT_ID] }),
    { reportIds: [REPORT_ID] },
  );
  assert.deepEqual(
    await client.restoreReports({ reportIds: [REPORT_ID, SECOND_REPORT_ID] }),
    { reportIds: [REPORT_ID, SECOND_REPORT_ID] },
  );
  assert.deepEqual(
    await client.deleteArchivedReports({ reportIds: [SECOND_REPORT_ID] }),
    { reportIds: [SECOND_REPORT_ID] },
  );
  assert.deepEqual(sentCommands, [
    { type: protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS },
    { type: protocol.COMMAND_TYPES.ARCHIVE_REPORTS, reportIds: [REPORT_ID] },
    {
      type: protocol.COMMAND_TYPES.RESTORE_REPORTS,
      reportIds: [REPORT_ID, SECOND_REPORT_ID],
    },
    {
      type: protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
      reportIds: [SECOND_REPORT_ID],
    },
  ]);
});

test("stream report client rejects invalid mutation requests and altered mutation results", async () => {
  let deliveryCount = 0;
  const invalidRequestClient = createClient({
    runtime: {
      async sendMessage() {
        deliveryCount += 1;
        return { ok: true, data: { reportIds: [] } };
      },
    },
  });

  await assert.rejects(
    invalidRequestClient.archiveReports({ reportIds: [] }),
    (error) => error.code === "INVALID_CLIENT_COMMAND",
  );
  await assert.rejects(
    invalidRequestClient.restoreReports({ reportIds: [REPORT_ID, REPORT_ID] }),
    (error) => error.code === "INVALID_CLIENT_COMMAND",
  );
  await assert.rejects(
    invalidRequestClient.deleteArchivedReports({ reportIds: ["not-a-report"] }),
    (error) => error.code === "INVALID_CLIENT_COMMAND",
  );
  assert.equal(deliveryCount, 0);

  const alteredResponseClient = createClient({
    runtime: {
      async sendMessage() {
        return { ok: true, data: { reportIds: [SECOND_REPORT_ID] } };
      },
    },
  });
  await assert.rejects(
    alteredResponseClient.archiveReports({ reportIds: [REPORT_ID] }),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("stream report client enforces separate dashboard and archived list limits", async () => {
  function createSummary(index) {
    return {
      reportId: `stream-report:${String(index + 1).padStart(8, "0")}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      startedAt: STARTED_AT,
      endedAt: new Date(Date.parse(ENDED_AT) - index * 1000).toISOString(),
      completeness: "provisional",
      completedPaymentCount: 0,
      totalSalesCount: 0,
      completedGmvCents: 0,
      attributedGmvDisplay: null,
    };
  }

  const client = createClient({
    runtime: {
      async sendMessage(message) {
        const listLimit =
          message.command.type === protocol.COMMAND_TYPES.LIST_REPORTS
            ? protocol.MAX_ACTIVE_REPORTS
            : protocol.MAX_ARCHIVED_REPORTS;

        return {
          ok: true,
          data: {
            reports: Array.from(
              { length: listLimit + 1 },
              (_value, index) => createSummary(index),
            ),
          },
        };
      },
    },
  });

  await assert.rejects(
    client.listReports(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  await assert.rejects(
    client.listArchivedReports(),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("stream report client rejects malformed summaries and mismatched records", async () => {
  const malformedList = createClient({
    runtime: {
      async sendMessage() {
        return { ok: true, data: { reports: [{ reportId: REPORT_ID }] } };
      },
    },
  });
  await assert.rejects(
    malformedList.listReports(),
    (error) => error.code === "INVALID_RESPONSE",
  );

  const mismatchedGet = createClient({
    runtime: {
      async sendMessage() {
        return {
          ok: true,
          data: {
            reportId: "stream-report:22222222-2222-4222-8222-222222222222",
            lifecycleStatus: "finalized",
            report: createReport(),
          },
        };
      },
    },
  });
  await assert.rejects(
    mismatchedGet.getReport({ reportId: REPORT_ID }),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("stream report client times out a receiver that never settles and clears its timer", async () => {
  let timeoutCallback = null;
  let clearedId = null;
  const client = createClient({
    runtime: {
      sendMessage() {
        return new Promise(() => {});
      },
    },
    setTimeoutImpl(callback, milliseconds) {
      assert.equal(milliseconds, 10);
      timeoutCallback = callback;
      return 73;
    },
    clearTimeoutImpl(identifier) {
      clearedId = identifier;
    },
    requestTimeoutMs: 10,
  });
  const request = client.listReports();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof timeoutCallback, "function");
  timeoutCallback();

  await assert.rejects(
    request,
    (error) =>
      error.code === "REPORT_REQUEST_TIMEOUT" &&
      /Reload the extension/.test(error.message),
  );
  assert.equal(clearedId, 73);
});

test("stream report client clears its receiver timeout after a successful response", async () => {
  let clearedId = null;
  const client = createClient({
    runtime: {
      async sendMessage() {
        return { ok: true, data: { reports: [] } };
      },
    },
    setTimeoutImpl() {
      return 91;
    },
    clearTimeoutImpl(identifier) {
      clearedId = identifier;
    },
  });

  assert.deepEqual(await client.listReports(), { reports: [] });
  assert.equal(clearedId, 91);
});
