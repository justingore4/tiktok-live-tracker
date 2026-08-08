(function initializeCaptureClient(root, factory) {
  const captureClient = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = captureClient;
  }

  root.TikTokLiveTrackerCaptureClient = captureClient;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createCaptureClientModule() {
    "use strict";

    class CaptureClientError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "CaptureClientError";
        this.code = code;
      }
    }

    function hasExactKeys(value, expectedKeys) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }

      const keys = Object.keys(value).sort();
      const expected = [...expectedKeys].sort();

      return (
        keys.length === expected.length &&
        keys.every((key, index) => key === expected[index])
      );
    }

    function requireProtocol(protocol) {
      if (
        !protocol ||
        typeof protocol !== "object" ||
        typeof protocol.createCaptureMessage !== "function" ||
        typeof protocol.EVENT_TYPES?.OBSERVE_VARIATIONS !== "string" ||
        typeof protocol.EVENT_TYPES?.OBSERVE_PAYMENT_STATUSES !== "string" ||
        typeof protocol.EVENT_TYPES?.PAYMENT_COMPLETE !== "string"
      ) {
        throw new TypeError("A valid capture protocol is required.");
      }

      return protocol;
    }

    function requireRuntime(runtime) {
      if (!runtime || typeof runtime.sendMessage !== "function") {
        throw new TypeError("A runtime with sendMessage is required.");
      }

      return runtime;
    }

    function readResponse(response) {
      if (hasExactKeys(response, ["ok", "data"]) && response.ok === true) {
        if (
          !hasExactKeys(response.data, ["status"]) ||
          response.data.status !== "accepted"
        ) {
          throw new CaptureClientError(
            "INVALID_CAPTURE_RESPONSE",
            "The capture response was not recognized.",
          );
        }

        return Object.freeze({ status: "accepted" });
      }

      if (hasExactKeys(response, ["ok", "error"]) && response.ok === false) {
        const error = response.error;

        if (
          hasExactKeys(error, ["code", "message"]) &&
          typeof error.code === "string" &&
          error.code.trim() !== "" &&
          typeof error.message === "string" &&
          error.message.trim() !== ""
        ) {
          throw new CaptureClientError(error.code, error.message);
        }
      }

      throw new CaptureClientError(
        "INVALID_CAPTURE_RESPONSE",
        "The capture response was not recognized.",
      );
    }

    function createCaptureClient({ runtime, protocol }) {
      const trustedRuntime = requireRuntime(runtime);
      const trustedProtocol = requireProtocol(protocol);
      let queue = Promise.resolve();

      function enqueue(event) {
        const message = trustedProtocol.createCaptureMessage(event);
        const request = queue.then(async () => {
          let response;

          try {
            response = await trustedRuntime.sendMessage(message);
          } catch {
            throw new CaptureClientError(
              "CAPTURE_TRANSPORT_ERROR",
              "The capture event could not be delivered.",
            );
          }

          return readResponse(response);
        });

        queue = request.catch(() => undefined);
        return request;
      }

      function observeVariations(variationNumbers) {
        return enqueue({
          type: trustedProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
          variationNumbers: Array.isArray(variationNumbers)
            ? [...variationNumbers]
            : variationNumbers,
        });
      }

      function observePaymentStatuses(statuses) {
        return enqueue({
          type: trustedProtocol.EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
          statuses: Array.isArray(statuses)
            ? statuses.map((status) => ({ ...status }))
            : statuses,
        });
      }

      function recordPaymentComplete({ variationNumber, soldPriceCents } = {}) {
        return enqueue({
          type: trustedProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
          variationNumber,
          soldPriceCents,
        });
      }

      return Object.freeze({
        observePaymentStatuses,
        observeVariations,
        recordPaymentComplete,
      });
    }

    return Object.freeze({ CaptureClientError, createCaptureClient });
  },
);
