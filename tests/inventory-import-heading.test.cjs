const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");

function declarationsFor(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((value) => value.trim() === selector))
    .map(([, , declarations]) => declarations).join("\n");
}

test("pre-stream inventory uses one semantic eyebrow heading beside the existing badge", () => {
  const heading = html.match(/<div class="inventory-import-heading">[\s\S]*?<\/div>/)?.[0];
  assert.ok(heading);
  assert.match(heading, /<h2\b[^>]*id="inventory-import-title"[^>]*class="eyebrow"[^>]*>Pre-stream inventory check<\/h2>/);
  assert.doesNotMatch(heading, /<p\b|Google Sheets inventory|>Pre-stream inventory<|<div>/);
  assert.equal((html.match(/id="inventory-import-title"/g) ?? []).length, 1);
  assert.equal((html.match(/id="inventory-import-badge"/g) ?? []).length, 1);
  assert.match(heading, /id="inventory-import-badge"[^>]*class="inventory-import-badge"[^>]*data-state="checking"/);
  assert.ok(heading.indexOf('id="inventory-import-title"') < heading.indexOf('id="inventory-import-badge"'));
  assert.match(html, /id="inventory-import-panel"[^>]*aria-labelledby="inventory-import-title"[^>]*aria-busy="true"/);
});

test("compact heading preserves import controls, field accessibility, progress and recovery targets", () => {
  for (const id of [
    "inventory-import-form", "inventory-sheet-reference", "inventory-sheet-error",
    "preview-inventory", "inventory-import-progress", "inventory-import-error",
    "retry-inventory-import", "edit-inventory-reference", "inventory-import-preview",
    "change-inventory-sheet", "confirm-inventory-import", "cancel-inventory-preview",
    "inventory-import-confirmation", "inventory-import-confirmation-status",
  ]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, id);
  assert.match(html, /<label for="inventory-sheet-reference" class="visually-hidden">Google Sheet ID or sharing link<\/label>/);
  assert.match(html, /id="inventory-sheet-reference"[^>]*placeholder="Paste a Google Sheet link or ID"[^>]*aria-describedby="inventory-sheet-error"/);
  assert.match(html, /id="preview-inventory"[^>]*type="submit">\s*Connect and preview/);
  assert.match(html, /id="inventory-import-progress"[^>]*role="status"[^>]*tabindex="-1"[^>]*aria-live="polite"/);
  assert.match(html, /id="inventory-import-error"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(html, /id="confirm-inventory-import"[^>]*>\s*Confirm inventory baseline/);
});

test("small uppercase heading inherits eyebrow typography and compact spacing stays local", () => {
  const heading = declarationsFor(".inventory-import-heading");
  assert.match(heading, /display:\s*grid;/);
  assert.match(heading, /grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(heading, /align-items:\s*center;/);
  const title = declarationsFor(".inventory-import-heading h2");
  assert.match(title, /min-width:\s*0;/);
  assert.match(title, /color:\s*var\(--blue-bright\);/);
  assert.match(title, /overflow-wrap:\s*anywhere;/);
  assert.match(title, /margin:\s*0;/);
  assert.doesNotMatch(title, /font-size:|font-weight:/);
  const eyebrow = declarationsFor(".eyebrow");
  assert.match(eyebrow, /font-size:\s*10px;/);
  assert.match(eyebrow, /font-weight:\s*760;/);
  assert.match(eyebrow, /color:\s*var\(--text-subtle\);/);
  assert.match(eyebrow, /text-transform:\s*uppercase;/);
  assert.match(declarationsFor(".inventory-import-panel"), /padding:\s*16px 12px 12px;/);
  assert.match(declarationsFor(".inventory-import-form"), /margin-top:\s*8px;/);
  assert.match(declarationsFor(".inventory-import-preview-heading"), /display:\s*flex;/);
  assert.match(declarationsFor(".inventory-import-preview-heading"), /align-items:\s*flex-start;/);
  const badge = declarationsFor(".inventory-import-badge");
  assert.match(badge, /font-size:\s*9px;/);
  assert.match(badge, /white-space:\s*nowrap;/);
  assert.match(badge, /min-height:\s*24px;/);
  assert.match(declarationsFor('.inventory-import-badge[data-state="ready"]'), /color:\s*#91e9d8;/);
  assert.match(declarationsFor('.inventory-import-badge[data-state="error"]'), /color:\s*#ffd88a;/);
});

function functionRange(name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Locate real ${name} rendering code`);
  return source.slice(start, end);
}

function node() {
  return {
    hidden: false, disabled: false, open: false, textContent: "", value: "",
    dataset: {}, attributes: {}, children: [], focusCount: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    toggleAttribute(name, present) {
      if (present) this.attributes[name] = "";
      else delete this.attributes[name];
    },
    replaceChildren(...children) { this.children = children; },
    append(child) { this.children.push(child); },
    focus() { this.focusCount += 1; },
  };
}

function inventorySnapshot(overrides = {}) {
  return Object.freeze({
    phase: "ready", operation: "load", busy: false, preview: null,
    hasConfirmedBaseline: false, confirmation: null, error: null, ...overrides,
  });
}

function renderFixture() {
  const previews = [];
  const context = {
    inventoryImportSnapshot: inventorySnapshot(),
    streamSnapshot: { activeSession: null, busy: false, phase: "ready" },
    confirmedInventoryPreviewContextBaselineId: null,
    confirmedInventoryPreviewRequestPending: false,
    confirmedInventoryPreviewBaselineId: null,
    previousInventoryImportPhase: "idle",
    focusInventoryImportAfterRetry: false,
    shouldPrepareInventoryForStreamRetry: () => false,
    resetConfirmedInventoryPreview() {},
    renderInventoryPreview: (preview) => previews.push(preview),
    REPREVIEW_REQUIRED_ERROR_CODES: new Set(["PREVIEW_EXPIRED"]),
    document: { createElement: () => node() },
  };
  for (const name of [
    "inventoryImportPanel", "inventoryImportForm", "inventoryImportPreview",
    "inventoryImportProgress", "inventoryImportError", "inventoryImportConfirmation",
    "inventorySheetReference", "inventorySheetError", "previewInventoryButton",
    "retryInventoryImportButton", "editInventoryReferenceButton", "changeInventorySheetButton",
    "cancelInventoryPreviewButton", "confirmInventoryImportButton", "inventoryImportBadge",
    "inventoryImportProgressTitle", "inventoryImportProgressMessage", "inventoryImportErrorTitle",
    "inventoryImportErrorMessage", "inventoryImportIssues", "inventoryImportConfirmationMessage",
    "inventoryImportConfirmationStatus", "startStreamButton", "streamSessionStatusMessage",
  ]) context[name] = node();
  const render = vm.runInNewContext(
    functionRange("isInventoryReadyForStart", "renderInventoryPreview") +
    functionRange("renderInventoryImportSnapshot", "renderStreamSnapshot") +
    "\nrenderInventoryImportSnapshot;", context,
  );
  return { context, render, previews };
}

const confirmation = Object.freeze({
  baselineId: "inventory-baseline:11111111-1111-4111-8111-111111111111",
  summary: { rowCount: 2, totalQuantityOnHandAtImport: 5 },
});

test("existing renderer keeps checking, connecting and confirming badges with busy controls and progress", () => {
  for (const [operation, label, title] of [
    ["load", "Checking", "Checking saved inventory..."],
    ["preview", "Connecting", "Connecting to Google Sheets..."],
    ["confirm", "Confirming", "Confirming inventory baseline..."],
  ]) {
    const f = renderFixture();
    f.context.inventorySheetReference.value = "example-sheet-id";
    const current = inventorySnapshot({ operation, phase: "loading", busy: true });
    const before = JSON.stringify(current);
    f.render(current);
    assert.equal(f.context.inventoryImportPanel.hidden, false);
    assert.equal(f.context.inventoryImportPanel.attributes["aria-busy"], "true");
    assert.equal(f.context.inventoryImportBadge.dataset.state, "checking");
    assert.equal(f.context.inventoryImportBadge.textContent, label);
    assert.equal(f.context.inventoryImportProgress.hidden, false);
    assert.equal(f.context.inventoryImportProgressTitle.textContent, title);
    assert.ok(f.context.inventoryImportProgressMessage.textContent.length > 0);
    assert.equal(f.context.inventoryImportError.hidden, true);
    assert.equal(f.context.inventoryImportForm.hidden, false);
    assert.ok(Object.hasOwn(f.context.inventoryImportForm.attributes, "inert"));
    for (const name of ["inventorySheetReference", "previewInventoryButton",
      "retryInventoryImportButton", "confirmInventoryImportButton", "startStreamButton"]) {
      assert.equal(f.context[name].disabled, true, name);
    }
    assert.equal(f.context.inventorySheetReference.value, "example-sheet-id");
    assert.equal(JSON.stringify(current), before);
  }
});

test("existing required and confirmed states retain input, readiness, confirmation and Start gating", () => {
  const f = renderFixture();
  f.context.inventorySheetReference.value = "example-sheet-id";
  f.render(inventorySnapshot());
  assert.equal(f.context.inventoryImportBadge.dataset.state, "required");
  assert.equal(f.context.inventoryImportBadge.textContent, "Import required");
  assert.equal(f.context.startStreamButton.disabled, true);
  assert.equal(f.context.inventoryImportConfirmation.hidden, true);
  f.context.previousInventoryImportPhase = "confirming";
  f.render(inventorySnapshot({ hasConfirmedBaseline: true, confirmation }));
  assert.equal(f.context.inventoryImportBadge.dataset.state, "ready");
  assert.equal(f.context.inventoryImportBadge.textContent, "Ready");
  assert.equal(f.context.inventoryImportPanel.attributes["aria-busy"], "false");
  assert.equal(f.context.inventoryImportConfirmation.hidden, false);
  assert.equal(f.context.inventoryImportConfirmationMessage.textContent,
    "2 rows and 5 opening units are ready for the next tracker stream.");
  assert.equal(f.context.inventoryImportConfirmationStatus.focusCount, 1);
  assert.equal(f.context.inventoryImportForm.hidden, false);
  assert.equal(f.context.inventoryImportPreview.hidden, true);
  assert.equal(f.context.inventoryImportProgress.hidden, true);
  assert.equal(f.context.inventoryImportError.hidden, true);
  assert.equal(f.context.inventorySheetReference.disabled, false);
  assert.equal(f.context.previewInventoryButton.disabled, false);
  assert.equal(f.context.startStreamButton.disabled, false);
  assert.equal(f.context.inventorySheetReference.value, "example-sheet-id");
});

test("existing preview state keeps its badge, review controls and focus instead of enabling Start", () => {
  const f = renderFixture();
  const preview = Object.freeze({ inventory: [], summary: confirmation.summary });
  f.context.previousInventoryImportPhase = "previewing";
  f.context.inventorySheetReference.value = "example-sheet-id";
  f.render(inventorySnapshot({ preview, hasConfirmedBaseline: true, confirmation }));
  assert.equal(f.context.inventoryImportBadge.dataset.state, "preview");
  assert.equal(f.context.inventoryImportBadge.textContent, "Preview ready");
  assert.equal(f.context.inventoryImportForm.hidden, true);
  assert.equal(f.context.inventoryImportPreview.hidden, false);
  assert.equal(f.context.inventoryImportConfirmation.hidden, true);
  assert.equal(f.context.inventoryImportProgress.hidden, true);
  assert.equal(f.context.confirmInventoryImportButton.disabled, false);
  assert.equal(f.context.cancelInventoryPreviewButton.disabled, false);
  assert.equal(f.context.confirmInventoryImportButton.focusCount, 1);
  assert.equal(f.context.inventorySheetReference.value, "");
  assert.equal(f.context.startStreamButton.disabled, true);
  assert.deepEqual(f.previews, [preview]);
});

test("existing errors retain attention badge, visible issues and field/retry recovery", () => {
  const f = renderFixture();
  f.context.inventorySheetReference.value = "invalid-sheet";
  const error = {
    scope: "preview", code: "INVALID_SPREADSHEET_REFERENCE", message: "Check the Sheet link.",
    issues: [{ rowNumber: 2, column: "sku", message: "SKU is required." }],
  };
  f.render(inventorySnapshot({ phase: "error", error }));
  assert.equal(f.context.inventoryImportBadge.dataset.state, "error");
  assert.equal(f.context.inventoryImportBadge.textContent, "Needs attention");
  assert.equal(f.context.inventoryImportError.hidden, false);
  assert.equal(f.context.inventoryImportErrorMessage.textContent, error.message);
  assert.equal(f.context.inventoryImportErrorTitle.textContent, "Inventory could not be previewed");
  assert.equal(f.context.inventoryImportIssues.hidden, false);
  assert.equal(f.context.inventoryImportIssues.children[0].textContent, "Row 2, sku: SKU is required.");
  assert.equal(f.context.inventorySheetReference.attributes["aria-invalid"], "true");
  assert.equal(f.context.inventorySheetError.hidden, false);
  assert.equal(f.context.inventorySheetReference.focusCount, 1);
  assert.equal(f.context.inventorySheetReference.value, "invalid-sheet");
  assert.equal(f.context.retryInventoryImportButton.textContent, "Retry");
  assert.equal(f.context.retryInventoryImportButton.disabled, false);
  assert.equal(f.context.startStreamButton.disabled, true);
  f.render(inventorySnapshot());
  assert.equal(f.context.inventoryImportError.hidden, true);
  assert.equal(f.context.inventorySheetError.hidden, true);
  assert.equal(f.context.inventoryImportIssues.hidden, true);
  assert.equal(f.context.inventorySheetReference.attributes["aria-invalid"], undefined);
  f.render(inventorySnapshot({ phase: "error", error: { scope: "confirm", code: "PREVIEW_EXPIRED" } }));
  assert.equal(f.context.inventoryImportErrorTitle.textContent, "Inventory could not be confirmed");
  assert.equal(f.context.retryInventoryImportButton.textContent, "Preview again");
  assert.equal(f.context.inventoryImportError.focusCount, 1);
});
