const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const reconciliation = require("../extension/shared/reconciliation.js");
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const controllerModule = require("../extension/tagger/persistent-tagger-controller.js");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "tagger", "sidepanel.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

function declaration(name) {
  const start = new RegExp(`^  function ${name}\\(`, "m").exec(source)?.index;
  assert.notEqual(start, undefined, `Missing ${name}`);
  const end = source.indexOf("\n  }", start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}

function view(overrides = {}) {
  return {
    streamId: "synthetic-end-warning",
    inventory: [], variations: [], activeBiddingVariationNumber: null,
    totals: { pendingMappedCount: 0, paymentFixingCount: 0, unmappedCompletedCount: 0, conflictCount: 0 },
    ...overrides,
  };
}

function unresolved(variationNumber, extra = {}) {
  return { variationNumber, recorded: true, status: "pending", ...extra };
}

function readiness(snapshotView) {
  const context = { savedSnapshot: { view: snapshotView } };
  vm.runInNewContext(declaration("describeReportReadiness"), context);
  return context.describeReportReadiness();
}

test("End readiness retains unknown-data and zero-issues messages without an empty variation list", () => {
  assert.equal(readiness(null), "The saved stream will be checked when the report is created.");
  assert.equal(readiness(view()), "No captured issues currently require attention.");
});

test("one unresolved captured order lists its variation beside the count", () => {
  assert.equal(readiness(view({ variations: [unresolved(98)] })),
    "Report attention items: unresolved order — Count 1: SKU #98.");
});

test("unresolved variation numbers are numeric-sorted, unique, and counted from that same set", () => {
  const snapshotView = view({ variations: [
    unresolved(98), unresolved(5), unresolved(32), unresolved(5),
    unresolved(0), unresolved(-1), unresolved("33"), unresolved(Number.NaN),
  ] });
  const before = clone(snapshotView);
  assert.equal(readiness(snapshotView),
    "Report attention items: unresolved orders — Count 3: SKU #5, 32, 98.");
  assert.deepEqual(clone(snapshotView), before, "Formatting must not reorder or change the saved view");
});

test("all thirteen unresolved numbers remain inline without truncation", () => {
  const numbers = [194, 3, 156, 44, 5, 29, 159, 30, 149, 32, 93, 55, 98];
  assert.equal(readiness(view({ variations: numbers.map((number) => unresolved(number)) })),
    "Report attention items: unresolved orders — Count 13: SKU #3, 5, 29, 30, 32, 44, 55, 93, 98, 149, 156, 159, 194.");
});

test("finalized orders, uncaptured presets, and manual queue previews are excluded", () => {
  const variations = [
    unresolved(5),
    unresolved(1, { status: "committed" }),
    unresolved(2, { status: "unmapped_completed" }),
    unresolved(3, { status: "canceled" }),
    unresolved(20, { recorded: false, preset: true, sku: "SYNTHETIC-M" }),
    unresolved(21, { recorded: false, queuedPreview: true, sku: "SYNTHETIC-M" }),
    unresolved(22, { recorded: false }),
  ];
  assert.equal(readiness(view({ variations })),
    "Report attention items: unresolved order — Count 1: SKU #5.");
  assert.equal(readiness(view({ variations: variations.slice(1) })),
    "No captured issues currently require attention.");
});

test("adding unresolved numbers preserves every other existing End warning", () => {
  assert.equal(readiness(view({
    variations: [unresolved(32)], activeBiddingVariationNumber: 32,
    inventory: [{ oversoldQuantity: 2 }, { oversoldQuantity: 0 }],
    totals: { pendingMappedCount: 2, paymentFixingCount: 1, unmappedCompletedCount: 3, conflictCount: 1 },
  })), "Report attention items: 1 active bidding SKU, unresolved order — Count 1: SKU #32, 2 pending mapped orders, 1 payment-error order, 3 completed sales without inventory, 1 data conflict, 1 SKU requiring a recount.");
});

function renderContext() {
  const noOp = () => {};
  const context = {
    savedSnapshot: null, previousSavedPhase: null,
    lastRenderedSavedVariations: new Map(), mountedStreamId: "synthetic-end-warning",
    queuedNextItemSnapshot: null, endConfirmationOpen: true,
    streamSnapshot: { resumed: true, busy: false, activeSession: { streamId: "synthetic-end-warning" } },
    endStreamButton: {}, confirmEndStreamButton: {}, endReportReadiness: {},
    savedSessionError: {}, hasFocusedSavedError: false,
    captureRefreshFocusSku: null, captureRefreshHadVariationFocus: false,
    focusSavedWorkspaceAfterRetry: false, pendingSavedAction: null,
    captureRefreshDirty: false, mappingAnnouncement: {},
    document: { activeElement: { name: "Keep stream active" } },
    pendingMapping: { contains: () => false },
    reconcileQueuedPreviewSelection: () => false,
    preserveCapturedPresetSelection: () => false,
    updateSessionControls: noOp, setTrackerWorkspaceVisible: noOp,
    setWorkspaceBusy: noOp, getSavedStatusText: () => "Saved", setFooterStatus: noOp,
    getFocusedInventorySku: () => null, restoreResumedPresetSelection: noOp,
    scheduleVariationPresetsRefresh: noOp, describeLiveRefresh: () => "",
    restoreTrackerEntryViewport: noOp,
    createSavedVariationSignatures: (nextView) => new Map(nextView.variations.map((entry) => [entry.variationNumber, entry.status])),
  };
  context.renderAll = () => context.savedSnapshot.view;
  vm.runInNewContext([
    declaration("describeReportReadiness"), declaration("renderSavedSnapshot"),
  ].join("\n"), context);
  return context;
}

test("authoritative controller refresh updates the open End warning as captured orders resolve", async () => {
  const streamId = "synthetic-end-warning";
  const state = reconciliation.createReconciliationState([
    { sku: "SYNTHETIC-M", item: "Synthetic tee", style: "", size: "M", quantityOnHandAtImport: 10, unitCostCents: 500 },
  ]);
  reconciliation.pinStreamToInventoryBaseline(state, { streamId });
  reconciliation.observeVariations(state, { streamId, variationNumbers: [98, 32, 5] });
  reconciliation.mapVariation(state, { streamId, variationNumber: 32, sku: "SYNTHETIC-M" });
  const client = {
    async getState() { return { state: clone(state), result: null }; },
    async initializeState() { assert.fail("End warning must not initialize inventory"); },
    async mapVariation() { assert.fail("End warning must not map inventory"); },
    async unmapVariation() { assert.fail("End warning must not unmap inventory"); },
  };
  const controller = controllerModule.createPersistentTaggerController({
    client, reconciliation, mappingWorkflow, streamId,
    currentVariationNumber: 98, variationNumbers: [5, 32, 98],
  });
  const context = renderContext();
  const originalFocus = context.document.activeElement;
  await controller.start();
  const unsubscribe = controller.subscribe(context.renderSavedSnapshot);
  assert.match(context.endReportReadiness.textContent, /Count 3: SKU #5, 32, 98/);
  assert.match(context.endReportReadiness.textContent, /1 pending mapped order/);

  reconciliation.observePaymentStatuses(state, { streamId, statuses: [{ variationNumber: 32, observedPaymentStatus: "canceled" }] });
  await controller.refresh();
  assert.equal(context.endReportReadiness.textContent,
    "Report attention items: unresolved orders — Count 2: SKU #5, 98.");
  reconciliation.recordPaymentComplete(state, { streamId, variationNumber: 5, soldPriceCents: 1000 });
  await controller.refresh();
  assert.equal(context.endReportReadiness.textContent,
    "Report attention items: unresolved order — Count 1: SKU #98, 1 completed sale without inventory.");
  reconciliation.observePaymentStatuses(state, { streamId, statuses: [{ variationNumber: 98, observedPaymentStatus: "canceled" }] });
  reconciliation.mapVariation(state, { streamId, variationNumber: 5, sku: "SYNTHETIC-M" });
  await controller.refresh();
  assert.equal(context.endReportReadiness.textContent, "No captured issues currently require attention.");
  assert.equal(context.endConfirmationOpen, true);
  assert.equal(context.document.activeElement, originalFocus, "Capture updates do not move End confirmation focus");
  assert.equal(context.confirmEndStreamButton.disabled, false, "Readiness text does not change End eligibility");
  unsubscribe();
});
