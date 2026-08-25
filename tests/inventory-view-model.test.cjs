const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LEGACY_RECOVERY_INVENTORY,
  calculateAverageOrderValueCents,
  createInventoryGroupKey,
  filterInventoryEntries,
  filterInventoryGroups,
  formatUsdCents,
  getInventoryGroupStockDisplay,
  getPreferredInventoryGroupEntry,
  getProfitDisplay,
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

test("prefers a calculated remaining quantity when one is available", () => {
  assert.equal(
    getRemainingQuantity({ quantityReceived: 5, remainingQuantity: 2 }),
    2,
  );
});
