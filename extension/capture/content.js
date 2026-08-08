(function initializeCaptureProbe() {
  "use strict";

  const LOG_PREFIX = "[TikTok Live Tracker]";
  const QUIET_SCAN_DELAY_MS = 150;
  const MAX_SCAN_WAIT_MS = 1000;
  const parser = globalThis.TikTokLiveTrackerSaleParser;
  const schedulerModule = globalThis.TikTokLiveTrackerCaptureScheduler;
  const emittedSales = new Map();

  let observer;
  let scheduler;

  if (!parser) {
    console.error(`${LOG_PREFIX} Sale parser failed to load.`);
    return;
  }

  if (!schedulerModule?.createCaptureScheduler) {
    console.error(`${LOG_PREFIX} Capture scheduler failed to load.`);
    return;
  }

  if (location.pathname !== "/streamer/live/event/dashboard") {
    return;
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

  function scanSoldItems() {
    collectCandidateRows().forEach((row) => {
      const sale = parser.parseSoldItemText(getElementText(row));

      if (sale?.paymentStatus === "payment_complete") {
        emitCompletedSale(sale);
      }
    });
  }

  function start() {
    if (!document.body) {
      return;
    }

    scheduler = schedulerModule.createCaptureScheduler({
      scan: scanSoldItems,
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
      onError(error) {
        console.error(`${LOG_PREFIX} Capture scan failed.`, error);
      },
      quietDelayMs: QUIET_SCAN_DELAY_MS,
      maxWaitMs: MAX_SCAN_WAIT_MS,
    });

    observer = new MutationObserver(() => scheduler.request());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    scheduler.runNow();

    console.info(
      `${LOG_PREFIX} Capture probe active on ${location.pathname}.`,
    );
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
