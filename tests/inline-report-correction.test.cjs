const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");
const realClientModule = require(
  "../extension/report/offline-report-editor-client.js",
);
const inlineCorrection = require(
  "../extension/report/inline-report-correction.js",
);

const REPORT_ID =
  "stream-report:11111111-1111-4111-8111-111111111111";
const SECOND_REPORT_ID =
  "stream-report:22222222-2222-4222-8222-222222222222";

const CORRECTION_SELECTORS = [
  "#mapping-correction-section",
  "#mapping-correction-disclosure",
  "#mapping-correction-fields",
  "#mapping-correction-availability",
  "#mapping-variation",
  "#mapping-item-group",
  "#mapping-sku-field",
  "#mapping-sku",
  "#mapping-variation-status",
  "#mapping-sold-price",
  "#mapping-original",
  "#mapping-selected",
  "#reset-mapping-original",
  "#mapping-correction-feedback",
  "#save-mapping-correction",
];

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toLocaleLowerCase("en-US");
    this.children = [];
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = "";
    this.title = "";
    this.dataset = {};
    this.className = "";
    this.attributes = new Map();
    this.listeners = new Map();
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  dispatch(name, event = {}) {
    const listener = this.listeners.get(name);

    if (!listener) {
      return Promise.resolve();
    }

    return Promise.resolve(listener({
      currentTarget: this,
      target: this,
      ...event,
    }));
  }

  click() {
    return this.disabled ? Promise.resolve() : this.dispatch("click");
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map(
      CORRECTION_SELECTORS.map((selector) => [selector, new FakeElement()]),
    );
    this.createdTags = [];
    this.querySelector("#mapping-correction-section").hidden = true;
    this.querySelector("#mapping-correction-fields").disabled = true;
    this.querySelector("#mapping-sku-field").hidden = true;
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  createElement(tagName) {
    this.createdTags.push(tagName.toLocaleLowerCase("en-US"));
    return new FakeElement(tagName);
  }
}

function createInventoryEntry(overrides = {}) {
  const openingQuantity = overrides.openingQuantity ?? 3;
  const streamSoldQuantity = overrides.streamSoldQuantity ?? 0;
  const baselineSoldQuantity = overrides.baselineSoldQuantity ??
    streamSoldQuantity;
  const pendingQuantity = overrides.pendingQuantity ?? 0;
  const calculatedRemainingQuantity =
    openingQuantity - baselineSoldQuantity;
  const oversoldQuantity = Math.max(
    0,
    baselineSoldQuantity + pendingQuantity - openingQuantity,
  );

  return {
    sku: overrides.sku ?? "BAG-OS",
    item: overrides.item ?? "Canvas Bag",
    style: overrides.style ?? "natural",
    size: overrides.size ?? "OS",
    unitCostCents: overrides.unitCostCents ?? 300,
    openingQuantity,
    streamSoldQuantity,
    baselineSoldQuantity,
    pendingQuantity,
    calculatedRemainingQuantity,
    replacementQuantity: Math.max(0, calculatedRemainingQuantity),
    availableAfterReservationsQuantity: Math.max(
      0,
      calculatedRemainingQuantity - pendingQuantity,
    ),
    oversoldQuantity,
    requiresRecount: oversoldQuantity > 0,
  };
}

function createEditorData(overrides = {}) {
  const base = {
    reportId: REPORT_ID,
    displayName: "Saturday stream",
    endedAt: "2026-08-29T20:00:00.000Z",
    eligibility: { status: "editable", code: null, reason: null },
    canceledDetailsAvailable: true,
    completedVariations: [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "SHOE-8",
        soldPriceCents: 2000,
      },
      {
        variationNumber: 11,
        expectedStatus: "payment_complete",
        expectedSku: null,
        soldPriceCents: 1500,
      },
    ],
    canceledVariations: [
      {
        variationNumber: 12,
        expectedStatus: "canceled",
        expectedSku: "SHOE-7",
      },
    ],
    inventory: [
      createInventoryEntry(),
      createInventoryEntry({
        sku: "SHOE-7",
        item: "Yeezy Slide",
        style: "black",
        size: "7",
        unitCostCents: 500,
        openingQuantity: 2,
      }),
      createInventoryEntry({
        sku: "SHOE-8",
        item: "Yeezy Slide",
        style: "black",
        size: "8",
        unitCostCents: 500,
        openingQuantity: 1,
        streamSoldQuantity: 1,
        baselineSoldQuantity: 1,
      }),
      createInventoryEntry({
        sku: "SHOE-10",
        item: "Yeezy Slide",
        style: "black",
        size: "10",
        unitCostCents: 500,
        openingQuantity: 0,
        baselineSoldQuantity: 1,
      }),
      createInventoryEntry({
        sku: "SHOE-WHITE-8",
        item: "Yeezy Slide",
        style: "white",
        size: "8",
        unitCostCents: 500,
      }),
    ],
  };

  return { ...base, ...overrides };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function withSavedMapping(data, change) {
  const corrected = clone(data);
  const collection = change.expectedStatus === "payment_complete"
    ? corrected.completedVariations
    : corrected.canceledVariations;
  const variation = collection.find(
    (entry) => entry.variationNumber === change.variationNumber,
  );
  variation.expectedSku = change.sku;
  return corrected;
}

function createHarness(options = {}) {
  const document = new FakeDocument();
  const data = options.data ?? createEditorData();
  const loads = [];
  const saves = [];
  const confirmations = [];
  const savedEvents = [];
  const statuses = [];
  const client = options.client ?? {
    async loadEditorData(input) {
      loads.push(clone(input));
      return clone(data);
    },
    async saveMappingCorrections(input) {
      saves.push(clone(input));
      return withSavedMapping(data, input.changes[0]);
    },
  };
  const controller = inlineCorrection.createInlineReportCorrectionController({
    document,
    client,
    confirm(message) {
      confirmations.push(message);
      return options.confirmResult ?? true;
    },
    async onSaved(event) {
      savedEvents.push(clone(event));
      return options.onSaved?.(event);
    },
    onStatus(message) {
      statuses.push(message);
    },
  });

  return {
    client,
    confirmations,
    controller,
    data,
    document,
    loads,
    saves,
    savedEvents,
    statuses,
  };
}

function findOption(select, pattern) {
  return select.children.find((option) => pattern.test(option.textContent));
}

async function selectVariation(document, variationNumber) {
  const select = document.querySelector("#mapping-variation");
  select.value = String(variationNumber);
  await select.dispatch("change");
}

async function selectTarget(document, data, sku) {
  const itemGroup = document.querySelector("#mapping-item-group");

  if (sku === null) {
    itemGroup.value = inlineCorrection.UNMAPPED_GROUP_VALUE;
    await itemGroup.dispatch("change");
    return;
  }

  const groups = inlineCorrection.groupInventoryEntries(data.inventory);
  const group = groups.find((candidate) =>
    candidate.entries.some((entry) => entry.sku === sku));
  assert.ok(group, `Expected an inventory group for ${sku}.`);
  itemGroup.value = group.key;
  await itemGroup.dispatch("change");

  if (group.entries.length > 1) {
    const skuSelect = document.querySelector("#mapping-sku");
    skuSelect.value = sku;
    await skuSelect.dispatch("change");
  }
}

test("inline correction follows inventory, precedes variations, and is print-hidden", () => {
  const reportRoot = path.join(__dirname, "..", "extension", "report");
  const html = fs.readFileSync(path.join(reportRoot, "report.html"), "utf8");
  const css = fs.readFileSync(path.join(reportRoot, "report.css"), "utf8");
  const inventoryStart = html.indexOf("inventory-update-section");
  const inventoryEnd = html.indexOf("</section>", inventoryStart) +
    "</section>".length;
  const correctionStart = html.indexOf(
    'id="mapping-correction-section"',
  );
  const correctionSectionStart = html.lastIndexOf("<section", correctionStart);
  const correctionEnd = html.indexOf("</section>", correctionStart) +
    "</section>".length;
  const variationsStart = html.indexOf('id="completed-sales-disclosure"');
  const variationsSectionStart = html.lastIndexOf(
    "<section",
    variationsStart,
  );
  const unitCostStart = html.indexOf('id="unit-cost-correction-section"');
  const footerStart = html.indexOf('<footer class="report-footer">');

  assert.ok(inventoryStart >= 0);
  assert.ok(correctionStart > inventoryStart);
  assert.ok(variationsStart > correctionStart);
  assert.ok(unitCostStart > variationsStart);
  assert.ok(footerStart > unitCostStart);
  assert.equal(html.slice(inventoryEnd, correctionSectionStart).trim(), "");
  assert.equal(html.slice(correctionEnd, variationsSectionStart).trim(), "");
  assert.match(
    html.slice(inventoryStart, variationsStart),
    /class="report-section mapping-correction-section screen-only"/,
  );
  assert.match(html, />Correct Item Mapping</);
  assert.doesNotMatch(
    html,
    /Correct one completed or canceled variation|mapping-inventory-quantity/,
  );
  assert.match(html, /<details id="mapping-correction-disclosure">/);
  assert.match(html, /for="mapping-variation"[\s\S]*?<select/);
  assert.match(html, /for="mapping-item-group"[\s\S]*?<select/);
  assert.match(html, /for="mapping-sku"[\s\S]*?<select/);
  assert.doesNotMatch(html, /mapping-current|Current durable mapping/);
  assert.match(
    html,
    /id="mapping-selected"[\s\S]*?id="reset-mapping-original"[\s\S]*?>Reset to original<\/button>/,
  );
  assert.match(
    html,
    /id="reset-mapping-original"[\s\S]*?type="button"[\s\S]*?disabled/,
  );
  assert.match(
    html,
    /id="mapping-correction-feedback"[\s\S]*?class="mapping-correction-feedback visually-hidden"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
  );
  assert.doesNotMatch(html, /mapping-reference-note/);
  assert.match(
    html,
    new RegExp([
      "stream-report-client\\.js[\\s\\S]*?",
      "offline-report-editor-client\\.js[\\s\\S]*?",
      "inline-report-correction\\.js[\\s\\S]*?report-page\\.js",
    ].join("")),
  );
  assert.match(
    css.slice(css.indexOf("@media print")),
    /\.screen-only,[\s\S]*?display:\s*none !important/,
  );
  assert.match(
    css,
    /\.mapping-reset-action\s*\{[\s\S]*?background:\s*var\(--blue\)/,
  );
  assert.match(
    css,
    /\.mapping-reset-action:disabled\s*\{[\s\S]*?background:\s*var\(--surface-raised\)/,
  );
  assert.doesNotMatch(html, /Edit in Offline Tracker/);
  assert.doesNotMatch(
    html,
    /offline-editor-(?:page|action)|offline-editor\.(?:html|css)/,
  );
  assert.equal(fs.existsSync(path.join(reportRoot, "offline-editor.html")), false);
  assert.equal(fs.existsSync(path.join(reportRoot, "offline-editor.css")), false);
  assert.equal(
    fs.existsSync(path.join(reportRoot, "offline-editor-page.js")),
    false,
  );
});

test("load renders combined variation labels and exact Item plus Style groups", async () => {
  const harness = createHarness();
  await harness.controller.load(REPORT_ID);

  const { document } = harness;
  const variation = document.querySelector("#mapping-variation");
  const itemGroup = document.querySelector("#mapping-item-group");
  const availability = document.querySelector(
    "#mapping-correction-availability",
  );
  assert.deepEqual(harness.loads, [{ reportId: REPORT_ID }]);
  assert.equal(document.querySelector("#mapping-correction-section").hidden, false);
  assert.equal(
    document.querySelector("#mapping-correction-disclosure").open,
    false,
  );
  assert.equal(availability.hidden, true);
  assert.equal(availability.textContent, "");
  assert.equal(
    document.querySelector("#mapping-correction-feedback").textContent,
    "",
  );
  document.querySelector("#mapping-correction-disclosure").open = true;
  assert.equal(availability.hidden, true);
  assert.equal(variation.children.length, 3);
  assert.match(variation.children[0].textContent, /Variation #10/);
  assert.match(variation.children[0].textContent, /Payment complete/);
  assert.match(variation.children[0].textContent, /\$20\.00/);
  assert.match(variation.children[0].textContent, /SHOE-8/);
  assert.match(variation.children[1].textContent, /Variation #11/);
  assert.match(variation.children[1].textContent, /Unmapped/);
  assert.match(variation.children[2].textContent, /Variation #12/);
  assert.match(variation.children[2].textContent, /Canceled/);
  assert.doesNotMatch(variation.children[2].textContent, /\$\d/);
  assert.equal(itemGroup.children.length, 4);
  assert.equal(itemGroup.children[0].textContent, "Unmapped");
  assert.ok(findOption(itemGroup, /Canvas Bag.*natural/));
  assert.ok(findOption(itemGroup, /Yeezy Slide.*black.*3 sizes \/ SKUs/));
  assert.ok(findOption(itemGroup, /Yeezy Slide.*white.*SHOE-WHITE-8/));
});

test("availability is visible while loading and hidden once editable", async () => {
  const data = createEditorData();
  const pending = createDeferred();
  const harness = createHarness({
    client: {
      loadEditorData() {
        return pending.promise;
      },
      async saveMappingCorrections() {
        throw new Error("This test does not save corrections.");
      },
    },
    data,
  });
  const availability = harness.document.querySelector(
    "#mapping-correction-availability",
  );
  const loading = harness.controller.load(REPORT_ID);

  assert.equal(availability.hidden, false);
  assert.equal(availability.textContent, "Checking availability…");
  assert.equal(availability.dataset.state, "loading");

  pending.resolve(clone(data));
  await loading;

  assert.equal(availability.hidden, true);
  assert.equal(availability.textContent, "");
  assert.equal(availability.dataset.state, "editable");
});

test("legacy data keeps completed corrections editable without canceled rows", async () => {
  const data = createEditorData({
    canceledDetailsAvailable: false,
    canceledVariations: [],
  });
  const harness = createHarness({ data });

  await harness.controller.load(REPORT_ID);

  const variation = harness.document.querySelector("#mapping-variation");
  const fields = harness.document.querySelector("#mapping-correction-fields");
  assert.equal(harness.controller.getState().eligibilityStatus, "editable");
  assert.equal(fields.disabled, false);
  assert.equal(variation.children.length, 2);
  assert.ok(variation.children.every((option) =>
    /Payment complete/.test(option.textContent)));
  assert.ok(variation.children.every((option) =>
    !/Canceled/.test(option.textContent)));

  await selectVariation(harness.document, 11);
  assert.equal(
    harness.document.querySelector("#mapping-correction-feedback").textContent,
    "",
  );
  await selectTarget(harness.document, data, "BAG-OS");
  assert.equal(
    harness.document.querySelector("#save-mapping-correction").disabled,
    false,
  );
});

test("same-report refresh preserves a draft while a new report resets it", async () => {
  const firstData = createEditorData();
  const secondData = createEditorData({
    reportId: SECOND_REPORT_ID,
    completedVariations: [
      {
        variationNumber: 10,
        expectedStatus: "payment_complete",
        expectedSku: "BAG-OS",
        soldPriceCents: 2000,
      },
    ],
    canceledVariations: [],
  });
  const client = {
    async loadEditorData({ reportId }) {
      return clone(reportId === REPORT_ID ? firstData : secondData);
    },
    async saveMappingCorrections() {
      throw new Error("This test does not save corrections.");
    },
  };
  const harness = createHarness({ client, data: firstData });

  await harness.controller.load(REPORT_ID);
  await selectTarget(harness.document, firstData, "SHOE-10");
  await harness.controller.load(REPORT_ID, { preserveDraft: true });
  assert.equal(harness.controller.getState().selectedSku, "SHOE-10");
  assert.match(
    harness.document.querySelector("#mapping-original").textContent,
    /SHOE-8/,
  );

  await harness.controller.load(SECOND_REPORT_ID, { preserveDraft: true });
  assert.equal(harness.controller.getState().reportId, SECOND_REPORT_ID);
  assert.equal(harness.controller.getState().selectedSku, "BAG-OS");
  assert.match(
    harness.document.querySelector("#mapping-original").textContent,
    /BAG-OS/,
  );
  assert.doesNotMatch(
    harness.document.querySelector("#mapping-original").textContent,
    /SHOE-8/,
  );
});

test("a late load cannot replace a newer report's correction state", async () => {
  const firstLoad = createDeferred();
  const secondLoad = createDeferred();
  const firstData = createEditorData();
  const secondData = createEditorData({
    reportId: SECOND_REPORT_ID,
    completedVariations: [{
      variationNumber: 20,
      expectedStatus: "payment_complete",
      expectedSku: "BAG-OS",
      soldPriceCents: 2500,
    }],
    canceledVariations: [],
  });
  const client = {
    loadEditorData({ reportId }) {
      return reportId === REPORT_ID
        ? firstLoad.promise
        : secondLoad.promise;
    },
    async saveMappingCorrections() {
      throw new Error("This test does not save corrections.");
    },
  };
  const harness = createHarness({ client, data: firstData });
  const older = harness.controller.load(REPORT_ID);
  const newer = harness.controller.load(SECOND_REPORT_ID);

  secondLoad.resolve(clone(secondData));
  await newer;
  firstLoad.resolve(clone(firstData));
  await older;

  assert.equal(harness.controller.getState().reportId, SECOND_REPORT_ID);
  assert.equal(harness.controller.getState().selectedVariationNumber, 20);
  assert.equal(harness.controller.getState().selectedSku, "BAG-OS");
  assert.equal(
    harness.document.querySelector("#mapping-variation").children.length,
    1,
  );
  assert.match(
    harness.document.querySelector("#mapping-variation").children[0]
      .textContent,
    /Variation #20/,
  );
});

test("destroy permanently disables the controller without new commands", async () => {
  const harness = createHarness();
  await harness.controller.load(REPORT_ID);
  await selectTarget(harness.document, harness.data, "SHOE-10");
  const loadCount = harness.loads.length;

  harness.controller.destroy();
  await harness.document.querySelector("#mapping-variation").dispatch(
    "change",
  );
  await harness.document.querySelector("#mapping-item-group").dispatch(
    "change",
  );
  await harness.document.querySelector("#mapping-sku").dispatch("change");
  await harness.document.querySelector("#reset-mapping-original").click();
  await harness.document.querySelector("#save-mapping-correction").click();
  await harness.controller.load(REPORT_ID);
  await harness.controller.save();
  harness.controller.destroy();

  assert.equal(harness.loads.length, loadCount);
  assert.deepEqual(harness.saves, []);
  assert.equal(harness.controller.getState().eligibilityStatus, "unavailable");
  assert.equal(
    harness.document.querySelector("#mapping-correction-availability")
      .dataset.state,
    "unavailable",
  );
  assert.equal(
    harness.document.querySelector("#mapping-correction-fields").disabled,
    true,
  );
  assert.equal(
    harness.document.querySelector("#reset-mapping-original").disabled,
    true,
  );
  assert.match(
    harness.document.querySelector("#mapping-correction-feedback").textContent,
    /report view was closed/,
  );
});

test("multi-size selection resets to the exact original SKU without saving", async () => {
  const harness = createHarness();
  await harness.controller.load(REPORT_ID);
  const { document } = harness;
  const save = document.querySelector("#save-mapping-correction");
  const reset = document.querySelector("#reset-mapping-original");

  assert.match(document.querySelector("#mapping-original").textContent, /SHOE-8/);
  assert.match(document.querySelector("#mapping-selected").textContent, /SHOE-8/);
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
  await save.click();
  assert.equal(harness.saves.length, 0);
  await selectTarget(document, harness.data, "SHOE-10");
  assert.equal(
    document.querySelector("#mapping-correction-feedback").textContent,
    "",
  );
  assert.equal(reset.disabled, false);
  await reset.click();
  assert.match(document.querySelector("#mapping-selected").textContent, /SHOE-8/);
  assert.equal(document.querySelector("#mapping-sku").value, "SHOE-8");
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
  assert.equal(harness.saves.length, 0);
  await selectTarget(document, harness.data, "SHOE-10");

  const sku = document.querySelector("#mapping-sku");
  assert.equal(document.querySelector("#mapping-sku-field").hidden, false);
  assert.deepEqual(
    sku.children.slice(1).map((option) => option.value),
    ["SHOE-7", "SHOE-8", "SHOE-10"],
  );
  assert.match(findOption(sku, /Size 10.*SHOE-10/).textContent, /SHOE-10/);
  assert.match(document.querySelector("#mapping-original").textContent, /SHOE-8/);
  assert.match(document.querySelector("#mapping-selected").textContent, /SHOE-10/);
  assert.equal(save.disabled, false);
  assert.equal(reset.disabled, false);
  assert.equal(harness.saves.length, 0);
});

test("one-change saves map, remap, and unmap with stale-safe expected fields", async (t) => {
  const cases = [
    {
      name: "remap a completed variation",
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "SHOE-8",
      sku: "SHOE-10",
    },
    {
      name: "map an unmapped completed variation",
      variationNumber: 11,
      expectedStatus: "payment_complete",
      expectedSku: null,
      sku: "BAG-OS",
    },
    {
      name: "unmap a completed variation",
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "SHOE-8",
      sku: null,
    },
  ];

  for (const expected of cases) {
    await t.test(expected.name, async () => {
      const harness = createHarness();
      await harness.controller.load(REPORT_ID);
      await selectVariation(harness.document, expected.variationNumber);
      await selectTarget(harness.document, harness.data, expected.sku);
      const reset = harness.document.querySelector("#reset-mapping-original");
      assert.equal(
        reset.disabled,
        expected.expectedSku === null,
      );
      assert.equal(harness.saves.length, 0);
      await harness.document.querySelector("#save-mapping-correction").click();

      assert.deepEqual(harness.saves, [{
        reportId: REPORT_ID,
        changes: [{
          variationNumber: expected.variationNumber,
          expectedStatus: expected.expectedStatus,
          expectedSku: expected.expectedSku,
          sku: expected.sku,
        }],
      }]);
      assert.equal(harness.savedEvents.length, 1);
      assert.equal(harness.confirmations.length, 0);
      assert.equal(
        harness.document.querySelector("#save-mapping-correction").disabled,
        true,
      );
      const original = harness.document.querySelector(
        "#mapping-original",
      ).textContent;
      const selected = harness.document.querySelector(
        "#mapping-selected",
      ).textContent;
      if (expected.expectedSku === null) {
        assert.equal(original, "Unmapped");
      } else {
        assert.match(original, new RegExp(expected.expectedSku));
      }
      if (expected.sku === null) {
        assert.equal(selected, "Unmapped");
      } else {
        assert.match(selected, new RegExp(expected.sku));
      }
      assert.equal(reset.disabled, expected.expectedSku === null);
    });
  }
});

test("a saved remap resets durably in one click", async () => {
  const harness = createHarness();
  const { document } = harness;
  const save = document.querySelector("#save-mapping-correction");
  const reset = document.querySelector("#reset-mapping-original");

  await harness.controller.load(REPORT_ID);
  await selectTarget(document, harness.data, "SHOE-10");
  await save.click();

  assert.equal(harness.saves.length, 1);
  assert.equal(reset.disabled, false);
  assert.match(document.querySelector("#mapping-original").textContent, /SHOE-8/);
  assert.match(document.querySelector("#mapping-selected").textContent, /SHOE-10/);

  await reset.click();

  assert.equal(harness.saves.length, 2);
  assert.deepEqual(harness.saves[1].changes, [{
    variationNumber: 10,
    expectedStatus: "payment_complete",
    expectedSku: "SHOE-10",
    sku: "SHOE-8",
  }]);
  assert.equal(harness.savedEvents.length, 2);
  assert.deepEqual(harness.savedEvents[1], {
    reportId: REPORT_ID,
    editorData: withSavedMapping(harness.data, {
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "SHOE-10",
      sku: "SHOE-8",
    }),
    variationNumber: 10,
    expectedStatus: "payment_complete",
    previousSku: "SHOE-10",
    sku: "SHOE-8",
  });
  assert.equal(harness.confirmations.length, 0);
  assert.equal(harness.controller.getState().selectedSku, "SHOE-8");
  assert.equal(document.querySelector("#mapping-sku").value, "SHOE-8");
  assert.match(document.querySelector("#mapping-selected").textContent, /SHOE-8/);
  assert.equal(reset.disabled, true);
  assert.equal(save.disabled, true);

  await save.click();
  assert.equal(harness.saves.length, 2);
});

test("a failed one-click reset keeps the original SKU ready to retry", async () => {
  const data = createEditorData();
  let durableData = clone(data);
  let resetAttempts = 0;
  const requests = [];
  const client = {
    async loadEditorData() {
      return clone(durableData);
    },
    async saveMappingCorrections(input) {
      requests.push(clone(input));
      const change = input.changes[0];

      if (change.sku === "SHOE-8") {
        resetAttempts += 1;

        if (resetAttempts === 1) {
          throw new Error("Reset storage is temporarily unavailable.");
        }
      }

      durableData = withSavedMapping(durableData, change);
      return clone(durableData);
    },
  };
  const harness = createHarness({ client, data });
  const { document } = harness;
  const save = document.querySelector("#save-mapping-correction");
  const reset = document.querySelector("#reset-mapping-original");

  await harness.controller.load(REPORT_ID);
  await selectTarget(document, data, "SHOE-10");
  await save.click();
  await reset.click();

  assert.equal(requests.length, 2);
  assert.equal(harness.savedEvents.length, 1);
  assert.equal(harness.controller.getState().selectedSku, "SHOE-8");
  assert.equal(save.disabled, false);
  assert.equal(reset.disabled, false);
  assert.match(
    document.querySelector("#mapping-correction-feedback").textContent,
    /Reset storage is temporarily unavailable/,
  );

  await reset.click();

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].changes, [{
    variationNumber: 10,
    expectedStatus: "payment_complete",
    expectedSku: "SHOE-10",
    sku: "SHOE-8",
  }]);
  assert.equal(harness.savedEvents.length, 2);
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);
});

test("save applies immediately without opening a confirmation", async () => {
  const harness = createHarness({ confirmResult: false });
  await harness.controller.load(REPORT_ID);
  await selectTarget(harness.document, harness.data, "SHOE-10");

  const save = harness.document.querySelector("#save-mapping-correction");
  await save.click();

  assert.equal(harness.confirmations.length, 0);
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.savedEvents.length, 1);
  assert.equal(harness.controller.getState().selectedSku, "SHOE-10");
  assert.equal(save.disabled, true);
});

test("canceled corrections are clearly reference-only", async () => {
  const harness = createHarness();
  await harness.controller.load(REPORT_ID);
  await selectVariation(harness.document, 12);

  const { document } = harness;
  assert.match(
    document.querySelector("#mapping-variation-status").textContent,
    /Canceled.*Reference only/,
  );
  await selectTarget(document, harness.data, "BAG-OS");
  await document.querySelector("#save-mapping-correction").click();

  assert.deepEqual(harness.saves[0].changes, [{
    variationNumber: 12,
    expectedStatus: "canceled",
    expectedSku: "SHOE-7",
    sku: "BAG-OS",
  }]);
  assert.equal(harness.confirmations.length, 0);
  assert.match(
    document.querySelector("#mapping-correction-feedback").textContent,
    /reference changed.*inventory and metrics were unchanged/i,
  );
  assert.match(
    document.querySelector("#mapping-correction-feedback").className,
    /\bvisually-hidden\b/,
  );
});

test("save busy state and failure preserve an exact replacement for retry", async () => {
  const data = createEditorData();
  let rejectFirst;
  let attempts = 0;
  const firstSave = new Promise((_resolve, reject) => {
    rejectFirst = reject;
  });
  const saves = [];
  const client = {
    async loadEditorData() {
      return clone(data);
    },
    async saveMappingCorrections(input) {
      attempts += 1;
      saves.push(clone(input));
      return attempts === 1
        ? firstSave
        : withSavedMapping(data, input.changes[0]);
    },
  };
  const harness = createHarness({ client, data });
  await harness.controller.load(REPORT_ID);
  await selectTarget(harness.document, data, "SHOE-10");

  const section = harness.document.querySelector("#mapping-correction-section");
  const fields = harness.document.querySelector("#mapping-correction-fields");
  const save = harness.document.querySelector("#save-mapping-correction");
  const reset = harness.document.querySelector("#reset-mapping-original");
  assert.equal(reset.disabled, false);
  const pending = save.click();
  assert.equal(section.getAttribute("aria-busy"), "true");
  assert.equal(fields.disabled, true);
  assert.equal(save.disabled, true);
  assert.equal(reset.disabled, true);

  rejectFirst(new Error("Storage is temporarily unavailable."));
  await pending;
  assert.equal(section.getAttribute("aria-busy"), "false");
  assert.equal(fields.disabled, false);
  assert.equal(save.disabled, false);
  assert.equal(reset.disabled, false);
  assert.equal(harness.controller.getState().selectedSku, "SHOE-10");
  assert.equal(harness.savedEvents.length, 0);
  assert.equal(
    harness.document.querySelector("#mapping-correction-feedback").textContent,
    "Storage is temporarily unavailable.",
  );

  await save.click();
  assert.equal(attempts, 2);
  assert.deepEqual(saves[1], saves[0]);
  assert.equal(harness.savedEvents.length, 1);
});

test("a saved correction with a failed report refresh cannot save twice", async () => {
  const harness = createHarness({
    async onSaved() {
      throw new Error("The report could not rerender.");
    },
  });
  await harness.controller.load(REPORT_ID);
  await selectTarget(harness.document, harness.data, "SHOE-10");

  const save = harness.document.querySelector("#save-mapping-correction");
  await save.click();

  assert.equal(harness.saves.length, 1);
  assert.equal(harness.savedEvents.length, 1);
  assert.equal(harness.controller.getState().selectedSku, "SHOE-10");
  assert.match(
    harness.document.querySelector("#mapping-original").textContent,
    /SHOE-8/,
  );
  assert.match(
    harness.document.querySelector("#mapping-selected").textContent,
    /SHOE-10/,
  );
  assert.equal(save.disabled, true);
  assert.match(
    harness.document.querySelector("#mapping-correction-feedback").textContent,
    /was saved[\s\S]*could not refresh[\s\S]*Reload the report/,
  );

  await save.click();
  assert.equal(harness.saves.length, 1);
});

test("blocked and read-only eligibility disable controls with exact reasons", async (t) => {
  const cases = [
    {
      name: "blocked",
      data: createEditorData({
        eligibility: {
          status: "blocked",
          code: "ACTIVE_STREAM_ALREADY_EXISTS",
          reason: "End the active tracker stream before editing a report.",
        },
      }),
    },
    {
      name: "read only",
      data: createEditorData({
        eligibility: {
          status: "read_only",
          code: "NO_EDITABLE_VARIATIONS",
          reason: "This report has no saved variations to edit.",
        },
        completedVariations: [],
        canceledVariations: [],
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = createHarness({ data: entry.data });
      await harness.controller.load(REPORT_ID);
      const reason = entry.data.eligibility.reason;
      const availability = harness.document.querySelector(
        "#mapping-correction-availability",
      );
      const save = harness.document.querySelector("#save-mapping-correction");
      const reset = harness.document.querySelector("#reset-mapping-original");

      assert.equal(availability.textContent, reason);
      assert.equal(availability.hidden, false);
      assert.equal(availability.dataset.state, entry.data.eligibility.status);
      assert.equal(
        harness.document.querySelector("#mapping-correction-fields").disabled,
        true,
      );
      assert.equal(save.disabled, true);
      assert.equal(reset.disabled, true);
      assert.equal(save.title, reason);
      await reset.click();
      await save.click();
      assert.deepEqual(harness.saves, []);
    });
  }
});

test("real client emits only report correction commands", async () => {
  const messages = [];
  const data = createEditorData();
  const runtime = {
    async sendMessage(message) {
      messages.push(clone(message));
      const command = message.command;

      if (command.type === protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA) {
        return { ok: true, data: clone(data) };
      }

      return {
        ok: true,
        data: withSavedMapping(data, command.changes[0]),
      };
    },
  };
  const client = realClientModule.createOfflineReportEditorClient({
    runtime,
    protocol,
  });
  const harness = createHarness({ client, data });
  await harness.controller.load(REPORT_ID);
  assert.deepEqual(
    messages.map((message) => message.command.type),
    [protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA],
  );

  await selectVariation(harness.document, 11);
  await selectTarget(harness.document, data, "SHOE-10");
  assert.equal(messages.length, 1);
  await harness.document.querySelector("#save-mapping-correction").click();

  assert.deepEqual(
    messages.map((message) => message.command.type),
    [
      protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
      protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
    ],
  );
  assert.ok(messages.every((message) =>
    message.channel === protocol.MESSAGE_CHANNEL &&
    message.version === protocol.MESSAGE_VERSION));
  assert.deepEqual(messages[1].command.changes, [{
    variationNumber: 11,
    expectedStatus: "payment_complete",
    expectedSku: null,
    sku: "SHOE-10",
  }]);
  assert.doesNotMatch(
    messages.map((message) => message.command.type).join(" "),
    /capture|queue|google|oauth|import|reconcil|baseline|live_mapping/i,
  );
});
