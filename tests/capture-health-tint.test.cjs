const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const healthView = require("../extension/tagger/capture-health-view.js");
const health = require("../extension/shared/capture-health.js");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const panelSource = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const tintRule = css.match(/(\.tracker-workspace:has\([^{}]+)\{([^{}]+)\}/);

function createFixture() {
  const attributes = new Map();
  const workspace = {
    hidden: false,
    setAttribute(name, value) { attributes.set(name, value); },
    toggleAttribute(name, value) { if (value) attributes.set(name, ""); else attributes.delete(name); },
  };
  const row = { hidden: true };
  const badge = {
    textContent: "Not tracking", dataset: {},
    closest(selector) { assert.equal(selector, ".capture-health-row"); return row; },
  };
  const description = {};
  const context = {
    trackerWorkspace: workspace,
    streamSnapshot: { resumed: true, activeSession: { streamId: "synthetic-stream" }, busy: false },
    activeStreamInventoryUpdateBusy: false,
    savedSnapshot: { phase: "loading", operation: "refresh" },
    variationSelectorLock: { isLocked: () => false },
    inventorySizeMenuState: null,
    endConfirmationOpen: false,
    // Capture-interaction-lock tests exercise this separately; this fixture
    // isolates the pre-existing busy safeguards from visual tint behavior.
    syncCaptureInteractionLock() {},
  };
  const busyStart = panelSource.indexOf("  function setWorkspaceBusy(busy)");
  const busyEnd = panelSource.indexOf("  function hideVariationListbox()", busyStart);
  assert.ok(busyStart >= 0 && busyEnd > busyStart);
  const setBusy = vm.runInNewContext(
    `${panelSource.slice(busyStart, busyEnd)}\nsetWorkspaceBusy;`, context,
  );
  return {
    workspace, row, badge, attributes, context, setBusy,
    render(phase, reason = "backlog") { healthView.renderBadge(badge, description, { phase, reason }); },
  };
}

test("workspace tint targets only Connecting/Loading content, never the badge or a busy refresh", () => {
  assert.ok(tintRule);
  const selectors = tintRule[1].split(",").map((selector) => selector.trim());
  assert.deepEqual(selectors, ["connecting", "loading"].map((phase) =>
    `.tracker-workspace:has(> .capture-health-row > .capture-health-badge[data-phase="${phase}"]) > :not(.capture-health-row)`));
  assert.match(tintRule[2], /^\s*opacity:\s*0\.5;\s*$/,
    "The tint changes no dimensions, positioning, scrolling, interactions, or animation");
  assert.doesNotMatch(css, /\.tracker-workspace\[aria-busy=[^\]]+\]/,
    "Per-refresh busy flags no longer apply whole-workspace opacity");
  const directWorkspaceRules = [...css.matchAll(/\.tracker-workspace(?:\[[^\]]+\])?\s*\{([^{}]*)\}/g)];
  assert.ok(directWorkspaceRules.every((rule) => !/opacity\s*:|filter\s*:/.test(rule[1])),
    "No ancestor opacity or filter can also dim the health badge/spinner");
});

test("badge state transitions retain the same tint across Connecting/Loading and clear it for green/red", () => {
  const f = createFixture();
  const tintPhases = [...tintRule[1].matchAll(/data-phase="([^"]+)"/g)].map((match) => match[1]);
  const tintOpacity = Number(tintRule[2].match(/opacity:\s*([\d.]+)/)[1]);
  // Check the real badge renderer against the exact state filters in the CSS.
  // Pixel rendering is a separate browser check, not simulated here.
  const sequence = [
    ["connecting", 0.5], ["loading", 0.5], ["connecting", 0.5], ["loading", 0.5],
    ["active", 1], ["loading", 0.5], ["unavailable", 1], ["connecting", 0.5],
    ["active", 1], ["not_tracking", 1],
  ];
  for (const [phase, expected] of sequence) {
    f.render(phase);
    for (const busy of [false, true, false, true, false]) {
      f.setBusy(busy);
      assert.equal(tintPhases.includes(f.badge.dataset.phase) ? tintOpacity : 1, expected);
      assert.equal(f.attributes.get("aria-busy"), String(busy));
      assert.equal(f.attributes.has("inert"), busy,
        "Busy interaction protection remains independent of the visual tint");
      assert.equal(f.badge.textContent, healthView.LABELS[phase]);
    }
  }
  assert.equal(f.row.hidden, true);
  f.render("unexpected-phase", "unexpected-reason");
  assert.equal(f.badge.dataset.phase, "unavailable");
  assert.equal(tintPhases.includes(f.badge.dataset.phase), false,
    "Invalid states use the existing red fallback without stale dimming");
});

test("health rendering preserves workspace visibility, errors, busy state and interaction safeguards", () => {
  const f = createFixture();
  f.workspace.hidden = true; // Resume/End-only view.
  f.context.streamSnapshot.resumed = false;
  for (const phase of ["connecting", "loading", "active", "unavailable"]) {
    f.setBusy(false);
    const before = [...f.attributes];
    f.render(phase);
    assert.equal(f.workspace.hidden, true);
    assert.deepEqual([...f.attributes], before);
    assert.equal(f.attributes.has("inert"), true);
  }
  f.context.streamSnapshot.resumed = true;
  f.workspace.hidden = false;
  f.context.variationSelectorLock.isLocked = () => true;
  f.setBusy(true);
  assert.equal(f.attributes.get("aria-busy"), "true");
  assert.equal(f.attributes.has("inert"), false, "Existing background-refresh picker exemption stays intact");
  f.context.endConfirmationOpen = true;
  f.setBusy(false);
  assert.equal(f.attributes.has("inert"), true, "End confirmation retains its interaction guard");
  f.context.endConfirmationOpen = false;
  f.context.savedSnapshot.phase = "error";
  f.setBusy(false);
  assert.equal(f.attributes.has("inert"), true, "Saved-state errors retain their interaction guard");
  assert.equal(f.attributes.get("aria-busy"), "false");
});

for (const failure of ["no_source", "no_first_sample", "unreadable"]) {
  test(`${failure} timeout clears existing tint at ten seconds; pending updates and recovery still drive it`, () => {
    const f = createFixture();
    const streamId = "local-stream:11111111-1111-4111-8111-111111111111";
    const source = { tabId: 9, documentId: "synthetic-dashboard" };
    const clean = { readable: true, pending: 0, inFlight: false, retrying: false, visible: true };
    let now = 0, sequence = 0;
    const store = health.createCaptureHealthStore({ now: () => now, createContextId: () => "synthetic-context" });
    store.setSession(streamId);
    let context = failure === "no_source" ? null : store.context(source);
    function pulse(sample) {
      assert.deepEqual(store.pulse(source, { type: "pulse", ...context, sequence: sequence++, sampledAt: now, sample }), { accepted: true });
    }
    function expectTint(phase, dimmed) {
      const state = store.get(streamId);
      f.render(state.phase, state.reason);
      assert.equal(f.badge.dataset.phase, phase);
      assert.equal(f.badge.textContent, healthView.LABELS[phase]);
      const selectors = [...tintRule[1].matchAll(/data-phase="([^"]+)"/g)].map((match) => match[1]);
      assert.equal(selectors.includes(f.badge.dataset.phase), dimmed,
        "The actual timeout state feeds the existing CSS selector, not a separate dimming timer");
    }
    if (failure === "unreadable") pulse({ ...clean, readable: false });
    const initialPhase = failure === "unreadable" ? "loading" : "connecting";
    expectTint(initialPhase, true);
    now = 9999; expectTint(initialPhase, true);
    now = 10000; expectTint("unavailable", false);
    context ??= store.context(source);
    pulse({ ...clean, pending: 1 }); expectTint("loading", true);
    now = 25000;
    pulse({ ...clean, pending: 1 }); expectTint("loading", true);
    now = 30000; pulse(clean); expectTint("loading", true);
    now = 35000; pulse(clean); expectTint("active", false);
  });
}

test("tint remains scoped to the tracker with its hidden badge row and unchanged spinner behavior", () => {
  assert.match(html, /id="tracker-workspace"[^>]*\bhidden\s*>\s*<div class="capture-health-row" hidden>/);
  assert.match(html, /<div class="capture-health-row" hidden>[\s\S]*?<\/div>\s*<section class="current-auction"/);
  assert.doesNotMatch(tintRule[1], /stream-session-panel|inventory-import-panel|stream-reports|archived-reports/);
  assert.doesNotMatch(fs.readFileSync(path.join(tagger, "..", "report", "report.html"), "utf8"), /capture-health|tracker-workspace/);
  assert.match(css, /\.capture-health-row\s*\{[^}]*height:\s*20px;[^}]*margin-bottom:\s*6px;/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.capture-health-badge\[data-phase="connecting"\]::before,\s*\.capture-health-badge\[data-phase="loading"\]::before\s*\{\s*animation:\s*none;/);
});
