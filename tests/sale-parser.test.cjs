const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeWhitespace,
  parseMoneyToCents,
  parseSoldItemText,
} = require("../extension/shared/sale-parser.js");

const completedSaleFixture = fs.readFileSync(
  path.join(__dirname, "fixtures", "payment-complete-row.txt"),
  "utf8",
);

test("parses a completed sale captured from the Sold items panel", () => {
  assert.deepEqual(parseSoldItemText(completedSaleFixture), {
    variationNumber: 250,
    soldPriceCents: 4800,
    paymentStatus: "payment_complete",
  });
});

test("normalizes whitespace before matching the row text", () => {
  const text = `
    Example\u00a0Buyer   has won:   $1,234.50
    Variation:   #248
    Payment complete
  `;

  assert.deepEqual(parseSoldItemText(text), {
    variationNumber: 248,
    soldPriceCents: 123450,
    paymentStatus: "payment_complete",
  });
});

test("does not mark a sale complete without the exact payment text", () => {
  const text = "Example Buyer has won: $20.00 Variation: #12 Awaiting payment";

  assert.deepEqual(parseSoldItemText(text), {
    variationNumber: 12,
    soldPriceCents: 2000,
    paymentStatus: "unknown",
  });
});

test("rejects text without both a variation number and sold price", () => {
  assert.equal(parseSoldItemText("Variation: #12 Payment complete"), null);
  assert.equal(parseSoldItemText("Example Buyer has won: $20.00"), null);
});

test("rejects an ancestor containing text from multiple sale rows", () => {
  const text = `
    Buyer One has won: $20.00 Variation: #12 Payment complete
    Buyer Two has won: $25.00 Variation: #13 Payment complete
  `;

  assert.equal(parseSoldItemText(text), null);
});

test("rejects variation number zero", () => {
  assert.equal(
    parseSoldItemText(
      "Example Buyer has won: $20.00 Variation: #0 Payment complete",
    ),
    null,
  );
});

test("converts supported currency strings to integer cents", () => {
  assert.equal(parseMoneyToCents("38.00"), 3800);
  assert.equal(parseMoneyToCents("1,234.5"), 123450);
  assert.equal(parseMoneyToCents("not money"), null);
});

test("parses visually separate variation and completed badge siblings flattened by textContent", () => {
  assert.deepEqual(
    parseSoldItemText(
      "Dobo93 has won: $11.00 Variation: #147Payment complete",
    ),
    {
      variationNumber: 147,
      soldPriceCents: 1100,
      paymentStatus: "payment_complete",
    },
  );
});

test("normalizes line breaks and repeated spaces", () => {
  assert.equal(normalizeWhitespace("  one\n\n two   three "), "one two three");
});
