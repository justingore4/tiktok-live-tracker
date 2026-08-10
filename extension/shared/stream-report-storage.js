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
    const STORAGE_SCHEMA_VERSION = 1;
    const MAX_REPORTS = 5;
    const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
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

    function hydrateRecord(streamReport, record, index) {
      const path = `records[${index}]`;

      if (!hasExactKeys(record, ["lifecycleStatus", "report", "reportId"])) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `${path} must contain exactly lifecycleStatus, report, and reportId.`,
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
        report: cloneSerializable(report),
      };
    }

    function hydrateRecords(streamReport, records) {
      if (!Array.isArray(records)) {
        fail("INVALID_REPORT_ARCHIVE", "records must be an array.");
      }

      if (records.length > MAX_REPORTS) {
        fail(
          "INVALID_REPORT_ARCHIVE",
          `records cannot contain more than ${MAX_REPORTS} reports.`,
        );
      }

      const reportIds = new Set();
      const streamIds = new Set();
      return records.map((record, index) => {
        const hydrated = hydrateRecord(streamReport, record, index);
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
    }

    function createStreamReportStore(options) {
      const { storageArea, streamReport } = validateDependencies(options);

      async function loadRecords() {
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

        if (envelope.schemaVersion !== STORAGE_SCHEMA_VERSION) {
          fail(
            "UNSUPPORTED_STORAGE_VERSION",
            `Stream-report storage version ${envelope.schemaVersion} is not supported.`,
          );
        }

        return hydrateRecords(streamReport, envelope.records);
      }

      async function saveRecords(records) {
        const hydratedRecords = hydrateRecords(streamReport, records);
        const envelope = {
          schemaVersion: STORAGE_SCHEMA_VERSION,
          records: hydratedRecords,
        };

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
      MAX_ARCHIVE_BYTES,
      MAX_REPORTS,
      REPORT_ID_PATTERN,
      STORAGE_KEY,
      STORAGE_SCHEMA_VERSION,
      StreamReportStorageError,
      createStreamReportStore,
    });
  },
);
