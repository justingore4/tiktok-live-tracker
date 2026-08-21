const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createOptionDisplay,
  getPaymentTone,
} = require("../extension/tagger/variation-selector-view-model.js");

function formatItemName(option) {
  return option.style ? `${option.item} - ${option.style}` : option.item;
}

function createOption(overrides = {}) {
  return {
    variationNumber: 168,
    bidding: false,
    observedPaymentStatus: "not_observed",
    observedPaymentStatusLabel: "Payment not yet observed",
    item: null,
    style: "",
    size: "",
    ...overrides,
  };
}

test("maps every payment state to its selector tone with bidding taking precedence", () => {
  const cases = [
    {
      name: "bidding overrides a terminal payment state",
      option: createOption({
        bidding: true,
        observedPaymentStatus: "canceled",
        observedPaymentStatusLabel: "Canceled",
      }),
      tone: "warning",
      label: "bidding",
    },
    {
      name: "payment processing",
      option: createOption({
        observedPaymentStatus: "payment_processing",
        observedPaymentStatusLabel: "Payment processing",
      }),
      tone: "warning",
      label: "processing",
    },
    {
      name: "payment fixing",
      option: createOption({
        observedPaymentStatus: "payment_fixing",
        observedPaymentStatusLabel: "Payment fixing",
      }),
      tone: "warning",
      label: "Payment fixing",
    },
    {
      name: "payment failed during its buffer period",
      option: createOption({
        observedPaymentStatus: "payment_failed",
        observedPaymentStatusLabel: "Payment failed",
      }),
      tone: "warning",
      label: "Payment failed",
    },
    {
      name: "canceled",
      option: createOption({
        observedPaymentStatus: "canceled",
        observedPaymentStatusLabel: "Canceled",
      }),
      tone: "danger",
      label: "Canceled",
    },
    {
      name: "payment complete",
      option: createOption({
        observedPaymentStatus: "payment_complete",
        observedPaymentStatusLabel: "Payment complete",
      }),
      tone: "success",
      label: "complete",
    },
    {
      name: "payment not yet observed",
      option: createOption(),
      tone: "neutral",
      label: "Payment not yet observed",
    },
    {
      name: "unrecognized payment status",
      option: createOption({
        observedPaymentStatus: "unrecognized",
        observedPaymentStatusLabel: "Unrecognized payment status",
      }),
      tone: "neutral",
      label: "Unrecognized payment status",
    },
    {
      name: "future unknown payment status",
      option: createOption({
        observedPaymentStatus: "future_status",
        observedPaymentStatusLabel: "Future status",
      }),
      tone: "neutral",
      label: "Future status",
    },
    {
      name: "missing payment status",
      option: createOption({
        observedPaymentStatus: null,
        observedPaymentStatusLabel: undefined,
      }),
      tone: "neutral",
      label: "Payment status unavailable",
    },
  ];

  for (const { name, option, tone, label } of cases) {
    assert.equal(getPaymentTone(option), tone, `${name} tone`);

    const display = createOptionDisplay(option, { formatItemName });

    assert.equal(display.paymentTone, tone, `${name} display tone`);
    assert.equal(display.paymentLabel, label, `${name} label`);
  }
});

test("formats mapped and unmapped options with exact independent item tones", () => {
  const mapped = createOptionDisplay(
    createOption({
      observedPaymentStatus: "payment_complete",
      observedPaymentStatusLabel: "Payment complete",
      item: "travis",
      style: "tee",
      size: "OS",
    }),
    { formatItemName },
  );
  const unmapped = createOptionDisplay(createOption(), { formatItemName });

  assert.deepEqual(mapped, {
    variationNumber: 168,
    variationLabel: "#168",
    paymentLabel: "complete",
    paymentTone: "success",
    itemLabel: "travis - tee, size OS",
    itemTone: "success",
    fullLabel: "#168 - complete - travis - tee, size OS",
  });
  assert.deepEqual(unmapped, {
    variationNumber: 168,
    variationLabel: "#168",
    paymentLabel: "Payment not yet observed",
    paymentTone: "neutral",
    itemLabel: "no selection",
    itemTone: "unselected",
    fullLabel: "#168 - Payment not yet observed - no selection",
  });
  assert.equal(Object.isFrozen(mapped), true);

  for (const item of ["", "   "]) {
    const display = createOptionDisplay(createOption({ item }), {
      formatItemName,
    });

    assert.equal(display.itemLabel, "no selection");
    assert.equal(display.itemTone, "unselected");
  }
});

test("keeps canceled payment and item-selection tones independent", () => {
  const mappedCanceled = createOptionDisplay(
    createOption({
      variationNumber: 167,
      observedPaymentStatus: "canceled",
      observedPaymentStatusLabel: "Canceled",
      item: "Black tee",
      style: "black",
      size: "L",
    }),
    { formatItemName },
  );
  const unmappedCanceled = createOptionDisplay(
    createOption({
      variationNumber: 166,
      observedPaymentStatus: "canceled",
      observedPaymentStatusLabel: "Canceled",
    }),
    { formatItemName },
  );

  assert.deepEqual(
    {
      paymentTone: mappedCanceled.paymentTone,
      itemTone: mappedCanceled.itemTone,
      fullLabel: mappedCanceled.fullLabel,
    },
    {
      paymentTone: "danger",
      itemTone: "success",
      fullLabel: "#167 - Canceled - Black tee - black, size L",
    },
  );
  assert.deepEqual(
    {
      paymentTone: unmappedCanceled.paymentTone,
      itemTone: unmappedCanceled.itemTone,
      fullLabel: unmappedCanceled.fullLabel,
    },
    {
      paymentTone: "danger",
      itemTone: "unselected",
      fullLabel: "#166 - Canceled - no selection",
    },
  );
});

test("validates variation options and requires an item-name formatter", () => {
  for (const option of [null, undefined, "168", [], 168]) {
    assert.throws(
      () => createOptionDisplay(option, { formatItemName }),
      /variation option is required/i,
    );
  }

  for (const variationNumber of [undefined, null, 0, -1, 1.5, "168", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createOptionDisplay(createOption({ variationNumber }), {
        formatItemName,
      }),
      /variation number must be a positive safe integer/i,
    );
  }

  assert.throws(
    () => createOptionDisplay(createOption()),
    /item-name formatter is required/i,
  );
  assert.throws(
    () => createOptionDisplay(createOption(), { formatItemName: "format" }),
    /item-name formatter is required/i,
  );
});
