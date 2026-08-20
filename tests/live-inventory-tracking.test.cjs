const assert = require("node:assert/strict");
const test = require("node:test");

const captureIntegration = require(
  "../extension/shared/capture-integration.js"
);
const captureProtocol = require("../extension/shared/capture-protocol.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationCoordinator = require(
  "../extension/shared/reconciliation-coordinator.js"
);
const reconciliationStorage = require(
  "../extension/shared/reconciliation-storage.js"
);
const streamSession = require("../extension/shared/stream-session.js");
const streamSessionCoordinator = require(
  "../extension/shared/stream-session-coordinator.js"
);
const streamSessionStorage = require(
  "../extension/shared/stream-session-storage.js"
);
const mappingWorkflow = require("../extension/tagger/mapping-workflow.js");
const { LEGACY_RECOVERY_INVENTORY } = require(
  "../extension/tagger/inventory-view-model.js"
);
const persistentTaggerController = require(
  "../extension/tagger/persistent-tagger-controller.js"
);
const reconciliationClient = require(
  "../extension/tagger/reconciliation-client.js"
);

const STREAM_ID = "local-stream:33333333-3333-4333-8333-333333333333";
const COMPLETED_VARIATION = 100;
const CURRENT_VARIATION = 101;
const SOLD_PRICE_CENTS = 2500;
const STUSSY_L_SKU = "STUSSY-TEE-BLACK-L";
const STUSSY_M_SKU = "STUSSY-TEE-BLACK-M";
const NIKE_XL_SKU = "NIKE-HOODIE-GREY-XL";
const NIKE_L_SKU = "NIKE-HOODIE-GREY-L";
const TEST_INVENTORY = LEGACY_RECOVERY_INVENTORY;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorageArea() {
  const values = {};
  let nextSetError = null;

  return {
    values,
    failNextSet(error = new Error("simulated storage failure")) {
      nextSetError = error;
    },
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
    },
    async set(entries) {
      if (nextSetError) {
        const error = nextSetError;

        nextSetError = null;
        throw error;
      }

      Object.assign(values, clone(entries));
    },
  };
}

function createStateCoordinator(storageArea) {
  return reconciliationCoordinator.createReconciliationCoordinator({
    reconciliation,
    stateStore: reconciliationStorage.createReconciliationStateStore({
      storageArea,
      reconciliation,
    }),
  });
}

function createActiveStreamCoordinator(storageArea) {
  return streamSessionCoordinator.createStreamSessionCoordinator({
    streamSession,
    stateStore: streamSessionStorage.createStreamSessionStateStore({
      storageArea,
      streamSession,
    }),
    createId: () => STREAM_ID,
    now: () => "2026-08-08T20:00:00.000Z",
  });
}

function createCaptureBridge(activeStreamCoordinator, stateCoordinator) {
  return captureIntegration.createCaptureIntegration({
    activeStreamCoordinator,
    captureProtocol,
    reconciliationCoordinator,
    stateCoordinator,
    streamSession,
    streamSessionCoordinator,
  });
}

function createRuntime(stateCoordinator) {
  return {
    async sendMessage(envelope) {
      assert.equal(envelope.channel, reconciliationCoordinator.MESSAGE_CHANNEL);
      assert.equal(envelope.version, reconciliationCoordinator.MESSAGE_VERSION);

      try {
        return {
          ok: true,
          data: await stateCoordinator.dispatch(envelope.command),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              typeof error?.code === "string"
                ? error.code
                : "RECONCILIATION_COMMAND_FAILED",
            message:
              typeof error?.message === "string"
                ? error.message
                : "The reconciliation command failed.",
          },
        };
      }
    },
  };
}

function createController(stateCoordinator, options = {}) {
  const inventory = options.inventory ?? TEST_INVENTORY;
  const currentVariationNumber =
    options.currentVariationNumber ?? CURRENT_VARIATION;
  const variationNumbers = options.variationNumbers ?? [
    COMPLETED_VARIATION,
    CURRENT_VARIATION,
  ];
  const client = reconciliationClient.createReconciliationClient({
    runtime: createRuntime(stateCoordinator),
    protocol: reconciliationCoordinator,
  });

  return persistentTaggerController.createPersistentTaggerController({
    client,
    inventory: clone(inventory),
    mappingWorkflow,
    reconciliation,
    streamId: STREAM_ID,
    currentVariationNumber,
    variationNumbers,
  });
}

async function startPreparedStream(
  stateCoordinator,
  activeStreamCoordinator,
  inventory = TEST_INVENTORY,
) {
  const client = reconciliationClient.createReconciliationClient({
    runtime: createRuntime(stateCoordinator),
    protocol: reconciliationCoordinator,
  });

  await persistentTaggerController.ensureInventoryInitialized({
    client,
    inventory: clone(inventory),
  });
  const session = await activeStreamCoordinator.dispatch({
    type: streamSessionCoordinator.COMMAND_TYPES.START_STREAM,
  });
  const streamId = session.state.activeSession?.streamId;

  assert.equal(typeof streamId, "string");
  await stateCoordinator.dispatch({
    type:
      reconciliationCoordinator.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE,
    streamId,
  });

  return session;
}

function inventoryEntry(snapshot, sku) {
  return snapshot.view.inventory.find((entry) => entry.sku === sku);
}

function inventoryQuantities(snapshot, sku) {
  const entry = inventoryEntry(snapshot, sku);

  return {
    availableToTagQuantity: entry.availableToTagQuantity,
    remainingQuantity: entry.remainingQuantity,
    reservedQuantity: entry.reservedQuantity,
    soldQuantity: entry.soldQuantity,
  };
}

async function capturePaymentStatus(capture, variationNumber, status) {
  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
    statuses: [
      {
        variationNumber,
        observedPaymentStatus: status,
      },
    ],
  });
}

test("live capture and persistent tagging reconcile six inventory entries without drift", async () => {
  const storageArea = createStorageArea();
  const firstStateCoordinator = createStateCoordinator(storageArea);
  const activeStreamCoordinator = createActiveStreamCoordinator(storageArea);
  const capture = createCaptureBridge(
    activeStreamCoordinator,
    firstStateCoordinator,
  );
  const controller = createController(firstStateCoordinator);

  await startPreparedStream(firstStateCoordinator, activeStreamCoordinator);
  let snapshot = await controller.start();

  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.view.inventory.length, 6);

  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [COMPLETED_VARIATION],
  });
  await capturePaymentStatus(
    capture,
    COMPLETED_VARIATION,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
  );
  snapshot = await controller.refresh();

  assert.equal(snapshot.view.selectedVariationNumber, COMPLETED_VARIATION);
  assert.equal(
    snapshot.view.auction.observedPaymentStatus,
    "payment_processing",
  );

  snapshot = await controller.mapSelectedSku(STUSSY_L_SKU);

  assert.equal(snapshot.view.auction.status, "pending");
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 4,
    remainingQuantity: 5,
    reservedQuantity: 1,
    soldQuantity: 0,
  });

  await capturePaymentStatus(
    capture,
    COMPLETED_VARIATION,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  );
  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: COMPLETED_VARIATION,
    soldPriceCents: SOLD_PRICE_CENTS,
  });
  snapshot = await controller.refresh();

  assert.equal(snapshot.view.auction.status, "committed");
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 4,
    remainingQuantity: 4,
    reservedQuantity: 0,
    soldQuantity: 1,
  });
  assert.equal(snapshot.view.totals.committedSalesCount, 1);
  assert.equal(snapshot.view.totals.committedRevenueCents, SOLD_PRICE_CENTS);
  assert.equal(snapshot.view.totals.costOfGoodsCents, 1200);
  assert.equal(snapshot.view.totals.profitCents, 1300);

  const beforeDuplicates = (
    await firstStateCoordinator.dispatch({ type: "get_state" })
  ).state;

  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [COMPLETED_VARIATION],
  });
  await capturePaymentStatus(
    capture,
    COMPLETED_VARIATION,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  );
  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: COMPLETED_VARIATION,
    soldPriceCents: SOLD_PRICE_CENTS,
  });
  const afterDuplicates = (
    await firstStateCoordinator.dispatch({ type: "get_state" })
  ).state;

  assert.deepEqual(afterDuplicates, beforeDuplicates);
  snapshot = await controller.refresh();
  assert.equal(inventoryEntry(snapshot, STUSSY_L_SKU).soldQuantity, 1);
  assert.equal(snapshot.view.totals.committedSalesCount, 1);

  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [COMPLETED_VARIATION, CURRENT_VARIATION],
  });
  await capturePaymentStatus(
    capture,
    CURRENT_VARIATION,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
  );
  snapshot = await controller.refresh();

  assert.equal(snapshot.view.selectedVariationNumber, CURRENT_VARIATION);
  snapshot = controller.selectVariation(COMPLETED_VARIATION);
  assert.equal(snapshot.view.isReviewingHistory, true);

  snapshot = await controller.mapSelectedSku(STUSSY_M_SKU);

  assert.equal(snapshot.view.selectedVariationNumber, COMPLETED_VARIATION);
  assert.equal(snapshot.view.auction.sku, STUSSY_M_SKU);
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 5,
    remainingQuantity: 5,
    reservedQuantity: 0,
    soldQuantity: 0,
  });
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_M_SKU), {
    availableToTagQuantity: 1,
    remainingQuantity: 1,
    reservedQuantity: 0,
    soldQuantity: 1,
  });
  assert.equal(snapshot.view.totals.costOfGoodsCents, 1200);
  assert.equal(snapshot.view.totals.profitCents, 1300);

  snapshot = await controller.mapSelectedSku(NIKE_XL_SKU);

  assert.equal(snapshot.view.selectedVariationNumber, COMPLETED_VARIATION);
  assert.equal(snapshot.view.auction.sku, NIKE_XL_SKU);
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_M_SKU), {
    availableToTagQuantity: 2,
    remainingQuantity: 2,
    reservedQuantity: 0,
    soldQuantity: 0,
  });
  assert.deepEqual(inventoryQuantities(snapshot, NIKE_XL_SKU), {
    availableToTagQuantity: 2,
    remainingQuantity: 2,
    reservedQuantity: 0,
    soldQuantity: 1,
  });
  assert.equal(snapshot.view.totals.costOfGoodsCents, 1400);
  assert.equal(snapshot.view.totals.profitCents, 1100);

  snapshot = await controller.unmapSelectedVariation();

  assert.equal(snapshot.view.auction.sku, null);
  assert.equal(snapshot.view.auction.status, "unmapped_completed");
  assert.equal(snapshot.view.auction.paymentStatus, "payment_complete");
  assert.equal(snapshot.view.auction.observedPaymentStatus, "payment_complete");
  assert.equal(snapshot.view.auction.soldPriceCents, SOLD_PRICE_CENTS);
  assert.equal(snapshot.view.totals.completedPaymentCount, 1);
  assert.equal(snapshot.view.totals.completedGmvCents, SOLD_PRICE_CENTS);
  assert.equal(snapshot.view.totals.committedSalesCount, 0);
  assert.equal(snapshot.view.totals.committedRevenueCents, 0);
  assert.equal(snapshot.view.totals.costOfGoodsCents, 0);
  assert.equal(snapshot.view.totals.profitCents, 0);
  TEST_INVENTORY.forEach(({ quantityReceived, sku }) => {
    assert.deepEqual(inventoryQuantities(snapshot, sku), {
      availableToTagQuantity: quantityReceived,
      remainingQuantity: quantityReceived,
      reservedQuantity: 0,
      soldQuantity: 0,
    });
  });

  const restartedStateCoordinator = createStateCoordinator(storageArea);
  const reopenedController = createController(restartedStateCoordinator);
  let reopened = await reopenedController.start();

  assert.equal(reopened.phase, "ready");
  assert.equal(reopened.view.selectedVariationNumber, CURRENT_VARIATION);
  reopened = reopenedController.selectVariation(COMPLETED_VARIATION);
  assert.equal(reopened.view.auction.status, "unmapped_completed");
  assert.equal(reopened.view.auction.paymentStatus, "payment_complete");
  assert.equal(reopened.view.auction.soldPriceCents, SOLD_PRICE_CENTS);
  TEST_INVENTORY.forEach(({ quantityReceived, sku }) => {
    assert.equal(
      inventoryEntry(reopened, sku).remainingQuantity,
      quantityReceived,
    );
  });

  const durableBeforeFailedSave = clone(
    storageArea.values[reconciliationStorage.STORAGE_KEY],
  );

  storageArea.failNextSet();
  const failedSave = await reopenedController.mapSelectedSku(NIKE_XL_SKU);

  assert.equal(failedSave.phase, "error");
  assert.equal(failedSave.error.scope, "save");
  assert.equal(failedSave.error.code, "STORAGE_WRITE_FAILED");
  assert.equal(failedSave.view.auction.sku, null);
  assert.equal(failedSave.view.auction.paymentStatus, "payment_complete");
  assert.deepEqual(
    storageArea.values[reconciliationStorage.STORAGE_KEY],
    durableBeforeFailedSave,
  );

  const afterFailureCoordinator = createStateCoordinator(storageArea);
  const afterFailure = await afterFailureCoordinator.dispatch({
    type: "get_state",
  });
  const completedAuction = reconciliation.getAuction(afterFailure.state, {
    streamId: STREAM_ID,
    variationNumber: COMPLETED_VARIATION,
  });

  assert.equal(completedAuction.sku, null);
  assert.equal(completedAuction.paymentStatus, "payment_complete");
  assert.equal(completedAuction.soldPriceCents, SOLD_PRICE_CENTS);
  assert.equal(
    reconciliation.getInventoryAvailability(afterFailure.state, {
      sku: NIKE_XL_SKU,
    }).remainingQuantity,
    3,
  );
});

test("a live failed payment stays reserved until terminal cancellation restores inventory and permits reference edits", async () => {
  const storageArea = createStorageArea();
  const stateCoordinator = createStateCoordinator(storageArea);
  const activeStreamCoordinator = createActiveStreamCoordinator(storageArea);
  const capture = createCaptureBridge(
    activeStreamCoordinator,
    stateCoordinator,
  );
  const controller = createController(stateCoordinator);

  await startPreparedStream(stateCoordinator, activeStreamCoordinator);
  await controller.start();
  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [COMPLETED_VARIATION],
  });
  await capturePaymentStatus(
    capture,
    COMPLETED_VARIATION,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
  );
  let snapshot = await controller.refresh();

  snapshot = await controller.mapSelectedSku(STUSSY_L_SKU);
  assert.equal(snapshot.view.auction.observedPaymentStatus, "payment_processing");
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 4,
    remainingQuantity: 5,
    reservedQuantity: 1,
    soldQuantity: 0,
  });

  for (const status of [
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
  ]) {
    await capturePaymentStatus(capture, COMPLETED_VARIATION, status);
    snapshot = await controller.refresh();

    assert.equal(snapshot.view.auction.observedPaymentStatus, status);
    assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
      availableToTagQuantity: 4,
      remainingQuantity: 5,
      reservedQuantity: 1,
      soldQuantity: 0,
    });
  }

  await capturePaymentStatus(
    capture,
    COMPLETED_VARIATION,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.CANCELED,
  );
  snapshot = await controller.refresh();

  assert.equal(snapshot.view.auction.sku, STUSSY_L_SKU);
  assert.equal(snapshot.view.auction.mappingStatus, "mapped");
  assert.equal(snapshot.view.auction.paymentStatus, "canceled");
  assert.equal(snapshot.view.auction.observedPaymentStatus, "canceled");
  assert.equal(snapshot.view.auction.soldPriceCents, null);
  assert.equal(snapshot.view.auction.committedUnitCostCents, null);
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 5,
    remainingQuantity: 5,
    reservedQuantity: 0,
    soldQuantity: 0,
  });
  assert.equal(snapshot.view.totals.completedPaymentCount, 0);
  assert.equal(snapshot.view.totals.committedSalesCount, 0);
  assert.equal(snapshot.view.totals.completedGmvCents, 0);
  assert.equal(snapshot.view.totals.committedRevenueCents, 0);
  assert.equal(snapshot.view.totals.costOfGoodsCents, 0);
  assert.equal(snapshot.view.totals.profitCents, 0);

  const canceledState = (
    await stateCoordinator.dispatch({ type: "get_state" })
  ).state;

  for (const staleStatus of [
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
  ]) {
    await capturePaymentStatus(
      capture,
      COMPLETED_VARIATION,
      staleStatus,
    );
  }

  const afterStaleStatuses = (
    await stateCoordinator.dispatch({ type: "get_state" })
  ).state;

  assert.deepEqual(afterStaleStatuses, canceledState);
  snapshot = await controller.refresh();
  assert.equal(snapshot.view.auction.paymentStatus, "canceled");
  assert.equal(snapshot.view.auction.observedPaymentStatus, "canceled");

  const beforeIgnoredCompletion = (
    await stateCoordinator.dispatch({ type: "get_state" })
  ).state;

  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: COMPLETED_VARIATION,
    soldPriceCents: SOLD_PRICE_CENTS,
  });
  snapshot = await controller.refresh();

  assert.equal(snapshot.view.auction.status, "canceled");
  assert.equal(snapshot.view.auction.paymentStatus, "canceled");
  assert.equal(snapshot.view.auction.observedPaymentStatus, "canceled");
  assert.deepEqual(snapshot.view.auction.conflicts, []);
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 5,
    remainingQuantity: 5,
    reservedQuantity: 0,
    soldQuantity: 0,
  });
  assert.equal(snapshot.view.totals.completedPaymentCount, 0);
  assert.equal(snapshot.view.totals.committedSalesCount, 0);
  assert.equal(snapshot.view.totals.conflictCount, 0);
  assert.equal(snapshot.view.totals.completedGmvCents, 0);
  assert.equal(snapshot.view.totals.committedRevenueCents, 0);
  assert.equal(snapshot.view.totals.costOfGoodsCents, 0);
  assert.equal(snapshot.view.totals.profitCents, 0);

  const afterIgnoredCompletion = (
    await stateCoordinator.dispatch({ type: "get_state" })
  ).state;

  assert.deepEqual(afterIgnoredCompletion, beforeIgnoredCompletion);
  const totalsBeforeReferenceEdits = clone(snapshot.view.totals);

  snapshot = await controller.mapSelectedSku(NIKE_XL_SKU);
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.operation, "map_variation");
  assert.equal(snapshot.view.auction.status, "canceled");
  assert.equal(snapshot.view.auction.sku, NIKE_XL_SKU);
  assert.equal(snapshot.view.auction.committedUnitCostCents, null);
  assert.deepEqual(snapshot.view.totals, totalsBeforeReferenceEdits);
  assert.deepEqual(inventoryQuantities(snapshot, STUSSY_L_SKU), {
    availableToTagQuantity: 5,
    remainingQuantity: 5,
    reservedQuantity: 0,
    soldQuantity: 0,
  });
  assert.deepEqual(inventoryQuantities(snapshot, NIKE_XL_SKU), {
    availableToTagQuantity: 3,
    remainingQuantity: 3,
    reservedQuantity: 0,
    soldQuantity: 0,
  });

  snapshot = await controller.unmapSelectedVariation();
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.operation, "unmap_variation");
  assert.equal(snapshot.view.auction.status, "canceled");
  assert.equal(snapshot.view.auction.sku, null);
  assert.equal(snapshot.view.mapping, null);
  assert.deepEqual(snapshot.view.totals, totalsBeforeReferenceEdits);

  snapshot = await controller.mapSelectedSku(STUSSY_L_SKU);
  assert.equal(snapshot.view.auction.status, "canceled");
  assert.equal(snapshot.view.auction.sku, STUSSY_L_SKU);
  assert.deepEqual(snapshot.view.totals, totalsBeforeReferenceEdits);

  const afterReferenceCorrections = (
    await stateCoordinator.dispatch({ type: "get_state" })
  ).state;

  assert.equal(
    reconciliation.getAuction(afterReferenceCorrections, {
      streamId: STREAM_ID,
      variationNumber: COMPLETED_VARIATION,
    }).sku,
    STUSSY_L_SKU,
  );
  assert.deepEqual(
    reconciliation.hydrateReconciliationState(
      clone(afterReferenceCorrections),
    ),
    afterReferenceCorrections,
  );
});

test("two persistent taggers may oversell the Nike hoodie last unit with visible shortage state", async () => {
  const storageArea = createStorageArea();
  const stateCoordinator = createStateCoordinator(storageArea);
  const activeStreamCoordinator = createActiveStreamCoordinator(storageArea);
  const capture = createCaptureBridge(
    activeStreamCoordinator,
    stateCoordinator,
  );
  const firstVariationNumber = 201;
  const secondVariationNumber = 202;
  const controllerOptions = {
    currentVariationNumber: secondVariationNumber,
    variationNumbers: [firstVariationNumber, secondVariationNumber],
  };
  const firstController = createController(
    stateCoordinator,
    controllerOptions,
  );
  const secondController = createController(
    stateCoordinator,
    controllerOptions,
  );

  await startPreparedStream(stateCoordinator, activeStreamCoordinator);
  await Promise.all([firstController.start(), secondController.start()]);
  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [firstVariationNumber, secondVariationNumber],
  });
  await capture.dispatch({
    type: captureProtocol.EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
    statuses: [
      {
        variationNumber: firstVariationNumber,
        observedPaymentStatus:
          captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
      {
        variationNumber: secondVariationNumber,
        observedPaymentStatus:
          captureProtocol.OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      },
    ],
  });

  const [firstReady, secondReady] = await Promise.all([
    firstController.refresh(),
    secondController.refresh(),
  ]);

  assert.equal(inventoryEntry(firstReady, NIKE_L_SKU).availableToTagQuantity, 1);
  assert.equal(inventoryEntry(secondReady, NIKE_L_SKU).availableToTagQuantity, 1);
  firstController.selectVariation(firstVariationNumber);
  secondController.selectVariation(secondVariationNumber);

  const outcomes = await Promise.all([
    firstController.mapSelectedSku(NIKE_L_SKU),
    secondController.mapSelectedSku(NIKE_L_SKU),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.phase === "ready").length,
    2,
  );

  const canonical = await stateCoordinator.dispatch({ type: "get_state" });
  const summary = reconciliation.calculateSummary(canonical.state, {
    streamId: STREAM_ID,
  });
  const mappedAuctions = summary.auctions.filter(
    (auction) => auction.sku === NIKE_L_SKU,
  );
  const nikeLastUnit = summary.inventory.find(
    (entry) => entry.sku === NIKE_L_SKU,
  );

  assert.equal(mappedAuctions.length, 2);
  assert.equal(
    mappedAuctions.every((auction) => auction.status === "pending"),
    true,
  );
  assert.equal(
    summary.auctions.filter((auction) => auction.sku === null).length,
    0,
  );
  assert.deepEqual(
    {
      availableToTagQuantity: nikeLastUnit.availableToTagQuantity,
      remainingQuantity: nikeLastUnit.remainingQuantity,
      reservedQuantity: nikeLastUnit.reservedQuantity,
      soldQuantity: nikeLastUnit.soldQuantity,
    },
    {
      availableToTagQuantity: -1,
      remainingQuantity: 1,
      reservedQuantity: 2,
      soldQuantity: 0,
    },
  );
  assert.equal(nikeLastUnit.oversoldQuantity, 1);
  assert.equal(summary.totals.pendingMappedCount, 2);

  await capturePaymentStatus(
    capture,
    firstVariationNumber,
    captureProtocol.OBSERVED_PAYMENT_STATUSES.CANCELED,
  );
  const afterCancellation = await stateCoordinator.dispatch({
    type: "get_state",
  });
  const afterCancellationSummary = reconciliation.calculateSummary(
    afterCancellation.state,
    { streamId: STREAM_ID },
  );
  const restoredLastUnit = afterCancellationSummary.inventory.find(
    (entry) => entry.sku === NIKE_L_SKU,
  );

  assert.deepEqual(
    afterCancellationSummary.auctions.map((auction) => ({
      sku: auction.sku,
      status: auction.status,
      variationNumber: auction.variationNumber,
    })),
    [
      {
        sku: NIKE_L_SKU,
        status: "canceled",
        variationNumber: firstVariationNumber,
      },
      {
        sku: NIKE_L_SKU,
        status: "pending",
        variationNumber: secondVariationNumber,
      },
    ],
  );
  assert.deepEqual(
    {
      availableToTagQuantity: restoredLastUnit.availableToTagQuantity,
      oversoldQuantity: restoredLastUnit.oversoldQuantity,
      remainingQuantity: restoredLastUnit.remainingQuantity,
      reservedQuantity: restoredLastUnit.reservedQuantity,
      soldQuantity: restoredLastUnit.soldQuantity,
    },
    {
      availableToTagQuantity: 0,
      oversoldQuantity: 0,
      remainingQuantity: 1,
      reservedQuantity: 1,
      soldQuantity: 0,
    },
  );
  assert.equal(afterCancellationSummary.totals.pendingMappedCount, 1);

  const restartedCoordinator = createStateCoordinator(storageArea);
  const restored = await restartedCoordinator.dispatch({ type: "get_state" });

  assert.deepEqual(restored.state, afterCancellation.state);
  assert.doesNotThrow(() =>
    reconciliation.hydrateReconciliationState(restored.state),
  );
});
