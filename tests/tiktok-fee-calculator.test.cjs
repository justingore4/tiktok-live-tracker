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
