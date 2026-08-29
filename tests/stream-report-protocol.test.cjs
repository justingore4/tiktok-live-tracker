const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");

const REPORT_ID =
  "stream-report:11111111-1111-4111-8111-111111111111";

test("creates strict read and archive-management stream-report messages", () => {
  assert.equal(
    protocol.MESSAGE_CHANNEL,
    "tiktok-live-tracker.stream-report",
  );
  assert.equal(protocol.MESSAGE_VERSION, 1);
  assert.deepEqual(protocol.COMMAND_TYPES, {
    LIST_REPORTS: "list_reports",
    LIST_ARCHIVED_REPORTS: "list_archived_reports",
    GET_REPORT: "get_report",
    LIST_PAYMENT_FIXING_ORDERS: "list_payment_fixing_orders",
    RESOLVE_PAYMENT_FIXING_ORDER: "resolve_payment_fixing_order",
    LIST_REPORT_UNIT_COSTS: "list_report_unit_costs",
    UPDATE_REPORT_UNIT_COST: "update_report_unit_cost",
    GET_OFFLINE_EDITOR_DATA: "get_offline_editor_data",
    SAVE_OFFLINE_EDITOR_MAPPINGS: "save_offline_editor_mappings",
    RENAME_REPORT: "rename_report",
    ARCHIVE_REPORTS: "archive_reports",
    RESTORE_REPORTS: "restore_reports",
    DELETE_ARCHIVED_REPORTS: "delete_archived_reports",
  });
  assert.equal(protocol.MAX_ACTIVE_REPORTS, 5);
  assert.equal(protocol.MAX_ARCHIVED_REPORTS, 25);
  assert.equal(protocol.MAX_OFFLINE_MAPPING_CHANGES, 1000);
  assert.equal(protocol.MAX_REPORT_DISPLAY_NAME_LENGTH, 80);
  assert.equal(protocol.MAX_TOTAL_REPORTS, 30);

  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "list_report_unit_costs",
      reportId: REPORT_ID,
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: {
        type: "list_report_unit_costs",
        reportId: REPORT_ID,
      },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "update_report_unit_cost",
      reportId: REPORT_ID,
      sku: "KOREA-TEE-OS",
      unitCostCents: 525,
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: {
        type: "update_report_unit_cost",
        reportId: REPORT_ID,
        sku: "KOREA-TEE-OS",
        unitCostCents: 525,
      },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({ type: "list_reports" }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: { type: "list_reports" },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "list_payment_fixing_orders",
      reportId: REPORT_ID,
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: {
        type: "list_payment_fixing_orders",
        reportId: REPORT_ID,
      },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "resolve_payment_fixing_order",
      reportId: REPORT_ID,
      variationNumber: 299,
      resolution: "payment_complete",
      soldPriceCents: 2750,
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: {
        type: "resolve_payment_fixing_order",
        reportId: REPORT_ID,
        variationNumber: 299,
        resolution: "payment_complete",
        soldPriceCents: 2750,
      },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: "August launch stream",
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: {
        type: "rename_report",
        reportId: REPORT_ID,
        displayName: "August launch stream",
      },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: null,
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: {
        type: "rename_report",
        reportId: REPORT_ID,
        displayName: null,
      },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "archive_reports",
      reportIds: [REPORT_ID],
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: { type: "archive_reports", reportIds: [REPORT_ID] },
    },
  );
  assert.deepEqual(
    protocol.createStreamReportMessage({
      type: "get_report",
      reportId: REPORT_ID,
    }),
    {
      channel: protocol.MESSAGE_CHANNEL,
      version: 1,
      command: { type: "get_report", reportId: REPORT_ID },
    },
  );
});

test("creates detached strict Offline Report Editor commands", () => {
  const changes = [
    {
      variationNumber: 15,
      expectedStatus: "payment_complete",
      expectedSku: "TEE-M",
      sku: "TEE-L",
    },
    {
      variationNumber: 16,
      expectedStatus: "canceled",
      expectedSku: null,
      sku: "TEE-M",
    },
  ];
  const load = protocol.createStreamReportMessage({
    type: protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
    reportId: REPORT_ID,
  });
  const save = protocol.createStreamReportMessage({
    type: protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
    reportId: REPORT_ID,
    changes,
  });

  changes[0].sku = null;
  changes.push({ ...changes[1], variationNumber: 17 });

  assert.deepEqual(load.command, {
    type: "get_offline_editor_data",
    reportId: REPORT_ID,
  });
  assert.deepEqual(save.command, {
    type: "save_offline_editor_mappings",
    reportId: REPORT_ID,
    changes: [
      {
        variationNumber: 15,
        expectedStatus: "payment_complete",
        expectedSku: "TEE-M",
        sku: "TEE-L",
      },
      {
        variationNumber: 16,
        expectedStatus: "canceled",
        expectedSku: null,
        sku: "TEE-M",
      },
    ],
  });
});

test("rejects malformed Offline Report Editor mapping batches", () => {
  const valid = {
    variationNumber: 15,
    expectedStatus: "payment_complete",
    expectedSku: "TEE-M",
    sku: "TEE-L",
  };
  const sparse = Array(1);
  const maskedSparse = Array(1);
  maskedSparse.extra = true;
  const invalid = [
    {
      type: "get_offline_editor_data",
      reportId: "bad",
    },
    {
      type: "get_offline_editor_data",
      reportId: REPORT_ID,
      extra: true,
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: sparse,
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: maskedSparse,
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [{ ...valid, extra: true }],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [{ ...valid, variationNumber: 0 }],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [{ ...valid, expectedStatus: "processing" }],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [{ ...valid, expectedSku: "tee-m" }],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [{ ...valid, sku: " TEE-L" }],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [valid, { ...valid, sku: null }],
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: Array.from(
        { length: protocol.MAX_OFFLINE_MAPPING_CHANGES + 1 },
        (_value, index) => ({ ...valid, variationNumber: index + 1 }),
      ),
    },
    {
      type: "save_offline_editor_mappings",
      reportId: REPORT_ID,
      changes: [valid],
      extra: true,
    },
  ];

  invalid.forEach((command) => {
    assert.throws(
      () => protocol.createStreamReportMessage(command),
      (error) => error instanceof protocol.StreamReportProtocolError,
    );
  });
});

test("rejects malformed report messages and IDs", () => {
  const invalid = [
    null,
    {},
    { type: "list_reports", extra: true },
    { type: "get_report", reportId: "stream-report:bad" },
    { type: "list_payment_fixing_orders", reportId: "bad" },
    { type: "list_report_unit_costs", reportId: "bad" },
    {
      type: "update_report_unit_cost",
      reportId: REPORT_ID,
      sku: " KOREA-TEE-OS",
      unitCostCents: 500,
    },
    {
      type: "update_report_unit_cost",
      reportId: REPORT_ID,
      sku: "KOREA-TEE-OS",
      unitCostCents: -1,
    },
    {
      type: "update_report_unit_cost",
      reportId: REPORT_ID,
      sku: "KOREA-TEE-OS",
      unitCostCents: 1.5,
    },
    {
      type: "update_report_unit_cost",
      reportId: REPORT_ID,
      sku: "KOREA-TEE-OS",
      unitCostCents: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      type: "rename_report",
      reportId: "bad",
      displayName: "Launch stream",
    },
    {
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: "",
    },
    {
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: " Launch stream",
    },
    {
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: "Launch\nstream",
    },
    {
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: "x".repeat(protocol.MAX_REPORT_DISPLAY_NAME_LENGTH + 1),
    },
    {
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: 42,
    },
    {
      type: "rename_report",
      reportId: REPORT_ID,
      displayName: null,
      extra: true,
    },
    {
      type: "resolve_payment_fixing_order",
      reportId: REPORT_ID,
      variationNumber: 0,
      resolution: "payment_complete",
      soldPriceCents: 100,
    },
    {
      type: "resolve_payment_fixing_order",
      reportId: REPORT_ID,
      variationNumber: 1,
      resolution: "processing",
      soldPriceCents: null,
    },
    {
      type: "resolve_payment_fixing_order",
      reportId: REPORT_ID,
      variationNumber: 1,
      resolution: "payment_complete",
      soldPriceCents: null,
    },
    {
      type: "resolve_payment_fixing_order",
      reportId: REPORT_ID,
      variationNumber: 1,
      resolution: "canceled",
      soldPriceCents: 100,
    },
    { type: "archive_reports", reportIds: [] },
    { type: "restore_reports", reportIds: [REPORT_ID, REPORT_ID] },
    { type: "delete_archived_reports", reportIds: ["bad"] },
    {
      type: "archive_reports",
      reportIds: Array.from(
        { length: protocol.MAX_ARCHIVED_REPORTS + 1 },
        (_, index) =>
          `stream-report:${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      ),
    },
    { type: "unknown" },
  ];

  invalid.forEach((command) => {
    assert.throws(
      () => protocol.createStreamReportMessage(command),
      (error) => error instanceof protocol.StreamReportProtocolError,
    );
  });

  assert.doesNotThrow(() => protocol.createStreamReportMessage({
    type: "rename_report",
    reportId: REPORT_ID,
    displayName: "x".repeat(protocol.MAX_REPORT_DISPLAY_NAME_LENGTH),
  }));

  const valid = protocol.createStreamReportMessage({ type: "list_reports" });
  assert.throws(
    () => protocol.validateStreamReportMessage({ ...valid, version: 2 }),
    (error) => error.code === "UNSUPPORTED_MESSAGE_VERSION",
  );
  assert.throws(
    () => protocol.validateStreamReportMessage({ ...valid, extra: true }),
    (error) => error.code === "INVALID_MESSAGE",
  );
});
