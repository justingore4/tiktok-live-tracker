const assert = require("node:assert/strict");
const test = require("node:test");

const streamSession = require("../extension/shared/stream-session.js");
const {
  COMMAND_TYPES,
  MESSAGE_CHANNEL,
  MESSAGE_VERSION,
  StreamSessionCoordinatorError,
  createStreamSessionCoordinator,
} = require("../extension/shared/stream-session-coordinator.js");

const FIRST_ID = "local-stream:11111111-1111-4111-8111-111111111111";
const SECOND_ID = "local-stream:22222222-2222-4222-8222-222222222222";
const STARTED_AT = "2026-08-08T19:00:00.000Z";

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
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

function createActiveState(streamId = FIRST_ID) {
  const state = streamSession.createStreamSessionState();
  streamSession.startStream(state, {
    streamId,
    startedAt: STARTED_AT,
    identitySource: "local_session",
  });
  return state;
}

function createMemoryStore(initialState = null) {
  let persistedState = clone(initialState);
  let nextLoadError = null;
  let nextSaveError = null;
  let beforeSave = null;
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const calls = { load: 0, save: [] };
  const stateStore = {
    async loadState() {
      calls.load += 1;
      if (nextLoadError) {
        const error = nextLoadError;
        nextLoadError = null;
        throw error;
      }
      return clone(persistedState);
    },
    async saveState(state) {
      const snapshot = clone(state);
      const saveIndex = calls.save.length;
      calls.save.push(snapshot);
      activeSaves += 1;
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
      try {
        if (beforeSave) {
          await beforeSave(snapshot, saveIndex);
        }
        if (nextSaveError) {
          const error = nextSaveError;
          nextSaveError = null;
          throw error;
        }
        persistedState = snapshot;
      } finally {
        activeSaves -= 1;
      }
    },
  };

  return {
    calls,
    stateStore,
    failNextLoad(error) {
      nextLoadError = error;
    },
    failNextSave(error) {
      nextSaveError = error;
    },
    persisted: () => clone(persistedState),
    setBeforeSave(callback) {
      beforeSave = callback;
    },
    maximumActiveSaves: () => maximumActiveSaves,
  };
}

function createCoordinator(memory, options = {}) {
  let idCalls = 0;
  let nowCalls = 0;
  const ids = options.ids ?? [FIRST_ID, SECOND_ID];
  const coordinator = createStreamSessionCoordinator({
    streamSession,
    stateStore: memory.stateStore,
    createId() {
      idCalls += 1;
      if (options.idError) {
        throw options.idError;
      }
      return ids[idCalls - 1] ?? SECOND_ID;
    },
    now() {
      nowCalls += 1;
      if (options.nowError) {
        throw options.nowError;
      }
      return options.startedAt ?? STARTED_AT;
    },
  });

  return {
    coordinator,
    idCalls: () => idCalls,
    nowCalls: () => nowCalls,
  };
}

function getCommand() {
  return { type: COMMAND_TYPES.GET_STREAM_SESSION };
}

function startCommand() {
  return { type: COMMAND_TYPES.START_STREAM };
}

function endCommand(streamId = FIRST_ID) {
  return { type: COMMAND_TYPES.END_STREAM, streamId };
}

async function assertCode(action, code, ErrorType = Error) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ErrorType);
    assert.equal(error.code, code);
    return true;
  });
}

test("exports a separate strict protocol", () => {
  assert.equal(MESSAGE_CHANNEL, "tiktok-live-tracker.stream-session");
  assert.equal(MESSAGE_VERSION, 1);
  assert.deepEqual(COMMAND_TYPES, {
    GET_STREAM_SESSION: "get_stream_session",
    START_STREAM: "start_stream",
    END_STREAM: "end_stream",
  });
});

test("treats absent storage as an inactive state without writing", async () => {
  const memory = createMemoryStore();
  const { coordinator } = createCoordinator(memory);

  assert.deepEqual(await coordinator.dispatch(getCommand()), {
    state: { version: 1, activeSession: null },
    result: null,
  });
  assert.equal(memory.calls.load, 1);
  assert.equal(memory.calls.save.length, 0);
});

test("starts once, persists before publishing, and makes retries idempotent", async () => {
  const memory = createMemoryStore();
  const harness = createCoordinator(memory);
  const first = await harness.coordinator.dispatch(startCommand());
  const repeated = await harness.coordinator.dispatch(startCommand());

  assert.equal(first.result.status, "started");
  assert.deepEqual(first.state.activeSession, {
    streamId: FIRST_ID,
    startedAt: STARTED_AT,
    identitySource: "local_session",
  });
  assert.equal(repeated.result.status, "already_active");
  assert.deepEqual(repeated.state, first.state);
  assert.deepEqual(memory.persisted(), first.state);
  assert.equal(memory.calls.save.length, 1);
  assert.equal(harness.idCalls(), 1);
  assert.equal(harness.nowCalls(), 1);
});

test("ends only the expected active stream and persists inactive state", async () => {
  const memory = createMemoryStore(createActiveState());
  const { coordinator } = createCoordinator(memory);
  const response = await coordinator.dispatch(endCommand());

  assert.equal(response.result.status, "ended");
  assert.equal(response.state.activeSession, null);
  assert.deepEqual(memory.persisted(), response.state);
});

test("an end retry after a lost response and worker restart converges", async () => {
  const memory = createMemoryStore(createActiveState());
  const firstWorker = createCoordinator(memory).coordinator;

  await firstWorker.dispatch(endCommand());
  const savesAfterFirstEnd = memory.calls.save.length;
  const restartedWorker = createCoordinator(memory).coordinator;
  const retry = await restartedWorker.dispatch(endCommand());

  assert.equal(retry.result.status, "already_ended");
  assert.equal(retry.state.activeSession, null);
  assert.equal(memory.calls.save.length, savesAfterFirstEnd);
});

test("an already-ended retry is idempotent while a stale ID stays rejected", async () => {
  const emptyMemory = createMemoryStore();
  const emptyCoordinator = createCoordinator(emptyMemory).coordinator;
  const alreadyEnded = await emptyCoordinator.dispatch(endCommand());

  assert.equal(alreadyEnded.result.status, "already_ended");
  assert.equal(alreadyEnded.state.activeSession, null);
  assert.equal(emptyMemory.calls.save.length, 0);

  const activeMemory = createMemoryStore(createActiveState());
  const activeCoordinator = createCoordinator(activeMemory).coordinator;
  await assertCode(
    () => activeCoordinator.dispatch(endCommand(SECOND_ID)),
    "ACTIVE_STREAM_MISMATCH",
    streamSession.StreamSessionError,
  );
  assert.deepEqual(activeMemory.persisted(), createActiveState());
  assert.equal(activeMemory.calls.save.length, 0);
});

test("an inactive stream still validates the requested end identifier", async () => {
  const memory = createMemoryStore();
  const coordinator = createCoordinator(memory).coordinator;

  await assertCode(
    () => coordinator.dispatch(endCommand("malformed-but-nonempty")),
    "INVALID_STREAM_SESSION_STATE",
    streamSession.StreamSessionError,
  );
  assert.equal(memory.calls.save.length, 0);
  assert.equal(memory.persisted(), null);
});

test("serializes concurrent starts so only one session is generated", async () => {
  const memory = createMemoryStore();
  const saveStarted = createDeferred();
  const releaseSave = createDeferred();
  memory.setBeforeSave(async (_state, index) => {
    if (index === 0) {
      saveStarted.resolve();
      await releaseSave.promise;
    }
  });
  const harness = createCoordinator(memory);
  const first = harness.coordinator.dispatch(startCommand());
  const second = harness.coordinator.dispatch(startCommand());

  await saveStarted.promise;
  assert.equal(memory.calls.save.length, 1);
  releaseSave.resolve();
  const [started, repeated] = await Promise.all([first, second]);

  assert.equal(started.result.status, "started");
  assert.equal(repeated.result.status, "already_active");
  assert.equal(harness.idCalls(), 1);
  assert.equal(memory.maximumActiveSaves(), 1);
});

test("queues reads behind unfinished durable mutations", async () => {
  const memory = createMemoryStore();
  const saveStarted = createDeferred();
  const releaseSave = createDeferred();
  let readSettled = false;
  memory.setBeforeSave(async () => {
    saveStarted.resolve();
    await releaseSave.promise;
  });
  const { coordinator } = createCoordinator(memory);
  const start = coordinator.dispatch(startCommand());
  const read = coordinator.dispatch(getCommand()).then((value) => {
    readSettled = true;
    return value;
  });

  await saveStarted.promise;
  await Promise.resolve();
  assert.equal(readSettled, false);
  releaseSave.resolve();
  await start;
  assert.equal((await read).state.activeSession.streamId, FIRST_ID);
});

test("failed writes do not publish state and the queue remains retryable", async () => {
  const memory = createMemoryStore();
  const failure = new Error("write failed");
  memory.failNextSave(failure);
  const harness = createCoordinator(memory);

  await assert.rejects(
    () => harness.coordinator.dispatch(startCommand()),
    (error) => error === failure,
  );
  assert.equal(
    (await harness.coordinator.dispatch(getCommand())).state.activeSession,
    null,
  );

  const retried = await harness.coordinator.dispatch(startCommand());
  assert.equal(retried.state.activeSession.streamId, SECOND_ID);
  assert.equal(memory.calls.save.length, 2);
});

test("failed cold loads retry instead of inventing or saving state", async () => {
  const memory = createMemoryStore(createActiveState());
  const failure = new Error("read failed");
  memory.failNextLoad(failure);
  const { coordinator } = createCoordinator(memory);

  await assert.rejects(
    () => coordinator.dispatch(getCommand()),
    (error) => error === failure,
  );
  assert.equal(memory.calls.save.length, 0);

  const restored = await coordinator.dispatch(getCommand());
  assert.equal(restored.state.activeSession.streamId, FIRST_ID);
  assert.equal(memory.calls.load, 2);
});

test("a new coordinator restores the durable active session", async () => {
  const memory = createMemoryStore();
  const first = createCoordinator(memory).coordinator;
  await first.dispatch(startCommand());

  const second = createCoordinator(memory).coordinator;
  const restored = await second.dispatch(getCommand());

  assert.equal(restored.state.activeSession.streamId, FIRST_ID);
  assert.equal(memory.calls.load, 2);
});

test("generator failures and invalid generated metadata cannot write", async () => {
  const idError = new Error("random source unavailable");
  const idMemory = createMemoryStore();
  const idCoordinator = createCoordinator(idMemory, { idError }).coordinator;
  await assertCode(
    () => idCoordinator.dispatch(startCommand()),
    "STREAM_ID_GENERATION_FAILED",
    StreamSessionCoordinatorError,
  );
  assert.equal(idMemory.calls.save.length, 0);

  const timeError = new Error("clock unavailable");
  const timeMemory = createMemoryStore();
  const timeCoordinator = createCoordinator(timeMemory, { nowError: timeError })
    .coordinator;
  await assertCode(
    () => timeCoordinator.dispatch(startCommand()),
    "STREAM_TIME_GENERATION_FAILED",
    StreamSessionCoordinatorError,
  );
  assert.equal(timeMemory.calls.save.length, 0);

  const malformedMemory = createMemoryStore();
  const malformed = createCoordinator(malformedMemory, {
    ids: ["not-local"],
  }).coordinator;
  await assertCode(
    () => malformed.dispatch(startCommand()),
    "INVALID_STREAM_SESSION_STATE",
    streamSession.StreamSessionError,
  );
  assert.equal(malformedMemory.calls.save.length, 0);
});

test("returned snapshots cannot mutate canonical state", async () => {
  const memory = createMemoryStore();
  const { coordinator } = createCoordinator(memory);
  const started = await coordinator.dispatch(startCommand());
  started.state.activeSession.streamId = SECOND_ID;
  started.result.status = "changed";

  const fresh = await coordinator.dispatch(getCommand());
  assert.equal(fresh.state.activeSession.streamId, FIRST_ID);
  assert.deepEqual(memory.persisted(), fresh.state);
});

test("rejects malformed commands before storage access", async () => {
  const memory = createMemoryStore();
  const { coordinator } = createCoordinator(memory);
  const invalidCommands = [
    null,
    {},
    { type: "unknown" },
    { type: COMMAND_TYPES.GET_STREAM_SESSION, extra: true },
    { type: COMMAND_TYPES.START_STREAM, streamId: FIRST_ID },
    { type: COMMAND_TYPES.END_STREAM },
    { type: COMMAND_TYPES.END_STREAM, streamId: "" },
  ];

  for (const command of invalidCommands) {
    await assert.rejects(
      () => coordinator.dispatch(command),
      StreamSessionCoordinatorError,
    );
  }
  assert.equal(memory.calls.load, 0);
});

test("validates coordinator dependencies immediately", () => {
  assert.throws(() => createStreamSessionCoordinator(), TypeError);
  assert.throws(
    () =>
      createStreamSessionCoordinator({
        streamSession,
        stateStore: {},
        createId() {},
        now() {},
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createStreamSessionCoordinator({
        streamSession,
        stateStore: { loadState() {}, saveState() {} },
        createId: null,
        now() {},
      }),
    TypeError,
  );
});
