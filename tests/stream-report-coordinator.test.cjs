const assert = require("node:assert/strict");
const test = require("node:test");

const coordinatorModule = require(
  "../extension/shared/stream-report-coordinator.js",
);
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
    report,
  };
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
