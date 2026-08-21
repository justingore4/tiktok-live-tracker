(function initializeMappingWorkflow(root, factory) {
  const workflow = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = workflow;
  }

  root.TikTokLiveTrackerMappingWorkflow = workflow;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createMappingWorkflowModule() {
    "use strict";

    const REQUIRED_RECONCILIATION_METHODS = [
      "calculateSummary",
      "createReconciliationState",
      "getAuction",
      "mapVariation",
      "unmapVariation",
    ];
    const STATUS_LABELS = Object.freeze({
      canceled: "Canceled",
      committed: "Payment complete",
      mapped: "Item selected",
      pending: "Waiting for payment",
      unmapped: "Not tagged",
      unmapped_completed: "Payment complete - item needed",
    });
    const OBSERVED_PAYMENT_STATUS_LABELS = Object.freeze({
      not_observed: "Payment not yet observed",
      payment_processing: "Payment processing",
      payment_fixing: "Payment fixing",
      payment_failed: "Payment failed",
      canceled: "Canceled",
      payment_complete: "Payment complete",
      unrecognized: "Unrecognized payment status",
    });
    const PAYMENT_STATUS_UNAVAILABLE_LABEL = "Payment status unavailable";

    function getObservedPaymentStatusLabel(value) {
      return (
        OBSERVED_PAYMENT_STATUS_LABELS[value] ??
        PAYMENT_STATUS_UNAVAILABLE_LABEL
      );
    }

    function requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${fieldName} must be a non-empty string.`);
      }

      return value.trim();
    }

    function requirePositiveInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${fieldName} must be a positive safe integer.`);
      }

      return value;
    }

    function validateReconciliation(reconciliation) {
      const valid =
        reconciliation &&
        REQUIRED_RECONCILIATION_METHODS.every(
          (methodName) => typeof reconciliation[methodName] === "function",
        );

      if (!valid) {
        throw new TypeError("A valid reconciliation module is required.");
      }

      return reconciliation;
    }

    function normalizeDisplayEntry(entry) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("Every display inventory entry must be an object.");
      }

      const item = requireNonEmptyString(entry.item, "inventory item");
      const style = String(entry.style ?? "").trim();

      return {
        ...entry,
        sku: requireNonEmptyString(entry.sku, "inventory SKU"),
        item,
        style,
        size: requireNonEmptyString(String(entry.size ?? ""), "inventory size"),
      };
    }

    function toReconciliationInventory(entry) {
      return {
        sku: entry.sku,
        name: entry.style ? `${entry.item} - ${entry.style}` : entry.item,
        size: entry.size,
        quantityReceived: entry.quantityReceived,
        unitCostCents: entry.unitCostCents,
      };
    }

    function getActiveBiddingVariationNumber(summary) {
      return Number.isSafeInteger(summary?.activeBiddingVariationNumber) &&
        summary.activeBiddingVariationNumber > 0
        ? summary.activeBiddingVariationNumber
        : null;
    }

    function createMappingSession(options) {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Mapping session options are required.");
      }

      if (!Array.isArray(options.inventory)) {
        throw new TypeError("Mapping session inventory must be an array.");
      }

      if (options.state === null) {
        throw new TypeError(
          "Mapping session state must be omitted or be a reconciliation state.",
        );
      }

      const reconciliation = validateReconciliation(options.reconciliation);
      const streamId = requireNonEmptyString(options.streamId, "streamId");
      const currentVariationNumber = requirePositiveInteger(
        options.variationNumber,
        "variationNumber",
      );
      const configuredVariationNumbers = options.variationNumbers === undefined
        ? [currentVariationNumber]
        : options.variationNumbers;

      if (!Array.isArray(configuredVariationNumbers)) {
        throw new TypeError("variationNumbers must be an array when provided.");
      }

      const normalizedVariationNumbers = configuredVariationNumbers.map(
        (value, index) => requirePositiveInteger(
          value,
          `variationNumbers[${index}]`,
        ),
      );

      if (new Set(normalizedVariationNumbers).size !== normalizedVariationNumbers.length) {
        throw new TypeError("variationNumbers cannot contain duplicates.");
      }

      if (!normalizedVariationNumbers.includes(currentVariationNumber)) {
        throw new TypeError("variationNumbers must include the current variationNumber.");
      }
      const inventory = options.inventory.map(normalizeDisplayEntry);
      const displaySkus = new Set();

      inventory.forEach((entry) => {
        if (displaySkus.has(entry.sku)) {
          throw new TypeError(`Display inventory contains duplicate SKU ${entry.sku}.`);
        }

        displaySkus.add(entry.sku);
      });

      let state =
        options.state ??
        reconciliation.createReconciliationState(
          inventory.map(toReconciliationInventory),
        );
      const initialSummary = reconciliation.calculateSummary(state, {
        streamId,
      });
      const initialActiveBiddingVariationNumber =
        getActiveBiddingVariationNumber(initialSummary);
      const persistedVariationNumbers = state.streams
        ?.find((stream) => stream.streamId === streamId)
        ?.variations.map((auction) => auction.variationNumber) ?? [];
      const knownVariationNumbers = Object.freeze(
        [...new Set([
          ...normalizedVariationNumbers,
          ...persistedVariationNumbers,
          ...(initialActiveBiddingVariationNumber === null
            ? []
            : [initialActiveBiddingVariationNumber]),
        ])].sort((left, right) => right - left),
      );
      let selectedVariationNumber =
        initialActiveBiddingVariationNumber ?? currentVariationNumber;
      const canonicalSkus = new Set(
        initialSummary.inventory.map((entry) => entry.sku),
      );

      inventory.forEach((entry) => {
        if (!canonicalSkus.has(entry.sku)) {
          throw new TypeError(
            `Display inventory SKU ${entry.sku} is missing from reconciliation state.`,
          );
        }
      });

      function auctionKey(extra = {}, variationNumber = selectedVariationNumber) {
        return {
          streamId,
          variationNumber,
          ...extra,
        };
      }

      function findDisplayEntry(sku) {
        return inventory.find((entry) => entry.sku === sku) ?? null;
      }

      function getAuctionDisplay(
        summary,
        variationNumber = selectedVariationNumber,
      ) {
        const auction = reconciliation.getAuction(
          state,
          auctionKey({}, variationNumber),
        );

        if (!auction) {
          return null;
        }

        const displayEntry = auction.sku
          ? findDisplayEntry(auction.sku)
          : null;
        const canonicalEntry = auction.sku
          ? summary.inventory.find((entry) => entry.sku === auction.sku) ?? null
          : null;

        return {
          ...auction,
          item: displayEntry?.item ?? canonicalEntry?.name ?? null,
          style: displayEntry?.style ?? "",
          size: displayEntry?.size ?? canonicalEntry?.size ?? "",
          inventory: canonicalEntry ? { ...canonicalEntry } : null,
          observedPaymentStatusLabel: getObservedPaymentStatusLabel(
            auction.observedPaymentStatus,
          ),
          statusLabel: STATUS_LABELS[auction.status] ?? auction.status,
        };
      }

      function getVariationOptions(summary) {
        const activeBiddingVariationNumber =
          getActiveBiddingVariationNumber(summary);
        const effectiveCurrentVariationNumber =
          activeBiddingVariationNumber ?? currentVariationNumber;

        return knownVariationNumbers.map((variationNumber) => {
          const auction = getAuctionDisplay(summary, variationNumber);

          return {
            variationNumber,
            recorded: auction !== null,
            bidding: variationNumber === activeBiddingVariationNumber,
            current: variationNumber === effectiveCurrentVariationNumber,
            selected: variationNumber === selectedVariationNumber,
            status: auction?.status ?? "unmapped",
            statusLabel: auction?.statusLabel ?? STATUS_LABELS.unmapped,
            observedPaymentStatus: auction?.observedPaymentStatus ?? null,
            observedPaymentStatusLabel:
              auction?.observedPaymentStatusLabel ??
              PAYMENT_STATUS_UNAVAILABLE_LABEL,
            soldPriceCents: auction?.soldPriceCents ?? null,
            conflicts: auction?.conflicts?.map((conflict) => ({
              ...conflict,
            })) ?? [],
            item: auction?.item ?? null,
            style: auction?.style ?? "",
            size: auction?.size ?? "",
          };
        });
      }

      function getInventoryEntries(
        summary = reconciliation.calculateSummary(state, { streamId }),
      ) {
        const summaryBySku = new Map(
          summary.inventory.map((entry) => [entry.sku, entry]),
        );
        const auction = reconciliation.getAuction(state, auctionKey());
        return inventory.map((displayEntry) => {
          const canonicalEntry = summaryBySku.get(displayEntry.sku);
          const selected = auction?.sku === displayEntry.sku;
          const selectionReason = selected ? "selected" : "available";

          return {
            ...displayEntry,
            ...canonicalEntry,
            selected,
            selectionAllowed: true,
            selectionReason,
          };
        });
      }

      function getViewState() {
        const summary = reconciliation.calculateSummary(state, { streamId });
        const activeBiddingVariationNumber =
          getActiveBiddingVariationNumber(summary);
        const effectiveCurrentVariationNumber =
          activeBiddingVariationNumber ?? currentVariationNumber;
        const auction = getAuctionDisplay(summary);
        return {
          streamId,
          variationNumber: selectedVariationNumber,
          activeBiddingVariationNumber,
          currentVariationNumber: effectiveCurrentVariationNumber,
          selectedVariationNumber,
          isReviewingHistory:
            selectedVariationNumber !== effectiveCurrentVariationNumber,
          variations: getVariationOptions(summary),
          auction,
          mapping: auction?.sku ? auction : null,
          inventory: getInventoryEntries(summary),
          totals: { ...summary.totals },
          warnings: summary.warnings.map((warning) => ({ ...warning })),
        };
      }

      function getCurrentMapping() {
        const summary = reconciliation.calculateSummary(state, { streamId });
        const effectiveCurrentVariationNumber =
          getActiveBiddingVariationNumber(summary) ?? currentVariationNumber;
        const auction = getAuctionDisplay(
          summary,
          effectiveCurrentVariationNumber,
        );

        return auction?.sku ? auction : null;
      }

      function getSelectedMapping() {
        return getViewState().mapping;
      }

      function selectVariation(value) {
        const variationNumber = Number(value);

        if (
          !Number.isSafeInteger(variationNumber) ||
          !knownVariationNumbers.includes(variationNumber)
        ) {
          return createRejectedResult(
            "UNKNOWN_VARIATION",
            "That variation is not available in this stream history.",
          );
        }

        if (variationNumber === selectedVariationNumber) {
          return createResult(true, "variation_unchanged");
        }

        selectedVariationNumber = variationNumber;
        return createResult(true, "variation_selected");
      }

      function createResult(ok, action, extra = {}) {
        const view = getViewState();

        return {
          ok,
          action,
          ...extra,
          mapping: view.mapping,
          view,
        };
      }

      function createRejectedResult(code, message) {
        return createResult(false, "rejected", { code, message });
      }

      function selectSku(value) {
        const sku = typeof value === "string" ? value.trim() : "";
        const entry = findDisplayEntry(sku);

        if (!entry) {
          return createRejectedResult(
            "UNKNOWN_SKU",
            "That inventory entry is not available in this session.",
          );
        }

        const previousAuction = reconciliation.getAuction(state, auctionKey());
        const sameSku = previousAuction?.sku === sku;

        if (sameSku) {
          reconciliation.unmapVariation(state, auctionKey());

          return createResult(true, "unmapped", {
            previousStatus: previousAuction.status,
            unmappedSku: sku,
          });
        }

        reconciliation.mapVariation(state, auctionKey({ sku }));

        let action = "mapped";

        if (
          previousAuction?.paymentStatus === "payment_complete" &&
          !previousAuction.sku
        ) {
          action = "completed_sale_mapped";
        } else if (previousAuction?.sku) {
          if (previousAuction.paymentStatus === "payment_complete") {
            action = "committed_mapping_corrected";
          } else {
            action = "remapped";
          }
        }

        return createResult(true, action);
      }

      function getStateSnapshot() {
        return JSON.parse(JSON.stringify(state));
      }

      return Object.freeze({
        streamId,
        variationNumber: currentVariationNumber,
        currentVariationNumber,
        getCurrentMapping,
        getInventoryEntries,
        getSelectedMapping,
        getStateSnapshot,
        getViewState,
        getVariationOptions: () => getViewState().variations,
        selectSku,
        selectVariation,
      });
    }

    return {
      createMappingSession,
      getObservedPaymentStatusLabel,
    };
  },
);
