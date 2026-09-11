(function initializeStreamReportStorage(root, factory) {
  const streamReportStorage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamReportStorage;
  }

  root.TikTokLiveTrackerStreamReportStorage = streamReportStorage;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamReportStorageModule() {
    "use strict";

    const STORAGE_KEY = "tiktokLiveTracker.streamReports";
    const LEGACY_STORAGE_SCHEMA_VERSION = 1;
    const PREVIOUS_STORAGE_SCHEMA_VERSION = 2;
    const STORAGE_SCHEMA_VERSION = 3;
    const MAX_ACTIVE_REPORTS = 5;
    const MAX_ARCHIVED_REPORTS = 25;
    const MAX_TOTAL_REPORTS =
      MAX_ACTIVE_REPORTS + MAX_ARCHIVED_REPORTS;
    const MAX_REPORT_DISPLAY_NAME_LENGTH = 80;
    const TARGET_ARCHIVE_BYTES = 4 * 1024 * 1024;
    const LEGACY_MIGRATION_HEADROOM_BYTES = 4 * 1024;
    const PREVIOUS_MAX_ARCHIVE_BYTES =
      TARGET_ARCHIVE_BYTES + LEGACY_MIGRATION_HEADROOM_BYTES;
    const REPORT_DISPLAY_NAME_HEADROOM_BYTES = 4 * 1024;
    const MAX_ARCHIVE_BYTES =
      PREVIOUS_MAX_ARCHIVE_BYTES + REPORT_DISPLAY_NAME_HEADROOM_BYTES;
    const REPORT_ID_PATTERN =
      /^stream-report:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const LIFECYCLE_STATUSES = Object.freeze({
      FINALIZED: "finalized",
      PENDING_END: "pending_end",
    });
    const LIFECYCLE_STATUS_VALUES = new Set(
      Object.values(LIFECYCLE_STATUSES),
    );

    class StreamReportStorageError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "StreamReportStorageError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new StreamReportStorageError(code, message, { cause });
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function hasExactKeys(value, expectedKeys) {
      if (!isPlainRecord(value)) {
        return false;
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();
      return actualKeys.length === sortedExpectedKeys.length &&
        actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
    }

    function cloneSerializable(value) {
      try {
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          fail(
            "INVALID_REPORT_ARCHIVE",
            "The stream-report archive must contain only JSON-serializable values.",
          );
        }

        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof StreamReportStorageError) {
          throw error;
        }

        fail(
          "INVALID_REPORT_ARCHIVE",
          "The stream-report archive must contain only JSON-serializable values.",
          error,
        );
      }
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Stream-report storage options are required.");
      }

      const { storageArea, streamReport } = options;

      if (
        !storageArea ||
        typeof storageArea.get !== "function" ||
        typeof storageArea.set !== "function"
      ) {
        throw new TypeError(
          "storageArea must provide Promise-based get and set methods.",
        );
      }

      if (
        !streamReport ||
        typeof streamReport.hydrateStreamReport !== "function"
      ) {
        throw new TypeError(
          "streamReport must provide hydrateStreamReport.",
        );
      }

      return { storageArea, streamReport };
    }

    function hydrateRecord(streamReport, record, index, options = {}) {
      const path = `records[${index}]`;
      const schemaVersion = options.schemaVersion ?? STORAGE_SCHEMA_VERSION;
      const legacy = schemaVersion === LEGACY_STORAGE_SCHEMA_VERSION;
      const hasDisplayName =
        isPlainRecord(record) &&
        Object.prototype.hasOwnProperty.call(record, "displayName");
      const expectedKeys = legacy
        ? ["lifecycleStatus", "report", "reportId"]
        : [
            "archived",
            ...(hasDisplayName ? ["displayName"] : []),
            "lifecycleStatus",
            "report",
            "reportId",
          ];

      if (
        !hasExactKeys(record, expectedKeys) ||
        (schemaVersion < STORAGE_SCHEMA_VERSION && hasDisplayName)
      ) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path} has an invalid saved report shape.`,
        );
      }

      if (
        typeof record.reportId !== "string" ||
        !REPORT_ID_PATTERN.test(record.reportId)
      ) {
        fail("INVALID_REPORT_ARCHIVE", `${path}.reportId is invalid.`);
      }

      if (!LIFECYCLE_STATUS_VALUES.has(record.lifecycleStatus)) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path}.lifecycleStatus is invalid.`,
        );
      }

      const archived = legacy ? false : record.archived;

      if (typeof archived !== "boolean") {
        fail("INVALID_REPORT_ARCHIVE", `${path}.archived is invalid.`);
      }

      if (
        hasDisplayName &&
        (
          typeof record.displayName !== "string" ||
          record.displayName.length < 1 ||
          record.displayName.length > MAX_REPORT_DISPLAY_NAME_LENGTH ||
          record.displayName !== record.displayName.trim() ||
          /[\u0000-\u001f\u007f]/.test(record.displayName)
        )
      ) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path}.displayName is invalid.`,
        );
      }

      if (
        archived &&
        record.lifecycleStatus !== LIFECYCLE_STATUSES.FINALIZED
      ) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path} cannot archive a report while End recovery is pending.`,
        );
      }

      let report;

      try {
        report = streamReport.hydrateStreamReport(record.report);
      } catch (error) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path}.report is invalid.`,
          error,
        );
      }

      if (report.reportId !== record.reportId) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path}.reportId must match its report.`,
        );
      }

      return {
        reportId: record.reportId,
        lifecycleStatus: record.lifecycleStatus,
        archived,
        ...(hasDisplayName ? { displayName: record.displayName } : {}),
        report: cloneSerializable(report),
      };
    }

    function hydrateRecords(streamReport, records, options = {}) {
      if (!Array.isArray(records)) {
        fail("INVALID_REPORT_ARCHIVE", "records must be an array.");
      }

      if (records.length > MAX_TOTAL_REPORTS) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `records cannot contain more than ${MAX_TOTAL_REPORTS} reports.`,
        );
      }

      const reportIds = new Set();
      const streamIds = new Set();
      const hydratedRecords = records.map((record, index) => {
        const hydrated = hydrateRecord(
          streamReport,
          record,
          index,
          options,
        );
        const streamId = hydrated.report?.metadata?.streamId;

        if (reportIds.has(hydrated.reportId)) {
          fail(
            "INVALID_REPORT_ARCHIVE",
            `records contains duplicate report ${hydrated.reportId}.`,
          );
        }

        if (typeof streamId !== "string" || streamId.trim() === "") {
          fail(
            "INVALID_REPORT_ARCHIVE",
            `records[${index}].report metadata has no stream ID.`,
          );
        }

        if (streamIds.has(streamId)) {
          fail(
            "INVALID_REPORT_ARCHIVE",
            `records contains more than one report for stream ${streamId}.`,
          );
        }

        reportIds.add(hydrated.reportId);
        streamIds.add(streamId);
        return hydrated;
      });

      const activeCount = hydratedRecords.filter(
        (record) =>
          !record.archived &&
          record.lifecycleStatus === LIFECYCLE_STATUSES.FINALIZED,
      ).length;
      const archivedCount = hydratedRecords.filter(
        (record) => record.archived,
      ).length;
      const pendingCount = hydratedRecords.filter(
        (record) =>
          record.lifecycleStatus === LIFECYCLE_STATUSES.PENDING_END,
      ).length;

      if (activeCount > MAX_ACTIVE_REPORTS) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `records cannot contain more than ${MAX_ACTIVE_REPORTS} active Business Records.`,
        );
      }

      if (archivedCount > MAX_ARCHIVED_REPORTS) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `records cannot contain more than ${MAX_ARCHIVED_REPORTS} archived reports.`,
        );
      }

      if (pendingCount > 1) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          "records cannot contain more than one report awaiting End recovery.",
        );
      }

      return hydratedRecords;
    }

    function createEnvelope(records) {
      return {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        records,
      };
    }

    function getEnvelopeByteLength(envelope) {
      return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    }

    // Measure the same canonical JSON envelope used by saveRecords, including
    // its schema metadata and every lifecycle state. Records are already
    // hydrated by the store; measuring must not write or change them.
    function measureRecordsByteLength(records) {
      return getEnvelopeByteLength(createEnvelope(records));
    }

    function requireSafeEnvelopeSize(
      envelope,
      maxBytes = MAX_ARCHIVE_BYTES,
    ) {
      if (getEnvelopeByteLength(envelope) > maxBytes) {
        fail(
          "REPORT_ARCHIVE_FULL",
          "Saved stream reports exceed the safe local archive size.",
        );
      }

      return envelope;
    }

    function createStreamReportStore(options) {
      const { storageArea, streamReport } = validateDependencies(options);

      async function loadRecords({ readOnly = false } = {}) {
        let storedValues;

        try {
          storedValues = await storageArea.get(STORAGE_KEY);
        } catch (error) {
          fail(
            "STORAGE_READ_FAILED",
            "Could not read saved stream reports from browser storage.",
            error,
          );
        }

        if (!isPlainRecord(storedValues)) {
          fail(
            "STORAGE_READ_FAILED",
            "Browser storage returned an invalid stream-report response.",
          );
        }

        if (!Object.prototype.hasOwnProperty.call(storedValues, STORAGE_KEY)) {
          return [];
        }

        const envelope = storedValues[STORAGE_KEY];

        if (!hasExactKeys(envelope, ["records", "schemaVersion"])) {
          fail(
            "INVALID_STORAGE_ENVELOPE",
            "The stream-report storage envelope is invalid.",
          );
        }

        if (
          !Number.isSafeInteger(envelope.schemaVersion) ||
          envelope.schemaVersion < 1
        ) {
          fail(
            "INVALID_STORAGE_ENVELOPE",
            "The stream-report storage version must be a positive safe integer.",
          );
        }

        if (
          envelope.schemaVersion !== STORAGE_SCHEMA_VERSION &&
          envelope.schemaVersion !== PREVIOUS_STORAGE_SCHEMA_VERSION &&
          envelope.schemaVersion !== LEGACY_STORAGE_SCHEMA_VERSION
        ) {
          fail(
            "UNSUPPORTED_STORAGE_VERSION",
            `Stream-report storage version ${envelope.schemaVersion} is not supported.`,
          );
        }

        const legacy =
          envelope.schemaVersion === LEGACY_STORAGE_SCHEMA_VERSION;
        const previous =
          envelope.schemaVersion === PREVIOUS_STORAGE_SCHEMA_VERSION;
        requireSafeEnvelopeSize(
          envelope,
          legacy
            ? TARGET_ARCHIVE_BYTES
            : previous
              ? PREVIOUS_MAX_ARCHIVE_BYTES
              : MAX_ARCHIVE_BYTES,
        );
        const hydratedRecords = hydrateRecords(
          streamReport,
          envelope.records,
          { schemaVersion: envelope.schemaVersion },
        );
        // Existing records migrate without eviction. The effective ceiling
        // includes a small fixed headroom for the v2 archive flags. Default
        // report names remain implicit, so the v3 migration adds no per-record
        // display-name payload.
        const migratedEnvelope = requireSafeEnvelopeSize(
          createEnvelope(hydratedRecords),
        );

        if (
          envelope.schemaVersion !== STORAGE_SCHEMA_VERSION &&
          !readOnly
        ) {
          try {
            await storageArea.set({ [STORAGE_KEY]: migratedEnvelope });
          } catch (error) {
            fail(
              "STORAGE_WRITE_FAILED",
              "Could not migrate saved stream reports in browser storage.",
              error,
            );
          }
        }

        return hydratedRecords;
      }

      async function saveRecords(records) {
        const hydratedRecords = hydrateRecords(streamReport, records);
        const envelope = requireSafeEnvelopeSize(
          createEnvelope(hydratedRecords),
        );

        try {
          await storageArea.set({ [STORAGE_KEY]: envelope });
        } catch (error) {
          fail(
            "STORAGE_WRITE_FAILED",
            "Could not save the stream report to browser storage.",
            error,
          );
        }

        return hydrateRecords(streamReport, hydratedRecords);
      }

      return Object.freeze({ loadRecords, saveRecords });
    }

    return Object.freeze({
      LIFECYCLE_STATUSES,
      LEGACY_STORAGE_SCHEMA_VERSION,
      LEGACY_MIGRATION_HEADROOM_BYTES,
      MAX_ACTIVE_REPORTS,
      MAX_ARCHIVE_BYTES,
      MAX_ARCHIVED_REPORTS,
      MAX_TOTAL_REPORTS,
      MAX_REPORT_DISPLAY_NAME_LENGTH,
      PREVIOUS_MAX_ARCHIVE_BYTES,
      PREVIOUS_STORAGE_SCHEMA_VERSION,
      REPORT_DISPLAY_NAME_HEADROOM_BYTES,
      REPORT_ID_PATTERN,
      STORAGE_KEY,
      STORAGE_SCHEMA_VERSION,
      TARGET_ARCHIVE_BYTES,
      StreamReportStorageError,
      createStreamReportStore,
      measureRecordsByteLength,
    });
  },
);
