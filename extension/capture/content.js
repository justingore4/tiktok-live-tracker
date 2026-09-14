(function initializeCaptureProbe() {
  "use strict";

  const LOG_PREFIX = "[TikTok Live Tracker]";
  const CAPTURE_ORIGIN = "https://shop.tiktok.com";
  const CAPTURE_PATH = "/streamer/live/product/dashboard";
  const LIFECYCLE_INTERVAL_MS = 250;
  const QUIET_SCAN_DELAY_MS = 150;
  const MAX_SCAN_WAIT_MS = 1000;
  const BIDDING_QUIET_SCAN_DELAY_MS = 75;
  const BIDDING_MAX_SCAN_WAIT_MS = 250;
  const DELIVERY_RETRY_DELAY_MS = 1000;
  const MAX_DELIVERY_RETRY_DELAY_MS = 5000;
  const SOLD_PAYMENT_ATTRIBUTE_NAMES = Object.freeze([
    "title", "hidden", "aria-hidden", "style", "class",
  ]);
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
  const attributedGmvLocator =
    globalThis.TikTokLiveTrackerAttributedGmvLocator;
  const biddingVariationLocator =
    globalThis.TikTokLiveTrackerBiddingVariationLocator;
  const candidateLocator = globalThis.TikTokLiveTrackerSaleCandidateLocator;
  const eventRegistryModule =
    globalThis.TikTokLiveTrackerCaptureEventRegistry;
  const schedulerModule = globalThis.TikTokLiveTrackerCaptureScheduler;
  const captureProtocol = globalThis.TikTokLiveTrackerCaptureProtocol;
  const captureClientModule = globalThis.TikTokLiveTrackerCaptureClient;
  const captureHealthProtocol = globalThis.TikTokLiveTrackerCaptureHealth;
  const captureHealthReporterModule = globalThis.TikTokLiveTrackerCaptureHealthReporter;

  if (!parser) {
    console.error(`${LOG_PREFIX} Sale parser failed to load.`);
    return;
  }

  if (!attributedGmvLocator?.locateUniqueVisibleAttributedGmv) {
    console.error(`${LOG_PREFIX} Attributed GMV locator failed to load.`);
    return;
  }

  if (!biddingVariationLocator?.locateUniqueVisibleBiddingAuction) {
    console.error(`${LOG_PREFIX} Bidding variation locator failed to load.`);
    return;
  }

  if (
    !candidateLocator?.locateObservedVariations ||
    !candidateLocator?.locatePaymentStatuses ||
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
  let captureDelivery = null;
  let attributedGmvSession = null;
  let attributedGmvDelivery = null;
  let biddingVariationSession = null;
  let biddingVariationDelivery = null;
  let lifecycleObserver = null;
  let observedDocumentElement = null;
  let lastRootDiscoveryStatus = null;
  let captureHealthReporter = null;
  const captureStartupFaults = { sold: false, bidding: false, lifecycle: false };
  let readinessStreamId = null;
  let startupReady = false;

  globalThis[SINGLETON_KEY] = singletonToken;

  function reportError(message, error) {
    // These faults guard initial readiness only. They never demote a page that
    // has completed startup, and never affect business capture or its retries.
    if (!/delivery/i.test(message)) {
      if (/^Capture (?:scan|scheduling|startup|observer|scheduler)/.test(message)) captureStartupFaults.sold = true;
      if (/^Bidding variation (?:scan|scheduling|startup|observer|scheduler)/.test(message)) captureStartupFaults.bidding = true;
      if (/^Lifecycle/.test(message)) captureStartupFaults.lifecycle = true;
    }
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

  function isHealthVisible(node) {
    if (!node || node.hidden === true || node.getAttribute?.("aria-hidden") === "true" ||
      typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    return Number.isFinite(rect?.width) && rect.width > 0 &&
      Number.isFinite(rect?.height) && rect.height > 0;
  }

  function hasInitialSoldItemsEvidence(root, variations) {
    if (variations.length > 0) return true;
    // This empty-state phrase is known from the supported dashboard. Match it
    // only in the scoped Sold Items root, never unrelated chat or page text.
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const emptyText = "Orders placed during your LIVE will show up here";
    return [root, ...root.querySelectorAll("*")].some((node) =>
      isHealthVisible(node) && (
        biddingVariationLocator.normalizeOwnText(node) === emptyText ||
        (node.children?.length === 0 && normalize(node.textContent) === emptyText)
      ));
  }

  function isBiddingStartupReady(body) {
    if (captureStartupFaults.bidding) return false;
    const located = biddingVariationLocator.locateUniqueVisibleBiddingAuction(body);
    return located.status === "found" && isCurrentBiddingVariationSession(biddingVariationSession) &&
      biddingVariationSession.root === located.root && biddingVariationSession.startupObserverReady &&
      biddingVariationSession.startupScanReady;
  }

  function sampleCaptureReadiness(context) {
    if (!context?.streamId) return { phase: "blank" };
    if (context.streamId !== readinessStreamId) {
      readinessStreamId = context.streamId;
      startupReady = false;
    }
    // The content script belongs to one browser document. Only a new stream or
    // a new document starts another readiness cycle; later glitches do not.
    if (startupReady) return { phase: "ready" };
    try {
      const body = document.body;
      if (!isCaptureRoute() || !body || !lifecycleObserver ||
        observedDocumentElement !== document.documentElement || captureStartupFaults.lifecycle) {
        return { phase: "blank" };
      }
      const sold = candidateLocator.locateUniqueVisibleSoldItemsRoot(body);
      const soldReady = sold.status === "found" &&
        isCurrentSession(captureSession) && captureSession.root === sold.root &&
        captureSession.startupObserverReady && captureSession.startupScanReady && !captureStartupFaults.sold &&
        captureSession.startupEvidenceReady;
      if (!soldReady && !isBiddingStartupReady(body)) return { phase: "blank" };
      // Only core capture's initial delivery matters. GMV is optional analytics
      // and can be absent, malformed, or retrying without holding startup open.
      const deliveries = [captureDelivery, biddingVariationDelivery].filter(Boolean);
      const pending = (captureDelivery?.queuedVariations.size ?? 0) +
        (captureDelivery?.queuedPaymentStatuses.size ?? 0) + (captureDelivery?.queuedPayments.size ?? 0) +
        (biddingVariationDelivery?.queuedVariationNumber != null ? 1 : 0) +
        (biddingVariationDelivery?.queuedBid != null ? 1 : 0);
      if (pending > 0 || deliveries.some((delivery) =>
        delivery.deliveryRunning || delivery.deliveryRetryTimerId !== null)) {
        return { phase: "loading" };
      }
      startupReady = true;
      return { phase: "ready" };
    } catch {
      return { phase: "blank" };
    }
  }

  function observeCaptureStartupErrors(kind, callback) {
    return (...args) => {
      try { return callback(...args); }
      catch (error) {
        captureStartupFaults[kind] = true;
        throw error;
      }
    };
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

  function isCurrentDelivery(delivery) {
    try {
      return (
        Boolean(delivery) &&
        captureDelivery === delivery &&
        isCaptureRoute() &&
        document.body === delivery.body
      );
    } catch {
      return false;
    }
  }

  function createDeliveryState(body) {
    return {
      body,
      deliveredPayments: new Set(),
      deliveredPaymentStatuses: new Map(),
      deliveredVariations: new Set(),
      deliveryRetryDelayMs: DELIVERY_RETRY_DELAY_MS,
      deliveryRetryTimerId: null,
      deliveryRunning: false,
      latestObservedPaymentStatuses: new Map(),
      queuedPayments: new Map(),
      queuedPaymentStatuses: new Map(),
      queuedVariations: new Set(),
      reportedDeliveryErrorCodes: new Set(),
      stickyCompletedVariations: new Set(),
    };
  }

  function isCurrentAttributedGmvSession(session) {
    try {
      return (
        Boolean(session) &&
        attributedGmvSession === session &&
        isCaptureRoute() &&
        document.body === session.body &&
        session.body.contains(session.root)
      );
    } catch {
      return false;
    }
  }

  function isCurrentAttributedGmvDelivery(delivery) {
    try {
      return (
        Boolean(delivery) &&
        attributedGmvDelivery === delivery &&
        isCaptureRoute() &&
        document.body === delivery.body
      );
    } catch {
      return false;
    }
  }

  function createAttributedGmvDeliveryState(body) {
    return {
      body,
      deliveredDisplay: null,
      deliveryRetryDelayMs: DELIVERY_RETRY_DELAY_MS,
      deliveryRetryTimerId: null,
      deliveryRunning: false,
      queuedDisplay: null,
      reportedDeliveryErrorCodes: new Set(),
    };
  }

  function isCurrentBiddingVariationSession(session) {
    try {
      return (
        Boolean(session) &&
        biddingVariationSession === session &&
        isCaptureRoute() &&
        document.body === session.body &&
        session.body.contains(session.root)
      );
    } catch {
      return false;
    }
  }

  function isCurrentBiddingVariationDelivery(delivery) {
    try {
      return (
        Boolean(delivery) &&
        biddingVariationDelivery === delivery &&
        isCaptureRoute() &&
        document.body === delivery.body
      );
    } catch {
      return false;
    }
  }

  function createBiddingVariationDeliveryState(body) {
    return {
      body,
      deliveredBid: null,
      deliveredVariationNumber: null,
      deliveryRetryDelayMs: DELIVERY_RETRY_DELAY_MS,
      deliveryRetryTimerId: null,
      deliveryRunning: false,
      latestObservedVariationNumber: null,
      latestObservedBid: null,
      queuedBid: null,
      queuedVariationNumber: null,
      reportedDeliveryErrorCodes: new Set(),
    };
  }

  function isSameBiddingPrice(left, right) {
    return (
      Boolean(left) &&
      Boolean(right) &&
      left.variationNumber === right.variationNumber &&
      left.bidPriceCents === right.bidPriceCents
    );
  }

  function hasQueuedBiddingDelivery(delivery) {
    return (
      (delivery.queuedVariationNumber !== null &&
        delivery.queuedVariationNumber !==
          delivery.deliveredVariationNumber) ||
      (delivery.queuedBid !== null &&
        !isSameBiddingPrice(delivery.queuedBid, delivery.deliveredBid))
    );
  }

  function restoreLatestBiddingQueue(delivery) {
    delivery.queuedVariationNumber =
      delivery.latestObservedVariationNumber !==
      delivery.deliveredVariationNumber
        ? delivery.latestObservedVariationNumber
        : null;
    delivery.queuedBid =
      delivery.latestObservedBid !== null &&
      !isSameBiddingPrice(
        delivery.latestObservedBid,
        delivery.deliveredBid,
      )
        ? delivery.latestObservedBid
        : null;
  }

  function paymentFingerprint(sale) {
    return `${sale.variationNumber}:${sale.soldPriceCents}`;
  }

  function isCompletedStatus(status) {
    return status.observedPaymentStatus === "payment_complete";
  }

  function queueLatestPaymentStatus(delivery, status) {
    const variationNumber = status.variationNumber;

    if (
      !isCompletedStatus(status) &&
      delivery.stickyCompletedVariations.has(variationNumber)
    ) {
      return false;
    }

    delivery.latestObservedPaymentStatuses.set(
      variationNumber,
      status.observedPaymentStatus,
    );

    const queued = delivery.queuedPaymentStatuses.get(variationNumber);

    if (queued?.observedPaymentStatus === status.observedPaymentStatus) {
      return false;
    }

    if (
      delivery.deliveredPaymentStatuses.get(variationNumber) ===
      status.observedPaymentStatus
    ) {
      delivery.queuedPaymentStatuses.delete(variationNumber);
      return false;
    }

    delivery.queuedPaymentStatuses.set(variationNumber, status);
    return true;
  }

  function requeuePaymentStatusUnlessNewer(delivery, status) {
    if (
      !isCompletedStatus(status) &&
      delivery.stickyCompletedVariations.has(status.variationNumber)
    ) {
      return;
    }

    if (
      delivery.latestObservedPaymentStatuses.get(status.variationNumber) !==
      status.observedPaymentStatus
    ) {
      return;
    }

    if (
      !delivery.queuedPaymentStatuses.has(status.variationNumber) &&
      delivery.deliveredPaymentStatuses.get(status.variationNumber) !==
        status.observedPaymentStatus
    ) {
      delivery.queuedPaymentStatuses.set(status.variationNumber, status);
    }
  }

  function reportDeliveryError(delivery, message, error) {
    const code =
      typeof error?.code === "string"
        ? error.code
        : "CAPTURE_DELIVERY_FAILED";

    if (delivery?.reportedDeliveryErrorCodes?.has(code)) {
      return;
    }

    delivery?.reportedDeliveryErrorCodes?.add(code);
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

  function cancelDeliveryRetry(delivery) {
    if (!delivery || delivery.deliveryRetryTimerId === null) {
      return false;
    }

    const timerId = delivery.deliveryRetryTimerId;
    delivery.deliveryRetryTimerId = null;

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

  function scheduleDeliveryRetry(delivery) {
    if (
      !isCurrentDelivery(delivery) ||
      delivery.deliveryRetryTimerId !== null
    ) {
      return false;
    }

    const delayMs = delivery.deliveryRetryDelayMs;

    try {
      delivery.deliveryRetryTimerId = window.setTimeout(() => {
        delivery.deliveryRetryTimerId = null;

        if (!isCurrentDelivery(delivery)) {
          return;
        }

        if (delivery.deliveryRunning) {
          scheduleDeliveryRetry(delivery);
          return;
        }

        if (
          delivery.queuedVariations.size === 0 &&
          delivery.queuedPaymentStatuses.size === 0 &&
          delivery.queuedPayments.size === 0
        ) {
          return;
        }

        delivery.deliveryRunning = true;
        void drainCaptureQueue(delivery).catch((error) => {
          reportDeliveryError(
            delivery,
            "Capture delivery queue failed.",
            error,
          );
        });
      }, delayMs);
      delivery.deliveryRetryDelayMs = Math.min(
        delayMs * 2,
        MAX_DELIVERY_RETRY_DELAY_MS,
      );
      return true;
    } catch (error) {
      reportDeliveryError(
        delivery,
        "Capture delivery retry failed.",
        error,
      );
      return false;
    }
  }

  async function drainCaptureQueue(delivery) {
    try {
      while (
        isCurrentDelivery(delivery) &&
        (delivery.queuedVariations.size > 0 ||
          delivery.queuedPaymentStatuses.size > 0 ||
          delivery.queuedPayments.size > 0)
      ) {
        const variationNumbers = [...delivery.queuedVariations].filter(
          (variationNumber) =>
            !delivery.deliveredVariations.has(variationNumber),
        );
        const completedSales = [...delivery.queuedPayments.values()].filter(
          (sale) =>
            !delivery.deliveredPayments.has(paymentFingerprint(sale)),
        );
        const paymentStatuses = [
          ...delivery.queuedPaymentStatuses.values(),
        ].filter(
          (status) =>
            delivery.deliveredPaymentStatuses.get(status.variationNumber) !==
            status.observedPaymentStatus,
        );

        delivery.queuedVariations.clear();
        delivery.queuedPaymentStatuses.clear();
        delivery.queuedPayments.clear();

        let observationsDelivered = true;

        if (variationNumbers.length > 0) {
          try {
            await captureClient.observeVariations(variationNumbers);

            if (!isCurrentDelivery(delivery)) {
              return;
            }

            variationNumbers.forEach((variationNumber) => {
              delivery.deliveredVariations.add(variationNumber);
            });
            delivery.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
            reportVariationSync(variationNumbers);
          } catch (error) {
            observationsDelivered = false;
            variationNumbers.forEach((variationNumber) => {
              delivery.queuedVariations.add(variationNumber);
            });
            completedSales.forEach((sale) => {
              delivery.queuedPayments.set(paymentFingerprint(sale), sale);
            });
            paymentStatuses.forEach((status) => {
              requeuePaymentStatusUnlessNewer(delivery, status);
            });
            reportDeliveryError(
              delivery,
              "Variation observation delivery failed.",
              error,
            );
            scheduleDeliveryRetry(delivery);
          }
        }

        if (!observationsDelivered || !isCurrentDelivery(delivery)) {
          return;
        }

        let statusesDelivered = true;

        if (paymentStatuses.length > 0) {
          try {
            await captureClient.observePaymentStatuses(
              paymentStatuses.map((status) => ({
                variationNumber: status.variationNumber,
                observedPaymentStatus: status.observedPaymentStatus,
              })),
            );

            if (!isCurrentDelivery(delivery)) {
              return;
            }

            paymentStatuses.forEach((status) => {
              delivery.deliveredPaymentStatuses.set(
                status.variationNumber,
                status.observedPaymentStatus,
              );
            });
            delivery.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
          } catch (error) {
            statusesDelivered = false;
            paymentStatuses.forEach((status) => {
              requeuePaymentStatusUnlessNewer(delivery, status);
            });
            completedSales.forEach((sale) => {
              delivery.queuedPayments.set(paymentFingerprint(sale), sale);
            });
            reportDeliveryError(
              delivery,
              "Payment status delivery failed.",
              error,
            );
            scheduleDeliveryRetry(delivery);
          }
        }

        if (!statusesDelivered || !isCurrentDelivery(delivery)) {
          return;
        }

        for (const sale of completedSales) {
          if (!isCurrentDelivery(delivery)) {
            return;
          }

          const fingerprint = paymentFingerprint(sale);

          try {
            await captureClient.recordPaymentComplete({
              variationNumber: sale.variationNumber,
              soldPriceCents: sale.soldPriceCents,
            });

            if (!isCurrentDelivery(delivery)) {
              return;
            }

            delivery.deliveredPayments.add(fingerprint);
            delivery.deliveredPaymentStatuses.set(
              sale.variationNumber,
              "payment_complete",
            );
            delivery.stickyCompletedVariations.add(sale.variationNumber);
            delivery.latestObservedPaymentStatuses.set(
              sale.variationNumber,
              "payment_complete",
            );
            delivery.queuedPaymentStatuses.delete(sale.variationNumber);
            delivery.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
          } catch (error) {
            delivery.queuedPayments.set(fingerprint, sale);
            reportDeliveryError(delivery, "Payment delivery failed.", error);
            scheduleDeliveryRetry(delivery);
          }
        }

        if (delivery.deliveryRetryTimerId !== null) {
          return;
        }
      }
    } finally {
      delivery.deliveryRunning = false;
    }
  }

  function cancelAttributedGmvDeliveryRetry(delivery) {
    if (!delivery || delivery.deliveryRetryTimerId === null) {
      return false;
    }

    const timerId = delivery.deliveryRetryTimerId;
    delivery.deliveryRetryTimerId = null;

    try {
      window.clearTimeout(timerId);
    } catch (error) {
      reportError("Attributed GMV delivery retry cleanup failed.", error);
    }

    return true;
  }

  function scheduleAttributedGmvDeliveryRetry(delivery) {
    if (
      !isCurrentAttributedGmvDelivery(delivery) ||
      delivery.deliveryRetryTimerId !== null
    ) {
      return false;
    }

    const delayMs = delivery.deliveryRetryDelayMs;

    try {
      delivery.deliveryRetryTimerId = window.setTimeout(() => {
        delivery.deliveryRetryTimerId = null;

        if (!isCurrentAttributedGmvDelivery(delivery)) {
          return;
        }

        if (delivery.deliveryRunning) {
          scheduleAttributedGmvDeliveryRetry(delivery);
          return;
        }

        if (
          delivery.queuedDisplay === null ||
          delivery.queuedDisplay === delivery.deliveredDisplay
        ) {
          return;
        }

        delivery.deliveryRunning = true;
        void drainAttributedGmvQueue(delivery).catch((error) => {
          reportDeliveryError(
            delivery,
            "Attributed GMV delivery queue failed.",
            error,
          );
        });
      }, delayMs);
      delivery.deliveryRetryDelayMs = Math.min(
        delayMs * 2,
        MAX_DELIVERY_RETRY_DELAY_MS,
      );
      return true;
    } catch (error) {
      reportDeliveryError(
        delivery,
        "Attributed GMV delivery retry failed.",
        error,
      );
      return false;
    }
  }

  async function drainAttributedGmvQueue(delivery) {
    try {
      while (
        isCurrentAttributedGmvDelivery(delivery) &&
        delivery.queuedDisplay !== null &&
        delivery.queuedDisplay !== delivery.deliveredDisplay
      ) {
        const attributedGmvDisplay = delivery.queuedDisplay;
        delivery.queuedDisplay = null;

        try {
          await captureClient.observeAttributedGmv(attributedGmvDisplay);

          if (!isCurrentAttributedGmvDelivery(delivery)) {
            return;
          }

          delivery.deliveredDisplay = attributedGmvDisplay;
          delivery.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
        } catch (error) {
          // A newer observation wins over the failed stale value.
          if (delivery.queuedDisplay === null) {
            delivery.queuedDisplay = attributedGmvDisplay;
          }

          reportDeliveryError(
            delivery,
            "Attributed GMV delivery failed.",
            error,
          );
          scheduleAttributedGmvDeliveryRetry(delivery);
          return;
        }

        if (delivery.deliveryRetryTimerId !== null) {
          return;
        }
      }
    } finally {
      delivery.deliveryRunning = false;
    }
  }

  function queueAttributedGmv(session, attributedGmvDisplay) {
    if (!isCurrentAttributedGmvSession(session)) {
      return false;
    }

    const delivery = session.delivery;

    if (attributedGmvDisplay === delivery.deliveredDisplay) {
      delivery.queuedDisplay = null;
      return false;
    }

    if (attributedGmvDisplay === delivery.queuedDisplay) {
      return false;
    }

    delivery.queuedDisplay = attributedGmvDisplay;

    if (
      delivery.deliveryRunning ||
      delivery.deliveryRetryTimerId !== null
    ) {
      return true;
    }

    delivery.deliveryRunning = true;
    void drainAttributedGmvQueue(delivery).catch((error) => {
      reportDeliveryError(
        delivery,
        "Attributed GMV delivery queue failed.",
        error,
      );
    });
    return true;
  }

  function cancelBiddingVariationDeliveryRetry(delivery) {
    if (!delivery || delivery.deliveryRetryTimerId === null) {
      return false;
    }

    const timerId = delivery.deliveryRetryTimerId;
    delivery.deliveryRetryTimerId = null;

    try {
      window.clearTimeout(timerId);
    } catch (error) {
      reportError("Bidding variation delivery retry cleanup failed.", error);
    }

    return true;
  }

  function scheduleBiddingVariationDeliveryRetry(delivery) {
    if (
      !isCurrentBiddingVariationDelivery(delivery) ||
      delivery.deliveryRetryTimerId !== null
    ) {
      return false;
    }

    const delayMs = delivery.deliveryRetryDelayMs;

    try {
      delivery.deliveryRetryTimerId = window.setTimeout(() => {
        delivery.deliveryRetryTimerId = null;

        if (!isCurrentBiddingVariationDelivery(delivery)) {
          return;
        }

        if (delivery.deliveryRunning) {
          scheduleBiddingVariationDeliveryRetry(delivery);
          return;
        }

        if (!hasQueuedBiddingDelivery(delivery)) {
          return;
        }

        delivery.deliveryRunning = true;
        void drainBiddingVariationQueue(delivery).catch((error) => {
          reportDeliveryError(
            delivery,
            "Bidding variation delivery queue failed.",
            error,
          );
        });
      }, delayMs);
      delivery.deliveryRetryDelayMs = Math.min(
        delayMs * 2,
        MAX_DELIVERY_RETRY_DELAY_MS,
      );
      return true;
    } catch (error) {
      reportDeliveryError(
        delivery,
        "Bidding variation delivery retry failed.",
        error,
      );
      return false;
    }
  }

  async function drainBiddingVariationQueue(delivery) {
    try {
      while (isCurrentBiddingVariationDelivery(delivery)) {
        if (
          delivery.queuedVariationNumber !== null &&
          delivery.queuedVariationNumber !==
            delivery.deliveredVariationNumber
        ) {
          const variationNumber = delivery.queuedVariationNumber;
          delivery.queuedVariationNumber = null;

          try {
            await captureClient.observeBiddingVariation(variationNumber);

            if (!isCurrentBiddingVariationDelivery(delivery)) {
              return;
            }

            delivery.deliveredVariationNumber = variationNumber;
            delivery.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
            restoreLatestBiddingQueue(delivery);
          } catch (error) {
            // Delivery may have crossed the boundary before a transport error,
            // so force the newest identity to be sent again before its price.
            delivery.deliveredVariationNumber = null;
            restoreLatestBiddingQueue(delivery);

            reportDeliveryError(
              delivery,
              "Bidding variation delivery failed.",
              error,
            );
            scheduleBiddingVariationDeliveryRetry(delivery);
            return;
          }

          if (
            delivery.deliveryRetryTimerId !== null ||
            !isCurrentBiddingVariationDelivery(delivery)
          ) {
            return;
          }

          // Establish the worker-owned active variation before its first bid.
          continue;
        }

        const bid = delivery.queuedBid;

        if (bid === null || isSameBiddingPrice(bid, delivery.deliveredBid)) {
          delivery.queuedBid = null;
          break;
        }

        if (bid.variationNumber !== delivery.deliveredVariationNumber) {
          restoreLatestBiddingQueue(delivery);

          if (
            delivery.queuedVariationNumber === null ||
            delivery.queuedVariationNumber ===
              delivery.deliveredVariationNumber
          ) {
            // A stale price must never cross after a newer card identity.
            delivery.queuedBid = null;
            break;
          }

          continue;
        }

        delivery.queuedBid = null;

        try {
          await captureClient.observeBiddingPrice(bid);

          if (!isCurrentBiddingVariationDelivery(delivery)) {
            return;
          }

          delivery.deliveredBid = bid;
          delivery.deliveryRetryDelayMs = DELIVERY_RETRY_DELAY_MS;
          restoreLatestBiddingQueue(delivery);
        } catch (error) {
          // The newest sampled price wins. Force it across again because a
          // transport failure can occur after the worker accepted the send.
          delivery.deliveredBid = null;
          restoreLatestBiddingQueue(delivery);

          reportDeliveryError(delivery, "Bidding price delivery failed.", error);
          scheduleBiddingVariationDeliveryRetry(delivery);
          return;
        }

        if (delivery.deliveryRetryTimerId !== null) {
          return;
        }
      }
    } finally {
      delivery.deliveryRunning = false;
    }
  }

  function queueBiddingAuction(session, variationNumber, bidPriceCents) {
    if (!isCurrentBiddingVariationSession(session)) {
      return false;
    }

    const delivery = session.delivery;

    const changedVariation =
      delivery.latestObservedVariationNumber !== variationNumber;
    delivery.latestObservedVariationNumber = variationNumber;

    if (changedVariation) {
      delivery.latestObservedBid = null;
      delivery.queuedBid = null;
    }

    if (Number.isSafeInteger(bidPriceCents) && bidPriceCents > 0) {
      const bid = Object.freeze({ variationNumber, bidPriceCents });
      delivery.latestObservedBid = bid;
      delivery.queuedBid = isSameBiddingPrice(bid, delivery.deliveredBid)
        ? null
        : bid;
    }

    if (variationNumber === delivery.deliveredVariationNumber) {
      delivery.queuedVariationNumber = null;
    } else {
      delivery.queuedVariationNumber = variationNumber;
    }

    if (!hasQueuedBiddingDelivery(delivery)) {
      cancelBiddingVariationDeliveryRetry(delivery);
      return false;
    }

    if (
      delivery.deliveryRunning ||
      delivery.deliveryRetryTimerId !== null
    ) {
      return true;
    }

    delivery.deliveryRunning = true;
    void drainBiddingVariationQueue(delivery).catch((error) => {
      reportDeliveryError(
        delivery,
        "Bidding variation delivery queue failed.",
        error,
      );
    });
    return true;
  }

  function queueCaptureBatch(
    session,
    variationNumbers,
    paymentStatuses,
    completedSales,
  ) {
    if (!isCurrentSession(session)) {
      return false;
    }

    const delivery = session.delivery;

    variationNumbers.forEach((variationNumber) => {
      if (!delivery.deliveredVariations.has(variationNumber)) {
        delivery.queuedVariations.add(variationNumber);
      }
    });

    completedSales.forEach((sale) => {
      const fingerprint = paymentFingerprint(sale);

      delivery.latestObservedPaymentStatuses.set(
        sale.variationNumber,
        "payment_complete",
      );

      if (!delivery.deliveredPayments.has(fingerprint)) {
        delivery.queuedPayments.set(fingerprint, sale);
      }
    });

    paymentStatuses.forEach((status) => {
      queueLatestPaymentStatus(delivery, status);
    });

    if (delivery.deliveryRunning) {
      return true;
    }

    if (delivery.deliveryRetryTimerId !== null) {
      return true;
    }

    delivery.deliveryRunning = true;
    void drainCaptureQueue(delivery).catch((error) => {
      reportDeliveryError(
        delivery,
        "Capture delivery queue failed.",
        error,
      );
    });
    return true;
  }

  function stopCapture({ preserveDelivery = false } = {}) {
    const session = captureSession;
    let changed = false;

    if (!preserveDelivery && captureDelivery) {
      cancelDeliveryRetry(captureDelivery);
      captureDelivery = null;
      changed = true;
    }

    if (!session) {
      return changed;
    }

    captureSession = null;
    changed = true;

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

    return changed;
  }

  function stopAttributedGmvCapture({ preserveDelivery = false } = {}) {
    const session = attributedGmvSession;
    let changed = false;

    if (!preserveDelivery && attributedGmvDelivery) {
      cancelAttributedGmvDeliveryRetry(attributedGmvDelivery);
      attributedGmvDelivery = null;
      changed = true;
    }

    if (!session) {
      return changed;
    }

    attributedGmvSession = null;
    changed = true;

    try {
      session.observer.disconnect();
    } catch (error) {
      reportError("Attributed GMV observer cleanup failed.", error);
    }

    try {
      session.scheduler.dispose();
    } catch (error) {
      reportError("Attributed GMV scheduler cleanup failed.", error);
    }

    return changed;
  }

  function stopBiddingVariationCapture({ preserveDelivery = false } = {}) {
    const session = biddingVariationSession;
    let changed = false;

    if (!preserveDelivery && biddingVariationDelivery) {
      cancelBiddingVariationDeliveryRetry(biddingVariationDelivery);
      biddingVariationDelivery = null;
      changed = true;
    }

    if (!session) {
      return changed;
    }

    biddingVariationSession = null;
    changed = true;

    try {
      session.observer.disconnect();
    } catch (error) {
      reportError("Bidding variation observer cleanup failed.", error);
    }

    try {
      session.scheduler.dispose();
    } catch (error) {
      reportError("Bidding variation scheduler cleanup failed.", error);
    }

    return changed;
  }

  function reconcileAttributedGmvCapture() {
    const targetBody = isCaptureRoute() ? document.body : null;

    if (!targetBody) {
      return stopAttributedGmvCapture();
    }

    const located =
      attributedGmvLocator.locateUniqueVisibleAttributedGmv(targetBody);

    if (located.status !== "found") {
      return stopAttributedGmvCapture({
        preserveDelivery: attributedGmvDelivery?.body === targetBody,
      });
    }

    if (
      attributedGmvSession?.body === targetBody &&
      attributedGmvSession?.root === located.root
    ) {
      return false;
    }

    stopAttributedGmvCapture({
      preserveDelivery: attributedGmvDelivery?.body === targetBody,
    });
    return startAttributedGmvCapture(targetBody, located.root);
  }

  function scanAttributedGmv(session) {
    if (
      !session ||
      attributedGmvSession !== session ||
      !isCaptureRoute() ||
      document.body !== session.body ||
      !isCurrentAttributedGmvSession(session)
    ) {
      reconcileAttributedGmvCapture();
      return;
    }

    const located =
      attributedGmvLocator.locateUniqueVisibleAttributedGmv(session.body);

    if (located.status !== "found" || located.root !== session.root) {
      reconcileAttributedGmvCapture();
      return;
    }

    queueAttributedGmv(session, located.attributedGmvDisplay);
  }

  function reconcileBiddingVariationCapture() {
    const targetBody = isCaptureRoute() ? document.body : null;

    if (!targetBody) {
      return stopBiddingVariationCapture();
    }

    const located =
      biddingVariationLocator.locateUniqueVisibleBiddingAuction(targetBody);

    if (located.status !== "found") {
      return stopBiddingVariationCapture({
        preserveDelivery: biddingVariationDelivery?.body === targetBody,
      });
    }

    if (
      biddingVariationSession?.body === targetBody &&
      biddingVariationSession?.root === located.root
    ) {
      return false;
    }

    stopBiddingVariationCapture({
      preserveDelivery: biddingVariationDelivery?.body === targetBody,
    });
    return startBiddingVariationCapture(targetBody, located.root);
  }

  function scanBiddingVariation(session) {
    if (
      !session ||
      biddingVariationSession !== session ||
      !isCaptureRoute() ||
      document.body !== session.body ||
      !isCurrentBiddingVariationSession(session)
    ) {
      reconcileBiddingVariationCapture();
      return;
    }

    const located =
      biddingVariationLocator.locateUniqueVisibleBiddingAuction(session.body);

    if (located.status !== "found" || located.root !== session.root) {
      reconcileBiddingVariationCapture();
      return;
    }

    queueBiddingAuction(
      session,
      located.variationNumber,
      located.bidPriceStatus === "found" ? located.bidPriceCents : null,
    );
    session.startupScanReady = true;
    captureStartupFaults.bidding = false;
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

      return stopCapture({
        preserveDelivery: captureDelivery?.body === targetBody,
      });
    }

    lastRootDiscoveryStatus = "found";

    if (
      captureSession?.body === targetBody &&
      captureSession?.root === locatedRoot.root
    ) {
      return false;
    }

    stopCapture({
      preserveDelivery: captureDelivery?.body === targetBody,
    });
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
    const locatedPaymentStatuses = candidateLocator.locatePaymentStatuses(
      session.root,
      parser,
    );
    const completedSales = locatedPaymentStatuses
      .filter(
        (status) =>
          isCompletedStatus(status) && status.soldPriceCents !== null,
      )
      .map((status) =>
        Object.freeze({
          paymentStatus: "payment_complete",
          soldPriceCents: status.soldPriceCents,
          variationNumber: status.variationNumber,
        }),
      );
    const paymentStatuses = locatedPaymentStatuses
      .filter(
        (status) =>
          !isCompletedStatus(status) || status.soldPriceCents === null,
      )
      .map((status) =>
        Object.freeze({
          variationNumber: status.variationNumber,
          observedPaymentStatus: status.observedPaymentStatus,
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

    paymentStatuses.forEach(({ variationNumber }) => {
      if (!seenVariations.has(variationNumber)) {
        seenVariations.add(variationNumber);
        variationNumbers.push(variationNumber);
      }
    });

    queueCaptureBatch(
      session,
      variationNumbers,
      paymentStatuses,
      completedSales,
    );
    // Evidence belongs to this completed scan, not a new DOM row that has not
    // yet passed through the normal capture scheduler and delivery queues.
    session.startupEvidenceReady = hasInitialSoldItemsEvidence(session.root, observedVariations);
    session.startupScanReady = true;
    captureStartupFaults.sold = false;
  }

  function isFailedPaymentAttributeContext(target, root) {
    let candidate = target;
    const visited = new Set();

    while (candidate && visited.size < candidateLocator.MAX_ROW_ANCESTORS) {
      if (visited.has(candidate) || (candidate === root && candidate !== target)) {
        return false;
      }
      visited.add(candidate);
      const tags = candidate.matches?.(candidateLocator.PAYMENT_TAG_SELECTOR)
        ? [candidate]
        : [...(candidate.querySelectorAll?.(candidateLocator.PAYMENT_TAG_SELECTOR) ?? [])];
      if (tags.length > 0) {
        // A changed container can affect its own failed rows. A detail node
        // must reach one failed badge before crossing into neighboring rows.
        return (candidate === target || tags.length === 1) && tags.some((tag) =>
          String(tag.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === "payment failed");
      }
      if (candidate === root) {
        return false;
      }
      candidate = candidate.parentElement;
    }

    return false;
  }

  function hasScopedCaptureMutation(records, root, includePaymentAttributes = false) {
    try {
      if (!records || typeof records[Symbol.iterator] !== "function") {
        return true;
      }

      for (const record of records) {
        if (
          !record ||
          (record.type !== "childList" && record.type !== "characterData" &&
            !(includePaymentAttributes && record.type === "attributes" &&
              SOLD_PAYMENT_ATTRIBUTE_NAMES.includes(record.attributeName)))
        ) {
          continue;
        }

        if (!record.target) {
          return true;
        }

        if (record.target === root || root.contains(record.target)) {
          if (record.type !== "attributes" || isFailedPaymentAttributeContext(record.target, root)) {
            return true;
          }
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
    const delivery =
      captureDelivery?.body === body
        ? captureDelivery
        : createDeliveryState(body);

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

      observer = new MutationObserver(observeCaptureStartupErrors("sold", (records) => {
        if (
          captureSession !== session ||
          !isCaptureRoute() ||
          document.body !== body ||
          !isCurrentSession(session)
        ) {
          reconcileCapture();
          return;
        }

        if (!hasScopedCaptureMutation(records, root, true)) {
          return;
        }

        try {
          scheduler.request();
        } catch (error) {
          reportError("Capture scheduling failed.", error);
        }
      }));

      session = {
        body,
        delivery,
        observer,
        root,
        scheduler,
        startupObserverReady: false,
        startupScanReady: false,
        startupEvidenceReady: false,
      };
      captureDelivery = delivery;
      captureSession = session;

      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...SOLD_PAYMENT_ATTRIBUTE_NAMES],
      });
      session.startupObserverReady = true;

      scheduler.runNow();

      console.info(`${LOG_PREFIX} Capture probe active on ${location.pathname}.`);
      return true;
    } catch (error) {
      if (session && captureSession === session) {
        stopCapture({
          preserveDelivery:
            captureDelivery === delivery &&
            isCaptureRoute() &&
            document.body === body,
        });
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

  function startAttributedGmvCapture(body, root) {
    if (
      !body ||
      !root ||
      !isCaptureRoute() ||
      document.body !== body ||
      !body.contains(root)
    ) {
      return false;
    }

    if (
      attributedGmvSession?.body === body &&
      attributedGmvSession?.root === root
    ) {
      return false;
    }

    let scheduler;
    let observer;
    let session;
    const delivery =
      attributedGmvDelivery?.body === body
        ? attributedGmvDelivery
        : createAttributedGmvDeliveryState(body);

    try {
      scheduler = schedulerModule.createCaptureScheduler({
        scan() {
          scanAttributedGmv(session);
        },
        setTimeoutFn: window.setTimeout.bind(window),
        clearTimeoutFn: window.clearTimeout.bind(window),
        onError(error) {
          reportError("Attributed GMV scan failed.", error);
        },
        quietDelayMs: QUIET_SCAN_DELAY_MS,
        maxWaitMs: MAX_SCAN_WAIT_MS,
      });

      observer = new MutationObserver((records) => {
        if (
          attributedGmvSession !== session ||
          !isCaptureRoute() ||
          document.body !== body ||
          !isCurrentAttributedGmvSession(session)
        ) {
          reconcileAttributedGmvCapture();
          return;
        }

        if (!hasScopedCaptureMutation(records, root)) {
          return;
        }

        try {
          scheduler.request();
        } catch (error) {
          reportError("Attributed GMV scheduling failed.", error);
        }
      });

      session = { body, delivery, observer, root, scheduler };
      attributedGmvDelivery = delivery;
      attributedGmvSession = session;

      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scheduler.runNow();

      console.info(`${LOG_PREFIX} Attributed GMV probe active.`);
      return true;
    } catch (error) {
      if (session && attributedGmvSession === session) {
        stopAttributedGmvCapture({
          preserveDelivery:
            attributedGmvDelivery === delivery &&
            isCaptureRoute() &&
            document.body === body,
        });
      } else {
        if (observer) {
          try {
            observer.disconnect();
          } catch (cleanupError) {
            reportError(
              "Attributed GMV observer cleanup failed.",
              cleanupError,
            );
          }
        }

        if (scheduler) {
          try {
            scheduler.dispose();
          } catch (cleanupError) {
            reportError(
              "Attributed GMV scheduler cleanup failed.",
              cleanupError,
            );
          }
        }
      }

      reportError("Attributed GMV startup failed.", error);
      return false;
    }
  }

  function startBiddingVariationCapture(body, root) {
    if (
      !body ||
      !root ||
      !isCaptureRoute() ||
      document.body !== body ||
      !body.contains(root)
    ) {
      return false;
    }

    if (
      biddingVariationSession?.body === body &&
      biddingVariationSession?.root === root
    ) {
      return false;
    }

    let scheduler;
    let observer;
    let session;
    const delivery =
      biddingVariationDelivery?.body === body
        ? biddingVariationDelivery
        : createBiddingVariationDeliveryState(body);

    try {
      scheduler = schedulerModule.createCaptureScheduler({
        scan() {
          scanBiddingVariation(session);
        },
        setTimeoutFn: window.setTimeout.bind(window),
        clearTimeoutFn: window.clearTimeout.bind(window),
        onError(error) {
          reportError("Bidding variation scan failed.", error);
        },
        quietDelayMs: BIDDING_QUIET_SCAN_DELAY_MS,
        maxWaitMs: BIDDING_MAX_SCAN_WAIT_MS,
      });

      observer = new MutationObserver(observeCaptureStartupErrors("bidding", (records) => {
        if (
          biddingVariationSession !== session ||
          !isCaptureRoute() ||
          document.body !== body ||
          !isCurrentBiddingVariationSession(session)
        ) {
          reconcileBiddingVariationCapture();
          return;
        }

        if (!hasScopedCaptureMutation(records, root)) {
          return;
        }

        try {
          scheduler.request();
        } catch (error) {
          reportError("Bidding variation scheduling failed.", error);
        }
      }));

      session = {
        body,
        delivery,
        observer,
        root,
        scheduler,
        startupObserverReady: false,
        startupScanReady: false,
      };
      biddingVariationDelivery = delivery;
      biddingVariationSession = session;

      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      session.startupObserverReady = true;

      scheduler.runNow();

      console.info(`${LOG_PREFIX} Bidding variation probe active.`);
      return true;
    } catch (error) {
      if (session && biddingVariationSession === session) {
        stopBiddingVariationCapture({
          preserveDelivery:
            biddingVariationDelivery === delivery &&
            isCaptureRoute() &&
            document.body === body,
        });
      } else {
        if (observer) {
          try {
            observer.disconnect();
          } catch (cleanupError) {
            reportError(
              "Bidding variation observer cleanup failed.",
              cleanupError,
            );
          }
        }

        if (scheduler) {
          try {
            scheduler.dispose();
          } catch (cleanupError) {
            reportError(
              "Bidding variation scheduler cleanup failed.",
              cleanupError,
            );
          }
        }
      }

      reportError("Bidding variation startup failed.", error);
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
    try {
      const observing = ensureLifecycleObserver();
      reconcileCapture();
      reconcileAttributedGmvCapture();
      reconcileBiddingVariationCapture();
      if (observing) captureStartupFaults.lifecycle = false;
    } catch (error) {
      captureStartupFaults.lifecycle = true;
      throw error;
    }
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

  if (captureHealthReporterModule?.createCaptureHealthReporter && captureHealthProtocol) {
    try {
      captureHealthReporter = captureHealthReporterModule.createCaptureHealthReporter({
        runtime: globalThis.chrome?.runtime,
        protocol: captureHealthProtocol,
        getSample: sampleCaptureReadiness,
        setTimeoutFn: window.setTimeout.bind(window),
        clearTimeoutFn: window.clearTimeout.bind(window),
      });
      captureHealthReporter.start();
      window.addEventListener?.("pagehide", (event) => {
        if (!event.persisted) captureHealthReporter.dispose();
      });
    } catch {
      // Missing/blocked health telemetry must never stop business capture.
    }
  }
})();
