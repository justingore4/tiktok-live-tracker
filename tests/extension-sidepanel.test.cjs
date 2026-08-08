const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionDirectory = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"),
);

function extensionResourceExists(relativePath) {
  return fs.existsSync(path.join(extensionDirectory, relativePath));
}

test("manifest configures the Chrome side-panel resources", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(Number(manifest.minimum_chrome_version) >= 114);
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(extensionResourceExists(manifest.side_panel.default_path));
  assert.ok(extensionResourceExists(manifest.background.service_worker));
  assert.equal(manifest.action.default_title, "Open TikTok Live Tracker");
});

test("service worker opens the side panel from the toolbar action", () => {
  const workerSource = fs.readFileSync(
    path.join(extensionDirectory, manifest.background.service_worker),
    "utf8",
  );
  let requestedBehavior = null;
  const sandbox = {
    chrome: {
      sidePanel: {
        setPanelBehavior(behavior) {
          requestedBehavior = behavior;
          return Promise.resolve();
        },
      },
    },
    console,
  };

  vm.runInNewContext(workerSource, sandbox);

  assert.equal(requestedBehavior?.openPanelOnActionClick, true);
});

test("side panel keeps every script and stylesheet inside the extension", () => {
  const panelPath = path.join(
    extensionDirectory,
    manifest.side_panel.default_path,
  );
  const panelDirectory = path.dirname(panelPath);
  const html = fs.readFileSync(panelPath, "utf8");
  const resourcePaths = [
    ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g),
  ].map((match) => match[1]);

  assert.deepEqual(resourcePaths, [
    "sidepanel.css",
    "inventory-view-model.js",
    "sidepanel.js",
  ]);
  assert.ok(
    resourcePaths.every((relativePath) =>
      fs.existsSync(path.join(panelDirectory, relativePath)),
    ),
  );
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
});

test("side panel exposes accessible search and clearly labels demo data", () => {
  const html = fs.readFileSync(
    path.join(extensionDirectory, manifest.side_panel.default_path),
    "utf8",
  );

  assert.match(html, /<label[^>]+for="inventory-search"/);
  assert.match(html, /id="result-count"[^>]+aria-live="polite"/);
  assert.match(html, /id="inventory-grid"[^>]+role="list"/);
  assert.match(html, />Demo data</);
  assert.match(html, /Preview only/);
  assert.doesNotMatch(html, /reconciliation\.js/);
});

test("existing dashboard capture scripts remain configured", () => {
  const dashboardScript = manifest.content_scripts.find((script) =>
    script.matches.includes(
      "https://shop.tiktok.com/streamer/live/event/dashboard*",
    ),
  );

  assert.deepEqual(dashboardScript.js, [
    "shared/sale-parser.js",
    "capture/content.js",
  ]);
  assert.ok(dashboardScript.js.every(extensionResourceExists));
});
