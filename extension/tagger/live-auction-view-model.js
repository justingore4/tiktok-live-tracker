(function exposeLiveAuctionViewModel(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.TikTokLiveTrackerLiveAuctionViewModel = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createLiveAuctionViewModel() {
    "use strict";

    const UNAVAILABLE = "\u2014";

    function isNonnegativeSafeInteger(value) {
      return Number.isSafeInteger(value) && value >= 0;
    }

    function isPositiveSafeInteger(value) {
      return Number.isSafeInteger(value) && value > 0;
    }

    function getSignedProfitDisplay(profitCents, formatUsdCents) {
      if (!Number.isSafeInteger(profitCents)) {
        return {
          label: UNAVAILABLE,
          tone: "neutral",
        };
      }

      return {
        label: `${profitCents > 0 ? "+" : ""}${formatUsdCents(profitCents)}`,
        tone:
          profitCents > 0
            ? "positive"
            : profitCents < 0
              ? "negative"
              : "neutral",
      };
    }

    function getVariationNumber(value) {
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }

    function getMatchingActiveMapping(view, variationNumber) {
      const mapping = view?.activeAuctionMapping;

      return (
        mapping?.variationNumber === variationNumber &&
        typeof mapping.sku === "string" &&
        mapping.sku.trim().length > 0 &&
        isNonnegativeSafeInteger(mapping.unitCostCents)
      )
        ? mapping
        : null;
    }

    function createDisplay({ activeMode, view, liveAuction, formatUsdCents }) {
      if (typeof formatUsdCents !== "function") {
        throw new TypeError("A currency formatter is required.");
      }

      if (activeMode !== "saved_session" || !view) {
        return {
          hidden: true,
          variationNumber: null,
          variationLabel: "Variation # -",
          currentBid: UNAVAILABLE,
          unitCost: UNAVAILABLE,
          grossProfit: UNAVAILABLE,
          profitTone: "neutral",
          note: "",
          state: "inactive",
        };
      }

      const activeVariationNumber = getVariationNumber(
        view.activeBiddingVariationNumber,
      );
      const retainedVariationNumber = getVariationNumber(
        liveAuction?.variationNumber,
      );
      const variationNumber = activeVariationNumber ?? retainedVariationNumber;
      const matchingSnapshot =
        variationNumber !== null &&
        liveAuction?.variationNumber === variationNumber
          ? liveAuction
          : null;
      const activeMapping = activeVariationNumber === null
        ? null
        : getMatchingActiveMapping(view, activeVariationNumber);
      const bidPriceCents = isPositiveSafeInteger(
        matchingSnapshot?.bidPriceCents,
      )
        ? matchingSnapshot.bidPriceCents
        : null;
      const snapshotUnitCostCents = isNonnegativeSafeInteger(
        matchingSnapshot?.unitCostCents,
      )
        ? matchingSnapshot.unitCostCents
        : null;
      const unitCostCents = activeVariationNumber === null
        ? snapshotUnitCostCents
        : activeMapping?.unitCostCents ?? null;
      const hasBid = bidPriceCents !== null;
      const hasMapping = unitCostCents !== null;
      const profitCents = hasBid && hasMapping
        ? bidPriceCents - unitCostCents
        : null;
      const profit = getSignedProfitDisplay(profitCents, formatUsdCents);
      let note;

      if (activeVariationNumber === null && variationNumber === null) {
        note = "Waiting for a live auction.";
      } else if (activeVariationNumber === null) {
        note = "Waiting for the next live item.";
      } else if (!hasBid && !hasMapping) {
        note =
          "Waiting for a live bid. Map the live item to show cost and profit.";
      } else if (!hasBid) {
        note =
          "Waiting for a live bid. Unit cost is ready; profit will appear with the first bid.";
      } else if (!hasMapping) {
        note =
          "Map the live item to show unit cost and live gross profit.";
      } else {
        note =
          "Live pre-fee estimate. Sold Items determines the final price.";
      }

      return {
        hidden: false,
        variationNumber,
        variationLabel: variationNumber === null
          ? "Variation # -"
          : `Variation #${variationNumber}`,
        currentBid: hasBid
          ? formatUsdCents(bidPriceCents)
          : UNAVAILABLE,
        unitCost: hasMapping
          ? formatUsdCents(unitCostCents)
          : UNAVAILABLE,
        grossProfit: profit.label,
        profitTone: profit.tone,
        note,
        state:
          activeVariationNumber === null
            ? variationNumber === null
              ? "inactive"
              : "retained"
            : hasBid && hasMapping
              ? "ready"
              : hasBid
                ? "unmapped"
                : "waiting",
      };
    }

    return Object.freeze({
      createDisplay,
      getSignedProfitDisplay,
    });
  },
);
