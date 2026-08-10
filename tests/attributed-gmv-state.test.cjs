const assert = require("node:assert/strict");
const test = require("node:test");

const captureProtocol = require(
  "../extension/shared/capture-protocol.js",
);
const {
  createCaptureIntegration,
} = require("../extension/shared/capture-integration.js");
const {
  createCaptureClient,
} = require("../extension/capture/capture-client.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationCoordinator = require(
  "../extension/shared/reconciliation-coordinator.js",
);
const {
  createMappingSession,
} = require("../extension/tagger/mapping-workflow.js");

const STREAM_ONE = "stream-attributed-gmv-one";
const STREAM_TWO = "stream-attributed-gmv-two";
const INVENTORY = [{
  sku: "BLACK-TEE-M",
  name: "Black Tee",
  size: "M",
  quantityReceived: 3,
  unitCostCents: 1200,
}];
const DISPLAY_INVENTORY = [{
  sku: "BLACK-TEE-M",
  item: "Black Tee",
  style: "",
  size: "M",
  quantityReceived: 3,
  unitCostCents: 1200,
}];

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createPinnedState(streamId = STREAM_ONE) {
  const state = reconciliation.createReconciliationState(INVENTORY);

  reconciliation.pinStreamToInventoryBaseline(state, { streamId });
  return state;
}

function createMemoryStateStore(initialState) {
  let persistedState = clone(initialState);
  const calls = { load: 0, save: [] };

  return {
    calls,
    getPersistedState: () => clone(persistedState),
    stateStore: {
      async loadState() {
        calls.load += 1;
        return clone(persistedState);
      },
      async saveState(state) {
        const snapshot = clone(state);

        calls.save.push(snapshot);
        persistedState = snapshot;
      },
    },
  };
}

function assertReconciliationError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof reconciliation.ReconciliationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("capture protocol accepts only canonical TikTok Attributed GMV displays", () => {
  assert.equal(
    captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
    "observe_attributed_gmv",
  );

  for (const attributedGmvDisplay of [
    "$0.00",
    "$999.99",
    "$4,087.01",
    "$4.64K",
    "$4.6M",
    "$1B",
    "$1000K",
  ]) {
    const event = {
      type: captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
      attributedGmvDisplay,
    };
    const message = captureProtocol.createCaptureMessage(event);

    assert.deepEqual(captureProtocol.validateCaptureMessage(message), event);
    assert.notEqual(message.event, event);
  }

  for (const attributedGmvDisplay of [
    " $4.64K",
    "$4.64K ",
    "$04.64K",
    "$4.640K",
    "$4.64k",
    "$1000.00",
    "$4,87.01",
    "$-4.64K",
    "€4.64K",
    "$4.64K<script>",
  ]) {
    assert.throws(
      () => captureProtocol.createCaptureMessage({
        type: captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
        attributedGmvDisplay,
      }),
      (error) =>
        error instanceof captureProtocol.CaptureProtocolError &&
        error.code === "INVALID_CAPTURE_MESSAGE",
      attributedGmvDisplay,
    );
  }

  assert.throws(
    () => captureProtocol.createCaptureMessage({
      type: captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
      attributedGmvDisplay: "$4.64K",
      rawDashboardHtml: "<div>untrusted</div>",
    }),
    (error) =>
      error instanceof captureProtocol.CaptureProtocolError &&
      error.code === "INVALID_CAPTURE_MESSAGE",
  );
});

test("capture client snapshots and delivers an Attributed GMV observation", async () => {
  const messages = [];
  const runtime = {
    async sendMessage(message) {
      messages.push(message);
      return { ok: true, data: { status: "accepted" } };
    },
  };
  const client = createCaptureClient({ protocol: captureProtocol, runtime });

  assert.equal(typeof client.observeAttributedGmv, "function");
  assert.deepEqual(await client.observeAttributedGmv("$4.64K"), {
    status: "accepted",
  });
  assert.deepEqual(messages, [captureProtocol.createCaptureMessage({
    type: captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
    attributedGmvDisplay: "$4.64K",
  })]);
});

test("capture integration scopes Attributed GMV to the verified active stream", async () => {
  const commands = [];
  const integration = createCaptureIntegration({
    activeStreamCoordinator: {
      async dispatch() {
        return {
          state: {
            activeSession: { streamId: STREAM_ONE },
          },
        };
      },
    },
    captureProtocol,
    reconciliationCoordinator,
    stateCoordinator: {
      async dispatch(command) {
        commands.push(clone(command));
        return { state: null, result: null };
      },
    },
    streamSession: {
      hydrateStreamSessionState(state) {
        return state;
      },
    },
    streamSessionCoordinator: {
      COMMAND_TYPES: {
        GET_STREAM_SESSION: "get_stream_session",
      },
    },
  });

  assert.deepEqual(await integration.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
    attributedGmvDisplay: "$4.64K",
  }), { status: "accepted" });
  assert.deepEqual(commands, [
    {
      type:
        reconciliationCoordinator.COMMAND_TYPES
          .PIN_STREAM_TO_INVENTORY_BASELINE,
      streamId: STREAM_ONE,
    },
    {
      type:
        reconciliationCoordinator.COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV,
      streamId: STREAM_ONE,
      attributedGmvDisplay: "$4.64K",
    },
  ]);
});

test("Attributed GMV is stream-scoped, replaceable, idempotent, and summary-visible", () => {
  const state = createPinnedState();

  assert.equal(
    reconciliation.calculateSummary(state, { streamId: STREAM_ONE }).totals
      .attributedGmvDisplay,
    null,
  );

  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$4.64K",
  });
  const afterFirstObservation = clone(state);

  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$4.64K",
  });
  assert.deepEqual(state, afterFirstObservation);

  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$4,687.01",
  });
  reconciliation.pinStreamToInventoryBaseline(state, {
    streamId: STREAM_TWO,
  });
  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_TWO,
    attributedGmvDisplay: "$125.00",
  });

  assert.equal(
    reconciliation.calculateSummary(state, { streamId: STREAM_ONE }).totals
      .attributedGmvDisplay,
    "$4,687.01",
  );
  assert.equal(
    reconciliation.calculateSummary(state, { streamId: STREAM_TWO }).totals
      .attributedGmvDisplay,
    "$125.00",
  );
  assert.equal(
    state.streams.find(({ streamId }) => streamId === STREAM_ONE)
      .attributedGmvDisplay,
    "$4,687.01",
  );
});

test("invalid Attributed GMV observations are rejected atomically", () => {
  const state = createPinnedState();
  const original = clone(state);

  for (const input of [
    { streamId: STREAM_ONE, attributedGmvDisplay: "$4.640K" },
    { streamId: STREAM_ONE, attributedGmvDisplay: "$1000.00" },
    { streamId: STREAM_ONE, attributedGmvDisplay: "$4.64K<script>" },
    { streamId: "", attributedGmvDisplay: "$4.64K" },
  ]) {
    assertReconciliationError(
      () => reconciliation.observeAttributedGmv(state, input),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(state, original);
  }
});

test("current state strictly migrates a detached v4 stream with no Attributed GMV", () => {
  const current = createPinnedState();
  const v4 = clone(current);

  v4.version = 4;
  delete v4.streams[0].activeBiddingVariationNumber;
  delete v4.streams[0].attributedGmvDisplay;

  const migrated = reconciliation.hydrateReconciliationState(v4);

  assert.equal(reconciliation.STATE_VERSION, 7);
  assert.equal(migrated.version, 7);
  assert.equal(migrated.streams[0].attributedGmvDisplay, null);
  assert.notEqual(migrated, v4);
  assert.notEqual(migrated.streams, v4.streams);
  assert.deepEqual(
    reconciliation.hydrateReconciliationState(clone(migrated)),
    migrated,
  );
});

test("current state hydration strictly validates the persisted display field", () => {
  const valid = createPinnedState();

  reconciliation.observeAttributedGmv(valid, {
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$4.64K",
  });
  assert.deepEqual(
    reconciliation.hydrateReconciliationState(clone(valid)),
    valid,
  );

  const missing = clone(valid);
  delete missing.streams[0].attributedGmvDisplay;
  assertReconciliationError(
    () => reconciliation.hydrateReconciliationState(missing),
    "INVALID_STATE",
  );

  const malformed = clone(valid);
  malformed.streams[0].attributedGmvDisplay = "$4.64K<script>";
  assertReconciliationError(
    () => reconciliation.hydrateReconciliationState(malformed),
    "INVALID_STATE",
  );
});

test("coordinator validates, serializes, and persists Attributed GMV observations", async () => {
  const memoryStore = createMemoryStateStore(createPinnedState());
  const coordinator = reconciliationCoordinator
    .createReconciliationCoordinator({
      reconciliation,
      stateStore: memoryStore.stateStore,
    });
  const command = {
    type:
      reconciliationCoordinator.COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV,
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$4.64K",
  };

  assert.equal(command.type, "observe_attributed_gmv");
  const first = await coordinator.dispatch(command);
  const repeated = await coordinator.dispatch(clone(command));

  assert.equal(first.state.streams[0].attributedGmvDisplay, "$4.64K");
  assert.equal(repeated.state.streams[0].attributedGmvDisplay, "$4.64K");
  assert.equal(memoryStore.calls.save.length, 1);
  assert.equal(
    memoryStore.getPersistedState().streams[0].attributedGmvDisplay,
    "$4.64K",
  );

  await assert.rejects(
    () => coordinator.dispatch({ ...command, extra: true }),
    (error) =>
      error instanceof
        reconciliationCoordinator.ReconciliationCoordinatorError &&
      error.code === "INVALID_COMMAND",
  );
  await assert.rejects(
    () => coordinator.dispatch({
      ...command,
      attributedGmvDisplay: "$4.64K<script>",
    }),
    (error) =>
      error instanceof
        reconciliationCoordinator.ReconciliationCoordinatorError &&
      error.code === "INVALID_COMMAND",
  );
  assert.equal(memoryStore.calls.save.length, 1);
});

test("mapping view exposes the active stream Attributed GMV under totals", () => {
  const state = createPinnedState();

  reconciliation.observeAttributedGmv(state, {
    streamId: STREAM_ONE,
    attributedGmvDisplay: "$4.64K",
  });
  const session = createMappingSession({
    inventory: DISPLAY_INVENTORY,
    reconciliation,
    state,
    streamId: STREAM_ONE,
    variationNumber: 1,
    variationNumbers: [1],
  });

  assert.equal(
    session.getViewState().totals.attributedGmvDisplay,
    "$4.64K",
  );
});
