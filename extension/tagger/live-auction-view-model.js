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

    function createDisplay({ view, liveAuction, formatUsdCents }) {
      if (typeof formatUsdCents !== "function") {
        throw new TypeError("A currency formatter is required.");
      }

      if (!view) {
        return {
          hidden: true,
          variationNumber: null,
          variationLabel: "Variation # - Status | -",
          currentBid: UNAVAILABLE,
          unitCost: UNAVAILABLE,
          grossProfit: UNAVAILABLE,
          profitTone: "neutral",
          remainingInventory: UNAVAILABLE,
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
      const displayedMapping = activeVariationNumber === null
        ? view.variations?.find((entry) => entry.variationNumber === variationNumber)
        : activeMapping;
      const mappedItem = displayedMapping?.sku
        ? view.inventory?.find((entry) => entry.sku === displayedMapping.sku) ?? displayedMapping
        : null;
      const itemLabel = mappedItem?.item
        ? mappedItem.style
          ? `${mappedItem.item} - ${mappedItem.style}`
          : mappedItem.item
        : "-";
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

      return {
        hidden: false,
        variationNumber,
        variationLabel: variationNumber === null
          ? "Variation # - Status | -"
          : `Variation #${variationNumber} Status | ${itemLabel}`,
        currentBid: hasBid
          ? formatUsdCents(bidPriceCents)
          : UNAVAILABLE,
        unitCost: hasMapping
          ? formatUsdCents(unitCostCents)
          : UNAVAILABLE,
        grossProfit: profit.label,
        profitTone: profit.tone,
        remainingInventory: Number.isSafeInteger(mappedItem?.remainingQuantity)
          ? `${mappedItem.remainingQuantity} remaining`
          : UNAVAILABLE,
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
