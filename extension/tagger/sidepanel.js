(function initializeTaggerPreview() {
  "use strict";

  const viewModel = globalThis.TikTokLiveTrackerInventoryViewModel;
  const searchInput = document.querySelector("#inventory-search");
  const clearSearchButton = document.querySelector("#clear-search");
  const inventoryGrid = document.querySelector("#inventory-grid");
  const resultCount = document.querySelector("#result-count");
  const emptyState = document.querySelector("#empty-state");
  const emptyQuery = document.querySelector("#empty-query");
  const cardTemplate = document.querySelector("#inventory-card-template");

  if (!viewModel) {
    console.error("[TikTok Live Tracker] Inventory preview failed to load.");
    resultCount.textContent = "Inventory unavailable";
    return;
  }

  const inventory = viewModel.MOCK_INVENTORY;

  function createInventoryCard(entry) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    const stock = viewModel.getStockDisplay(entry);

    card.dataset.sku = entry.sku;
    card.dataset.stockState = stock.state;
    card.setAttribute(
      "aria-label",
      `${entry.item}, ${entry.style}, size ${entry.size}, ${stock.label}`,
    );
    card.querySelector('[data-field="item"]').textContent = entry.item;
    card.querySelector('[data-field="style"]').textContent = entry.style;
    card.querySelector('[data-field="size"]').textContent = entry.size;
    card.querySelector('[data-field="stock"]').textContent = stock.label;

    return card;
  }

  function formatResultCount(visibleCount, totalCount, hasQuery) {
    if (!hasQuery) {
      return `${totalCount} inventory ${totalCount === 1 ? "entry" : "entries"}`;
    }

    return `${visibleCount} of ${totalCount} ${visibleCount === 1 ? "match" : "matches"}`;
  }

  function renderInventory() {
    const query = searchInput.value;
    const normalizedQuery = viewModel.normalizeSearchText(query);
    const filteredInventory = viewModel.filterInventoryEntries(inventory, query);
    const fragment = document.createDocumentFragment();

    filteredInventory.forEach((entry) => {
      fragment.append(createInventoryCard(entry));
    });

    inventoryGrid.replaceChildren(fragment);
    inventoryGrid.hidden = filteredInventory.length === 0;
    emptyState.hidden = filteredInventory.length !== 0;
    emptyQuery.textContent = `“${query.trim()}”`;
    clearSearchButton.hidden = normalizedQuery.length === 0;
    resultCount.textContent = formatResultCount(
      filteredInventory.length,
      inventory.length,
      normalizedQuery.length > 0,
    );
  }

  searchInput.addEventListener("input", renderInventory);

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

  renderInventory();
})();
