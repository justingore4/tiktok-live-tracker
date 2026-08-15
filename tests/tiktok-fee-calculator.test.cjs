const assert = require("node:assert/strict");
const test = require("node:test");

const calculator = require(
  "../extension/shared/tiktok-fee-calculator.js"
);

test("calculates approximate whole-dollar fees from an exact Total GMV", () => {
  assert.deepEqual(calculator.calculateSixPercentGmvFees("$4,087.01"), {
    feesPaidDisplay: "≈$245",
    gmvAfterFeesDisplay: "≈$3,842",
  });
});

test("expands compact Total GMV displays without inventing cent precision", () => {
  assert.deepEqual(calculator.calculateSixPercentGmvFees("$6.83K"), {
    feesPaidDisplay: "≈$410",
    gmvAfterFeesDisplay: "≈$6,420",
  });
  assert.deepEqual(calculator.calculateSixPercentGmvFees("$1.25M"), {
    feesPaidDisplay: "≈$75,000",
    gmvAfterFeesDisplay: "≈$1,175,000",
  });
  assert.deepEqual(calculator.calculateSixPercentGmvFees("$1B"), {
    feesPaidDisplay: "≈$60,000,000",
    gmvAfterFeesDisplay: "≈$940,000,000",
  });
});

test("rounds each fee result to the nearest dollar and supports zero", () => {
  assert.deepEqual(calculator.calculateSixPercentGmvFees("$8.34"), {
    feesPaidDisplay: "≈$1",
    gmvAfterFeesDisplay: "≈$8",
  });
  assert.deepEqual(calculator.calculateSixPercentGmvFees("$0.00"), {
    feesPaidDisplay: "≈$0",
    gmvAfterFeesDisplay: "≈$0",
  });
});

test("fails closed for missing or noncanonical Total GMV displays", () => {
  for (const display of [
    null,
    undefined,
    "",
    " $6.83K ",
    "$1000.00",
    "$4.640K",
    "-$10.00",
    "$6.83K<script>",
  ]) {
    assert.equal(calculator.calculateSixPercentGmvFees(display), null);
  }
});

test("calculates estimated profit after fees from exact Total GMV and COGS", () => {
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$100.00", 1_000),
    "≈$84",
  );
});

test("calculates estimated profit after fees from compact Total GMV", () => {
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$6.83K", 32_000),
    "≈$6,100",
  );
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$1.25M", 75_000_000),
    "≈$425,000",
  );
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$1B", 900_000_000),
    "≈$931,000,000",
  );
});

test("supports zero and formats negative estimated profit after fees", () => {
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$0.00", 0),
    "≈$0",
  );
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$10.00", 3_000),
    "≈-$21",
  );
});

test("rounds positive and negative half dollars symmetrically", () => {
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$1.00", 44),
    "≈$1",
  );
  assert.equal(
    calculator.calculateEstimatedProfitAfterFees("$1.00", 144),
    "≈-$1",
  );
});

test("fails closed for invalid Total GMV or COGS inputs", () => {
  for (const [display, costOfGoodsCents] of [
    [null, 0],
    ["$1000.00", 0],
    ["$10.00", -1],
    ["$10.00", 1.5],
    ["$10.00", Number.NaN],
    ["$10.00", Number.POSITIVE_INFINITY],
    ["$10.00", "100"],
    ["$10.00", Number.MAX_SAFE_INTEGER + 1],
  ]) {
    assert.equal(
      calculator.calculateEstimatedProfitAfterFees(
        display,
        costOfGoodsCents,
      ),
      null,
    );
  }
});
