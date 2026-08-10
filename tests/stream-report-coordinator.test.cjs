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

function createCoordinator(store, timestamps = ["2026-08-10T12:00:00.000Z"]) {
  let index = 0;
  return coordinatorModule.createStreamReportCoordinator({
    now: () => timestamps[Math.min(index++, timestamps.length - 1)],
    protocol,
    reconciliation,
    reportStore: store,
    storage,
    streamReport,
  });
}

const STREAM_ONE =
  "local-stream:11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-08-10T10:00:00.000Z";

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

  const finalized = await coordinator.finalizeReport(prepared.reportId);
  assert.equal(finalized.lifecycleStatus, "finalized");
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

test("bounded archive prunes the oldest finalized report without pruning pending", async () => {
  const store = createStore();
  const timestamps = Array.from(
    { length: storage.MAX_REPORTS + 1 },
    (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  );
  const coordinator = createCoordinator(store, timestamps);

  for (let index = 1; index <= storage.MAX_REPORTS; index += 1) {
    const uuid = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const record = await coordinator.prepareReport({
      reconciliationState: {},
      streamId: `local-stream:${uuid}`,
      startedAt: STARTED_AT,
    });
    await coordinator.finalizeReport(record.reportId);
  }

  const pending = await coordinator.prepareReport({
    reconciliationState: {},
    streamId:
      "local-stream:99999999-1111-4111-8111-111111111111",
    startedAt: STARTED_AT,
  });
  const retained = store.read();

  assert.equal(retained.length, storage.MAX_REPORTS);
  assert.equal(
    retained.some((record) => record.reportId === pending.reportId),
    true,
  );
  assert.equal(
    retained.some((record) =>
      record.reportId.startsWith("stream-report:00000001-"),
    ),
    false,
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

test("archive byte cap prunes finalized reports but never a pending report", async () => {
  const padding = "x".repeat(1_300_000);
  const records = Array.from({ length: 4 }, (_, index) => {
    const uuid = `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const streamId = `local-stream:${uuid}`;
    const report = {
      ...createReport({
        reconciliationState: {},
        streamId,
        startedAt: STARTED_AT,
        endedAt: `2026-08-0${index + 1}T12:00:00.000Z`,
        generatedAt: `2026-08-0${index + 1}T12:00:00.000Z`,
      }),
      padding,
    };

    return {
      reportId: report.reportId,
      lifecycleStatus: "finalized",
      report,
    };
  });
  const store = createStore({ records });
  const coordinator = createCoordinator(store, [
    "2026-08-10T12:00:00.000Z",
  ]);
  const pending = await coordinator.prepareReport({
    reconciliationState: {},
    streamId:
      "local-stream:99999999-1111-4111-8111-111111111111",
    startedAt: STARTED_AT,
  });
  const retained = store.read();

  assert.equal(
    retained.some((record) => record.reportId === pending.reportId),
    true,
  );
  assert.equal(retained.length < 5, true);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(retained)).byteLength <=
      storage.MAX_ARCHIVE_BYTES,
    true,
  );
});

test("archive byte cap rejects rather than pruning pending reports", async () => {
  const streamId =
    "local-stream:88888888-1111-4111-8111-111111111111";
  const report = {
    ...createReport({
      reconciliationState: {},
      streamId,
      startedAt: STARTED_AT,
      endedAt: "2026-08-09T12:00:00.000Z",
      generatedAt: "2026-08-09T12:00:00.000Z",
    }),
    padding: "x".repeat(storage.MAX_ARCHIVE_BYTES),
  };
  const store = createStore({
    records: [{
      reportId: report.reportId,
      lifecycleStatus: "pending_end",
      report,
    }],
  });
  const coordinator = createCoordinator(store);

  await assert.rejects(
    coordinator.prepareReport({
      reconciliationState: {},
      streamId: STREAM_ONE,
      startedAt: STARTED_AT,
    }),
    (error) => error.code === "REPORT_ARCHIVE_FULL",
  );
  assert.equal(store.read()[0].reportId, report.reportId);
});
