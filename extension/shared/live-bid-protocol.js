(function initializeLiveBidProtocol(root, factory) {
  const liveBidProtocol = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = liveBidProtocol;
  }

  root.TikTokLiveTrackerLiveBidProtocol = liveBidProtocol;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createLiveBidProtocolModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.live-bid";
    const MESSAGE_VERSION = 1;
    const COMMAND_TYPES = Object.freeze({
      GET_LIVE_BID: "get_live_bid",
    });
    const NOTIFICATION_TYPES = Object.freeze({
      LIVE_BID_CHANGED: "live_bid_changed",
    });

    class LiveBidProtocolError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "LiveBidProtocolError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new LiveBidProtocolError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function hasExactKeys(value, expectedKeys) {
      if (!isPlainRecord(value)) {
        return false;
      }

      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      return (
        actualKeys.length === sortedExpectedKeys.length &&
        actualKeys.every((key, index) => key === sortedExpectedKeys[index])
      );
    }

    function validateCommand(command) {
      if (!hasExactKeys(command, ["type"])) {
        fail(
          "INVALID_LIVE_BID_MESSAGE",
          "The live-bid command must contain exactly: type.",
        );
      }

      if (command.type !== COMMAND_TYPES.GET_LIVE_BID) {
        fail(
          "UNKNOWN_LIVE_BID_COMMAND",
          `Live-bid command ${command.type} is not supported.`,
        );
      }

      return command;
    }

    function validateLiveBidMessage(message) {
      if (!hasExactKeys(message, ["channel", "command", "version"])) {
        fail(
          "INVALID_LIVE_BID_MESSAGE",
          "The live-bid message has an invalid shape.",
        );
      }

      if (message.channel !== MESSAGE_CHANNEL) {
        fail(
          "INVALID_LIVE_BID_MESSAGE",
          "The live-bid message channel is invalid.",
        );
      }

      if (message.version !== MESSAGE_VERSION) {
        fail(
          "UNSUPPORTED_LIVE_BID_MESSAGE_VERSION",
          `Live-bid message version ${message.version} is not supported.`,
        );
      }

      return validateCommand(message.command);
    }

    function createLiveBidMessage(command = {
      type: COMMAND_TYPES.GET_LIVE_BID,
    }) {
      validateCommand(command);

      return {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        command: { type: command.type },
      };
    }

    function createLiveBidChangedNotification() {
      return {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        event: { type: NOTIFICATION_TYPES.LIVE_BID_CHANGED },
      };
    }

    function isLiveBidChangedNotification(message) {
      return (
        hasExactKeys(message, ["channel", "event", "version"]) &&
        message.channel === MESSAGE_CHANNEL &&
        message.version === MESSAGE_VERSION &&
        hasExactKeys(message.event, ["type"]) &&
        message.event.type === NOTIFICATION_TYPES.LIVE_BID_CHANGED
      );
    }

    return Object.freeze({
      COMMAND_TYPES,
      LiveBidProtocolError,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      NOTIFICATION_TYPES,
      createLiveBidChangedNotification,
      createLiveBidMessage,
      isLiveBidChangedNotification,
      validateLiveBidMessage,
    });
  },
);
