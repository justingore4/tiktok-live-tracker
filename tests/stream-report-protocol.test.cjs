const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");

const REPORT_ID =
  "stream-report:11111111-1111-4111-8111-111111111111";

test("creates strict list and get stream-report messages", () => {
  assert.equal(
    protocol.MESSAGE_CHANNEL,
    "tiktok-live-tracker.stream-report",
  );
  assert.equal(protocol.MESSAGE_VERSION, 1);
  assert.deepEqual(protocol.COMMAND_TYPES, {
    LIST_REPORTS: "list_reports",
    GET_REPORT: "get_report",
  });

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

