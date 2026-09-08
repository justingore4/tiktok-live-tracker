const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const parser = require("../extension/shared/sale-parser.js");
const candidateLocator = require(
  "../extension/capture/sale-candidate-locator.js",
);
const attributedGmvLocator = require(
  "../extension/capture/attributed-gmv-locator.js",
);
const biddingVariationLocator = require(
  "../extension/capture/bidding-variation-locator.js",
);
const captureEventRegistry = require(
  "../extension/capture/capture-event-registry.js",
);
const captureProtocol = require("../extension/shared/capture-protocol.js");
const captureClientModule = require("../extension/capture/capture-client.js");
const contentSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "capture", "content.js"),
  "utf8",
);

const DASHBOARD_ORIGIN = "https://shop.tiktok.com";
const DASHBOARD_PATH = "/streamer/live/product/dashboard";

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
  constructor({
    className = "",
    dataTid = null,
    height = 20,
    id = null,
    name = "element",
    ownText = "",
    tagName = "DIV",
    width = 100,
  } = {}) {
    this.nodeType = 1;
    this.className = className;
    this.dataTid = dataTid;
    this.height = height;
    this.id = id;
    this.name = name;
    this.ownText = ownText;
    this.tagName = tagName;
    this.width = width;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.onQuery = null;
  }

  get childNodes() {
    return this.children;
  }

  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    const index = siblings.indexOf(this);

    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  getAttribute(name) {
    if (name === "class") {
      return this.className;
    }

    if (name === "id") {
      return this.id;
    }

    if (name === "aria-hidden") {
      return null;
    }

    return null;
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
    if (selector === biddingVariationLocator.AUCTION_CARD_SELECTOR) {
      return this.className.split(/\s+/).includes("auction-pin-card");
    }

    if (selector === biddingVariationLocator.OWN_TEXT_ELEMENT_SELECTOR) {
      return true;
    }

    if (selector === attributedGmvLocator.ATTRIBUTED_GMV_ROOT_SELECTOR) {
      return this.id === "guide-Step-2" || this.id === "guide-step-2";
    }

    if (selector === attributedGmvLocator.METRIC_ELEMENT_SELECTOR) {
      return this.tagName === "DIV" || this.tagName === "SPAN";
    }

    if (selector === candidateLocator.PAYMENT_TAG_SELECTOR) {
      return this.dataTid === "m4b_tag";
    }

    if (selector === candidateLocator.SOLD_ITEMS_ROOT_SELECTOR) {
      return this.dataTid === "m4b_space";
    }

    if (selector === candidateLocator.VARIATION_LABEL_SELECTOR) {
      return this.tagName === "SPAN";
    }

    throw new Error(`Unexpected selector: ${selector}`);
  }

  querySelectorAll(selector) {
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

  getBoundingClientRect() {
    return { height: this.height, width: this.width };
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
  const variationMatch = text.match(/\bVariation\s*:\s*#\s*(\d+)\b/i);
  const summaryValue = text
    .replace(/\bPayment\s+complete\b/gi, "")
    .replace(/\bAwaiting\s+payment\b/gi, "")
    .replace(/\bVariation\s*:\s*#\s*\d+\b/gi, "")
    .trim();
  const row = new FakeElement({ name: "sale-row" });
  const summary = new FakeElement({ name: "sale-summary" });
  const summaryText = new FakeText(`${summaryValue} `);
  const variationLabel = new FakeElement({
    name: "variation-label",
    ownText: variationMatch ? `Variation: #${variationMatch[1]} ` : "",
    tagName: "SPAN",
  });
  const statusTag = new FakeElement({
    dataTid: "m4b_tag",
    name: "payment-tag",
  });
  const statusText = new FakeText(status);

  summary.append(summaryText, variationLabel);
  statusTag.append(statusText);
  row.append(summary, statusTag);

  return {
    row,
    statusTag,
    statusText,
    summary,
    summaryText,
    variationLabel,
  };
}

function createAttributedGmvMetric(display = "$4.64K", id = "guide-Step-2") {
  const root = new FakeElement({ id, name: "attributed-gmv-root" });
  const card = new FakeElement({ name: "attributed-gmv-card" });
  const label = new FakeElement({ name: "attributed-gmv-label" });
  const valueRegion = new FakeElement({ name: "attributed-gmv-value-region" });
  const value = new FakeElement({ name: "attributed-gmv-value" });
  const detail = new FakeElement({ name: "attributed-gmv-detail" });

  label.append(new FakeText("Attributed GMV"));
  value.append(new FakeText(display));
  valueRegion.append(value);
  detail.append(
    new FakeElement({ name: "auction-label", ownText: "Auction" }),
    new FakeElement({ name: "auction-value", ownText: display }),
  );
  card.append(label, valueRegion, detail);
  root.append(card);

  return { card, detail, label, root, value, valueRegion };
}

function createBiddingAuctionCard(variationNumber = 237, bidPrice = null) {
  const root = new FakeElement({
    className: "auction-pin-card flex rounded-8",
    name: "bidding-auction-card",
  });
  const details = new FakeElement({ name: "bidding-details" });
  const title = new FakeElement({ name: "bidding-title" });
  const titleText = new FakeText(
    `#${variationNumber} ITEMS SHOWN ON SCREEN/ ALL SALES FINAL`,
  );
  const bidPriceElement = new FakeElement({ name: "bidding-price" });
  const bidPriceText = new FakeText(bidPrice ?? "");
  const bids = new FakeElement({ name: "bidding-count" });

  title.append(titleText);
  bidPriceElement.append(bidPriceText);
  bids.append(new FakeText("6 bids"));
  details.append(title, bidPriceElement, bids);
  root.append(new FakeElement({ name: "auction-image" }), details);

  return {
    bidPriceElement,
    bidPriceText,
    bids,
    root,
    title,
    titleText,
  };
}

function setSaleSummary(sale, text) {
  const variationMatch = text.match(/\bVariation\s*:\s*#\s*(\d+)\b/i);
  sale.summaryText.textContent = `${text
    .replace(/\bVariation\s*:\s*#\s*\d+\b/gi, "")
    .trim()} `;
  sale.variationLabel.ownText = variationMatch
    ? `Variation: #${variationMatch[1]} `
    : "";
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
  protocolAvailable = true,
  clientAvailable = true,
  rows = [],
  rootCount = 1,
  captureResponseHandler = async () => ({
    ok: true,
    data: { status: "accepted" },
  }),
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
  const captureMessages = [];
  const documentElement = { name: "documentElement" };
  const location = { origin, pathname };
  const intervals = new Map();
  const timeouts = new Map();
  const windowEvents = createEventTarget(calls, "window");
  const documentEvents = createEventTarget(calls, "document");
  let currentBody = body;
  let currentRoot = null;
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
      currentRoot = null;
      return;
    }

    let existingRoots = currentBody.children.filter(
      (child) => child.dataTid === "m4b_space",
    );

    if (existingRoots.length === 0) {
      for (let index = 0; index < rootCount; index += 1) {
        currentBody.append(
          new FakeElement({
            dataTid: "m4b_space",
            name: `${currentBody.name}-sold-items-${index}`,
          }),
        );
      }

      existingRoots = currentBody.children.filter(
        (child) => child.dataTid === "m4b_space",
      );
    }

    currentRoot = existingRoots[0] ?? null;

    currentBody.onQuery = (selector) => {
      calls.push(`body:query:${selector}`);
    };
    if (!currentRoot) {
      return;
    }

    currentRoot.onQuery = (selector) => {
      if (selector === candidateLocator.PAYMENT_TAG_SELECTOR) {
        bodyQueryCount += 1;
        calls.push("body:query");
      }
    };
    currentRows.forEach(({ row }) => currentRoot.append(row));
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
    TikTokLiveTrackerAttributedGmvLocator: attributedGmvLocator,
    TikTokLiveTrackerBiddingVariationLocator: biddingVariationLocator,
    TikTokLiveTrackerSaleCandidateLocator: locatorAvailable
      ? candidateLocator
      : undefined,
    TikTokLiveTrackerCaptureEventRegistry: registryAvailable
      ? captureEventRegistry
      : undefined,
    TikTokLiveTrackerCaptureScheduler: schedulerModule,
    TikTokLiveTrackerCaptureProtocol: protocolAvailable
      ? captureProtocol
      : undefined,
    TikTokLiveTrackerCaptureClient: clientAvailable
      ? captureClientModule
      : undefined,
    chrome: {
      runtime: {
        async sendMessage(message) {
          captureMessages.push(message);
          return captureResponseHandler(message, captureMessages.length - 1);
        },
      },
    },
    location,
    document,
    MutationObserver: FakeMutationObserver,
    setTimeout(callback, delayMs) {
      const timerId = nextTimeoutId;
      nextTimeoutId += 1;
      timeouts.set(timerId, { callback, delayMs });
      return timerId;
    },
    clearTimeout(timerId) {
      timeouts.delete(timerId);
    },
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
    captureMessages,
    documentElement,
    errors,
    infos,
    intervals,
    timeouts,
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
    currentRoot() {
      return currentRoot;
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
    tickTimeouts() {
      const scheduled = [...timeouts.entries()];

      scheduled.forEach(([timerId, { callback }]) => {
        timeouts.delete(timerId);
        callback();
      });
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

async function flushAsync(turns = 6) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function assertSinglePrimitiveLog(entry, pattern) {
  assert.equal(entry.length, 1);
  assert.equal(typeof entry[0], "string");
  assert.match(entry[0], pattern);
  assert.doesNotMatch(entry[0], /\[object Object\]/);
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

test("fails closed when the capture protocol or client is unavailable", () => {
  const missingProtocol = createHarness({ protocolAvailable: false });
  const missingClient = createHarness({ clientAvailable: false });

  assert.equal(missingProtocol.schedulerCreateCount, 0);
  assert.deepEqual(missingProtocol.errors, [
    ["[TikTok Live Tracker] Capture protocol failed to load."],
  ]);
  assert.equal(missingClient.schedulerCreateCount, 0);
  assert.deepEqual(missingClient.errors, [
    ["[TikTok Live Tracker] Capture client failed to load."],
  ]);
});

test("keeps transient Sold Items root discovery states out of Chrome extension errors", () => {
  const missing = createHarness({ rootCount: 0 });
  const ambiguous = createHarness({ rootCount: 2 });

  for (const [harness, description] of [
    [missing, "no visible Sold Items panel was found"],
    [ambiguous, "more than one visible Sold Items panel was found"],
  ]) {
    assert.equal(harness.schedulerSessions.length, 0);
    assert.equal(harness.captureObservers().length, 0);
    assert.equal(harness.captureMessages.length, 0);
    assert.equal(harness.intervals.size, 1);

    harness.tickIntervals();
    assert.equal(harness.schedulerSessions.length, 0);
    assert.deepEqual(harness.warnings, []);
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.infos.length, 1);
    assertSinglePrimitiveLog(
      harness.infos[0],
      new RegExp(`Sold Items capture paused: ${description}\\.$`),
    );
  }
});

test("keeps the former event dashboard route dormant", () => {
  const harness = createHarness({
    pathname: "/streamer/live/event/dashboard",
  });

  assert.equal(harness.schedulerSessions.length, 0);
  assert.equal(harness.captureObservers().length, 0);
  assert.equal(harness.queryCount, 0);
  assert.equal(harness.lifecycleObservers().length, 1);
  assert.equal(harness.intervals.size, 1);
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.infos.length, 0);
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
  assert.equal(captureObserver.observeCalls[0].target, harness.currentRoot());
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

test("observes exact pending Variation labels without requiring a payment tag", async () => {
  const firstRow = new FakeElement({ name: "pending-row-44" }).append(
    new FakeElement({
      name: "variation-44",
      ownText: "Variation: #44",
      tagName: "SPAN",
    }),
  );
  const duplicateRow = new FakeElement({ name: "duplicate-row-44" }).append(
    new FakeElement({
      name: "duplicate-variation-44",
      ownText: "variation: #44",
      tagName: "SPAN",
    }),
  );
  const secondRow = new FakeElement({ name: "pending-row-43" }).append(
    new FakeElement({
      name: "variation-43",
      ownText: " Variation:   #43 ",
      tagName: "SPAN",
    }),
  );
  const lookalike = new FakeElement({ name: "lookalike-row" }).append(
    new FakeElement({
      name: "lookalike",
      ownText: "Buyer mentioned Variation: #999",
      tagName: "SPAN",
    }),
  );
  const harness = createHarness({
    rows: [
      { row: firstRow },
      { row: duplicateRow },
      { row: secondRow },
      { row: lookalike },
    ],
  });

  await flushAsync();

  assert.deepEqual(harness.captureMessages, [
    {
      channel: "tiktok-live-tracker.capture",
      version: 1,
      event: {
        type: "observe_variations",
        variationNumbers: [44, 43],
      },
    },
  ]);
  assert.equal(harness.completedSaleLogs().length, 0);
  assert.doesNotMatch(JSON.stringify(harness.captureMessages), /Buyer/);
  const syncLogs = harness.infos.filter(
    ([message]) =>
      message ===
      "[TikTok Live Tracker] Sold Items variations synchronized.",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(syncLogs)), [
    [
      "[TikTok Live Tracker] Sold Items variations synchronized.",
      { variationNumbers: [44, 43] },
    ],
  ]);
  assert.doesNotMatch(JSON.stringify(syncLogs), /Buyer|title|streamId/i);
});

test("forwards observation before completed payment and only once per fingerprint", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Payment complete",
  );
  const harness = createHarness({ rows: [sale], scanOnRequest: true });

  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [
      { type: "observe_variations", variationNumbers: [44] },
      {
        type: "payment_complete",
        variationNumber: 44,
        soldPriceCents: 700,
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(harness.captureMessages),
    /Example Buyer|streamId|observedAt|title|row/i,
  );

  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 2);
  assert.equal(
    harness.infos.filter(([message]) =>
      message.includes("Sold Items variations synchronized"),
    ).length,
    1,
  );

  setSaleSummary(sale, "Example Buyer has won: $8.00 Variation: #44");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.summaryText },
  ]);
  await flushAsync();

  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "payment_complete",
    variationNumber: 44,
    soldPriceCents: 800,
  });
  assert.equal(harness.captureMessages.length, 3);

  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.summaryText },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 3);
});

test("commits variation 147 when the price is outside its narrow item-status wrapper", async () => {
  const itemAndStatus = new FakeElement({ name: "item-and-status" }).append(
    new FakeElement({
      name: "item-line",
      ownText: "ITEM SHOWN ON SCREEN/ ALL SALES FINAL... | ",
    }).append(
      new FakeElement({
        name: "variation-label",
        ownText: "Variation: #147",
        tagName: "SPAN",
      }),
    ),
    new FakeElement({ name: "payment-line" }).append(
      new FakeElement({
        dataTid: "m4b_tag",
        name: "payment-tag",
      }).append(
        new FakeElement({ name: "tag-content", tagName: "SPAN" }).append(
          new FakeText("Payment complete"),
        ),
      ),
    ),
  );
  const row = new FakeElement({ name: "sold-item-row-147" }).append(
    new FakeElement({
      name: "buyer-line",
      ownText: "Dobo93 has won: $11.00 · 1m ",
    }),
    new FakeElement({ name: "buyer-handle", ownText: "doboy9393 " }),
    itemAndStatus,
  );
  const harness = createHarness({ rows: [{ row }] });

  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [
      { type: "observe_variations", variationNumbers: [147] },
      {
        type: "payment_complete",
        variationNumber: 147,
        soldPriceCents: 1100,
      },
    ],
  );
});

test("captures every sanitized row status before completed payments", async () => {
  const processing = createSaleRow(
    "Buyer One has won: $7.00 Variation: #44 Awaiting payment",
  );
  const fixing = createSaleRow(
    "Buyer Two has won: $8.00 Variation: #43 Awaiting payment",
  );
  const failed = createSaleRow(
    "Buyer Three has won: $9.00 Variation: #42 Awaiting payment",
  );
  const unrecognized = createSaleRow(
    "Buyer Four has won: $10.00 Variation: #41 Awaiting payment",
  );
  const complete = createSaleRow(
    "Buyer Five has won: $11.00 Variation: #40 Payment complete",
  );
  const canceled = createSaleRow(
    "Buyer Six has won: $12.00 Variation: #39 Awaiting payment",
  );

  setPaymentText(processing, "Payment processing...");
  setPaymentText(fixing, "Payment fixing");
  setPaymentText(failed, "Payment failed");
  setPaymentText(canceled, "Canceled");
  canceled.row.append(
    new FakeElement({
      name: "payment-failure-detail",
      ownText: "Payment failed",
    }),
  );
  setPaymentText(unrecognized, "Private custom badge text");
  const harness = createHarness({
    rows: [processing, fixing, failed, unrecognized, complete, canceled],
  });

  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [
      {
        type: "observe_variations",
        variationNumbers: [44, 43, 42, 41, 40, 39],
      },
      {
        type: "observe_payment_statuses",
        statuses: [
          {
            variationNumber: 44,
            observedPaymentStatus: "payment_processing",
          },
          {
            variationNumber: 43,
            observedPaymentStatus: "payment_fixing",
          },
          {
            variationNumber: 42,
            observedPaymentStatus: "payment_failed",
          },
          {
            variationNumber: 41,
            observedPaymentStatus: "unrecognized",
          },
          {
            variationNumber: 39,
            observedPaymentStatus: "canceled",
          },
        ],
      },
      {
        type: "payment_complete",
        variationNumber: 40,
        soldPriceCents: 1100,
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(harness.captureMessages),
    /Buyer One|Buyer Two|Buyer Three|Buyer Four|Buyer Five|Buyer Six|Private custom|statusText|title|element/i,
  );
  assert.doesNotMatch(
    JSON.stringify(harness.captureMessages),
    /Canceled|Payment failed/,
  );
  assert.doesNotMatch(
    JSON.stringify([...harness.infos, ...harness.warnings, ...harness.errors]),
    /Buyer One|Buyer Two|Buyer Three|Buyer Four|Buyer Five|Buyer Six|Canceled|Payment failed|Private custom badge text/,
  );
});

test("Order processing ellipses share one observation without committing a sale", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Awaiting payment",
  );
  setPaymentText(sale, "Order processing...");
  const harness = createHarness({ rows: [sale], scanOnRequest: true });

  await flushAsync();
  assert.deepEqual(harness.captureMessages.map(({ event }) => event), [
    { type: "observe_variations", variationNumbers: [44] },
    {
      type: "observe_payment_statuses",
      statuses: [{ variationNumber: 44, observedPaymentStatus: "order_processing" }],
    },
  ]);

  for (const label of ["Order processing", "Order processing\u2026"]) {
    setPaymentText(sale, label);
    latestCaptureObserver(harness).trigger([
      { type: "characterData", target: sale.statusText },
    ]);
    await flushAsync();
    assert.equal(harness.captureMessages.length, 2);
  }
  assert.equal(harness.completedSaleLogs().length, 0);

  setPaymentText(sale, "Payment complete");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "payment_complete",
    variationNumber: 44,
    soldPriceCents: 700,
  });
});

test("an unpriced completion remains provisional and can transition", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Payment complete",
  );
  setSaleSummary(sale, "Example Buyer Variation: #44");
  const harness = createHarness({ rows: [sale], scanOnRequest: true });

  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [
      { type: "observe_variations", variationNumbers: [44] },
      {
        type: "observe_payment_statuses",
        statuses: [
          {
            variationNumber: 44,
            observedPaymentStatus: "payment_complete",
          },
        ],
      },
    ],
  );
  assert.equal(harness.completedSaleLogs().length, 0);

  setPaymentText(sale, "Payment fixing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "observe_payment_statuses",
    statuses: [
      { variationNumber: 44, observedPaymentStatus: "payment_fixing" },
    ],
  });

  setPaymentText(sale, "Payment processing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "observe_payment_statuses",
    statuses: [
      { variationNumber: 44, observedPaymentStatus: "payment_processing" },
    ],
  });
  assert.equal(
    harness.captureMessages.some(
      ({ event }) => event.type === "payment_complete",
    ),
    false,
  );
});

test("streams status transitions once and keeps a completed payment sticky", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Awaiting payment",
  );
  setPaymentText(sale, "Payment processing");
  const harness = createHarness({ rows: [sale], scanOnRequest: true });

  await flushAsync();
  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.type),
    ["observe_variations", "observe_payment_statuses"],
  );

  setPaymentText(sale, "Payment fixing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "observe_payment_statuses",
    statuses: [
      { variationNumber: 44, observedPaymentStatus: "payment_fixing" },
    ],
  });

  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 3);

  setPaymentText(sale, "Payment complete");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "payment_complete",
    variationNumber: 44,
    soldPriceCents: 700,
  });

  setPaymentText(sale, "Canceled");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 4);
});

test("streams failed, fixing, canceled, and processing as distinct observations", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Awaiting payment",
  );
  setPaymentText(sale, "Payment failed");
  sale.row.append(
    new FakeElement({
      name: "payment-failure-detail",
      ownText: "Payment failed",
    }),
  );
  const harness = createHarness({ rows: [sale], scanOnRequest: true });

  await flushAsync();
  assert.equal(
    harness.captureMessages.at(-1).event.statuses[0].observedPaymentStatus,
    "payment_failed",
  );

  setPaymentText(sale, "Payment fixing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(
    harness.captureMessages.at(-1).event.statuses[0].observedPaymentStatus,
    "payment_fixing",
  );

  setPaymentText(sale, "Canceled");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();

  assert.deepEqual(harness.captureMessages.at(-1).event, {
    type: "observe_payment_statuses",
    statuses: [
      { variationNumber: 44, observedPaymentStatus: "canceled" },
    ],
  });

  setPaymentText(sale, "Payment processing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(
    harness.captureMessages.at(-1).event.statuses[0].observedPaymentStatus,
    "payment_processing",
  );
  assert.equal(
    harness.captureMessages.some(
      ({ event }) => event.type === "payment_complete",
    ),
    false,
  );
});

test("a stale Payment failed retry never overwrites newer Canceled", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Awaiting payment",
  );
  setPaymentText(sale, "Payment failed");
  let statusAttempts = 0;
  const harness = createHarness({
    rows: [sale],
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_payment_statuses" &&
        statusAttempts++ === 0
      ) {
        return {
          ok: false,
          error: {
            code: "NO_ACTIVE_STREAM",
            message: "No active tracker stream is available.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();
  assert.equal(harness.timeouts.size, 1);

  setPaymentText(sale, "Canceled");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 2);

  harness.tickTimeouts();
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages
      .filter(({ event }) => event.type === "observe_payment_statuses")
      .map(({ event }) => event.statuses[0].observedPaymentStatus),
    ["payment_failed", "canceled"],
  );
  assert.equal(harness.timeouts.size, 0);
});

test("a failed status retry is cancelled when the newest DOM state is already delivered", async () => {
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Awaiting payment",
  );
  setPaymentText(sale, "Payment processing");
  let statusAttempts = 0;
  const harness = createHarness({
    rows: [sale],
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_payment_statuses" &&
        statusAttempts++ === 1
      ) {
        return {
          ok: false,
          error: {
            code: "NO_ACTIVE_STREAM",
            message: "No active tracker stream is available.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();
  setPaymentText(sale, "Payment fixing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  assert.equal(harness.timeouts.size, 1);

  setPaymentText(sale, "Payment processing");
  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: sale.statusText },
  ]);
  await flushAsync();
  harness.tickTimeouts();
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages
      .filter(({ event }) => event.type === "observe_payment_statuses")
      .map(({ event }) => event.statuses[0].observedPaymentStatus),
    ["payment_processing", "payment_fixing"],
  );
  assert.equal(harness.timeouts.size, 0);
});

test("retries a failed observation without a DOM mutation and resets backoff", async () => {
  const failureIndexes = new Set([0, 2]);
  const row44 = new FakeElement({ name: "pending-row-44" }).append(
    new FakeElement({
      ownText: "Variation: #44",
      tagName: "SPAN",
    }),
  );
  const harness = createHarness({
    rows: [{ row: row44 }],
    scanOnRequest: true,
    captureResponseHandler: async (_message, index) =>
      failureIndexes.has(index)
        ? {
            ok: false,
            error: {
              code: "NO_ACTIVE_STREAM",
              message: "No active tracker stream is available.",
            },
          }
        : { ok: true, data: { status: "accepted" } },
  });

  await flushAsync();
  assert.equal(harness.captureMessages.length, 1);
  assert.deepEqual(
    [...harness.timeouts.values()].map(({ delayMs }) => delayMs),
    [1000],
  );

  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: row44.children[0] },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 1);
  assert.deepEqual(
    [...harness.timeouts.values()].map(({ delayMs }) => delayMs),
    [1000],
  );

  harness.tickTimeouts();
  await flushAsync();
  assert.equal(harness.captureMessages.length, 2);
  assert.equal(harness.timeouts.size, 0);

  const row45 = new FakeElement({ name: "pending-row-45" }).append(
    new FakeElement({
      ownText: "Variation: #45",
      tagName: "SPAN",
    }),
  );
  harness.currentRoot().append(row45);
  latestCaptureObserver(harness).trigger([
    {
      type: "childList",
      target: harness.currentRoot(),
      addedNodes: [row45],
      removedNodes: [],
    },
  ]);
  await flushAsync();

  assert.equal(harness.captureMessages.length, 3);
  assert.deepEqual(harness.captureMessages[2].event, {
    type: "observe_variations",
    variationNumbers: [45],
  });
  assert.deepEqual(
    [...harness.timeouts.values()].map(({ delayMs }) => delayMs),
    [1000],
  );
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.errors, []);
  const retryLogs = harness.infos.filter(([message]) =>
    message.includes("Variation observation delivery failed."),
  );
  assert.equal(retryLogs.length, 1);
  assertSinglePrimitiveLog(
    retryLogs[0],
    /Variation observation delivery failed\. Retrying automatically \(NO_ACTIVE_STREAM\)\.$/,
  );

  harness.tickTimeouts();
  await flushAsync();
  assert.equal(harness.captureMessages.length, 4);

  latestCaptureObserver(harness).trigger([
    { type: "characterData", target: row45.children[0] },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 4);
});

test("retries a failed payment without resending its accepted observation", async () => {
  let paymentAttempts = 0;
  const sale = createSaleRow(
    "Example Buyer has won: $7.00 Variation: #44 Payment complete",
  );
  const harness = createHarness({
    rows: [sale],
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "payment_complete" &&
        paymentAttempts++ === 0
      ) {
        return {
          ok: false,
          error: {
            code: "STATE_NOT_INITIALIZED",
            message: "Capture state is not ready.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();
  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.type),
    ["observe_variations", "payment_complete"],
  );
  assert.deepEqual(
    [...harness.timeouts.values()].map(({ delayMs }) => delayMs),
    [1000],
  );
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.errors, []);
  const retryLogs = harness.infos.filter(([message]) =>
    message.includes("Payment delivery failed."),
  );
  assert.equal(retryLogs.length, 1);
  assertSinglePrimitiveLog(
    retryLogs[0],
    /Payment delivery failed\. Retrying automatically \(STATE_NOT_INITIALIZED\)\.$/,
  );

  harness.tickTimeouts();
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.type),
    ["observe_variations", "payment_complete", "payment_complete"],
  );
  assert.equal(harness.timeouts.size, 0);
});

test("keeps retryable transport failures out of Chrome extension errors", async () => {
  let attempt = 0;
  const row = new FakeElement({ name: "pending-row-44" }).append(
    new FakeElement({ ownText: "Variation: #44", tagName: "SPAN" }),
  );
  const harness = createHarness({
    rows: [{ row }],
    captureResponseHandler: async () => {
      if (attempt++ === 0) {
        throw new Error("The service worker restarted.");
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();

  assert.equal(harness.captureMessages.length, 1);
  assert.equal(harness.timeouts.size, 1);
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.errors, []);
  const retryLogs = harness.infos.filter(([message]) =>
    message.includes("Variation observation delivery failed."),
  );
  assert.equal(retryLogs.length, 1);
  assertSinglePrimitiveLog(
    retryLogs[0],
    /Variation observation delivery failed\. Retrying automatically \(CAPTURE_TRANSPORT_ERROR\)\.$/,
  );

  harness.tickTimeouts();
  await flushAsync();

  assert.equal(harness.captureMessages.length, 2);
  assert.equal(harness.timeouts.size, 0);
});

test("reports unexpected delivery failures once with a readable primitive message", async () => {
  const row = new FakeElement({ name: "pending-row-44" }).append(
    new FakeElement({ ownText: "Variation: #44", tagName: "SPAN" }),
  );
  const harness = createHarness({
    rows: [{ row }],
    captureResponseHandler: async () => ({ unexpected: true }),
  });

  await flushAsync();

  assert.equal(harness.captureMessages.length, 1);
  assert.equal(harness.timeouts.size, 1);
  assert.deepEqual(harness.warnings, []);
  assert.equal(harness.errors.length, 1);
  assertSinglePrimitiveLog(
    harness.errors[0],
    /Variation observation delivery failed\. Retrying automatically \(INVALID_CAPTURE_RESPONSE\)\.$/,
  );

  harness.tickTimeouts();
  await flushAsync();

  assert.equal(harness.captureMessages.length, 2);
  assert.equal(harness.errors.length, 1);
});

test("cancels a pending delivery retry when the route tears down", async () => {
  const row = new FakeElement({ name: "pending-row" }).append(
    new FakeElement({ ownText: "Variation: #44", tagName: "SPAN" }),
  );
  const harness = createHarness({
    rows: [{ row }],
    captureResponseHandler: async () => ({
      ok: false,
      error: {
        code: "NO_ACTIVE_STREAM",
        message: "No active tracker stream is available.",
      },
    }),
  });

  await flushAsync();
  assert.equal(harness.captureMessages.length, 1);
  assert.equal(harness.timeouts.size, 1);

  harness.setPathname("/streamer/live/event/list");
  harness.dispatchWindow("popstate");

  assert.equal(harness.timeouts.size, 0);
  assert.equal(latestCaptureObserver(harness).connected, false);

  harness.tickTimeouts();
  await flushAsync();
  assert.equal(harness.captureMessages.length, 1);
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

  assert.equal(firstCaptureObserver.observeCalls[0].target, harness.currentRoot());

  harness.setBody(null);
  lifecycleObserver.trigger();

  assert.equal(firstSession.disposeCount, 1);
  assert.equal(firstCaptureObserver.disconnectCount, 1);

  harness.setBody(secondBody);
  lifecycleObserver.trigger();

  assert.equal(harness.schedulerSessions.length, 2);
  assert.equal(
    latestCaptureObserver(harness).observeCalls[0].target,
    harness.currentRoot(),
  );
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
  assert.equal(
    latestCaptureObserver(harness).observeCalls[0].target,
    harness.currentRoot(),
  );

  lifecycleObserver.trigger();
  assert.equal(harness.schedulerSessions.length, 2);

  const requestCountBeforeStaleCallback = firstSession.requestCount;
  const queryCountBeforeStaleCallback = harness.queryCount;
  assert.doesNotThrow(() => firstCaptureObserver.trigger());
  assert.equal(firstSession.requestCount, requestCountBeforeStaleCallback);
  assert.equal(harness.queryCount, queryCountBeforeStaleCallback);
});

test("replaces the Sold Items root, rescans it, and ignores stale callbacks", async () => {
  const firstRow = new FakeElement({ name: "first-row" }).append(
    new FakeElement({ ownText: "Variation: #44", tagName: "SPAN" }),
  );
  const harness = createHarness({ rows: [{ row: firstRow }] });

  await flushAsync();
  const firstObserver = latestCaptureObserver(harness);
  const firstRoot = harness.currentRoot();
  const secondRoot = new FakeElement({
    dataTid: "m4b_space",
    name: "replacement-sold-items",
  });
  const secondRow = new FakeElement({ name: "second-row" }).append(
    new FakeElement({ ownText: "Variation: #45", tagName: "SPAN" }),
  );
  secondRoot.append(secondRow);
  harness.currentBody().children = harness.currentBody().children.filter(
    (child) => child !== firstRoot,
  );
  firstRoot.parentElement = null;
  firstRoot.parentNode = null;
  harness.currentBody().append(secondRoot);

  harness.tickIntervals();
  await flushAsync();

  assert.equal(firstObserver.connected, false);
  assert.equal(latestCaptureObserver(harness).observeCalls[0].target, secondRoot);
  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.variationNumbers),
    [[44], [45]],
  );

  firstObserver.trigger([
    { type: "characterData", target: firstRow.children[0] },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 2);
});

test("captures sanitized Attributed GMV independently when Sold Items is unavailable", async () => {
  const body = createBody("analytics-only-body");
  const metric = createAttributedGmvMetric("$4.64K");
  body.append(metric.root);
  const harness = createHarness({ body, rootCount: 0 });

  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [
      {
        type: "observe_attributed_gmv",
        attributedGmvDisplay: "$4.64K",
      },
    ],
  );
  const analyticsObserver = harness.observerInstances.find(
    (observer) => observer.target === metric.root,
  );

  assert.ok(analyticsObserver);
  assert.deepEqual({ ...analyticsObserver.observeCalls[0].options }, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  assert.doesNotMatch(
    JSON.stringify(harness.captureMessages[0].event),
    /buyer|title|element|selector|observedAt|streamId/i,
  );
});

test("deduplicates Attributed GMV and streams live semantic-value changes", async () => {
  const body = createBody("analytics-update-body");
  const metric = createAttributedGmvMetric("$4.64K");
  body.append(metric.root);
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
  });

  await flushAsync();
  const analyticsObserver = harness.observerInstances.find(
    (observer) => observer.target === metric.root,
  );
  const valueText = metric.value.children[0];

  analyticsObserver.trigger([
    { type: "characterData", target: valueText },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 1);

  valueText.textContent = "$4.65K";
  analyticsObserver.trigger([
    { type: "characterData", target: valueText },
  ]);
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.attributedGmvDisplay),
    ["$4.64K", "$4.65K"],
  );
});

test("preserves latest Attributed GMV across root replacement and ignores stale callbacks", async () => {
  const body = createBody("analytics-replacement-body");
  const firstMetric = createAttributedGmvMetric("$4.64K");
  body.append(firstMetric.root);
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
  });

  await flushAsync();
  const firstObserver = harness.observerInstances.find(
    (observer) => observer.target === firstMetric.root,
  );
  const replacementMetric = createAttributedGmvMetric("$4.65K");

  body.children = body.children.filter((child) => child !== firstMetric.root);
  firstMetric.root.parentElement = null;
  firstMetric.root.parentNode = null;
  body.append(replacementMetric.root);
  harness.tickIntervals();
  await flushAsync();

  assert.equal(firstObserver.disconnectCount, 1);
  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.attributedGmvDisplay),
    ["$4.64K", "$4.65K"],
  );

  firstObserver.trigger([
    { type: "characterData", target: firstMetric.value.children[0] },
  ]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 2);
});

test("Attributed GMV retry keeps only the newest observation and tears down off-route", async () => {
  const body = createBody("analytics-retry-body");
  const metric = createAttributedGmvMetric("$4.64K");
  body.append(metric.root);
  let rejected = false;
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_attributed_gmv" &&
        !rejected
      ) {
        rejected = true;
        return {
          ok: false,
          error: {
            code: "NO_ACTIVE_STREAM",
            message: "Start a tracker stream.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();
  const analyticsObserver = harness.observerInstances.find(
    (observer) => observer.target === metric.root,
  );
  const valueText = metric.value.children[0];

  valueText.textContent = "$4.65K";
  analyticsObserver.trigger([
    { type: "characterData", target: valueText },
  ]);
  valueText.textContent = "$4.66K";
  analyticsObserver.trigger([
    { type: "characterData", target: valueText },
  ]);
  await flushAsync();
  harness.tickTimeouts();
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.attributedGmvDisplay),
    ["$4.64K", "$4.66K"],
  );

  harness.setPathname("/another-route");
  harness.tickIntervals();
  assert.equal(analyticsObserver.disconnectCount, 1);
  assert.equal(harness.timeouts.size, 0);
});

test("captures the current bidding variation independently of Sold Items", async () => {
  const body = createBody("bidding-only-body");
  const auction = createBiddingAuctionCard(252);
  body.append(auction.root);
  const harness = createHarness({ body, rootCount: 0 });

  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [{ type: "observe_bidding_variation", variationNumber: 252 }],
  );
  const auctionObserver = harness.observerInstances.find(
    (observer) => observer.target === auction.root,
  );

  assert.ok(auctionObserver);
  assert.deepEqual({ ...auctionObserver.observeCalls[0].options }, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  assert.doesNotMatch(
    JSON.stringify(harness.captureMessages[0].event),
    /title|product|buyer|bidAmount|bidCount|element|selector|streamId|observedAt/i,
  );
});

test("captures the live bid only after its active variation is accepted", async () => {
  const body = createBody("live-bid-body");
  const auction = createBiddingAuctionCard(252, "Bids: $28.00");
  body.append(auction.root);
  const harness = createHarness({ body, rootCount: 0 });

  await flushAsync(12);

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event),
    [
      { type: "observe_bidding_variation", variationNumber: 252 },
      {
        type: "observe_bidding_price",
        variationNumber: 252,
        bidPriceCents: 2800,
      },
    ],
  );
  assert.equal(harness.schedulerSessions.length, 1);
  assert.equal(harness.schedulerSessions[0].options.quietDelayMs, 75);
  assert.equal(harness.schedulerSessions[0].options.maxWaitMs, 250);
  assert.doesNotMatch(
    JSON.stringify(harness.captureMessages),
    /ITEMS SHOWN|buyer|bidCount|element|selector|streamId|observedAt/i,
  );
});

test("never sends a paired bid before a failed variation identity retry succeeds", async () => {
  const body = createBody("live-bid-identity-retry-body");
  const auction = createBiddingAuctionCard(252, "Bids: $28.00");
  body.append(auction.root);
  let rejectedIdentity = false;
  const harness = createHarness({
    body,
    rootCount: 0,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_bidding_variation" &&
        !rejectedIdentity
      ) {
        rejectedIdentity = true;
        return {
          ok: false,
          error: {
            code: "NO_ACTIVE_STREAM",
            message: "Start a tracker stream.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync(12);
  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.type),
    ["observe_bidding_variation"],
  );

  harness.tickTimeouts();
  await flushAsync(16);

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.type),
    [
      "observe_bidding_variation",
      "observe_bidding_variation",
      "observe_bidding_price",
    ],
  );
  assert.equal(harness.captureMessages.at(-1).event.bidPriceCents, 2800);
});

test("retains a valid bid through temporary absence and pairs the same price with a new variation", async () => {
  const body = createBody("live-bid-pairing-body");
  const auction = createBiddingAuctionCard(251, "Bids: $28.00");
  body.append(auction.root);
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
  });

  await flushAsync(12);
  const observer = harness.observerInstances.find(
    (candidate) => candidate.target === auction.root,
  );

  auction.bidPriceText.textContent = "Updating bid";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  await flushAsync();

  auction.bidPriceText.textContent = "Bids: $28.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  await flushAsync();

  assert.equal(
    harness.captureMessages.filter(
      ({ event }) => event.type === "observe_bidding_price",
    ).length,
    1,
  );

  auction.titleText.textContent = "#252 next auction";
  auction.bidPriceText.textContent = "Waiting for bids";
  observer.trigger([
    { type: "characterData", target: auction.titleText },
    { type: "characterData", target: auction.bidPriceText },
  ]);
  await flushAsync(12);

  assert.equal(harness.captureMessages.at(-1).event.type, "observe_bidding_variation");
  assert.equal(harness.captureMessages.at(-1).event.variationNumber, 252);

  auction.bidPriceText.textContent = "Bids: $28.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  await flushAsync(12);

  assert.deepEqual(
    harness.captureMessages.slice(-2).map(({ event }) => event),
    [
      { type: "observe_bidding_variation", variationNumber: 252 },
      {
        type: "observe_bidding_price",
        variationNumber: 252,
        bidPriceCents: 2800,
      },
    ],
  );
});

test("coalesces rapid bid changes to the newest price and preserves reversions", async () => {
  const body = createBody("live-bid-coalescing-body");
  const auction = createBiddingAuctionCard(251, "Bids: $28.00");
  body.append(auction.root);
  let releaseIntermediate;
  const intermediateGate = new Promise((resolve) => {
    releaseIntermediate = resolve;
  });
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_bidding_price" &&
        message.event.bidPriceCents === 2900
      ) {
        await intermediateGate;
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync(12);
  const observer = harness.observerInstances.find(
    (candidate) => candidate.target === auction.root,
  );

  auction.bidPriceText.textContent = "Bids: $29.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  await flushAsync();

  auction.bidPriceText.textContent = "Bids: $30.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  auction.bidPriceText.textContent = "Bids: $28.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  releaseIntermediate();
  await flushAsync(16);

  assert.deepEqual(
    harness.captureMessages
      .filter(({ event }) => event.type === "observe_bidding_price")
      .map(({ event }) => event.bidPriceCents),
    [2800, 2900, 2800],
  );
});

test("a failed bid delivery retries only the newest sampled price", async () => {
  const body = createBody("live-bid-retry-body");
  const auction = createBiddingAuctionCard(251, "Bids: $28.00");
  body.append(auction.root);
  let rejected = false;
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (message.event.type === "observe_bidding_price" && !rejected) {
        rejected = true;
        return {
          ok: false,
          error: {
            code: "NO_ACTIVE_STREAM",
            message: "Start a tracker stream.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync(12);
  const observer = harness.observerInstances.find(
    (candidate) => candidate.target === auction.root,
  );

  auction.bidPriceText.textContent = "Bids: $29.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  auction.bidPriceText.textContent = "Bids: $30.00";
  observer.trigger([
    { type: "characterData", target: auction.bidPriceText },
  ]);
  await flushAsync();
  harness.tickTimeouts();
  await flushAsync(16);

  assert.deepEqual(
    harness.captureMessages
      .filter(({ event }) => event.type === "observe_bidding_price")
      .map(({ event }) => event.bidPriceCents),
    [2800, 3000],
  );
});

test("deduplicates bidding observations and updates as the visible card changes", async () => {
  const body = createBody("bidding-update-body");
  const auction = createBiddingAuctionCard(251);
  body.append(auction.root);
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
  });

  await flushAsync();
  const observer = harness.observerInstances.find(
    (candidate) => candidate.target === auction.root,
  );

  observer.trigger([{ type: "characterData", target: auction.titleText }]);
  await flushAsync();
  assert.equal(harness.captureMessages.length, 1);

  auction.titleText.textContent =
    "#252 ITEMS SHOWN ON SCREEN/ ALL SALES FINAL";
  observer.trigger([{ type: "characterData", target: auction.titleText }]);
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.variationNumber),
    [251, 252],
  );
});

test("rebinds bidding capture across card and body replacement and ignores stale callbacks", async () => {
  const firstBody = createBody("first-bidding-body");
  const firstAuction = createBiddingAuctionCard(250);
  firstBody.append(firstAuction.root);
  const harness = createHarness({
    body: firstBody,
    rootCount: 0,
    scanOnRequest: true,
  });

  await flushAsync();
  const firstObserver = harness.observerInstances.find(
    (candidate) => candidate.target === firstAuction.root,
  );
  const secondAuction = createBiddingAuctionCard(251);

  firstBody.children = firstBody.children.filter(
    (child) => child !== firstAuction.root,
  );
  firstAuction.root.parentElement = null;
  firstAuction.root.parentNode = null;
  firstBody.append(secondAuction.root);
  harness.tickIntervals();
  await flushAsync();

  assert.equal(firstObserver.disconnectCount, 1);
  firstObserver.trigger([
    { type: "characterData", target: firstAuction.titleText },
  ]);
  await flushAsync();

  const secondBody = createBody("second-bidding-body");
  const thirdAuction = createBiddingAuctionCard(252);
  secondBody.append(thirdAuction.root);
  harness.setBody(secondBody);
  harness.tickIntervals();
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.variationNumber),
    [250, 251, 252],
  );

  harness.setPathname("/another-route");
  harness.tickIntervals();
  const latestObserver = harness.observerInstances.find(
    (candidate) => candidate.target === thirdAuction.root,
  );
  assert.equal(latestObserver.disconnectCount, 1);
});

test("bidding delivery retries only the newest observed variation", async () => {
  const body = createBody("bidding-retry-body");
  const auction = createBiddingAuctionCard(251);
  body.append(auction.root);
  let rejected = false;
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_bidding_variation" &&
        !rejected
      ) {
        rejected = true;
        return {
          ok: false,
          error: {
            code: "NO_ACTIVE_STREAM",
            message: "Start a tracker stream.",
          },
        };
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();
  const observer = harness.observerInstances.find(
    (candidate) => candidate.target === auction.root,
  );

  auction.titleText.textContent = "#252 next auction";
  observer.trigger([{ type: "characterData", target: auction.titleText }]);
  auction.titleText.textContent = "#253 newest auction";
  observer.trigger([{ type: "characterData", target: auction.titleText }]);
  await flushAsync();
  harness.tickTimeouts();
  await flushAsync();

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.variationNumber),
    [251, 253],
  );
});

test("bidding delivery preserves the latest card when it returns to a previously delivered variation", async () => {
  const body = createBody("bidding-reversion-body");
  const auction = createBiddingAuctionCard(251);
  body.append(auction.root);
  let releaseIntermediate;
  const intermediateGate = new Promise((resolve) => {
    releaseIntermediate = resolve;
  });
  const harness = createHarness({
    body,
    rootCount: 0,
    scanOnRequest: true,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "observe_bidding_variation" &&
        message.event.variationNumber === 252
      ) {
        await intermediateGate;
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();
  const observer = harness.observerInstances.find(
    (candidate) => candidate.target === auction.root,
  );

  auction.titleText.textContent = "#252 intermediate auction";
  observer.trigger([{ type: "characterData", target: auction.titleText }]);
  await flushAsync();
  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.variationNumber),
    [251, 252],
  );

  auction.titleText.textContent = "#251 restored auction";
  observer.trigger([{ type: "characterData", target: auction.titleText }]);
  releaseIntermediate();
  await flushAsync(12);

  assert.deepEqual(
    harness.captureMessages.map(({ event }) => event.variationNumber),
    [251, 252, 251],
  );
});

test("preserves parsed historical completions when the Sold Items root changes during delivery", async () => {
  const historicalSales = Array.from({ length: 40 }, (_, index) =>
    createSaleRow(
      `Historical Buyer has won: $${index + 1}.00 Variation: #${index + 1} Payment complete`,
    ),
  );
  let releaseFirstPayment;
  const firstPaymentGate = new Promise((resolve) => {
    releaseFirstPayment = resolve;
  });
  let firstPaymentIsBlocked = true;
  const harness = createHarness({
    rows: historicalSales,
    captureResponseHandler: async (message) => {
      if (
        message.event.type === "payment_complete" &&
        firstPaymentIsBlocked
      ) {
        firstPaymentIsBlocked = false;
        await firstPaymentGate;
      }

      return { ok: true, data: { status: "accepted" } };
    },
  });

  await flushAsync();

  assert.deepEqual(harness.captureMessages[0].event, {
    type: "observe_variations",
    variationNumbers: Array.from({ length: 40 }, (_, index) => index + 1),
  });
  assert.deepEqual(harness.captureMessages[1].event, {
    type: "payment_complete",
    variationNumber: 1,
    soldPriceCents: 100,
  });

  const firstRoot = harness.currentRoot();
  const replacementRoot = new FakeElement({
    dataTid: "m4b_space",
    name: "replacement-sold-items-without-history",
  });
  harness.currentBody().children = harness.currentBody().children.filter(
    (child) => child !== firstRoot,
  );
  firstRoot.parentElement = null;
  firstRoot.parentNode = null;
  harness.currentBody().append(replacementRoot);

  harness.tickIntervals();
  releaseFirstPayment();
  await flushAsync(12);

  assert.deepEqual(
    harness.captureMessages
      .filter(({ event }) => event.type === "payment_complete")
      .map(({ event }) => ({
        variationNumber: event.variationNumber,
        soldPriceCents: event.soldPriceCents,
      })),
    Array.from({ length: 40 }, (_, index) => ({
      variationNumber: index + 1,
      soldPriceCents: (index + 1) * 100,
    })),
  );
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
  assert.equal(harness.warnings.length, 0);
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
  assert.equal(Object.hasOwn(firstCompletedLogs[0][1], "streamId"), false);
  assert.equal(
    Object.hasOwn(firstCompletedLogs[0][1], "streamIdentityStatus"),
    false,
  );
  assert.equal(Object.hasOwn(firstCompletedLogs[0][1], "dedupeScope"), false);
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
    0,
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

test("capture remains page-read-only and delegates only extension messages", () => {
  assert.doesNotMatch(
    contentSource,
    /\bfetch\s*\(|XMLHttpRequest|runtime\.sendMessage|\.sendBeacon\s*\(/,
  );
  assert.doesNotMatch(
    contentSource,
    /\.append(?:Child)?\s*\(|\.prepend\s*\(|\.remove\s*\(|innerHTML\s*=|textContent\s*=/,
  );
});
