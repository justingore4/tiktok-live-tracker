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
      "LIST_PAYMENT_FIXING_ORDERS",
      "RESOLVE_PAYMENT_FIXING_ORDER",
      "LIST_REPORT_UNIT_COSTS",
      "UPDATE_REPORT_UNIT_COST",
      "RENAME_REPORT",
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
        !Number.isSafeInteger(protocol.MAX_REPORT_DISPLAY_NAME_LENGTH) ||
        protocol.MAX_REPORT_DISPLAY_NAME_LENGTH < 1 ||
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

    function requireRenameOptions(value, protocol) {
      if (
        !hasExactKeys(value, ["displayName", "reportId"]) ||
        typeof value.reportId !== "string" ||
        !protocol.REPORT_ID_PATTERN.test(value.reportId) ||
        (
          value.displayName !== null &&
          (
            typeof value.displayName !== "string" ||
            value.displayName.length < 1 ||
            value.displayName.length >
              protocol.MAX_REPORT_DISPLAY_NAME_LENGTH ||
            value.displayName !== value.displayName.trim() ||
            /[\u0000-\u001f\u007f]/.test(value.displayName)
          )
        )
      ) {
        fail(
          "INVALID_CLIENT_COMMAND",
          `Report rename options require a valid report ID and null or a trimmed name of at most ${protocol.MAX_REPORT_DISPLAY_NAME_LENGTH} characters.`,
        );
      }

      return {
        reportId: value.reportId,
        displayName: value.displayName,
      };
    }

    function requireResolutionOptions(value, protocol) {
      if (
        !hasExactKeys(value, [
          "reportId",
          "resolution",
          "soldPriceCents",
          "variationNumber",
        ]) ||
        typeof value.reportId !== "string" ||
        !protocol.REPORT_ID_PATTERN.test(value.reportId) ||
        !Number.isSafeInteger(value.variationNumber) ||
        value.variationNumber < 1 ||
        !["payment_complete", "canceled"].includes(value.resolution) ||
        (
          value.resolution === "payment_complete" &&
          (!Number.isSafeInteger(value.soldPriceCents) ||
            value.soldPriceCents < 1)
        ) ||
        (
          value.resolution === "canceled" &&
          value.soldPriceCents !== null
        )
      ) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "Payment resolution requires a valid report, variation, outcome, and final sold price.",
        );
      }

      return {
        reportId: value.reportId,
        variationNumber: value.variationNumber,
        resolution: value.resolution,
        soldPriceCents: value.soldPriceCents,
      };
    }

    function requireUnitCostOptions(value, protocol) {
      if (
        !hasExactKeys(value, ["reportId", "sku", "unitCostCents"]) ||
        typeof value.reportId !== "string" ||
        !protocol.REPORT_ID_PATTERN.test(value.reportId) ||
        typeof value.sku !== "string" ||
        value.sku.length < 1 ||
        value.sku.length > 64 ||
        value.sku !== value.sku.trim() ||
        /[\u0000-\u001f\u007f]/.test(value.sku) ||
        !Number.isSafeInteger(value.unitCostCents) ||
        value.unitCostCents < 0
      ) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "Unit-cost correction requires a valid report, exact inventory SKU, and nonnegative integer cents.",
        );
      }

      return {
        reportId: value.reportId,
        sku: value.sku,
        unitCostCents: value.unitCostCents,
      };
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
            "displayName",
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
          ) ||
          !(
            summary.displayName === null ||
            (
              typeof summary.displayName === "string" &&
              summary.displayName.length >= 1 &&
              summary.displayName.length <=
                protocol.MAX_REPORT_DISPLAY_NAME_LENGTH &&
              summary.displayName === summary.displayName.trim() &&
              !/[\u0000-\u001f\u007f]/.test(summary.displayName)
            )
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
          displayName: summary.displayName,
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

    function parseRenameData(data, protocol, requested) {
      if (
        !hasExactKeys(data, ["displayName", "reportId"]) ||
        data.reportId !== requested.reportId ||
        data.displayName !== requested.displayName ||
        !protocol.REPORT_ID_PATTERN.test(data.reportId)
      ) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned an invalid rename result.",
        );
      }

      return {
        reportId: data.reportId,
        displayName: data.displayName,
      };
    }

    function parsePaymentFixingOrdersData(data, protocol, requestedReportId) {
      if (
        !hasExactKeys(data, ["orders", "reportId"]) ||
        data.reportId !== requestedReportId ||
        !protocol.REPORT_ID_PATTERN.test(data.reportId) ||
        !Array.isArray(data.orders) ||
        data.orders.length > 10_000
      ) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned invalid unfinished payments.",
        );
      }

      let priorVariationNumber = 0;
      const orders = data.orders.map((order, index) => {
        const path = `orders[${index}]`;

        if (
          !hasExactKeys(order, [
            "item",
            "mapped",
            "observedPaymentStatus",
            "size",
            "sku",
            "style",
            "variationNumber",
          ]) ||
          !Number.isSafeInteger(order.variationNumber) ||
          order.variationNumber < 1 ||
          order.variationNumber <= priorVariationNumber ||
          ![
            "payment_processing",
            "order_processing",
            "payment_fixing",
            "payment_failed",
          ].includes(
            order.observedPaymentStatus,
          ) ||
          typeof order.mapped !== "boolean"
        ) {
          fail(
            "INVALID_RESPONSE",
            `The stream-report service returned an invalid ${path}.`,
          );
        }

        const identityIsValid = order.mapped
          ? typeof order.sku === "string" &&
            order.sku.trim() !== "" &&
            typeof order.item === "string" &&
            order.item.trim() !== "" &&
            typeof order.style === "string" &&
            typeof order.size === "string"
          : [order.sku, order.item, order.style, order.size].every(
              (value) => value === null,
            );

        if (!identityIsValid) {
          fail(
            "INVALID_RESPONSE",
            `The stream-report service returned an inconsistent ${path}.`,
          );
        }

        priorVariationNumber = order.variationNumber;
        return {
          variationNumber: order.variationNumber,
          observedPaymentStatus: order.observedPaymentStatus,
          mapped: order.mapped,
          sku: order.sku,
          item: order.item,
          style: order.style,
          size: order.size,
        };
      });

      return { reportId: data.reportId, orders };
    }

    function parseReportUnitCostsData(data, protocol, requestedReportId) {
      if (
        !hasExactKeys(data, ["reportId", "skus"]) ||
        data.reportId !== requestedReportId ||
        !protocol.REPORT_ID_PATTERN.test(data.reportId) ||
        !Array.isArray(data.skus) ||
        data.skus.length > 10_000
      ) {
        fail(
          "INVALID_RESPONSE",
          "The stream-report service returned invalid report unit costs.",
        );
      }

      const seenSkus = new Set();
      const skus = data.skus.map((entry, index) => {
        const path = `skus[${index}]`;

        if (
          !hasExactKeys(entry, [
            "completedSaleCount",
            "item",
            "size",
            "sku",
            "style",
            "unitCostCents",
          ]) ||
          typeof entry.sku !== "string" ||
          entry.sku.length < 1 ||
          entry.sku.length > 64 ||
          entry.sku !== entry.sku.trim() ||
          /[\u0000-\u001f\u007f]/.test(entry.sku) ||
          seenSkus.has(entry.sku) ||
          typeof entry.item !== "string" ||
          typeof entry.style !== "string" ||
          typeof entry.size !== "string" ||
          !Number.isSafeInteger(entry.unitCostCents) ||
          entry.unitCostCents < 0 ||
          !Number.isSafeInteger(entry.completedSaleCount) ||
          entry.completedSaleCount < 0
        ) {
          fail(
            "INVALID_RESPONSE",
            `The stream-report service returned an invalid ${path}.`,
          );
        }

        seenSkus.add(entry.sku);
        return {
          sku: entry.sku,
          item: entry.item,
          style: entry.style,
          size: entry.size,
          unitCostCents: entry.unitCostCents,
          completedSaleCount: entry.completedSaleCount,
        };
      });

      return { reportId: data.reportId, skus };
    }

    function parseGetData(data, protocol, streamReport, requestedReportId) {
      if (
        !hasExactKeys(data, [
          "displayName",
          "lifecycleStatus",
          "report",
          "reportId",
        ])
      ) {
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
          data.displayName !== null ||
          data.lifecycleStatus !== null ||
          data.report !== null
        ) {
          fail(
            "INVALID_RESPONSE",
            "The stream-report service returned an incomplete saved report.",
          );
        }

        return {
          reportId: null,
          lifecycleStatus: null,
          displayName: null,
          report: null,
        };
      }

      if (
        typeof data.reportId !== "string" ||
        !protocol.REPORT_ID_PATTERN.test(data.reportId) ||
        data.reportId !== requestedReportId ||
        !["finalized", "pending_end"].includes(data.lifecycleStatus) ||
        !(
          data.displayName === null ||
          (
            typeof data.displayName === "string" &&
            data.displayName.length >= 1 &&
            data.displayName.length <=
              protocol.MAX_REPORT_DISPLAY_NAME_LENGTH &&
            data.displayName === data.displayName.trim() &&
            !/[\u0000-\u001f\u007f]/.test(data.displayName)
          )
        )
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
          displayName: data.displayName,
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

      function renameReport(optionsValue) {
        let requested;

        return enqueueCommand(
          () => {
            requested = requireRenameOptions(optionsValue, protocol);
            return {
              type: protocol.COMMAND_TYPES.RENAME_REPORT,
              ...requested,
            };
          },
          (data) => parseRenameData(data, protocol, requested),
        );
      }

      function listPaymentFixingOrders(optionsValue) {
        let requestedReportId;

        return enqueueCommand(
          () => {
            const { reportId } = requireReportOptions(optionsValue);
            requestedReportId = reportId;

            return {
              type: protocol.COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS,
              reportId,
            };
          },
          (data) =>
            parsePaymentFixingOrdersData(
              data,
              protocol,
              requestedReportId,
            ),
        );
      }

      function resolvePaymentFixingOrder(optionsValue) {
        let requestedReportId;

        return enqueueCommand(
          () => {
            const command = requireResolutionOptions(optionsValue, protocol);
            requestedReportId = command.reportId;

            return {
              type: protocol.COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER,
              ...command,
            };
          },
          (data) => {
            const parsed = parseGetData(
              data,
              protocol,
              streamReport,
              requestedReportId,
            );

            if (
              !parsed.report ||
              parsed.lifecycleStatus !== "finalized"
            ) {
              fail(
                "INVALID_RESPONSE",
                "The stream-report service did not return the updated report.",
              );
            }

            return parsed;
          },
        );
      }

      function listReportUnitCosts(optionsValue) {
        let requestedReportId;

        return enqueueCommand(
          () => {
            const { reportId } = requireReportOptions(optionsValue);
            requestedReportId = reportId;

            return {
              type: protocol.COMMAND_TYPES.LIST_REPORT_UNIT_COSTS,
              reportId,
            };
          },
          (data) =>
            parseReportUnitCostsData(
              data,
              protocol,
              requestedReportId,
            ),
        );
      }

      function updateReportUnitCost(optionsValue) {
        let requestedReportId;

        return enqueueCommand(
          () => {
            const command = requireUnitCostOptions(optionsValue, protocol);
            requestedReportId = command.reportId;

            return {
              type: protocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
              ...command,
            };
          },
          (data) => {
            const parsed = parseGetData(
              data,
              protocol,
              streamReport,
              requestedReportId,
            );

            if (!parsed.report || parsed.lifecycleStatus !== "finalized") {
              fail(
                "INVALID_RESPONSE",
                "The stream-report service did not return the updated report.",
              );
            }

            return parsed;
          },
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
        listPaymentFixingOrders,
        listReportUnitCosts,
        listReports,
        renameReport,
        resolvePaymentFixingOrder,
        restoreReports,
        updateReportUnitCost,
      });
    }

    return Object.freeze({
      StreamReportClientError,
      DEFAULT_REQUEST_TIMEOUT_MS,
      createStreamReportClient,
    });
  },
);
