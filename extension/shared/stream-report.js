(function initializeStreamReport(root, factory) {
  const streamReport = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamReport;
  }

  root.TikTokLiveTrackerStreamReport = streamReport;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createStreamReportModule() {
    "use strict";

    const REPORT_VERSION = 1;
    const MAX_ROWS = 1000;
    const MAX_TEXT_LENGTH = 200;
    const MAX_ID_LENGTH = 200;
    const LOCAL_STREAM_ID_PATTERN =
      /^local-stream:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
    const REPORT_ID_PATTERN =
      /^stream-report:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const ATTRIBUTED_GMV_PATTERN =
      /^\$(?:(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}|(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB])$/;
    const UNSAFE_CONTROL_CHARACTER_PATTERN =
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    const FORMULA_INJECTION_PATTERN = /^[\t ]*[=+\-@]/;
    const SHEET_HEADERS = Object.freeze([
      "sku",
      "item",
      "style",
      "size",
      "quantity_on_hand_at_import",
      "unit_cost",
    ]);
    const REASON_ORDER = Object.freeze([
      "active_bidding_at_end",
      "unresolved_orders",
      "pending_inventory_reservations",
      "payment_fixing_orders",
      "unmapped_completed_sales",
      "reconciliation_conflicts",
      "inventory_recount_required",
    ]);
    const REASON_CODES = new Set(REASON_ORDER);

    class StreamReportError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StreamReportError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new StreamReportError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function requireExactRecord(value, expectedKeys, path) {
      if (!isPlainRecord(value)) {
        fail("INVALID_REPORT", `${path} must be an object.`);
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail(
          "INVALID_REPORT",
          `${path} must contain exactly: ${sortedExpectedKeys.join(", ")}.`,
        );
      }

      return value;
    }

    function requireArray(value, path, maximum = MAX_ROWS) {
      if (!Array.isArray(value) || value.length > maximum) {
        fail(
          "INVALID_REPORT",
          `${path} must be an array with at most ${maximum} entries.`,
        );
      }

      return value;
    }

    function requireInteger(value, path, minimum = 0) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        fail(
          "INVALID_REPORT",
          `${path} must be a safe integer greater than or equal to ${minimum}.`,
        );
      }

      return value;
    }

    function requireSignedInteger(value, path) {
      if (!Number.isSafeInteger(value)) {
        fail("INVALID_REPORT", `${path} must be a safe integer.`);
      }

      return value;
    }

    function requireBoolean(value, path) {
      if (typeof value !== "boolean") {
        fail("INVALID_REPORT", `${path} must be a boolean.`);
      }

      return value;
    }

    function requireText(
      value,
      path,
      { allowEmpty = false, maximum = MAX_TEXT_LENGTH } = {},
    ) {
      if (
        typeof value !== "string" ||
        value.length > maximum ||
        (!allowEmpty && value.length === 0) ||
        value !== value.trim() ||
        UNSAFE_CONTROL_CHARACTER_PATTERN.test(value)
      ) {
        fail("INVALID_REPORT", `${path} is not valid report text.`);
      }

      return value;
    }

    function requireNullableText(value, path, options) {
      return value === null ? null : requireText(value, path, options);
    }

    function requireSku(value, path) {
      const sku = requireText(value, path, { maximum: 64 });

      if (!SKU_PATTERN.test(sku)) {
        fail("INVALID_REPORT", `${path} is not a supported SKU.`);
      }

      return sku;
    }

    function requireStreamId(value, path) {
      const streamId = requireText(value, path, {
        maximum: MAX_ID_LENGTH,
      });

      if (!LOCAL_STREAM_ID_PATTERN.test(streamId)) {
        fail("INVALID_REPORT", `${path} is not a local stream identifier.`);
      }

      return streamId;
    }

    function createReportIdForStream(streamId) {
      const normalizedStreamId = requireStreamId(streamId, "streamId");
      const uuid = LOCAL_STREAM_ID_PATTERN.exec(normalizedStreamId)[1];

      return `stream-report:${uuid}`;
    }

    function requireTimestamp(value, path) {
      if (typeof value !== "string") {
        fail("INVALID_REPORT", `${path} must be a UTC ISO timestamp.`);
      }

      const parsed = new Date(value);

      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        fail("INVALID_REPORT", `${path} must be a UTC ISO timestamp.`);
      }

      return value;
    }

    function requireNullablePositiveInteger(value, path) {
      return value === null ? null : requireInteger(value, path, 1);
    }

    function requireNullableNonNegativeInteger(value, path) {
      return value === null ? null : requireInteger(value, path, 0);
    }

    function requireNullableSignedInteger(value, path) {
      return value === null ? null : requireSignedInteger(value, path);
    }

    function centsToDecimal(cents) {
      requireInteger(cents, "unit cost", 0);
      return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    }

    function decimalToCents(value, path) {
      if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) {
        fail("INVALID_REPORT", `${path} must be a nonnegative two-decimal amount.`);
      }

      const [whole, fraction] = value.split(".");
      const cents = Number(whole) * 100 + Number(fraction);

      if (!Number.isSafeInteger(cents)) {
        fail("INVALID_REPORT", `${path} exceeds the supported money range.`);
      }

      return cents;
    }

    function deepFreeze(value) {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
      }

      Object.values(value).forEach(deepFreeze);
      return Object.freeze(value);
    }

    function compareSku(left, right) {
      return left.sku.localeCompare(right.sku);
    }

    function compareProduct(left, right) {
      return left.item.localeCompare(right.item) ||
        left.style.localeCompare(right.style);
    }

    function normalizeIdentity(value, path) {
      requireExactRecord(value, ["item", "size", "sku", "style"], path);

      return {
        sku: requireSku(value.sku, `${path}.sku`),
        item: requireText(value.item, `${path}.item`, { maximum: 160 }),
        style: requireText(value.style, `${path}.style`, {
          allowEmpty: true,
          maximum: 160,
        }),
        size: requireText(value.size, `${path}.size`, {
          allowEmpty: true,
          maximum: 80,
        }),
      };
    }

    function normalizeItemPerformance(value, path) {
      requireExactRecord(
        value,
        [
          "costOfGoodsCents",
          "grossProfitCents",
          "item",
          "revenueCents",
          "size",
          "sku",
          "soldQuantity",
          "style",
        ],
        path,
      );
      const identity = normalizeIdentity(
        {
          sku: value.sku,
          item: value.item,
          style: value.style,
          size: value.size,
        },
        path,
      );
      const soldQuantity = requireInteger(
        value.soldQuantity,
        `${path}.soldQuantity`,
      );
      const revenueCents = requireInteger(
        value.revenueCents,
        `${path}.revenueCents`,
      );
      const costOfGoodsCents = requireInteger(
        value.costOfGoodsCents,
        `${path}.costOfGoodsCents`,
      );
      const grossProfitCents = requireSignedInteger(
        value.grossProfitCents,
        `${path}.grossProfitCents`,
      );

      if (grossProfitCents !== revenueCents - costOfGoodsCents) {
        fail("INVALID_REPORT", `${path} has inconsistent profit.`);
      }

      if (soldQuantity === 0 && (revenueCents !== 0 || costOfGoodsCents !== 0)) {
        fail("INVALID_REPORT", `${path} has money without a completed sale.`);
      }

      return {
        ...identity,
        soldQuantity,
        revenueCents,
        costOfGoodsCents,
        grossProfitCents,
      };
    }

    function normalizeProductIdentity(value, path) {
      requireExactRecord(value, ["item", "skus", "style"], path);
      const skus = requireArray(value.skus, `${path}.skus`)
        .map((sku, index) => requireSku(sku, `${path}.skus[${index}]`));

      if (
        skus.length === 0 ||
        new Set(skus).size !== skus.length ||
        !valuesEqual([...skus].sort(), skus)
      ) {
        fail("INVALID_REPORT", `${path}.skus must be nonempty, unique, and sorted.`);
      }

      return {
        item: requireText(value.item, `${path}.item`, { maximum: 160 }),
        style: requireText(value.style, `${path}.style`, {
          allowEmpty: true,
          maximum: 160,
        }),
        skus,
      };
    }

    function normalizeProductPerformance(value, path) {
      requireExactRecord(
        value,
        [
          "costOfGoodsCents",
          "grossProfitCents",
          "item",
          "revenueCents",
          "skus",
          "soldQuantity",
          "style",
        ],
        path,
      );
      const identity = normalizeProductIdentity(
        { item: value.item, style: value.style, skus: value.skus },
        path,
      );
      const soldQuantity = requireInteger(
        value.soldQuantity,
        `${path}.soldQuantity`,
      );
      const revenueCents = requireInteger(
        value.revenueCents,
        `${path}.revenueCents`,
      );
      const costOfGoodsCents = requireInteger(
        value.costOfGoodsCents,
        `${path}.costOfGoodsCents`,
      );
      const grossProfitCents = requireSignedInteger(
        value.grossProfitCents,
        `${path}.grossProfitCents`,
      );

      if (
        grossProfitCents !== revenueCents - costOfGoodsCents ||
        (soldQuantity === 0 && (revenueCents !== 0 || costOfGoodsCents !== 0))
      ) {
        fail("INVALID_REPORT", `${path} has inconsistent performance totals.`);
      }

      return {
        ...identity,
        soldQuantity,
        revenueCents,
        costOfGoodsCents,
        grossProfitCents,
      };
    }

    function normalizeConflict(value, path) {
      requireExactRecord(
        value,
        ["code", "observedSoldPriceCents", "retainedSoldPriceCents"],
        path,
      );
      const code = requireText(value.code, `${path}.code`, { maximum: 80 });

      if (!/^[a-z][a-z0-9_]*$/.test(code)) {
        fail("INVALID_REPORT", `${path}.code is not supported.`);
      }

      const retainedSoldPriceCents = requireNullablePositiveInteger(
        value.retainedSoldPriceCents,
        `${path}.retainedSoldPriceCents`,
      );
      const observedSoldPriceCents = requireNullablePositiveInteger(
        value.observedSoldPriceCents,
        `${path}.observedSoldPriceCents`,
      );

      if (
        (retainedSoldPriceCents === null) !==
        (observedSoldPriceCents === null)
      ) {
        fail("INVALID_REPORT", `${path} has an incomplete price conflict.`);
      }

      if (
        retainedSoldPriceCents !== null &&
        retainedSoldPriceCents === observedSoldPriceCents
      ) {
        fail("INVALID_REPORT", `${path} repeats the retained price.`);
      }

      return {
        code,
        retainedSoldPriceCents,
        observedSoldPriceCents,
      };
    }

    function normalizeCompletedSale(value, path) {
      requireExactRecord(
        value,
        [
          "conflicts",
          "grossProfitCents",
          "item",
          "mapped",
          "size",
          "sku",
          "soldPriceCents",
          "style",
          "unitCostCents",
          "variationNumber",
        ],
        path,
      );
      const variationNumber = requireInteger(
        value.variationNumber,
        `${path}.variationNumber`,
        1,
      );
      const mapped = requireBoolean(value.mapped, `${path}.mapped`);
      const soldPriceCents = requireInteger(
        value.soldPriceCents,
        `${path}.soldPriceCents`,
        1,
      );
      const sku = value.sku === null
        ? null
        : requireSku(value.sku, `${path}.sku`);
      const item = requireNullableText(value.item, `${path}.item`, {
        maximum: 160,
      });
      const style = requireNullableText(value.style, `${path}.style`, {
        allowEmpty: true,
        maximum: 160,
      });
      const size = requireNullableText(value.size, `${path}.size`, {
        allowEmpty: true,
        maximum: 80,
      });
      const unitCostCents = requireNullableNonNegativeInteger(
        value.unitCostCents,
        `${path}.unitCostCents`,
      );
      const grossProfitCents = requireNullableSignedInteger(
        value.grossProfitCents,
        `${path}.grossProfitCents`,
      );

      if (
        mapped !== (sku !== null) ||
        mapped !== (item !== null) ||
        mapped !== (style !== null) ||
        mapped !== (size !== null) ||
        mapped !== (unitCostCents !== null) ||
        mapped !== (grossProfitCents !== null)
      ) {
        fail("INVALID_REPORT", `${path} has inconsistent mapped fields.`);
      }

      if (
        mapped &&
        grossProfitCents !== soldPriceCents - unitCostCents
      ) {
        fail("INVALID_REPORT", `${path} has inconsistent profit.`);
      }

      const conflicts = requireArray(value.conflicts, `${path}.conflicts`, 20)
        .map((conflict, index) =>
          normalizeConflict(conflict, `${path}.conflicts[${index}]`),
        );

      return {
        variationNumber,
        mapped,
        sku,
        item,
        style,
        size,
        soldPriceCents,
        unitCostCents,
        grossProfitCents,
        conflicts,
      };
    }

    function normalizeInventoryRow(value, path) {
      requireExactRecord(
        value,
        [
          "availableAfterReservationsQuantity",
          "baselineSoldQuantity",
          "calculatedRemainingQuantity",
          "item",
          "openingQuantity",
          "oversoldQuantity",
          "pendingQuantity",
          "replacementQuantity",
          "requiresRecount",
          "size",
          "sku",
          "streamSoldQuantity",
          "style",
          "unitCostCents",
        ],
        path,
      );
      const identity = normalizeIdentity(
        {
          sku: value.sku,
          item: value.item,
          style: value.style,
          size: value.size,
        },
        path,
      );
      const unitCostCents = requireInteger(
        value.unitCostCents,
        `${path}.unitCostCents`,
      );
      const openingQuantity = requireInteger(
        value.openingQuantity,
        `${path}.openingQuantity`,
      );
      const streamSoldQuantity = requireInteger(
        value.streamSoldQuantity,
        `${path}.streamSoldQuantity`,
      );
      const baselineSoldQuantity = requireInteger(
        value.baselineSoldQuantity,
        `${path}.baselineSoldQuantity`,
      );
      const pendingQuantity = requireInteger(
        value.pendingQuantity,
        `${path}.pendingQuantity`,
      );
      const calculatedRemainingQuantity = requireSignedInteger(
        value.calculatedRemainingQuantity,
        `${path}.calculatedRemainingQuantity`,
      );
      const replacementQuantity = requireInteger(
        value.replacementQuantity,
        `${path}.replacementQuantity`,
      );
      const availableAfterReservationsQuantity = requireInteger(
        value.availableAfterReservationsQuantity,
        `${path}.availableAfterReservationsQuantity`,
      );
      const oversoldQuantity = requireInteger(
        value.oversoldQuantity,
        `${path}.oversoldQuantity`,
      );
      const requiresRecount = requireBoolean(
        value.requiresRecount,
        `${path}.requiresRecount`,
      );

      if (
        calculatedRemainingQuantity !== openingQuantity - baselineSoldQuantity ||
        replacementQuantity !== Math.max(0, calculatedRemainingQuantity) ||
        availableAfterReservationsQuantity !==
          Math.max(0, calculatedRemainingQuantity - pendingQuantity) ||
        oversoldQuantity !==
          Math.max(
            0,
            baselineSoldQuantity + pendingQuantity - openingQuantity,
          ) ||
        requiresRecount !== (oversoldQuantity > 0) ||
        streamSoldQuantity > baselineSoldQuantity
      ) {
        fail("INVALID_REPORT", `${path} has inconsistent inventory quantities.`);
      }

      return {
        ...identity,
        unitCostCents,
        openingQuantity,
        streamSoldQuantity,
        baselineSoldQuantity,
        pendingQuantity,
        calculatedRemainingQuantity,
        replacementQuantity,
        availableAfterReservationsQuantity,
        oversoldQuantity,
        requiresRecount,
      };
    }

    function normalizeSheetRow(value, path) {
      requireExactRecord(value, SHEET_HEADERS, path);
      const quantity = requireInteger(
        value.quantity_on_hand_at_import,
        `${path}.quantity_on_hand_at_import`,
      );
      const unitCost = requireText(value.unit_cost, `${path}.unit_cost`, {
        maximum: 30,
      });

      decimalToCents(unitCost, `${path}.unit_cost`);

      return {
        sku: requireSku(value.sku, `${path}.sku`),
        item: requireText(value.item, `${path}.item`, { maximum: 160 }),
        style: requireText(value.style, `${path}.style`, {
          allowEmpty: true,
          maximum: 160,
        }),
        size: requireText(value.size, `${path}.size`, {
          allowEmpty: true,
          maximum: 80,
        }),
        quantity_on_hand_at_import: quantity,
        unit_cost: unitCost,
      };
    }

    function normalizeTopMetric(value, path, expectedMetric) {
      if (value === null) {
        return null;
      }

      requireExactRecord(value, ["items", "metric", "value"], path);

      if (value.metric !== expectedMetric) {
        fail("INVALID_REPORT", `${path}.metric is not supported.`);
      }

      const metricValue = expectedMetric === "sold_quantity"
        ? requireInteger(value.value, `${path}.value`, 1)
        : requireSignedInteger(value.value, `${path}.value`);
      const items = requireArray(value.items, `${path}.items`)
        .map((item, index) => normalizeIdentity(item, `${path}.items[${index}]`));

      if (items.length === 0) {
        fail("INVALID_REPORT", `${path}.items cannot be empty.`);
      }

      const skuSet = new Set(items.map((item) => item.sku));

      if (skuSet.size !== items.length) {
        fail("INVALID_REPORT", `${path}.items contains duplicate SKUs.`);
      }

      return { metric: expectedMetric, value: metricValue, items };
    }

    function normalizeTopProductMetric(value, path, expectedMetric) {
      if (value === null) {
        return null;
      }

      requireExactRecord(value, ["items", "metric", "value"], path);

      if (value.metric !== expectedMetric) {
        fail("INVALID_REPORT", `${path}.metric is not supported.`);
      }

      const metricValue = expectedMetric === "sold_quantity"
        ? requireInteger(value.value, `${path}.value`, 1)
        : requireSignedInteger(value.value, `${path}.value`);
      const items = requireArray(value.items, `${path}.items`)
        .map((item, index) =>
          normalizeProductIdentity(item, `${path}.items[${index}]`),
        );

      if (items.length === 0) {
        fail("INVALID_REPORT", `${path}.items cannot be empty.`);
      }

      const identities = new Set(
        items.map((item) => JSON.stringify([item.item, item.style])),
      );

      if (identities.size !== items.length) {
        fail("INVALID_REPORT", `${path}.items contains duplicate products.`);
      }

      return { metric: expectedMetric, value: metricValue, items };
    }

    function normalizeWarning(value, path) {
      requireExactRecord(value, ["code", "count", "sku"], path);
      const code = requireText(value.code, `${path}.code`, { maximum: 80 });

      if (!REASON_CODES.has(code)) {
        fail("INVALID_REPORT", `${path}.code is not supported.`);
      }

      const sku = value.sku === null
        ? null
        : requireSku(value.sku, `${path}.sku`);

      if ((code === "inventory_recount_required") !== (sku !== null)) {
        fail("INVALID_REPORT", `${path}.sku does not match its warning code.`);
      }

      return {
        code,
        count: requireInteger(value.count, `${path}.count`, 1),
        sku,
      };
    }

    function normalizeMetadata(value) {
      requireExactRecord(
        value,
        [
          "activeBiddingVariationNumber",
          "endedAt",
          "generatedAt",
          "inventoryBaselineId",
          "startedAt",
          "streamId",
        ],
        "report.metadata",
      );
      const startedAt = requireTimestamp(value.startedAt, "report.metadata.startedAt");
      const endedAt = requireTimestamp(value.endedAt, "report.metadata.endedAt");
      const generatedAt = requireTimestamp(
        value.generatedAt,
        "report.metadata.generatedAt",
      );

      if (
        Date.parse(endedAt) < Date.parse(startedAt) ||
        Date.parse(generatedAt) < Date.parse(endedAt)
      ) {
        fail("INVALID_REPORT", "Report timestamps are out of order.");
      }

      return {
        streamId: requireStreamId(
          value.streamId,
          "report.metadata.streamId",
        ),
        startedAt,
        endedAt,
        generatedAt,
        inventoryBaselineId: requireText(
          value.inventoryBaselineId,
          "report.metadata.inventoryBaselineId",
          { maximum: MAX_ID_LENGTH },
        ),
        activeBiddingVariationNumber: requireNullablePositiveInteger(
          value.activeBiddingVariationNumber,
          "report.metadata.activeBiddingVariationNumber",
        ),
      };
    }

    function normalizeTotals(value) {
      const nonnegativeKeys = [
        "auctionCount",
        "canceledOrderCount",
        "committedRevenueCents",
        "committedSalesCount",
        "completedGmvCents",
        "completedPaymentCount",
        "conflictCount",
        "costOfGoodsCents",
        "paymentFixingCount",
        "pendingMappedCount",
        "totalSalesCount",
        "unmappedCompletedCount",
        "unresolvedOrderCount",
      ];

      requireExactRecord(
        value,
        [...nonnegativeKeys, "attributedGmvDisplay", "grossProfitCents"],
        "report.totals",
      );
      const totals = {};

      nonnegativeKeys.forEach((key) => {
        totals[key] = requireInteger(value[key], `report.totals.${key}`);
      });
      totals.grossProfitCents = requireSignedInteger(
        value.grossProfitCents,
        "report.totals.grossProfitCents",
      );
      totals.attributedGmvDisplay = value.attributedGmvDisplay === null
        ? null
        : requireText(
            value.attributedGmvDisplay,
            "report.totals.attributedGmvDisplay",
            { maximum: 24 },
          );

      if (
        totals.attributedGmvDisplay !== null &&
        !ATTRIBUTED_GMV_PATTERN.test(totals.attributedGmvDisplay)
      ) {
        fail("INVALID_REPORT", "report.totals.attributedGmvDisplay is invalid.");
      }

      if (
        totals.grossProfitCents !==
          totals.committedRevenueCents - totals.costOfGoodsCents ||
        totals.completedPaymentCount > totals.auctionCount ||
        totals.canceledOrderCount > totals.auctionCount ||
        totals.totalSalesCount > totals.auctionCount ||
        totals.committedSalesCount > totals.completedPaymentCount ||
        totals.unmappedCompletedCount !==
          totals.completedPaymentCount - totals.committedSalesCount ||
        totals.pendingMappedCount > totals.unresolvedOrderCount ||
        totals.paymentFixingCount > totals.unresolvedOrderCount
      ) {
        fail("INVALID_REPORT", "report.totals is internally inconsistent.");
      }

      return totals;
    }

    function normalizeCompleteness(value) {
      requireExactRecord(value, ["reasonCodes", "status"], "report.completeness");

      if (!["final", "provisional"].includes(value.status)) {
        fail("INVALID_REPORT", "report.completeness.status is not supported.");
      }

      const reasonCodes = requireArray(
        value.reasonCodes,
        "report.completeness.reasonCodes",
        REASON_ORDER.length,
      ).map((code, index) => {
        const normalized = requireText(
          code,
          `report.completeness.reasonCodes[${index}]`,
          { maximum: 80 },
        );

        if (!REASON_CODES.has(normalized)) {
          fail("INVALID_REPORT", "Report contains an unsupported reason code.");
        }

        return normalized;
      });

      if (
        new Set(reasonCodes).size !== reasonCodes.length ||
        reasonCodes.some(
          (code, index) => REASON_ORDER.indexOf(code) <=
            REASON_ORDER.indexOf(reasonCodes[index - 1]),
        ) ||
        (value.status === "final") !== (reasonCodes.length === 0)
      ) {
        fail("INVALID_REPORT", "report.completeness is internally inconsistent.");
      }

      return { status: value.status, reasonCodes };
    }

    function expectedTopMetric(performance, metric, valueKey) {
      const candidates = performance.filter((item) => item.soldQuantity > 0);

      if (candidates.length === 0) {
        return null;
      }

      const maximum = Math.max(...candidates.map((item) => item[valueKey]));
      return {
        metric,
        value: maximum,
        items: candidates
          .filter((item) => item[valueKey] === maximum)
          .map(({ sku, item, style, size }) => ({ sku, item, style, size }))
          .sort(compareSku),
      };
    }

    function createProductPerformance(itemPerformance) {
      const groups = new Map();

      itemPerformance.forEach((item) => {
        const key = JSON.stringify([item.item, item.style]);
        let product = groups.get(key);

        if (!product) {
          product = {
            item: item.item,
            style: item.style,
            skus: [],
            soldQuantity: 0,
            revenueCents: 0,
            costOfGoodsCents: 0,
            grossProfitCents: 0,
          };
          groups.set(key, product);
        }

        product.skus.push(item.sku);
        product.soldQuantity += item.soldQuantity;
        product.revenueCents += item.revenueCents;
        product.costOfGoodsCents += item.costOfGoodsCents;
        product.grossProfitCents += item.grossProfitCents;
      });

      return [...groups.values()]
        .map((product) => ({
          ...product,
          skus: product.skus.sort(),
        }))
        .sort(compareProduct);
    }

    function expectedTopProductMetric(performance, metric, valueKey) {
      const candidates = performance.filter((item) => item.soldQuantity > 0);

      if (candidates.length === 0) {
        return null;
      }

      const maximum = Math.max(...candidates.map((item) => item[valueKey]));
      return {
        metric,
        value: maximum,
        items: candidates
          .filter((item) => item[valueKey] === maximum)
          .map(({ item, style, skus }) => ({ item, style, skus: [...skus] }))
          .sort(compareProduct),
      };
    }

    function valuesEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    function expectedWarnings(metadata, totals, inventory) {
      const warnings = [];

      if (metadata.activeBiddingVariationNumber !== null) {
        warnings.push({ code: "active_bidding_at_end", count: 1, sku: null });
      }

      [
        ["unresolved_orders", totals.unresolvedOrderCount],
        ["pending_inventory_reservations", totals.pendingMappedCount],
        ["payment_fixing_orders", totals.paymentFixingCount],
        ["unmapped_completed_sales", totals.unmappedCompletedCount],
        ["reconciliation_conflicts", totals.conflictCount],
      ].forEach(([code, count]) => {
        if (count > 0) {
          warnings.push({ code, count, sku: null });
        }
      });

      inventory
        .filter((row) => row.requiresRecount)
        .forEach((row) => {
          warnings.push({
            code: "inventory_recount_required",
            count: row.oversoldQuantity,
            sku: row.sku,
          });
        });

      return warnings;
    }

    function hydrateStreamReport(candidate) {
      requireExactRecord(
        candidate,
        [
          "completedSales",
          "completeness",
          "inventory",
          "inventoryUpdateLines",
          "itemPerformance",
          "metadata",
          "productPerformance",
          "reportId",
          "sheetRows",
          "topItems",
          "topProducts",
          "totals",
          "version",
          "warnings",
        ],
        "report",
      );

      if (candidate.version !== REPORT_VERSION) {
        fail(
          "UNSUPPORTED_REPORT_VERSION",
          `Stream report version ${candidate.version} is not supported.`,
        );
      }

      const reportId = requireText(candidate.reportId, "report.reportId", {
        maximum: 50,
      });
      const metadata = normalizeMetadata(candidate.metadata);

      if (
        !REPORT_ID_PATTERN.test(reportId) ||
        reportId !== createReportIdForStream(metadata.streamId)
      ) {
        fail("INVALID_REPORT", "report.reportId does not match its stream.");
      }

      const completeness = normalizeCompleteness(candidate.completeness);
      const totals = normalizeTotals(candidate.totals);
      const itemPerformance = requireArray(
        candidate.itemPerformance,
        "report.itemPerformance",
      ).map((item, index) =>
        normalizeItemPerformance(item, `report.itemPerformance[${index}]`),
      );
      const productPerformance = requireArray(
        candidate.productPerformance,
        "report.productPerformance",
      ).map((product, index) =>
        normalizeProductPerformance(
          product,
          `report.productPerformance[${index}]`,
        ),
      );
      const completedSales = requireArray(
        candidate.completedSales,
        "report.completedSales",
      ).map((sale, index) =>
        normalizeCompletedSale(sale, `report.completedSales[${index}]`),
      );
      const inventory = requireArray(candidate.inventory, "report.inventory")
        .map((row, index) =>
          normalizeInventoryRow(row, `report.inventory[${index}]`),
        );
      const inventoryUpdateLines = requireArray(
        candidate.inventoryUpdateLines,
        "report.inventoryUpdateLines",
      ).map((line, index) =>
        requireText(line, `report.inventoryUpdateLines[${index}]`, {
          maximum: 100,
        }),
      );
      const sheetRows = requireArray(candidate.sheetRows, "report.sheetRows")
        .map((row, index) => normalizeSheetRow(row, `report.sheetRows[${index}]`));
      requireExactRecord(
        candidate.topItems,
        ["mostProfitable", "mostSold"],
        "report.topItems",
      );
      const topItems = {
        mostSold: normalizeTopMetric(
          candidate.topItems.mostSold,
          "report.topItems.mostSold",
          "sold_quantity",
        ),
        mostProfitable: normalizeTopMetric(
          candidate.topItems.mostProfitable,
          "report.topItems.mostProfitable",
          "gross_profit_cents",
        ),
      };
      requireExactRecord(
        candidate.topProducts,
        ["mostProfitable", "mostSold"],
        "report.topProducts",
      );
      const topProducts = {
        mostSold: normalizeTopProductMetric(
          candidate.topProducts.mostSold,
          "report.topProducts.mostSold",
          "sold_quantity",
        ),
        mostProfitable: normalizeTopProductMetric(
          candidate.topProducts.mostProfitable,
          "report.topProducts.mostProfitable",
          "gross_profit_cents",
        ),
      };
      const warnings = requireArray(
        candidate.warnings,
        "report.warnings",
        MAX_ROWS + 6,
      )
        .map((warning, index) =>
          normalizeWarning(warning, `report.warnings[${index}]`),
        );

      const skuSets = [itemPerformance, inventory, sheetRows].map(
        (rows) => rows.map((row) => row.sku),
      );
      const uniqueSkus = new Set(skuSets[0]);
      const completedVariationNumbers = completedSales.map(
        (sale) => sale.variationNumber,
      );

      if (
        uniqueSkus.size !== itemPerformance.length ||
        skuSets.some((skus) => new Set(skus).size !== skus.length) ||
        !skuSets.every((skus) => valuesEqual(skus, skuSets[0])) ||
        new Set(completedVariationNumbers).size !== completedSales.length ||
        !valuesEqual(
          [...completedVariationNumbers].sort((left, right) => left - right),
          completedVariationNumbers,
        ) ||
        !valuesEqual([...skuSets[0]].sort(), skuSets[0])
      ) {
        fail("INVALID_REPORT", "Report rows are not uniquely and deterministically ordered.");
      }

      const performanceBySku = new Map(
        itemPerformance.map((item) => [item.sku, item]),
      );
      const inventoryBySku = new Map(
        inventory.map((item) => [item.sku, item]),
      );
      const committedSalesCount = itemPerformance.reduce(
        (total, item) => total + item.soldQuantity,
        0,
      );
      const committedRevenueCents = itemPerformance.reduce(
        (total, item) => total + item.revenueCents,
        0,
      );
      const costOfGoodsCents = itemPerformance.reduce(
        (total, item) => total + item.costOfGoodsCents,
        0,
      );

      if (
        completedSales.length !== totals.completedPaymentCount ||
        completedSales.filter((sale) => !sale.mapped).length !==
          totals.unmappedCompletedCount ||
        completedSales.reduce(
          (total, sale) => total + sale.soldPriceCents,
          0,
        ) !== totals.completedGmvCents ||
        completedSales.reduce(
          (total, sale) => total + sale.conflicts.length,
          0,
        ) !== totals.conflictCount ||
        committedSalesCount !== totals.committedSalesCount ||
        committedRevenueCents !== totals.committedRevenueCents ||
        costOfGoodsCents !== totals.costOfGoodsCents
      ) {
        fail("INVALID_REPORT", "Report sales do not match report totals.");
      }

      const completedBySku = new Map(
        itemPerformance.map((item) => [
          item.sku,
          {
            soldQuantity: 0,
            revenueCents: 0,
            costOfGoodsCents: 0,
            grossProfitCents: 0,
          },
        ]),
      );

      completedSales
        .filter((sale) => sale.mapped)
        .forEach((sale) => {
          const inventoryItem = inventoryBySku.get(sale.sku);
          const aggregate = completedBySku.get(sale.sku);

          if (
            !inventoryItem ||
            !aggregate ||
            sale.item !== inventoryItem.item ||
            sale.style !== inventoryItem.style ||
            sale.size !== inventoryItem.size ||
            sale.unitCostCents !== inventoryItem.unitCostCents
          ) {
            fail("INVALID_REPORT", "A completed sale does not match its inventory item.");
          }

          aggregate.soldQuantity += 1;
          aggregate.revenueCents += sale.soldPriceCents;
          aggregate.costOfGoodsCents += sale.unitCostCents;
          aggregate.grossProfitCents += sale.grossProfitCents;
        });

      itemPerformance.forEach((item) => {
        const aggregate = completedBySku.get(item.sku);

        if (
          !aggregate ||
          aggregate.soldQuantity !== item.soldQuantity ||
          aggregate.revenueCents !== item.revenueCents ||
          aggregate.costOfGoodsCents !== item.costOfGoodsCents ||
          aggregate.grossProfitCents !== item.grossProfitCents
        ) {
          fail("INVALID_REPORT", "Completed sales do not match SKU performance.");
        }
      });

      inventory.forEach((row, index) => {
        const performance = performanceBySku.get(row.sku);
        const sheetRow = sheetRows[index];
        const expectedSheetRow = {
          sku: row.sku,
          item: row.item,
          style: row.style,
          size: row.size,
          quantity_on_hand_at_import: row.replacementQuantity,
          unit_cost: centsToDecimal(row.unitCostCents),
        };

        if (
          !performance ||
          performance.item !== row.item ||
          performance.style !== row.style ||
          performance.size !== row.size ||
          performance.soldQuantity !== row.streamSoldQuantity ||
          !valuesEqual(sheetRow, expectedSheetRow) ||
          inventoryUpdateLines[index] !==
            `SKU: ${row.sku} Updated count: ${row.replacementQuantity}`
        ) {
          fail("INVALID_REPORT", "Report inventory exports do not match inventory rows.");
        }
      });

      const expectedTopItems = {
        mostSold: expectedTopMetric(
          itemPerformance,
          "sold_quantity",
          "soldQuantity",
        ),
        mostProfitable: expectedTopMetric(
          itemPerformance,
          "gross_profit_cents",
          "grossProfitCents",
        ),
      };
      const expectedProductPerformance = createProductPerformance(
        itemPerformance,
      );
      const expectedTopProducts = {
        mostSold: expectedTopProductMetric(
          expectedProductPerformance,
          "sold_quantity",
          "soldQuantity",
        ),
        mostProfitable: expectedTopProductMetric(
          expectedProductPerformance,
          "gross_profit_cents",
          "grossProfitCents",
        ),
      };
      const normalizedWarnings = expectedWarnings(metadata, totals, inventory);
      const expectedReasonCodes = REASON_ORDER.filter((code) =>
        normalizedWarnings.some((warning) => warning.code === code),
      );

      if (
        !valuesEqual(topItems, expectedTopItems) ||
        !valuesEqual(productPerformance, expectedProductPerformance) ||
        !valuesEqual(topProducts, expectedTopProducts) ||
        !valuesEqual(warnings, normalizedWarnings) ||
        !valuesEqual(completeness.reasonCodes, expectedReasonCodes) ||
        completeness.status !==
          (expectedReasonCodes.length === 0 ? "final" : "provisional")
      ) {
        fail("INVALID_REPORT", "Report derived indicators are inconsistent.");
      }

      return deepFreeze({
        version: REPORT_VERSION,
        reportId,
        metadata,
        completeness,
        totals,
        topItems,
        topProducts,
        itemPerformance,
        productPerformance,
        completedSales,
        inventory,
        inventoryUpdateLines,
        sheetRows,
        warnings,
      });
    }

    function normalizeBuilderOptions(options) {
      requireExactRecord(
        options,
        [
          "endedAt",
          "generatedAt",
          "reconciliation",
          "reconciliationState",
          "startedAt",
          "streamId",
        ],
        "options",
      );

      if (
        !options.reconciliation ||
        typeof options.reconciliation.hydrateReconciliationState !== "function" ||
        typeof options.reconciliation.calculateSummary !== "function"
      ) {
        fail(
          "INVALID_DEPENDENCY",
          "reconciliation must provide hydration and summary calculation.",
        );
      }

      return {
        reconciliation: options.reconciliation,
        reconciliationState: options.reconciliationState,
        streamId: requireStreamId(options.streamId, "options.streamId"),
        startedAt: requireTimestamp(options.startedAt, "options.startedAt"),
        endedAt: requireTimestamp(options.endedAt, "options.endedAt"),
        generatedAt: requireTimestamp(options.generatedAt, "options.generatedAt"),
      };
    }

    function normalizeAuctionConflict(conflict) {
      return {
        code: conflict.code,
        retainedSoldPriceCents: conflict.retainedSoldPriceCents ?? null,
        observedSoldPriceCents: conflict.observedSoldPriceCents ?? null,
      };
    }

    function createStreamReport(options) {
      const normalized = normalizeBuilderOptions(options);
      const state = normalized.reconciliation.hydrateReconciliationState(
        normalized.reconciliationState,
      );
      const stream = state.streams.find(
        (candidate) => candidate.streamId === normalized.streamId,
      );

      if (!stream) {
        fail("UNKNOWN_STREAM", "The requested stream does not exist.");
      }

      const summary = normalized.reconciliation.calculateSummary(state, {
        streamId: normalized.streamId,
      });
      const inventoryBySku = new Map(
        summary.inventory.map((item) => [item.sku, item]),
      );
      const performanceBySku = new Map(
        summary.itemPerformance.map((item) => [item.sku, item]),
      );
      const itemPerformance = summary.itemPerformance
        .map((item) => ({
          sku: item.sku,
          item: item.item,
          style: item.style,
          size: item.size,
          soldQuantity: item.soldQuantity,
          revenueCents: item.revenueCents,
          costOfGoodsCents: item.costOfGoodsCents,
          grossProfitCents: item.profitCents,
        }))
        .sort(compareSku);
      const productPerformance = createProductPerformance(itemPerformance);
      const completedSales = summary.auctions
        .filter((auction) => auction.paymentStatus === "payment_complete")
        .map((auction) => {
          const inventoryItem = auction.sku
            ? inventoryBySku.get(auction.sku) ?? null
            : null;

          return {
            variationNumber: auction.variationNumber,
            mapped: inventoryItem !== null,
            sku: inventoryItem?.sku ?? null,
            item: inventoryItem?.item ?? null,
            style: inventoryItem?.style ?? null,
            size: inventoryItem?.size ?? null,
            soldPriceCents: auction.soldPriceCents,
            unitCostCents: auction.committedUnitCostCents,
            grossProfitCents: auction.profitCents,
            conflicts: auction.conflicts.map(normalizeAuctionConflict),
          };
        })
        .sort((left, right) => left.variationNumber - right.variationNumber);
      const inventory = summary.inventory
        .map((item) => {
          const performance = performanceBySku.get(item.sku);
          const calculatedRemainingQuantity = item.remainingQuantity;
          const replacementQuantity = Math.max(
            0,
            calculatedRemainingQuantity,
          );

          return {
            sku: item.sku,
            item: item.item,
            style: item.style,
            size: item.size,
            unitCostCents: item.unitCostCents,
            openingQuantity: item.quantityOnHandAtImport,
            streamSoldQuantity: performance?.soldQuantity ?? 0,
            baselineSoldQuantity: item.soldQuantity,
            pendingQuantity: item.reservedQuantity,
            calculatedRemainingQuantity,
            replacementQuantity,
            availableAfterReservationsQuantity: Math.max(
              0,
              item.availableToTagQuantity,
            ),
            oversoldQuantity: item.oversoldQuantity,
            requiresRecount: item.oversoldQuantity > 0,
          };
        })
        .sort(compareSku);
      const unresolvedOrderCount = summary.auctions.filter(
        (auction) => auction.paymentStatus === "unknown",
      ).length;
      const metadata = {
        streamId: normalized.streamId,
        startedAt: normalized.startedAt,
        endedAt: normalized.endedAt,
        generatedAt: normalized.generatedAt,
        inventoryBaselineId: summary.inventoryBaselineId,
        activeBiddingVariationNumber:
          summary.activeBiddingVariationNumber,
      };
      const totals = {
        auctionCount: summary.totals.auctionCount,
        completedPaymentCount: summary.totals.completedPaymentCount,
        canceledOrderCount: summary.totals.canceledOrderCount,
        paymentFixingCount: summary.totals.paymentFixingCount,
        totalSalesCount: summary.totals.totalSalesCount,
        committedSalesCount: summary.totals.committedSalesCount,
        unmappedCompletedCount: summary.totals.unmappedCompletedCount,
        pendingMappedCount: summary.totals.pendingMappedCount,
        conflictCount: summary.totals.conflictCount,
        unresolvedOrderCount,
        completedGmvCents: summary.totals.completedGmvCents,
        committedRevenueCents: summary.totals.committedRevenueCents,
        costOfGoodsCents: summary.totals.costOfGoodsCents,
        grossProfitCents: summary.totals.profitCents,
        attributedGmvDisplay: summary.totals.attributedGmvDisplay,
      };
      const warnings = expectedWarnings(metadata, totals, inventory);
      const reasonCodes = REASON_ORDER.filter((code) =>
        warnings.some((warning) => warning.code === code),
      );
      const sheetRows = inventory.map((row) => ({
        sku: row.sku,
        item: row.item,
        style: row.style,
        size: row.size,
        quantity_on_hand_at_import: row.replacementQuantity,
        unit_cost: centsToDecimal(row.unitCostCents),
      }));

      return hydrateStreamReport({
        version: REPORT_VERSION,
        reportId: createReportIdForStream(normalized.streamId),
        metadata,
        completeness: {
          status: reasonCodes.length === 0 ? "final" : "provisional",
          reasonCodes,
        },
        totals,
        topItems: {
          mostSold: expectedTopMetric(
            itemPerformance,
            "sold_quantity",
            "soldQuantity",
          ),
          mostProfitable: expectedTopMetric(
            itemPerformance,
            "gross_profit_cents",
            "grossProfitCents",
          ),
        },
        topProducts: {
          mostSold: expectedTopProductMetric(
            productPerformance,
            "sold_quantity",
            "soldQuantity",
          ),
          mostProfitable: expectedTopProductMetric(
            productPerformance,
            "gross_profit_cents",
            "grossProfitCents",
          ),
        },
        itemPerformance,
        productPerformance,
        completedSales,
        inventory,
        inventoryUpdateLines: inventory.map(
          (row) => `SKU: ${row.sku} Updated count: ${row.replacementQuantity}`,
        ),
        sheetRows,
        warnings,
      });
    }

    function normalizeUnitCostCorrection(input) {
      if (!isPlainRecord(input)) {
        fail("INVALID_ARGUMENT", "A report unit-cost correction is required.");
      }

      const actualKeys = Object.keys(input).sort();
      const expectedKeys = ["sku", "unitCostCents"];

      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        fail(
          "INVALID_ARGUMENT",
          "A report unit-cost correction must contain exactly sku and unitCostCents.",
        );
      }

      if (
        typeof input.sku !== "string" ||
        input.sku !== input.sku.trim() ||
        !SKU_PATTERN.test(input.sku)
      ) {
        fail("INVALID_ARGUMENT", "sku is not a supported SKU.");
      }

      if (!Number.isSafeInteger(input.unitCostCents) || input.unitCostCents < 0) {
        fail(
          "INVALID_ARGUMENT",
          "unitCostCents must be a nonnegative safe integer.",
        );
      }

      return {
        sku: input.sku,
        unitCostCents: input.unitCostCents,
      };
    }

    function correctReportUnitCost(report, input) {
      const hydrated = hydrateStreamReport(report);
      const correction = normalizeUnitCostCorrection(input);
      const inventoryItem = hydrated.inventory.find(
        (item) => item.sku === correction.sku,
      );

      if (!inventoryItem) {
        fail(
          "UNKNOWN_SKU",
          `Report inventory does not contain SKU ${correction.sku}.`,
        );
      }

      const projectedCostOfGoods = hydrated.itemPerformance.reduce(
        (total, item) =>
          total +
          (item.sku === correction.sku
            ? BigInt(item.soldQuantity) * BigInt(correction.unitCostCents)
            : BigInt(item.costOfGoodsCents)),
        0n,
      );

      if (projectedCostOfGoods > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail(
          "INVALID_ARGUMENT",
          "unitCostCents would make report cost totals unsafe.",
        );
      }

      const completedSales = hydrated.completedSales.map((sale) =>
        sale.mapped && sale.sku === correction.sku
          ? {
              ...sale,
              unitCostCents: correction.unitCostCents,
              grossProfitCents:
                sale.soldPriceCents - correction.unitCostCents,
            }
          : sale,
      );
      const itemPerformance = hydrated.itemPerformance.map((item) => {
        if (item.sku !== correction.sku) {
          return item;
        }

        const costOfGoodsCents = Number(
          BigInt(item.soldQuantity) * BigInt(correction.unitCostCents),
        );

        return {
          ...item,
          costOfGoodsCents,
          grossProfitCents: item.revenueCents - costOfGoodsCents,
        };
      });
      const productPerformance = createProductPerformance(itemPerformance);
      const inventory = hydrated.inventory.map((item) =>
        item.sku === correction.sku
          ? { ...item, unitCostCents: correction.unitCostCents }
          : item,
      );
      const sheetRows = hydrated.sheetRows.map((row) =>
        row.sku === correction.sku
          ? { ...row, unit_cost: centsToDecimal(correction.unitCostCents) }
          : row,
      );
      const costOfGoodsCents = Number(projectedCostOfGoods);
      const totals = {
        ...hydrated.totals,
        costOfGoodsCents,
        grossProfitCents:
          hydrated.totals.committedRevenueCents - costOfGoodsCents,
      };

      return hydrateStreamReport({
        ...hydrated,
        totals,
        topItems: {
          mostSold: expectedTopMetric(
            itemPerformance,
            "sold_quantity",
            "soldQuantity",
          ),
          mostProfitable: expectedTopMetric(
            itemPerformance,
            "gross_profit_cents",
            "grossProfitCents",
          ),
        },
        topProducts: {
          mostSold: expectedTopProductMetric(
            productPerformance,
            "sold_quantity",
            "soldQuantity",
          ),
          mostProfitable: expectedTopProductMetric(
            productPerformance,
            "gross_profit_cents",
            "grossProfitCents",
          ),
        },
        itemPerformance,
        productPerformance,
        completedSales,
        inventory,
        sheetRows,
      });
    }

    function protectFormulaText(value) {
      return FORMULA_INJECTION_PATTERN.test(value) ? `'${value}` : value;
    }

    function escapeDelimitedField(value, delimiter, textField) {
      const protectedValue = textField
        ? protectFormulaText(String(value))
        : String(value);

      if (
        protectedValue.includes(delimiter) ||
        protectedValue.includes('"') ||
        /[\r\n]/.test(protectedValue)
      ) {
        return `"${protectedValue.replace(/"/g, '""')}"`;
      }

      return protectedValue;
    }

    function serializeInventory(report, delimiter) {
      const hydrated = hydrateStreamReport(report);
      const lines = [SHEET_HEADERS.join(delimiter)];

      hydrated.sheetRows.forEach((row) => {
        lines.push(
          SHEET_HEADERS.map((header, index) =>
            escapeDelimitedField(row[header], delimiter, index < 4),
          ).join(delimiter),
        );
      });

      return `${lines.join("\r\n")}\r\n`;
    }

    function serializeInventoryCsv(report) {
      return serializeInventory(report, ",");
    }

    function serializeInventoryTsv(report) {
      return serializeInventory(report, "\t");
    }

    return Object.freeze({
      REPORT_VERSION,
      REPORT_ID_PATTERN,
      SHEET_HEADERS,
      StreamReportError,
      correctReportUnitCost,
      createReportIdForStream,
      createStreamReport,
      hydrateStreamReport,
      serializeInventoryCsv,
      serializeInventoryTsv,
    });
  },
);
