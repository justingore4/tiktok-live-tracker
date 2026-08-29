const assert = require("node:assert/strict");
const test = require("node:test");

const coordinatorModule = require(
  "../extension/shared/stream-report-coordinator.js",
);
const realReconciliation = require("../extension/shared/reconciliation.js");
const realStreamReport = require("../extension/shared/stream-report.js");
const protocol = require("../extension/shared/stream-report-protocol.js");
const storage = require("../extension/shared/stream-report-storage.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStore(options = {}) {
  let records = clone(options.records ?? []);
  const saves = [];

  return {
    saves,
    async loadRecords() {
      return clone(records);
    },
    async saveRecords(candidate) {
      if (options.failSave === true) {
        throw Object.assign(new Error("save failed"), {
          code: "STORAGE_WRITE_FAILED",
        });
      }

      const byteLength = new TextEncoder().encode(JSON.stringify({
        schemaVersion: storage.STORAGE_SCHEMA_VERSION,
        records: candidate,
      })).byteLength;

      if (byteLength > storage.MAX_ARCHIVE_BYTES) {
        throw new storage.StreamReportStorageError(
          "REPORT_ARCHIVE_FULL",
          "Saved stream reports exceed the safe local archive size.",
        );
      }

      records = clone(candidate);
      saves.push(clone(records));
      return clone(records);
    },
    read() {
      return clone(records);
    },
  };
}

function createReport(options) {
  const uuid = options.streamId.slice("local-stream:".length);
  return {
    reportId: `stream-report:${uuid}`,
    metadata: {
      streamId: options.streamId,
      startedAt: options.startedAt,
      endedAt: options.endedAt,
      generatedAt: options.generatedAt,
      inventoryBaselineId:
        "inventory-baseline:11111111-1111-4111-8111-111111111111",
      activeBiddingVariationNumber: null,
    },
    completeness: { status: "final", reasonCodes: [] },
    totals: {
      completedPaymentCount: options.reconciliationState.completed ?? 0,
      totalSalesCount: options.reconciliationState.total ?? 0,
      completedGmvCents: options.reconciliationState.gmv ?? 0,
      attributedGmvDisplay: options.reconciliationState.attributed ?? null,
    },
  };
}

const streamReport = {
  createStreamReport(options) {
    return createReport(options);
  },
  correctReportUnitCost(candidate, input) {
    return {
      ...clone(candidate),
      correctedUnitCost: clone(input),
    };
  },
  correctReportMappings(candidate, changes) {
    return {
      ...clone(candidate),
      correctedMappings: clone(changes),
    };
  },
  hydrateStreamReport(candidate) {
    return clone(candidate);
  },
};
const reconciliation = {
  hydrateReconciliationState(candidate) {
    return clone(candidate);
  },
  calculateSummary() {
    return {};
  },
};

function createCoordinator(
  store,
  timestamps = ["2026-08-10T12:00:00.000Z"],
  reportModule = streamReport,
) {
  let index = 0;
  return coordinatorModule.createStreamReportCoordinator({
    now: () => timestamps[Math.min(index++, timestamps.length - 1)],
    protocol,
    reconciliation,
    reportStore: store,
    storage,
    streamReport: reportModule,
  });
}

const STREAM_ONE =
  "local-stream:11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-08-10T10:00:00.000Z";

function getActiveCount(records) {
  return records.filter(
    (record) => record.lifecycleStatus === "finalized" && !record.archived,
  ).length;
}

function createSavedRecord(index, options = {}) {
  const uuid = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const endedAt = `2026-08-${String(index).padStart(2, "0")}T12:00:00.000Z`;
  const report = createReport({
    reconciliationState: {},
    streamId: `local-stream:${uuid}`,
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt,
    generatedAt: endedAt,
  });

  return {
    reportId: report.reportId,
    lifecycleStatus: options.lifecycleStatus ?? "finalized",
    archived: options.archived ?? false,
    ...(options.displayName === undefined
      ? {}
      : { displayName: options.displayName }),
    report,
  };
}

function createOfflineEditorRecord(index, options = {}) {
  const record = createSavedRecord(index, options);
  const oversoldQuantity = options.oversoldQuantity ?? 0;
  const oversold = oversoldQuantity > 0;
  const completedSales = options.completedSales ?? [
    {
      variationNumber: 10,
      mapped: true,
      sku: "TEE-M",
      item: "Tee",
      style: "black",
      size: "M",
      soldPriceCents: 1500,
      unitCostCents: 500,
      grossProfitCents: 1000,
      conflicts: options.conflicts ?? [],
    },
  ];
  const canceledOrders = options.canceledOrders === undefined
    ? [
        {
          variationNumber: 11,
          mapped: false,
          sku: null,
          item: null,
          style: null,
          size: null,
        },
      ]
    : options.canceledOrders;

  record.report = {
    ...record.report,
    metadata: {
      ...record.report.metadata,
      activeBiddingVariationNumber:
        options.activeBiddingVariationNumber ?? null,
    },
    completeness: options.completeness ?? {
      status: "provisional",
      reasonCodes: ["reconciliation_conflicts"],
    },
    totals: {
      ...record.report.totals,
      paymentFixingCount: options.paymentFixingCount ?? 0,
      pendingMappedCount: options.pendingMappedCount ?? 0,
      unresolvedOrderCount: options.unresolvedOrderCount ?? 0,
    },
    completedSales,
    canceledOrders,
    inventory: [
      {
        sku: "TEE-M",
        item: "Tee",
        style: "black",
        size: "M",
        unitCostCents: 500,
        openingQuantity: oversold ? 0 : 2,
        streamSoldQuantity: 1,
        baselineSoldQuantity: 1,
        pendingQuantity: 0,
        calculatedRemainingQuantity: oversold ? -1 : 1,
        replacementQuantity: oversold ? 0 : 1,
        availableAfterReservationsQuantity: oversold ? 0 : 1,
        oversoldQuantity,
        requiresRecount: oversold,
      },
      {
        sku: "TEE-L",
        item: "Tee",
        style: "black",
        size: "L",
        unitCostCents: 700,
        openingQuantity: 1,
        streamSoldQuantity: 0,
        baselineSoldQuantity: 0,
        pendingQuantity: 0,
        calculatedRemainingQuantity: 1,
        replacementQuantity: 1,
        availableAfterReservationsQuantity: 1,
        oversoldQuantity: 0,
        requiresRecount: false,
      },
    ],
    privateCanonicalState: { mustNotEscape: true },
  };

  return record;
}

test("prepares before End, finalizes idempotently, and exposes strict reads", async () => {
  const store = createStore();
  const coordinator = createCoordinator(store);
  const prepared = await coordinator.prepareReport({
    reconciliationState: {
      completed: 2,
      total: 3,
      gmv: 2500,
      attributed: "$30.00",
    },
    streamId: STREAM_ONE,
    startedAt: STARTED_AT,
  });

  assert.equal(prepared.lifecycleStatus, "pending_end");
  assert.equal(store.read()[0].lifecycleStatus, "pending_end");
  assert.equal(store.read()[0].archived, false);

  const finalized = await coordinator.finalizeReport(prepared.reportId);
  assert.equal(finalized.lifecycleStatus, "finalized");
  assert.equal(Object.hasOwn(finalized, "archived"), false);
  assert.deepEqual(
    await coordinator.finalizeReport(prepared.reportId),
    finalized,
  );

  assert.deepEqual(await coordinator.dispatch({ type: "list_reports" }), {
    reports: [{
      reportId: prepared.reportId,
      displayName: null,
      startedAt: STARTED_AT,
      endedAt: "2026-08-10T12:00:00.000Z",
      completeness: "final",
      completedPaymentCount: 2,
      totalSalesCount: 3,
      completedGmvCents: 2500,
      attributedGmvDisplay: "$30.00",
    }],
  });
  assert.deepEqual(
    await coordinator.dispatch({
      type: "get_report",
      reportId: prepared.reportId,
    }),
    finalized,
  );
});

test("finds the newest finalized report across active and archived tiers", async () => {
  const olderActive = createSavedRecord(1);
  const newestArchived = createSavedRecord(3, { archived: true });
  const pending = createSavedRecord(4, { lifecycleStatus: "pending_end" });
  const coordinator = createCoordinator(createStore({
    records: [olderActive, newestArchived, pending],
  }));

  assert.deepEqual(
    await coordinator.getLatestFinalizedReport(),
    {
      reportId: newestArchived.reportId,
      lifecycleStatus: "finalized",
      displayName: null,
      report: newestArchived.report,
    },
  );
});

test("regenerates one finalized report while preserving its saved identity and tier", async () => {
  const existing = createSavedRecord(2, { archived: true });
  const store = createStore({ records: [existing] });
  const coordinator = createCoordinator(
    store,
    ["2026-08-20T12:30:00.000Z"],
  );
  const replacement = await coordinator.replaceFinalizedReport({
    reportId: existing.reportId,
    reconciliationState: {
      completed: 4,
      total: 5,
      gmv: 7200,
      attributed: "$80.00",
    },
  });
  const persisted = store.read()[0];

  assert.equal(replacement.reportId, existing.reportId);
  assert.equal(replacement.lifecycleStatus, "finalized");
  assert.equal(replacement.report.metadata.startedAt, existing.report.metadata.startedAt);
  assert.equal(replacement.report.metadata.endedAt, existing.report.metadata.endedAt);
  assert.equal(
    replacement.report.metadata.generatedAt,
    "2026-08-20T12:30:00.000Z",
  );
  assert.equal(replacement.report.totals.completedPaymentCount, 4);
  assert.equal(replacement.report.totals.completedGmvCents, 7200);
  assert.equal(persisted.archived, true);
  assert.equal(persisted.lifecycleStatus, "finalized");
});

test("failed finalized report replacement preserves the previous saved report", async () => {
  const existing = createSavedRecord(2);
  const store = createStore({ records: [existing], failSave: true });
  const coordinator = createCoordinator(
    store,
    ["2026-08-20T12:30:00.000Z"],
  );

  await assert.rejects(
    () => coordinator.replaceFinalizedReport({
      reportId: existing.reportId,
      reconciliationState: { completed: 1, total: 1, gmv: 900 },
    }),
    (error) => error.code === "STORAGE_WRITE_FAILED",
  );
  assert.deepEqual(store.read(), [existing]);
});

test("corrects one archived report unit cost without changing its tier, identity, timestamps, or neighboring reports", async () => {
  const target = createSavedRecord(1, { archived: true });
  const neighbor = createSavedRecord(2);
  const store = createStore({ records: [target, neighbor] });
  const coordinator = createCoordinator(store);
  const result = await coordinator.correctFinalizedReportUnitCost({
    reportId: target.reportId,
    sku: "SKU-ONE",
    unitCostCents: 725,
  });
  const persisted = store.read();
  const corrected = persisted.find(
    (record) => record.reportId === target.reportId,
  );

  assert.deepEqual(result.report.correctedUnitCost, {
    sku: "SKU-ONE",
    unitCostCents: 725,
  });
  assert.equal(result.reportId, target.reportId);
  assert.equal(result.lifecycleStatus, "finalized");
  assert.equal(corrected.archived, true);
  assert.deepEqual(corrected.report.metadata, target.report.metadata);
  assert.deepEqual(
    persisted.find((record) => record.reportId === neighbor.reportId),
    neighbor,
  );
});

test("report-only unit-cost correction is idempotent and transform or save failures are atomic", async () => {
  const target = createSavedRecord(1);
  const store = createStore({ records: [target] });
  const coordinator = createCoordinator(store);
  const command = {
    reportId: target.reportId,
    sku: "SKU-ONE",
    unitCostCents: 725,
  };

  await coordinator.correctFinalizedReportUnitCost(command);
  const saveCount = store.saves.length;
  const corrected = store.read();
  await coordinator.correctFinalizedReportUnitCost(command);
  assert.equal(store.saves.length, saveCount);
  assert.deepEqual(store.read(), corrected);

  const transformFailureStore = createStore({ records: [target] });
  const transformFailureCoordinator = createCoordinator(
    transformFailureStore,
    undefined,
    {
      ...streamReport,
      correctReportUnitCost() {
        throw Object.assign(new Error("SKU is not in this report."), {
          code: "UNKNOWN_SKU",
        });
      },
    },
  );
  await assert.rejects(
    () => transformFailureCoordinator.correctFinalizedReportUnitCost(command),
    (error) => error.code === "UNKNOWN_SKU",
  );
  assert.deepEqual(transformFailureStore.read(), [target]);
  assert.equal(transformFailureStore.saves.length, 0);

  const saveFailureStore = createStore({ records: [target], failSave: true });
  const saveFailureCoordinator = createCoordinator(saveFailureStore);
  await assert.rejects(
    () => saveFailureCoordinator.correctFinalizedReportUnitCost(command),
    (error) => error.code === "STORAGE_WRITE_FAILED",
  );
  assert.deepEqual(saveFailureStore.read(), [target]);
});

test("retries replace the same stream report and pending repair follows session truth", async () => {
  const store = createStore();
  const coordinator = createCoordinator(store, [
    "2026-08-10T12:00:00.000Z",
    "2026-08-10T12:05:00.000Z",
  ]);
  const first = await coordinator.prepareReport({
    reconciliationState: { completed: 1, total: 1, gmv: 100 },
    streamId: STREAM_ONE,
    startedAt: STARTED_AT,
  });
  const retry = await coordinator.prepareReport({
    reconciliationState: { completed: 2, total: 2, gmv: 300 },
    streamId: STREAM_ONE,
    startedAt: STARTED_AT,
  });

  assert.equal(retry.reportId, first.reportId);
  assert.equal(store.read().length, 1);
  assert.equal(retry.report.totals.completedPaymentCount, 2);
  assert.deepEqual(
    await coordinator.repairPendingReports(STREAM_ONE),
    { repairedCount: 0 },
  );
  assert.deepEqual(
    await coordinator.repairPendingReports(null),
    { repairedCount: 1 },
  );
  assert.equal(store.read()[0].lifecycleStatus, "finalized");
});

test("a sixth finalized report archives the oldest active record without deleting it", async () => {
  const store = createStore();
  const timestamps = Array.from(
    { length: storage.MAX_ACTIVE_REPORTS + 1 },
    (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  );
  const coordinator = createCoordinator(store, timestamps);

  for (let index = 1; index <= storage.MAX_ACTIVE_REPORTS; index += 1) {
    const uuid = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const record = await coordinator.prepareReport({
      reconciliationState: {},
      streamId: `local-stream:${uuid}`,
      startedAt: STARTED_AT,
    });
    await coordinator.finalizeReport(record.reportId);
  }

  const sixth = await coordinator.prepareReport({
    reconciliationState: {},
    streamId:
      "local-stream:99999999-1111-4111-8111-111111111111",
    startedAt: STARTED_AT,
  });
  assert.equal(store.read().length, 6);
  assert.equal(
    (await coordinator.dispatch({ type: "list_reports" })).reports.length,
    storage.MAX_ACTIVE_REPORTS,
  );

  await coordinator.finalizeReport(sixth.reportId);
  const retained = store.read();
  const archived = await coordinator.dispatch({
    type: "list_archived_reports",
  });

  assert.equal(retained.length, 6);
  assert.equal(getActiveCount(retained), storage.MAX_ACTIVE_REPORTS);
  assert.equal(archived.reports.length, 1);
  assert.equal(
    archived.reports[0].reportId.startsWith("stream-report:00000001-"),
    true,
  );
});

test("a report save failure rejects before any End caller can proceed", async () => {
  const coordinator = createCoordinator(createStore({ failSave: true }));

  await assert.rejects(
    coordinator.prepareReport({
      reconciliationState: {},
      streamId: STREAM_ONE,
      startedAt: STARTED_AT,
    }),
    (error) => error.code === "STORAGE_WRITE_FAILED",
  );
});

test("End-without-report discards only the exact pending stream report", async () => {
  const store = createStore();
  const coordinator = createCoordinator(store);
  const prepared = await coordinator.prepareReport({
    reconciliationState: {},
    streamId: STREAM_ONE,
    startedAt: STARTED_AT,
  });

  assert.deepEqual(
    await coordinator.discardPendingReportForStream(STREAM_ONE),
    { discarded: true, reportId: prepared.reportId },
  );
  assert.deepEqual(store.read(), []);
  assert.deepEqual(
    await coordinator.discardPendingReportForStream(STREAM_ONE),
    { discarded: false, reportId: null },
  );
});

test("archive byte cap rejects a new report without deleting saved records", async () => {
  const record = createSavedRecord(1, { archived: true });
  const measure = (candidate) => new TextEncoder().encode(JSON.stringify({
    schemaVersion: storage.STORAGE_SCHEMA_VERSION,
    records: candidate,
  })).byteLength;
  record.report.padding = "x".repeat(
    storage.MAX_ARCHIVE_BYTES - measure([record]) - 100,
  );
  const records = [record];
  const store = createStore({ records });
  const coordinator = createCoordinator(store, [
    "2026-08-10T12:00:00.000Z",
  ]);

  await assert.rejects(
    coordinator.prepareReport({
      reconciliationState: {},
      streamId:
        "local-stream:99999999-1111-4111-8111-111111111111",
      startedAt: STARTED_AT,
    }),
    (error) => error.code === "REPORT_ARCHIVE_FULL",
  );
  assert.deepEqual(store.read(), records);
});

test("a full 5 active plus 25 archived archive blocks prepare without deletion", async () => {
  const records = Array.from(
    { length: storage.MAX_TOTAL_REPORTS },
    (_, index) => createSavedRecord(index + 1, {
      archived: index >= storage.MAX_ACTIVE_REPORTS,
    }),
  );
  const store = createStore({ records });
  const coordinator = createCoordinator(store);

  await assert.rejects(
    coordinator.prepareReport({
      reconciliationState: {},
      streamId: STREAM_ONE,
      startedAt: STARTED_AT,
    }),
    (error) => error.code === "REPORT_TOTAL_LIMIT_REACHED",
  );
  assert.deepEqual(store.read(), records);
});

test("archive, restore, and permanent delete mutations are atomic and keep reports immutable", async () => {
  const records = [
    createSavedRecord(1),
    createSavedRecord(2),
    createSavedRecord(3),
  ];
  const originalReport = clone(records[0].report);
  const store = createStore({ records });
  const coordinator = createCoordinator(store);
  const firstTwo = records.slice(0, 2).map((record) => record.reportId);

  assert.deepEqual(
    await coordinator.dispatch({
      type: "archive_reports",
      reportIds: firstTwo,
    }),
    { reportIds: firstTwo },
  );
  assert.equal((await coordinator.listReports()).reports.length, 1);
  assert.deepEqual(
    (await coordinator.listArchivedReports()).reports.map(
      (summary) => summary.reportId,
    ),
    [...firstTwo].reverse(),
  );
  assert.deepEqual(store.read()[0].report, originalReport);
  assert.equal(Object.hasOwn(await coordinator.getReport(firstTwo[0]), "archived"), false);

  assert.deepEqual(
    await coordinator.dispatch({
      type: "restore_reports",
      reportIds: firstTwo,
    }),
    { reportIds: firstTwo },
  );
  assert.equal((await coordinator.listReports()).reports.length, 3);

  await coordinator.dispatch({
    type: "archive_reports",
    reportIds: firstTwo,
  });
  assert.deepEqual(
    await coordinator.dispatch({
      type: "delete_archived_reports",
      reportIds: firstTwo,
    }),
    { reportIds: firstTwo },
  );
  assert.deepEqual(store.read().map((record) => record.reportId), [
    records[2].reportId,
  ]);
});

test("renames an active finalized report and preserves the name through archive and restore", async () => {
  const target = createSavedRecord(1);
  const neighbor = createSavedRecord(2);
  const originalReport = clone(target.report);
  const store = createStore({ records: [target, neighbor] });
  const coordinator = createCoordinator(store);
  const rename = {
    reportId: target.reportId,
    displayName: "August launch stream",
  };

  assert.deepEqual(await coordinator.renameReport(rename), rename);
  assert.equal(store.read()[0].displayName, rename.displayName);
  assert.deepEqual(store.read()[0].report, originalReport);
  assert.equal(
    (await coordinator.listReports()).reports.find(
      (summary) => summary.reportId === target.reportId,
    ).displayName,
    rename.displayName,
  );
  assert.equal(
    (await coordinator.getReport(target.reportId)).displayName,
    rename.displayName,
  );

  const saveCountAfterRename = store.saves.length;
  assert.deepEqual(await coordinator.renameReport(rename), rename);
  assert.equal(store.saves.length, saveCountAfterRename);

  await coordinator.archiveReports([target.reportId]);
  assert.equal(
    (await coordinator.listArchivedReports()).reports.find(
      (summary) => summary.reportId === target.reportId,
    ).displayName,
    rename.displayName,
  );
  assert.equal(
    (await coordinator.getReport(target.reportId)).displayName,
    rename.displayName,
  );

  await coordinator.restoreReports([target.reportId]);
  assert.equal(
    (await coordinator.listReports()).reports.find(
      (summary) => summary.reportId === target.reportId,
    ).displayName,
    rename.displayName,
  );

  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.RENAME_REPORT,
      reportId: target.reportId,
      displayName: null,
    }),
    { reportId: target.reportId, displayName: null },
  );
  assert.equal(Object.hasOwn(store.read()[0], "displayName"), false);
  assert.equal(
    (await coordinator.getReport(target.reportId)).displayName,
    null,
  );
  assert.deepEqual(store.read()[0].report, originalReport);
  assert.deepEqual(store.read()[1], neighbor);
});

test("rename rejects non-active reports and failed saves leave every record unchanged", async () => {
  const active = createSavedRecord(1);
  const archived = createSavedRecord(2, { archived: true });
  const pending = createSavedRecord(3, { lifecycleStatus: "pending_end" });
  const records = [active, archived, pending];
  const store = createStore({ records });
  const coordinator = createCoordinator(store);

  await assert.rejects(
    coordinator.renameReport({
      reportId: archived.reportId,
      displayName: "Archived report",
    }),
    (error) => error.code === "REPORT_NOT_ACTIVE",
  );
  await assert.rejects(
    coordinator.renameReport({
      reportId: pending.reportId,
      displayName: "Pending report",
    }),
    (error) => error.code === "REPORT_NOT_FINALIZED",
  );
  await assert.rejects(
    coordinator.renameReport({
      reportId: active.reportId,
      displayName: " padded",
    }),
    (error) => error.code === "INVALID_REPORT_DISPLAY_NAME",
  );
  await assert.rejects(
    coordinator.renameReport({
      reportId: "stream-report:99999999-1111-4111-8111-111111111111",
      displayName: "Missing report",
    }),
    (error) => error.code === "REPORT_NOT_FOUND",
  );
  assert.deepEqual(store.read(), records);
  assert.equal(store.saves.length, 0);

  const failingStore = createStore({ records: [active], failSave: true });
  const failingCoordinator = createCoordinator(failingStore);
  await assert.rejects(
    failingCoordinator.renameReport({
      reportId: active.reportId,
      displayName: "New report name",
    }),
    (error) => error.code === "STORAGE_WRITE_FAILED",
  );
  assert.deepEqual(failingStore.read(), [active]);
  assert.equal(failingStore.saves.length, 0);
});

test("restore and archive capacity failures preserve every selected record", async () => {
  const active = Array.from(
    { length: storage.MAX_ACTIVE_REPORTS },
    (_, index) => createSavedRecord(index + 1),
  );
  const archived = createSavedRecord(6, { archived: true });
  const restoreStore = createStore({ records: [...active, archived] });
  const restoreCoordinator = createCoordinator(restoreStore);

  await assert.rejects(
    restoreCoordinator.dispatch({
      type: "restore_reports",
      reportIds: [archived.reportId],
    }),
    (error) => error.code === "REPORT_ACTIVE_LIMIT_REACHED",
  );
  assert.deepEqual(restoreStore.read(), [...active, archived]);

  const fullArchive = Array.from(
    { length: storage.MAX_ARCHIVED_REPORTS },
    (_, index) => createSavedRecord(index + 1, { archived: true }),
  );
  const activeRecord = createSavedRecord(30);
  const archiveStore = createStore({ records: [...fullArchive, activeRecord] });
  const archiveCoordinator = createCoordinator(archiveStore);

  await assert.rejects(
    archiveCoordinator.dispatch({
      type: "archive_reports",
      reportIds: [activeRecord.reportId],
    }),
    (error) => error.code === "REPORT_ARCHIVED_LIMIT_REACHED",
  );
  assert.deepEqual(archiveStore.read(), [...fullArchive, activeRecord]);
});

test("pending reports stay out of both lists and cannot be archive-managed", async () => {
  const store = createStore();
  const coordinator = createCoordinator(store);
  const pending = await coordinator.prepareReport({
    reconciliationState: {},
    streamId: STREAM_ONE,
    startedAt: STARTED_AT,
  });

  assert.deepEqual(await coordinator.listReports(), { reports: [] });
  assert.deepEqual(await coordinator.listArchivedReports(), { reports: [] });
  await assert.rejects(
    coordinator.dispatch({
      type: "archive_reports",
      reportIds: [pending.reportId],
    }),
    (error) => error.code === "REPORT_NOT_FINALIZED",
  );
  assert.equal(store.read()[0].lifecycleStatus, "pending_end");
});

test("returns only sanitized Offline Report Editor data with exact eligibility", async () => {
  const editable = createOfflineEditorRecord(1, {
    displayName: "Saturday stream",
    oversoldQuantity: 1,
    conflicts: [{ code: "price_conflict" }],
  });
  const editableCoordinator = createCoordinator(createStore({
    records: [editable],
  }));
  const data = await editableCoordinator.loadOfflineEditorData({
    reportId: editable.reportId,
    activeStreamExists: false,
  });

  assert.deepEqual(Object.keys(data).sort(), [
    "canceledDetailsAvailable",
    "canceledVariations",
    "completedVariations",
    "displayName",
    "eligibility",
    "endedAt",
    "inventory",
    "reportId",
  ]);
  assert.equal(JSON.stringify(data).includes("privateCanonicalState"), false);
  assert.deepEqual(data.eligibility, {
    status: "editable",
    code: null,
    reason: null,
  });
  assert.deepEqual(data.completedVariations, [
    {
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "TEE-M",
      soldPriceCents: 1500,
    },
  ]);
  assert.deepEqual(data.canceledVariations, [
    {
      variationNumber: 11,
      expectedStatus: "canceled",
      expectedSku: null,
    },
  ]);

  const matrix = [
    {
      record: createOfflineEditorRecord(2),
      activeStreamExists: true,
      status: "blocked",
      code: "ACTIVE_STREAM_ALREADY_EXISTS",
    },
    {
      record: createOfflineEditorRecord(3, {
        lifecycleStatus: "pending_end",
      }),
      activeStreamExists: false,
      status: "blocked",
      code: "REPORT_NOT_FINALIZED",
    },
    {
      record: createOfflineEditorRecord(4, {
        activeBiddingVariationNumber: 12,
      }),
      activeStreamExists: false,
      status: "blocked",
      code: "ACTIVE_BIDDING_AT_END",
    },
    {
      record: createOfflineEditorRecord(5, { paymentFixingCount: 1 }),
      activeStreamExists: false,
      status: "blocked",
      code: "PAYMENT_FIXING_ORDERS_REMAIN",
    },
    {
      record: createOfflineEditorRecord(6, { pendingMappedCount: 1 }),
      activeStreamExists: false,
      status: "blocked",
      code: "PENDING_MAPPED_ORDERS_REMAIN",
    },
    {
      record: createOfflineEditorRecord(7, { unresolvedOrderCount: 1 }),
      activeStreamExists: false,
      status: "blocked",
      code: "UNRESOLVED_ORDERS_REMAIN",
    },
    {
      record: createOfflineEditorRecord(8, {
        completedSales: [],
        canceledOrders: [],
      }),
      activeStreamExists: false,
      status: "read_only",
      code: "NO_EDITABLE_VARIATIONS",
    },
  ];

  for (const entry of matrix) {
    const coordinator = createCoordinator(createStore({
      records: [entry.record],
    }));
    const response = await coordinator.loadOfflineEditorData({
      reportId: entry.record.reportId,
      activeStreamExists: entry.activeStreamExists,
    });

    assert.equal(response.eligibility.status, entry.status);
    assert.equal(response.eligibility.code, entry.code);
    assert.equal(typeof response.eligibility.reason, "string");
  }

  const legacy = createOfflineEditorRecord(9, { canceledOrders: null });
  const legacyData = await createCoordinator(createStore({
    records: [legacy],
  })).loadOfflineEditorData({
    reportId: legacy.reportId,
    activeStreamExists: false,
  });

  assert.equal(legacyData.eligibility.status, "editable");
  assert.equal(legacyData.canceledDetailsAvailable, false);
  assert.deepEqual(legacyData.canceledVariations, []);
});

test("mapping saves preserve active and archived wrappers, positions, and neighbors", async () => {
  for (const archived of [false, true]) {
    const before = createSavedRecord(1);
    const target = createOfflineEditorRecord(2, {
      archived,
      displayName: "Keep this name",
    });
    const after = createSavedRecord(3, { archived: !archived });
    const records = [before, target, after];
    const store = createStore({ records });
    const reportModule = {
      ...streamReport,
      correctReportMappings(candidate, changes) {
        const corrected = clone(candidate);
        const change = changes[0];
        const sale = corrected.completedSales.find(
          (entry) => entry.variationNumber === change.variationNumber,
        );

        sale.sku = change.sku;
        sale.item = "Tee";
        sale.style = "black";
        sale.size = "L";
        return corrected;
      },
    };
    const coordinator = createCoordinator(store, undefined, reportModule);
    const changes = [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "TEE-M",
        sku: "TEE-L",
      },
    ];
    const save = coordinator.correctFinalizedReportMappings({
      reportId: target.reportId,
      changes,
    });

    changes[0].sku = null;
    changes.push({
      variationNumber: 11,
      expectedStatus: "canceled",
      expectedSku: null,
      sku: "TEE-M",
    });
    const response = await save;
    const persisted = store.read();

    assert.equal(response.completedVariations[0].expectedSku, "TEE-L");
    assert.deepEqual(persisted.map((record) => record.reportId),
      records.map((record) => record.reportId));
    assert.deepEqual(persisted[0], before);
    assert.deepEqual(persisted[2], after);
    assert.equal(persisted[1].reportId, target.reportId);
    assert.equal(persisted[1].displayName, "Keep this name");
    assert.equal(persisted[1].lifecycleStatus, "finalized");
    assert.equal(persisted[1].archived, archived);
    const reopened = createCoordinator(store, undefined, reportModule);
    const reopenedData = await reopened.loadOfflineEditorData({
      reportId: target.reportId,
      activeStreamExists: false,
    });
    assert.equal(
      reopenedData.completedVariations[0].expectedSku,
      "TEE-L",
    );

    const saveCount = store.saves.length;
    await coordinator.correctFinalizedReportMappings({
      reportId: target.reportId,
      changes: [
        {
          variationNumber: 10,
          expectedStatus: "payment_complete",
          expectedSku: "TEE-M",
          sku: "TEE-L",
        },
      ],
    });
    assert.equal(store.saves.length, saveCount);
  }
});

test("real mapping corrections persist without changing the saved wrapper or neighbors", async () => {
  const streamId =
    "local-stream:00000002-1111-4111-8111-111111111111";
  const state = realReconciliation.createReconciliationState([
    {
      sku: "TEE-M",
      item: "Tee",
      style: "black",
      size: "M",
      quantityReceived: 2,
      unitCostCents: 500,
    },
    {
      sku: "TEE-L",
      item: "Tee",
      style: "black",
      size: "L",
      quantityReceived: 0,
      unitCostCents: 700,
    },
  ]);
  realReconciliation.mapVariation(state, {
    streamId,
    variationNumber: 10,
    sku: "TEE-M",
  });
  realReconciliation.recordPaymentComplete(state, {
    streamId,
    variationNumber: 10,
    soldPriceCents: 1500,
  });
  const report = realStreamReport.createStreamReport({
    reconciliation: realReconciliation,
    reconciliationState: state,
    streamId,
    startedAt: "2026-08-02T10:00:00.000Z",
    endedAt: "2026-08-02T12:00:00.000Z",
    generatedAt: "2026-08-02T12:00:01.000Z",
  });
  const before = createSavedRecord(1);
  const target = {
    reportId: report.reportId,
    lifecycleStatus: "finalized",
    archived: true,
    displayName: "Keep this name",
    report,
  };
  const after = createSavedRecord(3);
  const originalRecords = [before, target, after];
  const store = createStore({ records: originalRecords });
  const coordinator = createCoordinator(store, undefined, realStreamReport);

  const response = await coordinator.correctFinalizedReportMappings({
    reportId: target.reportId,
    changes: [{
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "TEE-M",
      sku: "TEE-L",
    }],
  });

  assert.equal(response.completedVariations[0].expectedSku, "TEE-L");
  const persisted = store.read();
  assert.deepEqual(
    persisted.map((record) => record.reportId),
    originalRecords.map((record) => record.reportId),
  );
  assert.deepEqual(persisted[0], before);
  assert.deepEqual(persisted[2], after);
  assert.equal(persisted[1].reportId, target.reportId);
  assert.equal(persisted[1].displayName, "Keep this name");
  assert.equal(persisted[1].lifecycleStatus, "finalized");
  assert.equal(persisted[1].archived, true);

  const corrected = persisted[1].report;
  assert.equal(corrected.completedSales[0].sku, "TEE-L");
  assert.equal(corrected.completedSales[0].unitCostCents, 700);
  assert.equal(corrected.completedSales[0].grossProfitCents, 800);
  assert.equal(corrected.totals.costOfGoodsCents, 700);
  assert.equal(corrected.totals.grossProfitCents, 800);
  assert.deepEqual(
    corrected.inventory.map((item) => [
      item.sku,
      item.streamSoldQuantity,
      item.replacementQuantity,
      item.oversoldQuantity,
      item.requiresRecount,
    ]),
    [
      ["TEE-L", 1, 0, 1, true],
      ["TEE-M", 0, 2, 0, false],
    ],
  );
  assert.deepEqual(
    corrected.sheetRows.map((row) => [
      row.sku,
      row.quantity_on_hand_at_import,
      row.unit_cost,
    ]),
    [
      ["TEE-L", 0, "7.00"],
      ["TEE-M", 2, "5.00"],
    ],
  );
  assert.deepEqual(corrected.warnings, [{
    code: "inventory_recount_required",
    count: 1,
    sku: "TEE-L",
  }]);
  assert.deepEqual(corrected.completeness, {
    status: "provisional",
    reasonCodes: ["inventory_recount_required"],
  });
  assert.deepEqual(realStreamReport.hydrateStreamReport(corrected), corrected);

  const reopened = createCoordinator(store, undefined, realStreamReport);
  const durable = await reopened.getReport(target.reportId);
  assert.equal(durable.displayName, "Keep this name");
  assert.equal(durable.lifecycleStatus, "finalized");
  assert.deepEqual(durable.report, corrected);
});

test("ineligible mapping saves reject before transformation or persistence", async () => {
  const scenarios = [
    {
      options: { lifecycleStatus: "pending_end" },
      code: "REPORT_NOT_FINALIZED",
    },
    {
      options: { activeBiddingVariationNumber: 12 },
      code: "ACTIVE_BIDDING_AT_END",
    },
    {
      options: { paymentFixingCount: 1 },
      code: "PAYMENT_FIXING_ORDERS_REMAIN",
    },
    {
      options: { pendingMappedCount: 1 },
      code: "PENDING_MAPPED_ORDERS_REMAIN",
    },
    {
      options: { unresolvedOrderCount: 1 },
      code: "UNRESOLVED_ORDERS_REMAIN",
    },
    {
      options: { completedSales: [], canceledOrders: [] },
      code: "NO_EDITABLE_VARIATIONS",
    },
  ];

  for (const scenario of scenarios) {
    const before = createSavedRecord(1);
    const target = createOfflineEditorRecord(2, scenario.options);
    const after = createSavedRecord(3, { archived: true });
    const records = [before, target, after];
    const store = createStore({ records });
    let transformCount = 0;
    const coordinator = createCoordinator(store, undefined, {
      ...streamReport,
      correctReportMappings() {
        transformCount += 1;
        throw new Error("The mapping transform must not run.");
      },
    });

    await assert.rejects(
      coordinator.correctFinalizedReportMappings({
        reportId: target.reportId,
        changes: [
          {
            variationNumber: 10,
            expectedStatus: "payment_complete",
            expectedSku: "TEE-M",
            sku: "TEE-L",
          },
        ],
      }),
      (error) => error.code === scenario.code,
    );
    assert.equal(transformCount, 0);
    assert.equal(store.saves.length, 0);
    assert.deepEqual(store.read(), records);
  }
});

test("queued mapping correction starts from the newest unit-cost-corrected report", async () => {
  const target = createOfflineEditorRecord(1);
  const store = createStore({ records: [target] });
  let mappingInputUnitCost = null;
  const reportModule = {
    ...streamReport,
    correctReportUnitCost(candidate, input) {
      const corrected = clone(candidate);
      corrected.inventory.find((item) => item.sku === input.sku)
        .unitCostCents = input.unitCostCents;
      return corrected;
    },
    correctReportMappings(candidate, changes) {
      mappingInputUnitCost = candidate.inventory.find(
        (item) => item.sku === "TEE-L",
      ).unitCostCents;
      const corrected = clone(candidate);
      corrected.completedSales[0].sku = changes[0].sku;
      return corrected;
    },
  };
  const coordinator = createCoordinator(store, undefined, reportModule);
  const costSave = coordinator.correctFinalizedReportUnitCost({
    reportId: target.reportId,
    sku: "TEE-L",
    unitCostCents: 825,
  });
  const mappingSave = coordinator.correctFinalizedReportMappings({
    reportId: target.reportId,
    changes: [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "TEE-M",
        sku: "TEE-L",
      },
    ],
  });

  await Promise.all([costSave, mappingSave]);
  assert.equal(mappingInputUnitCost, 825);
  assert.equal(store.read()[0].inventory, undefined);
  assert.equal(store.read()[0].report.inventory[1].unitCostCents, 825);
  assert.equal(store.read()[0].report.completedSales[0].sku, "TEE-L");
});

test("mapping transform and storage failures leave every saved report unchanged", async () => {
  const target = createOfflineEditorRecord(1);
  const neighbor = createSavedRecord(2);
  const records = [target, neighbor];
  const command = {
    reportId: target.reportId,
    changes: [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "TEE-M",
        sku: "TEE-L",
      },
      {
        variationNumber: 999,
        expectedStatus: "canceled",
        expectedSku: null,
        sku: "TEE-M",
      },
    ],
  };
  const transformStore = createStore({ records });
  const transformCoordinator = createCoordinator(
    transformStore,
    undefined,
    {
      ...streamReport,
      correctReportMappings() {
        throw Object.assign(new Error("Variation 999 is stale."), {
          code: "STALE_REPORT_MAPPING",
        });
      },
    },
  );

  await assert.rejects(
    transformCoordinator.correctFinalizedReportMappings(command),
    (error) => error.code === "STALE_REPORT_MAPPING",
  );
  assert.deepEqual(transformStore.read(), records);
  assert.equal(transformStore.saves.length, 0);

  const saveStore = createStore({ records, failSave: true });
  const saveCoordinator = createCoordinator(saveStore);
  await assert.rejects(
    saveCoordinator.correctFinalizedReportMappings(command),
    (error) => error.code === "STORAGE_WRITE_FAILED",
  );
  assert.deepEqual(saveStore.read(), records);
  assert.equal(saveStore.saves.length, 0);
});

test("bulk restore and permanent delete reject mixed selections without partial changes", async () => {
  const active = createSavedRecord(1);
  const archivedOne = createSavedRecord(2, { archived: true });
  const archivedTwo = createSavedRecord(3, { archived: true });
  const records = [active, archivedOne, archivedTwo];
  const store = createStore({ records });
  const coordinator = createCoordinator(store);

  await assert.rejects(
    coordinator.dispatch({
      type: "restore_reports",
      reportIds: [archivedOne.reportId, active.reportId],
    }),
    (error) => error.code === "REPORT_NOT_ARCHIVED",
  );
  assert.deepEqual(store.read(), records);

  await assert.rejects(
    coordinator.dispatch({
      type: "delete_archived_reports",
      reportIds: [archivedTwo.reportId, active.reportId],
    }),
    (error) => error.code === "REPORT_NOT_ARCHIVED",
  );
  assert.deepEqual(store.read(), records);
});
