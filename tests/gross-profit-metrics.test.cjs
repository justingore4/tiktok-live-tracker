const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  createMappingSession,
} = require("../extension/tagger/mapping-workflow.js");

const STREAM_ID = "gross-profit-stream";

const INVENTORY = Object.freeze([
  Object.freeze({
    sku: "TEE-BLACK-L",
    item: "Tee",
    style: "black",
    size: "L",
    quantityReceived: 5,
    unitCostCents: 1200,
  }),
  Object.freeze({
    sku: "HOODIE-GREY-M",
    item: "Hoodie",
    style: "grey",
    size: "M",
    quantityReceived: 5,
    unitCostCents: 750,
  }),
]);

function auctionInput(variationNumber, extra = {}) {
  return {
    streamId: STREAM_ID,
    variationNumber,
    ...extra,
  };
}

function createState() {
  return reconciliation.createReconciliationState(INVENTORY);
}

test("gross profit totals only completed mapped prices minus their committed unit costs", () => {
  const state = createState();

  reconciliation.mapVariation(
    state,
    auctionInput(101, { sku: "TEE-BLACK-L" }),
  );
  reconciliation.recordPaymentComplete(
    state,
    auctionInput(101, { soldPriceCents: 5000 }),
  );

  reconciliation.mapVariation(
    state,
    auctionInput(102, { sku: "HOODIE-GREY-M" }),
  );
  reconciliation.recordPaymentComplete(
    state,
    auctionInput(102, { soldPriceCents: 2500 }),
  );

  reconciliation.mapVariation(
    state,
    auctionInput(103, { sku: "TEE-BLACK-L" }),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 103,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
    ],
  });

  reconciliation.mapVariation(
    state,
    auctionInput(104, { sku: "HOODIE-GREY-M" }),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 104,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });

  reconciliation.recordPaymentComplete(
    state,
    auctionInput(105, { soldPriceCents: 3000 }),
  );

  const summary = reconciliation.calculateSummary(state, {
    streamId: STREAM_ID,
  });

  assert.equal(summary.totals.completedPaymentCount, 3);
  assert.equal(summary.totals.completedGmvCents, 10500);
  assert.equal(summary.totals.committedSalesCount, 2);
  assert.equal(summary.totals.committedRevenueCents, 7500);
  assert.equal(summary.totals.costOfGoodsCents, 1950);
  assert.equal(summary.totals.profitCents, 5550);
  assert.equal(
    summary.totals.profitCents,
    summary.totals.committedRevenueCents -
      summary.totals.costOfGoodsCents,
  );

  assert.equal(summary.totals.unmappedCompletedCount, 1);
  assert.deepEqual(
    summary.warnings.filter(
      (warning) => warning.code === "unmapped_completed_sale",
    ),
    [
      {
        code: "unmapped_completed_sale",
        eventKey: `${STREAM_ID}:105`,
      },
    ],
  );

  const processingAuction = summary.auctions.find(
    (auction) => auction.variationNumber === 103,
  );
  const canceledAuction = summary.auctions.find(
    (auction) => auction.variationNumber === 104,
  );
  const unmappedAuction = summary.auctions.find(
    (auction) => auction.variationNumber === 105,
  );

  assert.equal(processingAuction.committed, false);
  assert.equal(processingAuction.profitCents, null);
  assert.equal(canceledAuction.committed, false);
  assert.equal(canceledAuction.profitCents, null);
  assert.equal(unmappedAuction.status, "unmapped_completed");
  assert.equal(unmappedAuction.committed, false);
  assert.equal(unmappedAuction.profitCents, null);
});

test("mapping the final completed sale makes the displayed gross profit complete and clears its accuracy warning", () => {
  const state = createState();

  reconciliation.mapVariation(
    state,
    auctionInput(201, { sku: "TEE-BLACK-L" }),
  );
  reconciliation.recordPaymentComplete(
    state,
    auctionInput(201, { soldPriceCents: 5000 }),
  );
  reconciliation.recordPaymentComplete(
    state,
    auctionInput(202, { soldPriceCents: 3000 }),
  );

  const session = createMappingSession({
    inventory: INVENTORY,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 202,
    variationNumbers: [202, 201],
  });
  const incompleteView = session.getViewState();

  assert.equal(incompleteView.totals.completedGmvCents, 8000);
  assert.equal(incompleteView.totals.committedRevenueCents, 5000);
  assert.equal(incompleteView.totals.costOfGoodsCents, 1200);
  assert.equal(incompleteView.totals.profitCents, 3800);
  assert.equal(incompleteView.totals.unmappedCompletedCount, 1);
  assert.equal(
    incompleteView.warnings.some(
      (warning) =>
        warning.code === "unmapped_completed_sale" &&
        warning.eventKey === `${STREAM_ID}:202`,
    ),
    true,
  );

  const mapped = session.selectSku("HOODIE-GREY-M");

  assert.equal(mapped.ok, true);
  assert.equal(mapped.action, "completed_sale_mapped");
  assert.equal(mapped.view.totals.completedGmvCents, 8000);
  assert.equal(mapped.view.totals.committedRevenueCents, 8000);
  assert.equal(mapped.view.totals.costOfGoodsCents, 1950);
  assert.equal(mapped.view.totals.profitCents, 6050);
  assert.equal(
    mapped.view.totals.profitCents,
    mapped.view.totals.committedRevenueCents -
      mapped.view.totals.costOfGoodsCents,
  );
  assert.equal(mapped.view.totals.unmappedCompletedCount, 0);
  assert.equal(
    mapped.view.warnings.some(
      (warning) => warning.code === "unmapped_completed_sale",
    ),
    false,
  );
});
