const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const projection = require("../extension/tagger/variation-presets-view.js");
const protocol = require("../extension/shared/variation-presets-protocol.js");
const selector = require("../extension/tagger/variation-selector-view-model.js");
const tagger = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

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
  const attrs = new Map();
  const handlers = new Map();
  return {
    value: "", hidden: false, disabled: false, textContent: "", dataset: {}, children: [],
    classList: { contains: () => false },
    contains(target) { return target === this || this.children.some(child => child.contains?.(target)); },
    querySelectorAll: () => [],
    setAttribute(key, value) { attrs.set(key, String(value)); },
    getAttribute(key) { return attrs.get(key) ?? null; },
    hasAttribute(key) { return attrs.has(key); },
    removeAttribute(key) { attrs.delete(key); },
    toggleAttribute(key, value) { if (value) attrs.set(key, ""); else attrs.delete(key); },
    setCustomValidity(value) { this.validationMessage = value; },
    reportValidity() { this.reported = true; },
    focus() { this.focused = true; },
    addEventListener(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    async dispatch(type, extra = {}) {
      const event = { type, target: this, preventDefault() {}, stopImmediatePropagation() {}, ...extra };
      await Promise.all((handlers.get(type) ?? []).map((handler) => handler(event)));
    },
  };
}
function baselineView() {
  return {
    streamId: "synthetic-stream", currentVariationNumber: 30, selectedVariationNumber: 30,
    variationNumber: 30, isReviewingHistory: false, activeBiddingVariationNumber: 30,
    activeAuctionMapping: { variationNumber: 30, sku: "A", unitCostCents: 500 },
    variations: [30, 29, 1].map((variationNumber) => ({ variationNumber,
      recorded: true, selected: variationNumber === 30, sku: "A", item: "LA", style: "Hoodie", size: "M", observedPaymentStatus: "payment_complete" })),
    inventory: [{ sku: "A", item: "LA", style: "Hoodie", size: "M", remainingQuantity: 5,
      pendingQuantity: 1, soldQuantity: 2, selected: true, selectionAllowed: true }],
    auction: { variationNumber: 30, sku: "A", paymentStatus: "payment_processing" },
    mapping: { sku: "A" }, totals: { completedGmvCents: 2400, profitCents: 1400 }, warnings: [],
  };
}
function presetSnapshot(total = 200) {
  return { streamId: "synthetic-stream", baselineId: "synthetic-baseline", revision: "r1", total,
    assignments: total === null ? [] : [{ variationNumber: 80, sku: "A" }] };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ total = null, view = baselineView() } = {}) {
  const calls = [], selections = [], renders = [];
  const rawView = view;
  const context = {
    variationPresetsView: projection, variationPresetsProtocol: protocol,
    variationPresetsSnapshot: presetSnapshot(total), variationPresetsReady: true,
    variationPresetsEditing: false, variationPresetsBusy: false,
    variationPresetsEntryContext: null,
    variationPresetsGeneration: 0, variationPresetsReadGeneration: 0,
    selectedPresetVariationNumber: null, variationNavigationGeneration: 0,
    captureStateNotificationGeneration: 0,
    capturePlanningOverride: null, capturePlanningLoad: null, capturePlanningCycleGeneration: 0,
    document: element(),
    variationPresetsForm: element(), variationPresetsButton: element(), variationPresetsInput: element(),
    variationSearchForm: element(), variationSearchInput: element(),
    variationStepControls: element(), previousVariationButton: element(), nextVariationButton: element(),
    variationSelector: element(), searchInput: element(), returnToCurrentButton: element(),
    inventoryGrid: element(), inventorySizeListbox: element(),
    variationListbox: element(), clearSearchButton: element(), inventoryListToggle: element(),
    addActiveStreamSkusButton: element(), activeStreamInventoryUpdateForm: element(),
    retrySavedSessionButton: element(), retryStreamSessionButton: element(),
    trackerWorkspace: element(), captureHealthBadge: element(), mappingAnnouncement: element(),
    mountedStreamId: rawView.streamId,
    streamSnapshot: { activeSession: { streamId: rawView.streamId }, resumed: true, busy: false },
    savedSnapshot: { phase: "ready", busy: false, view: rawView },
    pendingSavedAction: null, endConfirmationOpen: false, nextItemQueueMutationBusy: false,
    activeStreamInventoryUpdateBusy: false, archivedReportsViewOpen: false, inventorySizeMenuState: null,
    updateQueuedItemBadgeAvailability() {}, scheduleNextItemQueueRefresh() {},
    setWorkspaceBusy() {},
    scheduleCaptureRefresh() {}, scheduleVariationPresetsRefresh() {},
    getFocusedInventorySku: () => null, formatItemName: (entry) => entry.item,
    renderInventory() {}, renderAll() { renders.push(context.getActiveView()); return context.getActiveView(); },
    releaseVariationSelector() {},
    releaseInventorySizeMenu() { context.inventorySizeMenuState = null; },
    describeSelectedVariation(view) { return `Variation ${view.selectedVariationNumber}`; },
    persistentController: {
      selectVariation(number) {
        selections.push(number);
        rawView.selectedVariationNumber = number;
        rawView.isReviewingHistory = number !== rawView.currentVariationNumber;
        rawView.variations.forEach((entry) => { entry.selected = entry.variationNumber === number; });
        return { view: rawView };
      },
      mapSelectedSku() { assert.fail("A placeholder cannot map a canonical variation"); },
      unmapSelectedVariation() { assert.fail("A placeholder cannot unmap a canonical variation"); },
    },
    variationPresetsClient: {},
    console: { error() {} },
  };
  context.variationPresetsForm.contains = (target) =>
    [context.variationPresetsForm, context.variationPresetsButton, context.variationPresetsInput].includes(target);
  context.inventoryGrid.contains = (button) => button.contained !== false;
  for (const kind of ["createPresets", "setPresetItem", "resetPresets", "assignNextPresetItem"]) {
    context.variationPresetsClient[kind] = async (command) => {
      calls.push({ kind, command: clone(command) });
      const next = clone(context.variationPresetsSnapshot);
      next.revision = `${next.revision}-next`;
      if (kind === "createPresets") { next.total = command.total; delete next.extensionAvailable; }
      if (kind === "resetPresets") { next.total = null; next.assignments = []; delete next.extensionAvailable; }
      if (kind === "setPresetItem") {
        next.assignments = next.assignments.filter((entry) => entry.variationNumber !== command.variationNumber);
        if (command.sku !== null) next.assignments.push({ variationNumber: command.variationNumber, sku: command.sku });
      }
      if (kind === "assignNextPresetItem") {
        const assigned = new Set(next.assignments.map((entry) => entry.variationNumber));
        const captured = new Set(rawView.variations.filter((entry) => entry.recorded).map((entry) => entry.variationNumber));
        let number = command.variationNumber;
        while (number <= next.total && (assigned.has(number) || captured.has(number))) number++;
        if (number > next.total) throw Object.assign(new Error("No more future variations."), { code: "NO_MORE_FUTURE_VARIATIONS" });
        next.assignments.push({ variationNumber: number, sku: command.sku });
        return { presets: next, assignedVariationNumber: number };
      }
      return next;
    };
  }
  context.captureHealthBadge.dataset.phase = "active";
  vm.createContext(context);
  vm.runInContext([
    "getActiveView", "getRecordedVariations", "getSelectableVariations", "hasSelectedRecordedVariation", "hasSelectedEditableVariation",
    "findVariationOption", "isCaptureInteractionLocked", "guardCaptureInteraction", "isCurrentVariationMapped", "getCurrentVariationMappedSku",
    "canUseVariationPresetData", "hasCapturePlanningScope", "isCapturePlanningEnabled", "isCapturePlanningLocked", "isCapturePlanningTarget", "handleCapturePlanningLoad", "syncCapturePlanningScope",
    "canChangeVariationPresets", "updateVariationPresetsAvailability", "mutateVariationPresets", "dismissVariationPresetsEntry", "submitVariationPresets", "snapshotIsBackgroundRefresh", "resetVariationPresetsDisplay", "preserveCapturedPresetSelection",
    "getFuturePresetContext", "isFuturePresetContextCurrent", "assignNextFuturePreset",
    "canSubmitVariationSearch", "updateVariationSearchAvailability", "submitVariationSearch", "selectVariationFromPicker", "nextVariationHasPreset",
    "canStepVariation", "getAdjacentVariationNumber", "updateVariationStepAvailability",
    "saveOrdinaryInventorySelection", "toggleNextItemQueue", "mapCurrentVariationFromHistory", "selectInventorySizeFromPicker",
  ].map(declaration).join("\n"), context);
  vm.runInContext(["variationPresetsForm", "variationPresetsButton", "variationPresetsInput", "variationSearchForm", "returnToCurrentButton"].map(registrations).join("\n"), context);
  const outsideDismissal = source.match(/^  document\.addEventListener\("pointerdown", dismissVariationPresetsEntry, true\);$/m);
  assert.ok(outsideDismissal, "Outside dismissal runs in capture phase, including clicks whose target stops propagation");
  vm.runInContext(outsideDismissal[0], context);
  vm.runInContext(registrations("inventoryGrid"), context);
  context.updateVariationPresetsAvailability();
  return { context, rawView, calls, selections, renders };
}

async function emptyStreamFixture({ beforeStateRead, ...options } = {}) {
  const reconciliation = require("../extension/shared/reconciliation.js");
  const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
  const controllerModule = require("../extension/tagger/persistent-tagger-controller.js");
  const state = reconciliation.createReconciliationState([
    { sku: "A", item: "LA", style: "Hoodie", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: "synthetic-stream" });
  const controller = controllerModule.createPersistentTaggerController({
    reconciliation, mappingWorkflow, streamId: "synthetic-stream",
    currentVariationNumber: 203, variationNumbers: [203, 202, 201, 200],
    client: {
      async getState() { await beforeStateRead?.(); return { state: clone(state), result: null }; },
      async initializeState() { assert.fail("Planning must not invent an inventory baseline"); },
      async mapVariation() { assert.fail("Planning must not map a canonical variation"); },
      async unmapVariation() { assert.fail("Planning must not unmap a canonical variation"); },
    },
  });
  const snapshot = await controller.start();
  assert.equal(snapshot.phase, "ready");
  const f = fixture({ ...options, view: snapshot.view });
  f.context.persistentController = controller;
  f.context.savedSnapshot = snapshot;
  f.state = state;
  return f;
}

function installVariationPicker(f) {
  const c = f.context, scrolled = [];
  function node(fragment = false) {
    const result = element();
    result.children = [];
    result.fragment = fragment;
    result.append = (...children) => result.children.push(...children);
    result.replaceChildren = (...children) => {
      result.children = children.flatMap(child => child.fragment ? child.children : [child]);
    };
    result.scrollIntoView = (options) => {
      assert.equal(c.variationListbox.hidden, false, "Scroll only after the popup is shown");
      scrolled.push({ number: Number(result.dataset.variationNumber), block: options.block });
    };
    return result;
  }
  c.document.createElement = () => node();
  c.document.createDocumentFragment = () => node(true);
  c.variationListbox = node();
  c.variationListbox.querySelectorAll = () => c.variationListbox.children;
  c.variationSelectorValue = node();
  c.variationSelectShell = element();
  c.variationSelectorOpen = false;
  c.activeVariationNumber = null;
  c.variationSelectorLock = { lock() { c.pickerLocked = true; } };
  c.showVariationListbox = () => { c.variationListbox.hidden = false; };
  c.releaseVariationSelector = () => {
    c.variationSelectorOpen = false;
    c.pickerLocked = false;
    c.variationListbox.hidden = true;
  };
  const removeAttribute = c.variationSelector.removeAttribute;
  c.variationSelector.removeAttribute = (key) => {
    removeAttribute(key);
    if (key === "data-variation-number") delete c.variationSelector.dataset.variationNumber;
  };
  c.getVariationOptionDisplay = entry => selector.createOptionDisplay(entry, { formatItemName: c.formatItemName });
  c.createVariationOptionContent = display => ({ textContent: display.fullLabel });
  vm.runInContext([
    "renderVariationSelectorOptions", "getVariationOptionRows", "setActiveVariation",
    "openVariationSelector", "moveActiveVariation", "moveActiveVariationToBoundary",
    "handleVariationSelectorKeydown", "commitActiveVariation",
  ].map(declaration).join("\n"), c);
  vm.runInContext(registrations("variationSelector"), c);
  const render = () => c.renderVariationSelectorOptions(c.getActiveView());
  render();
  return { scrolled, render };
}

function installPresetNavigation(f) {
  installVariationPicker(f);
  const c = f.context;
  c.variationContext = element();
  c.returnToCurrentButton.classList = { add() {} };
  c.variationSelectorLock.requestRender = view => c.renderVariationSelectorOptions(view);
  vm.runInContext(declaration("renderVariationNavigation"), c);
  c.renderAll = () => {
    const view = c.getActiveView();
    if (view) c.renderVariationNavigation(view);
    f.renders.push(view);
  };
  c.renderAll();
}

function installCaptureNotifications(c) {
  Object.assign(c, {
    CAPTURE_STATE_NOTIFICATION_CHANNEL: "tiktok-live-tracker.capture-state",
    CAPTURE_STATE_NOTIFICATION_VERSION: 1, CAPTURE_STATE_NOTIFICATION_TYPE: "capture_state_changed",
    chrome: { runtime: { id: "synthetic-extension" } },
    liveBidProtocol: require("../extension/shared/live-bid-protocol.js"),
    nextItemQueueProtocol: require("../extension/shared/next-item-queue-protocol.js"),
    scheduleLiveBidRefresh() {},
  });
  vm.runInContext(["isRecord", "hasExactKeys", "isCaptureStateChangedNotification",
    "isLiveBidChangedNotification", "handleCaptureStateChanged"].map(declaration).join("\n"), c);
  return {
    capture: { channel: c.CAPTURE_STATE_NOTIFICATION_CHANNEL, version: 1, event: { type: c.CAPTURE_STATE_NOTIFICATION_TYPE } },
    sender: { id: c.chrome.runtime.id },
  };
}

async function beginInitialPresetSave(f, total = 200) {
  const c = f.context;
  await c.variationPresetsButton.dispatch("click");
  c.variationPresetsInput.value = String(total);
  return c.variationPresetsForm.dispatch("submit");
}

test("successful initial pre-stream create immediately displays #1 and hides Return without a dropdown click", async () => {
  for (const phase of ["blank", "active"]) {
    const f = await emptyStreamFixture(), c = f.context;
    installPresetNavigation(f);
    c.captureHealthBadge.dataset.phase = phase;
    const before = JSON.stringify(f.state);
    await beginInitialPresetSave(f);
    assert.equal(c.selectedPresetVariationNumber, 1);
    assert.equal(c.variationSelector.dataset.variationNumber, "1");
    assert.equal(c.getActiveView().isReviewingPreset, true);
    assert.equal(c.getActiveView().auction, null);
    assert.equal(c.returnToCurrentButton.hidden, true);
    assert.equal(c.variationPresetsButton.textContent, "Reset presets");
    assert.equal(c.variationPresetsButton.focused, true);
    assert.match(c.mappingAnnouncement.textContent, /Planning untracked variation #1/);
    assert.equal(c.variationNavigationGeneration, 1);
    assert.equal(JSON.stringify(f.state), before);
    assert.equal(c.getActiveView().inventory[0].reservedQuantity, 0);
    await rightClick(f);
    assert.equal(c.selectedPresetVariationNumber, 1);
    await rightClick(f);
    assert.equal(c.selectedPresetVariationNumber, 2);
    assert.equal(c.returnToCurrentButton.hidden, true);
    assert.equal(JSON.stringify(f.state), before);
  }
});

test("reopening or refreshing existing presets never auto-selects #1 or replaces intentional planning", async () => {
  const f = await emptyStreamFixture({ total: 200 }), c = f.context;
  installPresetNavigation(f);
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), c);
  c.variationPresetsClient.getPresets = async () => clone(c.variationPresetsSnapshot);
  c.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(c.selectedPresetVariationNumber, null);
  assert.equal(c.variationSelectorValue.textContent, "Waiting for live auction variations");
  assert.equal(c.returnToCurrentButton.hidden, true);
  c.selectVariationFromPicker(80);
  c.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(c.selectedPresetVariationNumber, 80);
  assert.equal(c.returnToCurrentButton.hidden, true);
  assert.equal(f.calls.length, 0);
});

test("initial create during real tracking and exhausted-range extension never select #1", async () => {
  for (const total of [null, 100]) {
    const f = fixture({ total }), c = f.context;
    if (total !== null) advanceLive(f, 101);
    c.selectVariationFromPicker(29);
    installPresetNavigation(f);
    await beginInitialPresetSave(f);
    assert.equal(c.getActiveView().selectedVariationNumber, 29);
    assert.equal(c.selectedPresetVariationNumber, null);
    assert.equal(c.returnToCurrentButton.hidden, false);
  }
});

test("own successful-create notification before acknowledgement still selects #1 once", async () => {
  const f = await emptyStreamFixture(), c = f.context, reply = deferred();
  installPresetNavigation(f);
  const { sender } = installCaptureNotifications(c);
  const completed = { ...presetSnapshot(200), revision: "saved-initial", assignments: [] };
  c.variationPresetsClient.createPresets = () => reply.promise;
  const pending = beginInitialPresetSave(f); await settle();
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), c);
  c.variationPresetsClient.getPresets = async () => completed;
  c.handleCaptureStateChanged(protocol.createPresetsChangedNotification(), sender);
  await settle();
  assert.equal(c.variationPresetsEditing, false);
  assert.equal(c.selectedPresetVariationNumber, null);
  assert.equal(c.captureStateNotificationGeneration, 0);
  reply.resolve(completed); await pending;
  assert.equal(c.selectedPresetVariationNumber, 1);
  assert.equal(c.variationNavigationGeneration, 1);
  c.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(c.variationNavigationGeneration, 1);
  assert.equal(c.returnToCurrentButton.hidden, true);
});

test("an in-flight canonical refresh from the create notification finishes before initial #1 selection", async () => {
  let reads = 0;
  const read = deferred(), reply = deferred();
  const f = await emptyStreamFixture({ beforeStateRead: async () => { if (++reads === 2) await read.promise; } });
  const c = f.context;
  installPresetNavigation(f);
  const { sender } = installCaptureNotifications(c);
  c.persistentController.subscribe(snapshot => {
    c.savedSnapshot = snapshot;
    c.updateVariationPresetsAvailability();
    c.renderAll();
  });
  const completed = { ...presetSnapshot(200), revision: "created", assignments: [] };
  c.variationPresetsClient.createPresets = () => reply.promise;
  const pending = beginInitialPresetSave(f); await settle();
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), c);
  c.variationPresetsClient.getPresets = async () => completed;
  let background;
  c.scheduleCaptureRefresh = () => { background = c.persistentController.refresh(); };
  c.handleCaptureStateChanged(protocol.createPresetsChangedNotification(), sender); await settle();
  assert.equal(c.savedSnapshot.phase, "loading");
  reply.resolve(completed); await settle();
  assert.equal(c.selectedPresetVariationNumber, null);
  read.resolve(); await background; await pending;
  assert.equal(reads, 3, "The initial create adds one verification read behind the existing refresh");
  assert.equal(c.selectedPresetVariationNumber, 1);
  assert.equal(c.returnToCurrentButton.hidden, true);
  assert.equal(c.variationPresetsButton.disabled, false);
});

test("the post-create canonical read catches an already-persisted first capture absent from the panel snapshot", async () => {
  const f = await emptyStreamFixture(), c = f.context;
  require("../extension/shared/reconciliation.js").observeBiddingVariation(f.state, {
    streamId: c.mountedStreamId, variationNumber: 5,
  });
  assert.equal(c.getRecordedVariations(c.savedSnapshot.view).length, 0);
  await beginInitialPresetSave(f);
  assert.equal(c.selectedPresetVariationNumber, null);
  assert.equal(c.variationPresetsSnapshot.total, 200);
  assert.equal(c.persistentController.getSnapshot().view.currentVariationNumber, 5);
});

test("capture, navigation, reset or verification failure during the post-create read cannot force #1", async () => {
  for (const outcome of ["capture", "navigation", "reset", "failure"]) {
    let reads = 0;
    const read = deferred();
    const f = await emptyStreamFixture({ beforeStateRead: async () => { if (++reads === 2) await read.promise; } });
    const c = f.context;
    const { capture, sender } = installCaptureNotifications(c);
    c.persistentController.subscribe(snapshot => { c.savedSnapshot = snapshot; });
    const pending = beginInitialPresetSave(f); await settle();
    assert.equal(c.variationPresetsSnapshot.total, 200);
    assert.equal(c.selectedPresetVariationNumber, null);
    if (outcome === "capture") {
      require("../extension/shared/reconciliation.js").observeBiddingVariation(f.state, {
        streamId: c.mountedStreamId, variationNumber: 5,
      });
      c.handleCaptureStateChanged(capture, sender);
    } else if (outcome === "navigation") {
      c.selectedPresetVariationNumber = 80;
      c.variationNavigationGeneration++;
    } else if (outcome === "reset") c.resetVariationPresetsDisplay();
    if (outcome === "failure") read.reject(new Error("Synthetic read failure"));
    else read.resolve();
    await pending;
    assert.equal(c.selectedPresetVariationNumber, outcome === "navigation" ? 80 : null, outcome);
    if (outcome !== "reset") assert.equal(c.variationPresetsSnapshot.total, 200);
    if (outcome === "failure") assert.equal(c.savedSnapshot.phase, "error");
  }
});

test("capture during initial save prevents auto-selection even before the debounced view refresh", async () => {
  const reconciliation = require("../extension/shared/reconciliation.js");
  for (const updateView of [false, true]) {
    const f = await emptyStreamFixture(), c = f.context, reply = deferred();
    installPresetNavigation(f);
    const { capture, sender } = installCaptureNotifications(c);
    c.variationPresetsClient.createPresets = () => reply.promise;
    const pending = beginInitialPresetSave(f); await settle();
    reconciliation.observeVariations(f.state, { streamId: c.mountedStreamId, variationNumbers: [5] });
    if (updateView) c.savedSnapshot = await c.persistentController.refresh();
    else {
      c.handleCaptureStateChanged(capture, sender);
      assert.equal(c.getRecordedVariations(c.savedSnapshot.view).length, 0, "UI is still stale");
    }
    reply.resolve({ ...presetSnapshot(200), revision: "created", assignments: [] }); await pending;
    assert.equal(c.selectedPresetVariationNumber, null);
    assert.equal(c.variationPresetsSnapshot.total, 200, "The plan itself still saves");
    c.savedSnapshot = await c.persistentController.refresh(); c.renderAll();
    assert.equal(c.getActiveView().selectedVariationNumber, 5);
    assert.equal(c.getActiveView().currentVariationNumber, 5);
    assert.equal(c.returnToCurrentButton.hidden, true, "Following the captured live/latest variation needs no Return button");
  }
});

test("navigation during an initial save is not replaced by #1 or a late focus change", async () => {
  const f = await emptyStreamFixture(), c = f.context, reply = deferred();
  const completed = { ...presetSnapshot(200), revision: "created", assignments: [] };
  c.variationPresetsClient.createPresets = () => reply.promise;
  const pending = beginInitialPresetSave(f); await settle();
  // A view change after a saved-range notification must win over its delayed acknowledgement.
  c.variationPresetsSnapshot = completed;
  c.variationPresetsReadGeneration++;
  c.selectedPresetVariationNumber = 80;
  c.variationNavigationGeneration++;
  reply.resolve(completed); await pending;
  assert.equal(c.selectedPresetVariationNumber, 80);
  assert.equal(c.variationPresetsSnapshot.total, 200);
  assert.notEqual(c.variationPresetsButton.focused, true);
});

test("failed, canceled and stale initial creates never auto-select or reopen a discarded configuration", async () => {
  for (const outcome of ["failed", "reset", "baseline", "stream", "controller"]) {
    const f = await emptyStreamFixture(), c = f.context, reply = deferred();
    c.variationPresetsClient.createPresets = () => reply.promise;
    const pending = beginInitialPresetSave(f); await settle();
    if (outcome === "failed") reply.reject(new Error("Synthetic create failure"));
    else {
      if (outcome === "reset") c.resetVariationPresetsDisplay();
      if (outcome === "controller") c.persistentController = { ...c.persistentController };
      if (outcome === "stream") c.mountedStreamId = "new-stream";
      if (outcome === "baseline") {
        c.variationPresetsSnapshot = { ...presetSnapshot(null), baselineId: "new-baseline", revision: "replacement" };
        c.variationPresetsReadGeneration++;
        c.variationPresetsEntryContext = null;
      }
      reply.resolve({ ...presetSnapshot(200), revision: "old-create", assignments: [] });
    }
    await pending;
    assert.equal(c.selectedPresetVariationNumber, null, outcome);
    assert.notEqual(c.variationPresetsButton.focused, true, outcome);
  }
  const f = await emptyStreamFixture(), c = f.context;
  await c.variationPresetsButton.dispatch("click");
  c.variationPresetsInput.value = "200";
  await c.variationPresetsInput.dispatch("keydown", { key: "Escape" });
  await c.variationPresetsForm.dispatch("submit");
  assert.equal(c.selectedPresetVariationNumber, null);
  assert.equal(f.calls.length, 0);
});

test("Return stays hidden for offline future planning and returns normally after real capture", async () => {
  const reconciliation = require("../extension/shared/reconciliation.js");
  const f = await emptyStreamFixture(), c = f.context;
  installPresetNavigation(f);
  await beginInitialPresetSave(f);
  c.selectVariationFromPicker(80);
  assert.equal(c.returnToCurrentButton.hidden, true);
  reconciliation.observeBiddingVariation(f.state, { streamId: c.mountedStreamId, variationNumber: 1 });
  c.savedSnapshot = await c.persistentController.refresh(); c.renderAll();
  assert.equal(c.selectedPresetVariationNumber, 80);
  assert.equal(c.returnToCurrentButton.hidden, false);
  await c.returnToCurrentButton.dispatch("click"); c.savedSnapshot = c.persistentController.getSnapshot(); c.renderAll();
  assert.equal(c.getActiveView().selectedVariationNumber, 1);
  assert.equal(c.returnToCurrentButton.hidden, true, "Returning to live hides the button again");
  const live = fixture({ total: 200 });
  installPresetNavigation(live);
  assert.equal(live.context.returnToCurrentButton.hidden, true);
  live.context.selectVariationFromPicker(29); live.context.renderAll();
  assert.equal(live.context.returnToCurrentButton.hidden, false);
});

test("unrelated and untrusted notifications cannot suppress initial auto-selection", async () => {
  const f = await emptyStreamFixture(), c = f.context, reply = deferred();
  const { capture, sender } = installCaptureNotifications(c);
  c.variationPresetsClient.createPresets = () => reply.promise;
  const pending = beginInitialPresetSave(f); await settle();
  c.handleCaptureStateChanged(capture, { id: "other-extension" });
  c.handleCaptureStateChanged(capture, { ...sender, tab: {} });
  c.handleCaptureStateChanged({ ...capture, extra: true }, sender);
  c.handleCaptureStateChanged(c.nextItemQueueProtocol.createQueueChangedNotification(), sender);
  c.handleCaptureStateChanged(c.liveBidProtocol.createLiveBidChangedNotification(), sender);
  assert.equal(c.captureStateNotificationGeneration, 0);
  reply.resolve({ ...presetSnapshot(200), revision: "created", assignments: [] }); await pending;
  assert.equal(c.selectedPresetVariationNumber, 1);
});

test("initial save acknowledgement does not bypass newly active loading, error or session safeguards", async () => {
  for (const lock of [
    c => { c.captureHealthBadge.dataset.phase = "loading"; },
    c => { c.savedSnapshot.phase = "error"; },
    c => { c.streamSnapshot.resumed = false; },
    c => { c.endConfirmationOpen = true; },
  ]) {
    const f = await emptyStreamFixture(), c = f.context, reply = deferred();
    c.variationPresetsClient.createPresets = () => reply.promise;
    const pending = beginInitialPresetSave(f); await settle();
    lock(c);
    reply.resolve({ ...presetSnapshot(200), revision: "created", assignments: [] }); await pending;
    assert.equal(c.selectedPresetVariationNumber, null);
    assert.equal(c.variationPresetsSnapshot.total, 200);
    assert.equal(c.canChangeVariationPresets(), false);
    assert.equal(c.variationPresetsInput.disabled, true);
  }
});

test("fresh pre-stream presets open at #1 without changing descending order, selection, or accounting", async () => {
  for (const phase of ["active", "blank"]) {
    const f = await emptyStreamFixture({ total: 200 }), c = f.context;
    c.captureHealthBadge.dataset.phase = phase;
    const picker = installVariationPicker(f);
    const before = JSON.stringify([f.state, c.variationPresetsSnapshot, c.getActiveView()]);
    await c.variationSelector.dispatch("click");
    assert.equal(c.variationSelectorOpen, true);
    assert.equal(c.pickerLocked, true);
    assert.equal(c.activeVariationNumber, 1);
    assert.equal(c.variationSelector.getAttribute("aria-activedescendant"), "variation-option-1");
    assert.deepEqual(picker.scrolled, [{ number: 1, block: "nearest" }]);
    assert.equal(c.variationListbox.children[0].dataset.variationNumber, "200");
    assert.equal(c.variationListbox.children.at(-1).dataset.variationNumber, "1");
    assert.equal(c.variationListbox.children.some(row => row.getAttribute("aria-selected") === "true"), false);
    assert.equal(c.variationSelectorValue.textContent, "Waiting for live auction variations");
    assert.equal(JSON.stringify([f.state, c.variationPresetsSnapshot, c.getActiveView()]), before);
    assert.equal(f.calls.length, 0);
  }
});

test("pre-stream keyboard opening starts at #1 while explicit Home and End keep their existing boundaries", async () => {
  for (const [key, number] of [["Enter", 1], [" ", 1], ["F4", 1], ["ArrowDown", 1],
    ["ArrowUp", 1], ["PageDown", 1], ["PageUp", 1], ["Home", 200], ["End", 1]]) {
    const f = await emptyStreamFixture({ total: 200 }), c = f.context;
    const picker = installVariationPicker(f);
    await c.variationSelector.dispatch("keydown", { key });
    assert.equal(c.activeVariationNumber, number, key);
    assert.equal(picker.scrolled.at(-1).number, number, key);
    assert.equal(c.selectedPresetVariationNumber, null);
    await c.variationSelector.dispatch("keydown", { key: "Escape" });
    assert.equal(c.variationSelectorOpen, false);
    assert.equal(c.selectedPresetVariationNumber, null);
    assert.equal(f.calls.length, 0);
  }
});

test("confirming the initially highlighted #1 enables sequential planning without a captured order", async () => {
  const f = await emptyStreamFixture({ total: 200 }), c = f.context;
  installVariationPicker(f);
  const before = JSON.stringify(f.state);
  await c.variationSelector.dispatch("click");
  await c.variationSelector.dispatch("keydown", { key: "Enter" });
  assert.equal(c.selectedPresetVariationNumber, 1);
  assert.equal(c.getActiveView().isReviewingPreset, true);
  await rightClick(f);
  assert.equal(c.selectedPresetVariationNumber, 1);
  await rightClick(f);
  assert.equal(c.selectedPresetVariationNumber, 2);
  assert.equal(c.variationPresetsSnapshot.assignments.find(entry => entry.variationNumber === 1).sku, "A");
  assert.equal(c.variationPresetsSnapshot.assignments.find(entry => entry.variationNumber === 2).sku, "A");
  assert.equal(JSON.stringify(f.state), before);
});

test("reopening preserves an intentional future selection from Var # or sequential right-click instead of returning to #1", async () => {
  const f = await emptyStreamFixture({ total: 200 }), c = f.context;
  const picker = installVariationPicker(f);
  c.variationSearchInput.value = "80";
  await c.variationSearchForm.dispatch("submit");
  picker.render();
  await c.variationSelector.dispatch("click");
  assert.equal(c.activeVariationNumber, 80);
  c.releaseVariationSelector();
  await rightClick(f);
  picker.render();
  await c.variationSelector.dispatch("click");
  assert.equal(c.activeVariationNumber, 81);
  assert.equal(c.selectedPresetVariationNumber, 81);
});

test("any actual capture retains normal live and history menu opening even with Reload Site and no bidding marker", async () => {
  for (const phase of ["active", "blank"]) {
    const f = fixture({ total: 200 }), c = f.context;
    c.captureHealthBadge.dataset.phase = phase;
    f.rawView.activeBiddingVariationNumber = null;
    const picker = installVariationPicker(f);
    await c.variationSelector.dispatch("click");
    assert.equal(c.activeVariationNumber, 30);
    c.selectVariationFromPicker(29);
    picker.render();
    await c.variationSelector.dispatch("click");
    assert.equal(c.activeVariationNumber, 29);
    c.releaseVariationSelector();
    c.variationSelector.removeAttribute("data-variation-number");
    await c.variationSelector.dispatch("click");
    assert.equal(c.activeVariationNumber, 200, "Missing selection after real capture keeps the ordinary fallback");
  }
});

test("initial loading locks, disabled selectors and absence of presets still prevent opening", async () => {
  for (const phase of ["connecting", "loading"]) {
    const f = await emptyStreamFixture({ total: 200 }), c = f.context;
    const picker = installVariationPicker(f);
    c.captureHealthBadge.dataset.phase = phase;
    await c.variationSelector.dispatch("click");
    c.openVariationSelector();
    assert.equal(c.variationSelectorOpen, false);
    assert.equal(picker.scrolled.length, 0);
  }
  for (const total of [null, 200]) {
    const f = await emptyStreamFixture({ total }), c = f.context;
    const picker = installVariationPicker(f);
    if (total === null) assert.equal(c.variationSelector.getAttribute("aria-disabled"), "true");
    else c.variationSelector.setAttribute("aria-disabled", "true");
    await c.variationSelector.dispatch("click");
    assert.equal(c.variationSelectorOpen, false);
    assert.equal(picker.scrolled.length, 0);
  }
});

function installSavedRenderer(f) {
  const c = f.context;
  Object.assign(c, {
    previousSavedPhase: "loading", lastRenderedSavedVariations: new Map(),
    hasFocusedSavedError: false, captureRefreshFocusSku: null,
    captureRefreshHadVariationFocus: false, focusSavedWorkspaceAfterRetry: false,
    pendingTrackerEntryViewport: null,
    captureRefreshDirty: false, document: { activeElement: null },
    pendingMapping: { contains: () => false },
    endStreamButton: element(), confirmEndStreamButton: element(),
    savedSessionError: element(), savedSessionErrorTitle: element(),
    savedSessionErrorMessage: element(), retrySavedSessionButton: element(),
    streamSessionStatus: element(), variationSelectorLock: { isLocked: () => false },
    updateSessionControls() {}, getSavedStatusText: () => "Ready",
    setFooterStatus() {}, describeLiveRefresh: () => "",
    setTrackerWorkspaceVisible(visible) { c.trackerWorkspace.hidden = !visible; },
    syncCaptureInteractionLock() { c.updateVariationPresetsAvailability(); },
  });
  vm.runInContext([
    "renderSavedSnapshot", "restoreTrackerEntryViewport", "createSavedVariationSignatures", "setWorkspaceBusy",
    "snapshotIsBackgroundRefresh", "scheduleVariationPresetsRefresh",
  ].map(declaration).join("\n"), c);
}

function inventoryCard(f, sku = "A", multipleSizes = false) {
  const card = element();
  card.isInventoryCard = true;
  card.dataset = { sku, multipleSizes: String(multipleSizes), groupKey: "synthetic-group" };
  card.futurePresetContext = f.context.getFuturePresetContext(f.context.getActiveView());
  card.closest = (selector) => selector === ".inventory-card" ? card : null;
  return card;
}

async function rightClick(f, sku = "A") {
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f, sku) });
  await settle();
}

function installPlanningRuntime(f, phase = "loading") {
  const c = f.context;
  c.document.activeElement = null;
  c.variationSelectorOpen ??= false;
  c.variationSelectorLock ??= {};
  c.variationSelectorLock.isLocked = () => c.variationSelectorOpen;
  const row = element(), variation = element(), inventory = element(), metrics = element();
  row.classList.contains = name => name === "capture-health-row";
  variation.classList.contains = name => name === "current-auction";
  inventory.classList.contains = name => name === "inventory-section";
  variation.children = [c.variationSelector];
  inventory.children = [c.searchInput, c.inventoryGrid, c.inventoryListToggle, c.addActiveStreamSkusButton];
  c.trackerWorkspace.children = [row, variation, inventory, metrics];
  c.variationSearchForm.children = [c.variationSearchInput];
  c.variationStepControls.children = [c.previousVariationButton, c.nextVariationButton];
  c.inventoryGrid.contains = target => target === c.inventoryGrid || target?.isInventoryCard === true;
  const pin = element();
  c.inventoryGrid.querySelectorAll = () => [pin];
  c.inventoryListExpanded = false;
  c.inventoryGroupOrderController = { trimPinnedGroups: () => ({ changed: false }) };
  c.COLLAPSED_INVENTORY_ITEM_LIMIT = 9;
  vm.runInContext([
    "isTrackerInteractionTarget", "syncCaptureInteractionLock", "syncCaptureInventoryLock",
    "setWorkspaceBusy", "stepVariation",
  ].map(declaration).join("\n"), c);
  // The normal renderer reapplies this actual helper after replacing inventory
  // cards. Retain that step when the fixture isolates the selector rendering.
  const render = c.renderAll;
  c.renderAll = (...args) => { const result = render(...args); c.syncCaptureInventoryLock(); return result; };
  vm.runInContext(["previousVariationButton", "nextVariationButton", "searchInput", "inventoryListToggle"].map(registrations).join("\n"), c);
  c.captureHealthBadge.dataset.phase = phase;
  c.captureHealthBadge.textContent = phase === "loading" ? "Loading" : "Connecting";
  c.trackerWorkspace.scrollTop = 123;
  c.setWorkspaceBusy(false);
  return { row, variation, inventory, metrics, pin };
}

test("startup opt-in enables planning only, removes tint without changing Connecting/Loading, and creates initial #1", async () => {
  for (const phase of ["connecting", "loading"]) {
    const f = await emptyStreamFixture(), c = f.context;
    installPresetNavigation(f);
    const dom = installPlanningRuntime(f, phase), before = JSON.stringify(f.state);
    assert.equal(c.isCaptureInteractionLocked(), true);
    assert.equal(c.canChangeVariationPresets(), false);
    assert.equal(c.variationPresetsButton.disabled, false);
    assert.equal(dom.inventory.hasAttribute("inert"), true);
    await beginInitialPresetSave(f, 200);
    assert.equal(c.captureHealthBadge.dataset.phase, phase);
    assert.equal(c.captureHealthBadge.textContent, phase === "loading" ? "Loading" : "Connecting");
    assert.equal(c.isCaptureInteractionLocked(), true, "Actual readiness must not be faked");
    assert.equal(c.isCapturePlanningEnabled(), true);
    assert.equal(c.trackerWorkspace.hasAttribute("data-capture-planning"), true);
    assert.equal(dom.inventory.hasAttribute("inert"), false);
    assert.equal(dom.variation.hasAttribute("inert"), false);
    assert.equal(dom.metrics.hasAttribute("inert"), true);
    assert.equal(dom.pin.hasAttribute("inert"), true);
    assert.equal(c.addActiveStreamSkusButton.hasAttribute("inert"), true);
    assert.equal(c.activeStreamInventoryUpdateForm.hasAttribute("inert"), true);
    assert.equal(c.inventoryGrid.hasAttribute("inert"), false);
    assert.equal(c.getActiveView().selectedVariationNumber, 1);
    assert.equal(c.getActiveView().isReviewingPreset, true);
    assert.equal(c.trackerWorkspace.scrollTop, 123);
    assert.equal(JSON.stringify(f.state), before);
  }
});

test("startup planning uses dropdown, Var #, arrows, inventory search, exact sizes, and sequential clicks without accounting", async () => {
  const f = await emptyStreamFixture(), c = f.context;
  installPresetNavigation(f); installPlanningRuntime(f);
  const before = JSON.stringify(f.state);
  await beginInitialPresetSave(f, 200);
  await c.inventoryGrid.dispatch("click", { target: inventoryCard(f) }); await settle();
  assert.equal(c.variationPresetsSnapshot.assignments[0].variationNumber, 1);
  await c.inventoryGrid.dispatch("click", { target: inventoryCard(f) }); await settle();
  assert.equal(c.variationPresetsSnapshot.assignments.length, 0);
  await rightClick(f); await rightClick(f);
  assert.equal(c.selectedPresetVariationNumber, 2);
  await c.nextVariationButton.dispatch("click");
  assert.equal(c.selectedPresetVariationNumber, 3);
  await c.previousVariationButton.dispatch("click");
  assert.equal(c.selectedPresetVariationNumber, 2);
  c.variationSearchInput.value = "5";
  await c.variationSearchForm.dispatch("submit");
  assert.equal(c.selectedPresetVariationNumber, 5);
  await c.variationSelector.dispatch("click");
  assert.equal(c.variationSelectorOpen, true);
  c.selectVariationFromPicker(6);
  c.searchInput.value = "Hoodie";
  await c.searchInput.dispatch("input");
  assert.equal(c.searchInput.value, "Hoodie");
  await c.inventoryListToggle.dispatch("click");
  assert.equal(c.inventoryListExpanded, true);
  installSizeMenu(f);
  const commandsBeforeSize = f.calls.length;
  await c.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f, "A", true) });
  assert.equal(f.calls.length, commandsBeforeSize);
  assert.equal(c.inventorySizeMenuState.intent, "preset_context");
  c.selectInventorySizeFromPicker("A-L"); await settle();
  assert.equal(f.calls.at(-1).command.sku, "A-L");
  assert.equal(c.variationPresetsSnapshot.assignments.find(entry => entry.variationNumber === 6).sku, "A-L");
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(c.getActiveView().inventory[0].reservedQuantity, 0);
  assert.equal(c.getActiveView().inventory[0].remainingQuantity, 10);
});

test("existing Reset presets can opt into startup planning without bypassing reset acknowledgement", async () => {
  const f = await emptyStreamFixture({ total: 200 }), c = f.context, reply = deferred();
  installPlanningRuntime(f, "connecting");
  c.variationPresetsClient.resetPresets = () => reply.promise;
  const pending = c.variationPresetsButton.dispatch("click");
  assert.ok(c.capturePlanningOverride);
  assert.equal(c.variationPresetsSnapshot.total, 200);
  assert.equal(c.variationPresetsButton.textContent, "Reset presets");
  assert.equal(c.variationPresetsButton.disabled, true);
  assert.equal(c.trackerWorkspace.hasAttribute("data-capture-planning"), true);
  reply.resolve({ ...presetSnapshot(null), revision: "reset" }); await pending;
  assert.equal(c.variationPresetsSnapshot.total, null);
  assert.equal(c.variationPresetsButton.textContent, "Preset items");
  assert.equal(c.isCapturePlanningEnabled(), true);
  assert.equal(c.captureHealthBadge.dataset.phase, "connecting");
});

test("startup opt-in cannot bypass local-data, session, baseline, save, import, queue or End prerequisites", async () => {
  for (const block of [
    c => { c.savedSnapshot.phase = "loading"; c.savedSnapshot.busy = true; },
    c => { c.savedSnapshot.phase = "error"; },
    c => { c.savedSnapshot.view = null; },
    c => { c.variationPresetsReady = false; },
    c => { c.variationPresetsSnapshot = null; },
    c => { c.variationPresetsSnapshot.streamId = "other-stream"; },
    c => { c.streamSnapshot.phase = "error"; },
    c => { c.streamSnapshot.resumed = false; },
    c => { c.nextItemQueueMutationBusy = true; },
    c => { c.pendingSavedAction = {}; },
    c => { c.activeStreamInventoryUpdateBusy = true; },
    c => { c.endConfirmationOpen = true; },
  ]) {
    const f = await emptyStreamFixture(), c = f.context;
    installPlanningRuntime(f);
    block(c); c.setWorkspaceBusy(c.savedSnapshot.busy);
    await c.variationPresetsButton.dispatch("click");
    assert.equal(c.capturePlanningOverride, null);
    assert.equal(c.variationPresetsEditing, false);
    assert.equal(f.calls.length, 0);
  }
});

test("planning during startup keeps captured mapping and manual queue controls capture-locked", async () => {
  const f = fixture({ total: 200 }), c = f.context;
  installPlanningRuntime(f);
  // Preserve an existing range while opting in through the applicable control.
  c.variationPresetsClient.resetPresets = async () => { throw new Error("Synthetic reset failure"); };
  await c.variationPresetsButton.dispatch("click");
  assert.equal(c.isCapturePlanningEnabled(), true);
  c.nextItemQueueClient = {
    toggleQueue() { assert.fail("Startup planning must not queue live inventory"); },
    mapCurrent() { assert.fail("Startup planning must not map live inventory"); },
    clearQueue() { assert.fail("Startup planning must not manually clear the queue"); },
  };
  c.runSavedMutation = () => assert.fail("Startup planning must not mutate captured mappings");
  c.clearQueuedItemButton = element();
  vm.runInContext(declaration("clearQueuedItem"), c);
  for (const number of [30, 29]) {
    c.selectVariationFromPicker(number); c.setWorkspaceBusy(false);
    assert.equal(c.getActiveView().selectedVariationNumber, number);
    assert.equal(c.inventoryGrid.hasAttribute("inert"), true);
    const card = inventoryCard(f);
    await c.inventoryGrid.dispatch("click", { target: card });
    await c.inventoryGrid.dispatch("contextmenu", { target: card });
    c.saveOrdinaryInventorySelection(card, c.getActiveView());
    await c.toggleNextItemQueue(card, c.getActiveView());
    await c.mapCurrentVariationFromHistory(card, c.getActiveView());
    await c.clearQueuedItem({ type: "click", target: c.clearQueuedItemButton, preventDefault() {}, stopImmediatePropagation() {} });
  }
  assert.equal(f.calls.length, 0);
});

test("planning survives ordinary renders and busy work without tint but clears on actual load or readiness changes", async () => {
  const f = await emptyStreamFixture(), c = f.context;
  installPlanningRuntime(f);
  await beginInitialPresetSave(f, 200);
  const selection = c.selectedPresetVariationNumber;
  const token = c.capturePlanningOverride;
  c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "first-document" });
  assert.equal(c.capturePlanningOverride, token, "Learning the first identity is not refresh");
  assert.equal(token.loadId, "first-document");
  for (const busy of [true, false, true, false]) {
    c.savedSnapshot.busy = busy;
    c.setWorkspaceBusy(busy); c.renderAll();
    assert.equal(c.capturePlanningOverride, token);
    assert.equal(c.trackerWorkspace.hasAttribute("data-capture-planning"), true);
    assert.equal(c.canChangeVariationPresets(), !busy);
  }
  c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "first-document" });
  assert.equal(c.capturePlanningOverride, token);
  c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "new-document" });
  assert.equal(c.capturePlanningOverride, null);
  assert.equal(c.trackerWorkspace.hasAttribute("data-capture-planning"), false);
  assert.equal(c.selectedPresetVariationNumber, selection);
  assert.equal(c.trackerWorkspace.scrollTop, 123);
  for (const phase of ["active", "blank"]) {
    c.captureHealthBadge.dataset.phase = "loading";
    c.capturePlanningOverride = { streamId: c.mountedStreamId, loadId: "new-document" };
    c.captureHealthBadge.dataset.phase = phase; c.setWorkspaceBusy(false);
    assert.equal(c.capturePlanningOverride, null);
    assert.equal(c.canChangeVariationPresets(), true);
    assert.equal(c.selectedPresetVariationNumber, selection);
  }
});

test("leaving or replacing the active session clears the panel-local override and reopening does not inherit it", async () => {
  for (const leave of [c => { c.streamSnapshot.resumed = false; },
    c => { c.streamSnapshot.activeSession = null; },
    c => { c.mountedStreamId = "other-stream"; },
    c => { c.trackerWorkspace.hidden = true; }]) {
    const f = await emptyStreamFixture(), c = f.context;
    installPlanningRuntime(f); await c.variationPresetsButton.dispatch("click");
    assert.ok(c.capturePlanningOverride);
    leave(c); c.setWorkspaceBusy(false);
    assert.equal(c.capturePlanningOverride, null);
    assert.equal(c.trackerWorkspace.hasAttribute("data-capture-planning"), false);
    assert.equal(c.trackerWorkspace.scrollTop, 123);
  }
  const reopened = await emptyStreamFixture({ total: 200 });
  installPlanningRuntime(reopened);
  assert.equal(reopened.context.capturePlanningOverride, null);
  assert.equal(reopened.context.canChangeVariationPresets(), false);
});

test("future-origin clicks and exact-size choices invalidated by capture never fall through to mapping during planning", async () => {
  for (const kind of ["left", "right", "ordinary-size", "context-size"]) {
    const f = fixture(), c = f.context;
    installPlanningRuntime(f); await beginInitialPresetSave(f, 200);
    c.selectVariationFromPicker(80);
    const card = inventoryCard(f);
    if (kind.endsWith("size")) {
      installSizeMenu(f);
      await c.inventoryGrid.dispatch(kind === "ordinary-size" ? "click" : "contextmenu", { target: inventoryCard(f, "A", true) });
    }
    f.rawView.variations.push({ variationNumber: 80, recorded: true, sku: "A" });
    c.preserveCapturedPresetSelection(c.savedSnapshot);
    const before = JSON.stringify([c.variationPresetsSnapshot, f.rawView]), calls = f.calls.length;
    c.runSavedMutation = () => assert.fail("Old future intent cannot map a captured variation");
    if (kind.endsWith("size")) c.selectInventorySizeFromPicker("A-L");
    else await c.inventoryGrid.dispatch(kind === "left" ? "click" : "contextmenu", { target: card });
    await settle();
    assert.equal(f.calls.length, calls);
    assert.equal(JSON.stringify([c.variationPresetsSnapshot, f.rawView]), before);
  }
});

test("a safe background refresh preserves planning pickers and focus while rejecting edits until ready", async () => {
  for (const picker of ["variation", "size"]) {
    const f = await emptyStreamFixture(), c = f.context;
    installPresetNavigation(f); installPlanningRuntime(f);
    await beginInitialPresetSave(f, 200);
    if (picker === "size") {
      installSizeMenu(f);
      await c.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f, "A", true) });
      c.document.activeElement = c.inventorySizeListbox;
    } else {
      await c.variationSelector.dispatch("click");
      c.document.activeElement = c.variationSelector;
    }
    const focused = c.document.activeElement;
    let blurs = 0;
    focused.blur = () => { blurs++; c.document.activeElement = null; };
    const commands = f.calls.length;
    c.savedSnapshot = { ...c.savedSnapshot, phase: "loading", operation: "refresh", busy: true };
    c.setWorkspaceBusy(true);
    assert.equal(c.trackerWorkspace.hasAttribute("inert"), false, "Keep the pre-existing open-picker refresh exemption");
    assert.equal(c.trackerWorkspace.hasAttribute("data-capture-planning"), true);
    assert.equal(c.canChangeVariationPresets(), false);
    assert.equal(blurs, 0);
    assert.equal(c.document.activeElement, focused);
    if (picker === "size") {
      assert.ok(c.inventorySizeMenuState);
      assert.equal(c.inventorySizeListbox.hasAttribute("inert"), false);
      c.selectInventorySizeFromPicker("A-L");
    } else {
      assert.equal(c.variationSelectorOpen, true);
      c.selectVariationFromPicker(2);
    }
    assert.equal(f.calls.length, commands);
    assert.equal(c.selectedPresetVariationNumber, 1);
    c.savedSnapshot = { ...c.savedSnapshot, phase: "ready", busy: false };
    c.setWorkspaceBusy(false);
    assert.equal(c.canChangeVariationPresets(), true);
    if (picker === "size") {
      c.selectInventorySizeFromPicker("A-L"); await settle();
      assert.equal(f.calls.at(-1).command.sku, "A-L");
    }
    assert.equal(c.trackerWorkspace.scrollTop, 123);
  }
});

test("an actual new document dismisses only the unsaved preset draft and restores a fresh opt-in button", async () => {
  const f = await emptyStreamFixture(), c = f.context;
  installPlanningRuntime(f);
  c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "first" });
  await c.variationPresetsButton.dispatch("click");
  c.variationPresetsInput.value = "200";
  const state = JSON.stringify(f.state), plans = JSON.stringify(c.variationPresetsSnapshot);
  c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "next" });
  assert.equal(c.capturePlanningOverride, null);
  assert.equal(c.variationPresetsEditing, false);
  assert.equal(c.variationPresetsInput.value, "");
  assert.equal(c.variationPresetsButton.disabled, false);
  assert.equal(c.variationPresetsInput.hidden, true);
  assert.equal(c.variationPresetsButton.textContent, "Preset items");
  assert.equal(JSON.stringify(f.state), state);
  assert.equal(JSON.stringify(c.variationPresetsSnapshot), plans);
  assert.equal(c.trackerWorkspace.scrollTop, 123);
  await c.variationPresetsButton.dispatch("click");
  assert.equal(c.capturePlanningOverride.loadId, "next");
  assert.equal(c.variationPresetsEditing, true);
});

test("new-document changes suppress delayed create, sequential, and reset navigation or focus without undoing saved work", async () => {
  for (const action of ["create", "sequential", "reset"]) {
    const f = await emptyStreamFixture(), c = f.context, reply = deferred();
    installPresetNavigation(f); installPlanningRuntime(f);
    c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "first" });
    if (action !== "create") {
      await beginInitialPresetSave(f, 200);
      await rightClick(f);
    }
    const kind = { create: "createPresets", sequential: "assignNextPresetItem", reset: "resetPresets" }[action];
    const original = c.variationPresetsClient[kind];
    let result;
    c.variationPresetsClient[kind] = async command => {
      result = await original(command);
      await reply.promise;
      return result;
    };
    let pending;
    if (action === "create") pending = beginInitialPresetSave(f, 200);
    else if (action === "reset") pending = c.variationPresetsButton.dispatch("click");
    else await c.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
    await settle();
    assert.equal(c.variationPresetsBusy, true);
    const selected = c.selectedPresetVariationNumber;
    c.variationPresetsButton.focused = false;
    c.handleCapturePlanningLoad({ streamId: c.mountedStreamId, loadId: "new" });
    const generation = c.variationNavigationGeneration;
    reply.resolve(); await pending; await settle();
    assert.equal(c.variationPresetsBusy, false);
    assert.equal(c.capturePlanningOverride, null);
    assert.equal(c.variationNavigationGeneration, generation);
    assert.equal(c.selectedPresetVariationNumber, selected);
    assert.equal(c.variationPresetsButton.focused, false);
    assert.equal(c.variationPresetsEditing, false);
    assert.equal(c.trackerWorkspace.scrollTop, 123);
    assert.equal(c.variationPresetsSnapshot.total, action === "reset" ? null : 200);
    if (action === "sequential") assert.equal(c.variationPresetsSnapshot.assignments.length, 2);
    assert.equal(f.state.streams[0].variations.length, 0);
  }
});

test("preset union supplies 1–200 once, preserves captured entries and never changes source data or accounting", () => {
  const view = baselineView(), presets = presetSnapshot(), before = JSON.stringify([view, presets]);
  const output = projection.project(view, presets, 80);
  assert.equal(output.variations.length, 200);
  assert.equal(new Set(output.variations.map((entry) => entry.variationNumber)).size, 200);
  assert.deepEqual(output.variations.filter((entry) => entry.recorded).map((entry) => entry.variationNumber), [30, 29, 1]);
  assert.equal(output.auction, null);
  assert.equal(output.mapping, null);
  assert.equal(output.isReviewingPreset, true);
  assert.equal(output.currentVariationNumber, 30);
  assert.equal(output.activeBiddingVariationNumber, 30);
  assert.deepEqual(output.totals, view.totals);
  assert.equal(output.inventory[0].remainingQuantity, 5);
  assert.equal(output.inventory[0].pendingQuantity, 1);
  assert.equal(output.inventory[0].soldQuantity, 2);
  assert.equal(output.inventory[0].selected, true);
  assert.equal(JSON.stringify([view, presets]), before);
});

test("projection does not cap real captured numbers and never applies a different stream's plan", () => {
  const view = baselineView();
  view.variations.push({ variationNumber: 205, recorded: true, item: null });
  const output = projection.project(view, presetSnapshot());
  assert.equal(output.variations.length, 201);
  assert.equal(output.variations[0].variationNumber, 205);
  assert.equal(output.selectedVariationNumber, 30);
  assert.equal(projection.project(view, { ...presetSnapshot(), streamId: "other" }, 80), view);
  assert.equal(projection.project(view, presetSnapshot(null), 80), view);
});

test("projecting a saved range before first capture preserves waiting unless a preset selection is explicitly provided", () => {
  const raw = baselineView();
  raw.currentVariationNumber = 203;
  raw.selectedVariationNumber = 203;
  raw.activeBiddingVariationNumber = null;
  raw.auction = null;
  raw.variations = [{ variationNumber: 203, recorded: false, selected: true }];
  for (const total of [200, 1000]) {
    const projected = projection.project(raw, presetSnapshot(total));
    assert.equal(projected.variations.length, total);
    assert.equal(projected.selectedVariationNumber, null);
    assert.equal(projected.variations.some((entry) => entry.selected), false);
    assert.equal(projected.isReviewingPreset, false);
    assert.equal(projected.isReviewingHistory, false);
    const selected = projection.project(raw, presetSnapshot(total), 80);
    assert.equal(selected.selectedVariationNumber, 80);
    assert.equal(selected.isReviewingPreset, true);
  }
});

test("initial canonical readiness recovers an early failed preset read without needing any capture notification", async () => {
  const f = await emptyStreamFixture();
  installSavedRenderer(f);
  f.context.captureHealthBadge.dataset.phase = "blank";
  f.context.variationPresetsSnapshot = null;
  f.context.variationPresetsReady = false;
  let reads = 0;
  f.context.variationPresetsClient.getPresets = async () => {
    reads++;
    if (reads === 1) throw new Error("Preset context is not ready yet.");
    return presetSnapshot(null);
  };
  f.context.scheduleVariationPresetsRefresh();
  await settle();
  assert.equal(f.context.variationPresetsButton.disabled, true);
  f.context.savedSnapshot = { phase: "loading", operation: "load", busy: true, view: null };
  f.context.renderSavedSnapshot({ phase: "ready", operation: "load", busy: false, view: f.rawView });
  await settle();
  assert.equal(reads, 2, "Load completion, not future capture, must recover the preset context");
  assert.equal(f.context.trackerWorkspace.hasAttribute("inert"), false);
  assert.equal(f.context.variationPresetsButton.disabled, false);
  await f.context.variationPresetsButton.dispatch("click");
  assert.equal(f.context.variationPresetsInput.hidden, false);
  assert.equal(f.rawView.variations.some((entry) => entry.recorded), false);
});

test("loading retry refreshes preset prerequisites once and stale earlier reads cannot disable its ready result", async () => {
  const f = await emptyStreamFixture(), early = deferred();
  installSavedRenderer(f);
  f.context.variationPresetsReady = false;
  f.context.captureHealthBadge.dataset.phase = "blank";
  let reads = 0;
  f.context.variationPresetsClient.getPresets = () => ++reads === 1 ? early.promise : Promise.resolve(presetSnapshot(null));
  f.context.scheduleVariationPresetsRefresh();
  await settle();
  f.context.savedSnapshot = { phase: "loading", operation: "load", busy: true, view: f.rawView };
  const ready = { phase: "ready", operation: "load", busy: false, view: f.rawView };
  f.context.renderSavedSnapshot(ready);
  await settle();
  assert.equal(f.context.variationPresetsButton.disabled, false);
  early.reject(new Error("Old startup request failed."));
  await settle();
  assert.equal(f.context.variationPresetsButton.disabled, false);
  f.context.renderSavedSnapshot(ready);
  await settle();
  assert.equal(reads, 2, "Ordinary ready rerenders must not add preset reads or polling");
});

test("zero-capture planning needs explicit opt-in during Connecting/Loading and remains normally available when ready", async () => {
  for (const phase of ["connecting", "loading", "blank", "active"]) {
    const f = await emptyStreamFixture();
    f.context.captureHealthBadge.dataset.phase = phase;
    f.context.updateVariationPresetsAvailability();
    const locked = ["connecting", "loading"].includes(phase);
    assert.equal(f.context.variationPresetsButton.disabled, false);
    assert.equal(f.context.canChangeVariationPresets(), !locked);
    await f.context.variationPresetsButton.dispatch("click");
    assert.equal(f.context.variationPresetsEditing, true);
    assert.equal(f.context.captureHealthBadge.dataset.phase, phase);
    assert.equal(f.rawView.activeBiddingVariationNumber, null);
    assert.equal(f.state.streams[0].variations.length, 0);
  }
});

test("zero-capture planning supports total entry, exact lookup, left-click changes and sequential right-click without stock effects", async () => {
  const f = await emptyStreamFixture(), before = JSON.stringify(f.state);
  f.context.captureHealthBadge.dataset.phase = "blank";
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  const waiting = f.context.getActiveView();
  assert.equal(waiting.variations.length, 200);
  assert.equal(waiting.variations.some((entry) => entry.recorded || entry.current), false);
  assert.equal(waiting.selectedVariationNumber, 1);
  assert.equal(waiting.isReviewingPreset, true);
  assert.equal(waiting.auction, null);
  assert.equal(waiting.activeBiddingVariationNumber, null);
  f.context.variationSearchInput.value = "1";
  await f.context.variationSearchForm.dispatch("submit");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 1);
  f.context.saveOrdinaryInventorySelection(inventoryCard(f), f.context.getActiveView());
  await settle();
  assert.equal(f.context.variationPresetsSnapshot.assignments[0].variationNumber, 1);
  f.context.saveOrdinaryInventorySelection(inventoryCard(f), f.context.getActiveView());
  await settle();
  assert.equal(f.context.variationPresetsSnapshot.assignments.length, 0);
  await rightClick(f);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 1);
  await rightClick(f);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 2);
  assert.equal(f.context.variationPresetsSnapshot.assignments.length, 2);
  assert.equal(JSON.stringify(f.state), before);
  assert.deepEqual(f.context.getActiveView().totals, f.rawView.totals);
  assert.equal(f.context.getActiveView().inventory[0].reservedQuantity, 0);
  assert.equal(f.context.getActiveView().inventory[0].remainingQuantity, 10);
});

test("zero-capture future size picker requires an exact SKU and does not invent a live target on Return or reset", async () => {
  const f = await emptyStreamFixture({ total: 200 });
  installSizeMenu(f);
  f.context.variationPresetsSnapshot.assignments = [];
  f.context.selectVariationFromPicker(1);
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f, "A", true) });
  assert.equal(f.calls.length, 0);
  f.context.selectInventorySizeFromPicker("A-L");
  await settle();
  assert.equal(f.calls[0].command.sku, "A-L");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 1);
  await f.context.returnToCurrentButton.dispatch("click");
  assert.match(f.context.mappingAnnouncement.textContent, /latest live item is not available yet/);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 1);
  await f.context.variationPresetsButton.dispatch("click");
  assert.equal(f.context.variationPresetsSnapshot.total, null);
  assert.equal(f.context.selectedPresetVariationNumber, null);
  assert.equal(f.context.getActiveView().variations.some((entry) => entry.recorded), false);
  assert.equal(f.context.getActiveView().activeBiddingVariationNumber, null);
  assert.equal(f.state.streams[0].variations.length, 0);
  assert.equal(f.context.mappingAnnouncement.textContent, "Future presets were reset. Waiting for a live auction variation.");
});

test("pre-stream canonical readiness still waits for the original capture lock and ignores old-session preset responses", async () => {
  const f = await emptyStreamFixture(), read = deferred();
  installSavedRenderer(f);
  f.context.variationPresetsReady = false;
  f.context.captureHealthBadge.dataset.phase = "loading";
  f.context.variationPresetsClient.getPresets = () => read.promise;
  f.context.savedSnapshot = { phase: "loading", operation: "load", busy: true, view: null };
  f.context.renderSavedSnapshot({ phase: "ready", operation: "load", busy: false, view: f.rawView });
  await settle();
  assert.equal(f.context.variationPresetsButton.disabled, true);
  read.resolve(presetSnapshot(null));
  await settle();
  assert.equal(f.context.variationPresetsReady, true);
  assert.equal(f.context.variationPresetsButton.disabled, false, "Only explicit planning opt-in is available");
  assert.equal(f.context.canChangeVariationPresets(), false);
  f.context.captureHealthBadge.dataset.phase = "blank";
  f.context.setWorkspaceBusy(false);
  assert.equal(f.context.variationPresetsButton.disabled, false);

  const old = deferred();
  f.context.variationPresetsClient.getPresets = () => old.promise;
  f.context.scheduleVariationPresetsRefresh();
  await settle();
  f.context.resetVariationPresetsDisplay();
  f.context.mountedStreamId = "new-stream";
  old.resolve(presetSnapshot(200));
  await settle();
  assert.equal(f.context.variationPresetsSnapshot, null);
  assert.equal(f.context.variationPresetsReady, false);
});

test("no-capture Reload Site does not bypass missing preset context or session, inventory, save and End safeguards", async () => {
  for (const block of [
    (c) => { c.variationPresetsSnapshot = null; },
    (c) => { c.variationPresetsReady = false; },
    (c) => { c.savedSnapshot.phase = "error"; },
    (c) => { c.activeStreamInventoryUpdateBusy = true; },
    (c) => { c.savedSnapshot.busy = true; },
    (c) => { c.nextItemQueueMutationBusy = true; },
    (c) => { c.streamSnapshot.resumed = false; },
    (c) => { c.streamSnapshot.activeSession = null; },
    (c) => { c.endConfirmationOpen = true; },
  ]) {
    const f = await emptyStreamFixture();
    f.context.captureHealthBadge.dataset.phase = "blank";
    block(f.context);
    f.context.updateVariationPresetsAvailability();
    await f.context.variationPresetsButton.dispatch("click");
    assert.equal(f.context.variationPresetsButton.disabled, true);
    assert.equal(f.context.variationPresetsEditing, false);
    assert.equal(f.calls.length, 0);
  }
});

test("future labels reuse item formatting and say untracked without a fabricated payment status", () => {
  const view = projection.project(baselineView(), presetSnapshot());
  const options = { formatItemName: (entry) => `${entry.item} - ${entry.style}` };
  for (const [number, itemLabel] of [[80, "LA - Hoodie, size M"], [81, "no selection"]]) {
    const entry = view.variations.find((option) => option.variationNumber === number);
    const display = selector.createOptionDisplay(entry, options);
    assert.equal(display.paymentLabel, "untracked");
    assert.equal(display.itemLabel, itemLabel);
    assert.equal(display.paymentTone, "neutral");
    assert.equal(entry.observedPaymentStatus, undefined);
    assert.equal(entry.recorded, false);
  }
});

test("preset bubble and editor occupy only the existing third startup-row slot with accessible controls", () => {
  const row = html.slice(html.indexOf('<div class="capture-health-row"'), html.indexOf('<section class="current-auction"'));
  assert.match(row, /id="variation-presets-button" type="button"/);
  assert.match(row, /id="variation-presets-input" type="text" inputmode="numeric"/);
  assert.match(row, /aria-label="Total preset variations"/);
  assert.match(row, /aria-describedby="variation-presets-help"/);
  assert.doesNotMatch(row, /<(?:button|input)[^>]*id="variation-presets-(?:button|input)"[^>]*\btitle=/);
  assert.match(row, /Escape cancels/);
  assert.match(css, /\.variation-presets-form\s*\{[^}]*grid-column: 3;[^}]*grid-row: 1;[^}]*justify-self: end;[^}]*max-width: 100%;[^}]*min-width: 0;/);
  assert.match(css, /#variation-presets-input\s*\{[^}]*height: 20px;[^}]*color: var\(--blue\);/);
  assert.match(css, /\.capture-health-row\s*\{[^}]*minmax\(0, 1fr\) minmax\(0, 112px\) minmax\(0, 1fr\);[^}]*height: 20px;/);
  assert.match(css, /\.variation-search-form\s*\{[^}]*width: 64px;/);
  assert.equal((html.match(/id="variation-presets-button"/g) ?? []).length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(tagger, "..", "report", "report.html"), "utf8"), /variation-presets/);
});

test("narrow preset controls retain complete labels in the existing track without changing other controls or row height", () => {
  const rule = css.match(/@media \(max-width: 320px\)\s*\{\s*\/\*[\s\S]*?\*\/\s*(#variation-presets-button,\s*#variation-presets-input)\s*\{([^}]+)\}\s*\}/);
  assert.ok(rule, "Only the new preset bubble/editor need a narrower treatment");
  assert.match(rule[2], /padding:\s*0 1px;/);
  assert.match(rule[2], /font-size:\s*9px;/);
  assert.doesNotMatch(rule[2], /height|width|margin|grid|overflow|text-overflow/);
  assert.match(css, /#variation-presets-button\s*\{[^}]*white-space:\s*nowrap;/);
  assert.match(css, /#variation-presets-input\s*\{[^}]*height:\s*20px;/);
  assert.doesNotMatch(rule[1], /variation-search|capture-health/);
});

test("click opens editor, Escape cancels, Enter saves total and replaces control with Reset without switching live", async () => {
  const f = fixture();
  await f.context.variationPresetsButton.dispatch("click");
  assert.equal(f.context.variationPresetsInput.hidden, false);
  assert.equal(f.context.variationPresetsInput.focused, true);
  await f.context.variationPresetsInput.dispatch("keydown", { key: "Escape" });
  assert.equal(f.context.variationPresetsEditing, false);
  assert.equal(f.calls.length, 0);
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls[0].kind, "createPresets");
  assert.equal(f.calls[0].command.total, 200);
  assert.equal(f.calls[0].command.expectedBaselineId, "synthetic-baseline");
  assert.equal(f.calls[0].command.expectedRevision, "r1");
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  assert.equal(f.context.getActiveView().variations.length, 200);
  assert.deepEqual(f.selections, []);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 30);
});

test("outside pointer dismissal discards only the unsaved total without saving, moving focus, or intercepting the target", async () => {
  for (const pointerType of ["mouse", "touch", "pen"]) {
    for (const draft of ["", "200"]) {
      const f = fixture(), c = f.context;
      const before = JSON.stringify([c.variationPresetsSnapshot, f.rawView]);
      await c.variationPresetsButton.dispatch("click");
      c.variationPresetsInput.value = draft;
      c.variationSearchInput.value = "25";
      c.variationSearchInput.focus();
      await c.document.dispatch("pointerdown", {
        target: c.variationSearchInput, pointerType,
        preventDefault() { assert.fail("The outside target must remain clickable"); },
        stopImmediatePropagation() { assert.fail("Do not intercept other controls"); },
      });
      assert.equal(c.variationPresetsEditing, false);
      assert.equal(c.variationPresetsEntryContext, null);
      assert.equal(c.variationPresetsInput.hidden, true);
      assert.equal(c.variationPresetsInput.value, "");
      assert.equal(c.variationPresetsButton.hidden, false);
      assert.equal(c.variationPresetsButton.textContent, "Preset items");
      assert.notEqual(c.variationPresetsButton.focused, true);
      assert.equal(c.variationSearchInput.focused, true);
      assert.equal(c.variationSearchInput.value, "25");
      await c.variationPresetsForm.dispatch("submit"); // A late submit cannot save the discarded draft.
      await c.document.dispatch("pointerdown", { target: c.trackerWorkspace });
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.selections, []);
      assert.equal(JSON.stringify([c.variationPresetsSnapshot, f.rawView]), before);
    }
  }
});

test("opening the preset editor and interacting inside its form do not dismiss the draft", async () => {
  const { context: c, calls } = fixture();
  await c.document.dispatch("pointerdown", { target: c.variationPresetsButton });
  await c.variationPresetsButton.dispatch("click");
  c.variationPresetsInput.value = "200";
  const origin = c.variationPresetsEntryContext;
  for (const target of [c.variationPresetsInput, c.variationPresetsForm, c.variationPresetsButton]) {
    await c.document.dispatch("pointerdown", { target });
    assert.equal(c.variationPresetsEditing, true);
    assert.equal(c.variationPresetsInput.hidden, false);
    assert.equal(c.variationPresetsInput.value, "200");
    assert.equal(c.variationPresetsEntryContext, origin);
  }
  assert.equal(calls.length, 0);
});

test("outside dismissal clears invalid draft feedback and reopening still supports a normal save", async () => {
  const { context: c, calls } = fixture();
  await c.variationPresetsButton.dispatch("click");
  c.variationPresetsInput.value = "1.5";
  await c.variationPresetsForm.dispatch("submit");
  assert.equal(c.variationPresetsInput.getAttribute("aria-invalid"), "true");
  await c.document.dispatch("pointerdown", { target: c.trackerWorkspace });
  assert.equal(c.variationPresetsInput.validationMessage, "");
  assert.equal(c.variationPresetsInput.hasAttribute("aria-invalid"), false);
  await c.variationPresetsButton.dispatch("click");
  assert.equal(c.variationPresetsInput.value, "");
  c.variationPresetsInput.value = "200";
  await c.variationPresetsForm.dispatch("submit");
  assert.equal(calls.length, 1);
  assert.equal(c.variationPresetsSnapshot.total, 200);
  assert.equal(c.variationPresetsButton.textContent, "Reset presets");
});

test("outside interaction does not invalidate a pending preset save or discard a failed save's draft", async () => {
  for (const succeeds of [true, false]) {
    const { context: c } = fixture();
    const pending = deferred();
    c.variationPresetsClient.createPresets = () => pending.promise;
    await c.variationPresetsButton.dispatch("click");
    c.variationPresetsInput.value = "200";
    const origin = c.variationPresetsEntryContext;
    const submission = c.variationPresetsForm.dispatch("submit");
    assert.equal(c.variationPresetsBusy, true);
    await c.document.dispatch("pointerdown", { target: c.trackerWorkspace });
    assert.equal(c.variationPresetsEntryContext, origin);
    assert.equal(c.variationPresetsEditing, true);
    assert.equal(c.variationPresetsInput.value, "200");
    if (succeeds) pending.resolve({ ...presetSnapshot(200), revision: "saved" });
    else pending.reject(new Error("Synthetic save failure"));
    await submission;
    assert.equal(c.variationPresetsBusy, false);
    assert.equal(c.variationPresetsSnapshot.total, succeeds ? 200 : null);
    assert.equal(c.variationPresetsEditing, !succeeds);
    if (!succeeds) {
      assert.match(c.mappingAnnouncement.textContent, /Synthetic save failure/);
      assert.equal(c.variationPresetsInput.value, "200");
      await c.document.dispatch("pointerdown", { target: c.trackerWorkspace });
      assert.equal(c.variationPresetsEditing, false);
      assert.equal(c.variationPresetsInput.value, "");
    }
  }
});

test("dismissing an unsaved preset input never removes capture-loading or unrelated save safeguards", async () => {
  for (const lock of [c => { c.captureHealthBadge.dataset.phase = "loading"; },
    c => { c.savedSnapshot.busy = true; }]) {
    const { context: c, calls } = fixture();
    await c.variationPresetsButton.dispatch("click");
    lock(c);
    c.updateVariationPresetsAvailability();
    await c.document.dispatch("pointerdown", { target: c.trackerWorkspace });
    assert.equal(c.variationPresetsEditing, false);
    assert.equal(c.canChangeVariationPresets(), false);
    assert.equal(c.variationPresetsButton.disabled, c.savedSnapshot.busy);
    assert.equal(c.variationPresetsForm.hasAttribute("inert"), c.savedSnapshot.busy);
    assert.equal(calls.length, 0);
  }
});

test("outside dismissal of extension entry preserves skipped plans and the currently browsed future variation", async () => {
  const f = fixture({ total: 100 }), c = f.context;
  advanceLive(f, 101);
  c.selectVariationFromPicker(80);
  const before = JSON.stringify([c.variationPresetsSnapshot, f.rawView]);
  await c.variationPresetsButton.dispatch("click");
  c.variationPresetsInput.value = "200";
  await c.document.dispatch("pointerdown", { target: c.trackerWorkspace });
  assert.equal(c.variationPresetsEditing, false);
  assert.equal(c.variationPresetsButton.textContent, "Preset items");
  assert.equal(c.getActiveView().selectedVariationNumber, 80);
  assert.equal(JSON.stringify([c.variationPresetsSnapshot, f.rawView]), before);
  assert.equal(f.calls.length, 0);
});

test("invalid totals and totals below the highest captured variation are rejected before requests", async () => {
  for (const query of ["", "0", "-1", "1.5", "NaN", "2e2", "1001", "9007199254740992", "29"]) {
    const f = fixture();
    await f.context.variationPresetsButton.dispatch("click");
    f.context.variationPresetsInput.value = query;
    await f.context.variationPresetsForm.dispatch("submit");
    assert.equal(f.calls.length, 0, query);
    assert.ok(f.context.variationPresetsInput.validationMessage, query);
    assert.equal(f.context.variationPresetsInput.getAttribute("aria-invalid"), "true");
  }
});

test("valid upper bound and leading-zero whole totals work; an enabled total cannot be edited", async () => {
  const f = fixture();
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = " 01000 ";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.context.variationPresetsSnapshot.total, 1000);
  f.context.variationPresetsEditing = true;
  f.context.variationPresetsInput.value = "900";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls.length, 1);
});

test("future selection and Var # lookup never call the captured controller and incoming updates preserve the draft and selection", async () => {
  const f = fixture({ total: 200 });
  f.context.variationSearchInput.value = "80";
  await f.context.variationSearchForm.dispatch("submit");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.context.getActiveView().isReviewingHistory, true);
  assert.deepEqual(f.selections, []);
  f.rawView.currentVariationNumber = 31;
  f.rawView.selectedVariationNumber = 31;
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  f.context.renderAll();
  assert.equal(f.context.variationSearchInput.value, "80");
  assert.equal(f.context.getActiveView().currentVariationNumber, 31);
});

test("future assignment and unassignment use only revision-checked preset messages and leave inventory unchanged", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(81);
  const before = JSON.stringify(f.rawView);
  f.context.saveOrdinaryInventorySelection({ dataset: { sku: "A" } }, f.context.getActiveView());
  await settle();
  assert.equal(f.calls[0].kind, "setPresetItem");
  assert.equal(f.calls[0].command.variationNumber, 81);
  assert.equal(f.calls[0].command.sku, "A");
  assert.equal(JSON.stringify(f.rawView), before);
  f.context.saveOrdinaryInventorySelection({ dataset: { sku: "A" } }, f.context.getActiveView());
  await settle();
  assert.equal(f.calls[1].command.sku, null);
  assert.equal(JSON.stringify(f.rawView), before);
});

test("Return to live from a future variation clears the Var # draft and resumes actual current selection", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  f.context.variationSearchInput.value = "80";
  await f.context.returnToCurrentButton.dispatch("click");
  assert.deepEqual(f.selections, [30]);
  assert.equal(f.context.selectedPresetVariationNumber, null);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 30);
  assert.equal(f.context.variationSearchInput.value, "");
});

test("reset from live, history or future deletes only the display plan after acknowledgement and returns actual live", async () => {
  for (const selected of [30, 29, 80]) {
    const f = fixture({ total: 200 });
    f.context.selectVariationFromPicker(selected);
    const before = clone(f.rawView.variations);
    await f.context.variationPresetsButton.dispatch("click");
    assert.equal(f.calls.at(-1).kind, "resetPresets");
    assert.equal(f.context.variationPresetsSnapshot.total, null);
    assert.equal(f.context.variationPresetsButton.textContent, "Preset items");
    assert.equal(f.context.getActiveView().selectedVariationNumber, 30);
    assert.deepEqual(f.rawView.variations.map(({ selected, ...entry }) => entry), before.map(({ selected, ...entry }) => entry));
    assert.equal(f.context.getActiveView().variations.length, 3);
  }
});

test("failed reset preserves presets, the future view and Reset control", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  f.context.variationPresetsClient.resetPresets = async () => { throw new Error("Synthetic storage failure"); };
  await f.context.variationPresetsButton.dispatch("click");
  assert.equal(f.context.variationPresetsSnapshot.total, 200);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic storage failure/);
});

test("duplicate reset and stale prior-stream acknowledgements cannot remove another configuration", async () => {
  const f = fixture({ total: 200 }), reply = deferred();
  let requests = 0;
  f.context.variationPresetsClient.resetPresets = () => { requests++; return reply.promise; };
  const first = f.context.mutateVariationPresets("resetPresets");
  await f.context.mutateVariationPresets("resetPresets");
  assert.equal(requests, 1);
  assert.equal(f.context.variationPresetsButton.disabled, true);
  f.context.resetVariationPresetsDisplay();
  f.context.mountedStreamId = "another-stream";
  f.context.variationPresetsSnapshot = { ...presetSnapshot(300), streamId: "another-stream" };
  reply.resolve(presetSnapshot(null));
  await first;
  assert.equal(f.context.variationPresetsSnapshot.total, 300);
  assert.deepEqual(f.selections, []);
});

test("late mutation acknowledgement cannot overwrite a newer authoritative refresh", async () => {
  const f = fixture({ total: 200 }), reply = deferred();
  f.context.variationPresetsClient.setPresetItem = () => reply.promise;
  const action = f.context.mutateVariationPresets("setPresetItem", { variationNumber: 81, sku: "A" });
  f.context.variationPresetsReadGeneration += 1;
  f.context.variationPresetsSnapshot = presetSnapshot(null);
  reply.resolve(presetSnapshot(200));
  await action;
  assert.equal(f.context.variationPresetsSnapshot.total, null);
});

test("out-of-order reads and old stream responses cannot resurrect discarded presets", async () => {
  const f = fixture({ total: 200 }), first = deferred(), second = deferred();
  let reads = 0;
  f.context.variationPresetsClient.getPresets = () => ++reads === 1 ? first.promise : second.promise;
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), f.context);
  f.context.scheduleVariationPresetsRefresh();
  await settle();
  f.context.scheduleVariationPresetsRefresh();
  await settle();
  second.resolve(presetSnapshot(null));
  await settle();
  first.resolve(presetSnapshot(200));
  await settle();
  assert.equal(f.context.variationPresetsSnapshot.total, null);
});

test("a newly captured selected placeholder switches to the real history controller exactly once", () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  f.rawView.variations.push({ variationNumber: 80, recorded: true, sku: "A" });
  assert.equal(f.context.preserveCapturedPresetSelection(f.context.savedSnapshot), true);
  assert.equal(f.context.selectedPresetVariationNumber, null);
  assert.deepEqual(f.selections, [80]);
  assert.equal(f.context.preserveCapturedPresetSelection(f.context.savedSnapshot), false);
  assert.equal(f.context.getActiveView().variations.find((entry) => entry.variationNumber === 80).preset, undefined);
});

test("next-preset queue guard blocks queueing but preserves unmapped-live and historical live mapping routes", async () => {
  const f = fixture({ total: 200 });
  f.context.variationPresetsSnapshot.assignments.push({ variationNumber: 31, sku: "A" });
  let toggles = 0;
  f.context.nextItemQueueClient = { async toggleQueue() { toggles++; return { queuedSku: null }; } };
  await f.context.toggleNextItemQueue({ dataset: { sku: "A" } }, f.context.getActiveView());
  assert.equal(toggles, 0);
  assert.match(f.context.mappingAnnouncement.textContent, /queuing is unavailable/);
  assert.equal(f.context.nextVariationHasPreset(f.context.getActiveView()), true);
  f.context.variationPresetsSnapshot.assignments = [{ variationNumber: 80, sku: "A" }];
  assert.equal(f.context.nextVariationHasPreset(f.context.getActiveView()), false);
  assert.match(declaration("mapCurrentVariationFromHistory"), /nextItemQueueClient\.mapCurrent/);
  assert.doesNotMatch(declaration("mapCurrentVariationFromHistory"), /nextVariationHasPreset|toggleQueue/);
});

test("queue, save, session, End, import and error guards disable preset entry including planning opt-in", async () => {
  for (const block of [
    (f) => { f.context.nextItemQueueMutationBusy = true; },
    (f) => { f.context.pendingSavedAction = {}; },
    (f) => { f.context.savedSnapshot.busy = true; },
    (f) => { f.context.savedSnapshot.phase = "error"; },
    (f) => { f.context.endConfirmationOpen = true; },
    (f) => { f.context.streamSnapshot.busy = true; },
    (f) => { f.context.streamSnapshot.resumed = false; },
    (f) => { f.context.activeStreamInventoryUpdateBusy = true; },
    (f) => { f.context.trackerWorkspace.toggleAttribute("inert", true); },
    (f) => { f.context.variationPresetsReady = false; },
  ]) {
    const f = fixture({ total: 200 });
    block(f);
    f.context.updateVariationPresetsAvailability();
    assert.equal(f.context.variationPresetsButton.disabled, true);
    await f.context.variationPresetsButton.dispatch("click");
    await f.context.mutateVariationPresets("resetPresets");
    assert.equal(f.calls.length, 0);
  }
});

test("presets stay hidden outside resumed tracking and Reload Site does not override unrelated locks", () => {
  const f = fixture();
  for (const change of [
    () => { f.context.archivedReportsViewOpen = true; },
    () => { f.context.trackerWorkspace.hidden = true; },
    () => { f.context.streamSnapshot.resumed = false; },
  ]) {
    change(); f.context.updateVariationPresetsAvailability();
    assert.equal(f.context.variationPresetsForm.hidden, true);
  }
  const other = fixture();
  other.context.captureHealthBadge.dataset.phase = "blank";
  other.context.updateVariationPresetsAvailability();
  assert.equal(other.context.variationPresetsButton.disabled, false);
  other.context.savedSnapshot.busy = true;
  other.context.updateVariationPresetsAvailability();
  assert.equal(other.context.variationPresetsButton.disabled, true);
});

test("in-flight queue and live-map requests disable preset controls and cannot be bypassed by stale clicks", async () => {
  for (const action of ["toggleNextItemQueue", "mapCurrentVariationFromHistory"]) {
    const f = fixture({ total: 200 }), reply = deferred();
    if (action === "mapCurrentVariationFromHistory") f.context.selectVariationFromPicker(80);
    Object.assign(f.context, {
      nextItemQueueMutationGeneration: 0, nextItemQueueRefreshGeneration: 0,
      clearQueuedItemButton: element(), canClearQueuedItem: () => false,
      nextItemQueueClient: { toggleQueue: () => reply.promise, mapCurrent: () => reply.promise },
    });
    vm.runInContext(declaration("updateQueuedItemBadgeAvailability"), f.context);
    const current = f.context.getActiveView();
    const pending = f.context[action]({ dataset: { sku: "A" } }, current);
    assert.equal(f.context.nextItemQueueMutationBusy, true);
    assert.equal(f.context.variationPresetsButton.disabled, true);
    assert.equal(f.context.variationPresetsInput.disabled, true);
    await f.context.variationPresetsButton.dispatch("click");
    assert.equal(f.calls.length, 0);
    reply.resolve({ queuedSku: null, sku: "A", status: "mapped_current" });
    await pending;
    assert.equal(f.context.nextItemQueueMutationBusy, false);
    assert.equal(f.context.variationPresetsButton.disabled, false);
    assert.equal(f.context.getActiveView().selectedVariationNumber, current.selectedVariationNumber);
  }
});

test("real controller holds intentional future browsing after promotion through subsequent capture until Return to live", async () => {
  const reconciliation = require("../extension/shared/reconciliation.js");
  const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
  const controllerModule = require("../extension/tagger/persistent-tagger-controller.js");
  const streamId = "synthetic-stream";
  const state = reconciliation.createReconciliationState([
    { sku: "A", item: "Synthetic", style: "", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId });
  reconciliation.observeVariations(state, { streamId, variationNumbers: [24] });
  const controller = controllerModule.createPersistentTaggerController({
    reconciliation, mappingWorkflow, streamId, currentVariationNumber: 24, variationNumbers: [24],
    client: {
      async getState() { return { state: clone(state), result: null }; },
      async initializeState() { assert.fail("Navigation cannot initialize data"); },
      async mapVariation() { assert.fail("Navigation cannot map an order"); },
      async unmapVariation() { assert.fail("Navigation cannot unmap an order"); },
    },
  });
  const f = fixture({ total: 200 });
  f.context.persistentController = controller;
  f.context.savedSnapshot = await controller.start();
  controller.subscribe((snapshot) => {
    f.context.savedSnapshot = snapshot;
    f.context.preserveCapturedPresetSelection(snapshot);
  });
  f.context.selectVariationFromPicker(25);
  reconciliation.observeVariations(state, { streamId, variationNumbers: [25] });
  await controller.refresh();
  assert.equal(f.context.getActiveView().selectedVariationNumber, 25);
  assert.equal(f.context.getActiveView().isReviewingHistory, true, "Keep Return to live visible even at the exact capture moment");
  reconciliation.observeVariations(state, { streamId, variationNumbers: [26] });
  await controller.refresh();
  assert.equal(f.context.getActiveView().currentVariationNumber, 26);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 25);
  await f.context.returnToCurrentButton.dispatch("click");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 26);
  assert.equal(f.context.getActiveView().isReviewingHistory, false);
  reconciliation.observeVariations(state, { streamId, variationNumbers: [27] });
  await controller.refresh();
  assert.equal(f.context.getActiveView().selectedVariationNumber, 27);
});

test("right-click fills an empty current future preset and then fills and advances through subsequent presets", async () => {
  const f = fixture({ total: 200 });
  f.rawView.inventory.push({ ...f.rawView.inventory[0], sku: "B", item: "Jeans" });
  f.context.selectVariationFromPicker(81);
  const canonicalBefore = JSON.stringify(f.rawView);
  await rightClick(f);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 81);
  await rightClick(f, "B");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 82);
  await rightClick(f);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 83);
  assert.deepEqual(f.calls.map(({ kind, command }) => [kind, command.variationNumber, command.sku]), [
    ["assignNextPresetItem", 81, "A"], ["assignNextPresetItem", 81, "B"], ["assignNextPresetItem", 82, "A"],
  ]);
  assert.deepEqual(clone(f.context.variationPresetsSnapshot.assignments.slice(-3)), [
    { variationNumber: 81, sku: "A" }, { variationNumber: 82, sku: "B" }, { variationNumber: 83, sku: "A" },
  ]);
  assert.equal(JSON.stringify(f.rawView), canonicalBefore, "No real orders, accounting, inventory, or live marker changed");
  assert.deepEqual(f.selections, []);
  assert.equal(f.context.variationSelector.focused, undefined, "Sequential assignment does not move keyboard focus to the dropdown");
});

test("sequential UI uses the worker-returned target, skipping assigned and captured future numbers without replacing either", async () => {
  const f = fixture({ total: 200 });
  f.context.variationPresetsSnapshot.assignments.push({ variationNumber: 81, sku: "A" });
  f.rawView.variations.push({ variationNumber: 82, recorded: true, sku: "A" });
  f.context.selectVariationFromPicker(80);
  await rightClick(f);
  assert.equal(f.calls[0].command.variationNumber, 80, "The panel sends the source, not its own guessed next target");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 83);
  assert.deepEqual(clone(f.context.variationPresetsSnapshot.assignments), [
    { variationNumber: 80, sku: "A" }, { variationNumber: 81, sku: "A" }, { variationNumber: 83, sku: "A" },
  ]);
  assert.equal(f.rawView.variations.find((entry) => entry.variationNumber === 82).sku, "A");
});

test("final empty preset accepts its first right-click; subsequent clicks preserve it and announce the end without wrapping", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(200);
  await rightClick(f);
  const saved = clone(f.context.variationPresetsSnapshot);
  await rightClick(f);
  assert.deepEqual(clone(f.context.variationPresetsSnapshot), saved);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 200);
  assert.equal(f.context.mappingAnnouncement.textContent, "No more future variations.");
  assert.equal(saved.assignments.some((entry) => entry.variationNumber === 199), false);
  assert.deepEqual(f.selections, []);
});

test("same SKU right-clicks never toggle off a preset, while left-click still unassigns the viewed future item", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  await rightClick(f);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 81);
  assert.equal(f.context.variationPresetsSnapshot.assignments.filter((entry) => entry.sku === "A").length, 2);
  await f.context.inventoryGrid.dispatch("click", { target: inventoryCard(f) });
  await settle();
  assert.equal(f.calls.at(-1).kind, "setPresetItem");
  assert.equal(f.calls.at(-1).command.sku, null);
  assert.equal(f.context.variationPresetsSnapshot.assignments.some((entry) => entry.variationNumber === 80), true);
  assert.equal(f.context.variationPresetsSnapshot.assignments.some((entry) => entry.variationNumber === 81), false);
});

test("sequential right-click failure neither advances nor retries or changes authoritative assignments", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  const before = clone(f.context.variationPresetsSnapshot);
  let requests = 0;
  f.context.variationPresetsClient.assignNextPresetItem = async () => { requests++; throw new Error("Synthetic save failure"); };
  await rightClick(f);
  assert.equal(requests, 1);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.deepEqual(clone(f.context.variationPresetsSnapshot), before);
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic save failure/);
  assert.equal(f.context.variationPresetsBusy, false);
});

test("rapid right-clicks are not buffered and cannot overlap a pending sequential assignment", async () => {
  const f = fixture({ total: 200 }), reply = deferred();
  f.context.selectVariationFromPicker(80);
  const client = f.context.variationPresetsClient.assignNextPresetItem;
  let requests = 0;
  f.context.variationPresetsClient.assignNextPresetItem = async (command) => {
    requests++;
    const result = await client(command);
    await reply.promise;
    return result;
  };
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
  assert.equal(f.context.variationPresetsBusy, true);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
  assert.equal(requests, 1);
  reply.resolve();
  await settle();
  assert.equal(f.context.getActiveView().selectedVariationNumber, 81);
  assert.equal(requests, 1);
});

test("a delayed sequential acknowledgement does not override navigation to a captured variation", async () => {
  const f = fixture({ total: 200 }), reply = deferred();
  f.context.selectVariationFromPicker(80);
  const client = f.context.variationPresetsClient.assignNextPresetItem;
  f.context.variationPresetsClient.assignNextPresetItem = async (command) => {
    const result = await client(command); await reply.promise; return result;
  };
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
  f.context.selectVariationFromPicker(29);
  reply.resolve();
  await settle();
  assert.equal(f.context.getActiveView().selectedVariationNumber, 29);
  assert.equal(f.context.variationPresetsSnapshot.assignments.some((entry) => entry.variationNumber === 81), true);
});

test("late sequential acknowledgements cannot restore a reset, another baseline, or another stream", async () => {
  for (const transition of ["reset", "baseline", "stream"]) {
    const f = fixture({ total: 200 }), reply = deferred();
    f.context.selectVariationFromPicker(80);
    const old = clone(f.context.variationPresetsSnapshot);
    f.context.variationPresetsClient.assignNextPresetItem = () => reply.promise;
    await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
    f.context.resetVariationPresetsDisplay();
    const replacement = presetSnapshot(300);
    replacement.revision = "new-configuration";
    if (transition === "reset") { replacement.total = null; replacement.assignments = []; }
    if (transition === "baseline") replacement.baselineId = "another-baseline";
    if (transition === "stream") { replacement.streamId = "another-stream"; f.context.mountedStreamId = "another-stream"; }
    f.context.variationPresetsSnapshot = replacement;
    reply.resolve({ presets: { ...old, revision: "old-reply", assignments: [...old.assignments, { variationNumber: 81, sku: "A" }] }, assignedVariationNumber: 81 });
    await settle();
    assert.deepEqual(clone(f.context.variationPresetsSnapshot), replacement);
    assert.equal(f.context.selectedPresetVariationNumber, null);
  }
});

test("capture of a future-card source before its stale contextmenu event never falls back to live mapping", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  const card = inventoryCard(f);
  f.rawView.variations.push({ variationNumber: 80, recorded: true, sku: "A" });
  f.context.preserveCapturedPresetSelection(f.context.savedSnapshot);
  f.context.mapCurrentVariationFromHistory = () => assert.fail("Stale future action must not map live");
  f.context.toggleNextItemQueue = () => assert.fail("Stale future action must not queue");
  await f.context.inventoryGrid.dispatch("contextmenu", { target: card });
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
});

test("capture after sequential submission keeps the newly captured source selected instead of jumping on a late acknowledgement", async () => {
  const f = fixture({ total: 200 }), reply = deferred();
  f.context.selectVariationFromPicker(80);
  const client = f.context.variationPresetsClient.assignNextPresetItem;
  f.context.variationPresetsClient.assignNextPresetItem = async (command) => { const result = await client(command); await reply.promise; return result; };
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
  f.rawView.variations.push({ variationNumber: 80, recorded: true, sku: "A" });
  f.context.preserveCapturedPresetSelection(f.context.savedSnapshot);
  reply.resolve(); await settle();
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.context.getActiveView().isReviewingPreset, false);
});

test("a notification read starting before the assignment acknowledgement does not suppress successful forward navigation", async () => {
  const f = fixture({ total: 200 });
  f.context.selectVariationFromPicker(80);
  const client = f.context.variationPresetsClient.assignNextPresetItem;
  f.context.variationPresetsClient.assignNextPresetItem = async (command) => {
    const result = await client(command);
    f.context.variationPresetsReadGeneration++;
    return result;
  };
  await rightClick(f);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 81);
});

test("newer authoritative preset refresh suppresses stale sequential navigation and snapshot replacement", async () => {
  const f = fixture({ total: 200 }), reply = deferred();
  f.context.selectVariationFromPicker(80);
  const old = clone(f.context.variationPresetsSnapshot);
  f.context.variationPresetsClient.assignNextPresetItem = () => reply.promise;
  await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f) });
  const current = { ...presetSnapshot(null), revision: "newer-reset" };
  f.context.variationPresetsReadGeneration++;
  f.context.variationPresetsSnapshot = current;
  reply.resolve({ presets: { ...old, revision: "older-assignment" }, assignedVariationNumber: 81 });
  await settle();
  assert.deepEqual(clone(f.context.variationPresetsSnapshot), current);
  assert.notEqual(f.context.getActiveView().selectedVariationNumber, 81);
});

function installSizeMenu(f) {
  f.rawView.inventory.push({ ...f.rawView.inventory[0], sku: "A-L", size: "L" });
  Object.assign(f.context, {
    queuedNextItemSku: null, variationSelectorOpen: false,
    findInventoryGroup: (view) => ({ key: "synthetic-group", entries: view.inventory }),
    renderInventorySizeOptions(group, view, intent) { f.sizeIntent = intent; },
    showInventorySizeListbox() {}, setActiveInventorySize(sku) { f.preferredSize = sku; },
  });
  vm.runInContext(declaration("openInventorySizeMenu"), f.context);
  vm.runInContext(declaration("getInventorySizeOptionActionDescription"), f.context);
}

test("future right-click opens existing size picker and submits only the exact chosen SKU, never a representative size", async () => {
  const f = fixture({ total: 200 });
  installSizeMenu(f);
  f.context.selectVariationFromPicker(80);
  const card = inventoryCard(f, "A", true);
  await f.context.inventoryGrid.dispatch("contextmenu", { target: card });
  assert.equal(f.calls.length, 0);
  assert.equal(f.context.inventorySizeMenuState.intent, "preset_context");
  assert.equal(f.preferredSize, "A");
  f.context.selectInventorySizeFromPicker("A-L");
  await settle();
  assert.equal(f.calls[0].kind, "assignNextPresetItem");
  assert.equal(f.calls[0].command.sku, "A-L");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 81);
  assert.equal(f.context.variationPresetsSnapshot.assignments.find((entry) => entry.variationNumber === 81).sku, "A-L");
  assert.match(f.context.getInventorySizeOptionActionDescription({}, f.context.getActiveView(), "preset_context"), /next empty future preset/);
});

test("keyboard context-menu entry uses the same future-size intent and does not submit before size confirmation", async () => {
  const f = fixture({ total: 200 });
  installSizeMenu(f);
  f.context.selectVariationFromPicker(81);
  await f.context.inventoryGrid.dispatch("keydown", { target: inventoryCard(f, "A", true), key: "F10", shiftKey: true });
  assert.equal(f.context.inventorySizeMenuState.intent, "preset_context");
  assert.equal(f.calls.length, 0);
  f.context.selectInventorySizeFromPicker("A-L");
  await settle();
  assert.equal(f.calls[0].command.sku, "A-L");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 81);
});

test("capture, reset and assignment-revision changes while choosing a future size reject the old intent without live fallback", async () => {
  for (const change of ["capture", "reset", "revision"]) {
    const f = fixture({ total: 200 });
    installSizeMenu(f);
    f.context.selectVariationFromPicker(80);
    await f.context.inventoryGrid.dispatch("contextmenu", { target: inventoryCard(f, "A", true) });
    f.context.mapCurrentVariationFromHistory = () => assert.fail("A stale future size choice must not map live");
    if (change === "capture") {
      f.rawView.variations.push({ variationNumber: 80, recorded: true, sku: "A" });
      f.context.preserveCapturedPresetSelection(f.context.savedSnapshot);
    } else if (change === "reset") f.context.variationPresetsSnapshot = presetSnapshot(null);
    else f.context.variationPresetsSnapshot.revision = "newer-assignment";
    f.context.selectInventorySizeFromPicker("A-L");
    await settle();
    assert.equal(f.calls.length, 0);
    assert.equal(f.context.inventorySizeMenuState, null);
  }
});

test("all existing loading, session and busy safeguards prevent stale sequential right-click and future size submissions", async () => {
  for (const block of [
    (c) => { c.captureHealthBadge.dataset.phase = "connecting"; },
    (c) => { c.captureHealthBadge.dataset.phase = "loading"; },
    (c) => { c.nextItemQueueMutationBusy = true; },
    (c) => { c.variationPresetsBusy = true; },
    (c) => { c.pendingSavedAction = {}; },
    (c) => { c.savedSnapshot.busy = true; },
    (c) => { c.savedSnapshot.phase = "error"; },
    (c) => { c.endConfirmationOpen = true; },
    (c) => { c.streamSnapshot.busy = true; },
    (c) => { c.streamSnapshot.resumed = false; },
    (c) => { c.activeStreamInventoryUpdateBusy = true; },
    (c) => { c.trackerWorkspace.toggleAttribute("inert", true); },
    (c) => { c.variationPresetsReady = false; },
  ]) {
    const f = fixture({ total: 200 });
    installSizeMenu(f);
    f.context.selectVariationFromPicker(80);
    const card = inventoryCard(f);
    const context = card.futurePresetContext;
    block(f.context);
    await f.context.inventoryGrid.dispatch("contextmenu", { target: card });
    await f.context.assignNextFuturePreset(card, context);
    f.context.openInventorySizeMenu(inventoryCard(f, "A", true), "context");
    assert.equal(f.calls.length, 0);
    assert.equal(f.context.inventorySizeMenuState, null);
  }
});

test("actual live and captured-history contextmenu routes remain unchanged", async () => {
  for (const [number, route] of [[30, "queue"], [29, "live-map"]]) {
    const f = fixture({ total: 200 });
    f.context.selectVariationFromPicker(number);
    const actions = [];
    f.context.toggleNextItemQueue = (_button, view) => actions.push(["queue", view.selectedVariationNumber]);
    f.context.mapCurrentVariationFromHistory = (_button, view) => actions.push(["live-map", view.selectedVariationNumber]);
    await rightClick(f);
    assert.deepEqual(actions, [[route, number]]);
    assert.equal(f.calls.length, 0);
  }
});

function advanceLive(f, number) {
  f.rawView.activeBiddingVariationNumber = number;
  f.rawView.currentVariationNumber = number;
  if (!f.rawView.variations.some((entry) => entry.recorded && entry.variationNumber === number)) {
    f.rawView.variations.push({ variationNumber: number, recorded: true, sku: null });
  }
  f.context.updateVariationPresetsAvailability();
}

test("extension availability uses strict actual live advancement or its persisted latch, never selected or historical fallback numbers", () => {
  const view = baselineView(), presets = presetSnapshot(100);
  for (const current of [30, 100, 101, 900]) {
    view.currentVariationNumber = current;
    view.selectedVariationNumber = 900;
    view.variations.push({ variationNumber: current, recorded: true });
    assert.equal(projection.canExtend(view, presets), false);
  }
  view.activeBiddingVariationNumber = 100;
  assert.equal(projection.canExtend(view, presets), false);
  view.activeBiddingVariationNumber = 101;
  assert.equal(projection.canExtend(view, presets), true);
  view.activeBiddingVariationNumber = 125;
  assert.equal(projection.canExtend(view, presets), true);
  view.activeBiddingVariationNumber = null;
  assert.equal(projection.canExtend(view, presets), false);
  assert.equal(projection.canExtend(view, { ...presets, extensionAvailable: true }), true);
  assert.equal(projection.canExtend(view, { ...presets, streamId: "another-stream", extensionAvailable: true }), false);
  assert.equal(projection.canExtend(view, { ...presets, total: null, extensionAvailable: true }), false);
});

test("same-configuration late pre-latch snapshots cannot undo extension availability or leak it into another configuration", () => {
  const previous = { ...presetSnapshot(100), extensionAvailable: true };
  const incoming = presetSnapshot(100);
  const merged = projection.preserveExtensionAvailability(incoming, previous);
  assert.equal(merged.extensionAvailable, true);
  assert.equal(incoming.extensionAvailable, undefined);
  for (const changed of [
    { total: 200 }, { total: null }, { revision: "new-revision" },
    { baselineId: "new-baseline" }, { streamId: "new-stream" },
  ]) {
    const next = { ...incoming, ...changed };
    assert.equal(projection.preserveExtensionAvailability(next, previous), next);
    assert.equal(next.extensionAvailable, undefined);
  }
});

test("live 100 retains Reset; live 101 permits extending to 200 without selection, assignment, or canonical changes", async () => {
  const f = fixture({ total: 100 });
  f.context.selectVariationFromPicker(80);
  f.context.variationSearchInput.value = "80";
  advanceLive(f, 100);
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  advanceLive(f, 101);
  assert.equal(f.context.variationPresetsButton.textContent, "Preset items");
  const before = JSON.stringify(f.rawView);
  const assignments = clone(f.context.variationPresetsSnapshot.assignments);
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls[0].kind, "createPresets");
  assert.equal(f.calls[0].command.total, 200);
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  assert.equal(f.context.getActiveView().variations.length, 200);
  assert.equal(new Set(f.context.getActiveView().variations.map((entry) => entry.variationNumber)).size, 200);
  assert.deepEqual(clone(f.context.variationPresetsSnapshot.assignments), assignments);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.context.variationSearchInput.value, "80");
  assert.equal(JSON.stringify(f.rawView), before);
  assert.deepEqual(f.selections, []);
  advanceLive(f, 201);
  assert.equal(f.context.variationPresetsButton.textContent, "Preset items");
});

test("reopened exhausted snapshots retain Preset items after live bidding clears, while browsing and backfill alone do not enable it", async () => {
  const f = fixture({ total: 100 });
  f.context.selectVariationFromPicker(100);
  f.rawView.currentVariationNumber = 150;
  f.rawView.variations.push({ variationNumber: 150, recorded: true });
  f.rawView.activeBiddingVariationNumber = null;
  f.context.updateVariationPresetsAvailability();
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  f.context.variationPresetsSnapshot.extensionAvailable = true;
  f.context.updateVariationPresetsAvailability();
  assert.equal(f.context.variationPresetsButton.textContent, "Preset items");
  await f.context.variationPresetsButton.dispatch("click");
  assert.equal(f.context.variationPresetsEditing, true);
  assert.equal(f.calls.length, 0);
});

test("Escape cancels extension without clearing the saved range, its assignments, or current future selection", async () => {
  const f = fixture({ total: 100 });
  advanceLive(f, 120);
  f.context.selectVariationFromPicker(80);
  const before = clone(f.context.variationPresetsSnapshot);
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  await f.context.variationPresetsInput.dispatch("keydown", { key: "Escape" });
  assert.equal(f.context.variationPresetsEditing, false);
  assert.equal(f.context.variationPresetsButton.textContent, "Preset items");
  assert.deepEqual(clone(f.context.variationPresetsSnapshot), before);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.calls.length, 0);
});

test("ordinary preset reads and same-revision latching keep extension input text and focus intact", async () => {
  const f = fixture({ total: 100 });
  advanceLive(f, 101);
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "0200";
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), f.context);
  f.context.variationPresetsClient.getPresets = async () => ({ ...presetSnapshot(100), extensionAvailable: true });
  f.context.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(f.context.variationPresetsEditing, true);
  assert.equal(f.context.variationPresetsInput.value, "0200");
  assert.equal(f.context.variationPresetsInput.focused, true);
  f.rawView.activeBiddingVariationNumber = null;
  f.context.variationPresetsClient.getPresets = async () => presetSnapshot(100);
  f.context.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(f.context.variationPresetsSnapshot.extensionAvailable, true);
  assert.equal(f.context.variationPresetsInput.value, "0200");
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls[0].command.total, 200);
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
});

test("same-range promotion or reset/recreate revision changes preserve typed text but require a new explicit editor before submission", async () => {
  const f = fixture({ total: 100 });
  advanceLive(f, 101);
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), f.context);
  f.context.variationPresetsClient.getPresets = async () => ({ ...presetSnapshot(100), revision: "new-generation", extensionAvailable: true });
  f.context.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(f.context.variationPresetsEditing, true);
  assert.equal(f.context.variationPresetsInput.value, "200");
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls.length, 0);
  assert.match(f.context.mappingAnnouncement.textContent, /Reopen Preset items/);
  await f.context.variationPresetsInput.dispatch("keydown", { key: "Escape" });
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls[0].command.expectedRevision, "new-generation");
});

test("changed baseline or total invalidates an open extension editor without applying its draft to a replacement configuration", async () => {
  for (const replacement of [
    { ...presetSnapshot(100), baselineId: "another-baseline", extensionAvailable: true },
    { ...presetSnapshot(200), revision: "new-configuration" },
    { ...presetSnapshot(null), revision: "reset-configuration" },
  ]) {
    const f = fixture({ total: 100 });
    advanceLive(f, 101);
    await f.context.variationPresetsButton.dispatch("click");
    f.context.variationPresetsInput.value = "300";
    vm.runInContext(declaration("scheduleVariationPresetsRefresh"), f.context);
    f.context.variationPresetsClient.getPresets = async () => replacement;
    f.context.scheduleVariationPresetsRefresh(); await settle();
    assert.equal(f.context.variationPresetsEditing, false);
    assert.equal(f.context.variationPresetsEntryContext, null);
    await f.context.variationPresetsForm.dispatch("submit");
    assert.equal(f.calls.length, 0);
    assert.deepEqual(clone(f.context.variationPresetsSnapshot), replacement);
  }
});

test("extension validates invalid totals and latest captured minimum without limiting real capture", async () => {
  for (const query of ["", "0", "-1", "1.5", "2e2", "9007199254740992", "1001", "100", "110"]) {
    const f = fixture({ total: 100 });
    advanceLive(f, 120);
    await f.context.variationPresetsButton.dispatch("click");
    f.context.variationPresetsInput.value = query;
    await f.context.variationPresetsForm.dispatch("submit");
    assert.equal(f.calls.length, 0, query);
    assert.ok(f.context.variationPresetsInput.validationMessage, query);
    assert.equal(f.context.getActiveView().variations.some((entry) => entry.recorded && entry.variationNumber === 120), true);
  }
  const f = fixture({ total: 100 });
  advanceLive(f, 101);
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  advanceLive(f, 210);
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls.length, 0);
  assert.match(f.context.variationPresetsInput.validationMessage, /210/);
});

test("extension cannot exceed the existing 1000 cap and explains capture beyond that cap without removing captured entries", async () => {
  const f = fixture({ total: 1000 });
  advanceLive(f, 1001);
  const before = JSON.stringify(f.rawView);
  await f.context.variationPresetsButton.dispatch("click");
  assert.match(f.context.mappingAnnouncement.textContent, /1000-variation preset limit.*Normal tracking continues/);
  f.context.variationPresetsInput.value = "1000";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls.length, 0);
  assert.match(f.context.variationPresetsInput.validationMessage, /another preset range cannot be created/);
  assert.equal(f.context.getActiveView().variations.length, 1001);
  assert.equal(JSON.stringify(f.rawView), before);
});

test("failed extension preserves the authoritative range, skipped plans, selected future, and entered draft", async () => {
  const f = fixture({ total: 100 });
  advanceLive(f, 101);
  f.context.selectVariationFromPicker(80);
  const before = clone(f.context.variationPresetsSnapshot);
  f.context.variationPresetsClient.createPresets = async () => { throw new Error("Synthetic extension save failure"); };
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  await f.context.variationPresetsForm.dispatch("submit");
  assert.deepEqual(clone(f.context.variationPresetsSnapshot), before);
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.context.variationPresetsEditing, true);
  assert.equal(f.context.variationPresetsInput.value, "200");
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic extension save failure/);
});

test("capture overtaking an accepted extension before its reply keeps Preset items available rather than forcing Reset", async () => {
  const f = fixture({ total: 100 }), reply = deferred();
  advanceLive(f, 101);
  const client = f.context.variationPresetsClient.createPresets;
  f.context.variationPresetsClient.createPresets = async (command) => { const result = await client(command); await reply.promise; return result; };
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  const pending = f.context.variationPresetsForm.dispatch("submit");
  await settle();
  advanceLive(f, 201);
  await f.context.variationPresetsForm.dispatch("submit");
  assert.equal(f.calls.length, 1, "Do not buffer or duplicate submissions");
  reply.resolve(); await pending;
  assert.equal(f.context.variationPresetsSnapshot.total, 200);
  assert.equal(f.context.variationPresetsButton.textContent, "Preset items");
  assert.equal(f.context.variationPresetsEditing, false);
});

test("late extension replies do not overwrite a newer reset or steal focus after user navigation", async () => {
  for (const change of ["reset", "navigation", "stream"]) {
    const f = fixture({ total: 100 }), reply = deferred();
    advanceLive(f, 101);
    const client = f.context.variationPresetsClient.createPresets;
    f.context.variationPresetsClient.createPresets = async (command) => { const result = await client(command); await reply.promise; return result; };
    await f.context.variationPresetsButton.dispatch("click");
    f.context.variationPresetsInput.value = "200";
    const pending = f.context.variationPresetsForm.dispatch("submit");
    if (change === "navigation") f.context.selectVariationFromPicker(29);
    else {
      f.context.resetVariationPresetsDisplay();
      f.context.variationPresetsSnapshot = { ...presetSnapshot(null), revision: "newer-reset" };
      if (change === "stream") f.context.mountedStreamId = "another-stream";
    }
    reply.resolve(); await pending;
    assert.equal(f.context.variationPresetsButton.focused, undefined);
    if (change === "navigation") {
      assert.equal(f.context.getActiveView().selectedVariationNumber, 29);
      assert.equal(f.context.variationPresetsSnapshot.total, 200);
    } else assert.equal(f.context.variationPresetsSnapshot.total, null);
  }
});

test("Connecting/Loading and unrelated busy locks block extension entry and stale submission", async () => {
  for (const lock of [
    (c) => { c.captureHealthBadge.dataset.phase = "connecting"; },
    (c) => { c.captureHealthBadge.dataset.phase = "loading"; },
    (c) => { c.nextItemQueueMutationBusy = true; },
    (c) => { c.endConfirmationOpen = true; },
    (c) => { c.savedSnapshot.busy = true; },
    (c) => { c.activeStreamInventoryUpdateBusy = true; },
    (c) => { c.trackerWorkspace.toggleAttribute("inert", true); },
  ]) {
    const f = fixture({ total: 100 });
    advanceLive(f, 101);
    await f.context.variationPresetsButton.dispatch("click");
    f.context.variationPresetsInput.value = "200";
    lock(f.context);
    f.context.updateVariationPresetsAvailability();
    assert.equal(f.context.variationPresetsInput.disabled, true);
    await f.context.variationPresetsForm.dispatch("submit");
    assert.equal(f.calls.length, 0);
    assert.equal(f.context.variationPresetsSnapshot.total, 100);
  }
});

test("a stale reset acknowledgement cannot discard a newer extension editor or return its selected variation to live", async () => {
  const f = fixture({ total: 100 }), reply = deferred();
  f.context.selectVariationFromPicker(80);
  f.context.variationSearchInput.value = "80";
  f.context.variationPresetsClient.resetPresets = () => reply.promise;
  const pending = f.context.variationPresetsButton.dispatch("click");
  const newer = { ...presetSnapshot(200), revision: "new-configuration", extensionAvailable: true };
  f.context.variationPresetsReadGeneration++;
  f.context.variationPresetsSnapshot = newer;
  f.context.variationPresetsEditing = true;
  f.context.variationPresetsEntryContext = {
    streamId: newer.streamId, baselineId: newer.baselineId, revision: newer.revision, total: newer.total,
  };
  f.context.variationPresetsInput.value = "300";
  reply.resolve({ ...presetSnapshot(null), revision: "old-reset" });
  await pending;
  assert.deepEqual(clone(f.context.variationPresetsSnapshot), newer);
  assert.equal(f.context.variationPresetsEditing, true);
  assert.equal(f.context.variationPresetsInput.value, "300");
  assert.equal(f.context.getActiveView().selectedVariationNumber, 80);
  assert.equal(f.context.variationSearchInput.value, "80");
  assert.deepEqual(f.selections, []);
  assert.equal(f.context.variationPresetsButton.focused, undefined);
});

test("a successful extension notification arriving before its acknowledgement still announces the saved result", async () => {
  const f = fixture({ total: 100 }), reply = deferred();
  advanceLive(f, 101);
  const completed = { ...presetSnapshot(200), revision: "saved-extension" };
  f.context.variationPresetsClient.createPresets = () => reply.promise;
  await f.context.variationPresetsButton.dispatch("click");
  f.context.variationPresetsInput.value = "200";
  const pending = f.context.variationPresetsForm.dispatch("submit");
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), f.context);
  f.context.variationPresetsClient.getPresets = async () => completed;
  f.context.scheduleVariationPresetsRefresh(); await settle();
  assert.equal(f.context.variationPresetsEditing, false);
  reply.resolve(completed); await pending;
  assert.equal(f.context.variationPresetsButton.textContent, "Reset presets");
  assert.equal(f.context.variationPresetsButton.focused, true);
  assert.match(f.context.mappingAnnouncement.textContent, /Preset variations.*200 are ready/);
});
