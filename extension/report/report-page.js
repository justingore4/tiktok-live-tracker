(function initializeStreamReportPage(root, factory) {
  const streamReportPage = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = streamReportPage;
  }

  root.TikTokLiveTrackerStreamReportPage = streamReportPage;

  if (root.document && root.addEventListener) {
    const start = () => {
      streamReportPage.mountStreamReportPage({
        document: root.document,
        location: root.location,
        history: root.history,
        navigator: root.navigator,
        runtime: root.chrome?.runtime,
        protocol: root.TikTokLiveTrackerStreamReportProtocol,
        reportModule: root.TikTokLiveTrackerStreamReport,
        clientModule: root.TikTokLiveTrackerStreamReportClient,
        addEventListener: root.addEventListener.bind(root),
        print: () => root.print(),
        Blob: root.Blob,
        URL: root.URL,
        setTimeout: root.setTimeout.bind(root),
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
  function createStreamReportPageModule() {
    "use strict";

    const SHEET_HEADERS = Object.freeze([
      "sku",
      "item",
      "style",
      "size",
      "quantity_on_hand_at_import",
      "unit_cost",
    ]);
    const DEFAULT_DEFINITIONS = Object.freeze([
      Object.freeze({
        term: "TikTok Attributed GMV",
        description:
          "The last value displayed by TikTok during tracking. TikTok may abbreviate or round this display, and it can include buyer-paid shipping.",
      }),
      Object.freeze({
        term: "GMV / No shipping",
        description:
          "The sum of captured sold prices for orders marked Payment complete. Buyer-paid shipping is not included.",
      }),
      Object.freeze({
        term: "Gross profit",
        description:
          "Mapped completed-sale revenue minus the imported seller unit cost. It is not net profit and excludes platform fees, shipping labels, refunds, ads, taxes, and other expenses.",
      }),
      Object.freeze({
        term: "Updated count",
        description:
          "Opening quantity minus mapped completed sales across the inventory baseline, clamped to zero for the Sheet replacement value. Pending and canceled orders do not permanently reduce this count.",
      }),
    ]);
    const WARNING_MESSAGES = Object.freeze({
      active_bidding_at_end:
        "A bidding variation was still active when tracking ended.",
      reconciliation_conflicts:
        "At least one captured order contains conflicting observations and should be reviewed.",
      inventory_recount_required:
        "At least one SKU was allocated beyond its opening quantity. Review the oversold amount and recount physical stock.",
      payment_fixing_orders:
        "At least one order was still in the payment-fixing buffer when tracking ended.",
      pending_inventory_reservations:
        "At least one inventory reservation was unresolved when tracking ended.",
      unmapped_completed_sales:
        "At least one completed sale has no inventory item, so inventory and gross profit are incomplete.",
      unresolved_orders:
        "At least one captured order was unresolved when tracking ended.",
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

    function getPendingQuantity(entry) {
      return safeInteger(
        entry?.pendingQuantity ??
          entry?.reservedQuantity,
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
      const committedRevenueCents = safeInteger(totals.committedRevenueCents);
      const grossProfitCents = safeInteger(
        totals.grossProfitCents ?? totals.profitCents,
      );

      return [
        {
          label: "TikTok Attributed GMV",
          value: attributedGmvDisplay,
          note: "Last dashboard display; may include shipping",
        },
        {
          label: "GMV / No shipping",
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
          label: "Payment fixing",
          value: String(safeInteger(totals.paymentFixingCount)),
          note: "Still inside the payment buffer",
        },
        {
          label: "Average completed sale",
          value:
            completedCount > 0
              ? formatUsdCents(
                  Math.round(safeInteger(totals.completedGmvCents) / completedCount),
                )
              : "Not available",
          note: "Sold-price average; shipping excluded",
        },
        {
          label: "Mapped cost of goods",
          value: formatUsdCents(totals.costOfGoodsCents),
          note: "Imported unit costs for mapped completed sales",
        },
        {
          label: "Mapped gross margin",
          value: formatPercentage(grossProfitCents, committedRevenueCents),
          note: "Gross profit divided by mapped revenue",
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

    function buildSkuCountText(report) {
      if (Array.isArray(report?.inventoryUpdateLines)) {
        return report.inventoryUpdateLines
          .filter((line) => typeof line === "string")
          .join("\n");
      }

      return (Array.isArray(report?.inventory) ? report.inventory : [])
        .map(
          (entry) =>
            `SKU: ${String(entry?.sku ?? "")} Updated count: ${getUpdatedQuantity(entry)}`,
        )
        .join("\n");
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
      const sku = typeof warning.sku === "string" ? warning.sku : null;

      return [
        base,
        count > 0 ? `Count: ${count}.` : "",
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
        appendTextElement(document, card, "dt", metric.label);
        appendTextElement(document, card, "dd", metric.value);
        appendTextElement(document, card, "small", metric.note);
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

    function renderCompletedSales(document, report) {
      const body = document.querySelector("#completed-sales-rows");
      const empty = document.querySelector("#sales-empty");
      const count = document.querySelector("#sales-count");
      const sales = Array.isArray(report?.completedSales)
        ? report.completedSales
        : [];
      const rows = sales.map((sale) => {
        const row = document.createElement("tr");
        const mapped = typeof sale?.sku === "string" && sale.sku !== "";
        row.append(
          createTableCell(document, `#${safeInteger(sale?.variationNumber)}`),
          createTableCell(document, mapped ? sale.sku : "Unmapped", {
            className: mapped ? "sku-cell" : "warning-cell",
          }),
          createTableCell(document, mapped ? sale?.item : "Not selected"),
          createTableCell(document, mapped ? sale?.style : "—", {
            className: mapped ? "" : "muted-cell",
          }),
          createTableCell(document, mapped ? sale?.size : "—", {
            className: mapped ? "" : "muted-cell",
          }),
          createTableCell(document, formatUsdCents(sale?.soldPriceCents), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(getSaleCostCents(sale), "—"), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(getSaleProfitCents(sale), "—"), {
            className: "number-cell",
          }),
        );
        return row;
      });
      replaceChildren(body, rows);
      empty.hidden = rows.length !== 0;
      count.textContent = `${rows.length} completed sale${rows.length === 1 ? "" : "s"}`;
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
        .filter((entry) => safeInteger(entry?.soldQuantity) > 0);
      const rows = performance.map((entry) => {
        const row = document.createElement("tr");
        const openingQuantity = getOpeningQuantity(
          inventoryBySku.get(entry.sku),
        );
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
          createTableCell(document, formatUsdCents(entry?.revenueCents), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(entry?.costOfGoodsCents), {
            className: "number-cell",
          }),
          createTableCell(document, formatUsdCents(entry?.grossProfitCents), {
            className: "number-cell",
          }),
          createTableCell(
            document,
            formatPercentage(entry?.grossProfitCents, entry?.revenueCents),
            { className: "number-cell" },
          ),
          createTableCell(
            document,
            formatPercentage(entry?.soldQuantity, openingQuantity),
            { className: "number-cell" },
          ),
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
          createTableCell(document, getOpeningQuantity(entry), { className: "number-cell" }),
          createTableCell(document, getCompletedQuantity(entry), { className: "number-cell" }),
          createTableCell(document, getPendingQuantity(entry), { className: "number-cell" }),
          createTableCell(document, getUpdatedQuantity(entry), { className: "number-cell" }),
          createTableCell(document, oversold, {
            className: oversold > 0 ? "number-cell warning-cell" : "number-cell",
          }),
        );
        return row;
      });
      replaceChildren(body, rows);
      document.querySelector("#sku-count-list").textContent = buildSkuCountText(report);
    }

    function renderDefinitions(document) {
      const list = document.querySelector("#report-definitions");
      const children = [];
      DEFAULT_DEFINITIONS.forEach(({ term, description }) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = term;
        dd.textContent = description;
        children.push(dt, dd);
      });
      replaceChildren(list, children);
    }

    function renderReport(document, record) {
      const report = record.report;
      const metadata = isPlainRecord(report?.metadata) ? report.metadata : {};
      document.querySelector("#stream-started").textContent =
        formatTimestamp(metadata.startedAt);
      document.querySelector("#stream-ended").textContent =
        formatTimestamp(metadata.endedAt);
      document.querySelector("#stream-reference").textContent =
        typeof metadata.streamId === "string" ? metadata.streamId : "Unavailable";
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
      renderCompletedSales(document, report);
      renderSkuPerformance(document, report);
      renderInventory(document, report);
      renderDefinitions(document);

      document.title = createReportFilename(report, "Stream-Report", "pdf")
        .replace(/\.pdf$/i, "");
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

    function createPrintDisclosureController(document) {
      const disclosure = document?.querySelector?.(
        "#completed-sales-disclosure",
      );
      let wasOpen = null;

      const prepare = () => {
        if (!disclosure) {
          return;
        }

        if (wasOpen === null) {
          wasOpen = disclosure.open === true;
        }
        disclosure.open = true;
      };

      const restore = () => {
        if (!disclosure || wasOpen === null) {
          return;
        }

        disclosure.open = wasOpen;
        wasOpen = null;
      };

      return Object.freeze({ prepare, restore });
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
      let currentRecord = null;
      let loadSequence = 0;
      const printDisclosure = createPrintDisclosureController(document);

      if (typeof dependencies.addEventListener === "function") {
        dependencies.addEventListener("beforeprint", printDisclosure.prepare);
        dependencies.addEventListener("afterprint", printDisclosure.restore);
      }

      const feedback = (message) => {
        document.querySelector("#action-feedback").textContent = message;
      };

      const showError = (message) => {
        document.querySelector("#report-loading").hidden = true;
        document.querySelector("#report-loading").setAttribute("aria-busy", "false");
        document.querySelector("#report-content").hidden = true;
        document.querySelector("#report-error").hidden = false;
        document.querySelector("#report-error-message").textContent = message;
        document.querySelector("#print-report").disabled = true;
      };

      const load = async () => {
        const sequence = ++loadSequence;
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

          const report = typeof reportModule?.hydrateStreamReport === "function"
            ? reportModule.hydrateStreamReport(response.report)
            : response.report;
          currentRecord = {
            reportId: response.reportId,
            lifecycleStatus: response.lifecycleStatus,
            report,
          };
          renderReport(document, currentRecord);
          document.querySelector("#report-loading").setAttribute("aria-busy", "false");
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

      document.querySelector("#retry-report").addEventListener("click", load);
      document.querySelector("#print-report").addEventListener("click", () => {
        if (currentRecord) {
          printDisclosure.prepare();
          try {
            dependencies.print();
          } catch (error) {
            printDisclosure.restore();
            throw error;
          }
        }
      });
      document.querySelector("#copy-inventory").addEventListener("click", async () => {
        if (!currentRecord) {
          return;
        }

        try {
          await writeClipboard(
            navigator,
            serializeInventoryTsv(currentRecord.report, reportModule),
          );
          feedback("Updated six-column inventory copied. Paste it into Google Sheets.");
        } catch (error) {
          feedback(error?.message ?? "Updated inventory could not be copied.");
        }
      });
      document.querySelector("#copy-sku-counts").addEventListener("click", async () => {
        if (!currentRecord) {
          return;
        }

        try {
          await writeClipboard(navigator, buildSkuCountText(currentRecord.report));
          feedback("SKU updated counts copied.");
        } catch (error) {
          feedback(error?.message ?? "SKU counts could not be copied.");
        }
      });
      document.querySelector("#download-inventory").addEventListener("click", () => {
        if (!currentRecord) {
          return;
        }

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

      load();
      return Object.freeze({ load });
    }

    return Object.freeze({
      DEFAULT_DEFINITIONS,
      SHEET_HEADERS,
      buildSkuCountText,
      createPrintDisclosureController,
      createFileStamp,
      createReportFilename,
      createSummaryMetrics,
      downloadCsv,
      formatTimestamp,
      formatPercentage,
      formatUsdCents,
      getRequestedReportId,
      mountStreamReportPage,
      renderReport,
      serializeInventoryCsv,
      serializeInventoryTsv,
    });
  },
);
