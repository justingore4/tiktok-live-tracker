const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ReconciliationError,
  calculateSummary,
  createReconciliationState,
  getAuction,
  getInventoryAvailability,
  mapVariation,
  markUnpaid,
  recordPaymentComplete,
  undoMarkUnpaid,
} = require("../extension/shared/reconciliation.js");

const STREAM_ONE = "stream-2026-08-08";

function createInventory() {
  return [
    {
      sku: "BLACK-TEE-M",
      name: "Black Tee",
      size: "M",
      quantityReceived: 2,
      unitCostCents: 1200,
    },
    {
      sku: "BLACK-TEE-L",
      name: "Black Tee",
      size: "L",
      quantityReceived: 1,
      unitCostCents: 1500,
    },
  ];
}

function createState() {
  return createReconciliationState(createInventory());
}

function auctionInput(variationNumber, extra = {}) {
  return {
    streamId: STREAM_ONE,
    variationNumber,
    ...extra,
  };
}

function inventoryItem(summary, sku) {
  return summary.inventory.find((item) => item.sku === sku);
}

function performanceItem(summary, sku) {
  return summary.itemPerformance.find((item) => item.sku === sku);
}

function assertErrorCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof ReconciliationError && error.code === code,
  );
}

test("commits a mapped variation only after payment completes", () => {
  const state = createState();

  const pending = mapVariation(
    state,
    auctionInput(250, { sku: "BLACK-TEE-M" }),
  );
  const pendingSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(pending.status, "pending");
  assert.equal(pendingSummary.totals.committedSalesCount, 0);
  assert.equal(inventoryItem(pendingSummary, "BLACK-TEE-M").reservedQuantity, 1);
  assert.equal(
    inventoryItem(pendingSummary, "BLACK-TEE-M").remainingQuantity,
    2,
  );
  assert.equal(
    inventoryItem(pendingSummary, "BLACK-TEE-M").availableToTagQuantity,
    1,
  );

  const completed = recordPaymentComplete(
    state,
    auctionInput(250, { soldPriceCents: 4800 }),
  );
  const summary = calculateSummary(state, { streamId: STREAM_ONE });
  const mediumTee = inventoryItem(summary, "BLACK-TEE-M");
  const mediumTeePerformance = performanceItem(summary, "BLACK-TEE-M");

  assert.equal(completed.status, "committed");
  assert.equal(completed.committedUnitCostCents, 1200);
  assert.equal(completed.profitCents, 3600);
  assert.equal(mediumTee.soldQuantity, 1);
  assert.equal(mediumTee.reservedQuantity, 0);
  assert.equal(mediumTee.remainingQuantity, 1);
  assert.equal(mediumTee.availableToTagQuantity, 1);
  assert.equal(mediumTeePerformance.revenueCents, 4800);
  assert.equal(mediumTeePerformance.costOfGoodsCents, 1200);
  assert.equal(mediumTeePerformance.profitCents, 3600);
  assert.equal(summary.totals.completedGmvCents, 4800);
  assert.equal(summary.totals.committedRevenueCents, 4800);
  assert.equal(summary.totals.profitCents, 3600);

  const committedAvailability = getInventoryAvailability(state, {
    sku: "BLACK-TEE-M",
    streamId: STREAM_ONE,
    variationNumber: 250,
  });

  assert.equal(committedAvailability.currentAllocation, "sold");
  assert.equal(committedAvailability.availableForCurrentAuctionQuantity, 2);
});

test("reserves pending units without counting them as sold", () => {
  const state = createState();

  const firstPending = mapVariation(
    state,
    auctionInput(1, { sku: "BLACK-TEE-L" }),
  );
  const firstSummary = calculateSummary(state, { streamId: STREAM_ONE });
  const firstInventory = inventoryItem(firstSummary, "BLACK-TEE-L");
  const currentAvailability = getInventoryAvailability(state, {
    sku: "BLACK-TEE-L",
    streamId: STREAM_ONE,
    variationNumber: 1,
  });
  const nextAvailability = getInventoryAvailability(state, {
    sku: "BLACK-TEE-L",
    streamId: STREAM_ONE,
    variationNumber: 2,
  });

  assert.deepEqual(firstPending.warnings, []);
  assert.equal(firstInventory.soldQuantity, 0);
  assert.equal(firstInventory.reservedQuantity, 1);
  assert.equal(firstInventory.remainingQuantity, 1);
  assert.equal(firstInventory.availableToTagQuantity, 0);
  assert.equal(firstInventory.reservationShortfallQuantity, 0);
  assert.equal(currentAvailability.currentAllocation, "reserved");
  assert.equal(currentAvailability.availableForCurrentAuctionQuantity, 1);
  assert.equal(nextAvailability.currentAllocation, "none");
  assert.equal(nextAvailability.availableForCurrentAuctionQuantity, 0);

  const secondPending = mapVariation(
    state,
    auctionInput(2, { sku: "BLACK-TEE-L" }),
  );
  const secondInventory = inventoryItem(
    calculateSummary(state, { streamId: STREAM_ONE }),
    "BLACK-TEE-L",
  );

  assert.equal(secondPending.warnings[0].code, "no_stock_available");
  assert.equal(secondInventory.soldQuantity, 0);
  assert.equal(secondInventory.reservedQuantity, 2);
  assert.equal(secondInventory.remainingQuantity, 1);
  assert.equal(secondInventory.availableToTagQuantity, -1);
  assert.equal(secondInventory.reservationShortfallQuantity, 1);
});

test("pending remapping releases one reservation and creates another", () => {
  const state = createState();

  mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-M" }));
  mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-L" }));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(inventoryItem(summary, "BLACK-TEE-M").reservedQuantity, 0);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").availableToTagQuantity, 2);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").reservedQuantity, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").availableToTagQuantity, 0);
});

test("pending reservations aggregate across streams with repeated variation numbers", () => {
  const state = createState();

  mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-M",
  });
  mapVariation(state, {
    streamId: "evening-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-M",
  });
  const summary = calculateSummary(state);

  assert.equal(summary.totals.auctionCount, 2);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").reservedQuantity, 2);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").remainingQuantity, 2);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").availableToTagQuantity, 0);
});

test("commits correctly when payment arrives before the employee mapping", () => {
  const state = createState();

  const unmapped = recordPaymentComplete(
    state,
    auctionInput(251, { soldPriceCents: 2000 }),
  );
  const unmappedSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(unmapped.status, "unmapped_completed");
  assert.equal(unmappedSummary.totals.completedGmvCents, 2000);
  assert.equal(unmappedSummary.totals.committedRevenueCents, 0);
  assert.deepEqual(unmappedSummary.warnings, [
    {
      code: "unmapped_completed_sale",
      eventKey: `${STREAM_ONE}:251`,
    },
  ]);

  const committed = mapVariation(
    state,
    auctionInput(251, { sku: "BLACK-TEE-L" }),
  );
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(committed.status, "committed");
  assert.equal(committed.profitCents, 500);
  assert.equal(summary.totals.unmappedCompletedCount, 0);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").remainingQuantity, 0);
  assert.deepEqual(summary.warnings, []);
});

test("ignores an identical duplicate completed-payment event", () => {
  const state = createState();

  mapVariation(state, auctionInput(10, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(10, { soldPriceCents: 3000 }));
  recordPaymentComplete(state, auctionInput(10, { soldPriceCents: 3000 }));

  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(summary.totals.completedPaymentCount, 1);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").soldQuantity, 1);
  assert.equal(summary.totals.conflictCount, 0);
});

test("retains the first final price and surfaces conflicting duplicates", () => {
  const state = createState();

  mapVariation(state, auctionInput(11, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(11, { soldPriceCents: 3000 }));
  recordPaymentComplete(state, auctionInput(11, { soldPriceCents: 3100 }));
  recordPaymentComplete(state, auctionInput(11, { soldPriceCents: 3100 }));

  const auction = getAuction(state, auctionInput(11));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(auction.soldPriceCents, 3000);
  assert.deepEqual(auction.conflicts, [
    {
      code: "conflicting_sold_price",
      retainedSoldPriceCents: 3000,
      observedSoldPriceCents: 3100,
    },
  ]);
  assert.equal(summary.totals.committedRevenueCents, 3000);
  assert.equal(summary.totals.conflictCount, 1);
});

test("uses stream ID and variation number together as the auction key", () => {
  const state = createState();

  mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-M",
  });
  recordPaymentComplete(state, {
    streamId: "morning-stream",
    variationNumber: 1,
    soldPriceCents: 2000,
  });
  mapVariation(state, {
    streamId: "evening-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-L",
  });
  recordPaymentComplete(state, {
    streamId: "evening-stream",
    variationNumber: 1,
    soldPriceCents: 4000,
  });

  const allStreams = calculateSummary(state);
  const eveningOnly = calculateSummary(state, { streamId: "evening-stream" });

  assert.equal(allStreams.totals.committedSalesCount, 2);
  assert.equal(allStreams.totals.committedRevenueCents, 6000);
  assert.equal(eveningOnly.totals.committedSalesCount, 1);
  assert.equal(eveningOnly.totals.committedRevenueCents, 4000);
  assert.equal(eveningOnly.auctions[0].eventKey, "evening-stream:1");
  assert.equal(eveningOnly.inventoryScope, "all_streams");
  assert.equal(inventoryItem(eveningOnly, "BLACK-TEE-M").remainingQuantity, 1);
  assert.equal(inventoryItem(eveningOnly, "BLACK-TEE-L").remainingQuantity, 0);
  assert.equal(performanceItem(eveningOnly, "BLACK-TEE-M").soldQuantity, 0);
  assert.equal(performanceItem(eveningOnly, "BLACK-TEE-L").soldQuantity, 1);
});

test("warns immediately when a pending mapping has no available stock", () => {
  const state = createState();

  mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-L",
  });
  recordPaymentComplete(state, {
    streamId: "morning-stream",
    variationNumber: 1,
    soldPriceCents: 3000,
  });

  const exhaustedMapping = mapVariation(state, {
    streamId: "evening-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-L",
  });

  assert.deepEqual(exhaustedMapping.warnings, [
    {
      code: "no_stock_available",
      sku: "BLACK-TEE-L",
      availableQuantity: 0,
    },
  ]);

  const summaryWithWarning = calculateSummary(state, {
    streamId: "evening-stream",
  });
  assert.deepEqual(summaryWithWarning.warnings, [
    {
      eventKey: "evening-stream:1",
      code: "no_stock_available",
      sku: "BLACK-TEE-L",
      availableQuantity: 0,
    },
  ]);

  const correctedMapping = mapVariation(state, {
    streamId: "evening-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-M",
  });

  assert.deepEqual(correctedMapping.warnings, []);
  assert.deepEqual(
    calculateSummary(state, { streamId: "evening-stream" }).warnings,
    [],
  );
});

test("marking a mapped variation unpaid never changes inventory or profit", () => {
  const state = createState();

  mapVariation(state, auctionInput(20, { sku: "BLACK-TEE-M" }));
  const unpaid = markUnpaid(state, auctionInput(20));
  const unpaidSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(unpaid.status, "marked_unpaid");
  assert.equal(unpaidSummary.totals.markedUnpaidCount, 1);
  assert.equal(unpaidSummary.totals.committedSalesCount, 0);
  assert.equal(inventoryItem(unpaidSummary, "BLACK-TEE-M").reservedQuantity, 0);
  assert.equal(inventoryItem(unpaidSummary, "BLACK-TEE-M").remainingQuantity, 2);
  assert.equal(
    inventoryItem(unpaidSummary, "BLACK-TEE-M").availableToTagQuantity,
    2,
  );
  assert.equal(unpaidSummary.totals.profitCents, 0);

  const restored = undoMarkUnpaid(state, auctionInput(20));

  assert.equal(restored.status, "pending");
  const restoredSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(restoredSummary.totals.markedUnpaidCount, 0);
  assert.equal(inventoryItem(restoredSummary, "BLACK-TEE-M").reservedQuantity, 1);
  assert.equal(
    inventoryItem(restoredSummary, "BLACK-TEE-M").availableToTagQuantity,
    1,
  );
});

test("a re-auction under a new variation deducts stock only when it sells", () => {
  const state = createState();

  mapVariation(state, auctionInput(30, { sku: "BLACK-TEE-M" }));
  markUnpaid(state, auctionInput(30));
  mapVariation(state, auctionInput(31, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(31, { soldPriceCents: 2500 }));

  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(summary.totals.auctionCount, 2);
  assert.equal(summary.totals.markedUnpaidCount, 1);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").remainingQuantity, 1);
});

test("TikTok payment completion wins after a local unpaid mark and raises a conflict", () => {
  const state = createState();

  mapVariation(state, auctionInput(40, { sku: "BLACK-TEE-L" }));
  markUnpaid(state, auctionInput(40));
  const completed = recordPaymentComplete(
    state,
    auctionInput(40, { soldPriceCents: 3500 }),
  );
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(completed.status, "committed");
  assert.equal(completed.mappingStatus, "marked_unpaid");
  assert.equal(completed.profitCents, 2000);
  assert.deepEqual(completed.conflicts, [
    { code: "payment_completed_after_marked_unpaid" },
  ]);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(summary.totals.conflictCount, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").remainingQuantity, 0);
});

test("cannot locally mark a completed TikTok payment as unpaid", () => {
  const state = createState();

  mapVariation(state, auctionInput(41, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(41, { soldPriceCents: 2500 }));

  assertErrorCode(
    () => markUnpaid(state, auctionInput(41)),
    "PAYMENT_ALREADY_COMPLETE",
  );
  assert.equal(
    calculateSummary(state, { streamId: STREAM_ONE }).totals.committedSalesCount,
    1,
  );
});

test("correcting a committed mapping moves inventory and profit to the new SKU", () => {
  const state = createState();

  mapVariation(state, auctionInput(50, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(50, { soldPriceCents: 1000 }));

  const beforeCorrection = calculateSummary(state, { streamId: STREAM_ONE });
  assert.equal(inventoryItem(beforeCorrection, "BLACK-TEE-M").soldQuantity, 1);
  assert.equal(beforeCorrection.totals.profitCents, -200);

  const corrected = mapVariation(
    state,
    auctionInput(50, { sku: "BLACK-TEE-L" }),
  );
  const afterCorrection = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(corrected.committedUnitCostCents, 1500);
  assert.equal(corrected.profitCents, -500);
  assert.equal(inventoryItem(afterCorrection, "BLACK-TEE-M").soldQuantity, 0);
  assert.equal(inventoryItem(afterCorrection, "BLACK-TEE-M").remainingQuantity, 2);
  assert.equal(inventoryItem(afterCorrection, "BLACK-TEE-L").soldQuantity, 1);
  assert.equal(inventoryItem(afterCorrection, "BLACK-TEE-L").remainingQuantity, 0);
  assert.equal(performanceItem(afterCorrection, "BLACK-TEE-M").soldQuantity, 0);
  assert.equal(performanceItem(afterCorrection, "BLACK-TEE-M").profitCents, 0);
  assert.equal(performanceItem(afterCorrection, "BLACK-TEE-L").soldQuantity, 1);
  assert.equal(performanceItem(afterCorrection, "BLACK-TEE-L").profitCents, -500);
  assert.equal(afterCorrection.totals.profitCents, -500);
});

test("rejects an unknown SKU without creating a partial auction", () => {
  const state = createState();

  assertErrorCode(
    () => mapVariation(state, auctionInput(60, { sku: "MISSING-SKU" })),
    "UNKNOWN_SKU",
  );

  assert.equal(getAuction(state, auctionInput(60)), null);
  assert.equal(state.streams.length, 0);
});

test("records real completed sales even when inventory becomes negative", () => {
  const state = createState();

  for (const variationNumber of [70, 71]) {
    mapVariation(
      state,
      auctionInput(variationNumber, { sku: "BLACK-TEE-L" }),
    );
    recordPaymentComplete(
      state,
      auctionInput(variationNumber, { soldPriceCents: 2000 }),
    );
  }

  const summary = calculateSummary(state, { streamId: STREAM_ONE });
  const largeTee = inventoryItem(summary, "BLACK-TEE-L");

  assert.equal(summary.totals.committedSalesCount, 2);
  assert.equal(largeTee.remainingQuantity, -1);
  assert.equal(largeTee.oversoldQuantity, 1);
  assert.deepEqual(summary.warnings, [
    {
      code: "negative_inventory",
      sku: "BLACK-TEE-L",
      oversoldQuantity: 1,
    },
  ]);
});

test("state survives a JSON round trip for future local storage", () => {
  const state = createState();

  mapVariation(state, auctionInput(80, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(80, { soldPriceCents: 4800 }));

  const restoredState = JSON.parse(JSON.stringify(state));
  const summary = calculateSummary(restoredState, { streamId: STREAM_ONE });

  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(summary.totals.profitCents, 3600);
});

test("validates duplicate SKUs and integer money values", () => {
  const duplicateInventory = [createInventory()[0], createInventory()[0]];

  assertErrorCode(
    () => createReconciliationState(duplicateInventory),
    "DUPLICATE_SKU",
  );

  const state = createState();
  assertErrorCode(
    () =>
      recordPaymentComplete(
        state,
        auctionInput(90, { soldPriceCents: 10.5 }),
      ),
    "INVALID_ARGUMENT",
  );
  assert.equal(getAuction(state, auctionInput(90)), null);
});
