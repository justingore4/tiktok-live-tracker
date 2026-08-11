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
    archived: false,
    report,
  }];

  const saved = await store.saveRecords(records);
  report.metadata.streamId = "changed";
  saved[0].report.metadata.streamId = "also-changed";

  const loaded = await store.loadRecords();
  assert.equal(loaded[0].report.metadata.streamId.startsWith("local-stream:"), true);
  assert.equal(storage.LEGACY_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(storage.STORAGE_SCHEMA_VERSION, 2);
  assert.equal(storage.MAX_ACTIVE_REPORTS, 5);
  assert.equal(storage.MAX_ARCHIVED_REPORTS, 25);
  assert.equal(storage.MAX_TOTAL_REPORTS, 30);
  assert.equal(storage.TARGET_ARCHIVE_BYTES, 4 * 1024 * 1024);
  assert.equal(storage.LEGACY_MIGRATION_HEADROOM_BYTES, 4 * 1024);
  assert.equal(
    storage.MAX_ARCHIVE_BYTES,
    storage.TARGET_ARCHIVE_BYTES +
      storage.LEGACY_MIGRATION_HEADROOM_BYTES,
  );
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
      archived: false,
      report,
    }]),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );

  await assert.rejects(
    store.saveRecords([
      {
        reportId: report.reportId,
        lifecycleStatus: "finalized",
        archived: false,
        report,
      },
      {
        reportId: createReport(2).reportId,
        lifecycleStatus: "finalized",
        archived: false,
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
      Array.from({ length: storage.MAX_TOTAL_REPORTS + 1 }, (_, index) => {
        const next = createReport(index + 1);
        return {
          reportId: next.reportId,
          lifecycleStatus: "finalized",
          archived: true,
          report: next,
        };
      }),
    ),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
});

test("migrates legacy reports to active Business Records without data loss", async () => {
  const report = createReport();
  const storageArea = createStorageArea({
    [storage.STORAGE_KEY]: {
      schemaVersion: storage.LEGACY_STORAGE_SCHEMA_VERSION,
      records: [{
        reportId: report.reportId,
        lifecycleStatus: "finalized",
        report,
      }],
    },
  });
  const store = storage.createStreamReportStore({ storageArea, streamReport });
  const loaded = await store.loadRecords();

  assert.equal(loaded[0].archived, false);
  assert.deepEqual(
    storageArea.values[storage.STORAGE_KEY],
    {
      schemaVersion: storage.STORAGE_SCHEMA_VERSION,
      records: loaded,
    },
  );
});

test("migration headroom keeps a near-cap legacy report archive-manageable", async () => {
  const report = createReport();
  const legacyRecord = {
    reportId: report.reportId,
    lifecycleStatus: "finalized",
    report,
  };
  const measure = (envelope) =>
    new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  const legacyEnvelope = {
    schemaVersion: storage.LEGACY_STORAGE_SCHEMA_VERSION,
    records: [legacyRecord],
  };
  report.padding = "";
  report.padding = "x".repeat(
    storage.TARGET_ARCHIVE_BYTES - measure(legacyEnvelope),
  );
  const storageArea = createStorageArea({
    [storage.STORAGE_KEY]: legacyEnvelope,
  });
  const store = storage.createStreamReportStore({ storageArea, streamReport });
  const loaded = await store.loadRecords();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].archived, false);
  assert.equal(
    measure(storageArea.values[storage.STORAGE_KEY]) >
      storage.TARGET_ARCHIVE_BYTES,
    true,
  );
  assert.equal(
    measure(storageArea.values[storage.STORAGE_KEY]) <=
      storage.MAX_ARCHIVE_BYTES,
    true,
  );
  assert.equal(
    (await storage.createStreamReportStore({ storageArea, streamReport })
      .loadRecords()).length,
    1,
  );
  loaded[0].archived = true;
  await store.saveRecords(loaded);
  assert.equal((await store.loadRecords())[0].archived, true);
  await store.saveRecords([]);
  assert.deepEqual(await store.loadRecords(), []);
});

test("rejects stored envelopes that exceed their version-specific byte ceiling", async () => {
  for (const legacy of [true, false]) {
    const report = createReport(legacy ? 1 : 2);
    report.padding = "x".repeat(
      legacy ? storage.TARGET_ARCHIVE_BYTES : storage.MAX_ARCHIVE_BYTES,
    );
    const record = {
      reportId: report.reportId,
      lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
      ...(legacy ? {} : { archived: false }),
      report,
    };
    const storageArea = createStorageArea({
      [storage.STORAGE_KEY]: {
        schemaVersion: legacy
          ? storage.LEGACY_STORAGE_SCHEMA_VERSION
          : storage.STORAGE_SCHEMA_VERSION,
        records: [record],
      },
    });
    const store = storage.createStreamReportStore({
      storageArea,
      streamReport,
    });

    await assert.rejects(
      store.loadRecords(),
      (error) => error.code === "REPORT_ARCHIVE_FULL",
    );
  }
});

test("enforces active, archived, lifecycle, and byte limits without pruning", async () => {
  const storageArea = createStorageArea();
  const store = storage.createStreamReportStore({ storageArea, streamReport });
  const makeRecord = (index, archived = false, lifecycleStatus = "finalized") => {
    const report = createReport(index);
    return { reportId: report.reportId, lifecycleStatus, archived, report };
  };

  await assert.rejects(
    store.saveRecords(
      Array.from(
        { length: storage.MAX_ACTIVE_REPORTS + 1 },
        (_, index) => makeRecord(index + 1),
      ),
    ),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
  await assert.rejects(
    store.saveRecords(
      Array.from(
        { length: storage.MAX_ARCHIVED_REPORTS + 1 },
        (_, index) => makeRecord(index + 1, true),
      ),
    ),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
  await assert.rejects(
    store.saveRecords([makeRecord(1, true, "pending_end")]),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );
  await assert.rejects(
    store.saveRecords([
      makeRecord(1, false, "pending_end"),
      makeRecord(2, false, "pending_end"),
    ]),
    (error) => error.code === "INVALID_REPORT_ARCHIVE",
  );

  const oversized = makeRecord(1);
  oversized.report.padding = "x".repeat(storage.MAX_ARCHIVE_BYTES);
  await assert.rejects(
    store.saveRecords([oversized]),
    (error) => error.code === "REPORT_ARCHIVE_FULL",
  );
  assert.deepEqual(storageArea.values, {});
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
