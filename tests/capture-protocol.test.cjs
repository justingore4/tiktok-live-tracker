const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CaptureProtocolError,
  EVENT_TYPES,
  MAX_OBSERVED_PAYMENT_STATUSES,
  MAX_OBSERVED_VARIATIONS,
  MESSAGE_CHANNEL,
  MESSAGE_VERSION,
  OBSERVED_PAYMENT_STATUSES,
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

test("creates an exact sanitized Attributed GMV observation message", () => {
  const message = createCaptureMessage({
    type: EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
    attributedGmvDisplay: "$4.64K",
  });

  assert.deepEqual(message, {
    channel: MESSAGE_CHANNEL,
    version: MESSAGE_VERSION,
    event: {
      type: "observe_attributed_gmv",
      attributedGmvDisplay: "$4.64K",
    },
  });
});

test("creates an exact bidding-variation observation message", () => {
  const message = createCaptureMessage({
    type: EVENT_TYPES.OBSERVE_BIDDING_VARIATION,
    variationNumber: 252,
  });

  assert.deepEqual(message, {
    channel: MESSAGE_CHANNEL,
    version: MESSAGE_VERSION,
    event: {
      type: "observe_bidding_variation",
      variationNumber: 252,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(message.event),
    /title|product|buyer|bidAmount|bidCount|element|selector|streamId/i,
  );
});

test("rejects malformed or widened bidding-variation observations", () => {
  for (const event of [
    { type: "observe_bidding_variation", variationNumber: 0 },
    { type: "observe_bidding_variation", variationNumber: 1.5 },
    { type: "observe_bidding_variation", variationNumber: "252" },
    {
      type: "observe_bidding_variation",
      variationNumber: 252,
      title: "must not cross the capture boundary",
    },
  ]) {
    assert.throws(
      () => createCaptureMessage(event),
      /invalid shape|positive safe integer/i,
    );
  }
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

test("creates an exact detached batch payment-status message", () => {
  const statuses = [
    {
      variationNumber: 44,
      observedPaymentStatus:
        OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    },
    {
      variationNumber: 43,
      observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    },
    {
      variationNumber: 42,
      observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.CANCELED,
    },
  ];
  const message = createCaptureMessage({
    type: EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
    statuses,
  });

  assert.deepEqual(message, {
    channel: MESSAGE_CHANNEL,
    version: MESSAGE_VERSION,
    event: {
      type: "observe_payment_statuses",
      statuses,
    },
  });
  assert.notEqual(message.event.statuses, statuses);
  assert.notEqual(message.event.statuses[0], statuses[0]);

  statuses[0].variationNumber = 999;
  assert.equal(message.event.statuses[0].variationNumber, 44);
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
  const baseStatuses = {
    type: EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
    statuses: [
      {
        variationNumber: 44,
        observedPaymentStatus:
          OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
    ],
  };
  const baseAttributedGmv = {
    type: EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
    attributedGmvDisplay: "$4.64K",
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
    assertErrorCode(
      () => createCaptureMessage({ ...baseStatuses, [forbiddenField]: "x" }),
      "INVALID_CAPTURE_MESSAGE",
    );
    assertErrorCode(
      () =>
        createCaptureMessage({
          ...baseAttributedGmv,
          [forbiddenField]: "x",
        }),
      "INVALID_CAPTURE_MESSAGE",
    );
  }
});

test("accepts canonical exact and compact Attributed GMV displays only", () => {
  for (const attributedGmvDisplay of [
    "$0.00",
    "$999.99",
    "$4,087.01",
    "$1K",
    "$4.6M",
    "$4.64K",
    "$1B",
  ]) {
    assert.doesNotThrow(() =>
      createCaptureMessage({
        type: EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
        attributedGmvDisplay,
      }),
    );
  }

  for (const attributedGmvDisplay of [
    "$1000.00",
    "$4,87.01",
    "$4.640K",
    "$ 4.64K",
    "-$4.64K",
    "USD 4.64K",
    "$4.64K shipping",
    "",
    null,
  ]) {
    assertErrorCode(
      () =>
        createCaptureMessage({
          type: EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
          attributedGmvDisplay,
        }),
      "INVALID_CAPTURE_MESSAGE",
    );
  }
});

test("accepts only sanitized outbound payment-status batches", () => {
  const outboundStatuses = Object.values(OBSERVED_PAYMENT_STATUSES).filter(
    (status) => status !== OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED,
  );

  assert.equal(MAX_OBSERVED_PAYMENT_STATUSES, 1000);
  assert.notEqual(
    OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    OBSERVED_PAYMENT_STATUSES.CANCELED,
  );
  outboundStatuses.forEach((observedPaymentStatus, index) => {
    assert.doesNotThrow(() =>
      createCaptureMessage({
        type: EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
        statuses: [{ variationNumber: index + 1, observedPaymentStatus }],
      }),
    );
  });

  const invalidStatuses = [
    [],
    [
      {
        variationNumber: 44,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED,
      },
    ],
    [{ variationNumber: 44, observedPaymentStatus: "Payment complete" }],
    [{ variationNumber: 44, observedPaymentStatus: "another_status" }],
    [
      {
        variationNumber: 44,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
        statusText: "private DOM text",
      },
    ],
    [
      {
        variationNumber: 44,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      },
      {
        variationNumber: 44,
        observedPaymentStatus: OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
    new Array(MAX_OBSERVED_PAYMENT_STATUSES + 1).fill(null).map(
      (_, index) => ({
        variationNumber: index + 1,
        observedPaymentStatus:
          OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      }),
    ),
  ];

  for (const statuses of invalidStatuses) {
    assertErrorCode(
      () =>
        createCaptureMessage({
          type: EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
          statuses,
        }),
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
