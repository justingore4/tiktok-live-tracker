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

  state.inventory[0].name = "Caller changed this later";
  state.streams[0].variations[0].sku = "GREY-HOODIE-L";

  const firstLoad = await store.loadState();
  assert.deepEqual(firstLoad, original);
  assert.notEqual(
    firstLoad,
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState,
  );

  firstLoad.inventory[0].name = "Loaded copy changed";
  firstLoad.streams[0].variations[0].sku = "GREY-HOODIE-L";

  assert.deepEqual(await store.loadState(), original);
  assert.deepEqual(
    memoryStorage.getValues()[STORAGE_KEY].reconciliationState,
    original,
  );
  assert.equal(memoryStorage.getValues().unrelated, "preserved");
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
  futureState.version = 2;
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
    state.inventory = {};
  }],
  ["malformed inventory row", (state) => {
    state.inventory[0] = null;
  }],
  ["duplicate inventory SKU", (state) => {
    state.inventory.push(clone(state.inventory[0]));
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
  ["unknown payment status", (state) => {
    state.streams[0].variations[0].paymentStatus = "refunded";
  }],
  ["money on an unknown payment", (state) => {
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

test("accepts the intentional late-payment conflict state", async () => {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.mapVariation(state, {
    streamId: "evening-stream",
    variationNumber: 9,
    sku: "BLACK-TEE-M",
  });
  reconciliation.markUnpaid(state, {
    streamId: "evening-stream",
    variationNumber: 9,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "evening-stream",
    variationNumber: 9,
    soldPriceCents: 3600,
  });

  const memoryStorage = createMemoryStorage({
    [STORAGE_KEY]: createEnvelope(state),
  });

  assert.deepEqual(await createStore(memoryStorage).loadState(), state);
});

test("round-trips canonical price and payment-after-unpaid conflicts", async () => {
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
  reconciliation.markUnpaid(state, {
    streamId: "conflict-stream",
    variationNumber: 11,
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: "conflict-stream",
    variationNumber: 11,
    soldPriceCents: 4800,
  });
  reconciliation.undoMarkUnpaid(state, {
    streamId: "conflict-stream",
    variationNumber: 11,
  });

  const memoryStorage = createMemoryStorage();
  const store = createStore(memoryStorage);

  await store.saveState(state);
  assert.deepEqual(await store.loadState(), state);
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
  invalidState.inventory[0].quantityReceived = -1;

  await assertStorageError(
    () => createStore(memoryStorage).saveState(invalidState),
    "INVALID_RECONCILIATION_STATE",
  );
  assert.equal(memoryStorage.calls.set.length, 0);
  assert.equal(memoryStorage.getValues()[STORAGE_KEY], priorEnvelope);
});

test("rejects an unsupported reconciliation version before writing", async () => {
  const futureState = createState();
  futureState.version = 2;
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
