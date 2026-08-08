(function initializeTaggerMapping() {
  "use strict";

  const DEMO_STREAM_ID = "demo-stream";
  const DEMO_VARIATION_NUMBER = 203;
  const viewModel = globalThis.TikTokLiveTrackerInventoryViewModel;
  const reconciliation = globalThis.TikTokLiveTrackerReconciliation;
  const mappingWorkflow = globalThis.TikTokLiveTrackerMappingWorkflow;
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
  const mappingStatus = document.querySelector('[data-field="mapping-status"]');
  const changeMappingButton = document.querySelector("#change-mapping");
  const mappingAnnouncement = document.querySelector("#mapping-announcement");

  if (!viewModel || !reconciliation || !mappingWorkflow) {
    console.error("[TikTok Live Tracker] Tagger mapping failed to load.");
    resultCount.textContent = "Inventory unavailable";
    return;
  }

  const inventory = viewModel.MOCK_INVENTORY;
  const session = mappingWorkflow.createMappingSession({
    inventory,
    reconciliation,
    streamId: DEMO_STREAM_ID,
    variationNumber: DEMO_VARIATION_NUMBER,
  });

  function formatItemName(entry) {
    return entry.style ? `${entry.item} - ${entry.style}` : entry.item;
  }

  function createInventoryCard(entry, currentMapping) {
    const wrapper = cardTemplate.content.firstElementChild.cloneNode(true);
    const button = wrapper.querySelector(".inventory-card");
    const selectedLabel = wrapper.querySelector('[data-field="selected"]');
    const stock = viewModel.getStockDisplay(entry);
    const selected = currentMapping?.sku === entry.sku;
    const itemName = formatItemName(entry);

    button.dataset.sku = entry.sku;
    button.dataset.stockState = stock.state;
    button.disabled = stock.state === "sold_out";
    button.setAttribute("aria-pressed", String(selected));

    if (button.disabled) {
      button.setAttribute(
        "aria-label",
        `${itemName}, size ${entry.size}, sold out. Cannot map variation ${DEMO_VARIATION_NUMBER}.`,
      );
    } else if (selected) {
      button.setAttribute(
        "aria-label",
        `Variation ${DEMO_VARIATION_NUMBER} is mapped to ${itemName}, size ${entry.size}, ${stock.label}.`,
      );
    } else {
      button.setAttribute(
        "aria-label",
        `Map variation ${DEMO_VARIATION_NUMBER} to ${itemName}, size ${entry.size}, ${stock.label}.`,
      );
    }

    wrapper.querySelector('[data-field="item"]').textContent = entry.item;
    wrapper.querySelector('[data-field="style"]').textContent = entry.style;
    wrapper.querySelector('[data-field="size"]').textContent = entry.size;
    wrapper.querySelector('[data-field="stock"]').textContent = stock.label;
    selectedLabel.hidden = !selected;

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

    button?.focus();
  }

  function renderInventory(focusSku = null) {
    const query = searchInput.value;
    const normalizedQuery = viewModel.normalizeSearchText(query);
    const filteredInventory = viewModel.filterInventoryEntries(inventory, query);
    const currentMapping = session.getCurrentMapping();
    const fragment = document.createDocumentFragment();

    filteredInventory.forEach((entry) => {
      fragment.append(createInventoryCard(entry, currentMapping));
    });

    inventoryGrid.replaceChildren(fragment);
    inventoryGrid.hidden = filteredInventory.length === 0;
    emptyState.hidden = filteredInventory.length !== 0;
    emptyQuery.textContent = `"${query.trim()}"`;
    clearSearchButton.hidden = normalizedQuery.length === 0;
    const nextResultCount = formatResultCount(
      filteredInventory.length,
      inventory.length,
      normalizedQuery.length > 0,
    );

    if (resultCount.textContent !== nextResultCount) {
      resultCount.textContent = nextResultCount;
    }

    if (focusSku) {
      restoreCardFocus(focusSku);
    }
  }

  function renderPendingMapping() {
    const mapping = session.getCurrentMapping();

    if (!mapping) {
      pendingMapping.hidden = true;
      return;
    }

    mappedVariation.textContent = `#${mapping.variationNumber}`;
    mappedItem.textContent = `${formatItemName(mapping)}, size ${mapping.size}`;
    mappingStatus.textContent = mapping.statusLabel;
    pendingMapping.hidden = false;
  }

  function announceMapping(result) {
    const mapping = result.mapping;
    const itemDescription = `${formatItemName(mapping)}, size ${mapping.size}`;

    if (result.action === "remapped") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} changed to ${itemDescription}. Waiting for payment.`;
      return;
    }

    if (result.action === "unchanged") {
      mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} is already mapped to ${itemDescription}.`;
      return;
    }

    mappingAnnouncement.textContent = `Variation ${mapping.variationNumber} mapped to ${itemDescription}. Waiting for payment.`;
  }

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

    renderPendingMapping();
    renderInventory(result.mapping.sku);
    announceMapping(result);
  });

  searchInput.addEventListener("input", () => renderInventory());

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value) {
      searchInput.value = "";
      renderInventory();
    }
  });

  clearSearchButton.addEventListener("click", () => {
    searchInput.value = "";
    searchInput.focus();
    renderInventory();
  });

  changeMappingButton.addEventListener("click", () => {
    searchInput.value = "";
    renderInventory();
    searchInput.focus();
    mappingAnnouncement.textContent = `Choose a different inventory entry for variation ${DEMO_VARIATION_NUMBER}.`;
  });

  renderPendingMapping();
  renderInventory();
})();
