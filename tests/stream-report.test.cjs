const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const streamReport = require("../extension/shared/stream-report.js");

const STARTED_AT = "2026-08-10T00:00:00.000Z";
const ENDED_AT = "2026-08-10T01:00:00.000Z";
const GENERATED_AT = "2026-08-10T01:00:01.000Z";
const STREAM_ONE =
  "local-stream:11111111-1111-4111-8111-111111111111";
const STREAM_TWO =
  "local-stream:22222222-2222-4222-8222-222222222222";

function inventoryEntry(
  sku,
  item,
  style,
  size,
  quantityReceived,
  unitCostCents,
) {
  return {
    sku,
    item,
    style,
    size,
    quantityReceived,
    unitCostCents,
  };
}

function createState(inventory = [
  inventoryEntry("TEE-BLACK-L", "Tee", "black", "L", 3, 1000),
  inventoryEntry("HOODIE-GREY-M", "Hoodie", "grey", "M", 4, 1500),
  inventoryEntry("JACKET-BROWN-S", "Jacket", "brown", "S", 2, 2000),
]) {
  return reconciliation.createReconciliationState(inventory);
}

function auction(streamId, variationNumber, extra = {}) {
  return { streamId, variationNumber, ...extra };
}

function mapAndComplete(state, streamId, variationNumber, sku, soldPriceCents) {
  reconciliation.mapVariation(
    state,
    auction(streamId, variationNumber, { sku }),
  );
  reconciliation.recordPaymentComplete(
    state,
    auction(streamId, variationNumber, { soldPriceCents }),
  );
}

function buildReport(state, streamId = STREAM_ONE) {
  return streamReport.createStreamReport({
    reconciliation,
    reconciliationState: state,
    streamId,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    generatedAt: GENERATED_AT,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertReportError(action, code = "INVALID_REPORT") {
  assert.throws(
    action,
    (error) =>
      error instanceof streamReport.StreamReportError && error.code === code,
  );
}

test("builds a frozen final report with exact totals, completed rows, and top ties", () => {
  const state = createState();

  mapAndComplete(state, STREAM_ONE, 1, "TEE-BLACK-L", 2000);
  mapAndComplete(state, STREAM_ONE, 2, "HOODIE-GREY-M", 2500);
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 3,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$50.00",
  });

  const report = buildReport(state);

  assert.equal(report.version, 2);
  assert.equal(
    report.reportId,
    "stream-report:11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(report.metadata, {
    streamId: STREAM_ONE,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    generatedAt: GENERATED_AT,
    inventoryBaselineId: state.activeInventoryBaselineId,
    activeBiddingVariationNumber: null,
  });
  assert.deepEqual(report.completeness, {
    status: "final",
    reasonCodes: [],
  });
  assert.deepEqual(
    {
      completedPaymentCount: report.totals.completedPaymentCount,
      canceledOrderCount: report.totals.canceledOrderCount,
      completedGmvCents: report.totals.completedGmvCents,
      committedRevenueCents: report.totals.committedRevenueCents,
      costOfGoodsCents: report.totals.costOfGoodsCents,
      grossProfitCents: report.totals.grossProfitCents,
      attributedGmvDisplay: report.totals.attributedGmvDisplay,
    },
    {
      completedPaymentCount: 2,
      canceledOrderCount: 1,
      completedGmvCents: 4500,
      committedRevenueCents: 4500,
      costOfGoodsCents: 2500,
      grossProfitCents: 2000,
      attributedGmvDisplay: "$50.00",
    },
  );
  assert.deepEqual(
    report.topItems.mostSold.items.map((item) => item.sku),
    ["HOODIE-GREY-M", "TEE-BLACK-L"],
  );
  assert.equal(report.topItems.mostSold.value, 1);
  assert.deepEqual(
    report.topItems.mostProfitable.items.map((item) => item.sku),
    ["HOODIE-GREY-M", "TEE-BLACK-L"],
  );
  assert.equal(report.topItems.mostProfitable.value, 1000);
  assert.deepEqual(
    report.completedSales.map((sale) => ({
      variationNumber: sale.variationNumber,
      sku: sale.sku,
      soldPriceCents: sale.soldPriceCents,
      unitCostCents: sale.unitCostCents,
      grossProfitCents: sale.grossProfitCents,
    })),
    [
      {
        variationNumber: 1,
        sku: "TEE-BLACK-L",
        soldPriceCents: 2000,
        unitCostCents: 1000,
        grossProfitCents: 1000,
      },
      {
        variationNumber: 2,
        sku: "HOODIE-GREY-M",
        soldPriceCents: 2500,
        unitCostCents: 1500,
        grossProfitCents: 1000,
      },
    ],
  );
  assert.deepEqual(report.warnings, []);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.completedSales));
  assert.ok(Object.isFrozen(report.completedSales[0]));
});

test("snapshots mapped and unmapped canceled-order references without changing inventory or metrics", () => {
  const state = createState();

  mapAndComplete(state, STREAM_ONE, 1, "TEE-BLACK-L", 2000);
  reconciliation.mapVariation(
    state,
    auction(STREAM_ONE, 2, { sku: "HOODIE-GREY-M" }),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 2,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
      {
        variationNumber: 3,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });

  const report = buildReport(state);

  assert.deepEqual(report.canceledOrders, [
    {
      variationNumber: 2,
      mapped: true,
      sku: "HOODIE-GREY-M",
      item: "Hoodie",
      style: "grey",
      size: "M",
    },
    {
      variationNumber: 3,
      mapped: false,
      sku: null,
      item: null,
      style: null,
      size: null,
    },
  ]);
  assert.deepEqual(
    {
      completedPaymentCount: report.totals.completedPaymentCount,
      canceledOrderCount: report.totals.canceledOrderCount,
      completedGmvCents: report.totals.completedGmvCents,
      committedRevenueCents: report.totals.committedRevenueCents,
      costOfGoodsCents: report.totals.costOfGoodsCents,
      grossProfitCents: report.totals.grossProfitCents,
    },
    {
      completedPaymentCount: 1,
      canceledOrderCount: 2,
      completedGmvCents: 2000,
      committedRevenueCents: 2000,
      costOfGoodsCents: 1000,
      grossProfitCents: 1000,
    },
  );
  const canceledSku = report.inventory.find(
    (row) => row.sku === "HOODIE-GREY-M",
  );
  assert.equal(canceledSku.streamSoldQuantity, 0);
  assert.equal(canceledSku.pendingQuantity, 0);
  assert.equal(canceledSku.replacementQuantity, 4);
  assert.equal(report.sheetRows.find(
    (row) => row.sku === "HOODIE-GREY-M",
  ).quantity_on_hand_at_import, 4);
  assert.ok(Object.isFrozen(report.canceledOrders));
  assert.ok(Object.isFrozen(report.canceledOrders[0]));
});

test("marks unresolved, pending, fixing, unmatched, conflicting, and oversold reports provisional", () => {
  const state = createState([
    inventoryEntry("ZERO-STOCK", "Zero stock", "", "OS", 0, 500),
  ]);

  reconciliation.observeBiddingVariation(
    state,
    auction(STREAM_ONE, 10),
  );
  reconciliation.mapVariation(
    state,
    auction(STREAM_ONE, 10, { sku: "ZERO-STOCK" }),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 11,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
  });
  reconciliation.recordPaymentComplete(
    state,
    auction(STREAM_ONE, 12, { soldPriceCents: 1000 }),
  );
  reconciliation.recordPaymentComplete(
    state,
    auction(STREAM_ONE, 12, { soldPriceCents: 1100 }),
  );

  const report = buildReport(state);

  assert.equal(report.completeness.status, "provisional");
  assert.deepEqual(report.completeness.reasonCodes, [
    "active_bidding_at_end",
    "unresolved_orders",
    "pending_inventory_reservations",
    "payment_fixing_orders",
    "unmapped_completed_sales",
    "reconciliation_conflicts",
    "inventory_recount_required",
  ]);
  assert.equal(report.totals.unresolvedOrderCount, 2);
  assert.equal(report.totals.pendingMappedCount, 1);
  assert.equal(report.totals.paymentFixingCount, 1);
  assert.equal(report.totals.unmappedCompletedCount, 1);
  assert.equal(report.totals.conflictCount, 1);
  assert.equal(report.completedSales[0].mapped, false);
  assert.equal(report.completedSales[0].sku, null);
  assert.equal(report.completedSales[0].conflicts.length, 1);
  assert.deepEqual(report.warnings.at(-1), {
    code: "inventory_recount_required",
    count: 1,
    sku: "ZERO-STOCK",
  });
});

test("freezes baseline-wide replacement quantities while performance stays stream-scoped", () => {
  const state = createState([
    inventoryEntry("SHARED-SKU", "Shared item", "black", "L", 3, 800),
  ]);

  mapAndComplete(state, STREAM_ONE, 1, "SHARED-SKU", 2000);
  mapAndComplete(state, STREAM_TWO, 1, "SHARED-SKU", 2200);

  const report = buildReport(state, STREAM_ONE);
  const row = report.inventory[0];

  assert.equal(report.totals.completedPaymentCount, 1);
  assert.equal(report.itemPerformance[0].soldQuantity, 1);
  assert.equal(report.completedSales.length, 1);
  assert.deepEqual(
    {
      openingQuantity: row.openingQuantity,
      streamSoldQuantity: row.streamSoldQuantity,
      baselineSoldQuantity: row.baselineSoldQuantity,
      calculatedRemainingQuantity: row.calculatedRemainingQuantity,
      replacementQuantity: row.replacementQuantity,
    },
    {
      openingQuantity: 3,
      streamSoldQuantity: 1,
      baselineSoldQuantity: 2,
      calculatedRemainingQuantity: 1,
      replacementQuantity: 1,
    },
  );
  assert.equal(
    report.inventoryUpdateLines[0],
    "SKU: SHARED-SKU Updated count: 1",
  );
  assert.deepEqual(report.sheetRows[0], {
    sku: "SHARED-SKU",
    item: "Shared item",
    style: "black",
    size: "L",
    quantity_on_hand_at_import: 1,
    unit_cost: "8.00",
  });
});

test("groups product performance across sizes while retaining exact SKU rankings and ties", () => {
  const state = createState([
    inventoryEntry("TEE-BLACK-L", "Tee", "black", "L", 3, 1000),
    inventoryEntry("TEE-BLACK-M", "Tee", "black", "M", 3, 1200),
    inventoryEntry("HOODIE-GREY-S", "Hoodie", "grey", "S", 3, 1500),
  ]);

  mapAndComplete(state, STREAM_ONE, 1, "TEE-BLACK-L", 1500);
  mapAndComplete(state, STREAM_ONE, 2, "TEE-BLACK-M", 1700);
  mapAndComplete(state, STREAM_ONE, 3, "HOODIE-GREY-S", 2500);

  const report = buildReport(state);
  const tee = report.productPerformance.find(
    (product) => product.item === "Tee" && product.style === "black",
  );

  assert.deepEqual(tee, {
    item: "Tee",
    style: "black",
    skus: ["TEE-BLACK-L", "TEE-BLACK-M"],
    soldQuantity: 2,
    revenueCents: 3200,
    costOfGoodsCents: 2200,
    grossProfitCents: 1000,
  });
  assert.equal(report.topProducts.mostSold.value, 2);
  assert.deepEqual(report.topProducts.mostSold.items, [
    {
      item: "Tee",
      style: "black",
      skus: ["TEE-BLACK-L", "TEE-BLACK-M"],
    },
  ]);
  assert.equal(report.topProducts.mostProfitable.value, 1000);
  assert.deepEqual(
    report.topProducts.mostProfitable.items.map((product) => product.item),
    ["Hoodie", "Tee"],
  );
  assert.equal(report.topItems.mostProfitable.value, 1000);
  assert.deepEqual(
    report.topItems.mostProfitable.items.map((item) => item.sku),
    ["HOODIE-GREY-S"],
  );
});

test("clamps replacement quantity to zero and preserves the negative calculation and recount warning", () => {
  const state = createState([
    inventoryEntry("OVER-SKU", "Over item", "", "M", 0, 125),
  ]);

  mapAndComplete(state, STREAM_ONE, 1, "OVER-SKU", 500);

  const report = buildReport(state);
  const row = report.inventory[0];

  assert.equal(row.calculatedRemainingQuantity, -1);
  assert.equal(row.replacementQuantity, 0);
  assert.equal(row.oversoldQuantity, 1);
  assert.equal(row.requiresRecount, true);
  assert.equal(report.sheetRows[0].quantity_on_hand_at_import, 0);
  assert.equal(report.completeness.status, "provisional");
  assert.deepEqual(report.completeness.reasonCodes, [
    "inventory_recount_required",
  ]);
});

test("serializes deterministic six-column CSV and TSV with formula-safe text fields", () => {
  const state = createState([
    inventoryEntry(
      "SAFE-SKU",
      "=SUM(1,1)",
      "+black",
      "@L",
      2,
      1200,
    ),
  ]);

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 1,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });

  const report = buildReport(state);

  assert.equal(
    streamReport.serializeInventoryCsv(report),
    "sku,item,style,size,quantity_on_hand_at_import,unit_cost\r\n" +
      "SAFE-SKU,\"'=SUM(1,1)\",'+black,'@L,2,12.00\r\n",
  );
  assert.equal(
    streamReport.serializeInventoryTsv(report),
    "sku\titem\tstyle\tsize\tquantity_on_hand_at_import\tunit_cost\r\n" +
      "SAFE-SKU\t'=SUM(1,1)\t'+black\t'@L\t2\t12.00\r\n",
  );
  assert.deepEqual(report.sheetRows[0], {
    sku: "SAFE-SKU",
    item: "=SUM(1,1)",
    style: "+black",
    size: "@L",
    quantity_on_hand_at_import: 2,
    unit_cost: "12.00",
  });
});

test("strict hydration returns a detached deep-frozen report", () => {
  const state = createState();

  mapAndComplete(state, STREAM_ONE, 1, "TEE-BLACK-L", 2000);
  const source = clone(buildReport(state));
  const hydrated = streamReport.hydrateStreamReport(source);

  source.metadata.streamId = "changed";
  source.inventory[0].replacementQuantity = 999;

  assert.equal(hydrated.metadata.streamId, STREAM_ONE);
  assert.notEqual(hydrated.inventory[0].replacementQuantity, 999);
  assert.ok(Object.isFrozen(hydrated.metadata));
  assert.ok(Object.isFrozen(hydrated.inventory[0]));
  const frozenQuantity = hydrated.inventory[0].replacementQuantity;
  hydrated.inventory[0].replacementQuantity = 999;
  assert.equal(hydrated.inventory[0].replacementQuantity, frozenQuantity);
});

test("hydrates legacy reports without canceled-order details while retaining their canceled total", () => {
  const state = createState();

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 3,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const legacy = clone(buildReport(state));
  legacy.version = 1;
  delete legacy.canceledOrders;

  const hydrated = streamReport.hydrateStreamReport(legacy);

  assert.equal(hydrated.version, 2);
  assert.equal(hydrated.totals.canceledOrderCount, 1);
  assert.equal(hydrated.canceledOrders, null);
  assert.ok(Object.isFrozen(hydrated));
});

test("strict hydration rejects unsupported versions, extra fields, timestamp order, and inconsistent exports", () => {
  const state = createState();

  mapAndComplete(state, STREAM_ONE, 1, "TEE-BLACK-L", 2000);
  const valid = clone(buildReport(state));

  const future = clone(valid);
  future.version = 3;
  assertReportError(
    () => streamReport.hydrateStreamReport(future),
    "UNSUPPORTED_REPORT_VERSION",
  );

  const extra = clone(valid);
  extra.metadata.extra = true;
  assertReportError(() => streamReport.hydrateStreamReport(extra));

  const reversedTime = clone(valid);
  reversedTime.metadata.endedAt = "2026-08-09T23:00:00.000Z";
  assertReportError(() => streamReport.hydrateStreamReport(reversedTime));

  const wrongQuantity = clone(valid);
  wrongQuantity.inventory[0].replacementQuantity += 1;
  assertReportError(() => streamReport.hydrateStreamReport(wrongQuantity));

  const wrongSheet = clone(valid);
  wrongSheet.sheetRows[0].unit_cost = "99.00";
  assertReportError(() => streamReport.hydrateStreamReport(wrongSheet));

  const wrongTop = clone(valid);
  wrongTop.topItems.mostSold.value += 1;
  assertReportError(() => streamReport.hydrateStreamReport(wrongTop));

  const wrongProduct = clone(valid);
  wrongProduct.productPerformance[0].revenueCents += 1;
  wrongProduct.productPerformance[0].grossProfitCents += 1;
  assertReportError(() => streamReport.hydrateStreamReport(wrongProduct));

  const wrongSaleIdentity = clone(valid);
  wrongSaleIdentity.completedSales[0].item = "Wrong item";
  assertReportError(() =>
    streamReport.hydrateStreamReport(wrongSaleIdentity),
  );

  const wrongCanceledCount = clone(valid);
  wrongCanceledCount.canceledOrders = [];
  wrongCanceledCount.totals.canceledOrderCount = 1;
  assertReportError(() =>
    streamReport.hydrateStreamReport(wrongCanceledCount),
  );

  const canceledState = createState();
  reconciliation.mapVariation(
    canceledState,
    auction(STREAM_ONE, 2, { sku: "HOODIE-GREY-M" }),
  );
  reconciliation.observePaymentStatuses(canceledState, {
    streamId: STREAM_ONE,
    statuses: [{
      variationNumber: 2,
      observedPaymentStatus:
        reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
    }],
  });
  const wrongCanceledIdentity = clone(buildReport(canceledState));
  wrongCanceledIdentity.canceledOrders[0].item = "Wrong item";
  assertReportError(() =>
    streamReport.hydrateStreamReport(wrongCanceledIdentity),
  );
});

test("builder rejects unknown streams, malformed dependencies, and out-of-order timestamps", () => {
  const empty = createState();

  assertReportError(
    () => buildReport(empty),
    "UNKNOWN_STREAM",
  );

  assertReportError(
    () =>
      streamReport.createStreamReport({
        reconciliation: {},
        reconciliationState: empty,
        streamId: STREAM_ONE,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        generatedAt: GENERATED_AT,
      }),
    "INVALID_DEPENDENCY",
  );

  reconciliation.observePaymentStatuses(empty, {
    streamId: STREAM_ONE,
    statuses: [
      {
        variationNumber: 1,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });

  assertReportError(() =>
    streamReport.createStreamReport({
      reconciliation,
      reconciliationState: empty,
      streamId: STREAM_ONE,
      startedAt: ENDED_AT,
      endedAt: STARTED_AT,
      generatedAt: GENERATED_AT,
    }),
  );
});

test("derives the protocol report ID from the exact local-stream UUID", () => {
  assert.equal(
    streamReport.createReportIdForStream(STREAM_ONE),
    "stream-report:11111111-1111-4111-8111-111111111111",
  );
  assert.match(
    streamReport.createReportIdForStream(STREAM_TWO),
    streamReport.REPORT_ID_PATTERN,
  );
  assertReportError(() =>
    streamReport.createReportIdForStream(
      "stream-report:11111111-1111-4111-8111-111111111111",
    ),
  );
});
