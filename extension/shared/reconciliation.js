(function initializeReconciliation(root, factory) {
  const reconciliation = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = reconciliation;
  }

  root.TikTokLiveTrackerReconciliation = reconciliation;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createReconciliationModule() {
    "use strict";

    const LEGACY_STATE_VERSION = 1;
    const OBSERVED_PAYMENT_STATE_VERSION = 2;
    const CANCELED_PAYMENT_STATE_VERSION = 3;
    const INVENTORY_BASELINE_STATE_VERSION = 4;
    const ATTRIBUTED_GMV_STATE_VERSION = 5;
    const BIDDING_VARIATION_STATE_VERSION = 6;
    const STATE_VERSION = 7;
    const LEGACY_INVENTORY_BASELINE_ID =
      "inventory-baseline:00000000-0000-4000-8000-000000000000";
    const INVENTORY_BASELINE_ID_PATTERN =
      /^inventory-baseline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const SOURCE_FINGERPRINT_PATTERN = /^fnv1a64:[0-9a-f]{16}$/;
    const IMPORTED_SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const IMPORTED_TEXT_LIMITS = Object.freeze({
      item: 160,
      style: 160,
      size: 80,
    });
    const UNSAFE_CONTROL_CHARACTER_PATTERN =
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    const MAX_OBSERVED_VARIATIONS = 1000;
    const MAX_OBSERVED_PAYMENT_STATUSES = 1000;
    const MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH = 24;
    const ATTRIBUTED_GMV_DISPLAY_PATTERN =
      /^\$(?:(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}|(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB])$/;
    const OBSERVED_PAYMENT_STATUSES = Object.freeze({
      NOT_OBSERVED: "not_observed",
      PAYMENT_PROCESSING: "payment_processing",
      PAYMENT_FIXING: "payment_fixing",
      PAYMENT_FAILED: "payment_failed",
      CANCELED: "canceled",
      PAYMENT_COMPLETE: "payment_complete",
      UNRECOGNIZED: "unrecognized",
    });
    const OBSERVED_PAYMENT_STATUS_VALUES = new Set(
      Object.values(OBSERVED_PAYMENT_STATUSES),
    );
    const TOTAL_SALE_OBSERVED_PAYMENT_STATUSES = new Set([
      OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      OBSERVED_PAYMENT_STATUSES.CANCELED,
    ]);
    const PAYMENT_FIXING_OBSERVED_STATUSES = new Set([
      OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    ]);

    class ReconciliationError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "ReconciliationError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new ReconciliationError(code, message);
    }

    function requireState(state) {
      if (
        !state ||
        state.version !== STATE_VERSION ||
        !Array.isArray(state.inventoryBaselines) ||
        !Array.isArray(state.streams)
      ) {
        fail("INVALID_STATE", "A valid reconciliation state is required.");
      }
    }

    function requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim() === "") {
        fail("INVALID_ARGUMENT", `${fieldName} must be a non-empty string.`);
      }

      return value.trim();
    }

    function requireSafeInteger(value, fieldName, minimum) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        fail(
          "INVALID_ARGUMENT",
          `${fieldName} must be a safe integer greater than or equal to ${minimum}.`,
        );
      }

      return value;
    }

    function requireStreamId(value) {
      return requireNonEmptyString(value, "streamId");
    }

    function requireVariationNumber(value) {
      return requireSafeInteger(value, "variationNumber", 1);
    }

    function requireAttributedGmvDisplay(value, fieldName) {
      if (
        typeof value !== "string" ||
        value.length > MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH ||
        !ATTRIBUTED_GMV_DISPLAY_PATTERN.test(value)
      ) {
        fail(
          "INVALID_ARGUMENT",
          `${fieldName} must be a canonical TikTok Attributed GMV display.`,
        );
      }

      return value;
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function failInvalidState(message) {
      fail("INVALID_STATE", `Persisted reconciliation state is invalid: ${message}`);
    }

    function requirePersistedRecord(value, path, expectedKeys) {
      if (!isPlainRecord(value)) {
        failInvalidState(`${path} must be an object.`);
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        failInvalidState(
          `${path} must contain exactly: ${sortedExpectedKeys.join(", ")}.`,
        );
      }

      return value;
    }

    function requirePersistedString(value, path, allowEmpty = false) {
      if (
        typeof value !== "string" ||
        value !== value.trim() ||
        (!allowEmpty && value === "")
      ) {
        failInvalidState(
          `${path} must be ${allowEmpty ? "a trimmed string" : "a non-empty trimmed string"}.`,
        );
      }

      return value;
    }

    function requirePersistedInteger(value, path, minimum) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        failInvalidState(
          `${path} must be a safe integer greater than or equal to ${minimum}.`,
        );
      }

      return value;
    }

    function hydratePersistedConflict(
      conflict,
      path,
      auction,
      stateVersion,
    ) {
      if (!isPlainRecord(conflict)) {
        failInvalidState(`${path} must be an object.`);
      }

      if (conflict.code === "conflicting_sold_price") {
        requirePersistedRecord(conflict, path, [
          "code",
          "observedSoldPriceCents",
          "retainedSoldPriceCents",
        ]);
        const retainedSoldPriceCents = requirePersistedInteger(
          conflict.retainedSoldPriceCents,
          `${path}.retainedSoldPriceCents`,
          1,
        );
        const observedSoldPriceCents = requirePersistedInteger(
          conflict.observedSoldPriceCents,
          `${path}.observedSoldPriceCents`,
          1,
        );

        if (
          auction.paymentStatus !== "payment_complete" ||
          retainedSoldPriceCents !== auction.soldPriceCents ||
          observedSoldPriceCents === retainedSoldPriceCents
        ) {
          failInvalidState(`${path} does not match its completed payment.`);
        }

        return {
          code: "conflicting_sold_price",
          retainedSoldPriceCents,
          observedSoldPriceCents,
        };
      }

      if (conflict.code === "payment_completed_after_marked_unpaid") {
        requirePersistedRecord(conflict, path, ["code"]);

        if (auction.paymentStatus !== "payment_complete") {
          failInvalidState(`${path} does not match its completed payment.`);
        }

        return { code: "payment_completed_after_marked_unpaid" };
      }

      if (conflict.code === "payment_completed_after_canceled") {
        if (stateVersion < CANCELED_PAYMENT_STATE_VERSION) {
          failInvalidState(`${path}.code is not supported by this state version.`);
        }

        if (stateVersion >= STATE_VERSION) {
          failInvalidState(
            `${path}.code is a legacy conflict and is not supported by this state version.`,
          );
        }

        requirePersistedRecord(conflict, path, ["code"]);

        if (auction.paymentStatus !== "payment_complete") {
          failInvalidState(`${path} does not match its completed payment.`);
        }

        return { code: "payment_completed_after_canceled" };
      }

      failInvalidState(`${path}.code is not supported.`);
    }

    function hydratePersistedAuction(
      auction,
      path,
      parentStreamId,
      inventoryBySku,
      stateVersion,
    ) {
      const expectedKeys = [
        "committedUnitCostCents",
        "conflicts",
        "mappingStatus",
        "paymentStatus",
        "sku",
        "soldPriceCents",
        "streamId",
        "variationNumber",
      ];

      if (stateVersion !== LEGACY_STATE_VERSION) {
        expectedKeys.push("observedPaymentStatus");
      }

      requirePersistedRecord(auction, path, expectedKeys);
      const streamId = requirePersistedString(
        auction.streamId,
        `${path}.streamId`,
      );
      const variationNumber = requirePersistedInteger(
        auction.variationNumber,
        `${path}.variationNumber`,
        1,
      );

      if (streamId !== parentStreamId) {
        failInvalidState(`${path}.streamId must match its parent stream.`);
      }

      const sku = auction.sku === null
        ? null
        : requirePersistedString(auction.sku, `${path}.sku`);

      if (sku !== null && !inventoryBySku.has(sku)) {
        failInvalidState(`${path}.sku does not exist in inventory.`);
      }

      if (![
        "mapped",
        "marked_unpaid",
        "unmapped",
      ].includes(auction.mappingStatus)) {
        failInvalidState(`${path}.mappingStatus is not supported.`);
      }

      if (
        stateVersion >= STATE_VERSION &&
        auction.mappingStatus === "marked_unpaid"
      ) {
        failInvalidState(
          `${path}.mappingStatus is a legacy value and is not supported by this state version.`,
        );
      }

      const supportedPaymentStatuses =
        stateVersion >= CANCELED_PAYMENT_STATE_VERSION
        ? ["canceled", "payment_complete", "unknown"]
        : ["payment_complete", "unknown"];

      if (!supportedPaymentStatuses.includes(auction.paymentStatus)) {
        failInvalidState(`${path}.paymentStatus is not supported.`);
      }

      const observedPaymentStatus =
        stateVersion === LEGACY_STATE_VERSION
          ? auction.paymentStatus === "payment_complete"
            ? OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE
            : OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED
          : requirePersistedString(
              auction.observedPaymentStatus,
              `${path}.observedPaymentStatus`,
            );

      if (!OBSERVED_PAYMENT_STATUS_VALUES.has(observedPaymentStatus)) {
        failInvalidState(`${path}.observedPaymentStatus is not supported.`);
      }

      const paymentStatus =
        stateVersion === OBSERVED_PAYMENT_STATE_VERSION &&
        auction.paymentStatus === "unknown" &&
        observedPaymentStatus === OBSERVED_PAYMENT_STATUSES.CANCELED
          ? "canceled"
          : auction.paymentStatus;

      if (
        paymentStatus === "payment_complete" &&
        observedPaymentStatus !== OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE
      ) {
        failInvalidState(
          `${path}.observedPaymentStatus must reflect its completed payment.`,
        );
      }

      if (
        paymentStatus === "canceled" &&
        observedPaymentStatus !== OBSERVED_PAYMENT_STATUSES.CANCELED
      ) {
        failInvalidState(
          `${path}.observedPaymentStatus must reflect its canceled payment.`,
        );
      }

      if (
        stateVersion >= CANCELED_PAYMENT_STATE_VERSION &&
        observedPaymentStatus === OBSERVED_PAYMENT_STATUSES.CANCELED &&
        paymentStatus !== "canceled"
      ) {
        failInvalidState(
          `${path}.paymentStatus must reflect its observed cancellation.`,
        );
      }

      if (
        (sku === null && auction.mappingStatus === "mapped") ||
        (sku !== null && auction.mappingStatus === "unmapped")
      ) {
        failInvalidState(`${path} has inconsistent SKU and mapping state.`);
      }

      let soldPriceCents = null;
      let committedUnitCostCents = null;

      if (paymentStatus !== "payment_complete") {
        if (
          auction.soldPriceCents !== null ||
          auction.committedUnitCostCents !== null
        ) {
          failInvalidState(`${path} has money without a completed payment.`);
        }
      } else {
        soldPriceCents = requirePersistedInteger(
          auction.soldPriceCents,
          `${path}.soldPriceCents`,
          1,
        );

        if (sku === null) {
          if (auction.committedUnitCostCents !== null) {
            failInvalidState(
              `${path}.committedUnitCostCents must be null while unmapped.`,
            );
          }
        } else {
          committedUnitCostCents = requirePersistedInteger(
            auction.committedUnitCostCents,
            `${path}.committedUnitCostCents`,
            0,
          );

          if (
            committedUnitCostCents !== inventoryBySku.get(sku).unitCostCents
          ) {
            failInvalidState(
              `${path}.committedUnitCostCents must match inventory cost.`,
            );
          }
        }
      }

      if (!Array.isArray(auction.conflicts)) {
        failInvalidState(`${path}.conflicts must be an array.`);
      }

      const conflictKeys = new Set();
      const hydratedAuction = {
        streamId,
        variationNumber,
        sku,
        mappingStatus: auction.mappingStatus,
        paymentStatus,
        observedPaymentStatus,
        soldPriceCents,
        committedUnitCostCents,
        conflicts: [],
      };

      hydratedAuction.conflicts = auction.conflicts.map((conflict, index) => {
        const hydratedConflict = hydratePersistedConflict(
          conflict,
          `${path}.conflicts[${index}]`,
          hydratedAuction,
          stateVersion,
        );
        const conflictKey = `${hydratedConflict.code}:${hydratedConflict.observedSoldPriceCents ?? ""}`;

        if (conflictKeys.has(conflictKey)) {
          failInvalidState(`${path}.conflicts contains a duplicate conflict.`);
        }

        conflictKeys.add(conflictKey);
        return hydratedConflict;
      });

      if (
        paymentStatus !== "payment_complete" &&
        hydratedAuction.conflicts.length > 0
      ) {
        failInvalidState(`${path} has conflicts without a completed payment.`);
      }

      if (
        auction.mappingStatus === "marked_unpaid" &&
        auction.paymentStatus === "payment_complete" &&
        !hydratedAuction.conflicts.some(
          (conflict) =>
            conflict.code === "payment_completed_after_marked_unpaid",
        )
      ) {
        failInvalidState(
          `${path} is missing its payment-after-unpaid conflict.`,
        );
      }

      if (stateVersion < STATE_VERSION) {
        const completedAfterCancellation = hydratedAuction.conflicts.some(
          (conflict) => conflict.code === "payment_completed_after_canceled",
        );

        if (completedAfterCancellation) {
          hydratedAuction.paymentStatus = "canceled";
          hydratedAuction.observedPaymentStatus =
            OBSERVED_PAYMENT_STATUSES.CANCELED;
          hydratedAuction.soldPriceCents = null;
          hydratedAuction.committedUnitCostCents = null;
          hydratedAuction.conflicts = [];
        }

        if (hydratedAuction.mappingStatus === "marked_unpaid") {
          hydratedAuction.mappingStatus = hydratedAuction.sku
            ? "mapped"
            : "unmapped";
        }
      }

      return hydratedAuction;
    }

    function hydrateLegacyInventory(items) {
      if (!Array.isArray(items)) {
        failInvalidState("state.inventory must be an array.");
      }

      const seenSkus = new Set();

      return items.map((item, index) => {
        const path = `state.inventory[${index}]`;

        requirePersistedRecord(item, path, [
          "name",
          "quantityReceived",
          "size",
          "sku",
          "unitCostCents",
        ]);
        const hydratedItem = {
          sku: requirePersistedString(item.sku, `${path}.sku`),
          item: requirePersistedString(item.name, `${path}.name`),
          style: "",
          size: requirePersistedString(item.size, `${path}.size`, true),
          quantityOnHandAtImport: requirePersistedInteger(
            item.quantityReceived,
            `${path}.quantityReceived`,
            0,
          ),
          unitCostCents: requirePersistedInteger(
            item.unitCostCents,
            `${path}.unitCostCents`,
            0,
          ),
        };

        if (seenSkus.has(hydratedItem.sku)) {
          failInvalidState(
            `state.inventory contains duplicate SKU ${hydratedItem.sku}.`,
          );
        }

        seenSkus.add(hydratedItem.sku);
        return hydratedItem;
      });
    }

    function hydrateBaselineInventory(items, path, allowEmptySize = false) {
      if (!Array.isArray(items)) {
        failInvalidState(`${path} must be an array.`);
      }

      const seenSkus = new Set();

      return items.map((item, index) => {
        const itemPath = `${path}[${index}]`;

        requirePersistedRecord(item, itemPath, [
          "item",
          "quantityOnHandAtImport",
          "size",
          "sku",
          "style",
          "unitCostCents",
        ]);
        const hydratedItem = {
          sku: requirePersistedString(item.sku, `${itemPath}.sku`),
          item: requirePersistedString(item.item, `${itemPath}.item`),
          style: requirePersistedString(
            item.style,
            `${itemPath}.style`,
            true,
          ),
          size: requirePersistedString(
            item.size,
            `${itemPath}.size`,
            allowEmptySize,
          ),
          quantityOnHandAtImport: requirePersistedInteger(
            item.quantityOnHandAtImport,
            `${itemPath}.quantityOnHandAtImport`,
            0,
          ),
          unitCostCents: requirePersistedInteger(
            item.unitCostCents,
            `${itemPath}.unitCostCents`,
            0,
          ),
        };

        if (seenSkus.has(hydratedItem.sku)) {
          failInvalidState(`${path} contains duplicate SKU ${hydratedItem.sku}.`);
        }

        seenSkus.add(hydratedItem.sku);
        return hydratedItem;
      });
    }

    function importedInventoryContractIssue(inventory) {
      const identities = new Set();
      let totalQuantity = 0n;
      let totalInventoryCost = 0n;

      for (const entry of inventory) {
        if (!IMPORTED_SKU_PATTERN.test(entry.sku)) {
          return `SKU ${entry.sku} does not match the imported inventory contract.`;
        }

        for (const [field, allowEmpty] of [
          ["item", false],
          ["style", true],
          ["size", false],
        ]) {
          const value = entry[field];
          const canonical = value
            .normalize("NFC")
            .trim()
            .replace(/\s+/g, " ");

          if (
            value !== canonical ||
            (!allowEmpty && value === "") ||
            value.startsWith("=") ||
            value.length > IMPORTED_TEXT_LIMITS[field] ||
            UNSAFE_CONTROL_CHARACTER_PATTERN.test(value)
          ) {
            return `${field} does not match the imported inventory contract.`;
          }
        }

        const identity = [entry.item, entry.style, entry.size]
          .map((value) => value.toLocaleLowerCase("en-US"))
          .join("\u0000");

        if (identities.has(identity)) {
          return "item, style, and size must identify a unique inventory entry.";
        }

        identities.add(identity);
        totalQuantity += BigInt(entry.quantityOnHandAtImport);
        totalInventoryCost +=
          BigInt(entry.quantityOnHandAtImport) * BigInt(entry.unitCostCents);
      }

      if (
        totalQuantity > BigInt(Number.MAX_SAFE_INTEGER) ||
        totalInventoryCost > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return "Inventory quantity and cost totals must remain safe integers.";
      }

      return null;
    }

    function hydrateStreams(candidate, inventoryBaselines, legacy) {
      if (!Array.isArray(candidate.streams)) {
        failInvalidState("state.streams must be an array.");
      }

      const baselinesById = new Map(
        inventoryBaselines.map((baseline) => [baseline.baselineId, baseline]),
      );
      const streamIds = new Set();

      return candidate.streams.map((stream, streamIndex) => {
        const path = `state.streams[${streamIndex}]`;
        const expectedKeys = legacy
          ? ["streamId", "variations"]
          : candidate.version === INVENTORY_BASELINE_STATE_VERSION
            ? ["inventoryBaselineId", "streamId", "variations"]
            : candidate.version === ATTRIBUTED_GMV_STATE_VERSION
              ? [
                  "attributedGmvDisplay",
                  "inventoryBaselineId",
                  "streamId",
                  "variations",
                ]
              : [
                  "activeBiddingVariationNumber",
                  "attributedGmvDisplay",
                  "inventoryBaselineId",
                  "streamId",
                  "variations",
                ];

        requirePersistedRecord(stream, path, expectedKeys);
        const streamId = requirePersistedString(
          stream.streamId,
          `${path}.streamId`,
        );

        if (streamIds.has(streamId)) {
          failInvalidState(`state.streams contains duplicate stream ${streamId}.`);
        }

        streamIds.add(streamId);
        const inventoryBaselineId = legacy
          ? LEGACY_INVENTORY_BASELINE_ID
          : requirePersistedString(
              stream.inventoryBaselineId,
              `${path}.inventoryBaselineId`,
            );
        const baseline = baselinesById.get(inventoryBaselineId);
        let attributedGmvDisplay = null;
        let activeBiddingVariationNumber = null;

        if (
          !legacy &&
          candidate.version !== INVENTORY_BASELINE_STATE_VERSION &&
          stream.attributedGmvDisplay !== null
        ) {
          const display = requirePersistedString(
            stream.attributedGmvDisplay,
            `${path}.attributedGmvDisplay`,
          );

          if (
            display.length > MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH ||
            !ATTRIBUTED_GMV_DISPLAY_PATTERN.test(display)
          ) {
            failInvalidState(
              `${path}.attributedGmvDisplay is not a canonical TikTok Attributed GMV display.`,
            );
          }

          attributedGmvDisplay = display;
        }

        if (!baseline) {
          failInvalidState(
            `${path}.inventoryBaselineId does not reference an inventory baseline.`,
          );
        }

        if (!Array.isArray(stream.variations)) {
          failInvalidState(`${path}.variations must be an array.`);
        }

        const inventoryBySku = new Map(
          baseline.inventory.map((item) => [item.sku, item]),
        );
        const variationNumbers = new Set();
        const variations = stream.variations.map((auction, auctionIndex) => {
          const hydratedAuction = hydratePersistedAuction(
            auction,
            `${path}.variations[${auctionIndex}]`,
            streamId,
            inventoryBySku,
            candidate.version,
          );

          if (variationNumbers.has(hydratedAuction.variationNumber)) {
            failInvalidState(
              `${path}.variations contains duplicate variation ${hydratedAuction.variationNumber}.`,
            );
          }

          variationNumbers.add(hydratedAuction.variationNumber);
          return hydratedAuction;
        });

        if (
          !legacy &&
          candidate.version > ATTRIBUTED_GMV_STATE_VERSION &&
          stream.activeBiddingVariationNumber !== null
        ) {
          activeBiddingVariationNumber = requirePersistedInteger(
            stream.activeBiddingVariationNumber,
            `${path}.activeBiddingVariationNumber`,
            1,
          );

          if (!variationNumbers.has(activeBiddingVariationNumber)) {
            failInvalidState(
              `${path}.activeBiddingVariationNumber does not reference an existing variation.`,
            );
          }

          const activeAuction = variations.find(
            (auction) =>
              auction.variationNumber === activeBiddingVariationNumber,
          );
          const remainsEligibleForBidding =
            activeAuction.paymentStatus === "unknown" &&
            activeAuction.observedPaymentStatus ===
              OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED;

          if (!remainsEligibleForBidding) {
            if (candidate.version < STATE_VERSION) {
              activeBiddingVariationNumber = null;
            } else {
              failInvalidState(
                `${path}.activeBiddingVariationNumber must reference an unobserved, nonterminal variation.`,
              );
            }
          }
        }

        return {
          streamId,
          inventoryBaselineId,
          activeBiddingVariationNumber,
          attributedGmvDisplay,
          variations,
        };
      });
    }

    function hydrateReconciliationState(candidate) {
      try {
        if (!isPlainRecord(candidate)) {
          failInvalidState("state must be an object.");
        }

        if (!Number.isSafeInteger(candidate.version)) {
          failInvalidState("state.version must be a safe integer.");
        }

        if (
          candidate.version !== LEGACY_STATE_VERSION &&
          candidate.version !== OBSERVED_PAYMENT_STATE_VERSION &&
          candidate.version !== CANCELED_PAYMENT_STATE_VERSION &&
          candidate.version !== INVENTORY_BASELINE_STATE_VERSION &&
          candidate.version !== ATTRIBUTED_GMV_STATE_VERSION &&
          candidate.version !== BIDDING_VARIATION_STATE_VERSION &&
          candidate.version !== STATE_VERSION
        ) {
          fail(
            "UNSUPPORTED_STATE_VERSION",
            `Reconciliation state version ${candidate.version} is not supported.`,
          );
        }

        if (candidate.version < INVENTORY_BASELINE_STATE_VERSION) {
          requirePersistedRecord(candidate, "state", [
            "inventory",
            "streams",
            "version",
          ]);
          const inventory = hydrateLegacyInventory(candidate.inventory);
          const inventoryBaselines = [{
            baselineId: LEGACY_INVENTORY_BASELINE_ID,
            sourceFingerprint: null,
            inventory,
          }];
          const streams = hydrateStreams(candidate, inventoryBaselines, true);

          return {
            version: STATE_VERSION,
            activeInventoryBaselineId: LEGACY_INVENTORY_BASELINE_ID,
            inventoryBaselines,
            streams,
          };
        }

        requirePersistedRecord(candidate, "state", [
          "activeInventoryBaselineId",
          "inventoryBaselines",
          "streams",
          "version",
        ]);

        if (!Array.isArray(candidate.inventoryBaselines)) {
          failInvalidState("state.inventoryBaselines must be an array.");
        }

        const baselineIds = new Set();
        const inventoryBaselines = candidate.inventoryBaselines.map(
          (baseline, baselineIndex) => {
            const path = `state.inventoryBaselines[${baselineIndex}]`;

            requirePersistedRecord(baseline, path, [
              "baselineId",
              "inventory",
              "sourceFingerprint",
            ]);
            const baselineId = requirePersistedString(
              baseline.baselineId,
              `${path}.baselineId`,
            );

            if (!INVENTORY_BASELINE_ID_PATTERN.test(baselineId)) {
              failInvalidState(`${path}.baselineId is not supported.`);
            }

            if (baselineIds.has(baselineId)) {
              failInvalidState(
                `state.inventoryBaselines contains duplicate baseline ${baselineId}.`,
              );
            }

            baselineIds.add(baselineId);
            let sourceFingerprint = null;

            if (baseline.sourceFingerprint !== null) {
              sourceFingerprint = requirePersistedString(
                baseline.sourceFingerprint,
                `${path}.sourceFingerprint`,
              );

              if (!SOURCE_FINGERPRINT_PATTERN.test(sourceFingerprint)) {
                failInvalidState(`${path}.sourceFingerprint is not supported.`);
              }
            }

            if (
              (baselineId === LEGACY_INVENTORY_BASELINE_ID) !==
              (sourceFingerprint === null)
            ) {
              failInvalidState(
                `${path} has inconsistent legacy baseline provenance.`,
              );
            }

            const inventory = hydrateBaselineInventory(
              baseline.inventory,
              `${path}.inventory`,
              sourceFingerprint === null,
            );

            if (sourceFingerprint !== null) {
              if (inventory.length === 0) {
                failInvalidState(`${path}.inventory must not be empty.`);
              }

              const contractIssue = importedInventoryContractIssue(inventory);

              if (contractIssue !== null) {
                failInvalidState(`${path}.inventory ${contractIssue}`);
              }
            }

            return {
              baselineId,
              sourceFingerprint,
              inventory,
            };
          },
        );
        let activeInventoryBaselineId = null;

        if (candidate.activeInventoryBaselineId !== null) {
          activeInventoryBaselineId = requirePersistedString(
            candidate.activeInventoryBaselineId,
            "state.activeInventoryBaselineId",
          );

          if (!baselineIds.has(activeInventoryBaselineId)) {
            failInvalidState(
              "state.activeInventoryBaselineId does not reference an inventory baseline.",
            );
          }
        }

        if (
          (inventoryBaselines.length === 0) !==
          (activeInventoryBaselineId === null)
        ) {
          failInvalidState(
            "state.activeInventoryBaselineId must identify the active baseline.",
          );
        }

        const streams = hydrateStreams(candidate, inventoryBaselines, false);

        if (inventoryBaselines.length === 0 && streams.length > 0) {
          failInvalidState("state cannot contain streams without inventory baselines.");
        }

        return {
          version: STATE_VERSION,
          activeInventoryBaselineId,
          inventoryBaselines,
          streams,
        };
      } catch (error) {
        if (
          error instanceof ReconciliationError &&
          ["INVALID_STATE", "UNSUPPORTED_STATE_VERSION"].includes(error.code)
        ) {
          throw error;
        }

        throw new ReconciliationError(
          "INVALID_STATE",
          `Persisted reconciliation state is invalid: ${error.message}`,
        );
      }
    }

    function cloneLegacyInventoryItem(item, index) {
      if (!isPlainRecord(item)) {
        fail("INVALID_INVENTORY", `Inventory item ${index + 1} must be an object.`);
      }

      return {
        sku: requireNonEmptyString(item.sku, `inventory[${index}].sku`),
        item: requireNonEmptyString(
          item.item ?? item.name ?? item.sku,
          `inventory[${index}].item`,
        ),
        style: String(item.style ?? "").trim(),
        size: String(item.size ?? "").trim(),
        quantityOnHandAtImport: requireSafeInteger(
          item.quantityOnHandAtImport ?? item.quantityReceived,
          `inventory[${index}].quantityOnHandAtImport`,
          0,
        ),
        unitCostCents: requireSafeInteger(
          item.unitCostCents,
          `inventory[${index}].unitCostCents`,
          0,
        ),
      };
    }

    function cloneBaselineInventoryItem(item, index) {
      if (!isPlainRecord(item)) {
        fail(
          "INVALID_INVENTORY_BASELINE",
          `inventory[${index}] must be an object.`,
        );
      }

      const expectedKeys = [
        "item",
        "quantityOnHandAtImport",
        "size",
        "sku",
        "style",
        "unitCostCents",
      ].sort();
      const actualKeys = Object.keys(item).sort();

      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
      ) {
        fail(
          "INVALID_INVENTORY_BASELINE",
          `inventory[${index}] has an invalid shape.`,
        );
      }


      if (
        typeof item.sku !== "string" ||
        typeof item.item !== "string" ||
        typeof item.style !== "string" ||
        typeof item.size !== "string"
      ) {
        fail(
          "INVALID_INVENTORY_BASELINE",
          `inventory[${index}] text fields must be strings.`,
        );
      }

      return {
        sku: item.sku,
        item: item.item,
        style: item.style,
        size: item.size,
        quantityOnHandAtImport: requireSafeInteger(
          item.quantityOnHandAtImport,
          `inventory[${index}].quantityOnHandAtImport`,
          0,
        ),
        unitCostCents: requireSafeInteger(
          item.unitCostCents,
          `inventory[${index}].unitCostCents`,
          0,
        ),
      };
    }

    function requireUniqueInventorySkus(inventory) {
      const seenSkus = new Set();

      inventory.forEach((item) => {
        if (seenSkus.has(item.sku)) {
          fail("DUPLICATE_SKU", `Inventory SKU ${item.sku} appears more than once.`);
        }

        seenSkus.add(item.sku);
      });
    }

    function prepareInventoryBaselineCandidate(input) {
      if (!isPlainRecord(input)) {
        fail("INVALID_INVENTORY_BASELINE", "An inventory baseline is required.");
      }

      const actualKeys = Object.keys(input).sort();
      const expectedKeys = [
        "baselineId",
        "inventory",
        "sourceFingerprint",
      ].sort();

      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        fail("INVALID_INVENTORY_BASELINE", "The inventory baseline has an invalid shape.");
      }

      const baselineId = requireNonEmptyString(input.baselineId, "baselineId");

      if (
        !INVENTORY_BASELINE_ID_PATTERN.test(baselineId) ||
        baselineId === LEGACY_INVENTORY_BASELINE_ID
      ) {
        fail("INVALID_BASELINE_ID", "baselineId must be an inventory baseline UUID.");
      }

      const sourceFingerprint = requireNonEmptyString(
        input.sourceFingerprint,
        "sourceFingerprint",
      );

      if (!SOURCE_FINGERPRINT_PATTERN.test(sourceFingerprint)) {
        fail(
          "INVALID_SOURCE_FINGERPRINT",
          "sourceFingerprint must be a supported inventory fingerprint.",
        );
      }

      if (!Array.isArray(input.inventory) || input.inventory.length === 0) {
        fail(
          "INVALID_INVENTORY_BASELINE",
          "inventory must contain at least one entry.",
        );
      }

      const inventory = input.inventory.map(cloneBaselineInventoryItem);

      requireUniqueInventorySkus(inventory);
      const contractIssue = importedInventoryContractIssue(inventory);

      if (contractIssue !== null) {
        fail("INVALID_INVENTORY_BASELINE", contractIssue);
      }

      return { baselineId, sourceFingerprint, inventory };
    }

    function inventoryItemsMatch(first, second) {
      return (
        first.sku === second.sku &&
        first.item === second.item &&
        first.style === second.style &&
        first.size === second.size &&
        first.quantityOnHandAtImport === second.quantityOnHandAtImport &&
        first.unitCostCents === second.unitCostCents
      );
    }

    function createEmptyReconciliationState() {
      return {
        version: STATE_VERSION,
        activeInventoryBaselineId: null,
        inventoryBaselines: [],
        streams: [],
      };
    }

    function createReconciliationState(inventory = []) {
      if (!Array.isArray(inventory)) {
        fail("INVALID_INVENTORY", "Inventory must be an array.");
      }

      const normalizedInventory = inventory.map(cloneLegacyInventoryItem);

      requireUniqueInventorySkus(normalizedInventory);

      return {
        version: STATE_VERSION,
        activeInventoryBaselineId: LEGACY_INVENTORY_BASELINE_ID,
        inventoryBaselines: [{
          baselineId: LEGACY_INVENTORY_BASELINE_ID,
          sourceFingerprint: null,
          inventory: normalizedInventory,
        }],
        streams: [],
      };
    }

    function createInventoryBaseline(state, input) {
      requireState(state);
      const candidate = prepareInventoryBaselineCandidate(input);
      const { baselineId, inventory } = candidate;
      const existing = state.inventoryBaselines.find(
        (baseline) => baseline.baselineId === baselineId,
      );

      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(candidate)) {
          return { status: "already_exists", baselineId };
        }

        fail(
          "BASELINE_ID_CONFLICT",
          "The inventory baseline ID already identifies different inventory.",
        );
      }

      state.inventoryBaselines.push(candidate);
      state.activeInventoryBaselineId = baselineId;

      return { status: "created", baselineId };
    }

    function findInventoryBaseline(state, baselineId) {
      return state.inventoryBaselines.find(
        (baseline) => baseline.baselineId === baselineId,
      ) ?? null;
    }

    function requireActiveInventoryBaseline(state) {
      const baseline = findInventoryBaseline(
        state,
        state.activeInventoryBaselineId,
      );

      if (!baseline) {
        fail(
          "INVENTORY_BASELINE_NOT_INITIALIZED",
          "An inventory baseline must be active before a stream can be pinned.",
        );
      }

      return baseline;
    }

    function findInventoryItem(state, sku, baselineId) {
      const baseline = findInventoryBaseline(
        state,
        baselineId ?? state.activeInventoryBaselineId,
      );

      return baseline?.inventory.find((item) => item.sku === sku) ?? null;
    }

    function extendStreamInventoryBaseline(state, input) {
      requireState(state);

      if (!isPlainRecord(input)) {
        fail(
          "INVALID_INVENTORY_BASELINE_EXTENSION",
          "An inventory baseline extension is required.",
        );
      }

      const actualKeys = Object.keys(input).sort();
      const expectedKeys = [
        "baselineId",
        "expectedBaselineId",
        "inventory",
        "sourceFingerprint",
        "streamId",
      ].sort();

      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        fail(
          "INVALID_INVENTORY_BASELINE_EXTENSION",
          "The inventory baseline extension has an invalid shape.",
        );
      }

      const streamId = requireStreamId(input.streamId);
      const expectedBaselineId = requireNonEmptyString(
        input.expectedBaselineId,
        "expectedBaselineId",
      );
      const candidate = prepareInventoryBaselineCandidate({
        baselineId: input.baselineId,
        sourceFingerprint: input.sourceFingerprint,
        inventory: input.inventory,
      });
      const activeBaseline = requireActiveInventoryBaseline(state);

      if (activeBaseline.baselineId !== expectedBaselineId) {
        fail(
          "ACTIVE_INVENTORY_BASELINE_CHANGED",
          "The active inventory baseline changed before new SKUs could be added.",
        );
      }

      const stream = findStream(state, streamId);

      if (!stream) {
        fail("UNKNOWN_STREAM", `Stream ${streamId} does not exist.`);
      }

      if (stream.inventoryBaselineId !== expectedBaselineId) {
        fail(
          "STREAM_BASELINE_CONFLICT",
          "The stream is not pinned to the expected inventory baseline.",
        );
      }

      const incomingBySku = new Map(
        candidate.inventory.map((item) => [item.sku, item]),
      );

      for (const existingItem of activeBaseline.inventory) {
        const incomingItem = incomingBySku.get(existingItem.sku);

        if (!incomingItem || !inventoryItemsMatch(existingItem, incomingItem)) {
          fail(
            "INVENTORY_BASELINE_NOT_APPEND_ONLY",
            "Existing inventory rows cannot be changed, renamed, or removed while a stream is active.",
          );
        }
      }

      const existingSkus = new Set(
        activeBaseline.inventory.map((item) => item.sku),
      );
      const addedSkus = candidate.inventory
        .filter((item) => !existingSkus.has(item.sku))
        .map((item) => item.sku);

      if (addedSkus.length === 0) {
        return {
          status: "already_current",
          baselineId: expectedBaselineId,
          previousBaselineId: expectedBaselineId,
          addedSkus: [],
        };
      }

      if (findInventoryBaseline(state, candidate.baselineId)) {
        fail(
          "BASELINE_ID_CONFLICT",
          "The new inventory baseline ID is already in use.",
        );
      }

      createInventoryBaseline(state, candidate);
      state.streams.forEach((candidateStream) => {
        if (candidateStream.inventoryBaselineId === expectedBaselineId) {
          candidateStream.inventoryBaselineId = candidate.baselineId;
        }
      });

      return {
        status: "extended",
        baselineId: candidate.baselineId,
        previousBaselineId: expectedBaselineId,
        addedSkus,
      };
    }

    function findStream(state, streamId) {
      return state.streams.find((stream) => stream.streamId === streamId) ?? null;
    }

    function pinStreamToInventoryBaseline(state, input) {
      requireState(state);

      if (!isPlainRecord(input)) {
        fail("INVALID_ARGUMENT", "A stream pin input is required.");
      }

      const streamId = requireStreamId(input.streamId);
      const baseline = requireActiveInventoryBaseline(state);
      const existing = findStream(state, streamId);

      if (existing) {
        if (existing.inventoryBaselineId !== baseline.baselineId) {
          fail(
            "STREAM_BASELINE_CONFLICT",
            "A stream's inventory baseline cannot be changed after it is pinned.",
          );
        }

        return { status: "already_pinned", baselineId: baseline.baselineId };
      }

      state.streams.push({
        streamId,
        inventoryBaselineId: baseline.baselineId,
        activeBiddingVariationNumber: null,
        attributedGmvDisplay: null,
        variations: [],
      });

      return { status: "pinned", baselineId: baseline.baselineId };
    }

    function getOrCreateStream(state, streamId) {
      let stream = findStream(state, streamId);

      if (!stream) {
        const baseline = requireActiveInventoryBaseline(state);

        stream = {
          streamId,
          inventoryBaselineId: baseline.baselineId,
          activeBiddingVariationNumber: null,
          attributedGmvDisplay: null,
          variations: [],
        };
        state.streams.push(stream);
      }

      return stream;
    }

    function getInventoryBaselineForStream(state, streamId) {
      const stream = findStream(state, streamId);

      if (!stream) {
        return requireActiveInventoryBaseline(state);
      }

      const baseline = findInventoryBaseline(
        state,
        stream.inventoryBaselineId,
      );

      if (!baseline) {
        fail("INVALID_STATE", "The stream inventory baseline is unavailable.");
      }

      return baseline;
    }

    function findAuction(state, streamId, variationNumber) {
      const stream = findStream(state, streamId);

      return stream?.variations.find(
        (auction) => auction.variationNumber === variationNumber,
      ) ?? null;
    }

    function getOrCreateAuction(state, streamId, variationNumber) {
      let auction = findAuction(state, streamId, variationNumber);

      if (!auction) {
        auction = {
          streamId,
          variationNumber,
          sku: null,
          mappingStatus: "unmapped",
          paymentStatus: "unknown",
          observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED,
          soldPriceCents: null,
          committedUnitCostCents: null,
          conflicts: [],
        };
        getOrCreateStream(state, streamId).variations.push(auction);
      }

      return auction;
    }

    function addConflict(auction, conflict) {
      const duplicate = auction.conflicts.some(
        (existing) =>
          existing.code === conflict.code &&
          existing.observedSoldPriceCents === conflict.observedSoldPriceCents,
      );

      if (!duplicate) {
        auction.conflicts.push(conflict);
      }
    }

    function snapshotCommittedCost(state, auction) {
      if (auction.paymentStatus !== "payment_complete" || !auction.sku) {
        auction.committedUnitCostCents = null;
        return;
      }

      auction.committedUnitCostCents = findInventoryItem(
        state,
        auction.sku,
        getInventoryBaselineForStream(state, auction.streamId).baselineId,
      ).unitCostCents;
    }

    function hasPendingReservation(auction) {
      return Boolean(
        auction.sku &&
        auction.mappingStatus === "mapped" &&
        auction.paymentStatus === "unknown",
      );
    }

    function deriveAuctionStatus(auction) {
      if (auction.paymentStatus === "payment_complete" && auction.sku) {
        return "committed";
      }

      if (auction.paymentStatus === "payment_complete") {
        return "unmapped_completed";
      }

      if (auction.paymentStatus === "canceled") {
        return "canceled";
      }

      if (hasPendingReservation(auction)) {
        return "pending";
      }

      if (auction.sku) {
        return "mapped";
      }

      return "unmapped";
    }

    function countCommittedUnits(state, baselineId, sku) {
      return state.streams.reduce(
        (streamTotal, stream) =>
          streamTotal +
          (stream.inventoryBaselineId === baselineId
            ?
          stream.variations.filter(
            (auction) =>
              auction.sku === sku &&
              auction.paymentStatus === "payment_complete",
          ).length
            : 0),
        0,
      );
    }

    function countReservedUnits(state, baselineId, sku) {
      return state.streams.reduce(
        (streamTotal, stream) =>
          streamTotal +
          (stream.inventoryBaselineId === baselineId
            ?
          stream.variations.filter(
            (auction) =>
              auction.sku === sku && hasPendingReservation(auction),
          ).length
            : 0),
        0,
      );
    }

    function getInventoryAvailability(state, input) {
      requireState(state);

      if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail("INVALID_ARGUMENT", "An inventory availability input is required.");
      }

      const sku = requireNonEmptyString(input.sku, "sku");
      const hasStreamId = input.streamId !== undefined;
      const hasVariationNumber = input.variationNumber !== undefined;
      const hasInventoryBaselineId =
        input.inventoryBaselineId !== undefined;

      if (
        hasStreamId !== hasVariationNumber ||
        (hasInventoryBaselineId && hasStreamId)
      ) {
        fail(
          "INVALID_ARGUMENT",
          "Provide either inventoryBaselineId or streamId and variationNumber together.",
        );
      }

      const streamId = hasStreamId ? requireStreamId(input.streamId) : null;
      let baseline;

      if (hasInventoryBaselineId) {
        const baselineId = requireNonEmptyString(
          input.inventoryBaselineId,
          "inventoryBaselineId",
        );

        baseline = findInventoryBaseline(state, baselineId);

        if (!baseline) {
          fail("UNKNOWN_INVENTORY_BASELINE", "The inventory baseline does not exist.");
        }
      } else {
        baseline = hasStreamId
          ? getInventoryBaselineForStream(state, streamId)
          : requireActiveInventoryBaseline(state);
      }
      const inventoryItem = findInventoryItem(state, sku, baseline.baselineId);

      if (!inventoryItem) {
        fail("UNKNOWN_SKU", `Inventory does not contain SKU ${sku}.`);
      }

      const currentAuction = hasStreamId
        ? findAuction(
            state,
            streamId,
            requireVariationNumber(input.variationNumber),
          )
        : null;
      const soldQuantity = countCommittedUnits(state, baseline.baselineId, sku);
      const reservedQuantity = countReservedUnits(state, baseline.baselineId, sku);
      const remainingQuantity =
        inventoryItem.quantityOnHandAtImport - soldQuantity;
      const availableToTagQuantity = remainingQuantity - reservedQuantity;
      const oversoldQuantity = Math.max(
        0,
        soldQuantity + reservedQuantity -
          inventoryItem.quantityOnHandAtImport,
      );
      const reservationShortfallQuantity = Math.max(
        0,
        reservedQuantity - Math.max(0, remainingQuantity),
      );
      let currentAllocation = "none";

      if (currentAuction?.sku === sku) {
        if (currentAuction.paymentStatus === "payment_complete") {
          currentAllocation = "sold";
        } else if (hasPendingReservation(currentAuction)) {
          currentAllocation = "reserved";
        }
      }

      return {
        sku,
        name: inventoryItem.style
          ? `${inventoryItem.item} - ${inventoryItem.style}`
          : inventoryItem.item,
        item: inventoryItem.item,
        style: inventoryItem.style,
        size: inventoryItem.size,
        quantityOnHandAtImport: inventoryItem.quantityOnHandAtImport,
        quantityReceived: inventoryItem.quantityOnHandAtImport,
        soldQuantity,
        reservedQuantity,
        remainingQuantity,
        availableToTagQuantity,
        availableForCurrentAuctionQuantity:
          availableToTagQuantity + (currentAllocation === "none" ? 0 : 1),
        oversoldQuantity,
        reservationShortfallQuantity,
        currentAllocation,
      };
    }

    function createAuctionView(state, auction) {
      const status = deriveAuctionStatus(auction);
      const committed = status === "committed";
      const warnings = [];

      if (status === "pending") {
        const availability = getInventoryAvailability(state, {
          sku: auction.sku,
          streamId: auction.streamId,
          variationNumber: auction.variationNumber,
        });
        const availableQuantity =
          availability.availableForCurrentAuctionQuantity;

        if (availableQuantity <= 0) {
          warnings.push({
            code: "no_stock_available",
            sku: auction.sku,
            availableQuantity,
          });
        }
      }

      return {
        eventKey: `${auction.streamId}:${auction.variationNumber}`,
        streamId: auction.streamId,
        variationNumber: auction.variationNumber,
        sku: auction.sku,
        mappingStatus: auction.mappingStatus,
        paymentStatus: auction.paymentStatus,
        observedPaymentStatus: auction.observedPaymentStatus,
        soldPriceCents: auction.soldPriceCents,
        committedUnitCostCents: auction.committedUnitCostCents,
        profitCents: committed
          ? auction.soldPriceCents - auction.committedUnitCostCents
          : null,
        status,
        committed,
        conflicts: auction.conflicts.map((conflict) => ({ ...conflict })),
        warnings,
      };
    }

    function validateAuctionKey(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail("INVALID_ARGUMENT", "An auction input object is required.");
      }

      return {
        streamId: requireStreamId(input.streamId),
        variationNumber: requireVariationNumber(input.variationNumber),
      };
    }

    function mapVariation(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const sku = requireNonEmptyString(input.sku, "sku");
      const baseline = getInventoryBaselineForStream(state, key.streamId);
      const inventoryItem = findInventoryItem(state, sku, baseline.baselineId);

      if (!inventoryItem) {
        fail("UNKNOWN_SKU", `Inventory does not contain SKU ${sku}.`);
      }

      let auction = findAuction(state, key.streamId, key.variationNumber);

      if (auction?.sku === sku) {
        return createAuctionView(state, auction);
      }

      auction ??= getOrCreateAuction(
        state,
        key.streamId,
        key.variationNumber,
      );

      // A canceled variation may keep an SKU as reference-only history. Its
      // terminal payment status keeps this mapping out of inventory and sales.
      auction.sku = sku;
      auction.mappingStatus = "mapped";

      if (auction.paymentStatus === "payment_complete") {
        auction.committedUnitCostCents = inventoryItem.unitCostCents;
      }

      return createAuctionView(state, auction);
    }

    function observeVariations(state, input) {
      requireState(state);

      if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail("INVALID_ARGUMENT", "An observed-variations input is required.");
      }

      const streamId = requireStreamId(input.streamId);

      if (
        !Array.isArray(input.variationNumbers) ||
        input.variationNumbers.length === 0 ||
        input.variationNumbers.length > MAX_OBSERVED_VARIATIONS
      ) {
        fail(
          "INVALID_ARGUMENT",
          `variationNumbers must contain between 1 and ${MAX_OBSERVED_VARIATIONS} variation numbers.`,
        );
      }

      const seenVariationNumbers = new Set();
      const variationNumbers = input.variationNumbers.map(
        (variationNumber, index) => {
          const normalizedVariationNumber = requireSafeInteger(
            variationNumber,
            `variationNumbers[${index}]`,
            1,
          );

          if (seenVariationNumbers.has(normalizedVariationNumber)) {
            fail(
              "INVALID_ARGUMENT",
              "variationNumbers must not contain duplicates.",
            );
          }

          seenVariationNumbers.add(normalizedVariationNumber);
          return normalizedVariationNumber;
        },
      );
      let newlyObservedCount = 0;

      variationNumbers.forEach((variationNumber) => {
        if (findAuction(state, streamId, variationNumber) === null) {
          getOrCreateAuction(state, streamId, variationNumber);
          newlyObservedCount += 1;
        }
      });

      return {
        status: newlyObservedCount === 0 ? "already_observed" : "observed",
        observedCount: variationNumbers.length,
        newlyObservedCount,
      };
    }

    function observeBiddingVariation(state, input) {
      requireState(state);

      if (!isPlainRecord(input)) {
        fail("INVALID_ARGUMENT", "A bidding-variation observation is required.");
      }

      const streamId = requireStreamId(input.streamId);
      const variationNumber = requireVariationNumber(input.variationNumber);
      const existingAuction = findAuction(state, streamId, variationNumber);

      if (
        existingAuction &&
        (
          existingAuction.paymentStatus === "payment_complete" ||
          existingAuction.paymentStatus === "canceled" ||
          existingAuction.observedPaymentStatus !==
            OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED
        )
      ) {
        return {
          status: "ignored_sold_variation",
          variationNumber,
        };
      }

      const stream = getOrCreateStream(state, streamId);

      getOrCreateAuction(state, streamId, variationNumber);

      if (stream.activeBiddingVariationNumber === variationNumber) {
        return {
          status: "already_observed",
          variationNumber,
        };
      }

      stream.activeBiddingVariationNumber = variationNumber;

      return {
        status: "observed",
        variationNumber,
      };
    }

    function observePaymentStatuses(state, input) {
      requireState(state);

      if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail(
          "INVALID_ARGUMENT",
          "An observed-payment-statuses input is required.",
        );
      }

      const streamId = requireStreamId(input.streamId);

      if (
        !Array.isArray(input.statuses) ||
        input.statuses.length === 0 ||
        input.statuses.length > MAX_OBSERVED_PAYMENT_STATUSES
      ) {
        fail(
          "INVALID_ARGUMENT",
          `statuses must contain between 1 and ${MAX_OBSERVED_PAYMENT_STATUSES} payment statuses.`,
        );
      }

      const seenVariationNumbers = new Set();
      const statuses = input.statuses.map((status, index) => {
        if (!isPlainRecord(status)) {
          fail("INVALID_ARGUMENT", `statuses[${index}] must be an object.`);
        }

        const keys = Object.keys(status).sort();

        if (
          keys.length !== 2 ||
          keys[0] !== "observedPaymentStatus" ||
          keys[1] !== "variationNumber"
        ) {
          fail(
            "INVALID_ARGUMENT",
            `statuses[${index}] must contain exactly observedPaymentStatus and variationNumber.`,
          );
        }

        const variationNumber = requireVariationNumber(
          status.variationNumber,
        );
        const observedPaymentStatus = status.observedPaymentStatus;

        if (
          !OBSERVED_PAYMENT_STATUS_VALUES.has(observedPaymentStatus) ||
          observedPaymentStatus === OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED
        ) {
          fail(
            "INVALID_ARGUMENT",
            `statuses[${index}].observedPaymentStatus is not observable.`,
          );
        }

        if (seenVariationNumbers.has(variationNumber)) {
          fail(
            "INVALID_ARGUMENT",
            "statuses must not contain duplicate variation numbers.",
          );
        }

        seenVariationNumbers.add(variationNumber);
        return { variationNumber, observedPaymentStatus };
      });
      let updatedCount = 0;
      let ignoredCount = 0;

      statuses.forEach(({ variationNumber, observedPaymentStatus }) => {
        const auction = getOrCreateAuction(
          state,
          streamId,
          variationNumber,
        );

        if (auction.paymentStatus === "payment_complete") {
          if (
            observedPaymentStatus ===
            OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE
          ) {
            return;
          }

          ignoredCount += 1;
          return;
        }

        if (auction.paymentStatus === "canceled") {
          if (observedPaymentStatus === OBSERVED_PAYMENT_STATUSES.CANCELED) {
            return;
          }

          ignoredCount += 1;
          return;
        }

        if (auction.observedPaymentStatus === observedPaymentStatus) {
          return;
        }

        auction.observedPaymentStatus = observedPaymentStatus;

        if (observedPaymentStatus === OBSERVED_PAYMENT_STATUSES.CANCELED) {
          auction.paymentStatus = "canceled";
          auction.soldPriceCents = null;
          auction.committedUnitCostCents = null;
        }

        updatedCount += 1;
      });

      const stream = findStream(state, streamId);

      if (
        stream?.activeBiddingVariationNumber !== null &&
        statuses.some(
          ({ variationNumber }) =>
            variationNumber === stream.activeBiddingVariationNumber,
        )
      ) {
        stream.activeBiddingVariationNumber = null;
      }

      return {
        status: updatedCount === 0 ? "already_observed" : "observed",
        observedCount: statuses.length,
        updatedCount,
        ignoredCount,
      };
    }

    function unmapVariation(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const auction = findAuction(state, key.streamId, key.variationNumber);

      if (!auction) {
        fail("UNKNOWN_VARIATION", "The variation does not exist in this state.");
      }

      if (auction.sku === null) {
        return createAuctionView(state, auction);
      }

      auction.sku = null;
      auction.committedUnitCostCents = null;
      auction.mappingStatus = "unmapped";

      return createAuctionView(state, auction);
    }

    function recordPaymentComplete(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const soldPriceCents = requireSafeInteger(
        input.soldPriceCents,
        "soldPriceCents",
        1,
      );
      const auction = getOrCreateAuction(
        state,
        key.streamId,
        key.variationNumber,
      );
      const stream = findStream(state, key.streamId);

      if (auction.paymentStatus === "canceled") {
        return createAuctionView(state, auction);
      }

      if (stream?.activeBiddingVariationNumber === key.variationNumber) {
        stream.activeBiddingVariationNumber = null;
      }

      if (auction.paymentStatus === "payment_complete") {
        auction.observedPaymentStatus =
          OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE;

        if (auction.soldPriceCents !== soldPriceCents) {
          addConflict(auction, {
            code: "conflicting_sold_price",
            retainedSoldPriceCents: auction.soldPriceCents,
            observedSoldPriceCents: soldPriceCents,
          });
        }

        return createAuctionView(state, auction);
      }

      auction.paymentStatus = "payment_complete";
      auction.observedPaymentStatus =
        OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE;
      auction.soldPriceCents = soldPriceCents;
      snapshotCommittedCost(state, auction);

      return createAuctionView(state, auction);
    }

    function listPaymentFixingOrders(state, input) {
      requireState(state);

      if (!isPlainRecord(input)) {
        fail("INVALID_ARGUMENT", "A payment-fixing order query is required.");
      }

      const streamId = requireStreamId(input.streamId);
      const stream = findStream(state, streamId);

      if (!stream) {
        fail("UNKNOWN_STREAM", "The requested stream does not exist.");
      }

      const baseline = getInventoryBaselineForStream(state, streamId);
      const inventoryBySku = new Map(
        baseline.inventory.map((item) => [item.sku, item]),
      );

      return stream.variations
        .filter(
          (auction) =>
            auction.paymentStatus === "unknown" &&
            PAYMENT_FIXING_OBSERVED_STATUSES.has(
              auction.observedPaymentStatus,
            ),
        )
        .map((auction) => {
          const inventoryItem = auction.sku === null
            ? null
            : inventoryBySku.get(auction.sku) ?? null;

          return {
            variationNumber: auction.variationNumber,
            observedPaymentStatus: auction.observedPaymentStatus,
            mapped: inventoryItem !== null,
            sku: inventoryItem?.sku ?? null,
            item: inventoryItem?.item ?? null,
            style: inventoryItem?.style ?? null,
            size: inventoryItem?.size ?? null,
          };
        })
        .sort((left, right) => left.variationNumber - right.variationNumber);
    }

    function resolvePaymentFixingOrder(state, input) {
      requireState(state);

      if (!isPlainRecord(input)) {
        fail("INVALID_ARGUMENT", "A payment-fixing resolution is required.");
      }

      const key = validateAuctionKey(input);
      const resolution = input.resolution;

      if (!["payment_complete", "canceled"].includes(resolution)) {
        fail(
          "INVALID_ARGUMENT",
          "resolution must be payment_complete or canceled.",
        );
      }

      const soldPriceCents = resolution === "payment_complete"
        ? requireSafeInteger(input.soldPriceCents, "soldPriceCents", 1)
        : input.soldPriceCents;

      if (resolution === "canceled" && soldPriceCents !== null) {
        fail(
          "INVALID_ARGUMENT",
          "soldPriceCents must be null for a canceled payment.",
        );
      }

      const auction = findAuction(
        state,
        key.streamId,
        key.variationNumber,
      );

      if (!auction) {
        fail(
          "PAYMENT_ORDER_NOT_RESOLVABLE",
          "The payment-fixing variation does not exist.",
        );
      }

      if (auction.paymentStatus === resolution) {
        if (
          resolution === "payment_complete" &&
          auction.soldPriceCents !== soldPriceCents
        ) {
          fail(
            "PAYMENT_RESOLUTION_CONFLICT",
            "The completed payment already has a different final sold price.",
          );
        }

        return createAuctionView(state, auction);
      }

      if (auction.paymentStatus !== "unknown") {
        fail(
          "PAYMENT_RESOLUTION_CONFLICT",
          "The payment order already has a different terminal status.",
        );
      }

      if (
        !PAYMENT_FIXING_OBSERVED_STATUSES.has(
          auction.observedPaymentStatus,
        )
      ) {
        fail(
          "PAYMENT_ORDER_NOT_RESOLVABLE",
          "Only unresolved payment orders can be resolved after tracking ends.",
        );
      }

      if (resolution === "payment_complete") {
        return recordPaymentComplete(state, {
          ...key,
          soldPriceCents,
        });
      }

      auction.paymentStatus = "canceled";
      auction.observedPaymentStatus = OBSERVED_PAYMENT_STATUSES.CANCELED;
      auction.soldPriceCents = null;
      auction.committedUnitCostCents = null;

      const stream = findStream(state, key.streamId);

      if (stream?.activeBiddingVariationNumber === key.variationNumber) {
        stream.activeBiddingVariationNumber = null;
      }

      return createAuctionView(state, auction);
    }

    function observeAttributedGmv(state, input) {
      requireState(state);

      if (!isPlainRecord(input)) {
        fail("INVALID_ARGUMENT", "An Attributed GMV observation is required.");
      }

      const streamId = requireStreamId(input.streamId);
      const attributedGmvDisplay = requireAttributedGmvDisplay(
        input.attributedGmvDisplay,
        "attributedGmvDisplay",
      );
      const stream = getOrCreateStream(state, streamId);

      if (stream.attributedGmvDisplay === attributedGmvDisplay) {
        return {
          status: "already_observed",
          attributedGmvDisplay,
        };
      }

      stream.attributedGmvDisplay = attributedGmvDisplay;

      return {
        status: "observed",
        attributedGmvDisplay,
      };
    }

    function getAuction(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const auction = findAuction(state, key.streamId, key.variationNumber);

      return auction ? createAuctionView(state, auction) : null;
    }

    function calculateSummary(state, options = {}) {
      requireState(state);

      if (!options || typeof options !== "object" || Array.isArray(options)) {
        fail("INVALID_ARGUMENT", "Summary options must be an object.");
      }

      const selectedStream = options.streamId === undefined
        ? null
        : findStream(state, requireStreamId(options.streamId));
      const baseline = selectedStream
        ? getInventoryBaselineForStream(state, selectedStream.streamId)
        : requireActiveInventoryBaseline(state);
      const selectedStreams = options.streamId === undefined
        ? state.streams.filter(
            (stream) => stream.inventoryBaselineId === baseline.baselineId,
          )
        : selectedStream
          ? [selectedStream]
          : [];
      const auctions = selectedStreams
        .flatMap((stream) => stream.variations)
        .map((auction) => createAuctionView(state, auction))
        .sort(
          (left, right) =>
            left.streamId.localeCompare(right.streamId) ||
            left.variationNumber - right.variationNumber,
        );

      const inventory = baseline.inventory.map((item) => {
        const availability = getInventoryAvailability(state, {
          sku: item.sku,
          inventoryBaselineId: baseline.baselineId,
        });

        return {
          ...item,
          name: item.style ? `${item.item} - ${item.style}` : item.item,
          quantityReceived: item.quantityOnHandAtImport,
          soldQuantity: availability.soldQuantity,
          reservedQuantity: availability.reservedQuantity,
          remainingQuantity: availability.remainingQuantity,
          availableToTagQuantity: availability.availableToTagQuantity,
          oversoldQuantity: availability.oversoldQuantity,
          reservationShortfallQuantity:
            availability.reservationShortfallQuantity,
        };
      });
      const itemPerformance = baseline.inventory.map((item) => ({
        sku: item.sku,
        name: item.style ? `${item.item} - ${item.style}` : item.item,
        item: item.item,
        style: item.style,
        size: item.size,
        soldQuantity: 0,
        revenueCents: 0,
        costOfGoodsCents: 0,
        profitCents: 0,
      }));
      const totals = {
        auctionCount: auctions.length,
        completedPaymentCount: 0,
        canceledOrderCount: 0,
        paymentFixingCount: 0,
        totalSalesCount: 0,
        committedSalesCount: 0,
        unmappedCompletedCount: 0,
        pendingMappedCount: 0,
        conflictCount: 0,
        completedGmvCents: 0,
        committedRevenueCents: 0,
        costOfGoodsCents: 0,
        profitCents: 0,
        attributedGmvDisplay:
          selectedStream?.attributedGmvDisplay ?? null,
      };
      const warnings = [];

      auctions.forEach((auction) => {
        if (
          TOTAL_SALE_OBSERVED_PAYMENT_STATUSES.has(
            auction.observedPaymentStatus,
          )
        ) {
          totals.totalSalesCount += 1;
        }

        if (auction.paymentStatus === "payment_complete") {
          totals.completedPaymentCount += 1;
          totals.completedGmvCents += auction.soldPriceCents;
        }

        if (auction.paymentStatus === "canceled") {
          totals.canceledOrderCount += 1;
        }

        if (
          auction.paymentStatus === "unknown" &&
          PAYMENT_FIXING_OBSERVED_STATUSES.has(
            auction.observedPaymentStatus,
          )
        ) {
          totals.paymentFixingCount += 1;
        }

        if (auction.status === "unmapped_completed") {
          totals.unmappedCompletedCount += 1;
          warnings.push({
            code: "unmapped_completed_sale",
            eventKey: auction.eventKey,
          });
        }

        if (auction.status === "pending") {
          totals.pendingMappedCount += 1;
        }

        auction.conflicts.forEach((conflict) => {
          totals.conflictCount += 1;
          warnings.push({
            eventKey: auction.eventKey,
            ...conflict,
          });
        });

        auction.warnings.forEach((warning) => {
          warnings.push({
            eventKey: auction.eventKey,
            ...warning,
          });
        });

        if (!auction.committed) {
          return;
        }

        const performanceItem = itemPerformance.find(
          (item) => item.sku === auction.sku,
        );
        const profitCents =
          auction.soldPriceCents - auction.committedUnitCostCents;

        performanceItem.soldQuantity += 1;
        performanceItem.revenueCents += auction.soldPriceCents;
        performanceItem.costOfGoodsCents += auction.committedUnitCostCents;
        performanceItem.profitCents += profitCents;

        totals.committedSalesCount += 1;
        totals.committedRevenueCents += auction.soldPriceCents;
        totals.costOfGoodsCents += auction.committedUnitCostCents;
        totals.profitCents += profitCents;
      });

      inventory.forEach((item) => {
        if (item.oversoldQuantity > 0) {
          warnings.push({
            code: "negative_inventory",
            sku: item.sku,
            oversoldQuantity: item.oversoldQuantity,
          });
        }
      });

      return {
        streamId: options.streamId ?? null,
        activeBiddingVariationNumber:
          selectedStream?.activeBiddingVariationNumber ?? null,
        inventoryScope: "inventory_baseline",
        inventoryBaselineId: baseline.baselineId,
        inventory,
        itemPerformance,
        auctions,
        totals,
        warnings,
      };
    }

    return {
      MAX_OBSERVED_PAYMENT_STATUSES,
      OBSERVED_PAYMENT_STATUSES,
      ReconciliationError,
      STATE_VERSION,
      createEmptyReconciliationState,
      createReconciliationState,
      createInventoryBaseline,
      extendStreamInventoryBaseline,
      hydrateReconciliationState,
      getInventoryAvailability,
      pinStreamToInventoryBaseline,
      observePaymentStatuses,
      observeBiddingVariation,
      observeVariations,
      mapVariation,
      unmapVariation,
      recordPaymentComplete,
      listPaymentFixingOrders,
      resolvePaymentFixingOrder,
      observeAttributedGmv,
      getAuction,
      calculateSummary,
    };
  },
);
