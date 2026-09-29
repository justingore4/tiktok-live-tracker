const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const storage = require("../extension/shared/reconciliation-storage.js");
const coordinatorModule = require("../extension/shared/reconciliation-coordinator.js");
const controllerModule = require("../extension/tagger/persistent-tagger-controller.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const inventoryViewModel = require("../extension/tagger/inventory-view-model.js");
const liveBidStorage = require("../extension/shared/live-bid-storage.js");
const presetsView = require("../extension/tagger/variation-presets-view.js");

const STREAM = "synthetic-ran-stream";
const clone = value => JSON.parse(JSON.stringify(value));
const INVENTORY = [
  { sku: "TEE-M", item: "Synthetic tee", style: "Black", size: "M", quantityOnHandAtImport: 20, unitCostCents: 500 },
  { sku: "TEE-L", item: "Synthetic tee", style: "Black", size: "L", quantityOnHandAtImport: 20, unitCostCents: 500 },
  { sku: "HOODIE-OS", item: "Synthetic hoodie", style: "Red", size: "OS", quantityOnHandAtImport: 20, unitCostCents: 900 },
];

// Real persistence, coordinator, controller, and mapping projection; the storage
// area is in-memory only. No browser, credentials, seller data, or network access.
async function fixture() {
  const values = {}, writes = [];
  const storageArea = {
    async get(key) { return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {}; },
    async set(items) { writes.push(clone(items)); Object.assign(values, clone(items)); },
    async remove(key) { delete values[key]; },
  };
  const stateStore = storage.createReconciliationStateStore({ storageArea, reconciliation });
  let coordinator = coordinatorModule.createReconciliationCoordinator({ reconciliation, stateStore });
  await coordinator.dispatch({ type: "initialize_state", inventory: INVENTORY });
  await coordinator.dispatch({ type: "pin_stream_to_inventory_baseline", streamId: STREAM });
  const client = {
    getState: () => coordinator.dispatch({ type: "get_state" }),
    initializeState() { assert.fail("Opening the saved tracker must not initialize another baseline"); },
    mapVariation: options => coordinator.dispatch({ type: "map_variation", ...options }),
    unmapVariation: options => coordinator.dispatch({ type: "unmap_variation", ...options }),
  };
  async function open(streamId = STREAM) {
    const controller = controllerModule.createPersistentTaggerController({
      reconciliation, mappingWorkflow, client, streamId,
      inventory: INVENTORY, currentVariationNumber: 1, variationNumbers: [1],
    });
    const snapshot = await controller.start();
    assert.equal(snapshot.phase, "ready");
    return controller;
  }
  const controller = await open();
  return {
    controller, values, writes, storageArea, open,
    state: () => stateStore.loadState(),
    restartWorker() { coordinator = coordinatorModule.createReconciliationCoordinator({ reconciliation, stateStore }); },
    dispatch: command => coordinator.dispatch(command),
    bid: (variationNumber, streamId = STREAM) => coordinator.dispatch({ type: "observe_bidding_variation", streamId, variationNumber }),
    status: (variationNumber, observedPaymentStatus, streamId = STREAM) => coordinator.dispatch({
      type: "observe_payment_statuses", streamId, statuses: [{ variationNumber, observedPaymentStatus }],
    }),
    complete: (variationNumber, streamId = STREAM) => coordinator.dispatch({
      type: "record_payment_complete", streamId, variationNumber, soldPriceCents: 1500,
    }),
    async map(variationNumber, sku, controllerToUse = controller) {
      await controllerToUse.refresh();
      controllerToUse.selectVariation(variationNumber);
      const result = await controllerToUse.mapSelectedSku(sku);
      assert.equal(result.phase, "ready");
    },
  };
}

async function countsWithoutMutation(f, controller = f.controller) {
  const { view, phase } = await controller.refresh();
  assert.equal(phase, "ready");
  const before = JSON.stringify(f.values), beforeView = JSON.stringify(view), writes = f.writes.length;
  const counts = inventoryViewModel.getRanCountsBySku(view);
  const groups = inventoryViewModel.groupInventoryEntries(view.inventory);
  const groupTotal = groups.reduce((total, group) => total + inventoryViewModel.getInventoryGroupRanCount(group, counts), 0);
  assert.equal(groupTotal, [...counts.values()].reduce((total, count) => total + count, 0));
  assert.equal(JSON.stringify(f.values), before, "Derivation must not write inventory, reservations, payments, or reports");
  assert.equal(JSON.stringify(view), beforeView, "Derivation must not alter the controller's view");
  assert.equal(f.writes.length, writes, "Card counts are not persisted");
  return { counts: [...counts].sort(([a], [b]) => a.localeCompare(b)), view };
}

test("ran counts advance once per mapped auction, regardless of current/history selection or repeated captures", async () => {
  const f = await fixture();
  assert.deepEqual((await countsWithoutMutation(f)).counts, []);
  await f.bid(1); await f.map(1, "TEE-M");
  assert.deepEqual((await countsWithoutMutation(f)).counts, [], "The mapped live auction has not finished");
  await f.bid(2); await f.map(2, "TEE-M");
  assert.deepEqual((await countsWithoutMutation(f)).counts, [["TEE-M", 1]]);
  await f.bid(2);
  await f.dispatch({ type: "observe_variations", streamId: STREAM, variationNumbers: [1, 2] });
  await f.dispatch({ type: "observe_variations", streamId: STREAM, variationNumbers: [1, 2] });
  f.controller.selectVariation(1);
  const history = await countsWithoutMutation(f);
  assert.equal(history.view.selectedVariationNumber, 1);
  assert.equal(history.view.activeBiddingVariationNumber, 2);
  assert.deepEqual(history.counts, [["TEE-M", 1]]);
  await f.bid(3);
  assert.deepEqual((await countsWithoutMutation(f)).counts, [["TEE-M", 2]], "An unmapped live auction adds no count");
});

test("the final mapped auction counts when its bidding ends even without a next live variation", async () => {
  for (const status of ["payment_processing", "order_processing", "payment_fixing", "canceled", "unrecognized", "payment_complete"]) {
    const f = await fixture();
    await f.bid(1); await f.map(1, "TEE-M");
    if (status === "payment_complete") await f.complete(1);
    else await f.status(1, status);
    const { counts, view } = await countsWithoutMutation(f);
    assert.equal(view.currentVariationNumber, 1, status);
    assert.equal(view.activeBiddingVariationNumber, null, status);
    assert.deepEqual(counts, [["TEE-M", 1]], status);
    if (status === "payment_complete") await f.complete(1);
    else await f.status(1, status);
    assert.deepEqual((await countsWithoutMutation(f)).counts, [["TEE-M", 1]], "Payment refreshes cannot multiply a run");
  }
});

test("status transitions preserve ran totals while sale and reservation accounting remains separate", async () => {
  const f = await fixture();
  await f.bid(1); await f.map(1, "TEE-M"); await f.status(1, "payment_processing");
  await f.bid(2); await f.map(2, "TEE-L"); await f.status(2, "payment_fixing");
  assert.deepEqual((await countsWithoutMutation(f)).counts, [["TEE-L", 1], ["TEE-M", 1]]);
  await f.complete(1); await f.status(2, "canceled");
  const { counts, view } = await countsWithoutMutation(f);
  assert.deepEqual(counts, [["TEE-L", 1], ["TEE-M", 1]]);
  const tee = inventoryViewModel.groupInventoryEntries(view.inventory).find(group => group.item === "Synthetic tee");
  assert.equal(inventoryViewModel.getInventoryGroupRanCount(tee, inventoryViewModel.getRanCountsBySku(view)), 2);
  assert.equal(view.inventory.find(item => item.sku === "TEE-M").soldQuantity, 1);
  assert.equal(view.inventory.find(item => item.sku === "TEE-L").soldQuantity, 0);
  assert.equal(view.inventory.find(item => item.sku === "TEE-L").reservedQuantity, 0);
});

test("history remapping moves exactly one run between exact SKUs and unmapping removes only that run", async () => {
  const f = await fixture();
  await f.bid(1); await f.map(1, "TEE-M"); await f.status(1, "canceled");
  await f.bid(2); await f.map(2, "TEE-M"); await f.status(2, "payment_processing");
  await f.map(1, "TEE-L");
  assert.deepEqual((await countsWithoutMutation(f)).counts, [["TEE-L", 1], ["TEE-M", 1]]);
  await f.map(1, "HOODIE-OS");
  assert.deepEqual((await countsWithoutMutation(f)).counts, [["HOODIE-OS", 1], ["TEE-M", 1]]);
  f.controller.selectVariation(1);
  assert.equal((await f.controller.unmapSelectedVariation()).phase, "ready");
  assert.deepEqual((await countsWithoutMutation(f)).counts, [["TEE-M", 1]]);
});

test("reopening restores current-stream counts and a new stream starts at zero even on the same baseline", async () => {
  const f = await fixture();
  await f.bid(1); await f.map(1, "TEE-M"); await f.complete(1);
  const original = (await countsWithoutMutation(f)).view;
  f.restartWorker();
  const reopened = await f.open();
  assert.deepEqual((await countsWithoutMutation(f, reopened)).counts, [["TEE-M", 1]]);
  const nextStream = "synthetic-next-stream";
  await f.dispatch({ type: "pin_stream_to_inventory_baseline", streamId: nextStream });
  const next = await f.open(nextStream);
  const initial = await countsWithoutMutation(f, next);
  assert.equal(initial.view.inventoryBaselineId, original.inventoryBaselineId);
  assert.deepEqual(initial.counts, []);
  assert.equal(initial.view.inventory.find(item => item.sku === "TEE-M").soldQuantity, 1, "Baseline accounting still includes the earlier stream");
  await f.bid(1, nextStream); await f.map(1, "TEE-L", next); await f.status(1, "canceled", nextStream);
  assert.deepEqual((await countsWithoutMutation(f, next)).counts, [["TEE-L", 1]]);
  assert.deepEqual((await countsWithoutMutation(f, reopened)).counts, [["TEE-M", 1]]);
});

test("clearing transient bid data and reopening during disconnection does not treat bidding as finished", async () => {
  const f = await fixture();
  await f.bid(1); await f.map(1, "TEE-M");
  const liveBidStore = liveBidStorage.createLiveBidStore({ storageArea: f.storageArea });
  await liveBidStore.saveLiveBid({ streamId: STREAM, variationNumber: 1, bidPriceCents: 1200, unitCostCents: 500 });
  const canonicalBefore = await f.state();
  await liveBidStore.clearLiveBid();
  assert.equal(await liveBidStore.loadLiveBid(), null);
  f.restartWorker();
  const reopened = await f.open();
  const { counts, view } = await countsWithoutMutation(f, reopened);
  assert.equal(view.activeBiddingVariationNumber, 1);
  assert.deepEqual(counts, []);
  assert.deepEqual(await f.state(), canonicalBefore);
});

test("preset and manual-queue projections cannot contribute runs to the real saved stream", async () => {
  const f = await fixture();
  await f.bid(1); await f.map(1, "TEE-M"); await f.status(1, "canceled");
  await f.bid(2); await f.map(2, "TEE-L");
  const { view, counts } = await countsWithoutMutation(f);
  const before = JSON.stringify(f.values);
  const presets = { streamId: STREAM, baselineId: view.inventoryBaselineId, revision: "synthetic-revision", total: 5,
    assignments: [{ variationNumber: 4, sku: "HOODIE-OS" }, { variationNumber: 5, sku: "TEE-M" }] };
  const projected = presetsView.projectQueuedItem(presetsView.project(view, presets, 4), {
    streamId: STREAM, baselineId: view.inventoryBaselineId, armedAfterVariationNumber: 2,
    queuedSku: "HOODIE-OS", queueToken: "synthetic-queue",
  }, 3);
  assert.equal(projected.isReviewingQueuePreview, true);
  assert.deepEqual([...inventoryViewModel.getRanCountsBySku(projected)], counts);
  assert.equal(JSON.stringify(f.values), before);
});
