const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
  ReconciliationStorageError,
  createReconciliationStateStore,
} = require("../extension/shared/reconciliation-storage.js");

const INVENTORY = [
  {
    sku: "BLACK-TEE-M",
    name: "Black Tee",
    size: "M",
    quantityReceived: 3,
    unitCostCents: 1200,
  },
  {
    sku: "GREY-HOODIE-L",
    name: "Grey Hoodie",
    size: "L",
    quantityReceived: 2,
    unitCostCents: 2400,
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createState() {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 1,
    sku: "BLACK-TEE-M",
  });
  reconciliation.mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 2,
    sku: "GREY-HOODIE-L",
  });
  reconciliation.observePaymentStatuses(state, {
    streamId: "morning-stream",
    statuses: [
      {
        variationNumber: 1,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "morning-stream",
    variationNumber: 2,
    soldPriceCents: 4800,
  });

  return state;
}

function createEnvelope(state = createState()) {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    reconciliationState: state,
  };
}

function activeBaseline(state) {
  return state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === state.activeInventoryBaselineId,
  );
}

function toLegacyState(state, version) {
  const baseline = activeBaseline(state);

  return {
    version,
    inventory: baseline.inventory.map((entry) => ({
      sku: entry.sku,
      name: entry.style ? `${entry.item} - ${entry.style}` : entry.item,
      size: entry.size,
      quantityReceived: entry.quantityOnHandAtImport,
      unitCostCents: entry.unitCostCents,
    })),
    streams: state.streams.map(({ streamId, variations }) => ({
      streamId,
      variations: clone(variations),
    })),
  };
}

function createLegacyState() {
  const state = toLegacyState(createState(), 1);

  state.streams.forEach((stream) => {
    stream.variations.forEach((auction) => {
      if (auction.paymentStatus === "canceled") {
        auction.paymentStatus = "unknown";
      }

      delete auction.observedPaymentStatus;
    });
  });
  return state;
}

function createV2State() {
  const state = toLegacyState(createState(), 2);

  state.streams[0].variations[0].paymentStatus = "unknown";
  return state;
}

function createMemoryStorage(initialValues = {}) {
  let values = initialValues;
  let readError = null;
  let writeError = null;
  const calls = { get: [], set: [] };
  const storageArea = {
    async get(key) {
      calls.get.push(key);

      if (readError) {
        throw readError;
      }

      return values;
    },
    async set(update) {
      calls.set.push(update);

      if (writeError) {
        throw writeError;
      }

      values = { ...values, ...update };
    },
  };

  return {
    calls,
    storageArea,
    getValues: () => values,
    failReadsWith(error) {
      readError = error;
    },
    failWritesWith(error) {
      writeError = error;
    },
  };
}

function createStore(memoryStorage) {
  return createReconciliationStateStore({
    storageArea: memoryStorage.storageArea,
    reconciliation,
  });
}

async function assertStorageError(action, code, cause) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ReconciliationStorageError);
    assert.equal(error.code, code);

    if (cause !== undefined) {
      assert.equal(error.cause, cause);
    }

    return true;
  });
}

test("saves and loads a complete detached reconciliation snapshot", async () => {
  const memoryStorage = createMemoryStorage({ unrelated: "preserved" });
  const store = createStore(memoryStorage);
  const state = createState();
  const original = clone(state);

  assert.equal(await store.saveState(state), undefined);
  assert.equal(memoryStorage.calls.set.length, 1);
  assert.deepEqual(memoryStorage.calls.set[0], {
    [STORAGE_KEY]: createEnvelope(original),
  });
  assert.deepEqual(state, original);

  activeBaseline(state).inventory[0].item = "Caller changed this later";
  state.streams[0].variations[0].sku = "GREY-HOODIE-L";

  const firstLoad = await store.loadState();
  assert.deepEqual(firstLoad, original);
  assert.equal(firstLoad.version, reconciliation.STATE_VERSION);
  assert.equal(
    firstLoad.streams[0].variations[0].observedPaymentStatus,
    "canceled",
  );
  assert.equal(firstLoad.streams[0].variations[0].paymentStatus, "canceled");
  assert.notEqual(
    firstLoad,
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState,
  );

  activeBaseline(firstLoad).inventory[0].item = "Loaded copy changed";
  firstLoad.streams[0].variations[0].sku = "GREY-HOODIE-L";

  assert.deepEqual(await store.loadState(), original);
  assert.deepEqual(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState,
    original,
  );
  assert.equal(memoryStorage.getValues().unrelated, "preserved");
});

test("restores every mapped canonical-unknown reservation", async () => {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 10,
    sku: "BLACK-TEE-M",
  });
  reconciliation.observePaymentStatuses(state, {
    streamId: "morning-stream",
    statuses: [
      {
        variationNumber: 11,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      },
    ],
  });
  reconciliation.mapVariation(state, {
    streamId: "morning-stream",
    variationNumber: 11,
    sku: "BLACK-TEE-M",
  });

  const memoryStorage = createMemoryStorage();
  const store = createStore(memoryStorage);

  await store.saveState(state);
  const restored = await store.loadState();
  const summary = reconciliation.calculateSummary(restored, {
    streamId: "morning-stream",
  });

  assert.deepEqual(
    summary.auctions.map(({ variationNumber, status }) => ({
      variationNumber,
      status,
    })),
    [
      { variationNumber: 10, status: "pending" },
      { variationNumber: 11, status: "pending" },
    ],
  );
  assert.equal(summary.inventory[0].reservedQuantity, 2);
  assert.equal(summary.inventory[0].remainingQuantity, 3);
  assert.equal(summary.inventory[0].availableToTagQuantity, 1);
  assert.equal(summary.totals.pendingMappedCount, 2);
});

test("returns null only when the namespaced storage key is absent", async () => {
  const memoryStorage = createMemoryStorage({ unrelated: "preserved" });
  const store = createStore(memoryStorage);

  assert.equal(await store.loadState(), null);
  assert.deepEqual(memoryStorage.calls.get, [STORAGE_KEY]);
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.deepEqual(memoryStorage.getValues(), { unrelated: "preserved" });
});

test("loads a valid empty reconciliation state", async () => {
  const emptyState = reconciliation.createReconciliationState();
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: createEnvelope(emptyState),
  });

  assert.deepEqual(await createStore(memoryStorage).loadState(), emptyState);
});

test("lazily migrates strict legacy v1 state inside the v1 storage envelope", async () => {
  const legacyState = createLegacyState();
  const legacyEnvelope = {
    schemaVersion: 1,
    reconciliationState: legacyState,
  };
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: legacyEnvelope,
  });
  const store = createStore(memoryStorage);

  const migrated = await store.loadState();

  assert.equal(STORAGE_SCHEMA_VERSION, 1);
  assert.equal(migrated.version, reconciliation.STATE_VERSION);
  assert.deepEqual(
    migrated.streams[0].variations.map((auction) => ({
      paymentStatus: auction.paymentStatus,
      observedPaymentStatus: auction.observedPaymentStatus,
    })),
    [
      { paymentStatus: "unknown", observedPaymentStatus: "not_observed" },
      {
        paymentStatus: "payment_complete",
        observedPaymentStatus: "payment_complete",
      },
    ],
  );
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState.version,
    1,
  );

  await store.saveState(migrated);

  assert.equal(memoryStorage.calls.set.length, 1);
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].schemaVersion,
    STORAGE_SCHEMA_VERSION,
  );
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState.version,
    reconciliation.STATE_VERSION,
  );
});

test("lazily migrates v2 observed cancellation to the current state", async () => {
  const v2State = createV2State();
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: createEnvelope(v2State),
  });
  const store = createStore(memoryStorage);

  const migrated = await store.loadState();

  assert.equal(migrated.version, reconciliation.STATE_VERSION);
  assert.equal(
    migrated.streams[0].variations[0].observedPaymentStatus,
    "canceled",
  );
  assert.equal(migrated.streams[0].variations[0].paymentStatus, "canceled");
  assert.equal(migrated.streams[0].variations[0].soldPriceCents, null);
  assert.equal(
    migrated.streams[0].variations[0].committedUnitCostCents,
    null,
  );
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState.version,
    2,
  );
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState.streams[0]
      .variations[0].paymentStatus,
    "unknown",
  );
});

test("lazily migrates a v4 baseline stream with no Attributed GMV", async () => {
  const v4State = clone(createState());

  v4State.version = 4;
  v4State.streams.forEach((stream) => {
    delete stream.activeBiddingVariationNumber;
    delete stream.attributedGmvDisplay;
  });
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: createEnvelope(v4State),
  });
  const store = createStore(memoryStorage);

  const migrated = await store.loadState();

  assert.equal(migrated.version, reconciliation.STATE_VERSION);
  assert.equal(migrated.streams[0].attributedGmvDisplay, null);
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState.version,
    4,
  );

  await store.saveState(migrated);

  assert.equal(memoryStorage.calls.set.length, 1);
  assert.equal(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState.streams[0]
      .attributedGmvDisplay,
    null,
  );
});

test("lazily migrates v6 unpaid and cancellation-overridden state without rewriting storage", async () => {
  const v6State = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.mapVariation(v6State, {
    streamId: "legacy-v6-stream",
    variationNumber: 20,
    sku: "BLACK-TEE-M",
  });
  reconciliation.mapVariation(v6State, {
    streamId: "legacy-v6-stream",
    variationNumber: 21,
    sku: "GREY-HOODIE-L",
  });
  const [legacyUnpaid, legacyCanceled] = v6State.streams[0].variations;

  legacyUnpaid.mappingStatus = "marked_unpaid";
  Object.assign(legacyCanceled, {
    mappingStatus: "marked_unpaid",
    paymentStatus: "payment_complete",
    observedPaymentStatus: "payment_complete",
    soldPriceCents: 4800,
    committedUnitCostCents: 2400,
    conflicts: [
      { code: "payment_completed_after_marked_unpaid" },
      { code: "payment_completed_after_canceled" },
    ],
  });
  v6State.version = 6;
  const storedV6State = clone(v6State);
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: createEnvelope(v6State),
  });
  const migrated = await createStore(memoryStorage).loadState();
  const summary = reconciliation.calculateSummary(migrated, {
    streamId: "legacy-v6-stream",
  });

  assert.equal(migrated.version, 7);
  assert.equal(summary.auctions[0].mappingStatus, "mapped");
  assert.equal(summary.auctions[0].status, "pending");
  assert.equal(summary.auctions[1].mappingStatus, "mapped");
  assert.equal(summary.auctions[1].status, "canceled");
  assert.equal(summary.auctions[1].soldPriceCents, null);
  assert.deepEqual(summary.auctions[1].conflicts, []);
  assert.equal(summary.totals.completedGmvCents, 0);
  assert.equal(summary.totals.committedRevenueCents, 0);
  assert.equal(summary.inventory[0].reservedQuantity, 1);
  assert.equal(summary.inventory[1].soldQuantity, 0);
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.deepEqual(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState,
    storedV6State,
  );
});

test("rejects legacy v1 auctions containing v2 or unknown fields", async () => {
  const legacyState = createLegacyState();

  legacyState.streams[0].variations[0].observedPaymentStatus = "not_observed";
  const envelope = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    reconciliationState: legacyState,
  };
  const memoryStorage = createMemoryStorage({ [STORAGE_KEY]: envelope });

  await assertStorageError(
    () => createStore(memoryStorage).loadState(),
    "INVALID_RECONCILIATION_STATE",
  );
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.equal(memoryStorage.getValues()[STORAGE_KEY], envelope);
});

for (const [label, storedValue] of [
  ["null", null],
  ["an empty object", {}],
  ["a string", "stored state"],
  ["an array", []],
  ["a raw legacy state", createState()],
]) {
  test(`rejects ${label} instead of treating it as missing`, async () => {
    const memoryStorage = createMemoryStorage({
      [STORAGE_KEY]: storedValue,
    });

    await assertStorageError(
      () => createStore(memoryStorage).loadState(),
      "INVALID_STORAGE_ENVELOPE",
    );
    assert.equal(memoryStorage.calls.set.length, 0);
    assert.equal(memoryStorage.getValues()[STORAGE_KEY], storedValue);
  });
}

test("distinguishes invalid and unsupported storage schema versions", async () => {
  const invalidMemory = createMemoryStorage({
    [STORAGE_KEY]: {
      schemaVersion: "1",
      reconciliationState: createState(),
    },
  });
  const futureEnvelope = createEnvelope();
  futureEnvelope.schemaVersion = 2;
  const futureMemory = createMemoryStorage({ [STORAGE_KEY]: futureEnvelope });

  await assertStorageError(
    () => createStore(invalidMemory).loadState(),
    "INVALID_STORAGE_ENVELOPE",
  );
  await assertStorageError(
    () => createStore(futureMemory).loadState(),
    "UNSUPPORTED_STORAGE_VERSION",
  );
  assert.equal(invalidMemory.calls.set.length, 0);
  assert.equal(futureMemory.calls.set.length, 0);
});

test("reports unsupported reconciliation versions through the state boundary", async () => {
  const futureState = createState();
  futureState.version = reconciliation.STATE_VERSION + 1;
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: createEnvelope(futureState),
  });

  await assert.rejects(
    () => createStore(memoryStorage).loadState(),
    (error) => {
      assert.ok(error instanceof ReconciliationStorageError);
      assert.equal(error.code, "UNSUPPORTED_RECONCILIATION_VERSION");
      assert.equal(error.cause?.code, "UNSUPPORTED_STATE_VERSION");
      return true;
    },
  );
  assert.equal(memoryStorage.calls.set.length, 0);
});

const corruptStateCases = [
  ["non-array inventory", (state) => {
    activeBaseline(state).inventory = {};
  }],
  ["malformed inventory row", (state) => {
    activeBaseline(state).inventory[0] = null;
  }],
  ["duplicate inventory SKU", (state) => {
    const inventory = activeBaseline(state).inventory;
    inventory.push(clone(inventory[0]));
  }],
  ["duplicate stream ID", (state) => {
    state.streams.push(clone(state.streams[0]));
  }],
  ["non-array variations", (state) => {
    state.streams[0].variations = {};
  }],
  ["duplicate variation", (state) => {
    state.streams[0].variations.push(clone(state.streams[0].variations[0]));
  }],
  ["mismatched parent stream", (state) => {
    state.streams[0].variations[0].streamId = "different-stream";
  }],
  ["unknown mapped SKU", (state) => {
    state.streams[0].variations[0].sku = "MISSING-SKU";
  }],
  ["unknown mapping status", (state) => {
    state.streams[0].variations[0].mappingStatus = "maybe";
  }],
  ["legacy marked-unpaid mapping status", (state) => {
    state.streams[0].variations[0].mappingStatus = "marked_unpaid";
  }],
  ["unknown payment status", (state) => {
    state.streams[0].variations[0].paymentStatus = "refunded";
  }],
  ["unknown observed payment status", (state) => {
    state.streams[0].variations[0].observedPaymentStatus = "payment_pending";
  }],
  ["missing observed payment status", (state) => {
    delete state.streams[0].variations[0].observedPaymentStatus;
  }],
  ["a canceled observation without canonical cancellation", (state) => {
    state.streams[0].variations[0].paymentStatus = "unknown";
  }],
  ["canonical cancellation with a noncanceled observation", (state) => {
    state.streams[0].variations[0].observedPaymentStatus = "payment_failed";
  }],
  ["completed payment with a noncomplete observed status", (state) => {
    state.streams[0].variations[1].observedPaymentStatus = "payment_fixing";
  }],
  ["money on a canceled payment", (state) => {
    state.streams[0].variations[0].soldPriceCents = 4800;
  }],
  ["missing committed cost", (state) => {
    state.streams[0].variations[1].committedUnitCostCents = null;
  }],
  ["malformed conflicts", (state) => {
    state.streams[0].variations[1].conflicts = {};
  }],
  ["an unknown conflict", (state) => {
    state.streams[0].variations[1].conflicts.push({ code: "unknown" });
  }],
  ["a payment-after-canceled conflict without completion", (state) => {
    state.streams[0].variations[0].conflicts.push({
      code: "payment_completed_after_canceled",
    });
  }],
  ["a conflicting price that disagrees with the retained price", (state) => {
    state.streams[0].variations[1].conflicts.push({
      code: "conflicting_sold_price",
      retainedSoldPriceCents: 4700,
      observedSoldPriceCents: 5000,
    });
  }],
  ["a conflicting price whose observed price is not different", (state) => {
    state.streams[0].variations[1].conflicts.push({
      code: "conflicting_sold_price",
      retainedSoldPriceCents: 4800,
      observedSoldPriceCents: 4800,
    });
  }],
  ["duplicate conflicts", (state) => {
    const conflict = {
      code: "conflicting_sold_price",
      retainedSoldPriceCents: 4800,
      observedSoldPriceCents: 5000,
    };
    state.streams[0].variations[1].conflicts.push(
      clone(conflict),
      clone(conflict),
    );
  }],
  ["unknown persisted field", (state) => {
    state.extra = true;
  }],
];

for (const [label, corrupt] of corruptStateCases) {
  test(`rejects persisted state with ${label}`, async () => {
    const state = createState();
    corrupt(state);
    const envelope = createEnvelope(state);
    const memoryStorage = createMemoryStorage({ [STORAGE_KEY]: envelope });

    await assertStorageError(
      () => createStore(memoryStorage).loadState(),
      "INVALID_RECONCILIATION_STATE",
    );
    assert.equal(memoryStorage.calls.set.length, 0);
    assert.equal(memoryStorage.getValues()[STORAGE_KEY], envelope);
  });
}

test("rejects legacy manual-unpaid state at the v7 storage boundary", async () => {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.mapVariation(state, {
    streamId: "evening-stream",
    variationNumber: 9,
    sku: "BLACK-TEE-M",
  });
  state.streams[0].variations[0].mappingStatus = "marked_unpaid";

  const memoryStorage = createMemoryStorage();
  const store = createStore(memoryStorage);

  await assertStorageError(
    () => store.saveState(state),
    "INVALID_RECONCILIATION_STATE",
  );
  assert.equal(memoryStorage.calls.set.length, 0);
});

test("round-trips price and legacy-payment conflicts while canceled completion stays ignored", async () => {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.mapVariation(state, {
    streamId: "conflict-stream",
    variationNumber: 10,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "conflict-stream",
    variationNumber: 10,
    soldPriceCents: 3600,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "conflict-stream",
    variationNumber: 10,
    soldPriceCents: 3700,
  });
  reconciliation.mapVariation(state, {
    streamId: "conflict-stream",
    variationNumber: 11,
    sku: "GREY-HOODIE-L",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "conflict-stream",
    variationNumber: 11,
    soldPriceCents: 4800,
  });
  state.streams[0].variations[1].conflicts.push({
    code: "payment_completed_after_marked_unpaid",
  });
  reconciliation.mapVariation(state, {
    streamId: "conflict-stream",
    variationNumber: 12,
    sku: "BLACK-TEE-M",
  });
  reconciliation.observePaymentStatuses(state, {
    streamId: "conflict-stream",
    statuses: [
      {
        variationNumber: 12,
        observedPaymentStatus: "canceled",
      },
    ],
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "conflict-stream",
    variationNumber: 12,
    soldPriceCents: 3900,
  });

  const memoryStorage = createMemoryStorage();
  const store = createStore(memoryStorage);

  await store.saveState(state);
  assert.deepEqual(await store.loadState(), state);
  assert.equal(state.streams[0].variations[2].paymentStatus, "canceled");
  assert.equal(state.streams[0].variations[2].soldPriceCents, null);
  assert.deepEqual(state.streams[0].variations[2].conflicts, []);
});

test("rejects an envelope with unversioned extra fields", async () => {
  const envelope = {
    ...createEnvelope(),
    savedAt: "2026-08-08T12:00:00.000Z",
  };
  const memoryStorage = createMemoryStorage({ [STORAGE_KEY]: envelope });

  await assertStorageError(
    () => createStore(memoryStorage).loadState(),
    "INVALID_STORAGE_ENVELOPE",
  );
  assert.equal(memoryStorage.calls.set.length, 0);
});

for (const [label, invalidResponse] of [
  ["null", null],
  ["an array", []],
  ["a string", "invalid response"],
]) {
  test(
    `rejects ${label} browser-storage response as a read failure`,
    async () => {
      const memoryStorage = createMemoryStorage(invalidResponse);

      await assertStorageError(
        () => createStore(memoryStorage).loadState(),
        "STORAGE_READ_FAILED",
      );
      assert.equal(memoryStorage.calls.set.length, 0);
    },
  );
}

test("rejects invalid state before writing and preserves the prior snapshot", async () => {
  const priorState = createState();
  const priorEnvelope = createEnvelope(priorState);
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: priorEnvelope,
  });
  const invalidState = createState();
  activeBaseline(invalidState).inventory[0].quantityOnHandAtImport = -1;

  await assertStorageError(
    () => createStore(memoryStorage).saveState(invalidState),
    "INVALID_RECONCILIATION_STATE",
  );
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.equal(memoryStorage.getValues()[STORAGE_KEY], priorEnvelope);
});

test("rejects an unsupported reconciliation version before writing", async () => {
  const futureState = createState();
  futureState.version = reconciliation.STATE_VERSION + 1;
  const memoryStorage = createMemoryStorage();

  await assertStorageError(
    () => createStore(memoryStorage).saveState(futureState),
    "UNSUPPORTED_RECONCILIATION_VERSION",
  );
  assert.equal(memoryStorage.calls.set.length, 0);
});

test("wraps browser-storage read failures and preserves their cause", async () => {
  const memoryStorage = createMemoryStorage();
  const readError = new Error("browser read failed");
  memoryStorage.failReadsWith(readError);

  await assertStorageError(
    () => createStore(memoryStorage).loadState(),
    "STORAGE_READ_FAILED",
    readError,
  );
  assert.equal(memoryStorage.calls.set.length, 0);
});

test("wraps browser-storage write failures without replacing stored state", async () => {
  const priorEnvelope = createEnvelope();
  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: priorEnvelope,
  });
  const writeError = new Error("quota exceeded");
  memoryStorage.failWritesWith(writeError);

  await assertStorageError(
    () => createStore(memoryStorage).saveState(createState()),
    "STORAGE_WRITE_FAILED",
    writeError,
  );
  assert.equal(memoryStorage.calls.set.length, 1);
  assert.equal(memoryStorage.getValues()[STORAGE_KEY], priorEnvelope);
});

test("works through injected dependencies without a browser global", async () => {
  assert.equal(globalThis.chrome, undefined);

  const memoryStorage = createMemoryStorage();
  const state = createState();
  const store = createStore(memoryStorage);

  await store.saveState(state);
  assert.deepEqual(await store.loadState(), state);
});

test("rejects missing adapter dependencies immediately", () => {
  assert.throws(() => createReconciliationStateStore(), TypeError);
  assert.throws(
    () => createReconciliationStateStore({
      storageArea: {},
      reconciliation,
    }),
    TypeError,
  );
});
