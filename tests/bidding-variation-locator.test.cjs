const assert = require("node:assert/strict");
const test = require("node:test");

const locator = require(
  "../extension/capture/bidding-variation-locator.js",
);

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.textContent = value;
    this.parentNode = null;
  }
}

class FakeElement {
  constructor({
    ariaHidden = false,
    className = "",
    height = 20,
    hidden = false,
    ownText = "",
    width = 100,
  } = {}) {
    this.nodeType = 1;
    this.ariaHidden = ariaHidden;
    this.className = className;
    this.height = height;
    this.hidden = hidden;
    this.width = width;
    this.childNodes = [];
    this.parentNode = null;

    if (ownText !== "") {
      this.append(new FakeText(ownText));
    }
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }

    return this;
  }

  getAttribute(name) {
    if (name === "class") {
      return this.className;
    }

    if (name === "aria-hidden") {
      return this.ariaHidden ? "true" : null;
    }

    return null;
  }

  matches(selector) {
    if (selector === locator.AUCTION_CARD_SELECTOR) {
      return this.className.split(/\s+/).includes("auction-pin-card");
    }

    if (selector === locator.OWN_TEXT_ELEMENT_SELECTOR) {
      return true;
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
    let current = candidate;

    while (current) {
      if (current === this) {
        return true;
      }

      current = current.parentNode;
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

function createAuctionCard({
  className = "auction-pin-card flex rounded-8",
  title = "#237 ITEMS SHOWN ON SCREEN/ ALL SALES FINAL/ 8-9",
} = {}) {
  const root = element({ className });
  const image = element();
  const details = element();
  const titleElement = element({ ownText: title });
  const bids = element({ ownText: "6 bids" });

  details.append(titleElement, bids);
  root.append(image, details);
  return { bids, root, titleElement };
}

test("locates the visible semantic auction card and returns only its variation number", () => {
  const body = element();
  const auction = createAuctionCard();
  body.append(auction.root);

  const result = locator.locateUniqueVisibleBiddingVariation(body);

  assert.deepEqual(
    { status: result.status, variationNumber: result.variationNumber },
    { status: "found", variationNumber: 237 },
  );
  assert.equal(result.root, auction.root);
  assert.deepEqual(Object.keys(result).sort(), [
    "root",
    "status",
    "variationNumber",
  ]);
});

test("requires exactly one visible auction-pin-card token boundary", () => {
  const body = element();
  const hidden = createAuctionCard();
  hidden.root.width = 0;
  const visible = createAuctionCard({ title: "#238 Next item" });
  body.append(hidden.root, visible.root);

  assert.equal(
    locator.locateUniqueVisibleBiddingVariation(body).variationNumber,
    238,
  );

  body.append(createAuctionCard({ title: "#239 Another item" }).root);
  assert.equal(
    locator.locateUniqueVisibleBiddingVariation(body).status,
    "ambiguous",
  );

  const lookalike = element().append(
    createAuctionCard({
      className: "auction-pin-card-copy sc-generated",
      title: "#999 Wrong boundary",
    }).root,
  );
  assert.equal(
    locator.locateUniqueVisibleBiddingVariation(lookalike).status,
    "not_found",
  );
});

test("requires one visible direct-own-text match and fails closed on ambiguity", () => {
  const body = element();
  const auction = createAuctionCard();
  auction.root.append(element({ ownText: "#238 Duplicate variation" }));
  body.append(auction.root);

  assert.equal(
    locator.locateUniqueVisibleBiddingVariation(body).status,
    "ambiguous",
  );

  const hiddenDuplicateBody = element();
  const withHiddenDuplicate = createAuctionCard();
  withHiddenDuplicate.root.append(
    element({ ownText: "#238 Hidden duplicate", width: 0 }),
  );
  hiddenDuplicateBody.append(withHiddenDuplicate.root);
  assert.equal(
    locator.locateUniqueVisibleBiddingVariation(hiddenDuplicateBody)
      .variationNumber,
    237,
  );
});

test("accepts only a positive safe integer immediately after the leading hash", () => {
  for (const [value, expected] of [
    ["#1", 1],
    ["#252 bidding", 252],
    ["  #237\nITEMS SHOWN ", 237],
  ]) {
    assert.equal(locator.parseBiddingVariationNumber(value.trim()), expected);
  }

  for (const value of [
    "Variation #237",
    "# 237 item",
    "#0 item",
    "#01 item",
    "#237item",
    "-$237",
    "#9007199254740992 item",
    "",
    null,
  ]) {
    assert.equal(locator.parseBiddingVariationNumber(value), null);
  }
});

test("reads only own text and does not depend on TikTok generated classes", () => {
  const body = element();
  const auction = createAuctionCard({
    className: "sc-ehixzo auction-pin-card kwQsFs flex",
  });
  Object.defineProperty(body, "textContent", {
    get() {
      throw new Error("dashboard aggregate text must not be read");
    },
  });
  Object.defineProperty(auction.root, "textContent", {
    get() {
      throw new Error("auction aggregate text must not be read");
    },
  });
  body.append(auction.root);

  assert.equal(
    locator.locateUniqueVisibleBiddingVariation(body).variationNumber,
    237,
  );
});
