const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const controllerModule = require("../extension/tagger/persistent-tagger-controller.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const variationPresetsView = require("../extension/tagger/variation-presets-view.js");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

// Run the actual handlers/registrations, with no browser, extension storage,
// rendered dropdown options, or captured customer data in the fixture.
function declaration(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, `Missing function: ${name}`);
  const end = source.indexOf("\n  }", start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}

function registrations(target) {
  const matches = [...source.matchAll(new RegExp(`^  ${target}\\.addEventListener\\(`, "gm"))];
  assert.ok(matches.length, `Missing registration: ${target}`);
  return matches.map(({ index }) => {
    const end = source.indexOf("\n  });", index);
    assert.ok(end > index);
    return source.slice(index, end + 6);
  }).join("\n");
}

function element(document) {
  const attributes = new Map();
  const handlers = new Map();
  return {
    value: "", textContent: "", hidden: false, disabled: false, dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    toggleAttribute(name, enabled) {
      if (enabled) attributes.set(name, ""); else attributes.delete(name);
    },
    focus(options) { document.activeElement = this; this.focusOptions = options; },
    setCustomValidity(message) { this.validationMessage = message; },
    addEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    dispatch(type, extra = {}) {
      const event = {
        type, target: this, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...extra,
      };
      // Intentionally deliver even to disabled elements: stale/programmatic
      // events must be guarded by the implementation, not this test double.
      for (const handler of handlers.get(type) ?? []) handler(event);
      return event;
    },
  };
}

function fixture({ numbers = [500, 1, 25, 212], selected = 500, total = null } = {}) {
  const document = { activeElement: null };
  const selectionCalls = [];
  const releases = [];
  const view = {
    streamId: "synthetic-step-stream", inventory: [],
    variations: numbers.map((variationNumber) => ({ variationNumber, recorded: true })),
    currentVariationNumber: numbers.length ? Math.max(...numbers) : null,
    selectedVariationNumber: selected, isReviewingHistory: false,
  };
  const context = {
    document, variationPresetsView,
    isCapturePlanningTarget: () => false,
    isCapturePlanningLocked: () => context.isCaptureInteractionLocked(),
    variationPresetsSnapshot: {
      streamId: view.streamId, baselineId: "synthetic-baseline", revision: "r1", total, assignments: [],
    },
    variationPresetsReady: true, variationPresetsBusy: false,
    variationPresetsEditing: false, selectedPresetVariationNumber: null,
    variationNavigationGeneration: 0, nextItemQueueMutationBusy: false,
    pendingSavedAction: null, activeStreamInventoryUpdateBusy: false,
    mountedStreamId: view.streamId,
    streamSnapshot: { activeSession: { streamId: view.streamId }, resumed: true, busy: false },
    savedSnapshot: { phase: "ready", busy: false, operation: "refresh", view },
    archivedReportsViewOpen: false, endConfirmationOpen: false,
    inventorySizeMenuState: null,
    describeSelectedVariation: (selectedView) => `Variation ${selectedView.selectedVariationNumber}`,
    variationListbox: { querySelectorAll() { assert.fail("Stepping must not read rendered dropdown options"); } },
    persistentController: {
      selectVariation(number) {
        selectionCalls.push(number);
        view.selectedVariationNumber = number;
        view.isReviewingHistory = number !== view.currentVariationNumber;
        return { view };
      },
    },
    releaseInventorySizeMenu(options) {
      releases.push(["size", clone(options)]);
      context.inventorySizeMenuState = null;
    },
    releaseVariationSelector(options) {
      releases.push(["variation", clone(options)]);
      if (options.restoreFocus) context.variationSelector.focus();
    },
    renderAll() { context.updateVariationStepAvailability(); return context.getActiveView(); },
    mutateVariationPresets() { assert.fail("Navigation must not write presets"); },
  };
  for (const name of [
    "variationStepControls", "previousVariationButton", "nextVariationButton",
    "variationSearchForm", "variationSearchInput", "trackerWorkspace", "captureHealthBadge",
    "mappingAnnouncement", "searchInput", "variationSelector",
    "variationPresetsForm", "variationPresetsButton", "variationPresetsInput",
  ]) context[name] = element(document);
  context.captureHealthBadge.dataset.phase = "active";
  vm.createContext(context);
  vm.runInContext([
    "getActiveView", "getRecordedVariations", "getSelectableVariations", "findVariationOption",
    "isCaptureInteractionLocked", "guardCaptureInteraction", "canChangeVariationPresets", "canUseVariationPresetData",
    "canSubmitVariationSearch", "updateVariationSearchAvailability", "updateVariationPresetsAvailability",
    "canStepVariation", "getAdjacentVariationNumber", "updateVariationStepAvailability", "stepVariation",
    "selectVariationFromPicker", "getFuturePresetContext", "isFuturePresetContextCurrent", "assignNextFuturePreset",
  ].map(declaration).join("\n"), context);
  vm.runInContext([
    registrations("previousVariationButton"), registrations("nextVariationButton"),
  ].join("\n"), context);
  context.updateVariationStepAvailability();
  return {
    context, view, selectionCalls, releases,
    selected() { return context.getActiveView()?.selectedVariationNumber ?? null; },
    previous() { return context.previousVariationButton.dispatch("click"); },
    next() { return context.nextVariationButton.dispatch("click"); },
  };
}

test("variation arrows are distinct accessible non-submit buttons in the existing tracker row", () => {
  assert.match(html, /id="variation-step-controls"[^>]*role="group"[^>]*aria-label="Variation navigation"[^>]*inert/);
  for (const [id, label] of [["previous-variation", "Previous variation"], ["next-variation", "Next variation"]]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1);
    assert.match(html, new RegExp(`<button id="${id}" type="button" aria-label="${label}" disabled><span aria-hidden="true">`));
  }
  assert.ok(html.indexOf('id="variation-search-input"') < html.indexOf('id="variation-step-controls"'));
  assert.ok(html.indexOf('id="variation-step-controls"') < html.indexOf('id="capture-health-badge"'));
});

test("actual click handlers step numerically through existing captures, skipping gaps and ignoring dropdown DOM", () => {
  const f = fixture();
  for (const expected of [212, 25, 1]) {
    f.previous();
    assert.equal(f.selected(), expected);
  }
  f.previous();
  for (const expected of [25, 212, 500]) {
    f.next();
    assert.equal(f.selected(), expected);
  }
  f.next();
  assert.deepEqual(f.selectionCalls, [212, 25, 1, 25, 212, 500]);
  assert.equal(f.context.nextVariationButton.disabled, true);
  assert.equal(f.context.previousVariationButton.disabled, false);
});

test("real preset projection includes captured numbers beyond the range and skips nonselectable entries", () => {
  const f = fixture({ numbers: [12, 8, 2], selected: 8, total: 5 });
  f.context.variationPresetsSnapshot.assignments = [
    { variationNumber: 5, sku: "SYNTHETIC-A" },
    { variationNumber: 4, sku: "SYNTHETIC-B" },
  ];
  const assignments = clone(f.context.variationPresetsSnapshot.assignments);
  f.view.variations.push({ variationNumber: 7, recorded: false, preset: false });
  assert.deepEqual(f.context.getActiveView().variations.map(({ variationNumber }) => variationNumber), [12, 8, 5, 4, 3, 2, 1]);
  f.previous();
  assert.equal(f.selected(), 5);
  assert.equal(f.context.getActiveView().isReviewingPreset, true);
  assert.deepEqual(f.selectionCalls, [], "Future selection is not canonical selection or mapping");
  f.previous();
  assert.equal(f.selected(), 4, "Navigation includes assigned presets; only sequential item assignment skips them");
  f.next();
  f.next();
  f.next();
  assert.equal(f.selected(), 12);
  assert.deepEqual(f.selectionCalls, [8, 12]);
  assert.equal(f.context.selectedPresetVariationNumber, null);
  assert.deepEqual(f.context.variationPresetsSnapshot.assignments, assignments);
});

test("boundaries, invalid directions, absent selection and empty options never wrap or choose a default", () => {
  for (const options of [
    { numbers: [], selected: null },
    { numbers: [2, 7], selected: null },
    { numbers: [2, 7], selected: 3 },
    { numbers: [5], selected: 5 },
    { numbers: [], selected: null, total: 200 },
  ]) {
    const f = fixture(options);
    const before = f.selected();
    assert.equal(f.context.previousVariationButton.disabled, true);
    assert.equal(f.context.nextVariationButton.disabled, true);
    f.previous(); f.next();
    assert.equal(f.selected(), before);
    assert.deepEqual(f.selectionCalls, []);
    assert.equal(f.context.variationNavigationGeneration, 0);
  }
  const f = fixture();
  for (const direction of [0, 2, -2, null, undefined, "1", NaN]) {
    assert.equal(f.context.getAdjacentVariationNumber(direction), null);
    f.context.stepVariation(direction);
  }
  assert.deepEqual(f.selectionCalls, []);
});

test("each click recomputes candidates from refreshed capture and reset state, not stale button state", () => {
  const f = fixture({ numbers: [10, 1], selected: 10 });
  assert.equal(f.context.nextVariationButton.disabled, true);
  f.view.variations.push({ variationNumber: 15, recorded: true });
  f.next();
  assert.equal(f.selected(), 15, "A fresh capture is available even before a button rerender");
  f.context.variationPresetsSnapshot.total = 20;
  f.context.updateVariationStepAvailability();
  assert.equal(f.context.nextVariationButton.disabled, false);
  f.context.variationPresetsSnapshot.total = null;
  f.next();
  assert.equal(f.selected(), 15, "A reset removed the apparent next placeholder before this event");
  f.previous();
  assert.equal(f.selected(), 10);
  assert.deepEqual(f.selectionCalls, [15, 10]);
});

test("arrows preserve the Var # draft and validation while reusing ordinary selector filter behavior", () => {
  const f = fixture({ numbers: [1, 2], selected: 2, total: 3 });
  f.context.variationSearchInput.value = "unfinished draft 02";
  f.context.variationSearchInput.setCustomValidity("Existing search feedback");
  f.context.variationSearchInput.setAttribute("aria-invalid", "true");
  f.context.searchInput.value = "existing inventory filter";
  f.next();
  assert.equal(f.selected(), 3);
  f.previous();
  assert.equal(f.selected(), 2);
  assert.equal(f.context.variationSearchInput.value, "unfinished draft 02");
  assert.equal(f.context.variationSearchInput.validationMessage, "Existing search feedback");
  assert.equal(f.context.variationSearchInput.getAttribute("aria-invalid"), "true");
  assert.equal(f.context.searchInput.value, "", "Keep existing variation selection's inventory-filter clearing");
});

test("Connecting and Loading block stale clicks and compose disabled/inert availability", () => {
  for (const phase of ["connecting", "loading"]) {
    const f = fixture();
    f.context.captureHealthBadge.dataset.phase = phase;
    f.context.updateVariationSearchAvailability();
    assert.equal(f.context.previousVariationButton.disabled, true);
    assert.equal(f.context.nextVariationButton.disabled, true);
    assert.equal(f.context.variationStepControls.hasAttribute("inert"), true);
    const event = f.previous();
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(f.selectionCalls, []);
    assert.equal(f.context.variationNavigationGeneration, 0);
  }
});

test("Active and Reload Site never override queue, import, saved-action, session or error safeguards", () => {
  const restrictions = [
    ["queue mutation", (c) => { c.nextItemQueueMutationBusy = true; }],
    ["pending saved action", (c) => { c.pendingSavedAction = { type: "mapping" }; }],
    ["inventory import", (c) => { c.activeStreamInventoryUpdateBusy = true; }],
    ["preset mutation", (c) => { c.variationPresetsBusy = true; }],
    ["session busy", (c) => { c.streamSnapshot.busy = true; }],
    ["session not resumed", (c) => { c.streamSnapshot.resumed = false; }],
    ["no active session", (c) => { c.streamSnapshot.activeSession = null; }],
    ["controller unavailable", (c) => { c.persistentController = null; }],
    ["saved error", (c) => { c.savedSnapshot.phase = "error"; }],
    ["saved loading", (c) => { c.savedSnapshot.phase = "loading"; }],
    ["saved busy", (c) => { c.savedSnapshot.busy = true; }],
    ["End confirmation", (c) => { c.endConfirmationOpen = true; }],
    ["inert workspace", (c) => { c.trackerWorkspace.toggleAttribute("inert", true); }],
    ["setup/report view", (c) => { c.trackerWorkspace.hidden = true; }],
    ["archived reports", (c) => { c.archivedReportsViewOpen = true; }],
    ["not tracking", (c) => { c.captureHealthBadge.dataset.phase = "not_tracking"; }],
  ];
  for (const phase of ["active", "blank"]) {
    for (const [name, restrict] of restrictions) {
      const f = fixture();
      f.context.captureHealthBadge.dataset.phase = phase;
      restrict(f.context);
      f.context.updateVariationSearchAvailability();
      assert.equal(f.context.previousVariationButton.disabled, true, `${phase}: ${name}`);
      assert.equal(f.context.nextVariationButton.disabled, true, `${phase}: ${name}`);
      assert.equal(f.context.variationStepControls.hasAttribute("inert"), true, `${phase}: ${name}`);
      f.previous(); f.next();
      assert.deepEqual(f.selectionCalls, [], `${phase}: ${name}`);
      assert.equal(f.context.variationNavigationGeneration, 0, `${phase}: ${name}`);
    }
    const f = fixture();
    f.context.captureHealthBadge.dataset.phase = phase;
    f.context.updateVariationSearchAvailability();
    f.previous();
    assert.equal(f.selected(), 212, `${phase} allows otherwise-safe navigation`);
  }
});

test("busy lifecycle refreshes arrow availability when queue, preset, import and saved actions settle", () => {
  for (const key of ["nextItemQueueMutationBusy", "variationPresetsBusy", "activeStreamInventoryUpdateBusy", "pendingSavedAction"]) {
    const f = fixture();
    f.context[key] = key === "pendingSavedAction" ? { type: "mapping" } : true;
    f.context.updateVariationPresetsAvailability();
    assert.equal(f.context.previousVariationButton.disabled, true, key);
    f.context[key] = key === "pendingSavedAction" ? null : false;
    f.context.updateVariationPresetsAvailability();
    assert.equal(f.context.previousVariationButton.disabled, false, key);
  }
  assert.match(declaration("updateVariationSearchAvailability"), /updateVariationStepAvailability\(\)/);
  assert.match(declaration("updateVariationPresetsAvailability"), /updateVariationStepAvailability\(\)/);
  assert.match(declaration("updateQueuedItemBadgeAvailability"), /updateVariationPresetsAvailability\(\)/);
  assert.match(declaration("renderSavedSnapshot"), /pendingSavedAction = null;\s*updateVariationStepAvailability\(\)/);
});

test("unavailable preset state blocks a future target before side effects without disabling valid captured navigation", () => {
  for (const restrict of [
    (c) => { c.variationPresetsReady = false; },
    (c) => { c.mountedStreamId = "other-synthetic-stream"; },
  ]) {
    const f = fixture({ numbers: [1, 2], selected: 2, total: 4 });
    f.context.searchInput.value = "keep inventory filter";
    restrict(f.context);
    f.context.updateVariationStepAvailability();
    assert.equal(f.context.nextVariationButton.disabled, true);
    assert.equal(f.context.previousVariationButton.disabled, false);
    f.next();
    assert.equal(f.selected(), 2);
    assert.equal(f.context.searchInput.value, "keep inventory filter");
    assert.equal(f.context.variationNavigationGeneration, 0);
    assert.deepEqual(f.releases, []);
    f.previous();
    assert.equal(f.selected(), 1);
    assert.deepEqual(f.selectionCalls, [1]);
  }
});

test("successful stepping closes a size picker without stealing its focus back and supports repeated arrow activation", () => {
  const f = fixture({ numbers: [1, 3, 5], selected: 5 });
  f.context.inventorySizeMenuState = { item: "Synthetic size choice" };
  f.previous();
  assert.deepEqual(f.releases[0], ["size", { restoreFocus: false }]);
  assert.equal(f.context.inventorySizeMenuState, null);
  assert.equal(f.context.document.activeElement, f.context.previousVariationButton);
  assert.deepEqual(clone(f.context.previousVariationButton.focusOptions), { preventScroll: true });
  f.previous();
  assert.equal(f.selected(), 1);
  assert.equal(f.context.previousVariationButton.disabled, true);
  assert.equal(f.context.document.activeElement, f.context.variationSelector, "Do not focus a disabled boundary button");
  const releaseCount = f.releases.length;
  f.previous();
  assert.equal(f.releases.length, releaseCount, "Boundary actions must not close pickers or move focus");
});

test("step navigation invalidates delayed future-item contexts even after returning to the same preset", () => {
  const f = fixture({ numbers: [1], selected: 1, total: 4 });
  f.next();
  const staleContext = f.context.getFuturePresetContext(f.context.getActiveView());
  assert.equal(staleContext.variationNumber, 2);
  assert.equal(f.context.isFuturePresetContextCurrent(staleContext), true);
  f.next();
  f.previous();
  assert.equal(f.selected(), 2);
  assert.equal(f.context.isFuturePresetContextCurrent(staleContext), false);
  assert.equal(f.context.assignNextFuturePreset({ dataset: { sku: "SYNTHETIC-A" } }, staleContext), undefined);
  assert.equal(f.context.variationNavigationGeneration, 3);
  // The existing asynchronous acknowledgement consumer uses the same epoch;
  // it cannot put a late assigned target over an intervening arrow selection.
  assert.match(declaration("mutateVariationPresets"), /navigationContext\.navigationGeneration === variationNavigationGeneration/);
});

test("actual capture promotion removes future-only selection without creating duplicate step targets", () => {
  const f = fixture({ numbers: [1], selected: 1, total: 4 });
  f.next();
  assert.equal(f.selected(), 2);
  f.view.variations.push({ variationNumber: 2, recorded: true, sku: "SYNTHETIC-A" });
  assert.equal(f.context.getActiveView().isReviewingPreset, false);
  assert.equal(f.context.getActiveView().variations.filter(({ variationNumber }) => variationNumber === 2).length, 1);
  f.next();
  assert.equal(f.selected(), 3);
  f.previous();
  assert.equal(f.selected(), 2);
  assert.deepEqual(f.selectionCalls, [2]);
  assert.equal(f.context.selectedPresetVariationNumber, null);
});

test("real persistent-controller navigation changes only selection, preserves planning/accounting/queue and keeps live-follow semantics", async () => {
  const streamId = "synthetic-step-stream";
  const state = reconciliation.createReconciliationState([
    { sku: "SYNTHETIC-A", item: "Synthetic tee", style: "", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId });
  reconciliation.observeVariations(state, { streamId, variationNumbers: [1, 5, 10] });
  reconciliation.mapVariation(state, { streamId, variationNumber: 5, sku: "SYNTHETIC-A" });
  let reads = 0;
  const client = {
    async getState() { reads += 1; return { state: clone(state), result: null }; },
    async initializeState() { assert.fail("Navigation must not initialize inventory"); },
    async mapVariation() { assert.fail("Navigation must not map inventory"); },
    async unmapVariation() { assert.fail("Navigation must not unmap inventory"); },
  };
  const controller = controllerModule.createPersistentTaggerController({
    client, reconciliation, mappingWorkflow, streamId,
    currentVariationNumber: 10, variationNumbers: [1, 5, 10],
  });
  const f = fixture({ numbers: [1, 5, 10], selected: 10, total: 12 });
  f.context.persistentController = controller;
  f.context.savedSnapshot = await controller.start();
  controller.subscribe((snapshot) => { f.context.savedSnapshot = snapshot; });
  f.context.variationPresetsSnapshot.assignments = [{ variationNumber: 11, sku: "SYNTHETIC-A" }];
  f.context.queuedNextItemSku = "SYNTHETIC-A";
  const before = clone(state);
  const presetsBefore = clone(f.context.variationPresetsSnapshot);
  const readsBefore = reads;
  f.next();
  assert.equal(f.selected(), 11);
  assert.equal(f.context.getActiveView().isReviewingPreset, true);
  f.previous();
  f.previous();
  assert.equal(f.selected(), 9);
  assert.equal(f.context.getActiveView().isReviewingPreset, true);
  f.context.selectVariationFromPicker(5);
  f.previous();
  assert.equal(f.selected(), 4);
  f.next();
  assert.equal(f.selected(), 5);
  assert.equal(controller.getSnapshot().view.isReviewingHistory, true);
  assert.deepEqual(state, before);
  assert.deepEqual(f.context.variationPresetsSnapshot, presetsBefore);
  assert.equal(reads, readsBefore, "Navigation needs no canonical reads or mutations");
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");

  reconciliation.observeVariations(state, { streamId, variationNumbers: [15] });
  await controller.refresh();
  assert.equal(f.selected(), 5, "Incoming updates preserve intentional history selection");
  assert.equal(controller.getSnapshot().view.currentVariationNumber, 15);
  f.context.selectVariationFromPicker(12);
  f.next();
  assert.equal(f.selected(), 15, "Capture beyond the preset range is reached normally");
  assert.equal(controller.getSnapshot().view.isReviewingHistory, false);
  reconciliation.observeVariations(state, { streamId, variationNumbers: [16] });
  await controller.refresh();
  assert.equal(f.selected(), 16, "Stepping onto live retains normal live-follow behavior");
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
  assert.deepEqual(f.context.variationPresetsSnapshot, presetsBefore);
});
