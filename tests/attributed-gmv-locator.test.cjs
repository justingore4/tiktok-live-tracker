const assert = require("node:assert/strict");
const test = require("node:test");

const locator = require(
  "../extension/capture/attributed-gmv-locator.js",
);

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.textContent = value;
    this.parentElement = null;
    this.parentNode = null;
  }
}

class FakeElement {
  constructor({
    ariaHidden = false,
    height = 20,
    hidden = false,
    id = null,
    ownText = "",
    tagName = "DIV",
    width = 100,
  } = {}) {
    this.nodeType = 1;
    this.ariaHidden = ariaHidden;
    this.height = height;
    this.hidden = hidden;
    this.id = id;
    this.tagName = tagName;
    this.width = width;
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;

    if (ownText !== "") {
      this.append(new FakeText(ownText));
    }
  }

  append(...nodes) {
    nodes.forEach((node) => {
      node.parentElement = this;
      node.parentNode = this;
      this.childNodes.push(node);
    });

    return this;
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    const index = siblings.indexOf(this);

    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  getAttribute(name) {
    if (name === "id") {
      return this.id;
    }

    if (name === "aria-hidden") {
      return this.ariaHidden ? "true" : null;
    }

    return null;
  }

  matches(selector) {
    if (selector === locator.ATTRIBUTED_GMV_ROOT_SELECTOR) {
      return this.id === "guide-Step-2" || this.id === "guide-step-2";
    }

    if (selector === locator.METRIC_ELEMENT_SELECTOR) {
      return this.tagName === "DIV" || this.tagName === "SPAN";
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

      node.childNodes.forEach(visit);
    }

    this.childNodes.forEach(visit);
    return matches;
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

  getBoundingClientRect() {
    return { height: this.height, width: this.width };
  }
}

function element(options) {
  return new FakeElement(options);
}

function createMetric({
  display = "$4.64K",
  id = "guide-Step-2",
  rootOptions = {},
} = {}) {
  const root = element({ id, ...rootOptions });
  const card = element();
  const label = element({ ownText: "Attributed GMV" });
  const valueRegion = element();
  const value = element({ ownText: display });
  const detail = element().append(
    element({ tagName: "SPAN", ownText: "Auction" }),
    element({ tagName: "SPAN", ownText: display }),
  );

  valueRegion.append(value);
  card.append(label, valueRegion, detail);
  root.append(card);

  return { card, detail, label, root, value, valueRegion };
}

test("locates the exact semantic Attributed GMV card with its current capitalized guide ID", () => {
  const body = element();
  const metric = createMetric({ display: "$4.64K" });
  body.append(metric.root);

  const result = locator.locateUniqueVisibleAttributedGmv(body);

  assert.equal(result.status, "found");
  assert.equal(result.root, metric.root);
  assert.equal(result.attributedGmvDisplay, "$4.64K");
});

test("supports an exact canonical amount and the explicit lowercase guide-ID fallback", () => {
  const body = element();
  body.append(
    createMetric({
      display: "$4,087.01",
      id: "guide-step-2",
    }).root,
  );

  assert.deepEqual(
    {
      status: locator.locateUniqueVisibleAttributedGmv(body).status,
      display:
        locator.locateUniqueVisibleAttributedGmv(body)
          .attributedGmvDisplay,
    },
    { status: "found", display: "$4,087.01" },
  );
});

test("reads only the primary value sibling and ignores Auction, Sold Items, and Chat money", () => {
  const body = element();
  const metric = createMetric({ display: "$4.64K" });
  const soldItems = element({ id: "m4b_space" }).append(
    element({ ownText: "Buyer has won: $999.00" }),
  );
  const chat = element({ id: "dashboard-guide-chat" }).append(
    element({ ownText: "$19.00" }),
  );

  body.append(soldItems, metric.root, chat);

  const result = locator.locateUniqueVisibleAttributedGmv(body);

  assert.equal(result.status, "found");
  assert.equal(result.attributedGmvDisplay, "$4.64K");
});

test("ignores hidden roots but fails closed for duplicate visible roots", () => {
  const body = element();
  body.append(
    createMetric({ rootOptions: { width: 0 } }).root,
    createMetric({ display: "$5.00K" }).root,
  );

  assert.equal(
    locator.locateUniqueVisibleAttributedGmv(body).attributedGmvDisplay,
    "$5.00K",
  );

  body.append(createMetric({ display: "$6.00K" }).root);
  const ambiguous = locator.locateUniqueVisibleAttributedGmv(body);

  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.attributedGmvDisplay, null);
});

test("fails closed for duplicate labels or duplicate primary values", () => {
  const duplicateLabelBody = element();
  const duplicateLabelMetric = createMetric();
  duplicateLabelMetric.card.append(
    element({ ownText: "Attributed GMV" }),
  );
  duplicateLabelBody.append(duplicateLabelMetric.root);

  assert.equal(
    locator.locateUniqueVisibleAttributedGmv(duplicateLabelBody).status,
    "ambiguous",
  );

  const duplicateValueBody = element();
  const duplicateValueMetric = createMetric();
  duplicateValueMetric.valueRegion.append(
    element({ ownText: "$4.65K" }),
  );
  duplicateValueBody.append(duplicateValueMetric.root);

  assert.equal(
    locator.locateUniqueVisibleAttributedGmv(duplicateValueBody).status,
    "ambiguous",
  );
});

test("accepts only canonical exact or compact USD displays", () => {
  for (const display of [
    "$0.00",
    "$999.99",
    "$4,087.01",
    "$1K",
    "$4.6M",
    "$4.64K",
    "$1B",
  ]) {
    assert.equal(locator.sanitizeAttributedGmvDisplay(display), display);
  }

  for (const display of [
    "$1000.00",
    "$4,87.01",
    "$4.640K",
    "$ 4.64K",
    "-$4.64K",
    "USD 4.64K",
    "4.64K",
    "$4.64K shipping",
    "$4.64T",
    "",
    null,
  ]) {
    assert.equal(locator.sanitizeAttributedGmvDisplay(display), null);
  }
});

test("does not use aggregate descendant text or generated classes", () => {
  const body = element();
  const metric = createMetric();

  Object.defineProperty(metric.card, "textContent", {
    get() {
      throw new Error("broad card text must not be read");
    },
  });
  Object.defineProperty(body, "textContent", {
    get() {
      throw new Error("dashboard text must not be read");
    },
  });
  body.append(metric.root);

  assert.equal(
    locator.locateUniqueVisibleAttributedGmv(body).attributedGmvDisplay,
    "$4.64K",
  );
});
