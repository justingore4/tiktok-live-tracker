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
  getInventoryGroupRanCount,
  getInventoryGroupStockDisplay,
  getPreferredInventoryGroupEntry,
  getProfitDisplay,
  getRanCountsBySku,
  getRemainingQuantity,
  getStockDisplay,
  groupInventoryEntries,
  normalizeSearchText,
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

test("inventory keeps original Sheet order through sales and payment changes", () => {
  const groups = groupInventoryEntries([
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B-8", item: "Bravo", style: "two", size: "8" },
    { sku: "B-9", item: "Bravo", style: "two", size: "9" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const originalGroups = structuredClone(groups);
  const controller = createInventoryGroupOrderController();
  const currentVariation = {
    variationNumber: 104,
    recorded: true,
    bidding: true,
    sku: "D",
    observedPaymentStatus: "not_observed",
  };
  const priorVariations = [
    { variationNumber: 102, recorded: true, bidding: false, sku: "B-8" },
    { variationNumber: 101, recorded: true, bidding: false, sku: "B-9" },
  ];
  const snapshots = [
    [],
    [currentVariation],
    [...priorVariations, currentVariation],
    ...[
      "not_observed",
      "payment_processing",
      "payment_complete",
      "payment_failed",
      "canceled",
    ].map((observedPaymentStatus) => [
      ...priorVariations,
      { ...currentVariation, bidding: false, observedPaymentStatus },
    ]),
    [
      { ...currentVariation, bidding: false },
      ...priorVariations,
      { variationNumber: 103, recorded: true, bidding: false, sku: "A" },
      { variationNumber: 105, recorded: true, bidding: false, sku: "D" },
      { variationNumber: 106, recorded: false, bidding: false, sku: "A" },
      { variationNumber: 107, recorded: true, bidding: false, sku: "UNKNOWN" },
    ],
  ];

  for (const variations of snapshots) {
    const view = {
      variations,
      currentVariationNumber: 104,
      selectedVariationNumber: 104,
      isReviewingHistory: false,
      auction: variations.find((variation) => variation.variationNumber === 104),
    };
    const originalView = structuredClone(view);
    const ordered = controller.order(groups, view);

    assert.deepEqual(ordered.map((group) => group.item), [
      "Charlie", "Alpha", "Bravo", "Delta",
    ]);
    assert.notEqual(ordered, groups, "ordering must return a new array");
    assert.deepEqual(ordered, groups);
    assert.equal(
      ordered.filter((group) => group.item === "Bravo").length,
      1,
      "repeat sales and multiple sizes must retain exactly one grouped card",
    );
    assert.deepEqual(view, originalView, "ordering must not mutate sales or selection");
    assert.deepEqual(groups, originalGroups, "ordering must not mutate inventory");
  }
});

test("current and historical mappings, remaps, unmaps, and selection never promote items", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const currentVariation = {
    variationNumber: 101,
    recorded: true,
    bidding: false,
    sku: "C",
  };

  for (const isReviewingHistory of [false, true, false]) {
    for (const sku of [null, "B", "D", null, "C"]) {
      for (const selectedVariationNumber of [100, 101, 99]) {
        const view = {
          variations: [
            { variationNumber: 100, recorded: true, bidding: false, sku },
            { ...currentVariation, sku: isReviewingHistory ? "C" : sku },
          ],
          currentVariationNumber: 101,
          selectedVariationNumber,
          isReviewingHistory,
          auction: { sku },
        };
        const originalView = structuredClone(view);

        assert.deepEqual(
          controller.order(groups, view).map((group) => group.item),
          ["Alpha", "Bravo", "Charlie", "Delta"],
          "neither viewing nor correcting an auction may reorder inventory",
        );
        assert.deepEqual(view, originalView, "the selected auction must remain unchanged");
        assert.ok(groups.every((group) => !controller.isGroupPinned(group.key)));
      }
    }
  }
});

test("selected and queued sizes retain their preference without changing group order", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B-8", item: "Bravo", style: "two", size: "8" },
    { sku: "B-9", item: "Bravo", style: "two", size: "9" },
  ]);
  const controller = createInventoryGroupOrderController();

  for (const isReviewingHistory of [false, true]) {
    for (const preferences of [
      { selectedSku: "B-8", currentMappedSku: "B-9", queuedSku: "B-9" },
      { currentMappedSku: "B-8", queuedSku: "B-9" },
      { queuedSku: "B-8" },
    ]) {
      const view = {
        variations: [],
        currentVariationNumber: 101,
        selectedVariationNumber: isReviewingHistory ? 100 : 101,
        isReviewingHistory,
        auction: { sku: preferences.currentMappedSku ?? null },
      };

      assert.equal(getPreferredInventoryGroupEntry(groups[1], preferences).sku, "B-8");
      assert.deepEqual(controller.order(groups, view), groups);
    }
  }
});

test("inventory ordering validates group and view boundaries", () => {
  const controller = createInventoryGroupOrderController();

  assert.throws(
    () => controller.order(null, { variations: [] }),
    /Inventory groups must be an array/,
  );
  for (const view of [undefined, null, {}, { variations: null }]) {
    assert.throws(
      () => controller.order([], view),
      /An inventory ordering view with variations is required/,
    );
  }
  for (const group of [null, {}, { key: 1, entries: [] }, { key: "A" }]) {
    assert.throws(
      () => controller.order([group], { variations: [] }),
      /Inventory groups must contain a key and entries array/,
    );
  }
});

test("inventory refresh follows current Sheet order and removes unavailable pins", () => {
  const groups = groupInventoryEntries([
    { sku: "A", item: "Alpha", style: "one", size: "OS" },
    { sku: "B", item: "Bravo", style: "two", size: "OS" },
    { sku: "C", item: "Charlie", style: "three", size: "OS" },
    { sku: "D", item: "Delta", style: "four", size: "OS" },
  ]);
  const controller = createInventoryGroupOrderController();
  const view = {
    variations: [{ variationNumber: 100, recorded: true, bidding: false, sku: "D" }],
    selectedVariationNumber: 100,
    isReviewingHistory: true,
    auction: { sku: "D" },
  };

  controller.togglePinnedGroup(groups[1].key);
  controller.togglePinnedGroup(groups[3].key);
  assert.deepEqual(
    controller.order(groups, view).map((group) => group.item),
    ["Bravo", "Delta", "Alpha", "Charlie"],
  );

  const refreshedGroups = [groups[2], groups[0], groups[3]];
  assert.deepEqual(
    controller.order(refreshedGroups, view).map((group) => group.item),
    ["Delta", "Charlie", "Alpha"],
    "remaining pins lead and unpinned inventory follows the refreshed Sheet",
  );
  assert.equal(controller.isGroupPinned(groups[1].key), false);
  assert.equal(controller.isGroupPinned(groups[3].key), true);
  assert.deepEqual(
    controller.order(groups, view).map((group) => group.item),
    ["Delta", "Alpha", "Bravo", "Charlie"],
    "a returning inventory group must not recover an unavailable pin",
  );
});

test("user pins lead in pin order and unpinning restores original inventory position", () => {
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

  assert.deepEqual(orderNames(), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.deepEqual(controller.togglePinnedGroup(groupKey("Alpha")), {
    changed: true,
    pinned: true,
    limitReached: false,
    pinnedCount: 1,
    pinnedPosition: 1,
  });
  assert.deepEqual(orderNames(), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.equal(controller.isGroupPinned(groupKey("Alpha")), true);

  assert.equal(
    controller.togglePinnedGroup(groupKey("Delta")).pinnedPosition,
    2,
  );
  assert.deepEqual(orderNames(), ["Alpha", "Delta", "Bravo", "Charlie"]);
  assert.deepEqual(
    orderNames([
      ...endedVariations,
      { variationNumber: 102, recorded: true, bidding: false, sku: "B" },
    ]),
    ["Alpha", "Delta", "Bravo", "Charlie"],
    "new sales must not reorder pinned or unpinned cards",
  );

  assert.equal(controller.togglePinnedGroup(groupKey("Alpha")).pinned, false);
  assert.deepEqual(
    orderNames([
      ...endedVariations,
      { variationNumber: 102, recorded: true, bidding: false, sku: "B" },
    ]),
    ["Delta", "Alpha", "Bravo", "Charlie"],
    "an unpinned card must return to its original Sheet position after the pins",
  );

  assert.equal(controller.togglePinnedGroup(groupKey("Alpha")).pinnedPosition, 2);
  assert.deepEqual(orderNames(), ["Delta", "Alpha", "Bravo", "Charlie"]);
  assert.equal(new Set(orderNames()).size, groups.length);
  assert.equal(controller.togglePinnedGroup(groupKey("Delta")).pinned, false);
  assert.deepEqual(orderNames(), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.equal(controller.togglePinnedGroup(groupKey("Delta")).pinnedPosition, 2);

  controller.reset();
  assert.equal(controller.isGroupPinned(groupKey("Alpha")), false);
  assert.equal(controller.isGroupPinned(groupKey("Delta")), false);
  assert.deepEqual(orderNames([]), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.deepEqual(orderNames(), ["Alpha", "Bravo", "Charlie", "Delta"]);
  assert.equal(controller.togglePinnedGroup(groupKey("Delta")).pinnedPosition, 1);
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
  const pinKeys = [...groupKeys].reverse();

  pinKeys.forEach((groupKey, index) => {
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
    pinKeys,
    "every item may remain pinned while the list is expanded",
  );

  const trimmed = controller.trimPinnedGroups(9);

  assert.deepEqual(trimmed, {
    changed: true,
    pinnedCount: 9,
    unpinnedGroupKeys: pinKeys.slice(9),
  });
  assert.deepEqual(
    groupKeys.map((groupKey) => controller.isGroupPinned(groupKey)),
    [false, false, false, ...Array(9).fill(true)],
  );
  assert.deepEqual(
    controller.order(groups, {
      variations: [
        {
          variationNumber: 100,
          recorded: true,
          bidding: false,
          sku: "SKU-2",
        },
        {
          variationNumber: 101,
          recorded: true,
          bidding: false,
          sku: "SKU-3",
        },
      ],
      currentVariationNumber: 101,
      selectedVariationNumber: 101,
      isReviewingHistory: false,
      auction: { sku: "SKU-3" },
    }).map((group) => group.key),
    [...pinKeys.slice(0, 9), ...groupKeys.slice(0, 3)],
    "collapsing retains the first nine pins and restores the others to Sheet order",
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

test("historical views use the same pin order and only explicit pin changes move cards", () => {
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

  assert.deepEqual(orderNames(liveView), ["Alpha", "Delta", "Bravo", "Charlie"]);

  const historicalView = {
    ...liveView,
    selectedVariationNumber: 100,
    isReviewingHistory: true,
    auction: { sku: "B" },
  };

  assert.deepEqual(
    orderNames(historicalView),
    ["Alpha", "Delta", "Bravo", "Charlie"],
    "viewing a historical mapping must not promote its card ahead of user pins",
  );

  controller.togglePinnedGroup(groupKey("Charlie"));
  controller.togglePinnedGroup(groupKey("Alpha"));
  assert.deepEqual(
    orderNames(historicalView),
    ["Delta", "Charlie", "Alpha", "Bravo"],
    "explicit pin changes take effect immediately while reviewing history",
  );
  assert.deepEqual(
    orderNames(liveView),
    ["Delta", "Charlie", "Alpha", "Bravo"],
    "returning live preserves the same pins and original unpinned order",
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
      quantityOnHandAtImport: 10,
      quantityReceived: 10,
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
      quantityOnHandAtImport: 0,
      quantityReceived: 0,
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
      quantityOnHandAtImport: 5,
      quantityReceived: 5,
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
  assert.equal(stock.primaryLabel, "6/15");
  assert.match(stock.ariaLabel, /starting baseline quantity 15/);
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

function ranView(variations, extra = {}) {
  return { streamId: "current-stream", activeBiddingVariationNumber: null, variations, ...extra };
}

function ranVariation(variationNumber, sku = "TEE-M", extra = {}) {
  return { variationNumber, sku, recorded: true, ...extra };
}

test("ran counts include each mapped recorded outcome, including unresolved previous auctions", () => {
  const statuses = ["payment_complete", "canceled", "payment_processing", "order_processing",
    "payment_fixing", "payment_failed", "not_observed", "unrecognized"];
  const variations = statuses.map((observedPaymentStatus, index) => ranVariation(index + 1, "TEE-M", {
    observedPaymentStatus, soldPriceCents: observedPaymentStatus === "payment_complete" ? 100 : null,
  }));
  const view = ranView([...variations, ranVariation(9)], { activeBiddingVariationNumber: 9 });
  assert.deepEqual([...getRanCountsBySku(view)], [["TEE-M", 8]]);
});

test("ran excludes unrecorded presets, manual queue previews, and unmapped actual rows", () => {
  const view = ranView([
    ranVariation(1), ranVariation(2, null), ranVariation(3, ""),
    ranVariation(4, "TEE-M", { recorded: false, preset: true }),
    ranVariation(5, "TEE-M", { recorded: false, queuedPreview: true }),
    { variationNumber: 6, sku: "TEE-M" },
    ranVariation(7, "TEE-M", { preset: true }),
    ranVariation(8, "TEE-M", { queuedPreview: true }),
  ]);
  assert.deepEqual([...getRanCountsBySku(view)], [["TEE-M", 1]]);
});

test("grouped ran sums exact size SKUs and retains existing item/style group boundaries", () => {
  const inventory = [
    { sku: "TEE-S", item: "Tee", style: "Red", size: "S" },
    { sku: "TEE-M", item: "Tee", style: "Red", size: "M" },
    { sku: "TEE-L", item: "Tee", style: "Red", size: "L" },
    { sku: "TEE-BLUE-M", item: "Tee", style: "Blue", size: "M" },
  ];
  const groups = groupInventoryEntries(inventory);
  const counts = getRanCountsBySku(ranView([
    ranVariation(1, "TEE-S"), ranVariation(2, "TEE-M"), ranVariation(3, "TEE-L"),
    ranVariation(4, "TEE-BLUE-M"), ranVariation(5, "OTHER-ITEM"),
  ]));
  assert.equal(getInventoryGroupRanCount(groups[0], counts), 3);
  assert.equal(getInventoryGroupRanCount(groups[1], counts), 1);
  assert.equal(getInventoryGroupRanCount({ entries: [{ sku: "TEE-OS" }] }, counts), 0);
  assert.deepEqual([...counts], [["TEE-S", 1], ["TEE-M", 1], ["TEE-L", 1], ["TEE-BLUE-M", 1], ["OTHER-ITEM", 1]]);
});

test("ran excludes the actual live marker rather than selected, current, or history navigation markers", () => {
  const variations = [ranVariation(1), ranVariation(2), ranVariation(3)];
  for (const selectedVariationNumber of [1, 2, 3, 99]) {
    const view = ranView(variations, {
      activeBiddingVariationNumber: 3, currentVariationNumber: 1, selectedVariationNumber,
      isReviewingHistory: selectedVariationNumber !== 3, isReviewingPreset: selectedVariationNumber === 99,
    });
    assert.equal(getRanCountsBySku(view).get("TEE-M"), 2);
  }
});

test("last ended or processing auction counts immediately without a newer variation", () => {
  for (const observedPaymentStatus of ["payment_processing", "payment_complete", "canceled", "unrecognized"]) {
    const view = ranView([ranVariation(20, "TEE-M", { observedPaymentStatus })], {
      currentVariationNumber: 20, selectedVariationNumber: 20,
    });
    assert.equal(getRanCountsBySku(view).get("TEE-M"), 1);
  }
});

test("live advancement counts the previous mapped auction once and excludes the newly active one", () => {
  const before = ranView([ranVariation(1), ranVariation(2)], { activeBiddingVariationNumber: 2 });
  assert.equal(getRanCountsBySku(before).get("TEE-M"), 1);
  const after = { ...before, variations: [...before.variations, ranVariation(3)], activeBiddingVariationNumber: 3 };
  assert.equal(getRanCountsBySku(after).get("TEE-M"), 2);
  assert.equal(getRanCountsBySku(after).get("TEE-M"), 2, "repeated renders do not increment persistent counters");
  assert.equal(getRanCountsBySku(before).get("TEE-M"), 1, "no accumulation leaks into older view snapshots");
});

test("duplicate variation rows count once, and gaps never become inferred runs", () => {
  const counts = getRanCountsBySku(ranView([
    ranVariation(2), ranVariation(2), ranVariation(2, "TEE-L"),
    ranVariation(50, "TEE-L"), ranVariation(50, "TEE-L"), ranVariation(200),
  ], { activeBiddingVariationNumber: 200 }));
  assert.deepEqual([...counts], [["TEE-M", 1], ["TEE-L", 1]]);
  assert.equal(getInventoryGroupRanCount({ entries: [{ sku: "TEE-M" }, { sku: "TEE-M" }] }, counts), 1,
    "a repeated group entry must not double the SKU total");
});

test("ran recalculates when historical mapping is added, changed, or removed", () => {
  const source = ranView([ranVariation(1), ranVariation(2, null)]);
  assert.deepEqual([...getRanCountsBySku(source)], [["TEE-M", 1]]);
  const mapped = { ...source, variations: [source.variations[0], ranVariation(2, "TEE-L")] };
  assert.deepEqual([...getRanCountsBySku(mapped)], [["TEE-M", 1], ["TEE-L", 1]]);
  const remapped = { ...mapped, variations: [ranVariation(1, "TEE-L"), mapped.variations[1]] };
  assert.deepEqual([...getRanCountsBySku(remapped)], [["TEE-L", 2]]);
  const unmapped = { ...remapped, variations: [ranVariation(1, null), remapped.variations[1]] };
  assert.deepEqual([...getRanCountsBySku(unmapped)], [["TEE-L", 1]]);
});

test("ran counts remain exact-SKU based rather than matching item text or normalizing SKU names", () => {
  const counts = getRanCountsBySku(ranView([
    ranVariation(1, "SKU-M", { item: "Repeated", style: "Same" }),
    ranVariation(2, "SKU-MISC", { item: "Repeated", style: "Same" }),
    ranVariation(3, "sku-m", { item: "Repeated", style: "Same" }),
  ]));
  assert.equal(getInventoryGroupRanCount({ entries: [{ sku: "SKU-M" }] }, counts), 1);
  assert.equal(getInventoryGroupRanCount({ entries: [{ sku: "SKU-MISC" }] }, counts), 1);
  assert.equal(getInventoryGroupRanCount({ entries: [{ sku: "sku-m" }] }, counts), 1);
});

test("empty or malformed view rows do not fabricate ran totals", () => {
  for (const view of [null, undefined, {}, ranView([]), { variations: {} }]) {
    assert.equal(getRanCountsBySku(view).size, 0);
  }
  assert.equal(getRanCountsBySku(ranView([
    null, undefined, ranVariation(0), ranVariation(-1), ranVariation(1.5), ranVariation("2"),
    ranVariation(Infinity), ranVariation(3, " SKU-M "), ranVariation(4, 100),
  ])).size, 0);
  assert.equal(getInventoryGroupRanCount(null, new Map()), 0);
  assert.equal(getInventoryGroupRanCount({ entries: [] }, null), 0);
  const group = { entries: [{ sku: "TEE-M" }] };
  for (const count of [-1, 1.5, NaN, Infinity, "2", null]) {
    assert.equal(getInventoryGroupRanCount(group, new Map([["TEE-M", count]])), 0);
  }
});

test("ran projection does not mutate rows, grouped stock, canonical metrics, or caller-owned maps", () => {
  const entries = Object.freeze([
    Object.freeze({ sku: "TEE-M", item: "Tee", style: "Red", size: "M", quantityReceived: 10,
      remainingQuantity: 8, reservedQuantity: 1, availableToTagQuantity: 7 }),
  ]);
  const group = Object.freeze({ entries });
  const variations = Object.freeze([Object.freeze(ranVariation(1)), Object.freeze(ranVariation(2))]);
  const view = Object.freeze(ranView(variations, { inventory: entries, totals: Object.freeze({ completedPaymentCount: 2 }) }));
  const before = structuredClone(view);
  const stock = getInventoryGroupStockDisplay(group);
  const counts = getRanCountsBySku(view);
  assert.equal(getInventoryGroupRanCount(group, counts), 2);
  assert.deepEqual(getInventoryGroupStockDisplay(group), stock);
  assert.deepEqual(view, before);
  counts.set("TEE-M", 999);
  assert.equal(getRanCountsBySku(view).get("TEE-M"), 2, "returned maps are fresh derived values");
});

test("real canonical stream views keep ran local even when inventory totals share a baseline", () => {
  const reconciliation = require("../extension/shared/reconciliation.js");
  const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
  const state = reconciliation.createReconciliationState(TEST_INVENTORY);
  const sku = TEST_INVENTORY[0].sku;
  for (const streamId of ["prior-stream", "current-stream"]) {
    reconciliation.pinStreamToInventoryBaseline(state, { streamId });
    reconciliation.recordPaymentComplete(state, { streamId, variationNumber: 1, soldPriceCents: 2500 });
    reconciliation.mapVariation(state, { streamId, variationNumber: 1, sku });
  }
  const before = structuredClone(state);
  const buildView = (streamId) => mappingWorkflow.createMappingSession({
    inventory: TEST_INVENTORY, reconciliation, state, streamId, variationNumber: 1, variationNumbers: [1],
  }).getViewState();
  const current = buildView("current-stream");
  assert.equal(current.inventory.find((entry) => entry.sku === sku).soldQuantity, 2);
  assert.equal(getRanCountsBySku(current).get(sku), 1);
  assert.equal(getRanCountsBySku(buildView("prior-stream")).get(sku), 1);
  assert.deepEqual(state, before);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "new-stream" });
  assert.equal(getRanCountsBySku(buildView("new-stream")).size, 0, "new stream starts at zero without resetting counters");
});

test("preset and manual-queue projections preserve canonical ran counts for any viewed entry", () => {
  const presetView = require("../extension/tagger/variation-presets-view.js");
  const inventory = [{ sku: "TEE-M", item: "Tee", style: "Red", size: "M" }];
  const raw = ranView([ranVariation(1), ranVariation(2)], {
    inventory, inventoryBaselineId: "baseline", activeBiddingVariationNumber: 2,
    currentVariationNumber: 2, selectedVariationNumber: 2,
  });
  const presets = { streamId: raw.streamId, baselineId: "baseline", revision: "revision", total: 5,
    assignments: [{ variationNumber: 4, sku: "TEE-M" }] };
  const queue = { streamId: raw.streamId, baselineId: "baseline", queuedSku: "TEE-M", armedAfterVariationNumber: 2 };
  for (const selection of [null, 1, 4, 5]) {
    const planned = presetView.project(raw, presets, selection);
    const queued = presetView.projectQueuedItem(planned, queue, 3);
    assert.deepEqual([...getRanCountsBySku(planned)], [["TEE-M", 1]]);
    assert.deepEqual([...getRanCountsBySku(queued)], [["TEE-M", 1]]);
  }
});
