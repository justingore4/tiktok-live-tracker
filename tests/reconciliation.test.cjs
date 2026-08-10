const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OBSERVED_PAYMENT_STATUSES,
  ReconciliationError,
  STATE_VERSION,
  calculateSummary,
  createInventoryBaseline,
  createReconciliationState,
  getAuction,
  getInventoryAvailability,
  hydrateReconciliationState,
  mapVariation,
  markUnpaid,
  observeBiddingVariation,
  observePaymentStatuses,
  observeVariations,
  recordPaymentComplete,
  unmapVariation,
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

function activeBaseline(state) {
  return state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === state.activeInventoryBaselineId,
  );
}

function toLegacyState(state, version) {
  const baseline = activeBaseline(state);

  return {
    version,
    inventory: baseline.inventory.map((entry) => ({
      sku: entry.sku,
      name: entry.style ? `${entry.item} - ${entry.style}` : entry.item,
      size: entry.size,
      quantityReceived: entry.quantityOnHandAtImport,
      unitCostCents: entry.unitCostCents,
    })),
    streams: state.streams.map(({ streamId, variations }) => ({
      streamId,
      variations: JSON.parse(JSON.stringify(variations)),
    })),
  };
}

function auctionInput(variationNumber, extra = {}) {
  return {
    streamId: STREAM_ONE,
    variationNumber,
    ...extra,
  };
}

function observePendingPayment(
  state,
  variationNumber,
  observedPaymentStatus = OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
  streamId = STREAM_ONE,
) {
  return observePaymentStatuses(state, {
    streamId,
    statuses: [{ variationNumber, observedPaymentStatus }],
  });
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

test("observes a batch without changing inventory or financial totals", () => {
  const state = createState();
  const inventoryBefore = JSON.parse(
    JSON.stringify(activeBaseline(state).inventory),
  );

  const result = observeVariations(state, {
    streamId: STREAM_ONE,
    variationNumbers: [37, 38, 39],
  });
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.deepEqual(result, {
    status: "observed",
    observedCount: 3,
    newlyObservedCount: 3,
  });
  assert.deepEqual(activeBaseline(state).inventory, inventoryBefore);
  assert.equal(summary.totals.auctionCount, 3);
  assert.equal(summary.totals.completedPaymentCount, 0);
  assert.equal(summary.totals.completedGmvCents, 0);
  assert.equal(summary.totals.committedSalesCount, 0);
  assert.equal(summary.totals.profitCents, 0);
  assert.deepEqual(
    summary.auctions.map((auction) => ({
      variationNumber: auction.variationNumber,
      status: auction.status,
      sku: auction.sku,
      soldPriceCents: auction.soldPriceCents,
    })),
    [
      { variationNumber: 37, status: "unmapped", sku: null, soldPriceCents: null },
      { variationNumber: 38, status: "unmapped", sku: null, soldPriceCents: null },
      { variationNumber: 39, status: "unmapped", sku: null, soldPriceCents: null },
    ],
  );
});

test("repeated observations are idempotent and never regress completed truth", () => {
  const state = createState();

  observeVariations(state, {
    streamId: STREAM_ONE,
    variationNumbers: [40, 41],
  });
  recordPaymentComplete(state, auctionInput(40, { soldPriceCents: 7000 }));
  const beforeRetry = JSON.parse(JSON.stringify(state));
  const repeated = observeVariations(state, {
    streamId: STREAM_ONE,
    variationNumbers: [40, 41],
  });

  assert.deepEqual(repeated, {
    status: "already_observed",
    observedCount: 2,
    newlyObservedCount: 0,
  });
  assert.deepEqual(state, beforeRetry);
  assert.equal(getAuction(state, auctionInput(40)).paymentStatus, "payment_complete");
  assert.equal(getAuction(state, auctionInput(40)).soldPriceCents, 7000);
});

test("invalid observation batches are rejected atomically", () => {
  const state = createState();

  for (const variationNumbers of [[], [1, 1], [1, 0], [1, 2.5]]) {
    assertErrorCode(
      () =>
        observeVariations(state, {
          streamId: STREAM_ONE,
          variationNumbers,
        }),
      "INVALID_ARGUMENT",
    );
  }

  assert.deepEqual(state.streams, []);
});

test("observes payment statuses and canonicalizes terminal cancellation", () => {
  const state = createState();

  mapVariation(state, auctionInput(50, { sku: "BLACK-TEE-M" }));
  const beforeSummary = calculateSummary(state, { streamId: STREAM_ONE });
  const beforeAvailability = getInventoryAvailability(state, {
    sku: "BLACK-TEE-M",
  });
  const result = observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 50,
        observedPaymentStatus:
          OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
      {
        variationNumber: 51,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      },
      {
        variationNumber: 52,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
      {
        variationNumber: 53,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
      {
        variationNumber: 54,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
      },
    ],
  });
  const afterSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.deepEqual(result, {
    status: "observed",
    observedCount: 5,
    updatedCount: 5,
    ignoredCount: 0,
  });
  assert.equal(state.version, STATE_VERSION);
  assert.equal(
    getAuction(state, auctionInput(50)).observedPaymentStatus,
    "payment_processing",
  );
  assert.equal(getAuction(state, auctionInput(50)).sku, "BLACK-TEE-M");
  assert.equal(getAuction(state, auctionInput(51)).paymentStatus, "unknown");
  assert.equal(getAuction(state, auctionInput(51)).soldPriceCents, null);
  assert.equal(
    getAuction(state, auctionInput(53)).observedPaymentStatus,
    "canceled",
  );
  assert.equal(getAuction(state, auctionInput(53)).paymentStatus, "canceled");
  assert.equal(getAuction(state, auctionInput(53)).status, "canceled");
  assert.equal(getAuction(state, auctionInput(53)).soldPriceCents, null);
  assert.equal(beforeAvailability.reservedQuantity, 0);
  assert.equal(beforeAvailability.availableToTagQuantity, 2);
  assert.equal(
    getInventoryAvailability(state, { sku: "BLACK-TEE-M" })
      .reservedQuantity,
    1,
  );
  assert.equal(
    getInventoryAvailability(state, { sku: "BLACK-TEE-M" })
      .availableToTagQuantity,
    1,
  );
  assert.equal(beforeSummary.auctions[0].status, "mapped");
  assert.equal(afterSummary.auctions[0].status, "pending");
  assert.deepEqual(afterSummary.itemPerformance, beforeSummary.itemPerformance);
  assert.equal(afterSummary.totals.committedSalesCount, 0);
  assert.equal(afterSummary.totals.totalSalesCount, 2);
  assert.equal(afterSummary.totals.completedGmvCents, 0);
  assert.equal(afterSummary.totals.profitCents, 0);
  assert.deepEqual(
    hydrateReconciliationState(JSON.parse(JSON.stringify(state))),
    state,
  );
});

test("totalSalesCount includes only unique terminal Sold Items statuses in the selected stream", () => {
  const state = createState();

  observeBiddingVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 70,
  });
  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 71,
        observedPaymentStatus:
          OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
      {
        variationNumber: 72,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      },
      {
        variationNumber: 73,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
      },
      {
        variationNumber: 74,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
      {
        variationNumber: 75,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
      {
        variationNumber: 76,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      },
    ],
  });
  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 74,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
  });
  recordPaymentComplete(state, {
    streamId: "another-stream",
    variationNumber: 74,
    soldPriceCents: 2500,
  });

  const selectedSummary = calculateSummary(state, { streamId: STREAM_ONE });
  const otherSummary = calculateSummary(state, {
    streamId: "another-stream",
  });

  assert.equal(selectedSummary.totals.auctionCount, 7);
  assert.equal(selectedSummary.totals.totalSalesCount, 3);
  assert.equal(selectedSummary.totals.completedPaymentCount, 0);
  assert.equal(selectedSummary.activeBiddingVariationNumber, 70);
  assert.equal(otherSummary.totals.totalSalesCount, 1);
  assert.equal(otherSummary.totals.completedPaymentCount, 1);
});

test("nonterminal payment states are flexible until cancellation becomes sticky", () => {
  const state = createState();
  const observation = (observedPaymentStatus) =>
    observePaymentStatuses(state, {
      streamId: STREAM_ONE,
      statuses: [{ variationNumber: 60, observedPaymentStatus }],
    });

  for (const observedPaymentStatus of [
    OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
  ]) {
    assert.equal(observation(observedPaymentStatus).updatedCount, 1);
    assert.equal(
      getAuction(state, auctionInput(60)).observedPaymentStatus,
      observedPaymentStatus,
    );
  }

  const beforeRetry = JSON.parse(JSON.stringify(state));
  const retry = observation(OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING);

  assert.deepEqual(retry, {
    status: "already_observed",
    observedCount: 1,
    updatedCount: 0,
    ignoredCount: 0,
  });
  assert.deepEqual(state, beforeRetry);

  const canceled = observation(OBSERVED_PAYMENT_STATUSES.CANCELED);

  assert.equal(canceled.updatedCount, 1);
  assert.equal(getAuction(state, auctionInput(60)).paymentStatus, "canceled");
  assert.equal(getAuction(state, auctionInput(60)).status, "canceled");

  const afterCancellation = JSON.parse(JSON.stringify(state));

  for (const observedPaymentStatus of [
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  ]) {
    assert.deepEqual(observation(observedPaymentStatus), {
      status: "already_observed",
      observedCount: 1,
      updatedCount: 0,
      ignoredCount: 1,
    });
    assert.deepEqual(state, afterCancellation);
  }
});

test("observed completion does not create a canonical sale without its price", () => {
  const state = createState();

  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 61,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      },
    ],
  });
  const auction = getAuction(state, auctionInput(61));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(auction.observedPaymentStatus, "payment_complete");
  assert.equal(auction.paymentStatus, "unknown");
  assert.equal(auction.soldPriceCents, null);
  assert.equal(summary.totals.completedPaymentCount, 0);
  assert.equal(summary.totals.completedGmvCents, 0);
  assert.deepEqual(
    hydrateReconciliationState(JSON.parse(JSON.stringify(state))),
    state,
  );
});

test("canonical completion sets observed completion and ignores later statuses", () => {
  const state = createState();

  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 62,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
  });
  const completed = recordPaymentComplete(
    state,
    auctionInput(62, { soldPriceCents: 2500 }),
  );
  const beforeLateStatuses = JSON.parse(JSON.stringify(state));
  const ignored = observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 62,
        observedPaymentStatus:
          OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
    ],
  });

  assert.equal(completed.observedPaymentStatus, "payment_complete");
  assert.deepEqual(ignored, {
    status: "already_observed",
    observedCount: 1,
    updatedCount: 0,
    ignoredCount: 1,
  });
  assert.deepEqual(state, beforeLateStatuses);
  assert.equal(getAuction(state, auctionInput(62)).soldPriceCents, 2500);

  const lateCancellation = observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 62,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });

  assert.deepEqual(lateCancellation, {
    status: "already_observed",
    observedCount: 1,
    updatedCount: 0,
    ignoredCount: 1,
  });
  assert.deepEqual(state, beforeLateStatuses);
});

test("invalid payment-status batches are rejected atomically", () => {
  const invalidStatuses = [
    [],
    [
      {
        variationNumber: 1,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED,
      },
    ],
    [{ variationNumber: 1, observedPaymentStatus: "payment_pending" }],
    [
      {
        variationNumber: 1,
        observedPaymentStatus:
          OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
      {
        variationNumber: 1,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
    [
      {
        variationNumber: 0,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
    [
      {
        variationNumber: 1,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
        extra: true,
      },
    ],
  ];

  for (const statuses of invalidStatuses) {
    const state = createState();

    assertErrorCode(
      () => observePaymentStatuses(state, { streamId: STREAM_ONE, statuses }),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(state.streams, []);
  }

  const oversizedState = createState();
  const oversized = Array.from({ length: 1001 }, (_, index) => ({
    variationNumber: index + 1,
    observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
  }));

  assertErrorCode(
    () =>
      observePaymentStatuses(oversizedState, {
        streamId: STREAM_ONE,
        statuses: oversized,
      }),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(oversizedState.streams, []);
});

test("maps without reserving and commits only after payment completes", () => {
  const state = createState();

  const pending = mapVariation(
    state,
    auctionInput(250, { sku: "BLACK-TEE-M" }),
  );
  const pendingSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(pending.status, "mapped");
  assert.equal(pendingSummary.totals.committedSalesCount, 0);
  assert.equal(inventoryItem(pendingSummary, "BLACK-TEE-M").reservedQuantity, 0);
  assert.equal(
    inventoryItem(pendingSummary, "BLACK-TEE-M").remainingQuantity,
    2,
  );
  assert.equal(
    inventoryItem(pendingSummary, "BLACK-TEE-M").availableToTagQuantity,
    2,
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

test("reserves a mapped item only while payment is processing or fixing", () => {
  const state = createState();

  const mapped = mapVariation(
    state,
    auctionInput(249, { sku: "BLACK-TEE-M" }),
  );
  let availability = getInventoryAvailability(state, {
    sku: "BLACK-TEE-M",
    streamId: STREAM_ONE,
    variationNumber: 249,
  });

  assert.equal(mapped.status, "mapped");
  assert.equal(availability.reservedQuantity, 0);
  assert.equal(availability.availableToTagQuantity, 2);
  assert.equal(availability.currentAllocation, "none");
  assert.equal(
    calculateSummary(state, { streamId: STREAM_ONE }).totals
      .pendingMappedCount,
    0,
  );

  for (const observedPaymentStatus of [
    OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
  ]) {
    observePendingPayment(state, 249, observedPaymentStatus);
    availability = getInventoryAvailability(state, {
      sku: "BLACK-TEE-M",
      streamId: STREAM_ONE,
      variationNumber: 249,
    });

    assert.equal(getAuction(state, auctionInput(249)).status, "pending");
    assert.equal(availability.reservedQuantity, 1);
    assert.equal(availability.availableToTagQuantity, 1);
    assert.equal(availability.currentAllocation, "reserved");
    assert.equal(
      calculateSummary(state, { streamId: STREAM_ONE }).totals
        .pendingMappedCount,
      1,
    );
  }

  for (const observedPaymentStatus of [
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  ]) {
    observePaymentStatuses(state, {
      streamId: STREAM_ONE,
      statuses: [{ variationNumber: 249, observedPaymentStatus }],
    });
    availability = getInventoryAvailability(state, {
      sku: "BLACK-TEE-M",
      streamId: STREAM_ONE,
      variationNumber: 249,
    });

    assert.equal(getAuction(state, auctionInput(249)).status, "mapped");
    assert.equal(availability.reservedQuantity, 0);
    assert.equal(availability.availableToTagQuantity, 2);
    assert.equal(availability.currentAllocation, "none");
    assert.equal(
      calculateSummary(state, { streamId: STREAM_ONE }).totals
        .pendingMappedCount,
      0,
    );
  }
});

test("reserves the last unit and atomically rejects a competing mapping", () => {
  const state = createState();

  observePendingPayment(state, 1);
  observePendingPayment(state, 2);

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

  const stateAtCapacity = JSON.parse(JSON.stringify(state));
  const idempotent = mapVariation(
    state,
    auctionInput(1, { sku: "BLACK-TEE-L" }),
  );

  assert.equal(idempotent.status, "pending");
  assert.deepEqual(state, stateAtCapacity);
  assertErrorCode(
    () => mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-L" })),
    "NO_STOCK_AVAILABLE",
  );
  assert.deepEqual(state, stateAtCapacity);
  assert.equal(getAuction(state, auctionInput(2)).status, "unmapped");
  assert.equal(getAuction(state, auctionInput(2)).sku, null);

  const secondInventory = inventoryItem(
    calculateSummary(state, { streamId: STREAM_ONE }),
    "BLACK-TEE-L",
  );

  assert.equal(secondInventory.soldQuantity, 0);
  assert.equal(secondInventory.reservedQuantity, 1);
  assert.equal(secondInventory.remainingQuantity, 1);
  assert.equal(secondInventory.availableToTagQuantity, 0);
  assert.equal(secondInventory.reservationShortfallQuantity, 0);
});

test("a rejected pending remap preserves its original reservation", () => {
  const state = createState();

  observePendingPayment(state, 1);
  observePendingPayment(state, 2);

  mapVariation(state, auctionInput(1, { sku: "BLACK-TEE-L" }));
  mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-M" }));
  const beforeRemap = JSON.parse(JSON.stringify(state));

  assertErrorCode(
    () => mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-L" })),
    "NO_STOCK_AVAILABLE",
  );

  assert.deepEqual(state, beforeRemap);
  assert.equal(getAuction(state, auctionInput(2)).sku, "BLACK-TEE-M");
  assert.equal(
    getInventoryAvailability(state, { sku: "BLACK-TEE-L" }).reservedQuantity,
    1,
  );
  assert.equal(
    getInventoryAvailability(state, { sku: "BLACK-TEE-M" }).reservedQuantity,
    1,
  );
});

test("pending remapping releases one reservation and creates another", () => {
  const state = createState();

  observePendingPayment(state, 2);

  mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-M" }));
  mapVariation(state, auctionInput(2, { sku: "BLACK-TEE-L" }));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(inventoryItem(summary, "BLACK-TEE-M").reservedQuantity, 0);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").availableToTagQuantity, 2);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").reservedQuantity, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").availableToTagQuantity, 0);
});

test("cancellation preserves its mapping and releases the pending reservation", () => {
  const state = createState();

  observePendingPayment(state, 63);

  mapVariation(state, auctionInput(63, { sku: "BLACK-TEE-L" }));
  const canceledResult = observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 63,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const canceled = getAuction(state, auctionInput(63));
  const availability = getInventoryAvailability(state, {
    sku: "BLACK-TEE-L",
    streamId: STREAM_ONE,
    variationNumber: 63,
  });
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(canceledResult.updatedCount, 1);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.paymentStatus, "canceled");
  assert.equal(canceled.observedPaymentStatus, "canceled");
  assert.equal(canceled.mappingStatus, "mapped");
  assert.equal(canceled.sku, "BLACK-TEE-L");
  assert.equal(canceled.soldPriceCents, null);
  assert.equal(canceled.committedUnitCostCents, null);
  assert.equal(canceled.profitCents, null);
  assert.equal(canceled.committed, false);
  assert.equal(availability.currentAllocation, "none");
  assert.equal(availability.reservedQuantity, 0);
  assert.equal(availability.availableForCurrentAuctionQuantity, 1);
  assert.equal(summary.totals.pendingMappedCount, 0);
  assert.equal(inventoryItem(summary, "BLACK-TEE-L").remainingQuantity, 1);

  const unmapped = unmapVariation(state, auctionInput(63));

  assert.equal(unmapped.status, "canceled");
  assert.equal(unmapped.paymentStatus, "canceled");
  assert.equal(unmapped.mappingStatus, "unmapped");
  assert.equal(unmapped.sku, null);
});

test("priced completion overrides cancellation and records the transition conflict", () => {
  const state = createState();

  mapVariation(state, auctionInput(64, { sku: "BLACK-TEE-L" }));
  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 64,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const ignoredObservedCompletion = observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 64,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      },
    ],
  });

  assert.equal(ignoredObservedCompletion.ignoredCount, 1);
  assert.equal(getAuction(state, auctionInput(64)).paymentStatus, "canceled");

  const completed = recordPaymentComplete(
    state,
    auctionInput(64, { soldPriceCents: 3500 }),
  );
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(completed.status, "committed");
  assert.equal(completed.paymentStatus, "payment_complete");
  assert.equal(completed.observedPaymentStatus, "payment_complete");
  assert.equal(completed.soldPriceCents, 3500);
  assert.equal(completed.committedUnitCostCents, 1500);
  assert.equal(completed.profitCents, 2000);
  assert.deepEqual(completed.conflicts, [
    { code: "payment_completed_after_canceled" },
  ]);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(summary.totals.conflictCount, 1);
  assert.deepEqual(
    hydrateReconciliationState(JSON.parse(JSON.stringify(state))),
    state,
  );
});

test("unmapping a pending variation releases its reservation and is idempotent", () => {
  const state = createState();

  observePendingPayment(state, 3);

  mapVariation(state, auctionInput(3, { sku: "BLACK-TEE-M" }));
  const unmapped = unmapVariation(state, auctionInput(3));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(unmapped.status, "unmapped");
  assert.equal(unmapped.mappingStatus, "unmapped");
  assert.equal(unmapped.sku, null);
  assert.equal(unmapped.committedUnitCostCents, null);
  assert.equal(summary.totals.pendingMappedCount, 0);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").reservedQuantity, 0);
  assert.equal(
    inventoryItem(summary, "BLACK-TEE-M").availableToTagQuantity,
    2,
  );

  const stateAfterFirstUnmap = JSON.parse(JSON.stringify(state));
  const repeated = unmapVariation(state, auctionInput(3));

  assert.equal(repeated.status, "unmapped");
  assert.deepEqual(state, stateAfterFirstUnmap);
});

test("unmapping a completed payment preserves GMV but removes item attribution", () => {
  const state = createState();

  mapVariation(state, auctionInput(4, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(
    state,
    auctionInput(4, { soldPriceCents: 4800 }),
  );
  const unmapped = unmapVariation(state, auctionInput(4));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(unmapped.status, "unmapped_completed");
  assert.equal(unmapped.paymentStatus, "payment_complete");
  assert.equal(unmapped.soldPriceCents, 4800);
  assert.equal(unmapped.sku, null);
  assert.equal(unmapped.committedUnitCostCents, null);
  assert.equal(unmapped.profitCents, null);
  assert.equal(summary.totals.completedPaymentCount, 1);
  assert.equal(summary.totals.completedGmvCents, 4800);
  assert.equal(summary.totals.committedSalesCount, 0);
  assert.equal(summary.totals.committedRevenueCents, 0);
  assert.equal(summary.totals.costOfGoodsCents, 0);
  assert.equal(summary.totals.profitCents, 0);
  assert.equal(summary.totals.unmappedCompletedCount, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").soldQuantity, 0);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").remainingQuantity, 2);
  assert.deepEqual(summary.warnings, [
    {
      code: "unmapped_completed_sale",
      eventKey: `${STREAM_ONE}:4`,
    },
  ]);
});

test("pending reservations aggregate across streams with repeated variation numbers", () => {
  const state = createState();

  observePendingPayment(
    state,
    1,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    "morning-stream",
  );
  observePendingPayment(
    state,
    1,
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    "evening-stream",
  );

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
  assert.equal(eveningOnly.inventoryScope, "inventory_baseline");
  assert.equal(inventoryItem(eveningOnly, "BLACK-TEE-M").remainingQuantity, 1);
  assert.equal(inventoryItem(eveningOnly, "BLACK-TEE-L").remainingQuantity, 0);
  assert.equal(performanceItem(eveningOnly, "BLACK-TEE-M").soldQuantity, 0);
  assert.equal(performanceItem(eveningOnly, "BLACK-TEE-L").soldQuantity, 1);
});

test("rejects a pending mapping when completed sales exhausted stock", () => {
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

  const beforeRejectedMapping = JSON.parse(JSON.stringify(state));

  assertErrorCode(
    () =>
      mapVariation(state, {
        streamId: "evening-stream",
        variationNumber: 1,
        sku: "BLACK-TEE-L",
      }),
    "NO_STOCK_AVAILABLE",
  );
  assert.deepEqual(state, beforeRejectedMapping);
  assert.equal(
    getAuction(state, {
      streamId: "evening-stream",
      variationNumber: 1,
    }),
    null,
  );

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

  assert.equal(restored.status, "mapped");
  const restoredSummary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(restoredSummary.totals.markedUnpaidCount, 0);
  assert.equal(inventoryItem(restoredSummary, "BLACK-TEE-M").reservedQuantity, 0);
  assert.equal(
    inventoryItem(restoredSummary, "BLACK-TEE-M").availableToTagQuantity,
    2,
  );
});

test("unmapping preserves an unpaid decision across storage hydration", () => {
  const state = createState();

  mapVariation(state, auctionInput(21, { sku: "BLACK-TEE-M" }));
  markUnpaid(state, auctionInput(21));
  const unmapped = unmapVariation(state, auctionInput(21));
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(unmapped.status, "marked_unpaid");
  assert.equal(unmapped.mappingStatus, "marked_unpaid");
  assert.equal(unmapped.sku, null);
  assert.equal(summary.totals.markedUnpaidCount, 1);
  assert.equal(inventoryItem(summary, "BLACK-TEE-M").reservedQuantity, 0);

  const restoredState = hydrateReconciliationState(
    JSON.parse(JSON.stringify(state)),
  );
  const restoredAuction = getAuction(restoredState, auctionInput(21));

  assert.equal(restoredAuction.status, "marked_unpaid");
  assert.equal(restoredAuction.sku, null);
  assert.equal(undoMarkUnpaid(restoredState, auctionInput(21)).status, "unmapped");
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

test("unmapping a late completed payment preserves its unpaid conflict", () => {
  const state = createState();

  mapVariation(state, auctionInput(42, { sku: "BLACK-TEE-L" }));
  markUnpaid(state, auctionInput(42));
  recordPaymentComplete(
    state,
    auctionInput(42, { soldPriceCents: 3500 }),
  );
  const unmapped = unmapVariation(state, auctionInput(42));

  assert.equal(unmapped.status, "unmapped_completed");
  assert.equal(unmapped.mappingStatus, "marked_unpaid");
  assert.equal(unmapped.sku, null);
  assert.equal(unmapped.soldPriceCents, 3500);
  assert.equal(unmapped.committedUnitCostCents, null);
  assert.deepEqual(unmapped.conflicts, [
    { code: "payment_completed_after_marked_unpaid" },
  ]);

  const restoredState = hydrateReconciliationState(
    JSON.parse(JSON.stringify(state)),
  );
  const restored = getAuction(restoredState, auctionInput(42));
  const summary = calculateSummary(restoredState, { streamId: STREAM_ONE });

  assert.deepEqual(restored.conflicts, unmapped.conflicts);
  assert.equal(summary.totals.completedPaymentCount, 1);
  assert.equal(summary.totals.completedGmvCents, 3500);
  assert.equal(summary.totals.committedSalesCount, 0);
  assert.equal(summary.totals.conflictCount, 1);
});

test("a late payment remains authoritative after an unpaid item was unmapped", () => {
  const state = createState();

  mapVariation(state, auctionInput(43, { sku: "BLACK-TEE-L" }));
  markUnpaid(state, auctionInput(43));
  unmapVariation(state, auctionInput(43));
  const completed = recordPaymentComplete(
    state,
    auctionInput(43, { soldPriceCents: 3500 }),
  );
  const summary = calculateSummary(state, { streamId: STREAM_ONE });

  assert.equal(completed.status, "unmapped_completed");
  assert.equal(completed.mappingStatus, "marked_unpaid");
  assert.equal(completed.sku, null);
  assert.equal(completed.soldPriceCents, 3500);
  assert.deepEqual(completed.conflicts, [
    { code: "payment_completed_after_marked_unpaid" },
  ]);
  assert.equal(summary.totals.completedPaymentCount, 1);
  assert.equal(summary.totals.completedGmvCents, 3500);
  assert.equal(summary.totals.committedSalesCount, 0);
  assert.equal(summary.totals.conflictCount, 1);
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

test("cannot mark an observed unpriced TikTok completion unpaid", () => {
  const state = createState();

  mapVariation(state, auctionInput(42, { sku: "BLACK-TEE-M" }));
  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 42,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      },
    ],
  });
  const stateBefore = JSON.parse(JSON.stringify(state));

  assertErrorCode(
    () => markUnpaid(state, auctionInput(42)),
    "PAYMENT_ALREADY_COMPLETE",
  );
  assert.deepEqual(state, stateBefore);

  const summary = calculateSummary(state, { streamId: STREAM_ONE });
  const inventory = inventoryItem(summary, "BLACK-TEE-M");

  assert.equal(inventory.remainingQuantity, 2);
  assert.equal(inventory.reservedQuantity, 0);
  assert.equal(summary.auctions[0].status, "mapped");
  assert.equal(summary.totals.markedUnpaidCount, 0);
});

test("cannot locally mark a canceled TikTok payment unpaid", () => {
  const state = createState();

  mapVariation(state, auctionInput(44, { sku: "BLACK-TEE-M" }));
  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 44,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const beforeRejectedMark = JSON.parse(JSON.stringify(state));

  assertErrorCode(
    () => markUnpaid(state, auctionInput(44)),
    "PAYMENT_ALREADY_CANCELED",
  );
  assert.deepEqual(state, beforeRejectedMark);
  assert.equal(getAuction(state, auctionInput(44)).status, "canceled");
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

test("rejects unmapping an unknown variation without creating state", () => {
  const state = createState();

  assertErrorCode(
    () => unmapVariation(state, auctionInput(61)),
    "UNKNOWN_VARIATION",
  );
  assert.equal(state.streams.length, 0);
});

test("historical completed corrections may record real sales beyond stock", () => {
  const state = createState();

  for (const variationNumber of [70, 71]) {
    recordPaymentComplete(
      state,
      auctionInput(variationNumber, { soldPriceCents: 2000 }),
    );
    mapVariation(
      state,
      auctionInput(variationNumber, { sku: "BLACK-TEE-L" }),
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

test("canceled and marked-unpaid history can be mapped when stock is reserved", () => {
  const state = createState();

  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 72,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  mapVariation(state, auctionInput(73, { sku: "BLACK-TEE-M" }));
  markUnpaid(state, auctionInput(73));
  unmapVariation(state, auctionInput(73));
  observePendingPayment(state, 74);
  mapVariation(state, auctionInput(74, { sku: "BLACK-TEE-L" }));

  const canceledMapping = mapVariation(
    state,
    auctionInput(72, { sku: "BLACK-TEE-L" }),
  );
  const unpaidMapping = mapVariation(
    state,
    auctionInput(73, { sku: "BLACK-TEE-L" }),
  );

  assert.equal(canceledMapping.status, "canceled");
  assert.equal(canceledMapping.sku, "BLACK-TEE-L");
  assert.equal(unpaidMapping.status, "marked_unpaid");
  assert.equal(unpaidMapping.sku, "BLACK-TEE-L");
  assert.equal(
    getInventoryAvailability(state, { sku: "BLACK-TEE-L" }).reservedQuantity,
    1,
  );
});

test("hydrates a detached state after a JSON storage round trip", () => {
  const state = createState();

  mapVariation(state, auctionInput(80, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(state, auctionInput(80, { soldPriceCents: 4800 }));

  const serializedState = JSON.parse(JSON.stringify(state));
  const restoredState = hydrateReconciliationState(serializedState);
  const summary = calculateSummary(restoredState, { streamId: STREAM_ONE });

  assert.deepEqual(restoredState, state);
  assert.notEqual(restoredState, serializedState);
  assert.notEqual(
    restoredState.inventoryBaselines,
    serializedState.inventoryBaselines,
  );
  assert.notEqual(
    restoredState.inventoryBaselines[0].inventory,
    serializedState.inventoryBaselines[0].inventory,
  );
  assert.notEqual(restoredState.streams, serializedState.streams);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.equal(summary.totals.profitCents, 3600);

  restoredState.inventoryBaselines[0].inventory[0].item =
    "Changed after hydration";
  assert.equal(
    serializedState.inventoryBaselines[0].inventory[0].item,
    "Black Tee",
  );
});

test("round-trips a migrated legacy baseline whose historical size is blank", () => {
  const legacy = {
    version: 3,
    inventory: [{
      sku: "ONE-SIZE-LEGACY",
      name: "Legacy one-size item",
      size: "",
      quantityReceived: 1,
      unitCostCents: 500,
    }],
    streams: [],
  };

  const migrated = hydrateReconciliationState(legacy);

  assert.equal(activeBaseline(migrated).inventory[0].size, "");
  assert.deepEqual(
    hydrateReconciliationState(JSON.parse(JSON.stringify(migrated))),
    migrated,
  );
});

test("strictly migrates detached legacy v1 auctions into canonical v6", () => {
  const state = createState();

  observeVariations(state, {
    streamId: STREAM_ONE,
    variationNumbers: [70],
  });
  mapVariation(state, auctionInput(71, { sku: "BLACK-TEE-M" }));
  recordPaymentComplete(
    state,
    auctionInput(71, { soldPriceCents: 4800 }),
  );
  const legacy = toLegacyState(state, 1);
  legacy.streams.forEach((stream) => {
    stream.variations.forEach((auction) => {
      delete auction.observedPaymentStatus;
    });
  });

  const migrated = hydrateReconciliationState(legacy);

  assert.equal(migrated.version, STATE_VERSION);
  assert.deepEqual(
    migrated.streams[0].variations.map((auction) => ({
      variationNumber: auction.variationNumber,
      paymentStatus: auction.paymentStatus,
      observedPaymentStatus: auction.observedPaymentStatus,
    })),
    [
      {
        variationNumber: 70,
        paymentStatus: "unknown",
        observedPaymentStatus: "not_observed",
      },
      {
        variationNumber: 71,
        paymentStatus: "payment_complete",
        observedPaymentStatus: "payment_complete",
      },
    ],
  );
  assert.notEqual(migrated, legacy);
  assert.notEqual(migrated.streams, legacy.streams);

  migrated.streams[0].variations[0].observedPaymentStatus = "payment_failed";
  assert.equal(legacy.streams[0].variations[0].observedPaymentStatus, undefined);
});

test("migrates v2 canceled observations while retaining payment failures as unknown", () => {
  const state = createState();

  observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 72,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
      {
        variationNumber: 73,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const v2State = toLegacyState(state, 2);
  v2State.streams[0].variations[1].paymentStatus = "unknown";

  const migrated = hydrateReconciliationState(v2State);

  assert.equal(migrated.version, STATE_VERSION);
  assert.deepEqual(
    migrated.streams[0].variations.map((auction) => ({
      variationNumber: auction.variationNumber,
      paymentStatus: auction.paymentStatus,
      observedPaymentStatus: auction.observedPaymentStatus,
    })),
    [
      {
        variationNumber: 72,
        paymentStatus: "unknown",
        observedPaymentStatus: "payment_failed",
      },
      {
        variationNumber: 73,
        paymentStatus: "canceled",
        observedPaymentStatus: "canceled",
      },
    ],
  );
  assert.equal(v2State.streams[0].variations[1].paymentStatus, "unknown");
});

test("keeps legacy payment-era and canonical v6 auction shapes strict", () => {
  const state = createState();

  observeVariations(state, {
    streamId: STREAM_ONE,
    variationNumbers: [72],
  });
  const legacyWithV2Field = toLegacyState(state, 1);
  const missingV2Field = toLegacyState(state, 3);
  delete missingV2Field.streams[0].variations[0].observedPaymentStatus;
  const unsupportedObservedStatus = JSON.parse(JSON.stringify(state));
  unsupportedObservedStatus.streams[0].variations[0].observedPaymentStatus =
    "payment_pending";
  const legacyWithUnknownStatus = toLegacyState(state, 1);
  delete legacyWithUnknownStatus.streams[0].variations[0]
    .observedPaymentStatus;
  legacyWithUnknownStatus.streams[0].variations[0].paymentStatus =
    "payment_pending";
  const v2WithCanonicalCanceled = toLegacyState(state, 2);
  v2WithCanonicalCanceled.streams[0].variations[0].paymentStatus = "canceled";
  v2WithCanonicalCanceled.streams[0].variations[0]
    .observedPaymentStatus = "canceled";
  const v3UnknownObservedCanceled = toLegacyState(state, 3);
  v3UnknownObservedCanceled.streams[0].variations[0]
    .observedPaymentStatus = "canceled";
  const v3CanceledObservedFailed = toLegacyState(state, 3);
  v3CanceledObservedFailed.streams[0].variations[0].paymentStatus = "canceled";
  v3CanceledObservedFailed.streams[0].variations[0]
    .observedPaymentStatus = "payment_failed";
  const v2WithV3Conflict = createState();
  observePaymentStatuses(v2WithV3Conflict, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 73,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  recordPaymentComplete(
    v2WithV3Conflict,
    auctionInput(73, { soldPriceCents: 2500 }),
  );
  const v2ConflictState = toLegacyState(v2WithV3Conflict, 2);

  assertErrorCode(
    () => hydrateReconciliationState(legacyWithV2Field),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(missingV2Field),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(unsupportedObservedStatus),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(legacyWithUnknownStatus),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(v2WithCanonicalCanceled),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(v3UnknownObservedCanceled),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(v3CanceledObservedFailed),
    "INVALID_STATE",
  );
  assertErrorCode(
    () => hydrateReconciliationState(v2ConflictState),
    "INVALID_STATE",
  );
});

test("rejects unsupported and malformed persisted state", () => {
  const unsupportedState = createState();
  unsupportedState.version = STATE_VERSION + 1;

  assertErrorCode(
    () => hydrateReconciliationState(unsupportedState),
    "UNSUPPORTED_STATE_VERSION",
  );

  const malformedState = createState();
  activeBaseline(malformedState).inventory[0].quantityOnHandAtImport = "2";

  assertErrorCode(
    () => hydrateReconciliationState(malformedState),
    "INVALID_STATE",
  );
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

test("revalidates the normalized inventory contract at baseline creation", () => {
  const validInventory = [{
    sku: "BLACK-TEE-M",
    item: "Black Tee",
    style: "black",
    size: "M",
    quantityOnHandAtImport: 2,
    unitCostCents: 1200,
  }];
  const invalidInventories = [
    [{ ...validInventory[0], sku: "black tee" }],
    [{ ...validInventory[0], item: " Black Tee" }],
    [{ ...validInventory[0], item: "=IMPORTDATA(\"https://example.test\")" }],
    [{ ...validInventory[0], style: "=1+1" }],
    [{ ...validInventory[0], size: "=M" }],
    [{ ...validInventory[0], style: "black\u0007" }],
    [{ ...validInventory[0], size: "" }],
    [{
      ...validInventory[0],
      quantityOnHandAtImport: Number.MAX_SAFE_INTEGER,
      unitCostCents: 2,
    }],
    [
      validInventory[0],
      { ...validInventory[0], sku: "BLACK-TEE-M-SECOND" },
    ],
  ];

  invalidInventories.forEach((inventory, index) => {
    const state = createState();
    const before = JSON.parse(JSON.stringify(state));

    assertErrorCode(
      () => createInventoryBaseline(state, {
        baselineId:
          `inventory-baseline:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        sourceFingerprint: "fnv1a64:1234567890abcdef",
        inventory,
      }),
      "INVALID_INVENTORY_BASELINE",
    );
    assert.deepEqual(state, before);
  });
});

test("keeps imported SKU identities stable across immutable baselines", () => {
  const state = createState();
  const firstInventory = [{
    sku: "BLACK-TEE-M",
    item: "Black Tee",
    style: "black",
    size: "M",
    quantityOnHandAtImport: 2,
    unitCostCents: 1200,
  }];

  createInventoryBaseline(state, {
    baselineId: "inventory-baseline:10000000-0000-4000-8000-000000000000",
    sourceFingerprint: "fnv1a64:1234567890abcdef",
    inventory: firstInventory,
  });
  const before = JSON.parse(JSON.stringify(state));

  assertErrorCode(
    () => createInventoryBaseline(state, {
      baselineId: "inventory-baseline:20000000-0000-4000-8000-000000000000",
      sourceFingerprint: "fnv1a64:2234567890abcdef",
      inventory: [{ ...firstInventory[0], style: "white" }],
    }),
    "SKU_IDENTITY_CONFLICT",
  );
  assertErrorCode(
    () => createInventoryBaseline(state, {
      baselineId: "inventory-baseline:30000000-0000-4000-8000-000000000000",
      sourceFingerprint: "fnv1a64:3234567890abcdef",
      inventory: [{ ...firstInventory[0], sku: "OTHER-SKU" }],
    }),
    "INVENTORY_IDENTITY_CONFLICT",
  );
  assert.deepEqual(state, before);
});

test("strict hydration preserves baseline provenance and imported contract invariants", () => {
  const createImportedState = () => {
    const state = createState();

    createInventoryBaseline(state, {
      baselineId: "inventory-baseline:40000000-0000-4000-8000-000000000000",
      sourceFingerprint: "fnv1a64:4234567890abcdef",
      inventory: [{
        sku: "BLACK-TEE-M",
        item: "Black Tee",
        style: "black",
        size: "M",
        quantityOnHandAtImport: 2,
        unitCostCents: 1200,
      }],
    });
    return state;
  };
  const importedWithoutSource = createImportedState();
  activeBaseline(importedWithoutSource).sourceFingerprint = null;
  const legacyWithImportedSource = createImportedState();
  legacyWithImportedSource.inventoryBaselines[0].sourceFingerprint =
    "fnv1a64:5234567890abcdef";
  const emptyImport = createImportedState();
  activeBaseline(emptyImport).inventory = [];
  const noncanonicalImport = createImportedState();
  activeBaseline(noncanonicalImport).inventory[0].item = " Black Tee";
  const formulaLikeImport = createImportedState();
  activeBaseline(formulaLikeImport).inventory[0].style = "=1+1";

  [
    importedWithoutSource,
    legacyWithImportedSource,
    emptyImport,
    noncanonicalImport,
    formulaLikeImport,
  ].forEach((state) => {
    assertErrorCode(
      () => hydrateReconciliationState(state),
      "INVALID_STATE",
    );
  });
});
