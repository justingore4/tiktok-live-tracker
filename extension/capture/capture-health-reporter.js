(function initializeCaptureHealthReporter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerCaptureHealthReporter = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createModule() {
  "use strict";

  const INTERVAL_MS = 5_000;
  const REQUEST_TIMEOUT_MS = 3_000;

  function hasExactKeys(value, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === null || Object.getPrototypeOf(prototype) === null) &&
      Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key));
  }

  function readContext(response) {
    if (!hasExactKeys(response, ["ok", "data"]) || response.ok !== true ||
      !hasExactKeys(response.data, ["streamId", "contextId"])) return null;
    const { streamId, contextId } = response.data;
    if (streamId === null && contextId === null) return { streamId, contextId };
    if (typeof streamId !== "string" || !/^local-stream:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(streamId) ||
      typeof contextId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(contextId)) return null;
    return { streamId, contextId };
  }

  function readSample(value) {
    if (!value || typeof value !== "object" ||
      !["readable", "inFlight", "retrying", "visible"].every((key) => typeof value[key] === "boolean") ||
      !Number.isSafeInteger(value.pending) || value.pending < 0 || value.pending > 100_000) {
      throw new Error("Invalid capture health sample.");
    }
    // Only aggregates cross the boundary. Never spread a probe result that
    // might contain DOM nodes, raw TikTok text, or buyer/item details.
    return {
      readable: value.readable, pending: value.pending, inFlight: value.inFlight,
      retrying: value.retrying, visible: value.visible,
    };
  }

  function createCaptureHealthReporter({
    runtime, protocol, getSample,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
    now = () => Date.now(),
    intervalMs = INTERVAL_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof runtime?.sendMessage !== "function" || typeof getSample !== "function" ||
      protocol?.CHANNEL !== "tiktok-live-tracker.capture-health" || protocol?.VERSION !== 1 ||
      typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function" || typeof now !== "function" ||
      !Number.isFinite(intervalMs) || intervalMs < 1 ||
      !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error("Capture health reporting dependencies are unavailable.");
    }
    let started = false;
    let disposed = false;
    let running = false;
    let timer = null;
    let cancelRequest = null;
    let sequence = 0;

    function request(message) {
      return new Promise((resolve, reject) => {
        const deadline = now() + requestTimeoutMs;
        let settled = false;
        let timeout = null;
        const settle = (error, value) => {
          if (settled) return;
          settled = true;
          if (!error && now() >= deadline) error = new Error("Capture health request timed out.");
          if (timeout !== null) clearTimeoutFn(timeout);
          if (cancelRequest === cancel) cancelRequest = null;
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => settle(new Error("Capture health reporting stopped."));
        cancelRequest = cancel;
        try {
          timeout = setTimeoutFn(() => settle(new Error("Capture health request timed out.")), requestTimeoutMs);
          const returned = runtime.sendMessage(message, (response) => {
            const lastError = runtime.lastError;
            settle(lastError ? new Error("Capture health transport is unavailable.") : null, response);
          });
          if (returned && typeof returned.then === "function") {
            returned.then((response) => settle(null, response), (error) => settle(error));
          }
        } catch (error) { settle(error); }
      });
    }

    function schedule(delay) {
      if (disposed || timer !== null) return;
      try { timer = setTimeoutFn(() => { timer = null; void cycle(); }, delay); }
      catch { disposed = true; }
    }

    async function cycle() {
      if (disposed || running) return;
      running = true;
      try {
        const context = readContext(await request({
          channel: protocol.CHANNEL, version: protocol.VERSION, type: "context",
        }));
        if (disposed || !context?.streamId) return;
        // Sampling is deliberately after the fresh context response. An old
        // timed-out callback cannot reuse a sample in a later stream.
        const sampledAt = now();
        const sample = readSample(getSample());
        if (!Number.isSafeInteger(sampledAt) || sampledAt < 0 || now() - sampledAt > REQUEST_TIMEOUT_MS) return;
        if (disposed) return;
        const response = await request({
          channel: protocol.CHANNEL, version: protocol.VERSION, type: "pulse",
          streamId: context.streamId, contextId: context.contextId, sequence: ++sequence, sampledAt, sample,
        });
        if (!hasExactKeys(response, ["ok", "data"]) || response.ok !== true ||
          !hasExactKeys(response.data, ["accepted"]) || response.data.accepted !== true) {
          return;
        }
      } catch {
        // Health reporting is advisory. Capture delivery and its retries are
        // independent and must continue even if this channel is unavailable.
      } finally {
        running = false;
        schedule(intervalMs);
      }
    }

    function start() {
      if (started || disposed) return;
      started = true;
      schedule(0);
    }

    function dispose() {
      disposed = true;
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      cancelRequest?.();
    }

    return Object.freeze({ start, dispose });
  }

  return Object.freeze({ INTERVAL_MS, REQUEST_TIMEOUT_MS, createCaptureHealthReporter });
});
