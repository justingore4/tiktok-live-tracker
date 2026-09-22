"use strict";

importScripts(
  "shared/reconciliation.js",
  "shared/reconciliation-storage.js",
  "shared/reconciliation-coordinator.js",
  "shared/stream-report.js",
  "shared/stream-report-protocol.js",
  "shared/stream-report-storage.js",
  "shared/stream-report-coordinator.js",
  "shared/stream-session.js",
  "shared/stream-session-storage.js",
  "shared/stream-session-coordinator.js",
  "shared/live-bid-protocol.js",
  "shared/live-bid-storage.js",
  "shared/live-bid-coordinator.js",
  "shared/next-item-queue-protocol.js",
  "shared/next-item-queue-storage.js",
  "shared/next-item-queue-coordinator.js",
  "shared/variation-presets-protocol.js",
  "shared/variation-presets-storage.js",
  "shared/variation-presets-coordinator.js",
  "shared/capture-protocol.js",
  "shared/capture-health.js",
  "shared/capture-integration.js",
  "shared/inventory-sheet-import.js",
  "shared/inventory-import-protocol.js",
  "shared/google-sheets-inventory-import.js",
  "shared/report-quantity-handoff.js",
);

const reconciliation = globalThis.TikTokLiveTrackerReconciliation;
const reconciliationStorage =
  globalThis.TikTokLiveTrackerReconciliationStorage;
const reconciliationCoordinator =
  globalThis.TikTokLiveTrackerReconciliationCoordinator;
const streamReport = globalThis.TikTokLiveTrackerStreamReport;
const streamReportProtocol =
  globalThis.TikTokLiveTrackerStreamReportProtocol;
const streamReportStorage =
  globalThis.TikTokLiveTrackerStreamReportStorage;
const streamReportCoordinator =
  globalThis.TikTokLiveTrackerStreamReportCoordinator;
const streamSession = globalThis.TikTokLiveTrackerStreamSession;
const streamSessionStorage =
  globalThis.TikTokLiveTrackerStreamSessionStorage;
const streamSessionCoordinator =
  globalThis.TikTokLiveTrackerStreamSessionCoordinator;
const liveBidProtocol = globalThis.TikTokLiveTrackerLiveBidProtocol;
const liveBidStorage = globalThis.TikTokLiveTrackerLiveBidStorage;
const liveBidCoordinatorModule =
  globalThis.TikTokLiveTrackerLiveBidCoordinator;
const nextItemQueueProtocol =
  globalThis.TikTokLiveTrackerNextItemQueueProtocol;
const nextItemQueueStorage =
  globalThis.TikTokLiveTrackerNextItemQueueStorage;
const nextItemQueueCoordinatorModule =
  globalThis.TikTokLiveTrackerNextItemQueueCoordinator;
const variationPresetsProtocol = globalThis.TikTokLiveTrackerVariationPresetsProtocol;
const variationPresetsStorage = globalThis.TikTokLiveTrackerVariationPresetsStorage;
const variationPresetsCoordinatorModule = globalThis.TikTokLiveTrackerVariationPresetsCoordinator;
const captureProtocol = globalThis.TikTokLiveTrackerCaptureProtocol;
const captureHealth = globalThis.TikTokLiveTrackerCaptureHealth;
const captureIntegration = globalThis.TikTokLiveTrackerCaptureIntegration;
const inventorySheetImport =
  globalThis.TikTokLiveTrackerInventorySheetImport;
const inventoryImportProtocol =
  globalThis.TikTokLiveTrackerInventoryImportProtocol;
const googleSheetsInventoryImport =
  globalThis.TikTokLiveTrackerGoogleSheetsInventoryImport;
const reportQuantityHandoff = globalThis.TikTokLiveTrackerReportQuantityHandoff;
let storageAccessError = null;
const storageAccessReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
])
  .catch((error) => {
    storageAccessError = error;
    console.error(
      "[TikTok Live Tracker] Could not restrict local storage access.",
      error,
    );
  });
const stateStore = reconciliationStorage.createReconciliationStateStore({
  storageArea: chrome.storage.local,
  reconciliation,
});
const stateCoordinator =
  reconciliationCoordinator.createReconciliationCoordinator({
    reconciliation,
    stateStore,
  });
const reportStore = streamReportStorage.createStreamReportStore({
  storageArea: chrome.storage.local,
  streamReport,
});
const reportCoordinator =
  streamReportCoordinator.createStreamReportCoordinator({
    now: () => new Date().toISOString(),
    protocol: streamReportProtocol,
    reconciliation,
    reportStore,
    storage: streamReportStorage,
    streamReport,
  });
const streamSessionStore =
  streamSessionStorage.createStreamSessionStateStore({
    storageArea: chrome.storage.local,
    streamSession,
  });
const activeStreamCoordinator =
  streamSessionCoordinator.createStreamSessionCoordinator({
    streamSession,
    stateStore: streamSessionStore,
    createId: () => `local-stream:${globalThis.crypto.randomUUID()}`,
    now: () => new Date().toISOString(),
  });
const liveBidStore = liveBidStorage.createLiveBidStore({
  storageArea: chrome.storage.session,
});
const liveBidCoordinator =
  liveBidCoordinatorModule.createLiveBidCoordinator({
    activeStreamCoordinator,
    liveBidStore,
    reconciliation,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
const nextItemQueueStore =
  nextItemQueueStorage.createNextItemQueueStore({
    storageArea: chrome.storage.session,
  });
const nextItemQueueCoordinator =
  nextItemQueueCoordinatorModule.createNextItemQueueCoordinator({
    activeStreamCoordinator,
    protocol: nextItemQueueProtocol,
    queueStore: nextItemQueueStore,
    reconciliation,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
let presetLiveProjectionDirty = false;
const variationPresetsStore = variationPresetsStorage.createVariationPresetsStore({
  storageArea: chrome.storage.local,
  protocol: variationPresetsProtocol,
});
const variationPresetsCoordinator =
  variationPresetsCoordinatorModule.createVariationPresetsCoordinator({
    activeStreamCoordinator,
    streamSession,
    streamSessionCoordinator,
    stateCoordinator,
    reconciliation,
    reconciliationCoordinator,
    protocol: variationPresetsProtocol,
    presetStore: variationPresetsStore,
    clearConflictingQueue: async (streamId, context) => {
      const outcome = await nextItemQueueCoordinator.clearForPresets({ streamId, ...context });
      if (outcome?.status === "cleared") notifyNextItemQueueChanged();
    },
    onChange: ({ canonicalChanged = false } = {}) => {
      if (canonicalChanged) presetLiveProjectionDirty = true;
      notifyPresetsChanged();
      if (canonicalChanged) notifyCaptureStateChanged();
    },
  });
const captureEventIntegration =
  captureIntegration.createCaptureIntegration({
    activeStreamCoordinator,
    captureProtocol,
    liveBidCoordinator,
    nextItemQueueCoordinator,
    variationPresetsCoordinator,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
const inventoryImportService =
  googleSheetsInventoryImport.createGoogleSheetsInventoryImportService({
    abortController: globalThis.AbortController,
    assertActiveStream: requireActiveStreamForInventoryUpdate,
    assertNoActiveStream: requireNoActiveStreamForInventoryImport,
    clearTimeoutImpl: (...args) => globalThis.clearTimeout(...args),
    createBaseline: (command) =>
      stateCoordinator.dispatch({
        type:
          reconciliationCoordinator.COMMAND_TYPES
            .CREATE_INVENTORY_BASELINE,
        ...command,
      }),
    createUuid: () => globalThis.crypto.randomUUID(),
    extendStreamBaseline: (command) =>
      stateCoordinator.dispatch({
        type:
          reconciliationCoordinator.COMMAND_TYPES
            .EXTEND_STREAM_INVENTORY_BASELINE,
        ...command,
      }),
    fetchImpl: (...args) => globalThis.fetch(...args),
    getActiveBaseline: getActiveInventoryBaseline,
    identityApi: chrome.identity,
    inventorySheetImport,
    now: () => Date.now(),
    oauthClientId: chrome.runtime.getManifest()?.oauth2?.client_id,
    setTimeoutImpl: (...args) => globalThis.setTimeout(...args),
  });
const sidePanelUrl = chrome.runtime.getURL("tagger/sidepanel.html");
const reportPageUrl = chrome.runtime.getURL("report/report.html");
const reportReadCommandTypes = new Set([
  streamReportProtocol.COMMAND_TYPES.GET_LIBRARY_CAPACITY,
  streamReportProtocol.COMMAND_TYPES.LIST_REPORTS,
  streamReportProtocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
  streamReportProtocol.COMMAND_TYPES.GET_REPORT,
  streamReportProtocol.COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS,
  streamReportProtocol.COMMAND_TYPES.LIST_REPORT_UNIT_COSTS,
]);
const reportPageOnlyCommandTypes = new Set([
  streamReportProtocol.COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF,
  streamReportProtocol.COMMAND_TYPES.COPY_QUANTITY_HANDOFF,
  streamReportProtocol.COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS,
  streamReportProtocol.COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER,
  streamReportProtocol.COMMAND_TYPES.LIST_REPORT_UNIT_COSTS,
  streamReportProtocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
]);
const reportMutationCommandTypes = new Set([
  streamReportProtocol.COMMAND_TYPES.RENAME_REPORT,
  streamReportProtocol.COMMAND_TYPES.ARCHIVE_REPORTS,
  streamReportProtocol.COMMAND_TYPES.RESTORE_REPORTS,
  streamReportProtocol.COMMAND_TYPES.DELETE_REPORTS,
  streamReportProtocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
  streamReportProtocol.COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER,
  streamReportProtocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
  streamReportProtocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
]);
const captureDashboardUrlPattern =
  /^https:\/\/shop\.tiktok\.com\/streamer\/live\/product\/dashboard(?:[?#]|$)/;
const captureStateChangedNotification = Object.freeze({
  channel: "tiktok-live-tracker.capture-state",
  version: 1,
  event: Object.freeze({ type: "capture_state_changed" }),
});
const liveBidChangedNotification = Object.freeze(
  liveBidProtocol.createLiveBidChangedNotification(),
);
const nextItemQueueChangedNotification = Object.freeze(
  nextItemQueueProtocol.createQueueChangedNotification(),
);
const reportLibraryChangedNotification = Object.freeze(
  streamReportProtocol.createReportLibraryChangedNotification(),
);
let messageTail = Promise.resolve();
// Deliberately ephemeral: no Sheet identity, physical layout, token, or clipboard
// output is written into canonical inventory or saved report storage.
const quantityHandoffs = new Map();
const MAX_QUANTITY_HANDOFFS = 5;
const captureHealthStore = captureHealth?.createCaptureHealthStore({
  now: () => Date.now(),
  createContextId: () => globalThis.crypto.randomUUID(),
});

function invalidateCaptureHealthTab(tabId, closed = false, documentChanged = false) {
  if (!captureHealthStore) return;
  const execution = messageTail.then(() => {
    // Retire document authority without clearing its completed startup latch.
    // A newly observed owner document, rather than a tab event, starts a load.
    captureHealthStore.invalidateTab(tabId, { closed, documentChanged });
  });
  messageTail = execution.catch(() => undefined);
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  invalidateCaptureHealthTab(tabId, true);
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    invalidateCaptureHealthTab(tabId, false, changeInfo.status === "loading");
  }
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    console.error(
      "[TikTok Live Tracker] Could not configure the side panel.",
      error,
    );
  });

function failBoundary(protocol, code, message) {
  let BoundaryError =
    reconciliationCoordinator.ReconciliationCoordinatorError;

  if (protocol === captureProtocol) {
    BoundaryError = captureIntegration.CaptureIntegrationError;
  } else if (protocol === streamSessionCoordinator) {
    BoundaryError = streamSessionCoordinator.StreamSessionCoordinatorError;
  } else if (protocol === streamReportProtocol) {
    BoundaryError = streamReportProtocol.StreamReportProtocolError;
  } else if (protocol === inventoryImportProtocol) {
    BoundaryError = inventoryImportProtocol.InventoryImportProtocolError;
  } else if (protocol === liveBidProtocol) {
    BoundaryError = liveBidCoordinatorModule.LiveBidCoordinatorError;
  } else if (protocol === nextItemQueueProtocol) {
    BoundaryError =
      nextItemQueueCoordinatorModule.NextItemQueueCoordinatorError;
  } else if (protocol === variationPresetsProtocol) {
    BoundaryError = variationPresetsCoordinatorModule.VariationPresetsCoordinatorError;
  }

  throw new BoundaryError(code, message);
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getMessageBoundary(message) {
  if (!isRecord(message)) {
    return null;
  }

  if (message.channel === reconciliationCoordinator.MESSAGE_CHANNEL) {
    return {
      coordinator: stateCoordinator,
      label: "reconciliation",
      protocol: reconciliationCoordinator,
    };
  }

  if (message.channel === streamSessionCoordinator.MESSAGE_CHANNEL) {
    return {
      coordinator: activeStreamCoordinator,
      label: "stream-session",
      protocol: streamSessionCoordinator,
    };
  }

  if (message.channel === streamReportProtocol.MESSAGE_CHANNEL) {
    if (streamReportProtocol.isReportLibraryChangedNotification(message)) {
      return null;
    }

    return {
      coordinator: reportCoordinator,
      label: "stream-report",
      protocol: streamReportProtocol,
    };
  }

  if (message.channel === captureProtocol.MESSAGE_CHANNEL) {
    return {
      coordinator: captureEventIntegration,
      label: "capture",
      protocol: captureProtocol,
    };
  }

  if (message.channel === liveBidProtocol.MESSAGE_CHANNEL) {
    if (liveBidProtocol.isLiveBidChangedNotification(message)) {
      return null;
    }

    return {
      coordinator: liveBidCoordinator,
      label: "live-bid",
      protocol: liveBidProtocol,
    };
  }

  if (message.channel === nextItemQueueProtocol.MESSAGE_CHANNEL) {
    if (nextItemQueueProtocol.isQueueChangedNotification(message)) {
      return null;
    }

    return {
      coordinator: nextItemQueueCoordinator,
      label: "next-item queue",
      protocol: nextItemQueueProtocol,
    };
  }

  if (message.channel === inventoryImportProtocol.MESSAGE_CHANNEL) {
    return {
      coordinator: inventoryImportService,
      label: "inventory-import",
      protocol: inventoryImportProtocol,
    };
  }

  if (message.channel === variationPresetsProtocol.MESSAGE_CHANNEL) {
    if (variationPresetsProtocol.isPresetsChangedNotification(message)) return null;
    return {
      coordinator: variationPresetsCoordinator,
      label: "variation-presets",
      protocol: variationPresetsProtocol,
    };
  }

  return null;
}

function validateMessage(message, boundary) {
  const { label, protocol } = boundary;

  if (protocol === captureProtocol) {
    return captureProtocol.validateCaptureMessage(message);
  }

  if (protocol === liveBidProtocol) {
    return liveBidProtocol.validateLiveBidMessage(message);
  }

  if (protocol === nextItemQueueProtocol) {
    return nextItemQueueProtocol.validateNextItemQueueMessage(message);
  }

  if (protocol === variationPresetsProtocol) {
    return variationPresetsProtocol.validateMessage(message);
  }

  if (protocol === inventoryImportProtocol) {
    return inventoryImportProtocol.validateInventoryImportMessage(message);
  }

  if (protocol === streamReportProtocol) {
    return streamReportProtocol.validateStreamReportMessage(message);
  }

  const expectedKeys = ["channel", "command", "version"];
  const actualKeys = Object.keys(message).sort();

  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    !isRecord(message.command)
  ) {
    failBoundary(
      protocol,
      "INVALID_MESSAGE",
      `The ${label} message has an invalid shape.`,
    );
  }

  if (!Number.isSafeInteger(message.version) || message.version < 1) {
    failBoundary(
      protocol,
      "INVALID_MESSAGE",
      `The ${label} message version must be a positive integer.`,
    );
  }

  if (message.version !== protocol.MESSAGE_VERSION) {
    failBoundary(
      protocol,
      "UNSUPPORTED_MESSAGE_VERSION",
      `${label === "reconciliation" ? "Reconciliation" : "Stream-session"} message version ${message.version} is not supported.`,
    );
  }

  return message.command;
}

function validateSender(sender, command, boundary) {
  if (boundary.protocol === captureProtocol) {
    if (
      !sender ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !isRecord(sender.tab) ||
      typeof sender.url !== "string" ||
      !captureDashboardUrlPattern.test(sender.url)
    ) {
      failBoundary(
        boundary.protocol,
        "UNAUTHORIZED_MESSAGE_SENDER",
        "Only the top-level TikTok LIVE product dashboard can submit capture events.",
      );
    }

    return;
  }

  if (boundary.protocol === streamReportProtocol) {
    const fromSidePanel =
      sender?.id === chrome.runtime.id && sender.url === sidePanelUrl;
    const fromReportPage =
      sender?.id === chrome.runtime.id &&
      typeof sender.url === "string" &&
      (
        sender.url === reportPageUrl ||
        sender.url.startsWith(`${reportPageUrl}?`) ||
        sender.url.startsWith(`${reportPageUrl}#`)
      );
    if (
      command.type ===
        streamReportProtocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA
    ) {
      if (!fromReportPage) {
        failBoundary(
          boundary.protocol,
          "UNAUTHORIZED_MESSAGE_SENDER",
          "Only the packaged report page can load correction data.",
        );
      }

      return;
    }

    if (
      command.type ===
        streamReportProtocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS
    ) {
      if (!fromReportPage) {
        failBoundary(
          boundary.protocol,
          "UNAUTHORIZED_MESSAGE_SENDER",
          "Only the packaged report page can save mapping corrections.",
        );
      }

      return;
    }

    if (!fromSidePanel && !fromReportPage) {
      failBoundary(
        boundary.protocol,
        "UNAUTHORIZED_MESSAGE_SENDER",
        "Only the extension side panel and packaged report page can read stream reports.",
      );
    }

    if (
      fromSidePanel &&
      reportPageOnlyCommandTypes.has(command.type)
    ) {
      failBoundary(
        boundary.protocol,
        "UNAUTHORIZED_MESSAGE_SENDER",
        "Only the packaged report page can correct ended-stream report data.",
      );
    }

    if (
      fromReportPage &&
      !reportReadCommandTypes.has(command.type) &&
      ![
        streamReportProtocol.COMMAND_TYPES.RENAME_REPORT,
        streamReportProtocol.COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER,
        streamReportProtocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST,
        streamReportProtocol.COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF,
        streamReportProtocol.COMMAND_TYPES.COPY_QUANTITY_HANDOFF,
      ].includes(command.type)
    ) {
      failBoundary(
        boundary.protocol,
        "UNAUTHORIZED_MESSAGE_SENDER",
        "The packaged report page has read-only report access.",
      );
    }

    return;
  }

  if (
    !sender ||
    sender.id !== chrome.runtime.id ||
    sender.url !== sidePanelUrl
  ) {
    failBoundary(
      boundary.protocol,
      "UNAUTHORIZED_MESSAGE_SENDER",
      `This extension context cannot issue ${boundary.label} commands.`,
    );
  }

  if (
    boundary.protocol === reconciliationCoordinator &&
    [
      reconciliationCoordinator.COMMAND_TYPES.OBSERVE_VARIATIONS,
      reconciliationCoordinator.COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES,
      reconciliationCoordinator.COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV,
      reconciliationCoordinator.COMMAND_TYPES.OBSERVE_BIDDING_VARIATION,
      reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
    ].includes(command.type)
  ) {
    failBoundary(
      boundary.protocol,
      "UNAUTHORIZED_MESSAGE_SENDER",
      "Captured TikTok events cannot be issued by the side panel.",
    );
  }

  if (
    boundary.protocol === reconciliationCoordinator &&
    [
      reconciliationCoordinator.COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
      reconciliationCoordinator.COMMAND_TYPES
        .EXTEND_STREAM_INVENTORY_BASELINE,
    ].includes(command.type)
  ) {
    failBoundary(
      boundary.protocol,
      "UNAUTHORIZED_MESSAGE_SENDER",
      "Inventory baselines can be changed only through a validated Sheet import.",
    );
  }

  if (
    boundary.protocol === reconciliationCoordinator &&
    command.type ===
      reconciliationCoordinator.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE
  ) {
    failBoundary(
      boundary.protocol,
      "UNAUTHORIZED_MESSAGE_SENDER",
      "Inventory baseline pins are owned by the extension service worker.",
    );
  }
}

function hydrateStreamSessionResponse(response) {
  try {
    return streamSession.hydrateStreamSessionState(response?.state);
  } catch (_error) {
    failBoundary(
      streamSessionCoordinator,
      "ACTIVE_STREAM_STATE_UNAVAILABLE",
      "The active tracker stream could not be verified.",
    );
  }
}

function hydrateReconciliationResponse(response) {
  if (response?.state === null) {
    failBoundary(
      streamSessionCoordinator,
      "INVENTORY_BASELINE_REQUIRED",
      "Prepare inventory before starting a tracker stream.",
    );
  }

  try {
    return reconciliation.hydrateReconciliationState(response?.state);
  } catch (_error) {
    failBoundary(
      streamSessionCoordinator,
      "INVENTORY_BASELINE_UNAVAILABLE",
      "The prepared inventory baseline could not be verified.",
    );
  }
}

async function getStreamSessionResponse() {
  const response = await activeStreamCoordinator.dispatch({
    type:
      streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION,
  });
  const state = hydrateStreamSessionResponse(response);

  return { response, state };
}

async function requireNoActiveStreamForInventoryImport() {
  const { state } = await getStreamSessionResponse();

  if (state.activeSession !== null) {
    throw new googleSheetsInventoryImport.GoogleSheetsInventoryImportError(
      "ACTIVE_STREAM_ALREADY_EXISTS",
      "End the active tracker stream before importing inventory.",
    );
  }
}

async function requireActiveStreamForInventoryUpdate(streamId) {
  const { state } = await getStreamSessionResponse();

  if (
    state.activeSession === null ||
    state.activeSession.streamId !== streamId
  ) {
    throw new googleSheetsInventoryImport.GoogleSheetsInventoryImportError(
      "ACTIVE_STREAM_CHANGED",
      "The tracker stream changed while the Inventory tab was being checked. Nothing was added.",
    );
  }
}

async function getActiveStreamInventoryUpdateContext() {
  const { state: sessionState } = await getStreamSessionResponse();
  const activeSession = sessionState.activeSession;

  if (activeSession === null) {
    throw new googleSheetsInventoryImport.GoogleSheetsInventoryImportError(
      "NO_ACTIVE_STREAM",
      "Start or resume a tracker stream before adding new SKUs.",
    );
  }

  const pinnedResponse = await pinStreamToPreparedInventory(
    activeSession.streamId,
  );
  const reconciliationState = hydrateReconciliationResponse(pinnedResponse);
  const stream = reconciliationState.streams.find(
    (candidate) => candidate.streamId === activeSession.streamId,
  );

  if (
    !stream ||
    stream.inventoryBaselineId !==
      reconciliationState.activeInventoryBaselineId
  ) {
    throw new googleSheetsInventoryImport.GoogleSheetsInventoryImportError(
      "ACTIVE_INVENTORY_UNAVAILABLE",
      "The active stream inventory could not be verified. Nothing was added.",
    );
  }

  return {
    streamId: activeSession.streamId,
    expectedBaselineId: stream.inventoryBaselineId,
  };
}

async function addActiveStreamSkusFromGoogleSheet(spreadsheetId) {
  const context = await getActiveStreamInventoryUpdateContext();
  const result = await inventoryImportService
    .addActiveStreamSkusFromGoogleSheet(spreadsheetId, context);

  if (result?.status === "extended") {
    notifyCaptureStateChanged();
  }

  return result;
}

async function getActiveInventoryBaseline() {
  const response = await stateCoordinator.dispatch({
    type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
  });

  if (response?.state === null) {
    return null;
  }

  let state;

  try {
    state = reconciliation.hydrateReconciliationState(response?.state);
  } catch (_error) {
    throw new googleSheetsInventoryImport.GoogleSheetsInventoryImportError(
      "INVENTORY_BASELINE_UNAVAILABLE",
      "The prepared inventory baseline could not be verified.",
    );
  }

  return state.inventoryBaselines.find(
    (baseline) => baseline.baselineId === state.activeInventoryBaselineId,
  ) ?? null;
}

async function requirePreparedInventoryBaseline(options = {}) {
  const response = await stateCoordinator.dispatch({
    type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
  });
  const state = hydrateReconciliationResponse(response);
  const baselineId = state.activeInventoryBaselineId;
  const baseline = Array.isArray(state.inventoryBaselines)
    ? state.inventoryBaselines.find(
        (candidate) => candidate.baselineId === baselineId,
      )
    : null;

  if (
    typeof baselineId !== "string" ||
    baselineId.trim() === "" ||
    !baseline ||
    !Array.isArray(baseline.inventory) ||
    baseline.inventory.length === 0
  ) {
    failBoundary(
      streamSessionCoordinator,
      "INVENTORY_BASELINE_REQUIRED",
      "Prepare inventory before starting a tracker stream.",
    );
  }

  if (
    options.requireImported === true &&
    (
      typeof baseline.sourceFingerprint !== "string" ||
      baseline.sourceFingerprint.trim() === ""
    )
  ) {
    failBoundary(
      streamSessionCoordinator,
      "INVENTORY_IMPORT_REQUIRED",
      "Import and confirm Google Sheets inventory before starting a tracker stream.",
    );
  }

  return baselineId;
}

async function pinStreamToPreparedInventory(streamId) {
  return stateCoordinator.dispatch({
    type:
      reconciliationCoordinator.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE,
    streamId,
  });
}

async function repairPendingReportsForSession(state, options = {}) {
  const activeStreamId = state.activeSession?.streamId ?? null;

  try {
    return await reportCoordinator.repairPendingReports(activeStreamId);
  } catch (error) {
    if (options.required === true) {
      throw error;
    }

    console.error(
      "[TikTok Live Tracker] Could not repair pending stream reports.",
      error,
    );
    return { repairedCount: 0 };
  }
}

function createEndResponse(response, reportRecord) {
  const state = hydrateStreamSessionResponse(response);
  const status = response?.result?.status;

  return {
    state,
    result: {
      status,
      reportId: reportRecord?.reportId ?? null,
      reportLifecycleStatus: reportRecord?.lifecycleStatus ?? null,
    },
  };
}

async function clearNextItemQueueForEndedStream(streamId) {
  const result = await nextItemQueueCoordinator.clearForStream(streamId);

  if (result?.status === "cleared") {
    notifyNextItemQueueChanged();
  }
}

async function clearPresetsForEndedStream(streamId) {
  // End is already durable here. Stale scoped planning data must never turn
  // successful report/session persistence into an apparent failure.
  try {
    await variationPresetsCoordinator.clearForStream(streamId);
  } catch (_error) {
    // The next stream has a different identity and cannot use these presets.
  }
}

async function repairCapturedPresetAssignments() {
  // Called inside messageTail, before another command can edit real mappings,
  // reset plans, or build a report from a partially completed capture delivery.
  return variationPresetsCoordinator.dispatch({ type: variationPresetsProtocol.COMMAND_TYPES.GET_PRESETS });
}

async function synchronizeRepairedPresetLiveProjection() {
  if (!presetLiveProjectionDirty) return;
  try {
    const { state: sessionState } = await getStreamSessionResponse();
    const streamId = sessionState.activeSession?.streamId;
    if (streamId) {
      const response = await stateCoordinator.dispatch({ type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE });
      const outcome = await liveBidCoordinator.synchronize({ streamId, state: response?.state ?? null });
      if (outcome?.status === "accepted") notifyLiveBidChanged();
    }
    presetLiveProjectionDirty = false;
  } catch (_error) {
    // Canonical promotion is durable. Retry this transient projection on the
    // next trusted command, without failing an otherwise successful mutation.
  }
}

async function endStreamWithReport(command) {
  const { state: sessionState } = await getStreamSessionResponse();
  const activeSession = sessionState.activeSession;

  if (activeSession === null) {
    await repairPendingReportsForSession(sessionState, { required: true });
    const existing = await reportCoordinator.getReportForStream(
      command.streamId,
    );
    const response = await activeStreamCoordinator.dispatch(command);

    await clearNextItemQueueForEndedStream(command.streamId);
    await clearPresetsForEndedStream(command.streamId);
    return createEndResponse(
      response,
      existing.reportId === null ? null : existing,
    );
  }

  if (activeSession.streamId !== command.streamId) {
    return activeStreamCoordinator.dispatch(command);
  }

  await repairCapturedPresetAssignments();

  const reconciliationResponse = await stateCoordinator.dispatch({
    type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
  });
  const preparedReport = await reportCoordinator.prepareReport({
    reconciliationState: reconciliationResponse?.state,
    streamId: activeSession.streamId,
    startedAt: activeSession.startedAt,
  });
  const response = await activeStreamCoordinator.dispatch(command);

  await clearNextItemQueueForEndedStream(command.streamId);
  await clearPresetsForEndedStream(command.streamId);
  let finalizedReport = preparedReport;

  try {
    finalizedReport = await reportCoordinator.finalizeReport(
      preparedReport.reportId,
    );
  } catch (error) {
    // The report was saved before End. A later read/Start repairs this
    // pending marker without misreporting a successfully persisted End.
    console.error(
      "[TikTok Live Tracker] Stream ended, but report finalization is pending repair.",
      error,
    );
  }

  return createEndResponse(response, finalizedReport);
}

async function dispatchStreamSessionCommand(command) {
  if (
    command.type ===
    streamSessionCoordinator.COMMAND_TYPES.START_STREAM
  ) {
    inventoryImportService.invalidatePreviews();
    const { state: existingState } = await getStreamSessionResponse();

    await repairPendingReportsForSession(existingState);

    if (existingState.activeSession === null) {
      await requirePreparedInventoryBaseline({ requireImported: true });
    }

    const response = await activeStreamCoordinator.dispatch(command);
    const state = hydrateStreamSessionResponse(response);

    if (state.activeSession === null) {
      failBoundary(
        streamSessionCoordinator,
        "ACTIVE_STREAM_STATE_UNAVAILABLE",
        "The started tracker stream could not be verified.",
      );
    }

    await pinStreamToPreparedInventory(state.activeSession.streamId);
    return response;
  }

  if (
    command.type ===
    streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION
  ) {
    const { response, state } = await getStreamSessionResponse();

    await repairPendingReportsForSession(state);

    if (state.activeSession !== null) {
      await pinStreamToPreparedInventory(state.activeSession.streamId);
    }

    return response;
  }

  if (
    command.type === streamSessionCoordinator.COMMAND_TYPES.END_STREAM
  ) {
    return endStreamWithReport(command);
  }

  return activeStreamCoordinator.dispatch(command);
}

function createsInventoryBaseline(command) {
  return (
    command.type ===
    reconciliationCoordinator.COMMAND_TYPES.CREATE_INVENTORY_BASELINE
  );
}

function initializesInventoryState(command) {
  return (
    command.type ===
    reconciliationCoordinator.COMMAND_TYPES.INITIALIZE_STATE
  );
}

async function initializeInventoryState(command) {
  const { state: streamState } = await getStreamSessionResponse();

  if (streamState.activeSession === null) {
    failBoundary(
      reconciliationCoordinator,
      "INVENTORY_IMPORT_REQUIRED",
      "Import and confirm Google Sheets inventory before starting a tracker stream.",
    );
  }

  const storedResponse = await stateCoordinator.dispatch({
    type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
  });

  if (storedResponse?.state !== null) {
    failBoundary(
      reconciliationCoordinator,
      "ACTIVE_STREAM_ALREADY_EXISTS",
      "End the active tracker stream before preparing another inventory baseline.",
    );
  }

  const initializedResponse = await stateCoordinator.dispatch(command);

  hydrateReconciliationResponse(initializedResponse);

  const pinnedResponse = await pinStreamToPreparedInventory(
    streamState.activeSession.streamId,
  );

  return {
    state: pinnedResponse.state,
    result: initializedResponse.result,
  };
}

function mutatesEmployeeStream(command) {
  return [
    reconciliationCoordinator.COMMAND_TYPES.MAP_VARIATION,
    reconciliationCoordinator.COMMAND_TYPES.UNMAP_VARIATION,
  ].includes(command.type);
}

async function dispatchReconciliationCommand(command) {
  if (initializesInventoryState(command)) {
    return initializeInventoryState(command);
  }

  if (createsInventoryBaseline(command)) {
    const { state } = await getStreamSessionResponse();

    if (state.activeSession !== null) {
      failBoundary(
        reconciliationCoordinator,
        "ACTIVE_STREAM_ALREADY_EXISTS",
        "End the active tracker stream before preparing another inventory baseline.",
      );
    }
  }

  if (mutatesEmployeeStream(command)) {
    const { state } = await getStreamSessionResponse();

    if (state.activeSession === null) {
      failBoundary(
        reconciliationCoordinator,
        "NO_ACTIVE_STREAM",
        "Start or resume a tracker stream before changing inventory mappings.",
      );
    }

    if (command.streamId !== state.activeSession.streamId) {
      failBoundary(
        reconciliationCoordinator,
        "ACTIVE_STREAM_MISMATCH",
        "The requested inventory change does not belong to the active tracker stream.",
      );
    }

    await pinStreamToPreparedInventory(state.activeSession.streamId);
  }

  if (mutatesEmployeeStream(command) ||
      command.type === reconciliationCoordinator.COMMAND_TYPES.GET_STATE) {
    await repairCapturedPresetAssignments();
  }

  const response = await stateCoordinator.dispatch(command);

  if (mutatesEmployeeStream(command)) {
    try {
      const synchronization = await liveBidCoordinator.synchronize({
        streamId: command.streamId,
        state: response?.state ?? null,
      });

      if (synchronization?.status === "accepted") {
        notifyLiveBidChanged();
      }
    } catch (_error) {
      // The canonical mapping was saved successfully. Retained live-auction
      // display state is best-effort and must not turn that save into a failure.
    }
  }

  return response;
}

async function dispatchNextItemQueueCommand(command) {
  const presets = await repairCapturedPresetAssignments();
  if (command.type === nextItemQueueProtocol.COMMAND_TYPES.TOGGLE_QUEUE &&
      presets.streamId === command.expectedStreamId && presets.assignments.length > 0) {
    const stateResponse = await stateCoordinator.dispatch({
      type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
    });
    const canonical = hydrateReconciliationResponse(stateResponse);
    const stream = canonical.streams.find((entry) => entry.streamId === command.expectedStreamId);
    const current = stream?.activeBiddingVariationNumber ??
      Math.max(0, ...(stream?.variations ?? []).map((entry) => entry.variationNumber));
    const auction = stream?.variations.find((entry) => entry.variationNumber === current);
    // toggle_queue also maps an unassigned live variation. Preserve that path
    // and the independent map_current action while suppressing only queuing.
    if (current === command.expectedVariationNumber && typeof auction?.sku === "string" &&
        presets.assignments.some((entry) => entry.variationNumber === current + 1)) {
      failBoundary(nextItemQueueProtocol, "NEXT_VARIATION_PRESET",
        "The next variation already has a preset item. Queuing is disabled for that variation.");
    }
  }
  const response = await nextItemQueueCoordinator.dispatch(command);

  if (["mapped_current", "unmapped_current"].includes(response?.status)) {
    try {
      const stateResponse = await stateCoordinator.dispatch({
        type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
      });
      const synchronization = await liveBidCoordinator.synchronize({
        streamId: command.expectedStreamId,
        state: stateResponse?.state ?? null,
      });

      if (synchronization?.status === "accepted") {
        notifyLiveBidChanged();
      }
    } catch (_error) {
      // The canonical current-variation mapping change was saved successfully.
      // Retained live-auction display state is best-effort only.
    }
  }

  return response;
}

async function requireFinalizedReport(reportId) {
  const record = await reportCoordinator.getReport(reportId);

  if (record.reportId === null || record.report === null) {
    failBoundary(
      streamReportProtocol,
      "REPORT_NOT_FOUND",
      "The stream report does not exist.",
    );
  }

  if (
    record.lifecycleStatus !==
      streamReportStorage.LIFECYCLE_STATUSES.FINALIZED
  ) {
    failBoundary(
      streamReportProtocol,
      "REPORT_NOT_FINALIZED",
      "Only a finalized stream report can correct ended-stream data.",
    );
  }

  return record;
}

async function getCanonicalReconciliationState() {
  const response = await stateCoordinator.dispatch({
    type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
  });

  return hydrateReconciliationResponse(response);
}

async function getQuantityHandoffContext(reportId, sessionState) {
  if (sessionState.activeSession !== null) {
    failBoundary(streamReportProtocol, "ACTIVE_STREAM_ALREADY_EXISTS",
      "End the active tracker stream before verifying quantities.");
  }
  const record = await requireFinalizedReport(reportId);
  const latest = await reportCoordinator.getLatestFinalizedReport();
  if (latest.reportId !== reportId) {
    failBoundary(streamReportProtocol, "QUANTITY_REPORT_STALE",
      "Use the latest finalized report to copy quantities.");
  }
  const canonical = await getCanonicalReconciliationState();
  const guard = getReportCorrectionGuard(record, canonical);
  if (guard) {
    failBoundary(streamReportProtocol, "QUANTITY_REPORT_STALE",
      "A newer stream or inventory baseline exists. Reconcile stock before copying this report's quantities.");
  }
  const report = record.report;
  if (report.metadata.activeBiddingVariationNumber !== null ||
      ["unresolvedOrderCount", "pendingMappedCount", "paymentFixingCount",
        "unmappedCompletedCount", "conflictCount"].some((key) => report.totals[key] !== 0)) {
    failBoundary(streamReportProtocol, "QUANTITY_REPORT_NOT_READY",
      "Resolve unfinished payments, unmapped sales, and reconciliation conflicts before copying quantities.");
  }
  const stream = canonical.streams.at(-1);
  const baseline = canonical.inventoryBaselines.find(
    (entry) => entry.baselineId === report.metadata.inventoryBaselineId,
  );
  const reportItems = new Map(report.inventory.map((item) => [item.sku, item]));
  if (!baseline?.sourceFingerprint ||
      stream?.inventoryBaselineId !== baseline.baselineId ||
      baseline.inventory.length !== report.inventory.length ||
      baseline.inventory.some((item) => {
        const saved = reportItems.get(item.sku);
        return !saved || saved.openingQuantity !== item.quantityOnHandAtImport ||
          saved.item !== item.item || saved.style !== item.style || saved.size !== item.size;
      })) {
    failBoundary(streamReportProtocol, "QUANTITY_LINEAGE_UNAVAILABLE",
      "This report's inventory baseline cannot be verified. Reconcile stock before copying quantities.");
  }
  const summary = reconciliation.calculateSummary(canonical, { streamId: stream.streamId });
  const canonicalSales = summary.auctions.filter((order) => order.paymentStatus === "payment_complete")
    .map((order) => [order.variationNumber, order.soldPriceCents])
    .sort((left, right) => left[0] - right[0]);
  const canonicalCanceled = summary.auctions.filter((order) => order.paymentStatus === "canceled")
    .map((order) => order.variationNumber).sort((left, right) => left - right);
  if (summary.activeBiddingVariationNumber !== report.metadata.activeBiddingVariationNumber ||
      summary.totals.conflictCount !== 0 ||
      summary.auctions.length !== report.totals.auctionCount ||
      summary.auctions.some((order) => !["payment_complete", "canceled"].includes(order.paymentStatus)) ||
      JSON.stringify(canonicalSales) !== JSON.stringify(report.completedSales.map(
        (sale) => [sale.variationNumber, sale.soldPriceCents])) ||
      JSON.stringify(canonicalCanceled) !== JSON.stringify((report.canceledOrders ?? [])
        .map((order) => order.variationNumber))) {
    failBoundary(streamReportProtocol, "QUANTITY_REPORT_STALE",
      "The saved report does not match its latest captured payment state. Reload and resolve the report before copying quantities.");
  }
  // Costs and mappings may legitimately differ after report-only corrections.
  // Capture the exact saved report AND canonical context, rather than rebuilding
  // a report and thereby undoing those corrections.
  return { record, signature: JSON.stringify({ record, canonical, sessionState }) };
}

function pruneQuantityHandoffs() {
  const now = Date.now();
  for (const [token, prepared] of quantityHandoffs) {
    if (now < prepared.createdAt || now >= prepared.expiresAt) {
      quantityHandoffs.delete(token);
    }
  }
}

async function prepareQuantityHandoff(command, sessionState) {
  pruneQuantityHandoffs();
  // A new verification replaces this report's old preparations, even if the new
  // authentication/read fails. Never let failure expose a previous Sheet's data.
  for (const [token, prepared] of quantityHandoffs) {
    if (prepared.preview.reportId === command.reportId) quantityHandoffs.delete(token);
  }
  const before = await getQuantityHandoffContext(command.reportId, sessionState);
  const layout = await inventoryImportService.readInventoryLayout(command.spreadsheetId);
  const { state: currentSession } = await getStreamSessionResponse();
  const after = await getQuantityHandoffContext(command.reportId, currentSession);
  if (after.signature !== before.signature) {
    failBoundary(streamReportProtocol, "QUANTITY_HANDOFF_STALE",
      "The report or inventory changed. Verify the Sheet again.");
  }
  const handoff = reportQuantityHandoff.createQuantityHandoff(after.record.report, layout);
  const token = `quantity-handoff:${globalThis.crypto.randomUUID()}`;
  const preview = {
    reportId: command.reportId, token, spreadsheetId: command.spreadsheetId,
    sheetTitle: handoff.sheetTitle, startCell: handoff.startCell,
    range: `${handoff.startCell}:${handoff.endCell}`,
    rowCount: handoff.rowCount, itemCount: handoff.itemCount,
    alreadyApplied: handoff.alreadyApplied,
  };
  while (quantityHandoffs.size >= MAX_QUANTITY_HANDOFFS) {
    quantityHandoffs.delete(quantityHandoffs.keys().next().value);
  }
  const createdAt = Date.now();
  quantityHandoffs.set(token, {
    preview, text: handoff.text, signature: after.signature, createdAt,
    expiresAt: createdAt + googleSheetsInventoryImport.PREVIEW_TTL_MS,
  });
  return { ...preview };
}

async function copyQuantityHandoff(command, sessionState) {
  pruneQuantityHandoffs();
  const prepared = quantityHandoffs.get(command.token);
  if (!prepared || prepared.preview.reportId !== command.reportId) {
    failBoundary(streamReportProtocol, "QUANTITY_HANDOFF_EXPIRED",
      "The quantity preparation expired or is no longer available. Verify the Sheet again.");
  }
  const current = await getQuantityHandoffContext(command.reportId, sessionState);
  if (current.signature !== prepared.signature) {
    quantityHandoffs.delete(command.token);
    failBoundary(streamReportProtocol, "QUANTITY_HANDOFF_STALE",
      "The report or inventory changed. Verify the Sheet again before copying.");
  }
  return { ...prepared.preview, text: prepared.text };
}

function getReportCorrectionGuard(reportRecord, reconciliationState) {
  const report = reportRecord.report;
  const lastStream = reconciliationState.streams.at(-1) ?? null;

  if (
    report.metadata.inventoryBaselineId !==
      reconciliationState.activeInventoryBaselineId
  ) {
    return {
      code: "REPORT_INVENTORY_BASELINE_STALE",
      message:
        "This report uses an older inventory import and can no longer be corrected safely.",
    };
  }

  if (lastStream?.streamId !== report.metadata.streamId) {
    return {
      code: "REPORT_NOT_LATEST_STREAM",
      message:
        "A newer tracker stream exists, so this report can no longer be corrected safely.",
    };
  }

  return null;
}

async function getReportWithPaymentRepair(command, sessionState) {
  const reportRecord = await reportCoordinator.getReport(command.reportId);

  if (
    reportRecord.reportId === null ||
    reportRecord.report === null ||
    reportRecord.lifecycleStatus !==
      streamReportStorage.LIFECYCLE_STATUSES.FINALIZED ||
    sessionState.activeSession !== null
  ) {
    return reportRecord;
  }

  const savedPaymentFixingCount =
    reportRecord.report?.totals?.paymentFixingCount;

  if (savedPaymentFixingCount === 0) {
    return reportRecord;
  }

  const latest = await reportCoordinator.getLatestFinalizedReport();

  if (latest.reportId !== command.reportId) {
    return reportRecord;
  }

  let reconciliationState;
  let orders;

  try {
    reconciliationState = await getCanonicalReconciliationState();

    if (getReportCorrectionGuard(reportRecord, reconciliationState)) {
      return reportRecord;
    }

    orders = reconciliation.listPaymentFixingOrders(
      reconciliationState,
      { streamId: reportRecord.report.metadata.streamId },
    );
  } catch (_error) {
    // A valid saved report remains readable when its separate canonical
    // reconciliation state is unavailable. Payment corrections stay disabled.
    return reportRecord;
  }

  const needsPaymentRepair =
    Number.isSafeInteger(savedPaymentFixingCount) &&
    savedPaymentFixingCount !== orders.length;

  if (!needsPaymentRepair) {
    return reportRecord;
  }

  return reportCoordinator.replaceFinalizedReport({
    reportId: command.reportId,
    reconciliationState,
  });
}

async function listPaymentFixingOrdersForReport(command, sessionState) {
  const reportRecord = await requireFinalizedReport(command.reportId);
  const latest = await reportCoordinator.getLatestFinalizedReport();

  if (
    sessionState.activeSession !== null ||
    latest.reportId !== command.reportId
  ) {
    return { reportId: command.reportId, orders: [] };
  }

  const reconciliationState = await getCanonicalReconciliationState();

  if (getReportCorrectionGuard(reportRecord, reconciliationState)) {
    return { reportId: command.reportId, orders: [] };
  }

  const orders = reconciliation.listPaymentFixingOrders(
    reconciliationState,
    { streamId: reportRecord.report.metadata.streamId },
  );

  return {
    reportId: command.reportId,
    orders,
  };
}

async function resolvePaymentFixingOrderForReport(command, sessionState) {
  if (sessionState.activeSession !== null) {
    failBoundary(
      streamReportProtocol,
      "ACTIVE_STREAM_ALREADY_EXISTS",
      "End the active tracker stream before correcting a saved report.",
    );
  }

  const reportRecord = await requireFinalizedReport(command.reportId);
  const latest = await reportCoordinator.getLatestFinalizedReport();

  if (latest.reportId !== command.reportId) {
    failBoundary(
      streamReportProtocol,
      "REPORT_NOT_LATEST",
      "Only the newest ended-stream report can correct payment-error orders.",
    );
  }

  const reconciliationState = await getCanonicalReconciliationState();
  const correctionGuard = getReportCorrectionGuard(
    reportRecord,
    reconciliationState,
  );

  if (correctionGuard) {
    failBoundary(
      streamReportProtocol,
      correctionGuard.code,
      correctionGuard.message,
    );
  }

  const reconciliationResponse =
    await stateCoordinator.resolvePaymentFixingOrder({
      streamId: reportRecord.report.metadata.streamId,
      variationNumber: command.variationNumber,
      resolution: command.resolution,
      soldPriceCents: command.soldPriceCents,
    });

  return reportCoordinator.replaceFinalizedReport({
    reportId: command.reportId,
    reconciliationState: reconciliationResponse?.state,
  });
}

async function listUnitCostsForReport(command) {
  const reportRecord = await requireFinalizedReport(command.reportId);
  const completedSaleCounts = new Map(
    reportRecord.report.itemPerformance.map((item) => [
      item.sku,
      item.soldQuantity,
    ]),
  );

  return {
    reportId: command.reportId,
    skus: reportRecord.report.inventory.map((item) => ({
      sku: item.sku,
      item: item.item,
      style: item.style,
      size: item.size,
      unitCostCents: item.unitCostCents,
      completedSaleCount: completedSaleCounts.get(item.sku) ?? 0,
    })),
  };
}

async function updateUnitCostForReport(command) {
  return reportCoordinator.correctFinalizedReportUnitCost({
    reportId: command.reportId,
    sku: command.sku,
    unitCostCents: command.unitCostCents,
  });
}

async function loadOfflineEditorDataForReport(command, sessionState) {
  return reportCoordinator.loadOfflineEditorData({
    reportId: command.reportId,
    activeStreamExists: sessionState.activeSession !== null,
  });
}

async function saveOfflineEditorMappingsForReport(command, sessionState) {
  if (sessionState.activeSession !== null) {
    failBoundary(
      streamReportProtocol,
      "ACTIVE_STREAM_ALREADY_EXISTS",
      "End the active tracker stream before editing a report.",
    );
  }

  return reportCoordinator.correctFinalizedReportMappings({
    reportId: command.reportId,
    changes: command.changes,
  });
}

function dispatchBoundaryCommand(boundary, command) {
  if (boundary.protocol === streamSessionCoordinator) {
    return dispatchStreamSessionCommand(command);
  }

  if (boundary.protocol === streamReportProtocol) {
    if (
      command.type === streamReportProtocol.COMMAND_TYPES.GET_LIBRARY_CAPACITY
    ) {
      // Capacity includes pending records and must not repair or mutate them.
      return reportCoordinator.dispatch(command);
    }

    if (command.type === streamReportProtocol.COMMAND_TYPES.DELETE_REPORTS) {
      // Deletion must reject pending records, never finalize them as a side effect.
      return reportCoordinator.dispatch(command);
    }

    return getStreamSessionResponse().then(async ({ state }) => {
      if (command.type === streamReportProtocol.COMMAND_TYPES.PREPARE_QUANTITY_HANDOFF) {
        return prepareQuantityHandoff(command, state);
      }
      if (command.type === streamReportProtocol.COMMAND_TYPES.COPY_QUANTITY_HANDOFF) {
        return copyQuantityHandoff(command, state);
      }
      if (
        command.type ===
          streamReportProtocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA
      ) {
        return loadOfflineEditorDataForReport(command, state);
      }

      if (
        command.type ===
          streamReportProtocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS
      ) {
        return saveOfflineEditorMappingsForReport(command, state);
      }

      await repairPendingReportsForSession(state, { required: true });

      if (
        command.type === streamReportProtocol.COMMAND_TYPES.GET_REPORT
      ) {
        return getReportWithPaymentRepair(command, state);
      }

      if (
        command.type ===
          streamReportProtocol.COMMAND_TYPES.LIST_PAYMENT_FIXING_ORDERS
      ) {
        return listPaymentFixingOrdersForReport(command, state);
      }

      if (
        command.type ===
          streamReportProtocol.COMMAND_TYPES.RESOLVE_PAYMENT_FIXING_ORDER
      ) {
        return resolvePaymentFixingOrderForReport(command, state);
      }

      if (
        command.type ===
          streamReportProtocol.COMMAND_TYPES.LIST_REPORT_UNIT_COSTS
      ) {
        return listUnitCostsForReport(command);
      }

      if (
        command.type ===
          streamReportProtocol.COMMAND_TYPES.UPDATE_REPORT_UNIT_COST
      ) {
        return updateUnitCostForReport(command);
      }

      return reportCoordinator.dispatch(command);
    });
  }

  if (boundary.protocol === reconciliationCoordinator) {
    return dispatchReconciliationCommand(command);
  }

  if (boundary.protocol === nextItemQueueProtocol) {
    return dispatchNextItemQueueCommand(command);
  }

  if (boundary.protocol === inventoryImportProtocol) {
    switch (command.type) {
      case inventoryImportProtocol.COMMAND_TYPES.GET_IMPORT_STATUS:
        return inventoryImportService.getImportStatus();
      case inventoryImportProtocol.COMMAND_TYPES.GET_ACTIVE_BASELINE_PREVIEW:
        return inventoryImportService.getActiveBaselinePreview();
      case inventoryImportProtocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET:
        return inventoryImportService.previewGoogleSheet(
          command.spreadsheetId,
        );
      case inventoryImportProtocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT:
        return inventoryImportService.confirmGoogleSheetImport(
          command.previewToken,
        );
      case inventoryImportProtocol.COMMAND_TYPES
        .ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET:
        return addActiveStreamSkusFromGoogleSheet(command.spreadsheetId);
      default:
        failBoundary(
          inventoryImportProtocol,
          "UNKNOWN_COMMAND",
          "The inventory-import command is not supported.",
        );
    }
  }

  return boundary.coordinator.dispatch(command);
}

function serializeError(error, boundary) {
  const knownError =
    error instanceof
      reconciliationCoordinator.ReconciliationCoordinatorError ||
    error instanceof reconciliation.ReconciliationError ||
    error instanceof reconciliationStorage.ReconciliationStorageError ||
    error instanceof streamSession.StreamSessionError ||
    error instanceof streamSessionStorage.StreamSessionStorageError ||
    error instanceof streamSessionCoordinator.StreamSessionCoordinatorError ||
    error instanceof streamReportProtocol.StreamReportProtocolError ||
    error instanceof streamReportStorage.StreamReportStorageError ||
    error instanceof streamReportCoordinator.StreamReportCoordinatorError ||
    error instanceof captureProtocol.CaptureProtocolError ||
    error instanceof captureIntegration.CaptureIntegrationError ||
    error instanceof liveBidProtocol.LiveBidProtocolError ||
    error instanceof liveBidStorage.LiveBidStorageError ||
    error instanceof liveBidCoordinatorModule.LiveBidCoordinatorError ||
    error instanceof nextItemQueueProtocol.NextItemQueueProtocolError ||
    error instanceof nextItemQueueStorage.NextItemQueueStorageError ||
    error instanceof
      nextItemQueueCoordinatorModule.NextItemQueueCoordinatorError ||
    error instanceof variationPresetsProtocol.VariationPresetsProtocolError ||
    error instanceof variationPresetsStorage.VariationPresetsStorageError ||
    error instanceof variationPresetsCoordinatorModule.VariationPresetsCoordinatorError ||
    error instanceof inventoryImportProtocol.InventoryImportProtocolError ||
    (typeof inventorySheetImport.InventorySheetImportError === "function" &&
      error instanceof inventorySheetImport.InventorySheetImportError) ||
    error instanceof
      googleSheetsInventoryImport.GoogleSheetsInventoryImportError ||
    (reportQuantityHandoff && error instanceof reportQuantityHandoff.ReportQuantityHandoffError);

  if (knownError) {
    return { code: error.code, message: error.message };
  }

  console.error(
    `[TikTok Live Tracker] Unexpected ${boundary.label} command failure.`,
    error,
  );

  return {
    code: "INTERNAL_ERROR",
    message: `The ${boundary.label} command could not be completed.`,
  };
}

function notifyPresetsChanged() {
  try {
    const delivery = chrome.runtime.sendMessage(
      variationPresetsProtocol.createPresetsChangedNotification(),
    );
    if (delivery && typeof delivery.catch === "function") delivery.catch(() => undefined);
  } catch {
    // Durable changes are authoritative; notifications remain best-effort.
  }
}

function notifyCaptureStateChanged() {
  try {
    const delivery = chrome.runtime.sendMessage(
      captureStateChangedNotification,
    );

    if (delivery && typeof delivery.catch === "function") {
      delivery.catch(() => undefined);
    }
  } catch {
    // Persistence already succeeded; notification delivery is best-effort.
  }
}

function notifyLiveBidChanged() {
  try {
    const delivery = chrome.runtime.sendMessage(liveBidChangedNotification);

    if (delivery && typeof delivery.catch === "function") {
      delivery.catch(() => undefined);
    }
  } catch {
    // Transient persistence already succeeded; delivery is best-effort.
  }
}

function notifyNextItemQueueChanged() {
  try {
    const delivery = chrome.runtime.sendMessage(
      nextItemQueueChangedNotification,
    );

    if (delivery && typeof delivery.catch === "function") {
      delivery.catch(() => undefined);
    }
  } catch {
    // Session persistence already succeeded; delivery is best-effort.
  }
}

function handleCaptureHealthMessage(message, sender, sendResponse) {
  const receivedAt = Date.now();
  function requireCurrentHealthRequest() {
    const elapsed = Date.now() - receivedAt;
    if (elapsed < 0 || elapsed > captureHealth.MESSAGE_MAX_AGE_MS) {
      throw new captureHealth.CaptureHealthError(
        "STALE_HEALTH_MESSAGE", "The capture-health request expired before it could be processed.",
      );
    }
  }
  const execution = messageTail
    .then(() => storageAccessReady)
    .then(async () => {
      const request = captureHealth.parseRequest(message);
      const source = captureHealth.validateSender(sender, request.type, {
        extensionId: chrome.runtime.id,
        sidePanelUrl,
      });
      requireCurrentHealthRequest();
      if (storageAccessError) {
        throw new captureHealth.CaptureHealthError(
          "HEALTH_UNAVAILABLE", "Capture health is unavailable until storage access is restored.",
        );
      }
      // Startup readiness uses only the session coordinator's read command; it does not pin,
      // repair, migrate, or update reports, inventory, or capture accounting.
      const { state } = await getStreamSessionResponse();
      requireCurrentHealthRequest();
      captureHealthStore.setSession(state.activeSession?.streamId ?? null);
      if (request.type === "get") return captureHealthStore.get(request.streamId);
      if (request.type === "context") return captureHealthStore.context(source);
      return captureHealthStore.pulse(source, request);
    });
  messageTail = execution.catch(() => undefined);
  execution.then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof captureHealth.CaptureHealthError
        ? { code: error.code, message: error.message }
        : { code: "HEALTH_UNAVAILABLE", message: "Capture health could not be read. Please retry." },
    }),
  );
  return true;
}

function notifyReportLibraryChanged() {
  try {
    const delivery = chrome.runtime.sendMessage(
      reportLibraryChangedNotification,
    );

    if (delivery && typeof delivery.catch === "function") {
      delivery.catch(() => undefined);
    }
  } catch {
    // Report persistence already succeeded; delivery is best-effort.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (captureHealthStore && message?.channel === captureHealth.CHANNEL) {
    return handleCaptureHealthMessage(message, sender, sendResponse);
  }
  const boundary = getMessageBoundary(message);

  if (boundary === null) {
    return false;
  }

  const execution = messageTail
    .then(() => storageAccessReady)
    .then(async () => {
      if (storageAccessError) {
        failBoundary(
          boundary.protocol,
          "STORAGE_ACCESS_RESTRICTION_FAILED",
          "Canonical storage access could not be secured.",
        );
      }

      const command = validateMessage(message, boundary);

      validateSender(sender, command, boundary);
      await synchronizeRepairedPresetLiveProjection();
      try {
        return await dispatchBoundaryCommand(boundary, command);
      } finally {
        // Promotion can persist before its independent cleanup fails. Repair
        // the live cache inside the same worker FIFO even on that error path,
        // so later price events cannot be rejected against an old variation.
        await synchronizeRepairedPresetLiveProjection();
      }
    });

  messageTail = execution.catch(() => undefined);

  execution.then(
    (data) => {
      if (
        boundary.protocol === streamReportProtocol &&
        reportMutationCommandTypes.has(message.command?.type)
      ) {
        notifyReportLibraryChanged();
      }

      if (
        boundary.protocol === captureProtocol &&
        isRecord(data) &&
        data.status === "accepted"
      ) {
        const liveAuctionChanged =
          captureEventIntegration.consumeLiveBidChanged();
        const nextItemQueueChanged =
          captureEventIntegration.consumeNextItemQueueChanged();

        if (
          message.event?.type ===
          captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_PRICE
        ) {
          if (liveAuctionChanged) {
            notifyLiveBidChanged();
          }

          if (nextItemQueueChanged) {
            notifyNextItemQueueChanged();
          }
        } else {
          notifyCaptureStateChanged();

          if (liveAuctionChanged) {
            notifyLiveBidChanged();
          }

          if (nextItemQueueChanged) {
            notifyNextItemQueueChanged();
          }
        }
      }

      if (
        boundary.protocol === nextItemQueueProtocol &&
        isRecord(data) &&
        ["cleared", "queued"].includes(data.status)
      ) {
        notifyNextItemQueueChanged();
      }

      if (
        boundary.protocol === nextItemQueueProtocol &&
        isRecord(data) &&
        ["mapped_current", "unmapped_current"].includes(data.status)
      ) {
        notifyCaptureStateChanged();
      }

      sendResponse({ ok: true, data });
    },
    (error) =>
      sendResponse({
        ok: false,
        error: serializeError(error, boundary),
      }),
  );

  return true;
});
