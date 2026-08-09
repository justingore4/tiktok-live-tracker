(function initializeInventoryViewModel(root, factory) {
  const viewModel = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = viewModel;
  }

  root.TikTokLiveTrackerInventoryViewModel = viewModel;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createInventoryViewModel() {
    "use strict";

    const MOCK_INVENTORY = Object.freeze([
      Object.freeze({
        sku: "STUSSY-TEE-BLACK-L",
        item: "Stussy tee",
        style: "black",
        size: "L",
        quantityReceived: 5,
        unitCostCents: 1200,
      }),
      Object.freeze({
        sku: "STUSSY-TEE-BLACK-M",
        item: "Stussy tee",
        style: "black",
        size: "M",
        quantityReceived: 2,
        unitCostCents: 1200,
      }),
      Object.freeze({
        sku: "NIKE-HOODIE-GREY-XL",
        item: "Nike hoodie",
        style: "grey",
        size: "XL",
        quantityReceived: 3,
        unitCostCents: 1400,
      }),
      Object.freeze({
        sku: "NIKE-HOODIE-GREY-L",
        item: "Nike hoodie",
        style: "grey",
        size: "L",
        quantityReceived: 1,
        unitCostCents: 1400,
      }),
      Object.freeze({
        sku: "CARHARTT-JACKET-BROWN-M",
        item: "Carhartt jacket",
        style: "brown",
        size: "M",
        quantityReceived: 4,
        unitCostCents: 1800,
      }),
      Object.freeze({
        sku: "DENIM-SHORTS-WASHED-BLUE-32",
        item: "Denim shorts",
        style: "washed blue",
        size: "32",
        quantityReceived: 0,
        unitCostCents: 900,
      }),
    ]);

    function normalizeSearchText(value) {
      return String(value ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
    }

    function getRemainingQuantity(entry) {
      const quantity = entry?.remainingQuantity ?? entry?.quantityReceived ?? 0;

      return Number.isSafeInteger(quantity) ? quantity : 0;
    }

    function getAvailableToTagQuantity(entry) {
      const quantity =
        entry?.availableToTagQuantity ?? getRemainingQuantity(entry);

      return Number.isSafeInteger(quantity) ? quantity : 0;
    }

    function formatPendingQuantity(reservedQuantity) {
      return `${reservedQuantity} pending`;
    }

    function joinStockLabels(primaryLabel, secondaryLabel) {
      return secondaryLabel
        ? `${primaryLabel} · ${secondaryLabel}`
        : primaryLabel;
    }

    function formatInventoryUnits(quantity) {
      return `${quantity} inventory unit${quantity === 1 ? "" : "s"} left`;
    }

    function formatPendingReservations(quantity) {
      return `${quantity} pending reservation${quantity === 1 ? "" : "s"}`;
    }

    function filterInventoryEntries(entries, query) {
      if (!Array.isArray(entries)) {
        throw new TypeError("Inventory entries must be an array.");
      }

      const normalizedQuery = normalizeSearchText(query);

      if (!normalizedQuery) {
        return [...entries];
      }

      const searchTerms = normalizedQuery.split(" ");

      return entries.filter((entry) => {
        const searchableTerms = normalizeSearchText(
          [entry.item, entry.style, entry.size].join(" "),
        ).split(" ");

        return searchTerms.every((term) =>
          searchableTerms.some((candidate) => candidate.startsWith(term)),
        );
      });
    }

    function getStockDisplay(entry) {
      const remainingQuantity = getRemainingQuantity(entry);
      const availableToTagQuantity = getAvailableToTagQuantity(entry);
      const reservedQuantity = Number.isSafeInteger(entry?.reservedQuantity)
        ? entry.reservedQuantity
        : 0;
      const reservationShortfallQuantity = Number.isSafeInteger(
        entry?.reservationShortfallQuantity,
      )
        ? entry.reservationShortfallQuantity
        : 0;
      const primaryLabel = `${remainingQuantity} left`;

      if (reservationShortfallQuantity > 0) {
        const secondaryLabel = [
          reservedQuantity > 0 ? formatPendingQuantity(reservedQuantity) : "",
          `short by ${reservationShortfallQuantity}`,
        ]
          .filter(Boolean)
          .join(" · ");

        return {
          state: "over_reserved",
          label: joinStockLabels(primaryLabel, secondaryLabel),
          ariaLabel: [
            formatInventoryUnits(remainingQuantity),
            reservedQuantity > 0
              ? formatPendingReservations(reservedQuantity)
              : "",
            `short by ${reservationShortfallQuantity} unit${reservationShortfallQuantity === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(", "),
          primaryLabel,
          secondaryLabel,
          remainingQuantity,
          availableToTagQuantity,
          reservedQuantity,
        };
      }

      if (remainingQuantity <= 0) {
        const secondaryLabel = "Sold out";

        return {
          state: "sold_out",
          label: joinStockLabels(primaryLabel, secondaryLabel),
          ariaLabel: `${formatInventoryUnits(remainingQuantity)}, sold out`,
          primaryLabel,
          secondaryLabel,
          remainingQuantity,
          availableToTagQuantity,
          reservedQuantity,
        };
      }

      if (availableToTagQuantity <= 0) {
        const secondaryLabel = reservedQuantity > 0
          ? formatPendingQuantity(reservedQuantity)
          : "None available to tag";

        return {
          state: "fully_reserved",
          label: joinStockLabels(primaryLabel, secondaryLabel),
          ariaLabel: [
            formatInventoryUnits(remainingQuantity),
            reservedQuantity > 0
              ? formatPendingReservations(reservedQuantity)
              : "none available to tag",
          ].join(", "),
          primaryLabel,
          secondaryLabel,
          remainingQuantity,
          availableToTagQuantity,
          reservedQuantity,
        };
      }

      const secondaryLabel = reservedQuantity > 0
        ? formatPendingQuantity(reservedQuantity)
        : "";

      return {
        state: availableToTagQuantity <= 2 ? "low_stock" : "available",
        label: joinStockLabels(primaryLabel, secondaryLabel),
        ariaLabel: [
          formatInventoryUnits(remainingQuantity),
          reservedQuantity > 0
            ? formatPendingReservations(reservedQuantity)
            : "",
        ]
          .filter(Boolean)
          .join(", "),
        primaryLabel,
        secondaryLabel,
        remainingQuantity,
        availableToTagQuantity,
        reservedQuantity,
      };
    }

    function formatUsdCents(value) {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError("Currency value must be a safe integer number of cents.");
      }

      const absoluteValue = Math.abs(value);
      const dollars = Math.floor(absoluteValue / 100);
      const cents = String(absoluteValue % 100).padStart(2, "0");

      return `${value < 0 ? "-" : ""}$${dollars.toLocaleString("en-US")}.${cents}`;
    }

    function getProfitDisplay(value) {
      const formattedValue = formatUsdCents(value);

      if (value < 0) {
        return {
          tone: "negative",
          label: `${formattedValue} loss`,
        };
      }

      return {
        tone: value > 0 ? "positive" : "neutral",
        label: `${value > 0 ? "+" : ""}${formattedValue} profit`,
      };
    }

    return {
      MOCK_INVENTORY,
      filterInventoryEntries,
      formatUsdCents,
      getAvailableToTagQuantity,
      getProfitDisplay,
      getRemainingQuantity,
      getStockDisplay,
      normalizeSearchText,
    };
  },
);
