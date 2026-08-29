const assert = require("node:assert/strict");
const test = require("node:test");

const inventorySheetImport = require(
  "../extension/shared/inventory-sheet-import.js"
);
const googleImport = require(
  "../extension/shared/google-sheets-inventory-import.js"
);

const VALID_CLIENT_ID = "123456789-abcDEF_123.apps.googleusercontent.com";
const SPREADSHEET_ID = "1Abc_def-Ghij234567890";

function gridCell(type, value) {
  return { userEnteredValue: { [type]: value } };
}

function createGridPayload(overrides = {}) {
  const quantity = overrides.quantity ?? 3;
  const unitCost = overrides.unitCost ?? 12.5;
  const skuCell = overrides.skuFormula
    ? gridCell("formulaValue", '=CONCAT("SKU", "-1")')
    : gridCell("stringValue", "SKU-1");
  const headerValues = [
    "sku",
    "item",
    "style",
    "size",
    "quantity_on_hand_at_import",
    "unit_cost",
  ].map((value) => gridCell("stringValue", value));

  if (overrides.extraHeader) {
    headerValues.push(gridCell("stringValue", "unexpected"));
  }

  return {
    sheets: [
      {
        properties: { title: "Inventory" },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              { values: headerValues },
              {
                values: [
                  skuCell,
                  gridCell("stringValue", "Stussy tee"),
                  gridCell("stringValue", "black"),
                  gridCell("stringValue", "L"),
                  gridCell("numberValue", quantity),
                  gridCell("numberValue", unitCost),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function appendGridRow(payload, overrides = {}) {
  payload.sheets[0].data[0].rowData.push({
    values: [
      gridCell("stringValue", overrides.sku ?? "SKU-2"),
      gridCell("stringValue", overrides.item ?? "Limited hoodie"),
      gridCell("stringValue", overrides.style ?? "blue"),
      gridCell("stringValue", overrides.size ?? "M"),
      gridCell("numberValue", overrides.quantity ?? 2),
      gridCell("numberValue", overrides.unitCost ?? 10),
    ],
  });

  return payload;
}

function createResponse(payload, status = 200, headers = null) {
  return {
    status,
    headers,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createHarness(options = {}) {
  const fetchCalls = [];
  const authCalls = [];
  const removedTokens = [];
  const baselineCalls = [];
  const activeChecks = [];
  const activeStreamChecks = [];
  const extensionCalls = [];
  let remainingCreateFailures = options.createFailureCount ?? 0;
  const payloads = [...(options.payloads ?? [createGridPayload()])];
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  let uuidIndex = 0;

  const service = googleImport.createGoogleSheetsInventoryImportService({
    inventorySheetImport,
    oauthClientId: options.oauthClientId ?? VALID_CLIENT_ID,
    identityApi: {
      async getAuthToken(details) {
        authCalls.push(details);

        if (options.authResults) {
          const result = options.authResults[authCalls.length - 1];

          if (result instanceof Error) {
            throw result;
          }

          return result;
        }

        return { token: options.token ?? "secret-access-token" };
      },
      async removeCachedAuthToken(details) {
        removedTokens.push(details);
      },
    },
    async fetchImpl(url, requestOptions) {
      fetchCalls.push({ url, options: requestOptions });

      if (options.fetchImpl) {
        return options.fetchImpl(url, requestOptions, fetchCalls.length);
      }

      if (options.fetchResults) {
        const result = options.fetchResults[fetchCalls.length - 1];

        if (result instanceof Error) {
          throw result;
        }

        return result;
      }

      return createResponse(payloads.shift() ?? createGridPayload());
    },
    async assertNoActiveStream() {
      activeChecks.push(true);

      if (
        options.activeError &&
        (
          options.activeErrorAt === undefined ||
          options.activeErrorAt === activeChecks.length
        )
      ) {
        throw options.activeError;
      }
    },
    async assertActiveStream(streamId) {
      activeStreamChecks.push(streamId);

      if (
        options.activeStreamError &&
        (
          options.activeStreamErrorAt === undefined ||
          options.activeStreamErrorAt === activeStreamChecks.length
        )
      ) {
        throw options.activeStreamError;
      }
    },
    async createBaseline(command) {
      baselineCalls.push(JSON.parse(JSON.stringify(command)));

      if (options.createError && remainingCreateFailures > 0) {
        remainingCreateFailures -= 1;
        throw options.createError;
      }

      return {
        state: {
          version: 4,
          activeInventoryBaselineId: command.baselineId,
          inventoryBaselines: [
            {
              baselineId: command.baselineId,
              sourceFingerprint: command.sourceFingerprint,
              inventory: JSON.parse(JSON.stringify(command.inventory)),
            },
          ],
          streams: [],
        },
        result: { status: "created", baselineId: command.baselineId },
      };
    },
    async extendStreamBaseline(command) {
      extensionCalls.push(JSON.parse(JSON.stringify(command)));

      if (options.extendError) {
        throw options.extendError;
      }

      if (typeof options.extendResponse === "function") {
        return options.extendResponse(command, extensionCalls.length);
      }

      const addedSkus = command.inventory
        .filter((entry) => entry.sku !== "SKU-1")
        .map((entry) => entry.sku);

      return {
        state: {
          version: 7,
          activeInventoryBaselineId: command.baselineId,
          inventoryBaselines: [
            {
              baselineId: command.expectedBaselineId,
              sourceFingerprint: "fnv1a64:0000000000000000",
              inventory: command.inventory.slice(0, 1),
            },
            {
              baselineId: command.baselineId,
              sourceFingerprint: command.sourceFingerprint,
              inventory: JSON.parse(JSON.stringify(command.inventory)),
            },
          ],
          streams: [
            {
              streamId: command.streamId,
              inventoryBaselineId: command.baselineId,
              activeBiddingVariationNumber: null,
              attributedGmvDisplay: null,
              variations: [],
            },
          ],
        },
        result: {
          status: "extended",
          baselineId: command.baselineId,
          previousBaselineId: command.expectedBaselineId,
          addedSkus,
        },
      };
    },
    async getActiveBaseline() {
      return options.activeBaseline ?? null;
    },
    createUuid() {
      return uuids[uuidIndex++];
    },
    now: () =>
      typeof options.now === "function"
        ? options.now()
        : options.now ?? Date.parse("2026-08-08T20:00:00.000Z"),
    abortController: options.abortController ?? false,
    clearTimeoutImpl: options.clearTimeoutImpl,
    setTimeoutImpl: options.setTimeoutImpl,
  });

  return {
    activeChecks,
    activeStreamChecks,
    authCalls,
    baselineCalls,
    extensionCalls,
    fetchCalls,
    removedTokens,
    service,
  };
}

test("adapts user-entered values and preserves formulas for validation", () => {
  const rawValues = googleImport.gridResponseToValues(createGridPayload({
    skuFormula: true,
  }));

  assert.equal(rawValues[1][0], '=CONCAT("SKU", "-1")');
  assert.equal(rawValues[1][4], 3);
  assert.equal(rawValues[1][5], 12.5);
  assert.throws(
    () => inventorySheetImport.parseInventorySheet(rawValues),
    (error) =>
      error.code === "INVALID_INVENTORY_SHEET" &&
      error.issues.some((issue) => issue.code === "FORMULA_NOT_ALLOWED"),
  );
});

test("fills leading physical rows so validation keeps exact row numbers", () => {
  const payload = createGridPayload({ skuFormula: true });
  payload.sheets[0].data[0].startRow = 2;
  const rawValues = googleImport.gridResponseToValues(payload);

  assert.deepEqual(rawValues.slice(0, 2), [[], []]);
  assert.throws(
    () => inventorySheetImport.parseInventorySheet(rawValues),
    (error) =>
      error.issues.some(
        (issue) =>
          issue.code === "FORMULA_NOT_ALLOWED" && issue.rowNumber === 4,
      ),
  );
});

test("rejects more than one thousand inventory rows", () => {
  const payload = createGridPayload();
  const validRow = payload.sheets[0].data[0].rowData[1];
  payload.sheets[0].data[0].rowData = [
    payload.sheets[0].data[0].rowData[0],
    ...Array.from({ length: 1_001 }, () =>
      JSON.parse(JSON.stringify(validRow))),
  ];

  assert.throws(
    () => googleImport.gridResponseToValues(payload),
    (error) => error.code === "INVENTORY_SHEET_TOO_LARGE",
  );
});

test("previews a fixed read-only Inventory range without persisting", async () => {
  const harness = createHarness();
  const result = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  assert.deepEqual(result, {
    status: "ready",
    previewToken:
      "inventory-preview:11111111-1111-4111-8111-111111111111",
    spreadsheetId: SPREADSHEET_ID,
    range: "'Inventory'",
    contractVersion: 1,
    fingerprint: "fnv1a64:f77677917471abd7",
    inventory: [
      {
        sku: "SKU-1",
        item: "Stussy tee",
        style: "black",
        size: "L",
        quantityOnHandAtImport: 3,
        unitCostCents: 1250,
      },
    ],
    summary: {
      rowCount: 1,
      totalQuantityOnHandAtImport: 3,
      totalInventoryCostCents: 3750,
    },
    expiresAt: "2026-08-08T20:10:00.000Z",
  });
  assert.equal(harness.baselineCalls.length, 0);
  assert.equal(harness.activeChecks.length, 2);
  assert.equal(harness.authCalls.length, 1);
  assert.match(
    harness.fetchCalls[0].url,
    /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//,
  );
  assert.match(harness.fetchCalls[0].url, /includeGridData=true/);
  assert.match(harness.fetchCalls[0].url, /Inventory/);
  const requestUrl = new URL(harness.fetchCalls[0].url);
  assert.equal(requestUrl.searchParams.get("ranges"), "'Inventory'");
  assert.equal(requestUrl.searchParams.get("includeGridData"), "true");
  assert.equal(requestUrl.searchParams.get("fields"), googleImport.GRID_FIELDS);
  assert.equal(harness.fetchCalls[0].options.method, "GET");
  assert.equal(harness.fetchCalls[0].options.cache, "no-store");
  assert.equal(harness.fetchCalls[0].options.credentials, "omit");
  assert.equal(harness.fetchCalls[0].options.redirect, "error");
  assert.equal(harness.fetchCalls[0].options.referrerPolicy, "no-referrer");
  assert.equal(
    harness.fetchCalls[0].options.headers.Authorization,
    "Bearer secret-access-token",
  );
});

test("returns sanitized validation issues without a token or partial rows", async () => {
  const harness = createHarness({
    payloads: [createGridPayload({ skuFormula: true })],
  });
  const result = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  assert.equal(result.status, "invalid");
  assert.equal("previewToken" in result, false);
  assert.equal("inventory" in result, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "FORMULA_NOT_ALLOWED"),
  );
  assert.deepEqual(
    Object.keys(result.issues[0]).sort(),
    ["code", "column", "message", "rowNumber"],
  );
});

test("the whole Inventory-tab range still rejects a seventh data column", async () => {
  const payload = createGridPayload();
  payload.sheets[0].data[0].rowData[1].values.push(
    gridCell("stringValue", "unsupported employee note"),
  );
  const harness = createHarness({ payloads: [payload] });

  const result = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  assert.equal(result.status, "invalid");
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "INVALID_SHEET_VALUES" && issue.rowNumber === 2,
    ),
  );
  assert.equal(
    new URL(harness.fetchCalls[0].url).searchParams.get("ranges"),
    "'Inventory'",
  );
});

test("caps validation issues to the client-safe limit", async () => {
  const payload = createGridPayload();
  const header = payload.sheets[0].data[0].rowData[0];
  const invalidRows = Array.from({ length: 150 }, (_unused, index) => ({
    values: [
      gridCell("formulaValue", `=ROW()+${index}`),
      gridCell("stringValue", `Item ${index}`),
      gridCell("stringValue", "black"),
      gridCell("stringValue", `Size ${index}`),
      gridCell("numberValue", 1),
      gridCell("numberValue", 1),
    ],
  }));
  payload.sheets[0].data[0].rowData = [header, ...invalidRows];
  const harness = createHarness({ payloads: [payload] });
  const result = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  assert.equal(result.status, "invalid");
  assert.equal(result.issues.length, 100);
  assert.equal(
    result.issues[99].code,
    "ADDITIONAL_ISSUES_OMITTED",
  );
});

test("confirms only an unchanged re-read preview with worker-owned IDs", async () => {
  const harness = createHarness({
    payloads: [createGridPayload(), createGridPayload()],
  });
  const preview = await harness.service.previewGoogleSheet(SPREADSHEET_ID);
  const imported = await harness.service.confirmGoogleSheetImport(
    preview.previewToken,
  );

  assert.deepEqual(imported, {
    status: "imported",
    baselineId:
      "inventory-baseline:22222222-2222-4222-8222-222222222222",
    sourceFingerprint: preview.fingerprint,
    summary: preview.summary,
  });
  assert.deepEqual(harness.baselineCalls, [
    {
      baselineId:
        "inventory-baseline:22222222-2222-4222-8222-222222222222",
      sourceFingerprint: preview.fingerprint,
      inventory: preview.inventory,
    },
  ]);

  const retried = await harness.service.confirmGoogleSheetImport(
    preview.previewToken,
  );
  assert.deepEqual(retried, imported);
  assert.equal(harness.baselineCalls.length, 1);
  assert.equal(harness.fetchCalls.length, 2);
  assert.deepEqual(harness.authCalls, [
    { interactive: true },
    { interactive: false },
  ]);
});

test("rejects a changed Sheet without creating a baseline", async () => {
  const harness = createHarness({
    payloads: [
      createGridPayload(),
      createGridPayload({ quantity: 4 }),
    ],
  });
  const preview = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  await assert.rejects(
    harness.service.confirmGoogleSheetImport(preview.previewToken),
    (error) => error.code === "STALE_PREVIEW",
  );
  assert.equal(harness.baselineCalls.length, 0);
  await assert.rejects(
    harness.service.confirmGoogleSheetImport(preview.previewToken),
    (error) => error.code === "PREVIEW_NOT_FOUND",
  );
});

test("a new preview invalidates every earlier confirmation token", async () => {
  const harness = createHarness({
    payloads: [createGridPayload(), createGridPayload()],
  });
  const first = await harness.service.previewGoogleSheet(SPREADSHEET_ID);
  const second = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  assert.notEqual(first.previewToken, second.previewToken);
  await assert.rejects(
    harness.service.confirmGoogleSheetImport(first.previewToken),
    (error) => error.code === "PREVIEW_NOT_FOUND",
  );
});

test("an intervening stream lifecycle invalidates every pending preview", async () => {
  const harness = createHarness();
  const preview = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  harness.service.invalidatePreviews();

  await assert.rejects(
    harness.service.confirmGoogleSheetImport(preview.previewToken),
    (error) => error.code === "PREVIEW_NOT_FOUND",
  );
  assert.equal(harness.baselineCalls.length, 0);
});

test("expired previews require a fresh read", async () => {
  let now = Date.parse("2026-08-08T20:00:00.000Z");
  const harness = createHarness({ now: () => now });
  const preview = await harness.service.previewGoogleSheet(SPREADSHEET_ID);
  now += googleImport.PREVIEW_TTL_MS;

  await assert.rejects(
    harness.service.confirmGoogleSheetImport(preview.previewToken),
    (error) => error.code === "PREVIEW_EXPIRED",
  );
});

test("confirmation requires a cached noninteractive authorization token", async () => {
  const harness = createHarness({
    payloads: [createGridPayload()],
    authResults: [
      { token: "preview-token" },
      new Error("no cached token"),
    ],
  });
  const preview = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  await assert.rejects(
    harness.service.confirmGoogleSheetImport(preview.previewToken),
    (error) => error.code === "REAUTHORIZE_REQUIRED",
  );
  assert.deepEqual(harness.authCalls, [
    { interactive: true },
    { interactive: false },
  ]);
  assert.equal(harness.baselineCalls.length, 0);
});

test("a failed durable save retries with the same baseline identity", async () => {
  const harness = createHarness({
    payloads: [
      createGridPayload(),
      createGridPayload(),
      createGridPayload(),
    ],
    createError: new Error("storage unavailable"),
    createFailureCount: 1,
  });
  const preview = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  await assert.rejects(
    harness.service.confirmGoogleSheetImport(preview.previewToken),
    /storage unavailable/,
  );
  const imported = await harness.service.confirmGoogleSheetImport(
    preview.previewToken,
  );

  assert.equal(imported.status, "imported");
  assert.equal(harness.baselineCalls.length, 2);
  assert.equal(
    harness.baselineCalls[0].baselineId,
    harness.baselineCalls[1].baselineId,
  );
});

test("checks active state before OAuth and again immediately before commit", async () => {
  const activeError = new Error("active stream");
  const blockedPreview = createHarness({
    activeError,
    activeErrorAt: 1,
  });

  await assert.rejects(
    blockedPreview.service.previewGoogleSheet(SPREADSHEET_ID),
    activeError,
  );
  assert.equal(blockedPreview.authCalls.length, 0);

  const blockedCommit = createHarness({
    payloads: [createGridPayload(), createGridPayload()],
    activeError,
    activeErrorAt: 4,
  });
  const preview = await blockedCommit.service.previewGoogleSheet(
    SPREADSHEET_ID,
  );

  await assert.rejects(
    blockedCommit.service.confirmGoogleSheetImport(preview.previewToken),
    activeError,
  );
  assert.equal(blockedCommit.baselineCalls.length, 0);
});

test("rejects oversized responses before parsing or retaining previews", async () => {
  const oversizedLength = String(googleImport.MAX_RESPONSE_CHARACTERS + 1);
  const lengthHarness = createHarness({
    fetchResults: [
      createResponse(
        createGridPayload(),
        200,
        { get: () => oversizedLength },
      ),
    ],
  });

  await assert.rejects(
    lengthHarness.service.previewGoogleSheet(SPREADSHEET_ID),
    (error) => error.code === "INVENTORY_SHEET_TOO_LARGE",
  );

  const bodyHarness = createHarness({
    fetchResults: [
      {
        status: 200,
        async text() {
          return "x".repeat(googleImport.MAX_RESPONSE_CHARACTERS + 1);
        },
      },
    ],
  });
  await assert.rejects(
    bodyHarness.service.previewGoogleSheet(SPREADSHEET_ID),
    (error) => error.code === "INVENTORY_SHEET_TOO_LARGE",
  );

  let canceled = false;
  let readCount = 0;
  const streamHarness = createHarness({
    fetchResults: [
      {
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                readCount += 1;
                return {
                  done: false,
                  value: new Uint8Array(
                    Math.floor(googleImport.MAX_RESPONSE_CHARACTERS / 2) + 1,
                  ),
                };
              },
              async cancel() {
                canceled = true;
              },
            };
          },
        },
      },
    ],
  });
  await assert.rejects(
    streamHarness.service.previewGoogleSheet(SPREADSHEET_ID),
    (error) => error.code === "INVENTORY_SHEET_TOO_LARGE",
  );
  assert.equal(readCount, 2);
  assert.equal(canceled, true);
});

test("reports a bounded request timeout while consuming the response body", async () => {
  const controllers = [];
  const cleared = [];
  const scheduledDelays = [];
  class ImmediateAbortController {
    constructor() {
      this.signal = { aborted: false, onabort: null };
      controllers.push(this);
    }

    abort() {
      this.signal.aborted = true;
      this.signal.onabort?.();
    }
  }
  const harness = createHarness({
    abortController: ImmediateAbortController,
    setTimeoutImpl(callback, delayMs) {
      scheduledDelays.push(delayMs);
      queueMicrotask(callback);
      return controllers.length;
    },
    clearTimeoutImpl(timeoutId) {
      cleared.push(timeoutId);
    },
    fetchImpl(_url, requestOptions) {
      return {
        status: 200,
        text() {
          return new Promise((_resolve, reject) => {
            if (requestOptions.signal.aborted) {
              reject(new Error("body timed out"));
              return;
            }

            requestOptions.signal.onabort = () =>
              reject(new Error("body timed out"));
          });
        },
      };
    },
  });

  await assert.rejects(
    harness.service.previewGoogleSheet(SPREADSHEET_ID),
    (error) => error.code === "GOOGLE_SHEETS_REQUEST_TIMEOUT",
  );
  assert.equal(controllers.length, 1);
  assert.deepEqual(scheduledDelays, [20_000]);
  assert.deepEqual(cleared, [1]);
});

test("fails safely before OAuth when the build client ID is a placeholder", async () => {
  const harness = createHarness({
    oauthClientId:
      "REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  });

  await assert.rejects(
    harness.service.previewGoogleSheet(SPREADSHEET_ID),
    (error) => error.code === "GOOGLE_OAUTH_NOT_CONFIGURED",
  );
  assert.equal(harness.authCalls.length, 0);
  assert.equal(harness.fetchCalls.length, 0);
});

test("refreshes a rejected token once and never exposes API response bodies", async () => {
  const harness = createHarness({
    fetchResults: [
      createResponse({ sensitive: "do not expose" }, 401),
      createResponse(createGridPayload(), 200),
    ],
  });

  const result = await harness.service.previewGoogleSheet(SPREADSHEET_ID);

  assert.equal(result.status, "ready");
  assert.equal(harness.authCalls.length, 2);
  assert.deepEqual(harness.removedTokens, [
    { token: "secret-access-token" },
  ]);
});

test("reports readiness only for a persisted imported active baseline", async () => {
  const legacyHarness = createHarness({
    activeBaseline: {
      baselineId:
        "inventory-baseline:00000000-0000-4000-8000-000000000000",
      sourceFingerprint: null,
      inventory: [],
    },
  });
  assert.deepEqual(await legacyHarness.service.getImportStatus(), {
    ready: false,
    baselineId: null,
    sourceFingerprint: null,
    summary: null,
  });

  const importedHarness = createHarness({
    activeBaseline: {
      baselineId:
        "inventory-baseline:99999999-9999-4999-8999-999999999999",
      sourceFingerprint: "fnv1a64:ae41c31763e06074",
      inventory: [
        {
          sku: "SKU-1",
          item: "Stussy tee",
          style: "black",
          size: "L",
          quantityOnHandAtImport: 3,
          unitCostCents: 1250,
        },
      ],
    },
  });
  assert.deepEqual(await importedHarness.service.getImportStatus(), {
    ready: true,
    baselineId:
      "inventory-baseline:99999999-9999-4999-8999-999999999999",
    sourceFingerprint: "fnv1a64:ae41c31763e06074",
    summary: {
      rowCount: 1,
      totalQuantityOnHandAtImport: 3,
      totalInventoryCostCents: 3750,
    },
  });
});

test("returns a cloned local preview of the active inventory baseline", async () => {
  const activeBaseline = {
    baselineId:
      "inventory-baseline:99999999-9999-4999-8999-999999999999",
    sourceFingerprint: "fnv1a64:ae41c31763e06074",
    inventory: [
      {
        sku: "SKU-1",
        item: "Stussy tee",
        style: "black",
        size: "L",
        quantityOnHandAtImport: 3,
        unitCostCents: 1250,
      },
    ],
  };
  const harness = createHarness({ activeBaseline });

  const result = await harness.service.getActiveBaselinePreview();
  assert.deepEqual(result, {
    ready: true,
    baselineId: activeBaseline.baselineId,
    inventory: activeBaseline.inventory,
    summary: {
      rowCount: 1,
      totalQuantityOnHandAtImport: 3,
      totalInventoryCostCents: 3750,
    },
  });
  assert.notEqual(result.inventory, activeBaseline.inventory);
  assert.notEqual(result.inventory[0], activeBaseline.inventory[0]);
  result.inventory[0].item = "Changed client copy";
  assert.equal(activeBaseline.inventory[0].item, "Stussy tee");
  assert.equal(harness.authCalls.length, 0);
  assert.equal(harness.fetchCalls.length, 0);
});

test("returns the exact unavailable active-baseline preview for absent or unusable data", async () => {
  const expected = {
    ready: false,
    baselineId: null,
    inventory: null,
    summary: null,
  };
  const unusableBaselines = [
    null,
    {
      baselineId:
        "inventory-baseline:99999999-9999-4999-8999-999999999999",
      inventory: [],
    },
    {
      baselineId: "invalid-baseline",
      inventory: [{
        sku: "SKU-1",
        item: "Stussy tee",
        style: "black",
        size: "L",
        quantityOnHandAtImport: 3,
        unitCostCents: 1250,
      }],
    },
    {
      baselineId:
        "inventory-baseline:99999999-9999-4999-8999-999999999999",
      inventory: [{
        sku: "bad sku",
        item: "Stussy tee",
        style: "black",
        size: "L",
        quantityOnHandAtImport: 3,
        unitCostCents: 1250,
      }],
    },
  ];

  for (const activeBaseline of unusableBaselines) {
    const harness = createHarness({ activeBaseline });
    assert.deepEqual(
      await harness.service.getActiveBaselinePreview(),
      expected,
    );
  }
});

test("adds only a full validated Sheet snapshot to the active stream", async () => {
  const payload = appendGridRow(createGridPayload());
  const harness = createHarness({ payloads: [payload] });
  const context = {
    streamId: "local-stream:44444444-4444-4444-8444-444444444444",
    expectedBaselineId:
      "inventory-baseline:99999999-9999-4999-8999-999999999999",
  };

  const result = await harness.service.addActiveStreamSkusFromGoogleSheet(
    SPREADSHEET_ID,
    context,
  );

  assert.deepEqual(result, {
    status: "extended",
    baselineId:
      "inventory-baseline:11111111-1111-4111-8111-111111111111",
    sourceFingerprint: result.sourceFingerprint,
    summary: {
      rowCount: 2,
      totalQuantityOnHandAtImport: 5,
      totalInventoryCostCents: 5750,
    },
    addedSkus: ["SKU-2"],
  });
  assert.match(result.sourceFingerprint, /^fnv1a64:[0-9a-f]{16}$/);
  assert.deepEqual(harness.activeStreamChecks, [
    context.streamId,
    context.streamId,
  ]);
  assert.deepEqual(harness.authCalls, [{ interactive: true }]);
  assert.equal(harness.extensionCalls.length, 1);
  assert.deepEqual(harness.extensionCalls[0], {
    streamId: context.streamId,
    expectedBaselineId: context.expectedBaselineId,
    baselineId: result.baselineId,
    sourceFingerprint: result.sourceFingerprint,
    inventory: [
      {
        sku: "SKU-1",
        item: "Stussy tee",
        style: "black",
        size: "L",
        quantityOnHandAtImport: 3,
        unitCostCents: 1250,
      },
      {
        sku: "SKU-2",
        item: "Limited hoodie",
        style: "blue",
        size: "M",
        quantityOnHandAtImport: 2,
        unitCostCents: 1000,
      },
    ],
  });
});

test("does not mutate when the active stream changes during the Sheet read", async () => {
  const activeStreamError = new Error("active stream changed");
  const harness = createHarness({
    payloads: [appendGridRow(createGridPayload())],
    activeStreamError,
    activeStreamErrorAt: 2,
  });

  await assert.rejects(
    harness.service.addActiveStreamSkusFromGoogleSheet(
      SPREADSHEET_ID,
      {
        streamId: "local-stream:44444444-4444-4444-8444-444444444444",
        expectedBaselineId:
          "inventory-baseline:99999999-9999-4999-8999-999999999999",
      },
    ),
    activeStreamError,
  );
  assert.equal(harness.extensionCalls.length, 0);
});

test("returns invalid Sheet issues without attempting a live extension", async () => {
  const harness = createHarness({
    payloads: [createGridPayload({ skuFormula: true })],
  });

  const result = await harness.service.addActiveStreamSkusFromGoogleSheet(
    SPREADSHEET_ID,
    {
      streamId: "local-stream:44444444-4444-4444-8444-444444444444",
      expectedBaselineId:
        "inventory-baseline:99999999-9999-4999-8999-999999999999",
    },
  );

  assert.equal(result.status, "invalid");
  assert.ok(result.issues.some((issue) => issue.code === "FORMULA_NOT_ALLOWED"));
  assert.equal(harness.extensionCalls.length, 0);
});

test("accepts an order-independent already-current live Sheet", async () => {
  const payload = appendGridRow(createGridPayload());
  payload.sheets[0].data[0].rowData = [
    payload.sheets[0].data[0].rowData[0],
    payload.sheets[0].data[0].rowData[2],
    payload.sheets[0].data[0].rowData[1],
  ];
  const expectedBaselineId =
    "inventory-baseline:99999999-9999-4999-8999-999999999999";
  const harness = createHarness({
    payloads: [payload],
    extendResponse(command) {
      return {
        state: {
          version: 7,
          activeInventoryBaselineId: expectedBaselineId,
          inventoryBaselines: [{
            baselineId: expectedBaselineId,
            sourceFingerprint: command.sourceFingerprint,
            inventory: [...command.inventory].reverse(),
          }],
          streams: [{
            streamId: command.streamId,
            inventoryBaselineId: expectedBaselineId,
            activeBiddingVariationNumber: null,
            attributedGmvDisplay: null,
            variations: [],
          }],
        },
        result: {
          status: "already_current",
          baselineId: expectedBaselineId,
          previousBaselineId: expectedBaselineId,
          addedSkus: [],
        },
      };
    },
  });

  const result = await harness.service.addActiveStreamSkusFromGoogleSheet(
    SPREADSHEET_ID,
    {
      streamId: "local-stream:44444444-4444-4444-8444-444444444444",
      expectedBaselineId,
    },
  );

  assert.equal(result.status, "already_current");
  assert.equal(result.baselineId, expectedBaselineId);
  assert.deepEqual(result.addedSkus, []);
});

test("rejects an already-current response with mismatched persisted provenance", async () => {
  const expectedBaselineId =
    "inventory-baseline:99999999-9999-4999-8999-999999999999";
  const harness = createHarness({
    extendResponse(command) {
      return {
        state: {
          version: 7,
          activeInventoryBaselineId: expectedBaselineId,
          inventoryBaselines: [{
            baselineId: expectedBaselineId,
            sourceFingerprint: "fnv1a64:aaaaaaaaaaaaaaaa",
            inventory: command.inventory,
          }],
          streams: [{
            streamId: command.streamId,
            inventoryBaselineId: expectedBaselineId,
            activeBiddingVariationNumber: null,
            attributedGmvDisplay: null,
            variations: [],
          }],
        },
        result: {
          status: "already_current",
          baselineId: expectedBaselineId,
          previousBaselineId: expectedBaselineId,
          addedSkus: [],
        },
      };
    },
  });

  await assert.rejects(
    harness.service.addActiveStreamSkusFromGoogleSheet(
      SPREADSHEET_ID,
      {
        streamId: "local-stream:44444444-4444-4444-8444-444444444444",
        expectedBaselineId,
      },
    ),
    (error) => error.code === "ACTIVE_INVENTORY_UPDATE_FAILED",
  );
});
