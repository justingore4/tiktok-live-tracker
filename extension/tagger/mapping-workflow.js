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
      "createReconciliationState",
      "getAuction",
      "mapVariation",
    ];

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
      const item = requireNonEmptyString(entry?.item, "inventory item");
      const style = String(entry?.style ?? "").trim();

      return {
        ...entry,
        sku: requireNonEmptyString(entry?.sku, "inventory SKU"),
        item,
        style,
        size: requireNonEmptyString(String(entry?.size ?? ""), "inventory size"),
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

    function getRemainingQuantity(entry) {
      const quantity = entry.remainingQuantity ?? entry.quantityReceived ?? 0;

      return Number.isSafeInteger(quantity) ? quantity : 0;
    }

    function createMappingSession(options) {
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("Mapping session options are required.");
      }

      if (!Array.isArray(options.inventory)) {
        throw new TypeError("Mapping session inventory must be an array.");
      }

      const reconciliation = validateReconciliation(options.reconciliation);
      const streamId = requireNonEmptyString(options.streamId, "streamId");
      const variationNumber = requirePositiveInteger(
        options.variationNumber,
        "variationNumber",
      );
      const inventory = options.inventory.map(normalizeDisplayEntry);
      const state = reconciliation.createReconciliationState(
        inventory.map(toReconciliationInventory),
      );

      function findInventoryEntry(sku) {
        return inventory.find((entry) => entry.sku === sku) ?? null;
      }

      function getCurrentMapping() {
        const auction = reconciliation.getAuction(state, {
          streamId,
          variationNumber,
        });

        if (!auction?.sku) {
          return null;
        }

        const entry = findInventoryEntry(auction.sku);

        return {
          eventKey: auction.eventKey,
          streamId,
          variationNumber,
          sku: auction.sku,
          item: entry.item,
          style: entry.style,
          size: entry.size,
          status: auction.status,
          statusLabel: "Waiting for payment",
          mappingStatus: auction.mappingStatus,
          paymentStatus: auction.paymentStatus,
          soldPriceCents: auction.soldPriceCents,
          committedUnitCostCents: auction.committedUnitCostCents,
          profitCents: auction.profitCents,
          committed: auction.committed,
        };
      }

      function createRejectedResult(code, message) {
        return {
          ok: false,
          code,
          message,
          mapping: getCurrentMapping(),
        };
      }

      function selectSku(value) {
        const sku = typeof value === "string" ? value.trim() : "";
        const entry = findInventoryEntry(sku);

        if (!entry) {
          return createRejectedResult(
            "UNKNOWN_SKU",
            "That inventory entry is not available in this session.",
          );
        }

        if (getRemainingQuantity(entry) <= 0) {
          return createRejectedResult(
            "SOLD_OUT",
            `${entry.item}${entry.style ? ` - ${entry.style}` : ""} is sold out.`,
          );
        }

        const previousMapping = getCurrentMapping();

        reconciliation.mapVariation(state, {
          streamId,
          variationNumber,
          sku,
        });

        const mapping = getCurrentMapping();
        let action = "mapped";

        if (previousMapping?.sku === sku) {
          action = "unchanged";
        } else if (previousMapping) {
          action = "remapped";
        }

        return {
          ok: true,
          action,
          mapping,
        };
      }

      function getStateSnapshot() {
        return JSON.parse(JSON.stringify(state));
      }

      return Object.freeze({
        streamId,
        variationNumber,
        getCurrentMapping,
        getStateSnapshot,
        selectSku,
      });
    }

    return {
      createMappingSession,
    };
  },
);
