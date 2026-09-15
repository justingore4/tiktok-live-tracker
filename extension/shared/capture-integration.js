(function initializeCaptureIntegration(root, factory) {
  const captureIntegration = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = captureIntegration;
  }

  root.TikTokLiveTrackerCaptureIntegration = captureIntegration;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createCaptureIntegrationModule() {
    "use strict";

    class CaptureIntegrationError extends Error {
      constructor(code, message, options = {}) {
        super(message, options);
        this.name = "CaptureIntegrationError";
        this.code = code;

        if (options.cause !== undefined && this.cause === undefined) {
          this.cause = options.cause;
        }
      }
    }

    function fail(code, message, cause) {
      throw new CaptureIntegrationError(code, message, { cause });
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
        throw new TypeError("Capture-integration options are required.");
      }

      const {
        activeStreamCoordinator,
        captureProtocol,
        liveBidCoordinator,
        nextItemQueueCoordinator,
        variationPresetsCoordinator,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      } = options;

      if (
        !captureProtocol ||
        !captureProtocol.EVENT_TYPES ||
        typeof captureProtocol.createCaptureMessage !== "function" ||
        typeof captureProtocol.validateCaptureMessage !== "function"
      ) {
        throw new TypeError("A valid capture protocol is required.");
      }

      if (
        liveBidCoordinator !== undefined &&
        (
          !liveBidCoordinator ||
          typeof liveBidCoordinator.observe !== "function" ||
          typeof liveBidCoordinator.synchronize !== "function"
        )
      ) {
        throw new TypeError("A valid live-bid coordinator is required.");
      }

      if (
        nextItemQueueCoordinator !== undefined &&
        (
          !nextItemQueueCoordinator ||
          typeof nextItemQueueCoordinator.applyToObservedBiddingVariation !==
            "function"
        )
      ) {
        throw new TypeError("A valid next-item queue coordinator is required.");
      }

      if (
        variationPresetsCoordinator !== undefined &&
        (!variationPresetsCoordinator || typeof variationPresetsCoordinator.synchronize !== "function")
      ) {
        throw new TypeError("A valid variation-presets coordinator is required.");
      }

      if (
        !reconciliationCoordinator ||
        !reconciliationCoordinator.COMMAND_TYPES ||
        reconciliationCoordinator.COMMAND_TYPES.OBSERVE_VARIATIONS !==
          "observe_variations" ||
        reconciliationCoordinator.COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES !==
          "observe_payment_statuses" ||
        reconciliationCoordinator.COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV !==
          "observe_attributed_gmv" ||
        reconciliationCoordinator.COMMAND_TYPES.OBSERVE_BIDDING_VARIATION !==
          "observe_bidding_variation" ||
        reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE !==
          "record_payment_complete" ||
        reconciliationCoordinator.COMMAND_TYPES
          .PIN_STREAM_TO_INVENTORY_BASELINE !==
          "pin_stream_to_inventory_baseline"
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
        !streamSessionCoordinator ||
        !streamSessionCoordinator.COMMAND_TYPES ||
        streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION !==
          "get_stream_session"
      ) {
        throw new TypeError("A valid stream-session coordinator module is required.");
      }

      if (
        !activeStreamCoordinator ||
        typeof activeStreamCoordinator.dispatch !== "function"
      ) {
        throw new TypeError("An active-stream coordinator is required.");
      }

      return {
        activeStreamCoordinator,
        captureProtocol,
        liveBidCoordinator: liveBidCoordinator ?? null,
        nextItemQueueCoordinator: nextItemQueueCoordinator ?? null,
        variationPresetsCoordinator: variationPresetsCoordinator ?? null,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      };
    }

    function createCaptureIntegration(options) {
      const {
        activeStreamCoordinator,
        captureProtocol,
        liveBidCoordinator,
        nextItemQueueCoordinator,
        variationPresetsCoordinator,
        reconciliationCoordinator,
        stateCoordinator,
        streamSession,
        streamSessionCoordinator,
      } = validateDependencies(options);
      let eventTail = Promise.resolve();
      let liveBidChanged = false;
      let nextItemQueueChanged = false;

      async function synchronizeLiveAuction(streamId, state) {
        if (liveBidCoordinator === null) {
          return { status: "unchanged" };
        }

        try {
          return await liveBidCoordinator.synchronize({ streamId, state });
        } catch (_error) {
          // Canonical capture persistence is authoritative. A best-effort
          // session projection must never make the durable capture retry.
          return { status: "unchanged" };
        }
      }

      function snapshotEvent(event) {
        return captureProtocol.validateCaptureMessage(
          captureProtocol.createCaptureMessage(event),
        );
      }

      async function resolveActiveStreamId() {
        const response = await activeStreamCoordinator.dispatch({
          type:
            streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION,
        });
        let state;

        try {
          state = streamSession.hydrateStreamSessionState(response?.state);
        } catch (error) {
          fail(
            "ACTIVE_STREAM_STATE_UNAVAILABLE",
            "The active tracker stream could not be verified.",
            error,
          );
        }

        if (state.activeSession === null) {
          fail(
            "NO_ACTIVE_STREAM",
            "Start or resume a tracker stream before capturing Sold Items.",
          );
        }

        return state.activeSession.streamId;
      }

      async function executeEvent(event) {
        const streamId = await resolveActiveStreamId();
        let command;

        liveBidChanged = false;
        nextItemQueueChanged = false;

        if (
          event.type === captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_PRICE
        ) {
          if (liveBidCoordinator === null) {
            fail(
              "LIVE_BID_COORDINATOR_UNAVAILABLE",
              "The transient live-bid service is unavailable.",
            );
          }

          const outcome = await liveBidCoordinator.observe({
            streamId,
            variationNumber: event.variationNumber,
            bidPriceCents: event.bidPriceCents,
          });

          liveBidChanged = outcome?.status === "accepted";
          return { status: "accepted" };
        }

        await stateCoordinator.dispatch({
          type:
            reconciliationCoordinator.COMMAND_TYPES
              .PIN_STREAM_TO_INVENTORY_BASELINE,
          streamId,
        });

        switch (event.type) {
          case captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES
                  .OBSERVE_ATTRIBUTED_GMV,
              streamId,
              attributedGmvDisplay: event.attributedGmvDisplay,
            };
            break;
          case captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES
                  .OBSERVE_BIDDING_VARIATION,
              streamId,
              variationNumber: event.variationNumber,
            };
            break;
          case captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES.OBSERVE_VARIATIONS,
              streamId,
              variationNumbers: event.variationNumbers,
            };
            break;
          case captureProtocol.EVENT_TYPES.OBSERVE_PAYMENT_STATUSES:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES
                  .OBSERVE_PAYMENT_STATUSES,
              streamId,
              statuses: event.statuses.map((status) => ({ ...status })),
            };
            break;
          case captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE:
            command = {
              type:
                reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
              streamId,
              variationNumber: event.variationNumber,
              soldPriceCents: event.soldPriceCents,
            };
            break;
          default:
            fail(
              "UNKNOWN_CAPTURE_EVENT",
              `Capture event ${event.type} is not supported.`,
            );
        }

        // Payment can clear the active bidding marker. If persisting preset
        // extension readiness failed on the preceding live capture, retain that
        // proof before another canonical update can remove it. This is only a
        // readiness barrier, not preset promotion or next-item queue consumption.
        if (typeof variationPresetsCoordinator?.preserveExtensionAvailability === "function") {
          await variationPresetsCoordinator.preserveExtensionAvailability(streamId);
        }

        const response = await stateCoordinator.dispatch(command);
        let canonicalState = response?.state ?? null;

        // A preset is planning data until real capture has durably created the
        // variation. Promote through ordinary mapping before the generic queue
        // can consume this same target. A failure remains retryable, including
        // when the capture write succeeded but preset promotion/cleanup did not.
        if (variationPresetsCoordinator !== null) {
          const presetOutcome = await variationPresetsCoordinator.synchronize({
            streamId,
            state: canonicalState,
            deferNextQueueClear: event.type === captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION,
          });
          canonicalState = presetOutcome.state;
        }

        if (
          event.type ===
            captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION &&
          nextItemQueueCoordinator !== null
        ) {
          const queueOutcome =
            await nextItemQueueCoordinator.applyToObservedBiddingVariation({
              streamId,
              variationNumber: event.variationNumber,
              state: canonicalState,
            });

          canonicalState = queueOutcome?.state ?? canonicalState;
          nextItemQueueChanged = [
            "stale_queue_cleared",
            "invalid_sku_cleared",
            "mapped",
            "already_mapped",
            "skipped_existing_mapping",
          ].includes(queueOutcome?.status);
        }

        if (variationPresetsCoordinator !== null &&
            event.type === captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION) {
          // A queue due for this live variation must be applied before a preset
          // on the following variation disables/clears future queuing.
          const presetOutcome = await variationPresetsCoordinator.synchronize({ streamId, state: canonicalState });
          canonicalState = presetOutcome.state;
        }

        const liveAuctionOutcome = await synchronizeLiveAuction(
          streamId,
          canonicalState,
        );
        liveBidChanged = liveAuctionOutcome?.status === "accepted";

        return { status: "accepted" };
      }

      function dispatch(event) {
        let eventSnapshot;

        try {
          eventSnapshot = snapshotEvent(event);
        } catch (error) {
          return Promise.reject(error);
        }

        const execution = eventTail.then(() => executeEvent(eventSnapshot));

        eventTail = execution.catch(() => undefined);
        return execution;
      }

      function consumeLiveBidChanged() {
        const changed = liveBidChanged;

        liveBidChanged = false;
        return changed;
      }

      function consumeNextItemQueueChanged() {
        const changed = nextItemQueueChanged;

        nextItemQueueChanged = false;
        return changed;
      }

      return Object.freeze({
        consumeLiveBidChanged,
        consumeNextItemQueueChanged,
        dispatch,
      });
    }

    return Object.freeze({
      CaptureIntegrationError,
      createCaptureIntegration,
    });
  },
);
