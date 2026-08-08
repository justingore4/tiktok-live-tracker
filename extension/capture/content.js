(function initializeCaptureProbe() {
  "use strict";

  const LOG_PREFIX = "[TikTok Live Tracker]";
  const CAPTURE_ORIGIN = "https://shop.tiktok.com";
  const CAPTURE_PATH = "/streamer/live/product/dashboard";
  const LIFECYCLE_INTERVAL_MS = 250;
  const QUIET_SCAN_DELAY_MS = 150;
  const MAX_SCAN_WAIT_MS = 1000;
  const DELIVERY_RETRY_DELAY_MS = 1000;
  const MAX_DELIVERY_RETRY_DELAY_MS = 5000;
  const EXPECTED_CAPTURE_RETRY_CODES = new Set([
    "CAPTURE_TRANSPORT_ERROR",
    "NO_ACTIVE_STREAM",
    "STATE_NOT_INITIALIZED",
  ]);
  const SINGLETON_KEY = "__tiktokLiveTrackerCaptureProbeInstance__";

  if (location.origin !== CAPTURE_ORIGIN) {
    return;
  }

  if (globalThis[SINGLETON_KEY]) {
    return;
  }

  const parser = globalThis.TikTokLiveTrackerSaleParser;
  const candidateLocator = globalThis.TikTokLiveTrackerSaleCandidateLocator;
  const eventRegistryModule =
    globalThis.TikTokLiveTrackerCaptureEventRegistry;
  const schedulerModule = globalThis.TikTokLiveTrackerCaptureScheduler;
  const captureProtocol = globalThis.TikTokLiveTrackerCaptureProtocol;
  const captureClientModule = globalThis.TikTokLiveTrackerCaptureClient;

  if (!parser) {
    console.error(`${LOG_PREFIX} Sale parser failed to load.`);
    return;
  }

  if (
    !candidateLocator?.locateCompletedSales ||
    !candidateLocator?.locateObservedVariations ||
    !candidateLocator?.locateUniqueVisibleSoldItemsRoot
  ) {
    console.error(`${LOG_PREFIX} Sale candidate locator failed to load.`);
    return;
  }

  if (
    !eventRegistryModule?.createCaptureEventRegistry ||
    !eventRegistryModule?.createPageScope
  ) {
    console.error(`${LOG_PREFIX} Capture event registry failed to load.`);
    return;
  }

  if (!schedulerModule?.createCaptureScheduler) {
    console.error(`${LOG_PREFIX} Capture scheduler failed to load.`);
    return;
  }

  if (!captureProtocol?.createCaptureMessage) {
    console.error(`${LOG_PREFIX} Capture protocol failed to load.`);
    return;
  }

  if (!captureClientModule?.createCaptureClient) {
    console.error(`${LOG_PREFIX} Capture client failed to load.`);
    return;
  }

  let captureClient;

  try {
    captureClient = captureClientModule.createCaptureClient({
      protocol: captureProtocol,
      runtime: globalThis.chrome?.runtime,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} Capture client failed to initialize.`, error);
    return;
  }

  const eventRegistry = eventRegistryModule.createCaptureEventRegistry();
  const captureScope = eventRegistryModule.createPageScope(
    "current-dashboard-document",
  );
  const singletonToken = Object.freeze({});

  let captureSession = null;
  let lifecycleObserver = null;
  let observedDocumentElement = null;
  let lastRootDiscoveryStatus = null;

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

  function emitCompletedSale(sale) {
    const registryResult = eventRegistry.record(captureScope, sale);

    if (
      registryResult.status === "duplicate" ||
      registryResult.status === "duplicate_conflict"
    ) {
      return;
    }

    if (registryResult.status === "conflict") {
      console.warn(
        `${LOG_PREFIX} Conflicting completed price detected for variation #${sale.variationNumber} within the current page scope.`,
      );
      return;
    }

    const event = {
      type: "completed_sale_detected",
      source: "sold_items_dom_probe",
      page: `${location.origin}${location.pathname}`,
      observedAt: new Date().toISOString(),
      ...sale,
    };

    console.info(`${LOG_PREFIX} Completed sale detected`, event);
  }

  function isCurrentSession(session) {
    try {
      return (
        Boolean(session) &&
        captureSession === session &&
        isCaptureRoute() &&
        document.body === session.body &&
        session.body.contains(session.root)
      );
    } catch {
      return false;
    }
  }

  function paymentFingerprint(sale) {
    return `${sale.variationNumber}:${sale.soldPriceCents}`;
  }

  function reportDeliveryError(session, message, error) {
    const code =
      typeof error?.code === "string"
        ? error.code
        : "CAPTURE_DELIVERY_FAILED";

    if (session?.reportedDeliveryErrorCodes?.has(code)) {
      return;
    }

    session?.reportedDeliveryErrorCodes?.add(code);
    const detail = `${message} Retrying automatically (${code}).`;

    try {
      if (EXPECTED_CAPTURE_RETRY_CODES.has(code)) {
        console.info(`${LOG_PREFIX} ${detail}`);
      } else {
        console.error(`${LOG_PREFIX} ${detail}`);
      }
    } catch {
      // Diagnostics must not interrupt capture delivery.
    }
  }

  function cancelDeliveryRetry(session) {
    if (!session || session.deliveryRetryTimerId === null) {
      return false;
    }

    const timerId = session.deliveryRetryTimerId;
    session.deliveryRetryTimerId = null;

    try {
      window.clearTimeout(timerId);
    } catch (error) {
      reportError("Capture delivery retry cleanup failed.", error);
    }

    return true;
  }

  function reportVariationSync(variationNumbers) {
    try {
      console.info(
        `${LOG_PREFIX} Sold Items variations synchronized.`,
        { variationNumbers: [...variationNumbers] },
      );
    } catch {
      // Diagnostics must not interrupt capture delivery.
    }
  }

  function reportRootDiscoveryStatus(status) {
    const description =
      {
        ambiguous: "more than one visible Sold Items panel was found",
        not_found: "no visible Sold Items panel was found",
        unsafe: "Sold Items panel visibility could not be verified",
      }[status] ?? "the Sold Items panel is not ready";

    try {
      console.info(
        `${LOG_PREFIX} Sold Items capture paused: ${description}.`,
      );
    } catch {
      // Diagnostics must not interrupt capture recovery.
    }
  }

  function scheduleDeliveryRetry(session) {
    if (
      !isCurrentSession(session) ||
      session.deliveryRetryTimerId !== null
    ) {
      return false;
    }

    const delayMs = session.deliveryRetryDelayMs;

    try {
      session.deliveryRetryTimerId = window.setTimeout(() => {
        session.deliveryRetryTimerId = null;

        if (!isCurrentSession(session)) {
          return;
        }

        if (session.deliveryRunning) {
          scheduleDeliveryRetry(session);
          return;
        }

        if (
          session.queuedVariations.size === 0 &&
          session.queuedPayments.size === 0
        ) {
          return;
        }

        session.deliveryRunning = true;
        void drainCaptureQueue(session).catch((error) => {
          reportDeliveryError(
            session,
            "Capture delivery queue failed.",
            error,
          );
        });
      }, delayMs);
      session.deliveryRetryDelayMs = Math.min(
        delayMs * 2,
        MAX_DELIVERY_RETRY_DELAY_MS,
      );
      return true;
    } catch (error) {
      reportDeliveryError(
        session,
        "Capture delivery retry failed.",
        error,
      );
      return false;
    }
  }

  async function drainCaptureQueue(session) {
    try {
      while (
        isCurrentSession(session) &&
        (session.queuedVariations.size > 0 ||
          session.queuedPayments.size > 0)
      ) {
        const variationNumbers = [...session.queuedVariations].filter(
          (variationNumber) =>
            !session.deliveredVariations.has(variationNumber),
        );
        const completedSales = [...session.queuedPayments.values()].filter(
          (sale) =>
            !session.deliveredPayments.has(paymentFingerprint(sale)),
        );

        session.queuedVariations.clear();
        session.queuedPayments.clear();

        let observationsDelivered = true;

        if (variationNumbers.length > 0) {
          try {
            await captureClient.observeVariations(variationNumbers);

            if (!isCurrentSession(session)) {
              return;
            }

            variationNumbers.forEach((variationNumber) => {
              session.deliveredVariations.add(variationNumber);
            });
            session.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
            reportVariationSync(variationNumbers);
          } catch (error) {
            observationsDelivered = false;
            variationNumbers.forEach((variationNumber) => {
              session.queuedVariations.add(variationNumber);
            });
            completedSales.forEach((sale) => {
              session.queuedPayments.set(paymentFingerprint(sale), sale);
            });
            reportDeliveryError(
              session,
              "Variation observation delivery failed.",
              error,
            );
            scheduleDeliveryRetry(session);
          }
        }

        if (!observationsDelivered || !isCurrentSession(session)) {
          return;
        }

        for (const sale of completedSales) {
          if (!isCurrentSession(session)) {
            return;
          }

          const fingerprint = paymentFingerprint(sale);

          try {
            await captureClient.recordPaymentComplete({
              variationNumber: sale.variationNumber,
              soldPriceCents: sale.soldPriceCents,
            });

            if (!isCurrentSession(session)) {
              return;
            }

            session.deliveredPayments.add(fingerprint);
            session.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
          } catch (error) {
            session.queuedPayments.set(fingerprint, sale);
            reportDeliveryError(session, "Payment delivery failed.", error);
            scheduleDeliveryRetry(session);
          }
        }

        if (session.deliveryRetryTimerId !== null) {
          return;
        }
      }
    } finally {
      session.deliveryRunning = false;
    }
  }

  function queueCaptureBatch(session, variationNumbers, completedSales) {
    if (!isCurrentSession(session)) {
      return false;
    }

    variationNumbers.forEach((variationNumber) => {
      if (!session.deliveredVariations.has(variationNumber)) {
        session.queuedVariations.add(variationNumber);
      }
    });

    completedSales.forEach((sale) => {
      const fingerprint = paymentFingerprint(sale);

      if (!session.deliveredPayments.has(fingerprint)) {
        session.queuedPayments.set(fingerprint, sale);
      }
    });

    if (session.deliveryRunning) {
      return true;
    }

    if (session.deliveryRetryTimerId !== null) {
      return true;
    }

    session.deliveryRunning = true;
    void drainCaptureQueue(session).catch((error) => {
      reportDeliveryError(
        session,
        "Capture delivery queue failed.",
        error,
      );
    });
    return true;
  }

  function stopCapture() {
    const session = captureSession;

    if (!session) {
      return false;
    }

    captureSession = null;

    cancelDeliveryRetry(session);

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
      lastRootDiscoveryStatus = null;
      return stopCapture();
    }

    const locatedRoot = candidateLocator.locateUniqueVisibleSoldItemsRoot(
      targetBody,
    );

    if (locatedRoot.status !== "found") {
      if (lastRootDiscoveryStatus !== locatedRoot.status) {
        lastRootDiscoveryStatus = locatedRoot.status;
        reportRootDiscoveryStatus(locatedRoot.status);
      }

      return stopCapture();
    }

    lastRootDiscoveryStatus = "found";

    if (
      captureSession?.body === targetBody &&
      captureSession?.root === locatedRoot.root
    ) {
      return false;
    }

    stopCapture();
    return startCapture(targetBody, locatedRoot.root);
  }

  function scanSoldItems(session) {
    if (
      !session ||
      captureSession !== session ||
      !isCaptureRoute() ||
      document.body !== session.body ||
      !isCurrentSession(session)
    ) {
      reconcileCapture();
      return;
    }

    const observedVariations = candidateLocator.locateObservedVariations(
      session.root,
    );
    const completedSales = candidateLocator
      .locateCompletedSales(session.root, parser)
      .map(({ sale }) =>
        Object.freeze({
          paymentStatus: sale.paymentStatus,
          soldPriceCents: sale.soldPriceCents,
          variationNumber: sale.variationNumber,
        }),
      );
    const variationNumbers = [];
    const seenVariations = new Set();

    observedVariations.forEach(({ variationNumber }) => {
      if (!seenVariations.has(variationNumber)) {
        seenVariations.add(variationNumber);
        variationNumbers.push(variationNumber);
      }
    });

    completedSales.forEach((sale) => {
      if (!seenVariations.has(sale.variationNumber)) {
        seenVariations.add(sale.variationNumber);
        variationNumbers.push(sale.variationNumber);
      }

      emitCompletedSale(sale);
    });

    queueCaptureBatch(session, variationNumbers, completedSales);
  }

  function hasScopedCaptureMutation(records, root) {
    try {
      if (!records || typeof records[Symbol.iterator] !== "function") {
        return true;
      }

      for (const record of records) {
        if (
          !record ||
          (record.type !== "childList" && record.type !== "characterData")
        ) {
          continue;
        }

        if (!record.target) {
          return true;
        }

        if (record.target === root || root.contains(record.target)) {
          return true;
        }
      }

      return false;
    } catch {
      return true;
    }
  }

  function startCapture(body, root) {
    if (
      !body ||
      !root ||
      !isCaptureRoute() ||
      document.body !== body ||
      !body.contains(root)
    ) {
      return false;
    }

    if (captureSession?.body === body && captureSession?.root === root) {
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

      observer = new MutationObserver((records) => {
        if (
          captureSession !== session ||
          !isCaptureRoute() ||
          document.body !== body ||
          !isCurrentSession(session)
        ) {
          reconcileCapture();
          return;
        }

        if (!hasScopedCaptureMutation(records, root)) {
          return;
        }

        try {
          scheduler.request();
        } catch (error) {
          reportError("Capture scheduling failed.", error);
        }
      });

      session = {
        body,
        deliveredPayments: new Set(),
        deliveredVariations: new Set(),
        deliveryRetryDelayMs: DELIVERY_RETRY_DELAY_MS,
        deliveryRetryTimerId: null,
        deliveryRunning: false,
        observer,
        queuedPayments: new Map(),
        queuedVariations: new Set(),
        reportedDeliveryErrorCodes: new Set(),
        root,
        scheduler,
      };
      captureSession = session;

      observer.observe(root, {
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
