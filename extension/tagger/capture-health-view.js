(function initializeCaptureHealthView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerCaptureHealthView = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const LABELS = Object.freeze({
    not_tracking: "Not tracking", connecting: "Connecting", active: "Capture active",
    loading: "Loading", blank: "Reload Site",
  });
  const DESCRIPTIONS = Object.freeze({
    not_tracking: "Start stream tracking to initialize dashboard capture.",
    awaiting_capture: "Waiting for the TikTok LIVE product dashboard to initialize capture.",
    initializing: "Initializing capture for this dashboard page load.",
    ready: "Capture setup is ready for this dashboard page load. This startup indicator is not an ongoing capture-health check.",
    unavailable: "Reload the TikTok LIVE dashboard to initialize capture.",
    session_mismatch: "Waiting for capture setup for the current tracker session.",
    transport_unavailable: "Waiting for dashboard capture setup confirmation.",
  });

  function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  }

  function renderBadge(badge, description, state) {
    const phase = Object.hasOwn(LABELS, state.phase) ? state.phase : "blank";
    const row = badge.closest?.(".capture-health-row");
    if (row) row.hidden = phase === "not_tracking";
    const label = LABELS[phase];
    const detail = phase === "blank" ? DESCRIPTIONS.unavailable : Object.hasOwn(DESCRIPTIONS, state.reason)
      ? DESCRIPTIONS[state.reason] : DESCRIPTIONS.transport_unavailable;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.dataset.phase !== phase) badge.dataset.phase = phase;
    if (badge.title !== detail) badge.title = detail;
    if (description.textContent !== detail) description.textContent = detail;
    badge.setAttribute?.("aria-hidden", "false");
    badge.removeAttribute?.("tabindex");
  }

  function createCaptureHealthViewController({
    runtime, protocol, onChange,
    now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
    pollMs = 2000, requestTimeoutMs = 4000, failureGraceMs = 20000,
  }) {
    let streamId = null;
    let generation = 0;
    let timer = null;
    let cancelRequest = null;
    let busy = false;
    let disposed = false;
    let failedSince = null;
    let startupPhase = "connecting";
    let loadId = null;
    const retiredLoadIds = new Set();
    let ready = false;
    let lastPublished = "";

    function publish(phase, reason) {
      const key = `${phase}:${reason}`;
      if (key !== lastPublished) {
        lastPublished = key;
        onChange({ phase, reason });
      }
    }

    function request(message) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timeout;
        const deadline = now() + requestTimeoutMs;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          clearTimeoutFn(timeout);
          if (cancelRequest === cancel) cancelRequest = null;
          // Suspension can delay callbacks. A stale response must not declare
          // a new page load ready; already-latched readiness is independent.
          if (!error && now() >= deadline) error = new Error("Health request timed out");
          if (error) reject(error); else resolve(value);
        }
        const cancel = () => finish(new Error("Health request canceled"));
        cancelRequest = cancel;
        timeout = setTimeoutFn(() => finish(new Error("Health request timed out")), requestTimeoutMs);
        try {
          const pending = runtime.sendMessage(message, (value) => {
            finish(runtime.lastError ? new Error("Health request failed") : null, value);
          });
          if (pending?.then) pending.then((value) => finish(null, value), (error) => finish(error));
        } catch (error) { finish(error); }
      });
    }

    async function refresh() {
      if (disposed || streamId === null || busy) return;
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      const epoch = generation;
      const requestedId = streamId;
      busy = true;
      try {
        const response = await request({
          channel: protocol.CHANNEL, version: protocol.VERSION,
          type: "get", streamId: requestedId,
        });
        if (disposed || epoch !== generation) return;
        const data = response?.data;
        if (!exactKeys(response, ["ok", "data"]) || response.ok !== true ||
            !exactKeys(data, ["streamId", "loadId", "phase", "reason"]) ||
            data.streamId !== requestedId || data.phase === "not_tracking" ||
            !(data.loadId === null || typeof data.loadId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(data.loadId)) ||
            (data.phase === "active" && (data.loadId === null || data.reason !== "ready")) ||
            (data.reason === "ready" && data.phase !== "active") ||
            !Object.hasOwn(LABELS, data.phase) || !Object.hasOwn(DESCRIPTIONS, data.reason)) {
          throw new Error("Invalid capture health response");
        }
        if (data.loadId !== null && retiredLoadIds.has(data.loadId)) return;
        failedSince = null;
        if (data.loadId !== null && data.loadId !== loadId) {
          if (loadId !== null) retiredLoadIds.add(loadId);
          loadId = data.loadId;
          ready = false;
        }
        if (data.phase === "active") ready = true;
        if (!ready) startupPhase = data.phase;
        publish(ready ? "active" : data.phase, ready ? "ready" : data.reason);
      } catch {
        if (disposed || epoch !== generation) return;
        if (ready) return;
        failedSince ??= now();
        const phase = startupPhase === "blank" || now() - failedSince >= failureGraceMs
          ? "blank" : startupPhase === "loading" ? "loading" : "connecting";
        publish(phase, "transport_unavailable");
      } finally {
        if (epoch === generation) {
          busy = false;
          // Keep discovering new dashboard documents, not rechecking health
          // for a document that has already completed its startup handshake.
          if (!disposed && streamId !== null) timer = setTimeoutFn(() => { void refresh(); }, pollMs);
        }
      }
    }

    function setSession(nextStreamId) {
      if (disposed || nextStreamId === streamId && lastPublished !== "") return;
      generation++;
      cancelRequest?.();
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      busy = false;
      streamId = nextStreamId;
      startupPhase = "connecting";
      loadId = null;
      retiredLoadIds.clear();
      ready = false;
      failedSince = null;
      publish(streamId === null ? "not_tracking" : "connecting", streamId === null ? "not_tracking" : "awaiting_capture");
      if (streamId !== null) void refresh();
    }

    function dispose() {
      disposed = true;
      generation++;
      cancelRequest?.();
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
    }
    return { setSession, refresh, dispose };
  }
  return {
    LABELS, DESCRIPTIONS, renderBadge, createCaptureHealthViewController,
  };
});
