const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  ReconciliationStorageError,
} = require("../extension/shared/reconciliation-storage.js");
const {
  COMMAND_TYPES,
  ReconciliationCoordinatorError,
  createReconciliationCoordinator,
} = require("../extension/shared/reconciliation-coordinator.js");

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
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createMemoryStateStore(initialState = null) {
  let persistedState = clone(initialState);
  let nextLoadError = null;
  let nextSaveError = null;
  let beforeSave = null;
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const calls = { load: 0, save: [] };
  const stateStore = {
    async loadState() {
      calls.load += 1;

      if (nextLoadError) {
        const error = nextLoadError;
        nextLoadError = null;
        throw error;
      }

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
    failNextLoad(error) {
      nextLoadError = error;
    },
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

function initializeCommand(inventory = INVENTORY) {
  return {
    type: COMMAND_TYPES.INITIALIZE_STATE,
    inventory,
  };
}

function getStateCommand() {
  return { type: COMMAND_TYPES.GET_STATE };
}

function mapCommand(variationNumber, sku = "BLACK-TEE-M") {
  return {
    type: COMMAND_TYPES.MAP_VARIATION,
    streamId: "stream-1",
    variationNumber,
    sku,
  };
}

function paymentCommand(variationNumber, soldPriceCents = 4800) {
  return {
    type: COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
    streamId: "stream-1",
    variationNumber,
    soldPriceCents,
  };
}

function unpaidCommand(type, variationNumber) {
  return {
    type,
    streamId: "stream-1",
    variationNumber,
  };
}

async function assertErrorCode(action, code, ErrorType = Error) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ErrorType);
    assert.equal(error.code, code);
    return true;
  });
}

test("returns an explicit uninitialized state when storage is empty", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  assert.deepEqual(await coordinator.dispatch(getStateCommand()), {
    state: null,
    result: null,
  });
  assert.deepEqual(await coordinator.dispatch(getStateCommand()), {
    state: null,
    result: null,
  });
  assert.equal(memoryStore.calls.load, 1);
  assert.equal(memoryStore.calls.save.length, 0);
});

test("initializes once, persists immediately, and treats identical retry as a no-op", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  const initialized = await coordinator.dispatch(initializeCommand());
  const repeated = await coordinator.dispatch(initializeCommand(clone(INVENTORY)));

  assert.equal(initialized.result.status, "initialized");
  assert.equal(repeated.result.status, "already_initialized");
  assert.deepEqual(initialized.state.inventory, INVENTORY);
  assert.equal(memoryStore.calls.load, 1);
  assert.equal(memoryStore.calls.save.length, 1);
  assert.deepEqual(memoryStore.getPersistedState(), initialized.state);
});

test("refuses to replace initialized inventory", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);
  const changedInventory = clone(INVENTORY);
  changedInventory[0].quantityReceived = 99;

  await assertErrorCode(
    () => coordinator.dispatch(initializeCommand(changedInventory)),
    "STATE_ALREADY_INITIALIZED",
    ReconciliationCoordinatorError,
  );
  assert.equal(memoryStore.calls.save.length, 0);
  assert.deepEqual(memoryStore.getPersistedState(), storedState);
});

test("identical initialization after restart preserves existing auctions", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.mapVariation(storedState, {
    streamId: "earlier-stream",
    variationNumber: 7,
    sku: "BLACK-TEE-M",
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const result = await coordinator.dispatch(initializeCommand());

  assert.equal(result.result.status, "already_initialized");
  assert.deepEqual(result.state, storedState);
  assert.equal(memoryStore.calls.save.length, 0);
  assert.deepEqual(memoryStore.getPersistedState(), storedState);
});

test("rejects mutations before inventory initialization without writing", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  await assertErrorCode(
    () => coordinator.dispatch(mapCommand(1)),
    "STATE_NOT_INITIALIZED",
    ReconciliationCoordinatorError,
  );
  assert.equal(memoryStore.calls.save.length, 0);

  const initialized = await coordinator.dispatch(initializeCommand());
  assert.equal(initialized.result.status, "initialized");
});

test("routes mapping, payment, unpaid, and undo commands through one state", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  await coordinator.dispatch(initializeCommand());
  const mapped = await coordinator.dispatch(mapCommand(1));
  const completed = await coordinator.dispatch(paymentCommand(1));
  await coordinator.dispatch(mapCommand(2, "GREY-HOODIE-L"));
  const unpaid = await coordinator.dispatch(
    unpaidCommand(COMMAND_TYPES.MARK_UNPAID, 2),
  );
  const undone = await coordinator.dispatch(
    unpaidCommand(COMMAND_TYPES.UNDO_MARK_UNPAID, 2),
  );

  assert.equal(mapped.result.status, "pending");
  assert.equal(completed.result.status, "committed");
  assert.equal(completed.result.profitCents, 3600);
  assert.equal(unpaid.result.status, "marked_unpaid");
  assert.equal(undone.result.status, "pending");
  assert.equal(memoryStore.calls.save.length, 6);
  assert.deepEqual(memoryStore.getPersistedState(), undone.state);
});

test("supports payment arriving before employee mapping", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const payment = await coordinator.dispatch(paymentCommand(5, 5000));
  const mapping = await coordinator.dispatch(mapCommand(5, "GREY-HOODIE-L"));

  assert.equal(payment.result.status, "unmapped_completed");
  assert.equal(mapping.result.status, "committed");
  assert.equal(mapping.result.profitCents, 2600);
  assert.equal(memoryStore.calls.save.length, 2);
});

test("serializes concurrent writes without losing an update", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const firstSaveStarted = createDeferred();
  const releaseFirstSave = createDeferred();

  memoryStore.setBeforeSave(async (_state, saveIndex) => {
    if (saveIndex === 0) {
      firstSaveStarted.resolve();
      await releaseFirstSave.promise;
    }
  });

  const coordinator = createCoordinator(memoryStore);
  const first = coordinator.dispatch(mapCommand(10));
  const second = coordinator.dispatch(mapCommand(11, "GREY-HOODIE-L"));

  await firstSaveStarted.promise;
  assert.equal(memoryStore.calls.save.length, 1);
  assert.deepEqual(
    memoryStore.calls.save[0].streams[0].variations.map(
      (auction) => auction.variationNumber,
    ),
    [10],
  );

  releaseFirstSave.resolve();
  await Promise.all([first, second]);

  assert.equal(memoryStore.calls.save.length, 2);
  assert.deepEqual(
    memoryStore.calls.save[1].streams[0].variations.map(
      (auction) => auction.variationNumber,
    ),
    [10, 11],
  );
  assert.equal(memoryStore.getMaximumActiveSaves(), 1);
});

test("snapshots a command before it waits in the queue", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const firstSaveStarted = createDeferred();
  const releaseFirstSave = createDeferred();

  memoryStore.setBeforeSave(async (_state, saveIndex) => {
    if (saveIndex === 0) {
      firstSaveStarted.resolve();
      await releaseFirstSave.promise;
    }
  });

  const coordinator = createCoordinator(memoryStore);
  const first = coordinator.dispatch(mapCommand(12));

  await firstSaveStarted.promise;

  const queuedCommand = mapCommand(13, "GREY-HOODIE-L");
  const second = coordinator.dispatch(queuedCommand);

  queuedCommand.variationNumber = 999;
  queuedCommand.sku = "BLACK-TEE-M";
  releaseFirstSave.resolve();

  await Promise.all([first, second]);

  const auctions = memoryStore.getPersistedState().streams[0].variations;
  assert.deepEqual(
    auctions.map((auction) => [auction.variationNumber, auction.sku]),
    [
      [12, "BLACK-TEE-M"],
      [13, "GREY-HOODIE-L"],
    ],
  );
});

test("queues reads behind an unfinished durable write", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const saveStarted = createDeferred();
  const releaseSave = createDeferred();
  let readSettled = false;

  memoryStore.setBeforeSave(async (_state, saveIndex) => {
    if (saveIndex === 0) {
      saveStarted.resolve();
      await releaseSave.promise;
    }
  });

  const coordinator = createCoordinator(memoryStore);
  const write = coordinator.dispatch(mapCommand(20));
  const read = coordinator.dispatch(getStateCommand()).then((value) => {
    readSettled = true;
    return value;
  });

  await saveStarted.promise;
  await Promise.resolve();
  assert.equal(readSettled, false);

  releaseSave.resolve();
  await write;
  const snapshot = await read;

  assert.equal(snapshot.state.streams[0].variations[0].variationNumber, 20);
});

test("rolls back memory when a durable write fails and keeps the queue usable", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const writeError = new ReconciliationStorageError(
    "STORAGE_WRITE_FAILED",
    "write failed",
  );
  const coordinator = createCoordinator(memoryStore);

  memoryStore.failNextSave(writeError);
  await assertErrorCode(
    () => coordinator.dispatch(mapCommand(30)),
    "STORAGE_WRITE_FAILED",
    ReconciliationStorageError,
  );

  const afterFailure = await coordinator.dispatch(getStateCommand());
  assert.deepEqual(afterFailure.state, storedState);
  assert.deepEqual(memoryStore.getPersistedState(), storedState);

  const successful = await coordinator.dispatch(mapCommand(31));
  assert.deepEqual(
    successful.state.streams[0].variations.map(
      (auction) => auction.variationNumber,
    ),
    [31],
  );
});

test("engine rejection creates no partial state and does not poison later commands", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  await assertErrorCode(
    () => coordinator.dispatch(mapCommand(40, "MISSING-SKU")),
    "UNKNOWN_SKU",
    reconciliation.ReconciliationError,
  );
  assert.equal(memoryStore.calls.save.length, 0);

  const successful = await coordinator.dispatch(mapCommand(41));
  assert.equal(successful.result.status, "pending");
  assert.equal(memoryStore.calls.save.length, 1);
});

test("retries a failed cold-start load without defaulting or writing", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const readError = new ReconciliationStorageError(
    "STORAGE_READ_FAILED",
    "read failed",
  );
  const coordinator = createCoordinator(memoryStore);

  memoryStore.failNextLoad(readError);
  await assertErrorCode(
    () => coordinator.dispatch(getStateCommand()),
    "STORAGE_READ_FAILED",
    ReconciliationStorageError,
  );
  assert.equal(memoryStore.calls.save.length, 0);

  const recovered = await coordinator.dispatch(getStateCommand());
  assert.deepEqual(recovered.state, storedState);
  assert.equal(memoryStore.calls.load, 2);
});

test("returned snapshots and results cannot mutate canonical state", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);
  const mapped = await coordinator.dispatch(mapCommand(50));

  mapped.state.inventory[0].name = "Changed by caller";
  mapped.state.streams[0].variations[0].sku = "GREY-HOODIE-L";
  mapped.result.conflicts.push({ code: "fake" });

  const fresh = await coordinator.dispatch(getStateCommand());

  assert.equal(fresh.state.inventory[0].name, "Black Tee");
  assert.equal(fresh.state.streams[0].variations[0].sku, "BLACK-TEE-M");
  assert.deepEqual(fresh.state.streams[0].variations[0].conflicts, []);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), fresh);
  assert.deepEqual(structuredClone(fresh), fresh);
});

test("a new coordinator restores the last durable state after worker restart", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const firstCoordinator = createCoordinator(memoryStore);

  await firstCoordinator.dispatch(mapCommand(60));

  const secondCoordinator = createCoordinator(memoryStore);
  const restored = await secondCoordinator.dispatch(getStateCommand());
  const completed = await secondCoordinator.dispatch(paymentCommand(60, 4200));

  assert.equal(restored.result, null);
  assert.equal(restored.state.streams[0].variations[0].sku, "BLACK-TEE-M");
  assert.equal(completed.result.status, "committed");
  assert.equal(completed.result.profitCents, 3000);
  assert.equal(memoryStore.calls.load, 2);
});

test("rejects malformed and unknown commands before storage access", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  await assertErrorCode(
    () => coordinator.dispatch(null),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );
  await assertErrorCode(
    () => coordinator.dispatch({ type: "missing" }),
    "UNKNOWN_COMMAND",
    ReconciliationCoordinatorError,
  );
  await assertErrorCode(
    () => coordinator.dispatch({ type: COMMAND_TYPES.GET_STATE, extra: true }),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );
  await assertErrorCode(
    () => coordinator.dispatch(initializeCommand([])),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );

  assert.equal(memoryStore.calls.load, 0);
  assert.equal(memoryStore.calls.save.length, 0);
});

test("failed first initialization remains uninitialized and can be retried", async () => {
  const memoryStore = createMemoryStateStore();
  const writeError = new ReconciliationStorageError(
    "STORAGE_WRITE_FAILED",
    "write failed",
  );
  const coordinator = createCoordinator(memoryStore);

  memoryStore.failNextSave(writeError);
  await assertErrorCode(
    () => coordinator.dispatch(initializeCommand()),
    "STORAGE_WRITE_FAILED",
    ReconciliationStorageError,
  );
  assert.equal((await coordinator.dispatch(getStateCommand())).state, null);

  const retried = await coordinator.dispatch(initializeCommand());
  assert.equal(retried.result.status, "initialized");
  assert.equal(memoryStore.calls.save.length, 2);
});

test("validates coordinator dependencies immediately", () => {
  assert.throws(() => createReconciliationCoordinator(), TypeError);
  assert.throws(
    () => createReconciliationCoordinator({ reconciliation, stateStore: {} }),
    TypeError,
  );
});
