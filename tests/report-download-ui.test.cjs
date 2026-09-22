const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const root = path.join(__dirname, "..", "extension");
const source = fs.readFileSync(path.join(root, "tagger/sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(root, "tagger/sidepanel.html"), "utf8");

function functionSource(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end + 4);
}

function harness(overrides = {}) {
  const progress = [];
  const calls = [];
  const context = vm.createContext({
    reportDownloadBusy: false, reportMutationBusy: false, reportRenameBusy: false,
    streamReportsLoading: false, reportDownloadController: null,
    renderStreamReportsPanel() {}, renderReportDownloadProgress: (value) => progress.push(value),
    streamReportClient: { getReport: async ({ reportId }) => ({ reportId, report: {} }) },
    chrome: { downloads: {}, runtime: {} }, Blob, URL,
    TikTokLiveTrackerReportPdf: { generateReportPdf() {} },
    TikTokLiveTrackerReportDownloads: {
      createReportDownloadController(options) {
        calls.push(options);
        return { download: async (ids) => ({ status: "complete", total: ids.length, completed: ids.length, message: "Downloaded." }) };
      },
    },
    ...overrides,
  });
  vm.runInContext(functionSource("runReportDownload"), context);
  return { context, progress, calls, run: (ids) => context.runReportDownload(ids) };
}

test("both report tiers share the Download PDF menu action without opening a print dialog", () => {
  const menu = functionSource("createStreamReportLink");
  const action = menu.indexOf('createReportMenuAction("Download PDF", "download-pdf"');
  assert.ok(action > 0 && action < menu.indexOf("if (!archived)"));
  assert.match(menu, /runReportDownload\(\[summary\.reportId\]\)/);
  assert.match(menu, /moreButton\.disabled = reportMutationBusy \|\| reportDownloadBusy/);
  assert.doesNotMatch(functionSource("runReportDownload"), /\.print\(|openStreamReport\(|tabs\.create/);
});

test("archived downloads reuse the existing selection and accessible progress areas", () => {
  assert.match(source, /downloadSelectedReportsButton\.addEventListener\("click", \(\) => \{\s*void runReportDownload\(\[\.\.\.selectedArchivedReportIds\]\)/);
  assert.match(html, /id="download-selected-reports"[^>]*disabled>\s*Download selected/);
  for (const id of ["stream-report-download-status", "archived-report-download-status"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden`));
  }
});

test("Download selected is disabled for empty, loading, mutation and downloading states", () => {
  for (const state of [ {}, { selectedArchivedReportIds: new Set() },
    { reportDownloadBusy: true }, { reportMutationBusy: true }, { streamReportsLoading: true } ]) {
    const context = vm.createContext({
      selectedArchivedReportIds: new Set(["a"]), archivedReportSummaries: [{ reportId: "a" }],
      archivedSelectionMode: true, reportMutationBusy: false, reportDownloadBusy: false,
      streamReportsLoading: false, getAvailableDashboardReportSlots: () => 2,
      ...Object.fromEntries(["archivedSelectionToolbar", "archivedSelectionSummary", "selectAllArchivedReportsButton", "clearArchivedSelectionButton", "restoreSelectedReportsButton", "deleteSelectedReportsButton", "downloadSelectedReportsButton", "archivedRestoreGuidance"].map((key) => [key, {}])),
      toggleArchivedSelectionButton: { setAttribute() {} }, ...state,
    });
    vm.runInContext(functionSource("renderArchivedSelectionControls") + "\nrenderArchivedSelectionControls();", context);
    assert.equal(context.downloadSelectedReportsButton.disabled, Object.keys(state).length > 0);
  }
});

test("empty and busy invocations do not create a controller or read records", async () => {
  for (const override of [{}, { reportDownloadBusy: true }, { reportMutationBusy: true }, { reportRenameBusy: true }, { streamReportsLoading: true }]) {
    const h = harness(override);
    await h.run(Object.keys(override).length ? ["a"] : []);
    assert.equal(h.calls.length, 0);
  }
});

test("UI snapshots IDs, rejects repeated clicks, and leaves selections and report data alone", async () => {
  let finish;
  let received;
  let invocations = 0;
  const h = harness({ reportDownloadController: {
    download(ids) { invocations++; received = ids; return new Promise((resolve) => { finish = resolve; }); },
  } });
  const selected = ["a", "b"];
  const pending = h.run(selected);
  selected.splice(0, 2, "c");
  await h.run(["c"]);
  assert.equal(invocations, 1);
  assert.deepEqual(Array.from(received), ["a", "b"]);
  assert.equal(h.context.reportDownloadBusy, true);
  finish({ status: "partial", total: 2, completed: 1, failures: [{ name: "b", message: "Interrupted" }], message: "1 of 2 PDFs downloaded. 1 failed." });
  await pending;
  assert.equal(h.context.reportDownloadBusy, false);
  assert.equal(h.progress.at(-1).status, "partial");
  assert.deepEqual(selected, ["c"]);
  assert.doesNotMatch(functionSource("runReportDownload"), /(?:rename|archive|delete|restore)Reports?\(|storage\.|selectedArchivedReportIds\.(?:clear|delete)/);
});

test("controller wiring reads reports only and restores UI after an unexpected failure", async () => {
  const h = harness();
  await h.run(["a"]);
  assert.deepEqual(await h.calls[0].getReport("a"), { reportId: "a", report: {} });
  assert.equal(h.calls[0].downloads, h.context.chrome.downloads);
  assert.equal(h.context.reportDownloadBusy, false);
  h.context.reportDownloadController = { download: async () => { throw new Error("Synthetic error"); } };
  await h.run(["a"]);
  assert.equal(h.context.reportDownloadBusy, false);
  assert.equal(h.progress.at(-1).message, "Synthetic error");
  assert.equal(h.progress.at(-1).status, "failed");
});

test("progress exposes conflicts, per-file failures, and keep-open guidance as plain text", () => {
  const elements = [{ dataset: {} }, { dataset: {} }];
  const context = vm.createContext({ reportDownloadStatusElements: elements });
  vm.runInContext(functionSource("renderReportDownloadProgress"), context);
  context.renderReportDownloadProgress({ phase: "downloading", total: 3, completed: 1, failed: 1, name: "<example>" });
  assert.match(elements[0].textContent, /1 of 3 PDFs downloaded; 1 failed/);
  assert.match(elements[0].textContent, /Keep the tracker panel open/);
  context.renderReportDownloadProgress({ status: "duplicate", message: "Some selected reports have duplicate filenames. Rename them or deselect duplicates before downloading.", conflicts: [[{ name: "A:B", filename: "A-B.pdf" }, { name: "A?B", filename: "A-B.pdf" }]] });
  assert.match(elements[0].textContent, /"A:B" and "A\?B" -> A-B.pdf/);
  assert.match(elements[0].textContent, /No PDFs were downloaded/);
  assert.equal(elements[0].dataset.error, "true");
  context.renderReportDownloadProgress({ status: "partial", message: "1 of 2 PDFs downloaded. 1 failed.", failures: [{ name: "B", message: "Interrupted" }] });
  assert.match(elements[0].textContent, /B: Interrupted/);
  assert.deepEqual(elements[0], elements[1]);
  assert.doesNotMatch(functionSource("renderReportDownloadProgress"), /innerHTML/);
});

test("bundled local scripts load in dependency order and no extra host permissions are added", () => {
  let previous = -1;
  for (const script of ["tiktok-fee-calculator.js", "jspdf.umd.min.js", "jspdf.plugin.autotable.min.js", "report-downloads.js", "report-page.js", "report-pdf.js", "sidepanel.js"]) {
    const offset = html.indexOf(script);
    assert.ok(offset > previous, `${script} dependency order`);
    previous = offset;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.deepEqual(manifest.host_permissions, ["https://sheets.googleapis.com/*"]);
});

test("official PDF bundles and fonts remain pinned with their licenses", () => {
  for (const [file, hash] of [
    ["jspdf/jspdf.umd.min.js", "e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54"],
    ["jspdf-autotable/jspdf.plugin.autotable.min.js", "a65dff2c6a8296b16aff24e69f7683cd7dbaed4a4ec26b507d6840ee27d54649"],
    ["fonts/DejaVuSans.ttf", "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954"],
    ["fonts/DejaVuSans-Bold.ttf", "e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724"],
  ]) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(root, "vendor", file))).digest("hex"), hash);
  }
  for (const license of ["jspdf/LICENSE", "jspdf-autotable/LICENSE.txt", "fonts/LICENSE-DejaVu.txt"]) {
    assert.ok(fs.readFileSync(path.join(root, "vendor", license), "utf8").length > 500);
  }
});
