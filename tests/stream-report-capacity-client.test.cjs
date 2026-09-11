const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");
const storage = require("../extension/shared/stream-report-storage.js");
const clientModule = require("../extension/report/stream-report-client.js");

function capacity(overrides = {}) {
  return {
    usedBytes: 1200,
    maxBytes: storage.MAX_ARCHIVE_BYTES,
    totalReports: 3,
    maxReports: protocol.MAX_TOTAL_REPORTS,
    ...overrides,
  };
}

function createClient(options = {}) {
  return clientModule.createStreamReportClient({
    runtime: { sendMessage: async () => ({ ok: true, data: capacity() }) },
    protocol,
    streamReport: {
      hydrateStreamReport() {
        assert.fail("A capacity read must not hydrate report payloads.");
      },
    },
    ...options,
  });
}

test("capacity client sends one strict read command and returns detached exact metadata", async () => {
  const messages = [];
  const data = capacity();
  const client = createClient({
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, data };
      },
    },
  });
  const result = await client.getLibraryCapacity();
  assert.deepEqual(messages, [{
    channel: protocol.MESSAGE_CHANNEL,
    version: protocol.MESSAGE_VERSION,
    command: { type: "get_library_capacity" },
  }]);
  assert.deepEqual(result, data);
  assert.equal(result.maxBytes, 4 * 1024 * 1024 + 8 * 1024);
  result.usedBytes = 0;
  assert.equal(data.usedBytes, 1200);
});

test("capacity client accepts empty, warning-threshold, and exactly full metadata", async () => {
  for (const data of [
    capacity({ usedBytes: 0, totalReports: 0 }),
    capacity({ usedBytes: Math.ceil(storage.MAX_ARCHIVE_BYTES * 0.8) }),
    capacity({ usedBytes: Math.ceil(storage.MAX_ARCHIVE_BYTES * 0.95) }),
    capacity({
      usedBytes: storage.MAX_ARCHIVE_BYTES,
      totalReports: protocol.MAX_TOTAL_REPORTS,
    }),
  ]) {
    const client = createClient({
      runtime: { sendMessage: async () => ({ ok: true, data }) },
    });
    assert.deepEqual(await client.getLibraryCapacity(), data);
  }
});

test("capacity client rejects malformed fields, bounds, response envelopes, and unknown data", async () => {
  const invalidData = [
    null,
    [],
    {},
    { ...capacity(), extra: true },
    { ...capacity(), records: [] },
    { ...capacity(), reports: [] },
    capacity({ usedBytes: -1 }),
    capacity({ usedBytes: 0.5 }),
    capacity({ usedBytes: "1200" }),
    capacity({ usedBytes: null }),
    capacity({ usedBytes: Number.NaN }),
    capacity({ usedBytes: Infinity }),
    capacity({ usedBytes: Number.MAX_SAFE_INTEGER + 1 }),
    capacity({ usedBytes: storage.MAX_ARCHIVE_BYTES + 1 }),
    capacity({ maxBytes: 0 }),
    capacity({ maxBytes: -1 }),
    capacity({ maxBytes: 1200.5 }),
    capacity({ maxBytes: "4202496" }),
    capacity({ maxBytes: Number.MAX_SAFE_INTEGER + 1 }),
    capacity({ totalReports: -1 }),
    capacity({ totalReports: 1.5 }),
    capacity({ totalReports: "3" }),
    capacity({ totalReports: protocol.MAX_TOTAL_REPORTS + 1 }),
    capacity({ totalReports: Number.MAX_SAFE_INTEGER + 1 }),
    capacity({ maxReports: 0 }),
    capacity({ maxReports: protocol.MAX_TOTAL_REPORTS - 1 }),
    capacity({ maxReports: "30" }),
    capacity({ maxReports: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  for (const key of Object.keys(capacity())) {
    const missing = capacity();
    delete missing[key];
    invalidData.push(missing);
  }
  const invalidResponses = [
    ...invalidData.map((data) => ({ ok: true, data })),
    { ok: true, data: capacity(), extra: true },
    { ok: false, data: capacity() },
    { ok: false, error: { code: "", message: "failed" } },
    { ok: false, error: { code: "FAILED", message: "failed", extra: true } },
    undefined,
  ];
  for (const response of invalidResponses) {
    const client = createClient({
      runtime: { sendMessage: async () => response },
    });
    await assert.rejects(
      client.getLibraryCapacity(),
      (error) => error instanceof clientModule.StreamReportClientError &&
        error.code === "INVALID_RESPONSE",
    );
  }
});

test("capacity client preserves service errors and can read fresh data after failed requests", async () => {
  let attempts = 0;
  const client = createClient({
    runtime: {
      async sendMessage() {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            error: { code: "STORAGE_READ_FAILED", message: "Read failed." },
          };
        }
        if (attempts === 2) throw new Error("offline");
        return { ok: true, data: capacity({ totalReports: 2, usedBytes: 900 }) };
      },
    },
  });
  await assert.rejects(
    client.getLibraryCapacity(),
    (error) => error.code === "STORAGE_READ_FAILED" &&
      error.message === "Read failed.",
  );
  await assert.rejects(
    client.getLibraryCapacity(),
    (error) => error.code === "RUNTIME_MESSAGE_FAILED",
  );
  assert.deepEqual(
    await client.getLibraryCapacity(),
    capacity({ totalReports: 2, usedBytes: 900 }),
  );
});

test("capacity client bounds a hung request and clears its timer", async () => {
  let timeoutCallback;
  const cleared = [];
  const client = createClient({
    runtime: { sendMessage: () => new Promise(() => {}) },
    setTimeoutImpl(callback) {
      timeoutCallback = callback;
      return 7;
    },
    clearTimeoutImpl(timer) { cleared.push(timer); },
  });
  const request = client.getLibraryCapacity();
  await Promise.resolve();
  await Promise.resolve();
  timeoutCallback();
  await assert.rejects(request, (error) => error.code === "REPORT_REQUEST_TIMEOUT");
  assert.deepEqual(cleared, [7]);
});

test("capacity client requires the command and consistent total-report protocol constant", () => {
  const missingCommand = { ...protocol.COMMAND_TYPES };
  delete missingCommand.GET_LIBRARY_CAPACITY;
  assert.throws(
    () => createClient({ protocol: { ...protocol, COMMAND_TYPES: missingCommand } }),
    TypeError,
  );
  for (const maxReports of [undefined, 0, 29, "30", 30.5]) {
    assert.throws(
      () => createClient({ protocol: { ...protocol, MAX_TOTAL_REPORTS: maxReports } }),
      TypeError,
    );
  }
});
