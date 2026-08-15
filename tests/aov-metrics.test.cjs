const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");

const STREAM_ONE = "aov-stream-one";
const STREAM_TWO = "aov-stream-two";
const INVENTORY = Object.freeze([
  Object.freeze({
    sku: "TEE-BLACK-L",
    item: "Tee",
    style: "black",
    size: "L",
    quantityReceived: 10,
    unitCostCents: 1200,
  }),
]);

function createState() {
  return reconciliation.createReconciliationState(INVENTORY);
}

function observeStatus(state, streamId, variationNumber, status) {
  reconciliation.observePaymentStatuses(state, {
    streamId,
    statuses: [
      {
        variationNumber,
        observedPaymentStatus: status,
      },
    ],
  });
}

function calculateAovCents(totals) {
  return totals.completedPaymentCount > 0
    ? Math.round(
        totals.completedGmvCents / totals.completedPaymentCount,
      )
    : 0;
}

test("AOV uses every priced Payment complete order whether mapped or unmapped", () => {
  const state = createState();

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 101,
    soldPriceCents: 2000,
  });
  reconciliation.mapVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 102,
    sku: "TEE-BLACK-L",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 102,
    soldPriceCents: 4799,
  });

  const totals = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  }).totals;

  assert.equal(totals.completedPaymentCount, 2);
  assert.equal(totals.completedGmvCents, 6799);
  assert.equal(totals.unmappedCompletedCount, 1);
  assert.equal(calculateAovCents(totals), 3400);
});

test("AOV excludes bidding, nonterminal, canceled, and unpriced completed orders", () => {
  const state = createState();

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 200,
  });
  [
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  ].forEach((status, index) => {
    observeStatus(state, STREAM_ONE, 201 + index, status);
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 206,
    soldPriceCents: 1001,
  });

  const totals = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  }).totals;

  assert.equal(totals.completedPaymentCount, 1);
  assert.equal(totals.completedGmvCents, 1001);
  assert.equal(calculateAovCents(totals), 1001);
});

test("AOV is stream-scoped, idempotent, and zero when no priced completion exists", () => {
  const state = createState();

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 301,
    soldPriceCents: 2500,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 301,
    soldPriceCents: 2500,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_TWO,
    variationNumber: 301,
    soldPriceCents: 9000,
  });

  const streamOneTotals = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  }).totals;
  const streamTwoTotals = reconciliation.calculateSummary(state, {
    streamId: STREAM_TWO,
  }).totals;
  const emptyTotals = reconciliation.calculateSummary(createState(), {
    streamId: "empty-aov-stream",
  }).totals;

  assert.equal(streamOneTotals.completedPaymentCount, 1);
  assert.equal(calculateAovCents(streamOneTotals), 2500);
  assert.equal(streamTwoTotals.completedPaymentCount, 1);
  assert.equal(calculateAovCents(streamTwoTotals), 9000);
  assert.equal(emptyTotals.completedPaymentCount, 0);
  assert.equal(emptyTotals.completedGmvCents, 0);
  assert.equal(calculateAovCents(emptyTotals), 0);
});
