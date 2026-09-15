const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationStorage = require("../extension/shared/reconciliation-storage.js");
const sessionStorage = require("../extension/shared/stream-session-storage.js");
const reportStorage = require("../extension/shared/stream-report-storage.js");
const presetProtocol = require("../extension/shared/variation-presets-protocol.js");
const presetStorage = require("../extension/shared/variation-presets-storage.js");
const presetClientModule = require("../extension/tagger/variation-presets-client.js");
const queueStorage = require("../extension/shared/next-item-queue-storage.js");
const captureHealth = require("../extension/shared/capture-health.js");

const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const BASELINE = "inventory-baseline:11111111-1111-4111-8111-111111111111";
const EXTENSION_ID = "synthetic-extension";
const PANEL = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/tagger/sidepanel.html` };
const DASHBOARD = {
  id: EXTENSION_ID, frameId: 0, tab: { id: 123 },
  documentId: "synthetic-dashboard-document",
  url: "https://shop.tiktok.com/streamer/live/product/dashboard",
};
const CHANNELS = {
  reconciliation: "tiktok-live-tracker.reconciliation",
  session: "tiktok-live-tracker.stream-session",
  capture: "tiktok-live-tracker.capture",
  presets: presetProtocol.MESSAGE_CHANNEL,
  queue: "tiktok-live-tracker.next-item-queue",
  live: "tiktok-live-tracker.live-bid",
  report: "tiktok-live-tracker.stream-report",
  health: captureHealth.CHANNEL,
};
const clone = (value) => JSON.parse(JSON.stringify(value));

function initialState({ pinned = true, inventory = "confirmed" } = {}) {
  const state = reconciliation.createEmptyReconciliationState();
  if (inventory === "missing") return state;
  if (inventory === "unconfirmed") {
    return reconciliation.createReconciliationState([
      { sku: "SYNTH-A", quantityOnHandAtImport: 10, unitCostCents: 500 },
    ]);
  }
  reconciliation.createInventoryBaseline(state, {
    baselineId: BASELINE,
    sourceFingerprint: "fnv1a64:1111111111111111",
    inventory: [
      { sku: "SYNTH-A", item: "Synthetic", style: "Hoodie", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
      { sku: "SYNTH-B", item: "Synthetic", style: "Tee", size: "OS", quantityOnHandAtImport: 10, unitCostCents: 900 },
    ],
  });
  if (pinned) reconciliation.pinStreamToInventoryBaseline(state, { streamId: STREAM });
  return state;
}

// Every module loaded by the actual service worker runs in an isolated VM.
// Both Chrome storage areas, messages, IDs, and dashboard observations below
// are synthetic. This harness never opens a browser or uses the network.
function createHarness({ active = true, pinned = active, inventory = "confirmed" } = {}) {
  const values = {
    [reconciliationStorage.STORAGE_KEY]: { schemaVersion: 1, reconciliationState: initialState({ pinned, inventory }) },
    [sessionStorage.STORAGE_KEY]: {
      schemaVersion: 1,
      sessionState: {
        version: 1,
        activeSession: active ? { streamId: STREAM, startedAt: "2026-09-14T00:00:00.000Z", identitySource: "local_session" } : null,
      },
    },
  };
  const sessionValues = {};
  const writes = [];
  const notifications = [];
  const errors = [];
  const failedWrites = [];
  let failure = null;

  function failNext(predicate) {
    failure = predicate;
  }

  function open() {
    let listener;
    let context;
    function inRealm(value) {
      return vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
    }
    function storageArea(store, area) {
      return {
        async setAccessLevel() {},
        async get(keys) {
          const selected = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          return inRealm(Object.fromEntries(selected.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]])));
        },
        async set(items) {
          const copied = clone(items);
          if (failure?.({ area, operation: "set", items: copied })) {
            failure = null;
            failedWrites.push({ area, operation: "set", items: copied });
            throw new Error("Synthetic storage failure");
          }
          writes.push({ area, items: copied });
          Object.assign(store, copied);
        },
        async remove(keys) {
          const selected = Array.isArray(keys) ? keys : [keys];
          if (failure?.({ area, operation: "remove", keys: selected })) {
            failure = null;
            failedWrites.push({ area, operation: "remove", keys: selected });
            throw new Error("Synthetic storage removal failure");
          }
          for (const key of selected) delete store[key];
          writes.push({ area, removed: selected });
        },
      };
    }
    const event = () => ({ addListener() {} });
    const forbidden = () => { throw new Error("This synthetic test must not request credentials or network access"); };
    context = vm.createContext({
      console: { error: (...args) => errors.push(args.map(String)), log() {}, warn() {} },
      crypto: { randomUUID }, AbortController, TextEncoder, URL, setTimeout, clearTimeout,
      fetch: forbidden,
      chrome: {
        runtime: {
          id: EXTENSION_ID,
          getURL: (name) => `chrome-extension://${EXTENSION_ID}/${name}`,
          getManifest: () => ({ oauth2: { client_id: "synthetic-public-client.apps.googleusercontent.com" } }),
          onMessage: { addListener(callback) { assert.equal(listener, undefined); listener = callback; } },
          async sendMessage(message) { notifications.push(clone(message)); },
        },
        storage: { local: storageArea(values, "local"), session: storageArea(sessionValues, "session") },
        sidePanel: { async setPanelBehavior() {} },
        tabs: { onRemoved: event(), onUpdated: event() },
        identity: { getAuthToken: forbidden, removeCachedAuthToken: forbidden },
      },
      importScripts(...names) {
        for (const name of names) {
          const filename = path.join(__dirname, "..", "extension", name);
          vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
        }
      },
    });
    const workerPath = path.join(__dirname, "..", "extension", "service-worker.js");
    vm.runInContext(fs.readFileSync(workerPath, "utf8"), context, { filename: workerPath });

    async function raw(channel, command, sender = PANEL) {
      const capture = channel === "capture";
      const message = channel === "health"
        ? { channel: captureHealth.CHANNEL, version: captureHealth.VERSION, ...command }
        : { channel: CHANNELS[channel], version: 1, [capture ? "event" : "command"]: command };
      return new Promise((resolve, reject) => {
        const retained = listener(inRealm(message), inRealm(sender), (response) => resolve(clone(response)));
        if (retained !== true) reject(new Error(`The real worker did not accept channel ${channel}`));
      });
    }
    async function send(channel, command, sender) {
      const result = await raw(channel, command, sender);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      return result.data;
    }
    async function presets() { return send("presets", { type: "get_presets" }); }
    async function mutate(type, extra = {}, snapshot = null) {
      const displayed = snapshot ?? await presets();
      return send("presets", {
        type, expectedStreamId: displayed.streamId,
        expectedBaselineId: displayed.baselineId, expectedRevision: displayed.revision, ...extra,
      });
    }
    const presetClient = presetClientModule.createVariationPresetsClient({
      protocol: presetProtocol,
      runtime: { sendMessage: (message) => raw("presets", message.command) },
    });
    return {
      raw, send, presets, mutate, presetClient,
      async sequential(variationNumber, sku = "SYNTH-A", snapshot = null) {
        return presetClient.assignNextPresetItem({
          ...expected(snapshot ?? await presetClient.getPresets()), variationNumber, sku,
        });
      },
      async state() { return (await send("reconciliation", { type: "get_state" })).state; },
      async create(total = 200) { return mutate("create_presets", { total }); },
      async assign(variationNumber, sku = "SYNTH-A") { return mutate("set_preset_item", { variationNumber, sku }); },
      async reset(snapshot) { return mutate("reset_presets", {}, snapshot); },
      async capture(type, extra = {}) { return send("capture", { type, ...extra }, DASHBOARD); },
      async bid(variationNumber) { return send("capture", { type: "observe_bidding_variation", variationNumber }, DASHBOARD); },
      async map(variationNumber, sku = "SYNTH-A") { return send("reconciliation", { type: "map_variation", streamId: STREAM, variationNumber, sku }); },
      async queue(type, expectedVariationNumber, sku = "SYNTH-B") {
        return send("queue", { type, expectedStreamId: STREAM, expectedVariationNumber, sku });
      },
      async end() { return send("session", { type: "end_stream", streamId: STREAM }); },
      async report(reportId) { return send("report", { type: "get_report", reportId }); },
      async health(type = "get", options = {}, sender = type === "get" ? PANEL : DASHBOARD) {
        return send("health", { type, ...(type === "get" ? { streamId: STREAM } : {}), ...options }, sender);
      },
    };
  }
  return { open, values, sessionValues, writes, notifications, errors, failedWrites, failNext };
}

function summary(state) { return reconciliation.calculateSummary(state, { streamId: STREAM }); }
function auction(state, variationNumber) { return reconciliation.getAuction(state, { streamId: STREAM, variationNumber }); }
function expected(snapshot) {
  return { expectedStreamId: snapshot.streamId, expectedBaselineId: snapshot.baselineId, expectedRevision: snapshot.revision };
}

async function setStartupPhase(worker, phase) {
  if (phase === "connecting") return null;
  const context = await worker.health("context");
  await worker.health("pulse", {
    streamId: STREAM, contextId: context.contextId, sequence: 0,
    sampledAt: Date.now(), sample: { phase: "loading" },
  });
  return context;
}

test("startup planning through the real preset client never changes Connecting/Loading or canonical inventory", async () => {
  for (const phase of ["connecting", "loading"]) {
    const h = createHarness(), worker = h.open();
    await setStartupPhase(worker, phase);
    const beforeHealth = await worker.health();
    assert.equal(beforeHealth.phase, phase);
    const beforeState = await worker.state();
    const ready = await worker.presetClient.getPresets();
    const created = await worker.presetClient.createPresets({ ...expected(ready), total: 200 });
    const first = await worker.presetClient.setPresetItem({
      ...expected(created), variationNumber: 1, sku: "SYNTH-A",
    });
    const next = await worker.presetClient.assignNextPresetItem({
      ...expected(first), variationNumber: 1, sku: "SYNTH-B",
    });
    assert.equal(next.assignedVariationNumber, 2);
    assert.deepEqual(await worker.state(), beforeState);
    assert.equal(summary(await worker.state()).totals.auctionCount, 0);
    assert.deepEqual(await worker.health(), beforeHealth, "Planning is not a capture-ready signal");

    const cleared = await worker.presetClient.setPresetItem({
      ...expected(next.presets), variationNumber: 1, sku: null,
    });
    await worker.presetClient.resetPresets(expected(cleared));
    assert.deepEqual(await worker.state(), beforeState, "Unassign/reset are still planning-only during startup");
    assert.deepEqual(await worker.health(), beforeHealth);
    assert.equal((await worker.presets()).total, null);
    assert.ok(Object.keys(h.values).every((key) => [
      reconciliationStorage.STORAGE_KEY, sessionStorage.STORAGE_KEY, presetStorage.STORAGE_KEY,
    ].includes(key)), "The panel override does not need an extra persisted setting");
  }
});

test("startup planning preserves automatic queue conflict clearing and real capture promotion without forcing readiness", async () => {
  const h = createHarness(), worker = h.open();
  // This represents a saved live stream whose new dashboard document is still
  // loading. Its existing queue was created before the current startup lock.
  await worker.bid(1);
  await worker.map(1);
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  const context = await setStartupPhase(worker, "loading");
  const loading = await worker.health();
  const queued = await worker.send("queue", { type: "get_queue" });
  const stateBeforePlanning = await worker.state();
  const initial = await worker.presetClient.getPresets();
  const created = await worker.presetClient.createPresets({ ...expected(initial), total: 10 });
  const distant = await worker.presetClient.setPresetItem({
    ...expected(created), variationNumber: 8, sku: "SYNTH-B",
  });
  assert.deepEqual(await worker.send("queue", { type: "get_queue" }), queued);
  const next = await worker.presetClient.assignNextPresetItem({
    ...expected(distant), variationNumber: 2, sku: "SYNTH-A",
  });
  assert.equal(next.assignedVariationNumber, 2);
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
  assert.ok(h.notifications.some((message) => message.channel === CHANNELS.queue));
  assert.deepEqual(await worker.state(), stateBeforePlanning);
  assert.deepEqual(await worker.health(), loading);

  await worker.capture("payment_complete", { variationNumber: 2, soldPriceCents: 1700 });
  const captured = await worker.state();
  assert.equal(auction(captured, 2).sku, "SYNTH-A");
  assert.equal(summary(captured).inventory[0].soldQuantity, 1);
  assert.equal(summary(captured).totals.costOfGoodsCents, 500);
  assert.equal(summary(captured).totals.profitCents, 1200);
  assert.deepEqual((await worker.presets()).assignments, [{ variationNumber: 8, sku: "SYNTH-B" }]);
  await worker.capture("payment_complete", { variationNumber: 2, soldPriceCents: 1700 });
  assert.deepEqual(await worker.state(), captured, "Startup promotion remains idempotent");
  assert.deepEqual(await worker.health(), loading, "Capture accounting cannot mark initialization complete");
  await worker.health("pulse", {
    streamId: STREAM, contextId: context.contextId, sequence: 1,
    sampledAt: Date.now(), sample: { phase: "ready" },
  });
  assert.equal((await worker.health()).phase, "active", "Only the capture producer completes readiness");
});

test("startup capture/save races retain authoritative future validation and never turn stale planning into live mapping", async () => {
  for (const captureFirst of [true, false]) {
    const worker = createHarness().open();
    await setStartupPhase(worker, "loading");
    const healthBefore = await worker.health();
    const created = await worker.presetClient.createPresets({
      ...expected(await worker.presetClient.getPresets()), total: 10,
    });
    const capture = () => worker.bid(3);
    const assign = () => worker.presetClient.assignNextPresetItem({
      ...expected(created), variationNumber: 3, sku: "SYNTH-A",
    });
    const first = captureFirst ? capture() : assign();
    // The real preset client queues transport on its promise tail. Let that
    // send reach the worker before scheduling the competing capture; neither
    // authoritative operation needs to finish before the other is submitted.
    if (!captureFirst) await Promise.resolve();
    const second = captureFirst ? assign() : capture();
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, captureFirst ? "rejected" : "fulfilled");
    if (captureFirst) assert.equal(outcomes[1].reason.code, "VARIATION_ALREADY_CAPTURED");
    const captured = await worker.state();
    assert.equal(auction(captured, 3).sku, captureFirst ? null : "SYNTH-A");
    assert.equal(summary(captured).inventory[0].reservedQuantity, captureFirst ? 0 : 1);
    assert.deepEqual((await worker.presets()).assignments, []);
    assert.deepEqual(await worker.health(), healthBefore);
    const current = await worker.presets();
    await assert.rejects(worker.presetClient.setPresetItem({
      ...expected(current), variationNumber: 3, sku: "SYNTH-B",
    }), { code: "VARIATION_ALREADY_CAPTURED" });
    assert.deepEqual(await worker.state(), captured);
  }
});

test("starting with confirmed inventory pins the existing baseline and permits client planning before first capture", async () => {
  const h = createHarness({ active: false }), worker = h.open();
  const inventoryBefore = clone(h.values[reconciliationStorage.STORAGE_KEY].reconciliationState.inventoryBaselines);
  assert.equal((await worker.presetClient.getPresets()).streamId, null);
  const session = await worker.send("session", { type: "start_stream" });
  const streamId = session.state.activeSession.streamId;
  const ready = await worker.presetClient.getPresets();
  assert.equal(ready.streamId, streamId);
  assert.equal(ready.baselineId, BASELINE);
  const before = await worker.state();
  assert.deepEqual(before.inventoryBaselines, inventoryBefore, "Start reuses, rather than invents, the confirmed inventory baseline");
  assert.deepEqual(before.streams, [{
    streamId, inventoryBaselineId: BASELINE, activeBiddingVariationNumber: null,
    attributedGmvDisplay: null, variations: [],
  }]);
  const created = await worker.presetClient.createPresets({ ...expected(ready), total: 200 });
  await worker.presetClient.setPresetItem({ ...expected(created), variationNumber: 1, sku: "SYNTH-A" });
  const first = await worker.sequential(2, "SYNTH-B");
  assert.equal(first.assignedVariationNumber, 2);
  const next = await worker.sequential(2, "SYNTH-A");
  assert.equal(next.assignedVariationNumber, 3);
  assert.deepEqual(next.presets.assignments, [
    { variationNumber: 1, sku: "SYNTH-A" },
    { variationNumber: 2, sku: "SYNTH-B" },
    { variationNumber: 3, sku: "SYNTH-A" },
  ]);
  assert.deepEqual(await worker.state(), before, "all pre-stream planning stays outside canonical history and inventory");
  assert.equal((await worker.send("live", { type: "get_live_bid" })).liveAuction, null);
  const summaryBefore = reconciliation.calculateSummary(before, { streamId });
  assert.equal(summaryBefore.totals.auctionCount, 0);
  assert.ok(summaryBefore.inventory.every((item) => item.reservedQuantity === 0 && item.soldQuantity === 0));
  const ended = await worker.send("session", { type: "end_stream", streamId });
  const { report } = await worker.report(ended.result.reportId);
  assert.equal(report.totals.auctionCount, 0);
  assert.equal(report.totals.unresolvedOrderCount, 0);
  assert.equal(report.totals.costOfGoodsCents, 0);
  assert.equal(report.totals.committedRevenueCents, 0);
  assert.equal(report.totals.grossProfitCents, 0);
  assert.deepEqual(report.completedSales, []);
  assert.deepEqual(report.canceledOrders, []);
  assert.deepEqual(report.sheetRows.map((row) => row.quantity_on_hand_at_import), [10, 10]);
});

test("resuming an active unpinned session initializes a zero-capture preset context without a new baseline", async () => {
  const h = createHarness({ pinned: false }), worker = h.open();
  const inventoryBefore = clone(h.values[reconciliationStorage.STORAGE_KEY].reconciliationState.inventoryBaselines);
  assert.equal((await worker.presetClient.getPresets()).streamId, null, "an unverified baseline remains unavailable before the session workflow pins it");
  await worker.send("session", { type: "get_stream_session" });
  const ready = await worker.presetClient.getPresets();
  assert.equal(ready.streamId, STREAM);
  assert.equal(ready.baselineId, BASELINE);
  assert.deepEqual((await worker.state()).inventoryBaselines, inventoryBefore);
  assert.equal(summary(await worker.state()).totals.auctionCount, 0);
  const plan = await worker.create(200);
  await worker.assign(1, "SYNTH-B");
  const afterAssignment = await worker.presets();
  assert.notEqual(afterAssignment.revision, plan.revision);
  const reopened = h.open();
  await reopened.send("session", { type: "get_stream_session" });
  assert.deepEqual(await reopened.presets(), afterAssignment);
  assert.equal(summary(await reopened.state()).inventory[1].reservedQuantity, 0);
  await reopened.bid(1);
  await reopened.bid(1);
  assert.equal(auction(await reopened.state(), 1).sku, "SYNTH-B");
  assert.equal(summary(await reopened.state()).inventory[1].reservedQuantity, 1);
  assert.deepEqual((await reopened.presets()).assignments, []);
});

test("pre-stream Start remains blocked for missing or unconfirmed inventory and leaves no preset data", async () => {
  for (const inventory of ["missing", "unconfirmed"]) {
    const h = createHarness({ active: false, inventory }), worker = h.open();
    const before = clone(h.values);
    const response = await worker.raw("session", { type: "start_stream" });
    assert.equal(response.ok, false, inventory);
    assert.equal(response.error.code, inventory === "missing" ? "INVENTORY_BASELINE_REQUIRED" : "INVENTORY_IMPORT_REQUIRED");
    assert.equal((await worker.presetClient.getPresets()).streamId, null);
    const mutation = await worker.raw("presets", {
      type: "create_presets", expectedStreamId: STREAM, expectedBaselineId: BASELINE, expectedRevision: null, total: 200,
    });
    assert.equal(mutation.ok, false);
    assert.equal(mutation.error.code, "NO_ACTIVE_STREAM");
    assert.deepEqual(h.values, before);
    assert.equal(Object.hasOwn(h.values, presetStorage.STORAGE_KEY), false);
  }
});

test("failed pre-stream baseline pin keeps presets unavailable until the existing resume workflow succeeds", async () => {
  const h = createHarness({ active: false }), worker = h.open();
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, reconciliationStorage.STORAGE_KEY));
  assert.equal((await worker.raw("session", { type: "start_stream" })).ok, false);
  assert.equal(h.failedWrites.length, 1);
  assert.equal((await worker.presets()).streamId, null);
  const session = await worker.send("session", { type: "get_stream_session" });
  const ready = await worker.presets();
  assert.equal(ready.streamId, session.state.activeSession.streamId);
  assert.equal(ready.baselineId, BASELINE);
  await worker.create(200);
  assert.equal((await worker.state()).streams[0].variations.length, 0);
  assert.equal((await worker.state()).inventoryBaselines.length, 1);
});

test("pre-stream reset and unassignment discard only planning state before any auction exists", async () => {
  const h = createHarness({ active: false }), worker = h.open();
  await worker.send("session", { type: "start_stream" });
  const before = await worker.state();
  await worker.create(200);
  await worker.assign(1);
  await worker.assign(2, "SYNTH-B");
  await worker.assign(1, null);
  assert.deepEqual((await worker.presets()).assignments, [{ variationNumber: 2, sku: "SYNTH-B" }]);
  const old = await worker.presets();
  const reset = await worker.reset(old);
  assert.equal(reset.total, null);
  assert.deepEqual(reset.assignments, []);
  assert.deepEqual(await worker.state(), before);
  await assert.rejects(worker.presetClient.assignNextPresetItem({ ...expected(old), variationNumber: 2, sku: "SYNTH-A" }), { code: "PRESETS_CHANGED" });
  assert.deepEqual((await h.open().presets()).assignments, []);
});

test("first capture serialized before pre-stream assignment rejects stale planning rather than altering the real order", async () => {
  const h = createHarness({ pinned: false }), worker = h.open();
  await worker.send("session", { type: "get_stream_session" });
  await worker.create(200);
  const plan = await worker.presets();
  const [capture, assignment] = await Promise.all([
    worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 1 }, DASHBOARD),
    worker.raw("presets", { type: "assign_next_preset_item", ...expected(plan), variationNumber: 1, sku: "SYNTH-A" }),
  ]);
  assert.equal(capture.ok, true);
  assert.equal(assignment.ok, false);
  assert.equal(assignment.error.code, "VARIATION_ALREADY_CAPTURED");
  assert.equal(auction(await worker.state(), 1).sku, null);
  assert.equal(summary(await worker.state()).inventory[0].reservedQuantity, 0);
  assert.deepEqual((await worker.presets()).assignments, []);
});

test("pre-stream sequential save serialized before first capture promotes once through existing inventory logic", async () => {
  const h = createHarness({ pinned: false }), worker = h.open();
  await worker.send("session", { type: "get_stream_session" });
  await worker.create(200);
  const plan = await worker.presets();
  const [assignment, capture] = await Promise.all([
    worker.raw("presets", { type: "assign_next_preset_item", ...expected(plan), variationNumber: 1, sku: "SYNTH-B" }),
    worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 1 }, DASHBOARD),
  ]);
  assert.equal(assignment.ok, true);
  assert.equal(assignment.data.assignedVariationNumber, 1);
  assert.equal(capture.ok, true);
  await worker.bid(1);
  assert.equal(auction(await worker.state(), 1).sku, "SYNTH-B");
  assert.equal(summary(await worker.state()).inventory[1].reservedQuantity, 1);
  assert.deepEqual((await worker.presets()).assignments, []);
});

test("actual live capture exceeding the preset range enables a preserving client-to-worker extension", async () => {
  const h = createHarness(), worker = h.open();
  await worker.create(100);
  await worker.assign(80, "SYNTH-B");
  await worker.bid(100);
  await worker.map(100);
  const atLimit = await worker.presetClient.getPresets();
  assert.notEqual(atLimit.extensionAvailable, true);
  await assert.rejects(worker.presetClient.createPresets({ ...expected(atLimit), total: 200 }), { code: "PRESETS_ALREADY_ENABLED" });
  await worker.bid(101);
  const exceeded = await worker.presetClient.getPresets();
  assert.equal(exceeded.extensionAvailable, true);
  assert.equal(exceeded.total, 100);
  assert.equal(exceeded.revision, atLimit.revision, "readiness metadata does not invalidate existing plan identity");
  assert.deepEqual(exceeded.assignments, atLimit.assignments);
  const canonical = await worker.state();
  const extended = await worker.presetClient.createPresets({ ...expected(exceeded), total: 200 });
  assert.equal(extended.total, 200);
  assert.notEqual(extended.extensionAvailable, true);
  assert.notEqual(extended.revision, exceeded.revision);
  assert.deepEqual(extended.assignments, exceeded.assignments);
  assert.deepEqual(await worker.state(), canonical);
  assert.equal(auction(canonical, 100).sku, "SYNTH-A");
  assert.deepEqual(await h.open().presetClient.getPresets(), extended);
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 80, observedPaymentStatus: "canceled" }] });
  assert.equal(auction(await worker.state(), 80).sku, "SYNTH-B", "skipped plan still promotes after extension");
  assert.deepEqual((await worker.presets()).assignments, []);
});

test("high historical backfill cannot authorize extension with or without an actual live marker", async () => {
  for (const hasLiveMarker of [true, false]) {
    const worker = createHarness().open();
    await worker.create(100);
    if (hasLiveMarker) await worker.bid(100);
    await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 201, observedPaymentStatus: "canceled" }] });
    const backfilled = await worker.presets();
    assert.notEqual(backfilled.extensionAvailable, true);
    await assert.rejects(worker.presetClient.createPresets({ ...expected(backfilled), total: 300 }), { code: "PRESETS_ALREADY_ENABLED" });
    await worker.bid(102);
    const eligible = await worker.presets();
    assert.equal(eligible.extensionAvailable, true, "skipping past the total is sufficient real live advancement");
    await assert.rejects(worker.presetClient.createPresets({ ...expected(eligible), total: 200 }), { code: "PRESET_TOTAL_BELOW_CAPTURED" });
    assert.equal((await worker.presetClient.createPresets({ ...expected(eligible), total: 300 })).total, 300);
  }
});

test("exhausted-range availability survives payment clearing the live marker and worker restart without repeated writes", async () => {
  const h = createHarness(), worker = h.open();
  await worker.create(100);
  await worker.bid(101);
  const exceeded = await worker.presets();
  const writes = h.writes.filter((write) => write.items?.[presetStorage.STORAGE_KEY]).length;
  await worker.capture("payment_complete", { variationNumber: 101, soldPriceCents: 1700 });
  assert.equal((await worker.state()).streams[0].activeBiddingVariationNumber, null);
  const reopened = h.open();
  assert.deepEqual(await reopened.presetClient.getPresets(), exceeded);
  assert.deepEqual(await reopened.presetClient.getPresets(), exceeded);
  assert.equal(h.writes.filter((write) => write.items?.[presetStorage.STORAGE_KEY]).length, writes);
  await reopened.presetClient.createPresets({ ...expected(exceeded), total: 200 });
  await reopened.bid(201);
  assert.equal((await reopened.presets()).extensionAvailable, true, "each new range can be extended after it is exceeded");
});

test("capture advancing during an extension revalidates totals and can immediately exceed an accepted new range", async () => {
  const worker = createHarness().open();
  await worker.create(100);
  await worker.bid(101);
  const displayed = await worker.presets();
  await worker.bid(151);
  await assert.rejects(worker.presetClient.createPresets({ ...expected(displayed), total: 150 }), { code: "PRESET_TOTAL_BELOW_CAPTURED" });
  assert.equal((await worker.presets()).total, 100);
  const [extended, captured] = await Promise.all([
    worker.raw("presets", { type: "create_presets", ...expected(displayed), total: 200 }),
    worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 201 }, DASHBOARD),
  ]);
  assert.equal(extended.ok, true);
  assert.equal(captured.ok, true);
  assert.notEqual(extended.data.extensionAvailable, true);
  const current = await worker.presets();
  assert.equal(current.total, 200);
  assert.equal(current.extensionAvailable, true, "later authoritative capture supersedes the earlier successful response");
});

test("preset extension never raises the preset limit or restricts real capture beyond it", async () => {
  const worker = createHarness().open();
  await worker.create(1000);
  await worker.assign(80);
  await worker.bid(1001);
  const before = await worker.presets();
  assert.equal(before.extensionAvailable, true);
  for (const total of [1000, 1001, 2000, -1, 1.5, "200", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(worker.presetClient.createPresets({ ...expected(before), total }));
  }
  assert.deepEqual(await worker.presets(), before);
  await worker.bid(2000);
  assert.equal(auction(await worker.state(), 2000).sku, null);
  assert.deepEqual((await worker.presets()).assignments, before.assignments);
});

test("failed extension persistence keeps the exhausted range and its assignments available for explicit retry", async () => {
  const h = createHarness(), worker = h.open();
  await worker.create(100);
  await worker.assign(80);
  await worker.bid(101);
  const before = await worker.presets(), canonical = await worker.state();
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
  await assert.rejects(worker.presetClient.createPresets({ ...expected(before), total: 200 }));
  assert.equal(h.failedWrites.length, 1);
  assert.deepEqual(await worker.presets(), before);
  assert.deepEqual(await worker.state(), canonical);
  const reopened = h.open();
  assert.deepEqual(await reopened.presets(), before);
  assert.equal((await reopened.presetClient.createPresets({ ...expected(before), total: 200 })).total, 200);
});

test("extension competes safely with sequential assignments and duplicate commands under the worker FIFO", async () => {
  for (const extendFirst of [true, false]) {
    const worker = createHarness().open();
    await worker.create(100);
    await worker.bid(101);
    const before = await worker.presets();
    const extend = () => worker.raw("presets", { type: "create_presets", ...expected(before), total: 200 });
    const assign = () => worker.raw("presets", { type: "assign_next_preset_item", ...expected(before), variationNumber: 80, sku: "SYNTH-B" });
    const results = await Promise.all(extendFirst ? [extend(), assign()] : [assign(), extend()]);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.code, "PRESETS_CHANGED");
    if (!extendFirst) await worker.create(200);
    assert.deepEqual((await worker.presets()).assignments, extendFirst ? [] : [{ variationNumber: 80, sku: "SYNTH-B" }]);
    assert.equal((await extend()).error.code, "PRESETS_CHANGED", "duplicate extension cannot act against the new revision");
  }
});

test("captured preset promotion during extension cannot resurrect consumed plans or lose remaining plans", async () => {
  const worker = createHarness().open();
  await worker.create(100);
  await worker.assign(80);
  await worker.assign(81, "SYNTH-B");
  await worker.bid(101);
  const before = await worker.presets();
  const [captured, extended] = await Promise.all([
    worker.raw("capture", { type: "payment_complete", variationNumber: 80, soldPriceCents: 1700 }, DASHBOARD),
    worker.raw("presets", { type: "create_presets", ...expected(before), total: 200 }),
  ]);
  assert.equal(captured.ok, true);
  assert.equal(extended.ok, false);
  assert.equal(extended.error.code, "PRESETS_CHANGED");
  const after = await worker.create(200);
  assert.deepEqual(after.assignments, [{ variationNumber: 81, sku: "SYNTH-B" }]);
  assert.equal(auction(await worker.state(), 80).sku, "SYNTH-A");
  assert.equal(summary(await worker.state()).inventory[0].soldQuantity, 1);
});

test("manual reset invalidates a delayed extension and successful End never carries extension eligibility into a new stream", async () => {
  const worker = createHarness().open();
  await worker.create(100);
  await worker.assign(80);
  await worker.bid(101);
  const old = await worker.presets();
  await worker.reset();
  await worker.create(200);
  await worker.assign(90, "SYNTH-B");
  const replacement = await worker.presets();
  await assert.rejects(worker.presetClient.createPresets({ ...expected(old), total: 300 }), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await worker.presets(), replacement);
  await worker.bid(201);
  assert.equal((await worker.presets()).extensionAvailable, true);
  await worker.end();
  await worker.send("session", { type: "start_stream" });
  const next = await worker.presets();
  assert.notEqual(next.streamId, old.streamId);
  assert.notEqual(next.extensionAvailable, true);
  assert.equal(next.total, null);
  await assert.rejects(worker.presetClient.createPresets({ ...expected(old), total: 300 }), { code: "PRESET_CONTEXT_CHANGED" });
});

test("enabling and saving an extension preserves the ordinary queue, accounting, and report inventory export", async () => {
  const h = createHarness(), worker = h.open();
  await worker.create(100);
  await worker.assign(80, "SYNTH-B");
  await worker.bid(100);
  await worker.map(100);
  await worker.bid(101);
  await worker.map(101);
  await worker.queue("toggle_queue", 101, "SYNTH-B");
  const queue = await worker.send("queue", { type: "get_queue" });
  const canonical = await worker.state();
  const eligible = await worker.presets();
  assert.deepEqual(await worker.send("queue", { type: "get_queue" }), queue);
  const extended = await worker.presetClient.createPresets({ ...expected(eligible), total: 200 });
  assert.deepEqual(extended.assignments, eligible.assignments);
  assert.deepEqual(await worker.send("queue", { type: "get_queue" }), queue);
  assert.deepEqual(await worker.state(), canonical);
  await worker.capture("payment_complete", { variationNumber: 101, soldPriceCents: 1700 });
  const ended = await worker.end();
  const { report } = await worker.report(ended.result.reportId);
  assert.equal(report.totals.costOfGoodsCents, 500);
  assert.equal(report.totals.grossProfitCents, 1200);
  assert.equal(report.sheetRows[0].quantity_on_hand_at_import, 9);
  assert.equal(report.sheetRows[1].quantity_on_hand_at_import, 10);
  assert.doesNotMatch(JSON.stringify(report), /"variationNumber":80/);
});

test("failed readiness persistence recovers before payment can clear live proof, including after worker restart", async () => {
  for (const restart of [true, false]) {
    const h = createHarness();
    let worker = h.open();
    await worker.create(100);
    await worker.assign(80);
    h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
    assert.equal((await worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 101 }, DASHBOARD)).ok, false);
    assert.equal(h.values[reconciliationStorage.STORAGE_KEY].reconciliationState.streams[0].activeBiddingVariationNumber, 101);
    assert.notEqual(h.values[presetStorage.STORAGE_KEY].presets.extensionAvailable, true);
    if (restart) worker = h.open();
    await worker.capture("payment_complete", { variationNumber: 101, soldPriceCents: 1700 });
    assert.equal((await worker.state()).streams[0].activeBiddingVariationNumber, null);
    const recovered = await worker.presets();
    assert.equal(recovered.extensionAvailable, true);
    assert.deepEqual(recovered.assignments, [{ variationNumber: 80, sku: "SYNTH-A" }]);
    assert.equal((await worker.presetClient.createPresets({ ...expected(recovered), total: 200 })).total, 200);
  }
});

test("readiness barrier failure retains the canonical live proof for the existing capture retry path", async () => {
  const h = createHarness(), worker = h.open();
  await worker.create(100);
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
  assert.equal((await worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 101 }, DASHBOARD)).ok, false);
  const before = clone(h.values[reconciliationStorage.STORAGE_KEY]);
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
  assert.equal((await worker.raw("capture", { type: "payment_complete", variationNumber: 101, soldPriceCents: 1700 }, DASHBOARD)).ok, false);
  assert.deepEqual(h.values[reconciliationStorage.STORAGE_KEY], before, "failed readiness barrier cannot erase the only durable live evidence");
  await worker.capture("payment_complete", { variationNumber: 101, soldPriceCents: 1700 });
  assert.equal(auction(await worker.state(), 101).paymentStatus, "payment_complete");
  assert.equal((await worker.presets()).extensionAvailable, true);
});

test("real preset client and worker sequentially fill the source then skip assigned and captured targets", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(24);
  await worker.create(30);
  await worker.assign(27, "SYNTH-B");
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 28, observedPaymentStatus: "canceled" }] });
  await worker.map(28, "SYNTH-B");
  const canonical = await worker.state();
  const first = await worker.sequential(25);
  assert.equal(first.assignedVariationNumber, 25);
  const second = await worker.sequential(25, "SYNTH-B", first.presets);
  assert.equal(second.assignedVariationNumber, 26);
  const third = await worker.sequential(26, "SYNTH-A", second.presets);
  assert.equal(third.assignedVariationNumber, 29);
  const fourth = await worker.sequential(29, "SYNTH-A", third.presets);
  assert.equal(fourth.assignedVariationNumber, 30, "same SKU advances rather than unassigning");
  assert.deepEqual(fourth.presets.assignments, [
    { variationNumber: 25, sku: "SYNTH-A" }, { variationNumber: 26, sku: "SYNTH-B" },
    { variationNumber: 27, sku: "SYNTH-B" }, { variationNumber: 29, sku: "SYNTH-A" },
    { variationNumber: 30, sku: "SYNTH-A" },
  ]);
  assert.deepEqual(await worker.state(), canonical);
  assert.deepEqual(await h.open().presetClient.getPresets(), fourth.presets);
});

test("sequential end-of-range feedback never wraps, overwrites, queues, or writes", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create(5);
  const saved = await worker.sequential(5, "SYNTH-B");
  assert.equal(saved.assignedVariationNumber, 5, "an empty final preset accepts its initial assignment");
  const before = clone(h.values);
  const writes = h.writes.length;
  await assert.rejects(worker.sequential(5, "SYNTH-A", saved.presets), {
    code: "NO_MORE_FUTURE_VARIATIONS", message: "No more future variations.",
  });
  assert.deepEqual(h.values, before);
  assert.equal(h.writes.length, writes);
  assert.deepEqual((await worker.presets()).assignments, [{ variationNumber: 5, sku: "SYNTH-B" }]);
  assert.equal(summary(await worker.state()).totals.auctionCount, 0);
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
});

test("sequential future plans use ordinary capture promotion and remain excluded from reports and exports until captured", async () => {
  const worker = createHarness().open();
  await worker.create(200);
  const before = await worker.state();
  let source = 1;
  for (let index = 0; index < 5; index += 1) {
    source = (await worker.sequential(source)).assignedVariationNumber;
  }
  assert.equal(source, 5);
  assert.deepEqual(await worker.state(), before, "five plans reserve no stock and create no canonical orders");
  await worker.bid(1);
  await worker.capture("observe_payment_statuses", { statuses: [
    { variationNumber: 2, observedPaymentStatus: "payment_processing" },
    { variationNumber: 4, observedPaymentStatus: "canceled" },
  ] });
  await worker.capture("payment_complete", { variationNumber: 3, soldPriceCents: 1700 });
  const captured = await worker.state();
  assert.equal(summary(captured).inventory[0].reservedQuantity, 2);
  assert.equal(summary(captured).inventory[0].soldQuantity, 1);
  assert.equal(summary(captured).totals.canceledOrderCount, 1);
  await worker.bid(1);
  await worker.capture("payment_complete", { variationNumber: 3, soldPriceCents: 1700 });
  assert.deepEqual(await worker.state(), captured, "repeated capture has no duplicate effects");
  const ended = await worker.end();
  const { report } = await worker.report(ended.result.reportId);
  assert.equal(report.totals.costOfGoodsCents, 500);
  assert.equal(report.totals.grossProfitCents, 1200);
  assert.equal(report.totals.unresolvedOrderCount, 2);
  assert.equal(report.inventory[0].replacementQuantity, 9);
  assert.equal(report.sheetRows[0].quantity_on_hand_at_import, 9);
  assert.doesNotMatch(JSON.stringify(report), /"variationNumber":5/);
});

test("sequential assignment clears only an actual next-preset queue conflict through the real queue coordinator", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create(10);
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  const queueBefore = await worker.send("queue", { type: "get_queue" });
  await worker.sequential(8);
  assert.deepEqual(await worker.send("queue", { type: "get_queue" }), queueBefore, "distant plan does not clear the queue");
  const canonical = await worker.state();
  await worker.sequential(2);
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
  assert.deepEqual(await worker.state(), canonical);
  assert.ok(h.notifications.some((message) => message.channel === CHANNELS.queue));
  assert.equal((await worker.raw("queue", {
    type: "toggle_queue", expectedStreamId: STREAM, expectedVariationNumber: 1, sku: "SYNTH-B",
  })).error.code, "NEXT_VARIATION_PRESET");
  await worker.queue("map_current", 1, "SYNTH-B");
  assert.equal(auction(await worker.state(), 1).sku, "SYNTH-B");
  await worker.bid(2);
  assert.equal(auction(await worker.state(), 2).sku, "SYNTH-A");
});

test("duplicate sequential deliveries with the same revision fill only one target even across worker restart", async () => {
  const h = createHarness();
  const worker = h.open();
  const presets = await worker.create(10);
  const options = { ...expected(presets), variationNumber: 3, sku: "SYNTH-A" };
  const results = await Promise.allSettled([
    worker.presetClient.assignNextPresetItem(options), worker.presetClient.assignNextPresetItem(options),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value.assignedVariationNumber, 3);
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "PRESETS_CHANGED");
  await assert.rejects(h.open().presetClient.assignNextPresetItem(options), { code: "PRESETS_CHANGED" });
  assert.deepEqual((await worker.presets()).assignments, [{ variationNumber: 3, sku: "SYNTH-A" }]);
});

test("sequential persistence failure leaves prior assignments intact and returns no successful target", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create(10);
  await worker.assign(3, "SYNTH-B");
  const before = await worker.presets();
  const canonical = await worker.state();
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
  await assert.rejects(worker.sequential(3, "SYNTH-A", before));
  assert.equal(h.failedWrites.length, 1);
  assert.deepEqual(await h.open().presets(), before);
  assert.deepEqual(await worker.state(), canonical);
  const saved = await worker.sequential(3, "SYNTH-A", before);
  assert.equal(saved.assignedVariationNumber, 4);
});

test("a saved sequential plan survives failed queue clearing without an automatic retry assigning another target", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create(10);
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  const before = await worker.presets();
  h.failNext(({ operation, keys }) => operation === "remove" && keys.includes(queueStorage.STORAGE_KEY));
  await assert.rejects(worker.sequential(2, "SYNTH-A", before));
  assert.equal(h.failedWrites.length, 1);
  assert.deepEqual(h.values[presetStorage.STORAGE_KEY].presets.assignments, [{ variationNumber: 2, sku: "SYNTH-A" }]);
  const reopened = h.open();
  const repaired = await reopened.presetClient.getPresets();
  assert.deepEqual(repaired.assignments, [{ variationNumber: 2, sku: "SYNTH-A" }]);
  assert.equal((await reopened.send("queue", { type: "get_queue" })).queuedSku, null);
  await assert.rejects(reopened.sequential(2, "SYNTH-A", before), { code: "PRESETS_CHANGED" });
  await reopened.bid(2);
  assert.equal(auction(await reopened.state(), 2).sku, "SYNTH-A");
  assert.deepEqual((await reopened.presets()).assignments, []);
});

test("capture racing sequential assignment never turns an old future action into actual live mapping", async () => {
  for (const captureFirst of [true, false]) {
    const h = createHarness();
    const worker = h.open();
    const presets = await worker.create(10);
    const capture = () => worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 3 }, DASHBOARD);
    const sequential = () => worker.raw("presets", {
      type: "assign_next_preset_item", ...expected(presets), variationNumber: 3, sku: "SYNTH-A",
    });
    const [first, second] = await Promise.all(captureFirst ? [capture(), sequential()] : [sequential(), capture()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, !captureFirst);
    assert.equal(auction(await worker.state(), 3).sku, captureFirst ? null : "SYNTH-A");
    assert.deepEqual((await worker.presets()).assignments, []);
  }
});

test("capture of the next empty target makes the serialized worker skip it without overwriting its mapping", async () => {
  const worker = createHarness().open();
  await worker.create(10);
  await worker.assign(3);
  const beforeCapture = await worker.presets();
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 4, observedPaymentStatus: "canceled" }] });
  await worker.map(4, "SYNTH-B");
  const saved = await worker.sequential(3, "SYNTH-A", beforeCapture);
  assert.equal(saved.assignedVariationNumber, 5);
  assert.equal(auction(await worker.state(), 4).sku, "SYNTH-B");
});

test("reset and replacement preset configurations reject delayed sequential requests without resurrecting plans", async () => {
  const worker = createHarness().open();
  const old = await worker.create(10);
  await worker.reset();
  await worker.create(20);
  await worker.assign(3, "SYNTH-B");
  const newer = await worker.presets();
  await assert.rejects(worker.sequential(3, "SYNTH-A", old), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await worker.presets(), newer);
  await worker.bid(3);
  assert.equal(auction(await worker.state(), 3).sku, "SYNTH-B");
});

test("sequential requests enforce sender, source, exact SKU, stream, baseline, and ended-session boundaries", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  const presets = await worker.create(10);
  const command = { type: "assign_next_preset_item", ...expected(presets), variationNumber: 3, sku: "SYNTH-A" };
  const before = clone(h.values);
  for (const delta of [
    { variationNumber: 1 }, { variationNumber: 11 }, { variationNumber: 1.5 },
    { sku: null }, { sku: "UNKNOWN" }, { sku: " SYNTH-A " },
    { expectedStreamId: "wrong-stream" }, { expectedBaselineId: "wrong-baseline" },
  ]) assert.equal((await worker.raw("presets", { ...command, ...delta })).ok, false);
  assert.equal((await worker.raw("presets", command, DASHBOARD)).ok, false);
  assert.deepEqual(h.values, before);
  await worker.end();
  await assert.rejects(worker.sequential(3, "SYNTH-A", presets), { code: "NO_ACTIVE_STREAM" });
  await worker.send("session", { type: "start_stream" });
  await assert.rejects(worker.sequential(3, "SYNTH-A", presets), { code: "PRESET_CONTEXT_CHANGED" });
  assert.deepEqual((await worker.presets()).assignments, []);
});

test("real worker preserves canonical state while 200 future presets are planned, persisted, reopened, and unassigned", async () => {
  const h = createHarness();
  let worker = h.open();
  await worker.bid(3);
  await worker.map(3, "SYNTH-B");
  const before = await worker.state();
  await worker.create(200);
  await worker.assign(4);
  await worker.assign(80);
  await worker.assign(200, "SYNTH-B");
  assert.deepEqual(await worker.state(), before);
  const saved = await worker.presets();
  assert.equal(saved.total, 200);
  assert.deepEqual(saved.assignments, [
    { variationNumber: 4, sku: "SYNTH-A" },
    { variationNumber: 80, sku: "SYNTH-A" },
    { variationNumber: 200, sku: "SYNTH-B" },
  ]);
  worker = h.open();
  assert.deepEqual(await worker.presets(), saved);
  await worker.assign(80, null);
  assert.deepEqual((await worker.presets()).assignments.map((entry) => entry.variationNumber), [4, 200]);
  assert.deepEqual(await worker.state(), before);
  assert.equal(summary(before).totals.auctionCount, 1);
  assert.equal(summary(before).inventory[0].reservedQuantity, 0);
});

test("real worker rejects invalid totals, captured targets, stale identities, and unauthorized preset senders without writes", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(30);
  const empty = await worker.presets();
  const baseline = clone(h.values);
  for (const total of [0, -1, 1.5, "200", 1001, Number.MAX_SAFE_INTEGER + 1, 29]) {
    const response = await worker.raw("presets", { type: "create_presets", ...expected(empty), total });
    assert.equal(response.ok, false, `total ${total}`);
  }
  for (const sender of [DASHBOARD, { ...PANEL, id: "another-extension" }, { ...PANEL, url: PANEL.url.replace("sidepanel", "other") }]) {
    assert.equal((await worker.raw("presets", { type: "create_presets", ...expected(empty), total: 200 }, sender)).ok, false);
  }
  assert.deepEqual(h.values, baseline);
  await worker.create(200);
  const enabled = await worker.presets();
  assert.equal((await worker.raw("presets", { type: "create_presets", ...expected(enabled), total: 300 })).ok, false);
  for (const change of [
    { variationNumber: 30, sku: "SYNTH-A" },
    { variationNumber: 201, sku: "SYNTH-A" },
    { variationNumber: 31, sku: "UNKNOWN-SKU" },
  ]) {
    assert.equal((await worker.raw("presets", { type: "set_preset_item", ...expected(enabled), ...change })).ok, false);
  }
  assert.equal((await worker.raw("presets", { type: "reset_presets", ...expected(enabled), expectedBaselineId: "different-baseline" })).ok, false);
  assert.deepEqual(await worker.presets(), enabled);
  await worker.reset();
  await worker.create(presetProtocol.MAX_PRESET_VARIATIONS);
  assert.equal((await worker.presets()).total, 1000);
});

test("captured preset bidding, processing, complete, and canceled orders reuse real reconciliation and report accounting", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create(200);
  for (const number of [1, 2, 3, 4, 100]) await worker.assign(number);
  assert.equal(summary(await worker.state()).totals.auctionCount, 0);
  await worker.bid(1);
  assert.equal(summary(await worker.state()).inventory[0].reservedQuantity, 1);
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 2, observedPaymentStatus: "payment_processing" }] });
  await worker.capture("payment_complete", { variationNumber: 3, soldPriceCents: 1700 });
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 4, observedPaymentStatus: "canceled" }] });
  const captured = await worker.state();
  for (const number of [1, 2, 3, 4]) assert.equal(auction(captured, number).sku, "SYNTH-A");
  assert.equal(summary(captured).inventory[0].reservedQuantity, 2);
  assert.equal(summary(captured).inventory[0].soldQuantity, 1);
  assert.equal(summary(captured).inventory[0].remainingQuantity, 9);
  assert.equal(summary(captured).totals.canceledOrderCount, 1);
  assert.equal(summary(captured).totals.costOfGoodsCents, 500);
  assert.equal(summary(captured).totals.profitCents, 1200);
  assert.equal(auction(captured, 4).committed, false);
  const snapshot = await worker.presets();
  assert.deepEqual(snapshot.assignments, [{ variationNumber: 100, sku: "SYNTH-A" }]);
  await worker.capture("payment_complete", { variationNumber: 3, soldPriceCents: 1700 });
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 4, observedPaymentStatus: "canceled" }] });
  assert.deepEqual(await worker.state(), captured);
  const ended = await worker.end();
  const record = await worker.report(ended.result.reportId);
  assert.equal(record.report.completedSales.length, 1);
  assert.equal(record.report.completedSales[0].sku, "SYNTH-A");
  assert.equal(record.report.canceledOrders.length, 1);
  assert.equal(record.report.canceledOrders[0].sku, "SYNTH-A");
  assert.equal(record.report.totals.costOfGoodsCents, 500);
  assert.equal(record.report.totals.grossProfitCents, 1200);
  assert.equal(record.report.inventory[0].replacementQuantity, 9);
  assert.equal(record.report.sheetRows[0].quantity_on_hand_at_import, 9);
  assert.doesNotMatch(JSON.stringify(record.report), /"variationNumber":100/);
  assert.equal(record.report.totals.unresolvedOrderCount, 2);
  assert.equal((await worker.presets()).total, null);
  assert.deepEqual(await h.open().report(ended.result.reportId), record);
});

test("preset promotion handles skipped and out-of-order capture, exceeds the preset cap, and protects captured mappings on reset", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create(200);
  await worker.assign(80);
  await worker.assign(30, "SYNTH-B");
  await worker.assign(120);
  await worker.bid(80);
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 30, observedPaymentStatus: "canceled" }] });
  await worker.map(80, "SYNTH-B");
  await worker.bid(1001);
  const before = await worker.state();
  assert.equal(auction(before, 30).sku, "SYNTH-B");
  assert.equal(auction(before, 80).sku, "SYNTH-B");
  assert.equal(auction(before, 1001).sku, null);
  await worker.reset();
  assert.deepEqual(await worker.state(), before);
  assert.equal((await worker.presets()).total, null);
  await worker.capture("observe_variations", { variationNumbers: [120] });
  assert.equal(auction(await worker.state(), 120).sku, null);
});

test("next-preset assignment clears the existing queue, rejects requeue, but allows mapping the real live item", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create();
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, "SYNTH-B");
  await worker.assign(2);
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
  assert.equal((await worker.raw("queue", { type: "toggle_queue", expectedStreamId: STREAM, expectedVariationNumber: 1, sku: "SYNTH-B" })).ok, false);
  await worker.queue("map_current", 1, "SYNTH-B");
  assert.equal(auction(await worker.state(), 1).sku, "SYNTH-B");
  await worker.bid(2);
  assert.equal(auction(await worker.state(), 2).sku, "SYNTH-A");
  await worker.bid(3);
  assert.equal(auction(await worker.state(), 3).sku, null, "cleared queue must not leak into a later variation");
});

test("an assigned skipped capture target takes priority over a generic queue and future range alone does not block queueing", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create();
  await worker.assign(10);
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  await worker.bid(10);
  assert.equal(auction(await worker.state(), 10).sku, "SYNTH-A");
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
  await worker.bid(11);
  assert.equal(auction(await worker.state(), 11).sku, null);
});

test("late capture of an older preset does not clear an unrelated queue armed for the next live variation", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(3);
  await worker.bid(10);
  await worker.map(10);
  await worker.queue("toggle_queue", 10, "SYNTH-B");
  await worker.capture("observe_payment_statuses", { statuses: [{ variationNumber: 3, observedPaymentStatus: "canceled" }] });
  assert.equal(auction(await worker.state(), 3).sku, "SYNTH-A");
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, "SYNTH-B");
  await worker.bid(11);
  assert.equal(auction(await worker.state(), 11).sku, "SYNTH-B");
});

test("advancing toward a preset consumes the queue for the intervening real variation before blocking the next one", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create();
  await worker.assign(3);
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  await worker.bid(2);
  assert.equal(auction(await worker.state(), 2).sku, "SYNTH-B", "the queue was for #2, not the preset #3");
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
  assert.equal((await worker.raw("queue", {
    type: "toggle_queue", expectedStreamId: STREAM, expectedVariationNumber: 2, sku: "SYNTH-B",
  })).ok, false);
  await worker.bid(3);
  assert.equal(auction(await worker.state(), 3).sku, "SYNTH-A");
});

test("a due queued mapping survives read repair after its save fails even when the following variation has a preset", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create();
  await worker.assign(3);
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  h.failNext(({ items }) => {
    const state = items?.[reconciliationStorage.STORAGE_KEY]?.reconciliationState;
    return state?.streams[0].variations.some((entry) => entry.variationNumber === 2 && entry.sku === "SYNTH-B");
  });
  const failed = await worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 2 }, DASHBOARD);
  assert.equal(failed.ok, false);
  assert.equal(h.failedWrites.length, 1);
  assert.equal(auction(await worker.state(), 2).sku, null);
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, "SYNTH-B",
    "read repair must not mistake the still-due queue for an assignment to preset #3");
  await worker.bid(2);
  const state = await worker.state();
  assert.equal(auction(state, 2).sku, "SYNTH-B");
  assert.equal(summary(state).inventory[1].reservedQuantity, 1);
  assert.equal((await worker.send("queue", { type: "get_queue" })).queuedSku, null);
  await worker.bid(3);
  assert.equal(auction(await worker.state(), 3).sku, "SYNTH-A");
});

test("a failed conflicting-queue clear preserves the saved preset and capture repairs it before applying any queued SKU", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.create();
  await worker.queue("toggle_queue", 1, "SYNTH-B");
  const before = await worker.presets();
  h.failNext(({ operation, keys }) => operation === "remove" && keys.includes(queueStorage.STORAGE_KEY));
  const result = await worker.raw("presets", {
    type: "set_preset_item", ...expected(before), variationNumber: 2, sku: "SYNTH-A",
  });
  assert.equal(result.ok, false);
  assert.equal(h.failedWrites.length, 1);
  assert.deepEqual(h.values[presetStorage.STORAGE_KEY].presets.assignments, [{ variationNumber: 2, sku: "SYNTH-A" }]);
  assert.ok(Object.hasOwn(h.sessionValues, queueStorage.STORAGE_KEY));
  const reopened = h.open();
  await reopened.bid(2);
  assert.equal(auction(await reopened.state(), 2).sku, "SYNTH-A");
  assert.equal((await reopened.send("queue", { type: "get_queue" })).queuedSku, null);
  await reopened.bid(3);
  assert.equal(auction(await reopened.state(), 3).sku, null);
});

test("capture and reset dispatched concurrently preserve only assignments captured before reset", async () => {
  for (const captureFirst of [true, false]) {
    const h = createHarness();
    const worker = h.open();
    await worker.create();
    await worker.assign(5);
    await worker.assign(6, "SYNTH-B");
    const snapshot = await worker.presets();
    const capture = () => worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 5 }, DASHBOARD);
    const reset = () => worker.raw("presets", { type: "reset_presets", ...expected(snapshot) });
    const responses = await Promise.all(captureFirst ? [capture(), reset()] : [reset(), capture()]);
    assert.equal(responses[captureFirst ? 0 : 1].ok, true);
    if (captureFirst) {
      // Promotion rotates the configuration revision; an old reset may ask
      // for review, but it cannot undo the already-persisted real mapping.
      if (!responses[1].ok) await worker.reset();
    } else assert.equal(responses[0].ok, true);
    assert.equal(auction(await worker.state(), 5).sku, captureFirst ? "SYNTH-A" : null);
    assert.equal((await worker.presets()).total, null);
    await worker.bid(6);
    assert.equal(auction(await worker.state(), 6).sku, null);
  }
});

test("a stale future edit racing real capture cannot replace the newly captured preset mapping", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(5);
  const snapshot = await worker.presets();
  const [captured, edited] = await Promise.all([
    worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 5 }, DASHBOARD),
    worker.raw("presets", { type: "set_preset_item", ...expected(snapshot), variationNumber: 5, sku: "SYNTH-B" }),
  ]);
  assert.equal(captured.ok, true);
  assert.equal(edited.ok, false);
  assert.equal(auction(await worker.state(), 5).sku, "SYNTH-A");
  assert.deepEqual((await worker.presets()).assignments, []);
});

test("stale create, edit, and reset requests cannot replace a newer preset generation", async () => {
  const h = createHarness();
  const worker = h.open();
  const beforeCreate = await worker.presets();
  await worker.create();
  const beforeEdit = await worker.presets();
  await worker.assign(80);
  const beforeReset = await worker.presets();
  await worker.reset();
  await worker.create(300);
  await worker.assign(90, "SYNTH-B");
  const after = await worker.presets();
  for (const command of [
    { type: "create_presets", ...expected(beforeCreate), total: 100 },
    { type: "set_preset_item", ...expected(beforeEdit), variationNumber: 80, sku: "SYNTH-B" },
    { type: "reset_presets", ...expected(beforeReset) },
  ]) assert.equal((await worker.raw("presets", command)).ok, false);
  assert.deepEqual(await worker.presets(), after);
  assert.deepEqual(await h.open().presets(), after);
});

test("failed create, edit, and reset persistence leave the previous authoritative preset state intact", async () => {
  const h = createHarness();
  const worker = h.open();
  async function rejectWrite(type, extra) {
    const before = await worker.presets();
    const canonical = await worker.state();
    h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
    const result = await worker.raw("presets", { type, ...expected(before), ...extra });
    assert.equal(result.ok, false);
    assert.deepEqual(await worker.presets(), before);
    assert.deepEqual(await worker.state(), canonical);
  }
  await rejectWrite("create_presets", { total: 200 });
  await worker.create();
  await worker.assign(80);
  await rejectWrite("set_preset_item", { variationNumber: 80, sku: "SYNTH-B" });
  await rejectWrite("reset_presets", {});
});

test("capture saved before a failed preset promotion is repaired on reopening before reset can discard its assignment", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(5);
  h.failNext(({ items }) => {
    const state = items?.[reconciliationStorage.STORAGE_KEY]?.reconciliationState;
    return state?.streams[0].variations.some((entry) => entry.variationNumber === 5 && entry.sku === "SYNTH-A");
  });
  await worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 5 }, DASHBOARD);
  const persisted = h.values[reconciliationStorage.STORAGE_KEY].reconciliationState;
  assert.equal(auction(persisted, 5).sku, null);
  assert.equal(h.values[presetStorage.STORAGE_KEY].presets.assignments[0].sku, "SYNTH-A");
  const reopened = h.open();
  const repaired = await reopened.state();
  assert.equal(auction(repaired, 5).sku, "SYNTH-A");
  assert.equal(summary(repaired).inventory[0].reservedQuantity, 1);
  await reopened.reset();
  assert.deepEqual(await reopened.state(), repaired);
});

test("a capture write that failed before persistence cannot restore its discarded assignment after reset and retry", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(5);
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, reconciliationStorage.STORAGE_KEY));
  assert.equal((await worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 5 }, DASHBOARD)).ok, false);
  assert.equal(summary(await worker.state()).totals.auctionCount, 0);
  assert.deepEqual((await worker.presets()).assignments, [{ variationNumber: 5, sku: "SYNTH-A" }]);
  await worker.reset();
  await worker.bid(5);
  assert.equal(auction(await worker.state(), 5).sku, null);
});

test("failed preset cleanup after successful canonical promotion does not remap a deliberate manual correction", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(5);
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
  await worker.raw("capture", { type: "payment_complete", variationNumber: 5, soldPriceCents: 2100 }, DASHBOARD);
  assert.equal(auction(h.values[reconciliationStorage.STORAGE_KEY].reconciliationState, 5).sku, "SYNTH-A");
  const reopened = h.open();
  await reopened.map(5, "SYNTH-B");
  assert.equal(auction(await reopened.state(), 5).sku, "SYNTH-B");
  await reopened.capture("payment_complete", { variationNumber: 5, soldPriceCents: 2100 });
  assert.equal(auction(await reopened.state(), 5).sku, "SYNTH-B");
  assert.equal(summary(await reopened.state()).inventory[0].soldQuantity, 0);
  assert.equal(summary(await reopened.state()).inventory[1].soldQuantity, 1);
});

test("read repair after failed preset cleanup refreshes retained live identity and cost so later bid prices are accepted", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.bid(1);
  await worker.map(1);
  await worker.capture("observe_bidding_price", { variationNumber: 1, bidPriceCents: 100 });
  const initialLive = (await worker.send("live", { type: "get_live_bid" })).liveAuction;
  assert.equal(initialLive.variationNumber, 1);
  assert.equal(initialLive.bidPriceCents, 100);
  await worker.create();
  await worker.assign(5, "SYNTH-B");
  h.failNext(({ items }) => Object.hasOwn(items ?? {}, presetStorage.STORAGE_KEY));
  const failed = await worker.raw("capture", { type: "observe_bidding_variation", variationNumber: 5 }, DASHBOARD);
  assert.equal(failed.ok, false);
  assert.equal(h.failedWrites.length, 1);
  const repaired = await worker.state();
  assert.equal(auction(repaired, 5).sku, "SYNTH-B");
  const live = (await worker.send("live", { type: "get_live_bid" })).liveAuction;
  assert.equal(live.variationNumber, 5);
  assert.equal(live.unitCostCents, 900);
  assert.equal(live.bidPriceCents, null, "the preceding variation's bid must not follow the new one");
  await worker.capture("observe_bidding_price", { variationNumber: 5, bidPriceCents: 700 });
  const updatedLive = (await worker.send("live", { type: "get_live_bid" })).liveAuction;
  assert.equal(updatedLive.variationNumber, 5);
  assert.equal(updatedLive.unitCostCents, 900);
  assert.equal(updatedLive.bidPriceCents, 700);
  assert.deepEqual(await worker.state(), repaired, "live bid prices remain transient, not canonical orders");
});

test("failed End retains presets; successful End and a new stream never inherit unused assignments", async () => {
  for (const failedKey of [reportStorage.STORAGE_KEY, sessionStorage.STORAGE_KEY]) {
    const h = createHarness();
    const worker = h.open();
    await worker.create();
    await worker.assign(80);
    const saved = await worker.presets();
    h.failNext(({ items }) => Object.hasOwn(items ?? {}, failedKey));
    assert.equal((await worker.raw("session", { type: "end_stream", streamId: STREAM })).ok, false, failedKey);
    assert.equal(h.failedWrites.length, 1);
    assert.deepEqual(await worker.presets(), saved);
    assert.equal(h.values[sessionStorage.STORAGE_KEY].sessionState.activeSession.streamId, STREAM);
    const ended = await worker.end();
    const reportBefore = await worker.report(ended.result.reportId);
    assert.equal((await worker.presets()).total, null);
    const next = await worker.send("session", { type: "start_stream" });
    assert.notEqual(next.state.activeSession.streamId, STREAM);
    const nextPresets = await worker.presets();
    assert.equal(nextPresets.streamId, next.state.activeSession.streamId);
    assert.equal(nextPresets.total, null);
    assert.deepEqual(nextPresets.assignments, []);
    assert.deepEqual(await worker.report(ended.result.reportId), reportBefore);
  }
});

test("preset cleanup failure cannot turn a successful End into a failure or leak presets into another stream", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(80);
  h.failNext(({ operation, keys }) => operation === "remove" && keys.includes(presetStorage.STORAGE_KEY));
  const ended = await worker.end();
  assert.equal(h.failedWrites.length, 1, "the preset cleanup removal was actually attempted and failed");
  assert.equal(h.values[sessionStorage.STORAGE_KEY].sessionState.activeSession, null);
  assert.equal((await worker.report(ended.result.reportId)).lifecycleStatus, "finalized");
  const reopened = h.open();
  assert.equal((await reopened.presets()).total, null);
  await reopened.send("session", { type: "start_stream" });
  assert.deepEqual((await reopened.presets()).assignments, []);
});

test("a changed inventory baseline cannot adopt old preset assignments or authorize stale edits", async () => {
  const h = createHarness();
  const worker = h.open();
  await worker.create();
  await worker.assign(80);
  const old = await worker.presets();
  // Model the existing append-only import operation with a synthetic baseline;
  // no Sheets request or credentials are involved in this isolated fixture.
  const updated = clone(h.values[reconciliationStorage.STORAGE_KEY].reconciliationState);
  const nextBaseline = "inventory-baseline:22222222-2222-4222-8222-222222222222";
  reconciliation.extendStreamInventoryBaseline(updated, {
    streamId: STREAM, expectedBaselineId: BASELINE, baselineId: nextBaseline,
    sourceFingerprint: "fnv1a64:2222222222222222",
    inventory: [...updated.inventoryBaselines[0].inventory,
      { sku: "SYNTH-C", item: "Synthetic", style: "Cap", size: "OS", quantityOnHandAtImport: 2, unitCostCents: 300 }],
  });
  h.values[reconciliationStorage.STORAGE_KEY].reconciliationState = updated;
  const reopened = h.open();
  const current = await reopened.presets();
  assert.equal(current.baselineId, nextBaseline);
  assert.equal(current.total, null);
  assert.deepEqual(current.assignments, []);
  assert.equal((await reopened.raw("presets", {
    type: "set_preset_item", ...expected(old), variationNumber: 80, sku: "SYNTH-B",
  })).ok, false);
  await reopened.bid(80);
  assert.equal(auction(await reopened.state(), 80).sku, null);
});
