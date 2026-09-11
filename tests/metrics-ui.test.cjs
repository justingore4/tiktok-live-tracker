const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const {
  createPersistentTaggerController,
} = require("../extension/tagger/persistent-tagger-controller.js");

const STREAM_ID = "metrics-stream";
const INVENTORY = Object.freeze([
  Object.freeze({
    sku: "STUSSY-TEE-BLACK-L",
    item: "Stussy tee",
    style: "black",
    size: "L",
    quantityReceived: 5,
    unitCostCents: 1200,
  }),
]);
const CANONICAL_INVENTORY = INVENTORY.map((entry) => ({
  sku: entry.sku,
  item: entry.item,
  style: entry.style,
  size: entry.size,
  quantityOnHandAtImport: entry.quantityReceived,
  unitCostCents: entry.unitCostCents,
}));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPinnedState() {
  const state = reconciliation.createReconciliationState(
    CANONICAL_INVENTORY,
  );

  reconciliation.pinStreamToInventoryBaseline(state, {
    streamId: STREAM_ID,
  });
  return state;
}

function observeStatus(state, variationNumber, observedPaymentStatus) {
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [{ variationNumber, observedPaymentStatus }],
  });
}

function createReadClient(readState) {
  const read = async () => ({ state: clone(readState()), result: null });

  return {
    getState: read,
    initializeState: read,
    mapVariation: read,
    unmapVariation: read,
  };
}

test("side panel exposes bottom performance metrics and renders their values", () => {
  const taggerDirectory = path.join(__dirname, "..", "extension", "tagger");
  const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(taggerDirectory, "sidepanel.css"), "utf8");
  const source = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
  const inventoryPosition = html.indexOf('class="inventory-section"');
  const metricsPosition = html.indexOf('id="metrics-section"');
  const footerPosition = html.indexOf('class="app-footer"');
  const metricsSection = html.match(
    /<section[^>]+id="metrics-section"[\s\S]*?<\/section>/,
  )?.[0];

  assert.ok(metricsSection, "the side panel must contain a Metrics section");
  assert.ok(
    inventoryPosition < metricsPosition && metricsPosition < footerPosition,
    "Metrics must appear after Inventory and before the footer",
  );
  assert.match(
    css,
    /\.tracker-workspace\s*\+\s*\.stream-session-panel\s*\{[\s\S]*?margin-top:\s*14px;/,
    "the reordered stream controls must keep the standard section gap below Metrics",
  );
  assert.match(
    metricsSection,
    /aria-labelledby="metrics-title"/,
  );
  assert.match(metricsSection, /id="metrics-title"[^>]*>Performance Metrics</);
  assert.match(metricsSection, />\s*Gross Item Sales\s*</);
  assert.match(metricsSection, />\s*AOV\s*</);
  assert.match(metricsSection, />\s*Total GMV\s*</);
  assert.match(metricsSection, />\s*TikTok 6% Fees\s*</);
  assert.match(metricsSection, />\s*Fees paid:\s*</);
  assert.match(metricsSection, />\s*GMV after fees:\s*</);
  assert.match(metricsSection, />\s*Completed Sales\/Total Sales\s*</);
  assert.match(metricsSection, />\s*Canceled Orders:\s*</);
  assert.match(metricsSection, />\s*Payment Errors:\s*</);
  assert.match(
    metricsSection,
    /class="metric-title-with-description"[\s\S]*?>\s*Gross Profits\s*<[\s\S]*?class="metric-description">Mapped completed revenue - unit costs<\//,
  );
  assert.match(
    metricsSection,
    /class="metric-title-with-description"[\s\S]*?>\s*Est\. Profit After Fees\s*<[\s\S]*?class="metric-description">GMV post 6% fee - COGS<\//,
  );
  assert.match(
    metricsSection,
    /class="metric-title-with-description"[\s\S]*?>\s*Mapped Gross Margin\s*<[\s\S]*?class="metric-description">Gross profit divided by mapped revenue<\//,
  );
  assert.match(metricsSection, /id="revenue-value"[^>]*>\$0\.00</);
  assert.match(metricsSection, /id="aov-value"[^>]*>\$0\.00</);
  assert.match(metricsSection, /id="total-gmv-value"[^>]*>&mdash;</);
  assert.match(metricsSection, /id="fees-paid-value"[^>]*[\s\S]*?>&mdash;</);
  assert.match(
    metricsSection,
    /id="gmv-after-fees-value"[^>]*[\s\S]*?>&mdash;</,
  );
  assert.match(metricsSection, /id="completed-sales-value"[^>]*>0\/0</);
  assert.match(metricsSection, /id="canceled-orders-value"[^>]*>0</);
  assert.match(metricsSection, /id="payment-fixing-value"[^>]*>0</);
  assert.match(
    metricsSection,
    /id="gross-profit-value"[\s\S]*?aria-describedby="gross-profit-warning"[\s\S]*?>\$0\.00</,
  );
  assert.match(
    metricsSection,
    /id="gross-profit-warning"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"[\s\S]*?hidden/,
  );
  assert.match(
    metricsSection,
    /id="estimated-profit-after-fees-value"[\s\S]*?aria-describedby="estimated-profit-after-fees-warning"[\s\S]*?>&mdash;</,
  );
  assert.match(
    metricsSection,
    /id="estimated-profit-after-fees-warning"[\s\S]*?class="metric-warning"[\s\S]*?hidden/,
  );
  assert.match(
    metricsSection,
    /id="mapped-gross-margin-value"[^>]*>&mdash;</,
  );
  assert.equal(
    [
      ...metricsSection.matchAll(
        /class="metric-card(?:\s+metric-card-(?:fees|order-status|profit))?"/g,
      ),
    ].length,
    9,
    "the Metrics section must preserve its existing cards and include mapped gross margin",
  );

  assert.match(
    source,
    /const grossItemSalesValue = document\.querySelector\("#revenue-value"\)/,
  );
  assert.match(
    source,
    /const averageOrderValue = document\.querySelector\("#aov-value"\)/,
  );
  assert.match(
    source,
    /const totalGmvValue = document\.querySelector\("#total-gmv-value"\)/,
  );
  assert.match(
    source,
    /const feesPaidValue = document\.querySelector\("#fees-paid-value"\)/,
  );
  assert.match(
    source,
    /const gmvAfterFeesValue = document\.querySelector\([\s\S]*?"#gmv-after-fees-value"/,
  );
  assert.match(
    source,
    /const tiktokFeeCalculator\s*=\s*[\s\S]*?TikTokLiveTrackerTikTokFeeCalculator/,
  );
  assert.match(
    source,
    /const completedSalesValue = document\.querySelector\([\s\S]*?"#completed-sales-value"/,
  );
  assert.match(
    source,
    /const canceledOrdersValue = document\.querySelector\([\s\S]*?"#canceled-orders-value"/,
  );
  assert.match(
    source,
    /const paymentFixingValue = document\.querySelector\([\s\S]*?"#payment-fixing-value"/,
  );
  assert.match(
    source,
    /const grossProfitValue = document\.querySelector\("#gross-profit-value"\)/,
  );
  assert.match(
    source,
    /const grossProfitWarning = document\.querySelector\([\s\S]*?"#gross-profit-warning"/,
  );
  assert.match(
    source,
    /const mappedGrossMarginValue = document\.querySelector\([\s\S]*?"#mapped-gross-margin-value"/,
  );
  assert.match(
    source,
    /const estimatedProfitAfterFeesValue = document\.querySelector\([\s\S]*?"#estimated-profit-after-fees-value"/,
  );
  assert.match(
    source,
    /const estimatedProfitAfterFeesWarning = document\.querySelector\([\s\S]*?"#estimated-profit-after-fees-warning"/,
  );
  assert.match(
    source,
    /function renderMetrics\(view\)\s*{[\s\S]*?viewModel\.formatUsdCents\([\s\S]*?view\.totals\.completedGmvCents[\s\S]*?view\.totals\.profitCents[\s\S]*?view\.totals\.attributedGmvDisplay[\s\S]*?view\.totals\.unmappedCompletedCount[\s\S]*?}/,
  );
  assert.match(
    source,
    /function renderMetrics\(view\)\s*{[\s\S]*?calculateAverageOrderValueCents\([\s\S]*?view\.totals\.completedGmvCents,[\s\S]*?view\.totals\.completedPaymentCount[\s\S]*?averageOrderValue\.textContent\s*=\s*formattedAverageOrderValue/,
    "AOV must use Gross Item Sales divided by completed payments",
  );
  assert.match(
    source,
    /function renderMetrics\(view\)\s*{[\s\S]*?calculateSixPercentGmvFees\(attributedGmvDisplay\)[\s\S]*?feesPaidValue\.textContent\s*=\s*formattedFeesPaid[\s\S]*?gmvAfterFeesValue\.textContent\s*=\s*formattedGmvAfterFees/,
    "the live card must render the shared Total GMV fee calculation",
  );
  assert.match(
    source,
    /formattedFeesPaid\s*=\s*tiktokFeeMetrics\?\.feesPaidDisplay\s*\?\?\s*"—"/,
    "missing Total GMV must leave the live fee value unavailable",
  );
  assert.match(
    source,
    /formattedGmvAfterFees\s*=\s*[\s\S]*?gmvAfterFeesDisplay\s*\?\?\s*"—"/,
    "missing Total GMV must leave the live after-fee value unavailable",
  );
  assert.match(
    source,
    /calculateEstimatedProfitAfterFees\([\s\S]*?attributedGmvDisplay,[\s\S]*?view\.totals\.costOfGoodsCents[\s\S]*?estimatedProfitAfterFeesValue\.textContent\s*=[\s\S]*?formattedEstimatedProfitAfterFees/,
    "estimated profit after fees must use Total GMV and completed mapped-sale unit costs",
  );
  assert.match(
    source,
    /formattedEstimatedProfitAfterFees\s*=\s*[\s\S]*?estimatedProfitAfterFees\s*\?\?\s*"—"/,
    "missing Total GMV must leave estimated profit after fees unavailable",
  );
  assert.match(
    source,
    /formatGrossMarginPercentage\([\s\S]*?view\.totals\.profitCents,[\s\S]*?view\.totals\.committedRevenueCents[\s\S]*?mappedGrossMarginValue\.textContent\s*=\s*formattedMappedGrossMargin/,
    "mapped gross margin must use gross profit divided by mapped completed-sale revenue",
  );
  assert.match(
    source,
    /function renderMetrics\(view\)\s*{[\s\S]*?completedPaymentCount\s*=\s*view\.totals\.completedPaymentCount[\s\S]*?totalSalesCount\s*=\s*view\.totals\.totalSalesCount[\s\S]*?completedSalesRatio\s*=\s*`\$\{completedPaymentCount\}\/\$\{totalSalesCount\}`[\s\S]*?completedSalesValue\.textContent\s*=\s*completedSalesRatio/,
  );
  assert.match(
    source,
    /function renderMetrics\(view\)\s*{[\s\S]*?canceledOrderCount\s*=\s*Number\.isSafeInteger\([\s\S]*?view\.totals\.canceledOrderCount[\s\S]*?canceledOrdersDisplay\s*=\s*String\(canceledOrderCount\)[\s\S]*?canceledOrdersValue\.textContent\s*=\s*canceledOrdersDisplay/,
    "the card must render the canonical canceled-order total as a whole number",
  );
  assert.match(
    source,
    /function renderMetrics\(view\)\s*{[\s\S]*?paymentFixingCount\s*=\s*Number\.isSafeInteger\([\s\S]*?view\.totals\.paymentFixingCount[\s\S]*?paymentFixingDisplay\s*=\s*String\(paymentFixingCount\)[\s\S]*?paymentFixingValue\.textContent\s*=\s*paymentFixingDisplay/,
    "the card must render the canonical payment-error total as a whole number",
  );
  assert.match(
    metricsSection,
    /class="metric-card metric-card-order-status"[\s\S]*?<dt id="canceled-orders-label">Canceled Orders:<\/dt>[\s\S]*?id="canceled-orders-value"[\s\S]*?aria-labelledby="canceled-orders-label"[\s\S]*?<dt id="payment-fixing-label">Payment Errors:<\/dt>[\s\S]*?id="payment-fixing-value"[\s\S]*?aria-labelledby="payment-fixing-label"/,
    "the order-status card must keep both inline counts semantically labeled",
  );
  assert.match(
    css,
    /\.metric-card-order-status\s*{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;[\s\S]*?row-gap:\s*12px;/,
    "the two order-status values must remain compact, inline, and responsive",
  );
  assert.match(
    css,
    /\.metric-fee-row\s*{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;/,
    "the two fee rows must wrap safely in narrow metric cards",
  );
  assert.match(
    source,
    /Incomplete — 1 completed sale still needs an inventory item\./,
  );
  assert.match(
    source,
    /Incomplete — \$\{unmatchedCompletedCount} completed sales still need inventory items\./,
  );
  assert.match(
    source,
    /unmatchedCompletedCount > 0[\s\S]*?grossProfitWarning\.hidden = false[\s\S]*?grossProfitWarning\.hidden = true/,
  );
  assert.match(
    source,
    /unmatchedCompletedCount > 0[\s\S]*?estimatedProfitAfterFeesWarning\.textContent = warning[\s\S]*?estimatedProfitAfterFeesWarning\.hidden = false[\s\S]*?estimatedProfitAfterFeesWarning\.hidden = true[\s\S]*?estimatedProfitAfterFeesWarning\.textContent = ""/,
    "estimated profit after fees must share the accessible incomplete-cost warning",
  );
  assert.match(
    css,
    /\.metric-profit-content\s*>\s*span\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/,
    "profit values must wrap safely instead of overflowing narrow metric cards",
  );
  assert.match(
    css,
    /\.metric-description\s*\{[\s\S]*?display:\s*block;[\s\S]*?font-size:\s*10px;[\s\S]*?overflow-wrap:\s*anywhere;/,
    "the estimated-profit description must stay compact and wrap safely",
  );
  assert.match(
    css,
    /\.metric-warning\s*{[\s\S]*?font-size:\s*10px;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(
    source,
    /function renderAll\(options = {}\)[\s\S]*?renderMetrics\(view\)/,
  );
});

test("performance metrics has one compact heading with the Inventory typography", () => {
  const taggerDirectory = path.join(__dirname, "..", "extension", "tagger");
  const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(taggerDirectory, "sidepanel.css"), "utf8");
  const metricsSection = html.match(
    /<section[^>]+id="metrics-section"[\s\S]*?<\/section>/,
  )?.[0];
  const sharedHeadingStyle = css.match(/\.section-heading h2\s*\{([^}]+)\}/)?.[1];
  const metricsHeadingStyle = css.match(/\.metrics-heading h2\s*\{([^}]+)\}/)?.[1];
  const inventoryHeadingStyle = css.match(
    /\.inventory-heading-label h2\s*\{([^}]+)\}/,
  )?.[1];

  assert.ok(metricsSection);
  assert.match(
    metricsSection,
    /<div class="section-heading metrics-heading">\s*<h2 id="metrics-title">Performance Metrics<\/h2>\s*<\/div>\s*<dl class="metrics-grid">/,
    "one semantic heading must sit immediately above the unchanged metric grid",
  );
  assert.equal([...metricsSection.matchAll(/<h2\b/g)].length, 1);
  assert.doesNotMatch(metricsSection, /class="eyebrow"|>\s*Performance\s*<|>\s*Metrics\s*</);
  assert.match(html, /class="section-heading inventory-heading"[\s\S]*?<h2 id="inventory-title">Inventory<\/h2>/);
  assert.ok(sharedHeadingStyle);
  assert.match(sharedHeadingStyle, /font-size:\s*17px;/);
  assert.match(sharedHeadingStyle, /font-weight:\s*690;/);
  assert.match(sharedHeadingStyle, /letter-spacing:\s*-0\.025em;/);
  for (const style of [metricsHeadingStyle, inventoryHeadingStyle]) {
    assert.ok(style);
    assert.doesNotMatch(
      style,
      /(?:font(?:-[\w-]+)?|color|letter-spacing):/,
      "both headings must retain shared typography and inherited text color",
    );
    assert.match(style, /min-width:\s*0;/);
    assert.match(style, /overflow-wrap:\s*anywhere;/);
  }
  assert.match(css, /\.metrics-section\s*\{\s*padding-top:\s*14px;\s*\}/);
  assert.match(css, /\.section-heading\.metrics-heading\s*\{\s*margin-bottom:\s*8px;\s*\}/);
  assert.match(css, /\.metrics-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(150px, 1fr\)\);[^}]*gap:\s*10px;/);
  assert.match(css, /\.metric-card\s*\{[^}]*min-height:\s*120px;[^}]*padding:\s*15px;/);
});

test("Gross Item Sales is the exact sum of unique canonical priced completed payments", () => {
  const state = createPinnedState();

  observeStatus(state, 101, "payment_processing");
  observeStatus(state, 102, "payment_fixing");
  observeStatus(state, 103, "canceled");
  observeStatus(state, 104, "payment_complete");
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 105,
    soldPriceCents: 1999,
  });
  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 106,
    sku: "STUSSY-TEE-BLACK-L",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 106,
    soldPriceCents: 4800,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 106,
    soldPriceCents: 4800,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 106,
    soldPriceCents: 5100,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "another-stream",
    variationNumber: 107,
    soldPriceCents: 9900,
  });

  const restoredState = reconciliation.hydrateReconciliationState(
    clone(state),
  );
  const session = mappingWorkflow.createMappingSession({
    inventory: INVENTORY,
    reconciliation,
    streamId: STREAM_ID,
    variationNumber: 106,
    variationNumbers: [106, 105, 104, 103, 102, 101],
    state: restoredState,
  });
  const view = session.getViewState();
  const canonicalSummary = reconciliation.calculateSummary(restoredState, {
    streamId: STREAM_ID,
  });

  assert.equal(view.totals.completedPaymentCount, 2);
  assert.deepEqual(
    canonicalSummary.auctions
      .filter(({ paymentStatus }) => paymentStatus === "payment_complete")
      .map(({ variationNumber, soldPriceCents }) => ({
        variationNumber,
        soldPriceCents,
      })),
    [
      { variationNumber: 105, soldPriceCents: 1999 },
      { variationNumber: 106, soldPriceCents: 4800 },
    ],
    "only the current stream's canonical priced completions contribute",
  );
  assert.equal(
    view.totals.completedGmvCents,
    1999 + 4800,
    "Gross Item Sales sums each canonical priced Payment complete order exactly once",
  );
  assert.equal(view.totals.completedGmvCents, 6799);
  assert.equal(view.totals.committedSalesCount, 1);
  assert.equal(view.totals.committedRevenueCents, 4800);
  assert.equal(
    view.variations.find(({ variationNumber }) => variationNumber === 105)
      .status,
    "unmapped_completed",
    "a completed payment contributes to Gross Item Sales before an item is selected",
  );
  const unpricedCompletion = canonicalSummary.auctions.find(
    ({ variationNumber }) => variationNumber === 104,
  );

  assert.equal(unpricedCompletion.observedPaymentStatus, "payment_complete");
  assert.equal(unpricedCompletion.paymentStatus, "unknown");
  assert.equal(
    unpricedCompletion.soldPriceCents,
    null,
    "an observed completion without a captured price is excluded",
  );
  assert.equal(
    view.variations.find(({ variationNumber }) => variationNumber === 106)
      .soldPriceCents,
    4800,
    "a conflicting duplicate retains the first canonical captured price",
  );
  assert.equal(
    view.variations.some(({ variationNumber }) => variationNumber === 107),
    false,
    "completed payments from another stream are excluded",
  );
});

test("saved-session refresh projects newly completed payments into Gross Item Sales", async () => {
  let savedState = createPinnedState();
  const client = createReadClient(() => savedState);
  const controller = createPersistentTaggerController({
    client,
    inventory: INVENTORY,
    mappingWorkflow,
    reconciliation,
    streamId: STREAM_ID,
    currentVariationNumber: 105,
    variationNumbers: [105, 104, 103, 102, 101],
  });

  const initial = await controller.start();

  assert.equal(initial.view.totals.completedGmvCents, 0);

  savedState = reconciliation.hydrateReconciliationState(clone(savedState));
  reconciliation.recordPaymentComplete(savedState, {
    streamId: STREAM_ID,
    variationNumber: 104,
    soldPriceCents: 3250,
  });

  const refreshed = await controller.refresh();

  assert.equal(refreshed.phase, "ready");
  assert.equal(refreshed.operation, "refresh");
  assert.equal(refreshed.view.totals.completedGmvCents, 3250);
});
