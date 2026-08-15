(function initializeLiveBidClient(root, factory) {
  const liveBidClient = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = liveBidClient;
  }

  root.TikTokLiveTrackerLiveBidClient = liveBidClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createLiveBidClientModule() {
    "use strict";

    class LiveBidClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "LiveBidClientError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new LiveBidClientError(code, message);
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

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Live-bid client options are required.");
      }

      if (!options.runtime || typeof options.runtime.sendMessage !== "function") {
        throw new TypeError("runtime must provide sendMessage.");
      }

      if (
        !options.protocol ||
        typeof options.protocol.createLiveBidMessage !== "function" ||
        options.protocol.COMMAND_TYPES?.GET_LIVE_BID !== "get_live_bid"
      ) {
        throw new TypeError("A valid live-bid protocol is required.");
      }

      return options;
    }

    function parseResponse(response) {
      if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
        fail("INVALID_RESPONSE", "The live-bid service returned an invalid response.");
      }

      if (!response.ok) {
        if (
          !hasExactKeys(response, ["error", "ok"]) ||
          !hasExactKeys(response.error, ["code", "message"]) ||
          typeof response.error.code !== "string" ||
          response.error.code.trim() === "" ||
          typeof response.error.message !== "string" ||
          response.error.message.trim() === ""
        ) {
          fail("INVALID_RESPONSE", "The live-bid service returned an invalid response.");
        }

        throw new LiveBidClientError(
          response.error.code,
          response.error.message,
        );
      }

      if (
        !hasExactKeys(response, ["data", "ok"]) ||
        !hasExactKeys(response.data, ["liveAuction"])
      ) {
        fail("INVALID_RESPONSE", "The live-bid service returned an invalid response.");
      }

      const liveAuction = response.data.liveAuction;

      if (liveAuction === null) {
        return { liveAuction: null };
      }

      if (
        !hasExactKeys(liveAuction, [
          "bidPriceCents",
          "unitCostCents",
          "variationNumber",
        ]) ||
        !Number.isSafeInteger(liveAuction.variationNumber) ||
        liveAuction.variationNumber < 1 ||
        !(
          liveAuction.bidPriceCents === null ||
          (
            Number.isSafeInteger(liveAuction.bidPriceCents) &&
            liveAuction.bidPriceCents > 0
          )
        ) ||
        !(
          liveAuction.unitCostCents === null ||
          (
            Number.isSafeInteger(liveAuction.unitCostCents) &&
            liveAuction.unitCostCents >= 0
          )
        )
      ) {
        fail("INVALID_RESPONSE", "The live-bid service returned an invalid response.");
      }

      return {
        liveAuction: {
          variationNumber: liveAuction.variationNumber,
          bidPriceCents: liveAuction.bidPriceCents,
          unitCostCents: liveAuction.unitCostCents,
        },
      };
    }

    function createLiveBidClient(options) {
      const { runtime, protocol } = validateDependencies(options);

      async function getLiveBid() {
        let response;

        try {
          response = await runtime.sendMessage(
            protocol.createLiveBidMessage({
              type: protocol.COMMAND_TYPES.GET_LIVE_BID,
            }),
          );
        } catch (_error) {
          fail(
            "LIVE_BID_SERVICE_UNAVAILABLE",
            "The current live bid could not be loaded.",
          );
        }

        return parseResponse(response);
      }

      return Object.freeze({ getLiveBid });
    }

    return Object.freeze({ LiveBidClientError, createLiveBidClient });
  },
);
