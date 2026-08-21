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
    ARCHIVE_REPORTS: "archive_reports",
    RESTORE_REPORTS: "restore_reports",
    DELETE_ARCHIVED_REPORTS: "delete_archived_reports",
  });
  assert.equal(protocol.MAX_ACTIVE_REPORTS, 5);
  assert.equal(protocol.MAX_ARCHIVED_REPORTS, 25);
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
