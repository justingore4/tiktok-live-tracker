(function initializeOfflineEditorPage(root, factory) {
  const offlineEditorPage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = offlineEditorPage;
  }

  root.TikTokLiveTrackerOfflineEditorPage = offlineEditorPage;

  if (root.document && root.addEventListener) {
    const start = () => {
      offlineEditorPage.mountOfflineEditorPage({
        document: root.document,
        location: root.location,
        runtime: root.chrome?.runtime,
        protocol: root.TikTokLiveTrackerStreamReportProtocol,
        clientModule: root.TikTokLiveTrackerOfflineReportEditorClient,
        confirm: root.confirm.bind(root),
        navigate: (url) => root.location.assign(url),
        addEventListener: root.addEventListener.bind(root),
        removeEventListener: root.removeEventListener.bind(root),
      });
    };

    if (root.document.readyState === "loading") {
      root.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createOfflineEditorPageModule() {
    "use strict";

    const COLLAPSED_INVENTORY_ITEM_LIMIT = 9;
    const inventorySizeCollator = new Intl.Collator("en-US", {
      numeric: true,
      sensitivity: "base",
    });

    function normalizeSearchText(value) {
      return String(value ?? "")
        .normalize("NFC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
    }

    function getRequestedReportId(location, protocol) {
      if (
        typeof location?.search !== "string" ||
        !(protocol?.REPORT_ID_PATTERN instanceof RegExp)
      ) {
        return null;
      }

      const parameters = new URLSearchParams(location.search);
      const reportIds = parameters.getAll("reportId");
      const keys = [...parameters.keys()];

      if (
        reportIds.length !== 1 ||
        keys.length !== 1 ||
        keys[0] !== "reportId" ||
        !protocol.REPORT_ID_PATTERN.test(reportIds[0])
      ) {
        return null;
      }

      return reportIds[0];
    }

    function createReportReturnUrl(reportId) {
      return `report.html?reportId=${encodeURIComponent(reportId)}`;
    }

    function formatUsdCents(value, unavailable = "—") {
      if (!Number.isSafeInteger(value)) {
        return unavailable;
      }

      const absolute = Math.abs(value);
      const dollars = Math.floor(absolute / 100).toLocaleString("en-US");
      const cents = String(absolute % 100).padStart(2, "0");
      return `${value < 0 ? "-" : ""}$${dollars}.${cents}`;
    }

    function formatDefaultReportName(data) {
      if (typeof data?.displayName === "string") {
        return data.displayName;
      }

      const endedAt = new Date(data?.endedAt);

      if (Number.isNaN(endedAt.getTime())) {
        return "Saved stream report";
      }

      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(endedAt);
    }

    function compareInventoryEntries(left, right) {
      const sizeComparison = inventorySizeCollator.compare(
        String(left?.size ?? ""),
        String(right?.size ?? ""),
      );

      if (sizeComparison !== 0) {
        return sizeComparison;
      }

      return inventorySizeCollator.compare(
        String(left?.sku ?? ""),
        String(right?.sku ?? ""),
      );
    }

    function groupInventoryEntries(entries) {
      if (!Array.isArray(entries)) {
        throw new TypeError("Inventory entries must be an array.");
      }

      const groupsByKey = new Map();

      entries.forEach((entry) => {
        const key = JSON.stringify([
          normalizeSearchText(entry?.item),
          normalizeSearchText(entry?.style),
        ]);
        let group = groupsByKey.get(key);

        if (!group) {
          group = {
            key,
            item: entry?.item ?? "",
            style: entry?.style ?? "",
            entries: [],
          };
          groupsByKey.set(key, group);
        }

        group.entries.push(entry);
      });

      return [...groupsByKey.values()].map((group) => ({
        ...group,
        entries: [...group.entries].sort(compareInventoryEntries),
      }));
    }

    function filterInventoryGroups(groups, query) {
      if (!Array.isArray(groups)) {
        throw new TypeError("Inventory groups must be an array.");
      }

      const normalizedQuery = normalizeSearchText(query);

      if (normalizedQuery === "") {
        return [...groups];
      }

      const searchTerms = normalizedQuery.split(" ");

      return groups.filter((group) => {
        const searchableTerms = normalizeSearchText([
          group.item,
          group.style,
          ...group.entries.flatMap((entry) => [entry.sku, entry.size]),
        ].join(" ")).split(" ");

        return searchTerms.every((term) =>
          searchableTerms.some((candidate) => candidate.startsWith(term)),
        );
      });
    }

    function prioritizeMappedGroup(groups, mappedSku) {
      const copy = [...groups];

      if (typeof mappedSku !== "string") {
        return copy;
      }

      const mappedIndex = copy.findIndex((group) =>
        group.entries.some((entry) => entry.sku === mappedSku),
      );

      if (mappedIndex <= 0) {
        return copy;
      }

      const [mappedGroup] = copy.splice(mappedIndex, 1);
      copy.unshift(mappedGroup);
      return copy;
    }

    function prepareInventoryGroups(
      entries,
      { query = "", mappedSku = null, expanded = false } = {},
    ) {
      const grouped = groupInventoryEntries(entries);
      const ordered = prioritizeMappedGroup(grouped, mappedSku);
      const filtered = filterInventoryGroups(ordered, query);

      return {
        totalGroupCount: grouped.length,
        filteredGroupCount: filtered.length,
        groups: expanded
          ? filtered
          : filtered.slice(0, COLLAPSED_INVENTORY_ITEM_LIMIT),
        canToggle: filtered.length > COLLAPSED_INVENTORY_ITEM_LIMIT,
      };
    }

    function safeBigIntToNumber(value, path, { signed = false } = {}) {
      const maximum = BigInt(Number.MAX_SAFE_INTEGER);
      const minimum = signed ? BigInt(Number.MIN_SAFE_INTEGER) : 0n;

      if (value < minimum || value > maximum) {
        throw new RangeError(`${path} exceeds the supported preview range.`);
      }

      return Number(value);
    }

    function getEffectiveSku(variation, drafts) {
      return drafts.has(variation.variationNumber)
        ? drafts.get(variation.variationNumber)
        : variation.expectedSku;
    }

    function createDraftPreview(data, drafts) {
      if (!(drafts instanceof Map)) {
        throw new TypeError("Draft mappings must be stored in a Map.");
      }

      const inventoryBySku = new Map(
        data.inventory.map((entry) => [entry.sku, entry]),
      );
      const allocationBySku = new Map(
        data.inventory.map((entry) => [entry.sku, 0n]),
      );
      let mappedCompletedCount = 0n;
      let mappedRevenueCents = 0n;
      let costOfGoodsCents = 0n;

      data.completedVariations.forEach((variation) => {
        const sku = getEffectiveSku(variation, drafts);

        if (sku === null) {
          return;
        }

        const inventoryEntry = inventoryBySku.get(sku);

        if (!inventoryEntry) {
          throw new TypeError(`Report inventory does not contain SKU ${sku}.`);
        }

        allocationBySku.set(sku, allocationBySku.get(sku) + 1n);
        mappedCompletedCount += 1n;
        mappedRevenueCents += BigInt(variation.soldPriceCents);
        costOfGoodsCents += BigInt(inventoryEntry.unitCostCents);
      });

      const inventory = data.inventory.map((entry) => {
        const outsideStreamSales =
          BigInt(entry.baselineSoldQuantity) -
          BigInt(entry.streamSoldQuantity);

        if (outsideStreamSales < 0n) {
          throw new TypeError(
            `${entry.sku} has fewer baseline sales than report sales.`,
          );
        }

        const streamSoldQuantity = allocationBySku.get(entry.sku);
        const baselineSoldQuantity = outsideStreamSales + streamSoldQuantity;
        const calculatedRemainingQuantity =
          BigInt(entry.openingQuantity) - baselineSoldQuantity;
        const replacementQuantity =
          calculatedRemainingQuantity > 0n
            ? calculatedRemainingQuantity
            : 0n;
        const available =
          calculatedRemainingQuantity - BigInt(entry.pendingQuantity);
        const availableAfterReservationsQuantity =
          available > 0n ? available : 0n;
        const oversold =
          baselineSoldQuantity +
          BigInt(entry.pendingQuantity) -
          BigInt(entry.openingQuantity);
        const oversoldQuantity = oversold > 0n ? oversold : 0n;
        const normalizedOversoldQuantity = safeBigIntToNumber(
          oversoldQuantity,
          `${entry.sku} oversold quantity`,
        );

        return {
          ...entry,
          streamSoldQuantity: safeBigIntToNumber(
            streamSoldQuantity,
            `${entry.sku} stream sold quantity`,
          ),
          baselineSoldQuantity: safeBigIntToNumber(
            baselineSoldQuantity,
            `${entry.sku} baseline sold quantity`,
          ),
          calculatedRemainingQuantity: safeBigIntToNumber(
            calculatedRemainingQuantity,
            `${entry.sku} calculated remaining quantity`,
            { signed: true },
          ),
          replacementQuantity: safeBigIntToNumber(
            replacementQuantity,
            `${entry.sku} replacement quantity`,
          ),
          availableAfterReservationsQuantity: safeBigIntToNumber(
            availableAfterReservationsQuantity,
            `${entry.sku} available quantity`,
          ),
          oversoldQuantity: normalizedOversoldQuantity,
          requiresRecount: normalizedOversoldQuantity > 0,
        };
      });
      const grossProfitCents = mappedRevenueCents - costOfGoodsCents;

      return {
        mappedCompletedCount: safeBigIntToNumber(
          mappedCompletedCount,
          "Mapped completed sale count",
        ),
        mappedRevenueCents: safeBigIntToNumber(
          mappedRevenueCents,
          "Mapped completed revenue",
        ),
        costOfGoodsCents: safeBigIntToNumber(
          costOfGoodsCents,
          "Cost of goods",
        ),
        grossProfitCents: safeBigIntToNumber(
          grossProfitCents,
          "Gross profit",
          { signed: true },
        ),
        oversoldSkuCount: inventory.filter(
          (entry) => entry.requiresRecount,
        ).length,
        inventory,
      };
    }

    function createDraftController(data) {
      const variations = [
        ...data.completedVariations,
        ...data.canceledVariations,
      ].sort((left, right) => left.variationNumber - right.variationNumber);
      const variationsByNumber = new Map(
        variations.map((variation) => [variation.variationNumber, variation]),
      );
      const inventorySkus = new Set(data.inventory.map((entry) => entry.sku));
      const drafts = new Map();
      let selectedVariationNumber = variations[0]?.variationNumber ?? null;

      function getSelectedVariation() {
        return variationsByNumber.get(selectedVariationNumber) ?? null;
      }

      function selectVariation(variationNumber) {
        if (!variationsByNumber.has(variationNumber)) {
          throw new TypeError("The selected variation is unavailable.");
        }

        selectedVariationNumber = variationNumber;
        return getSelectedVariation();
      }

      function getSelectedSku() {
        const variation = getSelectedVariation();
        return variation ? getEffectiveSku(variation, drafts) : null;
      }

      function toggleSelectedMapping(sku) {
        const variation = getSelectedVariation();

        if (!variation) {
          throw new TypeError("Choose a saved variation before mapping an item.");
        }

        if (sku !== null && !inventorySkus.has(sku)) {
          throw new TypeError("Choose an exact SKU from this report inventory.");
        }

        const currentSku = getEffectiveSku(variation, drafts);
        const nextSku = currentSku === sku ? null : sku;
        const hadDraft = drafts.has(variation.variationNumber);
        const previousDraft = drafts.get(variation.variationNumber);

        if (nextSku === variation.expectedSku) {
          drafts.delete(variation.variationNumber);
        } else {
          drafts.set(variation.variationNumber, nextSku);
        }

        try {
          createDraftPreview(data, drafts);
        } catch (error) {
          if (hadDraft) {
            drafts.set(variation.variationNumber, previousDraft);
          } else {
            drafts.delete(variation.variationNumber);
          }
          throw error;
        }

        return nextSku;
      }

      function getChanges() {
        return variations
          .filter((variation) => drafts.has(variation.variationNumber))
          .map((variation) => ({
            variationNumber: variation.variationNumber,
            expectedStatus: variation.expectedStatus,
            expectedSku: variation.expectedSku,
            sku: drafts.get(variation.variationNumber),
          }));
      }

      return Object.freeze({
        clear() {
          drafts.clear();
        },
        getChangeCount() {
          return drafts.size;
        },
        getChanges,
        getPreview() {
          return createDraftPreview(data, drafts);
        },
        getSelectedSku,
        getSelectedVariation,
        getVariations() {
          return [...variations];
        },
        selectVariation,
        toggleSelectedMapping,
      });
    }

    function createElement(document, tagName, className, textContent) {
      const element = document.createElement(tagName);

      if (className) {
        element.className = className;
      }

      if (textContent !== undefined) {
        element.textContent = textContent;
      }

      return element;
    }

    function setButtonType(button) {
      button.type = "button";
      button.setAttribute("type", "button");
    }

    function validateMountDependencies(options) {
      if (
        !options ||
        typeof options.document?.querySelector !== "function" ||
        typeof options.document?.createElement !== "function" ||
        !options.runtime ||
        !options.protocol ||
        typeof options.clientModule?.createOfflineReportEditorClient !==
          "function" ||
        typeof options.confirm !== "function" ||
        typeof options.navigate !== "function" ||
        typeof options.addEventListener !== "function" ||
        typeof options.removeEventListener !== "function"
      ) {
        throw new TypeError(
          "The packaged Offline Report Editor dependencies are unavailable.",
        );
      }

      return options;
    }

    function mountOfflineEditorPage(options) {
      let dependencies;

      try {
        dependencies = validateMountDependencies(options);
      } catch (error) {
        const loadingSection = options?.document?.querySelector?.(
          "#editor-loading",
        );
        const errorSection = options?.document?.querySelector?.("#editor-error");
        const errorMessage = options?.document?.querySelector?.(
          "#editor-error-message",
        );
        const retryButton = options?.document?.querySelector?.("#retry-editor");

        if (loadingSection) {
          loadingSection.hidden = true;
          loadingSection.setAttribute("aria-busy", "false");
        }
        if (errorSection) {
          errorSection.hidden = false;
        }
        if (errorMessage) {
          errorMessage.textContent = error.message;
        }
        if (retryButton) {
          retryButton.hidden = true;
          retryButton.disabled = true;
        }
        return null;
      }

      const { document, location, protocol } = dependencies;
      const elements = {
        loading: document.querySelector("#editor-loading"),
        error: document.querySelector("#editor-error"),
        errorMessage: document.querySelector("#editor-error-message"),
        retry: document.querySelector("#retry-editor"),
        content: document.querySelector("#editor-content"),
        reportName: document.querySelector("#editor-report-name"),
        workspace: document.querySelector("#editor-workspace"),
        variationSelector: document.querySelector("#variation-selector"),
        selectedVariation: document.querySelector("#selected-variation"),
        selectedStatus: document.querySelector("#selected-status"),
        selectedSoldPrice: document.querySelector("#selected-sold-price"),
        selectedMapping: document.querySelector("#selected-mapping"),
        originalMapping: document.querySelector("#original-mapping"),
        referenceNote: document.querySelector("#reference-only-note"),
        previewMappedCount: document.querySelector("#preview-mapped-count"),
        previewCogs: document.querySelector("#preview-cogs"),
        previewGrossProfit: document.querySelector("#preview-gross-profit"),
        previewOversold: document.querySelector("#preview-oversold"),
        search: document.querySelector("#inventory-search"),
        resultCount: document.querySelector("#inventory-result-count"),
        grid: document.querySelector("#inventory-grid"),
        empty: document.querySelector("#inventory-empty"),
        listToggle: document.querySelector("#inventory-list-toggle"),
        listToggleLabel: document.querySelector(
          "#inventory-list-toggle-label",
        ),
        draftCount: document.querySelector("#draft-count"),
        status: document.querySelector("#editor-status"),
        cancel: document.querySelector("#cancel-editor"),
        save: document.querySelector("#save-editor"),
      };
      const requiredElements = Object.values(elements);

      if (requiredElements.some((element) => !element)) {
        elements.loading?.setAttribute("aria-busy", "false");
        if (elements.loading) {
          elements.loading.hidden = true;
        }
        if (elements.error) {
          elements.error.hidden = false;
        }
        if (elements.errorMessage) {
          elements.errorMessage.textContent =
            "The packaged Offline Report Editor DOM is incomplete.";
        }
        if (elements.retry) {
          elements.retry.hidden = true;
          elements.retry.disabled = true;
        }
        return null;
      }

      let client;

      try {
        client = dependencies.clientModule.createOfflineReportEditorClient({
          runtime: dependencies.runtime,
          protocol,
        });
      } catch (error) {
        elements.loading.hidden = true;
        elements.loading.setAttribute("aria-busy", "false");
        elements.error.hidden = false;
        elements.errorMessage.textContent =
          error?.message ??
          "The packaged Offline Report Editor client is unavailable.";
        elements.retry.hidden = true;
        elements.retry.disabled = true;
        return null;
      }

      let reportId = null;
      let editorData = null;
      let draftController = null;
      let preview = null;
      let inventoryExpanded = false;
      let inventoryQuery = "";
      let saving = false;
      let destroyed = false;
      let loadSequence = 0;
      let saveSequence = 0;
      const sizeSelectionByGroup = new Map();

      function hasUnsavedChanges() {
        return (draftController?.getChangeCount() ?? 0) > 0;
      }

      function setStatus(message, isError = false) {
        elements.status.textContent = message;
        elements.status.className = isError
          ? "editor-status is-error"
          : "editor-status";
      }

      function setBusyState() {
        const editable = editorData?.eligibility?.status === "editable";

        elements.workspace.disabled = saving || !editable;
        elements.workspace.setAttribute("aria-busy", String(saving));
        elements.save.disabled =
          saving || !editable || !hasUnsavedChanges();
        elements.cancel.disabled = saving;
      }

      function showError(message) {
        elements.loading.hidden = true;
        elements.loading.setAttribute("aria-busy", "false");
        elements.content.hidden = true;
        elements.error.hidden = false;
        elements.errorMessage.textContent = message;
        elements.workspace.disabled = true;
        elements.save.disabled = true;
      }

      function findInventoryEntry(sku) {
        return editorData?.inventory.find((entry) => entry.sku === sku) ?? null;
      }

      function describeMapping(sku) {
        if (sku === null) {
          return "Unmapped";
        }

        const entry = findInventoryEntry(sku);

        if (!entry) {
          return "Unmapped";
        }

        return [entry.item, entry.style, entry.size, entry.sku]
          .filter((value) => value !== "")
          .join(" — ");
      }

      function renderVariationFacts() {
        const variation = draftController?.getSelectedVariation() ?? null;

        if (!variation) {
          elements.selectedVariation.textContent = "—";
          elements.selectedStatus.textContent = "—";
          elements.selectedSoldPrice.textContent = "—";
          elements.selectedMapping.textContent = "Unmapped";
          elements.originalMapping.textContent = "Unmapped";
          elements.referenceNote.hidden = true;
          return;
        }

        const completed = variation.expectedStatus === "payment_complete";
        elements.selectedVariation.textContent =
          `#${variation.variationNumber}`;
        elements.selectedStatus.textContent = completed
          ? "Payment complete"
          : "Canceled";
        elements.selectedSoldPrice.textContent = completed
          ? formatUsdCents(variation.soldPriceCents)
          : "Not applicable";
        elements.selectedMapping.textContent = describeMapping(
          draftController.getSelectedSku(),
        );
        elements.originalMapping.textContent = describeMapping(
          variation.expectedSku,
        );
        elements.referenceNote.hidden = completed;
      }

      function renderPreview() {
        preview = draftController.getPreview();
        elements.previewMappedCount.textContent = String(
          preview.mappedCompletedCount,
        );
        elements.previewCogs.textContent = formatUsdCents(
          preview.costOfGoodsCents,
        );
        elements.previewGrossProfit.textContent = formatUsdCents(
          preview.grossProfitCents,
        );
        elements.previewOversold.textContent = String(
          preview.oversoldSkuCount,
        );
      }

      function announceMapping(sku) {
        const variation = draftController.getSelectedVariation();
        const canceled = variation.expectedStatus === "canceled";
        const action = sku === null
          ? `Variation #${variation.variationNumber} is now unmapped.`
          : `Variation #${variation.variationNumber} now uses ${sku}.`;
        setStatus(
          canceled
            ? `${action} Reference only; inventory and metrics are unchanged.`
            : `${action} The corrected report preview was updated.`,
        );
      }

      function renderDraftActions() {
        const count = draftController?.getChangeCount() ?? 0;
        elements.draftCount.textContent = count === 0
          ? "No unsaved mapping changes."
          : `${count} unsaved mapping ${count === 1 ? "change" : "changes"}.`;
        setBusyState();
      }

      function applySelectedMapping(sku) {
        if (saving || editorData?.eligibility?.status !== "editable") {
          return;
        }

        try {
          const nextSku = draftController.toggleSelectedMapping(sku);
          renderVariationFacts();
          renderPreview();
          renderInventory();
          renderDraftActions();
          announceMapping(nextSku);
        } catch (error) {
          setStatus(error?.message ?? "The draft mapping could not be changed.", true);
        }
      }

      function createInventoryCard(group, groupIndex, selectedSku) {
        const card = createElement(document, "article", "inventory-card");
        const heading = createElement(
          document,
          "div",
          "inventory-card-heading",
        );
        const title = createElement(document, "h3", "", group.item);
        const style = createElement(
          document,
          "p",
          "inventory-style",
          group.style,
        );
        const quantity = createElement(
          document,
          "p",
          "inventory-quantity",
        );
        const controls = createElement(
          document,
          "div",
          "inventory-card-controls",
        );
        const currentMapped = group.entries.some(
          (entry) => entry.sku === selectedSku,
        );
        const available = group.entries.reduce(
          (total, entry) => total + entry.replacementQuantity,
          0,
        );
        const oversold = group.entries.reduce(
          (total, entry) => total + entry.oversoldQuantity,
          0,
        );

        card.setAttribute("role", "listitem");
        card.dataset.groupKey = group.key;
        card.dataset.currentMapped = String(currentMapped);
        card.dataset.stockState = oversold > 0 ? "oversold" : "available";
        style.hidden = group.style === "";
        quantity.append(
          createElement(document, "span", "", `${available} available`),
          createElement(document, "span", "", `${oversold} oversold`),
        );
        heading.append(title, style);
        card.append(heading, quantity, controls);

        if (group.entries.length === 1) {
          const entry = group.entries[0];
          const action = createElement(
            document,
            "button",
            "inventory-action",
            selectedSku === entry.sku
              ? `Unmap ${entry.sku}`
              : `Map ${entry.sku}`,
          );
          setButtonType(action);
          action.setAttribute(
            "aria-label",
            selectedSku === entry.sku
              ? `Unmap ${entry.sku} from the selected variation`
              : `Map the selected variation to ${entry.sku}`,
          );
          action.addEventListener("click", () =>
            applySelectedMapping(entry.sku),
          );
          controls.append(action);
          return card;
        }

        const label = createElement(document, "label", "size-picker", "Size");
        const select = createElement(document, "select", "inventory-size-select");
        const selectId = `inventory-size-${groupIndex}`;
        const rememberedSku = sizeSelectionByGroup.get(group.key);
        const preferredSku = currentMapped
          ? selectedSku
          : group.entries.some((entry) => entry.sku === rememberedSku)
            ? rememberedSku
            : group.entries[0].sku;

        select.id = selectId;
        select.setAttribute("id", selectId);
        label.setAttribute("for", selectId);
        group.entries.forEach((entry) => {
          const option = createElement(
            document,
            "option",
            "",
            `${entry.size || "No size"} — ${entry.sku} — ${entry.replacementQuantity} available${entry.oversoldQuantity > 0 ? ` — ${entry.oversoldQuantity} oversold` : ""}`,
          );
          option.value = entry.sku;
          option.setAttribute("value", entry.sku);
          select.append(option);
        });
        select.value = preferredSku;
        sizeSelectionByGroup.set(group.key, preferredSku);
        label.append(select);

        const action = createElement(document, "button", "inventory-action");
        setButtonType(action);
        const updateActionDescription = (sku) => {
          const entry = findInventoryEntry(sku);
          const size = entry?.size || "No size";
          const actionName = selectedSku === sku ? "Unmap" : "Map";

          action.textContent = `${actionName} size ${size}`;
          action.setAttribute(
            "aria-label",
            `${actionName} size ${size}, SKU ${sku}, for the selected variation`,
          );
        };

        updateActionDescription(preferredSku);
        select.addEventListener("change", (event) => {
          const sku = event.currentTarget.value;
          sizeSelectionByGroup.set(group.key, sku);
          updateActionDescription(sku);
        });
        action.addEventListener("click", () =>
          applySelectedMapping(select.value),
        );
        controls.append(label, action);
        return card;
      }

      function renderInventory() {
        const selectedSku = draftController?.getSelectedSku() ?? null;
        const originalSku =
          draftController?.getSelectedVariation()?.expectedSku ?? null;
        const prepared = prepareInventoryGroups(preview?.inventory ?? [], {
          query: inventoryQuery,
          mappedSku: originalSku,
          expanded: inventoryExpanded,
        });
        const cards = prepared.groups.map((group, index) =>
          createInventoryCard(group, index, selectedSku),
        );

        elements.grid.replaceChildren(...cards);
        elements.grid.hidden = prepared.filteredGroupCount === 0;
        elements.empty.hidden = prepared.filteredGroupCount !== 0;
        elements.resultCount.textContent = inventoryQuery.trim() === ""
          ? `${prepared.filteredGroupCount} report inventory ${prepared.filteredGroupCount === 1 ? "item" : "items"}.`
          : `${prepared.filteredGroupCount} of ${prepared.totalGroupCount} report inventory items match.`;
        elements.listToggle.hidden = !prepared.canToggle;
        elements.listToggle.setAttribute(
          "aria-expanded",
          String(inventoryExpanded),
        );
        elements.listToggleLabel.textContent = inventoryExpanded
          ? "Show fewer items"
          : "Show all items";
      }

      function renderAll() {
        renderVariationFacts();
        renderPreview();
        renderInventory();
        renderDraftActions();
      }

      function renderVariationOptions() {
        const variations = draftController.getVariations();
        const options = variations.map((variation) => {
          const completed = variation.expectedStatus === "payment_complete";
          const option = createElement(
            document,
            "option",
            "",
            `Variation #${variation.variationNumber} — ${completed ? "Payment complete" : "Canceled"}`,
          );
          option.value = String(variation.variationNumber);
          option.setAttribute("value", String(variation.variationNumber));
          return option;
        });

        elements.variationSelector.replaceChildren(...options);
        const selected = draftController.getSelectedVariation();
        elements.variationSelector.value = selected
          ? String(selected.variationNumber)
          : "";
      }

      function displayEditor(data) {
        editorData = data;
        draftController = createDraftController(data);
        inventoryExpanded = false;
        inventoryQuery = "";
        sizeSelectionByGroup.clear();
        elements.search.value = "";
        elements.reportName.textContent = formatDefaultReportName(data);
        document.title = `${formatDefaultReportName(data)} — Offline Report Editor`;
        renderVariationOptions();
        renderAll();
        elements.loading.hidden = true;
        elements.loading.setAttribute("aria-busy", "false");
        elements.error.hidden = true;
        elements.content.hidden = false;

        if (data.eligibility.status === "editable") {
          setStatus("Report loaded. Mapping changes remain drafts until saved.");
        } else {
          setStatus(data.eligibility.reason, true);
        }

        elements.content.focus();
      }

      async function load() {
        const sequence = ++loadSequence;
        reportId = getRequestedReportId(location, protocol);
        elements.loading.hidden = false;
        elements.loading.setAttribute("aria-busy", "true");
        elements.error.hidden = true;
        elements.content.hidden = true;

        if (reportId === null) {
          showError(
            "Open the Offline Report Editor from a saved report with a valid report ID.",
          );
          return;
        }

        try {
          const response = await client.loadEditorData({ reportId });

          if (destroyed || sequence !== loadSequence) {
            return;
          }

          if (response?.reportId !== reportId) {
            throw new Error("The Offline Report Editor returned a different report.");
          }

          displayEditor(response);
        } catch (error) {
          if (destroyed || sequence !== loadSequence) {
            return;
          }

          showError(
            error?.message ??
              "The saved report could not be opened. Nothing was changed.",
          );
        }
      }

      async function save() {
        if (
          saving ||
          !draftController ||
          !hasUnsavedChanges() ||
          editorData?.eligibility?.status !== "editable"
        ) {
          return;
        }

        const changes = draftController.getChanges();
        const count = changes.length;
        const confirmation =
          `Save ${count} corrected mapping ${count === 1 ? "change" : "changes"} to this report? This updates only the selected saved report and its inventory handoff.`;

        if (dependencies.confirm(confirmation) !== true) {
          return;
        }

        const sequence = ++saveSequence;
        saving = true;
        setStatus("Saving the corrected report...");
        setBusyState();

        try {
          const response = await client.saveMappingCorrections({
            reportId,
            changes,
          });

          if (destroyed || sequence !== saveSequence) {
            return;
          }

          if (response?.reportId !== reportId) {
            throw new Error("The saved correction returned a different report.");
          }

          draftController.clear();
          setStatus("Corrected report saved. Returning to the report...");
          destroy();
          dependencies.navigate(createReportReturnUrl(reportId));
        } catch (error) {
          if (destroyed || sequence !== saveSequence) {
            return;
          }

          setStatus(
            error?.message ??
              "The corrected report could not be saved. Your drafts were kept.",
            true,
          );
        } finally {
          if (!destroyed && sequence === saveSequence) {
            saving = false;
            renderDraftActions();
          }
        }
      }

      function cancel() {
        if (saving || reportId === null) {
          return;
        }

        if (
          hasUnsavedChanges() &&
          dependencies.confirm(
            "Discard every unsaved mapping change and return to the report?",
          ) !== true
        ) {
          return;
        }

        draftController?.clear();
        destroy();
        dependencies.navigate(createReportReturnUrl(reportId));
      }

      function handleBeforeUnload(event) {
        if (!hasUnsavedChanges()) {
          return;
        }

        event.preventDefault();
        event.returnValue = "";
      }

      function destroy() {
        if (destroyed) {
          return;
        }

        destroyed = true;
        loadSequence += 1;
        saveSequence += 1;
        dependencies.removeEventListener("beforeunload", handleBeforeUnload);
      }

      elements.retry.addEventListener("click", load);
      elements.variationSelector.addEventListener("change", (event) => {
        try {
          draftController.selectVariation(Number(event.currentTarget.value));
          renderAll();
          setStatus("Selected variation changed. Existing drafts were kept.");
        } catch (error) {
          setStatus(error?.message ?? "That variation is unavailable.", true);
        }
      });
      elements.search.addEventListener("input", (event) => {
        inventoryQuery = event.currentTarget.value;
        renderInventory();
      });
      elements.listToggle.addEventListener("click", () => {
        inventoryExpanded = !inventoryExpanded;
        renderInventory();
      });
      elements.save.addEventListener("click", save);
      elements.cancel.addEventListener("click", cancel);
      dependencies.addEventListener("beforeunload", handleBeforeUnload);

      load();
      return Object.freeze({
        cancel,
        destroy,
        load,
        save,
        getState() {
          return {
            reportId,
            selectedVariationNumber:
              draftController?.getSelectedVariation()?.variationNumber ?? null,
            selectedSku: draftController?.getSelectedSku() ?? null,
            changeCount: draftController?.getChangeCount() ?? 0,
            expanded: inventoryExpanded,
            query: inventoryQuery,
            saving,
          };
        },
      });
    }

    return Object.freeze({
      COLLAPSED_INVENTORY_ITEM_LIMIT,
      createDraftController,
      createDraftPreview,
      createReportReturnUrl,
      filterInventoryGroups,
      formatUsdCents,
      getRequestedReportId,
      groupInventoryEntries,
      mountOfflineEditorPage,
      normalizeSearchText,
      prepareInventoryGroups,
      prioritizeMappedGroup,
    });
  },
);
