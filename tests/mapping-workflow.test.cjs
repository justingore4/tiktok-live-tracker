const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  MOCK_INVENTORY,
} = require("../extension/tagger/inventory-view-model.js");
const {
  createMappingSession,
} = require("../extension/tagger/mapping-workflow.js");

const STREAM_ID = "demo-stream";
const VARIATION_NUMBER = 203;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSession() {
  return createMappingSession({
    inventory: MOCK_INVENTORY,
    reconciliation,
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });
}

test("initializes an isolated mapping session without creating an auction", () => {
  const inventoryBefore = clone(MOCK_INVENTORY);
  const session = createSession();

  assert.equal(session.streamId, STREAM_ID);
  assert.equal(session.variationNumber, VARIATION_NUMBER);
  assert.equal(session.getCurrentMapping(), null);
  assert.deepEqual(session.getStateSnapshot().streams, []);
  assert.deepEqual(clone(MOCK_INVENTORY), inventoryBefore);
});

test("maps an available inventory entry to the demo variation", () => {
  const session = createSession();
  const result = session.selectSku("STUSSY-TEE-BLACK-L");
  const auction = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "mapped");
  assert.equal(result.mapping.item, "Stussy tee");
  assert.equal(result.mapping.style, "black");
  assert.equal(result.mapping.size, "L");
  assert.equal(result.mapping.statusLabel, "Waiting for payment");
  assert.equal(auction.eventKey, "demo-stream:203");
  assert.equal(auction.sku, "STUSSY-TEE-BLACK-L");
  assert.equal(auction.status, "pending");
  assert.equal(auction.mappingStatus, "mapped");
  assert.equal(auction.paymentStatus, "unknown");
});

test("reselecting the same entry is idempotent", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const stateBefore = session.getStateSnapshot();
  const result = session.selectSku("STUSSY-TEE-BLACK-L");

  assert.equal(result.ok, true);
  assert.equal(result.action, "unchanged");
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
});

test("selecting another entry corrects the same variation mapping", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const result = session.selectSku("NIKE-HOODIE-GREY-XL");
  const state = session.getStateSnapshot();

  assert.equal(result.ok, true);
  assert.equal(result.action, "remapped");
  assert.equal(result.mapping.sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(state.streams.length, 1);
  assert.equal(state.streams[0].variations.length, 1);
  assert.equal(state.streams[0].variations[0].variationNumber, 203);
  assert.equal(state.streams[0].variations[0].sku, "NIKE-HOODIE-GREY-XL");
});

test("rejects sold-out and unknown entries without changing state", () => {
  const session = createSession();
  const stateBefore = session.getStateSnapshot();
  const soldOutResult = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const unknownResult = session.selectSku("NOT-IN-INVENTORY");

  assert.equal(soldOutResult.ok, false);
  assert.equal(soldOutResult.code, "SOLD_OUT");
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, "UNKNOWN_SKU");
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
  assert.equal(session.getCurrentMapping(), null);
});

test("a rejected correction preserves an existing valid mapping", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const stateBefore = session.getStateSnapshot();
  const result = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");

  assert.equal(result.ok, false);
  assert.equal(result.code, "SOLD_OUT");
  assert.equal(result.mapping.sku, "STUSSY-TEE-BLACK-L");
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
});

test("pending mapping does not create payment, profit, or inventory changes", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const state = session.getStateSnapshot();
  const auction = reconciliation.getAuction(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });
  const summary = reconciliation.calculateSummary(state, {
    streamId: STREAM_ID,
  });

  assert.equal(auction.soldPriceCents, null);
  assert.equal(auction.committedUnitCostCents, null);
  assert.equal(auction.profitCents, null);
  assert.equal(auction.committed, false);
  assert.equal(summary.totals.completedPaymentCount, 0);
  assert.equal(summary.totals.committedSalesCount, 0);
  assert.equal(summary.totals.completedGmvCents, 0);
  assert.equal(summary.totals.committedRevenueCents, 0);
  assert.equal(summary.totals.costOfGoodsCents, 0);
  assert.equal(summary.totals.profitCents, 0);
  assert.deepEqual(
    summary.inventory.map((entry) => entry.remainingQuantity),
    MOCK_INVENTORY.map((entry) => entry.quantityReceived),
  );
});
