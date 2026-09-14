const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const viewModel = require("../extension/tagger/inventory-view-model.js");

const taggerDirectory = path.join(__dirname, "..", "extension", "tagger");
const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");
const source = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
const css = fs.readFileSync(path.join(taggerDirectory, "sidepanel.css"), "utf8");

function functionBefore(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Find the actual ${name} implementation`);
  return source.slice(start, end);
}

function element(textContent = "") {
  return {
    textContent,
    hidden: false,
    disabled: false,
    value: "",
    dataset: {},
    attributes: {},
    children: [],
    classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(fragment) { this.children = fragment.children; },
  };
}

function inventoryFixture(groupCount) {
  const entries = Array.from({ length: groupCount }, (_, index) => ({
    sku: `SYNTHETIC-${index}-M`,
    item: `Product ${index}`,
    style: index % 2 === 0 ? "Tee" : "Hoodie",
    size: "M",
    quantityReceived: 100,
    remainingQuantity: 75,
    unitCostCents: 500,
  }));
  if (groupCount > 0) {
    entries.push({ ...entries[0], sku: "SYNTHETIC-0-L", size: "L" });
  }
  return entries;
}

function createRenderHarness() {
  const sandbox = {
    document: {
      activeElement: null,
      createDocumentFragment() {
        return { children: [], append(card) { this.children.push(card); } };
      },
    },
    viewModel,
    inventorySizeMenuState: null,
    deferredInventoryRender: null,
    inventoryListExpanded: false,
    COLLAPSED_INVENTORY_ITEM_LIMIT: 9,
    inventoryGroupOrderController: viewModel.createInventoryGroupOrderController(),
    createInventoryCard(group) { return { group }; },
    restoreCardFocus() {},
    restoreInventoryPinFocus() {},
    renderQueuedItemBadge() {},
    inventoryGrid: element(),
    inventorySelectionNote: element(),
    inventoryListToggle: element(),
    inventoryListToggleLabel: element(),
    emptyState: element(),
    emptyQuery: element(),
    clearSearchButton: element(),
    searchInput: element(),
    resultCount: element("0 items"),
  };
  vm.runInNewContext(
    functionBefore("formatResultCount", "restoreCardFocus") +
      functionBefore("renderInventory", "renderMetrics"),
    sandbox,
  );
  return sandbox;
}

test("inventory header has one static title and inline polite count before its existing SKU action", () => {
  const inventorySection = html.match(
    /<section class="inventory-section" aria-labelledby="inventory-title">[\s\S]*?<\/section>/,
  )?.[0];
  assert.ok(inventorySection);
  const header = inventorySection.slice(0, inventorySection.indexOf("<form"));
  assert.match(header, /class="section-heading inventory-heading"/);
  assert.match(
    header,
    /class="inventory-heading-label">\s*<h2 id="inventory-title">Inventory<\/h2>\s*<p id="result-count" class="result-count" aria-live="polite">0 items<\/p>\s*<\/div>\s*<div id="queued-item-slot"[\s\S]*?<div class="inventory-heading-actions">/,
  );
  assert.equal((html.match(/id="inventory-title"/g) ?? []).length, 1);
  assert.equal((html.match(/id="result-count"/g) ?? []).length, 1);
  assert.doesNotMatch(header, /eyebrow|Waiting for a live auction variation|Select Variation|inventory items/);
  assert.match(
    header,
    /id="add-active-stream-skus"\s+class="text-action"\s+type="button"\s+aria-expanded="false"\s+aria-controls="active-stream-inventory-update-form"\s+hidden\s*>\s*Add new SKUs from updated Sheet/,
  );
  assert.match(inventorySection, /<label class="visually-hidden" for="inventory-search">\s*Search inventory by SKU, item, style, or size\s*<\/label>/);
  assert.match(inventorySection, /id="inventory-search"\s+type="search"\s+placeholder="Search SKU, item, style, or size"/);
  assert.match(inventorySection, /id="inventory-grid" class="inventory-grid" role="list"/);
});

test("waiting, live, and historical navigation never replaces the Inventory heading or its count", () => {
  const originalTitle = element("Inventory");
  const resultCount = element("10 items");
  const requestedViews = [];
  const sandbox = {
    inventoryTitle: originalTitle,
    resultCount,
    variationContext: element(),
    returnToCurrentButton: element(),
    variationSelectorLock: { requestRender(view) { requestedViews.push(view); } },
  };
  vm.runInNewContext(
    functionBefore("getRecordedVariations", "hasSelectedRecordedVariation") +
      functionBefore("renderVariationNavigation", "renderInventory"),
    sandbox,
  );
  const states = [
    { variations: [], isReviewingHistory: false, selectedVariationNumber: null },
    { variations: [{ recorded: true, variationNumber: 79 }], isReviewingHistory: false, selectedVariationNumber: 79 },
    { variations: [{ recorded: true, variationNumber: 78 }, { recorded: true, variationNumber: 79 }], isReviewingHistory: true, selectedVariationNumber: 78 },
  ];
  for (const state of states) {
    sandbox.renderVariationNavigation(state);
    assert.equal(originalTitle.textContent, "Inventory");
    assert.equal(resultCount.textContent, "10 items");
    assert.equal(sandbox.returnToCurrentButton.hidden, !state.isReviewingHistory);
    assert.equal(sandbox.returnToCurrentButton.textContent, "Return to live item");
  }
  assert.deepEqual(requestedViews, states);
  assert.doesNotMatch(source, /\binventoryTitle\b/);
});

test("inventory header counts grouped items, not SKU rows or stock units, with 0/1/10 grammar", () => {
  const harness = createRenderHarness();
  for (const count of [0, 1, 10]) {
    const inventory = inventoryFixture(count);
    const before = structuredClone(inventory);
    harness.renderInventory({ inventory, variations: [] });
    assert.equal(harness.resultCount.textContent, `${count} ${count === 1 ? "item" : "items"}`);
    assert.equal(harness.inventoryGrid.children.length, Math.min(count, 9));
    assert.equal(harness.inventoryGrid.hidden, count === 0);
    assert.deepEqual(inventory, before, "Rendering must not alter inventory rows or quantities");
  }
  assert.equal(harness.inventoryListToggle.hidden, false);
  assert.equal(harness.inventoryListToggle.attributes["aria-expanded"], "false");
  harness.inventoryListExpanded = true;
  harness.renderInventory({ inventory: inventoryFixture(10), variations: [] });
  assert.equal(harness.inventoryGrid.children.length, 10);
  assert.equal(harness.resultCount.textContent, "10 items", "Expanding cards does not change the item count");
});

test("inventory header retains grouped search counts, matches grammar, and empty-search behavior", () => {
  const harness = createRenderHarness();
  const inventory = inventoryFixture(10);
  const original = structuredClone(inventory);
  const cases = [
    ["tee", "5 of 10 matches", 5],
    ["SYNTHETIC-0-L", "1 of 10 match", 1],
    ["no such product", "0 of 10 matches", 0],
    ["Product", "10 of 10 matches", 9],
    ["   ", "10 items", 9],
  ];
  for (const [query, label, cards] of cases) {
    harness.searchInput.value = query;
    harness.renderInventory({ inventory, variations: [] });
    assert.equal(harness.resultCount.textContent, label);
    assert.equal(harness.inventoryGrid.children.length, cards);
    assert.equal(harness.emptyState.hidden, cards > 0);
    assert.equal(harness.clearSearchButton.hidden, query.trim() === "");
    assert.equal(harness.emptyQuery.textContent, `"${query.trim()}"`);
    assert.deepEqual(inventory, original);
  }
  assert.match(source, /searchInput\.addEventListener\("input", \(event\) => \{\s*if \(guardCaptureInteraction\(event\)\) return;\s*renderAll\(\);\s*\}\)/);
});

test("unchanged result counts do not repeatedly write the live-region text during live refreshes", () => {
  const harness = createRenderHarness();
  let renderedText = "";
  let writes = 0;
  Object.defineProperty(harness.resultCount, "textContent", {
    get() { return renderedText; },
    set(value) { renderedText = value; writes += 1; },
  });
  const view = { inventory: inventoryFixture(10), variations: [] };
  harness.renderInventory(view);
  harness.renderInventory(view);
  harness.renderInventory({ ...view, selectedVariationNumber: 80, isReviewingHistory: false });
  harness.renderInventory({ ...view, selectedVariationNumber: 79, isReviewingHistory: true });
  assert.equal(renderedText, "10 items");
  assert.equal(writes, 1);
});

test("header count stays the same when pinning changes the displayed group order", () => {
  const harness = createRenderHarness();
  const inventory = inventoryFixture(10);
  const original = structuredClone(inventory);
  const view = { inventory, variations: [] };
  harness.renderInventory(view);
  assert.equal(harness.inventoryGrid.children[0].group.item, "Product 0");
  harness.inventoryGroupOrderController.togglePinnedGroup(
    viewModel.createInventoryGroupKey("Product 9", "Hoodie"),
  );
  harness.renderInventory(view);
  assert.equal(harness.inventoryGrid.children[0].group.item, "Product 9");
  assert.equal(harness.resultCount.textContent, "10 items");
  assert.deepEqual(inventory, original);
});

test("the relocated SKU button retains availability, busy, and form visibility safeguards", () => {
  const sandbox = {
    streamSnapshot: { activeSession: null, resumed: false },
    persistentController: {},
    savedSnapshot: { view: {} },
    activeStreamInventoryUpdateOpen: false,
    activeStreamInventoryUpdateBusy: false,
    addActiveStreamSkusButton: element(),
    activeStreamInventoryUpdateForm: element(),
    activeStreamInventorySheetReference: element(),
    cancelActiveStreamInventoryUpdateButton: element(),
    confirmActiveStreamInventoryUpdateButton: element(),
  };
  vm.runInNewContext(
    functionBefore("renderActiveStreamInventoryUpdateControls", "closeActiveStreamInventoryUpdate"),
    sandbox,
  );
  sandbox.renderActiveStreamInventoryUpdateControls();
  assert.equal(sandbox.addActiveStreamSkusButton.hidden, true);
  assert.equal(sandbox.addActiveStreamSkusButton.disabled, true);
  sandbox.streamSnapshot = { activeSession: {}, resumed: true };
  sandbox.renderActiveStreamInventoryUpdateControls();
  assert.equal(sandbox.addActiveStreamSkusButton.hidden, false);
  assert.equal(sandbox.addActiveStreamSkusButton.disabled, false);
  assert.equal(sandbox.activeStreamInventoryUpdateForm.hidden, true);
  sandbox.activeStreamInventoryUpdateOpen = true;
  sandbox.activeStreamInventoryUpdateBusy = true;
  sandbox.renderActiveStreamInventoryUpdateControls();
  assert.equal(sandbox.addActiveStreamSkusButton.disabled, true);
  assert.equal(sandbox.addActiveStreamSkusButton.attributes["aria-expanded"], "true");
  assert.equal(sandbox.activeStreamInventoryUpdateForm.hidden, false);
  assert.equal(sandbox.activeStreamInventoryUpdateForm.attributes["aria-busy"], "true");
  assert.equal(sandbox.activeStreamInventorySheetReference.disabled, true);
  sandbox.streamSnapshot.resumed = false;
  sandbox.renderActiveStreamInventoryUpdateControls();
  assert.equal(sandbox.addActiveStreamSkusButton.hidden, true);
  assert.equal(sandbox.activeStreamInventoryUpdateForm.hidden, true);
  assert.equal(sandbox.activeStreamInventoryUpdateOpen, false);
  assert.match(source, /addActiveStreamSkusButton\.addEventListener\("click", \(event\) => \{\s*if \(guardCaptureInteraction\(event\)\) return;\s*if \(activeStreamInventoryUpdateBusy \|\| addActiveStreamSkusButton\.hidden\)/);
});

test("compact header styling wraps its labels and keeps the SKU action right aligned without fixed widths", () => {
  // These are layout contracts, not a browser/pixel-rendering substitute.
  assert.match(css, /\.section-heading\.inventory-heading\s*\{[^}]*flex-direction: row;[^}]*flex-wrap: wrap;[^}]*gap: 6px 12px;[^}]*margin-bottom: 8px;/);
  assert.match(css, /\.inventory-heading-label\s*\{[^}]*display: flex;[^}]*min-width: 0;[^}]*align-items: baseline;[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.inventory-heading-actions\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*margin-left: auto;[^}]*justify-content: flex-end;/);
  assert.match(css, /\.inventory-heading-actions \.text-action\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;[^}]*text-align: right;/);
  assert.match(css, /\.inventory-heading-actions \.text-action\s*\{[^}]*font-size: 10px;/);
  assert.match(css, /\.text-action\s*\{[^}]*font-size: 9px;/, "Other text actions retain their existing size");
  assert.match(css, /\.result-count\s*\{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.inventory-section\s*\{\s*padding-top: 14px;/);
  assert.match(css, /\.inventory-section > \.search-field input\s*\{\s*height: 42px;/);
  assert.match(css, /\.inventory-grid\s*\{[^}]*gap: 10px;[^}]*margin-top: 10px;/);
  assert.match(css, /\.metrics-section\s*\{\s*padding-top: 14px;/);
});
