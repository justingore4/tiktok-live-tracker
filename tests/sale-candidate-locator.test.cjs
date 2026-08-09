const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const parser = require("../extension/shared/sale-parser.js");
const {
  MAX_ROW_ANCESTORS,
  OBSERVED_PAYMENT_STATUSES,
  PAYMENT_TAG_SELECTOR,
  SOLD_ITEMS_ROOT_SELECTOR,
  VARIATION_LABEL_SELECTOR,
  locateCompletedSales,
  locateObservedVariations,
  locatePaymentStatuses,
  locateUniqueVisibleSoldItemsRoot,
  mutationsMayAffectSale,
} = require("../extension/capture/sale-candidate-locator.js");

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.value = value;
    this.parentElement = null;
    this.parentNode = null;
  }

  get textContent() {
    return this.value;
  }
}

class FakeElement {
  constructor({
    dataTid = null,
    height = 20,
    ownText = "",
    name = "element",
    tagName = "DIV",
    width = 100,
  } = {}) {
    this.nodeType = 1;
    this.dataTid = dataTid;
    this.height = height;
    this.ownText = ownText;
    this.name = name;
    this.tagName = tagName;
    this.width = width;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
  }

  append(...nodes) {
    nodes.forEach((node) => {
      node.parentElement = node instanceof FakeElement ? this : this;
      node.parentNode = this;
      this.children.push(node);
    });

    return this;
  }

  matches(selector) {
    if (selector === PAYMENT_TAG_SELECTOR) {
      return this.dataTid === "m4b_tag";
    }

    if (selector === SOLD_ITEMS_ROOT_SELECTOR) {
      return this.dataTid === "m4b_space";
    }

    if (selector === VARIATION_LABEL_SELECTOR) {
      return this.tagName === "SPAN";
    }

    throw new Error(`Unexpected selector: ${selector}`);
  }

  querySelectorAll(selector) {
    const matches = [];

    function visit(node) {
      if (!(node instanceof FakeElement)) {
        return;
      }

      if (node.matches(selector)) {
        matches.push(node);
      }

      node.children.forEach(visit);
    }

    this.children.forEach(visit);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return { height: this.height, width: this.width };
  }

  contains(candidate) {
    let node = candidate;
    const visited = new Set();

    while (node) {
      if (node === this) {
        return true;
      }

      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      node = node.parentNode;
    }

    return false;
  }

  get textContent() {
    return `${this.ownText}${this.children
      .map((child) => child.textContent)
      .join("")}`;
  }
}

function element(options) {
  return new FakeElement(options);
}

function text(value) {
  return new FakeText(value);
}

function createCompletedRow({
  variationNumber = 250,
  soldPrice = "48.00",
  badgeText = "Payment complete",
  badgeDataTid = "m4b_tag",
  duplicateBadge = false,
} = {}) {
  const row = element({ name: `row-${variationNumber}` });
  const summary = element({
    name: "summary",
    ownText: `Example Buyer has won: $${soldPrice} Variation: #${variationNumber} `,
  });
  const badge = element({ dataTid: badgeDataTid, name: "payment-tag" });
  const badgeTextNode = text(badgeText);

  if (duplicateBadge) {
    badge.append(
      element({ dataTid: "m4b_tag", name: "nested-payment-tag" }).append(
        badgeTextNode,
      ),
    );
  } else {
    badge.append(badgeTextNode);
  }

  row.append(summary, badge);

  return { badge, badgeTextNode, row, summary };
}

function createStatusRow({
  variationNumber = 250,
  soldPrice = "48.00",
  badgeText = "Payment processing",
  nestedBadgeText = false,
} = {}) {
  const row = element({ name: `status-row-${variationNumber}` });
  const summary = element({
    name: "summary",
    ownText: `Example Buyer has won: $${soldPrice} `,
  });
  const variationLabel = element({
    name: "variation-label",
    ownText: `Variation: #${variationNumber}`,
    tagName: "SPAN",
  });
  const badge = element({ dataTid: "m4b_tag", name: "payment-tag" });
  const badgeTextNode = text(badgeText);

  summary.append(variationLabel);

  if (nestedBadgeText) {
    badge.append(
      element({ name: "generated-class-wrapper", tagName: "SPAN" }).append(
        badgeTextNode,
      ),
    );
  } else {
    badge.append(badgeTextNode);
  }

  row.append(summary, badge);
  return { badge, badgeTextNode, row, summary, variationLabel };
}

function withinBoundary(row) {
  const boundary = element({ name: "boundary" });
  const list = element({ name: "list" });
  boundary.append(list);
  list.append(row);
  return { boundary, list };
}

function childListRecord(addedNodes, removedNodes = []) {
  return {
    type: "childList",
    target:
      addedNodes[0]?.parentElement ?? removedNodes[0]?.parentElement ?? null,
    addedNodes,
    removedNodes,
  };
}

test("exports the single verified payment-tag selector and ancestor limit", () => {
  assert.equal(PAYMENT_TAG_SELECTOR, '[data-tid="m4b_tag"]');
  assert.equal(SOLD_ITEMS_ROOT_SELECTOR, '[data-tid="m4b_space"]');
  assert.equal(VARIATION_LABEL_SELECTOR, "span");
  assert.equal(MAX_ROW_ANCESTORS, 12);
});

test("selects exactly one visible Sold Items root and ignores hidden matches", () => {
  const body = element({ name: "body" });
  const hiddenRoot = element({
    dataTid: "m4b_space",
    height: 0,
    name: "hidden-root",
  });
  const visibleRoot = element({
    dataTid: "m4b_space",
    name: "visible-root",
  });
  body.append(hiddenRoot, visibleRoot);

  assert.deepEqual(locateUniqueVisibleSoldItemsRoot(body), {
    root: visibleRoot,
    status: "found",
  });
});

test("fails closed when the visible Sold Items root is missing or ambiguous", () => {
  const missingBody = element({ name: "missing-body" }).append(
    element({ dataTid: "m4b_space", width: 0 }),
  );
  const ambiguousBody = element({ name: "ambiguous-body" }).append(
    element({ dataTid: "m4b_space", name: "first" }),
    element({ dataTid: "m4b_space", name: "second" }),
  );

  assert.deepEqual(locateUniqueVisibleSoldItemsRoot(missingBody), {
    root: null,
    status: "not_found",
  });
  assert.deepEqual(locateUniqueVisibleSoldItemsRoot(ambiguousBody), {
    root: null,
    status: "ambiguous",
  });
});

test("fails closed when Sold Items visibility cannot be inspected", () => {
  const root = element({ dataTid: "m4b_space" });
  const body = element({ name: "body" }).append(root);
  root.getBoundingClientRect = () => {
    throw new Error("layout unavailable");
  };

  assert.deepEqual(locateUniqueVisibleSoldItemsRoot(body), {
    root: null,
    status: "unsafe",
  });
});

test("extracts only whole Variation labels without returning row text", () => {
  const root = element({ dataTid: "m4b_space", name: "sold-items-root" });
  const first = element({
    name: "variation-37",
    ownText: " Variation:   #37 ",
    tagName: "SPAN",
  });
  const second = element({
    name: "variation-38",
    ownText: "variation: #38",
    tagName: "SPAN",
  });
  root.append(
    first,
    element({ ownText: "Buyer Variation: #99", tagName: "SPAN" }),
    element({ ownText: "Variation: #40 extra", tagName: "SPAN" }),
    element({ ownText: "Variation: #9007199254740992", tagName: "SPAN" }),
    element({ ownText: "Variation: #41", tagName: "DIV" }),
    second,
  );

  const located = locateObservedVariations(root);

  assert.deepEqual(
    located.map(({ variationNumber }) => variationNumber),
    [37, 38],
  );
  assert.equal(located[0].label, first);
  assert.equal(located[1].label, second);
  assert.equal(Object.hasOwn(located[0], "text"), false);
});

test("classifies exact row-local payment tags without exposing their text", () => {
  const cases = [
    ["  Payment\n complete ", "payment_complete", 4800],
    ["Canceled", "canceled", null],
    ["PAYMENT FAILED", "payment_failed", null],
    ["Payment fixing", "payment_fixing", null],
    ["payment processing", "payment_processing", null],
    ["Cancelled", "unrecognized", null],
    ["Canceled order", "unrecognized", null],
    ["Payment complete now", "unrecognized", null],
    ["toString", "unrecognized", null],
  ];
  const boundary = element({ name: "boundary" });

  cases.forEach(([badgeText, _status, _price], index) => {
    boundary.append(
      createStatusRow({
        variationNumber: index + 40,
        badgeText,
        nestedBadgeText: index === 0,
      }).row,
    );
  });

  const located = locatePaymentStatuses(boundary, parser);

  assert.deepEqual(
    located.map((status) => ({
      variationNumber: status.variationNumber,
      observedPaymentStatus: status.observedPaymentStatus,
      soldPriceCents: status.soldPriceCents,
    })),
    cases.map(([_text, observedPaymentStatus, soldPriceCents], index) => ({
      variationNumber: index + 40,
      observedPaymentStatus,
      soldPriceCents,
    })),
  );
  located.forEach((status) => {
    assert.equal(Object.hasOwn(status, "statusText"), false);
    assert.equal(Object.hasOwn(status, "text"), false);
    assert.equal(Object.hasOwn(status, "buyer"), false);
  });
  assert.equal(
    OBSERVED_PAYMENT_STATUSES.NOT_OBSERVED,
    "not_observed",
  );
});

test("associates each status with exactly one Variation row and ignores extra tags", () => {
  const row44 = createStatusRow({
    variationNumber: 44,
    badgeText: "Payment processing",
  });
  const row43 = createStatusRow({
    variationNumber: 43,
    badgeText: "Canceled",
  });
  row43.row.append(
    element({ name: "payment-failure-detail", ownText: "Payment failed" }),
  );
  const unrelatedTag = element({
    dataTid: "m4b_tag",
    name: "unrelated-generic-tag",
  }).append(text("Payment complete"));
  const boundary = element({ name: "boundary" }).append(
    unrelatedTag,
    row44.row,
    row43.row,
  );

  assert.deepEqual(
    locatePaymentStatuses(boundary, parser).map((status) => ({
      variationNumber: status.variationNumber,
      observedPaymentStatus: status.observedPaymentStatus,
    })),
    [
      { variationNumber: 44, observedPaymentStatus: "payment_processing" },
      { variationNumber: 43, observedPaymentStatus: "canceled" },
    ],
  );
});

test("fails closed when a candidate contains multiple labels or sibling tags", () => {
  const duplicateLabels = createStatusRow({ variationNumber: 44 });
  duplicateLabels.row.append(
    element({ ownText: "Variation: #45", tagName: "SPAN" }),
  );
  const duplicateTags = createStatusRow({ variationNumber: 46 });
  duplicateTags.row.append(
    element({ dataTid: "m4b_tag" }).append(text("Payment failed")),
  );
  const boundary = element({ name: "boundary" }).append(
    duplicateLabels.row,
    duplicateTags.row,
  );

  assert.deepEqual(locatePaymentStatuses(boundary, parser), []);
});

test("widens an exact completed association only to its nearest unique sold price", () => {
  const outer = element({
    name: "outer-row",
    ownText: "Example Buyer has won: $48.00 ",
  });
  const inner = element({ name: "smallest-association" });
  inner.append(
    element({ ownText: "Variation: #44", tagName: "SPAN" }),
    element({ dataTid: "m4b_tag" }).append(text("Payment complete")),
  );
  outer.append(inner);
  const boundary = element({ name: "boundary" }).append(outer);
  const [located] = locatePaymentStatuses(boundary, parser);

  assert.equal(located.row, inner);
  assert.equal(located.variationNumber, 44);
  assert.equal(located.observedPaymentStatus, "payment_complete");
  assert.equal(located.soldPriceCents, 4800);

  const mismatchedParser = {
    parseSoldItemText() {
      return {
        variationNumber: 999,
        paymentStatus: "payment_complete",
        soldPriceCents: 4800,
      };
    },
  };
  assert.equal(
    locatePaymentStatuses(boundary, mismatchedParser)[0].soldPriceCents,
    null,
  );
});

test("reads variation 147 price from its nearest enclosing Sold Items row", () => {
  const buyerLine = element({
    name: "buyer-line",
    ownText: "Dobo93 has won: $11.00 · 1m ",
  });
  const buyerHandle = element({
    name: "buyer-handle",
    ownText: "doboy9393 ",
  });
  const itemAndStatus = element({ name: "item-and-status" });
  const itemLine = element({
    name: "item-line",
    ownText: "ITEM SHOWN ON SCREEN/ ALL SALES FINAL... | ",
  }).append(
    element({
      name: "variation-label",
      ownText: "Variation: #147",
      tagName: "SPAN",
    }),
  );
  const paymentLine = element({ name: "payment-line" }).append(
    element({ dataTid: "m4b_tag", name: "payment-tag" }).append(
      element({ name: "tag-content", tagName: "SPAN" }).append(
        element({ name: "tag-text", ownText: "Payment complete" }),
      ),
    ),
  );

  itemAndStatus.append(itemLine, paymentLine);

  // TikTok can place the price-bearing buyer summary beside a narrower
  // item/status wrapper. The exact Variation label and payment tag still
  // belong to the nearest enclosing row, where the sold price is available.
  const row147 = element({ name: "sold-item-row-147" }).append(
    buyerLine,
    buyerHandle,
    itemAndStatus,
  );
  const boundary = element({
    dataTid: "m4b_space",
    name: "sold-items-root",
  }).append(row147);
  const [located] = locatePaymentStatuses(boundary, parser);

  assert.equal(located.row, itemAndStatus);
  assert.equal(located.variationNumber, 147);
  assert.equal(located.observedPaymentStatus, "payment_complete");
  assert.equal(located.soldPriceCents, 1100);
});

test("never borrows a completed price across adjacent Sold Items rows", () => {
  const target = element({ name: "row-147-without-price" }).append(
    element({ ownText: "Variation: #147", tagName: "SPAN" }),
    element({ dataTid: "m4b_tag" }).append(text("Payment complete")),
  );
  const adjacent = createStatusRow({
    variationNumber: 148,
    soldPrice: "99.00",
    badgeText: "Payment complete",
  }).row;
  const list = element({ name: "sold-items-list" }).append(target, adjacent);
  const boundary = element({
    dataTid: "m4b_space",
    name: "sold-items-root",
  }).append(list);
  const located = locatePaymentStatuses(boundary, parser);
  const targetStatus = located.find(
    ({ variationNumber }) => variationNumber === 147,
  );

  assert.equal(targetStatus.row, target);
  assert.equal(targetStatus.observedPaymentStatus, "payment_complete");
  assert.equal(targetStatus.soldPriceCents, null);
});

test("ignores empty tags and rejects invalid payment-status dependencies", () => {
  const empty = createStatusRow({ badgeText: " \n " });
  const boundary = element({ name: "boundary" }).append(empty.row);

  assert.deepEqual(locatePaymentStatuses(boundary, parser), []);
  assert.throws(
    () => locatePaymentStatuses(null, parser),
    /queryable sale-capture boundary/i,
  );
  assert.throws(
    () => locatePaymentStatuses(boundary, null),
    /sale parser/i,
  );
});

test("rejects invalid Sold Items discovery and variation boundaries", () => {
  assert.throws(
    () => locateUniqueVisibleSoldItemsRoot(null),
    /queryable sale-capture boundary/i,
  );
  assert.throws(
    () => locateObservedVariations(null),
    /queryable sale-capture boundary/i,
  );
});

test("locates an exact completed badge and returns its parsed smallest row", () => {
  const { row } = createCompletedRow({ badgeText: "  Payment\n complete  " });
  const { boundary } = withinBoundary(row);

  Object.defineProperty(row, "innerText", {
    get() {
      throw new Error("innerText must not be read");
    },
  });

  assert.deepEqual(locateCompletedSales(boundary, parser), [
    {
      row,
      sale: {
        variationNumber: 250,
        soldPriceCents: 4800,
        paymentStatus: "payment_complete",
      },
    },
  ]);
});

test("matches the whole normalized badge text without case sensitivity", () => {
  for (const badgeText of [
    "payment complete",
    "PAYMENT COMPLETE",
    "  PaYmEnT\n CoMpLeTe  ",
  ]) {
    const { row } = createCompletedRow({ badgeText });
    const { boundary } = withinBoundary(row);

    assert.equal(locateCompletedSales(boundary, parser).length, 1);
  }
});

test("rejects badge text that is not exactly Payment complete after normalization", () => {
  for (const badgeText of [
    "Awaiting payment",
    "Payment complete now",
    "",
  ]) {
    const { row } = createCompletedRow({ badgeText });
    row.append(element({ ownText: "Payment complete", name: "unrelated-text" }));
    const { boundary } = withinBoundary(row);

    assert.deepEqual(locateCompletedSales(boundary, parser), []);
  }
});

test("ignores lookalike data attributes even when their text and row are valid", () => {
  for (const badgeDataTid of ["m4b_tag_extra", "M4B_TAG", null]) {
    const { row } = createCompletedRow({ badgeDataTid });
    const { boundary } = withinBoundary(row);

    assert.deepEqual(locateCompletedSales(boundary, parser), []);
  }
});

test("deduplicates duplicate completed tags that resolve to the same row", () => {
  const { row } = createCompletedRow({ duplicateBadge: true });
  const { boundary } = withinBoundary(row);
  const located = locateCompletedSales(boundary, parser);

  assert.equal(located.length, 1);
  assert.equal(located[0].row, row);
});

test("returns distinct parsed results for distinct sale rows", () => {
  const first = createCompletedRow({ variationNumber: 250 }).row;
  const second = createCompletedRow({
    variationNumber: 251,
    soldPrice: "20.00",
  }).row;
  const boundary = element({ name: "boundary" }).append(first, second);
  const located = locateCompletedSales(boundary, parser);

  assert.deepEqual(
    located.map(({ sale }) => sale),
    [
      {
        variationNumber: 250,
        soldPriceCents: 4800,
        paymentStatus: "payment_complete",
      },
      {
        variationNumber: 251,
        soldPriceCents: 2000,
        paymentStatus: "payment_complete",
      },
    ],
  );
});

test("accepts the twelfth ancestor but never climbs to the thirteenth", () => {
  function buildAtDepth(depth) {
    const { badge } = createCompletedRow();
    let root = badge;

    for (let index = 1; index < depth; index += 1) {
      root = element({ name: `wrapper-${index}` }).append(root);
    }

    const row = element({
      name: `row-at-${depth}`,
      ownText: "Example Buyer has won: $48.00 Variation: #250 ",
    }).append(root);
    const boundary = element({ name: "boundary" }).append(row);
    return { boundary, row };
  }

  const atLimit = buildAtDepth(MAX_ROW_ANCESTORS);
  assert.equal(locateCompletedSales(atLimit.boundary, parser)[0].row, atLimit.row);

  const beyondLimit = buildAtDepth(MAX_ROW_ANCESTORS + 1);
  assert.deepEqual(locateCompletedSales(beyondLimit.boundary, parser), []);
});

test("never parses or accepts the supplied boundary", () => {
  const { badge } = createCompletedRow();
  const wrapper = element({ name: "non-row-wrapper" }).append(badge);
  const boundary = element({
    name: "parseable-boundary",
    ownText: "Example Buyer has won: $48.00 Variation: #250 ",
  }).append(wrapper);
  const parsedNodes = [];
  const trackingParser = {
    parseSoldItemText(value) {
      parsedNodes.push(value);
      return parser.parseSoldItemText(value);
    },
  };

  assert.deepEqual(locateCompletedSales(boundary, trackingParser), []);
  assert.equal(parsedNodes.includes(boundary.textContent), false);
});

test("never climbs outside the supplied boundary", () => {
  const { badge } = createCompletedRow();
  const boundary = element({ name: "boundary" }).append(badge);
  const outsideRow = element({
    name: "outside-row",
    ownText: "Example Buyer has won: $48.00 Variation: #250 ",
  }).append(boundary);
  const outsideRoot = element({ name: "outside-root" }).append(outsideRow);

  assert.ok(outsideRoot.contains(badge));
  assert.deepEqual(locateCompletedSales(boundary, parser), []);
});

test("rejects invalid dependencies instead of broadening its search", () => {
  const boundary = element({ name: "boundary" });

  assert.throws(
    () => locateCompletedSales(null, parser),
    /queryable sale-capture boundary/i,
  );
  assert.throws(
    () => locateCompletedSales(boundary, null),
    /sale parser/i,
  );
});

test("a child-list addition is relevant when it is or contains the exact tag", () => {
  const direct = createCompletedRow().badge;
  const directBoundary = element({ name: "boundary" }).append(direct);
  assert.equal(
    mutationsMayAffectSale([childListRecord([direct])], directBoundary),
    true,
  );

  const subtree = createCompletedRow().row;
  const subtreeBoundary = element({ name: "boundary" }).append(subtree);
  assert.equal(
    mutationsMayAffectSale([childListRecord([subtree])], subtreeBoundary),
    true,
  );
});

test("an exact Variation label is relevant before a payment tag exists", () => {
  const label = element({
    ownText: "Variation: #252",
    tagName: "SPAN",
  });
  const row = element({ name: "pending-row" }).append(label);
  const boundary = element({ name: "boundary" }).append(row);

  assert.equal(
    mutationsMayAffectSale([childListRecord([label])], boundary),
    true,
  );
  assert.equal(
    mutationsMayAffectSale([childListRecord([row])], boundary),
    true,
  );
});

test("text-node additions and character changes inside the exact tag are relevant", () => {
  const { badge, badgeTextNode, row } = createCompletedRow();
  const boundary = element({ name: "boundary" }).append(row);

  assert.equal(
    mutationsMayAffectSale([childListRecord([badgeTextNode])], boundary),
    true,
  );
  assert.equal(
    mutationsMayAffectSale(
      [{ type: "characterData", target: badgeTextNode }],
      boundary,
    ),
    true,
  );

  const nestedText = text("Payment complete");
  badge.children = [];
  badge.append(element({ name: "nested" }).append(nestedText));
  assert.equal(
    mutationsMayAffectSale(
      [{ type: "characterData", target: nestedText }],
      boundary,
    ),
    true,
  );
});

test("price or variation text changes beside an existing exact tag are relevant", () => {
  const { row, summary } = createCompletedRow();
  const boundary = element({ name: "boundary" }).append(row);
  const changedText = text(" updated price");
  summary.append(changedText);

  assert.equal(
    mutationsMayAffectSale(
      [{ type: "characterData", target: changedText }],
      boundary,
    ),
    true,
  );
  assert.equal(
    mutationsMayAffectSale([childListRecord([changedText])], boundary),
    true,
  );
});

test("mutation relevance never broadens past the ancestor limit", () => {
  const { badge } = createCompletedRow();
  const changedText = text("updated price");
  let distantBranch = changedText;

  for (let index = 0; index < MAX_ROW_ANCESTORS; index += 1) {
    distantBranch = element({ name: `distant-wrapper-${index}` }).append(
      distantBranch,
    );
  }

  const broadContainer = element({ name: "broad-container" }).append(
    distantBranch,
    badge,
  );
  const boundary = element({ name: "boundary" }).append(broadContainer);

  assert.equal(
    mutationsMayAffectSale(
      [{ type: "characterData", target: changedText }],
      boundary,
    ),
    false,
  );
});

test("ignores unrelated and lookalike additions and character changes", () => {
  const unrelated = element({ ownText: "Payment complete", name: "chat" });
  const lookalike = element({
    dataTid: "m4b_tag_extra",
    ownText: "Payment complete",
    name: "lookalike",
  });
  const unrelatedText = text("Payment complete");
  unrelated.append(unrelatedText);
  const saleRow = createCompletedRow().row;
  const boundary = element({ name: "boundary" }).append(
    unrelated,
    lookalike,
    saleRow,
  );

  assert.equal(
    mutationsMayAffectSale(
      [childListRecord([unrelated]), childListRecord([lookalike])],
      boundary,
    ),
    false,
  );
  assert.equal(
    mutationsMayAffectSale(
      [{ type: "characterData", target: unrelatedText }],
      boundary,
    ),
    false,
  );
});

test("removed-only changes recheck a related badge or sale row", () => {
  const { badge, row, summary } = createCompletedRow();
  const boundary = element({ name: "boundary" }).append(row);
  const removedBadgeSuffix = text(" now");
  removedBadgeSuffix.parentElement = badge;
  removedBadgeSuffix.parentNode = badge;
  const removedDuplicateVariation = text(" Variation: #999");
  removedDuplicateVariation.parentElement = summary;
  removedDuplicateVariation.parentNode = summary;

  assert.equal(
    mutationsMayAffectSale(
      [childListRecord([], [removedBadgeSuffix])],
      boundary,
    ),
    true,
  );
  assert.equal(
    mutationsMayAffectSale(
      [childListRecord([], [removedDuplicateVariation])],
      boundary,
    ),
    true,
  );
});

test("ignores removed-only changes outside a sale candidate", () => {
  const chat = element({ name: "chat" });
  const removedChatText = text("viewer left");
  removedChatText.parentElement = chat;
  removedChatText.parentNode = chat;
  const saleRow = createCompletedRow().row;
  const boundary = element({ name: "boundary" }).append(chat, saleRow);

  assert.equal(
    mutationsMayAffectSale(
      [childListRecord([], [removedChatText])],
      boundary,
    ),
    false,
  );
});

test("ignores exact tags outside the boundary and nodes detached before inspection", () => {
  const outsideTag = createCompletedRow().badge;
  const boundary = element({ name: "boundary" });

  assert.equal(
    mutationsMayAffectSale([childListRecord([outsideTag])], boundary),
    false,
  );

  const detachedTag = createCompletedRow().badge;
  assert.equal(
    mutationsMayAffectSale([childListRecord([detachedTag])], boundary),
    false,
  );
});

test("returns false for empty and unsupported mutation sets", () => {
  const boundary = element({ name: "boundary" });

  assert.equal(mutationsMayAffectSale([], boundary), false);
  assert.equal(
    mutationsMayAffectSale(
      [{ type: "attributes", target: boundary }],
      boundary,
    ),
    false,
  );
});

test("fails toward recovery when mutation records or DOM inspection are unsafe", () => {
  const boundary = element({ name: "boundary" });
  const child = element({ name: "child" });
  boundary.append(child);

  assert.equal(mutationsMayAffectSale(null, boundary), true);
  assert.equal(mutationsMayAffectSale([null], boundary), true);
  assert.equal(mutationsMayAffectSale([], null), true);

  const malformedRecord = { type: "childList" };
  assert.equal(mutationsMayAffectSale([malformedRecord], boundary), true);

  const throwingBoundary = element({ name: "throwing-boundary" });
  throwingBoundary.contains = () => {
    throw new Error("contains failed");
  };
  assert.equal(
    mutationsMayAffectSale([childListRecord([child])], throwingBoundary),
    true,
  );

  const throwingNode = element({ name: "throwing-node" });
  const safeBoundary = element({ name: "safe-boundary" }).append(throwingNode);
  throwingNode.querySelector = () => {
    throw new Error("query failed");
  };
  assert.equal(
    mutationsMayAffectSale([childListRecord([throwingNode])], safeBoundary),
    true,
  );
});

test("source contains no class, heading, URL, or browser-I/O heuristics", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "extension",
      "capture",
      "sale-candidate-locator.js",
    ),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /innerText|Sold items|className|querySelector\([^)]*class|location|URLSearchParams|\bfetch\s*\(|XMLHttpRequest|runtime\.sendMessage|chrome\.storage/,
  );
});
