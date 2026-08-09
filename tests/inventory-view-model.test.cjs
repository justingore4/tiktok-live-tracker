const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MOCK_INVENTORY,
  filterInventoryEntries,
  formatUsdCents,
  getProfitDisplay,
  getRemainingQuantity,
  getStockDisplay,
  normalizeSearchText,
} = require("../extension/tagger/inventory-view-model.js");

test("mock inventory contains unique stable SKUs", () => {
  const skus = MOCK_INVENTORY.map((entry) => entry.sku);

  assert.equal(MOCK_INVENTORY.length, 6);
  assert.equal(new Set(skus).size, MOCK_INVENTORY.length);
  assert.ok(
    MOCK_INVENTORY.every(
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
  const results = filterInventoryEntries(MOCK_INVENTORY, "   ");

  assert.deepEqual(results, MOCK_INVENTORY);
  assert.notEqual(results, MOCK_INVENTORY);
});

test("filters by item and style using multiple search terms", () => {
  const results = filterInventoryEntries(MOCK_INVENTORY, "nike grey");

  assert.deepEqual(
    results.map((entry) => entry.sku),
    ["NIKE-HOODIE-GREY-XL", "NIKE-HOODIE-GREY-L"],
  );
});

test("filters by size without matching letters inside another word", () => {
  const results = filterInventoryEntries(MOCK_INVENTORY, "stussy l");

  assert.deepEqual(
    results.map((entry) => entry.sku),
    ["STUSSY-TEE-BLACK-L"],
  );
});

test("supports partial words and multi-word styles", () => {
  const results = filterInventoryEntries(MOCK_INVENTORY, "den wash 32");

  assert.deepEqual(
    results.map((entry) => entry.sku),
    ["DENIM-SHORTS-WASHED-BLUE-32"],
  );
});

test("derives available, low-stock, and sold-out labels", () => {
  assert.deepEqual(getStockDisplay({ quantityReceived: 5 }), {
    state: "available",
    label: "5 left",
    ariaLabel: "5 inventory units left",
    primaryLabel: "5 left",
    secondaryLabel: "",
    remainingQuantity: 5,
    availableToTagQuantity: 5,
    reservedQuantity: 0,
  });
  assert.deepEqual(getStockDisplay({ quantityReceived: 1 }), {
    state: "low_stock",
    label: "1 left",
    ariaLabel: "1 inventory unit left",
    primaryLabel: "1 left",
    secondaryLabel: "",
    remainingQuantity: 1,
    availableToTagQuantity: 1,
    reservedQuantity: 0,
  });
  assert.deepEqual(getStockDisplay({ quantityReceived: 0 }), {
    state: "sold_out",
    label: "0 left · Sold out",
    ariaLabel: "0 inventory units left, sold out",
    primaryLabel: "0 left",
    secondaryLabel: "Sold out",
    remainingQuantity: 0,
    availableToTagQuantity: 0,
    reservedQuantity: 0,
  });
});

test("distinguishes available, fully reserved, and over-reserved inventory", () => {
  assert.deepEqual(
    getStockDisplay({
      remainingQuantity: 5,
      availableToTagQuantity: 4,
      reservedQuantity: 1,
      reservationShortfallQuantity: 0,
    }),
    {
      state: "available",
      label: "5 left · 1 pending",
      ariaLabel: "5 inventory units left, 1 pending reservation",
      primaryLabel: "5 left",
      secondaryLabel: "1 pending",
      remainingQuantity: 5,
      availableToTagQuantity: 4,
      reservedQuantity: 1,
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
      state: "fully_reserved",
      label: "1 left · 1 pending",
      ariaLabel: "1 inventory unit left, 1 pending reservation",
      primaryLabel: "1 left",
      secondaryLabel: "1 pending",
      remainingQuantity: 1,
      availableToTagQuantity: 0,
      reservedQuantity: 1,
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
      state: "over_reserved",
      label: "1 left · 2 pending · short by 1",
      ariaLabel:
        "1 inventory unit left, 2 pending reservations, short by 1 unit",
      primaryLabel: "1 left",
      secondaryLabel: "2 pending · short by 1",
      remainingQuantity: 1,
      availableToTagQuantity: -1,
      reservedQuantity: 2,
    },
  );
});

test("keeps remaining stock unchanged for a pending reservation and decrements it only after completion", () => {
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
  assert.equal(whilePending.label, "5 left · 1 pending");
  assert.equal(whilePending.primaryLabel, "5 left");
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

test("prefers a calculated remaining quantity when one is available", () => {
  assert.equal(
    getRemainingQuantity({ quantityReceived: 5, remainingQuantity: 2 }),
    2,
  );
});
