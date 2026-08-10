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
    const MAX_OBSERVED_PAYMENT_STATUSES = 1000;
    const MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH = 24;
    const ATTRIBUTED_GMV_DISPLAY_PATTERN =
      /^(?:\$(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}|\$(?:0|[1-9]\d*)(?:\.\d{1,2})?[KMB])$/;
    const OBSERVED_PAYMENT_STATUSES = Object.freeze({
      NOT_OBSERVED: "not_observed",
      PAYMENT_PROCESSING: "payment_processing",
      PAYMENT_FIXING: "payment_fixing",
      PAYMENT_FAILED: "payment_failed",
      CANCELED: "canceled",
      PAYMENT_COMPLETE: "payment_complete",
      UNRECOGNIZED: "unrecognized",
    });
    const OUTBOUND_PAYMENT_STATUSES = new Set([
      OBSERVED_PAYMENT_STATUSES.PAYMENT_PROCESSING,
      OBSERVED_PAYMENT_STATUSES.PAYMENT_FIXING,
      OBSERVED_PAYMENT_STATUSES.PAYMENT_FAILED,
      OBSERVED_PAYMENT_STATUSES.CANCELED,
      OBSERVED_PAYMENT_STATUSES.PAYMENT_COMPLETE,
      OBSERVED_PAYMENT_STATUSES.UNRECOGNIZED,
    ]);
    const EVENT_TYPES = Object.freeze({
      OBSERVE_ATTRIBUTED_GMV: "observe_attributed_gmv",
      OBSERVE_BIDDING_VARIATION: "observe_bidding_variation",
      OBSERVE_VARIATIONS: "observe_variations",
      OBSERVE_PAYMENT_STATUSES: "observe_payment_statuses",
      PAYMENT_COMPLETE: "payment_complete",
    });
    const EVENT_KEYS = Object.freeze({
      [EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV]: [
        "attributedGmvDisplay",
        "type",
      ],
      [EVENT_TYPES.OBSERVE_BIDDING_VARIATION]: ["type", "variationNumber"],
      [EVENT_TYPES.OBSERVE_VARIATIONS]: ["type", "variationNumbers"],
      [EVENT_TYPES.OBSERVE_PAYMENT_STATUSES]: ["statuses", "type"],
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

      if (event.type === EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV) {
        if (
          typeof event.attributedGmvDisplay !== "string" ||
          event.attributedGmvDisplay.length === 0 ||
          event.attributedGmvDisplay.length >
            MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH ||
          !ATTRIBUTED_GMV_DISPLAY_PATTERN.test(event.attributedGmvDisplay)
        ) {
          fail(
            "INVALID_CAPTURE_MESSAGE",
            "attributedGmvDisplay must be a sanitized exact or compact USD display.",
          );
        }
      } else if (event.type === EVENT_TYPES.OBSERVE_BIDDING_VARIATION) {
        requireVariationNumber(event.variationNumber, "variationNumber");
      } else if (event.type === EVENT_TYPES.OBSERVE_VARIATIONS) {
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
      } else if (event.type === EVENT_TYPES.OBSERVE_PAYMENT_STATUSES) {
        if (
          !Array.isArray(event.statuses) ||
          event.statuses.length === 0 ||
          event.statuses.length > MAX_OBSERVED_PAYMENT_STATUSES
        ) {
          fail(
            "INVALID_CAPTURE_MESSAGE",
            `statuses must contain between 1 and ${MAX_OBSERVED_PAYMENT_STATUSES} entries.`,
          );
        }

        const seenVariationNumbers = new Set();

        event.statuses.forEach((status, index) => {
          if (!isPlainRecord(status)) {
            fail(
              "INVALID_CAPTURE_MESSAGE",
              `statuses[${index}] must be an object.`,
            );
          }

          requireExactKeys(
            status,
            ["observedPaymentStatus", "variationNumber"],
            `statuses[${index}]`,
          );
          const variationNumber = requireVariationNumber(
            status.variationNumber,
            `statuses[${index}].variationNumber`,
          );

          if (seenVariationNumbers.has(variationNumber)) {
            fail(
              "INVALID_CAPTURE_MESSAGE",
              "statuses must contain unique variation numbers.",
            );
          }

          if (!OUTBOUND_PAYMENT_STATUSES.has(status.observedPaymentStatus)) {
            fail(
              "INVALID_CAPTURE_MESSAGE",
              `statuses[${index}].observedPaymentStatus is not supported for capture.`,
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
      ATTRIBUTED_GMV_DISPLAY_PATTERN,
      EVENT_TYPES,
      MAX_ATTRIBUTED_GMV_DISPLAY_LENGTH,
      MAX_OBSERVED_PAYMENT_STATUSES,
      MAX_OBSERVED_VARIATIONS,
      MESSAGE_CHANNEL,
      MESSAGE_VERSION,
      OBSERVED_PAYMENT_STATUSES,
      createCaptureMessage,
      validateCaptureEvent,
      validateCaptureMessage,
    });
  },
);
