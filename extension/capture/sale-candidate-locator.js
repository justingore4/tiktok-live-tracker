(function initializeSaleCandidateLocator(root, factory) {
  const locator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = locator;
  }

  root.TikTokLiveTrackerSaleCandidateLocator = locator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createSaleCandidateLocatorModule() {
    "use strict";

    const PAYMENT_TAG_SELECTOR = '[data-tid="m4b_tag"]';
    const PAYMENT_COMPLETE_TEXT = "Payment complete";
    const PAYMENT_COMPLETE_NORMALIZED = PAYMENT_COMPLETE_TEXT.toLowerCase();
    const MAX_ROW_ANCESTORS = 12;

    function normalizeText(value) {
      return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function requireBoundary(boundary) {
      if (!boundary || typeof boundary.querySelectorAll !== "function") {
        throw new TypeError("A queryable sale-capture boundary is required.");
      }
    }

    function requireParser(parser) {
      if (!parser || typeof parser.parseSoldItemText !== "function") {
        throw new TypeError("A sale parser with parseSoldItemText is required.");
      }
    }

    function isExactPaymentTag(node) {
      return (
        Boolean(node) &&
        typeof node.matches === "function" &&
        node.matches(PAYMENT_TAG_SELECTOR)
      );
    }

    function isInsideBoundary(node, boundary) {
      if (!node) {
        return false;
      }

      if (node === boundary) {
        return true;
      }

      if (typeof boundary.contains !== "function") {
        throw new TypeError("The sale-capture boundary must support contains().");
      }

      return boundary.contains(node);
    }

    function locateCompletedSales(boundary, parser) {
      requireBoundary(boundary);
      requireParser(parser);

      const results = [];
      const locatedRows = new Set();
      const tags = boundary.querySelectorAll(PAYMENT_TAG_SELECTOR);

      for (const tag of tags) {
        if (
          !isInsideBoundary(tag, boundary) ||
          !isExactPaymentTag(tag) ||
          normalizeText(tag.textContent).toLowerCase() !==
            PAYMENT_COMPLETE_NORMALIZED
        ) {
          continue;
        }

        let candidate = tag.parentElement;
        const visited = new Set();

        for (
          let ancestorCount = 0;
          candidate &&
          candidate !== boundary &&
          ancestorCount < MAX_ROW_ANCESTORS;
          ancestorCount += 1
        ) {
          if (visited.has(candidate) || !isInsideBoundary(candidate, boundary)) {
            break;
          }

          visited.add(candidate);
          const sale = parser.parseSoldItemText(candidate.textContent ?? "");

          if (sale?.paymentStatus === "payment_complete") {
            if (!locatedRows.has(candidate)) {
              locatedRows.add(candidate);
              results.push({ row: candidate, sale });
            }

            break;
          }

          candidate = candidate.parentElement;
        }
      }

      return results;
    }

    function nodeMayAffectSale(node, boundary) {
      if (!isInsideBoundary(node, boundary)) {
        return false;
      }

      if (isExactPaymentTag(node)) {
        return true;
      }

      if (
        typeof node.querySelector === "function" &&
        node.querySelector(PAYMENT_TAG_SELECTOR)
      ) {
        return true;
      }

      const visited = new Set();
      let ancestor = node.parentElement ?? node.parentNode ?? null;
      let ancestorCount = 0;

      while (
        ancestor &&
        ancestor !== boundary &&
        ancestorCount < MAX_ROW_ANCESTORS
      ) {
        if (visited.has(ancestor)) {
          return false;
        }

        visited.add(ancestor);
        ancestorCount += 1;

        if (isExactPaymentTag(ancestor)) {
          return true;
        }

        if (
          typeof ancestor.querySelector === "function" &&
          ancestor.querySelector(PAYMENT_TAG_SELECTOR)
        ) {
          return true;
        }

        ancestor = ancestor.parentElement ?? ancestor.parentNode ?? null;
      }

      return false;
    }

    function mutationsMayAffectSale(records, boundary) {
      try {
        if (!boundary || typeof boundary.contains !== "function") {
          return true;
        }

        if (!records || typeof records[Symbol.iterator] !== "function") {
          return true;
        }

        for (const record of records) {
          if (!record || typeof record !== "object") {
            return true;
          }

          if (record.type === "characterData") {
            if (nodeMayAffectSale(record.target, boundary)) {
              return true;
            }

            continue;
          }

          if (record.type !== "childList") {
            continue;
          }

          const addedNodes = record.addedNodes;
          const removedNodes = record.removedNodes;

          if (
            !addedNodes ||
            typeof addedNodes[Symbol.iterator] !== "function" ||
            !removedNodes ||
            typeof removedNodes[Symbol.iterator] !== "function"
          ) {
            return true;
          }

          for (const addedNode of addedNodes) {
            if (nodeMayAffectSale(addedNode, boundary)) {
              return true;
            }
          }

          let hasRemovedNodes = false;

          for (const _removedNode of removedNodes) {
            hasRemovedNodes = true;
            break;
          }

          if (
            hasRemovedNodes &&
            nodeMayAffectSale(record.target, boundary)
          ) {
            return true;
          }
        }

        return false;
      } catch {
        return true;
      }
    }

    return Object.freeze({
      MAX_ROW_ANCESTORS,
      PAYMENT_TAG_SELECTOR,
      locateCompletedSales,
      mutationsMayAffectSale,
    });
  },
);
