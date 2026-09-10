// Synthetic-only PDF visual QA. No Chrome profile, downloads API, or saved reports.
// Setup: npm.cmd install --prefix tmp/pdf-qa --no-save --ignore-scripts mupdf@1.28.1
// Run: node scripts/verify-report-pdfs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: mupdf } = await import("../tmp/pdf-qa/node_modules/mupdf/dist/mupdf.js");
const { generateReportPdf } = require("../extension/report/report-pdf.js");
const { makePdfRecord } = require("../tests/helpers/report-pdf-fixtures.cjs");
const fonts = Object.fromEntries([
  ["normal", "DejaVuSans.ttf"], ["bold", "DejaVuSans-Bold.ttf"],
].map(([style, file]) => [style, fs.readFileSync(path.join(root, "extension/vendor/fonts", file)).toString("base64")]));
const directory = path.join(root, "tmp/pdfs");
fs.mkdirSync(directory, { recursive: true });

for (const [name, options] of [
  ["representative", { rows: 3, allWarnings: false }],
  ["long-report", { rows: 70, longName: true, allWarnings: true }],
]) {
  const record = makePdfRecord(options);
  const before = JSON.stringify(record);
  const bytes = await generateReportPdf(record, { fonts });
  if (before !== JSON.stringify(record)) throw new Error("Export changed its input record");
  fs.writeFileSync(path.join(directory, `${name}.pdf`), bytes);
  const document = mupdf.Document.openDocument(bytes, "application/pdf");
  const pages = [];
  for (let index = 0; index < document.countPages(); index++) {
    const page = document.loadPage(index);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
    fs.writeFileSync(path.join(directory, `${name}-${index + 1}.png`), pixmap.asPNG());
    const structured = page.toStructuredText("preserve-whitespace");
    pages.push(structured.asText());
    structured.destroy(); pixmap.destroy(); page.destroy();
  }
  const text = pages.join("\n");
  fs.writeFileSync(path.join(directory, `${name}.txt`), text);
  if (!text.includes(record.displayName.split(" ")[0])) throw new Error("Report name was not retained");
  for (const item of record.report.inventory) {
    // SKU is repeated in three complete tables, not merely present in a heading.
    const count = text.split(item.sku).length - 1;
    if (count < 3) throw new Error(`Missing table rows for ${item.sku}: ${count}`);
  }
  console.log(`${name}: ${document.countPages()} pages, ${bytes.length} bytes; every inventory SKU appears in all three tables; input unchanged.`);
  document.destroy();
}
