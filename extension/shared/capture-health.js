(function initializeCaptureHealth(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerCaptureHealth = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const CHANNEL = "tiktok-live-tracker.capture-health";
  const VERSION = 2;
  const POLL_MS = 2_000;
  const MESSAGE_MAX_AGE_MS = 3_000;
  // Readiness is a one-time document startup result, not ongoing capture health.
  const SOURCE_GRACE_MS = 10_000;
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
        hasExactKeys(value.sample, ["phase"]) &&
        ["loading", "ready", "blank"].includes(value.sample.phase)) {
      return {
        type: "pulse", streamId: value.streamId, contextId: value.contextId, sequence: value.sequence, sampledAt: value.sampledAt,
        sample: { phase: value.sample.phase },
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
    let ownerTabId = null;
    let load = null;
    let contextCounter = 0;
    const sources = new Map();
    const knownDocuments = new Map();
    const retiredDocuments = new Set();
    const closedTabs = new Set();

    function retireDocument(tabId, documentId) {
      retiredDocuments.add(`${tabId}:${documentId}`);
      while (retiredDocuments.size > MAX_RETIRED_DOCUMENTS) retiredDocuments.delete(retiredDocuments.values().next().value);
    }

    function setSession(nextStreamId) {
      if (!validStreamId(nextStreamId, true)) fail("INVALID_HEALTH_SESSION", "The capture-health session is invalid.");
      if (nextStreamId !== streamId) {
        streamId = nextStreamId;
        sources.clear();
        sessionObservedAt = now();
        ownerTabId = null;
        load = null;
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

    function observeOwnedDocument(source, at) {
      // The first dashboard owns this stream's readiness display. Additional
      // tabs remain authorized but cannot reset or turn that display green.
      // A closed owner may be replaced by a subsequently observed dashboard.
      if (ownerTabId === null) ownerTabId = source.tabId;
      if (ownerTabId === source.tabId &&
          (load === null || load.tabId !== source.tabId || load.documentId !== source.documentId)) {
        load = { ...source, startedAt: at, phase: null };
      }
    }

    function context(source) {
      requireSource(source);
      if (streamId === null) return { streamId: null, contextId: null };
      const at = now();
      const prior = sources.get(source.tabId);
      const acquiringOwnership = ownerTabId === null && load !== null && load.tabId !== source.tabId;
      if (prior?.documentId === source.documentId && !acquiringOwnership) {
        observeOwnedDocument(source, at);
        return { streamId, contextId: prior.contextId };
      }
      const knownDocument = knownDocuments.get(source.tabId);
      if (!prior && sources.size >= MAX_SOURCES) fail("HEALTH_SOURCE_LIMIT", "Too many capture-health sources are connected.");
      const contextId = `${createContextId()}:${++contextCounter}`;
      if (!CONTEXT_ID_PATTERN.test(contextId)) fail("INVALID_HEALTH_CONTEXT", "A capture-health context could not be created.");
      if (knownDocument && knownDocument !== source.documentId) retireDocument(source.tabId, knownDocument);
      knownDocuments.set(source.tabId, source.documentId);
      while (knownDocuments.size > MAX_RETIRED_DOCUMENTS) knownDocuments.delete(knownDocuments.keys().next().value);
      sources.set(source.tabId, {
        ...source, contextId, lastAt: null, sequence: -1,
      });
      observeOwnedDocument(source, at);
      return { streamId, contextId };
    }

    function pulse(source, request) {
      requireSource(source);
      const parsed = parseRequest({ channel: CHANNEL, version: VERSION, ...request });
      const current = sources.get(source.tabId);
      if (parsed.type !== "pulse" || streamId === null || parsed.streamId !== streamId ||
          !current || current.documentId !== source.documentId || current.contextId !== parsed.contextId ||
          parsed.sequence <= current.sequence) {
        fail("STALE_HEALTH_CONTEXT", "The capture-health context or sequence is no longer current.");
      }
      const receivedAt = now();
      if (parsed.sampledAt > receivedAt || receivedAt - parsed.sampledAt > MESSAGE_MAX_AGE_MS ||
          (current.lastAt !== null && parsed.sampledAt < current.lastAt)) {
        fail("STALE_HEALTH_SAMPLE", "The capture-health sample is no longer current.");
      }
      if (load?.tabId === source.tabId && load.documentId === source.documentId && load.phase !== "ready") {
        load.phase = parsed.sample.phase;
      }
      current.lastAt = parsed.sampledAt;
      current.sequence = parsed.sequence;
      return { accepted: true };
    }

    function invalidateTab(tabId, optionsValue = {}) {
      if (!Number.isSafeInteger(tabId) || tabId < 0) return;
      if (!sources.has(tabId) && !knownDocuments.has(tabId)) return;
      sources.delete(tabId);
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
        if (ownerTabId === tabId) ownerTabId = null;
      }
      // Navigation, closure and transport gaps retire authority, not the
      // already completed startup result. Only a new document resets load.
    }

    function get(expectedStreamId) {
      if (!validStreamId(expectedStreamId, true)) fail("INVALID_HEALTH_SESSION", "The requested capture-health session is invalid.");
      const result = (phase, reason) => ({ streamId, loadId: load?.documentId ?? null, phase, reason });
      if (streamId === null) return result("not_tracking", "not_tracking");
      if (expectedStreamId !== streamId) return result("connecting", "session_mismatch");
      const at = now();
      if (load?.phase === "ready") return result("active", "ready");
      if (load?.phase === "loading") return result("loading", "initializing");
      if (load?.phase === "blank") return result("blank", "unavailable");
      if (at - (load?.startedAt ?? sessionObservedAt) >= SOURCE_GRACE_MS) return result("blank", "unavailable");
      return result("connecting", "awaiting_capture");
    }

    return { setSession, context, pulse, get, invalidateTab };
  }

  return {
    CHANNEL, VERSION, POLL_MS, MESSAGE_MAX_AGE_MS, SOURCE_GRACE_MS,
    LOAD_ID_PATTERN: DOCUMENT_PATTERN,
    CaptureHealthError, parseRequest, validateSender, createCaptureHealthStore,
  };
});
