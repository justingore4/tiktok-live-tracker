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

    const SOLD_ITEMS_ROOT_SELECTOR = '[data-tid="m4b_space"]';
    const VARIATION_LABEL_SELECTOR = "span";
    const VARIATION_LABEL_PATTERN = /^Variation\s*:\s*#\s*(\d+)$/i;
    const PAYMENT_TAG_SELECTOR = '[data-tid="m4b_tag"]';
    const PAYMENT_COMPLETE_TEXT = "Payment complete";
    const PAYMENT_COMPLETE_NORMALIZED = PAYMENT_COMPLETE_TEXT.toLowerCase();
    const OBSERVED_PAYMENT_STATUSES = Object.freeze({
      NOT_OBSERVED: "not_observed",
      PAYMENT_PROCESSING: "payment_processing",
      PAYMENT_FIXING: "payment_fixing",
      PAYMENT_FAILED: "payment_failed",
      CANCELED: "canceled",
      PAYMENT_COMPLETE: "payment_complete",
      UNRECOGNIZED: "unrecognized",
    });
    const PAYMENT_STATUS_BY_TEXT = new Map([
      ["payment complete", OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE],
      ["canceled", OBSERVED_PAYMENT_STATUSES.CANCELED],
      ["payment failed", OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED],
      ["payment fixing", OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING],
      ["payment processing", OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING],
    ]);
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

    function isExactSelectorMatch(node, selector) {
      return (
        Boolean(node) &&
        typeof node.matches === "function" &&
        node.matches(selector)
      );
    }

    function isVisibleElement(node) {
      if (!node || typeof node.getBoundingClientRect !== "function") {
        return false;
      }

      const rect = node.getBoundingClientRect();

      return (
        Boolean(rect) &&
        typeof rect.width === "number" &&
        Number.isFinite(rect.width) &&
        rect.width > 0 &&
        typeof rect.height === "number" &&
        Number.isFinite(rect.height) &&
        rect.height > 0
      );
    }

    function locateUniqueVisibleSoldItemsRoot(boundary) {
      requireBoundary(boundary);

      try {
        const candidates = boundary.querySelectorAll(
          SOLD_ITEMS_ROOT_SELECTOR,
        );
        const visibleRoots = [];

        for (const candidate of candidates) {
          if (
            !isInsideBoundary(candidate, boundary) ||
            !isExactSelectorMatch(candidate, SOLD_ITEMS_ROOT_SELECTOR) ||
            !isVisibleElement(candidate)
          ) {
            continue;
          }

          visibleRoots.push(candidate);

          if (visibleRoots.length > 1) {
            return Object.freeze({ root: null, status: "ambiguous" });
          }
        }

        if (visibleRoots.length === 0) {
          return Object.freeze({ root: null, status: "not_found" });
        }

        return Object.freeze({ root: visibleRoots[0], status: "found" });
      } catch {
        return Object.freeze({ root: null, status: "unsafe" });
      }
    }

    function locateObservedVariations(boundary) {
      requireBoundary(boundary);

      const results = [];
      const labels = boundary.querySelectorAll(VARIATION_LABEL_SELECTOR);

      for (const label of labels) {
        if (!isInsideBoundary(label, boundary)) {
          continue;
        }

        const match = normalizeText(label.textContent).match(
          VARIATION_LABEL_PATTERN,
        );

        if (!match) {
          continue;
        }

        const variationNumber = Number(match[1]);

        if (
          !Number.isSafeInteger(variationNumber) ||
          variationNumber < 1
        ) {
          continue;
        }

        results.push(Object.freeze({ label, variationNumber }));
      }

      return results;
    }

    function exactVariationLabels(boundary) {
      const results = [];

      for (const label of boundary.querySelectorAll(VARIATION_LABEL_SELECTOR)) {
        if (!isInsideBoundary(label, boundary)) {
          continue;
        }

        const match = normalizeText(label.textContent).match(
          VARIATION_LABEL_PATTERN,
        );

        if (!match) {
          continue;
        }

        const variationNumber = Number(match[1]);

        if (Number.isSafeInteger(variationNumber) && variationNumber > 0) {
          results.push({ label, variationNumber });
        }
      }

      return results;
    }

    function exactPaymentTags(boundary) {
      return [...boundary.querySelectorAll(PAYMENT_TAG_SELECTOR)].filter(
        (tag) =>
          isInsideBoundary(tag, boundary) && isExactPaymentTag(tag),
      );
    }

    function requireParser(parser) {
      if (!parser || typeof parser.parseSoldItemText !== "function") {
        throw new TypeError("A sale parser with parseSoldItemText is required.");
      }
    }

    function isExactPaymentTag(node) {
      return isExactSelectorMatch(node, PAYMENT_TAG_SELECTOR);
    }

    function isVariationLabelElement(node) {
      return isExactSelectorMatch(node, VARIATION_LABEL_SELECTOR);
    }

    function isExactVariationLabel(node) {
      return (
        isVariationLabelElement(node) &&
        VARIATION_LABEL_PATTERN.test(normalizeText(node.textContent))
      );
    }

    function containsExactVariationLabel(node) {
      if (typeof node?.querySelectorAll !== "function") {
        return false;
      }

      for (const candidate of node.querySelectorAll(VARIATION_LABEL_SELECTOR)) {
        if (isExactVariationLabel(candidate)) {
          return true;
        }
      }

      return false;
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

    function locatePaymentStatuses(boundary, parser) {
      requireBoundary(boundary);
      requireParser(parser);

      const candidatesByVariation = new Map();
      const tags = boundary.querySelectorAll(PAYMENT_TAG_SELECTOR);

      for (const tag of tags) {
        if (!isInsideBoundary(tag, boundary) || !isExactPaymentTag(tag)) {
          continue;
        }

        const normalizedText = normalizeText(tag.textContent);

        if (normalizedText === "") {
          continue;
        }

        const observedPaymentStatus =
          PAYMENT_STATUS_BY_TEXT.get(normalizedText.toLowerCase()) ??
          OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED;
        let candidate = tag.parentElement;
        let locatedAssociation = null;
        let soldPriceCents = null;
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
          const variationLabels = exactVariationLabels(candidate);
          const paymentTags = exactPaymentTags(candidate);
          const isExactAssociation =
            variationLabels.length === 1 &&
            paymentTags.length === 1 &&
            paymentTags[0] === tag;

          if (!locatedAssociation && isExactAssociation) {
            const variationNumber = variationLabels[0].variationNumber;

            locatedAssociation = Object.freeze({
              row: candidate,
              variationNumber,
            });

            if (
              observedPaymentStatus !==
              OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE
            ) {
              break;
            }
          } else if (
            locatedAssociation &&
            (!isExactAssociation ||
              variationLabels[0].variationNumber !==
                locatedAssociation.variationNumber)
          ) {
            // Do not cross into a parent containing another sale row. A
            // completed badge may need a wider ancestor for the winner price,
            // but that ancestor must still identify the same single row.
            break;
          }

          if (locatedAssociation) {
            if (
              observedPaymentStatus ===
              OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE
            ) {
              const sale = parser.parseSoldItemText(
                candidate.textContent ?? "",
              );

              if (
                sale?.variationNumber ===
                  locatedAssociation.variationNumber &&
                sale.paymentStatus ===
                  OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE &&
                Number.isSafeInteger(sale.soldPriceCents) &&
                sale.soldPriceCents > 0
              ) {
                soldPriceCents = sale.soldPriceCents;
                break;
              }
            }
          }

          candidate = candidate.parentElement;
        }

        if (!locatedAssociation) {
          continue;
        }

        const { row, variationNumber } = locatedAssociation;
        const result = Object.freeze({
          row,
          variationNumber,
          observedPaymentStatus,
          soldPriceCents,
        });

        if (!candidatesByVariation.has(variationNumber)) {
          candidatesByVariation.set(variationNumber, result);
        } else if (
          candidatesByVariation.get(variationNumber)?.row !== row
        ) {
          candidatesByVariation.set(variationNumber, null);
        }
      }

      return [...candidatesByVariation.values()].filter(Boolean);
    }

    function nodeMayAffectSale(node, boundary) {
      if (!isInsideBoundary(node, boundary)) {
        return false;
      }

      if (isExactPaymentTag(node)) {
        return true;
      }

      if (isExactVariationLabel(node)) {
        return true;
      }

      if (
        typeof node.querySelector === "function" &&
        node.querySelector(PAYMENT_TAG_SELECTOR)
      ) {
        return true;
      }


      if (containsExactVariationLabel(node)) {
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

        if (isExactVariationLabel(ancestor)) {
          return true;
        }

        if (
          typeof ancestor.querySelector === "function" &&
          ancestor.querySelector(PAYMENT_TAG_SELECTOR)
        ) {
          return true;
        }


        if (containsExactVariationLabel(ancestor)) {
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
      OBSERVED_PAYMENT_STATUSES,
      PAYMENT_TAG_SELECTOR,
      SOLD_ITEMS_ROOT_SELECTOR,
      VARIATION_LABEL_SELECTOR,
      locateCompletedSales,
      locateObservedVariations,
      locatePaymentStatuses,
      locateUniqueVisibleSoldItemsRoot,
      mutationsMayAffectSale,
    });
  },
);
