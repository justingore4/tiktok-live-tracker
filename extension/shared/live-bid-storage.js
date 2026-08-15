(function initializeLiveBidStorage(root, factory) {
  const liveBidStorage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = liveBidStorage;
  }

  root.TikTokLiveTrackerLiveBidStorage = liveBidStorage;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createLiveBidStorageModule() {
    "use strict";

    const STORAGE_KEY = "tiktokLiveTracker.liveBid";
    const STORAGE_SCHEMA_VERSION = 2;

    class LiveBidStorageError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "LiveBidStorageError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new LiveBidStorageError(code, message, { cause });
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

    function normalizeLiveAuction(value, code = "INVALID_LIVE_AUCTION") {
      if (
        !hasExactKeys(value, [
          "bidPriceCents",
          "streamId",
          "unitCostCents",
          "variationNumber",
        ]) ||
        typeof value.streamId !== "string" ||
        value.streamId.trim() === "" ||
        !Number.isSafeInteger(value.variationNumber) ||
        value.variationNumber < 1 ||
        !(
          value.bidPriceCents === null ||
          (
            Number.isSafeInteger(value.bidPriceCents) &&
            value.bidPriceCents > 0
          )
        ) ||
        !(
          value.unitCostCents === null ||
          (
            Number.isSafeInteger(value.unitCostCents) &&
            value.unitCostCents >= 0
          )
        )
      ) {
        fail(code, "The transient live auction is invalid.");
      }

      return {
        streamId: value.streamId.trim(),
        variationNumber: value.variationNumber,
        bidPriceCents: value.bidPriceCents,
        unitCostCents: value.unitCostCents,
      };
    }

    function migrateVersionOneLiveBid(envelope) {
      if (
        !hasExactKeys(envelope, ["liveBid", "schemaVersion"]) ||
        envelope.schemaVersion !== 1 ||
        !hasExactKeys(envelope.liveBid, [
          "bidPriceCents",
          "streamId",
          "variationNumber",
        ])
      ) {
        return null;
      }

      return normalizeLiveAuction(
        {
          ...envelope.liveBid,
          unitCostCents: null,
        },
        "INVALID_LIVE_BID_STORAGE",
      );
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Live-bid storage options are required.");
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

    function createLiveBidStore(options) {
      const storageArea = validateDependencies(options);

      async function loadLiveBid() {
        let storedValues;

        try {
          storedValues = await storageArea.get(STORAGE_KEY);
        } catch (error) {
          fail(
            "LIVE_BID_STORAGE_READ_FAILED",
            "Could not read the transient live bid.",
            error,
          );
        }

        if (!isPlainRecord(storedValues)) {
          fail(
            "LIVE_BID_STORAGE_READ_FAILED",
            "Browser session storage returned an invalid response.",
          );
        }

        if (!Object.prototype.hasOwnProperty.call(storedValues, STORAGE_KEY)) {
          return null;
        }

        const envelope = storedValues[STORAGE_KEY];

        if (envelope?.schemaVersion === 1) {
          const migrated = migrateVersionOneLiveBid(envelope);

          if (migrated !== null) {
            return migrated;
          }
        }

        if (
          !hasExactKeys(envelope, ["liveAuction", "schemaVersion"]) ||
          envelope.schemaVersion !== STORAGE_SCHEMA_VERSION
        ) {
          fail(
            "INVALID_LIVE_BID_STORAGE",
            "The stored transient live auction has an unsupported shape or version.",
          );
        }

        return normalizeLiveAuction(
          envelope.liveAuction,
          "INVALID_LIVE_BID_STORAGE",
        );
      }

      async function saveLiveBid(value) {
        const liveAuction = normalizeLiveAuction(value);

        try {
          await storageArea.set({
            [STORAGE_KEY]: {
              schemaVersion: STORAGE_SCHEMA_VERSION,
              liveAuction,
            },
          });
        } catch (error) {
          fail(
            "LIVE_BID_STORAGE_WRITE_FAILED",
            "Could not save the transient live bid.",
            error,
          );
        }

        return { ...liveAuction };
      }

      async function clearLiveBid() {
        try {
          await storageArea.remove(STORAGE_KEY);
        } catch (error) {
          fail(
            "LIVE_BID_STORAGE_WRITE_FAILED",
            "Could not clear the transient live bid.",
            error,
          );
        }
      }

      return Object.freeze({ clearLiveBid, loadLiveBid, saveLiveBid });
    }

    return Object.freeze({
      LiveBidStorageError,
      STORAGE_KEY,
      STORAGE_SCHEMA_VERSION,
      createLiveBidStore,
    });
  },
);
