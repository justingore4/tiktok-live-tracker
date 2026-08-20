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

function createStorageArea(initial = {}) {
  const values = clone(initial);

  return {
    values,
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
    },
    async set(entries) {
      Object.assign(values, clone(entries));
    },
  };
}

function uuidFor(index) {
  return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function streamIdFor(index) {
  return `local-stream:${uuidFor(index)}`;
}

function reportIdFor(index) {
  return `stream-report:${uuidFor(index)}`;
}

function timestampFor(index) {
  return new Date(Date.UTC(2026, 7, 10, 12, 0, index)).toISOString();
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
        "inventory-baseline:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      activeBiddingVariationNumber: null,
    },
    completeness: { status: "final", reasonCodes: [] },
    totals: {
      completedPaymentCount: options.reconciliationState.completed ?? 1,
      totalSalesCount: options.reconciliationState.total ?? 1,
      completedGmvCents: options.reconciliationState.gmv ?? 100,
      attributedGmvDisplay: options.reconciliationState.attributed ?? null,
    },
    padding: options.reconciliationState.padding ?? "",
  };
}

const streamReport = {
  createStreamReport: createReport,
  correctReportUnitCost(candidate) {
    return clone(candidate);
  },
  hydrateStreamReport(candidate) {
    if (
      !candidate ||
      typeof candidate.reportId !== "string" ||
      typeof candidate.metadata?.streamId !== "string"
    ) {
      throw new Error("invalid report");
    }

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

function createHarness(initialStorage = {}) {
  const storageArea = createStorageArea(initialStorage);
  const reportStore = storage.createStreamReportStore({
    storageArea,
    streamReport,
  });
  let nextTimestampIndex = 1;
  const coordinator = coordinatorModule.createStreamReportCoordinator({
    now() {
      const value = timestampFor(nextTimestampIndex);
      nextTimestampIndex += 1;
      return value;
    },
    protocol,
    reconciliation,
    reportStore,
    storage,
    streamReport,
  });

  return { coordinator, reportStore, storageArea };
}

async function prepareAndFinalize(coordinator, index, state = {}) {
  const prepared = await coordinator.prepareReport({
    reconciliationState: state,
    streamId: streamIdFor(index),
    startedAt: "2026-08-10T10:00:00.000Z",
  });

  return coordinator.finalizeReport(prepared.reportId);
}

async function listIds(coordinator, type) {
  const result = await coordinator.dispatch({ type });
  return result.reports.map((report) => report.reportId);
}

function savedEnvelope(storageArea) {
  return clone(storageArea.values[storage.STORAGE_KEY]);
}

test("a sixth Business Record archives the oldest report without changing its contents", async () => {
  const { coordinator, storageArea } = createHarness();
  let oldestRecord;

  for (let index = 1; index <= 6; index += 1) {
    const finalized = await prepareAndFinalize(coordinator, index, {
      completed: index,
      total: index + 1,
      gmv: index * 100,
    });

    if (index === 1) {
      oldestRecord = clone(finalized);
    }
  }

  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_REPORTS),
    [6, 5, 4, 3, 2].map(reportIdFor),
  );
  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS),
    [reportIdFor(1)],
  );
  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.GET_REPORT,
      reportId: reportIdFor(1),
    }),
    oldestRecord,
  );

  const envelope = savedEnvelope(storageArea);
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.records.length, 6);
  assert.equal(
    envelope.records.find((record) => record.reportId === reportIdFor(1))
      .archived,
    true,
  );
});

test("archive moves are atomic, restore uses only available slots, and deletion is archived-only", async () => {
  const { coordinator, storageArea } = createHarness();

  for (let index = 1; index <= 6; index += 1) {
    await prepareAndFinalize(coordinator, index);
  }

  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.ARCHIVE_REPORTS,
      reportIds: [reportIdFor(2), reportIdFor(3)],
    }),
    { reportIds: [reportIdFor(2), reportIdFor(3)] },
  );
  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.RESTORE_REPORTS,
      reportIds: [reportIdFor(1), reportIdFor(2)],
    }),
    { reportIds: [reportIdFor(1), reportIdFor(2)] },
  );
  await coordinator.dispatch({
    type: protocol.COMMAND_TYPES.ARCHIVE_REPORTS,
    reportIds: [reportIdFor(4)],
  });

  const beforeOversizedRestore = savedEnvelope(storageArea);
  await assert.rejects(
    coordinator.dispatch({
      type: protocol.COMMAND_TYPES.RESTORE_REPORTS,
      reportIds: [reportIdFor(3), reportIdFor(4)],
    }),
    (error) => error.code === "REPORT_ACTIVE_LIMIT_REACHED",
  );
  assert.deepEqual(savedEnvelope(storageArea), beforeOversizedRestore);

  const beforeMixedDelete = savedEnvelope(storageArea);
  await assert.rejects(
    coordinator.dispatch({
      type: protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
      reportIds: [reportIdFor(1), reportIdFor(3)],
    }),
    (error) => error.code === "REPORT_NOT_ARCHIVED",
  );
  assert.deepEqual(savedEnvelope(storageArea), beforeMixedDelete);

  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
      reportIds: [reportIdFor(3), reportIdFor(4)],
    }),
    { reportIds: [reportIdFor(3), reportIdFor(4)] },
  );
  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS),
    [],
  );
});

test("full count capacity preserves all reports and allows a retry after explicit archive deletion", async () => {
  const { coordinator, storageArea } = createHarness();

  for (let index = 1; index <= storage.MAX_TOTAL_REPORTS; index += 1) {
    await prepareAndFinalize(coordinator, index);
  }

  assert.equal(
    (await coordinator.dispatch({ type: protocol.COMMAND_TYPES.LIST_REPORTS }))
      .reports.length,
    storage.MAX_ACTIVE_REPORTS,
  );
  assert.equal(
    (await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
    })).reports.length,
    storage.MAX_ARCHIVED_REPORTS,
  );

  const fullEnvelope = savedEnvelope(storageArea);
  await assert.rejects(
    coordinator.prepareReport({
      reconciliationState: {},
      streamId: streamIdFor(31),
      startedAt: "2026-08-10T10:00:00.000Z",
    }),
    (error) => error.code === "REPORT_TOTAL_LIMIT_REACHED",
  );
  assert.deepEqual(savedEnvelope(storageArea), fullEnvelope);

  await coordinator.dispatch({
    type: protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
    reportIds: [reportIdFor(1)],
  });
  const pending = await coordinator.prepareReport({
    reconciliationState: {},
    streamId: streamIdFor(31),
    startedAt: "2026-08-10T10:00:00.000Z",
  });

  assert.equal(pending.lifecycleStatus, storage.LIFECYCLE_STATUSES.PENDING_END);
  assert.equal(
    (await coordinator.dispatch({ type: protocol.COMMAND_TYPES.LIST_REPORTS }))
      .reports.length,
    storage.MAX_ACTIVE_REPORTS,
  );
  assert.equal(
    (await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
    })).reports.length,
    storage.MAX_ARCHIVED_REPORTS - 1,
  );

  const beforePendingMutation = savedEnvelope(storageArea);
  await assert.rejects(
    coordinator.dispatch({
      type: protocol.COMMAND_TYPES.ARCHIVE_REPORTS,
      reportIds: [pending.reportId],
    }),
    (error) => error.code === "REPORT_NOT_FINALIZED",
  );
  await assert.rejects(
    coordinator.dispatch({
      type: protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
      reportIds: [pending.reportId],
    }),
    (error) => error.code === "REPORT_NOT_ARCHIVED",
  );
  assert.deepEqual(savedEnvelope(storageArea), beforePendingMutation);

  await coordinator.finalizeReport(pending.reportId);
  assert.equal(
    (await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
    })).reports.length,
    storage.MAX_ARCHIVED_REPORTS,
  );
});

test("byte-cap failure preserves existing reports instead of silently evicting one", async () => {
  const { coordinator, storageArea } = createHarness();
  await prepareAndFinalize(coordinator, 1, {
    padding: "x".repeat(3_400_000),
  });
  const before = savedEnvelope(storageArea);

  await assert.rejects(
    coordinator.prepareReport({
      reconciliationState: { padding: "y".repeat(1_000_000) },
      streamId: streamIdFor(2),
      startedAt: "2026-08-10T10:00:00.000Z",
    }),
    (error) => error.code === "REPORT_ARCHIVE_FULL",
  );

  assert.deepEqual(savedEnvelope(storageArea), before);
  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_REPORTS),
    [reportIdFor(1)],
  );
  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS),
    [],
  );
});

test("the hidden End-recovery staging record is limited to one and cannot become archive data", async () => {
  const { reportStore, storageArea } = createHarness();
  const pendingRecords = [1, 2].map((index) => {
    const timestamp = timestampFor(index);
    const report = createReport({
      reconciliationState: {},
      streamId: streamIdFor(index),
      startedAt: "2026-08-10T10:00:00.000Z",
      endedAt: timestamp,
      generatedAt: timestamp,
    });

    return {
      reportId: report.reportId,
      lifecycleStatus: storage.LIFECYCLE_STATUSES.PENDING_END,
      archived: false,
      report,
    };
  });

  await assert.rejects(
    reportStore.saveRecords(pendingRecords),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
  assert.equal(Object.hasOwn(storageArea.values, storage.STORAGE_KEY), false);

  await assert.rejects(
    reportStore.saveRecords([{ ...pendingRecords[0], archived: true }]),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
  assert.equal(Object.hasOwn(storageArea.values, storage.STORAGE_KEY), false);
});

test("a near-cap legacy record migrates before explicit archive and delete operations", async () => {
  const timestamp = timestampFor(1);
  const report = createReport({
    reconciliationState: {},
    streamId: streamIdFor(1),
    startedAt: "2026-08-10T10:00:00.000Z",
    endedAt: timestamp,
    generatedAt: timestamp,
  });
  const legacyEnvelope = {
    schemaVersion: storage.LEGACY_STORAGE_SCHEMA_VERSION,
    records: [{
      reportId: report.reportId,
      lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
      report,
    }],
  };
  const measure = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  report.padding = "z".repeat(
    storage.TARGET_ARCHIVE_BYTES - measure(legacyEnvelope) - 4,
  );
  const { coordinator, storageArea } = createHarness({
    [storage.STORAGE_KEY]: legacyEnvelope,
  });
  const expectedPublicRecord = {
    reportId: report.reportId,
    lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
    report: clone(report),
  };

  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_REPORTS),
    [report.reportId],
  );
  assert.equal(savedEnvelope(storageArea).schemaVersion, 2);
  assert.equal(measure(savedEnvelope(storageArea)) > storage.TARGET_ARCHIVE_BYTES, true);
  assert.equal(measure(savedEnvelope(storageArea)) <= storage.MAX_ARCHIVE_BYTES, true);

  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.ARCHIVE_REPORTS,
      reportIds: [report.reportId],
    }),
    { reportIds: [report.reportId] },
  );
  assert.deepEqual(
    await listIds(coordinator, protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS),
    [report.reportId],
  );
  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.GET_REPORT,
      reportId: report.reportId,
    }),
    expectedPublicRecord,
  );

  assert.deepEqual(
    await coordinator.dispatch({
      type: protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
      reportIds: [report.reportId],
    }),
    { reportIds: [report.reportId] },
  );
  assert.deepEqual(savedEnvelope(storageArea).records, []);
});
