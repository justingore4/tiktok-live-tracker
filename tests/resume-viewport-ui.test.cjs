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
function fixture({ kind = "empty", phase = "active", ready = false } = {}) {
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
    capturePlanningCycleGeneration: 0,
    isCapturePlanningTarget: () => false,
    isCapturePlanningEnabled: () => false,
    syncCapturePlanningScope: () => false,
    isFuturePresetContextCurrent: () => false,
    pendingResumeViewport: null, persistentController: null, mountedStreamId: null,
    focusSavedWorkspaceAfterRetry: false, previousSavedPhase: "idle",
    savedSnapshot: { phase: "idle", busy: false, operation: null, view: null },
    streamSnapshot: { phase: "ready", busy: false, resumed: false, activeSession: clone(SESSION) },
    archivedReportsViewOpen: false, endConfirmationOpen: false,
    lastRenderedSavedVariations: new Map(), pendingSavedAction: null,
    hasFocusedSavedError: false, captureRefreshFocusSku: null,
    captureRefreshHadVariationFocus: false, captureRefreshDirty: false,
    variationPresetsBusy: false, activeStreamInventoryUpdateBusy: false,
    selectedPresetVariationNumber: kind === "preset" ? 2 : null,
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
    announceSavedAction() { assert.fail("Resume must not complete a mapping or payment mutation"); },
    renderAll() {
      events.push(["render"]);
      return context.getActiveView();
    },
    window: {
      scrollY: 900,
      scrollTo(options) {
        assert.equal(context.pendingResumeViewport, null, "Consume before focus/scroll can reenter");
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
    "mappingAnnouncement", "resumeStreamButton", "endStreamButton", "confirmEndStreamButton",
    "cancelEndStreamButton", "endReportReadiness", "pendingMapping", "activeStreamInventorySheetReference",
    "archivedReportsView", "backToBusinessRecordsButton",
    "addActiveStreamSkusButton", "activeStreamInventoryUpdateForm", "inventoryGrid",
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
  let resumeCalls = 0;
  context.streamSessionController = {
    resumeActiveStream() {
      resumeCalls += 1;
      context.streamSnapshot = { ...context.streamSnapshot, resumed: true };
      context.mountedStreamId = SESSION.streamId;
      context.persistentController = {};
      if (ready) {
        context.savedSnapshot = { phase: "ready", busy: false, operation: "load", view };
        context.setTrackerWorkspaceVisible(true);
        context.setWorkspaceBusy(false);
        context.renderAll();
      }
      return context.streamSnapshot;
    },
    getSnapshot() { return context.streamSnapshot; },
  };
  vm.createContext(context);
  vm.runInContext([
    "restoreResumeViewport", "renderSavedSnapshot", "getRecordedVariations", "hasSelectedRecordedVariation",
    "createSavedVariationSignatures", "getActiveView", "setTrackerWorkspaceVisible", "setWorkspaceBusy",
    "syncCaptureInteractionLock", "syncCaptureInventoryLock", "snapshotIsBackgroundRefresh", "isCaptureInteractionLocked",
    "isTrackerInteractionTarget", "openArchivedReportsDashboard",
  ].map(declaration).join("\n"), context);
  vm.runInContext(registration("resumeStreamButton"), context);
  vm.runInContext(registration("endStreamButton"), context);
  return {
    context, view, events, handlers,
    resume() { context.resumeStreamButton.dispatch("click"); },
    resumeCalls() { return resumeCalls; },
    render(overrides = {}) {
      context.renderSavedSnapshot({ phase: "ready", busy: false, operation: "load", view, ...overrides });
    },
    scrollEvents() { return events.filter(([type]) => type === "scroll"); },
  };
}

test("Resume uses a separately scoped one-shot token and a labeled non-tab-stop workspace target", () => {
  const markup = html.match(/<div\s+id="tracker-workspace"[^>]*>/)?.[0];
  assert.ok(markup);
  assert.match(markup, /role="region"/);
  assert.match(markup, /aria-label="Live tracker"/);
  assert.match(markup, /tabindex="-1"/);
  const handler = registration("resumeStreamButton");
  assert.match(handler, /focusSavedWorkspaceAfterRetry = false/);
  assert.doesNotMatch(handler, /streamSessionStatus\.focus/);
  assert.ok(handler.indexOf("resumeActiveStream()") < handler.indexOf("pendingResumeViewport = {"));
  assert.match(declaration("restoreResumeViewport"), /focus\(\{ preventScroll: true \}\)/);
});

test("empty, recorded and preset Resume renders restore the top once in every retained capture phase", () => {
  for (const kind of ["empty", "recorded", "preset"]) {
    for (const phase of ["connecting", "loading", "active", "blank"]) {
      const f = fixture({ kind, phase });
      f.context.focusSavedWorkspaceAfterRetry = true;
      f.resume();
      assert.equal(f.context.focusSavedWorkspaceAfterRetry, false);
      assert.equal(f.scrollEvents().length, 0);
      assert.equal(f.context.pendingResumeViewport.controller, f.context.persistentController);
      f.render();
      assert.equal(f.context.pendingResumeViewport, null, `${kind}/${phase}`);
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
  assert.equal(f.context.pendingResumeViewport, null);
  f.render();
  assert.equal(f.scrollEvents().length, 1);
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
  f.context.restoreResumeViewport();
  assert.equal(f.context.window.scrollY, 640);
  assert.equal(f.scrollEvents().length, 1);
  assert.equal(f.events.filter(([type]) => type === "focus").length, 1);
});

test("load and refresh errors cancel Resume restoration and retain the existing error focus", () => {
  for (const scope of ["load", "refresh"]) {
    const f = fixture();
    f.resume();
    f.render({ phase: "error", view: scope === "load" ? null : f.view,
      error: { scope, message: "Synthetic read failure" } });
    assert.equal(f.context.pendingResumeViewport, null);
    assert.equal(f.context.document.activeElement, f.context.savedSessionError);
    assert.equal(f.scrollEvents().length, 0);
    assert.equal(f.context.trackerWorkspace.hasAttribute("inert"), true);
    f.context.window.scrollY = 420;
    f.render();
    assert.equal(f.context.window.scrollY, 420, "A later recovery does not revive a failed Resume request");
    assert.equal(f.scrollEvents().length, 0);
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
    const token = f.context.pendingResumeViewport;
    restrict(f.context);
    f.context.restoreResumeViewport();
    assert.equal(f.context.pendingResumeViewport, token);
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
    f.context.restoreResumeViewport();
    assert.equal(f.context.pendingResumeViewport, null);
    assert.equal(f.scrollEvents().length, 0);
  }
});

test("actual End and archive actions clear pending restoration without consuming their own focus behavior", () => {
  const f = fixture();
  f.resume();
  f.context.endStreamButton.dispatch("click");
  assert.equal(f.context.pendingResumeViewport, null);
  assert.equal(f.context.endConfirmationOpen, true);
  assert.equal(f.context.document.activeElement, f.context.cancelEndStreamButton);
  f.context.endConfirmationOpen = false;
  f.render();
  assert.equal(f.scrollEvents().length, 0);

  const g = fixture();
  g.resume();
  g.context.streamSnapshot.activeSession = null;
  g.context.openArchivedReportsDashboard();
  assert.equal(g.context.pendingResumeViewport, null);
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
    assert.equal(f.context.pendingResumeViewport, null);
    assert.equal(f.scrollEvents().length, 0);
  }
  const f = fixture();
  f.context.streamSessionController.resumeActiveStream = () => { throw new Error("Synthetic Resume rejection"); };
  f.resume();
  assert.equal(f.context.pendingResumeViewport, null);
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic Resume rejection/);
  const g = fixture();
  g.resume(); g.resume(); g.render(); g.resume(); g.render();
  assert.equal(g.resumeCalls(), 1);
  assert.equal(g.scrollEvents().length, 1);
});

test("unmount and page disposal clear the request, and Start/Retry do not schedule this Resume-only behavior", () => {
  const f = fixture(); f.resume();
  Object.assign(f.context, {
    inventoryGroupOrderController: { reset() {} }, unsubscribePersistentController: null,
    createEmptySavedSnapshot: () => ({ phase: "idle", view: null, busy: false }),
  });
  for (const name of ["clearCaptureRefreshTimer", "resetLiveBidTracking", "resetNextItemQueueDisplay",
    "resetVariationPresetsDisplay", "resetInventorySizeMenu", "resetVariationSelector",
    "clearActiveStreamInventoryUpdateError", "clearActiveStreamInventoryUpdateFeedback"]) f.context[name] = () => {};
  vm.runInContext(declaration("unmountPersistentController"), f.context);
  f.context.unmountPersistentController();
  assert.equal(f.context.pendingResumeViewport, null);
  assert.equal(f.context.persistentController, null);
  assert.equal(f.scrollEvents().length, 0);

  const g = fixture(); g.resume();
  Object.assign(g.context, {
    reportLibraryDisposed: false, streamReportsRefreshGeneration: 0,
    captureHealthController: { dispose() {} }, clearCaptureRefreshTimer() {}, resetLiveBidTracking() {},
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
  assert.equal(g.context.pendingResumeViewport, null);
  assert.equal(g.context.reportLibraryDisposed, true);
  assert.equal(g.scrollEvents().length, 0);
  for (const target of ["startStreamButton", "retrySavedSessionButton", "retryStreamSessionButton"]) {
    assert.doesNotMatch(registration(target), /pendingResumeViewport\s*=\s*\{/);
  }
  assert.match(registration("startStreamButton"), /focusSavedWorkspaceAfterRetry = true/);
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
  assert.ok(f.context.pendingResumeViewport);
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
