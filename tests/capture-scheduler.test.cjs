const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCaptureScheduler,
} = require("../extension/capture/capture-scheduler.js");

function createFakeTimers() {
  let nextTimerId = 1;
  let now = 0;
  const pending = new Map();

  function setTimeoutFn(callback, delayMs) {
    const timerId = nextTimerId;
    nextTimerId += 1;
    pending.set(timerId, { callback, delayMs, dueAt: now + delayMs });
    return timerId;
  }

  function clearTimeoutFn(timerId) {
    pending.delete(timerId);
  }

  function getTimer(timerId) {
    return pending.get(timerId);
  }

  function getTimersByDelay(delayMs) {
    return [...pending.entries()].filter(
      ([, timer]) => timer.delayMs === delayMs,
    );
  }

  function fire(timerId) {
    const timer = pending.get(timerId);

    if (!timer) {
      throw new Error(`Timer ${timerId} is not pending.`);
    }

    pending.delete(timerId);
    now = Math.max(now, timer.dueAt);
    timer.callback();
  }

  function advanceBy(elapsedMs) {
    const targetTime = now + elapsedMs;

    while (true) {
      const nextTimer = [...pending.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];

      if (!nextTimer) {
        break;
      }

      const [timerId, timer] = nextTimer;
      pending.delete(timerId);
      now = timer.dueAt;
      timer.callback();
    }

    now = targetTime;
  }

  return {
    advanceBy,
    clearTimeoutFn,
    fire,
    getTimer,
    getTimersByDelay,
    pending,
    setTimeoutFn,
  };
}

function createScheduler(overrides = {}) {
  const timers = createFakeTimers();
  const scans = [];
  const errors = [];
  const scheduler = createCaptureScheduler({
    scan() {
      scans.push("scan");
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onError(error) {
      errors.push(error);
    },
    ...overrides,
  });

  return { errors, scans, scheduler, timers };
}

test("coalesces a burst and scans after the final quiet delay", () => {
  const { scans, scheduler, timers } = createScheduler();

  assert.equal(scheduler.request(), true);
  const [[maxTimerId]] = timers.getTimersByDelay(1000);
  const [[firstQuietTimerId]] = timers.getTimersByDelay(150);

  for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
    assert.equal(scheduler.request(), true);
  }

  const [[currentMaxTimerId]] = timers.getTimersByDelay(1000);
  const [[currentQuietTimerId]] = timers.getTimersByDelay(150);

  assert.equal(currentMaxTimerId, maxTimerId);
  assert.notEqual(currentQuietTimerId, firstQuietTimerId);
  assert.equal(timers.pending.size, 2);

  timers.fire(currentQuietTimerId);

  assert.equal(scans.length, 1);
  assert.equal(timers.pending.size, 0);
});

test("continuous requests cannot postpone a scan beyond the maximum wait", () => {
  const { scans, scheduler, timers } = createScheduler();

  scheduler.request();
  const [[maxTimerId, maxTimer]] = timers.getTimersByDelay(1000);

  for (let elapsedMs = 100; elapsedMs <= 900; elapsedMs += 100) {
    timers.advanceBy(100);
    scheduler.request();
  }

  assert.equal(timers.getTimer(maxTimerId), maxTimer);
  assert.equal(timers.getTimersByDelay(1000).length, 1);
  assert.equal(scans.length, 0);

  timers.advanceBy(99);
  assert.equal(scans.length, 0);

  timers.advanceBy(1);

  assert.equal(scans.length, 1);
  assert.equal(timers.pending.size, 0);

  scheduler.request();
  timers.advanceBy(150);

  assert.equal(scans.length, 2);
  assert.equal(timers.pending.size, 0);
});

test("ignores cleared quiet callbacks and stale callbacks from prior batches", () => {
  const { scans, scheduler, timers } = createScheduler();

  scheduler.request();
  const [[firstMaxTimerId, firstMaxTimer]] = timers.getTimersByDelay(1000);
  const [[firstQuietTimerId, firstQuietTimer]] = timers.getTimersByDelay(150);

  scheduler.request();
  const [[currentQuietTimerId]] = timers.getTimersByDelay(150);

  assert.equal(timers.getTimer(firstQuietTimerId), undefined);
  firstQuietTimer.callback();
  assert.equal(scans.length, 0);
  assert.equal(timers.pending.size, 2);

  timers.fire(currentQuietTimerId);
  assert.equal(scans.length, 1);

  scheduler.request();
  const [[secondMaxTimerId]] = timers.getTimersByDelay(1000);
  const [[secondQuietTimerId]] = timers.getTimersByDelay(150);

  firstMaxTimer.callback();
  assert.equal(scans.length, 1);
  assert.equal(timers.getTimer(secondMaxTimerId).delayMs, 1000);
  assert.equal(timers.getTimer(secondQuietTimerId).delayMs, 150);

  timers.fire(secondQuietTimerId);
  assert.equal(scans.length, 2);
  assert.equal(timers.pending.size, 0);
  assert.equal(timers.getTimer(firstMaxTimerId), undefined);
});

test("clears the batch before scanning so a scan can request another batch", () => {
  const timers = createFakeTimers();
  let scanCount = 0;
  let scheduler;

  scheduler = createCaptureScheduler({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    scan() {
      scanCount += 1;

      if (scanCount === 1) {
        scheduler.request();
      }
    },
  });

  scheduler.request();
  const [[firstQuietTimerId]] = timers.getTimersByDelay(150);
  timers.fire(firstQuietTimerId);

  assert.equal(scanCount, 1);
  assert.equal(timers.getTimersByDelay(150).length, 1);
  assert.equal(timers.getTimersByDelay(1000).length, 1);

  const [[secondQuietTimerId]] = timers.getTimersByDelay(150);
  timers.fire(secondQuietTimerId);
  assert.equal(scanCount, 2);
});

test("reports a thrown scan and remains available for the next batch", () => {
  const timers = createFakeTimers();
  const scanError = new Error("scan failed");
  const errors = [];
  let scanCount = 0;
  const scheduler = createCaptureScheduler({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onError(error) {
      errors.push(error);
    },
    scan() {
      scanCount += 1;

      if (scanCount === 1) {
        throw scanError;
      }
    },
  });

  scheduler.request();
  let [[quietTimerId]] = timers.getTimersByDelay(150);
  assert.doesNotThrow(() => timers.fire(quietTimerId));
  assert.deepEqual(errors, [scanError]);

  scheduler.request();
  [[quietTimerId]] = timers.getTimersByDelay(150);
  timers.fire(quietTimerId);

  assert.equal(scanCount, 2);
  assert.equal(timers.pending.size, 0);
});

test("an error reporter that throws cannot break scheduling", () => {
  const timers = createFakeTimers();
  let scanCount = 0;
  const scheduler = createCaptureScheduler({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onError() {
      throw new Error("reporter failed");
    },
    scan() {
      scanCount += 1;
      throw new Error("scan failed");
    },
  });

  assert.doesNotThrow(() => scheduler.runNow());
  assert.equal(scheduler.request(), true);
  const [[quietTimerId]] = timers.getTimersByDelay(150);
  assert.doesNotThrow(() => timers.fire(quietTimerId));
  assert.equal(scanCount, 2);
});

test("runNow cancels a pending batch and scans immediately", () => {
  const { scans, scheduler, timers } = createScheduler();

  scheduler.request();
  const callbacks = [...timers.pending.values()].map((timer) => timer.callback);

  assert.equal(scheduler.runNow(), true);
  assert.equal(scans.length, 1);
  assert.equal(timers.pending.size, 0);

  callbacks.forEach((callback) => callback());
  assert.equal(scans.length, 1);

  assert.equal(scheduler.runNow(), true);
  assert.equal(scans.length, 2);
});

test("dispose cancels pending work and permanently disables the scheduler", () => {
  const { scans, scheduler, timers } = createScheduler();

  assert.equal(Object.isFrozen(scheduler), true);
  scheduler.request();
  const callbacks = [...timers.pending.values()].map((timer) => timer.callback);

  assert.equal(scheduler.dispose(), true);
  assert.equal(timers.pending.size, 0);
  assert.equal(scheduler.dispose(), false);
  assert.equal(scheduler.request(), false);
  assert.equal(scheduler.runNow(), false);

  callbacks.forEach((callback) => callback());
  assert.equal(scans.length, 0);
});

test("validates required dependencies and scheduler timings", () => {
  const validOptions = {
    scan() {},
    setTimeoutFn() {
      return 1;
    },
    clearTimeoutFn() {},
  };

  assert.throws(
    () => createCaptureScheduler(),
    /options must be an object/i,
  );
  assert.throws(
    () => createCaptureScheduler({ ...validOptions, scan: null }),
    /scan must be a function/i,
  );
  assert.throws(
    () => createCaptureScheduler({ ...validOptions, setTimeoutFn: null }),
    /setTimeoutFn must be a function/i,
  );
  assert.throws(
    () => createCaptureScheduler({ ...validOptions, clearTimeoutFn: null }),
    /clearTimeoutFn must be a function/i,
  );
  assert.throws(
    () => createCaptureScheduler({ ...validOptions, onError: "log" }),
    /onError must be a function/i,
  );

  for (const invalidDelay of [-1, Number.NaN, Number.POSITIVE_INFINITY, "150"]) {
    assert.throws(
      () => createCaptureScheduler({
        ...validOptions,
        quietDelayMs: invalidDelay,
      }),
      /quietDelayMs must be a finite, non-negative number/i,
    );
  }

  for (const invalidDelay of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
    assert.throws(
      () => createCaptureScheduler({
        ...validOptions,
        maxWaitMs: invalidDelay,
      }),
      /maxWaitMs must be a finite, non-negative number/i,
    );
  }

  assert.throws(
    () => createCaptureScheduler({
      ...validOptions,
      quietDelayMs: 200,
      maxWaitMs: 199,
    }),
    /maxWaitMs must be greater than or equal to quietDelayMs/i,
  );
});
