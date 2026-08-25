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

function assertTextOrder(source, expectedTokens, message) {
  let previousIndex = -1;

  expectedTokens.forEach((token) => {
    const index = source.indexOf(token, previousIndex + 1);

    assert.ok(
      index > previousIndex,
      message ?? `Expected ${token} to follow the preceding layout token.`,
    );
    previousIndex = index;
  });
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
  class FakeCaptureProtocolError extends Error {}
  class FakeCaptureIntegrationError extends Error {}
  class FakeInventoryImportProtocolError extends Error {}
  class FakeGoogleSheetsImportError extends Error {}
  class FakeStreamReportProtocolError extends Error {}
  class FakeStreamReportStorageError extends Error {}
  class FakeStreamReportCoordinatorError extends Error {}
  class FakeLiveBidProtocolError extends Error {}
  class FakeLiveBidStorageError extends Error {}
  class FakeLiveBidCoordinatorError extends Error {}
  class FakeNextItemQueueProtocolError extends Error {}
  class FakeNextItemQueueStorageError extends Error {}
  class FakeNextItemQueueCoordinatorError extends Error {}
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
        OBSERVE_VARIATIONS: "observe_variations",
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
    TikTokLiveTrackerCaptureProtocol: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.capture",
      CaptureProtocolError: FakeCaptureProtocolError,
    },
    TikTokLiveTrackerCaptureIntegration: {
      CaptureIntegrationError: FakeCaptureIntegrationError,
      createCaptureIntegration() {
        return { dispatch: () => Promise.resolve({ status: "accepted" }) };
      },
    },
    TikTokLiveTrackerLiveBidProtocol: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.live-bid",
      LiveBidProtocolError: FakeLiveBidProtocolError,
      createLiveBidChangedNotification() {
        return {
          channel: "tiktok-live-tracker.live-bid",
          version: 1,
          event: { type: "live_bid_changed" },
        };
      },
      isLiveBidChangedNotification() {
        return false;
      },
    },
    TikTokLiveTrackerLiveBidStorage: {
      LiveBidStorageError: FakeLiveBidStorageError,
      createLiveBidStore() {
        return {};
      },
    },
    TikTokLiveTrackerLiveBidCoordinator: {
      LiveBidCoordinatorError: FakeLiveBidCoordinatorError,
      createLiveBidCoordinator() {
        return { dispatch: () => Promise.resolve({ liveAuction: null }) };
      },
    },
    TikTokLiveTrackerNextItemQueueProtocol: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.next-item-queue",
      NextItemQueueProtocolError: FakeNextItemQueueProtocolError,
      createQueueChangedNotification() {
        return {
          channel: "tiktok-live-tracker.next-item-queue",
          version: 1,
          event: { type: "queue_changed" },
        };
      },
      isQueueChangedNotification() {
        return false;
      },
    },
    TikTokLiveTrackerNextItemQueueStorage: {
      NextItemQueueStorageError: FakeNextItemQueueStorageError,
      createNextItemQueueStore() {
        return {};
      },
    },
    TikTokLiveTrackerNextItemQueueCoordinator: {
      NextItemQueueCoordinatorError: FakeNextItemQueueCoordinatorError,
      createNextItemQueueCoordinator() {
        return {
          clearForStream: () => Promise.resolve({ status: "unchanged" }),
          dispatch: () => Promise.resolve({ queuedSku: null }),
        };
      },
    },
    TikTokLiveTrackerInventorySheetImport: {},
    TikTokLiveTrackerInventoryImportProtocol: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.inventory-import",
      COMMAND_TYPES: {
        GET_IMPORT_STATUS: "get_import_status",
        PREVIEW_GOOGLE_SHEET: "preview_google_sheet",
        CONFIRM_GOOGLE_SHEET_IMPORT: "confirm_google_sheet_import",
      },
      InventoryImportProtocolError: FakeInventoryImportProtocolError,
    },
    TikTokLiveTrackerGoogleSheetsInventoryImport: {
      GoogleSheetsInventoryImportError: FakeGoogleSheetsImportError,
      createGoogleSheetsInventoryImportService() {
        return {
          invalidatePreviews() {},
          getImportStatus: () => Promise.resolve({ ready: false }),
          previewGoogleSheet: () => Promise.resolve({ status: "invalid" }),
          confirmGoogleSheetImport: () => Promise.resolve({}),
        };
      },
    },
    TikTokLiveTrackerStreamReport: {},
    TikTokLiveTrackerStreamReportProtocol: {
      MESSAGE_CHANNEL: "tiktok-live-tracker.stream-report",
      COMMAND_TYPES: {
        GET_REPORT: "get_report",
        LIST_REPORTS: "list_reports",
      },
      StreamReportProtocolError: FakeStreamReportProtocolError,
    },
    TikTokLiveTrackerStreamReportStorage: {
      StreamReportStorageError: FakeStreamReportStorageError,
      createStreamReportStore() {
        return {};
      },
    },
    TikTokLiveTrackerStreamReportCoordinator: {
      StreamReportCoordinatorError: FakeStreamReportCoordinatorError,
      createStreamReportCoordinator() {
        return {
          dispatch: () => Promise.resolve({}),
          finalizeReport: () => Promise.resolve({}),
          getReportForStream: () => Promise.resolve(null),
          prepareReport: () => Promise.resolve({}),
          repairPendingReports: () => Promise.resolve(),
        };
      },
    },
    AbortController,
    clearTimeout,
    fetch: () => Promise.reject(new Error("Network is not used in this test.")),
    setTimeout,
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
        session: {
          setAccessLevel() {
            return Promise.resolve();
          },
        },
      },
      runtime: {
        id: "extension-id",
        getURL: (pathName) => `chrome-extension://extension-id/${pathName}`,
        getManifest: () => ({ oauth2: { client_id: "test.apps.googleusercontent.com" } }),
        onMessage: { addListener() {} },
      },
      identity: {},
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
    "../shared/reconciliation.js",
    "../shared/reconciliation-coordinator.js",
    "../shared/stream-session-coordinator.js",
    "../shared/inventory-import-protocol.js",
    "../shared/stream-report-protocol.js",
    "../shared/live-bid-protocol.js",
    "../shared/next-item-queue-protocol.js",
    "reconciliation-client.js",
    "stream-session-client.js",
    "stream-session-controller.js",
    "inventory-import-client.js",
    "inventory-import-controller.js",
    "live-bid-client.js",
    "next-item-queue-client.js",
    "../shared/tiktok-fee-calculator.js",
    "inventory-view-model.js",
    "live-auction-view-model.js",
    "variation-selector-view-model.js",
    "variation-selector-lock.js",
    "mapping-workflow.js",
    "persistent-tagger-controller.js",
    "../shared/stream-report.js",
    "../report/stream-report-client.js",
    "sidepanel.js",
  ]);
  assert.ok(
    resourcePaths.every((relativePath) =>
      fs.existsSync(path.join(panelDirectory, relativePath)),
    ),
  );
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
});

test("side panel exposes accessible Live lifecycle controls", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const headerSource = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0];
  const footerSource = html.match(
    /<footer class="app-footer"[\s\S]*?<\/footer>/,
  )?.[0];

  assert.ok(headerSource);
  assert.ok(footerSource);
  assert.match(html, /<label[^>]+for="inventory-search"/);
  assert.match(html, /id="variation-selector-label"[^>]+visually-hidden/);
  assert.doesNotMatch(headerSource, /<button/);
  assert.doesNotMatch(headerSource, /prototype-badge|>\s*Prototype\s*</);
  assert.doesNotMatch(
    html,
    /id="saved-session-mode"|class="mode-panel"|class="mode-controls"|aria-label="Tracker mode"/,
  );
  assert.doesNotMatch(html, /Choose where changes go|>\s*Workspace\s*</);
  assert.doesNotMatch(html, /id="saved-session-status(?:-text)?"/);
  assert.match(footerSource, /role="status"/);
  assert.match(footerSource, /aria-live="polite"/);
  assert.match(footerSource, /aria-atomic="true"/);
  assert.match(footerSource, /id="session-footer-label"/);
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
  assert.match(
    html,
    /id="stream-session-end-confirmation"[\s\S]+aria-labelledby="stream-session-end-title"[\s\S]+End and create the stream report\?/,
  );
  assert.match(
    html,
    /id="end-report-readiness"[\s\S]+role="status"[\s\S]+aria-live="polite"/,
  );
  assert.match(html, />\s*Keep stream active\s*</);
  assert.match(html, />\s*End and create report\s*</);
  assert.match(html, /id="end-stream-without-report"[\s\S]+End without report/);
  assert.match(html, /id="retry-stream-session"[\s\S]+type="button"/);
  assert.match(
    html,
    /id="inventory-import-panel"[\s\S]+aria-busy="true"/,
  );
  assert.match(html, /<label[^>]+for="inventory-sheet-reference"/);
  assert.match(
    html,
    /id="inventory-sheet-reference"[\s\S]+aria-describedby="inventory-sheet-help inventory-sheet-error"/,
  );
  assert.match(
    html,
    /id="inventory-import-progress"[\s\S]+role="status"[\s\S]+tabindex="-1"[\s\S]+aria-live="polite"/,
  );
  assert.match(
    html,
    /id="inventory-import-error"[\s\S]+role="alert"[\s\S]+tabindex="-1"/,
  );
  assert.match(html, /id="retry-inventory-import"[^>]+type="button"/);
  assert.match(html, /id="inventory-import-issues"/);
  assert.match(html, /id="inventory-import-preview"[^>]+hidden/);
  assert.match(html, /id="inventory-preview-rows"/);
  assert.match(html, /id="confirm-inventory-import"[^>]+type="button"/);
  assert.match(
    html,
    /opening quantities match the physical stock[\s\S]+immutable baseline for future[\s\S]+does not change earlier streams/i,
  );
  assert.match(
    html,
    /id="inventory-import-confirmation"[\s\S]+role="status"[\s\S]+tabindex="-1"[\s\S]+aria-live="polite"/,
  );
  assert.match(html, /do not[\s\S]+start or end TikTok LIVE/i);
  assert.match(html, /Waiting for a live auction variation/);
  assert.match(
    html,
    /Unresolved\s+variations never block End/i,
  );
  assert.match(html, /freeze a local business report before ending/i);
  assert.match(html, /appear in its attention list/i);
  const endConfirmation = html.match(
    /id="stream-session-end-confirmation"[\s\S]*?id="stream-session-error"/,
  )?.[0];
  assert.ok(endConfirmation);
  assert.doesNotMatch(endConfirmation, /\b(?:final|provisional)\b/i);
  assert.match(
    html,
    /id="stream-reports-panel"[\s\S]+aria-labelledby="stream-reports-title"[\s\S]+aria-busy="true"[\s\S]+hidden/,
  );
  assert.match(html, /id="stream-reports-title">Stream reports</);
  assert.match(html, /id="stream-reports-count"[\s\S]+0 saved/);
  assert.match(html, /print or save it as a PDF[\s\S]+updated Inventory table[\s\S]+Google Sheets-ready CSV/i);
  assert.match(
    html,
    /Limit of 5 reports on this dashboard, older reports will go to archived[\s\S]+once the limit is reached/,
  );
  assert.match(html, /id="stream-reports-list"[\s\S]+role="list"/);
  assert.match(
    html,
    /id="stream-reports-error"[\s\S]+role="alert"[\s\S]+tabindex="-1"/,
  );
  assert.match(html, /id="retry-stream-reports"[^>]+type="button"/);
  assert.doesNotMatch(
    html,
    /resolve every pending[\s\S]+inventory reservation[\s\S]+assign an item to every completed sale/i,
  );
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
    /id="variation-selector"[^>]+role="combobox"[^>]+aria-expanded="false"[^>]+aria-haspopup="listbox"[^>]+aria-controls="variation-listbox"[^>]+aria-labelledby="variation-selector-label variation-selector-value"[^>]+aria-describedby="variation-context"/,
  );
  assert.match(
    html,
    /id="variation-listbox"[^>]+role="listbox"[^>]+aria-labelledby="variation-selector-label"[^>]+popover="manual"/,
  );
  assert.match(
    html,
    /id="return-to-current"[^>]+type="button"[^>]+hidden/,
  );
  assert.match(html, /id="result-count"[^>]+aria-live="polite"/);
  assert.match(html, /id="inventory-grid"[^>]+role="list"/);
  assert.match(html, /class="inventory-card-wrapper"[^>]+role="listitem"/);
  assert.match(html, /<button class="inventory-card"[^>]+aria-pressed="false"/);
  assert.match(
    html,
    /data-field="stock"[\s\S]+data-field="stock-primary"[\s\S]+data-field="stock-secondary"[\s\S]+hidden/,
  );
  assert.match(
    html,
    /Selecting an item reserves one unit until TikTok reports Payment[\s\S]+complete or Canceled\.[\s\S]+Temporary Payment failed remains pending\.[\s\S]+Zero-stock items remain selectable[\s\S]+oversold\./,
  );
  assert.match(html, /id="pending-mapping"/);
  assert.match(html, /id="auction-eyebrow"[^>]*>Live order status</);
  assert.match(html, /id="mapping-announcement"[\s\S]+role="status"/);
  assert.match(html, /id="state-warning"[^>]+role="status"/);
  assert.match(html, /id="auction-status"[^>]+tabindex="-1"/);
  assert.match(html, /<dt>TikTok payment<\/dt>/);
  assert.match(
    html,
    /id="tiktok-payment-status"[\s\S]+data-payment-status="not_observed"/,
  );
  assert.match(html, /data-field="observed-payment-status"[\s\S]+Payment not yet observed/);
  assert.match(html, /id="payment-price"[^>]+hidden/);
  assert.match(html, /<dt>Inventory tag<\/dt>/);
  assert.match(html, /data-field="mapping-status"[\s\S]+No item selected/);
  assert.match(html, /data-field="gross-profit"/);
  assert.match(html, />\s*Live session\s*</);
  assert.doesNotMatch(html, /id="change-mapping"/);
  assert.doesNotMatch(html, />\s*Change item\s*</);
});

test("active streams expose an append-only Google Sheets inventory action", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );
  const actionSource = panelSource.match(
    /addActiveStreamSkusButton\.addEventListener\("click",[\s\S]*?inventorySheetReference\.addEventListener\("input"/,
  )?.[0];

  assert.ok(actionSource);
  assert.match(
    html,
    /id="add-active-stream-skus"[\s\S]+aria-expanded="false"[\s\S]+aria-controls="active-stream-inventory-update-form"[\s\S]+Add new SKUs from Sheet/,
  );
  assert.match(
    html,
    /id="active-stream-inventory-update-form"[\s\S]+aria-busy="false"[\s\S]+novalidate[\s\S]+hidden/,
  );
  assert.match(
    html,
    /Only[\s\S]+brand-new SKU rows will be added[\s\S]+opening quantity[\s\S]+unit cost must remain unchanged[\s\S]+variations and mappings will be preserved/i,
  );
  assert.match(
    html,
    /id="active-stream-inventory-update-error"[\s\S]+role="alert"[\s\S]+hidden/,
  );
  assert.match(
    html,
    /id="active-stream-inventory-update-feedback"[\s\S]+role="status"[\s\S]+aria-live="polite"[\s\S]+aria-atomic="true"[\s\S]+hidden/,
  );
  assert.match(actionSource, /inventoryImportClient\s*\.addActiveStreamSkusReference\(reference\)/);
  assert.match(actionSource, /refreshedSnapshot = await mountedController\.refresh\(\)/);
  assert.match(
    actionSource,
    /refreshedSnapshot\?\.phase !== "ready"[\s\S]+refreshedSnapshot\?\.operation !== "refresh"/,
  );
  assert.match(
    actionSource,
    /Added \$\{addedSkus\.length\} new[\s\S]+Existing variations and mappings were preserved/,
  );
  assert.match(actionSource, /No new SKUs were found\. Nothing changed\./);
  assert.match(actionSource, /outcomeUncertain/);
  assert.match(
    panelSource,
    /The inventory update could not be confirmed\.[\s\S]+Refresh or retry; retrying is safe\./,
  );
  assert.match(panelSource, /No SKUs were added\. \$\{message\}/);
  assert.match(
    panelSource,
    /const available =\s*streamSnapshot\.activeSession !== null &&\s*streamSnapshot\.resumed === true &&\s*persistentController !== null &&\s*savedSnapshot\?\.view !== null/,
  );
  assert.match(
    panelSource,
    /addActiveStreamSkusButton\.disabled\s*=\s*activeStreamInventoryUpdateBusy \|\| !available/,
  );
  assert.match(
    panelSource,
    /activeStreamInventorySheetReference\.disabled\s*=\s*activeStreamInventoryUpdateBusy/,
  );
  assert.doesNotMatch(
    panelSource,
    /setWorkspaceBusy\(activeStreamInventoryUpdateBusy\)/,
  );
  assert.match(
    panelSource,
    /const activeInventoryUpdateRefresh =\s*activeStreamInventoryUpdateBusy &&\s*snapshotIsBackgroundRefresh\(savedSnapshot\)[\s\S]+Boolean\(busy\) && !activeInventoryUpdateRefresh/,
  );
  assert.match(
    styleSource,
    /\.active-stream-inventory-update-form\s*\{[\s\S]*?border:[\s\S]*?border-radius:[\s\S]*?background:/,
  );
});

test("variation picker keeps its compact layout while coloring status segments", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );

  assert.match(
    panelSource,
    /function createVariationOptionContent\(display\)[\s\S]+variation-option-number[\s\S]+variation-option-status[\s\S]+display\.paymentTone[\s\S]+variation-option-item[\s\S]+display\.itemTone/,
  );
  assert.match(
    styleSource,
    /#variation-selector\s*\{[\s\S]*?min-height: 44px;[\s\S]*?border-radius: 10px;/,
  );
  assert.match(
    styleSource,
    /\.variation-option-status\[data-tone="warning"\]\s*\{[\s\S]*?color: #ffd88a;/,
  );
  assert.match(
    styleSource,
    /\.variation-option-status\[data-tone="danger"\]\s*\{[\s\S]*?color: #ffb1b7;/,
  );
  assert.match(
    styleSource,
    /\.variation-option-status\[data-tone="success"\],[\s\S]+\.variation-option-item\[data-tone="success"\]\s*\{[\s\S]*?color: #9df0df;/,
  );
  assert.match(
    styleSource,
    /\.variation-option-item\[data-tone="unselected"\]\s*\{[\s\S]*?color: #ffad5c;/,
  );
  assert.match(
    styleSource,
    /\.variation-listbox\s*\{[\s\S]*?position: fixed;[\s\S]*?max-height:[\s\S]*?overflow-y: auto;/,
  );
  assert.match(
    styleSource,
    /\.variation-option-item\s*\{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;/,
  );
});

test("side panel keeps setup and active-stream controls in their intended order", () => {
  const panelPath = path.join(
    extensionDirectory,
    manifest.side_panel.default_path,
  );
  const html = fs.readFileSync(panelPath, "utf8");
  const panelSource = fs.readFileSync(
    path.join(path.dirname(panelPath), "sidepanel.js"),
    "utf8",
  );
  const reorderSource = panelSource.match(
    /function reorderAppSections\(sections\) \{[\s\S]*?\n  \}/,
  )?.[0];
  const layoutSource = panelSource.match(
    /function updateLayoutOrder\(snapshot = streamSnapshot\) \{[\s\S]*?\n  \}/,
  )?.[0];
  const activeBranches = layoutSource?.match(
    /streamFailed\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[([\s\S]*?)\]/,
  );
  const setupBranch = layoutSource?.match(
    /return;\s*\}\s*reorderAppSections\(\[([\s\S]*?)\]\);/,
  )?.[1];

  assert.ok(reorderSource);
  assert.ok(layoutSource);
  assert.ok(activeBranches);
  assert.ok(setupBranch);
  assert.match(
    layoutSource,
    /snapshot\.activeSession !== null && snapshot\.resumed === true/,
  );
  assertTextOrder(setupBranch, ["inventoryImportPanel", "streamSessionPanel"]);
  assertTextOrder(activeBranches[1], [
    "savedSessionError",
    "streamSessionPanel",
    "trackerWorkspace",
    "streamReportsPanel",
    "appFooter",
  ]);
  assertTextOrder(activeBranches[2], [
    "savedSessionError",
    "trackerWorkspace",
    "streamSessionPanel",
    "streamReportsPanel",
    "appFooter",
  ]);
  assert.equal(activeBranches[1].trim().endsWith("appFooter,"), true);
  assert.equal(activeBranches[2].trim().endsWith("appFooter,"), true);
  assert.match(
    reorderSource,
    /appShell\.insertBefore\(section, mappingAnnouncement \?\? null\)/,
  );
  assert.doesNotMatch(
    reorderSource,
    /trackerWorkspace\.(?:append|appendChild|insertBefore)/,
  );
  assert.match(
    panelSource,
    /function renderStreamSnapshot\(snapshot\) \{[\s\S]*?streamSnapshot = snapshot;[\s\S]*?updateLayoutOrder\(snapshot\);/,
  );
  assertTextOrder(html, [
    'id="stream-reports-panel"',
    'id="archived-reports-view"',
    'id="report-action-confirmation"',
    '<footer class="app-footer"',
  ]);
  assert.doesNotMatch(panelSource, /savedSessionStatus(?:Text)?/);
});

test("active stream compacts its session controls without changing other lifecycle states", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );
  const sessionMarkup = html.match(
    /<section\s+id="stream-session-panel"[\s\S]*?<\/section>/,
  )?.[0];
  const renderSource = panelSource.match(
    /function renderStreamSnapshot\(snapshot\) \{[\s\S]*?function announceSavedAction/,
  )?.[0];
  const activeHideRule = styleSource.match(
    /\.stream-session-panel\[data-state="active"\] \.stream-session-heading,\s*\.stream-session-panel\[data-state="active"\] \.stream-session-safety-note\s*\{[\s\S]*?\}/,
  )?.[0];

  assert.ok(sessionMarkup);
  assert.ok(renderSource);
  assert.ok(activeHideRule);
  assert.match(sessionMarkup, /class="stream-session-heading"/);
  assert.match(sessionMarkup, /id="stream-session-safety-note"/);
  assert.match(sessionMarkup, /id="stream-session-status-title"/);
  assert.match(sessionMarkup, /id="stream-session-status-message"/);
  assert.match(
    sessionMarkup,
    /id="end-stream"[\s\S]*?>\s*End Stream Tracking\s*<\/button>/,
  );
  assert.match(
    renderSource,
    /const active = activeSession !== null && snapshot\.resumed;/,
  );
  assert.match(
    renderSource,
    /const dataState = failed[\s\S]*?: active[\s\S]*?\? "active"[\s\S]*?: resumeAvailable[\s\S]*?\? "resume"[\s\S]*?: "inactive"/,
  );
  assert.match(
    renderSource,
    /const badgeContainer = dataState === "active"\s*\? streamSessionStatus\s*:\s*streamSessionHeading;/,
  );
  assert.match(
    renderSource,
    /if \(streamSessionBadge\.parentElement !== badgeContainer\) \{\s*badgeContainer\.append\(streamSessionBadge\);\s*\}/,
  );
  assert.match(renderSource, /streamSessionBadge\.textContent = "Active";/);
  assert.match(renderSource, /streamSessionStatusTitle\.textContent = "Tracker stream active";/);
  assert.match(
    renderSource,
    /streamSessionStatusMessage\.textContent =\s*`Started \$\{startedLabel\}\. This local identity will survive panel and browser restarts\.`;/,
  );
  assert.match(activeHideRule, /display:\s*none;/);
  assert.match(
    styleSource,
    /\.stream-session-status > \.stream-session-badge\s*\{[\s\S]*?margin-left:\s*auto;/,
  );
  assert.match(
    styleSource,
    /\.stream-session-panel\[data-state="active"\] \.stream-session-status\s*\{[\s\S]*?margin-top:\s*0;/,
  );
  assert.doesNotMatch(
    styleSource,
    /\.stream-session-panel\[data-state="(?:inactive|resume|error|checking)"\][^{]*(?:stream-session-heading|stream-session-safety-note)[^{]*\{[\s\S]*?display:\s*none;/,
  );
});

test("tagger UI routes employee changes through persistent Live commands", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const workflowSource = fs.readFileSync(
    path.join(taggerDirectory, "mapping-workflow.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );
  const mappingSource = `${panelSource}\n${workflowSource}`;
  const inventoryClickHandler = panelSource.match(
    /inventoryGrid\.addEventListener\("click",[\s\S]*?searchInput\.addEventListener\("input"/,
  )?.[0];

  assert.ok(inventoryClickHandler);
  assert.match(
    panelSource,
    /button\.disabled = !entry\.selectionAllowed \|\| !canTagSelectedVariation/,
  );
  assert.match(
    panelSource,
    /const stockAriaLabel = stock\.ariaLabel \?\? stock\.label/,
  );
  assert.match(
    panelSource,
    /\[data-field="stock-primary"\]'\)\.textContent =[\s\S]+stock\.primaryLabel \?\? stock\.label/,
  );
  assert.match(
    panelSource,
    /\[data-field="stock-secondary"\]'[\s\S]+secondaryStockLabel\.textContent = stock\.secondaryLabel \?\? ""[\s\S]+secondaryStockLabel\.hidden = !stock\.secondaryLabel/,
  );
  assert.match(
    panelSource,
    /setAttribute\([\s\S]+"aria-label"[\s\S]+\$\{stockAriaLabel\}/,
  );
  assert.match(
    styleSource,
    /\.size-label\s*{[\s\S]*?flex-direction: column;[\s\S]*?}[\s\S]+\.stock-label\s*{[\s\S]*?flex-direction: column;/,
  );
  assert.match(styleSource, /\.stock-line\s*{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(panelSource, /function renderVariationNavigation\(view\)/);
  assert.match(
    panelSource,
    /function selectVariationFromPicker\(selectedVariationNumber\)[\s\S]+persistentController\.selectVariation/,
  );
  assert.match(
    panelSource,
    /returnToCurrentButton\.addEventListener\("click",[\s\S]+persistentController\.selectVariation\([\s\S]+currentView\.currentVariationNumber/,
  );
  assert.match(
    panelSource,
    /const reviewingRecordedHistory =[\s\S]+variations\.length > 0 && view\.isReviewingHistory/,
  );
  assert.match(
    panelSource,
    /returnToCurrentButton\.hidden = !reviewingRecordedHistory;[\s\S]+returnToCurrentButton\.textContent = "Return to live item"/,
  );
  assert.match(
    panelSource,
    /findVariationOption\([\s\S]+currentView\.currentVariationNumber[\s\S]+returnVariation\?\.recorded/,
  );
  assert.match(
    panelSource,
    /The next live auction will open automatically\./,
  );
  assert.match(
    styleSource,
    /\.return-to-current-live\s*\{[\s\S]*?min-height: 34px;[\s\S]*?font-size: 10px;/,
  );
  assert.match(panelSource, /view\.selectedVariationNumber/);
  assert.match(panelSource, /setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(panelSource, /Click to unselect this item/);
  assert.match(
    panelSource,
    /No item selected\. Select the matching inventory entry below\./,
  );
  assert.match(panelSource, /const auction = view\.auction/);
  assert.match(panelSource, /persistentController\.mapSelectedSku/);
  assert.match(panelSource, /persistentController\.unmapSelectedVariation/);
  assert.match(panelSource, /type: selected \? "unmap_variation" : "map_variation"/);
  assert.doesNotMatch(
    inventoryClickHandler,
    /paymentStatus === "canceled"|is read-only/,
  );
  assert.match(workflowSource, /reconciliation\.unmapVariation\(state, auctionKey\(\)\)/);
  assert.doesNotMatch(panelSource, /persistentController\.markSelectedUnpaid/);
  assert.doesNotMatch(panelSource, /persistentController\.undoSelectedUnpaid/);
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
  const startHandlerSource = panelSource.match(
    /startStreamButton\.addEventListener\("click",[\s\S]*?resumeStreamButton\.addEventListener/,
  )?.[0];
  assert.ok(startHandlerSource);
  assert.match(startHandlerSource, /isInventoryReadyForStart\(\)/);
  assert.match(startHandlerSource, /streamSessionController\.startNewStream\(\)/);
  assert.doesNotMatch(
    startHandlerSource,
    /ensureInventoryInitialized|LEGACY_RECOVERY_INVENTORY/,
  );
  assert.match(panelSource, /streamSessionController\.startNewStream\(\)/);
  assert.match(panelSource, /streamSessionController\.resumeActiveStream\(\)/);
  assert.match(panelSource, /streamSessionController\.endActiveStream\(\)/);
  assert.match(panelSource, /streamSessionController\.retry\(\)/);
  assert.doesNotMatch(panelSource, /function getEndBlockingVariations\(\)/);
  assert.match(panelSource, /getRecordedVariations\(view\)/);
  assert.match(panelSource, /variation\.recorded/);
  assert.match(panelSource, /Waiting for live auction variations/);
  assert.match(panelSource, /variationContext\.textContent = "Live auction variations"/);
  assert.match(
    panelSource,
    /variationSelectorViewModel\.createOptionDisplay\(option,[\s\S]+formatItemName/,
  );
  assert.match(
    panelSource,
    /Variation #\$\{activeBiddingVariation\.variationNumber\} is now bidding\. It is selected and ready to tag\./,
  );
  assert.match(panelSource, /Wait for a live auction variation before tagging/);
  assert.doesNotMatch(panelSource, /Prototype tagger current|live queue not connected/);
  assert.doesNotMatch(
    panelSource,
    /savedModeButton|#saved-session-mode|modeDescription|#mode-description/,
  );
  assert.doesNotMatch(
    styleSource,
    /\.prototype-badge/,
  );
  assert.match(
    panelSource,
    /trackerWorkspace\.toggleAttribute\("inert", shouldBeInert\)/,
  );
  assert.match(panelSource, /savedSnapshot\?\.phase === "error"/);
  assert.match(
    panelSource,
    /savedSnapshot\?\.phase === "error"\s*\|\|\s*endConfirmationOpen/,
  );
  assert.match(panelSource, /persistentController === null \|\| savedSnapshot\?\.phase !== "ready"/);
  assert.match(
    panelSource,
    /retryStreamSessionButton\.addEventListener\("click",[\s\S]+streamSessionStatus\.hidden = false;[\s\S]+streamSessionError\.hidden = true;[\s\S]+streamSessionStatus\.focus\(\)/,
  );
  assert.match(
    panelSource,
    /const RECOVERABLE_STREAM_BASELINE_ERROR_CODES = new Set\(\[[\s\S]+"STATE_NOT_INITIALIZED"[\s\S]+"INVENTORY_BASELINE_REQUIRED"/,
  );
  assert.match(
    panelSource,
    /function shouldPrepareInventoryForStreamRetry\(snapshot\) \{[\s\S]+snapshot\?\.error\?\.scope === "load"[\s\S]+RECOVERABLE_STREAM_BASELINE_ERROR_CODES\.has\(snapshot\.error\.code\)/,
  );
  const streamRetrySource = panelSource.match(
    /retryStreamSessionButton\.addEventListener\("click",[\s\S]*?retrySavedSessionButton\.addEventListener/,
  )?.[0];
  assert.ok(streamRetrySource);
  assert.match(
    streamRetrySource,
    /shouldPrepareInventoryForStreamRetry\(streamSnapshot\)/,
  );
  assert.match(
    panelSource,
    /inventoryImportControllerModule\.createInventoryImportController/,
  );
  assert.match(
    panelSource,
    /inventoryImportController\.subscribe\(renderInventoryImportSnapshot\)/,
  );
  assert.match(panelSource, /inventoryImportController\.previewReference/);
  assert.match(panelSource, /inventoryImportController\.confirmPreview/);
  assert.match(panelSource, /inventoryImportController\.retry/);
  assert.match(panelSource, /REPREVIEW_REQUIRED_ERROR_CODES/);
  assert.match(
    panelSource,
    /inventoryImportForm\.toggleAttribute\("inert", busy\)/,
  );
  assert.match(
    panelSource,
    /inventoryImportPreview\.toggleAttribute\("inert", busy\)/,
  );
  assert.match(panelSource, /cell\.textContent = value/);
  assert.doesNotMatch(panelSource, /innerHTML\s*=/);
  assert.match(
    streamRetrySource,
    /if \(!prepareMissingInventory\) \{[\s\S]+return null;[\s\S]+persistentTaggerControllerModule\.ensureInventoryInitialized\(\{[\s\S]+client: persistentClient,[\s\S]+inventory: viewModel\.LEGACY_RECOVERY_INVENTORY/,
  );
  assert.ok(
    streamRetrySource.indexOf(
      "persistentTaggerControllerModule.ensureInventoryInitialized",
    ) < streamRetrySource.indexOf("streamSessionController.retry()"),
    "a missing baseline must initialize before retry reissues the saved stream GET",
  );
  assert.match(panelSource, /savedSessionError\.focus\(\)/);
  assert.match(panelSource, /pendingSavedAction \|\| savedSnapshot\?\.busy/);
  assert.doesNotMatch(panelSource, /persistentController\.[^(]*Payment/);
  assert.match(workflowSource, /action = "completed_sale_mapped"/);
  assert.match(workflowSource, /canceled: "Canceled"/);
  assert.match(workflowSource, /selectionAllowed: true/);
  assert.doesNotMatch(workflowSource, /CANCELED_VARIATION_IMMUTABLE/);
  assert.doesNotMatch(workflowSource, /"SOLD_OUT"|"NO_STOCK_AVAILABLE"/);
  assert.doesNotMatch(workflowSource, /"canceled_order_mapped"|"canceled_mapping_corrected"/);
  assert.doesNotMatch(
    panelSource,
    /Payment is complete, but this variation still needs an inventory item\./,
  );
  assert.doesNotMatch(
    panelSource,
    /warnings\.some\([\s\S]+unmapped_completed_sale/,
  );
  assert.doesNotMatch(panelSource, /changeMappingButton|#change-mapping/);
  assert.match(panelSource, /function renderOrderStatuses\(auction\)/);
  assert.match(panelSource, /observedPaymentStatus\.textContent = observedLabel/);
  assert.match(
    panelSource,
    /tiktokPaymentStatus\.dataset\.paymentStatus = safeObservedStatus/,
  );
  assert.match(panelSource, /paymentPrice\.hidden = !hasCapturedPrice/);
  assert.match(panelSource, /mappingStatus\.textContent = getInventoryTagLabel\(auction\)/);
  assert.match(
    panelSource,
    /auction\.paymentStatus === "payment_complete"/,
  );
  assert.match(workflowSource, /"Payment status unavailable"/);
  assert.match(workflowSource, /mapped: "Item selected"/);
  assert.match(panelSource, /"Sale assigned"/);
  assert.match(panelSource, /"Item selected"/);
  assert.match(panelSource, /\? "Pending"[\s\S]+: "Item selected"/);
  assert.match(
    panelSource,
    /function isInventoryReservationPending\(auction\)[\s\S]+auction\?\.status === "pending"/,
  );
  assert.match(
    panelSource,
    /function isObservedCompletionAwaitingPrice\(auction\)/,
  );
  assert.match(panelSource, /"Final price syncing - item selected"/);
  assert.doesNotMatch(panelSource, /Final price syncing - item reserved/);
  assert.match(
    panelSource,
    /TikTok shows Payment complete, but the final price is still syncing\./,
  );
  assert.match(panelSource, /remains reserved and pending/);
  assert.match(
    panelSource,
    /"Canceled · reference item selected · no inventory change"/,
  );
  assert.match(panelSource, /"Canceled · no reference item selected"/);
  assert.match(panelSource, /selectedLabel\.textContent = "Canceled item"/);
  assert.match(panelSource, /Click to unselect this reference item/);
  assert.match(
    panelSource,
    /Select an item only to record what was auctioned; mapping, changing, or clearing it will not affect inventory or metrics/,
  );
  assert.match(
    panelSource,
    /You can still select a reference item without changing inventory or metrics/,
  );
  assert.match(
    panelSource,
    /Canceled variation \$\{variationNumber\} reference item saved locally\. Inventory and metrics were not changed/,
  );
  assert.match(
    panelSource,
    /Canceled variation \$\{variationNumber\} reference item cleared locally\. Inventory and metrics were not changed/,
  );
  assert.doesNotMatch(panelSource, /dataset\.lockedReason/);
  assert.doesNotMatch(styleSource, /data-locked-reason="canceled"/);
  assert.match(
    panelSource,
    /const canceled = view\.auction\?\.paymentStatus === "canceled"/,
  );
  assert.doesNotMatch(panelSource, /payment_completed_after_canceled/);
  assert.doesNotMatch(
    panelSource,
    /Canceled variation \$\{view\.selectedVariationNumber\} is read-only/,
  );
  assert.match(
    workflowSource,
    /not_observed: "Payment not yet observed"[\s\S]+payment_processing: "Payment processing"[\s\S]+payment_fixing: "Payment fixing"[\s\S]+payment_failed: "Payment failed"[\s\S]+canceled: "Canceled"[\s\S]+payment_complete: "Payment complete"[\s\S]+unrecognized: "Unrecognized payment status"/,
  );
  assert.match(panelSource, /"payment_failed",[\s\S]+"canceled",/);
  assert.match(
    styleSource,
    /data-payment-status="payment_fixing"\],[\s\S]+data-payment-status="payment_failed"\][\s\S]+color: #ffd88a/,
  );
  assert.match(
    styleSource,
    /data-payment-status="canceled"\][\s\S]+color: #ffb1b7[\s\S]+data-payment-status="canceled"\] \.pending-status-dot[\s\S]+background: #ff737e/,
  );
  assert.match(panelSource, /stateWarning\.textContent !== warning/);
  assert.doesNotMatch(panelSource, /this pending mapping/);
  assert.doesNotMatch(mappingSource, /undoPaymentComplete/);
  assert.doesNotMatch(
    mappingSource,
    /chrome\.storage|sendMessage|\bfetch\s*\(|sheets\.googleapis|completed_sale_detected/,
  );
});

test("inventory right click maps the current variation from history without changing its queue", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );
  const queueUiSource = panelSource.match(
    /function saveOrdinaryInventorySelection\(button, view\)[\s\S]*?searchInput\.addEventListener\("input"/,
  )?.[0];
  const leftClickSource = panelSource.match(
    /inventoryGrid\.addEventListener\("click",[\s\S]*?inventoryGrid\.addEventListener\("contextmenu"/,
  )?.[0];
  const contextMenuSource = panelSource.match(
    /inventoryGrid\.addEventListener\("contextmenu",[\s\S]*?\n  \}\);/,
  )?.[0];
  const queueMutationSource = panelSource.match(
    /async function toggleNextItemQueue\(button, view\)[\s\S]*?\n  \}/,
  )?.[0];
  const historyMappingSource = panelSource.match(
    /async function mapCurrentVariationFromHistory\(button, view\)[\s\S]*?\n  \}/,
  )?.[0];
  const currentVariationMappedSkuSource = panelSource.match(
    /function getCurrentVariationMappedSku\(view\)[\s\S]*?\n  \}/,
  )?.[0];

  assert.ok(queueUiSource);
  assert.ok(leftClickSource);
  assert.ok(contextMenuSource);
  assert.ok(queueMutationSource);
  assert.ok(historyMappingSource);
  assert.ok(currentVariationMappedSkuSource);
  assert.match(
    html,
    /src="\.\.\/shared\/next-item-queue-protocol\.js"[\s\S]+src="next-item-queue-client\.js"[\s\S]+src="sidepanel\.js"/,
  );
  assert.match(
    panelSource,
    /createNextItemQueueClient\(\{[\s\S]+runtime: chrome\.runtime,[\s\S]+protocol: nextItemQueueProtocol/,
  );
  assert.match(
    contextMenuSource,
    /if \(!button \|\| !inventoryGrid\.contains\(button\)\) \{[\s\S]+return;[\s\S]+event\.preventDefault\(\)/,
  );
  assert.match(
    contextMenuSource,
    /view\.isReviewingHistory[\s\S]+view\.selectedVariationNumber !== view\.currentVariationNumber[\s\S]+void mapCurrentVariationFromHistory\(button, view\)[\s\S]+return;[\s\S]+void toggleNextItemQueue\(button, view\)/,
  );
  assert.doesNotMatch(
    contextMenuSource,
    /saveOrdinaryInventorySelection|mapSelectedSku|unmapSelectedVariation|selectVariation/,
  );
  assert.doesNotMatch(contextMenuSource, /view\.auction/);
  assert.match(leftClickSource, /saveOrdinaryInventorySelection\(button, view\)/);
  assert.doesNotMatch(leftClickSource, /toggleNextItemQueue|toggleQueue/);
  assert.match(
    queueMutationSource,
    /nextItemQueueClient\.toggleQueue\(\{[\s\S]+expectedStreamId,[\s\S]+expectedVariationNumber,[\s\S]+sku/,
  );
  assert.match(
    queueMutationSource,
    /const expectedVariationNumber = view\.currentVariationNumber/,
  );
  assert.match(
    queueMutationSource,
    /response\.status === "mapped_current"[\s\S]+Variation #\$\{expectedVariationNumber\} mapped to[\s\S]+scheduleCaptureRefresh\(\)/,
  );
  assert.doesNotMatch(
    queueMutationSource,
    /mapSelectedSku|unmapSelectedVariation|selectVariation|setWorkspaceBusy/,
  );
  assert.match(
    historyMappingSource,
    /nextItemQueueClient\.mapCurrent\(\{[\s\S]+expectedStreamId,[\s\S]+expectedVariationNumber,[\s\S]+sku/,
  );
  assert.match(
    historyMappingSource,
    /response\.status === "unmapped_current"[\s\S]+was unselected from current variation #\$\{expectedVariationNumber\}\. Variation #\$\{historicalVariationNumber\} remains open\.[\s\S]+was mapped to current variation #\$\{expectedVariationNumber\}\. Variation #\$\{historicalVariationNumber\} remains open\.[\s\S]+scheduleCaptureRefresh\(\)/,
  );
  assert.doesNotMatch(historyMappingSource, /response\.status === "unchanged"/);
  assert.doesNotMatch(
    historyMappingSource,
    /toggleQueue|getQueue|queuedNextItemSku|scheduleNextItemQueueRefresh|mapSelectedSku|unmapSelectedVariation|selectVariation/,
  );
  assert.match(
    panelSource,
    /function isCurrentVariationMapped\(view\)[\s\S]+view\.currentVariationNumber[\s\S]+findVariationOption/,
  );
  assert.match(
    panelSource,
    /Right-click to select this item for current variation \$\{view\.currentVariationNumber\}/,
  );
  assert.match(
    panelSource,
    /Right-click to unmap it from current variation \$\{view\.currentVariationNumber\}/,
  );
  assert.doesNotMatch(
    panelSource,
    /Right-clicking it again keeps that current mapping unchanged/,
  );
  assert.match(
    panelSource,
    /Variation \$\{view\.selectedVariationNumber\} will remain open/,
  );
  assert.match(panelSource, /nextItemQueueClient\.getQueue\(\)/);
  assert.match(
    panelSource,
    /nextItemQueueProtocol\.isQueueChangedNotification\(message\)[\s\S]+scheduleNextItemQueueRefresh\(\)/,
  );
  assert.match(
    panelSource,
    /function unmountPersistentController\(\)[\s\S]+resetNextItemQueueDisplay\(\)/,
  );
  assert.match(
    panelSource,
    /function mountPersistentController\(activeSession\)[\s\S]+scheduleNextItemQueueRefresh\(\)/,
  );
  assert.match(panelSource, /button\.dataset\.queued = String\(queued\)/);
  assert.match(
    panelSource,
    /button\.dataset\.currentMapped = String\(mappedToCurrent\)/,
  );
  assert.match(
    currentVariationMappedSkuSource,
    /function getCurrentVariationMappedSku\(view\)[\s\S]+view\.activeAuctionMapping\?\.variationNumber ===[\s\S]+view\.currentVariationNumber[\s\S]+return view\.activeAuctionMapping\.sku/,
  );
  assert.match(
    currentVariationMappedSkuSource,
    /findVariationOption\(\s*view,\s*view\.currentVariationNumber,?\s*\)/,
  );
  assert.match(
    currentVariationMappedSkuSource,
    /typeof currentVariation(?:\?\.|\.)sku === "string"[\s\S]+return currentVariation\.sku/,
  );
  assert.match(
    panelSource,
    /Historical right-click does not change that queue\./,
  );
  assert.match(
    panelSource,
    /Queued for the next variation\.[\s\S]+Right-click to queue this item for the next variation\./,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-queued="true"\]\s*\{[\s\S]+#ff737e/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[aria-pressed="true"\]\[data-queued="true"\]\s*\{[\s\S]+linear-gradient\([\s\S]+90deg,[\s\S]+var\(--cyan\) 0 50%,[\s\S]+#ff737e 50% 100%/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-current-mapped="true"\]\s*\{[\s\S]+#62aaff/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[aria-pressed="true"\]\[data-current-mapped="true"\]\s*\{[\s\S]+var\(--cyan\) 0 50%[\s\S]+#62aaff 50% 100%/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-current-mapped="true"\]\[data-queued="true"\]\s*\{[\s\S]+#62aaff 0 50%[\s\S]+#ff737e 50% 100%/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[aria-pressed="true"\]\[data-current-mapped="true"\]\[data-queued="true"\]\s*\{[\s\S]+var\(--cyan\) 0 33\.333%[\s\S]+#62aaff 33\.333% 66\.666%[\s\S]+#ff737e 66\.666% 100%/,
  );
  assert.doesNotMatch(html, /data-field="queued"|class="queued-label"/);
});

test("canceled variation cards stay selectable for reference-only item changes", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const workflowSource = fs.readFileSync(
    path.join(taggerDirectory, "mapping-workflow.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );
  const cardSource = panelSource.match(
    /function createInventoryCard\(entry, view\) \{[\s\S]*?\n  \}/,
  )?.[0];
  const clickSource = panelSource.match(
    /function saveOrdinaryInventorySelection\(button, view\)[\s\S]*?searchInput\.addEventListener\("input"/,
  )?.[0];

  assert.ok(cardSource);
  assert.ok(clickSource);
  assert.match(workflowSource, /selectionAllowed: true/);
  assert.doesNotMatch(workflowSource, /CANCELED_VARIATION_IMMUTABLE/);
  assert.match(
    cardSource,
    /button\.disabled = !entry\.selectionAllowed \|\| !canTagSelectedVariation/,
  );
  assert.match(cardSource, /Click to unselect this reference item/);
  assert.match(cardSource, /No inventory (?:is|will be) changed/);
  assert.doesNotMatch(cardSource, /lockedReason|read-only/);
  assert.doesNotMatch(styleSource, /data-locked-reason="canceled"/);
  assert.doesNotMatch(
    clickSource,
    /paymentStatus === "canceled"|is read-only/,
  );
  assert.match(clickSource, /persistentController\.mapSelectedSku/);
  assert.match(clickSource, /persistentController\.unmapSelectedVariation/);
  assert.match(
    panelSource,
    /Canceled variation \$\{variationNumber\} reference item saved locally\. Inventory and metrics were not changed/,
  );
  assert.match(
    panelSource,
    /Canceled variation \$\{variationNumber\} reference item cleared locally\. Inventory and metrics were not changed/,
  );
});

test("End Stream confirmation is not gated by unresolved payment or mapping states", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const endHandlerSource = panelSource.match(
    /endStreamButton\.addEventListener\("click",[\s\S]*?cancelEndStreamButton\.addEventListener/,
  )?.[0];
  const confirmHandlerSource = panelSource.match(
    /confirmEndStreamButton\.addEventListener\("click",[\s\S]*?retryStreamSessionButton\.addEventListener/,
  )?.[0];

  assert.ok(endHandlerSource);
  assert.match(endHandlerSource, /if \(streamSnapshot\.busy\)/);
  assert.doesNotMatch(endHandlerSource, /isSavedWorkspaceUnavailable/);
  assert.match(endHandlerSource, /endConfirmationOpen = true/);
  assert.match(
    endHandlerSource,
    /renderStreamSnapshot\(streamSessionController\.getSnapshot\(\)\)/,
  );
  assert.match(endHandlerSource, /cancelEndStreamButton\.focus\(\)/);
  assert.doesNotMatch(
    endHandlerSource,
    /getEndBlockingVariations|unresolvedVariations|savedSnapshot\?\.view\?\.variations|variationSelector\.focus\(\)/,
  );

  const statesThatMustNeverBlockEnd = [
    "pending",
    "payment_processing",
    "payment_fixing",
    "unmapped_completed",
    "completionAwaitingPrice",
    "mapped",
    "unmapped",
  ];

  statesThatMustNeverBlockEnd.forEach((status) => {
    assert.doesNotMatch(
      endHandlerSource,
      new RegExp(`(?:^|[^a-z_])${status}(?:$|[^a-z_])`, "i"),
    );
  });

  const disableExpressions = [
    ...panelSource.matchAll(/endStreamButton\.disabled\s*=\s*([^;]+);/g),
  ].map((match) => match[1]);

  assert.ok(disableExpressions.length > 0);
  disableExpressions.forEach((expression) => {
    assert.doesNotMatch(
      expression,
      /isSavedWorkspaceUnavailable|variation|auction|payment|pending|mapped|completion/i,
    );
  });

  assert.ok(confirmHandlerSource);
  assert.match(confirmHandlerSource, /if \(streamSnapshot\.busy\)/);
  assert.doesNotMatch(confirmHandlerSource, /isSavedWorkspaceUnavailable/);
  assert.match(
    confirmHandlerSource,
    /streamSessionController\.endActiveStream\(\)/,
  );
  assert.match(confirmHandlerSource, /local business report was saved/);
  assert.match(
    confirmHandlerSource,
    /refreshStreamReports\(\{ openLatest: true \}\)/,
  );
  assert.doesNotMatch(
    confirmHandlerSource,
    /persistentController\.|unmapSelectedVariation|markSelectedUnpaid|chrome\.storage|\.clear\(|\.remove\(/,
  );
  assert.match(html, /Unresolved\s+variations never block End/i);
  assert.match(html, /appear in its attention list/i);
});

test("tagger lists, opens, refreshes, and safely bypasses local stream reports", () => {
  const styleSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );
  const readinessSource = panelSource.match(
    /function describeReportReadiness\([\s\S]*?function openStreamReport/,
  )?.[0];
  const reportLinkSource = panelSource.match(
    /function createStreamReportLink\(summary, options = \{\}\)[\s\S]*?function renderStreamReportsPanel/,
  )?.[0];

  assert.ok(readinessSource);
  assert.ok(reportLinkSource);
  assert.match(
    readinessSource,
    /No captured issues currently require attention\./,
  );
  assert.match(readinessSource, /Report attention items:/);
  assert.match(readinessSource, /pending mapped order/);
  assert.match(readinessSource, /payment-fixing order/);
  assert.match(readinessSource, /completed sale without inventory/);
  assert.match(readinessSource, /data conflict/);
  assert.match(readinessSource, /SKU requiring a recount/);
  assert.doesNotMatch(readinessSource, /\b(?:final|provisional)\b/i);

  assert.match(
    panelSource,
    /globalThis\.TikTokLiveTrackerStreamReportProtocol/,
  );
  assert.match(
    panelSource,
    /globalThis\.TikTokLiveTrackerStreamReportClient/,
  );
  assert.match(panelSource, /createStreamReportClient\(\{\s*runtime: chrome\.runtime/);
  assert.match(
    panelSource,
    /function openStreamReport\(reportId\)[\s\S]+chrome\.runtime\.getURL\([\s\S]+report\/report\.html\?reportId=/,
  );
  assert.match(panelSource, /chrome\.tabs\.create\(\{ url: reportUrl \}\)/);
  assert.match(
    reportLinkSource,
    /summary\.completedPaymentCount[\s\S]+summary\.totalSalesCount[\s\S]+summary\.completedGmvCents/,
  );
  assert.match(reportLinkSource, /Open stream report from/);
  assert.doesNotMatch(
    reportLinkSource,
    /summary\.completeness|stream-report-link-state|data-completeness|\b(?:Final|Provisional)\b/,
  );
  assert.doesNotMatch(
    styleSource,
    /stream-report-link-state|data-completeness/,
  );
  assert.match(
    panelSource,
    /async function refreshStreamReports\(options = \{\}\)[\s\S]+Promise\.all\([\s\S]+streamReportClient\.listReports\(\)[\s\S]+streamReportClient\.listArchivedReports\(\)[\s\S]+dashboardResponse\.reports[\s\S]+archivedResponse\.reports[\s\S]+options\.openLatest === true[\s\S]+openStreamReport\(latest\.reportId\)/,
  );
  assert.match(
    panelSource,
    /retryStreamReportsButton\.addEventListener\("click",[\s\S]+refreshStreamReports\(\{ focusError: true \}\)/,
  );
  assert.match(
    panelSource,
    /Promise\.resolve\(\)\.then\(\(\) => refreshStreamReports\(\)\)/,
  );
  assert.match(
    panelSource,
    /endStreamWithoutReportButton\.addEventListener\("click",[\s\S]+streamSessionController\.endActiveStreamWithoutReport\(\)[\s\S]+ended without a new report/,
  );
});

test("Business Records exposes a dedicated accessible archived-report dashboard", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.html"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );

  assert.match(
    html,
    /id="view-archived-reports"[\s\S]*?>\s*View archived reports\s*</,
  );
  assert.match(
    html,
    /id="archived-reports-view"[\s\S]+aria-labelledby="archived-reports-title"[\s\S]+hidden/,
  );
  assert.match(html, /id="archived-reports-title">Archived stream reports</);
  assert.match(
    html,
    /id="back-to-business-records"[\s\S]*?Back to Business Records/,
  );
  assert.match(html, /id="archived-reports-list"[\s\S]+role="list"/);
  assert.match(html, /id="toggle-archived-selection"[\s\S]+aria-pressed="false"[\s\S]*?>\s*Select\s*</);
  assert.match(html, /id="select-all-archived-reports"[\s\S]*?>\s*Select all\s*</);
  assert.match(html, /id="clear-archived-selection"[\s\S]*?>\s*Clear selection\s*</);
  assert.match(html, /id="restore-selected-reports"[\s\S]*?>\s*Restore selected\s*</);
  assert.match(html, /id="delete-selected-reports"[\s\S]*?>\s*Delete selected\s*</);
  assert.match(
    html,
    /id="report-action-confirmation"[\s\S]+aria-labelledby="report-action-confirmation-title"[\s\S]+aria-describedby="report-action-confirmation-message"/,
  );
  assert.match(
    html,
    /permanently deletes the saved report from this Chrome profile[\s\S]+cannot be undone[\s\S]+TikTok LIVE and Google Sheets will not be changed/i,
  );

  assert.match(
    styleSource,
    /\.app-shell\.archived-reports-open[\s\S]+\.archived-reports-view/,
  );
  assert.match(styleSource, /\.report-more-button[\s\S]+cursor: pointer/);
  assert.match(styleSource, /\.report-actions-menu[\s\S]+position: absolute/);
  assert.doesNotMatch(styleSource, /\.stream-report-row:hover[\s\S]+\.report-more-button/);
  assert.match(
    panelSource,
    /function openArchivedReportsDashboard\(\)[\s\S]+archivedReportsViewOpen = true[\s\S]+backToBusinessRecordsButton\.focus\(\)/,
  );
  assert.match(
    panelSource,
    /function closeArchivedReportsDashboard\(\)[\s\S]+archivedReportsViewOpen = false[\s\S]+viewArchivedReportsButton\.focus\(\)/,
  );
});

test("archived-report actions enforce dashboard capacity and remain keyboard operable", () => {
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );
  const reportLinkSource = panelSource.match(
    /function createStreamReportLink\(summary, options = \{\}\)[\s\S]*?function renderArchivedSelectionControls/,
  )?.[0];
  const mutationSource = panelSource.match(
    /async function runReportMutation\(action, reportIds\)[\s\S]*?function requestPermanentReportDeletion/,
  )?.[0];

  assert.ok(reportLinkSource);
  assert.ok(mutationSource);
  assert.match(reportLinkSource, /aria-haspopup/);
  assert.match(reportLinkSource, /aria-expanded/);
  assert.match(reportLinkSource, /aria-controls/);
  assert.match(reportLinkSource, /More actions for stream report from/);
  assert.match(reportLinkSource, /role", "menu"/);
  assert.match(panelSource, /button\.setAttribute\("role", "menuitem"\)/);
  assert.match(reportLinkSource, /"Archive", "archive"/);
  assert.match(reportLinkSource, /"Restore", "restore"/);
  assert.match(reportLinkSource, /"Delete forever", "delete"/);
  assert.match(reportLinkSource, /getAvailableDashboardReportSlots\(\) > 0/);
  assert.match(panelSource, /event\.key === "Escape"/);
  assert.match(panelSource, /event\.key === "ArrowDown"/);
  assert.match(panelSource, /event\.key === "ArrowUp"/);
  assert.match(panelSource, /document\.addEventListener\("click"[\s\S]+closeReportActionsMenu/);

  assert.match(
    mutationSource,
    /ids\.length > getAvailableDashboardReportSlots\(\)/,
  );
  assert.match(mutationSource, /streamReportClient\.archiveReports\(\{ reportIds: ids \}\)/);
  assert.match(mutationSource, /streamReportClient\.restoreReports\(\{ reportIds: ids \}\)/);
  assert.match(mutationSource, /streamReportClient\.deleteArchivedReports\(\{ reportIds: ids \}\)/);
  assert.match(
    panelSource,
    /restoreSelectedReportsButton\.hidden = availableSlots === 0/,
  );
  assert.match(
    panelSource,
    /selectedCount > availableSlots[\s\S]+Clear part of the selection before restoring/,
  );
  assert.match(
    panelSource,
    /requestPermanentReportDeletion\(\[summary\.reportId\], moreButton\)/,
  );
  assert.match(
    panelSource,
    /deleteSelectedReportsButton\.addEventListener\("click"[\s\S]+requestPermanentReportDeletion/,
  );
  assert.match(
    panelSource,
    /confirmReportActionButton\.addEventListener\("click"[\s\S]+pendingReportDeletion = null;[\s\S]+reportActionConfirmation\.close\(\)[\s\S]+runReportMutation\("delete", reportIds\)/,
  );
  assert.match(
    panelSource,
    /reportActionConfirmation\.addEventListener\("close"[\s\S]+restoreFocus = pendingReportDeletion !== null[\s\S]+returnFocusTarget\.focus\(\)/,
  );
});

test("an active stream can be ended before its saved workspace is resumed", () => {
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );
  const resumeAvailableSource = panelSource.match(
    /if \(resumeAvailable\) \{[\s\S]*?\n    \}/,
  )?.[0];

  assert.ok(resumeAvailableSource);
  assert.match(
    resumeAvailableSource,
    /resumeStreamButton\.hidden = endConfirmationOpen/,
  );
  assert.match(
    resumeAvailableSource,
    /endStreamButton\.hidden = endConfirmationOpen/,
  );
  assert.match(
    resumeAvailableSource,
    /streamSessionEndConfirmation\.hidden = !endConfirmationOpen/,
  );
  assert.doesNotMatch(resumeAvailableSource, /isSavedWorkspaceUnavailable/);
});

test("tagger refreshes canonical Sold Items state from strict worker invalidations", () => {
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );

  assert.match(
    panelSource,
    /CAPTURE_STATE_NOTIFICATION_CHANNEL\s*=\s*\n?\s*"tiktok-live-tracker\.capture-state"/,
  );
  assert.match(panelSource, /CAPTURE_STATE_NOTIFICATION_VERSION = 1/);
  assert.match(
    panelSource,
    /CAPTURE_STATE_NOTIFICATION_TYPE = "capture_state_changed"/,
  );
  assert.match(panelSource, /CAPTURE_REFRESH_DELAY_MS = 150/);
  assert.match(
    panelSource,
    /hasExactKeys\(message, \["channel", "version", "event"\]\)/,
  );
  assert.match(panelSource, /hasExactKeys\(message\.event, \["type"\]\)/);
  assert.match(panelSource, /sender\?\.id === chrome\.runtime\.id/);
  assert.match(panelSource, /sender\.tab === undefined/);
  assert.match(
    panelSource,
    /chrome\.runtime\.onMessage\.addListener\(handleCaptureStateChanged\)/,
  );
  assert.match(panelSource, /scheduledController\.refresh\(\)/);
  assert.match(panelSource, /scheduledController !== persistentController/);
  assert.match(panelSource, /scheduledStreamId !== mountedStreamId/);
  assert.match(panelSource, /window\.setTimeout\([\s\S]+CAPTURE_REFRESH_DELAY_MS/);
  assert.match(panelSource, /clearCaptureRefreshTimer\(\)/);
  assert.match(
    panelSource,
    /pagehide[\s\S]+removeListener\(handleCaptureStateChanged\)/,
  );
  assert.match(panelSource, /getFocusedInventorySku\(\)/);
  assert.match(panelSource, /captureRefreshFocusSku[\s\S]+focusOptions\.focusSku/);
  assert.match(panelSource, /Checking live auction data/);
  assert.match(panelSource, /Live auction data updated/);
  assert.match(panelSource, /Retry live update/);
  assert.match(panelSource, /Captured variation #/);
  assert.match(
    panelSource,
    /Captured variation #\$\{added\[0\]\} from Sold Items\. \$\{paymentDetail\} It is selected and ready to tag\./,
  );
  assert.match(panelSource, /variation\.observedPaymentStatus/);
  assert.match(panelSource, /variation\.soldPriceCents/);
  assert.match(panelSource, /variation\.conflicts/);
  assert.match(panelSource, /Payment complete captured for variation #/);
  assert.match(panelSource, /Payment price conflict for variation #/);
  assert.match(panelSource, /payment_completed_after_marked_unpaid/);
  assert.match(
    panelSource,
    /function createVariationOptionContent\(display\)[\s\S]+variation-option-status[\s\S]+display\.paymentTone[\s\S]+variation-option-item[\s\S]+display\.itemTone/,
  );
  assert.doesNotMatch(panelSource, /\$\{context\} - TikTok:/);
  assert.match(panelSource, /added\[0\] === view\.selectedVariationNumber/);
  assert.match(panelSource, /Captured earlier variation/);
  assert.match(panelSource, /captureRefreshHadVariationFocus/);
  assert.match(panelSource, /pendingMapping\.contains\(document\.activeElement\)/);
  assert.match(panelSource, /focusOptions\.focusVariation = true/);
  assert.match(
    panelSource,
    /Now showing variation #\$\{view\.selectedVariationNumber\}\./,
  );
  assert.match(panelSource, /view\.isReviewingHistory/);
  assert.match(
    panelSource,
    /New live auctions will keep updating in this menu without changing your selection\./,
  );
  assert.match(
    panelSource,
    /You are following the current auction, so the next live auction will open automatically\./,
  );
  assert.doesNotMatch(
    panelSource,
    /available in the variation menu now/,
  );
  assert.doesNotMatch(panelSource, /message\.state|message\.streamId/);
});

test("capture scripts load across the TikTok shop SPA and gate themselves at runtime", () => {
  const dashboardScript = manifest.content_scripts.find((script) =>
    script.matches.includes("https://shop.tiktok.com/*"),
  );

  assert.ok(dashboardScript);
  assert.deepEqual(dashboardScript.js, [
    "shared/sale-parser.js",
    "shared/capture-protocol.js",
    "capture/capture-client.js",
    "capture/attributed-gmv-locator.js",
    "capture/bidding-variation-locator.js",
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
  const captureClientSource = fs.readFileSync(
    path.join(extensionDirectory, "capture", "capture-client.js"),
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
  assert.match(captureSource, /TikTokLiveTrackerCaptureProtocol/);
  assert.match(captureSource, /TikTokLiveTrackerCaptureClient/);
  assert.match(captureClientSource, /trustedRuntime\.sendMessage/);
  assert.match(captureSource, /const QUIET_SCAN_DELAY_MS = 150/);
  assert.match(captureSource, /const MAX_SCAN_WAIT_MS = 1000/);
  assert.match(captureSource, /quietDelayMs:\s*QUIET_SCAN_DELAY_MS/);
  assert.match(captureSource, /maxWaitMs:\s*MAX_SCAN_WAIT_MS/);
  assert.match(captureSource, /https:\/\/shop\.tiktok\.com/);
  assert.match(captureSource, /\/streamer\/live\/product\/dashboard/);
  assert.doesNotMatch(
    `${captureSource}\n${locatorSource}\n${registrySource}\n${schedulerSource}`,
    /runtime\.sendMessage|tiktok-live-tracker\.reconciliation/,
  );
});
