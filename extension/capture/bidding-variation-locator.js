(function initializeBiddingVariationLocator(root, factory) {
  const locator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = locator;
  }

  root.TikTokLiveTrackerBiddingVariationLocator = locator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createBiddingVariationLocatorModule() {
    "use strict";

    const AUCTION_CARD_SELECTOR = '[class~="auction-pin-card"]';
    const OWN_TEXT_ELEMENT_SELECTOR = "*";
    const VARIATION_PREFIX_PATTERN = /^#([1-9]\d*)(?:\s|$)/;
    const BID_PRICE_PATTERN =
      /^Bids:\s+\$(0|[1-9]\d{0,2}(?:,\d{3})*)(?:\.(\d{1,2}))?$/;

    function normalizeOwnText(node) {
      if (
        !node?.childNodes ||
        typeof node.childNodes[Symbol.iterator] !== "function"
      ) {
        return "";
      }

      let value = "";

      for (const child of node.childNodes) {
        if (child?.nodeType === 3) {
          value += String(child.textContent ?? "");
        }
      }

      return value.replace(/\s+/g, " ").trim();
    }

    function parseBiddingVariationNumber(value) {
      if (typeof value !== "string") {
        return null;
      }

      const match = value.match(VARIATION_PREFIX_PATTERN);

      if (!match) {
        return null;
      }

      const variationNumber = Number(match[1]);

      return Number.isSafeInteger(variationNumber) && variationNumber > 0
        ? variationNumber
        : null;
    }

    function parseBidPriceCents(value) {
      if (typeof value !== "string") {
        return null;
      }

      const match = value.match(BID_PRICE_PATTERN);

      if (!match) {
        return null;
      }

      const dollars = Number(match[1].replace(/,/g, ""));
      const cents = Number((match[2] ?? "").padEnd(2, "0"));
      const bidPriceCents = dollars * 100 + cents;

      return Number.isSafeInteger(bidPriceCents) && bidPriceCents > 0
        ? bidPriceCents
        : null;
    }

    function requireBoundary(boundary) {
      if (!boundary || typeof boundary.querySelectorAll !== "function") {
        throw new TypeError("A queryable dashboard boundary is required.");
      }
    }

    function isInsideBoundary(node, boundary) {
      if (!node) {
        return false;
      }

      if (node === boundary) {
        return true;
      }

      if (typeof boundary.contains !== "function") {
        throw new TypeError("The dashboard boundary must support contains().");
      }

      return boundary.contains(node);
    }

    function readClassTokens(node) {
      const className =
        typeof node?.getAttribute === "function"
          ? node.getAttribute("class")
          : node?.className;

      return typeof className === "string"
        ? className.split(/\s+/).filter(Boolean)
        : [];
    }

    function isVisibleElement(node) {
      if (!node || typeof node.getBoundingClientRect !== "function") {
        return false;
      }

      if (
        node.hidden === true ||
        (typeof node.getAttribute === "function" &&
          node.getAttribute("aria-hidden") === "true")
      ) {
        return false;
      }

      const rect = node.getBoundingClientRect();

      return (
        Boolean(rect) &&
        Number.isFinite(rect.width) &&
        rect.width > 0 &&
        Number.isFinite(rect.height) &&
        rect.height > 0
      );
    }

    function result(status, root = null, variationNumber = null) {
      return Object.freeze({ root, status, variationNumber });
    }

    function auctionResult(
      status,
      root = null,
      variationNumber = null,
      bidPriceStatus = "not_found",
      bidPriceCents = null,
    ) {
      return Object.freeze({
        bidPriceCents,
        bidPriceStatus,
        root,
        status,
        variationNumber,
      });
    }

    function locateUniqueVisibleBiddingAuction(boundary) {
      requireBoundary(boundary);

      try {
        const visibleCards = [];

        for (const candidate of boundary.querySelectorAll(
          AUCTION_CARD_SELECTOR,
        )) {
          if (
            !isInsideBoundary(candidate, boundary) ||
            !readClassTokens(candidate).includes("auction-pin-card") ||
            !isVisibleElement(candidate)
          ) {
            continue;
          }

          visibleCards.push(candidate);

          if (visibleCards.length > 1) {
            return auctionResult("ambiguous");
          }
        }

        if (visibleCards.length === 0) {
          return auctionResult("not_found");
        }

        const card = visibleCards[0];
        const variationMatches = [];
        const bidPriceMatches = [];

        for (const candidate of card.querySelectorAll(
          OWN_TEXT_ELEMENT_SELECTOR,
        )) {
          if (
            !isInsideBoundary(candidate, card) ||
            !isVisibleElement(candidate)
          ) {
            continue;
          }

          const ownText = normalizeOwnText(candidate);
          const variationNumber = parseBiddingVariationNumber(ownText);

          if (variationNumber !== null) {
            variationMatches.push(variationNumber);
          }

          const bidPriceCents = parseBidPriceCents(ownText);

          if (bidPriceCents !== null) {
            bidPriceMatches.push(bidPriceCents);
          }
        }

        if (variationMatches.length > 1) {
          return auctionResult("ambiguous", card);
        }

        if (variationMatches.length !== 1) {
          return auctionResult("not_found", card);
        }

        const bidPriceStatus =
          bidPriceMatches.length === 0
            ? "not_found"
            : bidPriceMatches.length === 1
              ? "found"
              : "ambiguous";

        return auctionResult(
          "found",
          card,
          variationMatches[0],
          bidPriceStatus,
          bidPriceStatus === "found" ? bidPriceMatches[0] : null,
        );
      } catch {
        return auctionResult("unsafe", null, null, "unsafe");
      }
    }

    function locateUniqueVisibleBiddingVariation(boundary) {
      const located = locateUniqueVisibleBiddingAuction(boundary);

      return result(located.status, located.root, located.variationNumber);
    }

    return Object.freeze({
      AUCTION_CARD_SELECTOR,
      BID_PRICE_PATTERN,
      OWN_TEXT_ELEMENT_SELECTOR,
      VARIATION_PREFIX_PATTERN,
      locateUniqueVisibleBiddingAuction,
      locateUniqueVisibleBiddingVariation,
      normalizeOwnText,
      parseBidPriceCents,
      parseBiddingVariationNumber,
    });
  },
);
