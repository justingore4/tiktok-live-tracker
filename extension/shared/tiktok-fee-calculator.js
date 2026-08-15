(function initializeTikTokFeeCalculator(root, factory) {
  const calculator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = calculator;
  }

  root.TikTokLiveTrackerTikTokFeeCalculator = calculator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createTikTokFeeCalculator() {
    "use strict";

    const FEE_PERCENT = 6;
    const MAX_DISPLAY_LENGTH = 24;
    const EXACT_USD_PATTERN =
      /^\$(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}$/;
    const COMPACT_USD_PATTERN =
      /^\$(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB]$/;
    const COMPACT_DOLLAR_MULTIPLIERS = Object.freeze({
      K: 1_000n,
      M: 1_000_000n,
      B: 1_000_000_000n,
    });

    function parseAttributedGmvCents(display) {
      if (
        typeof display !== "string" ||
        display.length === 0 ||
        display.length > MAX_DISPLAY_LENGTH
      ) {
        return null;
      }

      if (EXACT_USD_PATTERN.test(display)) {
        const numeric = display.slice(1).replace(/,/g, "");
        const [dollars, cents] = numeric.split(".");

        return BigInt(dollars) * 100n + BigInt(cents);
      }

      if (!COMPACT_USD_PATTERN.test(display)) {
        return null;
      }

      const suffix = display.at(-1);
      const numeric = display.slice(1, -1);
      const [whole, fraction = ""] = numeric.split(".");
      const coefficient = BigInt(`${whole}${fraction}`);
      const fractionDivisor = 10n ** BigInt(fraction.length);

      return (
        coefficient *
        COMPACT_DOLLAR_MULTIPLIERS[suffix] *
        100n /
        fractionDivisor
      );
    }

    function roundPercentToWholeDollars(totalCents, percent) {
      const denominator = 10_000n;
      const numerator = totalCents * BigInt(percent);

      return (numerator + denominator / 2n) / denominator;
    }

    function formatApproximateDollars(dollars) {
      const isNegative = dollars < 0n;
      const absoluteDollars = isNegative ? -dollars : dollars;
      const grouped = absoluteDollars
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

      return `≈${isNegative ? "-" : ""}$${grouped}`;
    }

    function roundSignedRatioToWholeDollars(numerator, denominator) {
      const isNegative = numerator < 0n;
      const absoluteNumerator = isNegative ? -numerator : numerator;
      const rounded =
        (absoluteNumerator + denominator / 2n) / denominator;

      return isNegative ? -rounded : rounded;
    }

    function calculateSixPercentGmvFees(attributedGmvDisplay) {
      const totalGmvCents = parseAttributedGmvCents(attributedGmvDisplay);

      if (totalGmvCents === null) {
        return null;
      }

      const feesPaidDollars = roundPercentToWholeDollars(
        totalGmvCents,
        FEE_PERCENT,
      );
      const gmvAfterFeesDollars = roundPercentToWholeDollars(
        totalGmvCents,
        100 - FEE_PERCENT,
      );

      return Object.freeze({
        feesPaidDisplay: formatApproximateDollars(feesPaidDollars),
        gmvAfterFeesDisplay: formatApproximateDollars(gmvAfterFeesDollars),
      });
    }

    function calculateEstimatedProfitAfterFees(
      attributedGmvDisplay,
      costOfGoodsCents,
    ) {
      const totalGmvCents = parseAttributedGmvCents(attributedGmvDisplay);

      if (
        totalGmvCents === null ||
        !Number.isSafeInteger(costOfGoodsCents) ||
        costOfGoodsCents < 0
      ) {
        return null;
      }

      // Keep the 94% result unrounded until after exact COGS is subtracted.
      // The numerator is expressed over 10,000 units per whole dollar:
      // (GMV cents * 94 - COGS cents * 100) / 10,000.
      const profitNumerator =
        totalGmvCents * BigInt(100 - FEE_PERCENT) -
        BigInt(costOfGoodsCents) * 100n;
      const profitDollars = roundSignedRatioToWholeDollars(
        profitNumerator,
        10_000n,
      );

      return formatApproximateDollars(profitDollars);
    }

    return Object.freeze({
      FEE_PERCENT,
      calculateEstimatedProfitAfterFees,
      calculateSixPercentGmvFees,
    });
  },
);
