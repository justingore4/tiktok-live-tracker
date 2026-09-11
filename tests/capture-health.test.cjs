const assert = require("node:assert/strict");
const test = require("node:test");
const health = require("../extension/shared/capture-health.js");

const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const NEXT_STREAM = "local-stream:22222222-2222-4222-8222-222222222222";
const SOURCE = Object.freeze({ tabId: 9, documentId: "document-one" });
const CLEAN = Object.freeze({ readable: true, pending: 0, inFlight: false, retrying: false, visible: true });
const message = (type, fields = {}) => ({ channel: health.CHANNEL, version: health.VERSION, type, ...fields });

function harness() {
  let time = 0;
  const store = health.createCaptureHealthStore({ now: () => time, createContextId: () => "synthetic-epoch" });
  store.setSession(STREAM);
  const context = store.context(SOURCE);
  let sequence = 0;
  return {
    store, context,
    at(value) { time = value; },
    pulse(sample = CLEAN) {
      return store.pulse(SOURCE, { type: "pulse", ...context, sequence: sequence++, sampledAt: time, sample });
    },
    get() { return store.get(STREAM); },
  };
}

test("capture health protocol exposes the narrow channel and heartbeat/poll timings", () => {
  assert.equal(health.CHANNEL, "tiktok-live-tracker.capture-health");
  assert.equal(health.VERSION, 1);
  assert.equal(health.HEARTBEAT_MS, 5000);
  assert.equal(health.POLL_MS, 2000);
  assert.equal(health.SOURCE_GRACE_MS, 10000);
  assert.equal(health.UNREADABLE_UNAVAILABLE_MS, 10000);
  assert.equal(health.INITIAL_GRACE_MS, 20000);
  assert.equal(health.MESSAGE_MAX_AGE_MS, 3000);
  assert.equal(health.VISIBLE_FRESH_MS, 20000);
  assert.equal(health.VISIBLE_UNAVAILABLE_MS, 60000);
  assert.equal(health.HIDDEN_FRESH_MS, 90000);
  assert.equal(health.HIDDEN_UNAVAILABLE_MS, 180000);
  assert.equal(health.RETRY_UNAVAILABLE_MS, 60000);
  assert.equal(health.SOURCE_EXPIRY_MS, 180000);
  assert.deepEqual(health.parseRequest(message("context")), { type: "context" });
  assert.deepEqual(health.parseRequest(message("get", { streamId: null })), { type: "get", streamId: null });
  assert.deepEqual(health.parseRequest(message("get", { streamId: STREAM })), { type: "get", streamId: STREAM });
});

test("strict messages reject extra fields, raw data, invalid booleans, sizes and sequences", () => {
  const valid = message("pulse", { streamId: STREAM, contextId: "context", sequence: 0, sampledAt: 0, sample: CLEAN });
  assert.deepEqual(health.parseRequest(valid).sample, CLEAN);
  const invalid = [
    null, [], {}, { ...valid, version: 2 }, { ...valid, channel: "other" },
    message("context", { streamId: STREAM }), message("get", { streamId: "not-a-stream" }),
    { ...valid, rawOrders: [] }, { ...valid, sample: { ...CLEAN, bidPrice: 15 } },
    { ...valid, sample: { ...CLEAN, readable: 1 } },
    ...[-1, 1.5, 100001, Infinity, "1"].map((pending) => ({ ...valid, sample: { ...CLEAN, pending } })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((sequence) => ({ ...valid, sequence })),
    { ...valid, contextId: "" }, { ...valid, contextId: "a".repeat(161) },
    { ...valid, streamId: null }, { ...valid, sample: [] },
    ...[undefined, -1, 1.5, Infinity, "0"].map((sampledAt) => ({ ...valid, sampledAt })),
  ];
  for (const value of invalid) assert.throws(() => health.parseRequest(value), { code: "INVALID_HEALTH_MESSAGE" });
});

test("only the exact side panel may read health and top-level active dashboard documents may pulse", () => {
  const options = { extensionId: "extension-id", sidePanelUrl: "chrome-extension://extension-id/tagger/sidepanel.html" };
  const sender = { id: options.extensionId, frameId: 0, tab: { id: 9 }, documentId: "doc-one", documentLifecycle: "active", url: "https://shop.tiktok.com/streamer/live/product/dashboard?tool_tab=auction" };
  assert.deepEqual(health.validateSender(sender, "pulse", options), { tabId: 9, documentId: "doc-one" });
  assert.equal(health.validateSender({ id: options.extensionId, url: options.sidePanelUrl }, "get", options), null);
  for (const patch of [
    { id: "other" }, { frameId: 1 }, { tab: {} }, { tab: { id: -1 } },
    { documentId: undefined }, { documentId: "x".repeat(129) }, { documentLifecycle: "cached" },
    { url: "https://shop.tiktok.com/streamer/live/product/dashboard/extra" },
    { url: "https://shop.tiktok.com.evil.test/streamer/live/product/dashboard" },
    { url: "https://shop.tiktok.com/streamer/live/product/dashboard/" },
  ]) assert.throws(() => health.validateSender({ ...sender, ...patch }, "pulse", options), { code: "UNAUTHORIZED_HEALTH_SENDER" });
  for (const url of [sender.url, options.sidePanelUrl + "?other", "chrome-extension://extension-id/report/report.html"]) {
    assert.throws(() => health.validateSender({ id: options.extensionId, url }, "get", options), { code: "UNAUTHORIZED_HEALTH_SENDER" });
  }
});

test("context alone is never active; two clean pulses at least five seconds apart are required", () => {
  const h = harness();
  assert.deepEqual(h.get(), { streamId: STREAM, phase: "connecting", reason: "awaiting_capture" });
  h.pulse();
  assert.equal(h.get().reason, "warming_up");
  h.at(1000); h.pulse();
  h.at(5000);
  assert.notEqual(h.get().phase, "active", "time alone cannot substitute for a fresh second sample");
  h.pulse();
  assert.deepEqual(h.get(), { streamId: STREAM, phase: "active", reason: "healthy" });
  assert.deepEqual(h.store.context(SOURCE), h.context, "repeated context requests do not reset a healthy stream");
  assert.equal(h.get().phase, "active");
});

test("a quiet readable stream remains active without any sales, bids or storage writes", () => {
  const h = harness();
  for (let at = 0; at <= 120000; at += 5000) {
    h.at(at); h.pulse();
    assert.equal(h.get().phase, at === 0 ? "connecting" : "active");
  }
});

test("no dashboard source becomes unavailable at ten seconds without session reads resetting the wait", () => {
  const h = harness();
  h.store.setSession(NEXT_STREAM);
  assert.equal(h.store.get(NEXT_STREAM).phase, "connecting");
  h.at(9999);
  h.store.setSession(NEXT_STREAM);
  assert.equal(h.store.get(NEXT_STREAM).phase, "connecting");
  for (const at of [10000, 10001]) {
    h.at(at);
    assert.deepEqual(h.store.get(NEXT_STREAM), { streamId: NEXT_STREAM, phase: "unavailable", reason: "no_source" });
  }
});

test("a dashboard context with no first sample becomes unavailable at ten seconds and can still recover", () => {
  const h = harness();
  h.at(9999);
  assert.deepEqual(h.store.context(SOURCE), h.context, "Context requests do not extend the first-sample wait");
  assert.equal(h.get().phase, "connecting");
  for (const at of [10000, 10001]) {
    h.at(at);
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason: "no_source" });
  }
  assert.deepEqual(h.pulse(), { accepted: true }, "Red does not reject new samples");
  assert.equal(h.get().reason, "warming_up");
  h.at(15000); h.pulse(); assert.equal(h.get().phase, "connecting");
  h.at(15001); h.pulse(); assert.equal(h.get().phase, "active");
});

test("the first-sample grace remains relative to source creation, not session start", () => {
  const h = harness();
  h.store.setSession(NEXT_STREAM);
  h.at(5000); h.store.context(SOURCE);
  h.at(14999); assert.equal(h.store.get(NEXT_STREAM).phase, "connecting");
  h.at(15000); assert.equal(h.store.get(NEXT_STREAM).phase, "unavailable");
});

test("a received clean sample retains the separate twenty-second warm-up transition", () => {
  const h = harness();
  h.at(10000); h.pulse();
  for (const at of [10000, 19999, 20000]) {
    h.at(at);
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "connecting", reason: "warming_up" });
  }
  h.at(20001);
  assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason: "warming_up" });
  h.pulse(); assert.equal(h.get().phase, "active", "A second fresh clean sample still confirms health");
});

test("freshness degrades from Active to Loading to Unavailable without disappearing", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse();
  h.at(25000); assert.equal(h.get().phase, "active");
  h.at(25001); assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason: "stale" });
  h.at(64999); assert.equal(h.get().phase, "loading");
  h.at(65000); assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason: "stale" });
  h.pulse(); assert.equal(h.get().reason, "warming_up");
  h.at(70000); h.pulse(); assert.equal(h.get().phase, "active");
});

test("hidden dashboards allow background heartbeat throttling before stale/unavailable states", () => {
  const h = harness();
  const hidden = { ...CLEAN, visible: false };
  h.pulse(hidden); h.at(5000); h.pulse(hidden);
  h.at(95000); assert.equal(h.get().phase, "active");
  h.at(95001); assert.equal(h.get().phase, "loading");
  h.at(184999); assert.equal(h.get().phase, "loading");
  h.at(185000); assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason: "stale" });
});

test("an unreadable dashboard turns red at ten seconds from its first unreadable sample and recovers", () => {
  const h = harness();
  h.at(5000);
  h.pulse({ ...CLEAN, readable: false });
  assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason: "unreadable" });
  h.at(14999); h.pulse({ ...CLEAN, readable: false });
  assert.equal(h.get().phase, "loading");
  for (const at of [15000, 15001]) {
    h.at(at);
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason: "unreadable" });
  }
  h.at(16000); h.pulse(); assert.equal(h.get().reason, "warming_up");
  h.at(20999); h.pulse(); assert.notEqual(h.get().phase, "active");
  h.at(21000); h.pulse(); assert.equal(h.get().phase, "active");
});

for (const pending of [0, 1]) {
  test(`readability resets the ten-second unreadable timer even with ${pending} pending updates`, () => {
    const h = harness();
    h.pulse({ ...CLEAN, readable: false });
    h.at(9999); h.pulse({ ...CLEAN, pending });
    h.at(10000); h.pulse({ ...CLEAN, readable: false });
    h.at(19999); h.pulse({ ...CLEAN, readable: false });
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason: "unreadable" });
    h.at(20000);
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason: "unreadable" });
  });
}

for (const [reason, change] of [["retrying", { retrying: true }], ["backlog", { pending: 1 }], ["backlog", { inFlight: true }]]) {
  test(`${JSON.stringify(change)} prevents Active and becomes unavailable after sustained delay`, () => {
    const h = harness();
    for (let at = 0; at <= 55000; at += 5000) {
      h.at(at); h.pulse({ ...CLEAN, ...change });
      assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason });
    }
    h.at(59999); h.pulse({ ...CLEAN, ...change });
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason });
    h.at(60000);
    assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason });
    h.at(65000); h.pulse(); assert.equal(h.get().phase, "loading");
    h.at(70000); h.pulse(); assert.equal(h.get().phase, "active");
  });
}

test("replayed/out-of-order sequences cannot renew freshness or change health", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse(); h.at(26000);
  for (const sequence of [0, 1]) {
    assert.throws(() => h.store.pulse(SOURCE, { type: "pulse", ...h.context, sequence, sampledAt: 26000, sample: CLEAN }), { code: "STALE_HEALTH_CONTEXT" });
  }
  assert.equal(h.get().phase, "loading");
});

test("new streams and worker contexts reject stale correlation IDs and old sessions cannot turn the UI green", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse();
  h.store.setSession(null);
  assert.deepEqual(h.get(), { streamId: null, phase: "not_tracking", reason: "not_tracking" });
  assert.deepEqual(h.store.context(SOURCE), { streamId: null, contextId: null });
  h.store.setSession(NEXT_STREAM);
  assert.equal(h.store.get(STREAM).reason, "session_mismatch");
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  const newContext = h.store.context(SOURCE);
  assert.notEqual(newContext.contextId, h.context.contextId);
  const restarted = health.createCaptureHealthStore({ now: () => 0, createContextId: () => "new-worker-epoch" });
  restarted.setSession(STREAM);
  const restartedContext = restarted.context(SOURCE);
  assert.notEqual(restartedContext.contextId, h.context.contextId);
  assert.throws(() => restarted.pulse(SOURCE, { type: "pulse", ...h.context, sequence: 100, sampledAt: 0, sample: CLEAN }), { code: "STALE_HEALTH_CONTEXT" });
  assert.equal(restarted.get(STREAM).phase, "connecting");
});

test("replaced documents cannot reuse old correlation IDs or reacquire a retired context", () => {
  const h = harness();
  const replacement = { ...SOURCE, documentId: "replacement-document" };
  const current = h.store.context(replacement);
  assert.notEqual(current.contextId, h.context.contextId);
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  assert.throws(() => h.store.context(SOURCE), { code: "STALE_HEALTH_CONTEXT" });
  assert.throws(() => h.store.pulse({ tabId: 88, documentId: SOURCE.documentId }, { type: "pulse", ...h.context, sequence: 10, sampledAt: 0, sample: CLEAN }), { code: "STALE_HEALTH_CONTEXT" });
  assert.equal(h.get().phase, "connecting");
});

test("tab navigation invalidates the correlation ID but permits fresh same-document SPA context; closing retires it", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse();
  h.store.invalidateTab(SOURCE.tabId);
  assert.notEqual(h.get().phase, "active");
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  const context = h.store.context(SOURCE);
  assert.notEqual(context.contextId, h.context.contextId);
  h.store.invalidateTab(SOURCE.tabId, { closed: true });
  assert.throws(() => h.store.context(SOURCE), { code: "STALE_HEALTH_CONTEXT" });
  assert.notEqual(h.get().phase, "active");
});

test("multiple connected dashboards are conservative and expired ghost sources are pruned", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse();
  const second = { tabId: 10, documentId: "second-doc" };
  const context = h.store.context(second);
  assert.deepEqual(h.get(), { streamId: STREAM, phase: "unavailable", reason: "ambiguous_sources" });
  for (let at = 10000, sequence = 0; at <= 190000; at += 5000, sequence++) {
    h.at(at);
    h.store.pulse(second, { type: "pulse", ...context, sequence, sampledAt: at, sample: CLEAN });
  }
  assert.equal(h.get().phase, "active");
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
});

test("genuine document navigation retires the old document before a replacement sends context", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse();
  h.store.invalidateTab(SOURCE.tabId, { documentChanged: true });
  assert.throws(() => h.store.context(SOURCE), { code: "STALE_HEALTH_CONTEXT" });
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  const next = h.store.context({ ...SOURCE, documentId: "new-document" });
  assert.notEqual(next.contextId, h.context.contextId);
  assert.equal(h.get().phase, "connecting");
});

test("unrelated browser tab events do not change the capture-source status", () => {
  const h = harness();
  h.store.setSession(NEXT_STREAM);
  h.store.invalidateTab(999, { documentChanged: true });
  h.store.invalidateTab(998, { closed: true });
  assert.deepEqual(h.store.get(NEXT_STREAM), { streamId: NEXT_STREAM, phase: "connecting", reason: "awaiting_capture" });
});

test("delayed pulse bursts after throttling cannot immediately restore Active", () => {
  const h = harness();
  h.pulse(); h.at(5000); h.pulse();
  h.at(90000); h.pulse(); h.pulse(); h.pulse();
  assert.equal(h.get().reason, "warming_up");
  h.at(95000);
  assert.notEqual(h.get().phase, "active", "elapsed wall-clock time without a fresh later pulse is insufficient");
  h.pulse();
  assert.equal(h.get().phase, "active");
});

test("stale/future sample timestamps are rejected and accepted IPC delay does not extend freshness", () => {
  const h = harness();
  h.pulse();
  h.at(8000);
  for (const sampledAt of [0, 4999, 8001]) {
    assert.throws(() => h.store.pulse(SOURCE, { type: "pulse", ...h.context, sequence: 1, sampledAt, sample: CLEAN }), { code: "STALE_HEALTH_SAMPLE" });
  }
  h.store.pulse(SOURCE, { type: "pulse", ...h.context, sequence: 1, sampledAt: 5000, sample: CLEAN });
  assert.equal(h.get().phase, "active");
  h.at(26000);
  assert.deepEqual(h.get(), { streamId: STREAM, phase: "loading", reason: "stale" });
});

test("stored health samples are small copies; reading and updating never mutate caller data", () => {
  const h = harness();
  const request = Object.freeze({ type: "pulse", ...h.context, sequence: 0, sampledAt: 0, sample: CLEAN });
  const before = JSON.stringify(request);
  h.store.pulse(SOURCE, request);
  assert.equal(JSON.stringify(request), before);
  const result = h.get();
  assert.deepEqual(Object.keys(result).sort(), ["phase", "reason", "streamId"]);
  result.phase = "fake";
  assert.notEqual(h.get().phase, "fake");
});

test("source count is bounded and malformed store sources/session IDs fail safely", () => {
  const h = harness();
  for (let index = 0; index < 31; index++) h.store.context({ tabId: 100 + index, documentId: `doc-${index}` });
  assert.throws(() => h.store.context({ tabId: 999, documentId: "too-many" }), { code: "HEALTH_SOURCE_LIMIT" });
  assert.throws(() => h.store.context({ tabId: 9, documentId: "doc", raw: "data" }), { code: "INVALID_HEALTH_SOURCE" });
  assert.throws(() => h.store.setSession("bad-session"), { code: "INVALID_HEALTH_SESSION" });
  assert.throws(() => h.store.get(undefined), { code: "INVALID_HEALTH_SESSION" });
});
