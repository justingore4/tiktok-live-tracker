"use strict";

importScripts(
  "shared/reconciliation.js",
  "shared/reconciliation-storage.js",
  "shared/reconciliation-coordinator.js",
);

const reconciliation = globalThis.TikTokLiveTrackerReconciliation;
const reconciliationStorage =
  globalThis.TikTokLiveTrackerReconciliationStorage;
const reconciliationCoordinator =
  globalThis.TikTokLiveTrackerReconciliationCoordinator;
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
const sidePanelUrl = chrome.runtime.getURL("tagger/sidepanel.html");

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    console.error(
      "[TikTok Live Tracker] Could not configure the side panel.",
      error,
    );
  });

function failBoundary(code, message) {
  throw new reconciliationCoordinator.ReconciliationCoordinatorError(
    code,
    message,
  );
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isStateMessage(message) {
  return (
    isRecord(message) &&
    message.channel === reconciliationCoordinator.MESSAGE_CHANNEL
  );
}

function validateMessage(message) {
  const expectedKeys = ["channel", "command", "version"];
  const actualKeys = Object.keys(message).sort();

  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    !isRecord(message.command)
  ) {
    failBoundary(
      "INVALID_MESSAGE",
      "The reconciliation message has an invalid shape.",
    );
  }

  if (!Number.isSafeInteger(message.version) || message.version < 1) {
    failBoundary(
      "INVALID_MESSAGE",
      "The reconciliation message version must be a positive integer.",
    );
  }

  if (message.version !== reconciliationCoordinator.MESSAGE_VERSION) {
    failBoundary(
      "UNSUPPORTED_MESSAGE_VERSION",
      `Reconciliation message version ${message.version} is not supported.`,
    );
  }

  return message.command;
}

function validateSender(sender, command) {
  if (
    !sender ||
    sender.id !== chrome.runtime.id ||
    sender.url !== sidePanelUrl
  ) {
    failBoundary(
      "UNAUTHORIZED_MESSAGE_SENDER",
      "This extension context cannot issue reconciliation commands.",
    );
  }

  if (
    command.type ===
    reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE
  ) {
    failBoundary(
      "UNAUTHORIZED_MESSAGE_SENDER",
      "Captured TikTok payment events are not connected yet.",
    );
  }
}

function serializeError(error) {
  const knownError =
    error instanceof
      reconciliationCoordinator.ReconciliationCoordinatorError ||
    error instanceof reconciliation.ReconciliationError ||
    error instanceof reconciliationStorage.ReconciliationStorageError;

  if (knownError) {
    return { code: error.code, message: error.message };
  }

  console.error(
    "[TikTok Live Tracker] Unexpected reconciliation command failure.",
    error,
  );

  return {
    code: "INTERNAL_ERROR",
    message: "The reconciliation command could not be completed.",
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isStateMessage(message)) {
    return false;
  }

  Promise.resolve()
    .then(() => storageAccessReady)
    .then(() => {
      if (storageAccessError) {
        failBoundary(
          "STORAGE_ACCESS_RESTRICTION_FAILED",
          "Canonical storage access could not be secured.",
        );
      }

      const command = validateMessage(message);

      validateSender(sender, command);
      return stateCoordinator.dispatch(command);
    })
    .then(
      (data) => sendResponse({ ok: true, data }),
      (error) => sendResponse({ ok: false, error: serializeError(error) }),
    );

  return true;
});
