const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const view = require("../extension/tagger/capture-health-view.js");

const taggerDirectory = path.join(__dirname, "..", "extension", "tagger");
const panelSource = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
const css = fs.readFileSync(path.join(taggerDirectory, "sidepanel.css"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock(start = 0) {
  let time = start;
  let nextId = 0;
  const pending = new Map();
  const history = new Map();
  const now = () => time;
  function setTimeoutFn(callback, delay) {
    assert.ok(Number.isFinite(delay) && delay >= 0, "Timers use a finite, nonnegative remaining delay");
    const id = ++nextId;
    const timer = { callback, delay, at: time + delay };
    pending.set(id, timer);
    history.set(id, timer);
    return id;
  }
  function clearTimeoutFn(id) { pending.delete(id); }
  function nextDue(target) {
    const entry = [...pending.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    return entry && entry[1].at <= target ? entry : null;
  }
  function fire(id) {
    const timer = history.get(id);
    assert.ok(timer, `Unknown fake timer ${id}`);
    pending.delete(id);
    timer.callback(); // Deliberately permits delivery of a callback already canceled by the app.
  }
  function advance(ms) {
    const target = time + ms;
    let entry;
    while ((entry = nextDue(target))) {
      time = Math.max(time, entry[1].at);
      fire(entry[0]);
    }
    time = target;
  }
  async function advanceAsync(ms) {
    const target = time + ms;
    let entry;
    while ((entry = nextDue(target))) {
      time = Math.max(time, entry[1].at);
      fire(entry[0]);
      await flush();
    }
    time = target;
    await flush();
  }
  return {
    now, setTimeoutFn, clearTimeoutFn, pending, history, fire, advance, advanceAsync,
    jump(ms) { time += ms; },
  };
}

function fixture(start = 0) {
  const clock = fakeClock(start);
  const workspace = { hidden: false, inert: false, scrollTop: 87, dataset: { busy: "true" } };
  const row = { hidden: true, parentElement: workspace };
  const badge = {
    dataset: {}, textContent: "Not tracking", hidden: false, parentElement: row,
    closest(selector) { assert.equal(selector, ".capture-health-row"); return row; },
  };
  const description = {};
  const controller = view.createCaptureHealthBadgeVisibilityController({ badge, ...clock });
  function render(phase, reason = "no_source") {
    view.renderBadge(badge, description, { phase, reason });
    controller.update();
  }
  function contentSnapshot() {
    return {
      phase: badge.dataset.phase, text: badge.textContent, title: badge.title,
      detail: description.textContent, badgeHidden: badge.hidden, rowHidden: row.hidden,
      workspace: structuredClone(workspace),
    };
  }
  return { clock, workspace, row, badge, description, controller, render, contentSnapshot };
}

function onlyTimer(clock) {
  assert.equal(clock.pending.size, 1);
  return [...clock.pending.keys()][0];
}

test("red badge stays visible through 12,999 ms and hides at 13,000 ms without changing health or layout state", () => {
  assert.equal(view.RED_BADGE_HIDE_MS, 13000);
  const f = fixture(42000);
  f.render("unavailable");
  const content = f.contentSnapshot();
  assert.equal(f.badge.dataset.autoHidden, "false");
  assert.equal(f.row.hidden, false);
  f.clock.advance(12999);
  assert.equal(f.badge.dataset.autoHidden, "false");
  assert.deepEqual(f.contentSnapshot(), content);
  f.clock.advance(1);
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.deepEqual(f.contentSnapshot(), content, "Only the presentation flag changes");
  assert.equal(f.clock.pending.size, 0);
  f.clock.advance(60000);
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.deepEqual(f.contentSnapshot(), content);
});

test("repeated unavailable renders and reason changes never restart or resurrect the red badge", () => {
  const f = fixture();
  f.render("unavailable", "no_source");
  for (const [at, reason] of [[2000, "no_source"], [6000, "unreadable"], [12000, "stale"], [12999, "transport_unavailable"]]) {
    f.clock.advance(at - f.clock.now());
    f.render("unavailable", reason);
    assert.equal(f.badge.dataset.autoHidden, "false");
    assert.equal(f.clock.pending.get(onlyTimer(f.clock)).at, 13000);
    assert.equal(f.badge.title, view.DESCRIPTIONS[reason]);
  }
  f.clock.advance(1);
  assert.equal(f.badge.dataset.autoHidden, "true");
  for (const reason of ["transport_unavailable", "unreadable", "no_source"]) {
    f.clock.advance(2000);
    f.render("unavailable", reason);
    assert.equal(f.badge.dataset.autoHidden, "true");
    assert.equal(f.badge.dataset.phase, "unavailable");
    assert.equal(f.badge.title, view.DESCRIPTIONS[reason]);
    assert.equal(f.row.hidden, false);
    assert.equal(f.clock.pending.size, 0);
  }
});

test("a wall-clock rollback cannot reveal a red badge already hidden for its continuous red period", () => {
  const f = fixture();
  f.render("unavailable");
  f.clock.advance(13000);
  assert.equal(f.badge.dataset.autoHidden, "true");
  f.clock.jump(-60000);
  f.render("unavailable", "unreadable");
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.equal(f.clock.pending.size, 0);
  f.render("loading");
  assert.equal(f.badge.dataset.autoHidden, "false");
  f.render("unavailable");
  f.clock.advance(12999);
  assert.equal(f.badge.dataset.autoHidden, "false");
  f.clock.advance(1);
  assert.equal(f.badge.dataset.autoHidden, "true");
});

for (const phase of ["connecting", "loading", "active"]) {
  for (const elapsed of [5000, 13000]) {
    test(`${phase} restores immediately ${elapsed < 13000 ? "before" : "after"} red auto-hide and starts a fresh red countdown`, () => {
      const f = fixture();
      f.render("unavailable");
      f.clock.advance(elapsed);
      f.render(phase);
      assert.equal(f.badge.dataset.autoHidden, "false");
      assert.equal(f.badge.dataset.phase, phase);
      assert.equal(f.badge.textContent, view.LABELS[phase]);
      assert.equal(f.row.hidden, false);
      assert.equal(f.clock.pending.size, 0);
      f.clock.advance(40000);
      assert.equal(f.badge.dataset.autoHidden, "false", "Blue, yellow and green have no auto-hide timer");
      f.render("unavailable");
      assert.equal(f.badge.dataset.autoHidden, "false");
      f.clock.advance(12999);
      assert.equal(f.badge.dataset.autoHidden, "false");
      f.clock.advance(1);
      assert.equal(f.badge.dataset.autoHidden, "true");
    });
  }
}

test("a canceled callback cannot hide a recovered badge or shorten a later red period", () => {
  const f = fixture();
  f.render("unavailable");
  const oldTimer = onlyTimer(f.clock);
  f.clock.advance(3000);
  f.render("loading");
  const recovered = f.contentSnapshot();
  f.clock.fire(oldTimer);
  assert.equal(f.badge.dataset.autoHidden, "false");
  assert.deepEqual(f.contentSnapshot(), recovered);
  assert.equal(f.clock.pending.size, 0);
  f.clock.advance(2000);
  f.render("unavailable", "unreadable");
  const freshTimer = onlyTimer(f.clock);
  f.clock.advance(8000); // The first red period's original deadline.
  f.clock.fire(oldTimer);
  assert.equal(f.badge.dataset.autoHidden, "false");
  assert.equal(onlyTimer(f.clock), freshTimer, "Stale callback cannot replace or clear the fresh timer");
  f.clock.advance(4999);
  assert.equal(f.badge.dataset.autoHidden, "false");
  f.clock.advance(1);
  assert.equal(f.badge.dataset.autoHidden, "true");
});

test("early timer callbacks reschedule only the remaining elapsed-time deadline", () => {
  const f = fixture();
  f.render("unavailable");
  const original = onlyTimer(f.clock);
  f.clock.jump(7000);
  f.clock.fire(original);
  assert.equal(f.badge.dataset.autoHidden, "false");
  const next = onlyTimer(f.clock);
  assert.equal(f.clock.pending.get(next).delay, 6000);
  assert.equal(f.clock.pending.get(next).at, 13000);
  f.clock.jump(5999);
  f.clock.fire(next);
  assert.equal(f.badge.dataset.autoHidden, "false");
  assert.equal(f.clock.pending.get(onlyTimer(f.clock)).delay, 1);
  f.clock.fire(original);
  assert.equal(f.clock.pending.size, 1, "Superseded early callback cannot create an extra timer");
  f.clock.advance(1);
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.equal(f.clock.pending.size, 0);
});

test("a late callback hides immediately using elapsed time after suspension", () => {
  const f = fixture();
  f.render("unavailable");
  const timer = onlyTimer(f.clock);
  f.clock.jump(60000); // Browser callbacks do not run while the synthetic panel is suspended.
  f.clock.fire(timer);
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.equal(f.clock.pending.size, 0);
});

for (const elapsed of [13000, 45000]) {
  test(`a repeated render at ${elapsed} ms honors the deadline even before a delayed timer is delivered`, () => {
    const f = fixture();
    f.render("unavailable");
    const timer = onlyTimer(f.clock);
    f.clock.jump(elapsed);
    f.render("unavailable", "unreadable");
    assert.equal(f.badge.dataset.autoHidden, "true");
    assert.equal(f.clock.pending.size, 0);
    f.clock.fire(timer);
    assert.equal(f.badge.dataset.autoHidden, "true");
    assert.equal(f.clock.pending.size, 0);
  });
}

for (const elapsed of [5000, 13000]) {
  test(`dispose ${elapsed < 13000 ? "before" : "after"} auto-hide clears timers and makes updates and stale callbacks inert`, () => {
    const f = fixture();
    f.render("unavailable");
    const timer = onlyTimer(f.clock);
    f.clock.advance(elapsed);
    f.controller.dispose();
    f.controller.dispose();
    assert.equal(f.clock.pending.size, 0);
    f.clock.jump(60000);
    const hidden = f.badge.dataset.autoHidden;
    const content = f.contentSnapshot();
    f.clock.fire(timer);
    f.controller.update();
    assert.equal(f.badge.dataset.autoHidden, hidden);
    assert.deepEqual(f.contentSnapshot(), content);
    view.renderBadge(f.badge, f.description, { phase: "active", reason: "healthy" });
    f.controller.update();
    assert.equal(f.badge.dataset.autoHidden, hidden, "Disposed visibility controller performs no further writes");
    view.renderBadge(f.badge, f.description, { phase: "unavailable", reason: "no_source" });
    f.controller.update();
    assert.equal(f.clock.pending.size, 0, "Disposed controller never starts another countdown");
  });
}

test("not_tracking keeps its entire row hidden and cancels red timers without revealing the workspace", () => {
  for (const elapsed of [5000, 13000]) {
    const f = fixture();
    f.workspace.hidden = true;
    f.workspace.inert = true;
    const workspace = structuredClone(f.workspace);
    f.render("not_tracking", "not_tracking");
    assert.equal(f.row.hidden, true);
    assert.equal(f.clock.pending.size, 0);
    f.clock.advance(20000);
    f.render("unavailable");
    const timer = onlyTimer(f.clock);
    f.clock.advance(elapsed);
    f.render("not_tracking", "not_tracking");
    assert.equal(f.row.hidden, true);
    assert.equal(f.badge.dataset.autoHidden, "false");
    assert.equal(f.badge.textContent, "Not tracking");
    assert.equal(f.clock.pending.size, 0);
    f.clock.jump(60000);
    f.clock.fire(timer);
    assert.equal(f.row.hidden, true);
    assert.equal(f.badge.dataset.autoHidden, "false");
    assert.deepEqual(f.workspace, workspace);
  }
});

test("renderer validation supplies the fallback red phase without changing accessible content at auto-hide", () => {
  const f = fixture();
  f.render("unknown-phase", "unknown-reason");
  assert.equal(f.badge.dataset.phase, "unavailable");
  assert.equal(f.badge.textContent, "Capture unavailable");
  assert.equal(f.badge.title, view.DESCRIPTIONS.transport_unavailable);
  const content = f.contentSnapshot();
  f.clock.advance(13000);
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.deepEqual(f.contentSnapshot(), content);
});

test("auto-hide uses a visibility-only red selector and preserves the reserved badge row", () => {
  const rule = css.match(/\.capture-health-badge\[data-phase="unavailable"\]\[data-auto-hidden="true"\]\s*\{([^}]+)\}/);
  assert.ok(rule, "The hidden flag applies only to the unavailable badge");
  assert.match(rule[1], /^\s*visibility:\s*hidden;\s*$/);
  assert.equal((css.match(/data-auto-hidden/g) ?? []).length, 1, "No workspace/row selectors depend on presentation hiding");
  assert.match(css, /\.capture-health-row\s*\{[^}]*height:\s*20px;[^}]*margin-bottom:\s*6px;/);
  assert.match(css, /\.capture-health-badge\s*\{[^}]*height:\s*20px;/);
  assert.match(panelSource, /"pagehide",[\s\S]*?captureHealthBadgeVisibilityController\.dispose\(\)/);
});

test("hidden red retains its phase so tint and the actual capture interaction guard remain unchanged", () => {
  const f = fixture();
  const start = panelSource.indexOf("  function isCaptureInteractionLocked()");
  const end = panelSource.indexOf("\n  }", start);
  assert.ok(start >= 0 && end > start);
  const isLocked = vm.runInNewContext(`${panelSource.slice(start, end + 4)}\nisCaptureInteractionLocked;`, {
    captureHealthBadge: f.badge, trackerWorkspace: f.workspace,
    streamSnapshot: { resumed: true, activeSession: { streamId: "synthetic-stream" } },
    archivedReportsViewOpen: false,
  });
  const tintRule = css.match(/(\.tracker-workspace:has\([^{}]+)\{([^{}]+)\}/);
  assert.ok(tintRule);
  const tintPhases = [...tintRule[1].matchAll(/data-phase="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tintPhases, ["connecting", "loading"]);
  for (const phase of ["connecting", "loading", "active", "unavailable"]) {
    f.render(phase);
    assert.equal(isLocked(), phase === "connecting" || phase === "loading");
  }
  f.clock.advance(13000);
  assert.equal(f.badge.dataset.autoHidden, "true");
  assert.equal(f.badge.dataset.phase, "unavailable");
  assert.equal(isLocked(), false);
  assert.equal(tintPhases.includes(f.badge.dataset.phase), false);
  f.render("loading");
  assert.equal(f.badge.dataset.autoHidden, "false");
  assert.equal(isLocked(), true);
  assert.equal(tintPhases.includes(f.badge.dataset.phase), true);
});

test("the actual health subscription keeps polling after red auto-hide and renders recovery immediately", async () => {
  const f = fixture();
  let phase = "unavailable";
  let reason = "no_source";
  const messages = [];
  const callback = panelSource.match(/onChange:\s*(\(state\) => \{[\s\S]*?\n    \})/);
  assert.ok(callback);
  const onChange = vm.runInNewContext(`(${callback[1]})`, {
    captureHealthView: view, captureHealthBadge: f.badge, captureHealthDescription: f.description,
    captureHealthBadgeVisibilityController: f.controller, savedSnapshot: { busy: false },
    setWorkspaceBusy(busy) { assert.equal(busy, false); },
  });
  const controller = view.createCaptureHealthViewController({
    ...f.clock,
    protocol: { CHANNEL: "tiktok-live-tracker.capture-health", VERSION: 1 },
    runtime: { async sendMessage(message) {
      messages.push(message);
      return { ok: true, data: { streamId: message.streamId, phase, reason } };
    } },
    onChange,
  });
  try {
    controller.setSession("synthetic-stream");
    assert.equal(f.badge.dataset.phase, "connecting");
    assert.equal(f.badge.dataset.autoHidden, "false");
    await flush();
    assert.equal(f.badge.dataset.phase, "unavailable");
    await f.clock.advanceAsync(12999);
    assert.equal(f.badge.dataset.autoHidden, "false");
    await f.clock.advanceAsync(1);
    assert.equal(f.badge.dataset.autoHidden, "true");
    const countAtHide = messages.length;
    await f.clock.advanceAsync(7000);
    assert.ok(messages.length > countAtHide, "Presentation hiding does not stop health requests");
    assert.equal(f.badge.dataset.autoHidden, "true");
    reason = "unreadable";
    await f.clock.advanceAsync(2000);
    assert.equal(f.badge.title, view.DESCRIPTIONS.unreadable);
    assert.equal(f.badge.dataset.autoHidden, "true", "A newly published red reason stays hidden");
    phase = "active"; reason = "healthy";
    await f.clock.advanceAsync(2000);
    assert.equal(f.badge.dataset.phase, "active");
    assert.equal(f.badge.dataset.autoHidden, "false");
    controller.setSession(null);
    assert.equal(f.row.hidden, true);
    assert.equal(f.clock.pending.size, 0);
    const countAtEnd = messages.length;
    await f.clock.advanceAsync(30000);
    assert.equal(messages.length, countAtEnd);
  } finally {
    controller.dispose();
    f.controller.dispose();
  }
});
