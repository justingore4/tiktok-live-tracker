const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const healthView = require("../extension/tagger/capture-health-view.js");

const taggerDirectory = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");

// Execute actual declarations/registrations with synthetic DOM objects. These
// tests exercise the application guards, not a simulation of browser inertness.
function declaration(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing implementation function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert.ok(end > match.index);
  return source.slice(match.index, end + 4);
}

function registration(target, event, occurrence = 0) {
  const expression = new RegExp(`^  ${target}\\.addEventListener\\(\\s*"${event}"`, "gm");
  const matches = [...source.matchAll(expression)];
  const match = matches[occurrence];
  assert.ok(match, `Missing registration: ${target}/${event}/${occurrence}`);
  const oneLineEnd = source.indexOf("\n", match.index);
  if (source.slice(match.index, oneLineEnd).trimEnd().endsWith(";")) {
    return source.slice(match.index, oneLineEnd);
  }
  const end = source.indexOf("\n  });", match.index);
  assert.ok(end > match.index);
  return source.slice(match.index, end + 6);
}

function node(parent = null, className = "") {
  const attributes = new Map();
  const listeners = new Map();
  const value = {
    parentElement: parent, children: [], hidden: false, disabled: false,
    dataset: {}, value: "", textContent: "", className, scrollTop: 80,
    classList: { contains: (name) => className.split(/\s+/).includes(name) },
    setAttribute(name, content) { attributes.set(name, String(content)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    toggleAttribute(name, force) {
      const applied = force === undefined ? !attributes.has(name) : force;
      if (applied) attributes.set(name, ""); else attributes.delete(name);
      return applied;
    },
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
    matches(selector) { return selector === ".capture-health-row" && className === "capture-health-row"; },
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (current.matches(selector)) return current;
      }
      return null;
    },
    addEventListener(type, handler) {
      const current = listeners.get(type) ?? [];
      current.push(handler); listeners.set(type, current);
    },
    dispatch(type, event = {}) {
      return Promise.all((listeners.get(type) ?? []).map((handler) => handler({
        type, target: this, preventDefault() {}, stopPropagation() {}, ...event,
      })));
    },
    blur() { this.blurred = true; },
    focus() { this.focused = true; },
  };
  Object.defineProperty(value, "inert", {
    get() { return attributes.has("inert"); },
    set(state) { value.toggleAttribute("inert", Boolean(state)); },
  });
  parent?.children.push(value);
  return value;
}

function fixture() {
  const trackerWorkspace = node();
  const row = node(trackerWorkspace, "capture-health-row");
  const captureHealthBadge = node(row);
  const captureHealthDescription = node(row);
  const variationSection = node(trackerWorkspace);
  const inventorySection = node(trackerWorkspace);
  const metricsSection = node(trackerWorkspace);
  const searchInput = node(inventorySection);
  searchInput.value = "keep my search";
  const activeStreamInventorySheetReference = node(inventorySection);
  activeStreamInventorySheetReference.value = "keep my draft Sheet link";
  const variationListbox = node();
  const inventorySizeListbox = node();
  const released = [];
  const context = {
    trackerWorkspace, captureHealthBadge, captureHealthDescription, captureHealthView: healthView,
    pendingTrackerEntryViewport: null, persistentController: null, mountedStreamId: null,
    focusSavedWorkspaceAfterRetry: false,
    // The dedicated variation-number search suite exercises its disabled state.
    updateVariationSearchAvailability() {},
    updateQueuedItemBadgeAvailability() {},
    updateVariationPresetsAvailability() {},
    // This suite covers the default, non-opted-in capture lock. Planning opt-in
    // executes the actual scope/target helpers in variation-presets-ui tests.
    isCapturePlanningTarget: () => false,
    isCapturePlanningEnabled: () => false,
    isCapturePlanningLocked: () => context.isCaptureInteractionLocked(),
    syncCapturePlanningScope: () => false,
    getActiveView: () => null,
    isFuturePresetContextCurrent: () => false,
    variationPresetsBusy: false, variationPresetsReady: true,
    isCurrentVariationMapped: () => true,
    nextVariationHasPreset: () => false,
    variationListbox, inventorySizeListbox, searchInput,
    addActiveStreamSkusButton: node(), activeStreamInventoryUpdateForm: node(),
    inventoryGrid: Object.assign(node(), { querySelectorAll: () => [] }),
    activeStreamInventorySheetReference,
    retrySavedSessionButton: node(), retryStreamSessionButton: node(),
    streamSnapshot: { resumed: true, activeSession: { streamId: "synthetic-stream" }, busy: false },
    archivedReportsViewOpen: false,
    activeStreamInventoryUpdateBusy: false,
    savedSnapshot: { phase: "ready", operation: "refresh", busy: false },
    variationSelectorOpen: false,
    variationSelectorLock: { isLocked: () => context.variationSelectorOpen },
    inventorySizeMenuState: null,
    endConfirmationOpen: false,
    document: { activeElement: searchInput },
    releaseVariationSelector(options) {
      released.push(["variation", options]);
      context.variationSelectorOpen = false;
      context.variationListbox.hidden = true;
    },
    releaseInventorySizeMenu(options) {
      released.push(["size", options]);
      context.inventorySizeMenuState = null;
      context.inventorySizeListbox.hidden = true;
    },
  };
  const names = [
    "isCaptureInteractionLocked", "isTrackerInteractionTarget", "guardCaptureInteraction",
    "syncCaptureInteractionLock", "syncCaptureInventoryLock", "setWorkspaceBusy", "snapshotIsBackgroundRefresh",
  ];
  vm.createContext(context);
  vm.runInContext(names.map(declaration).join("\n"), context);
  const callback = source.match(/onChange:\s*(\(state\) => \{[\s\S]*?\n    \})/);
  assert.ok(callback, "The real health subscription must apply the lock after rendering the validated badge");
  const onHealthChange = vm.runInContext(`(${callback[1]})`, context);
  function health(phase) {
    onHealthChange({ phase, reason: "initializing" });
  }
  return { context, health, released, row, sections: [variationSection, inventorySection, metricsSection] };
}

test("capture-loading locks every content section for blue/yellow without disabling the health badge", () => {
  const f = fixture();
  for (const phase of ["connecting", "loading", "connecting", "loading", "active", "loading", "blank"]) {
    f.health(phase);
    const locked = phase === "connecting" || phase === "loading";
    assert.equal(f.context.isCaptureInteractionLocked(), locked);
    for (const section of f.sections) assert.equal(section.inert, locked);
    assert.equal(f.context.variationListbox.inert, locked);
    assert.equal(f.context.inventorySizeListbox.inert, locked);
    assert.equal(f.context.retrySavedSessionButton.inert, locked);
    assert.equal(f.context.retryStreamSessionButton.inert, locked);
    assert.equal(f.row.inert, false, "Badge remains accessible and outside capture-only inert regions");
    assert.equal(f.context.trackerWorkspace.inert, false, "Capture-only lock does not inert the badge ancestor");
    assert.equal(f.context.searchInput.value, "keep my search");
    assert.equal(f.context.activeStreamInventorySheetReference.value, "keep my draft Sheet link");
    assert.equal(f.context.trackerWorkspace.scrollTop, 80);
  }
  f.health("invalid phase");
  assert.equal(f.context.captureHealthBadge.dataset.phase, "blank");
  assert.equal(f.context.isCaptureInteractionLocked(), false, "Uses the badge's validated fallback");
});

test("busy/ready refreshes and picker exemptions cannot unlock Connecting or Loading", () => {
  const f = fixture();
  for (const phase of ["connecting", "loading"]) {
    f.health(phase);
    for (const busy of [true, false, true, false]) {
      f.context.savedSnapshot = { phase: busy ? "loading" : "ready", operation: "refresh", busy };
      f.context.variationSelectorOpen = true;
      f.context.setWorkspaceBusy(busy);
      assert.ok(f.sections.every((section) => section.inert));
      assert.equal(f.context.trackerWorkspace.getAttribute("aria-busy"), String(busy));
    }
  }
});

test("green/blank release capture-only inertness without overriding save/error/end safeguards", () => {
  for (const phase of ["active", "blank"]) {
    for (const safeguard of ["save", "error", "end", "session"]) {
      const f = fixture();
      f.health("loading");
      if (safeguard === "save") f.context.savedSnapshot = { phase: "saving", busy: true };
      if (safeguard === "error") f.context.savedSnapshot.phase = "error";
      if (safeguard === "end") f.context.endConfirmationOpen = true;
      if (safeguard === "session") f.context.streamSnapshot.busy = true;
      f.health(phase);
      assert.ok(f.sections.every((section) => !section.inert));
      assert.equal(f.context.trackerWorkspace.inert, true, `${phase} retains ${safeguard} safeguard`);
    }
  }
});

test("capture-only lock applies only to the visible resumed tracker, not setup or report views", () => {
  for (const change of [
    (ctx) => { ctx.streamSnapshot.activeSession = null; },
    (ctx) => { ctx.streamSnapshot.resumed = false; },
    (ctx) => { ctx.trackerWorkspace.hidden = true; },
    (ctx) => { ctx.archivedReportsViewOpen = true; },
  ]) {
    const f = fixture();
    f.health("loading");
    change(f.context);
    f.context.syncCaptureInteractionLock();
    assert.equal(f.context.isCaptureInteractionLocked(), false);
    assert.ok(f.sections.every((section) => !section.inert));
    assert.equal(f.context.inventorySizeListbox.inert, false);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(taggerDirectory, "..", "report", "report.html"), "utf8"), /captureInteraction|capture-health/);
});

test("resuming the same tracker reapplies its last published health lock when the workspace becomes visible", () => {
  const f = fixture();
  let footerUpdates = 0;
  f.context.updateFooterVisibility = () => { footerUpdates++; };
  vm.runInContext(declaration("setTrackerWorkspaceVisible"), f.context);
  f.health("loading");
  f.context.streamSnapshot.resumed = false;
  f.context.setTrackerWorkspaceVisible(false);
  assert.equal(f.context.trackerWorkspace.hidden, true);
  assert.ok(f.sections.every((section) => !section.inert));
  // No new badge publication: same-session health may not emit a repeated state.
  f.context.streamSnapshot.resumed = true;
  f.context.setTrackerWorkspaceVisible(true);
  assert.equal(f.context.captureHealthBadge.dataset.phase, "loading");
  assert.equal(f.context.trackerWorkspace.hidden, false);
  assert.ok(f.sections.every((section) => section.inert));
  assert.equal(footerUpdates, 2);
  f.health("active");
  assert.ok(f.sections.every((section) => !section.inert));
});

test("in-flight SKU refresh exemptions cannot lift capture lock and unlocking preserves individual disabled controls", () => {
  for (const phase of ["active", "blank"]) {
    const f = fixture();
    f.context.activeStreamInventoryUpdateBusy = true;
    f.context.savedSnapshot = { phase: "loading", operation: "refresh", busy: true };
    f.context.searchInput.disabled = true;
    f.context.activeStreamInventorySheetReference.disabled = true;
    f.health("loading");
    assert.equal(f.context.trackerWorkspace.inert, false, "Existing import/background-refresh exemption is preserved");
    assert.equal(f.context.trackerWorkspace.getAttribute("aria-busy"), "false");
    assert.ok(f.sections.every((section) => section.inert), "Capture-only child lock still wins");
    f.health(phase);
    assert.ok(f.sections.every((section) => !section.inert));
    assert.equal(f.context.searchInput.disabled, true);
    assert.equal(f.context.activeStreamInventorySheetReference.disabled, true);
    assert.equal(f.context.activeStreamInventoryUpdateBusy, true, "Capture state does not finish/cancel an import");
  }
});

test("locking blurs editor focus and closes external pickers without clearing drafts or restoring focus", () => {
  const f = fixture();
  f.context.variationSelectorOpen = true;
  f.context.inventorySizeMenuState = { synthetic: true };
  f.health("loading");
  assert.equal(f.context.searchInput.blurred, true);
  assert.equal(f.context.variationSelectorOpen, false);
  assert.equal(f.context.inventorySizeMenuState, null);
  assert.deepEqual(f.released.map(([name]) => name).sort(), ["size", "variation"]);
  for (const [, options] of f.released) {
    assert.equal(options.restoreFocus, false);
    assert.notEqual(options.flush, false, "Deferred capture render must not be discarded by closing a picker");
  }
  f.health("connecting");
  assert.equal(f.released.length, 2, "Blue/yellow changes do not reopen/reclose menus");
  assert.equal(f.context.searchInput.value, "keep my search");
  assert.equal(f.context.activeStreamInventorySheetReference.value, "keep my draft Sheet link");
});

test("closing a size popover on capture lock flushes its pending inventory render without losing data or moving focus", () => {
  const f = fixture();
  const trigger = node(f.sections[1]);
  trigger.dataset.focusSku = "SYNTHETIC";
  const updatedView = { currentVariationNumber: 42, inventory: [{ sku: "SYNTHETIC", quantity: 8 }] };
  const rendered = [];
  Object.assign(f.context, {
    inventorySizeMenuState: { trigger }, activeInventorySizeSku: "SYNTHETIC",
    deferredInventoryRender: { view: updatedView, focusSku: "SYNTHETIC" },
    hideInventorySizeListbox() { f.context.inventorySizeListbox.hidden = true; },
    renderInventory(view, focusSku) { rendered.push({ view, focusSku }); },
    restoreCardFocus() { assert.fail("Closing for capture loading must not restore card focus"); },
  });
  vm.runInContext(declaration("releaseInventorySizeMenu"), f.context);
  f.health("loading");
  assert.equal(f.context.inventorySizeMenuState, null);
  assert.equal(f.context.deferredInventoryRender, null);
  assert.equal(f.context.activeInventorySizeSku, null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.deepEqual(rendered, [{ view: updatedView, focusSku: null }]);
  assert.equal(trigger.focused, undefined);
  assert.ok(f.sections.every((section) => section.inert));
  assert.equal(f.context.trackerWorkspace.scrollTop, 80);
});

function event(target, type, extras = {}) {
  return {
    target, type, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
    ...extras,
  };
}

test("guard blocks action events and stale external picker events but leaves End Tracking/report targets alone", () => {
  const f = fixture();
  f.health("loading");
  const targets = [f.context.searchInput, node(f.context.variationListbox), node(f.context.inventorySizeListbox), f.context.retrySavedSessionButton];
  for (const target of targets) {
    assert.equal(f.context.isTrackerInteractionTarget(target), true);
    for (const type of ["click", "contextmenu", "beforeinput", "input", "paste", "change", "submit", "drop"]) {
      const e = event(target, type);
      assert.equal(f.context.guardCaptureInteraction(e), true);
      assert.equal(e.stopped, true);
      assert.equal(e.prevented, true);
    }
  }
  const outside = node();
  assert.equal(f.context.isTrackerInteractionTarget(outside), false);
  f.health("active");
  const allowed = event(f.context.searchInput, "click");
  assert.equal(f.context.guardCaptureInteraction(allowed), false);
  assert.equal(allowed.stopped, false);
});

test("keyboard scrolling, tab navigation and browser shortcuts keep their defaults while app handlers are stopped", () => {
  const f = fixture();
  f.health("connecting");
  for (const extras of [
    ...["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ", "Tab"].map((key) => ({ key })),
    { key: "r", ctrlKey: true }, { key: "r", metaKey: true }, { key: "ArrowLeft", altKey: true },
  ]) {
    const e = event(f.context.searchInput, "keydown", extras);
    assert.equal(f.context.guardCaptureInteraction(e), true);
    assert.equal(e.prevented, false, `${JSON.stringify(extras)} default should remain available`);
    assert.equal(e.stopped, true, "The variation/search handlers must not consume a scrolling key");
  }
  for (const key of ["Enter", "k", "Backspace", "Delete", "ContextMenu"]) {
    const e = event(f.context.searchInput, "keydown", { key });
    f.context.guardCaptureInteraction(e);
    assert.equal(e.prevented, true);
  }
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) {
    const e = event(f.context.searchInput, type);
    f.context.guardCaptureInteraction(e);
    assert.equal(e.prevented, false, "Do not cancel native scrollbar/autoscroll defaults");
    assert.equal(e.stopped, true);
  }
});

test("document capture guards cover external pickers but do not intercept scrolling or End/report controls", () => {
  const f = fixture();
  const registered = new Map();
  f.context.document.addEventListener = (type, handler, capture) => {
    assert.equal(capture, true, "Block actions before delegated/target handlers execute");
    registered.set(type, handler);
  };
  const start = source.indexOf("  for (const eventType of [");
  const end = source.indexOf("\n  }", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end + 4), f.context);
  for (const type of ["wheel", "touchstart", "touchmove", "touchend", "scroll"]) {
    assert.equal(registered.has(type), false, `${type} must retain native scrolling`);
  }
  f.health("loading");
  for (const type of ["click", "contextmenu", "keydown", "input", "beforeinput", "paste", "submit", "drop"]) {
    assert.equal(typeof registered.get(type), "function");
    const inside = event(node(f.context.inventorySizeListbox), type, { key: "Enter" });
    registered.get(type)(inside);
    assert.equal(inside.stopped, true);
    const outside = event(node(), type, { key: "Enter" });
    registered.get(type)(outside);
    assert.equal(outside.stopped, false, "End, setup and reports outside locked targets remain usable");
    assert.equal(outside.prevented, false);
  }
});

test("direct mutation, queue, mapping, pin and picker calls cannot bypass the capture lock", async () => {
  const f = fixture();
  f.health("loading");
  const names = [
    "runSavedMutation", "toggleInventoryGroupPin", "selectVariationFromPicker", "openVariationSelector",
    "openInventorySizeMenu", "selectInventorySizeFromPicker", "saveOrdinaryInventorySelection",
    "toggleNextItemQueue", "mapCurrentVariationFromHistory",
  ];
  // No controller/data stubs: any call past the early lock guard fails loudly.
  vm.runInContext(names.map(declaration).join("\n"), f.context);
  for (const name of names) {
    await f.context[name](undefined, undefined);
  }
  assert.equal(f.context.searchInput.value, "keep my search");
});

test("search, expansion, return-to-live and SKU form event handlers reject stale actions while locked", async () => {
  const f = fixture();
  f.health("loading");
  vm.runInContext(declaration("handleInventorySizeMenuKeydown"), f.context);
  const actions = [
    ["searchInput", "input"], ["searchInput", "keydown"], ["clearSearchButton", "click"],
    ["inventoryListToggle", "click"], ["returnToCurrentButton", "click"],
    ["addActiveStreamSkusButton", "click"], ["cancelActiveStreamInventoryUpdateButton", "click"],
    ["activeStreamInventorySheetReference", "input"], ["activeStreamInventoryUpdateForm", "submit"],
    ["variationSelector", "click"], ["variationListbox", "click"],
    ["inventorySizeListbox", "click"], ["inventorySizeListbox", "keydown"],
    ["inventoryGrid", "click"], ["inventoryGrid", "click", 1],
    ["inventoryGrid", "contextmenu"], ["inventoryGrid", "keydown"],
  ];
  for (const [target, type, occurrence] of actions) {
    f.context[target] ??= node(f.sections[1]);
    vm.runInContext(registration(target, type, occurrence), f.context);
    await f.context[target].dispatch(type, { key: "Escape" });
  }
  assert.equal(f.context.searchInput.value, "keep my search");
  assert.equal(f.context.activeStreamInventorySheetReference.value, "keep my draft Sheet link");
});

test("search keyboard editing becomes available again in green/blank, without clearing it during blue/yellow", async () => {
  for (const phase of ["connecting", "loading", "active", "blank"]) {
    const f = fixture();
    let renders = 0;
    f.context.renderAll = () => { renders++; };
    vm.runInContext(registration("searchInput", "keydown"), f.context);
    f.health(phase);
    await f.context.searchInput.dispatch("keydown", { key: "Escape" });
    const locked = phase === "connecting" || phase === "loading";
    assert.equal(f.context.searchInput.value, locked ? "keep my search" : "");
    assert.equal(renders, locked ? 0 : 1);
  }
});

test("an already-started queue delivery completes and refreshes normally after capture becomes Loading", async () => {
  const f = fixture();
  f.health("active");
  let finish;
  const reply = new Promise((resolve) => { finish = resolve; });
  const view = { currentVariationNumber: 3, selectedVariationNumber: 3, inventory: [{ sku: "SYNTHETIC", size: "OS" }] };
  let requests = 0, renders = 0, refreshes = 0;
  Object.assign(f.context, {
    nextItemQueueMutationBusy: false, mountedStreamId: "synthetic-stream", nextItemQueueMutationGeneration: 0,
    nextItemQueueRefreshGeneration: 0, queuedNextItemToken: null,
    nextItemQueueClient: { toggleQueue() { requests++; return reply; } },
    getActiveView: () => view, renderInventory() { renders++; }, getFocusedInventorySku: () => null,
    mappingAnnouncement: {}, formatItemName: () => "Synthetic item", scheduleNextItemQueueRefresh() { refreshes++; },
  });
  vm.runInContext(declaration("toggleNextItemQueue"), f.context);
  const pending = f.context.toggleNextItemQueue({ dataset: { sku: "SYNTHETIC" } }, view);
  assert.equal(requests, 1);
  f.health("loading");
  finish({ queuedSku: "SYNTHETIC", status: "queued" });
  await pending;
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC");
  assert.equal(renders, 1);
  assert.equal(refreshes, 1);
  assert.equal(f.context.nextItemQueueMutationBusy, false);
  assert.equal(f.context.isCaptureInteractionLocked(), true);
});

test("an in-flight Sheet import can finish and refresh inventory while a new capture lock stays active", async () => {
  const f = fixture();
  f.health("active");
  let finish;
  const reply = new Promise((resolve) => { finish = resolve; });
  let refreshes = 0, imports = 0;
  Object.assign(f.context, {
    activeStreamInventoryUpdateForm: node(f.sections[1]), activeStreamInventoryUpdateError: {},
    activeStreamInventoryUpdateOpen: true, mappingAnnouncement: {},
    persistentController: { async refresh() { refreshes++; return { phase: "ready", operation: "refresh" }; } },
    inventoryImportClient: { addActiveStreamSkusReference() { imports++; return reply; } },
    clearActiveStreamInventoryUpdateError() {}, clearActiveStreamInventoryUpdateFeedback() {},
    renderActiveStreamInventoryUpdateControls() { f.context.setWorkspaceBusy(f.context.savedSnapshot.busy); },
    showActiveStreamInventoryUpdateFeedback(message) { f.context.feedback = message; },
  });
  vm.runInContext(registration("activeStreamInventoryUpdateForm", "submit"), f.context);
  const pending = f.context.activeStreamInventoryUpdateForm.dispatch("submit");
  assert.equal(imports, 1);
  assert.equal(f.context.activeStreamInventoryUpdateBusy, true);
  f.health("loading");
  finish({ addedSkus: ["SYNTHETIC"] });
  await pending;
  assert.equal(refreshes, 1);
  assert.match(f.context.feedback, /Added 1 new SKU/);
  assert.equal(f.context.activeStreamInventoryUpdateBusy, false);
  assert.equal(f.context.activeStreamInventoryUpdateOpen, false);
  assert.ok(f.sections.every((section) => section.inert));
});

test("End Tracking opens and cancels confirmation during capture loading but retains its session-busy guard", async () => {
  const f = fixture();
  f.health("loading");
  const end = node(), cancel = node();
  Object.assign(f.context, {
    endStreamButton: end, cancelEndStreamButton: cancel, endReportReadiness: {}, mappingAnnouncement: {},
    describeReportReadiness: () => "Synthetic report ready",
    streamSessionController: { getSnapshot: () => f.context.streamSnapshot },
    renderStreamSnapshot() { f.context.setWorkspaceBusy(f.context.savedSnapshot.busy); },
  });
  vm.runInContext(registration("endStreamButton", "click") + registration("cancelEndStreamButton", "click"), f.context);
  assert.equal(f.context.isTrackerInteractionTarget(end), false);
  assert.equal(f.context.isTrackerInteractionTarget(cancel), false);
  await end.dispatch("click");
  assert.equal(f.context.endConfirmationOpen, true);
  assert.equal(cancel.focused, true);
  await cancel.dispatch("click");
  assert.equal(f.context.endConfirmationOpen, false);
  assert.equal(end.focused, true);
  assert.ok(f.sections.every((section) => section.inert), "Cancel does not lift the capture-loading lock");
  f.context.streamSnapshot.busy = true;
  await end.dispatch("click");
  assert.equal(f.context.endConfirmationOpen, false);
  assert.match(f.context.mappingAnnouncement.textContent, /Wait for the current tracker stream change/);
  assert.match(html, /id="end-stream"/);
});

test("End Tracking confirmation can still execute during Connecting/Loading and refuses duplicate session-busy requests", async () => {
  for (const phase of ["connecting", "loading"]) {
    const f = fixture();
    let ends = 0;
    Object.assign(f.context, {
      confirmEndStreamButton: node(), streamSessionEndConfirmation: node(), streamSessionStatus: node(),
      mappingAnnouncement: {},
      streamSessionController: { async endActiveStream() { ends++; return { phase: "error" }; } },
    });
    vm.runInContext(registration("confirmEndStreamButton", "click"), f.context);
    f.health(phase);
    assert.equal(f.context.isTrackerInteractionTarget(f.context.confirmEndStreamButton), false);
    await f.context.confirmEndStreamButton.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ends, 1);
    assert.equal(f.context.streamSessionEndConfirmation.hidden, true);
    f.context.streamSnapshot.busy = true;
    await f.context.confirmEndStreamButton.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ends, 1, "Existing session-busy guard still prevents a second end request");
  }
});
