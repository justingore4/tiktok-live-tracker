const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  MOCK_INVENTORY,
  getStockDisplay,
} = require("../extension/tagger/inventory-view-model.js");
const {
  createMappingSession,
  getObservedPaymentStatusLabel,
} = require("../extension/tagger/mapping-workflow.js");

const STREAM_ID = "demo-stream";
const VARIATION_NUMBER = 203;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toEngineInventory(entries = MOCK_INVENTORY) {
  return entries.map((entry) => ({
    sku: entry.sku,
    name: entry.style ? `${entry.item} - ${entry.style}` : entry.item,
    size: entry.size,
    quantityReceived: entry.quantityReceived,
    unitCostCents: entry.unitCostCents,
  }));
}

function createSession(overrides = {}) {
  return createMappingSession({
    inventory: MOCK_INVENTORY,
    reconciliation,
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    offlineSimulation: true,
    ...overrides,
  });
}

function inventoryEntry(view, sku) {
  return view.inventory.find((entry) => entry.sku === sku);
}

test("uses friendly labels for every observed TikTok payment status", () => {
  assert.deepEqual(
    Object.values(reconciliation.OBSERVED_PAYMENT_STATUSES).map((status) => [
      status,
      getObservedPaymentStatusLabel(status),
    ]),
    [
      ["not_observed", "Payment not yet observed"],
      ["payment_processing", "Payment processing"],
      ["payment_fixing", "Payment fixing"],
      ["payment_failed", "Payment failed"],
      ["canceled", "Canceled"],
      ["payment_complete", "Payment complete"],
      ["unrecognized", "Unrecognized payment status"],
    ],
  );
  assert.equal(
    getObservedPaymentStatusLabel("future_payment_status"),
    "Payment status unavailable",
  );
  assert.equal(
    getObservedPaymentStatusLabel(undefined),
    "Payment status unavailable",
  );
});

test("keeps payment failed unreserved but makes canceled canonical without inventory effects", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 202,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
      {
        variationNumber: 201,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      },
    ],
  });
  const session = createSession({
    state,
    variationNumber: 202,
    variationNumbers: [202, 201],
  });

  const linked = session.selectSku("STUSSY-TEE-BLACK-L");
  const view = session.getViewState();
  const canceledOption = view.variations.find(
    (variation) => variation.variationNumber === 202,
  );
  const failedOption = view.variations.find(
    (variation) => variation.variationNumber === 201,
  );

  assert.equal(view.selectedVariationNumber, 202);
  assert.equal(linked.action, "canceled_order_mapped");
  assert.equal(view.auction.observedPaymentStatus, "canceled");
  assert.equal(view.auction.observedPaymentStatusLabel, "Canceled");
  assert.equal(view.auction.paymentStatus, "canceled");
  assert.equal(view.auction.status, "canceled");
  assert.equal(view.auction.statusLabel, "Canceled");
  assert.equal(view.auction.mappingStatus, "mapped");
  assert.equal(view.mapping.sku, "STUSSY-TEE-BLACK-L");
  assert.equal(canceledOption.observedPaymentStatusLabel, "Canceled");
  assert.equal(canceledOption.status, "canceled");
  assert.equal(canceledOption.statusLabel, "Canceled");
  assert.equal(failedOption.observedPaymentStatusLabel, "Payment failed");
  assert.equal(failedOption.status, "unmapped");
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: 201,
    }).paymentStatus,
    "unknown",
  );
  assert.equal(
    inventoryEntry(view, "STUSSY-TEE-BLACK-L").reservedQuantity,
    0,
  );
  assert.equal(
    inventoryEntry(view, "STUSSY-TEE-BLACK-L").remainingQuantity,
    5,
  );
  assert.equal(
    inventoryEntry(view, "STUSSY-TEE-BLACK-L").availableToTagQuantity,
    5,
  );
  assert.equal(view.totals.completedPaymentCount, 0);
  assert.equal(view.totals.committedSalesCount, 0);
  assert.equal(view.totals.profitCents, 0);
  assert.deepEqual(view.controls, {
    canCompletePayment: false,
    canSimulateBufferExpiry: false,
    canMarkUnpaid: false,
    canUndoSimulatedPayment: false,
    canUndoUnpaid: false,
  });

  session.selectVariation(201);
  const failedMapping = session.selectSku("NIKE-HOODIE-GREY-XL");
  const failedInventory = inventoryEntry(
    failedMapping.view,
    "NIKE-HOODIE-GREY-XL",
  );

  assert.equal(failedMapping.mapping.status, "mapped");
  assert.equal(failedMapping.mapping.statusLabel, "Item selected");
  assert.equal(failedInventory.reservedQuantity, 0);
  assert.equal(failedInventory.availableToTagQuantity, 3);
});

test("keeps not-observed and unrecognized selections out of pending inventory", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [203],
  });
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 202,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
      },
    ],
  });
  const session = createSession({
    state,
    variationNumbers: [203, 202],
  });

  session.selectSku("NIKE-HOODIE-GREY-L");
  session.selectVariation(202);
  session.selectSku("NIKE-HOODIE-GREY-L");
  const view = session.getViewState();
  const inventory = inventoryEntry(view, "NIKE-HOODIE-GREY-L");

  assert.deepEqual(
    view.variations.map(({ variationNumber, status, statusLabel }) => ({
      variationNumber,
      status,
      statusLabel,
    })),
    [
      { variationNumber: 203, status: "mapped", statusLabel: "Item selected" },
      { variationNumber: 202, status: "mapped", statusLabel: "Item selected" },
    ],
  );
  assert.equal(inventory.reservedQuantity, 0);
  assert.equal(inventory.availableToTagQuantity, 1);
});

test("relinks and unlinks a canceled order to sold-out history without changing stock", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: VARIATION_NUMBER,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const session = createSession({ state });
  const linked = session.selectSku("STUSSY-TEE-BLACK-L");
  const relinked = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const soldOutEntry = inventoryEntry(
    relinked.view,
    "DENIM-SHORTS-WASHED-BLUE-32",
  );

  assert.equal(linked.ok, true);
  assert.equal(linked.action, "canceled_order_mapped");
  assert.equal(relinked.ok, true);
  assert.equal(relinked.action, "canceled_mapping_corrected");
  assert.equal(relinked.mapping.status, "canceled");
  assert.equal(relinked.mapping.sku, "DENIM-SHORTS-WASHED-BLUE-32");
  assert.equal(relinked.mapping.committed, false);
  assert.equal(relinked.mapping.soldPriceCents, null);
  assert.equal(relinked.mapping.committedUnitCostCents, null);
  assert.equal(relinked.mapping.profitCents, null);
  assert.equal(soldOutEntry.selected, true);
  assert.equal(soldOutEntry.selectionAllowed, true);
  assert.equal(soldOutEntry.selectionReason, "selected");
  assert.equal(soldOutEntry.remainingQuantity, 0);
  assert.equal(soldOutEntry.reservedQuantity, 0);
  assert.equal(relinked.view.totals.committedSalesCount, 0);
  assert.equal(relinked.view.totals.profitCents, 0);

  const unlinked = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");

  assert.equal(unlinked.ok, true);
  assert.equal(unlinked.action, "unmapped");
  assert.equal(unlinked.previousStatus, "canceled");
  assert.equal(unlinked.mapping, null);
  assert.equal(unlinked.view.auction.status, "canceled");
  assert.equal(unlinked.view.auction.paymentStatus, "canceled");
  assert.equal(unlinked.view.auction.sku, null);
  assert.equal(
    inventoryEntry(unlinked.view, "DENIM-SHORTS-WASHED-BLUE-32")
      .selectionAllowed,
    true,
  );
  assert.equal(unlinked.view.totals.committedSalesCount, 0);
  assert.equal(unlinked.view.totals.profitCents, 0);
});

test("shows when a later TikTok completion overrides cancellation and counts inventory", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: VARIATION_NUMBER,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.CANCELED,
      },
    ],
  });
  const session = createSession({ state });
  session.selectSku("STUSSY-TEE-BLACK-L");

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });
  const view = session.getViewState();
  const selectedInventory = inventoryEntry(view, "STUSSY-TEE-BLACK-L");

  assert.equal(view.auction.status, "committed");
  assert.equal(view.auction.statusLabel, "Payment complete");
  assert.equal(view.auction.paymentStatus, "payment_complete");
  assert.equal(view.auction.observedPaymentStatus, "payment_complete");
  assert.equal(view.auction.soldPriceCents, 4800);
  assert.equal(view.auction.committedUnitCostCents, 1200);
  assert.equal(view.auction.profitCents, 3600);
  assert.deepEqual(view.auction.conflicts, [
    { code: "payment_completed_after_canceled" },
  ]);
  assert.ok(
    view.warnings.some(
      (warning) =>
        warning.code === "payment_completed_after_canceled" &&
        warning.eventKey === `${STREAM_ID}:${VARIATION_NUMBER}`,
    ),
  );
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.soldQuantity, 1);
  assert.equal(selectedInventory.remainingQuantity, 4);
  assert.equal(view.totals.completedPaymentCount, 1);
  assert.equal(view.totals.committedSalesCount, 1);
  assert.equal(view.totals.profitCents, 3600);
});

test("projects observed payment labels and captured prices without an inventory mapping", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 202,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      },
    ],
  });
  const session = createSession({
    state,
    variationNumbers: [203, 202],
  });

  session.selectVariation(202);
  let view = session.getViewState();
  let option = view.variations.find(
    (variation) => variation.variationNumber === 202,
  );

  assert.equal(view.auction.observedPaymentStatus, "payment_fixing");
  assert.equal(view.auction.observedPaymentStatusLabel, "Payment fixing");
  assert.equal(option.observedPaymentStatus, "payment_fixing");
  assert.equal(option.observedPaymentStatusLabel, "Payment fixing");
  assert.equal(option.soldPriceCents, null);
  assert.deepEqual(option.conflicts, []);

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 202,
    soldPriceCents: 700,
  });
  view = session.getViewState();
  option = view.variations.find(
    (variation) => variation.variationNumber === 202,
  );

  assert.equal(view.mapping, null);
  assert.equal(view.auction.observedPaymentStatus, "payment_complete");
  assert.equal(view.auction.observedPaymentStatusLabel, "Payment complete");
  assert.equal(view.auction.soldPriceCents, 700);
  assert.equal(option.observedPaymentStatusLabel, "Payment complete");
  assert.equal(option.soldPriceCents, 700);
});

test("keeps an observed unpriced completion selected without showing pending", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: 147,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      },
    ],
  });
  const session = createSession({
    state,
    variationNumber: 147,
    variationNumbers: [147],
  });
  session.selectSku("STUSSY-TEE-BLACK-L");

  let view = session.getViewState();
  let selectedInventory = inventoryEntry(view, "STUSSY-TEE-BLACK-L");

  assert.equal(view.auction.observedPaymentStatus, "payment_complete");
  assert.equal(view.auction.paymentStatus, "unknown");
  assert.equal(view.auction.soldPriceCents, null);
  assert.equal(view.auction.status, "mapped");
  assert.equal(view.auction.statusLabel, "Item selected");
  assert.equal(view.controls.canMarkUnpaid, false);
  assert.equal(selectedInventory.remainingQuantity, 5);
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.availableToTagQuantity, 5);

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 147,
    soldPriceCents: 1100,
  });
  view = session.getViewState();
  selectedInventory = inventoryEntry(view, "STUSSY-TEE-BLACK-L");

  assert.equal(view.auction.paymentStatus, "payment_complete");
  assert.equal(view.auction.status, "committed");
  assert.equal(selectedInventory.remainingQuantity, 4);
  assert.equal(selectedInventory.reservedQuantity, 0);
});

test("initializes an isolated mapping session without creating an auction", () => {
  const inventoryBefore = clone(MOCK_INVENTORY);
  const session = createSession();

  assert.equal(session.streamId, STREAM_ID);
  assert.equal(session.variationNumber, VARIATION_NUMBER);
  assert.equal(session.getCurrentMapping(), null);
  assert.deepEqual(session.getStateSnapshot().streams, []);
  assert.deepEqual(clone(MOCK_INVENTORY), inventoryBefore);
});

test("navigates explicit variation history without changing reconciliation state", () => {
  const session = createSession({ variationNumbers: [203, 201] });
  const stateBefore = session.getStateSnapshot();
  const initialView = session.getViewState();

  assert.deepEqual(
    initialView.variations.map((variation) => variation.variationNumber),
    [203, 201],
  );
  assert.deepEqual(
    initialView.variations.map((variation) => variation.recorded),
    [false, false],
  );
  assert.equal(initialView.currentVariationNumber, 203);
  assert.equal(initialView.selectedVariationNumber, 203);
  assert.equal(initialView.isReviewingHistory, false);

  const selected = session.selectVariation(201);

  assert.equal(selected.ok, true);
  assert.equal(selected.action, "variation_selected");
  assert.equal(selected.view.currentVariationNumber, 203);
  assert.equal(selected.view.selectedVariationNumber, 201);
  assert.equal(selected.view.isReviewingHistory, true);
  assert.deepEqual(session.getStateSnapshot(), stateBefore);

  const unknown = session.selectVariation(202);

  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "UNKNOWN_VARIATION");
  assert.equal(unknown.view.selectedVariationNumber, 201);
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
});

test("marks only canonical variation records as recorded", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observeVariations(state, {
    streamId: STREAM_ID,
    variationNumbers: [202],
  });
  const session = createSession({
    state,
    variationNumbers: [203, 202, 201],
  });
  const options = session.getViewState().variations;

  assert.deepEqual(
    options.map(({ variationNumber, recorded }) => ({
      variationNumber,
      recorded,
    })),
    [
      { variationNumber: 203, recorded: false },
      { variationNumber: 202, recorded: true },
      { variationNumber: 201, recorded: false },
    ],
  );
});

test("multiple unobserved variations keep distinct selections without pending inventory", () => {
  const session = createSession({ variationNumbers: [203, 202] });

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.selectVariation(202);
  session.selectSku("NIKE-HOODIE-GREY-XL");

  const historicalView = session.getViewState();
  const state = session.getStateSnapshot();
  const stream = state.streams.find((entry) => entry.streamId === STREAM_ID);

  assert.equal(historicalView.mapping.variationNumber, 202);
  assert.equal(historicalView.mapping.sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(session.getSelectedMapping().variationNumber, 202);
  assert.equal(session.getSelectedMapping().sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(session.getCurrentMapping().variationNumber, 203);
  assert.equal(session.getCurrentMapping().sku, "STUSSY-TEE-BLACK-L");
  assert.equal(stream.variations.length, 2);
  assert.equal(
    inventoryEntry(historicalView, "STUSSY-TEE-BLACK-L").reservedQuantity,
    0,
  );
  assert.equal(
    inventoryEntry(historicalView, "NIKE-HOODIE-GREY-XL").reservedQuantity,
    0,
  );

  session.selectVariation(203);

  assert.equal(session.getCurrentMapping().sku, "STUSSY-TEE-BLACK-L");
  assert.equal(session.getSelectedMapping().sku, "STUSSY-TEE-BLACK-L");
  assert.equal(session.getViewState().currentVariationNumber, 203);
});

test("correcting a completed historical variation leaves the current mapping intact", () => {
  const session = createSession({ variationNumbers: [203, 202] });

  session.selectSku("NIKE-HOODIE-GREY-XL");
  const currentBefore = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: 203,
  });

  session.selectVariation(202);
  session.selectSku("STUSSY-TEE-BLACK-M");
  session.completePayment(2000);
  const corrected = session.selectSku("CARHARTT-JACKET-BROWN-M");
  const currentAfter = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: 203,
  });
  const option = corrected.view.variations.find(
    (variation) => variation.variationNumber === 202,
  );

  assert.equal(corrected.action, "committed_mapping_corrected");
  assert.equal(corrected.mapping.soldPriceCents, 2000);
  assert.equal(corrected.mapping.committedUnitCostCents, 1800);
  assert.equal(corrected.mapping.profitCents, 200);
  assert.equal(option.status, "committed");
  assert.equal(option.item, "Carhartt jacket");
  assert.equal(option.size, "M");
  assert.deepEqual(currentAfter, currentBefore);
});

test("correcting an unpaid historical variation preserves current state and undo", () => {
  const session = createSession({ variationNumbers: [203, 202] });

  session.selectSku("STUSSY-TEE-BLACK-L");
  const currentBefore = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: 203,
  });

  session.selectVariation(202);
  session.selectSku("NIKE-HOODIE-GREY-XL");
  session.simulatePaymentBufferExpired();
  session.markUnpaid();
  const corrected = session.selectSku("CARHARTT-JACKET-BROWN-M");

  assert.equal(corrected.action, "unpaid_mapping_corrected");
  assert.equal(corrected.mapping.status, "marked_unpaid");
  assert.equal(
    inventoryEntry(corrected.view, "NIKE-HOODIE-GREY-XL").reservedQuantity,
    0,
  );
  assert.equal(
    inventoryEntry(corrected.view, "CARHARTT-JACKET-BROWN-M").reservedQuantity,
    0,
  );

  const restored = session.undoMarkUnpaid();
  const currentAfter = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: 203,
  });

  assert.equal(restored.mapping.status, "mapped");
  assert.equal(restored.mapping.sku, "CARHARTT-JACKET-BROWN-M");
  assert.equal(
    inventoryEntry(restored.view, "CARHARTT-JACKET-BROWN-M").reservedQuantity,
    0,
  );
  assert.deepEqual(currentAfter, currentBefore);
});

test("payment-buffer eligibility stays with its own variation", () => {
  const session = createSession({ variationNumbers: [203, 202] });

  session.selectVariation(202);
  session.selectSku("STUSSY-TEE-BLACK-L");
  session.simulatePaymentBufferExpired();

  assert.equal(session.getViewState().controls.canMarkUnpaid, true);

  session.selectVariation(203);
  session.selectSku("NIKE-HOODIE-GREY-XL");

  assert.equal(session.getViewState().controls.canMarkUnpaid, false);
  assert.equal(
    session.getViewState().controls.canSimulateBufferExpiry,
    true,
  );

  session.selectVariation(202);

  assert.equal(session.getViewState().controls.canMarkUnpaid, true);
  assert.equal(
    session.getViewState().controls.canSimulateBufferExpiry,
    false,
  );
});

test("undoing one simulated payment preserves changes to other variations", () => {
  const session = createSession({ variationNumbers: [203, 202] });

  session.selectVariation(202);
  session.selectSku("STUSSY-TEE-BLACK-M");
  session.completePayment(2000);

  session.selectVariation(203);
  session.selectSku("NIKE-HOODIE-GREY-L");
  session.completePayment(2500);
  const currentBeforeUndo = reconciliation.getAuction(
    session.getStateSnapshot(),
    { streamId: STREAM_ID, variationNumber: 203 },
  );

  session.selectVariation(202);
  const undone = session.undoSimulatedPayment();
  const state = session.getStateSnapshot();
  const currentAfterUndo = reconciliation.getAuction(state, {
    streamId: STREAM_ID,
    variationNumber: 203,
  });

  assert.equal(undone.ok, true);
  assert.equal(undone.mapping.status, "mapped");
  assert.equal(undone.mapping.sku, "STUSSY-TEE-BLACK-M");
  assert.deepEqual(currentAfterUndo, currentBeforeUndo);
  assert.equal(undone.view.totals.committedSalesCount, 1);

  session.selectVariation(203);

  assert.equal(session.getViewState().controls.canUndoSimulatedPayment, true);
});

test("maps an available inventory entry to the demo variation", () => {
  const session = createSession();
  const result = session.selectSku("STUSSY-TEE-BLACK-L");
  const selectedInventory = inventoryEntry(
    result.view,
    "STUSSY-TEE-BLACK-L",
  );
  const auction = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "mapped");
  assert.equal(result.mapping.item, "Stussy tee");
  assert.equal(result.mapping.style, "black");
  assert.equal(result.mapping.size, "L");
  assert.equal(result.mapping.statusLabel, "Item selected");
  assert.equal(auction.eventKey, "demo-stream:203");
  assert.equal(auction.sku, "STUSSY-TEE-BLACK-L");
  assert.equal(auction.status, "mapped");
  assert.equal(auction.mappingStatus, "mapped");
  assert.equal(auction.paymentStatus, "unknown");
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.availableToTagQuantity, 5);
  assert.equal(getStockDisplay(selectedInventory).secondaryLabel, "");
});

test("uses a supplied shared state without replacing its existing auctions", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.mapVariation(state, {
    streamId: "earlier-stream",
    variationNumber: 7,
    sku: "STUSSY-TEE-BLACK-M",
  });
  const session = createSession({ state });
  const result = session.selectSku("STUSSY-TEE-BLACK-L");

  assert.equal(result.ok, true);
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: "earlier-stream",
      variationNumber: 7,
    }).sku,
    "STUSSY-TEE-BLACK-M",
  );
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: VARIATION_NUMBER,
    }).sku,
    "STUSSY-TEE-BLACK-L",
  );

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });
  const updatedView = session.getViewState();

  assert.equal(updatedView.auction.status, "committed");
  assert.equal(updatedView.auction.statusLabel, "Payment complete");
  assert.equal(updatedView.auction.profitCents, 3600);
  assert.equal(
    inventoryEntry(updatedView, "STUSSY-TEE-BLACK-L").remainingQuantity,
    4,
  );
});

test("an unmapped completed warning remains associated with its own variation", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: 203,
    sku: "STUSSY-TEE-BLACK-L",
  });
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 202,
    soldPriceCents: 4800,
  });

  const session = createSession({
    state,
    variationNumbers: [203, 202],
  });
  const currentView = session.getViewState();

  assert.equal(currentView.auction.status, "mapped");
  assert.ok(
    currentView.warnings.some(
      (warning) =>
        warning.code === "unmapped_completed_sale" &&
        warning.eventKey === "demo-stream:202",
    ),
  );

  session.selectVariation(202);

  assert.equal(session.getViewState().auction.status, "unmapped_completed");
});

test("maps a payment-complete variation that arrived before employee tagging", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });

  const session = createSession({ state });
  const beforeMapping = session.getViewState();

  assert.equal(beforeMapping.auction.status, "unmapped_completed");
  assert.equal(
    beforeMapping.auction.statusLabel,
    "Payment complete - item needed",
  );
  assert.equal(beforeMapping.mapping, null);
  assert.equal(beforeMapping.totals.completedGmvCents, 4800);
  assert.equal(beforeMapping.totals.committedSalesCount, 0);
  assert.equal(beforeMapping.totals.committedRevenueCents, 0);
  assert.equal(beforeMapping.totals.profitCents, 0);
  assert.equal(
    beforeMapping.warnings[0].code,
    "unmapped_completed_sale",
  );
  assert.deepEqual(beforeMapping.controls, {
    canCompletePayment: false,
    canSimulateBufferExpiry: false,
    canMarkUnpaid: false,
    canUndoSimulatedPayment: false,
    canUndoUnpaid: false,
  });

  const result = session.selectSku("STUSSY-TEE-BLACK-L");
  const selectedInventory = inventoryEntry(
    result.view,
    "STUSSY-TEE-BLACK-L",
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, "completed_sale_mapped");
  assert.equal(result.mapping.status, "committed");
  assert.equal(result.mapping.statusLabel, "Payment complete");
  assert.equal(result.mapping.soldPriceCents, 4800);
  assert.equal(result.mapping.committedUnitCostCents, 1200);
  assert.equal(result.mapping.profitCents, 3600);
  assert.equal(selectedInventory.soldQuantity, 1);
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.remainingQuantity, 4);
  assert.equal(result.view.totals.committedSalesCount, 1);
  assert.equal(result.view.totals.committedRevenueCents, 4800);
  assert.equal(result.view.warnings.length, 0);
  assert.equal(result.view.controls.canUndoSimulatedPayment, false);

  const stateBeforeRejectedUndo = session.getStateSnapshot();
  const rejectedUndo = session.undoSimulatedPayment();

  assert.equal(rejectedUndo.ok, false);
  assert.equal(rejectedUndo.code, "SIMULATED_PAYMENT_NOT_UNDOABLE");
  assert.deepEqual(session.getStateSnapshot(), stateBeforeRejectedUndo);
});

test("selecting the pending entry again unmaps it and releases its reservation", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: VARIATION_NUMBER,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
    ],
  });
  const session = createSession({ state });

  session.selectSku("STUSSY-TEE-BLACK-L");
  const result = session.selectSku("STUSSY-TEE-BLACK-L");
  const inventory = inventoryEntry(result.view, "STUSSY-TEE-BLACK-L");

  assert.equal(result.ok, true);
  assert.equal(result.action, "unmapped");
  assert.equal(result.previousStatus, "pending");
  assert.equal(result.unmappedSku, "STUSSY-TEE-BLACK-L");
  assert.equal(result.mapping, null);
  assert.equal(result.view.auction.status, "unmapped");
  assert.equal(result.view.auction.sku, null);
  assert.equal(inventory.selected, false);
  assert.equal(inventory.reservedQuantity, 0);
  assert.equal(inventory.availableToTagQuantity, 5);
});

test("unmapping a completed demo sale keeps payment truth and its undo checkpoint", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.completePayment(4800);
  const unmapped = session.selectSku("STUSSY-TEE-BLACK-L");
  const inventory = inventoryEntry(unmapped.view, "STUSSY-TEE-BLACK-L");

  assert.equal(unmapped.action, "unmapped");
  assert.equal(unmapped.previousStatus, "committed");
  assert.equal(unmapped.mapping, null);
  assert.equal(unmapped.view.auction.status, "unmapped_completed");
  assert.equal(unmapped.view.auction.paymentStatus, "payment_complete");
  assert.equal(unmapped.view.auction.soldPriceCents, 4800);
  assert.equal(unmapped.view.totals.completedPaymentCount, 1);
  assert.equal(unmapped.view.totals.completedGmvCents, 4800);
  assert.equal(unmapped.view.totals.committedSalesCount, 0);
  assert.equal(unmapped.view.totals.committedRevenueCents, 0);
  assert.equal(unmapped.view.totals.profitCents, 0);
  assert.equal(inventory.soldQuantity, 0);
  assert.equal(inventory.remainingQuantity, 5);
  assert.equal(unmapped.view.controls.canUndoSimulatedPayment, true);
  assert.ok(
    unmapped.view.warnings.some(
      (warning) => warning.code === "unmapped_completed_sale",
    ),
  );

  const undone = session.undoSimulatedPayment();

  assert.equal(undone.ok, true);
  assert.equal(undone.mapping, null);
  assert.equal(undone.view.auction.status, "unmapped");
  assert.equal(undone.view.auction.paymentStatus, "unknown");
  assert.equal(undone.view.totals.completedGmvCents, 0);
  assert.equal(undone.view.controls.canUndoSimulatedPayment, false);
});

test("unmapping an unpaid variation keeps the unpaid decision until undo", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.simulatePaymentBufferExpired();
  session.markUnpaid();
  const unmapped = session.selectSku("STUSSY-TEE-BLACK-L");

  assert.equal(unmapped.action, "unmapped");
  assert.equal(unmapped.previousStatus, "marked_unpaid");
  assert.equal(unmapped.mapping, null);
  assert.equal(unmapped.view.auction.status, "marked_unpaid");
  assert.equal(unmapped.view.auction.mappingStatus, "marked_unpaid");
  assert.equal(unmapped.view.controls.canCompletePayment, false);
  assert.equal(unmapped.view.controls.canUndoUnpaid, true);
  assert.equal(
    inventoryEntry(unmapped.view, "STUSSY-TEE-BLACK-L").reservedQuantity,
    0,
  );

  const restored = session.undoMarkUnpaid();

  assert.equal(restored.ok, true);
  assert.equal(restored.mapping, null);
  assert.equal(restored.view.auction.status, "unmapped");
  assert.equal(restored.view.controls.canUndoUnpaid, false);
});

test("mapping an unselected unpaid variation keeps its unpaid status", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.simulatePaymentBufferExpired();
  session.markUnpaid();
  session.selectSku("STUSSY-TEE-BLACK-L");
  const remapped = session.selectSku("NIKE-HOODIE-GREY-XL");

  assert.equal(remapped.ok, true);
  assert.equal(remapped.action, "unpaid_mapping_corrected");
  assert.equal(remapped.mapping.sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(remapped.mapping.status, "marked_unpaid");
  assert.equal(remapped.view.controls.canCompletePayment, true);
  assert.equal(remapped.view.controls.canUndoUnpaid, true);
});

test("unmapping a previous variation leaves the on-screen mapping intact", () => {
  const session = createSession({ variationNumbers: [203, 202] });

  session.selectSku("STUSSY-TEE-BLACK-L");
  const currentBefore = session.getCurrentMapping();
  session.selectVariation(202);
  session.selectSku("NIKE-HOODIE-GREY-XL");
  const unmapped = session.selectSku("NIKE-HOODIE-GREY-XL");

  assert.equal(unmapped.action, "unmapped");
  assert.equal(unmapped.view.selectedVariationNumber, 202);
  assert.equal(unmapped.view.mapping, null);
  assert.equal(unmapped.view.auction.status, "unmapped");
  assert.equal(session.getCurrentMapping().sku, currentBefore.sku);
  assert.equal(session.getCurrentMapping().variationNumber, 203);
});

test("selecting another entry corrects the same variation mapping", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const result = session.selectSku("NIKE-HOODIE-GREY-XL");
  const state = session.getStateSnapshot();

  assert.equal(result.ok, true);
  assert.equal(result.action, "remapped");
  assert.equal(result.mapping.sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(state.streams.length, 1);
  assert.equal(state.streams[0].variations.length, 1);
  assert.equal(state.streams[0].variations[0].variationNumber, 203);
  assert.equal(state.streams[0].variations[0].sku, "NIKE-HOODIE-GREY-XL");
});

test("rejects sold-out and unknown entries without changing state", () => {
  const session = createSession();
  const stateBefore = session.getStateSnapshot();
  const soldOutResult = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const unknownResult = session.selectSku("NOT-IN-INVENTORY");

  assert.equal(soldOutResult.ok, false);
  assert.equal(soldOutResult.code, "SOLD_OUT");
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, "UNKNOWN_SKU");
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
  assert.equal(session.getCurrentMapping(), null);
});

test("a rejected correction preserves an existing valid mapping", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const stateBefore = session.getStateSnapshot();
  const result = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");

  assert.equal(result.ok, false);
  assert.equal(result.code, "SOLD_OUT");
  assert.equal(result.mapping.sku, "STUSSY-TEE-BLACK-L");
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
});

test("pending mapping does not create payment, profit, or inventory changes", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [
      {
        variationNumber: VARIATION_NUMBER,
        observedPaymentStatus:
          reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      },
    ],
  });
  const session = createSession({ state });

  session.selectSku("STUSSY-TEE-BLACK-L");
  const stateSnapshot = session.getStateSnapshot();
  const auction = reconciliation.getAuction(stateSnapshot, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });
  const summary = reconciliation.calculateSummary(stateSnapshot, {
    streamId: STREAM_ID,
  });

  assert.equal(auction.soldPriceCents, null);
  assert.equal(auction.committedUnitCostCents, null);
  assert.equal(auction.profitCents, null);
  assert.equal(auction.committed, false);
  assert.equal(summary.totals.completedPaymentCount, 0);
  assert.equal(summary.totals.committedSalesCount, 0);
  assert.equal(summary.totals.completedGmvCents, 0);
  assert.equal(summary.totals.committedRevenueCents, 0);
  assert.equal(summary.totals.costOfGoodsCents, 0);
  assert.equal(summary.totals.profitCents, 0);
  assert.equal(
    inventoryEntry(session.getViewState(), "STUSSY-TEE-BLACK-L")
      .reservedQuantity,
    1,
  );
  assert.equal(
    inventoryEntry(session.getViewState(), "STUSSY-TEE-BLACK-L")
      .availableToTagQuantity,
    4,
  );
  assert.equal(
    getStockDisplay(
      inventoryEntry(session.getViewState(), "STUSSY-TEE-BLACK-L"),
    ).secondaryLabel,
    "1 pending",
  );
  assert.deepEqual(
    summary.inventory.map((entry) => entry.remainingQuantity),
    MOCK_INVENTORY.map((entry) => entry.quantityReceived),
  );
});

test("prevents two sessions from reserving the same final unit", () => {
  const displayInventory = [
    MOCK_INVENTORY.find((entry) => entry.sku === "NIKE-HOODIE-GREY-L"),
  ];
  const state = reconciliation.createReconciliationState(
    toEngineInventory(displayInventory),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [203, 204].map((variationNumber) => ({
      variationNumber,
      observedPaymentStatus:
        reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    })),
  });
  const firstSession = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 203,
  });
  const secondSession = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 204,
  });

  assert.equal(firstSession.selectSku("NIKE-HOODIE-GREY-L").ok, true);
  const firstView = firstSession.getViewState();
  const rejected = secondSession.selectSku("NIKE-HOODIE-GREY-L");

  assert.equal(
    inventoryEntry(firstView, "NIKE-HOODIE-GREY-L").remainingQuantity,
    1,
  );
  assert.equal(
    inventoryEntry(firstView, "NIKE-HOODIE-GREY-L").availableToTagQuantity,
    0,
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "NO_STOCK_AVAILABLE");
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: 204,
    }).sku,
    null,
  );
  const released = firstSession.selectSku("NIKE-HOODIE-GREY-L");

  assert.equal(released.action, "unmapped");
  assert.equal(
    inventoryEntry(released.view, "NIKE-HOODIE-GREY-L")
      .availableToTagQuantity,
    1,
  );
  assert.equal(secondSession.selectSku("NIKE-HOODIE-GREY-L").ok, true);
});

test("completes payment once and derives profit and inventory from the engine", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const completed = session.completePayment(4800);
  const completedState = session.getStateSnapshot();
  const duplicate = session.completePayment(4800);
  const duplicateState = session.getStateSnapshot();
  const conflict = session.completePayment(4900);
  const view = session.getViewState();
  const selectedInventory = inventoryEntry(view, "STUSSY-TEE-BLACK-L");

  assert.equal(completed.ok, true);
  assert.equal(completed.action, "payment_completed");
  assert.equal(completed.mapping.status, "committed");
  assert.equal(completed.mapping.statusLabel, "Payment complete");
  assert.equal(completed.mapping.soldPriceCents, 4800);
  assert.equal(completed.mapping.committedUnitCostCents, 1200);
  assert.equal(completed.mapping.profitCents, 3600);
  assert.equal(selectedInventory.soldQuantity, 1);
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.remainingQuantity, 4);
  assert.equal(selectedInventory.availableToTagQuantity, 4);
  assert.equal(view.totals.committedSalesCount, 1);
  assert.equal(view.totals.profitCents, 3600);
  assert.equal(duplicate.action, "payment_unchanged");
  assert.deepEqual(duplicateState, completedState);
  assert.equal(conflict.action, "payment_conflict");
  assert.equal(conflict.mapping.soldPriceCents, 4800);
  assert.equal(conflict.mapping.conflicts[0].code, "conflicting_sold_price");
});

test("undoes a locally simulated payment and restores an unreserved selection", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const beforePayment = session.getStateSnapshot();
  const completed = session.completePayment(4800);

  assert.equal(completed.view.controls.canUndoSimulatedPayment, true);

  const undone = session.undoSimulatedPayment();
  const inventory = inventoryEntry(undone.view, "STUSSY-TEE-BLACK-L");

  assert.equal(undone.ok, true);
  assert.equal(undone.action, "simulated_payment_undone");
  assert.equal(undone.mapping.status, "mapped");
  assert.equal(undone.mapping.statusLabel, "Item selected");
  assert.equal(undone.mapping.paymentStatus, "unknown");
  assert.equal(undone.mapping.soldPriceCents, null);
  assert.equal(undone.mapping.committedUnitCostCents, null);
  assert.equal(undone.mapping.profitCents, null);
  assert.equal(inventory.soldQuantity, 0);
  assert.equal(inventory.reservedQuantity, 0);
  assert.equal(inventory.remainingQuantity, 5);
  assert.equal(inventory.availableToTagQuantity, 5);
  assert.equal(undone.view.totals.completedPaymentCount, 0);
  assert.equal(undone.view.totals.committedSalesCount, 0);
  assert.equal(undone.view.totals.committedRevenueCents, 0);
  assert.equal(undone.view.totals.costOfGoodsCents, 0);
  assert.equal(undone.view.totals.profitCents, 0);
  assert.equal(undone.view.controls.canCompletePayment, true);
  assert.equal(undone.view.controls.canUndoSimulatedPayment, false);
  assert.deepEqual(session.getStateSnapshot(), beforePayment);

  const stateBeforeSecondUndo = session.getStateSnapshot();
  const secondUndo = session.undoSimulatedPayment();

  assert.equal(secondUndo.ok, false);
  assert.equal(secondUndo.code, "SIMULATED_PAYMENT_NOT_UNDOABLE");
  assert.deepEqual(session.getStateSnapshot(), stateBeforeSecondUndo);

  const completedAgain = session.completePayment(5000);

  assert.equal(completedAgain.ok, true);
  assert.equal(completedAgain.view.controls.canUndoSimulatedPayment, true);
});

test("undoing simulated payment preserves a mapping correction", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-M");
  session.completePayment(4800);
  session.selectSku("NIKE-HOODIE-GREY-XL");

  const undone = session.undoSimulatedPayment();
  const originalInventory = inventoryEntry(
    undone.view,
    "STUSSY-TEE-BLACK-M",
  );
  const correctedInventory = inventoryEntry(
    undone.view,
    "NIKE-HOODIE-GREY-XL",
  );

  assert.equal(undone.mapping.status, "mapped");
  assert.equal(undone.mapping.sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(originalInventory.reservedQuantity, 0);
  assert.equal(originalInventory.availableToTagQuantity, 2);
  assert.equal(correctedInventory.soldQuantity, 0);
  assert.equal(correctedInventory.reservedQuantity, 0);
  assert.equal(correctedInventory.remainingQuantity, 3);
  assert.equal(correctedInventory.availableToTagQuantity, 3);
  assert.equal(undone.view.totals.profitCents, 0);
});

test("undoing simulated payment restores demo buffer eligibility", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.simulatePaymentBufferExpired();
  session.completePayment(4800);

  const undone = session.undoSimulatedPayment();

  assert.equal(undone.mapping.status, "mapped");
  assert.equal(undone.view.demo.paymentBufferExpired, true);
  assert.equal(undone.view.controls.canSimulateBufferExpiry, false);
  assert.equal(undone.view.controls.canMarkUnpaid, true);
});

test("rejects simulated-payment undo before a local completion", () => {
  const session = createSession();
  const initialState = session.getStateSnapshot();

  const beforeMapping = session.undoSimulatedPayment();

  assert.equal(beforeMapping.ok, false);
  assert.equal(beforeMapping.code, "SIMULATED_PAYMENT_NOT_UNDOABLE");
  assert.deepEqual(session.getStateSnapshot(), initialState);

  session.selectSku("STUSSY-TEE-BLACK-L");
  const pendingState = session.getStateSnapshot();
  const beforeCompletion = session.undoSimulatedPayment();

  assert.equal(beforeCompletion.ok, false);
  assert.equal(beforeCompletion.code, "SIMULATED_PAYMENT_NOT_UNDOABLE");
  assert.deepEqual(session.getStateSnapshot(), pendingState);
});

test("requires an explicit demo flag before payment can be simulated", () => {
  const session = createMappingSession({
    inventory: MOCK_INVENTORY,
    reconciliation,
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });

  session.selectSku("STUSSY-TEE-BLACK-L");
  const pendingState = session.getStateSnapshot();
  const completion = session.completePayment(4800);
  const buffer = session.simulatePaymentBufferExpired();
  const undo = session.undoSimulatedPayment();

  assert.equal(completion.ok, false);
  assert.equal(completion.code, "PAYMENT_SIMULATION_DISABLED");
  assert.equal(buffer.ok, false);
  assert.equal(buffer.code, "BUFFER_SIMULATION_DISABLED");
  assert.equal(undo.code, "SIMULATED_PAYMENT_NOT_UNDOABLE");
  assert.equal(undo.view.controls.canUndoSimulatedPayment, false);
  assert.deepEqual(session.getStateSnapshot(), pendingState);
});

test("demo simulators never mutate supplied shared state", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());

  reconciliation.mapVariation(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    sku: "STUSSY-TEE-BLACK-L",
  });
  const identity = state;
  const beforeSimulation = clone(state);
  const session = createSession({ state });

  const completion = session.completePayment(4800);
  const buffer = session.simulatePaymentBufferExpired();

  assert.equal(completion.code, "PAYMENT_SIMULATION_DISABLED");
  assert.equal(buffer.code, "BUFFER_SIMULATION_DISABLED");
  assert.equal(state, identity);
  assert.deepEqual(state, beforeSimulation);
  assert.equal(session.getViewState().controls.canUndoSimulatedPayment, false);
});

test("does not allow a completed payment to be marked unpaid", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.completePayment(4800);
  const stateBefore = session.getStateSnapshot();
  const result = session.markUnpaid();

  assert.equal(result.ok, false);
  assert.equal(result.code, "PAYMENT_ALREADY_COMPLETE");
  assert.deepEqual(session.getStateSnapshot(), stateBefore);
});

test("rejects invalid payment completion without creating partial state", () => {
  const session = createSession();
  const emptyState = session.getStateSnapshot();

  assert.equal(session.completePayment(4800).code, "VARIATION_NOT_MAPPED");
  assert.deepEqual(session.getStateSnapshot(), emptyState);

  session.selectSku("STUSSY-TEE-BLACK-L");
  const mappedState = session.getStateSnapshot();

  [0, -1, 48.5, null].forEach((invalidPrice) => {
    const result = session.completePayment(invalidPrice);

    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_SOLD_PRICE");
    assert.deepEqual(session.getStateSnapshot(), mappedState);
  });
});

test("requires demo buffer expiry before unpaid and supports undo", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const mappedState = session.getStateSnapshot();
  const earlyUnpaid = session.markUnpaid();

  assert.equal(earlyUnpaid.ok, false);
  assert.equal(earlyUnpaid.code, "PAYMENT_BUFFER_ACTIVE");
  assert.deepEqual(session.getStateSnapshot(), mappedState);

  const expired = session.simulatePaymentBufferExpired();
  const expiredInventory = inventoryEntry(
    expired.view,
    "STUSSY-TEE-BLACK-L",
  );

  assert.equal(expired.action, "payment_buffer_expired");
  assert.equal(expired.view.auction.status, "mapped");
  assert.equal(expired.view.demo.paymentBufferExpired, true);
  assert.equal(expiredInventory.reservedQuantity, 0);
  assert.equal(expired.view.totals.committedSalesCount, 0);

  const unpaid = session.markUnpaid();
  const unpaidInventory = inventoryEntry(unpaid.view, "STUSSY-TEE-BLACK-L");

  assert.equal(unpaid.action, "marked_unpaid");
  assert.equal(unpaid.mapping.status, "marked_unpaid");
  assert.equal(unpaid.mapping.statusLabel, "Marked unpaid");
  assert.equal(unpaidInventory.reservedQuantity, 0);
  assert.equal(unpaidInventory.remainingQuantity, 5);
  assert.equal(unpaidInventory.availableToTagQuantity, 5);
  assert.equal(unpaid.view.totals.profitCents, 0);

  const restored = session.undoMarkUnpaid();
  const restoredInventory = inventoryEntry(
    restored.view,
    "STUSSY-TEE-BLACK-L",
  );

  assert.equal(restored.action, "unpaid_undone");
  assert.equal(restored.mapping.status, "mapped");
  assert.equal(restoredInventory.reservedQuantity, 0);
  assert.equal(restoredInventory.availableToTagQuantity, 5);
  assert.equal(restored.view.controls.canMarkUnpaid, true);
});

test("selecting another inventory card corrects an unpaid mapping", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.simulatePaymentBufferExpired();
  session.markUnpaid();

  const corrected = session.selectSku("NIKE-HOODIE-GREY-XL");
  const originalInventory = inventoryEntry(
    corrected.view,
    "STUSSY-TEE-BLACK-L",
  );
  const correctedInventory = inventoryEntry(
    corrected.view,
    "NIKE-HOODIE-GREY-XL",
  );

  assert.equal(corrected.ok, true);
  assert.equal(corrected.action, "unpaid_mapping_corrected");
  assert.equal(corrected.mapping.status, "marked_unpaid");
  assert.equal(corrected.mapping.sku, "NIKE-HOODIE-GREY-XL");
  assert.equal(originalInventory.soldQuantity, 0);
  assert.equal(originalInventory.reservedQuantity, 0);
  assert.equal(
    originalInventory.remainingQuantity,
    originalInventory.quantityReceived,
  );
  assert.equal(correctedInventory.soldQuantity, 0);
  assert.equal(correctedInventory.reservedQuantity, 0);
  assert.equal(
    correctedInventory.remainingQuantity,
    correctedInventory.quantityReceived,
  );
  assert.equal(corrected.view.totals.profitCents, 0);
  assert.equal(corrected.view.controls.canUndoUnpaid, true);
});

test("payment completion after an unpaid mark wins and surfaces a conflict", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  session.simulatePaymentBufferExpired();
  session.markUnpaid();
  const completed = session.completePayment(4800);
  const inventory = inventoryEntry(
    completed.view,
    "STUSSY-TEE-BLACK-L",
  );

  assert.equal(completed.ok, true);
  assert.equal(completed.mapping.status, "committed");
  assert.equal(completed.mapping.profitCents, 3600);
  assert.equal(
    completed.mapping.conflicts[0].code,
    "payment_completed_after_marked_unpaid",
  );
  assert.equal(inventory.soldQuantity, 1);
  assert.equal(inventory.reservedQuantity, 0);
  assert.equal(inventory.remainingQuantity, 4);
  assert.equal(completed.view.totals.committedSalesCount, 1);
  assert.equal(completed.view.totals.conflictCount, 1);
  assert.equal(completed.view.controls.canUndoSimulatedPayment, false);

  const stateBeforeUndo = session.getStateSnapshot();
  const rejectedUndo = session.undoSimulatedPayment();

  assert.equal(rejectedUndo.code, "SIMULATED_PAYMENT_NOT_UNDOABLE");
  assert.deepEqual(session.getStateSnapshot(), stateBeforeUndo);
});

test("undoing unpaid restores the reservation even if a re-auction claimed the unit", () => {
  const displayInventory = [
    MOCK_INVENTORY.find((entry) => entry.sku === "NIKE-HOODIE-GREY-L"),
  ];
  const state = reconciliation.createReconciliationState(
    toEngineInventory(displayInventory),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [203, 204].map((variationNumber) => ({
      variationNumber,
      observedPaymentStatus:
        reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    })),
  });
  const originalSession = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 203,
  });
  const reauctionSession = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 204,
  });

  originalSession.selectSku("NIKE-HOODIE-GREY-L");
  reconciliation.markUnpaid(state, {
    streamId: STREAM_ID,
    variationNumber: 203,
  });
  assert.equal(reauctionSession.selectSku("NIKE-HOODIE-GREY-L").ok, true);

  const restored = originalSession.undoMarkUnpaid();
  const inventory = inventoryEntry(restored.view, "NIKE-HOODIE-GREY-L");

  assert.equal(restored.ok, true);
  assert.equal(restored.mapping.status, "pending");
  assert.equal(inventory.soldQuantity, 0);
  assert.equal(inventory.reservedQuantity, 2);
  assert.equal(inventory.remainingQuantity, 1);
  assert.equal(inventory.availableToTagQuantity, -1);
  assert.equal(inventory.reservationShortfallQuantity, 1);
  assert.ok(
    restored.view.warnings.some(
      (warning) => warning.code === "no_stock_available",
    ),
  );
});

test("late payment wins after an unpaid item has already been re-auctioned", () => {
  const displayInventory = [
    MOCK_INVENTORY.find((entry) => entry.sku === "NIKE-HOODIE-GREY-L"),
  ];
  const state = reconciliation.createReconciliationState(
    toEngineInventory(displayInventory),
  );
  reconciliation.observePaymentStatuses(state, {
    streamId: STREAM_ID,
    statuses: [203, 204].map((variationNumber) => ({
      variationNumber,
      observedPaymentStatus:
        reconciliation.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    })),
  });
  const originalSession = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 203,
  });
  const reauctionSession = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: 204,
  });

  originalSession.selectSku("NIKE-HOODIE-GREY-L");
  reconciliation.markUnpaid(state, {
    streamId: STREAM_ID,
    variationNumber: 203,
  });
  reauctionSession.selectSku("NIKE-HOODIE-GREY-L");

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 203,
    soldPriceCents: 2500,
  });
  const completed = originalSession.getViewState();
  const inventory = inventoryEntry(completed, "NIKE-HOODIE-GREY-L");

  assert.equal(completed.mapping.status, "committed");
  assert.equal(inventory.soldQuantity, 1);
  assert.equal(inventory.reservedQuantity, 1);
  assert.equal(inventory.remainingQuantity, 0);
  assert.equal(inventory.availableToTagQuantity, -1);
  assert.equal(inventory.reservationShortfallQuantity, 1);
  assert.ok(
    completed.mapping.conflicts.some(
      (conflict) =>
        conflict.code === "payment_completed_after_marked_unpaid",
    ),
  );
  assert.ok(
    completed.warnings.some(
      (warning) => warning.code === "no_stock_available",
    ),
  );
});

test("committed correction moves stock and recalculates profit even when stock is empty", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-M");
  session.completePayment(1000);
  const corrected = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const view = session.getViewState();

  assert.equal(corrected.ok, true);
  assert.equal(corrected.action, "committed_mapping_corrected");
  assert.equal(corrected.mapping.status, "committed");
  assert.equal(corrected.mapping.committedUnitCostCents, 900);
  assert.equal(corrected.mapping.profitCents, 100);
  assert.equal(
    inventoryEntry(view, "STUSSY-TEE-BLACK-M").remainingQuantity,
    2,
  );
  assert.equal(
    inventoryEntry(view, "DENIM-SHORTS-WASHED-BLUE-32").remainingQuantity,
    -1,
  );
  assert.equal(view.warnings[0].code, "negative_inventory");
  assert.equal(view.controls.canUndoSimulatedPayment, false);
});

test("canonical state quantities override stale display quantities", () => {
  const displayInventory = [
    {
      sku: "STALE-SKU",
      item: "Stale item",
      style: "black",
      size: "M",
      quantityReceived: 99,
      remainingQuantity: 99,
      unitCostCents: 100,
    },
  ];
  const state = reconciliation.createReconciliationState([
    {
      sku: "STALE-SKU",
      name: "Stale item - black",
      size: "M",
      quantityReceived: 0,
      unitCostCents: 100,
    },
  ]);
  const session = createMappingSession({
    inventory: displayInventory,
    reconciliation,
    state,
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
  });
  const view = session.getViewState();

  assert.equal(inventoryEntry(view, "STALE-SKU").quantityReceived, 0);
  assert.equal(inventoryEntry(view, "STALE-SKU").remainingQuantity, 0);
  assert.equal(inventoryEntry(view, "STALE-SKU").selectionAllowed, false);
  assert.equal(session.selectSku("STALE-SKU").code, "SOLD_OUT");
});

test("rejects display inventory that is missing from supplied canonical state", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory([MOCK_INVENTORY[0]]),
  );

  assert.throws(
    () => createSession({ state }),
    /Display inventory SKU .* is missing from reconciliation state/,
  );
  assert.deepEqual(state.streams, []);

  assert.throws(
    () => createSession({ state: null }),
    /state must be omitted or be a reconciliation state/,
  );
});
