const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require(
  "../extension/shared/next-item-queue-protocol.js"
);
const clientModule = require(
  "../extension/tagger/next-item-queue-client.js"
);

const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";
const QUEUE_TOKEN = "11111111-1111-4111-8111-111111111111";

function clearOptions(overrides = {}) {
  return {
    expectedStreamId: STREAM_ID,
    expectedQueueToken: QUEUE_TOKEN,
    sku: "TEE-L",
    ...overrides,
  };
}

test("next-item queue protocol keeps GET, map-current, toggle, and notification exact", () => {
  const getMessage = protocol.createNextItemQueueMessage();

  assert.deepEqual(getMessage, {
    channel: "tiktok-live-tracker.next-item-queue",
    version: 1,
    command: { type: "get_queue" },
  });
  assert.deepEqual(protocol.validateNextItemQueueMessage(getMessage), {
    type: "get_queue",
  });

  const toggleMessage = protocol.createNextItemQueueMessage({
    type: protocol.COMMAND_TYPES.TOGGLE_QUEUE,
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  });

  assert.deepEqual(protocol.validateNextItemQueueMessage(toggleMessage), {
    type: "toggle_queue",
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  });

  const mapCurrentMessage = protocol.createNextItemQueueMessage({
    type: protocol.COMMAND_TYPES.MAP_CURRENT,
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  });

  assert.deepEqual(protocol.validateNextItemQueueMessage(mapCurrentMessage), {
    type: "map_current",
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  });

  const notification = protocol.createQueueChangedNotification();
  assert.deepEqual(notification, {
    channel: "tiktok-live-tracker.next-item-queue",
    version: 1,
    event: { type: "queue_changed" },
  });
  assert.equal(protocol.isQueueChangedNotification(notification), true);
  assert.equal(
    protocol.isQueueChangedNotification({ ...notification, sku: "TEE-L" }),
    false,
  );
  assert.equal(
    protocol.isQueueChangedNotification({
      ...notification,
      event: { type: "queue_changed", sku: "TEE-L" },
    }),
    false,
  );
});

test("queue protocol adds exact snapshot and explicit-clear commands without changing old contracts", () => {
  assert.deepEqual(protocol.createNextItemQueueMessage({ type: "get_queue_snapshot" }), {
    channel: protocol.MESSAGE_CHANNEL,
    version: 1,
    command: { type: "get_queue_snapshot" },
  });
  const command = { type: "clear_queue", ...clearOptions() };
  assert.deepEqual(
    protocol.validateNextItemQueueMessage(protocol.createNextItemQueueMessage(command)),
    command,
  );
  for (const invalid of [
    { type: "get_queue_snapshot", sku: "TEE-L" },
    { ...command, expectedVariationNumber: 203 },
    { ...command, expectedQueueToken: null },
    { ...command, expectedQueueToken: "" },
    { ...command, expectedQueueToken: 1 },
    { ...command, expectedQueueToken: "unverified-queue" },
    { ...command, expectedQueueToken: `${QUEUE_TOKEN} ` },
    { ...command, expectedQueueToken: "11111111-1111-1111-8111-111111111111" },
    { ...command, expectedStreamId: "" },
    { ...command, sku: " TEE-L" },
    { ...command, extra: true },
  ]) {
    assert.throws(
      () => protocol.createNextItemQueueMessage(invalid),
      (error) => error.code === "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
    );
  }
  for (const key of ["expectedStreamId", "expectedQueueToken", "sku"]) {
    const invalid = { ...command };
    delete invalid[key];
    assert.throws(
      () => protocol.createNextItemQueueMessage(invalid),
      (error) => error.code === "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
    );
  }
});

test("queue client reads strict generation snapshots and sends a detached explicit clear", async () => {
  const calls = [];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        return {
          ok: true,
          data: message.command.type === "get_queue_snapshot"
            ? { queuedSku: "TEE-L", queueToken: QUEUE_TOKEN }
            : { status: "cleared", queuedSku: null },
        };
      },
    },
  });
  assert.deepEqual(await client.getQueueSnapshot(), {
    queuedSku: "TEE-L", queueToken: QUEUE_TOKEN,
  });
  const options = clearOptions();
  const clear = client.clearQueue(options);
  options.sku = "OTHER";
  options.expectedQueueToken = "modified";
  assert.deepEqual(await clear, { status: "cleared", queuedSku: null });
  assert.deepEqual(calls, [
    protocol.createNextItemQueueMessage({ type: "get_queue_snapshot" }),
    protocol.createNextItemQueueMessage({ type: "clear_queue", ...clearOptions() }),
  ]);
});

test("queue client rejects malformed snapshot pairs and malformed clear acknowledgements", async () => {
  const invalidSnapshots = [
    {},
    { queuedSku: "TEE-L" },
    { queueToken: QUEUE_TOKEN },
    { queuedSku: null, queueToken: QUEUE_TOKEN },
    { queuedSku: "TEE-L", queueToken: null },
    { queuedSku: "TEE-L", queueToken: "" },
    { queuedSku: "TEE-L", queueToken: 1 },
    { queuedSku: "TEE-L", queueToken: "old-generation" },
    { queuedSku: " TEE-L", queueToken: QUEUE_TOKEN },
    { queuedSku: null, queueToken: null, extra: true },
    { queuedSku: "TEE-L", queueToken: QUEUE_TOKEN, streamId: STREAM_ID },
  ];
  const invalidClearResults = [
    {},
    { status: "queued", queuedSku: "TEE-L" },
    { status: "mapped_current", queuedSku: null },
    { status: "unchanged", queuedSku: null },
    { status: "cleared", queuedSku: "TEE-L" },
    { status: "cleared" },
    { status: "cleared", queuedSku: null, queueToken: null },
    { status: "cleared", queuedSku: null, extra: true },
  ];
  for (const [method, data] of [
    ...invalidSnapshots.map((data) => ["getQueueSnapshot", data]),
    ...invalidClearResults.map((data) => ["clearQueue", data]),
  ]) {
    const client = clientModule.createNextItemQueueClient({
      protocol,
      runtime: { async sendMessage() { return { ok: true, data }; } },
    });
    await assert.rejects(
      client[method](clearOptions()),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
  const emptyClient = clientModule.createNextItemQueueClient({
    protocol,
    runtime: { async sendMessage() { return { ok: true, data: { queuedSku: null, queueToken: null } }; } },
  });
  assert.deepEqual(await emptyClient.getQueueSnapshot(), { queuedSku: null, queueToken: null });
});

test("queue client rejects invalid clear options locally and never falls back to toggle or mapping", async () => {
  const calls = [];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: { async sendMessage(message) { calls.push(message); } },
  });
  for (const invalid of [
    undefined,
    null,
    {},
    clearOptions({ expectedStreamId: "" }),
    clearOptions({ sku: " " }),
    clearOptions({ expectedQueueToken: null }),
    clearOptions({ expectedQueueToken: "" }),
    clearOptions({ expectedQueueToken: "fake" }),
    { ...clearOptions(), expectedVariationNumber: 203 },
    { ...clearOptions(), extra: true },
  ]) {
    await assert.rejects(client.clearQueue(invalid), (error) => error.code === "INVALID_CLIENT_COMMAND");
  }
  assert.deepEqual(calls, []);
});

test("queue client preserves stale-clear errors and does not automatically retry a new generation", async () => {
  const calls = [];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      async sendMessage(message) {
        calls.push(message.command);
        if (message.command.type === "clear_queue") {
          return { ok: false, error: { code: "QUEUE_CHANGED", message: "Review the current queue." } };
        }
        return { ok: true, data: { queuedSku: "TEE-M", queueToken: QUEUE_TOKEN } };
      },
    },
  });
  await assert.rejects(
    client.clearQueue(clearOptions()),
    (error) => error.code === "QUEUE_CHANGED" && error.message === "Review the current queue.",
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(await client.getQueueSnapshot(), { queuedSku: "TEE-M", queueToken: QUEUE_TOKEN });
  assert.deepEqual(calls.map((command) => command.type), ["clear_queue", "get_queue_snapshot"]);
});

test("next-item queue protocol rejects extra fields and unsafe mutation values", () => {
  assert.throws(
    () =>
      protocol.validateNextItemQueueMessage({
        ...protocol.createNextItemQueueMessage(),
        queuedSku: "TEE-L",
      }),
    (error) =>
      error instanceof protocol.NextItemQueueProtocolError &&
      error.code === "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
  );

  for (const command of [
    {
      type: "toggle_queue",
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 0,
      sku: "TEE-L",
    },
    {
      type: "toggle_queue",
      expectedStreamId: ` ${STREAM_ID}`,
      expectedVariationNumber: 203,
      sku: "TEE-L",
    },
    {
      type: "toggle_queue",
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: " TEE-L",
    },
    {
      type: "toggle_queue",
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: "TEE-L",
      buyer: "must not cross the boundary",
    },
    {
      type: "map_current",
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: "TEE-L",
      buyer: "must not cross the boundary",
    },
  ]) {
    assert.throws(
      () => protocol.createNextItemQueueMessage(command),
      (error) =>
        error instanceof protocol.NextItemQueueProtocolError &&
        error.code === "INVALID_NEXT_ITEM_QUEUE_MESSAGE",
    );
  }
});

test("next-item queue client sends strict GET, map-current, and toggle commands", async () => {
  const calls = [];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      async sendMessage(message) {
        calls.push(message);

        if (message.command.type === "get_queue") {
          return { ok: true, data: { queuedSku: null } };
        }

        if (message.command.type === "map_current") {
          return {
            ok: true,
            data: { status: "mapped_current", sku: message.command.sku },
          };
        }

        return {
          ok: true,
          data: { status: "queued", queuedSku: message.command.sku },
        };
      },
    },
  });

  assert.deepEqual(await client.getQueue(), { queuedSku: null });
  assert.deepEqual(
    await client.mapCurrent({
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: "TEE-L",
    }),
    { status: "mapped_current", sku: "TEE-L" },
  );
  assert.deepEqual(
    await client.toggleQueue({
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: "TEE-L",
    }),
    { status: "queued", queuedSku: "TEE-L" },
  );
  assert.deepEqual(calls, [
    protocol.createNextItemQueueMessage(),
    protocol.createNextItemQueueMessage({
      type: "map_current",
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: "TEE-L",
    }),
    protocol.createNextItemQueueMessage({
      type: "toggle_queue",
      expectedStreamId: STREAM_ID,
      expectedVariationNumber: 203,
      sku: "TEE-L",
    }),
]);
});

test("next-item queue client accepts only strict map-current results", async () => {
  const responses = [
    { ok: true, data: { status: "mapped_current", sku: "TEE-L" } },
    { ok: true, data: { status: "unmapped_current", sku: "TEE-L" } },
  ];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      async sendMessage() {
        return responses.shift();
      },
    },
  });
  const options = {
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  };

  assert.deepEqual(await client.mapCurrent(options), {
    status: "mapped_current",
    sku: "TEE-L",
  });
  assert.deepEqual(await client.mapCurrent(options), {
    status: "unmapped_current",
    sku: "TEE-L",
  });
});

test("next-item queue client rejects malformed map-current results", async () => {
  for (const response of [
    { ok: true, data: { status: "queued", sku: "TEE-L" } },
    { ok: true, data: { status: "unchanged", sku: "TEE-L" } },
    { ok: true, data: { status: "mapped_current", sku: "TEE-M" } },
    { ok: true, data: { status: "unmapped_current", sku: "TEE-M" } },
    {
      ok: true,
      data: { status: "mapped_current", sku: "TEE-L", queuedSku: null },
    },
  ]) {
    const client = clientModule.createNextItemQueueClient({
      protocol,
      runtime: { async sendMessage() { return response; } },
    });

    await assert.rejects(
      () =>
        client.mapCurrent({
          expectedStreamId: STREAM_ID,
          expectedVariationNumber: 203,
          sku: "TEE-L",
        }),
      (error) =>
        error instanceof clientModule.NextItemQueueClientError &&
        error.code === "INVALID_RESPONSE",
    );
  }
});

test("next-item queue client accepts mapped-current responses with a preserved queue", async () => {
  const responses = [
    {
      ok: true,
      data: { status: "mapped_current", queuedSku: null },
    },
    {
      ok: true,
      data: { status: "mapped_current", queuedSku: "TEE-M" },
    },
  ];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      async sendMessage() {
        return responses.shift();
      },
    },
  });
  const options = {
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  };

  assert.deepEqual(await client.toggleQueue(options), {
    status: "mapped_current",
    queuedSku: null,
  });
  assert.deepEqual(await client.toggleQueue(options), {
    status: "mapped_current",
    queuedSku: "TEE-M",
  });
});

test("next-item queue client serializes commands through one FIFO", async () => {
  const started = [];
  const releases = [];
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      sendMessage(message) {
        started.push(message.command.type);
        return new Promise((resolve) => {
          releases.push(() =>
            resolve(
              message.command.type === "get_queue"
                ? { ok: true, data: { queuedSku: null } }
                : {
                    ok: true,
                    data: {
                      status: "queued",
                      queuedSku: message.command.sku,
                    },
                  },
            ),
          );
        });
      },
    },
  });
  const first = client.getQueue();
  const second = client.toggleQueue({
    expectedStreamId: STREAM_ID,
    expectedVariationNumber: 203,
    sku: "TEE-L",
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ["get_queue"]);
  releases.shift()();
  await first;
  await Promise.resolve();
  assert.deepEqual(started, ["get_queue", "toggle_queue"]);
  releases.shift()();
  await second;
});

test("next-item queue client fails closed on malformed success and error responses", async () => {
  const responses = [
    { ok: true, data: { queuedSku: "TEE-L", extra: true } },
    { ok: true, data: { status: "cleared", queuedSku: "TEE-L" } },
    { ok: true, data: { status: "queued", queuedSku: "OTHER-SKU" } },
    {
      ok: true,
      data: {
        status: "mapped_current",
        queuedSku: " invalid-queue-sku",
      },
    },
    { ok: false, error: { code: "FAILED", message: "No", detail: true } },
  ];

  for (const [index, response] of responses.entries()) {
    const client = clientModule.createNextItemQueueClient({
      protocol,
      runtime: { async sendMessage() { return response; } },
    });
    const operation = index === 0 || index === 4
      ? () => client.getQueue()
      : () =>
          client.toggleQueue({
            expectedStreamId: STREAM_ID,
            expectedVariationNumber: 203,
            sku: "TEE-L",
          });

    await assert.rejects(
      operation,
      (error) =>
        error instanceof clientModule.NextItemQueueClientError &&
        error.code === "INVALID_RESPONSE",
    );
  }
});

test("next-item queue client preserves typed service failures after prior FIFO failure", async () => {
  let callCount = 0;
  const client = clientModule.createNextItemQueueClient({
    protocol,
    runtime: {
      async sendMessage() {
        callCount += 1;

        if (callCount === 1) {
          throw new Error("worker unavailable");
        }

        return {
          ok: false,
          error: {
            code: "CURRENT_VARIATION_CHANGED",
            message: "The live variation changed.",
          },
        };
      },
    },
  });

  await assert.rejects(
    () => client.getQueue(),
    (error) =>
      error instanceof clientModule.NextItemQueueClientError &&
      error.code === "RUNTIME_MESSAGE_FAILED",
  );
  await assert.rejects(
    () =>
      client.toggleQueue({
        expectedStreamId: STREAM_ID,
        expectedVariationNumber: 203,
        sku: "TEE-L",
      }),
    (error) =>
      error instanceof clientModule.NextItemQueueClientError &&
      error.code === "CURRENT_VARIATION_CHANGED",
  );
});
