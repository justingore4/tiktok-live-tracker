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

    function orderInventoryGroupsByRecentMappedVariations(
      groups,
      variations,
    ) {
      if (!Array.isArray(groups)) {
        throw new TypeError("Inventory groups must be an array.");
      }

      if (!Array.isArray(variations)) {
        throw new TypeError("Variations must be an array.");
      }

      const groupIndexBySku = new Map();

      groups.forEach((group, groupIndex) => {
        if (!Array.isArray(group?.entries)) {
          return;
        }

        group.entries.forEach((entry) => {
          if (
            typeof entry?.sku === "string" &&
            !groupIndexBySku.has(entry.sku)
          ) {
            groupIndexBySku.set(entry.sku, groupIndex);
          }
        });
      });

      const latestEndedVariationByGroupIndex = new Map();

      variations.forEach((variation) => {
        if (
          variation?.recorded !== true ||
          variation?.bidding !== false ||
          typeof variation?.sku !== "string" ||
          !Number.isSafeInteger(variation.variationNumber) ||
          variation.variationNumber < 1
        ) {
          return;
        }

        const groupIndex = groupIndexBySku.get(variation.sku);

        if (groupIndex === undefined) {
          return;
        }

        const latestVariation =
          latestEndedVariationByGroupIndex.get(groupIndex);

        if (
          latestVariation === undefined ||
          variation.variationNumber > latestVariation
        ) {
          latestEndedVariationByGroupIndex.set(
            groupIndex,
            variation.variationNumber,
          );
        }
      });

      return groups
        .map((group, originalIndex) => ({
          group,
          originalIndex,
          latestEndedVariation:
            latestEndedVariationByGroupIndex.get(originalIndex) ?? null,
        }))
        .sort((left, right) => {
          if (left.latestEndedVariation === null) {
            return right.latestEndedVariation === null
              ? left.originalIndex - right.originalIndex
              : 1;
          }

          if (right.latestEndedVariation === null) {
            return -1;
          }

          return (
            right.latestEndedVariation - left.latestEndedVariation ||
            left.originalIndex - right.originalIndex
          );
        })
        .map(({ group }) => group);
    }

    function createInventoryGroupOrderController(options = {}) {
      const maxPinnedGroups = options.maxPinnedGroups ?? 9;

      if (!Number.isSafeInteger(maxPinnedGroups) || maxPinnedGroups < 1) {
        throw new TypeError(
          "The maximum pinned inventory group count must be a positive integer.",
        );
      }

      let endedVariationFacts = new Map();
      let pinnedGroupKeys = [];
      let historicalState = null;

      function createGroupLookups(groups) {
        const groupByKey = new Map();
        const groupKeyBySku = new Map();

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
          group.entries.forEach((entry) => {
            if (
              typeof entry?.sku === "string" &&
              !groupKeyBySku.has(entry.sku)
            ) {
              groupKeyBySku.set(entry.sku, group.key);
            }
          });
        });

        return { groupByKey, groupKeyBySku };
      }

      function reconcileOrderKeys(orderKeys, groups) {
        const availableKeys = new Set(groups.map((group) => group.key));
        const seenKeys = new Set();
        const reconciled = [];

        orderKeys.forEach((key) => {
          if (availableKeys.has(key) && !seenKeys.has(key)) {
            seenKeys.add(key);
            reconciled.push(key);
          }
        });

        groups.forEach((group) => {
          if (!seenKeys.has(group.key)) {
            seenKeys.add(group.key);
            reconciled.push(group.key);
          }
        });

        return reconciled;
      }

      function captureEndedVariationFacts(view) {
        view.variations.forEach((variation) => {
          if (
            variation?.recorded !== true ||
            variation?.bidding !== false ||
            !Number.isSafeInteger(variation.variationNumber) ||
            variation.variationNumber < 1 ||
            endedVariationFacts.has(variation.variationNumber)
          ) {
            return;
          }

          if (typeof variation.sku === "string") {
            endedVariationFacts.set(variation.variationNumber, variation.sku);
            return;
          }

          const isUnmappedCurrentLiveVariation =
            view.isReviewingHistory !== true &&
            variation.variationNumber === view.currentVariationNumber;

          if (!isUnmappedCurrentLiveVariation) {
            endedVariationFacts.set(variation.variationNumber, null);
          }
        });
      }

      function getLiveOrderKeys(groups) {
        const immutableEndedVariations = Array.from(
          endedVariationFacts,
          ([variationNumber, sku]) => ({
            variationNumber,
            recorded: true,
            bidding: false,
            sku,
          }),
        );

        const recentOrderKeys = orderInventoryGroupsByRecentMappedVariations(
          groups,
          immutableEndedVariations,
        ).map((group) => group.key);
        const availableGroupKeys = new Set(recentOrderKeys);

        pinnedGroupKeys = pinnedGroupKeys.filter(
          (groupKey) => availableGroupKeys.has(groupKey),
        );

        const pinnedKeySet = new Set(pinnedGroupKeys);

        return [
          ...pinnedGroupKeys,
          ...recentOrderKeys.filter((groupKey) => !pinnedKeySet.has(groupKey)),
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

        const { groupByKey, groupKeyBySku } = createGroupLookups(groups);

        captureEndedVariationFacts(view);
        const liveOrderKeys = getLiveOrderKeys(groups);

        if (view.isReviewingHistory !== true) {
          historicalState = null;
          return orderGroups(groupByKey, liveOrderKeys);
        }

        if (historicalState === null) {
          historicalState = {
            selectedVariationNumber: null,
            frozenOrderKeys: [...liveOrderKeys],
            historicalMappedGroupKey: null,
            mappedGroupKeyByVariationNumber: new Map(),
          };
        }

        historicalState.frozenOrderKeys = reconcileOrderKeys(
          historicalState.frozenOrderKeys,
          groups,
        );

        if (
          historicalState.selectedVariationNumber !==
          view.selectedVariationNumber
        ) {
          historicalState.selectedVariationNumber =
            view.selectedVariationNumber;

          if (
            historicalState.mappedGroupKeyByVariationNumber.has(
              view.selectedVariationNumber,
            )
          ) {
            historicalState.historicalMappedGroupKey =
              historicalState.mappedGroupKeyByVariationNumber.get(
                view.selectedVariationNumber,
              );
          } else {
            historicalState.historicalMappedGroupKey =
              typeof view.auction?.sku === "string"
                ? groupKeyBySku.get(view.auction.sku) ?? null
                : null;
            historicalState.mappedGroupKeyByVariationNumber.set(
              view.selectedVariationNumber,
              historicalState.historicalMappedGroupKey,
            );
          }
        }

        const historicalOrderKeys =
          historicalState.historicalMappedGroupKey === null
            ? historicalState.frozenOrderKeys
            : [
                historicalState.historicalMappedGroupKey,
                ...historicalState.frozenOrderKeys.filter(
                  (key) => key !== historicalState.historicalMappedGroupKey,
                ),
              ];

        return orderGroups(groupByKey, historicalOrderKeys);
      }

      function reset() {
        endedVariationFacts = new Map();
        pinnedGroupKeys = [];
        historicalState = null;
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
      if (!Array.isArray(group?.entries) || group.entries.length === 0) {
        return getStockDisplay({
          remainingQuantity: 0,
          availableToTagQuantity: 0,
          reservedQuantity: 0,
          oversoldQuantity: 0,
        });
      }

      const aggregate = group.entries.reduce(
        (totals, entry) => {
          const stock = getStockDisplay(entry);

          totals.remainingQuantity += Math.max(0, stock.remainingQuantity);
          totals.availableToTagQuantity +=
            stock.displayedAvailableToTagQuantity;
          totals.reservedQuantity += stock.reservedQuantity;
          totals.oversoldQuantity += stock.oversoldQuantity;

          return totals;
        },
        {
          remainingQuantity: 0,
          availableToTagQuantity: 0,
          reservedQuantity: 0,
          oversoldQuantity: 0,
        },
      );

      return getStockDisplay(aggregate);
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
      orderInventoryGroupsByRecentMappedVariations,
    };
  },
);
