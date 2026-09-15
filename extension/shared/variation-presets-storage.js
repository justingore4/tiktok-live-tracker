(function initializeVariationPresetsStorage(root, factory) {
  const moduleValue = factory();
  if (typeof module === "object" && module.exports) module.exports = moduleValue;
  root.TikTokLiveTrackerVariationPresetsStorage = moduleValue;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";
  const STORAGE_KEY = "tiktokLiveTracker.variationPresets.v1";
  const STORAGE_SCHEMA_VERSION = 1;
  class VariationPresetsStorageError extends Error {
    constructor(code, message, cause) {
      super(message, { cause });
      this.name = "VariationPresetsStorageError";
      this.code = code;
    }
  }
  function isPlainRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function createVariationPresetsStore({ storageArea, protocol } = {}) {
    if (!storageArea || ["get", "set", "remove"].some((name) => typeof storageArea[name] !== "function") ||
        typeof protocol?.validateSnapshot !== "function") {
      throw new TypeError("Preset storage requires a Promise-based storage area and preset protocol.");
    }
    function normalize(value) {
      try {
        protocol.validateSnapshot(value);
        if (value.streamId === null || value.revision === null) throw new Error("Missing saved identity.");
        const snapshot = JSON.parse(JSON.stringify(value));
        protocol.validateSnapshot(snapshot);
        return snapshot;
      } catch (cause) {
        throw new VariationPresetsStorageError("INVALID_VARIATION_PRESETS_STORAGE", "The saved preset configuration could not be verified.", cause);
      }
    }
    async function loadPresets() {
      let values;
      try { values = await storageArea.get(STORAGE_KEY); }
      catch (cause) {
        throw new VariationPresetsStorageError("VARIATION_PRESETS_STORAGE_READ_FAILED", "Could not read saved variation presets.", cause);
      }
      if (!isPlainRecord(values)) {
        throw new VariationPresetsStorageError("VARIATION_PRESETS_STORAGE_READ_FAILED", "Preset storage returned an invalid response.");
      }
      if (!Object.prototype.hasOwnProperty.call(values, STORAGE_KEY)) return null;
      const envelope = values[STORAGE_KEY];
      if (!isPlainRecord(envelope) ||
          Object.keys(envelope).sort().join(",") !== "presets,schemaVersion" ||
          envelope.schemaVersion !== STORAGE_SCHEMA_VERSION) {
        throw new VariationPresetsStorageError("INVALID_VARIATION_PRESETS_STORAGE", "The saved presets have an unsupported format or version.");
      }
      return normalize(envelope.presets);
    }
    async function savePresets(value) {
      const presets = normalize(value);
      try { await storageArea.set({ [STORAGE_KEY]: { schemaVersion: STORAGE_SCHEMA_VERSION, presets } }); }
      catch (cause) {
        throw new VariationPresetsStorageError("VARIATION_PRESETS_STORAGE_WRITE_FAILED", "Could not save variation presets. Please try again.", cause);
      }
      return normalize(presets);
    }
    async function clearPresets() {
      try { await storageArea.remove(STORAGE_KEY); }
      catch (cause) {
        throw new VariationPresetsStorageError("VARIATION_PRESETS_STORAGE_WRITE_FAILED", "Could not clear saved variation presets.", cause);
      }
    }
    return Object.freeze({ loadPresets, savePresets, clearPresets });
  }
  return Object.freeze({ STORAGE_KEY, STORAGE_SCHEMA_VERSION, VariationPresetsStorageError, createVariationPresetsStore });
});
