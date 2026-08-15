const assert = require("node:assert/strict");
const test = require("node:test");

const reconciliation = require("../extension/shared/reconciliation.js");
const {
  LEGACY_RECOVERY_INVENTORY,
  getStockDisplay,
} = require("../extension/tagger/inventory-view-model.js");
const {
  createMappingSession,
  getObservedPaymentStatusLabel,
} = require("../extension/tagger/mapping-workflow.js");

const STREAM_ID = "local-stream:mapping-test";
const VARIATION_NUMBER = 203;
const TEST_INVENTORY = LEGACY_RECOVERY_INVENTORY;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toEngineInventory(entries = TEST_INVENTORY) {
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
    inventory: TEST_INVENTORY,
    reconciliation,
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
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

test("keeps temporary payment failed reserved and locks canonical canceled orders", () => {
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

  const locked = session.selectSku("STUSSY-TEE-BLACK-L");
  const view = session.getViewState();
  const canceledOption = view.variations.find(
    (variation) => variation.variationNumber === 202,
  );
  const failedOption = view.variations.find(
    (variation) => variation.variationNumber === 201,
  );

  assert.equal(view.selectedVariationNumber, 202);
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "CANCELED_VARIATION_IMMUTABLE");
  assert.equal(view.auction.observedPaymentStatus, "canceled");
  assert.equal(view.auction.observedPaymentStatusLabel, "Canceled");
  assert.equal(view.auction.paymentStatus, "canceled");
  assert.equal(view.auction.status, "canceled");
  assert.equal(view.auction.statusLabel, "Canceled");
  assert.equal(view.auction.mappingStatus, "unmapped");
  assert.equal(view.mapping, null);
  assert.ok(view.inventory.every((entry) => !entry.selectionAllowed));
  assert.ok(
    view.inventory.every((entry) => entry.selectionReason === "canceled"),
  );
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

  session.selectVariation(201);
  const failedMapping = session.selectSku("NIKE-HOODIE-GREY-XL");
  const failedInventory = inventoryEntry(
    failedMapping.view,
    "NIKE-HOODIE-GREY-XL",
  );

  assert.equal(failedMapping.mapping.status, "pending");
  assert.equal(failedMapping.mapping.statusLabel, "Waiting for payment");
  assert.equal(failedInventory.reservedQuantity, 1);
  assert.equal(failedInventory.availableToTagQuantity, 2);
});

test("reserves not-observed and unrecognized selections until a terminal status", () => {
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
      { variationNumber: 203, status: "pending", statusLabel: "Waiting for payment" },
      { variationNumber: 202, status: "pending", statusLabel: "Waiting for payment" },
    ],
  );
  assert.equal(inventory.reservedQuantity, 2);
  assert.equal(inventory.availableToTagQuantity, -1);
  assert.equal(inventory.oversoldQuantity, 1);
});

test("keeps a canceled order's prior SKU as immutable read-only history", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

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
  const canceledView = session.getViewState();
  const selected = inventoryEntry(canceledView, "STUSSY-TEE-BLACK-L");
  const relinked = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const unlinked = session.selectSku("STUSSY-TEE-BLACK-L");

  assert.equal(canceledView.auction.status, "canceled");
  assert.equal(canceledView.mapping.sku, "STUSSY-TEE-BLACK-L");
  assert.equal(selected.selected, true);
  assert.equal(selected.selectionAllowed, false);
  assert.equal(selected.selectionReason, "canceled");
  assert.equal(selected.reservedQuantity, 0);
  assert.equal(selected.remainingQuantity, 5);
  assert.ok(canceledView.inventory.every((entry) => !entry.selectionAllowed));
  assert.equal(relinked.code, "CANCELED_VARIATION_IMMUTABLE");
  assert.equal(unlinked.code, "CANCELED_VARIATION_IMMUTABLE");
  assert.equal(session.getViewState().mapping.sku, "STUSSY-TEE-BLACK-L");
  assert.equal(canceledView.totals.committedSalesCount, 0);
  assert.equal(canceledView.totals.profitCents, 0);
});

test("keeps cancellation terminal when a stale completion arrives later", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

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

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });
  const view = session.getViewState();
  const selectedInventory = inventoryEntry(view, "STUSSY-TEE-BLACK-L");

  assert.equal(view.auction.status, "canceled");
  assert.equal(view.auction.statusLabel, "Canceled");
  assert.equal(view.auction.paymentStatus, "canceled");
  assert.equal(view.auction.observedPaymentStatus, "canceled");
  assert.equal(view.auction.soldPriceCents, null);
  assert.equal(view.auction.committedUnitCostCents, null);
  assert.equal(view.auction.profitCents, null);
  assert.deepEqual(view.auction.conflicts, []);
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.soldQuantity, 0);
  assert.equal(selectedInventory.remainingQuantity, 5);
  assert.equal(view.totals.completedPaymentCount, 0);
  assert.equal(view.totals.committedSalesCount, 0);
  assert.equal(view.totals.profitCents, 0);
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

test("keeps an observed unpriced completion reserved until its final price arrives", () => {
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
  assert.equal(view.auction.status, "pending");
  assert.equal(view.auction.statusLabel, "Waiting for payment");
  assert.equal(selectedInventory.remainingQuantity, 5);
  assert.equal(selectedInventory.reservedQuantity, 1);
  assert.equal(selectedInventory.availableToTagQuantity, 4);

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
  const inventoryBefore = clone(TEST_INVENTORY);
  const session = createSession();

  assert.equal(session.streamId, STREAM_ID);
  assert.equal(session.variationNumber, VARIATION_NUMBER);
  assert.equal(session.getCurrentMapping(), null);
  assert.deepEqual(session.getStateSnapshot().streams, []);
  assert.deepEqual(clone(TEST_INVENTORY), inventoryBefore);
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

test("projects the active bidding variation as current and keeps it mappable", () => {
  const biddingVariationNumber = 252;
  const state = reconciliation.createReconciliationState(
    toEngineInventory(),
  );

  reconciliation.observeBiddingVariation(state, {
    streamId: STREAM_ID,
    variationNumber: biddingVariationNumber,
  });
  const session = createSession({
    state,
    variationNumbers: [VARIATION_NUMBER],
  });
  let view = session.getViewState();
  let biddingOption = view.variations.find(
    ({ variationNumber }) => variationNumber === biddingVariationNumber,
  );

  assert.equal(view.activeBiddingVariationNumber, biddingVariationNumber);
  assert.equal(view.currentVariationNumber, biddingVariationNumber);
  assert.equal(view.selectedVariationNumber, biddingVariationNumber);
  assert.equal(view.isReviewingHistory, false);
  assert.equal(biddingOption.recorded, true);
  assert.equal(biddingOption.bidding, true);
  assert.equal(biddingOption.current, true);
  assert.equal(biddingOption.selected, true);

  const mapped = session.selectSku("STUSSY-TEE-BLACK-L");

  assert.equal(mapped.ok, true);
  assert.equal(mapped.mapping.variationNumber, biddingVariationNumber);
  assert.equal(mapped.mapping.observedPaymentStatus, "not_observed");
  view = session.getViewState();
  assert.equal(
    inventoryEntry(view, "STUSSY-TEE-BLACK-L").remainingQuantity,
    5,
  );
  assert.equal(
    inventoryEntry(view, "STUSSY-TEE-BLACK-L").reservedQuantity,
    1,
  );
  biddingOption = view.variations.find(
    ({ variationNumber }) => variationNumber === biddingVariationNumber,
  );
  assert.equal(biddingOption.item, "Stussy tee");
  assert.equal(biddingOption.style, "black");
  assert.equal(biddingOption.size, "L");

  const historical = session.selectVariation(VARIATION_NUMBER);

  assert.equal(historical.ok, true);
  assert.equal(historical.view.currentVariationNumber, biddingVariationNumber);
  assert.equal(historical.view.isReviewingHistory, true);
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

test("multiple unobserved variations keep distinct pending reservations", () => {
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
    1,
  );
  assert.equal(
    inventoryEntry(historicalView, "NIKE-HOODIE-GREY-XL").reservedQuantity,
    1,
  );

  session.selectVariation(203);

  assert.equal(session.getCurrentMapping().sku, "STUSSY-TEE-BLACK-L");
  assert.equal(session.getSelectedMapping().sku, "STUSSY-TEE-BLACK-L");
  assert.equal(session.getViewState().currentVariationNumber, 203);
});

test("correcting a completed historical variation leaves the current mapping intact", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());
  const session = createSession({ state, variationNumbers: [203, 202] });

  session.selectSku("NIKE-HOODIE-GREY-XL");
  const currentBefore = reconciliation.getAuction(session.getStateSnapshot(), {
    streamId: STREAM_ID,
    variationNumber: 203,
  });

  session.selectVariation(202);
  session.selectSku("STUSSY-TEE-BLACK-M");
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: 202,
    soldPriceCents: 2000,
  });
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

test("maps an available inventory entry to the selected Live variation", () => {
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
  assert.equal(result.mapping.statusLabel, "Waiting for payment");
  assert.equal(auction.eventKey, `${STREAM_ID}:203`);
  assert.equal(auction.sku, "STUSSY-TEE-BLACK-L");
  assert.equal(auction.status, "pending");
  assert.equal(auction.mappingStatus, "mapped");
  assert.equal(auction.paymentStatus, "unknown");
  assert.equal(selectedInventory.reservedQuantity, 1);
  assert.equal(selectedInventory.availableToTagQuantity, 4);
  assert.equal(getStockDisplay(selectedInventory).secondaryLabel, "1 pending");
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

  assert.equal(currentView.auction.status, "pending");
  assert.ok(
    currentView.warnings.some(
      (warning) =>
        warning.code === "unmapped_completed_sale" &&
        warning.eventKey === `${STREAM_ID}:202`,
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

test("unmapping a completed Live sale keeps captured payment truth", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());
  const session = createSession({ state });

  session.selectSku("STUSSY-TEE-BLACK-L");
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });
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
  assert.ok(
    unmapped.view.warnings.some(
      (warning) => warning.code === "unmapped_completed_sale",
    ),
  );
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

test("allows zero-stock entries while still rejecting unknown SKUs", () => {
  const session = createSession();
  const zeroStockResult = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const stateAfterSelection = session.getStateSnapshot();
  const unknownResult = session.selectSku("NOT-IN-INVENTORY");
  const zeroStockInventory = inventoryEntry(
    zeroStockResult.view,
    "DENIM-SHORTS-WASHED-BLUE-32",
  );

  assert.equal(zeroStockResult.ok, true);
  assert.equal(zeroStockResult.action, "mapped");
  assert.equal(zeroStockResult.mapping.status, "pending");
  assert.equal(zeroStockInventory.selectionAllowed, true);
  assert.equal(zeroStockInventory.availableToTagQuantity, -1);
  assert.equal(zeroStockInventory.oversoldQuantity, 1);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.code, "UNKNOWN_SKU");
  assert.deepEqual(session.getStateSnapshot(), stateAfterSelection);
  assert.equal(session.getCurrentMapping().sku, "DENIM-SHORTS-WASHED-BLUE-32");
});

test("correcting to a zero-stock entry records an oversold reservation", () => {
  const session = createSession();

  session.selectSku("STUSSY-TEE-BLACK-L");
  const result = session.selectSku("DENIM-SHORTS-WASHED-BLUE-32");
  const inventory = inventoryEntry(
    result.view,
    "DENIM-SHORTS-WASHED-BLUE-32",
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, "remapped");
  assert.equal(result.mapping.sku, "DENIM-SHORTS-WASHED-BLUE-32");
  assert.equal(inventory.reservedQuantity, 1);
  assert.equal(inventory.availableToTagQuantity, -1);
  assert.equal(inventory.oversoldQuantity, 1);
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
    TEST_INVENTORY.map((entry) => entry.quantityReceived),
  );
});

test("allows multiple reservations beyond stock and reports the oversold amount", () => {
  const displayInventory = [
    TEST_INVENTORY.find((entry) => entry.sku === "NIKE-HOODIE-GREY-L"),
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
  const second = secondSession.selectSku("NIKE-HOODIE-GREY-L");

  assert.equal(
    inventoryEntry(firstView, "NIKE-HOODIE-GREY-L").remainingQuantity,
    1,
  );
  assert.equal(
    inventoryEntry(firstView, "NIKE-HOODIE-GREY-L").availableToTagQuantity,
    0,
  );
  assert.equal(second.ok, true);
  assert.equal(second.mapping.status, "pending");
  assert.equal(
    reconciliation.getAuction(state, {
      streamId: STREAM_ID,
      variationNumber: 204,
    }).sku,
    "NIKE-HOODIE-GREY-L",
  );
  const overallocated = secondSession.getViewState();

  assert.equal(
    inventoryEntry(overallocated, "NIKE-HOODIE-GREY-L").reservedQuantity,
    2,
  );
  assert.equal(
    inventoryEntry(overallocated, "NIKE-HOODIE-GREY-L")
      .availableToTagQuantity,
    -1,
  );
  assert.equal(
    inventoryEntry(overallocated, "NIKE-HOODIE-GREY-L").oversoldQuantity,
    1,
  );
  const released = firstSession.selectSku("NIKE-HOODIE-GREY-L");

  assert.equal(released.action, "unmapped");
  assert.equal(
    inventoryEntry(released.view, "NIKE-HOODIE-GREY-L")
      .availableToTagQuantity,
    0,
  );
  assert.equal(
    inventoryEntry(released.view, "NIKE-HOODIE-GREY-L").oversoldQuantity,
    0,
  );
});

test("projects captured payment truth and engine-derived profit and inventory", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());
  const session = createSession({ state });

  session.selectSku("STUSSY-TEE-BLACK-L");
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });
  const completed = session.getViewState();
  const selectedInventory = inventoryEntry(completed, "STUSSY-TEE-BLACK-L");

  assert.equal(completed.mapping.status, "committed");
  assert.equal(completed.mapping.statusLabel, "Payment complete");
  assert.equal(completed.mapping.soldPriceCents, 4800);
  assert.equal(completed.mapping.committedUnitCostCents, 1200);
  assert.equal(completed.mapping.profitCents, 3600);
  assert.equal(selectedInventory.soldQuantity, 1);
  assert.equal(selectedInventory.reservedQuantity, 0);
  assert.equal(selectedInventory.remainingQuantity, 4);
  assert.equal(selectedInventory.availableToTagQuantity, 4);
  assert.equal(completed.totals.committedSalesCount, 1);
  assert.equal(completed.totals.profitCents, 3600);

  const completedState = clone(state);
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4800,
  });
  assert.deepEqual(state, completedState);

  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 4900,
  });
  const conflicted = session.getViewState();

  assert.equal(conflicted.mapping.soldPriceCents, 4800);
  assert.equal(
    conflicted.mapping.conflicts[0].code,
    "conflicting_sold_price",
  );
});

test("mapping workflow exposes only Live mapping and projection APIs", () => {
  const session = createSession();
  const view = session.getViewState();

  assert.deepEqual(Object.keys(session).sort(), [
    "currentVariationNumber",
    "getCurrentMapping",
    "getInventoryEntries",
    "getSelectedMapping",
    "getStateSnapshot",
    "getVariationOptions",
    "getViewState",
    "selectSku",
    "selectVariation",
    "streamId",
    "variationNumber",
  ]);
  assert.deepEqual(Object.keys(view).sort(), [
    "activeBiddingVariationNumber",
    "auction",
    "currentVariationNumber",
    "inventory",
    "isReviewingHistory",
    "mapping",
    "selectedVariationNumber",
    "streamId",
    "totals",
    "variationNumber",
    "variations",
    "warnings",
  ]);
});

test("committed correction moves stock and recalculates profit even when stock is empty", () => {
  const state = reconciliation.createReconciliationState(toEngineInventory());
  const session = createSession({ state });

  session.selectSku("STUSSY-TEE-BLACK-M");
  reconciliation.recordPaymentComplete(state, {
    streamId: STREAM_ID,
    variationNumber: VARIATION_NUMBER,
    soldPriceCents: 1000,
  });
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
  assert.equal(inventoryEntry(view, "STALE-SKU").selectionAllowed, true);
  const selected = session.selectSku("STALE-SKU");

  assert.equal(selected.ok, true);
  assert.equal(selected.mapping.status, "pending");
  assert.equal(inventoryEntry(selected.view, "STALE-SKU").oversoldQuantity, 1);
});

test("rejects display inventory that is missing from supplied canonical state", () => {
  const state = reconciliation.createReconciliationState(
    toEngineInventory([TEST_INVENTORY[0]]),
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
