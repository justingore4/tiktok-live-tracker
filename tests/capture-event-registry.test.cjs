const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCaptureEventRegistry,
  createPageScope,
  createVerifiedStreamScope,
} = require("../extension/capture/capture-event-registry.js");

function sale(overrides = {}) {
  return {
    variationNumber: 250,
    soldPriceCents: 4800,
    paymentStatus: "payment_complete",
    ...overrides,
  };
}

test("creates frozen verified and explicitly unverified page scopes", () => {
  const streamId = "tiktok-room:001:ABC";
  const verifiedScope = createVerifiedStreamScope(streamId);
  const pageScope = createPageScope("page:tab:1");

  assert.equal(Object.isFrozen(verifiedScope), true);
  assert.deepEqual(verifiedScope, {
    kind: "verified_stream",
    verified: true,
    streamId,
  });
  assert.equal(Object.isFrozen(pageScope), true);
  assert.deepEqual(pageScope, {
    kind: "page",
    pageScopeId: "page:tab:1",
    verified: false,
  });
  assert.equal(Object.hasOwn(pageScope, "streamId"), false);
});

test("accepts the first verified-stream sale and identifies an exact duplicate", () => {
  const registry = createCaptureEventRegistry();
  const scope = createVerifiedStreamScope("tiktok-room:123:456");
  const first = registry.record(scope, sale());
  const duplicate = registry.record(scope, sale());

  assert.equal(Object.isFrozen(registry), true);
  assert.equal(first.status, "accepted");
  assert.equal(first.streamId, "tiktok-room:123:456");
  assert.equal(first.scopeKind, "verified_stream");
  assert.equal(first.verified, true);
  assert.equal(first.identityStatus, "verified");
  assert.equal(first.dedupeScope, "stream");
  assert.equal(first.variationNumber, 250);
  assert.deepEqual(first.retainedFingerprint, {
    soldPriceCents: 4800,
    paymentStatus: "payment_complete",
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.retainedFingerprint), true);

  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.streamId, "tiktok-room:123:456");
  assert.deepEqual(duplicate.retainedFingerprint, first.retainedFingerprint);
  assert.deepEqual(duplicate.observedFingerprint, first.retainedFingerprint);
});

test("retains the first fingerprint and reports each distinct conflict once", () => {
  const registry = createCaptureEventRegistry();
  const scope = createVerifiedStreamScope("stream-1");

  registry.record(scope, sale());
  const firstConflict = registry.record(
    scope,
    sale({ soldPriceCents: 4900 }),
  );
  const repeatedConflict = registry.record(
    scope,
    sale({ soldPriceCents: 4900 }),
  );
  const secondConflict = registry.record(
    scope,
    sale({ paymentStatus: "payment_review" }),
  );
  const originalAgain = registry.record(scope, sale());

  assert.equal(firstConflict.status, "conflict");
  assert.deepEqual(firstConflict.retainedFingerprint, {
    soldPriceCents: 4800,
    paymentStatus: "payment_complete",
  });
  assert.deepEqual(firstConflict.observedFingerprint, {
    soldPriceCents: 4900,
    paymentStatus: "payment_complete",
  });
  assert.equal(repeatedConflict.status, "duplicate_conflict");
  assert.equal(secondConflict.status, "conflict");
  assert.deepEqual(secondConflict.retainedFingerprint, {
    soldPriceCents: 4800,
    paymentStatus: "payment_complete",
  });
  assert.equal(originalAgain.status, "duplicate");
});

test("separates identical variations across verified stream IDs", () => {
  const registry = createCaptureEventRegistry();
  const firstStream = createVerifiedStreamScope("room:a:b");
  const secondStream = createVerifiedStreamScope("room:a");

  assert.equal(registry.record(firstStream, sale()).status, "accepted");
  assert.equal(registry.record(secondStream, sale()).status, "accepted");
  assert.equal(
    registry.record(createVerifiedStreamScope("room:a:b"), sale()).status,
    "duplicate",
  );
});

test("keeps page and verified namespaces collision-safe", () => {
  const registry = createCaptureEventRegistry();
  const opaqueId = "same:id:with:colons";
  const pageScope = createPageScope(opaqueId);
  const verifiedScope = createVerifiedStreamScope(opaqueId);

  const pageResult = registry.record(pageScope, sale());
  const verifiedResult = registry.record(verifiedScope, sale());

  assert.equal(pageResult.status, "accepted");
  assert.equal(pageResult.scopeKind, "page");
  assert.equal(pageResult.verified, false);
  assert.equal(pageResult.identityStatus, "unverified");
  assert.equal(pageResult.dedupeScope, "page_load");
  assert.equal(pageResult.pageScopeId, opaqueId);
  assert.equal(Object.hasOwn(pageResult, "streamId"), false);
  assert.equal(verifiedResult.status, "accepted");
  assert.equal(verifiedResult.streamId, opaqueId);
});

test("never exposes streamId from page-scope record results", () => {
  const registry = createCaptureEventRegistry();
  const scope = createPageScope("page-1");
  const results = [
    registry.record(scope, sale()),
    registry.record(scope, sale()),
    registry.record(scope, sale({ soldPriceCents: 4900 })),
    registry.record(scope, sale({ soldPriceCents: 4900 })),
  ];

  assert.deepEqual(
    results.map((result) => result.status),
    ["accepted", "duplicate", "conflict", "duplicate_conflict"],
  );
  results.forEach((result) => {
    assert.equal(result.verified, false);
    assert.equal(Object.hasOwn(result, "streamId"), false);
  });
});

test("snapshots fingerprints instead of retaining mutable sale input", () => {
  const registry = createCaptureEventRegistry();
  const scope = createVerifiedStreamScope("stream-1");
  const mutableSale = sale();
  const accepted = registry.record(scope, mutableSale);

  mutableSale.soldPriceCents = 9999;
  mutableSale.paymentStatus = "changed";

  const duplicate = registry.record(scope, sale());

  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(accepted.retainedFingerprint, {
    soldPriceCents: 4800,
    paymentStatus: "payment_complete",
  });
});

test("keeps separate registry instances independent", () => {
  const firstRegistry = createCaptureEventRegistry();
  const secondRegistry = createCaptureEventRegistry();
  const scope = createVerifiedStreamScope("stream-1");

  assert.equal(firstRegistry.record(scope, sale()).status, "accepted");
  assert.equal(secondRegistry.record(scope, sale()).status, "accepted");
});

test("validates scope identifiers and rejects forged scopes", () => {
  for (const invalidId of [undefined, null, 123, "", "   "]) {
    assert.throws(
      () => createVerifiedStreamScope(invalidId),
      /streamId must be a non-empty string/i,
    );
    assert.throws(
      () => createPageScope(invalidId),
      /pageScopeId must be a non-empty string/i,
    );
  }

  const registry = createCaptureEventRegistry();

  for (const invalidScope of [
    null,
    {},
    { kind: "verified_stream", streamId: "stream-1", verified: true },
  ]) {
    assert.throws(
      () => registry.record(invalidScope, sale()),
      /scope must be created by/i,
    );
  }
});

test("validates the fingerprint fields needed for deduplication", () => {
  const registry = createCaptureEventRegistry();
  const scope = createVerifiedStreamScope("stream-1");

  for (const invalidSale of [null, [], "sale"]) {
    assert.throws(() => registry.record(scope, invalidSale), /sale must be an object/i);
  }

  for (const variationNumber of [0, -1, 1.5, Number.NaN, Infinity, "1"]) {
    assert.throws(
      () => registry.record(scope, sale({ variationNumber })),
      /variationNumber must be a positive safe integer/i,
    );
  }

  for (const soldPriceCents of [-1, 1.5, Number.NaN, Infinity, "4800"]) {
    assert.throws(
      () => registry.record(scope, sale({ soldPriceCents })),
      /soldPriceCents must be a non-negative safe integer/i,
    );
  }

  for (const paymentStatus of [undefined, null, "", "   ", 1]) {
    assert.throws(
      () => registry.record(scope, sale({ paymentStatus })),
      /paymentStatus must be a non-empty string/i,
    );
  }
});
