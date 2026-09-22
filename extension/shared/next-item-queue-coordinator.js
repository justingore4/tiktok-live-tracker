(function initializeNextItemQueueCoordinator(root, factory) {
  const nextItemQueueCoordinator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = nextItemQueueCoordinator;
  }

  root.TikTokLiveTrackerNextItemQueueCoordinator =
    nextItemQueueCoordinator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createNextItemQueueCoordinatorModule() {
    "use strict";

    class NextItemQueueCoordinatorError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "NextItemQueueCoordinatorError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new NextItemQueueCoordinatorError(code, message, { cause });
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
        if (error instanceof NextItemQueueCoordinatorError) {
          throw error;
        }

        fail(code, message, error);
      }
    }

    function requireTrimmedString(value, fieldName) {
      if (
        typeof value !== "string" ||
        value === "" ||
        value !== value.trim()
      ) {
        fail("INVALID_ARGUMENT", `${fieldName} must be a non-empty string.`);
      }

      return value;
    }

    function requirePositiveInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 1) {
        fail(
          "INVALID_ARGUMENT",
          `${fieldName} must be a positive safe integer.`,
        );
      }

      return value;
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Next-item queue coordinator options are required.");
      }

      const {
        activeStreamCoordinator,
        protocol,
        queueStore,
        reconciliation,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      } = options;
      const createQueueToken = options.createQueueToken ??
        (() => globalThis.crypto.randomUUID());

      if (typeof createQueueToken !== "function") {
        throw new TypeError("createQueueToken must be a function.");
      }

      if (
        !activeStreamCoordinator ||
        typeof activeStreamCoordinator.dispatch !== "function"
      ) {
        throw new TypeError("An active-stream coordinator is required.");
      }

      if (
        !protocol?.COMMAND_TYPES ||
        protocol.COMMAND_TYPES.GET_QUEUE !== "get_queue" ||
        protocol.COMMAND_TYPES.GET_QUEUE_SNAPSHOT !== "get_queue_snapshot" ||
        protocol.COMMAND_TYPES.CLEAR_QUEUE !== "clear_queue" ||
        !(protocol.QUEUE_TOKEN_PATTERN instanceof RegExp) ||
        protocol.COMMAND_TYPES.MAP_CURRENT !== "map_current" ||
        protocol.COMMAND_TYPES.TOGGLE_QUEUE !== "toggle_queue" ||
        typeof protocol.validateCommand !== "function"
      ) {
        throw new TypeError("A valid next-item queue protocol is required.");
      }

      if (
        !queueStore ||
        typeof queueStore.loadQueue !== "function" ||
        typeof queueStore.saveQueue !== "function" ||
        typeof queueStore.clearQueue !== "function"
      ) {
        throw new TypeError(
          "queueStore must provide loadQueue, saveQueue, and clearQueue.",
        );
      }

      if (
        !reconciliation ||
        typeof reconciliation.hydrateReconciliationState !== "function"
      ) {
        throw new TypeError("A valid reconciliation module is required.");
      }

      if (
        !reconciliationCoordinator?.COMMAND_TYPES ||
        reconciliationCoordinator.COMMAND_TYPES.GET_STATE !== "get_state" ||
        reconciliationCoordinator.COMMAND_TYPES.MAP_VARIATION !==
          "map_variation" ||
        reconciliationCoordinator.COMMAND_TYPES.UNMAP_VARIATION !==
          "unmap_variation"
      ) {
        throw new TypeError("A valid reconciliation coordinator module is required.");
      }

      if (!stateCoordinator || typeof stateCoordinator.dispatch !== "function") {
        throw new TypeError("A reconciliation state coordinator is required.");
      }

      if (
        !streamSession ||
        typeof streamSession.hydrateStreamSessionState !== "function"
      ) {
        throw new TypeError("A valid stream-session module is required.");
      }

      if (
        !streamSessionCoordinator?.COMMAND_TYPES ||
        streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION !==
          "get_stream_session"
      ) {
        throw new TypeError("A valid stream-session coordinator module is required.");
      }

      return {
        activeStreamCoordinator,
        createQueueToken,
        protocol,
        queueStore,
        reconciliation,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      };
    }

    function createNextItemQueueCoordinator(options) {
      const dependencies = validateDependencies(options);
      let operationTail = Promise.resolve();
      let observedQueueKey = null;
      let queueToken = null;

      function enqueue(operation) {
        const execution = operationTail.then(operation);

        operationTail = execution.catch(() => undefined);
        return execution;
      }

      function invalidateQueueSnapshot() {
        observedQueueKey = null;
        queueToken = null;
      }

      async function loadQueue() {
        const queue = await dependencies.queueStore.loadQueue();
        const key = queue === null
          ? null
          : JSON.stringify([
              queue.streamId,
              queue.sku,
              queue.armedAfterVariationNumber,
            ]);

        if (key !== observedQueueKey) {
          observedQueueKey = key;
          queueToken = null;
        }

        return queue;
      }

      async function clearPersistedQueue() {
        // Invalidate before persistence: even an uncertain failed write must
        // never leave an old badge authorized to remove a newer generation.
        invalidateQueueSnapshot();
        await dependencies.queueStore.clearQueue();
      }

      async function savePersistedQueue(queue) {
        invalidateQueueSnapshot();
        return dependencies.queueStore.saveQueue(queue);
      }

      function hydrateReconciliationState(value) {
        try {
          return dependencies.reconciliation.hydrateReconciliationState(value);
        } catch (error) {
          fail(
            "RECONCILIATION_STATE_UNAVAILABLE",
            "The current tracker inventory state could not be verified.",
            error,
          );
        }
      }

      async function resolveActiveStreamId() {
        const response = await dependencies.activeStreamCoordinator.dispatch({
          type:
            dependencies.streamSessionCoordinator.COMMAND_TYPES
              .GET_STREAM_SESSION,
        });
        let state;

        try {
          state = dependencies.streamSession.hydrateStreamSessionState(
            response?.state,
          );
        } catch (error) {
          fail(
            "ACTIVE_STREAM_STATE_UNAVAILABLE",
            "The active tracker stream could not be verified.",
            error,
          );
        }

        return state.activeSession?.streamId ?? null;
      }

      async function loadCanonicalState() {
        const response = await dependencies.stateCoordinator.dispatch({
          type:
            dependencies.reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
        });

        return hydrateReconciliationState(response?.state);
      }

      function findStream(state, streamId) {
        return state.streams.find((stream) => stream.streamId === streamId) ?? null;
      }

      function findBaseline(state, stream) {
        return state.inventoryBaselines.find(
          (baseline) => baseline.baselineId === stream.inventoryBaselineId,
        ) ?? null;
      }

      function findAuction(stream, variationNumber) {
        return stream.variations.find(
          (auction) => auction.variationNumber === variationNumber,
        ) ?? null;
      }

      function getCurrentVariationNumber(stream) {
        if (Number.isSafeInteger(stream.activeBiddingVariationNumber)) {
          return stream.activeBiddingVariationNumber;
        }

        if (stream.variations.length === 0) {
          return null;
        }

        return Math.max(
          ...stream.variations.map((auction) => auction.variationNumber),
        );
      }

      async function clearLoadedQueue(queue) {
        if (queue !== null) {
          await clearPersistedQueue();
        }
      }

      async function getActiveQueue() {
        const [activeStreamId, queue] = await Promise.all([
          resolveActiveStreamId(),
          loadQueue(),
        ]);

        if (activeStreamId === null || queue?.streamId !== activeStreamId) {
          await clearLoadedQueue(queue);
          return null;
        }

        return queue;
      }

      async function getQueue() {
        const queue = await getActiveQueue();
        return { queuedSku: queue?.sku ?? null };
      }

      async function getQueueSnapshot() {
        const queue = await getActiveQueue();

        if (queue === null) {
          return { queuedSku: null, queueToken: null, streamId: null, baselineId: null, armedAfterVariationNumber: null };
        }

        const state = await loadCanonicalState();
        const stream = findStream(state, queue.streamId);
        const baseline = stream === null ? null : findBaseline(state, stream);
        if (baseline === null) {
          fail("QUEUE_SNAPSHOT_UNAVAILABLE", "The queued item's inventory baseline could not be verified.");
        }

        if (queueToken === null) {
          let candidate;

          try {
            candidate = dependencies.createQueueToken();
          } catch (error) {
            fail(
              "QUEUE_SNAPSHOT_UNAVAILABLE",
              "The queued item could not be verified.",
              error,
            );
          }

          if (
            typeof candidate !== "string" ||
            !dependencies.protocol.QUEUE_TOKEN_PATTERN.test(candidate)
          ) {
            fail(
              "QUEUE_SNAPSHOT_UNAVAILABLE",
              "The queued item could not be verified.",
            );
          }

          // This identifier is deliberately ephemeral, never session storage.
          queueToken = candidate;
        }

        // Preview metadata is read-only. Keep the original queue anchor even if
        // capture has advanced and mapping/clearing is still waiting for retry.
        return {
          queuedSku: queue.sku, queueToken, streamId: queue.streamId,
          baselineId: baseline.baselineId,
          armedAfterVariationNumber: queue.armedAfterVariationNumber,
        };
      }

      async function clearQueue(command) {
        const activeStreamId = await resolveActiveStreamId();

        if (activeStreamId === null) {
          fail(
            "NO_ACTIVE_STREAM",
            "There is no active tracker stream to clear a queued item from.",
          );
        }

        if (command.expectedStreamId !== activeStreamId) {
          fail(
            "ACTIVE_STREAM_MISMATCH",
            "The displayed queue no longer belongs to the active tracker stream.",
          );
        }

        const queue = await loadQueue();

        if (
          queue === null ||
          queue.streamId !== activeStreamId ||
          queue.sku !== command.sku ||
          queueToken === null ||
          queueToken !== command.expectedQueueToken
        ) {
          fail(
            "QUEUE_CHANGED",
            "The queued item changed before it could be cleared. Review the current queue and try again.",
          );
        }

        await clearPersistedQueue();
        return { status: "cleared", queuedSku: null };
      }

      async function toggleQueue(command) {
        const activeStreamId = await resolveActiveStreamId();

        if (activeStreamId === null) {
          fail(
            "NO_ACTIVE_STREAM",
            "Start or resume a tracker stream before queuing the next item.",
          );
        }

        if (command.expectedStreamId !== activeStreamId) {
          fail(
            "ACTIVE_STREAM_MISMATCH",
            "The displayed inventory no longer belongs to the active tracker stream.",
          );
        }

        const state = await loadCanonicalState();
        const stream = findStream(state, activeStreamId);

        if (stream === null) {
          fail(
            "ACTIVE_STREAM_STATE_UNAVAILABLE",
            "The active tracker stream has no saved inventory state.",
          );
        }

        const currentVariationNumber = getCurrentVariationNumber(stream);

        if (currentVariationNumber === null) {
          fail(
            "NO_CURRENT_VARIATION",
            "Wait for a captured live auction variation before queuing an item.",
          );
        }

        if (command.expectedVariationNumber !== currentVariationNumber) {
          fail(
            "CURRENT_VARIATION_CHANGED",
            "The live variation changed before the item could be queued.",
          );
        }

        const baseline = findBaseline(state, stream);

        if (
          baseline === null ||
          !baseline.inventory.some((entry) => entry.sku === command.sku)
        ) {
          fail(
            "UNKNOWN_SKU",
            `The active stream inventory does not contain SKU ${command.sku}.`,
          );
        }

        const queue = await loadQueue();
        const currentAuction = findAuction(stream, currentVariationNumber);

        if (typeof currentAuction?.sku !== "string") {
          const response = await dependencies.stateCoordinator.dispatch({
            type:
              dependencies.reconciliationCoordinator.COMMAND_TYPES
                .MAP_VARIATION,
            streamId: activeStreamId,
            variationNumber: currentVariationNumber,
            sku: command.sku,
          });
          const resultingState = hydrateReconciliationState(response?.state);
          const resultingStream = findStream(resultingState, activeStreamId);
          const resultingAuction = resultingStream === null
            ? null
            : findAuction(resultingStream, currentVariationNumber);

          if (resultingAuction?.sku !== command.sku) {
            fail(
              "CURRENT_MAPPING_NOT_CONFIRMED",
              "The current variation item selection could not be confirmed.",
            );
          }

          return {
            status: "mapped_current",
            queuedSku:
              queue?.streamId === activeStreamId ? queue.sku : null,
          };
        }

        if (queue?.streamId === activeStreamId && queue.sku === command.sku) {
          await clearPersistedQueue();
          return { status: "cleared", queuedSku: null };
        }

        await savePersistedQueue({
          streamId: activeStreamId,
          sku: command.sku,
          armedAfterVariationNumber: currentVariationNumber,
        });

        return { status: "queued", queuedSku: command.sku };
      }

      async function mapCurrent(command) {
        const activeStreamId = await resolveActiveStreamId();

        if (activeStreamId === null) {
          fail(
            "NO_ACTIVE_STREAM",
            "Start or resume a tracker stream before selecting the current item.",
          );
        }

        if (command.expectedStreamId !== activeStreamId) {
          fail(
            "ACTIVE_STREAM_MISMATCH",
            "The displayed inventory no longer belongs to the active tracker stream.",
          );
        }

        const state = await loadCanonicalState();
        const stream = findStream(state, activeStreamId);

        if (stream === null) {
          fail(
            "ACTIVE_STREAM_STATE_UNAVAILABLE",
            "The active tracker stream has no saved inventory state.",
          );
        }

        const currentVariationNumber = getCurrentVariationNumber(stream);

        if (currentVariationNumber === null) {
          fail(
            "NO_CURRENT_VARIATION",
            "Wait for a captured live auction variation before selecting an item.",
          );
        }

        if (command.expectedVariationNumber !== currentVariationNumber) {
          fail(
            "CURRENT_VARIATION_CHANGED",
            "The live variation changed before the item could be selected.",
          );
        }

        const baseline = findBaseline(state, stream);

        if (
          baseline === null ||
          !baseline.inventory.some((entry) => entry.sku === command.sku)
        ) {
          fail(
            "UNKNOWN_SKU",
            `The active stream inventory does not contain SKU ${command.sku}.`,
          );
        }

        const currentAuction = findAuction(stream, currentVariationNumber);

        if (currentAuction?.sku === command.sku) {
          const response = await dependencies.stateCoordinator.dispatch({
            type:
              dependencies.reconciliationCoordinator.COMMAND_TYPES
                .UNMAP_VARIATION,
            streamId: activeStreamId,
            variationNumber: currentVariationNumber,
          });
          const resultingState = hydrateReconciliationState(response?.state);
          const resultingStream = findStream(resultingState, activeStreamId);
          const resultingAuction = resultingStream === null
            ? null
            : findAuction(resultingStream, currentVariationNumber);

          if (
            resultingAuction === null ||
            typeof resultingAuction.sku === "string"
          ) {
            fail(
              "CURRENT_UNMAPPING_NOT_CONFIRMED",
              "The current variation item removal could not be confirmed.",
            );
          }

          return { status: "unmapped_current", sku: command.sku };
        }

        const response = await dependencies.stateCoordinator.dispatch({
          type:
            dependencies.reconciliationCoordinator.COMMAND_TYPES
              .MAP_VARIATION,
          streamId: activeStreamId,
          variationNumber: currentVariationNumber,
          sku: command.sku,
        });
        const resultingState = hydrateReconciliationState(response?.state);
        const resultingStream = findStream(resultingState, activeStreamId);
        const resultingAuction = resultingStream === null
          ? null
          : findAuction(resultingStream, currentVariationNumber);

        if (resultingAuction?.sku !== command.sku) {
          fail(
            "CURRENT_MAPPING_NOT_CONFIRMED",
            "The current variation item selection could not be confirmed.",
          );
        }

        return { status: "mapped_current", sku: command.sku };
      }

      async function executeCommand(command) {
        const commandType = dependencies.protocol.validateCommand(command).type;

        if (commandType === dependencies.protocol.COMMAND_TYPES.GET_QUEUE) {
          return getQueue();
        }

        if (
          commandType === dependencies.protocol.COMMAND_TYPES.GET_QUEUE_SNAPSHOT
        ) {
          return getQueueSnapshot();
        }

        if (commandType === dependencies.protocol.COMMAND_TYPES.CLEAR_QUEUE) {
          return clearQueue(command);
        }

        if (commandType === dependencies.protocol.COMMAND_TYPES.MAP_CURRENT) {
          return mapCurrent(command);
        }

        if (commandType === dependencies.protocol.COMMAND_TYPES.TOGGLE_QUEUE) {
          return toggleQueue(command);
        }

        fail(
          "UNKNOWN_NEXT_ITEM_QUEUE_COMMAND",
          `Next-item queue command ${commandType} is not supported.`,
        );
      }

      function dispatch(command) {
        let snapshot;

        try {
          dependencies.protocol.validateCommand(command);
          snapshot = cloneSerializable(
            command,
            "INVALID_COMMAND",
            "The next-item queue command must be JSON serializable.",
          );
          dependencies.protocol.validateCommand(snapshot);
        } catch (error) {
          return Promise.reject(error);
        }

        return enqueue(() => executeCommand(snapshot));
      }

      function validateApplicationInput(input) {
        if (!hasExactKeys(input, ["state", "streamId", "variationNumber"])) {
          fail(
            "INVALID_ARGUMENT",
            "Queue application requires exactly state, streamId, and variationNumber.",
          );
        }

        return {
          state: hydrateReconciliationState(input.state),
          streamId: requireTrimmedString(input.streamId, "streamId"),
          variationNumber: requirePositiveInteger(
            input.variationNumber,
            "variationNumber",
          ),
        };
      }

      async function applyQueue(input) {
        const normalized = validateApplicationInput(input);
        const queue = await loadQueue();

        if (queue === null) {
          return { status: "no_queue", state: normalized.state };
        }

        if (queue.streamId !== normalized.streamId) {
          await clearPersistedQueue();
          return { status: "stale_queue_cleared", state: normalized.state };
        }

        const stream = findStream(normalized.state, normalized.streamId);

        if (
          stream === null ||
          stream.activeBiddingVariationNumber !== normalized.variationNumber ||
          normalized.variationNumber <= queue.armedAfterVariationNumber
        ) {
          return { status: "waiting", state: normalized.state };
        }

        const baseline = findBaseline(normalized.state, stream);

        if (
          baseline === null ||
          !baseline.inventory.some((entry) => entry.sku === queue.sku)
        ) {
          await clearPersistedQueue();
          return { status: "invalid_sku_cleared", state: normalized.state };
        }

        const auction = findAuction(stream, normalized.variationNumber);

        if (auction === null) {
          return { status: "waiting", state: normalized.state };
        }

        if (typeof auction.sku === "string") {
          await clearPersistedQueue();
          return {
            status:
              auction.sku === queue.sku
                ? "already_mapped"
                : "skipped_existing_mapping",
            state: normalized.state,
          };
        }

        const response = await dependencies.stateCoordinator.dispatch({
          type:
            dependencies.reconciliationCoordinator.COMMAND_TYPES
              .MAP_VARIATION,
          streamId: normalized.streamId,
          variationNumber: normalized.variationNumber,
          sku: queue.sku,
        });
        const resultingState = hydrateReconciliationState(response?.state);
        const resultingStream = findStream(resultingState, normalized.streamId);
        const resultingAuction = resultingStream === null
          ? null
          : findAuction(resultingStream, normalized.variationNumber);

        if (resultingAuction?.sku !== queue.sku) {
          fail(
            "QUEUE_MAPPING_NOT_CONFIRMED",
            "The queued item mapping could not be confirmed.",
          );
        }

        await clearPersistedQueue();
        return { status: "mapped", state: resultingState };
      }

      function applyToObservedBiddingVariation(input) {
        let snapshot;

        try {
          if (!hasExactKeys(input, ["state", "streamId", "variationNumber"])) {
            fail(
              "INVALID_ARGUMENT",
              "Queue application requires exactly state, streamId, and variationNumber.",
            );
          }

          snapshot = cloneSerializable(
            input,
            "INVALID_ARGUMENT",
            "Queue application input must be JSON serializable.",
          );
        } catch (error) {
          return Promise.reject(error);
        }

        return enqueue(() => applyQueue(snapshot));
      }

      function clearForStream(streamIdValue) {
        let streamId;

        try {
          streamId = requireTrimmedString(streamIdValue, "streamId");
        } catch (error) {
          return Promise.reject(error);
        }

        return enqueue(async () => {
          try {
            const queue = await loadQueue();

            if (queue?.streamId !== streamId) {
              return { status: "unchanged" };
            }

            await clearPersistedQueue();
            return { status: "cleared" };
          } catch (_error) {
            return { status: "unavailable" };
          }
        });
      }

      function clearForPresets(input) {
        let snapshot;
        try {
          if (!hasExactKeys(input, ["streamId", "capturedVariationNumbers", "blockNext", "currentVariationNumber"]) ||
              typeof input.blockNext !== "boolean" || !Array.isArray(input.capturedVariationNumbers) ||
              !Number.isSafeInteger(input.currentVariationNumber) || input.currentVariationNumber < 0) {
            fail("INVALID_ARGUMENT", "Preset queue clearing requires a stream and explicit capture targets.");
          }
          requireTrimmedString(input.streamId, "streamId");
          input.capturedVariationNumbers.forEach((number) => requirePositiveInteger(number, "variationNumber"));
          snapshot = cloneSerializable(input, "INVALID_ARGUMENT", "Preset queue context must be serializable.");
        } catch (error) { return Promise.reject(error); }
        return enqueue(async () => {
          const queue = await loadQueue();
          const blocksFutureQueue = snapshot.blockNext &&
            queue?.armedAfterVariationNumber >= snapshot.currentVariationNumber;
          if (queue?.streamId !== snapshot.streamId ||
              (!blocksFutureQueue && !snapshot.capturedVariationNumbers.some(
                (number) => number > queue.armedAfterVariationNumber))) {
            return { status: "unchanged" };
          }
          // Old Sold Items backfill must not erase a queue armed for a newer
          // live variation. Only an actual future target or next-preset conflict
          // cancels it. Also preserve an older queue already due for the current
          // captured variation: its mapping/clear may still need capture retry.
          // This shares the ordinary queue-token invalidation path.
          await clearPersistedQueue();
          return { status: "cleared" };
        });
      }

      return Object.freeze({
        applyToObservedBiddingVariation,
        clearForPresets,
        clearForStream,
        dispatch,
      });
    }

    return Object.freeze({
      NextItemQueueCoordinatorError,
      createNextItemQueueCoordinator,
    });
  },
);
