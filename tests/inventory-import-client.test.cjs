const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require("../extension/shared/inventory-import-protocol.js");
const {
  InventoryImportClientError,
  createInventoryImportClient,
  parseGoogleSheetReference,
} = require("../extension/tagger/inventory-import-client.js");

const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_1234567890";
const PREVIEW_TOKEN =
  "inventory-preview:11111111-1111-4111-8111-111111111111";
const BASELINE_ID =
  "inventory-baseline:22222222-2222-4222-8222-222222222222";
const FINGERPRINT = "fnv1a64:0123456789abcdef";
const SUMMARY = Object.freeze({
  rowCount: 1,
  totalQuantityOnHandAtImport: 3,
  totalInventoryCostCents: 3750,
});
const INVENTORY = Object.freeze([
  Object.freeze({
    sku: "TEE-BLACK-M",
    item: "Stussy tee",
    style: "black",
    size: "M",
    quantityOnHandAtImport: 3,
    unitCostCents: 1250,
  }),
]);

function ok(data) {
  return { ok: true, data };
}

function previewData() {
  return {
    status: "ready",
    contractVersion: 1,
    previewToken: PREVIEW_TOKEN,
    spreadsheetId: SHEET_ID,
    range: "'Inventory'",
    fingerprint: FINGERPRINT,
    inventory: INVENTORY,
    summary: SUMMARY,
    expiresAt: "2026-08-08T20:10:00.000Z",
  };
}

test("accepts an exact Sheet ID and common safe Google Sheets sharing links", () => {
  assert.equal(parseGoogleSheetReference(SHEET_ID), SHEET_ID);
  assert.equal(
    parseGoogleSheetReference(
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing#gid=0`,
    ),
    SHEET_ID,
  );
  assert.equal(
    parseGoogleSheetReference(
      `https://docs.google.com/spreadsheets/u/0/d/${SHEET_ID}/edit#gid=123`,
    ),
    SHEET_ID,
  );
});

test("rejects ambiguous, insecure, and lookalike Sheet references", () => {
  [
    "",
    "too-short",
    `http://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    `https://evil.example/spreadsheets/d/${SHEET_ID}/edit`,
    `https://docs.google.com.evil.example/spreadsheets/d/${SHEET_ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/unexpected/path`,
    `https://user:secret@docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
  ].forEach((reference) => {
    assert.throws(
      () => parseGoogleSheetReference(reference),
      (error) =>
        error instanceof InventoryImportClientError &&
        error.code === "INVALID_SPREADSHEET_REFERENCE",
    );
  });
});

test("sends only the extracted ID and strictly parses status, preview, and confirmation", async () => {
  const messages = [];
  const responses = [
    ok({
      ready: false,
      baselineId: null,
      sourceFingerprint: null,
      summary: null,
    }),
    ok(previewData()),
    ok({
      status: "imported",
      baselineId: BASELINE_ID,
      sourceFingerprint: FINGERPRINT,
      summary: SUMMARY,
    }),
  ];
  const client = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage(message) {
        messages.push(message);
        return Promise.resolve(responses.shift());
      },
    },
  });

  assert.deepEqual(await client.getImportStatus(), {
    ready: false,
    baselineId: null,
    sourceFingerprint: null,
    summary: null,
  });
  const sharingLink =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`;
  const preview = await client.previewReference(sharingLink);
  assert.equal(preview.previewToken, PREVIEW_TOKEN);
  assert.equal(preview.contractVersion, 1);
  assert.equal(Object.hasOwn(preview, "status"), false);
  const confirmed = await client.confirmPreview(PREVIEW_TOKEN);
  assert.equal(confirmed.baselineId, BASELINE_ID);
  assert.equal(Object.hasOwn(confirmed, "status"), false);

  assert.deepEqual(messages, [
    protocol.createInventoryImportMessage({
      type: protocol.COMMAND_TYPES.GET_IMPORT_STATUS,
    }),
    protocol.createInventoryImportMessage({
      type: protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
      spreadsheetId: SHEET_ID,
    }),
    protocol.createInventoryImportMessage({
      type: protocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT,
      previewToken: PREVIEW_TOKEN,
    }),
  ]);
  assert.equal(JSON.stringify(messages).includes(sharingLink), false);
});

test("turns a sanitized invalid preview union into one typed issue error", async () => {
  const issues = [
    {
      code: "REQUIRED_VALUE",
      rowNumber: 4,
      column: "sku",
      message: "sku is required.",
    },
    {
      code: "EMPTY_INVENTORY",
      rowNumber: null,
      column: null,
      message: "Inventory must contain at least one data row.",
    },
  ];
  const client = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage: () => Promise.resolve(ok({ status: "invalid", issues })),
    },
  });

  await assert.rejects(
    client.previewReference(SHEET_ID),
    (error) => {
      assert.ok(error instanceof InventoryImportClientError);
      assert.equal(error.code, "INVALID_INVENTORY_SHEET");
      assert.deepEqual(error.issues, issues);
      return true;
    },
  );
});

test("rejects malformed success data and preserves safe worker errors", async () => {
  const malformedClient = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage: () => Promise.resolve(ok({ ...previewData(), contractVersion: 2 })),
    },
  });
  await assert.rejects(
    malformedClient.previewReference(SHEET_ID),
    (error) => error.code === "INVALID_RESPONSE",
  );

  const deniedClient = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: "GOOGLE_SHEETS_PERMISSION_DENIED",
            message: "Google Sheets did not grant access to this spreadsheet.",
          },
        }),
    },
  });
  await assert.rejects(
    deniedClient.previewReference(SHEET_ID),
    (error) => error.code === "GOOGLE_SHEETS_PERMISSION_DENIED",
  );

  for (const error of [
    { code: "X".repeat(81), message: "safe" },
    { code: "SAFE_ERROR", message: "X".repeat(501) },
  ]) {
    const oversizedErrorClient = createInventoryImportClient({
      protocol,
      runtime: {
        sendMessage: () => Promise.resolve({ ok: false, error }),
      },
    });

    await assert.rejects(
      oversizedErrorClient.previewReference(SHEET_ID),
      (failure) => failure.code === "INVALID_RESPONSE",
    );
  }
});

test("rejects a preview above the bounded 1,000-row review limit", async () => {
  const oversized = previewData();
  oversized.inventory = Array.from({ length: 1_001 }, (_value, index) => ({
    ...INVENTORY[0],
    sku: `SKU-${String(index).padStart(4, "0")}`,
  }));
  oversized.summary = {
    ...SUMMARY,
    rowCount: oversized.inventory.length,
  };
  const client = createInventoryImportClient({
    protocol,
    runtime: { sendMessage: () => Promise.resolve(ok(oversized)) },
  });

  await assert.rejects(
    client.previewReference(SHEET_ID),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("serializes client commands so confirm cannot overtake preview", async () => {
  let resolvePreview;
  const calls = [];
  const client = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage(message) {
        calls.push(message.command.type);
        if (message.command.type === protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET) {
          return new Promise((resolve) => {
            resolvePreview = resolve;
          });
        }

        return Promise.resolve(ok({
          status: "imported",
          baselineId: BASELINE_ID,
          sourceFingerprint: FINGERPRINT,
          summary: SUMMARY,
        }));
      },
    },
  });

  const previewPromise = client.previewReference(SHEET_ID);
  const confirmPromise = client.confirmPreview(PREVIEW_TOKEN);
  await Promise.resolve();
  assert.deepEqual(calls, [protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET]);

  resolvePreview(ok(previewData()));
  await previewPromise;
  await confirmPromise;
  assert.deepEqual(calls, [
    protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
    protocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT,
  ]);
});

test("gets a strict local active-baseline preview", async () => {
  const messages = [];
  const readyData = {
    ready: true,
    baselineId: BASELINE_ID,
    inventory: INVENTORY,
    summary: SUMMARY,
  };
  const client = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage(message) {
        messages.push(message);
        return Promise.resolve(ok(readyData));
      },
    },
  });

  const result = await client.getActiveBaselinePreview();
  assert.deepEqual(result, readyData);
  assert.notEqual(result, readyData);
  assert.notEqual(result.inventory, readyData.inventory);
  assert.deepEqual(messages, [
    protocol.createInventoryImportMessage({
      type: protocol.COMMAND_TYPES.GET_ACTIVE_BASELINE_PREVIEW,
    }),
  ]);
});

test("strictly validates unavailable and ready active-baseline previews", async () => {
  const invalidResponses = [
    {
      ready: false,
      baselineId: null,
      inventory: [],
      summary: null,
    },
    {
      ready: true,
      baselineId: BASELINE_ID,
      inventory: [],
      summary: { ...SUMMARY, rowCount: 0 },
    },
    {
      ready: true,
      baselineId: "not-a-baseline",
      inventory: INVENTORY,
      summary: SUMMARY,
    },
    {
      ready: true,
      baselineId: BASELINE_ID,
      inventory: INVENTORY,
      summary: { ...SUMMARY, rowCount: 2 },
    },
    {
      ready: true,
      baselineId: BASELINE_ID,
      inventory: INVENTORY,
      summary: { ...SUMMARY, totalInventoryCostCents: 1 },
    },
    {
      ready: true,
      baselineId: BASELINE_ID,
      inventory: [{ ...INVENTORY[0], unexpected: true }],
      summary: SUMMARY,
    },
    {
      ready: true,
      baselineId: BASELINE_ID,
      inventory: INVENTORY,
      summary: SUMMARY,
      sourceFingerprint: FINGERPRINT,
    },
    {
      ready: true,
      baselineId: BASELINE_ID,
      inventory: [
        INVENTORY[0],
        { ...INVENTORY[0], sku: "TEE-BLACK-L" },
      ],
      summary: {
        rowCount: 2,
        totalQuantityOnHandAtImport: 6,
        totalInventoryCostCents: 7500,
      },
    },
  ];

  for (const data of invalidResponses) {
    const client = createInventoryImportClient({
      protocol,
      runtime: { sendMessage: () => Promise.resolve(ok(data)) },
    });

    await assert.rejects(
      client.getActiveBaselinePreview(),
      (error) => error.code === "INVALID_RESPONSE",
    );
  }

  const unavailableClient = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage: () => Promise.resolve(ok({
        ready: false,
        baselineId: null,
        inventory: null,
        summary: null,
      })),
    },
  });
  assert.deepEqual(await unavailableClient.getActiveBaselinePreview(), {
    ready: false,
    baselineId: null,
    inventory: null,
    summary: null,
  });
});

test("adds active-stream SKUs through an exact worker-owned command", async () => {
  const messages = [];
  const resultData = {
    status: "extended",
    baselineId: BASELINE_ID,
    sourceFingerprint: FINGERPRINT,
    summary: {
      rowCount: 2,
      totalQuantityOnHandAtImport: 5,
      totalInventoryCostCents: 4750,
    },
    addedSkus: ["NEW-SKU"],
  };
  const client = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage(message) {
        messages.push(message);
        return Promise.resolve(ok(resultData));
      },
    },
  });

  const result = await client.addActiveStreamSkusReference(
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
  );

  assert.deepEqual(result, resultData);
  assert.deepEqual(messages, [
    protocol.createInventoryImportMessage({
      type:
        protocol.COMMAND_TYPES.ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
      spreadsheetId: SHEET_ID,
    }),
  ]);
  assert.equal(JSON.stringify(messages).includes("streamId"), false);
  assert.equal(JSON.stringify(messages).includes("baselineId"), false);
});

test("strictly parses active-stream SKU update responses", async () => {
  const invalidSheetClient = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage: () => Promise.resolve(ok({
        status: "invalid",
        issues: [{
          code: "REQUIRED_VALUE",
          rowNumber: 3,
          column: "sku",
          message: "sku is required.",
        }],
      })),
    },
  });
  await assert.rejects(
    invalidSheetClient.addActiveStreamSkusReference(SHEET_ID),
    (error) => error.code === "INVALID_INVENTORY_SHEET",
  );

  const malformedClient = createInventoryImportClient({
    protocol,
    runtime: {
      sendMessage: () => Promise.resolve(ok({
        status: "already_current",
        baselineId: BASELINE_ID,
        sourceFingerprint: FINGERPRINT,
        summary: SUMMARY,
        addedSkus: ["IMPOSSIBLE-ADDITION"],
      })),
    },
  });
  await assert.rejects(
    malformedClient.addActiveStreamSkusReference(SHEET_ID),
    (error) => error.code === "INVALID_RESPONSE",
  );
});
