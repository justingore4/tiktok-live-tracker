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

  function projectQueuedItem(view, queueSnapshot, selectedNumber = null) {
    const isIdentity = (value) => typeof value === "string" && value.length > 0 && value === value.trim();
    const anchor = queueSnapshot?.armedAfterVariationNumber;
    if (!view || !queueSnapshot || !isIdentity(queueSnapshot.streamId) ||
        queueSnapshot.streamId !== view.streamId || !isIdentity(queueSnapshot.baselineId) ||
        queueSnapshot.baselineId !== view.inventoryBaselineId ||
        !isIdentity(queueSnapshot.queuedSku) || !Number.isSafeInteger(anchor) || anchor < 1 ||
        view.currentVariationNumber !== anchor ||
        !Array.isArray(view.variations) || !Array.isArray(view.inventory)) return view;

    const variationNumber = anchor + 1;
    if (!Number.isSafeInteger(variationNumber)) return view;
    const source = view.variations.find((entry) => entry.variationNumber === anchor);
    if (source?.recorded !== true || source.preset === true) return view;
    const target = view.variations.find((entry) => entry.variationNumber === variationNumber);
    if (target?.recorded || (target?.preset === true && target.sku != null)) return view;
    const item = view.inventory.find((entry) => entry.sku === queueSnapshot.queuedSku);
    if (!item) return view;

    // This read-only row describes the existing manual queue, not a new preset,
    // captured variation, or reservation. Never derive its target from selection
    // or move a late queue snapshot forward to a newer live variation.
    const selected = selectedNumber === variationNumber || view.selectedVariationNumber === variationNumber;
    const selection = selected ? variationNumber : view.selectedVariationNumber;
    const preview = {
      variationNumber, queuedPreview: true, preset: false, recorded: false, current: false,
      sku: item.sku, item: item.item, style: item.style ?? "", size: item.size ?? "",
      observedPaymentStatusLabel: "untracked", selected,
      ...(target?.preset === true || target?.underlyingPreset === true ? { underlyingPreset: true } : {}),
    };
    const variations = [...view.variations.filter((entry) => entry.variationNumber !== variationNumber), preview]
      .sort((a, b) => b.variationNumber - a.variationNumber)
      .map((entry) => ({ ...entry, selected: entry.variationNumber === selection }));
    return {
      ...view, variations,
      ...(selected ? {
        variationNumber, selectedVariationNumber: variationNumber,
        isReviewingQueuePreview: true, isReviewingPreset: false, isReviewingHistory: true,
        auction: null, mapping: null,
        inventory: view.inventory.map((entry) => ({ ...entry,
          selected: entry.sku === item.sku, selectionAllowed: false,
          selectionReason: "queued_preview_read_only",
        })),
      } : {}),
    };
  }

  function getUpcomingAssignment(view, presets, baselineId) {
    const activeNumber = view?.activeBiddingVariationNumber;
    const isIdentity = (value) => typeof value === "string" && value.length > 0 && value === value.trim();
    if (!view || !presets || !isIdentity(view.streamId) ||
        presets.streamId !== view.streamId || !isIdentity(baselineId) ||
        presets.baselineId !== baselineId || !isIdentity(presets.revision) ||
        !Number.isSafeInteger(presets.total) || presets.total < 1 ||
        !Array.isArray(view.variations) || !Array.isArray(view.inventory) ||
        !Array.isArray(presets.assignments)) return null;

    // A historical highest-number fallback is not a live auction. This display
    // projection must never arm the manual queue or activate a planned mapping.
    const prestream = !view.variations.some((entry) => entry.recorded);
    const sourceNumber = prestream ? view.selectedVariationNumber : activeNumber;
    const sourceEntry = view.variations.find((entry) => entry.variationNumber === sourceNumber);
    if (prestream) {
      // Before the first capture, show only the explicitly viewed plan's next
      // item. Once any capture exists, losing the live marker cannot reenter it.
      if (activeNumber != null || view.isReviewingPreset !== true ||
          !Number.isSafeInteger(sourceNumber) || sourceNumber < 1 ||
          sourceNumber > presets.total || sourceEntry?.preset !== true ||
          sourceEntry.recorded) return null;
    } else if (!Number.isSafeInteger(activeNumber) || activeNumber < 1 ||
        view.currentVariationNumber !== activeNumber ||
        view.selectedVariationNumber !== activeNumber ||
        view.isReviewingHistory || view.isReviewingPreset ||
        sourceEntry?.recorded !== true || sourceEntry.preset === true) return null;

    const variationNumber = sourceNumber + 1;
    if (!Number.isSafeInteger(variationNumber) || variationNumber > presets.total ||
        view.variations.some((entry) => entry.variationNumber === variationNumber && entry.recorded)) return null;
    if (prestream && !view.variations.some((entry) =>
      entry.variationNumber === variationNumber && entry.preset === true && !entry.recorded)) return null;
    const matching = presets.assignments.filter((entry) => entry.variationNumber === variationNumber);
    if (matching.length !== 1 || !isIdentity(matching[0].sku) ||
        !view.inventory.some((entry) => entry.sku === matching[0].sku)) return null;

    return {
      source: "preset", sku: matching[0].sku, variationNumber,
      ...(prestream ? { prestreamVariationNumber: sourceNumber } :
        { activeBiddingVariationNumber: activeNumber }),
      streamId: view.streamId, baselineId, revision: presets.revision,
    };
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

  return Object.freeze({ project, projectQueuedItem, nextHasAssignment, getUpcomingAssignment, canExtend, preserveExtensionAvailability });
});
