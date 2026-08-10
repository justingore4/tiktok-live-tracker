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

    function locateUniqueVisibleBiddingVariation(boundary) {
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
            return result("ambiguous");
          }
        }

        if (visibleCards.length === 0) {
          return result("not_found");
        }

        const card = visibleCards[0];
        const matches = [];

        for (const candidate of card.querySelectorAll(
          OWN_TEXT_ELEMENT_SELECTOR,
        )) {
          if (
            !isInsideBoundary(candidate, card) ||
            !isVisibleElement(candidate)
          ) {
            continue;
          }

          const variationNumber = parseBiddingVariationNumber(
            normalizeOwnText(candidate),
          );

          if (variationNumber === null) {
            continue;
          }

          matches.push(variationNumber);

          if (matches.length > 1) {
            return result("ambiguous", card);
          }
        }

        if (matches.length !== 1) {
          return result("not_found", card);
        }

        return result("found", card, matches[0]);
      } catch {
        return result("unsafe");
      }
    }

    return Object.freeze({
      AUCTION_CARD_SELECTOR,
      OWN_TEXT_ELEMENT_SELECTOR,
      VARIATION_PREFIX_PATTERN,
      locateUniqueVisibleBiddingVariation,
      normalizeOwnText,
      parseBiddingVariationNumber,
    });
  },
);
