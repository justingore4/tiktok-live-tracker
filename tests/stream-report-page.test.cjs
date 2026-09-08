const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");
const clientModule = require("../extension/report/stream-report-client.js");
const inlineCorrection = require(
  "../extension/report/inline-report-correction.js",
);
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
    this.open = false;
    this.value = "";
    this.title = "";
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

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  dispatch(name, event = {}) {
    const listener = this.listeners.get(name);

    if (!listener) {
      return Promise.resolve();
    }

    return Promise.resolve(listener({
      currentTarget: this,
      target: this,
      ...event,
    }));
  }

  focus() {}

  click() {
    this.clicked = true;
    return this.dispatch("click");
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
  "#download-inventory",
  "#inventory-rows",
  "#mapping-correction-availability",
  "#mapping-correction-disclosure",
  "#mapping-correction-feedback",
  "#mapping-correction-fields",
  "#mapping-correction-section",
  "#mapping-item-group",
  "#mapping-original",
  "#mapping-selected",
  "#mapping-sku",
  "#mapping-sku-field",
  "#mapping-sold-price",
  "#mapping-variation",
  "#mapping-variation-status",
  "#most-profitable-items",
  "#most-profitable-products",
  "#most-profitable-products-card",
  "#most-sold-items",
  "#most-sold-products",
  "#most-sold-products-card",
  "#performance-empty",
  "#performance-row-count",
  "#performance-rows",
  "#payment-resolution-count",
  "#payment-resolution-feedback",
  "#payment-resolution-orders",
  "#payment-resolution-section",
  "#print-report",
  "#report-content",
  "#report-error",
  "#report-error-message",
  "#report-generated-at",
  "#report-name",
  "#report-name-feedback",
  "#report-name-help",
  "#report-name-input",
  "#report-loading",
  "#report-warnings",
  "#retry-report",
  "#reset-mapping-original",
  "#save-mapping-correction",
  "#sales-count",
  "#sales-empty",
  "#variation-details-note",
  "#stream-ended",
  "#stream-reference",
  "#stream-started",
  "#summary-grid",
  "#unit-cost-correction-disclosure",
  "#unit-cost-correction-section",
  "#unit-cost-feedback",
  "#unit-cost-preview",
  "#unit-cost-sku",
  "#unit-cost-value",
  "#update-unit-cost",
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createCorrectionLoadRecorder(loads) {
  return {
    createInlineReportCorrectionController() {
      return {
        load(reportId, options = {}) {
          loads.push({ reportId, options: { ...options } });
        },
        getState() {
          return { busy: false };
        },
      };
    },
  };
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
      committedSalesCount: 1,
      totalSalesCount: 3,
      completedGmvCents: 2500,
      costOfGoodsCents: 600,
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
    canceledOrders: [
      {
        variationNumber: 14,
        mapped: true,
        sku: "SKU-A",
        item: malicious,
        style: "black",
        size: "L",
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

function mountReportNameEditor(options = {}) {
  const document = options.document ?? new FakeDocument();
  const location = options.location ?? {
    search: `?reportId=${encodeURIComponent(REPORT_ID)}`,
  };
  const renameRequests = [];
  let savedName = options.displayName ?? null;
  const client = {
    getReport: options.getReport ?? (async ({ reportId }) => ({
      reportId,
      lifecycleStatus: options.lifecycleStatus ?? "finalized",
      displayName: savedName,
      report: options.report ?? createReport({ reportId }),
    })),
    async renameReport(input) {
      renameRequests.push({ ...input });
      if (options.renameReport) {
        return options.renameReport(input);
      }
      savedName = input.displayName;
      return { reportId: input.reportId, displayName: input.displayName };
    },
    ...options.client,
  };
  if (options.canRename === false) {
    delete client.renameReport;
  }
  const mounted = reportPage.mountStreamReportPage({
    document,
    location,
    navigator: options.navigator ?? {},
    runtime: {},
    protocol,
    reportModule: { hydrateStreamReport: (report) => report },
    clientModule: { createStreamReportClient: () => client },
    inlineCorrectionModule: options.inlineCorrectionModule,
    print: options.print ?? (() => {}),
  });

  return {
    document,
    location,
    mounted,
    renameRequests,
    input: document.querySelector("#report-name-input"),
    feedback: document.querySelector("#report-name-feedback"),
    printName: document.querySelector("#report-name"),
    ready: new Promise((resolve) => setImmediate(resolve)),
  };
}

test("packaged report surface is local, printable, and exposes the required actions", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const source = fs.readFileSync(path.join(directory, "report-page.js"), "utf8");

  assert.match(html, /Print \/ Save as PDF/);
  assert.doesNotMatch(html, /Edit in Offline Tracker/);
  assert.doesNotMatch(html, /offline-editor-(?:page|action)/i);
  assert.doesNotMatch(source, /offline-editor-(?:page|action)|edit-offline-report/i);
  assert.doesNotMatch(css, /report-offline-editor-action/);
  assert.equal(fs.existsSync(path.join(directory, "offline-editor.html")), false);
  assert.equal(fs.existsSync(path.join(directory, "offline-editor.css")), false);
  assert.equal(
    fs.existsSync(path.join(directory, "offline-editor-page.js")),
    false,
  );
  assert.match(html, /Copy Updated Inventory/);
  assert.match(html, /Download Updated Inventory CSV/);
  assert.match(html, /Finish unresolved payments/);
  assert.match(html, /Correct SKU Unit Cost/);
  assert.doesNotMatch(
    html,
    /canceled-orders-disclosure|Canceled order references/,
  );
  assert.doesNotMatch(source, /renderCanceledOrders|#canceled-orders-/);
  assert.doesNotMatch(css, /\.canceled-orders-/);
  assert.match(
    html,
    /Correct a cost in this saved report[\s\S]*live tracker, other reports, and future streams are unaffected/,
  );
  assert.match(
    html,
    /id="payment-resolution-section"[\s\S]*?class="report-section payment-resolution-section screen-only"/,
  );
  assert.match(html, /id="payment-resolution-feedback"[\s\S]*?aria-live="polite"/);
  assert.match(
    html,
    /id="unit-cost-correction-section"[\s\S]*?class="report-section unit-cost-correction-section screen-only"/,
  );
  assert.match(html, /id="unit-cost-feedback"[\s\S]*?aria-live="polite"/);
  assert.doesNotMatch(html, /Copy SKU Counts/);
  assert.doesNotMatch(html, /Simple replacement list/i);
  assert.doesNotMatch(html, /SKU updated counts/i);
  assert.doesNotMatch(html, /id="(?:copy-sku-counts|sku-count-list)"/);
  assert.match(
    html,
    new RegExp([
      '<script src="\\.\\.\\/shared\\/tiktok-fee-calculator\\.js">',
      '<\\/script>[\\s\\S]*?',
      '<script src="stream-report-client\\.js"><\\/script>[\\s\\S]*?',
      '<script src="offline-report-editor-client\\.js">',
      '<\\/script>[\\s\\S]*?',
      '<script src="inline-report-correction\\.js"><\\/script>',
      '[\\s\\S]*?<script src="report-page\\.js"><\\/script>',
    ].join("")),
  );
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(html, /id="report-content"[^>]*tabindex="-1"/);
  assert.match(source, /querySelector\("#report-content"\)\.focus\(\)/);
  assert.match(
    css,
    /\.report-content:focus\s*\{\s*outline:\s*none;\s*\}/,
  );
  assert.match(source, /clearTimeout:\s*root\.clearTimeout\.bind\(root\)/);
  assert.match(source, /const ACTION_FEEDBACK_DURATION_MS = 4_000;/);
  assert.doesNotMatch(html, /report-state-badge|report-state-description/);
  assert.doesNotMatch(source, /\bFinal\b|\bProvisional\b/);
  assert.match(css, /@media print/);
  assert.match(css, /display:\s*table-header-group/);
  assert.match(css, /break-inside:\s*avoid/);
  assert.match(
    css,
    /\.summary-card-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;[\s\S]*?\.summary-card-row-value\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(
    css,
    /\.summary-grid dd\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(css, /\.summary-grid > \.summary-card-warning\s*\{/);
  assert.match(css, /\.summary-grid \.summary-card-warning-note\s*\{/);
  assert.match(
    css,
    /@media print[\s\S]*?\.summary-grid \.summary-card-warning-note\s*\{[\s\S]*?color:\s*#704900;/,
  );
  assert.doesNotMatch(css, /\.sku-count-list\b/);
  assert.match(css, /\.payment-resolution-order\s*\{/);
  assert.match(css, /\.unit-cost-correction-form\s*\{/);
  assert.doesNotMatch(css, /\.unit-cost-correction-section\s*\{[^}]*border-color:/);
});

test("compact Post Stream Report cover contains all stream metadata", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const coverStart = html.indexOf('<header class="report-cover report-block">');
  const coverEnd = html.indexOf("</header>", coverStart);
  const cover = html.slice(coverStart, coverEnd);
  const printCss = css.slice(css.indexOf("@media print"));

  assert.ok(coverStart >= 0);
  assert.match(html, /<title>Post Stream Report<\/title>/);
  assert.match(
    cover,
    /<div class="report-cover-title-row">[\s\S]*?<h1 id="report-title">Post Stream Report<\/h1>[\s\S]*?id="print-report"[\s\S]*?Print \/ Save as PDF[\s\S]*?<\/div>/,
  );
  assert.match(
    cover,
    /id="print-report"[\s\S]*?class="primary-action report-print-action screen-only"[\s\S]*?type="button"[\s\S]*?disabled/,
  );
  assert.equal((html.match(/id="print-report"/g) ?? []).length, 1);
  assert.doesNotMatch(cover, /Edit in Offline Tracker|offline-editor/i);
  assert.match(
    cover,
    /<dl class="report-meta"[\s\S]*?id="stream-started"[\s\S]*?id="stream-ended"[\s\S]*?<dt>\s*<label for="report-name-input">Report name<\/label>\s*<\/dt>[\s\S]*?id="report-name"[\s\S]*?<\/dl>/,
  );
  assert.match(
    html,
    /<footer class="report-footer">[\s\S]*?<p id="stream-reference">Stream reference: Unavailable<\/p>[\s\S]*?id="report-generated-at"[\s\S]*?<\/footer>/,
  );
  assert.equal((html.match(/class="report-meta"/g) ?? []).length, 1);
  assert.doesNotMatch(
    html,
    /class="app-header"|class="brand-mark"|class="brand-copy"|Seller tool|TikTok LIVE Stream Report|End-of-stream business summary|Locally prepared from captured sales and confirmed inventory mappings|report-subtitle/,
  );
  assert.doesNotMatch(css, /\.app-header\b|\.brand-mark\b|\.brand-copy\b|\.product-name\b|\.header-actions\b/);
  assert.match(
    css,
    /\.report-cover\s*\{[\s\S]*?gap:\s*16px;[\s\S]*?padding:\s*clamp\(18px, 3vw, 28px\);/,
  );
  assert.match(
    css,
    /\.report-cover h1\s*\{[\s\S]*?font-size:\s*clamp\(25px, 3\.5vw, 36px\);/,
  );
  assert.match(
    css,
    /\.report-cover-title-row\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*space-between;/,
  );
  assert.match(
    css,
    /\.report-print-action\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?margin-left:\s*auto;/,
  );
  assert.match(
    printCss,
    /\.screen-only,[\s\S]*?\.action-feedback\s*\{[\s\S]*?display:\s*none !important;/,
  );
  assert.match(
    printCss,
    /\.report-cover\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?padding:\s*0\.18in;[\s\S]*?\.report-cover h1\s*\{[\s\S]*?font-size:\s*20pt;/,
  );
});

test("report name replaces the header reference while the footer and filename retain stream identity", () => {
  const report = createReport();
  const expectedDocumentTitle = reportPage
    .createReportFilename(report, "Stream-Report", "pdf")
    .replace(/\.pdf$/i, "");
  const customDocument = new FakeDocument();

  reportPage.renderReport(customDocument, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    displayName: "Sunday evening stream",
    report,
  });

  assert.equal(
    customDocument.querySelector("#report-name").textContent,
    "Sunday evening stream",
  );
  assert.equal(
    customDocument.querySelector("#stream-reference").textContent,
    `Stream reference: ${report.metadata.streamId}`,
  );
  assert.equal(customDocument.title, expectedDocumentTitle);

  const defaultDocument = new FakeDocument();
  reportPage.renderReport(defaultDocument, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    displayName: null,
    report,
  });

  assert.equal(
    defaultDocument.querySelector("#report-name").textContent,
    reportPage.formatTimestamp(report.metadata.endedAt),
  );
  assert.equal(defaultDocument.title, expectedDocumentTitle);
});

test("report name editor is labeled and screen-only while the saved name prints", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const printIndex = css.indexOf("@media print");
  const screenCss = css.slice(0, printIndex);
  const printCss = css.slice(printIndex);

  assert.match(html, /<label for="report-name-input">Report name<\/label>/);
  assert.match(html, /class="[^"]*report-name-editor[^"]*screen-only[^"]*"/);
  assert.match(
    html,
    /<input\b(?=[^>]*id="report-name-input")(?=[^>]*type="text")(?=[^>]*maxlength="80")(?=[^>]*aria-describedby="[^"]*report-name-help[^"]*")(?=[^>]*disabled)[^>]*>/,
  );
  assert.match(
    html,
    /<[^>]+(?=[^>]*id="report-name-help")(?=[^>]*class="[^"]*visually-hidden[^"]*")[^>]*>/,
  );
  assert.match(
    html,
    /class="report-name-editor screen-only"[\s\S]*?<span\b(?=[^>]*id="report-name-feedback")(?=[^>]*role="status")[^>]*>[\s\S]*?<\/span>\s*<\/span>/,
  );
  assert.match(
    html,
    /<span\b(?=[^>]*id="report-name")(?=[^>]*class="[^"]*report-name-print[^"]*")[^>]*>/,
  );
  assert.match(screenCss, /\.report-name-print\s*\{[^}]*display:\s*none;/);
  assert.match(printCss, /\.report-name-print\s*\{[^}]*display:\s*(?:block|inline);/);
  assert.match(printCss, /\.screen-only,[\s\S]*?display:\s*none !important;/);
});

test("report name input waits for loading and displays the custom or default saved name", async (t) => {
  for (const displayName of [null, "Sunday evening stream"]) {
    await t.test(displayName ?? "default name", async () => {
      const pendingReport = createDeferred();
      const report = createReport();
      const surface = mountReportNameEditor({
        getReport: () => pendingReport.promise,
      });
      assert.equal(surface.input.disabled, true);

      pendingReport.resolve({
        reportId: REPORT_ID,
        lifecycleStatus: "finalized",
        displayName,
        report,
      });
      await surface.ready;

      const expected = displayName ?? reportPage.formatTimestamp(ENDED_AT);
      assert.equal(surface.input.value, expected);
      assert.equal(surface.printName.textContent, expected);
      assert.equal(surface.input.disabled, false);
      assert.deepEqual(surface.renameRequests, []);
    });
  }
});

test("Enter saves a trimmed report name once and keeps drafts out of print and report metrics", async () => {
  const save = createDeferred();
  const printedNames = [];
  const surface = mountReportNameEditor({
    displayName: "Previously saved name",
    renameReport: () => save.promise,
    print: () => printedNames.push(surface.printName.textContent),
  });
  await surface.ready;
  const unchangedSelectors = [
    "#summary-grid",
    "#completed-sales-rows",
    "#performance-rows",
    "#inventory-rows",
    "#stream-started",
    "#stream-ended",
    "#stream-reference",
    "#report-generated-at",
  ];
  const originalText = unchangedSelectors.map((selector) =>
    allText(surface.document.querySelector(selector)));
  const originalTitle = surface.document.title;
  let prevented = false;
  surface.input.value = "  Friday night sale  ";
  await surface.input.dispatch("input");
  assert.equal(surface.printName.textContent, "Previously saved name");
  const submitted = surface.input.dispatch("keydown", {
    key: "Enter",
    preventDefault() { prevented = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(surface.input.disabled, true);
  assert.equal(surface.printName.textContent, "Previously saved name");
  assert.match(surface.feedback.textContent, /saving/i);
  const duplicateBlur = surface.input.dispatch("blur");
  await surface.input.dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(surface.renameRequests, [{
    reportId: REPORT_ID,
    displayName: "Friday night sale",
  }]);

  save.resolve({ reportId: REPORT_ID, displayName: "Friday night sale" });
  await Promise.all([submitted, duplicateBlur]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surface.input.value, "Friday night sale");
  assert.equal(surface.printName.textContent, "Friday night sale");
  assert.equal(surface.input.disabled, false);
  assert.match(surface.feedback.textContent, /saved/i);
  await surface.document.querySelector("#print-report").click();
  assert.deepEqual(printedNames, ["Friday night sale"]);
  assert.deepEqual(
    unchangedSelectors.map((selector) => allText(surface.document.querySelector(selector))),
    originalText,
  );
  assert.equal(surface.document.title, originalTitle);
});

test("Print waits for an in-flight blur rename and prints the saved name without a second request", async () => {
  const save = createDeferred();
  const printedNames = [];
  const surface = mountReportNameEditor({
    displayName: "Original name",
    renameReport: () => save.promise,
    print: () => printedNames.push(surface.printName.textContent),
  });
  await surface.ready;
  surface.input.value = "Name to print";
  await surface.input.dispatch("input");
  const pendingSave = surface.input.dispatch("blur");
  const pendingPrint = surface.document.querySelector("#print-report").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(printedNames, []);
  assert.equal(surface.printName.textContent, "Original name");
  assert.deepEqual(surface.renameRequests, [{
    reportId: REPORT_ID,
    displayName: "Name to print",
  }]);

  save.resolve({ reportId: REPORT_ID, displayName: "Name to print" });
  await Promise.all([pendingSave, pendingPrint]);
  assert.deepEqual(printedNames, ["Name to print"]);
  assert.equal(surface.input.value, "Name to print");
  assert.equal(surface.input.disabled, false);
  assert.equal(surface.renameRequests.length, 1);
});

test("Print saves a dirty report name before opening the print dialog", async () => {
  const printedNames = [];
  const surface = mountReportNameEditor({
    displayName: "Original name",
    print: () => printedNames.push(surface.printName.textContent),
  });
  await surface.ready;
  surface.input.value = "  New PDF report name  ";
  await surface.input.dispatch("input");
  await surface.document.querySelector("#print-report").click();
  assert.deepEqual(surface.renameRequests, [{
    reportId: REPORT_ID,
    displayName: "New PDF report name",
  }]);
  assert.deepEqual(printedNames, ["New PDF report name"]);
});

test("Print does not open when the report name cannot be validated or saved", async (t) => {
  for (const failure of ["validation", "storage"]) {
    await t.test(failure, async () => {
      const printedNames = [];
      const surface = mountReportNameEditor({
        displayName: "Original name",
        async renameReport() {
          throw new Error("The report name could not be saved. Try again.");
        },
        print: () => printedNames.push(surface.printName.textContent),
      });
      await surface.ready;
      const draft = failure === "validation" ? "x".repeat(81) : "Unsaved PDF name";
      surface.input.value = draft;
      await surface.input.dispatch("input");
      await surface.document.querySelector("#print-report").click();
      assert.deepEqual(printedNames, []);
      assert.equal(surface.renameRequests.length, failure === "validation" ? 0 : 1);
      assert.equal(surface.input.value, draft);
      assert.equal(surface.printName.textContent, "Original name");
      assert.equal(surface.input.disabled, false);
      assert.match(surface.feedback.className, /is-error/);
    });
  }
});

test("Print waiting for a report rename never prints a different report after navigation", async () => {
  const save = createDeferred();
  const printedNames = [];
  const surface = mountReportNameEditor({
    async getReport({ reportId }) {
      return {
        reportId,
        lifecycleStatus: "finalized",
        displayName: reportId === REPORT_ID ? "Original name" : "Second report name",
        report: createReport({ reportId }),
      };
    },
    renameReport: () => save.promise,
    print: () => printedNames.push(surface.printName.textContent),
  });
  await surface.ready;
  surface.input.value = "First report draft";
  await surface.input.dispatch("input");
  const pendingSave = surface.input.dispatch("blur");
  const pendingPrint = surface.document.querySelector("#print-report").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(printedNames, []);
  surface.location.search = `?reportId=${encodeURIComponent(SECOND_REPORT_ID)}`;
  await surface.mounted.load();
  save.resolve({ reportId: REPORT_ID, displayName: "First report draft" });
  await Promise.all([pendingSave, pendingPrint]);
  assert.deepEqual(printedNames, []);
  assert.equal(surface.input.value, "Second report name");
  assert.equal(surface.printName.textContent, "Second report name");

  await surface.document.querySelector("#print-report").click();
  assert.deepEqual(printedNames, ["Second report name"]);
});

test("blur persists a report name and clearing it restores the default date", async () => {
  const surface = mountReportNameEditor({ displayName: "Original name" });
  await surface.ready;
  surface.input.value = "  Updated on blur  ";
  await surface.input.dispatch("input");
  await surface.input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surface.input.value, "Updated on blur");
  assert.equal(surface.printName.textContent, "Updated on blur");

  surface.input.value = "   ";
  await surface.input.dispatch("input");
  await surface.input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(surface.renameRequests, [
    { reportId: REPORT_ID, displayName: "Updated on blur" },
    { reportId: REPORT_ID, displayName: null },
  ]);
  assert.equal(surface.input.value, reportPage.formatTimestamp(ENDED_AT));
  assert.equal(surface.printName.textContent, reportPage.formatTimestamp(ENDED_AT));
  await surface.mounted.load();
  assert.equal(surface.input.value, reportPage.formatTimestamp(ENDED_AT));
});

test("unchanged report names and Escape do not send rename requests", async (t) => {
  for (const displayName of [null, "Saved custom name"]) {
    await t.test(displayName ?? "default name", async () => {
      const surface = mountReportNameEditor({ displayName });
      await surface.ready;
      const expected = surface.input.value;
      await surface.input.dispatch("blur");
      await surface.input.dispatch("keydown", { key: "Enter", preventDefault() {} });
      surface.input.value = `  ${expected}  `;
      await surface.input.dispatch("input");
      await surface.input.dispatch("blur");
      assert.equal(surface.input.value, expected);

      surface.input.value = "Unsaved draft";
      await surface.input.dispatch("input");
      let prevented = false;
      await surface.input.dispatch("keydown", {
        key: "Escape",
        preventDefault() { prevented = true; },
      });
      await surface.input.dispatch("blur");
      assert.equal(prevented, true);
      assert.equal(surface.input.value, expected);
      assert.equal(surface.printName.textContent, expected);
      assert.deepEqual(surface.renameRequests, []);
    });
  }
});

test("report name validation rejects long names and control characters without losing the draft", async (t) => {
  for (const draft of ["x".repeat(81), "line\nbreak", "embedded\u0000control", "delete\u007fcontrol"]) {
    await t.test(JSON.stringify(draft), async () => {
      const surface = mountReportNameEditor({ displayName: "Saved name" });
      await surface.ready;
      surface.input.value = draft;
      await surface.input.dispatch("input");
      await surface.input.dispatch("blur");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(surface.renameRequests, []);
      assert.equal(surface.input.value, draft);
      assert.equal(surface.printName.textContent, "Saved name");
      assert.equal(surface.input.disabled, false);
      assert.notEqual(surface.feedback.textContent, "");
      assert.match(surface.feedback.className, /is-error/);
    });
  }
});

test("report name accepts the 80-character boundary and renders markup-like names as text", async () => {
  const surface = mountReportNameEditor();
  await surface.ready;
  for (const draft of ["x".repeat(80), '<img src=x onerror="stealOAuthToken()">']) {
    surface.input.value = draft;
    await surface.input.dispatch("input");
    await surface.input.dispatch("blur");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(surface.printName.textContent, draft);
    assert.equal(surface.input.value, draft);
    assert.deepEqual(surface.printName.children, []);
  }
  assert.equal(surface.renameRequests.length, 2);
  assert.equal(surface.document.createdTags.includes("img"), false);
});

test("failed report rename keeps its draft and saved print name and allows retry", async () => {
  let attempts = 0;
  const surface = mountReportNameEditor({
    displayName: "Saved name",
    async renameReport(input) {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("The report name could not be saved. Try again.");
      }
      return { reportId: input.reportId, displayName: input.displayName };
    },
  });
  await surface.ready;
  surface.input.value = "Retry this name";
  await surface.input.dispatch("input");
  await surface.input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surface.input.value, "Retry this name");
  assert.equal(surface.printName.textContent, "Saved name");
  assert.equal(surface.input.disabled, false);
  assert.match(surface.feedback.textContent, /could not be saved|try again/i);
  assert.match(surface.feedback.className, /is-error/);
  assert.equal(surface.document.querySelector("#report-content").hidden, false);
  assert.equal(surface.document.querySelector("#print-report").disabled, false);

  await surface.input.dispatch("keydown", { key: "Enter", preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(surface.input.value, "Retry this name");
  assert.equal(surface.printName.textContent, "Retry this name");
  assert.doesNotMatch(surface.feedback.className, /is-error/);
});

test("report name only accepts a matching persisted rename echo", async (t) => {
  for (const response of [
    null,
    { reportId: SECOND_REPORT_ID, displayName: "Requested name" },
    { reportId: REPORT_ID, displayName: "Altered name" },
    { reportId: REPORT_ID },
  ]) {
    await t.test(JSON.stringify(response), async () => {
      const surface = mountReportNameEditor({
        displayName: "Saved name",
        renameReport: async () => response,
      });
      await surface.ready;
      surface.input.value = "Requested name";
      await surface.input.dispatch("input");
      await surface.input.dispatch("blur");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(surface.input.value, "Requested name");
      assert.equal(surface.printName.textContent, "Saved name");
      assert.equal(surface.input.disabled, false);
      assert.match(surface.feedback.className, /is-error/);
      assert.notEqual(surface.feedback.textContent, "");
    });
  }
});

test("report name stays disabled when rename support is unavailable", async () => {
  const surface = mountReportNameEditor({
    displayName: "Readable saved name",
    canRename: false,
  });
  await surface.ready;
  assert.equal(surface.input.value, "Readable saved name");
  assert.equal(surface.printName.textContent, "Readable saved name");
  assert.equal(surface.input.disabled, true);
  surface.input.value = "Cannot save this";
  await surface.input.dispatch("blur");
  await surface.input.dispatch("keydown", { key: "Enter", preventDefault() {} });
  assert.deepEqual(surface.renameRequests, []);
  assert.equal(surface.printName.textContent, "Readable saved name");
  assert.equal(surface.document.querySelector("#print-report").disabled, false);
});

test("stale rename success or failure cannot overwrite a newly loaded report", async (t) => {
  for (const newReportId of [REPORT_ID, SECOND_REPORT_ID]) {
    for (const outcome of ["success", "failure"]) {
      await t.test(`${newReportId} ${outcome}`, async () => {
        const save = createDeferred();
        let loadCount = 0;
        const surface = mountReportNameEditor({
          async getReport({ reportId }) {
            loadCount += 1;
            return {
              reportId,
              lifecycleStatus: "finalized",
              displayName: loadCount === 1 ? "Original name" : "Newly loaded name",
              report: createReport({ reportId }),
            };
          },
          renameReport: () => save.promise,
        });
        await surface.ready;
        surface.input.value = "Old rename request";
        await surface.input.dispatch("input");
        const pendingSave = surface.input.dispatch("blur");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(surface.input.disabled, true);
        surface.location.search = `?reportId=${encodeURIComponent(newReportId)}`;
        await surface.mounted.load();
        const expectedInput = newReportId === REPORT_ID
          ? "Old rename request"
          : "Newly loaded name";
        assert.equal(surface.input.value, expectedInput);
        assert.equal(surface.printName.textContent, "Newly loaded name");
        assert.equal(surface.input.disabled, false);
        const feedbackBefore = surface.feedback.textContent;

        if (outcome === "success") {
          save.resolve({ reportId: REPORT_ID, displayName: "Old rename request" });
        } else {
          save.reject(new Error("Old rename failed."));
        }
        await pendingSave;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(surface.input.value, expectedInput);
        assert.equal(surface.printName.textContent, "Newly loaded name");
        assert.equal(surface.input.disabled, false);
        assert.equal(surface.feedback.textContent, feedbackBefore);
      });
    }
  }
});

test("same-report correction refresh preserves a dirty name draft and refreshes only the saved print name", async () => {
  let onMappingSaved;
  let loadCount = 0;
  const originalReport = createReport();
  const updatedReport = createReport({
    totals: { ...originalReport.totals, grossProfitCents: 700 },
  });
  const surface = mountReportNameEditor({
    async getReport({ reportId }) {
      loadCount += 1;
      return {
        reportId,
        lifecycleStatus: "finalized",
        displayName: loadCount === 1 ? "Original saved name" : "Latest saved name",
        report: loadCount === 1 ? originalReport : updatedReport,
      };
    },
    inlineCorrectionModule: {
      createInlineReportCorrectionController(options) {
        onMappingSaved = options.onSaved;
        return { async load() {}, getState: () => ({ busy: false }) };
      },
    },
  });
  await surface.ready;
  surface.input.value = "Keep my unsaved name";
  await surface.input.dispatch("input");
  await onMappingSaved({ reportId: REPORT_ID });
  assert.equal(surface.input.value, "Keep my unsaved name");
  assert.equal(surface.printName.textContent, "Latest saved name");
  assert.deepEqual(surface.renameRequests, []);
  assert.match(allText(surface.document.querySelector("#summary-grid")), /Gross profit[\s\S]*\$7\.00/);

  await surface.input.dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(surface.input.value, "Latest saved name");
  assert.deepEqual(surface.renameRequests, []);
});

test("report notices stay compact inside Stream summary and disappear when empty", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const printIndex = css.indexOf("@media print");
  const screenCss = css.slice(0, printIndex);
  const mobileCss = screenCss.slice(screenCss.indexOf("@media (max-width: 720px)"));
  const summaryStart = html.indexOf(
    '<section class="report-section" aria-labelledby="summary-title">',
  );
  const summaryEnd = html.indexOf("</section>", summaryStart);
  const summarySection = html.slice(summaryStart, summaryEnd);
  const noticesStart = summarySection.indexOf('id="warnings-section"');
  const metricsStart = summarySection.indexOf('id="summary-grid"');

  assert.ok(summaryStart >= 0);
  assert.ok(noticesStart > summarySection.indexOf('id="summary-title"'));
  assert.ok(metricsStart > noticesStart);
  assert.match(
    summarySection,
    /<aside[\s\S]*?id="warnings-section"[\s\S]*?class="summary-notices"[\s\S]*?hidden[\s\S]*?>/,
  );
  assert.match(
    summarySection,
    /Review before updating inventory[\s\S]*Report notices[\s\S]*id="report-warnings"/,
  );
  assert.doesNotMatch(html, /<section[^>]+id="warnings-section"/);
  assert.equal((html.match(/id="warnings-section"/g) ?? []).length, 1);
  assert.match(
    screenCss,
    /\.section-heading\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*flex-start;[^}]*gap:\s*18px;[^}]*margin-bottom:\s*16px;/,
  );
  assert.match(
    screenCss,
    /\.summary-notices\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\);[^}]*flex:\s*1 1 520px;[^}]*gap:\s*14px;[^}]*max-width:\s*860px;[^}]*margin-left:\s*auto;[^}]*padding:\s*9px 12px;/,
  );
  assert.doesNotMatch(mobileCss, /\.summary-heading\b|\.summary-notices\b/);
  assert.match(
    mobileCss,
    /\.table-heading,\s*\.section-actions,\s*\.report-footer\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/,
  );

  const warningDocument = new FakeDocument();
  reportPage.renderReport(warningDocument, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report: createReport(),
  });
  assert.equal(warningDocument.querySelector("#warnings-section").hidden, false);
  assert.equal(warningDocument.querySelector("#report-warnings").children.length, 2);

  const clearDocument = new FakeDocument();
  reportPage.renderReport(clearDocument, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report: createReport({ warnings: [] }),
  });
  assert.equal(clearDocument.querySelector("#warnings-section").hidden, true);
  assert.equal(clearDocument.querySelector("#report-warnings").children.length, 0);
});

test("report notices use the approved concise text with dynamic counts and oversold SKU details", () => {
  const document = new FakeDocument();
  const warnings = [
    { code: "active_bidding_at_end", count: 1, sku: null },
    { code: "unresolved_orders", count: 12, sku: null },
    { code: "pending_inventory_reservations", count: 3, sku: null },
    { code: "payment_fixing_orders", count: 40, sku: null },
    { code: "unmapped_completed_sales", count: 5, sku: null },
    { code: "reconciliation_conflicts", count: 60, sku: null },
    { code: "inventory_recount_required", count: 7, sku: "SKU-OVERSOLD-BLUE-XL" },
  ];
  const originalWarnings = warnings.map((warning) => ({ ...warning }));
  const report = createReport({ warnings });

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  assert.equal(document.querySelector("#warnings-section").hidden, false);
  assert.deepEqual(
    document.querySelector("#report-warnings").children.map((item) => item.textContent),
    [
      "A variation was still bidding when tracking ended. Count: 1.",
      "Orders were still unresolved when tracking ended. Count: 12.",
      "Inventory reservations were still pending when tracking ended. Count: 3.",
      "Payments were still unresolved when tracking ended. Count: 40.",
      "Completed sales have no item assigned. Metrics are incomplete. Count: 5.",
      "Order records contain conflicting information. Review these orders. Count: 60.",
      "More units were allocated than starting stock. Check oversold units and recount stock. Oversold: 7. SKU: SKU-OVERSOLD-BLUE-XL.",
    ],
  );
  assert.equal(report.warnings, warnings);
  assert.deepEqual(report.warnings, originalWarnings);
});

test("print keeps compact Report notices to the right of Stream summary without clipping warnings", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "extension", "report", "report.css"),
    "utf8",
  );
  const printIndex = css.indexOf("@media print");
  const screenCss = css.slice(0, printIndex);
  const printCss = css.slice(printIndex);
  const summaryHeading = printCss.match(/\.summary-heading\s*\{([^}]*)\}/)?.[1];
  const notices = printCss.match(/\.summary-notices\s*\{([^}]*)\}/)?.[1];
  const warningList = printCss.match(
    /\.summary-notices \.warning-list\s*\{([^}]*)\}/,
  )?.[1];

  assert.ok(printIndex >= 0);
  assert.ok(summaryHeading);
  assert.ok(notices);
  assert.ok(warningList);
  assert.match(summaryHeading, /display:\s*grid;/);
  assert.match(summaryHeading, /grid-template-columns:\s*max-content minmax\(0, 1fr\);/);
  assert.match(summaryHeading, /align-items:\s*center;/);
  assert.match(summaryHeading, /gap:\s*0\.12in;/);
  assert.match(summaryHeading, /margin-bottom:\s*0\.12in;/);
  assert.match(summaryHeading, /break-inside:\s*avoid-page;/);
  assert.doesNotMatch(summaryHeading, /flex-direction:\s*column;/);
  assert.match(notices, /grid-template-columns:\s*minmax\(0, 1\.15in\) minmax\(0, 1fr\);/);
  assert.match(notices, /min-width:\s*0;/);
  assert.match(notices, /(?:^|;)\s*width:\s*auto;/);
  assert.match(notices, /max-width:\s*none;/);
  assert.match(notices, /margin-left:\s*0;/);
  assert.match(notices, /gap:\s*0\.08in;/);
  assert.match(notices, /padding:\s*0\.07in 0\.09in;/);
  assert.match(notices, /border-radius:\s*0\.08in;/);
  assert.match(notices, /overflow-wrap:\s*anywhere;/);
  assert.match(
    printCss,
    /\.summary-notices-heading \.eyebrow\s*\{[^}]*font-size:\s*6pt;/,
  );
  assert.match(
    printCss,
    /\.summary-notices-heading h3\s*\{[^}]*margin:\s*0;[^}]*font-size:\s*9pt;/,
  );
  assert.match(warningList, /font-size:\s*7pt;/);
  assert.match(warningList, /line-height:\s*1\.3;/);
  assert.match(warningList, /gap:\s*0\.03in;/);
  assert.match(warningList, /padding-left:\s*0\.12in;/);

  assert.match(
    screenCss,
    /\.summary-notices-heading \.eyebrow\s*\{[^}]*font-size:\s*8px;/,
  );
  assert.match(screenCss, /\.summary-notices-heading h3\s*\{[^}]*font-size:\s*13px;/);
  assert.match(
    screenCss,
    /\.warning-list\s*\{[^}]*gap:\s*4px;[^}]*padding-left:\s*17px;[^}]*font-size:\s*11px;[^}]*line-height:\s*1\.35;/,
  );
  assert.doesNotMatch(screenCss, /\.summary-heading\s*\{/);

  const noticeRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => /\.summary-heading\b|\.summary-notices\b|\.warning-list\b|#warnings-section\b|#report-warnings\b/.test(rule[1]));
  for (const [, selector, declarations] of noticeRules) {
    assert.doesNotMatch(
      declarations,
      /(?:^|;)\s*(?:height|max-height)\s*:/,
      `${selector.trim()} must expand to fit every report notice`,
    );
    assert.doesNotMatch(
      declarations,
      /(?:overflow(?:-[xy])?\s*:\s*(?:hidden|clip|scroll|auto)|text-overflow\s*:\s*ellipsis|(?:-webkit-)?line-clamp\s*:|white-space\s*:\s*nowrap)/,
      `${selector.trim()} must wrap warning text without clipping`,
    );
  }

  const warningDocument = new FakeDocument();
  const warnings = Array.from({ length: 12 }, (_, index) => ({
    message: `Notice ${index + 1}: Review SKU-${"LONGREFERENCE".repeat(15)} before updating inventory.`,
  }));
  reportPage.renderReport(warningDocument, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report: createReport({ warnings }),
  });
  assert.equal(warningDocument.querySelector("#warnings-section").hidden, false);
  assert.deepEqual(
    warningDocument.querySelector("#report-warnings").children.map((item) => item.textContent),
    warnings.map((warning) => warning.message),
  );
});

test("completed and canceled item variations print only when the user expands their disclosure", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const detailsTag = html.match(
    /<details\s+id="completed-sales-disclosure"[^>]*>/,
  )?.[0];
  const disclosureStart = html.indexOf('<details id="completed-sales-disclosure">');
  const disclosureEnd = html.indexOf("</details>", disclosureStart);
  const disclosure = html.slice(disclosureStart, disclosureEnd);
  const summary = disclosure.match(
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
  assert.match(summary, /Stream variations/);
  assert.match(summary, /Item variations this stream/);
  assert.match(summary, /0 variations/);
  assert.match(summary, /id="sales-count"/);
  assert.equal((html.match(/id="completed-sales-content"/g) ?? []).length, 1);
  assert.equal((html.match(/id="completed-sales-rows"/g) ?? []).length, 1);
  assert.equal((html.match(/id="sales-empty"/g) ?? []).length, 1);
  assert.match(content, /class="table-scroll screen-scroll"/);
  assert.match(content, /class="data-table sales-table"/);
  assert.match(content, /aria-labelledby="sales-title"/);
  assert.match(content, /id="completed-sales-rows"/);
  assert.match(content, /id="sales-empty"/);
  assert.match(content, /id="variation-details-note"/);
  assert.match(content, /<th scope="col">Status<\/th>/);
  assert.match(
    content,
    /Canceled item mappings are reference-only and do not affect inventory or metrics/,
  );
  assert.match(css, /\.completed-sales-toggle:focus-visible/);
  assert.doesNotMatch(
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

test("print uses white dark-section headings without recoloring metric cards or tables", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "extension", "report", "report.css"),
    "utf8",
  );
  const printIndex = css.indexOf("@media print");
  const screenCss = css.slice(0, printIndex);
  const printCss = css.slice(printIndex);
  const selectors = [
    ".section-heading h2",
    ".section-heading .eyebrow",
    ".section-heading .section-count",
    ".summary-notices-heading h3",
    ".completed-sales-summary-heading",
    ".completed-sales-summary-heading .eyebrow",
    ".completed-sales-summary-heading .section-count",
  ];
  const headingRule = printCss.match(
    /(\.section-heading h2,[^{}]+)\{\s*color: #ffffff;\s*\}/,
  );

  assert.ok(printIndex >= 0);
  assert.ok(headingRule, "white header text must be scoped to print/PDF");
  assert.deepEqual(headingRule[1].split(",").map((selector) => selector.trim()), selectors);
  assert.doesNotMatch(screenCss, /\.section-heading h2,[^{}]+\{\s*color: #ffffff;/);
  assert.match(screenCss, /\.eyebrow\s*\{[^}]*color: var\(--text-subtle\);/);
  assert.match(screenCss, /\.section-count\s*\{[^}]*color: var\(--text-muted\);/);
  assert.match(printCss, /--surface-raised: #f5f7fa;/);
  assert.match(printCss, /--text: #111820;/);
  assert.match(printCss, /\.summary-grid dd\s*\{[^}]*color: #086c5c;/);
  assert.match(printCss, /\.summary-card-row-value\s*\{[^}]*color: #086c5c;/);
  assert.match(printCss, /\.performer-value\s*\{[^}]*color: #086c5c;/);
  assert.match(
    printCss,
    /\.data-table th,\s*\.data-table td\s*\{\s*color: #000000 !important;/,
  );
});

test("all report tables use high-contrast zebra rows on screen and in print", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const printIndex = css.indexOf("@media print");
  const screenCss = css.slice(0, printIndex);
  const printCss = css.slice(printIndex);

  assert.equal((html.match(/<table class="data-table /g) ?? []).length, 3);
  assert.match(html, /<table class="data-table sales-table">/);
  assert.doesNotMatch(html, /sku-profit|Profit\/Loss by SKU/);
  assert.match(html, /<table class="data-table performance-table">/);
  assert.match(html, /<table class="data-table inventory-table">/);
  assert.match(
    screenCss,
    /\.data-table th,\s*\.data-table td\s*\{[\s\S]*?border-bottom:\s*1px solid #c7cdd4;[\s\S]*?color:\s*#000000;[\s\S]*?background:\s*#ffffff;/,
  );
  assert.match(
    screenCss,
    /\.data-table tbody tr:nth-child\(even\) td\s*\{\s*background:\s*#f4f6f8;/,
  );
  assert.match(
    screenCss,
    /\.data-table \.muted-cell,\s*\.data-table \.warning-cell\s*\{\s*color:\s*#000000;/,
  );
  assert.match(
    printCss,
    /\.table-scroll,\s*\.data-table,\s*\.data-table th,\s*\.data-table td\s*\{\s*color:\s*#000000 !important;\s*background:\s*#ffffff !important;/,
  );
  assert.match(
    printCss,
    /\.data-table tbody tr:nth-child\(even\) td\s*\{\s*background:\s*#f4f6f8 !important;/,
  );
});

test("SKU performance shows unit cost and average sale price without crowding screen or print", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const tableStart = html.indexOf('<table class="data-table performance-table">');
  const tableEnd = html.indexOf("</table>", tableStart);
  const performanceTable = html.slice(tableStart, tableEnd);
  const headerLabels = [...performanceTable.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const printCss = css.slice(css.indexOf("@media print"));

  assert.deepEqual(headerLabels, [
    "SKU",
    "Product",
    "Size",
    "Units sold",
    "Unit cost",
    "Avg. sale price",
    "Revenue",
    "COGS",
    "Sell-through",
    "Gross margin",
    "Gross profit/loss",
  ]);
  assert.match(css, /\.performance-table\s*\{\s*min-width:\s*1080px;/);
  assert.match(
    printCss,
    /\.inventory-table,\s*\.performance-table\s*\{\s*min-width:\s*0;/,
  );

  const document = new FakeDocument();
  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report: createReport(),
  });
  const cells = document.querySelector("#performance-rows").children[0].children;

  assert.equal(cells.length, 11);
  assert.equal(cells[4].textContent, "$6.00");
  assert.equal(cells[5].textContent, "$15.00");
  assert.equal(cells[10].textContent, "+$9.00");
  assert.equal(cells[10].className, "number-cell profit-positive");

  const roundingDocument = new FakeDocument();
  const roundingReport = createReport();
  roundingReport.itemPerformance = [{
    ...roundingReport.itemPerformance[0],
    soldQuantity: 3,
    revenueCents: 1001,
  }];

  reportPage.renderReport(roundingDocument, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report: roundingReport,
  });

  assert.equal(
    roundingDocument.querySelector("#performance-rows").children[0].children[5].textContent,
    "$3.34",
  );
});

test("SKU performance appears immediately before Top performers", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "extension", "report", "report.html"),
    "utf8",
  );
  const performanceStart = html.indexOf('aria-labelledby="performance-table-title"');
  const performersStart = html.indexOf('aria-labelledby="performers-title"');
  const inventoryStart = html.indexOf("inventory-update-section");

  assert.ok(performanceStart >= 0);
  assert.ok(performersStart > performanceStart);
  assert.ok(inventoryStart > performersStart);
});

test("updated inventory shows every SKU unit cost with a compact accessible Sold header", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const tableStart = html.indexOf('<table class="data-table inventory-table">');
  const tableEnd = html.indexOf("</table>", tableStart);
  const inventoryTable = html.slice(tableStart, tableEnd);
  const headerLabels = [...inventoryTable.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const printCss = css.slice(css.indexOf("@media print"));

  assert.deepEqual(headerLabels, [
    "SKU",
    "Item",
    "Style",
    "Size",
    "Unit cost",
    "Opening",
    "Sold",
    "Updated count",
    "Oversold",
  ]);
  assert.match(
    inventoryTable,
    /<th[\s\S]*?aria-label="Sold since inventory baseline"[\s\S]*?title="Sold since inventory baseline"[\s\S]*?>Sold<\/th>/,
  );
  assert.match(
    inventoryTable,
    /<caption>[\s\S]*?completed mapped sales since the inventory baseline[\s\S]*?every SKU[\s\S]*?<\/caption>/,
  );
  assert.match(css, /\.table-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(css, /\.inventory-table\s*\{\s*min-width:\s*800px;/);
  assert.match(
    css,
    /\.data-table\.inventory-table \.number-cell\s*\{\s*text-align:\s*center;/,
  );
  assert.match(
    printCss,
    /\.screen-scroll\s*\{[\s\S]*?overflow:\s*visible;/,
  );
  assert.match(
    printCss,
    /\.inventory-table,\s*\.performance-table\s*\{\s*min-width:\s*0;/,
  );
  assert.match(
    printCss,
    /\.data-table thead\s*\{\s*display:\s*table-header-group;/,
  );

  const base = createReport();
  const inventory = [
    base.inventory[0],
    {
      sku: "SKU-ZERO-COST-WITH-A-LONG-IDENTIFIER",
      item: "Long inventory item name retained in the narrow scrollable table",
      style: "limited-edition-long-style-name",
      size: "ONE-SIZE",
      unitCostCents: 0,
      openingQuantity: 20,
      streamSoldQuantity: 0,
      baselineSoldQuantity: 3,
      pendingQuantity: 0,
      replacementQuantity: 17,
      oversoldQuantity: 0,
    },
  ];
  const document = new FakeDocument();

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report: createReport({ inventory }),
  });

  const rows = document.querySelector("#inventory-rows").children;
  assert.equal(rows.length, inventory.length);
  assert.deepEqual(rows.map((row) => row.children.length), [9, 9]);
  assert.deepEqual(
    rows.map((row) => row.children[4].textContent),
    ["$6.00", "$0.00"],
  );
  assert.deepEqual(
    rows[1].children.map((cell) => cell.textContent),
    [
      "SKU-ZERO-COST-WITH-A-LONG-IDENTIFIER",
      "Long inventory item name retained in the narrow scrollable table",
      "limited-edition-long-style-name",
      "ONE-SIZE",
      "$0.00",
      "20",
      "3",
      "17",
      "0",
    ],
  );
  assert.equal(rows[0].children[4].className, "number-cell");
  assert.equal(rows[1].children[4].className, "number-cell");
});

test("Google Sheets handoff retains its actions and table without instructions", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const source = fs.readFileSync(path.join(directory, "report-page.js"), "utf8");
  const sectionStart = html.indexOf("inventory-update-section");
  const sectionEnd = html.indexOf("</section>", sectionStart);
  const section = html.slice(sectionStart, sectionEnd);
  const copyIndex = section.indexOf('id="copy-inventory"');
  const downloadIndex = section.indexOf('id="download-inventory"');
  const tableIndex = section.indexOf('<table class="data-table inventory-table">');

  assert.ok(sectionStart >= 0);
  assert.ok(copyIndex >= 0);
  assert.ok(downloadIndex > copyIndex);
  assert.ok(tableIndex > downloadIndex);
  assert.match(section, /Google Sheets handoff/);
  assert.match(section, /<h2 id="inventory-title">Updated inventory<\/h2>/);
  assert.match(
    section,
    /id="copy-inventory"[^>]*type="button">\s*Copy Updated Inventory\s*<\/button>/,
  );
  assert.match(
    section,
    /id="download-inventory"[^>]*type="button">\s*Download Updated Inventory CSV\s*<\/button>/,
  );
  assert.match(section, /<tbody id="inventory-rows"><\/tbody>/);
  assert.doesNotMatch(
    html,
    /inventory-instructions|inventory-workflow|(?:Show|Hide) instructions|Google Sheets handoff instructions/,
  );
  assert.doesNotMatch(
    html,
    /duplicate the <strong>Inventory<\/strong> tab as a backup|Return to the original|click cell <strong>A1<\/strong>|Cmd\+V|Ctrl\+V|The pasted six-column rectangle|Keep the rows in this exported order|Download Updated Inventory CSV is available as an alternative/,
  );
  assert.doesNotMatch(
    source,
    /inventory-instructions|inventoryInstructions|setInventoryInstructionsExpanded|(?:Show|Hide) instructions/,
  );
  assert.doesNotMatch(
    css,
    /inventory-instructions|inventory-workflow/,
  );
});

test("mapping correction sits between Sheets handoff and stream variations", () => {
  const directory = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(directory, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "report.css"), "utf8");
  const source = fs.readFileSync(path.join(directory, "report-page.js"), "utf8");
  const inventoryStart = html.indexOf("inventory-update-section");
  const inventoryEnd = html.indexOf("</section>", inventoryStart) +
    "</section>".length;
  const mappingStart = html.indexOf('id="mapping-correction-section"');
  const mappingSectionStart = html.lastIndexOf("<section", mappingStart);
  const mappingEnd = html.indexOf("</section>", mappingStart) +
    "</section>".length;
  const variationsStart = html.indexOf('id="completed-sales-disclosure"');
  const variationsSectionStart = html.lastIndexOf("<section", variationsStart);
  const unitCostStart = html.indexOf('id="unit-cost-correction-section"');
  const footerStart = html.indexOf('<footer class="report-footer">');

  assert.ok(inventoryStart >= 0);
  assert.ok(mappingStart > inventoryStart);
  assert.ok(variationsStart > mappingStart);
  assert.ok(unitCostStart > variationsStart);
  assert.ok(footerStart > unitCostStart);
  assert.equal(html.slice(inventoryEnd, mappingSectionStart).trim(), "");
  assert.equal(html.slice(mappingEnd, variationsSectionStart).trim(), "");
  assert.equal(
    html.lastIndexOf("<section", footerStart),
    html.lastIndexOf("<section", unitCostStart),
  );
  assert.equal((html.match(/id="mapping-correction-section"/g) ?? []).length, 1);
  assert.equal((html.match(/id="unit-cost-correction-section"/g) ?? []).length, 1);
  assert.doesNotMatch(
    html,
    /definitions-(?:section|disclosure|toggle|title|content)|report-definitions|definition-list|Definitions and limitations|How totals are calculated/i,
  );
  assert.doesNotMatch(source, /DEFAULT_DEFINITIONS|renderDefinitions|#definitions-/);
  assert.doesNotMatch(css, /\.definitions-|\.definition-list|#definitions-/);
});

test("Print preserves item-variation screen state without handoff instructions", async () => {
  const document = new FakeDocument();
  const completedSales = document.querySelector("#completed-sales-disclosure");
  const printedStates = [];

  assert.equal(document.querySelector("#inventory-instructions"), null);
  assert.equal(document.querySelector("#toggle-inventory-instructions"), null);
  completedSales.open = false;
  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
        };
      },
    },
    print() {
      printedStates.push(completedSales.open);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector("#report-content").hidden, false);
  assert.equal(document.querySelector("#copy-inventory").disabled, false);
  assert.equal(document.querySelector("#download-inventory").disabled, false);
  assert.equal(document.querySelector("#inventory-rows").children.length, 1);
  await document.querySelector("#print-report").click();
  assert.deepEqual(printedStates, [false]);
  assert.equal(completedSales.open, false);

  completedSales.open = true;
  await document.querySelector("#print-report").click();
  assert.deepEqual(printedStates, [false, true]);
  assert.equal(completedSales.open, true);
});

test("inline mapping correction loads and rerenders the same durable report", async () => {
  const document = new FakeDocument();
  const originalReport = createReport();
  const correctedReport = createReport({
    totals: {
      ...originalReport.totals,
      costOfGoodsCents: 0,
      grossProfitCents: 0,
      unmappedCompletedCount: 2,
    },
    topItems: {
      mostSold: null,
      mostProfitable: null,
    },
    itemPerformance: [],
    completedSales: originalReport.completedSales.map((sale) =>
      sale.variationNumber === 12
        ? {
            ...sale,
            mapped: false,
            sku: null,
            item: null,
            style: null,
            size: null,
            unitCostCents: null,
            grossProfitCents: null,
          }
        : sale),
    warnings: [
      { code: "unmapped_completed_sales", count: 2, sku: null },
    ],
  });
  const editorInventory = [{
    sku: "SKU-A",
    item: "Example tee",
    style: "black",
    size: "L",
    unitCostCents: 600,
    openingQuantity: 1,
    streamSoldQuantity: 1,
    baselineSoldQuantity: 1,
    pendingQuantity: 0,
    calculatedRemainingQuantity: 0,
    replacementQuantity: 0,
    availableAfterReservationsQuantity: 0,
    oversoldQuantity: 0,
    requiresRecount: false,
  }];
  const initialEditorData = {
    reportId: REPORT_ID,
    displayName: "Sunday evening stream",
    endedAt: ENDED_AT,
    eligibility: { status: "editable", code: null, reason: null },
    canceledDetailsAvailable: true,
    completedVariations: [
      {
        variationNumber: 12,
        expectedStatus: "payment_complete",
        expectedSku: "SKU-A",
        soldPriceCents: 1500,
      },
      {
        variationNumber: 13,
        expectedStatus: "payment_complete",
        expectedSku: null,
        soldPriceCents: 1000,
      },
    ],
    canceledVariations: [
      {
        variationNumber: 14,
        expectedStatus: "canceled",
        expectedSku: "SKU-A",
      },
    ],
    inventory: editorInventory,
  };
  const savedEditorData = {
    ...initialEditorData,
    completedVariations: initialEditorData.completedVariations.map(
      (variation) => variation.variationNumber === 12
        ? { ...variation, expectedSku: null }
        : variation,
    ),
  };
  const reportLoads = [];
  const correctionLoads = [];
  const correctionSaves = [];
  const confirmations = [];

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport(input) {
            reportLoads.push({ ...input });
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: reportLoads.length === 1
                ? originalReport
                : correctedReport,
            };
          },
          async listPaymentFixingOrders() {
            return { reportId: REPORT_ID, orders: [] };
          },
          async listReportUnitCosts() {
            return { reportId: REPORT_ID, skus: [] };
          },
        };
      },
    },
    correctionClientModule: {
      createOfflineReportEditorClient() {
        return {
          async loadEditorData(input) {
            correctionLoads.push({ ...input });
            return initialEditorData;
          },
          async saveMappingCorrections(input) {
            correctionSaves.push(JSON.parse(JSON.stringify(input)));
            return savedEditorData;
          },
        };
      },
    },
    inlineCorrectionModule: inlineCorrection,
    confirm(message) {
      confirmations.push(message);
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reportLoads, [{ reportId: REPORT_ID }]);
  assert.deepEqual(correctionLoads, [{ reportId: REPORT_ID }]);

  const group = document.querySelector("#mapping-item-group");
  group.value = inlineCorrection.UNMAPPED_GROUP_VALUE;
  await group.dispatch("change");
  await document.querySelector("#save-mapping-correction").click();

  assert.deepEqual(correctionSaves, [{
    reportId: REPORT_ID,
    changes: [{
      variationNumber: 12,
      expectedStatus: "payment_complete",
      expectedSku: "SKU-A",
      sku: null,
    }],
  }]);
  assert.equal(confirmations.length, 0);
  assert.deepEqual(reportLoads, [
    { reportId: REPORT_ID },
    { reportId: REPORT_ID },
  ]);
  assert.match(allText(document.querySelector("#summary-grid")), /Gross profit/);
  assert.match(allText(document.querySelector("#summary-grid")), /\$0\.00/);
  assert.equal(
    document.querySelector("#completed-sales-rows").children[0]
      .children[2].textContent,
    "Unmapped",
  );
});

test("mapping refresh failure disables stale unit-cost controls until recovery", async () => {
  const document = new FakeDocument();
  const unitCostEntry = {
    sku: "SKU-A",
    item: "Example tee",
    style: "black",
    size: "L",
    unitCostCents: 600,
    completedSaleCount: 1,
  };
  let unitCostRequestCount = 0;
  let onMappingSaved = null;

  const mounted = reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
          async listReportUnitCosts() {
            unitCostRequestCount += 1;

            if (unitCostRequestCount === 2 || unitCostRequestCount === 3) {
              throw new Error("Unit-cost data is temporarily unavailable.");
            }

            return { reportId: REPORT_ID, skus: [unitCostEntry] };
          },
        };
      },
    },
    inlineCorrectionModule: {
      createInlineReportCorrectionController(options) {
        onMappingSaved = options.onSaved;
        return {
          async load() {},
          getState() {
            return { busy: false };
          },
        };
      },
    },
    confirm: () => true,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const section = document.querySelector("#unit-cost-correction-section");
  const disclosure = document.querySelector(
    "#unit-cost-correction-disclosure",
  );
  const select = document.querySelector("#unit-cost-sku");
  const input = document.querySelector("#unit-cost-value");
  const button = document.querySelector("#update-unit-cost");
  const unitCostStatus = document.querySelector("#unit-cost-feedback");

  assert.equal(select.disabled, false);
  assert.equal(select.children.length, 1);
  await onMappingSaved({ reportId: REPORT_ID });

  assert.equal(unitCostRequestCount, 2);
  assert.equal(section.hidden, false);
  assert.equal(section.attributes.get("aria-busy"), "false");
  assert.equal(disclosure.open, true);
  assert.equal(select.children.length, 0);
  assert.equal(select.disabled, true);
  assert.equal(input.disabled, true);
  assert.equal(input.value, "");
  assert.equal(button.disabled, true);
  assert.equal(unitCostStatus.className, "unit-cost-feedback is-error");
  assert.match(
    unitCostStatus.textContent,
    /saved[\s\S]*could not refresh[\s\S]*Reload this report/,
  );
  assert.equal(select.title, unitCostStatus.textContent);

  await mounted.load();
  assert.equal(unitCostRequestCount, 3);
  assert.equal(section.hidden, false);
  assert.equal(select.disabled, true);
  assert.equal(unitCostStatus.className, "unit-cost-feedback is-error");
  assert.match(unitCostStatus.textContent, /Reload this report/);

  await mounted.load();
  assert.equal(unitCostRequestCount, 4);
  assert.equal(section.hidden, false);
  assert.equal(select.disabled, false);
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);
  assert.equal(select.children.length, 1);
  assert.equal(select.value, "SKU-A");
  assert.equal(select.title, "");
  assert.equal(unitCostStatus.className, "unit-cost-feedback");
  assert.equal(unitCostStatus.textContent, "");
});

test("stale auxiliary failures cannot overwrite a newer report", async (t) => {
  for (const failingRequest of ["payments", "unit costs"]) {
    await t.test(failingRequest, async () => {
      const document = new FakeDocument();
      const location = {
        search: `?reportId=${encodeURIComponent(REPORT_ID)}`,
      };
      const oldRequest = createDeferred();
      const oldRequestStarted = createDeferred();
      const newerOrder = {
        variationNumber: 330,
        observedPaymentStatus: "payment_failed",
        mapped: false,
        sku: null,
        item: null,
        style: null,
        size: null,
      };
      const newerCost = {
        sku: "SKU-B",
        item: "New report item",
        style: "blue",
        size: "M",
        unitCostCents: 700,
        completedSaleCount: 1,
      };
      const mounted = reportPage.mountStreamReportPage({
        document,
        location,
        navigator: {},
        runtime: {},
        protocol,
        reportModule: { hydrateStreamReport: (report) => report },
        clientModule: {
          createStreamReportClient() {
            return {
              async getReport({ reportId }) {
                return {
                  reportId,
                  lifecycleStatus: "finalized",
                  displayName: reportId === REPORT_ID
                    ? "Older report"
                    : "Newer report",
                  report: createReport(),
                };
              },
              async listPaymentFixingOrders({ reportId }) {
                if (
                  reportId === REPORT_ID &&
                  failingRequest === "payments"
                ) {
                  oldRequestStarted.resolve();
                  return oldRequest.promise;
                }

                return {
                  reportId,
                  orders: reportId === SECOND_REPORT_ID ? [newerOrder] : [],
                };
              },
              async listReportUnitCosts({ reportId }) {
                if (
                  reportId === REPORT_ID &&
                  failingRequest === "unit costs"
                ) {
                  oldRequestStarted.resolve();
                  return oldRequest.promise;
                }

                return {
                  reportId,
                  skus: reportId === SECOND_REPORT_ID ? [newerCost] : [],
                };
              },
            };
          },
        },
      });

      await oldRequestStarted.promise;
      location.search =
        `?reportId=${encodeURIComponent(SECOND_REPORT_ID)}`;
      await mounted.load();
      assert.equal(document.querySelector("#report-name").textContent, "Newer report");
      assert.equal(
        document.querySelector("#payment-resolution-orders").children.length,
        1,
      );
      assert.equal(document.querySelector("#unit-cost-sku").value, "SKU-B");

      oldRequest.reject(new Error("Older report auxiliary request failed."));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(document.querySelector("#report-name").textContent, "Newer report");
      assert.equal(
        document.querySelector("#payment-resolution-orders").children.length,
        1,
      );
      assert.equal(document.querySelector("#unit-cost-sku").value, "SKU-B");
      assert.doesNotMatch(
        document.querySelector("#action-feedback").textContent,
        /Older report auxiliary request failed/,
      );
    });
  }
});

test("a unit-cost refresh warning cannot leak into another report", async () => {
  const document = new FakeDocument();
  const location = { search: `?reportId=${encodeURIComponent(REPORT_ID)}` };
  let firstReportCostRequests = 0;
  let onMappingSaved = null;
  const mounted = reportPage.mountStreamReportPage({
    document,
    location,
    navigator: {},
    runtime: {},
    protocol,
    reportModule: { hydrateStreamReport: (report) => report },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport({ reportId }) {
            return {
              reportId,
              lifecycleStatus: "finalized",
              displayName: reportId === REPORT_ID
                ? "First report"
                : "Second report",
              report: createReport(),
            };
          },
          async listReportUnitCosts({ reportId }) {
            if (reportId === SECOND_REPORT_ID) {
              throw new Error("Second report unit costs are unavailable.");
            }

            firstReportCostRequests += 1;
            if (firstReportCostRequests > 1) {
              throw new Error("First report unit costs are unavailable.");
            }

            return {
              reportId,
              skus: [{
                sku: "SKU-A",
                item: "Example tee",
                style: "black",
                size: "L",
                unitCostCents: 600,
                completedSaleCount: 1,
              }],
            };
          },
        };
      },
    },
    inlineCorrectionModule: {
      createInlineReportCorrectionController(options) {
        onMappingSaved = options.onSaved;
        return {
          async load() {},
          getState() {
            return { busy: false };
          },
        };
      },
    },
    confirm: () => true,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await onMappingSaved({ reportId: REPORT_ID });
  assert.match(
    document.querySelector("#unit-cost-feedback").textContent,
    /mapping correction was saved/,
  );

  location.search = `?reportId=${encodeURIComponent(SECOND_REPORT_ID)}`;
  await mounted.load();

  assert.equal(document.querySelector("#report-name").textContent, "Second report");
  assert.equal(document.querySelector("#unit-cost-correction-section").hidden, true);
  assert.equal(document.querySelector("#unit-cost-feedback").textContent, "");
  assert.equal(document.querySelector("#unit-cost-sku").title, "");
  assert.match(
    document.querySelector("#action-feedback").textContent,
    /Second report unit costs are unavailable/,
  );
});

test("an unexpected correction-controller rejection degrades only its panel", async () => {
  const document = new FakeDocument();
  let printCount = 0;

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: { hydrateStreamReport: (report) => report },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
        };
      },
    },
    inlineCorrectionModule: {
      createInlineReportCorrectionController() {
        return {
          async load() {
            throw new Error("Unexpected controller failure.");
          },
          getState() {
            return { busy: false };
          },
        };
      },
    },
    print() {
      printCount += 1;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.querySelector("#report-content").hidden, false);
  assert.equal(document.querySelector("#mapping-correction-section").hidden, false);
  assert.equal(document.querySelector("#mapping-correction-fields").disabled, true);
  assert.match(
    document.querySelector("#mapping-correction-availability").textContent,
    /Mapping correction is unavailable/,
  );
  assert.equal(
    document.querySelector("#mapping-correction-availability").hidden,
    false,
  );
  assert.equal(
    document.querySelector("#mapping-correction-feedback").className,
    "mapping-correction-feedback visually-hidden is-error",
  );

  await document.querySelector("#print-report").click();
  assert.equal(printCount, 1);
});

test("an older correction refresh failure cannot override a newer success", async () => {
  const document = new FakeDocument();
  const olderRefresh = createDeferred();
  let correctionLoadCount = 0;
  const mounted = reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: { hydrateStreamReport: (report) => report },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
        };
      },
    },
    inlineCorrectionModule: {
      createInlineReportCorrectionController() {
        return {
          load() {
            correctionLoadCount += 1;
            if (correctionLoadCount === 1) {
              return olderRefresh.promise;
            }

            const availability = document.querySelector(
              "#mapping-correction-availability",
            );
            availability.hidden = true;
            availability.textContent = "";
            availability.dataset.state = "editable";
            document.querySelector(
              "#mapping-correction-fields",
            ).disabled = false;
            return Promise.resolve();
          },
          getState() {
            return { busy: false };
          },
        };
      },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await mounted.load();
  olderRefresh.reject(new Error("The older refresh failed late."));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(correctionLoadCount, 2);
  assert.equal(
    document.querySelector("#mapping-correction-availability").textContent,
    "",
  );
  assert.equal(
    document.querySelector("#mapping-correction-availability").hidden,
    true,
  );
  assert.equal(
    document.querySelector("#mapping-correction-availability").dataset.state,
    "editable",
  );
  assert.equal(
    document.querySelector("#mapping-correction-fields").disabled,
    false,
  );
});

test("a stale mapping refetch cannot rerender a different report", async () => {
  const document = new FakeDocument();
  const location = { search: `?reportId=${encodeURIComponent(REPORT_ID)}` };
  const staleRefresh = createDeferred();
  let deferFirstReport = false;
  let onMappingSaved = null;
  const mounted = reportPage.mountStreamReportPage({
    document,
    location,
    navigator: {},
    runtime: {},
    protocol,
    reportModule: { hydrateStreamReport: (report) => report },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport({ reportId }) {
            if (reportId === REPORT_ID && deferFirstReport) {
              return staleRefresh.promise;
            }

            return {
              reportId,
              lifecycleStatus: "finalized",
              displayName: reportId === REPORT_ID
                ? "First report"
                : "Second report",
              report: createReport(),
            };
          },
        };
      },
    },
    inlineCorrectionModule: {
      createInlineReportCorrectionController(options) {
        onMappingSaved = options.onSaved;
        return {
          async load() {},
          getState() {
            return { busy: false };
          },
        };
      },
    },
    confirm: () => true,
  });

  await new Promise((resolve) => setImmediate(resolve));
  deferFirstReport = true;
  const oldRefresh = onMappingSaved({ reportId: REPORT_ID });
  await new Promise((resolve) => setImmediate(resolve));

  location.search = `?reportId=${encodeURIComponent(SECOND_REPORT_ID)}`;
  await mounted.load();
  staleRefresh.resolve({
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    displayName: "Stale first report",
    report: createReport(),
  });

  await assert.rejects(
    oldRefresh,
    /corrected saved report could not be reloaded safely/,
  );
  assert.equal(document.querySelector("#report-name").textContent, "Second report");
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
  assert.equal(document.querySelector("#completed-sales-rows").children.length, 3);
  assert.equal(document.querySelector("#performance-rows").children.length, 1);
  assert.equal(document.querySelector("#inventory-rows").children.length, 1);
  assert.equal(document.querySelector("#summary-grid").children.length, 12);
  assert.match(
    allText(document.querySelector("#summary-grid")),
    /TikTok 6% Fees[\s\S]*Fees paid:[\s\S]*≈\$2[\s\S]*GMV after fees:[\s\S]*≈\$28/,
  );
  assert.match(
    allText(document.querySelector("#summary-grid")),
    /Est\. Profit After Fees[\s\S]*≈\$22[\s\S]*Incomplete — 1 completed sale still needs an inventory item\./,
  );
  const estimatedProfitCard = document
    .querySelector("#summary-grid")
    .children.find((card) =>
      allText(card).includes("Est. Profit After Fees"),
    );
  assert.equal(estimatedProfitCard.className, "summary-card-warning");
  assert.equal(
    estimatedProfitCard.children.at(-1).className,
    "summary-card-warning-note",
  );
  assert.match(
    allText(document.querySelector("#summary-grid")),
    /Avg\. Profit per Sale[\s\S]*\$9\.00[\s\S]*Gross profit per mapped completed sale/,
  );
  assert.equal(document.createdTags.includes("img"), false);
  assert.match(
    allText(document.querySelector("#completed-sales-rows")),
    /Completed[\s\S]*<img src=x onerror="stealOAuthToken\(\)">[\s\S]*Canceled/,
  );
});

test("item variation rows combine completed and canceled orders in variation order", () => {
  const document = new FakeDocument();
  const base = createReport();
  const report = createReport({
    totals: {
      ...base.totals,
      canceledOrderCount: 2,
    },
    canceledOrders: [
      {
        variationNumber: 11,
        mapped: true,
        sku: "SKU-A",
        item: "Example tee",
        style: "black",
        size: "L",
      },
      {
        variationNumber: 14,
        mapped: false,
        sku: null,
        item: null,
        style: null,
        size: null,
      },
    ],
  });

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  const rows = document.querySelector("#completed-sales-rows").children;
  assert.deepEqual(
    rows.map((row) => row.children[0].textContent),
    ["#11", "#12", "#13", "#14"],
  );
  assert.deepEqual(rows.map((row) => row.children.length), [9, 9, 9, 9]);
  assert.deepEqual(
    rows.map((row) => row.children[1].textContent),
    ["Canceled", "Completed", "Completed", "Canceled"],
  );
  assert.deepEqual(
    rows[0].children.slice(2, 6).map((cell) => cell.textContent),
    ["SKU-A", "Example tee", "black", "L"],
  );
  assert.deepEqual(
    rows[0].children.slice(6).map((cell) => cell.textContent),
    ["—", "—", "—"],
  );
  assert.deepEqual(
    rows[3].children.slice(2).map((cell) => cell.textContent),
    ["Unmapped", "Not selected", "—", "—", "—", "—", "—"],
  );
  assert.deepEqual(
    rows[1].children.slice(6).map((cell) => cell.textContent),
    ["$15.00", "$6.00", "$9.00"],
  );
  assert.equal(document.querySelector("#sales-count").textContent, "4 variations");
  assert.equal(document.querySelector("#sales-empty").hidden, true);
  assert.equal(document.querySelector("#variation-details-note").hidden, true);
});

test("legacy reports retain canceled totals and explain unavailable row details", () => {
  const document = new FakeDocument();
  const base = createReport();
  const report = createReport({
    totals: {
      ...base.totals,
      canceledOrderCount: 3,
    },
    canceledOrders: null,
  });

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  const rows = document.querySelector("#completed-sales-rows").children;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.children[1].textContent),
    ["Completed", "Completed"],
  );
  assert.equal(document.querySelector("#sales-count").textContent, "5 variations");
  assert.equal(document.querySelector("#sales-empty").hidden, true);
  assert.equal(document.querySelector("#variation-details-note").hidden, false);
  assert.match(
    document.querySelector("#variation-details-note").textContent,
    /3 canceled variations[\s\S]*not saved[\s\S]*still included above/,
  );

  const canceledOnlyDocument = new FakeDocument();
  reportPage.renderItemVariations(canceledOnlyDocument, createReport({
    completedSales: [],
    totals: {
      ...base.totals,
      completedPaymentCount: 0,
      canceledOrderCount: 1,
    },
    canceledOrders: null,
  }));
  assert.equal(
    canceledOnlyDocument.querySelector("#completed-sales-rows").children.length,
    0,
  );
  assert.equal(canceledOnlyDocument.querySelector("#sales-count").textContent, "1 variation");
  assert.equal(canceledOnlyDocument.querySelector("#sales-empty").hidden, true);
  assert.equal(canceledOnlyDocument.querySelector("#variation-details-note").hidden, false);
});

test("SKU performance sorts sold SKUs by profit with signed color-coded profit/loss values", () => {
  const document = new FakeDocument();
  const report = createReport({
    itemPerformance: [
      {
        sku: "SKU-ZERO",
        item: "Zero tee",
        style: "white",
        size: "S",
        soldQuantity: 1,
        grossProfitCents: 0,
      },
      {
        sku: "SKU-LOSS",
        item: "Loss tee",
        style: "red",
        size: "M",
        soldQuantity: 2,
        grossProfitCents: -23200,
      },
      {
        sku: "SKU-B",
        item: "Profit tee B",
        style: "blue",
        size: "L",
        soldQuantity: 3,
        grossProfitCents: 59800,
      },
      {
        sku: "SKU-A",
        item: "Profit tee A",
        style: "black",
        size: "L",
        soldQuantity: 4,
        grossProfitCents: 59800,
      },
      {
        sku: "SKU-UNSOLD",
        item: "Unsold tee",
        soldQuantity: 0,
        grossProfitCents: 99900,
      },
      {
        sku: "SKU-UNKNOWN",
        item: "Unknown-cost tee",
        soldQuantity: 1,
      },
    ],
  });

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  const rows = document.querySelector("#performance-rows").children;
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.children[0].textContent), [
    "SKU-A",
    "SKU-B",
    "SKU-ZERO",
    "SKU-LOSS",
    "SKU-UNKNOWN",
  ]);
  assert.deepEqual(rows.map((row) => row.children[10].textContent), [
    "+$598.00",
    "+$598.00",
    "$0.00",
    "-$232.00",
    "Not available",
  ]);
  assert.deepEqual(rows.map((row) => row.children[10].className), [
    "number-cell profit-positive",
    "number-cell profit-positive",
    "number-cell profit-neutral",
    "number-cell profit-negative",
    "number-cell profit-neutral",
  ]);
  assert.equal(document.querySelector("#performance-row-count").textContent, "5 selling SKUs");
  assert.equal(document.querySelector("#performance-empty").hidden, true);
  assert.equal(rows[0].children[1].textContent, "Profit tee A - black");
  assert.equal(rows[0].children[2].textContent, "L");
});

test("SKU sell-through caps at 100% while retaining the oversold quantity", () => {
  const document = new FakeDocument();
  const report = createReport({
    totals: {
      ...createReport().totals,
      completedPaymentCount: 2,
      totalSalesCount: 2,
      canceledOrderCount: 0,
    },
    canceledOrders: [],
    itemPerformance: [
      {
        sku: "SKU-OVER",
        item: "Oversold tee",
        style: "black",
        size: "OS",
        soldQuantity: 2,
        revenueCents: 3000,
        costOfGoodsCents: 1000,
        grossProfitCents: 2000,
      },
    ],
    inventory: [
      {
        sku: "SKU-OVER",
        item: "Oversold tee",
        style: "black",
        size: "OS",
        unitCostCents: 500,
        openingQuantity: 1,
        streamSoldQuantity: 2,
        baselineSoldQuantity: 2,
        pendingQuantity: 0,
        replacementQuantity: 0,
        oversoldQuantity: 1,
      },
    ],
    warnings: [
      { code: "inventory_recount_required", count: 1, sku: "SKU-OVER" },
    ],
  });

  reportPage.renderReport(document, {
    reportId: REPORT_ID,
    lifecycleStatus: "finalized",
    report,
  });

  const performanceRow =
    document.querySelector("#performance-rows").children[0];
  const inventoryRow = document.querySelector("#inventory-rows").children[0];

  assert.equal(performanceRow.children[8].textContent, "100.0%");
  assert.equal(performanceRow.children[9].textContent, "66.7%");
  assert.equal(inventoryRow.children[8].textContent, "1");
  assert.match(
    allText(document.querySelector("#report-warnings")),
    /More units were allocated than starting stock\.[\s\S]*Oversold: 1\. SKU: SKU-OVER\./,
  );
});

test("report action notifications dismiss after four seconds and newer messages restart the timer", async () => {
  const document = new FakeDocument();
  const timers = [];
  const clearedTimerIds = [];
  let nextTimerId = 1;
  let copyAttempts = 0;

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {
      clipboard: {
        async writeText() {
          copyAttempts += 1;

          if (copyAttempts === 2) {
            throw new Error("Copy failed.");
          }
        },
      },
    },
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
        };
      },
    },
    setTimeout(callback, milliseconds) {
      const timer = { id: nextTimerId, callback, milliseconds };
      nextTimerId += 1;
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(timerId) {
      clearedTimerIds.push(timerId);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const actionFeedback = document.querySelector("#action-feedback");
  const inlineFeedback = document.querySelector("#unit-cost-feedback");
  const copyButton = document.querySelector("#copy-inventory");

  copyButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    actionFeedback.textContent,
    "Updated six-column inventory copied. Paste it into Google Sheets.",
  );
  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, 4_000);

  inlineFeedback.textContent = "Inline details stay visible.";
  copyButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clearedTimerIds, [timers[0].id]);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].milliseconds, 4_000);
  assert.equal(actionFeedback.textContent, "Copy failed.");

  timers[0].callback();
  assert.equal(actionFeedback.textContent, "Copy failed.");
  assert.equal(inlineFeedback.textContent, "Inline details stay visible.");

  timers[1].callback();
  assert.equal(actionFeedback.textContent, "");
  assert.equal(inlineFeedback.textContent, "Inline details stay visible.");
});

test("post-stream payment controls render only supplied unresolved rows and collect explicit outcomes", () => {
  const document = new FakeDocument();
  const actions = [];
  const orders = [
    {
      variationNumber: 220,
      observedPaymentStatus: "payment_failed",
      mapped: true,
      sku: "SKU-A",
      item: "Example tee",
      style: "black",
      size: "L",
    },
    {
      variationNumber: 221,
      observedPaymentStatus: "payment_fixing",
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
    {
      variationNumber: 222,
      observedPaymentStatus: "payment_processing",
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
    {
      variationNumber: 223,
      observedPaymentStatus: "order_processing",
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
  ];

  const controls = reportPage.renderPaymentFixingOrders(
    document,
    orders,
    (action) => actions.push(action),
  );
  const section = document.querySelector("#payment-resolution-section");
  const rows = document.querySelector("#payment-resolution-orders");

  assert.equal(section.hidden, false);
  assert.equal(section.attributes.get("aria-busy"), "false");
  assert.equal(rows.children.length, 4);
  assert.equal(controls.length, 12);
  assert.equal(
    document.querySelector("#payment-resolution-count").textContent,
    "4 unresolved orders",
  );
  assert.match(
    allText(rows),
    /Variation #220[\s\S]*Payment failed - fixing period[\s\S]*Example tee - black - L \(SKU-A\)/,
  );
  assert.match(allText(rows), /Variation #221[\s\S]*No inventory item selected/);
  assert.match(allText(rows), /Variation #222[\s\S]*Payment processing/);
  assert.match(allText(rows), /Variation #223[\s\S]*Order processing/);

  const firstPriceInput = rows.children[0].children[1].children[1];
  firstPriceInput.value = "18.25";
  rows.children[0].children[2].click();
  rows.children[1].children[3].click();
  assert.equal(actions[0].resolution, "payment_complete");
  assert.equal(actions[0].soldPriceText, "18.25");
  assert.equal(actions[1].resolution, "canceled");
  assert.equal(actions[1].soldPriceText, null);

  reportPage.renderPaymentFixingOrders(document, [], () => {});
  assert.equal(section.hidden, true);
  assert.equal(rows.children.length, 0);
});

test("final sold prices convert to integer cents without floating-point rounding", () => {
  assert.equal(reportPage.parsePositiveUsdCents("18"), 1800);
  assert.equal(reportPage.parsePositiveUsdCents("18.2"), 1820);
  assert.equal(reportPage.parsePositiveUsdCents("18.25"), 1825);
  assert.equal(reportPage.parsePositiveUsdCents("0.01"), 1);

  for (const invalid of ["", "0", "0.00", "-1", "1.234", "$1.00", "1,000"] ) {
    assert.equal(reportPage.parsePositiveUsdCents(invalid), null);
  }
});

test("unit-cost correction renders every eligible inventory SKU and accepts exact zero-dollar costs", () => {
  const document = new FakeDocument();
  const entries = [
    {
      sku: "SKU-A",
      item: "Example tee",
      style: "black",
      size: "L",
      unitCostCents: 600,
      completedSaleCount: 2,
    },
    {
      sku: "SKU-UNSOLD",
      item: "Unsold tee",
      style: "white",
      size: "S",
      unitCostCents: 0,
      completedSaleCount: 0,
    },
  ];

  const selected = reportPage.renderUnitCostCorrection(
    document,
    entries,
    "SKU-UNSOLD",
  );

  assert.equal(selected.sku, "SKU-UNSOLD");
  assert.equal(document.querySelector("#unit-cost-correction-section").hidden, false);
  assert.equal(document.querySelector("#unit-cost-sku").children.length, 2);
  assert.match(
    document.querySelector("#unit-cost-sku").children[0].textContent,
    /SKU-A - Example tee - black - L - \$6\.00 - 2 sold/,
  );
  assert.equal(document.querySelector("#unit-cost-sku").value, "SKU-UNSOLD");
  assert.equal(document.querySelector("#unit-cost-value").value, "0.00");
  assert.match(
    document.querySelector("#unit-cost-preview").textContent,
    /no completed sales[\s\S]*metrics stay unchanged[\s\S]*only this report's Google Sheets handoff/,
  );

  assert.equal(reportPage.parseNonnegativeUsdCents("0"), 0);
  assert.equal(reportPage.parseNonnegativeUsdCents("0.00"), 0);
  assert.equal(reportPage.parseNonnegativeUsdCents("12.5"), 1250);
  assert.equal(reportPage.parseNonnegativeUsdCents("12.50"), 1250);
  for (const invalid of ["", "-1", "1.234", "$1.00", "1,000"] ) {
    assert.equal(reportPage.parseNonnegativeUsdCents(invalid), null);
  }

  reportPage.renderUnitCostCorrection(document, []);
  assert.equal(document.querySelector("#unit-cost-correction-section").hidden, true);
});

test("report unit-cost correction confirms impact, stays busy, and rerenders the same report and Sheet handoff", async () => {
  const document = new FakeDocument();
  const confirmations = [];
  const updates = [];
  const copied = [];
  const correctionLoads = [];
  let currentUnitCostCents = 600;
  let finishUpdate;
  const updateGate = new Promise((resolve) => {
    finishUpdate = resolve;
  });
  const originalReport = createReport();
  const updatedReport = createReport({
    totals: {
      ...originalReport.totals,
      costOfGoodsCents: 800,
      grossProfitCents: 700,
    },
    topItems: {
      ...originalReport.topItems,
      mostProfitable: {
        ...originalReport.topItems.mostProfitable,
        value: 700,
      },
    },
    itemPerformance: originalReport.itemPerformance.map((entry) => ({
      ...entry,
      costOfGoodsCents: 800,
      grossProfitCents: 700,
    })),
    completedSales: originalReport.completedSales.map((sale) =>
      sale.sku === "SKU-A"
        ? { ...sale, unitCostCents: 800, grossProfitCents: 700 }
        : sale,
    ),
    inventory: originalReport.inventory.map((entry) => ({
      ...entry,
      unitCostCents: 800,
    })),
    sheetRows: originalReport.sheetRows.map((entry) => ({
      ...entry,
      unit_cost: "8.00",
    })),
  });
  const createUnitCosts = () => ({
    reportId: REPORT_ID,
    skus: [
      {
        sku: "SKU-A",
        item: "Example tee",
        style: "black",
        size: "L",
        unitCostCents: currentUnitCostCents,
        completedSaleCount: 1,
      },
      {
        sku: "SKU-UNSOLD",
        item: "Unsold tee",
        style: "white",
        size: "S",
        unitCostCents: 100,
        completedSaleCount: 0,
      },
    ],
  });

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {
      clipboard: {
        async writeText(value) {
          copied.push(value);
        },
      },
    },
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: originalReport,
            };
          },
          async listPaymentFixingOrders() {
            return { reportId: REPORT_ID, orders: [] };
          },
          async listReportUnitCosts() {
            return createUnitCosts();
          },
          async updateReportUnitCost(options) {
            updates.push(options);
            await updateGate;
            currentUnitCostCents = options.unitCostCents;
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: updatedReport,
            };
          },
        };
      },
    },
    inlineCorrectionModule: createCorrectionLoadRecorder(correctionLoads),
    confirm(message) {
      confirmations.push(message);
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const section = document.querySelector("#unit-cost-correction-section");
  const input = document.querySelector("#unit-cost-value");
  const button = document.querySelector("#update-unit-cost");
  assert.equal(section.hidden, false);
  assert.equal(document.querySelector("#unit-cost-sku").children.length, 2);
  input.value = "8.00";
  input.listeners.get("input")?.();
  assert.match(
    document.querySelector("#unit-cost-preview").textContent,
    /COGS increases by \$2\.00[\s\S]*gross profit decreases by \$2\.00/,
  );
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(section.attributes.get("aria-busy"), "true");
  assert.equal(input.disabled, true);
  assert.equal(button.disabled, true);
  assert.match(
    confirmations[0],
    /SKU-A from \$6\.00 to \$8\.00[\s\S]*1 completed sale[\s\S]*only this saved report[\s\S]*other reports[\s\S]*future streams are unaffected/,
  );

  finishUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(updates, [
    { reportId: REPORT_ID, sku: "SKU-A", unitCostCents: 800 },
  ]);
  assert.deepEqual(correctionLoads, [
    { reportId: REPORT_ID, options: {} },
    { reportId: REPORT_ID, options: { preserveDraft: true } },
  ]);
  assert.equal(section.attributes.get("aria-busy"), "false");
  assert.equal(input.disabled, false);
  assert.equal(input.value, "8.00");
  assert.match(allText(document.querySelector("#summary-grid")), /Gross profit[\s\S]*\$7\.00/);
  assert.equal(
    document.querySelector("#completed-sales-rows").children[0].children[7].textContent,
    "$8.00",
  );
  assert.equal(
    document.querySelector("#performance-rows").children[0].children[4].textContent,
    "$8.00",
  );
  assert.equal(
    document.querySelector("#performance-rows").children[0].children[7].textContent,
    "$8.00",
  );
  assert.match(allText(document.querySelector("#most-profitable-items")), /\$7\.00/);
  assert.equal(
    document.querySelector("#inventory-rows").children[0].children[0].textContent,
    "SKU-A",
  );
  assert.equal(
    document.querySelector("#inventory-rows").children[0].children[4].textContent,
    "$8.00",
  );
  assert.match(
    document.querySelector("#unit-cost-feedback").textContent,
    /this report[\s\S]*metrics and Google Sheets handoff were updated[\s\S]*other reports and future streams were not changed/,
  );

  document.querySelector("#copy-inventory").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(copied[0], /SKU-A\t.*\t8\.00/);
});

test("failed report unit-cost correction keeps the selected SKU and entered cost for retry", async () => {
  const document = new FakeDocument();
  let attempts = 0;
  let actionFeedbackTimer = null;

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: { hydrateStreamReport: (report) => report },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
          async listReportUnitCosts() {
            return {
              reportId: REPORT_ID,
              skus: [{
                sku: "SKU-A",
                item: "Example tee",
                style: "black",
                size: "L",
                unitCostCents: 600,
                completedSaleCount: 1,
              }],
            };
          },
          async updateReportUnitCost() {
            attempts += 1;
            throw new Error("The corrected unit cost could not be saved. Try again.");
          },
        };
      },
    },
    confirm: () => true,
    setTimeout(callback, milliseconds) {
      actionFeedbackTimer = { callback, milliseconds };
      return 1;
    },
    clearTimeout() {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const section = document.querySelector("#unit-cost-correction-section");
  const select = document.querySelector("#unit-cost-sku");
  const input = document.querySelector("#unit-cost-value");
  const button = document.querySelector("#update-unit-cost");
  input.value = "7.25";
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 1);
  assert.equal(section.hidden, false);
  assert.equal(section.attributes.get("aria-busy"), "false");
  assert.equal(select.value, "SKU-A");
  assert.equal(input.value, "7.25");
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);
  assert.equal(
    document.querySelector("#unit-cost-feedback").textContent,
    "The corrected unit cost could not be saved. Try again.",
  );
  assert.equal(
    document.querySelector("#unit-cost-feedback").className,
    "unit-cost-feedback is-error",
  );
  assert.equal(actionFeedbackTimer.milliseconds, 4_000);
  assert.equal(
    document.querySelector("#action-feedback").textContent,
    "The corrected unit cost could not be saved. Try again.",
  );

  actionFeedbackTimer.callback();
  assert.equal(document.querySelector("#action-feedback").textContent, "");
  assert.equal(
    document.querySelector("#unit-cost-feedback").textContent,
    "The corrected unit cost could not be saved. Try again.",
  );
  assert.equal(
    document.querySelector("#unit-cost-feedback").className,
    "unit-cost-feedback is-error",
  );
});

test("report payment correction confirms, saves, refreshes totals, and removes the resolved row", async () => {
  const document = new FakeDocument();
  const confirmations = [];
  const resolutions = [];
  const correctionLoads = [];
  let finishResolution;
  const resolutionGate = new Promise((resolve) => {
    finishResolution = resolve;
  });
  let unresolvedOrders = [
    {
      variationNumber: 220,
      observedPaymentStatus: "payment_failed",
      mapped: true,
      sku: "SKU-A",
      item: "Example tee",
      style: "black",
      size: "L",
    },
  ];
  const originalReport = createReport();
  const updatedReport = createReport({
    totals: {
      ...originalReport.totals,
      completedPaymentCount: 3,
      totalSalesCount: 3,
      completedGmvCents: 4325,
      paymentFixingCount: 0,
    },
  });

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: originalReport,
            };
          },
          async listPaymentFixingOrders() {
            return { reportId: REPORT_ID, orders: unresolvedOrders };
          },
          async resolvePaymentFixingOrder(options) {
            resolutions.push(options);
            await resolutionGate;
            unresolvedOrders = [];
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: updatedReport,
            };
          },
        };
      },
    },
    inlineCorrectionModule: createCorrectionLoadRecorder(correctionLoads),
    confirm(message) {
      confirmations.push(message);
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const row = document.querySelector("#payment-resolution-orders").children[0];
  row.children[1].children[1].value = "18.25";
  row.children[2].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    document
      .querySelector("#payment-resolution-section")
      .attributes.get("aria-busy"),
    "true",
  );
  assert.equal(row.children[1].children[1].disabled, true);
  assert.equal(row.children[2].disabled, true);
  assert.equal(row.children[3].disabled, true);

  finishResolution();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resolutions, [
    {
      reportId: REPORT_ID,
      variationNumber: 220,
      resolution: "payment_complete",
      soldPriceCents: 1825,
    },
  ]);
  assert.deepEqual(correctionLoads, [
    { reportId: REPORT_ID, options: {} },
    { reportId: REPORT_ID, options: { preserveDraft: true } },
  ]);
  assert.match(
    confirmations[0],
    /variation #220 Payment complete at \$18\.25[\s\S]*permanently updates/,
  );
  assert.equal(document.querySelector("#payment-resolution-section").hidden, true);
  assert.match(
    document.querySelector("#action-feedback").textContent,
    /Report totals and inventory were updated/,
  );
  assert.match(allText(document.querySelector("#summary-grid")), /\$43\.25/);
});

test("report payment cancellation confirms, refreshes inventory, and removes the resolved row", async () => {
  const document = new FakeDocument();
  const confirmations = [];
  const resolutions = [];
  let unresolvedOrders = [
    {
      variationNumber: 220,
      observedPaymentStatus: "payment_failed",
      mapped: true,
      sku: "SKU-A",
      item: "Example tee",
      style: "black",
      size: "L",
    },
  ];
  const originalReport = createReport();
  const updatedReport = createReport({
    totals: {
      ...originalReport.totals,
      canceledOrderCount: originalReport.totals.canceledOrderCount + 1,
      paymentFixingCount: 0,
    },
    canceledOrders: [
      ...originalReport.canceledOrders,
      {
        variationNumber: 220,
        mapped: true,
        sku: "SKU-A",
        item: "Example tee",
        style: "black",
        size: "L",
      },
    ],
    inventory: originalReport.inventory.map((entry) => ({
      ...entry,
      pendingQuantity: 0,
    })),
  });

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: originalReport,
            };
          },
          async listPaymentFixingOrders() {
            return { reportId: REPORT_ID, orders: unresolvedOrders };
          },
          async resolvePaymentFixingOrder(options) {
            resolutions.push(options);
            unresolvedOrders = [];
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: updatedReport,
            };
          },
        };
      },
    },
    confirm(message) {
      confirmations.push(message);
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const row = document.querySelector("#payment-resolution-orders").children[0];
  row.children[3].click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resolutions, [
    {
      reportId: REPORT_ID,
      variationNumber: 220,
      resolution: "canceled",
      soldPriceCents: null,
    },
  ]);
  assert.match(
    confirmations[0],
    /variation #220 canceled[\s\S]*releases its inventory reservation/,
  );
  assert.equal(document.querySelector("#payment-resolution-section").hidden, true);
  assert.equal(
    document.querySelector("#inventory-rows").children[0].children[7].textContent,
    "0",
  );
  assert.match(
    document.querySelector("#action-feedback").textContent,
    /marked canceled[\s\S]*Report totals and inventory were updated/,
  );
  assert.equal(document.querySelector("#sales-count").textContent, "4 variations");
  const variationRows = document.querySelector("#completed-sales-rows").children;
  assert.deepEqual(
    variationRows.at(-1).children.map((cell) => cell.textContent),
    ["#220", "Canceled", "SKU-A", "Example tee", "black", "L", "—", "—", "—"],
  );
});

test("failed report payment correction preserves the row and input for retry", async () => {
  const document = new FakeDocument();
  const order = {
    variationNumber: 220,
    observedPaymentStatus: "payment_failed",
    mapped: true,
    sku: "SKU-A",
    item: "Example tee",
    style: "black",
    size: "L",
  };
  let resolutionAttempts = 0;

  reportPage.mountStreamReportPage({
    document,
    location: { search: `?reportId=${encodeURIComponent(REPORT_ID)}` },
    navigator: {},
    runtime: {},
    protocol,
    reportModule: {
      hydrateStreamReport(report) {
        return report;
      },
    },
    clientModule: {
      createStreamReportClient() {
        return {
          async getReport() {
            return {
              reportId: REPORT_ID,
              lifecycleStatus: "finalized",
              report: createReport(),
            };
          },
          async listPaymentFixingOrders() {
            return { reportId: REPORT_ID, orders: [order] };
          },
          async resolvePaymentFixingOrder() {
            resolutionAttempts += 1;
            throw new Error("The corrected report could not be saved. Try again.");
          },
        };
      },
    },
    confirm() {
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const section = document.querySelector("#payment-resolution-section");
  const orders = document.querySelector("#payment-resolution-orders");
  const row = orders.children[0];
  const priceInput = row.children[1].children[1];
  const completeButton = row.children[2];
  const cancelButton = row.children[3];
  priceInput.value = "19.50";
  completeButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(resolutionAttempts, 1);
  assert.equal(section.hidden, false);
  assert.equal(section.attributes.get("aria-busy"), "false");
  assert.equal(orders.children.length, 1);
  assert.equal(priceInput.value, "19.50");
  assert.equal(priceInput.disabled, false);
  assert.equal(completeButton.disabled, false);
  assert.equal(cancelButton.disabled, false);
  assert.equal(
    document.querySelector("#payment-resolution-feedback").textContent,
    "The corrected report could not be saved. Try again.",
  );
  assert.equal(
    document.querySelector("#payment-resolution-feedback").className,
    "resolution-feedback is-error",
  );
  assert.equal(
    document.querySelector("#action-feedback").textContent,
    "The corrected report could not be saved. Try again.",
  );
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

test("post-stream payment-error metric uses the renamed aggregate label", () => {
  const report = createReport();
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      ...report.totals,
      paymentFixingCount: 6,
    },
  }));
  const metric = metrics.find((entry) => entry.label === "Payment errors");

  assert.deepEqual(metric, {
    label: "Payment errors",
    value: "6",
    note: "Still inside the payment buffer",
  });
  assert.equal(
    metrics.some((entry) => entry.label === "Payment fixing"),
    false,
  );
});

test("post-stream average profit per sale uses mapped completed sales", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 4,
      committedSalesCount: 3,
      totalSalesCount: 5,
      completedGmvCents: 5000,
      committedRevenueCents: 4000,
      grossProfitCents: 1000,
      unmappedCompletedCount: 1,
      canceledOrderCount: 1,
      paymentFixingCount: 0,
      attributedGmvDisplay: "$50.00",
    },
  }));
  const metric = metrics.find(
    (entry) => entry.label === "Avg. Profit per Sale",
  );

  assert.deepEqual(metric, {
    label: "Avg. Profit per Sale",
    value: "$3.33",
    note: "Gross profit per mapped completed sale",
  });
});

test("post-stream average profit per sale handles losses and no mapped sales", () => {
  const lossMetric = reportPage.createSummaryMetrics(createReport({
    totals: {
      committedSalesCount: 2,
      grossProfitCents: -901,
    },
  })).find((entry) => entry.label === "Avg. Profit per Sale");
  const emptyMetric = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 2,
      committedSalesCount: 0,
      grossProfitCents: 0,
      unmappedCompletedCount: 2,
    },
  })).find((entry) => entry.label === "Avg. Profit per Sale");

  assert.equal(lossMetric.value, "-$4.51");
  assert.equal(emptyMetric.value, "$0.00");
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

test("post-stream estimated profit after fees uses unrounded 94% GMV minus mapped COGS", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 3,
      totalSalesCount: 3,
      completedGmvCents: 620000,
      costOfGoodsCents: 32000,
      grossProfitCents: 588000,
      unmappedCompletedCount: 0,
      canceledOrderCount: 0,
      paymentFixingCount: 0,
      attributedGmvDisplay: "$6.83K",
    },
  }));
  const metric = metrics.find(
    (entry) => entry.label === "Est. Profit After Fees",
  );

  assert.deepEqual(metric, {
    label: "Est. Profit After Fees",
    value: "≈$6,100",
    note: "Total GMV after 6% fee, minus mapped item costs",
    warning: false,
  });
});

test("post-stream estimated profit after fees shows incomplete counts and permits a loss", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 2,
      totalSalesCount: 2,
      completedGmvCents: 1000,
      costOfGoodsCents: 2000,
      grossProfitCents: -1000,
      unmappedCompletedCount: 2,
      canceledOrderCount: 0,
      paymentFixingCount: 0,
      attributedGmvDisplay: "$10.00",
    },
  }));
  const metric = metrics.find(
    (entry) => entry.label === "Est. Profit After Fees",
  );

  assert.deepEqual(metric, {
    label: "Est. Profit After Fees",
    value: "≈-$11",
    note: "Incomplete — 2 completed sales still need inventory items.",
    warning: true,
  });
});

test("post-stream estimated profit after fees displays an em dash without Total GMV", () => {
  const metrics = reportPage.createSummaryMetrics(createReport({
    totals: {
      completedPaymentCount: 0,
      totalSalesCount: 0,
      completedGmvCents: 0,
      costOfGoodsCents: 0,
      grossProfitCents: 0,
      unmappedCompletedCount: 0,
      canceledOrderCount: 0,
      paymentFixingCount: 0,
      attributedGmvDisplay: null,
    },
  }));
  const metric = metrics.find(
    (entry) => entry.label === "Est. Profit After Fees",
  );

  assert.equal(metric.value, "—");
});

test("inventory payloads use the exact six columns, retain zero, and omit unrelated secrets", () => {
  const report = createReport();
  const tsv = reportPage.serializeInventoryTsv(report);
  const csv = reportPage.serializeInventoryCsv(report);
  const expectedHeader =
    "sku\titem\tstyle\tsize\tquantity_on_hand_at_import\tunit_cost";

  assert.equal(tsv.split("\n")[0], expectedHeader);
  assert.equal(reportPage.SHEET_HEADERS.length, 6);
  assert.deepEqual(reportPage.SHEET_HEADERS, [
    "sku",
    "item",
    "style",
    "size",
    "quantity_on_hand_at_import",
    "unit_cost",
  ]);
  assert.ok(tsv.split("\n").every((row) => row.split("\t").length === 6));
  assert.ok(
    csv
      .split("\r\n")
      .every(
        (row) =>
          row.match(/(?:^|,)(?:"(?:[^"]|"")*"|[^,]*)/g).length === 6,
      ),
  );
  assert.match(tsv, /SKU-A[^\n]*\t0\t6\.00/);
  assert.match(csv, /quantity_on_hand_at_import/);

  for (const secret of [
    report.oauthToken,
    report.sourceSheetUrl,
    report.buyerName,
  ]) {
    assert.equal(tsv.includes(secret), false);
    assert.equal(csv.includes(secret), false);
  }
});

test("long inventory renders every row in the updated inventory table", () => {
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

  const rows = document.querySelector("#inventory-rows").children;
  assert.equal(rows.length, 1000);
  assert.ok(
    rows.every(
      (row) => row.children.length === 9 && row.children[4].textContent === "$1.00",
    ),
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
                  displayName: "Sunday evening stream",
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
            displayName: "Sunday evening stream",
            report,
          },
        };
      },
    },
  });

  const listing = await client.listReports();
  const record = await client.getReport({ reportId: REPORT_ID });

  assert.equal(listing.reports[0].reportId, REPORT_ID);
  assert.equal(listing.reports[0].displayName, "Sunday evening stream");
  assert.equal(record.displayName, "Sunday evening stream");
  assert.deepEqual(record.report, report);
  assert.equal(sent[0].channel, protocol.MESSAGE_CHANNEL);
  assert.equal(sent[0].version, protocol.MESSAGE_VERSION);
  assert.deepEqual(sent[1].command, {
    type: protocol.COMMAND_TYPES.GET_REPORT,
    reportId: REPORT_ID,
  });
});

test("stream report client strictly lists and resolves post-stream payment-fixing orders", async () => {
  const sentCommands = [];
  const report = createReport();
  const orders = [
    {
      variationNumber: 220,
      observedPaymentStatus: "payment_failed",
      mapped: true,
      sku: "SKU-A",
      item: "Example tee",
      style: "",
      size: "L",
    },
    {
      variationNumber: 221,
      observedPaymentStatus: "payment_fixing",
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
    {
      variationNumber: 222,
      observedPaymentStatus: "payment_processing",
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
    {
      variationNumber: 223,
      observedPaymentStatus: "order_processing",
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
  ];
  const client = createClient({
    runtime: {
      async sendMessage(message) {
        sentCommands.push(message.command);

        if (
          message.command.type ===
          protocol.COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS
        ) {
          return { ok: true, data: { reportId: REPORT_ID, orders } };
        }

        return {
          ok: true,
          data: {
            reportId: REPORT_ID,
            lifecycleStatus: "finalized",
            displayName: null,
            report,
          },
        };
      },
    },
  });

  assert.deepEqual(
    await client.listPaymentFixingOrders({ reportId: REPORT_ID }),
    { reportId: REPORT_ID, orders },
  );
  assert.deepEqual(
    await client.resolvePaymentFixingOrder({
      reportId: REPORT_ID,
      variationNumber: 220,
      resolution: "payment_complete",
      soldPriceCents: 1825,
    }),
    {
      reportId: REPORT_ID,
      lifecycleStatus: "finalized",
      displayName: null,
      report,
    },
  );
  assert.deepEqual(sentCommands, [
    {
      type: protocol.COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS,
      reportId: REPORT_ID,
    },
    {
      type: protocol.COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER,
      reportId: REPORT_ID,
      variationNumber: 220,
      resolution: "payment_complete",
      soldPriceCents: 1825,
    },
  ]);

  await assert.rejects(
    client.resolvePaymentFixingOrder({
      reportId: REPORT_ID,
      variationNumber: 220,
      resolution: "payment_complete",
      soldPriceCents: null,
    }),
    (error) => error.code === "INVALID_CLIENT_COMMAND",
  );
  await assert.rejects(
    client.resolvePaymentFixingOrder({
      reportId: REPORT_ID,
      variationNumber: 220,
      resolution: "canceled",
      soldPriceCents: 1825,
    }),
    (error) => error.code === "INVALID_CLIENT_COMMAND",
  );
});

test("stream report client rejects terminal payment statuses in unresolved-order responses", async () => {
  const client = createClient({
    runtime: {
      async sendMessage() {
        return {
          ok: true,
          data: {
            reportId: REPORT_ID,
            orders: [
              {
                variationNumber: 220,
                observedPaymentStatus: "payment_complete",
                mapped: false,
                sku: null,
                item: null,
                style: null,
                size: null,
              },
            ],
          },
        };
      },
    },
  });

  await assert.rejects(
    client.listPaymentFixingOrders({ reportId: REPORT_ID }),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("stream report client strictly lists and updates report unit costs", async () => {
  const sentCommands = [];
  const report = createReport();
  const skus = [
    {
      sku: "SKU-A",
      item: "Example tee",
      style: "black",
      size: "L",
      unitCostCents: 600,
      completedSaleCount: 2,
    },
    {
      sku: "SKU-UNSOLD",
      item: "Unsold tee",
      style: "",
      size: "OS",
      unitCostCents: 0,
      completedSaleCount: 0,
    },
  ];
  const client = createClient({
    runtime: {
      async sendMessage(message) {
        sentCommands.push(message.command);

        if (
          message.command.type ===
          protocol.COMMAND_TYPES.LIST_REPORT_UNIT_COSTS
        ) {
          return { ok: true, data: { reportId: REPORT_ID, skus } };
        }

        return {
          ok: true,
          data: {
            reportId: REPORT_ID,
            lifecycleStatus: "finalized",
            displayName: null,
            report,
          },
        };
      },
    },
  });

  assert.deepEqual(
    await client.listReportUnitCosts({ reportId: REPORT_ID }),
    { reportId: REPORT_ID, skus },
  );
  assert.deepEqual(
    await client.updateReportUnitCost({
      reportId: REPORT_ID,
      sku: "SKU-UNSOLD",
      unitCostCents: 0,
    }),
    {
      reportId: REPORT_ID,
      lifecycleStatus: "finalized",
      displayName: null,
      report,
    },
  );
  assert.deepEqual(sentCommands, [
    {
      type: protocol.COMMAND_TYPES.LIST_REPORT_UNIT_COSTS,
      reportId: REPORT_ID,
    },
    {
      type: protocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
      reportId: REPORT_ID,
      sku: "SKU-UNSOLD",
      unitCostCents: 0,
    },
  ]);

  for (const invalid of [
    { reportId: REPORT_ID, sku: "", unitCostCents: 0 },
    { reportId: REPORT_ID, sku: " SKU-A", unitCostCents: 0 },
    { reportId: REPORT_ID, sku: "SKU-A", unitCostCents: -1 },
    { reportId: REPORT_ID, sku: "SKU-A", unitCostCents: 1.5 },
  ]) {
    await assert.rejects(
      client.updateReportUnitCost(invalid),
      (error) => error.code === "INVALID_CLIENT_COMMAND",
    );
  }
});

test("stream report client rejects duplicate or malformed report unit-cost rows", async () => {
  const valid = {
    sku: "SKU-A",
    item: "Example tee",
    style: "black",
    size: "L",
    unitCostCents: 600,
    completedSaleCount: 1,
  };
  const responses = [
    [valid, { ...valid }],
    [{ ...valid, unitCostCents: -1 }],
    [{ ...valid, completedSaleCount: -1 }],
    [{ ...valid, unexpected: true }],
  ];

  for (const skus of responses) {
    const client = createClient({
      runtime: {
        async sendMessage() {
          return { ok: true, data: { reportId: REPORT_ID, skus } };
        },
      },
    });
    await assert.rejects(
      client.listReportUnitCosts({ reportId: REPORT_ID }),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
});

test("stream report client lists archived reports and strictly echoes archive mutations", async () => {
  const sentCommands = [];
  const summary = {
    reportId: REPORT_ID,
    displayName: null,
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

test("stream report client strictly renames a report and can restore its default name", async () => {
  const sentCommands = [];
  const client = createClient({
    runtime: {
      async sendMessage(message) {
        sentCommands.push(message.command);
        return {
          ok: true,
          data: {
            reportId: message.command.reportId,
            displayName: message.command.displayName,
          },
        };
      },
    },
  });

  assert.deepEqual(
    await client.renameReport({
      reportId: REPORT_ID,
      displayName: "Sunday evening stream",
    }),
    { reportId: REPORT_ID, displayName: "Sunday evening stream" },
  );
  assert.deepEqual(
    await client.renameReport({ reportId: REPORT_ID, displayName: null }),
    { reportId: REPORT_ID, displayName: null },
  );
  assert.deepEqual(sentCommands, [
    {
      type: protocol.COMMAND_TYPES.RENAME_REPORT,
      reportId: REPORT_ID,
      displayName: "Sunday evening stream",
    },
    {
      type: protocol.COMMAND_TYPES.RENAME_REPORT,
      reportId: REPORT_ID,
      displayName: null,
    },
  ]);

  const deliveryCount = sentCommands.length;
  for (const invalid of [
    { reportId: REPORT_ID, displayName: "" },
    { reportId: REPORT_ID, displayName: " padded" },
    { reportId: REPORT_ID, displayName: "line\nbreak" },
    {
      reportId: REPORT_ID,
      displayName: "x".repeat(protocol.MAX_REPORT_DISPLAY_NAME_LENGTH + 1),
    },
    { reportId: "not-a-report", displayName: "Valid name" },
  ]) {
    await assert.rejects(
      client.renameReport(invalid),
      (error) => error.code === "INVALID_CLIENT_COMMAND",
    );
  }
  assert.equal(sentCommands.length, deliveryCount);

  const alteredResponseClient = createClient({
    runtime: {
      async sendMessage() {
        return {
          ok: true,
          data: { reportId: REPORT_ID, displayName: "Altered name" },
        };
      },
    },
  });
  await assert.rejects(
    alteredResponseClient.renameReport({
      reportId: REPORT_ID,
      displayName: "Requested name",
    }),
    (error) => error.code === "INVALID_RESPONSE",
  );
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
      displayName: null,
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
            displayName: null,
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
