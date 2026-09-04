(function initializeVariationSelectorViewModel(root, factory) {
  const viewModel = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = viewModel;
  }

  root.TikTokLiveTrackerVariationSelectorViewModel = viewModel;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createVariationSelectorViewModelModule() {
    "use strict";

    const WARNING_PAYMENT_STATUSES = new Set([
      "payment_processing",
      "payment_fixing",
    ]);

    function requireOption(option) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        throw new TypeError("A variation option is required.");
      }

      if (!Number.isSafeInteger(option.variationNumber) || option.variationNumber < 1) {
        throw new TypeError("The variation number must be a positive safe integer.");
      }

      return option;
    }

    function getPaymentTone(option) {
      if (option.bidding === true) {
        return "warning";
      }

      if (WARNING_PAYMENT_STATUSES.has(option.observedPaymentStatus)) {
        return "warning";
      }

      if (
        option.observedPaymentStatus === "payment_failed" ||
        option.observedPaymentStatus === "canceled"
      ) {
        return "danger";
      }

      if (option.observedPaymentStatus === "payment_complete") {
        return "success";
      }

      return "neutral";
    }

    function getPaymentLabel(option) {
      if (option.bidding === true) {
        return "bidding";
      }

      if (option.observedPaymentStatus === "payment_complete") {
        return "complete";
      }

      if (option.observedPaymentStatus === "payment_processing") {
        return "processing";
      }

      return String(
        option.observedPaymentStatusLabel ?? "Payment status unavailable",
      );
    }

    function createOptionDisplay(option, options = {}) {
      const normalizedOption = requireOption(option);
      const { formatItemName } = options;

      if (typeof formatItemName !== "function") {
        throw new TypeError("An item-name formatter is required.");
      }

      const mapped =
        typeof normalizedOption.item === "string" &&
        normalizedOption.item.trim() !== "";
      const paymentLabel = getPaymentLabel(normalizedOption);
      const itemLabel = mapped
        ? `${formatItemName(normalizedOption)}, size ${normalizedOption.size}`
        : "no selection";
      const variationLabel = `#${normalizedOption.variationNumber}`;

      return Object.freeze({
        variationNumber: normalizedOption.variationNumber,
        variationLabel,
        paymentLabel,
        paymentTone: getPaymentTone(normalizedOption),
        itemLabel,
        itemTone: mapped ? "success" : "unselected",
        fullLabel: `${variationLabel} - ${paymentLabel} - ${itemLabel}`,
      });
    }

    return Object.freeze({
      createOptionDisplay,
      getPaymentTone,
    });
  },
);
