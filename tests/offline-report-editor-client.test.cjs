const assert = require("node:assert/strict");
const test = require("node:test");

const clientModule = require(
  "../extension/report/offline-report-editor-client.js",
);
const protocol = require(
  "../extension/shared/stream-report-protocol.js",
);

const REPORT_ID =
  "stream-report:11111111-1111-4111-8111-111111111111";
const SECOND_REPORT_ID =
  "stream-report:22222222-2222-4222-8222-222222222222";

function clone(value) {
  return structuredClone(value);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createInventoryRow(overrides = {}) {
  return {
    sku: "TEE-M",
    item: "Tee",
    style: "black",
    size: "M",
    unitCostCents: 500,
    openingQuantity: 2,
    streamSoldQuantity: 1,
    baselineSoldQuantity: 1,
    pendingQuantity: 0,
    calculatedRemainingQuantity: 1,
    replacementQuantity: 1,
    availableAfterReservationsQuantity: 1,
    oversoldQuantity: 0,
    requiresRecount: false,
    ...overrides,
  };
}

function createEditorData(overrides = {}) {
  return {
    reportId: REPORT_ID,
    displayName: "Saturday stream",
    endedAt: "2026-08-29T20:00:00.000Z",
    eligibility: { status: "editable", code: null, reason: null },
    canceledDetailsAvailable: true,
    completedVariations: [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "TEE-M",
        soldPriceCents: 1500,
      },
    ],
    canceledVariations: [
      {
        variationNumber: 11,
        expectedStatus: "canceled",
        expectedSku: null,
      },
    ],
    inventory: [
      createInventoryRow(),
      createInventoryRow({
        sku: "TEE-L",
        size: "L",
        openingQuantity: 1,
        streamSoldQuantity: 0,
        baselineSoldQuantity: 0,
        calculatedRemainingQuantity: 1,
        replacementQuantity: 1,
        availableAfterReservationsQuantity: 1,
      }),
    ],
    ...overrides,
  };
}

function createClient(runtime) {
  return clientModule.createOfflineReportEditorClient({
    runtime,
    protocol,
  });
}

test("loads and saves strict detached editor data through one FIFO queue", async () => {
  const firstDelivery = createDeferred();
  const sent = [];
  const loadData = createEditorData();
  const correctedData = createEditorData({
    completedVariations: [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "TEE-L",
        soldPriceCents: 1500,
      },
    ],
    inventory: [
      createInventoryRow({
        streamSoldQuantity: 0,
        baselineSoldQuantity: 0,
        calculatedRemainingQuantity: 2,
        replacementQuantity: 2,
        availableAfterReservationsQuantity: 2,
      }),
      createInventoryRow({
        sku: "TEE-L",
        size: "L",
        openingQuantity: 1,
        streamSoldQuantity: 1,
        baselineSoldQuantity: 1,
        calculatedRemainingQuantity: 0,
        replacementQuantity: 0,
        availableAfterReservationsQuantity: 0,
      }),
    ],
  });
  const client = createClient({
    async sendMessage(message) {
      sent.push(clone(message.command));

      if (sent.length === 1) {
        return firstDelivery.promise;
      }

      return { ok: true, data: correctedData };
    },
  });
  const changes = [
    {
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "TEE-M",
      sku: "TEE-L",
    },
  ];
  const load = client.loadEditorData({ reportId: REPORT_ID });
  const save = client.saveMappingCorrections({
    reportId: REPORT_ID,
    changes,
  });

  changes[0].sku = null;
  changes.push({
    variationNumber: 11,
    expectedStatus: "canceled",
    expectedSku: null,
    sku: "TEE-M",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  firstDelivery.resolve({ ok: true, data: loadData });

  assert.deepEqual(await load, loadData);
  assert.deepEqual(await save, correctedData);
  assert.deepEqual(sent, [
    {
      type: "get_offline_editor_data",
      reportId: REPORT_ID,
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [
        {
          variationNumber: 10,
          expectedStatus: "payment_complete",
          expectedSku: "TEE-M",
          sku: "TEE-L",
        },
      ],
    },
  ]);
});

test("rejects malformed client commands before runtime delivery", async () => {
  let deliveries = 0;
  const client = createClient({
    async sendMessage() {
      deliveries += 1;
      return { ok: true, data: createEditorData() };
    },
  });
  const valid = {
    variationNumber: 10,
    expectedStatus: "payment_complete",
    expectedSku: "TEE-M",
    sku: "TEE-L",
  };
  const sparse = Array(1);
  const maskedSparse = Array(1);
  maskedSparse.extra = true;
  const invalidLoads = [
    null,
    {},
    { reportId: "bad" },
    { reportId: REPORT_ID, extra: true },
  ];
  const invalidSaves = [
    null,
    { reportId: REPORT_ID, changes: [] },
    { reportId: REPORT_ID, changes: sparse },
    { reportId: REPORT_ID, changes: maskedSparse },
    { reportId: REPORT_ID, changes: [{ ...valid, extra: true }] },
    {
      reportId: REPORT_ID,
      changes: [{ ...valid, expectedStatus: "processing" }],
    },
    { reportId: REPORT_ID, changes: [{ ...valid, sku: "tee-l" }] },
    { reportId: REPORT_ID, changes: [valid, { ...valid, sku: null }] },
    { reportId: REPORT_ID, changes: [valid], extra: true },
  ];

  for (const value of invalidLoads) {
    await assert.rejects(
      client.loadEditorData(value),
      (error) => error.code === "INVALID_CLIENT_COMMAND",
    );
  }

  for (const value of invalidSaves) {
    await assert.rejects(
      client.saveMappingCorrections(value),
      (error) => error.code === "INVALID_CLIENT_COMMAND",
    );
  }

  assert.equal(deliveries, 0);
});

test("strictly rejects malformed or overexposed editor responses", async () => {
  const valid = createEditorData();
  const duplicateInventory = createEditorData({
    inventory: [createInventoryRow(), createInventoryRow()],
  });
  const badQuantity = createEditorData({
    inventory: [createInventoryRow({ replacementQuantity: 2 })],
  });
  const unknownSku = createEditorData({
    completedVariations: [
      {
        ...valid.completedVariations[0],
        expectedSku: "MISSING-SKU",
      },
    ],
  });
  const hiddenCanceledDetails = createEditorData({
    canceledDetailsAvailable: false,
  });
  const duplicateVariation = createEditorData({
    canceledVariations: [
      {
        variationNumber: 10,
        expectedStatus: "canceled",
        expectedSku: null,
      },
    ],
  });
  const invalidEligibility = createEditorData({
    eligibility: {
      status: "editable",
      code: "SHOULD_BE_NULL",
      reason: "Should be null.",
    },
  });
  const editableWithoutRows = createEditorData({
    completedVariations: [],
    canceledVariations: [],
  });
  const readOnlyWithRows = createEditorData({
    eligibility: {
      status: "read_only",
      code: "NO_EDITABLE_VARIATIONS",
      reason: "This report has no saved variations to edit.",
    },
  });
  const invalidBlockedCode = createEditorData({
    eligibility: {
      status: "blocked",
      code: "NOT_A_SUPPORTED_REASON",
      reason: "This reason is not supported.",
    },
  });
  const invalidReadOnlyCode = createEditorData({
    eligibility: {
      status: "read_only",
      code: "ACTIVE_BIDDING_AT_END",
      reason: "This is a blocker, not a read-only reason.",
    },
    completedVariations: [],
    canceledVariations: [],
  });
  const invalidResponses = [
    { ...valid, reconciliationState: { secret: true } },
    { ...valid, reportId: SECOND_REPORT_ID },
    duplicateInventory,
    badQuantity,
    unknownSku,
    hiddenCanceledDetails,
    duplicateVariation,
    invalidEligibility,
    editableWithoutRows,
    readOnlyWithRows,
    invalidBlockedCode,
    invalidReadOnlyCode,
    createEditorData({
      inventory: [createInventoryRow({ item: " Tee" })],
    }),
    createEditorData({
      inventory: [createInventoryRow({ style: "black " })],
    }),
    createEditorData({
      inventory: [createInventoryRow({ size: " M" })],
    }),
  ];

  for (const data of invalidResponses) {
    const client = createClient({
      async sendMessage() {
        return { ok: true, data };
      },
    });

    await assert.rejects(
      client.loadEditorData({ reportId: REPORT_ID }),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
});

test("accepts blocked and legacy read-only sanitized editor states", async () => {
  const responses = [
    createEditorData({
      eligibility: {
        status: "blocked",
        code: "ACTIVE_STREAM_ALREADY_EXISTS",
        reason: "End the active tracker stream before editing a report.",
      },
    }),
    createEditorData({
      eligibility: {
        status: "read_only",
        code: "NO_EDITABLE_VARIATIONS",
        reason: "This report has no saved variations to edit.",
      },
      canceledDetailsAvailable: false,
      completedVariations: [],
      canceledVariations: [],
    }),
    createEditorData({
      canceledDetailsAvailable: false,
      canceledVariations: [],
    }),
  ];

  for (const data of responses) {
    const client = createClient({
      async sendMessage() {
        return { ok: true, data };
      },
    });

    assert.deepEqual(
      await client.loadEditorData({ reportId: REPORT_ID }),
      data,
    );
  }
});

test("rejects malformed or ambiguous injected protocol dependencies", () => {
  const createProtocol = (overrides = {}) => ({
    ...protocol,
    ...overrides,
    COMMAND_TYPES: {
      ...protocol.COMMAND_TYPES,
      ...(overrides.COMMAND_TYPES ?? {}),
    },
  });
  const invalidProtocols = [
    createProtocol({ MESSAGE_CHANNEL: "" }),
    createProtocol({ MESSAGE_VERSION: 0 }),
    createProtocol({ MESSAGE_VERSION: 1.5 }),
    createProtocol({
      COMMAND_TYPES: { GET_OFFLINE_EDITOR_DATA: "" },
    }),
    createProtocol({
      COMMAND_TYPES: { SAVE_OFFLINE_EDITOR_MAPPINGS: "   " },
    }),
    createProtocol({
      COMMAND_TYPES: {
        SAVE_OFFLINE_EDITOR_MAPPINGS:
          protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
      },
    }),
  ];

  invalidProtocols.forEach((injectedProtocol) => {
    assert.throws(
      () => clientModule.createOfflineReportEditorClient({
        runtime: { sendMessage() {} },
        protocol: injectedProtocol,
      }),
      TypeError,
    );
  });
});

test("rejects matching save targets returned with unavailable eligibility", async () => {
  const correctedVariation = {
    variationNumber: 10,
    expectedStatus: "payment_complete",
    expectedSku: "TEE-L",
    soldPriceCents: 1500,
  };
  const unavailable = [
    {
      status: "blocked",
      code: "ACTIVE_BIDDING_AT_END",
      reason: "The report ended with an active bidding variation.",
    },
    {
      status: "read_only",
      code: "NO_EDITABLE_VARIATIONS",
      reason: "This report has no saved variations to edit.",
    },
  ];

  for (const eligibility of unavailable) {
    const data = createEditorData({
      eligibility,
      completedVariations: [correctedVariation],
      canceledVariations: [],
    });
    const client = createClient({
      async sendMessage() {
        return { ok: true, data };
      },
    });

    await assert.rejects(
      client.saveMappingCorrections({
        reportId: REPORT_ID,
        changes: [
          {
            variationNumber: 10,
            expectedStatus: "payment_complete",
            expectedSku: "TEE-M",
            sku: "TEE-L",
          },
        ],
      }),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }
});

test("rejects altered save results and remains usable after typed failures", async () => {
  let attempt = 0;
  const client = createClient({
    async sendMessage(message) {
      attempt += 1;

      if (attempt === 1) {
        return {
          ok: false,
          error: {
            code: "STALE_REPORT_MAPPING",
            message: "The saved mapping changed.",
          },
        };
      }

      if (
        message.command.type ===
          protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS
      ) {
        return { ok: true, data: createEditorData() };
      }

      return { ok: true, data: createEditorData() };
    },
  });

  await assert.rejects(
    client.loadEditorData({ reportId: REPORT_ID }),
    (error) => error.code === "STALE_REPORT_MAPPING",
  );
  assert.equal(
    (await client.loadEditorData({ reportId: REPORT_ID })).reportId,
    REPORT_ID,
  );
  await assert.rejects(
    client.saveMappingCorrections({
      reportId: REPORT_ID,
      changes: [
        {
          variationNumber: 10,
          expectedStatus: "payment_complete",
          expectedSku: "TEE-M",
          sku: "TEE-L",
        },
      ],
    }),
    (error) => error.code === "INVALID_RESPONSE",
  );
});
