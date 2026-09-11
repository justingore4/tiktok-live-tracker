const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Locate real ${name} function`);
  return source.slice(start, end);
}

function node() {
  return {
    hidden: false, disabled: false, textContent: "", dataset: {}, attributes: {},
    parentElement: null, focusCount: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) { child.parentElement = this; },
    focus() { this.focusCount += 1; },
  };
}

const session = Object.freeze({
  streamId: "local-stream:11111111-1111-4111-8111-111111111111",
  startedAt: "2026-09-10T13:33:00.000Z",
});

function snapshot(overrides = {}) {
  return Object.freeze({
    phase: "ready", busy: false, activeSession: session, resumed: true,
    operation: "resume", error: null, ...overrides,
  });
}

function renderFixture() {
  const calls = [];
  const context = {
    Intl, Date, console, Promise,
    streamSnapshot: snapshot({ activeSession: null, resumed: false }),
    savedSnapshot: { phase: "ready", busy: false },
    endConfirmationOpen: false,
    hasFocusedStreamError: false,
    persistentController: {},
    captureHealthController: { setSession: (id) => calls.push(["health", id]) },
    inventoryImportController: {
      setActiveStream: (active) => calls.push(["inventory", active]),
      refreshStatus: () => { calls.push(["refreshInventory"]); return Promise.resolve(); },
    },
    updateLayoutOrder: (value) => calls.push(["layout", value]),
    updateSessionControls: () => calls.push(["controls"]),
    describeReportReadiness: () => "Synthetic report readiness",
    isInventoryReadyForStart: () => true,
    unmountPersistentController: () => calls.push(["unmount"]),
    mountPersistentController: (value) => calls.push(["mount", value]),
    setWorkspaceBusy: (busy) => calls.push(["busy", busy]),
    setTrackerWorkspaceVisible: (visible) => calls.push(["workspace", visible]),
  };
  for (const name of [
    "endReportReadiness", "streamSessionPanel", "streamSessionBadge",
    "streamSessionHeading", "streamSessionStatus", "streamSessionStatusTitle",
    "streamSessionStatusMessage", "streamSessionError", "streamSessionActions",
    "startStreamButton", "resumeStreamButton", "endStreamButton",
    "confirmEndStreamButton", "confirmEndStreamWithoutReportButton",
    "cancelEndStreamButton", "endStreamWithoutReportButton",
    "streamSessionEndConfirmation", "streamSessionErrorTitle",
    "streamSessionErrorMessage", "retryStreamSessionButton", "savedSessionError",
  ]) context[name] = node();
  context.streamSessionHeading.append(context.streamSessionBadge);
  const render = vm.runInNewContext(
    `${functionSource("formatStreamStart", "isInventoryReadyForStart")}\n` +
    `${functionSource("renderStreamSnapshot", "announceSavedAction")}\nrenderStreamSnapshot;`,
    context,
  );
  return { context, calls, render };
}

test("active session combines the real formatted start time in one uniform text heading without mutating session data", () => {
  const f = renderFixture();
  for (const startedAt of [session.startedAt, "2027-01-02T02:07:00.000Z"] ) {
    const current = snapshot({ activeSession: Object.freeze({ ...session, startedAt }) });
    const before = JSON.stringify(current);
    f.render(current);
    const expectedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(startedAt));
    assert.equal(f.context.streamSessionStatusTitle.textContent, `Tracker Active | Started ${expectedDate}`);
    assert.equal(f.context.streamSessionStatusMessage.textContent, "");
    assert.equal(f.context.streamSessionStatusMessage.hidden, true);
    assert.equal(f.context.streamSessionBadge.textContent, "");
    assert.equal(f.context.streamSessionBadge.hidden, true);
    assert.equal(f.context.streamSessionStatus.hidden, false);
    assert.equal(f.context.streamSessionBadge.parentElement, f.context.streamSessionStatus);
    assert.equal(f.context.streamSessionPanel.dataset.state, "active");
    assert.equal(f.context.streamSessionPanel.attributes["aria-busy"], "false");
    assert.equal(JSON.stringify(current), before);
    assert.ok(f.calls.some(([action, value]) => action === "mount" && value === current.activeSession));
  }
  f.render(snapshot({ activeSession: Object.freeze({ ...session, startedAt: "invalid" }) }));
  assert.equal(f.context.streamSessionStatusTitle.textContent, "Tracker Active | Started an earlier time",
    "Existing invalid-date fallback is retained");
  assert.doesNotMatch(source, /This local identity will survive panel and browser restarts\./);
});

test("active session preserves End Stream Tracking and its confirmation controls", () => {
  const f = renderFixture();
  f.render(snapshot());
  assert.equal(f.context.startStreamButton.hidden, true);
  assert.equal(f.context.resumeStreamButton.hidden, true);
  assert.equal(f.context.endStreamButton.hidden, false);
  assert.equal(f.context.endStreamButton.disabled, false);
  assert.equal(f.context.streamSessionActions.hidden, false);
  assert.equal(f.context.streamSessionEndConfirmation.hidden, true);
  f.context.endConfirmationOpen = true;
  f.render(snapshot());
  assert.equal(f.context.endStreamButton.hidden, true);
  assert.equal(f.context.streamSessionEndConfirmation.hidden, false);
  for (const name of ["confirmEndStreamButton", "confirmEndStreamWithoutReportButton", "cancelEndStreamButton"]) {
    assert.equal(f.context[name].disabled, false);
  }
  f.render(snapshot({ phase: "saving", operation: "end", busy: true }));
  assert.equal(f.context.streamSessionPanel.dataset.state, "checking");
  assert.equal(f.context.streamSessionPanel.attributes["aria-busy"], "true");
  assert.equal(f.context.streamSessionActions.hidden, true);
  assert.equal(f.context.streamSessionBadge.hidden, false);
  assert.equal(f.context.streamSessionBadge.textContent, "Ending");
  assert.equal(f.context.streamSessionStatusMessage.hidden, false);
  for (const name of ["endStreamButton", "confirmEndStreamButton", "confirmEndStreamWithoutReportButton", "cancelEndStreamButton"]) {
    assert.equal(f.context[name].disabled, true);
  }
  assert.deepEqual(f.calls.at(-1), ["busy", true]);
});

test("leaving active view restores setup, resume and checking badges and descriptions", () => {
  for (const state of [
    { value: snapshot({ resumed: false }), label: "Ready to resume", dataState: "resume", statusHidden: true },
    { value: snapshot({ activeSession: null, resumed: false }), label: "Not started", dataState: "inactive", statusHidden: true },
    { value: snapshot({ phase: "loading", busy: true }), label: "Checking", dataState: "checking", statusHidden: false },
  ]) {
    const f = renderFixture();
    f.render(snapshot());
    f.render(state.value);
    assert.equal(f.context.streamSessionBadge.hidden, false);
    assert.equal(f.context.streamSessionStatusMessage.hidden, false);
    assert.equal(f.context.streamSessionBadge.parentElement, f.context.streamSessionHeading);
    assert.equal(f.context.streamSessionBadge.textContent, state.label);
    assert.equal(f.context.streamSessionPanel.dataset.state, state.dataState);
    assert.equal(f.context.streamSessionStatus.hidden, state.statusHidden);
    assert.ok(f.context.streamSessionStatusMessage.textContent.length > 0);
    if (state.dataState === "resume") {
      assert.equal(f.context.resumeStreamButton.hidden, false);
      assert.equal(f.context.endStreamButton.hidden, false);
      assert.equal(f.context.startStreamButton.hidden, true);
      assert.match(f.context.streamSessionStatusMessage.textContent, /Resume it to continue tagging/);
    } else if (state.dataState === "inactive") {
      assert.equal(f.context.startStreamButton.hidden, false);
      assert.equal(f.context.endStreamButton.hidden, true);
    }
    f.render(snapshot());
    assert.equal(f.context.streamSessionBadge.hidden, true);
    assert.equal(f.context.streamSessionStatusMessage.hidden, true);
  }
});

test("active session errors keep visible attention labels, retry messages and end-without-report recovery", () => {
  const f = renderFixture();
  f.render(snapshot());
  f.context.endConfirmationOpen = true;
  f.render(snapshot({ phase: "error", error: { scope: "end", message: "Synthetic storage error." } }));
  assert.equal(f.context.streamSessionBadge.hidden, false);
  assert.equal(f.context.streamSessionBadge.textContent, "Needs attention");
  assert.equal(f.context.streamSessionBadge.parentElement, f.context.streamSessionHeading);
  assert.equal(f.context.streamSessionStatus.hidden, true);
  assert.equal(f.context.streamSessionError.hidden, false);
  assert.equal(f.context.streamSessionErrorMessage.textContent, "Synthetic storage error. Nothing was changed.");
  assert.equal(f.context.retryStreamSessionButton.textContent, "Retry change");
  assert.equal(f.context.endStreamWithoutReportButton.hidden, false);
  assert.equal(f.context.endConfirmationOpen, false);
  assert.equal(f.context.streamSessionEndConfirmation.hidden, true);
  assert.equal(f.context.streamSessionError.focusCount, 1);
  assert.deepEqual(f.calls.at(-1), ["busy", false]);
  f.render(snapshot({ phase: "error", resumed: false, error: { scope: "load" } }));
  assert.equal(f.context.streamSessionErrorTitle.textContent, "Tracker stream unavailable");
  assert.equal(f.context.retryStreamSessionButton.textContent, "Retry loading");
  assert.equal(f.context.endStreamWithoutReportButton.hidden, true);
  assert.deepEqual(f.calls.at(-1), ["unmount"]);
});

function footerFixture() {
  const context = {
    appFooter: node(), sessionFooterLabel: node(), trackerWorkspace: node(), streamReportsPanel: node(),
    archivedReportsViewOpen: false, streamSnapshot: snapshot(),
  };
  const api = vm.runInNewContext(
    `${functionSource("updateFooterVisibility", "reorderAppSections")}\n` +
    `${functionSource("setFooterStatus", "formatReportTimestamp")}\n` +
    `${functionSource("getSavedStatusText", "formatStreamStart")}\n` +
    "({ updateFooterVisibility, setFooterStatus, getSavedStatusText });",
    context,
  );
  return { context, ...api };
}

test("active footer collapses restored-data status but immediately reveals errors, work and other useful statuses", () => {
  const f = footerFixture();
  for (const [text, phase] of [
    ["Could not save change", "error"], ["Checking live auction data...", "loading"],
    ["Saving change...", "saving"], ["Live auction data updated", "ready"],
    ["Saved locally", "ready"], ["Review inventory before continuing", "warning"],
  ]) {
    f.setFooterStatus("Live session data restored", "ready");
    assert.equal(f.context.appFooter.hidden, true, "The entire footer including its divider is hidden");
    f.setFooterStatus(text, phase);
    assert.equal(f.context.appFooter.hidden, false);
    assert.equal(f.context.sessionFooterLabel.textContent, text);
    assert.equal(f.context.appFooter.dataset.phase, phase);
  }
  f.setFooterStatus("Live session data restored", "error");
  assert.equal(f.context.appFooter.hidden, false, "Error phase must not be hidden based on text alone");
  assert.equal(f.getSavedStatusText({ phase: "ready", operation: "load" }), "Live session data restored",
    "Only footer presentation changes; the shared status used by announcements is preserved");
});

test("restored-data footer suppression stays scoped and retains existing setup/resume/archive visibility rules", () => {
  const f = footerFixture();
  f.setFooterStatus("Live session data restored", "ready");
  assert.equal(f.context.appFooter.hidden, true);
  f.context.streamSnapshot = snapshot({ resumed: false });
  f.updateFooterVisibility();
  assert.equal(f.context.appFooter.hidden, false, "No new suppression outside the resumed tracker");
  f.context.streamSnapshot = snapshot({ activeSession: null, resumed: false });
  f.updateFooterVisibility();
  assert.equal(f.context.appFooter.hidden, false, "Existing visible report/setup status is preserved");
  f.context.trackerWorkspace.hidden = true;
  f.context.streamReportsPanel.hidden = true;
  f.updateFooterVisibility();
  assert.equal(f.context.appFooter.hidden, true, "Existing Resume/End-only visibility rule remains");
  f.context.streamReportsPanel.hidden = false;
  f.updateFooterVisibility();
  assert.equal(f.context.appFooter.hidden, false);
  f.context.archivedReportsViewOpen = true;
  f.setFooterStatus("Saved locally", "ready");
  assert.equal(f.context.appFooter.hidden, true, "Existing archive view rule remains");
});

test("compact status styles affect only active view and preserve natural wrapping, the dot and live status semantics", () => {
  assert.match(css, /\.stream-session-panel\[data-state="active"\]\s*\{\s*padding:\s*10px;\s*\}/);
  const statusStyle = css.match(/\.stream-session-panel\[data-state="active"\] \.stream-session-status\s*\{([^}]+)\}/)?.[1];
  assert.ok(statusStyle);
  assert.match(statusStyle, /margin-top:\s*0;/);
  assert.match(statusStyle, /align-items:\s*center;/);
  assert.match(statusStyle, /gap:\s*8px;/);
  assert.match(statusStyle, /padding:\s*8px 10px;/);
  assert.match(css, /\.stream-session-panel\[data-state="active"\] \.stream-session-status-dot\s*\{[^}]*margin-top:\s*0;/);
  assert.match(css, /\.stream-session-panel\[data-state="active"\] \.stream-session-status h3\s*\{[^}]*line-height:\s*1\.45;[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.stream-session-status h3\s*\{[^}]*color:\s*var\(--text\);[^}]*font-size:\s*12px;[^}]*font-weight:\s*740;/);
  assert.match(css, /\.stream-session-panel\[data-state="active"\] \.stream-session-actions\s*\{[^}]*margin-top:\s*8px;/);
  assert.match(css, /\.stream-session-status > div\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1;/);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/);
  assert.doesNotMatch(statusStyle, /height:|white-space:\s*nowrap|overflow:\s*hidden/);
  assert.match(html, /id="stream-session-status"[^>]*role="status"[^>]*tabindex="-1"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /<span class="stream-session-status-dot" aria-hidden="true"><\/span>/);
  assert.match(html, /<h3 id="stream-session-status-title">[^<]+<\/h3>/);
  assert.match(html, /id="end-stream"[^>]*>[\s\S]*?End Stream Tracking\s*<\/button>/);
});
