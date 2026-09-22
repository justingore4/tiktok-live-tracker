const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const controllerModule = require("../extension/tagger/persistent-tagger-controller.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const reconciliation = require("../extension/shared/reconciliation.js");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");

// Exercise the actual side-panel handlers with synthetic elements only. The
// real-controller test below also checks the selection/accounting boundary.
function declaration(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing implementation function: ${name}`);
  const end = source.indexOf("\n  }", match.index);
  assert.ok(end > match.index);
  return source.slice(match.index, end + 4);
}

function registrations(target) {
  return [...source.matchAll(new RegExp(`^  ${target}\\.addEventListener\\(`, "gm"))].map((match) => {
    const lineEnd = source.indexOf("\n", match.index);
    if (source.slice(match.index, lineEnd).trimEnd().endsWith(";")) {
      return source.slice(match.index, lineEnd);
    }
    const end = source.indexOf("\n  });", match.index);
    assert.ok(end > match.index);
    return source.slice(match.index, end + 6);
  }).join("\n");
}

function element() {
  const attrs = new Map();
  const handlers = new Map();
  return {
    value: "", hidden: false, disabled: false, dataset: {}, textContent: "", children: [],
    contains(candidate) { return candidate === this; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    hasAttribute(name) { return attrs.has(name); },
    removeAttribute(name) { attrs.delete(name); },
    toggleAttribute(name, enabled) {
      if (enabled) attrs.set(name, ""); else attrs.delete(name);
    },
    focus() { this.focused = true; },
    blur() { this.blurred = true; },
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { this.validityReported = true; return !this.validationMessage; },
    addEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    dispatch(type, extra = {}) {
      const event = {
        type, target: this, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...extra,
      };
      for (const handler of handlers.get(type) ?? []) handler(event);
      return event;
    },
  };
}

function fixture() {
  const selectionCalls = [];
  const releaseCalls = [];
  const view = {
    variations: [1, 212, 500].map((variationNumber) => ({ variationNumber, recorded: true })),
    currentVariationNumber: 500, selectedVariationNumber: 500,
    isReviewingHistory: false,
  };
  const context = {
    variationPresetsView: require("../extension/tagger/variation-presets-view.js"),
    variationPresetsSnapshot: null, selectedPresetVariationNumber: null,
    queuedNextItemSnapshot: null, selectedQueuedVariationNumber: null,
    mountedStreamId: "synthetic-search",
    variationNavigationGeneration: 0,
    isCapturePlanningTarget: () => false,
    isCapturePlanningEnabled: () => false,
    isCapturePlanningLocked: () => context.isCaptureInteractionLocked(),
    syncCapturePlanningScope: () => false,
    isFuturePresetContextCurrent: () => false,
    addActiveStreamSkusButton: element(), activeStreamInventoryUpdateForm: element(),
    inventoryGrid: Object.assign(element(), { querySelectorAll: () => [] }),
    variationPresetsBusy: false, nextItemQueueMutationBusy: false,
    updateVariationPresetsAvailability() {},
    variationSearchForm: element(), variationSearchInput: element(),
    variationStepControls: element(), previousVariationButton: element(), nextVariationButton: element(),
    pendingSavedAction: null,
    trackerWorkspace: element(), captureHealthBadge: element(),
    mappingAnnouncement: element(), searchInput: element(), variationSelector: element(),
    returnToCurrentButton: element(),
    variationListbox: Object.assign(element(), {
      querySelectorAll() { assert.fail("Search must not inspect rendered dropdown rows"); },
    }),
    inventorySizeListbox: element(), retrySavedSessionButton: element(), retryStreamSessionButton: element(),
    savedSnapshot: { phase: "ready", busy: false, operation: "refresh", view },
    streamSnapshot: { activeSession: { streamId: "synthetic-search" }, resumed: true, busy: false },
    archivedReportsViewOpen: false, endConfirmationOpen: false,
    activeStreamInventoryUpdateBusy: false,
    inventorySizeMenuState: null,
    variationSelectorOpen: false, variationSelectorLock: { isLocked: () => false },
    updateQueuedItemBadgeAvailability() {},
    persistentController: {
      selectVariation(number) {
        selectionCalls.push(number);
        view.selectedVariationNumber = number;
        view.isReviewingHistory = number !== view.currentVariationNumber;
        return { view };
      },
    },
    releaseVariationSelector(options) { releaseCalls.push(options); },
    describeSelectedVariation: (current) => `Variation ${current.selectedVariationNumber}`,
    document: { activeElement: null },
  };
  context.captureHealthBadge.dataset.phase = "active";
  context.searchInput.value = "existing inventory filter";
  vm.createContext(context);
  vm.runInContext([
    "getActiveView", "getRecordedVariations", "getSelectableVariations", "findVariationOption", "reconcileQueuedPreviewSelection",
    "isCaptureInteractionLocked", "isTrackerInteractionTarget", "guardCaptureInteraction", "isSavedWorkspaceUnavailable",
    "syncCaptureInteractionLock", "syncCaptureInventoryLock", "setWorkspaceBusy", "snapshotIsBackgroundRefresh",
    "canSubmitVariationSearch", "updateVariationSearchAvailability", "submitVariationSearch",
    "canStepVariation", "getAdjacentVariationNumber", "updateVariationStepAvailability",
    "selectVariationFromPicker",
  ].map(declaration).join("\n"), context);
  vm.runInContext([
    registrations("variationSearchForm"),
    registrations("variationSearchInput"),
    registrations("returnToCurrentButton"),
  ].join("\n"), context);
  context.updateVariationSearchAvailability();
  return {
    context, view, selectionCalls, releaseCalls,
    submit(value) {
      context.variationSearchInput.value = value;
      return context.variationSearchForm.dispatch("submit");
    },
  };
}

test("variation-number input occupies the existing tracker-only health row with an accessible label", () => {
  const row = html.match(/<div class="capture-health-row" hidden>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(row);
  assert.match(row, /<form[^>]*id="variation-search-form"/);
  assert.match(row, /<input[^>]*id="variation-search-input"/);
  assert.match(row, /placeholder="Var #"/);
  assert.match(row, /aria-label="Find variation by number"/);
  assert.match(row, /inputmode="numeric"/);
  assert.match(row, /id="capture-health-badge"/);
  assert.equal((html.match(/id="variation-search-input"/g) ?? []).length, 1);
  assert.match(html, /id="tracker-workspace"[^>]*hidden\s*>\s*<div class="capture-health-row" hidden>/);
  assert.match(html, /id="mapping-announcement"[^>]*class="visually-hidden"[^>]*role="status"/);
  assert.doesNotMatch(fs.readFileSync(path.join(tagger, "..", "report", "report.html"), "utf8"), /variation-search/);
});

test("existing startup-row height and spacing stay unchanged while Reload Site retains its center slot", () => {
  const row = css.match(/\.capture-health-row\s*\{([^}]+)\}/)?.[1];
  assert.ok(row);
  assert.match(row, /height:\s*20px;/);
  assert.match(row, /margin-bottom:\s*6px;/);
  assert.match(row, /justify-content:\s*center;/);
  assert.match(css, /\.capture-health-badge\s*\{[^}]*height:\s*20px;/);
  assert.doesNotMatch(css, /\.capture-health-badge\[data-phase="blank"\]/);
  assert.match(css, /\.capture-health-badge\s*\{[^}]*justify-self:\s*center;/);
  assert.match(css, /#variation-search-input\s*\{/);
  assert.match(row, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 112px\) minmax\(0, 1fr\);/,
    "Equal flexible sides keep the badge centered and reserve its slot for the reload hint");
  assert.match(css, /\.variation-search-form\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;[^}]*width:\s*64px;[^}]*max-width:\s*max\(0px, calc\(100% - 46px\)\);[^}]*min-width:\s*0;/);
  assert.match(css, /\.variation-search-form\s*\{[^}]*margin:\s*0;[^}]*margin-inline-start:\s*min\(28px, max\(0px, calc\(100% - 110px\)\)\);/,
    "Rightward alignment gives back its inset and reserves both arrows on narrow panels");
  assert.match(css, /#variation-search-input\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*height:\s*20px;/);
});

test("step buttons occupy the left row slot with accessible names and remain outside reports", () => {
  const row = html.slice(html.indexOf('<div class="capture-health-row"'), html.indexOf('<section class="current-auction"'));
  assert.match(row, /id="variation-step-controls"[^>]*role="group"[^>]*aria-label="Variation navigation"[^>]*inert/);
  assert.match(row, /id="previous-variation" type="button" aria-label="Previous variation" disabled/);
  assert.match(row, /id="next-variation" type="button" aria-label="Next variation" disabled/);
  assert.ok(row.indexOf('id="variation-search-form"') < row.indexOf('id="previous-variation"'));
  assert.ok(row.indexOf('id="next-variation"') < row.indexOf('id="capture-health-badge"'));
  assert.match(row, /title="Start stream tracking to initialize dashboard capture\.">Not tracking<\/span>\s*<span id="capture-health-description"/,
    "Keep the badge and its custom tooltip adjacent");
  assert.doesNotMatch(fs.readFileSync(path.join(tagger, "..", "report", "report.html"), "utf8"), /variation-step-controls|previous-variation|next-variation/);
});

test("synthetic row geometry centers both arrows between the search input and the measured badge without moving either", () => {
  assert.match(css, /\.app-shell\s*\{[^}]*padding: 18px clamp\(14px, 4vw, 24px\) 14px;/);
  const arrows = css.match(/\.variation-step-controls\s*\{([^}]+)\}/)?.[1];
  assert.ok(arrows);
  assert.match(arrows, /grid-column: 1;[^}]*grid-row: 1;[^}]*justify-self: start;[^}]*gap: 2px;[^}]*width: 42px;[^}]*height: 20px;/);
  assert.doesNotMatch(arrows, /transform:/);
  assert.match(arrows, /--variation-search-end:\s*calc\(min\(28px, max\(0px, calc\(100% - 110px\)\)\) \+ min\(64px, max\(0px, calc\(100% - 46px\)\)\)\);/);
  assert.match(arrows, /margin-inline-start:\s*calc\(\(var\(--variation-search-end\) \+ 100% \+ 6px \+ \(112px - var\(--capture-badge-width, 112px\)\) \/ 2 - 42px\) \/ 2\);/);
  assert.equal((css.match(/var\(--capture-badge-width/g) ?? []).length, 1,
    "Only the arrow placement may consume the measured width; never resize or reposition the badge");
  assert.match(css, /\.variation-step-controls > button\s*\{[^}]*flex: 0 0 20px;[^}]*width: 20px;[^}]*min-width: 0;[^}]*height: 20px;[^}]*padding: 0;/);
  assert.match(css, /\.variation-step-controls > button:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus\);/);
  // This validates CSS constraints, not rendered browser pixels or glyph metrics.
  for (const viewport of [320, 321, 360, 399, 400, 420, 480, 700]) {
    const padding = Math.min(24, Math.max(14, viewport * 0.04));
    const rowWidth = viewport - padding * 2;
    const leftTrack = (rowWidth - 112 - 12) / 2;
    const inputLeft = Math.min(28, Math.max(0, leftTrack - 110));
    const inputWidth = Math.min(64, Math.max(0, leftTrack - 46));
    assert.ok(inputWidth >= 38, `Readable compact input at ${viewport}`);
    assert.equal(leftTrack + 6 + 56, rowWidth / 2, "Badge center is unchanged in every phase");
    // Representative synthetic border-box widths cover differently sized
    // retained badge labels and fractional font metrics, not actual glyph QA.
    for (const badgeWidth of [70, 83.625, 96, 112]) {
      const inputRight = inputLeft + inputWidth;
      const badgeLeft = leftTrack + 6 + (112 - badgeWidth) / 2;
      const arrowsLeft = (inputRight + badgeLeft - 42) / 2;
      const beforeGap = arrowsLeft - inputRight;
      const afterGap = badgeLeft - (arrowsLeft + 42);
      assert.ok(Math.abs(beforeGap - afterGap) < 1e-9, `Equal gaps at ${viewport}px, ${badgeWidth}px badge`);
      assert.ok(beforeGap >= 5 - 1e-9, `Search and focus rings remain clear at ${viewport}px`);
      assert.ok(afterGap >= 5 - 1e-9, `Badge and focus rings remain clear at ${viewport}px`);
      assert.equal(badgeLeft + badgeWidth / 2, rowWidth / 2, "Measuring does not move the centered badge");
      assert.ok(arrowsLeft >= 0 && arrowsLeft + 42 <= rowWidth, "Arrows never cause horizontal overflow");
    }
    if (viewport >= 480) {
      assert.equal(inputLeft, 28);
      assert.equal(inputWidth, 64);
    }
  }
});

test("badge-width measurements adjust only the arrow offset and retain safe fallback for hidden or invalid observations", () => {
  const properties = new Map(), writes = [];
  const badge = element();
  badge.dataset.phase = "active";
  badge.textContent = "Capture active";
  const context = {
    captureHealthBadge: badge,
    variationStepControls: {
      style: {
        setProperty(name, value) { properties.set(name, value); writes.push([name, value]); },
        removeProperty(name) { properties.delete(name); writes.push([name, null]); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(declaration("updateCaptureBadgeWidth"), context);
  const measure = width => context.updateCaptureBadgeWidth([{ target: badge, borderBoxSize: [{ inlineSize: width }] }]);
  for (const width of [112, 83.625, 70]) {
    measure(width);
    assert.equal(properties.get("--capture-badge-width"), `${width}px`);
  }
  const validWrites = writes.length;
  for (const width of [undefined, NaN, Infinity, -1, "94"]) measure(width);
  context.updateCaptureBadgeWidth([]);
  context.updateCaptureBadgeWidth([{ target: badge }]);
  context.updateCaptureBadgeWidth([{ target: element(), borderBoxSize: [{ inlineSize: 200 }] }]);
  assert.equal(writes.length, validWrites, "Invalid or unrelated observations must not move the arrows");
  assert.equal(properties.get("--capture-badge-width"), "70px");
  measure(0);
  assert.equal(properties.has("--capture-badge-width"), false, "A hidden badge restores the CSS 112px fallback");
  measure(95.5);
  assert.equal(properties.get("--capture-badge-width"), "95.5px", "Showing a different badge measures again");
  assert.equal(writes.every(([name]) => name === "--capture-badge-width"), true);
  assert.equal(badge.textContent, "Capture active");
  assert.equal(badge.dataset.phase, "active");
  assert.equal(badge.hidden, false);
  assert.equal(badge.hasAttribute("style"), false);
});

test("one border-box observer tracks badge label/font/viewport resizing and disconnects on page disposal without polling", () => {
  assert.match(source, /const captureBadgeSizeObserver = new ResizeObserver\(updateCaptureBadgeWidth\);/);
  assert.match(source, /captureBadgeSizeObserver\.observe\(captureHealthBadge, \{ box: "border-box" \}\);/);
  assert.equal((source.match(/new ResizeObserver\(updateCaptureBadgeWidth\)/g) ?? []).length, 1);
  const pagehide = source.slice(source.lastIndexOf('"pagehide"'));
  assert.match(pagehide, /captureBadgeSizeObserver\.disconnect\(\)/);
  assert.doesNotMatch(declaration("updateCaptureBadgeWidth"), /setTimeout|setInterval|requestAnimationFrame|captureHealthBadge\.(?:style|dataset|textContent)\s*=/);
});

test("submitting an exact variation number reuses historical and live selection without a dropdown DOM lookup", () => {
  const f = fixture();
  assert.equal(f.submit("212").prevented, true, "The native form must not navigate the panel");
  assert.deepEqual(f.selectionCalls, [212]);
  assert.equal(f.view.selectedVariationNumber, 212);
  assert.equal(f.view.isReviewingHistory, true);
  assert.match(f.context.mappingAnnouncement.textContent, /New live auctions will keep updating/);
  assert.equal(f.context.searchInput.value, "", "Retain the existing selector's inventory-filter behavior");
  assert.equal(f.context.variationSearchInput.value, "212");
  f.submit("500");
  assert.deepEqual(f.selectionCalls, [212, 500]);
  assert.equal(f.view.isReviewingHistory, false);
  assert.match(f.context.mappingAnnouncement.textContent, /following the current auction/);
  assert.equal(f.releaseCalls.length, 2);
});

test("number lookup handles whitespace and leading zeroes as an exact positive integer", () => {
  for (const value of [" 212 ", "00212"]) {
    const f = fixture();
    f.submit(value);
    assert.deepEqual(f.selectionCalls, [212]);
    assert.equal(f.context.variationSearchInput.value, value, "Do not rewrite the draft on submission");
  }
});

test("returning from history clears the variation search draft and its validation after selecting the live item", () => {
  for (const draft of ["212", "not a number"]) {
    const f = fixture();
    f.submit("212");
    if (draft !== "212") f.submit(draft);
    assert.equal(f.view.isReviewingHistory, true);
    assert.equal(f.context.variationSearchInput.value, draft);
    if (draft !== "212") {
      assert.ok(f.context.variationSearchInput.validationMessage);
      assert.equal(f.context.variationSearchInput.getAttribute("aria-invalid"), "true");
    }

    f.context.returnToCurrentButton.dispatch("click");

    assert.deepEqual(f.selectionCalls, [212, 500]);
    assert.equal(f.view.selectedVariationNumber, 500);
    assert.equal(f.view.isReviewingHistory, false);
    assert.equal(f.context.variationSearchInput.value, "");
    assert.equal(f.context.variationSearchInput.validationMessage, "");
    assert.equal(f.context.variationSearchInput.hasAttribute("aria-invalid"), false);
    assert.equal(f.context.variationSelector.focused, true);
    assert.match(f.context.mappingAnnouncement.textContent, /Returned to live/);
  }
});

test("unavailable or capture-blocked return clicks preserve the variation search draft and validation", () => {
  for (const change of [
    (f) => { f.view.variations = f.view.variations.filter(({ variationNumber }) => variationNumber !== 500); },
    (f) => { f.view.variations.find(({ variationNumber }) => variationNumber === 500).recorded = false; },
    (f) => { f.context.captureHealthBadge.dataset.phase = "connecting"; },
    (f) => { f.context.captureHealthBadge.dataset.phase = "loading"; },
  ]) {
    const f = fixture();
    f.submit("212");
    f.submit("not a number");
    const validation = f.context.variationSearchInput.validationMessage;
    change(f);

    f.context.returnToCurrentButton.dispatch("click");

    assert.deepEqual(f.selectionCalls, [212]);
    assert.equal(f.view.selectedVariationNumber, 212);
    assert.equal(f.context.variationSearchInput.value, "not a number");
    assert.equal(f.context.variationSearchInput.validationMessage, validation);
    assert.equal(f.context.variationSearchInput.getAttribute("aria-invalid"), "true");
  }
});

test("a return selection that fails to reach the live item does not clear the search draft", () => {
  const f = fixture();
  f.submit("212");
  f.submit("not a number");
  const validation = f.context.variationSearchInput.validationMessage;
  f.context.persistentController.selectVariation = (number) => {
    f.selectionCalls.push(number);
    return { view: f.view };
  };

  f.context.returnToCurrentButton.dispatch("click");

  assert.deepEqual(f.selectionCalls, [212, 500]);
  assert.equal(f.view.selectedVariationNumber, 212);
  assert.equal(f.context.variationSearchInput.value, "not a number");
  assert.equal(f.context.variationSearchInput.validationMessage, validation);
  assert.equal(f.context.variationSearchInput.getAttribute("aria-invalid"), "true");
  assert.match(f.context.mappingAnnouncement.textContent, /could not be selected/);
});

test("invalid and unsafe numbers do not select, create, or clear the current variation", () => {
  for (const value of ["", " ", "0", "-1", "+212", "#212", "21.2", "212.0", "2e2", "Infinity", "212x", "2 12", "9007199254740992"]) {
    const f = fixture();
    f.submit(value);
    assert.deepEqual(f.selectionCalls, [], value);
    assert.equal(f.view.selectedVariationNumber, 500, value);
    assert.equal(f.context.searchInput.value, "existing inventory filter", value);
    assert.ok(f.context.mappingAnnouncement.textContent.length > 0, "Invalid entry needs accessible feedback");
    assert.equal(f.context.variationSearchInput.getAttribute("aria-invalid"), "true");
    assert.equal(f.context.variationSearchInput.validityReported, true);
  }
});

test("a valid but absent variation leaves selection and drafts alone with accessible feedback", () => {
  const f = fixture();
  f.submit("213");
  assert.deepEqual(f.selectionCalls, []);
  assert.equal(f.view.selectedVariationNumber, 500);
  assert.equal(f.context.variationSearchInput.value, "213");
  assert.equal(f.context.searchInput.value, "existing inventory filter");
  assert.match(f.context.mappingAnnouncement.textContent, /213/);
  assert.match(f.context.mappingAnnouncement.textContent, /not|found|captured/i);
});

test("uncaptured placeholder options cannot be selected and an empty tracker leaves search disabled", () => {
  const f = fixture();
  f.view.variations.push({ variationNumber: 213, recorded: false });
  f.submit("213");
  assert.deepEqual(f.selectionCalls, []);
  assert.match(f.context.mappingAnnouncement.textContent, /not been captured/);
  f.view.variations = [{ variationNumber: 213, recorded: false }];
  f.context.updateVariationSearchAvailability();
  assert.equal(f.context.variationSearchInput.disabled, true);
  f.submit("213");
  assert.deepEqual(f.selectionCalls, []);
});

test("typing, pasting and clearing only edit the draft until the form is submitted", () => {
  const f = fixture();
  for (const value of ["2", "21", "212", ""]) {
    f.context.variationSearchInput.value = value;
    for (const event of ["input", "change", "paste", "keydown"]) {
      f.context.variationSearchInput.dispatch(event, { key: "2" });
    }
    assert.deepEqual(f.selectionCalls, []);
    assert.equal(f.view.selectedVariationNumber, 500);
    assert.equal(f.context.variationSearchInput.value, value);
  }
  assert.match(registrations("variationSearchForm"), /"submit"/);
});

test("editing after an invalid query clears only the field validation without changing selection", () => {
  const f = fixture();
  f.submit("not a number");
  assert.ok(f.context.variationSearchInput.validationMessage);
  f.context.variationSearchInput.value = "212";
  f.context.variationSearchInput.dispatch("input");
  assert.equal(f.context.variationSearchInput.validationMessage, "");
  assert.equal(f.context.variationSearchInput.hasAttribute("aria-invalid"), false);
  assert.equal(f.view.selectedVariationNumber, 500);
  assert.deepEqual(f.selectionCalls, []);
});

test("Connecting and Loading disable editing and stale submits while green and blank permit search", () => {
  const f = fixture();
  for (const phase of ["connecting", "loading", "connecting", "loading", "active", "loading", "blank"]) {
    f.context.captureHealthBadge.dataset.phase = phase;
    f.context.syncCaptureInteractionLock();
    const locked = phase === "connecting" || phase === "loading";
    assert.equal(f.context.variationSearchInput.disabled, locked, phase);
    assert.equal(f.context.variationSearchForm.hasAttribute("inert"), locked, phase);
    const previousCalls = f.selectionCalls.length;
    f.submit("212");
    assert.equal(f.selectionCalls.length, previousCalls + Number(!locked), phase);
    assert.equal(f.context.variationSearchInput.value, "212");
  }
});

test("green/blank do not bypass busy, error, End confirmation, inactive or hidden tracker safeguards", () => {
  const changes = [
    ["save", (c) => { c.savedSnapshot.phase = "saving"; c.savedSnapshot.busy = true; }],
    ["refresh", (c) => { c.savedSnapshot.phase = "loading"; c.savedSnapshot.busy = true; }],
    ["error", (c) => { c.savedSnapshot.phase = "error"; }],
    ["session busy", (c) => { c.streamSnapshot.busy = true; }],
    ["end confirmation", (c) => { c.endConfirmationOpen = true; }],
    ["setup", (c) => { c.streamSnapshot.activeSession = null; }],
    ["resume-only", (c) => { c.streamSnapshot.resumed = false; }],
    ["hidden", (c) => { c.trackerWorkspace.hidden = true; }],
    ["archived reports", (c) => { c.archivedReportsViewOpen = true; }],
    ["controller absent", (c) => { c.persistentController = null; }],
    ["workspace inert", (c) => { c.trackerWorkspace.setAttribute("inert", ""); }],
    ["snapshot still busy", (c) => { c.savedSnapshot.busy = true; }],
  ];
  for (const phase of ["active", "blank"]) {
    for (const [name, change] of changes) {
      const f = fixture();
      f.context.captureHealthBadge.dataset.phase = phase;
      change(f.context);
      f.context.updateVariationSearchAvailability();
      assert.equal(f.context.variationSearchInput.disabled, true, `${phase}/${name}`);
      f.submit("212");
      assert.deepEqual(f.selectionCalls, [], `${phase}/${name}`);
    }
  }
});

test("not-tracking keeps search disabled and a blank startup result remains searchable", () => {
  const f = fixture();
  f.context.captureHealthBadge.dataset.phase = "not_tracking";
  f.context.updateVariationSearchAvailability();
  assert.equal(f.context.variationSearchInput.disabled, true);
  f.submit("212");
  assert.deepEqual(f.selectionCalls, []);
  f.context.captureHealthBadge.dataset.phase = "blank";
  f.context.updateVariationSearchAvailability();
  assert.equal(f.context.variationSearchInput.disabled, false);
  f.submit("212");
  assert.deepEqual(f.selectionCalls, [212]);
  assert.equal(f.context.captureHealthBadge.dataset.phase, "blank");
});

test("search closes an open size picker before switching variation via the existing workflow", () => {
  const f = fixture();
  const sequence = [];
  f.context.inventorySizeMenuState = { synthetic: true };
  f.context.releaseInventorySizeMenu = (options) => {
    assert.equal(options.restoreFocus, false);
    f.context.inventorySizeMenuState = null;
    sequence.push("close size menu");
  };
  const select = f.context.persistentController.selectVariation;
  f.context.persistentController.selectVariation = (number) => {
    sequence.push("select variation");
    return select(number);
  };
  f.submit("212");
  assert.deepEqual(sequence, ["close size menu", "select variation"]);
});

test("ordinary renders and repeated refresh busy/ready changes preserve the draft and capture lock", () => {
  const f = fixture();
  f.context.variationSearchInput.value = "21";
  f.context.captureHealthBadge.dataset.phase = "loading";
  let renders = 0;
  for (const name of ["renderVariationNavigation", "renderLiveAuction", "renderAuction", "renderInventory", "renderMetrics"]) {
    f.context[name] = () => { renders++; };
  }
  vm.runInContext(declaration("renderAll"), f.context);
  for (const phase of ["loading", "ready", "loading", "ready"]) {
    f.context.savedSnapshot.phase = phase;
    f.context.savedSnapshot.busy = phase === "loading";
    f.context.setWorkspaceBusy(f.context.savedSnapshot.busy);
    f.context.renderAll();
    assert.equal(f.context.variationSearchInput.value, "21");
    assert.equal(f.context.variationSearchInput.disabled, true);
    assert.deepEqual(f.selectionCalls, []);
  }
  assert.equal(renders, 20, "The new field must not stop ordinary rendering");
});

test("availability is resynchronized through the existing capture-lock lifecycle", () => {
  assert.match(declaration("syncCaptureInteractionLock"), /updateVariationSearchAvailability\(\)/);
  assert.match(declaration("setWorkspaceBusy"), /syncCaptureInteractionLock\(\)/);
  assert.match(declaration("setTrackerWorkspaceVisible"), /syncCaptureInteractionLock\(\)/);
});

test("searching through the real controller preserves canonical mappings, inventory and queue while capture refreshes continue", async () => {
  const streamId = "local-stream:variation-number-search-test";
  let state = reconciliation.createReconciliationState([
    { sku: "SYNTHETIC-A", item: "Synthetic tee", style: "", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId });
  reconciliation.observeVariations(state, { streamId, variationNumbers: [1, 212, 500] });
  reconciliation.mapVariation(state, { streamId, variationNumber: 212, sku: "SYNTHETIC-A" });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const calls = [];
  const client = {
    async getState() { calls.push("read"); return { state: clone(state), result: null }; },
    async initializeState() { assert.fail("Search must never initialize canonical inventory"); },
    async mapVariation() { assert.fail("Search must never change canonical mappings"); },
    async unmapVariation() { assert.fail("Search must never remove canonical mappings"); },
  };
  const controller = controllerModule.createPersistentTaggerController({
    client, reconciliation, mappingWorkflow, streamId,
    currentVariationNumber: 500, variationNumbers: [1, 212, 500],
  });
  const f = fixture();
  f.context.persistentController = controller;
  f.context.savedSnapshot = await controller.start();
  f.context.queuedNextItemSku = "SYNTHETIC-A";
  controller.subscribe((snapshot) => { f.context.savedSnapshot = snapshot; });
  const before = clone(state);
  const readsBefore = calls.length;

  f.submit("212");
  assert.equal(controller.getSnapshot().view.selectedVariationNumber, 212);
  assert.equal(controller.getSnapshot().view.isReviewingHistory, true);
  assert.deepEqual(state, before);
  assert.equal(calls.length, readsBefore, "Selection is not a capture or storage mutation");
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");

  reconciliation.observeVariations(state, { streamId, variationNumbers: [501] });
  await controller.refresh();
  assert.equal(controller.getSnapshot().view.currentVariationNumber, 501);
  assert.equal(controller.getSnapshot().view.selectedVariationNumber, 212);
  assert.equal(f.context.variationSearchInput.value, "212");
  f.submit("501");
  assert.equal(controller.getSnapshot().view.isReviewingHistory, false);
  reconciliation.observeVariations(state, { streamId, variationNumbers: [502] });
  await controller.refresh();
  assert.equal(controller.getSnapshot().view.selectedVariationNumber, 502);
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
  assert.equal(f.context.variationSearchInput.value, "501");
});
