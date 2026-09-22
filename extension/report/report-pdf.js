(function initializeReportPdf(root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(
    root,
    node ? require("./report-page.js") : root.TikTokLiveTrackerStreamReportPage,
    node ? require("../vendor/jspdf/jspdf.umd.min.js").jsPDF : root.jspdf?.jsPDF,
    node
      ? require("../vendor/jspdf-autotable/jspdf.plugin.autotable.min.js").autoTable
      : null,
  );
  if (node) module.exports = api;
  root.TikTokLiveTrackerReportPdf = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createReportPdfModule(
  root, reportPage, DefaultJsPDF, defaultAutoTable,
) {
  "use strict";

  const TABLES = Object.freeze([
    {
      key: "performance", selector: "#performance-rows",
      eyebrow: "Inventory-connected analytics", title: "SKU performance",
      count: "#performance-row-count", empty: "No mapped completed sales are available for SKU performance.",
      headers: ["SKU", "Product", "Size", "Units sold", "Unit cost", "Avg. sale price", "Revenue", "COGS", "Sell-through", "Gross margin", "Gross profit/loss"],
      widths: [42, 67, 26, 32, 42, 46, 49, 45, 43, 43, 57],
    },
    {
      key: "inventory", selector: "#inventory-rows",
      eyebrow: "Google Sheets handoff", title: "Updated inventory",
      headers: ["SKU", "Item", "Style", "Size", "Unit cost", "Opening", "Sold", "Updated count", "Oversold"],
      widths: [66, 107, 66, 34, 53, 42, 36, 64, 44],
    },
    {
      key: "variations", selector: "#completed-sales-rows",
      eyebrow: "Stream variations", title: "Item variations this stream",
      count: "#sales-count", note: "#variation-details-note",
      empty: "No completed or canceled item variations were captured for this stream.",
      headers: ["Variation", "Status", "SKU", "Item", "Style", "Size", "Sold price", "Unit cost", "Gross profit"],
      widths: [51, 49, 63, 94, 58, 31, 57, 51, 58],
    },
    {
      key: "canceled", selector: "#canceled-orders-rows",
      eyebrow: "Canceled variations", title: "Canceled orders",
      count: "#canceled-orders-count", note: "#canceled-orders-note",
      empty: "No canceled orders were captured for this stream.",
      emptySelector: "#canceled-orders-empty",
      headers: ["Variation", "Status", "SKU", "Item", "Style", "Size"],
      widths: [58, 64, 99, 139, 110, 46],
    },
  ]);
  const COLORS = Object.freeze({
    section: [31, 38, 46], cover: [18, 57, 88], text: [17, 24, 32],
    muted: [71, 84, 98], light: [245, 247, 250], border: [174, 180, 187],
    green: [8, 108, 92], positive: [6, 118, 71], negative: [180, 35, 24],
    warning: [112, 73, 0], notice: [43, 39, 29], amber: [255, 221, 155],
  });
  const FONT = "ReportSans";
  let browserFontsPromise;

  // Reuse the existing report presentation, including all accounting, fallback,
  // sorting and legacy-report rules. This text-only adapter never mounts the UI,
  // parses report data as HTML, or accesses extension storage.
  function createTextDocument() {
    function element() {
      let text = "";
      return {
        children: [], hidden: false, className: "",
        get textContent() { return text + this.children.map((child) => child.textContent).join(""); },
        set textContent(value) { text = String(value ?? ""); this.children = []; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { text = ""; this.children = children; },
      };
    }
    const nodes = new Map();
    return {
      createElement: element,
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      },
    };
  }

  function createReportPresentation(record) {
    if (!record || !record.report || typeof record.report !== "object") {
      throw new Error("The saved report is unavailable for PDF export.");
    }
    const document = createTextDocument();
    reportPage.renderReport(document, record);
    const node = (selector) => document.querySelector(selector);
    const tables = TABLES.map((definition) => ({
      ...definition,
      headers: [...definition.headers], widths: [...definition.widths],
      count: definition.count ? node(definition.count).textContent : "",
      note: definition.note && !node(definition.note).hidden ? node(definition.note).textContent : "",
      emptyHidden: definition.emptySelector ? node(definition.emptySelector).hidden : false,
      rows: node(definition.selector).children.map((row) => row.children.map((cell) => ({
        text: cell.textContent, className: cell.className,
      }))),
    }));
    const performers = [
      ["Most sold SKU", "By completed units", "#most-sold-items"],
      ["Most profitable SKU", "By mapped gross profit", "#most-profitable-items"],
      ["Most sold product", "Combined across sizes", "#most-sold-products", "#most-sold-products-card"],
      ["Most profitable product", "Combined across sizes", "#most-profitable-products", "#most-profitable-products-card"],
    ].filter(([, , , card]) => !card || !node(card).hidden).map(([title, kicker, selector]) => ({
      title, kicker,
      rows: node(selector).children.map((row) => ({
        description: row.children[0]?.children.map((child) => child.textContent).join("\n") ?? row.textContent,
        value: row.children[1]?.textContent ?? "",
      })),
    }));
    return {
      name: node("#report-name").textContent,
      started: node("#stream-started").textContent,
      ended: node("#stream-ended").textContent,
      metrics: reportPage.createSummaryMetrics(record.report),
      warnings: node("#report-warnings").children.map((entry) => entry.textContent),
      tables, performers,
      footer: [node("#stream-reference").textContent, node("#report-generated-at").textContent],
    };
  }

  async function loadBrowserFonts() {
    if (!browserFontsPromise) {
      browserFontsPromise = Promise.all(["Regular", "Bold"].map(async (weight) => {
        if (!root.chrome?.runtime?.getURL || typeof root.fetch !== "function") {
          throw new Error("The bundled PDF fonts could not be loaded.");
        }
        const response = await root.fetch(root.chrome.runtime.getURL(`vendor/fonts/DejaVuSans${weight === "Bold" ? "-Bold" : ""}.ttf`));
        if (!response.ok) throw new Error("The bundled PDF fonts could not be loaded.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        return root.btoa(binary);
      })).then(([normal, bold]) => ({ normal, bold })).catch((error) => {
        browserFontsPromise = null;
        throw error;
      });
    }
    return browserFontsPromise;
  }

  function printableStrings(model) {
    return [
      model.name, model.started, model.ended, ...model.warnings, ...model.footer,
      ...model.metrics.flatMap((metric) => [metric.label, metric.value ?? "", metric.note,
        ...(metric.rows ?? []).flatMap((row) => [row.label, row.value])]),
      ...model.tables.flatMap((table) => [table.title, table.count, table.note, ...table.headers,
        ...table.rows.flatMap((row) => row.map((cell) => cell.text))]),
      ...model.performers.flatMap((card) => [card.title, ...card.rows.flatMap((row) => [row.description, row.value])]),
    ];
  }

  function validateFontCoverage(doc, model) {
    const unsupported = new Set();
    for (const style of ["normal", "bold"]) {
      doc.setFont(FONT, style);
      const glyphs = doc.getFont().metadata?.cmap?.unicode?.codeMap;
      if (!glyphs) throw new Error("The bundled PDF font could not be initialized.");
      for (const value of printableStrings(model)) {
        for (const character of String(value ?? "")) {
          if (!/\s/u.test(character) && !glyphs[character.codePointAt(0)]) unsupported.add(character);
        }
      }
    }
    if (unsupported.size > 0) {
      throw new Error(`The bundled PDF font cannot display these characters: ${[...unsupported].slice(0, 12).join(" ")}. Use Print / Save as PDF for this report.`);
    }
  }

  async function generateReportPdf(record, options = {}) {
    const model = createReportPresentation(record);
    const JsPDF = options.jsPDF ?? DefaultJsPDF;
    if (typeof JsPDF !== "function") throw new Error("The bundled PDF library is unavailable.");
    const doc = new JsPDF({ orientation: "portrait", unit: "pt", format: "letter", compress: true, putOnlyUsedFonts: true });
    const fonts = options.fonts ?? await loadBrowserFonts();
    for (const style of ["normal", "bold"]) {
      if (typeof fonts?.[style] !== "string" || !fonts[style]) throw new Error("The bundled PDF fonts are unavailable.");
      doc.addFileToVFS(`${FONT}-${style}.ttf`, fonts[style]);
      doc.addFont(`${FONT}-${style}.ttf`, FONT, style);
    }
    validateFontCoverage(doc, model);
    const autoTable = options.autoTable ?? defaultAutoTable ?? ((document, settings) => {
      if (typeof document.autoTable !== "function") throw new Error("The bundled PDF table library is unavailable.");
      document.autoTable(settings);
    });
    doc.setProperties({ title: model.name, subject: "Post Stream Report", creator: "TikTok Live Tracker" });
    doc.setLineHeightFactor(1.25);
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 36;
    const width = pageWidth - margin * 2;
    const bottom = pageHeight - margin;
    let y = margin;

    function font(size, bold = false, color = COLORS.text) {
      doc.setFont(FONT, bold ? "bold" : "normal");
      doc.setFontSize(size);
      doc.setTextColor(...color);
    }
    function lines(text, maxWidth, size, bold = false) {
      font(size, bold);
      return doc.splitTextToSize(String(text ?? ""), maxWidth);
    }
    function text(textLines, x, top, size, bold = false, color = COLORS.text) {
      font(size, bold, color);
      doc.text(textLines, x, top + size, { lineHeightFactor: 1.25 });
    }
    function box(x, top, boxWidth, height, fill, border = fill, radius = 5) {
      doc.setFillColor(...fill);
      doc.setDrawColor(...border);
      doc.setLineWidth(0.5);
      doc.roundedRect(x, top, boxWidth, height, radius, radius, "FD");
    }
    function ensureSpace(height) {
      if (y + height > bottom) { doc.addPage(); y = margin; }
    }
    function paragraph(value, size = 8, color = COLORS.muted) {
      const wrapped = lines(value, width - 24, size);
      const availableLines = Math.floor((bottom - margin) / (size * 1.25));
      for (let offset = 0; offset < wrapped.length; offset += availableLines) {
        const part = wrapped.slice(offset, offset + availableLines);
        const height = part.length * size * 1.25 + 8;
        ensureSpace(height);
        text(part, margin + 12, y, size, false, color);
        y += height;
      }
    }
    function heading(top, eyebrow, title, count = "", continued = false) {
      doc.setFillColor(...COLORS.section);
      doc.rect(margin, top, width, 44, "F");
      text(eyebrow.toLocaleUpperCase("en-US"), margin + 12, top + 8, 6.5, true, [255, 255, 255]);
      text(`${title}${continued ? " (continued)" : ""}`, margin + 12, top + 21, 12.5, true, [255, 255, 255]);
      if (count) {
        font(7, false, [255, 255, 255]);
        doc.text(count, pageWidth - margin - 12, top + 32, { align: "right" });
      }
    }

    const columnWidth = (width - 40) / 3;
    const meta = [
      ["Stream tracking started", model.started], ["Tracking ended", model.ended], ["Report name", model.name],
    ];
    const metaLines = meta.map(([, value]) => lines(value, columnWidth - 12, 9, true));
    const coverHeight = 72 + Math.max(...metaLines.map((entry) => entry.length)) * 11.25;
    box(margin, y, width, coverHeight, COLORS.cover);
    text("Post Stream Report", margin + 14, y + 10, 20, true, [255, 255, 255]);
    doc.setDrawColor(86, 123, 150);
    doc.line(margin + 14, y + 43, pageWidth - margin - 14, y + 43);
    meta.forEach(([label], index) => {
      const x = margin + 14 + index * (columnWidth + 6);
      text(label, x, y + 52, 7, true, [201, 219, 232]);
      text(metaLines[index], x, y + 65, 9, true, [255, 255, 255]);
    });
    y += coverHeight + 12;

    // Notices share the heading row, with continuations only for unusually long
    // notice lists. All notices are retained; none are clipped or ellipsized.
    const notices = model.warnings.flatMap((warning) => lines(`• ${warning}`, width - 284, 7));
    let noticeOffset = 0;
    do {
      const maxLines = Math.max(1, Math.floor((bottom - margin - 34) / 8.75));
      const noticeLines = notices.slice(noticeOffset, noticeOffset + maxLines);
      const height = Math.max(52, noticeLines.length * 8.75 + 24);
      ensureSpace(height + 10);
      box(margin, y, width, height, COLORS.section);
      text("PERFORMANCE", margin + 12, y + 12, 7, true, [255, 255, 255]);
      text(noticeOffset ? "Stream summary (continued)" : "Stream summary", margin + 12, y + 27, noticeOffset ? 10 : 14, true, [255, 255, 255]);
      if (noticeLines.length) {
        box(margin + 170, y + 8, width - 182, height - 16, COLORS.notice, [154, 107, 22]);
        text(["REVIEW BEFORE", "UPDATING INVENTORY"], margin + 178, y + 15, 5.5, true, [255, 255, 255]);
        text("Report notices", margin + 178, y + 33, 8, true, [255, 255, 255]);
        text(noticeLines, margin + 272, y + 13, 7, false, COLORS.amber);
      }
      y += height;
      noticeOffset += noticeLines.length;
      if (noticeOffset < notices.length) y += 12;
    } while (noticeOffset < notices.length);

    const gap = 6;
    const cardWidth = (width - 24 - gap * 3) / 4;
    for (let index = 0; index < model.metrics.length; index += 4) {
      const cards = model.metrics.slice(index, index + 4).map((metric) => {
        const label = lines(metric.label, cardWidth - 14, 7.7, true);
        const note = lines(metric.note, cardWidth - 14, 7);
        const value = metric.rows ? null : lines(metric.value, cardWidth - 14, 16, true);
        const feeRows = (metric.rows ?? []).map((row) => {
          const valueLines = lines(row.value, cardWidth - 14, 9, true);
          return { label: row.label, value: valueLines, height: 9 + valueLines.length * 11.25 + 5 };
        });
        const middleHeight = metric.rows ? feeRows.reduce((sum, row) => sum + row.height, 0) : Math.max(32, value.length * 20 + 8);
        return { metric, label, note, value, feeRows, middleHeight, height: 17 + label.length * 9.625 + middleHeight + note.length * 8.75 };
      });
      const rowHeight = Math.max(...cards.map((card) => card.height));
      ensureSpace(rowHeight + 18);
      doc.setFillColor(...COLORS.section);
      doc.rect(margin, y, width, rowHeight + 12, "F");
      cards.forEach(({ metric, label, note, value, feeRows, middleHeight }, column) => {
        const x = margin + 12 + column * (cardWidth + gap);
        box(x, y + 5, cardWidth, rowHeight, COLORS.light, metric.warning ? [154, 107, 22] : COLORS.border);
        text(label, x + 7, y + 12, 7.7, true, COLORS.muted);
        const middleTop = y + 12 + label.length * 9.625 + 5;
        if (metric.rows) {
          let feeTop = middleTop;
          feeRows.forEach((row) => {
            text(row.label, x + 7, feeTop, 6.3, true, COLORS.muted);
            // Fee values occupy a dedicated line, so large amounts cannot collide
            // with their labels in the narrow four-column print grid.
            text(row.value, x + 7, feeTop + 9, 9, true, COLORS.green);
            feeTop += row.height;
          });
        } else {
          text(value, x + 7, middleTop, 16, true, COLORS.green);
        }
        text(note, x + 7, middleTop + middleHeight, 7, metric.warning, metric.warning ? COLORS.warning : COLORS.muted);
      });
      y += rowHeight + 12;
    }
    y += 12;

    function drawTable(table) {
      ensureSpace(108);
      const start = y;
      heading(start, table.eyebrow, table.title, table.count);
      if (!table.rows.length) {
        y += 50;
        if (!table.emptyHidden) paragraph(table.empty || "No inventory rows were saved in this report.");
        y += 12;
        if (table.note) paragraph(table.note);
        return;
      }
      const tableWidth = width - 24;
      const widthTotal = table.widths.reduce((sum, entry) => sum + entry, 0);
      const columnStyles = Object.fromEntries(table.widths.map((entry, index) => [index, { cellWidth: tableWidth * entry / widthTotal }]));
      autoTable(doc, {
        startY: start + 44,
        margin: { top: margin + 44, bottom: margin + 12, left: margin + 12, right: margin + 12 },
        tableWidth,
        head: [table.headers], body: table.rows.map((row) => row.map((cell) => ({
          content: cell.text,
          styles: {
            ...(cell.className.includes("number-cell") ? { halign: "right" } : {}),
            ...(cell.className.includes("profit-positive") ? { textColor: COLORS.positive, fontStyle: "bold" } : {}),
            ...(cell.className.includes("profit-negative") ? { textColor: COLORS.negative, fontStyle: "bold" } : {}),
          },
        }))),
        theme: "grid", styles: { font: FONT, fontSize: 7.1, cellPadding: 4, overflow: "linebreak", valign: "top", lineWidth: 0.25, lineColor: COLORS.border, textColor: [0, 0, 0] },
        headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: "bold" },
        alternateRowStyles: { fillColor: [244, 246, 248] },
        columnStyles, showHead: "everyPage", rowPageBreak: "avoid",
        willDrawPage(data) { if (data.pageNumber > 1) heading(margin, table.eyebrow, table.title, table.count, true); },
        didDrawCell(data) {
          doc.setFillColor(...COLORS.section);
          doc.rect(margin, data.cell.y, 12, data.cell.height, "F");
          doc.rect(pageWidth - margin - 12, data.cell.y, 12, data.cell.height, "F");
        },
        didDrawPage(data) {
          doc.setFillColor(...COLORS.section);
          doc.rect(margin, data.cursor.y, width, 10, "F");
        },
      });
      y = doc.lastAutoTable.finalY + 23;
      if (table.note) paragraph(table.note);
    }

    drawTable(model.tables[0]);
    // Preserve the report's two-column performer cards, even when many items
    // tie. An oversized card continues on a later page with its title repeated.
    for (let index = 0; index < model.performers.length; index += 2) {
      const performerWidth = (width - 32) / 2;
      const pair = model.performers.slice(index, index + 2).map((card) => ({
        ...card, offset: 0,
        lines: card.rows.flatMap((row) => [
          ...lines(row.description, performerWidth - 20, 8).map((line) => ({ text: line, size: 8, height: 10, bold: false })),
          ...lines(row.value, performerWidth - 20, 9, true).map((line) => ({ text: line, size: 9, height: 11.25, bold: true })),
          { text: "", size: 8, height: 7 },
        ]),
      }));
      do {
        ensureSpace(140);
        heading(y, "Product insights", "Top performers", "", pair.some((card) => card.offset > 0));
        y += 44;
        const available = bottom - y - 54;
        const chunks = pair.map((card) => {
          const chunk = [];
          let height = 0;
          while (card.offset < card.lines.length && height + card.lines[card.offset].height <= available) {
            const line = card.lines[card.offset++];
            chunk.push(line);
            height += line.height;
          }
          return { card, chunk, height };
        });
        const rowHeight = Math.max(...chunks.map((entry) => entry.height)) + 46;
        doc.setFillColor(...COLORS.section);
        doc.rect(margin, y, width, rowHeight + 8, "F");
        chunks.forEach(({ card, chunk }, column) => {
          if (!chunk.length) return;
          const x = margin + 12 + column * (performerWidth + 8);
          box(x, y, performerWidth, rowHeight, COLORS.light, COLORS.border);
          text(card.kicker.toLocaleUpperCase("en-US"), x + 10, y + 7, 6, true, COLORS.muted);
          text(card.title, x + 10, y + 19, 11, true);
          let lineY = y + 37;
          for (const line of chunk) {
            text(line.text, x + 10, lineY, line.size, line.bold, line.bold ? COLORS.green : COLORS.text);
            lineY += line.height;
          }
        });
        y += rowHeight + 20;
      } while (pair.some((card) => card.offset < card.lines.length));
    }
    drawTable(model.tables[1]);
    drawTable(model.tables[2]);
    drawTable(model.tables[3]);
    for (const line of model.footer) paragraph(line, 7);
    const pageCount = doc.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      doc.setPage(page);
      font(7, false, COLORS.muted);
      doc.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: "right" });
    }
    const bytes = new Uint8Array(doc.output("arraybuffer"));
    if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
      throw new Error("The PDF library did not produce a valid PDF. No file was downloaded.");
    }
    return bytes;
  }

  return Object.freeze({ createReportPresentation, generateReportPdf });
});
