const assert = require("node:assert/strict");
const test = require("node:test");
const reconciliation = require("../extension/shared/reconciliation.js");
const coordinatorModule = require("../extension/shared/reconciliation-coordinator.js");
const storage = require("../extension/shared/reconciliation-storage.js");
const captureProtocol = require("../extension/shared/capture-protocol.js");
const captureIntegration = require("../extension/shared/capture-integration.js");
const streamSession = require("../extension/shared/stream-session.js");
const streamSessionCoordinator = require("../extension/shared/stream-session-coordinator.js");
const streamReport = require("../extension/shared/stream-report.js");

const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const OTHER_STREAM = "local-stream:22222222-2222-4222-8222-222222222222";
const key = { streamId: STREAM, variationNumber: 8 };
const inventory = [{ sku: "TEE-M", item: "Tee", style: "Black", size: "M",
  quantityReceived: 4, unitCostCents: 500 }];
const clone = (value) => JSON.parse(JSON.stringify(value));
const pendingStates = ["payment_processing", "order_processing", "payment_fixing", "payment_failed"];
function status(processingPriceCents, observedPaymentStatus = "payment_processing", variationNumber = 8) {
  return { variationNumber, observedPaymentStatus,
    ...(processingPriceCents === undefined ? {} : { processingPriceCents }) };
}
function observe(state, row = status(1700), streamId = STREAM) {
  return reconciliation.observePaymentStatuses(state, { streamId, statuses: [row] });
}
function auction(state, streamId = STREAM, variationNumber = 8) {
  return state.streams.find((stream) => stream.streamId === streamId)
    ?.variations.find((entry) => entry.variationNumber === variationNumber);
}
function list(state, streamId = STREAM) {
  return reconciliation.listPaymentFixingOrders(state, { streamId });
}
function createState() {
  const state = reconciliation.createReconciliationState(inventory);
  reconciliation.mapVariation(state, { ...key, sku: "TEE-M" });
  return state;
}
function event(row = status(1700)) {
  return { type: "observe_payment_statuses", statuses: [{ ...row,
    ...(Object.hasOwn(row, "processingPriceCents") ? { processingPriceContext: "synthetic-context" } : {}),
  }] };
}
function command(row = status(1700)) {
  return { type: "observe_payment_statuses", statuses: [row], streamId: STREAM };
}
function memory(initialState = createState()) {
  let saved = clone(initialState);
  let nextError = null;
  const writes = [];
  const stateStore = {
    async loadState() { return clone(saved); },
    async saveState(state) {
      if (nextError) { const error = nextError; nextError = null; throw error; }
      saved = clone(state);
      writes.push(clone(state));
    },
  };
  return { stateStore, writes, get: () => clone(saved), fail: (error) => { nextError = error; } };
}
const coordinator = (store) => coordinatorModule.createReconciliationCoordinator({
  reconciliation, stateStore: store.stateStore,
});

for (const observedPaymentStatus of pendingStates) {
  test(`processing price is auxiliary for ${observedPaymentStatus} and survives strict hydration`, () => {
    const state = createState();
    observe(state, status(undefined, observedPaymentStatus));
    const beforeSummary = reconciliation.calculateSummary(state, { streamId: STREAM });
    const beforeInventory = clone(state.inventoryBaselines);
    assert.equal(observe(state, status(1700, observedPaymentStatus)).updatedCount, 1);
    assert.equal(auction(state).processingPriceCents, 1700);
    assert.equal(auction(state).soldPriceCents, null);
    assert.equal(auction(state).committedUnitCostCents, null);
    assert.equal(auction(state).paymentStatus, "unknown");
    assert.deepEqual(state.inventoryBaselines, beforeInventory);
    assert.deepEqual(reconciliation.calculateSummary(state, { streamId: STREAM }), beforeSummary);
    assert.deepEqual(reconciliation.hydrateReconciliationState(clone(state)), state);
    assert.deepEqual(list(state)[0], { variationNumber: 8, observedPaymentStatus,
      mapped: true, sku: "TEE-M", item: "Tee", style: "Black", size: "M", processingPriceCents: 1700 });
    const beforeDuplicate = clone(state);
    assert.equal(observe(state, status(1700, observedPaymentStatus)).updatedCount, 0);
    assert.deepEqual(state, beforeDuplicate);
  });
}

test("processing prices cannot be inferred from bidding or an observation without a price", () => {
  const state = createState();
  reconciliation.observeBiddingVariation(state, key);
  assert.equal(Object.hasOwn(list(state)[0], "processingPriceCents"), false);
  observe(state, status());
  assert.equal(Object.hasOwn(auction(state), "processingPriceCents"), false);
  assert.equal(Object.hasOwn(list(state)[0], "processingPriceCents"), false);
});

test("processing price conflicts are sticky, survive reload, and do not become accounting conflicts", () => {
  const state = createState();
  observe(state);
  const beforeSummary = reconciliation.calculateSummary(state, { streamId: STREAM });
  assert.equal(observe(state, status(1800)).updatedCount, 1);
  assert.equal(auction(state).processingPriceCents, 1700);
  assert.equal(auction(state).processingPriceConflict, true);
  assert.equal(list(state)[0].processingPriceCents, null);
  assert.deepEqual(auction(state).conflicts, []);
  assert.deepEqual(reconciliation.calculateSummary(state, { streamId: STREAM }), beforeSummary);
  const restored = reconciliation.hydrateReconciliationState(clone(state));
  const before = clone(restored);
  observe(restored, status(1700));
  observe(restored, status(1800));
  observe(restored, status());
  assert.deepEqual(restored, before);
  observe(restored, status(undefined, "unrecognized"));
  assert.equal(list(restored)[0].processingPriceCents, null);
});

for (const outcome of ["payment_complete", "canceled"]) {
  test(`saved price never finalizes ${outcome} and terminal outcomes ignore later price updates`, () => {
    const state = createState();
    observe(state);
    assert.equal(reconciliation.calculateSummary(state, { streamId: STREAM }).totals.completedPaymentCount, 0);
    reconciliation.resolvePaymentFixingOrder(state, { ...key, resolution: outcome,
      soldPriceCents: outcome === "payment_complete" ? 1900 : null });
    assert.equal(auction(state).paymentStatus, outcome);
    assert.equal(auction(state).soldPriceCents, outcome === "payment_complete" ? 1900 : null);
    assert.equal(auction(state).processingPriceCents, 1700);
    assert.deepEqual(list(state), []);
    const before = clone(state);
    observe(state, status(9999));
    reconciliation.resolvePaymentFixingOrder(state, { ...key, resolution: outcome,
      soldPriceCents: outcome === "payment_complete" ? 1900 : null });
    assert.deepEqual(state, before);
    assert.deepEqual(reconciliation.hydrateReconciliationState(clone(state)), state);
  });
}

test("automatic completion uses its actual final price even if processing values conflicted", () => {
  const state = createState();
  observe(state);
  observe(state, status(1800));
  reconciliation.recordPaymentComplete(state, { ...key, soldPriceCents: 2000 });
  const before = clone(state);
  reconciliation.recordPaymentComplete(state, { ...key, soldPriceCents: 2000 });
  observe(state, status(undefined, "canceled"));
  assert.deepEqual(state, before);
  const summary = reconciliation.calculateSummary(state, { streamId: STREAM });
  assert.equal(summary.totals.completedGmvCents, 2000);
  assert.equal(summary.totals.committedSalesCount, 1);
  assert.deepEqual(auction(state).conflicts, []);
  assert.deepEqual(list(state), []);
});

test("canonical metadata stays isolated by stream and exact variation", () => {
  const state = createState();
  observe(state, status(1700));
  observe(state, status(2400, "order_processing", 9));
  observe(state, status(3300), OTHER_STREAM);
  assert.deepEqual(list(state).map((row) => [row.variationNumber, row.processingPriceCents]), [[8, 1700], [9, 2400]]);
  assert.equal(list(state, OTHER_STREAM)[0].processingPriceCents, 3300);
  assert.equal(list(state, OTHER_STREAM)[0].sku, null);
});

test("unpriced legacy/current snapshots hydrate without invented processing metadata", () => {
  const state = createState();
  observe(state, status());
  assert.deepEqual(reconciliation.hydrateReconciliationState(clone(state)), state);
  const legacy = clone(state);
  legacy.version = 6;
  const restored = reconciliation.hydrateReconciliationState(legacy);
  assert.equal(Object.hasOwn(auction(restored), "processingPriceCents"), false);
  assert.equal(Object.hasOwn(list(restored)[0], "processingPriceCents"), false);
});

test("strict saved-state validation rejects malformed auxiliary data without rewriting legacy snapshots", () => {
  for (const extra of [
    { processingPriceCents: null }, { processingPriceCents: 0 }, { processingPriceCents: -1 },
    { processingPriceCents: 1.5 }, { processingPriceCents: "1700" },
    { processingPriceCents: Number.MAX_SAFE_INTEGER + 1 },
    { processingPriceConflict: true }, { processingPriceCents: 1700, processingPriceConflict: "true" },
  ]) {
    const state = createState();
    observe(state, status());
    Object.assign(auction(state), extra);
    const before = clone(state);
    assert.throws(() => reconciliation.hydrateReconciliationState(state), { code: "INVALID_STATE" });
    assert.deepEqual(state, before);
  }
  const unobserved = createState();
  auction(unobserved).processingPriceCents = 1700;
  assert.throws(() => reconciliation.hydrateReconciliationState(unobserved), { code: "INVALID_STATE" });
  const legacy = createState();
  observe(legacy);
  legacy.version = 6;
  assert.throws(() => reconciliation.hydrateReconciliationState(legacy), { code: "INVALID_STATE" });
});

test("capture protocol allows only positive processing prices on eligible statuses and snapshots them", () => {
  for (const observedPaymentStatus of pendingStates) {
    const input = event(status(1700, observedPaymentStatus));
    const message = captureProtocol.createCaptureMessage(input);
    input.statuses[0].processingPriceCents = 9999;
    assert.equal(captureProtocol.validateCaptureMessage(message).statuses[0].processingPriceCents, 1700);
  }
});

test("all three mutation boundaries reject malformed or inappropriate processing prices atomically", async () => {
  const invalidRows = [
    ...[null, 0, -1, 1.5, "1700", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value) => status(value)),
    ...["canceled", "payment_complete", "unrecognized", "not_observed"].map((value) => status(1700, value)),
    { ...status(1700), processingPriceConflict: true },
    { ...status(1700), soldPriceCents: 1700 },
  ];
  for (const row of invalidRows) {
    const state = createState();
    const before = clone(state);
    const store = memory(state);
    assert.throws(() => captureProtocol.createCaptureMessage(event(row)), { code: "INVALID_CAPTURE_MESSAGE" });
    assert.throws(() => reconciliation.observePaymentStatuses(state, { streamId: STREAM,
      statuses: [status(1000, "payment_processing", 7), row] }), { code: "INVALID_ARGUMENT" });
    assert.deepEqual(state, before);
    await assert.rejects(coordinator(store).dispatch(command(row)), { code: "INVALID_COMMAND" });
    assert.deepEqual(store.writes, []);
  }
});

test("price capture requires paired bounded context and the context read contains no caller-selected identity", () => {
  assert.deepEqual(captureProtocol.createCaptureMessage({ type: "get_processing_price_context" }).event,
    { type: "get_processing_price_context" });
  for (const extra of [{ streamId: STREAM }, { inventoryBaselineId: "baseline" }, { processingPriceContext: "old" }]) {
    assert.throws(() => captureProtocol.createCaptureMessage({ type: "get_processing_price_context", ...extra }),
      { code: "INVALID_CAPTURE_MESSAGE" });
  }
  for (const value of [null, undefined, "", 17, "x".repeat(513)]) {
    const input = event();
    input.statuses[0].processingPriceContext = value;
    assert.throws(() => captureProtocol.createCaptureMessage(input), { code: "INVALID_CAPTURE_MESSAGE" });
  }
  const orphan = event(status());
  orphan.statuses[0].processingPriceContext = "without-price";
  assert.throws(() => captureProtocol.createCaptureMessage(orphan), { code: "INVALID_CAPTURE_MESSAGE" });
});

test("price-only coordinator updates are durable and failed writes can retry without extra deductions", async () => {
  const store = memory();
  let worker = coordinator(store);
  await worker.dispatch(command(status()));
  const before = store.get();
  const failure = new Error("synthetic write failure");
  store.fail(failure);
  await assert.rejects(worker.dispatch(command()), failure);
  assert.deepEqual(store.get(), before);
  assert.deepEqual((await worker.dispatch({ type: "get_state" })).state, before);
  await worker.dispatch(command());
  const after = store.get();
  const writes = store.writes.length;
  worker = coordinator(store);
  await worker.dispatch(command());
  assert.equal(store.writes.length, writes);
  assert.deepEqual((await worker.dispatch({ type: "get_state" })).state, after);
  assert.deepEqual(reconciliation.calculateSummary(after, { streamId: STREAM }),
    reconciliation.calculateSummary(before, { streamId: STREAM }));
});

test("real storage round trips optional fields without adding them to old records or changing envelopes", async () => {
  const state = createState();
  observe(state);
  observe(state, status(1800));
  observe(state, status(undefined, "order_processing", 9));
  let saved;
  const store = storage.createReconciliationStateStore({ reconciliation, storageArea: {
    async get() { return saved ? clone(saved) : {}; },
    async set(value) { saved = clone(value); },
  } });
  await store.saveState(state);
  assert.equal(saved[storage.STORAGE_KEY].schemaVersion, 1);
  assert.equal(saved[storage.STORAGE_KEY].reconciliationState.version, 7);
  assert.deepEqual(await store.loadState(), state);
  assert.equal(Object.hasOwn(auction(await store.loadState(), STREAM, 9), "processingPriceCents"), false);
});

function activeState() {
  const state = streamSession.createStreamSessionState();
  streamSession.startStream(state, { streamId: STREAM, startedAt: "2026-08-20T10:00:00.000Z",
    identitySource: streamSession.IDENTITY_SOURCES.LOCAL_SESSION });
  return state;
}
function integration(store, getSession) {
  return captureIntegration.createCaptureIntegration({
    captureProtocol, reconciliationCoordinator: coordinatorModule,
    stateCoordinator: coordinator(store), streamSession, streamSessionCoordinator,
    activeStreamCoordinator: { async dispatch() { return { state: clone(getSession()) }; } },
  });
}

test("capture integration persists price through restart and End report generation without publishing it as revenue", async () => {
  const store = memory();
  let session = activeState();
  await integration(store, () => session).dispatch(event());
  const reloaded = integration(store, () => session);
  const writes = store.writes.length;
  await reloaded.dispatch(event());
  assert.equal(store.writes.length, writes);
  const canonical = store.get();
  const report = streamReport.createStreamReport({ reconciliation, reconciliationState: canonical,
    streamId: STREAM, startedAt: "2026-08-20T10:00:00.000Z", endedAt: "2026-08-20T12:00:00.000Z",
    generatedAt: "2026-08-20T12:00:00.000Z" });
  assert.equal(report.totals.completedPaymentCount, 0);
  assert.equal(report.totals.unresolvedOrderCount, 1);
  assert.equal(report.inventory[0].updatedQuantity, undefined);
  assert.deepEqual(report.completedSales, []);
  assert.equal(list(reconciliation.hydrateReconciliationState(store.get()))[0].processingPriceCents, 1700);
  session = streamSession.createStreamSessionState();
  await assert.rejects(reloaded.dispatch(event(status(9999))), { code: "NO_ACTIVE_STREAM" });
  assert.deepEqual(store.get(), canonical);
});

test("capture integration preserves the existing stream-baseline mismatch guard for price observations", async () => {
  const state = createState();
  reconciliation.createInventoryBaseline(state, {
    baselineId: "inventory-baseline:33333333-3333-4333-8333-333333333333",
    sourceFingerprint: "fnv1a64:0123456789abcdef",
    inventory: [{ sku: "TEE-M", item: "Tee", style: "Black", size: "M", quantityOnHandAtImport: 9, unitCostCents: 500 }],
  });
  const store = memory(state);
  await assert.rejects(integration(store, activeState).dispatch(event()), { code: "STREAM_BASELINE_CONFLICT" });
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.get(), state);
});
