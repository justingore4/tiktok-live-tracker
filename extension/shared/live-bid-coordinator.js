(function initializeLiveBidCoordinator(root, factory) {
  const liveBidCoordinator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = liveBidCoordinator;
  }

  root.TikTokLiveTrackerLiveBidCoordinator = liveBidCoordinator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createLiveBidCoordinatorModule() {
    "use strict";

    class LiveBidCoordinatorError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "LiveBidCoordinatorError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new LiveBidCoordinatorError(code, message, { cause });
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function requirePositiveInteger(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 1) {
        fail("INVALID_LIVE_BID", `${fieldName} must be a positive safe integer.`);
      }

      return value;
    }

    function requireStreamId(value) {
      if (typeof value !== "string" || value.trim() === "") {
        fail("INVALID_LIVE_BID", "streamId must be a non-empty string.");
      }

      return value.trim();
    }

    function validateDependencies(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Live-bid coordinator options are required.");
      }

      const {
        activeStreamCoordinator,
        liveBidStore,
        reconciliation,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      } = options;

      if (
        !activeStreamCoordinator ||
        typeof activeStreamCoordinator.dispatch !== "function"
      ) {
        throw new TypeError("An active-stream coordinator is required.");
      }

      if (
        !liveBidStore ||
        typeof liveBidStore.loadLiveBid !== "function" ||
        typeof liveBidStore.saveLiveBid !== "function"
      ) {
        throw new TypeError("A live-bid store is required.");
      }

      if (
        !reconciliation ||
        typeof reconciliation.hydrateReconciliationState !== "function"
      ) {
        throw new TypeError("A valid reconciliation module is required.");
      }

      if (
        !reconciliationCoordinator?.COMMAND_TYPES ||
        reconciliationCoordinator.COMMAND_TYPES.GET_STATE !== "get_state"
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
        liveBidStore,
        reconciliation,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      };
    }

    function createLiveBidCoordinator(options) {
      const dependencies = validateDependencies(options);
      let activeVariationCache = null;
      let liveAuctionCache = null;
      let liveAuctionCacheLoaded = false;

      function readCanonicalProjection(candidateState, streamId) {
        if (candidateState === null) {
          return {
            activeVariationNumber: null,
            canonicalState: null,
            stream: null,
          };
        }

        let state;

        try {
          state = dependencies.reconciliation.hydrateReconciliationState(
            candidateState,
          );
        } catch (error) {
          fail(
            "LIVE_BID_RECONCILIATION_UNAVAILABLE",
            "The active auction could not be verified.",
            error,
          );
        }

        const stream = state.streams.find(
          (candidate) => candidate.streamId === streamId,
        );

        return {
          activeVariationNumber:
            stream?.activeBiddingVariationNumber ?? null,
          canonicalState: state,
          stream: stream ?? null,
        };
      }

      function getMappedUnitCost(projection, variationNumber) {
        if (
          projection.canonicalState === null ||
          projection.stream === null ||
          variationNumber === null
        ) {
          return null;
        }

        const auction = (projection.stream.variations ?? []).find(
          (candidate) => candidate.variationNumber === variationNumber,
        );

        if (typeof auction?.sku !== "string") {
          return null;
        }

        const baseline = (
          projection.canonicalState.inventoryBaselines ?? []
        ).find(
          (candidate) =>
            candidate.baselineId === projection.stream.inventoryBaselineId,
        );
        const inventoryEntry = baseline?.inventory?.find(
          (candidate) => candidate.sku === auction.sku,
        );

        return Number.isSafeInteger(inventoryEntry?.unitCostCents) &&
          inventoryEntry.unitCostCents >= 0
          ? inventoryEntry.unitCostCents
          : null;
      }

      async function loadLiveAuctionCache() {
        if (!liveAuctionCacheLoaded) {
          liveAuctionCache = await dependencies.liveBidStore.loadLiveBid();
          liveAuctionCacheLoaded = true;
        }

        return liveAuctionCache;
      }

      function liveAuctionsEqual(left, right) {
        return (
          left?.streamId === right.streamId &&
          left?.variationNumber === right.variationNumber &&
          left?.bidPriceCents === right.bidPriceCents &&
          left?.unitCostCents === right.unitCostCents
        );
      }

      async function saveLiveAuctionIfChanged(nextLiveAuction) {
        await loadLiveAuctionCache();

        if (liveAuctionsEqual(liveAuctionCache, nextLiveAuction)) {
          return { status: "unchanged" };
        }

        liveAuctionCache = await dependencies.liveBidStore.saveLiveBid(
          nextLiveAuction,
        );
        return { status: "accepted" };
      }

      async function synchronize(input) {
        if (
          !isPlainRecord(input) ||
          !Object.prototype.hasOwnProperty.call(input, "state") ||
          !Object.prototype.hasOwnProperty.call(input, "streamId") ||
          Object.keys(input).length !== 2
        ) {
          fail(
            "INVALID_LIVE_BID_SYNC",
            "Live-bid synchronization requires exactly streamId and state.",
          );
        }

        const streamId = requireStreamId(input.streamId);
        const projection = readCanonicalProjection(input.state, streamId);
        const activeVariationNumber = projection.activeVariationNumber;

        activeVariationCache = {
          streamId,
          variationNumber: activeVariationNumber,
          unitCostCents: getMappedUnitCost(
            projection,
            activeVariationNumber,
          ),
        };

        try {
          const stored = await loadLiveAuctionCache();
          const retainedVariationNumber =
            activeVariationNumber ??
            (stored?.streamId === streamId ? stored.variationNumber : null);

          if (retainedVariationNumber === null) {
            return { status: "unchanged" };
          }

          return await saveLiveAuctionIfChanged({
            streamId,
            variationNumber: retainedVariationNumber,
            bidPriceCents:
              stored?.streamId === streamId &&
              stored.variationNumber === retainedVariationNumber
                ? stored.bidPriceCents
                : null,
            unitCostCents: getMappedUnitCost(
              projection,
              retainedVariationNumber,
            ),
          });
        } catch (error) {
          // Force the next GET/price event to re-read canonical truth and retry
          // the transient projection. Durable reconciliation must not depend on
          // this best-effort session cache.
          activeVariationCache = null;
          throw error;
        }
      }

      async function getExpectedProjection(streamId) {
        if (activeVariationCache?.streamId === streamId) {
          return activeVariationCache;
        }

        const response = await dependencies.stateCoordinator.dispatch({
          type:
            dependencies.reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
        });

        await synchronize({ streamId, state: response?.state ?? null });
        return activeVariationCache;
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

      async function observe(input) {
        if (
          !isPlainRecord(input) ||
          !["bidPriceCents", "streamId", "variationNumber"].every((key) =>
            Object.prototype.hasOwnProperty.call(input, key),
          ) ||
          Object.keys(input).length !== 3
        ) {
          fail(
            "INVALID_LIVE_BID",
            "A live bid requires exactly streamId, variationNumber, and bidPriceCents.",
          );
        }

        const streamId = requireStreamId(input.streamId);
        const variationNumber = requirePositiveInteger(
          input.variationNumber,
          "variationNumber",
        );
        const bidPriceCents = requirePositiveInteger(
          input.bidPriceCents,
          "bidPriceCents",
        );
        const expectedProjection = await getExpectedProjection(streamId);

        if (expectedProjection.variationNumber !== variationNumber) {
          return { status: "ignored" };
        }

        return saveLiveAuctionIfChanged({
          streamId,
          variationNumber,
          bidPriceCents,
          unitCostCents: expectedProjection.unitCostCents,
        });
      }

      async function getLiveBid() {
        const streamId = await resolveActiveStreamId();

        if (streamId === null) {
          return { liveAuction: null };
        }

        const expectedProjection = await getExpectedProjection(streamId);
        const stored = await loadLiveAuctionCache();

        if (
          stored === null ||
          stored.streamId !== streamId ||
          (
            expectedProjection.variationNumber !== null &&
            stored.variationNumber !== expectedProjection.variationNumber
          )
        ) {
          return { liveAuction: null };
        }

        return {
          liveAuction: {
            variationNumber: stored.variationNumber,
            bidPriceCents: stored.bidPriceCents,
            unitCostCents: stored.unitCostCents,
          },
        };
      }

      async function dispatch(command) {
        if (
          !isPlainRecord(command) ||
          Object.keys(command).length !== 1 ||
          command.type !== "get_live_bid"
        ) {
          fail(
            "UNKNOWN_LIVE_BID_COMMAND",
            "The live-bid command is not supported.",
          );
        }

        return getLiveBid();
      }

      return Object.freeze({ dispatch, getLiveBid, observe, synchronize });
    }

    return Object.freeze({
      LiveBidCoordinatorError,
      createLiveBidCoordinator,
    });
  },
);
