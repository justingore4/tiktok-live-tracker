const assert = require("node:assert/strict");
const test = require("node:test");

const {
  StreamSessionClientError,
  createStreamSessionClient,
} = require("../extension/tagger/stream-session-client.js");

const protocol = Object.freeze({
  MESSAGE_CHANNEL: "tiktok-live-tracker.stream-session",
  MESSAGE_VERSION: 1,
  COMMAND_TYPES: Object.freeze({
    GET_STREAM_SESSION: "get_stream_session",
    START_STREAM: "start_stream",
    END_STREAM: "end_stream",
  }),
});
const STREAM_ID =
  "local-stream:11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-08-08T12:00:00.000Z";

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

function state(active = true) {
  return {
    version: 1,
    activeSession: active
      ? {
          streamId: STREAM_ID,
          startedAt: STARTED_AT,
          identitySource: "local_session",
        }
      : null,
  };
}

function success(commandType) {
  if (commandType === protocol.COMMAND_TYPES.GET_STREAM_SESSION) {
    return { ok: true, data: { state: state(false), result: null } };
  }

  if (commandType === protocol.COMMAND_TYPES.START_STREAM) {
    return {
      ok: true,
      data: { state: state(), result: { status: "started" } },
    };
  }

  return {
    ok: true,
    data: { state: state(false), result: { status: "ended" } },
  };
}

function createRuntime(handler = (envelope) =>
  Promise.resolve(success(envelope.command.type))) {
  const calls = [];

  return {
    calls,
    runtime: {
      sendMessage(envelope) {
        calls.push(clone(envelope));
        return handler(envelope, calls.length - 1);
      },
    },
  };
}

async function assertClientError(action, code, message) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof StreamSessionClientError);
    assert.equal(error.code, code);

    if (message !== undefined) {
      assert.equal(error.message, message);
    }

    return true;
  });
}

test("sends exact versioned envelopes for stream lifecycle commands", async () => {
  const harness = createRuntime();
  const client = createStreamSessionClient({
    runtime: harness.runtime,
    protocol,
  });

  await client.getSession();
  await client.startStream({
    streamId: "caller-cannot-inject-this",
    startedAt: "caller-cannot-inject-this",
  });
  await client.endStream({ streamId: `  ${STREAM_ID}  ` });

  assert.deepEqual(harness.calls, [
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: { type: protocol.COMMAND_TYPES.GET_STREAM_SESSION },
    },
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: { type: protocol.COMMAND_TYPES.START_STREAM },
    },
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: {
        type: protocol.COMMAND_TYPES.END_STREAM,
        streamId: STREAM_ID,
      },
    },
  ]);
});

test("exposes only the employee stream lifecycle API", () => {
  const client = createStreamSessionClient({
    runtime: createRuntime().runtime,
    protocol,
  });

  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Object.keys(client).sort(), [
    "endStream",
    "getSession",
    "startStream",
  ]);
  assert.equal(client.storage, undefined);
  assert.equal(client.recordPaymentComplete, undefined);
  assert.equal(client.setStreamId, undefined);
  assert.equal(client.endStreamWithoutReport, undefined);
});

test("normal End rejects the removed bypass status", async () => {
  const client = createStreamSessionClient({
    protocol,
    runtime: createRuntime(() => Promise.resolve({
      ok: true,
      data: {
        state: state(false),
        result: { status: "ended_without_report", reportId: null, reportLifecycleStatus: null },
      },
    })).runtime,
  });
  await assertClientError(client.endStream({ streamId: STREAM_ID }), "INVALID_RESPONSE");
});

test("unwraps and detaches strict successful responses", async () => {
  const workerResponse = {
    ok: true,
    data: { state: state(), result: { status: "already_active" } },
  };
  const client = createStreamSessionClient({
    runtime: createRuntime(() => Promise.resolve(workerResponse)).runtime,
    protocol,
  });
  const result = await client.startStream();

  assert.deepEqual(result, workerResponse.data);
  assert.notEqual(result, workerResponse.data);
  assert.notEqual(result.state, workerResponse.data.state);
  assert.notEqual(
    result.state.activeSession,
    workerResponse.data.state.activeSession,
  );

  result.state.activeSession.streamId = "mutated";
  result.result.status = "mutated";
  assert.equal(workerResponse.data.state.activeSession.streamId, STREAM_ID);
  assert.equal(workerResponse.data.result.status, "already_active");
});

test("preserves a worker's safe typed error", async () => {
  const client = createStreamSessionClient({
    runtime: createRuntime(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: "ACTIVE_STREAM_MISMATCH",
          message: "Another stream is active.",
        },
      })).runtime,
    protocol,
  });

  await assertClientError(
    () => client.endStream({ streamId: STREAM_ID }),
    "ACTIVE_STREAM_MISMATCH",
    "Another stream is active.",
  );
});

test("hides runtime failure details and keeps the FIFO usable", async () => {
  let callCount = 0;
  const harness = createRuntime((envelope) => {
    callCount += 1;

    if (callCount === 1) {
      return Promise.reject(new Error("sensitive runtime detail"));
    }

    return Promise.resolve(success(envelope.command.type));
  });
  const client = createStreamSessionClient({
    runtime: harness.runtime,
    protocol,
  });

  await assertClientError(
    () => client.getSession(),
    "RUNTIME_MESSAGE_FAILED",
    "Could not reach the stream-session service.",
  );
  const second = await client.startStream();

  assert.equal(second.result.status, "started");
  assert.equal(harness.calls.length, 2);
});

test("serializes commands through one FIFO runtime queue", async () => {
  const first = createDeferred();
  const second = createDeferred();
  const harness = createRuntime((_envelope, index) =>
    index === 0 ? first.promise : second.promise);
  const client = createStreamSessionClient({
    runtime: harness.runtime,
    protocol,
  });

  const getPromise = client.getSession();
  const startPromise = client.startStream();
  await Promise.resolve();

  assert.equal(harness.calls.length, 1);
  first.resolve(success(protocol.COMMAND_TYPES.GET_STREAM_SESSION));
  await getPromise;
  await Promise.resolve();
  assert.equal(harness.calls.length, 2);

  second.resolve(success(protocol.COMMAND_TYPES.START_STREAM));
  assert.equal((await startPromise).result.status, "started");
});

test("snapshots an end command before it waits in the FIFO", async () => {
  const first = createDeferred();
  const harness = createRuntime((envelope, index) =>
    index === 0
      ? first.promise
      : Promise.resolve(success(envelope.command.type)));
  const client = createStreamSessionClient({
    runtime: harness.runtime,
    protocol,
  });
  const options = { streamId: STREAM_ID };

  const getPromise = client.getSession();
  const endPromise = client.endStream(options);
  options.streamId =
    "local-stream:22222222-2222-4222-8222-222222222222";
  await Promise.resolve();

  first.resolve(success(protocol.COMMAND_TYPES.GET_STREAM_SESSION));
  await getPromise;
  await endPromise;

  assert.equal(harness.calls[1].command.streamId, STREAM_ID);
});

test("accepts an idempotent already-ended response", async () => {
  const harness = createRuntime(() =>
    Promise.resolve({
      ok: true,
      data: {
        state: state(false),
        result: { status: "already_ended" },
      },
    }));
  const client = createStreamSessionClient({
    runtime: harness.runtime,
    protocol,
  });

  const response = await client.endStream({ streamId: STREAM_ID });

  assert.equal(response.result.status, "already_ended");
  assert.equal(response.state.activeSession, null);
});

test("rejects malformed service responses without exposing their contents", async (t) => {
  const malformedResponses = [
    undefined,
    { ok: "yes", data: { state: state(false), result: null } },
    { ok: true, data: { state: state(false), result: null }, extra: true },
    { ok: true, data: { state: state(false) } },
    { ok: true, data: { state: null, result: null } },
    {
      ok: true,
      data: {
        state: { ...state(false), version: 2 },
        result: null,
      },
    },
    {
      ok: true,
      data: {
        state: { ...state(false), extra: true },
        result: null,
      },
    },
    {
      ok: true,
      data: {
        state: {
          version: 1,
          activeSession: {
            ...state().activeSession,
            identitySource: "verified_tiktok_stream",
          },
        },
        result: null,
      },
    },
    {
      ok: true,
      data: {
        state: {
          version: 1,
          activeSession: {
            ...state().activeSession,
            streamId: "caller-stream-id",
          },
        },
        result: null,
      },
    },
    { ok: false, error: { code: "BAD" } },
    {
      ok: false,
      error: { code: "BAD", message: "unsafe", details: "secret" },
    },
  ];

  for (const [index, response] of malformedResponses.entries()) {
    await t.test(`malformed response ${index + 1}`, async () => {
      const client = createStreamSessionClient({
        runtime: createRuntime(() => Promise.resolve(response)).runtime,
        protocol,
      });

      await assertClientError(
        () => client.getSession(),
        "INVALID_RESPONSE",
        "The stream-session service returned an invalid response.",
      );
    });
  }
});

test("rejects invalid end commands before contacting the runtime", async () => {
  const harness = createRuntime();
  const client = createStreamSessionClient({
    runtime: harness.runtime,
    protocol,
  });
  const invalidOptions = [
    undefined,
    null,
    {},
    { streamId: "" },
    { streamId: "   " },
    { streamId: STREAM_ID, extra: true },
  ];

  for (const options of invalidOptions) {
    await assertClientError(
      () => client.endStream(options),
      "INVALID_CLIENT_COMMAND",
    );
  }

  assert.equal(harness.calls.length, 0);
});

test("validates runtime and protocol dependencies immediately", () => {
  assert.throws(
    () => createStreamSessionClient(),
    /Stream-session client options are required/,
  );
  assert.throws(
    () => createStreamSessionClient({ runtime: {}, protocol }),
    /runtime must provide sendMessage/,
  );
  assert.throws(
    () =>
      createStreamSessionClient({
        runtime: createRuntime().runtime,
        protocol: { ...protocol, MESSAGE_VERSION: 0 },
      }),
    /valid stream-session message protocol/,
  );
  assert.throws(
    () =>
      createStreamSessionClient({
        runtime: createRuntime().runtime,
        protocol: {
          ...protocol,
          COMMAND_TYPES: {
            ...protocol.COMMAND_TYPES,
            END_STREAM: protocol.COMMAND_TYPES.START_STREAM,
          },
        },
      }),
    /missing required command types/,
  );
});
