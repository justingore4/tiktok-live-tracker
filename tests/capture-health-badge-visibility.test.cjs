const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const view = require("../extension/tagger/capture-health-view.js");
const tagger = path.join(__dirname, "..", "extension", "tagger");
const panelSource = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const source = fs.readFileSync(path.join(tagger, "capture-health-view.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const workspace = { hidden: false, inert: true, scrollTop: 87 };
  const row = { hidden: true, parentElement: workspace }, attributes = new Map();
  const badge = { dataset: {}, textContent: "", closest: () => row,
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: (name) => attributes.delete(name) };
  const description = {};
  return { workspace, row, badge, description, attributes,
    render(phase, reason = "unavailable") { view.renderBadge(badge, description, { phase, reason }); } };
}

test("unavailable startup shows an accessible static Reload Site hint with the existing neutral badge style", () => {
  assert.deepEqual(view.LABELS, {
    not_tracking: "Not tracking", connecting: "Connecting", active: "Capture active", loading: "Loading", blank: "Reload Site",
  });
  const reloadDescription = "Reload the TikTok LIVE dashboard to initialize capture.";
  assert.equal(view.DESCRIPTIONS.unavailable, reloadDescription);
  const f = fixture(), before = structuredClone(f.workspace); f.attributes.set("tabindex", "0");
  f.render("active", "ready"); f.render("blank");
  assert.equal(f.badge.textContent, "Reload Site");
  assert.equal(f.badge.title, reloadDescription);
  assert.equal(f.description.textContent, reloadDescription);
  assert.equal(f.badge.dataset.phase, "blank"); assert.equal(f.attributes.get("aria-hidden"), "false");
  assert.equal(f.attributes.has("tabindex"), false); assert.equal(f.row.hidden, false); assert.deepEqual(f.workspace, before);
  assert.doesNotMatch(css, /\.capture-health-badge\[data-phase="blank"\]/);
  const rule = css.match(/\.capture-health-badge\s*\{([^}]+)\}/)?.[1];
  assert.match(rule, /background:\s*rgb\(119 132 151 \/ 12%\);/);
  assert.match(rule, /color:\s*#b7c1ce;/);
  assert.doesNotMatch(rule, /animation:|cursor:\s*pointer|visibility:\s*hidden/);
  assert.doesNotMatch(html.match(/<span id="capture-health-badge"[\s\S]*?<\/span>/)[0], /tabindex|<button|<a\s/);
  assert.doesNotMatch(source, /(?:location|tabs)\.reload\s*\(/);
  assert.doesNotMatch(panelSource, /captureHealthBadge\.addEventListener\(\s*["']click/);
  f.render("<script>", "<img>"); assert.equal(f.badge.dataset.phase, "blank");
  assert.equal(f.badge.textContent, "Reload Site");
  assert.equal(f.badge.title, reloadDescription);
  assert.equal(f.description.textContent, reloadDescription);
});

test("only the active tooltip is centered, constrained and outside layout flow while its description stays accessible", () => {
  const row = css.match(/\.capture-health-row\s*\{([^}]+)\}/)[1];
  const hiddenDescription = css.match(/\.capture-health-description\s*\{([^}]+)\}/)[1];
  const tooltip = css.match(/\.capture-health-badge\[data-phase="active"\]:hover \+ \.capture-health-description\s*\{([^}]+)\}/)[1];
  assert.match(row, /position:\s*relative;/);
  assert.match(row, /height:\s*20px;/);
  assert.match(hiddenDescription, /position:\s*absolute;/);
  assert.match(hiddenDescription, /clip:\s*rect\(0, 0, 0, 0\);/);
  assert.doesNotMatch(hiddenDescription, /display:\s*none|visibility:\s*hidden/);
  assert.match(tooltip, /position:\s*absolute;/);
  assert.match(tooltip, /left:\s*50%;/);
  assert.match(tooltip, /transform:\s*translateX\(-50%\);/);
  assert.match(tooltip, /width:\s*max-content;/);
  assert.match(tooltip, /max-width:\s*100%;/);
  assert.match(tooltip, /box-sizing:\s*border-box;/);
  assert.match(tooltip, /clip:\s*auto;/);
  assert.match(tooltip, /white-space:\s*normal;/);
  assert.match(tooltip, /overflow-wrap:\s*anywhere;/);
  assert.match(tooltip, /pointer-events:\s*none;/);
  const descriptionTag = html.match(/<span id="capture-health-description"[^>]*>/)[0];
  assert.match(descriptionTag, /class="capture-health-description"/);
  assert.doesNotMatch(descriptionTag, /visually-hidden|aria-hidden|tabindex/);
  assert.match(html, /aria-describedby="capture-health-description"/);
  // These verify the declared geometry, not browser-rendered pixels.
  for (const rowWidth of [220, 320, 500, 700]) {
    const tooltipWidth = Math.min(370, rowWidth);
    const left = rowWidth / 2 - tooltipWidth / 2;
    assert.equal(left + tooltipWidth / 2, rowWidth / 2);
    assert.ok(left >= 0 && left + tooltipWidth <= rowWidth);
  }
});

test("active tooltip transitions suppress only its native title without changing badge or workspace state", () => {
  const f = fixture(), before = structuredClone(f.workspace);
  for (const [phase, reason] of [["connecting", "awaiting_capture"], ["loading", "initializing"],
    ["active", "ready"], ["blank", "unavailable"], ["active", "ready"]]) {
    f.render(phase, reason);
    assert.equal(f.badge.title, phase === "active" ? "" : view.DESCRIPTIONS[reason]);
    assert.equal(f.description.textContent, view.DESCRIPTIONS[reason]);
    assert.equal(f.badge.dataset.phase, phase);
    assert.equal(f.badge.textContent, view.LABELS[phase]);
    assert.equal(f.attributes.has("tabindex"), false);
    assert.deepEqual(f.workspace, before);
  }
});

test("not tracking hides the whole row; startup phases restore only the row, never a hidden workspace", () => {
  const f = fixture(); f.workspace.hidden = true;
  for (const phase of ["connecting", "loading", "active", "blank"]) {
    f.render("not_tracking", "not_tracking"); assert.equal(f.row.hidden, true);
    f.render(phase, "initializing"); assert.equal(f.row.hidden, false); assert.equal(f.workspace.hidden, true);
    assert.equal(f.attributes.get("aria-hidden"), "false");
    assert.equal(f.badge.textContent, view.LABELS[phase]);
    if (phase === "blank") {
      assert.equal(f.description.textContent, view.DESCRIPTIONS.unavailable);
      assert.equal(f.badge.title, view.DESCRIPTIONS.unavailable);
    }
  }
});

test("no red presentation timer or auto-hide controller remains", () => {
  assert.equal(view.createCaptureHealthBadgeVisibilityController, undefined); assert.equal(view.RED_BADGE_HIDE_MS, undefined);
  assert.doesNotMatch(source + panelSource + css, /autoHidden|auto-hidden|RED_BADGE_HIDE_MS|redDeadline|captureHealthBadgeVisibilityController/);
  assert.doesNotMatch(css, /capture-health-badge\[data-phase="unavailable"\]/);
});

test("fixed reserved center width keeps the existing Var search position stable in blank and visible phases", () => {
  const row = css.match(/\.capture-health-row\s*\{([^}]+)\}/)[1];
  const badge = css.match(/\.capture-health-badge\s*\{([^}]+)\}/)[1];
  const form = css.match(/\.variation-search-form\s*\{([^}]+)\}/)[1];
  assert.match(row, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 112px\) minmax\(0, 1fr\);/);
  assert.match(row, /height:\s*20px;/); assert.match(row, /margin-bottom:\s*6px;/);
  assert.match(badge, /grid-column:\s*2;/); assert.match(badge, /justify-self:\s*center;/);
  assert.doesNotMatch(badge, /(?:^|;)\s*width:/, "Visible pills retain their intrinsic width and existing padding");
  assert.match(form, /grid-column:\s*1;/); assert.match(form, /width:\s*64px;/);
  assert.match(form, /margin-inline-start:\s*min\(28px, max\(0px, calc\(100% - 64px\)\)\);/);
  // Numeric grid-track checks are synthetic layout checks, not browser pixels.
  for (const available of [100, 160, 220, 320, 500]) {
    const positions = ["connecting", "loading", "active", "blank"].map(() => {
      const centerTrack = Math.min(112, Math.max(0, available - 12));
      const leftTrack = Math.max(0, (available - centerTrack - 12) / 2);
      return Math.min(28, Math.max(0, leftTrack - 64));
    });
    assert.equal(new Set(positions).size, 1);
  }
  assert.doesNotMatch(css, /capture-health-badge\[data-phase="[^\"]+"\]\s*\{[^}]*\bwidth:/);
});

test("slot remains tracker-only and blue/yellow keep their reduced-motion-safe decorative spinner", () => {
  assert.match(html, /id="tracker-workspace"[^>]*hidden\s*>\s*<div class="capture-health-row" hidden>/);
  assert.match(html, /<div class="capture-health-row" hidden>[\s\S]*?<\/div>\s*<section class="current-auction"/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;/);
  assert.match(panelSource, /captureHealthController\.setSession\(snapshot\.activeSession\?\.streamId \?\? null\)/);
  assert.match(panelSource, /"pagehide",[\s\S]*?captureHealthController\.dispose\(\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(tagger, "..", "report", "report.html"), "utf8"), /capture-health/);
  assert.match(css, /\.capture-health-badge\[data-phase="connecting"\]::before,\s*\.capture-health-badge\[data-phase="loading"\]::before\s*\{[^}]*animation:\s*capture-health-spin 0\.8s linear infinite;/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.capture-health-badge\[data-phase="connecting"\]::before,\s*\.capture-health-badge\[data-phase="loading"\]::before\s*\{\s*animation:\s*none;/);
  assert.doesNotMatch(css, /\.capture-health-badge\[data-phase="(?:active|blank|not_tracking)"\]::before/);
});

test("actual subscription keeps green for later errors and only resets for a different document", async () => {
  const f = fixture(); let nextId = 0; const timers = new Map();
  let response = { ok: true, data: { streamId: "synthetic-stream", loadId: "document-a", phase: "active", reason: "ready" } };
  let failed = false, requests = 0;
  const callback = panelSource.match(/onChange:\s*(\(state\) => \{[\s\S]*?\n    \})/)[1];
  const onChange = vm.runInNewContext(`(${callback})`, {
    captureHealthView: view, captureHealthBadge: f.badge, captureHealthDescription: f.description,
    savedSnapshot: { busy: true }, setWorkspaceBusy(busy) { assert.equal(busy, true); },
  });
  const controller = view.createCaptureHealthViewController({
    runtime: { async sendMessage() { requests++; if (failed) throw new Error("offline"); return response; } },
    protocol: { CHANNEL: "tiktok-live-tracker.capture-health", VERSION: 2 }, onChange,
    setTimeoutFn(fn) { timers.set(++nextId, fn); return nextId; }, clearTimeoutFn(id) { timers.delete(id); },
  });
  controller.setSession("synthetic-stream"); await flush(); assert.equal(f.badge.dataset.phase, "active");
  failed = true; await controller.refresh(); assert.equal(f.badge.dataset.phase, "active");
  assert.equal(f.badge.textContent, "Capture active");
  assert.equal(f.description.textContent, view.DESCRIPTIONS.ready);
  failed = false; response = { ok: true, data: { streamId: "synthetic-stream", loadId: null, phase: "blank", reason: "unavailable" } };
  await controller.refresh(); assert.equal(f.badge.dataset.phase, "active");
  assert.equal(f.badge.textContent, "Capture active", "later unavailable results cannot replace latched green with the reload hint");
  response.data = { ...response.data, loadId: "document-b", phase: "loading", reason: "initializing" };
  await controller.refresh(); assert.equal(f.badge.dataset.phase, "loading");
  response.data = { ...response.data, phase: "blank", reason: "unavailable" };
  await controller.refresh(); assert.equal(f.badge.textContent, "Reload Site");
  assert.equal(f.badge.title, view.DESCRIPTIONS.unavailable);
  assert.equal(f.description.textContent, view.DESCRIPTIONS.unavailable);
  assert.equal(f.attributes.get("aria-hidden"), "false");
  assert.equal(f.attributes.has("tabindex"), false);
  assert.equal(f.row.hidden, false); assert.equal(f.workspace.inert, true);
  assert.equal(requests, 5); controller.dispose(); assert.equal(timers.size, 0);
});
