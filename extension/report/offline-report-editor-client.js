(function initializeOfflineReportEditorClient(root, factory) {
  const offlineReportEditorClient = factory(
    typeof root.setTimeout === "function" ? root.setTimeout.bind(root) : null,
    typeof root.clearTimeout === "function"
      ? root.clearTimeout.bind(root)
      : null,
  );

  if (typeof module === "object" && module.exports) {
    module.exports = offlineReportEditorClient;
  }

  root.TikTokLiveTrackerOfflineReportEditorClient =
    offlineReportEditorClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createOfflineReportEditorClientModule(
    defaultSetTimeout,
    defaultClearTimeout,
  ) {
    "use strict";

    const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
    const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const BLOCKED_ELIGIBILITY_CODES = new Set([
      "REPORT_NOT_FINALIZED",
      "ACTIVE_STREAM_ALREADY_EXISTS",
      "ACTIVE_BIDDING_AT_END",
      "PAYMENT_FIXING_ORDERS_REMAIN",
      "PENDING_MAPPED_ORDERS_REMAIN",
      "UNRESOLVED_ORDERS_REMAIN",
    ]);
    const READ_ONLY_ELIGIBILITY_CODE = "NO_EDITABLE_VARIATIONS";

    class OfflineReportEditorClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "OfflineReportEditorClientError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new OfflineReportEditorClientError(code, message);
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
        actualKeys.every(
          (key, index) => key === sortedExpectedKeys[index],
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
        if (error instanceof OfflineReportEditorClientError) {
          throw error;
        }

        fail(code, message);
      }
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Client options are required.");
      }

      const { protocol, runtime } = options;
      const setTimeoutImpl = options.setTimeoutImpl ?? defaultSetTimeout;
      const clearTimeoutImpl =
        options.clearTimeoutImpl ?? defaultClearTimeout;
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
        typeof protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA !==
          "string" ||
        typeof protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS !==
          "string" ||
        protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA.trim() === "" ||
        protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS.trim() === "" ||
        protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA ===
          protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS ||
        !(protocol.REPORT_ID_PATTERN instanceof RegExp) ||
        !Number.isSafeInteger(protocol.MAX_OFFLINE_MAPPING_CHANGES) ||
        protocol.MAX_OFFLINE_MAPPING_CHANGES < 1 ||
        !Number.isSafeInteger(protocol.MAX_REPORT_DISPLAY_NAME_LENGTH) ||
        protocol.MAX_REPORT_DISPLAY_NAME_LENGTH < 1 ||
        typeof protocol.createStreamReportMessage !== "function"
      ) {
        throw new TypeError(
          "A valid stream-report message protocol is required.",
        );
      }

      if (
        typeof setTimeoutImpl !== "function" ||
        typeof clearTimeoutImpl !== "function" ||
        !Number.isSafeInteger(requestTimeoutMs) ||
        requestTimeoutMs < 1
      ) {
        throw new TypeError(
          "The Offline Report Editor client requires timeout dependencies.",
        );
      }

      return {
        protocol,
        runtime,
        setTimeoutImpl,
        clearTimeoutImpl,
        requestTimeoutMs,
      };
    }

    function parseResponse(response) {
      if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
        fail(
          "INVALID_RESPONSE",
          "The Offline Report Editor service returned an invalid response.",
        );
      }

      if (response.ok) {
        if (
          !hasExactKeys(response, ["data", "ok"]) ||
          !isPlainRecord(response.data)
        ) {
          fail(
            "INVALID_RESPONSE",
            "The Offline Report Editor service returned an invalid response.",
          );
        }

        return cloneSerializable(
          response.data,
          "INVALID_RESPONSE",
          "The Offline Report Editor service returned invalid data.",
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
          "The Offline Report Editor service returned an invalid response.",
        );
      }

      throw new OfflineReportEditorClientError(
        response.error.code,
        response.error.message,
      );
    }

    function requireReportId(value, protocol) {
      if (
        typeof value !== "string" ||
        !protocol.REPORT_ID_PATTERN.test(value)
      ) {
        fail("INVALID_CLIENT_COMMAND", "A valid reportId is required.");
      }

      return value;
    }

    function requireMappingSku(value) {
      if (value !== null && (typeof value !== "string" ||
        !SKU_PATTERN.test(value))) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "Mapping SKUs must be exact report inventory SKUs or null.",
        );
      }

      return value;
    }

    function requireMappingChanges(changes, protocol) {
      const changeKeys = Array.isArray(changes) ? Object.keys(changes) : [];

      if (
        !Array.isArray(changes) ||
        changes.length < 1 ||
        changes.length > protocol.MAX_OFFLINE_MAPPING_CHANGES ||
        changeKeys.length !== changes.length ||
        changeKeys.some((key, index) => key !== String(index))
      ) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "A dense, non-empty mapping-correction batch is required.",
        );
      }

      const expectedKeys = [
        "expectedSku",
        "expectedStatus",
        "sku",
        "variationNumber",
      ];
      const seenVariationNumbers = new Set();

      return changes.map((change) => {
        if (
          !hasExactKeys(change, expectedKeys) ||
          !Number.isSafeInteger(change.variationNumber) ||
          change.variationNumber < 1 ||
          !["payment_complete", "canceled"].includes(
            change.expectedStatus,
          ) ||
          seenVariationNumbers.has(change.variationNumber)
        ) {
          fail(
            "INVALID_CLIENT_COMMAND",
            "Each correction must contain one unique terminal variation.",
          );
        }

        seenVariationNumbers.add(change.variationNumber);
        return {
          variationNumber: change.variationNumber,
          expectedStatus: change.expectedStatus,
          expectedSku: requireMappingSku(change.expectedSku),
          sku: requireMappingSku(change.sku),
        };
      });
    }

    function requireLoadOptions(value, protocol) {
      if (!hasExactKeys(value, ["reportId"])) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "Load options must contain exactly reportId.",
        );
      }

      return { reportId: requireReportId(value.reportId, protocol) };
    }

    function requireSaveOptions(value, protocol) {
      if (!hasExactKeys(value, ["changes", "reportId"])) {
        fail(
          "INVALID_CLIENT_COMMAND",
          "Save options must contain exactly changes and reportId.",
        );
      }

      return {
        reportId: requireReportId(value.reportId, protocol),
        changes: requireMappingChanges(value.changes, protocol),
      };
    }

    function requireTimestamp(value, path) {
      if (typeof value !== "string") {
        fail("INVALID_RESPONSE", `${path} must be a UTC timestamp.`);
      }

      const parsed = new Date(value);

      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        fail("INVALID_RESPONSE", `${path} must be a UTC timestamp.`);
      }

      return value;
    }

    function requireText(value, path, options = {}) {
      const allowEmpty = options.allowEmpty === true;
      const maximum = options.maximum ?? 160;

      if (
        typeof value !== "string" ||
        (!allowEmpty && value.length === 0) ||
        value.length > maximum ||
        value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        fail("INVALID_RESPONSE", `${path} is invalid.`);
      }

      return value;
    }

    function requireInteger(value, path, options = {}) {
      const signed = options.signed === true;

      if (
        !Number.isSafeInteger(value) ||
        (!signed && value < 0)
      ) {
        fail("INVALID_RESPONSE", `${path} is invalid.`);
      }

      return value;
    }

    function parseEligibility(value) {
      if (
        !hasExactKeys(value, ["code", "reason", "status"]) ||
        !["editable", "read_only", "blocked"].includes(value.status)
      ) {
        fail("INVALID_RESPONSE", "Report editor eligibility is invalid.");
      }

      const editable = value.status === "editable";
      const readOnly = value.status === "read_only";
      const validUnavailableReason =
        typeof value.reason === "string" &&
        value.reason.length >= 1 &&
        value.reason.length <= 240 &&
        !/[\u0000-\u001f\u007f]/.test(value.reason);

      if (
        editable
          ? value.code !== null || value.reason !== null
          : !validUnavailableReason ||
            (
              readOnly
                ? value.code !== READ_ONLY_ELIGIBILITY_CODE
                : !BLOCKED_ELIGIBILITY_CODES.has(value.code)
            )
      ) {
        fail("INVALID_RESPONSE", "Report editor eligibility is inconsistent.");
      }

      return {
        status: value.status,
        code: value.code,
        reason: value.reason,
      };
    }

    function parseInventory(value, protocol) {
      if (
        !Array.isArray(value) ||
        value.length > protocol.MAX_OFFLINE_MAPPING_CHANGES
      ) {
        fail("INVALID_RESPONSE", "Report editor inventory is invalid.");
      }

      const expectedKeys = [
        "availableAfterReservationsQuantity",
        "baselineSoldQuantity",
        "calculatedRemainingQuantity",
        "item",
        "openingQuantity",
        "oversoldQuantity",
        "pendingQuantity",
        "replacementQuantity",
        "requiresRecount",
        "size",
        "sku",
        "streamSoldQuantity",
        "style",
        "unitCostCents",
      ];
      const seenSkus = new Set();

      return value.map((entry, index) => {
        const path = `inventory[${index}]`;

        if (
          !hasExactKeys(entry, expectedKeys) ||
          typeof entry.sku !== "string" ||
          !SKU_PATTERN.test(entry.sku) ||
          seenSkus.has(entry.sku) ||
          typeof entry.requiresRecount !== "boolean"
        ) {
          fail("INVALID_RESPONSE", `${path} is invalid.`);
        }

        const item = requireText(entry.item, `${path}.item`);
        const style = requireText(entry.style, `${path}.style`, {
          allowEmpty: true,
        });
        const size = requireText(entry.size, `${path}.size`, {
          allowEmpty: true,
          maximum: 80,
        });
        const unitCostCents = requireInteger(
          entry.unitCostCents,
          `${path}.unitCostCents`,
        );
        const openingQuantity = requireInteger(
          entry.openingQuantity,
          `${path}.openingQuantity`,
        );
        const streamSoldQuantity = requireInteger(
          entry.streamSoldQuantity,
          `${path}.streamSoldQuantity`,
        );
        const baselineSoldQuantity = requireInteger(
          entry.baselineSoldQuantity,
          `${path}.baselineSoldQuantity`,
        );
        const pendingQuantity = requireInteger(
          entry.pendingQuantity,
          `${path}.pendingQuantity`,
        );
        const calculatedRemainingQuantity = requireInteger(
          entry.calculatedRemainingQuantity,
          `${path}.calculatedRemainingQuantity`,
          { signed: true },
        );
        const replacementQuantity = requireInteger(
          entry.replacementQuantity,
          `${path}.replacementQuantity`,
        );
        const availableAfterReservationsQuantity = requireInteger(
          entry.availableAfterReservationsQuantity,
          `${path}.availableAfterReservationsQuantity`,
        );
        const oversoldQuantity = requireInteger(
          entry.oversoldQuantity,
          `${path}.oversoldQuantity`,
        );
        const exactOversold = BigInt(baselineSoldQuantity) +
          BigInt(pendingQuantity) - BigInt(openingQuantity);
        const expectedOversold = exactOversold > 0n ? exactOversold : 0n;

        if (
          calculatedRemainingQuantity !==
            openingQuantity - baselineSoldQuantity ||
          replacementQuantity !==
            Math.max(0, calculatedRemainingQuantity) ||
          availableAfterReservationsQuantity !== Math.max(
            0,
            calculatedRemainingQuantity - pendingQuantity,
          ) ||
          expectedOversold > BigInt(Number.MAX_SAFE_INTEGER) ||
          BigInt(oversoldQuantity) !== expectedOversold ||
          entry.requiresRecount !== (oversoldQuantity > 0) ||
          streamSoldQuantity > baselineSoldQuantity
        ) {
          fail("INVALID_RESPONSE", `${path} quantities are inconsistent.`);
        }

        seenSkus.add(entry.sku);
        return {
          sku: entry.sku,
          item,
          style,
          size,
          unitCostCents,
          openingQuantity,
          streamSoldQuantity,
          baselineSoldQuantity,
          pendingQuantity,
          calculatedRemainingQuantity,
          replacementQuantity,
          availableAfterReservationsQuantity,
          oversoldQuantity,
          requiresRecount: entry.requiresRecount,
        };
      });
    }

    function parseVariations(
      value,
      expectedStatus,
      inventorySkus,
      seenVariationNumbers,
      protocol,
    ) {
      if (
        !Array.isArray(value) ||
        value.length > protocol.MAX_OFFLINE_MAPPING_CHANGES
      ) {
        fail("INVALID_RESPONSE", "Report editor variations are invalid.");
      }

      const completed = expectedStatus === "payment_complete";
      const expectedKeys = completed
        ? [
            "expectedSku",
            "expectedStatus",
            "soldPriceCents",
            "variationNumber",
          ]
        : ["expectedSku", "expectedStatus", "variationNumber"];
      let priorVariationNumber = 0;

      return value.map((entry, index) => {
        const path = `${completed ? "completed" : "canceled"}Variations[${index}]`;

        if (
          !hasExactKeys(entry, expectedKeys) ||
          !Number.isSafeInteger(entry.variationNumber) ||
          entry.variationNumber < 1 ||
          entry.variationNumber <= priorVariationNumber ||
          seenVariationNumbers.has(entry.variationNumber) ||
          entry.expectedStatus !== expectedStatus ||
          (
            entry.expectedSku !== null &&
            (
              typeof entry.expectedSku !== "string" ||
              !inventorySkus.has(entry.expectedSku)
            )
          ) ||
          (
            completed &&
            (
              !Number.isSafeInteger(entry.soldPriceCents) ||
              entry.soldPriceCents < 1
            )
          )
        ) {
          fail("INVALID_RESPONSE", `${path} is invalid.`);
        }

        priorVariationNumber = entry.variationNumber;
        seenVariationNumbers.add(entry.variationNumber);
        return completed
          ? {
              variationNumber: entry.variationNumber,
              expectedStatus,
              expectedSku: entry.expectedSku,
              soldPriceCents: entry.soldPriceCents,
            }
          : {
              variationNumber: entry.variationNumber,
              expectedStatus,
              expectedSku: entry.expectedSku,
            };
      });
    }

    function parseEditorData(data, protocol, requestedReportId) {
      if (
        !hasExactKeys(data, [
          "canceledDetailsAvailable",
          "canceledVariations",
          "completedVariations",
          "displayName",
          "eligibility",
          "endedAt",
          "inventory",
          "reportId",
        ]) ||
        data.reportId !== requestedReportId ||
        !protocol.REPORT_ID_PATTERN.test(data.reportId) ||
        (
          data.displayName !== null &&
          (
            typeof data.displayName !== "string" ||
            data.displayName.length < 1 ||
            data.displayName.length >
              protocol.MAX_REPORT_DISPLAY_NAME_LENGTH ||
            data.displayName !== data.displayName.trim() ||
            /[\u0000-\u001f\u007f]/.test(data.displayName)
          )
        ) ||
        typeof data.canceledDetailsAvailable !== "boolean"
      ) {
        fail("INVALID_RESPONSE", "Offline report editor data is invalid.");
      }

      const inventory = parseInventory(data.inventory, protocol);
      const inventorySkus = new Set(inventory.map((item) => item.sku));
      const seenVariationNumbers = new Set();
      const completedVariations = parseVariations(
        data.completedVariations,
        "payment_complete",
        inventorySkus,
        seenVariationNumbers,
        protocol,
      );
      const canceledVariations = parseVariations(
        data.canceledVariations,
        "canceled",
        inventorySkus,
        seenVariationNumbers,
        protocol,
      );
      const eligibility = parseEligibility(data.eligibility);
      const editableVariationCount =
        completedVariations.length + canceledVariations.length;

      if (
        editableVariationCount >
          protocol.MAX_OFFLINE_MAPPING_CHANGES ||
        (!data.canceledDetailsAvailable && canceledVariations.length > 0) ||
        (eligibility.status === "editable" &&
          editableVariationCount === 0) ||
        (eligibility.status === "read_only" &&
          editableVariationCount !== 0)
      ) {
        fail("INVALID_RESPONSE", "Offline report variations are inconsistent.");
      }

      return {
        reportId: data.reportId,
        displayName: data.displayName,
        endedAt: requireTimestamp(data.endedAt, "endedAt"),
        eligibility,
        canceledDetailsAvailable: data.canceledDetailsAvailable,
        completedVariations,
        canceledVariations,
        inventory,
      };
    }

    function requireSavedTargets(data, changes) {
      if (data.eligibility.status !== "editable") {
        fail(
          "INVALID_RESPONSE",
          "A saved mapping result must remain editable.",
        );
      }

      const savedByVariation = new Map([
        ...data.completedVariations,
        ...data.canceledVariations,
      ].map((entry) => [entry.variationNumber, entry]));

      changes.forEach((change) => {
        const saved = savedByVariation.get(change.variationNumber);

        if (
          !saved ||
          saved.expectedStatus !== change.expectedStatus ||
          saved.expectedSku !== change.sku
        ) {
          fail(
            "INVALID_RESPONSE",
            "The saved report did not contain the requested corrections.",
          );
        }
      });

      return data;
    }

    function createOfflineReportEditorClient(options) {
      const {
        protocol,
        runtime,
        setTimeoutImpl,
        clearTimeoutImpl,
        requestTimeoutMs,
      } = validateDependencies(options);
      let commandTail = Promise.resolve();

      async function sendCommand(command, parseData) {
        let timeoutId = null;
        const timeoutMarker = Object.freeze({ timedOut: true });

        try {
          const delivery = Promise.resolve().then(() =>
            runtime.sendMessage(
              protocol.createStreamReportMessage(command),
            ),
          );
          const timeout = new Promise((resolve) => {
            timeoutId = setTimeoutImpl(
              () => resolve(timeoutMarker),
              requestTimeoutMs,
            );
          });
          const response = await Promise.race([delivery, timeout]);

          if (response === timeoutMarker) {
            fail(
              "REPORT_REQUEST_TIMEOUT",
              "The saved report did not respond. Reload the extension and try again.",
            );
          }

          return parseData(parseResponse(response));
        } catch (error) {
          if (error instanceof OfflineReportEditorClientError) {
            throw error;
          }

          fail(
            "RUNTIME_MESSAGE_FAILED",
            "Could not reach the Offline Report Editor service.",
          );
        } finally {
          if (timeoutId !== null) {
            clearTimeoutImpl(timeoutId);
          }
        }
      }

      function enqueueCommand(createCommand, parseData) {
        let command;

        try {
          command = cloneSerializable(
            createCommand(),
            "INVALID_CLIENT_COMMAND",
            "The Offline Report Editor command must be serializable.",
          );
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() =>
          sendCommand(command, parseData));
        commandTail = execution.catch(() => undefined);
        return execution;
      }

      function loadEditorData(optionsValue) {
        let requestedReportId;

        return enqueueCommand(
          () => {
            const options = requireLoadOptions(optionsValue, protocol);
            requestedReportId = options.reportId;
            return {
              type: protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
              reportId: requestedReportId,
            };
          },
          (data) => parseEditorData(data, protocol, requestedReportId),
        );
      }

      function saveMappingCorrections(optionsValue) {
        let requested;

        return enqueueCommand(
          () => {
            requested = requireSaveOptions(optionsValue, protocol);
            return {
              type:
                protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
              ...requested,
            };
          },
          (data) => requireSavedTargets(
            parseEditorData(data, protocol, requested.reportId),
            requested.changes,
          ),
        );
      }

      return Object.freeze({
        loadEditorData,
        saveMappingCorrections,
      });
    }

    return Object.freeze({
      DEFAULT_REQUEST_TIMEOUT_MS,
      OfflineReportEditorClientError,
      createOfflineReportEditorClient,
    });
  },
);
