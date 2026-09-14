const assert = require("node:assert/strict");
const test = require("node:test");

const coordinatorModule = require(
  "../extension/shared/next-item-queue-coordinator.js"
);
const protocol = require(
  "../extension/shared/next-item-queue-protocol.js"
);
const storageModule = require(
  "../extension/shared/next-item-queue-storage.js"
);
const reconciliation = require("../extension/shared/reconciliation.js");

const STREAM_ONE = "local-stream:11111111-1111-4111-8111-111111111111";
const STREAM_TWO = "local-stream:22222222-2222-4222-8222-222222222222";

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createMemoryStorageArea() {
  const values = {};
  const calls = { get: [], remove: [], set: [] };
  let failNextGet = false;
  let failNextRemove = false;
  let failNextSet = false;

  return {
    calls,
    values,
    failNextGet() {
      failNextGet = true;
    },
    failNextRemove() {
      failNextRemove = true;
    },
    failNextSet() {
      failNextSet = true;
    },
    storageArea: {
      async get(key) {
        calls.get.push(key);

        if (failNextGet) {
          failNextGet = false;
          throw new Error("read failed");
        }

        return Object.prototype.hasOwnProperty.call(values, key)
          ? { [key]: clone(values[key]) }
          : {};
      },
      async set(entries) {
        calls.set.push(clone(entries));

        if (failNextSet) {
          failNextSet = false;
          throw new Error("write failed");
        }

        Object.assign(values, clone(entries));
      },
      async remove(key) {
        calls.remove.push(key);

        if (failNextRemove) {
          failNextRemove = false;
          throw new Error("remove failed");
        }

        delete values[key];
      },
    },
  };
}

function createInventory() {
  return [
    {
      sku: "TEE-M",
      name: "Tee",
      size: "M",
      quantityReceived: 10,
      unitCostCents: 1000,
    },
    {
      sku: "TEE-L",
      name: "Tee",
      size: "L",
      quantityReceived: 10,
      unitCostCents: 1100,
    },
  ];
}

function createCoordinatorHarness(options = {}) {
  const memory = options.memory ?? createMemoryStorageArea();
  const queueStore = storageModule.createNextItemQueueStore({
    storageArea: memory.storageArea,
  });
  let state = options.state === undefined
    ? reconciliation.createReconciliationState(createInventory())
    : reconciliation.hydrateReconciliationState(options.state);
  let activeStreamId = options.activeStreamId === undefined
    ? STREAM_ONE
    : options.activeStreamId;
  const stateCalls = [];

  if (options.state === undefined) {
    reconciliation.observeBiddingVariation(state, {
      streamId: STREAM_ONE,
      variationNumber: 203,
    });

    if (options.mapCurrent !== false) {
      reconciliation.mapVariation(state, {
        streamId: STREAM_ONE,
        variationNumber: 203,
        sku: options.currentSku ?? "TEE-M",
      });
    }
  }

  const reconciliationCoordinator = {
    COMMAND_TYPES: {
      GET_STATE: "get_state",
      MAP_VARIATION: "map_variation",
      UNMAP_VARIATION: "unmap_variation",
    },
  };
  const stateCoordinator = {
    async dispatch(command) {
      stateCalls.push(clone(command));

      if (command.type === "get_state") {
        return { state: reconciliation.hydrateReconciliationState(state), result: null };
      }

      if (
        command.type !== "map_variation" &&
        command.type !== "unmap_variation"
      ) {
        throw new Error(`Unexpected command ${command.type}`);
      }

      const candidate = reconciliation.hydrateReconciliationState(state);
      const result = command.type === "map_variation"
        ? reconciliation.mapVariation(candidate, {
            streamId: command.streamId,
            variationNumber: command.variationNumber,
            sku: command.sku,
          })
        : reconciliation.unmapVariation(candidate, {
            streamId: command.streamId,
            variationNumber: command.variationNumber,
          });
      state = candidate;
      return {
        state: reconciliation.hydrateReconciliationState(state),
        result,
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
    async dispatch() {
      return {
        state: {
          activeSession: activeStreamId === null
            ? null
            : { streamId: activeStreamId },
        },
        result: null,
      };
    },
  };
  const coordinator = coordinatorModule.createNextItemQueueCoordinator({
    activeStreamCoordinator,
    protocol,
    queueStore,
    reconciliation,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
    ...(options.createQueueToken === undefined
      ? {}
      : { createQueueToken: options.createQueueToken }),
  });

  return {
    coordinator,
    memory,
    queueStore,
    stateCalls,
    getState() {
      return reconciliation.hydrateReconciliationState(state);
    },
    setActiveStreamId(value) {
      activeStreamId = value;
    },
    setState(value) {
      state = reconciliation.hydrateReconciliationState(value);
    },
  };
}

function toggleCommand(overrides = {}) {
  return {
    type: protocol.COMMAND_TYPES.TOGGLE_QUEUE,
    expectedStreamId: STREAM_ONE,
    expectedVariationNumber: 203,
    sku: "TEE-L",
    ...overrides,
  };
}

function mapCurrentCommand(overrides = {}) {
  return {
    type: protocol.COMMAND_TYPES.MAP_CURRENT,
    expectedStreamId: STREAM_ONE,
    expectedVariationNumber: 203,
    sku: "TEE-L",
    ...overrides,
  };
}

function snapshotQueue(harness) {
  return harness.coordinator.dispatch({ type: protocol.COMMAND_TYPES.GET_QUEUE_SNAPSHOT });
}

function clearCommand(snapshot, overrides = {}) {
  return {
    type: protocol.COMMAND_TYPES.CLEAR_QUEUE,
    expectedStreamId: STREAM_ONE,
    expectedQueueToken: snapshot.queueToken,
    sku: snapshot.queuedSku,
    ...overrides,
  };
}

function addBiddingVariation(state, variationNumber, sku = null) {
  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ONE,
    variationNumber,
  });

  if (sku !== null) {
    reconciliation.mapVariation(state, {
      streamId: STREAM_ONE,
      variationNumber,
      sku,
    });
  }

  return state;
}

function findAuction(state, variationNumber) {
  return state.streams
    .find((stream) => stream.streamId === STREAM_ONE)
    .variations.find((auction) => auction.variationNumber === variationNumber);
}

test("session store persists exactly one strict stream-scoped queue", async () => {
  const memory = createMemoryStorageArea();
  const store = storageModule.createNextItemQueueStore({
    storageArea: memory.storageArea,
  });

  assert.equal(await store.loadQueue(), null);
  assert.deepEqual(
    await store.saveQueue({
      streamId: STREAM_ONE,
      sku: "TEE-L",
      armedAfterVariationNumber: 203,
    }),
    {
      streamId: STREAM_ONE,
      sku: "TEE-L",
      armedAfterVariationNumber: 203,
    },
  );
  assert.deepEqual(await store.loadQueue(), {
    streamId: STREAM_ONE,
    sku: "TEE-L",
    armedAfterVariationNumber: 203,
  });
  assert.deepEqual(memory.values[storageModule.STORAGE_KEY], {
    schemaVersion: 1,
    queue: {
      streamId: STREAM_ONE,
      sku: "TEE-L",
      armedAfterVariationNumber: 203,
    },
  });

  await store.clearQueue();
  assert.equal(await store.loadQueue(), null);
});

test("session store fails closed on malformed values and envelopes", async () => {
  const memory = createMemoryStorageArea();
  const store = storageModule.createNextItemQueueStore({
    storageArea: memory.storageArea,
  });

  await assert.rejects(
    () =>
      store.saveQueue({
        streamId: STREAM_ONE,
        sku: "TEE-L",
        armedAfterVariationNumber: 0,
      }),
    (error) =>
      error instanceof storageModule.NextItemQueueStorageError &&
      error.code === "INVALID_NEXT_ITEM_QUEUE",
  );

  memory.values[storageModule.STORAGE_KEY] = {
    schemaVersion: 1,
    queue: {
      streamId: STREAM_ONE,
      sku: "TEE-L",
      armedAfterVariationNumber: 203,
      buyer: "must not persist",
    },
  };
  await assert.rejects(
    () => store.loadQueue(),
    (error) =>
      error instanceof storageModule.NextItemQueueStorageError &&
      error.code === "INVALID_NEXT_ITEM_QUEUE_STORAGE",
  );
});

test("toggle queues, replaces, and clears without changing the current mapping", async () => {
  const harness = createCoordinatorHarness();

  assert.deepEqual(
    await harness.coordinator.dispatch(toggleCommand()),
    { status: "queued", queuedSku: "TEE-L" },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-M");
  assert.deepEqual(
    await harness.coordinator.dispatch({
      type: protocol.COMMAND_TYPES.GET_QUEUE,
    }),
    { queuedSku: "TEE-L" },
  );

  assert.deepEqual(
    await harness.coordinator.dispatch(
      toggleCommand({ sku: "TEE-M" }),
    ),
    { status: "queued", queuedSku: "TEE-M" },
  );
  assert.deepEqual(await harness.queueStore.loadQueue(), {
    streamId: STREAM_ONE,
    sku: "TEE-M",
    armedAfterVariationNumber: 203,
  });

  assert.deepEqual(
    await harness.coordinator.dispatch(
      toggleCommand({ sku: "TEE-M" }),
    ),
    { status: "cleared", queuedSku: null },
  );
  assert.equal(await harness.queueStore.loadQueue(), null);
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-M");
});

test("map-current remaps the canonical current variation without touching the queue", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const storageCallCounts = {
    get: harness.memory.calls.get.length,
    remove: harness.memory.calls.remove.length,
    set: harness.memory.calls.set.length,
  };

  assert.deepEqual(
    await harness.coordinator.dispatch(mapCurrentCommand()),
    { status: "mapped_current", sku: "TEE-L" },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-L");
  assert.deepEqual(harness.stateCalls.at(-1), {
    type: "map_variation",
    streamId: STREAM_ONE,
    variationNumber: 203,
    sku: "TEE-L",
  });
  assert.deepEqual(
    {
      get: harness.memory.calls.get.length,
      remove: harness.memory.calls.remove.length,
      set: harness.memory.calls.set.length,
    },
    storageCallCounts,
  );
  assert.deepEqual(await harness.queueStore.loadQueue(), {
    streamId: STREAM_ONE,
    sku: "TEE-L",
    armedAfterVariationNumber: 203,
  });
});

test("map-current unmaps the canonical current item when it already matches", async () => {
  const harness = createCoordinatorHarness({ currentSku: "TEE-L" });
  await harness.coordinator.dispatch(toggleCommand());
  const stateCallCount = harness.stateCalls.length;
  const storageCallCounts = {
    get: harness.memory.calls.get.length,
    remove: harness.memory.calls.remove.length,
    set: harness.memory.calls.set.length,
  };

  assert.deepEqual(
    await harness.coordinator.dispatch(mapCurrentCommand()),
    { status: "unmapped_current", sku: "TEE-L" },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, null);
  assert.equal(harness.stateCalls.length, stateCallCount + 2);
  assert.deepEqual(harness.stateCalls.at(-1), {
    type: "unmap_variation",
    streamId: STREAM_ONE,
    variationNumber: 203,
  });
  assert.deepEqual(
    {
      get: harness.memory.calls.get.length,
      remove: harness.memory.calls.remove.length,
      set: harness.memory.calls.set.length,
    },
    storageCallCounts,
  );
  assert.deepEqual(await harness.queueStore.loadQueue(), {
    streamId: STREAM_ONE,
    sku: "TEE-L",
    armedAfterVariationNumber: 203,
  });
});

test("map-current rejects a stale variation before mapping or touching the queue", async () => {
  const harness = createCoordinatorHarness();
  const advancedState = addBiddingVariation(harness.getState(), 204);
  harness.setState(advancedState);
  const storageCallCounts = {
    get: harness.memory.calls.get.length,
    remove: harness.memory.calls.remove.length,
    set: harness.memory.calls.set.length,
  };

  await assert.rejects(
    () => harness.coordinator.dispatch(mapCurrentCommand()),
    (error) => error.code === "CURRENT_VARIATION_CHANGED",
  );
  assert.equal(findAuction(harness.getState(), 204).sku, null);
  assert.equal(
    harness.stateCalls.filter((command) => command.type === "map_variation")
      .length,
    0,
  );
  assert.deepEqual(
    {
      get: harness.memory.calls.get.length,
      remove: harness.memory.calls.remove.length,
      set: harness.memory.calls.set.length,
    },
    storageCallCounts,
  );
});

test("coordinator serializes simultaneous toggles and retains the newest choice", async () => {
  const harness = createCoordinatorHarness();
  const first = harness.coordinator.dispatch(toggleCommand({ sku: "TEE-L" }));
  const second = harness.coordinator.dispatch(toggleCommand({ sku: "TEE-M" }));

  assert.deepEqual(await first, { status: "queued", queuedSku: "TEE-L" });
  assert.deepEqual(await second, { status: "queued", queuedSku: "TEE-M" });
  assert.deepEqual(await harness.queueStore.loadQueue(), {
    streamId: STREAM_ONE,
    sku: "TEE-M",
    armedAfterVariationNumber: 203,
  });
});

test("toggle uses the newest recorded variation between auctions", async () => {
  const harness = createCoordinatorHarness();
  const state = harness.getState();
  state.streams[0].activeBiddingVariationNumber = null;
  harness.setState(state);

  assert.deepEqual(
    await harness.coordinator.dispatch(toggleCommand()),
    { status: "queued", queuedSku: "TEE-L" },
  );
  assert.equal(
    (await harness.queueStore.loadQueue()).armedAfterVariationNumber,
    203,
  );
});

test("toggle maps an unmapped current variation before it can queue", async () => {
  const harness = createCoordinatorHarness({ mapCurrent: false });

  assert.deepEqual(
    await harness.coordinator.dispatch(toggleCommand()),
    { status: "mapped_current", queuedSku: null },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-L");
  assert.equal(await harness.queueStore.loadQueue(), null);
  assert.deepEqual(harness.stateCalls.at(-1), {
    type: "map_variation",
    streamId: STREAM_ONE,
    variationNumber: 203,
    sku: "TEE-L",
  });

  assert.deepEqual(
    await harness.coordinator.dispatch(toggleCommand()),
    { status: "queued", queuedSku: "TEE-L" },
  );
  assert.deepEqual(
    await harness.coordinator.dispatch(toggleCommand()),
    { status: "cleared", queuedSku: null },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-L");
  assert.equal(await harness.queueStore.loadQueue(), null);
});

test("mapping an unmapped current variation preserves an existing queue", async () => {
  const harness = createCoordinatorHarness();

  await harness.coordinator.dispatch(toggleCommand());
  const state = harness.getState();
  reconciliation.unmapVariation(state, {
    streamId: STREAM_ONE,
    variationNumber: 203,
  });
  harness.setState(state);

  assert.deepEqual(
    await harness.coordinator.dispatch(
      toggleCommand({ sku: "TEE-M" }),
    ),
    { status: "mapped_current", queuedSku: "TEE-L" },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-M");
  assert.deepEqual(await harness.queueStore.loadQueue(), {
    streamId: STREAM_ONE,
    sku: "TEE-L",
    armedAfterVariationNumber: 203,
  });
});

test("toggle maps the newest recorded variation when between auctions", async () => {
  const harness = createCoordinatorHarness({ mapCurrent: false });
  const state = harness.getState();
  state.streams[0].activeBiddingVariationNumber = null;
  harness.setState(state);

  assert.deepEqual(
    await harness.coordinator.dispatch(toggleCommand()),
    { status: "mapped_current", queuedSku: null },
  );
  assert.equal(findAuction(harness.getState(), 203).sku, "TEE-L");
  assert.equal(await harness.queueStore.loadQueue(), null);
});

test("a stale expected variation cannot map or alter the queue", async () => {
  const harness = createCoordinatorHarness({ mapCurrent: false });
  const advancedState = addBiddingVariation(harness.getState(), 204);
  harness.setState(advancedState);

  await assert.rejects(
    () => harness.coordinator.dispatch(toggleCommand()),
    (error) => error.code === "CURRENT_VARIATION_CHANGED",
  );
  assert.equal(findAuction(harness.getState(), 203).sku, null);
  assert.equal(findAuction(harness.getState(), 204).sku, null);
  assert.equal(await harness.queueStore.loadQueue(), null);
  assert.equal(
    harness.stateCalls.filter((command) => command.type === "map_variation")
      .length,
    0,
  );
});

test("toggle rejects stale, wrong-stream, and unknown-SKU requests", async () => {
  const stale = createCoordinatorHarness();
  await assert.rejects(
    () =>
      stale.coordinator.dispatch(
        toggleCommand({ expectedVariationNumber: 202 }),
      ),
    (error) => error.code === "CURRENT_VARIATION_CHANGED",
  );

  const wrongStream = createCoordinatorHarness();
  await assert.rejects(
    () =>
      wrongStream.coordinator.dispatch(
        toggleCommand({ expectedStreamId: STREAM_TWO }),
      ),
    (error) => error.code === "ACTIVE_STREAM_MISMATCH",
  );

  const unknownSku = createCoordinatorHarness();
  await assert.rejects(
    () =>
      unknownSku.coordinator.dispatch(toggleCommand({ sku: "MISSING" })),
    (error) => error.code === "UNKNOWN_SKU",
  );
});

test("GET exposes only the active stream queue and discards stale queues", async () => {
  const harness = createCoordinatorHarness();
  await harness.queueStore.saveQueue({
    streamId: STREAM_TWO,
    sku: "TEE-L",
    armedAfterVariationNumber: 50,
  });

  assert.deepEqual(
    await harness.coordinator.dispatch({ type: "get_queue" }),
    { queuedSku: null },
  );
  assert.equal(await harness.queueStore.loadQueue(), null);

  await harness.queueStore.saveQueue({
    streamId: STREAM_ONE,
    sku: "TEE-L",
    armedAfterVariationNumber: 203,
  });
  harness.setActiveStreamId(null);
  assert.deepEqual(
    await harness.coordinator.dispatch({ type: "get_queue" }),
    { queuedSku: null },
  );
  assert.equal(await harness.queueStore.loadQueue(), null);
});

test("a queued SKU maps only the next newer active bidding variation", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());

  assert.deepEqual(
    await harness.coordinator.applyToObservedBiddingVariation({
      streamId: STREAM_ONE,
      variationNumber: 203,
      state: harness.getState(),
    }),
    { status: "waiting", state: harness.getState() },
  );
  assert.notEqual(await harness.queueStore.loadQueue(), null);

  const nextState = addBiddingVariation(harness.getState(), 204);
  harness.setState(nextState);
  const applied = await harness.coordinator.applyToObservedBiddingVariation({
    streamId: STREAM_ONE,
    variationNumber: 204,
    state: harness.getState(),
  });

  assert.equal(applied.status, "mapped");
  assert.equal(findAuction(applied.state, 204).sku, "TEE-L");
  assert.equal(findAuction(harness.getState(), 204).sku, "TEE-L");
  assert.equal(await harness.queueStore.loadQueue(), null);
  assert.deepEqual(harness.stateCalls.at(-1), {
    type: "map_variation",
    streamId: STREAM_ONE,
    variationNumber: 204,
    sku: "TEE-L",
  });
});

test("application never overwrites an existing target mapping and consumes the queue", async () => {
  for (const [targetSku, expectedStatus] of [
    ["TEE-L", "already_mapped"],
    ["TEE-M", "skipped_existing_mapping"],
  ]) {
    const harness = createCoordinatorHarness();
    await harness.coordinator.dispatch(toggleCommand());
    const nextState = addBiddingVariation(
      harness.getState(),
      204,
      targetSku,
    );
    harness.setState(nextState);
    const beforeCallCount = harness.stateCalls.length;
    const result = await harness.coordinator.applyToObservedBiddingVariation({
      streamId: STREAM_ONE,
      variationNumber: 204,
      state: harness.getState(),
    });

    assert.equal(result.status, expectedStatus);
    assert.equal(findAuction(result.state, 204).sku, targetSku);
    assert.equal(harness.stateCalls.length, beforeCallCount);
    assert.equal(await harness.queueStore.loadQueue(), null);
  }
});

test("application clears stale-stream and missing-SKU queues without mapping", async () => {
  const stale = createCoordinatorHarness();
  await stale.queueStore.saveQueue({
    streamId: STREAM_TWO,
    sku: "TEE-L",
    armedAfterVariationNumber: 50,
  });
  const staleResult = await stale.coordinator.applyToObservedBiddingVariation({
    streamId: STREAM_ONE,
    variationNumber: 203,
    state: stale.getState(),
  });

  assert.equal(staleResult.status, "stale_queue_cleared");
  assert.equal(await stale.queueStore.loadQueue(), null);
  assert.equal(stale.stateCalls.length, 0);

  const missing = createCoordinatorHarness();
  await missing.queueStore.saveQueue({
    streamId: STREAM_ONE,
    sku: "REMOVED-SKU",
    armedAfterVariationNumber: 203,
  });
  const nextState = addBiddingVariation(missing.getState(), 204);
  missing.setState(nextState);
  const missingResult =
    await missing.coordinator.applyToObservedBiddingVariation({
      streamId: STREAM_ONE,
      variationNumber: 204,
      state: missing.getState(),
    });

  assert.equal(missingResult.status, "invalid_sku_cleared");
  assert.equal(findAuction(missingResult.state, 204).sku, null);
  assert.equal(await missing.queueStore.loadQueue(), null);
  assert.equal(missing.stateCalls.length, 0);
});

test("mapping remains idempotent when clearing fails after the durable map", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const nextState = addBiddingVariation(harness.getState(), 204);
  harness.setState(nextState);
  harness.memory.failNextRemove();

  await assert.rejects(
    () =>
      harness.coordinator.applyToObservedBiddingVariation({
        streamId: STREAM_ONE,
        variationNumber: 204,
        state: harness.getState(),
      }),
    (error) =>
      error instanceof storageModule.NextItemQueueStorageError &&
      error.code === "NEXT_ITEM_QUEUE_STORAGE_WRITE_FAILED",
  );
  assert.equal(findAuction(harness.getState(), 204).sku, "TEE-L");
  assert.notEqual(await harness.queueStore.loadQueue(), null);

  const retry = await harness.coordinator.applyToObservedBiddingVariation({
    streamId: STREAM_ONE,
    variationNumber: 204,
    state: harness.getState(),
  });
  assert.equal(retry.status, "already_mapped");
  assert.equal(await harness.queueStore.loadQueue(), null);
  assert.equal(
    harness.stateCalls.filter((command) => command.type === "map_variation").length,
    1,
  );
});

test("session persistence survives a coordinator restart", async () => {
  const first = createCoordinatorHarness();
  await first.coordinator.dispatch(toggleCommand());
  const restarted = createCoordinatorHarness({
    memory: first.memory,
    state: first.getState(),
  });

  assert.deepEqual(
    await restarted.coordinator.dispatch({ type: "get_queue" }),
    { queuedSku: "TEE-L" },
  );
});

test("clearForStream is scoped and never turns cleanup storage failure into an error", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());

  assert.deepEqual(await harness.coordinator.clearForStream(STREAM_TWO), {
    status: "unchanged",
  });
  assert.notEqual(await harness.queueStore.loadQueue(), null);

  harness.memory.failNextRemove();
  assert.deepEqual(await harness.coordinator.clearForStream(STREAM_ONE), {
    status: "unavailable",
  });
  assert.notEqual(await harness.queueStore.loadQueue(), null);

  assert.deepEqual(await harness.coordinator.clearForStream(STREAM_ONE), {
    status: "cleared",
  });
  assert.equal(await harness.queueStore.loadQueue(), null);
});

test("queue snapshots expose a stable ephemeral token without changing saved schema 1", async () => {
  const harness = createCoordinatorHarness();
  assert.deepEqual(await snapshotQueue(harness), { queuedSku: null, queueToken: null });
  await harness.coordinator.dispatch(toggleCommand());
  const persistedBefore = clone(harness.memory.values);
  const writesBefore = harness.memory.calls.set.length;
  const first = await snapshotQueue(harness);
  assert.equal(first.queuedSku, "TEE-L");
  assert.match(first.queueToken, protocol.QUEUE_TOKEN_PATTERN);
  assert.deepEqual(await snapshotQueue(harness), first);
  assert.deepEqual(await harness.coordinator.dispatch({ type: "get_queue" }), {
    queuedSku: "TEE-L",
  });
  assert.deepEqual(await snapshotQueue(harness), first);
  assert.deepEqual(harness.memory.values, persistedBefore);
  assert.equal(harness.memory.calls.set.length, writesBefore);
  assert.equal(harness.memory.values[storageModule.STORAGE_KEY].schemaVersion, 1);
  assert.deepEqual(Object.keys(harness.memory.values[storageModule.STORAGE_KEY].queue).sort(), [
    "armedAfterVariationNumber", "sku", "streamId",
  ]);
  first.queueToken = "changed-locally";
  assert.notEqual((await snapshotQueue(harness)).queueToken, first.queueToken);
});

test("explicit clear removes only the queued item even when the live auction becomes unmapped or advances", async () => {
  for (const advance of [false, true]) {
    const harness = createCoordinatorHarness();
    await harness.coordinator.dispatch(toggleCommand());
    const snapshot = await snapshotQueue(harness);
    const state = harness.getState();
    if (advance) {
      addBiddingVariation(state, 204);
    } else {
      reconciliation.unmapVariation(state, { streamId: STREAM_ONE, variationNumber: 203 });
    }
    harness.setState(state);
    const callsBefore = clone(harness.stateCalls);
    const writesBefore = harness.memory.calls.set.length;
    assert.deepEqual(await harness.coordinator.dispatch(clearCommand(snapshot)), {
      status: "cleared", queuedSku: null,
    });
    assert.equal(await harness.queueStore.loadQueue(), null);
    assert.deepEqual(harness.getState(), state);
    assert.deepEqual(harness.stateCalls, callsBefore);
    assert.equal(harness.memory.calls.set.length, writesBefore);
    assert.deepEqual(await snapshotQueue(harness), { queuedSku: null, queueToken: null });
  }
});

test("duplicate explicit clears are serialized and never toggle or recreate the queue", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const snapshot = await snapshotQueue(harness);
  const before = harness.memory.calls.remove.length;
  const results = await Promise.allSettled([
    harness.coordinator.dispatch(clearCommand(snapshot)),
    harness.coordinator.dispatch(clearCommand(snapshot)),
  ]);
  assert.deepEqual(results[0], { status: "fulfilled", value: { status: "cleared", queuedSku: null } });
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "QUEUE_CHANGED");
  assert.equal(harness.memory.calls.remove.length, before + 1);
  assert.equal(await harness.queueStore.loadQueue(), null);
  assert.equal(harness.memory.calls.set.length, 1);
});

test("replacement and ABA replacement cannot be cleared by an older badge token", async () => {
  for (const restoreOriginalSku of [false, true]) {
    const harness = createCoordinatorHarness();
    await harness.coordinator.dispatch(toggleCommand());
    const displayed = await snapshotQueue(harness);
    await harness.coordinator.dispatch(toggleCommand({ sku: "TEE-M" }));
    if (restoreOriginalSku) await harness.coordinator.dispatch(toggleCommand());
    const before = clone(harness.memory.values);
    const removesBefore = harness.memory.calls.remove.length;
    // No intermediate snapshot is needed for replacement to revoke the token.
    await assert.rejects(
      harness.coordinator.dispatch(clearCommand(displayed)),
      (error) => error.code === "QUEUE_CHANGED",
    );
    assert.deepEqual(harness.memory.values, before);
    assert.equal(harness.memory.calls.remove.length, removesBefore);
    const current = await snapshotQueue(harness);
    assert.notEqual(current.queueToken, displayed.queueToken);
    assert.equal(current.queuedSku, restoreOriginalSku ? "TEE-L" : "TEE-M");
    await assert.rejects(
      harness.coordinator.dispatch(clearCommand(displayed)),
      (error) => error.code === "QUEUE_CHANGED",
    );
    await harness.coordinator.dispatch(clearCommand(current));
    assert.equal(await harness.queueStore.loadQueue(), null);
  }
});

test("a replacement queued ahead of an explicit clear wins the coordinator FIFO", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const displayed = await snapshotQueue(harness);
  const replace = harness.coordinator.dispatch(toggleCommand({ sku: "TEE-M" }));
  const clear = harness.coordinator.dispatch(clearCommand(displayed));
  assert.deepEqual(await replace, { status: "queued", queuedSku: "TEE-M" });
  await assert.rejects(clear, (error) => error.code === "QUEUE_CHANGED");
  assert.equal((await harness.queueStore.loadQueue()).sku, "TEE-M");
});

test("clear and requeue of the same SKU at the same variation revokes the original token", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const displayed = await snapshotQueue(harness);
  await harness.coordinator.dispatch(toggleCommand());
  await harness.coordinator.dispatch(toggleCommand());
  const before = clone(harness.memory.values);
  await assert.rejects(
    harness.coordinator.dispatch(clearCommand(displayed)),
    (error) => error.code === "QUEUE_CHANGED",
  );
  assert.deepEqual(harness.memory.values, before);
  assert.notEqual((await snapshotQueue(harness)).queueToken, displayed.queueToken);
});

test("consumed queues and same-SKU queues rearmed at a newer variation reject stale clears", async () => {
  for (const targetSku of [null, "TEE-L", "TEE-M"]) {
    const harness = createCoordinatorHarness();
    await harness.coordinator.dispatch(toggleCommand());
    const displayed = await snapshotQueue(harness);
    harness.setState(addBiddingVariation(harness.getState(), 204, targetSku));
    const consumed = harness.coordinator.applyToObservedBiddingVariation({
      streamId: STREAM_ONE, variationNumber: 204, state: harness.getState(),
    });
    const staleClear = harness.coordinator.dispatch(clearCommand(displayed));
    await consumed;
    await assert.rejects(staleClear, (error) => error.code === "QUEUE_CHANGED");
    assert.equal(await harness.queueStore.loadQueue(), null);
    await harness.coordinator.dispatch(toggleCommand({ expectedVariationNumber: 204 }));
    const before = clone(harness.memory.values);
    await assert.rejects(
      harness.coordinator.dispatch(clearCommand(displayed)),
      (error) => error.code === "QUEUE_CHANGED",
    );
    assert.deepEqual(harness.memory.values, before);
    assert.equal((await harness.queueStore.loadQueue()).armedAfterVariationNumber, 204);
    assert.notEqual((await snapshotQueue(harness)).queueToken, displayed.queueToken);
  }
});

test("worker/coordinator restart invalidates displayed tokens without losing the saved queue", async () => {
  const original = createCoordinatorHarness();
  await original.coordinator.dispatch(toggleCommand());
  const displayed = await snapshotQueue(original);
  const before = clone(original.memory.values);
  const restarted = createCoordinatorHarness({ memory: original.memory, state: original.getState() });
  await assert.rejects(
    restarted.coordinator.dispatch(clearCommand(displayed)),
    (error) => error.code === "QUEUE_CHANGED",
  );
  assert.deepEqual(restarted.memory.values, before);
  const fresh = await snapshotQueue(restarted);
  assert.notEqual(fresh.queueToken, displayed.queueToken);
  await assert.rejects(
    restarted.coordinator.dispatch(clearCommand(displayed)),
    (error) => error.code === "QUEUE_CHANGED",
  );
  await restarted.coordinator.dispatch(clearCommand(fresh));
  assert.equal(await restarted.queueStore.loadQueue(), null);
});

test("clear validates active stream, queued SKU, and snapshot token before deleting anything", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const displayed = await snapshotQueue(harness);
  const before = clone(harness.memory.values);
  const attempts = [
    [clearCommand(displayed, { expectedStreamId: STREAM_TWO }), "ACTIVE_STREAM_MISMATCH"],
    [clearCommand(displayed, { sku: "TEE-M" }), "QUEUE_CHANGED"],
    [clearCommand(displayed, { expectedQueueToken: "11111111-1111-4111-8111-111111111111" }), "QUEUE_CHANGED"],
  ];
  for (const [command, code] of attempts) {
    await assert.rejects(harness.coordinator.dispatch(command), (error) => error.code === code);
    assert.deepEqual(harness.memory.values, before);
  }
  harness.setActiveStreamId(null);
  await assert.rejects(
    harness.coordinator.dispatch(clearCommand(displayed)),
    (error) => error.code === "NO_ACTIVE_STREAM",
  );
  assert.deepEqual(harness.memory.values, before);
  assert.equal(harness.memory.calls.remove.length, 0);
});

test("failed queue clears and saves conservatively revoke old tokens without changing canonical state", async () => {
  for (const operation of ["clear", "save"]) {
    const harness = createCoordinatorHarness();
    await harness.coordinator.dispatch(toggleCommand());
    const displayed = await snapshotQueue(harness);
    const before = clone(harness.memory.values);
    const stateBefore = harness.getState();
    if (operation === "clear") harness.memory.failNextRemove();
    else harness.memory.failNextSet();
    await assert.rejects(
      harness.coordinator.dispatch(operation === "clear"
        ? clearCommand(displayed)
        : toggleCommand({ sku: "TEE-M" })),
      (error) => error.code === "NEXT_ITEM_QUEUE_STORAGE_WRITE_FAILED",
    );
    assert.deepEqual(harness.memory.values, before);
    assert.deepEqual(harness.getState(), stateBefore);
    await assert.rejects(
      harness.coordinator.dispatch(clearCommand(displayed)),
      (error) => error.code === "QUEUE_CHANGED",
    );
    const current = await snapshotQueue(harness);
    assert.notEqual(current.queueToken, displayed.queueToken);
    await harness.coordinator.dispatch(clearCommand(current));
    assert.equal(await harness.queueStore.loadQueue(), null);
  }
});

test("ambiguous write failures cannot authorize a stale clear of a persisted replacement", async () => {
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const displayed = await snapshotQueue(harness);
  const originalSet = harness.memory.storageArea.set;
  harness.memory.storageArea.set = async (entries) => {
    await originalSet(entries);
    throw new Error("reply lost after persistence");
  };
  await assert.rejects(
    harness.coordinator.dispatch(toggleCommand({ sku: "TEE-M" })),
    (error) => error.code === "NEXT_ITEM_QUEUE_STORAGE_WRITE_FAILED",
  );
  harness.memory.storageArea.set = originalSet;
  await harness.coordinator.dispatch(toggleCommand());
  const before = clone(harness.memory.values);
  await assert.rejects(
    harness.coordinator.dispatch(clearCommand(displayed)),
    (error) => error.code === "QUEUE_CHANGED",
  );
  assert.deepEqual(harness.memory.values, before);
});

test("stream cleanup and stale-queue cleanup revoke tokens before the same queue is rearmed", async () => {
  for (const cleanup of ["clearForStream", "staleGet"]) {
    const harness = createCoordinatorHarness();
    await harness.coordinator.dispatch(toggleCommand());
    const displayed = await snapshotQueue(harness);
    if (cleanup === "clearForStream") {
      await harness.coordinator.clearForStream(STREAM_ONE);
    } else {
      harness.setActiveStreamId(null);
      await harness.coordinator.dispatch({ type: "get_queue" });
      harness.setActiveStreamId(STREAM_ONE);
    }
    await harness.coordinator.dispatch(toggleCommand());
    await assert.rejects(
      harness.coordinator.dispatch(clearCommand(displayed)),
      (error) => error.code === "QUEUE_CHANGED",
    );
    assert.equal((await harness.queueStore.loadQueue()).sku, "TEE-L");
    assert.notEqual((await snapshotQueue(harness)).queueToken, displayed.queueToken);
  }
});

test("snapshot generation and storage read failures are typed and cannot clear a queue", async () => {
  for (const createQueueToken of [() => "invalid", () => { throw new Error("unavailable"); }]) {
    const harness = createCoordinatorHarness({ createQueueToken });
    await harness.coordinator.dispatch(toggleCommand());
    const before = clone(harness.memory.values);
    await assert.rejects(snapshotQueue(harness), (error) => error.code === "QUEUE_SNAPSHOT_UNAVAILABLE");
    assert.deepEqual(harness.memory.values, before);
    assert.equal(harness.memory.calls.remove.length, 0);
  }
  const harness = createCoordinatorHarness();
  await harness.coordinator.dispatch(toggleCommand());
  const displayed = await snapshotQueue(harness);
  harness.memory.failNextGet();
  await assert.rejects(
    harness.coordinator.dispatch(clearCommand(displayed)),
    (error) => error.code === "NEXT_ITEM_QUEUE_STORAGE_READ_FAILED",
  );
  assert.equal((await harness.queueStore.loadQueue()).sku, "TEE-L");
  assert.equal(harness.memory.calls.remove.length, 0);
});
