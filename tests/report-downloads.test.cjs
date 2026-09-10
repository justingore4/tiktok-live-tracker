const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DUPLICATE_FILENAMES_MESSAGE,
  MAX_FILENAME_BASE_BYTES,
  createPdfFilename,
  getReportDisplayName,
  createReportDownloadController,
} = require("../extension/report/report-downloads.js");

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

function record(reportId, displayName = reportId) {
  return freeze({
    reportId,
    displayName,
    report: {
      metadata: {
        startedAt: "2026-09-08T01:00:00Z",
        endedAt: "2026-09-08T04:00:00Z",
      },
      inventory: [{ sku: "TEST", opening: 10, remaining: 9 }],
      summary: { grossProfitCents: 300 },
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(records = [record("a", "First stream")], options = {}) {
  const original = JSON.stringify(records);
  const loaded = [];
  const generated = [];
  const starts = [];
  const searches = [];
  const revoked = [];
  const blobs = [];
  const progress = [];
  const listeners = new Set();
  const erasedListeners = new Set();
  const items = new Map();
  const runtime = {};
  const downloads = {
    onChanged: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
    },
    onErased: {
      addListener(listener) { erasedListeners.add(listener); },
      removeListener(listener) { erasedListeners.delete(listener); },
    },
    download(settings, callback) {
      starts.push(settings);
      const id = starts.length;
      const failure = options.startFailures?.[id];
      if (failure) {
        runtime.lastError = { message: failure };
        callback();
        delete runtime.lastError;
        return;
      }
      items.set(id, { id, state: "in_progress" });
      if (options.manual) {
        callback(id);
      } else {
        const error = options.interruptions?.[id];
        // Chrome may complete before its download-start callback delivers the ID.
        const state = error ? "interrupted" : "complete";
        items.set(id, { id, state, error });
        for (const listener of listeners) listener({ id, state: { current: state }, error: { current: error } });
        callback(id);
      }
    },
    search(query, callback) {
      searches.push(query);
      callback(items.has(query.id) ? [items.get(query.id)] : []);
    },
  };
  const controller = createReportDownloadController({
    downloads,
    runtime,
    Blob,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:synthetic-${blobs.length}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    async getReport(id) {
      loaded.push(id);
      if (options.getReport) return options.getReport(id);
      return records.find((entry) => entry.reportId === id);
    },
    async generatePdf(entry) {
      generated.push(entry.reportId);
      if (options.generatePdf) return options.generatePdf(entry);
      return Uint8Array.from(Buffer.from(`%PDF-1.7 synthetic ${entry.reportId}`));
    },
    onProgress(event) { progress.push(event); options.onProgress?.(event); },
  });
  function finish(id, error) {
    const state = error ? "interrupted" : "complete";
    items.set(id, { id, state, error });
    for (const listener of listeners) listener({ id, state: { current: state }, error: { current: error } });
  }
  return { controller, downloads, records, original, loaded, generated, starts, searches, revoked, blobs, progress, listeners, erasedListeners, items, finish };
}

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

test("single report downloads a PDF named from the saved name with no print dialog or overwrite", async () => {
  const h = harness();
  const result = await h.controller.download(["a"]);
  assert.equal(result.status, "complete");
  assert.equal(result.completed, 1);
  assert.deepEqual(h.starts, [{ url: "blob:synthetic-1", filename: "First stream.pdf", saveAs: false, conflictAction: "uniquify" }]);
  assert.equal(h.blobs[0].type, "application/pdf");
  assert.match(await h.blobs[0].text(), /^%PDF/);
  assert.deepEqual(h.searches, [{ id: 1 }]);
  assert.equal(h.listeners.size, 0);
  assert.deepEqual(h.revoked, ["blob:synthetic-1"]);
});

test("bulk export preloads every report before generating any PDF and downloads separate files", async () => {
  const records = [record("a", "Alpha"), record("b", "Beta"), record("c", "Gamma")];
  const h = harness(records, {
    generatePdf(entry) {
      assert.deepEqual(h.loaded, ["a", "b", "c"]);
      return Uint8Array.from(Buffer.from(`%PDF ${entry.reportId}`));
    },
  });
  const result = await h.controller.download(["a", "b", "c"]);
  assert.equal(result.status, "complete");
  assert.equal(result.total, 3);
  assert.equal(result.completed, 3);
  assert.deepEqual(h.starts.map((entry) => entry.filename), ["Alpha.pdf", "Beta.pdf", "Gamma.pdf"]);
  assert.deepEqual(h.searches, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(h.revoked.length, 3);
});

test("empty selection performs no loading, generation, or downloading", async () => {
  const h = harness();
  const result = await h.controller.download([]);
  assert.equal(result.status, "empty");
  assert.equal(h.controller.isBusy(), false);
  assert.deepEqual(h.loaded, []);
  assert.deepEqual(h.generated, []);
  assert.deepEqual(h.starts, []);
});

test("selected IDs are snapshotted synchronously and repeated clicks cannot start another job", async () => {
  const gate = deferred();
  const selected = new Set(["a", "b"]);
  const records = [record("a"), record("b"), record("c")];
  const h = harness(records, {
    async getReport(id) { await gate.promise; return records.find((entry) => entry.reportId === id); },
  });
  const first = h.controller.download(selected);
  assert.equal(h.controller.isBusy(), true);
  selected.delete("a"); selected.add("c");
  const second = await h.controller.download(["c"]);
  assert.equal(second.status, "busy");
  gate.resolve();
  assert.equal((await first).status, "complete");
  assert.deepEqual(h.loaded, ["a", "b"]);
  assert.deepEqual(h.generated, ["a", "b"]);
  assert.equal(h.controller.isBusy(), false);
});

test("repeat downloads of an individual report are allowed", async () => {
  const h = harness();
  assert.equal((await h.controller.download(["a"])).status, "complete");
  assert.equal((await h.controller.download(["a"])).status, "complete");
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[0].filename, h.starts[1].filename);
});

for (const [description, names] of [
  ["identical names", ["Market night", "Market night"]],
  ["capitalization", ["Market NIGHT", "market night"]],
  ["Unicode capitalization", ["Stra\u00dfe", "STRASSE"]],
  ["Greek capitalization", ["\u03c3", "\u03c2"]],
  ["illegal characters sanitized to the same filename", ["Night/One", "Night:One"]],
  ["trailing dots and spaces", ["Night", " Night.  "]],
  ["an existing PDF suffix", ["Night.PDF", "Night"]],
  ["Unicode normalization", ["Caf\u00e9", "Cafe\u0301"]],
  ["truncated long names", ["a".repeat(200) + "one", "a".repeat(200) + "two"]],
  ["reserved name transformation", ["CON", "_CON"]],
]) {
  test(`batch rejects ${description} before any PDF generation or download`, async () => {
    const h = harness(names.map((name, index) => record(String(index), name)));
    const result = await h.controller.download(["0", "1"]);
    assert.equal(result.status, "duplicate");
    assert.equal(result.message, DUPLICATE_FILENAMES_MESSAGE);
    assert.equal(result.completed, 0);
    assert.deepEqual(result.conflicts[0].map((entry) => entry.name), names);
    assert.equal(result.conflicts[0][0].filename.toUpperCase().toLowerCase(), result.conflicts[0][1].filename.toUpperCase().toLowerCase());
    assert.deepEqual(h.generated, []);
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.loaded, ["0", "1"]);
    assert.equal(h.controller.isBusy(), false);
  });
}

test("filename sanitization protects Windows and macOS names without retaining path separators", () => {
  assert.equal(createPdfFilename('  A<B>:C"D/E\\F|G?H*I\u0000  '), "A-B--C-D-E-F-G-H-I-.pdf");
  assert.equal(createPdfFilename(".."), "Saved stream.pdf");
  assert.equal(createPdfFilename(""), "Saved stream.pdf");
  assert.equal(createPdfFilename("CON"), "_CON.pdf");
  assert.equal(createPdfFilename("nul.txt"), "_nul.txt.pdf");
  assert.equal(createPdfFilename("LPT9"), "_LPT9.pdf");
  assert.equal(createPdfFilename("COM1 .note"), "_COM1 .note.pdf");
  assert.equal(createPdfFilename("COM\u00b9"), "_COM\u00b9.pdf");
  assert.equal(createPdfFilename("CONCERT"), "CONCERT.pdf");
  assert.equal(createPdfFilename("file\u202etxt"), "filetxt.pdf");
  assert.equal(createPdfFilename("bad\ud800name"), "bad\ufffdname.pdf");
});

test("long Unicode filenames fit a portable UTF-8 byte limit without cutting code points", () => {
  const filename = createPdfFilename("\ud83c\udf19".repeat(200));
  assert.ok(Buffer.byteLength(filename) <= MAX_FILENAME_BASE_BYTES + 4);
  assert.equal(filename, "\ud83c\udf19".repeat(Math.floor(MAX_FILENAME_BASE_BYTES / 4)) + ".pdf");
});

test("missing display names use the tracking-start date rather than the distinct tracking-end date", () => {
  const saved = record("a", " ");
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const expected = format.format(new Date(saved.report.metadata.startedAt));
  assert.equal(getReportDisplayName(saved), expected);
  assert.notEqual(getReportDisplayName(saved), format.format(new Date(saved.report.metadata.endedAt)));
  assert.equal(saved.report.metadata.startedAt, "2026-09-08T01:00:00Z");
  assert.equal(saved.report.metadata.endedAt, "2026-09-08T04:00:00Z");
});

test("custom report names remain unchanged and missing or invalid start dates use a safe fallback", () => {
  assert.equal(getReportDisplayName(record("a", "Custom market night")), "Custom market night");
  for (const startedAt of [undefined, null, "", "invalid", 0]) {
    const saved = { report: { metadata: { startedAt, endedAt: "2026-09-08T04:00:00Z" } } };
    assert.equal(getReportDisplayName(saved), "Saved stream");
    assert.equal(getReportDisplayName({ ...saved, displayName: "Custom name" }), "Custom name");
  }
  assert.equal(getReportDisplayName({}), "Saved stream");
});

test("direct PDF filenames use tracking-start defaults without changing either stored timestamp", async () => {
  const saved = record("a", null);
  const h = harness([saved]);
  const result = await h.controller.download(["a"]);
  const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(saved.report.metadata.startedAt));
  assert.equal(result.status, "complete");
  assert.equal(h.starts[0].filename, createPdfFilename(expected));
  assert.equal(JSON.stringify(h.records), h.original);
  assert.equal(saved.report.metadata.startedAt, "2026-09-08T01:00:00Z");
  assert.equal(saved.report.metadata.endedAt, "2026-09-08T04:00:00Z");
});

test("a report load failure prevents every download and releases the busy guard", async () => {
  const h = harness([record("a")], { async getReport(id) { if (id === "b") throw new Error("Report no longer exists."); return record(id); } });
  const result = await h.controller.download(["a", "b"]);
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 0);
  assert.match(result.message, /Report no longer exists/);
  assert.match(result.message, /No PDFs were downloaded/);
  assert.deepEqual(h.generated, []);
  assert.deepEqual(h.starts, []);
  assert.equal(h.controller.isBusy(), false);
});

test("a missing loaded record also blocks all downloads", async () => {
  const h = harness();
  const result = await h.controller.download(["a", "missing"]);
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 0);
  assert.equal(h.starts.length, 0);
});

test("generation failures are reported as partial completion while remaining reports continue", async () => {
  const h = harness([record("a"), record("b"), record("c")], {
    async generatePdf(entry) { if (entry.reportId === "b") throw new Error("Cannot render this report."); return new Uint8Array([1, 2, 3]); },
  });
  const result = await h.controller.download(["a", "b", "c"]);
  assert.equal(result.status, "partial");
  assert.equal(result.completed, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failures.map((entry) => entry.reportId), ["b"]);
  assert.match(result.failures[0].message, /Cannot render/);
  assert.equal(result.message, "2 of 3 PDFs downloaded. 1 failed.");
  assert.equal(h.starts.length, 2);
  assert.equal(h.revoked.length, 2);
});

test("Chrome start errors do not claim completion and still release the blob and listener", async () => {
  const h = harness([record("a"), record("b")], { startFailures: { 1: "Permission denied" } });
  const result = await h.controller.download(["a", "b"]);
  assert.equal(result.status, "partial");
  assert.equal(result.completed, 1);
  assert.match(result.failures[0].message, /Permission denied/);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.revoked.length, 2);
});

test("interrupted Chrome downloads are failures, including interruptions before the callback", async () => {
  const h = harness([record("a"), record("b")], { interruptions: { 1: "FILE_NO_SPACE", 2: "USER_CANCELED" } });
  const result = await h.controller.download(["a", "b"]);
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 0);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0].message, /FILE_NO_SPACE/);
  assert.match(result.failures[1].message, /USER_CANCELED/);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.revoked.length, 2);
});

test("progress does not count an in-progress download as completed and ignores unrelated IDs", async () => {
  const h = harness([record("a"), record("b")], { manual: true });
  const pending = h.controller.download(["a", "b"]);
  await tick();
  assert.equal(h.controller.isBusy(), true);
  assert.equal(h.starts.length, 1);
  assert.equal(h.progress.at(-1).phase, "downloading");
  assert.equal(h.progress.at(-1).completed, 0);
  h.finish(999);
  await tick();
  assert.equal(h.starts.length, 1);
  h.finish(1);
  await tick();
  assert.equal(h.starts.length, 2);
  assert.equal(h.progress.at(-1).completed, 1);
  h.finish(2, "NETWORK_FAILED");
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.completed, 1);
  assert.equal(h.progress.at(-1).phase, "partial");
  assert.equal(h.listeners.size, 0);
  assert.deepEqual(h.searches, [{ id: 1 }, { id: 2 }]);
});

test("export leaves all frozen report and inventory data unchanged on success and rejection", async () => {
  const h = harness([record("a", "Alpha"), record("b", "Beta")]);
  await h.controller.download(["a", "b"]);
  assert.equal(JSON.stringify(h.records), h.original);
  const duplicates = harness([record("a", "Same"), record("b", "Same")]);
  await duplicates.controller.download(["a", "b"]);
  assert.equal(JSON.stringify(duplicates.records), duplicates.original);
});

test("progress display errors cannot change actual download results", async () => {
  const h = harness(undefined, { onProgress() { throw new Error("UI failed"); } });
  assert.equal((await h.controller.download(["a"])).status, "complete");
  assert.equal(h.controller.isBusy(), false);
});

test("promise-based Chrome APIs are supported", async () => {
  const h = harness();
  h.downloads.download = async (options) => { h.starts.push(options); return 42; };
  h.downloads.search = async (query) => { h.searches.push(query); return [{ id: 42, state: "complete" }]; };
  assert.equal((await h.controller.download(["a"])).status, "complete");
  assert.deepEqual(h.searches, [{ id: 42 }]);
  assert.equal(h.listeners.size, 0);
});

test("unavailable downloads API reports the reload/permission check without touching reports", async () => {
  const controller = createReportDownloadController({ downloads: {}, getReport() { assert.fail("must not load reports"); } });
  const result = await controller.download(["a"]);
  assert.equal(result.status, "failed");
  assert.match(result.message, /Reload the updated extension/);
  assert.equal(controller.isBusy(), false);
});

test("empty generated bytes fail without initiating a download", async () => {
  const h = harness(undefined, { generatePdf: async () => new Uint8Array() });
  const result = await h.controller.download(["a"]);
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 0);
  assert.equal(h.starts.length, 0);
});

test("missing download IDs and status-query failures do not claim successful downloads", async () => {
  const invalid = harness();
  invalid.downloads.download = async () => undefined;
  const invalidResult = await invalid.controller.download(["a"]);
  assert.equal(invalidResult.completed, 0);
  assert.match(invalidResult.failures[0].message, /did not start/);
  assert.equal(invalid.listeners.size, 0);
  assert.equal(invalid.revoked.length, 1);

  const unknown = harness(undefined, { manual: true });
  unknown.downloads.search = async () => { throw new Error("Status unavailable"); };
  const unknownResult = await unknown.controller.download(["a"]);
  assert.equal(unknownResult.completed, 0);
  assert.match(unknownResult.failures[0].message, /could not confirm/);
  assert.equal(unknown.listeners.size, 0);
  assert.equal(unknown.revoked.length, 1);
});

test("an observed Chrome completion remains successful if the status query subsequently rejects", async () => {
  const h = harness(undefined, { manual: true });
  h.downloads.search = async () => {
    h.finish(1);
    throw new Error("Query became unavailable");
  };
  const result = await h.controller.download(["a"]);
  assert.equal(result.status, "complete");
  assert.equal(result.completed, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.erasedListeners.size, 0);
});

test("erasing only this job's Chrome download status reports unconfirmed completion without hanging", async () => {
  const h = harness(undefined, { manual: true });
  const pending = h.controller.download(["a"]);
  await tick();
  for (const listener of h.erasedListeners) listener(999);
  assert.equal(h.controller.isBusy(), true);
  for (const listener of h.erasedListeners) listener(1);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 0);
  assert.match(result.failures[0].message, /before completion could be confirmed/);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.erasedListeners.size, 0);
  assert.equal(h.revoked.length, 1);
});
