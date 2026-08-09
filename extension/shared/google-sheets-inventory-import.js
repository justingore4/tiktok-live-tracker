(function initializeGoogleSheetsInventoryImport(root, factory) {
  const googleSheetsInventoryImport = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = googleSheetsInventoryImport;
  }

  root.TikTokLiveTrackerGoogleSheetsInventoryImport =
    googleSheetsInventoryImport;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createGoogleSheetsInventoryImportModule() {
    "use strict";

    const INVENTORY_RANGE = "'Inventory'!A:ZZZ";
    const SHEETS_API_ROOT = "https://sheets.googleapis.com/v4/spreadsheets";
    const GRID_FIELDS =
      "sheets(properties(title),data(startRow,startColumn,rowData.values.userEnteredValue))";
    const PREVIEW_TTL_MS = 10 * 60 * 1000;
    const MAX_RESPONSE_CHARACTERS = 4 * 1024 * 1024;
    const MAX_SHEET_ROWS = 1_001;
    const MAX_SHEET_COLUMNS = 18_278;
    const MAX_CELL_SLOTS = 20_000;
    const MAX_PREVIEW_ISSUES = 100;
    const REQUEST_TIMEOUT_MS = 20_000;
    const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
    const OAUTH_CLIENT_ID_PATTERN =
      /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;
    const BASELINE_ID_PATTERN =
      /^inventory-baseline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const PREVIEW_TOKEN_PATTERN =
      /^inventory-preview:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    class GoogleSheetsInventoryImportError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "GoogleSheetsInventoryImportError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new GoogleSheetsInventoryImportError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function cloneSerializable(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function createSheetsUrl(spreadsheetId) {
      return `${SHEETS_API_ROOT}/${encodeURIComponent(spreadsheetId)}` +
        `?includeGridData=true&ranges=${encodeURIComponent(INVENTORY_RANGE)}` +
        `&fields=${encodeURIComponent(GRID_FIELDS)}`;
    }

    async function readBoundedResponseText(response) {
      const contentLength = response.headers &&
        typeof response.headers.get === "function"
        ? response.headers.get("content-length")
        : null;

      if (
        typeof contentLength === "string" &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > MAX_RESPONSE_CHARACTERS
      ) {
        fail(
          "INVENTORY_SHEET_TOO_LARGE",
          "The Inventory tab exceeds the supported import size.",
        );
      }

      if (
        response.body &&
        typeof response.body.getReader === "function" &&
        typeof globalThis.TextDecoder === "function"
      ) {
        const reader = response.body.getReader();
        const chunks = [];
        let totalBytes = 0;

        while (true) {
          const result = await reader.read();

          if (
            !isPlainRecord(result) ||
            typeof result.done !== "boolean"
          ) {
            fail(
              "INVALID_GOOGLE_SHEETS_RESPONSE",
              "Google Sheets returned an unreadable response body.",
            );
          }

          if (result.done) {
            break;
          }

          if (!(result.value instanceof Uint8Array)) {
            fail(
              "INVALID_GOOGLE_SHEETS_RESPONSE",
              "Google Sheets returned an unreadable response body.",
            );
          }

          totalBytes += result.value.byteLength;

          if (totalBytes > MAX_RESPONSE_CHARACTERS) {
            try {
              await reader.cancel();
            } catch (_error) {
              // The bounded read is already being rejected.
            }

            fail(
              "INVENTORY_SHEET_TOO_LARGE",
              "The Inventory tab exceeds the supported import size.",
            );
          }

          chunks.push(result.value);
        }

        const bytes = new Uint8Array(totalBytes);
        let offset = 0;

        chunks.forEach((chunk) => {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        });

        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (_error) {
          fail(
            "INVALID_GOOGLE_SHEETS_RESPONSE",
            "Google Sheets returned invalid response encoding.",
          );
        }
      }

      if (typeof response.text !== "function") {
        fail(
          "INVALID_GOOGLE_SHEETS_RESPONSE",
          "Google Sheets returned an unreadable response.",
        );
      }

      const responseText = await response.text();

      if (
        typeof responseText !== "string" ||
        responseText.length > MAX_RESPONSE_CHARACTERS
      ) {
        fail(
          "INVENTORY_SHEET_TOO_LARGE",
          "The Inventory tab exceeds the supported import size.",
        );
      }

      return responseText;
    }

    function validateOptions(options) {
      if (!isPlainRecord(options)) {
        throw new TypeError("Google Sheets inventory-import options are required.");
      }

      const {
        assertNoActiveStream,
        createBaseline,
        createUuid,
        fetchImpl,
        getActiveBaseline,
        identityApi,
        inventorySheetImport,
        now,
        oauthClientId,
      } = options;

      if (typeof assertNoActiveStream !== "function") {
        throw new TypeError("assertNoActiveStream must be a function.");
      }

      if (typeof createBaseline !== "function") {
        throw new TypeError("createBaseline must be a function.");
      }

      if (typeof createUuid !== "function") {
        throw new TypeError("createUuid must be a function.");
      }

      if (typeof fetchImpl !== "function") {
        throw new TypeError("fetchImpl must be a function.");
      }

      if (typeof getActiveBaseline !== "function") {
        throw new TypeError("getActiveBaseline must be a function.");
      }

      if (
        !identityApi ||
        typeof identityApi.getAuthToken !== "function" ||
        typeof identityApi.removeCachedAuthToken !== "function"
      ) {
        throw new TypeError(
          "identityApi must provide getAuthToken and removeCachedAuthToken.",
        );
      }

      if (
        !inventorySheetImport ||
        !Number.isSafeInteger(inventorySheetImport.IMPORT_CONTRACT_VERSION) ||
        typeof inventorySheetImport.parseInventorySheet !== "function" ||
        typeof inventorySheetImport.InventorySheetImportError !== "function"
      ) {
        throw new TypeError("A valid inventory Sheet parser is required.");
      }

      if (typeof now !== "function") {
        throw new TypeError("now must be a function.");
      }

      return {
        abortController: options.abortController ?? globalThis.AbortController,
        assertNoActiveStream,
        clearTimeoutImpl: options.clearTimeoutImpl ?? globalThis.clearTimeout,
        createBaseline,
        createUuid,
        fetchImpl,
        getActiveBaseline,
        identityApi,
        inventorySheetImport,
        now,
        oauthClientId,
        setTimeoutImpl: options.setTimeoutImpl ?? globalThis.setTimeout,
      };
    }

    function normalizeTokenResult(result, interactive) {
      const token = typeof result === "string" ? result : result?.token;

      if (typeof token !== "string" || token.trim() === "") {
        fail(
          interactive ? "GOOGLE_AUTH_FAILED" : "REAUTHORIZE_REQUIRED",
          interactive
            ? "Google authorization did not return an access token."
            : "Reconnect Google Sheets and preview the spreadsheet again.",
        );
      }

      if (
        isPlainRecord(result) &&
        Array.isArray(result.grantedScopes) &&
        !result.grantedScopes.includes(
          "https://www.googleapis.com/auth/spreadsheets.readonly",
        )
      ) {
        fail(
          "GOOGLE_AUTH_SCOPE_MISSING",
          "Google authorization did not grant read-only spreadsheet access.",
        );
      }

      return token;
    }

    function sanitizeIssues(issues) {
      const sanitized = issues
        .slice(0, MAX_PREVIEW_ISSUES)
        .map((issue) => ({
          code: String(issue.code).slice(0, 80),
          rowNumber: Number.isSafeInteger(issue.rowNumber)
            ? issue.rowNumber
            : null,
          column: typeof issue.column === "string"
            ? issue.column.slice(0, 80)
            : null,
          message: String(issue.message).slice(0, 300),
        }));

      if (issues.length > MAX_PREVIEW_ISSUES) {
        sanitized[MAX_PREVIEW_ISSUES - 1] = {
          code: "ADDITIONAL_ISSUES_OMITTED",
          rowNumber: null,
          column: null,
          message: "Additional inventory validation issues were omitted.",
        };
      }

      return sanitized;
    }

    function parseGridValue(userEnteredValue) {
      if (userEnteredValue === undefined) {
        return undefined;
      }

      if (!isPlainRecord(userEnteredValue)) {
        fail(
          "INVALID_GOOGLE_SHEETS_RESPONSE",
          "Google Sheets returned an invalid Inventory cell.",
        );
      }

      const keys = Object.keys(userEnteredValue);

      if (keys.length === 0) {
        return undefined;
      }

      if (keys.length !== 1) {
        fail(
          "INVALID_GOOGLE_SHEETS_RESPONSE",
          "Google Sheets returned an ambiguous Inventory cell.",
        );
      }

      const [type] = keys;
      const value = userEnteredValue[type];

      if (type === "formulaValue") {
        return typeof value === "string" && value.startsWith("=")
          ? value
          : "=UNSUPPORTED_FORMULA";
      }

      if (type === "stringValue") {
        if (typeof value !== "string") {
          fail(
            "INVALID_GOOGLE_SHEETS_RESPONSE",
            "Google Sheets returned an invalid Inventory string.",
          );
        }

        return value;
      }

      if (type === "numberValue") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail(
            "INVALID_GOOGLE_SHEETS_RESPONSE",
            "Google Sheets returned an invalid Inventory number.",
          );
        }

        return value;
      }

      if (type === "boolValue") {
        if (typeof value !== "boolean") {
          fail(
            "INVALID_GOOGLE_SHEETS_RESPONSE",
            "Google Sheets returned an invalid Inventory boolean.",
          );
        }

        return value;
      }

      fail(
        "INVALID_GOOGLE_SHEETS_RESPONSE",
        "Google Sheets returned an unsupported Inventory cell type.",
      );
    }

    function gridResponseToValues(payload) {
      if (!isPlainRecord(payload) || !Array.isArray(payload.sheets)) {
        fail(
          "INVALID_GOOGLE_SHEETS_RESPONSE",
          "Google Sheets returned an invalid Inventory response.",
        );
      }

      if (payload.sheets.length !== 1) {
        fail(
          "INVENTORY_SHEET_NOT_FOUND",
          "The spreadsheet must contain exactly one Inventory tab.",
        );
      }

      const sheet = payload.sheets[0];

      if (
        !isPlainRecord(sheet) ||
        !isPlainRecord(sheet.properties) ||
        sheet.properties.title !== "Inventory" ||
        (sheet.data !== undefined && !Array.isArray(sheet.data))
      ) {
        fail(
          "INVALID_GOOGLE_SHEETS_RESPONSE",
          "Google Sheets returned an invalid Inventory tab.",
        );
      }

      const output = [];
      let cellSlots = 0;

      (sheet.data ?? []).forEach((grid) => {
        if (!isPlainRecord(grid)) {
          fail(
            "INVALID_GOOGLE_SHEETS_RESPONSE",
            "Google Sheets returned invalid Inventory grid data.",
          );
        }

        const startRow = grid.startRow ?? 0;
        const startColumn = grid.startColumn ?? 0;
        const rowData = grid.rowData ?? [];

        if (
          !Number.isSafeInteger(startRow) ||
          startRow < 0 ||
          !Number.isSafeInteger(startColumn) ||
          startColumn < 0 ||
          !Array.isArray(rowData) ||
          startRow + rowData.length > MAX_SHEET_ROWS
        ) {
          fail(
            "INVENTORY_SHEET_TOO_LARGE",
            "The Inventory tab exceeds the supported import size.",
          );
        }

        rowData.forEach((row, rowOffset) => {
          if (!isPlainRecord(row)) {
            fail(
              "INVALID_GOOGLE_SHEETS_RESPONSE",
              "Google Sheets returned an invalid Inventory row.",
            );
          }

          const cells = row.values ?? [];

          if (
            !Array.isArray(cells) ||
            startColumn + cells.length > MAX_SHEET_COLUMNS
          ) {
            fail(
              "INVENTORY_SHEET_TOO_LARGE",
              "The Inventory tab exceeds the supported import size.",
            );
          }

          cellSlots += cells.length;

          if (cellSlots > MAX_CELL_SLOTS) {
            fail(
              "INVENTORY_SHEET_TOO_LARGE",
              "The Inventory tab exceeds the supported import size.",
            );
          }

          const rowIndex = startRow + rowOffset;
          const outputRow = output[rowIndex] ?? [];

          cells.forEach((cell, columnOffset) => {
            if (!isPlainRecord(cell)) {
              fail(
                "INVALID_GOOGLE_SHEETS_RESPONSE",
                "Google Sheets returned an invalid Inventory cell.",
              );
            }

            const value = parseGridValue(cell.userEnteredValue);

            if (value !== undefined) {
              outputRow[startColumn + columnOffset] = value;
            }
          });

          output[rowIndex] = outputRow;
        });
      });

      for (let rowIndex = 0; rowIndex < output.length; rowIndex += 1) {
        output[rowIndex] ??= [];
      }

      return output;
    }

    function createGoogleSheetsInventoryImportService(options) {
      const dependencies = validateOptions(options);
      const previews = new Map();

      function currentTime() {
        const value = dependencies.now();

        if (!Number.isSafeInteger(value) || value < 0) {
          throw new TypeError("now must return nonnegative epoch milliseconds.");
        }

        return value;
      }

      function requireConfiguredOAuth() {
        if (
          typeof dependencies.oauthClientId !== "string" ||
          !OAUTH_CLIENT_ID_PATTERN.test(dependencies.oauthClientId)
        ) {
          fail(
            "GOOGLE_OAUTH_NOT_CONFIGURED",
            "Google Sheets authorization has not been configured for this extension build.",
          );
        }
      }

      async function getAccessToken(interactive) {
        requireConfiguredOAuth();

        try {
          return normalizeTokenResult(
            await dependencies.identityApi.getAuthToken({ interactive }),
            interactive,
          );
        } catch (error) {
          if (error instanceof GoogleSheetsInventoryImportError) {
            throw error;
          }

          fail(
            interactive ? "GOOGLE_AUTH_FAILED" : "REAUTHORIZE_REQUIRED",
            interactive
              ? "Google authorization was canceled or could not be completed."
              : "Reconnect Google Sheets and preview the spreadsheet again.",
          );
        }
      }

      async function invalidateAccessToken(token) {
        try {
          await dependencies.identityApi.removeCachedAuthToken({ token });
        } catch (_error) {
          fail(
            "GOOGLE_AUTH_FAILED",
            "Google authorization could not be refreshed.",
          );
        }
      }

      async function fetchOnce(url, token) {
        const Controller = dependencies.abortController;
        const controller = typeof Controller === "function"
          ? new Controller()
          : null;
        const timeoutId =
          controller && typeof dependencies.setTimeoutImpl === "function"
            ? dependencies.setTimeoutImpl(
                () => controller.abort(),
                REQUEST_TIMEOUT_MS,
              )
            : null;

        try {
          const response = await dependencies.fetchImpl(url, {
            method: "GET",
            cache: "no-store",
            credentials: "omit",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller?.signal,
          });
          let responseText = null;

          if (
            response &&
            Number.isSafeInteger(response.status) &&
            response.status >= 200 &&
            response.status < 300
          ) {
            responseText = await readBoundedResponseText(response);
          }

          return { response, responseText };
        } finally {
          if (
            timeoutId !== null &&
            typeof dependencies.clearTimeoutImpl === "function"
          ) {
            dependencies.clearTimeoutImpl(timeoutId);
          }
        }
      }

      async function requestGridPayload(spreadsheetId, interactive) {
        const url = createSheetsUrl(spreadsheetId);
        let token = await getAccessToken(interactive);
        let refreshedToken = false;
        let transientRetryUsed = false;

        while (true) {
          let fetchResult;

          try {
            fetchResult = await fetchOnce(url, token);
          } catch (error) {
            if (error instanceof GoogleSheetsInventoryImportError) {
              throw error;
            }

            if (!transientRetryUsed) {
              transientRetryUsed = true;
              continue;
            }

            fail(
              "GOOGLE_SHEETS_TEMPORARILY_UNAVAILABLE",
              "Google Sheets could not be reached. Try again.",
            );
          }

          const { response, responseText } = fetchResult;

          if (!response || !Number.isSafeInteger(response.status)) {
            fail(
              "INVALID_GOOGLE_SHEETS_RESPONSE",
              "Google Sheets returned an invalid network response.",
            );
          }

          if (response.status === 401 && !refreshedToken) {
            await invalidateAccessToken(token);
            token = await getAccessToken(interactive);
            refreshedToken = true;
            continue;
          }

          if (
            RETRYABLE_HTTP_STATUSES.has(response.status) &&
            !transientRetryUsed
          ) {
            transientRetryUsed = true;
            continue;
          }

          if (response.status === 403) {
            fail(
              "GOOGLE_SHEETS_PERMISSION_DENIED",
              "The connected Google account cannot read this spreadsheet.",
            );
          }

          if (response.status === 404) {
            fail(
              "GOOGLE_SHEET_NOT_FOUND",
              "The spreadsheet could not be found.",
            );
          }

          if (response.status === 400) {
            fail(
              "INVENTORY_SHEET_NOT_FOUND",
              "The spreadsheet must contain a readable Inventory tab.",
            );
          }

          if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
            fail(
              "GOOGLE_SHEETS_TEMPORARILY_UNAVAILABLE",
              "Google Sheets is temporarily unavailable. Try again.",
            );
          }

          if (response.status < 200 || response.status >= 300) {
            fail(
              "GOOGLE_SHEETS_REQUEST_FAILED",
              "Google Sheets could not read the Inventory tab.",
            );
          }

          if (
            typeof responseText !== "string" ||
            responseText.length > MAX_RESPONSE_CHARACTERS
          ) {
            fail(
              "INVENTORY_SHEET_TOO_LARGE",
              "The Inventory tab exceeds the supported import size.",
            );
          }

          try {
            return JSON.parse(responseText);
          } catch (_error) {
            fail(
              "INVALID_GOOGLE_SHEETS_RESPONSE",
              "Google Sheets returned invalid response data.",
            );
          }
        }
      }

      async function readSnapshot(spreadsheetId, interactive) {
        const payload = await requestGridPayload(spreadsheetId, interactive);
        const values = gridResponseToValues(payload);

        try {
          const preview = dependencies.inventorySheetImport
            .parseInventorySheet(values);

          return {
            valid: true,
            snapshot: cloneSerializable(preview),
          };
        } catch (error) {
          if (
            error instanceof
              dependencies.inventorySheetImport.InventorySheetImportError
          ) {
            return {
              valid: false,
              issues: sanitizeIssues(error.issues),
            };
          }

          throw error;
        }
      }

      function removeExpiredPreviews(nowValue) {
        for (const [token, record] of previews) {
          if (record.expiresAtMs <= nowValue) {
            previews.delete(token);
          }
        }
      }

      function makeIdentifier(prefix, pattern) {
        const identifier = `${prefix}:${dependencies.createUuid()}`;

        if (!pattern.test(identifier)) {
          fail(
            "SECURE_RANDOM_UNAVAILABLE",
            "A secure inventory-import identifier could not be created.",
          );
        }

        return identifier;
      }

      function storePreview(spreadsheetId, snapshot, nowValue) {
        removeExpiredPreviews(nowValue);

        const previewToken = makeIdentifier(
          "inventory-preview",
          PREVIEW_TOKEN_PATTERN,
        );
        const expiresAtMs = nowValue + PREVIEW_TTL_MS;
        const record = {
          spreadsheetId,
          snapshot: cloneSerializable(snapshot),
          expiresAtMs,
          baselineId: null,
          confirmedResult: null,
        };

        previews.set(previewToken, record);

        return {
          status: "ready",
          previewToken,
          spreadsheetId,
          range: INVENTORY_RANGE,
          contractVersion: snapshot.contractVersion,
          fingerprint: snapshot.fingerprint,
          inventory: cloneSerializable(snapshot.inventory),
          summary: cloneSerializable(snapshot.summary),
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
      }

      async function previewGoogleSheet(spreadsheetId) {
        await dependencies.assertNoActiveStream();
        previews.clear();
        const readResult = await readSnapshot(spreadsheetId, true);
        await dependencies.assertNoActiveStream();

        if (!readResult.valid) {
          return {
            status: "invalid",
            issues: readResult.issues,
          };
        }

        return storePreview(spreadsheetId, readResult.snapshot, currentTime());
      }

      function getPreview(previewToken) {
        const record = previews.get(previewToken);

        if (!record) {
          fail(
            "PREVIEW_NOT_FOUND",
            "Preview this spreadsheet again before confirming the import.",
          );
        }

        if (record.expiresAtMs <= currentTime()) {
          previews.delete(previewToken);
          fail(
            "PREVIEW_EXPIRED",
            "The inventory preview expired. Preview the spreadsheet again.",
          );
        }

        return record;
      }

      async function confirmGoogleSheetImport(previewToken) {
        await dependencies.assertNoActiveStream();
        const record = getPreview(previewToken);

        if (record.confirmedResult !== null) {
          return cloneSerializable(record.confirmedResult);
        }

        const reread = await readSnapshot(record.spreadsheetId, false);

        if (
          !reread.valid ||
          reread.snapshot.contractVersion !==
            dependencies.inventorySheetImport.IMPORT_CONTRACT_VERSION ||
          JSON.stringify(reread.snapshot) !== JSON.stringify(record.snapshot)
        ) {
          previews.delete(previewToken);
          fail(
            "STALE_PREVIEW",
            "The Inventory tab changed after preview. Preview it again before importing.",
          );
        }

        await dependencies.assertNoActiveStream();

        record.baselineId ??= makeIdentifier(
          "inventory-baseline",
          BASELINE_ID_PATTERN,
        );

        const durableResponse = await dependencies.createBaseline({
          baselineId: record.baselineId,
          sourceFingerprint: record.snapshot.fingerprint,
          inventory: cloneSerializable(record.snapshot.inventory),
        });
        const persistedBaseline = Array.isArray(
          durableResponse?.state?.inventoryBaselines,
        )
          ? durableResponse.state.inventoryBaselines.find(
              (baseline) => baseline?.baselineId === record.baselineId,
            )
          : null;

        if (
          durableResponse?.result?.baselineId !== record.baselineId ||
          durableResponse?.state?.activeInventoryBaselineId !==
            record.baselineId ||
          !persistedBaseline ||
          persistedBaseline.sourceFingerprint !== record.snapshot.fingerprint ||
          JSON.stringify(persistedBaseline.inventory) !==
            JSON.stringify(record.snapshot.inventory)
        ) {
          fail(
            "IMPORT_CONFIRMATION_FAILED",
            "The imported inventory baseline could not be verified.",
          );
        }

        record.confirmedResult = {
          status: "imported",
          baselineId: record.baselineId,
          sourceFingerprint: record.snapshot.fingerprint,
          summary: cloneSerializable(record.snapshot.summary),
        };
        record.spreadsheetId = null;
        record.snapshot = null;

        return cloneSerializable(record.confirmedResult);
      }

      async function getImportStatus() {
        const baseline = await dependencies.getActiveBaseline();

        if (
          !baseline ||
          typeof baseline.sourceFingerprint !== "string" ||
          baseline.sourceFingerprint.trim() === "" ||
          !Array.isArray(baseline.inventory)
        ) {
          return {
            ready: false,
            baselineId: null,
            sourceFingerprint: null,
            summary: null,
          };
        }

        let totalQuantityOnHandAtImport = 0;
        let totalInventoryCostCents = 0;

        baseline.inventory.forEach((row) => {
          totalQuantityOnHandAtImport += row.quantityOnHandAtImport;
          totalInventoryCostCents +=
            row.quantityOnHandAtImport * row.unitCostCents;
        });

        return {
          ready: true,
          baselineId: baseline.baselineId,
          sourceFingerprint: baseline.sourceFingerprint,
          summary: {
            rowCount: baseline.inventory.length,
            totalQuantityOnHandAtImport,
            totalInventoryCostCents,
          },
        };
      }

      function invalidatePreviews() {
        previews.clear();
      }

      return Object.freeze({
        confirmGoogleSheetImport,
        getImportStatus,
        invalidatePreviews,
        previewGoogleSheet,
      });
    }

    return Object.freeze({
      GRID_FIELDS,
      INVENTORY_RANGE,
      MAX_CELL_SLOTS,
      MAX_PREVIEW_ISSUES,
      MAX_RESPONSE_CHARACTERS,
      MAX_SHEET_COLUMNS,
      MAX_SHEET_ROWS,
      PREVIEW_TTL_MS,
      GoogleSheetsInventoryImportError,
      createGoogleSheetsInventoryImportService,
      createSheetsUrl,
      gridResponseToValues,
    });
  },
);
