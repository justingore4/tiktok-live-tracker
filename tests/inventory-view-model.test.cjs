const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LEGACY_RECOVERY_INVENTORY,
  calculateAverageOrderValueCents,
  createInventoryGroupKey,
  createInventoryGroupOrderController,
  filterInventoryEntries,
  filterInventoryGroups,
  formatGrossMarginPercentage,
  formatUsdCents,
  getInventoryGroupStockDisplay,
  getPreferredInventoryGroupEntry,
  getProfitDisplay,
  getRemainingQuantity,
  getStockDisplay,
  groupInventoryEntries,
  normalizeSearchText,
  orderInventoryGroupsByRecentMappedVariations,
} = require("../extension/tagger/inventory-view-model.js");

const TEST_INVENTORY = LEGACY_RECOVERY_INVENTORY;

test("legacy recovery inventory contains unique stable SKUs", () => {
  const skus = TEST_INVENTORY.map((entry) => entry.sku);

  assert.equal(TEST_INVENTORY.length, 6);
  assert.equal(new Set(skus).size, TEST_INVENTORY.length);
  assert.ok(
    TEST_INVENTORY.every(
      (entry) =>
        entry.item &&
        entry.style &&
        entry.size &&
        Number.isSafeInteger(entry.quantityReceived) &&
        Number.isSafeInteger(entry.unitCostCents),
    ),
  );
});

test("normalizes capitalization and repeated whitespace for search", () => {
  assert.equal(normalizeSearchText("  Nike   HOODIE  "), "nike hoodie");
});

test("returns every inventory entry for a blank search", () => {
  const results = filterInventoryEntries(TEST_INVENTORY, "   ");

  assert.deepEqual(results, TEST_INVENTORY);
  assert.notEqual(results, TEST_INVENTORY);
});

test("filters by item and style using multiple search terms", () => {
  const results = filterInventoryEntries(TEST_INVENTORY, "nike grey");

  assert.deepEqual(
    results.map((entry) => entry.sku),
    ["NIKE-HOODIE-GREY-XL", "NIKE-HOODIE-GREY-L"],
  );
});

test("filters by size without matching letters inside another word", () => {
  const results = filterInventoryEntries(TEST_INVENTORY, "stussy l");

  assert.deepEqual(
    results.map((entry) => entry.sku),
    ["STUSSY-TEE-BLACK-L"],
  );
});

test("supports partial words and multi-word styles", () => {
  const results = filterInventoryEntries(TEST_INVENTORY, "den wash 32");

  assert.deepEqual(
    results.map((entry) => entry.sku),
    ["DENIM-SHORTS-WASHED-BLUE-32"],
  );
});

test("groups inventory by normalized item and style while preserving every size SKU", () => {
  const entries = [
    {
      sku: "RUNNER-BLACK-10",
      item: "Runner",
      style: "Core Black",
      size: "10",
      quantityReceived: 2,
      unitCostCents: 2200,
    },
    {
      sku: "RUNNER-BLACK-8",
      item: "Runner",
      style: "Core Black",
      size: "8",
      quantityReceived: 4,
      unitCostCents: 1800,
    },
    {
      sku: "RUNNER-WHITE-8",
      item: "Runner",
      style: "White",
      size: "8",
      quantityReceived: 1,
      unitCostCents: 1900,
    },
    {
      sku: "HOODIE-BLACK-M",
      item: "Hoodie",
      style: "Core Black",
      size: "M",
      quantityReceived: 3,
      unitCostCents: 2500,
    },
  ];
  const originalSkuOrder = entries.map((entry) => entry.sku);
  const groups = groupInventoryEntries(entries);

  assert.deepEqual(
    groups.map(({ item, style }) => ({ item, style })),
    [
      { item: "Runner", style: "Core Black" },
      { item: "Runner", style: "White" },
      { item: "Hoodie", style: "Core Black" },
    ],
  );
  assert.deepEqual(
    groups[0].entries.map(({ sku, size, unitCostCents }) => ({
      sku,
      size,
      unitCostCents,
    })),
    [
      { sku: "RUNNER-BLACK-8", size: "8", unitCostCents: 1800 },
      { sku: "RUNNER-BLACK-10", size: "10", unitCostCents: 2200 },
    ],
  );
  assert.deepEqual(
    entries.map((entry) => entry.sku),
    originalSkuOrder,
    "grouping must not reorder the per-SKU inventory input",
  );
});

test("normalizes only the item and style pair used as the inventory group key", () => {
  const composed = createInventoryGroupKey("  Caf\u00e9   Runner ", " CORE  BLACK ");
  const decomposed = createInventoryGroupKey(
    "cafe\u0301 runner",
    "core black",
  );

  assert.equal(composed, decomposed);
  assert.notEqual(
    composed,
    createInventoryGroupKey("Caf\u00e9 Runner", "Core White"),
  );
  assert.notEqual(
    composed,
    createInventoryGroupKey("Caf\u00e9 Hoodie", "Core Black"),
  );
});

test("keeps Sheet order until ended mapped variations establish recent-item order", () => {
  const groups = groupInventoryEntries([
    {
      sku: "KOREA-TEE-OS",
      item: "Korea",
      style: "tee",
      size: "OS",
    },
    {
      sku: "RUNNER-BLACK-8",
      item: "Runner",
      style: "black",
      size: "8",
    },
    {
      sku: "RUNNER-BLACK-9",
      item: "Runner",
      style: "black",
      size: "9",
    },
    {
      sku: "SOCCER-TEE-OS",
      item: "Soccer",
      style: "tee",
      size: "OS",
    },
    {
      sku: "STUSSY-TEE-OS",
      item: "Stussy",
      style: "tee",
      size: "OS",
    },
  ]);
  const originalGroups = [...groups];

  const initialOrder = orderInventoryGroupsByRecentMappedVariations(
    groups,
    [],
  );

  assert.deepEqual(initialOrder, groups);
  assert.notEqual(initialOrder, groups);

  const recentOrder = orderInventoryGroupsByRecentMappedVariations(groups, [
    {
      variationNumber: 104,
      recorded: true,
      bidding: false,
      sku: "RUNNER-BLACK-8",
      observedPaymentStatus: "payment_processing",
    },
    {
      variationNumber: 106,
      recorded: true,
      bidding: true,
      sku: "STUSSY-TEE-OS",
      observedPaymentStatus: "not_observed",
    },
    {
      variationNumber: 103,
      recorded: true,
      bidding: false,
      sku: "RUNNER-BLACK-9",
      observedPaymentStatus: "payment_complete",
    },
    {
      variationNumber: 105,
      recorded: true,
      bidding: false,
      sku: "SOCCER-TEE-OS",
      observedPaymentStatus: "canceled",
    },
    {
      variationNumber: 107,
      recorded: false,
      bidding: false,
      sku: "KOREA-TEE-OS",
      observedPaymentStatus: "not_observed",
    },
    {
      variationNumber: 108,
      recorded: true,
      bidding: false,
      sku: "UNKNOWN-SKU",
      observedPaymentStatus: "payment_failed",
    },
    {
      variationNumber: 109,
      recorded: true,
      sku: "KOREA-TEE-OS",
      observedPaymentStatus: "payment_complete",
    },
  ]);

  assert.deepEqual(
    recentOrder.map((group) => group.item),
    ["Soccer", "Runner", "Korea", "Stussy"],
  );
  assert.equal(
    recentOrder.filter((group) => group.item === "Runner").length,
    1,
    "multiple sizes and repeat sales must keep one grouped card",
  );
  assert.deepEqual(groups, originalGroups, "ordering must not mutate groups");
});

test("moves a mapped item only after its recorded bid is no longer active", () => {
  const groups = groupInventoryEntries([
    { sku: "FIRST", item: "First", style: "one", size: "OS" },
    { sku: "SECOND", item: "Second", style: "two", size: "OS" },
  ]);
  const currentVariation = {
    variationNumber: 200,
    recorded: true,
    bidding: true,
    sku: "SECOND",
    observedPaymentStatus: "not_observed",
  };

  assert.deepEqual(
    orderInventoryGroupsByRecentMappedVariations(
      groups,
      [currentVariation],
    ).map((group) => group.item),
    ["First", "Second"],
  );
  assert.deepEqual(
    orderInventoryGroupsByRecentMappedVariations(
      groups,
      [{ ...currentVariation, bidding: false }],
    ).map((group) => group.item),
    ["Second", "First"],
  );
});

test("each newly ended mapped item moves ahead of the prior recent item", () => {
  const groups = groupInventoryEntries([
    { sku: "FIRST", item: "First", style: "one", size: "OS" },
    { sku: "SECOND", item: "Second", style: "two", size: "OS" },
    { sku: "THIRD", item: "Third", style: "three", size: "OS" },
  ]);
  const variations = [];
  const endMappedVariation = (variationNumber, sku, paymentStatus) => {
    variations.push({
      variationNumber,
      recorded: true,
      bidding: false,
      sku,
      observedPaymentStatus: paymentStatus,
    });

    return orderInventoryGroupsByRecentMappedVariations(
      groups,
      variations,
    ).map((group) => group.item);
  };

  assert.deepEqual(
    endMappedVariation(101, "SECOND", "payment_processing"),
    ["Second", "First", "Third"],
  );
  assert.deepEqual(
    endMappedVariation(102, "THIRD", "canceled"),
    ["Third", "Second", "First"],
  );
  assert.deepEqual(
    endMappedVariation(103, "SECOND", "payment_complete"),
    ["Second", "Third", "First"],
  );
});

test("recent-item ordering validates only its array boundaries", () => {
  assert.throws(
    () => orderInventoryGroupsByRecentMappedVariations(null, []),
    /Inventory groups must be an array/,
  );
  assert.throws(
    () => orderInventoryGroupsByRecentMappedVariations([], null),
    /Variations must be an array/,
  );
});

test("historical inventory order freezes and pins the mapping present on entry", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const endedVariations = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "B" },
    { variationNumber: 101, recorded: true, bidding: false, sku: "C" },
  ];
  const orderNames = (view) =>
    controller.order(groups, view).map((group) => group.item);

  assert.deepEqual(
    orderNames({
      variations: endedVariations,
      selectedVariationNumber: 101,
      isReviewingHistory: false,
      auction: { sku: "C" },
    }),
    ["Charlie", "Bravo", "Alpha", "Delta"],
  );
  assert.deepEqual(
    orderNames({
      variations: endedVariations,
      selectedVariationNumber: 100,
      isReviewingHistory: true,
      auction: { sku: "B" },
    }),
    ["Bravo", "Charlie", "Alpha", "Delta"],
  );

  const correctedHistoricalVariations = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "D" },
    endedVariations[1],
  ];

  assert.deepEqual(
    orderNames({
      variations: correctedHistoricalVariations,
      selectedVariationNumber: 100,
      isReviewingHistory: true,
      auction: { sku: "D" },
    }),
    ["Bravo", "Charlie", "Alpha", "Delta"],
    "changing the open historical mapping must not replace its pinned card",
  );
  assert.deepEqual(
    orderNames({
      variations: correctedHistoricalVariations,
      selectedVariationNumber: 101,
      isReviewingHistory: true,
      auction: { sku: "C" },
    }),
    ["Charlie", "Bravo", "Alpha", "Delta"],
    "switching historical variations must pin the newly viewed mapping",
  );
  assert.deepEqual(
    orderNames({
      variations: correctedHistoricalVariations,
      selectedVariationNumber: 100,
      isReviewingHistory: true,
      auction: { sku: "D" },
    }),
    ["Bravo", "Charlie", "Alpha", "Delta"],
    "returning to a corrected historical variation must restore its original pin",
  );
  assert.deepEqual(
    orderNames({
      variations: correctedHistoricalVariations,
      selectedVariationNumber: 99,
      isReviewingHistory: true,
      auction: { sku: null },
    }),
    ["Charlie", "Bravo", "Alpha", "Delta"],
    "an unmapped historical variation must use the frozen live order",
  );
});

test("live bids update recent order only after ending while history stays frozen", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const baseVariations = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "B" },
    { variationNumber: 101, recorded: true, bidding: false, sku: "C" },
  ];
  const historicalView = {
    variations: baseVariations,
    selectedVariationNumber: 100,
    isReviewingHistory: true,
    auction: { sku: "B" },
  };
  const orderNames = (view) =>
    controller.order(groups, view).map((group) => group.item);

  orderNames({
    ...historicalView,
    selectedVariationNumber: 101,
    isReviewingHistory: false,
    auction: { sku: "C" },
  });
  assert.deepEqual(orderNames(historicalView), [
    "Bravo",
    "Charlie",
    "Alpha",
    "Delta",
  ]);

  const biddingWhileReviewing = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "A" },
    baseVariations[1],
    { variationNumber: 102, recorded: true, bidding: true, sku: "D" },
  ];

  assert.deepEqual(
    orderNames({
      ...historicalView,
      variations: biddingWhileReviewing,
      auction: { sku: "A" },
    }),
    ["Bravo", "Charlie", "Alpha", "Delta"],
    "historical and current-bidding mapping changes must not move cards",
  );

  const endedWhileReviewing = biddingWhileReviewing.map((variation) =>
    variation.variationNumber === 102
      ? { ...variation, bidding: false }
      : variation,
  );

  assert.deepEqual(
    orderNames({
      ...historicalView,
      variations: endedWhileReviewing,
      auction: { sku: "A" },
    }),
    ["Bravo", "Charlie", "Alpha", "Delta"],
    "a real bid ending must not disturb the frozen historical screen",
  );
  assert.deepEqual(
    orderNames({
      variations: endedWhileReviewing,
      selectedVariationNumber: 102,
      isReviewingHistory: false,
      auction: { sku: "D" },
    }),
    ["Delta", "Charlie", "Bravo", "Alpha"],
    "returning live must apply the real ended bid but ignore historical edits",
  );

  controller.reset();
  assert.deepEqual(
    orderNames({
      variations: [],
      selectedVariationNumber: 203,
      isReviewingHistory: false,
      auction: null,
    }),
    ["Alpha", "Bravo", "Charlie", "Delta"],
  );
});

test("late older variations keep numeric recency instead of arrival order", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const orderNames = (variations) =>
    controller.order(groups, {
      variations,
      currentVariationNumber: 102,
      selectedVariationNumber: 102,
      isReviewingHistory: false,
      auction: { sku: "D" },
    }).map((group) => group.item);
  const initiallyCaptured = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "B" },
    { variationNumber: 102, recorded: true, bidding: false, sku: "D" },
  ];

  assert.deepEqual(orderNames(initiallyCaptured), [
    "Delta",
    "Bravo",
    "Alpha",
    "Charlie",
  ]);
  assert.deepEqual(
    orderNames([
      ...initiallyCaptured,
      { variationNumber: 101, recorded: true, bidding: false, sku: "C" },
    ]),
    ["Delta", "Charlie", "Bravo", "Alpha"],
    "a late variation must be inserted by variation number, not moved to first",
  );
});

test("live late mapping is accepted while historical late mapping stays excluded", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
  ]);
  const liveController = createInventoryGroupOrderController();
  const endedUnmapped = {
    variationNumber: 200,
    recorded: true,
    bidding: false,
    sku: null,
  };
  const createView = (overrides = {}) => ({
    variations: [endedUnmapped],
    currentVariationNumber: 200,
    selectedVariationNumber: 200,
    isReviewingHistory: false,
    auction: { sku: null },
    ...overrides,
  });
  const orderNames = (controller, view) =>
    controller.order(groups, view).map((group) => group.item);

  assert.deepEqual(
    orderNames(liveController, createView()),
    ["Alpha", "Bravo"],
  );
  assert.deepEqual(
    orderNames(liveController, createView({
      variations: [{ ...endedUnmapped, sku: "B" }],
      auction: { sku: "B" },
    })),
    ["Bravo", "Alpha"],
    "an ended current item mapped before leaving live view should become recent",
  );

  const historicalController = createInventoryGroupOrderController();
  assert.deepEqual(
    orderNames(historicalController, createView({
      isReviewingHistory: true,
    })),
    ["Alpha", "Bravo"],
  );
  assert.deepEqual(
    orderNames(historicalController, createView({
      variations: [{ ...endedUnmapped, sku: "B" }],
      isReviewingHistory: true,
      auction: { sku: "B" },
    })),
    ["Alpha", "Bravo"],
    "mapping the same open historical variation must not change its pin",
  );
  assert.deepEqual(
    orderNames(historicalController, createView({
      variations: [{ ...endedUnmapped, sku: "B" }],
      auction: { sku: "B" },
    })),
    ["Alpha", "Bravo"],
    "the historical mapping must not affect live recent order after returning",
  );
});

test("user pins stay ahead of sale recency in the order they were pinned", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const groupKey = (item) =>
    groups.find((group) => group.item === item).key;
  const createLiveView = (variations) => ({
    variations,
    currentVariationNumber: 102,
    selectedVariationNumber: 102,
    isReviewingHistory: false,
    auction: { sku: "B" },
  });
  const endedVariations = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "B" },
    { variationNumber: 101, recorded: true, bidding: false, sku: "C" },
  ];
  const orderNames = (variations = endedVariations) =>
    controller.order(groups, createLiveView(variations))
      .map((group) => group.item);

  assert.deepEqual(orderNames(), ["Charlie", "Bravo", "Alpha", "Delta"]);
  assert.deepEqual(controller.togglePinnedGroup(groupKey("Alpha")), {
    changed: true,
    pinned: true,
    limitReached: false,
    pinnedCount: 1,
    pinnedPosition: 1,
  });
  assert.deepEqual(orderNames(), ["Alpha", "Charlie", "Bravo", "Delta"]);
  assert.equal(controller.isGroupPinned(groupKey("Alpha")), true);

  assert.equal(
    controller.togglePinnedGroup(groupKey("Delta")).pinnedPosition,
    2,
  );
  assert.deepEqual(orderNames(), ["Alpha", "Delta", "Charlie", "Bravo"]);
  assert.deepEqual(
    orderNames([
      ...endedVariations,
      { variationNumber: 102, recorded: true, bidding: false, sku: "B" },
    ]),
    ["Alpha", "Delta", "Bravo", "Charlie"],
    "new sales must reorder only the unpinned cards",
  );

  assert.equal(controller.togglePinnedGroup(groupKey("Alpha")).pinned, false);
  assert.deepEqual(
    orderNames([
      ...endedVariations,
      { variationNumber: 102, recorded: true, bidding: false, sku: "B" },
    ]),
    ["Delta", "Bravo", "Charlie", "Alpha"],
    "an unpinned card must return to its actual sale-recency position",
  );

  controller.reset();
  assert.equal(controller.isGroupPinned(groupKey("Delta")), false);
  assert.deepEqual(orderNames([]), ["Alpha", "Bravo", "Charlie", "Delta"]);
});

test("inventory pins enforce a strict nine-item limit", () => {
  const groups = groupInventoryEntries(
    Array.from({ length: 10 }, (_, index) => ({
      sku: `SKU-${index + 1}`,
      item: `Item ${index + 1}`,
      style: "style",
      size: "OS",
    })),
  );
  const controller = createInventoryGroupOrderController({
    maxPinnedGroups: 9,
  });
  const reverseKeys = [...groups].reverse().map((group) => group.key);

  reverseKeys.slice(0, 9).forEach((groupKey, index) => {
    const result = controller.togglePinnedGroup(groupKey);

    assert.equal(result.pinned, true);
    assert.equal(result.pinnedPosition, index + 1);
  });

  assert.deepEqual(controller.togglePinnedGroup(reverseKeys[9]), {
    changed: false,
    pinned: false,
    limitReached: true,
    pinnedCount: 9,
    pinnedPosition: null,
  });
  assert.equal(controller.isGroupPinned(reverseKeys[9]), false);
  assert.deepEqual(
    controller.order(groups, {
      variations: [],
      currentVariationNumber: null,
      selectedVariationNumber: null,
      isReviewingHistory: false,
      auction: null,
    }).map((group) => group.key),
    reverseKeys,
  );
  assert.throws(
    () => createInventoryGroupOrderController({ maxPinnedGroups: 0 }),
    /maximum pinned inventory group count must be a positive integer/i,
  );
  assert.throws(
    () => controller.togglePinnedGroup(""),
    /pinned inventory group key is required/i,
  );
});

test("expanded inventory can pin every item and collapsing keeps only the first nine pins", () => {
  const groups = groupInventoryEntries(
    Array.from({ length: 12 }, (_, index) => ({
      sku: `SKU-${index + 1}`,
      item: `Item ${index + 1}`,
      style: "style",
      size: "OS",
    })),
  );
  const controller = createInventoryGroupOrderController({
    maxPinnedGroups: 9,
  });
  const groupKeys = groups.map((group) => group.key);

  groupKeys.forEach((groupKey, index) => {
    const result = controller.togglePinnedGroup(groupKey, groups.length);

    assert.equal(result.pinned, true);
    assert.equal(result.pinnedPosition, index + 1);
  });

  assert.deepEqual(
    controller.order(groups, {
      variations: [],
      currentVariationNumber: null,
      selectedVariationNumber: null,
      isReviewingHistory: false,
      auction: null,
    }).map((group) => group.key),
    groupKeys,
    "every item may remain pinned while the list is expanded",
  );

  const trimmed = controller.trimPinnedGroups(9);

  assert.deepEqual(trimmed, {
    changed: true,
    pinnedCount: 9,
    unpinnedGroupKeys: groupKeys.slice(9),
  });
  assert.deepEqual(
    groupKeys.map((groupKey) => controller.isGroupPinned(groupKey)),
    [...Array(9).fill(true), false, false, false],
  );
  assert.deepEqual(
    controller.order(groups, {
      variations: [
        {
          variationNumber: 100,
          recorded: true,
          bidding: false,
          sku: "SKU-10",
        },
        {
          variationNumber: 101,
          recorded: true,
          bidding: false,
          sku: "SKU-11",
        },
      ],
      currentVariationNumber: 101,
      selectedVariationNumber: 101,
      isReviewingHistory: false,
      auction: { sku: "SKU-11" },
    }).map((group) => group.key),
    [...groupKeys.slice(0, 9), groupKeys[10], groupKeys[9], groupKeys[11]],
    "pins removed by collapsing must return to recent-sale and Sheet order",
  );
  assert.deepEqual(controller.trimPinnedGroups(9), {
    changed: false,
    pinnedCount: 9,
    unpinnedGroupKeys: [],
  });
  assert.throws(
    () => controller.togglePinnedGroup(groupKeys[9], 0),
    /maximum pinned inventory group count must be a positive integer/i,
  );
  assert.throws(
    () => controller.trimPinnedGroups(0),
    /maximum pinned inventory group count must be a positive integer/i,
  );
});

test("historical mapping stays first ahead of the frozen pin-aware live order", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const groupKey = (item) =>
    groups.find((group) => group.item === item).key;
  const variations = [
    { variationNumber: 100, recorded: true, bidding: false, sku: "B" },
    { variationNumber: 101, recorded: true, bidding: false, sku: "C" },
  ];
  const orderNames = (view) =>
    controller.order(groups, view).map((group) => group.item);

  controller.togglePinnedGroup(groupKey("Alpha"));
  controller.togglePinnedGroup(groupKey("Delta"));

  const liveView = {
    variations,
    currentVariationNumber: 101,
    selectedVariationNumber: 101,
    isReviewingHistory: false,
    auction: { sku: "C" },
  };

  assert.deepEqual(orderNames(liveView), ["Alpha", "Delta", "Charlie", "Bravo"]);

  const historicalView = {
    ...liveView,
    selectedVariationNumber: 100,
    isReviewingHistory: true,
    auction: { sku: "B" },
  };

  assert.deepEqual(
    orderNames(historicalView),
    ["Bravo", "Alpha", "Delta", "Charlie"],
    "the historical mapping must lead without duplicating its frozen card",
  );

  controller.togglePinnedGroup(groupKey("Charlie"));
  controller.togglePinnedGroup(groupKey("Alpha"));
  assert.deepEqual(
    orderNames(historicalView),
    ["Bravo", "Alpha", "Delta", "Charlie"],
    "pin changes must not disturb the open historical order",
  );
  assert.deepEqual(
    orderNames(liveView),
    ["Delta", "Charlie", "Bravo", "Alpha"],
    "returning live must apply pin changes ahead of current recency",
  );
});

test("sorts numeric sizes naturally within a grouped item", () => {
  const group = groupInventoryEntries(
    [10, 7, 9, 8].map((size) => ({
      sku: `RUNNER-${size}`,
      item: "Runner",
      style: "Black",
      size: String(size),
      quantityReceived: 1,
      unitCostCents: 1000 + size,
    })),
  )[0];

  assert.deepEqual(
    group.entries.map((entry) => entry.size),
    ["7", "8", "9", "10"],
  );
  assert.deepEqual(
    group.entries.map((entry) => entry.sku),
    ["RUNNER-7", "RUNNER-8", "RUNNER-9", "RUNNER-10"],
  );
});

test("group search matches item, style, any size, and any underlying SKU", () => {
  const groups = groupInventoryEntries([
    {
      sku: "RUNNER-BLACK-8",
      item: "Runner",
      style: "Core Black",
      size: "8",
      quantityReceived: 4,
      unitCostCents: 1800,
    },
    {
      sku: "RUNNER-BLACK-10",
      item: "Runner",
      style: "Core Black",
      size: "10",
      quantityReceived: 2,
      unitCostCents: 2200,
    },
    {
      sku: "HOODIE-GREY-M",
      item: "Hoodie",
      style: "Heather Grey",
      size: "M",
      quantityReceived: 3,
      unitCostCents: 2500,
    },
  ]);
  const runnerSkus = ["RUNNER-BLACK-8", "RUNNER-BLACK-10"];

  for (const query of [
    "runner",
    "core black",
    "10",
    "runner-black-8",
  ]) {
    const results = filterInventoryGroups(groups, query);

    assert.equal(results.length, 1, `expected one group for ${query}`);
    assert.deepEqual(
      results[0].entries.map((entry) => entry.sku),
      runnerSkus,
      `matching ${query} must retain every size in the group`,
    );
  }

  const blankResults = filterInventoryGroups(groups, "   ");

  assert.deepEqual(blankResults, groups);
  assert.notEqual(blankResults, groups);
});

test("aggregates grouped stock without one oversold size hiding other available sizes", () => {
  const group = groupInventoryEntries([
    {
      sku: "RUNNER-7",
      item: "Runner",
      style: "Black",
      size: "7",
      remainingQuantity: 5,
      availableToTagQuantity: 4,
      reservedQuantity: 1,
      oversoldQuantity: 0,
    },
    {
      sku: "RUNNER-8",
      item: "Runner",
      style: "Black",
      size: "8",
      remainingQuantity: 0,
      availableToTagQuantity: -1,
      reservedQuantity: 1,
      oversoldQuantity: 1,
    },
    {
      sku: "RUNNER-10",
      item: "Runner",
      style: "Black",
      size: "10",
      remainingQuantity: 2,
      availableToTagQuantity: 2,
      reservedQuantity: 0,
      oversoldQuantity: 0,
    },
  ])[0];
  const stock = getInventoryGroupStockDisplay(group);

  assert.equal(stock.remainingQuantity, 7);
  assert.equal(stock.availableToTagQuantity, 6);
  assert.equal(stock.displayedAvailableToTagQuantity, 6);
  assert.equal(stock.reservedQuantity, 2);
  assert.equal(stock.oversoldQuantity, 1);
  assert.equal(stock.state, "oversold");
  assert.equal(stock.primaryLabel, "6 left");
  assert.match(stock.secondaryLabel, /2 pending/);
  assert.match(stock.secondaryLabel, /Oversold by 1/);
});

test("prefers the viewed selection, then current mapping, then queued size", () => {
  const group = groupInventoryEntries([
    {
      sku: "RUNNER-7",
      item: "Runner",
      style: "Black",
      size: "7",
    },
    {
      sku: "RUNNER-8",
      item: "Runner",
      style: "Black",
      size: "8",
    },
    {
      sku: "RUNNER-9",
      item: "Runner",
      style: "Black",
      size: "9",
    },
  ])[0];

  assert.equal(
    getPreferredInventoryGroupEntry(group, {
      selectedSku: "RUNNER-7",
      currentMappedSku: "RUNNER-8",
      queuedSku: "RUNNER-9",
    }).sku,
    "RUNNER-7",
  );
  assert.equal(
    getPreferredInventoryGroupEntry(group, {
      currentMappedSku: "RUNNER-8",
      queuedSku: "RUNNER-9",
    }).sku,
    "RUNNER-8",
  );
  assert.equal(
    getPreferredInventoryGroupEntry(group, { queuedSku: "RUNNER-9" }).sku,
    "RUNNER-9",
  );
  assert.equal(
    getPreferredInventoryGroupEntry(group, {
      selectedSku: "OTHER-SKU",
      currentMappedSku: "MISSING-SKU",
    }),
    null,
  );
});

test("derives available and low-stock labels without treating zero as sold out", () => {
  assert.deepEqual(getStockDisplay({ quantityReceived: 5 }), {
    state: "available",
    label: "5 left",
    ariaLabel: "5 inventory units available to tag",
    primaryLabel: "5 left",
    secondaryLabel: "",
    remainingQuantity: 5,
    availableToTagQuantity: 5,
    displayedAvailableToTagQuantity: 5,
    reservedQuantity: 0,
    oversoldQuantity: 0,
  });
  assert.deepEqual(getStockDisplay({ quantityReceived: 1 }), {
    state: "low_stock",
    label: "1 left",
    ariaLabel: "1 inventory unit available to tag",
    primaryLabel: "1 left",
    secondaryLabel: "",
    remainingQuantity: 1,
    availableToTagQuantity: 1,
    displayedAvailableToTagQuantity: 1,
    reservedQuantity: 0,
    oversoldQuantity: 0,
  });
  assert.deepEqual(getStockDisplay({ quantityReceived: 0 }), {
    state: "low_stock",
    label: "0 left",
    ariaLabel: "0 inventory units available to tag",
    primaryLabel: "0 left",
    secondaryLabel: "",
    remainingQuantity: 0,
    availableToTagQuantity: 0,
    displayedAvailableToTagQuantity: 0,
    reservedQuantity: 0,
    oversoldQuantity: 0,
  });
});

test("shows pending allocations in the available count and reports oversold quantity", () => {
  assert.deepEqual(
    getStockDisplay({
      remainingQuantity: 5,
      availableToTagQuantity: 4,
      reservedQuantity: 1,
      reservationShortfallQuantity: 0,
    }),
    {
      state: "available",
      label: "4 left · 1 pending",
      ariaLabel: "4 inventory units available to tag, 1 pending reservation",
      primaryLabel: "4 left",
      secondaryLabel: "1 pending",
      remainingQuantity: 5,
      availableToTagQuantity: 4,
      displayedAvailableToTagQuantity: 4,
      reservedQuantity: 1,
      oversoldQuantity: 0,
    },
  );
  assert.deepEqual(
    getStockDisplay({
      remainingQuantity: 1,
      availableToTagQuantity: 0,
      reservedQuantity: 1,
      reservationShortfallQuantity: 0,
    }),
    {
      state: "low_stock",
      label: "0 left · 1 pending",
      ariaLabel: "0 inventory units available to tag, 1 pending reservation",
      primaryLabel: "0 left",
      secondaryLabel: "1 pending",
      remainingQuantity: 1,
      availableToTagQuantity: 0,
      displayedAvailableToTagQuantity: 0,
      reservedQuantity: 1,
      oversoldQuantity: 0,
    },
  );
  assert.deepEqual(
    getStockDisplay({
      remainingQuantity: 1,
      availableToTagQuantity: -1,
      reservedQuantity: 2,
      reservationShortfallQuantity: 1,
    }),
    {
      state: "oversold",
      label: "0 left · 2 pending · Oversold by 1",
      ariaLabel:
        "0 inventory units available to tag, 2 pending reservations, oversold by 1",
      primaryLabel: "0 left",
      secondaryLabel: "2 pending · Oversold by 1",
      remainingQuantity: 1,
      availableToTagQuantity: -1,
      displayedAvailableToTagQuantity: 0,
      reservedQuantity: 2,
      oversoldQuantity: 1,
    },
  );
});

test("shows a reservation in available stock and removes pending after completion", () => {
  const beforeMapping = getStockDisplay({
    remainingQuantity: 5,
    availableToTagQuantity: 5,
    reservedQuantity: 0,
  });
  const whilePending = getStockDisplay({
    remainingQuantity: 5,
    availableToTagQuantity: 4,
    reservedQuantity: 1,
  });
  const afterPaymentComplete = getStockDisplay({
    remainingQuantity: 4,
    availableToTagQuantity: 4,
    reservedQuantity: 0,
  });

  assert.equal(beforeMapping.label, "5 left");
  assert.equal(beforeMapping.primaryLabel, "5 left");
  assert.equal(beforeMapping.secondaryLabel, "");
  assert.equal(whilePending.label, "4 left · 1 pending");
  assert.equal(whilePending.primaryLabel, "4 left");
  assert.equal(whilePending.secondaryLabel, "1 pending");
  assert.equal(whilePending.remainingQuantity, 5);
  assert.equal(whilePending.availableToTagQuantity, 4);
  assert.equal(afterPaymentComplete.label, "4 left");
  assert.equal(afterPaymentComplete.primaryLabel, "4 left");
  assert.equal(afterPaymentComplete.secondaryLabel, "");
  assert.equal(afterPaymentComplete.remainingQuantity, 4);
});

test("formats currency and positive, negative, and neutral gross profit", () => {
  assert.equal(formatUsdCents(4800), "$48.00");
  assert.equal(formatUsdCents(-400), "-$4.00");
  assert.deepEqual(getProfitDisplay(3600), {
    tone: "positive",
    label: "+$36.00 profit",
  });
  assert.deepEqual(getProfitDisplay(-400), {
    tone: "negative",
    label: "-$4.00 loss",
  });
  assert.deepEqual(getProfitDisplay(0), {
    tone: "neutral",
    label: "$0.00 profit",
  });
});

test("calculates AOV from Gross Item Sales and completed payments", () => {
  assert.equal(calculateAverageOrderValueCents(6799, 2), 3400);
  assert.equal(calculateAverageOrderValueCents(1000, 3), 333);
  assert.equal(calculateAverageOrderValueCents(0, 0), 0);
  assert.equal(
    formatUsdCents(calculateAverageOrderValueCents(0, 0)),
    "$0.00",
  );
});

test("rejects invalid AOV inputs", () => {
  assert.throws(
    () => calculateAverageOrderValueCents(-1, 1),
    /Gross Item Sales must be a nonnegative safe integer/,
  );
  assert.throws(
    () => calculateAverageOrderValueCents(100, -1),
    /Completed payment count must be a nonnegative safe integer/,
  );
});

test("formats mapped gross margin from mapped revenue", () => {
  assert.equal(formatGrossMarginPercentage(6050, 8000), "75.6%");
  assert.equal(formatGrossMarginPercentage(0, 2500), "0.0%");
  assert.equal(formatGrossMarginPercentage(-500, 2500), "-20.0%");
  assert.equal(formatGrossMarginPercentage(0, 0), "—");
});

test("rejects invalid mapped gross margin inputs", () => {
  assert.throws(
    () => formatGrossMarginPercentage(1.5, 100),
    /Gross profit must be a safe integer/,
  );
  assert.throws(
    () => formatGrossMarginPercentage(100, -1),
    /Mapped revenue must be a nonnegative safe integer/,
  );
});

test("prefers a calculated remaining quantity when one is available", () => {
  assert.equal(
    getRemainingQuantity({ quantityReceived: 5, remainingQuantity: 2 }),
    2,
  );
});
