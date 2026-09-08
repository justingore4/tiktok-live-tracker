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

    const LEGACY_RECOVERY_INVENTORY = Object.freeze([
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
        .normalize("NFC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
    }

    const inventorySizeCollator = new Intl.Collator("en-US", {
      numeric: true,
      sensitivity: "base",
    });

    function createInventoryGroupKey(item, style) {
      return JSON.stringify([
        normalizeSearchText(item),
        normalizeSearchText(style),
      ]);
    }

    function compareInventoryGroupEntries(left, right) {
      const sizeComparison = inventorySizeCollator.compare(
        String(left?.size ?? ""),
        String(right?.size ?? ""),
      );

      if (sizeComparison !== 0) {
        return sizeComparison;
      }

      return inventorySizeCollator.compare(
        String(left?.sku ?? ""),
        String(right?.sku ?? ""),
      );
    }

    function groupInventoryEntries(entries) {
      if (!Array.isArray(entries)) {
        throw new TypeError("Inventory entries must be an array.");
      }

      const groupsByKey = new Map();

      entries.forEach((entry) => {
        const key = createInventoryGroupKey(entry?.item, entry?.style);
        let group = groupsByKey.get(key);

        if (!group) {
          group = {
            key,
            item: entry?.item ?? "",
            style: entry?.style ?? "",
            entries: [],
          };
          groupsByKey.set(key, group);
        }

        group.entries.push(entry);
      });

      return [...groupsByKey.values()].map((group) => ({
        ...group,
        entries: [...group.entries].sort(compareInventoryGroupEntries),
      }));
    }

    function createInventoryGroupOrderController(options = {}) {
      const maxPinnedGroups = options.maxPinnedGroups ?? 9;

      if (!Number.isSafeInteger(maxPinnedGroups) || maxPinnedGroups < 1) {
        throw new TypeError(
          "The maximum pinned inventory group count must be a positive integer.",
        );
      }

      let pinnedGroupKeys = [];

      function createGroupLookup(groups) {
        const groupByKey = new Map();

        groups.forEach((group) => {
          if (
            typeof group?.key !== "string" ||
            !Array.isArray(group.entries)
          ) {
            throw new TypeError(
              "Inventory groups must contain a key and entries array.",
            );
          }

          groupByKey.set(group.key, group);
        });

        return groupByKey;
      }

      function getPinnedOrderKeys(groups) {
        const originalOrderKeys = groups.map((group) => group.key);
        const availableGroupKeys = new Set(originalOrderKeys);

        pinnedGroupKeys = pinnedGroupKeys.filter(
          (groupKey) => availableGroupKeys.has(groupKey),
        );

        const pinnedKeySet = new Set(pinnedGroupKeys);

        return [
          ...pinnedGroupKeys,
          ...originalOrderKeys.filter((groupKey) => !pinnedKeySet.has(groupKey)),
        ];
      }

      function validateMaxPinnedGroups(value) {
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new TypeError(
            "The maximum pinned inventory group count must be a positive integer.",
          );
        }

        return value;
      }

      function trimPinnedGroups(
        requestedMaxPinnedGroups = maxPinnedGroups,
      ) {
        const pinLimit = validateMaxPinnedGroups(requestedMaxPinnedGroups);
        const unpinnedGroupKeys = pinnedGroupKeys.slice(pinLimit);

        if (unpinnedGroupKeys.length > 0) {
          pinnedGroupKeys = pinnedGroupKeys.slice(0, pinLimit);
        }

        return Object.freeze({
          changed: unpinnedGroupKeys.length > 0,
          pinnedCount: pinnedGroupKeys.length,
          unpinnedGroupKeys: Object.freeze(unpinnedGroupKeys),
        });
      }

      function togglePinnedGroup(
        groupKey,
        requestedMaxPinnedGroups = maxPinnedGroups,
      ) {
        if (typeof groupKey !== "string" || groupKey.length === 0) {
          throw new TypeError("A pinned inventory group key is required.");
        }

        const pinLimit = validateMaxPinnedGroups(requestedMaxPinnedGroups);

        const pinnedIndex = pinnedGroupKeys.indexOf(groupKey);

        if (pinnedIndex >= 0) {
          pinnedGroupKeys.splice(pinnedIndex, 1);

          return Object.freeze({
            changed: true,
            pinned: false,
            limitReached: false,
            pinnedCount: pinnedGroupKeys.length,
            pinnedPosition: null,
          });
        }

        if (pinnedGroupKeys.length >= pinLimit) {
          return Object.freeze({
            changed: false,
            pinned: false,
            limitReached: true,
            pinnedCount: pinnedGroupKeys.length,
            pinnedPosition: null,
          });
        }

        pinnedGroupKeys.push(groupKey);

        return Object.freeze({
          changed: true,
          pinned: true,
          limitReached: false,
          pinnedCount: pinnedGroupKeys.length,
          pinnedPosition: pinnedGroupKeys.length,
        });
      }

      function isGroupPinned(groupKey) {
        return pinnedGroupKeys.includes(groupKey);
      }

      function orderGroups(groupByKey, orderKeys) {
        return orderKeys
          .map((key) => groupByKey.get(key))
          .filter(Boolean);
      }

      function order(groups, view) {
        if (!Array.isArray(groups)) {
          throw new TypeError("Inventory groups must be an array.");
        }

        if (!view || !Array.isArray(view.variations)) {
          throw new TypeError(
            "An inventory ordering view with variations is required.",
          );
        }

        const groupByKey = createGroupLookup(groups);
        return orderGroups(groupByKey, getPinnedOrderKeys(groups));
      }

      function reset() {
        pinnedGroupKeys = [];
      }

      return Object.freeze({
        isGroupPinned,
        order,
        reset,
        trimPinnedGroups,
        togglePinnedGroup,
      });
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

    function formatOversoldQuantity(oversoldQuantity) {
      return `Oversold by ${oversoldQuantity}`;
    }

    function joinStockLabels(primaryLabel, secondaryLabel) {
      return secondaryLabel
        ? `${primaryLabel} · ${secondaryLabel}`
        : primaryLabel;
    }

    function formatAvailableInventoryUnits(quantity) {
      return `${quantity} inventory unit${quantity === 1 ? "" : "s"} available to tag`;
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
          [entry.sku, entry.item, entry.style, entry.size].join(" "),
        ).split(" ");

        return searchTerms.every((term) =>
          searchableTerms.some((candidate) => candidate.startsWith(term)),
        );
      });
    }

    function filterInventoryGroups(groups, query) {
      if (!Array.isArray(groups)) {
        throw new TypeError("Inventory groups must be an array.");
      }

      const normalizedQuery = normalizeSearchText(query);

      if (!normalizedQuery) {
        return [...groups];
      }

      const searchTerms = normalizedQuery.split(" ");

      return groups.filter((group) => {
        const searchableTerms = normalizeSearchText([
          group?.item,
          group?.style,
          ...(group?.entries ?? []).flatMap((entry) => [
            entry?.sku,
            entry?.size,
          ]),
        ].join(" ")).split(" ");

        return searchTerms.every((term) =>
          searchableTerms.some((candidate) => candidate.startsWith(term)),
        );
      });
    }

    function getStockDisplay(entry) {
      const remainingQuantity = getRemainingQuantity(entry);
      const availableToTagQuantity = getAvailableToTagQuantity(entry);
      const displayedAvailableToTagQuantity = Math.max(
        0,
        availableToTagQuantity,
      );
      const reservedQuantity = Number.isSafeInteger(entry?.reservedQuantity)
        ? Math.max(0, entry.reservedQuantity)
        : 0;
      const reportedOversoldQuantity = Number.isSafeInteger(
        entry?.oversoldQuantity,
      )
        ? Math.max(0, entry.oversoldQuantity)
        : Math.max(0, -availableToTagQuantity);
      const primaryLabel = `${displayedAvailableToTagQuantity} left`;
      const secondaryLabel = [
        reservedQuantity > 0 ? formatPendingQuantity(reservedQuantity) : "",
        reportedOversoldQuantity > 0
          ? formatOversoldQuantity(reportedOversoldQuantity)
          : "",
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        state: reportedOversoldQuantity > 0
          ? "oversold"
          : displayedAvailableToTagQuantity <= 2
            ? "low_stock"
            : "available",
        label: joinStockLabels(primaryLabel, secondaryLabel),
        ariaLabel: [
          formatAvailableInventoryUnits(displayedAvailableToTagQuantity),
          reservedQuantity > 0
            ? formatPendingReservations(reservedQuantity)
            : "",
          reportedOversoldQuantity > 0
            ? formatOversoldQuantity(reportedOversoldQuantity).toLocaleLowerCase(
                "en-US",
              )
            : "",
        ]
          .filter(Boolean)
          .join(", "),
        primaryLabel,
        secondaryLabel,
        remainingQuantity,
        availableToTagQuantity,
        displayedAvailableToTagQuantity,
        reservedQuantity,
        oversoldQuantity: reportedOversoldQuantity,
      };
    }

    function getInventoryGroupStockDisplay(group) {
      const entries = Array.isArray(group?.entries) ? group.entries : [];
      const aggregate = entries.reduce(
        (totals, entry) => {
          const stock = getStockDisplay(entry);
          const baselineQuantity =
            entry?.quantityOnHandAtImport ?? entry?.quantityReceived ?? 0;

          if (Number.isSafeInteger(baselineQuantity) && baselineQuantity >= 0) {
            totals.quantityOnHandAtImport += baselineQuantity;
          }
          totals.remainingQuantity += Math.max(0, stock.remainingQuantity);
          totals.availableToTagQuantity +=
            stock.displayedAvailableToTagQuantity;
          totals.reservedQuantity += stock.reservedQuantity;
          totals.oversoldQuantity += stock.oversoldQuantity;

          return totals;
        },
        {
          quantityOnHandAtImport: 0,
          remainingQuantity: 0,
          availableToTagQuantity: 0,
          reservedQuantity: 0,
          oversoldQuantity: 0,
        },
      );

      const stock = getStockDisplay(aggregate);
      const primaryLabel =
        `${stock.displayedAvailableToTagQuantity}/${aggregate.quantityOnHandAtImport}`;

      return {
        ...stock,
        primaryLabel,
        label: joinStockLabels(primaryLabel, stock.secondaryLabel),
        ariaLabel:
          `${stock.ariaLabel}, starting baseline quantity ${aggregate.quantityOnHandAtImport}`,
      };
    }

    function getPreferredInventoryGroupEntry(
      group,
      { selectedSku = null, currentMappedSku = null, queuedSku = null } = {},
    ) {
      if (!Array.isArray(group?.entries)) {
        return null;
      }

      for (const sku of [selectedSku, currentMappedSku, queuedSku]) {
        if (typeof sku !== "string" || sku.trim() === "") {
          continue;
        }

        const entry = group.entries.find((candidate) => candidate.sku === sku);

        if (entry) {
          return entry;
        }
      }

      return null;
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

    function calculateAverageOrderValueCents(
      completedGmvCents,
      completedPaymentCount,
    ) {
      if (
        !Number.isSafeInteger(completedGmvCents) ||
        completedGmvCents < 0
      ) {
        throw new TypeError(
          "Gross Item Sales must be a nonnegative safe integer number of cents.",
        );
      }

      if (
        !Number.isSafeInteger(completedPaymentCount) ||
        completedPaymentCount < 0
      ) {
        throw new TypeError(
          "Completed payment count must be a nonnegative safe integer.",
        );
      }

      return completedPaymentCount === 0
        ? 0
        : Math.round(completedGmvCents / completedPaymentCount);
    }

    function formatGrossMarginPercentage(
      grossProfitCents,
      mappedRevenueCents,
    ) {
      if (!Number.isSafeInteger(grossProfitCents)) {
        throw new TypeError(
          "Gross profit must be a safe integer number of cents.",
        );
      }

      if (
        !Number.isSafeInteger(mappedRevenueCents) ||
        mappedRevenueCents < 0
      ) {
        throw new TypeError(
          "Mapped revenue must be a nonnegative safe integer number of cents.",
        );
      }

      if (mappedRevenueCents === 0) {
        return "—";
      }

      const percentage = (grossProfitCents / mappedRevenueCents) * 100;
      return `${percentage.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}%`;
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
      LEGACY_RECOVERY_INVENTORY,
      calculateAverageOrderValueCents,
      createInventoryGroupKey,
      createInventoryGroupOrderController,
      filterInventoryEntries,
      filterInventoryGroups,
      formatGrossMarginPercentage,
      formatUsdCents,
      getAvailableToTagQuantity,
      getInventoryGroupStockDisplay,
      getPreferredInventoryGroupEntry,
      getProfitDisplay,
      getRemainingQuantity,
      getStockDisplay,
      groupInventoryEntries,
      normalizeSearchText,
    };
  },
);
