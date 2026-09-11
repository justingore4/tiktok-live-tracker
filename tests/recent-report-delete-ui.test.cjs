const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(directory, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(directory, "sidepanel.html"), "utf8");

function functionSource(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end + 4);
}

function listenerSource(target, event) {
  const start = source.indexOf(`  ${target}.addEventListener("${event}",`);
  assert.ok(start >= 0, `${target} ${event} listener exists`);
  const end = source.indexOf("\n  });", start);
  return source.slice(start, end + 6);
}

function harness(overrides = {}) {
  const writes = [];
  const reads = [];
  const announcements = [];
  let context;

  class Element {
    constructor(tagName = "div") {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.disabled = false;
      this.hidden = false;
      this.isConnected = true;
      this.open = false;
      this.showCount = 0;
    }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }
    dispatch(event, values = {}) {
      const input = {
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        ...values,
      };
      for (const listener of this.listeners.get(event) ?? []) listener(input);
      return input;
    }
    click() { if (!this.disabled) this.dispatch("click"); }
    focus() { context.document.activeElement = this; }
    querySelectorAll(selector) {
      assert.equal(selector, '[role="menuitem"]');
      return this.children.filter((child) => child.attributes.role === "menuitem");
    }
    showModal() { this.open = true; this.showCount++; }
    close(value = "") {
      if (!this.open) return;
      this.open = false;
      this.returnValue = value;
      this.dispatch("close");
    }
    cancelWithEscape() {
      const event = this.dispatch("cancel");
      if (!event.defaultPrevented) this.close();
    }
  }

  const client = Object.fromEntries(
    ["archiveReports", "restoreReports", "deleteReports", "deleteArchivedReports"]
      .map((action) => [action, async ({ reportIds }) => {
        writes.push({ action, ids: Array.from(reportIds) });
      }]),
  );
  client.listReports = async () => { reads.push("recent"); return { reports: [] }; };
  client.listArchivedReports = async () => { reads.push("archived"); return { reports: [] }; };
  client.getLibraryCapacity = async () => {
    reads.push("capacity");
    return { usedBytes: 101, maxBytes: 1000 };
  };

  context = vm.createContext({
    document: { activeElement: null, createElement: (tag) => new Element(tag) },
    archivedSelectionMode: false,
    selectedArchivedReportIds: new Set(),
    reportMutationBusy: false,
    reportDownloadBusy: false,
    reportRenameBusy: false,
    streamReportsLoading: false,
    openReportActions: null,
    pendingReportDeletion: null,
    pendingReportDeletionArchived: true,
    pendingReportDeletionReturnFocus: null,
    streamReportsLoadError: null,
    archivedReportsLoadError: null,
    streamReportSummaries: [],
    archivedReportSummaries: [],
    reportLibraryCapacity: null,
    reportLibraryDisposed: false,
    streamReportsOpenLatestPending: false,
    streamReportsRefreshGeneration: 0,
    archivedReportsViewOpen: false,
    MAX_DASHBOARD_REPORTS: 5,
    streamReportClient: client,
    viewModel: { formatUsdCents: (value) => `$${(value / 100).toFixed(2)}` },
    formatReportTimestamp: () => "Synthetic date",
    renderArchivedSelectionControls() {},
    renderArchivedReportsView() {},
    renderStreamReportsPanel() {
      context.streamReportsError.hidden = !context.streamReportsLoadError;
      context.streamReportsError.textContent = context.streamReportsLoadError ?? "";
      context.archivedReportsError.hidden = !context.archivedReportsLoadError;
      context.archivedReportsError.textContent = context.archivedReportsLoadError ?? "";
    },
    announceReportMutation: (message, archived) => announcements.push({ message, archived }),
    openStreamReport: async () => {},
    requestReportRename() {},
    runReportDownload() {},
    ...Object.fromEntries([
      "reportActionConfirmation", "reportActionConfirmationTitle",
      "reportActionConfirmationMessage", "confirmReportActionButton",
      "streamReportsError", "archivedReportsError",
    ].map((name) => [name, new Element()])),
    ...overrides,
  });

  vm.runInContext([
    "getAvailableDashboardReportSlots", "closeReportActionsMenu", "getReportMenuItems",
    "openReportActionsMenu", "handleReportMenuKeydown", "createReportMenuAction",
    "getReportDisplayName", "createStreamReportLink", "setReportInteractionError",
    "runReportMutation", "requestPermanentReportDeletion", "refreshStreamReports",
  ].map(functionSource).join("\n") + "\n" +
    listenerSource("confirmReportActionButton", "click") + "\n" +
    listenerSource("reportActionConfirmation", "close"), context);

  function report(id = "recent-a", options = {}) {
    const row = context.createStreamReportLink({
      reportId: id, displayName: `Report ${id}`,
      completedPaymentCount: 2, totalSalesCount: 3, completedGmvCents: 1234,
    }, options);
    const menu = row.children.find((child) => child.attributes.role === "menu");
    const more = row.children.find((child) => child.className === "report-more-button");
    return { row, menu, more, deletion: menu.children.find((child) => child.dataset.reportAction === "delete") };
  }
  return { context, client, writes, reads, announcements, report, Element };
}

async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

test("recent reports append Delete as the fourth menu action; archived actions remain unchanged", () => {
  const h = harness();
  const recent = h.report();
  assert.deepEqual(recent.menu.children.map((item) => item.textContent), [
    "Download PDF", "Rename", "Archive", "Delete",
  ]);
  assert.deepEqual(recent.menu.children.map((item) => item.dataset.reportAction), [
    "download-pdf", "rename", "archive", "delete",
  ]);
  assert.equal(recent.deletion.attributes.role, "menuitem");
  assert.deepEqual(h.report("archived-a", { archived: true }).menu.children.map((item) => item.textContent), [
    "Download PDF", "Restore", "Delete forever",
  ]);
  h.context.streamReportSummaries = Array.from({ length: 5 }, (_, index) => ({ reportId: `r-${index}` }));
  assert.deepEqual(h.report("archived-b", { archived: true }).menu.children.map((item) => item.textContent), [
    "Download PDF", "Delete forever",
  ]);
});

test("recent Delete opens the existing permanent-deletion confirmation without deleting or archiving", () => {
  const h = harness();
  const recent = h.report();
  recent.more.click();
  recent.deletion.click();
  assert.equal(recent.menu.hidden, true);
  assert.equal(h.context.reportActionConfirmation.open, true);
  assert.equal(h.context.reportActionConfirmationTitle.textContent, "Delete report forever?");
  assert.match(h.context.reportActionConfirmationMessage.textContent, /cannot be undone/);
  assert.match(h.context.reportActionConfirmationMessage.textContent, /TikTok LIVE and Google Sheets will not be changed/);
  assert.equal(h.context.confirmReportActionButton.textContent, "Delete forever");
  assert.equal(h.context.pendingReportDeletionArchived, false);
  assert.deepEqual(Array.from(h.context.pendingReportDeletion), ["recent-a"]);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.reads, []);
});

test("Cancel, Escape, and closing the confirmation perform no writes and restore the menu-button focus", () => {
  const dialog = html.match(/<dialog\s+id="report-action-confirmation"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dialog);
  assert.match(dialog, /<form method="dialog">/);
  assert.match(dialog, /id="cancel-report-action"[\s\S]*?type="submit"[\s\S]*?value="cancel"/);
  assert.match(dialog, /id="confirm-report-action"[\s\S]*?type="button"/);
  for (const method of ["cancel", "escape", "close"]) {
    const h = harness();
    const recent = h.report();
    recent.deletion.click();
    if (method === "escape") h.context.reportActionConfirmation.cancelWithEscape();
    else h.context.reportActionConfirmation.close(method === "cancel" ? "cancel" : "");
    assert.equal(h.context.pendingReportDeletion, null, method);
    assert.equal(h.context.pendingReportDeletionReturnFocus, null, method);
    assert.equal(h.context.document.activeElement, recent.more, method);
    h.context.confirmReportActionButton.click();
    assert.deepEqual(h.writes, [], method);
  }
});

test("a confirmed recent deletion uses the snapshot exactly once and refreshes both lists and capacity", async () => {
  const h = harness();
  let finish;
  h.client.deleteReports = ({ reportIds }) => {
    h.writes.push({ action: "deleteReports", ids: Array.from(reportIds) });
    return new Promise((resolve) => { finish = resolve; });
  };
  const selected = ["recent-a", "recent-a", "recent-b"];
  h.context.requestPermanentReportDeletion(selected, h.report().more, { archived: false });
  selected.splice(0, selected.length, "not-selected");
  h.context.confirmReportActionButton.click();
  h.context.confirmReportActionButton.click();
  assert.equal(h.context.reportActionConfirmation.open, false);
  assert.equal(h.context.pendingReportDeletion, null);
  assert.equal(h.context.reportMutationBusy, true);
  assert.deepEqual(h.writes, [{ action: "deleteReports", ids: ["recent-a", "recent-b"] }]);
  assert.deepEqual(h.reads, [], "Refresh waits for successful deletion");
  finish();
  await settle();
  assert.equal(h.context.reportMutationBusy, false);
  assert.deepEqual(h.reads, ["recent", "archived", "capacity"]);
  assert.equal(h.context.reportLibraryCapacity.usedBytes, 101);
  assert.equal(h.announcements.length, 1);
  assert.equal(h.announcements[0].archived, false, "Feedback belongs to the main report panel");
  assert.match(h.announcements[0].message, /2 reports were permanently deleted/);
});

test("the default archived confirmation keeps the archived-only delete route and feedback", async () => {
  const h = harness();
  h.report("archived-a", { archived: true }).deletion.click();
  assert.equal(h.context.pendingReportDeletionArchived, true);
  h.context.confirmReportActionButton.click();
  await settle();
  assert.deepEqual(h.writes, [{ action: "deleteArchivedReports", ids: ["archived-a"] }]);
  assert.equal(h.announcements[0].archived, true);
  assert.deepEqual(h.reads, ["recent", "archived", "capacity"]);
});

test("a canceled recent deletion cannot leak its destination into a later archived confirmation", async () => {
  const h = harness();
  h.report().deletion.click();
  h.context.reportActionConfirmation.close("cancel");
  h.report("archived-a", { archived: true }).deletion.click();
  h.context.confirmReportActionButton.click();
  await settle();
  assert.deepEqual(h.writes, [{ action: "deleteArchivedReports", ids: ["archived-a"] }]);
  assert.equal(h.announcements[0].archived, true);
});

test("busy mutations and downloads block stale Delete requests and mutation handlers", async () => {
  for (const flag of ["reportMutationBusy", "reportDownloadBusy"]) {
    const h = harness({ [flag]: true });
    const recent = h.report();
    assert.equal(recent.more.disabled, true, flag);
    recent.deletion.dispatch("click");
    assert.equal(h.context.reportActionConfirmation.showCount, 0, flag);
    await h.context.runReportMutation("delete", ["recent-a"], { archived: false });
    assert.deepEqual(h.writes, [], flag);
    assert.deepEqual(h.announcements, [], flag);
  }
  const h = harness();
  h.context.requestPermanentReportDeletion([], null, { archived: false });
  await h.context.runReportMutation("delete", [], { archived: false });
  assert.equal(h.context.reportActionConfirmation.showCount, 0);
  assert.deepEqual(h.writes, []);
});

test("a download starting while confirmation is open still prevents deletion on confirmation", async () => {
  const h = harness();
  h.report().deletion.click();
  h.context.reportDownloadBusy = true;
  h.context.confirmReportActionButton.click();
  await settle();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.announcements, []);
  assert.equal(h.context.reportDownloadBusy, true);
});

test("recent-delete failure is visible and focused on the main panel without false completion", async () => {
  const h = harness();
  const originalReports = [{ reportId: "recent-a", displayName: "Keep this report" }];
  h.context.streamReportSummaries = originalReports;
  h.client.deleteReports = async () => { throw new Error("Synthetic saved-report write failed"); };
  h.report().deletion.click();
  h.context.confirmReportActionButton.click();
  await settle();
  assert.equal(h.context.reportMutationBusy, false);
  assert.equal(h.context.streamReportsLoadError, "Synthetic saved-report write failed");
  assert.equal(h.context.archivedReportsLoadError, null);
  assert.equal(h.context.streamReportsError.hidden, false);
  assert.equal(h.context.archivedReportsError.hidden, true);
  assert.equal(h.context.document.activeElement, h.context.streamReportsError);
  assert.equal(h.context.streamReportSummaries, originalReports);
  assert.deepEqual(h.announcements, []);
  assert.deepEqual(h.reads, []);
});

test("archive remains a distinct action with its existing route and no deletion confirmation", async () => {
  const h = harness();
  const recent = h.report();
  recent.menu.children.find((item) => item.dataset.reportAction === "archive").click();
  await settle();
  assert.equal(h.context.reportActionConfirmation.showCount, 0);
  assert.deepEqual(h.writes, [{ action: "archiveReports", ids: ["recent-a"] }]);
  assert.equal(h.announcements[0].archived, false);
  assert.match(h.announcements[0].message, /1 report was archived/);
  assert.deepEqual(h.reads, ["recent", "archived", "capacity"]);
});

test("keyboard navigation reaches the fourth Delete action and Escape restores menu focus", () => {
  const h = harness();
  const recent = h.report();
  recent.more.dispatch("keydown", { key: "ArrowUp" });
  assert.equal(recent.menu.hidden, false);
  assert.equal(h.context.document.activeElement, recent.deletion);
  recent.menu.dispatch("keydown", { key: "Home" });
  assert.equal(h.context.document.activeElement.textContent, "Download PDF");
  recent.menu.dispatch("keydown", { key: "End" });
  assert.equal(h.context.document.activeElement, recent.deletion);
  recent.menu.dispatch("keydown", { key: "Escape" });
  assert.equal(recent.menu.hidden, true);
  assert.equal(h.context.document.activeElement, recent.more);
  assert.deepEqual(h.writes, []);
});
