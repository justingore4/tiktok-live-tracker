(function initializeVariationPresetsProtocol(root, factory) {
  const moduleValue = factory();
  if (typeof module === "object" && module.exports) module.exports = moduleValue;
  root.TikTokLiveTrackerVariationPresetsProtocol = moduleValue;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const MESSAGE_CHANNEL = "tiktok-live-tracker.variation-presets";
  const MESSAGE_VERSION = 1;
  const MAX_PRESET_VARIATIONS = 1000;
  const REVISION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const COMMAND_TYPES = Object.freeze({
    GET_PRESETS: "get_presets",
    CREATE_PRESETS: "create_presets",
    SET_PRESET_ITEM: "set_preset_item",
    ASSIGN_NEXT_PRESET_ITEM: "assign_next_preset_item",
    RESET_PRESETS: "reset_presets",
  });
  const IDENTITY_KEYS = ["expectedStreamId", "expectedBaselineId", "expectedRevision", "type"];
  const COMMAND_KEYS = Object.freeze({
    get_presets: ["type"],
    create_presets: [...IDENTITY_KEYS, "total"],
    set_preset_item: [...IDENTITY_KEYS, "variationNumber", "sku"],
    assign_next_preset_item: [...IDENTITY_KEYS, "variationNumber", "sku"],
    reset_presets: IDENTITY_KEYS,
  });

  class VariationPresetsProtocolError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "VariationPresetsProtocolError";
      this.code = code;
    }
  }
  function fail(message) {
    throw new VariationPresetsProtocolError("INVALID_VARIATION_PRESETS_MESSAGE", message);
  }
  function hasExactKeys(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
  }
  function isIdentity(value) {
    return typeof value === "string" && value.length > 0 && value === value.trim();
  }
  function isRevision(value) {
    return typeof value === "string" && REVISION_PATTERN.test(value);
  }
  function isTotal(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PRESET_VARIATIONS;
  }
  function validateCommand(command) {
    const keys = command && Object.prototype.hasOwnProperty.call(COMMAND_KEYS, command.type) && COMMAND_KEYS[command.type];
    if (!keys || !hasExactKeys(command, keys)) fail("The preset command has an invalid shape or type.");
    if (command.type === COMMAND_TYPES.GET_PRESETS) return command;
    if (!isIdentity(command.expectedStreamId) || !isIdentity(command.expectedBaselineId)) {
      fail("Preset commands must identify the displayed stream and inventory baseline.");
    }
    if (command.expectedRevision !== null && !isRevision(command.expectedRevision)) {
      fail("The preset revision must identify the displayed configuration.");
    }
    if (command.type === COMMAND_TYPES.CREATE_PRESETS && !isTotal(command.total)) {
      fail(`Enter a whole-number preset total between 1 and ${MAX_PRESET_VARIATIONS}.`);
    }
    if (command.type === COMMAND_TYPES.SET_PRESET_ITEM || command.type === COMMAND_TYPES.ASSIGN_NEXT_PRESET_ITEM) {
      if (!isTotal(command.variationNumber)) fail("The preset variation number is invalid.");
      if (command.sku !== null && !isIdentity(command.sku)) fail("The preset item must be an exact SKU or null.");
      if (command.type === COMMAND_TYPES.ASSIGN_NEXT_PRESET_ITEM && command.sku === null) {
        fail("Sequential preset assignment requires an exact SKU.");
      }
    }
    return command;
  }
  function validateSnapshot(snapshot) {
    const keys = ["streamId", "baselineId", "revision", "total", "assignments"];
    const hasExtensionAvailable = Object.prototype.hasOwnProperty.call(snapshot ?? {}, "extensionAvailable");
    if (!hasExactKeys(snapshot, hasExtensionAvailable ? [...keys, "extensionAvailable"] : keys)) {
      fail("The preset snapshot has an invalid shape.");
    }
    // This optional readiness latch is scoped to this exact saved range. Older
    // records omit it; false/other values are not a second configuration state.
    if (hasExtensionAvailable && (snapshot.extensionAvailable !== true || snapshot.total === null || snapshot.streamId === null)) {
      fail("Preset extension readiness requires an enabled configuration.");
    }
    if (!Array.isArray(snapshot.assignments) || snapshot.assignments.length > MAX_PRESET_VARIATIONS) {
      fail("The preset assignments are invalid.");
    }
    if (snapshot.streamId === null) {
      if (snapshot.baselineId !== null || snapshot.revision !== null || snapshot.total !== null || snapshot.assignments.length) {
        fail("Inactive presets must not contain a configuration.");
      }
      return snapshot;
    }
    if (!isIdentity(snapshot.streamId) || !isIdentity(snapshot.baselineId)) fail("The preset identity is invalid.");
    if (snapshot.revision !== null && !isRevision(snapshot.revision)) fail("The preset revision is invalid.");
    if (snapshot.total === null) {
      if (snapshot.assignments.length) fail("Disabled presets cannot contain assignments.");
      return snapshot;
    }
    if (!isTotal(snapshot.total) || !isRevision(snapshot.revision)) fail("The preset total or revision is invalid.");
    let previous = 0;
    for (const assignment of snapshot.assignments) {
      if (!hasExactKeys(assignment, ["variationNumber", "sku"]) ||
          !isTotal(assignment.variationNumber) || assignment.variationNumber > snapshot.total ||
          assignment.variationNumber <= previous || !isIdentity(assignment.sku)) {
        fail("Preset assignments must contain unique, ordered variation numbers and exact SKUs.");
      }
      previous = assignment.variationNumber;
    }
    return snapshot;
  }
  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_error) { fail("Preset messages must be JSON serializable."); }
  }
  function createMessage(command = { type: COMMAND_TYPES.GET_PRESETS }) {
    validateCommand(command);
    const snapshot = clone(command);
    validateCommand(snapshot);
    return { channel: MESSAGE_CHANNEL, version: MESSAGE_VERSION, command: snapshot };
  }
  function validateMessage(message) {
    if (!hasExactKeys(message, ["channel", "version", "command"]) ||
        message.channel !== MESSAGE_CHANNEL || message.version !== MESSAGE_VERSION) {
      fail("The preset message has an invalid shape, channel, or version.");
    }
    validateCommand(message.command);
    return validateCommand(clone(message.command));
  }
  function createPresetsChangedNotification() {
    return { channel: MESSAGE_CHANNEL, version: MESSAGE_VERSION, event: { type: "presets_changed" } };
  }
  function isPresetsChangedNotification(message) {
    return hasExactKeys(message, ["channel", "version", "event"]) &&
      message.channel === MESSAGE_CHANNEL && message.version === MESSAGE_VERSION &&
      hasExactKeys(message.event, ["type"]) && message.event.type === "presets_changed";
  }
  return Object.freeze({
    COMMAND_TYPES, MESSAGE_CHANNEL, MESSAGE_VERSION, MAX_PRESET_VARIATIONS,
    REVISION_PATTERN, VariationPresetsProtocolError, validateCommand, validateSnapshot,
    createMessage, validateMessage,
    createVariationPresetsMessage: createMessage,
    validateVariationPresetsMessage: validateMessage,
    createPresetsChangedNotification, isPresetsChangedNotification,
  });
});
