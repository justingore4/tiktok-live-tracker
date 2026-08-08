const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const parser = require("../extension/shared/sale-parser.js");
const {
  MAX_ROW_ANCESTORS,
  PAYMENT_TAG_SELECTOR,
  locateCompletedSales,
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
  constructor({ dataTid = null, ownText = "", name = "element" } = {}) {
    this.nodeType = 1;
    this.dataTid = dataTid;
    this.ownText = ownText;
    this.name = name;
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
    assert.equal(selector, PAYMENT_TAG_SELECTOR);
    return this.dataTid === "m4b_tag";
  }

  querySelectorAll(selector) {
    assert.equal(selector, PAYMENT_TAG_SELECTOR);
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
  assert.equal(MAX_ROW_ANCESTORS, 12);
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
