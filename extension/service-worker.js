"use strict";

importScripts(
  "shared/reconciliation.js",
  "shared/reconciliation-storage.js",
  "shared/reconciliation-coordinator.js",
  "shared/stream-session.js",
  "shared/stream-session-storage.js",
  "shared/stream-session-coordinator.js",
  "shared/capture-protocol.js",
  "shared/capture-integration.js",
);

const reconciliation = globalThis.TikTokLiveTrackerReconciliation;
const reconciliationStorage =
  globalThis.TikTokLiveTrackerReconciliationStorage;
const reconciliationCoordinator =
  globalThis.TikTokLiveTrackerReconciliationCoordinator;
const streamSession = globalThis.TikTokLiveTrackerStreamSession;
const streamSessionStorage =
  globalThis.TikTokLiveTrackerStreamSessionStorage;
const streamSessionCoordinator =
  globalThis.TikTokLiveTrackerStreamSessionCoordinator;
const captureProtocol = globalThis.TikTokLiveTrackerCaptureProtocol;
const captureIntegration = globalThis.TikTokLiveTrackerCaptureIntegration;
let storageAccessError = null;
const storageAccessReady = chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
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
const captureEventIntegration =
  captureIntegration.createCaptureIntegration({
    activeStreamCoordinator,
    captureProtocol,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
const sidePanelUrl = chrome.runtime.getURL("tagger/sidepanel.html");
const captureDashboardUrlPattern =
  /^https:\/\/shop\.tiktok\.com\/streamer\/live\/product\/dashboard(?:[?#]|$)/;
const captureStateChangedNotification = Object.freeze({
  channel: "tiktok-live-tracker.capture-state",
  version: 1,
  event: Object.freeze({ type: "capture_state_changed" }),
});
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

  if (message.channel === captureProtocol.MESSAGE_CHANNEL) {
    return {
      coordinator: captureEventIntegration,
      label: "capture",
      protocol: captureProtocol,
    };
  }

  return null;
}

function validateMessage(message, boundary) {
  const { label, protocol } = boundary;

  if (protocol === captureProtocol) {
    return captureProtocol.validateCaptureMessage(message);
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
      reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
    ].includes(command.type)
  ) {
    failBoundary(
      boundary.protocol,
      "UNAUTHORIZED_MESSAGE_SENDER",
      "Captured TikTok events cannot be issued by the side panel.",
    );
  }
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
    error instanceof captureProtocol.CaptureProtocolError ||
    error instanceof captureIntegration.CaptureIntegrationError;

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
      return boundary.coordinator.dispatch(command);
    });

  messageTail = execution.catch(() => undefined);

  execution.then(
    (data) => {
      if (
        boundary.protocol === captureProtocol &&
        isRecord(data) &&
        data.status === "accepted"
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
