(function initializeNextItemQueueProtocol(root, factory) {
  const nextItemQueueProtocol = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = nextItemQueueProtocol;
  }

  root.TikTokLiveTrackerNextItemQueueProtocol = nextItemQueueProtocol;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createNextItemQueueProtocolModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.next-item-queue";
    const MESSAGE_VERSION = 1;
    const QUEUE_TOKEN_PATTERN =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const COMMAND_TYPES = Object.freeze({
      GET_QUEUE: "get_queue",
      GET_QUEUE_SNAPSHOT: "get_queue_snapshot",
      CLEAR_QUEUE: "clear_queue",
      MAP_CURRENT: "map_current",
      TOGGLE_QUEUE: "toggle_queue",
    });
    const NOTIFICATION_TYPES = Object.freeze({
      QUEUE_CHANGED: "queue_changed",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.GET_QUEUE]: ["type"],
      [COMMAND_TYPES.GET_QUEUE_SNAPSHOT]: ["type"],
      [COMMAND_TYPES.CLEAR_QUEUE]: [
        "expectedQueueToken",
        "expectedStreamId",
        "sku",
        "type",
      ],
      [COMMAND_TYPES.MAP_CURRENT]: [
        "expectedStreamId",
        "expectedVariationNumber",
        "sku",
        "type",
      ],
      [COMMAND_TYPES.TOGGLE_QUEUE]: [
        "expectedStreamId",
        "expectedVariationNumber",
        "sku",
        "type",
      ],
    });

    class NextItemQueueProtocolError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "NextItemQueueProtocolError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new NextItemQueueProtocolError(code, message);
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

    function requireTrimmedString(value, fieldName) {
      if (
        typeof value !== "string" ||
        value === "" ||
        value !== value.trim()
      ) {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          `${fieldName} must be a non-empty trimmed string.`,
        );
      }

      return value;
    }

    function validateCommand(command) {
      if (!isPlainRecord(command) || typeof command.type !== "string") {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          "A next-item queue command object with a type is required.",
        );
      }

      const expectedKeys = COMMAND_KEYS[command.type];

      if (!expectedKeys) {
        fail(
          "UNKNOWN_NEXT_ITEM_QUEUE_COMMAND",
          `Next-item queue command ${command.type} is not supported.`,
        );
      }

      if (!hasExactKeys(command, expectedKeys)) {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          `Next-item queue command ${command.type} has an invalid shape.`,
        );
      }

      if (
        command.type === COMMAND_TYPES.MAP_CURRENT ||
        command.type === COMMAND_TYPES.TOGGLE_QUEUE ||
        command.type === COMMAND_TYPES.CLEAR_QUEUE
      ) {
        requireTrimmedString(command.expectedStreamId, "expectedStreamId");
        requireTrimmedString(command.sku, "sku");
      }

      if (
        command.type === COMMAND_TYPES.MAP_CURRENT ||
        command.type === COMMAND_TYPES.TOGGLE_QUEUE
      ) {
        if (
          !Number.isSafeInteger(command.expectedVariationNumber) ||
          command.expectedVariationNumber < 1
        ) {
          fail(
            "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
            "expectedVariationNumber must be a positive safe integer.",
          );
        }
      }

      if (
        command.type === COMMAND_TYPES.CLEAR_QUEUE &&
        (
          typeof command.expectedQueueToken !== "string" ||
          !QUEUE_TOKEN_PATTERN.test(command.expectedQueueToken)
        )
      ) {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          "expectedQueueToken must identify the displayed queue generation.",
        );
      }

      return command;
    }

    function cloneSerializable(value) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_error) {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          "Next-item queue messages must be JSON serializable.",
        );
      }
    }

    function createNextItemQueueMessage(command = {
      type: COMMAND_TYPES.GET_QUEUE,
    }) {
      validateCommand(command);
      const snapshot = cloneSerializable(command);
      validateCommand(snapshot);

      return {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        command: snapshot,
      };
    }

    function validateNextItemQueueMessage(message) {
      if (!hasExactKeys(message, ["channel", "command", "version"])) {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          "The next-item queue message has an invalid shape.",
        );
      }

      if (message.channel !== MESSAGE_CHANNEL) {
        fail(
          "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
          "The next-item queue message channel is invalid.",
        );
      }

      if (message.version !== MESSAGE_VERSION) {
        fail(
          "UNSUPPORTED_NEXT_ITEM_QUEUE_MESSAGE_VERSION",
          `Next-item queue message version ${message.version} is not supported.`,
        );
      }

      const command = cloneSerializable(message.command);
      validateCommand(command);
      return command;
    }

    function createQueueChangedNotification() {
      return {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        event: { type: NOTIFICATION_TYPES.QUEUE_CHANGED },
      };
    }

    function isQueueChangedNotification(message) {
      return (
        hasExactKeys(message, ["channel", "event", "version"]) &&
        message.channel === MESSAGE_CHANNEL &&
        message.version === MESSAGE_VERSION &&
        hasExactKeys(message.event, ["type"]) &&
        message.event.type === NOTIFICATION_TYPES.QUEUE_CHANGED
      );
    }

    return Object.freeze({
      COMMAND_TYPES,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      NOTIFICATION_TYPES,
      QUEUE_TOKEN_PATTERN,
      NextItemQueueProtocolError,
      createNextItemQueueMessage,
      createQueueChangedNotification,
      isQueueChangedNotification,
      validateCommand,
      validateNextItemQueueMessage,
    });
  },
);
