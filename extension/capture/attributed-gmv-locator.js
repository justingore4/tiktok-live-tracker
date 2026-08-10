(function initializeAttributedGmvLocator(root, factory) {
  const locator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = locator;
  }

  root.TikTokLiveTrackerAttributedGmvLocator = locator;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createAttributedGmvLocatorModule() {
    "use strict";

    // TikTok currently capitalizes this guide target as `guide-Step-2`.
    // Keep the previously observed lowercase spelling as an explicit fallback;
    // a case-insensitive or substring selector would make this boundary wider.
    const ATTRIBUTED_GMV_ROOT_IDS = new Set([
      "guide-Step-2",
      "guide-step-2",
    ]);
    const ATTRIBUTED_GMV_ROOT_SELECTOR =
      '[id="guide-Step-2"],[id="guide-step-2"]';
    const METRIC_ELEMENT_SELECTOR = "div,span";
    const ATTRIBUTED_GMV_LABEL = "Attributed GMV";
    const MAX_DISPLAY_LENGTH = 24;
    const EXACT_USD_PATTERN =
      /^\$(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}$/;
    const COMPACT_USD_PATTERN =
      /^\$(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB]$/;

    function normalizeOwnText(node) {
      if (!node?.childNodes || typeof node.childNodes[Symbol.iterator] !== "function") {
        return "";
      }

      let value = "";

      for (const child of node.childNodes) {
        if (child?.nodeType === 3) {
          value += String(child.textContent ?? "");
        }
      }

      return value.replace(/\s+/g, " ").trim();
    }

    function sanitizeAttributedGmvDisplay(value) {
      if (typeof value !== "string") {
        return null;
      }

      const normalized = value.replace(/\s+/g, " ").trim();

      if (
        normalized.length === 0 ||
        normalized.length > MAX_DISPLAY_LENGTH ||
        (!EXACT_USD_PATTERN.test(normalized) &&
          !COMPACT_USD_PATTERN.test(normalized))
      ) {
        return null;
      }

      return normalized;
    }

    function requireBoundary(boundary) {
      if (!boundary || typeof boundary.querySelectorAll !== "function") {
        throw new TypeError("A queryable dashboard boundary is required.");
      }
    }

    function isInsideBoundary(node, boundary) {
      if (!node) {
        return false;
      }

      if (node === boundary) {
        return true;
      }

      if (typeof boundary.contains !== "function") {
        throw new TypeError("The dashboard boundary must support contains().");
      }

      return boundary.contains(node);
    }

    function readElementId(node) {
      if (typeof node?.getAttribute === "function") {
        return node.getAttribute("id");
      }

      return typeof node?.id === "string" ? node.id : null;
    }

    function isVisibleElement(node) {
      if (!node || typeof node.getBoundingClientRect !== "function") {
        return false;
      }

      if (
        node.hidden === true ||
        (typeof node.getAttribute === "function" &&
          node.getAttribute("aria-hidden") === "true")
      ) {
        return false;
      }

      const rect = node.getBoundingClientRect();

      return (
        Boolean(rect) &&
        Number.isFinite(rect.width) &&
        rect.width > 0 &&
        Number.isFinite(rect.height) &&
        rect.height > 0
      );
    }

    function locateUniqueVisibleAttributedGmv(boundary) {
      requireBoundary(boundary);

      try {
        const visibleRoots = [];

        for (const candidate of boundary.querySelectorAll(
          ATTRIBUTED_GMV_ROOT_SELECTOR,
        )) {
          if (
            !isInsideBoundary(candidate, boundary) ||
            !ATTRIBUTED_GMV_ROOT_IDS.has(readElementId(candidate)) ||
            !isVisibleElement(candidate)
          ) {
            continue;
          }

          visibleRoots.push(candidate);

          if (visibleRoots.length > 1) {
            return Object.freeze({
              attributedGmvDisplay: null,
              root: null,
              status: "ambiguous",
            });
          }
        }

        if (visibleRoots.length === 0) {
          return Object.freeze({
            attributedGmvDisplay: null,
            root: null,
            status: "not_found",
          });
        }

        const metricRoot = visibleRoots[0];
        const labels = [];

        for (const candidate of metricRoot.querySelectorAll(
          METRIC_ELEMENT_SELECTOR,
        )) {
          if (
            isInsideBoundary(candidate, metricRoot) &&
            isVisibleElement(candidate) &&
            normalizeOwnText(candidate) === ATTRIBUTED_GMV_LABEL
          ) {
            labels.push(candidate);

            if (labels.length > 1) {
              return Object.freeze({
                attributedGmvDisplay: null,
                root: metricRoot,
                status: "ambiguous",
              });
            }
          }
        }

        if (labels.length !== 1) {
          return Object.freeze({
            attributedGmvDisplay: null,
            root: metricRoot,
            status: "not_found",
          });
        }

        // The screenshot's stable semantic relationship is label followed by
        // its primary-value container. Staying inside that immediate sibling
        // deliberately excludes the later `Auction $...` detail row.
        const valueRegion = labels[0].nextElementSibling;

        if (
          !valueRegion ||
          !isInsideBoundary(valueRegion, metricRoot) ||
          !isVisibleElement(valueRegion)
        ) {
          return Object.freeze({
            attributedGmvDisplay: null,
            root: metricRoot,
            status: "not_found",
          });
        }

        const valueCandidates = [];
        const possibleValues = [
          valueRegion,
          ...valueRegion.querySelectorAll(METRIC_ELEMENT_SELECTOR),
        ];

        for (const candidate of possibleValues) {
          if (
            !isInsideBoundary(candidate, valueRegion) ||
            !isVisibleElement(candidate)
          ) {
            continue;
          }

          const attributedGmvDisplay = sanitizeAttributedGmvDisplay(
            normalizeOwnText(candidate),
          );

          if (attributedGmvDisplay !== null) {
            valueCandidates.push(attributedGmvDisplay);

            if (valueCandidates.length > 1) {
              return Object.freeze({
                attributedGmvDisplay: null,
                root: metricRoot,
                status: "ambiguous",
              });
            }
          }
        }

        if (valueCandidates.length !== 1) {
          return Object.freeze({
            attributedGmvDisplay: null,
            root: metricRoot,
            status: "not_found",
          });
        }

        return Object.freeze({
          attributedGmvDisplay: valueCandidates[0],
          root: metricRoot,
          status: "found",
        });
      } catch {
        return Object.freeze({
          attributedGmvDisplay: null,
          root: null,
          status: "unsafe",
        });
      }
    }

    return Object.freeze({
      ATTRIBUTED_GMV_LABEL,
      ATTRIBUTED_GMV_ROOT_SELECTOR,
      COMPACT_USD_PATTERN,
      EXACT_USD_PATTERN,
      MAX_DISPLAY_LENGTH,
      METRIC_ELEMENT_SELECTOR,
      locateUniqueVisibleAttributedGmv,
      normalizeOwnText,
      sanitizeAttributedGmvDisplay,
    });
  },
);
