const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CaptureProtocolError,
  EVENT_TYPES,
  MAX_OBSERVED_VARIATIONS,
  MESSAGE_CHANNEL,
  MESSAGE_VERSION,
  createCaptureMessage,
  validateCaptureMessage,
} = require("../extension/shared/capture-protocol.js");

function assertErrorCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof CaptureProtocolError && error.code === code,
  );
}

test("creates an exact detached batch-observation message", () => {
  const event = {
    type: EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44, 43, 42],
  };
  const message = createCaptureMessage(event);

  assert.deepEqual(message, {
    channel: MESSAGE_CHANNEL,
    version: MESSAGE_VERSION,
    event,
  });
  assert.notEqual(message.event, event);
  assert.notEqual(message.event.variationNumbers, event.variationNumbers);

  event.variationNumbers[0] = 999;
  assert.deepEqual(message.event.variationNumbers, [44, 43, 42]);
});

test("creates an exact detached payment-complete message", () => {
  const message = createCaptureMessage({
    type: EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 700,
  });

  assert.deepEqual(message, {
    channel: MESSAGE_CHANNEL,
    version: MESSAGE_VERSION,
    event: {
      type: "payment_complete",
      variationNumber: 44,
      soldPriceCents: 700,
    },
  });
});

test("rejects stream identity, buyer, title, DOM, and time fields", () => {
  const baseObservation = {
    type: EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44],
  };
  const basePayment = {
    type: EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 700,
  };

  for (const forbiddenField of [
    "streamId",
    "buyer",
    "title",
    "element",
    "selector",
    "observedAt",
  ]) {
    assertErrorCode(
      () => createCaptureMessage({ ...baseObservation, [forbiddenField]: "x" }),
      "INVALID_CAPTURE_MESSAGE",
    );
    assertErrorCode(
      () => createCaptureMessage({ ...basePayment, [forbiddenField]: "x" }),
      "INVALID_CAPTURE_MESSAGE",
    );
  }
});

test("rejects malformed observation batches", () => {
  const invalidBatches = [
    [],
    [1, 1],
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    new Array(MAX_OBSERVED_VARIATIONS + 1).fill(0).map((_, index) => index + 1),
  ];

  for (const variationNumbers of invalidBatches) {
    assertErrorCode(
      () =>
        createCaptureMessage({
          type: EVENT_TYPES.OBSERVE_VARIATIONS,
          variationNumbers,
        }),
      "INVALID_CAPTURE_MESSAGE",
    );
  }
});

test("rejects malformed payment values", () => {
  for (const [variationNumber, soldPriceCents] of [
    [0, 700],
    [1.5, 700],
    [44, 0],
    [44, 10.5],
  ]) {
    assertErrorCode(
      () =>
        createCaptureMessage({
          type: EVENT_TYPES.PAYMENT_COMPLETE,
          variationNumber,
          soldPriceCents,
        }),
      "INVALID_CAPTURE_MESSAGE",
    );
  }
});

test("validates the exact envelope, channel, version, and event type", () => {
  const message = createCaptureMessage({
    type: EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44],
  });

  assert.deepEqual(validateCaptureMessage(message), message.event);
  assertErrorCode(
    () => validateCaptureMessage({ ...message, extra: true }),
    "INVALID_CAPTURE_MESSAGE",
  );
  assertErrorCode(
    () => validateCaptureMessage({ ...message, channel: "another-channel" }),
    "INVALID_CAPTURE_MESSAGE",
  );
  assertErrorCode(
    () => validateCaptureMessage({ ...message, version: 2 }),
    "UNSUPPORTED_CAPTURE_MESSAGE_VERSION",
  );
  assertErrorCode(
    () =>
      validateCaptureMessage({
        ...message,
        event: { type: "unknown" },
      }),
    "UNKNOWN_CAPTURE_EVENT",
  );
});
