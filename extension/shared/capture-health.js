(function initializeCaptureHealth(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerCaptureHealth = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const CHANNEL = "tiktok-live-tracker.capture-health";
  const VERSION = 1;
  const HEARTBEAT_MS = 5_000;
  const POLL_MS = 2_000;
  const MESSAGE_MAX_AGE_MS = 3_000;
  // Source discovery/first sample can fail sooner without shortening warm-up.
  const SOURCE_GRACE_MS = 10_000;
  const INITIAL_GRACE_MS = 20_000;
  const VISIBLE_FRESH_MS = 20_000;
  const HIDDEN_FRESH_MS = 90_000;
  const VISIBLE_UNAVAILABLE_MS = 60_000;
  const HIDDEN_UNAVAILABLE_MS = 180_000;
  const UNREADABLE_UNAVAILABLE_MS = 10_000;
  const RETRY_UNAVAILABLE_MS = 60_000;
  const SOURCE_EXPIRY_MS = 180_000;
  const MAX_SOURCES = 32;
  const MAX_RETIRED_DOCUMENTS = 256;
  const STREAM_ID_PATTERN = /^local-stream:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DASHBOARD_URL_PATTERN = /^https:\/\/shop\.tiktok\.com\/streamer\/live\/product\/dashboard(?:[?#]|$)/;
  const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
  const DOCUMENT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

  class CaptureHealthError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "CaptureHealthError";
      this.code = code;
    }
  }

  function fail(code, message) { throw new CaptureHealthError(code, message); }

  function isRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  function hasExactKeys(value, keys) {
    return isRecord(value) && Object.keys(value).length === keys.length &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function validStreamId(value, nullable = false) {
    return (nullable && value === null) || (typeof value === "string" && STREAM_ID_PATTERN.test(value));
  }

  function parseRequest(value) {
    if (!isRecord(value) || value.channel !== CHANNEL || value.version !== VERSION) {
      fail("INVALID_HEALTH_MESSAGE", "The capture-health message is not supported.");
    }
    const common = ["channel", "version", "type"];
    if (value.type === "context" && hasExactKeys(value, common)) return { type: "context" };
    if (value.type === "get" && hasExactKeys(value, [...common, "streamId"]) && validStreamId(value.streamId, true)) {
      return { type: "get", streamId: value.streamId };
    }
    if (value.type === "pulse" && hasExactKeys(value, [...common, "streamId", "contextId", "sequence", "sampledAt", "sample"]) &&
        validStreamId(value.streamId) && typeof value.contextId === "string" && CONTEXT_ID_PATTERN.test(value.contextId) &&
        Number.isSafeInteger(value.sequence) && value.sequence >= 0 &&
        Number.isSafeInteger(value.sampledAt) && value.sampledAt >= 0 &&
        hasExactKeys(value.sample, ["readable", "pending", "inFlight", "retrying", "visible"]) &&
        ["readable", "inFlight", "retrying", "visible"].every((key) => typeof value.sample[key] === "boolean") &&
        Number.isSafeInteger(value.sample.pending) && value.sample.pending >= 0 && value.sample.pending <= 100_000) {
      return {
        type: "pulse", streamId: value.streamId, contextId: value.contextId, sequence: value.sequence, sampledAt: value.sampledAt,
        sample: {
          readable: value.sample.readable, pending: value.sample.pending,
          inFlight: value.sample.inFlight, retrying: value.sample.retrying, visible: value.sample.visible,
        },
      };
    }
    fail("INVALID_HEALTH_MESSAGE", "The capture-health message has invalid fields.");
  }

  function validateSender(sender, type, options) {
    if (sender?.id !== options.extensionId) {
      fail("UNAUTHORIZED_HEALTH_SENDER", "The capture-health sender is not authorized.");
    }
    if (type === "get") {
      if (sender.url !== options.sidePanelUrl) {
        fail("UNAUTHORIZED_HEALTH_SENDER", "Only the tracker panel can read capture health.");
      }
      return null;
    }
    if (sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0 ||
        typeof sender.url !== "string" || !DASHBOARD_URL_PATTERN.test(sender.url) ||
        typeof sender.documentId !== "string" || !DOCUMENT_PATTERN.test(sender.documentId) ||
        (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active")) {
      fail("UNAUTHORIZED_HEALTH_SENDER", "Only the active top-level TikTok LIVE dashboard can report capture health.");
    }
    return { tabId: sender.tab.id, documentId: sender.documentId };
  }

  function createCaptureHealthStore(options = {}) {
    const now = options.now ?? (() => Date.now());
    const createContextId = options.createContextId ?? (() => globalThis.crypto.randomUUID());
    let streamId = null;
    let sessionObservedAt = now();
    let lastInvalidationReason = "awaiting_capture";
    let contextCounter = 0;
    const sources = new Map();
    const knownDocuments = new Map();
    const retiredDocuments = new Set();
    const closedTabs = new Set();

    function retireDocument(tabId, documentId) {
      retiredDocuments.add(`${tabId}:${documentId}`);
      while (retiredDocuments.size > MAX_RETIRED_DOCUMENTS) retiredDocuments.delete(retiredDocuments.values().next().value);
    }

    function prune(at) {
      for (const [tabId, source] of sources) {
        if (at - (source.lastAt ?? source.createdAt) > SOURCE_EXPIRY_MS) sources.delete(tabId);
      }
    }

    function setSession(nextStreamId) {
      if (!validStreamId(nextStreamId, true)) fail("INVALID_HEALTH_SESSION", "The capture-health session is invalid.");
      if (nextStreamId !== streamId) {
        streamId = nextStreamId;
        sources.clear();
        sessionObservedAt = now();
        lastInvalidationReason = "awaiting_capture";
      }
    }

    function requireSource(source) {
      if (!hasExactKeys(source, ["tabId", "documentId"]) || !Number.isSafeInteger(source.tabId) || source.tabId < 0 ||
          typeof source.documentId !== "string" || !DOCUMENT_PATTERN.test(source.documentId)) {
        fail("INVALID_HEALTH_SOURCE", "The capture-health source is invalid.");
      }
      if (closedTabs.has(source.tabId) || retiredDocuments.has(`${source.tabId}:${source.documentId}`)) {
        fail("STALE_HEALTH_CONTEXT", "The capture-health document is no longer current.");
      }
    }

    function context(source) {
      requireSource(source);
      if (streamId === null) return { streamId: null, contextId: null };
      const at = now();
      prune(at);
      const prior = sources.get(source.tabId);
      if (prior?.documentId === source.documentId) return { streamId, contextId: prior.contextId };
      const knownDocument = knownDocuments.get(source.tabId);
      if (knownDocument && knownDocument !== source.documentId) retireDocument(source.tabId, knownDocument);
      if (!prior && sources.size >= MAX_SOURCES) fail("HEALTH_SOURCE_LIMIT", "Too many capture-health sources are connected.");
      const contextId = `${createContextId()}:${++contextCounter}`;
      if (!CONTEXT_ID_PATTERN.test(contextId)) fail("INVALID_HEALTH_CONTEXT", "A capture-health context could not be created.");
      knownDocuments.set(source.tabId, source.documentId);
      while (knownDocuments.size > MAX_RETIRED_DOCUMENTS) knownDocuments.delete(knownDocuments.keys().next().value);
      sources.set(source.tabId, {
        ...source, contextId, createdAt: at, lastAt: null, sequence: -1, sample: null,
        cleanAt: null, cleanCount: 0, unhealthyAt: null, unreadableAt: null,
      });
      return { streamId, contextId };
    }

    function pulse(source, request) {
      requireSource(source);
      const parsed = parseRequest({ channel: CHANNEL, version: VERSION, ...request });
      const current = sources.get(source.tabId);
      if (current && now() - (current.lastAt ?? current.createdAt) > SOURCE_EXPIRY_MS) sources.delete(source.tabId);
      if (parsed.type !== "pulse" || streamId === null || parsed.streamId !== streamId ||
          !current || !sources.has(source.tabId) || current.documentId !== source.documentId || current.contextId !== parsed.contextId ||
          parsed.sequence <= current.sequence) {
        fail("STALE_HEALTH_CONTEXT", "The capture-health context or sequence is no longer current.");
      }
      const receivedAt = now();
      if (parsed.sampledAt > receivedAt || receivedAt - parsed.sampledAt > MESSAGE_MAX_AGE_MS ||
          (current.lastAt !== null && parsed.sampledAt < current.lastAt)) {
        fail("STALE_HEALTH_SAMPLE", "The capture-health sample is no longer current.");
      }
      const at = parsed.sampledAt;
      const freshFor = current.sample?.visible === false ? HIDDEN_FRESH_MS : VISIBLE_FRESH_MS;
      const hadGap = current.lastAt !== null && at - current.lastAt > freshFor;
      const sample = parsed.sample;
      const clean = sample.readable && sample.pending === 0 && !sample.inFlight && !sample.retrying;
      if (clean) {
        if (hadGap || current.cleanAt === null) { current.cleanAt = at; current.cleanCount = 0; }
        current.cleanCount += 1;
        current.unhealthyAt = null;
        current.unreadableAt = null;
      } else {
        current.cleanAt = null;
        current.cleanCount = 0;
        if (current.unhealthyAt === null) current.unhealthyAt = at;
        if (!sample.readable && current.unreadableAt === null) current.unreadableAt = at;
        if (sample.readable) current.unreadableAt = null;
      }
      current.lastAt = at;
      current.sequence = parsed.sequence;
      current.sample = sample;
      return { accepted: true };
    }

    function invalidateTab(tabId, optionsValue = {}) {
      if (!Number.isSafeInteger(tabId) || tabId < 0) return;
      if (!sources.has(tabId) && !knownDocuments.has(tabId)) return;
      sources.delete(tabId);
      lastInvalidationReason = "source_changed";
      if (optionsValue.documentChanged === true) {
        const documentId = knownDocuments.get(tabId);
        if (documentId) retireDocument(tabId, documentId);
      }
      if (optionsValue.closed === true) {
        const documentId = knownDocuments.get(tabId);
        if (documentId) retireDocument(tabId, documentId);
        knownDocuments.delete(tabId);
        closedTabs.add(tabId);
        while (closedTabs.size > MAX_RETIRED_DOCUMENTS) closedTabs.delete(closedTabs.values().next().value);
      }
    }

    function get(expectedStreamId) {
      if (!validStreamId(expectedStreamId, true)) fail("INVALID_HEALTH_SESSION", "The requested capture-health session is invalid.");
      const result = (phase, reason) => ({ streamId, phase, reason });
      if (streamId === null) return result("not_tracking", "not_tracking");
      if (expectedStreamId !== streamId) return result("connecting", "session_mismatch");
      const at = now();
      prune(at);
      if (sources.size > 1) return result("unavailable", "ambiguous_sources");
      const source = sources.values().next().value;
      if (!source) {
        if (at - sessionObservedAt < SOURCE_GRACE_MS) return result("connecting", lastInvalidationReason);
        return result("unavailable", lastInvalidationReason === "source_changed" ? "source_changed" : "no_source");
      }
      const sample = source.sample;
      if (!sample) {
        return at - source.createdAt < SOURCE_GRACE_MS
          ? result("connecting", "awaiting_capture") : result("unavailable", "no_source");
      }
      const age = Math.max(0, at - source.lastAt);
      const freshFor = sample.visible ? VISIBLE_FRESH_MS : HIDDEN_FRESH_MS;
      const unavailableAfter = sample.visible ? VISIBLE_UNAVAILABLE_MS : HIDDEN_UNAVAILABLE_MS;
      if (age >= unavailableAfter) return result("unavailable", "stale");
      if (!sample.readable && at - source.unreadableAt >= UNREADABLE_UNAVAILABLE_MS) return result("unavailable", "unreadable");
      if (source.unhealthyAt !== null && at - source.unhealthyAt >= RETRY_UNAVAILABLE_MS) {
        return result("unavailable", sample.retrying ? "retrying" : "backlog");
      }
      if (age > freshFor) return result("loading", "stale");
      if (!sample.readable) return result("loading", "unreadable");
      if (sample.retrying) return result("loading", "retrying");
      if (sample.pending > 0 || sample.inFlight) return result("loading", "backlog");
      if (source.cleanCount >= 2 && at - source.cleanAt >= HEARTBEAT_MS && source.lastAt - source.cleanAt >= HEARTBEAT_MS) {
        return result("active", "healthy");
      }
      return result(at - sessionObservedAt <= INITIAL_GRACE_MS ? "connecting" : "loading", "warming_up");
    }

    return { setSession, context, pulse, get, invalidateTab };
  }

  return {
    CHANNEL, VERSION, HEARTBEAT_MS, POLL_MS, MESSAGE_MAX_AGE_MS, SOURCE_GRACE_MS, INITIAL_GRACE_MS, VISIBLE_FRESH_MS,
    HIDDEN_FRESH_MS, VISIBLE_UNAVAILABLE_MS, HIDDEN_UNAVAILABLE_MS,
    UNREADABLE_UNAVAILABLE_MS, RETRY_UNAVAILABLE_MS, SOURCE_EXPIRY_MS,
    CaptureHealthError, parseRequest, validateSender, createCaptureHealthStore,
  };
});
