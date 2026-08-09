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

    const STATE_VERSION = 3;
    const LEGACY_STATE_VERSION = 1;
    const OBSERVED_PAYMENT_STATE_VERSION = 2;
    const MAX_OBSERVED_VARIATIONS = 1000;
    const MAX_OBSERVED_PAYMENT_STATUSES = 1000;
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
        !Array.isArray(state.inventory) ||
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
        if (stateVersion !== STATE_VERSION) {
          failInvalidState(`${path}.code is not supported by this state version.`);
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

      const supportedPaymentStatuses = stateVersion === STATE_VERSION
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
        stateVersion === STATE_VERSION &&
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

      return hydratedAuction;
    }

    function hydrateReconciliationState(candidate) {
      try {
        requirePersistedRecord(candidate, "state", [
          "inventory",
          "streams",
          "version",
        ]);

        if (!Number.isSafeInteger(candidate.version)) {
          failInvalidState("state.version must be a safe integer.");
        }

        if (
          candidate.version !== LEGACY_STATE_VERSION &&
          candidate.version !== OBSERVED_PAYMENT_STATE_VERSION &&
          candidate.version !== STATE_VERSION
        ) {
          fail(
            "UNSUPPORTED_STATE_VERSION",
            `Reconciliation state version ${candidate.version} is not supported.`,
          );
        }

        if (!Array.isArray(candidate.inventory)) {
          failInvalidState("state.inventory must be an array.");
        }

        if (!Array.isArray(candidate.streams)) {
          failInvalidState("state.streams must be an array.");
        }

        const inventorySkus = new Set();
        const inventory = candidate.inventory.map((item, index) => {
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
            name: requirePersistedString(item.name, `${path}.name`),
            size: requirePersistedString(item.size, `${path}.size`, true),
            quantityReceived: requirePersistedInteger(
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

          if (inventorySkus.has(hydratedItem.sku)) {
            failInvalidState(`state.inventory contains duplicate SKU ${hydratedItem.sku}.`);
          }

          inventorySkus.add(hydratedItem.sku);
          return hydratedItem;
        });
        const inventoryBySku = new Map(
          inventory.map((item) => [item.sku, item]),
        );
        const streamIds = new Set();
        const streams = candidate.streams.map((stream, streamIndex) => {
          const path = `state.streams[${streamIndex}]`;

          requirePersistedRecord(stream, path, ["streamId", "variations"]);
          const streamId = requirePersistedString(
            stream.streamId,
            `${path}.streamId`,
          );

          if (streamIds.has(streamId)) {
            failInvalidState(`state.streams contains duplicate stream ${streamId}.`);
          }

          streamIds.add(streamId);

          if (!Array.isArray(stream.variations)) {
            failInvalidState(`${path}.variations must be an array.`);
          }

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

          return { streamId, variations };
        });

        return { version: STATE_VERSION, inventory, streams };
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

    function cloneInventoryItem(item, index) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        fail("INVALID_INVENTORY", `Inventory item ${index + 1} must be an object.`);
      }

      const sku = requireNonEmptyString(item.sku, `inventory[${index}].sku`);
      const name = requireNonEmptyString(
        item.name ?? sku,
        `inventory[${index}].name`,
      );
      const size = String(item.size ?? "").trim();
      const quantityReceived = requireSafeInteger(
        item.quantityReceived,
        `inventory[${index}].quantityReceived`,
        0,
      );
      const unitCostCents = requireSafeInteger(
        item.unitCostCents,
        `inventory[${index}].unitCostCents`,
        0,
      );

      return {
        sku,
        name,
        size,
        quantityReceived,
        unitCostCents,
      };
    }

    function createReconciliationState(inventory = []) {
      if (!Array.isArray(inventory)) {
        fail("INVALID_INVENTORY", "Inventory must be an array.");
      }

      const normalizedInventory = inventory.map(cloneInventoryItem);
      const seenSkus = new Set();

      normalizedInventory.forEach((item) => {
        if (seenSkus.has(item.sku)) {
          fail("DUPLICATE_SKU", `Inventory SKU ${item.sku} appears more than once.`);
        }

        seenSkus.add(item.sku);
      });

      return {
        version: STATE_VERSION,
        inventory: normalizedInventory,
        streams: [],
      };
    }

    function findInventoryItem(state, sku) {
      return state.inventory.find((item) => item.sku === sku) ?? null;
    }

    function findStream(state, streamId) {
      return state.streams.find((stream) => stream.streamId === streamId) ?? null;
    }

    function getOrCreateStream(state, streamId) {
      let stream = findStream(state, streamId);

      if (!stream) {
        stream = { streamId, variations: [] };
        state.streams.push(stream);
      }

      return stream;
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
      ).unitCostCents;
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

      if (auction.mappingStatus === "marked_unpaid") {
        return "marked_unpaid";
      }

      if (auction.sku) {
        return "pending";
      }

      return "unmapped";
    }

    function countCommittedUnits(state, sku) {
      return state.streams.reduce(
        (streamTotal, stream) =>
          streamTotal +
          stream.variations.filter(
            (auction) =>
              auction.sku === sku &&
              auction.paymentStatus === "payment_complete",
          ).length,
        0,
      );
    }

    function countReservedUnits(state, sku) {
      return state.streams.reduce(
        (streamTotal, stream) =>
          streamTotal +
          stream.variations.filter(
            (auction) =>
              auction.sku === sku &&
              auction.paymentStatus === "unknown" &&
              auction.mappingStatus === "mapped",
          ).length,
        0,
      );
    }

    function getInventoryAvailability(state, input) {
      requireState(state);

      if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail("INVALID_ARGUMENT", "An inventory availability input is required.");
      }

      const sku = requireNonEmptyString(input.sku, "sku");
      const inventoryItem = findInventoryItem(state, sku);

      if (!inventoryItem) {
        fail("UNKNOWN_SKU", `Inventory does not contain SKU ${sku}.`);
      }

      const hasStreamId = input.streamId !== undefined;
      const hasVariationNumber = input.variationNumber !== undefined;

      if (hasStreamId !== hasVariationNumber) {
        fail(
          "INVALID_ARGUMENT",
          "streamId and variationNumber must be provided together.",
        );
      }

      const currentAuction = hasStreamId
        ? findAuction(
            state,
            requireStreamId(input.streamId),
            requireVariationNumber(input.variationNumber),
          )
        : null;
      const soldQuantity = countCommittedUnits(state, sku);
      const reservedQuantity = countReservedUnits(state, sku);
      const remainingQuantity = inventoryItem.quantityReceived - soldQuantity;
      const availableToTagQuantity = remainingQuantity - reservedQuantity;
      const oversoldQuantity = Math.max(0, -remainingQuantity);
      const reservationShortfallQuantity = Math.max(
        0,
        reservedQuantity - Math.max(0, remainingQuantity),
      );
      let currentAllocation = "none";

      if (currentAuction?.sku === sku) {
        if (currentAuction.paymentStatus === "payment_complete") {
          currentAllocation = "sold";
        } else if (
          currentAuction.paymentStatus === "unknown" &&
          currentAuction.mappingStatus === "mapped"
        ) {
          currentAllocation = "reserved";
        }
      }

      return {
        sku,
        quantityReceived: inventoryItem.quantityReceived,
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
      const inventoryItem = findInventoryItem(state, sku);

      if (!inventoryItem) {
        fail("UNKNOWN_SKU", `Inventory does not contain SKU ${sku}.`);
      }

      let auction = findAuction(state, key.streamId, key.variationNumber);

      if (auction?.sku === sku) {
        return createAuctionView(state, auction);
      }

      const historicalCorrection = Boolean(
        auction &&
        (
          auction.paymentStatus === "payment_complete" ||
          auction.paymentStatus === "canceled" ||
          auction.mappingStatus === "marked_unpaid"
        ),
      );

      if (!historicalCorrection) {
        const availability = getInventoryAvailability(state, {
          sku,
          streamId: key.streamId,
          variationNumber: key.variationNumber,
        });

        if (availability.availableForCurrentAuctionQuantity <= 0) {
          fail(
            "NO_STOCK_AVAILABLE",
            `Inventory does not have an available unit for SKU ${sku}.`,
          );
        }
      }

      auction ??= getOrCreateAuction(
        state,
        key.streamId,
        key.variationNumber,
      );

      auction.sku = sku;

      if (auction.mappingStatus !== "marked_unpaid") {
        auction.mappingStatus = "mapped";
      }

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

      if (auction.mappingStatus !== "marked_unpaid") {
        auction.mappingStatus = "unmapped";
      }

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

      if (auction.mappingStatus === "marked_unpaid") {
        addConflict(auction, {
          code: "payment_completed_after_marked_unpaid",
        });
      }

      if (auction.paymentStatus === "canceled") {
        addConflict(auction, {
          code: "payment_completed_after_canceled",
        });
      }

      auction.paymentStatus = "payment_complete";
      auction.observedPaymentStatus =
        OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE;
      auction.soldPriceCents = soldPriceCents;
      snapshotCommittedCost(state, auction);

      return createAuctionView(state, auction);
    }

    function markUnpaid(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const auction = findAuction(state, key.streamId, key.variationNumber);

      if (!auction || !auction.sku) {
        fail(
          "VARIATION_NOT_MAPPED",
          "A variation must be mapped to an inventory SKU before it can be marked unpaid.",
        );
      }

      if (auction.paymentStatus === "payment_complete") {
        fail(
          "PAYMENT_ALREADY_COMPLETE",
          "A completed TikTok payment cannot be marked unpaid locally.",
        );
      }

      if (auction.paymentStatus === "canceled") {
        fail(
          "PAYMENT_ALREADY_CANCELED",
          "A canceled TikTok payment cannot be marked unpaid locally.",
        );
      }

      // The caller confirms that TikTok's payment buffer has expired. This
      // engine records that decision but does not control when the UI exposes it.
      auction.mappingStatus = "marked_unpaid";
      return createAuctionView(state, auction);
    }

    function undoMarkUnpaid(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const auction = findAuction(state, key.streamId, key.variationNumber);

      if (!auction) {
        fail("UNKNOWN_VARIATION", "The variation does not exist in this state.");
      }

      if (auction.mappingStatus === "marked_unpaid") {
        auction.mappingStatus = auction.sku ? "mapped" : "unmapped";
      }

      return createAuctionView(state, auction);
    }

    function getAuction(state, input) {
      requireState(state);
      const key = validateAuctionKey(input);
      const auction = findAuction(state, key.streamId, key.variationNumber);

      return auction ? createAuctionView(state, auction) : null;
    }

    function selectedStreams(state, options) {
      if (options.streamId === undefined) {
        return state.streams;
      }

      const streamId = requireStreamId(options.streamId);
      const stream = findStream(state, streamId);

      return stream ? [stream] : [];
    }

    function calculateSummary(state, options = {}) {
      requireState(state);

      if (!options || typeof options !== "object" || Array.isArray(options)) {
        fail("INVALID_ARGUMENT", "Summary options must be an object.");
      }

      const allAuctions = state.streams
        .flatMap((stream) => stream.variations)
        .map((auction) => createAuctionView(state, auction));
      const selectedStreamIds = new Set(
        selectedStreams(state, options).map((stream) => stream.streamId),
      );
      const auctions = allAuctions
        .filter((auction) => selectedStreamIds.has(auction.streamId))
        .sort(
          (left, right) =>
            left.streamId.localeCompare(right.streamId) ||
            left.variationNumber - right.variationNumber,
        );

      const inventory = state.inventory.map((item) => {
        const availability = getInventoryAvailability(state, { sku: item.sku });

        return {
          ...item,
          soldQuantity: availability.soldQuantity,
          reservedQuantity: availability.reservedQuantity,
          remainingQuantity: availability.remainingQuantity,
          availableToTagQuantity: availability.availableToTagQuantity,
          oversoldQuantity: availability.oversoldQuantity,
          reservationShortfallQuantity:
            availability.reservationShortfallQuantity,
        };
      });
      const itemPerformance = state.inventory.map((item) => ({
        sku: item.sku,
        name: item.name,
        size: item.size,
        soldQuantity: 0,
        revenueCents: 0,
        costOfGoodsCents: 0,
        profitCents: 0,
      }));
      const totals = {
        auctionCount: auctions.length,
        completedPaymentCount: 0,
        committedSalesCount: 0,
        unmappedCompletedCount: 0,
        pendingMappedCount: 0,
        markedUnpaidCount: 0,
        conflictCount: 0,
        completedGmvCents: 0,
        committedRevenueCents: 0,
        costOfGoodsCents: 0,
        profitCents: 0,
      };
      const warnings = [];

      auctions.forEach((auction) => {
        if (auction.paymentStatus === "payment_complete") {
          totals.completedPaymentCount += 1;
          totals.completedGmvCents += auction.soldPriceCents;
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

        if (auction.status === "marked_unpaid") {
          totals.markedUnpaidCount += 1;
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
        inventoryScope: "all_streams",
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
      createReconciliationState,
      hydrateReconciliationState,
      getInventoryAvailability,
      observePaymentStatuses,
      observeVariations,
      mapVariation,
      unmapVariation,
      recordPaymentComplete,
      markUnpaid,
      undoMarkUnpaid,
      getAuction,
      calculateSummary,
    };
  },
);
