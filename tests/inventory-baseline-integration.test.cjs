const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  COMMAND_TYPES,
  createReconciliationCoordinator,
} = require("../extension/shared/reconciliation-coordinator.js");

const LEGACY_OPENING_INVENTORY = [
  {
    sku: "BLACK-TEE-M",
    name: "Black Tee",
    size: "M",
    quantityReceived: 2,
    unitCostCents: 1200,
  },
  {
    sku: "GREY-HOODIE-L",
    name: "Grey Hoodie",
    size: "L",
    quantityReceived: 1,
    unitCostCents: 2400,
  },
];

const NORMALIZED_OPENING_INVENTORY = [
  {
    sku: "BLACK-TEE-M",
    item: "Black Tee",
    style: "",
    size: "M",
    quantityOnHandAtImport: 2,
    unitCostCents: 1200,
  },
  {
    sku: "GREY-HOODIE-L",
    item: "Grey Hoodie",
    style: "",
    size: "L",
    quantityOnHandAtImport: 1,
    unitCostCents: 2400,
  },
];

const RECOUNTED_INVENTORY = [
  {
    sku: "BLACK-TEE-M",
    item: "Black Tee",
    style: "black",
    size: "M",
    quantityOnHandAtImport: 5,
    unitCostCents: 1350,
  },
  {
    sku: "GREY-HOODIE-L",
    item: "Grey Hoodie",
    style: "grey",
    size: "L",
    quantityOnHandAtImport: 3,
    unitCostCents: 2500,
  },
  {
    sku: "BLUE-CAP-OS",
    item: "Blue Cap",
    style: "blue",
    size: "OS",
    quantityOnHandAtImport: 4,
    unitCostCents: 700,
  },
];

const RECOUNT_BASELINE_ID =
  "inventory-baseline:22222222-2222-4222-8222-222222222222";
const RECOUNT_SOURCE_FINGERPRINT = "fnv1a64:59816505a5757e62";

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createMemoryStateStore(initialState = null) {
  let persistedState = clone(initialState);
  let nextSaveError = null;
  let beforeSave = null;
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const calls = { load: 0, save: [] };
  const stateStore = {
    async loadState() {
      calls.load += 1;
      return clone(persistedState);
    },
    async saveState(state) {
      const snapshot = clone(state);
      const saveIndex = calls.save.length;

      calls.save.push(snapshot);
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);

      try {
        if (beforeSave) {
          await beforeSave(snapshot, saveIndex);
        }

        if (nextSaveError) {
          const error = nextSaveError;
          nextSaveError = null;
          throw error;
        }

        persistedState = snapshot;
      } finally {
        activeSaves -= 1;
      }
    },
  };

  return {
    calls,
    stateStore,
    failNextSave(error) {
      nextSaveError = error;
    },
    getMaximumActiveSaves: () => maximumActiveSaves,
    getPersistedState: () => clone(persistedState),
    setBeforeSave(callback) {
      beforeSave = callback;
    },
  };
}

function createCoordinator(memoryStore) {
  return createReconciliationCoordinator({
    reconciliation,
    stateStore: memoryStore.stateStore,
  });
}

function getActiveBaseline(state) {
  return state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === state.activeInventoryBaselineId,
  );
}

function getStream(state, streamId) {
  return state.streams.find((stream) => stream.streamId === streamId);
}

function createBaselineCommand(
  baselineId = RECOUNT_BASELINE_ID,
  inventory = RECOUNTED_INVENTORY,
  sourceFingerprint = RECOUNT_SOURCE_FINGERPRINT,
) {
  return {
    type: COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
    baselineId,
    sourceFingerprint,
    inventory: clone(inventory),
  };
}

function pinStreamCommand(streamId) {
  return {
    type: COMMAND_TYPES.PIN_STREAM_TO_INVENTORY_BASELINE,
    streamId,
  };
}

function mapCommand(streamId, variationNumber, sku = "BLACK-TEE-M") {
  return {
    type: COMMAND_TYPES.MAP_VARIATION,
    streamId,
    variationNumber,
    sku,
  };
}

function observeProcessingCommand(streamId, variationNumber) {
  return {
    type: COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES,
    streamId,
    statuses: [
      {
        variationNumber,
        observedPaymentStatus: "payment_processing",
      },
    ],
  };
}

test("creates one immutable opening baseline for a fresh state", () => {
  const source = clone(LEGACY_OPENING_INVENTORY);
  const state = reconciliation.createReconciliationState(source);

  assert.equal(reconciliation.STATE_VERSION, 4);
  assert.equal(state.version, 4);
  assert.equal(state.inventoryBaselines.length, 1);
  assert.equal(typeof state.activeInventoryBaselineId, "string");
  assert.notEqual(state.activeInventoryBaselineId, "");
  assert.deepEqual(
    getActiveBaseline(state).inventory,
    NORMALIZED_OPENING_INVENTORY,
  );
  assert.equal(getActiveBaseline(state).sourceFingerprint, null);

  source[0].quantityReceived = 999;
  assert.equal(
    getActiveBaseline(state).inventory[0].quantityOnHandAtImport,
    2,
  );
});

test("appends a recount without overwriting the opening baseline", () => {
  const state = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );
  const openingSnapshot = clone(getActiveBaseline(state));
  const source = clone(RECOUNTED_INVENTORY);

  const result = reconciliation.createInventoryBaseline(state, {
    baselineId: RECOUNT_BASELINE_ID,
    sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
    inventory: source,
  });

  assert.deepEqual(result, {
    status: "created",
    baselineId: RECOUNT_BASELINE_ID,
  });
  assert.equal(state.activeInventoryBaselineId, RECOUNT_BASELINE_ID);
  assert.equal(state.inventoryBaselines.length, 2);
  assert.deepEqual(state.inventoryBaselines[0], openingSnapshot);
  assert.deepEqual(getActiveBaseline(state).inventory, RECOUNTED_INVENTORY);
  assert.equal(
    getActiveBaseline(state).sourceFingerprint,
    RECOUNT_SOURCE_FINGERPRINT,
  );

  source[0].quantityOnHandAtImport = 999;
  assert.equal(
    getActiveBaseline(state).inventory[0].quantityOnHandAtImport,
    5,
  );
});

test("treats a baseline ID as an idempotency key and rejects conflicting reuse", () => {
  const state = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );

  reconciliation.createInventoryBaseline(state, {
    baselineId: RECOUNT_BASELINE_ID,
    sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
    inventory: RECOUNTED_INVENTORY,
  });
  const saved = clone(state);

  assert.deepEqual(
    reconciliation.createInventoryBaseline(state, {
      baselineId: RECOUNT_BASELINE_ID,
      sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
      inventory: clone(RECOUNTED_INVENTORY),
    }),
    { status: "already_exists", baselineId: RECOUNT_BASELINE_ID },
  );
  assert.deepEqual(state, saved);

  const conflict = clone(RECOUNTED_INVENTORY);
  conflict[0].quantityOnHandAtImport += 1;
  assert.throws(
    () => reconciliation.createInventoryBaseline(state, {
      baselineId: RECOUNT_BASELINE_ID,
      sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
      inventory: conflict,
    }),
    (error) => error.code === "BASELINE_ID_CONFLICT",
  );
  assert.deepEqual(state, saved);

  const laterRecountId =
    "inventory-baseline:33333333-3333-4333-8333-333333333333";
  assert.deepEqual(
    reconciliation.createInventoryBaseline(state, {
      baselineId: laterRecountId,
      sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
      inventory: clone(RECOUNTED_INVENTORY),
    }),
    { status: "created", baselineId: laterRecountId },
  );
  assert.equal(state.activeInventoryBaselineId, laterRecountId);
  assert.equal(state.inventoryBaselines.length, 3);
});

test("pins a stream once and never repoints it when a recount becomes active", () => {
  const state = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );
  const openingBaselineId = state.activeInventoryBaselineId;

  assert.deepEqual(
    reconciliation.pinStreamToInventoryBaseline(state, {
      streamId: "stream-old",
    }),
    { status: "pinned", baselineId: openingBaselineId },
  );
  assert.deepEqual(
    reconciliation.pinStreamToInventoryBaseline(state, {
      streamId: "stream-old",
    }),
    { status: "already_pinned", baselineId: openingBaselineId },
  );
  reconciliation.createInventoryBaseline(state, {
    baselineId: RECOUNT_BASELINE_ID,
    sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
    inventory: RECOUNTED_INVENTORY,
  });

  assert.throws(
    () => reconciliation.pinStreamToInventoryBaseline(state, {
      streamId: "stream-old",
    }),
    (error) => error.code === "STREAM_BASELINE_CONFLICT",
  );
  assert.deepEqual(
    reconciliation.pinStreamToInventoryBaseline(state, {
      streamId: "stream-new",
    }),
    { status: "pinned", baselineId: RECOUNT_BASELINE_ID },
  );
  assert.equal(
    getStream(state, "stream-old").inventoryBaselineId,
    openingBaselineId,
  );
  assert.equal(
    getStream(state, "stream-new").inventoryBaselineId,
    RECOUNT_BASELINE_ID,
  );
});

test("does not subtract old-baseline sales again from a fresh physical recount", () => {
  const state = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );

  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "stream-old" });
  reconciliation.mapVariation(state, {
    streamId: "stream-old",
    variationNumber: 1,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "stream-old",
    variationNumber: 1,
    soldPriceCents: 5000,
  });

  reconciliation.createInventoryBaseline(state, {
    baselineId: RECOUNT_BASELINE_ID,
    sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
    inventory: RECOUNTED_INVENTORY,
  });
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "stream-new" });

  assert.equal(
    reconciliation.calculateSummary(state, { streamId: "stream-old" })
      .inventory.find((item) => item.sku === "BLACK-TEE-M").remainingQuantity,
    1,
  );
  assert.equal(
    reconciliation.calculateSummary(state, { streamId: "stream-new" })
      .inventory.find((item) => item.sku === "BLACK-TEE-M").remainingQuantity,
    5,
  );

  reconciliation.mapVariation(state, {
    streamId: "stream-new",
    variationNumber: 2,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "stream-new",
    variationNumber: 2,
    soldPriceCents: 6000,
  });

  assert.equal(
    reconciliation.calculateSummary(state, { streamId: "stream-old" })
      .inventory.find((item) => item.sku === "BLACK-TEE-M").remainingQuantity,
    1,
  );
  assert.equal(
    reconciliation.calculateSummary(state, { streamId: "stream-new" })
      .inventory.find((item) => item.sku === "BLACK-TEE-M").remainingQuantity,
    4,
  );
});

test("uses each pinned baseline's unit cost for completed sales", () => {
  const state = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );

  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "stream-old" });
  reconciliation.mapVariation(state, {
    streamId: "stream-old",
    variationNumber: 10,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "stream-old",
    variationNumber: 10,
    soldPriceCents: 5000,
  });
  reconciliation.createInventoryBaseline(state, {
    baselineId: RECOUNT_BASELINE_ID,
    sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
    inventory: RECOUNTED_INVENTORY,
  });
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "stream-new" });
  reconciliation.mapVariation(state, {
    streamId: "stream-new",
    variationNumber: 11,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "stream-new",
    variationNumber: 11,
    soldPriceCents: 5000,
  });

  assert.equal(
    reconciliation.getAuction(state, {
      streamId: "stream-old",
      variationNumber: 10,
    }).committedUnitCostCents,
    1200,
  );
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: "stream-new",
      variationNumber: 11,
    }).committedUnitCostCents,
    1350,
  );
});

test("historical corrections affect only the historical stream baseline", () => {
  const state = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );

  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "stream-old" });
  reconciliation.mapVariation(state, {
    streamId: "stream-old",
    variationNumber: 20,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "stream-old",
    variationNumber: 20,
    soldPriceCents: 5000,
  });
  reconciliation.createInventoryBaseline(state, {
    baselineId: RECOUNT_BASELINE_ID,
    sourceFingerprint: RECOUNT_SOURCE_FINGERPRINT,
    inventory: RECOUNTED_INVENTORY,
  });
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "stream-new" });

  reconciliation.mapVariation(state, {
    streamId: "stream-old",
    variationNumber: 20,
    sku: "GREY-HOODIE-L",
  });

  const oldSummary = reconciliation.calculateSummary(state, {
    streamId: "stream-old",
  });
  const newSummary = reconciliation.calculateSummary(state, {
    streamId: "stream-new",
  });
  assert.equal(
    oldSummary.inventory.find((item) => item.sku === "BLACK-TEE-M")
      .remainingQuantity,
    2,
  );
  assert.equal(
    oldSummary.inventory.find((item) => item.sku === "GREY-HOODIE-L")
      .remainingQuantity,
    0,
  );
  assert.equal(oldSummary.auctions[0].committedUnitCostCents, 2400);
  assert.equal(
    newSummary.inventory.find((item) => item.sku === "BLACK-TEE-M")
      .remainingQuantity,
    5,
  );
  assert.equal(
    newSummary.inventory.find((item) => item.sku === "GREY-HOODIE-L")
      .remainingQuantity,
    3,
  );

  assert.throws(
    () => reconciliation.mapVariation(state, {
      streamId: "stream-old",
      variationNumber: 20,
      sku: "BLUE-CAP-OS",
    }),
    (error) => error.code === "UNKNOWN_SKU",
  );
});

test("strictly migrates a version-3 snapshot into one pinned baseline", () => {
  const legacy = {
    version: 3,
    inventory: clone(LEGACY_OPENING_INVENTORY),
    streams: [
      {
        streamId: "legacy-stream",
        variations: [
          {
            streamId: "legacy-stream",
            variationNumber: 7,
            sku: "BLACK-TEE-M",
            mappingStatus: "mapped",
            paymentStatus: "payment_complete",
            observedPaymentStatus: "payment_complete",
            soldPriceCents: 5000,
            committedUnitCostCents: 1200,
            conflicts: [],
          },
        ],
      },
    ],
  };

  const migrated = reconciliation.hydrateReconciliationState(legacy);
  const baseline = getActiveBaseline(migrated);

  assert.equal(migrated.version, 4);
  assert.equal(migrated.inventoryBaselines.length, 1);
  assert.deepEqual(baseline.inventory, NORMALIZED_OPENING_INVENTORY);
  assert.equal(baseline.sourceFingerprint, null);
  assert.equal(
    getStream(migrated, "legacy-stream").inventoryBaselineId,
    baseline.baselineId,
  );
  assert.equal(
    reconciliation.getAuction(migrated, {
      streamId: "legacy-stream",
      variationNumber: 7,
    }).committedUnitCostCents,
    1200,
  );
  assert.deepEqual(reconciliation.hydrateReconciliationState(migrated), migrated);
});

test("coordinator persists baseline creation and stream pinning across restart", async () => {
  const memoryStore = createMemoryStateStore(
    reconciliation.createReconciliationState(LEGACY_OPENING_INVENTORY),
  );
  const firstCoordinator = createCoordinator(memoryStore);

  const created = await firstCoordinator.dispatch(createBaselineCommand());
  const pinned = await firstCoordinator.dispatch(pinStreamCommand("stream-new"));

  assert.equal(created.result.status, "created");
  assert.equal(pinned.result.status, "pinned");
  assert.equal(memoryStore.calls.save.length, 2);

  const restartedCoordinator = createCoordinator(memoryStore);
  const restored = await restartedCoordinator.dispatch({
    type: COMMAND_TYPES.GET_STATE,
  });

  assert.equal(restored.state.activeInventoryBaselineId, RECOUNT_BASELINE_ID);
  assert.equal(
    getStream(restored.state, "stream-new").inventoryBaselineId,
    RECOUNT_BASELINE_ID,
  );
  assert.equal(memoryStore.calls.load, 2);
});

test("coordinator keeps memory and disk on the previous baseline when save fails", async () => {
  const openingState = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );
  const memoryStore = createMemoryStateStore(openingState);
  const coordinator = createCoordinator(memoryStore);
  memoryStore.failNextSave(new Error("quota exceeded"));

  await assert.rejects(() => coordinator.dispatch(createBaselineCommand()));

  const afterFailure = await coordinator.dispatch({
    type: COMMAND_TYPES.GET_STATE,
  });
  assert.deepEqual(afterFailure.state, openingState);
  assert.deepEqual(memoryStore.getPersistedState(), openingState);

  const retry = await coordinator.dispatch(createBaselineCommand());
  assert.equal(retry.result.status, "created");
  assert.equal(retry.state.activeInventoryBaselineId, RECOUNT_BASELINE_ID);
});

test("coordinator FIFO pins against the baseline active when start wins the race", async () => {
  const openingState = reconciliation.createReconciliationState(
    LEGACY_OPENING_INVENTORY,
  );
  const openingBaselineId = openingState.activeInventoryBaselineId;
  const memoryStore = createMemoryStateStore(openingState);
  const coordinator = createCoordinator(memoryStore);
  const firstSave = createDeferred();
  memoryStore.setBeforeSave(async (_snapshot, saveIndex) => {
    if (saveIndex === 0) {
      await firstSave.promise;
    }
  });

  const pin = coordinator.dispatch(pinStreamCommand("stream-start-first"));
  const recount = coordinator.dispatch(createBaselineCommand());
  await Promise.resolve();
  firstSave.resolve();
  await Promise.all([pin, recount]);

  const state = memoryStore.getPersistedState();
  assert.equal(
    getStream(state, "stream-start-first").inventoryBaselineId,
    openingBaselineId,
  );
  assert.equal(state.activeInventoryBaselineId, RECOUNT_BASELINE_ID);
  assert.equal(memoryStore.getMaximumActiveSaves(), 1);
});

test("coordinator FIFO pins against the new baseline when recount wins the race", async () => {
  const memoryStore = createMemoryStateStore(
    reconciliation.createReconciliationState(LEGACY_OPENING_INVENTORY),
  );
  const coordinator = createCoordinator(memoryStore);
  const firstSave = createDeferred();
  memoryStore.setBeforeSave(async (_snapshot, saveIndex) => {
    if (saveIndex === 0) {
      await firstSave.promise;
    }
  });

  const recount = coordinator.dispatch(createBaselineCommand());
  const pin = coordinator.dispatch(pinStreamCommand("stream-recount-first"));
  await Promise.resolve();
  firstSave.resolve();
  await Promise.all([recount, pin]);

  const state = memoryStore.getPersistedState();
  assert.equal(
    getStream(state, "stream-recount-first").inventoryBaselineId,
    RECOUNT_BASELINE_ID,
  );
  assert.equal(memoryStore.getMaximumActiveSaves(), 1);
});

test("same-baseline concurrent mappings cannot claim the final unit twice", async () => {
  const oneUnit = clone(LEGACY_OPENING_INVENTORY);
  oneUnit[0].quantityReceived = 1;
  const memoryStore = createMemoryStateStore(
    reconciliation.createReconciliationState(oneUnit),
  );
  const coordinator = createCoordinator(memoryStore);

  await coordinator.dispatch(pinStreamCommand("stream-a"));
  await coordinator.dispatch(pinStreamCommand("stream-b"));
  await coordinator.dispatch(observeProcessingCommand("stream-a", 1));
  await coordinator.dispatch(observeProcessingCommand("stream-b", 2));

  const results = await Promise.allSettled([
    coordinator.dispatch(mapCommand("stream-a", 1)),
    coordinator.dispatch(mapCommand("stream-b", 2)),
  ]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["fulfilled", "rejected"],
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "NO_STOCK_AVAILABLE");

  const persisted = memoryStore.getPersistedState();
  const mappedCount = persisted.streams.reduce(
    (total, stream) => total + stream.variations.filter(
      (variation) => variation.sku === "BLACK-TEE-M",
    ).length,
    0,
  );
  assert.equal(mappedCount, 1);
});

test("snapshotting a baseline command prevents caller mutation while queued", async () => {
  const memoryStore = createMemoryStateStore(
    reconciliation.createReconciliationState(LEGACY_OPENING_INVENTORY),
  );
  const coordinator = createCoordinator(memoryStore);
  const firstSave = createDeferred();
  memoryStore.setBeforeSave(async (_snapshot, saveIndex) => {
    if (saveIndex === 0) {
      await firstSave.promise;
    }
  });

  const blocker = coordinator.dispatch(pinStreamCommand("stream-blocker"));
  const command = createBaselineCommand();
  const queued = coordinator.dispatch(command);
  command.baselineId = "inventory-baseline:mutated";
  command.inventory[0].quantityOnHandAtImport = 999;
  firstSave.resolve();

  await Promise.all([blocker, queued]);
  const state = memoryStore.getPersistedState();
  assert.equal(state.activeInventoryBaselineId, RECOUNT_BASELINE_ID);
  assert.equal(
    getActiveBaseline(state).inventory[0].quantityOnHandAtImport,
    5,
  );
});
