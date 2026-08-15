const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ReconciliationClientError,
  createReconciliationClient,
} = require("../extension/tagger/reconciliation-client.js");

const protocol = Object.freeze({
  MESSAGE_CHANNEL: "tiktok-live-tracker.reconciliation",
  MESSAGE_VERSION: 1,
  COMMAND_TYPES: Object.freeze({
    GET_STATE: "get_state",
    INITIALIZE_STATE: "initialize_state",
    MAP_VARIATION: "map_variation",
    UNMAP_VARIATION: "unmap_variation",
  }),
});
const inventory = Object.freeze([
  Object.freeze({
    sku: "BLACK-TEE-M",
    name: "Black Tee",
    size: "M",
    quantityReceived: 3,
    unitCostCents: 1200,
  }),
]);

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

function success(state = null, result = null) {
  return { ok: true, data: { state, result } };
}

function createRuntime(handler = () => Promise.resolve(success())) {
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
    assert.ok(error instanceof ReconciliationClientError);
    assert.equal(error.code, code);

    if (message !== undefined) {
      assert.equal(error.message, message);
    }

    return true;
  });
}

test("sends exact versioned envelopes for every employee command", async () => {
  const harness = createRuntime();
  const client = createReconciliationClient({
    runtime: harness.runtime,
    protocol,
  });

  await client.getState();
  await client.initializeState(inventory);
  await client.mapVariation({
    streamId: "stream-1",
    variationNumber: 203,
    sku: "BLACK-TEE-M",
  });
  await client.unmapVariation({
    streamId: "stream-1",
    variationNumber: 203,
  });

  assert.deepEqual(harness.calls, [
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: { type: protocol.COMMAND_TYPES.GET_STATE },
    },
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: {
        type: protocol.COMMAND_TYPES.INITIALIZE_STATE,
        inventory,
      },
    },
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: {
        type: protocol.COMMAND_TYPES.MAP_VARIATION,
        streamId: "stream-1",
        variationNumber: 203,
        sku: "BLACK-TEE-M",
      },
    },
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: protocol.MESSAGE_VERSION,
      command: {
        type: protocol.COMMAND_TYPES.UNMAP_VARIATION,
        streamId: "stream-1",
        variationNumber: 203,
      },
    },
  ]);
});

test("exposes no API that can create payment truth", () => {
  const client = createReconciliationClient({
    runtime: createRuntime().runtime,
    protocol,
  });

  assert.deepEqual(Object.keys(client).sort(), [
    "getState",
    "initializeState",
    "mapVariation",
    "unmapVariation",
  ]);
  assert.equal(client.recordPaymentComplete, undefined);
  assert.ok(Object.isFrozen(client));
});

test("unwraps and detaches strict successful responses", async () => {
  const state = {
    version: 1,
    inventory: [],
    streams: [],
  };
  const result = { status: "initialized" };
  const response = success(state, result);
  const client = createReconciliationClient({
    runtime: createRuntime(() => Promise.resolve(response)).runtime,
    protocol,
  });

  const data = await client.getState();

  assert.deepEqual(data, { state, result });
  assert.notEqual(data, response.data);
  assert.notEqual(data.state, state);
  data.state.inventory.push({ sku: "LOCAL" });
  assert.deepEqual(state.inventory, []);
});

test("preserves a worker's safe typed error", async () => {
  const client = createReconciliationClient({
    runtime: createRuntime(() =>
      Promise.resolve({
        ok: false,
        error: {
          code: "STORAGE_WRITE_FAILED",
          message: "Could not save reconciliation state.",
        },
      }),
    ).runtime,
    protocol,
  });

  await assertClientError(
    () => client.getState(),
    "STORAGE_WRITE_FAILED",
    "Could not save reconciliation state.",
  );
});

test("hides runtime failure details and keeps the queue usable", async () => {
  let callCount = 0;
  const harness = createRuntime(() => {
    callCount += 1;

    if (callCount === 1) {
      return Promise.reject(new Error("sensitive browser details"));
    }

    return Promise.resolve(success());
  });
  const client = createReconciliationClient({
    runtime: harness.runtime,
    protocol,
  });

  await assertClientError(
    () => client.getState(),
    "RUNTIME_MESSAGE_FAILED",
    "Could not reach the reconciliation service.",
  );
  assert.doesNotMatch(
    await client.getState().then(() => "success"),
    /sensitive browser details/,
  );
  assert.equal(harness.calls.length, 2);
});

test("serializes commands through one FIFO runtime queue", async () => {
  const firstResponse = createDeferred();
  const secondResponse = createDeferred();
  const harness = createRuntime((_envelope, index) =>
    index === 0 ? firstResponse.promise : secondResponse.promise,
  );
  const client = createReconciliationClient({
    runtime: harness.runtime,
    protocol,
  });

  const first = client.mapVariation({
    streamId: "stream-1",
    variationNumber: 203,
    sku: "BLACK-TEE-M",
  });
  const second = client.unmapVariation({
    streamId: "stream-1",
    variationNumber: 203,
  });

  await Promise.resolve();
  assert.equal(harness.calls.length, 1);

  firstResponse.resolve(success());
  await first;
  await Promise.resolve();
  assert.equal(harness.calls.length, 2);

  secondResponse.resolve(success());
  await second;
  assert.deepEqual(
    harness.calls.map((envelope) => envelope.command.type),
    [
      protocol.COMMAND_TYPES.MAP_VARIATION,
      protocol.COMMAND_TYPES.UNMAP_VARIATION,
    ],
  );
});

test("snapshots command data before it waits in the FIFO queue", async () => {
  const firstResponse = createDeferred();
  const harness = createRuntime((_envelope, index) =>
    index === 0 ? firstResponse.promise : Promise.resolve(success()),
  );
  const client = createReconciliationClient({
    runtime: harness.runtime,
    protocol,
  });
  const mutableInventory = clone(inventory);
  const blocker = client.getState();
  const initialization = client.initializeState(mutableInventory);

  mutableInventory[0].sku = "MUTATED";
  mutableInventory.push({ sku: "LATE" });
  firstResponse.resolve(success());
  await blocker;
  await initialization;

  assert.deepEqual(harness.calls[1].command.inventory, inventory);
});

test("rejects malformed service responses without exposing their contents", async (t) => {
  const invalidResponses = [
    undefined,
    null,
    [],
    {},
    { ok: "true", data: { state: null, result: null } },
    { ok: true },
    { ok: true, data: { state: null, result: null }, extra: true },
    { ok: true, data: { state: null } },
    { ok: true, data: { state: [], result: null } },
    { ok: true, data: { state: null, result: [] } },
    { ok: false, error: { code: "FAILED", message: "" } },
    {
      ok: false,
      error: { code: "FAILED", message: "No", stack: "secret" },
    },
  ];

  for (const [index, invalidResponse] of invalidResponses.entries()) {
    await t.test(`invalid response ${index + 1}`, async () => {
      const client = createReconciliationClient({
        runtime: createRuntime(() => Promise.resolve(invalidResponse)).runtime,
        protocol,
      });

      await assertClientError(
        () => client.getState(),
        "INVALID_RESPONSE",
        "The reconciliation service returned an invalid response.",
      );
    });
  }
});

test("rejects invalid commands before contacting the runtime", async () => {
  const harness = createRuntime();
  const client = createReconciliationClient({
    runtime: harness.runtime,
    protocol,
  });

  await assertClientError(
    () => client.initializeState([]),
    "INVALID_CLIENT_COMMAND",
  );
  await assertClientError(
    () =>
      client.unmapVariation({
        streamId: "stream-1",
        variationNumber: 203,
        sku: "BLACK-TEE-M",
      }),
    "INVALID_CLIENT_COMMAND",
  );
  await assertClientError(
    () =>
      client.mapVariation({
        streamId: "stream-1",
        variationNumber: 0,
        sku: "BLACK-TEE-M",
      }),
    "INVALID_CLIENT_COMMAND",
  );
  assert.equal(harness.calls.length, 0);
});

test("rejects non-serializable command input without poisoning later commands", async () => {
  const harness = createRuntime();
  const client = createReconciliationClient({
    runtime: harness.runtime,
    protocol,
  });
  const cyclicInventory = clone(inventory);

  cyclicInventory.push(cyclicInventory);
  await assertClientError(
    () => client.initializeState(cyclicInventory),
    "INVALID_CLIENT_COMMAND",
  );
  await client.getState();

  assert.equal(harness.calls.length, 1);
  assert.equal(
    harness.calls[0].command.type,
    protocol.COMMAND_TYPES.GET_STATE,
  );
});

test("validates runtime and protocol dependencies immediately", () => {
  const {
    UNMAP_VARIATION: _unmapVariation,
    ...commandTypesWithoutUnmap
  } = protocol.COMMAND_TYPES;

  assert.throws(() => createReconciliationClient(), /options are required/);
  assert.throws(
    () => createReconciliationClient({ runtime: {}, protocol }),
    /runtime must provide sendMessage/,
  );
  assert.throws(
    () =>
      createReconciliationClient({
        runtime: createRuntime().runtime,
        protocol: {
          ...protocol,
          COMMAND_TYPES: { GET_STATE: "get_state" },
        },
      }),
    /missing required command types/,
  );
  assert.throws(
    () =>
      createReconciliationClient({
        runtime: createRuntime().runtime,
        protocol: {
          ...protocol,
          COMMAND_TYPES: commandTypesWithoutUnmap,
        },
      }),
    /missing required command types/,
  );
});
