(function initializeTaggerLifecycle() {
  "use strict";

  const DEMO_STREAM_ID = "demo-stream";
  const DEMO_CURRENT_VARIATION_NUMBER = 203;
  const DEFAULT_DEMO_SOLD_PRICE = "48.00";
  const DEMO_VARIATION_SEEDS = Object.freeze([
    Object.freeze({
      variationNumber: 202,
      sku: "STUSSY-TEE-BLACK-M",
      status: "committed",
      soldPriceCents: 2000,
    }),
    Object.freeze({
      variationNumber: 201,
      status: "unmapped",
    }),
    Object.freeze({
      variationNumber: 200,
      sku: "CARHARTT-JACKET-BROWN-M",
      status: "marked_unpaid",
    }),
  ]);
  const DEMO_VARIATION_NUMBERS = Object.freeze([
    DEMO_CURRENT_VARIATION_NUMBER,
    ...DEMO_VARIATION_SEEDS.map((seed) => seed.variationNumber),
  ]);
  const CAPTURE_STATE_NOTIFICATION_CHANNEL =
    "tiktok-live-tracker.capture-state";
  const CAPTURE_STATE_NOTIFICATION_VERSION = 1;
  const CAPTURE_STATE_NOTIFICATION_TYPE = "capture_state_changed";
  const CAPTURE_REFRESH_DELAY_MS = 150;
  const OBSERVED_PAYMENT_STATUSES = new Set([
    "not_observed",
    "payment_processing",
    "payment_fixing",
    "payment_failed",
    "canceled",
    "payment_complete",
    "unrecognized",
  ]);
  const RECOVERABLE_STREAM_BASELINE_ERROR_CODES = new Set([
    "STATE_NOT_INITIALIZED",
    "INVENTORY_BASELINE_REQUIRED",
  ]);
  const REPREVIEW_REQUIRED_ERROR_CODES = new Set([
    "PREVIEW_EXPIRED",
    "PREVIEW_NOT_FOUND",
    "STALE_PREVIEW",
    "REAUTHORIZE_REQUIRED",
    "GOOGLE_AUTH_SCOPE_MISSING",
    "GOOGLE_SCOPE_NOT_GRANTED",
  ]);
  const saleParser = globalThis.TikTokLiveTrackerSaleParser;
  const viewModel = globalThis.TikTokLiveTrackerInventoryViewModel;
  const reconciliation = globalThis.TikTokLiveTrackerReconciliation;
  const reconciliationProtocol =
    globalThis.TikTokLiveTrackerReconciliationCoordinator;
  const reconciliationClientModule =
    globalThis.TikTokLiveTrackerReconciliationClient;
  const streamSessionProtocol =
    globalThis.TikTokLiveTrackerStreamSessionCoordinator;
  const streamSessionClientModule =
    globalThis.TikTokLiveTrackerStreamSessionClient;
  const streamSessionControllerModule =
    globalThis.TikTokLiveTrackerStreamSessionController;
  const inventoryImportProtocol =
    globalThis.TikTokLiveTrackerInventoryImportProtocol;
  const inventoryImportClientModule =
    globalThis.TikTokLiveTrackerInventoryImportClient;
  const inventoryImportControllerModule =
    globalThis.TikTokLiveTrackerInventoryImportController;
  const mappingWorkflow = globalThis.TikTokLiveTrackerMappingWorkflow;
  const persistentTaggerControllerModule =
    globalThis.TikTokLiveTrackerPersistentTaggerController;
  const savedModeButton = document.querySelector("#saved-session-mode");
  const demoModeButton = document.querySelector("#offline-demo-mode");
  const modeDescription = document.querySelector("#mode-description");
  const savedSessionStatus = document.querySelector("#saved-session-status");
  const savedSessionStatusText = document.querySelector(
    "#saved-session-status-text",
  );
  const savedSessionError = document.querySelector("#saved-session-error");
  const savedSessionErrorTitle = document.querySelector(
    "#saved-session-error-title",
  );
  const savedSessionErrorMessage = document.querySelector(
    "#saved-session-error-message",
  );
  const retrySavedSessionButton = document.querySelector(
    "#retry-saved-session",
  );
  const inventoryImportPanel = document.querySelector(
    "#inventory-import-panel",
  );
  const inventoryImportBadge = document.querySelector(
    "#inventory-import-badge",
  );
  const inventoryImportForm = document.querySelector(
    "#inventory-import-form",
  );
  const inventorySheetReference = document.querySelector(
    "#inventory-sheet-reference",
  );
  const inventorySheetError = document.querySelector(
    "#inventory-sheet-error",
  );
  const previewInventoryButton = document.querySelector(
    "#preview-inventory",
  );
  const inventoryImportProgress = document.querySelector(
    "#inventory-import-progress",
  );
  const inventoryImportProgressTitle = document.querySelector(
    "#inventory-import-progress-title",
  );
  const inventoryImportProgressMessage = document.querySelector(
    "#inventory-import-progress-message",
  );
  const inventoryImportError = document.querySelector(
    "#inventory-import-error",
  );
  const inventoryImportErrorTitle = document.querySelector(
    "#inventory-import-error-title",
  );
  const inventoryImportErrorMessage = document.querySelector(
    "#inventory-import-error-message",
  );
  const inventoryImportIssues = document.querySelector(
    "#inventory-import-issues",
  );
  const retryInventoryImportButton = document.querySelector(
    "#retry-inventory-import",
  );
  const editInventoryReferenceButton = document.querySelector(
    "#edit-inventory-reference",
  );
  const inventoryImportPreview = document.querySelector(
    "#inventory-import-preview",
  );
  const changeInventorySheetButton = document.querySelector(
    "#change-inventory-sheet",
  );
  const cancelInventoryPreviewButton = document.querySelector(
    "#cancel-inventory-preview",
  );
  const confirmInventoryImportButton = document.querySelector(
    "#confirm-inventory-import",
  );
  const inventoryPreviewRowCount = document.querySelector(
    "#inventory-preview-row-count",
  );
  const inventoryPreviewUnitCount = document.querySelector(
    "#inventory-preview-unit-count",
  );
  const inventoryPreviewTotalCost = document.querySelector(
    "#inventory-preview-total-cost",
  );
  const inventoryPreviewRows = document.querySelector(
    "#inventory-preview-rows",
  );
  const inventoryImportConfirmation = document.querySelector(
    "#inventory-import-confirmation",
  );
  const inventoryImportConfirmationMessage = document.querySelector(
    "#inventory-import-confirmation-message",
  );
  const streamSessionPanel = document.querySelector("#stream-session-panel");
  const streamSessionBadge = document.querySelector("#stream-session-badge");
  const streamSessionStatus = document.querySelector("#stream-session-status");
  const streamSessionStatusTitle = document.querySelector(
    "#stream-session-status-title",
  );
  const streamSessionStatusMessage = document.querySelector(
    "#stream-session-status-message",
  );
  const streamSessionActions = document.querySelector(
    "#stream-session-actions",
  );
  const startStreamButton = document.querySelector("#start-stream");
  const resumeStreamButton = document.querySelector("#resume-stream");
  const endStreamButton = document.querySelector("#end-stream");
  const streamSessionEndConfirmation = document.querySelector(
    "#stream-session-end-confirmation",
  );
  const cancelEndStreamButton = document.querySelector("#cancel-end-stream");
  const confirmEndStreamButton = document.querySelector(
    "#confirm-end-stream",
  );
  const streamSessionError = document.querySelector("#stream-session-error");
  const streamSessionErrorTitle = document.querySelector(
    "#stream-session-error-title",
  );
  const streamSessionErrorMessage = document.querySelector(
    "#stream-session-error-message",
  );
  const retryStreamSessionButton = document.querySelector(
    "#retry-stream-session",
  );
  const trackerWorkspace = document.querySelector("#tracker-workspace");
  const dataModeBadge = document.querySelector("#data-mode-badge");
  const variationContext = document.querySelector("#variation-context");
  const variationSelector = document.querySelector("#variation-selector");
  const returnToCurrentButton = document.querySelector("#return-to-current");
  const inventoryTitle = document.querySelector("#inventory-title");
  const searchInput = document.querySelector("#inventory-search");
  const clearSearchButton = document.querySelector("#clear-search");
  const inventoryGrid = document.querySelector("#inventory-grid");
  const resultCount = document.querySelector("#result-count");
  const emptyState = document.querySelector("#empty-state");
  const emptyQuery = document.querySelector("#empty-query");
  const cardTemplate = document.querySelector("#inventory-card-template");
  const gmvNoShippingValue = document.querySelector("#revenue-value");
  const totalGmvValue = document.querySelector("#total-gmv-value");
  const grossProfitValue = document.querySelector("#gross-profit-value");
  const grossProfitWarning = document.querySelector(
    "#gross-profit-warning",
  );
  const pendingMapping = document.querySelector("#pending-mapping");
  const mappedVariation = document.querySelector(
    '[data-field="mapped-variation"]',
  );
  const mappedItem = document.querySelector("#mapped-item");
  const auctionEyebrow = document.querySelector("#auction-eyebrow");
  const auctionStatus = document.querySelector("#auction-status");
  const tiktokPaymentStatus = document.querySelector(
    "#tiktok-payment-status",
  );
  const observedPaymentStatus = document.querySelector(
    '[data-field="observed-payment-status"]',
  );
  const paymentPrice = document.querySelector("#payment-price");
  const mappingStatus = document.querySelector('[data-field="mapping-status"]');
  const saleResults = document.querySelector("#sale-results");
  const soldPriceResult = document.querySelector('[data-field="sold-price"]');
  const unitCostResult = document.querySelector('[data-field="unit-cost"]');
  const grossProfitResult = document.querySelector(
    '[data-field="gross-profit"]',
  );
  const remainingInventoryResult = document.querySelector(
    '[data-field="remaining-inventory"]',
  );
  const undoPaymentNote = document.querySelector("#undo-payment-note");
  const undoSimulatedPaymentButton = document.querySelector(
    "#undo-simulated-payment",
  );
  const stateWarning = document.querySelector("#state-warning");
  const lifecycleControls = document.querySelector("#lifecycle-controls");
  const lifecycleControlsLegend = document.querySelector(
    "#lifecycle-controls-legend",
  );
  const lifecycleControlsNote = document.querySelector(
    "#lifecycle-controls-note",
  );
  const completePaymentForm = document.querySelector(
    "#complete-payment-form",
  );
  const soldPriceInput = document.querySelector("#sold-price");
  const soldPriceError = document.querySelector("#sold-price-error");
  const simulateBufferButton = document.querySelector(
    "#simulate-buffer-expiry",
  );
  const bufferExpiredNote = document.querySelector("#buffer-expired-note");
  const markUnpaidButton = document.querySelector("#mark-unpaid");
  const unpaidNote = document.querySelector("#unpaid-note");
  const undoUnpaidButton = document.querySelector("#undo-unpaid");
  const mappingAnnouncement = document.querySelector("#mapping-announcement");
  const sessionFooterLabel = document.querySelector("#session-footer-label");

  if (
    !saleParser ||
    !viewModel ||
    !reconciliation ||
    !reconciliationProtocol ||
    !reconciliationClientModule ||
    !streamSessionProtocol ||
    !streamSessionClientModule ||
    !streamSessionControllerModule ||
    !inventoryImportProtocol ||
    !inventoryImportClientModule ||
    !inventoryImportControllerModule ||
    !mappingWorkflow ||
    !persistentTaggerControllerModule ||
    typeof persistentTaggerControllerModule.ensureInventoryInitialized !==
      "function"
  ) {
    console.error("[TikTok Live Tracker] Tagger lifecycle failed to load.");
    savedSessionStatus.hidden = true;
    savedSessionError.hidden = false;
    savedSessionErrorMessage.textContent =
      "The tracker did not load completely. Reload the extension and try again.";
    retrySavedSessionButton.addEventListener("click", () => location.reload());
    savedSessionError.focus();
    return;
  }

  const persistentClient =
    reconciliationClientModule.createReconciliationClient({
      runtime: chrome.runtime,
      protocol: reconciliationProtocol,
    });
  const streamSessionClient =
    streamSessionClientModule.createStreamSessionClient({
      runtime: chrome.runtime,
      protocol: streamSessionProtocol,
    });
  const streamSessionController =
    streamSessionControllerModule.createStreamSessionController({
      client: streamSessionClient,
    });
  const inventoryImportClient =
    inventoryImportClientModule.createInventoryImportClient({
      runtime: chrome.runtime,
      protocol: inventoryImportProtocol,
    });
  const inventoryImportController =
    inventoryImportControllerModule.createInventoryImportController({
      client: inventoryImportClient,
    });
  let activeMode = "saved_session";
  let demoSession = null;
  let persistentController = null;
  let unsubscribePersistentController = null;
  let mountedStreamId = null;
  let streamSnapshot = streamSessionController.getSnapshot();
  let inventoryImportSnapshot = inventoryImportController.getSnapshot();
  let savedSnapshot = {
    phase: "idle",
    operation: null,
    busy: false,
    error: null,
    view: null,
  };
  let previousSavedPhase = null;
  let pendingSavedAction = null;
  let hasFocusedSavedError = false;
  let focusSavedWorkspaceAfterRetry = false;
  let hasFocusedStreamError = false;
  let endConfirmationOpen = false;
  let captureRefreshTimerId = null;
  let captureRefreshDirty = false;
  let captureRefreshFocusSku = null;
  let captureRefreshHadVariationFocus = false;
  let lastRenderedSavedVariations = new Map();
  let previousInventoryImportPhase = null;
  let focusInventoryImportAfterRetry = false;

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function shouldPrepareInventoryForStreamRetry(snapshot) {
    return (
      snapshot?.error?.scope === "load" &&
      RECOVERABLE_STREAM_BASELINE_ERROR_CODES.has(snapshot.error.code)
    );
  }

  function hasExactKeys(value, expectedKeys) {
    return (
      isRecord(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...expectedKeys].sort())
    );
  }

  function isCaptureStateChangedNotification(message, sender) {
    return (
      hasExactKeys(message, ["channel", "version", "event"]) &&
      message.channel === CAPTURE_STATE_NOTIFICATION_CHANNEL &&
      message.version === CAPTURE_STATE_NOTIFICATION_VERSION &&
      hasExactKeys(message.event, ["type"]) &&
      message.event.type === CAPTURE_STATE_NOTIFICATION_TYPE &&
      sender?.id === chrome.runtime.id &&
      sender.tab === undefined
    );
  }

  function getRecordedVariations(view) {
    return view?.variations?.filter((variation) => variation.recorded) ?? [];
  }

  function hasSelectedRecordedVariation(view) {
    return getRecordedVariations(view).some((variation) => variation.selected);
  }

  function createSavedVariationSignatures(view) {
    return new Map(
      getRecordedVariations(view).map((variation) => [
        variation.variationNumber,
        JSON.stringify([
          variation.bidding === true,
          variation.status,
          variation.observedPaymentStatus,
          variation.soldPriceCents,
          variation.conflicts?.map((conflict) => [
            conflict.code,
            conflict.retainedSoldPriceCents ?? null,
            conflict.observedSoldPriceCents ?? null,
          ]) ?? [],
          variation.item,
          variation.style,
          variation.size,
        ]),
      ]),
    );
  }

  function findVariationOption(view, variationNumber) {
    return view?.variations?.find(
      (variation) => variation.variationNumber === variationNumber,
    ) ?? null;
  }

  function getSafeObservedPaymentStatus(value) {
    return OBSERVED_PAYMENT_STATUSES.has(value) ? value : "unavailable";
  }

  function getObservedPaymentStatusLabel(value) {
    return mappingWorkflow.getObservedPaymentStatusLabel(value);
  }

  function getCapturedPriceText(variation) {
    return variation?.observedPaymentStatus === "payment_complete" &&
      Number.isSafeInteger(variation.soldPriceCents)
      ? `, sold for ${viewModel.formatUsdCents(variation.soldPriceCents)}`
      : "";
  }

  function describeObservedPaymentUpdate(variation) {
    const priceConflict = variation?.conflicts?.find(
      (candidate) => candidate.code === "conflicting_sold_price",
    );
    const completedAfterUnpaid = variation?.conflicts?.some(
      (candidate) => candidate.code === "payment_completed_after_marked_unpaid",
    );
    const completedAfterCanceled = variation?.conflicts?.some(
      (candidate) => candidate.code === "payment_completed_after_canceled",
    );

    if (priceConflict) {
      return `Payment price conflict for variation #${variation.variationNumber}. The first captured price, ${viewModel.formatUsdCents(priceConflict.retainedSoldPriceCents)}, was retained for review.`;
    }

    if (variation?.status === "canceled") {
      return `Variation #${variation.variationNumber} was canceled. Its inventory reservation was released and stock remains unchanged.`;
    }

    if (variation?.observedPaymentStatus === "payment_complete") {
      const reviewDetail = completedAfterCanceled
        ? " TikTok completion overrode its earlier cancellation; inventory was counted. Review the warning."
        : completedAfterUnpaid
          ? " It was previously marked unpaid; review the warning."
          : "";

      return `Payment complete captured for variation #${variation.variationNumber}${getCapturedPriceText(variation)}.${reviewDetail}`;
    }

    return `Variation #${variation.variationNumber} TikTok payment status: ${variation?.observedPaymentStatusLabel ?? getObservedPaymentStatusLabel(undefined)}.`;
  }

  function describeLiveRefresh(previous, view, includeExistingUpdates = true) {
    const next = createSavedVariationSignatures(view);
    const added = [...next.keys()].filter((number) => !previous.has(number));
    const updated = includeExistingUpdates
      ? [...next.entries()]
          .filter(([number, signature]) =>
            previous.has(number) && previous.get(number) !== signature,
          )
          .map(([number]) => number)
      : [];
    const activeBiddingVariation = findVariationOption(
      view,
      view.activeBiddingVariationNumber,
    );
    const previousActiveSignature = activeBiddingVariation
      ? previous.get(activeBiddingVariation.variationNumber)
      : null;
    let wasPreviouslyBidding = false;

    if (typeof previousActiveSignature === "string") {
      try {
        wasPreviouslyBidding =
          JSON.parse(previousActiveSignature)?.[0] === true;
      } catch (_error) {
        // A stale UI-only signature must not interrupt live capture updates.
      }
    }

    if (activeBiddingVariation && !wasPreviouslyBidding) {
      return activeBiddingVariation.selected
        ? `Variation #${activeBiddingVariation.variationNumber} is now bidding. It is selected and ready to tag.`
        : `Variation #${activeBiddingVariation.variationNumber} is now bidding. Variation #${view.selectedVariationNumber} remains selected.`;
    }

    if (added.length === 1 && updated.length === 0) {
      const addedVariation = findVariationOption(view, added[0]);
      const paymentDetail =
        addedVariation?.observedPaymentStatus === "payment_complete"
          ? `${addedVariation.observedPaymentStatusLabel}${getCapturedPriceText(addedVariation)}.`
          : `TikTok payment: ${addedVariation?.observedPaymentStatusLabel ?? getObservedPaymentStatusLabel(undefined)}.`;

      return added[0] === view.selectedVariationNumber
        ? `Captured variation #${added[0]} from Sold Items. ${paymentDetail} It is selected and ready to tag.`
        : `Captured earlier variation #${added[0]} from Sold Items. ${paymentDetail} Variation #${view.selectedVariationNumber} remains selected.`;
    }

    if (added.length > 1 && updated.length === 0) {
      return `Captured ${added.length} new Sold Items variations: ${added.map((number) => `#${number}`).join(", ")}. Now showing variation #${view.selectedVariationNumber}.`;
    }

    if (added.length === 0 && updated.length === 1) {
      return describeObservedPaymentUpdate(
        findVariationOption(view, updated[0]),
      );
    }

    if (added.length > 0 || updated.length > 0) {
      return `Live auction data updated ${added.length + updated.length} variations.`;
    }

    return "";
  }

  function clearCaptureRefreshTimer() {
    if (captureRefreshTimerId !== null) {
      window.clearTimeout(captureRefreshTimerId);
      captureRefreshTimerId = null;
    }
  }

  function getFocusedInventorySku() {
    const button = document.activeElement?.closest?.("button[data-sku]");

    return button && inventoryGrid.contains(button)
      ? button.dataset.sku
      : null;
  }

  function armCaptureRefresh() {
    if (
      !captureRefreshDirty ||
      captureRefreshTimerId !== null ||
      activeMode !== "saved_session" ||
      !streamSnapshot.resumed ||
      streamSnapshot.activeSession === null ||
      persistentController === null
    ) {
      return;
    }

    const scheduledController = persistentController;
    const scheduledStreamId = mountedStreamId;

    captureRefreshTimerId = window.setTimeout(() => {
      captureRefreshTimerId = null;

      if (
        scheduledController !== persistentController ||
        scheduledStreamId !== mountedStreamId ||
        activeMode !== "saved_session" ||
        !streamSnapshot.resumed
      ) {
        return;
      }

      captureRefreshDirty = false;
      captureRefreshFocusSku = getFocusedInventorySku();
      captureRefreshHadVariationFocus = pendingMapping.contains(
        document.activeElement,
      );
      Promise.resolve()
        .then(() => scheduledController.refresh())
        .then((snapshot) => {
          if (
            scheduledController === persistentController &&
            scheduledStreamId === mountedStreamId &&
            snapshot?.operation !== "refresh"
          ) {
            captureRefreshDirty = true;

            if (snapshot?.phase === "ready") {
              armCaptureRefresh();
            }
          }
        })
        .catch((error) => {
          console.error(
            "[TikTok Live Tracker] Unexpected live auction refresh failure.",
            error,
          );
        });
    }, CAPTURE_REFRESH_DELAY_MS);
  }

  function scheduleCaptureRefresh() {
    captureRefreshDirty = true;
    armCaptureRefresh();
  }

  function handleCaptureStateChanged(message, sender) {
    if (!isCaptureStateChangedNotification(message, sender)) {
      return false;
    }

    scheduleCaptureRefresh();
    return false;
  }

  function createDemoSession() {
    const nextSession = mappingWorkflow.createMappingSession({
      inventory: viewModel.MOCK_INVENTORY,
      reconciliation,
      streamId: DEMO_STREAM_ID,
      variationNumber: DEMO_CURRENT_VARIATION_NUMBER,
      variationNumbers: DEMO_VARIATION_NUMBERS,
      offlineSimulation: true,
    });

    seedDemoVariationHistory(nextSession);
    return nextSession;
  }

  function getDemoSession() {
    if (demoSession === null) {
      demoSession = createDemoSession();
    }

    return demoSession;
  }

  function getActiveView() {
    return activeMode === "offline_demo"
      ? getDemoSession().getViewState()
      : savedSnapshot?.view ?? null;
  }

  function createEmptySavedSnapshot() {
    return {
      phase: "idle",
      operation: null,
      busy: false,
      error: null,
      view: null,
    };
  }

  function unmountPersistentController() {
    clearCaptureRefreshTimer();
    unsubscribePersistentController?.();
    unsubscribePersistentController = null;
    persistentController = null;
    mountedStreamId = null;
    savedSnapshot = createEmptySavedSnapshot();
    previousSavedPhase = null;
    pendingSavedAction = null;
    captureRefreshDirty = false;
    captureRefreshFocusSku = null;
    captureRefreshHadVariationFocus = false;
    lastRenderedSavedVariations = new Map();
    savedSessionStatus.hidden = true;
    savedSessionError.hidden = true;
    trackerWorkspace.hidden = true;
    trackerWorkspace.toggleAttribute("inert", true);
  }

  function mountPersistentController(activeSession) {
    if (mountedStreamId === activeSession.streamId && persistentController) {
      return;
    }

    unmountPersistentController();
    mountedStreamId = activeSession.streamId;
    persistentController =
      persistentTaggerControllerModule.createPersistentTaggerController({
        client: persistentClient,
        reconciliation,
        mappingWorkflow,
        streamId: activeSession.streamId,
        currentVariationNumber: DEMO_CURRENT_VARIATION_NUMBER,
        variationNumbers: DEMO_VARIATION_NUMBERS,
      });
    const mountedController = persistentController;

    savedSnapshot = mountedController.getSnapshot();
    unsubscribePersistentController =
      mountedController.subscribe(renderSavedSnapshot);
    Promise.resolve()
      .then(() => mountedController.start())
      .catch((error) => {
        console.error(
          "[TikTok Live Tracker] Unexpected live-session startup failure.",
          error,
        );
      });
  }

  function setWorkspaceBusy(busy) {
    const streamUnavailable =
      activeMode === "saved_session" &&
      (!streamSnapshot.resumed || streamSnapshot.activeSession === null);
    const shouldBeBusy =
      Boolean(busy) ||
      (activeMode === "saved_session" && streamSnapshot.busy) ||
      streamUnavailable;
    const shouldBeInert =
      shouldBeBusy ||
      (activeMode === "saved_session" &&
        (savedSnapshot?.phase === "error" || endConfirmationOpen));

    trackerWorkspace.setAttribute("aria-busy", String(shouldBeBusy));
    trackerWorkspace.toggleAttribute("inert", shouldBeInert);
  }

  function isSavedWorkspaceUnavailable() {
    return (
      persistentController === null || savedSnapshot?.phase !== "ready"
    );
  }

  function updateModeControls() {
    const savedMode = activeMode === "saved_session";

    savedModeButton.setAttribute("aria-pressed", String(savedMode));
    demoModeButton.setAttribute("aria-pressed", String(!savedMode));
    demoModeButton.disabled = savedMode && savedSnapshot?.phase === "saving";
    streamSessionPanel.hidden = !savedMode;
    inventoryImportPanel.hidden =
      !savedMode ||
      streamSnapshot.activeSession !== null ||
      shouldPrepareInventoryForStreamRetry(streamSnapshot);
    modeDescription.textContent = savedMode
      ? "Start or resume a local tracker stream. Mappings and unpaid changes are saved and restored when this panel reopens."
      : `Temporary simulator. Demo actions are not saved or applied to TikTok.${streamSnapshot.activeSession ? " Your live tracker stream remains active in the background." : ""}`;
    dataModeBadge.textContent = savedMode ? "Live session" : "Demo data";
    sessionFooterLabel.textContent = !savedMode
      ? "Offline demo - not saved"
      : !streamSnapshot.activeSession
        ? "No active tracker stream"
        : !streamSnapshot.resumed
          ? "Tracker stream ready to resume"
      : {
          idle: "Restoring live session data",
          loading: "Restoring live session data",
          saving: "Saving locally",
          error: "Live session data needs attention",
          ready: "Saved locally",
        }[savedSnapshot?.phase] ?? "Live session";
  }

  function requireDemoSeedResult(result, action) {
    if (!result.ok) {
      throw new Error(`Could not ${action}: ${result.message}`);
    }

    return result;
  }

  function seedDemoVariationHistory(session) {
    DEMO_VARIATION_SEEDS.forEach((seed) => {
      requireDemoSeedResult(
        session.selectVariation(seed.variationNumber),
        `select demo variation ${seed.variationNumber}`,
      );

      if (seed.sku) {
        requireDemoSeedResult(
          session.selectSku(seed.sku),
          `map demo variation ${seed.variationNumber}`,
        );
      }

      if (seed.status === "committed") {
        requireDemoSeedResult(
          session.completePayment(seed.soldPriceCents),
          `complete demo variation ${seed.variationNumber}`,
        );
      } else if (seed.status === "marked_unpaid") {
        requireDemoSeedResult(
          session.simulatePaymentBufferExpired(),
          `expire demo variation ${seed.variationNumber}`,
        );
        requireDemoSeedResult(
          session.markUnpaid(),
          `mark demo variation ${seed.variationNumber} unpaid`,
        );
      }
    });

    requireDemoSeedResult(
      session.selectVariation(DEMO_CURRENT_VARIATION_NUMBER),
      "return to the current demo variation",
    );
  }

  function formatItemName(entry) {
    return entry.style ? `${entry.item} - ${entry.style}` : entry.item;
  }

  function createInventoryCard(entry, view) {
    const auction = view.auction;
    const variationNumber = view.variationNumber;
    const wrapper = cardTemplate.content.firstElementChild.cloneNode(true);
    const button = wrapper.querySelector(".inventory-card");
    const selectedLabel = wrapper.querySelector('[data-field="selected"]');
    const stock = viewModel.getStockDisplay(entry);
    const stockAriaLabel = stock.ariaLabel ?? stock.label;
    const selected = entry.selected;
    const itemName = formatItemName(entry);
    const canTagSelectedVariation =
      activeMode !== "saved_session" || hasSelectedRecordedVariation(view);

    button.dataset.sku = entry.sku;
    button.dataset.stockState = stock.state;
    button.dataset.selectionReason = entry.selectionReason;
    button.disabled = !entry.selectionAllowed || !canTagSelectedVariation;
    button.setAttribute("aria-pressed", String(selected));

    if (!canTagSelectedVariation) {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, ${stockAriaLabel}. Wait for a live auction variation before tagging.`,
      );
    } else if (selected && auction?.status === "canceled") {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, is linked to canceled variation ${variationNumber}, ${stockAriaLabel}. Its reservation is released and stock is unchanged. Click to unlink this item.`,
      );
    } else if (selected) {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, is selected for variation ${variationNumber}, ${stockAriaLabel}. Click to unselect this item.`,
      );
    } else if (button.disabled) {
      const action = auction?.sku ? "correct" : "map";

      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, ${stockAriaLabel}. Cannot ${action} variation ${variationNumber}.`,
      );
    } else if (auction?.status === "canceled") {
      const action = auction.sku ? "Relink" : "Link";

      button.setAttribute(
        "aria-label",
        `${action} canceled variation ${variationNumber} to ${itemName}, size ${entry.size}, ${stockAriaLabel}. Stock counts will not change.`,
      );
    } else if (auction?.sku) {
      button.setAttribute(
        "aria-label",
        `Correct variation ${variationNumber} to ${itemName}, size ${entry.size}, ${stockAriaLabel}.`,
      );
    } else {
      button.setAttribute(
        "aria-label",
        `Map variation ${variationNumber} to ${itemName}, size ${entry.size}, ${stockAriaLabel}.`,
      );
    }

    wrapper.querySelector('[data-field="item"]').textContent = entry.item;
    wrapper.querySelector('[data-field="style"]').textContent = entry.style;
    wrapper.querySelector('[data-field="size"]').textContent = entry.size;
    wrapper.querySelector('[data-field="stock-primary"]').textContent =
      stock.primaryLabel ?? stock.label;

    const secondaryStockLabel = wrapper.querySelector(
      '[data-field="stock-secondary"]',
    );

    secondaryStockLabel.textContent = stock.secondaryLabel ?? "";
    secondaryStockLabel.hidden = !stock.secondaryLabel;
    selectedLabel.hidden = !selected;

    if (auction?.status === "committed" && selected) {
      selectedLabel.textContent = "Sold";
    } else if (auction?.status === "canceled" && selected) {
      selectedLabel.textContent = "Linked";
    } else if (auction?.status === "marked_unpaid" && selected) {
      selectedLabel.textContent = "Unpaid";
    } else {
      selectedLabel.textContent = "Selected";
    }

    return wrapper;
  }

  function formatResultCount(visibleCount, totalCount, hasQuery) {
    if (!hasQuery) {
      return `${totalCount} inventory ${totalCount === 1 ? "entry" : "entries"}`;
    }

    return `${visibleCount} of ${totalCount} ${visibleCount === 1 ? "match" : "matches"}`;
  }

  function restoreCardFocus(sku) {
    const button = [...inventoryGrid.querySelectorAll("button[data-sku]")].find(
      (candidate) => candidate.dataset.sku === sku,
    );

    if (button && !button.disabled) {
      button.focus();
    } else {
      searchInput.focus();
    }
  }

  function formatVariationOption(option) {
    const item = option.item
      ? `${formatItemName(option)}, size ${option.size}`
      : "No item selected";
    const status = option.bidding
      ? "bidding"
      : option.observedPaymentStatusLabel;

    return `#${option.variationNumber} - ${status} - ${item}`;
  }

  function renderVariationNavigation(view) {
    const fragment = document.createDocumentFragment();
    const variations = activeMode === "saved_session"
      ? getRecordedVariations(view)
      : view.variations;

    if (variations.length === 0) {
      const option = document.createElement("option");

      option.value = "";
      option.textContent = "Waiting for live auction variations";
      option.disabled = true;
      option.selected = true;
      fragment.append(option);
    } else {
      variations.forEach((variation) => {
        const option = document.createElement("option");

        option.value = String(variation.variationNumber);
        option.textContent = formatVariationOption(variation);
        option.selected = variation.selected;
        fragment.append(option);
      });
    }

    variationSelector.replaceChildren(fragment);
    variationSelector.disabled = variations.length === 0;

    if (activeMode === "saved_session") {
      if (variations.length > 0) {
        variationSelector.value = String(view.selectedVariationNumber);
        variationContext.textContent = "Live auction variations";
        inventoryTitle.textContent =
          `Review or tag variation #${view.selectedVariationNumber}`;
      } else {
        variationContext.textContent =
          "Waiting for a live auction variation";
        inventoryTitle.textContent = "Waiting for a live auction variation";
      }

      returnToCurrentButton.hidden = true;
      return;
    }

    variationSelector.value = String(view.selectedVariationNumber);
    variationContext.textContent = view.isReviewingHistory
      ? "Reviewing previous variation"
      : "On screen now";
    returnToCurrentButton.hidden = !view.isReviewingHistory;
    returnToCurrentButton.textContent =
      `Return to on-screen variation #${view.currentVariationNumber}`;
    inventoryTitle.textContent = view.isReviewingHistory
      ? `Review or correct variation #${view.selectedVariationNumber}`
      : `Find the item for variation #${view.currentVariationNumber}`;
  }

  function renderInventory(view, focusSku = null) {
    const query = searchInput.value;
    const normalizedQuery = viewModel.normalizeSearchText(query);
    const filteredInventory = viewModel.filterInventoryEntries(
      view.inventory,
      query,
    );
    const fragment = document.createDocumentFragment();

    filteredInventory.forEach((entry) => {
      fragment.append(createInventoryCard(entry, view));
    });

    inventoryGrid.replaceChildren(fragment);
    inventoryGrid.hidden = filteredInventory.length === 0;
    emptyState.hidden = filteredInventory.length !== 0;
    emptyQuery.textContent = `"${query.trim()}"`;
    clearSearchButton.hidden = normalizedQuery.length === 0;
    const nextResultCount = formatResultCount(
      filteredInventory.length,
      view.inventory.length,
      normalizedQuery.length > 0,
    );

    if (resultCount.textContent !== nextResultCount) {
      resultCount.textContent = nextResultCount;
    }

    if (focusSku) {
      restoreCardFocus(focusSku);
    }
  }

  function renderMetrics(view) {
    const formattedGmvNoShipping = viewModel.formatUsdCents(
      view.totals.completedGmvCents,
    );
    const formattedGrossProfit = viewModel.formatUsdCents(
      view.totals.profitCents,
    );
    const attributedGmvDisplay = view.totals.attributedGmvDisplay;
    const unmatchedCompletedCount = view.totals.unmappedCompletedCount;
    const formattedTotalGmv =
      typeof attributedGmvDisplay === "string" && attributedGmvDisplay.trim()
        ? attributedGmvDisplay.trim()
        : "—";

    if (gmvNoShippingValue.textContent !== formattedGmvNoShipping) {
      gmvNoShippingValue.textContent = formattedGmvNoShipping;
    }

    if (totalGmvValue.textContent !== formattedTotalGmv) {
      totalGmvValue.textContent = formattedTotalGmv;
    }

    if (grossProfitValue.textContent !== formattedGrossProfit) {
      grossProfitValue.textContent = formattedGrossProfit;
    }

    if (unmatchedCompletedCount > 0) {
      const warning = unmatchedCompletedCount === 1
        ? "Incomplete — 1 completed sale still needs an inventory item."
        : `Incomplete — ${unmatchedCompletedCount} completed sales still need inventory items.`;

      if (grossProfitWarning.textContent !== warning) {
        grossProfitWarning.textContent = warning;
      }
      grossProfitWarning.hidden = false;
    } else {
      grossProfitWarning.hidden = true;
      grossProfitWarning.textContent = "";
    }
  }

  function describeStateWarning(view) {
    const conflict = view.auction?.conflicts?.[0];

    if (conflict?.code === "conflicting_sold_price") {
      return `Price conflict: the first completed price, ${viewModel.formatUsdCents(conflict.retainedSoldPriceCents)}, was retained for review.`;
    }

    if (conflict?.code === "payment_completed_after_marked_unpaid") {
      return "TikTok completed this payment after it was marked unpaid. The completed sale was counted and flagged for review.";
    }

    if (conflict?.code === "payment_completed_after_canceled") {
      return "TikTok completed this payment after it was canceled. TikTok completion won, inventory was counted, and the order was flagged for review.";
    }

    if (view.auction?.status === "unmapped_completed") {
      return "Payment is complete, but this variation still needs an inventory item. Select the matching entry below.";
    }

    if (isObservedCompletionAwaitingPrice(view.auction)) {
      return view.auction.sku
        ? "TikTok shows Payment complete, but the final price is still syncing. The item stays selected without a pending reservation; inventory will update automatically when the completed sale finishes syncing."
        : "TikTok shows Payment complete, but the final price is still syncing. Select the matching item; inventory will update automatically when the completed sale finishes syncing.";
    }

    const negativeInventory = view.warnings.find(
      (warning) => warning.code === "negative_inventory",
    );

    if (negativeInventory) {
      const entry = view.inventory.find(
        (inventoryEntry) => inventoryEntry.sku === negativeInventory.sku,
      );
      const itemLabel = entry
        ? `${formatItemName(entry)}, size ${entry.size}`
        : "this inventory entry";

      return `Inventory warning: ${itemLabel} is short by ${negativeInventory.oversoldQuantity}. The sale remains recorded for review.`;
    }

    const unavailable = view.warnings.find(
      (warning) => warning.code === "no_stock_available",
    );

    if (unavailable) {
      const entry = view.inventory.find(
        (inventoryEntry) => inventoryEntry.sku === unavailable.sku,
      );
      const itemLabel = entry
        ? `${formatItemName(entry)}, size ${entry.size}`
        : "This inventory entry";
      const isCurrentVariation =
        unavailable.eventKey === view.auction?.eventKey;

      return isCurrentVariation
        ? `Inventory warning: ${itemLabel} does not have an available unit for variation #${view.variationNumber}.`
        : `Inventory warning: another pending variation reserves ${itemLabel} without an available unit. Review pending tags.`;
    }

    return "";
  }

  function renderStateWarning(view) {
    const warning = describeStateWarning(view);

    if (stateWarning.textContent !== warning) {
      stateWarning.textContent = warning;
    }

    const shouldHide = warning.length === 0;

    if (stateWarning.hidden !== shouldHide) {
      stateWarning.hidden = shouldHide;
    }
  }

  function renderSaleResults(view) {
    const auction = view.auction;
    const committed = auction?.status === "committed";

    saleResults.hidden = !committed;

    if (!committed) {
      return;
    }

    const selectedInventory = view.inventory.find(
      (entry) => entry.sku === auction.sku,
    );
    const remainingQuantity =
      selectedInventory?.remainingQuantity ??
      auction.inventory?.remainingQuantity;
    const profit = viewModel.getProfitDisplay(auction.profitCents);

    soldPriceResult.textContent = viewModel.formatUsdCents(
      auction.soldPriceCents,
    );
    unitCostResult.textContent = viewModel.formatUsdCents(
      auction.committedUnitCostCents,
    );
    grossProfitResult.textContent = profit.label;
    grossProfitResult.dataset.tone = profit.tone;
    remainingInventoryResult.textContent = Number.isSafeInteger(
      remainingQuantity,
    )
      ? `${remainingQuantity} remaining`
      : "Inventory unavailable";
  }

  function getInventoryTagLabel(auction) {
    if (auction.paymentStatus === "payment_complete") {
      return auction.sku ? "Sale assigned" : "No item selected";
    }

    if (isObservedCompletionAwaitingPrice(auction)) {
      return auction.sku
        ? "Final price syncing - item selected"
        : "Final price syncing - no item selected";
    }

    if (auction.paymentStatus === "canceled") {
      return auction.sku
        ? "Item linked · reservation released · stock unchanged"
        : "No item linked · stock unchanged";
    }

    if (auction.mappingStatus === "marked_unpaid") {
      return "Marked unpaid locally";
    }

    if (!auction.sku) {
      return "No item selected";
    }

    return isInventoryReservationPending(auction)
      ? "Pending"
      : "Item selected";
  }

  function isInventoryReservationPending(auction) {
    return auction?.status === "pending";
  }

  function isObservedCompletionAwaitingPrice(auction) {
    return (
      auction?.observedPaymentStatus === "payment_complete" &&
      auction.paymentStatus !== "payment_complete"
    );
  }

  function renderOrderStatuses(auction) {
    const safeObservedStatus = getSafeObservedPaymentStatus(
      auction.observedPaymentStatus,
    );
    const observedLabel = getObservedPaymentStatusLabel(
      auction.observedPaymentStatus,
    );
    const hasCapturedPrice =
      auction.observedPaymentStatus === "payment_complete" &&
      Number.isSafeInteger(auction.soldPriceCents);

    observedPaymentStatus.textContent = observedLabel;
    tiktokPaymentStatus.dataset.paymentStatus = safeObservedStatus;
    paymentPrice.hidden = !hasCapturedPrice;
    paymentPrice.textContent = hasCapturedPrice
      ? `(${viewModel.formatUsdCents(auction.soldPriceCents)} captured)`
      : "";
    mappingStatus.textContent = getInventoryTagLabel(auction);
  }

  function renderLifecycleControls(view) {
    const committed = view.auction?.status === "committed";
    const canceled = view.auction?.status === "canceled";
    const markedUnpaid = view.auction?.status === "marked_unpaid";
    const completionAwaitingPrice = isObservedCompletionAwaitingPrice(
      view.auction,
    );
    const offlineDemo = activeMode === "offline_demo";
    const canUndoSimulatedPayment =
      offlineDemo && view.controls.canUndoSimulatedPayment;
    const canUndoUnpaid = view.controls.canUndoUnpaid;

    lifecycleControlsLegend.textContent = offlineDemo
      ? "Offline test controls"
      : "Saved order controls";
    lifecycleControlsNote.textContent = offlineDemo
      ? "These controls simulate TikTok events in temporary memory and do not act on TikTok."
      : "Mark unpaid only after TikTok's payment buffer has expired. These employee changes are saved locally.";
    undoPaymentNote.textContent = view.mapping
      ? "Offline demo only. Remove the simulated payment, keep the item selected, and do not change TikTok."
      : "Offline demo only. Remove the simulated payment with no item selected, and do not change TikTok.";

    lifecycleControls.hidden =
      canceled ||
      completionAwaitingPrice ||
      (!view.mapping && !canUndoSimulatedPayment && !canUndoUnpaid) ||
      (committed && !canUndoSimulatedPayment) ||
      (!offlineDemo && committed);
    completePaymentForm.hidden =
      !offlineDemo || !view.controls.canCompletePayment;
    simulateBufferButton.hidden =
      !offlineDemo || !view.controls.canSimulateBufferExpiry;
    bufferExpiredNote.hidden = !(
      offlineDemo &&
      view.demo.paymentBufferExpired &&
      (view.auction?.status === "mapped" ||
        view.auction?.status === "pending")
    );
    markUnpaidButton.hidden = completionAwaitingPrice || (offlineDemo
      ? !view.controls.canMarkUnpaid
      : view.auction?.status !== "pending");
    markUnpaidButton.disabled = completionAwaitingPrice;
    unpaidNote.hidden = !markedUnpaid;
    undoUnpaidButton.hidden = offlineDemo
      ? !view.controls.canUndoUnpaid
      : !markedUnpaid;
    undoPaymentNote.hidden = !canUndoSimulatedPayment;
    undoSimulatedPaymentButton.hidden = !canUndoSimulatedPayment;
  }

  function renderAuction(view) {
    const auction = view.auction;

    if (!auction) {
      pendingMapping.hidden = true;
      return;
    }

    mappedVariation.textContent = `#${auction.variationNumber}`;
    mappedItem.textContent = auction.sku
      ? `${formatItemName(auction)}, size ${auction.size}`
      : "No item selected. Select the matching inventory entry below.";
    auctionEyebrow.textContent = activeMode === "offline_demo"
      ? "Demo order status"
      : "Live order status";
    renderOrderStatuses(auction);
    auctionStatus.dataset.status = auction.status;
    pendingMapping.dataset.status = auction.status;
    pendingMapping.hidden = false;

    renderSaleResults(view);
    renderStateWarning(view);
    renderLifecycleControls(view);
  }

  function renderAll(options = {}) {
    const view = getActiveView();

    if (!view) {
      return null;
    }

    renderVariationNavigation(view);
    renderAuction(view);
    renderInventory(view, options.focusSku ?? null);
    renderMetrics(view);

    if (options.focusStatus && !pendingMapping.hidden) {
      auctionStatus.focus();
    } else if (options.focusControl === "mark_unpaid") {
      markUnpaidButton.focus();
    } else if (options.focusVariation) {
      variationSelector.focus();
    }

    return view;
  }

  function clearPriceError() {
    soldPriceInput.removeAttribute("aria-invalid");
    soldPriceError.textContent = "";
    soldPriceError.hidden = true;
  }

  function showPriceError(message) {
    soldPriceInput.setAttribute("aria-invalid", "true");
    soldPriceError.textContent = message;
    soldPriceError.hidden = false;
    soldPriceInput.focus();
  }

  function announceMapping(result) {
    if (result.action === "unmapped") {
      const detail =
        {
          canceled:
            "The canceled order remains recorded. Its item link was removed and stock stays unchanged.",
          committed:
            "Payment remains complete, but inventory and gross profit need a replacement item.",
          marked_unpaid:
            "The unpaid status remains and no item is selected.",
          pending:
            "Its pending reservation was released and no item is selected.",
        }[result.previousStatus] ?? "No item is selected.";

      mappingAnnouncement.textContent =
        `Variation ${result.view.variationNumber} item unselected. ${detail}`;
      return;
    }

    const mapping = result.mapping;
    const itemDescription = `${formatItemName(mapping)}, size ${mapping.size}`;
    const paymentLabel =
      result.view.auction?.observedPaymentStatusLabel ??
      getObservedPaymentStatusLabel(undefined);

    if (result.action === "completed_sale_mapped") {
      const profit = viewModel.getProfitDisplay(mapping.profitCents);

      mappingAnnouncement.textContent = `Payment-complete variation ${mapping.variationNumber} matched to ${itemDescription}. Sold for ${viewModel.formatUsdCents(mapping.soldPriceCents)}; ${profit.label} recorded.`;
    } else if (result.action === "committed_mapping_corrected") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} corrected to ${itemDescription}. Inventory and gross profit recalculated.`;
    } else if (result.action === "canceled_order_mapped") {
      mappingAnnouncement.textContent = `Canceled variation ${mapping.variationNumber} linked to ${itemDescription}. Its reservation remains released and stock stays unchanged.`;
    } else if (result.action === "canceled_mapping_corrected") {
      mappingAnnouncement.textContent = `Canceled variation ${mapping.variationNumber} relinked to ${itemDescription}. Stock stays unchanged.`;
    } else if (result.action === "unpaid_mapping_corrected") {
      mappingAnnouncement.textContent = `Unpaid variation ${mapping.variationNumber} corrected to ${itemDescription}. Remaining inventory and profit stay unchanged.`;
    } else if (result.action === "remapped") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} changed to ${itemDescription}. TikTok payment: ${paymentLabel}.`;
    } else if (result.action === "unchanged") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} is already mapped to ${itemDescription}.`;
    } else {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} mapped to ${itemDescription}. TikTok payment: ${paymentLabel}.`;
    }
  }

  function describeSelectedVariation(view) {
    const selected = view.variations.find((variation) => variation.selected);

    if (!selected) {
      return `Variation ${view.selectedVariationNumber}`;
    }

    const item = selected.item
      ? `, ${formatItemName(selected)}, size ${selected.size}`
      : ", no item selected";

    return `Variation ${selected.variationNumber}, TikTok payment: ${selected.observedPaymentStatusLabel}${item}`;
  }

  function getSavedStatusText(snapshot) {
    if (snapshot.phase === "idle" || snapshot.phase === "loading") {
      if (snapshot.operation === "initialize") {
        return "Preparing live session data...";
      }

      return snapshot.operation === "refresh"
        ? "Checking live auction data..."
        : "Restoring live session data...";
    }

    if (snapshot.phase === "saving") {
      return "Saving change...";
    }

    if (snapshot.operation === "refresh") {
      return "Live auction data updated";
    }

    return snapshot.operation === "load" || snapshot.operation === "initialize"
      ? "Live session data restored"
      : "Saved locally";
  }

  function formatStreamStart(startedAt) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(startedAt));
    } catch (_error) {
      return "an earlier time";
    }
  }

  function isInventoryReadyForStart(snapshot = inventoryImportSnapshot) {
    return (
      snapshot.hasConfirmedBaseline === true &&
      snapshot.busy !== true &&
      snapshot.preview === null &&
      snapshot.phase !== "error"
    );
  }

  function describeImportSummary(summary) {
    if (!summary) {
      return "The confirmed inventory is ready for the next tracker stream.";
    }

    const rowLabel = summary.rowCount === 1 ? "row" : "rows";
    const unitLabel =
      summary.totalQuantityOnHandAtImport === 1 ? "unit" : "units";

    return `${summary.rowCount} ${rowLabel} and ${summary.totalQuantityOnHandAtImport} opening ${unitLabel} are ready for the next tracker stream.`;
  }

  function clearInventorySheetFieldError() {
    inventorySheetReference.removeAttribute("aria-invalid");
    inventorySheetError.hidden = true;
    inventorySheetError.textContent = "";
  }

  function renderInventoryImportIssues(issues) {
    inventoryImportIssues.replaceChildren();

    issues.forEach((issue) => {
      const item = document.createElement("li");
      const location = [
        issue.rowNumber === null ? null : `Row ${issue.rowNumber}`,
        issue.column === null ? null : issue.column,
      ].filter(Boolean).join(", ");

      item.textContent = location
        ? `${location}: ${issue.message}`
        : issue.message;
      inventoryImportIssues.append(item);
    });

    inventoryImportIssues.hidden = issues.length === 0;
  }

  function renderInventoryPreview(preview) {
    const { inventory, summary } = preview;

    inventoryPreviewRowCount.textContent = String(summary.rowCount);
    inventoryPreviewUnitCount.textContent = String(
      summary.totalQuantityOnHandAtImport,
    );
    inventoryPreviewTotalCost.textContent = viewModel.formatUsdCents(
      summary.totalInventoryCostCents,
    );
    const rowsFragment = document.createDocumentFragment();

    inventory.forEach((row) => {
      const tableRow = document.createElement("tr");
      [
        row.sku,
        row.item,
        row.style || "None",
        row.size,
        String(row.quantityOnHandAtImport),
        viewModel.formatUsdCents(row.unitCostCents),
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        tableRow.append(cell);
      });
      rowsFragment.append(tableRow);
    });
    inventoryPreviewRows.replaceChildren(rowsFragment);
  }

  function renderInventoryImportSnapshot(snapshot) {
    inventoryImportSnapshot = snapshot;
    const savedMode = activeMode === "saved_session";
    const streamExists = streamSnapshot.activeSession !== null;
    const busy = snapshot.busy === true;
    const failed = snapshot.phase === "error";
    const preview = snapshot.preview;
    const showPanel =
      savedMode &&
      !streamExists &&
      !shouldPrepareInventoryForStreamRetry(streamSnapshot);

    inventoryImportPanel.hidden = !showPanel;

    if (!showPanel) {
      previousInventoryImportPhase = snapshot.phase;
      return;
    }

    inventoryImportPanel.setAttribute("aria-busy", String(busy));
    inventoryImportForm.hidden = preview !== null;
    inventoryImportPreview.hidden = preview === null;
    inventoryImportForm.toggleAttribute("inert", busy);
    inventoryImportPreview.toggleAttribute("inert", busy);
    inventoryImportProgress.hidden = !busy;
    inventoryImportError.hidden = !failed;
    inventoryImportConfirmation.hidden =
      !snapshot.hasConfirmedBaseline || preview !== null || failed || busy;
    inventorySheetReference.disabled = busy;
    previewInventoryButton.disabled = busy;
    retryInventoryImportButton.disabled = busy;
    editInventoryReferenceButton.disabled = busy;
    changeInventorySheetButton.disabled = busy;
    cancelInventoryPreviewButton.disabled = busy;
    confirmInventoryImportButton.disabled = busy || preview === null || failed;

    inventoryImportBadge.dataset.state = failed
      ? "error"
      : busy
        ? "checking"
        : preview !== null
          ? "preview"
          : snapshot.hasConfirmedBaseline
            ? "ready"
            : "required";
    inventoryImportBadge.textContent = failed
      ? "Needs attention"
      : busy
        ? snapshot.operation === "confirm"
          ? "Confirming"
          : snapshot.operation === "preview"
            ? "Connecting"
            : "Checking"
        : preview !== null
          ? "Preview ready"
          : snapshot.hasConfirmedBaseline
            ? "Ready"
            : "Import required";

    if (busy) {
      inventoryImportProgressTitle.textContent =
        snapshot.operation === "confirm"
          ? "Confirming inventory baseline..."
          : snapshot.operation === "preview"
            ? "Connecting to Google Sheets..."
            : "Checking saved inventory...";
      inventoryImportProgressMessage.textContent =
        snapshot.operation === "confirm"
          ? "Saving the validated opening inventory locally."
          : snapshot.operation === "preview"
            ? "Waiting for authorization and validating the Inventory tab."
            : "Looking for a previously confirmed Google Sheets baseline.";
    }

    if (preview !== null) {
      inventorySheetReference.value = "";
      clearInventorySheetFieldError();
      renderInventoryPreview(preview);

      if (
        previousInventoryImportPhase === "previewing" ||
        (previousInventoryImportPhase === "error" &&
          snapshot.phase === "ready")
      ) {
        confirmInventoryImportButton.focus();
      }
    }

    if (failed) {
      const issues = snapshot.error?.issues ?? [];
      const invalidReference =
        snapshot.error?.code === "INVALID_SPREADSHEET_REFERENCE" ||
        snapshot.error?.code === "INVALID_SPREADSHEET_ID";

      inventoryImportErrorTitle.textContent =
        snapshot.error?.scope === "confirm"
          ? "Inventory could not be confirmed"
          : snapshot.error?.scope === "load"
            ? "Saved inventory could not be checked"
            : "Inventory could not be previewed";
      inventoryImportErrorMessage.textContent = snapshot.error?.message ??
        "Nothing was imported. Correct the Sheet and try again.";
      retryInventoryImportButton.textContent =
        REPREVIEW_REQUIRED_ERROR_CODES.has(snapshot.error?.code)
        ? "Preview again"
        : "Retry";
      renderInventoryImportIssues(issues);

      if (invalidReference) {
        inventorySheetReference.setAttribute("aria-invalid", "true");
        inventorySheetError.textContent = inventoryImportErrorMessage.textContent;
        inventorySheetError.hidden = false;
      }

      if (previousInventoryImportPhase !== "error") {
        if (invalidReference) {
          inventorySheetReference.focus();
        } else {
          inventoryImportError.focus();
        }
      }
    } else {
      clearInventorySheetFieldError();
      renderInventoryImportIssues([]);
    }

    if (
      snapshot.hasConfirmedBaseline &&
      preview === null &&
      !failed &&
      !busy
    ) {
      inventoryImportConfirmationMessage.textContent =
        describeImportSummary(snapshot.confirmation?.summary);

      if (
        previousInventoryImportPhase === "confirming" ||
        focusInventoryImportAfterRetry
      ) {
        inventoryImportConfirmation.focus();
        focusInventoryImportAfterRetry = false;
      }
    }

    previousInventoryImportPhase = snapshot.phase;

    if (streamSnapshot.activeSession === null) {
      startStreamButton.disabled =
        streamSnapshot.busy || !isInventoryReadyForStart(snapshot);

      if (streamSnapshot.phase === "ready") {
        streamSessionStatusMessage.textContent = busy
          ? "Wait for the inventory check to finish before starting a tracker stream."
          : preview !== null
            ? "Review and confirm the inventory preview, or cancel it, before starting."
            : isInventoryReadyForStart(snapshot)
              ? "Confirmed inventory is ready. Start a local stream when TikTok LIVE begins."
              : "Connect, preview, and confirm Google Sheets inventory before starting a local tracker stream.";
      }
    }
  }

  function renderStreamSnapshot(snapshot) {
    const streamWasActive = streamSnapshot.activeSession !== null;
    streamSnapshot = snapshot;
    updateModeControls();
    inventoryImportController.setActiveStream(snapshot.activeSession !== null);

    if (streamWasActive && snapshot.activeSession === null) {
      Promise.resolve(inventoryImportController.refreshStatus()).catch(
        (error) => {
          console.error(
            "[TikTok Live Tracker] Unexpected post-stream inventory-status failure.",
            error,
          );
        },
      );
    }

    if (activeMode !== "saved_session") {
      return;
    }

    const failed = snapshot.phase === "error";
    const busy = snapshot.busy === true;
    const checking = snapshot.phase === "idle" || snapshot.phase === "loading";
    const activeSession = snapshot.activeSession;
    const resumeAvailable = activeSession !== null && !snapshot.resumed;
    const active = activeSession !== null && snapshot.resumed;
    const dataState = failed
      ? "error"
      : checking || busy
        ? "checking"
        : active
          ? "active"
          : resumeAvailable
            ? "resume"
            : "inactive";

    streamSessionPanel.dataset.state = dataState;
    streamSessionPanel.setAttribute("aria-busy", String(checking || busy));
    streamSessionBadge.dataset.state = dataState;
    streamSessionStatus.hidden = failed;
    streamSessionError.hidden = !failed;
    streamSessionActions.hidden = failed || checking || busy;
    startStreamButton.hidden = true;
    resumeStreamButton.hidden = true;
    endStreamButton.hidden = true;
    startStreamButton.disabled = busy || !isInventoryReadyForStart();
    resumeStreamButton.disabled = busy;
    endStreamButton.disabled = busy;
    confirmEndStreamButton.disabled = busy;
    cancelEndStreamButton.disabled = busy;

    if (failed) {
      endConfirmationOpen = false;
      streamSessionEndConfirmation.hidden = true;
      streamSessionBadge.textContent = "Needs attention";
      streamSessionErrorTitle.textContent =
        snapshot.error?.scope === "load"
          ? "Tracker stream unavailable"
          : "Stream change was not saved";
      streamSessionErrorMessage.textContent = snapshot.error?.message
        ? `${snapshot.error.message} Nothing was changed.`
        : "The tracker stream could not be updated. Nothing was changed.";
      retryStreamSessionButton.textContent =
        snapshot.error?.scope === "load" ? "Retry loading" : "Retry change";

      if (!hasFocusedStreamError) {
        streamSessionError.focus();
        hasFocusedStreamError = true;
      }

      if (!active) {
        unmountPersistentController();
      } else {
        setWorkspaceBusy(false);
      }

      return;
    }

    hasFocusedStreamError = false;

    if (checking || busy) {
      streamSessionBadge.textContent =
        checking
          ? "Checking"
          : snapshot.operation === "end"
            ? "Ending"
            : "Saving";
      streamSessionStatusTitle.textContent =
        snapshot.operation === "end"
          ? "Ending tracker stream..."
          : snapshot.operation === "start"
            ? "Starting tracker stream..."
            : "Checking saved stream...";
      streamSessionStatusMessage.textContent =
        checking
          ? "Looking for an active tracker stream that can be resumed."
          : "Waiting for the local session change to finish safely.";
      if (!persistentController) {
        savedSessionStatus.hidden = true;
        savedSessionError.hidden = true;
        trackerWorkspace.hidden = true;
      }
      setWorkspaceBusy(true);
      return;
    }

    streamSessionActions.hidden = false;

    if (activeSession === null) {
      endConfirmationOpen = false;
      streamSessionEndConfirmation.hidden = true;
      streamSessionBadge.textContent = "Not started";
      streamSessionStatusTitle.textContent = "No active tracker stream";
      streamSessionStatusMessage.textContent =
        isInventoryReadyForStart()
          ? "Confirmed inventory is ready. Start a local stream when TikTok LIVE begins."
          : "Connect, preview, and confirm Google Sheets inventory before starting a local tracker stream.";
      startStreamButton.hidden = false;
      startStreamButton.disabled = !isInventoryReadyForStart();
      unmountPersistentController();
      return;
    }

    const startedLabel = formatStreamStart(activeSession.startedAt);

    if (resumeAvailable) {
      streamSessionBadge.textContent = "Ready to resume";
      streamSessionStatusTitle.textContent = "Active stream found";
      streamSessionStatusMessage.textContent =
        `Started ${startedLabel}. Resume it to continue tagging, or end it without loading the inventory workspace.`;
      resumeStreamButton.hidden = endConfirmationOpen;
      endStreamButton.hidden = endConfirmationOpen;
      streamSessionEndConfirmation.hidden = !endConfirmationOpen;
      unmountPersistentController();
      return;
    }

    streamSessionBadge.textContent = "Active";
    streamSessionStatusTitle.textContent = "Tracker stream active";
    streamSessionStatusMessage.textContent =
      `Started ${startedLabel}. This local identity will survive panel and browser restarts.`;
    endStreamButton.hidden = endConfirmationOpen;
    streamSessionEndConfirmation.hidden = !endConfirmationOpen;
    mountPersistentController(activeSession);
    setWorkspaceBusy(savedSnapshot?.busy === true);
  }

  function announceSavedAction(action, view) {
    const variationNumber =
      action.variationNumber ?? view.selectedVariationNumber;

    if (action.type === "map_variation") {
      mappingAnnouncement.textContent = view.auction?.status === "canceled"
        ? `Canceled variation ${variationNumber} item link saved locally. Its reservation is released and stock remains unchanged.`
        : `Variation ${variationNumber} mapping saved locally.`;
    } else if (action.type === "unmap_variation") {
      mappingAnnouncement.textContent = view.auction?.status === "canceled"
        ? `Canceled variation ${variationNumber} item link removed and saved locally. Stock remains unchanged.`
        : `Variation ${variationNumber} item unselected and saved locally. No item is selected.`;
    } else if (action.type === "mark_unpaid") {
      mappingAnnouncement.textContent =
        `Variation ${variationNumber} marked unpaid and saved locally. Its item stays linked without a pending reservation.`;
    } else if (action.type === "undo_mark_unpaid") {
      mappingAnnouncement.textContent =
        `Unpaid mark removed from variation ${variationNumber} and saved locally. Its TikTok payment status is unchanged.`;
    }
  }

  function renderSavedSnapshot(snapshot) {
    const priorPhase = savedSnapshot?.phase ?? previousSavedPhase;
    const priorVariations = lastRenderedSavedVariations;
    const priorSelectedVariationNumber =
      savedSnapshot?.view?.selectedVariationNumber ?? null;

    savedSnapshot = snapshot;
    updateModeControls();

    if (
      activeMode !== "saved_session" ||
      !streamSnapshot.resumed ||
      streamSnapshot.activeSession === null
    ) {
      previousSavedPhase = snapshot.phase;
      return;
    }

    endStreamButton.disabled = streamSnapshot.busy;
    confirmEndStreamButton.disabled = streamSnapshot.busy;

    if (snapshot.phase === "loading" && snapshot.operation === "refresh") {
      captureRefreshFocusSku =
        getFocusedInventorySku() ?? captureRefreshFocusSku;
      captureRefreshHadVariationFocus =
        pendingMapping.contains(document.activeElement) ||
        captureRefreshHadVariationFocus;
    }

    const failed = snapshot.phase === "error";
    const hasView = snapshot.view !== null;

    savedSessionStatus.hidden = failed;
    savedSessionError.hidden = !failed;
    trackerWorkspace.hidden = !hasView;

    if (failed) {
      const loadFailure = snapshot.error?.scope === "load" || !hasView;
      const refreshFailure = snapshot.error?.scope === "refresh" && hasView;

      setWorkspaceBusy(false);
      trackerWorkspace.toggleAttribute("inert", true);
      savedSessionErrorTitle.textContent = refreshFailure
        ? "Live auction refresh failed"
        : loadFailure
          ? "Live session data unavailable"
          : "Change was not saved";
      savedSessionErrorMessage.textContent = snapshot.error?.message
        ? refreshFailure
          ? `${snapshot.error.message} The last saved view is still shown; retry before making more changes.`
          : `${snapshot.error.message} Your last saved data was not changed.`
        : refreshFailure
          ? "The newest live auction data could not be loaded. Retry before making more changes."
          : "Your last saved data was not changed. Try again.";
      retrySavedSessionButton.textContent = refreshFailure
        ? "Retry live update"
        : loadFailure
          ? "Retry loading"
          : "Retry saving";

      if (!hasFocusedSavedError || priorPhase !== "error") {
        savedSessionError.focus();
        hasFocusedSavedError = true;
      }

      previousSavedPhase = snapshot.phase;
      return;
    }

    hasFocusedSavedError = false;
    savedSessionStatus.dataset.phase = snapshot.phase;
    const nextStatusText = getSavedStatusText(snapshot);

    if (savedSessionStatusText.textContent !== nextStatusText) {
      savedSessionStatusText.textContent = nextStatusText;
    }
    setWorkspaceBusy(snapshot.busy === true);

    if (hasView && snapshot.phase === "ready") {
      const completedAction = pendingSavedAction;
      const focusOptions = {};
      const refreshCompleted = snapshot.operation === "refresh";
      const selectedNewVariation =
        snapshot.view.selectedVariationNumber !== priorSelectedVariationNumber &&
        !priorVariations.has(snapshot.view.selectedVariationNumber) &&
        snapshot.view.variations.some(
          (variation) =>
            variation.recorded &&
            variation.variationNumber === snapshot.view.selectedVariationNumber,
        );

      if (
        selectedNewVariation &&
        (
          completedAction?.focusSku ||
          completedAction?.focusStatus ||
          captureRefreshFocusSku ||
          captureRefreshHadVariationFocus
        )
      ) {
        focusOptions.focusVariation = true;
      } else if (completedAction?.focusSku) {
        focusOptions.focusSku = completedAction.focusSku;
      } else if (completedAction?.focusStatus) {
        focusOptions.focusStatus = true;
      } else if (refreshCompleted && captureRefreshFocusSku) {
        focusOptions.focusSku = captureRefreshFocusSku;
      }

      const view = renderAll(focusOptions);
      const liveRefreshAnnouncement = refreshCompleted || completedAction
        ? describeLiveRefresh(priorVariations, view, refreshCompleted)
        : "";

      lastRenderedSavedVariations = createSavedVariationSignatures(view);
      captureRefreshFocusSku = null;
      captureRefreshHadVariationFocus = false;

      if (completedAction) {
        announceSavedAction(completedAction, view);
        if (liveRefreshAnnouncement) {
          mappingAnnouncement.textContent += ` ${liveRefreshAnnouncement}`;
        }
        pendingSavedAction = null;
      } else if (focusSavedWorkspaceAfterRetry) {
        focusSavedWorkspaceAfterRetry = false;
        if (hasSelectedRecordedVariation(view)) {
          variationSelector.focus();
          mappingAnnouncement.textContent = refreshCompleted
            ? liveRefreshAnnouncement || "Live auction data is up to date."
            : "Live session data restored. You can continue with the selected auction variation.";
        } else {
          streamSessionStatus.focus();
          mappingAnnouncement.textContent =
            "Live tracking is ready. Waiting for a live auction variation.";
        }
      } else if (liveRefreshAnnouncement) {
        mappingAnnouncement.textContent = liveRefreshAnnouncement;
      } else if (priorPhase === "loading" && !refreshCompleted) {
        mappingAnnouncement.textContent =
          "Live session data restored from local browser storage.";
      }

      if (captureRefreshDirty) {
        armCaptureRefresh();
      }
    }

    previousSavedPhase = snapshot.phase;
  }

  function runSavedMutation(action, pendingAction) {
    if (
      !persistentController ||
      !streamSnapshot.resumed ||
      streamSnapshot.activeSession === null
    ) {
      mappingAnnouncement.textContent =
        "Start or resume a tracker stream before saving live changes.";
      return;
    }

    if (pendingSavedAction || savedSnapshot?.busy) {
      mappingAnnouncement.textContent =
        "Wait for the current saved-session change to finish.";
      return;
    }

    let operation;

    try {
      operation = action();
    } catch (error) {
      mappingAnnouncement.textContent =
        error?.message ?? "That change could not be started.";
      return;
    }

    pendingSavedAction = pendingAction;

    Promise.resolve(operation).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected saved-session action failure.",
        error,
      );
    });
  }

  function selectMode(mode) {
    if (mode === activeMode) {
      return;
    }

    activeMode = mode;
    endConfirmationOpen = false;
    streamSessionEndConfirmation.hidden = true;
    clearPriceError();
    searchInput.value = "";
    soldPriceInput.value = DEFAULT_DEMO_SOLD_PRICE;
    updateModeControls();

    if (activeMode === "offline_demo") {
      savedSessionStatus.hidden = true;
      savedSessionError.hidden = true;
      trackerWorkspace.hidden = false;
      setWorkspaceBusy(false);
      const view = renderAll();

      variationSelector.focus();
      mappingAnnouncement.textContent =
        `Offline demo opened on ${describeSelectedVariation(view)}. Demo actions are temporary and are not saved.`;
      return;
    }

    armCaptureRefresh();
    hasFocusedSavedError = false;
    hasFocusedStreamError = false;
    renderStreamSnapshot(streamSessionController.getSnapshot());
    if (streamSnapshot.resumed && persistentController) {
      renderSavedSnapshot(persistentController.getSnapshot());
    }

    if (
      streamSnapshot.resumed &&
      persistentController &&
      savedSnapshot.phase === "ready" &&
      savedSnapshot.view
    ) {
      focusSavedWorkspaceAfterRetry = false;
      if (hasSelectedRecordedVariation(savedSnapshot.view)) {
        variationSelector.focus();
        mappingAnnouncement.textContent =
          `Returned to live auction tracking on ${describeSelectedVariation(savedSnapshot.view)}.`;
      } else {
        streamSessionStatus.focus();
        mappingAnnouncement.textContent =
          "Returned to live auction tracking. Waiting for a captured variation.";
      }
    } else if (streamSnapshot.activeSession && !streamSnapshot.resumed) {
      resumeStreamButton.focus();
    } else if (!streamSnapshot.activeSession && streamSnapshot.phase === "ready") {
      startStreamButton.focus();
    }
  }

  variationSelector.addEventListener("change", () => {
    if (activeMode === "saved_session") {
      if (!persistentController || variationSelector.value === "") {
        mappingAnnouncement.textContent =
          "Waiting for a live auction variation.";
        return;
      }

      try {
        clearPriceError();
        searchInput.value = "";
        const snapshot = persistentController.selectVariation(
          Number(variationSelector.value),
        );

        const view = snapshot.view;

        mappingAnnouncement.textContent =
          `Reviewing auction ${describeSelectedVariation(view)}. A newly captured variation will open automatically.`;
      } catch (error) {
        mappingAnnouncement.textContent =
          error?.message ?? "That variation could not be selected.";
      }

      return;
    }

    const result = getDemoSession().selectVariation(
      Number(variationSelector.value),
    );

    if (!result.ok) {
      renderAll();
      mappingAnnouncement.textContent = result.message;
      return;
    }

    clearPriceError();
    soldPriceInput.value = DEFAULT_DEMO_SOLD_PRICE;
    searchInput.value = "";
    const view = renderAll();
    mappingAnnouncement.textContent = view.isReviewingHistory
      ? `Reviewing previous ${describeSelectedVariation(view)}. Select an inventory card to tag or correct this variation.`
      : `Returned to on-screen ${describeSelectedVariation(view)}.`;
  });

  returnToCurrentButton.addEventListener("click", () => {
    if (activeMode === "saved_session") {
      return;
    }

    const result = getDemoSession().selectVariation(
      DEMO_CURRENT_VARIATION_NUMBER,
    );

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    clearPriceError();
    soldPriceInput.value = DEFAULT_DEMO_SOLD_PRICE;
    searchInput.value = "";
    const view = renderAll();

    variationSelector.focus();
    mappingAnnouncement.textContent =
      `Returned to on-screen ${describeSelectedVariation(view)}.`;
  });

  inventoryGrid.addEventListener("click", (event) => {
    const button = event.target.closest?.("button[data-sku]");

    if (!button || button.disabled || !inventoryGrid.contains(button)) {
      return;
    }

    if (activeMode === "saved_session") {
      const view = getActiveView();

      if (!hasSelectedRecordedVariation(view)) {
        mappingAnnouncement.textContent =
          "Wait for a captured live auction variation before selecting inventory.";
        return;
      }

      const selected = button.getAttribute("aria-pressed") === "true";

      runSavedMutation(
        () => selected
          ? persistentController.unmapSelectedVariation()
          : persistentController.mapSelectedSku(button.dataset.sku),
        {
          type: selected ? "unmap_variation" : "map_variation",
          variationNumber: view.selectedVariationNumber,
          focusSku: button.dataset.sku,
        },
      );
      return;
    }

    const result = getDemoSession().selectSku(button.dataset.sku);

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    clearPriceError();
    renderAll({ focusSku: button.dataset.sku });
    announceMapping(result);
  });

  completePaymentForm.addEventListener("submit", (event) => {
    event.preventDefault();

    if (activeMode !== "offline_demo") {
      mappingAnnouncement.textContent =
        "Payment simulation is available only in Offline demo mode.";
      return;
    }

    const normalizedPrice = soldPriceInput.value.replace(/^\s*\$/, "");
    const soldPriceCents = saleParser.parseMoneyToCents(normalizedPrice);

    if (soldPriceCents === null || soldPriceCents < 1) {
      showPriceError("Enter a valid sold price greater than $0.00.");
      return;
    }

    const result = getDemoSession().completePayment(soldPriceCents);

    if (!result.ok) {
      showPriceError(result.message);
      return;
    }

    clearPriceError();
    const view = renderAll({ focusStatus: true });
    const profit = viewModel.getProfitDisplay(view.auction.profitCents);

    mappingAnnouncement.textContent = `Payment complete for variation ${view.variationNumber}. Sold for ${viewModel.formatUsdCents(view.auction.soldPriceCents)}. ${profit.label}.`;
  });

  simulateBufferButton.addEventListener("click", () => {
    if (activeMode !== "offline_demo") {
      return;
    }

    const result = getDemoSession().simulatePaymentBufferExpired();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    renderAll({ focusControl: "mark_unpaid" });
    mappingAnnouncement.textContent = `Payment buffer expired for variation ${result.view.variationNumber} in this demo.`;
  });

  markUnpaidButton.addEventListener("click", () => {
    if (activeMode === "saved_session") {
      const view = getActiveView();

      runSavedMutation(
        () => persistentController.markSelectedUnpaid(),
        {
          type: "mark_unpaid",
          variationNumber: view.selectedVariationNumber,
          focusStatus: true,
        },
      );
      return;
    }

    const result = getDemoSession().markUnpaid();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    renderAll({ focusStatus: true });
    mappingAnnouncement.textContent = `Variation ${result.view.variationNumber} marked unpaid. Remaining inventory and profit stay unchanged; its reservation is released.`;
  });

  undoUnpaidButton.addEventListener("click", () => {
    if (activeMode === "saved_session") {
      const view = getActiveView();

      runSavedMutation(
        () => persistentController.undoSelectedUnpaid(),
        {
          type: "undo_mark_unpaid",
          variationNumber: view.selectedVariationNumber,
          focusStatus: true,
        },
      );
      return;
    }

    const result = getDemoSession().undoMarkUnpaid();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    renderAll({ focusStatus: true });
    mappingAnnouncement.textContent = result.mapping
      ? `Unpaid mark removed from variation ${result.view.variationNumber}. Waiting for payment.`
      : `Unpaid mark removed from variation ${result.view.variationNumber}. No item is selected.`;
  });

  undoSimulatedPaymentButton.addEventListener("click", () => {
    if (activeMode !== "offline_demo") {
      return;
    }

    const result = getDemoSession().undoSimulatedPayment();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    clearPriceError();
    searchInput.value = "";
    renderAll(
      result.mapping
        ? { focusSku: result.mapping.sku }
        : { focusStatus: true },
    );
    mappingAnnouncement.textContent = result.mapping
      ? `Simulated payment undone for variation ${result.view.variationNumber}. It is waiting for payment again. The selected item remains reserved; remaining inventory and gross profit were restored.`
      : `Simulated payment undone for variation ${result.view.variationNumber}. No item is selected; remaining inventory and gross profit were restored.`;
  });

  searchInput.addEventListener("input", () => renderAll());

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value) {
      searchInput.value = "";
      renderAll();
    }
  });

  clearSearchButton.addEventListener("click", () => {
    searchInput.value = "";
    searchInput.focus();
    renderAll();
  });

  soldPriceInput.addEventListener("input", clearPriceError);

  savedModeButton.addEventListener("click", () => {
    selectMode("saved_session");
  });

  demoModeButton.addEventListener("click", () => {
    selectMode("offline_demo");
  });

  inventorySheetReference.addEventListener("input", () => {
    clearInventorySheetFieldError();
  });

  inventoryImportForm.addEventListener("submit", (event) => {
    event.preventDefault();

    if (streamSnapshot.activeSession !== null || inventoryImportSnapshot.busy) {
      return;
    }

    clearInventorySheetFieldError();
    mappingAnnouncement.textContent =
      "Connecting to Google Sheets and validating the Inventory tab.";

    try {
      const operation = inventoryImportController.previewReference(
        inventorySheetReference.value,
      );

      inventoryImportProgress.focus();
      Promise.resolve(operation)
        .then((snapshot) => {
          if (snapshot.phase === "ready" && snapshot.preview !== null) {
            confirmInventoryImportButton.focus();
            mappingAnnouncement.textContent =
              `Inventory preview ready with ${snapshot.preview.summary.rowCount} rows. Review every opening quantity before confirming.`;
          }
        })
        .catch((error) => {
          console.error(
            "[TikTok Live Tracker] Unexpected inventory-preview failure.",
            error,
          );
        });
    } catch (error) {
      mappingAnnouncement.textContent =
        error?.message ?? "The inventory preview could not be started.";
    }
  });

  function resetInventoryPreviewAndFocus() {
    try {
      inventoryImportController.resetPreview();
      inventorySheetReference.value = "";
      clearInventorySheetFieldError();
      inventorySheetReference.focus();
    } catch (error) {
      mappingAnnouncement.textContent =
        error?.message ?? "Wait for the inventory operation to finish.";
    }
  }

  changeInventorySheetButton.addEventListener(
    "click",
    resetInventoryPreviewAndFocus,
  );
  cancelInventoryPreviewButton.addEventListener(
    "click",
    resetInventoryPreviewAndFocus,
  );
  editInventoryReferenceButton.addEventListener(
    "click",
    resetInventoryPreviewAndFocus,
  );

  confirmInventoryImportButton.addEventListener("click", () => {
    if (
      streamSnapshot.activeSession !== null ||
      inventoryImportSnapshot.busy ||
      inventoryImportSnapshot.preview === null
    ) {
      return;
    }

    focusInventoryImportAfterRetry = true;
    mappingAnnouncement.textContent =
      "Confirming the validated opening inventory for future tracker streams.";

    try {
      const operation = inventoryImportController.confirmPreview();

      inventoryImportProgress.focus();
      Promise.resolve(operation)
        .then((snapshot) => {
          if (snapshot.phase === "ready" && snapshot.hasConfirmedBaseline) {
            mappingAnnouncement.textContent =
              "Inventory baseline confirmed. Start is now available.";
            renderStreamSnapshot(streamSessionController.getSnapshot());
          }
        })
        .catch((error) => {
          console.error(
            "[TikTok Live Tracker] Unexpected inventory-confirmation failure.",
            error,
          );
        });
    } catch (error) {
      mappingAnnouncement.textContent =
        error?.message ?? "The inventory baseline could not be confirmed.";
    }
  });

  retryInventoryImportButton.addEventListener("click", () => {
    if (inventoryImportSnapshot.busy) {
      return;
    }

    if (REPREVIEW_REQUIRED_ERROR_CODES.has(inventoryImportSnapshot.error?.code)) {
      resetInventoryPreviewAndFocus();
      mappingAnnouncement.textContent =
        "Paste the Sheet link again to create a fresh inventory preview.";
      return;
    }

    focusInventoryImportAfterRetry = true;
    inventoryImportProgress.focus();
    Promise.resolve(inventoryImportController.retry()).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected inventory-import retry failure.",
        error,
      );
    });
  });

  startStreamButton.addEventListener("click", () => {
    if (!isInventoryReadyForStart()) {
      mappingAnnouncement.textContent =
        "Confirm Google Sheets inventory before starting a live tracker stream.";
      inventoryImportPanel.scrollIntoView({ block: "start" });
      inventorySheetReference.focus();
      return;
    }

    focusSavedWorkspaceAfterRetry = true;
    streamSessionStatus.focus();
    mappingAnnouncement.textContent =
      "Starting the tracker stream with the confirmed inventory baseline.";
    Promise.resolve()
      .then(() => streamSessionController.startNewStream())
      .then((snapshot) => {
        if (snapshot.phase === "ready" && snapshot.resumed) {
          mappingAnnouncement.textContent =
            "Local tracker stream started. Saved inventory is loading.";
        }
      })
      .catch((error) => {
        mappingAnnouncement.textContent =
          error?.message ??
          "Local inventory could not be prepared, so the tracker stream was not started.";
        console.error(
          "[TikTok Live Tracker] Unexpected stream-start failure.",
          error,
        );
      });
  });

  resumeStreamButton.addEventListener("click", () => {
    focusSavedWorkspaceAfterRetry = true;
    streamSessionStatus.focus();

    try {
      streamSessionController.resumeActiveStream();
      mappingAnnouncement.textContent =
        "Active tracker stream resumed. Saved inventory is loading.";
    } catch (error) {
      mappingAnnouncement.textContent =
        error?.message ?? "The tracker stream could not be resumed.";
    }
  });

  endStreamButton.addEventListener("click", () => {
    if (streamSnapshot.busy) {
      mappingAnnouncement.textContent =
        "Wait for the current tracker stream change to finish before ending.";
      return;
    }

    endConfirmationOpen = true;
    renderStreamSnapshot(streamSessionController.getSnapshot());
    cancelEndStreamButton.focus();
  });

  cancelEndStreamButton.addEventListener("click", () => {
    endConfirmationOpen = false;
    renderStreamSnapshot(streamSessionController.getSnapshot());
    endStreamButton.focus();
  });

  confirmEndStreamButton.addEventListener("click", () => {
    if (streamSnapshot.busy) {
      mappingAnnouncement.textContent =
        "Wait for the current tracker stream change to finish before ending.";
      return;
    }

    endConfirmationOpen = false;
    streamSessionEndConfirmation.hidden = true;
    streamSessionStatus.focus();
    Promise.resolve()
      .then(() => streamSessionController.endActiveStream())
      .then((snapshot) => {
        if (snapshot.phase === "ready" && snapshot.activeSession === null) {
          startStreamButton.focus();
          mappingAnnouncement.textContent =
            "Tracker stream ended locally. TikTok LIVE was not changed, and saved order history was kept.";
        }
      })
      .catch((error) => {
        console.error(
          "[TikTok Live Tracker] Unexpected stream-end failure.",
          error,
        );
      });
  });

  retryStreamSessionButton.addEventListener("click", () => {
    const prepareMissingInventory =
      shouldPrepareInventoryForStreamRetry(streamSnapshot);

    hasFocusedStreamError = false;
    streamSessionStatus.hidden = false;
    streamSessionError.hidden = true;
    streamSessionStatusTitle.textContent = "Retrying tracker stream...";
    streamSessionStatusMessage.textContent =
      "Checking the saved local stream before allowing more changes.";
    streamSessionStatus.focus();
    Promise.resolve()
      .then(() => {
        if (!prepareMissingInventory) {
          return null;
        }

        mappingAnnouncement.textContent =
          "Recovering the legacy inventory for this already-active tracker stream.";
        return persistentTaggerControllerModule.ensureInventoryInitialized({
          client: persistentClient,
          inventory: viewModel.MOCK_INVENTORY,
        });
      })
      .then(() => streamSessionController.retry())
      .then((snapshot) => {
        if (snapshot.phase !== "ready") {
          return;
        }

        if (snapshot.activeSession === null) {
          startStreamButton.focus();
        } else if (!snapshot.resumed) {
          resumeStreamButton.focus();
        }
      })
      .catch((error) => {
        renderStreamSnapshot(streamSessionController.getSnapshot());
        mappingAnnouncement.textContent =
          error?.message ??
          "Local inventory could not be prepared, so the tracker stream was not restored.";
        console.error(
          "[TikTok Live Tracker] Unexpected stream-session retry failure.",
          error,
        );
      });
  });

  retrySavedSessionButton.addEventListener("click", () => {
    if (!persistentController) {
      return;
    }

    hasFocusedSavedError = false;
    focusSavedWorkspaceAfterRetry =
      ["load", "refresh"].includes(savedSnapshot.error?.scope) ||
      savedSnapshot.view === null;
    Promise.resolve().then(() => persistentController.retry()).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected saved-session retry failure.",
        error,
      );
    });
  });

  chrome.runtime.onMessage.addListener(handleCaptureStateChanged);
  window.addEventListener(
    "pagehide",
    () => {
      clearCaptureRefreshTimer();
      chrome.runtime.onMessage.removeListener(handleCaptureStateChanged);
    },
    { once: true },
  );
  inventoryImportController.subscribe(renderInventoryImportSnapshot);
  Promise.resolve().then(() => inventoryImportController.start()).catch((error) => {
    console.error(
      "[TikTok Live Tracker] Unexpected inventory-status startup failure.",
      error,
    );
  });
  streamSessionController.subscribe(renderStreamSnapshot);
  Promise.resolve().then(() => streamSessionController.start()).catch((error) => {
    console.error(
      "[TikTok Live Tracker] Unexpected stream-session startup failure.",
      error,
    );
  });
})();
