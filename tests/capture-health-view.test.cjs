const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const view = require("../extension/tagger/capture-health-view.js");
const directory = path.join(__dirname, "..", "extension");
const protocol = { CHANNEL: "tiktok-live-tracker.capture-health", VERSION: 1 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const good = (streamId, phase = "active", reason = "healthy") => ({ ok: true, data: { streamId, phase, reason } });

function fixture(send = async (message) => good(message.streamId)) {
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  const states = [];
  const messages = [];
  const runtime = { sendMessage(message, callback) { messages.push(message); return send(message, callback); } };
  const controller = view.createCaptureHealthViewController({
    runtime, protocol, onChange: (value) => states.push(value), now: () => clock,
    setTimeoutFn(fn, delay) { timers.set(++nextId, { fn, at: clock + delay }); return nextId; },
    clearTimeoutFn(id) { timers.delete(id); },
  });
  async function advance(ms) {
    const target = clock + ms;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    clock = target;
    await flush();
  }
  return { controller, states, messages, timers, runtime, advance, jump: (ms) => { clock += ms; } };
}

test("capture badge retains its state labels and plain-text accessible explanations", () => {
  assert.deepEqual(view.LABELS, {
    not_tracking: "Not tracking", connecting: "Connecting", active: "Capture active",
    loading: "Loading", unavailable: "Capture unavailable",
  });
  const badge = { dataset: {}, textContent: "" };
  const detail = {};
  for (const [phase, label] of Object.entries(view.LABELS)) {
    view.renderBadge(badge, detail, { phase, reason: phase === "not_tracking" ? "not_tracking" : "backlog" });
    assert.equal(badge.textContent, label);
    assert.equal(badge.dataset.phase, phase);
    assert.equal(badge.title, detail.textContent);
    assert.ok(detail.textContent.length > 10);
  }
  view.renderBadge(badge, detail, { phase: "<script>", reason: "<img>" });
  assert.equal(badge.textContent, "Capture unavailable");
  assert.ok(!detail.textContent.includes("<img>"));
  view.renderBadge(badge, detail, { phase: "active", reason: "__proto__" });
  assert.equal(detail.textContent, view.DESCRIPTIONS.transport_unavailable);
});

test("the entire badge row stays hidden when not tracking and returns for every active state", () => {
  const row = { hidden: true };
  const badge = {
    dataset: {}, textContent: "Not tracking",
    closest(selector) { assert.equal(selector, ".capture-health-row"); return row; },
  };
  const description = {};
  view.renderBadge(badge, description, { phase: "not_tracking", reason: "not_tracking" });
  assert.equal(row.hidden, true);
  for (const phase of ["connecting", "active", "loading", "unavailable"]) {
    view.renderBadge(badge, description, { phase, reason: "backlog" });
    assert.equal(row.hidden, false, `${phase} remains visible`);
    assert.equal(badge.textContent, view.LABELS[phase]);
    view.renderBadge(badge, description, { phase: "not_tracking", reason: "not_tracking" });
    assert.equal(row.hidden, true, "Ending tracking hides the bubble and its row");
  }
});

test("inactive health does not query the worker or reveal a tracker workspace", async () => {
  const f = fixture();
  f.controller.setSession(null);
  await f.advance(20000);
  assert.deepEqual(f.states, [{ phase: "not_tracking", reason: "not_tracking" }]);
  assert.deepEqual(f.messages, []);
  assert.equal(f.timers.size, 0);
});

test("session starts Connecting then accepts validated health, with no repeated announcements", async () => {
  const f = fixture();
  f.controller.setSession("stream-a");
  assert.equal(f.states[0].phase, "connecting");
  await flush();
  assert.equal(f.states.at(-1).phase, "active");
  await f.advance(6000);
  assert.equal(f.states.length, 2);
  assert.equal(f.messages.length, 4);
  assert.deepEqual(f.messages[0], { channel: protocol.CHANNEL, version: 1, type: "get", streamId: "stream-a" });
  f.controller.setSession(null);
  assert.equal(f.states.at(-1).phase, "not_tracking");
  assert.equal(f.timers.size, 0);
});

test("health state and reason updates render Loading/unavailable and recover", async () => {
  let phase = "loading", reason = "backlog";
  const f = fixture(async ({ streamId }) => good(streamId, phase, reason));
  f.controller.setSession("a");
  await flush();
  assert.deepEqual(f.states.at(-1), { phase, reason });
  phase = "unavailable"; reason = "unreadable";
  await f.advance(2000);
  assert.deepEqual(f.states.at(-1), { phase, reason });
  phase = "active"; reason = "healthy";
  await f.advance(2000);
  assert.deepEqual(f.states.at(-1), { phase, reason });
  f.controller.dispose();
});

test("worker failures never leave green stuck and become unavailable after grace", async () => {
  let fail = false;
  const f = fixture(async ({ streamId }) => { if (fail) throw new Error("synthetic failure"); return good(streamId); });
  f.controller.setSession("a");
  await flush();
  fail = true;
  await f.advance(2000);
  assert.equal(f.states.at(-1).phase, "loading");
  await f.advance(10000);
  assert.equal(f.states.at(-1).phase, "loading", "Transport failures retain their twenty-second grace");
  await f.advance(9999);
  assert.equal(f.states.at(-1).phase, "loading");
  await f.advance(1);
  assert.equal(f.states.at(-1).phase, "unavailable");
  fail = false;
  await f.advance(2000);
  assert.equal(f.states.at(-1).phase, "active");
  f.controller.dispose();
});

test("initial connection timeout and a never-resolving worker do not overlap requests", async () => {
  const f = fixture(() => new Promise(() => {}));
  f.controller.setSession("a");
  await f.controller.refresh();
  assert.equal(f.messages.length, 1);
  await f.advance(4000);
  assert.equal(f.states.at(-1).phase, "connecting");
  await f.advance(24000);
  assert.equal(f.states.at(-1).phase, "unavailable");
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test("late responses from a previous session or a closed panel cannot change the badge", async () => {
  const deferred = [];
  const f = fixture((message) => new Promise((resolve) => deferred.push({ message, resolve })));
  f.controller.setSession("old");
  f.controller.setSession("new");
  deferred[0].resolve(good("old"));
  await flush();
  assert.equal(f.states.at(-1).phase, "connecting");
  deferred[1].resolve(good("new", "loading", "warming_up"));
  await flush();
  assert.equal(f.states.at(-1).phase, "loading");
  await f.advance(2000);
  f.controller.dispose();
  const count = f.states.length;
  deferred[2].resolve(good("new"));
  await flush();
  assert.equal(f.states.length, count);
  assert.equal(f.timers.size, 0);
});

test("a throttled timeout cannot accept an old green response after panel suspension", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  f.controller.setSession("a");
  f.jump(60000); // Time passes without running any browser timer callbacks.
  resolve(good("a"));
  await flush();
  assert.equal(f.states.at(-1).phase, "connecting");
  assert.ok(!f.states.some((state) => state.phase === "active"));
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test("malformed, mismatched-session and unknown health responses fail closed", async () => {
  for (const response of [null, { ok: false, error: { message: "private raw text" } },
    good("old"), good("a", "anything"), good("a", "active", "anything"),
    good("a", "not_tracking", "not_tracking"), { ...good("a"), extra: true },
    { ok: true, data: { ...good("a").data, extra: true } }]) {
    const f = fixture(async () => response);
    f.controller.setSession("a");
    await flush();
    assert.equal(f.states.at(-1).phase, "connecting");
    await f.advance(20000);
    assert.equal(f.states.at(-1).phase, "unavailable");
    assert.ok(!JSON.stringify(f.states).includes("private raw text"));
    f.controller.dispose();
  }
});

test("callback runtime errors are handled and repeated session renders do not restart polling", async () => {
  let fail = false;
  const f = fixture((message, callback) => {
    if (fail) f.runtime.lastError = { message: "synthetic" };
    callback(good(message.streamId));
    delete f.runtime.lastError;
  });
  f.controller.setSession("a");
  await flush();
  f.controller.setSession("a");
  assert.equal(f.messages.length, 1);
  fail = true;
  await f.advance(2000);
  assert.equal(f.states.at(-1).phase, "loading");
  f.controller.dispose();
});

test("the centered badge row is inside the tracker above Variation, slim, stable and absent from reports", () => {
  const html = fs.readFileSync(path.join(directory, "tagger/sidepanel.html"), "utf8");
  const css = fs.readFileSync(path.join(directory, "tagger/sidepanel.css"), "utf8");
  const js = fs.readFileSync(path.join(directory, "tagger/sidepanel.js"), "utf8");
  const row = css.match(/\.capture-health-row\s*\{([^}]+)\}/)[1];
  const badge = css.match(/\.capture-health-badge\s*\{([^}]+)\}/)[1];
  assert.match(html, /id="tracker-workspace"\s+class="tracker-workspace"\s+aria-busy="true"\s+inert\s+hidden\s*>\s*<div class="capture-health-row" hidden>/,
    "The badge inherits the workspace visibility instead of appearing on the Resume/End screen");
  assert.match(html, /<div class="capture-health-row" hidden>[\s\S]*?<\/div>\s*<section class="current-auction"/,
    "The badge remains immediately above Variation");
  assert.equal((html.match(/class="capture-health-row"/g) ?? []).length, 1);
  assert.match(html, /<div class="capture-health-row" hidden>/, "No gray badge flashes before session loading");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;/, "A hidden row occupies no layout space");
  assert.match(row, /justify-content:\s*center/);
  assert.match(row, /height:\s*20px/);
  assert.match(row, /margin-bottom:\s*6px/);
  assert.match(badge, /height:\s*20px/);
  assert.match(badge, /font-size:\s*10px/);
  assert.match(badge, /white-space:\s*nowrap/);
  assert.doesNotMatch(row + badge, /animation|transition|position:\s*absolute|visibility/);
  assert.match(html, /id="capture-health-badge"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-describedby="capture-health-description"/);
  assert.match(js, /captureHealthController\.setSession\(snapshot\.activeSession\?\.streamId \?\? null\)/);
  assert.match(js, /"pagehide",[\s\S]*?captureHealthController\.dispose\(\)/);
  assert.match(js, /appHeader\.hidden = activeAndResumed/);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, "report/report.html"), "utf8"), /capture-health/);
});

test("only Connecting and Loading have a tiny decorative spinner that respects reduced motion", () => {
  const css = fs.readFileSync(path.join(directory, "tagger/sidepanel.css"), "utf8");
  const selector = /\.capture-health-badge\[data-phase="connecting"\]::before,\s*\.capture-health-badge\[data-phase="loading"\]::before\s*\{([^}]+)\}/;
  const spinner = css.match(selector)?.[1];
  assert.ok(spinner);
  assert.match(spinner, /content:\s*"";/, "An empty CSS decoration adds nothing to the accessible label");
  assert.match(spinner, /box-sizing:\s*border-box;/, "The border fits inside the 10px wheel");
  assert.match(spinner, /flex:\s*0 0 10px;/);
  assert.match(spinner, /width:\s*10px;/);
  assert.match(spinner, /height:\s*10px;/);
  assert.match(spinner, /margin-right:\s*5px;/, "The wheel sits before the text inside the badge");
  assert.match(spinner, /border-right-color:\s*transparent;/);
  assert.match(spinner, /animation:\s*capture-health-spin 0\.8s linear infinite;/);
  assert.match(css, /@keyframes capture-health-spin\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.capture-health-badge\[data-phase="connecting"\]::before,\s*\.capture-health-badge\[data-phase="loading"\]::before\s*\{\s*animation:\s*none;/);
  assert.doesNotMatch(css, /\.capture-health-badge(?:\[data-phase="(?:active|unavailable|not_tracking)"\])?::before/,
    "Other badge states have no spinner");
});
