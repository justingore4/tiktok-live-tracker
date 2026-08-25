(function initializeNextItemQueueStorage(root, factory) {
  const nextItemQueueStorage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = nextItemQueueStorage;
  }

  root.TikTokLiveTrackerNextItemQueueStorage = nextItemQueueStorage;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createNextItemQueueStorageModule() {
    "use strict";

    const STORAGE_KEY = "tiktokLiveTracker.nextItemQueue";
    const STORAGE_SCHEMA_VERSION = 1;

    class NextItemQueueStorageError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "NextItemQueueStorageError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new NextItemQueueStorageError(code, message, { cause });
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

    function requireTrimmedString(value, fieldName, code) {
      if (
        typeof value !== "string" ||
        value === "" ||
        value !== value.trim()
      ) {
        fail(code, `${fieldName} must be a non-empty trimmed string.`);
      }

      return value;
    }

    function normalizeQueue(value, code = "INVALID_NEXT_ITEM_QUEUE") {
      if (
        !hasExactKeys(value, [
          "armedAfterVariationNumber",
          "sku",
          "streamId",
        ])
      ) {
        fail(code, "The stored next-item queue has an invalid shape.");
      }

      const streamId = requireTrimmedString(value.streamId, "streamId", code);
      const sku = requireTrimmedString(value.sku, "sku", code);

      if (
        !Number.isSafeInteger(value.armedAfterVariationNumber) ||
        value.armedAfterVariationNumber < 1
      ) {
        fail(
          code,
          "armedAfterVariationNumber must be a positive safe integer.",
        );
      }

      return {
        streamId,
        sku,
        armedAfterVariationNumber: value.armedAfterVariationNumber,
      };
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Next-item queue storage options are required.");
      }

      const { storageArea } = options;

      if (
        !storageArea ||
        typeof storageArea.get !== "function" ||
        typeof storageArea.set !== "function" ||
        typeof storageArea.remove !== "function"
      ) {
        throw new TypeError(
          "storageArea must provide Promise-based get, set, and remove methods.",
        );
      }

      return storageArea;
    }

    function createNextItemQueueStore(options) {
      const storageArea = validateDependencies(options);

      async function loadQueue() {
        let storedValues;

        try {
          storedValues = await storageArea.get(STORAGE_KEY);
        } catch (error) {
          fail(
            "NEXT_ITEM_QUEUE_STORAGE_READ_FAILED",
            "Could not read the queued next item from browser session storage.",
            error,
          );
        }

        if (!isPlainRecord(storedValues)) {
          fail(
            "NEXT_ITEM_QUEUE_STORAGE_READ_FAILED",
            "Browser session storage returned an invalid response.",
          );
        }

        if (!Object.prototype.hasOwnProperty.call(storedValues, STORAGE_KEY)) {
          return null;
        }

        const envelope = storedValues[STORAGE_KEY];

        if (
          !hasExactKeys(envelope, ["queue", "schemaVersion"]) ||
          envelope.schemaVersion !== STORAGE_SCHEMA_VERSION
        ) {
          fail(
            "INVALID_NEXT_ITEM_QUEUE_STORAGE",
            "The stored next-item queue has an unsupported shape or version.",
          );
        }

        return normalizeQueue(
          envelope.queue,
          "INVALID_NEXT_ITEM_QUEUE_STORAGE",
        );
      }

      async function saveQueue(value) {
        const queue = normalizeQueue(value);

        try {
          await storageArea.set({
            [STORAGE_KEY]: {
              schemaVersion: STORAGE_SCHEMA_VERSION,
              queue,
            },
          });
        } catch (error) {
          fail(
            "NEXT_ITEM_QUEUE_STORAGE_WRITE_FAILED",
            "Could not save the queued next item to browser session storage.",
            error,
          );
        }

        return { ...queue };
      }

      async function clearQueue() {
        try {
          await storageArea.remove(STORAGE_KEY);
        } catch (error) {
          fail(
            "NEXT_ITEM_QUEUE_STORAGE_WRITE_FAILED",
            "Could not clear the queued next item from browser session storage.",
            error,
          );
        }
      }

      return Object.freeze({ clearQueue, loadQueue, saveQueue });
    }

    return Object.freeze({
      NextItemQueueStorageError,
      STORAGE_KEY,
      STORAGE_SCHEMA_VERSION,
      createNextItemQueueStore,
    });
  },
);
