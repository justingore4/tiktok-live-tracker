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
  class FakeCaptureProtocolError extends Error {}
  class FakeCaptureIntegrationError extends Error {}
  class FakeInventoryImportProtocolError extends Error {}
  class FakeGoogleSheetsImportError extends Error {}
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
    "../shared/sale-parser.js",
    "../shared/reconciliation.js",
    "../shared/reconciliation-coordinator.js",
    "../shared/stream-session-coordinator.js",
    "../shared/inventory-import-protocol.js",
    "reconciliation-client.js",
    "stream-session-client.js",
    "stream-session-controller.js",
    "inventory-import-client.js",
    "inventory-import-controller.js",
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
  assert.match(html, /Waiting for a variation to appear in Sold Items/);
  assert.match(html, /ended streams cannot be\s+reopened in this prototype/i);
  assert.match(
    html,
    /unresolved variations do not block End/i,
  );
  assert.match(html, /captured (?:order )?history will remain saved/i);
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
  assert.match(
    html,
    /data-field="stock"[\s\S]+data-field="stock-primary"[\s\S]+data-field="stock-secondary"[\s\S]+hidden/,
  );
  assert.match(
    html,
    /Remaining inventory changes only after Payment complete\.[\s\S]+Pending appears[\s\S]+only while TikTok shows Payment processing or Payment fixing[\s\S]+reduces what is available to tag\./,
  );
  assert.match(html, /Click the selected card again to remove\s+its item/);
  assert.match(html, /id="pending-mapping"/);
  assert.match(html, /id="auction-eyebrow"[^>]*>Auction status</);
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
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );
  const mappingSource = `${panelSource}\n${workflowSource}`;
  const demoSeedsSource = panelSource.match(
    /const DEMO_VARIATION_SEEDS = Object\.freeze\(\[[\s\S]*?\]\);/,
  )?.[0];

  assert.ok(demoSeedsSource);
  assert.doesNotMatch(demoSeedsSource, /status: "pending"/);
  assert.match(
    demoSeedsSource,
    /variationNumber: 201,[\s\S]+status: "unmapped"/,
  );

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
    /variationSelector\.addEventListener\("change",[\s\S]+persistentController\.selectVariation[\s\S]+getDemoSession\(\)\.selectVariation/,
  );
  assert.match(
    panelSource,
    /returnToCurrentButton\.addEventListener\("click",[\s\S]+activeMode === "saved_session"[\s\S]+getDemoSession\(\)\.selectVariation/,
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
  const startHandlerSource = panelSource.match(
    /startStreamButton\.addEventListener\("click",[\s\S]*?resumeStreamButton\.addEventListener/,
  )?.[0];
  assert.ok(startHandlerSource);
  assert.match(startHandlerSource, /isInventoryReadyForStart\(\)/);
  assert.match(startHandlerSource, /streamSessionController\.startNewStream\(\)/);
  assert.doesNotMatch(
    startHandlerSource,
    /ensureInventoryInitialized|MOCK_INVENTORY/,
  );
  assert.match(panelSource, /streamSessionController\.startNewStream\(\)/);
  assert.match(panelSource, /streamSessionController\.resumeActiveStream\(\)/);
  assert.match(panelSource, /streamSessionController\.endActiveStream\(\)/);
  assert.match(panelSource, /streamSessionController\.retry\(\)/);
  assert.doesNotMatch(panelSource, /function getEndBlockingVariations\(\)/);
  assert.match(panelSource, /getRecordedVariations\(view\)/);
  assert.match(panelSource, /variation\.recorded/);
  assert.match(panelSource, /Waiting for Sold Items variations/);
  assert.match(panelSource, /Wait for a Sold Items variation before tagging/);
  assert.doesNotMatch(panelSource, /Prototype tagger current|live queue not connected/);
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
    /if \(!prepareMissingInventory\) \{[\s\S]+return null;[\s\S]+persistentTaggerControllerModule\.ensureInventoryInitialized\(\{[\s\S]+client: persistentClient,[\s\S]+inventory: viewModel\.MOCK_INVENTORY/,
  );
  assert.ok(
    streamRetrySource.indexOf(
      "persistentTaggerControllerModule.ensureInventoryInitialized",
    ) < streamRetrySource.indexOf("streamSessionController.retry()"),
    "a missing baseline must initialize before retry reissues the saved stream GET",
  );
  assert.match(panelSource, /savedSessionError\.focus\(\)/);
  assert.match(panelSource, /pendingSavedAction \|\| savedSnapshot\?\.busy/);
  assert.match(panelSource, /activeMode !== "offline_demo"/);
  assert.doesNotMatch(panelSource, /persistentController\.[^(]*Payment/);
  assert.match(panelSource, /result\.action === "completed_sale_mapped"/);
  assert.match(workflowSource, /canceled: "Canceled"/);
  assert.match(
    workflowSource,
    /auction\?\.paymentStatus === "canceled" \|\|[\s\S]+auction\?\.paymentStatus === "payment_complete"/,
  );
  assert.match(
    workflowSource,
    /previousAuction\?\.paymentStatus === "canceled" \|\|[\s\S]+previousAuction\?\.paymentStatus === "payment_complete"/,
  );
  assert.match(workflowSource, /"canceled_order_mapped"/);
  assert.match(workflowSource, /"canceled_mapping_corrected"/);
  assert.match(
    workflowSource,
    /error\?\.code !== "NO_STOCK_AVAILABLE"[\s\S]+simulatedPaymentCheckpoints\.delete\(selectedEventKey\(\)\)/,
  );
  assert.match(panelSource, /view\.auction\?\.status === "unmapped_completed"/);
  assert.doesNotMatch(
    panelSource,
    /warnings\.some\([\s\S]+unmapped_completed_sale/,
  );
  assert.doesNotMatch(panelSource, /changeMappingButton|#change-mapping/);
  assert.match(panelSource, /auctionEyebrow\.textContent/);
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
  assert.match(panelSource, /without a pending reservation/);
  assert.match(
    panelSource,
    /lifecycleControls\.hidden =[\s\S]+completionAwaitingPrice \|\|/,
  );
  assert.match(
    panelSource,
    /markUnpaidButton\.hidden = completionAwaitingPrice \|\|/,
  );
  assert.match(
    panelSource,
    /markUnpaidButton\.disabled = completionAwaitingPrice/,
  );
  assert.match(
    panelSource,
    /"Item linked · reservation released · stock unchanged"/,
  );
  assert.match(panelSource, /selectedLabel\.textContent = "Linked"/);
  assert.match(panelSource, /is linked to canceled variation/);
  assert.match(panelSource, /Stock counts will not change/);
  assert.match(panelSource, /const canceled = view\.auction\?\.status === "canceled"/);
  assert.match(panelSource, /lifecycleControls\.hidden =[\s\S]+canceled \|\|/);
  assert.match(panelSource, /payment_completed_after_canceled/);
  assert.match(
    panelSource,
    /TikTok completion won, inventory was counted, and the order was flagged for review/,
  );
  assert.match(panelSource, /Canceled variation \$\{variationNumber\} item link saved locally/);
  assert.match(panelSource, /Canceled variation \$\{variationNumber\} item link removed/);
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
  assert.match(confirmHandlerSource, /saved order history was kept/);
  assert.doesNotMatch(
    confirmHandlerSource,
    /persistentController\.|unmapSelectedVariation|markSelectedUnpaid|chrome\.storage|\.clear\(|\.remove\(/,
  );
  assert.match(html, /unresolved variations do not block End/i);
  assert.match(html, /captured (?:order )?history will remain saved/i);
  assert.match(html, /ended streams cannot be\s+reopened in this prototype/i);
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
  assert.match(panelSource, /Checking live Sold Items/);
  assert.match(panelSource, /Live Sold Items updated/);
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
    /#\$\{option\.variationNumber\} - \$\{option\.observedPaymentStatusLabel\} - \$\{item\}/,
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
  assert.match(
    panelSource,
    /A newly captured variation will open automatically\./,
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
