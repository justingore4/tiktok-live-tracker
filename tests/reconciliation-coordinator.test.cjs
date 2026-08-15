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

function activeBaseline(state) {
  return state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === state.activeInventoryBaselineId,
  );
}

function legacyInventoryProjection(state) {
  return activeBaseline(state).inventory.map((entry) => ({
    sku: entry.sku,
    name: entry.style ? `${entry.item} - ${entry.style}` : entry.item,
    size: entry.size,
    quantityReceived: entry.quantityOnHandAtImport,
    unitCostCents: entry.unitCostCents,
  }));
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

function observeCommand(variationNumbers, streamId = "stream-1") {
  return {
    type: COMMAND_TYPES.OBSERVE_VARIATIONS,
    streamId,
    variationNumbers,
  };
}

function observePaymentStatusesCommand(
  statuses,
  streamId = "stream-1",
) {
  return {
    type: COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES,
    streamId,
    statuses,
  };
}

function unmapCommand(variationNumber) {
  return {
    type: COMMAND_TYPES.UNMAP_VARIATION,
    streamId: "stream-1",
    variationNumber,
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

test("creates the first confirmed inventory baseline without seeding legacy inventory", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);
  const baselineId =
    "inventory-baseline:50000000-0000-4000-8000-000000000000";
  const created = await coordinator.dispatch({
    type: COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
    baselineId,
    sourceFingerprint: "fnv1a64:5234567890abcdef",
    inventory: [{
      sku: "BLACK-TEE-M",
      item: "Black Tee",
      style: "black",
      size: "M",
      quantityOnHandAtImport: 4,
      unitCostCents: 1250,
    }],
  });

  assert.deepEqual(created.result, { status: "created", baselineId });
  assert.equal(created.state.activeInventoryBaselineId, baselineId);
  assert.equal(created.state.inventoryBaselines.length, 1);
  assert.equal(created.state.inventoryBaselines[0].sourceFingerprint,
    "fnv1a64:5234567890abcdef");
  assert.equal(memoryStore.calls.save.length, 1);
  assert.deepEqual(memoryStore.getPersistedState(), created.state);
});

test("initializes once, persists immediately, and treats identical retry as a no-op", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  const initialized = await coordinator.dispatch(initializeCommand());
  const repeated = await coordinator.dispatch(initializeCommand(clone(INVENTORY)));

  assert.equal(initialized.result.status, "initialized");
  assert.equal(repeated.result.status, "already_initialized");
  assert.deepEqual(legacyInventoryProjection(initialized.state), INVENTORY);
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

test("persists a batch observation once and skips writes for its retry", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const observed = await coordinator.dispatch(observeCommand([44, 43, 42]));
  const repeated = await coordinator.dispatch(observeCommand([44, 43, 42]));

  assert.deepEqual(observed.result, {
    status: "observed",
    observedCount: 3,
    newlyObservedCount: 3,
  });
  assert.deepEqual(repeated.result, {
    status: "already_observed",
    observedCount: 3,
    newlyObservedCount: 0,
  });
  assert.equal(memoryStore.calls.save.length, 1);
  assert.deepEqual(
    memoryStore.getPersistedState().streams[0].variations.map(
      (auction) => auction.variationNumber,
    ),
    [44, 43, 42],
  );
});

test("observations never regress existing mappings or completed payments", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.mapVariation(storedState, {
    streamId: "stream-1",
    variationNumber: 40,
    sku: "BLACK-TEE-M",
  });
  reconciliation.recordPaymentComplete(storedState, {
    streamId: "stream-1",
    variationNumber: 40,
    soldPriceCents: 7000,
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const response = await coordinator.dispatch(observeCommand([40]));

  assert.equal(response.result.status, "already_observed");
  assert.equal(memoryStore.calls.save.length, 0);
  assert.equal(response.state.streams[0].variations[0].sku, "BLACK-TEE-M");
  assert.equal(
    response.state.streams[0].variations[0].paymentStatus,
    "payment_complete",
  );
  assert.equal(response.state.streams[0].variations[0].soldPriceCents, 7000);
});

test("persists payment-status batches once and skips identical retries", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.mapVariation(storedState, {
    streamId: "stream-1",
    variationNumber: 44,
    sku: "BLACK-TEE-M",
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);
  const statuses = [
    {
      variationNumber: 44,
      observedPaymentStatus: "payment_processing",
    },
    {
      variationNumber: 45,
      observedPaymentStatus: "payment_failed",
    },
    {
      variationNumber: 46,
      observedPaymentStatus: "canceled",
    },
  ];

  const observed = await coordinator.dispatch(
    observePaymentStatusesCommand(statuses),
  );
  const repeated = await coordinator.dispatch(
    observePaymentStatusesCommand(clone(statuses)),
  );

  assert.deepEqual(observed.result, {
    status: "observed",
    observedCount: 3,
    updatedCount: 3,
    ignoredCount: 0,
  });
  assert.deepEqual(repeated.result, {
    status: "already_observed",
    observedCount: 3,
    updatedCount: 0,
    ignoredCount: 0,
  });
  assert.equal(memoryStore.calls.save.length, 1);
  assert.equal(observed.state.streams[0].variations[0].sku, "BLACK-TEE-M");
  assert.equal(
    observed.state.streams[0].variations[0].observedPaymentStatus,
    "payment_processing",
  );
  assert.equal(observed.state.streams[0].variations[0].paymentStatus, "unknown");
  assert.equal(observed.state.streams[0].variations[0].soldPriceCents, null);
  assert.equal(
    observed.state.streams[0].variations[1].observedPaymentStatus,
    "payment_failed",
  );
  assert.equal(
    observed.state.streams[0].variations[2].observedPaymentStatus,
    "canceled",
  );
  assert.equal(observed.state.streams[0].variations[2].paymentStatus, "canceled");
});

test("persists mapped reservations through every nonterminal payment status", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const mapped = await coordinator.dispatch(mapCommand(49));
  const processing = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 49,
        observedPaymentStatus: "payment_processing",
      },
    ]),
  );
  const failed = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 49,
        observedPaymentStatus: "payment_failed",
      },
    ]),
  );
  const fixing = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 49,
        observedPaymentStatus: "payment_fixing",
      },
    ]),
  );
  const key = {
    streamId: "stream-1",
    variationNumber: 49,
    sku: "BLACK-TEE-M",
  };

  assert.equal(mapped.result.status, "pending");
  assert.equal(
    reconciliation.getInventoryAvailability(mapped.state, key)
      .reservedQuantity,
    1,
  );
  assert.equal(
    reconciliation.getAuction(processing.state, key).status,
    "pending",
  );
  assert.equal(
    reconciliation.getInventoryAvailability(processing.state, key)
      .reservedQuantity,
    1,
  );
  assert.equal(reconciliation.getAuction(failed.state, key).status, "pending");
  assert.equal(
    reconciliation.getInventoryAvailability(failed.state, key)
      .reservedQuantity,
    1,
  );
  assert.equal(reconciliation.getAuction(fixing.state, key).status, "pending");
  assert.equal(
    reconciliation.getInventoryAvailability(fixing.state, key)
      .reservedQuantity,
    1,
  );
  assert.equal(memoryStore.calls.save.length, 4);
  assert.deepEqual(memoryStore.getPersistedState(), fixing.state);
});

test("persisted cancellation releases capacity for the next variation", async () => {
  const inventory = [
    {
      sku: "BLACK-TEE-M",
      name: "Black Tee",
      size: "M",
      quantityReceived: 1,
      unitCostCents: 1200,
    },
  ];
  const storedState = reconciliation.createReconciliationState(inventory);
  reconciliation.observePaymentStatuses(storedState, {
    streamId: "stream-1",
    statuses: [
      {
        variationNumber: 47,
        observedPaymentStatus: "payment_processing",
      },
      {
        variationNumber: 48,
        observedPaymentStatus: "payment_processing",
      },
    ],
  });
  reconciliation.mapVariation(storedState, {
    streamId: "stream-1",
    variationNumber: 47,
    sku: "BLACK-TEE-M",
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const canceled = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 47,
        observedPaymentStatus: "canceled",
      },
    ]),
  );
  const replacement = await coordinator.dispatch(mapCommand(48));

  assert.equal(canceled.state.streams[0].variations[0].sku, "BLACK-TEE-M");
  assert.equal(canceled.state.streams[0].variations[0].mappingStatus, "mapped");
  assert.equal(canceled.state.streams[0].variations[0].paymentStatus, "canceled");
  assert.equal(canceled.state.streams[0].variations[0].soldPriceCents, null);
  assert.equal(replacement.result.status, "pending");
  assert.equal(memoryStore.calls.save.length, 2);
  assert.deepEqual(
    memoryStore.getPersistedState().streams[0].variations.map(
      (auction) => [auction.variationNumber, auction.paymentStatus],
    ),
    [
      [47, "canceled"],
      [48, "unknown"],
    ],
  );
});

test("serializes statuses while cancellation and priced completion stay sticky", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const processing = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 46,
        observedPaymentStatus: "payment_processing",
      },
    ]),
  );
  const fixing = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 46,
        observedPaymentStatus: "payment_fixing",
      },
    ]),
  );
  const failed = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 46,
        observedPaymentStatus: "payment_failed",
      },
    ]),
  );
  const canceled = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 46,
        observedPaymentStatus: "canceled",
      },
    ]),
  );
  const writesBeforeStaleStatus = memoryStore.calls.save.length;
  const staleProcessing = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 46,
        observedPaymentStatus: "payment_processing",
      },
    ]),
  );
  const writesAfterStaleStatus = memoryStore.calls.save.length;
  const completed = await coordinator.dispatch(paymentCommand(46, 3200));
  const writesBeforeLateStatus = memoryStore.calls.save.length;
  const lateFailure = await coordinator.dispatch(
    observePaymentStatusesCommand([
      {
        variationNumber: 46,
        observedPaymentStatus: "payment_failed",
      },
    ]),
  );

  assert.equal(
    processing.state.streams[0].variations[0].observedPaymentStatus,
    "payment_processing",
  );
  assert.equal(
    fixing.state.streams[0].variations[0].observedPaymentStatus,
    "payment_fixing",
  );
  assert.equal(
    failed.state.streams[0].variations[0].observedPaymentStatus,
    "payment_failed",
  );
  assert.equal(
    canceled.state.streams[0].variations[0].observedPaymentStatus,
    "canceled",
  );
  assert.equal(
    canceled.state.streams[0].variations[0].paymentStatus,
    "canceled",
  );
  assert.deepEqual(staleProcessing.result, {
    status: "already_observed",
    observedCount: 1,
    updatedCount: 0,
    ignoredCount: 1,
  });
  assert.equal(writesAfterStaleStatus, writesBeforeStaleStatus);
  assert.equal(
    staleProcessing.state.streams[0].variations[0].paymentStatus,
    "canceled",
  );
  assert.equal(
    completed.state.streams[0].variations[0].observedPaymentStatus,
    "canceled",
  );
  assert.equal(completed.state.streams[0].variations[0].soldPriceCents, null);
  assert.equal(completed.result.status, "canceled");
  assert.deepEqual(completed.result.conflicts, []);
  assert.deepEqual(lateFailure.result, {
    status: "already_observed",
    observedCount: 1,
    updatedCount: 0,
    ignoredCount: 1,
  });
  assert.equal(memoryStore.calls.save.length, writesBeforeLateStatus);
  assert.equal(
    lateFailure.state.streams[0].variations[0].observedPaymentStatus,
    "canceled",
  );
});

test("identical completed-payment retries do not write again", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.recordPaymentComplete(storedState, {
    streamId: "stream-1",
    variationNumber: 41,
    soldPriceCents: 800,
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const response = await coordinator.dispatch(paymentCommand(41, 800));

  assert.equal(response.result.status, "unmapped_completed");
  assert.equal(memoryStore.calls.save.length, 0);
  assert.deepEqual(memoryStore.getPersistedState(), storedState);
});

test("routes employee mapping and captured payment commands", async () => {
  const memoryStore = createMemoryStateStore();
  const coordinator = createCoordinator(memoryStore);

  await coordinator.dispatch(initializeCommand());
  const mapped = await coordinator.dispatch(mapCommand(1));
  const completed = await coordinator.dispatch(paymentCommand(1));
  await coordinator.dispatch(mapCommand(2, "GREY-HOODIE-L"));

  assert.equal(mapped.result.status, "pending");
  assert.equal(completed.result.status, "committed");
  assert.equal(completed.result.profitCents, 3600);
  assert.equal(memoryStore.calls.save.length, 4);
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

test("persists an unmap command and returns the canonical unselected state", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.mapVariation(storedState, {
    streamId: "stream-1",
    variationNumber: 6,
    sku: "BLACK-TEE-M",
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const response = await coordinator.dispatch(unmapCommand(6));
  const persistedAuction =
    memoryStore.getPersistedState().streams[0].variations[0];

  assert.equal(response.result.status, "unmapped");
  assert.equal(response.result.sku, null);
  assert.equal(response.state.streams[0].variations[0].sku, null);
  assert.equal(persistedAuction.sku, null);
  assert.equal(persistedAuction.mappingStatus, "unmapped");
  assert.equal(memoryStore.calls.save.length, 1);
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

test("serializes competing last-unit mappings and records visible over-allocation", async () => {
  const lastUnitInventory = [
    {
      sku: "BLACK-TEE-M",
      name: "Black Tee",
      size: "M",
      quantityReceived: 1,
      unitCostCents: 1200,
    },
  ];
  const storedState = reconciliation.createReconciliationState(
    lastUnitInventory,
  );
  reconciliation.observePaymentStatuses(storedState, {
    streamId: "stream-1",
    statuses: [
      {
        variationNumber: 14,
        observedPaymentStatus: "payment_processing",
      },
      {
        variationNumber: 15,
        observedPaymentStatus: "payment_fixing",
      },
    ],
  });
  const memoryStore = createMemoryStateStore(storedState);
  const coordinator = createCoordinator(memoryStore);

  const outcomes = await Promise.allSettled([
    coordinator.dispatch(mapCommand(14)),
    coordinator.dispatch(mapCommand(15)),
  ]);

  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[0].value.result.status, "pending");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(outcomes[1].value.result.status, "pending");
  assert.equal(memoryStore.calls.save.length, 2);
  assert.deepEqual(
    memoryStore.getPersistedState().streams[0].variations.map(
      (auction) => [auction.variationNumber, auction.sku],
    ),
    [
      [14, "BLACK-TEE-M"],
      [15, "BLACK-TEE-M"],
    ],
  );
  const availability = reconciliation.getInventoryAvailability(
    memoryStore.getPersistedState(),
    { sku: "BLACK-TEE-M" },
  );

  assert.equal(availability.reservedQuantity, 2);
  assert.equal(availability.oversoldQuantity, 1);

  const repeated = await coordinator.dispatch(mapCommand(14));
  const snapshot = await coordinator.dispatch(getStateCommand());

  assert.equal(repeated.result.status, "pending");
  assert.equal(memoryStore.calls.save.length, 2);
  assert.deepEqual(snapshot.state, memoryStore.getPersistedState());
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

test("a failed unmap save leaves the canonical and durable mapping unchanged", async () => {
  const storedState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.mapVariation(storedState, {
    streamId: "stream-1",
    variationNumber: 32,
    sku: "BLACK-TEE-M",
  });
  const memoryStore = createMemoryStateStore(storedState);
  const writeError = new ReconciliationStorageError(
    "STORAGE_WRITE_FAILED",
    "write failed",
  );
  const coordinator = createCoordinator(memoryStore);

  memoryStore.failNextSave(writeError);
  await assertErrorCode(
    () => coordinator.dispatch(unmapCommand(32)),
    "STORAGE_WRITE_FAILED",
    ReconciliationStorageError,
  );

  const afterFailure = await coordinator.dispatch(getStateCommand());

  assert.equal(afterFailure.state.streams[0].variations[0].sku, "BLACK-TEE-M");
  assert.equal(
    memoryStore.getPersistedState().streams[0].variations[0].sku,
    "BLACK-TEE-M",
  );

  const retried = await coordinator.dispatch(unmapCommand(32));

  assert.equal(retried.result.status, "unmapped");
  assert.equal(retried.state.streams[0].variations[0].sku, null);
  assert.equal(memoryStore.getPersistedState().streams[0].variations[0].sku, null);
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

  activeBaseline(mapped.state).inventory[0].item = "Changed by caller";
  mapped.state.streams[0].variations[0].sku = "GREY-HOODIE-L";
  mapped.result.conflicts.push({ code: "fake" });

  const fresh = await coordinator.dispatch(getStateCommand());

  assert.equal(activeBaseline(fresh.state).inventory[0].item, "Black Tee");
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
  await assertErrorCode(
    () => coordinator.dispatch({ ...unmapCommand(1), sku: "BLACK-TEE-M" }),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );
  await assertErrorCode(
    () => coordinator.dispatch(observeCommand([1, 1])),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );
  await assertErrorCode(
    () => coordinator.dispatch(observeCommand([])),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );

  for (const statuses of [
    [],
    [
      {
        variationNumber: 1,
        observedPaymentStatus: "not_observed",
      },
    ],
    [{ variationNumber: 1, observedPaymentStatus: "payment_pending" }],
    [
      { variationNumber: 1, observedPaymentStatus: "payment_processing" },
      { variationNumber: 1, observedPaymentStatus: "payment_failed" },
    ],
    [
      {
        variationNumber: 1,
        observedPaymentStatus: "payment_failed",
        extra: true,
      },
    ],
  ]) {
    await assertErrorCode(
      () => coordinator.dispatch(observePaymentStatusesCommand(statuses)),
      "INVALID_COMMAND",
      ReconciliationCoordinatorError,
    );
  }

  await assertErrorCode(
    () =>
      coordinator.dispatch({
        ...observePaymentStatusesCommand([
          {
            variationNumber: 1,
            observedPaymentStatus: "payment_processing",
          },
        ]),
        extra: true,
      }),
    "INVALID_COMMAND",
    ReconciliationCoordinatorError,
  );

  await assertErrorCode(
    () =>
      coordinator.dispatch(
        observePaymentStatusesCommand(
          Array.from({ length: 1001 }, (_, index) => ({
            variationNumber: index + 1,
            observedPaymentStatus: "payment_processing",
          })),
        ),
      ),
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
  const missingPaymentStatusObserver = { ...reconciliation };
  delete missingPaymentStatusObserver.observePaymentStatuses;

  assert.throws(
    () =>
      createReconciliationCoordinator({
        reconciliation: missingPaymentStatusObserver,
        stateStore: createMemoryStateStore().stateStore,
      }),
    TypeError,
  );
});
