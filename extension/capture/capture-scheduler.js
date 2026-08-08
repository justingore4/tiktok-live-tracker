(function initializeCaptureScheduler(root, factory) {
  const scheduler = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = scheduler;
  }

  root.TikTokLiveTrackerCaptureScheduler = scheduler;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createCaptureSchedulerModule() {
    "use strict";

    const DEFAULT_QUIET_DELAY_MS = 150;
    const DEFAULT_MAX_WAIT_MS = 1000;

    function assertDelay(value, name) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${name} must be a finite, non-negative number.`);
      }
    }

    function createCaptureScheduler(options) {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Capture scheduler options must be an object.");
      }

      const {
        scan,
        setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
        clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
        onError,
        quietDelayMs = DEFAULT_QUIET_DELAY_MS,
        maxWaitMs = DEFAULT_MAX_WAIT_MS,
      } = options;

      if (typeof scan !== "function") {
        throw new TypeError("scan must be a function.");
      }

      if (typeof setTimeoutFn !== "function") {
        throw new TypeError("setTimeoutFn must be a function.");
      }

      if (typeof clearTimeoutFn !== "function") {
        throw new TypeError("clearTimeoutFn must be a function.");
      }

      if (onError !== undefined && typeof onError !== "function") {
        throw new TypeError("onError must be a function when provided.");
      }

      assertDelay(quietDelayMs, "quietDelayMs");
      assertDelay(maxWaitMs, "maxWaitMs");

      if (maxWaitMs < quietDelayMs) {
        throw new RangeError("maxWaitMs must be greater than or equal to quietDelayMs.");
      }

      let activeBatchToken = null;
      let activeQuietToken = null;
      let quietTimerId = null;
      let maxTimerId = null;
      let disposed = false;

      function reportError(error) {
        if (!onError) {
          return;
        }

        try {
          onError(error);
        } catch {
          // Error reporting must not break future capture scheduling.
        }
      }

      function clearTimer(timerId) {
        if (timerId === null) {
          return;
        }

        try {
          clearTimeoutFn(timerId);
        } catch (error) {
          reportError(error);
        }
      }

      function clearBatch(batchToken) {
        if (activeBatchToken !== batchToken) {
          return false;
        }

        const pendingQuietTimerId = quietTimerId;
        const pendingMaxTimerId = maxTimerId;

        activeBatchToken = null;
        activeQuietToken = null;
        quietTimerId = null;
        maxTimerId = null;

        clearTimer(pendingQuietTimerId);

        if (pendingMaxTimerId !== pendingQuietTimerId) {
          clearTimer(pendingMaxTimerId);
        }

        return true;
      }

      function executeScan() {
        try {
          scan();
        } catch (error) {
          reportError(error);
        }
      }

      function completeBatch(batchToken) {
        if (disposed || !clearBatch(batchToken)) {
          return false;
        }

        executeScan();
        return true;
      }

      function scheduleMaxTimer(batchToken) {
        try {
          const timerId = setTimeoutFn(
            () => completeBatch(batchToken),
            maxWaitMs,
          );

          if (activeBatchToken === batchToken) {
            maxTimerId = timerId;
          } else {
            clearTimer(timerId);
          }

          return true;
        } catch (error) {
          clearBatch(batchToken);
          reportError(error);
          return false;
        }
      }

      function scheduleQuietTimer(batchToken, quietToken) {
        try {
          const timerId = setTimeoutFn(() => {
            if (
              activeBatchToken === batchToken &&
              activeQuietToken === quietToken
            ) {
              completeBatch(batchToken);
            }
          }, quietDelayMs);

          if (
            activeBatchToken === batchToken &&
            activeQuietToken === quietToken
          ) {
            quietTimerId = timerId;
          } else {
            clearTimer(timerId);
          }

          return true;
        } catch (error) {
          clearBatch(batchToken);
          reportError(error);
          return false;
        }
      }

      function request() {
        if (disposed) {
          return false;
        }

        let batchToken = activeBatchToken;

        if (batchToken === null) {
          batchToken = Object.freeze({});
          activeBatchToken = batchToken;

          if (!scheduleMaxTimer(batchToken)) {
            return false;
          }

          if (activeBatchToken !== batchToken) {
            return true;
          }
        }

        const previousQuietTimerId = quietTimerId;
        const quietToken = Object.freeze({});

        activeQuietToken = quietToken;
        quietTimerId = null;
        clearTimer(previousQuietTimerId);

        return scheduleQuietTimer(batchToken, quietToken);
      }

      function runNow() {
        if (disposed) {
          return false;
        }

        if (activeBatchToken !== null) {
          clearBatch(activeBatchToken);
        }

        executeScan();
        return true;
      }

      function dispose() {
        if (disposed) {
          return false;
        }

        disposed = true;

        if (activeBatchToken !== null) {
          clearBatch(activeBatchToken);
        }

        return true;
      }

      return Object.freeze({
        request,
        runNow,
        dispose,
      });
    }

    return Object.freeze({
      createCaptureScheduler,
    });
  },
);
