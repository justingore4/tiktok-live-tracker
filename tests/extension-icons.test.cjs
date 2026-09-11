const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { crc32, inflateSync } = require("node:zlib");
const { unzipSync } = require("fflate");
const {
  readExtensionSnapshot,
  buildArchive,
  verifyArchive,
} = require("../scripts/package-extension.cjs");

const root = path.join(__dirname, "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(extension, "manifest.json"), "utf8"),
);
const icons = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};

test("extension listing and toolbar action share every packaged icon size", () => {
  assert.deepEqual(manifest.icons, icons);
  assert.deepEqual(manifest.action.default_icon, icons);
  assert.deepEqual(manifest.action, {
    default_title: "Open TikTok Live Tracker",
    default_icon: icons,
  });
});

for (const [size, resource] of Object.entries(icons)) {
  test(`${resource} is a complete PNG with the declared ${size}px dimensions`, () => {
    const bytes = fs.readFileSync(path.join(extension, resource));
    assert.deepEqual(bytes.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const chunks = [];
    let offset = 8;
    while (offset < bytes.length) {
      assert.ok(offset + 12 <= bytes.length, "PNG chunk header is complete");
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      const dataEnd = offset + 8 + length;
      assert.ok(dataEnd + 4 <= bytes.length, `${type} chunk is complete`);
      assert.equal(crc32(bytes.subarray(offset + 4, dataEnd)),
        bytes.readUInt32BE(dataEnd), `${type} chunk checksum matches`);
      chunks.push({ type, data: bytes.subarray(offset + 8, dataEnd) });
      offset = dataEnd + 4;
    }
    assert.equal(chunks[0].type, "IHDR");
    assert.equal(chunks.at(-1).type, "IEND");
    assert.equal(chunks.at(-1).data.length, 0);
    assert.equal(chunks.filter((chunk) => chunk.type === "IHDR").length, 1);
    assert.equal(chunks.filter((chunk) => chunk.type === "IEND").length, 1);
    const header = chunks[0].data;
    assert.equal(header.length, 13);
    assert.equal(header.readUInt32BE(0), Number(size));
    assert.equal(header.readUInt32BE(4), Number(size));
    assert.equal(header[8], 8, "icon pixels use 8-bit channels");
    assert.ok([2, 6].includes(header[9]), "icon pixels are RGB or RGBA");
    assert.deepEqual([...header.subarray(10)], [0, 0, 0],
      "icons use standard compression/filtering without interlacing");
    const compressed = chunks.filter((chunk) => chunk.type === "IDAT");
    assert.ok(compressed.length > 0, "PNG contains image data");
    const pixels = inflateSync(Buffer.concat(compressed.map((chunk) => chunk.data)));
    const rowBytes = Number(size) * (header[9] === 6 ? 4 : 3) + 1;
    assert.equal(pixels.length, rowBytes * Number(size));
    for (let row = 0; row < Number(size); row += 1) {
      assert.ok(pixels[row * rowBytes] <= 4, "each row has a valid PNG filter");
    }
  });
}

test("icon configuration preserves extension identity, release, OAuth, and permissions", () => {
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "TikTok Live Tracker");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "114");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(packageMetadata.version, manifest.version);
  const publicKey = Buffer.from(manifest.key, "base64");
  assert.equal(publicKey.toString("base64"), manifest.key);
  const fingerprint = createHash("sha256").update(publicKey).digest("hex");
  assert.equal(fingerprint,
    "bcab9a49c82adb44b3564a116fd462ce83753ec0bff920d3077e7432c5fbd4cb");
  assert.equal(fingerprint.slice(0, 32).replace(/[0-9a-f]/g,
    (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))),
  "lmkljkejmicknleeldfgekbbgpnegcmo");
  assert.deepEqual([...manifest.permissions].sort(), [
    "downloads", "identity", "sidePanel", "storage", "unlimitedStorage",
  ]);
  assert.deepEqual(manifest.host_permissions, ["https://sheets.googleapis.com/*"]);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.oauth2, {
    client_id:
      "627721501298-v850an3m2mog3re717nd4kd6rnp76eh7.apps.googleusercontent.com",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  assert.deepEqual(manifest.background, { service_worker: "service-worker.js" });
  assert.deepEqual(manifest.side_panel, { default_path: "tagger/sidepanel.html" });
});

test("release packaging includes every icon and both manifest mappings without writing an artifact", async () => {
  const snapshot = await readExtensionSnapshot(root);
  const zip = buildArchive(snapshot);
  verifyArchive(zip, snapshot);
  const entries = unzipSync(zip);
  const packagedManifest = JSON.parse(
    Buffer.from(entries["extension/manifest.json"]).toString("utf8"),
  );
  assert.deepEqual(packagedManifest.icons, icons);
  assert.deepEqual(packagedManifest.action.default_icon, icons);
  for (const resource of Object.values(icons)) {
    assert.ok(snapshot.files.has(resource), `${resource} is in the source snapshot`);
    assert.ok(Object.hasOwn(entries, `extension/${resource}`),
      `${resource} is included in the release archive`);
    assert.deepEqual(Buffer.from(entries[`extension/${resource}`]),
      snapshot.files.get(resource), "packaging preserves exact PNG bytes");
  }
});
