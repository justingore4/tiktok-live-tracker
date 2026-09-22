(function initializeInlineReportCorrection(root, factory) {
  const inlineReportCorrection = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = inlineReportCorrection;
  }

  root.TikTokLiveTrackerInlineReportCorrection = inlineReportCorrection;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createInlineReportCorrectionModule() {
    "use strict";

    const UNMAPPED_GROUP_VALUE = "__unmapped__";
    const sizeCollator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });

    function normalizeGroupText(value) {
      return String(value ?? "")
        .normalize("NFC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase("en-US");
    }

    function compareInventoryEntries(left, right) {
      const sizeComparison = sizeCollator.compare(
        String(left?.size ?? ""),
        String(right?.size ?? ""),
      );

      return sizeComparison !== 0
        ? sizeComparison
        : sizeCollator.compare(String(left?.sku ?? ""), String(right?.sku ?? ""));
    }

    function groupInventoryEntries(entries) {
      if (!Array.isArray(entries)) {
        throw new TypeError("Inventory entries must be an array.");
      }

      const groupsByKey = new Map();

      entries.forEach((entry) => {
        const key = JSON.stringify([
          normalizeGroupText(entry?.item),
          normalizeGroupText(entry?.style),
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

    function formatUsdCents(value) {
      if (!Number.isSafeInteger(value)) {
        return "—";
      }

      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
      }).format(value / 100);
    }

    function getVariations(data) {
      return [
        ...(data?.completedVariations ?? []),
        ...(data?.canceledVariations ?? []),
      ].sort((left, right) => left.variationNumber - right.variationNumber);
    }

    function findInventoryEntry(data, sku) {
      if (typeof sku !== "string") {
        return null;
      }

      return data?.inventory.find((entry) => entry.sku === sku) ?? null;
    }

    function describeMapping(data, sku) {
      if (sku === null) {
        return "Unmapped";
      }

      if (sku === undefined) {
        return "Choose an exact size / SKU";
      }

      const entry = findInventoryEntry(data, sku);

      if (!entry) {
        return "Unavailable mapping";
      }

      return [entry.item, entry.style, entry.size, entry.sku]
        .filter((value) => value !== "")
        .join(" — ");
    }

    function formatVariationOption(data, variation) {
      const completed = variation.expectedStatus === "payment_complete";
      const parts = [
        `Variation #${variation.variationNumber}`,
        completed ? "Payment complete" : "Canceled",
      ];

      if (completed) {
        parts.push(formatUsdCents(variation.soldPriceCents));
      }

      parts.push(describeMapping(data, variation.expectedSku));
      return parts.join(" — ");
    }

    function formatGroupLabel(group) {
      const identity = [group.item, group.style]
        .filter((value) => value !== "")
        .join(" — ");

      if (group.entries.length === 1) {
        const entry = group.entries[0];
        const size = entry.size === "" ? "No size" : `Size ${entry.size}`;
        return `${identity} — ${size} — SKU ${entry.sku}`;
      }

      return `${identity} — ${group.entries.length} sizes / SKUs`;
    }

    function formatSkuLabel(entry) {
      const size = entry.size === "" ? "No size" : `Size ${entry.size}`;
      return `${size} — SKU ${entry.sku}`;
    }

    function createOption(document, value, text, options = {}) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.disabled = options.disabled === true;
      option.setAttribute("value", value);
      return option;
    }

    function getRequiredElements(document) {
      const selectors = {
        section: "#mapping-correction-section",
        fields: "#mapping-correction-fields",
        availability: "#mapping-correction-availability",
        variation: "#mapping-variation",
        itemGroup: "#mapping-item-group",
        skuField: "#mapping-sku-field",
        sku: "#mapping-sku",
        status: "#mapping-variation-status",
        soldPrice: "#mapping-sold-price",
        original: "#mapping-original",
        selected: "#mapping-selected",
        reset: "#reset-mapping-original",
        feedback: "#mapping-correction-feedback",
        save: "#save-mapping-correction",
      };
      const elements = Object.fromEntries(
        Object.entries(selectors).map(([key, selector]) => [
          key,
          document.querySelector(selector),
        ]),
      );

      if (Object.values(elements).some((element) => !element)) {
        throw new TypeError("The inline report correction DOM is incomplete.");
      }

      return elements;
    }

    function validateEditorData(data, reportId) {
      if (
        !data ||
        typeof data !== "object" ||
        data.reportId !== reportId ||
        !data.eligibility ||
        !["editable", "blocked", "read_only"].includes(
          data.eligibility.status,
        ) ||
        !Array.isArray(data.completedVariations) ||
        !Array.isArray(data.canceledVariations) ||
        !Array.isArray(data.inventory)
      ) {
        throw new Error("The correction service returned different report data.");
      }

      return data;
    }

    function createInlineReportCorrectionController(options) {
      if (
        !options ||
        typeof options !== "object" ||
        !options.document ||
        typeof options.document.querySelector !== "function" ||
        typeof options.document.createElement !== "function" ||
        typeof options.onSaved !== "function"
      ) {
        throw new TypeError("Inline report correction dependencies are unavailable.");
      }

      const document = options.document;
      const client = options.client ?? null;
      const announceGlobal = typeof options.onStatus === "function"
        ? options.onStatus
        : () => undefined;
      const elements = getRequiredElements(document);
      let reportId = null;
      let editorData = null;
      let variations = [];
      let groups = [];
      let originalMappings = new Map();
      let originalMappingsReportId = null;
      let selectedVariationNumber = null;
      let selectedGroupKey = UNMAPPED_GROUP_VALUE;
      let selectedSku = null;
      let busy = false;
      let loading = false;
      let externalBusy = false;
      let reportedControlState = null;
      let unavailableReason = null;
      let loadSequence = 0;
      let saveSequence = 0;
      let destroyed = false;

      function currentVariation() {
        return variations.find(
          (variation) =>
            variation.variationNumber === selectedVariationNumber,
        ) ?? null;
      }

      function currentGroup() {
        return groups.find((group) => group.key === selectedGroupKey) ?? null;
      }

      function currentOriginalSku() {
        const variation = currentVariation();

        if (
          !variation ||
          !originalMappings.has(variation.variationNumber)
        ) {
          return undefined;
        }

        return originalMappings.get(variation.variationNumber);
      }

      function setFeedback(message, isError = false) {
        elements.feedback.textContent = message;
        elements.feedback.className = isError
          ? "mapping-correction-feedback visually-hidden is-error"
          : "mapping-correction-feedback visually-hidden";
      }

      function announce(message) {
        try {
          announceGlobal(message);
        } catch (_error) {
          // A report-level announcement cannot change correction state.
        }
      }

      function eligibilityReason() {
        if (unavailableReason !== null) {
          return unavailableReason;
        }

        return editorData?.eligibility?.status === "editable"
          ? null
          : editorData?.eligibility?.reason ??
              "Mapping correction is unavailable for this report.";
      }

      function canSave() {
        const variation = currentVariation();
        const validTarget = selectedSku === null ||
          findInventoryEntry(editorData, selectedSku) !== null;

        return !destroyed &&
          !busy &&
          !externalBusy &&
          !loading &&
          editorData?.eligibility?.status === "editable" &&
          variation !== null &&
          selectedSku !== undefined &&
          validTarget &&
          selectedSku !== variation.expectedSku;
      }

      function canResetSelection() {
        const variation = currentVariation();
        const originalSku = currentOriginalSku();

        return !destroyed &&
          !busy &&
          !externalBusy &&
          !loading &&
          editorData?.eligibility?.status === "editable" &&
          variation !== null &&
          typeof originalSku === "string" &&
          findInventoryEntry(editorData, originalSku) !== null &&
          selectedSku !== undefined &&
          (
            variation.expectedSku !== originalSku ||
            selectedSku !== originalSku
          );
      }

      function saveUnavailableReason() {
        const variation = currentVariation();

        if (externalBusy) return "Wait for quantity copying to finish.";

        if (busy) {
          return "Saving the mapping correction.";
        }

        if (loading) {
          return "Checking mapping-correction availability.";
        }

        const reason = eligibilityReason();

        if (reason !== null) {
          return reason;
        }

        if (!variation) {
          return "Choose a saved variation.";
        }

        if (selectedSku === undefined) {
          return "Choose an exact size and SKU.";
        }

        if (
          selectedSku !== null &&
          findInventoryEntry(editorData, selectedSku) === null
        ) {
          return "Choose an exact SKU from this report inventory.";
        }

        if (selectedSku === variation.expectedSku) {
          return "";
        }

        return "";
      }

      function renderAvailability() {
        const reason = eligibilityReason();

        if (loading) {
          elements.availability.hidden = false;
          elements.availability.textContent = "Checking availability…";
          elements.availability.dataset.state = "loading";
          return;
        }

        if (reason !== null) {
          elements.availability.hidden = false;
          elements.availability.textContent = reason;
          elements.availability.dataset.state = unavailableReason !== null
            ? "unavailable"
            : editorData?.eligibility?.status ?? "unavailable";
          return;
        }

        elements.availability.hidden = true;
        elements.availability.textContent = "";
        elements.availability.dataset.state = "editable";
      }

      function renderControlState() {
        const reason = eligibilityReason();
        const editable = reason === null &&
          editorData?.eligibility?.status === "editable";
        const unavailable = busy || externalBusy || loading || !editable;
        const group = currentGroup();

        elements.section.setAttribute("aria-busy", String(busy || externalBusy || loading));
        elements.fields.disabled = unavailable;
        elements.variation.disabled = unavailable || variations.length === 0;
        elements.itemGroup.disabled = unavailable || currentVariation() === null;
        elements.sku.disabled = unavailable ||
          group === null ||
          group.entries.length < 2;
        elements.save.disabled = !canSave();
        elements.reset.disabled = !canResetSelection();

        const controlTitle = busy
          ? "Saving the mapping correction."
          : loading
            ? "Checking mapping-correction availability."
            : reason ?? "";
        [elements.variation, elements.itemGroup, elements.sku]
          .forEach((control) => {
            control.title = controlTitle;
          });
        elements.save.title = saveUnavailableReason();
        const controlState = `${reportId}:${busy}:${loading}`;
        if (reportedControlState !== controlState) {
          reportedControlState = controlState;
          if (typeof options.onStateChange === "function") {
            options.onStateChange({ reportId, busy, loading });
          }
        }
      }

      function renderVariationOptions() {
        const options = variations.map((variation) =>
          createOption(
            document,
            String(variation.variationNumber),
            formatVariationOption(editorData, variation),
          ));

        if (options.length === 0) {
          options.push(createOption(document, "", "No editable variations", {
            disabled: true,
          }));
        }

        elements.variation.replaceChildren(...options);
        elements.variation.value = currentVariation()
          ? String(selectedVariationNumber)
          : "";
      }

      function renderSkuOptions() {
        const group = currentGroup();

        if (!group || group.entries.length < 2) {
          elements.skuField.hidden = true;
          elements.sku.replaceChildren();
          elements.sku.value = "";
          return;
        }

        const options = [
          createOption(document, "", "Choose exact size / SKU", {
            disabled: true,
          }),
          ...group.entries.map((entry) =>
            createOption(document, entry.sku, formatSkuLabel(entry))),
        ];
        elements.skuField.hidden = false;
        elements.sku.replaceChildren(...options);
        elements.sku.value = typeof selectedSku === "string"
          ? selectedSku
          : "";
      }

      function renderItemGroups() {
        const options = [
          createOption(document, UNMAPPED_GROUP_VALUE, "Unmapped"),
          ...groups.map((group) =>
            createOption(document, group.key, formatGroupLabel(group))),
        ];

        elements.itemGroup.replaceChildren(...options);
        elements.itemGroup.value = selectedGroupKey;
        renderSkuOptions();
      }

      function renderFacts() {
        const variation = currentVariation();

        if (!variation) {
          elements.status.textContent = "—";
          elements.soldPrice.textContent = "—";
          elements.original.textContent = "Unmapped";
          elements.selected.textContent = "Unmapped";
          return;
        }

        const completed = variation.expectedStatus === "payment_complete";
        elements.status.textContent = completed
          ? "Payment complete"
          : "Canceled — Reference only";
        elements.soldPrice.textContent = completed
          ? formatUsdCents(variation.soldPriceCents)
          : "Not applicable";
        elements.original.textContent = describeMapping(
          editorData,
          originalMappings.get(variation.variationNumber) ?? null,
        );
        elements.selected.textContent = describeMapping(editorData, selectedSku);
      }

      function renderAll() {
        renderAvailability();
        renderVariationOptions();
        renderItemGroups();
        renderFacts();
        renderControlState();
      }

      function initializeSelection(variation) {
        if (!variation) {
          selectedVariationNumber = null;
          selectedGroupKey = UNMAPPED_GROUP_VALUE;
          selectedSku = null;
          return;
        }

        selectedVariationNumber = variation.variationNumber;
        selectedSku = variation.expectedSku;
        const group = groups.find((candidate) =>
          candidate.entries.some((entry) => entry.sku === selectedSku));
        selectedGroupKey = group?.key ?? UNMAPPED_GROUP_VALUE;
      }

      function canPreserveTarget(target) {
        return target === null ||
          target === undefined ||
          findInventoryEntry(editorData, target) !== null;
      }

      function applyEditorData(nextData, optionsValue = {}) {
        const previousVariation = currentVariation();
        const previousVariationNumber = selectedVariationNumber;
        const previousExpectedSku = previousVariation?.expectedSku;
        const previousSelectedSku = selectedSku;
        const previousGroupKey = selectedGroupKey;
        const previousDataReportId = editorData?.reportId ?? null;
        const changedReport = previousDataReportId !== nextData.reportId;

        if (originalMappingsReportId !== nextData.reportId) {
          originalMappings = new Map();
          originalMappingsReportId = nextData.reportId;
        }

        reportId = nextData.reportId;
        editorData = nextData;
        variations = getVariations(editorData);
        groups = groupInventoryEntries(editorData.inventory);
        variations.forEach((variation) => {
          if (!originalMappings.has(variation.variationNumber)) {
            originalMappings.set(
              variation.variationNumber,
              variation.expectedSku,
            );
          }
        });

        const preferredVariationNumber =
          optionsValue.preferredVariationNumber ??
          (changedReport ? null : previousVariationNumber);
        const preferredVariation = variations.find(
          (variation) =>
            variation.variationNumber === preferredVariationNumber,
        ) ?? variations[0] ?? null;
        initializeSelection(preferredVariation);

        const preserveDraft = !changedReport &&
          optionsValue.preserveDraft === true &&
          previousVariationNumber === preferredVariation?.variationNumber &&
          previousExpectedSku === preferredVariation?.expectedSku &&
          canPreserveTarget(previousSelectedSku);

        if (preserveDraft) {
          selectedSku = previousSelectedSku;
          const targetGroup = typeof previousSelectedSku === "string"
            ? groups.find((group) => group.entries.some(
                (entry) => entry.sku === previousSelectedSku,
              ))
            : null;
          selectedGroupKey = targetGroup?.key ??
            (
              previousSelectedSku === undefined &&
              groups.some((group) => group.key === previousGroupKey)
                ? previousGroupKey
                : UNMAPPED_GROUP_VALUE
            );
        }

        unavailableReason = null;
        loading = false;
        elements.section.hidden = false;
        renderAll();
      }

      function announceSelection() {
        setFeedback("");
      }

      function handleVariationChange(event) {
        if (
          destroyed ||
          busy || externalBusy ||
          editorData?.eligibility?.status !== "editable"
        ) {
          return;
        }

        const variationNumber = Number(event.currentTarget.value);
        const variation = variations.find(
          (candidate) => candidate.variationNumber === variationNumber,
        );

        if (!variation) {
          setFeedback("That variation is unavailable.", true);
          return;
        }

        initializeSelection(variation);
        renderItemGroups();
        renderFacts();
        renderControlState();
        setFeedback("");
      }

      function handleItemGroupChange(event) {
        if (
          destroyed ||
          busy || externalBusy ||
          editorData?.eligibility?.status !== "editable"
        ) {
          return;
        }

        selectedGroupKey = event.currentTarget.value;

        if (selectedGroupKey === UNMAPPED_GROUP_VALUE) {
          selectedSku = null;
        } else {
          const group = currentGroup();
          selectedSku = group?.entries.length === 1
            ? group.entries[0].sku
            : undefined;
        }

        renderSkuOptions();
        renderFacts();
        renderControlState();
        announceSelection();
      }

      function handleSkuChange(event) {
        if (
          destroyed ||
          busy || externalBusy ||
          editorData?.eligibility?.status !== "editable"
        ) {
          return;
        }

        const group = currentGroup();
        const sku = event.currentTarget.value;
        selectedSku = group?.entries.some((entry) => entry.sku === sku)
          ? sku
          : undefined;
        renderFacts();
        renderControlState();
        announceSelection();
      }

      async function handleResetOriginal() {
        if (!canResetSelection()) {
          return;
        }

        const variation = currentVariation();
        const originalSku = currentOriginalSku();
        const group = groups.find((candidate) =>
          candidate.entries.some((entry) => entry.sku === originalSku));

        if (!variation || !group) {
          return;
        }

        const requiresDurableReset = variation.expectedSku !== originalSku;
        selectedGroupKey = group.key;
        selectedSku = originalSku;
        renderItemGroups();
        renderFacts();
        renderControlState();
        setFeedback("");

        if (requiresDurableReset) {
          await persistSelectedMapping();
        }
      }

      async function load(nextReportId, optionsValue = {}) {
        if (destroyed) {
          return;
        }

        const sequence = ++loadSequence;
        const changedReport = editorData?.reportId !== nextReportId;

        saveSequence += 1;
        busy = false;
        loading = true;
        unavailableReason = null;
        reportId = nextReportId;

        if (changedReport) {
          editorData = null;
          variations = [];
          groups = [];
          originalMappings = new Map();
          originalMappingsReportId = null;
          initializeSelection(null);
        }

        elements.section.hidden = false;
        renderAll();

        if (
          !client ||
          typeof client.loadEditorData !== "function" ||
          typeof client.saveMappingCorrections !== "function"
        ) {
          loading = false;
          unavailableReason =
            "Mapping correction is unavailable. Reload the extension and try again.";
          renderAvailability();
          renderControlState();
          setFeedback(unavailableReason, true);
          return;
        }

        try {
          const response = validateEditorData(
            await client.loadEditorData({ reportId: nextReportId }),
            nextReportId,
          );

          if (destroyed || sequence !== loadSequence) {
            return;
          }

          applyEditorData(response, {
            preserveDraft: optionsValue.preserveDraft === true,
          });
          const reason = eligibilityReason();
          setFeedback(reason ?? "", reason !== null);
        } catch (error) {
          if (destroyed || sequence !== loadSequence) {
            return;
          }

          loading = false;
          unavailableReason = error?.message ??
            "Mapping correction data could not be loaded.";
          renderAvailability();
          renderControlState();
          setFeedback(unavailableReason, true);
        }
      }

      async function persistSelectedMapping() {
        if (destroyed || !canSave()) {
          return;
        }

        const variation = currentVariation();
        const targetSku = selectedSku;
        const sequence = ++saveSequence;
        const savedReportId = reportId;
        const change = {
          variationNumber: variation.variationNumber,
          expectedStatus: variation.expectedStatus,
          expectedSku: variation.expectedSku,
          sku: targetSku,
        };
        let savedData = null;
        let saveConfirmed = false;
        busy = true;
        setFeedback(`Saving variation #${variation.variationNumber}...`);
        renderControlState();

        try {
          savedData = validateEditorData(
            await client.saveMappingCorrections({
              reportId: savedReportId,
              changes: [change],
            }),
            savedReportId,
          );
          saveConfirmed = true;

          if (destroyed || sequence !== saveSequence) {
            return;
          }

          const savedVariation = getVariations(savedData).find(
            (candidate) =>
              candidate.variationNumber === change.variationNumber,
          );

          if (
            !savedVariation ||
            savedVariation.expectedStatus !== change.expectedStatus ||
            savedVariation.expectedSku !== change.sku
          ) {
            throw new Error("The saved correction returned different mapping data.");
          }

          applyEditorData(savedData, {
            preferredVariationNumber: change.variationNumber,
          });
          busy = true;
          setFeedback(
            `Variation #${change.variationNumber} was saved. Refreshing the report...`,
          );
          renderControlState();

          try {
            await options.onSaved({
              reportId: savedReportId,
              editorData: savedData,
              variationNumber: change.variationNumber,
              expectedStatus: change.expectedStatus,
              previousSku: change.expectedSku,
              sku: change.sku,
            });
          } catch (error) {
            if (destroyed || sequence !== saveSequence) {
              return;
            }

            const message =
              `Variation #${change.variationNumber} was saved, but the report ` +
              "could not refresh. Reload the report to display its updated totals.";
            setFeedback(message, true);
            announce(message);
            return;
          }

          if (destroyed || sequence !== saveSequence) {
            return;
          }

          const action = change.sku === null ? "unmapped" : `mapped to ${change.sku}`;
          const suffix = change.expectedStatus === "canceled"
            ? " The reference changed; inventory and metrics were unchanged."
            : " Inventory, metrics, and the Google Sheets handoff were updated.";
          const message =
            `Variation #${change.variationNumber} was ${action}.${suffix}`;
          setFeedback(message);
          announce(message);
        } catch (error) {
          if (destroyed || sequence !== saveSequence) {
            return;
          }

          const message = saveConfirmed
            ? `Variation #${change.variationNumber} was saved, but the report ` +
              "could not refresh. Reload the report to display its updated totals."
            : error?.message ??
              "The mapping correction could not be saved. Your selection was kept.";
          setFeedback(message, true);
          announce(message);
        } finally {
          if (!destroyed && sequence === saveSequence) {
            busy = false;
            renderControlState();
          }
        }
      }

      async function save() {
        await persistSelectedMapping();
      }

      function destroy() {
        if (destroyed) {
          return;
        }

        destroyed = true;
        loadSequence += 1;
        saveSequence += 1;
        busy = false;
        loading = false;
        unavailableReason =
          "Mapping correction is unavailable because this report view was closed.";
        renderAvailability();
        renderControlState();
        setFeedback(unavailableReason, true);
      }

      elements.variation.addEventListener("change", handleVariationChange);
      elements.itemGroup.addEventListener("change", handleItemGroupChange);
      elements.sku.addEventListener("change", handleSkuChange);
      elements.reset.addEventListener("click", handleResetOriginal);
      elements.save.addEventListener("click", save);

      return Object.freeze({
        destroy,
        load,
        save,
        setExternalBusy(value) {
          externalBusy = value === true;
          renderControlState();
        },
        getState() {
          return {
            reportId,
            selectedVariationNumber,
            selectedSku,
            busy,
            loading,
            eligibilityStatus:
              destroyed
                ? "unavailable"
                : editorData?.eligibility?.status ?? "unavailable",
          };
        },
      });
    }

    return Object.freeze({
      UNMAPPED_GROUP_VALUE,
      createInlineReportCorrectionController,
      describeMapping,
      formatVariationOption,
      groupInventoryEntries,
    });
  },
);
