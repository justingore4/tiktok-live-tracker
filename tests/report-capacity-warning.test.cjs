const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(directory, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(directory, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(directory, "sidepanel.css"), "utf8");
const fullMessage = "Report library full — delete an archived report";

function functionSource(name) {
  const declaration = new RegExp(`^  (?:async )?function ${name}\\(`, "m");
  const start = source.search(declaration);
  assert.notEqual(start, -1, `${name} exists`);
  const end = source.indexOf("\n  }", start);
  assert.ok(end > start, `${name} has a closing brace`);
  return source.slice(start, end + "\n  }".length);
}

function summaries(count, tier) {
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    Object.freeze({ reportId: `${tier}-${index}` }),
  ));
}

function createHarness(overrides = {}) {
  // No storage, browser API, or report client is available to the helper.
  const sandbox = {
    MAX_TOTAL_REPORTS: 30,
    streamSnapshot: Object.freeze({ activeSession: null }),
    streamReportsLoading: false,
    reportMutationBusy: false,
    streamReportsLoadError: null,
    archivedReportsLoadError: null,
    streamReportSummaries: summaries(5, "current"),
    archivedReportSummaries: summaries(22, "archived"),
    streamReportsCapacityWarning: { hidden: true, textContent: "" },
    ...overrides,
  };
  vm.createContext(sandbox);
  vm.runInContext(`"use strict";\n${functionSource("renderReportCapacityWarning")}`, sandbox);
  return {
    sandbox,
    setCounts(current, archived) {
      sandbox.streamReportSummaries = summaries(current, "current");
      sandbox.archivedReportSummaries = summaries(archived, "archived");
    },
    render() {
      sandbox.renderReportCapacityWarning();
      return { ...sandbox.streamReportsCapacityWarning };
    },
  };
}

test("capacity warning covers empty, near-full, full, and over-capacity libraries", () => {
  const harness = createHarness();
  for (const [total, message] of [
    [0, ""],
    [26, ""],
    [27, "3 report slots left"],
    [28, "2 report slots left"],
    [29, "1 report slot left"],
    [30, fullMessage],
    [31, fullMessage],
    [45, fullMessage],
  ]) {
    const current = Math.min(5, total);
    harness.setCounts(current, total - current);
    assert.deepEqual(harness.render(), {
      hidden: message === "",
      textContent: message,
    }, `${total} saved reports`);
  }
});

test("current and archived reports share one capacity regardless of their split", () => {
  const harness = createHarness();
  for (const [current, archived] of [[0, 27], [1, 26], [2, 25], [5, 22]]) {
    harness.setCounts(current, archived);
    assert.deepEqual(harness.render(), {
      hidden: false,
      textContent: "3 report slots left",
    });
  }
});

test("fresh deletion counts update the warning and hide it below 27 reports", () => {
  const harness = createHarness();
  for (const [archived, message] of [
    [25, fullMessage],
    [24, "1 report slot left"],
    [23, "2 report slots left"],
    [22, "3 report slots left"],
    [21, ""],
  ]) {
    harness.setCounts(5, archived);
    assert.deepEqual(harness.render(), {
      hidden: message === "",
      textContent: message,
    });
  }
});

test("archive and restore tier movements do not change total capacity", () => {
  const harness = createHarness();
  for (const [current, archived] of [[5, 24], [4, 25], [5, 24]]) {
    harness.setCounts(current, archived);
    assert.deepEqual(harness.render(), {
      hidden: false,
      textContent: "1 report slot left",
    });
  }
});

test("loading, mutations, either list error, and active sessions clear stale warnings", () => {
  for (const patch of [
    { streamReportsLoading: true },
    { reportMutationBusy: true },
    { streamReportsLoadError: "Current reports failed" },
    { archivedReportsLoadError: "Archived reports failed" },
    { streamReportsLoadError: "" },
    { archivedReportsLoadError: "" },
    { streamSnapshot: { activeSession: { streamId: "active-stream" } } },
  ]) {
    const harness = createHarness();
    assert.equal(harness.render().hidden, false);
    const previous = Object.fromEntries(
      Object.keys(patch).map((key) => [key, harness.sandbox[key]]),
    );
    Object.assign(harness.sandbox, patch);
    assert.deepEqual(harness.render(), { hidden: true, textContent: "" });
    Object.assign(harness.sandbox, previous);
    assert.deepEqual(harness.render(), {
      hidden: false,
      textContent: "3 report slots left",
    });
  }
});

test("capacity uses the shared protocol limit with a 30-report fallback", () => {
  const declaration = source.match(/const MAX_TOTAL_REPORTS\s*=\s*streamReportProtocol\?\.MAX_TOTAL_REPORTS\s*\?\?\s*30\s*;/)?.[0];
  assert.ok(declaration);
  for (const [streamReportProtocol, expected] of [
    [undefined, 30],
    [{}, 30],
    [{ MAX_TOTAL_REPORTS: 40 }, 40],
  ]) {
    assert.equal(vm.runInNewContext(`${declaration}\nMAX_TOTAL_REPORTS`, {
      streamReportProtocol,
    }), expected);
  }
  const harness = createHarness({ MAX_TOTAL_REPORTS: 40 });
  harness.setCounts(5, 32);
  assert.equal(harness.render().textContent, "3 report slots left");
  harness.setCounts(5, 35);
  assert.equal(harness.render().textContent, fullMessage);
});

test("helper only changes warning visibility and text, leaving report data untouched", () => {
  const harness = createHarness();
  const { sandbox } = harness;
  const before = { ...sandbox };
  for (let index = 0; index < 3; index += 1) harness.render();
  for (const key of Object.keys(before)) {
    if (key !== "streamReportsCapacityWarning") {
      assert.equal(sandbox[key], before[key], `${key} is not replaced`);
    }
  }
  assert.deepEqual(Object.keys(sandbox).sort(), Object.keys(before).sort());
  assert.doesNotMatch(functionSource("renderReportCapacityWarning"),
    /chrome\.|\bstorage\b|streamReportClient|\bfetch\s*\(|\bdelete\s+[\w.]+\s*\[/);
});

test("existing panel rendering updates capacity without replacing the archived count", () => {
  const harness = createHarness();
  const { sandbox } = harness;
  Object.assign(sandbox, {
    MAX_DASHBOARD_REPORTS: 5,
    closeReportActionsMenu() {},
    streamReportsPanel: { setAttribute() {} },
    streamReportsCount: {},
    archivedReportsShortCount: {},
    viewArchivedReportsButton: {},
    streamReportsList: { replaceChildren() {} },
    createStreamReportLink() { return {}; },
    streamReportsError: {},
    streamReportsErrorMessage: {},
    renderArchivedReportsView() {},
    updateFooterVisibility() {},
  });
  vm.runInContext(functionSource("renderStreamReportsPanel"), sandbox);
  sandbox.renderStreamReportsPanel();
  assert.equal(sandbox.streamReportsCapacityWarning.textContent, "3 report slots left");
  assert.equal(sandbox.archivedReportsShortCount.textContent, "22 archived");
  sandbox.reportMutationBusy = true;
  sandbox.renderStreamReportsPanel();
  assert.deepEqual(sandbox.streamReportsCapacityWarning, { hidden: true, textContent: "" });
  assert.match(source, /const streamReportsCapacityWarning\s*=\s*document\.querySelector\(\s*"#stream-reports-capacity-warning"/);
});

test("both-list refresh and mutation completion reach the capacity renderer", () => {
  const refresh = functionSource("refreshStreamReports");
  assert.match(refresh, /streamReportsLoading = true;[\s\S]*?renderStreamReportsPanel\(\)/);
  assert.match(refresh, /streamReportClient\.listReports\(\)/);
  assert.match(refresh, /streamReportClient\.listArchivedReports\(\)/);
  assert.match(refresh, /streamReportSummaries = dashboardResponse\.reports;\s*archivedReportSummaries = archivedResponse\.reports;\s*streamReportsLoading = false;\s*renderStreamReportsPanel\(\)/);
  assert.match(refresh, /streamReportsLoadError = message;\s*archivedReportsLoadError = message;\s*renderStreamReportsPanel\(\)/);
  const mutation = functionSource("runReportMutation");
  assert.match(mutation, /reportMutationBusy = true;[\s\S]*?renderStreamReportsPanel\(\)/);
  assert.match(mutation, /await refreshStreamReports\(\)/);
  assert.match(mutation, /finally\s*\{\s*reportMutationBusy = false;\s*renderStreamReportsPanel\(\)/);
});

test("warning is an initially hidden polite status directly after the archive button", () => {
  const navigation = html.match(/<div class="stream-reports-navigation">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(navigation);
  const actions = navigation.match(/<div class="stream-reports-archive-actions">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(actions);
  assert.match(actions, /<button\b[^>]*id="view-archived-reports"[^>]*>\s*View archived reports\s*<\/button>\s*<span\b[^>]*id="stream-reports-capacity-warning"/);
  const warning = actions.match(/<span\b([^>]*id="stream-reports-capacity-warning"[^>]*)>\s*<\/span>/)?.[1];
  assert.ok(warning);
  for (const attribute of ['role="status"', 'aria-live="polite"', 'aria-atomic="true"']) {
    assert.ok(warning.includes(attribute));
  }
  assert.match(warning, /\bhidden(?:\s|$)/);
  assert.match(navigation, /<\/div>\s*<span id="archived-reports-short-count"[^>]*>\s*0 archived/);
});

test("compact red warning wraps within its navigation and respects hidden", () => {
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} has a style rule`);
    return css.slice(start, css.indexOf("}", start) + 1);
  };
  assert.match(rule(".stream-reports-navigation"), /flex-wrap:\s*wrap;/);
  const actions = rule(".stream-reports-archive-actions");
  assert.match(actions, /display:\s*flex;/);
  assert.match(actions, /flex-wrap:\s*wrap;/);
  assert.match(actions, /min-width:\s*0;/);
  const warning = rule(".stream-reports-capacity-warning");
  assert.match(warning, /max-width:\s*100%;/);
  assert.match(warning, /overflow-wrap:\s*anywhere;/);
  assert.match(warning, /border-radius:\s*999px;/);
  assert.match(warning, /font-size:\s*10px;/);
  const background = warning.match(/background:\s*rgb\((\d+)\s+(\d+)\s+(\d+)/);
  assert.ok(background, "warning has a red-tinted background");
  assert.ok(Number(background[1]) > Number(background[2]) * 1.5);
  assert.ok(Number(background[1]) > Number(background[3]) * 1.5);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/);
});
