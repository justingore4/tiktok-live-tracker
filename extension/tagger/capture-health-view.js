(function initializeCaptureHealthView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerCaptureHealthView = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const RED_BADGE_HIDE_MS = 13_000;

  const LABELS = Object.freeze({
    not_tracking: "Not tracking", connecting: "Connecting", active: "Capture active",
    loading: "Loading", unavailable: "Capture unavailable",
  });
  const DESCRIPTIONS = Object.freeze({
    not_tracking: "Start stream tracking to check capture health.",
    awaiting_capture: "Waiting for fresh capture confirmation. Open the TikTok LIVE product dashboard and its Sold Items tab.",
    warming_up: "Confirming consecutive healthy dashboard checks.",
    healthy: "Recent dashboard checks succeeded and no capture deliveries are waiting. This does not guarantee every TikTok sale was captured.",
    unreadable: "The dashboard could not be read reliably. Open the TikTok LIVE product dashboard and select Sold Items; refresh it if this continues.",
    retrying: "Capture delivery is retrying. Keep the dashboard open; refresh it if this continues.",
    backlog: "Capture updates are waiting for delivery confirmation. Keep the dashboard open while they catch up.",
    stale: "Waiting for a fresh dashboard check. Bring the TikTok dashboard to the foreground; refresh it if this continues.",
    no_source: "Capture is not currently confirmed. Open the TikTok LIVE product dashboard and select Sold Items.",
    source_changed: "The dashboard was closed or navigated away. Open the TikTok LIVE product dashboard and select Sold Items.",
    ambiguous_sources: "More than one dashboard is reporting capture. Keep only the dashboard for this tracker stream open.",
    session_mismatch: "Waiting for capture confirmation for the current tracker session.",
    transport_unavailable: "Capture health could not be confirmed. Reopen the tracker and check the TikTok dashboard if this continues.",
  });

  function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  }

  function renderBadge(badge, description, state) {
    const phase = Object.hasOwn(LABELS, state.phase) ? state.phase : "unavailable";
    const row = badge.closest?.(".capture-health-row");
    if (row) row.hidden = phase === "not_tracking";
    const label = LABELS[phase];
    const detail = Object.hasOwn(DESCRIPTIONS, state.reason)
      ? DESCRIPTIONS[state.reason] : DESCRIPTIONS.transport_unavailable;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.dataset.phase !== phase) badge.dataset.phase = phase;
    if (badge.title !== detail) badge.title = detail;
    if (description.textContent !== detail) description.textContent = detail;
  }

  function createCaptureHealthBadgeVisibilityController({
    badge, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  }) {
    let redDeadline = null;
    let redHidden = false;
    let timer = null;
    let generation = 0;
    let disposed = false;

    function cancelTimer() {
      generation++;
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
    }

    function update() {
      if (disposed) return;
      // Consume the renderer's validated phase, never infer capture health.
      // This presentation flag changes neither phase nor the reserved row.
      if (badge.dataset.phase !== "unavailable") {
        cancelTimer();
        redDeadline = null;
        redHidden = false;
        badge.dataset.autoHidden = "false";
        return;
      }

      redDeadline ??= now() + RED_BADGE_HIDE_MS;
      const remaining = Math.max(0, redDeadline - now());
      redHidden ||= remaining === 0;
      badge.dataset.autoHidden = String(redHidden);
      if (redHidden) {
        cancelTimer();
        return;
      }
      if (timer !== null) return;

      const epoch = ++generation;
      timer = setTimeoutFn(() => {
        if (disposed || epoch !== generation) return;
        timer = null;
        // Recheck elapsed time after delayed/early callbacks without restarting
        // the countdown. An old red callback cannot hide a recovered badge.
        update();
      }, remaining);
    }

    function dispose() {
      disposed = true;
      cancelTimer();
    }

    return { update, dispose };
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
    let confirmed = false;
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
          // Suspension can delay the timeout callback itself. An old green
          // response must still expire by wall-clock time when the panel wakes.
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
            !exactKeys(data, ["streamId", "phase", "reason"]) ||
            data.streamId !== requestedId || data.phase === "not_tracking" ||
            !Object.hasOwn(LABELS, data.phase) || !Object.hasOwn(DESCRIPTIONS, data.reason)) {
          throw new Error("Invalid capture health response");
        }
        failedSince = null;
        confirmed = true;
        publish(data.phase, data.reason);
      } catch {
        if (disposed || epoch !== generation) return;
        failedSince ??= now();
        publish(now() - failedSince >= failureGraceMs ? "unavailable" : confirmed ? "loading" : "connecting", "transport_unavailable");
      } finally {
        if (epoch === generation) {
          busy = false;
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
      confirmed = false;
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
    LABELS, DESCRIPTIONS, RED_BADGE_HIDE_MS, renderBadge,
    createCaptureHealthBadgeVisibilityController, createCaptureHealthViewController,
  };
});
