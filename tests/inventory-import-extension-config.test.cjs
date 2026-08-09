const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "extension", "manifest.json"),
    "utf8",
  ),
);

test("requests only browser identity and read-only Google Sheets access", () => {
  assert.ok(manifest.permissions.includes("identity"));
  assert.deepEqual(manifest.host_permissions, [
    "https://sheets.googleapis.com/*",
  ]);
  assert.deepEqual(manifest.oauth2.scopes, [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ]);
  assert.match(
    manifest.oauth2.client_id,
    /^(?:REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID|[0-9]+-[A-Za-z0-9_-]+)\.apps\.googleusercontent\.com$/,
    "use either the safe checked-in placeholder or a public Chrome Extension OAuth client ID",
  );
});

test("does not ship a service-account secret in the extension manifest", () => {
  const serialized = JSON.stringify(manifest).toLowerCase();

  assert.doesNotMatch(serialized, /private_key|client_secret|service_account/);
});
