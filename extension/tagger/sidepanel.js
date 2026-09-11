(function initializeTaggerLifecycle() {
  "use strict";

  const FALLBACK_CURRENT_VARIATION_NUMBER = 203;
  const FALLBACK_VARIATION_NUMBERS = Object.freeze([203, 202, 201, 200]);
  const CAPTURE_STATE_NOTIFICATION_CHANNEL =
    "tiktok-live-tracker.capture-state";
  const CAPTURE_STATE_NOTIFICATION_VERSION = 1;
  const CAPTURE_STATE_NOTIFICATION_TYPE = "capture_state_changed";
  const CAPTURE_REFRESH_DELAY_MS = 150;
  const ACTIVE_STREAM_INVENTORY_FEEDBACK_DURATION_MS = 4_000;
  const COLLAPSED_INVENTORY_ITEM_LIMIT = 9;
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
  const viewModel = globalThis.TikTokLiveTrackerInventoryViewModel;
  const tiktokFeeCalculator =
    globalThis.TikTokLiveTrackerTikTokFeeCalculator;
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
  const streamReportProtocol =
    globalThis.TikTokLiveTrackerStreamReportProtocol;
  const liveBidProtocol =
    globalThis.TikTokLiveTrackerLiveBidProtocol;
  const nextItemQueueProtocol =
    globalThis.TikTokLiveTrackerNextItemQueueProtocol;
  const MAX_DASHBOARD_REPORTS =
    streamReportProtocol?.MAX_ACTIVE_REPORTS ?? 5;
  const MAX_REPORT_DISPLAY_NAME_LENGTH =
    streamReportProtocol?.MAX_REPORT_DISPLAY_NAME_LENGTH ?? 80;
  const streamReportClientModule =
    globalThis.TikTokLiveTrackerStreamReportClient;
  const liveBidClientModule =
    globalThis.TikTokLiveTrackerLiveBidClient;
  const nextItemQueueClientModule =
    globalThis.TikTokLiveTrackerNextItemQueueClient;
  const mappingWorkflow = globalThis.TikTokLiveTrackerMappingWorkflow;
  const liveAuctionViewModel =
    globalThis.TikTokLiveTrackerLiveAuctionViewModel;
  const variationSelectorViewModel =
    globalThis.TikTokLiveTrackerVariationSelectorViewModel;
  const variationSelectorLockModule =
    globalThis.TikTokLiveTrackerVariationSelectorLock;
  const persistentTaggerControllerModule =
    globalThis.TikTokLiveTrackerPersistentTaggerController;
  const appShell = document.querySelector(".app-shell");
  const appHeader = document.querySelector(".app-header");
  const captureHealthBadge = document.querySelector("#capture-health-badge");
  const captureHealthDescription = document.querySelector("#capture-health-description");
  const captureHealthView = globalThis.TikTokLiveTrackerCaptureHealthView;
  const captureHealthBadgeVisibilityController =
    captureHealthView.createCaptureHealthBadgeVisibilityController({ badge: captureHealthBadge });
  const captureHealthController = captureHealthView.createCaptureHealthViewController({
    runtime: chrome.runtime,
    protocol: globalThis.TikTokLiveTrackerCaptureHealth,
    onChange: (state) => {
      captureHealthView.renderBadge(captureHealthBadge, captureHealthDescription, state);
      captureHealthBadgeVisibilityController.update();
      setWorkspaceBusy(savedSnapshot?.busy === true);
    },
  });
  const appFooter = document.querySelector(".app-footer");
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
  const inventoryImportConfirmationStatus = document.querySelector(
    "#inventory-import-confirmation-status",
  );
  const inventoryImportConfirmationMessage = document.querySelector(
    "#inventory-import-confirmation-message",
  );
  const confirmedInventoryPreviewLoading = document.querySelector(
    "#confirmed-inventory-preview-loading",
  );
  const confirmedInventoryPreviewError = document.querySelector(
    "#confirmed-inventory-preview-error",
  );
  const confirmedInventoryPreviewErrorMessage = document.querySelector(
    "#confirmed-inventory-preview-error-message",
  );
  const confirmedInventoryPreview = document.querySelector(
    "#confirmed-inventory-preview",
  );
  const confirmedInventoryPreviewRowCount = document.querySelector(
    "#confirmed-inventory-preview-row-count",
  );
  const confirmedInventoryPreviewUnitCount = document.querySelector(
    "#confirmed-inventory-preview-unit-count",
  );
  const confirmedInventoryPreviewTotalCost = document.querySelector(
    "#confirmed-inventory-preview-total-cost",
  );
  const confirmedInventoryPreviewRows = document.querySelector(
    "#confirmed-inventory-preview-rows",
  );
  const streamSessionPanel = document.querySelector("#stream-session-panel");
  const streamSessionHeading = document.querySelector(
    ".stream-session-heading",
  );
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
  const endReportReadiness = document.querySelector(
    "#end-report-readiness",
  );
  const streamReportsPanel = document.querySelector(
    "#stream-reports-panel",
  );
  const streamReportsCount = document.querySelector(
    "#stream-reports-count",
  );
  const streamReportsList = document.querySelector(
    "#stream-reports-list",
  );
  const streamReportsError = document.querySelector(
    "#stream-reports-error",
  );
  const streamReportsErrorMessage = document.querySelector(
    "#stream-reports-error-message",
  );
  const retryStreamReportsButton = document.querySelector(
    "#retry-stream-reports",
  );
  const viewArchivedReportsButton = document.querySelector(
    "#view-archived-reports",
  );
  const streamReportsCapacityWarning = document.querySelector(
    "#stream-reports-capacity-warning",
  );
  const archivedReportsShortCount = document.querySelector(
    "#archived-reports-short-count",
  );
  const archivedReportsView = document.querySelector(
    "#archived-reports-view",
  );
  const backToBusinessRecordsButton = document.querySelector(
    "#back-to-business-records",
  );
  const archivedReportsCount = document.querySelector(
    "#archived-reports-count",
  );
  const toggleArchivedSelectionButton = document.querySelector(
    "#toggle-archived-selection",
  );
  const archivedSelectionToolbar = document.querySelector(
    "#archived-selection-toolbar",
  );
  const archivedSelectionSummary = document.querySelector(
    "#archived-selection-summary",
  );
  const selectAllArchivedReportsButton = document.querySelector(
    "#select-all-archived-reports",
  );
  const clearArchivedSelectionButton = document.querySelector(
    "#clear-archived-selection",
  );
  const downloadSelectedReportsButton = document.querySelector(
    "#download-selected-reports",
  );
  const reportDownloadStatusElements = [
    document.querySelector("#stream-report-download-status"),
    document.querySelector("#archived-report-download-status"),
  ];
  const restoreSelectedReportsButton = document.querySelector(
    "#restore-selected-reports",
  );
  const deleteSelectedReportsButton = document.querySelector(
    "#delete-selected-reports",
  );
  const archivedRestoreGuidance = document.querySelector(
    "#archived-restore-guidance",
  );
  const archivedReportsList = document.querySelector(
    "#archived-reports-list",
  );
  const archivedReportsEmpty = document.querySelector(
    "#archived-reports-empty",
  );
  const archivedReportsError = document.querySelector(
    "#archived-reports-error",
  );
  const archivedReportsErrorMessage = document.querySelector(
    "#archived-reports-error-message",
  );
  const retryArchivedReportsButton = document.querySelector(
    "#retry-archived-reports",
  );
  const archivedReportsFeedback = document.querySelector(
    "#archived-reports-feedback",
  );
  const reportActionConfirmation = document.querySelector(
    "#report-action-confirmation",
  );
  const reportActionConfirmationTitle = document.querySelector(
    "#report-action-confirmation-title",
  );
  const reportActionConfirmationMessage = document.querySelector(
    "#report-action-confirmation-message",
  );
  const cancelReportActionButton = document.querySelector(
    "#cancel-report-action",
  );
  const confirmReportActionButton = document.querySelector(
    "#confirm-report-action",
  );
  const reportRenameDialog = document.querySelector(
    "#report-rename-dialog",
  );
  const reportRenameForm = document.querySelector("#report-rename-form");
  const reportRenameInput = document.querySelector("#report-rename-input");
  const reportRenameError = document.querySelector("#report-rename-error");
  const cancelReportRenameButton = document.querySelector(
    "#cancel-report-rename",
  );
  const resetReportNameButton = document.querySelector(
    "#reset-report-name",
  );
  const saveReportNameButton = document.querySelector("#save-report-name");
  const trackerWorkspace = document.querySelector("#tracker-workspace");
  const variationContext = document.querySelector("#variation-context");
  const variationSelectShell = document.querySelector(
    ".variation-select-shell",
  );
  const variationSelector = document.querySelector("#variation-selector");
  const variationSelectorValue = document.querySelector(
    "#variation-selector-value",
  );
  const variationListbox = document.querySelector("#variation-listbox");
  const returnToCurrentButton = document.querySelector("#return-to-current");
  const liveAuctionPanel = document.querySelector("#live-auction");
  const liveAuctionTitle = document.querySelector("#live-auction-title");
  const liveBidValue = document.querySelector("#live-bid-value");
  const liveUnitCostValue = document.querySelector(
    "#live-unit-cost-value",
  );
  const liveGrossProfitValue = document.querySelector(
    "#live-gross-profit-value",
  );
  const liveRemainingInventoryValue = document.querySelector(
    "#live-remaining-inventory-value",
  );
  const searchInput = document.querySelector("#inventory-search");
  const clearSearchButton = document.querySelector("#clear-search");
  const inventoryGrid = document.querySelector("#inventory-grid");
  const inventoryListToggle = document.querySelector(
    "#inventory-list-toggle",
  );
  const inventoryListToggleLabel = inventoryListToggle.querySelector(
    '[data-field="inventory-list-toggle-label"]',
  );
  const inventorySizeListbox = document.querySelector(
    "#inventory-size-listbox",
  );
  const inventorySelectionNote = document.querySelector(
    "#inventory-selection-note",
  );
  const resultCount = document.querySelector("#result-count");
  const addActiveStreamSkusButton = document.querySelector(
    "#add-active-stream-skus",
  );
  const activeStreamInventoryUpdateForm = document.querySelector(
    "#active-stream-inventory-update-form",
  );
  const activeStreamInventorySheetReference = document.querySelector(
    "#active-stream-inventory-sheet-reference",
  );
  const activeStreamInventoryUpdateError = document.querySelector(
    "#active-stream-inventory-update-error",
  );
  const cancelActiveStreamInventoryUpdateButton = document.querySelector(
    "#cancel-active-stream-inventory-update",
  );
  const confirmActiveStreamInventoryUpdateButton = document.querySelector(
    "#confirm-active-stream-inventory-update",
  );
  const activeStreamInventoryUpdateFeedback = document.querySelector(
    "#active-stream-inventory-update-feedback",
  );
  const emptyState = document.querySelector("#empty-state");
  const emptyQuery = document.querySelector("#empty-query");
  const cardTemplate = document.querySelector("#inventory-card-template");
  const grossItemSalesValue = document.querySelector("#revenue-value");
  const averageOrderValue = document.querySelector("#aov-value");
  const totalGmvValue = document.querySelector("#total-gmv-value");
  const feesPaidValue = document.querySelector("#fees-paid-value");
  const gmvAfterFeesValue = document.querySelector(
    "#gmv-after-fees-value",
  );
  const completedSalesValue = document.querySelector(
    "#completed-sales-value",
  );
  const canceledOrdersValue = document.querySelector(
    "#canceled-orders-value",
  );
  const paymentFixingValue = document.querySelector(
    "#payment-fixing-value",
  );
  const grossProfitValue = document.querySelector("#gross-profit-value");
  const grossProfitWarning = document.querySelector(
    "#gross-profit-warning",
  );
  const mappedGrossMarginValue = document.querySelector(
    "#mapped-gross-margin-value",
  );
  const estimatedProfitAfterFeesValue = document.querySelector(
    "#estimated-profit-after-fees-value",
  );
  const estimatedProfitAfterFeesWarning = document.querySelector(
    "#estimated-profit-after-fees-warning",
  );
  const pendingMapping = document.querySelector("#pending-mapping");
  const pendingMappingTitle = document.querySelector("#pending-mapping-title");
  const mappedVariation = document.querySelector(
    '[data-field="mapped-variation"]',
  );
  const mappedItem = document.querySelector("#mapped-item");
  const soldPriceResult = document.querySelector('[data-field="sold-price"]');
  const unitCostResult = document.querySelector('[data-field="unit-cost"]');
  const grossProfitResult = document.querySelector(
    '[data-field="gross-profit"]',
  );
  const remainingInventoryResult = document.querySelector(
    '[data-field="remaining-inventory"]',
  );
  const stateWarning = document.querySelector("#state-warning");
  const mappingAnnouncement = document.querySelector("#mapping-announcement");
  const sessionFooterLabel = document.querySelector("#session-footer-label");

  if (
    !viewModel ||
    typeof viewModel.groupInventoryEntries !== "function" ||
    typeof viewModel.createInventoryGroupOrderController !==
      "function" ||
    typeof viewModel.filterInventoryGroups !== "function" ||
    typeof viewModel.getInventoryGroupStockDisplay !== "function" ||
    typeof viewModel.getPreferredInventoryGroupEntry !== "function" ||
    !tiktokFeeCalculator ||
    typeof tiktokFeeCalculator.calculateSixPercentGmvFees !== "function" ||
    typeof tiktokFeeCalculator.calculateEstimatedProfitAfterFees !==
      "function" ||
    !reconciliation ||
    !reconciliationProtocol ||
    !reconciliationClientModule ||
    !streamSessionProtocol ||
    !streamSessionClientModule ||
    !streamSessionControllerModule ||
    !inventoryImportProtocol ||
    !inventoryImportClientModule ||
    !inventoryImportControllerModule ||
    !streamReportProtocol ||
    !streamReportClientModule ||
    !liveBidProtocol ||
    !liveBidClientModule ||
    !nextItemQueueProtocol ||
    typeof nextItemQueueProtocol.isQueueChangedNotification !== "function" ||
    !nextItemQueueClientModule ||
    typeof nextItemQueueClientModule.createNextItemQueueClient !== "function" ||
    !liveAuctionViewModel ||
    typeof liveAuctionViewModel.createDisplay !== "function" ||
    !variationSelectorViewModel ||
    typeof variationSelectorViewModel.createOptionDisplay !== "function" ||
    !variationSelectorLockModule ||
    typeof variationSelectorLockModule.createVariationSelectorLock !==
      "function" ||
    !mappingWorkflow ||
    !persistentTaggerControllerModule ||
    typeof persistentTaggerControllerModule.ensureInventoryInitialized !==
      "function"
  ) {
    console.error("[TikTok Live Tracker] Tagger lifecycle failed to load.");
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
  const streamReportClient =
    streamReportClientModule.createStreamReportClient({
      runtime: chrome.runtime,
      protocol: streamReportProtocol,
    });
  const liveBidClient = liveBidClientModule.createLiveBidClient({
    runtime: chrome.runtime,
    protocol: liveBidProtocol,
  });
  const nextItemQueueClient =
    nextItemQueueClientModule.createNextItemQueueClient({
      runtime: chrome.runtime,
      protocol: nextItemQueueProtocol,
    });
  const variationSelectorLock =
    variationSelectorLockModule.createVariationSelectorLock({
      apply: renderVariationSelectorOptions,
    });
  const inventoryGroupOrderController =
    viewModel.createInventoryGroupOrderController({
      maxPinnedGroups: COLLAPSED_INVENTORY_ITEM_LIMIT,
    });
  let variationSelectorOpen = false;
  let activeVariationNumber = null;
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
  let liveAuctionSnapshot = { liveAuction: null };
  let liveBidRefreshGeneration = 0;
  let liveBidRefreshDirty = false;
  let liveBidRefreshScheduled = false;
  let liveBidRefreshInFlight = false;
  let queuedNextItemSku = null;
  let inventoryListExpanded = false;
  let inventorySizeMenuState = null;
  let deferredInventoryRender = null;
  let activeInventorySizeSku = null;
  let nextItemQueueRefreshGeneration = 0;
  let nextItemQueueMutationGeneration = 0;
  let nextItemQueueMutationBusy = false;
  let lastRenderedSavedVariations = new Map();
  let previousInventoryImportPhase = null;
  let focusInventoryImportAfterRetry = false;
  let confirmedInventoryPreviewContextBaselineId = null;
  let confirmedInventoryPreviewBaselineId = null;
  let confirmedInventoryPreviewRequestEpoch = 0;
  let confirmedInventoryPreviewRequestPending = false;
  let activeStreamInventoryUpdateOpen = false;
  let activeStreamInventoryUpdateBusy = false;
  let activeStreamInventoryUpdateFeedbackTimerId = null;
  let activeStreamInventoryUpdateFeedbackSequence = 0;
  let streamReportSummaries = [];
  let archivedReportSummaries = [];
  let reportLibraryCapacity = null;
  let streamReportsRefreshGeneration = 0;
  let streamReportsOpenLatestPending = false;
  let reportLibraryDisposed = false;
  let streamReportsLoading = false;
  let streamReportsLoadError = null;
  let archivedReportsLoadError = null;
  let archivedReportsViewOpen = false;
  let archivedSelectionMode = false;
  let selectedArchivedReportIds = new Set();
  let openReportActions = null;
  let reportMutationBusy = false;
  let reportDownloadBusy = false;
  let reportDownloadController = null;
  let pendingReportDeletion = null;
  let pendingReportDeletionArchived = true;
  let pendingReportDeletionReturnFocus = null;
  let pendingReportRename = null;
  let reportRenameBusy = false;

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

  function isLiveBidChangedNotification(message, sender) {
    return (
      hasExactKeys(message, ["channel", "version", "event"]) &&
      message.channel === liveBidProtocol.MESSAGE_CHANNEL &&
      message.version === liveBidProtocol.MESSAGE_VERSION &&
      hasExactKeys(message.event, ["type"]) &&
      message.event.type === "live_bid_changed" &&
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

  function getCurrentVariationMappedSku(view) {
    if (
      !view ||
      !Number.isSafeInteger(view.currentVariationNumber) ||
      view.currentVariationNumber < 1
    ) {
      return null;
    }

    if (
      view.selectedVariationNumber === view.currentVariationNumber &&
      typeof view.auction?.sku === "string" &&
      view.auction.sku.trim() !== ""
    ) {
      return view.auction.sku;
    }

    if (
      view.activeAuctionMapping?.variationNumber ===
        view.currentVariationNumber &&
      typeof view.activeAuctionMapping.sku === "string" &&
      view.activeAuctionMapping.sku.trim() !== ""
    ) {
      return view.activeAuctionMapping.sku;
    }

    const currentVariation = findVariationOption(
      view,
      view.currentVariationNumber,
    );

    if (
      currentVariation?.recorded === true &&
      typeof currentVariation.sku === "string" &&
      currentVariation.sku.trim() !== ""
    ) {
      return currentVariation.sku;
    }

    return null;
  }

  function isCurrentVariationMapped(view) {
    if (
      !view ||
      !Number.isSafeInteger(view.currentVariationNumber) ||
      view.currentVariationNumber < 1
    ) {
      return false;
    }

    if (getCurrentVariationMappedSku(view) !== null) {
      return true;
    }

    const currentVariation = findVariationOption(
      view,
      view.currentVariationNumber,
    );

    return (
      currentVariation?.recorded === true &&
      currentVariation.item !== null &&
      currentVariation.item !== undefined
    );
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

    if (priceConflict) {
      return `Payment price conflict for variation #${variation.variationNumber}. The first captured price, ${viewModel.formatUsdCents(priceConflict.retainedSoldPriceCents)}, was retained for review.`;
    }

    if (variation?.status === "canceled") {
      return `Variation #${variation.variationNumber} was canceled. Any inventory reservation was released. You can still select a reference item without changing inventory or metrics.`;
    }

    if (variation?.observedPaymentStatus === "payment_complete") {
      const reviewDetail = completedAfterUnpaid
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
    const button = document.activeElement?.closest?.(".inventory-card");

    return button && inventoryGrid.contains(button)
      ? button.dataset.sku ?? button.dataset.focusSku ?? null
      : null;
  }

  function armCaptureRefresh() {
    if (
      !captureRefreshDirty ||
      captureRefreshTimerId !== null ||
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

  function canRefreshLiveBid() {
    return (
      streamSnapshot.resumed &&
      streamSnapshot.activeSession !== null &&
      persistentController !== null &&
      mountedStreamId !== null
    );
  }

  function armLiveBidRefresh() {
    if (
      liveBidRefreshScheduled ||
      liveBidRefreshInFlight ||
      !liveBidRefreshDirty
    ) {
      return;
    }

    liveBidRefreshScheduled = true;
    Promise.resolve().then(async () => {
      liveBidRefreshScheduled = false;

      if (liveBidRefreshInFlight || !liveBidRefreshDirty) {
        return;
      }

      if (!canRefreshLiveBid()) {
        liveBidRefreshDirty = false;
        return;
      }

      liveBidRefreshDirty = false;
      liveBidRefreshInFlight = true;
      const requestGeneration = liveBidRefreshGeneration;
      const requestStreamId = mountedStreamId;

      try {
        const response = await liveBidClient.getLiveBid();

        if (
          requestGeneration === liveBidRefreshGeneration &&
          requestStreamId === mountedStreamId &&
          canRefreshLiveBid()
        ) {
          if (
            isRecord(response) &&
            hasExactKeys(response, ["liveAuction"])
          ) {
            liveAuctionSnapshot = response;
          }
          renderLiveAuction(getActiveView());
        }
      } catch (error) {
        if (
          requestGeneration === liveBidRefreshGeneration &&
          requestStreamId === mountedStreamId
        ) {
          renderLiveAuction(getActiveView());
        }
        console.error(
          "[TikTok Live Tracker] Live bid could not be refreshed.",
          error,
        );
      } finally {
        liveBidRefreshInFlight = false;
        armLiveBidRefresh();
      }
    });
  }

  function scheduleLiveBidRefresh() {
    liveBidRefreshGeneration += 1;
    liveBidRefreshDirty = true;
    armLiveBidRefresh();
  }

  function resetLiveBidTracking() {
    liveBidRefreshGeneration += 1;
    liveBidRefreshDirty = false;
    liveAuctionSnapshot = { liveAuction: null };
    renderLiveAuction(null);
  }

  function resetNextItemQueueDisplay() {
    nextItemQueueRefreshGeneration += 1;
    nextItemQueueMutationGeneration += 1;
    nextItemQueueMutationBusy = false;
    queuedNextItemSku = null;
  }

  function scheduleNextItemQueueRefresh() {
    if (
      !streamSnapshot.resumed ||
      streamSnapshot.activeSession === null ||
      persistentController === null ||
      mountedStreamId === null
    ) {
      return;
    }

    const requestGeneration = ++nextItemQueueRefreshGeneration;
    const requestStreamId = mountedStreamId;

    Promise.resolve()
      .then(() => nextItemQueueClient.getQueue())
      .then((response) => {
        if (
          requestGeneration !== nextItemQueueRefreshGeneration ||
          requestStreamId !== mountedStreamId
        ) {
          return;
        }

        queuedNextItemSku = response.queuedSku;
        const view = getActiveView();

        if (view) {
          renderInventory(view, getFocusedInventorySku());
        }
      })
      .catch((error) => {
        if (
          requestGeneration === nextItemQueueRefreshGeneration &&
          requestStreamId === mountedStreamId
        ) {
          console.error(
            "[TikTok Live Tracker] The next-item queue could not be refreshed.",
            error,
          );
        }
      });
  }

  function handleCaptureStateChanged(message, sender) {
    if (
      nextItemQueueProtocol.isQueueChangedNotification(message) &&
      sender?.id === chrome.runtime.id &&
      sender.tab === undefined
    ) {
      scheduleNextItemQueueRefresh();
      return false;
    }

    if (isLiveBidChangedNotification(message, sender)) {
      scheduleLiveBidRefresh();
      return false;
    }

    if (!isCaptureStateChangedNotification(message, sender)) {
      return false;
    }

    scheduleCaptureRefresh();
    return false;
  }

  function getActiveView() {
    return savedSnapshot?.view ?? null;
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

  function setTrackerWorkspaceVisible(visible) {
    trackerWorkspace.hidden = !visible;
    syncCaptureInteractionLock();
    updateFooterVisibility();
  }

  function updateFooterVisibility() {
    if (appFooter) {
      const redundantRestoredStatus =
        streamSnapshot.activeSession !== null &&
        streamSnapshot.resumed === true &&
        appFooter.dataset.phase === "ready" &&
        sessionFooterLabel.textContent === "Live session data restored";
      appFooter.hidden =
        archivedReportsViewOpen ||
        (trackerWorkspace.hidden && streamReportsPanel.hidden) ||
        redundantRestoredStatus;
    }
  }

  function reorderAppSections(sections) {
    if (!appShell) {
      return;
    }

    const orderedSections = sections.filter(
      (section) => section && section !== mappingAnnouncement,
    );
    const currentOrder = Array.from(appShell.children).filter((child) =>
      orderedSections.includes(child),
    );
    const orderAlreadyMatches =
      currentOrder.length === orderedSections.length &&
      orderedSections.every((section, index) => currentOrder[index] === section);

    if (orderAlreadyMatches) {
      return;
    }

    orderedSections.forEach((section) => {
      appShell.insertBefore(section, mappingAnnouncement ?? null);
    });
  }

  function updateLayoutOrder(snapshot = streamSnapshot) {
    const activeAndResumed =
      snapshot.activeSession !== null && snapshot.resumed === true;
    appHeader.hidden = activeAndResumed;
    const streamFailed = snapshot.phase === "error";

    if (activeAndResumed) {
      reorderAppSections(
        streamFailed
          ? [
              inventoryImportPanel,
              savedSessionError,
              streamSessionPanel,
              trackerWorkspace,
              streamReportsPanel,
              appFooter,
            ]
          : [
              inventoryImportPanel,
              savedSessionError,
              trackerWorkspace,
              streamSessionPanel,
              streamReportsPanel,
              appFooter,
            ],
      );
      return;
    }

    reorderAppSections([
      inventoryImportPanel,
      streamSessionPanel,
      savedSessionError,
      trackerWorkspace,
      streamReportsPanel,
      appFooter,
    ]);
  }

  function unmountPersistentController() {
    clearCaptureRefreshTimer();
    resetLiveBidTracking();
    resetNextItemQueueDisplay();
    resetInventorySizeMenu();
    resetVariationSelector();
    inventoryGroupOrderController.reset();
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
    activeStreamInventoryUpdateOpen = false;
    activeStreamInventorySheetReference.value = "";
    clearActiveStreamInventoryUpdateError();
    clearActiveStreamInventoryUpdateFeedback();
    savedSessionError.hidden = true;
    setTrackerWorkspaceVisible(false);
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
        currentVariationNumber: FALLBACK_CURRENT_VARIATION_NUMBER,
        variationNumbers: FALLBACK_VARIATION_NUMBERS,
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
    scheduleLiveBidRefresh();
    scheduleNextItemQueueRefresh();
  }

  function isCaptureInteractionLocked() {
    const phase = captureHealthBadge.dataset.phase;
    return (
      streamSnapshot.activeSession !== null &&
      streamSnapshot.resumed === true &&
      !trackerWorkspace.hidden &&
      !archivedReportsViewOpen &&
      (phase === "connecting" || phase === "loading")
    );
  }

  function isTrackerInteractionTarget(target) {
    return Boolean(target) && [
      trackerWorkspace,
      variationListbox,
      inventorySizeListbox,
      retrySavedSessionButton,
      retryStreamSessionButton,
    ].some((element) => element.contains(target));
  }

  function guardCaptureInteraction(event) {
    if (!isCaptureInteractionLocked()) {
      return false;
    }

    // Let native scrolling, focus traversal and browser shortcuts keep working.
    // Inert content and the editing-event guards prevent those defaults from
    // editing a locked field. Never intercept wheel, touchmove or scroll events.
    const nativeKeyboardAction =
      (event?.type === "keydown" || event?.type === "keyup") &&
      (event.ctrlKey || event.metaKey || event.altKey || [
        "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "PageUp", "PageDown", " ", "Spacebar",
      ].includes(event.key));
    const nativePointerAction = [
      "pointerdown", "pointerup", "mousedown", "mouseup",
    ].includes(event?.type);
    if (!nativeKeyboardAction && !nativePointerAction) {
      event?.preventDefault?.();
    }
    event?.stopImmediatePropagation?.();
    return true;
  }

  function syncCaptureInteractionLock() {
    const locked = isCaptureInteractionLocked();
    // Blur before flushing a picker's deferred render, so rendering cannot
    // restore focus to a newly locked card and move the scroll position.
    if (locked && isTrackerInteractionTarget(document.activeElement)) {
      document.activeElement.blur();
    }

    // Keep capture-only inert separate from the existing workspace safeguards.
    // The badge remains accessible, and green/red never clear legacy root inert
    // or disabled attributes. Explicit popover targets cover top-layer menus.
    for (const child of trackerWorkspace.children) {
      if (!child.classList.contains("capture-health-row")) {
        child.toggleAttribute("inert", locked);
      }
    }
    for (const element of [
      variationListbox, inventorySizeListbox,
      retrySavedSessionButton, retryStreamSessionButton,
    ]) {
      element.toggleAttribute("inert", locked);
    }

    if (locked && variationSelectorOpen) {
      releaseVariationSelector({ restoreFocus: false });
    }
    if (locked && inventorySizeMenuState !== null) {
      releaseInventorySizeMenu({ restoreFocus: false });
    }
  }

  function setWorkspaceBusy(busy) {
    const streamUnavailable =
      !streamSnapshot.resumed || streamSnapshot.activeSession === null;
    const activeInventoryUpdateRefresh =
      activeStreamInventoryUpdateBusy &&
      snapshotIsBackgroundRefresh(savedSnapshot);
    const shouldBeBusy =
      (Boolean(busy) && !activeInventoryUpdateRefresh) ||
      streamSnapshot.busy ||
      streamUnavailable;
    const keepOpenPickerInteractive =
      (variationSelectorLock.isLocked() || inventorySizeMenuState !== null) &&
      snapshotIsBackgroundRefresh(savedSnapshot) &&
      !streamSnapshot.busy &&
      !streamUnavailable &&
      !endConfirmationOpen;
    const shouldBeInert =
      (shouldBeBusy && !keepOpenPickerInteractive) ||
      savedSnapshot?.phase === "error" ||
      endConfirmationOpen;

    trackerWorkspace.setAttribute("aria-busy", String(shouldBeBusy));
    trackerWorkspace.toggleAttribute("inert", shouldBeInert);
    syncCaptureInteractionLock();
  }

  function snapshotIsBackgroundRefresh(snapshot) {
    return (
      snapshot?.phase === "loading" && snapshot.operation === "refresh"
    );
  }

  function hideVariationListbox() {
    try {
      if (
        typeof variationListbox.hidePopover === "function" &&
        variationListbox.matches(":popover-open")
      ) {
        variationListbox.hidePopover();
      }
    } catch (error) {
      console.error(
        "[TikTok Live Tracker] Variation listbox could not be hidden.",
        error,
      );
    }

    variationListbox.hidden = true;
    variationListbox.removeAttribute("data-fallback-open");
  }

  function clearOpenVariationSelector() {
    restoreCurrentVariationHighlight();
    variationSelectorOpen = false;
    activeVariationNumber = null;
    variationSelectShell.dataset.open = "false";
    variationSelector.setAttribute("aria-expanded", "false");
    variationSelector.removeAttribute("aria-activedescendant");
    hideVariationListbox();
  }

  function resetVariationSelector() {
    clearOpenVariationSelector();
    variationSelectorLock.reset();
  }

  function releaseVariationSelector(options = {}) {
    const { restoreFocus = false } = options;

    clearOpenVariationSelector();
    variationSelectorLock.release();
    setWorkspaceBusy(savedSnapshot?.busy === true);

    if (restoreFocus && variationSelector.tabIndex >= 0) {
      variationSelector.focus();
    }
  }

  function isSavedWorkspaceUnavailable() {
    return (
      persistentController === null || savedSnapshot?.phase !== "ready"
    );
  }

  function clearActiveStreamInventoryUpdateError() {
    activeStreamInventorySheetReference.removeAttribute("aria-invalid");
    activeStreamInventoryUpdateError.hidden = true;
    activeStreamInventoryUpdateError.textContent = "";
  }

  function clearActiveStreamInventoryUpdateFeedback() {
    activeStreamInventoryUpdateFeedbackSequence += 1;

    if (activeStreamInventoryUpdateFeedbackTimerId !== null) {
      window.clearTimeout(activeStreamInventoryUpdateFeedbackTimerId);
      activeStreamInventoryUpdateFeedbackTimerId = null;
    }

    activeStreamInventoryUpdateFeedback.hidden = true;
    activeStreamInventoryUpdateFeedback.textContent = "";
  }

  function showActiveStreamInventoryUpdateFeedback(message) {
    clearActiveStreamInventoryUpdateFeedback();
    const sequence = activeStreamInventoryUpdateFeedbackSequence;

    activeStreamInventoryUpdateFeedback.textContent = message;
    activeStreamInventoryUpdateFeedback.hidden = false;
    activeStreamInventoryUpdateFeedbackTimerId = window.setTimeout(() => {
      if (sequence !== activeStreamInventoryUpdateFeedbackSequence) {
        return;
      }

      activeStreamInventoryUpdateFeedbackTimerId = null;
      activeStreamInventoryUpdateFeedback.hidden = true;
      activeStreamInventoryUpdateFeedback.textContent = "";
    }, ACTIVE_STREAM_INVENTORY_FEEDBACK_DURATION_MS);
  }

  function setActiveStreamInventoryUpdateError(message, options = {}) {
    activeStreamInventorySheetReference.toggleAttribute(
      "aria-invalid",
      options.markReference === true,
    );
    const renderedMessage = options.outcomeUncertain === true
      ? `The inventory update could not be confirmed. ${message} Refresh or retry; retrying is safe.`
      : `No SKUs were added. ${message}`;

    activeStreamInventoryUpdateError.textContent = renderedMessage;
    activeStreamInventoryUpdateError.hidden = false;
    return renderedMessage;
  }

  function renderActiveStreamInventoryUpdateControls() {
    const available =
      streamSnapshot.activeSession !== null &&
      streamSnapshot.resumed === true &&
      persistentController !== null &&
      savedSnapshot?.view !== null;

    if (!available) {
      activeStreamInventoryUpdateOpen = false;
    }

    addActiveStreamSkusButton.hidden = !available;
    addActiveStreamSkusButton.disabled =
      activeStreamInventoryUpdateBusy || !available;
    addActiveStreamSkusButton.setAttribute(
      "aria-expanded",
      String(activeStreamInventoryUpdateOpen && available),
    );
    activeStreamInventoryUpdateForm.hidden =
      !activeStreamInventoryUpdateOpen || !available;
    activeStreamInventoryUpdateForm.setAttribute(
      "aria-busy",
      String(activeStreamInventoryUpdateBusy),
    );
    activeStreamInventorySheetReference.disabled =
      activeStreamInventoryUpdateBusy;
    cancelActiveStreamInventoryUpdateButton.disabled =
      activeStreamInventoryUpdateBusy;
    confirmActiveStreamInventoryUpdateButton.disabled =
      activeStreamInventoryUpdateBusy;
    confirmActiveStreamInventoryUpdateButton.textContent =
      activeStreamInventoryUpdateBusy ? "Checking Sheet..." : "Check and add";
  }

  function closeActiveStreamInventoryUpdate(options = {}) {
    const { clearReference = false, restoreFocus = false } = options;

    activeStreamInventoryUpdateOpen = false;
    clearActiveStreamInventoryUpdateError();

    if (clearReference) {
      activeStreamInventorySheetReference.value = "";
    }

    renderActiveStreamInventoryUpdateControls();

    if (
      restoreFocus &&
      !addActiveStreamSkusButton.hidden &&
      !addActiveStreamSkusButton.disabled
    ) {
      addActiveStreamSkusButton.focus();
    }
  }

  function updateSessionControls() {
    inventoryImportPanel.hidden =
      streamSnapshot.activeSession !== null ||
      shouldPrepareInventoryForStreamRetry(streamSnapshot);
    const footerText = !streamSnapshot.activeSession
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
    const footerPhase = !streamSnapshot.activeSession
      ? "inactive"
      : !streamSnapshot.resumed
        ? "resume"
        : savedSnapshot?.phase ?? "idle";

    setFooterStatus(footerText, footerPhase);
    renderActiveStreamInventoryUpdateControls();
    renderStreamReportsPanel();
  }

  function setFooterStatus(text, phase) {
    if (sessionFooterLabel.textContent !== text) {
      sessionFooterLabel.textContent = text;
    }

    appFooter.dataset.phase = phase;
    updateFooterVisibility();
  }

  function formatReportTimestamp(value) {
    const parsed = typeof value === "string" ? new Date(value) : null;

    if (!parsed || Number.isNaN(parsed.getTime())) {
      return "Saved stream";
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(parsed);
  }

  function describeReportReadiness(view = savedSnapshot?.view) {
    const totals = view?.totals;

    if (!totals) {
      return "The saved stream will be checked when the report is created.";
    }

    const variations = Array.isArray(view?.variations)
      ? view.variations
      : [];
    const unresolvedOrderCount = variations.filter(
      (variation) =>
        variation.recorded === true &&
        !["committed", "unmapped_completed", "canceled"].includes(
          variation.status,
        ),
    ).length;
    const recountSkuCount = (Array.isArray(view?.inventory)
      ? view.inventory
      : []
    ).filter(
      (entry) =>
        Number.isSafeInteger(entry.oversoldQuantity) &&
        entry.oversoldQuantity > 0,
    ).length;
    const issues = [
      [
        Number.isSafeInteger(view?.activeBiddingVariationNumber) ? 1 : 0,
        "active bidding variation",
        "active bidding variations",
      ],
      [unresolvedOrderCount, "unresolved order", "unresolved orders"],
      [totals.pendingMappedCount, "pending mapped order", "pending mapped orders"],
      [totals.paymentFixingCount, "payment-error order", "payment-error orders"],
      [totals.unmappedCompletedCount, "completed sale without inventory", "completed sales without inventory"],
      [totals.conflictCount, "data conflict", "data conflicts"],
      [recountSkuCount, "SKU requiring a recount", "SKUs requiring a recount"],
    ]
      .filter(([count]) => Number.isSafeInteger(count) && count > 0)
      .map(([count, singular, plural]) =>
        `${count} ${count === 1 ? singular : plural}`,
      );

    return issues.length === 0
      ? "No captured issues currently require attention."
      : `Report attention items: ${issues.join(", ")}.`;
  }

  function openStreamReport(reportId) {
    const reportUrl = chrome.runtime.getURL(
      `report/report.html?reportId=${encodeURIComponent(reportId)}`,
    );

    if (chrome.tabs && typeof chrome.tabs.create === "function") {
      return chrome.tabs.create({ url: reportUrl });
    }

    const opened = globalThis.open(reportUrl, "_blank", "noopener");

    if (!opened) {
      throw new Error("Chrome blocked the stream report tab.");
    }

    return Promise.resolve(opened);
  }

  function getAvailableDashboardReportSlots() {
    return Math.max(
      0,
      MAX_DASHBOARD_REPORTS - streamReportSummaries.length,
    );
  }

  function closeReportActionsMenu(options = {}) {
    if (!openReportActions) {
      return;
    }

    const { button, menu } = openReportActions;

    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    openReportActions = null;

    if (options.restoreFocus === true && button.isConnected) {
      button.focus();
    }
  }

  function getReportMenuItems(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
      (item) => !item.disabled && !item.hidden,
    );
  }

  function openReportActionsMenu(button, menu, focusPosition = null) {
    if (openReportActions?.menu !== menu) {
      closeReportActionsMenu();
    }

    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openReportActions = { button, menu };

    if (focusPosition !== null) {
      const items = getReportMenuItems(menu);
      const index = focusPosition === "last" ? items.length - 1 : 0;

      items[index]?.focus();
    }
  }

  function handleReportMenuKeydown(event, button, menu) {
    const items = getReportMenuItems(menu);
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = null;

    if (event.key === "Escape") {
      event.preventDefault();
      closeReportActionsMenu({ restoreFocus: true });
      return;
    }

    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0
        ? items.length - 1
        : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Tab") {
      closeReportActionsMenu();
      return;
    }

    if (nextIndex !== null && items.length > 0) {
      event.preventDefault();
      items[nextIndex].focus();
    }
  }

  function createReportMenuAction(label, action, onActivate) {
    const button = document.createElement("button");

    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.reportAction = action;
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeReportActionsMenu();
      onActivate();
    });
    return button;
  }

  function setReportInteractionError(error, archived) {
    const message =
      error?.message ?? "The saved report could not be changed. Nothing was changed.";

    if (archived) {
      archivedReportsLoadError = message;
    } else {
      streamReportsLoadError = message;
    }

    renderStreamReportsPanel();
    (archived ? archivedReportsError : streamReportsError).focus();
  }

  function getReportDisplayName(summary) {
    return typeof summary?.displayName === "string" &&
      summary.displayName.trim() !== ""
      ? summary.displayName
      : formatReportTimestamp(summary?.startedAt);
  }

  function setReportRenameError(message = null) {
    const hasError = typeof message === "string" && message !== "";

    reportRenameError.hidden = !hasError;
    reportRenameError.textContent = hasError ? message : "";
    reportRenameInput.setAttribute("aria-invalid", String(hasError));
  }

  function setReportRenameBusy(busy) {
    reportRenameBusy = busy;
    reportRenameForm.setAttribute("aria-busy", String(busy));
    reportRenameInput.disabled = busy;
    cancelReportRenameButton.disabled = busy;
    resetReportNameButton.disabled = busy;
    saveReportNameButton.disabled = busy;
  }

  function findReportMoreButton(reportId) {
    return Array.from(document.querySelectorAll(".report-more-button")).find(
      (button) => button.dataset.reportId === reportId,
    ) ?? null;
  }

  function requestReportRename(summary, returnFocusTarget) {
    if (reportRenameBusy || reportMutationBusy || reportDownloadBusy) {
      return;
    }

    const defaultName = formatReportTimestamp(summary.startedAt);
    const customName = typeof summary.displayName === "string"
      ? summary.displayName
      : null;

    pendingReportRename = {
      reportId: summary.reportId,
      defaultName,
      customName,
      returnFocusTarget,
    };
    reportRenameInput.value = customName ?? defaultName;
    resetReportNameButton.hidden = customName === null;
    setReportRenameError();
    setReportRenameBusy(false);
    reportRenameDialog.showModal();
    reportRenameInput.focus();
    reportRenameInput.select();
  }

  async function savePendingReportName(displayName) {
    const pending = pendingReportRename;

    if (!pending || reportRenameBusy) {
      return;
    }

    setReportRenameError();
    setReportRenameBusy(true);

    try {
      await streamReportClient.renameReport({
        reportId: pending.reportId,
        displayName,
      });
      streamReportSummaries = streamReportSummaries.map((summary) =>
        summary.reportId === pending.reportId
          ? { ...summary, displayName }
          : summary,
      );
      await refreshStreamReports();
      pending.returnFocusTarget =
        findReportMoreButton(pending.reportId) ?? pending.returnFocusTarget;
      setReportRenameBusy(false);
      announceReportMutation(
        displayName === null
          ? "The report is using its default name."
          : `Report renamed to ${displayName}.`,
        false,
      );
      reportRenameDialog.close("saved");
    } catch (error) {
      setReportRenameBusy(false);
      setReportRenameError(
        error?.message ?? "The report name could not be saved. Nothing was changed.",
      );
      reportRenameInput.focus();
    }
  }

  function createStreamReportLink(summary, options = {}) {
    const archived = options.archived === true;
    const selectionEnabled = archived && archivedSelectionMode;
    const wrapper = document.createElement("div");
    const button = document.createElement("button");
    const title = document.createElement("span");
    const meta = document.createElement("span");
    const moreButton = document.createElement("button");
    const moreGlyph = document.createElement("span");
    const menu = document.createElement("div");
    const completedCount = Number.isSafeInteger(summary.completedPaymentCount)
      ? summary.completedPaymentCount
      : 0;
    const totalCount = Number.isSafeInteger(summary.totalSalesCount)
      ? summary.totalSalesCount
      : 0;
    const reportDisplayName = getReportDisplayName(summary);
    const menuId = `report-actions-${archived ? "archived" : "dashboard"}-${summary.reportId.replace(/[^a-z0-9_-]/gi, "-")}`;

    wrapper.className = "stream-report-row";
    wrapper.dataset.selectionMode = String(selectionEnabled);
    wrapper.setAttribute("role", "listitem");

    if (selectionEnabled) {
      const checkboxLabel = document.createElement("label");
      const checkbox = document.createElement("input");
      const checkboxMark = document.createElement("span");

      checkboxLabel.className = "archive-report-checkbox-label";
      checkbox.className = "archive-report-checkbox";
      checkbox.type = "checkbox";
      checkbox.value = summary.reportId;
      checkbox.checked = selectedArchivedReportIds.has(summary.reportId);
      checkbox.disabled = reportMutationBusy;
      checkbox.setAttribute(
        "aria-label",
        `Select ${reportDisplayName}`,
      );
      checkboxMark.className = "archive-report-checkbox-mark";
      checkboxMark.setAttribute("aria-hidden", "true");
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedArchivedReportIds.add(summary.reportId);
        } else {
          selectedArchivedReportIds.delete(summary.reportId);
        }

        renderArchivedSelectionControls();
      });
      checkboxLabel.append(checkbox, checkboxMark);
      wrapper.append(checkboxLabel);
    }

    button.type = "button";
    button.className = "stream-report-link";
    button.dataset.reportId = summary.reportId;
    button.setAttribute(
      "aria-label",
      `Open ${reportDisplayName}`,
    );

    title.className = "stream-report-link-title";
    title.textContent = reportDisplayName;
    meta.className = "stream-report-link-meta";
    meta.textContent =
      `${completedCount}/${totalCount} completed - ` +
      viewModel.formatUsdCents(summary.completedGmvCents ?? 0);
    button.append(title, meta);
    button.addEventListener("click", () => {
      Promise.resolve(openStreamReport(summary.reportId)).catch((error) => {
        setReportInteractionError(error, archived);
      });
    });

    moreButton.type = "button";
    moreButton.className = "report-more-button";
    moreButton.dataset.reportId = summary.reportId;
    moreButton.disabled = reportMutationBusy || reportDownloadBusy;
    moreButton.setAttribute("aria-haspopup", "menu");
    moreButton.setAttribute("aria-expanded", "false");
    moreButton.setAttribute("aria-controls", menuId);
    moreButton.setAttribute(
      "aria-label",
      `More actions for ${reportDisplayName}`,
    );
    moreGlyph.className = "report-more-glyph";
    moreGlyph.setAttribute("aria-hidden", "true");
    moreGlyph.textContent = "\u2026";
    moreButton.append(moreGlyph);

    menu.id = menuId;
    menu.className = "report-actions-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Actions for ${reportDisplayName}`);
    menu.hidden = true;

    menu.append(
      createReportMenuAction("Download PDF", "download-pdf", () => {
        void runReportDownload([summary.reportId]);
      }),
    );

    if (!archived) {
      menu.append(
        createReportMenuAction("Rename", "rename", () => {
          requestReportRename(summary, moreButton);
        }),
        createReportMenuAction("Archive", "archive", () => {
          void runReportMutation("archive", [summary.reportId]);
        }),
        createReportMenuAction("Delete", "delete", () => {
          requestPermanentReportDeletion([summary.reportId], moreButton, {
            archived: false,
          });
        }),
      );
    } else {
      if (getAvailableDashboardReportSlots() > 0) {
        menu.append(
          createReportMenuAction("Restore", "restore", () => {
            void runReportMutation("restore", [summary.reportId]);
          }),
        );
      }

      menu.append(
        createReportMenuAction("Delete forever", "delete", () => {
          requestPermanentReportDeletion([summary.reportId], moreButton);
        }),
      );
    }

    moreButton.addEventListener("click", (event) => {
      event.stopPropagation();

      if (menu.hidden) {
        openReportActionsMenu(moreButton, menu);
      } else {
        closeReportActionsMenu({ restoreFocus: true });
      }
    });
    moreButton.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openReportActionsMenu(
          moreButton,
          menu,
          event.key === "ArrowUp" ? "last" : "first",
        );
      }
    });
    menu.addEventListener("keydown", (event) => {
      handleReportMenuKeydown(event, moreButton, menu);
    });
    menu.addEventListener("click", (event) => event.stopPropagation());

    wrapper.append(button, moreButton, menu);
    return wrapper;
  }

  function renderArchivedSelectionControls() {
    const selectedCount = selectedArchivedReportIds.size;
    const availableSlots = getAvailableDashboardReportSlots();
    const allSelected =
      archivedReportSummaries.length > 0 &&
      selectedCount === archivedReportSummaries.length;

    archivedSelectionToolbar.hidden = !archivedSelectionMode;
    toggleArchivedSelectionButton.setAttribute(
      "aria-pressed",
      String(archivedSelectionMode),
    );
    toggleArchivedSelectionButton.textContent = archivedSelectionMode
      ? "Done"
      : "Select";
    archivedSelectionSummary.textContent =
      `${selectedCount} selected - ${availableSlots} ${availableSlots === 1 ? "slot" : "slots"} available`;
    selectAllArchivedReportsButton.disabled =
      reportMutationBusy || archivedReportSummaries.length === 0 || allSelected;
    clearArchivedSelectionButton.disabled =
      reportMutationBusy || selectedCount === 0;
    restoreSelectedReportsButton.hidden = availableSlots === 0;
    restoreSelectedReportsButton.disabled =
      reportMutationBusy ||
      reportDownloadBusy ||
      selectedCount === 0 ||
      selectedCount > availableSlots;
    deleteSelectedReportsButton.disabled =
      reportMutationBusy || reportDownloadBusy || selectedCount === 0;
    downloadSelectedReportsButton.disabled =
      reportMutationBusy || reportDownloadBusy || streamReportsLoading ||
      selectedCount === 0;

    if (availableSlots === 0) {
      archivedRestoreGuidance.textContent =
        "Dashboard full: 5 of 5 reports. Archive a dashboard report before restoring.";
    } else if (selectedCount > availableSlots) {
      archivedRestoreGuidance.textContent =
        `Only ${availableSlots} ${availableSlots === 1 ? "dashboard slot is" : "dashboard slots are"} available. Clear part of the selection before restoring.`;
    } else {
      archivedRestoreGuidance.textContent =
        `${availableSlots} of 5 dashboard ${availableSlots === 1 ? "slot is" : "slots are"} available.`;
    }
  }

  function syncArchivedReportCheckboxes() {
    archivedReportsList
      .querySelectorAll(".archive-report-checkbox")
      .forEach((checkbox) => {
        checkbox.checked = selectedArchivedReportIds.has(checkbox.value);
      });
  }

  function renderArchivedReportsView() {
    const inactive = streamSnapshot.activeSession === null;
    const hasError = typeof archivedReportsLoadError === "string";
    const archivedIds = new Set(
      archivedReportSummaries.map((summary) => summary.reportId),
    );

    if (!inactive) {
      archivedReportsViewOpen = false;
    }

    selectedArchivedReportIds = new Set(
      [...selectedArchivedReportIds].filter((reportId) =>
        archivedIds.has(reportId),
      ),
    );
    if (archivedReportSummaries.length === 0) {
      archivedSelectionMode = false;
      selectedArchivedReportIds.clear();
    }

    closeReportActionsMenu();
    archivedReportsView.hidden = !archivedReportsViewOpen;
    archivedReportsView.setAttribute(
      "aria-busy",
      String(streamReportsLoading || reportMutationBusy),
    );
    appShell.classList.toggle(
      "archived-reports-open",
      archivedReportsViewOpen,
    );
    archivedReportsCount.textContent =
      `${archivedReportSummaries.length} archived`;
    toggleArchivedSelectionButton.hidden =
      archivedReportSummaries.length === 0;
    toggleArchivedSelectionButton.disabled =
      streamReportsLoading || reportMutationBusy;
    archivedReportsList.replaceChildren(
      ...archivedReportSummaries.map((summary) =>
        createStreamReportLink(summary, { archived: true }),
      ),
    );
    archivedReportsEmpty.hidden =
      streamReportsLoading || archivedReportSummaries.length > 0 || hasError;
    archivedReportsError.hidden = !hasError;
    archivedReportsErrorMessage.textContent = hasError
      ? archivedReportsLoadError
      : "Archived reports could not be loaded. Nothing was changed.";
    renderArchivedSelectionControls();
  }

  function renderReportCapacityWarning() {
    const hidden =
      streamSnapshot.activeSession !== null ||
      streamReportsLoading ||
      reportMutationBusy ||
      typeof streamReportsLoadError === "string" ||
      typeof archivedReportsLoadError === "string" ||
      reportLibraryCapacity === null;

    let message = "";
    let tone = "danger";
    if (!hidden) {
      const { usedBytes, maxBytes, totalReports, maxReports } = reportLibraryCapacity;
      const remainingSlots = Math.max(0, maxReports - totalReports);
      const usage = usedBytes / maxBytes;
      // Thresholds use the unrounded ratio; floor only the displayed percentage.
      const percent = Math.floor(usage * 100);
      const slotWarning = remainingSlots <= 3;
      const sizeWarning = usage >= 0.8;
      const slots = `${remainingSlots} report ${remainingSlots === 1 ? "slot" : "slots"} left`;

      if (remainingSlots === 0 || usedBytes >= maxBytes) {
        message = "Report library full — delete an archived report";
      } else if (slotWarning && sizeWarning) {
        message = `${slots} · Storage ${percent}% full`;
      } else if (sizeWarning) {
        tone = usage >= 0.9 ? "danger" : "warning";
        message = usage >= 0.9
          ? `Report storage nearly full — ${percent}% used`
          : `Report storage getting full — ${percent}% used`;
      } else if (slotWarning) {
        message = slots;
      }
    }

    streamReportsCapacityWarning.hidden = message === "";
    streamReportsCapacityWarning.dataset.tone = tone;
    streamReportsCapacityWarning.textContent = message;
  }

  function renderStreamReportsPanel() {
    const inactive = streamSnapshot.activeSession === null;
    const hasReports = streamReportSummaries.length > 0;
    const hasArchivedReports = archivedReportSummaries.length > 0;
    const hasError = typeof streamReportsLoadError === "string";

    closeReportActionsMenu();
    streamReportsPanel.hidden =
      !inactive ||
      (!hasReports && !hasArchivedReports && !hasError);
    streamReportsPanel.setAttribute(
      "aria-busy",
      String(streamReportsLoading || reportMutationBusy),
    );
    streamReportsCount.textContent =
      `${streamReportSummaries.length}/${MAX_DASHBOARD_REPORTS} saved`;
    archivedReportsShortCount.textContent =
      `${archivedReportSummaries.length} archived`;
    renderReportCapacityWarning();
    viewArchivedReportsButton.disabled =
      streamReportsLoading || reportMutationBusy;
    streamReportsList.replaceChildren(
      ...streamReportSummaries.map((summary) =>
        createStreamReportLink(summary, { archived: false }),
      ),
    );
    streamReportsError.hidden = !hasError;
    streamReportsErrorMessage.textContent = hasError
      ? streamReportsLoadError
      : "Saved reports could not be loaded. Nothing was changed.";
    renderArchivedReportsView();
    updateFooterVisibility();
  }

  function openArchivedReportsDashboard() {
    if (streamSnapshot.activeSession !== null) {
      return;
    }

    archivedReportsViewOpen = true;
    renderStreamReportsPanel();
    archivedReportsView.scrollIntoView({ block: "start" });
    backToBusinessRecordsButton.focus();
  }

  function closeArchivedReportsDashboard() {
    archivedReportsViewOpen = false;
    archivedSelectionMode = false;
    selectedArchivedReportIds.clear();
    renderStreamReportsPanel();

    if (streamReportsPanel.hidden) {
      streamSessionStatus.focus();
    } else {
      streamReportsPanel.scrollIntoView({ block: "start" });
      viewArchivedReportsButton.focus();
    }
  }

  function announceReportMutation(message, archived) {
    if (archived) {
      archivedReportsFeedback.textContent = "";
      archivedReportsFeedback.textContent = message;
      return;
    }

    mappingAnnouncement.textContent = "";
    mappingAnnouncement.textContent = message;
  }

  function renderReportDownloadProgress(progress) {
    const phase = progress.phase ?? progress.status;
    const running = ["preflight", "generating", "downloading"].includes(phase);
    let message = progress.message ?? "";
    if (running) {
      const completed = progress.completed ?? 0;
      const failed = progress.failed ?? 0;
      message = phase === "preflight"
        ? `Checking ${progress.total} report filenames before downloading...`
        : `${completed} of ${progress.total} PDFs downloaded${failed ? `; ${failed} failed` : ""}. ` +
          `${phase === "generating" ? "Preparing" : "Downloading"}: ${progress.name}`;
      message += " Keep the tracker panel open until the downloads finish.";
    }
    if (phase === "duplicate") {
      const names = (progress.conflicts ?? []).map((group) =>
        group.map((entry) => `"${entry.name}"`).join(" and ") +
        ` -> ${group[0].filename}`,
      );
      message += `\n${names.join("\n")}\nNo PDFs were downloaded.`;
    } else if (Array.isArray(progress.failures) && progress.failures.length > 0) {
      const details = progress.failures.filter((failure) =>
        failure.name || failure.message !== message,
      ).map((failure) => failure.name
        ? `${failure.name}: ${failure.message}` : failure.message,
      );
      if (details.length) message += "\n" + details.join("\n");
    }
    for (const element of reportDownloadStatusElements) {
      element.hidden = !message;
      element.textContent = message;
      element.dataset.error = String(["failed", "partial", "duplicate"].includes(phase));
    }
  }

  async function runReportDownload(reportIds) {
    // Selection may change while generation runs; the job owns this snapshot.
    const ids = [...new Set(reportIds)];
    if (reportDownloadBusy || reportMutationBusy || reportRenameBusy ||
        streamReportsLoading || ids.length === 0) {
      return;
    }
    reportDownloadBusy = true;
    renderStreamReportsPanel();
    try {
      if (!reportDownloadController) {
        reportDownloadController = globalThis.TikTokLiveTrackerReportDownloads
          .createReportDownloadController({
            getReport: (reportId) => streamReportClient.getReport({ reportId }),
            generatePdf: (record) => globalThis.TikTokLiveTrackerReportPdf
              .generateReportPdf(record),
            downloads: chrome.downloads,
            runtime: chrome.runtime,
            Blob: globalThis.Blob,
            URL: globalThis.URL,
            onProgress: renderReportDownloadProgress,
          });
      }
      const result = await reportDownloadController.download(ids);
      renderReportDownloadProgress(result);
    } catch (error) {
      renderReportDownloadProgress({
        status: "failed",
        message: error?.message ?? "PDF downloads could not be prepared. Please retry.",
      });
    } finally {
      reportDownloadBusy = false;
      renderStreamReportsPanel();
    }
  }

  async function runReportMutation(action, reportIds, options = {}) {
    const ids = [...new Set(reportIds)];
    const archivedAction = options.archived ?? (action !== "archive");

    if (reportMutationBusy || reportDownloadBusy || ids.length === 0) {
      return;
    }

    if (
      action === "restore" &&
      ids.length > getAvailableDashboardReportSlots()
    ) {
      announceReportMutation(
        "There are not enough dashboard slots for that selection. Archive a dashboard report or clear part of the selection.",
        true,
      );
      renderArchivedReportsView();
      return;
    }

    reportMutationBusy = true;
    streamReportsLoadError = null;
    archivedReportsLoadError = null;
    renderStreamReportsPanel();

    try {
      if (action === "archive") {
        await streamReportClient.archiveReports({ reportIds: ids });
      } else if (action === "restore") {
        await streamReportClient.restoreReports({ reportIds: ids });
      } else if (action === "delete") {
        if (archivedAction) {
          await streamReportClient.deleteArchivedReports({ reportIds: ids });
        } else {
          await streamReportClient.deleteReports({ reportIds: ids });
        }
      } else {
        throw new Error("The report action is not supported.");
      }

      ids.forEach((reportId) => selectedArchivedReportIds.delete(reportId));
      announceReportMutation(
        action === "archive"
          ? `${ids.length} ${ids.length === 1 ? "report was" : "reports were"} archived.`
          : action === "restore"
            ? `${ids.length} ${ids.length === 1 ? "report was" : "reports were"} restored to Business Records.`
            : `${ids.length} ${ids.length === 1 ? "report was" : "reports were"} permanently deleted from this Chrome profile.`,
        archivedAction,
      );
      await refreshStreamReports();
    } catch (error) {
      setReportInteractionError(error, archivedAction);
    } finally {
      reportMutationBusy = false;
      renderStreamReportsPanel();
    }
  }

  function requestPermanentReportDeletion(reportIds, returnFocusTarget = null, options = {}) {
    const ids = [...new Set(reportIds)];

    if (ids.length === 0 || reportMutationBusy || reportDownloadBusy) {
      return;
    }

    pendingReportDeletion = ids;
    pendingReportDeletionArchived = options.archived !== false;
    pendingReportDeletionReturnFocus = returnFocusTarget;
    reportActionConfirmationTitle.textContent =
      ids.length === 1
        ? "Delete report forever?"
        : `Delete ${ids.length} reports forever?`;
    reportActionConfirmationMessage.textContent =
      ids.length === 1
        ? "This permanently deletes the saved report from this Chrome profile and cannot be undone. TikTok LIVE and Google Sheets will not be changed."
        : `This permanently deletes ${ids.length} saved reports from this Chrome profile and cannot be undone. TikTok LIVE and Google Sheets will not be changed.`;
    confirmReportActionButton.textContent = "Delete forever";
    reportActionConfirmation.showModal();
  }

  async function refreshStreamReports(options = {}) {
    if (reportLibraryDisposed) return null;
    // Preserve End's auto-open intent if a library notification supersedes its read.
    streamReportsOpenLatestPending ||= options.openLatest === true;
    const generation = ++streamReportsRefreshGeneration;
    reportLibraryCapacity = null;
    streamReportsLoading = true;
    streamReportsLoadError = null;
    archivedReportsLoadError = null;
    renderStreamReportsPanel();

    try {
      const [dashboardResponse, archivedResponse, capacity] = await Promise.all([
        streamReportClient.listReports(),
        streamReportClient.listArchivedReports(),
        streamReportClient.getLibraryCapacity(),
      ]);
      if (reportLibraryDisposed || generation !== streamReportsRefreshGeneration) {
        return null;
      }
      streamReportSummaries = dashboardResponse.reports;
      archivedReportSummaries = archivedResponse.reports;
      reportLibraryCapacity = capacity;
      streamReportsLoading = false;
      renderStreamReportsPanel();

      const latest = streamReportSummaries[0] ?? null;
      const openLatest = streamReportsOpenLatestPending;
      streamReportsOpenLatestPending = false;
      if (openLatest && latest) {
        await openStreamReport(latest.reportId);
      }

      return latest;
    } catch (error) {
      if (reportLibraryDisposed || generation !== streamReportsRefreshGeneration) {
        return null;
      }
      reportLibraryCapacity = null;
      streamReportsOpenLatestPending = false;
      streamReportsLoading = false;
      const message =
        error?.message ?? "Saved reports could not be loaded. Nothing was changed.";
      streamReportsLoadError = message;
      archivedReportsLoadError = message;
      renderStreamReportsPanel();

      if (options.focusError === true) {
        (archivedReportsViewOpen
          ? archivedReportsError
          : streamReportsError).focus();
      }

      return null;
    }
  }

  function handleReportLibraryChanged(message, sender) {
    if (
      reportLibraryDisposed ||
      sender?.id !== chrome.runtime.id ||
      sender.tab !== undefined ||
      !streamReportProtocol.isReportLibraryChangedNotification(message)
    ) {
      return;
    }
    // Also refresh during own mutations: a notification can arrive after their
    // refresh has finished. The generation guard discards any superseded read.
    void refreshStreamReports();
  }

  function formatItemName(entry) {
    return entry.style ? `${entry.item} - ${entry.style}` : entry.item;
  }

  function createInventoryCard(group, view) {
    const auction = view.auction;
    const canceled = auction?.paymentStatus === "canceled";
    const variationNumber = view.variationNumber;
    const wrapper = cardTemplate.content.firstElementChild.cloneNode(true);
    const pinButton = wrapper.querySelector(".inventory-pin-button");
    const button = wrapper.querySelector(".inventory-card");
    const badges = wrapper.querySelector(".inventory-card-badges");
    const selectedLabel = wrapper.querySelector('[data-field="selected"]');
    const currentLabel = wrapper.querySelector('[data-field="current-mapped"]');
    const queuedLabel = wrapper.querySelector('[data-field="queued"]');
    const stock = viewModel.getInventoryGroupStockDisplay(group);
    const stockAriaLabel = stock.ariaLabel ?? stock.label;
    const selectedEntry = group.entries.find((entry) => entry.selected) ?? null;
    const selected = selectedEntry !== null;
    const queuedEntry = group.entries.find(
      (entry) => entry.sku === queuedNextItemSku,
    ) ?? null;
    const queued = queuedEntry !== null;
    const itemName = formatItemName(group);
    const pinned = inventoryGroupOrderController.isGroupPinned(group.key);
    const multipleSizes = group.entries.length > 1;
    const selectionAllowed = group.entries.some(
      (entry) => entry.selectionAllowed,
    );
    const canTagSelectedVariation = hasSelectedRecordedVariation(view);
    const canUseCurrentContextAction =
      canTagSelectedVariation &&
      selectionAllowed &&
      Number.isSafeInteger(view.currentVariationNumber) &&
      view.currentVariationNumber > 0;
    const reviewingHistory =
      view.isReviewingHistory ||
      view.selectedVariationNumber !== view.currentVariationNumber;
    const currentMappedSku = getCurrentVariationMappedSku(view);
    const mappedToCurrent =
      reviewingHistory &&
      group.entries.some((entry) => entry.sku === currentMappedSku);
    const currentVariationMapped = isCurrentVariationMapped(view);
    const preferredEntry = viewModel.getPreferredInventoryGroupEntry(group, {
      selectedSku: selectedEntry?.sku ?? null,
      currentMappedSku,
      queuedSku: queuedNextItemSku,
    });
    const representativeEntry = preferredEntry ?? group.entries[0];
    const historyPreservedDescription = reviewingHistory
      ? ` Variation ${view.selectedVariationNumber} will remain open.`
      : "";

    wrapper.dataset.pinned = String(pinned);
    pinButton.dataset.groupKey = group.key;
    pinButton.setAttribute("aria-pressed", String(pinned));
    pinButton.setAttribute(
      "aria-label",
      `${pinned ? "Unpin" : "Pin"} ${itemName}`,
    );
    pinButton.title = `${pinned ? "Unpin" : "Pin"} ${itemName}`;
    button.dataset.groupKey = group.key;
    button.dataset.variantSkus = JSON.stringify(
      group.entries.map((entry) => entry.sku),
    );
    button.dataset.focusSku = representativeEntry?.sku ?? "";
    button.dataset.multipleSizes = String(multipleSizes);
    button.dataset.placeholderSize = String(
      !multipleSizes && /^(?:os|n\/?a)$/i.test(representativeEntry?.size?.trim() ?? ""),
    );

    if (!multipleSizes && representativeEntry) {
      button.dataset.sku = representativeEntry.sku;
    }

    button.dataset.stockState = stock.state;
    button.dataset.selectionReason =
      group.entries.find((entry) => entry.selectionAllowed)?.selectionReason ??
      group.entries[0]?.selectionReason ??
      "";
    button.dataset.queued = String(queued);
    button.dataset.currentMapped = String(mappedToCurrent);
    button.dataset.selected = String(selected);
    button.disabled = !selectionAllowed || !canTagSelectedVariation;

    if (multipleSizes) {
      button.setAttribute("role", "combobox");
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-controls", "inventory-size-listbox");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-autocomplete", "none");
    } else {
      button.setAttribute("aria-pressed", String(selected));
    }

    if (!canTagSelectedVariation) {
      button.setAttribute(
        "aria-label",
        multipleSizes
          ? `${itemName}, ${group.entries.length} sizes, ${stockAriaLabel}. Wait for a live auction variation before tagging.`
          : `${itemName}, size ${representativeEntry?.size ?? ""}, ${stockAriaLabel}. Wait for a live auction variation before tagging.`,
      );
    } else if (button.disabled) {
      const action = auction?.sku ? "correct" : "map";

      button.setAttribute(
        "aria-label",
        multipleSizes
          ? `${itemName}, ${group.entries.length} sizes, ${stockAriaLabel}. Cannot ${action} variation ${variationNumber}.`
          : `${itemName}, size ${representativeEntry?.size ?? ""}, ${stockAriaLabel}. Cannot ${action} variation ${variationNumber}.`,
      );
    } else if (multipleSizes) {
      const selectedDescription = selectedEntry
        ? ` Size ${selectedEntry.size} is selected for variation ${variationNumber}.`
        : "";
      const canceledDescription = canceled
        ? " This is a reference-only selection; inventory and metrics will not change."
        : "";

      button.setAttribute(
        "aria-label",
        `${itemName}, ${group.entries.length} sizes, ${stockAriaLabel}.${selectedDescription}${canceledDescription} Click to choose a size for variation ${variationNumber}.`,
      );
    } else if (selected && canceled) {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${representativeEntry?.size ?? ""}, is the reference item for canceled variation ${variationNumber}, ${stockAriaLabel}. No inventory is changed. Click to unselect this reference item.`,
      );
    } else if (selected) {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${representativeEntry?.size ?? ""}, is selected for variation ${variationNumber}, ${stockAriaLabel}. Click to unselect this item.`,
      );
    } else if (canceled) {
      button.setAttribute(
        "aria-label",
        auction?.sku
          ? `Change canceled variation ${variationNumber} to reference ${itemName}, size ${representativeEntry?.size ?? ""}, ${stockAriaLabel}. No inventory will be changed.`
          : `Select ${itemName}, size ${representativeEntry?.size ?? ""}, as the reference item for canceled variation ${variationNumber}, ${stockAriaLabel}. No inventory will be changed.`,
      );
    } else if (auction?.sku) {
      button.setAttribute(
        "aria-label",
        `Correct variation ${variationNumber} to ${itemName}, size ${representativeEntry?.size ?? ""}, ${stockAriaLabel}.`,
      );
    } else {
      button.setAttribute(
        "aria-label",
        `Map variation ${variationNumber} to ${itemName}, size ${representativeEntry?.size ?? ""}, ${stockAriaLabel}.`,
      );
    }

    if (reviewingHistory && canUseCurrentContextAction) {
      const currentMappingDescription = mappedToCurrent
        ? ` This item is also selected for current variation ${view.currentVariationNumber}. Right-click to unmap it from current variation ${view.currentVariationNumber}.`
        : currentVariationMapped
          ? ` Right-click to remap current variation ${view.currentVariationNumber} to this item.`
          : ` Right-click to map this item to current variation ${view.currentVariationNumber}.`;
      const queuedDescription = queued
        ? " Queued for the next variation. Historical right-click does not change that queue."
        : "";

      button.setAttribute(
        "aria-label",
        `${button.getAttribute("aria-label")}${queuedDescription}${currentMappingDescription}${historyPreservedDescription}`,
      );
    } else if (queued) {
      let contextAction = "";

      if (canUseCurrentContextAction && currentVariationMapped) {
        contextAction =
          ` Right-click to remove it from the next variation queue.${historyPreservedDescription}`;
      } else if (canUseCurrentContextAction) {
        contextAction =
          ` Right-click to select it for current variation ${view.currentVariationNumber}; it will remain queued for the next variation.${historyPreservedDescription}`;
      }

      button.setAttribute(
        "aria-label",
        `${button.getAttribute("aria-label")} Queued for the next variation.${contextAction}`,
      );
    } else if (canUseCurrentContextAction && currentVariationMapped) {
      button.setAttribute(
        "aria-label",
        `${button.getAttribute("aria-label")} Right-click to queue this item for the next variation.${historyPreservedDescription}`,
      );
    } else if (canUseCurrentContextAction) {
      button.setAttribute(
        "aria-label",
        `${button.getAttribute("aria-label")} Right-click to select this item for current variation ${view.currentVariationNumber}.${historyPreservedDescription}`,
      );
    }

    wrapper.querySelector('[data-field="item"]').textContent = group.item;
    wrapper.querySelector('[data-field="style"]').textContent = group.style;
    wrapper.querySelector('[data-field="size-caption"]').hidden = multipleSizes;
    wrapper.querySelector('[data-field="size"]').textContent = multipleSizes
      ? preferredEntry
        ? preferredEntry.size || "No size"
        : "Choose size"
      : representativeEntry?.size ?? "";
    wrapper.querySelector('[data-field="stock-primary"]').textContent =
      stock.primaryLabel ?? stock.label;

    const secondaryStockLabel = wrapper.querySelector(
      '[data-field="stock-secondary"]',
    );

    secondaryStockLabel.textContent = stock.secondaryLabel ?? "";
    secondaryStockLabel.hidden = !stock.secondaryLabel;
    selectedLabel.hidden = !selected;
    currentLabel.hidden = !mappedToCurrent;
    queuedLabel.hidden = !queued;
    badges.hidden = !selected && !mappedToCurrent && !queued;

    if (auction?.status === "committed" && selected) {
      selectedLabel.textContent = "Sold";
    } else if (canceled && selected) {
      selectedLabel.textContent = "Canceled item";
    } else {
      selectedLabel.textContent = "Selected";
    }

    return wrapper;
  }

  function formatResultCount(visibleCount, totalCount, hasQuery) {
    if (!hasQuery) {
      return `${totalCount} ${totalCount === 1 ? "item" : "items"}`;
    }

    return `${visibleCount} of ${totalCount} ${visibleCount === 1 ? "match" : "matches"}`;
  }

  function restoreCardFocus(sku) {
    const button = [...inventoryGrid.querySelectorAll(".inventory-card")].find(
      (candidate) => {
        if (candidate.dataset.sku === sku) {
          return true;
        }

        try {
          return JSON.parse(candidate.dataset.variantSkus ?? "[]").includes(sku);
        } catch (_error) {
          return false;
        }
      },
    );

    if (button && !button.disabled) {
      button.focus();
    } else {
      searchInput.focus();
    }
  }

  function restoreInventoryPinFocus(groupKey) {
    const pinButton = [
      ...inventoryGrid.querySelectorAll(".inventory-pin-button"),
    ].find((candidate) => candidate.dataset.groupKey === groupKey);

    if (pinButton) {
      pinButton.focus();
    } else if (!inventoryListToggle.hidden) {
      inventoryListToggle.focus();
    } else {
      searchInput.focus();
    }
  }

  function toggleInventoryGroupPin(pinButton) {
    if (isCaptureInteractionLocked()) return;
    const view = getActiveView();
    const groupKey = pinButton.dataset.groupKey;
    const inventoryGroups = viewModel.groupInventoryEntries(
      view?.inventory ?? [],
    );
    const group = inventoryGroups.find(
      (candidate) => candidate.key === groupKey,
    ) ?? null;

    if (!view || !group) {
      return;
    }

    const pinLimit = inventoryListExpanded
      ? inventoryGroups.length
      : COLLAPSED_INVENTORY_ITEM_LIMIT;
    const result = inventoryGroupOrderController.togglePinnedGroup(
      groupKey,
      pinLimit,
    );
    const itemName = formatItemName(group);

    if (result.limitReached) {
      mappingAnnouncement.textContent =
        `You can pin up to ${pinLimit} items. Unpin an item before pinning ${itemName}.`;
      pinButton.focus();
      return;
    }

    renderInventory(view);
    restoreInventoryPinFocus(groupKey);

    if (result.pinned) {
      mappingAnnouncement.textContent =
        `${itemName} is pinned at position ${result.pinnedPosition}.`;
    } else {
      mappingAnnouncement.textContent =
        `${itemName} is unpinned and returned to original inventory order after pinned items.`;
    }
  }

  function findInventoryGroup(view, groupKey) {
    return viewModel.groupInventoryEntries(view?.inventory ?? []).find(
      (group) => group.key === groupKey,
    ) ?? null;
  }

  function getInventorySizeOptionRows() {
    return [...inventorySizeListbox.querySelectorAll('[role="option"]')];
  }

  function createInventorySizeBadge(label, tone) {
    const badge = document.createElement("span");

    badge.className = "inventory-size-option-badge";
    badge.dataset.tone = tone;
    badge.textContent = label;

    return badge;
  }

  function getInventorySizeOptionActionDescription(entry, view, intent) {
    if (intent === "ordinary") {
      return entry.selected
        ? `Unmap this size from variation ${view.selectedVariationNumber}`
        : `Map variation ${view.selectedVariationNumber} to this size`;
    }

    const reviewingHistory =
      view.isReviewingHistory ||
      view.selectedVariationNumber !== view.currentVariationNumber;

    if (reviewingHistory) {
      return entry.sku === getCurrentVariationMappedSku(view)
        ? `Unmap this size from current variation ${view.currentVariationNumber}; the historical variation will stay open`
        : `Map current variation ${view.currentVariationNumber} to this size; the historical variation will stay open`;
    }

    if (!isCurrentVariationMapped(view)) {
      return `Map current variation ${view.currentVariationNumber} to this size`;
    }

    return entry.sku === queuedNextItemSku
      ? "Remove this size from the next variation queue"
      : "Queue this size for the next variation without changing the current mapping";
  }

  function renderInventorySizeOptions(group, view, intent) {
    const fragment = document.createDocumentFragment();
    const reviewingHistory =
      view.isReviewingHistory ||
      view.selectedVariationNumber !== view.currentVariationNumber;
    const currentMappedSku = getCurrentVariationMappedSku(view);

    group.entries.forEach((entry, index) => {
      const stock = viewModel.getStockDisplay(entry);
      const option = document.createElement("div");
      const copy = document.createElement("span");
      const size = document.createElement("span");
      const detail = document.createElement("span");
      const side = document.createElement("span");
      const stockLabel = document.createElement("span");
      const badges = document.createElement("span");
      const selected = entry.selected === true;
      const mappedToCurrent = reviewingHistory && entry.sku === currentMappedSku;
      const queued = entry.sku === queuedNextItemSku;
      const statusDescriptions = [];

      option.id = `inventory-size-option-${index}`;
      option.className = "inventory-size-option";
      option.dataset.sku = entry.sku;
      option.dataset.stockState = stock.state;
      option.dataset.disabled = String(!entry.selectionAllowed);
      option.dataset.active = "false";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(selected));
      option.setAttribute("aria-disabled", String(!entry.selectionAllowed));

      copy.className = "inventory-size-option-copy";
      size.className = "inventory-size-option-size";
      size.textContent = entry.size || "No size";
      detail.className = "inventory-size-option-detail";
      detail.textContent = `SKU: ${entry.sku}`;
      copy.append(size, detail);

      side.className = "inventory-size-option-side";
      stockLabel.className = "inventory-size-option-stock";
      stockLabel.textContent = stock.label;
      badges.className = "inventory-size-option-badges";

      if (selected) {
        badges.append(createInventorySizeBadge("Selected", "selected"));
        statusDescriptions.push("selected for the variation being viewed");
      }

      if (mappedToCurrent) {
        badges.append(createInventorySizeBadge("Live", "current"));
        statusDescriptions.push("mapped to the current live variation");
      }

      if (queued) {
        badges.append(createInventorySizeBadge("Queued", "queued"));
        statusDescriptions.push("queued for the next variation");
      }

      side.append(stockLabel);

      if (badges.childElementCount > 0) {
        side.append(badges);
      }

      option.setAttribute(
        "aria-label",
        [
          `Size ${entry.size || "not provided"}`,
          `SKU ${entry.sku}`,
          stock.ariaLabel,
          ...statusDescriptions,
          entry.selectionAllowed
            ? getInventorySizeOptionActionDescription(entry, view, intent)
            : entry.selectionReason,
        ]
          .filter(Boolean)
          .join(", "),
      );
      option.append(copy, side);
      fragment.append(option);
    });

    inventorySizeListbox.replaceChildren(fragment);
  }

  function hideInventorySizeListbox() {
    try {
      if (
        typeof inventorySizeListbox.hidePopover === "function" &&
        inventorySizeListbox.matches(":popover-open")
      ) {
        inventorySizeListbox.hidePopover();
      }
    } catch (error) {
      console.error(
        "[TikTok Live Tracker] Inventory size listbox could not be hidden.",
        error,
      );
    }

    inventorySizeListbox.hidden = true;
    inventorySizeListbox.removeAttribute("data-fallback-open");
  }

  function positionInventorySizeListbox() {
    if (!inventorySizeMenuState) {
      return;
    }

    const triggerRect =
      inventorySizeMenuState.trigger.getBoundingClientRect();
    const viewportWidth = Math.max(
      document.documentElement?.clientWidth ?? 0,
      window.innerWidth ?? 0,
    );
    const viewportHeight = Math.max(
      document.documentElement?.clientHeight ?? 0,
      window.innerHeight ?? 0,
    );
    const viewportMargin = 8;
    const popupGap = 4;
    const popupWidth = Math.max(
      0,
      Math.min(
        Math.max(triggerRect.width, 220),
        viewportWidth - viewportMargin * 2,
      ),
    );
    const popupLeft = Math.min(
      Math.max(viewportMargin, triggerRect.left),
      Math.max(viewportMargin, viewportWidth - viewportMargin - popupWidth),
    );
    const spaceBelow = Math.max(
      0,
      viewportHeight - triggerRect.bottom - popupGap - viewportMargin,
    );
    const spaceAbove = Math.max(
      0,
      triggerRect.top - popupGap - viewportMargin,
    );
    const heightCap = Math.min(360, Math.floor(viewportHeight * 0.52));
    const openAbove =
      spaceBelow < Math.min(150, heightCap) && spaceAbove > spaceBelow;
    const availableHeight = openAbove ? spaceAbove : spaceBelow;

    inventorySizeListbox.style.width = `${popupWidth}px`;
    inventorySizeListbox.style.left = `${popupLeft}px`;
    inventorySizeListbox.style.maxHeight = `${Math.max(
      1,
      Math.min(heightCap, availableHeight),
    )}px`;

    if (openAbove) {
      inventorySizeListbox.style.top = "auto";
      inventorySizeListbox.style.bottom = `${
        viewportHeight - triggerRect.top + popupGap
      }px`;
    } else {
      inventorySizeListbox.style.top = `${triggerRect.bottom + popupGap}px`;
      inventorySizeListbox.style.bottom = "auto";
    }
  }

  function showInventorySizeListbox() {
    inventorySizeListbox.hidden = false;
    positionInventorySizeListbox();

    try {
      if (typeof inventorySizeListbox.showPopover === "function") {
        inventorySizeListbox.showPopover();
      } else {
        inventorySizeListbox.dataset.fallbackOpen = "true";
      }
    } catch (error) {
      inventorySizeListbox.dataset.fallbackOpen = "true";
      console.error(
        "[TikTok Live Tracker] Inventory size listbox could not enter the top layer.",
        error,
      );
    }
  }

  function setActiveInventorySize(sku, options = {}) {
    const { scroll = true } = options;
    const rows = getInventorySizeOptionRows().filter(
      (row) => row.dataset.disabled !== "true",
    );
    const nextRow = rows.find((row) => row.dataset.sku === sku) ?? rows[0] ?? null;
    const trigger = inventorySizeMenuState?.trigger ?? null;

    if (!nextRow || !trigger) {
      activeInventorySizeSku = null;
      trigger?.removeAttribute("aria-activedescendant");
      return false;
    }

    getInventorySizeOptionRows().forEach((row) => {
      row.dataset.active = String(row === nextRow);
    });
    activeInventorySizeSku = nextRow.dataset.sku;
    trigger.setAttribute("aria-activedescendant", nextRow.id);

    if (scroll && typeof nextRow.scrollIntoView === "function") {
      nextRow.scrollIntoView({ block: "nearest" });
    }

    return true;
  }

  function moveActiveInventorySize(offset) {
    const rows = getInventorySizeOptionRows().filter(
      (row) => row.dataset.disabled !== "true",
    );

    if (rows.length === 0) {
      return;
    }

    const currentIndex = rows.findIndex(
      (row) => row.dataset.sku === activeInventorySizeSku,
    );
    const nextIndex = Math.min(
      rows.length - 1,
      Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + offset),
    );

    setActiveInventorySize(rows[nextIndex].dataset.sku);
  }

  function moveActiveInventorySizeToBoundary(boundary) {
    const rows = getInventorySizeOptionRows().filter(
      (row) => row.dataset.disabled !== "true",
    );
    const row = boundary === "end" ? rows.at(-1) : rows[0];

    if (row) {
      setActiveInventorySize(row.dataset.sku);
    }
  }

  function releaseInventorySizeMenu(options = {}) {
    const { restoreFocus = false, flush = true } = options;
    const state = inventorySizeMenuState;
    const focusSku = state?.trigger?.dataset.focusSku ?? null;
    const deferred = deferredInventoryRender;

    if (state?.trigger) {
      state.trigger.setAttribute("aria-expanded", "false");
      state.trigger.removeAttribute("aria-activedescendant");
    }

    inventorySizeMenuState = null;
    activeInventorySizeSku = null;
    hideInventorySizeListbox();

    if (flush && deferred?.view) {
      deferredInventoryRender = null;
      renderInventory(deferred.view, null);
    } else if (flush) {
      deferredInventoryRender = null;
    }

    setWorkspaceBusy(savedSnapshot?.busy === true);

    if (restoreFocus) {
      if (focusSku) {
        restoreCardFocus(focusSku);
      } else if (state?.trigger?.isConnected && !state.trigger.disabled) {
        state.trigger.focus();
      }
    }
  }

  function flushDeferredInventoryRender() {
    if (inventorySizeMenuState || !deferredInventoryRender?.view) {
      return;
    }

    const deferred = deferredInventoryRender;
    const focusedInventorySku = getFocusedInventorySku();
    const focusFellBackToDocument =
      document.activeElement === null ||
      document.activeElement === document.body;
    const focusSku = focusedInventorySku ?? (
      focusFellBackToDocument ? deferred.focusSku : null
    );

    deferredInventoryRender = null;
    renderInventory(deferred.view, focusSku);
  }

  function resetInventorySizeMenu() {
    inventorySizeMenuState?.trigger?.setAttribute("aria-expanded", "false");
    inventorySizeMenuState?.trigger?.removeAttribute("aria-activedescendant");
    inventorySizeMenuState = null;
    activeInventorySizeSku = null;
    deferredInventoryRender = null;
    hideInventorySizeListbox();
  }

  function openInventorySizeMenu(trigger, intent, options = {}) {
    if (isCaptureInteractionLocked()) return false;
    const view = getActiveView();
    const group = findInventoryGroup(view, trigger.dataset.groupKey);

    if (!view || !group || group.entries.length < 2 || trigger.disabled) {
      return false;
    }

    if (
      inventorySizeMenuState?.trigger === trigger &&
      inventorySizeMenuState.intent === intent
    ) {
      releaseInventorySizeMenu({ restoreFocus: true });
      return false;
    }

    if (inventorySizeMenuState) {
      releaseInventorySizeMenu({ flush: false });
    }

    if (variationSelectorOpen) {
      releaseVariationSelector();
    }

    inventorySizeMenuState = {
      groupKey: group.key,
      intent,
      trigger,
      streamId: mountedStreamId,
      selectedVariationNumber: view.selectedVariationNumber,
      currentVariationNumber: view.currentVariationNumber,
    };
    renderInventorySizeOptions(group, view, intent);
    trigger.setAttribute("aria-expanded", "true");
    showInventorySizeListbox();

    const reviewingHistory =
      view.isReviewingHistory ||
      view.selectedVariationNumber !== view.currentVariationNumber;
    const selectedSku = group.entries.find((entry) => entry.selected)?.sku;
    const currentMappedSku = getCurrentVariationMappedSku(view);
    const preferredSku =
      intent === "ordinary"
        ? selectedSku
        : reviewingHistory
          ? currentMappedSku
          : queuedNextItemSku ?? selectedSku;

    if (options.boundary === "start" || options.boundary === "end") {
      moveActiveInventorySizeToBoundary(options.boundary);
    } else {
      setActiveInventorySize(preferredSku);
    }

    setWorkspaceBusy(savedSnapshot?.busy === true);
    return true;
  }

  function getVariationOptionDisplay(option) {
    return variationSelectorViewModel.createOptionDisplay(option, {
      formatItemName,
    });
  }

  function createVariationOptionContent(display) {
    const content = document.createElement("span");
    const variationNumber = document.createElement("span");
    const firstSeparator = document.createElement("span");
    const paymentStatus = document.createElement("span");
    const secondSeparator = document.createElement("span");
    const itemStatus = document.createElement("span");

    content.className = "variation-option-content";
    variationNumber.className = "variation-option-number";
    variationNumber.textContent = display.variationLabel;
    firstSeparator.className = "variation-option-separator";
    firstSeparator.textContent = " - ";
    paymentStatus.className = "variation-option-status";
    paymentStatus.dataset.tone = display.paymentTone;
    paymentStatus.textContent = display.paymentLabel;
    secondSeparator.className = "variation-option-separator";
    secondSeparator.textContent = " - ";
    itemStatus.className = "variation-option-item";
    itemStatus.dataset.tone = display.itemTone;
    itemStatus.textContent = display.itemLabel;
    content.append(
      variationNumber,
      firstSeparator,
      paymentStatus,
      secondSeparator,
      itemStatus,
    );

    return content;
  }

  function getVariationOptionRows() {
    return [...variationListbox.querySelectorAll('[role="option"]')];
  }

  function restoreCurrentVariationHighlight() {
    getVariationOptionRows().forEach((row) => {
      const current = row.dataset.current === "true";

      row.dataset.active = "false";
      row.setAttribute("aria-selected", String(current));
    });
  }

  function setActiveVariation(variationNumber, options = {}) {
    const { scroll = true } = options;
    const rows = getVariationOptionRows();
    const nextRow = rows.find(
      (row) => Number(row.dataset.variationNumber) === variationNumber,
    ) ?? rows[0] ?? null;

    if (!nextRow) {
      activeVariationNumber = null;
      variationSelector.removeAttribute("aria-activedescendant");
      return false;
    }

    rows.forEach((row) => {
      const active = row === nextRow;

      row.dataset.active = String(active);
    });
    activeVariationNumber = Number(nextRow.dataset.variationNumber);
    variationSelector.setAttribute("aria-activedescendant", nextRow.id);

    if (scroll && typeof nextRow.scrollIntoView === "function") {
      nextRow.scrollIntoView({ block: "nearest" });
    }

    return true;
  }

  function moveActiveVariation(offset) {
    const rows = getVariationOptionRows();

    if (rows.length === 0) {
      return;
    }

    const currentIndex = rows.findIndex(
      (row) => Number(row.dataset.variationNumber) === activeVariationNumber,
    );
    const nextIndex = Math.min(
      rows.length - 1,
      Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + offset),
    );

    setActiveVariation(Number(rows[nextIndex].dataset.variationNumber));
  }

  function moveActiveVariationToBoundary(boundary) {
    const rows = getVariationOptionRows();
    const row = boundary === "end" ? rows.at(-1) : rows[0];

    if (row) {
      setActiveVariation(Number(row.dataset.variationNumber));
    }
  }

  function positionVariationListbox() {
    if (!variationSelectorOpen) {
      return;
    }

    const triggerRect = variationSelector.getBoundingClientRect();
    const viewportWidth = Math.max(
      document.documentElement?.clientWidth ?? 0,
      window.innerWidth ?? 0,
    );
    const viewportHeight = Math.max(
      document.documentElement?.clientHeight ?? 0,
      window.innerHeight ?? 0,
    );
    const viewportMargin = 8;
    const popupGap = 4;
    const popupWidth = Math.max(
      0,
      Math.min(triggerRect.width, viewportWidth - viewportMargin * 2),
    );
    const popupLeft = Math.min(
      Math.max(viewportMargin, triggerRect.left),
      Math.max(viewportMargin, viewportWidth - viewportMargin - popupWidth),
    );
    const spaceBelow = Math.max(
      0,
      viewportHeight - triggerRect.bottom - popupGap - viewportMargin,
    );
    const spaceAbove = Math.max(
      0,
      triggerRect.top - popupGap - viewportMargin,
    );
    const heightCap = Math.min(480, Math.floor(viewportHeight * 0.55));
    const openAbove =
      spaceBelow < Math.min(160, heightCap) && spaceAbove > spaceBelow;
    const availableHeight = openAbove ? spaceAbove : spaceBelow;

    variationListbox.style.width = `${popupWidth}px`;
    variationListbox.style.left = `${popupLeft}px`;
    variationListbox.style.maxHeight = `${Math.max(
      1,
      Math.min(heightCap, availableHeight),
    )}px`;

    if (openAbove) {
      variationListbox.style.top = "auto";
      variationListbox.style.bottom = `${
        viewportHeight - triggerRect.top + popupGap
      }px`;
    } else {
      variationListbox.style.top = `${triggerRect.bottom + popupGap}px`;
      variationListbox.style.bottom = "auto";
    }
  }

  function showVariationListbox() {
    variationListbox.hidden = false;
    positionVariationListbox();

    try {
      if (typeof variationListbox.showPopover === "function") {
        variationListbox.showPopover();
      } else {
        variationListbox.dataset.fallbackOpen = "true";
      }
    } catch (error) {
      variationListbox.dataset.fallbackOpen = "true";
      console.error(
        "[TikTok Live Tracker] Variation listbox could not enter the top layer.",
        error,
      );
    }
  }

  function openVariationSelector(options = {}) {
    if (isCaptureInteractionLocked()) return;
    const { boundary = null } = options;

    if (
      variationSelectorOpen ||
      variationSelector.getAttribute("aria-disabled") === "true"
    ) {
      return false;
    }

    const rows = getVariationOptionRows();

    if (rows.length === 0) {
      return false;
    }

    if (inventorySizeMenuState) {
      releaseInventorySizeMenu();
    }

    variationSelectorLock.lock();
    variationSelectorOpen = true;
    variationSelectShell.dataset.open = "true";
    variationSelector.setAttribute("aria-expanded", "true");
    showVariationListbox();

    if (boundary === "start" || boundary === "end") {
      moveActiveVariationToBoundary(boundary);
    } else {
      const selectedVariationNumber = Number(
        variationSelector.dataset.variationNumber,
      );

      setActiveVariation(selectedVariationNumber);
    }

    return true;
  }

  function renderLiveAuction(view) {
    const display = liveAuctionViewModel.createDisplay({
      view,
      liveAuction: liveAuctionSnapshot.liveAuction,
      formatUsdCents: viewModel.formatUsdCents,
    });

    liveAuctionPanel.hidden = display.hidden;
    liveAuctionPanel.dataset.state = display.state;

    if (liveAuctionTitle.textContent !== display.variationLabel) {
      liveAuctionTitle.textContent = display.variationLabel;
    }

    if (liveBidValue.textContent !== display.currentBid) {
      liveBidValue.textContent = display.currentBid;
    }

    if (liveUnitCostValue.textContent !== display.unitCost) {
      liveUnitCostValue.textContent = display.unitCost;
    }

    if (liveGrossProfitValue.textContent !== display.grossProfit) {
      liveGrossProfitValue.textContent = display.grossProfit;
    }

    if (liveGrossProfitValue.dataset.tone !== display.profitTone) {
      liveGrossProfitValue.dataset.tone = display.profitTone;
    }

    if (liveRemainingInventoryValue.textContent !== display.remainingInventory) {
      liveRemainingInventoryValue.textContent = display.remainingInventory;
    }
  }

  function renderVariationSelectorOptions(view) {
    const fragment = document.createDocumentFragment();
    const variations = getRecordedVariations(view);

    if (variations.length === 0) {
      variationSelectorValue.textContent =
        "Waiting for live auction variations";
      variationSelector.removeAttribute("data-variation-number");
      variationSelector.setAttribute("aria-disabled", "true");
      variationSelector.tabIndex = -1;
    } else {
      variations.forEach((variation) => {
        const display = getVariationOptionDisplay(variation);
        const option = document.createElement("div");

        option.id = `variation-option-${variation.variationNumber}`;
        option.className = "variation-option";
        option.dataset.variationNumber = String(variation.variationNumber);
        option.dataset.current = String(variation.selected);
        option.dataset.active = "false";
        option.setAttribute("role", "option");
        option.setAttribute("aria-label", display.fullLabel);
        option.setAttribute("aria-selected", String(variation.selected));
        option.append(createVariationOptionContent(display));
        fragment.append(option);
      });

      const selectedVariation = variations.find(
        (variation) => variation.selected,
      ) ?? variations[0];
      const selectedDisplay = getVariationOptionDisplay(selectedVariation);

      variationSelectorValue.replaceChildren(
        createVariationOptionContent(selectedDisplay),
      );
      variationSelector.dataset.variationNumber = String(
        selectedVariation.variationNumber,
      );
      variationSelector.setAttribute("aria-disabled", "false");
      variationSelector.tabIndex = 0;
    }

    variationListbox.replaceChildren(fragment);
  }

  function renderVariationNavigation(view) {
    const variations = getRecordedVariations(view);

    variationSelectorLock.requestRender(view);

    const reviewingRecordedHistory =
      variations.length > 0 && view.isReviewingHistory;

    if (variations.length > 0) {
      variationContext.textContent = "Live auction variations";
    } else {
      variationContext.textContent =
        "Waiting for a live auction variation";
    }

    returnToCurrentButton.classList.add("return-to-current-live");
    returnToCurrentButton.hidden = !reviewingRecordedHistory;
    returnToCurrentButton.textContent = "Return to live item";
  }

  function renderInventory(view, focusSku = null) {
    if (inventorySizeMenuState) {
      deferredInventoryRender = { view, focusSku };
      return;
    }

    const focusedPinGroupKey = document.activeElement
      ?.closest?.(".inventory-pin-button")
      ?.dataset.groupKey ?? null;
    const canceled = view.auction?.paymentStatus === "canceled";
    const query = searchInput.value;
    const normalizedQuery = viewModel.normalizeSearchText(query);
    const inventoryGroups = viewModel.groupInventoryEntries(view.inventory);
    const orderedInventoryGroups =
      inventoryGroupOrderController.order(
        inventoryGroups,
        view,
      );
    const filteredInventory = viewModel.filterInventoryGroups(
      orderedInventoryGroups,
      query,
    );
    const visibleInventory = inventoryListExpanded
      ? filteredInventory
      : filteredInventory.slice(0, COLLAPSED_INVENTORY_ITEM_LIMIT);
    const fragment = document.createDocumentFragment();

    visibleInventory.forEach((group) => {
      fragment.append(createInventoryCard(group, view));
    });

    inventoryGrid.replaceChildren(fragment);
    inventoryGrid.dataset.orderState = canceled ? "canceled" : "editable";
    inventorySelectionNote.hidden = !canceled;
    inventorySelectionNote.textContent = canceled
      ? "This order was canceled. Select an item only to record what was auctioned; mapping, changing, or clearing it will not affect inventory or metrics."
      : "";
    inventoryGrid.hidden = filteredInventory.length === 0;
    inventoryListToggle.hidden =
      filteredInventory.length <= COLLAPSED_INVENTORY_ITEM_LIMIT;
    inventoryListToggle.setAttribute(
      "aria-expanded",
      String(inventoryListExpanded),
    );
    inventoryListToggleLabel.textContent = inventoryListExpanded
      ? "Show fewer items"
      : "Show all items";
    emptyState.hidden = filteredInventory.length !== 0;
    emptyQuery.textContent = `"${query.trim()}"`;
    clearSearchButton.hidden = normalizedQuery.length === 0;
    const nextResultCount = formatResultCount(
      filteredInventory.length,
      inventoryGroups.length,
      normalizedQuery.length > 0,
    );

    if (resultCount.textContent !== nextResultCount) {
      resultCount.textContent = nextResultCount;
    }

    if (focusSku) {
      restoreCardFocus(focusSku);
    } else if (focusedPinGroupKey) {
      restoreInventoryPinFocus(focusedPinGroupKey);
    }
  }

  function renderMetrics(view) {
    const formattedGrossItemSales = viewModel.formatUsdCents(
      view.totals.completedGmvCents,
    );
    const formattedAverageOrderValue = viewModel.formatUsdCents(
      viewModel.calculateAverageOrderValueCents(
        view.totals.completedGmvCents,
        view.totals.completedPaymentCount,
      ),
    );
    const formattedGrossProfit = viewModel.formatUsdCents(
      view.totals.profitCents,
    );
    const formattedMappedGrossMargin =
      viewModel.formatGrossMarginPercentage(
        view.totals.profitCents,
        view.totals.committedRevenueCents,
      );
    const attributedGmvDisplay = view.totals.attributedGmvDisplay;
    const tiktokFeeMetrics =
      tiktokFeeCalculator.calculateSixPercentGmvFees(attributedGmvDisplay);
    const estimatedProfitAfterFees =
      tiktokFeeCalculator.calculateEstimatedProfitAfterFees(
        attributedGmvDisplay,
        view.totals.costOfGoodsCents,
      );
    const unmatchedCompletedCount = view.totals.unmappedCompletedCount;
    const completedPaymentCount = view.totals.completedPaymentCount;
    const totalSalesCount = view.totals.totalSalesCount;
    const canceledOrderCount = Number.isSafeInteger(
      view.totals.canceledOrderCount,
    ) && view.totals.canceledOrderCount >= 0
      ? view.totals.canceledOrderCount
      : 0;
    const paymentFixingCount = Number.isSafeInteger(
      view.totals.paymentFixingCount,
    ) && view.totals.paymentFixingCount >= 0
      ? view.totals.paymentFixingCount
      : 0;
    const completedSalesRatio = `${completedPaymentCount}/${totalSalesCount}`;
    const formattedTotalGmv =
      typeof attributedGmvDisplay === "string" && attributedGmvDisplay.trim()
        ? attributedGmvDisplay.trim()
        : "—";
    const formattedFeesPaid = tiktokFeeMetrics?.feesPaidDisplay ?? "—";
    const formattedGmvAfterFees =
      tiktokFeeMetrics?.gmvAfterFeesDisplay ?? "—";
    const formattedEstimatedProfitAfterFees =
      estimatedProfitAfterFees ?? "—";

    if (grossItemSalesValue.textContent !== formattedGrossItemSales) {
      grossItemSalesValue.textContent = formattedGrossItemSales;
    }

    if (averageOrderValue.textContent !== formattedAverageOrderValue) {
      averageOrderValue.textContent = formattedAverageOrderValue;
    }

    if (totalGmvValue.textContent !== formattedTotalGmv) {
      totalGmvValue.textContent = formattedTotalGmv;
    }

    if (feesPaidValue.textContent !== formattedFeesPaid) {
      feesPaidValue.textContent = formattedFeesPaid;
    }

    if (gmvAfterFeesValue.textContent !== formattedGmvAfterFees) {
      gmvAfterFeesValue.textContent = formattedGmvAfterFees;
    }

    if (
      estimatedProfitAfterFeesValue.textContent !==
      formattedEstimatedProfitAfterFees
    ) {
      estimatedProfitAfterFeesValue.textContent =
        formattedEstimatedProfitAfterFees;
    }

    if (completedSalesValue.textContent !== completedSalesRatio) {
      completedSalesValue.textContent = completedSalesRatio;
    }

    const canceledOrdersDisplay = String(canceledOrderCount);

    if (canceledOrdersValue.textContent !== canceledOrdersDisplay) {
      canceledOrdersValue.textContent = canceledOrdersDisplay;
    }

    const paymentFixingDisplay = String(paymentFixingCount);

    if (paymentFixingValue.textContent !== paymentFixingDisplay) {
      paymentFixingValue.textContent = paymentFixingDisplay;
    }

    if (grossProfitValue.textContent !== formattedGrossProfit) {
      grossProfitValue.textContent = formattedGrossProfit;
    }

    if (mappedGrossMarginValue.textContent !== formattedMappedGrossMargin) {
      mappedGrossMarginValue.textContent = formattedMappedGrossMargin;
    }

    if (unmatchedCompletedCount > 0) {
      const warning = unmatchedCompletedCount === 1
        ? "Incomplete — 1 completed sale still needs an inventory item."
        : `Incomplete — ${unmatchedCompletedCount} completed sales still need inventory items.`;

      if (grossProfitWarning.textContent !== warning) {
        grossProfitWarning.textContent = warning;
      }
      if (estimatedProfitAfterFeesWarning.textContent !== warning) {
        estimatedProfitAfterFeesWarning.textContent = warning;
      }
      grossProfitWarning.hidden = false;
      estimatedProfitAfterFeesWarning.hidden = false;
    } else {
      grossProfitWarning.hidden = true;
      grossProfitWarning.textContent = "";
      estimatedProfitAfterFeesWarning.hidden = true;
      estimatedProfitAfterFeesWarning.textContent = "";
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

    if (isObservedCompletionAwaitingPrice(view.auction)) {
      return view.auction.sku
        ? "TikTok shows Payment complete, but the final price is still syncing. The item remains reserved and pending until the completed sale finishes syncing."
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

      return `Inventory warning: ${itemLabel} is oversold by ${negativeInventory.oversoldQuantity}. The sale remains recorded for review.`;
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
    const selectedInventory = auction?.sku
      ? view.inventory.find((entry) => entry.sku === auction.sku)
      : null;
    const soldPriceCents = Number.isSafeInteger(auction?.soldPriceCents)
      ? auction.soldPriceCents
      : null;
    const unitCostCents = Number.isSafeInteger(
      auction?.committedUnitCostCents,
    )
      ? auction.committedUnitCostCents
      : Number.isSafeInteger(selectedInventory?.unitCostCents)
        ? selectedInventory.unitCostCents
        : null;
    const remainingQuantity =
      selectedInventory?.remainingQuantity ??
      auction?.inventory?.remainingQuantity;
    const profit = Number.isSafeInteger(auction?.profitCents)
      ? viewModel.getProfitDisplay(auction.profitCents)
      : null;

    soldPriceResult.textContent = soldPriceCents === null
      ? "—"
      : viewModel.formatUsdCents(soldPriceCents);
    unitCostResult.textContent = unitCostCents === null
      ? "—"
      : viewModel.formatUsdCents(unitCostCents);
    grossProfitResult.textContent = profit?.label ?? "—";
    grossProfitResult.dataset.tone = profit?.tone ?? "neutral";
    remainingInventoryResult.textContent = Number.isSafeInteger(
      remainingQuantity,
    )
      ? `${remainingQuantity} remaining`
      : "—";
  }

  function isObservedCompletionAwaitingPrice(auction) {
    return (
      auction?.observedPaymentStatus === "payment_complete" &&
      auction.paymentStatus !== "payment_complete"
    );
  }

  function renderAuction(view) {
    const auction = view.auction;

    if (!auction || !view.isReviewingHistory) {
      pendingMapping.hidden = true;
      return;
    }

    mappedVariation.textContent = `#${auction.variationNumber}`;
    mappedItem.textContent = auction.sku ? formatItemName(auction) : "-";
    pendingMapping.dataset.status = auction.status;
    pendingMapping.hidden = false;

    renderSaleResults(view);
    renderStateWarning(view);
  }

  function renderAll(options = {}) {
    const view = getActiveView();

    if (!view) {
      return null;
    }

    renderVariationNavigation(view);
    renderLiveAuction(view);
    renderAuction(view);
    renderInventory(view, options.focusSku ?? null);
    renderMetrics(view);

    if (options.focusStatus && !pendingMapping.hidden) {
      pendingMappingTitle.focus();
    } else if (options.focusVariation) {
      variationSelector.focus();
    }

    return view;
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

  function renderInventoryPreview(
    preview,
    {
      rowCount = inventoryPreviewRowCount,
      unitCount = inventoryPreviewUnitCount,
      totalCost = inventoryPreviewTotalCost,
      rows = inventoryPreviewRows,
    } = {},
  ) {
    const { inventory, summary } = preview;

    rowCount.textContent = String(summary.rowCount);
    unitCount.textContent = String(
      summary.totalQuantityOnHandAtImport,
    );
    totalCost.textContent = viewModel.formatUsdCents(
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
    rows.replaceChildren(rowsFragment);
  }

  function resetConfirmedInventoryPreview({ collapse = true } = {}) {
    confirmedInventoryPreviewRequestEpoch += 1;
    confirmedInventoryPreviewRequestPending = false;
    confirmedInventoryPreviewBaselineId = null;
    confirmedInventoryPreviewLoading.hidden = true;
    confirmedInventoryPreviewError.hidden = true;
    confirmedInventoryPreviewErrorMessage.textContent =
      "Close and reopen the preview to try again.";
    confirmedInventoryPreview.hidden = true;
    confirmedInventoryPreviewRows.replaceChildren();

    if (collapse) {
      inventoryImportConfirmation.open = false;
    }
  }

  async function loadConfirmedInventoryPreview() {
    const expectedBaselineId =
      inventoryImportSnapshot.confirmation?.baselineId ?? null;

    if (confirmedInventoryPreviewRequestPending) {
      return;
    }

    if (typeof expectedBaselineId !== "string") {
      confirmedInventoryPreviewLoading.hidden = true;
      confirmedInventoryPreview.hidden = true;
      confirmedInventoryPreviewErrorMessage.textContent =
        "The saved baseline details are unavailable. Close and reopen the side panel to refresh them.";
      confirmedInventoryPreviewError.hidden = false;
      mappingAnnouncement.textContent =
        confirmedInventoryPreviewErrorMessage.textContent;
      return;
    }

    if (
      confirmedInventoryPreviewBaselineId === expectedBaselineId &&
      !confirmedInventoryPreview.hidden
    ) {
      return;
    }

    const requestEpoch = ++confirmedInventoryPreviewRequestEpoch;
    confirmedInventoryPreviewRequestPending = true;
    confirmedInventoryPreviewLoading.hidden = false;
    confirmedInventoryPreviewError.hidden = true;
    confirmedInventoryPreview.hidden = true;

    try {
      const preview = await inventoryImportClient.getActiveBaselinePreview();
      const requestIsCurrent =
        requestEpoch === confirmedInventoryPreviewRequestEpoch &&
        inventoryImportConfirmation.open &&
        inventoryImportSnapshot.confirmation?.baselineId === expectedBaselineId;

      if (!requestIsCurrent) {
        return;
      }

      if (!preview.ready || preview.baselineId !== expectedBaselineId) {
        throw new Error(
          "The confirmed inventory baseline is no longer available. Close and reopen the side panel to refresh it.",
        );
      }

      renderInventoryPreview(preview, {
        rowCount: confirmedInventoryPreviewRowCount,
        unitCount: confirmedInventoryPreviewUnitCount,
        totalCost: confirmedInventoryPreviewTotalCost,
        rows: confirmedInventoryPreviewRows,
      });
      confirmedInventoryPreviewBaselineId = preview.baselineId;
      confirmedInventoryPreview.hidden = false;
      mappingAnnouncement.textContent =
        `Saved inventory preview opened with ${preview.summary.rowCount} rows.`;
    } catch (error) {
      if (
        requestEpoch !== confirmedInventoryPreviewRequestEpoch ||
        !inventoryImportConfirmation.open
      ) {
        return;
      }

      confirmedInventoryPreviewErrorMessage.textContent =
        error?.message ??
        "The confirmed inventory could not be loaded. Close and reopen the preview to try again.";
      confirmedInventoryPreviewError.hidden = false;
      mappingAnnouncement.textContent =
        confirmedInventoryPreviewErrorMessage.textContent;
    } finally {
      if (requestEpoch === confirmedInventoryPreviewRequestEpoch) {
        confirmedInventoryPreviewRequestPending = false;
        confirmedInventoryPreviewLoading.hidden = true;
      }
    }
  }

  function renderInventoryImportSnapshot(snapshot) {
    inventoryImportSnapshot = snapshot;
    const streamExists = streamSnapshot.activeSession !== null;
    const busy = snapshot.busy === true;
    const failed = snapshot.phase === "error";
    const preview = snapshot.preview;
    const showPanel =
      !streamExists &&
      !shouldPrepareInventoryForStreamRetry(streamSnapshot);
    const nextConfirmedBaselineId =
      snapshot.hasConfirmedBaseline && preview === null && !failed && !busy
        ? snapshot.confirmation?.baselineId ?? null
        : null;

    if (nextConfirmedBaselineId !== confirmedInventoryPreviewContextBaselineId) {
      resetConfirmedInventoryPreview();
      confirmedInventoryPreviewContextBaselineId = nextConfirmedBaselineId;
    }

    inventoryImportPanel.hidden = !showPanel;

    if (!showPanel) {
      if (
        inventoryImportConfirmation.open ||
        confirmedInventoryPreviewRequestPending ||
        confirmedInventoryPreviewBaselineId !== null
      ) {
        resetConfirmedInventoryPreview();
      }
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
        inventoryImportConfirmationStatus.focus();
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
    captureHealthController.setSession(snapshot.activeSession?.streamId ?? null);
    updateLayoutOrder(snapshot);
    updateSessionControls();
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

    endReportReadiness.textContent = describeReportReadiness();

    streamSessionPanel.dataset.state = dataState;
    streamSessionPanel.dataset.view = active ? "tracker" : "setup";
    streamSessionPanel.setAttribute("aria-busy", String(checking || busy));
    streamSessionHeading.hidden = !active;
    streamSessionBadge.dataset.state = dataState;
    streamSessionBadge.hidden = dataState === "active";
    streamSessionStatusMessage.hidden = dataState === "active";
    const badgeContainer = !active
      ? appHeader
      : dataState === "active"
        ? streamSessionStatus
        : streamSessionHeading;

    if (streamSessionBadge.parentElement !== badgeContainer) {
      badgeContainer.append(streamSessionBadge);
    }
    streamSessionStatus.hidden =
      failed || dataState === "inactive" || dataState === "resume";
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
        savedSessionError.hidden = true;
        setTrackerWorkspaceVisible(false);
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

    streamSessionBadge.textContent = "";
    streamSessionStatusTitle.textContent = `Tracker Active | Started ${startedLabel}`;
    streamSessionStatusMessage.textContent = "";
    endStreamButton.hidden = endConfirmationOpen;
    streamSessionEndConfirmation.hidden = !endConfirmationOpen;
    mountPersistentController(activeSession);
    setWorkspaceBusy(savedSnapshot?.busy === true);
  }

  function announceSavedAction(action, view) {
    const variationNumber =
      action.variationNumber ?? view.selectedVariationNumber;
    const canceled = view.auction?.paymentStatus === "canceled";

    if (action.type === "map_variation") {
      mappingAnnouncement.textContent =
        canceled
          ? `Canceled variation ${variationNumber} reference item saved locally. Inventory and metrics were not changed.`
          : `Variation ${variationNumber} mapping saved locally.`;
    } else if (action.type === "unmap_variation") {
      mappingAnnouncement.textContent =
        canceled
          ? `Canceled variation ${variationNumber} reference item cleared locally. Inventory and metrics were not changed.`
          : `Variation ${variationNumber} item unselected and saved locally. No item is selected.`;
    }
  }

  function renderSavedSnapshot(snapshot) {
    const priorPhase = savedSnapshot?.phase ?? previousSavedPhase;
    const priorVariations = lastRenderedSavedVariations;
    const priorSelectedVariationNumber =
      savedSnapshot?.view?.selectedVariationNumber ?? null;

    savedSnapshot = snapshot;
    updateSessionControls();

    if (
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

    savedSessionError.hidden = !failed;
    setTrackerWorkspaceVisible(hasView);

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
    const nextStatusText = getSavedStatusText(snapshot);
    setFooterStatus(nextStatusText, snapshot.phase);
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

    if (endConfirmationOpen) {
      endReportReadiness.textContent = describeReportReadiness(snapshot.view);
    }

    previousSavedPhase = snapshot.phase;
  }

  function runSavedMutation(action, pendingAction) {
    if (isCaptureInteractionLocked()) return;
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

  function selectVariationFromPicker(selectedVariationNumber) {
    if (isCaptureInteractionLocked()) return;
    try {
      if (
        !persistentController ||
        !Number.isSafeInteger(selectedVariationNumber) ||
        selectedVariationNumber < 1
      ) {
        mappingAnnouncement.textContent =
          "Waiting for a live auction variation.";
        return;
      }

      searchInput.value = "";

      const snapshot = persistentController.selectVariation(
        selectedVariationNumber,
      );
      const view = snapshot.view;

      mappingAnnouncement.textContent = view.isReviewingHistory
        ? `Reviewing auction ${describeSelectedVariation(view)}. New live auctions will keep updating in this menu without changing your selection.`
        : `Reviewing auction ${describeSelectedVariation(view)}. You are following the current auction, so the next live auction will open automatically.`;
    } catch (error) {
      mappingAnnouncement.textContent =
        error?.message ?? "That variation could not be selected.";
    } finally {
      releaseVariationSelector({ restoreFocus: true });
    }
  }

  function commitActiveVariation() {
    if (isCaptureInteractionLocked()) return;
    const selectedVariationNumber = activeVariationNumber;

    if (selectedVariationNumber === null) {
      releaseVariationSelector({ restoreFocus: true });
      return;
    }

    selectVariationFromPicker(selectedVariationNumber);
  }

  // Capture-phase guards also cover stale/programmatic events and popovers
  // outside the workspace, without intercepting scrolling or End Tracking.
  for (const eventType of [
    "click", "dblclick", "auxclick", "contextmenu", "keydown", "keyup",
    "beforeinput", "input", "change", "submit", "paste", "cut", "drop",
    "dragstart", "pointerdown", "pointerup", "mousedown", "mouseup",
  ]) {
    document.addEventListener(eventType, (event) => {
      if (isTrackerInteractionTarget(event.target)) {
        guardCaptureInteraction(event);
      }
    }, true);
  }

  variationSelector.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (variationSelectorOpen) {
      releaseVariationSelector({ restoreFocus: true });
    } else {
      openVariationSelector();
    }
  });

  function handleVariationSelectorKeydown(event) {
    if (guardCaptureInteraction(event)) return;
    if (!variationSelectorOpen) {
      const opensPicker =
        event.key === " " ||
        event.key === "Spacebar" ||
        event.key === "Enter" ||
        event.key === "F4" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageDown" ||
        event.key === "PageUp";

      if (!opensPicker) {
        return;
      }

      event.preventDefault();
      openVariationSelector({
        boundary:
          event.key === "Home"
            ? "start"
            : event.key === "End"
              ? "end"
              : null,
      });
      return;
    }

    if (
      event.key === "Escape" ||
      event.key === "F4" ||
      (event.altKey && event.key === "ArrowUp")
    ) {
      event.preventDefault();
      releaseVariationSelector({ restoreFocus: true });
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveVariation(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveVariation(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActiveVariationToBoundary("start");
    } else if (event.key === "End") {
      event.preventDefault();
      moveActiveVariationToBoundary("end");
    } else if (event.key === "PageDown") {
      event.preventDefault();
      moveActiveVariation(10);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      moveActiveVariation(-10);
    } else if (
      event.key === " " ||
      event.key === "Spacebar" ||
      event.key === "Enter"
    ) {
      event.preventDefault();
      commitActiveVariation();
    } else if (event.key === "Tab") {
      releaseVariationSelector();
    }
  }

  variationSelector.addEventListener(
    "keydown",
    handleVariationSelectorKeydown,
  );
  variationListbox.addEventListener(
    "keydown",
    handleVariationSelectorKeydown,
  );

  variationListbox.addEventListener("pointerdown", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (event.button === 0 && event.target.closest?.('[role="option"]')) {
      event.preventDefault();
    }
  });

  variationListbox.addEventListener("pointerup", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (event.button === 0 && variationSelectorOpen) {
      variationSelector.focus({ preventScroll: true });
    }
  });

  variationListbox.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    const option = event.target.closest?.('[role="option"]');

    if (
      !variationSelectorOpen ||
      !option ||
      !variationListbox.contains(option)
    ) {
      return;
    }

    const selectedVariationNumber = Number(option.dataset.variationNumber);

    selectVariationFromPicker(selectedVariationNumber);
  });

  variationListbox.addEventListener("toggle", (event) => {
    if (event.newState === "closed" && variationSelectorOpen) {
      releaseVariationSelector();
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        variationSelectorOpen &&
        !variationSelectShell.contains(event.target)
      ) {
        releaseVariationSelector();
      }
    },
    true,
  );

  document.addEventListener("focusin", (event) => {
    if (
      variationSelectorOpen &&
      !variationSelectShell.contains(event.target)
    ) {
      releaseVariationSelector();
    }
  });

  window.addEventListener("resize", () => {
    positionVariationListbox();
    positionInventorySizeListbox();
  });

  document.addEventListener(
    "scroll",
    (event) => {
      if (variationSelectorOpen && event.target !== variationListbox) {
        positionVariationListbox();
      }

      if (
        inventorySizeMenuState &&
        event.target !== inventorySizeListbox
      ) {
        positionInventorySizeListbox();
      }
    },
    true,
  );

  returnToCurrentButton.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    const currentView = getActiveView();

    if (!persistentController || !currentView?.isReviewingHistory) {
      return;
    }

    const returnVariation = findVariationOption(
      currentView,
      currentView.currentVariationNumber,
    );

    if (!returnVariation?.recorded) {
      mappingAnnouncement.textContent =
        "The latest live item is not available yet.";
      return;
    }

    searchInput.value = "";
    const snapshot = persistentController.selectVariation(
      currentView.currentVariationNumber,
    );
    const view = snapshot.view;

    if (
      !view ||
      view.selectedVariationNumber !== currentView.currentVariationNumber
    ) {
      mappingAnnouncement.textContent =
        "The latest live item could not be selected.";
      return;
    }

    variationSelector.focus();
    mappingAnnouncement.textContent =
      `Returned to live ${describeSelectedVariation(view)}. The next live auction will open automatically.`;
  });

  function saveOrdinaryInventorySelection(button, view) {
    if (isCaptureInteractionLocked()) return;
    const sku = button.dataset.sku;
    const selected =
      view.inventory.find((entry) => entry.sku === sku)?.selected === true;

    runSavedMutation(
      () => selected
        ? persistentController.unmapSelectedVariation()
        : persistentController.mapSelectedSku(sku),
      {
        type: selected ? "unmap_variation" : "map_variation",
        variationNumber: view.selectedVariationNumber,
        focusSku: sku,
      },
    );
  }

  async function toggleNextItemQueue(button, view) {
    if (isCaptureInteractionLocked()) return;
    if (nextItemQueueMutationBusy) {
      mappingAnnouncement.textContent =
        "Wait for the current next-item queue change to finish.";
      return;
    }

    const expectedStreamId = mountedStreamId;
    const expectedVariationNumber = view.currentVariationNumber;
    const sku = button.dataset.sku;
    const mutationGeneration = ++nextItemQueueMutationGeneration;

    nextItemQueueMutationBusy = true;

    try {
      const response = await nextItemQueueClient.toggleQueue({
        expectedStreamId,
        expectedVariationNumber,
        sku,
      });

      if (
        mutationGeneration !== nextItemQueueMutationGeneration ||
        expectedStreamId !== mountedStreamId
      ) {
        return;
      }

      const latestView = getActiveView();
      const stillOnExpectedVariation =
        latestView?.currentVariationNumber === expectedVariationNumber;

      if (stillOnExpectedVariation) {
        queuedNextItemSku = response.queuedSku;
        renderInventory(latestView, getFocusedInventorySku());
      }

      if (response.status === "mapped_current") {
        const mappedEntry =
          latestView?.inventory.find((entry) => entry.sku === sku) ??
          view.inventory.find((entry) => entry.sku === sku);
        const mappedName = mappedEntry
          ? `${formatItemName(mappedEntry)}, size ${mappedEntry.size}`
          : sku;
        const preservedHistory = latestView?.isReviewingHistory
          ? ` Variation #${latestView.selectedVariationNumber} remains open.`
          : "";

        mappingAnnouncement.textContent =
          `Variation #${expectedVariationNumber} mapped to ${mappedName}.${preservedHistory}`;
        scheduleCaptureRefresh();
      } else if (response.queuedSku === null) {
        mappingAnnouncement.textContent =
          "The next-item queue was cleared. The current variation mapping was not changed.";
      } else {
        const queuedEntry = latestView?.inventory.find(
          (entry) => entry.sku === response.queuedSku,
        );
        const queuedName = queuedEntry
          ? `${formatItemName(queuedEntry)}, size ${queuedEntry.size}`
          : response.queuedSku;

        mappingAnnouncement.textContent =
          `${queuedName} is queued for the next variation. The current variation mapping was not changed.`;
      }

      scheduleNextItemQueueRefresh();
    } catch (error) {
      if (
        mutationGeneration === nextItemQueueMutationGeneration &&
        expectedStreamId === mountedStreamId
      ) {
        mappingAnnouncement.textContent =
          error?.message ?? "The next item could not be queued.";
        scheduleNextItemQueueRefresh();
      }
    } finally {
      if (mutationGeneration === nextItemQueueMutationGeneration) {
        nextItemQueueMutationBusy = false;
      }
    }
  }

  async function mapCurrentVariationFromHistory(button, view) {
    if (isCaptureInteractionLocked()) return;
    if (nextItemQueueMutationBusy) {
      mappingAnnouncement.textContent =
        "Wait for the current inventory action to finish.";
      return;
    }

    const expectedStreamId = mountedStreamId;
    const expectedVariationNumber = view.currentVariationNumber;
    const historicalVariationNumber = view.selectedVariationNumber;
    const sku = button.dataset.sku;
    const mutationGeneration = ++nextItemQueueMutationGeneration;

    nextItemQueueMutationBusy = true;

    try {
      const response = await nextItemQueueClient.mapCurrent({
        expectedStreamId,
        expectedVariationNumber,
        sku,
      });

      if (
        mutationGeneration !== nextItemQueueMutationGeneration ||
        expectedStreamId !== mountedStreamId
      ) {
        return;
      }

      const latestView = getActiveView();
      const mappedEntry =
        latestView?.inventory.find((entry) => entry.sku === response.sku) ??
        view.inventory.find((entry) => entry.sku === response.sku);
      const mappedName = mappedEntry
        ? `${formatItemName(mappedEntry)}, size ${mappedEntry.size}`
        : response.sku;

      if (response.status === "unmapped_current") {
        mappingAnnouncement.textContent =
          `${mappedName} was unselected from current variation #${expectedVariationNumber}. Variation #${historicalVariationNumber} remains open.`;
      } else {
        mappingAnnouncement.textContent =
          `${mappedName} was mapped to current variation #${expectedVariationNumber}. Variation #${historicalVariationNumber} remains open.`;
      }

      scheduleCaptureRefresh();
    } catch (error) {
      if (
        mutationGeneration === nextItemQueueMutationGeneration &&
        expectedStreamId === mountedStreamId
      ) {
        mappingAnnouncement.textContent =
          error?.message ?? "The current variation could not be mapped.";
      }
    } finally {
      if (mutationGeneration === nextItemQueueMutationGeneration) {
        nextItemQueueMutationBusy = false;
      }
    }
  }

  function selectInventorySizeFromPicker(sku) {
    if (isCaptureInteractionLocked()) return;
    const state = inventorySizeMenuState;
    const view = getActiveView();
    const entry = view?.inventory.find((candidate) => candidate.sku === sku);

    if (
      state &&
      (
        state.streamId !== mountedStreamId ||
        state.selectedVariationNumber !== view?.selectedVariationNumber ||
        state.currentVariationNumber !== view?.currentVariationNumber
      )
    ) {
      releaseInventorySizeMenu();
      mappingAnnouncement.textContent =
        "The live variation changed while you were choosing a size. Open the item again to apply the size to the correct variation.";
      return;
    }

    if (!state || !view || !entry || !entry.selectionAllowed) {
      releaseInventorySizeMenu({ restoreFocus: true });
      mappingAnnouncement.textContent =
        entry?.selectionReason ?? "That inventory size cannot be selected.";
      return;
    }

    const intent = state.intent;
    const actionTarget = { dataset: { sku } };

    releaseInventorySizeMenu();

    if (intent === "ordinary") {
      saveOrdinaryInventorySelection(actionTarget, view);
      return;
    }

    if (
      view.isReviewingHistory ||
      view.selectedVariationNumber !== view.currentVariationNumber
    ) {
      void mapCurrentVariationFromHistory(actionTarget, view);
      return;
    }

    void toggleNextItemQueue(actionTarget, view);
  }

  function commitActiveInventorySize() {
    if (isCaptureInteractionLocked()) return;
    if (activeInventorySizeSku === null) {
      releaseInventorySizeMenu({ restoreFocus: true });
      return;
    }

    selectInventorySizeFromPicker(activeInventorySizeSku);
  }

  function handleInventorySizeMenuKeydown(event) {
    if (guardCaptureInteraction(event)) return true;
    if (!inventorySizeMenuState) {
      return false;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      releaseInventorySizeMenu({ restoreFocus: true });
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveInventorySize(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveInventorySize(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActiveInventorySizeToBoundary("start");
    } else if (event.key === "End") {
      event.preventDefault();
      moveActiveInventorySizeToBoundary("end");
    } else if (
      event.key === " " ||
      event.key === "Spacebar" ||
      event.key === "Enter"
    ) {
      event.preventDefault();
      commitActiveInventorySize();
    } else if (event.key === "Tab") {
      releaseInventorySizeMenu({ flush: false });
      window.setTimeout(flushDeferredInventoryRender, 0);
    } else {
      return false;
    }

    return true;
  }

  inventoryGrid.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    const pinButton = event.target.closest?.(".inventory-pin-button");

    if (!pinButton || !inventoryGrid.contains(pinButton)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    toggleInventoryGroupPin(pinButton);
  });

  inventoryGrid.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (event.target.closest?.(".inventory-pin-button")) {
      return;
    }

    const button = event.target.closest?.(".inventory-card");

    if (!button || button.disabled || !inventoryGrid.contains(button)) {
      return;
    }

    const view = getActiveView();

    if (!hasSelectedRecordedVariation(view)) {
      mappingAnnouncement.textContent =
        "Wait for a captured live auction variation before selecting inventory.";
      return;
    }

    if (button.dataset.multipleSizes === "true") {
      openInventorySizeMenu(button, "ordinary");
      return;
    }

    if (inventorySizeMenuState) {
      releaseInventorySizeMenu();
    }

    saveOrdinaryInventorySelection(button, view);
  });

  inventoryGrid.addEventListener("contextmenu", (event) => {
    if (guardCaptureInteraction(event)) return;
    const button = event.target.closest?.(".inventory-card");

    if (!button || !inventoryGrid.contains(button)) {
      return;
    }

    event.preventDefault();

    if (button.disabled) {
      return;
    }

    const view = getActiveView();

    if (!hasSelectedRecordedVariation(view)) {
      mappingAnnouncement.textContent =
        "Wait for a captured live auction variation before selecting inventory.";
      return;
    }

    if (button.dataset.multipleSizes === "true") {
      openInventorySizeMenu(button, "context");
      return;
    }

    if (inventorySizeMenuState) {
      releaseInventorySizeMenu();
    }

    if (
      view.isReviewingHistory ||
      view.selectedVariationNumber !== view.currentVariationNumber
    ) {
      void mapCurrentVariationFromHistory(button, view);
      return;
    }

    void toggleNextItemQueue(button, view);
  });

  inventoryGrid.addEventListener("keydown", (event) => {
    if (guardCaptureInteraction(event)) return;
    const button = event.target.closest?.(".inventory-card");

    if (!button || button.disabled || !inventoryGrid.contains(button)) {
      return;
    }

    if (inventorySizeMenuState?.trigger === button) {
      handleInventorySizeMenuKeydown(event);
      return;
    }

    if (button.dataset.multipleSizes !== "true") {
      return;
    }

    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openInventorySizeMenu(button, "context");
    } else if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      openInventorySizeMenu(button, "ordinary", {
        boundary: event.key === "End" ? "end" : "start",
      });
    }
  });

  inventoryListToggle.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    inventoryListExpanded = !inventoryListExpanded;
    const trimmedPins = inventoryListExpanded
      ? null
      : inventoryGroupOrderController.trimPinnedGroups(
          COLLAPSED_INVENTORY_ITEM_LIMIT,
        );

    const view = getActiveView();

    if (view) {
      renderInventory(view);
    }

    if (trimmedPins?.changed) {
      const unpinnedCount = trimmedPins.unpinnedGroupKeys.length;

      mappingAnnouncement.textContent =
        `${unpinnedCount} ${unpinnedCount === 1 ? "item was" : "items were"} unpinned. ` +
        `The first ${COLLAPSED_INVENTORY_ITEM_LIMIT} pinned items remain pinned.`;
    }
  });

  inventorySizeListbox.addEventListener("keydown", (event) => {
    handleInventorySizeMenuKeydown(event);
  });

  inventorySizeListbox.addEventListener("pointerdown", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (event.button === 0 && event.target.closest?.('[role="option"]')) {
      event.preventDefault();
    }
  });

  inventorySizeListbox.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    const option = event.target.closest?.('[role="option"]');

    if (
      !inventorySizeMenuState ||
      !option ||
      !inventorySizeListbox.contains(option) ||
      option.dataset.disabled === "true"
    ) {
      return;
    }

    selectInventorySizeFromPicker(option.dataset.sku);
  });

  inventorySizeListbox.addEventListener("toggle", (event) => {
    if (event.newState === "closed" && inventorySizeMenuState) {
      releaseInventorySizeMenu();
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !inventorySizeMenuState ||
        inventorySizeListbox.contains(event.target) ||
        inventorySizeMenuState.trigger.contains(event.target)
      ) {
        return;
      }

      const nextInventoryCard = event.target.closest?.(".inventory-card");

      if (!nextInventoryCard || !inventoryGrid.contains(nextInventoryCard)) {
        releaseInventorySizeMenu();
      }
    },
    true,
  );

  document.addEventListener("focusin", (event) => {
    if (
      inventorySizeMenuState &&
      !inventorySizeListbox.contains(event.target) &&
      !inventorySizeMenuState.trigger.contains(event.target)
    ) {
      const nextInventoryCard = event.target.closest?.(".inventory-card");

      if (!nextInventoryCard || !inventoryGrid.contains(nextInventoryCard)) {
        releaseInventorySizeMenu();
      }
    }
  });

  searchInput.addEventListener("input", (event) => {
    if (guardCaptureInteraction(event)) return;
    renderAll();
  });

  searchInput.addEventListener("keydown", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (event.key === "Escape" && searchInput.value) {
      searchInput.value = "";
      renderAll();
    }
  });

  clearSearchButton.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    searchInput.value = "";
    searchInput.focus();
    renderAll();
  });

  addActiveStreamSkusButton.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (activeStreamInventoryUpdateBusy || addActiveStreamSkusButton.hidden) {
      return;
    }

    if (activeStreamInventoryUpdateOpen) {
      closeActiveStreamInventoryUpdate({
        clearReference: true,
        restoreFocus: true,
      });
      return;
    }

    activeStreamInventoryUpdateOpen = true;
    clearActiveStreamInventoryUpdateError();
    clearActiveStreamInventoryUpdateFeedback();
    renderActiveStreamInventoryUpdateControls();
    activeStreamInventorySheetReference.focus();
  });

  cancelActiveStreamInventoryUpdateButton.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
    if (activeStreamInventoryUpdateBusy) {
      return;
    }

    closeActiveStreamInventoryUpdate({
      clearReference: true,
      restoreFocus: true,
    });
  });

  activeStreamInventorySheetReference.addEventListener("input", (event) => {
    if (guardCaptureInteraction(event)) return;
    clearActiveStreamInventoryUpdateError();
  });

  activeStreamInventoryUpdateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (guardCaptureInteraction(event)) return;

    if (activeStreamInventoryUpdateBusy) {
      return;
    }

    const reference = activeStreamInventorySheetReference.value.trim();
    const activeSession = streamSnapshot.activeSession;
    const mountedController = persistentController;

    if (reference === "") {
      setActiveStreamInventoryUpdateError(
        "Paste the same Google Sheet link or ID used for this stream.",
        { markReference: true },
      );
      activeStreamInventorySheetReference.focus();
      return;
    }

    if (
      activeSession === null ||
      streamSnapshot.resumed !== true ||
      mountedController === null
    ) {
      setActiveStreamInventoryUpdateError(
        "Start or resume the tracker stream before checking for new SKUs.",
      );
      return;
    }

    activeStreamInventoryUpdateBusy = true;
    clearActiveStreamInventoryUpdateError();
    clearActiveStreamInventoryUpdateFeedback();
    renderActiveStreamInventoryUpdateControls();
    mappingAnnouncement.textContent =
      "Checking the Inventory tab for brand-new SKU rows.";

    try {
      const result = await inventoryImportClient
        .addActiveStreamSkusReference(reference);
      const addedSkus = Array.isArray(result?.addedSkus)
        ? result.addedSkus
        : [];
      const sameStreamStillMounted =
        streamSnapshot.activeSession?.streamId === activeSession.streamId &&
        persistentController === mountedController;

      if (!sameStreamStillMounted) {
        return;
      }

      let refreshedSnapshot = null;

      try {
        refreshedSnapshot = await mountedController.refresh();
      } catch (_error) {
        // The controller normally resolves failures as error snapshots, but a
        // thrown failure is handled by the same saved-update recovery below.
      }

      if (
        refreshedSnapshot?.phase !== "ready" ||
        refreshedSnapshot?.operation !== "refresh"
      ) {
        if (
          streamSnapshot.activeSession?.streamId === activeSession.streamId &&
          persistentController === mountedController
        ) {
          const savedMessage = addedSkus.length === 0
            ? "The Sheet was checked, but the live inventory view could not refresh. Close and reopen the side panel to reload it."
            : `Added ${addedSkus.length} new ${
                addedSkus.length === 1 ? "SKU" : "SKUs"
              }, but the live inventory view could not refresh. Close and reopen the side panel to reload it.`;

          activeStreamInventoryUpdateError.textContent = savedMessage;
          activeStreamInventoryUpdateError.hidden = false;
          mappingAnnouncement.textContent = savedMessage;
        }

        return;
      }

      if (
        streamSnapshot.activeSession?.streamId !== activeSession.streamId ||
        persistentController !== mountedController
      ) {
        return;
      }

      activeStreamInventoryUpdateOpen = false;
      activeStreamInventorySheetReference.value = "";
      const message = addedSkus.length === 0
        ? "No new SKUs were found. Nothing changed."
        : `Added ${addedSkus.length} new ${
            addedSkus.length === 1 ? "SKU" : "SKUs"
          }. Existing variations and mappings were preserved.`;

      showActiveStreamInventoryUpdateFeedback(message);
      mappingAnnouncement.textContent = message;
    } catch (error) {
      if (
        streamSnapshot.activeSession?.streamId !== activeSession.streamId ||
        persistentController !== mountedController
      ) {
        return;
      }

      const invalidReference = [
        "INVALID_SPREADSHEET_ID",
        "INVALID_SPREADSHEET_REFERENCE",
      ].includes(error?.code);
      const message = error?.message ??
        "The Inventory tab could not be checked.";
      const outcomeUncertain =
        typeof error?.code !== "string" ||
        [
          "ACTIVE_INVENTORY_UPDATE_FAILED",
          "INTERNAL_ERROR",
          "INVALID_RESPONSE",
          "RUNTIME_MESSAGE_FAILED",
        ].includes(error.code);

      const renderedMessage = setActiveStreamInventoryUpdateError(message, {
        markReference: invalidReference,
        outcomeUncertain,
      });
      mappingAnnouncement.textContent = renderedMessage;
    } finally {
      activeStreamInventoryUpdateBusy = false;
      renderActiveStreamInventoryUpdateControls();
    }
  });

  inventoryImportConfirmation.addEventListener("toggle", () => {
    if (!inventoryImportConfirmation.open) {
      if (confirmedInventoryPreviewRequestPending) {
        confirmedInventoryPreviewRequestEpoch += 1;
        confirmedInventoryPreviewRequestPending = false;
        confirmedInventoryPreviewLoading.hidden = true;
      }
      return;
    }

    Promise.resolve(loadConfirmedInventoryPreview()).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected saved-inventory preview failure.",
        error,
      );
    });
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
    endReportReadiness.textContent = describeReportReadiness();
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
      .then(async (snapshot) => {
        if (snapshot.phase === "ready" && snapshot.activeSession === null) {
          startStreamButton.focus();
          mappingAnnouncement.textContent =
            "Tracker stream ended and its local business report was saved. TikTok LIVE was not changed.";
          await refreshStreamReports({ openLatest: true });
        }
      })
      .catch((error) => {
        console.error(
          "[TikTok Live Tracker] Unexpected stream-end failure.",
          error,
        );
      });
  });

  retryStreamSessionButton.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
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
          inventory: viewModel.LEGACY_RECOVERY_INVENTORY,
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

  retryStreamReportsButton.addEventListener("click", () => {
    Promise.resolve(refreshStreamReports({ focusError: true })).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected stream-report retry failure.",
        error,
      );
    });
  });

  viewArchivedReportsButton.addEventListener("click", () => {
    openArchivedReportsDashboard();
  });

  backToBusinessRecordsButton.addEventListener("click", () => {
    closeArchivedReportsDashboard();
  });

  toggleArchivedSelectionButton.addEventListener("click", () => {
    archivedSelectionMode = !archivedSelectionMode;

    if (!archivedSelectionMode) {
      selectedArchivedReportIds.clear();
    }

    renderArchivedReportsView();
    toggleArchivedSelectionButton.focus();
  });

  selectAllArchivedReportsButton.addEventListener("click", () => {
    selectedArchivedReportIds = new Set(
      archivedReportSummaries.map((summary) => summary.reportId),
    );
    syncArchivedReportCheckboxes();
    renderArchivedSelectionControls();
  });

  clearArchivedSelectionButton.addEventListener("click", () => {
    selectedArchivedReportIds.clear();
    syncArchivedReportCheckboxes();
    renderArchivedSelectionControls();
  });

  downloadSelectedReportsButton.addEventListener("click", () => {
    void runReportDownload([...selectedArchivedReportIds]);
  });

  restoreSelectedReportsButton.addEventListener("click", () => {
    void runReportMutation("restore", [...selectedArchivedReportIds]);
  });

  deleteSelectedReportsButton.addEventListener("click", () => {
    requestPermanentReportDeletion(
      [...selectedArchivedReportIds],
      deleteSelectedReportsButton,
    );
  });

  retryArchivedReportsButton.addEventListener("click", () => {
    Promise.resolve(refreshStreamReports({ focusError: true })).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected archived-report retry failure.",
        error,
      );
    });
  });

  confirmReportActionButton.addEventListener("click", () => {
    const reportIds = pendingReportDeletion;
    const archived = pendingReportDeletionArchived;

    if (!reportIds || reportIds.length === 0) {
      reportActionConfirmation.close();
      return;
    }

    pendingReportDeletion = null;
    reportActionConfirmation.close();
    void runReportMutation("delete", reportIds, { archived });
  });

  reportActionConfirmation.addEventListener("close", () => {
    const restoreFocus = pendingReportDeletion !== null;
    const returnFocusTarget = pendingReportDeletionReturnFocus;

    pendingReportDeletion = null;
    pendingReportDeletionArchived = true;
    pendingReportDeletionReturnFocus = null;

    if (
      restoreFocus &&
      returnFocusTarget?.isConnected &&
      !returnFocusTarget.hidden &&
      !returnFocusTarget.disabled
    ) {
      returnFocusTarget.focus();
    }
  });

  reportRenameForm.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!pendingReportRename || reportRenameBusy) {
      return;
    }

    const displayName = reportRenameInput.value.trim();

    if (
      displayName.length < 1 ||
      displayName.length > MAX_REPORT_DISPLAY_NAME_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(displayName)
    ) {
      setReportRenameError(
        `Enter a report name between 1 and ${MAX_REPORT_DISPLAY_NAME_LENGTH} characters.`,
      );
      reportRenameInput.focus();
      return;
    }

    reportRenameInput.value = displayName;
    const savedDisplayName =
      pendingReportRename.customName === null &&
      displayName === pendingReportRename.defaultName
        ? null
        : displayName;
    void savePendingReportName(savedDisplayName);
  });

  reportRenameInput.addEventListener("input", () => {
    setReportRenameError();
  });

  cancelReportRenameButton.addEventListener("click", () => {
    if (!reportRenameBusy) {
      reportRenameDialog.close("cancel");
    }
  });

  resetReportNameButton.addEventListener("click", () => {
    void savePendingReportName(null);
  });

  reportRenameDialog.addEventListener("cancel", (event) => {
    if (reportRenameBusy) {
      event.preventDefault();
    }
  });

  reportRenameDialog.addEventListener("close", () => {
    const pending = pendingReportRename;
    const reportId = pending?.reportId ?? null;
    const returnFocusTarget = pending?.returnFocusTarget ?? null;

    pendingReportRename = null;
    setReportRenameBusy(false);
    setReportRenameError();
    reportRenameInput.value = "";

    const currentMoreButton = reportId === null
      ? null
      : findReportMoreButton(reportId);
    const focusTarget = currentMoreButton ?? returnFocusTarget;

    if (
      focusTarget?.isConnected &&
      !focusTarget.hidden &&
      !focusTarget.disabled
    ) {
      focusTarget.focus();
    }
  });

  document.addEventListener("click", () => {
    closeReportActionsMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openReportActions) {
      closeReportActionsMenu({ restoreFocus: true });
    }
  });

  retrySavedSessionButton.addEventListener("click", (event) => {
    if (guardCaptureInteraction(event)) return;
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
  chrome.runtime.onMessage.addListener(handleReportLibraryChanged);
  window.addEventListener(
    "pagehide",
    () => {
      reportLibraryDisposed = true;
      ++streamReportsRefreshGeneration;
      captureHealthController.dispose();
      captureHealthBadgeVisibilityController.dispose();
      clearCaptureRefreshTimer();
      resetLiveBidTracking();
      resetConfirmedInventoryPreview();
      chrome.runtime.onMessage.removeListener(handleCaptureStateChanged);
      chrome.runtime.onMessage.removeListener(handleReportLibraryChanged);
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
  Promise.resolve().then(() => refreshStreamReports()).catch((error) => {
    console.error(
      "[TikTok Live Tracker] Unexpected stream-report startup failure.",
      error,
    );
  });
})();
