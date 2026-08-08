const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MOCK_INVENTORY,
  filterInventoryEntries,
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
    remainingQuantity: 5,
  });
  assert.deepEqual(getStockDisplay({ quantityReceived: 1 }), {
    state: "low_stock",
    label: "1 left",
    remainingQuantity: 1,
  });
  assert.deepEqual(getStockDisplay({ quantityReceived: 0 }), {
    state: "sold_out",
    label: "Sold out",
    remainingQuantity: 0,
  });
});

test("prefers a calculated remaining quantity when one is available", () => {
  assert.equal(
    getRemainingQuantity({ quantityReceived: 5, remainingQuantity: 2 }),
    2,
  );
});
