const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const parser = require("../extension/shared/sale-parser.js");
const contentSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "capture", "content.js"),
  "utf8",
);

function createSaleRow(text) {
  const row = {
    innerText: text,
    textContent: text,
    parentElement: null,
  };
  const statusTag = {
    innerText: "Payment status",
    textContent: "Payment status",
    parentElement: row,
  };

  return { row, statusTag };
}

function createHarness({
  pathname = "/streamer/live/event/dashboard",
  schedulerAvailable = true,
  rows = [],
  scanOnRequest = false,
} = {}) {
  const calls = [];
  const infos = [];
  const warnings = [];
  const errors = [];
  const body = {};
  const observerInstances = [];
  let schedulerOptions;
  let schedulerCreateCount = 0;
  let schedulerRequestCount = 0;
  let queryCount = 0;

  const schedulerModule = schedulerAvailable
    ? {
        createCaptureScheduler(options) {
          schedulerCreateCount += 1;
          schedulerOptions = options;
          calls.push("scheduler:create");

          return {
            request() {
              schedulerRequestCount += 1;
              calls.push("scheduler:request");

              if (scanOnRequest) {
                options.scan();
              }
            },
            runNow() {
              calls.push("scheduler:run-now");
              options.scan();
            },
            dispose() {
              calls.push("scheduler:dispose");
            },
          };
        },
      }
    : undefined;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      observerInstances.push(this);
      calls.push("observer:create");
    }

    observe(target, options) {
      this.observeCalls.push({ target, options });
      calls.push("observer:observe");
    }
  }

  const context = {
    TikTokLiveTrackerSaleParser: parser,
    TikTokLiveTrackerCaptureScheduler: schedulerModule,
    location: {
      origin: "https://shop.tiktok.com",
      pathname,
    },
    document: {
      body,
      querySelectorAll(selector) {
        queryCount += 1;
        calls.push("document:query");
        assert.equal(selector, '[data-tid="m4b_tag"]');
        return rows.map(({ statusTag }) => statusTag);
      },
      addEventListener() {
        calls.push("document:add-listener");
      },
    },
    MutationObserver: FakeMutationObserver,
    window: {
      setTimeout() {
        throw new Error("The scheduler stub should own timer behavior.");
      },
      clearTimeout() {
        throw new Error("The scheduler stub should own timer behavior.");
      },
    },
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

  vm.runInNewContext(contentSource, context, {
    filename: "extension/capture/content.js",
  });

  return {
    body,
    calls,
    errors,
    infos,
    observerInstances,
    warnings,
    get queryCount() {
      return queryCount;
    },
    get schedulerCreateCount() {
      return schedulerCreateCount;
    },
    get schedulerOptions() {
      return schedulerOptions;
    },
    get schedulerRequestCount() {
      return schedulerRequestCount;
    },
  };
}

function completedSaleLogs(harness) {
  return harness.infos.filter(
    ([message]) => message === "[TikTok Live Tracker] Completed sale detected",
  );
}

test("requires the capture scheduler on the dashboard route", () => {
  const harness = createHarness({ schedulerAvailable: false });

  assert.equal(harness.schedulerCreateCount, 0);
  assert.equal(harness.observerInstances.length, 0);
  assert.deepEqual(harness.errors, [
    ["[TikTok Live Tracker] Capture scheduler failed to load."],
  ]);
});

test("does not start capture outside the exact dashboard route", () => {
  const harness = createHarness({ pathname: "/streamer/live/event/dashboard/history" });

  assert.equal(harness.schedulerCreateCount, 0);
  assert.equal(harness.observerInstances.length, 0);
  assert.equal(harness.queryCount, 0);
  assert.deepEqual(harness.errors, []);
});

test("observes the dashboard before running the initial scan", () => {
  const harness = createHarness();

  assert.equal(harness.schedulerCreateCount, 1);
  assert.ok(
    harness.calls.indexOf("observer:observe") <
      harness.calls.indexOf("scheduler:run-now"),
  );
  assert.equal(harness.queryCount, 1);
  assert.equal(harness.schedulerOptions.quietDelayMs, 150);
  assert.equal(harness.schedulerOptions.maxWaitMs, 1000);
  assert.equal(typeof harness.schedulerOptions.setTimeoutFn, "function");
  assert.equal(typeof harness.schedulerOptions.clearTimeoutFn, "function");

  const [observer] = harness.observerInstances;
  assert.equal(observer.observeCalls.length, 1);
  assert.equal(observer.observeCalls[0].target, harness.body);
  assert.deepEqual(
    JSON.parse(JSON.stringify(observer.observeCalls[0].options)),
    {
      childList: true,
      subtree: true,
      characterData: true,
    },
  );
});

test("forwards dashboard mutations to the capture scheduler", () => {
  const harness = createHarness();
  const [observer] = harness.observerInstances;

  observer.callback([{ type: "childList" }], observer);
  observer.callback([{ type: "characterData" }], observer);

  assert.equal(harness.schedulerRequestCount, 2);
  assert.equal(harness.queryCount, 1);
});

test("reports scheduled scan errors through the tracker logger", () => {
  const harness = createHarness();
  const failure = new Error("temporary DOM failure");

  harness.schedulerOptions.onError(failure);

  assert.deepEqual(harness.errors, [
    ["[TikTok Live Tracker] Capture scan failed.", failure],
  ]);
});

test("emits a pending row once when it turns green and preserves deduplication", () => {
  const sale = createSaleRow(
    "Example Buyer has won: $48.00 Variation: #250 Awaiting payment",
  );
  const harness = createHarness({ rows: [sale], scanOnRequest: true });
  const [observer] = harness.observerInstances;

  assert.equal(completedSaleLogs(harness).length, 0);

  sale.row.innerText =
    "Example Buyer has won: $48.00 Variation: #250 Payment complete";
  sale.row.textContent = sale.row.innerText;
  observer.callback([{ type: "characterData" }], observer);

  const firstCompletedLogs = completedSaleLogs(harness);
  assert.equal(firstCompletedLogs.length, 1);
  assert.equal(firstCompletedLogs[0][1].type, "completed_sale_detected");
  assert.equal(firstCompletedLogs[0][1].source, "sold_items_dom_probe");
  assert.equal(
    firstCompletedLogs[0][1].page,
    "https://shop.tiktok.com/streamer/live/event/dashboard",
  );
  assert.equal(firstCompletedLogs[0][1].variationNumber, 250);
  assert.equal(firstCompletedLogs[0][1].soldPriceCents, 4800);
  assert.equal(firstCompletedLogs[0][1].paymentStatus, "payment_complete");
  assert.equal(typeof firstCompletedLogs[0][1].observedAt, "string");

  observer.callback([{ type: "childList" }], observer);

  assert.equal(completedSaleLogs(harness).length, 1);
  assert.equal(harness.warnings.length, 0);

  sale.row.innerText =
    "Example Buyer has won: $49.00 Variation: #250 Payment complete";
  sale.row.textContent = sale.row.innerText;
  observer.callback([{ type: "characterData" }], observer);

  assert.equal(completedSaleLogs(harness).length, 1);
  assert.deepEqual(harness.warnings, [
    [
      "[TikTok Live Tracker] Conflicting completed price detected for variation #250.",
    ],
  ]);
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
