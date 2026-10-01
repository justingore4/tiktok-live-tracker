(function initializeSaleParser(root, factory) {
  const parser = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = parser;
  }

  root.TikTokLiveTrackerSaleParser = parser;
})(typeof globalThis === "undefined" ? this : globalThis, function createSaleParser() {
  "use strict";

  // SKU is an alternate auction label, not the seller's inventory SKU. Require
  // its complete numeric token so values such as "SKU: #38-XL" are not IDs.
  const VARIATION_PATTERN =
    /\b(?:Variation\s*:\s*#\s*(\d+)\b|SKU\s*:\s*#\s*(\d+)(?=\s|$))/gi;
  const SOLD_PRICE_PATTERN =
    /\bhas\s+won\s*:\s*\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
  const PAYMENT_COMPLETE_PATTERN = /\bPayment\s+complete\b/gi;
  const FLATTENED_COMPLETE_STATUS_PATTERN =
    /((?:Variation|SKU)\s*:\s*#\s*\d+)(?=Payment\s+complete\b)/gi;
  const FLATTENED_PRICE_LABEL_PATTERN =
    /(\$\s*[\d,.]+)(?=(?:Variation|SKU)\s*:)/gi;

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
    // siblings. TikTok can therefore flatten the exact auction label and
    // green payment badge into "#147Payment complete" even though they are
    // rendered on separate lines.
    const text = normalizeWhitespace(value).replace(
      FLATTENED_COMPLETE_STATUS_PATTERN,
      "$1 ",
    ).replace(FLATTENED_PRICE_LABEL_PATTERN, "$1 ");
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

    const variationNumber = Number(variationMatches[0][1] ?? variationMatches[0][2]);
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

  function parseProcessingItemText(value) {
    // Keep this auxiliary price stricter than the legacy completed-sale parser.
    // Only the row's explicit auction-winner amount is evidence, never a bid,
    // shipping charge, order total, or another arbitrary dollar amount.
    const text = normalizeWhitespace(value).replace(
      /((?:Variation|SKU)\s*:\s*#\s*\d+)(?=(?:Payment\s+(?:processing|fixing|failed)|Order\s+processing))/gi,
      "$1 ",
    ).replace(FLATTENED_PRICE_LABEL_PATTERN, "$1 ");
    const variations = [...text.matchAll(VARIATION_PATTERN)];
    const winners = [...text.matchAll(/\bhas\s+won\s*:/gi)];
    if (variations.length !== 1 || winners.length !== 1) return null;

    const amountText = text.slice(winners[0].index + winners[0][0].length);
    const amount = amountText.match(
      /^\s*\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?=\s|$|(?:Variation|SKU)\s*:)/i,
    );
    if (!amount) return null;
    const variationNumber = Number(variations[0][1] ?? variations[0][2]);
    const processingPriceCents = parseMoneyToCents(amount[1]);
    if (!Number.isSafeInteger(variationNumber) || variationNumber < 1 ||
        !Number.isSafeInteger(processingPriceCents) || processingPriceCents <= 0) {
      return null;
    }
    return { variationNumber, processingPriceCents };
  }

  return {
    normalizeWhitespace,
    parseMoneyToCents,
    parseProcessingItemText,
    parseSoldItemText,
  };
});
