const assert = require("node:assert/strict");
const test = require("node:test");
const view = require("../extension/tagger/capture-health-view.js");
const protocol = { CHANNEL: "tiktok-live-tracker.capture-health", VERSION: 2 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const good = (streamId, phase = "active", reason = "ready", loadId = "dashboard-a") =>
  ({ ok: true, data: { streamId, loadId, phase, reason } });

function fixture(send = async (message) => good(message.streamId)) {
  let clock = 0, nextId = 0;
  const timers = new Map(), states = [], messages = [], loads = [];
  const runtime = { sendMessage(message, callback) { messages.push(message); return send(message, callback); } };
  const controller = view.createCaptureHealthViewController({
    runtime, protocol, onChange: (value) => states.push(value), now: () => clock,
    onLoadChange: (value) => loads.push(value),
    setTimeoutFn(fn, delay) { timers.set(++nextId, { fn, at: clock + delay }); return nextId; },
    clearTimeoutFn(id) { timers.delete(id); },
  });
  async function advance(ms) {
    const target = clock + ms;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    clock = target; await flush();
  }
  return { controller, states, messages, loads, timers, runtime, advance, jump: (ms) => { clock += ms; } };
}

test("active badge tooltip and accessible description contain only the startup-ready sentence", () => {
  const badge = { textContent: "", dataset: {}, title: "" };
  const description = { textContent: "" };
  view.renderBadge(badge, description, { phase: "active", reason: "ready" });
  assert.equal(badge.textContent, "Capture active");
  assert.equal(badge.dataset.phase, "active");
  assert.equal(badge.title, "", "Do not show a second cursor-positioned native tooltip");
  assert.equal(description.textContent, "Capture setup is ready for this dashboard page load.");
});

test("inactive readiness never queries the worker", async () => {
  const f = fixture(); f.controller.setSession(null); await f.advance(20000);
  assert.deepEqual(f.states, [{ phase: "not_tracking", reason: "not_tracking" }]);
  assert.deepEqual(f.messages, []); assert.equal(f.timers.size, 0);
});

test("a panel opened on a ready document goes from Connecting to green without yellow or repeated announcements", async () => {
  const f = fixture(); f.controller.setSession("a"); await flush(); await f.advance(6000);
  assert.deepEqual(f.states.map((state) => state.phase), ["connecting", "active"]);
  assert.equal(f.messages.length, 4);
  assert.deepEqual(f.messages[0], { channel: protocol.CHANNEL, version: 2, type: "get", streamId: "a" });
  f.controller.setSession("a"); assert.equal(f.messages.length, 4);
  f.controller.setSession(null); assert.equal(f.states.at(-1).phase, "not_tracking"); assert.equal(f.timers.size, 0);
});

test("real initial work stays yellow without a timeout and can become blank then ready", async () => {
  let response = good("a", "loading", "initializing");
  const f = fixture(async () => response); f.controller.setSession("a"); await flush();
  await f.advance(60000); assert.equal(f.states.at(-1).phase, "loading");
  response = good("a", "blank", "unavailable"); await f.advance(2000); assert.equal(f.states.at(-1).phase, "blank");
  response = good("a"); await f.advance(2000); assert.equal(f.states.at(-1).phase, "active"); f.controller.dispose();
});

test("ready stays green for same-load work, failure, source closure and missing or malformed responses", async () => {
  let response = good("a"), fail = false;
  const f = fixture(async () => { if (fail) throw new Error("offline"); return response; });
  f.controller.setSession("a"); await flush();
  for (response of [good("a", "loading", "initializing"), good("a", "blank", "unavailable"),
    good("a", "connecting", "awaiting_capture", null), good("a", "blank", "unavailable", null), null]) {
    await f.advance(2000); assert.equal(f.states.at(-1).phase, "active");
  }
  fail = true; await f.advance(60000);
  assert.deepEqual(f.states.map((state) => state.phase), ["connecting", "active"]);
  assert.ok(f.messages.length > 20, "Discovery continues for future document loads"); f.controller.dispose();
});

test("a different nonnull load resets the startup cycle, and ending or changing stream clears the latch", async () => {
  let response = good("a");
  const f = fixture(async () => response); f.controller.setSession("a"); await flush();
  for (const [phase, reason] of [["connecting", "awaiting_capture"], ["loading", "initializing"], ["active", "ready"]]) {
    response = good("a", phase, reason, "dashboard-b"); await f.advance(2000); assert.equal(f.states.at(-1).phase, phase);
  }
  f.controller.setSession(null); assert.equal(f.states.at(-1).phase, "not_tracking");
  response = good("b", "loading", "initializing", "dashboard-b"); f.controller.setSession("b"); await flush();
  assert.equal(f.states.at(-1).phase, "loading"); f.controller.dispose();
});

test("initial transport errors become blank only after twenty seconds and can recover", async () => {
  let fail = true;
  const f = fixture(async ({ streamId }) => { if (fail) throw new Error("synthetic"); return good(streamId); });
  f.controller.setSession("a"); await flush(); await f.advance(19999); assert.equal(f.states.at(-1).phase, "connecting");
  await f.advance(1); assert.equal(f.states.at(-1).phase, "blank");
  fail = false; await f.advance(2000); assert.equal(f.states.at(-1).phase, "active"); f.controller.dispose();
});

test("a late retired-document response cannot resurrect the previous load or restart its readiness", async () => {
  let response = good("a");
  const f = fixture(async () => response); f.controller.setSession("a"); await flush();
  response = good("a", "loading", "initializing", "dashboard-b"); await f.advance(2000);
  response = good("a"); await f.advance(2000);
  assert.equal(f.states.at(-1).phase, "loading", "An old ready response cannot make the new document ready");
  response = good("a", "active", "ready", "dashboard-b"); await f.advance(2000);
  response = good("a", "connecting", "awaiting_capture", "dashboard-a"); await f.advance(2000);
  assert.equal(f.states.at(-1).phase, "active", "A retired load cannot reset the newer ready load");
  f.controller.dispose();
});

test("a transport error never invents yellow work after a blue or blank startup result", async () => {
  for (const phase of ["connecting", "blank"]) {
    let fail = false;
    const f = fixture(async () => {
      if (fail) throw new Error("offline");
      return good("a", phase, phase === "blank" ? "unavailable" : "awaiting_capture");
    });
    f.controller.setSession("a"); await flush(); fail = true; await f.advance(2000);
    assert.equal(f.states.at(-1).phase, phase);
    assert.ok(!f.states.some((state) => state.phase === "loading")); f.controller.dispose();
  }
});

test("never-resolving initial requests cannot overlap and eventually yield blank", async () => {
  const f = fixture(() => new Promise(() => {})); f.controller.setSession("a");
  await f.controller.refresh(); assert.equal(f.messages.length, 1);
  await f.advance(4000); assert.equal(f.states.at(-1).phase, "connecting");
  await f.advance(24000); assert.equal(f.states.at(-1).phase, "blank"); f.controller.dispose(); assert.equal(f.timers.size, 0);
});

test("old-session, disposed-panel and expired asynchronous replies cannot latch readiness", async () => {
  const deferred = [];
  const f = fixture((message) => new Promise((resolve) => deferred.push({ message, resolve })));
  f.controller.setSession("old"); f.controller.setSession("new");
  deferred[0].resolve(good("old")); await flush(); assert.equal(f.states.at(-1).phase, "connecting");
  deferred[1].resolve(good("new", "loading", "initializing")); await flush(); assert.equal(f.states.at(-1).phase, "loading");
  await f.advance(2000); f.controller.dispose(); const count = f.states.length;
  deferred[2].resolve(good("new")); await flush(); assert.equal(f.states.length, count); assert.equal(f.timers.size, 0);
  let resolve; const suspended = fixture(() => new Promise((done) => { resolve = done; }));
  suspended.controller.setSession("a"); suspended.jump(60000); resolve(good("a")); await flush();
  assert.ok(!suspended.states.some((state) => state.phase === "active")); suspended.controller.dispose();
});

test("legacy, malformed, mismatched-session and invalid-load readiness replies fail blank", async () => {
  for (const response of [null, { ok: false, error: { message: "private raw text" } }, good("old"),
    good("a", "anything"), good("a", "active", "anything"), good("a", "not_tracking", "not_tracking"),
    good("a", "active", "unavailable"), good("a", "loading", "ready"),
    good("a", "active", "ready", null), good("a", "active", "ready", ""), good("a", "active", "ready", "bad id"),
    { ok: true, data: { streamId: "a", phase: "active", reason: "ready" } },
    { ...good("a"), extra: true }, { ok: true, data: { ...good("a").data, extra: true } }]) {
    const f = fixture(async () => response); f.controller.setSession("a"); await flush(); await f.advance(20000);
    assert.equal(f.states.at(-1).phase, "blank"); assert.ok(!JSON.stringify(f.states).includes("private raw text")); f.controller.dispose();
  }
});

test("duplicate callback/promise completions and later callback errors cannot demote a ready result", async () => {
  let fail = false;
  const f = fixture((message, callback) => {
    if (fail) f.runtime.lastError = { message: "synthetic" };
    callback(good(message.streamId)); delete f.runtime.lastError;
    return Promise.resolve(good(message.streamId, "loading", "initializing", "ignored-duplicate"));
  });
  f.controller.setSession("a"); await flush(); fail = true; await f.advance(2000);
  assert.deepEqual(f.states.map((state) => state.phase), ["connecting", "active"]); f.controller.dispose();
});

test("validated document discovery notifies planning even when the badge phase does not change", async () => {
  let response = good("a", "loading", "initializing", null);
  const f = fixture(async () => response);
  f.controller.setSession("a"); await flush();
  assert.deepEqual(f.loads, [{ streamId: "a", loadId: null }]);
  response = good("a", "loading", "initializing", "first-document");
  await f.advance(2000);
  const phases = [...f.states];
  response = good("a", "loading", "initializing", "second-document");
  await f.advance(2000);
  assert.deepEqual(f.states, phases, "Same phase is not republished just to detect refresh");
  assert.deepEqual(f.loads, [
    { streamId: "a", loadId: null },
    { streamId: "a", loadId: "first-document" },
    { streamId: "a", loadId: "second-document" },
  ]);
  const documents = [...f.loads];
  for (response of [good("a", "loading", "initializing", null),
    good("a", "loading", "initializing", "second-document"),
    good("a", "active", "ready", "first-document"), good("wrong-stream"),
    good("a", "loading", "initializing", "invalid document id"), null]) {
    await f.advance(2000);
    assert.deepEqual(f.loads, documents, "Missing, repeated, retired or invalid identity is not a new load");
  }
  f.controller.setSession(null);
  assert.deepEqual(f.loads.at(-1), { streamId: null, loadId: null });
  f.controller.dispose();
});

test("stale, disposed and duplicate readiness replies do not publish a planning document change", async () => {
  const deferred = [];
  const f = fixture(() => new Promise(resolve => deferred.push(resolve)));
  f.controller.setSession("old"); f.controller.setSession("new");
  deferred[0](good("old")); await flush();
  assert.deepEqual(f.loads, [{ streamId: "old", loadId: null }, { streamId: "new", loadId: null }]);
  f.controller.dispose(); deferred[1](good("new")); await flush();
  assert.equal(f.loads.length, 2);
  const duplicate = fixture((message, callback) => {
    callback(good(message.streamId));
    return Promise.resolve(good(message.streamId, "loading", "initializing", "duplicate-document"));
  });
  duplicate.controller.setSession("a"); await flush();
  assert.deepEqual(duplicate.loads, [{ streamId: "a", loadId: null }, { streamId: "a", loadId: "dashboard-a" }]);
  duplicate.controller.dispose();
});
