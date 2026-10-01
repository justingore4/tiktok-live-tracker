const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeWhitespace,
  parseMoneyToCents,
  parseProcessingItemText,
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

test("processing prices require the exact row's single explicit winning amount", () => {
  for (const status of ["Payment processing...", "Order processing", "Payment fixing", "Payment failed"]) {
    assert.deepEqual(parseProcessingItemText(
      `Buyer has won: $1,234.50 Variation: #17${status}`,
    ), { variationNumber: 17, processingPriceCents: 123450 });
  }
  assert.deepEqual(parseProcessingItemText(
    "Buyer has won: $25Variation: #17 Payment processing Shipping: $5 Total: $30",
  ), { variationNumber: 17, processingPriceCents: 2500 });
});

test("processing prices reject malformed, zero, ambiguous and unrelated monetary values", () => {
  for (const amount of ["0", "0.00", "-5", "+5", "1,00", "5.999", "5.0.0", "5e3", "NaN", "9007199254740992"]) {
    assert.equal(parseProcessingItemText(`Buyer has won: $${amount} Variation: #17 Payment processing`), null, amount);
  }
  for (const value of [
    "Variation: #17 Payment processing Unit cost: $5 Shipping: $5 Total: $20 Bids: $10",
    "Buyer has won: $20 Variation: #17 Payment processing Buyer has won: $30",
    "Buyer has won: $20 Variation: #17 Payment processing Variation: #18",
    "Buyer has won: $20 Variation: #0 Payment processing",
    "Buyer has won: $20 Variation: #9007199254740992 Payment processing",
  ]) assert.equal(parseProcessingItemText(value), null, value);
});

test("both numeric auction labels produce identical completed and processing parser results", () => {
  for (const label of ["Variation: #38", "SKU: #38", "sku : # 38", "sKu\u00a0:\n#\t00038"]) {
    assert.deepEqual(parseSoldItemText(`Buyer has won: $12.50 ${label} Payment complete`), {
      variationNumber: 38, soldPriceCents: 1250, paymentStatus: "payment_complete",
    }, label);
    assert.deepEqual(parseProcessingItemText(`Buyer has won: $12.50 ${label} Payment processing`), {
      variationNumber: 38, processingPriceCents: 1250,
    }, label);
  }
});

test("completed SKU labels support flattened payment and winner-price sibling boundaries", () => {
  for (const label of ["Variation", "SKU", "sku"]) {
    for (const text of [
      `Buyer has won: $12.50 ${label}: #38Payment complete`,
      `Buyer has won: $12.50${label}: #38 Payment complete`,
      `Buyer has won: $ 12.50${label}: #38Payment complete`,
      `Buyer has won: $1,234.50${label}: #38Payment complete`,
    ]) {
      assert.deepEqual(parseSoldItemText(text), {
        variationNumber: 38,
        soldPriceCents: text.includes("1,234") ? 123450 : 1250,
        paymentStatus: "payment_complete",
      }, text);
    }
  }
});

test("processing SKU labels support each existing flattened status and winner-price boundary", () => {
  for (const label of ["Variation", "SKU", "sku"]) {
    for (const status of ["Payment processing...", "Payment processing…", "Order processing", "Payment fixing", "Payment failed"]) {
      for (const price of ["$12.50", "$ 12.50"]) {
        assert.deepEqual(parseProcessingItemText(`Buyer has won: ${price}${label}: #38${status}`), {
          variationNumber: 38, processingPriceCents: 1250,
        }, `${label} / ${status} / ${price}`);
      }
    }
  }
});

test("SKU compatibility preserves exact completion detection and context-independent auxiliary prices", () => {
  for (const status of ["Awaiting payment", "Payment processing", "Order processing", "Payment fixing", "Payment failed", "Canceled", "Cancelled", ""]) {
    const text = `Buyer has won: $20.00 SKU: #38 ${status}`;
    assert.deepEqual(parseSoldItemText(text), {
      variationNumber: 38, soldPriceCents: 2000, paymentStatus: "unknown",
    }, status);
    assert.deepEqual(parseProcessingItemText(text), {
      variationNumber: 38, processingPriceCents: 2000,
    }, status);
  }
  assert.deepEqual(parseSoldItemText("Buyer has won: $0 SKU: #38 Payment complete"), {
    variationNumber: 38, soldPriceCents: 0, paymentStatus: "payment_complete",
  });
  assert.equal(parseProcessingItemText("Buyer has won: $0 SKU: #38 Payment processing"), null);
});

test("numeric SKU auction IDs retain positive safe-integer bounds and require colon and hash", () => {
  for (const label of [
    "SKU: #0", "SKU: #000", "SKU: #-38", "SKU: #+38", "SKU: #9007199254740992",
    "SKU #38", "SKU: 38", "SKU 38", "SKU：#38", "SKU: #", "SKU: #NaN",
  ]) {
    const text = `Buyer has won: $20 ${label} Payment complete`;
    assert.equal(parseSoldItemText(text), null, label);
    assert.equal(parseProcessingItemText(text), null, label);
  }
  const maximum = `Buyer has won: $20 SKU: #${Number.MAX_SAFE_INTEGER} Payment complete`;
  assert.equal(parseSoldItemText(maximum).variationNumber, Number.MAX_SAFE_INTEGER);
  assert.equal(parseProcessingItemText(maximum).variationNumber, Number.MAX_SAFE_INTEGER);
});

test("ordinary SKU values and partial numeric SKU tokens are not auction labels", () => {
  for (const label of [
    "SKU: TEE-M", "SKU: #TEE-M", "SKU: 38-XL", "SKU: #38-XL", "SKU: #38_XL",
    "SKU: #38.5", "SKU: #38,500", "SKU: #38/XL", "SKU: #38e2", "SKU: #38ABC",
    "Product SKU count: #38", "SKUs: #38", "InventorySKU: #38", "Product #38",
  ]) {
    const text = `Buyer has won: $20 ${label} Payment complete`;
    assert.equal(parseSoldItemText(text), null, label);
    assert.equal(parseProcessingItemText(text), null, label);
  }
  const withInventorySku = "Buyer has won: $20 SKU: #38-XL Variation: #17 Payment complete";
  assert.equal(parseSoldItemText(withInventorySku).variationNumber, 17);
  assert.equal(parseProcessingItemText(withInventorySku).variationNumber, 17);
});

test("both parsers reject repeated and mixed numeric identifiers even when their numbers agree", () => {
  for (const labels of [
    "SKU: #38 SKU: #38", "SKU: #38 SKU: #39",
    "Variation: #38 SKU: #38", "Variation: #38 SKU: #39",
    "SKU: #38 Variation: #38", "SKU: #38 Variation: #39",
  ]) {
    const text = `Buyer has won: $20 ${labels} Payment complete`;
    assert.equal(parseSoldItemText(text), null, labels);
    assert.equal(parseProcessingItemText(text), null, labels);
  }
});

test("SKU labels retain multiple-price rejection and require the explicit winner amount", () => {
  for (const text of [
    "Buyer has won: $20 SKU: #38 Payment complete Buyer has won: $30",
    "Buyer has won: $20 SKU: #38Payment complete Buyer has won: $30 SKU: #39Payment complete",
    "Buyer has won: $20 Variation: #37Payment complete Buyer has won: $30 SKU: #38Payment complete",
    "SKU: #38 Payment complete Unit cost: $5 Shipping: $5 Total: $20 Bids: $10",
    "SKU: #38 Payment complete",
  ]) {
    assert.equal(parseSoldItemText(text), null, text);
    assert.equal(parseProcessingItemText(text), null, text);
  }
  assert.equal(parseSoldItemText("Buyer has won: $20 SKU: #38 Payment complete Payment complete"), null);
  assert.deepEqual(parseProcessingItemText("Buyer has won: $20SKU: #38 Payment processing Shipping: $5 Total: $25"), {
    variationNumber: 38, processingPriceCents: 2000,
  });
});

test("SKU processing prices keep strict money validation at flattened and ordinary boundaries", () => {
  for (const amount of ["0", "0.00", "-5", "+5", "1,00", "5.999", "5.0.0", "5e3", "NaN", "9007199254740992"]) {
    for (const separator of ["", " "]) {
      const text = `Buyer has won: $${amount}${separator}SKU: #38 Payment processing`;
      assert.equal(parseProcessingItemText(text), null, text);
    }
  }
});
