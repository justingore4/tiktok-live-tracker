const assert = require("node:assert/strict");
const test = require("node:test");
const projection = require("../extension/tagger/variation-presets-view.js");
const selector = require("../extension/tagger/variation-selector-view-model.js");

function fixture(anchor = 10) {
  const view = {
    streamId: "synthetic-stream", inventoryBaselineId: "synthetic-baseline",
    variationNumber: anchor, selectedVariationNumber: anchor, currentVariationNumber: anchor,
    activeBiddingVariationNumber: anchor, isReviewingHistory: false, isReviewingPreset: false,
    variations: [anchor, anchor - 1].map((variationNumber) => ({
      variationNumber, recorded: true, current: variationNumber === anchor,
      selected: variationNumber === anchor, sku: "TEE-M", item: "BAPE Tee", style: "Red", size: "M",
      observedPaymentStatusLabel: "bidding", bidding: variationNumber === anchor,
    })),
    inventory: [
      { sku: "TEE-M", item: "BAPE Tee", style: "Red", size: "M", selected: true,
        quantityReceived: 10, pendingQuantity: 1, soldQuantity: 0, remainingQuantity: 10,
        selectionAllowed: true, selectionReason: "selected" },
      { sku: "TEE-L", item: "BAPE Tee", style: "Red", size: "L", selected: false,
        quantityReceived: 12, pendingQuantity: 0, soldQuantity: 0, remainingQuantity: 12,
        selectionAllowed: true, selectionReason: "available" },
    ],
    auction: { variationNumber: anchor, sku: "TEE-M" }, mapping: { sku: "TEE-M" },
    activeAuctionMapping: { variationNumber: anchor, sku: "TEE-M", unitCostCents: 700 },
    totals: { completedGmvCents: 0, canceledOrderCount: 0 }, warnings: [],
  };
  const queue = {
    streamId: view.streamId, baselineId: view.inventoryBaselineId, queuedSku: "TEE-L",
    armedAfterVariationNumber: anchor, queueToken: "synthetic-token",
  };
  return { view, queue };
}
function plan(view, assignments = []) {
  return {
    streamId: view.streamId, baselineId: view.inventoryBaselineId, total: 20,
    revision: "synthetic-revision", assignments,
  };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function previewRow(view, variationNumber = 11) {
  return view.variations.find((entry) => entry.variationNumber === variationNumber);
}

test("manual queue adds one descending untracked preview without changing the live selection", () => {
  const { view, queue } = fixture();
  const projected = projection.projectQueuedItem(view, queue);
  assert.deepEqual(projected.variations.map((entry) => entry.variationNumber), [11, 10, 9]);
  assert.deepEqual(previewRow(projected), {
    variationNumber: 11, queuedPreview: true, preset: false, recorded: false, current: false,
    sku: "TEE-L", item: "BAPE Tee", style: "Red", size: "L",
    observedPaymentStatusLabel: "untracked", selected: false,
  });
  assert.equal(projected.selectedVariationNumber, 10);
  assert.equal(projected.currentVariationNumber, 10);
  assert.equal(projected.activeBiddingVariationNumber, 10);
  assert.deepEqual(projected.inventory, view.inventory);
  assert.deepEqual(projected.auction, view.auction);
  assert.deepEqual(projected.mapping, view.mapping);
  assert.deepEqual(projected.activeAuctionMapping, view.activeAuctionMapping);
  const display = selector.createOptionDisplay(previewRow(projected), { formatItemName: (entry) => `${entry.item} ${entry.style}` });
  assert.equal(display.fullLabel, "#11 - untracked - BAPE Tee Red, size L");
  assert.equal(display.paymentTone, "neutral");
});

test("selecting a manual queue preview is read-only and retains actual live markers", () => {
  const { view, queue } = fixture();
  const projected = projection.projectQueuedItem(view, queue, 11);
  assert.equal(projected.isReviewingQueuePreview, true);
  assert.equal(projected.isReviewingHistory, true);
  assert.equal(projected.isReviewingPreset, false);
  assert.equal(projected.variationNumber, 11);
  assert.equal(projected.selectedVariationNumber, 11);
  assert.equal(projected.currentVariationNumber, 10);
  assert.equal(projected.activeBiddingVariationNumber, 10);
  assert.deepEqual(projected.activeAuctionMapping, view.activeAuctionMapping);
  assert.equal(projected.auction, null);
  assert.equal(projected.mapping, null);
  assert.deepEqual(projected.variations.filter((entry) => entry.selected).map((entry) => entry.variationNumber), [11]);
  assert.deepEqual(projected.variations.filter((entry) => entry.current).map((entry) => entry.variationNumber), [10]);
  assert.ok(projected.inventory.every((entry) => entry.selectionAllowed === false && entry.selectionReason === "queued_preview_read_only"));
  assert.deepEqual(projected.inventory.filter((entry) => entry.selected).map((entry) => entry.sku), ["TEE-L"]);
});

test("manual queue preview leaves historical and other future selections unchanged", () => {
  const { view, queue } = fixture();
  view.selectedVariationNumber = view.variationNumber = 9;
  view.isReviewingHistory = true;
  const historical = projection.projectQueuedItem(view, queue, 9);
  assert.equal(historical.selectedVariationNumber, 9);
  assert.equal(historical.isReviewingQueuePreview, undefined);
  assert.deepEqual(historical.inventory, view.inventory);
  assert.deepEqual(historical.variations.filter((entry) => entry.selected).map((entry) => entry.variationNumber), [9]);
  const future = projection.project(view, plan(view), 15);
  const futureWithQueue = projection.projectQueuedItem(future, queue, 15);
  assert.equal(futureWithQueue.selectedVariationNumber, 15);
  assert.equal(futureWithQueue.isReviewingPreset, true);
  assert.equal(futureWithQueue.isReviewingQueuePreview, undefined);
  assert.deepEqual(futureWithQueue.inventory, future.inventory);
  assert.equal(previewRow(futureWithQueue).selected, false);
});

test("empty preset overlays are distinguishable previews and preserve the underlying plan", () => {
  const { view, queue } = fixture();
  const presets = plan(view);
  const projectedPresets = projection.project(view, presets);
  const before = structuredClone(projectedPresets);
  const projected = projection.projectQueuedItem(projectedPresets, queue, 11);
  assert.equal(projected.variations.length, 20);
  assert.equal(previewRow(projected).underlyingPreset, true);
  assert.equal(previewRow(projected).preset, false);
  assert.equal(previewRow(projected).queuedPreview, true);
  assert.equal(projected.isReviewingPreset, false);
  assert.equal(projected.isReviewingQueuePreview, true);
  assert.deepEqual(projectedPresets, before);
  assert.deepEqual(presets.assignments, []);
  const withoutQueue = projection.projectQueuedItem(projectedPresets, null);
  assert.equal(withoutQueue, projectedPresets);
  assert.equal(previewRow(withoutQueue).preset, true);
  assert.equal(previewRow(withoutQueue).sku, null);
});

test("assigned presets always win over a conflicting generic queue", () => {
  const { view, queue } = fixture();
  for (const sku of ["TEE-M", "TEE-L"]) {
    const withPreset = projection.project(view, plan(view, [{ variationNumber: 11, sku }]), 11);
    assert.equal(projection.projectQueuedItem(withPreset, queue, 11), withPreset);
    assert.equal(previewRow(withPreset).preset, true);
    assert.equal(previewRow(withPreset).queuedPreview, undefined);
    assert.equal(previewRow(withPreset).sku, sku);
  }
});

test("a queue arriving on an already selected empty preset immediately changes it to a read-only preview", () => {
  const { view, queue } = fixture();
  const presets = plan(view);
  const selectedEmptyPreset = projection.project(view, presets, 11);
  assert.equal(selectedEmptyPreset.isReviewingPreset, true);
  assert.ok(selectedEmptyPreset.inventory.every((entry) => entry.selectionAllowed));
  const preview = projection.projectQueuedItem(selectedEmptyPreset, queue);
  assert.equal(preview.selectedVariationNumber, 11);
  assert.equal(preview.variationNumber, 11);
  assert.equal(preview.isReviewingQueuePreview, true);
  assert.equal(preview.isReviewingPreset, false, "stale preset handlers cannot retain editable view intent");
  assert.equal(preview.isReviewingHistory, true);
  assert.equal(previewRow(preview).underlyingPreset, true);
  assert.equal(preview.auction, null);
  assert.equal(preview.mapping, null);
  assert.ok(preview.inventory.every((entry) => entry.selectionAllowed === false));
  assert.deepEqual(preview.inventory.filter((entry) => entry.selected).map((entry) => entry.sku), ["TEE-L"]);
  const afterClear = projection.projectQueuedItem(projection.project(view, presets, 11), null);
  assert.equal(afterClear.selectedVariationNumber, 11);
  assert.equal(afterClear.isReviewingPreset, true);
  assert.equal(afterClear.isReviewingQueuePreview, undefined);
  assert.ok(afterClear.inventory.every((entry) => entry.selectionAllowed));
  assert.equal(previewRow(afterClear).sku, null);
  assert.deepEqual(presets.assignments, []);
});

test("manual queue replacement updates exact SKU once and never creates duplicate rows", () => {
  const { view, queue } = fixture();
  const first = projection.projectQueuedItem(view, queue, 11);
  const replacement = { ...queue, queuedSku: "TEE-M", queueToken: "replacement-token" };
  const second = projection.projectQueuedItem(view, replacement, 11);
  assert.equal(previewRow(first).sku, "TEE-L");
  assert.equal(previewRow(second).sku, "TEE-M");
  assert.equal(previewRow(second).size, "M");
  assert.deepEqual(second.inventory.filter((entry) => entry.selected).map((entry) => entry.sku), ["TEE-M"]);
  const repeated = projection.projectQueuedItem(second, replacement, 11);
  assert.equal(repeated.variations.filter((entry) => entry.variationNumber === 11).length, 1);
  assert.deepEqual(repeated, second);
});

test("manual queue previews reject missing, cleared, stale stream/baseline, and unknown SKU snapshots", () => {
  const { view, queue } = fixture();
  for (const invalid of [null, undefined, {},
    { ...queue, queuedSku: null }, { ...queue, queuedSku: "" },
    { ...queue, queuedSku: " TEE-L " }, { ...queue, queuedSku: "UNKNOWN" },
    { ...queue, streamId: "other-stream" }, { ...queue, baselineId: "other-baseline" },
    { ...queue, streamId: "" }, { ...queue, baselineId: null },
  ]) assert.equal(projection.projectQueuedItem(view, invalid, 11), view);
  const missingBaseline = { ...view, inventoryBaselineId: undefined };
  assert.equal(projection.projectQueuedItem(missingBaseline, queue), missingBaseline);
  assert.equal(projection.projectQueuedItem(null, queue), null);
  assert.equal(projection.projectQueuedItem(view, { ...queue, queueToken: null }).variations.length, 3,
    "last-known display is allowed when the independent clear token has been invalidated");
});

test("manual queue previews require an anchored recorded source and do not follow late queues forward", () => {
  const { view, queue } = fixture();
  for (const changes of [
    { currentVariationNumber: 11 }, { currentVariationNumber: 9 },
    { variations: [] },
    { variations: [{ variationNumber: 10, recorded: false }] },
    { variations: [{ variationNumber: 10, recorded: true, preset: true }] },
  ]) {
    const stale = { ...view, ...changes };
    assert.equal(projection.projectQueuedItem(stale, queue, 11), stale);
  }
  for (const anchor of [null, undefined, 0, -1, "10", 10.5]) {
    assert.equal(projection.projectQueuedItem(view, { ...queue, armedAfterVariationNumber: anchor }), view);
  }
  const history = { ...view, selectedVariationNumber: 9, variationNumber: 9, isReviewingHistory: true };
  assert.equal(previewRow(projection.projectQueuedItem(history, queue)).variationNumber, 11,
    "the target comes from the queue anchor, never historical selection + 1");
  const noLongerBidding = { ...view, activeBiddingVariationNumber: null };
  assert.equal(previewRow(projection.projectQueuedItem(noLongerBidding, queue)).variationNumber, 11);
});

test("capture of the preview target suppresses the row without touching its saved mapping", () => {
  const { view, queue } = fixture();
  view.variations.unshift({ variationNumber: 11, recorded: true, sku: "TEE-M", item: "BAPE Tee", size: "M" });
  const before = structuredClone(view);
  assert.equal(projection.projectQueuedItem(view, queue, 11), view);
  assert.deepEqual(view, before);
});

test("manual queue previews have no preset-only cap and guard integer overflow", () => {
  for (const anchor of [1000, 9000, Number.MAX_SAFE_INTEGER - 1]) {
    const { view, queue } = fixture(anchor);
    const projected = projection.projectQueuedItem(view, queue, anchor + 1);
    assert.equal(previewRow(projected, anchor + 1).queuedPreview, true);
    assert.equal(projected.selectedVariationNumber, anchor + 1);
  }
  const { view, queue } = fixture(Number.MAX_SAFE_INTEGER);
  assert.equal(projection.projectQueuedItem(view, queue), view);
});

test("manual queue projection changes no data, payments, inventory quantities, accounting, or queue token", () => {
  const data = fixture();
  const before = structuredClone(data);
  freeze(data);
  for (const selected of [null, 11]) {
    const projected = projection.projectQueuedItem(data.view, data.queue, selected);
    assert.deepEqual(projected.totals, data.view.totals);
    assert.deepEqual(projected.warnings, data.view.warnings);
    for (const [index, entry] of projected.inventory.entries()) {
      for (const key of ["quantityReceived", "pendingQuantity", "soldQuantity", "remainingQuantity"])
        assert.equal(entry[key], data.view.inventory[index][key]);
    }
    assert.ok(projected.variations.filter((entry) => entry.recorded)
      .every((entry) => entry.observedPaymentStatusLabel === "bidding"));
    assert.deepEqual(data, before);
  }
});
