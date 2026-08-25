const assert = require("node:assert/strict");
const test = require("node:test");

const protocol = require(
  "../extension/shared/inventory-import-protocol.js"
);

test("creates exact versioned inventory-import messages", () => {
  const command = {
    type: protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
    spreadsheetId: "1Abc_def-Ghij234567890",
  };

  assert.deepEqual(protocol.createInventoryImportMessage(command), {
    channel: "tiktok-live-tracker.inventory-import",
    version: 1,
    command,
  });

  const message = protocol.createInventoryImportMessage(command);
  command.spreadsheetId = "1Changed_sheet_identifier_12345";
  assert.equal(message.command.spreadsheetId, "1Abc_def-Ghij234567890");
});

test("accepts only the four exact command shapes", () => {
  assert.deepEqual(
    protocol.validateCommand({
      type: protocol.COMMAND_TYPES.GET_IMPORT_STATUS,
    }),
    { type: "get_import_status" },
  );
  assert.deepEqual(
    protocol.validateCommand({
      type: protocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT,
      previewToken:
        "inventory-preview:12345678-1234-4123-8123-123456789abc",
    }),
    {
      type: "confirm_google_sheet_import",
      previewToken:
        "inventory-preview:12345678-1234-4123-8123-123456789abc",
    },
  );
  assert.deepEqual(
    protocol.validateCommand({
      type:
        protocol.COMMAND_TYPES.ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
      spreadsheetId: "1Abc_def-Ghij234567890",
    }),
    {
      type: "add_active_stream_skus_from_google_sheet",
      spreadsheetId: "1Abc_def-Ghij234567890",
    },
  );

  assert.throws(
    () =>
      protocol.validateCommand({
        type: protocol.COMMAND_TYPES.CONFIRM_GOOGLE_SHEET_IMPORT,
        previewToken:
          "inventory-preview:12345678-1234-4123-8123-123456789abc",
        inventory: [],
      }),
    (error) => error.code === "INVALID_COMMAND",
  );
  assert.throws(
    () =>
      protocol.validateCommand({
        type: protocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
        spreadsheetId: "https://docs.google.com/spreadsheets/d/not-an-id",
      }),
    (error) => error.code === "INVALID_SPREADSHEET_ID",
  );
  assert.throws(
    () =>
      protocol.validateCommand({
        type:
          protocol.COMMAND_TYPES.ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
        spreadsheetId: "1Abc_def-Ghij234567890",
        streamId: "caller-controlled-stream",
      }),
    (error) => error.code === "INVALID_COMMAND",
  );
});

test("rejects extra envelope fields and unsupported versions", () => {
  assert.throws(
    () =>
      protocol.validateInventoryImportMessage({
        channel: protocol.MESSAGE_CHANNEL,
        version: protocol.MESSAGE_VERSION,
        command: { type: protocol.COMMAND_TYPES.GET_IMPORT_STATUS },
        inventory: [],
      }),
    (error) => error.code === "INVALID_MESSAGE",
  );
  assert.throws(
    () =>
      protocol.validateInventoryImportMessage({
        channel: protocol.MESSAGE_CHANNEL,
        version: 2,
        command: { type: protocol.COMMAND_TYPES.GET_IMPORT_STATUS },
      }),
    (error) => error.code === "UNSUPPORTED_MESSAGE_VERSION",
  );
});
