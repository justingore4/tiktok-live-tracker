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
    name: "Stussy tee - black",
    size: "L",
    quantityReceived: 5,
    unitCostCents: 1200,
  },
  {
    sku: "GREY-HOODIE-XL",
    name: "Nike hoodie - grey",
    size: "XL",
    quantityReceived: 3,
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

function createState() {
  return reconciliation.createReconciliationState(CANONICAL_INVENTORY);
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
    "retry",
    "selectVariation",
    "start",
    "subscribe",
    "undoSelectedUnpaid",
  ]);
  assert.doesNotMatch(
    source,
    /chrome\.|recordPaymentComplete|record_payment_complete|completePayment/,
  );
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

test("initializes prototype inventory only after an explicit null state", async () => {
  const memory = createMemoryClient(null);
  const controller = createController(memory.client);
  const phases = [];

  controller.subscribe((snapshot) => {
    phases.push(`${snapshot.phase}:${snapshot.operation}`);
  });

  const snapshot = await controller.start();

  assert.deepEqual(memory.calls, [
    { method: "getState" },
    { method: "initializeState", inventory: CANONICAL_INVENTORY },
  ]);
  assert.deepEqual(phases, [
    "idle:null",
    "loading:load",
    "loading:initialize",
    "ready:initialize",
  ]);
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.view.currentVariationNumber, CURRENT_VARIATION);
  assert.equal(snapshot.view.selectedVariationNumber, CURRENT_VARIATION);
  assert.equal(snapshot.view.inventory.length, INVENTORY.length);
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
  assert.equal(snapshot.view.selectedVariationNumber, CURRENT_VARIATION);
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

  const restored = await controller.retry();

  assert.equal(restored.phase, "ready");
  assert.deepEqual(
    memory.calls.map((call) => call.method),
    ["getState", "getState", "initializeState"],
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
  assert.equal(restored.view.auction.status, "pending");
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
  const memory = createMemoryClient(null);
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
