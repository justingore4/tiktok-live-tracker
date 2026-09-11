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

test("variation selector renders immediately while its custom menu is closed", () => {
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

test("side panel freezes only custom selector mutations while the rest of the view updates", () => {
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
  assert.match(optionRenderer, /variationListbox\.replaceChildren\(fragment\)/);
  assert.match(optionRenderer, /variationSelectorValue\.replaceChildren\(/);
  assert.match(
    optionRenderer,
    /variationSelector\.setAttribute\("aria-disabled", "true"\)/,
  );
  assert.match(
    optionRenderer,
    /variationSelector\.setAttribute\("aria-disabled", "false"\)/,
  );
  assert.match(
    optionRenderer,
    /variationSelector\.dataset\.variationNumber = String\(/,
  );
  assert.match(
    navigationRenderer,
    /variationSelectorLock\.requestRender\(view\)/,
  );
  assert.doesNotMatch(navigationRenderer, /replaceChildren|showPopover|hidePopover/);
  assert.match(navigationRenderer, /variationContext\.textContent/);
  assert.doesNotMatch(navigationRenderer, /inventoryTitle/,
    "Variation updates leave the static Inventory heading and its separate item count alone");
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
  const releaseStart = source.indexOf("function releaseVariationSelector(options = {})");
  const unavailableStart = source.indexOf(
    "function isSavedWorkspaceUnavailable()",
  );
  const openStart = source.indexOf("function openVariationSelector(options = {})");
  const liveAuctionStart = source.indexOf("function renderLiveAuction(view)");
  const selectStart = source.indexOf(
    "function selectVariationFromPicker(selectedVariationNumber)",
  );
  const commitStart = source.indexOf("function commitActiveVariation()");
  const activeStart = source.indexOf(
    "function setActiveVariation(variationNumber, options = {})",
  );
  const moveStart = source.indexOf("function moveActiveVariation(offset)");
  const keyboardStart = source.indexOf(
    "function handleVariationSelectorKeydown(event)",
  );
  const keyboardListenersStart = source.search(
    /variationSelector\.addEventListener\(\s*"keydown"/,
  );
  const savedStart = source.indexOf("function renderSavedSnapshot(snapshot)");
  const mutationStart = source.indexOf("function runSavedMutation(");
  const busyRenderer = source.slice(busyStart, refreshPredicateStart);
  const releaseHandler = source.slice(releaseStart, unavailableStart);
  const openHandler = source.slice(openStart, liveAuctionStart);
  const selectionHandler = source.slice(selectStart, commitStart);
  const activeHandler = source.slice(activeStart, moveStart);
  const savedRenderer = source.slice(savedStart, mutationStart);
  const keyboardHandler = source.slice(keyboardStart, keyboardListenersStart);
  const optionClickHandler = source.match(
    /variationListbox\.addEventListener\("click", \(event\) => \{[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(busyStart >= 0);
  assert.ok(refreshPredicateStart > busyStart);
  assert.ok(releaseStart > refreshPredicateStart);
  assert.ok(unavailableStart > releaseStart);
  assert.ok(openStart >= 0);
  assert.ok(liveAuctionStart > openStart);
  assert.ok(selectStart >= 0);
  assert.ok(commitStart > selectStart);
  assert.ok(activeStart >= 0);
  assert.ok(moveStart > activeStart);
  assert.ok(keyboardStart >= 0);
  assert.ok(keyboardListenersStart > keyboardStart);
  assert.ok(savedStart >= 0);
  assert.ok(mutationStart > savedStart);
  assert.ok(keyboardHandler);
  assert.ok(optionClickHandler);
  assert.match(
    openHandler,
    /variationSelectorLock\.lock\(\)[\s\S]+variationSelectorOpen = true[\s\S]+showVariationListbox\(\)/,
  );
  assert.match(
    keyboardHandler,
    /event\.key === " "[\s\S]+event\.key === "Enter"[\s\S]+event\.key === "ArrowDown"[\s\S]+event\.key === "ArrowUp"[\s\S]+event\.key === "Home"[\s\S]+event\.key === "End"[\s\S]+event\.key === "PageDown"[\s\S]+event\.key === "PageUp"/,
  );
  assert.match(
    keyboardHandler,
    /event\.key === "Escape"[\s\S]+event\.altKey[\s\S]+releaseVariationSelector\(\{ restoreFocus: true \}\)[\s\S]+commitActiveVariation\(\)[\s\S]+event\.key === "Tab"[\s\S]+releaseVariationSelector\(\)/,
  );
  assert.doesNotMatch(
    source,
    /variationSelector\.addEventListener\("blur"/,
  );
  assert.match(source, /variationListbox\.addEventListener\([\s\S]+"keydown"[\s\S]+handleVariationSelectorKeydown/);
  assert.match(activeHandler, /row\.dataset\.active = String\(active\)/);
  assert.match(activeHandler, /aria-activedescendant/);
  assert.doesNotMatch(activeHandler, /aria-selected/);
  assert.match(selectionHandler, /persistentController\.selectVariation\(/);
  assert.match(
    selectionHandler,
    /finally \{\s*releaseVariationSelector\(\{ restoreFocus: true \}\)/,
  );
  assert.match(optionClickHandler, /Number\(option\.dataset\.variationNumber\)/);
  assert.match(
    optionClickHandler,
    /selectVariationFromPicker\(selectedVariationNumber\)/,
  );
  assert.ok(
    optionClickHandler.indexOf("const selectedVariationNumber") <
      optionClickHandler.indexOf("selectVariationFromPicker"),
    "the chosen variation must be captured before deferred DOM work flushes",
  );

  assert.match(
    busyRenderer,
    /variationSelectorLock\.isLocked\(\) \|\| inventorySizeMenuState !== null/,
  );
  assert.match(busyRenderer, /snapshotIsBackgroundRefresh\(savedSnapshot\)/);
  assert.match(busyRenderer, /shouldBeBusy && !keepOpenPickerInteractive/);
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
    releaseHandler.indexOf("clearOpenVariationSelector()") <
      releaseHandler.indexOf("variationSelectorLock.release()") &&
      releaseHandler.indexOf("variationSelectorLock.release()") <
      releaseHandler.indexOf("setWorkspaceBusy"),
    "the popup must close before latest options flush and busy state restores",
  );

  assert.ok(
    savedRenderer.indexOf("savedSnapshot = snapshot") <
      savedRenderer.indexOf("renderAll(focusOptions)"),
    "captured snapshots must be retained even while selector rendering is deferred",
  );
  assert.match(
    source,
    /function unmountPersistentController\(\) \{[\s\S]*?resetVariationSelector\(\)/,
  );
  assert.match(
    source,
    /function resetVariationSelector\(\) \{[\s\S]*?clearOpenVariationSelector\(\)[\s\S]*?variationSelectorLock\.reset\(\)/,
  );
  assert.match(
    source,
    /document\.addEventListener\([\s\S]+"pointerdown"[\s\S]+!variationSelectShell\.contains\(event\.target\)[\s\S]+releaseVariationSelector\(\)/,
  );
  assert.match(
    source,
    /document\.addEventListener\("focusin", \(event\) => \{[\s\S]+!variationSelectShell\.contains\(event\.target\)[\s\S]+releaseVariationSelector\(\)/,
  );
  assert.match(
    source,
    /variationListbox\.addEventListener\("pointerup", \(event\) => \{[\s\S]+variationSelector\.focus\(\{ preventScroll: true \}\)/,
  );
});
