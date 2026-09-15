(function initializeVariationPresetsClient(root, factory) {
  const moduleValue = factory();
  if (typeof module === "object" && module.exports) module.exports = moduleValue;
  root.TikTokLiveTrackerVariationPresetsClient = moduleValue;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";
  class VariationPresetsClientError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "VariationPresetsClientError";
      this.code = code;
    }
  }
  function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  }
  function createVariationPresetsClient({ runtime, protocol } = {}) {
    if (typeof runtime?.sendMessage !== "function" || typeof protocol?.createMessage !== "function" ||
        typeof protocol?.validateSnapshot !== "function") {
      throw new TypeError("The preset client requires runtime messaging and the preset protocol.");
    }
    let tail = Promise.resolve();
    function send(type, options = {}) {
      let message;
      try {
        if (!options || typeof options !== "object" || Array.isArray(options) || Object.prototype.hasOwnProperty.call(options, "type")) {
          throw new VariationPresetsClientError("INVALID_CLIENT_COMMAND", "Preset options have an invalid shape.");
        }
        message = protocol.createMessage({ type, ...options });
      } catch (error) { return Promise.reject(error); }
      const result = tail.then(async () => {
        let response;
        try { response = await runtime.sendMessage(message); }
        catch (_error) {
          throw new VariationPresetsClientError("RUNTIME_MESSAGE_FAILED", "Could not reach the variation preset service.");
        }
        if (response?.ok === false && exactKeys(response, ["ok", "error"]) &&
            exactKeys(response.error, ["code", "message"]) &&
            typeof response.error.code === "string" && response.error.code.trim() &&
            typeof response.error.message === "string" && response.error.message.trim()) {
          throw new VariationPresetsClientError(response.error.code, response.error.message);
        }
        try {
          if (!exactKeys(response, ["ok", "data"]) || response.ok !== true) throw new Error("Invalid envelope.");
          const sequential = type === protocol.COMMAND_TYPES.ASSIGN_NEXT_PRESET_ITEM;
          if (sequential && !exactKeys(response.data, ["presets", "assignedVariationNumber"])) throw new Error("Invalid sequential assignment result.");
          const presets = sequential ? response.data.presets : response.data;
          protocol.validateSnapshot(presets);
          if (type !== protocol.COMMAND_TYPES.GET_PRESETS &&
              (presets.streamId !== message.command.expectedStreamId ||
               presets.baselineId !== message.command.expectedBaselineId ||
               presets.revision === null)) throw new Error("Wrong identity or revision.");
          if (type === protocol.COMMAND_TYPES.CREATE_PRESETS && presets.total !== message.command.total) throw new Error("Wrong total.");
          if (type === protocol.COMMAND_TYPES.RESET_PRESETS && presets.total !== null) throw new Error("Reset not confirmed.");
          if (type === protocol.COMMAND_TYPES.SET_PRESET_ITEM &&
              (presets.total === null ||
               (presets.assignments.find((entry) => entry.variationNumber === message.command.variationNumber)?.sku ?? null) !== message.command.sku)) {
            throw new Error("Assignment not confirmed.");
          }
          if (sequential) {
            const target = response.data.assignedVariationNumber;
            if (presets.total === null || !Number.isSafeInteger(target) ||
                target < message.command.variationNumber || target > presets.total ||
                presets.revision === message.command.expectedRevision ||
                presets.assignments.find((entry) => entry.variationNumber === target)?.sku !== message.command.sku ||
                (target > message.command.variationNumber &&
                 !presets.assignments.some((entry) => entry.variationNumber === message.command.variationNumber))) {
              throw new Error("Sequential assignment not confirmed.");
            }
          }
          return JSON.parse(JSON.stringify(response.data));
        } catch (_error) {
          throw new VariationPresetsClientError("INVALID_RESPONSE", "The variation preset service returned an invalid response.");
        }
      });
      tail = result.catch(() => undefined);
      return result;
    }
    return Object.freeze({
      getPresets: () => send(protocol.COMMAND_TYPES.GET_PRESETS),
      createPresets: (options) => send(protocol.COMMAND_TYPES.CREATE_PRESETS, options),
      setPresetItem: (options) => send(protocol.COMMAND_TYPES.SET_PRESET_ITEM, options),
      assignNextPresetItem: (options) => send(protocol.COMMAND_TYPES.ASSIGN_NEXT_PRESET_ITEM, options),
      resetPresets: (options) => send(protocol.COMMAND_TYPES.RESET_PRESETS, options),
    });
  }
  return Object.freeze({ VariationPresetsClientError, createVariationPresetsClient });
});
