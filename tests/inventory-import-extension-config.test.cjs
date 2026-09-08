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

test("package and extension release versions stay aligned", () => {
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );

  assert.equal(packageMetadata.version, manifest.version);
});

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
    /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/,
    "use the configured public Chrome Extension OAuth client ID",
  );
});

test("does not ship a service-account secret in the extension manifest", () => {
  const serialized = JSON.stringify(manifest).toLowerCase();

  assert.doesNotMatch(serialized, /private_key|client_secret|service_account/);
});
