"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const inventoryImportProtocol = require(
  "../extension/shared/inventory-import-protocol.js",
);
const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationProtocol = require(
  "../extension/shared/reconciliation-coordinator.js",
);
const streamSessionProtocol = require(
  "../extension/shared/stream-session-coordinator.js",
);
const inventoryImportClientModule = require(
  "../extension/tagger/inventory-import-client.js",
);
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const persistentControllerModule = require(
  "../extension/tagger/persistent-tagger-controller.js",
);
const reconciliationClientModule = require(
  "../extension/tagger/reconciliation-client.js",
);
const streamSessionClientModule = require(
  "../extension/tagger/stream-session-client.js",
);

const EXTENSION_DIRECTORY = path.join(__dirname, "..", "extension");
const SERVICE_WORKER_PATH = path.join(
  EXTENSION_DIRECTORY,
  "service-worker.js",
);
const RECONCILIATION_STORAGE_KEY = "tiktokLiveTracker.reconciliation";
const STREAM_STORAGE_KEY = "tiktokLiveTracker.streamSession";
const EXTENSION_ID = "real-integration-extension";
const SIDE_PANEL_URL =
  `chrome-extension://${EXTENSION_ID}/tagger/sidepanel.html`;
const SPREADSHEET_ID = "1Abc_def-Ghij234567890";

const TEMPLATE_ROWS = Object.freeze([
  ["sku", "item", "style", "size", "quantity_on_hand_at_import", "unit_cost"],
  ["STUSSY-TEE-BLACK-L", "Stussy tee", "black", "L", 5, 12],
  ["STUSSY-TEE-BLACK-M", "Stussy tee", "black", "M", 2, 12],
  ["NIKE-HOODIE-GREY-XL", "Nike hoodie", "grey", "XL", 3, 14],
  ["NIKE-HOODIE-GREY-L", "Nike hoodie", "grey", "L", 1, 14],
  ["CARHARTT-JACKET-BROWN-M", "Carhartt jacket", "brown", "M", 4, 18],
  ["DENIM-SHORTS-WASHED-BLUE-32", "Denim shorts", "washed blue", "32", 0, 9],
]);
const LIMITED_SKU_ROW = Object.freeze([
  "LIMITED-HOODIE-SILVER-OS",
  "Limited hoodie",
  "silver",
  "OS",
  3,
  20,
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createGridPayload(rows = TEMPLATE_ROWS) {
  return {
    sheets: [
      {
        properties: { title: "Inventory" },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: rows.map((row) => ({
              values: row.map((value) => ({
                userEnteredValue: typeof value === "number"
                  ? { numberValue: value }
                  : { stringValue: value },
              })),
            })),
          },
        ],
      },
    ],
  };
}

function createUuidFactory() {
  let sequence = 0;

  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
}

function createRealWorkerHarness(options = {}) {
  const storage = options.storage ?? {};
  const sessionStorage = options.sessionStorage ?? {};
  const payloads = options.payloads ?? [createGridPayload()];
  const authCalls = [];
  const fetchCalls = [];
  const workerNotifications = [];
  const workerErrors = [];
  const listeners = [];
  const createUuid = createUuidFactory();
  let fetchIndex = 0;
  let context;

  function cloneIntoWorker(value) {
    const json = JSON.stringify(value);
    context.__integrationCloneJson = json;

    try {
      return vm.runInContext(
        "JSON.parse(__integrationCloneJson)",
        context,
      );
    } finally {
      delete context.__integrationCloneJson;
    }
  }

  const storageArea = {
    async get(key) {
      const response = Object.prototype.hasOwnProperty.call(storage, key)
        ? { [key]: clone(storage[key]) }
        : {};
      return cloneIntoWorker(response);
    },
    async set(values) {
      Object.assign(storage, clone(values));
    },
    async setAccessLevel() {},
  };
  const sessionStorageArea = {
    async get(key) {
      const response = Object.prototype.hasOwnProperty.call(
        sessionStorage,
        key,
      )
        ? { [key]: clone(sessionStorage[key]) }
        : {};
      return cloneIntoWorker(response);
    },
    async set(values) {
      Object.assign(sessionStorage, clone(values));
    },
    async remove(key) {
      delete sessionStorage[key];
    },
    async setAccessLevel() {},
  };
  const sandbox = {
    AbortController,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    clearTimeout,
    console: {
      error(...values) {
        workerErrors.push(values.map(String));
      },
    },
    crypto: { randomUUID: createUuid },
    fetch: async (url, request) => {
      fetchCalls.push({
        url,
        method: request.method,
        credentials: request.credentials,
        redirect: request.redirect,
        referrerPolicy: request.referrerPolicy,
        authorization: request.headers.Authorization,
      });
      const payload = payloads[Math.min(fetchIndex, payloads.length - 1)];
      fetchIndex += 1;

      return {
        status: 200,
        headers: { get: () => null },
        async text() {
          return JSON.stringify(payload);
        },
      };
    },
    setTimeout,
  };

  sandbox.chrome = {
    identity: {
      async getAuthToken(details) {
        authCalls.push({ interactive: details.interactive });
        return `worker-only-token-${authCalls.length}`;
      },
      async removeCachedAuthToken() {},
    },
    runtime: {
      id: EXTENSION_ID,
      getManifest() {
        return {
          oauth2: {
            client_id: "123456789-real-integration.apps.googleusercontent.com",
          },
        };
      },
      getURL(relativePath) {
        return `chrome-extension://${EXTENSION_ID}/${relativePath}`;
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
        removeListener() {},
      },
      async sendMessage(message) {
        workerNotifications.push(clone(message));
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
    },
    storage: { local: storageArea, session: sessionStorageArea },
  };
  sandbox.importScripts = (...relativePaths) => {
    relativePaths.forEach((relativePath) => {
      const source = fs.readFileSync(
        path.join(EXTENSION_DIRECTORY, relativePath),
        "utf8",
      );
      vm.runInContext(source, context, { filename: relativePath });
    });
  };

  context = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(SERVICE_WORKER_PATH, "utf8"),
    context,
    { filename: "service-worker.js" },
  );
  assert.equal(listeners.length, 1);

  const runtime = {
    sendMessage(message) {
      const workerMessage = cloneIntoWorker(message);
      const workerSender = cloneIntoWorker({
        id: EXTENSION_ID,
        url: SIDE_PANEL_URL,
      });

      return new Promise((resolve, reject) => {
        let asynchronous;

        try {
          asynchronous = listeners[0](
            workerMessage,
            workerSender,
            (response) => resolve(clone(response)),
          );
        } catch (error) {
          reject(error);
          return;
        }

        if (asynchronous !== true) {
          resolve(undefined);
        }
      });
    },
  };

  return {
    authCalls,
    fetchCalls,
    runtime,
    storage,
    workerErrors,
    workerNotifications,
  };
}

function createClients(runtime) {
  return {
    inventory: inventoryImportClientModule.createInventoryImportClient({
      runtime,
      protocol: inventoryImportProtocol,
    }),
    reconciliation: reconciliationClientModule.createReconciliationClient({
      runtime,
      protocol: reconciliationProtocol,
    }),
    stream: streamSessionClientModule.createStreamSessionClient({
      runtime,
      protocol: streamSessionProtocol,
    }),
  };
}

test("real Sheet confirmation persists, wins the worker FIFO, pins Start, and drives the live inventory", async () => {
  const storage = {};
  const firstWorker = createRealWorkerHarness({
    storage,
    payloads: [createGridPayload(), createGridPayload()],
  });
  const firstClients = createClients(firstWorker.runtime);
  const preview = await firstClients.inventory.previewReference(
    `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
  );

  assert.equal(preview.inventory.length, 6);
  assert.equal(RECONCILIATION_STORAGE_KEY in storage, false);

  const confirmationPromise = firstClients.inventory.confirmPreview(
    preview.previewToken,
  );
  const startPromise = firstClients.stream.startStream();
  const [confirmation, started] = await Promise.all([
    confirmationPromise,
    startPromise,
  ]);
  const streamId = started.state.activeSession.streamId;

  assert.match(confirmation.baselineId, /^inventory-baseline:/);
  assert.equal(storage[RECONCILIATION_STORAGE_KEY]
    .reconciliationState.activeInventoryBaselineId, confirmation.baselineId);
  assert.equal(storage[STREAM_STORAGE_KEY].sessionState
    .activeSession.streamId, streamId);
  assert.equal(storage[RECONCILIATION_STORAGE_KEY]
    .reconciliationState.streams[0].inventoryBaselineId, confirmation.baselineId);
  assert.deepEqual(firstWorker.authCalls, [
    { interactive: true },
    { interactive: false },
  ]);
  assert.equal(firstWorker.fetchCalls.length, 2);
  firstWorker.fetchCalls.forEach((request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.referrerPolicy, "no-referrer");
    assert.match(request.authorization, /^Bearer worker-only-token-/);
    assert.equal(
      new URL(request.url).searchParams.get("ranges"),
      "'Inventory'",
    );
  });
  assert.equal(JSON.stringify(storage).includes("worker-only-token"), false);
  assert.equal(JSON.stringify(storage).includes(SPREADSHEET_ID), false);

  const restartedWorker = createRealWorkerHarness({ storage });
  const restartedClients = createClients(restartedWorker.runtime);
  const restoredSession = await restartedClients.stream.getSession();

  assert.equal(restoredSession.state.activeSession.streamId, streamId);
  assert.equal(restartedWorker.fetchCalls.length, 0);

  const controller = persistentControllerModule.createPersistentTaggerController({
    client: restartedClients.reconciliation,
    mappingWorkflow,
    reconciliation,
    streamId,
    currentVariationNumber: 1,
    variationNumbers: [1],
  });
  const live = await controller.start();

  assert.equal(live.phase, "ready");
  assert.deepEqual(
    live.view.inventory.map((entry) => ({
      sku: entry.sku,
      quantityReceived: entry.quantityReceived,
    })),
    [
      { sku: "STUSSY-TEE-BLACK-L", quantityReceived: 5 },
      { sku: "STUSSY-TEE-BLACK-M", quantityReceived: 2 },
      { sku: "NIKE-HOODIE-GREY-XL", quantityReceived: 3 },
      { sku: "NIKE-HOODIE-GREY-L", quantityReceived: 1 },
      { sku: "CARHARTT-JACKET-BROWN-M", quantityReceived: 4 },
      { sku: "DENIM-SHORTS-WASHED-BLUE-32", quantityReceived: 0 },
    ],
  );
  assert.deepEqual(firstWorker.workerErrors, []);
  assert.deepEqual(restartedWorker.workerErrors, []);
});

test("a worker restart discards its in-memory preview authorization", async () => {
  const storage = {};
  const firstWorker = createRealWorkerHarness({ storage });
  const preview = await createClients(firstWorker.runtime)
    .inventory.previewReference(SPREADSHEET_ID);
  const restartedWorker = createRealWorkerHarness({ storage });
  const restartedClient = createClients(restartedWorker.runtime).inventory;

  await assert.rejects(
    restartedClient.confirmPreview(preview.previewToken),
    (error) => error.code === "PREVIEW_NOT_FOUND",
  );
  assert.equal(RECONCILIATION_STORAGE_KEY in storage, false);
  assert.equal(restartedWorker.authCalls.length, 0);
  assert.equal(restartedWorker.fetchCalls.length, 0);
});

test("an active Sheet append preserves mappings and survives worker restart", async () => {
  const storage = {};
  const expandedRows = [...TEMPLATE_ROWS, LIMITED_SKU_ROW];
  const worker = createRealWorkerHarness({
    storage,
    payloads: [
      createGridPayload(),
      createGridPayload(),
      createGridPayload(expandedRows),
    ],
  });
  const clients = createClients(worker.runtime);
  const preview = await clients.inventory.previewReference(SPREADSHEET_ID);

  await clients.inventory.confirmPreview(preview.previewToken);
  const started = await clients.stream.startStream();
  const streamId = started.state.activeSession.streamId;

  await clients.reconciliation.mapVariation({
    streamId,
    variationNumber: 77,
    sku: "STUSSY-TEE-BLACK-L",
  });
  const before = await clients.reconciliation.getState();
  const beforeStream = before.state.streams.find(
    (stream) => stream.streamId === streamId,
  );
  const previousBaselineId = beforeStream.inventoryBaselineId;
  const variationSnapshot = clone(beforeStream.variations);

  const result = await clients.inventory.addActiveStreamSkusReference(
    `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
  );
  const after = await clients.reconciliation.getState();
  const afterStream = after.state.streams.find(
    (stream) => stream.streamId === streamId,
  );
  const activeBaseline = after.state.inventoryBaselines.find(
    (baseline) =>
      baseline.baselineId === after.state.activeInventoryBaselineId,
  );

  assert.equal(result.status, "extended");
  assert.deepEqual(result.addedSkus, [LIMITED_SKU_ROW[0]]);
  assert.notEqual(afterStream.inventoryBaselineId, previousBaselineId);
  assert.equal(
    afterStream.inventoryBaselineId,
    after.state.activeInventoryBaselineId,
  );
  assert.deepEqual(afterStream.variations, variationSnapshot);
  assert.equal(
    activeBaseline.inventory.find((item) => item.sku === LIMITED_SKU_ROW[0])
      .quantityOnHandAtImport,
    3,
  );
  assert.deepEqual(worker.authCalls, [
    { interactive: true },
    { interactive: false },
    { interactive: true },
  ]);
  assert.equal(worker.fetchCalls.length, 3);

  const restartedWorker = createRealWorkerHarness({ storage });
  const restartedClients = createClients(restartedWorker.runtime);
  const restored = await restartedClients.reconciliation.getState();
  const restoredStream = restored.state.streams.find(
    (stream) => stream.streamId === streamId,
  );
  const restoredBaseline = restored.state.inventoryBaselines.find(
    (baseline) =>
      baseline.baselineId === restored.state.activeInventoryBaselineId,
  );

  assert.deepEqual(restoredStream.variations, variationSnapshot);
  assert.ok(
    restoredBaseline.inventory.some(
      (item) => item.sku === LIMITED_SKU_ROW[0],
    ),
  );
  assert.equal(restartedWorker.fetchCalls.length, 0);
  assert.equal(JSON.stringify(storage).includes(SPREADSHEET_ID), false);
  assert.deepEqual(worker.workerErrors, []);
  assert.deepEqual(restartedWorker.workerErrors, []);
});
