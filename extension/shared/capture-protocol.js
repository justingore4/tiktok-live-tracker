(function initializeCaptureProtocol(root, factory) {
  const captureProtocol = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = captureProtocol;
  }

  root.TikTokLiveTrackerCaptureProtocol = captureProtocol;
})(
  typeof globalThis === "undefined" ? this : globalThis,
  function createCaptureProtocolModule() {
    "use strict";

    const MESSAGE_CHANNEL = "tiktok-live-tracker.capture";
    const MESSAGE_VERSION = 1;
    const MAX_OBSERVED_VARIATIONS = 1000;
    const EVENT_TYPES = Object.freeze({
      OBSERVE_VARIATIONS: "observe_variations",
      PAYMENT_COMPLETE: "payment_complete",
    });
    const EVENT_KEYS = Object.freeze({
      [EVENT_TYPES.OBSERVE_VARIATIONS]: ["type", "variationNumbers"],
      [EVENT_TYPES.PAYMENT_COMPLETE]: [
        "soldPriceCents",
        "type",
        "variationNumber",
      ],
    });

    class CaptureProtocolError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "CaptureProtocolError";
        this.code = code;
      }
    }

    function fail(code, message) {
      throw new CaptureProtocolError(code, message);
    }

    function isPlainRecord(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }

      const prototype = Object.getPrototypeOf(value);

      return prototype === Object.prototype || prototype === null;
    }

    function requireExactKeys(value, expectedKeys, description) {
      const actualKeys = Object.keys(value).sort();
      const sortedExpectedKeys = [...expectedKeys].sort();

      if (
        actualKeys.length !== sortedExpectedKeys.length ||
        actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
      ) {
        fail("INVALID_CAPTURE_MESSAGE", `${description} has an invalid shape.`);
      }
    }

    function requireVariationNumber(value, fieldName) {
      if (!Number.isSafeInteger(value) || value < 1) {
        fail(
          "INVALID_CAPTURE_MESSAGE",
          `${fieldName} must be a positive safe integer.`,
        );
      }

      return value;
    }

    function validateCaptureEvent(event) {
      if (!isPlainRecord(event) || typeof event.type !== "string") {
        fail(
          "INVALID_CAPTURE_MESSAGE",
          "A capture event object with a type is required.",
        );
      }

      const expectedKeys = EVENT_KEYS[event.type];

      if (!expectedKeys) {
        fail(
          "UNKNOWN_CAPTURE_EVENT",
          `Capture event ${event.type} is not supported.`,
        );
      }

      requireExactKeys(event, expectedKeys, `Capture event ${event.type}`);

      if (event.type === EVENT_TYPES.OBSERVE_VARIATIONS) {
        if (
          !Array.isArray(event.variationNumbers) ||
          event.variationNumbers.length === 0 ||
          event.variationNumbers.length > MAX_OBSERVED_VARIATIONS
        ) {
          fail(
            "INVALID_CAPTURE_MESSAGE",
            `variationNumbers must contain between 1 and ${MAX_OBSERVED_VARIATIONS} entries.`,
          );
        }

        const seenVariationNumbers = new Set();

        event.variationNumbers.forEach((variationNumber, index) => {
          requireVariationNumber(
            variationNumber,
            `variationNumbers[${index}]`,
          );

          if (seenVariationNumbers.has(variationNumber)) {
            fail(
              "INVALID_CAPTURE_MESSAGE",
              "variationNumbers must contain unique values.",
            );
          }

          seenVariationNumbers.add(variationNumber);
        });
      } else {
        requireVariationNumber(event.variationNumber, "variationNumber");

        if (!Number.isSafeInteger(event.soldPriceCents) || event.soldPriceCents < 1) {
          fail(
            "INVALID_CAPTURE_MESSAGE",
            "soldPriceCents must be a positive safe integer.",
          );
        }
      }

      return event;
    }

    function cloneSerializable(value) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_error) {
        fail(
          "INVALID_CAPTURE_MESSAGE",
          "Capture messages must contain only JSON-serializable values.",
        );
      }
    }

    function snapshotCaptureEvent(event) {
      validateCaptureEvent(event);
      const snapshot = cloneSerializable(event);
      validateCaptureEvent(snapshot);
      return snapshot;
    }

    function createCaptureMessage(event) {
      return {
        channel: MESSAGE_CHANNEL,
        version: MESSAGE_VERSION,
        event: snapshotCaptureEvent(event),
      };
    }

    function validateCaptureMessage(message) {
      if (!isPlainRecord(message)) {
        fail("INVALID_CAPTURE_MESSAGE", "A capture message object is required.");
      }

      requireExactKeys(
        message,
        ["channel", "event", "version"],
        "The capture message",
      );

      if (message.channel !== MESSAGE_CHANNEL) {
        fail(
          "INVALID_CAPTURE_MESSAGE",
          "The capture message channel is invalid.",
        );
      }

      if (!Number.isSafeInteger(message.version) || message.version < 1) {
        fail(
          "INVALID_CAPTURE_MESSAGE",
          "The capture message version must be a positive integer.",
        );
      }

      if (message.version !== MESSAGE_VERSION) {
        fail(
          "UNSUPPORTED_CAPTURE_MESSAGE_VERSION",
          `Capture message version ${message.version} is not supported.`,
        );
      }

      return snapshotCaptureEvent(message.event);
    }

    return Object.freeze({
      CaptureProtocolError,
      EVENT_TYPES,
      MAX_OBSERVED_VARIATIONS,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      createCaptureMessage,
      validateCaptureEvent,
      validateCaptureMessage,
    });
  },
);
