(function initializeCaptureProbe() {
  "use strict";

  const LOG_PREFIX = "[TikTok Live Tracker]";
  const CAPTURE_ORIGIN = "https://shop.tiktok.com";
  const CAPTURE_PATH = "/streamer/live/event/dashboard";
  const LIFECYCLE_INTERVAL_MS = 250;
  const QUIET_SCAN_DELAY_MS = 150;
  const MAX_SCAN_WAIT_MS = 1000;
  const SINGLETON_KEY = "__tiktokLiveTrackerCaptureProbeInstance__";

  if (location.origin !== CAPTURE_ORIGIN) {
    return;
  }

  if (globalThis[SINGLETON_KEY]) {
    return;
  }

  const parser = globalThis.TikTokLiveTrackerSaleParser;
  const schedulerModule = globalThis.TikTokLiveTrackerCaptureScheduler;

  if (!parser) {
    console.error(`${LOG_PREFIX} Sale parser failed to load.`);
    return;
  }

  if (!schedulerModule?.createCaptureScheduler) {
    console.error(`${LOG_PREFIX} Capture scheduler failed to load.`);
    return;
  }

  const emittedSales = new Map();
  const singletonToken = Object.freeze({});

  let captureSession = null;
  let lifecycleObserver = null;
  let observedDocumentElement = null;

  globalThis[SINGLETON_KEY] = singletonToken;

  function reportError(message, error) {
    try {
      console.error(`${LOG_PREFIX} ${message}`, error);
    } catch {
      // Error reporting must not interrupt capture recovery.
    }
  }

  function isCaptureRoute() {
    return (
      location.origin === CAPTURE_ORIGIN && location.pathname === CAPTURE_PATH
    );
  }

  function getElementText(element) {
    return element.innerText || element.textContent || "";
  }

  function findNearestSaleRow(element) {
    let candidate = element;

    for (let depth = 0; candidate && depth < 12; depth += 1) {
      if (parser.parseSoldItemText(getElementText(candidate))) {
        return candidate;
      }

      candidate = candidate.parentElement;
    }

    return null;
  }

  function collectCandidateRows() {
    const candidates = new Set();

    document.querySelectorAll('[data-tid="m4b_tag"]').forEach((statusTag) => {
      const row = findNearestSaleRow(statusTag);

      if (row) {
        candidates.add(row);
      }
    });

    return candidates;
  }

  function createFingerprint(sale) {
    return `${sale.variationNumber}:${sale.soldPriceCents}:${sale.paymentStatus}`;
  }

  function emitCompletedSale(sale) {
    const key = String(sale.variationNumber);
    const fingerprint = createFingerprint(sale);

    if (emittedSales.get(key) === fingerprint) {
      return;
    }

    if (emittedSales.has(key)) {
      console.warn(
        `${LOG_PREFIX} Conflicting completed price detected for variation #${sale.variationNumber}.`,
      );
      return;
    }

    emittedSales.set(key, fingerprint);

    const event = {
      type: "completed_sale_detected",
      source: "sold_items_dom_probe",
      page: `${location.origin}${location.pathname}`,
      observedAt: new Date().toISOString(),
      ...sale,
    };

    console.info(`${LOG_PREFIX} Completed sale detected`, event);
  }

  function stopCapture() {
    const session = captureSession;

    if (!session) {
      return false;
    }

    captureSession = null;

    try {
      session.observer.disconnect();
    } catch (error) {
      reportError("Capture observer cleanup failed.", error);
    }

    try {
      session.scheduler.dispose();
    } catch (error) {
      reportError("Capture scheduler cleanup failed.", error);
    }

    return true;
  }

  function reconcileCapture() {
    const targetBody = isCaptureRoute() ? document.body : null;

    if (!targetBody) {
      return stopCapture();
    }

    if (captureSession?.body === targetBody) {
      return false;
    }

    stopCapture();
    return startCapture(targetBody);
  }

  function scanSoldItems(session) {
    if (
      !session ||
      captureSession !== session ||
      !isCaptureRoute() ||
      document.body !== session.body
    ) {
      reconcileCapture();
      return;
    }

    collectCandidateRows().forEach((row) => {
      const sale = parser.parseSoldItemText(getElementText(row));

      if (sale?.paymentStatus === "payment_complete") {
        emitCompletedSale(sale);
      }
    });
  }

  function startCapture(body) {
    if (!body || !isCaptureRoute() || document.body !== body) {
      return false;
    }

    if (captureSession?.body === body) {
      return false;
    }

    let scheduler;
    let observer;
    let session;

    try {
      scheduler = schedulerModule.createCaptureScheduler({
        scan() {
          scanSoldItems(session);
        },
        setTimeoutFn: window.setTimeout.bind(window),
        clearTimeoutFn: window.clearTimeout.bind(window),
        onError(error) {
          reportError("Capture scan failed.", error);
        },
        quietDelayMs: QUIET_SCAN_DELAY_MS,
        maxWaitMs: MAX_SCAN_WAIT_MS,
      });

      observer = new MutationObserver(() => {
        if (
          captureSession !== session ||
          !isCaptureRoute() ||
          document.body !== body
        ) {
          reconcileCapture();
          return;
        }

        try {
          scheduler.request();
        } catch (error) {
          reportError("Capture scheduling failed.", error);
        }
      });

      session = Object.freeze({ body, observer, scheduler });
      captureSession = session;

      observer.observe(body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      scheduler.runNow();

      console.info(`${LOG_PREFIX} Capture probe active on ${location.pathname}.`);
      return true;
    } catch (error) {
      if (session && captureSession === session) {
        stopCapture();
      } else {
        if (observer) {
          try {
            observer.disconnect();
          } catch (cleanupError) {
            reportError("Capture observer cleanup failed.", cleanupError);
          }
        }

        if (scheduler) {
          try {
            scheduler.dispose();
          } catch (cleanupError) {
            reportError("Capture scheduler cleanup failed.", cleanupError);
          }
        }
      }

      reportError("Capture startup failed.", error);
      return false;
    }
  }

  function ensureLifecycleObserver() {
    const documentElement = document.documentElement;

    if (!documentElement) {
      return false;
    }

    if (
      lifecycleObserver &&
      observedDocumentElement === documentElement
    ) {
      return true;
    }

    const previousObserver = lifecycleObserver;

    lifecycleObserver = null;
    observedDocumentElement = null;

    if (previousObserver) {
      try {
        previousObserver.disconnect();
      } catch (error) {
        reportError("Lifecycle observer cleanup failed.", error);
      }
    }

    let nextObserver;

    try {
      nextObserver = new MutationObserver(handleLifecycleSignal);
      nextObserver.observe(documentElement, { childList: true });
      lifecycleObserver = nextObserver;
      observedDocumentElement = documentElement;
      return true;
    } catch (error) {
      if (nextObserver) {
        try {
          nextObserver.disconnect();
        } catch (cleanupError) {
          reportError("Lifecycle observer cleanup failed.", cleanupError);
        }
      }

      reportError("Lifecycle observer startup failed.", error);
      return false;
    }
  }

  function handleLifecycleSignal() {
    ensureLifecycleObserver();
    reconcileCapture();
  }

  function addLifecycleListener(target, eventName) {
    if (typeof target?.addEventListener !== "function") {
      return;
    }

    try {
      target.addEventListener(eventName, handleLifecycleSignal);
    } catch (error) {
      reportError(`Lifecycle ${eventName} listener failed.`, error);
    }
  }

  addLifecycleListener(window, "popstate");
  addLifecycleListener(window, "hashchange");
  addLifecycleListener(window, "pageshow");
  addLifecycleListener(document, "visibilitychange");

  if (typeof window.setInterval === "function") {
    try {
      window.setInterval(handleLifecycleSignal, LIFECYCLE_INTERVAL_MS);
    } catch (error) {
      reportError("Lifecycle interval startup failed.", error);
    }
  }

  handleLifecycleSignal();
})();
