(function initializeStreamReportPage(root, factory) {
  const feeCalculator =
    typeof module === "object" && module.exports
      ? require("../shared/tiktok-fee-calculator.js")
      : root.TikTokLiveTrackerTikTokFeeCalculator;
  const reportDownloads =
    typeof module === "object" && module.exports
      ? require("./report-downloads.js")
      : root.TikTokLiveTrackerReportDownloads;
  const inventoryImportClient = typeof module === "object" && module.exports
    ? require("../tagger/inventory-import-client.js") : root.TikTokLiveTrackerInventoryImportClient;
  const streamReportPage = factory(feeCalculator, reportDownloads, inventoryImportClient);

  if (typeof module === "object" && module.exports) {
    module.exports = streamReportPage;
  }

  root.TikTokLiveTrackerStreamReportPage = streamReportPage;

  if (root.document && root.addEventListener) {
    const start = () => {
      // The side panel also loads these presentation helpers for direct PDFs.
      // Only the actual report page should mount its editor and print controls.
      if (!root.document.querySelector?.("#report-content")) {
        return;
      }
      streamReportPage.mountStreamReportPage({
        document: root.document,
        location: root.location,
        history: root.history,
        navigator: root.navigator,
        runtime: root.chrome?.runtime,
        protocol: root.TikTokLiveTrackerStreamReportProtocol,
        reportModule: root.TikTokLiveTrackerStreamReport,
        clientModule: root.TikTokLiveTrackerStreamReportClient,
        correctionClientModule:
          root.TikTokLiveTrackerOfflineReportEditorClient,
        inlineCorrectionModule:
          root.TikTokLiveTrackerInlineReportCorrection,
        confirm: root.confirm.bind(root),
        print: () => root.print(),
        printEventTarget: root,
        Blob: root.Blob,
        ClipboardItem: root.ClipboardItem,
        lifecycleEventTarget: root,
        URL: root.URL,
        setTimeout: root.setTimeout.bind(root),
        clearTimeout: root.clearTimeout.bind(root),
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
  function createStreamReportPageModule(feeCalculator, reportDownloads, inventoryImportClient) {
    "use strict";

    const SHEET_HEADERS = Object.freeze([
      "sku",
      "item",
      "style",
      "size",
      "quantity_on_hand_at_import",
      "unit_cost",
    ]);
    const ACTION_FEEDBACK_DURATION_MS = 4_000;
    const WARNING_MESSAGES = Object.freeze({
      active_bidding_at_end:
        "A variation was still bidding when tracking ended.",
      reconciliation_conflicts:
        "Order records contain conflicting information. Review these orders.",
      inventory_recount_required:
        "More units were allocated than starting stock. Check oversold units and recount stock.",
      payment_fixing_orders:
        "Payments were still unresolved when tracking ended.",
      pending_inventory_reservations:
        "Inventory reservations were still pending when tracking ended.",
      unmapped_completed_sales:
        "Completed sales have no item assigned. Metrics are incomplete.",
      unresolved_orders:
        "Orders were still unresolved when tracking ended.",
    });

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function safeInteger(value, fallback = 0) {
      return Number.isSafeInteger(value) ? value : fallback;
    }

    function formatUsdCents(value, unavailable = "Not available") {
      if (!Number.isSafeInteger(value)) {
        return unavailable;
      }

      const absoluteValue = Math.abs(value);
      const dollars = Math.floor(absoluteValue / 100).toLocaleString("en-US");
      const cents = String(absoluteValue % 100).padStart(2, "0");
      return `${value < 0 ? "-" : ""}$${dollars}.${cents}`;
    }

    function formatSignedUsdCents(value, unavailable = "Not available") {
      if (!Number.isSafeInteger(value)) {
        return unavailable;
      }

      const formatted = formatUsdCents(value, unavailable);
      return value > 0 ? `+${formatted}` : formatted;
    }

    function formatTimestamp(value) {
      if (typeof value !== "string") {
        return "Not recorded";
      }

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return "Not recorded";
      }

      return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    }

    function formatDefaultReportName(value) {
      if (typeof value !== "string") {
        return "Saved stream";
      }

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return "Saved stream";
      }

      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    }

    function createFileStamp(value) {
      const date = new Date(value);
      const safeDate = Number.isNaN(date.getTime()) ? new Date(0) : date;
      const parts = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(safeDate);
      const getPart = (type) =>
        parts.find((part) => part.type === type)?.value ?? "00";

      return [
        getPart("year"),
        getPart("month"),
        getPart("day"),
        getPart("hour"),
        getPart("minute"),
      ].join("-");
    }

    function createReportFilename(report, suffix, extension) {
      const endedAt = report?.metadata?.endedAt;
      return `TikTok-LIVE-${suffix}_${createFileStamp(endedAt)}.${extension}`;
    }

    function getItemDescription(entry) {
      const parts = [entry?.item, entry?.style, entry?.size]
        .filter((value) => typeof value === "string" && value.trim() !== "")
        .map((value) => value.trim());

      return parts.length > 0 ? parts.join(" - ") : "Unmapped item";
    }

    function getUpdatedQuantity(entry) {
      return safeInteger(
        entry?.replacementQuantityOnHand ??
          entry?.replacementQuantity ??
          entry?.updatedQuantityOnHand ??
          entry?.updatedQuantity ??
          entry?.remainingQuantity,
      );
    }

    function getOpeningQuantity(entry) {
      return safeInteger(
        entry?.quantityOnHandAtImport ??
          entry?.openingQuantity ??
          entry?.quantityReceived,
      );
    }

    function getCompletedQuantity(entry) {
      return safeInteger(
        entry?.baselineSoldQuantity ??
          entry?.completedSoldQuantity ??
          entry?.soldQuantity,
      );
    }

    function getOversoldQuantity(entry) {
      return safeInteger(entry?.oversoldQuantity);
    }

    function getUnitCostCents(entry) {
      return safeInteger(entry?.unitCostCents ?? entry?.committedUnitCostCents);
    }

    function getProfitCents(entry) {
      return safeInteger(
        entry?.profitCents ?? entry?.grossProfitCents,
      );
    }

    function getSaleCostCents(entry) {
      const value = entry?.unitCostCents ?? entry?.committedUnitCostCents;
      return Number.isSafeInteger(value) ? value : null;
    }

    function getSaleProfitCents(entry) {
      const value = entry?.profitCents ?? entry?.grossProfitCents;
      return Number.isSafeInteger(value) ? value : null;
    }

    function createSummaryMetrics(report) {
      const totals = isPlainRecord(report?.totals) ? report.totals : {};
      const attributedGmvDisplay =
        typeof totals.attributedGmvDisplay === "string" &&
        totals.attributedGmvDisplay.trim() !== ""
          ? totals.attributedGmvDisplay.trim()
          : "Not captured";
      const completedCount = safeInteger(totals.completedPaymentCount);
      const totalSalesCount = safeInteger(totals.totalSalesCount);
      const unmatchedCount = safeInteger(totals.unmappedCompletedCount);
      const committedSalesCount = safeInteger(totals.committedSalesCount);
      const committedRevenueCents = safeInteger(totals.committedRevenueCents);
      const grossProfitCents = safeInteger(
        totals.grossProfitCents ?? totals.profitCents,
      );
      const averageProfitCents = committedSalesCount > 0
        ? Math.sign(grossProfitCents) * Math.round(
            Math.abs(grossProfitCents) / committedSalesCount,
          )
        : 0;
      const feeMetrics =
        typeof feeCalculator?.calculateSixPercentGmvFees === "function"
          ? feeCalculator.calculateSixPercentGmvFees(
              totals.attributedGmvDisplay,
            )
          : null;
      const estimatedProfitAfterFees =
        typeof feeCalculator?.calculateEstimatedProfitAfterFees === "function"
          ? feeCalculator.calculateEstimatedProfitAfterFees(
              totals.attributedGmvDisplay,
              totals.costOfGoodsCents,
            )
          : null;

      return [
        {
          label: "TikTok Attributed GMV",
          value: attributedGmvDisplay,
          note: "Last dashboard display; may include shipping",
        },
        {
          label: "TikTok 6% Fees",
          rows: [
            {
              label: "Fees paid:",
              value: feeMetrics?.feesPaidDisplay ?? "—",
            },
            {
              label: "GMV after fees:",
              value: feeMetrics?.gmvAfterFeesDisplay ?? "—",
            },
          ],
          note: "Approximate values calculated from Total GMV",
        },
        {
          label: "Est. Profit After Fees",
          value: estimatedProfitAfterFees ?? "—",
          note:
            unmatchedCount > 0
              ? `Incomplete — ${unmatchedCount} completed sale${unmatchedCount === 1 ? "" : "s"} still ${unmatchedCount === 1 ? "needs an inventory item" : "need inventory items"}.`
              : "Total GMV after 6% fee, minus mapped item costs",
          warning: unmatchedCount > 0,
        },
        {
          label: "Gross Item Sales",
          value: formatUsdCents(totals.completedGmvCents),
          note: "Captured completed-order prices",
        },
        {
          label: "Gross profit",
          value: formatUsdCents(grossProfitCents),
          note:
            unmatchedCount > 0
              ? `${unmatchedCount} completed sale${unmatchedCount === 1 ? "" : "s"} unmapped`
              : "Mapped completed sales",
        },
        {
          label: "Completed / Total sales",
          value: `${completedCount}/${totalSalesCount}`,
          note: "Bidding variation excluded",
        },
        {
          label: "Canceled orders",
          value: String(safeInteger(totals.canceledOrderCount)),
          note: "Terminal cancellations only",
        },
        {
          label: "Payment errors",
          value: String(safeInteger(totals.paymentFixingCount)),
          note: "Still inside the payment buffer",
        },
        {
          label: "AOV",
          value:
            completedCount > 0
              ? formatUsdCents(
                  Math.round(safeInteger(totals.completedGmvCents) / completedCount),
                )
              : "$0.00",
          note: "Completed-sale average; shipping excluded",
        },
        {
          label: "Mapped cost of goods",
          value: formatUsdCents(totals.costOfGoodsCents),
          note: "Unit costs saved in this report",
        },
        {
          label: "Mapped gross margin",
          value: formatPercentage(grossProfitCents, committedRevenueCents),
          note: "Gross profit divided by mapped revenue",
        },
        {
          label: "Avg. Profit per Sale",
          value: formatUsdCents(averageProfitCents),
          note: "Gross profit per mapped completed sale",
        },
      ];
    }

    function getTopMetric(report, groupName, kind) {
      const group = isPlainRecord(report?.[groupName]) ? report[groupName] : {};
      const metric = group[kind];

      if (!isPlainRecord(metric)) {
        return { entries: [], value: null };
      }

      const entries = Array.isArray(metric.items)
        ? metric.items
        : Array.isArray(metric.products)
          ? metric.products
          : [];
      return {
        entries,
        value: Number.isSafeInteger(metric.value) ? metric.value : null,
      };
    }

    function normalizeSheetCell(value) {
      return String(value ?? "")
        .replace(/[\t\r\n]+/g, " ")
        .trim();
    }

    function protectSpreadsheetCell(value) {
      const normalized = normalizeSheetCell(value);
      return /^[=+@-]/.test(normalized) ? `'${normalized}` : normalized;
    }

    function getFallbackSheetRows(report) {
      return (Array.isArray(report?.inventory) ? report.inventory : []).map(
        (entry) => ({
          sku: entry?.sku ?? "",
          item: entry?.item ?? "",
          style: entry?.style ?? "",
          size: entry?.size ?? "",
          quantity_on_hand_at_import: getUpdatedQuantity(entry),
          unit_cost: (getUnitCostCents(entry) / 100).toFixed(2),
        }),
      );
    }

    function getSheetRows(report) {
      return Array.isArray(report?.sheetRows)
        ? report.sheetRows
        : getFallbackSheetRows(report);
    }

    function serializeInventoryTsv(report, reportModule) {
      if (typeof reportModule?.serializeInventoryTsv === "function") {
        return reportModule.serializeInventoryTsv(report);
      }

      return [
        SHEET_HEADERS.join("\t"),
        ...getSheetRows(report).map((row) =>
          SHEET_HEADERS.map((header) =>
            protectSpreadsheetCell(row?.[header]),
          ).join("\t"),
        ),
      ].join("\n");
    }

    function escapeCsvCell(value) {
      return `"${protectSpreadsheetCell(value).replace(/"/g, '""')}"`;
    }

    function serializeInventoryCsv(report, reportModule) {
      if (typeof reportModule?.serializeInventoryCsv === "function") {
        return reportModule.serializeInventoryCsv(report);
      }

      return [
        SHEET_HEADERS.map(escapeCsvCell).join(","),
        ...getSheetRows(report).map((row) =>
          SHEET_HEADERS.map((header) => escapeCsvCell(row?.[header])).join(","),
        ),
      ].join("\r\n");
    }

    function getWarningMessage(warning) {
      if (typeof warning === "string" && warning.trim() !== "") {
        return warning.trim();
      }

      if (!isPlainRecord(warning)) {
        return "The report contains an item that needs review.";
      }

      if (typeof warning.message === "string" && warning.message.trim() !== "") {
        return warning.message.trim();
      }

      const code = String(warning.code ?? "").toLocaleLowerCase("en-US");
      const base = WARNING_MESSAGES[code] ??
        `Review report notice: ${code.replace(/_/g, " ") || "unknown issue"}.`;
      const count = safeInteger(warning.count);
      const countLabel = code === "inventory_recount_required" ? "Oversold" : "Count";
      const sku = typeof warning.sku === "string" ? warning.sku : null;

      return [
        base,
        count > 0 ? `${countLabel}: ${count}.` : "",
        sku ? `SKU: ${sku}.` : "",
      ].filter(Boolean).join(" ");
    }

    function appendTextElement(document, parent, tagName, text, className) {
      const element = document.createElement(tagName);
      element.textContent = String(text ?? "");
      if (className) {
        element.className = className;
      }
      parent.append(element);
      return element;
    }

    function replaceChildren(element, children) {
      element.replaceChildren(...children);
    }

    function createTableCell(document, value, options = {}) {
      const cell = document.createElement("td");
      cell.textContent = String(value ?? "");
      if (options.className) {
        cell.className = options.className;
      }
      return cell;
    }

    function renderSummary(document, report) {
      const summary = document.querySelector("#summary-grid");
      const cards = createSummaryMetrics(report).map((metric) => {
        const card = document.createElement("div");
        if (metric.warning) {
          card.className = "summary-card-warning";
        }
        appendTextElement(document, card, "dt", metric.label);
        if (Array.isArray(metric.rows)) {
          const rows = document.createElement("dd");
          rows.className = "summary-card-rows";
          metric.rows.forEach((row) => {
            const item = document.createElement("span");
            item.className = "summary-card-row";
            appendTextElement(
              document,
              item,
              "span",
              row.label,
              "summary-card-row-label",
            );
            appendTextElement(
              document,
              item,
              "strong",
              row.value,
              "summary-card-row-value",
            );
            rows.append(item);
          });
          card.append(rows);
        } else {
          appendTextElement(document, card, "dd", metric.value);
        }
        appendTextElement(
          document,
          card,
          "small",
          metric.note,
          metric.warning ? "summary-card-warning-note" : "",
        );
        return card;
      });
      replaceChildren(summary, cards);
    }

    function renderWarnings(document, report) {
      const section = document.querySelector("#warnings-section");
      const list = document.querySelector("#report-warnings");
      const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
      const items = warnings.map((warning) => {
        const item = document.createElement("li");
        item.textContent = getWarningMessage(warning);
        return item;
      });
      replaceChildren(list, items);
      section.hidden = items.length === 0;
    }

    function renderTopMetric(
      document,
      report,
      groupName,
      kind,
      targetSelector,
      cardSelector = null,
    ) {
      const target = document.querySelector(targetSelector);
      const metric = getTopMetric(report, groupName, kind);
      const items = metric.entries.map((entry) => {
        const row = document.createElement("li");
        const copy = document.createElement("span");
        appendTextElement(document, copy, "span", getItemDescription(entry), "performer-name");
        if (typeof entry?.sku === "string" && entry.sku !== "") {
          appendTextElement(document, copy, "span", entry.sku, "performer-sku");
        } else if (Array.isArray(entry?.skus) && entry.skus.length > 0) {
          appendTextElement(
            document,
            copy,
            "span",
            `SKUs: ${entry.skus.join(", ")}`,
            "performer-sku",
          );
        }
        row.append(copy);
        appendTextElement(
          document,
          row,
          "strong",
          kind === "mostSold"
            ? `${safeInteger(metric.value)} sold`
            : formatUsdCents(metric.value),
          "performer-value",
        );
        return row;
      });

      if (items.length === 0 && cardSelector === null) {
        const empty = document.createElement("li");
        empty.textContent = "Not enough mapped completed-sale data.";
        items.push(empty);
      }

      replaceChildren(target, items);
      if (cardSelector !== null) {
        document.querySelector(cardSelector).hidden = items.length === 0;
      }
    }

    function getObservedPaymentLabel(status) {
      if (status === "order_processing") {
        return "Order processing";
      }

      if (status === "payment_processing") {
        return "Payment processing";
      }

      if (status === "payment_failed") {
        return "Payment failed - fixing period";
      }

      return "Payment fixing";
    }

    function renderPaymentFixingOrders(document, ordersValue, onResolve) {
      const section = document.querySelector("#payment-resolution-section");
      const container = document.querySelector("#payment-resolution-orders");
      const count = document.querySelector("#payment-resolution-count");
      const orders = Array.isArray(ordersValue) ? ordersValue : [];
      const controls = [];

      if (!section || !container || !count) {
        return controls;
      }

      const rows = orders.map((order) => {
        const row = document.createElement("article");
        const copy = document.createElement("div");
        const priceField = document.createElement("label");
        const priceInput = document.createElement("input");
        const completeButton = document.createElement("button");
        const cancelButton = document.createElement("button");
        const variationNumber = safeInteger(order?.variationNumber);
        const inputId = `payment-resolution-price-${variationNumber}`;

        row.className = "payment-resolution-order";
        row.dataset.variationNumber = String(variationNumber);
        copy.className = "payment-resolution-copy";
        appendTextElement(
          document,
          copy,
          "h3",
          `Variation #${variationNumber}`,
          "payment-resolution-order-title",
        );
        appendTextElement(
          document,
          copy,
          "p",
          getObservedPaymentLabel(order?.observedPaymentStatus),
          "payment-resolution-status",
        );
        appendTextElement(
          document,
          copy,
          "p",
          order?.mapped
            ? `Selected inventory: ${getItemDescription(order)} (${order.sku})`
            : "No inventory item selected.",
          "payment-resolution-item",
        );

        priceField.className = "payment-price-field";
        priceField.setAttribute("for", inputId);
        appendTextElement(
          document,
          priceField,
          "span",
          "Sold price (required for complete)",
        );
        priceInput.id = inputId;
        priceInput.className = "payment-price-input";
        priceInput.type = "text";
        priceInput.inputMode = "decimal";
        priceInput.autocomplete = "off";
        priceInput.placeholder = "0.00";
        priceInput.setAttribute("aria-label", `Sold price for variation ${variationNumber}`);
        priceField.append(priceInput);

        completeButton.className = "primary-action complete-payment-action";
        completeButton.type = "button";
        completeButton.textContent = "Mark complete";
        completeButton.addEventListener("click", () => {
          onResolve?.({
            order,
            priceInput,
            resolution: "payment_complete",
            soldPriceText: priceInput.value,
          });
        });

        cancelButton.className = "secondary-action cancel-payment-action";
        cancelButton.type = "button";
        cancelButton.textContent = "Mark canceled";
        cancelButton.addEventListener("click", () => {
          onResolve?.({
            order,
            priceInput,
            resolution: "canceled",
            soldPriceText: null,
          });
        });

        controls.push(priceInput, completeButton, cancelButton);
        row.append(copy, priceField, completeButton, cancelButton);
        return row;
      });

      replaceChildren(container, rows);
      count.textContent = `${rows.length} unresolved order${rows.length === 1 ? "" : "s"}`;
      section.hidden = rows.length === 0;
      section.setAttribute("aria-busy", "false");
      return controls;
    }

    function createVariationReferenceCells(document, order, status) {
      const mapped = typeof order?.sku === "string" && order.sku !== "";
      return [
        createTableCell(document, `#${safeInteger(order?.variationNumber)}`),
        createTableCell(document, status),
        createTableCell(document, mapped ? order.sku : "Unmapped", {
          className: mapped ? "sku-cell" : "warning-cell",
        }),
        createTableCell(document, mapped ? order?.item : "Not selected"),
        createTableCell(document, mapped ? order?.style : "—", {
          className: mapped ? "" : "muted-cell",
        }),
        createTableCell(document, mapped ? order?.size : "—", {
          className: mapped ? "" : "muted-cell",
        }),
      ];
    }

    function renderItemVariations(document, report) {
      const body = document.querySelector("#completed-sales-rows");
      const empty = document.querySelector("#sales-empty");
      const count = document.querySelector("#sales-count");
      const detailsNote = document.querySelector("#variation-details-note");
      const sales = Array.isArray(report?.completedSales)
        ? report.completedSales
        : [];
      const canceledDetailsAvailable = Array.isArray(report?.canceledOrders);
      const canceledOrders = canceledDetailsAvailable
        ? report.canceledOrders
        : [];
      const canceledCount = Number.isSafeInteger(report?.totals?.canceledOrderCount)
        ? safeInteger(report.totals.canceledOrderCount)
        : canceledOrders.length;
      const variations = [
        ...sales.map((order) => ({ order, status: "Completed" })),
        ...canceledOrders.map((order) => ({ order, status: "Canceled" })),
      ].sort(
        (left, right) =>
          safeInteger(left.order?.variationNumber) -
          safeInteger(right.order?.variationNumber),
      );
      const rows = variations.map(({ order, status }) => {
        const row = document.createElement("tr");
        const canceled = status === "Canceled";
        row.append(
          ...createVariationReferenceCells(document, order, status),
          createTableCell(document, canceled
            ? "—"
            : formatUsdCents(order?.soldPriceCents), {
            className: "number-cell",
          }),
          createTableCell(document, canceled
            ? "—"
            : formatUsdCents(getSaleCostCents(order), "—"), {
            className: "number-cell",
          }),
          createTableCell(document, canceled
            ? "—"
            : formatUsdCents(getSaleProfitCents(order), "—"), {
            className: "number-cell",
          }),
        );
        return row;
      });
      replaceChildren(body, rows);
      const combinedTotal = sales.length + canceledCount;
      empty.hidden = combinedTotal !== 0;
      empty.textContent = "No completed or canceled item variations were captured for this stream.";
      count.textContent = `${combinedTotal} variation${combinedTotal === 1 ? "" : "s"}`;

      const unavailableCanceledCount = canceledDetailsAvailable ? 0 : canceledCount;
      detailsNote.hidden = unavailableCanceledCount === 0;
      detailsNote.textContent = unavailableCanceledCount === 0
        ? ""
        : `Individual item details for ${unavailableCanceledCount} canceled variation${unavailableCanceledCount === 1 ? "" : "s"} were not saved in this older report. The canceled total is still included above.`;
    }

    function renderCanceledSkuSummary(document, orders) {
      const groups = new Map();
      // Saved report validation guarantees one row per canceled variation. Count
      // those references only; no inventory or completed-sale totals are involved.
      for (const order of orders) {
        const sku = typeof order?.sku === "string" && order.sku !== ""
          ? order.sku
          : null;
        if (!groups.has(sku)) {
          groups.set(sku, {
            sku,
            item: sku === null ? "Not selected" : order.item,
            style: sku === null ? "—" : order.style,
            count: 0,
          });
        }
        groups.get(sku).count += 1;
      }
      const rows = [...groups.values()]
        .sort((left, right) => {
          if (left.sku === right.sku) return 0;
          if (left.sku === null) return 1;
          if (right.sku === null) return -1;
          return left.sku < right.sku ? -1 : 1;
        })
        .map((group) => {
          const row = document.createElement("tr");
          row.append(
            createTableCell(document, group.sku ?? "Unmapped", {
              className: group.sku === null ? "warning-cell" : "sku-cell",
            }),
            createTableCell(document, group.item),
            createTableCell(document, group.style, {
              className: group.sku === null ? "muted-cell" : "",
            }),
            createTableCell(document, group.count, { className: "number-cell" }),
          );
          return row;
        });
      replaceChildren(document.querySelector("#canceled-sku-summary-rows"), rows);
      document.querySelector("#canceled-sku-summary").hidden = rows.length === 0;
    }

    function renderCanceledOrders(document, report) {
      const body = document.querySelector("#canceled-orders-rows");
      const empty = document.querySelector("#canceled-orders-empty");
      const count = document.querySelector("#canceled-orders-count");
      const detailsNote = document.querySelector("#canceled-orders-note");
      const detailsAvailable = Array.isArray(report?.canceledOrders);
      const orders = detailsAvailable ? report.canceledOrders : [];
      renderCanceledSkuSummary(document, orders);
      const canceledCount = Number.isSafeInteger(report?.totals?.canceledOrderCount)
        ? report.totals.canceledOrderCount
        : orders.length;
      const rows = [...orders]
        .sort((left, right) =>
          safeInteger(left?.variationNumber) - safeInteger(right?.variationNumber))
        .map((order) => {
          const row = document.createElement("tr");
          row.append(...createVariationReferenceCells(document, order, "Canceled"));
          return row;
        });

      replaceChildren(body, rows);
      count.textContent = `${canceledCount} canceled order${canceledCount === 1 ? "" : "s"}`;
      empty.hidden = canceledCount !== 0;
      const unavailableCount = detailsAvailable ? 0 : canceledCount;
      detailsNote.hidden = unavailableCount === 0;
      detailsNote.textContent = unavailableCount === 0
        ? ""
        : `Individual item details for ${unavailableCount} canceled variation${unavailableCount === 1 ? "" : "s"} were not saved in this older report. The canceled total is still included above.`;
    }

    function formatPercentage(numerator, denominator) {
      if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
        return "—";
      }

      const percentage = (numerator / denominator) * 100;
      return `${percentage.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}%`;
    }

    function formatSellThroughPercentage(soldQuantity, openingQuantity) {
      if (
        !Number.isSafeInteger(soldQuantity) ||
        !Number.isSafeInteger(openingQuantity) ||
        openingQuantity <= 0
      ) {
        return formatPercentage(soldQuantity, openingQuantity);
      }

      return formatPercentage(
        Math.min(soldQuantity, openingQuantity),
        openingQuantity,
      );
    }

    function getAverageSalePriceCents(entry) {
      const revenueCents = entry?.revenueCents;
      const soldQuantity = entry?.soldQuantity;

      if (
        !Number.isSafeInteger(revenueCents) ||
        !Number.isSafeInteger(soldQuantity) ||
        soldQuantity <= 0
      ) {
        return null;
      }

      return Math.round(revenueCents / soldQuantity);
    }

    function renderSkuPerformance(document, report) {
      const body = document.querySelector("#performance-rows");
      const empty = document.querySelector("#performance-empty");
      const count = document.querySelector("#performance-row-count");
      const inventoryBySku = new Map(
        (Array.isArray(report?.inventory) ? report.inventory : []).map(
          (entry) => [entry.sku, entry],
        ),
      );
      const performance = (Array.isArray(report?.itemPerformance)
        ? report.itemPerformance
        : [])
        .filter((entry) => safeInteger(entry?.soldQuantity) > 0)
        .slice()
        .sort((left, right) => {
          const leftProfit = Number.isSafeInteger(left?.grossProfitCents)
            ? left.grossProfitCents
            : null;
          const rightProfit = Number.isSafeInteger(right?.grossProfitCents)
            ? right.grossProfitCents
            : null;

          if (leftProfit === null || rightProfit === null) {
            if (leftProfit !== rightProfit) {
              return leftProfit === null ? 1 : -1;
            }
          }

          if (leftProfit !== rightProfit) {
            return leftProfit > rightProfit ? -1 : 1;
          }

          const leftSku = typeof left?.sku === "string" ? left.sku.trim() : "";
          const rightSku = typeof right?.sku === "string" ? right.sku.trim() : "";
          return leftSku < rightSku ? -1 : leftSku > rightSku ? 1 : 0;
        });
      const rows = performance.map((entry) => {
        const row = document.createElement("tr");
        const inventoryEntry = inventoryBySku.get(entry.sku);
        const openingQuantity = getOpeningQuantity(inventoryEntry);
        const grossProfitCents = Number.isSafeInteger(entry?.grossProfitCents)
          ? entry.grossProfitCents
          : null;
        const profitClass = grossProfitCents !== null && grossProfitCents > 0
          ? "profit-positive"
          : grossProfitCents !== null && grossProfitCents < 0
            ? "profit-negative"
            : "profit-neutral";
        row.append(
          createTableCell(document, entry?.sku ?? "", { className: "sku-cell" }),
          createTableCell(
            document,
            [entry?.item, entry?.style]
              .filter((value) => typeof value === "string" && value !== "")
              .join(" - "),
          ),
          createTableCell(document, entry?.size ?? ""),
          createTableCell(document, safeInteger(entry?.soldQuantity), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(inventoryEntry?.unitCostCents), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(getAverageSalePriceCents(entry)), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(entry?.revenueCents), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(entry?.costOfGoodsCents), {
            className: "number-cell",
          }),
          createTableCell(
            document,
            formatSellThroughPercentage(entry?.soldQuantity, openingQuantity),
            { className: "number-cell" },
          ),
          createTableCell(
            document,
            formatPercentage(entry?.grossProfitCents, entry?.revenueCents),
            { className: "number-cell" },
          ),
          createTableCell(document, formatSignedUsdCents(grossProfitCents), {
            className: `number-cell ${profitClass}`,
          }),
        );
        return row;
      });

      replaceChildren(body, rows);
      empty.hidden = rows.length !== 0;
      count.textContent = `${rows.length} selling SKU${rows.length === 1 ? "" : "s"}`;
    }

    function renderInventory(document, report) {
      const body = document.querySelector("#inventory-rows");
      const inventory = Array.isArray(report?.inventory) ? report.inventory : [];
      const rows = inventory.map((entry) => {
        const row = document.createElement("tr");
        const oversold = getOversoldQuantity(entry);
        row.append(
          createTableCell(document, entry?.sku ?? "", { className: "sku-cell" }),
          createTableCell(document, entry?.item ?? ""),
          createTableCell(document, entry?.style ?? ""),
          createTableCell(document, entry?.size ?? ""),
          createTableCell(document, formatUsdCents(entry?.unitCostCents), {
            className: "number-cell",
          }),
          createTableCell(document, getOpeningQuantity(entry), { className: "number-cell" }),
          createTableCell(document, getCompletedQuantity(entry), { className: "number-cell" }),
          createTableCell(document, getUpdatedQuantity(entry), { className: "number-cell" }),
          createTableCell(document, oversold, {
            className: oversold > 0 ? "number-cell warning-cell" : "number-cell",
          }),
        );
        return row;
      });
      replaceChildren(body, rows);
    }

    function parsePositiveUsdCents(value) {
      if (typeof value !== "string") {
        return null;
      }

      const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());

      if (!match) {
        return null;
      }

      const dollars = Number(match[1]);
      const cents = Number((match[2] ?? "").padEnd(2, "0"));

      if (!Number.isSafeInteger(dollars) || dollars > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
        return null;
      }

      const total = dollars * 100 + cents;
      return Number.isSafeInteger(total) && total > 0 ? total : null;
    }

    function parseNonnegativeUsdCents(value) {
      if (typeof value !== "string") {
        return null;
      }

      const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());

      if (!match) {
        return null;
      }

      const dollars = Number(match[1]);
      const cents = Number((match[2] ?? "").padEnd(2, "0"));

      if (
        !Number.isSafeInteger(dollars) ||
        dollars > Math.floor(Number.MAX_SAFE_INTEGER / 100)
      ) {
        return null;
      }

      const total = dollars * 100 + cents;
      return Number.isSafeInteger(total) && total >= 0 ? total : null;
    }

    function createUnitCostImpactSummary(entry, nextUnitCostCents) {
      const completedSaleCount = safeInteger(entry?.completedSaleCount);
      const currentUnitCostCents = safeInteger(entry?.unitCostCents);

      if (!Number.isSafeInteger(nextUnitCostCents) || nextUnitCostCents < 0) {
        return `Enter a nonnegative unit cost to preview its effect on ${completedSaleCount} completed sale${completedSaleCount === 1 ? "" : "s"}.`;
      }

      if (completedSaleCount === 0) {
        return "This SKU had no completed sales in this stream. Report metrics stay unchanged; only this report's Google Sheets handoff will use the corrected cost.";
      }

      const costDifferenceCents =
        (nextUnitCostCents - currentUnitCostCents) * completedSaleCount;
      const saleCopy = `${completedSaleCount} completed sale${completedSaleCount === 1 ? "" : "s"}`;

      if (!Number.isSafeInteger(costDifferenceCents)) {
        return `${saleCopy} will be recalculated with the corrected cost.`;
      }

      if (costDifferenceCents === 0) {
        return `${saleCopy} use this cost. Mapped COGS and gross profit remain unchanged.`;
      }

      const differenceDisplay = formatUsdCents(Math.abs(costDifferenceCents));
      return costDifferenceCents > 0
        ? `${saleCopy} will be updated. Mapped COGS increases by ${differenceDisplay}, and gross profit decreases by ${differenceDisplay}.`
        : `${saleCopy} will be updated. Mapped COGS decreases by ${differenceDisplay}, and gross profit increases by ${differenceDisplay}.`;
    }

    function renderUnitCostCorrection(
      document,
      skuEntriesValue,
      selectedSkuValue = null,
    ) {
      const section = document.querySelector("#unit-cost-correction-section");
      const select = document.querySelector("#unit-cost-sku");
      const input = document.querySelector("#unit-cost-value");
      const button = document.querySelector("#update-unit-cost");
      const preview = document.querySelector("#unit-cost-preview");
      const entries = Array.isArray(skuEntriesValue) ? skuEntriesValue : [];

      if (!section || !select || !input || !button || !preview) {
        return null;
      }

      const options = entries.map((entry) => {
        const option = document.createElement("option");
        const completedSaleCount = safeInteger(entry?.completedSaleCount);
        const soldCopy = `${completedSaleCount} sold`;
        option.value = entry.sku;
        option.textContent = [
          entry.sku,
          getItemDescription(entry),
          formatUsdCents(entry.unitCostCents),
          soldCopy,
        ].join(" - ");
        return option;
      });
      replaceChildren(select, options);

      const selectedEntry = entries.find(
        (entry) => entry.sku === selectedSkuValue,
      ) ?? entries[0] ?? null;
      section.hidden = selectedEntry === null;
      select.disabled = selectedEntry === null;
      input.disabled = selectedEntry === null;
      button.disabled = selectedEntry === null;

      if (selectedEntry === null) {
        select.value = "";
        input.value = "";
        preview.textContent = "";
        return null;
      }

      select.value = selectedEntry.sku;
      input.value = (selectedEntry.unitCostCents / 100).toFixed(2);
      preview.textContent = createUnitCostImpactSummary(
        selectedEntry,
        selectedEntry.unitCostCents,
      );
      section.setAttribute("aria-busy", "false");
      return selectedEntry;
    }

    function getReportDisplayName(record) {
      return typeof record.displayName === "string" &&
        record.displayName.trim() !== ""
        ? record.displayName
        : formatDefaultReportName(record.report?.metadata?.startedAt);
    }

    function updateReportTitle(document, record) {
      // Chrome suggests this title for Save as PDF; share direct-download cleanup.
      document.title = reportDownloads.createPdfFilename(getReportDisplayName(record))
        .replace(/\.pdf$/i, "");
    }

    function renderReport(document, record) {
      const report = record.report;
      const metadata = isPlainRecord(report?.metadata) ? report.metadata : {};
      document.querySelector("#stream-started").textContent =
        formatTimestamp(metadata.startedAt);
      document.querySelector("#stream-ended").textContent =
        formatTimestamp(metadata.endedAt);
      document.querySelector("#report-name").textContent =
        getReportDisplayName(record);
      document.querySelector("#stream-reference").textContent =
        `Stream reference: ${
          typeof metadata.streamId === "string"
            ? metadata.streamId
            : "Unavailable"
        }`;
      document.querySelector("#report-generated-at").textContent =
        `Generated ${formatTimestamp(metadata.generatedAt)}.`;

      renderSummary(document, report);
      renderWarnings(document, report);
      renderTopMetric(
        document,
        report,
        "topItems",
        "mostSold",
        "#most-sold-items",
      );
      renderTopMetric(
        document,
        report,
        "topItems",
        "mostProfitable",
        "#most-profitable-items",
      );
      renderTopMetric(
        document,
        report,
        "topProducts",
        "mostSold",
        "#most-sold-products",
        "#most-sold-products-card",
      );
      renderTopMetric(
        document,
        report,
        "topProducts",
        "mostProfitable",
        "#most-profitable-products",
        "#most-profitable-products-card",
      );
      renderItemVariations(document, report);
      renderCanceledOrders(document, report);
      renderSkuPerformance(document, report);
      renderInventory(document, report);

      updateReportTitle(document, record);
      document.querySelector("#report-loading").hidden = true;
      document.querySelector("#report-error").hidden = true;
      document.querySelector("#report-content").hidden = false;
      document.querySelector("#print-report").disabled = false;
    }

    async function writeClipboard(navigator, text) {
      if (!navigator?.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard access is unavailable in this browser context.");
      }

      await navigator.clipboard.writeText(text);
    }

    // Other options uses the original six-column copy. The main Copy Updated
    // Inventory button opens the separate, verified quantity-only handoff.
    async function copyUpdatedInventory(navigator, report, reportModule) {
      await writeClipboard(navigator, serializeInventoryTsv(report, reportModule));
    }

    function downloadCsv(document, dependencies, report, csvText) {
      if (
        typeof dependencies.Blob !== "function" ||
        !dependencies.URL ||
        typeof dependencies.URL.createObjectURL !== "function" ||
        typeof dependencies.URL.revokeObjectURL !== "function"
      ) {
        throw new Error("CSV downloads are unavailable in this browser context.");
      }

      const blob = new dependencies.Blob([csvText], {
        type: "text/csv;charset=utf-8",
      });
      const objectUrl = dependencies.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = createReportFilename(
        report,
        "Updated-Inventory",
        "csv",
      );
      anchor.hidden = true;
      document.body.append(anchor);

      try {
        anchor.click();
      } finally {
        anchor.remove();
        dependencies.setTimeout(
          () => dependencies.URL.revokeObjectURL(objectUrl),
          0,
        );
      }

      return anchor.download;
    }

    function getRequestedReportId(location, protocol) {
      const parameters = new URLSearchParams(location?.search ?? "");
      const reportId = parameters.get("reportId");

      if (reportId === null || reportId.trim() === "") {
        return null;
      }

      if (!protocol?.REPORT_ID_PATTERN?.test(reportId)) {
        throw new Error("This report link contains an invalid local report ID.");
      }

      return reportId;
    }

    function validateMountDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Report-page options are required.");
      }

      const requiredDocumentMethods = ["createElement", "querySelector"];
      if (
        !options.document ||
        requiredDocumentMethods.some(
          (method) => typeof options.document[method] !== "function",
        )
      ) {
        throw new TypeError("document must provide the report page DOM.");
      }

      if (
        !options.runtime ||
        !options.protocol ||
        typeof options.clientModule?.createStreamReportClient !== "function"
      ) {
        throw new TypeError("The stream-report client dependencies are unavailable.");
      }

      return options;
    }

    function mountStreamReportPage(options) {
      let dependencies;

      try {
        dependencies = validateMountDependencies(options);
      } catch (error) {
        options?.document?.querySelector?.("#report-loading")?.setAttribute(
          "aria-busy",
          "false",
        );
        const errorSection = options?.document?.querySelector?.("#report-error");
        if (errorSection) {
          errorSection.hidden = false;
        }
        const errorMessage = options?.document?.querySelector?.(
          "#report-error-message",
        );
        if (errorMessage) {
          errorMessage.textContent =
            "The packaged report components are unavailable. Reload the extension and try again.";
        }
        return null;
      }

      const {
        document,
        location,
        navigator,
        protocol,
        reportModule,
      } = dependencies;
      const client = dependencies.clientModule.createStreamReportClient({
        runtime: dependencies.runtime,
        protocol,
      });
      let correctionClient = null;

      if (
        typeof dependencies.correctionClientModule
          ?.createOfflineReportEditorClient === "function"
      ) {
        try {
          correctionClient = dependencies.correctionClientModule
            .createOfflineReportEditorClient({
              runtime: dependencies.runtime,
              protocol,
            });
        } catch (_error) {
          correctionClient = null;
        }
      }

      let currentRecord = null;
      let currentPaymentFixingOrders = [];
      let paymentResolutionControls = [];
      let paymentResolutionBusy = false;
      let currentUnitCostEntries = [];
      let unitCostCorrectionBusy = false;
      let unitCostRefreshFailure = null;
      let loadSequence = 0;
      let mappingCorrectionRefreshSequence = 0;
      let actionFeedbackSequence = 0;
      let actionFeedbackTimerId = null;
      const reportNameInput = document.querySelector("#report-name-input");
      const reportNameFeedback = document.querySelector("#report-name-feedback");
      let reportNameDraftId = null;
      let reportNameDirty = false;
      let reportNameSave = null;
      let printDisclosureState = null;
      let disposed = false;
      let quantityLoading = true;
      let quantitySequence = 0;
      let quantityBusy = false;
      let inventoryCopying = false;
      let quantityCopyReference = null;
      let quantityCopyNameDraft = null;
      let preparedQuantities = null;
      let renderedQuantityReport = null;
      const quantityPanel = document.querySelector("#quantity-handoff-panel");
      const inventoryCopyButton = document.querySelector("#copy-inventory");
      const inventoryOptionsContainer = document.querySelector("#inventory-other-options-container");
      const inventoryOptionsButton = document.querySelector("#inventory-other-options");
      const inventoryOptionsPanel = document.querySelector("#inventory-other-options-panel");
      const inventoryCsvButton = document.querySelector("#download-inventory");
      const inventoryUnformattedButton = document.querySelector("#copy-inventory-unformatted");
      const quantityForm = document.querySelector("#quantity-handoff-form");
      const quantitySheetInput = document.querySelector("#quantity-sheet-reference");
      const checkQuantityButton = document.querySelector("#check-quantity-sheet");
      const copyQuantityButton = document.querySelector("#copy-quantities");
      const quantityTarget = document.querySelector("#quantity-handoff-target");
      const quantityFeedback = document.querySelector("#quantity-handoff-feedback");

      const quantityMessage = (message, isError = false) => {
        if (!quantityFeedback) return;
        quantityFeedback.textContent = message;
        quantityFeedback.className = `quantity-handoff-feedback${isError ? " is-error" : ""}`;
      };
      const quantityReportKey = () => currentRecord
        ? JSON.stringify([currentRecord.reportId, currentRecord.report]) : null;
      const isQuantityReportLocationCurrent = () => {
        try {
          const requestedReportId = getRequestedReportId(location, protocol);
          return requestedReportId === null || requestedReportId === currentRecord?.reportId;
        } catch (_error) {
          return false;
        }
      };
      const canUseQuantities = () => !disposed && !quantityLoading && currentRecord !== null &&
        currentRecord.lifecycleStatus === "finalized" && !document.querySelector("#report-content").hidden &&
        isQuantityReportLocationCurrent() &&
        !paymentResolutionBusy && !unitCostCorrectionBusy && !unitCostRefreshFailure && !reportNameSave &&
        !mappingCorrectionController?.getState()?.busy && !mappingCorrectionController?.getState()?.loading &&
        typeof client.prepareQuantityHandoff === "function" && typeof client.copyQuantityHandoff === "function";
      // Full-table exports do not require the quantity-check worker APIs or a
      // prepared Sheet destination. They still respect report/save/copy locks.
      const canUseInventoryExports = () => !disposed && !quantityLoading && currentRecord !== null &&
        currentRecord.lifecycleStatus === "finalized" && !document.querySelector("#report-content").hidden &&
        isQuantityReportLocationCurrent() && !inventoryCopying && !quantityBusy &&
        !paymentResolutionBusy && !unitCostCorrectionBusy && !unitCostRefreshFailure && !reportNameSave &&
        !mappingCorrectionController?.getState()?.busy && !mappingCorrectionController?.getState()?.loading;
      const syncInventoryOptions = () => {
        const unavailable = !canUseInventoryExports();
        if (inventoryOptionsButton) inventoryOptionsButton.disabled = unavailable;
        const actionsUnavailable = unavailable || inventoryOptionsPanel?.hidden !== false;
        if (inventoryCsvButton) inventoryCsvButton.disabled = actionsUnavailable;
        if (inventoryUnformattedButton) inventoryUnformattedButton.disabled = actionsUnavailable;
      };
      const setInventoryOptionsOpen = (open, restoreFocus = false) => {
        if (inventoryOptionsPanel) inventoryOptionsPanel.hidden = !open;
        inventoryOptionsButton?.setAttribute("aria-expanded", String(open));
        syncInventoryOptions();
        if (restoreFocus) inventoryOptionsButton?.focus();
      };
      const syncQuantityControls = () => {
        const unavailable = !canUseQuantities() || inventoryCopying;
        const preparationCurrent = preparedQuantities &&
          preparedQuantities.reportKey === quantityReportKey() &&
          preparedQuantities.reference === quantitySheetInput?.value &&
          preparedQuantities.locationSearch === location?.search;
        quantityForm?.setAttribute("aria-busy", String(quantityBusy));
        if (inventoryCopyButton) inventoryCopyButton.disabled = unavailable || quantityBusy;
        const panelClosed = quantityPanel?.hidden !== false;
        if (checkQuantityButton) checkQuantityButton.disabled = panelClosed || unavailable || quantityBusy;
        if (copyQuantityButton) copyQuantityButton.disabled = panelClosed || unavailable || quantityBusy || !preparationCurrent;
        // Keep the link editable during Check so destination changes invalidate
        // that read. Clipboard delivery temporarily locks all local edits.
        if (quantitySheetInput) quantitySheetInput.disabled = panelClosed || disposed || quantityLoading || inventoryCopying;
        syncInventoryOptions();
      };
      const setQuantityPanelOpen = (open) => {
        if (quantityPanel) quantityPanel.hidden = !open;
        inventoryCopyButton?.setAttribute("aria-expanded", String(open));
        syncQuantityControls();
      };
      const invalidateQuantities = (message = "") => {
        quantitySequence += 1;
        preparedQuantities = null;
        if (quantityTarget) { quantityTarget.hidden = true; quantityTarget.textContent = ""; }
        quantityMessage(message);
        syncQuantityControls();
      };
      const quantityContext = () => ({
        sequence: ++quantitySequence, loadSequence, reportId: currentRecord.reportId,
        reportKey: quantityReportKey(), reference: quantitySheetInput.value, locationSearch: location?.search,
      });
      const isQuantityContextCurrent = (context) => !disposed && context.sequence === quantitySequence &&
        context.loadSequence === loadSequence && context.reportId === currentRecord?.reportId &&
        context.reportKey === quantityReportKey() && context.reference === quantitySheetInput?.value &&
        context.locationSearch === location?.search;
      const setInventoryCopying = (copying) => {
        inventoryCopying = copying;
        quantityCopyReference = copying ? quantitySheetInput?.value : null;
        quantityCopyNameDraft = copying ? reportNameInput?.value : null;
        syncReportNameInput();
        setResolutionBusy(paymentResolutionBusy);
        setUnitCostBusy(unitCostCorrectionBusy);
        mappingCorrectionController?.setExternalBusy?.(copying);
        document.querySelector("#retry-report").disabled = copying;
        syncQuantityControls();
      };
      const prepareQuantities = async (event) => {
        event.preventDefault();
        if (!canUseQuantities() || quantityBusy || inventoryCopying || quantityPanel?.hidden !== false) return;
        invalidateQuantities();
        let spreadsheetId;
        try {
          spreadsheetId = inventoryImportClient.parseGoogleSheetReference(quantitySheetInput.value);
        } catch (error) { quantityMessage(error.message, true); return; }
        const context = quantityContext();
        quantityBusy = true;
        syncQuantityControls();
        quantityMessage("Checking the Inventory tab and saved report...");
        try {
          const result = await client.prepareQuantityHandoff({ reportId: context.reportId, spreadsheetId });
          if (!isQuantityContextCurrent(context)) return;
          if (!canUseQuantities() || result.reportId !== context.reportId || result.spreadsheetId !== spreadsheetId) {
            throw new Error("The report changed while checking. Finish any corrections, then check the Sheet again.");
          }
          preparedQuantities = { ...result, reportKey: context.reportKey, reference: context.reference, locationSearch: context.locationSearch };
          const cellLine = document.createElement("strong");
          cellLine.className = "quantity-handoff-cell";
          cellLine.textContent = `Paste into inventory cell ${result.startCell}`;
          const guidance = document.createElement("span");
          guidance.textContent = "\nNot A1 to preserve order and formatting of google sheet. Make sure edits were not made during tracking or before pasting.";
          quantityTarget.replaceChildren(cellLine, guidance);
          quantityTarget.hidden = false;
          quantityMessage(result.alreadyApplied
            ? "These quantities already match the Sheet. Copying them again will not deduct stock again."
            : "Sheet verified. Copy quantities when ready; other columns and formatting are not included.");
        } catch (error) {
          if (isQuantityContextCurrent(context)) {
            preparedQuantities = null;
            quantityMessage(error?.message ?? "The Sheet could not be checked. No quantities were copied.", true);
          }
        } finally {
          quantityBusy = false;
          syncQuantityControls();
        }
      };
      const copyQuantities = async () => {
        if (!canUseQuantities() || quantityBusy || inventoryCopying || quantityPanel?.hidden !== false || !preparedQuantities) return;
        const prepared = preparedQuantities;
        if (prepared.reportKey !== quantityReportKey() || prepared.reference !== quantitySheetInput.value ||
            prepared.locationSearch !== location?.search) {
          invalidateQuantities("The report or Sheet link changed. Check the Sheet again.");
          return;
        }
        if (typeof navigator?.clipboard?.write !== "function" ||
            typeof dependencies.ClipboardItem !== "function" || typeof dependencies.Blob !== "function") {
          quantityMessage("Quantity copying is unavailable in this browser. Use current desktop Chrome, or the separate full-table export.", true);
          return;
        }
        const context = quantityContext();
        quantityBusy = true;
        setInventoryCopying(true);
        quantityMessage("Rechecking the saved report before copying...");
        // Start clipboard.write during this explicit click. Its promised Blob
        // resolves only after the worker confirms the report and preparation
        // token are still current; async validation never copies stale text.
        const payload = Promise.resolve().then(async () => {
          const result = await client.copyQuantityHandoff({ reportId: context.reportId, token: prepared.token });
          if (!isQuantityContextCurrent(context) || !canUseQuantities() ||
              result.reportId !== context.reportId || result.token !== prepared.token ||
              result.spreadsheetId !== prepared.spreadsheetId || result.range !== prepared.range ||
              result.startCell !== prepared.startCell || result.sheetTitle !== prepared.sheetTitle) {
            throw new Error("The report or destination changed. Check the Sheet again before copying.");
          }
          return new dependencies.Blob([result.text], { type: "text/plain" });
        });
        payload.catch(() => {}); // A synchronous clipboard rejection may never consume its payload.
        try {
          await navigator.clipboard.write([new dependencies.ClipboardItem({ "text/plain": payload })]);
          if (!isQuantityContextCurrent(context)) return;
          quantityMessage("");
        } catch (error) {
          if (isQuantityContextCurrent(context)) {
            invalidateQuantities();
            quantityMessage(error?.message ?? "Quantities could not be copied. Check the Sheet again to retry.", true);
          }
        } finally {
          quantityBusy = false;
          setInventoryCopying(false);
        }
      };

      const expandVariationsForPrint = () => {
        if (printDisclosureState !== null || !currentRecord ||
            document.querySelector("#report-content").hidden) {
          return;
        }
        printDisclosureState = [
          "#completed-sales-disclosure",
          "#canceled-orders-disclosure",
        ].map((selector) => document.querySelector(selector))
          .filter(Boolean)
          .map((element) => ({ element, open: element.open }));
        printDisclosureState.forEach(({ element }) => { element.open = true; });
      };

      const restoreVariationsAfterPrint = () => {
        const previousState = printDisclosureState;
        printDisclosureState = null;
        previousState?.forEach(({ element, open }) => { element.open = open; });
      };

      // Native browser printing (including Ctrl/Cmd+P) uses the same temporary
      // expansion as the report button, without changing normal disclosure state.
      const printEventTarget = dependencies.printEventTarget ?? document.defaultView;
      printEventTarget?.addEventListener("beforeprint", expandVariationsForPrint);
      printEventTarget?.addEventListener("afterprint", restoreVariationsAfterPrint);

      const showReportNameFeedback = (message, isError = false) => {
        if (reportNameFeedback) {
          reportNameFeedback.textContent = message;
          reportNameFeedback.hidden = message === "";
          reportNameFeedback.className = isError
            ? "report-name-feedback is-error"
            : "report-name-feedback";
        }
        reportNameInput?.setAttribute("aria-invalid", String(isError));
      };

      const syncReportNameInput = () => {
        if (!reportNameInput || !currentRecord) {
          return;
        }
        if (reportNameDraftId !== currentRecord.reportId) {
          reportNameDraftId = currentRecord.reportId;
          reportNameDirty = false;
          reportNameSave = null;
          showReportNameFeedback("");
        }
        if (!reportNameDirty) {
          reportNameInput.value = getReportDisplayName(currentRecord);
        }
        reportNameInput.disabled = reportNameSave !== null || inventoryCopying ||
          currentRecord.lifecycleStatus !== "finalized" ||
          typeof client.renameReport !== "function";
        reportNameInput.setAttribute("aria-busy", String(reportNameSave !== null));
      };

      const renderCurrentReport = () => {
        const key = quantityReportKey();
        if (renderedQuantityReport !== key) {
          invalidateQuantities(renderedQuantityReport === null ? "" : "The report changed. Check the Sheet again before copying quantities.");
          renderedQuantityReport = key;
        }
        renderReport(document, currentRecord);
        syncReportNameInput();
        syncQuantityControls();
      };

      const feedback = (message) => {
        const target = document.querySelector("#action-feedback");
        const sequence = ++actionFeedbackSequence;

        if (!target) {
          return;
        }

        if (
          actionFeedbackTimerId !== null &&
          typeof dependencies.clearTimeout === "function"
        ) {
          dependencies.clearTimeout(actionFeedbackTimerId);
        }

        actionFeedbackTimerId = null;
        target.textContent = message;

        if (
          message === "" ||
          typeof dependencies.setTimeout !== "function"
        ) {
          return;
        }

        actionFeedbackTimerId = dependencies.setTimeout(() => {
          if (sequence !== actionFeedbackSequence) {
            return;
          }

          target.textContent = "";
          actionFeedbackTimerId = null;
        }, ACTION_FEEDBACK_DURATION_MS);
      };

      const resolutionFeedback = (message, isError = false) => {
        const target = document.querySelector("#payment-resolution-feedback");

        if (!target) {
          return;
        }

        target.textContent = message;
        target.className = isError
          ? "resolution-feedback is-error"
          : "resolution-feedback";
      };

      const unitCostFeedback = (message, isError = false) => {
        const target = document.querySelector("#unit-cost-feedback");

        if (!target) {
          return;
        }

        target.textContent = message;
        target.className = isError
          ? "unit-cost-feedback is-error"
          : "unit-cost-feedback";
      };

      const setResolutionBusy = (busy) => {
        const section = document.querySelector("#payment-resolution-section");

        paymentResolutionBusy = busy;
        if (busy) invalidateQuantities("Finish the payment correction, then check the Sheet again.");
        syncQuantityControls();
        section?.setAttribute("aria-busy", busy ? "true" : "false");
        paymentResolutionControls.forEach((control) => {
          control.disabled = busy || inventoryCopying;
        });
      };

      const displayPaymentFixingOrders = (orders, onResolve) => {
        currentPaymentFixingOrders = Array.isArray(orders) ? orders : [];
        paymentResolutionControls = renderPaymentFixingOrders(
          document,
          currentPaymentFixingOrders,
          onResolve,
        );
        setResolutionBusy(paymentResolutionBusy);
      };

      const setUnitCostBusy = (busy) => {
        const section = document.querySelector("#unit-cost-correction-section");
        const controls = [
          document.querySelector("#unit-cost-sku"),
          document.querySelector("#unit-cost-value"),
          document.querySelector("#update-unit-cost"),
        ].filter(Boolean);

        unitCostCorrectionBusy = busy;
        if (busy) invalidateQuantities("Finish the report correction, then check the Sheet again.");
        syncQuantityControls();
        section?.setAttribute("aria-busy", busy ? "true" : "false");
        controls.forEach((control) => {
          control.disabled = busy || inventoryCopying || currentUnitCostEntries.length === 0;
        });
      };

      const getSelectedUnitCostEntry = () => {
        const sku = document.querySelector("#unit-cost-sku")?.value;
        return currentUnitCostEntries.find((entry) => entry.sku === sku) ?? null;
      };

      const updateUnitCostPreview = () => {
        const entry = getSelectedUnitCostEntry();
        const preview = document.querySelector("#unit-cost-preview");
        const input = document.querySelector("#unit-cost-value");

        if (!preview || !entry) {
          if (preview) {
            preview.textContent = "";
          }
          return;
        }

        preview.textContent = createUnitCostImpactSummary(
          entry,
          parseNonnegativeUsdCents(input?.value),
        );
      };

      const displayReportUnitCosts = (entries, selectedSku = null) => {
        unitCostRefreshFailure = null;
        currentUnitCostEntries = Array.isArray(entries) ? entries : [];
        renderUnitCostCorrection(
          document,
          currentUnitCostEntries,
          selectedSku,
        );
        [
          document.querySelector("#unit-cost-sku"),
          document.querySelector("#unit-cost-value"),
          document.querySelector("#update-unit-cost"),
        ].filter(Boolean).forEach((control) => {
          control.title = "";
        });
        unitCostFeedback("");
        setUnitCostBusy(unitCostCorrectionBusy);
      };

      const showUnitCostRefreshFailure = (reportId, message) => {
        const section = document.querySelector("#unit-cost-correction-section");
        const disclosure = document.querySelector(
          "#unit-cost-correction-disclosure",
        );
        const controls = [
          document.querySelector("#unit-cost-sku"),
          document.querySelector("#unit-cost-value"),
          document.querySelector("#update-unit-cost"),
        ].filter(Boolean);

        unitCostRefreshFailure = { reportId, message };
        currentUnitCostEntries = [];
        renderUnitCostCorrection(document, currentUnitCostEntries);
        setUnitCostBusy(false);

        if (section) {
          section.hidden = false;
          section.setAttribute("aria-busy", "false");
        }
        if (disclosure) {
          disclosure.open = true;
        }
        controls.forEach((control) => {
          control.disabled = true;
          control.title = message;
        });
        unitCostFeedback(message, true);
      };

      const showError = (message) => {
        quantityLoading = false;
        setInventoryOptionsOpen(false);
        setQuantityPanelOpen(false);
        invalidateQuantities();
        document.querySelector("#report-loading").hidden = true;
        document.querySelector("#report-loading").setAttribute("aria-busy", "false");
        document.querySelector("#report-content").hidden = true;
        document.querySelector("#report-error").hidden = false;
        document.querySelector("#report-error-message").textContent = message;
        document.querySelector("#print-report").disabled = true;
        syncQuantityControls();
      };

      const hydrateRecord = (response) => {
        const report = typeof reportModule?.hydrateStreamReport === "function"
          ? reportModule.hydrateStreamReport(response.report)
          : response.report;

        return {
          reportId: response.reportId,
          lifecycleStatus: response.lifecycleStatus,
          displayName: response.displayName ?? null,
          report,
        };
      };

      let resolvePaymentOrder = null;

      const getPaymentFixingOrders = async (reportId) => {
        if (typeof client.listPaymentFixingOrders !== "function") {
          return [];
        }

        const response = await client.listPaymentFixingOrders({ reportId });
        return response.orders;
      };

      const getReportUnitCosts = async (reportId) => {
        if (typeof client.listReportUnitCosts !== "function") {
          return [];
        }

        const response = await client.listReportUnitCosts({ reportId });
        return response.skus;
      };

      const showCorrectionUnavailable = () => {
        const section = document.querySelector("#mapping-correction-section");
        const availability = document.querySelector(
          "#mapping-correction-availability",
        );
        const fields = document.querySelector("#mapping-correction-fields");
        const correctionFeedback = document.querySelector(
          "#mapping-correction-feedback",
        );
        const reason =
          "Mapping correction is unavailable. Reload the extension and try again.";

        if (section) {
          section.hidden = false;
          section.setAttribute("aria-busy", "false");
        }
        if (availability) {
          availability.hidden = false;
          availability.textContent = reason;
          availability.dataset.state = "unavailable";
        }
        if (fields) {
          fields.disabled = true;
        }
        if (correctionFeedback) {
          correctionFeedback.textContent = reason;
          correctionFeedback.className =
            "mapping-correction-feedback visually-hidden is-error";
        }
      };
      const isCurrentReportView = (reportId, sequence) =>
        !disposed && loadSequence === sequence && currentRecord?.reportId === reportId;

      let mappingCorrectionController = null;

      if (
        typeof dependencies.inlineCorrectionModule
          ?.createInlineReportCorrectionController === "function"
      ) {
        try {
          const controller = dependencies.inlineCorrectionModule
            .createInlineReportCorrectionController({
              document,
              client: correctionClient,
              onStatus: feedback,
              onStateChange: ({ reportId, busy }) => {
                if (disposed || currentRecord?.reportId !== reportId) return;
                if (busy) invalidateQuantities("Finish the mapping correction, then check the Sheet again.");
                else syncQuantityControls();
              },
              onSaved: async ({ reportId }) => {
                const refreshSequence = loadSequence;

                if (disposed || currentRecord?.reportId !== reportId) {
                  throw new Error(
                    "The viewed report changed before it could be refreshed.",
                  );
                }
                invalidateQuantities("The report correction was saved. Check the Sheet again before copying quantities.");

                const response = await client.getReport({ reportId });

                if (
                  !response?.report ||
                  response.reportId !== reportId ||
                  !isCurrentReportView(reportId, refreshSequence)
                ) {
                  throw new Error(
                    "The corrected saved report could not be reloaded safely.",
                  );
                }

                currentRecord = hydrateRecord(response);
                renderCurrentReport();

                try {
                  const entries = await getReportUnitCosts(reportId);

                  if (!isCurrentReportView(reportId, refreshSequence)) {
                    return;
                  }

                  displayReportUnitCosts(entries);
                } catch (_error) {
                  if (isCurrentReportView(reportId, refreshSequence)) {
                    showUnitCostRefreshFailure(
                      reportId,
                      "The mapping correction was saved, but unit-cost " +
                        "correction data could not refresh. Reload this report " +
                        "before correcting a unit cost.",
                    );
                  }
                }
              },
            });

          if (
            !controller ||
            typeof controller.load !== "function" ||
            typeof controller.getState !== "function"
          ) {
            throw new TypeError(
              "The inline mapping-correction controller is unavailable.",
            );
          }

          mappingCorrectionController = controller;
        } catch (_error) {
          mappingCorrectionController = null;
        }
      }

      if (!mappingCorrectionController) {
        showCorrectionUnavailable();
      }

      const refreshMappingCorrection = (reportId, optionsValue = {}) => {
        if (
          !mappingCorrectionController ||
          typeof mappingCorrectionController.load !== "function" ||
          currentRecord?.reportId !== reportId
        ) {
          return;
        }

        const refreshSequence = loadSequence;
        const correctionSequence = ++mappingCorrectionRefreshSequence;
        const handleFailure = () => {
          if (
            correctionSequence === mappingCorrectionRefreshSequence &&
            isCurrentReportView(reportId, refreshSequence)
          ) {
            showCorrectionUnavailable();
          }
        };

        try {
          const state = typeof mappingCorrectionController.getState === "function"
            ? mappingCorrectionController.getState()
            : null;

          if (state?.busy) {
            return;
          }

          Promise.resolve(
            mappingCorrectionController.load(reportId, optionsValue),
          ).catch(handleFailure);
        } catch (_error) {
          handleFailure();
        }
      };

      resolvePaymentOrder = async ({
        order,
        priceInput,
        resolution,
        soldPriceText,
      }) => {
        if (disposed || inventoryCopying || !currentRecord || typeof client.resolvePaymentFixingOrder !== "function") {
          return;
        }

        const variationNumber = safeInteger(order?.variationNumber);
        const soldPriceCents = resolution === "payment_complete"
          ? parsePositiveUsdCents(soldPriceText)
          : null;

        if (resolution === "payment_complete" && soldPriceCents === null) {
          resolutionFeedback(
            "Enter the final sold price as a positive dollar amount with no more than two decimal places.",
            true,
          );
          priceInput?.focus?.();
          return;
        }

        const itemDescription = order?.mapped
          ? getItemDescription(order)
          : "unmapped item";
        const confirmation = resolution === "payment_complete"
          ? `Mark variation #${variationNumber} Payment complete at ${formatUsdCents(soldPriceCents)} for ${itemDescription}? This permanently updates this saved report and its inventory totals.`
          : order?.mapped
            ? `Mark variation #${variationNumber} canceled? This permanently resolves the order and releases its inventory reservation.`
            : `Mark variation #${variationNumber} canceled? This permanently resolves the order as canceled.`;

        if (
          typeof dependencies.confirm !== "function" ||
          dependencies.confirm(confirmation) !== true
        ) {
          return;
        }

        const reportId = currentRecord.reportId;
        const mutationSequence = loadSequence;
        setResolutionBusy(true);
        resolutionFeedback(`Saving variation #${variationNumber}...`);

        try {
          const response = await client.resolvePaymentFixingOrder({
            reportId,
            variationNumber,
            resolution,
            soldPriceCents,
          });

          if (!isCurrentReportView(reportId, mutationSequence)) {
            return;
          }

          currentRecord = hydrateRecord(response);
          renderCurrentReport();
          displayPaymentFixingOrders(
            currentPaymentFixingOrders.filter(
              (candidate) => candidate.variationNumber !== variationNumber,
            ),
            resolvePaymentOrder,
          );

          const outcome = resolution === "payment_complete"
            ? "Payment complete"
            : "canceled";
          const successMessage = `Variation #${variationNumber} was marked ${outcome}. Report totals and inventory were updated.`;
          feedback(successMessage);
          resolutionFeedback(successMessage);

          try {
            const orders = await getPaymentFixingOrders(currentRecord.reportId);

            if (!isCurrentReportView(reportId, mutationSequence)) {
              return;
            }

            displayPaymentFixingOrders(orders, resolvePaymentOrder);
          } catch (_refreshError) {
            if (isCurrentReportView(reportId, mutationSequence)) {
              feedback(
                `${successMessage} Reload the report to recheck unfinished payments.`,
              );
            }
          }

          try {
            const entries = await getReportUnitCosts(currentRecord.reportId);

            if (!isCurrentReportView(reportId, mutationSequence)) {
              return;
            }

            displayReportUnitCosts(entries);
          } catch (_refreshError) {
            if (isCurrentReportView(reportId, mutationSequence)) {
              displayReportUnitCosts([]);
            }
          }

          refreshMappingCorrection(reportId, {
            preserveDraft: true,
          });
        } catch (error) {
          if (isCurrentReportView(reportId, mutationSequence)) {
            const message = error?.message ??
              "The unfinished payment could not be updated.";
            resolutionFeedback(message, true);
            feedback(message);
          }
        } finally {
          setResolutionBusy(false);
        }
      };

      const updateSelectedUnitCost = async () => {
        if (
          disposed || inventoryCopying || !currentRecord ||
          unitCostCorrectionBusy ||
          typeof client.updateReportUnitCost !== "function"
        ) {
          return;
        }

        const entry = getSelectedUnitCostEntry();
        const input = document.querySelector("#unit-cost-value");
        const unitCostCents = parseNonnegativeUsdCents(input?.value);

        if (!entry || unitCostCents === null) {
          unitCostFeedback(
            "Enter a nonnegative dollar amount with no more than two decimal places, such as 0.00 or 12.50.",
            true,
          );
          input?.focus?.();
          return;
        }

        const impact = createUnitCostImpactSummary(entry, unitCostCents);
        const confirmation =
          `Update ${entry.sku} from ${formatUsdCents(entry.unitCostCents)} to ${formatUsdCents(unitCostCents)}? ${impact} This changes only this saved report and its Google Sheets handoff. The live tracker, other reports, and future streams are unaffected.`;

        if (
          typeof dependencies.confirm !== "function" ||
          dependencies.confirm(confirmation) !== true
        ) {
          return;
        }

        const reportId = currentRecord.reportId;
        const mutationSequence = loadSequence;
        setUnitCostBusy(true);
        unitCostFeedback(`Updating ${entry.sku}...`);

        try {
          const response = await client.updateReportUnitCost({
            reportId,
            sku: entry.sku,
            unitCostCents,
          });

          if (!isCurrentReportView(reportId, mutationSequence)) {
            return;
          }

          currentRecord = hydrateRecord(response);
          renderCurrentReport();

          const successMessage =
            `${entry.sku} now uses ${formatUsdCents(unitCostCents)} in this report. Its metrics and Google Sheets handoff were updated; other reports and future streams were not changed.`;
          feedback(successMessage);
          unitCostFeedback(successMessage);

          try {
            const entries = await getReportUnitCosts(currentRecord.reportId);

            if (!isCurrentReportView(reportId, mutationSequence)) {
              return;
            }

            displayReportUnitCosts(entries, entry.sku);
            unitCostFeedback(successMessage);
          } catch (_refreshError) {
            if (isCurrentReportView(reportId, mutationSequence)) {
              displayReportUnitCosts([]);
              feedback(
                `${successMessage} Reload the report before making another ` +
                  "cost correction.",
              );
            }
          }

          refreshMappingCorrection(reportId, {
            preserveDraft: true,
          });
        } catch (error) {
          if (isCurrentReportView(reportId, mutationSequence)) {
            const message = error?.message ??
              "The corrected unit cost could not be saved. Try again.";
            unitCostFeedback(message, true);
            feedback(message);
          }
        } finally {
          setUnitCostBusy(false);
        }
      };

      const saveReportName = async () => {
        if (disposed || inventoryCopying) return;
        if (reportNameSave) {
          return reportNameSave.done;
        }
        if (
          !reportNameInput || reportNameInput.disabled ||
          !currentRecord || typeof client.renameReport !== "function"
        ) {
          return;
        }

        const enteredName = reportNameInput.value;
        const trimmedName = enteredName.trim();
        const displayName = trimmedName === "" ? null : trimmedName;
        const maxLength = protocol.MAX_REPORT_DISPLAY_NAME_LENGTH;

        if (
          trimmedName.length > maxLength ||
          /[\u0000-\u001f\u007f]/.test(enteredName)
        ) {
          showReportNameFeedback(
            `Use at most ${maxLength} characters with no line breaks or control characters.`,
            true,
          );
          return;
        }
        if (
          trimmedName === getReportDisplayName(currentRecord) ||
          displayName === currentRecord.displayName
        ) {
          reportNameDirty = false;
          showReportNameFeedback("");
          syncReportNameInput();
          return;
        }

        const reportId = currentRecord.reportId;
        const sequence = loadSequence;
        let finishSave;
        const save = {
          done: new Promise((resolve) => { finishSave = resolve; }),
        };
        reportNameSave = save;
        invalidateQuantities("Finish saving the report name, then check the Sheet again.");
        reportNameDirty = true;
        showReportNameFeedback("Saving report name...");
        syncReportNameInput();

        try {
          const response = await client.renameReport({ reportId, displayName });
          if (!isCurrentReportView(reportId, sequence) || reportNameSave !== save) {
            return;
          }
          if (response?.reportId !== reportId || response.displayName !== displayName) {
            throw new Error("The saved report name could not be confirmed. Try again.");
          }

          currentRecord = { ...currentRecord, displayName: response.displayName };
          reportNameDirty = false;
          document.querySelector("#report-name").textContent =
            getReportDisplayName(currentRecord);
          updateReportTitle(document, currentRecord);
          showReportNameFeedback(displayName === null
            ? "Default report name restored."
            : "Report name saved.");
        } catch (error) {
          if (isCurrentReportView(reportId, sequence) && reportNameSave === save) {
            showReportNameFeedback(
              error?.message ?? "The report name could not be saved. Try again.",
              true,
            );
          }
        } finally {
          if (reportNameSave === save) {
            reportNameSave = null;
            syncReportNameInput();
            syncQuantityControls();
          }
          finishSave();
        }
      };

      const load = async () => {
        if (disposed || inventoryCopying) return;
        setInventoryOptionsOpen(false);
        quantityLoading = true;
        setQuantityPanelOpen(false);
        invalidateQuantities();
        const sequence = ++loadSequence;
        reportNameSave = null;
        showReportNameFeedback("");
        if (reportNameInput) {
          reportNameInput.disabled = true;
        }
        document.querySelector("#report-loading").hidden = false;
        document.querySelector("#report-loading").setAttribute("aria-busy", "true");
        document.querySelector("#report-error").hidden = true;
        document.querySelector("#report-content").hidden = true;

        try {
          let reportId = getRequestedReportId(location, protocol);

          if (reportId === null) {
            const listing = await client.listReports();
            const newest = Array.isArray(listing?.reports)
              ? listing.reports[0]
              : null;

            if (!newest || typeof newest.reportId !== "string") {
              throw new Error("No saved stream report is available yet.");
            }

            reportId = newest.reportId;
          }

          const response = await client.getReport({ reportId });

          if (sequence !== loadSequence) {
            return;
          }

          if (!response?.report || response.reportId !== reportId) {
            throw new Error("The requested saved stream report was not found.");
          }

          const previousReportId = currentRecord?.reportId ?? null;
          currentRecord = hydrateRecord(response);

          if (
            previousReportId !== null &&
            previousReportId !== currentRecord.reportId
          ) {
            displayPaymentFixingOrders([], resolvePaymentOrder);
            displayReportUnitCosts([]);
          }

          renderCurrentReport();
          resolutionFeedback("");
          if (
            unitCostRefreshFailure === null ||
            unitCostRefreshFailure.reportId !== currentRecord.reportId
          ) {
            unitCostFeedback("");
          }
          refreshMappingCorrection(currentRecord.reportId);

          try {
            const orders = await getPaymentFixingOrders(currentRecord.reportId);

            if (!isCurrentReportView(reportId, sequence)) {
              return;
            }

            displayPaymentFixingOrders(orders, resolvePaymentOrder);
          } catch (error) {
            if (!isCurrentReportView(reportId, sequence)) {
              return;
            }

            displayPaymentFixingOrders([], resolvePaymentOrder);
            feedback(
              error?.message ??
                "Unfinished payments could not be checked. Reload the report to try again.",
            );
          }

          try {
            const entries = await getReportUnitCosts(currentRecord.reportId);

            if (!isCurrentReportView(reportId, sequence)) {
              return;
            }

            displayReportUnitCosts(entries);
          } catch (error) {
            if (!isCurrentReportView(reportId, sequence)) {
              return;
            }

            if (unitCostRefreshFailure?.reportId === reportId) {
              showUnitCostRefreshFailure(
                reportId,
                unitCostRefreshFailure.message,
              );
            } else {
              displayReportUnitCosts([]);
            }
            feedback(
              error?.message ??
                "Unit costs could not be checked. Reload the report to try again.",
            );
          }

          if (sequence !== loadSequence) {
            return;
          }

          document.querySelector("#report-loading").setAttribute("aria-busy", "false");
          quantityLoading = false;
          syncQuantityControls();
          document.querySelector("#report-content").focus();
        } catch (error) {
          if (sequence !== loadSequence) {
            return;
          }

          showError(
            error?.message ||
              "The locally saved report could not be loaded. Nothing was changed.",
          );
        }
      };

      reportNameInput?.addEventListener("input", () => {
        if (inventoryCopying) {
          reportNameInput.value = quantityCopyNameDraft;
          return;
        }
        reportNameDirty = true;
        showReportNameFeedback("");
      });
      reportNameInput?.addEventListener("blur", saveReportName);
      reportNameInput?.addEventListener("keydown", (event) => {
        if (event.isComposing || reportNameSave || inventoryCopying) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          return saveReportName();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          reportNameDirty = false;
          showReportNameFeedback("");
          syncReportNameInput();
        }
      });

      document.querySelector("#retry-report").addEventListener("click", load);
      quantityForm?.addEventListener("submit", prepareQuantities);
      quantitySheetInput?.addEventListener("input", () => {
        if (inventoryCopying) {
          quantitySheetInput.value = quantityCopyReference;
          return;
        }
        invalidateQuantities("Sheet link changed. Check the Sheet again.");
      });
      copyQuantityButton?.addEventListener("click", copyQuantities);
      document.querySelector("#unit-cost-sku")?.addEventListener("change", () => {
        const entry = getSelectedUnitCostEntry();
        const input = document.querySelector("#unit-cost-value");

        if (entry && input) {
          input.value = (entry.unitCostCents / 100).toFixed(2);
        }
        unitCostFeedback("");
        updateUnitCostPreview();
      });
      document.querySelector("#unit-cost-value")?.addEventListener(
        "input",
        updateUnitCostPreview,
      );
      document.querySelector("#update-unit-cost")?.addEventListener(
        "click",
        updateSelectedUnitCost,
      );
      document.querySelector("#print-report").addEventListener("click", async () => {
        if (!currentRecord) {
          return;
        }
        const reportId = currentRecord.reportId;
        const sequence = loadSequence;
        await saveReportName();
        if (isCurrentReportView(reportId, sequence) && !reportNameDirty) {
          expandVariationsForPrint();
          try {
            dependencies.print();
          } catch (error) {
            feedback(error?.message ?? "The print dialog could not be opened.");
          } finally {
            // Chrome's print dialog is synchronous. Also restore if it is
            // canceled or throws before an afterprint event can arrive.
            restoreVariationsAfterPrint();
          }
        }
      });
      inventoryCopyButton?.addEventListener("click", () => {
        if (!canUseQuantities() || quantityBusy || inventoryCopying || !quantityPanel) return;
        setInventoryOptionsOpen(false);
        setQuantityPanelOpen(quantityPanel.hidden);
      });
      inventoryOptionsButton?.addEventListener("click", () => {
        if (!canUseInventoryExports() || !inventoryOptionsPanel) return;
        setInventoryOptionsOpen(inventoryOptionsPanel.hidden);
      });
      const dismissInventoryOptions = (event) => {
        if (inventoryOptionsPanel?.hidden !== false) return;
        if (!inventoryOptionsContainer?.contains(event.target)) setInventoryOptionsOpen(false);
      };
      const handleInventoryOptionsKey = (event) => {
        if (event.key !== "Escape" || inventoryOptionsPanel?.hidden !== false) return;
        event.preventDefault();
        setInventoryOptionsOpen(false, true);
      };
      document.addEventListener?.("click", dismissInventoryOptions);
      document.addEventListener?.("keydown", handleInventoryOptionsKey);
      inventoryCsvButton?.addEventListener("click", () => {
        if (!canUseInventoryExports() || inventoryOptionsPanel?.hidden !== false) return;
        setInventoryOptionsOpen(false, true);

        try {
          const filename = downloadCsv(
            document,
            dependencies,
            currentRecord.report,
            serializeInventoryCsv(currentRecord.report, reportModule),
          );
          feedback(`Downloaded ${filename}`);
        } catch (error) {
          feedback(error?.message ?? "The updated inventory CSV could not be downloaded.");
        }
      });
      inventoryUnformattedButton?.addEventListener("click", async () => {
        if (!canUseInventoryExports() || inventoryOptionsPanel?.hidden !== false) return;
        const reportKey = quantityReportKey();
        const sequence = loadSequence;
        const locationSearch = location?.search;
        const isCurrent = () => !disposed && sequence === loadSequence &&
          reportKey === quantityReportKey() && locationSearch === location?.search;
        setInventoryOptionsOpen(false, true);
        setInventoryCopying(true);
        try {
          await copyUpdatedInventory(navigator, currentRecord.report, reportModule);
          if (isCurrent()) feedback("Inventory copied. Paste into spreadsheet cell A1.");
        } catch (error) {
          if (isCurrent()) feedback(error?.message ?? "The updated inventory could not be copied.");
        } finally {
          setInventoryCopying(false);
        }
      });

      const dispose = () => {
        disposed = true;
        loadSequence += 1;
        setInventoryOptionsOpen(false);
        setQuantityPanelOpen(false);
        invalidateQuantities();
        document.removeEventListener?.("click", dismissInventoryOptions);
        document.removeEventListener?.("keydown", handleInventoryOptionsKey);
        mappingCorrectionController?.destroy?.();
      };
      (dependencies.lifecycleEventTarget ?? document.defaultView)?.addEventListener("pagehide", dispose);
      load();
      return Object.freeze({ load, dispose });
    }

    return Object.freeze({
      SHEET_HEADERS,
      copyUpdatedInventory,
      createFileStamp,
      createReportFilename,
      createSummaryMetrics,
      downloadCsv,
      formatTimestamp,
      formatPercentage,
      formatUsdCents,
      getRequestedReportId,
      mountStreamReportPage,
      parseNonnegativeUsdCents,
      parsePositiveUsdCents,
      renderCanceledOrders,
      renderItemVariations,
      renderPaymentFixingOrders,
      renderReport,
      renderUnitCostCorrection,
      serializeInventoryCsv,
      serializeInventoryTsv,
    });
  },
);
