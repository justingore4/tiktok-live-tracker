const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  IMPORT_CONTRACT_VERSION,
  REQUIRED_HEADERS,
  InventorySheetImportError,
  parseInventorySheet,
} = require("../extension/shared/inventory-sheet-import.js");

const HEADERS = [
  "sku",
  "item",
  "style",
  "size",
  "quantity_on_hand_at_import",
  "unit_cost",
];

function validValues() {
  return [
    [...HEADERS],
    [
      "STUSSY-TEE-BLACK-L",
      "Stussy tee",
      "black",
      "L",
      "5",
      "12.00",
    ],
    [
      "NIKE-HOODIE-GREY-XL",
      "Nike hoodie",
      "grey",
      "XL",
      3,
      14,
    ],
  ];
}

function captureImportError(values) {
  let captured = null;

  assert.throws(
    () => parseInventorySheet(values),
    (error) => {
      captured = error;
      assert.ok(error instanceof InventorySheetImportError);
      assert.equal(error.code, "INVALID_INVENTORY_SHEET");
      assert.equal(typeof error.message, "string");
      assert.notEqual(error.message, "");
      assert.ok(Array.isArray(error.issues));
      assert.ok(error.issues.length > 0);
      assert.equal(Object.isFrozen(error.issues), true);

      error.issues.forEach((issue) => {
        assert.equal(typeof issue.code, "string");
        assert.ok(Object.hasOwn(issue, "rowNumber"));
        assert.ok(Object.hasOwn(issue, "column"));
        assert.equal(typeof issue.message, "string");
        assert.notEqual(issue.message, "");
        assert.equal(Object.isFrozen(issue), true);
      });

      return true;
    },
  );

  return captured;
}

function findIssue(values, code, expectedLocation = {}) {
  const error = captureImportError(values);
  const issue = error.issues.find((candidate) => candidate.code === code);

  assert.ok(issue, `Expected an import issue with code ${code}.`);

  if (Object.hasOwn(expectedLocation, "rowNumber")) {
    assert.equal(issue.rowNumber, expectedLocation.rowNumber);
  }

  if (Object.hasOwn(expectedLocation, "column")) {
    assert.equal(issue.column, expectedLocation.column);
  }

  return issue;
}

test("publishes the exact versioned Inventory tab headers", () => {
  assert.ok(Number.isSafeInteger(IMPORT_CONTRACT_VERSION));
  assert.ok(IMPORT_CONTRACT_VERSION > 0);
  assert.deepEqual(REQUIRED_HEADERS, HEADERS);
  assert.equal(Object.isFrozen(REQUIRED_HEADERS), true);
});

test("publishes the same pure contract for browser and CommonJS consumers", () => {
  assert.equal(
    globalThis.TikTokLiveTrackerInventorySheetImport.parseInventorySheet,
    parseInventorySheet,
  );
  assert.equal(
    globalThis.TikTokLiveTrackerInventorySheetImport.IMPORT_CONTRACT_VERSION,
    IMPORT_CONTRACT_VERSION,
  );
});

test("keeps the downloadable Google Sheets template on the parser contract", () => {
  const template = fs.readFileSync(
    path.join(__dirname, "..", "docs", "google-sheets-inventory-template.csv"),
    "utf8",
  );
  const [headerLine] = template.replace(/^\uFEFF/, "").split(/\r?\n/u);

  assert.equal(headerLine, REQUIRED_HEADERS.join(","));
});

test("keeps the contract module free of network, browser-storage, and filesystem I/O", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "shared", "inventory-sheet-import.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/u);
  assert.doesNotMatch(source, /\bchrome\s*\.\s*(?:identity|storage)\b/u);
  assert.doesNotMatch(source, /\brequire\s*\(\s*["'](?:node:)?(?:fs|https?)["']\s*\)/u);
});

test("converts a valid Inventory tab into a detached import preview", () => {
  const result = parseInventorySheet(validValues());

  assert.equal(result.contractVersion, IMPORT_CONTRACT_VERSION);
  assert.deepEqual(result.inventory, [
    {
      sku: "STUSSY-TEE-BLACK-L",
      item: "Stussy tee",
      style: "black",
      size: "L",
      quantityOnHandAtImport: 5,
      unitCostCents: 1200,
    },
    {
      sku: "NIKE-HOODIE-GREY-XL",
      item: "Nike hoodie",
      style: "grey",
      size: "XL",
      quantityOnHandAtImport: 3,
      unitCostCents: 1400,
    },
  ]);
  assert.equal(typeof result.fingerprint, "string");
  assert.notEqual(result.fingerprint, "");
  assert.deepEqual(result.summary, {
    rowCount: 2,
    totalQuantityOnHandAtImport: 8,
    totalInventoryCostCents: 10200,
  });
});

test("matches columns by strict header name instead of fragile column position", () => {
  const values = [
    [
      "unit_cost",
      "size",
      "quantity_on_hand_at_import",
      "style",
      "item",
      "sku",
    ],
    ["12.00", "L", "5", "black", "Stussy tee", "STUSSY-TEE-BLACK-L"],
  ];

  assert.deepEqual(parseInventorySheet(values).inventory, [
    {
      sku: "STUSSY-TEE-BLACK-L",
      item: "Stussy tee",
      style: "black",
      size: "L",
      quantityOnHandAtImport: 5,
      unitCostCents: 1200,
    },
  ]);
});

test("uses the first nonblank row as the header and reports physical Sheet rows", () => {
  const values = [
    [],
    ["", "", ""],
    [...HEADERS],
    ["STUSSY-TEE-BLACK-L", "Stussy tee", "black", "L", "5", "12.00"],
  ];
  const result = parseInventorySheet(values);

  assert.equal(result.summary.rowCount, 1);

  values[3][1] = "";
  findIssue(values, "MISSING_REQUIRED_VALUE", {
    rowNumber: 4,
    column: "item",
  });
});

test("normalizes deliberate whitespace, permits blank styles, and ignores blank rows", () => {
  const values = [
    [...HEADERS],
    [],
    [
      "  STUSSY-TEE-BLACK-L  ",
      "  Stussy   tee ",
      "   ",
      " L ",
      " 5 ",
      " 12.00 ",
    ],
    ["", "", "", "", "", ""],
  ];

  assert.deepEqual(parseInventorySheet(values).inventory, [
    {
      sku: "STUSSY-TEE-BLACK-L",
      item: "Stussy tee",
      style: "",
      size: "L",
      quantityOnHandAtImport: 5,
      unitCostCents: 1200,
    },
  ]);
});

test("accepts plain nonnegative USD decimals while keeping money in cents", () => {
  const values = [
    [...HEADERS],
    ["FREE-SAMPLE-OS", "Free sample", "", "OS", 0, "0.00"],
    ["COAT-NAVY-M", "Coat", "navy", "M", 1, "1234.56"],
    ["PIN-RED-OS", "Pin", "red", "OS", "2", "0.5"],
  ];

  assert.deepEqual(
    parseInventorySheet(values).inventory.map(
      ({ sku, quantityOnHandAtImport, unitCostCents }) => ({
        sku,
        quantityOnHandAtImport,
        unitCostCents,
      }),
    ),
    [
      {
        sku: "FREE-SAMPLE-OS",
        quantityOnHandAtImport: 0,
        unitCostCents: 0,
      },
      { sku: "COAT-NAVY-M", quantityOnHandAtImport: 1, unitCostCents: 123456 },
      { sku: "PIN-RED-OS", quantityOnHandAtImport: 2, unitCostCents: 50 },
    ],
  );
});

test("requires exactly one of every supported header", () => {
  for (const values of [
    [["sku", "item", "style", "size", "quantity_on_hand_at_import"]],
    [[...HEADERS, "notes"]],
    [["sku", "item", "style", "size", "quantity_on_hand_at_import", "sku"]],
    [["SKU", "item", "style", "size", "quantity_on_hand_at_import", "unit_cost"]],
  ]) {
    findIssue(values, "INVALID_HEADERS", { rowNumber: 1 });
  }
});

test("rejects an empty Inventory tab and a header-only tab", () => {
  findIssue([], "EMPTY_INVENTORY");
  findIssue([[...HEADERS]], "EMPTY_INVENTORY");
});

test("rejects values that are not a two-dimensional Sheet array", () => {
  findIssue(null, "INVALID_SHEET_VALUES");
  findIssue([HEADERS, { sku: "NOT-A-SHEET-ROW" }], "INVALID_SHEET_VALUES", {
    rowNumber: 2,
  });
});

test("reports required field failures with their Sheet row and column", () => {
  const values = validValues();

  values[1][1] = "   ";
  values[1][3] = "";

  const error = captureImportError(values);

  assert.ok(
    error.issues.some(
      (issue) =>
        issue.code === "MISSING_REQUIRED_VALUE" &&
        issue.rowNumber === 2 &&
        issue.column === "item",
    ),
  );
  assert.ok(
    error.issues.some(
      (issue) =>
        issue.code === "MISSING_REQUIRED_VALUE" &&
        issue.rowNumber === 2 &&
        issue.column === "size",
    ),
  );
});

test("rejects a partial data row atomically instead of importing its valid cells", () => {
  const values = [
    [...HEADERS],
    ["STUSSY-TEE-BLACK-L", "Stussy tee", "black"],
  ];
  const error = captureImportError(values);

  assert.ok(
    error.issues.some(
      (issue) =>
        issue.code === "MISSING_REQUIRED_VALUE" &&
        issue.rowNumber === 2 &&
        issue.column === "size",
    ),
  );
  assert.ok(
    error.issues.some(
      (issue) =>
        issue.code === "MISSING_REQUIRED_VALUE" &&
        issue.rowNumber === 2 &&
        issue.column === "quantity_on_hand_at_import",
    ),
  );
  assert.ok(
    error.issues.some(
      (issue) =>
        issue.code === "MISSING_REQUIRED_VALUE" &&
        issue.rowNumber === 2 &&
        issue.column === "unit_cost",
    ),
  );
  assert.equal(Object.hasOwn(error, "inventory"), false);
});

test("rejects nonblank cells beyond the contract while allowing trailing blanks", () => {
  const extraValueRows = validValues();

  extraValueRows[1].push("unsupported employee note");
  findIssue(extraValueRows, "INVALID_SHEET_VALUES", {
    rowNumber: 2,
    column: null,
  });

  const trailingBlankRows = validValues();

  trailingBlankRows[1].push("", null, undefined);
  assert.deepEqual(
    parseInventorySheet(trailingBlankRows).inventory,
    parseInventorySheet(validValues()).inventory,
  );
});

test("requires an explicit uppercase, spreadsheet-safe SKU", () => {
  for (const sku of ["stussy-tee-black-l", "STUSSY TEE L", "SHIRT/BLUE/L", "👕-L"]) {
    const values = validValues();

    values[1][0] = sku;
    findIssue(values, "INVALID_SKU", { rowNumber: 2, column: "sku" });
  }
});

test("does not compatibility-normalize lookalike characters in stable SKUs", () => {
  for (const sku of ["ＳＴＵＳＳＹ-L", "KIT-L"]) {
    const values = validValues();

    values[1][0] = sku;
    findIssue(values, "INVALID_SKU", { rowNumber: 2, column: "sku" });
  }
});

test("rejects negative, fractional, unsafe, and nonnumeric imported quantities", () => {
  for (const quantity of [-1, "1.5", "9007199254740992", "five"]) {
    const values = validValues();

    values[1][4] = quantity;
    findIssue(values, "INVALID_QUANTITY_ON_HAND_AT_IMPORT", {
      rowNumber: 2,
      column: "quantity_on_hand_at_import",
    });
  }
});

test("rejects symbols, commas, negatives, and over-precise unit costs", () => {
  for (const unitCost of [
    "$1.00",
    "1,234.56",
    "-1.00",
    "12.345",
    "90071992547409.92",
    "EUR 12.00",
  ]) {
    const values = validValues();

    values[1][5] = unitCost;
    findIssue(values, "INVALID_UNIT_COST", {
      rowNumber: 2,
      column: "unit_cost",
    });
  }
});

test("rejects formulas in every Inventory data field without evaluating them", () => {
  HEADERS.forEach((column, columnIndex) => {
    const values = validValues();

    values[1][columnIndex] = "=1+1";
    findIssue(values, "FORMULA_NOT_ALLOWED", {
      rowNumber: 2,
      column,
    });
  });
});

test("rejects a single-row inventory cost product outside safe-integer range", () => {
  const values = [
    [...HEADERS],
    ["EXPENSIVE-PAIR", "Expensive pair", "", "OS", 2, "45035996273704.96"],
  ];

  findIssue(values, "UNSAFE_INVENTORY_TOTAL", {
    rowNumber: null,
    column: null,
  });
});

test("rejects safe rows whose aggregate quantity or inventory cost is unsafe", () => {
  const unsafeQuantityValues = [
    [...HEADERS],
    ["BULK-A", "Bulk item", "A", "OS", "9007199254740991", "0"],
    ["BULK-B", "Bulk item", "B", "OS", "1", "0"],
  ];
  const unsafeCostValues = [
    [...HEADERS],
    ["EXPENSIVE-A", "Expensive item", "A", "OS", 1, "45035996273704.96"],
    ["EXPENSIVE-B", "Expensive item", "B", "OS", 1, "45035996273704.96"],
  ];

  findIssue(unsafeQuantityValues, "UNSAFE_INVENTORY_TOTAL", {
    rowNumber: null,
    column: null,
  });
  findIssue(unsafeCostValues, "UNSAFE_INVENTORY_TOTAL", {
    rowNumber: null,
    column: null,
  });
});

test("collects independent row failures into one atomic import error", () => {
  const values = validValues();

  values[1] = ["bad sku", "", "black", "", "1.5", "12.345"];
  const error = captureImportError(values);

  assert.deepEqual(
    error.issues.map(({ code, rowNumber, column }) => ({
      code,
      rowNumber,
      column,
    })),
    [
      { code: "INVALID_SKU", rowNumber: 2, column: "sku" },
      { code: "MISSING_REQUIRED_VALUE", rowNumber: 2, column: "item" },
      { code: "MISSING_REQUIRED_VALUE", rowNumber: 2, column: "size" },
      {
        code: "INVALID_QUANTITY_ON_HAND_AT_IMPORT",
        rowNumber: 2,
        column: "quantity_on_hand_at_import",
      },
      { code: "INVALID_UNIT_COST", rowNumber: 2, column: "unit_cost" },
    ],
  );
});

test("rejects duplicate SKUs and duplicate item/style/size identities", () => {
  const duplicateSkuValues = validValues();

  duplicateSkuValues.push([
    "STUSSY-TEE-BLACK-L",
    "Stussy tee",
    "black",
    "M",
    1,
    "12.00",
  ]);
  findIssue(duplicateSkuValues, "DUPLICATE_SKU", {
    rowNumber: 4,
    column: "sku",
  });

  const duplicateIdentityValues = validValues();

  duplicateIdentityValues.push([
    "A-DIFFERENT-SKU",
    " stussy TEE ",
    "BLACK",
    "l",
    1,
    "12.00",
  ]);
  findIssue(duplicateIdentityValues, "DUPLICATE_INVENTORY_IDENTITY", {
    rowNumber: 4,
  });
});

test("canonicalizes employee-facing Unicode before duplicate detection", () => {
  const values = [
    [...HEADERS],
    ["CAFE-TEE-A", "Caf\u00e9 tee", "black", "L", 1, "12.00"],
    ["CAFE-TEE-B", "Cafe\u0301 tee", "black", "L", 1, "12.00"],
  ];

  findIssue(values, "DUPLICATE_INVENTORY_IDENTITY", { rowNumber: 3 });
});

test("creates a deterministic fingerprint from normalized inventory values", () => {
  const first = parseInventorySheet(validValues());
  const equivalentValues = [
    [
      "style",
      "unit_cost",
      "item",
      "quantity_on_hand_at_import",
      "sku",
      "size",
    ],
    [" black ", "12", " Stussy   tee ", 5, "STUSSY-TEE-BLACK-L", "L"],
    ["grey", "14.00", "Nike hoodie", "3", "NIKE-HOODIE-GREY-XL", "XL"],
  ];
  const equivalent = parseInventorySheet(equivalentValues);
  const changedValues = validValues();

  changedValues[1][4] = 6;
  const changed = parseInventorySheet(changedValues);

  assert.deepEqual(equivalent.inventory, first.inventory);
  assert.equal(first.fingerprint, "fnv1a64:59816505a5757e62");
  assert.equal(equivalent.fingerprint, first.fingerprint);
  assert.notEqual(changed.fingerprint, first.fingerprint);
});

test("keeps the fingerprint stable when employees reorder valid inventory rows", () => {
  const originalValues = validValues();
  const reorderedValues = [
    [...HEADERS],
    [...originalValues[2]],
    [...originalValues[1]],
  ];
  const original = parseInventorySheet(originalValues);
  const reordered = parseInventorySheet(reorderedValues);

  assert.notDeepEqual(reordered.inventory, original.inventory);
  assert.equal(reordered.fingerprint, original.fingerprint);
  assert.deepEqual(reordered.summary, original.summary);
});

test("does not mutate Sheet values and returns deeply detached frozen results", () => {
  const values = validValues();
  const before = structuredClone(values);
  const result = parseInventorySheet(values);

  assert.deepEqual(values, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.inventory), true);
  assert.equal(Object.isFrozen(result.inventory[0]), true);
  assert.equal(Object.isFrozen(result.summary), true);

  values[1][1] = "Changed input";
  assert.equal(result.inventory[0].item, "Stussy tee");

  const second = parseInventorySheet(validValues());
  assert.notEqual(second, result);
  assert.notEqual(second.inventory, result.inventory);
  assert.notEqual(second.inventory[0], result.inventory[0]);
  assert.deepEqual(second, result);
});

test("is synchronous and deterministic without an I/O dependency", () => {
  const first = parseInventorySheet(validValues());
  const second = parseInventorySheet(validValues());

  assert.equal(typeof first?.then, "undefined");
  assert.deepEqual(second, first);
});
