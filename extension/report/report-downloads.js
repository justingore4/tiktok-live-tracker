(function initializeReportDownloads(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerReportDownloads = api;
})(typeof globalThis === "undefined" ? this : globalThis, function (root) {
  "use strict";

  const DUPLICATE_FILENAMES_MESSAGE =
    "Some selected reports have duplicate filenames. Rename them or deselect duplicates before downloading.";
  const MAX_FILENAME_BASE_BYTES = 180;

  function getReportDisplayName(record) {
    if (typeof record?.displayName === "string" && record.displayName.trim()) {
      return record.displayName;
    }
    const value = record?.report?.metadata?.startedAt;
    const date = typeof value === "string" ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date)
      : "Saved stream";
  }

  function createPdfFilename(name) {
    let base = String(name ?? "")
      .normalize("NFC")
      .replace(/[\ud800-\udfff]/gu, "\ufffd")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, "-")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
      .trim()
      .replace(/[. ]+$/g, "")
      .replace(/\.pdf$/i, "")
      .replace(/[. ]+$/g, "");
    // Windows device names are reserved even when followed by an extension.
    if (/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:[ .]|$)/i.test(base)) {
      base = `_${base}`;
    }
    let truncated = "";
    let bytes = 0;
    for (const character of base) {
      const point = character.codePointAt(0);
      const length = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes + length > MAX_FILENAME_BASE_BYTES) break;
      truncated += character;
      bytes += length;
    }
    base = truncated.replace(/[. ]+$/g, "");
    return `${base || "Saved stream"}.pdf`;
  }

  function findFilenameConflicts(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const key = entry.filename.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        reportId: entry.reportId,
        name: entry.name,
        filename: entry.filename,
      });
    }
    return Array.from(groups.values()).filter((group) => group.length > 1);
  }

  function createReportDownloadController(options) {
    const {
      getReport,
      generatePdf,
      downloads = root.chrome?.downloads,
      Blob: BlobConstructor = root.Blob,
      URL: urlApi = root.URL,
      runtime = root.chrome?.runtime,
      getDisplayName = getReportDisplayName,
      onProgress = () => {},
    } = options;
    let busy = false;

    function emit(progress) {
      // A UI rendering error must not turn a successful download into a failure.
      try { onProgress(progress); } catch (_) { /* The export remains independent. */ }
    }

    function chromeCall(method, argument) {
      return new Promise((resolve, reject) => {
        let settled = false;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve(value);
        }
        try {
          const returned = downloads[method](argument, (value) => {
            const error = runtime?.lastError;
            finish(error ? new Error(error.message || "Chrome download failed.") : null, value);
          });
          if (returned && typeof returned.then === "function") {
            returned.then((value) => finish(null, value), (error) => finish(error));
          }
        } catch (error) { finish(error); }
      });
    }

    async function downloadBytes(bytes, filename) {
      let objectUrl;
      let listener;
      let erasedListener;
      let downloadId;
      let settled = false;
      let resolveTerminal;
      let rejectTerminal;
      const terminal = new Promise((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      });
      // Errors can arrive before the download-start callback resolves.
      terminal.catch(() => {});
      function inspectState(state, error) {
        if (settled) return;
        if (state === "complete") {
          settled = true;
          resolveTerminal(downloadId);
        } else if (state === "interrupted") {
          settled = true;
          rejectTerminal(new Error(`Download interrupted${error ? `: ${error}` : "."}`));
        }
      }
      try {
        objectUrl = urlApi.createObjectURL(new BlobConstructor([bytes], { type: "application/pdf" }));
        listener = (change) => {
          if (downloadId === undefined || change.id !== downloadId) return;
          inspectState(change.state?.current, change.error?.current);
        };
        downloads.onChanged.addListener(listener);
        if (typeof downloads.onErased?.addListener === "function" &&
            typeof downloads.onErased?.removeListener === "function") {
          erasedListener = (erasedId) => {
            if (downloadId === undefined || erasedId !== downloadId || settled) return;
            settled = true;
            rejectTerminal(new Error("Chrome removed the download status before completion could be confirmed."));
          };
          downloads.onErased.addListener(erasedListener);
        }
        downloadId = await chromeCall("download", {
          url: objectUrl,
          filename,
          saveAs: false,
          // This only protects an existing disk file. Batch collisions were already rejected.
          conflictAction: "uniquify",
        });
        if (!Number.isInteger(downloadId) || downloadId < 0) {
          throw new Error("Chrome did not start the PDF download.");
        }
        // Inspect only our new ID, resolving completion before the start callback/listener.
        let items;
        try {
          items = await chromeCall("search", { id: downloadId });
        } catch (error) {
          if (settled) return await terminal;
          throw new Error(`Chrome could not confirm the PDF download: ${error?.message || "status unavailable"}`);
        }
        const ownItem = Array.isArray(items) ? items.find((item) => item.id === downloadId) : null;
        if (!ownItem && !settled) throw new Error("Chrome could not confirm the PDF download.");
        if (ownItem) inspectState(ownItem.state, ownItem.error);
        return await terminal;
      } finally {
        if (listener) downloads.onChanged.removeListener(listener);
        if (erasedListener) downloads.onErased.removeListener(erasedListener);
        if (objectUrl) urlApi.revokeObjectURL(objectUrl);
      }
    }

    async function download(reportIds) {
      if (busy) return { status: "busy", total: 0, completed: 0, failures: [], message: "A PDF download job is already running." };
      // Copy synchronously, before any await; later checkbox changes cannot alter this job.
      const ids = Array.from(new Set(reportIds || []));
      if (!ids.length) return { status: "empty", total: 0, completed: 0, failures: [], message: "Select at least one report to download." };
      busy = true;
      const total = ids.length;
      const failures = [];
      let completed = 0;
      const entries = [];
      emit({ phase: "preflight", total, completed, failed: 0 });
      try {
        if (typeof downloads?.download !== "function" ||
            typeof downloads?.search !== "function" ||
            typeof downloads?.onChanged?.addListener !== "function" ||
            typeof downloads?.onChanged?.removeListener !== "function") {
          throw new Error("PDF downloads are unavailable. Reload the updated extension and check its downloads permission.");
        }
        // Fetch and validate every name before generating a PDF or starting a download.
        for (const reportId of ids) {
          const record = await getReport(reportId);
          if (!record || !record.report) throw new Error(`Could not load report ${reportId}. No PDFs were downloaded.`);
          const name = getDisplayName(record);
          entries.push({ reportId, record, name, filename: createPdfFilename(name) });
        }
        const conflicts = findFilenameConflicts(entries);
        if (conflicts.length) {
          const result = { status: "duplicate", total, completed, failures, conflicts, message: DUPLICATE_FILENAMES_MESSAGE };
          emit({ phase: result.status, total, completed, failed: 0, ...result });
          return result;
        }
        for (const entry of entries) {
          const progress = { total, completed, failed: failures.length, reportId: entry.reportId, name: entry.name, filename: entry.filename };
          try {
            emit({ ...progress, phase: "generating" });
            const bytes = await generatePdf(entry.record);
            if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
              throw new Error("PDF generation did not produce a file.");
            }
            emit({ ...progress, phase: "downloading" });
            await downloadBytes(bytes, entry.filename);
            completed += 1;
          } catch (error) {
            failures.push({ reportId: entry.reportId, name: entry.name, filename: entry.filename, message: error?.message || "The PDF download failed." });
          }
        }
        const status = failures.length ? (completed ? "partial" : "failed") : "complete";
        const message = failures.length
          ? `${completed} of ${total} PDFs downloaded. ${failures.length} failed.`
          : `${completed} ${completed === 1 ? "PDF" : "PDFs"} downloaded.`;
        const result = { status, total, completed, failures, message };
        emit({ phase: status, failed: failures.length, ...result });
        return result;
      } catch (error) {
        const message = `${error?.message || "Could not prepare the PDF downloads."}${completed === 0 && !String(error?.message).includes("No PDFs were downloaded.") ? " No PDFs were downloaded." : ""}`;
        const result = { status: "failed", total, completed, failures: [{ message }], message };
        emit({ phase: "failed", failed: total, ...result });
        return result;
      } finally { busy = false; }
    }

    return { download, isBusy: () => busy };
  }

  return { DUPLICATE_FILENAMES_MESSAGE, MAX_FILENAME_BASE_BYTES, createPdfFilename, getReportDisplayName, findFilenameConflicts, createReportDownloadController };
});
