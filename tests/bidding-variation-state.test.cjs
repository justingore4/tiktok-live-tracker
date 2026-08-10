const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  COMMAND_TYPES,
  ReconciliationCoordinatorError,
  createReconciliationCoordinator,
} = require("../extension/shared/reconciliation-coordinator.js");

const STREAM_ID = "live-stream";
const INVENTORY = [{
  sku: "STUSSY-BLACK-L",
  name: "Stussy tee - black",
  size: "L",
  quantityReceived: 5,
  unitCostCents: 1200,
}];

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createState() {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.pinStreamToInventoryBaseline(state, { streamId: STREAM_ID });
  return state;
}

function streamFrom(state) {
  return state.streams.find((stream) => stream.streamId === STREAM_ID);
}

test("bidding observation creates an unmapped auction and exposes one idempotent marker", () => {
  const state = createState();
  const first = reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });
  const afterFirst = clone(state);
  const repeated = reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });
  const summary = reconciliation.calculateSummary(state, {
    streamId: STREAM_ID,
  });

  assert.deepEqual(first, { status: "observed", variationNumber: 252 });
  assert.deepEqual(repeated, {
    status: "already_observed",
    variationNumber: 252,
  });
  assert.deepEqual(state, afterFirst);
  assert.equal(streamFrom(state).activeBiddingVariationNumber, 252);
  assert.equal(summary.activeBiddingVariationNumber, 252);
  assert.equal(summary.auctions.length, 1);
  assert.equal(summary.auctions[0].variationNumber, 252);
  assert.equal(summary.auctions[0].status, "unmapped");
});

test("a new bidding marker replaces the old marker without losing either mapping", () => {
  const state = createState();

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });
  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
    sku: "STUSSY-BLACK-L",
  });
  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 253,
  });

  assert.equal(streamFrom(state).activeBiddingVariationNumber, 253);
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: 252,
    }).sku,
    "STUSSY-BLACK-L",
  );
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: 253,
    }).sku,
    null,
  );
});

test("Sold Items payment truth clears bidding while preserving the auction and mapping", () => {
  const state = createState();

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });
  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
    sku: "STUSSY-BLACK-L",
  });
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [{
      variationNumber: 252,
      observedPaymentStatus:
        reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    }],
  });

  assert.equal(streamFrom(state).activeBiddingVariationNumber, null);
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: 252,
    }).sku,
    "STUSSY-BLACK-L",
  );

  const beforeStaleCard = clone(state);
  const stale = reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });

  assert.deepEqual(stale, {
    status: "ignored_sold_variation",
    variationNumber: 252,
  });
  assert.deepEqual(state, beforeStaleCard);
});

test("priced completion clears bidding and a stale completed card cannot reactivate it", () => {
  const state = createState();

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
    soldPriceCents: 1900,
  });

  assert.equal(streamFrom(state).activeBiddingVariationNumber, null);
  assert.equal(
    reconciliation.observeBiddingVariation(state, {
      streamId: STREAM_ID,
      variationNumber: 252,
    }).status,
    "ignored_sold_variation",
  );
  assert.equal(streamFrom(state).activeBiddingVariationNumber, null);
});

test("v5 streams migrate with no bidding marker and canonical v7 markers are strict", () => {
  const state = createState();

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 252,
  });
  const v5 = clone(state);
  v5.version = 5;
  delete v5.streams[0].activeBiddingVariationNumber;

  const migrated = reconciliation.hydrateReconciliationState(v5);

  assert.equal(migrated.version, reconciliation.STATE_VERSION);
  assert.equal(migrated.streams[0].activeBiddingVariationNumber, null);

  const missingMarker = clone(state);
  delete missingMarker.streams[0].activeBiddingVariationNumber;
  assert.throws(
    () => reconciliation.hydrateReconciliationState(missingMarker),
    (error) =>
      error instanceof reconciliation.ReconciliationError &&
      error.code === "INVALID_STATE",
  );

  const unknownMarker = clone(state);
  unknownMarker.streams[0].activeBiddingVariationNumber = 999;
  assert.throws(
    () => reconciliation.hydrateReconciliationState(unknownMarker),
    (error) =>
      error instanceof reconciliation.ReconciliationError &&
      error.code === "INVALID_STATE",
  );

  const completedMarker = clone(state);
  completedMarker.streams[0].variations[0].paymentStatus = "payment_complete";
  completedMarker.streams[0].variations[0].observedPaymentStatus =
    "payment_complete";
  completedMarker.streams[0].variations[0].soldPriceCents = 1900;
  assert.throws(
    () => reconciliation.hydrateReconciliationState(completedMarker),
    (error) =>
      error instanceof reconciliation.ReconciliationError &&
      error.code === "INVALID_STATE",
  );

  const observedMarker = clone(state);
  observedMarker.streams[0].variations[0].observedPaymentStatus =
    "payment_processing";
  assert.throws(
    () => reconciliation.hydrateReconciliationState(observedMarker),
    (error) =>
      error instanceof reconciliation.ReconciliationError &&
      error.code === "INVALID_STATE",
  );

  observedMarker.version = 6;
  assert.equal(
    reconciliation.hydrateReconciliationState(observedMarker)
      .streams[0].activeBiddingVariationNumber,
    null,
  );
});

test("coordinator persists the exact bidding command once and rejects extra data", async () => {
  let persisted = createState();
  const saves = [];
  const coordinator = createReconciliationCoordinator({
    reconciliation,
    stateStore: {
      async loadState() {
        return clone(persisted);
      },
      async saveState(state) {
        persisted = clone(state);
        saves.push(clone(state));
      },
    },
  });
  const command = {
    type: COMMAND_TYPES.OBSERVE_BIDDING_VARIATION,
    streamId: STREAM_ID,
    variationNumber: 252,
  };

  const first = await coordinator.dispatch(command);
  const repeated = await coordinator.dispatch(command);

  assert.equal(first.result.status, "observed");
  assert.equal(repeated.result.status, "already_observed");
  assert.equal(first.state.streams[0].activeBiddingVariationNumber, 252);
  assert.equal(saves.length, 1);

  await assert.rejects(
    coordinator.dispatch({ ...command, rawText: "buyer bid on item" }),
    (error) =>
      error instanceof ReconciliationCoordinatorError &&
      error.code === "INVALID_COMMAND",
  );
  assert.equal(saves.length, 1);
});
