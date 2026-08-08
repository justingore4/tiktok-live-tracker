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
      "getInventoryAvailability",
      "mapVariation",
      "markUnpaid",
      "recordPaymentComplete",
      "undoMarkUnpaid",
    ];
    const STATUS_LABELS = Object.freeze({
      committed: "Payment complete",
      marked_unpaid: "Marked unpaid",
      pending: "Waiting for payment",
      unmapped: "Not tagged",
      unmapped_completed: "Payment complete - item needed",
    });

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

    function cloneSerializableState(value) {
      return JSON.parse(JSON.stringify(value));
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
      const variationNumber = requirePositiveInteger(
        options.variationNumber,
        "variationNumber",
      );
      const inventory = options.inventory.map(normalizeDisplayEntry);
      const displaySkus = new Set();

      inventory.forEach((entry) => {
        if (displaySkus.has(entry.sku)) {
          throw new TypeError(`Display inventory contains duplicate SKU ${entry.sku}.`);
        }

        displaySkus.add(entry.sku);
      });

      const ownsState = options.state === undefined;
      // Supplied state may contain captured TikTok truth. Demo-only events and
      // rollback checkpoints are enabled solely for an isolated session state.
      const offlineSimulationEnabled =
        ownsState && options.offlineSimulation === true;
      let state =
        options.state ??
        reconciliation.createReconciliationState(
          inventory.map(toReconciliationInventory),
        );
      const initialSummary = reconciliation.calculateSummary(state);
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

      let paymentBufferExpired =
        reconciliation.getAuction(state, { streamId, variationNumber })
          ?.mappingStatus === "marked_unpaid";
      let simulatedPaymentCheckpoint = null;

      function auctionKey(extra = {}) {
        return {
          streamId,
          variationNumber,
          ...extra,
        };
      }

      function findDisplayEntry(sku) {
        return inventory.find((entry) => entry.sku === sku) ?? null;
      }

      function getAuctionDisplay(summary) {
        const auction = reconciliation.getAuction(state, auctionKey());

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
          statusLabel: STATUS_LABELS[auction.status] ?? auction.status,
        };
      }

      function getInventoryEntries(
        summary = reconciliation.calculateSummary(state, { streamId }),
      ) {
        const summaryBySku = new Map(
          summary.inventory.map((entry) => [entry.sku, entry]),
        );
        const auction = reconciliation.getAuction(state, auctionKey());
        const allowsHistoricalCorrection =
          auction?.paymentStatus === "payment_complete" ||
          auction?.mappingStatus === "marked_unpaid";

        return inventory.map((displayEntry) => {
          const canonicalEntry = summaryBySku.get(displayEntry.sku);
          const selected = auction?.sku === displayEntry.sku;
          const hasCapacity = canonicalEntry.availableToTagQuantity > 0;
          const selectionAllowed =
            selected || allowsHistoricalCorrection || hasCapacity;
          let selectionReason = "available";

          if (selected) {
            selectionReason = "selected";
          } else if (allowsHistoricalCorrection && !hasCapacity) {
            selectionReason = "correction_allowed";
          } else if (!hasCapacity) {
            selectionReason = canonicalEntry.remainingQuantity <= 0
              ? "sold_out"
              : "fully_reserved";
          }

          return {
            ...displayEntry,
            ...canonicalEntry,
            selected,
            selectionAllowed,
            selectionReason,
          };
        });
      }

      function getViewState() {
        const summary = reconciliation.calculateSummary(state, { streamId });
        const auction = getAuctionDisplay(summary);
        const isPending = auction?.status === "pending";
        const isMarkedUnpaid = auction?.status === "marked_unpaid";

        return {
          streamId,
          variationNumber,
          auction,
          mapping: auction?.sku ? auction : null,
          inventory: getInventoryEntries(summary),
          totals: { ...summary.totals },
          warnings: summary.warnings.map((warning) => ({ ...warning })),
          demo: {
            offlineSimulationEnabled,
            paymentBufferExpired,
          },
          controls: {
            canCompletePayment:
              offlineSimulationEnabled && (isPending || isMarkedUnpaid),
            canSimulateBufferExpiry:
              offlineSimulationEnabled &&
              isPending &&
              !paymentBufferExpired,
            canMarkUnpaid: isPending && paymentBufferExpired,
            canUndoSimulatedPayment:
              offlineSimulationEnabled &&
              simulatedPaymentCheckpoint !== null &&
              auction?.status === "committed",
            canUndoUnpaid: isMarkedUnpaid,
          },
        };
      }

      function getCurrentMapping() {
        return getViewState().mapping;
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
        const historicalCorrection =
          previousAuction?.paymentStatus === "payment_complete" ||
          previousAuction?.mappingStatus === "marked_unpaid";
        const availability = reconciliation.getInventoryAvailability(
          state,
          auctionKey({ sku }),
        );

        if (
          !sameSku &&
          !historicalCorrection &&
          availability.availableToTagQuantity <= 0
        ) {
          const soldOut = availability.remainingQuantity <= 0;

          return createRejectedResult(
            soldOut ? "SOLD_OUT" : "NO_STOCK_AVAILABLE",
            soldOut
              ? `${entry.item}${entry.style ? ` - ${entry.style}` : ""} is sold out.`
              : `${entry.item}${entry.style ? ` - ${entry.style}` : ""} is already reserved for pending auctions.`,
          );
        }

        reconciliation.mapVariation(state, auctionKey({ sku }));

        if (simulatedPaymentCheckpoint && !sameSku) {
          reconciliation.mapVariation(
            simulatedPaymentCheckpoint.state,
            auctionKey({ sku }),
          );
        }

        let action = "mapped";

        if (sameSku) {
          action = "unchanged";
        } else if (
          previousAuction?.paymentStatus === "payment_complete" &&
          !previousAuction.sku
        ) {
          action = "completed_sale_mapped";
        } else if (previousAuction?.sku) {
          if (previousAuction.paymentStatus === "payment_complete") {
            action = "committed_mapping_corrected";
          } else if (previousAuction.mappingStatus === "marked_unpaid") {
            action = "unpaid_mapping_corrected";
          } else {
            action = "remapped";
          }
        }

        return createResult(true, action);
      }

      function completePayment(soldPriceCents) {
        if (!offlineSimulationEnabled) {
          return createRejectedResult(
            "PAYMENT_SIMULATION_DISABLED",
            "Payment simulation is available only in the isolated offline demo.",
          );
        }

        if (!Number.isSafeInteger(soldPriceCents) || soldPriceCents < 1) {
          return createRejectedResult(
            "INVALID_SOLD_PRICE",
            "Enter a sold price greater than $0.00.",
          );
        }

        const previousAuction = reconciliation.getAuction(state, auctionKey());

        if (!previousAuction?.sku) {
          return createRejectedResult(
            "VARIATION_NOT_MAPPED",
            "Select an inventory entry before completing payment.",
          );
        }

        const nextCheckpoint =
          previousAuction.status === "pending"
            ? {
                state: cloneSerializableState(state),
                paymentBufferExpired,
              }
            : null;

        reconciliation.recordPaymentComplete(
          state,
          auctionKey({ soldPriceCents }),
        );

        if (nextCheckpoint) {
          simulatedPaymentCheckpoint = nextCheckpoint;
        }

        let action = "payment_completed";

        if (previousAuction.paymentStatus === "payment_complete") {
          action = previousAuction.soldPriceCents === soldPriceCents
            ? "payment_unchanged"
            : "payment_conflict";
        }

        return createResult(true, action);
      }

      function undoSimulatedPayment() {
        const auction = reconciliation.getAuction(state, auctionKey());

        if (
          !offlineSimulationEnabled ||
          !simulatedPaymentCheckpoint ||
          auction?.status !== "committed"
        ) {
          return createRejectedResult(
            "SIMULATED_PAYMENT_NOT_UNDOABLE",
            "Only a payment created by this offline demo can be undone.",
          );
        }

        state = cloneSerializableState(simulatedPaymentCheckpoint.state);
        paymentBufferExpired =
          simulatedPaymentCheckpoint.paymentBufferExpired;
        simulatedPaymentCheckpoint = null;

        return createResult(true, "simulated_payment_undone");
      }

      function simulatePaymentBufferExpired() {
        if (!offlineSimulationEnabled) {
          return createRejectedResult(
            "BUFFER_SIMULATION_DISABLED",
            "Payment-buffer simulation is available only in the isolated offline demo.",
          );
        }

        const auction = reconciliation.getAuction(state, auctionKey());

        if (!auction?.sku || auction.status !== "pending") {
          return createRejectedResult(
            "PAYMENT_NOT_PENDING",
            "Only a mapped auction waiting for payment can expire its buffer.",
          );
        }

        if (paymentBufferExpired) {
          return createResult(true, "payment_buffer_unchanged");
        }

        paymentBufferExpired = true;
        return createResult(true, "payment_buffer_expired");
      }

      function markCurrentUnpaid() {
        const auction = reconciliation.getAuction(state, auctionKey());

        if (!auction?.sku) {
          return createRejectedResult(
            "VARIATION_NOT_MAPPED",
            "Select an inventory entry before marking unpaid.",
          );
        }

        if (auction.paymentStatus === "payment_complete") {
          return createRejectedResult(
            "PAYMENT_ALREADY_COMPLETE",
            "A completed TikTok payment cannot be marked unpaid.",
          );
        }

        if (auction?.mappingStatus === "marked_unpaid") {
          return createResult(true, "unpaid_unchanged");
        }

        if (!paymentBufferExpired) {
          return createRejectedResult(
            "PAYMENT_BUFFER_ACTIVE",
            "Wait until TikTok's payment buffer expires before marking unpaid.",
          );
        }

        try {
          reconciliation.markUnpaid(state, auctionKey());
        } catch (error) {
          return createRejectedResult(
            error.code ?? "MARK_UNPAID_FAILED",
            error.message,
          );
        }

        return createResult(true, "marked_unpaid");
      }

      function undoCurrentUnpaid() {
        const auction = reconciliation.getAuction(state, auctionKey());

        if (auction?.mappingStatus !== "marked_unpaid") {
          return createRejectedResult(
            "NOT_MARKED_UNPAID",
            "This variation is not marked unpaid.",
          );
        }

        reconciliation.undoMarkUnpaid(state, auctionKey());
        return createResult(true, "unpaid_undone");
      }

      function getStateSnapshot() {
        return JSON.parse(JSON.stringify(state));
      }

      return Object.freeze({
        streamId,
        variationNumber,
        completePayment,
        getCurrentMapping,
        getInventoryEntries,
        getStateSnapshot,
        getViewState,
        markUnpaid: markCurrentUnpaid,
        selectSku,
        simulatePaymentBufferExpired,
        undoSimulatedPayment,
        undoMarkUnpaid: undoCurrentUnpaid,
      });
    }

    return {
      createMappingSession,
    };
  },
);
