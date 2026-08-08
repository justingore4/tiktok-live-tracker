(function initializeReconciliationStorage(root, factory) {
  const reconciliationStorage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = reconciliationStorage;
  }

  root.TikTokLiveTrackerReconciliationStorage = reconciliationStorage;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createReconciliationStorageModule() {
    "use strict";

    const STORAGE_KEY = "tiktokLiveTracker.reconciliation";
    const STORAGE_SCHEMA_VERSION = 1;

    class ReconciliationStorageError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "ReconciliationStorageError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new ReconciliationStorageError(code, message, { cause });
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function requireExactKeys(value, expectedKeys) {
      if (!isPlainRecord(value)) {
        fail(
          "INVALID_STORAGE_ENVELOPE",
          "The stored reconciliation value must be an object.",
        );
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail(
          "INVALID_STORAGE_ENVELOPE",
          "The stored reconciliation value must contain exactly: " +
            `${sortedExpectedKeys.join(", ")}.`,
        );
      }
    }

    function hydrateState(reconciliation, candidate) {
      try {
        return reconciliation.hydrateReconciliationState(candidate);
      } catch (error) {
        const unsupportedVersion =
          error?.code === "UNSUPPORTED_STATE_VERSION";

        fail(
          unsupportedVersion
            ? "UNSUPPORTED_RECONCILIATION_VERSION"
            : "INVALID_RECONCILIATION_STATE",
          unsupportedVersion
            ? "The stored reconciliation state version is not supported."
            : "The stored reconciliation state is invalid.",
          error,
        );
      }
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Storage options are required.");
      }

      const { storageArea, reconciliation } = options;

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
        !reconciliation ||
        typeof reconciliation.hydrateReconciliationState !== "function"
      ) {
        throw new TypeError(
          "reconciliation must provide hydrateReconciliationState.",
        );
      }

      return { storageArea, reconciliation };
    }

    function createReconciliationStateStore(options) {
      const { storageArea, reconciliation } = validateDependencies(options);

      async function loadState() {
        let storedValues;

        try {
          storedValues = await storageArea.get(STORAGE_KEY);
        } catch (error) {
          fail(
            "STORAGE_READ_FAILED",
            "Could not read reconciliation state from browser storage.",
            error,
          );
        }

        if (!isPlainRecord(storedValues)) {
          fail(
            "STORAGE_READ_FAILED",
            "Browser storage returned an invalid response.",
          );
        }

        if (!Object.prototype.hasOwnProperty.call(storedValues, STORAGE_KEY)) {
          return null;
        }

        const envelope = storedValues[STORAGE_KEY];

        requireExactKeys(envelope, [
          "reconciliationState",
          "schemaVersion",
        ]);

        if (
          !Number.isSafeInteger(envelope.schemaVersion) ||
          envelope.schemaVersion < 1
        ) {
          fail(
            "INVALID_STORAGE_ENVELOPE",
            "The storage schema version must be a safe integer.",
          );
        }

        if (envelope.schemaVersion !== STORAGE_SCHEMA_VERSION) {
          fail(
            "UNSUPPORTED_STORAGE_VERSION",
            `Storage schema version ${envelope.schemaVersion} is not supported.`,
          );
        }

        return hydrateState(reconciliation, envelope.reconciliationState);
      }

      async function saveState(state) {
        const reconciliationState = hydrateState(reconciliation, state);
        const envelope = {
          schemaVersion: STORAGE_SCHEMA_VERSION,
          reconciliationState,
        };

        try {
          await storageArea.set({ [STORAGE_KEY]: envelope });
        } catch (error) {
          fail(
            "STORAGE_WRITE_FAILED",
            "Could not save reconciliation state to browser storage.",
            error,
          );
        }
      }

      return Object.freeze({ loadState, saveState });
    }

    return {
      STORAGE_KEY,
      STORAGE_SCHEMA_VERSION,
      ReconciliationStorageError,
      createReconciliationStateStore,
    };
  },
);
