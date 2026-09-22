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
const BASELINE_ID = "synthetic-baseline";
const clone = (value) => JSON.parse(JSON.stringify(value));

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
    queuedNextItemSnapshot: null, selectedQueuedVariationNumber: null,
    variationPresetsBusy: false, variationPresetsReady: true,
    variationPresetsGeneration: 0, variationPresetsReadGeneration: 0,
    variationPresetsEntryContext: null, variationPresetsEditing: false,
    capturePlanningCycleGeneration: 0, variationNavigationGeneration: 0, captureStateNotificationGeneration: 0,
    pendingSavedAction: null, activeStreamInventoryUpdateBusy: false,
    isCapturePlanningTarget: () => false,
    scheduleVariationPresetsRefresh() { refreshes.push("presets"); },
    scheduleCaptureRefresh() { refreshes.push("capture"); },
    updateVariationPresetsAvailability() {},
    updateVariationSearchAvailability() {},
    setWorkspaceBusy() {},
    isCapturePlanningLocked: () => context.isCaptureInteractionLocked(),
    capturePlanningOverride: null,
    queuedItemSlot: element(), queuedItemBadge: element(), queuedItemLabel: element(),
    queuedItemTooltip: element(), clearQueuedItemButton: element(),
    queuedNextItemSku: "SYNTHETIC-A",
    queuedNextItemToken: "11111111-1111-4111-8111-111111111111",
    nextItemQueueRefreshGeneration: 0, nextItemQueueMutationGeneration: 0, nextItemQueueMutationBusy: false,
    streamSnapshot: { activeSession: { streamId: STREAM_ID }, resumed: true, busy: false },
    savedSnapshot: { phase: "ready", busy: false, operation: "refresh", view,
      state: { inventoryBaseline: { baselineId: BASELINE_ID } } },
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
    renderAll() { context.renderQueuedItemBadge(context.getActiveView()); context.renderInventory(context.getActiveView()); },
    getFocusedInventorySku: () => null,
    scheduleNextItemQueueRefresh() { refreshes.push("refresh"); },
    console: { error() {} },
  };
  context.captureHealthBadge.dataset.phase = "active";
  context.searchInput.value = "Other item";
  vm.createContext(context);
  vm.runInContext([
    "getActiveView", "getRecordedVariations", "isCaptureInteractionLocked", "guardCaptureInteraction",
    "getQueuedItemPresentation", "formatQueuedItemBadge", "renderQueuedItemBadge", "canClearQueuedItem",
    "updateQueuedItemBadgeAvailability", "clearQueuedItem",
    "canUseVariationPresetData", "canChangeVariationPresets", "snapshotIsBackgroundRefresh", "mutateVariationPresets",
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

function presetFixture({ assignments = [{ variationNumber: 11, sku: "SYNTHETIC-A" }], total = 20 } = {}) {
  const f = fixture();
  const c = f.context;
  Object.assign(f.view, {
    streamId: STREAM_ID, inventoryBaselineId: BASELINE_ID, variationNumber: 10, currentVariationNumber: 10,
    selectedVariationNumber: 10, activeBiddingVariationNumber: 10,
    isReviewingHistory: false, isReviewingPreset: false,
    variations: [{ variationNumber: 10, recorded: true, current: true, selected: true, sku: "SYNTHETIC-B" }],
    auction: { variationNumber: 10, sku: "SYNTHETIC-B", paymentStatus: "bidding" },
  });
  c.variationPresetsSnapshot = { streamId: STREAM_ID, baselineId: BASELINE_ID, revision: "revision-1", total, assignments: clone(assignments) };
  c.queuedNextItemSku = null;
  c.queuedNextItemToken = null;
  f.presetRequests = [];
  c.variationPresetsClient = {
    async setPresetItem(command) {
      f.presetRequests.push(clone(command));
      const snapshot = clone(c.variationPresetsSnapshot);
      snapshot.revision = "revision-2";
      snapshot.assignments = snapshot.assignments.filter(entry => entry.variationNumber !== command.variationNumber);
      return snapshot;
    },
  };
  c.renderQueuedItemBadge(c.getActiveView());
  return f;
}

function prestreamFixture({ selected = 1, assignments = [{ variationNumber: 2, sku: "SYNTHETIC-A" }], total = 20 } = {}) {
  const f = presetFixture({ assignments, total });
  Object.assign(f.view, {
    currentVariationNumber: 203, selectedVariationNumber: 203, variationNumber: 203,
    activeBiddingVariationNumber: null, variations: [], auction: null,
  });
  f.context.selectedPresetVariationNumber = selected;
  f.context.renderQueuedItemBadge(f.context.getActiveView());
  return f;
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
    streamId: STREAM_ID, baselineId: BASELINE_ID, armedAfterVariationNumber: 501,
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
  replies[1].resolve({ queuedSku: "SYNTHETIC-B", queueToken: "22222222-2222-4222-8222-222222222222", streamId: STREAM_ID, baselineId: BASELINE_ID, armedAfterVariationNumber: 501 });
  await settle();
  replies[0].resolve({ queuedSku: "SYNTHETIC-A", queueToken: "11111111-1111-4111-8111-111111111111", streamId: STREAM_ID, baselineId: BASELINE_ID, armedAfterVariationNumber: 501 });
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
    return { queuedSku: "SYNTHETIC-A", queueToken: "22222222-2222-4222-8222-222222222222", streamId: STREAM_ID, baselineId: BASELINE_ID, armedAfterVariationNumber: 501 };
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
  oldRead.resolve({ queuedSku: "SYNTHETIC-A", queueToken: "11111111-1111-4111-8111-111111111111", streamId: STREAM_ID, baselineId: BASELINE_ID, armedAfterVariationNumber: 501 });
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
  assert.deepEqual(f.refreshes, ["refresh", "presets"]);
  f.context.handleCaptureStateChanged(message, { id: "wrong-extension" });
  f.context.handleCaptureStateChanged(message, { id: "synthetic-extension", tab: {} });
  assert.deepEqual(f.refreshes, ["refresh", "presets"]);
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

test("upcoming preset header shows the exact next SKU and size despite inventory filtering without creating a manual queue", () => {
  const f = presetFixture({ assignments: [{ variationNumber: 11, sku: "SYNTHETIC-A" }, { variationNumber: 14, sku: "SYNTHETIC-B" }] });
  const c = f.context;
  const before = JSON.stringify({ view: f.view, presets: c.variationPresetsSnapshot });
  for (const query of ["no matching items", "Other item", "", "L"]) {
    c.searchInput.value = query;
    c.renderQueuedItemBadge(c.getActiveView());
    assert.equal(c.queuedItemSlot.hidden, false);
    assert.equal(c.queuedItemLabel.textContent, "LA hoodie-M");
    assert.equal(c.clearQueuedItemButton.disabled, false);
    assert.match(c.queuedItemTooltip.textContent, /LA hoodie, size M/);
    assert.match(c.queuedItemTooltip.textContent, /preset|variation #?11/i);
    assert.match(c.clearQueuedItemButton.getAttribute("aria-label"), /clear.*preset.*11/i);
  }
  assert.equal(c.queuedNextItemSku, null);
  assert.equal(c.queuedNextItemToken, null);
  assert.equal(JSON.stringify({ view: f.view, presets: c.variationPresetsSnapshot }), before);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.presetRequests, []);
});

test("an empty immediate-next preset does not show a later assigned item", () => {
  const f = presetFixture({ assignments: [{ variationNumber: 12, sku: "SYNTHETIC-A" }] });
  assert.equal(f.context.queuedItemSlot.hidden, true);
  assert.equal(f.context.clearQueuedItemButton.disabled, true);
  f.context.queuedNextItemSku = "SYNTHETIC-B";
  f.context.queuedNextItemToken = "manual-token";
  f.context.renderQueuedItemBadge(f.context.getActiveView());
  assert.equal(f.context.queuedItemLabel.textContent, "Other item tee-L", "Normal manual queue still renders");
});

test("preset indicators advance only with actual bidding, disappear outside live view, and restore on return or reopening", () => {
  const f = presetFixture({ assignments: [{ variationNumber: 11, sku: "SYNTHETIC-A" }, { variationNumber: 12, sku: "SYNTHETIC-B" }] });
  const c = f.context;
  const render = () => c.renderQueuedItemBadge(c.getActiveView());
  c.selectedPresetVariationNumber = 15;
  render();
  assert.equal(c.queuedItemSlot.hidden, true, "Future browsing hides upcoming preset styling");
  c.selectedPresetVariationNumber = null;
  f.view.isReviewingHistory = true;
  render();
  assert.equal(c.queuedItemSlot.hidden, true, "Historical view never exposes the preset clear action");
  f.view.isReviewingHistory = false;
  f.view.activeBiddingVariationNumber = null;
  render();
  assert.equal(c.queuedItemSlot.hidden, true, "Finished/unresolved current item is not active bidding");
  f.view.activeBiddingVariationNumber = 10;
  render();
  assert.equal(c.queuedItemLabel.textContent, "LA hoodie-M");
  Object.assign(f.view, { currentVariationNumber: 11, selectedVariationNumber: 11, variationNumber: 11, activeBiddingVariationNumber: 11 });
  f.view.variations.push({ variationNumber: 11, recorded: true, selected: true });
  f.view.auction.variationNumber = 11;
  c.variationPresetsSnapshot.assignments = [{ variationNumber: 12, sku: "SYNTHETIC-B" }];
  render();
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  c.streamSnapshot.resumed = false;
  render();
  assert.equal(c.queuedItemSlot.hidden, true);
  c.streamSnapshot.resumed = true;
  render();
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  f.view.variations = [];
  f.view.activeBiddingVariationNumber = null;
  render();
  assert.equal(c.queuedItemSlot.hidden, true, "Offline planning before first capture has no queued-preset badge");
});

test("manual queue stays visible and uses token-checked clear while browsing future and historical views", async () => {
  for (const future of [false, true]) {
    const f = presetFixture();
    const c = f.context;
    c.queuedNextItemSku = "SYNTHETIC-B";
    c.queuedNextItemToken = "manual-token";
    if (future) c.selectedPresetVariationNumber = 15;
    else f.view.isReviewingHistory = true;
    c.renderQueuedItemBadge(c.getActiveView());
    assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
    await f.clear();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].expectedQueueToken, "manual-token");
    assert.equal(f.presetRequests.length, 0);
    assert.equal(c.variationPresetsSnapshot.assignments[0].sku, "SYNTHETIC-A");
  }
});

test("preset X clears only the precise upcoming assignment using the worker preset command and preserves its placeholder", async () => {
  const f = presetFixture({ assignments: [{ variationNumber: 11, sku: "SYNTHETIC-A" }, { variationNumber: 15, sku: "SYNTHETIC-B" }] });
  const c = f.context;
  const originalView = JSON.stringify(f.view);
  await f.clear();
  assert.deepEqual(f.presetRequests, [{ expectedStreamId: STREAM_ID, expectedBaselineId: BASELINE_ID,
    expectedRevision: "revision-1", variationNumber: 11, sku: null, expectedActiveBiddingVariationNumber: 10 }]);
  assert.deepEqual(f.requests, [], "Never route a preset clear through manual clearQueue");
  assert.equal(c.variationPresetsSnapshot.total, 20);
  assert.deepEqual(clone(c.variationPresetsSnapshot.assignments), [{ variationNumber: 15, sku: "SYNTHETIC-B" }]);
  assert.equal(c.getActiveView().variations.find(entry => entry.variationNumber === 11).preset, true);
  assert.equal(c.getActiveView().variations.find(entry => entry.variationNumber === 11).sku, null);
  assert.equal(c.variationPresetsView.nextHasAssignment(c.getActiveView(), c.variationPresetsSnapshot), false);
  assert.equal(c.queuedItemSlot.hidden, true);
  assert.equal(JSON.stringify(f.view), originalView, "No change to current/history mapping, inventory, or accounting");
  assert.ok(f.refreshes.includes("presets"));
  assert.ok(f.refreshes.includes("refresh"));
});

test("preset clear keeps X visible but disabled for every startup, save, error, session and inert safeguard", async () => {
  const guards = [
    c => { c.captureHealthBadge.dataset.phase = "connecting"; },
    c => { c.captureHealthBadge.dataset.phase = "loading"; },
    c => { c.savedSnapshot.busy = true; },
    c => { c.savedSnapshot.phase = "error"; },
    c => { c.streamSnapshot.phase = "error"; },
    c => { c.streamSnapshot.busy = true; },
    c => { c.variationPresetsBusy = true; },
    c => { c.variationPresetsReady = false; },
    c => { c.nextItemQueueMutationBusy = true; },
    c => { c.pendingSavedAction = {}; },
    c => { c.activeStreamInventoryUpdateBusy = true; },
    c => { c.endConfirmationOpen = true; },
    c => { c.trackerWorkspace.setAttribute("inert", ""); },
  ];
  for (const apply of guards) {
    const f = presetFixture();
    apply(f.context);
    f.context.updateQueuedItemBadgeAvailability();
    assert.equal(f.context.clearQueuedItemButton.disabled, true, String(apply));
    assert.equal(f.context.queuedItemSlot.hidden, false, String(apply));
    await f.clear();
    assert.deepEqual(f.presetRequests, [], String(apply));
    assert.deepEqual(f.requests, [], String(apply));
  }
});

test("stale rendered preset X cannot clear a changed assignment, reset range, newly upcoming item or changed baseline/session", async () => {
  const changes = [
    c => { c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, revision: "replacement", assignments: [{ variationNumber: 11, sku: "SYNTHETIC-B" }] }; },
    c => { c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, revision: "same-sku-replacement" }; },
    c => { c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, revision: "reset", total: null, assignments: [] }; },
    c => { c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, baselineId: "new-baseline" }; },
    c => { c.mountedStreamId = "other-stream"; c.streamSnapshot.activeSession.streamId = "other-stream"; },
    c => { c.savedSnapshot.view.activeBiddingVariationNumber = 11; c.savedSnapshot.view.currentVariationNumber = 11; },
    c => { c.savedSnapshot.view.variations.push({ variationNumber: 11, recorded: true }); },
    c => { c.selectedPresetVariationNumber = 15; },
  ];
  for (const apply of changes) {
    const f = presetFixture();
    apply(f.context);
    await f.clear();
    assert.deepEqual(f.presetRequests, [], String(apply));
    assert.deepEqual(f.requests, [], String(apply));
  }
});

test("pending preset clears suppress rapid clicks and never optimistically remove the assignment", async () => {
  const f = presetFixture();
  const reply = deferred();
  f.context.variationPresetsClient.setPresetItem = command => { f.presetRequests.push(clone(command)); return reply.promise; };
  const pending = f.clear();
  assert.equal(f.presetRequests.length, 1);
  assert.equal(f.context.variationPresetsBusy, true);
  assert.equal(f.context.clearQueuedItemButton.disabled, true);
  assert.equal(f.context.variationPresetsSnapshot.assignments[0].sku, "SYNTHETIC-A");
  await f.clear();
  assert.equal(f.presetRequests.length, 1);
  reply.resolve({ ...clone(f.context.variationPresetsSnapshot), revision: "cleared", assignments: [] });
  await pending;
  assert.equal(f.context.variationPresetsBusy, false);
  assert.equal(f.context.queuedItemSlot.hidden, true);
});

test("failed preset clears retain the authoritative assignment, announce failure, and request fresh preset/capture state", async () => {
  const f = presetFixture();
  f.context.variationPresetsClient.setPresetItem = async command => {
    f.presetRequests.push(clone(command));
    throw new Error("Synthetic preset persistence failure");
  };
  await f.clear();
  assert.equal(f.presetRequests.length, 1);
  assert.equal(f.context.queuedItemLabel.textContent, "LA hoodie-M");
  assert.equal(f.context.queuedItemSlot.hidden, false);
  assert.equal(f.context.variationPresetsSnapshot.assignments[0].sku, "SYNTHETIC-A");
  assert.match(f.context.mappingAnnouncement.textContent, /Synthetic preset persistence failure/);
  assert.ok(f.refreshes.includes("presets"));
  assert.ok(f.refreshes.includes("capture"));
  assert.deepEqual(f.requests, []);
});

test("delayed preset-clear acknowledgements cannot replace newer assignments/reset/session state or navigate the user", async () => {
  for (const transition of ["assignment", "reset", "session", "navigation", "capture"]) {
    const f = presetFixture();
    const c = f.context;
    const reply = deferred();
    const original = clone(c.variationPresetsSnapshot);
    c.variationPresetsClient.setPresetItem = () => reply.promise;
    const pending = f.clear();
    if (transition === "assignment") {
      c.variationPresetsSnapshot = { ...original, revision: "newer", assignments: [{ variationNumber: 11, sku: "SYNTHETIC-B" }] };
      c.variationPresetsReadGeneration++;
    } else if (transition === "reset") {
      c.variationPresetsSnapshot = { ...original, revision: "reset", total: null, assignments: [] };
      c.variationPresetsReadGeneration++;
    } else if (transition === "session") {
      c.mountedStreamId = "new-stream";
      c.streamSnapshot.activeSession.streamId = "new-stream";
      c.variationPresetsSnapshot = { ...original, streamId: "new-stream", revision: "new-session" };
      c.variationPresetsGeneration++;
    } else if (transition === "capture") {
      Object.assign(f.view, { currentVariationNumber: 11, selectedVariationNumber: 11, activeBiddingVariationNumber: 11 });
      f.view.variations.push({ variationNumber: 11, recorded: true, sku: "SYNTHETIC-A" });
      c.variationPresetsSnapshot = { ...original, revision: "promoted", assignments: [{ variationNumber: 12, sku: "SYNTHETIC-B" }] };
      c.variationPresetsReadGeneration++;
    } else {
      c.selectedPresetVariationNumber = 15;
      c.variationNavigationGeneration++;
    }
    const current = clone(c.variationPresetsSnapshot);
    reply.resolve({ ...original, revision: "old-acknowledgement", assignments: [] });
    await pending;
    if (transition !== "navigation") assert.deepEqual(clone(c.variationPresetsSnapshot), current, transition);
    else assert.equal(c.selectedPresetVariationNumber, 15, "An in-flight clear never forces live navigation");
    assert.deepEqual(f.requests, [], transition);
    assert.equal(c.queuedNextItemSku, null, transition);
  }
});

test("a baseline-only change while preset clearing is pending cannot be replaced by its old acknowledgement", async () => {
  for (const canonicalViewChanged of [false, true]) {
    const f = presetFixture();
    const c = f.context;
    const original = clone(c.variationPresetsSnapshot);
    const reply = deferred();
    c.variationPresetsClient.setPresetItem = () => reply.promise;
    const pending = f.clear();
    c.variationPresetsSnapshot = { ...original, baselineId: "new-baseline" };
    if (canonicalViewChanged) f.view.inventoryBaselineId = "new-baseline";
    const authoritative = clone(c.variationPresetsSnapshot);
    // No stream, revision or generation change: baseline identity alone must
    // invalidate this response even when transport revisions happen to match.
    reply.resolve({ ...original, revision: "old-clear-result", assignments: [] });
    await pending;
    assert.deepEqual(clone(c.variationPresetsSnapshot), authoritative);
    assert.equal(c.variationPresetsSnapshot.assignments[0].sku, "SYNTHETIC-A");
    assert.ok(f.refreshes.includes("presets"));
    assert.deepEqual(f.requests, []);
    assert.equal(c.queuedNextItemSku, null);
  }
});

test("an old saved view and matching preset snapshot cannot show a queued preset after mounting a new stream", async () => {
  const f = presetFixture();
  const c = f.context;
  c.mountedStreamId = "new-stream";
  c.streamSnapshot.activeSession.streamId = "new-stream";
  assert.equal(f.view.streamId, STREAM_ID);
  assert.equal(c.variationPresetsSnapshot.streamId, STREAM_ID);
  c.renderQueuedItemBadge(c.getActiveView());
  assert.equal(c.getQueuedItemPresentation(c.getActiveView()), null);
  assert.equal(c.queuedItemSlot.hidden, true);
  assert.equal(c.clearQueuedItemButton.disabled, true);
  await f.clear();
  assert.deepEqual(f.presetRequests, []);
  assert.deepEqual(f.requests, []);
});

test("multi-size preset rendering marks only the exact queued size while retaining the current selected size", () => {
  const f = presetFixture({ assignments: [{ variationNumber: 11, sku: "TEE-L" }] });
  const c = f.context;
  const makeNode = () => {
    const node = element();
    node.children = [];
    node.append = (...children) => node.children.push(...children);
    node.replaceChildren = fragment => { node.children = fragment.children; };
    Object.defineProperty(node, "childElementCount", { get: () => node.children.length });
    return node;
  };
  c.document.createElement = makeNode;
  c.document.createDocumentFragment = makeNode;
  c.inventorySizeListbox = makeNode();
  c.getCurrentVariationMappedSku = () => "TEE-S";
  c.isCurrentVariationMapped = () => true;
  c.viewModel = { getStockDisplay: () => ({ state: "in_stock", label: "10 left", ariaLabel: "10 units remaining" }) };
  const entries = ["S", "M", "L"].map(size => ({ sku: `TEE-${size}`, size, item: "Tee", style: "", selected: size === "S", selectionAllowed: true }));
  f.view.inventory = entries;
  vm.runInContext(["createInventorySizeBadge", "getInventorySizeOptionActionDescription", "renderInventorySizeOptions"].map(declaration).join("\n"), c);
  const original = JSON.stringify(f.view);
  c.renderInventorySizeOptions({ entries }, c.getActiveView(), "ordinary");
  const allBadges = node => [node, ...node.children.flatMap(allBadges)].filter(item => item.className === "inventory-size-option-badge");
  for (const option of c.inventorySizeListbox.children) {
    const queued = allBadges(option).filter(badge => badge.textContent === "Queued");
    assert.equal(queued.length, option.dataset.sku === "TEE-L" ? 1 : 0);
    if (option.dataset.sku === "TEE-L") assert.match(option.getAttribute("aria-label"), /preset.*11|11.*preset/i);
    assert.equal(option.getAttribute("aria-selected"), String(option.dataset.sku === "TEE-S"));
  }
  assert.equal(JSON.stringify(f.view), original);
  assert.equal(c.queuedNextItemSku, null);
});

test("preset snapshot notifications update upcoming badges and a failed refresh keeps text but disables clearing", async () => {
  const f = presetFixture();
  const c = f.context;
  c.restoreResumedPresetSelection = () => false;
  c.captureConnectingPlanning = null;
  c.pendingPresetResumeSelection = null;
  let response = { ...clone(c.variationPresetsSnapshot), revision: "replacement", assignments: [{ variationNumber: 11, sku: "SYNTHETIC-B" }] };
  c.variationPresetsClient.getPresets = async () => response;
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), c);
  c.scheduleVariationPresetsRefresh();
  await settle();
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  assert.equal(c.clearQueuedItemButton.disabled, false);
  c.variationPresetsClient.getPresets = async () => { throw new Error("Synthetic snapshot failure"); };
  c.scheduleVariationPresetsRefresh();
  await settle();
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  assert.equal(c.clearQueuedItemButton.disabled, true);
  await f.clear();
  assert.deepEqual(f.presetRequests, []);
  c.variationPresetsClient.getPresets = async () => response;
  c.scheduleVariationPresetsRefresh();
  await settle();
  assert.equal(c.clearQueuedItemButton.disabled, false);
  response = { ...response, revision: "reset", total: null, assignments: [] };
  c.scheduleVariationPresetsRefresh();
  await settle();
  assert.equal(c.queuedItemSlot.hidden, true);
});

test("out-of-order or wrong-stream preset refreshes cannot resurrect an outdated queued-preset display", async () => {
  const f = presetFixture();
  const c = f.context;
  c.restoreResumedPresetSelection = () => false;
  c.captureConnectingPlanning = null;
  c.pendingPresetResumeSelection = null;
  const oldSnapshot = clone(c.variationPresetsSnapshot);
  const replies = [deferred(), deferred(), deferred()];
  let index = 0;
  c.variationPresetsClient.getPresets = () => replies[index++].promise;
  vm.runInContext(declaration("scheduleVariationPresetsRefresh"), c);
  c.scheduleVariationPresetsRefresh();
  await settle();
  c.scheduleVariationPresetsRefresh();
  await settle();
  replies[1].resolve({ ...oldSnapshot, revision: "replacement", assignments: [{ variationNumber: 11, sku: "SYNTHETIC-B" }] });
  await settle();
  replies[0].resolve(oldSnapshot);
  await settle();
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  assert.equal(c.clearQueuedItemButton.dataset.revision, "replacement");
  c.scheduleVariationPresetsRefresh();
  await settle();
  replies[2].resolve({ ...oldSnapshot, streamId: "wrong-stream" });
  await settle();
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  assert.equal(c.clearQueuedItemButton.disabled, true);
  assert.equal(c.variationPresetsSnapshot.revision, "replacement");
  assert.equal(c.queuedNextItemSku, null);
});

test("pre-stream planned-next badge uses the selected preset plus one and stays visible through search without reserving stock", () => {
  const f = prestreamFixture({ assignments: [{ variationNumber: 1, sku: "SYNTHETIC-B" }, { variationNumber: 2, sku: "SYNTHETIC-A" }, { variationNumber: 4, sku: "SYNTHETIC-B" }] });
  const c = f.context;
  const before = JSON.stringify({ view: f.view, presets: c.variationPresetsSnapshot });
  for (const query of ["no results", "Other item", "L", ""]) {
    c.searchInput.value = query;
    c.renderQueuedItemBadge(c.getActiveView());
    assert.equal(c.queuedItemSlot.hidden, false);
    assert.equal(c.queuedItemLabel.textContent, "LA hoodie-M");
    assert.match(c.queuedItemTooltip.textContent, /Pre-stream preset for variation #2\. No inventory is reserved\./);
    assert.match(c.clearQueuedItemButton.getAttribute("aria-label"), /clear.*preset.*2/i);
    assert.equal(c.clearQueuedItemButton.disabled, false);
    assert.equal(c.clearQueuedItemButton.dataset.prestreamVariationNumber, "1");
    assert.equal(c.clearQueuedItemButton.dataset.activeBiddingVariationNumber, "");
  }
  assert.equal(JSON.stringify({ view: f.view, presets: c.variationPresetsSnapshot }), before);
  assert.equal(c.queuedNextItemSku, null);
  assert.equal(c.queuedNextItemToken, null);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.presetRequests, []);
});

test("pre-stream next indicators follow navigation and sequential-selection changes without skipping an empty next slot", () => {
  const f = prestreamFixture({ assignments: [{ variationNumber: 2, sku: "SYNTHETIC-A" }, { variationNumber: 3, sku: "SYNTHETIC-B" }, { variationNumber: 5, sku: "SYNTHETIC-A" }] });
  const c = f.context;
  assert.equal(c.queuedItemLabel.textContent, "LA hoodie-M");
  c.selectedPresetVariationNumber = 2;
  c.variationNavigationGeneration++;
  c.renderQueuedItemBadge(c.getActiveView());
  assert.equal(c.queuedItemLabel.textContent, "Other item tee-L");
  c.selectedPresetVariationNumber = 3;
  c.variationNavigationGeneration++;
  c.renderQueuedItemBadge(c.getActiveView());
  assert.equal(c.queuedItemSlot.hidden, true, "Assigned #5 must not skip empty #4");
  c.selectedPresetVariationNumber = null;
  c.renderQueuedItemBadge(c.getActiveView());
  assert.equal(c.queuedItemSlot.hidden, true, "Waiting placeholder is not a selected pre-stream preset");
  c.selectedPresetVariationNumber = 20;
  c.renderQueuedItemBadge(c.getActiveView());
  assert.equal(c.queuedItemSlot.hidden, true, "The final preset never wraps");
  c.selectedPresetVariationNumber = 1;
  c.renderQueuedItemBadge(c.getActiveView());
  assert.equal(c.queuedItemLabel.textContent, "LA hoodie-M");
  assert.deepEqual(f.presetRequests, []);
});

test("pre-stream X sends a precise source-and-target preset clear and preserves all placeholders, other plans and manual queue", async () => {
  const f = prestreamFixture({ assignments: [{ variationNumber: 1, sku: "SYNTHETIC-A" }, { variationNumber: 2, sku: "SYNTHETIC-A" }, { variationNumber: 3, sku: "SYNTHETIC-B" }] });
  const c = f.context;
  const before = JSON.stringify(f.view);
  c.queuedNextItemSku = "SYNTHETIC-B";
  c.queuedNextItemToken = "unchanged-manual-token";
  c.renderQueuedItemBadge(c.getActiveView());
  await f.clear();
  assert.deepEqual(f.presetRequests, [{ expectedStreamId: STREAM_ID, expectedBaselineId: BASELINE_ID,
    expectedRevision: "revision-1", variationNumber: 2, sku: null, expectedPrestreamVariationNumber: 1 }]);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(clone(c.variationPresetsSnapshot.assignments), [{ variationNumber: 1, sku: "SYNTHETIC-A" }, { variationNumber: 3, sku: "SYNTHETIC-B" }]);
  assert.equal(c.variationPresetsSnapshot.total, 20);
  assert.equal(c.getActiveView().variations.find(entry => entry.variationNumber === 2).preset, true);
  assert.equal(c.getActiveView().variations.find(entry => entry.variationNumber === 2).sku, null);
  assert.equal(c.selectedPresetVariationNumber, 1);
  assert.equal(c.queuedNextItemSku, "SYNTHETIC-B");
  assert.equal(c.queuedNextItemToken, "unchanged-manual-token");
  assert.equal(JSON.stringify(f.view), before);
  assert.equal(c.clearQueuedItemButton.dataset.source, "manual", "Only original manual-queue display can remain after preset removal");
});

test("pre-stream preset X remains visible but locked during blue, yellow, local saving/errors and existing interaction safeguards", async () => {
  const guards = [
    c => { c.captureHealthBadge.dataset.phase = "connecting"; c.capturePlanningOverride = {}; c.isCapturePlanningLocked = () => false; },
    c => { c.captureHealthBadge.dataset.phase = "loading"; c.isCapturePlanningLocked = () => false; },
    c => { c.savedSnapshot.phase = "saving"; c.savedSnapshot.busy = true; },
    c => { c.savedSnapshot.phase = "error"; },
    c => { c.streamSnapshot.phase = "error"; },
    c => { c.streamSnapshot.busy = true; },
    c => { c.variationPresetsBusy = true; },
    c => { c.variationPresetsReady = false; },
    c => { c.nextItemQueueMutationBusy = true; },
    c => { c.pendingSavedAction = {}; },
    c => { c.activeStreamInventoryUpdateBusy = true; },
    c => { c.endConfirmationOpen = true; },
    c => { c.trackerWorkspace.setAttribute("inert", ""); },
  ];
  for (const apply of guards) {
    const f = prestreamFixture();
    apply(f.context);
    f.context.updateQueuedItemBadgeAvailability();
    assert.equal(f.context.queuedItemSlot.hidden, false, String(apply));
    assert.equal(f.context.clearQueuedItemButton.disabled, true, String(apply));
    await f.clear();
    assert.deepEqual(f.presetRequests, [], String(apply));
    assert.deepEqual(f.requests, [], String(apply));
  }
});

test("stale pre-stream X rejects navigation-away-and-back, source edits, capture start, reset and identity changes before submission", async () => {
  for (const apply of [
    c => { c.selectedPresetVariationNumber = 2; c.variationNavigationGeneration++; },
    c => { c.variationNavigationGeneration += 2; },
    c => { c.variationPresetsSnapshot.revision = "replacement"; },
    c => { c.variationPresetsSnapshot.assignments[0].sku = "SYNTHETIC-B"; },
    c => { c.variationPresetsSnapshot = { ...c.variationPresetsSnapshot, total: null, assignments: [], revision: "reset" }; },
    c => { c.savedSnapshot.view.variations.push({ variationNumber: 8, recorded: true }); },
    c => { c.savedSnapshot.view.activeBiddingVariationNumber = 8; },
    c => { c.variationPresetsSnapshot.baselineId = "different-baseline"; },
    c => { c.mountedStreamId = "new-stream"; c.streamSnapshot.activeSession.streamId = "new-stream"; },
  ]) {
    const f = prestreamFixture();
    apply(f.context);
    await f.clear();
    assert.deepEqual(f.presetRequests, [], String(apply));
    assert.deepEqual(f.requests, [], String(apply));
  }
});

test("pre-stream clear failure and duplicate clicks retain the saved upcoming plan without retries or navigation", async () => {
  const f = prestreamFixture();
  const c = f.context;
  const reply = deferred();
  c.variationPresetsClient.setPresetItem = command => { f.presetRequests.push(clone(command)); return reply.promise; };
  const pending = f.clear();
  assert.equal(c.clearQueuedItemButton.disabled, true);
  assert.equal(c.queuedItemSlot.hidden, false);
  assert.equal(c.variationPresetsSnapshot.assignments[0].sku, "SYNTHETIC-A");
  await f.clear();
  assert.equal(f.presetRequests.length, 1);
  reply.reject(new Error("Synthetic pre-stream persistence failure"));
  await pending;
  assert.equal(c.variationPresetsSnapshot.assignments[0].sku, "SYNTHETIC-A");
  assert.equal(c.queuedItemLabel.textContent, "LA hoodie-M");
  assert.equal(c.selectedPresetVariationNumber, 1);
  assert.match(c.mappingAnnouncement.textContent, /Synthetic pre-stream persistence failure/);
  assert.ok(f.refreshes.includes("presets"));
  assert.ok(f.refreshes.includes("capture"));
  assert.deepEqual(f.requests, []);
});

test("pre-stream clear replies never resurrect a replacement configuration or navigate after capture/navigation/session changes", async () => {
  for (const transition of ["navigation", "capture", "capture-notification", "reset", "session", "baseline", "assignment"]) {
    const f = prestreamFixture();
    const c = f.context;
    const original = clone(c.variationPresetsSnapshot);
    const reply = deferred();
    c.variationPresetsClient.setPresetItem = () => reply.promise;
    const pending = f.clear();
    if (transition === "navigation") {
      c.selectedPresetVariationNumber = 5;
      c.variationNavigationGeneration++;
    } else if (transition === "capture") {
      f.view.variations.push({ variationNumber: 8, recorded: true, sku: "SYNTHETIC-B" });
      f.view.activeBiddingVariationNumber = 8;
      c.variationPresetsSnapshot = { ...original, revision: "captured" };
      c.variationPresetsReadGeneration++;
    } else if (transition === "capture-notification") {
      c.captureStateNotificationGeneration++;
    } else if (transition === "reset") {
      c.variationPresetsSnapshot = { ...original, revision: "reset", total: null, assignments: [] };
      c.variationPresetsReadGeneration++;
    } else if (transition === "session") {
      c.mountedStreamId = "new-stream";
      c.streamSnapshot.activeSession.streamId = "new-stream";
      c.variationPresetsSnapshot = { ...original, streamId: "new-stream" };
      c.variationPresetsGeneration++;
    } else if (transition === "baseline") {
      c.variationPresetsSnapshot = { ...original, baselineId: "new-baseline" };
      f.view.inventoryBaselineId = "new-baseline";
    } else {
      c.variationPresetsSnapshot = { ...original, revision: "replacement", assignments: [{ variationNumber: 2, sku: "SYNTHETIC-B" }] };
      c.variationPresetsReadGeneration++;
    }
    const latest = clone(c.variationPresetsSnapshot);
    reply.resolve({ ...original, revision: "old-success", assignments: [] });
    await pending;
    if (transition !== "navigation") assert.deepEqual(clone(c.variationPresetsSnapshot), latest, transition);
    else assert.equal(c.selectedPresetVariationNumber, 5, "Clearing must never move a newer browsing selection");
    assert.deepEqual(f.requests, [], transition);
    assert.equal(c.queuedNextItemSku, null, transition);
  }
});

test("pre-stream multi-size picker shows only the exact upcoming size as Queued and retains current preset selection", () => {
  const f = prestreamFixture({ assignments: [{ variationNumber: 1, sku: "TEE-S" }, { variationNumber: 2, sku: "TEE-L" }] });
  const c = f.context;
  const makeNode = () => {
    const node = element();
    node.children = [];
    node.append = (...children) => node.children.push(...children);
    node.replaceChildren = fragment => { node.children = fragment.children; };
    Object.defineProperty(node, "childElementCount", { get: () => node.children.length });
    return node;
  };
  c.document.createElement = makeNode;
  c.document.createDocumentFragment = makeNode;
  c.inventorySizeListbox = makeNode();
  c.getCurrentVariationMappedSku = () => null;
  c.isCurrentVariationMapped = () => false;
  c.viewModel = { getStockDisplay: () => ({ state: "in_stock", label: "10 left", ariaLabel: "10 units remaining" }) };
  f.view.inventory = ["S", "M", "L"].map(size => ({ sku: `TEE-${size}`, size, item: "Tee", style: "", selected: false, selectionAllowed: true }));
  vm.runInContext(["createInventorySizeBadge", "getInventorySizeOptionActionDescription", "renderInventorySizeOptions"].map(declaration).join("\n"), c);
  const original = JSON.stringify(f.view);
  const view = c.getActiveView();
  c.renderInventorySizeOptions({ entries: view.inventory }, view, "preset_current");
  const allBadges = node => [node, ...node.children.flatMap(allBadges)].filter(item => item.className === "inventory-size-option-badge");
  for (const option of c.inventorySizeListbox.children) {
    assert.equal(allBadges(option).filter(badge => badge.textContent === "Queued").length, option.dataset.sku === "TEE-L" ? 1 : 0);
    assert.equal(option.getAttribute("aria-selected"), String(option.dataset.sku === "TEE-S"));
    if (option.dataset.sku === "TEE-L") assert.match(option.getAttribute("aria-label"), /queued by preset for variation #2/i);
    assert.match(option.getAttribute("aria-label"), /no inventory is reserved/i);
  }
  assert.equal(JSON.stringify(f.view), original);
  assert.equal(c.queuedNextItemSku, null);
});
