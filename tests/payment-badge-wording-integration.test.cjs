const assert = require("node:assert/strict");
const test = require("node:test");

const locator = require("../extension/capture/sale-candidate-locator.js");
const parser = require("../extension/shared/sale-parser.js");
const captureClient = require("../extension/capture/capture-client.js");
const captureProtocol = require("../extension/shared/capture-protocol.js");
const captureIntegration = require("../extension/shared/capture-integration.js");
const reconciliation = require("../extension/shared/reconciliation.js");
const reconciliationCoordinator = require("../extension/shared/reconciliation-coordinator.js");
const reconciliationStorage = require("../extension/shared/reconciliation-storage.js");
const streamSession = require("../extension/shared/stream-session.js");
const streamSessionCoordinator = require("../extension/shared/stream-session-coordinator.js");
const streamReport = require("../extension/shared/stream-report.js");
const streamReportCoordinator = require("../extension/shared/stream-report-coordinator.js");
const streamReportProtocol = require("../extension/shared/stream-report-protocol.js");
const streamReportStorage = require("../extension/shared/stream-report-storage.js");

const STREAM_ID = "local-stream:11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-09-12T00:00:00.000Z";
const ENDED_AT = "2026-09-12T00:10:00.000Z";
const INVENTORY = [{
  sku: "SYNTHETIC-TEE-M",
  name: "Synthetic Tee",
  size: "M",
  quantityReceived: 5,
  unitCostCents: 1200,
}];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Only the DOM operations used by the real Sold Items locator are simulated.
// No browser session, customer data, or live dashboard is involved.
class Element {
  constructor({ dataTid = null, tagName = "DIV", text = "" } = {}) {
    this.nodeType = 1;
    this.dataTid = dataTid;
    this.tagName = tagName;
    this.ownText = text;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
    }
    return this;
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  get childNodes() {
    return this.children;
  }

  getAttribute(name) {
    return name === "data-tid" ? this.dataTid : null;
  }

  getBoundingClientRect() {
    return { width: 100, height: 20 };
  }

  matches(selector) {
    if (selector === locator.SOLD_ITEMS_ROOT_SELECTOR) {
      return this.dataTid === "m4b_space";
    }
    if (selector === locator.PAYMENT_TAG_SELECTOR) {
      return this.dataTid === "m4b_tag";
    }
    if (selector === locator.VARIATION_LABEL_SELECTOR) {
      return this.tagName === "SPAN";
    }
    throw new Error(`Unexpected selector: ${selector}`);
  }

  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  contains(candidate) {
    for (let node = candidate; node; node = node.parentNode) {
      if (node === this) return true;
    }
    return false;
  }
}

function createDashboard(rows) {
  const root = new Element({ dataTid: "m4b_space" });
  for (const { variationNumber, badgeText, retryDetail = null, soldPrice = "48.00" } of rows) {
    const row = new Element().append(
      new Element({ text: `Synthetic Buyer has won: $${soldPrice} ` }),
      new Element({ tagName: "SPAN", text: `Variation: #${variationNumber}` }),
      new Element({ text: " " }),
      new Element({ dataTid: "m4b_tag", text: badgeText }),
    );
    if (retryDetail !== null) row.append(new Element({ text: ` ${retryDetail}` }));
    root.append(row);
  }
  return new Element().append(root);
}

function createHarness(initialState = reconciliation.createReconciliationState(INVENTORY)) {
  const values = {
    [reconciliationStorage.STORAGE_KEY]: {
      schemaVersion: reconciliationStorage.STORAGE_SCHEMA_VERSION,
      reconciliationState: clone(initialState),
    },
  };
  const writes = [];
  const messages = [];
  const storageArea = {
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
    },
    async set(items) {
      writes.push(clone(items));
      Object.assign(values, clone(items));
    },
  };
  const activeSession = streamSession.createStreamSessionState();
  streamSession.startStream(activeSession, {
    streamId: STREAM_ID,
    startedAt: STARTED_AT,
    identitySource: streamSession.IDENTITY_SOURCES.LOCAL_SESSION,
  });

  function open() {
    const stateStore = reconciliationStorage.createReconciliationStateStore({
      storageArea,
      reconciliation,
    });
    const stateCoordinator = reconciliationCoordinator.createReconciliationCoordinator({
      reconciliation,
      stateStore,
    });
    const integration = captureIntegration.createCaptureIntegration({
      activeStreamCoordinator: {
        async dispatch() {
          return { state: clone(activeSession), result: null };
        },
      },
      captureProtocol,
      reconciliationCoordinator,
      stateCoordinator,
      streamSession,
      streamSessionCoordinator,
    });
    const client = captureClient.createCaptureClient({
      protocol: captureProtocol,
      runtime: {
        async sendMessage(message) {
          messages.push(clone(message));
          const event = captureProtocol.validateCaptureMessage(message);
          return { ok: true, data: await integration.dispatch(event) };
        },
      },
    });
    const reports = streamReportCoordinator.createStreamReportCoordinator({
      now: () => ENDED_AT,
      protocol: streamReportProtocol,
      reconciliation,
      reportStore: streamReportStorage.createStreamReportStore({ storageArea, streamReport }),
      storage: streamReportStorage,
      streamReport,
    });

    async function getState() {
      return (await stateCoordinator.dispatch({
        type: reconciliationCoordinator.COMMAND_TYPES.GET_STATE,
      })).state;
    }

    return {
      getState,
      reports,
      async map(variationNumber) {
        await stateCoordinator.dispatch({
          type: reconciliationCoordinator.COMMAND_TYPES.MAP_VARIATION,
          streamId: STREAM_ID,
          variationNumber,
          sku: INVENTORY[0].sku,
        });
      },
      async scan(rows) {
        const locatedRoot = locator.locateUniqueVisibleSoldItemsRoot(createDashboard(rows));
        assert.equal(locatedRoot.status, "found");
        const root = locatedRoot.root;
        const located = locator.locatePaymentStatuses(root, parser);
        assert.equal(located.length, rows.length, "every synthetic row must be associated");
        const variations = locator.locateObservedVariations(root)
          .map(({ variationNumber }) => variationNumber);
        const statuses = located.filter((entry) =>
          entry.observedPaymentStatus !== "payment_complete" || entry.soldPriceCents === null)
          .map(({ variationNumber, observedPaymentStatus }) => ({
            variationNumber,
            observedPaymentStatus,
          }));

        // Mirror content.js: detached variations, non-priced statuses, then
        // strict positive-price completions through the actual capture client.
        if (variations.length) await client.observeVariations(variations);
        if (statuses.length) await client.observePaymentStatuses(statuses);
        for (const entry of located) {
          if (entry.observedPaymentStatus === "payment_complete" && entry.soldPriceCents !== null) {
            await client.recordPaymentComplete({
              variationNumber: entry.variationNumber,
              soldPriceCents: entry.soldPriceCents,
            });
          }
        }
        return located.map(({ variationNumber, observedPaymentStatus }) => ({
          variationNumber,
          observedPaymentStatus,
        }));
      },
      async saveReport() {
        const prepared = await reports.prepareReport({
          streamId: STREAM_ID,
          startedAt: STARTED_AT,
          reconciliationState: await getState(),
        });
        return reports.finalizeReport(prepared.reportId);
      },
    };
  }

  return { open, messages, writes };
}

function auction(state, variationNumber = 1) {
  return reconciliation.getAuction(state, { streamId: STREAM_ID, variationNumber });
}

function manualOrders(state) {
  return reconciliation.listPaymentFixingOrders(state, { streamId: STREAM_ID });
}

function summary(state) {
  return reconciliation.calculateSummary(state, { streamId: STREAM_ID });
}

for (const mapped of [false, true]) {
  test(`fresh plain Payment failed automatically cancels ${mapped ? "a mapped" : "an unmapped"} order through capture, storage, and report`, async () => {
    const harness = createHarness();
    const session = harness.open();
    await session.scan([{ variationNumber: 1, badgeText: "Payment processing..." }]);
    if (mapped) await session.map(1);
    const pending = await session.getState();
    assert.equal(manualOrders(pending).length, 1);
    assert.equal(summary(pending).inventory[0].reservedQuantity, mapped ? 1 : 0);

    assert.deepEqual(await session.scan([{ variationNumber: 1, badgeText: "Payment failed" }]), [
      { variationNumber: 1, observedPaymentStatus: "canceled" },
    ]);
    const canceledState = await session.getState();
    const canceled = auction(canceledState);
    assert.equal(canceled.paymentStatus, "canceled");
    assert.equal(canceled.observedPaymentStatus, "canceled");
    assert.equal(canceled.mappingStatus, mapped ? "mapped" : "unmapped");
    assert.equal(canceled.sku, mapped ? INVENTORY[0].sku : null);
    assert.equal(canceled.soldPriceCents, null);
    assert.equal(canceled.committedUnitCostCents, null);
    assert.equal(canceled.profitCents, null);
    assert.equal(canceled.committed, false);
    assert.deepEqual(manualOrders(canceledState), []);
    const canceledSummary = summary(canceledState);
    assert.equal(canceledSummary.inventory[0].reservedQuantity, 0);
    assert.equal(canceledSummary.inventory[0].remainingQuantity, 5);
    assert.equal(canceledSummary.inventory[0].soldQuantity, 0);
    for (const key of ["completedGmvCents", "committedRevenueCents", "costOfGoodsCents", "profitCents"]) {
      assert.equal(canceledSummary.totals[key], 0, key);
    }
    assert.equal(canceledSummary.totals.canceledOrderCount, 1);
    assert.equal(canceledSummary.totals.totalSalesCount, 1);

    const writeCount = harness.writes.length;
    await session.scan([{ variationNumber: 1, badgeText: "Payment failed" }]);
    assert.deepEqual(await session.getState(), canceledState);
    assert.equal(harness.writes.length, writeCount, "duplicate cancellation does not save twice");

    const record = await session.saveReport();
    assert.equal(record.report.totals.canceledOrderCount, 1);
    assert.equal(record.report.totals.paymentFixingCount, 0);
    assert.equal(record.report.totals.unresolvedOrderCount, 0);
    assert.deepEqual(record.report.completedSales, []);
    assert.equal(record.report.canceledOrders.length, 1);
    assert.equal(record.report.canceledOrders[0].mapped, mapped);
    assert.equal(record.report.canceledOrders[0].sku, mapped ? INVENTORY[0].sku : null);
    for (const key of ["completedGmvCents", "committedRevenueCents", "costOfGoodsCents", "grossProfitCents"]) {
      assert.equal(record.report.totals[key], 0, key);
    }
    assert.ok(!record.report.completeness.reasonCodes.includes("payment_fixing_orders"));
    assert.ok(!record.report.completeness.reasonCodes.includes("unresolved_orders"));

    const reopened = harness.open();
    assert.deepEqual(await reopened.getState(), canceledState);
    assert.deepEqual(manualOrders(await reopened.getState()), []);
    assert.deepEqual(await reopened.reports.getReport(record.reportId), record);
    assert.doesNotMatch(JSON.stringify(harness.messages), /Synthetic Buyer|has won|badgeText|m4b_tag/);
  });
}

test("processing badges with either ellipsis remain unresolved through a later report and storage reopen", async () => {
  const harness = createHarness();
  const session = harness.open();
  const badgeTexts = [
    "Payment processing", "Payment processing...", "Payment processing\u2026",
    "Order processing", "Order processing...", "Order processing\u2026",
  ];
  const rows = badgeTexts.map((badgeText, index) => ({ variationNumber: index + 1, badgeText }));
  await session.scan(rows);
  await session.map(1);
  const state = await session.getState();
  for (let index = 0; index < rows.length; index += 1) {
    assert.equal(auction(state, index + 1).paymentStatus, "unknown");
    assert.equal(auction(state, index + 1).observedPaymentStatus,
      index < 3 ? "payment_processing" : "order_processing");
  }
  assert.equal(manualOrders(state).length, 6);
  assert.equal(summary(state).inventory[0].reservedQuantity, 1);
  const record = await session.saveReport();
  assert.equal(record.report.totals.paymentFixingCount, 6);
  assert.equal(record.report.totals.canceledOrderCount, 0);
  assert.equal(record.report.totals.unresolvedOrderCount, 6);
  assert.deepEqual(record.report.canceledOrders, []);
  assert.deepEqual(await harness.open().getState(), state);
});

test("saved internal payment_failed is not migrated to canceled until that variation is freshly observed as plain Payment failed", async () => {
  const oldState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.observePaymentStatuses(oldState, {
    streamId: STREAM_ID,
    statuses: [1, 2].map((variationNumber) => ({
      variationNumber,
      observedPaymentStatus: "payment_failed",
    })),
  });
  const harness = createHarness(oldState);
  const session = harness.open();
  assert.deepEqual(await session.getState(), oldState);
  assert.equal(manualOrders(await session.getState()).length, 2);
  assert.equal(harness.writes.length, 0, "loading old data must not silently cancel it");
  const reopened = harness.open();
  assert.deepEqual(await reopened.getState(), oldState);
  await reopened.scan([{ variationNumber: 1, badgeText: "Payment failed" }]);
  const updated = await reopened.getState();
  assert.equal(auction(updated, 1).paymentStatus, "canceled");
  assert.equal(auction(updated, 2).paymentStatus, "unknown");
  assert.equal(auction(updated, 2).observedPaymentStatus, "payment_failed");
  assert.deepEqual(manualOrders(updated).map((order) => order.variationNumber), [2]);
  const record = await reopened.saveReport();
  assert.equal(record.report.totals.canceledOrderCount, 1);
  assert.equal(record.report.totals.paymentFixingCount, 1);
  assert.deepEqual(record.report.canceledOrders.map((order) => order.variationNumber), [1]);
  assert.deepEqual(await harness.open().getState(), updated);
});

test("reopening an existing report with legacy payment_failed neither reclassifies it nor writes storage", async () => {
  const oldState = reconciliation.createReconciliationState(INVENTORY);
  reconciliation.observePaymentStatuses(oldState, {
    streamId: STREAM_ID,
    statuses: [{ variationNumber: 1, observedPaymentStatus: "payment_failed" }],
  });
  const harness = createHarness(oldState);
  const saved = await harness.open().saveReport();
  assert.equal(saved.lifecycleStatus, "finalized");
  assert.equal(saved.report.totals.paymentFixingCount, 1);
  assert.equal(saved.report.totals.unresolvedOrderCount, 1);
  assert.equal(saved.report.totals.canceledOrderCount, 0);
  assert.deepEqual(saved.report.canceledOrders, []);
  assert.ok(saved.report.completeness.reasonCodes.includes("payment_fixing_orders"));

  const writesBeforeReopen = harness.writes.length;
  const reopened = harness.open();
  const reopenedState = await reopened.getState();
  assert.deepEqual(reopenedState, oldState);
  assert.equal(auction(reopenedState).paymentStatus, "unknown");
  assert.equal(auction(reopenedState).observedPaymentStatus, "payment_failed");
  assert.equal(manualOrders(reopenedState).length, 1);
  assert.deepEqual(await reopened.reports.getReport(saved.reportId), saved);
  assert.equal(harness.writes.length, writesBeforeReopen,
    "opening legacy state and report must not silently persist a cancellation");
  assert.deepEqual(harness.messages, [], "no fresh dashboard observation was supplied");
});

test("a failed badge with a legacy retry indicator stays unresolved until a fresh row no longer has that indicator", async () => {
  const harness = createHarness();
  const session = harness.open();
  for (const countdown of ["04:42", "00:00"]) {
    assert.deepEqual(await session.scan([{
      variationNumber: 1,
      badgeText: "Payment failed",
      retryDetail: `Transaction will cancel in ${countdown}`,
    }]), [{ variationNumber: 1, observedPaymentStatus: "payment_failed" }]);
    const state = await session.getState();
    assert.equal(auction(state).paymentStatus, "unknown");
    assert.equal(manualOrders(state).length, 1);
    assert.equal(summary(state).totals.canceledOrderCount, 0);
  }
  await session.map(1);
  assert.equal(summary(await session.getState()).inventory[0].reservedQuantity, 1);

  const reopened = harness.open();
  assert.equal(manualOrders(await reopened.getState()).length, 1);
  await reopened.scan([{ variationNumber: 1, badgeText: "Payment failed" }]);
  const canceled = await reopened.getState();
  assert.equal(auction(canceled).paymentStatus, "canceled");
  assert.equal(auction(canceled).sku, INVENTORY[0].sku);
  assert.equal(summary(canceled).inventory[0].reservedQuantity, 0);
  assert.deepEqual(manualOrders(canceled), []);
  const record = await reopened.saveReport();
  assert.equal(record.report.totals.paymentFixingCount, 0);
  assert.equal(record.report.totals.canceledOrderCount, 1);
});

test("plain failed observations preserve an already completed sale and later completions preserve a canceled order", async () => {
  const harness = createHarness();
  const session = harness.open();
  await session.scan([{ variationNumber: 1, badgeText: "Payment processing" }]);
  await session.map(1);
  await session.scan([{ variationNumber: 1, badgeText: "Payment complete" }]);
  const completedState = await session.getState();
  const writesBeforeStaleFailure = harness.writes.length;
  await session.scan([{ variationNumber: 1, badgeText: "Payment failed" }]);
  assert.deepEqual(await session.getState(), completedState);
  assert.equal(harness.writes.length, writesBeforeStaleFailure);
  assert.equal(auction(completedState).paymentStatus, "payment_complete");
  assert.equal(auction(completedState).soldPriceCents, 4800);
  assert.equal(auction(completedState).committedUnitCostCents, 1200);

  await session.scan([{ variationNumber: 2, badgeText: "Payment failed" }]);
  const canceledState = await session.getState();
  const writesBeforeStaleCompletion = harness.writes.length;
  await session.scan([{ variationNumber: 2, badgeText: "Payment complete" }]);
  assert.deepEqual(await session.getState(), canceledState);
  assert.equal(harness.writes.length, writesBeforeStaleCompletion);
  assert.deepEqual(manualOrders(canceledState), []);
  const record = await session.saveReport();
  assert.equal(record.report.totals.completedPaymentCount, 1);
  assert.equal(record.report.totals.canceledOrderCount, 1);
  assert.equal(record.report.totals.paymentFixingCount, 0);
  assert.equal(record.report.totals.completedGmvCents, 4800);
  assert.equal(record.report.totals.costOfGoodsCents, 1200);
  assert.equal(record.report.totals.grossProfitCents, 3600);
  assert.deepEqual(record.report.completedSales.map((sale) => sale.variationNumber), [1]);
  assert.deepEqual(record.report.canceledOrders.map((order) => order.variationNumber), [2]);
});
