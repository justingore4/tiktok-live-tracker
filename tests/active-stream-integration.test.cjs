const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationStorage = require(
  "../extension/shared/reconciliation-storage.js"
);
const reconciliationCoordinator = require(
  "../extension/shared/reconciliation-coordinator.js"
);
const streamSession = require("../extension/shared/stream-session.js");
const streamSessionStorage = require(
  "../extension/shared/stream-session-storage.js"
);
const streamSessionCoordinator = require(
  "../extension/shared/stream-session-coordinator.js"
);

const FIRST_ID = "local-stream:11111111-1111-4111-8111-111111111111";
const SECOND_ID = "local-stream:22222222-2222-4222-8222-222222222222";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorageArea() {
  const values = {};

  return {
    values,
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
    },
    async set(entries) {
      Object.assign(values, clone(entries));
    },
  };
}

function createStreamCoordinator(storageArea, ids) {
  let index = 0;
  const stateStore = streamSessionStorage.createStreamSessionStateStore({
    storageArea,
    streamSession,
  });

  return streamSessionCoordinator.createStreamSessionCoordinator({
    streamSession,
    stateStore,
    createId: () => ids[index++],
    now: () => "2026-08-08T20:00:00.000Z",
  });
}

test("ending and starting tracker streams preserves reconciliation history", async () => {
  const storageArea = createStorageArea();
  const stateStore = reconciliationStorage.createReconciliationStateStore({
    storageArea,
    reconciliation,
  });
  const stateCoordinator =
    reconciliationCoordinator.createReconciliationCoordinator({
      reconciliation,
      stateStore,
    });
  const activeStreams = createStreamCoordinator(storageArea, [
    FIRST_ID,
    SECOND_ID,
  ]);
  const inventory = [
    {
      sku: "TEST-SKU-M",
      name: "Test item",
      size: "M",
      quantityReceived: 2,
      unitCostCents: 1200,
    },
  ];

  await stateCoordinator.dispatch({ type: "initialize_state", inventory });
  const firstSession = await activeStreams.dispatch({ type: "start_stream" });

  assert.equal(firstSession.state.activeSession.streamId, FIRST_ID);
  await stateCoordinator.dispatch({
    type: "map_variation",
    streamId: FIRST_ID,
    variationNumber: 203,
    sku: "TEST-SKU-M",
  });
  const beforeEnd = await stateCoordinator.dispatch({ type: "get_state" });

  await activeStreams.dispatch({ type: "end_stream", streamId: FIRST_ID });
  const afterEnd = await stateCoordinator.dispatch({ type: "get_state" });

  assert.deepEqual(afterEnd.state, beforeEnd.state);

  const secondSession = await activeStreams.dispatch({ type: "start_stream" });

  assert.equal(secondSession.state.activeSession.streamId, SECOND_ID);
  await stateCoordinator.dispatch({
    type: "map_variation",
    streamId: SECOND_ID,
    variationNumber: 203,
    sku: "TEST-SKU-M",
  });
  const finalState = await stateCoordinator.dispatch({ type: "get_state" });

  assert.deepEqual(
    finalState.state.streams.map((stream) => stream.streamId),
    [FIRST_ID, SECOND_ID],
  );
  assert.equal(finalState.state.streams[0].variations[0].variationNumber, 203);
  assert.equal(finalState.state.streams[1].variations[0].variationNumber, 203);
  assert.notEqual(
    reconciliationStorage.STORAGE_KEY,
    streamSessionStorage.STORAGE_KEY,
  );
});
