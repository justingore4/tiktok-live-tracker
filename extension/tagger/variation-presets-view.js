(function exposeVariationPresetsView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TikTokLiveTrackerVariationPresetsView = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createVariationPresetsView() {
  "use strict";

  // Display projection only. Never pass these placeholders into reconciliation,
  // persistence, report generation, or a captured-variation mapping command.
  function project(view, presets, selectedNumber = null) {
    if (!view || !presets || presets.streamId !== view.streamId || presets.total === null) return view;
    const captured = view.variations.filter((entry) => entry.recorded);
    const byNumber = new Map(captured.map((entry) => [entry.variationNumber, entry]));
    const assignments = new Map(presets.assignments.map((entry) => [entry.variationNumber, entry.sku]));
    for (let number = 1; number <= presets.total; number += 1) {
      if (byNumber.has(number)) continue;
      const sku = assignments.get(number) ?? null;
      const item = view.inventory.find((entry) => entry.sku === sku);
      byNumber.set(number, {
        variationNumber: number, recorded: false, preset: true, current: false,
        sku, item: item?.item ?? null, style: item?.style ?? "", size: item?.size ?? "",
        observedPaymentStatusLabel: "untracked", selected: false,
      });
    }
    // The ordinary controller may still have a startup fallback number before
    // any capture. That number must not silently select a future placeholder.
    const selected = byNumber.get(selectedNumber) ??
      captured.find((entry) => entry.variationNumber === view.selectedVariationNumber) ?? null;
    const selection = selected?.variationNumber ?? null;
    const future = selected?.preset === true;
    const variations = [...byNumber.values()].sort((a, b) => b.variationNumber - a.variationNumber)
      .map((entry) => ({ ...entry, selected: entry.variationNumber === selection }));
    return {
      ...view, variations, selectedVariationNumber: selection, variationNumber: selection,
      isReviewingHistory: future || (selection !== null &&
        ((selection === view.selectedVariationNumber && view.isReviewingHistory) ||
          selection !== view.currentVariationNumber)),
      isReviewingPreset: future,
      ...(future ? {
        auction: null, mapping: null,
        inventory: view.inventory.map((entry) => ({ ...entry,
          selected: entry.sku === selected.sku,
          selectionAllowed: true,
          selectionReason: entry.sku === selected.sku ? "selected" : "available",
        })),
      } : {}),
    };
  }

  function nextHasAssignment(view, presets) {
    return Boolean(view && presets && presets.streamId === view.streamId &&
      presets.total !== null && presets.assignments.some((entry) =>
        entry.variationNumber === view.currentVariationNumber + 1));
  }

  function canExtend(view, presets) {
    return Boolean(view && presets && presets.streamId === view.streamId &&
      presets.total !== null && (presets.extensionAvailable === true ||
        (Number.isSafeInteger(view.activeBiddingVariationNumber) &&
          view.activeBiddingVariationNumber > presets.total)));
  }

  function preserveExtensionAvailability(snapshot, previous) {
    // Latching readiness does not rotate the preset revision. A pre-latch read
    // arriving late must not erase an already-observed latch for that exact
    // configuration, especially after the active bidding marker clears.
    return snapshot && previous?.extensionAvailable === true &&
      snapshot.total !== null && snapshot.streamId === previous.streamId &&
      snapshot.baselineId === previous.baselineId && snapshot.total === previous.total &&
      snapshot.revision === previous.revision
      ? { ...snapshot, extensionAvailable: true } : snapshot;
  }

  return Object.freeze({ project, nextHasAssignment, canExtend, preserveExtensionAvailability });
});
