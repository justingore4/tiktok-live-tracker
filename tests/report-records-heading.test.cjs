const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { MAX_ACTIVE_REPORTS } = require("../extension/shared/stream-report-storage.js");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const panel = html.match(/<section\s+id="stream-reports-panel"[\s\S]*?<\/section>/)?.[0];

function declarationsFor(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((value) => value.trim() === selector))
    .map(([, , declarations]) => declarations).join("\n");
}

test("report records replace the two-line heading and description with one semantic label", () => {
  assert.ok(panel);
  const heading = panel.match(/<div class="stream-reports-heading">[\s\S]*?<\/div>/)?.[0];
  assert.ok(heading);
  assert.match(heading, /<h2 id="stream-reports-title" class="eyebrow">STREAM REPORT RECORDS<\/h2>/);
  assert.doesNotMatch(heading, /<p\b|Business records|>Stream reports<|<div>/);
  assert.equal((html.match(/id="stream-reports-title"/g) ?? []).length, 1);
  assert.match(panel, /aria-labelledby="stream-reports-title"[^>]*aria-busy="true"[^>]*hidden/);
  assert.match(heading, /<span id="stream-reports-count" class="stream-reports-count">0 saved<\/span>/);
  assert.ok(heading.indexOf('id="stream-reports-title"') < heading.indexOf('id="stream-reports-count"'));
  assert.doesNotMatch(panel, /stream-reports-description|print or save it as a PDF|Google Sheets-ready CSV|Limit of 5 reports/);
  assert.doesNotMatch(css, /\.stream-reports-description\b/);
});

test("report records retain list, retry, archive navigation, capacity and download accessibility targets", () => {
  for (const id of [
    "stream-reports-count", "stream-reports-list", "stream-reports-error",
    "stream-reports-error-message", "retry-stream-reports", "view-archived-reports",
    "stream-reports-capacity-warning", "stream-reports-capacity-help",
    "archived-reports-short-count", "stream-report-download-status",
  ]) assert.equal((panel.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, id);
  assert.match(panel, /id="stream-reports-list"[^>]*role="list"/);
  assert.match(panel, /id="stream-reports-error"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(panel, /id="retry-stream-reports"[^>]*type="button">\s*Retry reports/);
  assert.match(panel, /id="view-archived-reports"[^>]*type="button"\s*>\s*View archived reports/);
  assert.match(panel, /id="stream-reports-capacity-warning"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(panel, /id="stream-report-download-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("compact report heading uses eyebrow typography without changing count or archived list styles", () => {
  const heading = declarationsFor(".stream-reports-heading");
  assert.match(heading, /display:\s*grid;/);
  assert.match(heading, /grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(heading, /align-items:\s*center;/);
  const title = declarationsFor(".stream-reports-heading h2");
  assert.match(title, /min-width:\s*0;/);
  assert.match(title, /color:\s*var\(--blue-bright\);/);
  assert.match(title, /overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(title, /font-size:|font-weight:|letter-spacing:/);
  const eyebrow = declarationsFor(".eyebrow");
  assert.match(eyebrow, /font-size:\s*10px;/);
  assert.match(eyebrow, /font-weight:\s*760;/);
  assert.match(eyebrow, /color:\s*var\(--text-subtle\);/);
  assert.match(eyebrow, /text-transform:\s*uppercase;/);
  assert.match(declarationsFor(".stream-reports-panel"), /padding:\s*16px 12px 12px;/);
  assert.match(declarationsFor("#stream-reports-list"), /margin-top:\s*8px;/);
  assert.match(declarationsFor(".stream-reports-list"), /margin-top:\s*11px;/);
  assert.equal(declarationsFor("#archived-reports-list"), "");
  const count = declarationsFor(".stream-reports-count");
  assert.match(count, /font-size:\s*9px;/);
  assert.match(count, /font-weight:\s*760;/);
  assert.match(count, /color:\s*#adf4e7;/);
  assert.match(count, /white-space:\s*nowrap;/);
});

function node() {
  return {
    hidden: false, disabled: false, textContent: "", attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...children) { this.children = children; },
  };
}

function renderFixture() {
  const calls = [];
  const context = {
    streamSnapshot: Object.freeze({ activeSession: null }),
    streamReportSummaries: [], archivedReportSummaries: [],
    streamReportsLoadError: null, streamReportsLoading: false, reportMutationBusy: false,
    MAX_DASHBOARD_REPORTS: MAX_ACTIVE_REPORTS,
    closeReportActionsMenu: () => calls.push("close menu"),
    renderReportCapacityWarning: () => calls.push("capacity"),
    renderArchivedReportsView: () => calls.push("archives"),
    updateFooterVisibility: () => calls.push("footer"),
    createStreamReportLink: (summary, options) => ({ summary, archived: options.archived }),
  };
  for (const name of [
    "streamReportsPanel", "streamReportsCount", "archivedReportsShortCount",
    "viewArchivedReportsButton", "streamReportsList", "streamReportsError", "streamReportsErrorMessage",
  ]) context[name] = node();
  const start = source.indexOf("  function renderStreamReportsPanel() {");
  const end = source.indexOf("  function openArchivedReportsDashboard() {", start);
  assert.ok(start >= 0 && end > start);
  const render = vm.runInNewContext(source.slice(start, end) + "\nrenderStreamReportsPanel;", context);
  return { context, calls, render };
}

function summaries(count) {
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    Object.freeze({ reportId: `report-${index}` })));
}

test("real renderer preserves dynamic X/5 counts and existing report links with the compact heading", () => {
  const f = renderFixture();
  const badge = f.context.streamReportsCount;
  f.context.archivedReportSummaries = summaries(2);
  for (const count of [0, 1, 5, 2]) {
    f.context.streamReportSummaries = summaries(count);
    const before = JSON.stringify(f.context.streamReportSummaries);
    f.render();
    assert.equal(f.context.streamReportsCount, badge);
    assert.equal(badge.textContent, `${count}/5 saved`);
    assert.equal(f.context.archivedReportsShortCount.textContent, "2 archived");
    assert.equal(f.context.streamReportsPanel.hidden, false);
    assert.equal(f.context.streamReportsPanel.attributes["aria-busy"], "false");
    assert.equal(f.context.streamReportsList.children.length, count);
    f.context.streamReportsList.children.forEach((link, index) => {
      assert.equal(link.summary, f.context.streamReportSummaries[index]);
      assert.equal(link.archived, false);
    });
    assert.equal(JSON.stringify(f.context.streamReportSummaries), before);
    assert.deepEqual(f.calls.slice(-4), ["close menu", "capacity", "archives", "footer"]);
  }
});

test("real renderer keeps loading, errors, empty-library and active-stream visibility behavior", () => {
  const f = renderFixture();
  f.render();
  assert.equal(f.context.streamReportsPanel.hidden, true);
  f.context.streamReportSummaries = summaries(2);
  for (const busyProperty of ["streamReportsLoading", "reportMutationBusy"]) {
    f.context[busyProperty] = true;
    f.render();
    assert.equal(f.context.streamReportsPanel.hidden, false);
    assert.equal(f.context.streamReportsPanel.attributes["aria-busy"], "true");
    assert.equal(f.context.streamReportsCount.textContent, "2/5 saved");
    assert.equal(f.context.viewArchivedReportsButton.disabled, true);
    f.context[busyProperty] = false;
  }
  f.context.streamReportSummaries = summaries(0);
  f.context.streamReportsLoadError = "Saved reports could not be read.";
  f.render();
  assert.equal(f.context.streamReportsPanel.hidden, false);
  assert.equal(f.context.streamReportsError.hidden, false);
  assert.equal(f.context.streamReportsErrorMessage.textContent, f.context.streamReportsLoadError);
  assert.equal(f.context.viewArchivedReportsButton.disabled, false);
  f.context.streamReportsLoadError = null;
  f.context.archivedReportSummaries = summaries(1);
  f.render();
  assert.equal(f.context.streamReportsPanel.hidden, false, "Archived-only libraries stay reachable");
  assert.equal(f.context.streamReportsError.hidden, true);
  assert.equal(f.context.streamReportsErrorMessage.textContent,
    "Saved reports could not be loaded. Nothing was changed.");
  f.context.streamSnapshot = Object.freeze({ activeSession: Object.freeze({ streamId: "active-stream" }) });
  f.render();
  assert.equal(f.context.streamReportsPanel.hidden, true);
});
