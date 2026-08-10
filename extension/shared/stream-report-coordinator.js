(function initializeStreamReportCoordinator(root, factory) {
  const streamReportCoordinator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamReportCoordinator;
  }

  root.TikTokLiveTrackerStreamReportCoordinator = streamReportCoordinator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamReportCoordinatorModule() {
    "use strict";

    class StreamReportCoordinatorError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "StreamReportCoordinatorError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new StreamReportCoordinatorError(code, message, { cause });
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function cloneSerializable(value) {
      try {
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          fail(
            "INVALID_REPORT_DATA",
            "Stream-report data must be JSON serializable.",
          );
        }

        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof StreamReportCoordinatorError) {
          throw error;
        }

        fail(
          "INVALID_REPORT_DATA",
          "Stream-report data must be JSON serializable.",
          error,
        );
      }
    }

    function requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value !== value.trim() || value === "") {
        fail("INVALID_ARGUMENT", `${fieldName} must be a non-empty string.`);
      }

      return value;
    }

    function requireCanonicalTimestamp(value, fieldName) {
      if (typeof value !== "string") {
        fail("INVALID_ARGUMENT", `${fieldName} must be a UTC ISO timestamp.`);
      }

      const parsed = new Date(value);

      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        fail("INVALID_ARGUMENT", `${fieldName} must be a UTC ISO timestamp.`);
      }

      return value;
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Stream-report coordinator options are required.");
      }

      const {
        now,
        protocol,
        reconciliation,
        reportStore,
        streamReport,
        storage,
      } = options;

      if (typeof now !== "function") {
        throw new TypeError("now must be a function.");
      }

      if (
        !protocol ||
        !protocol.COMMAND_TYPES ||
        typeof protocol.validateCommand !== "function" ||
        !(protocol.REPORT_ID_PATTERN instanceof RegExp)
      ) {
        throw new TypeError("A valid stream-report protocol is required.");
      }

      if (
        !reconciliation ||
        typeof reconciliation.hydrateReconciliationState !== "function" ||
        typeof reconciliation.calculateSummary !== "function"
      ) {
        throw new TypeError("A valid reconciliation module is required.");
      }

      if (
        !reportStore ||
        typeof reportStore.loadRecords !== "function" ||
        typeof reportStore.saveRecords !== "function"
      ) {
        throw new TypeError(
          "reportStore must provide loadRecords and saveRecords.",
        );
      }

      if (
        !streamReport ||
        typeof streamReport.createStreamReport !== "function" ||
        typeof streamReport.hydrateStreamReport !== "function"
      ) {
        throw new TypeError(
          "streamReport must provide createStreamReport and hydrateStreamReport.",
        );
      }

      if (
        !storage ||
        !storage.LIFECYCLE_STATUSES ||
        !Number.isSafeInteger(storage.MAX_REPORTS) ||
        storage.MAX_REPORTS < 1 ||
        !Number.isSafeInteger(storage.MAX_ARCHIVE_BYTES) ||
        storage.MAX_ARCHIVE_BYTES < 1024 ||
        !Number.isSafeInteger(storage.STORAGE_SCHEMA_VERSION) ||
        storage.STORAGE_SCHEMA_VERSION < 1
      ) {
        throw new TypeError("A valid stream-report storage module is required.");
      }

      return {
        now,
        protocol,
        reconciliation,
        reportStore,
        streamReport,
        storage,
      };
    }

    function createStreamReportCoordinator(options) {
      const {
        now,
        protocol,
        reconciliation,
        reportStore,
        streamReport,
        storage,
      } = validateDependencies(options);
      let loaded = false;
      let records = [];
      let operationTail = Promise.resolve();

      async function ensureLoaded() {
        if (loaded) {
          return;
        }

        records = await reportStore.loadRecords();
        loaded = true;
      }

      function createTimestamp() {
        let timestamp;

        try {
          timestamp = now();
        } catch (error) {
          fail(
            "REPORT_TIME_GENERATION_FAILED",
            "Could not record the stream report time.",
            error,
          );
        }

        return requireCanonicalTimestamp(timestamp, "generated timestamp");
      }

      function sortNewestFirst(left, right) {
        return (
          right.report.metadata.endedAt.localeCompare(
            left.report.metadata.endedAt,
          ) || left.reportId.localeCompare(right.reportId)
        );
      }

      function boundArchive(candidateRecords) {
        const sorted = [...candidateRecords].sort(sortNewestFirst);
        const pending = sorted.filter(
          (record) =>
            record.lifecycleStatus ===
            storage.LIFECYCLE_STATUSES.PENDING_END,
        );
        const finalized = sorted.filter(
          (record) =>
            record.lifecycleStatus ===
            storage.LIFECYCLE_STATUSES.FINALIZED,
        );

        if (pending.length > storage.MAX_REPORTS) {
          fail(
            "REPORT_ARCHIVE_FULL",
            "Too many stream reports are waiting for End recovery.",
          );
        }

        const retainedFinalized = finalized
          .sort(sortNewestFirst)
          .slice(0, storage.MAX_REPORTS - pending.length);
        const bounded = [...pending, ...retainedFinalized]
          .sort(sortNewestFirst);

        function archiveByteLength(recordsToMeasure) {
          const serialized = JSON.stringify({
            schemaVersion: storage.STORAGE_SCHEMA_VERSION,
            records: recordsToMeasure,
          });

          return new TextEncoder().encode(serialized).byteLength;
        }

        while (
          archiveByteLength(bounded) > storage.MAX_ARCHIVE_BYTES &&
          bounded.some(
            (record) =>
              record.lifecycleStatus ===
                storage.LIFECYCLE_STATUSES.FINALIZED,
          )
        ) {
          const oldestFinalizedIndex = bounded.findLastIndex(
            (record) =>
              record.lifecycleStatus ===
                storage.LIFECYCLE_STATUSES.FINALIZED,
          );
          bounded.splice(oldestFinalizedIndex, 1);
        }

        if (archiveByteLength(bounded) > storage.MAX_ARCHIVE_BYTES) {
          fail(
            "REPORT_ARCHIVE_FULL",
            "The pending stream report exceeds the safe local archive size.",
          );
        }

        return bounded;
      }

      async function persist(candidateRecords) {
        const bounded = boundArchive(candidateRecords);
        records = await reportStore.saveRecords(bounded);
        return records;
      }

      function findByStreamId(streamId) {
        return records.find(
          (record) => record.report.metadata.streamId === streamId,
        ) ?? null;
      }

      function findByReportId(reportId) {
        return records.find((record) => record.reportId === reportId) ?? null;
      }

      function createSummary(record) {
        return {
          reportId: record.reportId,
          startedAt: record.report.metadata.startedAt,
          endedAt: record.report.metadata.endedAt,
          completeness: record.report.completeness.status,
          completedPaymentCount: record.report.totals.completedPaymentCount,
          totalSalesCount: record.report.totals.totalSalesCount,
          completedGmvCents: record.report.totals.completedGmvCents,
          attributedGmvDisplay: record.report.totals.attributedGmvDisplay,
        };
      }

      async function prepareReport(input) {
        if (
          !isPlainRecord(input) ||
          Object.keys(input).sort().join(",") !==
            "reconciliationState,startedAt,streamId"
        ) {
          fail(
            "INVALID_ARGUMENT",
            "Report preparation requires reconciliationState, startedAt, and streamId.",
          );
        }

        await ensureLoaded();
        const streamId = requireNonEmptyString(input.streamId, "streamId");
        const startedAt = requireCanonicalTimestamp(input.startedAt, "startedAt");
        const generatedAt = createTimestamp();
        const existing = findByStreamId(streamId);
        let report;

        try {
          report = streamReport.createStreamReport({
            reconciliation,
            reconciliationState: input.reconciliationState,
            streamId,
            startedAt,
            endedAt: generatedAt,
            generatedAt,
          });
          report = streamReport.hydrateStreamReport(report);
        } catch (error) {
          fail(
            "REPORT_GENERATION_FAILED",
            "Could not create the end-of-stream report from saved tracker data.",
            error,
          );
        }

        const reportId = report.reportId;

        if (
          typeof reportId !== "string" ||
          !protocol.REPORT_ID_PATTERN.test(reportId) ||
          (existing !== null && existing.reportId !== reportId)
        ) {
          fail(
            "REPORT_GENERATION_FAILED",
            "The generated stream report identifier is invalid.",
          );
        }

        const record = {
          reportId,
          lifecycleStatus: storage.LIFECYCLE_STATUSES.PENDING_END,
          report: cloneSerializable(report),
        };
        const nextRecords = existing
          ? records.map((candidate) =>
              candidate.reportId === reportId ? record : candidate,
            )
          : [...records, record];

        await persist(nextRecords);
        return cloneSerializable(record);
      }

      async function finalizeReport(reportId) {
        await ensureLoaded();
        protocol.validateCommand({
          type: protocol.COMMAND_TYPES.GET_REPORT,
          reportId,
        });
        const existing = findByReportId(reportId);

        if (!existing) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        if (
          existing.lifecycleStatus === storage.LIFECYCLE_STATUSES.FINALIZED
        ) {
          return cloneSerializable(existing);
        }

        const finalized = {
          ...existing,
          lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
        };
        await persist(
          records.map((record) =>
            record.reportId === reportId ? finalized : record,
          ),
        );
        return cloneSerializable(findByReportId(reportId));
      }

      async function repairPendingReports(activeStreamId) {
        await ensureLoaded();
        const normalizedActiveStreamId = activeStreamId === null
          ? null
          : requireNonEmptyString(activeStreamId, "activeStreamId");
        let repairedCount = 0;
        const repaired = records.map((record) => {
          if (
            record.lifecycleStatus !==
              storage.LIFECYCLE_STATUSES.PENDING_END ||
            record.report.metadata.streamId === normalizedActiveStreamId
          ) {
            return record;
          }

          repairedCount += 1;
          return {
            ...record,
            lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
          };
        });

        if (repairedCount > 0) {
          await persist(repaired);
        }

        return { repairedCount };
      }

      async function discardPendingReportForStream(streamId) {
        await ensureLoaded();
        const normalizedStreamId = requireNonEmptyString(streamId, "streamId");
        const existing = findByStreamId(normalizedStreamId);

        if (
          !existing ||
          existing.lifecycleStatus !==
            storage.LIFECYCLE_STATUSES.PENDING_END
        ) {
          return { discarded: false, reportId: null };
        }

        await persist(
          records.filter((record) => record.reportId !== existing.reportId),
        );
        return { discarded: true, reportId: existing.reportId };
      }

      async function listReports() {
        await ensureLoaded();
        return {
          reports: [...records].sort(sortNewestFirst).map(createSummary),
        };
      }

      async function getReport(reportId) {
        await ensureLoaded();
        protocol.validateCommand({
          type: protocol.COMMAND_TYPES.GET_REPORT,
          reportId,
        });
        const record = findByReportId(reportId);

        if (!record) {
          return { reportId: null, lifecycleStatus: null, report: null };
        }

        return cloneSerializable(record);
      }

      async function getReportForStream(streamId) {
        await ensureLoaded();
        const normalizedStreamId = requireNonEmptyString(streamId, "streamId");
        const record = findByStreamId(normalizedStreamId);

        if (!record) {
          return { reportId: null, lifecycleStatus: null, report: null };
        }

        return cloneSerializable(record);
      }

      async function execute(command) {
        const validated = protocol.validateCommand(command);

        switch (validated.type) {
          case protocol.COMMAND_TYPES.LIST_REPORTS:
            return listReports();
          case protocol.COMMAND_TYPES.GET_REPORT:
            return getReport(validated.reportId);
          default:
            fail(
              "UNKNOWN_COMMAND",
              `Stream-report command ${validated.type} is not supported.`,
            );
        }
      }

      function enqueue(operation) {
        const execution = operationTail.then(operation);
        operationTail = execution.catch(() => undefined);
        return execution;
      }

      return Object.freeze({
        dispatch(command) {
          let snapshot;

          try {
            snapshot = cloneSerializable(command);
            protocol.validateCommand(snapshot);
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => execute(snapshot));
        },
        discardPendingReportForStream(streamId) {
          return enqueue(() => discardPendingReportForStream(streamId));
        },
        finalizeReport(reportId) {
          return enqueue(() => finalizeReport(reportId));
        },
        getReport(reportId) {
          return enqueue(() => getReport(reportId));
        },
        getReportForStream(streamId) {
          return enqueue(() => getReportForStream(streamId));
        },
        listReports() {
          return enqueue(listReports);
        },
        prepareReport(input) {
          let snapshot;

          try {
            snapshot = cloneSerializable(input);
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => prepareReport(snapshot));
        },
        repairPendingReports(activeStreamId) {
          return enqueue(() => repairPendingReports(activeStreamId));
        },
      });
    }

    return Object.freeze({
      StreamReportCoordinatorError,
      createStreamReportCoordinator,
    });
  },
);
