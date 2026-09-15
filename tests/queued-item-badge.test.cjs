const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const tagger = path.join(__dirname, "..", "extension", "tagger");
const source = fs.readFileSync(path.join(tagger, "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.join(tagger, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(tagger, "sidepanel.css"), "utf8");
const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";

function declaration(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, `Missing implementation function: ${name}`);
  const end = source.indexOf("\n  }", start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}

function element() {
  const attributes = new Map();
  const events = new Map();
  return {
    hidden: false, disabled: false, textContent: "", title: "", dataset: {}, value: "",
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    toggleAttribute(name, value) {
      if (value) attributes.set(name, ""); else attributes.delete(name);
    },
    addEventListener(name, listener) {
      const listeners = events.get(name) ?? [];
      listeners.push(listener);
      events.set(name, listeners);
    },
    dispatch(name, extra = {}) {
      const event = {
        type: name, target: this, prevented: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...extra,
      };
      for (const listener of events.get(name) ?? []) listener(event);
      return event;
    },
    contains(other) { return other === this; },
    focus() { this.focused = true; },
    blur() { this.blurred = true; },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const requests = [];
  const renders = [];
  const refreshes = [];
  const inventory = [
    { sku: "SYNTHETIC-A", item: " LA ", style: " hoodie ", size: "M", selected: false },
    { sku: "SYNTHETIC-B", item: "Other item", style: "tee", size: "L", selected: true },
  ];
  const view = {
    inventory, currentVariationNumber: 501, selectedVariationNumber: 212,
    isReviewingHistory: true,
    auction: { sku: "SYNTHETIC-B", paymentStatus: "payment_complete" },
  };
  const context = {
    variationPresetsView: require("../extension/tagger/variation-presets-view.js"),
    variationPresetsProtocol: require("../extension/shared/variation-presets-protocol.js"),
    variationPresetsSnapshot: null, selectedPresetVariationNumber: null,
    variationPresetsBusy: false,
    isCapturePlanningTarget: () => false,
    scheduleVariationPresetsRefresh() {},
    updateVariationPresetsAvailability() {},
    queuedItemSlot: element(), queuedItemBadge: element(), queuedItemLabel: element(),
    queuedItemTooltip: element(), clearQueuedItemButton: element(),
    queuedNextItemSku: "SYNTHETIC-A",
    queuedNextItemToken: "11111111-1111-4111-8111-111111111111",
    nextItemQueueRefreshGeneration: 0, nextItemQueueMutationGeneration: 0, nextItemQueueMutationBusy: false,
    streamSnapshot: { activeSession: { streamId: STREAM_ID }, resumed: true, busy: false },
    savedSnapshot: { phase: "ready", busy: false, operation: "refresh", view },
    persistentController: {}, mountedStreamId: STREAM_ID, archivedReportsViewOpen: false,
    trackerWorkspace: element(), captureHealthBadge: element(), mappingAnnouncement: element(),
    searchInput: element(), endConfirmationOpen: false,
    document: { activeElement: null },
    nextItemQueueClient: {
      async clearQueue(command) {
        requests.push(command);
        return { status: "cleared", queuedSku: null };
      },
      toggleQueue() { assert.fail("The badge X must never toggle or map a queue item"); },
      mapCurrent() { assert.fail("The badge X must never map the current variation"); },
    },
    renderInventory(current, focus) { renders.push({ current, focus }); },
    getFocusedInventorySku: () => null,
    scheduleNextItemQueueRefresh() { refreshes.push("refresh"); },
    console: { error() {} },
  };
  context.captureHealthBadge.dataset.phase = "active";
  context.searchInput.value = "Other item";
  vm.createContext(context);
  vm.runInContext([
    "getActiveView", "isCaptureInteractionLocked", "guardCaptureInteraction",
    "formatQueuedItemBadge", "renderQueuedItemBadge", "canClearQueuedItem",
    "updateQueuedItemBadgeAvailability", "clearQueuedItem",
  ].map(declaration).join("\n"), context);
  context.renderQueuedItemBadge(view);
  return {
    context, view, inventory, requests, renders, refreshes,
    clear() {
      return context.clearQueuedItem({
        type: "click", target: context.clearQueuedItemButton,
        preventDefault() {}, stopImmediatePropagation() {},
      });
    },
  };
}

test("queued badge is inside the existing inventory heading between its label and Sheet action", () => {
  const start = html.indexOf('<div class="section-heading inventory-heading">');
  const end = html.indexOf('<form', start);
  const heading = html.slice(start, end);
  assert.ok(start > 0 && end > start);
  for (const id of ["queued-item-slot", "queued-item-badge", "queued-item-label", "queued-item-tooltip", "clear-queued-item"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, id);
    assert.ok(heading.includes(`id="${id}"`), `${id} belongs to the existing heading`);
  }
  assert.ok(heading.indexOf('id="result-count"') < heading.indexOf('id="queued-item-slot"'));
  assert.ok(heading.indexOf('id="queued-item-slot"') < heading.indexOf('id="add-active-stream-skus"'));
  assert.match(heading, /<button[^>]*id="clear-queued-item"[^>]*type="button"/);
  assert.match(heading, /id="queued-item-tooltip"[^>]*role="tooltip"/);
  assert.match(heading, /id="clear-queued-item"[^>]*aria-describedby="queued-item-tooltip"/);
  assert.doesNotMatch(heading, /<input|<select|<form/);
  assert.match(source, /clearQueuedItemButton\.addEventListener\("click", clearQueuedItem\)/);
  assert.doesNotMatch(source, /(?:queuedItemBadge|queuedItemSlot|queuedItemLabel)\.addEventListener\("(?:click|keydown)"/,
    "Only the native X button performs an action, including its normal keyboard activation");
  assert.doesNotMatch(fs.readFileSync(path.join(tagger, "..", "report", "report.html"), "utf8"), /queued-item/);
});

test("queued badge uses the existing red queue palette and a non-layout tooltip in the compact header gap", () => {
  assert.match(css, /\.queued-item-slot\s*\{[^}]*flex:\s*1 1 32px;[^}]*min-width:\s*32px;[^}]*justify-content:\s*center;/);
  assert.match(css, /\.queued-item-badge\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*height:\s*20px;[^}]*background:\s*#ff737e;[^}]*color:\s*#21070a;/);
  assert.match(css, /\.inventory-card-badge\[data-tone="queued"\]\s*\{[^}]*color:\s*#21070a;[^}]*background:\s*#ff737e;/);
  assert.match(css, /\.queued-item-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
  assert.match(css, /\.queued-item-tooltip\s*\{[^}]*position:\s*absolute;[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(css, /\.clear-queued-item:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.section-heading\.inventory-heading\s*\{[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*6px 12px;[^}]*margin-bottom:\s*8px;/);
});

test("queued item label trims item/style and includes only a meaningful size", () => {
  const { context } = fixture();
  const cases = [
    [{ item: " LA ", style: " hoodie ", size: " M " }, "LA hoodie-M", "LA hoodie, size M"],
    [{ item: "  LA  team ", style: " long   sleeve ", size: "XL" }, "LA team long sleeve-XL", "LA team long sleeve, size XL"],
    [{ item: "Cap", style: "", size: "OS" }, "Cap", "Cap"],
    [{ item: "Cap", style: " baseball ", size: " oS " }, "Cap baseball", "Cap baseball"],
    [{ item: "Sticker", style: "Pack", size: "N/A" }, "Sticker Pack", "Sticker Pack"],
    [{ item: "Sticker", style: "Pack", size: " n/a " }, "Sticker Pack", "Sticker Pack"],
    [{ item: "Bag", style: "", size: "" }, "Bag", "Bag"],
    [{ item: "Tee", style: "", size: "OSFA" }, "Tee-OSFA", "Tee, size OSFA"],
    [{ item: "Tee", style: "", size: "N/A-L" }, "Tee-N/A-L", "Tee, size N/A-L"],
  ];
  for (const [entry, expected, description] of cases) {
    const formatted = context.formatQueuedItemBadge(entry);
    assert.equal(formatted.label, expected);
    assert.equal(formatted.description, description);
  }
});

test("queued badge uses the authoritative queued SKU across search filters and historical selections", () => {
  const f = fixture();
  const before = JSON.stringify(f.view);
  assert.equal(f.context.queuedItemSlot.hidden, false);
  assert.equal(f.context.queuedItemLabel.textContent, "LA hoodie-M");
  assert.equal(f.context.clearQueuedItemButton.disabled, false);
  for (const query of ["Other item", "no results", "", "SYNTHETIC-B"]) {
    f.context.searchInput.value = query;
    f.context.renderQueuedItemBadge(f.view);
    assert.equal(f.context.queuedItemLabel.textContent, "LA hoodie-M");
  }
  assert.equal(JSON.stringify(f.view), before, "Rendering cannot change mappings, inventory, or the selected variation");
  assert.equal(f.requests.length, 0);
});

test("long labels keep full accessible tooltip text without using inventory HTML", () => {
  const f = fixture();
  f.inventory[0].item = "A very long item name <script>synthetic</script>";
  f.inventory[0].style = "A very long synthetic style";
  f.context.renderQueuedItemBadge(f.view);
  const full = `${f.inventory[0].item} ${f.inventory[0].style}-M`;
  const description = `${f.inventory[0].item} ${f.inventory[0].style}, size M`;
  assert.equal(f.context.queuedItemLabel.textContent, full);
  assert.equal(f.context.queuedItemTooltip.textContent, description);
  assert.equal(f.context.queuedItemBadge.title, description);
  assert.ok(f.context.clearQueuedItemButton.getAttribute("aria-label").includes(description));
  assert.doesNotMatch(declaration("renderQueuedItemBadge"), /innerHTML/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /queued-item[^{}]*:hover/);
  assert.match(css, /queued-item[^{}]*:focus-within/);
});

test("a stale button token, SKU or stream cannot clear a newly rendered queue generation", async () => {
  for (const field of ["sku", "queueToken", "streamId"]) {
    const f = fixture();
    f.context.clearQueuedItemButton.dataset[field] = "stale";
    f.context.updateQueuedItemBadgeAvailability();
    assert.equal(f.context.clearQueuedItemButton.disabled, true);
    await f.clear();
    assert.deepEqual(f.requests, []);
    assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
  }
});

test("queued badge is absent with no queue or outside the active resumed tracker", () => {
  for (const change of [
    (c) => { c.queuedNextItemSku = null; c.queuedNextItemToken = null; },
    (c) => { c.streamSnapshot.activeSession = null; },
    (c) => { c.streamSnapshot.resumed = false; },
    (c) => { c.trackerWorkspace.hidden = true; },
    (c) => { c.archivedReportsViewOpen = true; },
  ]) {
    const f = fixture();
    change(f.context);
    f.context.renderQueuedItemBadge(f.view);
    assert.equal(f.context.queuedItemSlot.hidden, true);
    assert.equal(f.context.clearQueuedItemButton.disabled, true);
  }
});

test("capture loading disables clear without removing the queued label or draft inventory search", async () => {
  const f = fixture();
  for (const phase of ["connecting", "loading", "connecting", "loading"]) {
    f.context.captureHealthBadge.dataset.phase = phase;
    f.context.updateQueuedItemBadgeAvailability();
    assert.equal(f.context.clearQueuedItemButton.disabled, true);
    await f.clear();
    assert.equal(f.context.queuedItemLabel.textContent, "LA hoodie-M");
    assert.equal(f.context.queuedItemSlot.hidden, false);
    assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
    assert.equal(f.context.searchInput.value, "Other item");
  }
  assert.deepEqual(f.requests, []);
});

test("green/blank do not remove queue, session, saved-error, busy, or End-confirmation safeguards", async () => {
  const safeguards = [
    (c) => { c.nextItemQueueMutationBusy = true; },
    (c) => { c.streamSnapshot.busy = true; },
    (c) => { c.savedSnapshot.phase = "saving"; c.savedSnapshot.busy = true; },
    (c) => { c.savedSnapshot.phase = "loading"; c.savedSnapshot.busy = true; },
    (c) => { c.savedSnapshot.phase = "error"; },
    (c) => { c.endConfirmationOpen = true; },
    (c) => { c.trackerWorkspace.setAttribute("inert", ""); },
    (c) => { c.persistentController = null; },
    (c) => { c.queuedNextItemToken = null; },
  ];
  for (const phase of ["active", "blank"]) {
    for (const change of safeguards) {
      const f = fixture();
      f.context.captureHealthBadge.dataset.phase = phase;
      change(f.context);
      f.context.updateQueuedItemBadgeAvailability();
      assert.equal(f.context.clearQueuedItemButton.disabled, true);
      await f.clear();
      assert.deepEqual(f.requests, []);
      assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
    }
  }
});

test("the badge X sends an explicit token-checked clear without changing current mapping or historical selection", async () => {
  for (const phase of ["active", "blank"]) {
    const f = fixture();
    const before = JSON.stringify(f.view);
    f.context.captureHealthBadge.dataset.phase = phase;
    await f.clear();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0])), {
      expectedStreamId: STREAM_ID,
      expectedQueueToken: "11111111-1111-4111-8111-111111111111",
      sku: "SYNTHETIC-A",
    });
    assert.equal(f.context.queuedNextItemSku, null);
    assert.equal(f.context.queuedNextItemToken, null);
    assert.equal(f.context.queuedItemSlot.hidden, true);
    assert.equal(f.context.nextItemQueueMutationBusy, false);
    assert.equal(JSON.stringify(f.view), before);
    assert.ok(f.refreshes.length > 0);
    assert.doesNotMatch(declaration("clearQueuedItem"), /toggleQueue|mapCurrent|mapVariation|unmapVariation/);
  }
});

test("duplicate clear actions stay disabled until the first request settles, while capture loading can begin", async () => {
  const f = fixture();
  const reply = deferred();
  f.context.nextItemQueueClient.clearQueue = (command) => { f.requests.push(command); return reply.promise; };
  const pending = f.clear();
  assert.equal(f.requests.length, 1);
  assert.equal(f.context.nextItemQueueMutationBusy, true);
  assert.equal(f.context.clearQueuedItemButton.disabled, true);
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A", "No optimistic queue removal");
  await f.clear();
  assert.equal(f.requests.length, 1);
  f.context.captureHealthBadge.dataset.phase = "loading";
  reply.resolve({ status: "cleared", queuedSku: null });
  await pending;
  assert.equal(f.context.queuedNextItemSku, null, "An already-started clear may finish normally");
  assert.equal(f.context.nextItemQueueMutationBusy, false);
  assert.equal(f.context.isCaptureInteractionLocked(), true);
});

test("failed clears retain the visible queue, announce failure and refresh without toggling or automatic clear retries", async () => {
  const f = fixture();
  f.context.nextItemQueueClient.clearQueue = async (command) => {
    f.requests.push(command);
    throw new Error("Synthetic clear failure");
  };
  await f.clear();
  assert.equal(f.requests.length, 1);
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
  assert.equal(f.context.queuedItemSlot.hidden, false);
  assert.equal(f.context.queuedItemLabel.textContent, "LA hoodie-M");
  assert.equal(f.context.queuedNextItemToken, null, "A failed request must refresh its authoritative token");
  assert.equal(f.context.clearQueuedItemButton.disabled, true);
  assert.equal(f.context.nextItemQueueMutationBusy, false);
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic clear failure/);
  assert.ok(f.refreshes.length > 0);
});

test("late clear success cannot erase a newer queued SKU or same-SKU generation", async () => {
  for (const nextSku of ["SYNTHETIC-A", "SYNTHETIC-B"]) {
    const f = fixture();
    const reply = deferred();
    f.context.nextItemQueueClient.clearQueue = () => reply.promise;
    const pending = f.clear();
    f.context.queuedNextItemSku = nextSku;
    f.context.queuedNextItemToken = "22222222-2222-4222-8222-222222222222";
    f.context.nextItemQueueRefreshGeneration++;
    f.context.renderQueuedItemBadge(f.view);
    reply.resolve({ status: "cleared", queuedSku: null });
    await pending;
    assert.equal(f.context.queuedNextItemSku, nextSku);
    assert.equal(f.context.queuedNextItemToken, "22222222-2222-4222-8222-222222222222");
    assert.equal(f.context.queuedItemSlot.hidden, false);
  }
});

test("late clear failure cannot invalidate the token received by a newer queue refresh", async () => {
  const f = fixture();
  const reply = deferred();
  f.context.nextItemQueueClient.clearQueue = () => reply.promise;
  const pending = f.clear();
  f.context.queuedNextItemSku = "SYNTHETIC-B";
  f.context.queuedNextItemToken = "22222222-2222-4222-8222-222222222222";
  f.context.nextItemQueueRefreshGeneration++;
  reply.reject(new Error("Late synthetic failure"));
  await pending;
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-B");
  assert.equal(f.context.queuedNextItemToken, "22222222-2222-4222-8222-222222222222");
});

test("a clear reply from a previous tracker mount cannot change a new stream or release its mutation guard", async () => {
  const f = fixture();
  const reply = deferred();
  f.context.nextItemQueueClient.clearQueue = () => reply.promise;
  const pending = f.clear();
  f.context.mountedStreamId = "local-stream:33333333-3333-4333-8333-333333333333";
  f.context.streamSnapshot.activeSession.streamId = f.context.mountedStreamId;
  f.context.nextItemQueueMutationGeneration++;
  f.context.queuedNextItemSku = "SYNTHETIC-B";
  f.context.queuedNextItemToken = "22222222-2222-4222-8222-222222222222";
  reply.resolve({ status: "cleared", queuedSku: null });
  await pending;
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-B");
  assert.equal(f.context.queuedNextItemToken, "22222222-2222-4222-8222-222222222222");
  assert.equal(f.context.nextItemQueueMutationBusy, true, "The new mount owns its own mutation state");
});

test("queue snapshot refresh updates the badge even while inventory-card rendering is deferred", async () => {
  const f = fixture();
  f.context.nextItemQueueClient.getQueueSnapshot = async () => ({
    queuedSku: "SYNTHETIC-B", queueToken: "22222222-2222-4222-8222-222222222222",
  });
  f.context.renderInventory = () => { f.context.inventoryDeferred = true; };
  vm.runInContext(declaration("scheduleNextItemQueueRefresh"), f.context);
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-B");
  assert.equal(f.context.queuedNextItemToken, "22222222-2222-4222-8222-222222222222");
  assert.equal(f.context.queuedItemLabel.textContent, "Other item tee-L");
  assert.equal(f.context.inventoryDeferred, true);
  assert.equal(f.view.selectedVariationNumber, 212);
});

test("out-of-order queue snapshots and wrong-stream replies cannot replace newer badge state", async () => {
  const f = fixture();
  const replies = [deferred(), deferred(), deferred()];
  let index = 0;
  f.context.nextItemQueueClient.getQueueSnapshot = () => replies[index++].promise;
  vm.runInContext(declaration("scheduleNextItemQueueRefresh"), f.context);
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  replies[1].resolve({ queuedSku: "SYNTHETIC-B", queueToken: "22222222-2222-4222-8222-222222222222" });
  await settle();
  replies[0].resolve({ queuedSku: "SYNTHETIC-A", queueToken: "11111111-1111-4111-8111-111111111111" });
  await settle();
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-B");
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  f.context.mountedStreamId = "local-stream:33333333-3333-4333-8333-333333333333";
  replies[2].resolve({ queuedSku: null, queueToken: null });
  await settle();
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-B");
  assert.equal(f.context.queuedItemLabel.textContent, "Other item tee-L");
});

test("a failed queue snapshot keeps the item visible but disables clear until a fresh token arrives", async () => {
  const f = fixture();
  let fail = true;
  f.context.nextItemQueueClient.getQueueSnapshot = async () => {
    if (fail) throw new Error("Synthetic snapshot failure");
    return { queuedSku: "SYNTHETIC-A", queueToken: "22222222-2222-4222-8222-222222222222" };
  };
  vm.runInContext(declaration("scheduleNextItemQueueRefresh"), f.context);
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  assert.equal(f.context.queuedNextItemSku, "SYNTHETIC-A");
  assert.equal(f.context.queuedItemSlot.hidden, false);
  assert.equal(f.context.queuedNextItemToken, null);
  assert.equal(f.context.clearQueuedItemButton.disabled, true);
  fail = false;
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  assert.equal(f.context.queuedItemLabel.textContent, "LA hoodie-M");
  assert.equal(f.context.clearQueuedItemButton.disabled, false);
});

test("an already-started queue read cannot resurrect an item after the user clears it", async () => {
  const f = fixture();
  const oldRead = deferred();
  let reads = 0;
  f.context.nextItemQueueClient.getQueueSnapshot = () => ++reads === 1
    ? oldRead.promise
    : Promise.resolve({ queuedSku: null, queueToken: null });
  vm.runInContext(declaration("scheduleNextItemQueueRefresh"), f.context);
  f.context.scheduleNextItemQueueRefresh();
  await settle();
  await f.clear();
  await settle();
  oldRead.resolve({ queuedSku: "SYNTHETIC-A", queueToken: "11111111-1111-4111-8111-111111111111" });
  await settle();
  assert.equal(f.context.queuedNextItemSku, null);
  assert.equal(f.context.queuedItemSlot.hidden, true);
});

test("validated existing queue notifications schedule a snapshot read without adding a polling loop", () => {
  const f = fixture();
  const protocol = require("../extension/shared/next-item-queue-protocol.js");
  Object.assign(f.context, {
    nextItemQueueProtocol: protocol, chrome: { runtime: { id: "synthetic-extension" } },
    isLiveBidChangedNotification: () => false, isCaptureStateChangedNotification: () => false,
  });
  vm.runInContext(declaration("handleCaptureStateChanged"), f.context);
  const message = protocol.createQueueChangedNotification();
  f.context.handleCaptureStateChanged(message, { id: "synthetic-extension" });
  assert.deepEqual(f.refreshes, ["refresh"]);
  f.context.handleCaptureStateChanged(message, { id: "wrong-extension" });
  f.context.handleCaptureStateChanged(message, { id: "synthetic-extension", tab: {} });
  assert.deepEqual(f.refreshes, ["refresh"]);
});

test("reset clears the queue token and badge while invalidating earlier requests", () => {
  const f = fixture();
  vm.runInContext(declaration("resetNextItemQueueDisplay"), f.context);
  f.context.resetNextItemQueueDisplay();
  assert.equal(f.context.queuedNextItemSku, null);
  assert.equal(f.context.queuedNextItemToken, null);
  assert.equal(f.context.queuedItemSlot.hidden, true);
  assert.equal(f.context.nextItemQueueRefreshGeneration, 1);
  assert.equal(f.context.nextItemQueueMutationGeneration, 1);
});

test("badge rendering and availability reuse the existing update flow without a polling timer", () => {
  const render = declaration("renderInventory");
  assert.match(render, /renderQueuedItemBadge\(view\)/);
  assert.ok(render.indexOf("renderQueuedItemBadge(view)") < render.indexOf("inventorySizeMenuState"));
  assert.match(declaration("syncCaptureInteractionLock"), /updateQueuedItemBadgeAvailability\(\)/);
  assert.match(declaration("handleCaptureStateChanged"), /isQueueChangedNotification[\s\S]*scheduleNextItemQueueRefresh\(\)/);
  const queueCode = ["formatQueuedItemBadge", "renderQueuedItemBadge", "clearQueuedItem", "scheduleNextItemQueueRefresh"].map(declaration).join("\n");
  assert.doesNotMatch(queueCode, /setInterval|setTimeout/);
});
