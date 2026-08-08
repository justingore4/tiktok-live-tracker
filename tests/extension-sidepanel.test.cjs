const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionDirectory = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"),
);

function extensionResourceExists(relativePath) {
  return fs.existsSync(path.join(extensionDirectory, relativePath));
}

test("manifest configures the Chrome side-panel resources", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(Number(manifest.minimum_chrome_version) >= 114);
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(extensionResourceExists(manifest.side_panel.default_path));
  assert.ok(extensionResourceExists(manifest.background.service_worker));
  assert.equal(manifest.action.default_title, "Open TikTok Live Tracker");
});

test("service worker opens the side panel from the toolbar action", () => {
  const workerSource = fs.readFileSync(
    path.join(extensionDirectory, manifest.background.service_worker),
    "utf8",
  );
  let requestedBehavior = null;
  class FakeReconciliationError extends Error {}
  class FakeStorageError extends Error {}
  class FakeCoordinatorError extends Error {}
  class FakeStreamError extends Error {}
  class FakeStreamStorageError extends Error {}
  class FakeStreamCoordinatorError extends Error {}
  const sandbox = {
    importScripts() {},
    TikTokLiveTrackerReconciliation: {
      ReconciliationError: FakeReconciliationError,
    },
    TikTokLiveTrackerReconciliationStorage: {
      ReconciliationStorageError: FakeStorageError,
      createReconciliationStateStore() {
        return {};
      },
    },
    TikTokLiveTrackerReconciliationCoordinator: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.reconciliation",
      MESSAGE_VERSION: 1,
      COMMAND_TYPES: {
        RECORD_PAYMENT_COMPLETE: "record_payment_complete",
      },
      ReconciliationCoordinatorError: FakeCoordinatorError,
      createReconciliationCoordinator() {
        return { dispatch: () => Promise.resolve({}) };
      },
    },
    TikTokLiveTrackerStreamSession: {
      StreamSessionError: FakeStreamError,
    },
    TikTokLiveTrackerStreamSessionStorage: {
      StreamSessionStorageError: FakeStreamStorageError,
      createStreamSessionStateStore() {
        return {};
      },
    },
    TikTokLiveTrackerStreamSessionCoordinator: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.stream-session",
      MESSAGE_VERSION: 1,
      COMMAND_TYPES: {
        GET_STREAM_SESSION: "get_stream_session",
        START_STREAM: "start_stream",
        END_STREAM: "end_stream",
      },
      StreamSessionCoordinatorError: FakeStreamCoordinatorError,
      createStreamSessionCoordinator() {
        return { dispatch: () => Promise.resolve({}) };
      },
    },
    crypto: {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    },
    chrome: {
      storage: {
        local: {
          setAccessLevel() {
            return Promise.resolve();
          },
        },
      },
      runtime: {
        id: "extension-id",
        getURL: (pathName) => `chrome-extension://extension-id/${pathName}`,
        onMessage: { addListener() {} },
      },
      sidePanel: {
        setPanelBehavior(behavior) {
          requestedBehavior = behavior;
          return Promise.resolve();
        },
      },
    },
    console,
  };

  vm.runInNewContext(workerSource, sandbox);

  assert.equal(requestedBehavior?.openPanelOnActionClick, true);
});

test("side panel keeps every script and stylesheet inside the extension", () => {
  const panelPath = path.join(
    extensionDirectory,
    manifest.side_panel.default_path,
  );
  const panelDirectory = path.dirname(panelPath);
  const html = fs.readFileSync(panelPath, "utf8");
  const resourcePaths = [
    ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g),
  ].map((match) => match[1]);

  assert.deepEqual(resourcePaths, [
    "sidepanel.css",
    "../shared/sale-parser.js",
    "../shared/reconciliation.js",
    "../shared/reconciliation-coordinator.js",
    "../shared/stream-session-coordinator.js",
    "reconciliation-client.js",
    "stream-session-client.js",
    "stream-session-controller.js",
    "inventory-view-model.js",
    "mapping-workflow.js",
    "persistent-tagger-controller.js",
    "sidepanel.js",
  ]);
  assert.ok(
    resourcePaths.every((relativePath) =>
      fs.existsSync(path.join(panelDirectory, relativePath)),
    ),
  );
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
});

test("side panel exposes accessible lifecycle controls and clearly labels demo data", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );

  assert.match(html, /<label[^>]+for="inventory-search"/);
  assert.match(html, /<label[^>]+for="variation-selector"/);
  assert.match(html, /class="mode-controls"[^>]+role="group"/);
  assert.match(
    html,
    /id="saved-session-mode"[\s\S]+aria-pressed="true"[\s\S]+aria-describedby="mode-description"/,
  );
  assert.match(
    html,
    /id="offline-demo-mode"[\s\S]+aria-pressed="false"[\s\S]+aria-describedby="mode-description"/,
  );
  assert.match(
    html,
    /id="saved-session-status"[\s\S]+role="status"[\s\S]+aria-live="polite"/,
  );
  assert.match(
    html,
    /id="stream-session-panel"[\s\S]+aria-busy="true"/,
  );
  assert.match(
    html,
    /id="stream-session-status"[\s\S]+role="status"[\s\S]+tabindex="-1"[\s\S]+aria-live="polite"/,
  );
  assert.match(
    html,
    /id="stream-session-error"[\s\S]+role="alert"[\s\S]+tabindex="-1"/,
  );
  assert.match(html, /id="start-stream"[\s\S]+type="button"/);
  assert.match(html, /id="resume-stream"[\s\S]+type="button"/);
  assert.match(html, /id="end-stream"[\s\S]+type="button"/);
  assert.match(html, /id="confirm-end-stream"[\s\S]+type="button"/);
  assert.match(html, /id="retry-stream-session"[\s\S]+type="button"/);
  assert.match(html, /do not[\s\S]+start or end TikTok LIVE/i);
  assert.match(html, /Prototype variation - capture not connected/);
  assert.match(html, /ended streams cannot be reopened in this prototype/i);
  assert.match(
    html,
    /id="saved-session-error"[\s\S]+role="alert"[\s\S]+tabindex="-1"/,
  );
  assert.match(html, /id="retry-saved-session"[^>]+type="button"/);
  assert.match(
    html,
    /id="tracker-workspace"[\s\S]+aria-busy="true"[\s\S]+inert[\s\S]+hidden/,
  );
  assert.match(
    html,
    /id="variation-selector"[^>]+aria-describedby="variation-context"/,
  );
  assert.match(
    html,
    /id="return-to-current"[^>]+type="button"[^>]+hidden/,
  );
  assert.match(html, /id="result-count"[^>]+aria-live="polite"/);
  assert.match(html, /id="inventory-grid"[^>]+role="list"/);
  assert.match(html, /class="inventory-card-wrapper"[^>]+role="listitem"/);
  assert.match(html, /<button class="inventory-card"[^>]+aria-pressed="false"/);
  assert.match(html, /Click the selected card again to remove its item/);
  assert.match(html, /id="pending-mapping"/);
  assert.match(html, /id="auction-eyebrow"[^>]*>Auction status</);
  assert.match(html, /id="mapping-announcement"[\s\S]+role="status"/);
  assert.match(html, /id="state-warning"[^>]+role="status"/);
  assert.match(html, />Waiting for payment</);
  assert.match(html, /<label[^>]+for="sold-price"/);
  assert.match(html, /id="sold-price"[\s\S]+aria-describedby=/);
  assert.match(html, /id="sold-price-error"[^>]+role="alert"/);
  assert.match(html, />Saved order controls</);
  assert.match(html, />\s*Simulate payment complete\s*</);
  assert.match(html, />\s*Simulate payment buffer expired\s*</);
  assert.match(html, />\s*Mark unpaid after buffer\s*</);
  assert.match(html, />\s*Undo unpaid\s*</);
  assert.match(html, /id="undo-payment-note"/);
  assert.match(
    html,
    /id="undo-simulated-payment"[\s\S]+aria-describedby="undo-payment-note"/,
  );
  assert.match(html, />\s*Undo simulated payment\s*</);
  assert.match(html, /data-field="gross-profit"/);
  assert.match(html, />\s*Live session\s*</);
  assert.match(html, /Offline demo/);
  assert.match(html, /do not change TikTok/);
  assert.doesNotMatch(html, /id="change-mapping"/);
  assert.doesNotMatch(html, />\s*Change item\s*</);
});

test("tagger UI separates persistent commands from the offline lifecycle", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const workflowSource = fs.readFileSync(
    path.join(taggerDirectory, "mapping-workflow.js"),
    "utf8",
  );
  const mappingSource = `${panelSource}\n${workflowSource}`;

  assert.match(panelSource, /button\.disabled = !entry\.selectionAllowed/);
  assert.match(panelSource, /function renderVariationNavigation\(view\)/);
  assert.match(
    panelSource,
    /variationSelector\.addEventListener\("change",[\s\S]+persistentController\.selectVariation[\s\S]+getDemoSession\(\)\.selectVariation/,
  );
  assert.match(
    panelSource,
    /returnToCurrentButton\.addEventListener\("click",[\s\S]+persistentController\.selectVariation\([\s\S]*?DEMO_CURRENT_VARIATION_NUMBER[\s\S]+getDemoSession\(\)\.selectVariation/,
  );
  assert.match(panelSource, /view\.selectedVariationNumber/);
  assert.doesNotMatch(panelSource, /\bDEMO_VARIATION_NUMBER\b/);
  assert.match(panelSource, /setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(panelSource, /Click to unselect this item/);
  assert.match(
    panelSource,
    /No item selected\. Select the matching inventory entry below\./,
  );
  assert.match(panelSource, /getDemoSession\(\)\.completePayment/);
  assert.match(panelSource, /getDemoSession\(\)\.simulatePaymentBufferExpired/);
  assert.match(panelSource, /getDemoSession\(\)\.markUnpaid/);
  assert.match(panelSource, /getDemoSession\(\)\.undoMarkUnpaid/);
  assert.match(panelSource, /getDemoSession\(\)\.undoSimulatedPayment/);
  assert.match(panelSource, /offlineSimulation: true/);
  assert.match(
    panelSource,
    /undoSimulatedPaymentButton\.addEventListener\("click",[\s\S]+searchInput\.value = "";[\s\S]+result\.mapping[\s\S]+focusStatus: true/,
  );
  assert.match(
    panelSource,
    /committed && !canUndoSimulatedPayment/,
  );
  assert.match(
    panelSource,
    /undoSimulatedPaymentButton\.hidden = !canUndoSimulatedPayment/,
  );
  assert.match(
    panelSource,
    /Remove the simulated payment with no item selected/,
  );
  assert.match(panelSource, /const auction = view\.auction/);
  assert.match(panelSource, /getDemoSession\(\)\.selectSku\(button\.dataset\.sku\)/);
  assert.match(panelSource, /persistentController\.mapSelectedSku/);
  assert.match(panelSource, /persistentController\.unmapSelectedVariation/);
  assert.match(panelSource, /type: selected \? "unmap_variation" : "map_variation"/);
  assert.match(panelSource, /result\.action === "unmapped"/);
  assert.match(workflowSource, /reconciliation\.unmapVariation\(state, auctionKey\(\)\)/);
  assert.match(
    workflowSource,
    /reconciliation\.unmapVariation\([\s\S]+simulatedPaymentCheckpoint\.state/,
  );
  assert.match(panelSource, /persistentController\.markSelectedUnpaid/);
  assert.match(panelSource, /persistentController\.undoSelectedUnpaid/);
  assert.match(panelSource, /const mountedController = persistentController/);
  assert.match(panelSource, /mountedController\.start\(\)/);
  assert.match(panelSource, /persistentController\.retry\(\)/);
  assert.match(panelSource, /mountedController\.subscribe\(renderSavedSnapshot\)/);
  assert.match(
    panelSource,
    /streamId: activeSession\.streamId/,
  );
  assert.match(
    panelSource,
    /streamSessionController\.subscribe\(renderStreamSnapshot\)/,
  );
  assert.match(panelSource, /streamSessionController\.startNewStream\(\)/);
  assert.match(panelSource, /streamSessionController\.resumeActiveStream\(\)/);
  assert.match(panelSource, /streamSessionController\.endActiveStream\(\)/);
  assert.match(panelSource, /streamSessionController\.retry\(\)/);
  assert.match(panelSource, /getUnresolvedLiveVariations\(\)/);
  assert.match(panelSource, /Prototype current/);
  assert.match(panelSource, /capture not connected/);
  assert.match(
    panelSource,
    /savedModeButton\.addEventListener\("click",[\s\S]+selectMode\("saved_session"\)/,
  );
  assert.match(
    panelSource,
    /demoModeButton\.addEventListener\("click",[\s\S]+selectMode\("offline_demo"\)/,
  );
  assert.match(
    panelSource,
    /trackerWorkspace\.toggleAttribute\("inert", shouldBeInert\)/,
  );
  assert.match(panelSource, /savedSnapshot\?\.phase === "error"/);
  assert.match(panelSource, /savedSnapshot\?\.phase === "error" \|\| endConfirmationOpen/);
  assert.match(panelSource, /persistentController === null \|\| savedSnapshot\?\.phase !== "ready"/);
  assert.match(
    panelSource,
    /retryStreamSessionButton\.addEventListener\("click",[\s\S]+streamSessionStatus\.hidden = false;[\s\S]+streamSessionError\.hidden = true;[\s\S]+streamSessionStatus\.focus\(\)/,
  );
  assert.match(panelSource, /savedSessionError\.focus\(\)/);
  assert.match(panelSource, /pendingSavedAction \|\| savedSnapshot\?\.busy/);
  assert.match(panelSource, /activeMode !== "offline_demo"/);
  assert.doesNotMatch(panelSource, /persistentController\.[^(]*Payment/);
  assert.match(panelSource, /result\.action === "completed_sale_mapped"/);
  assert.match(panelSource, /view\.auction\?\.status === "unmapped_completed"/);
  assert.doesNotMatch(
    panelSource,
    /warnings\.some\([\s\S]+unmapped_completed_sale/,
  );
  assert.doesNotMatch(panelSource, /changeMappingButton|#change-mapping/);
  assert.match(panelSource, /auctionEyebrow\.textContent/);
  assert.match(panelSource, /stateWarning\.textContent !== warning/);
  assert.doesNotMatch(panelSource, /this pending mapping/);
  assert.doesNotMatch(mappingSource, /undoPaymentComplete/);
  assert.doesNotMatch(
    mappingSource,
    /chrome\.storage|sendMessage|\bfetch\s*\(|sheets\.googleapis|completed_sale_detected/,
  );
});

test("capture scripts load across the TikTok shop SPA and gate themselves at runtime", () => {
  const dashboardScript = manifest.content_scripts.find((script) =>
    script.matches.includes("https://shop.tiktok.com/*"),
  );

  assert.ok(dashboardScript);
  assert.deepEqual(dashboardScript.js, [
    "shared/sale-parser.js",
    "capture/sale-candidate-locator.js",
    "capture/capture-event-registry.js",
    "capture/capture-scheduler.js",
    "capture/content.js",
  ]);
  assert.ok(dashboardScript.js.every(extensionResourceExists));

  const captureSource = fs.readFileSync(
    path.join(extensionDirectory, "capture", "content.js"),
    "utf8",
  );
  const schedulerSource = fs.readFileSync(
    path.join(extensionDirectory, "capture", "capture-scheduler.js"),
    "utf8",
  );
  const locatorSource = fs.readFileSync(
    path.join(extensionDirectory, "capture", "sale-candidate-locator.js"),
    "utf8",
  );
  const registrySource = fs.readFileSync(
    path.join(extensionDirectory, "capture", "capture-event-registry.js"),
    "utf8",
  );

  assert.match(captureSource, /TikTokLiveTrackerCaptureScheduler/);
  assert.match(captureSource, /TikTokLiveTrackerSaleCandidateLocator/);
  assert.match(captureSource, /TikTokLiveTrackerCaptureEventRegistry/);
  assert.match(captureSource, /const QUIET_SCAN_DELAY_MS = 150/);
  assert.match(captureSource, /const MAX_SCAN_WAIT_MS = 1000/);
  assert.match(captureSource, /quietDelayMs:\s*QUIET_SCAN_DELAY_MS/);
  assert.match(captureSource, /maxWaitMs:\s*MAX_SCAN_WAIT_MS/);
  assert.match(captureSource, /https:\/\/shop\.tiktok\.com/);
  assert.match(captureSource, /\/streamer\/live\/event\/dashboard/);
  assert.doesNotMatch(
    `${captureSource}\n${locatorSource}\n${registrySource}\n${schedulerSource}`,
    /runtime\.sendMessage|tiktok-live-tracker\.reconciliation/,
  );
});
