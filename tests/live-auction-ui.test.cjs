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
  assert.equal(
    createDisplay({ view: null }).hidden,
    true,
  );

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
      variationLabel: "Variation # -",
      currentBid: "\u2014",
      unitCost: "\u2014",
      grossProfit: "\u2014",
      profitTone: "neutral",
      note: "Waiting for a live auction.",
      state: "inactive",
    },
  );
});

test("live auction waits safely until a matching bid and mapping arrive", () => {
  const waiting = createDisplay();

  assert.deepEqual(waiting, {
    hidden: false,
    variationNumber: 225,
    variationLabel: "Variation #225",
    currentBid: "\u2014",
    unitCost: "\u2014",
    grossProfit: "\u2014",
    profitTone: "neutral",
    note: "Waiting for a live bid. Map the live item to show cost and profit.",
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
    },
  });

  assert.equal(stale.currentBid, "\u2014");
  assert.equal(stale.unitCost, "\u2014");
  assert.equal(stale.grossProfit, "\u2014");
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
  assert.equal(display.state, "unmapped");
  assert.match(display.note, /Map the live item/);
});

test("live profit uses the active auction mapping while history is selected", () => {
  const view = {
    activeBiddingVariationNumber: 225,
    selectedVariationNumber: 200,
    auction: {
      variationNumber: 200,
      sku: "HISTORICAL-ITEM",
      committedUnitCostCents: 99999,
    },
    activeAuctionMapping: {
      variationNumber: 225,
      sku: "LIVE-ITEM",
      unitCostCents: 1200,
    },
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
});

test("live auction retains its final display until a new active variation", () => {
  const retained = createDisplay({
    view: { activeBiddingVariationNumber: null },
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });

  assert.equal(retained.variationLabel, "Variation #225");
  assert.equal(retained.currentBid, "$28.00");
  assert.equal(retained.unitCost, "$12.00");
  assert.equal(retained.grossProfit, "+$16.00");
  assert.equal(retained.state, "retained");
  assert.doesNotMatch(retained.note, /previous/i);

  const nextActive = createDisplay({
    view: {
      activeBiddingVariationNumber: 226,
      activeAuctionMapping: null,
    },
    liveAuction: {
      variationNumber: 225,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });

  assert.equal(nextActive.variationLabel, "Variation #226");
  assert.equal(nextActive.currentBid, "\u2014");
  assert.equal(nextActive.unitCost, "\u2014");
  assert.equal(nextActive.grossProfit, "\u2014");
  assert.equal(nextActive.state, "waiting");
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
    },
    liveAuction: staleCost,
  });

  assert.equal(unmapped.currentBid, "$28.00");
  assert.equal(unmapped.unitCost, "\u2014");
  assert.equal(unmapped.grossProfit, "\u2014");
  assert.equal(unmapped.state, "unmapped");
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
  assert.match(html, /id="live-auction-title">Variation # -</);
  assert.match(html, />\s*Current bid\s*</);
  assert.match(html, />\s*Unit cost\s*</);
  assert.match(html, />\s*Live gross profit\s*</);
  assert.match(html, /id="live-auction-note"[\s\S]*?aria-live="polite"/);
  assert.match(css, /\.live-auction-values\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.live-auction-values \[data-tone="positive"\]/);
  assert.match(css, /\.live-auction-values \[data-tone="negative"\]/);
  assert.match(css, /\.live-auction-indicator[\s\S]*?#667386/);
  assert.match(source, /function renderLiveAuction\(view\)/);
  assert.match(source, /liveBidClient\.getLiveBid\(\)/);
  assert.match(source, /liveAuctionTitle\.textContent = display\.variationLabel/);
  assert.match(source, /message\.event\.type === "live_bid_changed"/);
  assert.match(
    source,
    /isLiveBidChangedNotification\(message, sender\)[\s\S]*?scheduleLiveBidRefresh\(\)[\s\S]*?return false;[\s\S]*?isCaptureStateChangedNotification/,
    "live bid notifications must bypass the full reconciliation refresh",
  );
});
