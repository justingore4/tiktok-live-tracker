"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const inventoryImportProtocol = require(
  "../extension/shared/inventory-import-protocol.js",
);
const inventorySheetImport = require("../extension/shared/inventory-sheet-import.js");
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
  ["sku", "item", "style", "size", "quantity", "unit_cost"],
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

function withExtraColumns(rows, revision = 1) {
  return rows.map((row, index) => {
    const result = [...row];
    while (result.length < 6) result.push("");
    result[6] = `ignored-summary-${revision}-${index}`;
    result[7] = { formulaValue: `=SUM(E:E)*${revision}` };
    result[25] = index === 0 ? "sku" : `ignored-far-note-${revision}`;
    return result;
  });
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
                userEnteredValue: typeof value === "object" ? value : typeof value === "number"
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
    async remove(key) {
      delete storage[key];
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
      "'Inventory'!A:F",
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

test("real preview and confirmation ignore changing G+ formulas, headers, and summary-only rows", async () => {
  const rows = [[], TEMPLATE_ROWS[0], [], ...TEMPLATE_ROWS.slice(1), []];
  const laterRows = [...rows, ...Array.from({ length: 1002 }, () => [])];
  const worker = createRealWorkerHarness({ payloads: [
    createGridPayload(withExtraColumns(rows)),
    createGridPayload(withExtraColumns(laterRows, 2)),
  ] });
  const clients = createClients(worker.runtime);
  const expected = inventorySheetImport.parseInventorySheet(TEMPLATE_ROWS);
  const preview = await clients.inventory.previewReference(SPREADSHEET_ID);

  assert.equal(preview.range, "'Inventory'!A:F");
  assert.deepEqual(preview.inventory, expected.inventory);
  assert.deepEqual(preview.summary, expected.summary);
  assert.equal(preview.fingerprint, expected.fingerprint);
  const confirmation = await clients.inventory.confirmPreview(preview.previewToken);
  assert.equal(confirmation.sourceFingerprint, expected.fingerprint);
  const state = await clients.reconciliation.getState();
  const baseline = state.state.inventoryBaselines.find(
    (entry) => entry.baselineId === confirmation.baselineId,
  );
  assert.deepEqual(baseline.inventory, expected.inventory);
  assert.equal(JSON.stringify(worker.storage).includes("ignored-"), false);
  assert.equal(JSON.stringify(worker.storage).includes("formulaValue"), false);
  assert.equal(worker.fetchCalls.length, 2);
  assert.deepEqual(worker.workerErrors, []);
});

test("real preview, confirmation, and active SKU addition accept either quantity header without changing saved fields", async () => {
  const preferredRows = clone(TEMPLATE_ROWS);
  const legacyRows = clone(TEMPLATE_ROWS);
  legacyRows[0][4] = "quantity_on_hand_at_import";
  const worker = createRealWorkerHarness({ payloads: [
    createGridPayload(legacyRows),
    createGridPayload(preferredRows),
    createGridPayload(legacyRows),
    createGridPayload([...preferredRows, LIMITED_SKU_ROW]),
  ] });
  const clients = createClients(worker.runtime);
  const preview = await clients.inventory.previewReference(SPREADSHEET_ID);
  const expected = inventorySheetImport.parseInventorySheet(preferredRows);
  assert.equal(preview.fingerprint, expected.fingerprint);
  assert.deepEqual(preview.inventory, expected.inventory);

  const confirmation = await clients.inventory.confirmPreview(preview.previewToken);
  assert.equal(confirmation.sourceFingerprint, expected.fingerprint);
  await clients.stream.startStream();
  const before = clone(worker.storage);
  const unchanged = await clients.inventory.addActiveStreamSkusReference(SPREADSHEET_ID);
  assert.equal(unchanged.status, "already_current");
  assert.deepEqual(worker.storage, before);
  const added = await clients.inventory.addActiveStreamSkusReference(SPREADSHEET_ID);
  assert.equal(added.status, "extended");
  assert.deepEqual(added.addedSkus, [LIMITED_SKU_ROW[0]]);
  const current = await clients.reconciliation.getState();
  const baseline = current.state.inventoryBaselines.find((entry) =>
    entry.baselineId === current.state.activeInventoryBaselineId);
  assert.equal(baseline.inventory.find((entry) => entry.sku === LIMITED_SKU_ROW[0]).quantityOnHandAtImport, 3);
  assert.equal(Object.hasOwn(baseline.inventory[0], "quantity"), false);
  assert.equal(worker.fetchCalls.length, 4);
  assert.deepEqual(worker.workerErrors, []);
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

test("separate pre-stream confirmations allow an SKU rename without changing the historical baseline", async () => {
  const storage = {};
  const headers = TEMPLATE_ROWS[0];
  const originalRows = [
    headers,
    ["TRAVIS", "travis", "tee", "OS", 40, 16],
  ];
  const renamedRows = [
    headers,
    ["TRAVIS-TEE", "travis", "tee", "OS", 40, 16],
  ];
  const worker = createRealWorkerHarness({
    storage,
    payloads: [
      createGridPayload(originalRows),
      createGridPayload(originalRows),
      createGridPayload(renamedRows),
      createGridPayload(renamedRows),
    ],
  });
  const clients = createClients(worker.runtime);
  const firstPreview = await clients.inventory.previewReference(SPREADSHEET_ID);
  const firstConfirmation = await clients.inventory.confirmPreview(
    firstPreview.previewToken,
  );
  const afterFirstConfirmation = await clients.reconciliation.getState();
  const historicalBaseline = clone(
    afterFirstConfirmation.state.inventoryBaselines.find(
      (baseline) => baseline.baselineId === firstConfirmation.baselineId,
    ),
  );

  const renamedPreview = await clients.inventory.previewReference(SPREADSHEET_ID);
  const renamedConfirmation = await clients.inventory.confirmPreview(
    renamedPreview.previewToken,
  );
  const afterRename = await clients.reconciliation.getState();
  const retainedHistoricalBaseline = afterRename.state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === firstConfirmation.baselineId,
  );
  const renamedBaseline = afterRename.state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === renamedConfirmation.baselineId,
  );

  assert.notEqual(renamedConfirmation.baselineId, firstConfirmation.baselineId);
  assert.equal(
    afterRename.state.activeInventoryBaselineId,
    renamedConfirmation.baselineId,
  );
  assert.deepEqual(retainedHistoricalBaseline, historicalBaseline);
  assert.deepEqual(
    historicalBaseline.inventory.map(({ sku, item, style, size }) => ({
      sku,
      item,
      style,
      size,
    })),
    [{ sku: "TRAVIS", item: "travis", style: "tee", size: "OS" }],
  );
  assert.deepEqual(
    renamedBaseline.inventory.map(({ sku, item, style, size }) => ({
      sku,
      item,
      style,
      size,
    })),
    [{ sku: "TRAVIS-TEE", item: "travis", style: "tee", size: "OS" }],
  );

  const restartedWorker = createRealWorkerHarness({ storage });
  const restored = await createClients(restartedWorker.runtime)
    .reconciliation.getState();

  assert.deepEqual(restored.state, afterRename.state);
  assert.equal(restartedWorker.fetchCalls.length, 0);
  assert.deepEqual(worker.workerErrors, []);
  assert.deepEqual(restartedWorker.workerErrors, []);
});

test("an active Sheet append preserves mappings and survives worker restart", async () => {
  const storage = {};
  const expandedRows = [...TEMPLATE_ROWS, LIMITED_SKU_ROW];
  const worker = createRealWorkerHarness({
    storage,
    payloads: [
      createGridPayload(),
      createGridPayload(),
      createGridPayload(withExtraColumns([[], ...expandedRows, [], []])),
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

test("active G+ edits alone are a no-op while changes to every existing A:F field still reject atomically", async () => {
  const mutations = ["RENAMED-SKU", "Changed item", "Changed style", "XXL", 99, 99];
  const changedPayloads = mutations.map((value, column) => {
    const rows = clone([...TEMPLATE_ROWS, LIMITED_SKU_ROW]);
    rows[1][column] = value;
    return createGridPayload(withExtraColumns(rows, column + 3));
  });
  const worker = createRealWorkerHarness({ payloads: [
    createGridPayload(), createGridPayload(),
    createGridPayload(withExtraColumns([[], ...TEMPLATE_ROWS, [], []], 2)),
    ...changedPayloads,
  ] });
  const clients = createClients(worker.runtime);
  const preview = await clients.inventory.previewReference(SPREADSHEET_ID);
  await clients.inventory.confirmPreview(preview.previewToken);
  await clients.stream.startStream();
  const before = clone(worker.storage);
  const unchanged = await clients.inventory.addActiveStreamSkusReference(SPREADSHEET_ID);
  assert.equal(unchanged.status, "already_current");
  assert.deepEqual(unchanged.addedSkus, []);
  assert.deepEqual(worker.storage, before);

  for (const header of TEMPLATE_ROWS[0]) {
    await assert.rejects(clients.inventory.addActiveStreamSkusReference(SPREADSHEET_ID),
      { code: "INVENTORY_BASELINE_NOT_APPEND_ONLY" }, header);
    assert.deepEqual(worker.storage, before, header);
  }
  assert.equal(worker.fetchCalls.length, 9);
  assert.deepEqual(worker.workerErrors, []);
});
