const assert = require("node:assert/strict");
const test = require("node:test");
const { createCaptureHealthReporter } = require("../extension/capture/capture-health-reporter.js");

const protocol = { CHANNEL: "tiktok-live-tracker.capture-health", VERSION: 2 };
const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const NEXT_STREAM = "local-stream:22222222-2222-4222-8222-222222222222";
const sample = { phase: "ready" };
const contextResponse = (streamId = STREAM, contextId = "context-one") => ({ ok: true, data: { streamId, contextId } });
const accepted = { ok: true, data: { accepted: true } };

async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness({ handler, getSample, timeout = 1000 } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const messages = [];
  let samples = 0;
  const runtime = {
    sendMessage(message, callback) {
      messages.push(message);
      return handler ? handler(message, callback) : Promise.resolve(message.type === "context" ? contextResponse() : accepted);
    },
  };
  const reporter = createCaptureHealthReporter({
    runtime, protocol, intervalMs: 5000, requestTimeoutMs: timeout,
    now: () => now,
    getSample(context) { samples++; return getSample ? getSample(context) : sample; },
    setTimeoutFn(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
  });
  return {
    reporter, messages, timers, runtime,
    jumpWallClock(ms) { now += ms; },
    get samples() { return samples; },
    async advance(ms) {
      const target = now + ms;
      await settle();
      while (true) {
        const next = [...timers].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await settle();
      }
      now = target; await settle();
    },
  };
}

test("readiness reporter sends only startup phase and stops sampling or pulsing after ready", async () => {
  const h = harness({ getSample: () => ({ ...sample, buyerName: "private", rawText: "do not send" }) });
  h.reporter.start(); h.reporter.start();
  await h.advance(0);
  assert.deepEqual(h.messages.map((message) => message.type), ["context", "pulse"]);
  assert.deepEqual(h.messages[1], { channel: protocol.CHANNEL, version: 2, type: "pulse", streamId: STREAM, contextId: "context-one", sequence: 1, sampledAt: 0, sample });
  await h.advance(4999); assert.equal(h.samples, 1);
  await h.advance(1); assert.equal(h.samples, 1);
  assert.deepEqual(h.messages.map(message => message.type), ["context", "pulse", "context"]);
  await h.advance(120000);
  assert.equal(h.samples, 1, "Later checks discover sessions; they do not measure ongoing health");
  assert.equal(h.messages.filter(message => message.type === "pulse").length, 1);
  h.reporter.dispose(); assert.equal(h.timers.size, 0);
});

test("no active stream skips the probe and later context changes use the new correlation ID", async () => {
  let active = false;
  const h = harness({ handler: (message) => Promise.resolve(message.type === "context" ? contextResponse(active ? NEXT_STREAM : null, active ? "context-two" : null) : accepted) });
  h.reporter.start(); await h.advance(0);
  assert.equal(h.samples, 0); assert.equal(h.messages.length, 1);
  active = true; await h.advance(5000);
  assert.equal(h.messages[2].streamId, NEXT_STREAM); assert.equal(h.messages[2].contextId, "context-two");
});

test("initial loading is sampled until ready and only phase changes are published", async () => {
  let phase = "loading";
  const h = harness({ getSample(context) {
    assert.equal(context.streamId, STREAM);
    return { phase };
  } });
  h.reporter.start(); await h.advance(0);
  assert.equal(h.messages.at(-1).sample.phase, "loading");
  await h.advance(5000);
  assert.equal(h.samples, 2);
  assert.equal(h.messages.filter(message => message.type === "pulse").length, 1);
  phase = "ready"; await h.advance(5000);
  assert.equal(h.messages.at(-1).sample.phase, "ready");
  phase = "blank"; await h.advance(15000);
  assert.equal(h.samples, 3, "Ready permanently stops this document's initialization checks");
  assert.equal(h.messages.filter(message => message.type === "pulse").length, 2);
  h.reporter.dispose();
});

test("a renewed worker context restores ready without resampling, but a new stream starts fresh", async () => {
  let streamId = STREAM;
  let contextId = "first-worker";
  const h = harness({
    handler: message => Promise.resolve(message.type === "context" ? contextResponse(streamId, contextId) : accepted),
    getSample: context => ({ phase: context.streamId === STREAM ? "ready" : "loading" }),
  });
  h.reporter.start(); await h.advance(0);
  contextId = "restarted-worker"; await h.advance(5000);
  assert.equal(h.samples, 1);
  assert.equal(h.messages.at(-1).sample.phase, "ready");
  assert.equal(h.messages.at(-1).contextId, contextId);
  streamId = NEXT_STREAM; contextId = "new-stream"; await h.advance(5000);
  assert.equal(h.samples, 2);
  assert.equal(h.messages.at(-1).sample.phase, "loading");
  assert.equal(h.messages.at(-1).streamId, NEXT_STREAM);
  h.reporter.dispose();
});

test("a new reporter for a refreshed document does not inherit ready from the old page", async () => {
  const oldPage = harness();
  oldPage.reporter.start(); await oldPage.advance(0); oldPage.reporter.dispose();
  const newPage = harness({ getSample: () => ({ phase: "loading" }) });
  newPage.reporter.start(); await newPage.advance(0);
  assert.equal(newPage.samples, 1);
  assert.equal(newPage.messages.at(-1).sample.phase, "loading");
  newPage.reporter.dispose();
});

test("late timed-out context callbacks cannot sample or send an old stream pulse", async () => {
  let late;
  let calls = 0;
  const h = harness({ handler(message, callback) {
    if (message.type === "context" && calls++ === 0) { late = callback; return; }
    return Promise.resolve(message.type === "context" ? contextResponse(NEXT_STREAM, "fresh-context") : accepted);
  } });
  h.reporter.start(); await h.advance(1000);
  late(contextResponse()); await settle();
  assert.equal(h.samples, 0); assert.equal(h.messages.length, 1);
  await h.advance(5000);
  assert.equal(h.samples, 1); assert.equal(h.messages[2].contextId, "fresh-context");
});

test("a stuck pulse times out without overlapping jobs and recovers on the next cycle", async () => {
  let pulses = 0;
  const h = harness({ handler(message) {
    if (message.type === "context") return Promise.resolve(contextResponse());
    if (++pulses === 1) return new Promise(() => {});
    return Promise.resolve(accepted);
  } });
  h.reporter.start(); await h.advance(0); h.reporter.start();
  await h.advance(999); assert.equal(h.messages.length, 2);
  await h.advance(1); assert.equal(h.messages.length, 2);
  await h.advance(5000); assert.equal(h.messages.length, 4); assert.equal(h.messages[3].sequence, 2);
});

test("malformed context and sample responses never become successful pulses", async () => {
  const invalidContexts = [
    { ok: true, data: { streamId: STREAM, contextId: null } },
    { ok: true, data: { streamId: "not-a-stream", contextId: "context" } },
    { ok: true, data: { streamId: STREAM, contextId: "private\ntext" } },
    { ok: true, data: { streamId: STREAM, contextId: "context", extra: true } },
    { ok: true, data: { streamId: STREAM, contextId: "context" }, extra: true },
    { ok: false, error: "unavailable" },
  ];
  for (const response of invalidContexts) {
    const h = harness({ handler: () => Promise.resolve(response) });
    h.reporter.start(); await h.advance(0); assert.equal(h.samples, 0); assert.equal(h.messages.length, 1); h.reporter.dispose();
  }
  for (const invalidSample of [null, {}, { phase: "active" }, { phase: "unavailable" }, { readable: true }]) {
    const h = harness({ getSample: () => invalidSample });
    h.reporter.start(); await h.advance(0); assert.equal(h.messages.length, 1); h.reporter.dispose();
  }
});

test("sample failures and rejected pulses are advisory and the next fresh cycle recovers", async () => {
  let fail = true;
  let rejectPulse = true;
  const h = harness({
    getSample() { if (fail) throw new Error("DOM read failed"); return { phase: "blank" }; },
    handler: (message) => Promise.resolve(message.type === "context" ? contextResponse() : rejectPulse ? { ok: true, data: { accepted: false } } : accepted),
  });
  h.reporter.start(); await h.advance(0); assert.equal(h.messages.length, 1);
  fail = false; await h.advance(5000); assert.equal(h.messages.at(-1).sample.phase, "blank");
  rejectPulse = false; await h.advance(5000); assert.equal(h.messages.at(-1).sequence, 2);
});

test("dispose cancels pending requests and ignores their eventual callbacks", async () => {
  let callback;
  const h = harness({ handler(message, done) { callback = done; } });
  h.reporter.start(); await h.advance(0); h.reporter.dispose();
  callback(contextResponse()); await h.advance(30000);
  assert.equal(h.samples, 0); assert.equal(h.messages.length, 1); assert.equal(h.timers.size, 0);
});

test("callback and Promise delivery of the same response settle only once", async () => {
  const h = harness({ handler(message, callback) {
    const response = message.type === "context" ? contextResponse() : accepted;
    callback(response); return Promise.resolve(response);
  } });
  h.reporter.start(); await h.advance(0);
  assert.equal(h.samples, 1); assert.equal(h.messages.length, 2); assert.equal(h.timers.size, 1);
});

test("runtime transport exceptions and lastError recover without interfering with capture", async () => {
  let throwTransport = true;
  const h = harness({ handler(message, callback) {
    if (throwTransport) throw new Error("invalidated extension context");
    callback(message.type === "context" ? contextResponse() : accepted);
  } });
  h.reporter.start(); await h.advance(0); assert.equal(h.samples, 0);
  throwTransport = false; h.runtime.lastError = { message: "transport failure" };
  await h.advance(5000); assert.equal(h.samples, 0);
  delete h.runtime.lastError; await h.advance(5000); assert.equal(h.samples, 1);
});

test("a throttled timeout cannot accept a context callback after its wall-clock deadline", async () => {
  let late;
  const h = harness({ handler(message, callback) { late = callback; } });
  h.reporter.start(); await h.advance(0);
  h.jumpWallClock(20_000); // No timers have run, as with a suspended/throttled page.
  late(contextResponse()); await settle();
  assert.equal(h.samples, 0);
  assert.equal(h.messages.length, 1);
  h.reporter.dispose();
});

test("a probe that outlives the freshness window cannot send an old sample as current", async () => {
  const h = harness({ getSample() { h.jumpWallClock(4000); return sample; } });
  h.reporter.start(); await h.advance(0);
  assert.equal(h.samples, 1);
  assert.equal(h.messages.length, 1);
  h.reporter.dispose();
});
