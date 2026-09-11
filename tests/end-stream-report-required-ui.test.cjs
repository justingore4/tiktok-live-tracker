const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(directory, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(directory, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(directory, "sidepanel.css"), "utf8");

function listenerSource(target) {
  const start = source.indexOf(`  ${target}.addEventListener("click",`);
  assert.ok(start >= 0, `${target} click listener exists`);
  const end = source.indexOf("\n  });", start);
  return source.slice(start, end + 6);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const ending = deferred();
  const calls = [];
  const listeners = new Map();
  const session = Object.freeze({ streamId: "synthetic-stream", startedAt: "2026-09-10T12:00:00.000Z" });
  const context = {
    streamSnapshot: Object.freeze({ phase: "ready", busy: false, activeSession: session, resumed: true }),
    endConfirmationOpen: false,
    mappingAnnouncement: { textContent: "" },
    endReportReadiness: {},
    streamSessionEndConfirmation: { hidden: true },
    streamSessionStatusTitle: {}, streamSessionStatusMessage: {},
    streamSessionError: { hidden: false }, hasFocusedStreamError: true,
    describeReportReadiness: () => "Report attention items: 1 unresolved order.",
    renderStreamSnapshot(snapshot) { calls.push(["render", snapshot]); },
    async refreshStreamReports(options) { calls.push(["refresh", options]); },
    guardCaptureInteraction: () => false,
    shouldPrepareInventoryForStreamRetry: () => false,
    console: { error: (...args) => calls.push(["error", ...args]) },
    streamSessionController: {
      getSnapshot: () => context.streamSnapshot,
      endActiveStream: (...args) => { calls.push(["end", args]); return ending.promise; },
      retry: async () => { calls.push(["retry"]); return context.streamSnapshot; },
    },
    ...overrides,
  };
  for (const name of [
    "endStreamButton", "cancelEndStreamButton", "confirmEndStreamButton",
    "retryStreamSessionButton", "startStreamButton", "resumeStreamButton", "streamSessionStatus",
  ]) {
    context[name] = {
      hidden: false,
      focus: () => calls.push(["focus", name]),
      addEventListener: (event, listener) => {
        assert.equal(event, "click");
        listeners.set(name, listener);
      },
    };
  }
  vm.runInNewContext([
    "endStreamButton", "cancelEndStreamButton", "confirmEndStreamButton", "retryStreamSessionButton",
  ].map(listenerSource).join("\n"), context);
  return { context, calls, ending, session, click: (name) => listeners.get(name)({}) };
}

async function settle() { await new Promise(setImmediate); }

test("End without report buttons, bindings, handlers, and status messages are absent from the panel", () => {
  assert.doesNotMatch(html, /(?:confirm-)?end-stream-without-report|End without report/i);
  assert.doesNotMatch(source,
    /endActiveStreamWithoutReport|confirmEndStreamWithoutReportButton|endStreamWithoutReportButton|ending without a report|ended without a new report/i);
  const errorPanel = html.match(/id="stream-session-error"[\s\S]*?<\/section>/)?.[0];
  assert.ok(errorPanel);
  assert.deepEqual([...errorPanel.matchAll(/<button\s+id="([^"]+)"/g)].map((match) => match[1]),
    ["retry-stream-session"], "Error recovery exposes only the existing Retry button");
});

test("end confirmation has exactly two full-width controls in the existing order", () => {
  const confirmation = html.match(/id="stream-session-end-confirmation"[\s\S]*?id="stream-session-error"/)?.[0];
  assert.ok(confirmation);
  const buttons = [...confirmation.matchAll(/<button\s+id="([^"]+)"([^>]+)>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(buttons.map((match) => [match[1], match[3].trim()]), [
    ["cancel-end-stream", "Keep stream active"],
    ["confirm-end-stream", "End and create report"],
  ]);
  assert.ok(buttons.every((match) => /type="button"/.test(match[2])));
  assert.match(css, /\.stream-session-confirm-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(css, /\.stream-session-full-end-action\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/);
  assert.match(css, /\.primary-action,\s*\.secondary-action,\s*\.danger-action\s*\{[^}]*width:\s*100%;/);
  assert.match(confirmation, /id="end-report-readiness"[\s\S]*?aria-live="polite"/);
});

test("opening then canceling End preserves the active or resumable session and calls no end operation", () => {
  for (const resumed of [true, false]) {
    const h = harness();
    h.context.streamSnapshot = Object.freeze({ ...h.context.streamSnapshot, resumed });
    const snapshot = h.context.streamSnapshot;
    const before = JSON.stringify(snapshot);
    h.click("endStreamButton");
    assert.equal(h.context.endConfirmationOpen, true);
    assert.match(h.context.endReportReadiness.textContent, /1 unresolved order/);
    assert.deepEqual(h.calls.at(-1), ["focus", "cancelEndStreamButton"]);
    h.click("cancelEndStreamButton");
    assert.equal(h.context.endConfirmationOpen, false);
    assert.deepEqual(h.calls.at(-1), ["focus", "endStreamButton"]);
    assert.equal(h.context.streamSnapshot, snapshot);
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(h.calls.some(([action]) => ["end", "retry", "refresh"].includes(action)), false);
  }
});

test("existing session-busy safeguards reject End and confirmation without sending an end request", async () => {
  for (const button of ["endStreamButton", "confirmEndStreamButton"]) {
    const h = harness();
    h.context.streamSnapshot = Object.freeze({ ...h.context.streamSnapshot, busy: true });
    h.click(button);
    await settle();
    assert.match(h.context.mappingAnnouncement.textContent, /Wait for the current tracker stream change/);
    assert.deepEqual(h.calls, []);
    assert.equal(h.context.streamSnapshot.activeSession, h.session);
  }
});

test("normal confirmation still calls the report-producing End path and opens the saved report only after success", async () => {
  const h = harness();
  h.context.endConfirmationOpen = true;
  h.context.streamSessionEndConfirmation.hidden = false;
  h.click("confirmEndStreamButton");
  assert.equal(h.context.endConfirmationOpen, false);
  assert.equal(h.context.streamSessionEndConfirmation.hidden, true);
  assert.deepEqual(h.calls, [["focus", "streamSessionStatus"]]);
  await settle();
  assert.equal(h.calls.filter(([action]) => action === "end").length, 1);
  assert.equal(h.calls.find(([action]) => action === "end")[1].length, 0,
    "The normal end operation is called without skip-report options");
  assert.equal(h.calls.some(([action]) => action === "refresh"), false);
  assert.doesNotMatch(h.context.mappingAnnouncement.textContent, /was saved/);
  h.ending.resolve({ phase: "ready", activeSession: null });
  await settle();
  assert.ok(h.calls.some(([action, target]) => action === "focus" && target === "startStreamButton"));
  const refresh = h.calls.find(([action]) => action === "refresh");
  assert.equal(refresh[1].openLatest, true);
  assert.match(h.context.mappingAnnouncement.textContent, /local business report was saved/);
});

test("failed report creation or an unfinished end keeps the session and never announces a saved report", async () => {
  for (const failure of ["error-snapshot", "still-active", "rejection"]) {
    const h = harness();
    const original = h.context.streamSnapshot;
    h.click("confirmEndStreamButton");
    await settle();
    if (failure === "rejection") h.ending.reject(new Error("Synthetic report save failure"));
    else h.ending.resolve({
      phase: failure === "error-snapshot" ? "error" : "ready",
      activeSession: h.session,
      error: failure === "error-snapshot" ? { scope: "end", message: "Report library full" } : null,
    });
    await settle();
    assert.equal(h.context.streamSnapshot, original);
    assert.equal(h.context.streamSnapshot.activeSession, h.session);
    assert.equal(h.calls.some(([action]) => action === "refresh"), false);
    assert.equal(h.calls.some(([action, target]) => action === "focus" && target === "startStreamButton"), false);
    assert.doesNotMatch(h.context.mappingAnnouncement.textContent, /was saved|stream ended/);
    assert.equal(h.calls.some(([action]) => action === "error"), failure === "rejection");
  }
});

test("Retry retains the existing recovery path without any alternate end action", async () => {
  const h = harness();
  h.context.streamSnapshot = Object.freeze({
    ...h.context.streamSnapshot, phase: "error", error: { scope: "end", message: "Synthetic save error" },
  });
  h.click("retryStreamSessionButton");
  assert.equal(h.context.hasFocusedStreamError, false);
  assert.equal(h.context.streamSessionError.hidden, true);
  assert.equal(h.context.streamSessionStatus.hidden, false);
  assert.equal(h.context.streamSessionStatusTitle.textContent, "Retrying tracker stream...");
  await settle();
  assert.equal(h.calls.filter(([action]) => action === "retry").length, 1);
  assert.equal(h.calls.some(([action]) => action === "end" || action === "refresh"), false);
  assert.equal(h.context.streamSnapshot.activeSession, h.session);
});
