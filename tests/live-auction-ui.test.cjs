const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const inventoryViewModel = require(
  "../extension/tagger/inventory-view-model.js",
);
const liveAuctionViewModel = require(
  "../extension/tagger/live-auction-view-model.js",
);

const formatUsdCents = inventoryViewModel.formatUsdCents;

function createDisplay(overrides = {}) {
  return liveAuctionViewModel.createDisplay({
    view: {
      activeBiddingVariationNumber: 225,
      activeAuctionMapping: null,
    },
    liveAuction: null,
    formatUsdCents,
    ...overrides,
  });
}

test("live auction display stays hidden only without an available Live workspace", () => {
  const inactive = createDisplay({ view: null });

  assert.equal(inactive.hidden, true);
  assert.equal(inactive.variationLabel, "Variation # - Status | -");
  assert.equal(inactive.remainingInventory, "\u2014");
  assert.equal(Object.hasOwn(inactive, "note"), false);

  assert.equal(
    createDisplay({ view: { activeBiddingVariationNumber: null } }).hidden,
    false,
  );
});

test("live auction remains visible with a neutral empty state before capture", () => {
  assert.deepEqual(
    createDisplay({ view: { activeBiddingVariationNumber: null } }),
    {
      hidden: false,
      variationNumber: null,
      variationLabel: "Variation # - Status | -",
      currentBid: "\u2014",
      unitCost: "\u2014",
      grossProfit: "\u2014",
      remainingInventory: "\u2014",
      profitTone: "neutral",
      state: "inactive",
    },
  );
});

test("live auction waits safely until a matching bid and mapping arrive", () => {
  const waiting = createDisplay();

  assert.deepEqual(waiting, {
    hidden: false,
    variationNumber: 225,
    variationLabel: "Variation #225 Status | -",
    currentBid: "\u2014",
    unitCost: "\u2014",
    grossProfit: "\u2014",
    remainingInventory: "\u2014",
    profitTone: "neutral",
    state: "waiting",
  });

  const stale = createDisplay({
    liveAuction: {
      variationNumber: 224,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
    view: {
      activeBiddingVariationNumber: 225,
      activeAuctionMapping: {
        variationNumber: 224,
        sku: "OLD-ITEM",
        unitCostCents: 1200,
      },
      inventory: [{ sku: "OLD-ITEM", item: "Old item", style: "tee", remainingQuantity: 99 }],
    },
  });

  assert.equal(stale.currentBid, "\u2014");
  assert.equal(stale.unitCost, "\u2014");
  assert.equal(stale.grossProfit, "\u2014");
  assert.equal(stale.remainingInventory, "\u2014");
  assert.equal(stale.variationLabel, "Variation #225 Status | -");
});

test("live auction always shows a matching bid before inventory is mapped", () => {
  const display = createDisplay({
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 2800,
      unitCostCents: null,
    },
  });

  assert.equal(display.currentBid, "$28.00");
  assert.equal(display.unitCost, "\u2014");
  assert.equal(display.grossProfit, "\u2014");
  assert.equal(display.remainingInventory, "\u2014");
  assert.equal(display.state, "unmapped");
  assert.equal(display.variationLabel, "Variation #225 Status | -");
  assert.equal(Object.hasOwn(display, "note"), false);
});

test("live profit uses the active auction mapping while history is selected", () => {
  const view = {
    activeBiddingVariationNumber: 225,
    selectedVariationNumber: 200,
    auction: {
      variationNumber: 200,
      sku: "HISTORICAL-ITEM",
      item: "Historical item",
      style: "hoodie",
      committedUnitCostCents: 99999,
      remainingQuantity: 99,
    },
    activeAuctionMapping: {
      variationNumber: 225,
      sku: "LIVE-ITEM",
      unitCostCents: 1200,
    },
    inventory: [
      { sku: "HISTORICAL-ITEM", item: "Historical item", style: "hoodie", remainingQuantity: 99 },
      {
        sku: "LIVE-ITEM", item: "korea vulture", style: "tee",
        remainingQuantity: 81, availableToTagQuantity: 80,
      },
    ],
  };
  const positive = createDisplay({
    view,
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });
  const negative = createDisplay({
    view,
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 1000,
      unitCostCents: 1200,
    },
  });
  const breakEven = createDisplay({
    view,
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 1200,
      unitCostCents: 1200,
    },
  });

  assert.equal(positive.currentBid, "$28.00");
  assert.equal(positive.unitCost, "$12.00");
  assert.equal(positive.grossProfit, "+$16.00");
  assert.equal(positive.profitTone, "positive");
  assert.equal(negative.grossProfit, "-$2.00");
  assert.equal(negative.profitTone, "negative");
  assert.equal(breakEven.grossProfit, "$0.00");
  assert.equal(breakEven.profitTone, "neutral");

  for (const display of [positive, negative, breakEven]) {
    assert.equal(display.variationLabel, "Variation #225 Status | korea vulture - tee");
    assert.equal(display.remainingInventory, "81 remaining");
    assert.equal(Object.hasOwn(display, "note"), false);
  }
});

test("live auction retains its final display until a new active variation", () => {
  const retained = createDisplay({
    view: {
      activeBiddingVariationNumber: null,
      selectedVariationNumber: 200,
      auction: {
        variationNumber: 200,
        sku: "HISTORICAL-ITEM",
        item: "Historical item",
        style: "hoodie",
      },
      variations: [
        { variationNumber: 200, sku: "HISTORICAL-ITEM", item: "Historical item" },
        { variationNumber: 225, sku: "LIVE-ITEM", item: "korea vulture", style: "tee" },
      ],
      inventory: [{ sku: "LIVE-ITEM", item: "korea vulture", style: "tee", remainingQuantity: 80 }],
    },
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });

  assert.equal(retained.variationLabel, "Variation #225 Status | korea vulture - tee");
  assert.equal(retained.currentBid, "$28.00");
  assert.equal(retained.unitCost, "$12.00");
  assert.equal(retained.grossProfit, "+$16.00");
  assert.equal(retained.remainingInventory, "80 remaining");
  assert.equal(retained.state, "retained");
  assert.equal(Object.hasOwn(retained, "note"), false);

  const nextActive = createDisplay({
    view: {
      activeBiddingVariationNumber: 226,
      activeAuctionMapping: null,
      variations: [
        { variationNumber: 225, sku: "LIVE-ITEM", item: "korea vulture", style: "tee" },
      ],
      inventory: [{ sku: "LIVE-ITEM", item: "korea vulture", style: "tee" }],
    },
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });

  assert.equal(nextActive.variationLabel, "Variation #226 Status | -");
  assert.equal(nextActive.currentBid, "\u2014");
  assert.equal(nextActive.unitCost, "\u2014");
  assert.equal(nextActive.grossProfit, "\u2014");
  assert.equal(nextActive.remainingInventory, "\u2014");
  assert.equal(nextActive.state, "waiting");
  assert.equal(Object.hasOwn(nextActive, "note"), false);
});

test("active mapping is authoritative over a stale retained unit cost", () => {
  const staleCost = {
    variationNumber: 225,
    bidPriceCents: 2800,
    unitCostCents: 1200,
  };
  const unmapped = createDisplay({
    view: {
      activeBiddingVariationNumber: 225,
      activeAuctionMapping: null,
      variations: [
        { variationNumber: 225, sku: "OLD-ITEM", item: "Old item", style: "tee" },
      ],
      inventory: [{ sku: "OLD-ITEM", item: "Old item", style: "tee" }],
    },
    liveAuction: staleCost,
  });

  assert.equal(unmapped.currentBid, "$28.00");
  assert.equal(unmapped.unitCost, "\u2014");
  assert.equal(unmapped.grossProfit, "\u2014");
  assert.equal(unmapped.remainingInventory, "\u2014");
  assert.equal(unmapped.state, "unmapped");
  assert.equal(unmapped.variationLabel, "Variation #225 Status | -");
});

test("live auction title follows remapping and supports items without a style", () => {
  const view = {
    activeBiddingVariationNumber: 225,
    activeAuctionMapping: {
      variationNumber: 225,
      sku: "TEE",
      unitCostCents: 1200,
    },
    inventory: [
      { sku: "TEE", item: "korea vulture", style: "tee", remainingQuantity: 81 },
      { sku: "BAG", item: "Backpack", style: "", remainingQuantity: 2 },
    ],
  };
  const mapped = createDisplay({ view });
  const remapped = createDisplay({
    view: {
      ...view,
      activeAuctionMapping: { variationNumber: 225, sku: "BAG", unitCostCents: 0 },
    },
  });

  assert.equal(mapped.variationLabel, "Variation #225 Status | korea vulture - tee");
  assert.equal(mapped.unitCost, "$12.00");
  assert.equal(mapped.remainingInventory, "81 remaining");
  assert.equal(remapped.variationLabel, "Variation #225 Status | Backpack");
  assert.equal(remapped.unitCost, "$0.00");
  assert.equal(remapped.remainingInventory, "2 remaining");
  assert.equal(remapped.currentBid, "\u2014");
  assert.equal(remapped.grossProfit, "\u2014");
  assert.equal(Object.hasOwn(mapped, "note"), false);
  assert.equal(Object.hasOwn(remapped, "note"), false);
});

test("retained titles use only matching mapping identities and never a historical selection", () => {
  const view = {
    activeBiddingVariationNumber: null,
    auction: {
      variationNumber: 200,
      sku: "HISTORICAL-ITEM",
      item: "Historical item",
      style: "tee",
      remainingQuantity: 99,
    },
    variations: [
      {
        variationNumber: 225, sku: "LIVE-ITEM", item: "Live item", style: "hoodie",
        remainingQuantity: 4,
      },
    ],
  };
  const liveAuction = { variationNumber: 225, bidPriceCents: 2800, unitCostCents: 1200 };
  const retained = createDisplay({ view, liveAuction });
  const unknown = createDisplay({ view: { ...view, variations: [] }, liveAuction });
  const unmapped = createDisplay({
    view: {
      ...view,
      variations: [{ variationNumber: 225, sku: null, item: "Old name", style: "tee" }],
    },
    liveAuction,
  });

  assert.equal(retained.variationLabel, "Variation #225 Status | Live item - hoodie");
  assert.equal(retained.remainingInventory, "4 remaining");
  assert.equal(unknown.variationLabel, "Variation #225 Status | -");
  assert.equal(unknown.remainingInventory, "\u2014");
  assert.equal(unmapped.variationLabel, "Variation #225 Status | -");
  assert.equal(unmapped.remainingInventory, "\u2014");
});

test("live inventory follows exact size SKUs, mapping changes, and valid fresh quantities", () => {
  const view = {
    activeBiddingVariationNumber: 225,
    activeAuctionMapping: { variationNumber: 225, sku: "TEE-M", unitCostCents: 1200 },
    inventory: [
      { sku: "TEE-S", item: "T-shirt", style: "tee", size: "S", remainingQuantity: 9 },
      {
        sku: "TEE-M", item: "T-shirt", style: "tee", size: "M",
        remainingQuantity: 3, availableToTagQuantity: 2,
      },
    ],
  };

  assert.equal(createDisplay({ view }).remainingInventory, "3 remaining");
  view.inventory[1].remainingQuantity = 2;
  view.inventory[1].availableToTagQuantity = 1;
  assert.equal(createDisplay({ view }).remainingInventory, "2 remaining");
  view.activeAuctionMapping = { variationNumber: 225, sku: "TEE-S", unitCostCents: 1200 };
  assert.equal(createDisplay({ view }).remainingInventory, "9 remaining");
  view.activeAuctionMapping = null;
  assert.equal(createDisplay({ view }).remainingInventory, "\u2014");

  for (const [quantity, expected] of [
    [0, "0 remaining"],
    [-2, "-2 remaining"],
    [undefined, "\u2014"],
    [null, "\u2014"],
    ["3", "\u2014"],
    [1.5, "\u2014"],
    [Number.MAX_SAFE_INTEGER + 1, "\u2014"],
  ]) {
    const display = createDisplay({
      view: {
        activeBiddingVariationNumber: 225,
        activeAuctionMapping: { variationNumber: 225, sku: "TEE", unitCostCents: 1200 },
        inventory: [{ sku: "TEE", item: "T-shirt", remainingQuantity: quantity }],
      },
    });

    assert.equal(display.remainingInventory, expected, `remainingQuantity: ${quantity}`);
  }
});

test("side panel places a compact live auction panel directly after Variation", () => {
  const directory = path.join(__dirname, "..", "extension", "tagger");
  const html = fs.readFileSync(path.join(directory, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "sidepanel.css"), "utf8");
  const source = fs.readFileSync(path.join(directory, "sidepanel.js"), "utf8");
  const currentAuctionEnd = html.search(
    /<section\s+id="live-auction"/,
  );
  const pendingMappingStart = html.indexOf('id="pending-mapping"');

  assert.ok(currentAuctionEnd > html.indexOf('class="current-auction"'));
  assert.ok(currentAuctionEnd < pendingMappingStart);
  assert.doesNotMatch(
    html.match(/<section\s+id="live-auction"[\s\S]*?>/)?.[0] ?? "",
    /\shidden/,
  );
  assert.match(html, /id="live-auction-title">Variation # - Status \| -</);
  assert.match(html, />\s*Current bid\s*</);
  assert.match(html, />\s*Unit cost\s*</);
  assert.match(html, />\s*Live gross profit\s*</);
  const liveMetrics = html.slice(currentAuctionEnd, html.indexOf("</dl>", currentAuctionEnd));
  assert.equal((liveMetrics.match(/<dt>/g) ?? []).length, 4);
  assert.match(
    liveMetrics,
    /<dt>Live gross profit<\/dt>[\s\S]*?<dt>Inventory<\/dt>\s*<dd id="live-remaining-inventory-value">&mdash;<\/dd>/,
  );
  assert.doesNotMatch(html, /id="live-auction-note"/);
  assert.doesNotMatch(source, /liveAuctionNote|display\.note/);
  assert.doesNotMatch(css, /\.live-auction-note/);
  const panelCss = css.match(/\.live-auction\s*\{([^}]+)\}/)?.[1] ?? "";
  const headingCss = css.match(/\.live-auction-heading h2\s*\{([^}]+)\}/)?.[1] ?? "";
  const valuesCss = css.match(/\.live-auction-values\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(panelCss, /margin-top:\s*10px;/);
  assert.match(panelCss, /padding:\s*10px 12px;/);
  assert.match(headingCss, /margin:\s*0;/);
  assert.match(valuesCss, /margin:\s*8px 0 0;/);
  assert.match(valuesCss, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.live-auction-values > div\s*\{[^}]*padding:\s*0 8px;/);
  assert.match(css, /#live-remaining-inventory-value\s*\{[^}]*white-space:\s*normal;/);
  assert.match(css, /\.live-auction-values \[data-tone="positive"\]/);
  assert.match(css, /\.live-auction-values \[data-tone="negative"\]/);
  assert.match(css, /\.live-auction-indicator[\s\S]*?#667386/);
  assert.doesNotMatch(css, /\.current-auction::after/);
  assert.match(source, /function renderLiveAuction\(view\)/);
  assert.match(source, /liveBidClient\.getLiveBid\(\)/);
  assert.match(source, /liveAuctionTitle\.textContent = display\.variationLabel/);
  assert.match(
    source,
    /document\.querySelector\(\s*"#live-remaining-inventory-value",?\s*\)/,
  );
  assert.match(
    source,
    /if \(liveRemainingInventoryValue\.textContent !== display\.remainingInventory\)\s*\{\s*liveRemainingInventoryValue\.textContent = display\.remainingInventory;/,
  );
  assert.match(source, /message\.event\.type === "live_bid_changed"/);
  assert.match(
    source,
    /isLiveBidChangedNotification\(message, sender\)[\s\S]*?scheduleLiveBidRefresh\(\)[\s\S]*?return false;[\s\S]*?isCaptureStateChangedNotification/,
    "live bid notifications must bypass the full reconciliation refresh",
  );
});

test("live order sale results stay compact and replace unavailable values with dashes", () => {
  const directory = path.join(__dirname, "..", "extension", "tagger");
  const html = fs.readFileSync(path.join(directory, "sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "sidepanel.css"), "utf8");
  const source = fs.readFileSync(path.join(directory, "sidepanel.js"), "utf8");
  const resultsStart = html.indexOf('<div id="sale-results" class="sale-results">');
  const resultsEnd = html.indexOf("</dl>", resultsStart);
  const results = html.slice(resultsStart, resultsEnd);
  const renderStart = source.indexOf("function renderSaleResults(view)");
  const renderEnd = source.indexOf("function isObservedCompletionAwaitingPrice", renderStart);
  const renderSource = source.slice(renderStart, renderEnd);

  assert.ok(resultsStart >= 0);
  assert.doesNotMatch(results, /\shidden/);
  assert.equal((results.match(/&mdash;/g) ?? []).length, 4);
  assert.doesNotMatch(source, /saleResults\.hidden/);
  assert.match(renderSource, /soldPriceCents === null[\s\S]*?\? "—"/);
  assert.match(renderSource, /unitCostCents === null[\s\S]*?\? "—"/);
  assert.match(renderSource, /profit\?\.label \?\? "—"/);
  assert.match(renderSource, /profit\?\.tone \?\? "neutral"/);
  assert.match(renderSource, /Number\.isSafeInteger\([\s\S]*?remainingQuantity[\s\S]*?: "—"/);
  assert.match(
    css,
    /\.sale-results dl\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*560px\)[\s\S]*?\.sale-results dl\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    css,
    /\.sale-results dd\s*\{[\s\S]*?min-height:\s*1\.25em;[\s\S]*?white-space:\s*nowrap;/,
  );
});
