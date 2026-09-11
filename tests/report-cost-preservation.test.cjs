const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const streamReport = require("../extension/shared/stream-report.js");
const storage = require("../extension/shared/stream-report-storage.js");
const protocol = require("../extension/shared/stream-report-protocol.js");
const coordinatorModule = require("../extension/shared/stream-report-coordinator.js");

const STREAM_ID = "local-stream:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_STREAM_ID = "local-stream:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STARTED_AT = "2026-08-20T18:00:00.000Z";
const ENDED_AT = "2026-08-20T19:00:00.000Z";
const GENERATED_AT = "2026-08-20T19:00:01.000Z";
const REGENERATED_AT = "2026-08-20T20:00:00.000Z";
const INVENTORY = [
  { sku: "SHIRT-S", item: "Shirt", style: "red", size: "S", quantityReceived: 5, unitCostCents: 500 },
  { sku: "SHIRT-M", item: "Shirt", style: "red", size: "M", quantityReceived: 5, unitCostCents: 700 },
  { sku: "JACKET-L", item: "Jacket", style: "black", size: "L", quantityReceived: 5, unitCostCents: 300 },
  { sku: "UNSOLD-OS", item: "Hat", style: "", size: "OS", quantityReceived: 5, unitCostCents: 250 },
];
const INITIAL_SALES = [
  { variationNumber: 1, sku: "SHIRT-S", soldPriceCents: 1500 },
  { variationNumber: 2, sku: "SHIRT-M", soldPriceCents: 1400 },
  { variationNumber: 3, sku: "JACKET-L", soldPriceCents: 2000 },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createState(pendingSku = "SHIRT-S", streamId = STREAM_ID) {
  const state = reconciliation.createReconciliationState(INVENTORY);
  for (const sale of INITIAL_SALES) {
    reconciliation.mapVariation(state, { streamId, variationNumber: sale.variationNumber, sku: sale.sku });
    reconciliation.recordPaymentComplete(state, { streamId, variationNumber: sale.variationNumber, soldPriceCents: sale.soldPriceCents });
  }
  reconciliation.mapVariation(state, { streamId, variationNumber: 4, sku: pendingSku });
  reconciliation.observePaymentStatuses(state, {
    streamId,
    statuses: [{ variationNumber: 4, observedPaymentStatus: reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED }],
  });
  return state;
}

function buildReport(state, streamId = STREAM_ID) {
  return streamReport.createStreamReport({
    reconciliation,
    reconciliationState: state,
    streamId,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    generatedAt: GENERATED_AT,
  });
}

function savedRecord(report, options = {}) {
  return {
    reportId: report.reportId,
    lifecycleStatus: "finalized",
    archived: true,
    displayName: "Keep this saved report name",
    report,
    ...options,
  };
}

function createMemoryStorage(records) {
  let values = { [storage.STORAGE_KEY]: { schemaVersion: storage.STORAGE_SCHEMA_VERSION, records: clone(records) } };
  const writes = [];
  const memory = {
    writes,
    failSave: false,
    beforeSave: null,
    async get() { return clone(values); },
    async set(next) {
      if (memory.beforeSave) await memory.beforeSave();
      if (memory.failSave) throw new Error("Synthetic storage failure");
      values = clone(next);
      writes.push(clone(next));
    },
    read() { return clone(values[storage.STORAGE_KEY].records); },
  };
  return memory;
}

function createCoordinator(memory, reportModule = streamReport) {
  return coordinatorModule.createStreamReportCoordinator({
    now: () => REGENERATED_AT,
    protocol,
    reconciliation,
    streamReport: reportModule,
    storage,
    reportStore: storage.createStreamReportStore({ storageArea: memory, streamReport }),
  });
}

function createHarness(options = {}) {
  const state = createState(options.pendingSku);
  let report = buildReport(state);
  for (const [sku, unitCostCents] of Object.entries(options.costs ?? { "SHIRT-S": 900 })) {
    report = streamReport.correctReportUnitCost(report, { sku, unitCostCents });
  }
  const target = savedRecord(report, options.recordOptions);
  const neighbor = savedRecord(buildReport(createState("SHIRT-M", OTHER_STREAM_ID), OTHER_STREAM_ID), { archived: false, displayName: "Unrelated report" });
  const memory = createMemoryStorage([target, neighbor]);
  const helperCalls = [];
  const reportModule = {
    ...streamReport,
    correctReportUnitCost(candidate, input) {
      helperCalls.push(clone(input));
      return options.correctReportUnitCost
        ? options.correctReportUnitCost(candidate, input, helperCalls.length)
        : streamReport.correctReportUnitCost(candidate, input);
    },
    ...options.moduleOverrides,
  };
  return { state, target, neighbor, memory, helperCalls, coordinator: createCoordinator(memory, reportModule) };
}

function resolve(state, resolution = "payment_complete") {
  reconciliation.resolvePaymentFixingOrder(state, {
    streamId: STREAM_ID,
    variationNumber: 4,
    resolution,
    soldPriceCents: resolution === "payment_complete" ? 1800 : null,
  });
  return state;
}

function replace(harness, state = harness.state) {
  return harness.coordinator.replaceFinalizedReport({ reportId: harness.target.reportId, reconciliationState: state });
}

function assertCostFacts(report, expectedSales, costs) {
  const expectedCosts = new Map(INVENTORY.map((row) => [row.sku, costs[row.sku] ?? row.unitCostCents]));
  const expectedPerformance = new Map();
  for (const sale of expectedSales) {
    const actual = report.completedSales.find((row) => row.variationNumber === sale.variationNumber);
    const cost = expectedCosts.get(sale.sku);
    assert.equal(actual.sku, sale.sku);
    assert.equal(actual.soldPriceCents, sale.soldPriceCents);
    assert.equal(actual.unitCostCents, cost);
    assert.equal(actual.grossProfitCents, sale.soldPriceCents - cost);
    const facts = expectedPerformance.get(sale.sku) ?? { soldQuantity: 0, revenueCents: 0, costOfGoodsCents: 0, grossProfitCents: 0 };
    facts.soldQuantity++;
    facts.revenueCents += sale.soldPriceCents;
    facts.costOfGoodsCents += cost;
    facts.grossProfitCents += sale.soldPriceCents - cost;
    expectedPerformance.set(sale.sku, facts);
  }
  assert.equal(report.completedSales.length, expectedSales.length);
  const expectedProducts = new Map();
  for (const [sku, expected] of expectedPerformance) {
    const actual = report.itemPerformance.find((row) => row.sku === sku);
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `${sku}.${key}`);
    const item = INVENTORY.find((row) => row.sku === sku).item;
    const product = expectedProducts.get(item) ?? { soldQuantity: 0, revenueCents: 0, costOfGoodsCents: 0, grossProfitCents: 0 };
    for (const key of Object.keys(product)) product[key] += expected[key];
    expectedProducts.set(item, product);
  }
  for (const [item, expected] of expectedProducts) {
    const actual = report.productPerformance.find((row) => row.item === item);
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `${item}.${key}`);
  }
  const revenue = expectedSales.reduce((total, row) => total + row.soldPriceCents, 0);
  const cost = expectedSales.reduce((total, row) => total + expectedCosts.get(row.sku), 0);
  assert.equal(report.totals.costOfGoodsCents, cost);
  assert.equal(report.totals.grossProfitCents, revenue - cost);
  assert.equal(report.totals.committedRevenueCents, revenue);
  assert.equal(report.totals.completedGmvCents, revenue);
  assert.equal(report.totals.completedPaymentCount, expectedSales.length);
  assert.equal(report.topItems.mostProfitable.value, Math.max(...Array.from(expectedPerformance.values(), (row) => row.grossProfitCents)));
  assert.equal(report.topProducts.mostProfitable.value, Math.max(...Array.from(expectedProducts.values(), (row) => row.grossProfitCents)));
  assert.deepEqual(
    report.topItems.mostProfitable.items.map((row) => row.sku).sort(),
    Array.from(expectedPerformance).filter(([, row]) => row.grossProfitCents === report.topItems.mostProfitable.value).map(([sku]) => sku).sort(),
  );
  assert.deepEqual(
    report.topProducts.mostProfitable.items.map((row) => row.item).sort(),
    Array.from(expectedProducts).filter(([, row]) => row.grossProfitCents === report.topProducts.mostProfitable.value).map(([item]) => item).sort(),
  );
  for (const original of INVENTORY) {
    const row = report.inventory.find((entry) => entry.sku === original.sku);
    const sheetRow = report.sheetRows.find((entry) => entry.sku === original.sku);
    const sold = expectedPerformance.get(original.sku)?.soldQuantity ?? 0;
    assert.equal(row.unitCostCents, expectedCosts.get(original.sku));
    assert.equal(row.streamSoldQuantity, sold);
    assert.equal(row.replacementQuantity, original.quantityReceived - sold);
    assert.equal(sheetRow.quantity_on_hand_at_import, row.replacementQuantity);
    assert.equal(sheetRow.unit_cost, (expectedCosts.get(original.sku) / 100).toFixed(2));
    const fields = [original.sku, original.item, original.style, original.size, row.replacementQuantity, sheetRow.unit_cost];
    assert.ok(streamReport.serializeInventoryCsv(report).includes(fields.join(",")));
    assert.ok(streamReport.serializeInventoryTsv(report).includes(fields.join("\t")));
  }
  assert.deepEqual(streamReport.hydrateStreamReport(report), report);
}

async function assertPreserved(harness, before, expectedWrites = 0) {
  assert.deepEqual(harness.memory.read(), before);
  assert.equal(harness.memory.writes.length, expectedWrites);
  assert.deepEqual((await harness.coordinator.getReport(harness.target.reportId)).report, before[0].report);
  assert.deepEqual((await createCoordinator(harness.memory).getReport(harness.target.reportId)).report, before[0].report);
}

test("regeneration applies a saved $5 to $9 correction to old and newly completed sales of the same exact SKU", async () => {
  const harness = createHarness();
  const canonicalBefore = clone(harness.state);
  resolve(harness.state);
  const resolvedBefore = clone(harness.state);
  const result = await replace(harness);
  assertCostFacts(result.report, [...INITIAL_SALES, { variationNumber: 4, sku: "SHIRT-S", soldPriceCents: 1800 }], { "SHIRT-S": 900 });
  assert.deepEqual(harness.helperCalls, [{ sku: "SHIRT-S", unitCostCents: 900 }]);
  assert.equal(harness.memory.writes.length, 1);
  assert.deepEqual(harness.memory.read()[1], harness.neighbor);
  assert.deepEqual(harness.state, resolvedBefore);
  assert.deepEqual(harness.state.inventoryBaselines, canonicalBefore.inventoryBaselines);
  assert.equal(reconciliation.getAuction(harness.state, { streamId: STREAM_ID, variationNumber: 4 }).committedUnitCostCents, 500);
  assert.equal(result.reportId, harness.target.reportId);
  assert.equal(result.displayName, harness.target.displayName);
  assert.equal(result.lifecycleStatus, "finalized");
  assert.equal(harness.memory.read()[0].archived, true);
  assert.deepEqual(result.report.metadata, { ...harness.target.report.metadata, generatedAt: REGENERATED_AT });
  const reopened = await createCoordinator(harness.memory).getReport(harness.target.reportId);
  assert.deepEqual(reopened, result);
});

test("a payment completed for another SKU preserves multiple corrections, zero cost, and an unsold export cost", async () => {
  const costs = { "SHIRT-S": 900, "SHIRT-M": 0, "UNSOLD-OS": 1250 };
  const harness = createHarness({ pendingSku: "SHIRT-M", costs });
  resolve(harness.state);
  const result = await replace(harness);
  assertCostFacts(result.report, [...INITIAL_SALES, { variationNumber: 4, sku: "SHIRT-M", soldPriceCents: 1800 }], costs);
  assert.deepEqual(new Map(harness.helperCalls.map((call) => [call.sku, call.unitCostCents])), new Map(Object.entries(costs)));
  assert.equal(harness.helperCalls.length, 3);
  assert.equal(harness.memory.writes.length, 1);
  assert.deepEqual(harness.memory.read()[1], harness.neighbor);
});

test("canceling a payment-fixing order preserves saved costs while releasing its reservation", async () => {
  const costs = { "SHIRT-S": 900, "SHIRT-M": 0, "UNSOLD-OS": 0 };
  const harness = createHarness({ costs });
  resolve(harness.state, "canceled");
  const result = await replace(harness);
  assertCostFacts(result.report, INITIAL_SALES, costs);
  assert.deepEqual(result.report.canceledOrders.map((row) => [row.variationNumber, row.sku]), [[4, "SHIRT-S"]]);
  assert.equal(result.report.totals.canceledOrderCount, 1);
  assert.equal(result.report.totals.paymentFixingCount, 0);
  assert.equal(result.report.totals.pendingMappedCount, 0);
  assert.equal(result.report.inventory.find((row) => row.sku === "SHIRT-S").availableAfterReservationsQuantity, 4);
  assert.equal(harness.memory.writes.length, 1);
});

test("unchanged costs skip the correction helper and persist a payment rebuild once", async () => {
  const harness = createHarness({ costs: {}, recordOptions: { archived: false } });
  resolve(harness.state);
  const result = await replace(harness);
  assertCostFacts(result.report, [...INITIAL_SALES, { variationNumber: 4, sku: "SHIRT-S", soldPriceCents: 1800 }], {});
  assert.deepEqual(harness.helperCalls, []);
  assert.equal(harness.memory.writes.length, 1);
  assert.equal(harness.memory.read()[0].archived, false);
});

test("replacement reads the latest saved cost from an earlier queued correction", async () => {
  const harness = createHarness();
  let release;
  let entered;
  const pendingSave = new Promise((resolveSave) => { release = resolveSave; });
  const saveEntered = new Promise((resolveEntered) => { entered = resolveEntered; });
  harness.memory.beforeSave = async () => { entered(); await pendingSave; };
  const correction = harness.coordinator.correctFinalizedReportUnitCost({ reportId: harness.target.reportId, sku: "SHIRT-S", unitCostCents: 1100 });
  await saveEntered;
  resolve(harness.state);
  const replacement = replace(harness);
  release();
  await correction;
  const result = await replacement;
  assertCostFacts(result.report, [...INITIAL_SALES, { variationNumber: 4, sku: "SHIRT-S", soldPriceCents: 1800 }], { "SHIRT-S": 1100 });
  assert.deepEqual(harness.helperCalls, [{ sku: "SHIRT-S", unitCostCents: 1100 }, { sku: "SHIRT-S", unitCostCents: 1100 }]);
  assert.equal(harness.memory.writes.length, 2);
  assert.deepEqual((await createCoordinator(harness.memory).getReport(harness.target.reportId)).report, result.report);
});

test("generation, helper, and final validation failures leave the prior corrected report intact", async (t) => {
  const failures = [
    { name: "rebuild throws", moduleOverrides: { createStreamReport() { throw new Error("Synthetic rebuild failure"); } } },
    { name: "second cost helper throws after a successful first correction", correctReportUnitCost(candidate, input, count) { if (count === 2) throw new Error("Synthetic helper failure"); return streamReport.correctReportUnitCost(candidate, input); } },
    { name: "last helper returns invalid final financial totals", correctReportUnitCost(candidate, input, count) { const result = clone(streamReport.correctReportUnitCost(candidate, input)); if (count === 2) result.totals.costOfGoodsCents++; return result; } },
    { name: "helper silently fails to preserve requested cost", correctReportUnitCost(candidate) { return candidate; } },
    { name: "helper changes stream identity", correctReportUnitCost(candidate, input) { const result = clone(streamReport.correctReportUnitCost(candidate, input)); result.metadata.startedAt = "2026-08-20T17:00:00.000Z"; return result; } },
  ];
  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const harness = createHarness({ ...failure, costs: { "SHIRT-S": 900, "UNSOLD-OS": 0 } });
      const before = harness.memory.read();
      resolve(harness.state);
      const canonicalBefore = clone(harness.state);
      await assert.rejects(() => replace(harness), { code: "REPORT_GENERATION_FAILED" });
      await assertPreserved(harness, before);
      assert.deepEqual(harness.state, canonicalBefore);
    });
  }
});

test("same-baseline regeneration rejects removed, added, or renamed exact inventory SKUs", async (t) => {
  const changes = [
    ["removed", (inventory) => inventory.filter((row) => row.sku !== "UNSOLD-OS")],
    ["added", (inventory) => [...inventory, { ...inventory[0], sku: "ADDED-SKU" }]],
    ["renamed", (inventory) => inventory.map((row) => row.sku === "UNSOLD-OS" ? { ...row, sku: "RENAMED-OS" } : row)],
  ];
  for (const [name, change] of changes) {
    await t.test(name, async () => {
      const harness = createHarness();
      const before = harness.memory.read();
      resolve(harness.state);
      harness.state.inventoryBaselines[0].inventory = change(harness.state.inventoryBaselines[0].inventory);
      // The rebuilt report is valid in isolation; its SKU set is wrong for this saved report.
      assert.doesNotThrow(() => buildReport(harness.state));
      await assert.rejects(() => replace(harness), { code: "REPORT_GENERATION_FAILED" });
      await assertPreserved(harness, before);
    });
  }
});

test("rebuild identity and lifecycle guards preserve the saved record before persistence", async (t) => {
  for (const field of ["reportId", "streamId", "startedAt", "endedAt", "inventoryBaselineId"]) {
    await t.test(field, async () => {
      const harness = createHarness({ moduleOverrides: {
        createStreamReport(options) {
          const report = clone(streamReport.createStreamReport(options));
          if (field === "reportId") report.reportId = streamReport.createReportIdForStream(OTHER_STREAM_ID);
          else if (field === "streamId") report.metadata.streamId = OTHER_STREAM_ID;
          else if (field === "startedAt") report.metadata.startedAt = "2026-08-20T17:00:00.000Z";
          else if (field === "endedAt") report.metadata.endedAt = "2026-08-20T19:30:00.000Z";
          else report.metadata.inventoryBaselineId = "inventory-baseline:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
          return report;
        },
      } });
      const before = harness.memory.read();
      resolve(harness.state);
      await assert.rejects(() => replace(harness), { code: "REPORT_GENERATION_FAILED" });
      await assertPreserved(harness, before);
    });
  }
  await t.test("pending end report", async () => {
    const harness = createHarness({ recordOptions: { lifecycleStatus: "pending_end", archived: false } });
    const before = harness.memory.read();
    await assert.rejects(() => replace(harness), { code: "REPORT_NOT_FINALIZED" });
    await assertPreserved(harness, before);
    assert.deepEqual(harness.helperCalls, []);
  });
  await t.test("missing report", async () => {
    const harness = createHarness();
    const before = harness.memory.read();
    await assert.rejects(() => harness.coordinator.replaceFinalizedReport({ reportId: "stream-report:cccccccc-cccc-4ccc-8ccc-cccccccccccc", reconciliationState: harness.state }), { code: "REPORT_NOT_FOUND" });
    await assertPreserved(harness, before);
    assert.deepEqual(harness.helperCalls, []);
  });
});

test("real storage write failure preserves the prior report in memory and after reopening", async () => {
  const harness = createHarness();
  const before = harness.memory.read();
  resolve(harness.state);
  harness.memory.failSave = true;
  await assert.rejects(() => replace(harness), { code: "STORAGE_WRITE_FAILED" });
  await assertPreserved(harness, before);
});

test("real archive size rejection leaves the prior report and unrelated records intact", async () => {
  const harness = createHarness();
  resolve(harness.state);
  const stream = harness.state.streams.find((row) => row.streamId === STREAM_ID);
  const sale = clone(stream.variations.find((row) => row.variationNumber === 1));
  // Each individual report remains below its real 1000-sale limit. Only the
  // combined persisted archive exceeds its byte budget after replacement.
  stream.variations.push(...Array.from({ length: 996 }, (_, index) => ({ ...sale, variationNumber: index + 5, conflicts: [] })));
  const largeReport = buildReport(harness.state);
  const records = [harness.target];
  function filler(report, index) {
    const result = clone(report);
    result.metadata.streamId = `local-stream:${String(index).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`;
    result.reportId = streamReport.createReportIdForStream(result.metadata.streamId);
    return savedRecord(result);
  }
  while (true) {
    const next = filler(largeReport, records.length);
    if (storage.measureRecordsByteLength([...records, next]) > storage.MAX_ARCHIVE_BYTES) break;
    records.push(next);
  }
  while (storage.measureRecordsByteLength([savedRecord(largeReport), ...records.slice(1)]) <= storage.MAX_ARCHIVE_BYTES) {
    records.push(filler(harness.target.report, records.length));
  }
  assert.ok(records.length <= storage.MAX_ARCHIVED_REPORTS);
  assert.ok(storage.measureRecordsByteLength(records) <= storage.MAX_ARCHIVE_BYTES);
  const memory = createMemoryStorage(records);
  const coordinator = createCoordinator(memory);
  const before = memory.read();
  await assert.rejects(() => coordinator.replaceFinalizedReport({ reportId: harness.target.reportId, reconciliationState: harness.state }), { code: "REPORT_ARCHIVE_FULL" });
  await assertPreserved({ ...harness, coordinator, memory }, before);
});

test("cost decreases are applied before increases when only a transient intermediate total would overflow", async () => {
  const largeCost = 2 ** 52;
  const state = reconciliation.createReconciliationState([
    { sku: "A-SKU", item: "Alpha", size: "S", quantityReceived: 5, unitCostCents: 0 },
    { sku: "B-SKU", item: "Beta", size: "S", quantityReceived: 5, unitCostCents: largeCost },
  ]);
  for (const [variationNumber, sku] of [[1, "A-SKU"], [2, "B-SKU"]]) {
    reconciliation.mapVariation(state, { streamId: STREAM_ID, variationNumber, sku });
    reconciliation.recordPaymentComplete(state, { streamId: STREAM_ID, variationNumber, soldPriceCents: 100 });
  }
  let report = buildReport(state);
  report = streamReport.correctReportUnitCost(report, { sku: "B-SKU", unitCostCents: 0 });
  report = streamReport.correctReportUnitCost(report, { sku: "A-SKU", unitCostCents: largeCost });
  const memory = createMemoryStorage([savedRecord(report)]);
  const calls = [];
  const coordinator = createCoordinator(memory, {
    ...streamReport,
    correctReportUnitCost(candidate, input) {
      calls.push(clone(input));
      return streamReport.correctReportUnitCost(candidate, input);
    },
  });
  const canonicalBefore = clone(state);
  const result = await coordinator.replaceFinalizedReport({ reportId: report.reportId, reconciliationState: state });
  assert.deepEqual(calls, [{ sku: "B-SKU", unitCostCents: 0 }, { sku: "A-SKU", unitCostCents: largeCost }]);
  assert.equal(result.report.totals.costOfGoodsCents, largeCost);
  assert.equal(result.report.totals.grossProfitCents, 200 - largeCost);
  assert.deepEqual(result.report.completedSales.map((row) => [row.sku, row.unitCostCents]), [["A-SKU", largeCost], ["B-SKU", 0]]);
  assert.deepEqual(state, canonicalBefore);
  assert.equal(memory.writes.length, 1);
  assert.deepEqual((await createCoordinator(memory).getReport(report.reportId)).report, result.report);
});

test("a genuinely unsafe final cost total rejects atomically", async () => {
  const harness = createHarness({ costs: { "SHIRT-S": 2 ** 52 } });
  const before = harness.memory.read();
  resolve(harness.state);
  const canonicalBefore = clone(harness.state);
  await assert.rejects(() => replace(harness), { code: "REPORT_GENERATION_FAILED" });
  await assertPreserved(harness, before);
  assert.deepEqual(harness.state, canonicalBefore);
});
