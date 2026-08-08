(function initializeReconciliationClient(root, factory) {
  const reconciliationClient = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = reconciliationClient;
  }

  root.TikTokLiveTrackerReconciliationClient = reconciliationClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createReconciliationClientModule() {
    "use strict";

    const REQUIRED_COMMAND_TYPES = Object.freeze([
      "GET_STATE",
      "INITIALIZE_STATE",
      "MAP_VARIATION",
      "MARK_UNPAID",
      "UNDO_MARK_UNPAID",
    ]);

    class ReconciliationClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "ReconciliationClientError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new ReconciliationClientError(code, message);
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
        if (error instanceof ReconciliationClientError) {
          throw error;
        }

        fail(code, message);
      }
    }

    function requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim() === "") {
        fail(
          "INVALID_CLIENT_COMMAND",
          `${fieldName} must be a non-empty string.`,
        );
      }

      return value.trim();
    }

    function requirePositiveInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 1) {
        fail(
          "INVALID_CLIENT_COMMAND",
          `${fieldName} must be a positive safe integer.`,
        );
      }

      return value;
    }

    function requireCommandOptions(value, expectedKeys) {
      if (!hasExactKeys(value, expectedKeys)) {
        fail(
          "INVALID_CLIENT_COMMAND",
          `Command options must contain exactly: ${[...expectedKeys]
            .sort()
            .join(", ")}.`,
        );
      }

      return value;
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Client options are required.");
      }

      const { runtime, protocol } = options;

      if (!runtime || typeof runtime.sendMessage !== "function") {
        throw new TypeError("runtime must provide sendMessage.");
      }

      if (
        !isPlainRecord(protocol) ||
        typeof protocol.MESSAGE_CHANNEL !== "string" ||
        protocol.MESSAGE_CHANNEL.trim() === "" ||
        !Number.isSafeInteger(protocol.MESSAGE_VERSION) ||
        protocol.MESSAGE_VERSION < 1 ||
        !isPlainRecord(protocol.COMMAND_TYPES)
      ) {
        throw new TypeError("A valid reconciliation message protocol is required.");
      }

      const commandValues = REQUIRED_COMMAND_TYPES.map(
        (commandName) => protocol.COMMAND_TYPES[commandName],
      );

      if (
        commandValues.some(
          (commandType) =>
            typeof commandType !== "string" || commandType.trim() === "",
        ) ||
        new Set(commandValues).size !== commandValues.length
      ) {
        throw new TypeError(
          "The reconciliation protocol is missing required command types.",
        );
      }

      return { runtime, protocol };
    }

    function parseResponse(response) {
      try {
        if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
          fail(
            "INVALID_RESPONSE",
            "The reconciliation service returned an invalid response.",
          );
        }

        if (response.ok) {
          if (
            !hasExactKeys(response, ["data", "ok"]) ||
            !hasExactKeys(response.data, ["result", "state"]) ||
            !(
              response.data.state === null ||
              isPlainRecord(response.data.state)
            ) ||
            !(
              response.data.result === null ||
              isPlainRecord(response.data.result)
            )
          ) {
            fail(
              "INVALID_RESPONSE",
              "The reconciliation service returned an invalid response.",
            );
          }

          return cloneSerializable(
            response.data,
            "INVALID_RESPONSE",
            "The reconciliation service returned an invalid response.",
          );
        }

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
            "The reconciliation service returned an invalid response.",
          );
        }

        throw new ReconciliationClientError(
          response.error.code,
          response.error.message,
        );
      } catch (error) {
        if (error instanceof ReconciliationClientError) {
          throw error;
        }

        fail(
          "INVALID_RESPONSE",
          "The reconciliation service returned an invalid response.",
        );
      }
    }

    function createReconciliationClient(options) {
      const { runtime, protocol } = validateDependencies(options);
      let commandTail = Promise.resolve();

      async function sendCommand(command) {
        const envelope = {
          channel: protocol.MESSAGE_CHANNEL,
          version: protocol.MESSAGE_VERSION,
          command,
        };
        let response;

        try {
          response = await runtime.sendMessage(envelope);
        } catch (_error) {
          fail(
            "RUNTIME_MESSAGE_FAILED",
            "Could not reach the reconciliation service.",
          );
        }

        return parseResponse(response);
      }

      function enqueueCommand(createCommand) {
        let command;

        try {
          command = cloneSerializable(
            createCommand(),
            "INVALID_CLIENT_COMMAND",
            "The reconciliation command must contain only JSON-serializable values.",
          );
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() => sendCommand(command));

        commandTail = execution.catch(() => undefined);
        return execution;
      }

      function getState() {
        return enqueueCommand(() => ({
          type: protocol.COMMAND_TYPES.GET_STATE,
        }));
      }

      function initializeState(inventory) {
        return enqueueCommand(() => {
          if (!Array.isArray(inventory) || inventory.length === 0) {
            fail(
              "INVALID_CLIENT_COMMAND",
              "inventory must contain at least one entry.",
            );
          }

          return {
            type: protocol.COMMAND_TYPES.INITIALIZE_STATE,
            inventory,
          };
        });
      }

      function mapVariation(optionsValue) {
        return enqueueCommand(() => {
          const commandOptions = requireCommandOptions(optionsValue, [
            "sku",
            "streamId",
            "variationNumber",
          ]);

          return {
            type: protocol.COMMAND_TYPES.MAP_VARIATION,
            streamId: requireNonEmptyString(
              commandOptions.streamId,
              "streamId",
            ),
            variationNumber: requirePositiveInteger(
              commandOptions.variationNumber,
              "variationNumber",
            ),
            sku: requireNonEmptyString(commandOptions.sku, "sku"),
          };
        });
      }

      function createVariationCommand(commandType, optionsValue) {
        const commandOptions = requireCommandOptions(optionsValue, [
          "streamId",
          "variationNumber",
        ]);

        return {
          type: commandType,
          streamId: requireNonEmptyString(commandOptions.streamId, "streamId"),
          variationNumber: requirePositiveInteger(
            commandOptions.variationNumber,
            "variationNumber",
          ),
        };
      }

      function markUnpaid(optionsValue) {
        return enqueueCommand(() =>
          createVariationCommand(
            protocol.COMMAND_TYPES.MARK_UNPAID,
            optionsValue,
          ),
        );
      }

      function undoMarkUnpaid(optionsValue) {
        return enqueueCommand(() =>
          createVariationCommand(
            protocol.COMMAND_TYPES.UNDO_MARK_UNPAID,
            optionsValue,
          ),
        );
      }

      return Object.freeze({
        getState,
        initializeState,
        mapVariation,
        markUnpaid,
        undoMarkUnpaid,
      });
    }

    return {
      ReconciliationClientError,
      createReconciliationClient,
    };
  },
);
