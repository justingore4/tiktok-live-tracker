const assert = require("node:assert/strict");
const test = require("node:test");
const health = require("../extension/shared/capture-health.js");

const STREAM = "local-stream:11111111-1111-4111-8111-111111111111";
const NEXT_STREAM = "local-stream:22222222-2222-4222-8222-222222222222";
const SOURCE = Object.freeze({ tabId: 9, documentId: "document-one" });
const READY = Object.freeze({ phase: "ready" });
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
    pulse(sample = READY) {
      return store.pulse(SOURCE, { type: "pulse", ...context, sequence: sequence++, sampledAt: time, sample });
    },
    get() { return store.get(STREAM); },
  };
}

function expected(phase, reason, loadId = SOURCE.documentId, streamId = STREAM) {
  return { streamId, loadId, phase, reason };
}

test("startup readiness exposes the version-two narrow protocol and discovery timings", () => {
  assert.equal(health.CHANNEL, "tiktok-live-tracker.capture-health");
  assert.equal(health.VERSION, 2);
  assert.equal(health.POLL_MS, 2000);
  assert.equal(health.SOURCE_GRACE_MS, 10000);
  assert.equal(health.MESSAGE_MAX_AGE_MS, 3000);
  assert.ok(health.LOAD_ID_PATTERN.test(SOURCE.documentId));
  assert.equal(health.LOAD_ID_PATTERN.test("x".repeat(129)), false);
  assert.deepEqual(health.parseRequest(message("context")), { type: "context" });
  assert.deepEqual(health.parseRequest(message("get", { streamId: null })), { type: "get", streamId: null });
  assert.deepEqual(health.parseRequest(message("get", { streamId: STREAM })), { type: "get", streamId: STREAM });
  for (const phase of ["loading", "ready", "blank"]) {
    assert.deepEqual(health.parseRequest(message("pulse", {
      streamId: STREAM, contextId: "context", sequence: 0, sampledAt: 0, sample: { phase },
    })).sample, { phase });
  }
});

test("strict readiness messages reject legacy health fields, extra data and invalid sequences", () => {
  const valid = message("pulse", { streamId: STREAM, contextId: "context", sequence: 0, sampledAt: 0, sample: READY });
  const invalid = [
    null, [], {}, { ...valid, version: 1 }, { ...valid, version: 3 }, { ...valid, channel: "other" },
    message("context", { streamId: STREAM }), message("get", { streamId: "not-a-stream" }),
    { ...valid, rawOrders: [] }, { ...valid, loadId: "caller-selected-document" },
    { ...valid, sample: { phase: "ready", pending: 0 } },
    { ...valid, sample: { readable: true, pending: 0, inFlight: false, retrying: false, visible: true } },
    ...[null, undefined, true, "active", "healthy", "unavailable", "READY", 1].map((phase) => ({ ...valid, sample: { phase } })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((sequence) => ({ ...valid, sequence })),
    { ...valid, contextId: "" }, { ...valid, contextId: "a".repeat(161) },
    { ...valid, streamId: null }, { ...valid, sample: [] },
    ...[undefined, -1, 1.5, Infinity, "0"].map((sampledAt) => ({ ...valid, sampledAt })),
  ];
  for (const value of invalid) assert.throws(() => health.parseRequest(value), { code: "INVALID_HEALTH_MESSAGE" });
});

test("only the exact panel and current top-level dashboard document may use readiness", () => {
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

test("a single genuine ready sample activates immediately with the browser document identity", () => {
  const h = harness();
  assert.deepEqual(h.get(), expected("connecting", "awaiting_capture"));
  assert.deepEqual(h.pulse(), { accepted: true });
  assert.deepEqual(h.get(), expected("active", "ready"));
  assert.deepEqual(h.store.context(SOURCE), h.context);
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("loading never becomes ready from elapsed time and may legitimately exceed ten seconds", () => {
  const h = harness();
  h.pulse({ phase: "loading" });
  for (const at of [9999, 10000, 20000, 60000, 180001, 3_600_000]) {
    h.at(at);
    assert.deepEqual(h.get(), expected("loading", "initializing"));
    assert.deepEqual(h.store.context(SOURCE), h.context);
  }
  h.pulse();
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("readiness stays green through long gaps and later loading or blank samples", () => {
  const h = harness();
  h.pulse();
  for (const at of [20_001, 60_000, 180_001, 3_600_000]) {
    h.at(at);
    assert.deepEqual(h.get(), expected("active", "ready"));
    h.pulse({ phase: "loading" });
    h.pulse({ phase: "blank" });
    assert.deepEqual(h.get(), expected("active", "ready"));
  }
});

test("an explicit unavailable startup is blank immediately and can recover with a real ready sample", () => {
  const h = harness();
  h.pulse({ phase: "blank" });
  assert.deepEqual(h.get(), expected("blank", "unavailable"));
  h.pulse({ phase: "loading" });
  assert.deepEqual(h.get(), expected("loading", "initializing"));
  h.pulse();
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("no source becomes blank at ten seconds without repeated session reads resetting discovery", () => {
  const h = harness();
  h.store.setSession(NEXT_STREAM);
  for (const at of [0, 9999]) {
    h.at(at);
    h.store.setSession(NEXT_STREAM);
    assert.deepEqual(h.store.get(NEXT_STREAM), expected("connecting", "awaiting_capture", null, NEXT_STREAM));
  }
  h.at(10000);
  assert.deepEqual(h.store.get(NEXT_STREAM), expected("blank", "unavailable", null, NEXT_STREAM));
});

test("a document without its first pulse gets its own ten-second discovery grace and can recover", () => {
  const h = harness();
  h.store.setSession(NEXT_STREAM);
  h.at(5000);
  const context = h.store.context(SOURCE);
  h.at(14999);
  assert.deepEqual(h.store.context(SOURCE), context);
  assert.deepEqual(h.store.get(NEXT_STREAM), expected("connecting", "awaiting_capture", SOURCE.documentId, NEXT_STREAM));
  h.at(15000);
  assert.deepEqual(h.store.get(NEXT_STREAM), expected("blank", "unavailable", SOURCE.documentId, NEXT_STREAM));
  h.store.pulse(SOURCE, { type: "pulse", ...context, sequence: 0, sampledAt: 15000, sample: READY });
  assert.deepEqual(h.store.get(NEXT_STREAM), expected("active", "ready", SOURCE.documentId, NEXT_STREAM));
});

test("same-document context renewal and navigation invalidate authority without resetting readiness", () => {
  const h = harness();
  h.pulse();
  h.store.invalidateTab(SOURCE.tabId);
  assert.deepEqual(h.get(), expected("active", "ready"));
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  const context = h.store.context(SOURCE);
  assert.notEqual(context.contextId, h.context.contextId);
  assert.deepEqual(h.get(), expected("active", "ready"));
  h.store.pulse(SOURCE, { type: "pulse", ...context, sequence: 0, sampledAt: 0, sample: { phase: "loading" } });
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("a genuine new owner document resets its cycle only when the new document requests context", () => {
  const h = harness();
  h.pulse();
  h.store.invalidateTab(SOURCE.tabId, { documentChanged: true });
  h.at(100_000);
  assert.deepEqual(h.get(), expected("active", "ready"));
  assert.throws(() => h.store.context(SOURCE), { code: "STALE_HEALTH_CONTEXT" });
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  const replacement = { ...SOURCE, documentId: "replacement-document" };
  const context = h.store.context(replacement);
  assert.deepEqual(h.get(), expected("connecting", "awaiting_capture", replacement.documentId));
  h.store.pulse(replacement, { type: "pulse", ...context, sequence: 0, sampledAt: 100_000, sample: { phase: "loading" } });
  assert.deepEqual(h.get(), expected("loading", "initializing", replacement.documentId));
  h.store.pulse(replacement, { type: "pulse", ...context, sequence: 1, sampledAt: 100_000, sample: READY });
  assert.deepEqual(h.get(), expected("active", "ready", replacement.documentId));
});

test("new documents retire previous contexts even without a tab navigation signal", () => {
  const h = harness();
  h.pulse();
  const replacement = { ...SOURCE, documentId: "replacement-document" };
  const context = h.store.context(replacement);
  assert.notEqual(context.contextId, h.context.contextId);
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  assert.throws(() => h.store.context(SOURCE), { code: "STALE_HEALTH_CONTEXT" });
  assert.throws(() => h.store.pulse({ tabId: 88, documentId: replacement.documentId }, {
    type: "pulse", ...context, sequence: 0, sampledAt: 0, sample: READY,
  }), { code: "STALE_HEALTH_CONTEXT" });
  assert.deepEqual(h.get(), expected("connecting", "awaiting_capture", replacement.documentId));
});

test("secondary dashboards cannot turn the first source green or reset its ready result", () => {
  const h = harness();
  h.pulse({ phase: "loading" });
  const secondary = { tabId: 10, documentId: "secondary-document" };
  const context = h.store.context(secondary);
  h.store.pulse(secondary, { type: "pulse", ...context, sequence: 0, sampledAt: 0, sample: READY });
  assert.deepEqual(h.get(), expected("loading", "initializing"));
  h.pulse();
  h.store.context({ ...secondary, documentId: "new-secondary-document" });
  assert.deepEqual(h.get(), expected("active", "ready"));
  h.store.invalidateTab(secondary.tabId, { closed: true });
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("closing the owner preserves green until another dashboard explicitly acquires ownership", () => {
  const h = harness();
  h.pulse();
  const secondary = { tabId: 10, documentId: "secondary-document" };
  const secondaryContext = h.store.context(secondary);
  h.store.invalidateTab(SOURCE.tabId, { closed: true });
  assert.deepEqual(h.get(), expected("active", "ready"));
  assert.throws(() => h.store.context(SOURCE), { code: "STALE_HEALTH_CONTEXT" });
  h.store.pulse(secondary, { type: "pulse", ...secondaryContext, sequence: 0, sampledAt: 0, sample: READY });
  assert.deepEqual(h.get(), expected("active", "ready"), "unsolicited secondary pulse cannot reset the old load");
  const acquiredContext = h.store.context(secondary);
  assert.notEqual(acquiredContext.contextId, secondaryContext.contextId,
    "Ownership transfer requests a fresh ready result from the retained reporter.");
  assert.deepEqual(h.get(), expected("connecting", "awaiting_capture", secondary.documentId));
  assert.throws(() => h.store.pulse(secondary, {
    type: "pulse", ...secondaryContext, sequence: 1, sampledAt: 0, sample: READY,
  }), { code: "STALE_HEALTH_CONTEXT" });
  h.store.pulse(secondary, { type: "pulse", ...acquiredContext, sequence: 0, sampledAt: 0, sample: READY });
  assert.deepEqual(h.get(), expected("active", "ready", secondary.documentId));
});

test("new and ended streams clear their readiness latch and reject old stream correlation", () => {
  const h = harness();
  h.pulse();
  h.store.setSession(null);
  assert.deepEqual(h.get(), expected("not_tracking", "not_tracking", null, null));
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  assert.deepEqual(h.store.context(SOURCE), { streamId: null, contextId: null });
  h.store.setSession(NEXT_STREAM);
  assert.deepEqual(h.store.get(NEXT_STREAM), expected("connecting", "awaiting_capture", null, NEXT_STREAM));
  const context = h.store.context(SOURCE);
  assert.throws(() => h.pulse(), { code: "STALE_HEALTH_CONTEXT" });
  assert.deepEqual(h.get(), expected("connecting", "session_mismatch", SOURCE.documentId, NEXT_STREAM));
  h.store.pulse(SOURCE, { type: "pulse", ...context, sequence: 0, sampledAt: 0, sample: READY });
  assert.deepEqual(h.store.get(NEXT_STREAM), expected("active", "ready", SOURCE.documentId, NEXT_STREAM));
});

test("replayed or out-of-order sequences cannot turn a loading document ready", () => {
  const h = harness();
  h.pulse({ phase: "loading" });
  h.at(1000);
  assert.throws(() => h.store.pulse(SOURCE, {
    type: "pulse", ...h.context, sequence: 0, sampledAt: 1000, sample: READY,
  }), { code: "STALE_HEALTH_CONTEXT" });
  assert.deepEqual(h.get(), expected("loading", "initializing"));
  h.pulse();
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("stale, future and regressing sampled timestamps are rejected without mutating readiness", () => {
  const h = harness();
  h.pulse({ phase: "loading" });
  h.at(8000);
  for (const sampledAt of [0, 4999, 8001]) {
    assert.throws(() => h.store.pulse(SOURCE, {
      type: "pulse", ...h.context, sequence: 1, sampledAt, sample: READY,
    }), { code: "STALE_HEALTH_SAMPLE" });
  }
  assert.deepEqual(h.get(), expected("loading", "initializing"));
  h.store.pulse(SOURCE, { type: "pulse", ...h.context, sequence: 1, sampledAt: 6000, sample: { phase: "loading" } });
  assert.throws(() => h.store.pulse(SOURCE, {
    type: "pulse", ...h.context, sequence: 2, sampledAt: 5999, sample: READY,
  }), { code: "STALE_HEALTH_SAMPLE" });
  h.store.pulse(SOURCE, { type: "pulse", ...h.context, sequence: 2, sampledAt: 6000, sample: READY });
  assert.deepEqual(h.get(), expected("active", "ready"));
});

test("reopening reads keeps the document latch and never mutates caller objects", () => {
  const h = harness();
  const request = Object.freeze({ type: "pulse", ...h.context, sequence: 0, sampledAt: 0, sample: READY });
  const before = JSON.stringify(request);
  h.store.pulse(SOURCE, request);
  assert.equal(JSON.stringify(request), before);
  const result = h.get();
  assert.deepEqual(Object.keys(result).sort(), ["loadId", "phase", "reason", "streamId"]);
  result.phase = "blank";
  result.loadId = "caller-change";
  h.at(3_600_000);
  for (let read = 0; read < 5; read += 1) assert.deepEqual(h.get(), expected("active", "ready"));
});

test("source bounds, malformed identities and unrelated tab events cannot change readiness", () => {
  const h = harness();
  h.pulse();
  for (let index = 0; index < 31; index++) h.store.context({ tabId: 100 + index, documentId: `doc-${index}` });
  assert.throws(() => h.store.context({ tabId: 999, documentId: "too-many" }), { code: "HEALTH_SOURCE_LIMIT" });
  assert.throws(() => h.store.context({ tabId: 9, documentId: "doc", raw: "data" }), { code: "INVALID_HEALTH_SOURCE" });
  assert.throws(() => h.store.setSession("bad-session"), { code: "INVALID_HEALTH_SESSION" });
  assert.throws(() => h.store.get(undefined), { code: "INVALID_HEALTH_SESSION" });
  h.store.invalidateTab(999, { documentChanged: true });
  h.store.invalidateTab(998, { closed: true });
  assert.deepEqual(h.get(), expected("active", "ready"));
});
