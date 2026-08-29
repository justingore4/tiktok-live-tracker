const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const streamReport = require("../extension/shared/stream-report.js");

const STREAM_ID =
  "local-stream:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIOR_STREAM_ID =
  "local-stream:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STARTED_AT = "2026-08-29T18:00:00.000Z";
const ENDED_AT = "2026-08-29T19:00:00.000Z";
const GENERATED_AT = "2026-08-29T19:00:01.000Z";

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

function mapAndComplete(
  state,
  streamId,
  variationNumber,
  sku,
  soldPriceCents,
) {
  reconciliation.mapVariation(state, {
    streamId,
    variationNumber,
    sku,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId,
    variationNumber,
    soldPriceCents,
  });
}

function cancel(state, variationNumber, sku = null) {
  if (sku !== null) {
    reconciliation.mapVariation(state, {
      streamId: STREAM_ID,
      variationNumber,
      sku,
    });
  }

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
}

function createReport(state) {
  return streamReport.createStreamReport({
    reconciliation,
    reconciliationState: state,
    streamId: STREAM_ID,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    generatedAt: GENERATED_AT,
  });
}

function buildFixture() {
  const state = reconciliation.createReconciliationState([
    inventoryEntry("ALPHA-S", "Alpha", "red", "S", 3, 500),
    inventoryEntry("BETA-M", "Beta", "blue", "M", 2, 900),
    inventoryEntry("RUNNER-8", "Runner", "black", "8", 1, 700),
    inventoryEntry("RUNNER-9", "Runner", "black", "9", 2, 1100),
    inventoryEntry("ZERO-OS", "Zero", "", "OS", 0, 300),
  ]);

  mapAndComplete(state, PRIOR_STREAM_ID, 1, "ALPHA-S", 1000);
  mapAndComplete(state, STREAM_ID, 10, "ALPHA-S", 1500);
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 10,
    soldPriceCents: 1600,
  });
  mapAndComplete(state, STREAM_ID, 11, "BETA-M", 2000);
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 12,
    soldPriceCents: 1200,
  });
  cancel(state, 13, "ALPHA-S");
  cancel(state, 14);
  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_ID,
    attributedGmvDisplay: "$99.00",
  });

  return { state, report: createReport(state) };
}

function mappingChange(
  variationNumber,
  expectedStatus,
  expectedSku,
  sku,
) {
  return { variationNumber, expectedStatus, expectedSku, sku };
}

function bySku(rows, sku) {
  return rows.find((row) => row.sku === sku);
}

function byVariation(rows, variationNumber) {
  return rows.find((row) => row.variationNumber === variationNumber);
}

function assertReportError(action, code) {
  assert.throws(
    action,
    (error) =>
      error instanceof streamReport.StreamReportError && error.code === code,
  );
}

function assertDeepFrozen(value, visited = new Set()) {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }

  visited.add(value);
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach((child) => assertDeepFrozen(child, visited));
}

function assertStrictReport(report) {
  assert.deepEqual(streamReport.hydrateStreamReport(report), report);
  assertDeepFrozen(report);
}

function inventoryFacts(report) {
  return report.inventory.map((row) => ({
    sku: row.sku,
    streamSoldQuantity: row.streamSoldQuantity,
    baselineSoldQuantity: row.baselineSoldQuantity,
    pendingQuantity: row.pendingQuantity,
    calculatedRemainingQuantity: row.calculatedRemainingQuantity,
    replacementQuantity: row.replacementQuantity,
    availableAfterReservationsQuantity:
      row.availableAfterReservationsQuantity,
    oversoldQuantity: row.oversoldQuantity,
    requiresRecount: row.requiresRecount,
  }));
}

test("applies a mixed batch and rebuilds all mapping-derived report facts", () => {
  const { state, report: original } = buildFixture();
  const stateBefore = structuredClone(state);
  const originalBefore = structuredClone(original);
  const changes = [
    mappingChange(10, "payment_complete", "ALPHA-S", "RUNNER-9"),
    mappingChange(12, "payment_complete", null, "ALPHA-S"),
    mappingChange(13, "canceled", "ALPHA-S", "BETA-M"),
    mappingChange(14, "canceled", null, "RUNNER-8"),
  ];
  const changesBefore = structuredClone(changes);
  const corrected = streamReport.correctReportMappings(original, changes);
  const reversed = streamReport.correctReportMappings(
    original,
    [...changes].reverse(),
  );
  const repeated = streamReport.correctReportMappings(corrected, changes);

  assert.deepEqual(state, stateBefore);
  assert.deepEqual(original, originalBefore);
  assert.deepEqual(changes, changesBefore);
  assert.deepEqual(reversed, corrected);
  assert.deepEqual(repeated, corrected);
  assert.notEqual(corrected, original);
  assert.notEqual(repeated, corrected);
  assert.equal(corrected.reportId, original.reportId);
  assert.equal(corrected.version, original.version);
  assert.deepEqual(corrected.metadata, original.metadata);

  assert.deepEqual(
    corrected.completedSales.map((sale) => ({
      variationNumber: sale.variationNumber,
      mapped: sale.mapped,
      sku: sale.sku,
      item: sale.item,
      style: sale.style,
      size: sale.size,
      soldPriceCents: sale.soldPriceCents,
      unitCostCents: sale.unitCostCents,
      grossProfitCents: sale.grossProfitCents,
    })),
    [
      {
        variationNumber: 10,
        mapped: true,
        sku: "RUNNER-9",
        item: "Runner",
        style: "black",
        size: "9",
        soldPriceCents: 1500,
        unitCostCents: 1100,
        grossProfitCents: 400,
      },
      {
        variationNumber: 11,
        mapped: true,
        sku: "BETA-M",
        item: "Beta",
        style: "blue",
        size: "M",
        soldPriceCents: 2000,
        unitCostCents: 900,
        grossProfitCents: 1100,
      },
      {
        variationNumber: 12,
        mapped: true,
        sku: "ALPHA-S",
        item: "Alpha",
        style: "red",
        size: "S",
        soldPriceCents: 1200,
        unitCostCents: 500,
        grossProfitCents: 700,
      },
    ],
  );
  assert.deepEqual(
    byVariation(corrected.completedSales, 10).conflicts,
    byVariation(original.completedSales, 10).conflicts,
  );
  assert.deepEqual(corrected.canceledOrders, [
    {
      variationNumber: 13,
      mapped: true,
      sku: "BETA-M",
      item: "Beta",
      style: "blue",
      size: "M",
    },
    {
      variationNumber: 14,
      mapped: true,
      sku: "RUNNER-8",
      item: "Runner",
      style: "black",
      size: "8",
    },
  ]);

  assert.deepEqual(
    {
      committedSalesCount: corrected.totals.committedSalesCount,
      unmappedCompletedCount: corrected.totals.unmappedCompletedCount,
      committedRevenueCents: corrected.totals.committedRevenueCents,
      costOfGoodsCents: corrected.totals.costOfGoodsCents,
      grossProfitCents: corrected.totals.grossProfitCents,
    },
    {
      committedSalesCount: 3,
      unmappedCompletedCount: 0,
      committedRevenueCents: 4700,
      costOfGoodsCents: 2500,
      grossProfitCents: 2200,
    },
  );
  const invariantTotalKeys = Object.keys(original.totals).filter(
    (key) => ![
      "committedSalesCount",
      "unmappedCompletedCount",
      "committedRevenueCents",
      "costOfGoodsCents",
      "grossProfitCents",
    ].includes(key),
  );
  invariantTotalKeys.forEach((key) => {
    assert.deepEqual(corrected.totals[key], original.totals[key]);
  });

  assert.deepEqual(
    corrected.itemPerformance.map((item) => ({
      sku: item.sku,
      soldQuantity: item.soldQuantity,
      revenueCents: item.revenueCents,
      costOfGoodsCents: item.costOfGoodsCents,
      grossProfitCents: item.grossProfitCents,
    })),
    [
      {
        sku: "ALPHA-S",
        soldQuantity: 1,
        revenueCents: 1200,
        costOfGoodsCents: 500,
        grossProfitCents: 700,
      },
      {
        sku: "BETA-M",
        soldQuantity: 1,
        revenueCents: 2000,
        costOfGoodsCents: 900,
        grossProfitCents: 1100,
      },
      {
        sku: "RUNNER-8",
        soldQuantity: 0,
        revenueCents: 0,
        costOfGoodsCents: 0,
        grossProfitCents: 0,
      },
      {
        sku: "RUNNER-9",
        soldQuantity: 1,
        revenueCents: 1500,
        costOfGoodsCents: 1100,
        grossProfitCents: 400,
      },
      {
        sku: "ZERO-OS",
        soldQuantity: 0,
        revenueCents: 0,
        costOfGoodsCents: 0,
        grossProfitCents: 0,
      },
    ],
  );
  const runner = corrected.productPerformance.find(
    (product) => product.item === "Runner" && product.style === "black",
  );
  assert.deepEqual(
    {
      skus: runner.skus,
      soldQuantity: runner.soldQuantity,
      revenueCents: runner.revenueCents,
      costOfGoodsCents: runner.costOfGoodsCents,
      grossProfitCents: runner.grossProfitCents,
    },
    {
      skus: ["RUNNER-8", "RUNNER-9"],
      soldQuantity: 1,
      revenueCents: 1500,
      costOfGoodsCents: 1100,
      grossProfitCents: 400,
    },
  );
  assert.deepEqual(
    corrected.topItems.mostSold.items.map((item) => item.sku),
    ["ALPHA-S", "BETA-M", "RUNNER-9"],
  );
  assert.deepEqual(
    corrected.topItems.mostProfitable.items.map((item) => item.sku),
    ["BETA-M"],
  );
  assert.deepEqual(
    corrected.topProducts.mostSold.items.map((item) => item.item),
    ["Alpha", "Beta", "Runner"],
  );
  assert.deepEqual(
    corrected.topProducts.mostProfitable.items.map((item) => item.item),
    ["Beta"],
  );

  assert.deepEqual(inventoryFacts(corrected), [
    {
      sku: "ALPHA-S",
      streamSoldQuantity: 1,
      baselineSoldQuantity: 2,
      pendingQuantity: 0,
      calculatedRemainingQuantity: 1,
      replacementQuantity: 1,
      availableAfterReservationsQuantity: 1,
      oversoldQuantity: 0,
      requiresRecount: false,
    },
    {
      sku: "BETA-M",
      streamSoldQuantity: 1,
      baselineSoldQuantity: 1,
      pendingQuantity: 0,
      calculatedRemainingQuantity: 1,
      replacementQuantity: 1,
      availableAfterReservationsQuantity: 1,
      oversoldQuantity: 0,
      requiresRecount: false,
    },
    {
      sku: "RUNNER-8",
      streamSoldQuantity: 0,
      baselineSoldQuantity: 0,
      pendingQuantity: 0,
      calculatedRemainingQuantity: 1,
      replacementQuantity: 1,
      availableAfterReservationsQuantity: 1,
      oversoldQuantity: 0,
      requiresRecount: false,
    },
    {
      sku: "RUNNER-9",
      streamSoldQuantity: 1,
      baselineSoldQuantity: 1,
      pendingQuantity: 0,
      calculatedRemainingQuantity: 1,
      replacementQuantity: 1,
      availableAfterReservationsQuantity: 1,
      oversoldQuantity: 0,
      requiresRecount: false,
    },
    {
      sku: "ZERO-OS",
      streamSoldQuantity: 0,
      baselineSoldQuantity: 0,
      pendingQuantity: 0,
      calculatedRemainingQuantity: 0,
      replacementQuantity: 0,
      availableAfterReservationsQuantity: 0,
      oversoldQuantity: 0,
      requiresRecount: false,
    },
  ]);
  assert.deepEqual(
    corrected.sheetRows.map((row) => [
      row.sku,
      row.quantity_on_hand_at_import,
      row.unit_cost,
    ]),
    [
      ["ALPHA-S", 1, "5.00"],
      ["BETA-M", 1, "9.00"],
      ["RUNNER-8", 1, "7.00"],
      ["RUNNER-9", 1, "11.00"],
      ["ZERO-OS", 0, "3.00"],
    ],
  );
  assert.equal(
    corrected.inventoryUpdateLines[3],
    "SKU: RUNNER-9 Updated count: 1",
  );
  assert.match(
    streamReport.serializeInventoryCsv(corrected),
    /RUNNER-9,Runner,black,9,1,11\.00/,
  );
  assert.deepEqual(corrected.warnings, [
    { code: "reconciliation_conflicts", count: 1, sku: null },
  ]);
  assert.deepEqual(corrected.completeness, {
    status: "provisional",
    reasonCodes: ["reconciliation_conflicts"],
  });
  assertStrictReport(corrected);
  assertStrictReport(repeated);
});

test("maps and unmaps completed variations with idempotent allocation changes", () => {
  const { report: original } = buildFixture();
  const mapped = streamReport.correctReportMappings(original, [
    mappingChange(12, "payment_complete", null, "BETA-M"),
  ]);

  assert.equal(byVariation(mapped.completedSales, 12).sku, "BETA-M");
  assert.equal(byVariation(mapped.completedSales, 12).unitCostCents, 900);
  assert.equal(byVariation(mapped.completedSales, 12).grossProfitCents, 300);
  assert.equal(mapped.totals.committedSalesCount, 3);
  assert.equal(mapped.totals.unmappedCompletedCount, 0);
  assert.equal(mapped.totals.committedRevenueCents, 4700);
  assert.equal(mapped.totals.costOfGoodsCents, 2300);
  assert.equal(mapped.totals.grossProfitCents, 2400);
  assert.equal(bySku(mapped.inventory, "BETA-M").streamSoldQuantity, 2);
  assert.equal(bySku(mapped.inventory, "BETA-M").baselineSoldQuantity, 2);
  assert.equal(bySku(mapped.inventory, "BETA-M").replacementQuantity, 0);

  const unmapped = streamReport.correctReportMappings(original, [
    mappingChange(11, "payment_complete", "BETA-M", null),
  ]);
  const repeated = streamReport.correctReportMappings(unmapped, [
    mappingChange(11, "payment_complete", "BETA-M", null),
  ]);

  assert.deepEqual(byVariation(unmapped.completedSales, 11), {
    variationNumber: 11,
    mapped: false,
    sku: null,
    item: null,
    style: null,
    size: null,
    soldPriceCents: 2000,
    unitCostCents: null,
    grossProfitCents: null,
    conflicts: [],
  });
  assert.equal(unmapped.totals.committedSalesCount, 1);
  assert.equal(unmapped.totals.unmappedCompletedCount, 2);
  assert.equal(unmapped.totals.committedRevenueCents, 1500);
  assert.equal(unmapped.totals.costOfGoodsCents, 500);
  assert.equal(unmapped.totals.grossProfitCents, 1000);
  assert.equal(bySku(unmapped.inventory, "BETA-M").streamSoldQuantity, 0);
  assert.equal(bySku(unmapped.inventory, "BETA-M").baselineSoldQuantity, 0);
  assert.equal(bySku(unmapped.inventory, "BETA-M").replacementQuantity, 2);
  assert.deepEqual(repeated, unmapped);

  const restored = streamReport.correctReportMappings(unmapped, [
    mappingChange(11, "payment_complete", null, "BETA-M"),
  ]);
  assert.deepEqual(restored, original);
  assertStrictReport(mapped);
  assertStrictReport(unmapped);
  assertStrictReport(restored);
});

test("changes canceled references without changing any report economics", () => {
  const { report: original } = buildFixture();
  const corrected = streamReport.correctReportMappings(original, [
    mappingChange(13, "canceled", "ALPHA-S", "RUNNER-8"),
    mappingChange(14, "canceled", null, "BETA-M"),
  ]);
  const unmapped = streamReport.correctReportMappings(original, [
    mappingChange(13, "canceled", "ALPHA-S", null),
  ]);

  assert.deepEqual(corrected.canceledOrders, [
    {
      variationNumber: 13,
      mapped: true,
      sku: "RUNNER-8",
      item: "Runner",
      style: "black",
      size: "8",
    },
    {
      variationNumber: 14,
      mapped: true,
      sku: "BETA-M",
      item: "Beta",
      style: "blue",
      size: "M",
    },
  ]);
  assert.deepEqual(byVariation(unmapped.canceledOrders, 13), {
    variationNumber: 13,
    mapped: false,
    sku: null,
    item: null,
    style: null,
    size: null,
  });

  const originalWithoutCanceled = structuredClone(original);
  const correctedWithoutCanceled = structuredClone(corrected);
  correctedWithoutCanceled.canceledOrders = originalWithoutCanceled.canceledOrders;
  assert.deepEqual(correctedWithoutCanceled, originalWithoutCanceled);
  assertStrictReport(corrected);
  assertStrictReport(unmapped);
});

test("preserves earlier sales and regenerates zero-stock oversold handoff data", () => {
  const { report: original } = buildFixture();
  const corrected = streamReport.correctReportMappings(original, [
    mappingChange(10, "payment_complete", "ALPHA-S", "ZERO-OS"),
  ]);
  const alpha = bySku(corrected.inventory, "ALPHA-S");
  const zero = bySku(corrected.inventory, "ZERO-OS");

  assert.equal(alpha.streamSoldQuantity, 0);
  assert.equal(alpha.baselineSoldQuantity, 1);
  assert.equal(alpha.calculatedRemainingQuantity, 2);
  assert.equal(alpha.replacementQuantity, 2);
  assert.equal(zero.streamSoldQuantity, 1);
  assert.equal(zero.baselineSoldQuantity, 1);
  assert.equal(zero.calculatedRemainingQuantity, -1);
  assert.equal(zero.replacementQuantity, 0);
  assert.equal(zero.availableAfterReservationsQuantity, 0);
  assert.equal(zero.oversoldQuantity, 1);
  assert.equal(zero.requiresRecount, true);
  assert.equal(corrected.totals.committedRevenueCents, 3500);
  assert.equal(corrected.totals.costOfGoodsCents, 1200);
  assert.equal(corrected.totals.grossProfitCents, 2300);
  assert.equal(bySku(corrected.sheetRows, "ALPHA-S").quantity_on_hand_at_import, 2);
  assert.equal(bySku(corrected.sheetRows, "ZERO-OS").quantity_on_hand_at_import, 0);
  assert.equal(
    corrected.inventoryUpdateLines[4],
    "SKU: ZERO-OS Updated count: 0",
  );
  assert.deepEqual(corrected.warnings, [
    { code: "unmapped_completed_sales", count: 1, sku: null },
    { code: "reconciliation_conflicts", count: 1, sku: null },
    { code: "inventory_recount_required", count: 1, sku: "ZERO-OS" },
  ]);
  assert.deepEqual(corrected.completeness, {
    status: "provisional",
    reasonCodes: [
      "unmapped_completed_sales",
      "reconciliation_conflicts",
      "inventory_recount_required",
    ],
  });
  assertStrictReport(corrected);
});

test("uses the exact multi-size SKU and that report's corrected unit cost", () => {
  const { report: original } = buildFixture();
  const costCorrected = streamReport.correctReportUnitCost(original, {
    sku: "RUNNER-9",
    unitCostCents: 1300,
  });
  const corrected = streamReport.correctReportMappings(costCorrected, [
    mappingChange(12, "payment_complete", null, "RUNNER-9"),
  ]);
  const sale = byVariation(corrected.completedSales, 12);

  assert.equal(sale.sku, "RUNNER-9");
  assert.equal(sale.item, "Runner");
  assert.equal(sale.style, "black");
  assert.equal(sale.size, "9");
  assert.equal(sale.unitCostCents, 1300);
  assert.equal(sale.grossProfitCents, -100);
  assert.equal(bySku(corrected.inventory, "RUNNER-8").streamSoldQuantity, 0);
  assert.equal(bySku(corrected.inventory, "RUNNER-9").streamSoldQuantity, 1);
  assert.equal(bySku(corrected.inventory, "RUNNER-9").replacementQuantity, 1);
  assert.equal(bySku(corrected.sheetRows, "RUNNER-9").unit_cost, "13.00");
  assert.equal(corrected.totals.costOfGoodsCents, 2700);
  assert.equal(corrected.totals.grossProfitCents, 2000);
  assertStrictReport(costCorrected);
  assertStrictReport(corrected);
});

test("strictly rejects malformed, duplicate, unknown, and stale changes", () => {
  const { report: original } = buildFixture();
  const originalBefore = structuredClone(original);
  const valid = mappingChange(
    10,
    "payment_complete",
    "ALPHA-S",
    "BETA-M",
  );
  const malformedBatches = [
    null,
    {},
    [],
    Array(1),
    [null],
    [{}],
    [{ ...valid, extra: true }],
    [{ ...valid, variationNumber: 0 }],
    [{ ...valid, variationNumber: 1.5 }],
    [{ ...valid, variationNumber: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...valid, expectedStatus: "processing" }],
    [{ ...valid, expectedSku: undefined }],
    [{ ...valid, expectedSku: "alpha-s" }],
    [{ ...valid, sku: " BETA-M" }],
    [valid, { ...valid, sku: "RUNNER-8" }],
    Array.from({ length: 1001 }, (_, index) =>
      mappingChange(index + 1, "payment_complete", null, "ALPHA-S")),
  ];

  malformedBatches.forEach((changes) => {
    const changesBefore = structuredClone(changes);
    assertReportError(
      () => streamReport.correctReportMappings(original, changes),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(changes, changesBefore);
    assert.deepEqual(original, originalBefore);
  });

  const maskedSparseBatch = Array(1);
  maskedSparseBatch.extra = true;
  assertReportError(
    () => streamReport.correctReportMappings(original, maskedSparseBatch),
    "INVALID_ARGUMENT",
  );
  assert.equal(maskedSparseBatch.length, 1);
  assert.equal(0 in maskedSparseBatch, false);
  assert.equal(maskedSparseBatch.extra, true);
  assert.deepEqual(original, originalBefore);

  const semanticFailures = [
    {
      code: "UNKNOWN_SKU",
      changes: [
        mappingChange(10, "payment_complete", "ALPHA-S", "MISSING-SKU"),
      ],
    },
    {
      code: "UNKNOWN_SKU",
      changes: [
        mappingChange(10, "payment_complete", "MISSING-SKU", "BETA-M"),
      ],
    },
    {
      code: "UNKNOWN_VARIATION",
      changes: [mappingChange(999, "payment_complete", null, "ALPHA-S")],
    },
    {
      code: "STALE_REPORT_MAPPING",
      changes: [
        mappingChange(10, "payment_complete", "BETA-M", "RUNNER-8"),
      ],
    },
    {
      code: "STALE_REPORT_MAPPING",
      changes: [mappingChange(10, "canceled", "ALPHA-S", "BETA-M")],
    },
  ];

  semanticFailures.forEach(({ code, changes }) => {
    const changesBefore = structuredClone(changes);
    assertReportError(
      () => streamReport.correctReportMappings(original, changes),
      code,
    );
    assert.deepEqual(changes, changesBefore);
    assert.deepEqual(original, originalBefore);
  });

  assertReportError(
    () =>
      streamReport.correctReportMappings(original, [
        valid,
        mappingChange(999, "payment_complete", null, "ALPHA-S"),
      ]),
    "UNKNOWN_VARIATION",
  );
  assert.deepEqual(original, originalBefore);

  const malformedReport = structuredClone(original);
  malformedReport.sheetRows[0].quantity_on_hand_at_import += 1;
  assertReportError(
    () => streamReport.correctReportMappings(malformedReport, [valid]),
    "INVALID_REPORT",
  );
});

test("rejects arithmetically unsafe batches without partial changes", () => {
  const state = reconciliation.createReconciliationState([
    inventoryEntry(
      "HUGE-B",
      "Huge",
      "",
      "OS",
      10,
      1,
    ),
  ]);
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 1,
    soldPriceCents: 1,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 2,
    soldPriceCents: 1,
  });
  const baseReport = createReport(state);
  const original = streamReport.correctReportUnitCost(baseReport, {
    sku: "HUGE-B",
    unitCostCents: Number.MAX_SAFE_INTEGER,
  });
  const originalBefore = structuredClone(original);
  const safe = streamReport.correctReportMappings(original, [
    mappingChange(1, "payment_complete", null, "HUGE-B"),
  ]);
  const changes = [
    mappingChange(1, "payment_complete", null, "HUGE-B"),
    mappingChange(2, "payment_complete", null, "HUGE-B"),
  ];
  const changesBefore = structuredClone(changes);

  assert.equal(safe.totals.costOfGoodsCents, Number.MAX_SAFE_INTEGER);
  assert.equal(
    safe.totals.grossProfitCents,
    1 - Number.MAX_SAFE_INTEGER,
  );
  assertStrictReport(safe);
  assertReportError(
    () => streamReport.correctReportMappings(original, changes),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(original, originalBefore);
  assert.deepEqual(changes, changesBefore);
});

test("corrects legacy completed rows but rejects unavailable canceled details", () => {
  const { report } = buildFixture();
  const legacy = structuredClone(report);
  legacy.version = 1;
  delete legacy.canceledOrders;
  const legacyBefore = structuredClone(legacy);
  const corrected = streamReport.correctReportMappings(legacy, [
    mappingChange(12, "payment_complete", null, "RUNNER-8"),
  ]);

  assert.deepEqual(legacy, legacyBefore);
  assert.equal(corrected.version, 2);
  assert.equal(corrected.canceledOrders, null);
  assert.equal(corrected.totals.canceledOrderCount, 2);
  assert.equal(corrected.totals.committedSalesCount, 3);
  assert.equal(corrected.totals.unmappedCompletedCount, 0);
  assert.equal(corrected.totals.committedRevenueCents, 4700);
  assert.equal(corrected.totals.costOfGoodsCents, 2100);
  assert.equal(corrected.totals.grossProfitCents, 2600);
  assert.equal(byVariation(corrected.completedSales, 12).sku, "RUNNER-8");
  assert.equal(bySku(corrected.inventory, "RUNNER-8").streamSoldQuantity, 1);
  assert.equal(bySku(corrected.inventory, "RUNNER-8").replacementQuantity, 0);
  assertStrictReport(corrected);

  assertReportError(
    () =>
      streamReport.correctReportMappings(legacy, [
        mappingChange(13, "canceled", "ALPHA-S", "BETA-M"),
      ]),
    "CANCELED_DETAILS_UNAVAILABLE",
  );
  assert.deepEqual(legacy, legacyBefore);
});

test("keeps oversold arithmetic exact near the safe-integer boundary", () => {
  const sku = "MAX-ROW";
  const maximum = Number.MAX_SAFE_INTEGER;
  const state = reconciliation.createReconciliationState([
    inventoryEntry(sku, "Maximum", "", "OS", maximum, 0),
  ]);
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 1,
    soldPriceCents: 100,
  });
  const baseReport = createReport(state);
  const exactCandidate = structuredClone(baseReport);

  Object.assign(exactCandidate.inventory[0], {
    streamSoldQuantity: 0,
    baselineSoldQuantity: maximum - 1,
    pendingQuantity: 2,
    calculatedRemainingQuantity: 1,
    replacementQuantity: 1,
    availableAfterReservationsQuantity: 0,
    oversoldQuantity: 1,
    requiresRecount: true,
  });
  exactCandidate.inventoryUpdateLines[0] =
    `SKU: ${sku} Updated count: 1`;
  exactCandidate.sheetRows[0].quantity_on_hand_at_import = 1;
  exactCandidate.warnings.push({
    code: "inventory_recount_required",
    count: 1,
    sku,
  });
  exactCandidate.completeness.reasonCodes.push(
    "inventory_recount_required",
  );
  const exactSource = streamReport.hydrateStreamReport(exactCandidate);
  const corrected = streamReport.correctReportMappings(exactSource, [
    mappingChange(1, "payment_complete", null, sku),
  ]);

  assert.equal(corrected.inventory[0].baselineSoldQuantity, maximum);
  assert.equal(corrected.inventory[0].calculatedRemainingQuantity, 0);
  assert.equal(corrected.inventory[0].oversoldQuantity, 2);
  assert.equal(corrected.inventory[0].requiresRecount, true);
  assert.deepEqual(corrected.warnings, [
    { code: "inventory_recount_required", count: 2, sku },
  ]);
  assertStrictReport(corrected);

  const overflowCandidate = structuredClone(baseReport);
  Object.assign(overflowCandidate.inventory[0], {
    streamSoldQuantity: 0,
    baselineSoldQuantity: maximum,
    pendingQuantity: 0,
    calculatedRemainingQuantity: 0,
    replacementQuantity: 0,
    availableAfterReservationsQuantity: 0,
    oversoldQuantity: 0,
    requiresRecount: false,
  });
  overflowCandidate.inventoryUpdateLines[0] =
    `SKU: ${sku} Updated count: 0`;
  overflowCandidate.sheetRows[0].quantity_on_hand_at_import = 0;
  const overflowSource = streamReport.hydrateStreamReport(overflowCandidate);
  const overflowBefore = structuredClone(overflowSource);

  assertReportError(
    () =>
      streamReport.correctReportMappings(overflowSource, [
        mappingChange(1, "payment_complete", null, sku),
      ]),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(overflowSource, overflowBefore);
});

test("accepts the legal 101-character inventory update line after unmapping", () => {
  const sku = "S".repeat(64);
  const openingQuantity = 1_000_000_000_000_000;
  const state = reconciliation.createReconciliationState([
    inventoryEntry(sku, "Boundary", "", "OS", openingQuantity, 1),
  ]);

  mapAndComplete(state, STREAM_ID, 1, sku, 100);
  const original = createReport(state);
  assert.equal(original.inventoryUpdateLines[0].length, 100);

  const corrected = streamReport.correctReportMappings(original, [
    mappingChange(1, "payment_complete", sku, null),
  ]);

  assert.equal(corrected.inventory[0].replacementQuantity, openingQuantity);
  assert.equal(
    corrected.inventoryUpdateLines[0],
    `SKU: ${sku} Updated count: ${openingQuantity}`,
  );
  assert.equal(corrected.inventoryUpdateLines[0].length, 101);
  assertStrictReport(corrected);
});
