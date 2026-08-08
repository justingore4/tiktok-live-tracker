const assert = require("node:assert/strict");
const test = require("node:test");

const captureProtocol = require("../extension/shared/capture-protocol.js");
const {
  CaptureIntegrationError,
  createCaptureIntegration,
} = require("../extension/shared/capture-integration.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationCoordinator = require(
  "../extension/shared/reconciliation-coordinator.js",
);
const streamSession = require("../extension/shared/stream-session.js");
const streamSessionCoordinator = require(
  "../extension/shared/stream-session-coordinator.js",
);

const STREAM_ONE = "local-stream:11111111-1111-4111-8111-111111111111";
const STREAM_TWO = "local-stream:22222222-2222-4222-8222-222222222222";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createActiveState(streamId = STREAM_ONE) {
  const state = streamSession.createStreamSessionState();

  streamSession.startStream(state, {
    streamId,
    startedAt: "2026-08-08T20:00:00.000Z",
    identitySource: streamSession.IDENTITY_SOURCES.LOCAL_SESSION,
  });
  return state;
}

function createMemoryStateStore(initialState) {
  let persistedState = initialState === null ? null : clone(initialState);
  let failNextSaveWith = null;
  const calls = { load: 0, save: [] };

  return {
    calls,
    failNextSave(error) {
      failNextSaveWith = error;
    },
    getPersistedState() {
      return persistedState === null ? null : clone(persistedState);
    },
    stateStore: {
      async loadState() {
        calls.load += 1;
        return persistedState === null ? null : clone(persistedState);
      },
      async saveState(state) {
        const snapshot = clone(state);
        calls.save.push(snapshot);

        if (failNextSaveWith) {
          const error = failNextSaveWith;
          failNextSaveWith = null;
          throw error;
        }

        persistedState = snapshot;
      },
    },
  };
}

function createPersistentIntegration(memoryStore, getActiveState) {
  const stateCoordinator =
    reconciliationCoordinator.createReconciliationCoordinator({
      reconciliation,
      stateStore: memoryStore.stateStore,
    });
  const activeStreamCoordinator = {
    async dispatch() {
      return { state: clone(getActiveState()), result: null };
    },
  };

  return createCaptureIntegration({
    activeStreamCoordinator,
    captureProtocol,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
}

function createHarness(options = {}) {
  const activeCalls = [];
  const stateCalls = [];
  let activeState = options.activeState ?? createActiveState();
  const activeStreamCoordinator = {
    async dispatch(command) {
      activeCalls.push(clone(command));

      if (options.activeError) {
        throw options.activeError;
      }

      return { state: clone(activeState), result: null };
    },
  };
  const stateCoordinator = {
    async dispatch(command) {
      stateCalls.push(clone(command));

      if (options.beforeStateDispatch) {
        await options.beforeStateDispatch(command, stateCalls.length - 1);
      }

      if (options.stateError) {
        throw options.stateError;
      }

      return options.stateResponse ?? {
        state: { sensitive: "must not escape" },
        result: { sensitive: "must not escape" },
      };
    },
  };
  const integration = createCaptureIntegration({
    activeStreamCoordinator,
    captureProtocol,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });

  return {
    activeCalls,
    integration,
    setActiveState(state) {
      activeState = state;
    },
    stateCalls,
  };
}

test("binds batch observations to the worker-owned active stream", async () => {
  const harness = createHarness();
  const result = await harness.integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44, 43, 42],
  });

  assert.deepEqual(result, { status: "accepted" });
  assert.deepEqual(harness.activeCalls, [
    { type: streamSessionCoordinator.COMMAND_TYPES.GET_STREAM_SESSION },
  ]);
  assert.deepEqual(harness.stateCalls, [
    {
      type: reconciliationCoordinator.COMMAND_TYPES.OBSERVE_VARIATIONS,
      streamId: STREAM_ONE,
      variationNumbers: [44, 43, 42],
    },
  ]);
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal("streamId" in result, false);
});

test("binds completed payments to the worker-owned active stream", async () => {
  const harness = createHarness();

  assert.deepEqual(
    await harness.integration.dispatch({
      type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
      variationNumber: 44,
      soldPriceCents: 700,
    }),
    { status: "accepted" },
  );
  assert.deepEqual(harness.stateCalls, [
    {
      type:
        reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
      streamId: STREAM_ONE,
      variationNumber: 44,
      soldPriceCents: 700,
    },
  ]);
});

test("fails closed without an active stream", async () => {
  const harness = createHarness({
    activeState: streamSession.createStreamSessionState(),
  });

  await assert.rejects(
    () =>
      harness.integration.dispatch({
        type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
        variationNumbers: [44],
      }),
    (error) =>
      error instanceof CaptureIntegrationError &&
      error.code === "NO_ACTIVE_STREAM",
  );
  assert.equal(harness.stateCalls.length, 0);
});

test("fails closed when active-stream state cannot be verified", async () => {
  const harness = createHarness({ activeState: { version: 1 } });

  await assert.rejects(
    () =>
      harness.integration.dispatch({
        type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
        variationNumber: 44,
        soldPriceCents: 700,
      }),
    (error) =>
      error instanceof CaptureIntegrationError &&
      error.code === "ACTIVE_STREAM_STATE_UNAVAILABLE",
  );
  assert.equal(harness.stateCalls.length, 0);
});

test("serializes session resolution and persistence in one FIFO", async () => {
  const firstWriteStarted = createDeferred();
  const releaseFirstWrite = createDeferred();
  const harness = createHarness({
    async beforeStateDispatch(_command, index) {
      if (index === 0) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
    },
  });
  const first = harness.integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44],
  });
  const secondEvent = {
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 700,
  };
  const second = harness.integration.dispatch(secondEvent);

  secondEvent.variationNumber = 999;
  secondEvent.soldPriceCents = 99999;
  await firstWriteStarted.promise;
  assert.equal(harness.activeCalls.length, 1);
  assert.equal(harness.stateCalls.length, 1);

  releaseFirstWrite.resolve();
  await Promise.all([first, second]);

  assert.equal(harness.activeCalls.length, 2);
  assert.deepEqual(harness.stateCalls[1], {
    type: reconciliationCoordinator.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
    streamId: STREAM_ONE,
    variationNumber: 44,
    soldPriceCents: 700,
  });
});

test("a failed write does not poison the following capture event", async () => {
  const writeError = new Error("write failed");
  let callCount = 0;
  const harness = createHarness({
    async beforeStateDispatch() {
      callCount += 1;

      if (callCount === 1) {
        throw writeError;
      }
    },
  });

  await assert.rejects(
    () =>
      harness.integration.dispatch({
        type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
        variationNumbers: [44],
      }),
    writeError,
  );
  assert.deepEqual(
    await harness.integration.dispatch({
      type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [45],
    }),
    { status: "accepted" },
  );
  assert.equal(harness.stateCalls.length, 2);
});

test("rejects invalid events before resolving active state", async () => {
  const harness = createHarness();

  await assert.rejects(
    () =>
      harness.integration.dispatch({
        type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
        streamId: STREAM_ONE,
        variationNumber: 44,
        soldPriceCents: 700,
      }),
    (error) =>
      error instanceof captureProtocol.CaptureProtocolError &&
      error.code === "INVALID_CAPTURE_MESSAGE",
  );
  assert.equal(harness.activeCalls.length, 0);
  assert.equal(harness.stateCalls.length, 0);
});

test("persists canonical capture truth idempotently across worker restarts", async () => {
  const initialState = reconciliation.createReconciliationState([
    {
      sku: "SHIRT-M",
      name: "Shirt",
      size: "M",
      quantityReceived: 2,
      unitCostCents: 300,
    },
  ]);
  const memoryStore = createMemoryStateStore(initialState);
  let activeState = createActiveState(STREAM_ONE);
  let integration = createPersistentIntegration(
    memoryStore,
    () => activeState,
  );

  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44, 43],
  });
  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44, 43],
  });
  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 700,
  });
  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 700,
  });

  assert.equal(memoryStore.calls.save.length, 2);

  integration = createPersistentIntegration(memoryStore, () => activeState);
  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44, 43],
  });
  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 800,
  });

  const afterRestart = memoryStore.getPersistedState();
  const firstStreamAuction = afterRestart.streams[0].variations.find(
    (auction) => auction.variationNumber === 44,
  );

  assert.equal(memoryStore.calls.load, 2);
  assert.equal(memoryStore.calls.save.length, 3);
  assert.equal(firstStreamAuction.soldPriceCents, 700);
  assert.deepEqual(firstStreamAuction.conflicts, [
    {
      code: "conflicting_sold_price",
      retainedSoldPriceCents: 700,
      observedSoldPriceCents: 800,
    },
  ]);

  activeState = createActiveState(STREAM_TWO);
  await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44],
  });
  const finalState = memoryStore.getPersistedState();

  assert.deepEqual(
    finalState.streams.map((stream) => ({
      streamId: stream.streamId,
      variations: stream.variations.map((auction) => auction.variationNumber),
    })),
    [
      { streamId: STREAM_ONE, variations: [44, 43] },
      { streamId: STREAM_TWO, variations: [44] },
    ],
  );
});

test("uninitialized and failed storage leave capture state untouched", async () => {
  const uninitializedStore = createMemoryStateStore(null);
  const uninitializedIntegration = createPersistentIntegration(
    uninitializedStore,
    () => createActiveState(),
  );

  await assert.rejects(
    () =>
      uninitializedIntegration.dispatch({
        type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
        variationNumbers: [44],
      }),
    (error) =>
      error instanceof
        reconciliationCoordinator.ReconciliationCoordinatorError &&
      error.code === "STATE_NOT_INITIALIZED",
  );
  assert.equal(uninitializedStore.calls.save.length, 0);
  assert.equal(uninitializedStore.getPersistedState(), null);

  const initializedState = reconciliation.createReconciliationState([]);
  const failingStore = createMemoryStateStore(initializedState);
  const writeError = new Error("storage write failed");
  const failingIntegration = createPersistentIntegration(
    failingStore,
    () => createActiveState(),
  );

  failingStore.failNextSave(writeError);
  await assert.rejects(
    () =>
      failingIntegration.dispatch({
        type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
        variationNumbers: [44],
      }),
    writeError,
  );
  assert.deepEqual(failingStore.getPersistedState(), initializedState);

  await failingIntegration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44],
  });
  assert.equal(
    failingStore.getPersistedState().streams[0].variations[0].variationNumber,
    44,
  );
});

test("validates dependencies immediately", () => {
  assert.throws(() => createCaptureIntegration(), TypeError);
  assert.throws(
    () => createCaptureIntegration({ captureProtocol }),
    TypeError,
  );
});
