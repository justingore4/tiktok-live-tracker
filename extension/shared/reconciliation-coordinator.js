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
      CREATE_INVENTORY_BASELINE: "create_inventory_baseline",
      EXTEND_STREAM_INVENTORY_BASELINE:
        "extend_stream_inventory_baseline",
      PIN_STREAM_TO_INVENTORY_BASELINE:
        "pin_stream_to_inventory_baseline",
      OBSERVE_VARIATIONS: "observe_variations",
      OBSERVE_PAYMENT_STATUSES: "observe_payment_statuses",
      OBSERVE_BIDDING_VARIATION: "observe_bidding_variation",
      OBSERVE_ATTRIBUTED_GMV: "observe_attributed_gmv",
      MAP_VARIATION: "map_variation",
      UNMAP_VARIATION: "unmap_variation",
      RECORD_PAYMENT_COMPLETE: "record_payment_complete",
    });
    const COMMAND_KEYS = Object.freeze({
      [COMMAND_TYPES.GET_STATE]: ["type"],
      [COMMAND_TYPES.INITIALIZE_STATE]: ["inventory", "type"],
      [COMMAND_TYPES.CREATE_INVENTORY_BASELINE]: [
        "baselineId",
        "inventory",
        "sourceFingerprint",
        "type",
      ],
      [COMMAND_TYPES.EXTEND_STREAM_INVENTORY_BASELINE]: [
        "baselineId",
        "expectedBaselineId",
        "inventory",
        "sourceFingerprint",
        "streamId",
        "type",
      ],
      [COMMAND_TYPES.PIN_STREAM_TO_INVENTORY_BASELINE]: [
        "streamId",
        "type",
      ],
      [COMMAND_TYPES.OBSERVE_VARIATIONS]: [
        "streamId",
        "type",
        "variationNumbers",
      ],
      [COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES]: [
        "statuses",
        "streamId",
        "type",
      ],
      [COMMAND_TYPES.OBSERVE_BIDDING_VARIATION]: [
        "streamId",
        "type",
        "variationNumber",
      ],
      [COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV]: [
        "attributedGmvDisplay",
        "streamId",
        "type",
      ],
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
    });
    const REQUIRED_RECONCILIATION_METHODS = [
      "createReconciliationState",
      "createEmptyReconciliationState",
      "createInventoryBaseline",
      "extendStreamInventoryBaseline",
      "hydrateReconciliationState",
      "mapVariation",
      "observePaymentStatuses",
      "observeBiddingVariation",
      "observeAttributedGmv",
      "observeVariations",
      "recordPaymentComplete",
      "resolvePaymentFixingOrder",
      "pinStreamToInventoryBaseline",
      "unmapVariation",
    ];
    const OBSERVABLE_PAYMENT_STATUSES = new Set([
      "payment_processing",
      "payment_fixing",
      "payment_failed",
      "canceled",
      "payment_complete",
      "unrecognized",
    ]);
    const MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH = 24;
    const ATTRIBUTED_GMV_DISPLAY_PATTERN =
      /^\$(?:(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}|(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB])$/;

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

      if (command.type === COMMAND_TYPES.CREATE_INVENTORY_BASELINE) {
        if (
          typeof command.baselineId !== "string" ||
          command.baselineId.trim() === "" ||
          typeof command.sourceFingerprint !== "string" ||
          command.sourceFingerprint.trim() === "" ||
          !Array.isArray(command.inventory) ||
          command.inventory.length === 0
        ) {
          fail(
            "INVALID_COMMAND",
            "create_inventory_baseline requires an ID, fingerprint, and nonempty inventory.",
          );
        }
      }

      if (command.type === COMMAND_TYPES.EXTEND_STREAM_INVENTORY_BASELINE) {
        if (
          typeof command.baselineId !== "string" ||
          command.baselineId.trim() === "" ||
          typeof command.expectedBaselineId !== "string" ||
          command.expectedBaselineId.trim() === "" ||
          typeof command.sourceFingerprint !== "string" ||
          command.sourceFingerprint.trim() === "" ||
          typeof command.streamId !== "string" ||
          command.streamId.trim() === "" ||
          !Array.isArray(command.inventory) ||
          command.inventory.length === 0
        ) {
          fail(
            "INVALID_COMMAND",
            "extend_stream_inventory_baseline requires a stream, expected and new baseline IDs, fingerprint, and nonempty inventory.",
          );
        }
      }

      if (
        command.type === COMMAND_TYPES.PIN_STREAM_TO_INVENTORY_BASELINE &&
        (typeof command.streamId !== "string" ||
          command.streamId.trim() === "")
      ) {
        fail(
          "INVALID_COMMAND",
          "pin_stream_to_inventory_baseline requires a non-empty streamId.",
        );
      }

      if (command.type === COMMAND_TYPES.OBSERVE_VARIATIONS) {
        if (
          typeof command.streamId !== "string" ||
          command.streamId.trim() === "" ||
          !Array.isArray(command.variationNumbers) ||
          command.variationNumbers.length === 0 ||
          command.variationNumbers.length > 1000 ||
          command.variationNumbers.some(
            (variationNumber) =>
              !Number.isSafeInteger(variationNumber) || variationNumber < 1,
          ) ||
          new Set(command.variationNumbers).size !==
            command.variationNumbers.length
        ) {
          fail(
            "INVALID_COMMAND",
            "observe_variations requires a stream and 1 to 1000 unique positive variation numbers.",
          );
        }
      }

      if (command.type === COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES) {
        const statusesAreValid =
          typeof command.streamId === "string" &&
          command.streamId.trim() !== "" &&
          Array.isArray(command.statuses) &&
          command.statuses.length > 0 &&
          command.statuses.length <= 1000 &&
          command.statuses.every((status) => {
            if (!isPlainRecord(status)) {
              return false;
            }

            const keys = Object.keys(status).sort();

            return (
              keys.length === 2 &&
              keys[0] === "observedPaymentStatus" &&
              keys[1] === "variationNumber" &&
              Number.isSafeInteger(status.variationNumber) &&
              status.variationNumber >= 1 &&
              OBSERVABLE_PAYMENT_STATUSES.has(
                status.observedPaymentStatus,
              )
            );
          }) &&
          new Set(
            command.statuses.map((status) => status.variationNumber),
          ).size === command.statuses.length;

        if (!statusesAreValid) {
          fail(
            "INVALID_COMMAND",
            "observe_payment_statuses requires a stream and 1 to 1000 unique observable payment statuses.",
          );
        }
      }

      if (command.type === COMMAND_TYPES.OBSERVE_BIDDING_VARIATION) {
        if (
          typeof command.streamId !== "string" ||
          command.streamId.trim() === "" ||
          !Number.isSafeInteger(command.variationNumber) ||
          command.variationNumber < 1
        ) {
          fail(
            "INVALID_COMMAND",
            "observe_bidding_variation requires a stream and positive variation number.",
          );
        }
      }

      if (command.type === COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV) {
        if (
          typeof command.streamId !== "string" ||
          command.streamId.trim() === "" ||
          typeof command.attributedGmvDisplay !== "string" ||
          command.attributedGmvDisplay.length >
            MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH ||
          !ATTRIBUTED_GMV_DISPLAY_PATTERN.test(
            command.attributedGmvDisplay,
          )
        ) {
          fail(
            "INVALID_COMMAND",
            "observe_attributed_gmv requires a stream and canonical TikTok Attributed GMV display.",
          );
        }
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

    function activeInventory(state) {
      return state.inventoryBaselines.find(
        (baseline) =>
          baseline.baselineId === state.activeInventoryBaselineId,
      )?.inventory ?? null;
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
          if (
            canonicalState.inventoryBaselines.length === 1 &&
            canonicalState.inventoryBaselines[0].sourceFingerprint === null &&
            inventoryMatches(
              activeInventory(canonicalState),
              activeInventory(candidate),
            )
          ) {
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

      async function createInventoryBaseline(command) {
        const candidate = canonicalState === null
          ? reconciliation.createEmptyReconciliationState()
          : reconciliation.hydrateReconciliationState(canonicalState);
        const result = reconciliation.createInventoryBaseline(candidate, {
          baselineId: command.baselineId,
          sourceFingerprint: command.sourceFingerprint,
          inventory: command.inventory,
        });

        if (
          canonicalState !== null &&
          JSON.stringify(candidate) === JSON.stringify(canonicalState)
        ) {
          return createResponse(result);
        }

        await stateStore.saveState(candidate);
        canonicalState = candidate;

        return createResponse(result);
      }

      async function mutateState(operation) {
        const candidate = cloneCanonicalState();
        const result = operation(candidate);

        if (JSON.stringify(candidate) === JSON.stringify(canonicalState)) {
          return createResponse(result);
        }

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
          case COMMAND_TYPES.CREATE_INVENTORY_BASELINE:
            return createInventoryBaseline(command);
          case COMMAND_TYPES.EXTEND_STREAM_INVENTORY_BASELINE:
            return mutateState((state) =>
              reconciliation.extendStreamInventoryBaseline(state, {
                streamId: command.streamId,
                expectedBaselineId: command.expectedBaselineId,
                baselineId: command.baselineId,
                sourceFingerprint: command.sourceFingerprint,
                inventory: command.inventory,
              }),
            );
          case COMMAND_TYPES.PIN_STREAM_TO_INVENTORY_BASELINE:
            return mutateState((state) =>
              reconciliation.pinStreamToInventoryBaseline(state, {
                streamId: command.streamId,
              }),
            );
          case COMMAND_TYPES.OBSERVE_VARIATIONS:
            return mutateState((state) =>
              reconciliation.observeVariations(state, {
                streamId: command.streamId,
                variationNumbers: command.variationNumbers,
              }),
            );
          case COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES:
            return mutateState((state) =>
              reconciliation.observePaymentStatuses(state, {
                streamId: command.streamId,
                statuses: command.statuses,
              }),
            );
          case COMMAND_TYPES.OBSERVE_BIDDING_VARIATION:
            return mutateState((state) =>
              reconciliation.observeBiddingVariation(state, {
                streamId: command.streamId,
                variationNumber: command.variationNumber,
              }),
            );
          case COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV:
            return mutateState((state) =>
              reconciliation.observeAttributedGmv(state, {
                streamId: command.streamId,
                attributedGmvDisplay: command.attributedGmvDisplay,
              }),
            );
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

      function snapshotInternalInput(input) {
        return cloneSerializable(input);
      }

      return Object.freeze({
        dispatch,
        resolvePaymentFixingOrder(input) {
          let snapshot;

          try {
            snapshot = snapshotInternalInput(input);
          } catch (error) {
            return Promise.reject(error);
          }

          const execution = commandTail.then(async () => {
            await ensureLoaded();
            return mutateState((state) =>
              reconciliation.resolvePaymentFixingOrder(state, snapshot),
            );
          });

          commandTail = execution.catch(() => undefined);
          return execution;
        },
      });
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
