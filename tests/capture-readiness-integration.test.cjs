const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require("../extension/shared/capture-health.js");
const reporterModule = require("../extension/capture/capture-health-reporter.js");
const viewModule = require("../extension/tagger/capture-health-view.js");

const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";
const EXTENSION_ID = "synthetic-readiness-extension";
const PANEL_URL = `chrome-extension://${EXTENSION_ID}/tagger/sidepanel.html`;
const DASHBOARD_URL = "https://shop.tiktok.com/streamer/live/product/dashboard";

const clone = (value) => JSON.parse(JSON.stringify(value));

async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function createClock() {
  let at = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => at,
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: at + delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    jump(milliseconds) { at += milliseconds; },
    async advance(milliseconds) {
      await settle();
      const target = at + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        at = Math.max(at, next[1].at);
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      at = target;
      await settle();
    },
  };
}

function createHarness() {
  const clock = createClock();
  const messages = [];
  const reporters = [];
  const panels = [];
  const failures = { reporter: false, panel: false };
  let epoch = 0;
  let store;

  function restartWorker() {
    const workerEpoch = ++epoch;
    store = protocol.createCaptureHealthStore({
      now: clock.now,
      createContextId: () => `synthetic-worker-${workerEpoch}`,
    });
    store.setSession(STREAM_ID);
  }
  restartWorker();

  function runtime(role, sender) {
    return {
      async sendMessage(message) {
        messages.push({ role, message: clone(message) });
        if (failures[role]) throw new Error("Synthetic disconnected transport");
        try {
          const request = protocol.parseRequest(message);
          const source = protocol.validateSender(sender, request.type, {
            extensionId: EXTENSION_ID,
            sidePanelUrl: PANEL_URL,
          });
          const data = request.type === "get" ? store.get(request.streamId)
            : request.type === "context" ? store.context(source)
              : store.pulse(source, request);
          return { ok: true, data: clone(data) };
        } catch (error) {
          return { ok: false, error: { code: error.code, message: error.message } };
        }
      },
    };
  }

  function openReporter(documentId, initialPhase = "loading") {
    const work = { phase: initialPhase, throwOnRead: false, reads: 0 };
    const sender = {
      id: EXTENSION_ID,
      frameId: 0,
      tab: { id: 9 },
      documentId,
      documentLifecycle: "active",
      url: DASHBOARD_URL,
    };
    const controller = reporterModule.createCaptureHealthReporter({
      runtime: runtime("reporter", sender),
      protocol,
      ...clock,
      getSample() {
        work.reads += 1;
        if (work.throwOnRead) throw new Error("The old dashboard probe must not run again");
        return { phase: work.phase, syntheticPrivateDetail: "must stay outside protocol" };
      },
    });
    reporters.push(controller);
    controller.start();
    return { controller, work };
  }

  function openPanel() {
    const states = [];
    const controller = viewModule.createCaptureHealthViewController({
      runtime: runtime("panel", { id: EXTENSION_ID, url: PANEL_URL }),
      protocol,
      ...clock,
      onChange(state) { states.push(clone(state)); },
    });
    panels.push(controller);
    controller.setSession(STREAM_ID);
    return { controller, states, latest: () => states.at(-1) };
  }

  return {
    clock, messages, failures, openReporter, openPanel, restartWorker,
    get: () => store.get(STREAM_ID),
    invalidateDocument: () => store.invalidateTab(9, { documentChanged: true }),
    pulses: () => messages.filter(({ message }) => message.type === "pulse").map(({ message }) => message),
    dispose() {
      reporters.forEach((reporter) => reporter.dispose());
      panels.forEach((panel) => panel.dispose());
    },
  };
}

test("real reporter, store and view remain loading until synthetic initial work actually finishes", async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const reporter = h.openReporter("initial-document");
  const panel = h.openPanel();
  await h.clock.advance(0);
  await panel.controller.refresh();
  assert.deepEqual(panel.latest(), { phase: "loading", reason: "initializing" });

  h.clock.jump(75_000);
  await h.clock.advance(0);
  assert.equal(h.get().phase, "loading", "Elapsed time must not declare capture ready or hide real loading.");
  assert.equal(panel.latest().phase, "loading");
  assert.equal(panel.states.some((state) => state.phase === "active"), false);

  reporter.work.phase = "ready";
  await h.clock.advance(reporterModule.CONTEXT_CHECK_MS);
  await panel.controller.refresh();
  assert.deepEqual(h.get(), { streamId: STREAM_ID, loadId: "initial-document", phase: "active", reason: "ready" });
  assert.deepEqual(panel.latest(), { phase: "active", reason: "ready" });
  assert.deepEqual(h.pulses().map((pulse) => pulse.sample), [{ phase: "loading" }, { phase: "ready" }]);
  for (const pulse of h.pulses()) {
    assert.equal(pulse.version, 2);
    assert.deepEqual(Object.keys(pulse.sample), ["phase"]);
  }
  assert.doesNotMatch(JSON.stringify(h.messages), /syntheticPrivateDetail|must stay outside protocol/);
});

test("ready survives throwing probes, transport failures and gaps, then republishes after worker renewal without resampling", async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const reporter = h.openReporter("retained-document", "ready");
  await h.clock.advance(0);
  const panel = h.openPanel();
  await settle();
  assert.equal(panel.latest().phase, "active");
  assert.equal(reporter.work.reads, 1);
  const initialPulse = h.pulses()[0];
  const readyIndex = panel.states.length - 1;
  reporter.work.throwOnRead = true;
  h.failures.reporter = true;
  h.failures.panel = true;
  h.clock.jump(3_600_000);
  await h.clock.advance(0);
  assert.equal(h.get().phase, "active");
  assert.equal(panel.latest().phase, "active");
  assert.equal(reporter.work.reads, 1, "A ready document is no longer probed.");
  assert.equal(h.pulses().length, 1, "Failed context checks do not send health pulses.");

  h.failures.reporter = false;
  h.failures.panel = false;
  h.restartWorker();
  await panel.controller.refresh();
  assert.equal(panel.latest().phase, "active", "The same panel retains ready while rediscovering the worker.");
  await h.clock.advance(reporterModule.CONTEXT_CHECK_MS);
  await panel.controller.refresh();
  assert.deepEqual(h.get(), { streamId: STREAM_ID, loadId: "retained-document", phase: "active", reason: "ready" });
  assert.equal(reporter.work.reads, 1);
  assert.equal(h.pulses().length, 2);
  assert.notEqual(h.pulses()[1].contextId, initialPulse.contextId);
  assert.deepEqual(h.pulses()[1].sample, { phase: "ready" });
  assert.ok(panel.states.slice(readyIndex).every((state) => state.phase === "active"));
});

test("reopening the panel reads an already-ready document without restarting its yellow loading phase", async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const reporter = h.openReporter("reopened-document", "ready");
  await h.clock.advance(0);
  const firstPanel = h.openPanel();
  await settle();
  assert.equal(firstPanel.latest().phase, "active");
  firstPanel.controller.dispose();
  reporter.work.throwOnRead = true;
  const pulseCount = h.pulses().length;

  const reopened = h.openPanel();
  await settle();
  assert.deepEqual(reopened.states.map((state) => state.phase), ["connecting", "active"],
    "Only the blue connection handshake precedes the first valid ready reply.");
  assert.equal(reopened.states.some((state) => state.phase === "loading"), false);
  assert.equal(h.pulses().length, pulseCount, "Opening a panel does not request a new readiness sample.");
  assert.equal(reporter.work.reads, 1);
});

test("an actual replacement document with a new reporter starts loading before its own real ready result", async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const oldReporter = h.openReporter("old-document", "ready");
  await h.clock.advance(0);
  const panel = h.openPanel();
  await settle();
  assert.equal(panel.latest().phase, "active");
  oldReporter.controller.dispose();
  h.invalidateDocument();
  await panel.controller.refresh();
  assert.equal(panel.latest().phase, "active", "Navigation alone is not a newly loaded document.");

  const replacement = h.openReporter("replacement-document", "loading");
  await h.clock.advance(0);
  await panel.controller.refresh();
  assert.deepEqual(h.get(), { streamId: STREAM_ID, loadId: "replacement-document", phase: "loading", reason: "initializing" });
  assert.deepEqual(panel.latest(), { phase: "loading", reason: "initializing" });
  assert.equal(replacement.work.reads, 1);
  replacement.work.phase = "ready";
  await h.clock.advance(reporterModule.CONTEXT_CHECK_MS);
  await panel.controller.refresh();
  assert.deepEqual(h.get(), { streamId: STREAM_ID, loadId: "replacement-document", phase: "active", reason: "ready" });
  assert.deepEqual(panel.latest(), { phase: "active", reason: "ready" });
  assert.deepEqual(h.pulses().map((pulse) => pulse.sample.phase), ["ready", "loading", "ready"]);
});
