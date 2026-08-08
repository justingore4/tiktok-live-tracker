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
      sku: "NIKE-HOODIE-GREY-XL",
      status: "pending",
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
  const saleParser = globalThis.TikTokLiveTrackerSaleParser;
  const viewModel = globalThis.TikTokLiveTrackerInventoryViewModel;
  const reconciliation = globalThis.TikTokLiveTrackerReconciliation;
  const reconciliationProtocol =
    globalThis.TikTokLiveTrackerReconciliationCoordinator;
  const reconciliationClientModule =
    globalThis.TikTokLiveTrackerReconciliationClient;
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
  const pendingMapping = document.querySelector("#pending-mapping");
  const mappedVariation = document.querySelector(
    '[data-field="mapped-variation"]',
  );
  const mappedItem = document.querySelector("#mapped-item");
  const auctionEyebrow = document.querySelector("#auction-eyebrow");
  const auctionStatus = document.querySelector("#auction-status");
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
    !mappingWorkflow ||
    !persistentTaggerControllerModule
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
  const persistentController =
    persistentTaggerControllerModule.createPersistentTaggerController({
      client: persistentClient,
      reconciliation,
      mappingWorkflow,
      inventory: viewModel.MOCK_INVENTORY,
      streamId: DEMO_STREAM_ID,
      currentVariationNumber: DEMO_CURRENT_VARIATION_NUMBER,
      variationNumbers: DEMO_VARIATION_NUMBERS,
    });
  let activeMode = "saved_session";
  let demoSession = null;
  let savedSnapshot = persistentController.getSnapshot();
  let previousSavedPhase = null;
  let pendingSavedAction = null;
  let hasFocusedSavedError = false;
  let focusSavedWorkspaceAfterRetry = false;

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

  function setWorkspaceBusy(busy) {
    trackerWorkspace.setAttribute("aria-busy", String(busy));
    trackerWorkspace.toggleAttribute("inert", busy);
  }

  function updateModeControls() {
    const savedMode = activeMode === "saved_session";

    savedModeButton.setAttribute("aria-pressed", String(savedMode));
    demoModeButton.setAttribute("aria-pressed", String(!savedMode));
    demoModeButton.disabled = savedMode && savedSnapshot?.phase === "saving";
    modeDescription.textContent = savedMode
      ? "Mappings and unpaid changes are saved locally and restored when this panel reopens."
      : "Temporary simulator. Demo actions are not saved, sent to the service worker, or applied to TikTok.";
    dataModeBadge.textContent = savedMode ? "Saved session" : "Demo data";
    sessionFooterLabel.textContent = !savedMode
      ? "Offline demo - not saved"
      : {
          idle: "Restoring saved session",
          loading: "Restoring saved session",
          saving: "Saving locally",
          error: "Saved session needs attention",
          ready: "Saved locally",
        }[savedSnapshot?.phase] ?? "Saved session";
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
      requireDemoSeedResult(
        session.selectSku(seed.sku),
        `map demo variation ${seed.variationNumber}`,
      );

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
    const selected = entry.selected;
    const itemName = formatItemName(entry);

    button.dataset.sku = entry.sku;
    button.dataset.stockState = stock.state;
    button.dataset.selectionReason = entry.selectionReason;
    button.disabled = !entry.selectionAllowed;
    button.setAttribute("aria-pressed", String(selected));

    if (selected) {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, is selected for variation ${variationNumber}, ${stock.label}. Click to unselect this item.`,
      );
    } else if (button.disabled) {
      const action = auction?.sku ? "correct" : "map";

      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, ${stock.label}. Cannot ${action} variation ${variationNumber}.`,
      );
    } else if (auction?.sku) {
      button.setAttribute(
        "aria-label",
        `Correct variation ${variationNumber} to ${itemName}, size ${entry.size}, ${stock.label}.`,
      );
    } else {
      button.setAttribute(
        "aria-label",
        `Map variation ${variationNumber} to ${itemName}, size ${entry.size}, ${stock.label}.`,
      );
    }

    wrapper.querySelector('[data-field="item"]').textContent = entry.item;
    wrapper.querySelector('[data-field="style"]').textContent = entry.style;
    wrapper.querySelector('[data-field="size"]').textContent = entry.size;
    wrapper.querySelector('[data-field="stock"]').textContent = stock.label;
    selectedLabel.hidden = !selected;

    if (auction?.status === "committed" && selected) {
      selectedLabel.textContent = "Sold";
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

    if (button) {
      button.focus();
    } else {
      searchInput.focus();
    }
  }

  function formatVariationOption(option) {
    const context = option.current ? "On screen now" : "Previous";
    const item = option.item
      ? `${formatItemName(option)}, size ${option.size}`
      : "No item selected";

    return `#${option.variationNumber} - ${context} - ${option.statusLabel} - ${item}`;
  }

  function renderVariationNavigation(view) {
    const fragment = document.createDocumentFragment();

    view.variations.forEach((variation) => {
      const option = document.createElement("option");

      option.value = String(variation.variationNumber);
      option.textContent = formatVariationOption(variation);
      option.selected = variation.selected;
      fragment.append(option);
    });

    variationSelector.replaceChildren(fragment);
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

  function describeStateWarning(view) {
    const conflict = view.auction?.conflicts?.[0];

    if (conflict?.code === "conflicting_sold_price") {
      return `Price conflict: the first completed price, ${viewModel.formatUsdCents(conflict.retainedSoldPriceCents)}, was retained for review.`;
    }

    if (conflict?.code === "payment_completed_after_marked_unpaid") {
      return "TikTok completed this payment after it was marked unpaid. The completed sale was counted and flagged for review.";
    }

    if (view.auction?.status === "unmapped_completed") {
      return "Payment is complete, but this variation still needs an inventory item. Select the matching entry below.";
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

  function renderLifecycleControls(view) {
    const committed = view.auction?.status === "committed";
    const markedUnpaid = view.auction?.status === "marked_unpaid";
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
      ? "Offline demo only. Return this sale to Waiting for payment, keep the selected item reserved, and do not change TikTok."
      : "Offline demo only. Remove the simulated payment with no item selected, and do not change TikTok.";

    lifecycleControls.hidden =
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
      view.auction?.status === "pending"
    );
    markUnpaidButton.hidden = offlineDemo
      ? !view.controls.canMarkUnpaid
      : view.auction?.status !== "pending";
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
    auctionEyebrow.textContent =
      {
        committed: "Sale result",
        marked_unpaid: "Unpaid auction",
        pending: "Just tagged",
        unmapped_completed: "Needs item",
      }[auction.status] ?? "Auction status";
    mappingStatus.textContent = auction.statusLabel;
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

    if (options.focusStatus && !pendingMapping.hidden) {
      auctionStatus.focus();
    } else if (options.focusControl === "mark_unpaid") {
      markUnpaidButton.focus();
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

    if (result.action === "completed_sale_mapped") {
      const profit = viewModel.getProfitDisplay(mapping.profitCents);

      mappingAnnouncement.textContent = `Payment-complete variation ${mapping.variationNumber} matched to ${itemDescription}. Sold for ${viewModel.formatUsdCents(mapping.soldPriceCents)}; ${profit.label} recorded.`;
    } else if (result.action === "committed_mapping_corrected") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} corrected to ${itemDescription}. Inventory and gross profit recalculated.`;
    } else if (result.action === "unpaid_mapping_corrected") {
      mappingAnnouncement.textContent = `Unpaid variation ${mapping.variationNumber} corrected to ${itemDescription}. Remaining inventory and profit stay unchanged.`;
    } else if (result.action === "remapped") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} changed to ${itemDescription}. Waiting for payment.`;
    } else if (result.action === "unchanged") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} is already mapped to ${itemDescription}.`;
    } else {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} mapped to ${itemDescription}. Waiting for payment.`;
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

    return `Variation ${selected.variationNumber}, ${selected.statusLabel}${item}`;
  }

  function getSavedStatusText(snapshot) {
    if (snapshot.phase === "idle" || snapshot.phase === "loading") {
      return snapshot.operation === "initialize"
        ? "Preparing saved session..."
        : "Restoring saved session...";
    }

    if (snapshot.phase === "saving") {
      return "Saving change...";
    }

    return snapshot.operation === "load" || snapshot.operation === "initialize"
      ? "Saved session restored"
      : "Saved locally";
  }

  function announceSavedAction(action, view) {
    const variationNumber =
      action.variationNumber ?? view.selectedVariationNumber;

    if (action.type === "map_variation") {
      mappingAnnouncement.textContent =
        `Variation ${variationNumber} mapping saved locally.`;
    } else if (action.type === "unmap_variation") {
      mappingAnnouncement.textContent =
        `Variation ${variationNumber} item unselected and saved locally. No item is selected.`;
    } else if (action.type === "mark_unpaid") {
      mappingAnnouncement.textContent =
        `Variation ${variationNumber} marked unpaid and saved locally. Its pending reservation was released.`;
    } else if (action.type === "undo_mark_unpaid") {
      mappingAnnouncement.textContent =
        `Unpaid mark removed from variation ${variationNumber} and saved locally. It is waiting for payment.`;
    }
  }

  function renderSavedSnapshot(snapshot) {
    const priorPhase = savedSnapshot?.phase ?? previousSavedPhase;

    savedSnapshot = snapshot;
    updateModeControls();

    if (activeMode !== "saved_session") {
      previousSavedPhase = snapshot.phase;
      return;
    }

    const failed = snapshot.phase === "error";
    const hasView = snapshot.view !== null;

    savedSessionStatus.hidden = failed;
    savedSessionError.hidden = !failed;
    trackerWorkspace.hidden = !hasView;

    if (failed) {
      const loadFailure = snapshot.error?.scope === "load" || !hasView;

      setWorkspaceBusy(false);
      trackerWorkspace.toggleAttribute("inert", true);
      savedSessionErrorTitle.textContent = loadFailure
        ? "Saved session unavailable"
        : "Change was not saved";
      savedSessionErrorMessage.textContent = snapshot.error?.message
        ? `${snapshot.error.message} Your last saved data was not changed.`
        : "Your last saved data was not changed. Try again.";
      retrySavedSessionButton.textContent = loadFailure
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

      if (completedAction?.focusSku) {
        focusOptions.focusSku = completedAction.focusSku;
      } else if (completedAction?.focusStatus) {
        focusOptions.focusStatus = true;
      }

      const view = renderAll(focusOptions);

      if (completedAction) {
        announceSavedAction(completedAction, view);
        pendingSavedAction = null;
      } else if (focusSavedWorkspaceAfterRetry) {
        focusSavedWorkspaceAfterRetry = false;
        variationSelector.focus();
        mappingAnnouncement.textContent =
          "Saved session restored. You can continue with the selected variation.";
      } else if (priorPhase === "loading") {
        mappingAnnouncement.textContent =
          "Saved session restored from local browser storage.";
      }
    }

    previousSavedPhase = snapshot.phase;
  }

  function runSavedMutation(action, pendingAction) {
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

    hasFocusedSavedError = false;
    renderSavedSnapshot(persistentController.getSnapshot());

    if (savedSnapshot.phase === "ready" && savedSnapshot.view) {
      focusSavedWorkspaceAfterRetry = false;
      variationSelector.focus();
      mappingAnnouncement.textContent =
        `Returned to saved ${describeSelectedVariation(savedSnapshot.view)}.`;
    }
  }

  variationSelector.addEventListener("change", () => {
    if (activeMode === "saved_session") {
      try {
        clearPriceError();
        searchInput.value = "";
        const snapshot = persistentController.selectVariation(
          Number(variationSelector.value),
        );

        const view = snapshot.view;

        mappingAnnouncement.textContent = view.isReviewingHistory
          ? `Reviewing previous ${describeSelectedVariation(view)}. Select an inventory card to tag or correct this variation.`
          : `Returned to on-screen ${describeSelectedVariation(view)}.`;
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
      try {
        clearPriceError();
        searchInput.value = "";
        const snapshot = persistentController.selectVariation(
          DEMO_CURRENT_VARIATION_NUMBER,
        );

        variationSelector.focus();
        mappingAnnouncement.textContent =
          `Returned to on-screen ${describeSelectedVariation(snapshot.view)}.`;
      } catch (error) {
        mappingAnnouncement.textContent =
          error?.message ?? "The on-screen variation could not be selected.";
      }

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

  retrySavedSessionButton.addEventListener("click", () => {
    hasFocusedSavedError = false;
    focusSavedWorkspaceAfterRetry =
      savedSnapshot.error?.scope === "load" || savedSnapshot.view === null;
    Promise.resolve().then(() => persistentController.retry()).catch((error) => {
      console.error(
        "[TikTok Live Tracker] Unexpected saved-session retry failure.",
        error,
      );
    });
  });

  persistentController.subscribe(renderSavedSnapshot);
  Promise.resolve().then(() => persistentController.start()).catch((error) => {
    console.error(
      "[TikTok Live Tracker] Unexpected saved-session startup failure.",
      error,
    );
  });
})();
