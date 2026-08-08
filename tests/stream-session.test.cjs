const assert = require("node:assert/strict");
const test = require("node:test");

const streamSession = require("../extension/shared/stream-session.js");

const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";
const OTHER_STREAM_ID = "local-stream:22222222-2222-4222-8222-222222222222";
const STARTED_AT = "2026-08-08T19:00:00.000Z";

function startInput(overrides = {}) {
  return {
    streamId: STREAM_ID,
    startedAt: STARTED_AT,
    identitySource: streamSession.IDENTITY_SOURCES.LOCAL_SESSION,
    ...overrides,
  };
}

function activeState() {
  const state = streamSession.createStreamSessionState();
  streamSession.startStream(state, startInput());
  return state;
}

function assertCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof streamSession.StreamSessionError);
    assert.equal(error.code, code);
    return true;
  });
}

test("creates an explicit versioned state with no active stream", () => {
  assert.deepEqual(streamSession.createStreamSessionState(), {
    version: 1,
    activeSession: null,
  });
  assert.equal(streamSession.LOCAL_STREAM_ID_PREFIX, "local-stream:");
  assert.equal(streamSession.LOCAL_STREAM_ID_PATTERN.test(STREAM_ID), true);
  assert.equal(
    streamSession.IDENTITY_SOURCES.LOCAL_SESSION,
    "local_session",
  );
});

test("starts and ends one local stream without deleting other state objects", () => {
  const state = streamSession.createStreamSessionState();

  assert.deepEqual(streamSession.startStream(state, startInput()), {
    status: "started",
  });
  assert.deepEqual(state.activeSession, startInput());
  assert.deepEqual(
    streamSession.endStream(state, { streamId: STREAM_ID }),
    { status: "ended" },
  );
  assert.equal(state.activeSession, null);
});

test("hydrates a detached canonical snapshot", () => {
  const state = activeState();
  const hydrated = streamSession.hydrateStreamSessionState(state);

  assert.deepEqual(hydrated, state);
  assert.notEqual(hydrated, state);
  assert.notEqual(hydrated.activeSession, state.activeSession);

  hydrated.activeSession.streamId = OTHER_STREAM_ID;
  assert.equal(state.activeSession.streamId, STREAM_ID);
});

test("requires exact state and active-session shapes", () => {
  for (const candidate of [
    null,
    [],
    { version: 1 },
    { version: 1, activeSession: null, extra: true },
    { version: 0, activeSession: null },
    { version: 1, activeSession: {} },
    {
      version: 1,
      activeSession: { ...startInput(), extra: true },
    },
  ]) {
    assertCode(
      () => streamSession.hydrateStreamSessionState(candidate),
      "INVALID_STREAM_SESSION_STATE",
    );
  }
});

test("distinguishes unsupported state versions", () => {
  assertCode(
    () =>
      streamSession.hydrateStreamSessionState({
        version: 2,
        activeSession: null,
      }),
    "UNSUPPORTED_STREAM_SESSION_STATE_VERSION",
  );
});

test("rejects malformed local identity metadata and timestamps", () => {
  const malformed = [
    startInput({ streamId: "" }),
    startInput({ streamId: "verified-tiktok-id" }),
    startInput({ streamId: "local-stream:not-a-uuid" }),
    startInput({ streamId: `${STREAM_ID} ` }),
    startInput({ identitySource: "verified" }),
    startInput({ startedAt: "2026-08-08" }),
    startInput({ startedAt: "not-a-date" }),
  ];

  for (const activeSession of malformed) {
    assertCode(
      () =>
        streamSession.hydrateStreamSessionState({
          version: 1,
          activeSession,
        }),
      "INVALID_STREAM_SESSION_STATE",
    );
  }
});

test("does not replace an active stream", () => {
  const state = activeState();

  assertCode(
    () =>
      streamSession.startStream(
        state,
        startInput({ streamId: OTHER_STREAM_ID }),
      ),
    "ACTIVE_STREAM_ALREADY_EXISTS",
  );
  assert.equal(state.activeSession.streamId, STREAM_ID);
});

test("requires the expected active ID when ending", () => {
  const empty = streamSession.createStreamSessionState();
  const active = activeState();

  assert.deepEqual(
    streamSession.endStream(empty, { streamId: STREAM_ID }),
    { status: "already_ended" },
  );
  assertCode(
    () => streamSession.endStream(active, { streamId: OTHER_STREAM_ID }),
    "ACTIVE_STREAM_MISMATCH",
  );
  assert.equal(active.activeSession.streamId, STREAM_ID);
});

test("invalid command inputs do not partially mutate state", () => {
  const empty = streamSession.createStreamSessionState();
  const active = activeState();

  assertCode(
    () => streamSession.startStream(empty, { ...startInput(), extra: true }),
    "INVALID_STREAM_SESSION_STATE",
  );
  assertCode(
    () => streamSession.endStream(active, { streamId: STREAM_ID, extra: true }),
    "INVALID_STREAM_SESSION_STATE",
  );
  assert.equal(empty.activeSession, null);
  assert.equal(active.activeSession.streamId, STREAM_ID);
});
