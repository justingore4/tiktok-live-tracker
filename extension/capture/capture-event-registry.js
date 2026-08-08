(function initializeCaptureEventRegistry(root, factory) {
  const captureEventRegistry = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = captureEventRegistry;
  }

  root.TikTokLiveTrackerCaptureEventRegistry = captureEventRegistry;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createCaptureEventRegistryModule() {
    "use strict";

    const SCOPE_KINDS = Object.freeze({
      PAGE: "page",
      VERIFIED_STREAM: "verified_stream",
    });
    const scopeMetadata = new WeakMap();

    function requireOpaqueId(value, fieldName) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${fieldName} must be a non-empty string.`);
      }

      return value;
    }

    function createVerifiedStreamScope(streamId) {
      const id = requireOpaqueId(streamId, "streamId");
      const scope = Object.freeze({
        kind: SCOPE_KINDS.VERIFIED_STREAM,
        verified: true,
        streamId: id,
      });

      scopeMetadata.set(scope, {
        id,
        kind: SCOPE_KINDS.VERIFIED_STREAM,
      });
      return scope;
    }

    function createPageScope(pageScopeId) {
      const id = requireOpaqueId(pageScopeId, "pageScopeId");
      const scope = Object.freeze({
        kind: SCOPE_KINDS.PAGE,
        pageScopeId: id,
        verified: false,
      });

      scopeMetadata.set(scope, { id, kind: SCOPE_KINDS.PAGE });
      return scope;
    }

    function requireSale(sale) {
      if (!sale || typeof sale !== "object" || Array.isArray(sale)) {
        throw new TypeError("sale must be an object.");
      }

      if (
        !Number.isSafeInteger(sale.variationNumber) ||
        sale.variationNumber < 1
      ) {
        throw new TypeError(
          "sale.variationNumber must be a positive safe integer.",
        );
      }

      if (
        !Number.isSafeInteger(sale.soldPriceCents) ||
        sale.soldPriceCents < 0
      ) {
        throw new TypeError(
          "sale.soldPriceCents must be a non-negative safe integer.",
        );
      }

      if (
        typeof sale.paymentStatus !== "string" ||
        sale.paymentStatus.trim() === ""
      ) {
        throw new TypeError(
          "sale.paymentStatus must be a non-empty string.",
        );
      }

      return {
        variationNumber: sale.variationNumber,
        fingerprint: Object.freeze({
          soldPriceCents: sale.soldPriceCents,
          paymentStatus: sale.paymentStatus,
        }),
      };
    }

    function fingerprintsMatch(left, right) {
      return (
        left.soldPriceCents === right.soldPriceCents &&
        left.paymentStatus === right.paymentStatus
      );
    }

    function hasConflictFingerprint(entry, fingerprint) {
      return (
        entry.conflictsByPaymentStatus
          .get(fingerprint.paymentStatus)
          ?.has(fingerprint.soldPriceCents) ?? false
      );
    }

    function addConflictFingerprint(entry, fingerprint) {
      let prices = entry.conflictsByPaymentStatus.get(
        fingerprint.paymentStatus,
      );

      if (!prices) {
        prices = new Set();
        entry.conflictsByPaymentStatus.set(fingerprint.paymentStatus, prices);
      }

      prices.add(fingerprint.soldPriceCents);
    }

    function createResult(
      status,
      metadata,
      variationNumber,
      retainedFingerprint,
      observedFingerprint,
    ) {
      const scopeFields = metadata.kind === SCOPE_KINDS.VERIFIED_STREAM
        ? { streamId: metadata.id }
        : { pageScopeId: metadata.id };
      const verified = metadata.kind === SCOPE_KINDS.VERIFIED_STREAM;

      return Object.freeze({
        status,
        scopeKind: metadata.kind,
        verified,
        identityStatus: verified ? "verified" : "unverified",
        dedupeScope: verified ? "stream" : "page_load",
        ...scopeFields,
        variationNumber,
        retainedFingerprint,
        observedFingerprint,
      });
    }

    function createCaptureEventRegistry() {
      const entriesByScopeKind = new Map([
        [SCOPE_KINDS.PAGE, new Map()],
        [SCOPE_KINDS.VERIFIED_STREAM, new Map()],
      ]);

      function record(scope, sale) {
        const metadata = scope && typeof scope === "object"
          ? scopeMetadata.get(scope)
          : null;

        if (!metadata) {
          throw new TypeError(
            "scope must be created by createVerifiedStreamScope or createPageScope.",
          );
        }

        const { variationNumber, fingerprint } = requireSale(sale);
        const entriesByScopeId = entriesByScopeKind.get(metadata.kind);
        let entriesByVariation = entriesByScopeId.get(metadata.id);

        if (!entriesByVariation) {
          entriesByVariation = new Map();
          entriesByScopeId.set(metadata.id, entriesByVariation);
        }

        const existing = entriesByVariation.get(variationNumber);

        if (!existing) {
          entriesByVariation.set(variationNumber, {
            conflictsByPaymentStatus: new Map(),
            retainedFingerprint: fingerprint,
          });

          return createResult(
            "accepted",
            metadata,
            variationNumber,
            fingerprint,
            fingerprint,
          );
        }

        if (fingerprintsMatch(existing.retainedFingerprint, fingerprint)) {
          return createResult(
            "duplicate",
            metadata,
            variationNumber,
            existing.retainedFingerprint,
            fingerprint,
          );
        }

        if (hasConflictFingerprint(existing, fingerprint)) {
          return createResult(
            "duplicate_conflict",
            metadata,
            variationNumber,
            existing.retainedFingerprint,
            fingerprint,
          );
        }

        addConflictFingerprint(existing, fingerprint);

        return createResult(
          "conflict",
          metadata,
          variationNumber,
          existing.retainedFingerprint,
          fingerprint,
        );
      }

      return Object.freeze({ record });
    }

    return Object.freeze({
      createCaptureEventRegistry,
      createPageScope,
      createVerifiedStreamScope,
    });
  },
);
