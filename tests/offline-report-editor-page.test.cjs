const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const protocol = require("../extension/shared/stream-report-protocol.js");
const realClientModule = require(
  "../extension/report/offline-report-editor-client.js",
);
const editorPage = require("../extension/report/offline-editor-page.js");

const REPORT_ID =
  "stream-report:11111111-1111-4111-8111-111111111111";

const EDITOR_SELECTORS = [
  "#cancel-editor",
  "#draft-count",
  "#editor-content",
  "#editor-error",
  "#editor-error-message",
  "#editor-loading",
  "#editor-report-name",
  "#editor-status",
  "#editor-workspace",
  "#inventory-empty",
  "#inventory-grid",
  "#inventory-list-toggle",
  "#inventory-list-toggle-label",
  "#inventory-result-count",
  "#inventory-search",
  "#original-mapping",
  "#preview-cogs",
  "#preview-gross-profit",
  "#preview-mapped-count",
  "#preview-oversold",
  "#reference-only-note",
  "#retry-editor",
  "#save-editor",
  "#selected-mapping",
  "#selected-sold-price",
  "#selected-status",
  "#selected-variation",
  "#variation-selector",
];

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toLocaleLowerCase("en-US");
    this.children = [];
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.id = "";
    this.title = "";
    this.dataset = {};
    this.className = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.focused = false;
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
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name, event = {}) {
    const dispatched = {
      currentTarget: this,
      target: this,
      ...event,
    };

    return Promise.all(
      (this.listeners.get(name) ?? []).map((listener) =>
        listener(dispatched),
      ),
    );
  }

  click() {
    if (this.disabled) {
      return Promise.resolve([]);
    }

    return this.dispatch("click");
  }

  focus() {
    this.focused = true;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map(
      EDITOR_SELECTORS.map((selector) => [selector, new FakeElement()]),
    );
    this.createdTags = [];
    this.title = "";
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
    sku: overrides.sku ?? "EXTRA-1",
    item: overrides.item ?? "Extra item 1",
    style: overrides.style ?? "standard",
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
  const extras = Array.from({ length: 10 }, (_value, index) =>
    createInventoryEntry({
      sku: `EXTRA-${index + 1}`,
      item: `Extra item ${index + 1}`,
    }),
  );
  const inventory = [
    ...extras,
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
    }),
  ];
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
    inventory,
  };

  return { ...base, ...overrides };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options = {}) {
  const document = new FakeDocument();
  const navigations = [];
  const confirmations = [];
  const windowListeners = new Map();
  const loadCalls = [];
  const saveCalls = [];
  const data = options.data ?? createEditorData();
  const client = options.client ?? {
    async loadEditorData(input) {
      loadCalls.push(clone(input));
      return clone(data);
    },
    async saveMappingCorrections(input) {
      saveCalls.push(clone(input));
      return clone(data);
    },
  };
  const controller = editorPage.mountOfflineEditorPage({
    document,
    location: {
      search: options.search ?? `?reportId=${encodeURIComponent(REPORT_ID)}`,
    },
    runtime: options.runtime ?? {},
    protocol,
    clientModule: options.clientModule ?? {
      createOfflineReportEditorClient() {
        return client;
      },
    },
    confirm(message) {
      confirmations.push(message);
      return options.confirmResult ?? true;
    },
    navigate(url) {
      navigations.push(url);
    },
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (windowListeners.get(name) === listener) {
        windowListeners.delete(name);
      }
    },
  });

  return {
    client,
    confirmations,
    controller,
    data,
    document,
    loadCalls,
    navigations,
    saveCalls,
    windowListeners,
  };
}

function getShoeCard(document) {
  return document.querySelector("#inventory-grid").children.find(
    (card) => card.dataset.groupKey.includes("yeezy slide"),
  );
}

function getItemCard(document, item) {
  return document.querySelector("#inventory-grid").children.find(
    (card) => card.children[0].children[0].textContent === item,
  );
}

function getMultiSizeControls(card) {
  const controls = card.children[2];
  const label = controls.children[0];
  return {
    select: label.children[0],
    action: controls.children[1],
  };
}

async function selectVariationWithExpandedInventory(document, variationNumber) {
  const toggle = document.querySelector("#inventory-list-toggle");
  assert.equal(toggle.hidden, false);
  await toggle.click();

  const variation = document.querySelector("#variation-selector");
  variation.value = variationNumber;
  await variation.dispatch("change");
  assert.equal(
    document.querySelector("#inventory-list-toggle").getAttribute("aria-expanded"),
    "true",
  );
}

test("packaged Offline Report Editor assets are isolated and accessible", () => {
  const extensionRoot = path.join(__dirname, "..", "extension");
  const reportRoot = path.join(extensionRoot, "report");
  const html = fs.readFileSync(
    path.join(reportRoot, "offline-editor.html"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(reportRoot, "offline-editor.css"),
    "utf8",
  );
  const source = fs.readFileSync(
    path.join(reportRoot, "offline-editor-page.js"),
    "utf8",
  );
  const reportHtml = fs.readFileSync(
    path.join(reportRoot, "report.html"),
    "utf8",
  );
  const sidePanelHtml = fs.readFileSync(
    path.join(extensionRoot, "tagger", "sidepanel.html"),
    "utf8",
  );
  const manifest = fs.readFileSync(
    path.join(extensionRoot, "manifest.json"),
    "utf8",
  );

  assert.match(html, /<h1>Offline Report Editor<\/h1>/);
  assert.match(html, /TikTok capture is off/);
  assert.match(html, /id="editor-report-name"/);
  assert.match(html, /Originally mapped item:[\s\S]*?id="original-mapping"/);
  assert.match(html, /<label[^>]*for="variation-selector"/);
  assert.match(html, /<label[^>]*for="inventory-search"/);
  assert.match(html, /id="inventory-grid"[^>]*role="list"/);
  assert.match(html, /id="draft-count"[^>]*role="status"/);
  assert.match(html, /id="editor-error"[\s\S]*?role="alert"/);
  assert.match(
    html,
    /stream-report-protocol\.js[\s\S]*?offline-report-editor-client\.js[\s\S]*?offline-editor-page\.js/,
  );
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(
    html,
    /Google Sheets|Connect and preview|Start stream|End Stream Tracking|live bidding|pin item/i,
  );
  assert.doesNotMatch(source, /\.innerHTML\s*=|MutationObserver|setInterval/);
  assert.doesNotMatch(source, /start_stream|end_stream|queue_next|google|oauth/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(reportHtml, /offline-editor-page\.js|offline-editor\.css/);
  assert.doesNotMatch(sidePanelHtml, /offline-editor/i);
  assert.doesNotMatch(manifest, /offline-editor/i);
});

test("report ID routing accepts one exact ID and rejects unsafe URLs", () => {
  const encoded = encodeURIComponent(REPORT_ID);

  assert.equal(
    editorPage.getRequestedReportId({ search: `?reportId=${encoded}` }, protocol),
    REPORT_ID,
  );
  for (const search of [
    "",
    "?reportId=",
    "?reportId=bad",
    `?reportId=${encoded}&reportId=${encoded}`,
    `?reportId=${encoded}&extra=true`,
  ]) {
    assert.equal(
      editorPage.getRequestedReportId({ search }, protocol),
      null,
    );
  }
  assert.equal(
    editorPage.createReportReturnUrl(REPORT_ID),
    `report.html?reportId=${encoded}`,
  );
});

test("grouping retains exact size SKUs, natural order, search, and nine-card limit", () => {
  const data = createEditorData();
  const groups = editorPage.groupInventoryEntries(data.inventory);
  const shoeGroup = groups.find((group) => group.item === "Yeezy Slide");

  assert.deepEqual(
    shoeGroup.entries.map((entry) => [entry.size, entry.sku]),
    [
      ["7", "SHOE-7"],
      ["8", "SHOE-8"],
      ["10", "SHOE-10"],
    ],
  );

  const collapsed = editorPage.prepareInventoryGroups(data.inventory, {
    mappedSku: "SHOE-8",
  });
  assert.equal(collapsed.groups.length, 9);
  assert.equal(collapsed.canToggle, true);
  assert.equal(collapsed.groups[0].item, "Yeezy Slide");
  assert.equal(
    collapsed.groups.filter((group) => group.item === "Yeezy Slide").length,
    1,
  );

  const expanded = editorPage.prepareInventoryGroups(data.inventory, {
    mappedSku: "SHOE-8",
    expanded: true,
  });
  assert.equal(expanded.groups.length, 11);

  const searched = editorPage.prepareInventoryGroups(data.inventory, {
    query: "SHOE-10",
    expanded: true,
  });
  assert.equal(searched.groups.length, 1);
  assert.equal(searched.groups[0].entries.length, 3);
});

test("drafts persist across variations and reverting removes the change", () => {
  const controller = editorPage.createDraftController(createEditorData());

  assert.equal(controller.getSelectedVariation().variationNumber, 10);
  assert.equal(controller.getSelectedSku(), "SHOE-8");
  assert.equal(controller.toggleSelectedMapping("SHOE-10"), "SHOE-10");
  assert.equal(controller.getChangeCount(), 1);

  controller.selectVariation(12);
  assert.equal(controller.toggleSelectedMapping("SHOE-10"), "SHOE-10");
  assert.equal(controller.getChangeCount(), 2);
  controller.selectVariation(10);
  assert.equal(controller.getSelectedSku(), "SHOE-10");

  assert.equal(controller.toggleSelectedMapping("SHOE-8"), "SHOE-8");
  assert.equal(controller.getChangeCount(), 1);
  controller.selectVariation(12);
  assert.equal(controller.toggleSelectedMapping("SHOE-7"), "SHOE-7");
  assert.equal(controller.getChangeCount(), 0);
});

test("the originally mapped item stays first after unmapping or remapping", async () => {
  const harness = createHarness();
  await flush();
  const { document, controller } = harness;
  const grid = document.querySelector("#inventory-grid");

  let shoeCard = getShoeCard(document);
  assert.equal(shoeCard, grid.children[0]);
  let controls = getMultiSizeControls(shoeCard);
  assert.equal(controls.select.value, "SHOE-8");
  await controls.action.click();

  assert.equal(controller.getState().selectedSku, null);
  assert.equal(getShoeCard(document), grid.children[0]);

  const extraCard = getItemCard(document, "Extra item 1");
  await extraCard.children[2].children[0].click();

  assert.equal(controller.getState().selectedSku, "EXTRA-1");
  assert.equal(getShoeCard(document), grid.children[0]);
  assert.equal(
    document.querySelector("#original-mapping").textContent,
    "Yeezy Slide — black — 8 — SHOE-8",
  );
});

test("completed drafts recalculate inventory, profit, and oversold quantities", () => {
  const data = createEditorData();
  const controller = editorPage.createDraftController(data);
  const original = controller.getPreview();

  assert.equal(original.mappedCompletedCount, 1);
  assert.equal(original.mappedRevenueCents, 2000);
  assert.equal(original.costOfGoodsCents, 500);
  assert.equal(original.grossProfitCents, 1500);

  controller.toggleSelectedMapping("SHOE-10");
  const remapped = controller.getPreview();
  const shoe8 = remapped.inventory.find((entry) => entry.sku === "SHOE-8");
  const shoe10 = remapped.inventory.find((entry) => entry.sku === "SHOE-10");

  assert.equal(shoe8.streamSoldQuantity, 0);
  assert.equal(shoe8.replacementQuantity, 1);
  assert.equal(shoe10.streamSoldQuantity, 1);
  assert.equal(shoe10.calculatedRemainingQuantity, -1);
  assert.equal(shoe10.replacementQuantity, 0);
  assert.equal(shoe10.availableAfterReservationsQuantity, 0);
  assert.equal(shoe10.oversoldQuantity, 1);
  assert.equal(shoe10.requiresRecount, true);
  assert.equal(remapped.oversoldSkuCount, 1);

  controller.selectVariation(11);
  controller.toggleSelectedMapping("EXTRA-1");
  const mapped = controller.getPreview();
  assert.equal(mapped.mappedCompletedCount, 2);
  assert.equal(mapped.mappedRevenueCents, 3500);
  assert.equal(mapped.costOfGoodsCents, 800);
  assert.equal(mapped.grossProfitCents, 2700);

  controller.selectVariation(10);
  controller.toggleSelectedMapping("SHOE-10");
  const unmapped = controller.getPreview();
  assert.equal(unmapped.mappedCompletedCount, 1);
  assert.equal(unmapped.mappedRevenueCents, 1500);
});

test("canceled mapping drafts are reference-only in every financial preview", () => {
  const controller = editorPage.createDraftController(createEditorData());
  const before = controller.getPreview();

  controller.selectVariation(12);
  controller.toggleSelectedMapping("SHOE-10");
  const after = controller.getPreview();

  assert.deepEqual(after, before);
  assert.deepEqual(controller.getChanges(), [
    {
      variationNumber: 12,
      expectedStatus: "canceled",
      expectedSku: "SHOE-7",
      sku: "SHOE-10",
    },
  ]);
});

test("arithmetically unsafe preview changes roll back without hiding a draft", () => {
  const data = createEditorData();
  data.inventory.find((entry) => entry.sku === "SHOE-10").unitCostCents =
    Number.MAX_SAFE_INTEGER;
  const controller = editorPage.createDraftController(data);

  controller.toggleSelectedMapping("SHOE-10");
  assert.equal(controller.getChangeCount(), 1);
  controller.selectVariation(11);
  assert.throws(
    () => controller.toggleSelectedMapping("SHOE-10"),
    /supported preview range/,
  );
  assert.equal(controller.getChangeCount(), 1);
  assert.equal(controller.getSelectedSku(), null);
  assert.deepEqual(controller.getChanges().map((change) => change.variationNumber),
    [10]);
});

test("invalid URLs fail before loading while blocked data stays read-only", async () => {
  const invalid = createHarness({ search: "?reportId=bad" });
  await flush();
  assert.deepEqual(invalid.loadCalls, []);
  assert.equal(invalid.document.querySelector("#editor-error").hidden, false);
  assert.match(
    invalid.document.querySelector("#editor-error-message").textContent,
    /valid report ID/,
  );

  const reason = "End the active tracker stream before editing a report.";
  const blocked = createHarness({
    data: createEditorData({
      eligibility: {
        status: "blocked",
        code: "ACTIVE_STREAM_ALREADY_EXISTS",
        reason,
      },
    }),
  });
  await flush();
  assert.equal(blocked.document.querySelector("#editor-workspace").disabled, true);
  assert.equal(blocked.document.querySelector("#save-editor").disabled, true);
  assert.equal(blocked.document.querySelector("#editor-status").textContent, reason);

  const readOnlyReason =
    "This report has no saved completed or canceled variations to edit.";
  const readOnly = createHarness({
    data: createEditorData({
      eligibility: {
        status: "read_only",
        code: "NO_EDITABLE_VARIATIONS",
        reason: readOnlyReason,
      },
      completedVariations: [],
      canceledVariations: [],
    }),
  });
  await flush();
  assert.equal(readOnly.document.querySelector("#editor-workspace").disabled, true);
  assert.equal(readOnly.document.querySelector("#editor-status").textContent,
    readOnlyReason);
});

test("a newer editor load wins over a stale earlier response", async () => {
  let loadCount = 0;
  let resolveFirstLoad;
  const firstLoad = new Promise((resolve) => {
    resolveFirstLoad = resolve;
  });
  const client = {
    loadEditorData() {
      loadCount += 1;
      return loadCount === 1
        ? firstLoad
        : Promise.resolve(clone(createEditorData({
            displayName: "Newest durable report",
          })));
    },
    async saveMappingCorrections() {
      throw new Error("Saving is not expected in this test.");
    },
  };
  const harness = createHarness({ client });
  await harness.controller.load();

  assert.equal(harness.document.querySelector("#editor-report-name").textContent,
    "Newest durable report");
  resolveFirstLoad(clone(createEditorData({
    displayName: "Stale earlier report",
  })));
  await flush();
  assert.equal(harness.document.querySelector("#editor-report-name").textContent,
    "Newest durable report");
});

test("editable UI uses exact multi-size SKU and preserves expansion across renders", async () => {
  const harness = createHarness();
  await flush();
  const { document, controller } = harness;

  assert.equal(document.querySelector("#editor-content").hidden, false);
  assert.equal(document.querySelector("#editor-workspace").disabled, false);
  assert.equal(document.querySelector("#editor-report-name").textContent,
    "Saturday stream");
  assert.equal(document.querySelector("#selected-sold-price").textContent,
    "$20.00");
  assert.equal(
    document.querySelector("#original-mapping").textContent,
    "Yeezy Slide — black — 8 — SHOE-8",
  );
  assert.equal(getShoeCard(document), document.querySelector("#inventory-grid").children[0]);

  await document.querySelector("#inventory-list-toggle").click();
  assert.equal(controller.getState().expanded, true);
  assert.equal(document.querySelector("#inventory-grid").children.length, 11);

  const variationSelector = document.querySelector("#variation-selector");
  variationSelector.value = "11";
  await variationSelector.dispatch("change");
  assert.equal(controller.getState().expanded, true);

  let controls = getMultiSizeControls(getShoeCard(document));
  controls.select.value = "SHOE-10";
  await controls.select.dispatch("change");
  assert.match(
    controls.action.getAttribute("aria-label"),
    /Map size 10, SKU SHOE-10/,
  );
  await controls.action.click();

  assert.equal(controller.getState().selectedSku, "SHOE-10");
  assert.equal(
    getShoeCard(document),
    document.querySelector("#inventory-grid").children.at(-1),
  );
  assert.equal(
    document.querySelector("#original-mapping").textContent,
    "Unmapped",
  );
  assert.equal(controller.getState().changeCount, 1);
  assert.equal(document.querySelector("#preview-oversold").textContent, "1");
  assert.equal(document.querySelector("#save-editor").disabled, false);
  controls = getMultiSizeControls(getShoeCard(document));
  assert.match(
    controls.action.getAttribute("aria-label"),
    /Unmap size 10, SKU SHOE-10/,
  );

  variationSelector.value = "12";
  await variationSelector.dispatch("change");
  assert.equal(
    document.querySelector("#original-mapping").textContent,
    "Yeezy Slide — black — 7 — SHOE-7",
  );
  assert.equal(document.querySelector("#reference-only-note").hidden, false);
  assert.equal(controller.getState().changeCount, 1);
  assert.equal(controller.getState().expanded, true);

  const search = document.querySelector("#inventory-search");
  search.value = "SHOE-7";
  await search.dispatch("input");
  assert.equal(document.querySelector("#inventory-grid").children.length, 1);
  assert.equal(getShoeCard(document).children[2].children[0].children[0]
    .children.length, 3);
});

test("save confirmation, busy state, failure retry, and success navigation are safe", async () => {
  let rejectFirst;
  let resolveSecond;
  let saveAttempt = 0;
  const client = {
    async loadEditorData() {
      return clone(createEditorData());
    },
    saveMappingCorrections() {
      saveAttempt += 1;
      return new Promise((resolve, reject) => {
        if (saveAttempt === 1) {
          rejectFirst = reject;
        } else {
          resolveSecond = resolve;
        }
      });
    },
  };
  const harness = createHarness({ client });
  await flush();
  await selectVariationWithExpandedInventory(harness.document, "11");
  let controls = getMultiSizeControls(getShoeCard(harness.document));
  controls.select.value = "SHOE-10";
  await controls.select.dispatch("change");
  await controls.action.click();

  const saveButton = harness.document.querySelector("#save-editor");
  const firstSave = saveButton.click();
  await flush();
  assert.equal(harness.document.querySelector("#editor-workspace").disabled, true);
  assert.equal(harness.document.querySelector("#cancel-editor").disabled, true);
  assert.match(harness.confirmations[0], /Save 1 corrected mapping change/);

  rejectFirst(new Error("Storage is temporarily unavailable."));
  await firstSave;
  assert.equal(harness.controller.getState().changeCount, 1);
  assert.equal(harness.document.querySelector("#editor-workspace").disabled, false);
  assert.equal(harness.document.querySelector("#editor-status").textContent,
    "Storage is temporarily unavailable.");
  assert.equal(harness.navigations.length, 0);

  const secondSave = saveButton.click();
  await flush();
  resolveSecond({ reportId: REPORT_ID });
  await secondSave;
  assert.deepEqual(harness.navigations, [
    editorPage.createReportReturnUrl(REPORT_ID),
  ]);
  assert.equal(harness.controller.getState().changeCount, 0);
  assert.equal(harness.windowListeners.has("beforeunload"), false);
});

test("declined confirmation and mismatched save responses preserve every draft", async () => {
  const declined = createHarness({ confirmResult: false });
  await flush();
  await selectVariationWithExpandedInventory(declined.document, "11");
  let controls = getMultiSizeControls(getShoeCard(declined.document));
  controls.select.value = "SHOE-10";
  await controls.select.dispatch("change");
  await controls.action.click();
  await declined.document.querySelector("#save-editor").click();
  await declined.document.querySelector("#cancel-editor").click();
  assert.equal(declined.saveCalls.length, 0);
  assert.equal(declined.navigations.length, 0);
  assert.equal(declined.controller.getState().changeCount, 1);

  const mismatch = createHarness({
    client: {
      async loadEditorData() {
        return clone(createEditorData());
      },
      async saveMappingCorrections() {
        return {
          reportId:
            "stream-report:22222222-2222-4222-8222-222222222222",
        };
      },
    },
  });
  await flush();
  await selectVariationWithExpandedInventory(mismatch.document, "11");
  controls = getMultiSizeControls(getShoeCard(mismatch.document));
  controls.select.value = "SHOE-10";
  await controls.select.dispatch("change");
  await controls.action.click();
  await mismatch.document.querySelector("#save-editor").click();
  assert.equal(mismatch.navigations.length, 0);
  assert.equal(mismatch.controller.getState().changeCount, 1);
  assert.match(
    mismatch.document.querySelector("#editor-status").textContent,
    /different report/,
  );
});

test("cancel and beforeunload protect drafts without saving", async () => {
  const harness = createHarness();
  await flush();
  await selectVariationWithExpandedInventory(harness.document, "11");
  let controls = getMultiSizeControls(getShoeCard(harness.document));
  controls.select.value = "SHOE-10";
  await controls.select.dispatch("change");
  await controls.action.click();

  let prevented = false;
  const unloadEvent = {
    returnValue: null,
    preventDefault() {
      prevented = true;
    },
  };
  harness.windowListeners.get("beforeunload")(unloadEvent);
  assert.equal(prevented, true);
  assert.equal(unloadEvent.returnValue, "");

  await harness.document.querySelector("#cancel-editor").click();
  assert.equal(harness.saveCalls.length, 0);
  assert.deepEqual(harness.navigations, [
    editorPage.createReportReturnUrl(REPORT_ID),
  ]);
  assert.equal(harness.windowListeners.has("beforeunload"), false);
});

test("the real client emits only Offline Report Editor report commands", async () => {
  const messages = [];
  const data = createEditorData();
  const runtime = {
    async sendMessage(message) {
      messages.push(clone(message));

      if (
        message.command.type ===
          protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA
      ) {
        return { ok: true, data: clone(data) };
      }

      const change = message.command.changes[0];
      const drafts = new Map([[change.variationNumber, change.sku]]);
      const corrected = clone(data);
      corrected.completedVariations = corrected.completedVariations.map(
        (variation) => variation.variationNumber === change.variationNumber
          ? { ...variation, expectedSku: change.sku }
          : variation,
      );
      corrected.inventory = editorPage.createDraftPreview(data, drafts).inventory;
      return { ok: true, data: corrected };
    },
  };
  const harness = createHarness({
    clientModule: realClientModule,
    runtime,
  });
  await flush();
  assert.deepEqual(
    messages.map((message) => message.command.type),
    [protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA],
  );

  await harness.document.querySelector("#inventory-list-toggle").click();
  const variation = harness.document.querySelector("#variation-selector");
  variation.value = "11";
  await variation.dispatch("change");
  const controls = getMultiSizeControls(getShoeCard(harness.document));
  controls.select.value = "SHOE-10";
  await controls.select.dispatch("change");
  await controls.action.click();
  assert.equal(messages.length, 1);

  await harness.document.querySelector("#save-editor").click();
  await flush();
  assert.deepEqual(
    messages.map((message) => message.command.type),
    [
      protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
      protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
    ],
  );
  assert.ok(messages.every((message) =>
    [
      protocol.COMMAND_TYPES.GET_OFFLINE_EDITOR_DATA,
      protocol.COMMAND_TYPES.SAVE_OFFLINE_EDITOR_MAPPINGS,
    ].includes(message.command.type),
  ));
  assert.deepEqual(messages[1].command.changes, [
    {
      variationNumber: 11,
      expectedStatus: "payment_complete",
      expectedSku: null,
      sku: "SHOE-10",
    },
  ]);
});
