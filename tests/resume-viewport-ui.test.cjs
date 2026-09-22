const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const streamControllers = require("../extension/tagger/stream-session-controller.js");
const persistentControllers = require("../extension/tagger/persistent-tagger-controller.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const variationPresetsView = require("../extension/tagger/variation-presets-view.js");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const SESSION = {
  streamId: "local-stream:11111111-1111-4111-8111-111111111111",
  startedAt: "2026-09-15T18:00:00.000Z", identitySource: "local_session",
};

function declaration(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}

function registration(target) {
  // The saved-session retry also has an early initialization-error fallback;
  // exercise the normal controller-backed registration at the end of the UI.
  const start = source.lastIndexOf(`  ${target}.addEventListener(`);
  assert.ok(start >= 0, target);
  return source.slice(start, source.indexOf("\n  });", start) + 6);
}

function syntheticView(kind = "empty") {
  return {
    streamId: SESSION.streamId, inventory: [],
    currentVariationNumber: kind === "recorded" ? 10 : null,
    selectedVariationNumber: kind === "recorded" ? 10 : null,
    variations: kind === "recorded" ? [{ variationNumber: 10, recorded: true, selected: true }] : [],
  };
}

// Only model focus eligibility and requested scroll coordinates. This does not
// claim a native browser layout/scrolling or real extension-profile test.
function fixture({ kind = "empty", phase = "active", ready = false, entry = "resume" } = {}) {
  const events = [];
  const document = { activeElement: null };
  const handlers = new Map();
  function element(name) {
    const attributes = new Map();
    const listeners = new Map();
    return {
      name, children: [], parent: null, hidden: false, disabled: false, textContent: "", value: "", dataset: {},
      classList: { contains: (value) => name === "captureHealthRow" && value === "capture-health-row" },
      contains(target) { return target === this || this.children.some((child) => child.contains(target)); },
      hasAttribute(key) { return attributes.has(key); },
      setAttribute(key, value) { attributes.set(key, String(value)); },
      removeAttribute(key) { attributes.delete(key); },
      toggleAttribute(key, enabled) { if (enabled) attributes.set(key, ""); else attributes.delete(key); },
      focus(options) {
        for (let node = this; node; node = node.parent) {
          if (node.hidden || node.hasAttribute("inert")) {
            events.push(["focus-blocked", name]);
            return;
          }
        }
        document.activeElement = this;
        events.push(["focus", name, options ? clone(options) : null]);
      },
      blur() { if (document.activeElement === this) document.activeElement = null; },
      setCustomValidity() {},
      scrollIntoView(options) { events.push(["scrollIntoView", name, clone(options)]); },
      addEventListener(type, handler) { listeners.set(type, handler); },
      dispatch(type) { return listeners.get(type)?.({ type, target: this }); },
    };
  }
  const view = syntheticView(kind);
  const context = {
    document, variationPresetsView, console,
    capturePlanningCycleGeneration: 0, variationNavigationGeneration: 0,
    captureStateNotificationGeneration: 0, pendingPresetResumeSelection: null,
    variationPresetsGeneration: 0, variationPresetsEditing: false,
    variationPresetsReady: kind === "preset",
    isCapturePlanningTarget: () => false,
    isCapturePlanningEnabled: () => false,
    syncCapturePlanningScope: () => false,
    captureConnectingPlanning: null, capturePlanningDisposed: false,
    resetConnectingPlanningDelay() {},
    isFuturePresetContextCurrent: () => false,
    pendingTrackerEntryViewport: null, persistentController: null, mountedStreamId: null,
    focusSavedWorkspaceAfterRetry: false, previousSavedPhase: "idle",
    savedSnapshot: { phase: "idle", busy: false, operation: null, view: null },
    streamSnapshot: { phase: "ready", busy: false, resumed: false, activeSession: entry === "start" ? null : clone(SESSION) },
    archivedReportsViewOpen: false, endConfirmationOpen: false,
    lastRenderedSavedVariations: new Map(), pendingSavedAction: null,
    hasFocusedSavedError: false, captureRefreshFocusSku: null,
    captureRefreshHadVariationFocus: false, captureRefreshDirty: false,
    variationPresetsBusy: false, activeStreamInventoryUpdateBusy: false,
    selectedPresetVariationNumber: kind === "preset" ? 2 : null,
    queuedNextItemSnapshot: null, selectedQueuedVariationNumber: null,
    variationPresetsSnapshot: kind === "preset" ? {
      streamId: SESSION.streamId, baselineId: "synthetic-baseline", revision: "r1", total: 5, assignments: [],
    } : null,
    inventorySizeMenuState: null, variationSelectorOpen: false,
    variationSelectorLock: { isLocked: () => false },
    getFocusedInventorySku: () => null,
    updateSessionControls() {}, updateFooterVisibility() {},
    updateVariationSearchAvailability() {}, updateQueuedItemBadgeAvailability() {},
    updateVariationPresetsAvailability() {}, updateVariationStepAvailability() {},
    getSavedStatusText: () => "Ready", setFooterStatus() {},
    scheduleVariationPresetsRefresh() {}, describeLiveRefresh: () => "", armCaptureRefresh() {},
    describeReportReadiness: () => "Synthetic readiness",
    renderStreamSnapshot() {}, renderStreamReportsPanel() {},
    preserveCapturedPresetSelection: () => false,
    announceSavedAction() { assert.fail("Entering the tracker must not complete a mapping or payment mutation"); },
    isInventoryReadyForStart: () => true,
    renderAll() {
      events.push(["render"]);
      return context.getActiveView();
    },
    window: {
      scrollY: 900,
      scrollTo(options) {
        assert.equal(context.pendingTrackerEntryViewport, null, "Consume before focus/scroll can reenter");
        this.scrollY = options.top;
        events.push(["scroll", clone(options)]);
      },
      addEventListener(type, handler) { handlers.set(type, handler); },
    },
  };
  for (const name of [
    "trackerWorkspace", "captureHealthRow", "captureHealthBadge", "variationSection", "variationSelector",
    "variationListbox", "inventorySizeListbox", "retrySavedSessionButton", "retryStreamSessionButton",
    "savedSessionError", "savedSessionErrorTitle", "savedSessionErrorMessage", "streamSessionStatus",
    "mappingAnnouncement", "startStreamButton", "resumeStreamButton", "endStreamButton", "confirmEndStreamButton",
    "cancelEndStreamButton", "endReportReadiness", "pendingMapping", "activeStreamInventorySheetReference",
    "archivedReportsView", "backToBusinessRecordsButton",
    "addActiveStreamSkusButton", "activeStreamInventoryUpdateForm", "inventoryGrid",
    "inventoryImportPanel", "inventorySheetReference",
  ]) context[name] = element(name);
  context.inventoryGrid.querySelectorAll = () => [];
  context.trackerWorkspace.children = [context.captureHealthRow, context.variationSection];
  context.captureHealthRow.parent = context.trackerWorkspace;
  context.variationSection.parent = context.trackerWorkspace;
  context.variationSection.children = [context.variationSelector];
  context.variationSelector.parent = context.variationSection;
  context.captureHealthBadge.dataset.phase = phase;
  context.trackerWorkspace.hidden = true;
  context.trackerWorkspace.toggleAttribute("inert", true);
  let resumeCalls = 0, startCalls = 0;
  function activateTracker() {
    context.streamSnapshot = { ...context.streamSnapshot, resumed: true, activeSession: clone(SESSION) };
    context.mountedStreamId = SESSION.streamId;
    context.persistentController = {};
    if (ready) context.renderSavedSnapshot({ phase: "ready", busy: false, operation: "load", view });
    return context.streamSnapshot;
  }
  context.streamSessionController = {
    resumeActiveStream() {
      resumeCalls += 1;
      return activateTracker();
    },
    async startNewStream() { startCalls++; return activateTracker(); },
    getSnapshot() { return context.streamSnapshot; },
  };
  vm.createContext(context);
  vm.runInContext([
    "restoreTrackerEntryViewport", "renderSavedSnapshot", "getRecordedVariations", "hasSelectedRecordedVariation",
    "restoreResumedPresetSelection", "findVariationOption", "reconcileQueuedPreviewSelection",
    "createSavedVariationSignatures", "getActiveView", "setTrackerWorkspaceVisible", "setWorkspaceBusy",
    "syncCaptureInteractionLock", "syncCaptureInventoryLock", "snapshotIsBackgroundRefresh", "isCaptureInteractionLocked",
    "isTrackerInteractionTarget", "openArchivedReportsDashboard",
  ].map(declaration).join("\n"), context);
  vm.runInContext(registration("resumeStreamButton"), context);
  vm.runInContext(registration("startStreamButton"), context);
  vm.runInContext(registration("endStreamButton"), context);
  return {
    context, view, events, handlers,
    resume() { context.resumeStreamButton.dispatch("click"); },
    async start() { context.startStreamButton.dispatch("click"); await settle(); },
    resumeCalls() { return resumeCalls; },
    startCalls() { return startCalls; },
    render(overrides = {}) {
      context.renderSavedSnapshot({ phase: "ready", busy: false, operation: "load", view, ...overrides });
    },
    scrollEvents() { return events.filter(([type]) => type === "scroll"); },
  };
}

test("Start and Resume share a visibility-scoped one-shot token and a labeled non-tab-stop workspace target", () => {
  const markup = html.match(/<div\s+id="tracker-workspace"[^>]*>/)?.[0];
  assert.ok(markup);
  assert.match(markup, /role="region"/);
  assert.match(markup, /aria-label="Live tracker"/);
  assert.match(markup, /tabindex="-1"/);
  for (const target of ["startStreamButton", "resumeStreamButton"]) {
    const handler = registration(target);
    assert.match(handler, /focusSavedWorkspaceAfterRetry = false/);
    assert.doesNotMatch(handler, /streamSessionStatus\.focus|pendingTrackerEntryViewport\s*=\s*\{/);
  }
  assert.match(declaration("setTrackerWorkspaceVisible"), /pendingTrackerEntryViewport = \{/);
  assert.match(declaration("restoreTrackerEntryViewport"), /focus\(\{ preventScroll: true \}\)/);
});

test("empty, recorded and preset Resume renders restore the top once in every retained capture phase", () => {
  for (const kind of ["empty", "recorded", "preset"]) {
    for (const phase of ["connecting", "loading", "active", "blank"]) {
      const f = fixture({ kind, phase });
      f.context.focusSavedWorkspaceAfterRetry = true;
      f.resume();
      assert.equal(f.context.focusSavedWorkspaceAfterRetry, false);
      assert.equal(f.scrollEvents().length, 0);
      assert.equal(f.context.pendingTrackerEntryViewport, null, "Wait for the tracker to actually become visible");
      f.render();
      assert.equal(f.context.pendingTrackerEntryViewport, null, `${kind}/${phase}`);
      assert.equal(f.context.window.scrollY, 0, `${kind}/${phase}`);
      assert.deepEqual(f.scrollEvents(), [["scroll", { top: 0, left: 0, behavior: "instant" }]]);
      assert.equal(f.context.document.activeElement, f.context.trackerWorkspace);
      assert.deepEqual(f.events.filter(([type]) => type === "focus"), [
        ["focus", "trackerWorkspace", { preventScroll: true }],
      ]);
      assert.ok(f.events.findIndex(([type]) => type === "render") < f.events.findIndex(([type]) => type === "scroll"));
      const locked = ["connecting", "loading"].includes(phase);
      assert.equal(f.context.variationSection.hasAttribute("inert"), locked);
      assert.equal(f.context.variationListbox.hasAttribute("inert"), locked);
      assert.equal(f.context.captureHealthBadge.dataset.phase, phase);
      assert.equal(f.context.trackerWorkspace.hasAttribute("inert"), false);
    }
  }
});

test("Resume handles an already-ready synchronous restored layout without waiting for another render", () => {
  const f = fixture({ ready: true });
  f.resume();
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  f.render();
  assert.equal(f.scrollEvents().length, 1);
});

test("offline Resume restores saved preset #1 without a second viewport reset or extra focus when its read completes late", async () => {
  for (const phase of ["connecting", "loading", "blank", "active"]) {
    const f = fixture({ phase }), c = f.context;
    f.resume(); f.render();
    assert.equal(f.scrollEvents().length, 1);
    assert.ok(c.pendingPresetResumeSelection);
    c.window.scrollY = 460;
    const focused = c.document.activeElement;
    c.variationPresetsSnapshot = {
      streamId: SESSION.streamId, baselineId: "synthetic-baseline", revision: "saved", total: 200,
      assignments: [{ variationNumber: 1, sku: "SYNTHETIC-A" }],
    };
    c.variationPresetsReady = true;
    let verificationReads = 0;
    c.persistentController.refresh = async () => {
      verificationReads++;
      f.render({ phase: "loading", busy: true, operation: "refresh" });
      f.render({ operation: "refresh" });
      return c.savedSnapshot;
    };
    f.render({ operation: null });
    await settle();
    assert.equal(c.selectedPresetVariationNumber, 1);
    assert.equal(c.pendingPresetResumeSelection, null);
    assert.equal(c.window.scrollY, 460);
    assert.equal(f.scrollEvents().length, 1);
    assert.ok(c.document.activeElement === focused || c.document.activeElement === null,
      "Existing loading safeguards may blur the workspace; restoration must not move focus to another control");
    assert.equal(f.events.filter(([type]) => type === "focus").length, 1);
    assert.equal(verificationReads, 1);
    assert.equal(c.captureHealthBadge.dataset.phase, phase);
    assert.equal(c.variationSection.hasAttribute("inert"), ["connecting", "loading"].includes(phase));
    f.render();
    assert.equal(c.window.scrollY, 460);
    assert.equal(f.scrollEvents().length, 1);
  }
});

test("Start opens empty, captured and preset tracker layouts at the top once, including initial capture locks", async () => {
  for (const kind of ["empty", "recorded", "preset"]) {
    for (const phase of ["connecting", "loading", "active", "blank"]) {
      for (const ready of [false, true]) {
        const f = fixture({ kind, phase, ready, entry: "start" });
        f.context.focusSavedWorkspaceAfterRetry = true;
        await f.start();
        assert.equal(f.startCalls(), 1);
        assert.equal(f.context.focusSavedWorkspaceAfterRetry, false);
        if (!ready) {
          assert.equal(f.scrollEvents().length, 0);
          assert.equal(f.context.pendingTrackerEntryViewport, null);
          f.render({ phase: "loading", busy: true });
          assert.equal(f.context.pendingTrackerEntryViewport.controller, f.context.persistentController);
          assert.equal(f.scrollEvents().length, 0);
          f.render();
        }
        assert.deepEqual(f.scrollEvents(), [["scroll", { top: 0, left: 0, behavior: "instant" }]]);
        assert.equal(f.context.pendingTrackerEntryViewport, null);
        assert.equal(f.context.document.activeElement, f.context.trackerWorkspace);
        assert.equal(f.events.some(event => event[0] === "focus" && event[1] === "streamSessionStatus"), false);
        assert.equal(f.context.variationSection.hasAttribute("inert"), ["connecting", "loading"].includes(phase));
        assert.equal(f.context.captureHealthBadge.dataset.phase, phase);
        f.context.window.scrollY = 620;
        f.render({ operation: "refresh" }); f.render();
        assert.equal(f.context.window.scrollY, 620);
        assert.equal(f.scrollEvents().length, 1);
      }
    }
  }
});

test("Start blocked by inventory or rejected before tracker visibility cannot scroll or steal its error focus", async () => {
  const missing = fixture({ entry: "start" });
  missing.context.isInventoryReadyForStart = () => false;
  await missing.start();
  assert.equal(missing.startCalls(), 0);
  assert.equal(missing.context.pendingTrackerEntryViewport, null);
  assert.equal(missing.context.document.activeElement, missing.context.inventorySheetReference);
  assert.equal(missing.scrollEvents().length, 0);
  assert.equal(missing.context.window.scrollY, 900);
  for (const reject of [true, false]) {
    const f = fixture({ entry: "start" });
    f.context.console = { error() {} };
    f.context.streamSessionController.startNewStream = async () => {
      f.context.savedSessionError.focus();
      if (reject) throw new Error("Synthetic Start failure");
      return { phase: "error", resumed: false, activeSession: null };
    };
    await f.start();
    assert.equal(f.context.pendingTrackerEntryViewport, null);
    assert.equal(f.context.document.activeElement, f.context.savedSessionError);
    assert.equal(f.context.window.scrollY, 900);
    assert.equal(f.scrollEvents().length, 0);
  }
});

test("successful Retry loading after Start opens the hidden tracker once; visible refresh retry does not rearm", async () => {
  for (const scope of ["load", "refresh"]) {
    const f = fixture({ entry: "start", kind: "recorded" });
    await f.start();
    if (scope === "refresh") f.render();
    f.render({ phase: "error", view: scope === "load" ? null : f.view,
      error: { scope, message: "Synthetic canonical failure" } });
    const priorScrolls = f.scrollEvents().length;
    f.context.window.scrollY = 470;
    f.context.persistentController.retry = async () => {
      f.render({ phase: "loading", busy: true, operation: scope, view: scope === "load" ? null : f.view });
      f.render({ operation: scope });
      return f.context.savedSnapshot;
    };
    vm.runInContext(declaration("guardCaptureInteraction") + "\n" + registration("retrySavedSessionButton"), f.context);
    f.context.retrySavedSessionButton.dispatch("click"); await settle();
    assert.equal(f.scrollEvents().length, priorScrolls + (scope === "load" ? 1 : 0));
    assert.equal(f.context.window.scrollY, scope === "load" ? 0 : 470);
    assert.equal(f.context.document.activeElement, scope === "load" ? f.context.trackerWorkspace : f.context.variationSelector);
    assert.equal(f.context.pendingTrackerEntryViewport, null);
  }
});

test("late successful Start acknowledgement cannot repeat an already-completed entry reset", async () => {
  const f = fixture({ entry: "start" });
  let resolve;
  const acknowledgement = new Promise(done => { resolve = done; });
  f.context.streamSessionController.startNewStream = async () => {
    f.context.streamSessionController.resumeActiveStream();
    f.render();
    await acknowledgement;
    return f.context.streamSnapshot;
  };
  f.context.startStreamButton.dispatch("click"); await settle();
  assert.equal(f.scrollEvents().length, 1);
  f.context.window.scrollY = 650;
  resolve(); await settle();
  assert.equal(f.context.window.scrollY, 650);
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.context.pendingTrackerEntryViewport, null);
});

test("every genuine hidden-to-visible tracker entry rearms once; repeated visible updates and invalid entries do not", () => {
  const f = fixture(); f.resume(); f.render();
  assert.equal(f.scrollEvents().length, 1);
  f.context.window.scrollY = 810;
  f.context.setTrackerWorkspaceVisible(false);
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  f.context.setTrackerWorkspaceVisible(true);
  assert.ok(f.context.pendingTrackerEntryViewport);
  assert.equal(f.scrollEvents().length, 1, "Visibility alone must wait for the rendered ready layout");
  f.render();
  assert.equal(f.scrollEvents().length, 2);
  f.context.window.scrollY = 520;
  for (let index = 0; index < 3; index++) {
    f.context.setTrackerWorkspaceVisible(true); f.render();
  }
  assert.equal(f.scrollEvents().length, 2);
  assert.equal(f.context.window.scrollY, 520);
  for (const invalidate of [
    c => { c.streamSnapshot.resumed = false; },
    c => { c.streamSnapshot.activeSession = null; },
    c => { c.persistentController = null; },
    c => { c.mountedStreamId = "other"; },
    c => { c.savedSnapshot.view.streamId = "other"; },
    c => { c.savedSnapshot.phase = "error"; },
    c => { c.endConfirmationOpen = true; },
    c => { c.archivedReportsViewOpen = true; },
  ]) {
    const g = fixture(); g.resume();
    g.context.savedSnapshot = { phase: "ready", busy: false, view: g.view };
    invalidate(g.context);
    g.context.setTrackerWorkspaceVisible(true);
    g.context.restoreTrackerEntryViewport();
    assert.equal(g.context.pendingTrackerEntryViewport, null);
    assert.equal(g.scrollEvents().length, 0);
  }
});

test("hiding an unfinished entry clears its token and a later stream receives only its own viewport reset", () => {
  const f = fixture(); f.resume(); f.render({ phase: "loading", busy: true });
  const first = f.context.pendingTrackerEntryViewport;
  assert.ok(first);
  f.context.setTrackerWorkspaceVisible(false);
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  const secondId = "local-stream:22222222-2222-4222-8222-222222222222";
  f.context.mountedStreamId = secondId;
  f.context.streamSnapshot.activeSession = { ...SESSION, streamId: secondId };
  f.context.persistentController = {};
  const view = { ...f.view, streamId: secondId };
  f.context.savedSnapshot = { phase: "loading", busy: true, operation: "load", view };
  f.context.setTrackerWorkspaceVisible(true);
  const second = f.context.pendingTrackerEntryViewport;
  assert.notEqual(second, first);
  assert.equal(second.streamId, secondId);
  f.render({ view });
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  f.context.window.scrollY = 330;
  f.context.restoreTrackerEntryViewport();
  assert.equal(f.context.window.scrollY, 330);
});

test("later manual scrolling survives ordinary renders, incoming refreshes and readiness changes", () => {
  const f = fixture({ phase: "loading" });
  f.resume(); f.render();
  f.context.window.scrollY = 640;
  f.context.captureHealthBadge.dataset.phase = "active";
  f.context.setWorkspaceBusy(false);
  f.render({ phase: "loading", busy: true, operation: "refresh" });
  f.render({ operation: "refresh" });
  f.render();
  f.context.restoreTrackerEntryViewport();
  assert.equal(f.context.window.scrollY, 640);
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.events.filter(([type]) => type === "focus").length, 1);
});

test("load and refresh errors keep error focus; only a later hidden-to-visible recovery gets a new entry reset", () => {
  for (const scope of ["load", "refresh"]) {
    const f = fixture();
    f.resume();
    f.render({ phase: "error", view: scope === "load" ? null : f.view,
      error: { scope, message: "Synthetic read failure" } });
    assert.equal(f.context.pendingTrackerEntryViewport, null);
    assert.equal(f.context.document.activeElement, f.context.savedSessionError);
    assert.equal(f.scrollEvents().length, 0);
    assert.equal(f.context.trackerWorkspace.hasAttribute("inert"), true);
    f.context.window.scrollY = 420;
    f.render();
    assert.equal(f.context.window.scrollY, scope === "load" ? 0 : 420);
    assert.equal(f.scrollEvents().length, scope === "load" ? 1 : 0,
      "Hidden load recovery is a fresh entry; an already-visible refresh recovery is not");
  }
});

test("waiting, busy, hidden and inert workspaces defer rather than scroll before a valid ready layout", () => {
  const restrictions = [
    (c) => { c.savedSnapshot.phase = "loading"; },
    (c) => { c.savedSnapshot.busy = true; },
    (c) => { c.streamSnapshot.busy = true; },
    (c) => { c.savedSnapshot.view = null; },
    (c) => { c.trackerWorkspace.hidden = true; },
    (c) => { c.trackerWorkspace.toggleAttribute("inert", true); },
  ];
  for (const restrict of restrictions) {
    const f = fixture();
    f.resume();
    f.context.savedSnapshot = { phase: "ready", busy: false, view: f.view };
    f.context.setTrackerWorkspaceVisible(true);
    f.context.setWorkspaceBusy(false);
    const token = f.context.pendingTrackerEntryViewport;
    restrict(f.context);
    f.context.restoreTrackerEntryViewport();
    assert.equal(f.context.pendingTrackerEntryViewport, token);
    assert.equal(f.scrollEvents().length, 0);
  }
});

test("stream/controller mismatches, ended sessions, errors, End confirmation and archive navigation cancel stale requests", () => {
  const restrictions = [
    (c) => { c.persistentController = {}; },
    (c) => { c.mountedStreamId = "other-stream"; },
    (c) => { c.streamSnapshot.activeSession = { streamId: "other-stream" }; },
    (c) => { c.streamSnapshot.activeSession = null; },
    (c) => { c.streamSnapshot.resumed = false; },
    (c) => { c.streamSnapshot.phase = "error"; },
    (c) => { c.savedSnapshot.phase = "error"; },
    (c) => { c.savedSnapshot.view = { ...c.savedSnapshot.view, streamId: "other-stream" }; },
    (c) => { c.endConfirmationOpen = true; },
    (c) => { c.archivedReportsViewOpen = true; },
  ];
  for (const restrict of restrictions) {
    const f = fixture();
    f.resume();
    f.context.savedSnapshot = { phase: "ready", busy: false, view: f.view };
    f.context.setTrackerWorkspaceVisible(true);
    f.context.setWorkspaceBusy(false);
    restrict(f.context);
    f.context.restoreTrackerEntryViewport();
    assert.equal(f.context.pendingTrackerEntryViewport, null);
    assert.equal(f.scrollEvents().length, 0);
  }
});

test("actual End and archive actions clear pending restoration without consuming their own focus behavior", () => {
  const f = fixture();
  f.resume();
  f.render({ phase: "loading", busy: true });
  f.context.endStreamButton.dispatch("click");
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  assert.equal(f.context.pendingPresetResumeSelection, null);
  assert.equal(f.context.endConfirmationOpen, true);
  assert.equal(f.context.document.activeElement, f.context.cancelEndStreamButton);
  f.context.endConfirmationOpen = false;
  f.render();
  assert.equal(f.scrollEvents().length, 0);

  const g = fixture();
  g.resume();
  g.render({ phase: "loading", busy: true });
  g.context.streamSnapshot.activeSession = null;
  g.context.openArchivedReportsDashboard();
  assert.equal(g.context.pendingTrackerEntryViewport, null);
  assert.equal(g.context.pendingPresetResumeSelection, null);
  assert.equal(g.context.archivedReportsViewOpen, true);
  assert.equal(g.context.document.activeElement, g.context.backToBusinessRecordsButton);
  assert.equal(g.scrollEvents().length, 0);
});

test("rejected, failed and duplicate Resume clicks never schedule another viewport restoration", () => {
  for (const restrict of [
    (c) => { c.streamSnapshot.resumed = true; },
    (c) => { c.streamSnapshot.activeSession = null; },
    (c) => { c.streamSnapshot.busy = true; },
    (c) => { c.endConfirmationOpen = true; },
    (c) => { c.archivedReportsViewOpen = true; },
  ]) {
    const f = fixture(); restrict(f.context); f.resume();
    assert.equal(f.resumeCalls(), 0);
    assert.equal(f.context.pendingTrackerEntryViewport, null);
    assert.equal(f.scrollEvents().length, 0);
  }
  const f = fixture();
  f.context.streamSessionController.resumeActiveStream = () => { throw new Error("Synthetic Resume rejection"); };
  f.resume();
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic Resume rejection/);
  const g = fixture();
  g.resume(); g.resume(); g.render(); g.resume(); g.render();
  assert.equal(g.resumeCalls(), 1);
  assert.equal(g.scrollEvents().length, 1);
});

test("unmount and page disposal clear the request; buttons never duplicate the shared entry hook", () => {
  const f = fixture(); f.resume(); f.render({ phase: "loading", busy: true });
  Object.assign(f.context, {
    inventoryGroupOrderController: { reset() {} }, unsubscribePersistentController: null,
    createEmptySavedSnapshot: () => ({ phase: "idle", view: null, busy: false }),
  });
  for (const name of ["clearCaptureRefreshTimer", "resetLiveBidTracking", "resetNextItemQueueDisplay",
    "resetVariationPresetsDisplay", "resetInventorySizeMenu", "resetVariationSelector",
    "clearActiveStreamInventoryUpdateError", "clearActiveStreamInventoryUpdateFeedback"]) f.context[name] = () => {};
  vm.runInContext(declaration("unmountPersistentController"), f.context);
  f.context.unmountPersistentController();
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  assert.equal(f.context.persistentController, null);
  assert.equal(f.scrollEvents().length, 0);

  const g = fixture(); g.resume(); g.render({ phase: "loading", busy: true });
  Object.assign(g.context, {
    reportLibraryDisposed: false, streamReportsRefreshGeneration: 0,
    captureHealthController: { dispose() {} }, captureBadgeSizeObserver: { disconnect() {} },
    clearCaptureRefreshTimer() {}, resetLiveBidTracking() {},
    resetConfirmedInventoryPreview() {}, handleCaptureStateChanged() {}, handleReportLibraryChanged() {},
    chrome: { runtime: { onMessage: { removeListener() {} } } },
  });
  const start = source.indexOf('  window.addEventListener(\n    "pagehide"');
  // Normalize CRLF only for locating the multiline registration.
  const normalized = source.replace(/\r\n/g, "\n");
  const normalizedStart = normalized.indexOf('  window.addEventListener(\n    "pagehide"');
  assert.ok(start >= 0 || normalizedStart >= 0);
  vm.runInContext(normalized.slice(normalizedStart, normalized.indexOf("\n  );", normalizedStart) + 5), g.context);
  g.handlers.get("pagehide")();
  assert.equal(g.context.pendingTrackerEntryViewport, null);
  assert.equal(g.context.reportLibraryDisposed, true);
  assert.equal(g.scrollEvents().length, 0);
  for (const target of ["startStreamButton", "retrySavedSessionButton", "retryStreamSessionButton"]) {
    assert.doesNotMatch(registration(target), /pendingTrackerEntryViewport\s*=\s*\{/);
  }
  assert.match(registration("startStreamButton"), /focusSavedWorkspaceAfterRetry = false/);
  assert.match(registration("retrySavedSessionButton"), /focusSavedWorkspaceAfterRetry =/);
});

test("real session and persistent controllers restore synthetic data read-only before one viewport reset", async () => {
  const state = reconciliation.createReconciliationState([
    { sku: "SYNTHETIC-A", item: "Synthetic tee", style: "", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: SESSION.streamId });
  reconciliation.observeVariations(state, { streamId: SESSION.streamId, variationNumbers: [1, 10] });
  reconciliation.mapVariation(state, { streamId: SESSION.streamId, variationNumber: 10, sku: "SYNTHETIC-A" });
  const before = clone(state), calls = [];
  let resolveRead;
  const read = new Promise((resolve) => { resolveRead = resolve; });
  const sessionController = streamControllers.createStreamSessionController({ client: {
    async getSession() { calls.push("session read"); return { state: { version: 1, activeSession: clone(SESSION) }, result: null }; },
    async startStream() { assert.fail("Resume must not start another stream"); },
    async endStream() { assert.fail("Resume must not end the stream"); },
  } });
  const controller = persistentControllers.createPersistentTaggerController({
    streamId: SESSION.streamId, currentVariationNumber: 1, variationNumbers: [1], reconciliation, mappingWorkflow,
    client: {
      async getState() { calls.push("canonical read"); await read; return { state: clone(state), result: null }; },
      async initializeState() { assert.fail("Resume must not initialize inventory"); },
      async mapVariation() { assert.fail("Resume must not change mappings"); },
      async unmapVariation() { assert.fail("Resume must not remove mappings"); },
    },
  });
  const f = fixture({ phase: "loading" });
  f.context.streamSessionController = sessionController;
  await sessionController.start();
  let loading;
  sessionController.subscribe((snapshot) => {
    f.context.streamSnapshot = snapshot;
    if (snapshot.resumed && !f.context.persistentController) {
      f.context.mountedStreamId = snapshot.activeSession.streamId;
      f.context.persistentController = controller;
      controller.subscribe(f.context.renderSavedSnapshot);
      loading = controller.start();
    }
  });
  f.resume();
  assert.equal(f.context.pendingTrackerEntryViewport, null, "No entry exists before canonical data makes the tracker visible");
  assert.equal(f.scrollEvents().length, 0);
  resolveRead();
  await loading;
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.context.document.activeElement, f.context.trackerWorkspace);
  assert.equal(f.context.variationSection.hasAttribute("inert"), true);
  assert.equal(controller.getSnapshot().view.selectedVariationNumber, 10);
  assert.deepEqual(calls, ["session read", "canonical read"]);
  assert.deepEqual(state, before);
  f.context.window.scrollY = 450;
  await controller.refresh();
  assert.equal(f.context.window.scrollY, 450);
  assert.equal(f.scrollEvents().length, 1);
  assert.deepEqual(state, before);
});

test("real Start and persistent controllers open an empty synthetic stream once after local inventory loads", async () => {
  const state = reconciliation.createReconciliationState([
    { sku: "SYNTHETIC-A", item: "Synthetic tee", style: "", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId: SESSION.streamId });
  const before = clone(state), calls = [];
  let resolveRead;
  const read = new Promise(resolve => { resolveRead = resolve; });
  const sessionController = streamControllers.createStreamSessionController({ client: {
    async getSession() { calls.push("session read"); return { state: { version: 1, activeSession: null }, result: null }; },
    async startStream() {
      calls.push("session start");
      return { state: { version: 1, activeSession: clone(SESSION) }, result: { status: "started" } };
    },
    async endStream() { assert.fail("Entry scrolling must not end the stream"); },
  } });
  const controller = persistentControllers.createPersistentTaggerController({
    streamId: SESSION.streamId, currentVariationNumber: 1, variationNumbers: [1], reconciliation, mappingWorkflow,
    client: {
      async getState() { calls.push("canonical read"); await read; return { state: clone(state), result: null }; },
      async initializeState() { assert.fail("Entry scrolling must not initialize inventory"); },
      async mapVariation() { assert.fail("Entry scrolling must not map a variation"); },
      async unmapVariation() { assert.fail("Entry scrolling must not unmap a variation"); },
    },
  });
  const f = fixture({ phase: "connecting", entry: "start" });
  f.context.streamSessionController = sessionController;
  await sessionController.start();
  let loading;
  sessionController.subscribe(snapshot => {
    f.context.streamSnapshot = snapshot;
    if (snapshot.resumed && !f.context.persistentController) {
      f.context.mountedStreamId = snapshot.activeSession.streamId;
      f.context.persistentController = controller;
      controller.subscribe(f.context.renderSavedSnapshot);
      loading = controller.start();
    }
  });
  await f.start();
  assert.equal(f.context.pendingTrackerEntryViewport, null);
  assert.equal(f.scrollEvents().length, 0);
  resolveRead(); await loading;
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.context.document.activeElement, f.context.trackerWorkspace);
  assert.equal(f.context.variationSection.hasAttribute("inert"), true);
  assert.equal(controller.getSnapshot().view.variations.some(entry => entry.recorded), false);
  assert.deepEqual(calls, ["session read", "session start", "canonical read"]);
  assert.deepEqual(state, before);
  f.context.window.scrollY = 740;
  await controller.refresh();
  assert.equal(f.context.window.scrollY, 740);
  assert.equal(f.scrollEvents().length, 1);
  assert.deepEqual(state, before);
});
