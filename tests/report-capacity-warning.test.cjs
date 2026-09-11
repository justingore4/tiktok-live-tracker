const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(directory, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(directory, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(directory, "sidepanel.css"), "utf8");
const fullMessage = "Report library full \u2014 delete an archived report";
const gettingFull = (percent) => `Report storage getting full \u2014 ${percent}% used`;
const nearlyFull = (percent) => `Report storage nearly full \u2014 ${percent}% used`;
const combined = (slots, percent) => `${slots} report ${slots === 1 ? "slot" : "slots"} left \u00b7 Storage ${percent}% full`;
const tooltip = "Download reports you want to keep, then delete unwanted archived reports to free space. Archiving alone does not free space.";

function functionSource(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
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

function capacity(overrides = {}) {
  return Object.freeze({ usedBytes: 10_000, maxBytes: 100_000, totalReports: 27, maxReports: 30, ...overrides });
}

function createHarness(overrides = {}) {
  // No storage, browser API, report payloads, or client are available to the
  // renderer: the warning must be derived only from cached capacity metadata.
  const sandbox = {
    streamSnapshot: Object.freeze({ activeSession: null }),
    streamReportsLoading: false,
    reportMutationBusy: false,
    reportRenameBusy: false,
    reportDownloadBusy: false,
    reportLibraryDisposed: false,
    streamReportsRefreshGeneration: 0,
    streamReportsOpenLatestPending: false,
    streamReportsLoadError: null,
    archivedReportsLoadError: null,
    streamReportSummaries: summaries(5, "current"),
    archivedReportSummaries: summaries(22, "archived"),
    reportLibraryCapacity: capacity(),
    streamReportsCapacityWarning: { hidden: true, textContent: "", dataset: {} },
    ...overrides,
  };
  vm.createContext(sandbox);
  vm.runInContext(`"use strict";\n${functionSource("renderReportCapacityWarning")}`, sandbox);
  return {
    sandbox,
    setCapacity(overrides) { sandbox.reportLibraryCapacity = capacity(overrides); },
    render() {
      sandbox.renderReportCapacityWarning();
      const { hidden, textContent, dataset } = sandbox.streamReportsCapacityWarning;
      return { hidden, textContent, tone: dataset.tone };
    },
  };
}

function assertWarning(harness, textContent, tone = "danger") {
  assert.deepEqual(harness.render(), { hidden: textContent === "", textContent, tone });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function createRefreshHarness(overrides = {}) {
  const harness = createHarness(overrides);
  const { sandbox } = harness;
  const calls = { dashboard: [], archived: [], capacity: [] };
  const rendered = [];
  const opened = [];
  const focused = [];
  const request = (name) => {
    const pending = deferred();
    calls[name].push(pending);
    return pending.promise;
  };
  Object.assign(sandbox, {
    archivedReportsViewOpen: false,
    streamReportClient: {
      listReports: () => request("dashboard"),
      listArchivedReports: () => request("archived"),
      getLibraryCapacity: () => request("capacity"),
    },
    renderStreamReportsPanel() { rendered.push(harness.render()); },
    async openStreamReport(reportId) { opened.push(reportId); },
    streamReportsError: { focus() { focused.push("dashboard"); } },
    archivedReportsError: { focus() { focused.push("archived"); } },
  });
  vm.runInContext(functionSource("refreshStreamReports"), sandbox);
  return {
    ...harness, calls, rendered, opened, focused,
    refresh(options) { return sandbox.refreshStreamReports(options); },
    resolve(index, metadata = capacity(), current = summaries(5, "fresh"), archived = summaries(22, "archived")) {
      calls.dashboard[index].resolve({ reports: current });
      calls.archived[index].resolve({ reports: archived });
      calls.capacity[index].resolve(metadata);
    },
  };
}

function createEndWithoutReportHarness() {
  const harness = createRefreshHarness({ streamSnapshot: { busy: false, activeSession: { streamId: "active" } } });
  const { sandbox } = harness;
  const ending = deferred();
  const events = [];
  const announcements = { textContent: "" };
  Object.assign(sandbox, {
    endConfirmationOpen: true,
    mappingAnnouncement: announcements,
    streamSessionEndConfirmation: { hidden: false },
    streamSessionError: { hidden: false },
    streamSessionStatus: { hidden: true, focus() { events.push("status-focus"); } },
    streamSessionStatusTitle: {},
    streamSessionStatusMessage: {},
    startStreamButton: { focus() { events.push("start-focus"); } },
    streamSessionController: {
      endActiveStreamWithoutReport() { events.push("end-request"); return ending.promise; },
      getSnapshot() { return sandbox.streamSnapshot; },
    },
    renderStreamSnapshot(snapshot) { events.push("snapshot-render"); sandbox.streamSnapshot = snapshot; },
    console: { error() { events.push("error-log"); } },
  });
  vm.runInContext(functionSource("endActiveStreamWithoutReport"), sandbox);
  return { ...harness, ending, events, announcements };
}

test("exact byte thresholds use the unrounded ratio and floor displayed percentages", () => {
  const harness = createHarness();
  for (const [usedBytes, message, tone] of [
    [0, ""], [79_000, ""], [79_999, ""],
    [80_000, gettingFull(80), "warning"],
    [80_999, gettingFull(80), "warning"],
    [89_999, gettingFull(89), "warning"],
    [90_000, nearlyFull(90), "danger"],
    [90_999, nearlyFull(90), "danger"],
    [99_999, nearlyFull(99), "danger"],
    [100_000, fullMessage, "danger"],
    [101_000, fullMessage, "danger"],
  ]) {
    harness.setCapacity({ totalReports: 10, usedBytes });
    assertWarning(harness, message, tone);
  }
});

test("count-only warnings preserve three, two, one, full, and over-capacity labels", () => {
  const harness = createHarness();
  for (const [totalReports, message] of [
    [0, ""], [26, ""], [27, "3 report slots left"],
    [28, "2 report slots left"], [29, "1 report slot left"],
    [30, fullMessage], [31, fullMessage], [45, fullMessage],
  ]) {
    harness.setCapacity({ totalReports });
    assertWarning(harness, message);
  }
});

test("simultaneous slot and size pressure produces one red combined warning", () => {
  const harness = createHarness();
  for (const [totalReports, usedBytes, message] of [
    [27, 79_999, "3 report slots left"],
    [27, 80_000, combined(3, 80)],
    [28, 80_000, combined(2, 80)],
    [29, 89_999, combined(1, 89)],
    [28, 92_999, combined(2, 92)],
    [29, 99_999, combined(1, 99)],
    [30, 80_000, fullMessage],
    [28, 100_000, fullMessage],
  ]) {
    harness.setCapacity({ totalReports, usedBytes });
    assertWarning(harness, message);
  }
});

test("metadata totals include pending reports even when neither summary list includes them", () => {
  const harness = createHarness({ streamReportSummaries: summaries(0, "current"), archivedReportSummaries: summaries(0, "archived") });
  assertWarning(harness, "3 report slots left");
  harness.setCapacity({ totalReports: 30 });
  assertWarning(harness, fullMessage);
  harness.setCapacity({ totalReports: 0, usedBytes: 90_000 });
  assertWarning(harness, nearlyFull(90));
  harness.setCapacity({ totalReports: 1, usedBytes: 0 });
  harness.sandbox.streamReportSummaries = summaries(30, "stale");
  assertWarning(harness, "");
});

test("unknown capacity is never treated as zero or inferred from cached summaries", () => {
  const harness = createHarness({ reportLibraryCapacity: null, archivedReportSummaries: summaries(25, "archived") });
  assertWarning(harness, "");
  harness.setCapacity({ totalReports: 30 });
  assertWarning(harness, fullMessage);
  harness.sandbox.reportLibraryCapacity = null;
  assertWarning(harness, "");
});

test("metadata supplies the configured byte and count limits", () => {
  const harness = createHarness();
  harness.setCapacity({ maxReports: 40, totalReports: 37, maxBytes: 200_000, usedBytes: 159_999 });
  assertWarning(harness, "3 report slots left");
  harness.setCapacity({ maxReports: 40, totalReports: 37, maxBytes: 200_000, usedBytes: 160_000 });
  assertWarning(harness, combined(3, 80));
  harness.setCapacity({ maxReports: 40, totalReports: 40, maxBytes: 200_000, usedBytes: 10 });
  assertWarning(harness, fullMessage);
});

test("loading, mutations, either list error, and active sessions clear stale warnings", () => {
  for (const patch of [
    { streamReportsLoading: true }, { reportMutationBusy: true },
    { streamReportsLoadError: "Current reports failed" },
    { archivedReportsLoadError: "Archived reports failed" },
    { streamReportsLoadError: "" }, { archivedReportsLoadError: "" },
    { streamSnapshot: { activeSession: { streamId: "active-stream" } } },
  ]) {
    const harness = createHarness();
    assertWarning(harness, "3 report slots left");
    const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, harness.sandbox[key]]));
    Object.assign(harness.sandbox, patch);
    assertWarning(harness, "");
    Object.assign(harness.sandbox, previous);
    assertWarning(harness, "3 report slots left");
  }
});

test("ordinary rerendering only changes warning presentation and performs no client or storage work", () => {
  const harness = createHarness();
  const { sandbox } = harness;
  const before = { ...sandbox };
  for (let index = 0; index < 20; index += 1) harness.render();
  for (const key of Object.keys(before)) {
    if (key !== "streamReportsCapacityWarning") assert.equal(sandbox[key], before[key], `${key} is unchanged`);
  }
  assert.deepEqual(Object.keys(sandbox).sort(), Object.keys(before).sort());
  assert.doesNotMatch(functionSource("renderReportCapacityWarning"),
    /chrome\.|streamReportClient|\bfetch\s*\(|JSON\.stringify|new\s+(?:Blob|TextEncoder)|\.getBytesInUse\(/);
});

test("existing panel rendering updates capacity without replacing the archived count", () => {
  const harness = createHarness({ reportLibraryCapacity: capacity({ totalReports: 29, usedBytes: 92_000 }) });
  const { sandbox } = harness;
  Object.assign(sandbox, {
    MAX_DASHBOARD_REPORTS: 5,
    closeReportActionsMenu() {}, streamReportsPanel: { setAttribute() {} },
    streamReportsCount: {}, archivedReportsShortCount: {}, viewArchivedReportsButton: {},
    streamReportsList: { replaceChildren() {} }, createStreamReportLink() { return {}; },
    streamReportsError: {}, streamReportsErrorMessage: {},
    renderArchivedReportsView() {}, updateFooterVisibility() {},
  });
  vm.runInContext(functionSource("renderStreamReportsPanel"), sandbox);
  sandbox.renderStreamReportsPanel();
  assert.equal(sandbox.streamReportsCapacityWarning.textContent, combined(1, 92));
  assert.equal(sandbox.archivedReportsShortCount.textContent, "22 archived");
  sandbox.reportMutationBusy = true;
  sandbox.renderStreamReportsPanel();
  assert.equal(sandbox.streamReportsCapacityWarning.hidden, true);
  assert.equal(sandbox.streamReportsCapacityWarning.textContent, "");
  assert.match(source, /const streamReportsCapacityWarning\s*=\s*document\.querySelector\(\s*"#stream-reports-capacity-warning"/);
});

test("refresh loads both lists and capacity together, clearing old metadata while pending", async () => {
  const harness = createRefreshHarness();
  const refreshing = harness.refresh();
  assert.equal(harness.sandbox.streamReportsLoading, true);
  assert.equal(harness.sandbox.reportLibraryCapacity, null);
  assert.equal(harness.rendered.at(-1).hidden, true);
  for (const calls of Object.values(harness.calls)) assert.equal(calls.length, 1);
  const metadata = capacity({ totalReports: 28, usedBytes: 92_000 });
  const current = summaries(2, "new-current");
  const archived = summaries(3, "new-archived");
  harness.resolve(0, metadata, current, archived);
  assert.equal(await refreshing, current[0]);
  assert.equal(harness.sandbox.reportLibraryCapacity, metadata);
  assert.equal(harness.sandbox.streamReportSummaries, current);
  assert.equal(harness.sandbox.archivedReportSummaries, archived);
  assert.equal(harness.sandbox.streamReportsLoading, false);
  assertWarning(harness, combined(2, 92));
});

test("refresh updates the warning as report count and byte usage fall and rise", async () => {
  const harness = createRefreshHarness();
  const changes = [
    [30, 100_000, fullMessage], [29, 92_000, combined(1, 92)],
    [28, 85_000, combined(2, 85)], [27, 79_000, "3 report slots left"],
    [26, 79_000, ""], [26, 90_000, nearlyFull(90)],
  ];
  for (const [index, [totalReports, usedBytes, message]] of changes.entries()) {
    const refreshing = harness.refresh();
    harness.resolve(index, capacity({ totalReports, usedBytes }));
    await refreshing;
    assertWarning(harness, message);
  }
});

test("a capacity read failure leaves metadata unknown and retry restores the warning", async () => {
  const harness = createRefreshHarness();
  const refreshing = harness.refresh({ focusError: true });
  harness.calls.dashboard[0].resolve({ reports: summaries(5, "current") });
  harness.calls.archived[0].resolve({ reports: summaries(25, "archived") });
  harness.calls.capacity[0].reject(new Error("Capacity unavailable"));
  assert.equal(await refreshing, null);
  assert.equal(harness.sandbox.reportLibraryCapacity, null);
  assert.equal(harness.sandbox.streamReportsLoadError, "Capacity unavailable");
  assert.equal(harness.sandbox.archivedReportsLoadError, "Capacity unavailable");
  assert.equal(harness.sandbox.streamReportsLoading, false);
  assert.deepEqual(harness.focused, ["dashboard"]);
  assertWarning(harness, "");
  const retrying = harness.refresh();
  harness.resolve(1, capacity({ totalReports: 2, usedBytes: 80_000 }));
  await retrying;
  assertWarning(harness, gettingFull(80), "warning");
});

test("a superseding refresh inherits auto-open intent but cannot open stale report data", async () => {
  const harness = createRefreshHarness();
  const older = harness.refresh({ openLatest: true });
  const newer = harness.refresh();
  const freshCapacity = capacity({ totalReports: 10, usedBytes: 82_000 });
  const freshReports = summaries(2, "newer");
  harness.resolve(1, freshCapacity, freshReports);
  await newer;
  const renderCount = harness.rendered.length;
  harness.resolve(0, capacity({ totalReports: 30, usedBytes: 100_000 }), summaries(2, "older"));
  assert.equal(await older, null);
  assert.equal(harness.sandbox.reportLibraryCapacity, freshCapacity);
  assert.equal(harness.sandbox.streamReportSummaries, freshReports);
  assert.equal(harness.rendered.length, renderCount);
  assert.deepEqual(harness.opened, ["newer-0"]);
  assert.equal(harness.sandbox.streamReportsOpenLatestPending, false);
  assertWarning(harness, gettingFull(82), "warning");
});

test("a trusted notification superseding End's refresh preserves auto-open intent exactly once", async () => {
  const harness = createRefreshHarness();
  const { sandbox } = harness;
  const notification = Object.freeze({ syntheticLibraryChanged: true });
  Object.assign(sandbox, {
    chrome: { runtime: { id: "test-extension" } },
    streamReportProtocol: { isReportLibraryChangedNotification: (message) => message === notification },
  });
  vm.runInContext(functionSource("handleReportLibraryChanged"), sandbox);
  const endingRefresh = harness.refresh({ openLatest: true });
  sandbox.handleReportLibraryChanged(notification, { id: "test-extension" });
  assert.equal(harness.calls.capacity.length, 2);
  harness.resolve(0, capacity(), summaries(1, "superseded"));
  assert.equal(await endingRefresh, null);
  assert.equal(sandbox.streamReportsLoading, true);
  assert.equal(sandbox.streamReportsOpenLatestPending, true);
  assert.deepEqual(harness.opened, []);
  harness.resolve(1, capacity(), summaries(1, "notification-latest"));
  await new Promise(setImmediate);
  assert.deepEqual(harness.opened, ["notification-latest-0"]);
  assert.equal(sandbox.streamReportsOpenLatestPending, false);
  const ordinaryRefresh = harness.refresh();
  harness.resolve(2, capacity(), summaries(1, "subsequent"));
  await ordinaryRefresh;
  assert.deepEqual(harness.opened, ["notification-latest-0"]);
});

test("a superseded read failure retains pending auto-open intent for the current success", async () => {
  const harness = createRefreshHarness();
  const older = harness.refresh({ openLatest: true });
  const newer = harness.refresh();
  harness.calls.capacity[0].reject(new Error("Superseded failure"));
  harness.resolve(0);
  assert.equal(await older, null);
  assert.equal(harness.sandbox.streamReportsOpenLatestPending, true);
  assert.equal(harness.sandbox.streamReportsLoading, true);
  harness.resolve(1, capacity(), summaries(1, "current"));
  await newer;
  assert.deepEqual(harness.opened, ["current-0"]);
  assert.equal(harness.sandbox.streamReportsOpenLatestPending, false);
});

test("a current read failure clears auto-open intent, so ordinary retries do not reopen reports", async () => {
  const harness = createRefreshHarness();
  const failing = harness.refresh({ openLatest: true });
  harness.calls.capacity[0].reject(new Error("Current failure"));
  harness.resolve(0);
  assert.equal(await failing, null);
  assert.equal(harness.sandbox.streamReportsOpenLatestPending, false);
  const retrying = harness.refresh();
  harness.resolve(1, capacity(), summaries(1, "retry"));
  await retrying;
  assert.deepEqual(harness.opened, []);
  const requested = harness.refresh({ openLatest: true });
  harness.resolve(2, capacity(), summaries(1, "requested"));
  await requested;
  assert.deepEqual(harness.opened, ["requested-0"]);
});

test("an empty current success consumes auto-open intent without opening a later unrelated report", async () => {
  const harness = createRefreshHarness();
  const empty = harness.refresh({ openLatest: true });
  harness.resolve(0, capacity({ totalReports: 0 }), []);
  assert.equal(await empty, null);
  assert.equal(harness.sandbox.streamReportsOpenLatestPending, false);
  const later = harness.refresh();
  harness.resolve(1, capacity(), summaries(1, "later"));
  await later;
  assert.deepEqual(harness.opened, []);
});

test("an older failed refresh cannot clear newer capacity, show an error, or move focus", async () => {
  const harness = createRefreshHarness();
  const older = harness.refresh({ focusError: true });
  const newer = harness.refresh();
  const freshCapacity = capacity({ totalReports: 28, usedBytes: 94_000 });
  harness.resolve(1, freshCapacity);
  await newer;
  const renderCount = harness.rendered.length;
  harness.calls.capacity[0].reject(new Error("Stale failure"));
  harness.calls.dashboard[0].resolve({ reports: [] });
  harness.calls.archived[0].resolve({ reports: [] });
  assert.equal(await older, null);
  assert.equal(harness.sandbox.reportLibraryCapacity, freshCapacity);
  assert.equal(harness.sandbox.streamReportsLoadError, null);
  assert.equal(harness.sandbox.archivedReportsLoadError, null);
  assert.equal(harness.rendered.length, renderCount);
  assert.deepEqual(harness.focused, []);
  assertWarning(harness, combined(2, 94));
});

test("late refresh success and failure after disposal do not update or focus the panel", async () => {
  for (const failure of [false, true]) {
    const harness = createRefreshHarness();
    const refreshing = harness.refresh({ openLatest: true, focusError: true });
    harness.sandbox.reportLibraryDisposed = true;
    const renderCount = harness.rendered.length;
    if (failure) harness.calls.capacity[0].reject(new Error("After disposal"));
    harness.resolve(0, capacity({ totalReports: 30 }));
    assert.equal(await refreshing, null);
    assert.equal(harness.sandbox.reportLibraryCapacity, null);
    assert.equal(harness.sandbox.streamReportsLoadError, null);
    assert.equal(harness.sandbox.archivedReportsLoadError, null);
    assert.equal(harness.rendered.length, renderCount);
    assert.deepEqual(harness.opened, []);
    assert.deepEqual(harness.focused, []);
    assert.equal(await harness.refresh(), null);
    for (const calls of Object.values(harness.calls)) assert.equal(calls.length, 1);
  }
});

test("mutation completion uses fresh capacity and keeps its intermediate warning hidden", async () => {
  const harness = createRefreshHarness({ reportLibraryCapacity: capacity({ totalReports: 30 }) });
  const { sandbox } = harness;
  const deletion = deferred();
  sandbox.streamReportClient.deleteArchivedReports = () => deletion.promise;
  Object.assign(sandbox, {
    selectedArchivedReportIds: new Set(["archived-1"]), announceReportMutation() {},
    setReportInteractionError(error) { throw error; }, renderArchivedReportsView() {},
    getAvailableDashboardReportSlots() { return 5; },
  });
  vm.runInContext(functionSource("runReportMutation"), sandbox);
  const mutating = sandbox.runReportMutation("delete", ["archived-1"]);
  assert.equal(sandbox.reportMutationBusy, true);
  assert.equal(harness.rendered.at(-1).hidden, true);
  deletion.resolve();
  await new Promise(setImmediate);
  assert.equal(harness.calls.capacity.length, 1);
  harness.resolve(0, capacity({ totalReports: 29, usedBytes: 81_000 }));
  await mutating;
  assert.equal(sandbox.reportMutationBusy, false);
  assert.equal(sandbox.selectedArchivedReportIds.size, 0);
  assertWarning(harness, combined(1, 81));
  assert.ok(harness.rendered.slice(0, -1).every((render) => render.hidden));
});

test("successful End without report waits for fresh capacity before focusing and announcing completion", async () => {
  const harness = createEndWithoutReportHarness();
  const { sandbox } = harness;
  sandbox.endActiveStreamWithoutReport();
  assert.equal(sandbox.endConfirmationOpen, false);
  assert.equal(sandbox.streamSessionEndConfirmation.hidden, true);
  assert.deepEqual(harness.events, ["status-focus"]);
  assert.equal(harness.calls.capacity.length, 0);
  sandbox.streamSnapshot = { phase: "ready", busy: false, activeSession: null };
  harness.ending.resolve(sandbox.streamSnapshot);
  await new Promise(setImmediate);
  assert.equal(harness.calls.capacity.length, 1);
  assert.equal(sandbox.reportLibraryCapacity, null);
  assert.equal(harness.events.includes("start-focus"), false);
  assert.equal(harness.announcements.textContent, "");
  const afterDiscard = capacity({ totalReports: 26, usedBytes: 70_000 });
  harness.resolve(0, afterDiscard);
  await new Promise(setImmediate);
  assert.equal(sandbox.reportLibraryCapacity, afterDiscard);
  assert.deepEqual(harness.events, ["status-focus", "end-request", "start-focus"]);
  assert.equal(harness.announcements.textContent,
    "Tracker stream ended without a new report. TikTok LIVE was not changed.");
  assertWarning(harness, "");
  assert.deepEqual(harness.opened, [], "ending without a report does not request auto-open");
});

test("failed or still-active End without report does not refresh capacity or announce success", async () => {
  for (const failure of ["rejection", "failed-snapshot", "still-active"]) {
    const harness = createEndWithoutReportHarness();
    const previousCapacity = harness.sandbox.reportLibraryCapacity;
    harness.sandbox.endActiveStreamWithoutReport();
    if (failure === "rejection") {
      harness.ending.reject(new Error("End failed"));
    } else {
      harness.ending.resolve(failure === "failed-snapshot"
        ? { phase: "error", activeSession: null }
        : { phase: "ready", activeSession: { streamId: "active" } });
    }
    await new Promise(setImmediate);
    for (const calls of Object.values(harness.calls)) assert.equal(calls.length, 0);
    assert.equal(harness.sandbox.reportLibraryCapacity, previousCapacity);
    assert.equal(harness.events.includes("start-focus"), false);
    assert.equal(harness.announcements.textContent, failure === "rejection" ? "End failed" : "");
  }
});

test("only valid trusted library notifications refresh, including notifications during own writes", () => {
  const harness = createHarness();
  const { sandbox } = harness;
  let refreshes = 0;
  const notification = Object.freeze({ syntheticLibraryChanged: true });
  Object.assign(sandbox, {
    chrome: { runtime: { id: "test-extension" } },
    streamReportProtocol: { isReportLibraryChangedNotification: (message) => message === notification },
    refreshStreamReports() { refreshes += 1; return Promise.resolve(null); },
  });
  vm.runInContext(functionSource("handleReportLibraryChanged"), sandbox);
  for (const sender of [undefined, null, {}, { id: "other-extension" }, { id: "test-extension", tab: {} }, { id: "test-extension", tab: null }]) {
    sandbox.handleReportLibraryChanged(notification, sender);
  }
  sandbox.handleReportLibraryChanged({}, { id: "test-extension" });
  assert.equal(refreshes, 0);
  for (const busyFlag of [null, "reportMutationBusy", "reportRenameBusy"]) {
    if (busyFlag) sandbox[busyFlag] = true;
    sandbox.handleReportLibraryChanged(notification, { id: "test-extension" });
    if (busyFlag) sandbox[busyFlag] = false;
  }
  assert.equal(refreshes, 3);
  sandbox.reportLibraryDisposed = true;
  sandbox.handleReportLibraryChanged(notification, { id: "test-extension" });
  assert.equal(refreshes, 3);
  assert.match(source, /chrome\.runtime\.onMessage\.addListener\(handleReportLibraryChanged\)/);
  assert.match(source, /"pagehide",[\s\S]*?reportLibraryDisposed = true;[\s\S]*?\+\+streamReportsRefreshGeneration;[\s\S]*?chrome\.runtime\.onMessage\.removeListener\(handleReportLibraryChanged\)/);
  assert.doesNotMatch(functionSource("handleReportLibraryChanged"), /setInterval|setTimeout/);
});

test("warning is a keyboard-focusable polite status with the exact tooltip and description", () => {
  const navigation = html.match(/<div class="stream-reports-navigation">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(navigation);
  const actions = navigation.match(/<div class="stream-reports-archive-actions">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(actions);
  assert.match(actions, /<button\b[^>]*id="view-archived-reports"[^>]*>\s*View archived reports\s*<\/button>\s*<span\b[^>]*id="stream-reports-capacity-warning"/);
  const warning = actions.match(/<span\b([^>]*id="stream-reports-capacity-warning"[^>]*)>\s*<\/span>/)?.[1];
  assert.ok(warning);
  for (const attribute of ['role="status"', 'aria-live="polite"', 'aria-atomic="true"', 'tabindex="0"']) {
    assert.ok(warning.includes(attribute), attribute);
  }
  assert.match(warning, /\bhidden(?:\s|$)/);
  assert.equal(warning.match(/title="([^"]+)"/)?.[1], tooltip);
  const descriptionId = warning.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.equal(descriptionId, "stream-reports-capacity-help");
  const description = html.match(new RegExp(`<span\\b([^>]*id="${descriptionId}"[^>]*)>([\\s\\S]*?)<\\/span>`));
  assert.ok(description);
  assert.match(description[1], /class="[^"]*visually-hidden[^"]*"/);
  assert.equal(description[2].trim(), tooltip);
  assert.match(navigation, /<span id="archived-reports-short-count"[^>]*>\s*0 archived/);
});

test("compact warning has yellow and red tones, wraps, shows keyboard focus, and respects hidden", () => {
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
  assert.ok(background, "default warning has a red-tinted background");
  assert.ok(Number(background[1]) > Number(background[2]) * 1.5);
  assert.ok(Number(background[1]) > Number(background[3]) * 1.5);
  const yellow = rule('.stream-reports-capacity-warning[data-tone="warning"]');
  assert.match(yellow, /background:/);
  assert.match(yellow, /color:/);
  assert.match(rule(".stream-reports-capacity-warning:focus-visible"), /outline:/);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/);
});
