const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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

test("requests only tracker, unlimited local storage, and PDF download permissions", () => {
  assert.deepEqual([...manifest.permissions].sort(), [
    "downloads",
    "identity",
    "sidePanel",
    "storage",
    "unlimitedStorage",
  ]);
});

test("preserves the public key and permanent private extension ID", () => {
  const publicKeyBytes = Buffer.from(manifest.key, "base64");
  assert.equal(publicKeyBytes.toString("base64"), manifest.key);

  const fingerprint = createHash("sha256")
    .update(publicKeyBytes)
    .digest("hex");

  // Pin the complete public key, not only the prefix used for Chrome's ID.
  assert.equal(
    fingerprint,
    "bcab9a49c82adb44b3564a116fd462ce83753ec0bff920d3077e7432c5fbd4cb",
  );

  const extensionId = fingerprint.slice(0, 32).replace(
    /[0-9a-f]/g,
    (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)),
  );
  assert.equal(extensionId, "lmkljkejmicknleeldfgekbbgpnegcmo");
});

test("preserves the configured OAuth client and read-only Google Sheets access", () => {
  assert.deepEqual(manifest.host_permissions, [
    "https://sheets.googleapis.com/*",
  ]);
  assert.deepEqual(manifest.oauth2, {
    client_id:
      "627721501298-v850an3m2mog3re717nd4kd6rnp76eh7.apps.googleusercontent.com",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
});

test("does not ship a service-account secret in the extension manifest", () => {
  const serialized = JSON.stringify(manifest).toLowerCase();

  assert.doesNotMatch(serialized, /private_key|client_secret|service_account/);
});
