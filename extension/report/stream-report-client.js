(function initializeStreamReportClient(root, factory) {
  const streamReportClient = factory(
    root.TikTokLiveTrackerStreamReport,
    typeof root.setTimeout === "function" ? root.setTimeout.bind(root) : null,
    typeof root.clearTimeout === "function" ? root.clearTimeout.bind(root) : null,
  );

  if (typeof module === "object" && module.exports) {
    module.exports = streamReportClient;
  }

  root.TikTokLiveTrackerStreamReportClient = streamReportClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamReportClientModule(
    defaultStreamReport,
    defaultSetTimeout,
    defaultClearTimeout,
  ) {
    "use strict";

    const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
    const ATTRIBUTED_GMV_PATTERN =
      /^\$(?:(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}|(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB])$/;

    const REQUIRED_COMMAND_TYPES = Object.freeze([
      "LIST_REPORTS",
      "LIST_ARCHIVED_REPORTS",
      "GET_REPORT",
      "ARCHIVE_REPORTS",
      "RESTORE_REPORTS",
      "DELETE_ARCHIVED_REPORTS",
    ]);

    class StreamReportClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StreamReportClientError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new StreamReportClientError(code, message);
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

      return (
        actualKeys.length === sortedExpectedKeys.length &&
        actualKeys.every((key, index) => key === sortedExpectedKeys[index])
      );
    }

    function cloneSerializable(value, code, message) {
      try {
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          fail(code, message);
        }

        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof StreamReportClientError) {
          throw error;
        }

        fail(code, message);
      }
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Client options are required.");
      }

      const { runtime, protocol } = options;
      const streamReport = options.streamReport ?? defaultStreamReport;
      const setTimeoutImpl = options.setTimeoutImpl ?? defaultSetTimeout;
      const clearTimeoutImpl = options.clearTimeoutImpl ?? defaultClearTimeout;
      const requestTimeoutMs = options.requestTimeoutMs ??
        DEFAULT_REQUEST_TIMEOUT_MS;

      if (!runtime || typeof runtime.sendMessage !== "function") {
        throw new TypeError("runtime must provide sendMessage.");
      }

      if (
        !isPlainRecord(protocol) ||
        typeof protocol.MESSAGE_CHANNEL !== "string" ||
        protocol.MESSAGE_CHANNEL.trim() === "" ||
        !Number.isSafeInteger(protocol.MESSAGE_VERSION) ||
        protocol.MESSAGE_VERSION < 1 ||
        !isPlainRecord(protocol.COMMAND_TYPES) ||
        !(protocol.REPORT_ID_PATTERN instanceof RegExp) ||
        !Number.isSafeInteger(protocol.MAX_ACTIVE_REPORTS) ||
        protocol.MAX_ACTIVE_REPORTS < 1 ||
        !Number.isSafeInteger(protocol.MAX_ARCHIVED_REPORTS) ||
        protocol.MAX_ARCHIVED_REPORTS < 1 ||
        typeof protocol.createStreamReportMessage !== "function"
      ) {
        throw new TypeError("A valid stream-report message protocol is required.");
      }

      const commandValues = REQUIRED_COMMAND_TYPES.map(
        (commandName) => protocol.COMMAND_TYPES[commandName],
      );

      if (
        commandValues.some(
          (commandType) =>
            typeof commandType !== "string" || commandType.trim() === "",
        ) ||
        new Set(commandValues).size !== commandValues.length
      ) {
        throw new TypeError(
          "The stream-report protocol is missing required command types.",
        );
      }

      if (!streamReport || typeof streamReport.hydrateStreamReport !== "function") {
        throw new TypeError(
          "streamReport must provide hydrateStreamReport.",
        );
      }

      if (
        typeof setTimeoutImpl !== "function" ||
        typeof clearTimeoutImpl !== "function" ||
        !Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1
      ) {
        throw new TypeError(
          "The stream-report client requires valid timeout dependencies.",
        );
      }

      return {
        runtime,
        protocol,
        streamReport,
        setTimeoutImpl,
        clearTimeoutImpl,
        requestTimeoutMs,
      };
    }

    function parseResponse(response) {
      try {
        if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
          fail(
            "INVALID_RESPONSE",
            "The stream-report service returned an invalid response.",
          );
        }

        if (response.ok) {
          if (!hasExactKeys(response, ["data", "ok"]) || !isPlainRecord(response.data)) {
            fail(
              "INVALID_RESPONSE",
              "The stream-report service returned an invalid response.",
            );
          }

          return cloneSerializable(
            response.data,
            "INVALID_RESPONSE",
            "The stream-report service returned an invalid response.",
          );
        }

        if (
          !hasExactKeys(response, ["error", "ok"]) ||
          !hasExactKeys(response.error, ["code", "message"]) ||
          typeof response.error.code !== "string" ||
          response.error.code.trim() === "" ||
          typeof response.error.message !== "string" ||
          response.error.message.trim() === ""
        ) {
          fail(
            "INVALID_RESPONSE",
            "The stream-report service returned an invalid response.",
          );
        }

        throw new StreamReportClientError(
          response.error.code,
          response.error.message,
        );
      } catch (error) {
        if (error instanceof StreamReportClientError) {
          throw error;
        }

        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned an invalid response.",
        );
      }
    }

    function requireReportOptions(value) {
      if (!hasExactKeys(value, ["reportId"])) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "Report options must contain exactly reportId.",
        );
      }

      if (typeof value.reportId !== "string" || value.reportId.trim() === "") {
        fail(
          "INVALID_CLIENT_COMMAND",
          "reportId must be a non-empty string.",
        );
      }

      return { reportId: value.reportId.trim() };
    }

    function requireReportIdsOptions(value, protocol) {
      if (
        !hasExactKeys(value, ["reportIds"]) ||
        !Array.isArray(value.reportIds) ||
        value.reportIds.length < 1 ||
        value.reportIds.length > protocol.MAX_ARCHIVED_REPORTS
      ) {
        fail(
          "INVALID_CLIENT_COMMAND",
          `Report options must contain 1 to ${protocol.MAX_ARCHIVED_REPORTS} report IDs.`,
        );
      }

      const reportIds = value.reportIds.map((reportId) => {
        if (
          typeof reportId !== "string" ||
          !protocol.REPORT_ID_PATTERN.test(reportId)
        ) {
          fail("INVALID_CLIENT_COMMAND", "A report ID is invalid.");
        }

        return reportId;
      });

      if (new Set(reportIds).size !== reportIds.length) {
        fail("INVALID_CLIENT_COMMAND", "Report IDs must be unique.");
      }

      return { reportIds };
    }

    function requireCanonicalTimestamp(value, fieldName) {
      if (typeof value !== "string") {
        fail("INVALID_RESPONSE", `${fieldName} must be a UTC timestamp.`);
      }

      const parsed = new Date(value);

      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        fail("INVALID_RESPONSE", `${fieldName} must be a UTC timestamp.`);
      }

      return value;
    }

    function requireNonnegativeInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 0) {
        fail("INVALID_RESPONSE", `${fieldName} must be a nonnegative integer.`);
      }

      return value;
    }

    function parseListData(data, protocol, maxReports) {
      if (
        !hasExactKeys(data, ["reports"]) ||
        !Array.isArray(data.reports) ||
        data.reports.length > maxReports
      ) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned an invalid report list.",
        );
      }

      const reportIds = new Set();
      let priorEndedAt = null;
      const reports = data.reports.map((summary, index) => {
        const path = `reports[${index}]`;

        if (
          !hasExactKeys(summary, [
            "attributedGmvDisplay",
            "completedGmvCents",
            "completedPaymentCount",
            "completeness",
            "endedAt",
            "reportId",
            "startedAt",
            "totalSalesCount",
          ]) ||
          typeof summary.reportId !== "string" ||
          !protocol.REPORT_ID_PATTERN.test(summary.reportId) ||
          !["final", "provisional"].includes(summary.completeness) ||
          !(
            summary.attributedGmvDisplay === null ||
            (typeof summary.attributedGmvDisplay === "string" &&
              ATTRIBUTED_GMV_PATTERN.test(summary.attributedGmvDisplay))
          )
        ) {
          fail(
            "INVALID_RESPONSE",
            "The stream-report service returned an invalid report list.",
          );
        }

        const startedAt = requireCanonicalTimestamp(
          summary.startedAt,
          `${path}.startedAt`,
        );
        const endedAt = requireCanonicalTimestamp(
          summary.endedAt,
          `${path}.endedAt`,
        );
        const completedPaymentCount = requireNonnegativeInteger(
          summary.completedPaymentCount,
          `${path}.completedPaymentCount`,
        );
        const totalSalesCount = requireNonnegativeInteger(
          summary.totalSalesCount,
          `${path}.totalSalesCount`,
        );
        const completedGmvCents = requireNonnegativeInteger(
          summary.completedGmvCents,
          `${path}.completedGmvCents`,
        );

        if (
          Date.parse(endedAt) < Date.parse(startedAt) ||
          completedPaymentCount > totalSalesCount ||
          reportIds.has(summary.reportId) ||
          (priorEndedAt !== null && Date.parse(endedAt) > Date.parse(priorEndedAt))
        ) {
          fail(
            "INVALID_RESPONSE",
            "The stream-report service returned an inconsistent report list.",
          );
        }

        reportIds.add(summary.reportId);
        priorEndedAt = endedAt;
        return {
          reportId: summary.reportId,
          startedAt,
          endedAt,
          completeness: summary.completeness,
          completedPaymentCount,
          totalSalesCount,
          completedGmvCents,
          attributedGmvDisplay: summary.attributedGmvDisplay,
        };
      });

      return { reports };
    }

    function parseMutationData(data, requestedReportIds) {
      if (
        !hasExactKeys(data, ["reportIds"]) ||
        !Array.isArray(data.reportIds) ||
        data.reportIds.length !== requestedReportIds.length ||
        data.reportIds.some(
          (reportId, index) => reportId !== requestedReportIds[index],
        )
      ) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned an invalid mutation result.",
        );
      }

      return { reportIds: [...data.reportIds] };
    }

    function parseGetData(data, protocol, streamReport, requestedReportId) {
      if (!hasExactKeys(data, ["lifecycleStatus", "report", "reportId"])) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned an invalid saved report.",
        );
      }

      if (
        data.reportId === null ||
        data.lifecycleStatus === null ||
        data.report === null
      ) {
        if (
          data.reportId !== null ||
          data.lifecycleStatus !== null ||
          data.report !== null
        ) {
          fail(
            "INVALID_RESPONSE",
            "The stream-report service returned an incomplete saved report.",
          );
        }

        return { reportId: null, lifecycleStatus: null, report: null };
      }

      if (
        typeof data.reportId !== "string" ||
        !protocol.REPORT_ID_PATTERN.test(data.reportId) ||
        data.reportId !== requestedReportId ||
        !["finalized", "pending_end"].includes(data.lifecycleStatus)
      ) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned an invalid saved report.",
        );
      }

      let report;

      try {
        report = streamReport.hydrateStreamReport(data.report);
      } catch (_error) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned invalid report data.",
        );
      }

      if (report.reportId !== data.reportId) {
        fail(
          "INVALID_RESPONSE",
          "The saved report ID does not match its report data.",
        );
      }

      return cloneSerializable(
        {
          reportId: data.reportId,
          lifecycleStatus: data.lifecycleStatus,
          report,
        },
        "INVALID_RESPONSE",
        "The stream-report service returned invalid report data.",
      );
    }

    function createStreamReportClient(options) {
      const {
        runtime,
        protocol,
        streamReport,
        setTimeoutImpl,
        clearTimeoutImpl,
        requestTimeoutMs,
      } = validateDependencies(options);
      let commandTail = Promise.resolve();

      async function sendCommand(command, parseData) {
        let response;
        let timeoutId = null;
        const timeoutMarker = Object.freeze({ timedOut: true });

        try {
          const delivery = Promise.resolve().then(() =>
            runtime.sendMessage(protocol.createStreamReportMessage(command)),
          );
          const timeout = new Promise((resolve) => {
            timeoutId = setTimeoutImpl(
              () => resolve(timeoutMarker),
              requestTimeoutMs,
            );
          });
          response = await Promise.race([delivery, timeout]);

          if (response === timeoutMarker) {
            fail(
              "REPORT_REQUEST_TIMEOUT",
              "The saved report did not respond. Reload the extension and try again.",
            );
          }
        } catch (error) {
          if (error instanceof StreamReportClientError) {
            throw error;
          }

          fail(
            "RUNTIME_MESSAGE_FAILED",
            "Could not reach the stream-report service.",
          );
        } finally {
          if (timeoutId !== null) {
            clearTimeoutImpl(timeoutId);
          }
        }

        return parseData(parseResponse(response));
      }

      function enqueueCommand(createCommand, parseData) {
        let command;

        try {
          command = cloneSerializable(
            createCommand(),
            "INVALID_CLIENT_COMMAND",
            "The stream-report command must be JSON serializable.",
          );
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() => sendCommand(command, parseData));

        commandTail = execution.catch(() => undefined);
        return execution;
      }

      function listReports() {
        return enqueueCommand(
          () => ({
            type: protocol.COMMAND_TYPES.LIST_REPORTS,
          }),
          (data) =>
            parseListData(data, protocol, protocol.MAX_ACTIVE_REPORTS),
        );
      }

      function listArchivedReports() {
        return enqueueCommand(
          () => ({
            type: protocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
          }),
          (data) =>
            parseListData(data, protocol, protocol.MAX_ARCHIVED_REPORTS),
        );
      }

      function getReport(optionsValue) {
        let requestedReportId;

        return enqueueCommand(
          () => {
            const { reportId } = requireReportOptions(optionsValue);
            requestedReportId = reportId;

            return {
              type: protocol.COMMAND_TYPES.GET_REPORT,
              reportId,
            };
          },
          (data) =>
            parseGetData(data, protocol, streamReport, requestedReportId),
        );
      }

      function createMutationMethod(commandType) {
        return function mutateReports(optionsValue) {
          let requestedReportIds;

          return enqueueCommand(
            () => {
              const { reportIds } = requireReportIdsOptions(
                optionsValue,
                protocol,
              );
              requestedReportIds = reportIds;

              return {
                type: commandType,
                reportIds,
              };
            },
            (data) => parseMutationData(data, requestedReportIds),
          );
        };
      }

      const archiveReports = createMutationMethod(
        protocol.COMMAND_TYPES.ARCHIVE_REPORTS,
      );
      const restoreReports = createMutationMethod(
        protocol.COMMAND_TYPES.RESTORE_REPORTS,
      );
      const deleteArchivedReports = createMutationMethod(
        protocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
      );

      return Object.freeze({
        archiveReports,
        deleteArchivedReports,
        getReport,
        listArchivedReports,
        listReports,
        restoreReports,
      });
    }

    return Object.freeze({
      StreamReportClientError,
      DEFAULT_REQUEST_TIMEOUT_MS,
      createStreamReportClient,
    });
  },
);
