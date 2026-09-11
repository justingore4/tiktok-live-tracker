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
    parentElement: null, focusCount: 0, children: [], appendCount: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    append(child) {
      if (child.parentElement) {
        const siblings = child.parentElement.children;
        siblings.splice(siblings.indexOf(child), 1);
      }
      this.children.push(child);
      child.parentElement = this;
      this.appendCount += 1;
    },
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
    "appHeader", "endReportReadiness", "streamSessionPanel", "streamSessionBadge",
    "streamSessionHeading", "streamSessionStatus", "streamSessionStatusTitle",
    "streamSessionStatusMessage", "streamSessionError", "streamSessionActions",
    "startStreamButton", "resumeStreamButton", "endStreamButton",
    "confirmEndStreamButton", "confirmEndStreamWithoutReportButton",
    "cancelEndStreamButton", "endStreamWithoutReportButton",
    "streamSessionEndConfirmation", "streamSessionErrorTitle",
    "streamSessionErrorMessage", "retryStreamSessionButton", "savedSessionError",
  ]) context[name] = node();
  context.appHeader.append(context.streamSessionBadge);
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
    assert.equal(f.context.streamSessionPanel.dataset.view, "tracker");
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
  assert.equal(f.context.streamSessionBadge.parentElement, f.context.streamSessionHeading);
  assert.equal(f.context.streamSessionHeading.hidden, false);
  assert.equal(f.context.streamSessionPanel.dataset.view, "tracker");
  assert.equal(f.context.streamSessionStatusMessage.hidden, false);
  for (const name of ["endStreamButton", "confirmEndStreamButton", "confirmEndStreamWithoutReportButton", "cancelEndStreamButton"]) {
    assert.equal(f.context[name].disabled, true);
  }
  assert.deepEqual(f.calls.at(-1), ["busy", true]);
});

test("leaving active view restores setup, resume and checking badges and descriptions", () => {
  for (const state of [
    { value: snapshot({ resumed: false }), label: "Ready to resume", dataState: "resume", statusHidden: true, setup: true },
    { value: snapshot({ activeSession: null, resumed: false }), label: "Not started", dataState: "inactive", statusHidden: true, setup: true },
    { value: snapshot({ phase: "loading", busy: true }), label: "Checking", dataState: "checking", statusHidden: false, setup: false },
  ]) {
    const f = renderFixture();
    f.render(snapshot());
    f.render(state.value);
    assert.equal(f.context.streamSessionBadge.hidden, false);
    assert.equal(f.context.streamSessionStatusMessage.hidden, false);
    assert.equal(f.context.streamSessionBadge.parentElement,
      state.setup ? f.context.appHeader : f.context.streamSessionHeading);
    assert.equal(f.context.streamSessionHeading.hidden, state.setup);
    assert.equal(f.context.streamSessionPanel.dataset.view, state.setup ? "setup" : "tracker");
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
  assert.equal(f.context.streamSessionHeading.hidden, false);
  assert.equal(f.context.streamSessionPanel.dataset.view, "tracker");
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

test("setup Start and Resume views put the existing live badge in the header and keep controls usable", () => {
  for (const resumedSession of [null, session]) {
    const f = renderFixture();
    const current = snapshot({ activeSession: resumedSession, resumed: false });
    const before = JSON.stringify(current);
    f.render(current);
    assert.equal(f.context.streamSessionBadge.parentElement, f.context.appHeader);
    assert.equal(f.context.streamSessionBadge.hidden, false);
    assert.equal(f.context.streamSessionBadge.textContent,
      resumedSession === null ? "Not started" : "Ready to resume");
    assert.equal(f.context.streamSessionHeading.hidden, true);
    assert.equal(f.context.streamSessionPanel.dataset.view, "setup");
    assert.equal(f.context.streamSessionStatus.hidden, true);
    assert.equal(f.context.streamSessionActions.hidden, false);
    assert.equal(f.context.streamSessionError.hidden, true);
    assert.equal(f.context.startStreamButton.hidden, resumedSession !== null);
    assert.equal(f.context.resumeStreamButton.hidden, resumedSession === null);
    assert.equal(f.context.endStreamButton.hidden, resumedSession === null);
    assert.equal(f.context.startStreamButton.disabled, false);
    assert.equal(f.context.resumeStreamButton.disabled, false);
    assert.equal(f.context.endStreamButton.disabled, false);
    assert.equal(JSON.stringify(current), before);
    assert.deepEqual(f.calls.at(-1), ["unmount"]);
    if (resumedSession === null) {
      f.context.isInventoryReadyForStart = () => false;
      f.render(current);
      assert.equal(f.context.startStreamButton.disabled, true,
        "Moving the badge does not bypass inventory readiness");
    } else {
      f.context.endConfirmationOpen = true;
      f.render(current);
      assert.equal(f.context.streamSessionEndConfirmation.hidden, false);
      assert.equal(f.context.resumeStreamButton.hidden, true);
      assert.equal(f.context.endStreamButton.hidden, true);
      assert.equal(f.context.streamSessionBadge.parentElement, f.context.appHeader);
    }
  }
});

test("initial loading and Start/Resume progress keep header badges dynamic without hiding useful status", () => {
  for (const scenario of [
    { phase: "idle", operation: "load", activeSession: null, label: "Checking", title: "Checking saved stream..." },
    { phase: "loading", operation: "load", activeSession: null, label: "Checking", title: "Checking saved stream..." },
    { phase: "saving", operation: "start", activeSession: null, label: "Saving", title: "Starting tracker stream..." },
    { phase: "loading", operation: "resume", activeSession: session, label: "Checking", title: "Checking saved stream..." },
    { phase: "saving", operation: "resume", activeSession: session, label: "Saving", title: "Checking saved stream..." },
  ]) {
    const f = renderFixture();
    f.context.persistentController = null;
    f.render(snapshot({
      phase: scenario.phase, operation: scenario.operation,
      activeSession: scenario.activeSession, resumed: false, busy: true,
    }));
    assert.equal(f.context.streamSessionBadge.parentElement, f.context.appHeader);
    assert.equal(f.context.streamSessionBadge.textContent, scenario.label);
    assert.equal(f.context.streamSessionBadge.dataset.state, "checking");
    assert.equal(f.context.streamSessionBadge.hidden, false);
    assert.equal(f.context.streamSessionHeading.hidden, true);
    assert.equal(f.context.streamSessionPanel.dataset.view, "setup");
    assert.equal(f.context.streamSessionPanel.attributes["aria-busy"], "true");
    assert.equal(f.context.streamSessionStatus.hidden, false);
    assert.equal(f.context.streamSessionStatusTitle.textContent, scenario.title);
    assert.equal(f.context.streamSessionStatusMessage.hidden, false);
    assert.match(f.context.streamSessionStatusMessage.textContent,
      /Looking for an active tracker stream|Waiting for the local session change/);
    assert.equal(f.context.streamSessionActions.hidden, true);
    for (const name of ["startStreamButton", "resumeStreamButton", "endStreamButton"]) {
      assert.equal(f.context[name].hidden, true);
      assert.equal(f.context[name].disabled, true);
    }
    assert.ok(f.calls.some(([action, value]) => action === "workspace" && value === false));
    assert.deepEqual(f.calls.at(-1), ["busy", true]);
  }
});

test("setup errors keep the header attention badge, visible focused errors and retries", () => {
  for (const scope of ["load", "start", "resume"]) {
    const f = renderFixture();
    const current = snapshot({
      phase: "error", resumed: false, activeSession: scope === "resume" ? session : null,
      error: { scope, message: "Synthetic setup failure." },
    });
    f.context.endConfirmationOpen = true;
    f.render(current);
    assert.equal(f.context.streamSessionBadge.parentElement, f.context.appHeader);
    assert.equal(f.context.streamSessionBadge.textContent, "Needs attention");
    assert.equal(f.context.streamSessionBadge.dataset.state, "error");
    assert.equal(f.context.streamSessionBadge.hidden, false);
    assert.equal(f.context.streamSessionHeading.hidden, true);
    assert.equal(f.context.streamSessionPanel.dataset.view, "setup");
    assert.equal(f.context.streamSessionPanel.attributes["aria-busy"], "false");
    assert.equal(f.context.streamSessionStatus.hidden, true);
    assert.equal(f.context.streamSessionError.hidden, false);
    assert.equal(f.context.streamSessionErrorMessage.textContent,
      "Synthetic setup failure. Nothing was changed.");
    assert.equal(f.context.retryStreamSessionButton.textContent,
      scope === "load" ? "Retry loading" : "Retry change");
    assert.equal(f.context.streamSessionError.focusCount, 1);
    assert.equal(f.context.streamSessionEndConfirmation.hidden, true);
    assert.equal(f.context.endStreamWithoutReportButton.hidden, true);
    assert.equal(f.context.streamSessionActions.hidden, true);
    assert.deepEqual(f.calls.at(-1), ["unmount"]);
    f.render(current);
    assert.equal(f.context.streamSessionError.focusCount, 1,
      "Unchanged errors retain the existing one-time focus behavior");
    f.render(snapshot({ activeSession: null, resumed: false }));
    assert.equal(f.context.streamSessionError.hidden, true);
    assert.equal(f.context.streamSessionBadge.textContent, "Not started");
  }
});

test("setup, tracker, busy and error transitions move one badge without clones or stale header content", () => {
  const f = renderFixture();
  const badge = f.context.streamSessionBadge;
  const containers = [f.context.appHeader, f.context.streamSessionHeading, f.context.streamSessionStatus];
  for (const [current, container, label] of [
    [snapshot({ phase: "loading", busy: true, activeSession: null, resumed: false }), f.context.appHeader, "Checking"],
    [snapshot({ activeSession: null, resumed: false }), f.context.appHeader, "Not started"],
    [snapshot({ resumed: false }), f.context.appHeader, "Ready to resume"],
    [snapshot(), f.context.streamSessionStatus, ""],
    [snapshot({ busy: true, phase: "saving", operation: "end" }), f.context.streamSessionHeading, "Ending"],
    [snapshot({ phase: "error", error: { scope: "end" } }), f.context.streamSessionHeading, "Needs attention"],
    [snapshot(), f.context.streamSessionStatus, ""],
    [snapshot({ activeSession: null, resumed: false }), f.context.appHeader, "Not started"],
  ]) {
    f.render(current);
    assert.equal(f.context.streamSessionBadge, badge);
    assert.equal(badge.parentElement, container);
    assert.equal(badge.textContent, label);
    assert.equal(containers.flatMap((parent) => parent.children).filter((child) => child === badge).length, 1);
    for (const parent of containers.filter((candidate) => candidate !== container)) {
      assert.equal(parent.children.includes(badge), false);
    }
    const appends = containers.reduce((sum, parent) => sum + parent.appendCount, 0);
    f.render(current);
    assert.equal(containers.reduce((sum, parent) => sum + parent.appendCount, 0), appends,
      "A repeated render does not move or recreate the badge");
  }
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

test("setup markup has one accessible live header badge and retains the session section label", () => {
  const header = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0];
  const panel = html.match(/<section\s+id="stream-session-panel"[\s\S]*?<\/section>/)?.[0];
  assert.ok(header);
  assert.ok(panel);
  assert.equal((html.match(/id="stream-session-badge"/g) ?? []).length, 1);
  assert.match(header, /id="stream-session-badge"[^>]*data-state="checking"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.ok(header.indexOf("<h1>TikTok Live Tracker</h1>") < header.indexOf('id="stream-session-badge"'));
  assert.doesNotMatch(panel, /id="stream-session-badge"/);
  assert.match(panel, /aria-labelledby="stream-session-title"/);
  assert.match(panel, /data-view="setup"/);
  assert.match(panel, /<div class="stream-session-heading" hidden>[\s\S]*?<h2 id="stream-session-title">Tracker stream<\/h2>/);
  assert.match(panel, /id="stream-session-status"[^>]*role="status"[^>]*tabindex="-1"[^>]*aria-live="polite"/);
  assert.match(panel, /id="stream-session-error"[^>]*role="alert"[^>]*tabindex="-1"/);
});

test("compact setup spacing and responsive header layout stay scoped away from active and archive views", () => {
  const rule = (selector) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selectors]) => selectors.split(",").some((candidate) => candidate.trim() === selector),
  )?.[2];
  assert.match(rule('.stream-session-panel[data-view="setup"]'), /padding:\s*10px;/);
  for (const selector of [
    '.stream-session-panel[data-view="setup"] .stream-session-actions',
    '.stream-session-panel[data-view="setup"] .stream-session-status',
    '.stream-session-panel[data-view="setup"] .stream-session-error',
    '.stream-session-panel[data-view="setup"][data-state="resume"] .stream-session-end-confirmation',
  ]) assert.match(rule(selector), /margin-top:\s*0;/);
  assert.match(rule(".app-header"), /grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(rule(".app-header > .stream-session-badge"), /justify-self:\s*end;/);
  const title = rule(".app-shell:not(.archived-reports-open) .app-header .brand-copy h1");
  assert.match(title, /overflow:\s*visible;/);
  assert.match(title, /white-space:\s*normal;/);
  assert.match(title, /overflow-wrap:\s*anywhere;/);
  assert.match(css, /@media\s*\(max-width:\s*320px\)\s*\{\s*\.app-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);\s*\}\s*\.app-header > \.stream-session-badge\s*\{[^}]*grid-column:\s*1 \/ -1;/);
  assert.match(rule(".app-shell.archived-reports-open .app-header"),
    /grid-template-columns:\s*auto minmax\(0, 1fr\);/);
  assert.match(rule(".app-shell.archived-reports-open .app-header > .stream-session-badge"),
    /display:\s*none;/);
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
