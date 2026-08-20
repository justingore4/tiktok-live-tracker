const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const streamReport = require("../extension/shared/stream-report.js");

const STREAM_ID =
  "local-stream:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STARTED_AT = "2026-08-20T18:00:00.000Z";
const ENDED_AT = "2026-08-20T19:00:00.000Z";
const GENERATED_AT = "2026-08-20T19:00:01.000Z";

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

function mapAndComplete(state, variationNumber, sku, soldPriceCents) {
  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber,
    sku,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber,
    soldPriceCents,
  });
}

function buildReport(inventory, completedSales) {
  const state = reconciliation.createReconciliationState(inventory);

  completedSales.forEach(({ variationNumber, sku, soldPriceCents }) => {
    mapAndComplete(state, variationNumber, sku, soldPriceCents);
  });

  return streamReport.createStreamReport({
    reconciliation,
    reconciliationState: state,
    streamId: STREAM_ID,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    generatedAt: GENERATED_AT,
  });
}

function buildPerformanceReport() {
  return buildReport(
    [
      inventoryEntry("A-SHIRT-S", "Shirt", "red", "S", 5, 500),
      inventoryEntry("B-SHIRT-M", "Shirt", "red", "M", 5, 800),
      inventoryEntry("C-JACKET-L", "Jacket", "black", "L", 5, 300),
      inventoryEntry("Z-UNSOLD-OS", "Hat", "", "OS", 5, 250),
    ],
    [
      { variationNumber: 1, sku: "A-SHIRT-S", soldPriceCents: 1500 },
      { variationNumber: 2, sku: "A-SHIRT-S", soldPriceCents: 1500 },
      { variationNumber: 3, sku: "B-SHIRT-M", soldPriceCents: 1000 },
      { variationNumber: 4, sku: "C-JACKET-L", soldPriceCents: 2000 },
    ],
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertReportError(action, code) {
  assert.throws(
    action,
    (error) =>
      error instanceof streamReport.StreamReportError && error.code === code,
  );
}

test("corrects one saved report and recalculates every cost-derived fact", () => {
  const original = buildPerformanceReport();
  const originalSnapshot = clone(original);
  const corrected = streamReport.correctReportUnitCost(original, {
    sku: "A-SHIRT-S",
    unitCostCents: 1200,
  });

  assert.deepEqual(original, originalSnapshot);
  assert.notEqual(corrected, original);
  assert.equal(corrected.reportId, original.reportId);
  assert.deepEqual(corrected.metadata, original.metadata);
  assert.deepEqual(corrected.completeness, original.completeness);
  assert.deepEqual(corrected.warnings, original.warnings);
  assert.equal(corrected.metadata.generatedAt, GENERATED_AT);

  assert.deepEqual(
    corrected.completedSales.map((sale) => ({
      variationNumber: sale.variationNumber,
      sku: sale.sku,
      soldPriceCents: sale.soldPriceCents,
      unitCostCents: sale.unitCostCents,
      grossProfitCents: sale.grossProfitCents,
      conflicts: sale.conflicts,
    })),
    [
      {
        variationNumber: 1,
        sku: "A-SHIRT-S",
        soldPriceCents: 1500,
        unitCostCents: 1200,
        grossProfitCents: 300,
        conflicts: [],
      },
      {
        variationNumber: 2,
        sku: "A-SHIRT-S",
        soldPriceCents: 1500,
        unitCostCents: 1200,
        grossProfitCents: 300,
        conflicts: [],
      },
      {
        variationNumber: 3,
        sku: "B-SHIRT-M",
        soldPriceCents: 1000,
        unitCostCents: 800,
        grossProfitCents: 200,
        conflicts: [],
      },
      {
        variationNumber: 4,
        sku: "C-JACKET-L",
        soldPriceCents: 2000,
        unitCostCents: 300,
        grossProfitCents: 1700,
        conflicts: [],
      },
    ],
  );

  const correctedSku = corrected.itemPerformance.find(
    (item) => item.sku === "A-SHIRT-S",
  );
  assert.deepEqual(
    {
      soldQuantity: correctedSku.soldQuantity,
      revenueCents: correctedSku.revenueCents,
      costOfGoodsCents: correctedSku.costOfGoodsCents,
      grossProfitCents: correctedSku.grossProfitCents,
    },
    {
      soldQuantity: 2,
      revenueCents: 3000,
      costOfGoodsCents: 2400,
      grossProfitCents: 600,
    },
  );
  const shirt = corrected.productPerformance.find(
    (product) => product.item === "Shirt",
  );
  assert.deepEqual(
    {
      soldQuantity: shirt.soldQuantity,
      revenueCents: shirt.revenueCents,
      costOfGoodsCents: shirt.costOfGoodsCents,
      grossProfitCents: shirt.grossProfitCents,
    },
    {
      soldQuantity: 3,
      revenueCents: 4000,
      costOfGoodsCents: 3200,
      grossProfitCents: 800,
    },
  );
  assert.equal(corrected.totals.costOfGoodsCents, 3500);
  assert.equal(corrected.totals.grossProfitCents, 2500);
  assert.equal(corrected.totals.committedRevenueCents, 6000);
  assert.deepEqual(
    corrected.topItems.mostProfitable.items.map((item) => item.sku),
    ["C-JACKET-L"],
  );
  assert.equal(corrected.topItems.mostProfitable.value, 1700);
  assert.deepEqual(
    corrected.topProducts.mostProfitable.items.map((item) => item.item),
    ["Jacket"],
  );
  assert.equal(corrected.topProducts.mostProfitable.value, 1700);
  assert.deepEqual(corrected.topItems.mostSold, original.topItems.mostSold);
  assert.deepEqual(
    corrected.topProducts.mostSold,
    original.topProducts.mostSold,
  );

  const correctedInventory = corrected.inventory.find(
    (item) => item.sku === "A-SHIRT-S",
  );
  const correctedSheetRow = corrected.sheetRows.find(
    (row) => row.sku === "A-SHIRT-S",
  );
  assert.equal(correctedInventory.unitCostCents, 1200);
  assert.equal(correctedSheetRow.unit_cost, "12.00");
  assert.equal(correctedInventory.replacementQuantity, 3);
  assert.match(
    streamReport.serializeInventoryCsv(corrected),
    /A-SHIRT-S,Shirt,red,S,3,12\.00/,
  );

  const invariantTotalKeys = Object.keys(original.totals).filter(
    (key) => !["costOfGoodsCents", "grossProfitCents"].includes(key),
  );
  invariantTotalKeys.forEach((key) => {
    assert.deepEqual(corrected.totals[key], original.totals[key]);
  });
  corrected.inventory.forEach((row, index) => {
    const originalRow = original.inventory[index];
    const { unitCostCents: _correctedCost, ...correctedFacts } = row;
    const { unitCostCents: _originalCost, ...originalFacts } = originalRow;
    assert.deepEqual(correctedFacts, originalFacts);
  });
  assert.ok(Object.isFrozen(corrected));
  assert.ok(Object.isFrozen(corrected.itemPerformance));
  assert.ok(Object.isFrozen(corrected.completedSales[0]));
  assert.deepEqual(streamReport.hydrateStreamReport(corrected), corrected);
});

test("corrects an unsold SKU for this report export without changing metrics", () => {
  const original = buildPerformanceReport();
  const corrected = streamReport.correctReportUnitCost(original, {
    sku: "Z-UNSOLD-OS",
    unitCostCents: Number.MAX_SAFE_INTEGER,
  });

  assert.deepEqual(corrected.totals, original.totals);
  assert.deepEqual(corrected.completedSales, original.completedSales);
  assert.deepEqual(corrected.itemPerformance, original.itemPerformance);
  assert.deepEqual(corrected.productPerformance, original.productPerformance);
  assert.deepEqual(corrected.topItems, original.topItems);
  assert.deepEqual(corrected.topProducts, original.topProducts);
  assert.equal(
    corrected.inventory.find((item) => item.sku === "Z-UNSOLD-OS")
      .unitCostCents,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    corrected.sheetRows.find((row) => row.sku === "Z-UNSOLD-OS").unit_cost,
    "90071992547409.91",
  );
});

test("unit-cost correction preserves canceled-order reference mappings", () => {
  const state = reconciliation.createReconciliationState([
    inventoryEntry("A-SHIRT-S", "Shirt", "red", "S", 5, 500),
  ]);
  mapAndComplete(state, 1, "A-SHIRT-S", 1500);
  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 2,
    sku: "A-SHIRT-S",
  });
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [{
      variationNumber: 2,
      observedPaymentStatus:
        reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
    }],
  });
  const original = streamReport.createStreamReport({
    reconciliation,
    reconciliationState: state,
    streamId: STREAM_ID,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    generatedAt: GENERATED_AT,
  });

  const corrected = streamReport.correctReportUnitCost(original, {
    sku: "A-SHIRT-S",
    unitCostCents: 700,
  });

  assert.deepEqual(corrected.canceledOrders, original.canceledOrders);
  assert.equal(corrected.totals.canceledOrderCount, 1);
  assert.equal(corrected.inventory[0].replacementQuantity, 4);
  assert.equal(corrected.sheetRows[0].quantity_on_hand_at_import, 4);
});

test("accepts a zero-dollar cost and remains idempotent for a repeated correction", () => {
  const original = buildPerformanceReport();
  const zeroCost = streamReport.correctReportUnitCost(original, {
    sku: "A-SHIRT-S",
    unitCostCents: 0,
  });
  const repeated = streamReport.correctReportUnitCost(zeroCost, {
    sku: "A-SHIRT-S",
    unitCostCents: 0,
  });

  assert.equal(zeroCost.totals.costOfGoodsCents, 1100);
  assert.equal(zeroCost.totals.grossProfitCents, 4900);
  assert.equal(
    zeroCost.itemPerformance.find((item) => item.sku === "A-SHIRT-S")
      .grossProfitCents,
    3000,
  );
  assert.deepEqual(repeated, zeroCost);
  assert.notEqual(repeated, zeroCost);
  assert.ok(Object.isFrozen(repeated));
});

test("re-ranks losses by the least-negative SKU and product profit", () => {
  const original = buildReport(
    [
      inventoryEntry("LOSS-A", "Alpha", "", "OS", 2, 1000),
      inventoryEntry("LOSS-B", "Beta", "", "OS", 2, 1000),
    ],
    [
      { variationNumber: 1, sku: "LOSS-A", soldPriceCents: 500 },
      { variationNumber: 2, sku: "LOSS-B", soldPriceCents: 600 },
    ],
  );
  const corrected = streamReport.correctReportUnitCost(original, {
    sku: "LOSS-B",
    unitCostCents: 2000,
  });

  assert.equal(corrected.totals.grossProfitCents, -1900);
  assert.equal(corrected.topItems.mostProfitable.value, -500);
  assert.deepEqual(
    corrected.topItems.mostProfitable.items.map((item) => item.sku),
    ["LOSS-A"],
  );
  assert.equal(corrected.topProducts.mostProfitable.value, -500);
  assert.deepEqual(
    corrected.topProducts.mostProfitable.items.map((item) => item.item),
    ["Alpha"],
  );
});

test("strictly rejects malformed, unknown, and arithmetically unsafe corrections atomically", () => {
  const original = buildPerformanceReport();
  const before = clone(original);

  for (const input of [
    null,
    {},
    { sku: "A-SHIRT-S", unitCostCents: 500, extra: true },
    { sku: " A-SHIRT-S", unitCostCents: 500 },
    { sku: "A-SHIRT-S", unitCostCents: -1 },
    { sku: "A-SHIRT-S", unitCostCents: 1.5 },
    { sku: "A-SHIRT-S", unitCostCents: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assertReportError(
      () => streamReport.correctReportUnitCost(original, input),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(original, before);
  }

  assertReportError(
    () =>
      streamReport.correctReportUnitCost(original, {
        sku: "MISSING-SKU",
        unitCostCents: 500,
      }),
    "UNKNOWN_SKU",
  );
  assert.deepEqual(original, before);

  assertReportError(
    () =>
      streamReport.correctReportUnitCost(original, {
        sku: "A-SHIRT-S",
        unitCostCents: Number.MAX_SAFE_INTEGER,
      }),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(original, before);
});
