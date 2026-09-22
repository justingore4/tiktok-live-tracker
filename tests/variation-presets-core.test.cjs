const assert = require("node:assert/strict");
const test = require("node:test");
const protocol = require("../extension/shared/variation-presets-protocol.js");
const storage = require("../extension/shared/variation-presets-storage.js");
const coordinatorModule = require("../extension/shared/variation-presets-coordinator.js");
const clientModule = require("../extension/tagger/variation-presets-client.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const canonicalModule = require("../extension/shared/reconciliation-coordinator.js");
const streamReport = require("../extension/shared/stream-report.js");

const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const OTHER_STREAM = "local-stream:22222222-2222-4222-8222-222222222222";
const REVISION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVENTORY = [
  { sku: "LA-M", item: "LA", style: "hoodie", size: "M", quantityReceived: 10, unitCostCents: 900 },
  { sku: "TEE-OS", item: "Tee", style: "", size: "OS", quantityReceived: 4, unitCostCents: 500 },
];
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const inactive = { streamId: null, baselineId: null, revision: null, total: null, assignments: [] };
function memoryStore() {
  const values = {};
  const writes = [];
  let failure = null;
  return {
    values, writes,
    failNext(method) { failure = method; },
    storageArea: {
      async get(key) {
        if (failure === "get") { failure = null; throw new Error("Synthetic read failure"); }
        return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
      },
      async set(value) {
        if (failure === "set") { failure = null; throw new Error("Synthetic write failure"); }
        writes.push(clone(value));
        Object.assign(values, clone(value));
      },
      async remove(key) {
        if (failure === "remove") { failure = null; throw new Error("Synthetic remove failure"); }
        delete values[key];
      },
    },
  };
}
function harness({ state: initial, noCapture = false } = {}) {
  let state = initial === undefined ? reconciliation.createReconciliationState(INVENTORY) : clone(initial);
  if (initial === undefined) {
    reconciliation.pinStreamToInventoryBaseline(state, { streamId: STREAM });
    if (!noCapture) reconciliation.observeBiddingVariation(state, { streamId: STREAM, variationNumber: 3 });
  }
  const memory = memoryStore();
  const presetStore = storage.createVariationPresetsStore({ storageArea: memory.storageArea, protocol });
  const notices = [];
  const queueClears = [];
  const queueIntents = [];
  const canonicalWrites = [];
  let activeStreamId = STREAM;
  let mapFailure = false;
  let queueFailure = false;
  let revisionCount = 0;
  let queuedSku = "TEE-OS";
  const stateCoordinator = canonicalModule.createReconciliationCoordinator({
    reconciliation,
    stateStore: {
      async loadState() { return clone(state); },
      async saveState(value) {
        if (mapFailure) { mapFailure = false; throw new Error("Synthetic canonical save failure"); }
        canonicalWrites.push(clone(value));
        state = clone(value);
      },
    },
  });
  const options = {
    activeStreamCoordinator: { async dispatch() { return { state: { activeSession: activeStreamId ? { streamId: activeStreamId } : null } }; } },
    streamSession: { hydrateStreamSessionState: clone },
    streamSessionCoordinator: { COMMAND_TYPES: { GET_STREAM_SESSION: "get_stream_session" } },
    stateCoordinator, reconciliation, reconciliationCoordinator: canonicalModule, protocol, presetStore,
    createRevision: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++revisionCount).padStart(12, "0")}`,
    clearConflictingQueue: async (streamId, intent) => {
      if (queueFailure) { queueFailure = false; throw new Error("Synthetic queue clear failure"); }
      queueClears.push(streamId);
      queueIntents.push(clone(intent));
      queuedSku = null;
    },
    onChange: (event) => notices.push(event),
  };
  let coordinator = coordinatorModule.createVariationPresetsCoordinator(options);
  const runtime = {
    async sendMessage(message) {
      try { return { ok: true, data: await coordinator.dispatch(protocol.validateMessage(message)) }; }
      catch (error) { return { ok: false, error: { code: error.code ?? "SYNTHETIC_FAILURE", message: error.message } }; }
    },
  };
  const client = clientModule.createVariationPresetsClient({ protocol, runtime });
  async function snapshot() { return client.getPresets(); }
  function expected(value) { return { expectedStreamId: value.streamId, expectedBaselineId: value.baselineId, expectedRevision: value.revision }; }
  async function create(total = 200) { return client.createPresets({ ...expected(await snapshot()), total }); }
  async function assign(variationNumber, sku = "LA-M") {
    return client.setPresetItem({ ...expected(await snapshot()), variationNumber, sku });
  }
  async function assignNext(variationNumber, sku = "LA-M", value) {
    return client.assignNextPresetItem({ ...expected(value ?? await snapshot()), variationNumber, sku });
  }
  async function reset(value) { return client.resetPresets(expected(value ?? await snapshot())); }
  async function capture(variationNumber, status = "bidding") {
    let command;
    if (status === "bidding") command = { type: "observe_bidding_variation", streamId: activeStreamId, variationNumber };
    else if (status === "payment_complete") command = { type: "record_payment_complete", streamId: activeStreamId, variationNumber, soldPriceCents: 2300 };
    else command = { type: "observe_payment_statuses", streamId: activeStreamId, statuses: [{ variationNumber, observedPaymentStatus: status }] };
    return (await stateCoordinator.dispatch(command)).state;
  }
  async function synchronize(inputState = state) { return coordinator.synchronize({ streamId: activeStreamId, state: inputState }); }
  async function preserveReadiness(streamId = activeStreamId) { return coordinator.preserveExtensionAvailability(streamId); }
  return {
    memory, presetStore, client, options, notices, queueClears, queueIntents, canonicalWrites,
    expected, snapshot, create, assign, assignNext, reset, capture, synchronize, preserveReadiness, stateCoordinator,
    getState: () => clone(state), getQueue: () => queuedSku,
    setQueue: (sku) => { queuedSku = sku; },
    restart: () => { coordinator = coordinatorModule.createVariationPresetsCoordinator(options); },
    failMap: () => { mapFailure = true; }, failQueue: () => { queueFailure = true; },
    activate: (streamId) => { activeStreamId = streamId; },
  };
}
function report(state) {
  return streamReport.createStreamReport({
    reconciliation, reconciliationState: state, streamId: STREAM,
    startedAt: "2026-09-14T00:00:00.000Z", endedAt: "2026-09-14T01:00:00.000Z", generatedAt: "2026-09-14T01:00:01.000Z",
  });
}
function storedRecord(overrides = {}) {
  return { streamId: STREAM, baselineId: "synthetic-baseline", revision: REVISION, total: 200, assignments: [], ...overrides };
}

test("preset protocol has a preset-only 1000 limit and strict detached messages", () => {
  assert.equal(protocol.MAX_PRESET_VARIATIONS, 1000);
  const command = { type: "create_presets", expectedStreamId: STREAM, expectedBaselineId: "base", expectedRevision: null, total: 200 };
  const message = protocol.createMessage(command);
  command.total = 500;
  assert.equal(protocol.validateMessage(message).total, 200);
  const notification = protocol.createPresetsChangedNotification();
  assert.equal(protocol.isPresetsChangedNotification(notification), true);
  assert.equal(protocol.isPresetsChangedNotification({ ...notification, extra: true }), false);
  for (const type of ["__proto__", "toString", "constructor", "unknown"]) {
    assert.throws(() => protocol.validateCommand({ type }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  }
  assert.throws(() => protocol.validateMessage({ ...message, version: 2 }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  assert.throws(() => protocol.validateCommand({ type: "get_presets", storageKey: "other" }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
});

test("invalid totals and identities fail before sending a request", async () => {
  const h = harness();
  const expected = h.expected(await h.snapshot());
  for (const total of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1001, "200", "1e2", null]) {
    await assert.rejects(h.client.createPresets({ ...expected, total }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  }
  await assert.rejects(h.client.createPresets({ ...expected, expectedStreamId: " stream ", total: 200 }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  assert.equal(h.memory.writes.length, 0);
});

test("queued-preset clear protocol accepts only an exact next target and a live-only clear guard", () => {
  const command = {
    type: "set_preset_item", expectedStreamId: STREAM, expectedBaselineId: "base",
    expectedRevision: REVISION, variationNumber: 4, sku: null,
    expectedActiveBiddingVariationNumber: 3,
  };
  assert.deepEqual(protocol.validateMessage(protocol.createMessage(command)), command);
  const { expectedActiveBiddingVariationNumber: _live, ...ordinary } = command;
  assert.deepEqual(protocol.validateCommand(ordinary), ordinary, "ordinary preset edits retain their original command shape");
  for (const invalid of [
    { ...command, sku: "LA-M" },
    { ...command, type: "assign_next_preset_item", sku: "LA-M" },
    { ...command, variationNumber: 5 },
    { ...command, extra: true },
    ...[null, undefined, 0, -1, 2.5, "3", Infinity, Number.MAX_SAFE_INTEGER + 1]
      .map((value) => ({ ...command, expectedActiveBiddingVariationNumber: value })),
  ]) {
    assert.throws(() => protocol.validateCommand(invalid), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  }
});

test("pre-stream queued-preset clear protocol requires one exclusive clear-only source guard", () => {
  const command = {
    type: "set_preset_item", expectedStreamId: STREAM, expectedBaselineId: "base",
    expectedRevision: REVISION, variationNumber: 4, sku: null,
    expectedPrestreamVariationNumber: 3,
  };
  assert.deepEqual(protocol.validateMessage(protocol.createMessage(command)), command);
  for (const invalid of [
    { ...command, sku: "LA-M" },
    { ...command, type: "assign_next_preset_item", sku: "LA-M" },
    { ...command, expectedActiveBiddingVariationNumber: 3 },
    { ...command, variationNumber: 5 },
    { ...command, variationNumber: 1001, expectedPrestreamVariationNumber: 1000 },
    ...[null, undefined, 0, -1, 2.5, "3", Infinity, Number.MAX_SAFE_INTEGER + 1, 1001]
      .map((value) => ({ ...command, expectedPrestreamVariationNumber: value })),
  ]) assert.throws(() => protocol.validateCommand(invalid), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  for (const type of ["get_presets", "create_presets", "reset_presets"]) {
    assert.throws(() => protocol.validateCommand({ ...command, type }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  }
});

test("strict preset snapshots reject duplicate, unordered, out-of-range and disabled assignments", () => {
  protocol.validateSnapshot(inactive);
  protocol.validateSnapshot(storedRecord({ total: null }));
  for (const value of [
    storedRecord({ revision: null }),
    storedRecord({ total: null, assignments: [{ variationNumber: 1, sku: "LA-M" }] }),
    storedRecord({ assignments: [{ variationNumber: 201, sku: "LA-M" }] }),
    storedRecord({ assignments: [{ variationNumber: 1, sku: " LA-M" }] }),
    storedRecord({ assignments: [{ variationNumber: 1, sku: "LA-M", extra: true }] }),
    storedRecord({ assignments: [{ variationNumber: 2, sku: "LA-M" }, { variationNumber: 2, sku: "TEE-OS" }] }),
    storedRecord({ assignments: [{ variationNumber: 2, sku: "LA-M" }, { variationNumber: 1, sku: "TEE-OS" }] }),
    { ...inactive, total: 200 },
  ]) assert.throws(() => protocol.validateSnapshot(value), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
});

test("separate storage validates version, round-trips exact SKUs and preserves unrelated keys", async () => {
  const memory = memoryStore();
  memory.values["existing-tracker-state"] = { protected: true };
  const store = storage.createVariationPresetsStore({ storageArea: memory.storageArea, protocol });
  assert.equal(await store.loadPresets(), null);
  const value = storedRecord({ assignments: [{ variationNumber: 7, sku: "Exact-SKU" }] });
  const saved = await store.savePresets(value);
  value.assignments[0].sku = "changed";
  assert.equal(saved.assignments[0].sku, "Exact-SKU");
  assert.deepEqual(await store.loadPresets(), saved);
  memory.values[storage.STORAGE_KEY].schemaVersion = 2;
  await assert.rejects(store.loadPresets(), { code: "INVALID_VARIATION_PRESETS_STORAGE" });
  assert.deepEqual(memory.values["existing-tracker-state"], { protected: true });
  await store.clearPresets();
  assert.deepEqual(memory.values, { "existing-tracker-state": { protected: true } });
});

test("storage errors are clear and do not replace a previously valid preset record", async () => {
  const h = harness();
  const saved = await h.create();
  h.memory.failNext("set");
  await assert.rejects(h.assign(80), /Could not save variation presets/);
  assert.deepEqual(await h.snapshot(), saved);
  h.memory.failNext("get");
  await assert.rejects(h.snapshot(), /Could not read saved variation presets/);
  assert.deepEqual(await h.snapshot(), saved);
});

test("creating a 200 range preserves earlier canonical records without phantom variations", async () => {
  const h = harness();
  const before = h.getState();
  const beforeReport = report(before);
  const value = await h.create(200);
  assert.equal(value.total, 200);
  assert.deepEqual(value.assignments, []);
  assert.deepEqual(h.getState(), before);
  assert.deepEqual(report(h.getState()), beforeReport);
  assert.equal(h.canonicalWrites.length, 0);
});

test("totals below highest captured variation are rejected even when live number is lower", async () => {
  const h = harness();
  await h.capture(30, "canceled");
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, 3);
  await assert.rejects(h.create(29), { code: "PRESET_TOTAL_BELOW_CAPTURED" });
  assert.equal((await h.create(30)).total, 30);
});

test("a within-range total cannot change until reset, and reset tombstones prevent delayed ABA edits", async () => {
  const h = harness();
  const first = await h.create();
  await assert.rejects(h.create(400), { code: "PRESETS_ALREADY_ENABLED" });
  const disabled = await h.reset();
  assert.equal(disabled.total, null);
  assert.notEqual(disabled.revision, first.revision);
  const replacement = await h.create(80);
  await assert.rejects(h.reset(first), { code: "PRESETS_CHANGED" });
  await assert.rejects(h.client.setPresetItem({ ...h.expected(first), variationNumber: 10, sku: "LA-M" }), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), replacement);
});

test("future assignments change only preset state, allow repeated SKU plans, and unassign cleanly", async () => {
  const h = harness();
  await h.create();
  const before = h.getState();
  const exported = streamReport.serializeInventoryCsv(report(before));
  await h.assign(80);
  await h.assign(100);
  const assigned = await h.assign(50, "TEE-OS");
  assert.deepEqual(assigned.assignments, [
    { variationNumber: 50, sku: "TEE-OS" }, { variationNumber: 80, sku: "LA-M" }, { variationNumber: 100, sku: "LA-M" },
  ]);
  assert.deepEqual(h.getState(), before);
  assert.equal(streamReport.serializeInventoryCsv(report(h.getState())), exported);
  assert.deepEqual(reconciliation.listPaymentFixingOrders(h.getState(), { streamId: STREAM }), []);
  const noticesBefore = h.notices.length;
  assert.deepEqual(await h.assign(80), assigned);
  assert.equal(h.notices.length, noticesBefore, "no-op plans and GETs do not cause notification loops");
  assert.equal((await h.assign(80, null)).assignments.length, 2);
});

test("assignment rejects captured targets, unknown SKUs, outside-range targets and stale revisions", async () => {
  const h = harness();
  const value = await h.create(20);
  await assert.rejects(h.assign(3), { code: "VARIATION_ALREADY_CAPTURED" });
  await assert.rejects(h.assign(21), { code: "OUTSIDE_PRESET_RANGE" });
  await assert.rejects(h.assign(10, "missing"), { code: "UNKNOWN_SKU" });
  await h.assign(10);
  await assert.rejects(h.client.setPresetItem({ ...h.expected(value), variationNumber: 11, sku: "TEE-OS" }), { code: "PRESETS_CHANGED" });
});

for (const status of ["bidding", "payment_processing", "payment_complete", "canceled"]) {
  test(`captured ${status} promotes a planned SKU through real persisted reconciliation exactly once`, async () => {
    const h = harness();
    await h.create();
    await h.assign(25);
    const beforeCapture = h.getState();
    await h.capture(25, status);
    const captured = h.getState();
    const expected = clone(captured);
    reconciliation.mapVariation(expected, { streamId: STREAM, variationNumber: 25, sku: "LA-M" });
    const result = await h.synchronize(beforeCapture); // stale caller state is never used to erase the real capture
    assert.deepEqual(result.state, expected);
    assert.equal(result.changed, true);
    const writes = h.canonicalWrites.length;
    assert.equal((await h.synchronize()).changed, false);
    assert.equal(h.canonicalWrites.length, writes);
    assert.deepEqual((await h.snapshot()).assignments, []);
    const availability = reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" });
    assert.equal(availability.reservedQuantity, ["bidding", "payment_processing"].includes(status) ? 1 : 0);
    assert.equal(availability.soldQuantity, status === "payment_complete" ? 1 : 0);
    const summary = reconciliation.calculateSummary(h.getState(), { streamId: STREAM });
    assert.equal(summary.totals.costOfGoodsCents, status === "payment_complete" ? 900 : 0);
    assert.equal(summary.totals.profitCents, status === "payment_complete" ? 1400 : 0);
    assert.deepEqual(report(h.getState()), report(expected));
    assert.equal(streamReport.serializeInventoryCsv(report(h.getState())), streamReport.serializeInventoryCsv(report(expected)));
    assert.equal(h.notices.some((event) => event.canonicalChanged), true);
  });
}

test("skipped and out-of-order captures promote only actual entries and never overwrite existing mappings", async () => {
  const h = harness();
  await h.create();
  await h.assign(4);
  await h.assign(80);
  await h.assign(81);
  await h.capture(80);
  await h.stateCoordinator.dispatch({ type: "map_variation", streamId: STREAM, variationNumber: 80, sku: "TEE-OS" });
  await h.synchronize();
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "TEE-OS");
  assert.deepEqual((await h.snapshot()).assignments.map((entry) => entry.variationNumber), [4, 81]);
  await h.capture(4, "canceled");
  await h.synchronize();
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 4 }).sku, "LA-M");
  assert.deepEqual((await h.snapshot()).assignments.map((entry) => entry.variationNumber), [81]);
});

test("capture beyond the preset-only maximum remains normal and is not capped", async () => {
  const h = harness();
  await h.create(1000);
  await h.capture(5000);
  await h.synchronize();
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, 5000);
  assert.equal((await h.snapshot()).total, 1000);
});

test("next assignment clears a preexisting queue but farther plans do not", async () => {
  const h = harness();
  await h.create();
  await h.assign(80);
  assert.equal(h.getQueue(), "TEE-OS");
  await h.assign(4);
  assert.equal(h.getQueue(), null);
  assert.deepEqual(h.queueClears, [STREAM]);
});

test("guarded upcoming-preset clear removes only its assignment and rejects duplicate delivery", async () => {
  const h = harness();
  await h.create(20);
  await h.assign(4);
  const displayed = await h.assign(5, "TEE-OS");
  const canonical = h.getState();
  const beforeReport = report(canonical);
  const command = {
    ...h.expected(displayed), variationNumber: 4, sku: null,
    expectedActiveBiddingVariationNumber: 3,
  };
  const cleared = await h.client.setPresetItem(command);
  assert.equal(cleared.total, 20, "the empty #4 placeholder remains in the range");
  assert.deepEqual(cleared.assignments, [{ variationNumber: 5, sku: "TEE-OS" }]);
  assert.notEqual(cleared.revision, displayed.revision);
  assert.deepEqual(h.getState(), canonical);
  assert.deepEqual(report(h.getState()), beforeReport);
  assert.equal(h.canonicalWrites.length, 0);
  await assert.rejects(h.client.setPresetItem(command), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), cleared);
});

test("queued-preset clear rejects live advancement or completion even if its revision and target remain uncaptured", async () => {
  for (const status of ["skip", "payment_processing", "payment_complete", "canceled"]) {
    const h = harness();
    await h.create();
    const displayed = await h.assign(4);
    if (status === "skip") await h.capture(8);
    else await h.capture(3, status);
    assert.equal(h.getState().streams[0].variations.some((entry) => entry.variationNumber === 4), false);
    assert.notEqual(h.getState().streams[0].activeBiddingVariationNumber, 3);
    const writes = h.memory.writes.length;
    await assert.rejects(h.client.setPresetItem({
      ...h.expected(displayed), variationNumber: 4, sku: null,
      expectedActiveBiddingVariationNumber: 3,
    }), { code: "PRESET_LIVE_VARIATION_CHANGED" }, status);
    assert.deepEqual(await h.snapshot(), displayed, "no fallback to highest captured number can authorize the clear");
    assert.equal(h.memory.writes.length, writes);
  }
});

test("guarded clear retains the saved assignment after persistence failure and replacement rejects the stale click", async () => {
  const h = harness();
  await h.create();
  const displayed = await h.assign(4);
  const command = {
    ...h.expected(displayed), variationNumber: 4, sku: null,
    expectedActiveBiddingVariationNumber: 3,
  };
  h.memory.failNext("set");
  await assert.rejects(h.client.setPresetItem(command), /Could not save variation presets/);
  assert.deepEqual(await h.snapshot(), displayed);
  const replacement = await h.assign(4, "TEE-OS");
  await assert.rejects(h.client.setPresetItem(command), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), replacement);
  assert.equal(h.getState().streams[0].variations.some((entry) => entry.variationNumber === 4), false);
});

test("pre-stream clear preserves its source, all other plans, range, canonical accounting, and unrelated queue", async () => {
  const h = harness({ noCapture: true });
  await h.create(20);
  await h.assign(3);
  await h.assign(4, "TEE-OS");
  const displayed = await h.assign(8);
  const canonical = h.getState();
  const beforeReport = report(canonical);
  const queue = h.getQueue();
  const command = {
    ...h.expected(displayed), variationNumber: 4, sku: null, expectedPrestreamVariationNumber: 3,
  };
  const cleared = await h.client.setPresetItem(command);
  assert.equal(cleared.total, 20);
  assert.deepEqual(cleared.assignments, [{ variationNumber: 3, sku: "LA-M" }, { variationNumber: 8, sku: "LA-M" }]);
  assert.deepEqual(h.getState(), canonical);
  assert.deepEqual(report(h.getState()), beforeReport);
  assert.equal(h.getQueue(), queue);
  assert.equal(h.canonicalWrites.length, 0);
  await assert.rejects(h.client.setPresetItem(command), { code: "PRESETS_CHANGED" });
  h.restart();
  assert.deepEqual(await h.snapshot(), cleared);
});

test("pre-stream clear requires zero actual captures even after bidding stops or capture arrives elsewhere", async () => {
  for (const status of ["bidding", "payment_processing", "payment_complete", "canceled", "completed-after-bidding"]) {
    const h = harness({ noCapture: true });
    await h.create();
    const displayed = await h.assign(4);
    if (status === "completed-after-bidding") {
      await h.capture(9);
      await h.capture(9, "payment_complete");
    } else await h.capture(9, status);
    assert.notEqual(h.getState().streams[0].variations.length, 0);
    if (status !== "bidding") assert.equal(h.getState().streams[0].activeBiddingVariationNumber, null);
    const canonical = h.getState();
    const writes = h.memory.writes.length;
    await assert.rejects(h.client.setPresetItem({
      ...h.expected(displayed), variationNumber: 4, sku: null, expectedPrestreamVariationNumber: 3,
    }), { code: "PRESET_PRESTREAM_CONTEXT_CHANGED" }, status);
    assert.deepEqual(await h.snapshot(), displayed);
    assert.deepEqual(h.getState(), canonical);
    assert.equal(h.memory.writes.length, writes);
  }
});

test("pre-stream clear revalidates enabled source/target range and preserves plans after save failure or replacement", async () => {
  const h = harness({ noCapture: true });
  const enabled = await h.create(3);
  await assert.rejects(h.client.setPresetItem({
    ...h.expected(enabled), variationNumber: 4, sku: null, expectedPrestreamVariationNumber: 3,
  }), { code: "PRESET_PRESTREAM_CONTEXT_CHANGED" });
  const displayed = await h.assign(2);
  const command = {
    ...h.expected(displayed), variationNumber: 2, sku: null, expectedPrestreamVariationNumber: 1,
  };
  h.memory.failNext("set");
  await assert.rejects(h.client.setPresetItem(command), /Could not save variation presets/);
  assert.deepEqual(await h.snapshot(), displayed);
  const replacement = await h.assign(2, "TEE-OS");
  await assert.rejects(h.client.setPresetItem(command), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), replacement);
  const disabled = await h.reset();
  await assert.rejects(h.client.setPresetItem({ ...command, ...h.expected(disabled) }),
    { code: "PRESET_PRESTREAM_CONTEXT_CHANGED" });
  assert.deepEqual(await h.snapshot(), disabled);
});

test("live advancement to a planned next item and a skipped captured target clear conflicting queues", async () => {
  const h = harness();
  await h.create();
  await h.assign(80);
  await h.capture(79);
  await h.synchronize();
  assert.equal(h.getQueue(), null);
  h.setQueue("TEE-OS");
  await h.capture(80);
  await h.synchronize();
  assert.equal(h.getQueue(), null);
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "LA-M");
});

test("pre-bidding repair defers only next-variation clearing until the current queue can be consumed", async () => {
  const h = harness();
  await h.create();
  await h.assign(5);
  await h.capture(4);
  const coordinator = coordinatorModule.createVariationPresetsCoordinator(h.options);
  await coordinator.synchronize({ streamId: STREAM, state: h.getState(), deferNextQueueClear: true });
  assert.equal(h.getQueue(), "TEE-OS", "queue for newly bidding #4 must remain until its normal consumer runs");
  assert.deepEqual(h.queueIntents, []);
  await coordinator.synchronize({ streamId: STREAM, state: h.getState() });
  assert.deepEqual(h.queueIntents, [{ capturedVariationNumbers: [], blockNext: true, currentVariationNumber: 4 }]);
});

test("captured-plan queue intent identifies exact targets so backfilled history need not erase an unrelated live queue", async () => {
  const h = harness();
  await h.create();
  await h.assign(10);
  await h.capture(22);
  await h.capture(10, "canceled");
  await h.synchronize();
  assert.deepEqual(h.queueIntents, [{ capturedVariationNumbers: [10], blockNext: false, currentVariationNumber: 22 }]);
  const coordinator = coordinatorModule.createVariationPresetsCoordinator(h.options);
  await assert.rejects(coordinator.synchronize({ streamId: STREAM, state: h.getState(), deferNextQueueClear: "yes" }), { code: "INVALID_ARGUMENT" });
});

test("preset save failure does not clear queue; clear failure keeps the durable plan for read repair", async () => {
  const h = harness();
  await h.create();
  h.memory.failNext("set");
  await assert.rejects(h.assign(4), /Could not save variation presets/);
  assert.equal(h.getQueue(), "TEE-OS");
  h.failQueue();
  await assert.rejects(h.assign(4), /queue clear failure/);
  assert.equal((await h.presetStore.loadPresets()).assignments[0].sku, "LA-M");
  assert.equal(h.getQueue(), "TEE-OS");
  await h.snapshot();
  assert.equal(h.getQueue(), null);
});

test("reset removes only uncaptured plans, preserves mappings and returns a disabled durable generation", async () => {
  const h = harness();
  await h.create();
  await h.assign(30);
  await h.assign(80);
  await h.capture(30, "payment_complete");
  await h.synchronize();
  const before = h.getState();
  const disabled = await h.reset();
  assert.equal(disabled.total, null);
  assert.deepEqual(disabled.assignments, []);
  assert.deepEqual(h.getState(), before);
  h.restart();
  assert.deepEqual(await h.snapshot(), disabled);
  await h.capture(80);
  await h.synchronize();
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, null);
});

test("a capture between read and reset is promoted first; stale reset must refresh instead of deleting it", async () => {
  const h = harness();
  await h.create();
  const before = await h.assign(80);
  await h.capture(80, "canceled");
  await assert.rejects(h.reset(before), { code: "PRESETS_CHANGED" });
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "LA-M");
  await h.reset();
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "LA-M");
});

test("failed reset preserves all saved future assignments", async () => {
  const h = harness();
  await h.create();
  const before = await h.assign(80);
  h.memory.failNext("set");
  await assert.rejects(h.reset(before), /Could not save variation presets/);
  assert.deepEqual(await h.snapshot(), before);
});

test("failed canonical mapping retains capture and plan and retries after reopening", async () => {
  const h = harness();
  await h.create();
  await h.assign(80);
  await h.capture(80, "payment_complete");
  const captured = h.getState();
  h.failMap();
  await assert.rejects(h.synchronize(), /canonical save failure/);
  assert.deepEqual(h.getState(), captured);
  assert.equal((await h.presetStore.loadPresets()).assignments.length, 1);
  h.restart();
  assert.deepEqual((await h.snapshot()).assignments, []);
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "LA-M");
});

test("failed plan cleanup after durable mapping cannot duplicate deductions on retry", async () => {
  const h = harness();
  await h.create();
  await h.assign(80);
  await h.capture(80, "payment_complete");
  h.memory.failNext("set");
  await assert.rejects(h.synchronize(), /Could not save variation presets/);
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "LA-M");
  assert.equal(h.notices.some((entry) => entry.canonicalChanged), true);
  const writes = h.canonicalWrites.length;
  h.restart();
  await h.snapshot();
  assert.equal(h.canonicalWrites.length, writes);
  assert.deepEqual((await h.snapshot()).assignments, []);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" }).soldQuantity, 1);
});

test("separate presets persist across worker restart and are hidden from other streams/baselines", async () => {
  const h = harness();
  await h.create();
  const original = await h.assign(80);
  h.restart();
  assert.deepEqual(await h.snapshot(), original);
  await h.stateCoordinator.dispatch({ type: "pin_stream_to_inventory_baseline", streamId: OTHER_STREAM });
  h.activate(OTHER_STREAM);
  const other = await h.snapshot();
  assert.equal(other.streamId, OTHER_STREAM);
  assert.equal(other.total, null);
  assert.deepEqual(other.assignments, []);
  assert.deepEqual(await h.presetStore.loadPresets(), original, "merely reading another stream does not delete saved data");
  h.activate(STREAM);
  const saved = await h.presetStore.loadPresets();
  await h.presetStore.savePresets({ ...saved, baselineId: "another-baseline" });
  assert.equal((await h.snapshot()).total, null);
});

test("initial and inactive streams expose no phantom preset identity and reject mutations", async () => {
  const h = harness({ state: null });
  assert.deepEqual(await h.snapshot(), inactive);
  await assert.rejects(h.client.createPresets({ expectedStreamId: STREAM, expectedBaselineId: "base", expectedRevision: null, total: 200 }), { code: "NO_ACTIVE_STREAM" });
  const noStream = harness({ state: reconciliation.createReconciliationState(INVENTORY) });
  assert.deepEqual(await noStream.snapshot(), inactive);
  const active = harness();
  await active.create();
  const saved = await active.presetStore.loadPresets();
  active.activate(null);
  assert.deepEqual(await active.snapshot(), inactive);
  assert.deepEqual(await active.presetStore.loadPresets(), saved);
});

test("a newly started pinned stream with no captured variations can preset without inventing live activity", async () => {
  const h = harness({ noCapture: true });
  await h.create();
  await h.assign(1);
  assert.deepEqual(h.getState().streams[0].variations, []);
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, null);
});

test("cleanup is scoped to its ended stream and failure cannot delete a newer stream's plan", async () => {
  const h = harness();
  await h.create();
  const coordinator = coordinatorModule.createVariationPresetsCoordinator(h.options);
  assert.deepEqual(await coordinator.clearForStream(OTHER_STREAM), { status: "unchanged" });
  h.memory.failNext("remove");
  assert.deepEqual(await coordinator.clearForStream(STREAM), { status: "unavailable" });
  assert.equal((await h.snapshot()).total, 200);
  assert.deepEqual(await coordinator.clearForStream(STREAM), { status: "cleared" });
  assert.equal(await h.presetStore.loadPresets(), null);
});

test("FIFO snapshots commands at submission and rejects repeated stale edits", async () => {
  const h = harness();
  const first = await h.create();
  const command = { ...h.expected(first), variationNumber: 80, sku: "LA-M" };
  const one = h.client.setPresetItem(command);
  const two = h.client.setPresetItem({ ...h.expected(first), variationNumber: 81, sku: "TEE-OS" });
  command.sku = "TEE-OS";
  await one;
  await assert.rejects(two, { code: "PRESETS_CHANGED" });
  assert.deepEqual((await h.snapshot()).assignments, [{ variationNumber: 80, sku: "LA-M" }]);
});

test("client rejects malformed, mismatched and unconfirmed successes and recovers its FIFO after failure", async () => {
  const h = harness();
  const base = await h.create();
  let response;
  const client = clientModule.createVariationPresetsClient({ protocol, runtime: { async sendMessage() { return clone(response); } } });
  for (const data of [
    { ...base, streamId: OTHER_STREAM },
    { ...base, total: null },
    { ...base, assignments: [{ variationNumber: 80, sku: "TEE-OS" }] },
  ]) {
    response = { ok: true, data };
    await assert.rejects(client.setPresetItem({ ...h.expected(base), variationNumber: 80, sku: "LA-M" }), { code: "INVALID_RESPONSE" });
  }
  response = { ok: false, error: { code: "PRESETS_CHANGED", message: "Changed" } };
  await assert.rejects(client.getPresets(), { code: "PRESETS_CHANGED" });
  response = { ok: true, data: base };
  assert.deepEqual(await client.getPresets(), base);
});

test("invalid revision generation and failed notifications cannot corrupt preset state", async () => {
  const h = harness();
  const before = await h.snapshot();
  const bad = coordinatorModule.createVariationPresetsCoordinator({ ...h.options, createRevision: () => "not-a-token" });
  await assert.rejects(bad.dispatch({ type: "create_presets", ...h.expected(before), total: 200 }), { code: "PRESET_REVISION_UNAVAILABLE" });
  assert.equal(await h.presetStore.loadPresets(), null);
  const quiet = coordinatorModule.createVariationPresetsCoordinator({ ...h.options, onChange() { throw new Error("Synthetic notification failure"); } });
  assert.equal((await quiet.dispatch({ type: "create_presets", ...h.expected(before), total: 200 })).total, 200);
});

test("sequential protocol accepts only an exact source, SKU and existing mutation identity", async () => {
  const h = harness();
  const presets = await h.create();
  const options = { ...h.expected(presets), variationNumber: 25, sku: "LA-M" };
  assert.equal(protocol.COMMAND_TYPES.ASSIGN_NEXT_PRESET_ITEM, "assign_next_preset_item");
  const message = protocol.createMessage({ type: "assign_next_preset_item", ...options });
  assert.deepEqual(protocol.validateMessage(message), { type: "assign_next_preset_item", ...options });
  for (const patch of [
    { sku: null }, { sku: "" }, { sku: " LA-M " }, { sku: 1 },
    { variationNumber: 0 }, { variationNumber: 25.5 }, { variationNumber: "25" },
    { variationNumber: 1001 }, { variationNumber: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevision: "outdated" }, { expectedStreamId: null },
    { targetVariationNumber: 26 }, { overwrite: true },
  ]) {
    await assert.rejects(h.client.assignNextPresetItem({ ...options, ...patch }), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  }
  assert.deepEqual(await h.snapshot(), presets);
});

test("sequential first click fills its empty source; later clicks move forward without toggling matching SKUs", async () => {
  const h = harness();
  const initial = await h.create();
  const canonical = h.getState();
  const initialReport = report(canonical);
  const initialExport = streamReport.serializeInventoryCsv(initialReport);
  const first = await h.assignNext(25);
  assert.equal(first.assignedVariationNumber, 25);
  assert.notEqual(first.presets.revision, initial.revision);
  const second = await h.assignNext(25);
  assert.equal(second.assignedVariationNumber, 26);
  const third = await h.assignNext(26, "TEE-OS");
  assert.equal(third.assignedVariationNumber, 27);
  assert.deepEqual(third.presets.assignments, [
    { variationNumber: 25, sku: "LA-M" },
    { variationNumber: 26, sku: "LA-M" },
    { variationNumber: 27, sku: "TEE-OS" },
  ]);
  assert.deepEqual(h.getState(), canonical);
  assert.deepEqual(report(h.getState()), initialReport);
  assert.equal(streamReport.serializeInventoryCsv(report(h.getState())), initialExport);
  assert.deepEqual(reconciliation.listPaymentFixingOrders(h.getState(), { streamId: STREAM }), []);
  assert.equal(h.canonicalWrites.length, 0);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" }).reservedQuantity, 0);
  assert.equal(h.getQueue(), "TEE-OS", "distant plans do not clear the actual next-item queue");
});

test("sequential assignment skips assigned presets and captured variations without replacing either", async () => {
  const h = harness();
  await h.create();
  await h.assign(25, "TEE-OS");
  await h.assign(26);
  await h.assign(28, "TEE-OS");
  await h.capture(27, "canceled");
  await h.capture(29, "payment_complete");
  await h.stateCoordinator.dispatch({ type: "map_variation", streamId: STREAM, variationNumber: 29, sku: "TEE-OS" });
  const canonical = h.getState();
  const result = await h.assignNext(25);
  assert.equal(result.assignedVariationNumber, 30);
  assert.deepEqual(result.presets.assignments, [
    { variationNumber: 25, sku: "TEE-OS" }, { variationNumber: 26, sku: "LA-M" },
    { variationNumber: 28, sku: "TEE-OS" }, { variationNumber: 30, sku: "LA-M" },
  ]);
  assert.deepEqual(h.getState(), canonical);
});

test("final empty preset gets one assignment and no-more feedback never wraps, writes or changes the queue", async () => {
  const h = harness();
  await h.create(5);
  const final = await h.assignNext(5);
  assert.equal(final.assignedVariationNumber, 5);
  const writes = h.memory.writes.length;
  const notices = h.notices.length;
  const canonical = h.getState();
  await assert.rejects(h.assignNext(5, "TEE-OS"), { code: "NO_MORE_FUTURE_VARIATIONS", message: "No more future variations." });
  assert.deepEqual(await h.snapshot(), final.presets);
  assert.equal(h.memory.writes.length, writes);
  assert.equal(h.notices.length, notices);
  assert.equal(h.getQueue(), "TEE-OS");
  assert.deepEqual(h.getState(), canonical);
  assert.equal(final.presets.assignments.some((entry) => entry.variationNumber === 4), false, "earlier empty #4 stays empty");
});

test("sequential source must still be a valid uncaptured preset with an exact baseline SKU", async () => {
  const h = harness();
  await h.create(30);
  const base = await h.snapshot();
  await assert.rejects(h.assignNext(3), { code: "VARIATION_ALREADY_CAPTURED" });
  await assert.rejects(h.assignNext(31), { code: "OUTSIDE_PRESET_RANGE" });
  await assert.rejects(h.assignNext(25, "LA"), { code: "UNKNOWN_SKU" });
  await assert.rejects(h.client.assignNextPresetItem({ ...h.expected(base), expectedBaselineId: "other-baseline", variationNumber: 25, sku: "LA-M" }), { code: "PRESET_CONTEXT_CHANGED" });
  await assert.rejects(h.client.assignNextPresetItem({ ...h.expected(base), expectedStreamId: OTHER_STREAM, variationNumber: 25, sku: "LA-M" }), { code: "PRESET_CONTEXT_CHANGED" });
  assert.deepEqual(await h.snapshot(), base);
  await h.reset();
  await assert.rejects(h.assignNext(25), { code: "NO_PRESETS" });
});

test("duplicate and overlapping sequential requests cannot advance or assign more than once", async () => {
  const h = harness();
  const base = await h.create();
  const command = { ...h.expected(base), variationNumber: 25, sku: "LA-M" };
  const pending = h.client.assignNextPresetItem(command);
  const duplicate = h.client.assignNextPresetItem({ ...command });
  command.sku = "TEE-OS";
  const first = await pending;
  await assert.rejects(duplicate, { code: "PRESETS_CHANGED" });
  assert.equal(first.assignedVariationNumber, 25);
  assert.deepEqual((await h.snapshot()).assignments, [{ variationNumber: 25, sku: "LA-M" }]);
  await assert.rejects(h.assignNext(25, "TEE-OS", base), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), first.presets);
});

test("ordinary edits and sequential edits share the authoritative FIFO and revision guard", async () => {
  const h = harness();
  const base = await h.create();
  const leftClick = h.client.setPresetItem({ ...h.expected(base), variationNumber: 26, sku: "TEE-OS" });
  const rightClick = h.assignNext(25, "LA-M", base);
  await leftClick;
  await assert.rejects(rightClick, { code: "PRESETS_CHANGED" });
  assert.deepEqual((await h.snapshot()).assignments, [{ variationNumber: 26, sku: "TEE-OS" }]);
  const fresh = await h.assignNext(25);
  assert.equal(fresh.assignedVariationNumber, 25);
  assert.equal((await h.assignNext(25)).assignedVariationNumber, 27);
});

test("sequential commands do not survive reset, replacement, restart or a changed active stream", async () => {
  const h = harness();
  const old = await h.create();
  const reset = h.client.resetPresets(h.expected(old));
  const oldClick = h.assignNext(25, "LA-M", old);
  await reset;
  await assert.rejects(oldClick, { code: "PRESETS_CHANGED" });
  const replacement = await h.create(100);
  h.restart();
  await assert.rejects(h.assignNext(25, "LA-M", old), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), replacement);
  h.activate(null);
  await assert.rejects(h.assignNext(25, "LA-M", replacement), { code: "NO_ACTIVE_STREAM" });
  assert.deepEqual(await h.presetStore.loadPresets(), replacement);
});

test("capture of the viewed source rejects an old sequential click rather than creating a real mapping", async () => {
  const h = harness();
  const before = await h.create();
  await h.capture(25);
  const canonical = h.getState();
  await assert.rejects(h.assignNext(25, "LA-M", before), { code: "VARIATION_ALREADY_CAPTURED" });
  assert.deepEqual(h.getState(), canonical);
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 25 }).sku, null);
  assert.deepEqual((await h.snapshot()).assignments, []);
});

test("capture of an assigned source promotes the existing plan and invalidates a pending advance", async () => {
  const h = harness();
  await h.create();
  const before = (await h.assignNext(25)).presets;
  await h.capture(25, "payment_complete");
  await assert.rejects(h.assignNext(25, "TEE-OS", before), { code: "PRESETS_CHANGED" });
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 25 }).sku, "LA-M");
  assert.deepEqual((await h.snapshot()).assignments, []);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" }).soldQuantity, 1);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "TEE-OS" }).soldQuantity, 0);
});

test("sequential save failure preserves plans and queue; a failed queue clear retains the durable assignment", async () => {
  const h = harness();
  const before = await h.create();
  h.memory.failNext("set");
  await assert.rejects(h.assignNext(4, "LA-M", before), /Could not save variation presets/);
  assert.deepEqual(await h.snapshot(), before);
  assert.equal(h.getQueue(), "TEE-OS");
  h.failQueue();
  await assert.rejects(h.assignNext(4, "LA-M", before), /queue clear failure/);
  assert.deepEqual((await h.presetStore.loadPresets()).assignments, [{ variationNumber: 4, sku: "LA-M" }]);
  assert.equal(h.getQueue(), "TEE-OS");
  const repaired = await h.snapshot();
  assert.equal(h.getQueue(), null);
  await assert.rejects(h.assignNext(4, "LA-M", before), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), repaired, "a retry of the failed response cannot fill #5");
});

test("sequential target conflict uses the actual next variation, not merely the source or preset range", async () => {
  const h = harness();
  await h.create();
  await h.assignNext(2, "LA-M");
  assert.equal(h.getQueue(), "TEE-OS", "backfilled empty preset #2 is not the live-next target");
  const result = await h.assignNext(2, "TEE-OS");
  assert.equal(result.assignedVariationNumber, 4, "captured #3 is skipped");
  assert.equal(h.getQueue(), null);
  assert.deepEqual(h.queueIntents, [{ capturedVariationNumbers: [], blockNext: true, currentVariationNumber: 3 }]);
  assert.equal(h.getState().streams[0].variations.length, 1);
});

test("sequential client rejects malformed, mismatched, unchanged, wrong-SKU and unconfirmed target responses", async () => {
  const h = harness();
  const original = await h.create();
  const nextRevision = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const presets = { ...original, revision: nextRevision, assignments: [{ variationNumber: 25, sku: "LA-M" }] };
  const valid = { presets, assignedVariationNumber: 25 };
  let data;
  const client = clientModule.createVariationPresetsClient({ protocol, runtime: { async sendMessage() { return { ok: true, data: clone(data) }; } } });
  const options = { ...h.expected(original), variationNumber: 25, sku: "LA-M" };
  for (data of [
    presets, { ...valid, extra: true }, { assignedVariationNumber: 25 },
    { ...valid, assignedVariationNumber: "25" }, { ...valid, assignedVariationNumber: 25.5 },
    { ...valid, assignedVariationNumber: 24 }, { ...valid, assignedVariationNumber: 201 },
    { ...valid, presets: { ...presets, streamId: OTHER_STREAM } },
    { ...valid, presets: { ...presets, baselineId: "other-baseline" } },
    { ...valid, presets: { ...presets, revision: original.revision } },
    { ...valid, presets: { ...presets, total: null, assignments: [] } },
    { ...valid, presets: { ...presets, assignments: [] } },
    { ...valid, presets: { ...presets, assignments: [{ variationNumber: 25, sku: "TEE-OS" }] } },
    { assignedVariationNumber: 26, presets: { ...presets, assignments: [{ variationNumber: 26, sku: "LA-M" }] } },
  ]) {
    await assert.rejects(client.assignNextPresetItem(options), { code: "INVALID_RESPONSE" });
  }
  data = valid;
  const actual = await client.assignNextPresetItem(options);
  assert.deepEqual(actual, valid);
  actual.presets.assignments[0].sku = "mutated";
  assert.equal(data.presets.assignments[0].sku, "LA-M", "client returns detached result snapshots");
  data = { presets: { ...presets, assignments: [{ variationNumber: 25, sku: "TEE-OS" }, { variationNumber: 30, sku: "LA-M" }] }, assignedVariationNumber: 30 };
  assert.deepEqual(await client.assignNextPresetItem(options), data);
});

test("extension readiness is backward-compatible optional metadata only for an enabled preset range", async () => {
  const memory = memoryStore();
  const store = storage.createVariationPresetsStore({ storageArea: memory.storageArea, protocol });
  const legacy = storedRecord();
  await store.savePresets(legacy);
  assert.deepEqual(await store.loadPresets(), legacy, "legacy records are accepted without rewriting or migration");
  const enabled = { ...legacy, extensionAvailable: true };
  assert.deepEqual(await store.savePresets(enabled), enabled);
  assert.deepEqual(await store.loadPresets(), enabled);
  for (const value of [
    { ...legacy, extensionAvailable: false }, { ...legacy, extensionAvailable: 1 },
    { ...legacy, extensionAvailable: "true" }, { ...legacy, extensionAvailable: null },
    { ...legacy, total: null, extensionAvailable: true }, { ...inactive, extensionAvailable: true },
    { ...enabled, otherMetadata: true },
  ]) assert.throws(() => protocol.validateSnapshot(value), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
});

test("range extension activates only after actual live capture exceeds the total and latches once", async () => {
  const h = harness();
  const initial = await h.create(100);
  await h.capture(100);
  assert.equal((await h.snapshot()).extensionAvailable, undefined);
  await assert.rejects(h.create(200), { code: "PRESETS_ALREADY_ENABLED" });
  const writes = h.memory.writes.length;
  const notices = h.notices.length;
  await h.capture(101);
  const canonical = h.getState();
  await h.synchronize();
  const ready = await h.snapshot();
  assert.equal(ready.total, 100);
  assert.equal(ready.extensionAvailable, true);
  assert.equal(ready.revision, initial.revision, "readiness alone is not a new assignment or range generation");
  assert.equal(h.memory.writes.length, writes + 1);
  assert.equal(h.notices.length, notices + 1);
  await h.synchronize();
  await h.snapshot();
  assert.equal(h.memory.writes.length, writes + 1, "ordinary reads and captures do not rewrite the latch");
  assert.deepEqual(h.getState(), canonical);
  assert.equal(h.getQueue(), "TEE-OS", "readiness does not clear an unrelated next-item queue");
});

test("exceeded readiness survives payment completion and worker restart without an active bidding marker", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(101);
  await h.synchronize();
  await h.capture(101, "payment_complete");
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, null);
  h.restart();
  const ready = await h.snapshot();
  assert.equal(ready.extensionAvailable, true);
  const extended = await h.create(200);
  assert.equal(extended.total, 200);
  assert.equal(Object.hasOwn(extended, "extensionAvailable"), false);
  h.restart();
  assert.deepEqual(await h.snapshot(), extended);
});

test("a high historical payment backfill cannot enable extension even when it is the highest captured number", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(150, "canceled");
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, 3);
  assert.equal((await h.snapshot()).extensionAvailable, undefined);
  await assert.rejects(h.create(200), { code: "PRESETS_ALREADY_ENABLED" });
  await h.capture(3, "payment_complete");
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, null);
  h.restart();
  assert.equal((await h.snapshot()).extensionAvailable, undefined);
  await assert.rejects(h.create(200), { code: "PRESETS_ALREADY_ENABLED" });
});

test("extension preserves skipped plans and real mappings without changing canonical inventory, reports, exports or queue", async () => {
  const h = harness();
  await h.create(100);
  await h.assign(25);
  await h.assign(80, "TEE-OS");
  await h.capture(101);
  await h.stateCoordinator.dispatch({ type: "map_variation", streamId: STREAM, variationNumber: 101, sku: "TEE-OS" });
  const canonical = h.getState();
  const beforeReport = report(canonical);
  const beforeCsv = streamReport.serializeInventoryCsv(beforeReport);
  const ready = await h.snapshot();
  const extended = await h.create(200);
  assert.equal(extended.total, 200);
  assert.notEqual(extended.revision, ready.revision);
  assert.equal(extended.extensionAvailable, undefined);
  assert.deepEqual(extended.assignments, [
    { variationNumber: 25, sku: "LA-M" }, { variationNumber: 80, sku: "TEE-OS" },
  ]);
  assert.deepEqual(h.getState(), canonical);
  assert.deepEqual(report(h.getState()), beforeReport);
  assert.equal(streamReport.serializeInventoryCsv(report(h.getState())), beforeCsv);
  assert.equal(h.getQueue(), "TEE-OS");
  await h.capture(25, "payment_complete");
  await h.synchronize();
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 25 }).sku, "LA-M");
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 101 }).sku, "TEE-OS");
  assert.deepEqual((await h.snapshot()).assignments, [{ variationNumber: 80, sku: "TEE-OS" }]);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" }).soldQuantity, 1);
});

test("skipping beyond a preset total enables extension but revalidates against the highest captured variation", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(125);
  const ready = await h.snapshot();
  assert.equal(ready.extensionAvailable, true);
  for (const total of [1, 99, 100]) {
    await assert.rejects(h.create(total), { code: "PRESET_TOTAL_NOT_INCREASED" });
  }
  await assert.rejects(h.create(124), { code: "PRESET_TOTAL_BELOW_CAPTURED" });
  await h.capture(180, "canceled");
  await assert.rejects(h.client.createPresets({ ...h.expected(ready), total: 150 }), { code: "PRESET_TOTAL_BELOW_CAPTURED" });
  const extended = await h.create(180);
  assert.equal(extended.total, 180);
  assert.equal(extended.extensionAvailable, undefined);
  await assert.rejects(h.create(200), { code: "PRESETS_ALREADY_ENABLED" });
});

test("each extended range can be exceeded again and the preset limit never caps real capture", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(101);
  await h.create(200);
  await h.capture(200);
  assert.equal((await h.snapshot()).extensionAvailable, undefined);
  await h.capture(201);
  assert.equal((await h.snapshot()).extensionAvailable, true);
  await h.create(1000);
  await h.capture(1001);
  await h.synchronize();
  assert.equal((await h.snapshot()).extensionAvailable, true);
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, 1001);
  await assert.rejects(h.create(1001), { code: "INVALID_VARIATION_PRESETS_MESSAGE" });
  await assert.rejects(h.create(1000), { code: "PRESET_TOTAL_NOT_INCREASED" });
  assert.equal((await h.snapshot()).total, 1000);
});

test("failed readiness or extension persistence keeps existing plans and does not change canonical data", async () => {
  const h = harness();
  await h.create(100);
  const original = await h.assign(80);
  await h.capture(101);
  const canonical = h.getState();
  h.memory.failNext("set");
  await assert.rejects(h.synchronize(), /Could not save variation presets/);
  assert.deepEqual(await h.presetStore.loadPresets(), original);
  assert.deepEqual(h.getState(), canonical);
  const ready = await h.snapshot();
  h.memory.failNext("set");
  await assert.rejects(h.client.createPresets({ ...h.expected(ready), total: 200 }), /Could not save variation presets/);
  assert.deepEqual(await h.presetStore.loadPresets(), ready);
  assert.deepEqual(h.getState(), canonical);
  assert.equal(h.getQueue(), "TEE-OS");
  assert.deepEqual((await h.create(200)).assignments, original.assignments);
});

test("duplicate extension requests and stale reset or assignment cannot overwrite the new range", async () => {
  const h = harness();
  await h.create(100);
  await h.assign(80);
  await h.capture(101);
  const ready = await h.snapshot();
  const command = { ...h.expected(ready), total: 200 };
  const first = h.client.createPresets(command);
  const duplicate = h.client.createPresets(command);
  const extended = await first;
  await assert.rejects(duplicate, { code: "PRESETS_CHANGED" });
  await assert.rejects(h.reset(ready), { code: "PRESETS_CHANGED" });
  await assert.rejects(h.assignNext(25, "TEE-OS", ready), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), extended);
});

test("reset and sequential assignment races invalidate old extension requests without losing a newer configuration", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(101);
  const ready = await h.snapshot();
  const assign = h.assignNext(25, "LA-M", ready);
  const extension = h.client.createPresets({ ...h.expected(ready), total: 200 });
  await assign;
  await assert.rejects(extension, { code: "PRESETS_CHANGED" });
  const fresh = await h.snapshot();
  assert.equal(fresh.extensionAvailable, true);
  assert.deepEqual(fresh.assignments, [{ variationNumber: 25, sku: "LA-M" }]);
  const reset = h.reset(fresh);
  const stale = h.client.createPresets({ ...h.expected(fresh), total: 200 });
  const disabled = await reset;
  await assert.rejects(stale, { code: "PRESETS_CHANGED" });
  assert.equal(disabled.extensionAvailable, undefined);
  assert.equal(disabled.total, null);
  const replacement = await h.create(300);
  await assert.rejects(h.client.createPresets({ ...h.expected(ready), total: 200 }), { code: "PRESETS_CHANGED" });
  assert.deepEqual(await h.snapshot(), replacement);
  assert.deepEqual(replacement.assignments, []);
});

test("promotion before extension preserves the real mapping and rejects the stale assignment generation", async () => {
  const h = harness();
  await h.create(100);
  await h.assign(80);
  await h.capture(101);
  const ready = await h.snapshot();
  await h.capture(80, "canceled");
  await assert.rejects(h.client.createPresets({ ...h.expected(ready), total: 200 }), { code: "PRESETS_CHANGED" });
  assert.equal(reconciliation.getAuction(h.getState(), { streamId: STREAM, variationNumber: 80 }).sku, "LA-M");
  const extended = await h.create(200);
  assert.deepEqual(extended.assignments, []);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" }).reservedQuantity, 0);
  assert.equal(reconciliation.getInventoryAvailability(h.getState(), { sku: "LA-M" }).soldQuantity, 0);
});

test("extension readiness cannot carry into another stream or inventory baseline", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(101);
  const ready = await h.snapshot();
  await h.stateCoordinator.dispatch({ type: "pin_stream_to_inventory_baseline", streamId: OTHER_STREAM });
  h.activate(OTHER_STREAM);
  assert.equal((await h.snapshot()).extensionAvailable, undefined);
  await assert.rejects(h.client.createPresets({ ...h.expected(ready), total: 200 }), { code: "PRESET_CONTEXT_CHANGED" });
  assert.deepEqual(await h.presetStore.loadPresets(), ready);
  h.activate(STREAM);
  await h.presetStore.savePresets({ ...ready, baselineId: "different-baseline" });
  assert.equal((await h.snapshot()).extensionAvailable, undefined);
  await assert.rejects(h.client.createPresets({ ...h.expected(ready), total: 200 }), { code: "PRESETS_CHANGED" });
});

test("pre-capture readiness preservation retries failed proof persistence before payment clears the live marker", async () => {
  const h = harness();
  await h.create(100);
  await h.capture(101);
  h.memory.failNext("set");
  await assert.rejects(h.synchronize(), /Could not save variation presets/);
  const pending = h.getState();
  h.memory.failNext("set");
  await assert.rejects(h.preserveReadiness(), /Could not save variation presets/);
  assert.deepEqual(h.getState(), pending, "a failed pre-capture latch cannot clear the only canonical live proof");
  assert.deepEqual(await h.preserveReadiness(), { changed: true });
  await h.capture(101, "payment_complete");
  await h.synchronize();
  assert.equal(h.getState().streams[0].activeBiddingVariationNumber, null);
  h.restart();
  assert.equal((await h.snapshot()).extensionAvailable, true);
  assert.equal((await h.create(200)).total, 200);
});

test("pre-capture readiness hook performs no promotion, queue clearing, generation rotation or repeated writes", async () => {
  const h = harness();
  await h.create(100);
  const assigned = await h.assign(80);
  await h.capture(80, "payment_complete");
  await h.capture(101);
  const canonical = h.getState();
  const clears = h.queueClears.length;
  const writes = h.memory.writes.length;
  const canonicalWrites = h.canonicalWrites.length;
  assert.deepEqual(await h.preserveReadiness(), { changed: true });
  const saved = await h.presetStore.loadPresets();
  assert.equal(saved.revision, assigned.revision);
  assert.equal(saved.extensionAvailable, true);
  assert.deepEqual(saved.assignments, assigned.assignments, "promotion remains in the ordinary capture repair path");
  assert.deepEqual(h.getState(), canonical);
  assert.equal(h.canonicalWrites.length, canonicalWrites);
  assert.equal(h.queueClears.length, clears);
  assert.equal(h.getQueue(), "TEE-OS");
  assert.deepEqual(await h.preserveReadiness(), { changed: false });
  assert.equal(h.memory.writes.length, writes + 1);
});

test("pre-capture readiness hook validates identity and ignores inactive, other-stream, within-range and historical-only state", async () => {
  const h = harness();
  for (const identity of [null, "", " padded ", 3, {}, []]) {
    await assert.rejects(h.preserveReadiness(identity), { code: "INVALID_ARGUMENT" });
  }
  assert.deepEqual(await h.preserveReadiness(), { changed: false });
  await h.create(100);
  await h.capture(101, "payment_complete");
  assert.deepEqual(await h.preserveReadiness(), { changed: false });
  await h.capture(102);
  assert.deepEqual(await h.preserveReadiness(OTHER_STREAM), { changed: false });
  assert.equal((await h.presetStore.loadPresets()).extensionAvailable, undefined);
  h.activate(null);
  assert.deepEqual(await h.preserveReadiness(STREAM), { changed: false });
  const noState = harness({ state: null });
  assert.deepEqual(await noState.preserveReadiness(), { changed: false });
});
