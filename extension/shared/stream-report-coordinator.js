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
        !(protocol.REPORT_ID_PATTERN instanceof RegExp) ||
        !Number.isSafeInteger(protocol.MAX_ACTIVE_REPORTS) ||
        !Number.isSafeInteger(protocol.MAX_ARCHIVED_REPORTS) ||
        !Number.isSafeInteger(protocol.MAX_TOTAL_REPORTS)
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
        typeof streamReport.correctReportMappings !== "function" ||
        typeof streamReport.correctReportUnitCost !== "function" ||
        typeof streamReport.hydrateStreamReport !== "function"
      ) {
        throw new TypeError(
          "streamReport must provide report creation, mapping correction, unit-cost correction, and hydration.",
        );
      }

      if (
        !storage ||
        !storage.LIFECYCLE_STATUSES ||
        typeof storage.measureRecordsByteLength !== "function" ||
        storage.MAX_ACTIVE_REPORTS !== protocol.MAX_ACTIVE_REPORTS ||
        storage.MAX_ARCHIVED_REPORTS !== protocol.MAX_ARCHIVED_REPORTS ||
        storage.MAX_TOTAL_REPORTS !== protocol.MAX_TOTAL_REPORTS ||
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
      let loadedReadOnly = false;
      let records = [];
      let libraryCapacity = null;
      let operationTail = Promise.resolve();

      async function ensureLoaded({ readOnly = false } = {}) {
        if (loaded || (readOnly && loadedReadOnly)) {
          return;
        }

        records = await reportStore.loadRecords({ readOnly });
        libraryCapacity = null;
        // A capacity-only load must not persist a legacy migration. An
        // ordinary later operation still performs the existing normal load.
        loaded = !readOnly;
        loadedReadOnly = readOnly;
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

      async function persist(candidateRecords) {
        records = await reportStore.saveRecords(candidateRecords);
        libraryCapacity = null;
        return records;
      }

      function isFinalized(record) {
        return record.lifecycleStatus ===
          storage.LIFECYCLE_STATUSES.FINALIZED;
      }

      function isActiveRecord(record) {
        return isFinalized(record) && record.archived === false;
      }

      function isArchivedRecord(record) {
        return isFinalized(record) && record.archived === true;
      }

      function getActiveRecords(candidateRecords = records) {
        return candidateRecords.filter(isActiveRecord);
      }

      function getArchivedRecords(candidateRecords = records) {
        return candidateRecords.filter(isArchivedRecord);
      }

      function sortOldestFirst(left, right) {
        return (
          left.report.metadata.endedAt.localeCompare(
            right.report.metadata.endedAt,
          ) || left.reportId.localeCompare(right.reportId)
        );
      }

      function createPublicRecord(record) {
        if (!record) {
          return {
            reportId: null,
            lifecycleStatus: null,
            displayName: null,
            report: null,
          };
        }

        return cloneSerializable({
          reportId: record.reportId,
          lifecycleStatus: record.lifecycleStatus,
          displayName: record.displayName ?? null,
          report: record.report,
        });
      }

      function requireTotalCapacity(additionalCount) {
        if (records.length + additionalCount > storage.MAX_TOTAL_REPORTS) {
          fail(
            "REPORT_TOTAL_LIMIT_REACHED",
            `Saved reports already contain the ${storage.MAX_TOTAL_REPORTS}-report local limit. Permanently delete an archived report before continuing.`,
          );
        }
      }

      function finalizePendingRecord(candidateRecords, reportId) {
        const existing = candidateRecords.find(
          (record) => record.reportId === reportId,
        );

        if (!existing) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        if (isFinalized(existing)) {
          return candidateRecords;
        }

        if (existing.archived !== false) {
          fail(
            "REPORT_NOT_FINALIZED",
            "A report awaiting End recovery cannot be archived.",
          );
        }

        let nextRecords = candidateRecords.map((record) =>
          record.reportId === reportId
            ? {
                ...record,
                lifecycleStatus: storage.LIFECYCLE_STATUSES.FINALIZED,
              }
            : record,
        );
        const activeRecords = getActiveRecords(nextRecords);

        if (activeRecords.length > storage.MAX_ACTIVE_REPORTS) {
          if (
            getArchivedRecords(nextRecords).length >=
            storage.MAX_ARCHIVED_REPORTS
          ) {
            fail(
              "REPORT_ARCHIVED_LIMIT_REACHED",
              `Archived Reports already contains ${storage.MAX_ARCHIVED_REPORTS} reports. Permanently delete one before ending tracking.`,
            );
          }

          const oldest = [...activeRecords].sort(sortOldestFirst)[0];
          nextRecords = nextRecords.map((record) =>
            record.reportId === oldest.reportId
              ? { ...record, archived: true }
              : record,
          );
        }

        return nextRecords;
      }

      function findByStreamId(streamId) {
        return records.find(
          (record) => record.report.metadata.streamId === streamId,
        ) ?? null;
      }

      function findByReportId(reportId) {
        return records.find((record) => record.reportId === reportId) ?? null;
      }

      function getFinalizedRecords(candidateRecords = records) {
        return candidateRecords.filter(isFinalized);
      }

      function createSummary(record) {
        return {
          reportId: record.reportId,
          displayName: record.displayName ?? null,
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
          archived: false,
          report: cloneSerializable(report),
        };

        if (existing && isFinalized(existing)) {
          fail(
            "REPORT_ALREADY_FINALIZED",
            "A finalized stream report cannot be replaced.",
          );
        }

        if (!existing) {
          requireTotalCapacity(1);
        }

        const nextRecords = existing
          ? records.map((candidate) =>
              candidate.reportId === reportId ? record : candidate,
            )
          : [...records, record];

        await persist(nextRecords);
        return createPublicRecord(findByReportId(reportId));
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

        if (isFinalized(existing)) {
          return createPublicRecord(existing);
        }

        await persist(finalizePendingRecord(records, reportId));
        return createPublicRecord(findByReportId(reportId));
      }

      async function repairPendingReports(activeStreamId) {
        await ensureLoaded();
        const normalizedActiveStreamId = activeStreamId === null
          ? null
          : requireNonEmptyString(activeStreamId, "activeStreamId");
        const repairIds = records
          .filter(
            (record) =>
              record.lifecycleStatus ===
                storage.LIFECYCLE_STATUSES.PENDING_END &&
              record.report.metadata.streamId !== normalizedActiveStreamId,
          )
          .sort(sortOldestFirst)
          .map((record) => record.reportId);
        let repaired = records;

        repairIds.forEach((reportId) => {
          repaired = finalizePendingRecord(repaired, reportId);
        });

        if (repairIds.length > 0) {
          await persist(repaired);
        }

        return { repairedCount: repairIds.length };
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
          reports: getActiveRecords()
            .sort(sortNewestFirst)
            .map(createSummary),
        };
      }

      async function listArchivedReports() {
        await ensureLoaded();
        return {
          reports: getArchivedRecords()
            .sort(sortNewestFirst)
            .map(createSummary),
        };
      }

      async function getLibraryCapacity() {
        await ensureLoaded({ readOnly: true });

        if (libraryCapacity === null) {
          libraryCapacity = {
            usedBytes: storage.measureRecordsByteLength(records),
            maxBytes: storage.MAX_ARCHIVE_BYTES,
            totalReports: records.length,
            maxReports: storage.MAX_TOTAL_REPORTS,
          };
        }

        return { ...libraryCapacity };
      }

      async function getReport(reportId) {
        await ensureLoaded();
        protocol.validateCommand({
          type: protocol.COMMAND_TYPES.GET_REPORT,
          reportId,
        });
        const record = findByReportId(reportId);

        return createPublicRecord(record);
      }

      function createOfflineEditorEligibility(
        record,
        activeStreamExists,
      ) {
        if (!isFinalized(record)) {
          return {
            status: "blocked",
            code: "REPORT_NOT_FINALIZED",
            reason: "Only a finalized stream report can be edited.",
          };
        }

        if (activeStreamExists) {
          return {
            status: "blocked",
            code: "ACTIVE_STREAM_ALREADY_EXISTS",
            reason: "End the active tracker stream before editing a report.",
          };
        }

        if (record.report.metadata.activeBiddingVariationNumber !== null) {
          return {
            status: "blocked",
            code: "ACTIVE_BIDDING_AT_END",
            reason: "The report ended with an active bidding variation.",
          };
        }

        if (record.report.totals.paymentFixingCount > 0) {
          return {
            status: "blocked",
            code: "PAYMENT_FIXING_ORDERS_REMAIN",
            reason:
              "Resolve all processing and payment-error orders before editing this report.",
          };
        }

        if (record.report.totals.pendingMappedCount > 0) {
          return {
            status: "blocked",
            code: "PENDING_MAPPED_ORDERS_REMAIN",
            reason:
              "Resolve all pending mapped orders before editing this report.",
          };
        }

        if (record.report.totals.unresolvedOrderCount > 0) {
          return {
            status: "blocked",
            code: "UNRESOLVED_ORDERS_REMAIN",
            reason: "Resolve all unfinished orders before editing this report.",
          };
        }

        const editableVariationCount =
          record.report.completedSales.length +
          (record.report.canceledOrders?.length ?? 0);

        if (editableVariationCount === 0) {
          return {
            status: "read_only",
            code: "NO_EDITABLE_VARIATIONS",
            reason:
              "This report has no saved completed or canceled variations to edit.",
          };
        }

        return { status: "editable", code: null, reason: null };
      }

      function createOfflineEditorData(record, activeStreamExists) {
        const report = record.report;
        const mapExpectedState = (entry, expectedStatus) => ({
          variationNumber: entry.variationNumber,
          expectedStatus,
          expectedSku: entry.sku,
        });

        return cloneSerializable({
          reportId: record.reportId,
          displayName: record.displayName ?? null,
          endedAt: report.metadata.endedAt,
          eligibility: createOfflineEditorEligibility(
            record,
            activeStreamExists,
          ),
          canceledDetailsAvailable: report.canceledOrders !== null,
          completedVariations: report.completedSales.map((sale) => ({
            ...mapExpectedState(sale, "payment_complete"),
            soldPriceCents: sale.soldPriceCents,
          })),
          canceledVariations: (report.canceledOrders ?? []).map((order) =>
            mapExpectedState(order, "canceled")),
          inventory: report.inventory.map((item) => ({
            sku: item.sku,
            item: item.item,
            style: item.style,
            size: item.size,
            unitCostCents: item.unitCostCents,
            openingQuantity: item.openingQuantity,
            streamSoldQuantity: item.streamSoldQuantity,
            baselineSoldQuantity: item.baselineSoldQuantity,
            pendingQuantity: item.pendingQuantity,
            calculatedRemainingQuantity:
              item.calculatedRemainingQuantity,
            replacementQuantity: item.replacementQuantity,
            availableAfterReservationsQuantity:
              item.availableAfterReservationsQuantity,
            oversoldQuantity: item.oversoldQuantity,
            requiresRecount: item.requiresRecount,
          })),
        });
      }

      async function loadOfflineEditorData(input) {
        if (
          !isPlainRecord(input) ||
          Object.keys(input).sort().join(",") !==
            "activeStreamExists,reportId" ||
          typeof input.activeStreamExists !== "boolean"
        ) {
          fail(
            "INVALID_ARGUMENT",
            "Offline editor loading requires reportId and activeStreamExists.",
          );
        }

        await ensureLoaded();
        protocol.validateCommand({
          type: protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
          reportId: input.reportId,
        });
        const record = findByReportId(input.reportId);

        if (!record) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        return createOfflineEditorData(
          record,
          input.activeStreamExists,
        );
      }

      async function getReportForStream(streamId) {
        await ensureLoaded();
        const normalizedStreamId = requireNonEmptyString(streamId, "streamId");
        const record = findByStreamId(normalizedStreamId);

        return createPublicRecord(record);
      }

      async function getLatestFinalizedReport() {
        await ensureLoaded();
        const record = [...getFinalizedRecords()].sort(sortNewestFirst)[0] ?? null;

        return createPublicRecord(record);
      }

      async function replaceFinalizedReport(input) {
        if (
          !isPlainRecord(input) ||
          Object.keys(input).sort().join(",") !==
            "reconciliationState,reportId"
        ) {
          fail(
            "INVALID_ARGUMENT",
            "Finalized report replacement requires reconciliationState and reportId.",
          );
        }

        await ensureLoaded();
        protocol.validateCommand({
          type: protocol.COMMAND_TYPES.GET_REPORT,
          reportId: input.reportId,
        });
        const existing = findByReportId(input.reportId);

        if (!existing) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        if (!isFinalized(existing)) {
          fail(
            "REPORT_NOT_FINALIZED",
            "Only a finalized stream report can be corrected.",
          );
        }

        const previous = existing.report;
        let replacement;

        try {
          replacement = streamReport.createStreamReport({
            reconciliation,
            reconciliationState: input.reconciliationState,
            streamId: previous.metadata.streamId,
            startedAt: previous.metadata.startedAt,
            endedAt: previous.metadata.endedAt,
            generatedAt: createTimestamp(),
          });
          replacement = streamReport.hydrateStreamReport(replacement);

          // Payment resolution rebuilds quantities/statuses from canonical data,
          // but saved report-only costs remain authoritative for this report.
          // Read them here, inside the serialized operation, not at request time.
          const savedUnitCosts = new Map(
            previous.inventory.map((item) => [item.sku, item.unitCostCents]),
          );

          if (
            replacement.inventory.length !== savedUnitCosts.size ||
            replacement.inventory.some((item) => !savedUnitCosts.has(item.sku))
          ) {
            throw new Error("The rebuilt report inventory does not match the saved SKUs.");
          }

          const changedCosts = replacement.inventory.filter(
            (item) => item.unitCostCents !== savedUnitCosts.get(item.sku),
          );
          // Lower costs first so intermediate totals cannot overflow when the
          // final set of saved costs would still produce valid report totals.
          changedCosts.sort((left, right) =>
            Number(savedUnitCosts.get(left.sku) > left.unitCostCents) -
            Number(savedUnitCosts.get(right.sku) > right.unitCostCents),
          );

          for (const item of changedCosts) {
            replacement = streamReport.correctReportUnitCost(replacement, {
              sku: item.sku,
              unitCostCents: savedUnitCosts.get(item.sku),
            });
          }

          replacement = streamReport.hydrateStreamReport(replacement);

          if (
            replacement.inventory.length !== savedUnitCosts.size ||
            replacement.inventory.some(
              (item) => !savedUnitCosts.has(item.sku) ||
                item.unitCostCents !== savedUnitCosts.get(item.sku),
            )
          ) {
            throw new Error("The rebuilt report could not preserve its saved unit costs.");
          }
        } catch (error) {
          fail(
            "REPORT_GENERATION_FAILED",
            "Could not regenerate the stream report from corrected tracker data.",
            error,
          );
        }

        if (
          replacement.reportId !== existing.reportId ||
          replacement.metadata.streamId !== previous.metadata.streamId ||
          replacement.metadata.startedAt !== previous.metadata.startedAt ||
          replacement.metadata.endedAt !== previous.metadata.endedAt ||
          replacement.metadata.inventoryBaselineId !==
            previous.metadata.inventoryBaselineId
        ) {
          fail(
            "REPORT_GENERATION_FAILED",
            "The corrected report does not preserve the saved stream identity.",
          );
        }

        await persist(
          records.map((record) =>
            record.reportId === existing.reportId
              ? { ...record, report: cloneSerializable(replacement) }
              : record,
          ),
        );

        return createPublicRecord(findByReportId(existing.reportId));
      }

      async function correctFinalizedReportUnitCost(input) {
        if (
          !isPlainRecord(input) ||
          Object.keys(input).sort().join(",") !==
            "reportId,sku,unitCostCents"
        ) {
          fail(
            "INVALID_ARGUMENT",
            "Report unit-cost correction requires reportId, sku, and unitCostCents.",
          );
        }

        await ensureLoaded();
        protocol.validateCommand({
          type: protocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
          ...input,
        });
        const existing = findByReportId(input.reportId);

        if (!existing) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        if (!isFinalized(existing)) {
          fail(
            "REPORT_NOT_FINALIZED",
            "Only a finalized stream report can be corrected.",
          );
        }

        let correctedReport;

        try {
          correctedReport = streamReport.correctReportUnitCost(
            existing.report,
            {
              sku: input.sku,
              unitCostCents: input.unitCostCents,
            },
          );
        } catch (error) {
          fail(
            typeof error?.code === "string"
              ? error.code
              : "REPORT_CORRECTION_FAILED",
            typeof error?.message === "string"
              ? error.message
              : "Could not correct the saved stream report.",
            error,
          );
        }

        if (
          JSON.stringify(correctedReport) === JSON.stringify(existing.report)
        ) {
          return createPublicRecord(existing);
        }

        await persist(
          records.map((record) =>
            record.reportId === existing.reportId
              ? { ...record, report: cloneSerializable(correctedReport) }
              : record,
          ),
        );

        return createPublicRecord(findByReportId(existing.reportId));
      }

      async function correctFinalizedReportMappings(input) {
        if (
          !isPlainRecord(input) ||
          Object.keys(input).sort().join(",") !== "changes,reportId"
        ) {
          fail(
            "INVALID_ARGUMENT",
            "Report mapping correction requires changes and reportId.",
          );
        }

        await ensureLoaded();
        const command = protocol.validateCommand({
          type: protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
          ...input,
        });
        const existing = findByReportId(command.reportId);

        if (!existing) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        const eligibility = createOfflineEditorEligibility(existing, false);

        if (eligibility.status !== "editable") {
          fail(eligibility.code, eligibility.reason);
        }

        let correctedReport;

        try {
          correctedReport = streamReport.correctReportMappings(
            existing.report,
            command.changes,
          );
        } catch (error) {
          fail(
            typeof error?.code === "string"
              ? error.code
              : "REPORT_CORRECTION_FAILED",
            typeof error?.message === "string"
              ? error.message
              : "Could not correct the saved stream report.",
            error,
          );
        }

        if (
          JSON.stringify(correctedReport) === JSON.stringify(existing.report)
        ) {
          return createOfflineEditorData(existing, false);
        }

        await persist(
          records.map((record) =>
            record.reportId === existing.reportId
              ? { ...record, report: cloneSerializable(correctedReport) }
              : record,
          ),
        );

        return createOfflineEditorData(
          findByReportId(existing.reportId),
          false,
        );
      }

      function requireReportsById(reportIds) {
        const selected = reportIds.map((reportId) => findByReportId(reportId));

        if (selected.some((record) => record === null)) {
          fail("REPORT_NOT_FOUND", "At least one stream report does not exist.");
        }

        return selected;
      }

      async function archiveReports(reportIds) {
        await ensureLoaded();
        const selected = requireReportsById(reportIds);

        if (selected.some((record) => !isFinalized(record))) {
          fail(
            "REPORT_NOT_FINALIZED",
            "A report awaiting End recovery cannot be archived.",
          );
        }

        if (selected.some((record) => record.archived)) {
          fail(
            "REPORT_NOT_ACTIVE",
            "Only active Business Records can be archived.",
          );
        }

        if (
          getArchivedRecords().length + reportIds.length >
          storage.MAX_ARCHIVED_REPORTS
        ) {
          fail(
            "REPORT_ARCHIVED_LIMIT_REACHED",
            `Archived Reports already contains the ${storage.MAX_ARCHIVED_REPORTS}-report limit. Permanently delete one before archiving another.`,
          );
        }

        const selectedIds = new Set(reportIds);
        await persist(
          records.map((record) =>
            selectedIds.has(record.reportId)
              ? { ...record, archived: true }
              : record,
          ),
        );
        return { reportIds: [...reportIds] };
      }

      async function restoreReports(reportIds) {
        await ensureLoaded();
        const selected = requireReportsById(reportIds);

        if (selected.some((record) => !isFinalized(record))) {
          fail(
            "REPORT_NOT_FINALIZED",
            "A report awaiting End recovery cannot be restored.",
          );
        }

        if (selected.some((record) => !record.archived)) {
          fail(
            "REPORT_NOT_ARCHIVED",
            "Only archived reports can be restored.",
          );
        }

        const availableSlots =
          storage.MAX_ACTIVE_REPORTS - getActiveRecords().length;

        if (availableSlots === 0 || reportIds.length > availableSlots) {
          fail(
            "REPORT_ACTIVE_LIMIT_REACHED",
            `Business Records can contain at most ${storage.MAX_ACTIVE_REPORTS} reports. Archive another report before restoring this selection.`,
          );
        }

        const selectedIds = new Set(reportIds);
        await persist(
          records.map((record) =>
            selectedIds.has(record.reportId)
              ? { ...record, archived: false }
              : record,
          ),
        );
        return { reportIds: [...reportIds] };
      }

      async function deleteReports(reportIds) {
        await ensureLoaded();
        const selected = requireReportsById(reportIds);

        if (selected.some((record) => !isFinalized(record))) {
          fail(
            "REPORT_NOT_FINALIZED",
            "A report awaiting End recovery cannot be permanently deleted.",
          );
        }

        const selectedIds = new Set(reportIds);
        await persist(
          records.filter((record) => !selectedIds.has(record.reportId)),
        );
        return { reportIds: [...reportIds] };
      }

      async function deleteArchivedReports(reportIds) {
        await ensureLoaded();
        const selected = requireReportsById(reportIds);

        if (selected.some((record) => !isArchivedRecord(record))) {
          fail(
            "REPORT_NOT_ARCHIVED",
            "Only archived reports can be permanently deleted.",
          );
        }

        const selectedIds = new Set(reportIds);
        await persist(
          records.filter((record) => !selectedIds.has(record.reportId)),
        );
        return { reportIds: [...reportIds] };
      }

      async function renameReport(input) {
        await ensureLoaded();
        const command = protocol.validateCommand({
          type: protocol.COMMAND_TYPES.RENAME_REPORT,
          ...input,
        });
        const existing = findByReportId(command.reportId);

        if (!existing) {
          fail("REPORT_NOT_FOUND", "The stream report does not exist.");
        }

        if (!isFinalized(existing)) {
          fail(
            "REPORT_NOT_FINALIZED",
            "A report awaiting End recovery cannot be renamed.",
          );
        }

        if (existing.archived) {
          fail(
            "REPORT_NOT_ACTIVE",
            "Only active Business Records can be renamed.",
          );
        }

        const currentDisplayName = existing.displayName ?? null;

        if (currentDisplayName === command.displayName) {
          return {
            reportId: existing.reportId,
            displayName: currentDisplayName,
          };
        }

        const replacement = { ...existing };

        if (command.displayName === null) {
          delete replacement.displayName;
        } else {
          replacement.displayName = command.displayName;
        }

        await persist(
          records.map((record) =>
            record.reportId === existing.reportId ? replacement : record,
          ),
        );
        return {
          reportId: existing.reportId,
          displayName: command.displayName,
        };
      }

      function snapshotReportIdCommand(type, reportIds) {
        const command = cloneSerializable({ type, reportIds });
        return protocol.validateCommand(command);
      }

      async function execute(command) {
        const validated = protocol.validateCommand(command);

        switch (validated.type) {
          case protocol.COMMAND_TYPES.LIST_REPORTS:
            return listReports();
          case protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS:
            return listArchivedReports();
          case protocol.COMMAND_TYPES.GET_LIBRARY_CAPACITY:
            return getLibraryCapacity();
          case protocol.COMMAND_TYPES.GET_REPORT:
            return getReport(validated.reportId);
          case protocol.COMMAND_TYPES.RENAME_REPORT:
            return renameReport({
              reportId: validated.reportId,
              displayName: validated.displayName,
            });
          case protocol.COMMAND_TYPES.ARCHIVE_REPORTS:
            return archiveReports(validated.reportIds);
          case protocol.COMMAND_TYPES.RESTORE_REPORTS:
            return restoreReports(validated.reportIds);
          case protocol.COMMAND_TYPES.DELETE_REPORTS:
            return deleteReports(validated.reportIds);
          case protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS:
            return deleteArchivedReports(validated.reportIds);
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
        archiveReports(reportIds) {
          let command;

          try {
            command = snapshotReportIdCommand(
              protocol.COMMAND_TYPES.ARCHIVE_REPORTS,
              reportIds,
            );
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => archiveReports(command.reportIds));
        },
        deleteReports(reportIds) {
          let command;

          try {
            command = snapshotReportIdCommand(
              protocol.COMMAND_TYPES.DELETE_REPORTS,
              reportIds,
            );
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => deleteReports(command.reportIds));
        },
        deleteArchivedReports(reportIds) {
          let command;

          try {
            command = snapshotReportIdCommand(
              protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
              reportIds,
            );
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => deleteArchivedReports(command.reportIds));
        },
        correctFinalizedReportUnitCost(input) {
          let snapshot;

          try {
            snapshot = cloneSerializable(input);
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => correctFinalizedReportUnitCost(snapshot));
        },
        correctFinalizedReportMappings(input) {
          let snapshot;

          try {
            snapshot = cloneSerializable(input);
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => correctFinalizedReportMappings(snapshot));
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
        getLibraryCapacity() {
          return enqueue(getLibraryCapacity);
        },
        getReportForStream(streamId) {
          return enqueue(() => getReportForStream(streamId));
        },
        getLatestFinalizedReport() {
          return enqueue(getLatestFinalizedReport);
        },
        loadOfflineEditorData(input) {
          let snapshot;

          try {
            snapshot = cloneSerializable(input);
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => loadOfflineEditorData(snapshot));
        },
        listReports() {
          return enqueue(listReports);
        },
        listArchivedReports() {
          return enqueue(listArchivedReports);
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
        renameReport(input) {
          let command;

          try {
            command = protocol.validateCommand({
              type: protocol.COMMAND_TYPES.RENAME_REPORT,
              ...cloneSerializable(input),
            });
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => renameReport({
            reportId: command.reportId,
            displayName: command.displayName,
          }));
        },
        replaceFinalizedReport(input) {
          let snapshot;

          try {
            snapshot = cloneSerializable(input);
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => replaceFinalizedReport(snapshot));
        },
        restoreReports(reportIds) {
          let command;

          try {
            command = snapshotReportIdCommand(
              protocol.COMMAND_TYPES.RESTORE_REPORTS,
              reportIds,
            );
          } catch (error) {
            return Promise.reject(error);
          }

          return enqueue(() => restoreReports(command.reportIds));
        },
      });
    }

    return Object.freeze({
      StreamReportCoordinatorError,
      createStreamReportCoordinator,
    });
  },
);
