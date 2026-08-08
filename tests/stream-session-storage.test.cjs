const assert = require("node:assert/strict");
const test = require("node:test");

const streamSession = require("../extension/shared/stream-session.js");
const {
  STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
  StreamSessionStorageError,
  createStreamSessionStateStore,
} = require("../extension/shared/stream-session-storage.js");

const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createActiveState() {
  const state = streamSession.createStreamSessionState();
  streamSession.startStream(state, {
    streamId: STREAM_ID,
    startedAt: "2026-08-08T19:00:00.000Z",
    identitySource: "local_session",
  });
  return state;
}

function createMemoryStorage(initial = {}) {
  let values = clone(initial);
  let readError = null;
  let writeError = null;
  const calls = { get: [], set: [] };
  const storageArea = {
    async get(key) {
      calls.get.push(key);
      if (readError) {
        throw readError;
      }
      return clone(values);
    },
    async set(update) {
      calls.set.push(clone(update));
      if (writeError) {
        throw writeError;
      }
      values = { ...values, ...clone(update) };
    },
  };

  return {
    calls,
    storageArea,
    values: () => clone(values),
    failRead(error) {
      readError = error;
    },
    failWrite(error) {
      writeError = error;
    },
  };
}

function createStore(memory) {
  return createStreamSessionStateStore({
    storageArea: memory.storageArea,
    streamSession,
  });
}

async function assertCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof StreamSessionStorageError);
    assert.equal(error.code, code);
    return true;
  });
}

test("uses an independent stable storage key and schema", () => {
  assert.equal(STORAGE_KEY, "tiktokLiveTracker.streamSession");
  assert.equal(STORAGE_SCHEMA_VERSION, 1);
});

test("returns null only when the stream-session key is absent", async () => {
  const memory = createMemoryStorage({ unrelated: true });
  const store = createStore(memory);

  assert.equal(await store.loadState(), null);
  assert.deepEqual(memory.calls.get, [STORAGE_KEY]);
  assert.equal(memory.calls.set.length, 0);
});

test("saves and restores a strict detached envelope", async () => {
  const memory = createMemoryStorage();
  const store = createStore(memory);
  const state = createActiveState();

  await store.saveState(state);
  state.activeSession.streamId =
    "local-stream:22222222-2222-4222-8222-222222222222";

  assert.deepEqual(memory.values(), {
    [STORAGE_KEY]: {
      schemaVersion: 1,
      sessionState: createActiveState(),
    },
  });

  const restored = await store.loadState();
  assert.deepEqual(restored, createActiveState());
  restored.activeSession.startedAt = "changed";
  assert.equal(
    memory.values()[STORAGE_KEY].sessionState.activeSession.startedAt,
    "2026-08-08T19:00:00.000Z",
  );
});

test("rejects malformed and future storage envelopes", async () => {
  const cases = [
    [{ [STORAGE_KEY]: null }, "INVALID_STORAGE_ENVELOPE"],
    [
      {
        [STORAGE_KEY]: {
          schemaVersion: 1,
          sessionState: streamSession.createStreamSessionState(),
          extra: true,
        },
      },
      "INVALID_STORAGE_ENVELOPE",
    ],
    [
      {
        [STORAGE_KEY]: {
          schemaVersion: 0,
          sessionState: streamSession.createStreamSessionState(),
        },
      },
      "INVALID_STORAGE_ENVELOPE",
    ],
    [
      {
        [STORAGE_KEY]: {
          schemaVersion: 2,
          sessionState: streamSession.createStreamSessionState(),
        },
      },
      "UNSUPPORTED_STORAGE_VERSION",
    ],
  ];

  for (const [stored, code] of cases) {
    await assertCode(() => createStore(createMemoryStorage(stored)).loadState(), code);
  }
});

test("distinguishes invalid and unsupported session state", async () => {
  const invalid = createMemoryStorage({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      sessionState: { version: 1, activeSession: {} },
    },
  });
  const unsupported = createMemoryStorage({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      sessionState: { version: 2, activeSession: null },
    },
  });

  await assertCode(
    () => createStore(invalid).loadState(),
    "INVALID_STREAM_SESSION_STATE",
  );
  await assertCode(
    () => createStore(unsupported).loadState(),
    "UNSUPPORTED_STREAM_SESSION_VERSION",
  );
});

test("wraps storage failures and retains their causes", async () => {
  const readFailure = new Error("read details");
  const readMemory = createMemoryStorage();
  readMemory.failRead(readFailure);

  await assert.rejects(
    () => createStore(readMemory).loadState(),
    (error) => {
      assert.equal(error.code, "STORAGE_READ_FAILED");
      assert.equal(error.cause, readFailure);
      return true;
    },
  );

  const writeFailure = new Error("write details");
  const writeMemory = createMemoryStorage();
  writeMemory.failWrite(writeFailure);

  await assert.rejects(
    () => createStore(writeMemory).saveState(createActiveState()),
    (error) => {
      assert.equal(error.code, "STORAGE_WRITE_FAILED");
      assert.equal(error.cause, writeFailure);
      return true;
    },
  );
  assert.deepEqual(writeMemory.values(), {});
});

test("rejects invalid browser responses and dependencies", async () => {
  const store = createStreamSessionStateStore({
    storageArea: {
      async get() {
        return null;
      },
      async set() {},
    },
    streamSession,
  });

  await assertCode(() => store.loadState(), "STORAGE_READ_FAILED");
  assert.throws(() => createStreamSessionStateStore(), TypeError);
  assert.throws(
    () => createStreamSessionStateStore({ storageArea: {}, streamSession }),
    TypeError,
  );
  assert.throws(
    () =>
      createStreamSessionStateStore({
        storageArea: { get() {}, set() {} },
        streamSession: {},
      }),
    TypeError,
  );
});
