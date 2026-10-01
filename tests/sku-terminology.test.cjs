const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const liveAuctionViewModel = require("../extension/tagger/live-auction-view-model.js");
const selectorViewModel = require("../extension/tagger/variation-selector-view-model.js");
const { parseSoldItemText } = require("../extension/shared/sale-parser.js");

for (const relativePath of ["tagger/sidepanel.html", "report/report.html"]) {
  test(`${relativePath} uses SKU wording in static text and accessible labels`, () => {
    const html = fs.readFileSync(path.join(__dirname, "../extension", relativePath), "utf8")
      .replace(/<!--[\s\S]*?-->/g, "");
    const text = [...html.matchAll(/>([^<]+)</g)].map(match => match[1]);
    const labels = [...html.matchAll(/\b(?:aria-label|placeholder|title|alt)="([^"]*)"/g)]
      .map(match => match[1]);

    assert.doesNotMatch([...text, ...labels].join("\n"), /\b(?:variations?|vars?)\b/i);
    assert.match(text.join("\n"), /\bSKU\b/);
  });
}

test("SKU presentation preserves seller text and internal auction identities", () => {
  const inventory = [{
    sku: "VAR-SKU-M", item: "Variation tee", style: "Var print", size: "M",
    remainingQuantity: 4,
  }];
  const view = {
    activeBiddingVariationNumber: 50,
    activeAuctionMapping: { variationNumber: 50, sku: "VAR-SKU-M", unitCostCents: 200 },
    inventory,
  };
  const before = JSON.stringify(view);
  const display = liveAuctionViewModel.createDisplay({
    view,
    liveAuction: { variationNumber: 50, bidPriceCents: 500, unitCostCents: 200 },
    formatUsdCents: cents => `$${(cents / 100).toFixed(2)}`,
  });

  assert.equal(display.variationLabel, "SKU #50 Status | Variation tee - Var print");
  assert.equal(display.variationNumber, 50);
  assert.equal(display.currentBid, "$5.00");
  assert.equal(display.grossProfit, "+$3.00");
  assert.equal(JSON.stringify(view), before);

  const option = selectorViewModel.createOptionDisplay({
    ...inventory[0], variationNumber: 50, observedPaymentStatus: "payment_complete",
  }, { formatItemName: item => `${item.item} - ${item.style}` });
  assert.equal(option.variationNumber, 50);
  assert.equal(option.fullLabel, "#50 - complete - Variation tee - Var print, size M");
});

test("SKU UI terminology retains both dashboard label formats and capture field names", () => {
  for (const label of ["Variation", "SKU"]) {
    assert.deepEqual(parseSoldItemText(`Example Buyer has won: $5.00 ${label}: #50 Payment complete`), {
      variationNumber: 50,
      soldPriceCents: 500,
      paymentStatus: "payment_complete",
    });
  }
});
