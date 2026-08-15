const assert = require("node:assert/strict");
const test = require("node:test");

const liveBidCoordinatorModule = require(
  "../extension/shared/live-bid-coordinator.js",
);
const liveBidStorage = require("../extension/shared/live-bid-storage.js");

const STREAM_ONE = "local-stream:11111111-1111-4111-8111-111111111111";
const STREAM_TWO = "local-stream:22222222-2222-4222-8222-222222222222";

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createMemoryStorageArea() {
  const values = {};
  const calls = { get: [], remove: [], set: [] };

  return {
    calls,
    storageArea: {
      async get(key) {
        calls.get.push(key);
        return Object.prototype.hasOwnProperty.call(values, key)
          ? { [key]: clone(values[key]) }
          : {};
      },
      async set(entries) {
        calls.set.push(clone(entries));
        Object.assign(values, clone(entries));
      },
      async remove(key) {
        calls.remove.push(key);
        delete values[key];
      },
    },
  };
}

function createCoordinatorHarness(options = {}) {
  const memory = options.memory ?? createMemoryStorageArea();
  const liveBidStore = liveBidStorage.createLiveBidStore({
    storageArea: memory.storageArea,
  });
  const stateCalls = [];
  const sessionCalls = [];
  let activeStreamId = options.activeStreamId ?? STREAM_ONE;
  let activeVariationNumber = options.activeVariationNumber ?? 203;
  let latestVariationNumber = activeVariationNumber ?? 203;
  let mappedSku = options.mappedSku ?? null;
  const reconciliation = {
    hydrateReconciliationState(value) {
      return clone(value);
    },
  };
  const reconciliationCoordinator = {
    COMMAND_TYPES: { GET_STATE: "get_state" },
  };
  const stateCoordinator = {
    async dispatch(command) {
      stateCalls.push(clone(command));
      return {
        state: {
          inventoryBaselines: [
            {
              baselineId: "baseline:one",
              inventory: [
                { sku: "TEE-L", unitCostCents: 1200 },
              ],
            },
          ],
          streams: activeStreamId === null
            ? []
            : [
                {
                  streamId: activeStreamId,
                  inventoryBaselineId: "baseline:one",
                  activeBiddingVariationNumber: activeVariationNumber,
                  variations: [
                    {
                      variationNumber: latestVariationNumber,
                      sku: mappedSku,
                    },
                  ],
                },
              ],
        },
        result: null,
      };
    },
  };
  const streamSession = {
    hydrateStreamSessionState(value) {
      return clone(value);
    },
  };
  const streamSessionCoordinator = {
    COMMAND_TYPES: { GET_STREAM_SESSION: "get_stream_session" },
  };
  const activeStreamCoordinator = {
    async dispatch(command) {
      sessionCalls.push(clone(command));
      return {
        state: {
          version: 1,
          activeSession: activeStreamId === null
            ? null
            : { streamId: activeStreamId },
        },
        result: null,
      };
    },
  };
  const coordinator = liveBidCoordinatorModule.createLiveBidCoordinator({
    activeStreamCoordinator,
    liveBidStore,
    reconciliation,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });

  return {
    coordinator,
    memory,
    sessionCalls,
    stateCalls,
    setActiveStreamId(value) {
      activeStreamId = value;
    },
    setActiveVariationNumber(value) {
      activeVariationNumber = value;

      if (value !== null) {
        latestVariationNumber = value;
      }
    },
    setMappedSku(value) {
      mappedSku = value;
    },
  };
}

test("session storage keeps exactly one strict stream-scoped live auction", async () => {
  const memory = createMemoryStorageArea();
  const store = liveBidStorage.createLiveBidStore({
    storageArea: memory.storageArea,
  });

  assert.equal(await store.loadLiveBid(), null);
  await store.saveLiveBid({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
    unitCostCents: null,
  });
  assert.deepEqual(await store.loadLiveBid(), {
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
    unitCostCents: null,
  });

  await store.saveLiveBid({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 3100,
    unitCostCents: 1200,
  });
  assert.equal(memory.calls.set.length, 2);
  assert.equal((await store.loadLiveBid()).bidPriceCents, 3100);

  await assert.rejects(
    () =>
      store.saveLiveBid({
        streamId: STREAM_ONE,
        variationNumber: 203,
        bidPriceCents: 0,
        unitCostCents: null,
      }),
    (error) =>
      error instanceof liveBidStorage.LiveBidStorageError &&
      error.code === "INVALID_LIVE_AUCTION",
  );
});

test("session storage safely reads the version-one bid as an unmapped auction", async () => {
  const memory = createMemoryStorageArea();

  await memory.storageArea.set({
    [liveBidStorage.STORAGE_KEY]: {
      schemaVersion: 1,
      liveBid: {
        streamId: STREAM_ONE,
        variationNumber: 203,
        bidPriceCents: 2800,
      },
    },
  });

  const store = liveBidStorage.createLiveBidStore({
    storageArea: memory.storageArea,
  });

  assert.deepEqual(await store.loadLiveBid(), {
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
    unitCostCents: null,
  });
});

test("repeated live prices seed canonical state once and never pin or write reconciliation", async () => {
  const harness = createCoordinatorHarness();

  assert.deepEqual(
    await harness.coordinator.observe({
      streamId: STREAM_ONE,
      variationNumber: 203,
      bidPriceCents: 2800,
    }),
    { status: "accepted" },
  );
  await harness.coordinator.observe({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2900,
  });
  await harness.coordinator.observe({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 3000,
  });

  assert.deepEqual(harness.stateCalls, [{ type: "get_state" }]);
  assert.equal(harness.memory.calls.set.length, 4);
  assert.equal((await harness.coordinator.getLiveBid()).liveAuction.bidPriceCents, 3000);
  assert.deepEqual(harness.stateCalls, [{ type: "get_state" }]);
});

test("an exact retry is acknowledged without another session write or invalidation", async () => {
  const harness = createCoordinatorHarness();
  const bid = {
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
  };

  assert.deepEqual(await harness.coordinator.observe(bid), {
    status: "accepted",
  });
  assert.deepEqual(await harness.coordinator.observe(bid), {
    status: "unchanged",
  });
  assert.equal(harness.memory.calls.set.length, 2);
  assert.equal(harness.stateCalls.length, 1);

  const restartedWorker = createCoordinatorHarness({ memory: harness.memory });

  assert.deepEqual(await restartedWorker.coordinator.observe(bid), {
    status: "unchanged",
  });
  assert.equal(harness.memory.calls.set.length, 2);
  assert.equal(restartedWorker.stateCalls.length, 1);
});

test("a synchronized active marker creates a placeholder and avoids the first canonical read", async () => {
  const harness = createCoordinatorHarness();

  assert.deepEqual(
    await harness.coordinator.synchronize({
      streamId: STREAM_ONE,
      state: {
        streams: [
          {
            streamId: STREAM_ONE,
            activeBiddingVariationNumber: 204,
          },
        ],
      },
    }),
    { status: "accepted" },
  );
  assert.deepEqual(
    await harness.coordinator.observe({
      streamId: STREAM_ONE,
      variationNumber: 204,
      bidPriceCents: 1000,
    }),
    { status: "accepted" },
  );
  assert.equal(harness.stateCalls.length, 0);
});

test("stale variation prices are ignored without writes beyond the new placeholder", async () => {
  const harness = createCoordinatorHarness();

  await harness.coordinator.synchronize({
    streamId: STREAM_ONE,
    state: {
      streams: [
        {
          streamId: STREAM_ONE,
          activeBiddingVariationNumber: 204,
        },
      ],
    },
  });

  assert.deepEqual(
    await harness.coordinator.observe({
      streamId: STREAM_ONE,
      variationNumber: 203,
      bidPriceCents: 9900,
    }),
    { status: "ignored" },
  );
  assert.equal(harness.memory.calls.set.length, 1);
  assert.equal(harness.stateCalls.length, 0);
});

test("GET retains the current stream auction between active variations", async () => {
  const harness = createCoordinatorHarness();

  await harness.coordinator.observe({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
  });
  assert.deepEqual(await harness.coordinator.dispatch({ type: "get_live_bid" }), {
    liveAuction: {
      variationNumber: 203,
      bidPriceCents: 2800,
      unitCostCents: null,
    },
  });

  harness.setActiveVariationNumber(204);
  await harness.coordinator.synchronize({
    streamId: STREAM_ONE,
    state: {
      streams: [
        {
          streamId: STREAM_ONE,
          activeBiddingVariationNumber: 204,
        },
      ],
    },
  });
  assert.deepEqual(await harness.coordinator.getLiveBid(), {
    liveAuction: {
      variationNumber: 204,
      bidPriceCents: null,
      unitCostCents: null,
    },
  });

  harness.setActiveVariationNumber(null);
  await harness.coordinator.synchronize({
    streamId: STREAM_ONE,
    state: {
      streams: [
        {
          streamId: STREAM_ONE,
          activeBiddingVariationNumber: null,
        },
      ],
    },
  });
  assert.deepEqual(await harness.coordinator.getLiveBid(), {
    liveAuction: {
      variationNumber: 204,
      bidPriceCents: null,
      unitCostCents: null,
    },
  });

  harness.setActiveStreamId(STREAM_TWO);
  assert.deepEqual(await harness.coordinator.getLiveBid(), { liveAuction: null });

  harness.setActiveStreamId(null);
  assert.deepEqual(await harness.coordinator.getLiveBid(), { liveAuction: null });
});

test("mapped cost is retained, remapped, and cleared without changing bid history", async () => {
  const harness = createCoordinatorHarness({ mappedSku: "TEE-L" });

  await harness.coordinator.observe({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
  });
  assert.deepEqual(await harness.coordinator.getLiveBid(), {
    liveAuction: {
      variationNumber: 203,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });

  harness.setActiveVariationNumber(null);
  await harness.coordinator.synchronize({
    streamId: STREAM_ONE,
    state: {
      inventoryBaselines: [
        {
          baselineId: "baseline:one",
          inventory: [{ sku: "TEE-L", unitCostCents: 1200 }],
        },
      ],
      streams: [
        {
          streamId: STREAM_ONE,
          inventoryBaselineId: "baseline:one",
          activeBiddingVariationNumber: null,
          variations: [{ variationNumber: 203, sku: "TEE-L" }],
        },
      ],
    },
  });
  assert.equal(
    (await harness.coordinator.getLiveBid()).liveAuction.unitCostCents,
    1200,
  );

  harness.setMappedSku(null);
  await harness.coordinator.synchronize({
    streamId: STREAM_ONE,
    state: {
      inventoryBaselines: [
        {
          baselineId: "baseline:one",
          inventory: [{ sku: "TEE-L", unitCostCents: 1200 }],
        },
      ],
      streams: [
        {
          streamId: STREAM_ONE,
          inventoryBaselineId: "baseline:one",
          activeBiddingVariationNumber: null,
          variations: [{ variationNumber: 203, sku: null }],
        },
      ],
    },
  });
  assert.deepEqual(await harness.coordinator.getLiveBid(), {
    liveAuction: {
      variationNumber: 203,
      bidPriceCents: 2800,
      unitCostCents: null,
    },
  });
});

test("an inactive retained auction survives panel and worker recreation in the browser session", async () => {
  const firstWorker = createCoordinatorHarness({ mappedSku: "TEE-L" });

  await firstWorker.coordinator.observe({
    streamId: STREAM_ONE,
    variationNumber: 203,
    bidPriceCents: 2800,
  });
  firstWorker.setActiveVariationNumber(null);
  await firstWorker.coordinator.synchronize({
    streamId: STREAM_ONE,
    state: {
      inventoryBaselines: [
        {
          baselineId: "baseline:one",
          inventory: [{ sku: "TEE-L", unitCostCents: 1200 }],
        },
      ],
      streams: [
        {
          streamId: STREAM_ONE,
          inventoryBaselineId: "baseline:one",
          activeBiddingVariationNumber: null,
          variations: [{ variationNumber: 203, sku: "TEE-L" }],
        },
      ],
    },
  });

  const restartedWorker = createCoordinatorHarness({
    mappedSku: "TEE-L",
    memory: firstWorker.memory,
  });
  restartedWorker.setActiveVariationNumber(null);

  assert.deepEqual(await restartedWorker.coordinator.getLiveBid(), {
    liveAuction: {
      variationNumber: 203,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });
  assert.deepEqual(restartedWorker.stateCalls, [{ type: "get_state" }]);
});
