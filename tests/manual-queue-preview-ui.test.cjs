const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const projection = require("../extension/tagger/variation-presets-view.js");
const selector = require("../extension/tagger/variation-selector-view-model.js");
const source = fs.readFileSync(path.join(__dirname, "../extension/tagger/sidepanel.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const TOKEN = "11111111-1111-4111-8111-111111111111";
const BASELINE = "synthetic-baseline";

function declaration(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}

function registrations(target) {
  return [...source.matchAll(new RegExp(`^  ${target}\\.addEventListener\\(`, "gm"))].map(({ index }) => {
    const lineEnd = source.indexOf("\n", index);
    return source.slice(index, source.slice(index, lineEnd).endsWith(";") ? lineEnd : source.indexOf("\n  });", index) + 6);
  }).join("\n");
}

function element() {
  const attrs = new Map(), handlers = new Map();
  return {
    value: "", textContent: "", hidden: false, disabled: false, dataset: {}, children: [],
    classList: { add() {}, contains() { return false; } },
    contains() { return true; }, querySelectorAll() { return this.children; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children.flatMap(child => child.fragment ? child.children : [child]); },
    setAttribute(key, value) { attrs.set(key, String(value)); },
    getAttribute(key) { return attrs.get(key) ?? null; },
    removeAttribute(key) { attrs.delete(key); }, hasAttribute(key) { return attrs.has(key); },
    toggleAttribute(key, value) { if (value) attrs.set(key, ""); else attrs.delete(key); },
    focus() { this.focused = true; }, setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() {},
    addEventListener(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    async dispatch(type, extra = {}) {
      const event = { type, target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
      for (const handler of handlers.get(type) ?? []) await handler(event);
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const mutations = [], selections = [], refreshes = [];
  const view = {
    streamId: STREAM, inventoryBaselineId: BASELINE, currentVariationNumber: 10,
    selectedVariationNumber: 10, variationNumber: 10, activeBiddingVariationNumber: 10,
    isReviewingHistory: false, isReviewingPreset: false,
    variations: [10, 9].map(number => ({ variationNumber: number, recorded: true,
      selected: number === 10, bidding: number === 10, sku: "TEE-S", item: "Tee", style: "Red", size: "S" })),
    inventory: ["S", "M", "L"].map(size => ({ sku: `TEE-${size}`, item: "Tee", style: "Red", size,
      selected: size === "S", selectionAllowed: true, remainingQuantity: 10, reservedQuantity: size === "S" ? 1 : 0 })),
    auction: { variationNumber: 10, sku: "TEE-S", paymentStatus: "bidding" },
    mapping: { sku: "TEE-S" }, activeAuctionMapping: { variationNumber: 10, sku: "TEE-S" },
    totals: { completedGmvCents: 1000 }, warnings: [],
  };
  const queue = { streamId: STREAM, baselineId: BASELINE, queuedSku: "TEE-L", queueToken: TOKEN,
    armedAfterVariationNumber: 10 };
  const c = {
    variationPresetsView: projection, variationSelectorViewModel: selector,
    variationPresetsSnapshot: { streamId: STREAM, baselineId: BASELINE, total: null, revision: "r1", assignments: [] },
    variationPresetsReady: true, variationPresetsBusy: false, variationPresetsEditing: false,
    selectedPresetVariationNumber: null, selectedQueuedVariationNumber: null,
    queuedNextItemSnapshot: queue, queuedNextItemSku: queue.queuedSku, queuedNextItemToken: TOKEN,
    nextItemQueueMutationBusy: false, nextItemQueueMutationGeneration: 0, nextItemQueueRefreshGeneration: 0,
    variationNavigationGeneration: 0, mountedStreamId: STREAM,
    savedSnapshot: { phase: "ready", busy: false, view },
    streamSnapshot: { activeSession: { streamId: STREAM }, resumed: true, busy: false },
    pendingSavedAction: null, activeStreamInventoryUpdateBusy: false, archivedReportsViewOpen: false,
    endConfirmationOpen: false, inventorySizeMenuState: null, activeInventorySizeSku: null,
    variationSelectorOpen: false, activeVariationNumber: null,
    capturePlanningOverride: null,
    document: { activeElement: null, createElement: element,
      createDocumentFragment: () => Object.assign(element(), { fragment: true }) },
    isCapturePlanningTarget: () => false,
    isCapturePlanningLocked: () => c.isCaptureInteractionLocked(),
    isCapturePlanningEnabled: () => false,
    updateVariationPresetsAvailability() {},
    releaseVariationSelector() {},
    releaseInventorySizeMenu() { c.inventorySizeMenuState = null; },
    renderInventory() { c.renderQueuedItemBadge(); },
    renderAll() { c.reconcileQueuedPreviewSelection(); c.renderVariationSelectorOptions(c.getActiveView()); c.renderVariationNavigation(c.getActiveView()); c.renderQueuedItemBadge(); return c.getActiveView(); },
    getFocusedInventorySku: () => null,
    getVariationOptionDisplay: row => selector.createOptionDisplay(row, { formatItemName: entry => `${entry.item}${entry.style ? ` - ${entry.style}` : ""}` }),
    createVariationOptionContent: display => ({ textContent: display.fullLabel }),
    describeSelectedVariation: current => `Variation #${current.selectedVariationNumber}`,
    scheduleVariationPresetsRefresh() { refreshes.push("presets"); },
    scheduleCaptureRefresh() { refreshes.push("capture"); },
    scheduleNextItemQueueRefresh() { refreshes.push("queue"); },
    getFuturePresetContext: () => null, isFuturePresetContextCurrent: () => false,
    mutateVariationPresets() { mutations.push("preset"); },
    runSavedMutation() { mutations.push("mapping"); },
    openInventorySizeMenu() { mutations.push("size-picker"); },
    toggleNextItemQueue() { mutations.push("queue"); },
    mapCurrentVariationFromHistory() { mutations.push("live-map"); },
    assignNextFuturePreset() { mutations.push("sequence"); },
    nextVariationHasPreset: () => false,
    nextItemQueueClient: {
      async clearQueue(command) { mutations.push({ clear: clone(command) }); return { status: "cleared", queuedSku: null }; },
    },
    persistentController: {
      selectVariation(number, options) {
        assert.ok(view.variations.some(row => row.variationNumber === number), "Never select a fabricated canonical variation");
        selections.push(number);
        view.selectedVariationNumber = number;
        view.variationNumber = number;
        view.isReviewingHistory = options?.holdSelection === true || number !== view.currentVariationNumber;
        view.variations.forEach(row => { row.selected = row.variationNumber === number; });
        return { view };
      },
    },
    console: { error() {} },
  };
  for (const name of ["variationSelector", "variationSelectorValue", "variationListbox", "variationContext",
    "variationSearchForm", "variationSearchInput", "variationStepControls", "previousVariationButton", "nextVariationButton",
    "returnToCurrentButton", "trackerWorkspace", "captureHealthBadge", "mappingAnnouncement", "searchInput",
    "inventoryGrid", "inventorySizeListbox", "queuedItemSlot", "queuedItemBadge", "queuedItemLabel", "queuedItemTooltip", "clearQueuedItemButton"]) c[name] = element();
  c.captureHealthBadge.dataset.phase = "active";
  c.variationSelectorLock = { requestRender: current => c.renderVariationSelectorOptions(current) };
  vm.createContext(c);
  vm.runInContext([
    "getActiveView", "getRecordedVariations", "getSelectableVariations", "hasSelectedRecordedVariation", "hasSelectedEditableVariation", "reconcileQueuedPreviewSelection", "isQueuePreviewInteraction",
    "findVariationOption", "getCurrentVariationMappedSku", "isCurrentVariationMapped",
    "isCaptureInteractionLocked", "guardCaptureInteraction", "canChangeVariationPresets", "canUseVariationPresetData",
    "selectVariationFromPicker", "canSubmitVariationSearch", "updateVariationSearchAvailability", "submitVariationSearch",
    "canStepVariation", "getAdjacentVariationNumber", "updateVariationStepAvailability", "stepVariation",
    "renderVariationSelectorOptions", "renderVariationNavigation",
    "saveOrdinaryInventorySelection", "selectInventorySizeFromPicker", "commitActiveInventorySize", "handleInventorySizeMenuKeydown",
    "getQueuedItemPresentation", "formatQueuedItemBadge", "canClearQueuedItem", "updateQueuedItemBadgeAvailability", "renderQueuedItemBadge", "clearQueuedItem",
  ].map(declaration).join("\n"), c);
  vm.runInContext(["variationSearchForm", "previousVariationButton", "nextVariationButton", "returnToCurrentButton", "inventoryGrid"].map(registrations).join("\n"), c);
  return { c, view, queue, mutations, selections, refreshes,
    select(number = 11) { c.selectVariationFromPicker(number); },
    clear() { return c.clearQueuedItem({ type: "click", target: c.clearQueuedItemButton, preventDefault() {}, stopImmediatePropagation() {} }); },
  };
}

function inventoryButton({ multiple = false } = {}) {
  const button = element();
  button.dataset.sku = "TEE-L";
  button.dataset.multipleSizes = String(multiple);
  button.closest = selector => selector === ".inventory-card" ? button : null;
  return button;
}

test("manual queued preview appears in the real dropdown and exact-number lookup without changing captured data", async () => {
  const f = fixture(), c = f.c;
  const before = JSON.stringify({ view: f.view, queue: f.queue, presets: c.variationPresetsSnapshot });
  c.renderAll();
  const option = c.variationListbox.children.find(row => row.dataset.variationNumber === "11");
  assert.ok(option);
  assert.match(option.getAttribute("aria-label"), /#11.*untracked.*Tee.*L/i);
  c.variationSearchInput.value = "11";
  await c.variationSearchForm.dispatch("submit");
  const preview = c.getActiveView();
  assert.equal(preview.isReviewingQueuePreview, true);
  assert.equal(preview.selectedVariationNumber, 11);
  assert.equal(preview.currentVariationNumber, 10);
  assert.equal(preview.activeBiddingVariationNumber, 10);
  assert.equal(preview.auction, null);
  assert.equal(preview.mapping, null);
  assert.equal(c.hasSelectedEditableVariation(preview), false);
  assert.ok(preview.inventory.every(entry => entry.selectionAllowed === false));
  assert.equal(JSON.stringify({ view: f.view, queue: f.queue, presets: c.variationPresetsSnapshot }), before);
  assert.deepEqual(f.selections, []);
  assert.deepEqual(f.mutations, []);
});

test("arrows navigate to the manual preview and Return to live removes its local selection and search draft", async () => {
  const f = fixture(), c = f.c;
  await c.nextVariationButton.dispatch("click");
  assert.equal(c.getActiveView().isReviewingQueuePreview, true);
  assert.equal(c.getAdjacentVariationNumber(1), null);
  c.renderVariationNavigation(c.getActiveView());
  assert.equal(c.returnToCurrentButton.hidden, false);
  await c.previousVariationButton.dispatch("click");
  assert.equal(c.getActiveView().selectedVariationNumber, 10);
  f.select();
  c.variationSearchInput.value = "11";
  await c.returnToCurrentButton.dispatch("click");
  assert.equal(c.selectedQueuedVariationNumber, null);
  assert.equal(c.getActiveView().selectedVariationNumber, 10);
  assert.equal(c.variationSearchInput.value, "");
  assert.equal(c.queuedNextItemSku, "TEE-L");
  assert.deepEqual(f.mutations, []);
});

test("manual queue preview rejects left/right/native-keyboard and programmatic size or mapping actions", async () => {
  const f = fixture(), c = f.c;
  f.select();
  for (const multiple of [false, true]) {
    const button = inventoryButton({ multiple });
    for (const type of ["click", "contextmenu"]) await c.inventoryGrid.dispatch(type, { target: button });
    for (const key of ["ContextMenu", "F10", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " "]) {
      await c.inventoryGrid.dispatch("keydown", { target: button, key, shiftKey: key === "F10" });
    }
    c.saveOrdinaryInventorySelection(button, c.getActiveView());
    for (const intent of ["ordinary", "context", "preset_current", "preset_sequence"]) {
      c.inventorySizeMenuState = { streamId: STREAM, selectedVariationNumber: 11, currentVariationNumber: 10, intent, trigger: button };
      c.selectInventorySizeFromPicker("TEE-L");
    }
  }
  assert.deepEqual(f.mutations, []);
  assert.equal(c.queuedNextItemSku, "TEE-L");
  assert.equal(c.getActiveView().selectedVariationNumber, 11);
});

test("manual preview follows authoritative queue replacements and cannot duplicate an existing preset slot", () => {
  const f = fixture(), c = f.c;
  f.select();
  c.queuedNextItemSnapshot = { ...f.queue, queuedSku: "TEE-M", queueToken: "22222222-2222-4222-8222-222222222222" };
  c.queuedNextItemSku = "TEE-M";
  c.queuedNextItemToken = c.queuedNextItemSnapshot.queueToken;
  c.renderAll();
  const row = c.getActiveView().variations.find(entry => entry.variationNumber === 11);
  assert.equal(row.sku, "TEE-M");
  assert.equal(c.getActiveView().selectedVariationNumber, 11);
  c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, total: 20, assignments: [] };
  assert.equal(c.getActiveView().variations.filter(entry => entry.variationNumber === 11).length, 1);
  assert.deepEqual(f.mutations, []);
});

test("loading and unrelated safeguards prevent queued-preview search or arrow navigation", async () => {
  for (const apply of [
    c => { c.captureHealthBadge.dataset.phase = "loading"; },
    c => { c.captureHealthBadge.dataset.phase = "connecting"; },
    c => { c.savedSnapshot.busy = true; },
    c => { c.savedSnapshot.phase = "error"; },
    c => { c.streamSnapshot.busy = true; },
    c => { c.endConfirmationOpen = true; },
    c => { c.trackerWorkspace.setAttribute("inert", ""); },
  ]) {
    const f = fixture(), c = f.c;
    apply(c);
    c.searchInput.value = "keep inventory search draft";
    c.variationSearchInput.value = "11";
    await c.variationSearchForm.dispatch("submit");
    await c.nextVariationButton.dispatch("click");
    c.selectVariationFromPicker(11);
    assert.equal(c.getActiveView().selectedVariationNumber, 10, String(apply));
    assert.equal(c.searchInput.value, "keep inventory search draft", String(apply));
    assert.deepEqual(f.selections, []);
    assert.deepEqual(f.mutations, []);
  }
});

test("successful token-checked manual clear removes its selected temporary preview and returns to live without mapping", async () => {
  const f = fixture(), c = f.c;
  f.select();
  c.renderQueuedItemBadge();
  await f.clear();
  c.renderAll();
  assert.deepEqual(f.mutations, [{ clear: { expectedStreamId: STREAM, expectedQueueToken: TOKEN, sku: "TEE-L" } }]);
  assert.equal(c.queuedNextItemSnapshot, null);
  assert.equal(c.selectedQueuedVariationNumber, null);
  assert.equal(c.getActiveView().selectedVariationNumber, 10);
  assert.equal(c.getActiveView().variations.some(row => row.variationNumber === 11), false);
  assert.equal(c.queuedItemSlot.hidden, true);
  assert.equal(f.view.mapping.sku, "TEE-S");
});

test("clearing a queued overlay restores its underlying empty preset without deleting the planned range", async () => {
  const f = fixture(), c = f.c;
  c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, total: 20 };
  f.select();
  assert.equal(c.getActiveView().isReviewingQueuePreview, true);
  c.renderQueuedItemBadge();
  await f.clear();
  c.renderAll();
  const row = c.getActiveView().variations.find(entry => entry.variationNumber === 11);
  assert.equal(row.preset, true);
  assert.equal(row.recorded, false);
  assert.equal(row.sku, null);
  assert.equal(c.selectedPresetVariationNumber, 11);
  assert.equal(c.selectedQueuedVariationNumber, null);
  assert.equal(c.variationPresetsSnapshot.total, 20);
  assert.deepEqual(c.variationPresetsSnapshot.assignments, []);
});

test("failed manual clear preserves the queued preview and selected exact SKU while disabling stale clear token", async () => {
  const f = fixture(), c = f.c;
  c.nextItemQueueClient.clearQueue = async () => { throw new Error("Synthetic queue clear failure"); };
  f.select();
  c.renderQueuedItemBadge();
  await f.clear();
  c.renderAll();
  assert.equal(c.getActiveView().isReviewingQueuePreview, true);
  assert.equal(c.getActiveView().inventory.find(entry => entry.selected).sku, "TEE-L");
  assert.equal(c.queuedNextItemSnapshot.queuedSku, "TEE-L");
  assert.equal(c.clearQueuedItemButton.disabled, true);
  assert.match(c.mappingAnnouncement.textContent, /Synthetic queue clear failure/);
  assert.ok(f.refreshes.includes("queue"));
});

test("late clear completion cannot remove a replacement queue preview or override navigation away", async () => {
  for (const navigateAway of [false, true]) {
    const f = fixture(), c = f.c, reply = deferred();
    c.nextItemQueueClient.clearQueue = () => reply.promise;
    f.select();
    c.renderQueuedItemBadge();
    const pending = f.clear();
    c.queuedNextItemSnapshot = { ...f.queue, queuedSku: "TEE-M", queueToken: "22222222-2222-4222-8222-222222222222" };
    c.queuedNextItemSku = "TEE-M";
    c.queuedNextItemToken = c.queuedNextItemSnapshot.queueToken;
    c.nextItemQueueRefreshGeneration++;
    if (navigateAway) c.selectVariationFromPicker(9);
    reply.resolve({ status: "cleared", queuedSku: null });
    await pending;
    c.renderAll();
    assert.equal(c.queuedNextItemSnapshot.queuedSku, "TEE-M");
    assert.equal(c.getActiveView().selectedVariationNumber, navigateAway ? 9 : 11);
    assert.equal(c.getActiveView().variations.find(row => row.variationNumber === 11).sku, "TEE-M");
    assert.equal(f.view.mapping.sku, "TEE-S");
  }
});

test("real capture replaces its selected preview with a held captured view, never retaining a fake order or assignment", () => {
  const f = fixture(), c = f.c;
  f.select();
  f.view.variations.unshift({ variationNumber: 11, recorded: true, sku: "TEE-L", item: "Tee", size: "L" });
  f.view.currentVariationNumber = 11;
  f.view.activeBiddingVariationNumber = 11;
  c.queuedNextItemSnapshot = null;
  c.queuedNextItemSku = null;
  c.queuedNextItemToken = null;
  c.renderAll();
  assert.equal(c.selectedQueuedVariationNumber, null);
  assert.equal(c.getActiveView().selectedVariationNumber, 11);
  assert.equal(c.getActiveView().isReviewingQueuePreview, undefined);
  assert.equal(c.getActiveView().isReviewingHistory, true, "Capture does not silently restore follow-live intent");
  assert.equal(c.getActiveView().variations.filter(row => row.variationNumber === 11).length, 1);
  assert.equal(c.getActiveView().variations.find(row => row.variationNumber === 11).recorded, true);
  assert.deepEqual(f.mutations, []);
});

test("skipped capture removes a temporary preview and a consumed old snapshot cannot move forward to the newer auction", () => {
  const f = fixture(), c = f.c;
  f.select();
  f.view.variations.unshift({ variationNumber: 13, recorded: true, sku: "TEE-L" });
  f.view.currentVariationNumber = 13;
  f.view.activeBiddingVariationNumber = 13;
  c.renderAll();
  assert.equal(c.selectedQueuedVariationNumber, null);
  assert.equal(c.getActiveView().selectedVariationNumber, 13);
  assert.equal(c.getActiveView().variations.some(row => row.queuedPreview), false);
  assert.equal(c.getActiveView().variations.some(row => row.variationNumber === 14), false);
  assert.deepEqual(f.mutations, []);
});

test("queue preview removal or capture after a newer user selection cannot steal that selection", () => {
  for (const captured of [false, true]) {
    const f = fixture(), c = f.c;
    f.select();
    c.selectVariationFromPicker(9);
    c.queuedNextItemSnapshot = null;
    c.queuedNextItemSku = null;
    c.queuedNextItemToken = null;
    if (captured) {
      f.view.variations.unshift({ variationNumber: 11, recorded: true, sku: "TEE-L" });
      f.view.currentVariationNumber = 11;
      f.view.activeBiddingVariationNumber = 11;
    }
    c.renderAll();
    assert.equal(c.getActiveView().selectedVariationNumber, 9);
    assert.deepEqual(f.mutations, []);
  }
});

test("stale readonly preview cards cannot become editable mappings after capture or navigation", async () => {
  const f = fixture(), c = f.c;
  f.select();
  const button = inventoryButton({ multiple: true });
  button.queuedPreviewReadOnly = true;
  c.selectVariationFromPicker(10);
  for (const type of ["click", "contextmenu"]) await c.inventoryGrid.dispatch(type, { target: button });
  for (const key of ["ContextMenu", "ArrowDown", "F10"]) await c.inventoryGrid.dispatch("keydown", { target: button, key, shiftKey: key === "F10" });
  c.saveOrdinaryInventorySelection(button, c.getActiveView());
  assert.deepEqual(f.mutations, []);
  assert.equal(f.view.mapping.sku, "TEE-S");
});

test("actual direct queue/mapping/preset mutators and size opening cannot bypass readonly preview origin", async () => {
  const f = fixture(), c = f.c;
  vm.runInContext(["toggleNextItemQueue", "mapCurrentVariationFromHistory", "assignNextFuturePreset", "openInventorySizeMenu"].map(declaration).join("\n"), c);
  f.select();
  const button = inventoryButton({ multiple: true });
  button.queuedPreviewReadOnly = true;
  for (const leavePreview of [false, true]) {
    if (leavePreview) c.selectVariationFromPicker(10);
    const view = c.getActiveView();
    await c.toggleNextItemQueue(button, view);
    await c.mapCurrentVariationFromHistory(button, view);
    await c.assignNextFuturePreset(button, null);
    c.saveOrdinaryInventorySelection(button, view);
    assert.equal(c.openInventorySizeMenu(button, "ordinary"), false);
    c.inventorySizeMenuState = { trigger: button, streamId: STREAM,
      selectedVariationNumber: view.selectedVariationNumber, currentVariationNumber: 10, intent: "context" };
    c.selectInventorySizeFromPicker("TEE-L");
  }
  assert.deepEqual(f.mutations, []);
  assert.equal(f.view.mapping.sku, "TEE-S");
});

test("out-of-order queue refreshes cannot resurrect cleared previews or retarget a new stream or baseline", async () => {
  const f = fixture(), c = f.c;
  const replies = [deferred(), deferred(), deferred()];
  let index = 0;
  c.nextItemQueueClient.getQueueSnapshot = () => replies[index++].promise;
  vm.runInContext(declaration("scheduleNextItemQueueRefresh"), c);
  f.select();
  c.scheduleNextItemQueueRefresh();
  await settle();
  c.scheduleNextItemQueueRefresh();
  await settle();
  replies[1].resolve({ queuedSku: null, queueToken: null, streamId: null, baselineId: null, armedAfterVariationNumber: null });
  await settle();
  replies[0].resolve(f.queue);
  await settle();
  assert.equal(c.queuedNextItemSnapshot, null);
  assert.equal(c.selectedQueuedVariationNumber, null);
  assert.equal(c.getActiveView().variations.some(row => row.queuedPreview), false);
  c.scheduleNextItemQueueRefresh();
  await settle();
  c.mountedStreamId = "new-stream";
  c.streamSnapshot.activeSession.streamId = "new-stream";
  replies[2].resolve(f.queue);
  await settle();
  assert.equal(c.queuedNextItemSnapshot, null);
  c.mountedStreamId = STREAM;
  c.streamSnapshot.activeSession.streamId = STREAM;
  c.queuedNextItemSnapshot = { ...f.queue, baselineId: "wrong-baseline" };
  assert.equal(c.getActiveView().variations.some(row => row.queuedPreview), false);
});

test("a queue snapshot arriving after capture never creates the preview on the newer next variation", async () => {
  const f = fixture(), c = f.c, reply = deferred();
  c.nextItemQueueClient.getQueueSnapshot = () => reply.promise;
  vm.runInContext(declaration("scheduleNextItemQueueRefresh"), c);
  c.scheduleNextItemQueueRefresh();
  await settle();
  f.view.variations.unshift({ variationNumber: 11, recorded: true, sku: "TEE-L" });
  Object.assign(f.view, { currentVariationNumber: 11, selectedVariationNumber: 11, activeBiddingVariationNumber: 11 });
  reply.resolve(f.queue);
  await settle();
  assert.equal(c.getActiveView().variations.some(row => row.queuedPreview), false);
  assert.equal(c.getActiveView().variations.some(row => row.variationNumber === 12), false);
  assert.equal(c.getActiveView().selectedVariationNumber, 11);
});

test("canonical inventory repinning refetches the unchanged queue preview once per baseline transition before selection repair", () => {
  const f = fixture(), c = f.c, effects = [];
  c.lastRenderedSavedVariations = new Map();
  c.scheduleNextItemQueueRefresh = () => effects.push("queue-refetch");
  c.reconcileQueuedPreviewSelection = () => { effects.push("selection-repair"); return false; };
  // Stop downstream presentation after testing the actual canonical snapshot
  // acceptance/repin flow; capture promotion itself has separate coverage.
  c.preserveCapturedPresetSelection = () => true;
  vm.runInContext(declaration("renderSavedSnapshot"), c);
  const repinned = { ...clone(f.view), inventoryBaselineId: "appended-stock-baseline" };
  const snapshot = { phase: "ready", busy: false, operation: "refresh", view: repinned };
  c.renderSavedSnapshot(snapshot);
  assert.deepEqual(effects, ["queue-refetch", "selection-repair"]);
  assert.equal(c.savedSnapshot.view.inventoryBaselineId, "appended-stock-baseline");
  assert.equal(c.queuedNextItemSnapshot.baselineId, BASELINE, "Canonical rendering waits for the authoritative queue reply");
  assert.equal(c.queuedNextItemSnapshot.queuedSku, "TEE-L");
  effects.length = 0;
  c.renderSavedSnapshot(snapshot);
  c.renderSavedSnapshot({ ...snapshot, operation: null });
  assert.deepEqual(effects, ["selection-repair", "selection-repair"], "Ordinary renders do not poll the queue");
  c.queuedNextItemSnapshot = { ...f.queue, baselineId: "appended-stock-baseline" };
  effects.length = 0;
  c.renderSavedSnapshot({ ...snapshot, view: { ...repinned, inventoryBaselineId: "another-append-baseline" } });
  assert.deepEqual(effects, ["queue-refetch", "selection-repair"], "A later real repin permits one fresh read");
  assert.deepEqual(f.mutations, []);
});

test("canonical repin queue refetch is skipped for unchanged identity, no queue, another stream and early loading", () => {
  for (const scenario of ["same-baseline", "no-queue", "other-stream", "loading", "error", "already-current-queue"]) {
    const f = fixture(), c = f.c;
    c.lastRenderedSavedVariations = new Map();
    c.reconcileQueuedPreviewSelection = () => false;
    c.preserveCapturedPresetSelection = () => true;
    vm.runInContext(declaration("renderSavedSnapshot"), c);
    const view = { ...clone(f.view), inventoryBaselineId: "appended-stock-baseline" };
    const snapshot = { phase: "ready", busy: false, operation: "refresh", view };
    if (scenario === "same-baseline") view.inventoryBaselineId = BASELINE;
    if (scenario === "no-queue") c.queuedNextItemSnapshot = null;
    if (scenario === "other-stream") view.streamId = "different-stream";
    if (scenario === "loading" || scenario === "error") snapshot.phase = scenario;
    if (scenario === "already-current-queue") c.queuedNextItemSnapshot = { ...f.queue, baselineId: view.inventoryBaselineId };
    c.renderSavedSnapshot(snapshot);
    assert.deepEqual(f.refreshes, [], scenario);
    assert.deepEqual(f.mutations, [], scenario);
  }
});
