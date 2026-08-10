const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");

const INVENTORY = Object.freeze([
  Object.freeze({
    sku: "TEE-BLACK-L",
    item: "Tee",
    style: "black",
    size: "L",
    quantityReceived: 10,
    unitCostCents: 1200,
  }),
  Object.freeze({
    sku: "HOODIE-GREY-M",
    item: "Hoodie",
    style: "grey",
    size: "M",
    quantityReceived: 10,
    unitCostCents: 1800,
  }),
]);

const STREAM_ONE = "completed-sales-stream-one";
const STREAM_TWO = "completed-sales-stream-two";

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

function completedSales(state, streamId) {
  return reconciliation.calculateSummary(state, { streamId }).totals
    .completedPaymentCount;
}

function completedSalesRatio(state, streamId) {
  const totals = reconciliation.calculateSummary(state, { streamId }).totals;

  return `${totals.completedPaymentCount}/${totals.totalSalesCount}`;
}

test("completedPaymentCount includes priced Payment complete variations whether mapped or unmatched", () => {
  const state = createState();

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 101,
    soldPriceCents: 2500,
  });

  reconciliation.mapVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 102,
    sku: "TEE-BLACK-L",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 102,
    soldPriceCents: 4000,
  });

  const summary = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  });

  assert.equal(summary.totals.completedPaymentCount, 2);
  assert.equal(summary.totals.completedGmvCents, 6500);
  assert.equal(summary.totals.unmappedCompletedCount, 1);
  assert.deepEqual(
    summary.auctions
      .filter((auction) => auction.paymentStatus === "payment_complete")
      .map((auction) => auction.variationNumber),
    [101, 102],
  );
});

test("Total Sales includes only terminal Sold Items and excludes the active bid and non-final states", () => {
  const state = createState();

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 200,
  });
  const statuses = [
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
    reconciliation.OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
  ];

  statuses.forEach((status, index) => {
    observeStatus(state, STREAM_ONE, 201 + index, status);
  });

  const summary = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  });

  assert.equal(summary.totals.completedPaymentCount, 0);
  assert.equal(
    summary.totals.auctionCount,
    statuses.length + 1,
    "all canonical variations remain available to the tracker",
  );
  assert.equal(
    summary.totals.totalSalesCount,
    3,
    "only Payment complete, Payment failed, and Canceled variations count as Total Sales",
  );
  assert.equal(completedSalesRatio(state, STREAM_ONE), "0/3");
  assert.equal(summary.totals.completedGmvCents, 0);
  assert.equal(summary.auctions.length, statuses.length + 1);
  assert.equal(summary.activeBiddingVariationNumber, 200);
  assert.equal(
    summary.auctions.find((auction) => auction.variationNumber === 200)
      .observedPaymentStatus,
    reconciliation.OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED,
    "the active bidding variation remains visible but is excluded from Total Sales",
  );
  assert.equal(
    summary.auctions.find((auction) => auction.variationNumber === 205)
      .observedPaymentStatus,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  );
  assert.equal(
    summary.auctions.find((auction) => auction.variationNumber === 205)
      .soldPriceCents,
    null,
    "an observed Payment complete badge is not a priced completed sale yet",
  );
});

test("Completed Sales/Total Sales includes complete, failed, and canceled variations in its denominator", () => {
  const state = createState();

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 251,
    soldPriceCents: 3000,
  });
  observeStatus(
    state,
    STREAM_ONE,
    252,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
  );
  observeStatus(
    state,
    STREAM_ONE,
    253,
    reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
  );

  const totals = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  }).totals;

  assert.equal(totals.completedPaymentCount, 1);
  assert.equal(totals.totalSalesCount, 3);
  assert.equal(completedSalesRatio(state, STREAM_ONE), "1/3");
});

test("Completed Sales/Total Sales is stream-scoped and counts each canonical variation only once", () => {
  const state = createState();

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 301,
    soldPriceCents: 3000,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 301,
    soldPriceCents: 3000,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 301,
    soldPriceCents: 3500,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_TWO,
    variationNumber: 301,
    soldPriceCents: 7000,
  });
  observeStatus(
    state,
    STREAM_ONE,
    302,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
  );
  observeStatus(
    state,
    STREAM_ONE,
    302,
    reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
  );
  observeStatus(
    state,
    STREAM_ONE,
    303,
    reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
  );
  observeStatus(
    state,
    STREAM_ONE,
    303,
    reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
  );
  observeStatus(
    state,
    STREAM_TWO,
    304,
    reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
  );

  const streamOne = reconciliation.calculateSummary(state, {
    streamId: STREAM_ONE,
  });
  const streamTwo = reconciliation.calculateSummary(state, {
    streamId: STREAM_TWO,
  });

  assert.equal(streamOne.totals.completedPaymentCount, 1);
  assert.equal(streamOne.totals.totalSalesCount, 3);
  assert.equal(streamOne.totals.auctionCount, 3);
  assert.equal(completedSalesRatio(state, STREAM_ONE), "1/3");
  assert.equal(streamOne.totals.completedGmvCents, 3000);
  assert.equal(streamTwo.totals.completedPaymentCount, 1);
  assert.equal(streamTwo.totals.totalSalesCount, 2);
  assert.equal(streamTwo.totals.auctionCount, 2);
  assert.equal(completedSalesRatio(state, STREAM_TWO), "1/2");
  assert.equal(streamTwo.totals.completedGmvCents, 7000);
  assert.equal(
    streamOne.auctions[0].conflicts.some(
      (conflict) => conflict.code === "conflicting_sold_price",
    ),
    true,
    "a conflicting duplicate remains one canonical completed variation",
  );
});

test("mapping, remapping, and unmapping a completed variation never change completedPaymentCount", () => {
  const state = createState();

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ONE,
    variationNumber: 401,
    soldPriceCents: 5000,
  });
  assert.equal(completedSales(state, STREAM_ONE), 1);

  reconciliation.mapVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 401,
    sku: "TEE-BLACK-L",
  });
  assert.equal(completedSales(state, STREAM_ONE), 1);

  reconciliation.mapVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 401,
    sku: "HOODIE-GREY-M",
  });
  assert.equal(completedSales(state, STREAM_ONE), 1);

  reconciliation.unmapVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 401,
  });
  assert.equal(completedSales(state, STREAM_ONE), 1);
});
