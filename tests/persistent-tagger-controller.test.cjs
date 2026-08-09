const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const controllerModule = require(
  "../extension/tagger/persistent-tagger-controller.js",
);
const reconciliation = require("../extension/shared/reconciliation.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");

const STREAM_ID = "demo-stream";
const CURRENT_VARIATION = 203;
const INVENTORY = Object.freeze([
  Object.freeze({
    sku: "BLACK-TEE-L",
    item: "Stussy tee",
    style: "black",
    size: "L",
    quantityReceived: 5,
    unitCostCents: 1200,
  }),
  Object.freeze({
    sku: "GREY-HOODIE-XL",
    item: "Nike hoodie",
    style: "grey",
    size: "XL",
    quantityReceived: 3,
    unitCostCents: 1400,
  }),
]);
const CANONICAL_INVENTORY = [
  {
    sku: "BLACK-TEE-L",
    item: "Stussy tee",
    style: "black",
    size: "L",
    quantityOnHandAtImport: 5,
    unitCostCents: 1200,
  },
  {
    sku: "GREY-HOODIE-XL",
    item: "Nike hoodie",
    style: "grey",
    size: "XL",
    quantityOnHandAtImport: 3,
    unitCostCents: 1400,
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

function createUnpinnedState() {
  return reconciliation.createReconciliationState(CANONICAL_INVENTORY);
}

function createState() {
  const state = createUnpinnedState();

  reconciliation.pinStreamToInventoryBaseline(state, {
    streamId: STREAM_ID,
  });
  return state;
}

function createMemoryClient(initialState = null) {
  let state = clone(initialState);
  const calls = [];
  const client = {
    async getState() {
      calls.push({ method: "getState" });
      return { state: clone(state), result: null };
    },
    async initializeState(inventory) {
      calls.push({ method: "initializeState", inventory: clone(inventory) });

      if (state === null) {
        state = reconciliation.createReconciliationState(inventory);
      }

      return {
        state: clone(state),
        result: { status: "initialized" },
      };
    },
    async mapVariation(options) {
      calls.push({ method: "mapVariation", options: clone(options) });
      const candidate = reconciliation.hydrateReconciliationState(state);
      const result = reconciliation.mapVariation(candidate, options);

      state = candidate;
      return { state: clone(state), result: clone(result) };
    },
    async markUnpaid(options) {
      calls.push({ method: "markUnpaid", options: clone(options) });
      const candidate = reconciliation.hydrateReconciliationState(state);
      const result = reconciliation.markUnpaid(candidate, options);

      state = candidate;
      return { state: clone(state), result: clone(result) };
    },
    async unmapVariation(options) {
      calls.push({ method: "unmapVariation", options: clone(options) });
      const candidate = reconciliation.hydrateReconciliationState(state);
      const result = reconciliation.unmapVariation(candidate, options);

      state = candidate;
      return { state: clone(state), result: clone(result) };
    },
    async undoMarkUnpaid(options) {
      calls.push({ method: "undoMarkUnpaid", options: clone(options) });
      const candidate = reconciliation.hydrateReconciliationState(state);
      const result = reconciliation.undoMarkUnpaid(candidate, options);

      state = candidate;
      return { state: clone(state), result: clone(result) };
    },
  };

  return {
    calls,
    client,
    getState: () => clone(state),
    setState: (nextState) => {
      state = clone(nextState);
    },
  };
}

function createController(client, options = {}) {
  return controllerModule.createPersistentTaggerController({
    client,
    mappingWorkflow,
    reconciliation,
    inventory: INVENTORY,
    streamId: STREAM_ID,
    currentVariationNumber: CURRENT_VARIATION,
    variationNumbers: [203, 202, 201, 200],
    ...options,
  });
}

function auctionFromSnapshot(snapshot) {
  return snapshot.view?.auction ?? null;
}

test("exports a pure saved-session controller without a payment-complete API", () => {
  const { client } = createMemoryClient();
  const controller = createController(client);
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "extension",
      "tagger",
      "persistent-tagger-controller.js",
    ),
    "utf8",
  );

  assert.deepEqual(Object.keys(controller).sort(), [
    "getSnapshot",
    "mapSelectedSku",
    "markSelectedUnpaid",
    "refresh",
    "retry",
    "selectVariation",
    "start",
    "subscribe",
    "undoSelectedUnpaid",
    "unmapSelectedVariation",
  ]);
  assert.doesNotMatch(
    source,
    /chrome\.|recordPaymentComplete|record_payment_complete|completePayment/,
  );
});

test("prepares the opening mock baseline before a stream can be started", async () => {
  const memory = createMemoryClient(null);

  const prepared = await controllerModule.ensureInventoryInitialized({
    client: memory.client,
    inventory: INVENTORY,
  });

  assert.equal(prepared.initialized, true);
  assert.deepEqual(memory.calls, [
    { method: "getState" },
    { method: "initializeState", inventory: CANONICAL_INVENTORY },
  ]);
  assert.equal(prepared.response.state.version, reconciliation.STATE_VERSION);
  assert.equal(prepared.response.state.inventoryBaselines.length, 1);
  assert.deepEqual(
    prepared.response.state.inventoryBaselines[0].inventory,
    CANONICAL_INVENTORY,
  );
});

test("pre-start inventory preparation preserves an existing baseline", async () => {
  const existing = createState();
  const memory = createMemoryClient(existing);

  const prepared = await controllerModule.ensureInventoryInitialized({
    client: memory.client,
    inventory: INVENTORY,
  });

  assert.equal(prepared.initialized, false);
  assert.deepEqual(memory.calls, [{ method: "getState" }]);
  assert.deepEqual(prepared.response.state, existing);
});

test("pre-start inventory preparation never initializes after a malformed read", async () => {
  let initializationCalls = 0;
  const client = {
    async getState() {
      return { result: null };
    },
    async initializeState() {
      initializationCalls += 1;
      throw new Error("must not initialize");
    },
  };

  await assert.rejects(
    () => controllerModule.ensureInventoryInitialized({
      client,
      inventory: INVENTORY,
    }),
    (error) => error.code === "INVALID_CLIENT_RESPONSE",
  );
  assert.equal(initializationCalls, 0);
});

test("resume projects inventory from the stream's pinned canonical baseline", async () => {
  const state = createUnpinnedState();
  const importedInventory = [
    {
      sku: "CLIENT-JACKET-M",
      item: "Client jacket",
      style: "brown",
      size: "M",
      quantityOnHandAtImport: 8,
      unitCostCents: 3100,
    },
  ];

  reconciliation.createInventoryBaseline(state, {
    baselineId:
      "inventory-baseline:22222222-2222-4222-8222-222222222222",
    sourceFingerprint: "fnv1a64:1234567890abcdef",
    inventory: importedInventory,
  });
  reconciliation.pinStreamToInventoryBaseline(state, {
    streamId: STREAM_ID,
  });
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  const resumed = await controller.start();

  assert.equal(resumed.phase, "ready");
  assert.deepEqual(
    resumed.view.inventory.map((entry) => ({
      sku: entry.sku,
      item: entry.item,
      style: entry.style,
      size: entry.size,
      quantityReceived: entry.quantityReceived,
    })),
    [
      {
        sku: "CLIENT-JACKET-M",
        item: "Client jacket",
        style: "brown",
        size: "M",
        quantityReceived: 8,
      },
    ],
  );
  assert.equal(
    resumed.view.inventory.some((entry) => entry.sku === "BLACK-TEE-L"),
    false,
  );
});

test("resume fails closed instead of falling back to the active baseline", async () => {
  const memory = createMemoryClient(createUnpinnedState());
  const controller = createController(memory.client);

  const failed = await controller.start();

  assert.equal(failed.phase, "error");
  assert.equal(failed.error.scope, "load");
  assert.equal(failed.error.code, "MISSING_STREAM_BASELINE_PIN");
  assert.equal(failed.view, null);
  assert.deepEqual(memory.calls, [{ method: "getState" }]);
});

test("refresh selects the newest newly captured variation for immediate tagging", async () => {
  const state = createState();

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [201, 202, 203],
  });
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(202);

  const capturedState = memory.getState();
  reconciliation.observeVariations(capturedState, {
    streamId: STREAM_ID,
    variationNumbers: [204, 205],
  });
  memory.setState(capturedState);

  const refreshed = await controller.refresh();

  assert.equal(refreshed.phase, "ready");
  assert.equal(refreshed.operation, "refresh");
  assert.equal(refreshed.view.selectedVariationNumber, 205);
  assert.deepEqual(
    refreshed.view.variations.map((variation) => variation.variationNumber),
    [205, 204, 203, 202, 201, 200],
  );
  assert.equal(
    refreshed.view.variations.find(
      (variation) => variation.variationNumber === 205,
    ).selected,
    true,
  );
  assert.deepEqual(
    memory.calls.map((call) => call.method),
    ["getState", "getState"],
  );
});

test("refresh retains selection when canonical state has no newly captured variation", async () => {
  const state = createState();

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [202, 203],
  });
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(202);

  const paymentState = memory.getState();
  reconciliation.recordPaymentComplete(paymentState, {
    streamId: STREAM_ID,
    variationNumber: 203,
    soldPriceCents: 2500,
  });
  memory.setState(paymentState);

  const refreshed = await controller.refresh();

  assert.equal(refreshed.view.selectedVariationNumber, 202);
  assert.equal(
    refreshed.view.variations.find(
      (variation) => variation.variationNumber === 203,
    ).status,
    "unmapped_completed",
  );
});

test("older backfill and later payment updates do not steal the live selection", async () => {
  const state = createState();

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [45],
  });
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  const initial = await controller.start();
  assert.equal(initial.view.selectedVariationNumber, 45);

  const backfilledState = memory.getState();
  reconciliation.observeVariations(backfilledState, {
    streamId: STREAM_ID,
    variationNumbers: [43],
  });
  memory.setState(backfilledState);

  const backfilled = await controller.refresh();
  assert.equal(backfilled.view.selectedVariationNumber, 45);
  assert.ok(
    backfilled.view.variations.some(
      (variation) => variation.variationNumber === 43,
    ),
  );

  const processingState = memory.getState();
  reconciliation.observePaymentStatuses(processingState, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 43,
        observedPaymentStatus: "payment_processing",
      },
    ],
  });
  memory.setState(processingState);

  const processingUpdated = await controller.refresh();
  const processingOption = processingUpdated.view.variations.find(
    (variation) => variation.variationNumber === 43,
  );

  assert.equal(processingUpdated.view.selectedVariationNumber, 45);
  assert.equal(processingOption.observedPaymentStatus, "payment_processing");
  assert.equal(processingOption.observedPaymentStatusLabel, "Payment processing");

  const completedState = memory.getState();
  reconciliation.recordPaymentComplete(completedState, {
    streamId: STREAM_ID,
    variationNumber: 43,
    soldPriceCents: 1800,
  });
  memory.setState(completedState);

  const paymentUpdated = await controller.refresh();
  const completedOption = paymentUpdated.view.variations.find(
    (variation) => variation.variationNumber === 43,
  );

  assert.equal(paymentUpdated.view.selectedVariationNumber, 45);
  assert.equal(completedOption.status, "unmapped_completed");
  assert.equal(completedOption.observedPaymentStatus, "payment_complete");
  assert.equal(completedOption.observedPaymentStatusLabel, "Payment complete");
  assert.equal(completedOption.soldPriceCents, 1800);
});

test("selects the newest recorded variation when only a prototype placeholder was selected", async () => {
  const state = createState();
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  const initial = await controller.start();

  assert.equal(initial.view.selectedVariationNumber, 203);
  assert.equal(
    initial.view.variations.find((variation) => variation.selected).recorded,
    false,
  );

  const capturedState = memory.getState();
  reconciliation.observeVariations(capturedState, {
    streamId: STREAM_ID,
    variationNumbers: [37, 38],
  });
  memory.setState(capturedState);

  const refreshed = await controller.refresh();

  assert.equal(refreshed.view.selectedVariationNumber, 38);
  assert.equal(
    refreshed.view.variations.find((variation) => variation.selected).recorded,
    true,
  );
});

test("initial restore selects the newest recorded variation even when the prototype number is recorded", async () => {
  const state = createState();

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [203, 204, 205],
  });
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  const restored = await controller.start();

  assert.equal(restored.view.selectedVariationNumber, 205);
  assert.equal(
    restored.view.variations.find((variation) => variation.selected)
      .variationNumber,
    205,
  );
});

test("serializes and coalesces refresh notifications behind a mutation", async () => {
  const initialState = createState();
  const memory = createMemoryClient(initialState);
  const deferred = createDeferred();
  memory.client.mapVariation = (options) => {
    memory.calls.push({ method: "mapVariation", options: clone(options) });
    return deferred.promise;
  };
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(202);
  const save = controller.mapSelectedSku("BLACK-TEE-L");
  const firstRefresh = controller.refresh();
  const secondRefresh = controller.refresh();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    memory.calls.filter((call) => call.method === "getState").length,
    1,
  );
  assert.equal(controller.getSnapshot().phase, "saving");

  const savedState = reconciliation.hydrateReconciliationState(initialState);
  const result = reconciliation.mapVariation(savedState, {
    streamId: STREAM_ID,
    variationNumber: 202,
    sku: "BLACK-TEE-L",
  });
  reconciliation.observeVariations(savedState, {
    streamId: STREAM_ID,
    variationNumbers: [204],
  });
  memory.setState(savedState);
  deferred.resolve({ state: clone(savedState), result });

  const [saved, refreshed, duplicateRefresh] = await Promise.all([
    save,
    firstRefresh,
    secondRefresh,
  ]);

  assert.equal(saved.operation, "map_variation");
  assert.equal(refreshed.operation, "refresh");
  assert.deepEqual(duplicateRefresh, refreshed);
  assert.equal(refreshed.view.selectedVariationNumber, 204);
  assert.equal(refreshed.view.auction.variationNumber, 204);
  assert.equal(refreshed.view.auction.status, "unmapped");
  assert.equal(refreshed.view.auction.sku, null);
  assert.ok(
    refreshed.view.variations.some(
      (variation) => variation.variationNumber === 204,
    ),
  );
  assert.equal(
    memory.calls.filter((call) => call.method === "getState").length,
    2,
  );
});

test("retains the last good view after refresh failure and retries canonical GET", async () => {
  const state = createState();

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [202, 203],
  });
  const memory = createMemoryClient(state);
  const canonicalGet = memory.client.getState;
  let refreshAttempts = 0;
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(202);
  const lastGoodView = controller.getSnapshot().view;
  memory.client.getState = async () => {
    refreshAttempts += 1;

    if (refreshAttempts === 1) {
      const failure = new Error("Could not read the newest state.");
      failure.code = "STORAGE_READ_FAILED";
      throw failure;
    }

    return canonicalGet();
  };

  const failed = await controller.refresh();

  assert.equal(failed.phase, "error");
  assert.equal(failed.operation, "refresh");
  assert.deepEqual(failed.error, {
    scope: "refresh",
    code: "STORAGE_READ_FAILED",
    message: "Could not read the newest state.",
  });
  assert.deepEqual(failed.view, lastGoodView);

  const retried = await controller.retry();

  assert.equal(retried.phase, "ready");
  assert.equal(retried.operation, "refresh");
  assert.equal(retried.error, null);
  assert.equal(retried.view.selectedVariationNumber, 202);
  assert.equal(refreshAttempts, 2);
});

test("rejects malformed refresh data without publishing it over the last good view", async () => {
  const memory = createMemoryClient(createState());
  const controller = createController(memory.client);
  const snapshots = [];

  controller.subscribe((snapshot) => snapshots.push(snapshot));
  await controller.start();
  const lastGoodView = controller.getSnapshot().view;
  memory.client.getState = async () => ({ state: null, result: null });

  const failed = await controller.refresh();

  assert.equal(failed.phase, "error");
  assert.equal(failed.error.scope, "refresh");
  assert.equal(failed.error.code, "MISSING_CANONICAL_STATE");
  assert.deepEqual(failed.view, lastGoodView);
  assert.deepEqual(
    snapshots.slice(-2).map((snapshot) => ({
      phase: snapshot.phase,
      operation: snapshot.operation,
      view: snapshot.view,
    })),
    [
      { phase: "loading", operation: "refresh", view: lastGoodView },
      { phase: "error", operation: "refresh", view: lastGoodView },
    ],
  );
});

test("capture refresh cannot mask a failed save or replace its retry command", async () => {
  const memory = createMemoryClient(createState());
  const successfulMap = memory.client.mapVariation;
  const firstAttempt = createDeferred();
  let attempts = 0;
  memory.client.mapVariation = (options) => {
    attempts += 1;

    if (attempts === 1) {
      memory.calls.push({ method: "mapVariation", options: clone(options) });
      return firstAttempt.promise;
    }

    return successfulMap(options);
  };
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(201);
  const save = controller.mapSelectedSku("GREY-HOODIE-XL");
  const queuedRefresh = controller.refresh();
  const readCount = memory.calls.filter(
    (call) => call.method === "getState",
  ).length;
  const failure = new Error("Mapping was not saved.");
  failure.code = "STORAGE_WRITE_FAILED";
  firstAttempt.reject(failure);

  const [failed, ignoredRefresh] = await Promise.all([save, queuedRefresh]);

  assert.deepEqual(ignoredRefresh, failed);
  assert.equal(failed.phase, "error");
  assert.equal(failed.operation, "map_variation");
  assert.equal(failed.error.scope, "save");
  assert.equal(
    memory.calls.filter((call) => call.method === "getState").length,
    readCount,
  );

  const saved = await controller.retry();

  assert.equal(saved.phase, "ready");
  assert.equal(saved.operation, "map_variation");
  assert.equal(saved.view.selectedVariationNumber, 201);
  assert.equal(saved.view.auction.sku, "GREY-HOODIE-XL");
  assert.equal(attempts, 2);
});

test("a queued capture refresh cannot replace a failed initial-load retry", async () => {
  const memory = createMemoryClient(createState());
  const canonicalGet = memory.client.getState;
  const firstRead = createDeferred();
  let reads = 0;

  memory.client.getState = () => {
    reads += 1;

    if (reads === 1) {
      memory.calls.push({ method: "getState" });
      return firstRead.promise;
    }

    return canonicalGet();
  };
  const controller = createController(memory.client);
  const load = controller.start();
  const queuedRefresh = controller.refresh();
  const failure = new Error("Saved state could not be read.");
  failure.code = "STORAGE_READ_FAILED";

  firstRead.reject(failure);
  const [failed, ignoredRefresh] = await Promise.all([load, queuedRefresh]);

  assert.deepEqual(ignoredRefresh, failed);
  assert.equal(failed.phase, "error");
  assert.equal(failed.operation, "load");
  assert.equal(failed.error.scope, "load");
  assert.equal(reads, 1);

  const restored = await controller.retry();

  assert.equal(restored.phase, "ready");
  assert.equal(restored.operation, "load");
  assert.equal(reads, 2);
});

test("starts idle, publishes detached snapshots, and unsubscribes idempotently", async () => {
  const { client } = createMemoryClient(createState());
  const controller = createController(client);
  const snapshots = [];
  controller.subscribe(() => {
    throw new Error("listener failure must stay isolated");
  });
  const unsubscribe = controller.subscribe((snapshot) => {
    snapshots.push(snapshot);
    snapshot.mode = "changed by listener";
  });

  assert.deepEqual(controller.getSnapshot(), {
    mode: "saved_session",
    phase: "idle",
    operation: null,
    busy: false,
    error: null,
    view: null,
  });

  await controller.start();
  unsubscribe();
  unsubscribe();
  controller.selectVariation(202);

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.phase),
    ["idle", "loading", "ready"],
  );
  assert.equal(controller.getSnapshot().mode, "saved_session");
  assert.equal(snapshots.length, 3);
});

test("fails closed when mounted before inventory initialization and stream pinning", async () => {
  const memory = createMemoryClient(null);
  const controller = createController(memory.client);
  const phases = [];

  controller.subscribe((snapshot) => {
    phases.push(`${snapshot.phase}:${snapshot.operation}`);
  });

  const snapshot = await controller.start();

  assert.deepEqual(memory.calls, [{ method: "getState" }]);
  assert.deepEqual(phases, [
    "idle:null",
    "loading:load",
    "error:load",
  ]);
  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.error.code, "MISSING_CANONICAL_STATE");
  assert.equal(snapshot.view, null);
});

test("restores stored history without trying to initialize again", async () => {
  const state = createState();

  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 202,
    sku: "GREY-HOODIE-XL",
  });
  reconciliation.markUnpaid(state, {
    streamId: STREAM_ID,
    variationNumber: 202,
  });

  const memory = createMemoryClient(state);
  const controller = createController(memory.client);
  const snapshot = await controller.start();
  const restoredVariation = snapshot.view.variations.find(
    (variation) => variation.variationNumber === 202,
  );

  assert.deepEqual(memory.calls, [{ method: "getState" }]);
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.view.selectedVariationNumber, 202);
  assert.equal(restoredVariation.status, "marked_unpaid");
  assert.equal(restoredVariation.item, "Nike hoodie");
});

test("never initializes after a failed or malformed read and retries from GET", async () => {
  let reads = 0;
  const memory = createMemoryClient(null);
  memory.client.getState = async () => {
    memory.calls.push({ method: "getState" });
    reads += 1;

    if (reads === 1) {
      return { result: null };
    }

    return { state: null, result: null };
  };
  const controller = createController(memory.client);
  const failed = await controller.start();

  assert.equal(failed.phase, "error");
  assert.equal(failed.error.scope, "load");
  assert.equal(failed.error.code, "INVALID_CLIENT_RESPONSE");
  assert.equal(failed.view, null);
  assert.equal(
    memory.calls.filter((call) => call.method === "initializeState").length,
    0,
  );

  const retried = await controller.retry();

  assert.equal(retried.phase, "error");
  assert.equal(retried.error.code, "MISSING_CANONICAL_STATE");
  assert.deepEqual(
    memory.calls.map((call) => call.method),
    ["getState", "getState"],
  );
});

test("keeps the canonical projection unchanged until a mapping save succeeds", async () => {
  const initialState = createState();
  const memory = createMemoryClient(initialState);
  const deferred = createDeferred();
  memory.client.mapVariation = (options) => {
    memory.calls.push({ method: "mapVariation", options: clone(options) });
    return deferred.promise;
  };
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(202);
  const save = controller.mapSelectedSku("BLACK-TEE-L");
  await Promise.resolve();
  await Promise.resolve();

  const saving = controller.getSnapshot();

  assert.equal(saving.phase, "saving");
  assert.equal(saving.busy, true);
  assert.equal(saving.view.selectedVariationNumber, 202);
  assert.equal(auctionFromSnapshot(saving), null);
  assert.deepEqual(memory.getState(), initialState);

  const candidate = reconciliation.hydrateReconciliationState(initialState);
  const result = reconciliation.mapVariation(candidate, {
    streamId: STREAM_ID,
    variationNumber: 202,
    sku: "BLACK-TEE-L",
  });

  deferred.resolve({ state: candidate, result });
  const saved = await save;

  assert.equal(saved.phase, "ready");
  assert.equal(saved.operation, "map_variation");
  assert.equal(saved.view.selectedVariationNumber, 202);
  assert.equal(auctionFromSnapshot(saved).sku, "BLACK-TEE-L");
  assert.deepEqual(memory.calls.at(-1), {
    method: "mapVariation",
    options: {
      streamId: STREAM_ID,
      variationNumber: 202,
      sku: "BLACK-TEE-L",
    },
  });
});

test("keeps a historical mapping visible until its unmap save succeeds", async () => {
  const initialState = createState();

  reconciliation.mapVariation(initialState, {
    streamId: STREAM_ID,
    variationNumber: 202,
    sku: "BLACK-TEE-L",
  });
  const memory = createMemoryClient(initialState);
  const deferred = createDeferred();
  memory.client.unmapVariation = (options) => {
    memory.calls.push({ method: "unmapVariation", options: clone(options) });
    return deferred.promise;
  };
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(202);
  const save = controller.unmapSelectedVariation();
  await Promise.resolve();
  await Promise.resolve();

  const saving = controller.getSnapshot();

  assert.equal(saving.phase, "saving");
  assert.equal(saving.operation, "unmap_variation");
  assert.equal(saving.view.selectedVariationNumber, 202);
  assert.equal(auctionFromSnapshot(saving).sku, "BLACK-TEE-L");
  assert.deepEqual(memory.getState(), initialState);

  const candidate = reconciliation.hydrateReconciliationState(initialState);
  const result = reconciliation.unmapVariation(candidate, {
    streamId: STREAM_ID,
    variationNumber: 202,
  });

  deferred.resolve({ state: candidate, result });
  const saved = await save;

  assert.equal(saved.phase, "ready");
  assert.equal(saved.operation, "unmap_variation");
  assert.equal(saved.view.selectedVariationNumber, 202);
  assert.equal(saved.view.mapping, null);
  assert.equal(auctionFromSnapshot(saved).sku, null);
  assert.equal(auctionFromSnapshot(saved).status, "unmapped");
  assert.deepEqual(memory.calls.at(-1), {
    method: "unmapVariation",
    options: {
      streamId: STREAM_ID,
      variationNumber: 202,
    },
  });
});

test("retains the last saved view after failure and retries the frozen command", async () => {
  const memory = createMemoryClient(createState());
  const successfulMap = memory.client.mapVariation;
  let attempts = 0;

  memory.client.mapVariation = async (options) => {
    attempts += 1;

    if (attempts === 1) {
      memory.calls.push({ method: "mapVariation", options: clone(options) });
      const failure = new Error("Could not save mapping.");
      failure.code = "STORAGE_WRITE_FAILED";
      throw failure;
    }

    return successfulMap(options);
  };

  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(201);
  const failed = await controller.mapSelectedSku("GREY-HOODIE-XL");

  assert.equal(failed.phase, "error");
  assert.equal(failed.operation, "map_variation");
  assert.deepEqual(failed.error, {
    scope: "save",
    code: "STORAGE_WRITE_FAILED",
    message: "Could not save mapping.",
  });
  assert.equal(failed.view.selectedVariationNumber, 201);
  assert.equal(failed.view.auction, null);

  const saved = await controller.retry();
  const mappingCalls = memory.calls.filter(
    (call) => call.method === "mapVariation",
  );

  assert.equal(saved.phase, "ready");
  assert.equal(saved.view.selectedVariationNumber, 201);
  assert.equal(saved.view.auction.sku, "GREY-HOODIE-XL");
  assert.equal(mappingCalls.length, 2);
  assert.deepEqual(mappingCalls[0].options, mappingCalls[1].options);
});

test("retains a mapped historical view after unmap failure and retries the frozen command", async () => {
  const state = createState();

  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 201,
    sku: "GREY-HOODIE-XL",
  });
  const memory = createMemoryClient(state);
  const successfulUnmap = memory.client.unmapVariation;
  let attempts = 0;

  memory.client.unmapVariation = async (options) => {
    attempts += 1;

    if (attempts === 1) {
      memory.calls.push({ method: "unmapVariation", options: clone(options) });
      const failure = new Error("Could not remove mapping.");
      failure.code = "STORAGE_WRITE_FAILED";
      throw failure;
    }

    return successfulUnmap(options);
  };

  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(201);
  const failed = await controller.unmapSelectedVariation();

  assert.equal(failed.phase, "error");
  assert.equal(failed.operation, "unmap_variation");
  assert.deepEqual(failed.error, {
    scope: "save",
    code: "STORAGE_WRITE_FAILED",
    message: "Could not remove mapping.",
  });
  assert.equal(failed.view.selectedVariationNumber, 201);
  assert.equal(failed.view.auction.sku, "GREY-HOODIE-XL");

  const saved = await controller.retry();
  const unmapCalls = memory.calls.filter(
    (call) => call.method === "unmapVariation",
  );

  assert.equal(saved.phase, "ready");
  assert.equal(saved.view.selectedVariationNumber, 201);
  assert.equal(saved.view.mapping, null);
  assert.equal(saved.view.auction.status, "unmapped");
  assert.equal(unmapCalls.length, 2);
  assert.deepEqual(unmapCalls[0].options, unmapCalls[1].options);
});

test("persists mark-unpaid and undo commands for the selected variation", async () => {
  const state = createState();

  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 200,
    sku: "BLACK-TEE-L",
  });
  const memory = createMemoryClient(state);
  const controller = createController(memory.client);

  await controller.start();
  controller.selectVariation(200);

  const unpaid = await controller.markSelectedUnpaid();
  const restored = await controller.undoSelectedUnpaid();

  assert.equal(unpaid.view.auction.status, "marked_unpaid");
  assert.equal(restored.view.auction.status, "mapped");
  assert.deepEqual(memory.calls.slice(-2), [
    {
      method: "markUnpaid",
      options: { streamId: STREAM_ID, variationNumber: 200 },
    },
    {
      method: "undoMarkUnpaid",
      options: { streamId: STREAM_ID, variationNumber: 200 },
    },
  ]);
});

test("a reopened controller restores the last durable mapping and unpaid state", async () => {
  const memory = createMemoryClient(createState());
  const firstController = createController(memory.client);

  await firstController.start();
  await firstController.mapSelectedSku("BLACK-TEE-L");
  await firstController.markSelectedUnpaid();

  const reopenedController = createController(memory.client);
  const restored = await reopenedController.start();

  assert.equal(restored.phase, "ready");
  assert.equal(restored.view.selectedVariationNumber, CURRENT_VARIATION);
  assert.equal(restored.view.auction.sku, "BLACK-TEE-L");
  assert.equal(restored.view.auction.status, "marked_unpaid");
  assert.equal(restored.view.auction.paymentStatus, "unknown");
  assert.equal(
    memory.calls.filter((call) => call.method === "initializeState").length,
    0,
  );
  assert.equal(
    memory.calls.filter((call) => call.method === "getState").length,
    2,
  );
});

test("requires the saved-session client to provide unmapping", () => {
  const { client } = createMemoryClient();

  delete client.unmapVariation;

  assert.throws(
    () => createController(client),
    /mapping, unmapping, and unpaid methods/,
  );
});

test("a reopened controller restores a durable unmap", async () => {
  const memory = createMemoryClient(createState());
  const firstController = createController(memory.client);

  await firstController.start();
  await firstController.mapSelectedSku("BLACK-TEE-L");
  await firstController.unmapSelectedVariation();

  const reopenedController = createController(memory.client);
  const restored = await reopenedController.start();

  assert.equal(restored.phase, "ready");
  assert.equal(restored.view.selectedVariationNumber, CURRENT_VARIATION);
  assert.equal(restored.view.mapping, null);
  assert.equal(restored.view.auction.sku, null);
  assert.equal(restored.view.auction.status, "unmapped");
  assert.equal(restored.view.auction.paymentStatus, "unknown");
  assert.equal(
    memory.calls.filter((call) => call.method === "initializeState").length,
    0,
  );
  assert.equal(
    memory.calls.filter((call) => call.method === "unmapVariation").length,
    1,
  );
  assert.equal(
    memory.calls.filter((call) => call.method === "getState").length,
    2,
  );
});

test("coalesces duplicate starts and rejects mutations while busy", async () => {
  const memory = createMemoryClient(createState());
  const deferred = createDeferred();
  memory.client.getState = () => {
    memory.calls.push({ method: "getState" });
    return deferred.promise;
  };
  const controller = createController(memory.client);
  const firstStart = controller.start();
  const secondStart = controller.start();

  assert.throws(
    () => controller.mapSelectedSku("BLACK-TEE-L"),
    (error) => {
      assert.equal(error.code, "CONTROLLER_BUSY");
      return true;
    },
  );

  deferred.resolve({ state: createState(), result: null });
  await Promise.all([firstStart, secondStart]);

  assert.deepEqual(
    memory.calls.map((call) => call.method),
    ["getState"],
  );
  assert.equal(controller.getSnapshot().phase, "ready");
});
