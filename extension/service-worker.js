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
  "shared/capture-protocol.js",
  "shared/capture-integration.js",
  "shared/inventory-sheet-import.js",
  "shared/inventory-import-protocol.js",
  "shared/google-sheets-inventory-import.js",
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
const captureProtocol = globalThis.TikTokLiveTrackerCaptureProtocol;
const captureIntegration = globalThis.TikTokLiveTrackerCaptureIntegration;
const inventorySheetImport =
  globalThis.TikTokLiveTrackerInventorySheetImport;
const inventoryImportProtocol =
  globalThis.TikTokLiveTrackerInventoryImportProtocol;
const googleSheetsInventoryImport =
  globalThis.TikTokLiveTrackerGoogleSheetsInventoryImport;
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
const captureEventIntegration =
  captureIntegration.createCaptureIntegration({
    activeStreamCoordinator,
    captureProtocol,
    liveBidCoordinator,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
const inventoryImportService =
  googleSheetsInventoryImport.createGoogleSheetsInventoryImportService({
    abortController: globalThis.AbortController,
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
  streamReportProtocol.COMMAND_TYPES.LIST_REPORTS,
  streamReportProtocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
  streamReportProtocol.COMMAND_TYPES.GET_REPORT,
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
let messageTail = Promise.resolve();

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

  if (message.channel === inventoryImportProtocol.MESSAGE_CHANNEL) {
    return {
      coordinator: inventoryImportService,
      label: "inventory-import",
      protocol: inventoryImportProtocol,
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

    if (!fromSidePanel && !fromReportPage) {
      failBoundary(
        boundary.protocol,
        "UNAUTHORIZED_MESSAGE_SENDER",
        "Only the extension side panel and packaged report page can read stream reports.",
      );
    }

    if (
      fromReportPage &&
      !reportReadCommandTypes.has(command.type)
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
    command.type ===
      reconciliationCoordinator.COMMAND_TYPES.CREATE_INVENTORY_BASELINE
  ) {
    failBoundary(
      boundary.protocol,
      "UNAUTHORIZED_MESSAGE_SENDER",
      "Inventory baselines can be created only through a confirmed Sheet import.",
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

function createEndResponse(response, reportRecord, statusOverride = null) {
  const state = hydrateStreamSessionResponse(response);
  const status = statusOverride ?? response?.result?.status;

  return {
    state,
    result: {
      status,
      reportId: reportRecord?.reportId ?? null,
      reportLifecycleStatus: reportRecord?.lifecycleStatus ?? null,
    },
  };
}

async function endStreamWithoutReport(command) {
  const { state: sessionState } = await getStreamSessionResponse();

  if (
    sessionState.activeSession !== null &&
    sessionState.activeSession.streamId !== command.streamId
  ) {
    return activeStreamCoordinator.dispatch(command);
  }

  if (sessionState.activeSession !== null) {
    await reportCoordinator.discardPendingReportForStream(command.streamId);
  } else {
    await repairPendingReportsForSession(sessionState, { required: true });
  }

  const response = await activeStreamCoordinator.dispatch(command);
  const status = response?.result?.status === "ended"
    ? "ended_without_report"
    : response?.result?.status;

  return createEndResponse(response, null, status);
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
    return createEndResponse(
      response,
      existing.reportId === null ? null : existing,
    );
  }

  if (activeSession.streamId !== command.streamId) {
    return activeStreamCoordinator.dispatch(command);
  }

  const reconciliationResponse = await stateCoordinator.dispatch({
    type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
  });
  const preparedReport = await reportCoordinator.prepareReport({
    reconciliationState: reconciliationResponse?.state,
    streamId: activeSession.streamId,
    startedAt: activeSession.startedAt,
  });
  const response = await activeStreamCoordinator.dispatch(command);
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

  if (
    command.type ===
      streamSessionCoordinator.COMMAND_TYPES.END_STREAM_WITHOUT_REPORT
  ) {
    return endStreamWithoutReport(command);
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

function isManualUnpaidCommand(command) {
  return [
    reconciliationCoordinator.COMMAND_TYPES.MARK_UNPAID,
    reconciliationCoordinator.COMMAND_TYPES.UNDO_MARK_UNPAID,
  ].includes(command.type);
}

async function dispatchReconciliationCommand(command) {
  if (isManualUnpaidCommand(command)) {
    failBoundary(
      reconciliationCoordinator,
      "MANUAL_UNPAID_DISABLED",
      "Live payment failures and cancellations are tracked automatically from TikTok.",
    );
  }

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

function dispatchBoundaryCommand(boundary, command) {
  if (boundary.protocol === streamSessionCoordinator) {
    return dispatchStreamSessionCommand(command);
  }

  if (boundary.protocol === streamReportProtocol) {
    return getStreamSessionResponse().then(async ({ state }) => {
      await repairPendingReportsForSession(state, { required: true });
      return reportCoordinator.dispatch(command);
    });
  }

  if (boundary.protocol === reconciliationCoordinator) {
    return dispatchReconciliationCommand(command);
  }

  if (boundary.protocol === inventoryImportProtocol) {
    switch (command.type) {
      case inventoryImportProtocol.COMMAND_TYPES.GET_IMPORT_STATUS:
        return inventoryImportService.getImportStatus();
      case inventoryImportProtocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET:
        return inventoryImportService.previewGoogleSheet(
          command.spreadsheetId,
        );
      case inventoryImportProtocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT:
        return inventoryImportService.confirmGoogleSheetImport(
          command.previewToken,
        );
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
    error instanceof inventoryImportProtocol.InventoryImportProtocolError ||
    error instanceof
      googleSheetsInventoryImport.GoogleSheetsInventoryImportError;

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const boundary = getMessageBoundary(message);

  if (boundary === null) {
    return false;
  }

  const execution = messageTail
    .then(() => storageAccessReady)
    .then(() => {
      if (storageAccessError) {
        failBoundary(
          boundary.protocol,
          "STORAGE_ACCESS_RESTRICTION_FAILED",
          "Canonical storage access could not be secured.",
        );
      }

      const command = validateMessage(message, boundary);

      validateSender(sender, command, boundary);
      return dispatchBoundaryCommand(boundary, command);
    });

  messageTail = execution.catch(() => undefined);

  execution.then(
    (data) => {
      if (
        boundary.protocol === captureProtocol &&
        isRecord(data) &&
        data.status === "accepted"
      ) {
        const liveAuctionChanged =
          captureEventIntegration.consumeLiveBidChanged();

        if (
          message.event?.type ===
          captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_PRICE
        ) {
          if (liveAuctionChanged) {
            notifyLiveBidChanged();
          }
        } else {
          notifyCaptureStateChanged();

          if (liveAuctionChanged) {
            notifyLiveBidChanged();
          }
        }
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
