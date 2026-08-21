(function exposeVariationSelectorLock(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.TikTokLiveTrackerVariationSelectorLock = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createVariationSelectorLockModule() {
    "use strict";

    function createVariationSelectorLock(options = {}) {
      const { apply } = options;

      if (typeof apply !== "function") {
        throw new TypeError("A variation selector render function is required.");
      }

      let locked = false;
      let hasPendingRender = false;
      let pendingValue;

      function clearPendingRender() {
        hasPendingRender = false;
        pendingValue = undefined;
      }

      function lock() {
        locked = true;
      }

      function requestRender(value) {
        if (locked) {
          pendingValue = value;
          hasPendingRender = true;
          return false;
        }

        clearPendingRender();
        apply(value);
        return true;
      }

      function release() {
        locked = false;

        if (!hasPendingRender) {
          return false;
        }

        const value = pendingValue;

        clearPendingRender();
        apply(value);
        return true;
      }

      function reset() {
        locked = false;
        clearPendingRender();
      }

      function isLocked() {
        return locked;
      }

      return Object.freeze({
        isLocked,
        lock,
        release,
        requestRender,
        reset,
      });
    }

    return Object.freeze({
      createVariationSelectorLock,
    });
  },
);
