(function initializeVariationPresetsCoordinator(root, factory) {
  const moduleValue = factory();
  if (typeof module === "object" && module.exports) module.exports = moduleValue;
  root.TikTokLiveTrackerVariationPresetsCoordinator = moduleValue;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";
  class VariationPresetsCoordinatorError extends Error {
    constructor(code, message, cause) {
      super(message, { cause });
      this.name = "VariationPresetsCoordinatorError";
      this.code = code;
    }
  }
  function fail(code, message, cause) { throw new VariationPresetsCoordinatorError(code, message, cause); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function createVariationPresetsCoordinator(options = {}) {
    const {
      activeStreamCoordinator, streamSession, streamSessionCoordinator,
      stateCoordinator, reconciliation, reconciliationCoordinator,
      protocol, presetStore,
      createRevision = () => globalThis.crypto.randomUUID(),
      clearConflictingQueue = async () => undefined,
      onChange = () => undefined,
    } = options;
    if (typeof activeStreamCoordinator?.dispatch !== "function" ||
        typeof streamSession?.hydrateStreamSessionState !== "function" ||
        !streamSessionCoordinator?.COMMAND_TYPES?.GET_STREAM_SESSION ||
        typeof stateCoordinator?.dispatch !== "function" ||
        typeof reconciliation?.hydrateReconciliationState !== "function" ||
        !reconciliationCoordinator?.COMMAND_TYPES?.GET_STATE ||
        !reconciliationCoordinator?.COMMAND_TYPES?.MAP_VARIATION ||
        typeof protocol?.validateCommand !== "function" || typeof protocol?.validateSnapshot !== "function" ||
        ["loadPresets", "savePresets", "clearPresets"].some((name) => typeof presetStore?.[name] !== "function") ||
        typeof createRevision !== "function" || typeof clearConflictingQueue !== "function" || typeof onChange !== "function") {
      throw new TypeError("Preset coordination requires stream, canonical state, storage, and protocol dependencies.");
    }
    let tail = Promise.resolve();
    function enqueue(operation) {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    }
    function notify(canonicalChanged = false) {
      try { Promise.resolve(onChange({ canonicalChanged })).catch(() => undefined); }
      catch (_error) { /* A notification cannot undo durable state. */ }
    }
    function revision() {
      let value;
      try { value = createRevision(); }
      catch (error) { fail("PRESET_REVISION_UNAVAILABLE", "Could not identify this preset update.", error); }
      if (typeof value !== "string" || !protocol.REVISION_PATTERN.test(value)) {
        fail("PRESET_REVISION_UNAVAILABLE", "Could not identify this preset update.");
      }
      return value;
    }
    function hydrate(value) {
      try { return reconciliation.hydrateReconciliationState(value); }
      catch (error) { fail("RECONCILIATION_STATE_UNAVAILABLE", "The tracker inventory state could not be verified.", error); }
    }
    async function readActiveStreamId() {
      const response = await activeStreamCoordinator.dispatch({ type: streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION });
      try { return streamSession.hydrateStreamSessionState(response?.state).activeSession?.streamId ?? null; }
      catch (error) { fail("ACTIVE_STREAM_STATE_UNAVAILABLE", "The active tracker stream could not be verified.", error); }
    }
    async function readState() {
      const value = (await stateCoordinator.dispatch({ type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE }))?.state;
      return value === null ? null : hydrate(value);
    }
    function findStream(state, streamId) { return state.streams.find((stream) => stream.streamId === streamId) ?? null; }
    function currentNumber(stream) {
      if (Number.isSafeInteger(stream.activeBiddingVariationNumber)) return stream.activeBiddingVariationNumber;
      return stream.variations.reduce((highest, variation) => Math.max(highest, variation.variationNumber), 0);
    }
    function emptySnapshot(streamId = null, baselineId = null) {
      return { streamId, baselineId, revision: null, total: null, assignments: [] };
    }
    async function readContext() {
      const streamId = await readActiveStreamId();
      const state = await readState();
      if (streamId === null || state === null) return { state, stream: null, baseline: null, snapshot: emptySnapshot() };
      const stream = findStream(state, streamId);
      const baseline = stream === null ? null : state.inventoryBaselines.find((entry) => entry.baselineId === stream.inventoryBaselineId);
      // Legacy/initial setup may have a session before its canonical baseline is
      // pinned. Reads must not break initialization; mutations stay unavailable.
      if (!stream || !baseline) return { state, stream: null, baseline: null, snapshot: emptySnapshot() };
      const saved = await presetStore.loadPresets();
      const snapshot = saved?.streamId === streamId && saved.baselineId === baseline.baselineId
        ? saved : emptySnapshot(streamId, baseline.baselineId);
      protocol.validateSnapshot(snapshot);
      return { state, stream, baseline, snapshot };
    }
    async function save(snapshot) {
      protocol.validateSnapshot(snapshot);
      const saved = await presetStore.savePresets(snapshot);
      notify();
      return saved;
    }
    async function preserveReadiness(context) {
      const { stream, snapshot } = context;
      if (!stream || snapshot.total === null) return { ...context, changed: false };
      // Only a real live-auction observation proves this range was exceeded.
      // The highest captured number may instead be a Sold Items backfill. Keep
      // the proof after bidding ends (when the canonical active number clears),
      // across panel/worker restarts, without changing this range's revision.
      if (snapshot.extensionAvailable !== true &&
          Number.isSafeInteger(stream.activeBiddingVariationNumber) &&
          stream.activeBiddingVariationNumber > snapshot.total) {
        return { ...context, snapshot: await save({ ...snapshot, extensionAvailable: true }), changed: true };
      }
      return { ...context, changed: false };
    }
    async function repair(context, { deferNextQueueClear = false } = {}) {
      context = await preserveReadiness(context);
      let { state, stream, snapshot, changed } = context;
      if (!stream || snapshot.total === null) return context;
      if (snapshot.assignments.length === 0) return { ...context, snapshot, changed };

      // Work from saved capture state, never selection, number ranges, or timers.
      const captured = new Set(stream.variations.map((entry) => entry.variationNumber));
      const plannedCaptured = snapshot.assignments.filter((entry) => captured.has(entry.variationNumber));
      const blockNext = !deferNextQueueClear && snapshot.assignments.some((entry) => entry.variationNumber === currentNumber(stream) + 1);
      if (plannedCaptured.length || blockNext) {
        await clearConflictingQueue(stream.streamId, {
          capturedVariationNumbers: plannedCaptured.map((entry) => entry.variationNumber),
          blockNext,
          currentVariationNumber: currentNumber(stream),
        });
      }
      for (const assignment of plannedCaptured) {
        const actual = stream.variations.find((entry) => entry.variationNumber === assignment.variationNumber);
        if (actual.sku === null || actual.sku === undefined) {
          const result = await stateCoordinator.dispatch({
            type: reconciliationCoordinator.COMMAND_TYPES.MAP_VARIATION,
            streamId: stream.streamId,
            variationNumber: assignment.variationNumber,
            sku: assignment.sku,
          });
          state = hydrate(result?.state);
          stream = findStream(state, snapshot.streamId);
          const mapped = stream?.variations.find((entry) => entry.variationNumber === assignment.variationNumber);
          if (mapped?.sku !== assignment.sku) {
            fail("PRESET_MAPPING_NOT_CONFIRMED", "The captured preset item could not be confirmed. Its plan has been kept for retry.");
          }
          changed = true;
          // Mapping has persisted even if the independent plan cleanup fails.
          notify(true);
        }
        snapshot = await save({
          ...snapshot,
          revision: revision(),
          assignments: snapshot.assignments.filter((entry) => entry.variationNumber !== assignment.variationNumber),
        });
        changed = true;
      }
      return { ...context, state, stream, snapshot, changed };
    }
    function checkExpected(command, context) {
      if (!context.stream) fail("NO_ACTIVE_STREAM", "Start or resume tracking before using variation presets.");
      if (command.expectedStreamId !== context.snapshot.streamId || command.expectedBaselineId !== context.snapshot.baselineId) {
        fail("PRESET_CONTEXT_CHANGED", "The displayed stream or inventory baseline changed. Review the tracker and try again.");
      }
      if (command.expectedRevision !== context.snapshot.revision) {
        fail("PRESETS_CHANGED", "The presets changed before this request completed. Review the current presets and try again.");
      }
      if (Object.prototype.hasOwnProperty.call(command, "expectedActiveBiddingVariationNumber") &&
          command.expectedActiveBiddingVariationNumber !== context.stream.activeBiddingVariationNumber) {
        // A queued-preset clear belongs to the exact live auction that exposed
        // it. Skipping ahead or finishing bidding may leave the plan/revision
        // unchanged, so the ordinary configuration guard alone is insufficient.
        fail("PRESET_LIVE_VARIATION_CHANGED", "The live variation changed. Review the upcoming item and try again.");
      }
      if (Object.prototype.hasOwnProperty.call(command, "expectedPrestreamVariationNumber") &&
          (context.stream.variations.length !== 0 || context.stream.activeBiddingVariationNumber !== null ||
            context.snapshot.total === null || command.expectedPrestreamVariationNumber > context.snapshot.total ||
            command.variationNumber > context.snapshot.total)) {
        // Pre-stream presentation is valid only before the first real capture,
        // even if bidding has already ended or capture arrived elsewhere.
        fail("PRESET_PRESTREAM_CONTEXT_CHANGED", "Pre-stream planning changed or capture began. Review the upcoming item and try again.");
      }
    }
    async function execute(command) {
      let context = await readContext();
      if (command.type !== protocol.COMMAND_TYPES.GET_PRESETS) checkExpected(command, context);
      context = await repair(context);
      if (command.type === protocol.COMMAND_TYPES.GET_PRESETS) return clone(context.snapshot);
      checkExpected(command, context);
      const { snapshot, stream, baseline } = context;
      if (command.type === protocol.COMMAND_TYPES.CREATE_PRESETS) {
        if (snapshot.total !== null && snapshot.extensionAvailable !== true) {
          fail("PRESETS_ALREADY_ENABLED", "Reset presets before choosing another total.");
        }
        if (snapshot.total !== null && command.total <= snapshot.total) {
          fail("PRESET_TOTAL_NOT_INCREASED", "Enter a larger preset total to extend this range.");
        }
        const highest = stream.variations.reduce((value, entry) => Math.max(value, entry.variationNumber), 0);
        if (command.total < highest) fail("PRESET_TOTAL_BELOW_CAPTURED", `The total cannot be lower than captured variation #${highest}.`);
        const { extensionAvailable: _extensionAvailable, ...configuration } = snapshot;
        return save({ ...configuration, revision: revision(), total: command.total, assignments: snapshot.assignments });
      }
      if (snapshot.total === null) fail("NO_PRESETS", "There is no active preset configuration to change.");
      if (command.type === protocol.COMMAND_TYPES.RESET_PRESETS) {
        // Keep a revision tombstone to reject delayed requests from before reset.
        const { extensionAvailable: _extensionAvailable, ...configuration } = snapshot;
        return save({ ...configuration, revision: revision(), total: null, assignments: [] });
      }
      if (command.variationNumber > snapshot.total) fail("OUTSIDE_PRESET_RANGE", "This variation is outside the preset range.");
      if (stream.variations.some((entry) => entry.variationNumber === command.variationNumber)) {
        fail("VARIATION_ALREADY_CAPTURED", "This variation was captured. Select it again to change its actual mapping.");
      }
      if (command.sku !== null && !baseline.inventory.some((entry) => entry.sku === command.sku)) {
        fail("UNKNOWN_SKU", "The selected item is not in this stream's inventory baseline.");
      }
      const sequential = command.type === protocol.COMMAND_TYPES.ASSIGN_NEXT_PRESET_ITEM;
      let targetVariationNumber = command.variationNumber;
      if (sequential) {
        const captured = new Set(stream.variations.map((entry) => entry.variationNumber));
        const assigned = new Set(snapshot.assignments.map((entry) => entry.variationNumber));
        while (targetVariationNumber <= snapshot.total &&
               (captured.has(targetVariationNumber) || assigned.has(targetVariationNumber))) {
          targetVariationNumber += 1;
        }
        if (targetVariationNumber > snapshot.total) {
          fail("NO_MORE_FUTURE_VARIATIONS", "No more future variations.");
        }
      }
      const previous = snapshot.assignments.find((entry) => entry.variationNumber === targetVariationNumber)?.sku ?? null;
      if (previous === command.sku) return clone(snapshot);
      const assignments = snapshot.assignments.filter((entry) => entry.variationNumber !== targetVariationNumber);
      if (command.sku !== null) assignments.push({ variationNumber: targetVariationNumber, sku: command.sku });
      assignments.sort((a, b) => a.variationNumber - b.variationNumber);
      const saved = await save({ ...snapshot, revision: revision(), assignments });
      // The saved plan wins. If clearing fails, a later read/capture repairs it.
      if (command.sku !== null && targetVariationNumber === currentNumber(stream) + 1) {
        await clearConflictingQueue(stream.streamId, {
          capturedVariationNumbers: [], blockNext: true,
          currentVariationNumber: currentNumber(stream),
        });
      }
      return sequential ? { presets: saved, assignedVariationNumber: targetVariationNumber } : saved;
    }
    function dispatch(command) {
      let snapshot;
      try {
        protocol.validateCommand(command);
        snapshot = clone(command);
        protocol.validateCommand(snapshot);
      } catch (error) { return Promise.reject(error); }
      return enqueue(() => execute(snapshot));
    }
    function synchronize(input) {
      let streamId;
      let deferNextQueueClear;
      try {
        const keys = input && Object.keys(input).sort().join(",");
        if (!input || !["state,streamId", "deferNextQueueClear,state,streamId"].includes(keys) ||
            (Object.prototype.hasOwnProperty.call(input, "deferNextQueueClear") && typeof input.deferNextQueueClear !== "boolean") ||
            typeof input.streamId !== "string" || !input.streamId || input.streamId !== input.streamId.trim()) {
          fail("INVALID_ARGUMENT", "Preset synchronization requires a stream identity and canonical state.");
        }
        hydrate(input.state);
        streamId = input.streamId;
        deferNextQueueClear = input.deferNextQueueClear === true;
      } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        // Re-read durable state after joining the FIFO; callers may hold an older snapshot.
        const context = await readContext();
        if (context.stream?.streamId !== streamId) return { state: context.state, changed: false };
        const repaired = await repair(context, { deferNextQueueClear });
        return { state: repaired.state, changed: repaired.changed };
      });
    }
    function clearForStream(streamId) {
      if (typeof streamId !== "string" || !streamId || streamId !== streamId.trim()) {
        return Promise.reject(new VariationPresetsCoordinatorError("INVALID_ARGUMENT", "A stream identity is required."));
      }
      return enqueue(async () => {
        try {
          const saved = await presetStore.loadPresets();
          if (saved?.streamId !== streamId) return { status: "unchanged" };
          await presetStore.clearPresets();
          notify();
          return { status: "cleared" };
        } catch (_error) { return { status: "unavailable" }; }
      });
    }
    function preserveExtensionAvailability(streamId) {
      if (typeof streamId !== "string" || !streamId || streamId !== streamId.trim()) {
        return Promise.reject(new VariationPresetsCoordinatorError("INVALID_ARGUMENT", "A stream identity is required."));
      }
      return enqueue(async () => {
        // Capture calls this before an observation can clear the current live
        // marker. A prior failed latch write remains retryable without ever
        // using historical maxima as proof or invoking queue/map repair here.
        const context = await readContext();
        if (context.stream?.streamId !== streamId) return { changed: false };
        const preserved = await preserveReadiness(context);
        return { changed: preserved.changed };
      });
    }
    return Object.freeze({ dispatch, synchronize, clearForStream, preserveExtensionAvailability });
  }
  return Object.freeze({ VariationPresetsCoordinatorError, createVariationPresetsCoordinator });
});
