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
  const mappingWorkflow = globalThis.TikTokLiveTrackerMappingWorkflow;
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

  if (!saleParser || !viewModel || !reconciliation || !mappingWorkflow) {
    console.error("[TikTok Live Tracker] Tagger lifecycle failed to load.");
    resultCount.textContent = "Inventory unavailable";
    return;
  }

  const session = mappingWorkflow.createMappingSession({
    inventory: viewModel.MOCK_INVENTORY,
    reconciliation,
    streamId: DEMO_STREAM_ID,
    variationNumber: DEMO_CURRENT_VARIATION_NUMBER,
    variationNumbers: DEMO_VARIATION_NUMBERS,
    offlineSimulation: true,
  });

  function requireDemoSeedResult(result, action) {
    if (!result.ok) {
      throw new Error(`Could not ${action}: ${result.message}`);
    }

    return result;
  }

  function seedDemoVariationHistory() {
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

  seedDemoVariationHistory();

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
        `Variation ${variationNumber} is mapped to ${itemName}, size ${entry.size}, ${stock.label}.`,
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
    const canUndoSimulatedPayment =
      view.controls.canUndoSimulatedPayment;

    lifecycleControls.hidden =
      !view.mapping || (committed && !canUndoSimulatedPayment);
    completePaymentForm.hidden = !view.controls.canCompletePayment;
    simulateBufferButton.hidden = !view.controls.canSimulateBufferExpiry;
    bufferExpiredNote.hidden = !(
      view.demo.paymentBufferExpired && view.auction?.status === "pending"
    );
    markUnpaidButton.hidden = !view.controls.canMarkUnpaid;
    unpaidNote.hidden = !markedUnpaid;
    undoUnpaidButton.hidden = !view.controls.canUndoUnpaid;
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
      : "Select the matching inventory entry below.";
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
    const view = session.getViewState();

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

  variationSelector.addEventListener("change", () => {
    const result = session.selectVariation(Number(variationSelector.value));

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
    const result = session.selectVariation(DEMO_CURRENT_VARIATION_NUMBER);

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

    const result = session.selectSku(button.dataset.sku);

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    clearPriceError();
    renderAll({ focusSku: result.mapping.sku });
    announceMapping(result);
  });

  completePaymentForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const normalizedPrice = soldPriceInput.value.replace(/^\s*\$/, "");
    const soldPriceCents = saleParser.parseMoneyToCents(normalizedPrice);

    if (soldPriceCents === null || soldPriceCents < 1) {
      showPriceError("Enter a valid sold price greater than $0.00.");
      return;
    }

    const result = session.completePayment(soldPriceCents);

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
    const result = session.simulatePaymentBufferExpired();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    renderAll({ focusControl: "mark_unpaid" });
    mappingAnnouncement.textContent = `Payment buffer expired for variation ${result.view.variationNumber} in this demo.`;
  });

  markUnpaidButton.addEventListener("click", () => {
    const result = session.markUnpaid();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    renderAll({ focusStatus: true });
    mappingAnnouncement.textContent = `Variation ${result.view.variationNumber} marked unpaid. Remaining inventory and profit stay unchanged; its reservation is released.`;
  });

  undoUnpaidButton.addEventListener("click", () => {
    const result = session.undoMarkUnpaid();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    renderAll({ focusStatus: true });
    mappingAnnouncement.textContent = `Unpaid mark removed from variation ${result.view.variationNumber}. Waiting for payment.`;
  });

  undoSimulatedPaymentButton.addEventListener("click", () => {
    const result = session.undoSimulatedPayment();

    if (!result.ok) {
      mappingAnnouncement.textContent = result.message;
      return;
    }

    clearPriceError();
    searchInput.value = "";
    renderAll({ focusSku: result.mapping.sku });
    mappingAnnouncement.textContent = `Simulated payment undone for variation ${result.view.variationNumber}. It is waiting for payment again. The selected item remains reserved; remaining inventory and gross profit were restored.`;
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

  renderAll();
})();
