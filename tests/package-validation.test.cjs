"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateArchivePath, isOsJunk, assertSafeFile, validateExtension } = require("../scripts/package-validation.cjs");

function fixture(manifest = {}, extra = {}) {
  return new Map(Object.entries({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Packaging fixture", version: "1.0.0", ...manifest }),
    ...extra,
  }).map(([name, value]) => [name, Buffer.from(value)]));
}

test("validates a minimal MV3 extension and returns its parsed version", () => {
  assert.equal(validateExtension(fixture()).version, "1.0.0");
  for (const version of ["1", "0.1", "1.2.3.4", "65535.65535.65535.65535"]) {
    assert.equal(validateExtension(fixture({ version })).version, version);
  }
});

test("rejects missing, malformed, or invalid manifests without exposing source", () => {
  assert.throws(() => validateExtension(new Map()), /missing manifest.json/);
  assert.throws(() => validateExtension(new Map([["manifest.json", Buffer.from("{ broken")]])), /valid JSON/);
  for (const manifest of [null, [], "text", { manifest_version: 2 }, { manifest_version: "3" }]) {
    const files = fixture({}, { "manifest.json": JSON.stringify(manifest) });
    assert.throws(() => validateExtension(files), /manifest_version 3/);
  }
  for (const name of [null, "", "  ", 1]) assert.throws(() => validateExtension(fixture({ name })), /nonempty name/);
  for (const version of [null, 1, "", "0", "0.0.0.0", "01.2", "1.02", "1.2.3.4.5", "1.0-beta", "65536", "-1", "1."]) {
    assert.throws(() => validateExtension(fixture({ version })), /Chrome extension version/);
  }
  for (const minimum_chrome_version of [114, "", "114-beta", "114.0.0.0.1"]) {
    assert.throws(() => validateExtension(fixture({ minimum_chrome_version })), /Chrome version string/);
  }
});

test("validates every supported manifest local-resource entry", () => {
  const cases = [
    { background: { service_worker: "missing.js" } },
    { content_scripts: [{ js: ["missing.js"] }] },
    { content_scripts: [{ css: ["missing.css"] }] },
    { side_panel: { default_path: "missing.html" } },
    { action: { default_popup: "missing.html" } },
    { action: { default_icon: "missing.png" } },
    { icons: { 128: "missing.png" } },
    { options_page: "missing.html" },
    { options_ui: { page: "missing.html" } },
    { devtools_page: "missing.html" },
    { chrome_url_overrides: { newtab: "missing.html" } },
    { sandbox: { pages: ["missing.html"] } },
    { storage: { managed_schema: "missing.json" } },
    { declarative_net_request: { rule_resources: [{ id: "rules", path: "missing.json" }] } },
    { web_accessible_resources: [{ resources: ["missing.png"], matches: ["<all_urls>"] }] },
    { default_locale: "en" },
  ];
  for (const manifest of cases) assert.throws(() => validateExtension(fixture(manifest)), /Missing local resource/);
  assert.throws(() => validateExtension(fixture({ background: { scripts: [] } })), /service_worker/);
  assert.throws(() => validateExtension(fixture({ content_scripts: "worker.js" })), /Invalid content_scripts/);
  assert.throws(() => validateExtension(fixture({ content_scripts: [{ js: "worker.js" }] })), /Invalid content_scripts.js/);
  assert.throws(() => validateExtension(fixture({ side_panel: {} })), /Missing side_panel.default_path/);
  assert.throws(() => validateExtension(fixture({ background: { service_worker: "https://example.com/worker.js" } })), /Invalid external resource/);
});

test("validates web-accessible resource globs without treating host patterns as local files", () => {
  const manifest = { web_accessible_resources: [{ resources: ["assets/*.png"], matches: ["https://example.com/*"] }] };
  assert.doesNotThrow(() => validateExtension(fixture(manifest, { "assets/icon.png": "image" })));
  assert.throws(() => validateExtension(fixture(manifest)), /no matching files/);
});

test("follows HTML, CSS, and JavaScript references transitively", () => {
  const files = fixture({ side_panel: { default_path: "ui/panel.html" } }, {
    "ui/panel.html": '<link href="panel.css" rel="stylesheet"><script src="../worker.js"></script>',
    "ui/panel.css": '@import "../styles/base.css"; .icon { background: url("../assets/icon.png?size=1#icon"); }',
    "styles/base.css": '@font-face { src: url(../fonts/regular.woff2); }',
    "assets/icon.png": "image",
    "fonts/regular.woff2": "font",
    "worker.js": 'importScripts("shared/one.js", "shared/two.js"); chrome.runtime.getURL("report/report.html");',
    "shared/one.js": 'import helper from "./helper.js"; export { helper } from "./export.js";',
    "shared/two.js": 'import "./side-effect.js"; import("./dynamic.js");',
    "shared/helper.js": "",
    "shared/export.js": "",
    "shared/side-effect.js": "",
    "shared/dynamic.js": "",
    "report/report.html": "<!doctype html><title>Report</title>",
  });
  assert.doesNotThrow(() => validateExtension(files));
  for (const name of [...files.keys()].filter((name) => name !== "manifest.json")) {
    const missing = new Map(files);
    missing.delete(name);
    assert.throws(() => validateExtension(missing), /Missing local resource/, name);
  }
});

test("scans new/unreachable HTML, CSS and JS too; this is not a runtime whitelist", () => {
  for (const [name, source] of [
    ["new.html", '<script src="missing.js"></script>'],
    ["new.css", '@import url("missing.css");'],
    ["new.js", 'importScripts("missing.js");'],
  ]) assert.throws(() => validateExtension(fixture({}, { [name]: source })), /Missing local resource/);
});

test("understands parent-relative, root-relative, encoded, query and fragment references", () => {
  const files = fixture({}, {
    "nested/page.html": '<script src="../js/./worker.js?v=1&amp;x=2#hash"></script><link href="/styles/site.css">',
    "styles/site.css": 'body { background: url("../assets/my%20icon.png"); mask: url(#mask); }',
    "assets/my icon.png": "",
    "js/worker.js": 'chrome?.runtime?.getURL(`nested/page.html?record=${recordId}`); import "\\x2e/second.js";',
    "js/second.js": "",
  });
  assert.doesNotThrow(() => validateExtension(files));
  files.delete("nested/page.html");
  assert.throws(() => validateExtension(files), /Missing local resource/);
});

test("does not interpret comments or string prose as JavaScript imports", () => {
  const source = '// importScripts("missing-comment.js");\n/* import "missing-block.js"; */\n' +
    'const prose = \'importScripts("missing-prose.js")\'; const text = `import "missing-template.js"`;';
  assert.doesNotThrow(() => validateExtension(fixture({}, { "worker.js": source })));
  assert.throws(() => validateExtension(fixture({}, { "worker.js": 'importScripts(dynamicPath, "missing.js");' })), /Missing local resource/);
});

test("keeps regular-expression literals opaque without swallowing imports after division", () => {
  for (const source of [
    'const re = /import "missing.js"/;',
    'const re = /importScripts("missing.js")/;',
    'if (condition) /import "missing.js"/.test(text);',
    'function pattern() { return /import "missing.js"/; }',
  ]) assert.doesNotThrow(() => validateExtension(fixture({}, { "module.js": source })), source);
  for (const source of [
    'const re = /[/*]/; import "./missing.js";',
    'const re = /[\\/]/; import "./missing.js";',
    'const re = condition ? /[/*]/ : null; import "./missing.js";',
    'const ratio = value / divisor; import "./missing.js";',
    'const ratio = fn() / divisor; import "./missing.js"; const next = a / b;',
    'const ratio = items[0] / divisor; import "./missing.js";',
    'const ratio = value++ / divisor; import "./missing.js";',
    'const ratio = value-- / divisor; import "./missing.js";',
    'const ratio = 12 / 3; import "./missing.js";',
  ]) assert.throws(() => validateExtension(fixture({}, { "module.js": source })), /Missing local resource/, source);
});

test("ignores external, data, blob and fragment resources", () => {
  const files = fixture({}, {
    "page.html": '<link href="https://example.com/theme.css"><img src="data:image/png;base64,AAAA"><script src="//example.com/script.js"></script>',
    "site.css": 'a { mask:url(#icon); background:url(data:image/png;base64,AAAA); } @import "https://example.com/style.css";',
    "module.js": 'import "https://example.com/module.js"; import("blob:https://example.com/id");',
  });
  assert.doesNotThrow(() => validateExtension(files));
});

test("rejects escaping, file URLs, malformed escapes and Windows-style resource paths", () => {
  for (const reference of ["../../outside.js", "%2e%2e/%2e%2e/outside.js", "file:///secret.js", "C:/secret.js", "C:\\secret.js", "%00.js", "bad%QQ.js"]) {
    assert.throws(() => validateExtension(fixture({}, { "nested/page.html": `<script src="${reference}"></script>` })), /escapes extension root|Invalid external|Unsafe|Invalid encoded/);
  }
  assert.throws(() => validateExtension(fixture({}, { "worker.js": 'chrome.runtime.getURL("https://example.com/script.js");' })), /Invalid external/);
});

test("requires PDF runtime libraries, dynamically loaded fonts, and license files", () => {
  const required = [
    "vendor/jspdf/jspdf.umd.min.js", "vendor/jspdf/LICENSE",
    "vendor/jspdf-autotable/jspdf.plugin.autotable.min.js", "vendor/jspdf-autotable/LICENSE.txt",
    "vendor/fonts/DejaVuSans.ttf", "vendor/fonts/DejaVuSans-Bold.ttf", "vendor/fonts/LICENSE-DejaVu.txt",
  ];
  const files = fixture({}, { "report/report-pdf.js": "", ...Object.fromEntries(required.map((name) => [name, ""])) });
  assert.doesNotThrow(() => validateExtension(files));
  for (const name of required) {
    const missing = new Map(files);
    missing.delete(name);
    assert.throws(() => validateExtension(missing), /Missing local resource/, name);
  }
});

test("rejects environment, credential, and private-key filenames", () => {
  for (const name of [".env", ".env.local", ".ENV.production", "production.env", ".envrc", ".npmrc", ".netrc", "nested/credentials.json", ".credentials", "google-credentials.json", "credential.json", "secret.txt", "secrets.json", "service-account-prod.json", "client_secret_123.json", "private-key.txt", "id_rsa", "id_ed25519", "cert.pem", "archive.p12", "signing.key", ".aws/config"]) {
    assert.throws(() => assertSafeFile(name, Buffer.from("harmless")), /potentially sensitive file/i, name);
  }
});

test("rejects token credential artifacts while allowing token-related runtime code", () => {
  for (const name of ["token.json", "tokens.json", ".token", ".tokens", "oauth-token.json", "nested/oauth_tokens.json"]) {
    assert.throws(() => assertSafeFile(name, Buffer.from("{}")), /potentially sensitive file/i);
  }
  assert.doesNotThrow(() => assertSafeFile("token-client.js", Buffer.from("const token = null;")));
});

test("rejects private keys and recognizable credentials in ordinary files without revealing their values", () => {
  const contents = [
    "-----BEGIN PRIVATE KEY-----\nVERY_PRIVATE_SENTINEL\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nVERY_PRIVATE_SENTINEL",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nVERY_PRIVATE_SENTINEL",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVERY_PRIVATE_SENTINEL",
    'const clientSecret = "VERY_PRIVATE_SENTINEL";',
    'const client_secret = `VERY_PRIVATE_SENTINEL`;',
    'const apiKey = `VERY_PRIVATE_SENTINEL`;',
    '{"refresh_token":"VERY_PRIVATE_SENTINEL"}',
    '{"access_token":"VERY_PRIVATE_SENTINEL"}',
    '{"private_key":"VERY_PRIVATE_SENTINEL"}',
    'password = "VERY_PRIVATE_SENTINEL"',
    'Authorization: "Bearer VERY_PRIVATE_SENTINEL"',
    "API_KEY=VERY_PRIVATE_SENTINEL",
    "AKIA1234567890ABCDEF",
    "ghp_abcdefghijklmnopqrstuvwxyz1234",
  ];
  for (const content of contents) {
    assert.throws(() => assertSafeFile("ordinary.txt", Buffer.from(content)), (error) => {
      assert.match(error.message, /Potential secret content/);
      assert.ok(!error.message.includes("VERY_PRIVATE_SENTINEL"));
      assert.ok(!error.message.includes(content));
      return true;
    });
  }
  assert.throws(() => validateExtension(fixture({}, { "nested/ordinary.txt": contents[0] })), /Potential secret content/);
});

test("allows manifest OAuth client IDs/public keys and runtime token-handling code", () => {
  const files = fixture({
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8APublicKeyNotASecret",
    oauth2: { client_id: "1234-example.apps.googleusercontent.com", scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] },
  }, {
    "auth.js": 'const token = await getAccessToken(); const headers = {Authorization: `Bearer ${token}`}; const state = { password: "", access_token: null }; const clientSecret = `${config.secret}`;',
    "id_ed25519.pub": "ssh-ed25519 public-material",
    "license.txt": "Permission is hereby granted, free of charge.",
  });
  assert.doesNotThrow(() => validateExtension(files));
});

test("rejects unsafe and nonportable archive paths", () => {
  for (const name of ["", "/root.js", "../file", "a/../file", "a/./file", "a//file", "a/", "C:/file", "a\\file", "a:file", "a?file", "a*file", "a|file", 'a"file', "a<file", "a>file", "CON", "nul.txt", "aux.js", "COM1.js", "lpt9", "COM¹.txt", "con .txt", "file.", "file ", "a\u0000b", "a\nb", "cafe\u0301.js"]) {
    assert.throws(() => validateArchivePath(name), /Unsafe or nonportable/, JSON.stringify(name));
  }
  for (const name of ["manifest.json", "assets/my icon.png", "vendor/LICENSE", "café.js", "com10.js", "nested/private-public.txt"]) {
    assert.equal(validateArchivePath(name), name);
  }
  const collision = fixture({}, { "A.js": "", "a.js": "" });
  assert.throws(() => validateExtension(collision), /case-insensitive/);
});

test("identifies only narrow OS-junk basenames case-insensitively", () => {
  for (const name of [".DS_Store", "nested/.ds_STORE", "._report.js", "Thumbs.db", "DESKTOP.INI", "__MACOSX"]) assert.equal(isOsJunk(name), true, name);
  for (const name of ["manifest.json", "report.js", "licenses.txt", "README.md", "Thumbs.db.js", "file.DS_Store", "node_modules"]) assert.equal(isOsJunk(name), false, name);
});
