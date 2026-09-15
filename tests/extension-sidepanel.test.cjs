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
    TikTokLiveTrackerVariationPresetsProtocol: require("../extension/shared/variation-presets-protocol.js"),
    TikTokLiveTrackerVariationPresetsStorage: {
      createVariationPresetsStore: () => ({}),
    },
    TikTokLiveTrackerVariationPresetsCoordinator: {
      createVariationPresetsCoordinator: () => ({
        dispatch: async () => ({ streamId: null, baselineId: null, revision: null, total: null, assignments: [] }),
        synchronize: async ({ state }) => ({ state, changed: false }),
        clearForStream: async () => ({ status: "unchanged" }),
      }),
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
      createReportLibraryChangedNotification() {
        return {
          channel: "tiktok-live-tracker.stream-report",
          version: 1,
          event: { type: "report_library_changed" },
        };
      },
      isReportLibraryChangedNotification() {
        return false;
      },
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
    "../shared/capture-health.js",
    "capture-health-view.js",
    "../shared/inventory-import-protocol.js",
    "../shared/stream-report-protocol.js",
    "../shared/live-bid-protocol.js",
    "../shared/next-item-queue-protocol.js",
    "../shared/variation-presets-protocol.js",
    "reconciliation-client.js",
    "stream-session-client.js",
    "stream-session-controller.js",
    "inventory-import-client.js",
    "inventory-import-controller.js",
    "live-bid-client.js",
    "next-item-queue-client.js",
    "variation-presets-client.js",
    "variation-presets-view.js",
    "../shared/tiktok-fee-calculator.js",
    "inventory-view-model.js",
    "live-auction-view-model.js",
    "variation-selector-view-model.js",
    "variation-selector-lock.js",
    "mapping-workflow.js",
    "persistent-tagger-controller.js",
    "../shared/stream-report.js",
    "../report/stream-report-client.js",
    "../vendor/jspdf/jspdf.umd.min.js",
    "../vendor/jspdf-autotable/jspdf.plugin.autotable.min.js",
    "../report/report-page.js",
    "../report/report-pdf.js",
    "../report/report-downloads.js",
    "sidepanel.js",
  ]);
  assert.ok(
    resourcePaths.every((relativePath) =>
      fs.existsSync(path.join(panelDirectory, relativePath)),
    ),
  );
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
});

test("side-panel header keeps a compact decorative mark centered beside the unchanged title", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const header = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  assert.match(header, /<div class="brand-mark" aria-hidden="true">T<\/div>/);
  assert.match(header, /<div class="brand-copy">\s*<h1>TikTok Live Tracker<\/h1>\s*<\/div>/);
  assert.doesNotMatch(header, /Seller tool|class="eyebrow"/i);
  assertTextOrder(header, ['class="brand-mark"', 'class="brand-copy"', "<h1>"]);

  const headerRule = css.match(/\.app-header\s*\{([^}]+)\}/)?.[1];
  const markRule = css.match(/\.brand-mark\s*\{([^}]+)\}/)?.[1];
  const titleRule = css.match(/(?:^|\n)\.brand-copy h1\s*\{([^}]+)\}/)?.[1];
  assert.ok(headerRule);
  assert.ok(markRule);
  assert.ok(titleRule);
  assert.match(headerRule, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(headerRule, /align-items:\s*center/);
  assert.match(markRule, /width:\s*32px/);
  assert.match(markRule, /height:\s*32px/);
  assert.match(markRule, /border-radius:\s*10px/);
  assert.match(markRule, /font-size:\s*16px/);
  assert.match(markRule, /place-items:\s*center/);
  assert.match(markRule, /background:\s*linear-gradient\(145deg, var\(--cyan\), var\(--blue\)\)/);
  const secondaryActionRule = css.match(/(?:^|\n)\.secondary-action\s*\{([^}]+)\}/)?.[1];
  assert.ok(secondaryActionRule);
  assert.match(titleRule, /color:\s*var\(--blue-bright\);/);
  assert.equal(titleRule.match(/color:\s*([^;]+);/)?.[1],
    secondaryActionRule.match(/color:\s*([^;]+);/)?.[1], "Title matches View archived reports text");
  assert.doesNotMatch(titleRule, /background(?:-clip)?\s*:/);
  assert.match(titleRule, /font-size:\s*clamp\(15px, 4\.5vw, 18px\)/);
  assert.match(titleRule, /font-weight:\s*720/);
  assert.doesNotMatch(titleRule, /(?:margin|padding)(?:-top|-block-start)?\s*:/);
  const titleMarginReset = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selectors, declarations]) =>
      selectors.split(",").some((selector) => selector.trim() === ".brand-copy h1") &&
      /margin:\s*0\s*;/.test(declarations),
  );
  assert.ok(titleMarginReset, "The title keeps its existing zero-margin reset with no eyebrow gap.");
});

test("side panel exposes accessible Live lifecycle controls", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const headerSource = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0];
  const footerSource = html.match(
    /<footer class="app-footer"[\s\S]*?<\/footer>/,
  )?.[0];
  const inventoryCardTemplateSource = html.match(
    /<template id="inventory-card-template">[\s\S]*?<\/template>/,
  )?.[0];
  const inventoryCardOpeningTag = inventoryCardTemplateSource?.match(
    /<button class="inventory-card"[^>]*>/,
  )?.[0];

  assert.ok(headerSource);
  assert.ok(footerSource);
  assert.ok(inventoryCardTemplateSource);
  assert.ok(inventoryCardOpeningTag);
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
  assert.match(
    html,
    /id="start-stream"[\s\S]+type="button"[\s\S]+>\s*Start stream tracking\s*</,
  );
  assert.match(html, /id="resume-stream"[\s\S]+type="button"/);
  assert.match(html, /id="end-stream"[\s\S]+type="button"/);
  assert.doesNotMatch(
    html,
    /stream-session-safety-note|These controls affect only this tracker's local session/,
  );
  assert.match(html, /id="confirm-end-stream"[\s\S]+type="button"/);
  assert.match(
    html,
    /id="stream-session-end-confirmation"[\s\S]+role="group"[\s\S]+aria-label="End stream tracking options"/,
  );
  assert.match(
    html,
    /id="end-report-readiness"[\s\S]+role="status"[\s\S]+aria-live="polite"/,
  );
  assert.match(html, />\s*Keep stream active\s*</);
  assert.match(html, />\s*End and create report\s*</);
  assert.doesNotMatch(html, /id="(?:confirm-)?end-stream-without-report"|End without report/);
  assert.match(html, /id="retry-stream-session"[\s\S]+type="button"/);
  assert.match(
    html,
    /id="inventory-import-panel"[\s\S]+aria-busy="true"/,
  );
  assert.match(html, /<label[^>]+for="inventory-sheet-reference"/);
  assert.match(
    html,
    /id="inventory-sheet-reference"[\s\S]+aria-describedby="inventory-sheet-error"/,
  );
  assert.doesNotMatch(
    html,
    /inventory-import-description|inventory-sheet-help|Connect the spreadsheet that contains your|Only the Inventory tab is read/,
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
    /id="inventory-import-confirmation-status"[\s\S]+role="status"[\s\S]+tabindex="-1"[\s\S]+aria-live="polite"/,
  );
  assert.doesNotMatch(html, /do not[\s\S]+start or end TikTok LIVE/i);
  assert.match(html, /Waiting for a live auction variation/);
  const endConfirmation = html.match(
    /id="stream-session-end-confirmation"[\s\S]*?id="stream-session-error"/,
  )?.[0];
  assert.ok(endConfirmation);
  assert.doesNotMatch(
    endConfirmation,
    /stream-session-end-title|Create a local business report|Unresolved variations never block/,
  );
  assert.doesNotMatch(endConfirmation, /\b(?:final|provisional)\b/i);
  assert.match(
    html,
    /id="stream-reports-panel"[\s\S]+aria-labelledby="stream-reports-title"[\s\S]+aria-busy="true"[\s\S]+hidden/,
  );
  assert.match(html, /id="stream-reports-title" class="eyebrow">STREAM REPORT RECORDS</);
  assert.match(html, /id="stream-reports-count"[\s\S]+0 saved/);
  assert.doesNotMatch(
    html,
    /class="stream-reports-description"|print or save it as a PDF|Limit of 5 reports on this dashboard/,
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
  assert.match(inventoryCardTemplateSource, /<button class="inventory-card" type="button">/);
  assert.match(
    inventoryCardTemplateSource,
    /class="card-title"[\s\S]*?data-field="item"[\s\S]*?data-field="style"/,
  );
  assert.doesNotMatch(inventoryCardTemplateSource, /item-separator/);
  assert.doesNotMatch(inventoryCardTemplateSource, /stock-indicator/);
  assert.match(
    styleSource,
    /\.card-title\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/,
  );
  assert.doesNotMatch(inventoryCardOpeningTag, /aria-pressed|role="combobox"/);
  assert.match(
    html,
    /data-field="stock"[\s\S]+data-field="stock-primary"[\s\S]+data-field="stock-secondary"[\s\S]+hidden/,
  );
  assert.match(
    html,
    /id="inventory-selection-note"[^>]+hidden[^>]*><\/p>/,
  );
  assert.doesNotMatch(
    `${html}\n${panelSource}`,
    /Selecting an item reserves one unit until TikTok reports Payment complete or Canceled/,
  );
  assert.match(html, /id="pending-mapping"/);
  assert.match(
    html,
    /id="pending-mapping-title"[^>]+tabindex="-1"[\s\S]*?Variation <span data-field="mapped-variation">#&mdash;<\/span>[\s\S]*?Status \|\s+<span id="mapped-item">-<\/span>/,
  );
  assert.match(html, /id="mapping-announcement"[\s\S]+role="status"/);
  assert.match(html, /id="state-warning"[^>]+role="status"/);
  assert.doesNotMatch(
    html,
    /id="auction-eyebrow"|class="pending-card"|id="auction-status"|id="tiktok-payment-status"|id="payment-price"|data-field="observed-payment-status"|data-field="mapping-status"/,
  );
  assert.doesNotMatch(html, /<dt>TikTok payment<\/dt>|<dt>Inventory tag<\/dt>/);
  assert.doesNotMatch(html, /Gross profit excludes platform fees, shipping, refunds, and taxes/);
  assert.match(styleSource, /\.pending-heading h2:focus\s*\{/);
  assert.doesNotMatch(styleSource, /\.sale-results > p\s*\{/);
  assert.match(
    html,
    /id="sale-results"\s+class="sale-results">[\s\S]+data-field="sold-price">&mdash;<[\s\S]+data-field="unit-cost">&mdash;<[\s\S]+data-field="gross-profit"\s+data-tone="neutral">&mdash;<[\s\S]+data-field="remaining-inventory">&mdash;</,
  );
  assert.doesNotMatch(html, /id="sale-results"[^>]*\shidden/);
  assert.doesNotMatch(html, /id="data-mode-badge"|class="session-badge"/);
  assert.doesNotMatch(html, /id="change-mapping"/);
  assert.doesNotMatch(html, />\s*Change item\s*</);
});

test("pre-stream sheet input keeps its accessible label without a visible layout row", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const sheetLabel = html.match(
    /<label\b[^>]*\bfor="inventory-sheet-reference"[^>]*>[\s\S]*?<\/label>/,
  )?.[0];
  const activeStreamSheetLabel = html.match(
    /<label\b[^>]*\bfor="active-stream-inventory-sheet-reference"[^>]*>[\s\S]*?<\/label>/,
  )?.[0];
  const hiddenStyle = styleSource.match(
    /\.visually-hidden\s*\{[^}]*\}/,
  )?.[0];

  assert.ok(sheetLabel);
  assert.ok(activeStreamSheetLabel);
  assert.ok(hiddenStyle);
  assert.match(sheetLabel, /class="[^"]*\bvisually-hidden\b[^"]*"/);
  assert.match(sheetLabel, />\s*Google Sheet ID or sharing link\s*<\/label>/);
  assert.doesNotMatch(sheetLabel, /\shidden(?:\s|=|>)|aria-hidden="true"/);
  assert.match(html, /<input\b[^>]*\bid="inventory-sheet-reference"/);
  assert.match(hiddenStyle, /position:\s*absolute\s*!important;/);
  assert.match(hiddenStyle, /overflow:\s*hidden\s*!important;/);
  assert.match(hiddenStyle, /clip:\s*rect\(0, 0, 0, 0\)\s*!important;/);
  assert.doesNotMatch(hiddenStyle, /display:\s*none|visibility:\s*hidden/);
  assert.match(
    activeStreamSheetLabel,
    />\s*Google Sheet ID or sharing link\s*<\/label>/,
  );
  assert.doesNotMatch(activeStreamSheetLabel, /visually-hidden|\shidden(?:\s|=|>)/);
});

test("a confirmed baseline exposes a local read-only inventory disclosure", () => {
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
  const confirmationSource = html.match(
    /<details\s+id="inventory-import-confirmation"[\s\S]*?<\/details>/,
  )?.[0];
  const confirmationOpeningTag = confirmationSource?.match(/^<details[^>]+>/)?.[0];

  assert.ok(confirmationSource);
  assert.ok(confirmationOpeningTag);
  assert.match(confirmationOpeningTag, /\shidden(?:\s|>)/);
  assert.doesNotMatch(confirmationOpeningTag, /\sopen(?:\s|>)/);
  assert.match(
    confirmationSource,
    /<summary class="inventory-import-confirmation-summary">/,
  );
  assert.match(confirmationSource, /Preview inventory/);
  assert.match(
    confirmationSource,
    /id="confirmed-inventory-preview"[\s\S]+class="inventory-import-preview confirmed-inventory-preview"[\s\S]+hidden/,
  );
  assert.match(
    confirmationSource,
    /Validated preview[\s\S]+Review the opening inventory/,
  );
  assert.match(
    confirmationSource,
    /Rows[\s\S]+Opening units[\s\S]+Opening cost/,
  );
  assert.match(
    confirmationSource,
    /SKU[\s\S]+Item[\s\S]+Style[\s\S]+Size[\s\S]+Qty[\s\S]+Cost/,
  );
  assert.doesNotMatch(
    confirmationSource,
    /Confirm inventory baseline|Cancel preview|Change Sheet/,
  );
  assert.match(
    panelSource,
    /inventoryImportConfirmation\.addEventListener\("toggle"/,
  );
  assert.match(
    panelSource,
    /inventoryImportClient\.getActiveBaselinePreview\(\)/,
  );
  assert.match(
    panelSource,
    /preview\.baselineId !== expectedBaselineId/,
  );
  assert.match(
    panelSource,
    /confirmedInventoryPreviewRequestEpoch/,
  );
  assert.match(
    styleSource,
    /\.inventory-import-confirmation-summary::\-webkit-details-marker[\s\S]+display:\s*none/,
  );
  assert.match(
    styleSource,
    /\.inventory-import-confirmation\[open\][\s\S]+content:\s*"−"/,
  );
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
    /id="add-active-stream-skus"[\s\S]+aria-expanded="false"[\s\S]+aria-controls="active-stream-inventory-update-form"[\s\S]+Add new SKUs from updated Sheet/,
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
  assert.match(
    actionSource,
    /showActiveStreamInventoryUpdateFeedback\(message\)/,
  );
  assert.match(
    panelSource,
    /const ACTIVE_STREAM_INVENTORY_FEEDBACK_DURATION_MS = 4_000;/,
  );
  assert.match(
    panelSource,
    /function clearActiveStreamInventoryUpdateFeedback\(\)[\s\S]+window\.clearTimeout\(activeStreamInventoryUpdateFeedbackTimerId\)[\s\S]+activeStreamInventoryUpdateFeedback\.hidden = true;[\s\S]+activeStreamInventoryUpdateFeedback\.textContent = "";/,
  );
  assert.match(
    panelSource,
    /function showActiveStreamInventoryUpdateFeedback\(message\)[\s\S]+window\.setTimeout\([\s\S]+activeStreamInventoryUpdateFeedback\.hidden = true;[\s\S]+activeStreamInventoryUpdateFeedback\.textContent = "";[\s\S]+ACTIVE_STREAM_INVENTORY_FEEDBACK_DURATION_MS/,
  );
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
  const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");
  const panelSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.js"),
    "utf8",
  );
  const styleSource = fs.readFileSync(
    path.join(taggerDirectory, "sidepanel.css"),
    "utf8",
  );

  assert.match(html, /id="variation-context" class="visually-hidden"/);
  assert.match(html, /aria-describedby="variation-context"/);
  assert.doesNotMatch(html, /id="data-mode-badge"|class="session-badge"/);
  assert.doesNotMatch(styleSource, /\.session-badge\s*\{|\.current-auction-label/);

  const panelRules = [...styleSource.matchAll(/\.current-auction\s*\{([^}]+)\}/g)];
  const pickerRules = [...styleSource.matchAll(/\.variation-picker\s*\{([^}]+)\}/g)];
  assert.equal(panelRules.length, 1, "narrow layouts must keep the compact panel");
  assert.match(panelRules[0][1], /padding: 12px 14px;/);
  assert.doesNotMatch(panelRules[0][1], /min-height/);
  assert.equal(pickerRules.length, 1, "the label and dropdown must stay on one row");
  assert.match(pickerRules[0][1], /display: flex;/);
  assert.doesNotMatch(pickerRules[0][1], /flex-direction: column/);
  assert.match(
    styleSource,
    /\.variation-picker h2\s*\{[^}]*font-size: clamp\(18px, 6vw, 24px\);/,
  );
  for (const selector of ["current-auction-copy", "variation-select-shell"]) {
    const rule = styleSource.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`));
    assert.match(rule?.[1] ?? "", /min-width: 0;[\s\S]*flex: 1;/);
  }
  assert.match(styleSource, /#variation-selector\s*\{[^}]*width: 100%;/);

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

test("the complete header collapses only in the resumed active workspace and returns after tracking ends", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
  const css = fs.readFileSync(path.join(taggerDirectory, "sidepanel.css"), "utf8");
  const layoutSource = panelSource.match(
    /function updateLayoutOrder\(snapshot = streamSnapshot\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(layoutSource);
  assert.match(panelSource, /const appHeader = document\.querySelector\("\.app-header"\)/);

  const sectionNames = [
    "inventoryImportPanel", "streamSessionPanel", "savedSessionError",
    "trackerWorkspace", "streamReportsPanel", "appFooter",
  ];
  const setupOrder = [...sectionNames];
  const activeOrder = [
    "inventoryImportPanel", "savedSessionError", "trackerWorkspace",
    "streamSessionPanel", "streamReportsPanel", "appFooter",
  ];
  const activeErrorOrder = [
    "inventoryImportPanel", "savedSessionError", "streamSessionPanel",
    "trackerWorkspace", "streamReportsPanel", "appFooter",
  ];
  const appHeader = { hidden: false };
  const orders = [];
  const context = vm.createContext({
    appHeader,
    ...Object.fromEntries(sectionNames.map((name) => [name, Object.freeze({ id: name })])),
    reorderAppSections(sections) {
      orders.push(Array.from(sections, (section) => section.id));
    },
  });
  vm.runInContext(layoutSource, context);
  const activeSession = Object.freeze({ streamId: "synthetic-header-stream" });
  const transitions = [
    { label: "pre-stream", activeSession: null, resumed: false, phase: "idle", hidden: false, order: setupOrder },
    { label: "active workspace", activeSession, resumed: true, phase: "active", hidden: true, order: activeOrder },
    { label: "active busy transition", activeSession, resumed: true, phase: "ending", hidden: true, order: activeOrder },
    { label: "active error", activeSession, resumed: true, phase: "error", hidden: true, order: activeErrorOrder },
    { label: "ended stream", activeSession: null, resumed: false, phase: "idle", hidden: false, order: setupOrder },
    { label: "awaiting resume", activeSession, resumed: false, phase: "ready", hidden: false, order: setupOrder },
    { label: "resumed again", activeSession, resumed: true, phase: "active", hidden: true, order: activeOrder },
    { label: "inactive despite stale resumed flag", activeSession: null, resumed: true, phase: "idle", hidden: false, order: setupOrder },
  ];
  for (const transition of transitions) {
    const snapshot = Object.freeze({
      activeSession: transition.activeSession,
      resumed: transition.resumed,
      phase: transition.phase,
    });
    context.updateLayoutOrder(snapshot);
    assert.equal(appHeader.hidden, transition.hidden, transition.label);
    assert.deepEqual(orders.at(-1), transition.order, `${transition.label}: existing section order is preserved`);
  }

  const hiddenRule = css.match(/(?:^|\n)\[hidden\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(hiddenRule);
  assert.match(hiddenRule, /display:\s*none\s*!important\s*;/);
  assert.doesNotMatch(hiddenRule, /visibility\s*:\s*hidden/);
  assert.doesNotMatch(layoutSource, /(?:\.style\.|setAttribute\("style")/);
});

test("stable stream states hide redundant status copy while active tracking stays compact", () => {
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
    /\.stream-session-panel\[data-state="active"\] \.stream-session-heading\s*\{[\s\S]*?\}/,
  )?.[0];

  assert.ok(sessionMarkup);
  assert.ok(renderSource);
  assert.ok(activeHideRule);
  assert.match(sessionMarkup, /class="stream-session-heading"/);
  assert.doesNotMatch(sessionMarkup, /stream-session-safety-note/);
  assert.match(sessionMarkup, /id="stream-session-status-title"/);
  assert.match(sessionMarkup, /id="stream-session-status-message"/);
  assert.match(
    sessionMarkup,
    /id="start-stream"[\s\S]*?>\s*Start stream tracking\s*<\/button>/,
  );
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
    /const badgeContainer = !active\s*\? appHeader\s*:\s*dataState === "active"\s*\? streamSessionStatus\s*:\s*streamSessionHeading;/,
  );
  assert.match(
    renderSource,
    /if \(streamSessionBadge\.parentElement !== badgeContainer\) \{\s*badgeContainer\.append\(streamSessionBadge\);\s*\}/,
  );
  assert.match(
    renderSource,
    /streamSessionStatus\.hidden =\s*failed \|\| dataState === "inactive" \|\| dataState === "resume";/,
  );
  assert.match(renderSource, /streamSessionBadge\.hidden = dataState === "active";/);
  assert.match(renderSource, /streamSessionStatusMessage\.hidden = dataState === "active";/);
  assert.match(renderSource, /streamSessionBadge\.textContent = "";/);
  assert.match(
    renderSource,
    /streamSessionStatusTitle\.textContent = `Tracker Active \| Started \$\{startedLabel\}`;/,
  );
  assert.match(renderSource, /streamSessionStatusMessage\.textContent = "";/);
  assert.doesNotMatch(renderSource, /This local identity will survive panel and browser restarts/);
  assert.match(activeHideRule, /display:\s*none;/);
  assert.match(
    styleSource,
    /\.stream-session-status > \.stream-session-badge\s*\{[\s\S]*?margin-left:\s*auto;/,
  );
  assert.match(
    styleSource,
    /\.stream-session-panel\[data-state="active"\] \.stream-session-status\s*\{[\s\S]*?margin-top:\s*0;/,
  );
  assert.doesNotMatch(styleSource, /stream-session-safety-note/);
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
    /const selectionAllowed = group\.entries\.some\([\s\S]*?entry\.selectionAllowed[\s\S]*?button\.disabled = !selectionAllowed \|\| !canTagSelectedVariation/,
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
    /const reviewingRecordedHistory =[\s\S]+variations\.some\(\(variation\) => variation\.recorded\) && view\.isReviewingHistory/,
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
  assert.match(panelSource, /button\.dataset\.selected = String\(selected\)/);
  assert.match(
    panelSource,
    /if \(multipleSizes\) \{[\s\S]*?button\.setAttribute\("role", "combobox"\)[\s\S]*?\} else \{[\s\S]*?button\.setAttribute\("aria-pressed", String\(selected\)\)/,
  );
  assert.match(panelSource, /Click to unselect this item/);
  assert.doesNotMatch(
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
  assert.doesNotMatch(
    panelSource,
    /renderOrderStatuses|getInventoryTagLabel|isInventoryReservationPending|auctionStatus|tiktokPaymentStatus|paymentPrice|mappingStatus/,
  );
  assert.match(workflowSource, /"Payment status unavailable"/);
  assert.match(workflowSource, /mapped: "Item selected"/);
  assert.match(
    panelSource,
    /function isObservedCompletionAwaitingPrice\(auction\)/,
  );
  assert.doesNotMatch(panelSource, /Final price syncing - item reserved/);
  assert.match(
    panelSource,
    /TikTok shows Payment complete, but the final price is still syncing\./,
  );
  assert.match(panelSource, /remains reserved and pending/);
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
  assert.doesNotMatch(
    panelSource,
    /OBSERVED_PAYMENT_STATUSES|getSafeObservedPaymentStatus/,
  );
  assert.match(
    panelSource,
    /function getObservedPaymentStatusLabel\(value\)/,
  );
  assert.doesNotMatch(
    styleSource,
    /\.pending-status|\.order-statuses|\.inventory-tag-status|\.payment-price/,
  );
  assert.match(panelSource, /stateWarning\.textContent !== warning/);
  assert.doesNotMatch(panelSource, /this pending mapping/);
  assert.doesNotMatch(mappingSource, /undoPaymentComplete/);
  assert.doesNotMatch(
    mappingSource,
    /chrome\.storage|sendMessage|\bfetch\s*\(|sheets\.googleapis|completed_sale_detected/,
  );
});

test("compact order box appears only in history and preserves live rendering and focus", () => {
  const source = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );
  const nameStart = source.indexOf("function formatItemName(entry)");
  const nameEnd = source.indexOf("function createInventoryCard", nameStart);
  const renderStart = source.indexOf("function renderAuction(view)");
  const renderEnd = source.indexOf("function describeSelectedVariation", renderStart);

  assert.ok(nameStart >= 0 && nameEnd > nameStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);

  let activeView = null;
  const calls = [];
  let headingFocusCount = 0;
  let variationFocusCount = 0;
  const sandbox = {
    getActiveView: () => activeView,
    mappedVariation: { textContent: "" },
    mappedItem: { textContent: "" },
    pendingMapping: { hidden: true, dataset: {} },
    pendingMappingTitle: {
      focus() { headingFocusCount += 1; },
    },
    variationSelector: {
      focus() { variationFocusCount += 1; },
    },
    renderVariationNavigation: (view) => calls.push(["navigation", view]),
    renderLiveAuction: (view) => calls.push(["live", view]),
    renderSaleResults: (view) => calls.push(["sale", view]),
    renderStateWarning: (view) => calls.push(["warning", view]),
    renderInventory: (view) => calls.push(["inventory", view]),
    renderMetrics: (view) => calls.push(["metrics", view]),
  };
  vm.runInNewContext(
    `${source.slice(nameStart, nameEnd)}\n${source.slice(renderStart, renderEnd)}`,
    sandbox,
  );

  const cases = [
    { sku: "KOREA", item: "korea vulture", style: "tee", label: "korea vulture - tee" },
    { sku: "LA-M", item: "LA", style: "hoodie", label: "LA - hoodie" },
    { sku: null, item: null, style: null, label: "-" },
    { sku: "PLAIN", item: "plain", style: "", label: "plain" },
    {
      sku: "KOREA",
      item: "korea vulture",
      style: "tee",
      label: "korea vulture - tee",
      paymentStatus: "canceled",
      status: "canceled",
      variationNumber: 78,
    },
  ];

  for (const example of cases) {
    const { label, ...identity } = example;
    const auction = Object.freeze({
      variationNumber: 79,
      paymentStatus: "payment_complete",
      status: "committed",
      size: "OS",
      ...identity,
    });
    activeView = Object.freeze({
      auction,
      inventory: Object.freeze([]),
      isReviewingHistory: true,
      selectedVariationNumber: auction.variationNumber,
      currentVariationNumber: 80,
    });
    calls.length = 0;
    const previousHeadingFocus = headingFocusCount;

    assert.equal(sandbox.renderAll({ focusStatus: true }), activeView);
    assert.equal(sandbox.mappedVariation.textContent, `#${auction.variationNumber}`);
    assert.equal(sandbox.mappedItem.textContent, label);
    assert.equal(sandbox.pendingMapping.hidden, false);
    assert.equal(sandbox.pendingMapping.dataset.status, auction.status);
    assert.equal(headingFocusCount, previousHeadingFocus + 1);
    assert.equal(variationFocusCount, 0);
    assert.deepEqual(calls.map(([name]) => name), [
      "navigation", "live", "sale", "warning", "inventory", "metrics",
    ]);
    assert.ok(calls.every(([, view]) => view === activeView));
  }

  const historicalView = activeView;
  for (const activeBiddingVariationNumber of [80, null]) {
    activeView = {
      ...historicalView,
      auction: { variationNumber: 80, sku: null },
      selectedVariationNumber: 80,
      activeBiddingVariationNumber,
      isReviewingHistory: false,
    };
    calls.length = 0;
    const previousHeadingFocus = headingFocusCount;

    sandbox.renderAll({ focusStatus: true });
    assert.equal(sandbox.pendingMapping.hidden, true);
    assert.equal(headingFocusCount, previousHeadingFocus);
    assert.deepEqual(calls.map(([name]) => name), [
      "navigation", "live", "inventory", "metrics",
    ]);

    activeView = historicalView;
    sandbox.renderAll();
    assert.equal(sandbox.pendingMapping.hidden, false);
    assert.equal(sandbox.mappedVariation.textContent, "#78");
  }

  const previousHeadingFocus = headingFocusCount;
  activeView = { auction: null, inventory: [] };
  calls.length = 0;
  sandbox.renderAll({ focusStatus: true });
  assert.equal(sandbox.pendingMapping.hidden, true);
  assert.equal(headingFocusCount, previousHeadingFocus);
  assert.ok(calls.every(([name]) => name !== "sale" && name !== "warning"));
  sandbox.renderAll({ focusVariation: true });
  assert.equal(variationFocusCount, 1);
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
  assert.match(panelSource, /nextItemQueueClient\.getQueueSnapshot\(\)/);
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
    /\.inventory-card\[data-selected="true"\]\[data-queued="true"\]\s*\{[\s\S]+linear-gradient\([\s\S]+90deg,[\s\S]+var\(--cyan\) 0 50%,[\s\S]+#ff737e 50% 100%/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-current-mapped="true"\]\s*\{[\s\S]+#62aaff/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-selected="true"\]\[data-current-mapped="true"\]\s*\{[\s\S]+var\(--cyan\) 0 50%[\s\S]+#62aaff 50% 100%/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-current-mapped="true"\]\[data-queued="true"\]\s*\{[\s\S]+#62aaff 0 50%[\s\S]+#ff737e 50% 100%/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-selected="true"\]\[data-current-mapped="true"\]\[data-queued="true"\]\s*\{[\s\S]+var\(--cyan\) 0 33\.333%[\s\S]+#62aaff 33\.333% 66\.666%[\s\S]+#ff737e 66\.666% 100%/,
  );
  assert.match(html, /data-field="queued"[^>]*>Queued<\/span>/);
  assert.match(html, /data-field="current-mapped"[^>]*>Live<\/span>/);
});

function createInventoryCardBadgeHarness() {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
  const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");
  const templateSource = html.match(
    /<template id="inventory-card-template">([\s\S]*?)<\/template>/,
  )?.[1];
  const cardSource = panelSource.slice(
    panelSource.indexOf("function createInventoryCard(group, view)"),
    panelSource.indexOf("function formatResultCount("),
  );
  const currentMappingSource = panelSource.slice(
    panelSource.indexOf("function findVariationOption("),
    panelSource.indexOf("function getObservedPaymentStatusLabel("),
  );
  const viewModel = require("../extension/tagger/inventory-view-model.js");

  assert.ok(templateSource, "use the actual inventory card template");
  assert.ok(cardSource.length > 0, "execute the actual inventory card renderer");
  assert.ok(currentMappingSource.length > 0);

  function cloneTemplate() {
    const elements = [...templateSource.matchAll(/<([a-z]+)\b([^>]*)>([^<]*)/gi)]
      .map(([, tagName, attributeSource, textContent]) => {
        const attributes = Object.fromEntries(
          [...attributeSource.matchAll(/([\w-]+)="([^"]*)"/g)]
            .map(([, name, value]) => [name, value]),
        );
        return {
          tagName,
          attributes,
          dataset: {},
          hidden: /\bhidden(?:\s|$)/.test(attributeSource),
          textContent: textContent.trim(),
          setAttribute(name, value) {
            this.attributes[name] = String(value);
          },
          getAttribute(name) {
            return this.attributes[name] ?? null;
          },
        };
      });
    const wrapper = elements[0];
    wrapper.querySelector = (selector) => {
      const field = selector.match(/^\[data-field="([^"]+)"\]$/)?.[1];
      const element = elements.find((candidate) => field
        ? candidate.attributes["data-field"] === field
        : candidate.attributes.class?.split(/\s+/).includes(selector.slice(1)));
      assert.ok(element, `template contains ${selector}`);
      return element;
    };
    return wrapper;
  }

  const sandbox = {
    cardTemplate: { content: { firstElementChild: { cloneNode: cloneTemplate } } },
    queuedNextItemSku: null,
    viewModel: {
      getPreferredInventoryGroupEntry: viewModel.getPreferredInventoryGroupEntry,
      getInventoryGroupStockDisplay: () => ({ state: "in_stock", label: "3 left" }),
    },
    inventoryGroupOrderController: { isGroupPinned: () => false },
    formatItemName: (group) => `${group.item} ${group.style}`,
    hasSelectedRecordedVariation: () => true,
    hasSelectedEditableVariation: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${currentMappingSource}\n${cardSource}`, sandbox);

  return {
    render({
      selectedSku = null,
      liveSku = null,
      queuedSku = null,
      reviewingHistory = true,
      status = "pending",
      paymentStatus = "payment_processing",
      sizes = ["M"],
    } = {}) {
      const group = {
        key: "test-tee-black",
        item: "Test tee",
        style: "Black",
        entries: sizes.map((size) => ({
          sku: `TEE-${size}`,
          size,
          selected: selectedSku === `TEE-${size}`,
          selectionAllowed: true,
        })),
      };
      const view = {
        variationNumber: reviewingHistory ? 100 : 115,
        selectedVariationNumber: reviewingHistory ? 100 : 115,
        currentVariationNumber: 115,
        isReviewingHistory: reviewingHistory,
        auction: { sku: selectedSku, status, paymentStatus },
        activeAuctionMapping: { variationNumber: 115, sku: liveSku },
        variations: [],
      };
      const originalGroup = JSON.stringify(group);
      const originalView = JSON.stringify(view);
      sandbox.queuedNextItemSku = queuedSku;
      const wrapper = sandbox.createInventoryCard(group, view);
      assert.equal(JSON.stringify(group), originalGroup, "badges must not change inventory");
      assert.equal(JSON.stringify(view), originalView, "badges must not change mappings");
      return {
        button: wrapper.querySelector(".inventory-card"),
        badges: wrapper.querySelector(".inventory-card-badges"),
        selected: wrapper.querySelector('[data-field="selected"]'),
        live: wrapper.querySelector('[data-field="current-mapped"]'),
        queued: wrapper.querySelector('[data-field="queued"]'),
        size: wrapper.querySelector('[data-field="size"]'),
      };
    },
  };
}

test("inventory cards independently label every selected, live, and queued combination", () => {
  const harness = createInventoryCardBadgeHarness();
  const selectedStates = [
    { status: "pending", paymentStatus: "payment_processing", label: "Selected" },
    { status: "committed", paymentStatus: "payment_complete", label: "Sold" },
    { status: "canceled", paymentStatus: "canceled", label: "Canceled item" },
  ];

  for (const state of selectedStates) {
    for (const selected of [false, true]) {
      for (const live of [false, true]) {
        for (const queued of [false, true]) {
          const card = harness.render({
            ...state,
            selectedSku: selected ? "TEE-M" : null,
            liveSku: live ? "TEE-M" : null,
            queuedSku: queued ? "TEE-M" : null,
          });
          const context =
            `${state.label}: selected=${selected}, live=${live}, queued=${queued}`;
          assert.equal(card.selected.hidden, !selected, context);
          assert.equal(card.live.hidden, !live, context);
          assert.equal(card.queued.hidden, !queued, context);
          assert.equal(card.badges.hidden, !(selected || live || queued), context);
          assert.equal(
            card.selected.textContent,
            selected ? state.label : "Selected",
            context,
          );
          assert.equal(card.live.textContent, "Live", context);
          assert.equal(card.queued.textContent, "Queued", context);
          assert.equal(card.button.dataset.selected, String(selected), context);
          assert.equal(card.button.dataset.currentMapped, String(live), context);
          assert.equal(card.button.dataset.queued, String(queued), context);
          assert.equal(card.button.dataset.sku, "TEE-M", context);
          assert.equal(card.button.getAttribute("aria-pressed"), String(selected), context);
          assert.equal(card.button.disabled, false, context);
        }
      }
    }
  }
});

test("inventory card badges clear with state changes and hide Live in current view", () => {
  const harness = createInventoryCardBadgeHarness();
  const states = [
    {
      input: { selectedSku: "TEE-M", liveSku: "TEE-M", queuedSku: "TEE-M" },
      visible: [true, true, true],
    },
    {
      input: { selectedSku: "TEE-M", liveSku: "TEE-M" },
      visible: [true, true, false],
    },
    {
      input: { selectedSku: "TEE-M", liveSku: "TEE-M", reviewingHistory: false },
      visible: [true, false, false],
    },
    { input: { queuedSku: "TEE-M" }, visible: [false, false, true] },
    { input: {}, visible: [false, false, false] },
  ];

  for (const { input, visible } of states) {
    const card = harness.render(input);
    assert.deepEqual(
      [!card.selected.hidden, !card.live.hidden, !card.queued.hidden],
      visible,
    );
    assert.equal(card.badges.hidden, !visible.some(Boolean));
  }
});

test("grouped inventory card badges retain distinct exact-SKU selections and queue state", () => {
  const harness = createInventoryCardBadgeHarness();
  const card = harness.render({
    sizes: ["S", "M", "L"],
    selectedSku: "TEE-S",
    liveSku: "TEE-M",
    queuedSku: "TEE-L",
  });

  assert.deepEqual(
    [card.selected.hidden, card.live.hidden, card.queued.hidden],
    [false, false, false],
  );
  assert.equal(card.badges.hidden, false);
  assert.equal(card.button.dataset.focusSku, "TEE-S");
  assert.equal(card.size.textContent, "S");
  assert.equal(
    card.button.dataset.sku,
    undefined,
    "a grouped card cannot become a single-SKU action",
  );
  assert.deepEqual(JSON.parse(card.button.dataset.variantSkus), ["TEE-S", "TEE-M", "TEE-L"]);
  assert.equal(card.button.getAttribute("role"), "combobox");
  assert.equal(card.button.getAttribute("aria-pressed"), null);
  assert.match(card.button.getAttribute("aria-label"), /Size S is selected for variation 100/);
  assert.match(card.button.getAttribute("aria-label"), /Queued for the next variation/);
  assert.match(card.button.getAttribute("aria-label"), /selected for current variation 115/);

  const unrelated = harness.render({
    sizes: ["S", "M", "L"],
    selectedSku: "OTHER-S",
    liveSku: "OTHER-M",
    queuedSku: "OTHER-L",
  });
  assert.deepEqual(
    [unrelated.selected.hidden, unrelated.live.hidden, unrelated.queued.hidden],
    [true, true, true],
  );
  assert.equal(unrelated.badges.hidden, true, "matching only a size must not produce a badge");
});

test("inventory cards keep smaller titles at top left and compact stock at bottom right without overlap positioning", () => {
  const css = fs.readFileSync(path.join(extensionDirectory, "tagger", "sidepanel.css"), "utf8");
  const block = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
    assert.ok(match, `${selector} has a style rule`);
    return match[1];
  };
  const card = block(".inventory-card");
  const heading = block(".card-heading");
  const title = block(".card-title");
  const meta = block(".card-meta");
  const stock = block(".stock-label");
  const pin = block(".inventory-pin-button");
  assert.match(card, /display: flex;/);
  assert.match(card, /flex-direction: column;/);
  assert.match(card, /align-items: stretch;/);
  assert.match(card, /padding: 12px 10px 10px 12px;/);
  assert.match(card, /min-height: 120px;/, "The normal card minimum height stays unchanged");
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*?\.inventory-card\s*\{\s*min-height: 112px;/);
  assert.match(title, /font-size: 13px;/, "Item and style inherit the smaller title size");
  assert.match(title, /overflow-wrap: anywhere;/);
  assert.match(heading, /flex-shrink: 0;/);
  assert.match(heading, /padding-right: 30px;/);
  assert.match(meta, /margin-top: auto;/, "The footer uses remaining height to sit at the bottom");
  assert.match(meta, /padding-top: 16px;/, "Keep a minimum gap below long titles and stacked badges");
  assert.match(meta, /flex-wrap: wrap;/, "Stock can wrap below size on narrow cards");
  assert.match(meta, /flex-shrink: 0;/);
  assert.match(stock, /font-size: 11px;/);
  assert.match(stock, /align-self: flex-end;/);
  assert.match(stock, /margin-left: auto;/);
  assert.match(stock, /text-align: right;/);
  assert.match(block(".stock-line"), /overflow-wrap: anywhere;/);
  assert.match(block(".size-value"), /white-space: normal;/);
  assert.match(block('.size-value [data-field="size"]'), /min-width: 0;[\s\S]*overflow-wrap: anywhere;/);
  assert.doesNotMatch(heading + title + meta + stock, /position:\s*(?:absolute|fixed)/,
    "Long content remains in layout flow instead of overlapping the count");
  assert.match(pin, /top: 8px;[\s\S]*right: 8px;/);
  assert.match(pin, /width: 28px;[\s\S]*height: 28px;/);
  assert.match(block(".inventory-pin-button svg"), /width: 16px;[\s\S]*height: 16px;/);
  const cardRightPadding = Number(card.match(/padding:\s*\d+px\s+(\d+)px/)[1]);
  const headingReserve = Number(heading.match(/padding-right:\s*(\d+)px/)[1]);
  const pinRight = Number(pin.match(/right:\s*(\d+)px/)[1]);
  const pinWidth = Number(pin.match(/width:\s*(\d+)px/)[1]);
  assert.ok(cardRightPadding + headingReserve >= pinRight + pinWidth + 4,
    "Heading reserves room for the pin and a gap");
});

test("inventory card badges stay compact, clear pins, and match size-picker colors", () => {
  const styleSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.html"),
    "utf8",
  );
  const badgeStyle = styleSource.match(/\.inventory-card-badge\s*\{([^}]+)\}/)?.[1];
  const stackStyle = styleSource.match(/\.inventory-card-badges\s*\{([^}]+)\}/)?.[1];
  const headingStyle = styleSource.match(/\.card-heading\s*\{([^}]+)\}/)?.[1];

  assert.ok(badgeStyle);
  assert.ok(stackStyle);
  assert.ok(headingStyle);
  assert.match(html, /class="inventory-card-badges" hidden/);
  assert.match(badgeStyle, /font-size: 8px/);
  assert.match(badgeStyle, /padding: 2px 5px/);
  assert.match(badgeStyle, /line-height: 1\.25/);
  assert.match(badgeStyle, /max-width: 100%/);
  assert.match(badgeStyle, /overflow-wrap: anywhere/);
  assert.match(stackStyle, /flex-direction: column/);
  assert.match(stackStyle, /gap: 3px/);
  assert.match(headingStyle, /display: flex/);
  assert.match(headingStyle, /flex-wrap: wrap/);
  assert.match(headingStyle, /padding-right: 30px/);
  assert.match(styleSource, /\[hidden\]\s*\{\s*display: none !important;/);

  for (const tone of ["selected", "current", "queued"]) {
    const cardStyle = styleSource.match(new RegExp(
      `\\.inventory-card-badge\\[data-tone="${tone}"\\]\\s*\\{([^}]+)\\}`,
    ))?.[1];
    const optionStyle = styleSource.match(new RegExp(
      `\\.inventory-size-option-badge\\[data-tone="${tone}"\\]\\s*\\{([^}]+)\\}`,
    ))?.[1];
    assert.ok(cardStyle, `${tone} card badge has its own color rule`);
    assert.ok(optionStyle, `${tone} size-picker badge has a color rule`);
    assert.equal(cardStyle.trim(), optionStyle.trim(), `${tone} colors stay consistent`);
  }
});

test("inventory hover preserves every selection outline and keyboard focus", () => {
  const styleSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.css"),
    "utf8",
  );
  const hoverRules = [...styleSource.matchAll(/(\.inventory-card[^{}]*:hover[^{}]*)\{([^}]+)\}/g)];

  assert.equal(hoverRules.length, 1, "only one card hover rule can override status borders");
  assert.equal(
    hoverRules[0][1].trim(),
    ".inventory-card:where(:not(:disabled):hover)",
    ":where keeps hover below all attribute-based status rules in specificity",
  );
  assert.match(hoverRules[0][2], /border-color: var\(--border-strong\);/);
  assert.match(hoverRules[0][2], /transform: translateY\(-1px\);/);
  assert.doesNotMatch(hoverRules[0][2], /!important|background|box-shadow|outline/);

  const states = ["selected", "current-mapped", "queued"];
  for (let mask = 1; mask < 8; mask += 1) {
    const attributes = states.filter((_, index) => mask & (1 << index))
      .map((state) => `[data-${state}="true"]`).join("");
    const selector = `.inventory-card${attributes}`;
    const rules = [...styleSource.matchAll(/(\.inventory-card[^{}]*)\{([^}]+)\}/g)];
    const rule = rules.find((match) => match[1].trim() === selector)?.[2];

    assert.ok(rule, `${selector} retains its status outline`);
    const border = mask === 1 ? "var(--cyan)" : mask === 2 ? "#62aaff" : "transparent";
    assert.ok(rule.includes(`border-color: ${border};`), selector);
    assert.match(rule, /background:/);
    assert.match(rule, /box-shadow:/);
  }

  assert.match(
    styleSource,
    /\.inventory-card:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus\);/,
  );
});

test("placeholder sizes stay invisible on single-SKU cards without changing spacing", () => {
  const taggerDirectory = path.join(extensionDirectory, "tagger");
  const panelSource = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(taggerDirectory, "sidepanel.css"), "utf8");
  const sizeDisplaySource = panelSource.match(
    /button\.dataset\.placeholderSize = String\([\s\S]*?\);/,
  )?.[0];

  assert.ok(sizeDisplaySource);
  assert.match(
    styleSource,
    /\.inventory-card\[data-placeholder-size="true"\] \.size-label\s*\{\s*visibility: hidden;\s*\}/,
    "hide the full label and value while preserving their layout space",
  );

  const placeholderSizes = ["OS", "os", "N/A", "na", "n/a", "NA", " OS "];
  const realSizes = ["S", "M", "XL", "7", "10.5", "OSFM", "N/A-XL", "", null];

  for (const size of [...placeholderSizes, ...realSizes]) {
    for (const multipleSizes of [false, true]) {
      const representativeEntry = Object.freeze({ sku: "EXACT-SKU", size });
      const button = { dataset: {} };
      vm.runInNewContext(sizeDisplaySource, { button, representativeEntry, multipleSizes });
      assert.equal(
        button.dataset.placeholderSize,
        String(!multipleSizes && placeholderSizes.includes(size)),
        `size ${size}, multiple sizes ${multipleSizes}`,
      );
      assert.deepEqual(representativeEntry, { sku: "EXACT-SKU", size });
    }
  }
});

test("grouped multi-size inventory cards keep exact-SKU mapping and queue actions accessible", () => {
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
  const cardSource = panelSource.slice(
    panelSource.indexOf("function createInventoryCard(group, view)"),
    panelSource.indexOf("function formatResultCount("),
  );
  const sizeActionDescriptionSource = panelSource.slice(
    panelSource.indexOf("function getInventorySizeOptionActionDescription("),
    panelSource.indexOf("function renderInventorySizeOptions("),
  );
  const sizeOptionsSource = panelSource.slice(
    panelSource.indexOf("function renderInventorySizeOptions(group, view, intent)"),
    panelSource.indexOf("function hideInventorySizeListbox()"),
  );
  const activeSizeSource = panelSource.slice(
    panelSource.indexOf("function setActiveInventorySize(sku, options = {})"),
    panelSource.indexOf("function moveActiveInventorySize(offset)"),
  );
  const releaseSource = panelSource.slice(
    panelSource.indexOf("function releaseInventorySizeMenu(options = {})"),
    panelSource.indexOf("function resetInventorySizeMenu()"),
  );
  const deferredFlushSource = panelSource.slice(
    panelSource.indexOf("function flushDeferredInventoryRender()"),
    panelSource.indexOf("function resetInventorySizeMenu()"),
  );
  const openSizeMenuSource = panelSource.slice(
    panelSource.indexOf("function openInventorySizeMenu(trigger, intent"),
    panelSource.indexOf("function getVariationOptionDisplay("),
  );
  const inventoryRenderer = panelSource.slice(
    panelSource.indexOf("function renderInventory(view, focusSku = null)"),
    panelSource.indexOf("function renderMetrics(view)"),
  );
  const pickerActionSource = panelSource.slice(
    panelSource.indexOf("function selectInventorySizeFromPicker(sku)"),
    panelSource.indexOf("function commitActiveInventorySize()"),
  );
  const pickerKeyboardSource = panelSource.slice(
    panelSource.indexOf("function handleInventorySizeMenuKeydown(event)"),
    panelSource.indexOf('searchInput.addEventListener("input"'),
  );
  const inventoryClickSource = panelSource.slice(
    panelSource.indexOf('inventoryGrid.addEventListener("click"'),
    panelSource.indexOf('inventoryGrid.addEventListener("contextmenu"'),
  );
  const inventoryContextSource = panelSource.slice(
    panelSource.indexOf('inventoryGrid.addEventListener("contextmenu"'),
    panelSource.indexOf('inventoryGrid.addEventListener("keydown"'),
  );

  assert.ok(cardSource.length > 0);
  assert.ok(sizeActionDescriptionSource.length > 0);
  assert.ok(sizeOptionsSource.length > 0);
  assert.ok(activeSizeSource.length > 0);
  assert.ok(releaseSource.length > 0);
  assert.ok(deferredFlushSource.length > 0);
  assert.ok(openSizeMenuSource.length > 0);
  assert.ok(inventoryRenderer.length > 0);
  assert.ok(pickerActionSource.length > 0);
  assert.ok(pickerKeyboardSource.length > 0);

  assert.match(
    html,
    /id="inventory-size-listbox-label"[\s\S]*?Choose an inventory size[\s\S]*?id="inventory-size-listbox"[\s\S]*?role="listbox"[\s\S]*?tabindex="-1"[\s\S]*?aria-labelledby="inventory-size-listbox-label"[\s\S]*?popover="manual"[\s\S]*?hidden/,
  );
  assert.match(
    html,
    /Search inventory by SKU, item, style, or size[\s\S]*?placeholder="Search SKU, item, style, or size"/,
  );

  assertTextOrder(
    inventoryRenderer,
    [
      "viewModel.groupInventoryEntries(view.inventory)",
      "inventoryGroupOrderController.order(",
      "viewModel.filterInventoryGroups(",
      "const visibleInventory = inventoryListExpanded",
      "visibleInventory.forEach((group)",
      "createInventoryCard(group, view)",
    ],
    "inventory rows must be grouped, pin-ordered, and filtered before visible whole groups render",
  );
  assert.match(
    inventoryRenderer,
    /inventoryGroupOrderController\.order\(\s*inventoryGroups,\s*view,?\s*\)/,
  );
  assert.match(
    inventoryRenderer,
    /if \(inventorySizeMenuState\) \{[\s\S]*?deferredInventoryRender = \{ view, focusSku \};[\s\S]*?return;/,
  );

  assert.match(cardSource, /const multipleSizes = group\.entries\.length > 1/);
  assert.match(
    cardSource,
    /button\.dataset\.variantSkus = JSON\.stringify\([\s\S]*?group\.entries\.map\(\(entry\) => entry\.sku\)/,
  );
  assert.match(
    cardSource,
    /if \(!multipleSizes && representativeEntry\) \{[\s\S]*?button\.dataset\.sku = representativeEntry\.sku/,
  );
  assert.match(
    cardSource,
    /if \(multipleSizes\) \{[\s\S]*?setAttribute\("role", "combobox"\)[\s\S]*?aria-haspopup", "listbox"[\s\S]*?aria-controls", "inventory-size-listbox"[\s\S]*?aria-expanded", "false"[\s\S]*?aria-autocomplete", "none"/,
  );
  assert.match(
    inventoryClickSource,
    /button\.dataset\.multipleSizes === "true"[\s\S]*?openInventorySizeMenu\(button, "ordinary"\)[\s\S]*?saveOrdinaryInventorySelection\(button, view\)/,
  );
  assert.match(
    inventoryContextSource,
    /button\.dataset\.multipleSizes === "true"[\s\S]*?openInventorySizeMenu\(button, "context"\)[\s\S]*?mapCurrentVariationFromHistory\(button, view\)[\s\S]*?toggleNextItemQueue\(button, view\)/,
  );

  assert.match(
    cardSource,
    /const selectedEntry = group\.entries\.find\(\(entry\) => entry\.selected\) \?\? null/,
  );
  assert.match(
    cardSource,
    /const queuedEntry = group\.entries\.find\([\s\S]*?entry\.sku === queuedNextItemSku/,
  );
  assert.match(
    cardSource,
    /const mappedToCurrent =[\s\S]*?group\.entries\.some\(\(entry\) => entry\.sku === currentMappedSku\)/,
  );
  assert.match(cardSource, /button\.dataset\.queued = String\(queued\)/);
  assert.match(
    cardSource,
    /button\.dataset\.currentMapped = String\(mappedToCurrent\)/,
  );
  assert.match(
    cardSource,
    /button\.dataset\.selected = String\(selected\)/,
  );
  assert.match(
    cardSource,
    /if \(multipleSizes\) \{[\s\S]*?button\.setAttribute\("role", "combobox"\)[\s\S]*?\} else \{[\s\S]*?button\.setAttribute\("aria-pressed", String\(selected\)\)/,
  );
  assert.doesNotMatch(
    cardSource.slice(
      cardSource.indexOf("if (multipleSizes)"),
      cardSource.indexOf("} else {", cardSource.indexOf("if (multipleSizes)")),
    ),
    /aria-pressed/,
    "multi-size combobox cards must not expose the button-only aria-pressed state",
  );
  assert.match(
    cardSource,
    /\[data-field="size-caption"\]'\)\.hidden = multipleSizes/,
  );
  assert.match(
    cardSource,
    /\[data-field="size"\]'\)\.textContent = multipleSizes[\s\S]*?\? preferredEntry[\s\S]*?\? preferredEntry\.size \|\| "No size"[\s\S]*?: "Choose size"/,
  );

  assert.match(
    sizeActionDescriptionSource,
    /intent === "ordinary"[\s\S]*?Unmap this size from variation[\s\S]*?Map variation[\s\S]*?if \(reviewingHistory\)[\s\S]*?Unmap this size from current variation[\s\S]*?Map current variation[\s\S]*?Remove this size from the next variation queue[\s\S]*?Queue this size for the next variation without changing the current mapping/,
  );
  assert.match(
    sizeOptionsSource,
    /function renderInventorySizeOptions\(group, view, intent\)/,
  );
  assert.match(sizeOptionsSource, /option\.dataset\.sku = entry\.sku/);
  assert.match(
    sizeOptionsSource,
    /option\.setAttribute\("role", "option"\)[\s\S]*?aria-selected[\s\S]*?aria-disabled/,
  );
  assert.match(
    sizeOptionsSource,
    /if \(selected\)[\s\S]*?createInventorySizeBadge\("Selected", "selected"\)[\s\S]*?if \(mappedToCurrent\)[\s\S]*?createInventorySizeBadge\("Live", "current"\)[\s\S]*?if \(queued\)[\s\S]*?createInventorySizeBadge\("Queued", "queued"\)/,
  );
  assert.match(
    sizeOptionsSource,
    /entry\.selectionAllowed[\s\S]*?getInventorySizeOptionActionDescription\(entry, view, intent\)[\s\S]*?: entry\.selectionReason/,
  );
  assert.match(
    activeSizeSource,
    /trigger\.setAttribute\("aria-activedescendant", nextRow\.id\)/,
  );
  assert.match(
    panelSource,
    /inventorySizeListbox\.addEventListener\("click",[\s\S]*?selectInventorySizeFromPicker\(option\.dataset\.sku\)/,
  );
  assert.match(
    pickerActionSource,
    /view\?\.inventory\.find\(\(candidate\) => candidate\.sku === sku\)[\s\S]*?const actionTarget = \{ dataset: \{ sku \} \}/,
  );
  assert.match(
    openSizeMenuSource,
    /inventorySizeMenuState = \{[\s\S]*?groupKey: group\.key,[\s\S]*?intent,[\s\S]*?trigger,[\s\S]*?streamId: mountedStreamId,[\s\S]*?selectedVariationNumber: view\.selectedVariationNumber,[\s\S]*?currentVariationNumber: view\.currentVariationNumber[\s\S]*?\};[\s\S]*?renderInventorySizeOptions\(group, view, intent\)/,
  );
  assert.match(
    pickerActionSource,
    /state\.streamId !== mountedStreamId \|\|[\s\S]*?state\.selectedVariationNumber !== view\?\.selectedVariationNumber \|\|[\s\S]*?state\.currentVariationNumber !== view\?\.currentVariationNumber/,
  );
  assertTextOrder(
    pickerActionSource,
    [
      "state.streamId !== mountedStreamId",
      "releaseInventorySizeMenu()",
      "The live variation changed while you were choosing a size",
      "return;",
      "if (!state || !view || !entry || !entry.selectionAllowed)",
      "const intent = state.intent",
    ],
    "a size action must be refused before mapping if its pinned stream or variation context changed",
  );
  assertTextOrder(
    pickerActionSource,
    [
      'if (intent === "ordinary")',
      "saveOrdinaryInventorySelection(actionTarget, view)",
      "view.isReviewingHistory",
      "mapCurrentVariationFromHistory(actionTarget, view)",
      "toggleNextItemQueue(actionTarget, view)",
    ],
    "an exact child SKU must route to ordinary mapping, historical live mapping, or current queueing",
  );

  assertTextOrder(
    releaseSource,
    [
      "const deferred = deferredInventoryRender",
      "inventorySizeMenuState = null",
      "hideInventorySizeListbox()",
      "if (flush && deferred?.view)",
      "deferredInventoryRender = null",
      "renderInventory(deferred.view, null)",
    ],
    "closing the size picker must flush only its latest deferred inventory view",
  );
  assert.doesNotMatch(
    releaseSource.slice(0, releaseSource.indexOf("if (flush && deferred?.view)")),
    /deferredInventoryRender = null/,
    "flush=false must preserve a deferred view while switching directly to another card",
  );
  assert.match(
    releaseSource,
    /if \(flush && deferred\?\.view\) \{[\s\S]*?deferredInventoryRender = null;[\s\S]*?renderInventory\(deferred\.view, null\)[\s\S]*?\} else if \(flush\) \{[\s\S]*?deferredInventoryRender = null/,
  );
  assert.match(
    openSizeMenuSource,
    /if \(inventorySizeMenuState\) \{[\s\S]*?releaseInventorySizeMenu\(\{ flush: false \}\)/,
  );
  assert.match(
    deferredFlushSource,
    /if \(inventorySizeMenuState \|\| !deferredInventoryRender\?\.view\) \{[\s\S]*?return;[\s\S]*?const deferred = deferredInventoryRender;[\s\S]*?const focusedInventorySku = getFocusedInventorySku\(\);[\s\S]*?const focusSku = focusedInventorySku \?\?[\s\S]*?deferred\.focusSku[\s\S]*?deferredInventoryRender = null;[\s\S]*?renderInventory\(deferred\.view, focusSku\)/,
  );
  assert.match(
    pickerKeyboardSource,
    /event\.key === "Escape"[\s\S]*?event\.key === "ArrowDown"[\s\S]*?event\.key === "ArrowUp"[\s\S]*?event\.key === "Home"[\s\S]*?event\.key === "End"[\s\S]*?event\.key === "Enter"[\s\S]*?event\.key === "Tab"/,
  );
  assert.match(
    pickerKeyboardSource,
    /event\.key === "Tab"[\s\S]*?releaseInventorySizeMenu\(\{ flush: false \}\)[\s\S]*?window\.setTimeout\(flushDeferredInventoryRender, 0\)/,
  );
  assert.match(
    pickerKeyboardSource,
    /event\.key === "ContextMenu" \|\| \(event\.shiftKey && event\.key === "F10"\)[\s\S]*?openInventorySizeMenu\(button, "context"\)/,
  );
  assert.match(
    pickerKeyboardSource,
    /document\.addEventListener\([\s\S]*?"pointerdown"[\s\S]*?!inventorySizeListbox\.contains\(event\.target\)[\s\S]*?releaseInventorySizeMenu\(/,
  );
  assert.match(
    pickerKeyboardSource,
    /document\.addEventListener\("focusin",[\s\S]*?!inventorySizeListbox\.contains\(event\.target\)[\s\S]*?releaseInventorySizeMenu\(\)/,
  );

  assert.match(
    styleSource,
    /\.inventory-card\[data-multiple-sizes="true"\] \.size-chevron\s*\{[\s\S]*?display: inline-block/,
  );
  assert.match(
    styleSource,
    /\.card-meta\s*\{[\s\S]*?display: flex[\s\S]*?flex-wrap: wrap[\s\S]*?gap: 8px/,
  );
  assert.match(
    styleSource,
    /\.size-value\s*\{[\s\S]*?white-space: normal/,
  );
  assert.match(
    styleSource,
    /\.inventory-size-listbox\s*\{[\s\S]*?position: fixed[\s\S]*?overflow-y: auto/,
  );
  assert.match(
    styleSource,
    /\.inventory-size-option\[data-active="true"\][\s\S]*?background:/,
  );
  assert.match(
    styleSource,
    /\.inventory-size-option-badge\[data-tone="selected"\][\s\S]*?var\(--cyan\)[\s\S]*?\.inventory-size-option-badge\[data-tone="current"\][\s\S]*?#62aaff[\s\S]*?\.inventory-size-option-badge\[data-tone="queued"\][\s\S]*?#ff737e/,
  );
  assert.match(
    styleSource,
    /\.inventory-card\[data-selected="true"\]\[data-current-mapped="true"\]\[data-queued="true"\][\s\S]*?var\(--cyan\) 0 33\.333%[\s\S]*?#62aaff 33\.333% 66\.666%[\s\S]*?#ff737e 66\.666% 100%/,
  );
});

test("inventory cards stay capped at nine until the user expands the list", () => {
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
  const toggleMarkup = html.match(
    /<button\s+id="inventory-list-toggle"[\s\S]*?<\/button>/,
  )?.[0];
  const inventoryRenderer = panelSource.slice(
    panelSource.indexOf("function renderInventory(view, focusSku = null)"),
    panelSource.indexOf("function renderMetrics(view)"),
  );
  const toggleHandler = panelSource.slice(
    panelSource.indexOf('inventoryListToggle.addEventListener("click"'),
    panelSource.indexOf('inventorySizeListbox.addEventListener("keydown"'),
  );
  const unmountSource = panelSource.slice(
    panelSource.indexOf("function unmountPersistentController()"),
    panelSource.indexOf("function mountPersistentController("),
  );

  assert.ok(toggleMarkup);
  assert.match(toggleMarkup, /type="button"/);
  assert.match(toggleMarkup, /aria-expanded="false"/);
  assert.match(toggleMarkup, /aria-controls="inventory-grid"/);
  assert.match(toggleMarkup, /\shidden/);
  assert.match(toggleMarkup, />Show all items</);
  assert.match(toggleMarkup, /class="inventory-list-toggle-chevron"[^>]+aria-hidden="true"/);

  assert.match(panelSource, /const COLLAPSED_INVENTORY_ITEM_LIMIT = 9;/);
  assert.match(panelSource, /let inventoryListExpanded = false;/);
  assertTextOrder(
    inventoryRenderer,
    [
      "inventoryGroupOrderController.order(",
      "viewModel.filterInventoryGroups(",
      "const visibleInventory = inventoryListExpanded",
      "filteredInventory.slice(0, COLLAPSED_INVENTORY_ITEM_LIMIT)",
      "visibleInventory.forEach((group)",
    ],
    "the nine-card limit must be applied after pin ordering and search filtering",
  );
  assert.match(
    inventoryRenderer,
    /inventoryListToggle\.hidden\s*=\s*[\s\S]*?filteredInventory\.length <= COLLAPSED_INVENTORY_ITEM_LIMIT/,
  );
  assert.match(
    inventoryRenderer,
    /inventoryListToggle\.setAttribute\([\s\S]*?"aria-expanded",[\s\S]*?String\(inventoryListExpanded\)/,
  );
  assert.match(
    inventoryRenderer,
    /inventoryListToggleLabel\.textContent = inventoryListExpanded[\s\S]*?"Show fewer items"[\s\S]*?: "Show all items"/,
  );
  assert.match(
    toggleHandler,
    /inventoryListExpanded = !inventoryListExpanded;[\s\S]*?inventoryListExpanded[\s\S]*?trimPinnedGroups\([\s\S]*?COLLAPSED_INVENTORY_ITEM_LIMIT[\s\S]*?const view = getActiveView\(\);[\s\S]*?if \(view\) \{[\s\S]*?renderInventory\(view\)/,
  );
  assert.match(
    toggleHandler,
    /trimmedPins\?\.changed[\s\S]*?unpinnedGroupKeys\.length[\s\S]*?first \$\{COLLAPSED_INVENTORY_ITEM_LIMIT\} pinned items remain pinned/,
  );
  assert.doesNotMatch(inventoryRenderer, /inventoryListExpanded\s*=\s*false/);
  assert.doesNotMatch(unmountSource, /inventoryListExpanded\s*=/);
  assert.match(unmountSource, /inventoryGroupOrderController\.reset\(\)/);

  assert.match(
    styleSource,
    /\.inventory-list-toggle\s*\{[\s\S]*?display: flex;[\s\S]*?width: 100%;/,
  );
  assert.match(
    styleSource,
    /\.inventory-list-toggle\[aria-expanded="true"\][\s\S]*?\.inventory-list-toggle-chevron\s*\{[\s\S]*?rotate\(225deg\)/,
  );
});

test("inventory pin controls are accessible and isolated from mapping actions", () => {
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
  const templateSource = html.match(
    /<template id="inventory-card-template">[\s\S]*?<\/template>/,
  )?.[0];
  const cardSource = panelSource.slice(
    panelSource.indexOf("function createInventoryCard(group, view)"),
    panelSource.indexOf("function formatResultCount("),
  );
  const togglePinSource = panelSource.slice(
    panelSource.indexOf("function toggleInventoryGroupPin(pinButton)"),
    panelSource.indexOf("function findInventoryGroup("),
  );
  const inventoryRenderer = panelSource.slice(
    panelSource.indexOf("function renderInventory(view, focusSku = null)"),
    panelSource.indexOf("function renderMetrics(view)"),
  );
  const firstClickHandlerStart = panelSource.indexOf(
    'inventoryGrid.addEventListener("click"',
  );
  const secondClickHandlerStart = panelSource.indexOf(
    'inventoryGrid.addEventListener("click"',
    firstClickHandlerStart + 1,
  );
  const contextHandlerStart = panelSource.indexOf(
    'inventoryGrid.addEventListener("contextmenu"',
  );
  const pinClickSource = panelSource.slice(
    firstClickHandlerStart,
    secondClickHandlerStart,
  );
  const mappingClickSource = panelSource.slice(
    secondClickHandlerStart,
    contextHandlerStart,
  );

  assert.ok(templateSource);
  assert.match(
    templateSource,
    /class="inventory-card-wrapper"[\s\S]*?<button[\s\S]*?class="inventory-pin-button"[\s\S]*?data-field="pin"[\s\S]*?type="button"[\s\S]*?aria-pressed="false"[\s\S]*?<\/button>\s*<button class="inventory-card" type="button">/,
    "the pin must be a sibling of the mapping card, never a nested button",
  );
  assert.match(
    templateSource,
    /class="inventory-pin-button"[\s\S]*?<svg[\s\S]*?aria-hidden="true"[\s\S]*?focusable="false"/,
  );
  assert.match(
    panelSource,
    /createInventoryGroupOrderController\(\{[\s\S]*?maxPinnedGroups: COLLAPSED_INVENTORY_ITEM_LIMIT/,
  );
  assert.match(
    cardSource,
    /const pinButton = wrapper\.querySelector\("\.inventory-pin-button"\)[\s\S]*?isGroupPinned\(group\.key\)[\s\S]*?pinButton\.dataset\.groupKey = group\.key[\s\S]*?aria-pressed[\s\S]*?Unpin[\s\S]*?Pin/,
  );
  assert.match(
    pinClickSource,
    /closest\?\.\("\.inventory-pin-button"\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?toggleInventoryGroupPin\(pinButton\)/,
  );
  assertTextOrder(
    mappingClickSource,
    [
      'event.target.closest?.(".inventory-pin-button")',
      "return;",
      'event.target.closest?.(".inventory-card")',
      "saveOrdinaryInventorySelection(button, view)",
    ],
    "pin clicks must be rejected before ordinary mapping logic",
  );
  assert.match(
    togglePinSource,
    /const pinLimit = inventoryListExpanded[\s\S]*?inventoryGroups\.length[\s\S]*?: COLLAPSED_INVENTORY_ITEM_LIMIT[\s\S]*?togglePinnedGroup\([\s\S]*?groupKey,[\s\S]*?pinLimit[\s\S]*?result\.limitReached[\s\S]*?pin up to \$\{pinLimit\} items[\s\S]*?renderInventory\(view\)[\s\S]*?restoreInventoryPinFocus\(groupKey\)/,
  );
  assert.match(
    togglePinSource,
    /pinned at position \$\{result\.pinnedPosition\}[\s\S]*?returned to original inventory order after pinned items/,
  );
  assert.doesNotMatch(togglePinSource, /recent-sale|remains frozen|reviewingHistory/);
  assertTextOrder(
    inventoryRenderer,
    [
      'closest?.(".inventory-pin-button")',
      "inventoryGrid.replaceChildren(fragment)",
      "restoreInventoryPinFocus(focusedPinGroupKey)",
    ],
    "background inventory renders must restore focus to a recreated pin control",
  );
  assert.match(
    styleSource,
    /\.inventory-card-wrapper\s*\{[\s\S]*?position: relative/,
  );
  assert.match(
    styleSource,
    /\.inventory-pin-button\s*\{[\s\S]*?position: absolute[\s\S]*?z-index: 2[\s\S]*?width: 28px[\s\S]*?height: 28px[\s\S]*?border-radius: 8px/,
  );
  assert.match(
    styleSource,
    /\.inventory-pin-button svg\s*\{[\s\S]*?width: 16px[\s\S]*?height: 16px/,
  );
  assert.match(
    styleSource,
    /\.card-heading\s*\{[\s\S]*?padding-right: 30px/,
  );
  assert.match(
    styleSource,
    /\.inventory-pin-button:focus-visible[\s\S]*?outline: 2px solid var\(--focus\)/,
  );
  assert.match(
    styleSource,
    /\.inventory-pin-button\[aria-pressed="true"\][\s\S]*?background: var\(--cyan\)/,
  );
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
    /function createInventoryCard\(group, view\) \{[\s\S]*?function formatResultCount/,
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
    /const selectionAllowed = group\.entries\.some\([\s\S]*?entry\.selectionAllowed[\s\S]*?button\.disabled = !selectionAllowed \|\| !canTagSelectedVariation/,
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
});

test("tagger lists, opens, refreshes, and requires local report creation when ending", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
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
  const readinessSource = panelSource.match(
    /function describeReportReadiness\([\s\S]*?function openStreamReport/,
  )?.[0];
  const reportLinkSource = panelSource.match(
    /function createStreamReportLink\(summary, options = \{\}\)[\s\S]*?function renderStreamReportsPanel/,
  )?.[0];
  const endConfirmation = html.match(
    /id="stream-session-end-confirmation"[\s\S]*?id="stream-session-error"/,
  )?.[0];

  assert.ok(readinessSource);
  assert.ok(reportLinkSource);
  assert.ok(endConfirmation);
  assert.match(
    readinessSource,
    /No captured issues currently require attention\./,
  );
  assert.match(readinessSource, /Report attention items:/);
  assert.match(readinessSource, /pending mapped order/);
  assert.match(readinessSource, /payment-error order/);
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
  assert.match(reportLinkSource, /const reportDisplayName = getReportDisplayName\(summary\)/);
  assert.match(reportLinkSource, /title\.textContent = reportDisplayName/);
  assert.match(reportLinkSource, /`Open \$\{reportDisplayName\}`/);
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
    /async function refreshStreamReports\(options = \{\}\)[\s\S]+streamReportsOpenLatestPending \|\|= options\.openLatest === true[\s\S]+Promise\.all\([\s\S]+streamReportClient\.listReports\(\)[\s\S]+streamReportClient\.listArchivedReports\(\)[\s\S]+streamReportClient\.getLibraryCapacity\(\)[\s\S]+dashboardResponse\.reports[\s\S]+archivedResponse\.reports[\s\S]+const openLatest = streamReportsOpenLatestPending[\s\S]+openStreamReport\(latest\.reportId\)/,
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
    endConfirmation,
    /id="cancel-end-stream"[\s\S]+Keep stream active[\s\S]+id="confirm-end-stream"[\s\S]+stream-session-full-end-action[\s\S]+End and create report/,
  );
  assert.match(
    styleSource,
    /\.stream-session-full-end-action\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/,
  );
  assert.match(
    styleSource,
    /\.stream-session-end-confirmation\s*\{[\s\S]*?margin-top:\s*8px;[\s\S]*?padding:\s*9px;/,
  );
  assert.match(
    styleSource,
    /\.stream-session-end-confirmation \.end-report-readiness\s*\{[\s\S]*?margin:\s*0;[\s\S]*?line-height:\s*1\.35;/,
  );
  assert.doesNotMatch(styleSource, /\.stream-session-end-confirmation h3/);
  assert.doesNotMatch(panelSource,
    /endActiveStreamWithoutReport|confirmEndStreamWithoutReportButton|endStreamWithoutReportButton/);
  assert.doesNotMatch(html, /(?:confirm-)?end-stream-without-report|End without report/);
  assert.match(styleSource,
    /\.stream-session-confirm-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
});

test("dashboard report names use the saved custom name with tracking start as the default", () => {
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"),
    "utf8",
  );
  const displayNameSource = panelSource.match(
    /function getReportDisplayName\(summary\)[\s\S]*?function setReportRenameError/,
  )?.[0];
  const requestRenameSource = panelSource.match(
    /function requestReportRename\(summary, returnFocusTarget\)[\s\S]*?async function savePendingReportName/,
  )?.[0];
  const saveRenameSource = panelSource.match(
    /async function savePendingReportName\(displayName\)[\s\S]*?function createStreamReportLink/,
  )?.[0];
  const renameSubmitSource = panelSource.match(
    /reportRenameForm\.addEventListener\("submit"[\s\S]*?reportRenameInput\.addEventListener\("input"/,
  )?.[0];

  assert.ok(displayNameSource);
  assert.ok(requestRenameSource);
  assert.ok(saveRenameSource);
  assert.ok(renameSubmitSource);
  assert.match(
    displayNameSource,
    /typeof summary\?\.displayName === "string"[\s\S]+summary\.displayName\.trim\(\) !== ""[\s\S]+\? summary\.displayName[\s\S]+: formatReportTimestamp\(summary\?\.startedAt\)/,
  );
  assert.match(
    requestRenameSource,
    /const defaultName = formatReportTimestamp\(summary\.startedAt\)/,
  );
  assert.match(
    requestRenameSource,
    /reportRenameInput\.value = customName \?\? defaultName/,
  );
  assert.match(requestRenameSource, /resetReportNameButton\.hidden = customName === null/);
  assert.match(requestRenameSource, /reportRenameDialog\.showModal\(\)/);
  assert.match(requestRenameSource, /reportRenameInput\.focus\(\)/);
  assert.match(requestRenameSource, /reportRenameInput\.select\(\)/);

  assert.match(
    saveRenameSource,
    /streamReportClient\.renameReport\(\{[\s\S]+reportId: pending\.reportId,[\s\S]+displayName,[\s\S]+\}\)/,
  );
  assert.match(
    saveRenameSource,
    /streamReportSummaries = streamReportSummaries\.map\([\s\S]+\{ \.\.\.summary, displayName \}/,
  );
  assert.match(saveRenameSource, /await refreshStreamReports\(\)/);
  assert.match(
    saveRenameSource,
    /displayName === null[\s\S]+The report is using its default name\.[\s\S]+Report renamed to \$\{displayName\}\./,
  );
  assert.match(saveRenameSource, /reportRenameDialog\.close\("saved"\)/);

  assert.match(renameSubmitSource, /const displayName = reportRenameInput\.value\.trim\(\)/);
  assert.match(renameSubmitSource, /displayName\.length < 1/);
  assert.match(renameSubmitSource, /displayName\.length > MAX_REPORT_DISPLAY_NAME_LENGTH/);
  assert.match(renameSubmitSource, /\[\\u0000-\\u001f\\u007f\]/);
  assert.match(
    renameSubmitSource,
    /pendingReportRename\.customName === null[\s\S]+displayName === pendingReportRename\.defaultName[\s\S]+\? null[\s\S]+: displayName/,
  );
  assert.match(renameSubmitSource, /savePendingReportName\(savedDisplayName\)/);
  assert.match(
    panelSource,
    /resetReportNameButton\.addEventListener\("click"[\s\S]+savePendingReportName\(null\)/,
  );
});

test("current and archived report labels prefer tracking start without changing custom names or timestamps", () => {
  const panelSource = fs.readFileSync(
    path.join(extensionDirectory, "tagger", "sidepanel.js"), "utf8",
  );
  const context = vm.createContext({});
  const timestampFunction = panelSource.match(
    /function formatReportTimestamp\(value\)[\s\S]*?(?=function describeReportReadiness)/,
  )[0];
  const nameFunction = panelSource.match(
    /function getReportDisplayName\(summary\)[\s\S]*?(?=function setReportRenameError)/,
  )[0];
  vm.runInContext(`${timestampFunction}\n${nameFunction}`, context);
  const startedAt = "2026-09-08T01:00:00.000Z";
  const endedAt = "2026-09-08T03:00:00.000Z";
  const startName = context.formatReportTimestamp(startedAt);
  const endName = context.formatReportTimestamp(endedAt);
  assert.notEqual(startName, endName);
  for (const displayName of [undefined, null, "", "  ", "Friends stream", endName]) {
    const summary = Object.freeze({ startedAt, endedAt, displayName });
    assert.equal(context.getReportDisplayName(summary), displayName?.trim() ? displayName : startName);
    assert.equal(summary.startedAt, startedAt);
    assert.equal(summary.endedAt, endedAt);
  }
  for (const startedAt of [undefined, "invalid"]) {
    assert.equal(context.getReportDisplayName({ startedAt, endedAt }), "Saved stream");
  }
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
    /id="report-action-confirmation"[\s\S]+aria-labelledby="report-action-confirmation-title"/,
  );
  assert.match(
    html,
    /id="report-rename-dialog"[\s\S]+aria-labelledby="report-rename-title"[\s\S]+aria-describedby="report-rename-description report-rename-error"/,
  );
  assert.match(
    html,
    /id="report-rename-input"[\s\S]+type="text"[\s\S]+maxlength="80"[\s\S]+required/,
  );
  assert.match(html, /id="report-rename-error"[\s\S]+role="alert"[\s\S]+hidden/);
  assert.match(html, /id="cancel-report-rename"[\s\S]*?>\s*Cancel\s*</);
  assert.match(html, /id="reset-report-name"[\s\S]*?>\s*Use default\s*</);
  assert.match(html, /id="save-report-name"[\s\S]*?>\s*Save name\s*</);
  assert.doesNotMatch(
    html,
    /report-action-confirmation-message|This permanently deletes the saved report/,
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
    /async function runReportMutation\(action, reportIds, options = \{\}\)[\s\S]*?function requestPermanentReportDeletion/,
  )?.[0];

  assert.ok(reportLinkSource);
  assert.ok(mutationSource);
  assert.match(reportLinkSource, /aria-haspopup/);
  assert.match(reportLinkSource, /aria-expanded/);
  assert.match(reportLinkSource, /aria-controls/);
  assert.match(reportLinkSource, /`More actions for \$\{reportDisplayName\}`/);
  assert.match(reportLinkSource, /role", "menu"/);
  assert.match(panelSource, /button\.setAttribute\("role", "menuitem"\)/);
  assert.match(
    reportLinkSource,
    /if \(!archived\) \{[\s\S]+createReportMenuAction\("Rename", "rename"[\s\S]+requestReportRename\(summary, moreButton\)[\s\S]+createReportMenuAction\("Archive", "archive"/,
  );
  assert.match(reportLinkSource, /"Archive", "archive"/);
  assert.match(reportLinkSource, /"Delete", "delete"/);
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
  assert.match(mutationSource, /streamReportClient\.deleteReports\(\{ reportIds: ids \}\)/);
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
    /confirmReportActionButton\.addEventListener\("click"[\s\S]+pendingReportDeletion = null;[\s\S]+reportActionConfirmation\.close\(\)[\s\S]+runReportMutation\("delete", reportIds, \{ archived \}\)/,
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
    "shared/capture-health.js",
    "capture/capture-health-reporter.js",
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
