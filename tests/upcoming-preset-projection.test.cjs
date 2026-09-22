const assert = require("node:assert/strict");
const test = require("node:test");
const projection = require("../extension/tagger/variation-presets-view.js");

function fixture() {
  const view = {
    streamId: "synthetic-stream", variationNumber: 10,
    currentVariationNumber: 10, selectedVariationNumber: 10,
    activeBiddingVariationNumber: 10, isReviewingHistory: false,
    variations: [{ variationNumber: 10, recorded: true, sku: "HOODIE-M" }],
    inventory: [
      { sku: "HOODIE-M", item: "LA", style: "Hoodie", size: "M", selected: true,
        remainingQuantity: 12, pendingQuantity: 1, soldQuantity: 0 },
      { sku: "HOODIE-L", item: "LA", style: "Hoodie", size: "L", selected: false,
        remainingQuantity: 8, pendingQuantity: 0, soldQuantity: 0 },
    ],
    mapping: { sku: "HOODIE-M", variationNumber: 10 },
    totals: { completedGmvCents: 0, canceledOrderCount: 0 },
  };
  const presets = {
    streamId: "synthetic-stream", baselineId: "synthetic-baseline", revision: "revision-1",
    total: 20, assignments: [{ variationNumber: 11, sku: "HOODIE-L" }],
  };
  return { view, presets, baselineId: presets.baselineId };
}
function upcoming({ view, presets, baselineId }) {
  return projection.getUpcomingAssignment(view, presets, baselineId);
}
function prestreamFixture(selectedNumber = 10, assignments = [{ variationNumber: 11, sku: "HOODIE-L" }]) {
  const data = fixture();
  Object.assign(data.view, {
    activeBiddingVariationNumber: null, currentVariationNumber: 1,
    selectedVariationNumber: null, variationNumber: null, variations: [], mapping: null,
  });
  data.view.inventory = data.view.inventory.map((entry) => ({ ...entry, selected: false, pendingQuantity: 0 }));
  data.presets.assignments = assignments;
  data.view = projection.project(data.view, data.presets, selectedNumber);
  return data;
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("upcoming preset projection identifies only the immediate next exact SKU and mutation identity", () => {
  const data = fixture();
  assert.deepEqual(upcoming(data), {
    source: "preset", sku: "HOODIE-L", variationNumber: 11,
    activeBiddingVariationNumber: 10, streamId: "synthetic-stream",
    baselineId: "synthetic-baseline", revision: "revision-1",
  });
  const projected = projection.project(data.view, data.presets);
  assert.deepEqual(upcoming({ ...data, view: projected }), upcoming(data));
});

test("upcoming preset projection never skips an empty immediate next placeholder", () => {
  const data = fixture();
  for (const assignments of [[], [{ variationNumber: 12, sku: "HOODIE-L" }],
    [{ variationNumber: 9, sku: "HOODIE-L" }]]) {
    data.presets.assignments = assignments;
    assert.equal(upcoming(data), null);
  }
});

test("upcoming preset projection advances only with the actual live bidding marker", () => {
  const data = fixture();
  data.presets.assignments.push({ variationNumber: 12, sku: "HOODIE-M" });
  assert.equal(upcoming(data).variationNumber, 11);
  data.view.variations.push({ variationNumber: 11, recorded: true, sku: "HOODIE-L" });
  assert.equal(upcoming(data), null, "captured next target is never still presented as a preset");
  Object.assign(data.view, { activeBiddingVariationNumber: 11, currentVariationNumber: 11,
    selectedVariationNumber: 11, variationNumber: 11 });
  assert.equal(upcoming(data).variationNumber, 12);
  assert.equal(upcoming(data).sku, "HOODIE-M");
  data.view.activeBiddingVariationNumber = null;
  assert.equal(upcoming(data), null, "highest captured fallback cannot masquerade as bidding");
});

test("upcoming preset projection is hidden in historical and future views", () => {
  for (const changes of [
    { selectedVariationNumber: 9 }, { selectedVariationNumber: 12 },
    { isReviewingHistory: true }, { isReviewingPreset: true },
    { currentVariationNumber: 9 },
  ]) {
    const data = fixture();
    Object.assign(data.view, changes);
    assert.equal(upcoming(data), null, JSON.stringify(changes));
  }
  const data = fixture();
  const future = projection.project(data.view, data.presets, 12);
  assert.equal(upcoming({ ...data, view: future }), null);
});

test("upcoming preset projection requires a recorded live entry, not offline startup or a placeholder", () => {
  for (const activeBiddingVariationNumber of [null, undefined, 0, -1, 10.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
    const data = fixture();
    data.view.activeBiddingVariationNumber = activeBiddingVariationNumber;
    assert.equal(upcoming(data), null);
  }
  for (const variations of [[], [{ variationNumber: 10, recorded: false }],
    [{ variationNumber: 10, recorded: true, preset: true }]]) {
    const data = fixture();
    data.view.variations = variations;
    assert.equal(upcoming(data), null);
  }
});

test("upcoming preset projection fails closed for another stream, baseline, or missing revision", () => {
  for (const changes of [
    { streamId: "different-stream" }, { baselineId: "different-baseline" },
    { revision: null }, { revision: "" }, { revision: " revision " },
  ]) {
    const data = fixture();
    Object.assign(data.presets, changes);
    assert.equal(upcoming(data), null, JSON.stringify(changes));
  }
  for (const baselineId of [null, undefined, "", "different-baseline", " synthetic-baseline "]) {
    assert.equal(upcoming({ ...fixture(), baselineId }), null);
  }
  const data = fixture();
  data.view.streamId = data.presets.streamId = "";
  assert.equal(upcoming(data), null);
});

test("upcoming preset projection respects range end and disabled or malformed plans", () => {
  for (const total of [null, undefined, 0, -1, 10, 10.5, "20", Number.MAX_SAFE_INTEGER + 1]) {
    const data = fixture();
    data.presets.total = total;
    assert.equal(upcoming(data), null);
  }
  for (const changes of [
    { view: null }, { presets: null },
    { view: { ...fixture().view, variations: null } },
    { view: { ...fixture().view, inventory: null } },
    { presets: { ...fixture().presets, assignments: null } },
  ]) assert.equal(upcoming({ ...fixture(), ...changes }), null);
});

test("upcoming preset projection preserves exact size SKU identity and permits selected plus queued", () => {
  const data = fixture();
  const sibling = upcoming(data);
  assert.equal(sibling.sku, "HOODIE-L");
  assert.equal(data.view.inventory.find((entry) => entry.sku === sibling.sku).size, "L");
  data.presets.assignments[0].sku = "HOODIE-M";
  assert.equal(upcoming(data).sku, data.view.mapping.sku);
  assert.equal(data.view.inventory.find((entry) => entry.sku === upcoming(data).sku).size, "M");
});

test("upcoming preset projection rejects missing or ambiguous exact SKU assignments", () => {
  for (const sku of [null, "", " HOODIE-L ", "hoodie-l", "UNKNOWN-SKU"]) {
    const data = fixture();
    data.presets.assignments[0].sku = sku;
    assert.equal(upcoming(data), null);
  }
  const data = fixture();
  data.presets.assignments.push({ variationNumber: 11, sku: "HOODIE-M" });
  assert.equal(upcoming(data), null);
});

test("upcoming preset projection is read-only and independent of manual queue, search, and stock", () => {
  const data = fixture();
  data.view.inventoryFilter = "a search that hides the card";
  data.view.queuedSku = "MANUAL-QUEUE";
  data.view.inventory[1].remainingQuantity = 0;
  const before = structuredClone(data);
  freeze(data);
  const result = upcoming(data);
  assert.equal(result.sku, "HOODIE-L");
  assert.equal(result.source, "preset");
  assert.equal(Object.hasOwn(result, "queueToken"), false);
  assert.deepEqual(data, before);
  result.sku = "changed-output-only";
  assert.deepEqual(data, before);
});

test("pre-stream upcoming preset uses an explicitly viewed empty or assigned future source", () => {
  for (const sourceAssigned of [false, true]) {
    const assignments = [{ variationNumber: 11, sku: "HOODIE-L" }];
    if (sourceAssigned) assignments.unshift({ variationNumber: 10, sku: "HOODIE-M" });
    const data = prestreamFixture(10, assignments);
    assert.deepEqual(upcoming(data), {
      source: "preset", sku: "HOODIE-L", variationNumber: 11,
      prestreamVariationNumber: 10, streamId: "synthetic-stream",
      baselineId: "synthetic-baseline", revision: "revision-1",
    });
    assert.equal(Object.hasOwn(upcoming(data), "activeBiddingVariationNumber"), false);
    assert.equal(data.view.mapping, null);
  }
});

test("pre-stream upcoming preset navigation follows exactly the selected number plus one", () => {
  const assignments = [
    { variationNumber: 11, sku: "HOODIE-L" },
    { variationNumber: 12, sku: "HOODIE-M" },
    { variationNumber: 15, sku: "HOODIE-L" },
  ];
  const data = prestreamFixture(10, assignments);
  assert.equal(upcoming(data).variationNumber, 11);
  data.view = projection.project(data.view, data.presets, 11);
  assert.equal(upcoming(data).variationNumber, 12);
  assert.equal(upcoming(data).prestreamVariationNumber, 11);
  assert.equal(upcoming(data).sku, "HOODIE-M");
  data.view = projection.project(data.view, data.presets, 12);
  assert.equal(upcoming(data), null, "do not skip ahead to assigned #15");
  data.view = projection.project(data.view, data.presets, 14);
  assert.equal(upcoming(data).variationNumber, 15);
  data.view = projection.project(data.view, data.presets, 20);
  assert.equal(upcoming(data), null, "never wrap past the range end");
});

test("pre-stream upcoming preset requires existing source and target placeholders without an implicit default", () => {
  for (const selectedNumber of [null, undefined, 0, -1, 10.5, "10", 21]) {
    const data = prestreamFixture();
    data.view.selectedVariationNumber = selectedNumber;
    assert.equal(upcoming(data), null);
  }
  const unselected = prestreamFixture(null, [{ variationNumber: 2, sku: "HOODIE-L" }]);
  assert.equal(upcoming(unselected), null, "a startup fallback does not imply selected preset #1");
  for (const absent of [10, 11]) {
    const data = prestreamFixture();
    data.view.variations = data.view.variations.filter((entry) => entry.variationNumber !== absent);
    assert.equal(upcoming(data), null);
  }
  const ordinary = prestreamFixture();
  ordinary.view.isReviewingPreset = false;
  assert.equal(upcoming(ordinary), null);
  for (const target of [10, 11]) {
    const data = prestreamFixture();
    data.view.variations.find((entry) => entry.variationNumber === target).preset = false;
    assert.equal(upcoming(data), null);
  }
});

test("pre-stream upcoming preset fails closed for identity changes, reset, and invalid assignments", () => {
  for (const changes of [
    { streamId: "different-stream" }, { baselineId: "different-baseline" },
    { revision: null }, { total: null }, { total: 10 }, { assignments: [] },
    { assignments: [{ variationNumber: 11, sku: "UNKNOWN-SKU" }] },
  ]) {
    const data = prestreamFixture();
    Object.assign(data.presets, changes);
    assert.equal(upcoming(data), null, JSON.stringify(changes));
  }
  const data = prestreamFixture();
  assert.equal(upcoming({ ...data, baselineId: "another-baseline" }), null);
});

test("pre-stream upcoming preset stops after any real capture and cannot return when bidding stops", () => {
  for (const capturedNumber of [1, 10, 11, 19]) {
    const data = prestreamFixture();
    assert.equal(upcoming(data).variationNumber, 11);
    const captured = data.view.variations.find((entry) => entry.variationNumber === capturedNumber);
    Object.assign(captured, { recorded: true, preset: false });
    assert.equal(upcoming(data), null, "even capture without a live marker ends pre-stream presentation");
    data.view.activeBiddingVariationNumber = capturedNumber;
    data.view.currentVariationNumber = capturedNumber;
    assert.equal(upcoming(data), null, "future browsing after capture must not get preset indicators");
    data.view.activeBiddingVariationNumber = null;
    assert.equal(upcoming(data), null, "clearing the live marker is not a new pre-stream phase");
  }
  for (const activeBiddingVariationNumber of [0, -1, 10, "10"]) {
    const data = prestreamFixture();
    data.view.activeBiddingVariationNumber = activeBiddingVariationNumber;
    assert.equal(upcoming(data), null);
  }
});

test("pre-stream upcoming preset keeps exact size identity including the selected SKU", () => {
  for (const sku of ["HOODIE-L", "HOODIE-M"]) {
    const data = prestreamFixture(10, [
      { variationNumber: 10, sku: "HOODIE-M" }, { variationNumber: 11, sku },
    ]);
    const result = upcoming(data);
    assert.equal(result.sku, sku);
    const selected = data.view.inventory.find((entry) => entry.selected);
    assert.equal(selected.sku, "HOODIE-M");
    assert.equal(data.view.inventory.find((entry) => entry.sku === result.sku).size,
      sku === "HOODIE-M" ? "M" : "L");
  }
});

test("pre-stream upcoming preset remains a read-only projection without arming manual queues or reserving stock", () => {
  const data = prestreamFixture();
  data.view.inventoryFilter = "hidden item search";
  data.view.queuedSku = "MANUAL-QUEUE";
  const before = structuredClone(data);
  freeze(data);
  const result = upcoming(data);
  assert.equal(result.sku, "HOODIE-L");
  assert.equal(result.source, "preset");
  assert.equal(Object.hasOwn(result, "queueToken"), false);
  assert.ok(data.view.inventory.every((entry) => entry.pendingQuantity === 0));
  assert.equal(data.view.mapping, null);
  assert.deepEqual(data, before);
  result.sku = "changed-output-only";
  assert.deepEqual(data, before);
});
