const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const protocol = require("../extension/shared/capture-protocol.js");
const {
  CaptureClientError,
  createCaptureClient,
} = require("../extension/capture/capture-client.js");

const ACCEPTED = Object.freeze({
  ok: true,
  data: Object.freeze({ status: "accepted" }),
});

function createRuntime(handler = async () => ACCEPTED) {
  const calls = [];

  return {
    calls,
    async sendMessage(message) {
      calls.push(message);
      return handler(message, calls.length - 1);
    },
  };
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

test("sends one strict batch observation envelope without caller-owned data", async () => {
  const runtime = createRuntime();
  const client = createCaptureClient({ protocol, runtime });
  const variationNumbers = [44, 43, 42];
  const request = client.observeVariations(variationNumbers);

  variationNumbers.push(999);

  assert.deepEqual(await request, { status: "accepted" });
  assert.deepEqual(runtime.calls, [
    {
      channel: "tiktok-live-tracker.capture",
      version: 1,
      event: {
        type: "observe_variations",
        variationNumbers: [44, 43, 42],
      },
    },
  ]);
});

test("sends only the sanitized Attributed GMV display", async () => {
  const runtime = createRuntime();
  const client = createCaptureClient({ protocol, runtime });

  await client.observeAttributedGmv("$4.64K");

  assert.deepEqual(runtime.calls[0].event, {
    type: "observe_attributed_gmv",
    attributedGmvDisplay: "$4.64K",
  });
  assert.doesNotMatch(
    JSON.stringify(runtime.calls[0].event),
    /buyer|title|element|selector|observedAt|streamId/i,
  );
});

test("sends only the live bidding variation number", async () => {
  const runtime = createRuntime();
  const client = createCaptureClient({ protocol, runtime });

  await client.observeBiddingVariation(252);

  assert.deepEqual(runtime.calls[0].event, {
    type: "observe_bidding_variation",
    variationNumber: 252,
  });
  assert.doesNotMatch(
    JSON.stringify(runtime.calls[0].event),
    /title|product|buyer|bidAmount|bidCount|element|selector|streamId/i,
  );
});

test("sends only variation and price for a completed payment", async () => {
  const runtime = createRuntime();
  const client = createCaptureClient({ protocol, runtime });

  await client.recordPaymentComplete({
    variationNumber: 44,
    soldPriceCents: 700,
  });

  assert.deepEqual(runtime.calls[0].event, {
    type: "payment_complete",
    variationNumber: 44,
    soldPriceCents: 700,
  });
  assert.equal(Object.hasOwn(runtime.calls[0].event, "streamId"), false);
  assert.equal(Object.hasOwn(runtime.calls[0].event, "observedAt"), false);
  assert.equal(Object.hasOwn(runtime.calls[0].event, "buyer"), false);
});

test("sends only sanitized detached payment-status facts", async () => {
  const runtime = createRuntime();
  const client = createCaptureClient({ protocol, runtime });
  const statuses = [
    {
      variationNumber: 44,
      observedPaymentStatus:
        protocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    },
    {
      variationNumber: 43,
      observedPaymentStatus:
        protocol.OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
    },
    {
      variationNumber: 42,
      observedPaymentStatus:
        protocol.OBSERVED_PAYMENT_STATUSES.CANCELED,
    },
  ];
  const request = client.observePaymentStatuses(statuses);

  statuses[0].variationNumber = 999;
  statuses[0].observedPaymentStatus = "private raw text";

  assert.deepEqual(await request, { status: "accepted" });
  assert.deepEqual(runtime.calls[0].event, {
    type: "observe_payment_statuses",
    statuses: [
      {
        variationNumber: 44,
        observedPaymentStatus: "payment_processing",
      },
      {
        variationNumber: 43,
        observedPaymentStatus: "unrecognized",
      },
      {
        variationNumber: 42,
        observedPaymentStatus: "canceled",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(runtime.calls[0]),
    /private raw text|statusText|buyer|title|element|selector/i,
  );
});

test("serializes variation, status, then payment while the first send waits", async () => {
  const first = deferred();
  const runtime = createRuntime((_message, index) =>
    index === 0 ? first.promise : ACCEPTED,
  );
  const client = createCaptureClient({ protocol, runtime });

  const observation = client.observeVariations([44]);
  const statusObservation = client.observePaymentStatuses([
    {
      variationNumber: 44,
      observedPaymentStatus:
        protocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    },
  ]);
  const payment = client.recordPaymentComplete({
    variationNumber: 44,
    soldPriceCents: 700,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].event.type, "observe_variations");

  first.resolve(ACCEPTED);
  await observation;
  await statusObservation;
  await payment;

  assert.deepEqual(
    runtime.calls.map(({ event }) => event.type),
    [
      "observe_variations",
      "observe_payment_statuses",
      "payment_complete",
    ],
  );
});

test("a rejected request does not poison the FIFO queue", async () => {
  const runtime = createRuntime((_message, index) => {
    if (index === 0) {
      return {
        ok: false,
        error: {
          code: "NO_ACTIVE_STREAM",
          message: "No active tracker stream is available.",
        },
      };
    }

    return ACCEPTED;
  });
  const client = createCaptureClient({ protocol, runtime });
  const first = client.observeVariations([44]);
  const second = client.observeVariations([45]);

  await assert.rejects(
    first,
    (error) =>
      error instanceof CaptureClientError &&
      error.code === "NO_ACTIVE_STREAM",
  );
  assert.deepEqual(await second, { status: "accepted" });
  assert.equal(runtime.calls.length, 2);
});

test("rejects malformed success, error, and transport responses", async () => {
  for (const response of [
    undefined,
    { ok: true, data: { status: "accepted", extra: true } },
    { ok: true, data: { status: "observed" } },
    { ok: false, error: { code: "NO_ACTIVE_STREAM" } },
  ]) {
    const client = createCaptureClient({
      protocol,
      runtime: createRuntime(async () => response),
    });

    await assert.rejects(
      client.observeVariations([44]),
      (error) =>
        error instanceof CaptureClientError &&
        error.code === "INVALID_CAPTURE_RESPONSE",
    );
  }

  const transportClient = createCaptureClient({
    protocol,
    runtime: createRuntime(async () => {
      throw new Error("private transport detail");
    }),
  });
  await assert.rejects(
    transportClient.observeVariations([44]),
    (error) =>
      error instanceof CaptureClientError &&
      error.code === "CAPTURE_TRANSPORT_ERROR" &&
      !error.message.includes("private transport detail"),
  );
});

test("fails before runtime delivery when event input is invalid", () => {
  const runtime = createRuntime();
  const client = createCaptureClient({ protocol, runtime });

  assert.throws(() => client.observeVariations([]), /between 1 and 1000/i);
  assert.throws(() => client.observeVariations([44, 44]), /unique/i);
  assert.throws(
    () =>
      client.observePaymentStatuses([
        { variationNumber: 44, observedPaymentStatus: "Payment complete" },
      ]),
    /not supported for capture/i,
  );
  assert.throws(
    () => client.recordPaymentComplete({ variationNumber: 0, soldPriceCents: 1 }),
    /positive safe integer/i,
  );
  assert.throws(
    () => client.observeAttributedGmv("$1000.00"),
    /sanitized exact or compact USD display/i,
  );
  assert.equal(runtime.calls.length, 0);
});

test("requires explicit protocol/runtime dependencies and remains storage-free", () => {
  assert.throws(
    () => createCaptureClient({ protocol, runtime: null }),
    /runtime with sendMessage/i,
  );
  assert.throws(
    () => createCaptureClient({ protocol: null, runtime: createRuntime() }),
    /capture protocol/i,
  );

  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "capture", "capture-client.js"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /chrome\.storage|localStorage|sessionStorage|\bfetch\s*\(|XMLHttpRequest|sendBeacon/,
  );
});
