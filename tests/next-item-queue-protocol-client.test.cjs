const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require(
  "../extension/shared/next-item-queue-protocol.js"
);
const clientModule = require(
  "../extension/tagger/next-item-queue-client.js"
);

const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";

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
