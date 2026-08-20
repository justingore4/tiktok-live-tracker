const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createVariationSelectorLock,
} = require("../extension/tagger/variation-selector-lock.js");

function createHarness() {
  const applied = [];
  const lock = createVariationSelectorLock({
    apply(value) {
      applied.push(value);
    },
  });

  return { applied, lock };
}

test("variation selector renders immediately while its native menu is closed", () => {
  const { applied, lock } = createHarness();
  const initial = { selectedVariationNumber: 10 };

  lock.requestRender(initial);

  assert.deepEqual(applied, [initial]);
  assert.equal(lock.isLocked(), false);
});

test("variation selector freezes while open and flushes only the latest update", () => {
  const { applied, lock } = createHarness();
  const first = { selectedVariationNumber: 10, status: "processing" };
  const second = { selectedVariationNumber: 10, status: "payment_fixing" };
  const latest = { selectedVariationNumber: 11, status: "complete" };

  lock.lock();
  lock.requestRender(first);
  lock.requestRender(second);
  lock.requestRender(latest);

  assert.equal(lock.isLocked(), true);
  assert.deepEqual(applied, []);

  lock.release();

  assert.equal(lock.isLocked(), false);
  assert.deepEqual(applied, [latest]);

  lock.release();
  assert.deepEqual(applied, [latest], "release must flush a deferred view once");
});

test("a stale deferred selector view cannot overwrite a newer rendered view", () => {
  const { applied, lock } = createHarness();
  const stale = { selectedVariationNumber: 20 };
  const deferredLatest = { selectedVariationNumber: 21 };
  const current = { selectedVariationNumber: 22 };

  lock.lock();
  lock.requestRender(stale);
  lock.requestRender(deferredLatest);
  lock.release();
  lock.requestRender(current);
  lock.release();

  assert.deepEqual(applied, [deferredLatest, current]);
  assert.equal(applied.at(-1), current);
});

test("reset discards deferred selector work and leaves future rendering usable", () => {
  const { applied, lock } = createHarness();
  const discarded = { selectedVariationNumber: 30 };
  const afterRemount = { selectedVariationNumber: 31 };

  lock.lock();
  lock.requestRender(discarded);
  lock.reset();

  assert.equal(lock.isLocked(), false);
  assert.deepEqual(applied, []);

  lock.release();
  lock.requestRender(afterRemount);

  assert.deepEqual(applied, [afterRemount]);
});

test("side panel loads and wires the variation selector lock before lifecycle startup", () => {
  const taggerDirectory = path.join(__dirname, "..", "extension", "tagger");
  const html = fs.readFileSync(path.join(taggerDirectory, "sidepanel.html"), "utf8");
  const source = fs.readFileSync(path.join(taggerDirectory, "sidepanel.js"), "utf8");
  const lockScriptIndex = html.indexOf('src="variation-selector-lock.js"');
  const sidepanelScriptIndex = html.indexOf('src="sidepanel.js"');

  assert.ok(lockScriptIndex >= 0, "the selector lock script must be loaded");
  assert.ok(
    lockScriptIndex < sidepanelScriptIndex,
    "the selector lock must load before sidepanel.js",
  );
  assert.match(source, /TikTokLiveTrackerVariationSelectorLock/);
  assert.match(source, /createVariationSelectorLock\s*\(\s*\{/);
});

test("side panel freezes only native selector mutations while the rest of the view updates", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "tagger", "sidepanel.js"),
    "utf8",
  );
  const optionsStart = source.indexOf(
    "function renderVariationSelectorOptions(view)",
  );
  const navigationStart = source.indexOf(
    "function renderVariationNavigation(view)",
  );
  const inventoryStart = source.indexOf("function renderInventory(view");
  const optionRenderer = source.slice(optionsStart, navigationStart);
  const navigationRenderer = source.slice(navigationStart, inventoryStart);

  assert.ok(optionsStart >= 0);
  assert.ok(navigationStart > optionsStart);
  assert.ok(inventoryStart > navigationStart);
  assert.match(optionRenderer, /variationSelector\.replaceChildren\(fragment\)/);
  assert.match(optionRenderer, /variationSelector\.disabled = variations\.length === 0/);
  assert.match(
    optionRenderer,
    /variationSelector\.value = String\(view\.selectedVariationNumber\)/,
  );
  assert.match(
    navigationRenderer,
    /variationSelectorLock\.requestRender\(view\)/,
  );
  assert.doesNotMatch(navigationRenderer, /replaceChildren/);
  assert.match(navigationRenderer, /variationContext\.textContent/);
  assert.match(navigationRenderer, /inventoryTitle\.textContent/);
  assert.match(navigationRenderer, /returnToCurrentButton\.hidden/);
});

test("pointer and keyboard selector paths preserve refresh data and release safely", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "tagger", "sidepanel.js"),
    "utf8",
  );
  const busyStart = source.indexOf("function setWorkspaceBusy(busy)");
  const refreshPredicateStart = source.indexOf(
    "function snapshotIsBackgroundRefresh(snapshot)",
  );
  const releaseStart = source.indexOf("function releaseVariationSelector()");
  const unavailableStart = source.indexOf(
    "function isSavedWorkspaceUnavailable()",
  );
  const savedStart = source.indexOf("function renderSavedSnapshot(snapshot)");
  const mutationStart = source.indexOf("function runSavedMutation(");
  const busyRenderer = source.slice(busyStart, refreshPredicateStart);
  const releaseHandler = source.slice(releaseStart, unavailableStart);
  const savedRenderer = source.slice(savedStart, mutationStart);
  const changeHandler = source.match(
    /variationSelector\.addEventListener\("change", \(\) => \{[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(busyStart >= 0);
  assert.ok(refreshPredicateStart > busyStart);
  assert.ok(releaseStart > refreshPredicateStart);
  assert.ok(unavailableStart > releaseStart);
  assert.ok(savedStart >= 0);
  assert.ok(mutationStart > savedStart);
  assert.ok(changeHandler);
  assert.match(
    source,
    /variationSelector\.addEventListener\("pointerdown", \(event\) => \{[\s\S]*?event\.button === 0[\s\S]*?variationSelectorLock\.lock\(\)/,
  );
  assert.match(
    source,
    /variationSelector\.addEventListener\("keydown", \(event\) => \{[\s\S]*?event\.key === " "[\s\S]*?event\.key === "Enter"[\s\S]*?event\.key === "ArrowDown"[\s\S]*?event\.key === "ArrowUp"[\s\S]*?variationSelectorLock\.lock\(\)[\s\S]*?event\.key === "Escape"[\s\S]*?releaseVariationSelector\(\)/,
  );
  assert.match(
    source,
    /variationSelector\.addEventListener\("blur", \(\) => \{\s*releaseVariationSelector\(\)/,
  );
  assert.match(changeHandler, /const selectedValue = variationSelector\.value/);
  assert.match(changeHandler, /Number\(selectedValue\)/);
  assert.match(changeHandler, /finally \{\s*releaseVariationSelector\(\)/);
  assert.ok(
    changeHandler.indexOf("const selectedValue") <
      changeHandler.indexOf("releaseVariationSelector()"),
    "the chosen variation must be captured before deferred DOM work flushes",
  );

  assert.match(busyRenderer, /variationSelectorLock\.isLocked\(\)/);
  assert.match(busyRenderer, /snapshotIsBackgroundRefresh\(savedSnapshot\)/);
  assert.match(busyRenderer, /shouldBeBusy && !keepVariationSelectorInteractive/);
  assert.match(
    busyRenderer,
    /trackerWorkspace\.setAttribute\("aria-busy", String\(shouldBeBusy\)\)/,
    "background refresh remains represented even when inert is suppressed",
  );
  assert.match(
    busyRenderer,
    /trackerWorkspace\.toggleAttribute\("inert", shouldBeInert\)/,
  );
  assert.ok(
    releaseHandler.indexOf("variationSelectorLock.release()") <
      releaseHandler.indexOf("setWorkspaceBusy"),
    "latest deferred options must flush before current busy state is restored",
  );

  assert.ok(
    savedRenderer.indexOf("savedSnapshot = snapshot") <
      savedRenderer.indexOf("renderAll(focusOptions)"),
    "captured snapshots must be retained even while selector rendering is deferred",
  );
  assert.match(
    source,
    /function unmountPersistentController\(\) \{[\s\S]*?variationSelectorLock\.reset\(\)/,
  );
});
