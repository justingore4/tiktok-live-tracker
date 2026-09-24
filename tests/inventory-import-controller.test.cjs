const assert = require("node:assert/strict");
const test = require("node:test");

const {
  InventoryImportControllerError,
  createInventoryImportController,
  requireImportStatus,
} = require("../extension/tagger/inventory-import-controller.js");

const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_1234567890";
const PREVIEW_TOKEN =
  "inventory-preview:11111111-1111-4111-8111-111111111111";
const SUMMARY = {
  rowCount: 1,
  totalQuantityOnHandAtImport: 3,
  totalInventoryCostCents: 3750,
};
const PREVIEW = {
  contractVersion: 1,
  previewToken: PREVIEW_TOKEN,
  spreadsheetId: SHEET_ID,
  range: "'Inventory'!A:F",
  fingerprint: "fnv1a64:0123456789abcdef",
  inventory: [
    {
      sku: "TEE-BLACK-M",
      item: "Stussy tee",
      style: "black",
      size: "M",
      quantityOnHandAtImport: 3,
      unitCostCents: 1250,
    },
  ],
  summary: SUMMARY,
  expiresAt: "2026-08-08T20:10:00.000Z",
};
const CONFIRMATION = {
  baselineId: "inventory-baseline:22222222-2222-4222-8222-222222222222",
  sourceFingerprint: "fnv1a64:0123456789abcdef",
  summary: SUMMARY,
};

function notReadyStatus() {
  return {
    ready: false,
    baselineId: null,
    sourceFingerprint: null,
    summary: null,
  };
}

function createClient(overrides = {}) {
  return {
    getImportStatus: async () => notReadyStatus(),
    normalizeReference: () => SHEET_ID,
    previewSpreadsheetId: async () => PREVIEW,
    confirmPreview: async () => CONFIRMATION,
    ...overrides,
  };
}

test("loads durable import readiness without inspecting reconciliation state", async () => {
  const controller = createInventoryImportController({
    client: createClient({
      getImportStatus: async () => ({ ready: true, ...CONFIRMATION }),
    }),
  });

  const snapshot = await controller.start();
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.hasConfirmedBaseline, true);
  assert.deepEqual(snapshot.confirmation, CONFIRMATION);
});

test("refreshes durable readiness after an active stream ends", async () => {
  let ready = false;
  const controller = createInventoryImportController({
    client: createClient({
      getImportStatus: async () =>
        ready ? { ready: true, ...CONFIRMATION } : notReadyStatus(),
    }),
  });

  assert.equal((await controller.start()).hasConfirmedBaseline, false);
  controller.setActiveStream(true);
  controller.setActiveStream(false);
  ready = true;
  assert.equal((await controller.refreshStatus()).hasConfirmedBaseline, true);
});

test("previews detached rows then confirms a baseline explicitly", async () => {
  const calls = [];
  const controller = createInventoryImportController({
    client: createClient({
      normalizeReference(reference) {
        calls.push(["normalize", reference]);
        return SHEET_ID;
      },
      async previewSpreadsheetId(spreadsheetId) {
        calls.push(["preview", spreadsheetId]);
        return PREVIEW;
      },
      async confirmPreview(token) {
        calls.push(["confirm", token]);
        return CONFIRMATION;
      },
    }),
  });

  await controller.start();
  const previewed = await controller.previewReference("a sharing link");
  assert.equal(previewed.hasConfirmedBaseline, false);
  assert.deepEqual(previewed.preview, PREVIEW);

  const confirmed = await controller.confirmPreview();
  assert.equal(confirmed.hasConfirmedBaseline, true);
  assert.equal(confirmed.preview, null);
  assert.deepEqual(confirmed.confirmation, CONFIRMATION);
  assert.deepEqual(calls, [
    ["normalize", "a sharing link"],
    ["preview", SHEET_ID],
    ["confirm", PREVIEW_TOKEN],
  ]);
});

test("preview controller rejects whole-tab, wider, and row-capped range contracts", async () => {
  for (const range of ["'Inventory'", "'Inventory'!A:G", "'Inventory'!A1:F1001"]) {
    const controller = createInventoryImportController({
      client: createClient({ previewSpreadsheetId: async () => ({ ...PREVIEW, range }) }),
    });
    await controller.start();
    const failed = await controller.previewReference(SHEET_ID);
    assert.equal(failed.phase, "error", range);
    assert.equal(failed.error.code, "INVALID_CLIENT_RESPONSE", range);
    assert.equal(failed.preview, null, range);
    assert.equal(failed.hasConfirmedBaseline, false, range);
  }
});

test("canceling a replacement preview retains the confirmed baseline identity", async () => {
  const controller = createInventoryImportController({
    client: createClient({
      getImportStatus: async () => ({ ready: true, ...CONFIRMATION }),
    }),
  });

  await controller.start();
  const previewed = await controller.previewReference(SHEET_ID);
  assert.equal(previewed.hasConfirmedBaseline, true);
  assert.deepEqual(previewed.confirmation, CONFIRMATION);
  assert.deepEqual(previewed.preview, PREVIEW);

  const canceled = controller.resetPreview();
  assert.equal(canceled.hasConfirmedBaseline, true);
  assert.deepEqual(canceled.confirmation, CONFIRMATION);
  assert.equal(canceled.preview, null);
});

test("retains sanitized validation issues and retries the same detached Sheet ID", async () => {
  let attempts = 0;
  const validationFailure = Object.assign(new Error("Fix the Inventory tab."), {
    code: "INVALID_INVENTORY_SHEET",
    issues: [
      {
        code: "REQUIRED_VALUE",
        rowNumber: 5,
        column: "size",
        message: "size is required.",
      },
      {
        code: "EMPTY_INVENTORY",
        rowNumber: null,
        column: null,
        message: "Inventory is empty.",
      },
    ],
  });
  const controller = createInventoryImportController({
    client: createClient({
      normalizeReference: () => SHEET_ID,
      async previewSpreadsheetId() {
        attempts += 1;
        if (attempts === 1) {
          throw validationFailure;
        }
        return PREVIEW;
      },
    }),
  });

  await controller.start();
  const failed = await controller.previewReference("sharing link is not retained");
  assert.equal(failed.phase, "error");
  assert.equal(failed.error.code, "INVALID_INVENTORY_SHEET");
  assert.deepEqual(failed.error.issues, validationFailure.issues);
  assert.equal(JSON.stringify(failed).includes("sharing link is not retained"), false);

  const retried = await controller.retry();
  assert.equal(retried.phase, "ready");
  assert.deepEqual(retried.preview, PREVIEW);
  assert.equal(attempts, 2);
});

test("bounds defensive error and issue text before publishing it", async () => {
  const controller = createInventoryImportController({
    client: createClient({
      normalizeReference() {
        throw Object.assign(new Error(` message ${"X".repeat(600)} `), {
          code: ` CODE_${"Y".repeat(100)} `,
          issues: [{
            code: ` ISSUE_${"C".repeat(100)} `,
            rowNumber: 2,
            column: ` column_${"N".repeat(100)} `,
            message: ` issue ${"M".repeat(600)} `,
          }],
        });
      },
    }),
  });

  await controller.start();
  const snapshot = await controller.previewReference("unsafe response text");

  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.error.code.length, 80);
  assert.equal(snapshot.error.message.length, 500);
  assert.equal(snapshot.error.issues[0].code.length, 80);
  assert.equal(snapshot.error.issues[0].column.length, 80);
  assert.equal(snapshot.error.issues[0].message.length, 500);
});

test("blocks import while a stream exists and discards an in-flight preview", async () => {
  let resolvePreview;
  const controller = createInventoryImportController({
    client: createClient({
      previewSpreadsheetId: () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    }),
  });
  await controller.start();

  const pending = controller.previewReference(SHEET_ID);
  await Promise.resolve();
  controller.setActiveStream(true);
  resolvePreview(PREVIEW);
  const ignored = await pending;
  assert.equal(ignored.activeStream, true);
  assert.equal(ignored.preview, null);
  assert.equal(ignored.phase, "ready");

  assert.throws(
    () => controller.previewReference(SHEET_ID),
    (error) =>
      error instanceof InventoryImportControllerError &&
      error.code === "ACTIVE_STREAM_ALREADY_EXISTS",
  );
});

test("fails closed on malformed import status and preview responses", async () => {
  assert.throws(
    () => requireImportStatus({ ready: true, ...CONFIRMATION, extra: true }),
    (error) => error.code === "INVALID_CLIENT_RESPONSE",
  );

  const controller = createInventoryImportController({
    client: createClient({ previewSpreadsheetId: async () => ({ inventory: [] }) }),
  });
  await controller.start();
  const snapshot = await controller.previewReference(SHEET_ID);
  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.error.code, "INVALID_CLIENT_RESPONSE");
  assert.equal(snapshot.preview, null);
});
