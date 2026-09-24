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

    const INVENTORY_RANGE = "'Inventory'!A:F";
    const INVENTORY_COLUMN_COUNT = 6;
    const SHEETS_API_ROOT = "https://sheets.googleapis.com/v4/spreadsheets";
    const GRID_FIELDS =
      "sheets(properties(title),data(startRow,startColumn,rowData.values.userEnteredValue))";
    const LAYOUT_GRID_FIELDS =
      "spreadsheetId,sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)),merges,data(startRow,startColumn,rowData.values.userEnteredValue))";
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
    const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const INVENTORY_TEXT_LIMITS = Object.freeze({
      item: 160,
      style: 160,
      size: 80,
    });
    const UNSAFE_CONTROL_CHARACTER_PATTERN =
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
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

    function createSheetsUrl(spreadsheetId, fields = GRID_FIELDS) {
      return `${SHEETS_API_ROOT}/${encodeURIComponent(spreadsheetId)}` +
        `?includeGridData=true&ranges=${encodeURIComponent(INVENTORY_RANGE)}` +
        `&fields=${encodeURIComponent(fields)}`;
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
        assertActiveStream,
        assertNoActiveStream,
        createBaseline,
        createUuid,
        extendStreamBaseline,
        fetchImpl,
        getActiveBaseline,
        identityApi,
        inventorySheetImport,
        now,
        oauthClientId,
      } = options;

      if (typeof assertActiveStream !== "function") {
        throw new TypeError("assertActiveStream must be a function.");
      }

      if (typeof assertNoActiveStream !== "function") {
        throw new TypeError("assertNoActiveStream must be a function.");
      }

      if (typeof createBaseline !== "function") {
        throw new TypeError("createBaseline must be a function.");
      }

      if (typeof extendStreamBaseline !== "function") {
        throw new TypeError("extendStreamBaseline must be a function.");
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
        assertActiveStream,
        assertNoActiveStream,
        clearTimeoutImpl: options.clearTimeoutImpl ??
          ((...args) => globalThis.clearTimeout(...args)),
        createBaseline,
        createUuid,
        extendStreamBaseline,
        fetchImpl,
        getActiveBaseline,
        identityApi,
        inventorySheetImport,
        now,
        oauthClientId,
        setTimeoutImpl: options.setTimeoutImpl ??
          ((...args) => globalThis.setTimeout(...args)),
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
      const visitedCells = new Set();
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
          startColumn >= MAX_SHEET_COLUMNS ||
          !Array.isArray(rowData) ||
          !Number.isSafeInteger(startRow + rowData.length)
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
            // Retain physical response-integrity limits, even for ignored G+.
            fail(
              "INVENTORY_SHEET_TOO_LARGE",
              "The Inventory tab exceeds the supported import size.",
            );
          }

          // A:F is the complete inventory boundary, including when a mocked or
          // unexpected response includes unrelated G+ cells or grid blocks.
          const inventoryCells = cells.slice(0, Math.max(0, INVENTORY_COLUMN_COUNT - startColumn));
          const rowIndex = startRow + rowOffset;
          if (rowIndex < MAX_SHEET_ROWS) cellSlots += inventoryCells.length;

          if (cellSlots > MAX_CELL_SLOTS) {
            fail(
              "INVENTORY_SHEET_TOO_LARGE",
              "The Inventory tab exceeds the supported import size.",
            );
          }

          const outputRow = output[rowIndex] ?? [];

          inventoryCells.forEach((cell, columnOffset) => {
            if (!isPlainRecord(cell)) {
              fail(
                "INVALID_GOOGLE_SHEETS_RESPONSE",
                "Google Sheets returned an invalid Inventory cell.",
              );
            }

            const columnIndex = startColumn + columnOffset;
            if (rowIndex < MAX_SHEET_ROWS) {
              const key = `${rowIndex}:${columnIndex}`;
              if (visitedCells.has(key)) {
                fail("INVALID_GOOGLE_SHEETS_RESPONSE", "Google Sheets returned overlapping Inventory grid data.");
              }
              visitedCells.add(key);
            }
            const value = parseGridValue(cell.userEnteredValue);

            if (value !== undefined) {
              if (!isBlankInventoryValue(value) && rowIndex >= MAX_SHEET_ROWS) {
                fail("INVENTORY_SHEET_TOO_LARGE", "The Inventory tab exceeds the supported import size.");
              }
              if (rowIndex < MAX_SHEET_ROWS) {
                outputRow[columnIndex] = value;
              }
            }
          });

          // Never allocate rows for remote summaries or trailing formatting.
          if (rowIndex < MAX_SHEET_ROWS) output[rowIndex] = outputRow;
        });
      });

      while (output.length > 0 && (output[output.length - 1] ?? []).every(isBlankInventoryValue)) {
        output.pop();
      }
      for (let rowIndex = 0; rowIndex < output.length; rowIndex += 1) {
        output[rowIndex] ??= [];
      }

      return output;
    }

    function isBlankInventoryValue(value) {
      return value === undefined || value === null ||
        (typeof value === "string" && value.trim() === "");
    }

    function hasUnsupportedInventoryMerges(sheet) {
      if (sheet.merges === undefined) return false;
      if (!Array.isArray(sheet.merges)) return true;
      const { rowCount, columnCount } = sheet.properties.gridProperties;
      // Google may omit a default-valued sheetId of zero in its response.
      const sheetId = sheet.properties.sheetId === undefined ? 0 : sheet.properties.sheetId;
      if (!Number.isSafeInteger(sheetId) || sheetId < 0) return true;
      return sheet.merges.some((merge) => {
        if (!isPlainRecord(merge)) return true;
        if (merge.sheetId !== undefined &&
            (!Number.isSafeInteger(merge.sheetId) || merge.sheetId < 0 || merge.sheetId !== sheetId)) return true;
        const startRow = merge.startRowIndex === undefined ? 0 : merge.startRowIndex;
        const endRow = merge.endRowIndex === undefined ? rowCount : merge.endRowIndex;
        const startColumn = merge.startColumnIndex === undefined ? 0 : merge.startColumnIndex;
        const endColumn = merge.endColumnIndex === undefined ? columnCount : merge.endColumnIndex;
        if (![startRow, endRow, startColumn, endColumn].every(Number.isSafeInteger) ||
            startRow < 0 || startColumn < 0 || endRow <= startRow || endColumn <= startColumn ||
            endRow > rowCount || endColumn > columnCount) return true;
        return startColumn < INVENTORY_COLUMN_COUNT;
      });
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
        } catch (error) {
          if (error instanceof GoogleSheetsInventoryImportError) {
            throw error;
          }

          if (controller?.signal?.aborted === true) {
            fail(
              "GOOGLE_SHEETS_REQUEST_TIMEOUT",
              "Google Sheets took too long to respond. Try again.",
            );
          }

          throw error;
        } finally {
          if (
            timeoutId !== null &&
            typeof dependencies.clearTimeoutImpl === "function"
          ) {
            dependencies.clearTimeoutImpl(timeoutId);
          }
        }
      }

      async function requestGridPayload(spreadsheetId, interactive, fields = GRID_FIELDS) {
        const url = createSheetsUrl(spreadsheetId, fields);
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

      async function readInventoryLayout(spreadsheetId) {
        if (typeof spreadsheetId !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId)) {
          fail("INVALID_SPREADSHEET_ID", "Enter a valid Google Sheet link or spreadsheet ID.");
        }
        // Read all rows in A:F, never a capped A1 range. Existing limits reject
        // oversized inventory instead of truncating it; G+ is not inventory.
        const payload = await requestGridPayload(spreadsheetId, true, LAYOUT_GRID_FIELDS);
        const sheet = payload?.sheets?.[0];
        const grid = sheet?.data?.[0];
        const properties = sheet?.properties?.gridProperties;
        if (!isPlainRecord(payload) || payload.spreadsheetId !== spreadsheetId ||
            !Array.isArray(payload.sheets) || payload.sheets.length !== 1 ||
            sheet?.properties?.title !== "Inventory" ||
            ![undefined, "GRID"].includes(sheet?.properties?.sheetType) ||
            !isPlainRecord(properties) || !Number.isSafeInteger(properties.rowCount) || properties.rowCount < 1 ||
            !Number.isSafeInteger(properties.columnCount) || properties.columnCount < 1 ||
            properties.columnCount > MAX_SHEET_COLUMNS ||
            !Array.isArray(sheet.data) || sheet.data.length !== 1 || !isPlainRecord(grid) ||
            (grid.startRow ?? 0) !== 0 || (grid.startColumn ?? 0) !== 0 ||
            !Array.isArray(grid.rowData) || grid.rowData.length > properties.rowCount ||
            hasUnsupportedInventoryMerges(sheet) ||
            grid.rowData.some((row) => Array.isArray(row?.values) && row.values.length > properties.columnCount)) {
          fail("UNSUPPORTED_INVENTORY_LAYOUT", "The complete, unmerged Inventory A:F layout could not be verified. Check the Sheet layout and try again.");
        }
        const values = gridResponseToValues(payload);
        // Reuse strict A:F import validation (including formulas, duplicates and
        // integer bounds), but retain the physical grid separately.
        try {
          dependencies.inventorySheetImport.parseInventorySheet(values);
        } catch (error) {
          if (!(error instanceof dependencies.inventorySheetImport.InventorySheetImportError)) throw error;
          const issue = sanitizeIssues(error.issues)[0];
          const location = issue.rowNumber === null ? "Inventory" : `Inventory row ${issue.rowNumber}`;
          const column = issue.column ? ` (${issue.column})` : "";
          const additional = error.issues.length > 1 ? ` ${error.issues.length - 1} additional validation issue(s) must also be fixed.` : "";
          fail("INVALID_INVENTORY_SHEET", `${location}${column}: ${issue.message}${additional}`);
        }
        const isBlank = (value) => value === undefined || value === null ||
          (typeof value === "string" && value.trim() === "");
        const headerIndex = values.findIndex((row) => row.some((value) => !isBlank(value)));
        return {
          spreadsheetId, sheetTitle: "Inventory", values: cloneSerializable(values),
          headerRowNumber: headerIndex + 1,
          quantityColumnNumber:
            dependencies.inventorySheetImport.getQuantityHeaderIndex(values[headerIndex]) + 1,
        };
      }

      function inventoriesMatchBySku(first, second) {
        if (
          !Array.isArray(first) ||
          !Array.isArray(second) ||
          first.length !== second.length
        ) {
          return false;
        }

        const secondBySku = new Map(
          second.map((item) => [item?.sku, item]),
        );

        return (
          secondBySku.size === second.length &&
          first.every((item) => {
            const match = secondBySku.get(item?.sku);

            return (
              match &&
              item.item === match.item &&
              item.style === match.style &&
              item.size === match.size &&
              item.quantityOnHandAtImport ===
                match.quantityOnHandAtImport &&
              item.unitCostCents === match.unitCostCents
            );
          })
        );
      }

      async function addActiveStreamSkusFromGoogleSheet(
        spreadsheetId,
        context,
      ) {
        if (
          !isPlainRecord(context) ||
          Object.keys(context).sort().join("\u0000") !==
            ["expectedBaselineId", "streamId"].sort().join("\u0000") ||
          typeof context.streamId !== "string" ||
          context.streamId.trim() === "" ||
          typeof context.expectedBaselineId !== "string" ||
          !BASELINE_ID_PATTERN.test(context.expectedBaselineId)
        ) {
          fail(
            "INVALID_ACTIVE_STREAM_CONTEXT",
            "The active stream inventory could not be verified.",
          );
        }

        const streamId = context.streamId.trim();
        const expectedBaselineId = context.expectedBaselineId;

        await dependencies.assertActiveStream(streamId);
        const readResult = await readSnapshot(spreadsheetId, true);
        await dependencies.assertActiveStream(streamId);

        if (!readResult.valid) {
          return {
            status: "invalid",
            issues: readResult.issues,
          };
        }

        const nextBaselineId = makeIdentifier(
          "inventory-baseline",
          BASELINE_ID_PATTERN,
        );
        const durableResponse = await dependencies.extendStreamBaseline({
          streamId,
          expectedBaselineId,
          baselineId: nextBaselineId,
          sourceFingerprint: readResult.snapshot.fingerprint,
          inventory: cloneSerializable(readResult.snapshot.inventory),
        });
        const result = durableResponse?.result;
        const state = durableResponse?.state;
        const extended = result?.status === "extended";
        const alreadyCurrent = result?.status === "already_current";
        const persistedBaselineId = extended
          ? nextBaselineId
          : expectedBaselineId;
        const persistedBaseline = Array.isArray(state?.inventoryBaselines)
          ? state.inventoryBaselines.find(
              (baseline) => baseline?.baselineId === persistedBaselineId,
            )
          : null;
        const persistedStream = Array.isArray(state?.streams)
          ? state.streams.find((stream) => stream?.streamId === streamId)
          : null;
        const addedSkus = Array.isArray(result?.addedSkus)
          ? result.addedSkus
          : null;
        const persistedSnapshotMatches =
          persistedBaseline?.sourceFingerprint ===
            readResult.snapshot.fingerprint &&
          (
            extended
              ? JSON.stringify(persistedBaseline?.inventory) ===
                JSON.stringify(readResult.snapshot.inventory)
              : inventoriesMatchBySku(
                  persistedBaseline?.inventory,
                  readResult.snapshot.inventory,
                )
          );

        if (
          (!extended && !alreadyCurrent) ||
          result?.baselineId !== persistedBaselineId ||
          result?.previousBaselineId !== expectedBaselineId ||
          !addedSkus ||
          (extended && addedSkus.length === 0) ||
          (alreadyCurrent && addedSkus.length !== 0) ||
          state?.activeInventoryBaselineId !== persistedBaselineId ||
          persistedStream?.inventoryBaselineId !== persistedBaselineId ||
          !persistedBaseline ||
          !persistedSnapshotMatches ||
          (
            extended &&
            state.streams.some(
              (stream) =>
                stream?.inventoryBaselineId === expectedBaselineId,
            )
          )
        ) {
          fail(
            "ACTIVE_INVENTORY_UPDATE_FAILED",
            "The new live-stream inventory could not be verified.",
          );
        }

        return {
          status: result.status,
          baselineId: persistedBaselineId,
          sourceFingerprint: readResult.snapshot.fingerprint,
          summary: cloneSerializable(readResult.snapshot.summary),
          addedSkus: cloneSerializable(addedSkus),
        };
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

      function createActiveBaselinePreview(baseline) {
        const unavailable = {
          ready: false,
          baselineId: null,
          inventory: null,
          summary: null,
        };

        if (
          !isPlainRecord(baseline) ||
          typeof baseline.baselineId !== "string" ||
          !BASELINE_ID_PATTERN.test(baseline.baselineId) ||
          !Array.isArray(baseline.inventory) ||
          baseline.inventory.length < 1 ||
          baseline.inventory.length > 1_000
        ) {
          return unavailable;
        }

        const seenSkus = new Set();
        const seenIdentities = new Set();
        let totalQuantityOnHandAtImport = 0n;
        let totalInventoryCostCents = 0n;

        for (const row of baseline.inventory) {
          if (
            !isPlainRecord(row) ||
            Object.keys(row).sort().join("\u0000") !==
              [
                "item",
                "quantityOnHandAtImport",
                "size",
                "sku",
                "style",
                "unitCostCents",
              ].sort().join("\u0000") ||
            typeof row.sku !== "string" ||
            !SKU_PATTERN.test(row.sku) ||
            seenSkus.has(row.sku) ||
            !Number.isSafeInteger(row.quantityOnHandAtImport) ||
            row.quantityOnHandAtImport < 0 ||
            !Number.isSafeInteger(row.unitCostCents) ||
            row.unitCostCents < 0
          ) {
            return unavailable;
          }

          for (const [field, allowEmpty] of [
            ["item", false],
            ["style", true],
            ["size", false],
          ]) {
            const value = row[field];

            if (
              typeof value !== "string" ||
              value !== value.normalize("NFC").trim().replace(/\s+/g, " ") ||
              (!allowEmpty && value === "") ||
              value.startsWith("=") ||
              value.length > INVENTORY_TEXT_LIMITS[field] ||
              UNSAFE_CONTROL_CHARACTER_PATTERN.test(value)
            ) {
              return unavailable;
            }
          }

          const identity = [row.item, row.style, row.size]
            .map((value) => value.toLocaleLowerCase("en-US"))
            .join("\u0000");

          if (seenIdentities.has(identity)) {
            return unavailable;
          }

          seenSkus.add(row.sku);
          seenIdentities.add(identity);
          totalQuantityOnHandAtImport += BigInt(row.quantityOnHandAtImport);
          totalInventoryCostCents +=
            BigInt(row.quantityOnHandAtImport) * BigInt(row.unitCostCents);
        }

        if (
          totalQuantityOnHandAtImport > BigInt(Number.MAX_SAFE_INTEGER) ||
          totalInventoryCostCents > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          return unavailable;
        }

        return {
          ready: true,
          baselineId: baseline.baselineId,
          inventory: cloneSerializable(baseline.inventory),
          summary: {
            rowCount: baseline.inventory.length,
            totalQuantityOnHandAtImport: Number(totalQuantityOnHandAtImport),
            totalInventoryCostCents: Number(totalInventoryCostCents),
          },
        };
      }

      async function getActiveBaselinePreview() {
        return createActiveBaselinePreview(
          await dependencies.getActiveBaseline(),
        );
      }

      function invalidatePreviews() {
        previews.clear();
      }

      return Object.freeze({
        addActiveStreamSkusFromGoogleSheet,
        confirmGoogleSheetImport,
        getActiveBaselinePreview,
        getImportStatus,
        invalidatePreviews,
        previewGoogleSheet,
        readInventoryLayout,
      });
    }

    return Object.freeze({
      GRID_FIELDS,
      LAYOUT_GRID_FIELDS,
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
