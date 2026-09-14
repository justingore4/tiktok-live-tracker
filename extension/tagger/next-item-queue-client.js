(function initializeNextItemQueueClient(root, factory) {
  const nextItemQueueClient = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = nextItemQueueClient;
  }

  root.TikTokLiveTrackerNextItemQueueClient = nextItemQueueClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createNextItemQueueClientModule() {
    "use strict";

    const TOGGLE_STATUSES = new Set([
      "cleared",
      "mapped_current",
      "queued",
    ]);

    class NextItemQueueClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "NextItemQueueClientError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new NextItemQueueClientError(code, message);
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

    function cloneSerializable(value, code, message) {
      try {
        const serialized = JSON.stringify(value);

        if (serialized === undefined) {
          fail(code, message);
        }

        return JSON.parse(serialized);
      } catch (error) {
        if (error instanceof NextItemQueueClientError) {
          throw error;
        }

        fail(code, message);
      }
    }

    function requireTrimmedString(value, fieldName) {
      if (
        typeof value !== "string" ||
        value === "" ||
        value !== value.trim()
      ) {
        fail(
          "INVALID_CLIENT_COMMAND",
          `${fieldName} must be a non-empty trimmed string.`,
        );
      }

      return value;
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Next-item queue client options are required.");
      }

      const { protocol, runtime } = options;

      if (!runtime || typeof runtime.sendMessage !== "function") {
        throw new TypeError("runtime must provide sendMessage.");
      }

      if (
        !protocol?.COMMAND_TYPES ||
        protocol.COMMAND_TYPES.GET_QUEUE !== "get_queue" ||
        protocol.COMMAND_TYPES.GET_QUEUE_SNAPSHOT !== "get_queue_snapshot" ||
        protocol.COMMAND_TYPES.CLEAR_QUEUE !== "clear_queue" ||
        !(protocol.QUEUE_TOKEN_PATTERN instanceof RegExp) ||
        protocol.COMMAND_TYPES.MAP_CURRENT !== "map_current" ||
        protocol.COMMAND_TYPES.TOGGLE_QUEUE !== "toggle_queue" ||
        typeof protocol.createNextItemQueueMessage !== "function"
      ) {
        throw new TypeError("A valid next-item queue protocol is required.");
      }

      return { protocol, runtime };
    }

    function requireQueuedSku(value) {
      if (value === null) {
        return null;
      }

      if (
        typeof value !== "string" ||
        value === "" ||
        value !== value.trim()
      ) {
        fail(
          "INVALID_RESPONSE",
          "The next-item queue service returned an invalid response.",
        );
      }

      return value;
    }

    function parseResponse(response, command, protocol) {
      const commandType = command.type;
      if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
        fail(
          "INVALID_RESPONSE",
          "The next-item queue service returned an invalid response.",
        );
      }

      if (!response.ok) {
        if (
          !hasExactKeys(response, ["error", "ok"]) ||
          !hasExactKeys(response.error, ["code", "message"]) ||
          typeof response.error.code !== "string" ||
          response.error.code.trim() === "" ||
          typeof response.error.message !== "string" ||
          response.error.message.trim() === ""
        ) {
          fail(
            "INVALID_RESPONSE",
            "The next-item queue service returned an invalid response.",
          );
        }

        throw new NextItemQueueClientError(
          response.error.code,
          response.error.message,
        );
      }

      if (!hasExactKeys(response, ["data", "ok"])) {
        fail(
          "INVALID_RESPONSE",
          "The next-item queue service returned an invalid response.",
        );
      }

      if (commandType === protocol.COMMAND_TYPES.GET_QUEUE) {
        if (!hasExactKeys(response.data, ["queuedSku"])) {
          fail(
            "INVALID_RESPONSE",
            "The next-item queue service returned an invalid response.",
          );
        }

        return { queuedSku: requireQueuedSku(response.data.queuedSku) };
      }

      if (commandType === protocol.COMMAND_TYPES.GET_QUEUE_SNAPSHOT) {
        if (!hasExactKeys(response.data, ["queuedSku", "queueToken"])) {
          fail(
            "INVALID_RESPONSE",
            "The next-item queue service returned an invalid snapshot.",
          );
        }

        const queuedSku = requireQueuedSku(response.data.queuedSku);
        const queueToken = response.data.queueToken;

        if (
          (queuedSku === null && queueToken !== null) ||
          (
            queuedSku !== null &&
            (
              typeof queueToken !== "string" ||
              !protocol.QUEUE_TOKEN_PATTERN.test(queueToken)
            )
          )
        ) {
          fail(
            "INVALID_RESPONSE",
            "The next-item queue service returned an invalid snapshot.",
          );
        }

        return { queuedSku, queueToken };
      }

      if (commandType === protocol.COMMAND_TYPES.CLEAR_QUEUE) {
        if (
          !hasExactKeys(response.data, ["queuedSku", "status"]) ||
          response.data.status !== "cleared" ||
          response.data.queuedSku !== null
        ) {
          fail(
            "INVALID_RESPONSE",
            "The next-item queue service returned an invalid clear result.",
          );
        }

        return { status: "cleared", queuedSku: null };
      }

      if (commandType === protocol.COMMAND_TYPES.MAP_CURRENT) {
        if (
          !hasExactKeys(response.data, ["sku", "status"]) ||
          !["mapped_current", "unmapped_current"].includes(
            response.data.status,
          ) ||
          typeof response.data.sku !== "string" ||
          response.data.sku !== command.sku
        ) {
          fail(
            "INVALID_RESPONSE",
            "The next-item queue service returned an invalid response.",
          );
        }

        return { status: response.data.status, sku: response.data.sku };
      }

      if (
        commandType !== protocol.COMMAND_TYPES.TOGGLE_QUEUE ||
        !hasExactKeys(response.data, ["queuedSku", "status"]) ||
        !TOGGLE_STATUSES.has(response.data.status)
      ) {
        fail(
          "INVALID_RESPONSE",
          "The next-item queue service returned an invalid response.",
        );
      }

      const queuedSku = requireQueuedSku(response.data.queuedSku);

      if (
        (response.data.status === "cleared" && queuedSku !== null) ||
        (response.data.status === "queued" && queuedSku !== command.sku)
      ) {
        fail(
          "INVALID_RESPONSE",
          "The next-item queue service returned an invalid response.",
        );
      }

      return { status: response.data.status, queuedSku };
    }

    function createNextItemQueueClient(options) {
      const { protocol, runtime } = validateDependencies(options);
      let commandTail = Promise.resolve();

      async function sendCommand(command) {
        let response;

        try {
          response = await runtime.sendMessage(
            protocol.createNextItemQueueMessage(command),
          );
        } catch (_error) {
          fail(
            "RUNTIME_MESSAGE_FAILED",
            "Could not reach the next-item queue service.",
          );
        }

        return parseResponse(response, command, protocol);
      }

      function enqueueCommand(createCommand) {
        let command;

        try {
          command = cloneSerializable(
            createCommand(),
            "INVALID_CLIENT_COMMAND",
            "The next-item queue command must be JSON serializable.",
          );
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() => sendCommand(command));

        commandTail = execution.catch(() => undefined);
        return execution;
      }

      function getQueue() {
        return enqueueCommand(() => ({
          type: protocol.COMMAND_TYPES.GET_QUEUE,
        }));
      }

      function getQueueSnapshot() {
        return enqueueCommand(() => ({
          type: protocol.COMMAND_TYPES.GET_QUEUE_SNAPSHOT,
        }));
      }

      function clearQueue(optionsValue) {
        return enqueueCommand(() => {
          if (
            !hasExactKeys(optionsValue, [
              "expectedStreamId",
              "expectedQueueToken",
              "sku",
            ]) ||
            typeof optionsValue.expectedQueueToken !== "string" ||
            !protocol.QUEUE_TOKEN_PATTERN.test(optionsValue.expectedQueueToken)
          ) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "Clear options must identify exactly the displayed stream, queue token, and SKU.",
            );
          }

          return {
            type: protocol.COMMAND_TYPES.CLEAR_QUEUE,
            expectedStreamId: requireTrimmedString(
              optionsValue.expectedStreamId,
              "expectedStreamId",
            ),
            expectedQueueToken: optionsValue.expectedQueueToken,
            sku: requireTrimmedString(optionsValue.sku, "sku"),
          };
        });
      }

      function toggleQueue(optionsValue) {
        return enqueueCommand(() => {
          if (
            !hasExactKeys(optionsValue, [
              "expectedStreamId",
              "expectedVariationNumber",
              "sku",
            ])
          ) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "Toggle options must contain exactly expectedStreamId, expectedVariationNumber, and sku.",
            );
          }

          if (
            !Number.isSafeInteger(optionsValue.expectedVariationNumber) ||
            optionsValue.expectedVariationNumber < 1
          ) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "expectedVariationNumber must be a positive safe integer.",
            );
          }

          return {
            type: protocol.COMMAND_TYPES.TOGGLE_QUEUE,
            expectedStreamId: requireTrimmedString(
              optionsValue.expectedStreamId,
              "expectedStreamId",
            ),
            expectedVariationNumber: optionsValue.expectedVariationNumber,
            sku: requireTrimmedString(optionsValue.sku, "sku"),
          };
        });
      }

      function mapCurrent(optionsValue) {
        return enqueueCommand(() => {
          if (
            !hasExactKeys(optionsValue, [
              "expectedStreamId",
              "expectedVariationNumber",
              "sku",
            ])
          ) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "Map-current options must contain exactly expectedStreamId, expectedVariationNumber, and sku.",
            );
          }

          if (
            !Number.isSafeInteger(optionsValue.expectedVariationNumber) ||
            optionsValue.expectedVariationNumber < 1
          ) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "expectedVariationNumber must be a positive safe integer.",
            );
          }

          return {
            type: protocol.COMMAND_TYPES.MAP_CURRENT,
            expectedStreamId: requireTrimmedString(
              optionsValue.expectedStreamId,
              "expectedStreamId",
            ),
            expectedVariationNumber: optionsValue.expectedVariationNumber,
            sku: requireTrimmedString(optionsValue.sku, "sku"),
          };
        });
      }

      return Object.freeze({
        clearQueue,
        getQueue,
        getQueueSnapshot,
        mapCurrent,
        toggleQueue,
      });
    }

    return Object.freeze({
      NextItemQueueClientError,
      createNextItemQueueClient,
    });
  },
);
