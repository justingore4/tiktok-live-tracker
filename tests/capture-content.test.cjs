const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const parser = require("../extension/shared/sale-parser.js");
const candidateLocator = require(
  "../extension/capture/sale-candidate-locator.js",
);
const captureEventRegistry = require(
  "../extension/capture/capture-event-registry.js",
);
const contentSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "capture", "content.js"),
  "utf8",
);

const DASHBOARD_ORIGIN = "https://shop.tiktok.com";
const DASHBOARD_PATH = "/streamer/live/event/dashboard";

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.value = value;
    this.parentElement = null;
    this.parentNode = null;
  }

  get textContent() {
    return this.value;
  }

  set textContent(value) {
    this.value = value;
  }
}

class FakeElement {
  constructor({ dataTid = null, name = "element", ownText = "" } = {}) {
    this.nodeType = 1;
    this.dataTid = dataTid;
    this.name = name;
    this.ownText = ownText;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.onQuery = null;
  }

  append(...nodes) {
    nodes.forEach((node) => {
      if (node.parentNode?.children) {
        node.parentNode.children = node.parentNode.children.filter(
          (child) => child !== node,
        );
      }

      node.parentElement = this;
      node.parentNode = this;
      this.children.push(node);
    });

    return this;
  }

  matches(selector) {
    assert.equal(selector, candidateLocator.PAYMENT_TAG_SELECTOR);
    return this.dataTid === "m4b_tag";
  }

  querySelectorAll(selector) {
    assert.equal(selector, candidateLocator.PAYMENT_TAG_SELECTOR);
    this.onQuery?.(selector);
    const matches = [];

    function visit(node) {
      if (!(node instanceof FakeElement)) {
        return;
      }

      if (node.matches(selector)) {
        matches.push(node);
      }

      node.children.forEach(visit);
    }

    this.children.forEach(visit);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(candidate) {
    let node = candidate;
    const visited = new Set();

    while (node) {
      if (node === this) {
        return true;
      }

      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      node = node.parentNode;
    }

    return false;
  }

  get textContent() {
    return `${this.ownText}${this.children
      .map((child) => child.textContent)
      .join("")}`;
  }
}

function createBody(name = "body") {
  return new FakeElement({ name });
}

function createSaleRow(text) {
  const paymentComplete = /\bPayment\s+complete\b/i.test(text);
  const status = paymentComplete ? "Payment complete" : "Awaiting payment";
  const summaryValue = text
    .replace(/\bPayment\s+complete\b/gi, "")
    .replace(/\bAwaiting\s+payment\b/gi, "")
    .trim();
  const row = new FakeElement({ name: "sale-row" });
  const summary = new FakeElement({ name: "sale-summary" });
  const summaryText = new FakeText(`${summaryValue} `);
  const statusTag = new FakeElement({
    dataTid: "m4b_tag",
    name: "payment-tag",
  });
  const statusText = new FakeText(status);

  summary.append(summaryText);
  statusTag.append(statusText);
  row.append(summary, statusTag);

  return { row, statusTag, statusText, summary, summaryText };
}

function setSaleSummary(sale, text) {
  sale.summaryText.textContent = `${text.trim()} `;
}

function setPaymentText(sale, text) {
  sale.statusText.textContent = text;
}

function createEventTarget(calls, prefix) {
  const listeners = new Map();

  function addEventListener(type, callback) {
    const callbacks = listeners.get(type) || [];
    callbacks.push(callback);
    listeners.set(type, callbacks);
    calls.push(`${prefix}:add-listener:${type}`);
  }

  function removeEventListener(type, callback) {
    const callbacks = listeners.get(type) || [];
    listeners.set(
      type,
      callbacks.filter((candidate) => candidate !== callback),
    );
    calls.push(`${prefix}:remove-listener:${type}`);
  }

  function dispatch(type) {
    calls.push(`${prefix}:dispatch:${type}`);
    [...(listeners.get(type) || [])].forEach((callback) =>
      callback({ type }),
    );
  }

  return {
    addEventListener,
    dispatch,
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    removeEventListener,
  };
}

function createHarness({
  origin = DASHBOARD_ORIGIN,
  pathname = DASHBOARD_PATH,
  body = createBody(),
  locatorAvailable = true,
  registryAvailable = true,
  schedulerAvailable = true,
  rows = [],
  scanOnRequest = false,
  schedulerCreateFailures = 0,
  bodyObserveFailures = 0,
  schedulerRunNowFailures = 0,
  schedulerRequestFailures = 0,
  schedulerDisposeFailures = 0,
  bodyDisconnectFailures = 0,
  autoRun = true,
} = {}) {
  const calls = [];
  const infos = [];
  const warnings = [];
  const errors = [];
  const observerInstances = [];
  const schedulerSessions = [];
  const documentElement = { name: "documentElement" };
  const location = { origin, pathname };
  const intervals = new Map();
  const windowEvents = createEventTarget(calls, "window");
  const documentEvents = createEventTarget(calls, "document");
  let currentBody = body;
  let currentRows = rows;
  let bodyQueryCount = 0;
  let documentQueryCount = 0;
  let nextIntervalId = 1;
  let nextTimeoutId = 1000;
  let schedulerCreateCount = 0;
  let remainingSchedulerCreateFailures = schedulerCreateFailures;
  let remainingBodyObserveFailures = bodyObserveFailures;
  let remainingSchedulerRunNowFailures = schedulerRunNowFailures;
  let remainingSchedulerRequestFailures = schedulerRequestFailures;
  let remainingSchedulerDisposeFailures = schedulerDisposeFailures;
  let remainingBodyDisconnectFailures = bodyDisconnectFailures;

  function mountRowsOnCurrentBody() {
    if (!(currentBody instanceof FakeElement)) {
      return;
    }

    currentBody.onQuery = () => {
      bodyQueryCount += 1;
      calls.push("body:query");
    };
    currentRows.forEach(({ row }) => currentBody.append(row));
  }

  mountRowsOnCurrentBody();

  const schedulerModule = schedulerAvailable
    ? {
        createCaptureScheduler(options) {
          schedulerCreateCount += 1;
          calls.push("scheduler:create");

          if (remainingSchedulerCreateFailures > 0) {
            remainingSchedulerCreateFailures -= 1;
            throw new Error("scheduler creation failed");
          }

          const session = {
            id: schedulerSessions.length + 1,
            options,
            requestCount: 0,
            runNowCount: 0,
            disposeCount: 0,
            disposed: false,
            request() {
              session.requestCount += 1;
              calls.push(`scheduler:${session.id}:request`);

              if (remainingSchedulerRequestFailures > 0) {
                remainingSchedulerRequestFailures -= 1;
                throw new Error("scheduler request failed");
              }

              if (session.disposed) {
                return false;
              }

              if (scanOnRequest) {
                options.scan();
              }

              return true;
            },
            runNow() {
              session.runNowCount += 1;
              calls.push(`scheduler:${session.id}:run-now`);

              if (remainingSchedulerRunNowFailures > 0) {
                remainingSchedulerRunNowFailures -= 1;
                throw new Error("scheduler initial scan failed");
              }

              options.scan();
              return true;
            },
            dispose() {
              session.disposeCount += 1;
              session.disposed = true;
              calls.push(`scheduler:${session.id}:dispose`);

              if (remainingSchedulerDisposeFailures > 0) {
                remainingSchedulerDisposeFailures -= 1;
                throw new Error("scheduler disposal failed");
              }

              return session.disposeCount === 1;
            },
          };

          schedulerSessions.push(session);
          return session;
        },
      }
    : undefined;

  class FakeMutationObserver {
    constructor(callback) {
      this.id = observerInstances.length + 1;
      this.callback = callback;
      this.observeCalls = [];
      this.disconnectCount = 0;
      this.connected = false;
      observerInstances.push(this);
      calls.push(`observer:${this.id}:create`);
    }

    observe(target, options) {
      this.observeCalls.push({ target, options });
      this.target = target;
      calls.push(`observer:${this.id}:observe`);

      if (target !== documentElement && remainingBodyObserveFailures > 0) {
        remainingBodyObserveFailures -= 1;
        throw new Error("capture observer failed to observe body");
      }

      this.connected = true;
    }

    disconnect() {
      this.disconnectCount += 1;
      this.connected = false;
      calls.push(`observer:${this.id}:disconnect`);

      if (this.target !== documentElement && remainingBodyDisconnectFailures > 0) {
        remainingBodyDisconnectFailures -= 1;
        throw new Error("capture observer failed to disconnect");
      }
    }

    trigger(records = [{ type: "childList" }]) {
      return this.callback(records, this);
    }
  }

  const document = {
    documentElement,
    get body() {
      return currentBody;
    },
    querySelectorAll(selector) {
      documentQueryCount += 1;
      calls.push("document:query");
      assert.equal(selector, candidateLocator.PAYMENT_TAG_SELECTOR);
      return [];
    },
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
  };

  const context = {
    TikTokLiveTrackerSaleParser: parser,
    TikTokLiveTrackerSaleCandidateLocator: locatorAvailable
      ? candidateLocator
      : undefined,
    TikTokLiveTrackerCaptureEventRegistry: registryAvailable
      ? captureEventRegistry
      : undefined,
    TikTokLiveTrackerCaptureScheduler: schedulerModule,
    location,
    document,
    MutationObserver: FakeMutationObserver,
    setTimeout() {
      const timerId = nextTimeoutId;
      nextTimeoutId += 1;
      return timerId;
    },
    clearTimeout() {},
    setInterval(callback, delayMs) {
      const intervalId = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(intervalId, { callback, delayMs });
      calls.push(`window:set-interval:${delayMs}`);
      return intervalId;
    },
    clearInterval(intervalId) {
      intervals.delete(intervalId);
      calls.push(`window:clear-interval:${intervalId}`);
    },
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    console: {
      info(...args) {
        infos.push(args);
      },
      warn(...args) {
        warnings.push(args);
      },
      error(...args) {
        errors.push(args);
      },
    },
  };
  context.window = context;
  const vmContext = vm.createContext(context);

  function runContent() {
    vm.runInContext(contentSource, vmContext, {
      filename: "extension/capture/content.js",
    });
  }

  function observersForTarget(target) {
    return observerInstances.filter((observer) =>
      observer.observeCalls.some((call) => call.target === target),
    );
  }

  const harness = {
    calls,
    documentElement,
    errors,
    infos,
    intervals,
    location,
    observerInstances,
    schedulerSessions,
    warnings,
    completedSaleLogs() {
      return infos.filter(
        ([message]) =>
          message === "[TikTok Live Tracker] Completed sale detected",
      );
    },
    currentBody() {
      return currentBody;
    },
    captureObservers() {
      return observerInstances.filter(
        (observer) =>
          observer.observeCalls.length > 0 &&
          observer.observeCalls.some((call) => call.target !== documentElement),
      );
    },
    dispatchDocument(type) {
      documentEvents.dispatch(type);
    },
    dispatchWindow(type) {
      windowEvents.dispatch(type);
    },
    lifecycleObservers() {
      return observersForTarget(documentElement);
    },
    listenerCount(target, type) {
      return target === "window"
        ? windowEvents.listenerCount(type)
        : documentEvents.listenerCount(type);
    },
    runContent,
    setBody(nextBody) {
      currentBody = nextBody;
      mountRowsOnCurrentBody();
    },
    setOrigin(nextOrigin) {
      location.origin = nextOrigin;
    },
    setPathname(nextPathname) {
      location.pathname = nextPathname;
    },
    setRows(nextRows) {
      currentRows = nextRows;
      mountRowsOnCurrentBody();
    },
    tickIntervals() {
      [...intervals.values()].forEach(({ callback }) => callback());
    },
    get queryCount() {
      return bodyQueryCount;
    },
    get bodyQueryCount() {
      return bodyQueryCount;
    },
    get documentQueryCount() {
      return documentQueryCount;
    },
    get schedulerCreateCount() {
      return schedulerCreateCount;
    },
  };

  if (autoRun) {
    runContent();
  }

  return harness;
}

function latestCaptureObserver(harness) {
  return harness.captureObservers().at(-1);
}

test("requires the capture scheduler before installing lifecycle watchers", () => {
  const harness = createHarness({ schedulerAvailable: false });

  assert.equal(harness.schedulerCreateCount, 0);
  assert.equal(harness.observerInstances.length, 0);
  assert.equal(harness.intervals.size, 0);
  assert.deepEqual(harness.errors, [
    ["[TikTok Live Tracker] Capture scheduler failed to load."],
  ]);
});

test("fails closed when the sale candidate locator is unavailable", () => {
  const harness = createHarness({ locatorAvailable: false });

  assert.equal(harness.schedulerCreateCount, 0);
  assert.equal(harness.observerInstances.length, 0);
  assert.equal(harness.intervals.size, 0);
  assert.deepEqual(harness.errors, [
    ["[TikTok Live Tracker] Sale candidate locator failed to load."],
  ]);
});

test("fails closed when the capture event registry is unavailable", () => {
  const harness = createHarness({ registryAvailable: false });

  assert.equal(harness.schedulerCreateCount, 0);
  assert.equal(harness.observerInstances.length, 0);
  assert.equal(harness.intervals.size, 0);
  assert.deepEqual(harness.errors, [
    ["[TikTok Live Tracker] Capture event registry failed to load."],
  ]);
});

test("stays dormant outside the exact dashboard path", () => {
  const harness = createHarness({ pathname: `${DASHBOARD_PATH}/history` });

  assert.equal(harness.schedulerSessions.length, 0);
  assert.equal(harness.captureObservers().length, 0);
  assert.equal(harness.queryCount, 0);
  assert.equal(harness.lifecycleObservers().length, 1);
  assert.equal(harness.intervals.size, 1);
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.completedSaleLogs().length, 0);
});

test("does not install lifecycle monitoring on another origin", () => {
  const harness = createHarness({ origin: "https://seller.example.com" });

  assert.equal(harness.schedulerSessions.length, 0);
  assert.equal(harness.observerInstances.length, 0);
  assert.equal(harness.intervals.size, 0);
  assert.equal(harness.queryCount, 0);
  assert.deepEqual(harness.errors, []);
});

test("starts one capture session on the exact dashboard and installs lifecycle signals", () => {
  const harness = createHarness();
  const [session] = harness.schedulerSessions;
  const [captureObserver] = harness.captureObservers();
  const [lifecycleObserver] = harness.lifecycleObservers();

  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(session.runNowCount, 1);
  assert.equal(harness.bodyQueryCount, 1);
  assert.equal(harness.documentQueryCount, 0);
  assert.equal(captureObserver.observeCalls[0].target, harness.currentBody());
  assert.deepEqual(
    JSON.parse(JSON.stringify(captureObserver.observeCalls[0].options)),
    { childList: true, subtree: true, characterData: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(lifecycleObserver.observeCalls[0].options)),
    { childList: true },
  );
  assert.ok(
    harness.calls.indexOf(`observer:${captureObserver.id}:observe`) <
      harness.calls.indexOf("scheduler:1:run-now"),
  );
  assert.equal(session.options.quietDelayMs, 150);
  assert.equal(session.options.maxWaitMs, 1000);
  assert.equal(typeof session.options.setTimeoutFn, "function");
  assert.equal(typeof session.options.clearTimeoutFn, "function");
  assert.deepEqual(
    [...harness.intervals.values()].map(({ delayMs }) => delayMs),
    [250],
  );
  assert.equal(harness.listenerCount("window", "popstate"), 1);
  assert.equal(harness.listenerCount("window", "hashchange"), 1);
  assert.equal(harness.listenerCount("window", "pageshow"), 1);
  assert.equal(harness.listenerCount("document", "visibilitychange"), 1);
});

test("requires the exact completed-payment badge text before emitting a sale", () => {
  const sale = createSaleRow(
    "Example Buyer has won: $48.00 Variation: #250 Payment complete",
  );
  setPaymentText(sale, "Payment complete now");
  const harness = createHarness({ rows: [sale], scanOnRequest: true });
  const captureObserver = latestCaptureObserver(harness);
  const [session] = harness.schedulerSessions;

  assert.equal(harness.completedSaleLogs().length, 0);
  assert.equal(session.requestCount, 0);
  assert.equal(harness.bodyQueryCount, 1);

  setPaymentText(sale, "Payment complete");
  captureObserver.trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  assert.equal(session.requestCount, 1);
  assert.equal(harness.bodyQueryCount, 2);

  assert.equal(harness.completedSaleLogs().length, 1);
});

test("rechecks a badge when removing text makes payment complete exact", () => {
  const sale = createSaleRow(
    "Example Buyer has won: $48.00 Variation: #250 Payment complete",
  );
  const suffix = new FakeText(" now");
  sale.statusTag.append(suffix);
  const harness = createHarness({ rows: [sale], scanOnRequest: true });
  const captureObserver = latestCaptureObserver(harness);
  const [session] = harness.schedulerSessions;

  assert.equal(harness.completedSaleLogs().length, 0);

  sale.statusTag.children = sale.statusTag.children.filter(
    (child) => child !== suffix,
  );
  suffix.parentElement = null;
  suffix.parentNode = null;
  captureObserver.trigger([
    {
      type: "childList",
      target: sale.statusTag,
      addedNodes: [],
      removedNodes: [suffix],
    },
  ]);

  assert.equal(session.requestCount, 1);
  assert.equal(harness.completedSaleLogs().length, 1);
});

test("ignores unrelated dashboard mutations without scheduling or rescanning", () => {
  const harness = createHarness({ scanOnRequest: true });
  const [session] = harness.schedulerSessions;
  const captureObserver = latestCaptureObserver(harness);
  const unrelated = new FakeElement({ name: "viewer-count" });
  harness.currentBody().append(unrelated);

  const queryCountBeforeMutation = harness.bodyQueryCount;
  captureObserver.trigger([
    {
      type: "childList",
      target: harness.currentBody(),
      addedNodes: [unrelated],
      removedNodes: [],
    },
  ]);

  assert.equal(session.requestCount, 0);
  assert.equal(harness.bodyQueryCount, queryCountBeforeMutation);
  assert.equal(harness.documentQueryCount, 0);
});

test("a silent URL change enters capture on the polling fallback and stays idempotent", () => {
  const harness = createHarness({ pathname: "/streamer/live/event/list" });

  assert.equal(harness.schedulerSessions.length, 0);
  harness.setPathname(DASHBOARD_PATH);
  harness.tickIntervals();

  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(harness.schedulerSessions[0].runNowCount, 1);

  harness.tickIntervals();
  harness.lifecycleObservers()[0].trigger();
  harness.dispatchWindow("pageshow");
  harness.dispatchDocument("visibilitychange");

  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(harness.captureObservers().length, 1);
  assert.equal(harness.schedulerSessions[0].runNowCount, 1);
});

test("each lifecycle event can stop and restart capture without duplicate sessions", () => {
  const harness = createHarness();
  const signals = [
    () => harness.dispatchWindow("popstate"),
    () => harness.dispatchWindow("hashchange"),
    () => harness.dispatchWindow("pageshow"),
    () => harness.dispatchDocument("visibilitychange"),
  ];

  signals.forEach((signal, index) => {
    const activeSession = harness.schedulerSessions.at(-1);
    const activeObserver = latestCaptureObserver(harness);

    harness.setPathname("/streamer/live/event/list");
    signal();

    assert.equal(activeSession.disposeCount, 1);
    assert.equal(activeObserver.disconnectCount, 1);
    assert.equal(activeObserver.connected, false);

    signal();
    assert.equal(activeSession.disposeCount, 1);
    assert.equal(activeObserver.disconnectCount, 1);

    harness.setPathname(DASHBOARD_PATH);
    signal();

    assert.equal(harness.schedulerSessions.length, index + 2);
    assert.equal(harness.schedulerSessions.at(-1).runNowCount, 1);

    signal();
    assert.equal(harness.schedulerSessions.length, index + 2);
  });
});

test("waits for a body, cleans up when it disappears, and starts on its replacement", () => {
  const harness = createHarness({ body: null });
  const [lifecycleObserver] = harness.lifecycleObservers();
  const firstBody = createBody("first");
  const secondBody = createBody("second");

  assert.equal(harness.schedulerSessions.length, 0);

  harness.setBody(firstBody);
  lifecycleObserver.trigger();
  const firstSession = harness.schedulerSessions[0];
  const firstCaptureObserver = latestCaptureObserver(harness);

  assert.equal(firstCaptureObserver.observeCalls[0].target, firstBody);

  harness.setBody(null);
  lifecycleObserver.trigger();

  assert.equal(firstSession.disposeCount, 1);
  assert.equal(firstCaptureObserver.disconnectCount, 1);

  harness.setBody(secondBody);
  lifecycleObserver.trigger();

  assert.equal(harness.schedulerSessions.length, 2);
  assert.equal(latestCaptureObserver(harness).observeCalls[0].target, secondBody);
});

test("replaces a detached body session once and ignores its stale mutation callback", () => {
  const firstBody = createBody("first");
  const secondBody = createBody("second");
  const harness = createHarness({ body: firstBody, scanOnRequest: true });
  const [lifecycleObserver] = harness.lifecycleObservers();
  const firstSession = harness.schedulerSessions[0];
  const firstCaptureObserver = latestCaptureObserver(harness);

  harness.setBody(secondBody);
  lifecycleObserver.trigger();

  assert.equal(firstSession.disposeCount, 1);
  assert.equal(firstCaptureObserver.disconnectCount, 1);
  assert.equal(harness.schedulerSessions.length, 2);
  assert.equal(latestCaptureObserver(harness).observeCalls[0].target, secondBody);

  lifecycleObserver.trigger();
  assert.equal(harness.schedulerSessions.length, 2);

  const requestCountBeforeStaleCallback = firstSession.requestCount;
  const queryCountBeforeStaleCallback = harness.queryCount;
  assert.doesNotThrow(() => firstCaptureObserver.trigger());
  assert.equal(firstSession.requestCount, requestCountBeforeStaleCallback);
  assert.equal(harness.queryCount, queryCountBeforeStaleCallback);
});

test("keeps completed-sale deduplication for the lifetime of the SPA document", () => {
  const firstBody = createBody("first");
  const secondBody = createBody("second");
  const sale = createSaleRow(
    "Example Buyer has won: $48.00 Variation: #250 Payment complete",
  );
  const harness = createHarness({ body: firstBody, rows: [sale], scanOnRequest: true });
  const [lifecycleObserver] = harness.lifecycleObservers();

  assert.equal(harness.completedSaleLogs().length, 1);

  harness.setBody(secondBody);
  lifecycleObserver.trigger();
  assert.equal(harness.completedSaleLogs().length, 1);

  harness.setPathname("/streamer/live/event/list");
  harness.dispatchWindow("popstate");
  harness.setPathname(DASHBOARD_PATH);
  harness.dispatchWindow("popstate");
  assert.equal(harness.completedSaleLogs().length, 1);

  setSaleSummary(
    sale,
    "Another Buyer has won: $20.00 Variation: #251",
  );
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.summaryText },
  ]);

  assert.equal(harness.completedSaleLogs().length, 2);
  assert.equal(harness.completedSaleLogs()[1][1].variationNumber, 251);
  assert.equal(
    harness.warnings.filter(([message]) =>
      message.includes("stream identity is not yet verified"),
    ).length,
    1,
  );
});

test("emits a pending row once when it turns green and preserves price conflicts", () => {
  const sale = createSaleRow(
    "Example Buyer has won: $48.00 Variation: #250 Awaiting payment",
  );
  const harness = createHarness({ rows: [sale], scanOnRequest: true });
  const captureObserver = latestCaptureObserver(harness);
  const [session] = harness.schedulerSessions;

  assert.equal(harness.completedSaleLogs().length, 0);
  assert.equal(session.requestCount, 0);
  assert.equal(harness.bodyQueryCount, 1);

  setPaymentText(sale, "Payment complete");
  captureObserver.trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  assert.equal(session.requestCount, 1);
  assert.equal(harness.bodyQueryCount, 2);

  const firstCompletedLogs = harness.completedSaleLogs();
  assert.equal(firstCompletedLogs.length, 1);
  assert.equal(firstCompletedLogs[0][1].type, "completed_sale_detected");
  assert.equal(firstCompletedLogs[0][1].source, "sold_items_dom_probe");
  assert.equal(
    firstCompletedLogs[0][1].page,
    `${DASHBOARD_ORIGIN}${DASHBOARD_PATH}`,
  );
  assert.equal(firstCompletedLogs[0][1].variationNumber, 250);
  assert.equal(firstCompletedLogs[0][1].soldPriceCents, 4800);
  assert.equal(firstCompletedLogs[0][1].paymentStatus, "payment_complete");
  assert.equal(firstCompletedLogs[0][1].streamId, null);
  assert.equal(firstCompletedLogs[0][1].streamIdentityStatus, "unverified");
  assert.equal(firstCompletedLogs[0][1].dedupeScope, "page_load");
  assert.equal(typeof firstCompletedLogs[0][1].observedAt, "string");

  captureObserver.trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  assert.equal(harness.completedSaleLogs().length, 1);

  setSaleSummary(sale, "Example Buyer has won: $49.00 Variation: #250");
  captureObserver.trigger([
    { type: "characterData", target: sale.summaryText },
  ]);
  assert.equal(session.requestCount, 3);
  assert.equal(harness.bodyQueryCount, 4);

  assert.equal(harness.completedSaleLogs().length, 1);
  assert.deepEqual(harness.warnings, [
    [
      "[TikTok Live Tracker] TikTok stream identity is not yet verified; completed-sale deduplication is limited to this page load.",
    ],
    [
      "[TikTok Live Tracker] Conflicting completed price detected for variation #250 within the current page scope.",
    ],
  ]);
});

test("warns once for each distinct conflicting price within the page scope", () => {
  const sale = createSaleRow(
    "Example Buyer has won: $48.00 Variation: #250 Payment complete",
  );
  const harness = createHarness({ rows: [sale], scanOnRequest: true });
  const captureObserver = latestCaptureObserver(harness);

  setSaleSummary(sale, "Example Buyer has won: $49.00 Variation: #250");
  captureObserver.trigger([
    { type: "characterData", target: sale.summaryText },
  ]);
  captureObserver.trigger([
    { type: "characterData", target: sale.summaryText },
  ]);

  let conflictWarnings = harness.warnings.filter(([message]) =>
    message.includes("Conflicting completed price detected"),
  );
  assert.equal(conflictWarnings.length, 1);

  setSaleSummary(sale, "Example Buyer has won: $50.00 Variation: #250");
  captureObserver.trigger([
    { type: "characterData", target: sale.summaryText },
  ]);

  conflictWarnings = harness.warnings.filter(([message]) =>
    message.includes("Conflicting completed price detected"),
  );
  assert.equal(conflictWarnings.length, 2);
  assert.equal(
    harness.warnings.filter(([message]) =>
      message.includes("stream identity is not yet verified"),
    ).length,
    1,
  );
  assert.equal(harness.completedSaleLogs().length, 1);
});

test("duplicate content-script execution reuses one active lifecycle singleton", () => {
  const harness = createHarness({ autoRun: false });

  harness.runContent();
  harness.runContent();

  assert.equal(harness.lifecycleObservers().length, 1);
  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(harness.captureObservers().length, 1);
  assert.equal(harness.schedulerSessions[0].runNowCount, 1);
  assert.equal(harness.intervals.size, 1);
  assert.equal(harness.listenerCount("window", "popstate"), 1);
  assert.equal(harness.listenerCount("document", "visibilitychange"), 1);
});

test("duplicate dormant execution still creates only one session after SPA entry", () => {
  const harness = createHarness({
    autoRun: false,
    pathname: "/streamer/live/event/list",
  });

  harness.runContent();
  harness.runContent();
  harness.setPathname(DASHBOARD_PATH);
  harness.tickIntervals();

  assert.equal(harness.lifecycleObservers().length, 1);
  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(harness.captureObservers().length, 1);
  assert.equal(harness.intervals.size, 1);
});

test("failed scheduler creation leaves no partial session and retries", () => {
  const harness = createHarness({ schedulerCreateFailures: 1 });

  assert.equal(harness.schedulerCreateCount, 1);
  assert.equal(harness.schedulerSessions.length, 0);
  assert.equal(harness.captureObservers().length, 0);
  assert.ok(harness.errors.length >= 1);

  assert.doesNotThrow(() => harness.tickIntervals());
  assert.equal(harness.schedulerCreateCount, 2);
  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(harness.captureObservers().length, 1);
});

test("failed observer setup disposes the scheduler and retries cleanly", () => {
  const harness = createHarness({ bodyObserveFailures: 1 });
  const [failedSession] = harness.schedulerSessions;
  const [failedObserver] = harness.captureObservers();

  assert.equal(failedSession.disposeCount, 1);
  assert.equal(failedObserver.connected, false);
  assert.ok(harness.errors.length >= 1);

  assert.doesNotThrow(() => harness.tickIntervals());
  assert.equal(harness.schedulerSessions.length, 2);
  assert.equal(harness.schedulerSessions[1].runNowCount, 1);
  assert.equal(latestCaptureObserver(harness).connected, true);
});

test("failed initial scan cleans up its partial session and retries", () => {
  const harness = createHarness({ schedulerRunNowFailures: 1 });
  const [failedSession] = harness.schedulerSessions;
  const [failedObserver] = harness.captureObservers();

  assert.equal(failedSession.disposeCount, 1);
  assert.equal(failedObserver.disconnectCount, 1);
  assert.ok(harness.errors.length >= 1);

  assert.doesNotThrow(() => harness.tickIntervals());
  assert.equal(harness.schedulerSessions.length, 2);
  assert.equal(harness.schedulerSessions[1].runNowCount, 1);
});

test("mutation request failures are contained without disabling capture", () => {
  const harness = createHarness({
    schedulerRequestFailures: 1,
    scanOnRequest: true,
  });
  const [session] = harness.schedulerSessions;
  const captureObserver = latestCaptureObserver(harness);

  assert.doesNotThrow(() => captureObserver.trigger());
  assert.equal(session.requestCount, 1);
  assert.ok(harness.errors.length >= 1);

  assert.doesNotThrow(() => captureObserver.trigger());
  assert.equal(session.requestCount, 2);
  assert.equal(harness.schedulerSessions.length, 1);
});

test("cleanup failures cannot prevent a later dashboard session", () => {
  const harness = createHarness({
    bodyDisconnectFailures: 1,
    schedulerDisposeFailures: 1,
  });
  const [firstSession] = harness.schedulerSessions;
  const firstObserver = latestCaptureObserver(harness);

  harness.setPathname("/streamer/live/event/list");
  assert.doesNotThrow(() => harness.dispatchWindow("popstate"));
  assert.equal(firstObserver.disconnectCount, 1);
  assert.equal(firstSession.disposeCount, 1);
  assert.ok(harness.errors.length >= 1);

  harness.setPathname(DASHBOARD_PATH);
  assert.doesNotThrow(() => harness.dispatchWindow("popstate"));
  assert.equal(harness.schedulerSessions.length, 2);
  assert.equal(harness.schedulerSessions[1].runNowCount, 1);
});

test("capture remains read-only and does not send data", () => {
  assert.doesNotMatch(
    contentSource,
    /\bfetch\s*\(|XMLHttpRequest|runtime\.sendMessage|\.sendBeacon\s*\(/,
  );
  assert.doesNotMatch(
    contentSource,
    /\.append(?:Child)?\s*\(|\.prepend\s*\(|\.remove\s*\(|innerHTML\s*=|textContent\s*=/,
  );
});
