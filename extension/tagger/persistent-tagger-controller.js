(function initializePersistentTaggerController(root, factory) {
  const persistentTaggerController = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = persistentTaggerController;
  }

  root.TikTokLiveTrackerPersistentTaggerController =
    persistentTaggerController;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createPersistentTaggerControllerModule() {
    "use strict";

    const MODE = "saved_session";
    const PHASES = Object.freeze({
      IDLE: "idle",
      LOADING: "loading",
      READY: "ready",
      SAVING: "saving",
      ERROR: "error",
    });
    const OPERATIONS = Object.freeze({
      LOAD: "load",
      REFRESH: "refresh",
      INITIALIZE: "initialize",
      MAP_VARIATION: "map_variation",
      UNMAP_VARIATION: "unmap_variation",
    });
    const REQUIRED_CLIENT_METHODS = Object.freeze([
      "getState",
      "initializeState",
      "mapVariation",
      "unmapVariation",
    ]);

    class PersistentTaggerControllerError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "PersistentTaggerControllerError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new PersistentTaggerControllerError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function requireNonEmptyString(value, fieldName) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${fieldName} must be a non-empty string.`);
      }

      return value.trim();
    }

    function requirePositiveInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${fieldName} must be a positive safe integer.`);
      }

      return value;
    }

    function requireNonNegativeInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
      }

      return value;
    }

    function cloneSerializable(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Persistent tagger controller options are required.");
      }

      const { client, mappingWorkflow, reconciliation } = options;

      if (
        !client ||
        REQUIRED_CLIENT_METHODS.some(
          (methodName) => typeof client[methodName] !== "function",
        )
      ) {
        throw new TypeError(
          "client must provide saved-state read, initialize, mapping, and unmapping methods.",
        );
      }

      if (
        !mappingWorkflow ||
        typeof mappingWorkflow.createMappingSession !== "function"
      ) {
        throw new TypeError(
          "mappingWorkflow must provide createMappingSession.",
        );
      }

      if (
        !reconciliation ||
        typeof reconciliation.hydrateReconciliationState !== "function"
      ) {
        throw new TypeError(
          "reconciliation must provide hydrateReconciliationState.",
        );
      }

      return { client, mappingWorkflow, reconciliation };
    }

    function normalizeInventory(inventory) {
      if (!Array.isArray(inventory) || inventory.length === 0) {
        throw new TypeError(
          "Persistent tagger inventory must contain at least one entry.",
        );
      }

      const seenSkus = new Set();

      return inventory.map((entry, index) => {
        if (!isPlainRecord(entry)) {
          throw new TypeError(`inventory[${index}] must be an object.`);
        }

        const normalized = {
          ...cloneSerializable(entry),
          sku: requireNonEmptyString(entry.sku, `inventory[${index}].sku`),
          item: requireNonEmptyString(entry.item, `inventory[${index}].item`),
          style: String(entry.style ?? "").trim(),
          size: requireNonEmptyString(
            String(entry.size ?? ""),
            `inventory[${index}].size`,
          ),
          quantityReceived: requireNonNegativeInteger(
            entry.quantityReceived,
            `inventory[${index}].quantityReceived`,
          ),
          unitCostCents: requireNonNegativeInteger(
            entry.unitCostCents,
            `inventory[${index}].unitCostCents`,
          ),
        };

        if (seenSkus.has(normalized.sku)) {
          throw new TypeError(
            `Persistent tagger inventory contains duplicate SKU ${normalized.sku}.`,
          );
        }

        seenSkus.add(normalized.sku);
        return normalized;
      });
    }

    function toCanonicalInventory(inventory) {
      return inventory.map((entry) => ({
        sku: entry.sku,
        item: entry.item,
        style: entry.style,
        size: entry.size,
        quantityOnHandAtImport: entry.quantityReceived,
        unitCostCents: entry.unitCostCents,
      }));
    }

    function requireInitializationOptions(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Inventory initialization options are required.");
      }

      if (
        !options.client ||
        typeof options.client.getState !== "function" ||
        typeof options.client.initializeState !== "function"
      ) {
        throw new TypeError(
          "client must provide saved-state read and initialize methods.",
        );
      }

      return {
        client: options.client,
        inventory: normalizeInventory(options.inventory),
      };
    }

    async function ensureInventoryInitialized(options) {
      const { client, inventory } = requireInitializationOptions(options);
      let response = requireClientResponse(await client.getState(), true);
      let initialized = false;

      if (response.state === null) {
        response = requireClientResponse(
          await client.initializeState(
            cloneSerializable(toCanonicalInventory(inventory)),
          ),
          false,
        );
        initialized = true;
      }

      return { initialized, response };
    }

    function getPinnedDisplayInventory(canonicalState, streamId) {
      const stream = canonicalState.streams.find(
        (candidate) => candidate.streamId === streamId,
      );
      const baselineId = stream?.inventoryBaselineId;

      if (typeof baselineId !== "string" || baselineId === "") {
        fail(
          "MISSING_STREAM_BASELINE_PIN",
          "The tracker stream is not pinned to an inventory baseline.",
        );
      }

      const baseline = canonicalState.inventoryBaselines.find(
        (candidate) => candidate.baselineId === baselineId,
      );

      if (!baseline) {
        fail(
          "MISSING_INVENTORY_BASELINE",
          "The tracker stream does not have an available inventory baseline.",
        );
      }

      return normalizeInventory(
        baseline.inventory.map((entry) => ({
          sku: entry.sku,
          item: entry.item,
          style: entry.style,
          size: entry.size,
          quantityReceived: entry.quantityOnHandAtImport,
          unitCostCents: entry.unitCostCents,
        })),
      );
    }

    function normalizeVariationNumbers(values, currentVariationNumber) {
      const supplied = values === undefined
        ? [currentVariationNumber]
        : values;

      if (!Array.isArray(supplied)) {
        throw new TypeError("variationNumbers must be an array when provided.");
      }

      const normalized = supplied.map((value, index) =>
        requirePositiveInteger(value, `variationNumbers[${index}]`),
      );

      if (new Set(normalized).size !== normalized.length) {
        throw new TypeError("variationNumbers cannot contain duplicates.");
      }

      if (!normalized.includes(currentVariationNumber)) {
        throw new TypeError(
          "variationNumbers must include currentVariationNumber.",
        );
      }

      return normalized;
    }

    function requireClientResponse(response, allowNullState) {
      if (!isPlainRecord(response)) {
        fail("INVALID_CLIENT_RESPONSE", "The saved-state service returned invalid data.");
      }

      const keys = Object.keys(response).sort();

      if (
        keys.length !== 2 ||
        keys[0] !== "result" ||
        keys[1] !== "state"
      ) {
        fail("INVALID_CLIENT_RESPONSE", "The saved-state service returned invalid data.");
      }

      if (response.state === null && !allowNullState) {
        fail(
          "MISSING_CANONICAL_STATE",
          "The saved-state service did not return initialized tracker data.",
        );
      }

      if (response.state === undefined) {
        fail("INVALID_CLIENT_RESPONSE", "The saved-state service returned invalid data.");
      }

      return response;
    }

    function normalizeError(error, scope) {
      const knownCode =
        typeof error?.code === "string" && error.code.trim() !== "";
      const knownMessage =
        typeof error?.message === "string" && error.message.trim() !== "";

      return {
        scope,
        code: knownCode
          ? error.code
          : scope === "load"
            ? "SESSION_LOAD_FAILED"
            : scope === "refresh"
              ? "SESSION_REFRESH_FAILED"
            : "SESSION_SAVE_FAILED",
        message: knownCode && knownMessage
          ? error.message
          : scope === "load"
            ? "Saved tracker data could not be restored. Nothing was changed."
            : scope === "refresh"
              ? "New saved tracker data could not be loaded. The last saved view is still shown."
            : "The change could not be saved. The previous saved view is still shown.",
      };
    }

    function createPersistentTaggerController(options) {
      const { client, mappingWorkflow, reconciliation } =
        validateDependencies(options);
      const streamId = requireNonEmptyString(options.streamId, "streamId");
      const currentVariationNumber = requirePositiveInteger(
        options.currentVariationNumber,
        "currentVariationNumber",
      );
      const variationNumbers = normalizeVariationNumbers(
        options.variationNumbers,
        currentVariationNumber,
      );
      const listeners = new Set();
      let phase = PHASES.IDLE;
      let operation = null;
      let error = null;
      let view = null;
      let projectionSession = null;
      let selectedVariationNumber = currentVariationNumber;
      // This baseline advances with canonical capture even while an employee
      // deliberately keeps a historical variation selected.
      let latestVariationNumber = currentVariationNumber;
      let started = false;
      let activePromise = null;
      let queuedRefresh = null;
      let retryDescriptor = null;

      function createSnapshot() {
        return {
          mode: MODE,
          phase,
          operation,
          busy: phase === PHASES.LOADING || phase === PHASES.SAVING,
          error: error === null ? null : { ...error },
          view: view === null ? null : cloneSerializable(view),
        };
      }

      function publish() {
        listeners.forEach((listener) => {
          try {
            listener(createSnapshot());
          } catch (_error) {
            // One UI listener must not interrupt persistence or other listeners.
          }
        });
      }

      function transition(nextPhase, nextOperation, nextError = null) {
        phase = nextPhase;
        operation = nextOperation;
        error = nextError;
        publish();
      }

      function decorateProjectionView(
        candidateView,
        activeBiddingVariationNumber,
        currentVariationNumber,
        activeAuctionMapping,
      ) {
        return {
          ...candidateView,
          activeBiddingVariationNumber,
          activeAuctionMapping:
            activeAuctionMapping === null
              ? null
              : { ...activeAuctionMapping },
          currentVariationNumber,
          isReviewingHistory:
            candidateView.selectedVariationNumber !== currentVariationNumber,
          variations: candidateView.variations.map((variation) => ({
            ...variation,
            current:
              variation.variationNumber === currentVariationNumber,
          })),
        };
      }

      function getActiveAuctionMapping(
        canonicalStream,
        activeBiddingVariationNumber,
        pinnedInventory,
      ) {
        if (activeBiddingVariationNumber === null || !canonicalStream) {
          return null;
        }

        const activeAuction = canonicalStream.variations.find(
          (auction) =>
            auction.variationNumber === activeBiddingVariationNumber,
        );

        if (typeof activeAuction?.sku !== "string") {
          return null;
        }

        const inventoryEntry = pinnedInventory.find(
          (entry) => entry.sku === activeAuction.sku,
        );

        if (!inventoryEntry) {
          return null;
        }

        return {
          variationNumber: activeBiddingVariationNumber,
          sku: inventoryEntry.sku,
          unitCostCents: inventoryEntry.unitCostCents,
        };
      }

      function buildProjection(candidateState, preferredVariationNumber) {
        const canonicalState =
          reconciliation.hydrateReconciliationState(candidateState);
        const pinnedInventory = getPinnedDisplayInventory(
          canonicalState,
          streamId,
        );
        const canonicalStream = canonicalState.streams.find(
          (stream) => stream.streamId === streamId,
        );
        const recordedVariationNumbers =
          canonicalStream?.variations.map(
            (variation) => variation.variationNumber,
          ) ?? [];
        const activeBiddingVariationNumber =
          canonicalStream?.activeBiddingVariationNumber ?? null;
        const activeAuctionMapping = getActiveAuctionMapping(
          canonicalStream,
          activeBiddingVariationNumber,
          pinnedInventory,
        );
        const newestRecordedVariationNumber =
          recordedVariationNumbers.length === 0
            ? null
            : Math.max(...recordedVariationNumbers);
        const currentCanonicalVariationNumber =
          activeBiddingVariationNumber ??
          newestRecordedVariationNumber ??
          currentVariationNumber;
        const candidateSession = mappingWorkflow.createMappingSession({
          inventory: pinnedInventory,
          reconciliation,
          streamId,
          variationNumber: currentVariationNumber,
          variationNumbers,
          state: canonicalState,
        });
        let candidateView = candidateSession.getViewState();
        const preferredVariation = candidateView.variations.find(
          (variation) =>
            variation.variationNumber === preferredVariationNumber,
        );
        const firstRecordedVariation = candidateView.variations.find(
          (variation) => variation.recorded,
        );
        const selectionTarget = preferredVariation ?? firstRecordedVariation;

        if (
          selectionTarget &&
          selectionTarget.variationNumber !==
            candidateView.selectedVariationNumber
        ) {
          const selection = candidateSession.selectVariation(
            selectionTarget.variationNumber,
          );

          if (selection.ok) {
            candidateView = candidateSession.getViewState();
          }
        }

        candidateView = decorateProjectionView(
          candidateView,
          activeBiddingVariationNumber,
          currentCanonicalVariationNumber,
          activeAuctionMapping,
        );

        return {
          activeAuctionMapping,
          activeBiddingVariationNumber,
          currentCanonicalVariationNumber,
          session: candidateSession,
          selectedVariationNumber: candidateView.selectedVariationNumber,
          view: candidateView,
        };
      }

      function acceptCanonicalState(candidateState, options = {}) {
        const wasFollowingLatestVariation =
          selectedVariationNumber === latestVariationNumber;
        const projection = buildProjection(
          candidateState,
          selectedVariationNumber,
        );
        const activeBiddingVariationNumber =
          projection.activeBiddingVariationNumber;
        const currentCanonicalVariationNumber =
          projection.currentCanonicalVariationNumber;
        const canonicalVariationChanged =
          currentCanonicalVariationNumber !== latestVariationNumber;
        const shouldFollowVariation =
          options.resetFollowBaseline === true ||
          (
            options.followNewVariation === true &&
            canonicalVariationChanged &&
            wasFollowingLatestVariation
          );
        const variationToFollow = shouldFollowVariation
          ? currentCanonicalVariationNumber
          : null;

        if (
          variationToFollow !== null &&
          projection.selectedVariationNumber !== variationToFollow
        ) {
          const selection = projection.session.selectVariation(
            variationToFollow,
          );

          if (!selection.ok) {
            fail(
              "INVALID_CANONICAL_PROJECTION",
              "The newest saved variation could not be displayed.",
            );
          }

          projection.selectedVariationNumber =
            selection.view.selectedVariationNumber;
          projection.view = decorateProjectionView(
            selection.view,
            activeBiddingVariationNumber,
            currentCanonicalVariationNumber,
            projection.activeAuctionMapping,
          );
        }

        projectionSession = projection.session;
        selectedVariationNumber = projection.selectedVariationNumber;
        view = projection.view;

        if (
          options.resetFollowBaseline === true ||
          options.followNewVariation === true
        ) {
          latestVariationNumber = currentCanonicalVariationNumber;
        }
      }

      function failOperation(scope, failedOperation, failure, retry) {
        retryDescriptor = retry;
        transition(
          PHASES.ERROR,
          failedOperation,
          normalizeError(failure, scope),
        );
        return createSnapshot();
      }

      async function performLoad() {
        transition(PHASES.LOADING, OPERATIONS.LOAD);

        try {
          const response = requireClientResponse(
            await client.getState(),
            false,
          );

          selectedVariationNumber = currentVariationNumber;
          acceptCanonicalState(response.state, {
            resetFollowBaseline: true,
          });
          retryDescriptor = null;
          transition(PHASES.READY, OPERATIONS.LOAD);
          return createSnapshot();
        } catch (failure) {
          return failOperation(
            "load",
            operation ?? OPERATIONS.LOAD,
            failure,
            { scope: "load" },
          );
        }
      }

      async function performRefresh() {
        transition(PHASES.LOADING, OPERATIONS.REFRESH);

        try {
          const response = requireClientResponse(await client.getState(), false);

          acceptCanonicalState(response.state, {
            followNewVariation: true,
          });
          retryDescriptor = null;
          transition(PHASES.READY, OPERATIONS.REFRESH);
          return createSnapshot();
        } catch (failure) {
          return failOperation(
            "refresh",
            OPERATIONS.REFRESH,
            failure,
            { scope: "refresh" },
          );
        }
      }

      async function performMutation(descriptor) {
        transition(PHASES.SAVING, descriptor.operation);

        try {
          const response = requireClientResponse(
            await descriptor.execute(),
            false,
          );

          acceptCanonicalState(response.state, {
            followNewVariation: true,
          });
          retryDescriptor = null;
          transition(PHASES.READY, descriptor.operation);
          return createSnapshot();
        } catch (failure) {
          return failOperation(
            "save",
            descriptor.operation,
            failure,
            descriptor,
          );
        }
      }

      function createQueuedRefresh() {
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });

        return { promise, reject, resolve };
      }

      function drainQueuedRefresh() {
        if (!queuedRefresh) {
          return;
        }

        const queued = queuedRefresh;
        queuedRefresh = null;

        if (
          phase === PHASES.ERROR &&
          retryDescriptor?.scope !== "refresh"
        ) {
          queued.resolve(createSnapshot());
          return;
        }

        const refreshPromise = begin(performRefresh);

        refreshPromise.then(queued.resolve, queued.reject);
      }

      function begin(task) {
        if (activePromise) {
          return activePromise;
        }

        const running = Promise.resolve().then(task);
        const tracked = running.finally(() => {
          if (activePromise === tracked) {
            activePromise = null;
            drainQueuedRefresh();
          }
        });

        activePromise = tracked;
        return tracked;
      }

      function start() {
        if (started) {
          return activePromise ?? Promise.resolve(createSnapshot());
        }

        started = true;
        return begin(performLoad);
      }

      function refresh() {
        if (!started) {
          return start();
        }

        if (
          !activePromise &&
          phase === PHASES.ERROR &&
          retryDescriptor?.scope !== "refresh"
        ) {
          return Promise.resolve(createSnapshot());
        }

        if (!activePromise) {
          return begin(performRefresh);
        }

        if (!queuedRefresh) {
          queuedRefresh = createQueuedRefresh();
        }

        return queuedRefresh.promise;
      }

      function retry() {
        if (activePromise || !retryDescriptor) {
          return activePromise ?? Promise.resolve(createSnapshot());
        }

        if (retryDescriptor.scope === "load") {
          return begin(performLoad);
        }

        if (retryDescriptor.scope === "refresh") {
          return begin(performRefresh);
        }

        return begin(() => performMutation(retryDescriptor));
      }

      function selectVariation(value) {
        if (phase !== PHASES.READY || !projectionSession) {
          return createSnapshot();
        }

        const result = projectionSession.selectVariation(value);

        if (!result.ok) {
          return createSnapshot();
        }

        selectedVariationNumber = result.view.selectedVariationNumber;
        view = decorateProjectionView(
          result.view,
          view?.activeBiddingVariationNumber ?? null,
          latestVariationNumber,
          view?.activeAuctionMapping ?? null,
        );
        publish();
        return createSnapshot();
      }

      function requireReadyForMutation() {
        if (activePromise || phase !== PHASES.READY) {
          fail(
            "CONTROLLER_BUSY",
            "Wait for the current saved-session operation to finish.",
          );
        }
      }

      function mapSelectedSku(value) {
        requireReadyForMutation();

        const sku = requireNonEmptyString(value, "sku");
        const command = Object.freeze({
          streamId,
          variationNumber: selectedVariationNumber,
          sku,
        });
        const descriptor = {
          scope: "save",
          operation: OPERATIONS.MAP_VARIATION,
          execute: () => client.mapVariation({ ...command }),
        };

        return begin(() => performMutation(descriptor));
      }

      function unmapSelectedVariation() {
        requireReadyForMutation();

        const command = Object.freeze({
          streamId,
          variationNumber: selectedVariationNumber,
        });
        const descriptor = {
          scope: "save",
          operation: OPERATIONS.UNMAP_VARIATION,
          execute: () => client.unmapVariation({ ...command }),
        };

        return begin(() => performMutation(descriptor));
      }

      function subscribe(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("subscribe requires a listener function.");
        }

        listeners.add(listener);
        try {
          listener(createSnapshot());
        } catch (_error) {
          // Match later publications: a faulty observer cannot stop the app.
        }
        let subscribed = true;

        return function unsubscribe() {
          if (!subscribed) {
            return;
          }

          subscribed = false;
          listeners.delete(listener);
        };
      }

      return Object.freeze({
        getSnapshot: createSnapshot,
        mapSelectedSku,
        refresh,
        retry,
        selectVariation,
        start,
        subscribe,
        unmapSelectedVariation,
      });
    }

    return {
      MODE,
      OPERATIONS,
      PHASES,
      PersistentTaggerControllerError,
      createPersistentTaggerController,
      ensureInventoryInitialized,
    };
  },
);
