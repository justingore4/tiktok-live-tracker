(function initializeReconciliationCoordinator(root, factory) {
  const reconciliationCoordinator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = reconciliationCoordinator;
  }

  root.TikTokLiveTrackerReconciliationCoordinator =
    reconciliationCoordinator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createReconciliationCoordinatorModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.reconciliation";
    const MESSAGE_VERSION = 1;
    const COMMAND_TYPES = Object.freeze({
      GET_STATE: "get_state",
      INITIALIZE_STATE: "initialize_state",
      MAP_VARIATION: "map_variation",
      UNMAP_VARIATION: "unmap_variation",
      RECORD_PAYMENT_COMPLETE: "record_payment_complete",
      MARK_UNPAID: "mark_unpaid",
      UNDO_MARK_UNPAID: "undo_mark_unpaid",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.GET_STATE]: ["type"],
      [COMMAND_TYPES.INITIALIZE_STATE]: ["inventory", "type"],
      [COMMAND_TYPES.MAP_VARIATION]: [
        "sku",
        "streamId",
        "type",
        "variationNumber",
      ],
      [COMMAND_TYPES.UNMAP_VARIATION]: [
        "streamId",
        "type",
        "variationNumber",
      ],
      [COMMAND_TYPES.RECORD_PAYMENT_COMPLETE]: [
        "soldPriceCents",
        "streamId",
        "type",
        "variationNumber",
      ],
      [COMMAND_TYPES.MARK_UNPAID]: [
        "streamId",
        "type",
        "variationNumber",
      ],
      [COMMAND_TYPES.UNDO_MARK_UNPAID]: [
        "streamId",
        "type",
        "variationNumber",
      ],
    });
    const REQUIRED_RECONCILIATION_METHODS = [
      "createReconciliationState",
      "hydrateReconciliationState",
      "mapVariation",
      "markUnpaid",
      "recordPaymentComplete",
      "unmapVariation",
      "undoMarkUnpaid",
    ];

    class ReconciliationCoordinatorError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "ReconciliationCoordinatorError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new ReconciliationCoordinatorError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Coordinator options are required.");
      }

      const { reconciliation, stateStore } = options;
      const validReconciliation =
        reconciliation &&
        REQUIRED_RECONCILIATION_METHODS.every(
          (methodName) => typeof reconciliation[methodName] === "function",
        );

      if (!validReconciliation) {
        throw new TypeError("A valid reconciliation module is required.");
      }

      if (
        !stateStore ||
        typeof stateStore.loadState !== "function" ||
        typeof stateStore.saveState !== "function"
      ) {
        throw new TypeError(
          "stateStore must provide Promise-based loadState and saveState methods.",
        );
      }

      return { reconciliation, stateStore };
    }

    function validateCommand(command) {
      if (!isPlainRecord(command) || typeof command.type !== "string") {
        fail("INVALID_COMMAND", "A state command object with a type is required.");
      }

      const expectedKeys = COMMAND_KEYS[command.type];

      if (!expectedKeys) {
        fail("UNKNOWN_COMMAND", `State command ${command.type} is not supported.`);
      }

      const actualKeys = Object.keys(command).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail(
          "INVALID_COMMAND",
          `State command ${command.type} has an invalid shape.`,
        );
      }

      if (
        command.type === COMMAND_TYPES.INITIALIZE_STATE &&
        (!Array.isArray(command.inventory) || command.inventory.length === 0)
      ) {
        fail(
          "INVALID_COMMAND",
          "initialize_state inventory must contain at least one entry.",
        );
      }

      return command.type;
    }

    function cloneSerializable(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function snapshotCommand(command) {
      validateCommand(command);

      try {
        return cloneSerializable(command);
      } catch (_error) {
        fail(
          "INVALID_COMMAND",
          "The state command must contain only JSON-serializable values.",
        );
      }
    }

    function inventoryMatches(first, second) {
      return JSON.stringify(first) === JSON.stringify(second);
    }

    function createReconciliationCoordinator(options) {
      const { reconciliation, stateStore } = validateDependencies(options);
      let loaded = false;
      let canonicalState = null;
      let commandTail = Promise.resolve();

      async function ensureLoaded() {
        if (loaded) {
          return;
        }

        const storedState = await stateStore.loadState();

        canonicalState = storedState === null
          ? null
          : reconciliation.hydrateReconciliationState(storedState);
        loaded = true;
      }

      function requireInitializedState() {
        if (canonicalState === null) {
          fail(
            "STATE_NOT_INITIALIZED",
            "Inventory must initialize reconciliation state before this command can run.",
          );
        }

        return canonicalState;
      }

      function cloneCanonicalState() {
        return reconciliation.hydrateReconciliationState(
          requireInitializedState(),
        );
      }

      function createResponse(result = null) {
        return {
          state: canonicalState === null
            ? null
            : reconciliation.hydrateReconciliationState(canonicalState),
          result: result === null ? null : cloneSerializable(result),
        };
      }

      async function initializeState(command) {
        const candidate = reconciliation.createReconciliationState(
          command.inventory,
        );

        if (canonicalState !== null) {
          if (inventoryMatches(canonicalState.inventory, candidate.inventory)) {
            return createResponse({ status: "already_initialized" });
          }

          fail(
            "STATE_ALREADY_INITIALIZED",
            "Reconciliation state already contains different inventory.",
          );
        }

        await stateStore.saveState(candidate);
        canonicalState = candidate;

        return createResponse({ status: "initialized" });
      }

      async function mutateState(operation) {
        const candidate = cloneCanonicalState();
        const result = operation(candidate);

        await stateStore.saveState(candidate);
        canonicalState = candidate;

        return createResponse(result);
      }

      async function executeCommand(command) {
        const commandType = validateCommand(command);

        await ensureLoaded();

        switch (commandType) {
          case COMMAND_TYPES.GET_STATE:
            return createResponse();
          case COMMAND_TYPES.INITIALIZE_STATE:
            return initializeState(command);
          case COMMAND_TYPES.MAP_VARIATION:
            return mutateState((state) =>
              reconciliation.mapVariation(state, {
                streamId: command.streamId,
                variationNumber: command.variationNumber,
                sku: command.sku,
              }),
            );
          case COMMAND_TYPES.UNMAP_VARIATION:
            return mutateState((state) =>
              reconciliation.unmapVariation(state, {
                streamId: command.streamId,
                variationNumber: command.variationNumber,
              }),
            );
          case COMMAND_TYPES.RECORD_PAYMENT_COMPLETE:
            return mutateState((state) =>
              reconciliation.recordPaymentComplete(state, {
                streamId: command.streamId,
                variationNumber: command.variationNumber,
                soldPriceCents: command.soldPriceCents,
              }),
            );
          case COMMAND_TYPES.MARK_UNPAID:
            return mutateState((state) =>
              reconciliation.markUnpaid(state, {
                streamId: command.streamId,
                variationNumber: command.variationNumber,
              }),
            );
          case COMMAND_TYPES.UNDO_MARK_UNPAID:
            return mutateState((state) =>
              reconciliation.undoMarkUnpaid(state, {
                streamId: command.streamId,
                variationNumber: command.variationNumber,
              }),
            );
          default:
            fail("UNKNOWN_COMMAND", `State command ${commandType} is not supported.`);
        }
      }

      function dispatch(command) {
        let commandSnapshot;

        try {
          commandSnapshot = snapshotCommand(command);
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = commandTail.then(() =>
          executeCommand(commandSnapshot),
        );

        commandTail = execution.catch(() => undefined);
        return execution;
      }

      return Object.freeze({ dispatch });
    }

    return {
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      COMMAND_TYPES,
      ReconciliationCoordinatorError,
      createReconciliationCoordinator,
    };
  },
);
