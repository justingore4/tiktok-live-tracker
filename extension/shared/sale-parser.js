(function initializeSaleParser(root, factory) {
  const parser = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = parser;
  }

  root.TikTokLiveTrackerSaleParser = parser;
})(typeof globalThis === "undefined" ? this : globalThis, function createSaleParser() {
  "use strict";

  const VARIATION_PATTERN = /\bVariation\s*:\s*#\s*(\d+)\b/gi;
  const SOLD_PRICE_PATTERN =
    /\bhas\s+won\s*:\s*\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
  const PAYMENT_COMPLETE_PATTERN = /\bPayment\s+complete\b/gi;
  const FLATTENED_COMPLETE_STATUS_PATTERN =
    /(Variation\s*:\s*#\s*\d+)(?=Payment\s+complete\b)/gi;

  function normalizeWhitespace(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseMoneyToCents(value) {
    const normalized = String(value ?? "").replace(/,/g, "").trim();

    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
      return null;
    }

    const [wholePart, fractionalPart = ""] = normalized.split(".");
    const dollars = Number(wholePart);
    const cents = Number(fractionalPart.padEnd(2, "0"));
    const total = dollars * 100 + cents;

    return Number.isSafeInteger(total) ? total : null;
  }

  function parseSoldItemText(value) {
    // textContent does not insert whitespace between visually separate DOM
    // siblings. TikTok can therefore flatten the exact Variation label and
    // green payment badge into "#147Payment complete" even though they are
    // rendered on separate lines.
    const text = normalizeWhitespace(value).replace(
      FLATTENED_COMPLETE_STATUS_PATTERN,
      "$1 ",
    );
    const variationMatches = [...text.matchAll(VARIATION_PATTERN)];
    const priceMatches = [...text.matchAll(SOLD_PRICE_PATTERN)];
    const paymentCompleteMatches = [...text.matchAll(PAYMENT_COMPLETE_PATTERN)];

    if (
      variationMatches.length !== 1 ||
      priceMatches.length !== 1 ||
      paymentCompleteMatches.length > 1
    ) {
      return null;
    }

    const variationNumber = Number(variationMatches[0][1]);
    const soldPriceCents = parseMoneyToCents(priceMatches[0][1]);

    if (
      !Number.isSafeInteger(variationNumber) ||
      variationNumber < 1 ||
      soldPriceCents === null
    ) {
      return null;
    }

    return {
      variationNumber,
      soldPriceCents,
      paymentStatus: paymentCompleteMatches.length === 1
        ? "payment_complete"
        : "unknown",
    };
  }

  return {
    normalizeWhitespace,
    parseMoneyToCents,
    parseSoldItemText,
  };
});
