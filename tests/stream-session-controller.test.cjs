const assert = require("node:assert/strict");
const test = require("node:test");

const controllerModule = require("../extension/tagger/stream-session-controller.js");

const SESSION = Object.freeze({
  streamId: "local-stream:11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-08T18:00:00.000Z",
  identitySource: "local_session",
});

function response(activeSession, status = null) {
  return {
    state: {
      version: 1,
      activeSession: activeSession === null ? null : { ...activeSession },
    },
    result: status === null ? null : { status },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });

  return { promise, reject, resolve };
}

function createClient(overrides = {}) {
  const calls = [];
  const client = {
    getSession() {
      calls.push(["get"]);
      return Promise.resolve(response(null));
    },
    startStream() {
      calls.push(["start"]);
      return Promise.resolve(response(SESSION, "started"));
    },
    endStream(options) {
      calls.push(["end", { ...options }]);
      return Promise.resolve(response(null, "ended"));
    },
    ...overrides,
  };

  return { calls, client };
}

test("loads an absent stream without starting one", async () => {
  const { calls, client } = createClient();
  const controller = controllerModule.createStreamSessionController({ client });

  assert.deepEqual(controller.getSnapshot(), {
    phase: "idle",
    operation: null,
    busy: false,
    error: null,
    activeSession: null,
    resumed: false,
  });

  const snapshot = await controller.start();

  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.activeSession, null);
  assert.equal(snapshot.resumed, false);
  assert.deepEqual(calls, [["get"]]);
});

test("does not mutate a stream before the initial restore is ready", () => {
  const { client } = createClient();
  const controller = controllerModule.createStreamSessionController({ client });

  assert.throws(
    () => controller.startNewStream(),
    (error) => error.code === "CONTROLLER_BUSY",
  );
  assert.throws(
    () => controller.endActiveStream(),
    (error) => error.code === "CONTROLLER_BUSY",
  );
});

test("restores a durable stream as resume-available without writing", async () => {
  const { calls, client } = createClient({
    getSession() {
      calls.push(["get"]);
      return Promise.resolve(response(SESSION));
    },
  });
  const controller = controllerModule.createStreamSessionController({ client });

  await controller.start();
  assert.equal(controller.getSnapshot().resumed, false);

  const resumed = controller.resumeActiveStream();

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.activeSession.streamId, SESSION.streamId);
  assert.deepEqual(calls, [["get"]]);
});

test("starts, publishes, and ends one durable tracker stream", async () => {
  const { calls, client } = createClient();
  const controller = controllerModule.createStreamSessionController({ client });

  await controller.start();
  const started = await controller.startNewStream();

  assert.equal(started.resumed, true);
  assert.deepEqual(started.activeSession, SESSION);

  const ended = await controller.endActiveStream();

  assert.equal(ended.activeSession, null);
  assert.equal(ended.resumed, false);
  assert.deepEqual(calls, [
    ["get"],
    ["start"],
    ["end", { streamId: SESSION.streamId }],
  ]);
});

test("blocks a second operation while persistence is in flight", async () => {
  const startResult = deferred();
  const { client } = createClient({
    startStream() {
      return startResult.promise;
    },
  });
  const controller = controllerModule.createStreamSessionController({ client });

  await controller.start();
  const pending = controller.startNewStream();

  assert.throws(
    () => controller.startNewStream(),
    (error) => error.code === "CONTROLLER_BUSY",
  );
  startResult.resolve(response(SESSION, "started"));
  await pending;
});

test("a lost end response keeps the frozen ID and converges on retry", async () => {
  let attempts = 0;
  const calls = [];
  const { client } = createClient({
    getSession() {
      return Promise.resolve(response(SESSION));
    },
    endStream(options) {
      calls.push({ ...options });
      attempts += 1;

      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("Could not save end."), {
            code: "STREAM_SESSION_WRITE_FAILED",
          }),
        );
      }

      return Promise.resolve(response(null, "already_ended"));
    },
  });
  const controller = controllerModule.createStreamSessionController({ client });

  await controller.start();
  controller.resumeActiveStream();
  const failed = await controller.endActiveStream();

  assert.equal(failed.phase, "error");
  assert.equal(failed.activeSession.streamId, SESSION.streamId);
  assert.equal(failed.resumed, true);

  const recovered = await controller.retry();

  assert.equal(recovered.phase, "ready");
  assert.equal(recovered.activeSession, null);
  assert.deepEqual(calls, [
    { streamId: SESSION.streamId },
    { streamId: SESSION.streamId },
  ]);
});

test("a failed load remains closed and retry can recover", async () => {
  let attempts = 0;
  const { client } = createClient({
    getSession() {
      attempts += 1;

      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("Stored stream is corrupt."), {
            code: "INVALID_STREAM_SESSION_STATE",
          }),
        );
      }

      return Promise.resolve(response(SESSION));
    },
  });
  const controller = controllerModule.createStreamSessionController({ client });

  const failed = await controller.start();

  assert.equal(failed.phase, "error");
  assert.equal(failed.activeSession, null);
  assert.equal(failed.error.scope, "load");

  const restored = await controller.retry();

  assert.equal(restored.phase, "ready");
  assert.equal(restored.activeSession.streamId, SESSION.streamId);
  assert.equal(restored.resumed, false);
});

test("snapshots and subscriber values are detached", async () => {
  const { client } = createClient();
  const controller = controllerModule.createStreamSessionController({ client });
  const snapshots = [];
  const unsubscribe = controller.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });

  await controller.start();
  await controller.startNewStream();
  const first = controller.getSnapshot();

  first.activeSession.streamId = "changed";
  snapshots.at(-1).activeSession.streamId = "also-changed";
  assert.equal(controller.getSnapshot().activeSession.streamId, SESSION.streamId);

  unsubscribe();
  unsubscribe();
  await controller.endActiveStream();
  assert.equal(snapshots.at(-1).activeSession.streamId, "also-changed");
});

test("validates dependencies and rejects invalid client responses", async () => {
  assert.throws(
    () => controllerModule.createStreamSessionController({ client: {} }),
    /getSession, startStream, and endStream/,
  );

  const { client } = createClient({
    getSession() {
      return Promise.resolve({ state: null, result: null });
    },
  });
  const controller = controllerModule.createStreamSessionController({ client });
  const snapshot = await controller.start();

  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.error.code, "INVALID_CLIENT_RESPONSE");
});
