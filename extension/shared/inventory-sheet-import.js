(function initializeInventorySheetImport(root, factory) {
  const inventorySheetImport = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = inventorySheetImport;
  }

  root.TikTokLiveTrackerInventorySheetImport = inventorySheetImport;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createInventorySheetImportModule() {
    "use strict";

    const IMPORT_CONTRACT_VERSION = 1;
    const REQUIRED_HEADERS = Object.freeze([
      "sku",
      "item",
      "style",
      "size",
      "quantity_on_hand_at_import",
      "unit_cost",
    ]);
    const REQUIRED_HEADER_SET = new Set(REQUIRED_HEADERS);
    const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
    const MAX_TEXT_LENGTHS = Object.freeze({
      item: 160,
      style: 160,
      size: 80,
    });
    const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
    const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
    const FNV_64_PRIME = 0x100000001b3n;
    const FNV_64_MASK = 0xffffffffffffffffn;

    class InventorySheetImportError extends Error {
      constructor(issues) {
        const frozenIssues = Object.freeze(
          issues.map((issue) => Object.freeze({ ...issue })),
        );
        const noun = frozenIssues.length === 1 ? "issue" : "issues";

        super(
          `The Inventory sheet contains ${frozenIssues.length} validation ${noun}.`,
        );
        this.name = "InventorySheetImportError";
        this.code = "INVALID_INVENTORY_SHEET";
        this.issues = frozenIssues;
      }
    }

    function createIssue(code, rowNumber, column, message) {
      return { code, rowNumber, column, message };
    }

    function failWithIssues(issues) {
      throw new InventorySheetImportError(issues);
    }

    function isBlankCell(value) {
      return value === undefined || value === null ||
        (typeof value === "string" && value.trim() === "");
    }

    function isBlankRow(row) {
      return Array.isArray(row) && row.every(isBlankCell);
    }

    function projectInventoryColumns(values) {
      if (!Array.isArray(values)) {
        failWithIssues([
          createIssue(
            "INVALID_SHEET_VALUES",
            null,
            null,
            "Inventory sheet values must be a two-dimensional array.",
          ),
        ]);
      }

      const issues = [];
      const projected = [];
      for (let index = 0; index < values.length; index += 1) {
        const row = values[index];
        if (!Array.isArray(row)) {
          issues.push(
            createIssue(
              "INVALID_SHEET_VALUES",
              index + 1,
              null,
              "Every Inventory sheet row must be an array.",
            ),
          );
        } else {
          projected.push(row.slice(0, REQUIRED_HEADERS.length));
        }
      }
      if (issues.length > 0) failWithIssues(issues);

      // Preserve physical row positions for diagnostics and quantity-only paste.
      // Personal columns never turn an A:F spacer into an inventory row.
      while (projected.length > 0 && isBlankRow(projected[projected.length - 1])) {
        projected.pop();
      }
      return projected;
    }

    function normalizeDisplayText(value) {
      if (typeof value !== "string" && typeof value !== "number") {
        return null;
      }

      return String(value)
        .normalize("NFC")
        .trim()
        .replace(/\s+/g, " ");
    }

    function hasUnsafeControlCharacter(value) {
      return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
    }

    function isFormulaCell(value) {
      return typeof value === "string" && value.trim().startsWith("=");
    }

    function validateHeaders(headerRow, rowNumber, issues) {
      if (headerRow.length !== REQUIRED_HEADERS.length) {
        issues.push(
          createIssue(
            "INVALID_HEADERS",
            rowNumber,
            null,
            `The header row must contain exactly: ${REQUIRED_HEADERS.join(", ")}.`,
          ),
        );
        return null;
      }

      const headerIndexes = new Map();
      let valid = true;

      headerRow.forEach((header, index) => {
        if (
          typeof header !== "string" ||
          !REQUIRED_HEADER_SET.has(header) ||
          headerIndexes.has(header)
        ) {
          valid = false;
          return;
        }

        headerIndexes.set(header, index);
      });

      if (
        !valid ||
        REQUIRED_HEADERS.some((header) => !headerIndexes.has(header))
      ) {
        issues.push(
          createIssue(
            "INVALID_HEADERS",
            rowNumber,
            null,
            `The header row must contain each supported header exactly once: ${REQUIRED_HEADERS.join(", ")}.`,
          ),
        );
        return null;
      }

      return headerIndexes;
    }

    function parseRequiredText(value, rowNumber, column, issues) {
      if (isBlankCell(value)) {
        issues.push(
          createIssue(
            "MISSING_REQUIRED_VALUE",
            rowNumber,
            column,
            `${column} is required.`,
          ),
        );
        return null;
      }

      const normalized = normalizeDisplayText(value);

      if (normalized === "") {
        issues.push(
          createIssue(
            "MISSING_REQUIRED_VALUE",
            rowNumber,
            column,
            `${column} is required.`,
          ),
        );
        return null;
      }

      if (
        normalized === null ||
        hasUnsafeControlCharacter(normalized) ||
        normalized.length > MAX_TEXT_LENGTHS[column]
      ) {
        issues.push(
          createIssue(
            "INVALID_TEXT_VALUE",
            rowNumber,
            column,
            `${column} must be plain text no longer than ${MAX_TEXT_LENGTHS[column]} characters.`,
          ),
        );
        return null;
      }

      return normalized;
    }

    function parseOptionalStyle(value, rowNumber, issues) {
      const normalized = normalizeDisplayText(value ?? "");

      if (
        normalized === null ||
        hasUnsafeControlCharacter(normalized) ||
        normalized.length > MAX_TEXT_LENGTHS.style
      ) {
        issues.push(
          createIssue(
            "INVALID_TEXT_VALUE",
            rowNumber,
            "style",
            `style must be plain text no longer than ${MAX_TEXT_LENGTHS.style} characters.`,
          ),
        );
        return null;
      }

      return normalized;
    }

    function parseSku(value, rowNumber, issues) {
      if (isBlankCell(value)) {
        issues.push(
          createIssue(
            "MISSING_REQUIRED_VALUE",
            rowNumber,
            "sku",
            "sku is required.",
          ),
        );
        return null;
      }

      const normalized = typeof value === "string"
        ? value.trim()
        : null;

      if (normalized === "") {
        issues.push(
          createIssue(
            "MISSING_REQUIRED_VALUE",
            rowNumber,
            "sku",
            "sku is required.",
          ),
        );
        return null;
      }

      if (normalized === null || !SKU_PATTERN.test(normalized)) {
        issues.push(
          createIssue(
            "INVALID_SKU",
            rowNumber,
            "sku",
            "sku must be 1-64 uppercase letters, numbers, periods, underscores, or hyphens.",
          ),
        );
        return null;
      }

      return normalized;
    }

    function parseQuantity(value, rowNumber, issues) {
      if (isBlankCell(value)) {
        issues.push(
          createIssue(
            "MISSING_REQUIRED_VALUE",
            rowNumber,
            "quantity_on_hand_at_import",
            "quantity_on_hand_at_import is required.",
          ),
        );
        return null;
      }

      const normalized = typeof value === "number" ? String(value) :
        typeof value === "string" ? value.trim() : "";

      if (!/^(0|[1-9]\d*)$/.test(normalized)) {
        issues.push(
          createIssue(
            "INVALID_QUANTITY_ON_HAND_AT_IMPORT",
            rowNumber,
            "quantity_on_hand_at_import",
            "quantity_on_hand_at_import must be a nonnegative safe integer.",
          ),
        );
        return null;
      }

      const parsed = BigInt(normalized);

      if (parsed > MAX_SAFE_INTEGER_BIGINT) {
        issues.push(
          createIssue(
            "INVALID_QUANTITY_ON_HAND_AT_IMPORT",
            rowNumber,
            "quantity_on_hand_at_import",
            "quantity_on_hand_at_import must be a nonnegative safe integer.",
          ),
        );
        return null;
      }

      return Number(parsed);
    }

    function parseUnitCost(value, rowNumber, issues) {
      if (isBlankCell(value)) {
        issues.push(
          createIssue(
            "MISSING_REQUIRED_VALUE",
            rowNumber,
            "unit_cost",
            "unit_cost is required.",
          ),
        );
        return null;
      }

      const normalized = typeof value === "number" ? String(value) :
        typeof value === "string" ? value.trim() : "";
      const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized);

      if (!match) {
        issues.push(
          createIssue(
            "INVALID_UNIT_COST",
            rowNumber,
            "unit_cost",
            "unit_cost must be a nonnegative plain USD decimal with at most two fractional digits.",
          ),
        );
        return null;
      }

      const fractional = (match[2] ?? "").padEnd(2, "0");
      const parsed = BigInt(match[1]) * 100n + BigInt(fractional || "0");

      if (parsed > MAX_SAFE_INTEGER_BIGINT) {
        issues.push(
          createIssue(
            "INVALID_UNIT_COST",
            rowNumber,
            "unit_cost",
            "unit_cost is too large to convert safely to integer cents.",
          ),
        );
        return null;
      }

      return Number(parsed);
    }

    function createFingerprint(inventory) {
      const fingerprintInventory = [...inventory].sort((left, right) => {
        if (left.sku === right.sku) {
          return 0;
        }

        return left.sku < right.sku ? -1 : 1;
      });
      const canonical = JSON.stringify({
        contractVersion: IMPORT_CONTRACT_VERSION,
        inventory: fingerprintInventory,
      });
      const bytes = new TextEncoder().encode(canonical);
      let hash = FNV_64_OFFSET_BASIS;

      for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = (hash * FNV_64_PRIME) & FNV_64_MASK;
      }

      return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
    }

    function parseInventorySheet(values) {
      values = projectInventoryColumns(values);

      const issues = [];
      let headerIndex = -1;

      for (let index = 0; index < values.length; index += 1) {
        const row = values[index];

        if (!isBlankRow(row)) {
          headerIndex = index;
          break;
        }
      }

      if (headerIndex < 0) {
        issues.push(
          createIssue(
            "EMPTY_INVENTORY",
            null,
            null,
            "The Inventory sheet must contain a header and at least one inventory row.",
          ),
        );
        failWithIssues(issues);
      }

      const headerRowNumber = headerIndex + 1;
      const headerIndexes = validateHeaders(
        values[headerIndex],
        headerRowNumber,
        issues,
      );

      if (headerIndexes === null) {
        failWithIssues(issues);
      }

      const parsedRows = [];
      let nonblankDataRows = 0;

      for (let index = headerIndex + 1; index < values.length; index += 1) {
        const row = values[index];
        const rowNumber = index + 1;

        if (isBlankRow(row)) {
          continue;
        }

        nonblankDataRows += 1;

        const rowIssueCountBefore = issues.length;

        const rawValues = Object.fromEntries(
          REQUIRED_HEADERS.map((header) => [header, row[headerIndexes.get(header)]]),
        );
        const formulaColumns = new Set();

        REQUIRED_HEADERS.forEach((column) => {
          if (isFormulaCell(rawValues[column])) {
            formulaColumns.add(column);
            issues.push(
              createIssue(
                "FORMULA_NOT_ALLOWED",
                rowNumber,
                column,
                `${column} must contain a value, not a formula.`,
              ),
            );
          }
        });

        const sku = formulaColumns.has("sku") ? null :
          parseSku(rawValues.sku, rowNumber, issues);
        const item = formulaColumns.has("item") ? null :
          parseRequiredText(rawValues.item, rowNumber, "item", issues);
        const style = formulaColumns.has("style") ? null :
          parseOptionalStyle(rawValues.style, rowNumber, issues);
        const size = formulaColumns.has("size") ? null :
          parseRequiredText(rawValues.size, rowNumber, "size", issues);
        const quantityOnHandAtImport =
          formulaColumns.has("quantity_on_hand_at_import") ? null :
            parseQuantity(
              rawValues.quantity_on_hand_at_import,
              rowNumber,
              issues,
            );
        const unitCostCents = formulaColumns.has("unit_cost") ? null :
          parseUnitCost(rawValues.unit_cost, rowNumber, issues);

        if (issues.length === rowIssueCountBefore) {
          parsedRows.push({
            rowNumber,
            inventory: {
              sku,
              item,
              style,
              size,
              quantityOnHandAtImport,
              unitCostCents,
            },
          });
        }
      }

      if (nonblankDataRows === 0) {
        issues.push(
          createIssue(
            "EMPTY_INVENTORY",
            null,
            null,
            "The Inventory sheet must contain at least one inventory row.",
          ),
        );
      }

      const seenSkus = new Map();
      const seenIdentities = new Map();

      parsedRows.forEach(({ rowNumber, inventory }) => {
        if (seenSkus.has(inventory.sku)) {
          issues.push(
            createIssue(
              "DUPLICATE_SKU",
              rowNumber,
              "sku",
              `sku duplicates Inventory row ${seenSkus.get(inventory.sku)}.`,
            ),
          );
        } else {
          seenSkus.set(inventory.sku, rowNumber);
        }

        const identity = [inventory.item, inventory.style, inventory.size]
          .map((value) => value.toLocaleLowerCase("en-US"))
          .join("\u0000");

        if (seenIdentities.has(identity)) {
          issues.push(
            createIssue(
              "DUPLICATE_INVENTORY_IDENTITY",
              rowNumber,
              null,
              `item, style, and size duplicate Inventory row ${seenIdentities.get(identity)}.`,
            ),
          );
        } else {
          seenIdentities.set(identity, rowNumber);
        }
      });

      let totalQuantity = 0n;
      let totalInventoryCost = 0n;

      parsedRows.forEach(({ inventory }) => {
        totalQuantity += BigInt(inventory.quantityOnHandAtImport);
        totalInventoryCost +=
          BigInt(inventory.quantityOnHandAtImport) *
          BigInt(inventory.unitCostCents);
      });

      if (
        totalQuantity > MAX_SAFE_INTEGER_BIGINT ||
        totalInventoryCost > MAX_SAFE_INTEGER_BIGINT
      ) {
        issues.push(
          createIssue(
            "UNSAFE_INVENTORY_TOTAL",
            null,
            null,
            "Inventory quantity or total cost exceeds the supported safe-integer range.",
          ),
        );
      }

      if (issues.length > 0) {
        failWithIssues(issues);
      }

      const inventory = Object.freeze(
        parsedRows.map(({ inventory: row }) => Object.freeze({ ...row })),
      );
      const summary = Object.freeze({
        rowCount: inventory.length,
        totalQuantityOnHandAtImport: Number(totalQuantity),
        totalInventoryCostCents: Number(totalInventoryCost),
      });

      return Object.freeze({
        contractVersion: IMPORT_CONTRACT_VERSION,
        fingerprint: createFingerprint(inventory),
        inventory,
        summary,
      });
    }

    return Object.freeze({
      IMPORT_CONTRACT_VERSION,
      REQUIRED_HEADERS,
      InventorySheetImportError,
      projectInventoryColumns,
      parseInventorySheet,
    });
  },
);
