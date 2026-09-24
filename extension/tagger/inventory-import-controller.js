(function initializeInventoryImportController(root, factory) {
  const inventoryImportController = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = inventoryImportController;
  }

  root.TikTokLiveTrackerInventoryImportController = inventoryImportController;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createInventoryImportControllerModule() {
    "use strict";

    const PHASES = Object.freeze({
      IDLE: "idle",
      LOADING: "loading",
      READY: "ready",
      PREVIEWING: "previewing",
      CONFIRMING: "confirming",
      ERROR: "error",
    });
    const OPERATIONS = Object.freeze({
      LOAD: "load",
      PREVIEW: "preview",
      CONFIRM: "confirm",
    });
    const NO_STATE_CODES = new Set([
      "STATE_NOT_INITIALIZED",
      "RECONCILIATION_STATE_NOT_INITIALIZED",
    ]);

    class InventoryImportControllerError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "InventoryImportControllerError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new InventoryImportControllerError(code, message);
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
      if (value === null || value === undefined) {
        return value ?? null;
      }

      return JSON.parse(JSON.stringify(value));
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Inventory-import controller options are required.");
      }

      const { client } = options;

      if (
        !client ||
        typeof client.getImportStatus !== "function" ||
        typeof client.normalizeReference !== "function" ||
        typeof client.previewSpreadsheetId !== "function" ||
        typeof client.confirmPreview !== "function"
      ) {
        throw new TypeError(
          "client must provide import status, reference parsing, preview, and confirmation methods.",
        );
      }

      return client;
    }

    function requireImportStatus(value) {
      if (
        !hasExactKeys(value, [
          "baselineId",
          "ready",
          "sourceFingerprint",
          "summary",
        ]) ||
        typeof value.ready !== "boolean" ||
        !(value.baselineId === null || typeof value.baselineId === "string") ||
        !(
          value.sourceFingerprint === null ||
          typeof value.sourceFingerprint === "string"
        ) ||
        !(value.summary === null || isPlainRecord(value.summary))
      ) {
        fail(
          "INVALID_CLIENT_RESPONSE",
          "The inventory status service returned invalid data.",
        );
      }

      if (!value.ready) {
        if (
          value.baselineId !== null ||
          value.sourceFingerprint !== null ||
          value.summary !== null
        ) {
          fail(
            "INVALID_CLIENT_RESPONSE",
            "The inventory status service returned invalid data.",
          );
        }

        return null;
      }

      if (
        typeof value.baselineId !== "string" ||
        value.baselineId.trim() === "" ||
        typeof value.sourceFingerprint !== "string" ||
        value.sourceFingerprint.trim() === "" ||
        !hasExactKeys(value.summary, [
          "rowCount",
          "totalInventoryCostCents",
          "totalQuantityOnHandAtImport",
        ]) ||
        !Number.isSafeInteger(value.summary.rowCount) ||
        value.summary.rowCount < 1 ||
        !Number.isSafeInteger(value.summary.totalQuantityOnHandAtImport) ||
        value.summary.totalQuantityOnHandAtImport < 0 ||
        !Number.isSafeInteger(value.summary.totalInventoryCostCents) ||
        value.summary.totalInventoryCostCents < 0
      ) {
        fail(
          "INVALID_CLIENT_RESPONSE",
          "The inventory status service returned invalid data.",
        );
      }

      return cloneSerializable({
        baselineId: value.baselineId,
        sourceFingerprint: value.sourceFingerprint,
        summary: value.summary,
      });
    }

    function normalizeIssues(error) {
      if (!Array.isArray(error?.issues)) {
        return [];
      }

      return error.issues
        .filter((issue) => isPlainRecord(issue))
        .slice(0, 100)
        .map((issue) => ({
          rowNumber:
            Number.isSafeInteger(issue.rowNumber) && issue.rowNumber > 0
              ? issue.rowNumber
              : null,
          column:
            typeof issue.column === "string" && issue.column.trim() !== ""
              ? issue.column.trim().slice(0, 80)
              : null,
          code:
            typeof issue.code === "string" && issue.code.trim() !== ""
              ? issue.code.trim().slice(0, 80)
              : "INVALID_VALUE",
          message:
            typeof issue.message === "string" && issue.message.trim() !== ""
              ? issue.message.trim().slice(0, 500)
              : "This value is invalid.",
        }));
    }

    function normalizeError(error, scope) {
      const code =
        typeof error?.code === "string" && error.code.trim() !== ""
          ? error.code.trim().slice(0, 80)
          : "INVENTORY_IMPORT_FAILED";
      const providedMessage =
        typeof error?.message === "string" && error.message.trim() !== ""
          ? error.message.trim().slice(0, 500)
          : null;
      const fallbackMessage = {
        [OPERATIONS.LOAD]:
          "The saved inventory baseline could not be checked. Nothing was changed.",
        [OPERATIONS.PREVIEW]:
          "The Inventory tab could not be previewed. Nothing was imported.",
        [OPERATIONS.CONFIRM]:
          "The inventory baseline could not be confirmed. Nothing was imported.",
      }[scope];

      return {
        scope,
        code,
        message: providedMessage ?? fallbackMessage,
        issues: normalizeIssues(error),
      };
    }

    function requirePreview(value) {
      if (
        !isPlainRecord(value) ||
        value.contractVersion !== 1 ||
        typeof value.previewToken !== "string" ||
        value.previewToken.trim() === "" ||
        typeof value.spreadsheetId !== "string" ||
        value.spreadsheetId.trim() === "" ||
        value.range !== "'Inventory'!A:F" ||
        typeof value.fingerprint !== "string" ||
        value.fingerprint.trim() === "" ||
        !Array.isArray(value.inventory) ||
        value.inventory.length === 0 ||
        value.inventory.length > 1_000 ||
        !hasExactKeys(value.summary, [
          "rowCount",
          "totalInventoryCostCents",
          "totalQuantityOnHandAtImport",
        ]) ||
        !Number.isSafeInteger(value.summary.rowCount) ||
        value.summary.rowCount !== value.inventory.length ||
        !Number.isSafeInteger(value.summary.totalQuantityOnHandAtImport) ||
        value.summary.totalQuantityOnHandAtImport < 0 ||
        !Number.isSafeInteger(value.summary.totalInventoryCostCents) ||
        value.summary.totalInventoryCostCents < 0 ||
        value.inventory.some(
          (row) =>
            !isPlainRecord(row) ||
            typeof row.sku !== "string" ||
            typeof row.item !== "string" ||
            typeof row.style !== "string" ||
            typeof row.size !== "string" ||
            !Number.isSafeInteger(row.quantityOnHandAtImport) ||
            row.quantityOnHandAtImport < 0 ||
            !Number.isSafeInteger(row.unitCostCents) ||
            row.unitCostCents < 0,
        )
      ) {
        fail(
          "INVALID_CLIENT_RESPONSE",
          "The inventory preview service returned invalid data.",
        );
      }

      return cloneSerializable(value);
    }

    function requireConfirmation(value) {
      if (
        !isPlainRecord(value) ||
        typeof value.baselineId !== "string" ||
        value.baselineId.trim() === "" ||
        typeof value.sourceFingerprint !== "string" ||
        value.sourceFingerprint.trim() === "" ||
        !hasExactKeys(value.summary, [
          "rowCount",
          "totalInventoryCostCents",
          "totalQuantityOnHandAtImport",
        ]) ||
        !Number.isSafeInteger(value.summary.rowCount) ||
        value.summary.rowCount < 1 ||
        !Number.isSafeInteger(value.summary.totalQuantityOnHandAtImport) ||
        value.summary.totalQuantityOnHandAtImport < 0 ||
        !Number.isSafeInteger(value.summary.totalInventoryCostCents) ||
        value.summary.totalInventoryCostCents < 0
      ) {
        fail(
          "INVALID_CLIENT_RESPONSE",
          "The inventory confirmation service returned invalid data.",
        );
      }

      return cloneSerializable(value);
    }

    function createInventoryImportController(options) {
      const client = validateDependencies(options);
      const listeners = new Set();
      let phase = PHASES.IDLE;
      let operation = null;
      let error = null;
      let preview = null;
      let confirmation = null;
      let hasConfirmedBaseline = false;
      let activeStream = false;
      let activePromise = null;
      let retryDescriptor = null;
      let started = false;
      let operationEpoch = 0;

      function createSnapshot() {
        return {
          phase,
          operation,
          busy: [PHASES.LOADING, PHASES.PREVIEWING, PHASES.CONFIRMING].includes(
            phase,
          ),
          error: cloneSerializable(error),
          preview: cloneSerializable(preview),
          confirmation: cloneSerializable(confirmation),
          hasConfirmedBaseline,
          activeStream,
        };
      }

      function publish() {
        const snapshot = createSnapshot();

        listeners.forEach((listener) => {
          try {
            listener(snapshot);
          } catch (_error) {
            // A faulty UI observer cannot interrupt import state.
          }
        });
      }

      function transition(nextPhase, nextOperation, nextError = null) {
        phase = nextPhase;
        operation = nextOperation;
        error = nextError;
        publish();
      }

      function begin(descriptor) {
        if (activePromise) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current inventory operation to finish.",
          );
        }

        if (activeStream && descriptor.operation !== OPERATIONS.LOAD) {
          fail(
            "ACTIVE_STREAM_ALREADY_EXISTS",
            "End the active tracker stream before importing inventory.",
          );
        }

        retryDescriptor = descriptor;
        const descriptorEpoch = operationEpoch;
        transition(
          descriptor.operation === OPERATIONS.LOAD
            ? PHASES.LOADING
            : descriptor.operation === OPERATIONS.PREVIEW
              ? PHASES.PREVIEWING
              : PHASES.CONFIRMING,
          descriptor.operation,
        );

        const execution = Promise.resolve()
          .then(descriptor.execute)
          .then((value) => {
            if (
              descriptor.operation !== OPERATIONS.LOAD &&
              (activeStream || descriptorEpoch !== operationEpoch)
            ) {
              return createSnapshot();
            }

            descriptor.accept(value);
            retryDescriptor = null;
            transition(PHASES.READY, descriptor.operation);
            return createSnapshot();
          })
          .catch((failure) => {
            if (
              descriptor.operation !== OPERATIONS.LOAD &&
              (activeStream || descriptorEpoch !== operationEpoch)
            ) {
              return createSnapshot();
            }

            if (
              descriptor.operation === OPERATIONS.LOAD &&
              NO_STATE_CODES.has(failure?.code)
            ) {
              hasConfirmedBaseline = false;
              confirmation = null;
              retryDescriptor = null;
              transition(PHASES.READY, descriptor.operation);
              return createSnapshot();
            }

            transition(
              PHASES.ERROR,
              descriptor.operation,
              normalizeError(failure, descriptor.operation),
            );
            return createSnapshot();
          });
        const tracked = execution.finally(() => {
          if (activePromise === tracked) {
            activePromise = null;
          }
        });

        activePromise = tracked;
        return tracked;
      }

      function createLoadDescriptor() {
        return Object.freeze({
          operation: OPERATIONS.LOAD,
          execute: () => client.getImportStatus(),
          accept(response) {
            const existing = requireImportStatus(response);

            confirmation = existing;
            hasConfirmedBaseline = existing !== null;
          },
        });
      }

      function start() {
        if (started) {
          return activePromise ?? Promise.resolve(createSnapshot());
        }

        started = true;
        return begin(createLoadDescriptor());
      }

      function refreshStatus() {
        if (activePromise) {
          return activePromise;
        }

        return begin(createLoadDescriptor());
      }

      function previewReference(reference) {
        let spreadsheetId = null;
        let referenceError = null;

        try {
          spreadsheetId = client.normalizeReference(reference);
        } catch (error) {
          referenceError = error;
        }

        const descriptor = Object.freeze({
          operation: OPERATIONS.PREVIEW,
          execute: () =>
            referenceError
              ? Promise.reject(referenceError)
              : client.previewSpreadsheetId(spreadsheetId),
          accept(response) {
            preview = requirePreview(response);
          },
        });

        return begin(descriptor);
      }

      function confirmPreview() {
        if (!preview) {
          fail(
            "PREVIEW_REQUIRED",
            "Preview the Inventory tab before confirming it.",
          );
        }

        const previewToken = preview.previewToken;
        const descriptor = Object.freeze({
          operation: OPERATIONS.CONFIRM,
          execute: () => client.confirmPreview(previewToken),
          accept(response) {
            confirmation = requireConfirmation(response);
            hasConfirmedBaseline = true;
            preview = null;
          },
        });

        return begin(descriptor);
      }

      function resetPreview() {
        if (activePromise) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current inventory operation to finish.",
          );
        }

        preview = null;
        error = null;
        retryDescriptor = null;
        transition(PHASES.READY, null);
        return createSnapshot();
      }

      function setActiveStream(value) {
        const nextActiveStream = value === true;

        if (nextActiveStream === activeStream) {
          return createSnapshot();
        }

        activeStream = nextActiveStream;

        if (activeStream) {
          operationEpoch += 1;
          preview = null;
          retryDescriptor = null;
          error = null;
          phase = PHASES.READY;
          operation = null;
        }

        publish();
        return createSnapshot();
      }

      function retry() {
        if (activePromise || retryDescriptor === null) {
          return activePromise ?? Promise.resolve(createSnapshot());
        }

        return begin(retryDescriptor);
      }

      function subscribe(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("subscribe requires a listener function.");
        }

        listeners.add(listener);
        try {
          listener(createSnapshot());
        } catch (_error) {
          // Match later publications: a faulty observer cannot stop the app.
        }

        let subscribed = true;

        return function unsubscribe() {
          if (!subscribed) {
            return;
          }

          subscribed = false;
          listeners.delete(listener);
        };
      }

      return Object.freeze({
        confirmPreview,
        getSnapshot: createSnapshot,
        previewReference,
        refreshStatus,
        resetPreview,
        retry,
        setActiveStream,
        start,
        subscribe,
      });
    }

    return Object.freeze({
      InventoryImportControllerError,
      OPERATIONS,
      PHASES,
      createInventoryImportController,
      requireImportStatus,
    });
  },
);
