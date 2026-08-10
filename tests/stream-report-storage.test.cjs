const assert = require("node:assert/strict");
const test = require("node:test");

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

function createReport(index = 1) {
  const uuid = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const streamId = `local-stream:${uuid}`;

  return {
    reportId: `stream-report:${uuid}`,
    metadata: {
      streamId,
      startedAt: "2026-08-10T10:00:00.000Z",
      endedAt: `2026-08-${String(index).padStart(2, "0")}T11:00:00.000Z`,
    },
    completeness: { status: "final" },
    totals: {},
  };
}

const streamReport = {
  hydrateStreamReport(candidate) {
    if (!candidate || typeof candidate.reportId !== "string") {
      throw new Error("invalid report");
    }

    return clone(candidate);
  },
};

test("saves and restores a detached bounded report archive", async () => {
  const storageArea = createStorageArea();
  const store = storage.createStreamReportStore({ storageArea, streamReport });
  const report = createReport();
  const records = [{
    reportId: report.reportId,
    lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
    report,
  }];

  const saved = await store.saveRecords(records);
  report.metadata.streamId = "changed";
  saved[0].report.metadata.streamId = "also-changed";

  const loaded = await store.loadRecords();
  assert.equal(loaded[0].report.metadata.streamId.startsWith("local-stream:"), true);
  assert.equal(storage.MAX_REPORTS, 5);
  assert.equal(
    storageArea.values[storage.STORAGE_KEY].schemaVersion,
    storage.STORAGE_SCHEMA_VERSION,
  );
});

test("rejects mismatched wrapper IDs, duplicate streams, and oversized archives", async () => {
  const storageArea = createStorageArea();
  const store = storage.createStreamReportStore({ storageArea, streamReport });
  const report = createReport();

  await assert.rejects(
    store.saveRecords([{
      reportId: "stream-report:22222222-2222-4222-8222-222222222222",
      lifecycleStatus: "finalized",
      report,
    }]),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );

  await assert.rejects(
    store.saveRecords([
      {
        reportId: report.reportId,
        lifecycleStatus: "finalized",
        report,
      },
      {
        reportId: createReport(2).reportId,
        lifecycleStatus: "finalized",
        report: {
          ...createReport(2),
          metadata: { ...report.metadata },
        },
      },
    ]),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );

  await assert.rejects(
    store.saveRecords(
      Array.from({ length: storage.MAX_REPORTS + 1 }, (_, index) => {
        const next = createReport(index + 1);
        return {
          reportId: next.reportId,
          lifecycleStatus: "finalized",
          report: next,
        };
      }),
    ),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
});

test("reports typed storage read and write failures", async () => {
  const readStore = storage.createStreamReportStore({
    streamReport,
    storageArea: {
      get: async () => { throw new Error("read failed"); },
      set: async () => undefined,
    },
  });
  const writeStore = storage.createStreamReportStore({
    streamReport,
    storageArea: {
      get: async () => ({}),
      set: async () => { throw new Error("write failed"); },
    },
  });

  await assert.rejects(
    readStore.loadRecords(),
    (error) => error.code === "STORAGE_READ_FAILED",
  );
  await assert.rejects(
    writeStore.saveRecords([]),
    (error) => error.code === "STORAGE_WRITE_FAILED",
  );
});

