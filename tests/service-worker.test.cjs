const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const captureProtocol = require("../extension/shared/capture-protocol.js");
const inventoryImportProtocol = require(
  "../extension/shared/inventory-import-protocol.js"
);
const liveBidProtocol = require("../extension/shared/live-bid-protocol.js");
const nextItemQueueProtocol = require(
  "../extension/shared/next-item-queue-protocol.js",
);
const streamReportProtocol = require(
  "../extension/shared/stream-report-protocol.js"
);

const workerSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "service-worker.js"),
  "utf8",
);

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createWorkerHarness(options = {}) {
  const imports = [];
  const listeners = [];
  const dispatchCalls = [];
  const streamDispatchCalls = [];
  const captureDispatchCalls = [];
  const runtimeSendMessages = [];
  const inventoryImportCalls = [];
  const reportCalls = [];
  const liveBidSyncCalls = [];
  const nextItemQueueCalls = [];
  const consoleErrors = [];
  const timerCalls = [];
  const timerReceiverMarker = {};
  let requestedStorageAccess = null;
  const storageArea = {
    setAccessLevel(accessOptions) {
      requestedStorageAccess = accessOptions;

      if (options.accessLevelError) {
        return Promise.reject(options.accessLevelError);
      }

      return Promise.resolve();
    },
  };
  const stateStore = {};
  const streamStateStore = {};
  const reportStore = {};
  const extensionId = "test-extension-id";
  const activeStreamId =
    "local-stream:11111111-1111-4111-8111-111111111111";
  const activeInventoryBaselineId =
    "inventory-baseline:11111111-1111-4111-8111-111111111111";
  const preparedReconciliationState = {
    version: 4,
    activeInventoryBaselineId,
    inventoryBaselines: [
      {
        baselineId: activeInventoryBaselineId,
        sourceFingerprint:
          options.preparedSourceFingerprint === undefined
            ? "fnv1a64:1111111111111111"
            : options.preparedSourceFingerprint,
        inventory: [
          {
            sku: "TEST-SKU",
            item: "Test item",
            style: "",
            size: "OS",
            quantityOnHandAtImport: 1,
            unitCostCents: 100,
          },
        ],
      },
    ],
    streams: [],
  };
  const sidePanelUrl =
    `chrome-extension://${extensionId}/tagger/sidepanel.html`;
  const reportPageUrl =
    `chrome-extension://${extensionId}/report/report.html`;
  let requestedPanelBehavior = null;
  let storeOptions = null;
  let coordinatorOptions = null;
  let streamStoreOptions = null;
  let streamCoordinatorOptions = null;
  let captureIntegrationOptions = null;
  let nextItemQueueCoordinatorOptions = null;
  let inventoryImportOptions = null;
  let remainingPinFailures = options.pinFailureCount ?? 0;
  let remainingEndFailures = options.endStreamFailureCount ?? 0;
  let persistedActiveSession = options.initialActiveSession
    ? JSON.parse(JSON.stringify(options.initialActiveSession))
    : null;
  const statefulReconciliation = options.statefulReconciliation === true;
  let persistedReconciliationState = statefulReconciliation
    ? options.initialReconciliationState === undefined
      ? null
      : JSON.parse(JSON.stringify(options.initialReconciliationState))
    : undefined;

  class FakeReconciliationError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeStorageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeCoordinatorError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeStreamSessionError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeStreamStorageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeStreamCoordinatorError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeStreamReportStorageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeStreamReportCoordinatorError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeCaptureIntegrationError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeLiveBidProtocolError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeLiveBidStorageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeLiveBidCoordinatorError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeNextItemQueueStorageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeNextItemQueueCoordinatorError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  class FakeGoogleSheetsInventoryImportError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  let paymentFixingListIndex = 0;
  const reconciliation = {
    ReconciliationError: FakeReconciliationError,
    hydrateReconciliationState(candidate) {
      if (!candidate || typeof candidate !== "object") {
        throw new FakeReconciliationError(
          "INVALID_STATE",
          "Invalid reconciliation state.",
        );
      }

      return JSON.parse(JSON.stringify(candidate));
    },
    listPaymentFixingOrders(_candidate, input) {
      dispatchCalls.push({
        type: "list_payment_fixing_orders_internal",
        streamId: input.streamId,
      });
      const sequence = options.paymentFixingOrdersSequence;
      const orders = Array.isArray(sequence) && sequence.length > 0
        ? sequence[Math.min(paymentFixingListIndex++, sequence.length - 1)]
        : options.paymentFixingOrders ?? [];

      return JSON.parse(JSON.stringify(orders));
    },
    calculateSummary(_candidate, input) {
      dispatchCalls.push({
        type: "calculate_summary_internal",
        streamId: input.streamId,
      });
      return JSON.parse(JSON.stringify(
        options.reconciliationSummary ?? {
          inventory: [],
          itemPerformance: [],
          auctions: [],
        },
      ));
    },
  };
  const storageModule = {
    ReconciliationStorageError: FakeStorageError,
    createReconciliationStateStore(receivedOptions) {
      storeOptions = receivedOptions;
      return stateStore;
    },
  };
  const coordinator = {
    async resolvePaymentFixingOrder(input) {
      dispatchCalls.push({
        type: "resolve_payment_fixing_order_internal",
        ...JSON.parse(JSON.stringify(input)),
      });

      if (options.paymentResolutionError) {
        throw options.paymentResolutionError;
      }

      return options.paymentResolutionResponse ?? {
        state: persistedReconciliationState === undefined
          ? JSON.parse(JSON.stringify(preparedReconciliationState))
          : JSON.parse(JSON.stringify(persistedReconciliationState)),
        result: { status: input.resolution },
      };
    },
    async dispatch(command) {
      dispatchCalls.push(command);

      if (options.beforeDispatch) {
        await options.beforeDispatch(command);
      }

      if (
        command.type ===
          coordinatorModule.COMMAND_TYPES
            .PIN_STREAM_TO_INVENTORY_BASELINE &&
        options.pinDispatchError &&
        remainingPinFailures > 0
      ) {
        remainingPinFailures -= 1;
        throw options.pinDispatchError === "known"
          ? new FakeStorageError(
              "STORAGE_WRITE_FAILED",
              "Could not pin stream inventory.",
            )
          : options.pinDispatchError;
      }

      if (options.dispatchError === "known") {
        throw new FakeStorageError("STORAGE_WRITE_FAILED", "Could not save.");
      }

      if (options.dispatchError === "unexpected") {
        throw new Error("sensitive failure details");
      }

      if (statefulReconciliation) {
        if (command.type === coordinatorModule.COMMAND_TYPES.GET_STATE) {
          return {
            state: persistedReconciliationState === null
              ? null
              : JSON.parse(JSON.stringify(persistedReconciliationState)),
            result: null,
          };
        }

        if (
          command.type === coordinatorModule.COMMAND_TYPES.INITIALIZE_STATE
        ) {
          if (persistedReconciliationState === null) {
            persistedReconciliationState = JSON.parse(
              JSON.stringify(preparedReconciliationState),
            );
            persistedReconciliationState.inventoryBaselines[0].inventory =
              JSON.parse(JSON.stringify(command.inventory));
          }

          return {
            state: JSON.parse(JSON.stringify(persistedReconciliationState)),
            result: { status: "initialized" },
          };
        }

        if (
          command.type ===
          coordinatorModule.COMMAND_TYPES.PIN_STREAM_TO_INVENTORY_BASELINE
        ) {
          if (persistedReconciliationState === null) {
            throw new FakeCoordinatorError(
              "STATE_NOT_INITIALIZED",
              "Inventory must initialize reconciliation state before this command can run.",
            );
          }

          const existingStream = persistedReconciliationState.streams.find(
            (candidate) => candidate.streamId === command.streamId,
          );

          if (!existingStream) {
            persistedReconciliationState.streams.push({
              streamId: command.streamId,
              inventoryBaselineId:
                persistedReconciliationState.activeInventoryBaselineId,
              variations: [],
            });
          }

          return {
            state: JSON.parse(JSON.stringify(persistedReconciliationState)),
            result: {
              status: existingStream ? "already_pinned" : "pinned",
              baselineId:
                persistedReconciliationState.activeInventoryBaselineId,
            },
          };
        }

        return {
          state: persistedReconciliationState === null
            ? null
            : JSON.parse(JSON.stringify(persistedReconciliationState)),
          result: null,
        };
      }

      if (
        command.type === coordinatorModule.COMMAND_TYPES.GET_STATE &&
        options.usePreparedState
      ) {
        return {
          state: JSON.parse(JSON.stringify(preparedReconciliationState)),
          result: null,
        };
      }

      return options.dispatchResult ?? { state: null, result: null };
    },
  };
  const coordinatorModule = {
    MESSAGE_CHANNEL: "tiktok-live-tracker.reconciliation",
    MESSAGE_VERSION: 1,
    COMMAND_TYPES: {
      GET_STATE: "get_state",
      INITIALIZE_STATE: "initialize_state",
      CREATE_INVENTORY_BASELINE: "create_inventory_baseline",
      EXTEND_STREAM_INVENTORY_BASELINE:
        "extend_stream_inventory_baseline",
      PIN_STREAM_TO_INVENTORY_BASELINE:
        "pin_stream_to_inventory_baseline",
      OBSERVE_ATTRIBUTED_GMV: "observe_attributed_gmv",
      OBSERVE_BIDDING_VARIATION: "observe_bidding_variation",
      OBSERVE_PAYMENT_STATUSES: "observe_payment_statuses",
      OBSERVE_VARIATIONS: "observe_variations",
      MAP_VARIATION: "map_variation",
      RECORD_PAYMENT_COMPLETE: "record_payment_complete",
      UNMAP_VARIATION: "unmap_variation",
    },
    ReconciliationCoordinatorError: FakeCoordinatorError,
    createReconciliationCoordinator(receivedOptions) {
      coordinatorOptions = receivedOptions;
      return coordinator;
    },
  };
  const streamSession = {
    StreamSessionError: FakeStreamSessionError,
    hydrateStreamSessionState(candidate) {
      if (
        !candidate ||
        candidate.version !== 1 ||
        !("activeSession" in candidate)
      ) {
        throw new FakeStreamSessionError(
          "INVALID_STREAM_SESSION_STATE",
          "Invalid stream-session state.",
        );
      }

      return JSON.parse(JSON.stringify(candidate));
    },
  };
  const streamStorageModule = {
    StreamSessionStorageError: FakeStreamStorageError,
    createStreamSessionStateStore(receivedOptions) {
      streamStoreOptions = receivedOptions;
      return streamStateStore;
    },
  };
  const streamCoordinator = {
    async dispatch(command) {
      streamDispatchCalls.push(command);

      if (options.beforeStreamDispatch) {
        await options.beforeStreamDispatch(command);
      }

      if (
        options.endStreamDispatchError &&
        remainingEndFailures > 0 &&
        [
          streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
          streamCoordinatorModule.COMMAND_TYPES.END_STREAM_WITHOUT_REPORT,
        ].includes(command.type)
      ) {
        remainingEndFailures -= 1;
        throw options.endStreamDispatchError === "known"
          ? new FakeStreamStorageError(
              "STORAGE_WRITE_FAILED",
              "Could not save stream.",
            )
          : options.endStreamDispatchError;
      }

      if (options.streamDispatchError === "known") {
        throw new FakeStreamStorageError(
          "STORAGE_WRITE_FAILED",
          "Could not save stream.",
        );
      }

      if (options.streamDispatchError === "unexpected") {
        throw new Error("sensitive stream failure details");
      }

      if (options.streamDispatchResult) {
        return options.streamDispatchResult;
      }

      if (
        command.type === streamCoordinatorModule.COMMAND_TYPES.START_STREAM
      ) {
        const alreadyActive = persistedActiveSession !== null;

        persistedActiveSession ??= {
          streamId: activeStreamId,
          startedAt: "2026-08-08T20:00:00.000Z",
          identitySource: "local_session",
        };

        return {
          state: {
            version: 1,
            activeSession: JSON.parse(
              JSON.stringify(persistedActiveSession),
            ),
          },
          result: { status: alreadyActive ? "already_active" : "started" },
        };
      }

      if (
        [
          streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
          streamCoordinatorModule.COMMAND_TYPES.END_STREAM_WITHOUT_REPORT,
        ].includes(command.type)
      ) {
        persistedActiveSession = null;

        return {
          state: { version: 1, activeSession: null },
          result: { status: "ended" },
        };
      }

      return {
        state: {
          version: 1,
          activeSession: persistedActiveSession === null
            ? null
            : JSON.parse(JSON.stringify(persistedActiveSession)),
        },
        result: null,
      };
    },
  };
  const streamCoordinatorModule = {
    MESSAGE_CHANNEL: "tiktok-live-tracker.stream-session",
    MESSAGE_VERSION: 1,
    COMMAND_TYPES: {
      GET_STREAM_SESSION: "get_stream_session",
      START_STREAM: "start_stream",
      END_STREAM: "end_stream",
      END_STREAM_WITHOUT_REPORT: "end_stream_without_report",
    },
    StreamSessionCoordinatorError: FakeStreamCoordinatorError,
    createStreamSessionCoordinator(receivedOptions) {
      streamCoordinatorOptions = receivedOptions;
      return streamCoordinator;
    },
  };
  const streamReport = {
    hydrateStreamReport(candidate) {
      return JSON.parse(JSON.stringify(candidate));
    },
  };
  const reportStorageModule = {
    LIFECYCLE_STATUSES: {
      FINALIZED: "finalized",
      PENDING_END: "pending_end",
    },
    MAX_ACTIVE_REPORTS: 5,
    MAX_ARCHIVED_REPORTS: 25,
    MAX_TOTAL_REPORTS: 30,
    TARGET_ARCHIVE_BYTES: 4 * 1024 * 1024,
    LEGACY_MIGRATION_HEADROOM_BYTES: 4 * 1024,
    MAX_ARCHIVE_BYTES: (4 * 1024 * 1024) + (4 * 1024),
    STORAGE_SCHEMA_VERSION: 3,
    StreamReportStorageError: FakeStreamReportStorageError,
    createStreamReportStore(receivedOptions) {
      reportCalls.push({ type: "create_store", options: receivedOptions });
      return reportStore;
    },
  };
  let lastPreparedReport = null;
  let currentPaymentReportRecord = options.paymentReportRecord === undefined
    ? null
    : JSON.parse(JSON.stringify(options.paymentReportRecord));
  let remainingReportReplacementFailures =
    options.reportReplacementFailureCount ?? 0;
  function createOfflineEditorFixture(
    reportId,
    expectedSku = "TEE-M",
    eligibility = { status: "editable", code: null, reason: null },
  ) {
    const createInventoryRow = (sku, size, openingQuantity) => {
      const soldQuantity = expectedSku === sku ? 1 : 0;
      const calculatedRemainingQuantity = openingQuantity - soldQuantity;

      return {
        sku,
        item: "Tee",
        style: "black",
        size,
        unitCostCents: sku === "TEE-M" ? 500 : 700,
        openingQuantity,
        streamSoldQuantity: soldQuantity,
        baselineSoldQuantity: soldQuantity,
        pendingQuantity: 0,
        calculatedRemainingQuantity,
        replacementQuantity: calculatedRemainingQuantity,
        availableAfterReservationsQuantity: calculatedRemainingQuantity,
        oversoldQuantity: 0,
        requiresRecount: false,
      };
    };

    return {
      reportId,
      displayName: null,
      endedAt: "2026-08-19T12:00:00.000Z",
      eligibility,
      canceledDetailsAvailable: true,
      completedVariations: [
        {
          variationNumber: 10,
          expectedStatus: "payment_complete",
          expectedSku,
          soldPriceCents: 1500,
        },
      ],
      canceledVariations: [],
      inventory: [
        createInventoryRow("TEE-M", "M", 2),
        createInventoryRow("TEE-L", "L", 1),
      ],
    };
  }
  const reportCoordinator = {
    async loadOfflineEditorData(input) {
      reportCalls.push({
        type: "load_offline_editor",
        input: JSON.parse(JSON.stringify(input)),
      });
      const eligibility = input.activeStreamExists
        ? {
            status: "blocked",
            code: "ACTIVE_STREAM_ALREADY_EXISTS",
            reason: "End the active tracker stream before editing a report.",
          }
        : { status: "editable", code: null, reason: null };
      const fallback = createOfflineEditorFixture(
        input.reportId,
        "TEE-M",
        eligibility,
      );

      return JSON.parse(JSON.stringify(
        options.offlineEditorData ?? fallback,
      ));
    },
    async correctFinalizedReportMappings(input) {
      reportCalls.push({
        type: "correct_offline_mappings",
        input: JSON.parse(JSON.stringify(input)),
      });

      if (options.offlineMappingCorrectionError) {
        throw options.offlineMappingCorrectionError === "known"
          ? new FakeStreamReportStorageError(
              "STORAGE_WRITE_FAILED",
              "Could not save the corrected stream report.",
            )
          : options.offlineMappingCorrectionError;
      }

      return JSON.parse(JSON.stringify(
        options.mappingCorrectedEditorData ??
          options.offlineEditorData ?? {
            ...createOfflineEditorFixture(
              input.reportId,
              input.changes.find(
                (change) => change.expectedStatus === "payment_complete",
              )?.sku ?? null,
            ),
          },
      ));
    },
    async correctFinalizedReportUnitCost(input) {
      reportCalls.push({
        type: "correct_unit_cost",
        input: JSON.parse(JSON.stringify(input)),
      });

      if (options.reportUnitCostCorrectionError) {
        throw options.reportUnitCostCorrectionError === "known"
          ? new FakeStreamReportStorageError(
              "STORAGE_WRITE_FAILED",
              "Could not save the corrected stream report.",
            )
          : options.reportUnitCostCorrectionError;
      }

      currentPaymentReportRecord = JSON.parse(JSON.stringify(
        options.unitCostCorrectedReportRecord ?? currentPaymentReportRecord,
      ));
      return JSON.parse(JSON.stringify(currentPaymentReportRecord));
    },
    async getReport(reportId) {
      reportCalls.push({ type: "get", reportId });
      return JSON.parse(JSON.stringify(
        currentPaymentReportRecord ?? {
          reportId: null,
          lifecycleStatus: null,
          displayName: null,
          report: null,
        },
      ));
    },
    async getLatestFinalizedReport() {
      reportCalls.push({ type: "get_latest" });
      return JSON.parse(JSON.stringify(
        options.latestReportRecord ?? currentPaymentReportRecord ?? {
          reportId: null,
          lifecycleStatus: null,
          displayName: null,
          report: null,
        },
      ));
    },
    async replaceFinalizedReport(input) {
      reportCalls.push({
        type: "replace_finalized",
        input: JSON.parse(JSON.stringify(input)),
      });

      if (
        options.reportReplacementError &&
        remainingReportReplacementFailures > 0
      ) {
        remainingReportReplacementFailures -= 1;
        throw options.reportReplacementError === "known"
          ? new FakeStreamReportStorageError(
              "STORAGE_WRITE_FAILED",
              "Could not save the corrected stream report.",
            )
          : options.reportReplacementError;
      }

      currentPaymentReportRecord = JSON.parse(JSON.stringify(
        options.replacementReportRecord ?? currentPaymentReportRecord,
      ));
      return JSON.parse(JSON.stringify(currentPaymentReportRecord));
    },
    async prepareReport(input) {
      reportCalls.push({
        type: "prepare",
        input: JSON.parse(JSON.stringify(input)),
      });

      if (options.beforeReportPrepare) {
        await options.beforeReportPrepare(input);
      }

      if (options.reportPrepareError) {
        throw options.reportPrepareError === "known"
          ? new FakeStreamReportStorageError(
              "STORAGE_WRITE_FAILED",
              "Could not save the stream report.",
            )
          : options.reportPrepareError;
      }

      const uuid = input.streamId.slice("local-stream:".length);
      lastPreparedReport = {
        reportId: `stream-report:${uuid}`,
        lifecycleStatus: "pending_end",
        displayName: null,
        report: {
          reportId: `stream-report:${uuid}`,
          metadata: {
            streamId: input.streamId,
            startedAt: input.startedAt,
            endedAt: "2026-08-10T12:00:00.000Z",
          },
        },
      };
      return JSON.parse(JSON.stringify(lastPreparedReport));
    },
    async finalizeReport(reportId) {
      reportCalls.push({ type: "finalize", reportId });

      if (options.reportFinalizeError) {
        throw new FakeStreamReportStorageError(
          "STORAGE_WRITE_FAILED",
          "Could not finalize the stream report.",
        );
      }

      return {
        ...(lastPreparedReport ?? { reportId, report: null }),
        reportId,
        lifecycleStatus: "finalized",
      };
    },
    async repairPendingReports(activeStreamId) {
      reportCalls.push({ type: "repair", activeStreamId });

      if (options.reportRepairError) {
        throw new FakeStreamReportStorageError(
          "STORAGE_WRITE_FAILED",
          "Could not repair stream reports.",
        );
      }

      return { repairedCount: 0 };
    },
    async getReportForStream(streamId) {
      reportCalls.push({ type: "get_for_stream", streamId });
      return options.existingReport ?? {
        reportId: null,
        lifecycleStatus: null,
        displayName: null,
        report: null,
      };
    },
    async discardPendingReportForStream(streamId) {
      reportCalls.push({ type: "discard", streamId });
      const discarded =
        lastPreparedReport?.report.metadata.streamId === streamId &&
        lastPreparedReport.lifecycleStatus === "pending_end";
      const reportId = discarded ? lastPreparedReport.reportId : null;

      if (discarded) {
        lastPreparedReport = null;
      }

      return { discarded, reportId };
    },
    async dispatch(command) {
      reportCalls.push({
        type: "dispatch",
        command: JSON.parse(JSON.stringify(command)),
      });
      return options.reportDispatchResult ?? (
        [
          streamReportProtocol.COMMAND_TYPES.LIST_REPORTS,
          streamReportProtocol.COMMAND_TYPES.LIST_ARCHIVED_REPORTS,
        ].includes(command.type)
          ? { reports: [] }
          : command.type === streamReportProtocol.COMMAND_TYPES.RENAME_REPORT
            ? {
                reportId: command.reportId,
                displayName: command.displayName,
              }
          : [
              streamReportProtocol.COMMAND_TYPES.ARCHIVE_REPORTS,
              streamReportProtocol.COMMAND_TYPES.RESTORE_REPORTS,
              streamReportProtocol.COMMAND_TYPES.DELETE_ARCHIVED_REPORTS,
            ].includes(command.type)
            ? { reportIds: [...command.reportIds] }
            : {
                reportId: null,
                lifecycleStatus: null,
                displayName: null,
                report: null,
              }
      );
    },
  };
  const reportCoordinatorModule = {
    StreamReportCoordinatorError: FakeStreamReportCoordinatorError,
    createStreamReportCoordinator(receivedOptions) {
      reportCalls.push({
        type: "create_coordinator",
        options: receivedOptions,
      });
      return reportCoordinator;
    },
  };
  const captureEventIntegration = {
    consumeLiveBidChanged() {
      return options.liveBidChanged === true;
    },
    consumeNextItemQueueChanged() {
      return options.nextItemQueueChanged === true;
    },
    async dispatch(event) {
      captureDispatchCalls.push(JSON.parse(JSON.stringify(event)));

      if (options.beforeCaptureDispatch) {
        await options.beforeCaptureDispatch(event);
      }

      if (options.captureDispatchError === "known") {
        throw new FakeCaptureIntegrationError(
          "CAPTURE_PERSISTENCE_FAILED",
          "Could not persist capture.",
        );
      }

      if (options.captureDispatchError === "unexpected") {
        throw new Error("sensitive capture failure details");
      }

      return options.captureDispatchResult ?? { status: "accepted" };
    },
  };
  const captureIntegrationModule = {
    CaptureIntegrationError: FakeCaptureIntegrationError,
    createCaptureIntegration(receivedOptions) {
      captureIntegrationOptions = receivedOptions;
      return captureEventIntegration;
    },
  };
  const liveBidProtocolModule = {
    MESSAGE_CHANNEL: "tiktok-live-tracker.live-bid",
    MESSAGE_VERSION: 1,
    COMMAND_TYPES: { GET_LIVE_BID: "get_live_bid" },
    LiveBidProtocolError: FakeLiveBidProtocolError,
    createLiveBidChangedNotification() {
      return {
        channel: "tiktok-live-tracker.live-bid",
        version: 1,
        event: { type: "live_bid_changed" },
      };
    },
    isLiveBidChangedNotification(message) {
      return message?.event?.type === "live_bid_changed";
    },
    validateLiveBidMessage(message) {
      return message.command;
    },
  };
  const liveBidStorageModule = {
    LiveBidStorageError: FakeLiveBidStorageError,
    createLiveBidStore() {
      return {};
    },
  };
  const liveBidCoordinator = {
    async dispatch() {
      return options.liveBidDispatchResult ?? { liveAuction: null };
    },
    async synchronize(value) {
      liveBidSyncCalls.push(JSON.parse(JSON.stringify(value)));

      if (options.liveBidSyncError) {
        throw options.liveBidSyncError;
      }

      return options.liveBidSyncResult ?? { status: "unchanged" };
    },
  };
  const liveBidCoordinatorModule = {
    LiveBidCoordinatorError: FakeLiveBidCoordinatorError,
    createLiveBidCoordinator() {
      return liveBidCoordinator;
    },
  };
  const nextItemQueueStore = {};
  const nextItemQueueStorageModule = {
    NextItemQueueStorageError: FakeNextItemQueueStorageError,
    createNextItemQueueStore() {
      return nextItemQueueStore;
    },
  };
  const nextItemQueueCoordinator = {
    async clearForStream(streamId) {
      nextItemQueueCalls.push({ type: "clear_for_stream", streamId });
      return options.nextItemQueueClearResult ?? { status: "unchanged" };
    },
    async dispatch(command) {
      nextItemQueueCalls.push({
        type: "dispatch",
        command: JSON.parse(JSON.stringify(command)),
      });

      if (options.nextItemQueueDispatchError === "known") {
        throw new FakeNextItemQueueCoordinatorError(
          "NEXT_ITEM_QUEUE_FAILED",
          "Could not update the next-item queue.",
        );
      }

      if (options.nextItemQueueDispatchError === "unexpected") {
        throw new Error("sensitive next-item queue failure");
      }

      if (options.nextItemQueueDispatchResult) {
        return options.nextItemQueueDispatchResult;
      }

      return command.type === nextItemQueueProtocol.COMMAND_TYPES.GET_QUEUE
        ? { queuedSku: null }
        : { status: "queued", queuedSku: command.sku };
    },
  };
  const nextItemQueueCoordinatorModule = {
    NextItemQueueCoordinatorError: FakeNextItemQueueCoordinatorError,
    createNextItemQueueCoordinator(receivedOptions) {
      nextItemQueueCoordinatorOptions = receivedOptions;
      return nextItemQueueCoordinator;
    },
  };
  const googleSheetsInventoryImportModule = {
    GoogleSheetsInventoryImportError: FakeGoogleSheetsInventoryImportError,
    createGoogleSheetsInventoryImportService(receivedOptions) {
      inventoryImportOptions = receivedOptions;

      return {
        invalidatePreviews() {
          inventoryImportCalls.push({ type: "invalidate_previews" });
        },
        async getImportStatus() {
          inventoryImportCalls.push({ type: "get_import_status" });
          return options.importStatusResult ?? {
            ready: false,
            baselineId: null,
            sourceFingerprint: null,
            summary: null,
          };
        },
        async getActiveBaselinePreview() {
          inventoryImportCalls.push({
            type: "get_active_baseline_preview",
          });
          return options.activeBaselinePreviewResult ?? {
            ready: false,
            baselineId: null,
            inventory: null,
            summary: null,
          };
        },
        async previewGoogleSheet(spreadsheetId) {
          inventoryImportCalls.push({
            type: "preview_google_sheet",
            spreadsheetId,
          });
          await receivedOptions.assertNoActiveStream();
          return options.importPreviewResult ?? {
            status: "invalid",
            issues: [],
          };
        },
        async confirmGoogleSheetImport(previewToken) {
          inventoryImportCalls.push({
            type: "confirm_google_sheet_import",
            previewToken,
          });
          await receivedOptions.assertNoActiveStream();

          if (options.importCreateCommand) {
            await receivedOptions.createBaseline(
              options.importCreateCommand,
            );
          }

          return options.importConfirmResult ?? {
            status: "imported",
            baselineId:
              "inventory-baseline:22222222-2222-4222-8222-222222222222",
            sourceFingerprint: "fnv1a64:1111111111111111",
            summary: {
              rowCount: 1,
              totalQuantityOnHandAtImport: 1,
              totalInventoryCostCents: 100,
            },
          };
        },
        async addActiveStreamSkusFromGoogleSheet(spreadsheetId, context) {
          inventoryImportCalls.push({
            type: "add_active_stream_skus_from_google_sheet",
            spreadsheetId,
            context: JSON.parse(JSON.stringify(context)),
          });
          await receivedOptions.assertActiveStream(context.streamId);

          if (options.importExtendCommand) {
            await receivedOptions.extendStreamBaseline(
              options.importExtendCommand,
            );
          }

          return options.importActiveUpdateResult ?? {
            status: "already_current",
            baselineId: context.expectedBaselineId,
            sourceFingerprint: "fnv1a64:1111111111111111",
            summary: {
              rowCount: 1,
              totalQuantityOnHandAtImport: 1,
              totalInventoryCostCents: 100,
            },
            addedSkus: [],
          };
        },
      };
    },
  };
  function receiverStrictSetTimeout(callback, delayMs) {
    if (this?.__timerReceiverMarker !== timerReceiverMarker) {
      throw new TypeError("Illegal invocation");
    }

    timerCalls.push({ type: "set", callback, delayMs });
    return 77;
  }

  function receiverStrictClearTimeout(timeoutId) {
    if (this?.__timerReceiverMarker !== timerReceiverMarker) {
      throw new TypeError("Illegal invocation");
    }

    timerCalls.push({ type: "clear", timeoutId });
  }

  const sandbox = {
    __timerReceiverMarker: timerReceiverMarker,
    importScripts(...relativePaths) {
      imports.push(...relativePaths);
    },
    TikTokLiveTrackerReconciliation: reconciliation,
    TikTokLiveTrackerReconciliationStorage: storageModule,
    TikTokLiveTrackerReconciliationCoordinator: coordinatorModule,
    TikTokLiveTrackerStreamReport: streamReport,
    TikTokLiveTrackerStreamReportProtocol: streamReportProtocol,
    TikTokLiveTrackerStreamReportStorage: reportStorageModule,
    TikTokLiveTrackerStreamReportCoordinator: reportCoordinatorModule,
    TikTokLiveTrackerStreamSession: streamSession,
    TikTokLiveTrackerStreamSessionStorage: streamStorageModule,
    TikTokLiveTrackerStreamSessionCoordinator: streamCoordinatorModule,
    TikTokLiveTrackerCaptureProtocol: captureProtocol,
    TikTokLiveTrackerCaptureIntegration: captureIntegrationModule,
    TikTokLiveTrackerLiveBidProtocol: liveBidProtocolModule,
    TikTokLiveTrackerLiveBidStorage: liveBidStorageModule,
    TikTokLiveTrackerLiveBidCoordinator: liveBidCoordinatorModule,
    TikTokLiveTrackerNextItemQueueProtocol: nextItemQueueProtocol,
    TikTokLiveTrackerNextItemQueueStorage: nextItemQueueStorageModule,
    TikTokLiveTrackerNextItemQueueCoordinator:
      nextItemQueueCoordinatorModule,
    TikTokLiveTrackerInventorySheetImport: {},
    TikTokLiveTrackerInventoryImportProtocol: inventoryImportProtocol,
    TikTokLiveTrackerGoogleSheetsInventoryImport:
      googleSheetsInventoryImportModule,
    AbortController,
    clearTimeout: options.receiverStrictTimers
      ? receiverStrictClearTimeout
      : clearTimeout,
    fetch: () => Promise.reject(new Error("Network is not used by this harness.")),
    setTimeout: options.receiverStrictTimers
      ? receiverStrictSetTimeout
      : setTimeout,
    crypto: {
      randomUUID() {
        return "11111111-1111-4111-8111-111111111111";
      },
    },
    chrome: {
      storage: { local: storageArea, session: storageArea },
      runtime: {
        id: extensionId,
        getManifest() {
          return {
            oauth2: {
              client_id: "123456789-test.apps.googleusercontent.com",
            },
          };
        },
        getURL(relativePath) {
          return `chrome-extension://${extensionId}/${relativePath}`;
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        sendMessage(message) {
          runtimeSendMessages.push(JSON.parse(JSON.stringify(message)));

          if (options.runtimeSendMessageThrows) {
            throw options.runtimeSendMessageThrows;
          }

          if (options.runtimeSendMessageError) {
            return Promise.reject(options.runtimeSendMessageError);
          }

          return Promise.resolve();
        },
      },
      identity: {
        getAuthToken() {
          return Promise.resolve({ token: "test-token" });
        },
        removeCachedAuthToken() {
          return Promise.resolve();
        },
      },
      sidePanel: {
        setPanelBehavior(behavior) {
          requestedPanelBehavior = behavior;
          return Promise.resolve();
        },
      },
    },
    console: {
      error(...values) {
        consoleErrors.push(values);
      },
    },
  };

  vm.runInNewContext(workerSource, sandbox);

  function createMessage(command, overrides = {}) {
    return {
      channel: coordinatorModule.MESSAGE_CHANNEL,
      version: coordinatorModule.MESSAGE_VERSION,
      command,
      ...overrides,
    };
  }

  function createSender(overrides = {}) {
    return {
      id: extensionId,
      url: sidePanelUrl,
      ...overrides,
    };
  }

  function createStreamMessage(command, overrides = {}) {
    return {
      channel: streamCoordinatorModule.MESSAGE_CHANNEL,
      version: streamCoordinatorModule.MESSAGE_VERSION,
      command,
      ...overrides,
    };
  }

  function createCaptureMessage(event, overrides = {}) {
    return {
      ...captureProtocol.createCaptureMessage(event),
      ...overrides,
    };
  }

  function createImportMessage(command, overrides = {}) {
    return {
      ...inventoryImportProtocol.createInventoryImportMessage(command),
      ...overrides,
    };
  }

  function createReportMessage(command, overrides = {}) {
    return {
      ...streamReportProtocol.createStreamReportMessage(command),
      ...overrides,
    };
  }

  function createCaptureSender(overrides = {}) {
    return createSender({
      url:
        "https://shop.tiktok.com/streamer/live/product/dashboard?tool_tab=auction",
      frameId: 0,
      tab: { id: 9 },
      ...overrides,
    });
  }

  function send(message, sender = createSender()) {
    let responseCount = 0;
    let resolveResponse;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const returnValue = listeners[0](message, sender, (value) => {
      responseCount += 1;
      resolveResponse(JSON.parse(JSON.stringify(value)));
    });

    return {
      getResponseCount: () => responseCount,
      response,
      returnValue,
    };
  }

  return {
    consoleErrors,
    captureDispatchCalls,
    captureEventIntegration,
    captureIntegrationModule,
    captureProtocol,
    coordinator,
    coordinatorModule,
    createStreamMessage,
    createCaptureMessage,
    createCaptureSender,
    createImportMessage,
    createReportMessage,
    createMessage,
    createSender,
    dispatchCalls,
    activeInventoryBaselineId,
    activeStreamId,
    preparedReconciliationState,
    streamDispatchCalls,
    extensionId,
    getCoordinatorOptions: () => coordinatorOptions,
    getPanelBehavior: () => requestedPanelBehavior,
    getStorageAccess: () => requestedStorageAccess,
    getStoreOptions: () => storeOptions,
    getStreamCoordinatorOptions: () => streamCoordinatorOptions,
    getStreamStoreOptions: () => streamStoreOptions,
    getCaptureIntegrationOptions: () => captureIntegrationOptions,
    getNextItemQueueCoordinatorOptions: () =>
      nextItemQueueCoordinatorOptions,
    getInventoryImportOptions: () => inventoryImportOptions,
    imports,
    inventoryImportCalls,
    inventoryImportProtocol,
    reportCalls,
    reportCoordinator,
    reportPageUrl,
    listeners,
    liveBidSyncCalls,
    nextItemQueueCalls,
    nextItemQueueCoordinator,
    nextItemQueueProtocol,
    nextItemQueueStore,
    reconciliation,
    runtimeSendMessages,
    send,
    sidePanelUrl,
    streamReportProtocol,
    stateStore,
    streamCoordinator,
    streamCoordinatorModule,
    streamSession,
    streamStateStore,
    storageArea,
    timerCalls,
  };
}

test("loads state dependencies and wires the canonical coordinator", () => {
  const harness = createWorkerHarness();

  assert.deepEqual(harness.imports, [
    "shared/reconciliation.js",
    "shared/reconciliation-storage.js",
    "shared/reconciliation-coordinator.js",
    "shared/stream-report.js",
    "shared/stream-report-protocol.js",
    "shared/stream-report-storage.js",
    "shared/stream-report-coordinator.js",
    "shared/stream-session.js",
    "shared/stream-session-storage.js",
    "shared/stream-session-coordinator.js",
    "shared/live-bid-protocol.js",
    "shared/live-bid-storage.js",
    "shared/live-bid-coordinator.js",
    "shared/next-item-queue-protocol.js",
    "shared/next-item-queue-storage.js",
    "shared/next-item-queue-coordinator.js",
    "shared/capture-protocol.js",
    "shared/capture-integration.js",
    "shared/inventory-sheet-import.js",
    "shared/inventory-import-protocol.js",
    "shared/google-sheets-inventory-import.js",
  ]);
  assert.ok(
    harness.imports.every((relativePath) =>
      fs.existsSync(
        path.join(__dirname, "..", "extension", relativePath),
      ),
    ),
  );
  assert.equal(harness.getStoreOptions().storageArea, harness.storageArea);
  assert.equal(
    harness.getStoreOptions().reconciliation,
    harness.reconciliation,
  );
  assert.equal(
    harness.getCoordinatorOptions().reconciliation,
    harness.reconciliation,
  );
  assert.equal(
    harness.getCoordinatorOptions().stateStore,
    harness.stateStore,
  );
  assert.equal(
    harness.getStreamStoreOptions().storageArea,
    harness.storageArea,
  );
  assert.equal(
    harness.getStreamStoreOptions().streamSession,
    harness.streamSession,
  );
  assert.equal(
    harness.getStreamCoordinatorOptions().streamSession,
    harness.streamSession,
  );
  assert.equal(
    harness.getStreamCoordinatorOptions().stateStore,
    harness.streamStateStore,
  );
  assert.equal(
    harness.getCaptureIntegrationOptions().activeStreamCoordinator,
    harness.streamCoordinator,
  );
  assert.equal(
    harness.getCaptureIntegrationOptions().captureProtocol,
    harness.captureProtocol,
  );
  assert.equal(
    harness.getCaptureIntegrationOptions().nextItemQueueCoordinator,
    harness.nextItemQueueCoordinator,
  );
  assert.equal(
    harness.getNextItemQueueCoordinatorOptions().queueStore,
    harness.nextItemQueueStore,
  );
  assert.equal(
    harness.getNextItemQueueCoordinatorOptions().protocol,
    harness.nextItemQueueProtocol,
  );
  assert.equal(
    harness.getCaptureIntegrationOptions().reconciliationCoordinator,
    harness.coordinatorModule,
  );
  assert.equal(
    harness.getCaptureIntegrationOptions().stateCoordinator,
    harness.coordinator,
  );
  assert.equal(
    harness.getCaptureIntegrationOptions().streamSession,
    harness.streamSession,
  );
  assert.equal(
    harness.getStreamCoordinatorOptions().createId(),
    "local-stream:11111111-1111-4111-8111-111111111111",
  );
  assert.match(
    harness.getStreamCoordinatorOptions().now(),
    /^\d{4}-\d{2}-\d{2}T/,
  );
  assert.equal(harness.listeners.length, 1);
  assert.equal(harness.getPanelBehavior().openPanelOnActionClick, true);
  assert.equal(
    harness.getStorageAccess().accessLevel,
    "TRUSTED_CONTEXTS",
  );
});

test("wraps worker timers so adapter method calls keep the global receiver", () => {
  const harness = createWorkerHarness({ receiverStrictTimers: true });
  const importOptions = harness.getInventoryImportOptions();
  const callback = () => {};

  const timeoutId = importOptions.setTimeoutImpl(callback, 20_000);
  importOptions.clearTimeoutImpl(timeoutId);

  assert.equal(timeoutId, 77);
  assert.deepEqual(harness.timerCalls, [
    { type: "set", callback, delayMs: 20_000 },
    { type: "clear", timeoutId: 77 },
  ]);
  assert.match(
    workerSource,
    /clearTimeoutImpl:\s*\(\.\.\.args\) => globalThis\.clearTimeout\(\.\.\.args\)/,
  );
  assert.match(
    workerSource,
    /setTimeoutImpl:\s*\(\.\.\.args\) => globalThis\.setTimeout\(\.\.\.args\)/,
  );
});

test("keeps the async response channel open and returns plain success data", async () => {
  const expectedData = {
    state: { version: 1, inventory: [], streams: [] },
    result: null,
  };
  const harness = createWorkerHarness({ dispatchResult: expectedData });
  const command = { type: "get_state" };
  const request = harness.send(harness.createMessage(command));

  assert.equal(request.returnValue, true);
  assert.deepEqual(await request.response, { ok: true, data: expectedData });
  assert.equal(request.getResponseCount(), 1);
  assert.deepEqual(harness.dispatchCalls, [command]);
});

test("routes active-stream commands through their separate trusted boundary", async () => {
  const expectedData = {
    state: { version: 1, activeSession: null },
    result: null,
  };
  const harness = createWorkerHarness({ streamDispatchResult: expectedData });
  const command = {
    type: harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION,
  };
  const request = harness.send(harness.createStreamMessage(command));

  assert.equal(request.returnValue, true);
  assert.deepEqual(await request.response, { ok: true, data: expectedData });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.streamDispatchCalls)),
    [command],
  );
  assert.deepEqual(harness.dispatchCalls, []);
});

test("preflights inventory and pins the worker-owned stream during Start", async () => {
  const order = [];
  const harness = createWorkerHarness({
    usePreparedState: true,
    beforeDispatch(command) {
      order.push(`reconciliation:${command.type}`);
    },
    beforeStreamDispatch(command) {
      order.push(`stream:${command.type}`);
    },
  });
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );
  const response = await request.response;

  assert.equal(response.ok, true);
  assert.equal(response.data.result.status, "started");
  assert.deepEqual(order, [
    "stream:get_stream_session",
    "reconciliation:get_state",
    "stream:start_stream",
    "reconciliation:pin_stream_to_inventory_baseline",
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatchCalls)),
    [
      { type: harness.coordinatorModule.COMMAND_TYPES.GET_STATE },
      {
        type:
          harness.coordinatorModule.COMMAND_TYPES
            .PIN_STREAM_TO_INVENTORY_BASELINE,
        streamId: harness.activeStreamId,
      },
    ],
  );
});

test("blocks Start before session persistence when inventory is not prepared", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "INVENTORY_BASELINE_REQUIRED",
      message: "Prepare inventory before starting a tracker stream.",
    },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatchCalls)),
    [{ type: harness.coordinatorModule.COMMAND_TYPES.GET_STATE }],
  );
  assert.deepEqual(
    harness.streamDispatchCalls.map((command) => command.type),
    [harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION],
  );
});

test("GET repairs an active stream's missing inventory pin before returning", async () => {
  const harness = createWorkerHarness({
    initialActiveSession: {
      streamId: "local-stream:33333333-3333-4333-8333-333333333333",
      startedAt: "2026-08-08T21:00:00.000Z",
      identitySource: "local_session",
    },
  });
  const request = harness.send(
    harness.createStreamMessage({
      type:
        harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION,
    }),
  );
  const response = await request.response;

  assert.equal(response.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatchCalls)),
    [
      {
        type:
          harness.coordinatorModule.COMMAND_TYPES
            .PIN_STREAM_TO_INVENTORY_BASELINE,
        streamId: "local-stream:33333333-3333-4333-8333-333333333333",
      },
    ],
  );
});

test("recovers a legacy active stream when reconciliation state is truly missing", async () => {
  const legacySession = {
    streamId: "local-stream:88888888-8888-4888-8888-888888888888",
    startedAt: "2026-08-08T19:30:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: legacySession,
    statefulReconciliation: true,
  });
  const getStreamCommand = {
    type:
      harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION,
  };

  const initialLoad = harness.send(
    harness.createStreamMessage(getStreamCommand),
  );

  assert.deepEqual(await initialLoad.response, {
    ok: false,
    error: {
      code: "STATE_NOT_INITIALIZED",
      message:
        "Inventory must initialize reconciliation state before this command can run.",
    },
  });

  const missingStateRead = harness.send(
    harness.createMessage({
      type: harness.coordinatorModule.COMMAND_TYPES.GET_STATE,
    }),
  );

  assert.deepEqual(await missingStateRead.response, {
    ok: true,
    data: { state: null, result: null },
  });

  const inventory =
    harness.preparedReconciliationState.inventoryBaselines[0].inventory;
  const initialize = harness.send(
    harness.createMessage({
      type: harness.coordinatorModule.COMMAND_TYPES.INITIALIZE_STATE,
      inventory,
    }),
  );
  const initializedResponse = await initialize.response;

  assert.equal(initializedResponse.ok, true);
  assert.deepEqual(initializedResponse.data.result, {
    status: "initialized",
  });
  assert.deepEqual(initializedResponse.data.state.streams, [
    {
      streamId: legacySession.streamId,
      inventoryBaselineId: harness.activeInventoryBaselineId,
      variations: [],
    },
  ]);

  const retryLoad = harness.send(
    harness.createStreamMessage(getStreamCommand),
  );
  const retryResponse = await retryLoad.response;

  assert.equal(retryResponse.ok, true);
  assert.deepEqual(retryResponse.data.state.activeSession, legacySession);
  assert.equal(
    harness.streamDispatchCalls.some(
      (command) =>
        command.type ===
        harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    ),
    false,
  );
  assert.deepEqual(
    harness.dispatchCalls.map((command) => command.type),
    [
      harness.coordinatorModule.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE,
      harness.coordinatorModule.COMMAND_TYPES.GET_STATE,
      harness.coordinatorModule.COMMAND_TYPES.GET_STATE,
      harness.coordinatorModule.COMMAND_TYPES.INITIALIZE_STATE,
      harness.coordinatorModule.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE,
      harness.coordinatorModule.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE,
    ],
  );
  assert.deepEqual(
    harness.dispatchCalls
      .filter(
        (command) =>
          command.type ===
          harness.coordinatorModule.COMMAND_TYPES
            .PIN_STREAM_TO_INVENTORY_BASELINE,
      )
      .map((command) => command.streamId),
    [legacySession.streamId, legacySession.streamId, legacySession.streamId],
  );
});

test("does not replace non-null reconciliation state for an active stream", async () => {
  const activeSession = {
    streamId: "local-stream:99999999-9999-4999-8999-999999999999",
    startedAt: "2026-08-08T19:45:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    initialReconciliationState: {
      version: 4,
      activeInventoryBaselineId:
        "inventory-baseline:99999999-9999-4999-8999-999999999999",
      inventoryBaselines: [
        {
          baselineId:
            "inventory-baseline:99999999-9999-4999-8999-999999999999",
          sourceFingerprint: null,
          inventory: [
            {
              sku: "EXISTING-SKU",
              item: "Existing item",
              style: "",
              size: "OS",
              quantityOnHandAtImport: 2,
              unitCostCents: 250,
            },
          ],
        },
      ],
      streams: [],
    },
    statefulReconciliation: true,
  });
  const request = harness.send(
    harness.createMessage({
      type: harness.coordinatorModule.COMMAND_TYPES.INITIALIZE_STATE,
      inventory:
        harness.preparedReconciliationState.inventoryBaselines[0].inventory,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "ACTIVE_STREAM_ALREADY_EXISTS",
      message:
        "End the active tracker stream before preparing another inventory baseline.",
    },
  });
  assert.deepEqual(
    harness.dispatchCalls.map((command) => command.type),
    [harness.coordinatorModule.COMMAND_TYPES.GET_STATE],
  );
});

test("recovers a session-first Start when the first inventory pin save fails", async () => {
  const harness = createWorkerHarness({
    usePreparedState: true,
    pinDispatchError: "known",
    pinFailureCount: 1,
  });
  const command = {
    type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
  };
  const first = harness.send(harness.createStreamMessage(command));

  assert.deepEqual(await first.response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not pin stream inventory.",
    },
  });

  const retry = harness.send(harness.createStreamMessage(command));
  const retryResponse = await retry.response;

  assert.equal(retryResponse.ok, true);
  assert.equal(retryResponse.data.result.status, "already_active");
  assert.deepEqual(
    harness.streamDispatchCalls.map((candidate) => candidate.type),
    [
      "get_stream_session",
      "start_stream",
      "get_stream_session",
      "start_stream",
    ],
  );
  assert.equal(
    harness.dispatchCalls.filter(
      (candidate) =>
        candidate.type ===
        harness.coordinatorModule.COMMAND_TYPES
          .PIN_STREAM_TO_INVENTORY_BASELINE,
    ).length,
    2,
  );
});

test("keeps rejected direct baseline creation behind Start in the worker FIFO", async () => {
  const startEntered = createDeferred();
  const releaseStart = createDeferred();
  const harness = createWorkerHarness({
    usePreparedState: true,
    async beforeStreamDispatch(command) {
      if (
        command.type ===
        harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM
      ) {
        startEntered.resolve();
        await releaseStart.promise;
      }
    },
  });
  const start = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );
  const create = harness.send(
    harness.createMessage({
      type:
        harness.coordinatorModule.COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
      baselineId:
        "inventory-baseline:44444444-4444-4444-8444-444444444444",
      sourceFingerprint: "fnv1a64:0000000000000000",
      inventory: [],
    }),
  );

  await startEntered.promise;
  assert.equal(harness.streamDispatchCalls.length, 2);
  releaseStart.resolve();
  assert.equal((await start.response).ok, true);
  assert.deepEqual(await create.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Inventory baselines can be changed only through a validated Sheet import.",
    },
  });
  assert.equal(
    harness.dispatchCalls.some(
      (candidate) =>
        candidate.type ===
        harness.coordinatorModule.COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
    ),
    false,
  );
});

test("does not expose baseline creation directly to the side panel", async () => {
  const harness = createWorkerHarness();
  const command = {
    type:
      harness.coordinatorModule.COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
    baselineId:
      "inventory-baseline:55555555-5555-4555-8555-555555555555",
    sourceFingerprint: "fnv1a64:1111111111111111",
    inventory: [
      {
        sku: "TEST-SKU",
        item: "Test item",
        style: "",
        size: "OS",
        quantityOnHandAtImport: 1,
        unitCostCents: 100,
      },
    ],
  };
  const request = harness.send(harness.createMessage(command));

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Inventory baselines can be changed only through a validated Sheet import.",
    },
  });
  assert.deepEqual(harness.streamDispatchCalls, []);
  assert.deepEqual(harness.dispatchCalls, []);
});

test("does not expose active baseline extension directly to the side panel", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createMessage({
      type:
        harness.coordinatorModule.COMMAND_TYPES
          .EXTEND_STREAM_INVENTORY_BASELINE,
      streamId: harness.activeStreamId,
      expectedBaselineId: harness.activeInventoryBaselineId,
      baselineId:
        "inventory-baseline:66666666-6666-4666-8666-666666666666",
      sourceFingerprint: "fnv1a64:2222222222222222",
      inventory: [],
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Inventory baselines can be changed only through a validated Sheet import.",
    },
  });
  assert.deepEqual(harness.dispatchCalls, []);
});

test("requires a confirmed imported baseline before a fresh Start", async () => {
  const harness = createWorkerHarness({
    usePreparedState: true,
    preparedSourceFingerprint: null,
  });
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "INVENTORY_IMPORT_REQUIRED",
      message:
        "Import and confirm Google Sheets inventory before starting a tracker stream.",
    },
  });
  assert.deepEqual(
    harness.streamDispatchCalls.map((command) => command.type),
    [harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION],
  );
  assert.equal(
    harness.streamDispatchCalls.some(
      (command) =>
        command.type ===
        harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    ),
    false,
  );
  assert.deepEqual(harness.inventoryImportCalls, [
    { type: "invalidate_previews" },
  ]);
});

test("keeps Start idempotent for an already-active legacy stream", async () => {
  const harness = createWorkerHarness({
    initialActiveSession: {
      streamId: "local-stream:77777777-7777-4777-8777-777777777777",
      startedAt: "2026-08-08T20:00:00.000Z",
      identitySource: "local_session",
    },
    usePreparedState: true,
    preparedSourceFingerprint: null,
  });
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );
  const response = await request.response;

  assert.equal(response.ok, true);
  assert.equal(response.data.result.status, "already_active");
  assert.deepEqual(
    harness.streamDispatchCalls.map((command) => command.type),
    ["get_stream_session", "start_stream"],
  );
  assert.deepEqual(
    harness.dispatchCalls.map((command) => command.type),
    ["pin_stream_to_inventory_baseline"],
  );
});

test("does not allow inactive legacy recovery to bypass Sheet import", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createMessage({
      type: harness.coordinatorModule.COMMAND_TYPES.INITIALIZE_STATE,
      inventory:
        harness.preparedReconciliationState.inventoryBaselines[0].inventory,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "INVENTORY_IMPORT_REQUIRED",
      message:
        "Import and confirm Google Sheets inventory before starting a tracker stream.",
    },
  });
  assert.deepEqual(harness.dispatchCalls, []);
});

test("routes exact inventory-import status and preview messages", async () => {
  const harness = createWorkerHarness({
    importStatusResult: {
      ready: false,
      baselineId: null,
      sourceFingerprint: null,
      summary: null,
    },
  });
  const status = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES.GET_IMPORT_STATUS,
    }),
  );
  const preview = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
      spreadsheetId: "1Abc_def-Ghij234567890",
    }),
  );

  assert.deepEqual(await status.response, {
    ok: true,
    data: {
      ready: false,
      baselineId: null,
      sourceFingerprint: null,
      summary: null,
    },
  });
  assert.deepEqual(await preview.response, {
    ok: true,
    data: { status: "invalid", issues: [] },
  });
  assert.deepEqual(harness.inventoryImportCalls, [
    { type: "get_import_status" },
    {
      type: "preview_google_sheet",
      spreadsheetId: "1Abc_def-Ghij234567890",
    },
  ]);
});

test("routes the exact local active-baseline preview message", async () => {
  const activeBaselinePreviewResult = {
    ready: true,
    baselineId:
      "inventory-baseline:22222222-2222-4222-8222-222222222222",
    inventory: [{
      sku: "TEST-SKU",
      item: "Test item",
      style: "",
      size: "OS",
      quantityOnHandAtImport: 1,
      unitCostCents: 100,
    }],
    summary: {
      rowCount: 1,
      totalQuantityOnHandAtImport: 1,
      totalInventoryCostCents: 100,
    },
  };
  const harness = createWorkerHarness({ activeBaselinePreviewResult });
  const request = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES
          .GET_ACTIVE_BASELINE_PREVIEW,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: activeBaselinePreviewResult,
  });
  assert.deepEqual(harness.inventoryImportCalls, [{
    type: "get_active_baseline_preview",
  }]);
});

test("confirmed import alone can dispatch internal baseline creation", async () => {
  const createCommand = {
    baselineId:
      "inventory-baseline:22222222-2222-4222-8222-222222222222",
    sourceFingerprint: "fnv1a64:1111111111111111",
    inventory: [
      {
        sku: "TEST-SKU",
        item: "Test item",
        style: "",
        size: "OS",
        quantityOnHandAtImport: 1,
        unitCostCents: 100,
      },
    ],
  };
  const harness = createWorkerHarness({ importCreateCommand: createCommand });
  const request = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES
          .CONFIRM_GOOGLE_SHEET_IMPORT,
      previewToken:
        "inventory-preview:11111111-1111-4111-8111-111111111111",
    }),
  );

  assert.equal((await request.response).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.dispatchCalls)), [
    {
      type:
        harness.coordinatorModule.COMMAND_TYPES.CREATE_INVENTORY_BASELINE,
      ...createCommand,
    },
  ]);
});

test("blocks Sheet preview while a tracker stream is active", async () => {
  const harness = createWorkerHarness({
    initialActiveSession: {
      streamId: "local-stream:77777777-7777-4777-8777-777777777777",
      startedAt: "2026-08-08T20:00:00.000Z",
      identitySource: "local_session",
    },
  });
  const request = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES.PREVIEW_GOOGLE_SHEET,
      spreadsheetId: "1Abc_def-Ghij234567890",
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "ACTIVE_STREAM_ALREADY_EXISTS",
      message: "End the active tracker stream before importing inventory.",
    },
  });
});

test("adds Sheet SKUs using only worker-owned active stream context", async () => {
  const streamId =
    "local-stream:11111111-1111-4111-8111-111111111111";
  const baselineId =
    "inventory-baseline:11111111-1111-4111-8111-111111111111";
  const harness = createWorkerHarness({
    statefulReconciliation: true,
    initialActiveSession: {
      streamId,
      startedAt: "2026-08-08T20:00:00.000Z",
      identitySource: "local_session",
    },
    initialReconciliationState: {
      version: 4,
      activeInventoryBaselineId: baselineId,
      inventoryBaselines: [{
        baselineId,
        sourceFingerprint: "fnv1a64:1111111111111111",
        inventory: [{
          sku: "TEST-SKU",
          item: "Test item",
          style: "",
          size: "OS",
          quantityOnHandAtImport: 1,
          unitCostCents: 100,
        }],
      }],
      streams: [{
        streamId,
        inventoryBaselineId: baselineId,
        variations: [],
      }],
    },
  });
  const request = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES
          .ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
      spreadsheetId: "1Abc_def-Ghij234567890",
    }),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: {
      status: "already_current",
      baselineId,
      sourceFingerprint: "fnv1a64:1111111111111111",
      summary: {
        rowCount: 1,
        totalQuantityOnHandAtImport: 1,
        totalInventoryCostCents: 100,
      },
      addedSkus: [],
    },
  });
  assert.deepEqual(harness.inventoryImportCalls, [{
    type: "add_active_stream_skus_from_google_sheet",
    spreadsheetId: "1Abc_def-Ghij234567890",
    context: { streamId, expectedBaselineId: baselineId },
  }]);
  assert.equal(
    harness.dispatchCalls.filter(
      (command) =>
        command.type ===
          harness.coordinatorModule.COMMAND_TYPES
            .PIN_STREAM_TO_INVENTORY_BASELINE,
    ).length,
    1,
  );
});

test("rejects active-stream Sheet additions when no stream is active", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES
          .ADD_ACTIVE_STREAM_SKUS_FROM_GOOGLE_SHEET,
      spreadsheetId: "1Abc_def-Ghij234567890",
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "NO_ACTIVE_STREAM",
      message: "Start or resume a tracker stream before adding new SKUs.",
    },
  });
  assert.deepEqual(harness.inventoryImportCalls, []);
});

test("accepts inventory-import messages only from the exact side panel", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createImportMessage({
      type:
        harness.inventoryImportProtocol.COMMAND_TYPES.GET_IMPORT_STATUS,
    }),
    harness.createSender({
      url: "https://shop.tiktok.com/streamer/live/product/dashboard",
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "This extension context cannot issue inventory-import commands.",
    },
  });
  assert.deepEqual(harness.inventoryImportCalls, []);
});

test("does not expose the internal stream-pin command to the side panel", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createMessage({
      type:
        harness.coordinatorModule.COMMAND_TYPES
          .PIN_STREAM_TO_INVENTORY_BASELINE,
      streamId: harness.activeStreamId,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Inventory baseline pins are owned by the extension service worker.",
    },
  });
  assert.equal(harness.dispatchCalls.length, 0);
});

test("rejects stream-session commands from the dashboard content script", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
    harness.createSender({
      url: "https://shop.tiktok.com/streamer/live/product/dashboard",
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message: "This extension context cannot issue stream-session commands.",
    },
  });
  assert.equal(harness.streamDispatchCalls.length, 0);
});

test("serializes active-stream storage failures without exposing internals", async () => {
  const harness = createWorkerHarness({
    streamDispatchError: "known",
    usePreparedState: true,
  });
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );
  const response = await request.response;

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not save stream.",
    },
  });
  assert.equal("stack" in response.error, false);
  assert.equal("cause" in response.error, false);
});

test("accepts batch observations only through the capture boundary", async () => {
  const harness = createWorkerHarness({
    captureDispatchResult: {
      status: "accepted",
    },
  });
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44, 43, 42],
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.equal(request.returnValue, true);
  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.captureDispatchCalls, [event]);
  assert.equal(harness.dispatchCalls.length, 0);
  assert.equal(harness.streamDispatchCalls.length, 0);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
});

test("accepts completed payments through the capture boundary", async () => {
  const harness = createWorkerHarness();
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
    variationNumber: 44,
    soldPriceCents: 700,
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.captureDispatchCalls, [event]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
});

test("accepts sanitized payment-status changes through the capture boundary", async () => {
  const harness = createWorkerHarness();
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_PAYMENT_STATUSES,
    statuses: [
      { variationNumber: 44, observedPaymentStatus: "payment_fixing" },
      { variationNumber: 43, observedPaymentStatus: "payment_processing" },
      { variationNumber: 42, observedPaymentStatus: "canceled" },
    ],
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.captureDispatchCalls, [event]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
});

test("accepts sanitized Attributed GMV through the capture boundary", async () => {
  const harness = createWorkerHarness();
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_ATTRIBUTED_GMV,
    attributedGmvDisplay: "$4.64K",
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.captureDispatchCalls, [event]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
});

test("accepts a sanitized bidding variation through the capture boundary", async () => {
  const harness = createWorkerHarness();
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION,
    variationNumber: 252,
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.captureDispatchCalls, [event]);
});

test("a new bidding variation emits canonical and retained-auction invalidations", async () => {
  const harness = createWorkerHarness({ liveBidChanged: true });
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION,
    variationNumber: 253,
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
    {
      channel: "tiktok-live-tracker.live-bid",
      version: 1,
      event: { type: "live_bid_changed" },
    },
  ]);
});

test("an applied queued item emits canonical and queue invalidations", async () => {
  const harness = createWorkerHarness({ nextItemQueueChanged: true });
  const request = harness.send(
    harness.createCaptureMessage({
      type: harness.captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_VARIATION,
      variationNumber: 253,
    }),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
    {
      channel: "tiktok-live-tracker.next-item-queue",
      version: 1,
      event: { type: "queue_changed" },
    },
  ]);
});

test("live bid prices emit only their lightweight data-free invalidation", async () => {
  const harness = createWorkerHarness({ liveBidChanged: true });
  const event = {
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_PRICE,
    variationNumber: 252,
    bidPriceCents: 2800,
  };
  const request = harness.send(
    harness.createCaptureMessage(event),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.deepEqual(harness.captureDispatchCalls, [event]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.live-bid",
      version: 1,
      event: { type: "live_bid_changed" },
    },
  ]);
});

test("silently ignored stale live bid prices do not invalidate either UI path", async () => {
  const harness = createWorkerHarness({ liveBidChanged: false });
  const request = harness.send(
    harness.createCaptureMessage({
      type: harness.captureProtocol.EVENT_TYPES.OBSERVE_BIDDING_PRICE,
      variationNumber: 251,
      bidPriceCents: 2800,
    }),
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: { status: "accepted" },
  });
  assert.equal(harness.runtimeSendMessages.length, 0);
});

test("only the exact side panel can read the transient live bid", async () => {
  const expected = {
    liveAuction: {
      variationNumber: 252,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  };
  const harness = createWorkerHarness({ liveBidDispatchResult: expected });
  const message = liveBidProtocol.createLiveBidMessage();

  assert.deepEqual(
    await harness.send(message, harness.createSender()).response,
    { ok: true, data: expected },
  );

  assert.deepEqual(
    await harness.send(message, harness.createCaptureSender()).response,
    {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message: "This extension context cannot issue live-bid commands.",
      },
    },
  );
});

test("only the exact side panel can read and toggle the next-item queue", async () => {
  const expected = { status: "queued", queuedSku: "TEST-SKU" };
  const harness = createWorkerHarness({
    nextItemQueueDispatchResult: expected,
  });
  const message = nextItemQueueProtocol.createNextItemQueueMessage({
    type: nextItemQueueProtocol.COMMAND_TYPES.TOGGLE_QUEUE,
    expectedStreamId: harness.activeStreamId,
    expectedVariationNumber: 252,
    sku: "TEST-SKU",
  });

  assert.deepEqual(
    await harness.send(message, harness.createSender()).response,
    { ok: true, data: expected },
  );
  assert.deepEqual(harness.nextItemQueueCalls, [
    {
      type: "dispatch",
      command: {
        type: "toggle_queue",
        expectedStreamId: harness.activeStreamId,
        expectedVariationNumber: 252,
        sku: "TEST-SKU",
      },
    },
  ]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.next-item-queue",
      version: 1,
      event: { type: "queue_changed" },
    },
  ]);

  assert.deepEqual(
    await harness.send(message, harness.createCaptureSender()).response,
    {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message:
          "This extension context cannot issue next-item queue commands.",
      },
    },
  );
  assert.equal(harness.nextItemQueueCalls.length, 1);
});

test("mapping the current item from the queue boundary refreshes canonical and live-bid views", async () => {
  const expected = { status: "mapped_current", queuedSku: null };
  const canonicalState = {
    version: 7,
    marker: "current variation mapped",
  };
  const harness = createWorkerHarness({
    dispatchResult: { state: canonicalState, result: null },
    liveBidSyncResult: { status: "accepted" },
    nextItemQueueDispatchResult: expected,
  });
  const message = nextItemQueueProtocol.createNextItemQueueMessage({
    type: nextItemQueueProtocol.COMMAND_TYPES.TOGGLE_QUEUE,
    expectedStreamId: harness.activeStreamId,
    expectedVariationNumber: 252,
    sku: "TEST-SKU",
  });

  assert.deepEqual(
    await harness.send(message, harness.createSender()).response,
    { ok: true, data: expected },
  );
  assert.deepEqual(harness.nextItemQueueCalls, [
    {
      type: "dispatch",
      command: {
        type: "toggle_queue",
        expectedStreamId: harness.activeStreamId,
        expectedVariationNumber: 252,
        sku: "TEST-SKU",
      },
    },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatchCalls)),
    [{ type: "get_state" }],
  );
  assert.deepEqual(harness.liveBidSyncCalls, [
    {
      streamId: harness.activeStreamId,
      state: canonicalState,
    },
  ]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.live-bid",
      version: 1,
      event: { type: "live_bid_changed" },
    },
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
  assert.equal(
    harness.runtimeSendMessages.some(
      (notification) =>
        notification.channel === "tiktok-live-tracker.next-item-queue",
    ),
    false,
  );

  assert.deepEqual(
    await harness.send(message, harness.createCaptureSender()).response,
    {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message:
          "This extension context cannot issue next-item queue commands.",
      },
    },
  );
  assert.equal(harness.nextItemQueueCalls.length, 1);
});

test("mapping the live item while reviewing history refreshes canonical and live-bid views without changing the queue", async () => {
  const expected = { status: "mapped_current", sku: "TEST-SKU" };
  const canonicalState = {
    version: 7,
    marker: "historical view mapped the live variation",
  };
  const harness = createWorkerHarness({
    dispatchResult: { state: canonicalState, result: null },
    liveBidSyncResult: { status: "accepted" },
    nextItemQueueDispatchResult: expected,
  });
  const message = nextItemQueueProtocol.createNextItemQueueMessage({
    type: nextItemQueueProtocol.COMMAND_TYPES.MAP_CURRENT,
    expectedStreamId: harness.activeStreamId,
    expectedVariationNumber: 252,
    sku: "TEST-SKU",
  });

  assert.deepEqual(
    await harness.send(message, harness.createSender()).response,
    { ok: true, data: expected },
  );
  assert.deepEqual(harness.nextItemQueueCalls, [
    {
      type: "dispatch",
      command: {
        type: "map_current",
        expectedStreamId: harness.activeStreamId,
        expectedVariationNumber: 252,
        sku: "TEST-SKU",
      },
    },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatchCalls)),
    [{ type: "get_state" }],
  );
  assert.deepEqual(harness.liveBidSyncCalls, [
    {
      streamId: harness.activeStreamId,
      state: canonicalState,
    },
  ]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.live-bid",
      version: 1,
      event: { type: "live_bid_changed" },
    },
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
  assert.equal(
    harness.runtimeSendMessages.some(
      (notification) =>
        notification.channel === "tiktok-live-tracker.next-item-queue",
    ),
    false,
  );

  assert.deepEqual(
    await harness.send(message, harness.createCaptureSender()).response,
    {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message:
          "This extension context cannot issue next-item queue commands.",
      },
    },
  );
  assert.equal(harness.nextItemQueueCalls.length, 1);
});

test("unmapping the live item from history refreshes canonical and live-bid views without changing the queue", async () => {
  const expected = { status: "unmapped_current", sku: "TEST-SKU" };
  const canonicalState = {
    version: 7,
    marker: "historical view unmapped the live variation",
  };
  const harness = createWorkerHarness({
    dispatchResult: { state: canonicalState, result: null },
    liveBidSyncResult: { status: "accepted" },
    nextItemQueueDispatchResult: expected,
  });
  const message = nextItemQueueProtocol.createNextItemQueueMessage({
    type: nextItemQueueProtocol.COMMAND_TYPES.MAP_CURRENT,
    expectedStreamId: harness.activeStreamId,
    expectedVariationNumber: 252,
    sku: "TEST-SKU",
  });

  assert.deepEqual(
    await harness.send(message, harness.createSender()).response,
    { ok: true, data: expected },
  );
  assert.deepEqual(harness.nextItemQueueCalls, [
    {
      type: "dispatch",
      command: {
        type: "map_current",
        expectedStreamId: harness.activeStreamId,
        expectedVariationNumber: 252,
        sku: "TEST-SKU",
      },
    },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.dispatchCalls)),
    [{ type: "get_state" }],
  );
  assert.deepEqual(harness.liveBidSyncCalls, [
    {
      streamId: harness.activeStreamId,
      state: canonicalState,
    },
  ]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.live-bid",
      version: 1,
      event: { type: "live_bid_changed" },
    },
    {
      channel: "tiktok-live-tracker.capture-state",
      version: 1,
      event: { type: "capture_state_changed" },
    },
  ]);
  assert.equal(
    harness.runtimeSendMessages.some(
      (notification) =>
        notification.channel === "tiktok-live-tracker.next-item-queue",
    ),
    false,
  );
});

test("clearing the next-item queue emits only its queue invalidation", async () => {
  const expected = { status: "cleared", queuedSku: null };
  const harness = createWorkerHarness({
    nextItemQueueDispatchResult: expected,
  });
  const message = nextItemQueueProtocol.createNextItemQueueMessage({
    type: nextItemQueueProtocol.COMMAND_TYPES.TOGGLE_QUEUE,
    expectedStreamId: harness.activeStreamId,
    expectedVariationNumber: 252,
    sku: "TEST-SKU",
  });

  assert.deepEqual(
    await harness.send(message, harness.createSender()).response,
    { ok: true, data: expected },
  );
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.next-item-queue",
      version: 1,
      event: { type: "queue_changed" },
    },
  ]);
  assert.deepEqual(harness.liveBidSyncCalls, []);
  assert.deepEqual(harness.dispatchCalls, []);
});

test("queue reads do not emit invalidations and queue notifications are not commands", async () => {
  const harness = createWorkerHarness();
  const getMessage = nextItemQueueProtocol.createNextItemQueueMessage();

  assert.deepEqual(
    await harness.send(getMessage, harness.createSender()).response,
    { ok: true, data: { queuedSku: null } },
  );
  assert.equal(harness.runtimeSendMessages.length, 0);
  assert.equal(
    harness.listeners[0](
      nextItemQueueProtocol.createQueueChangedNotification(),
      harness.createSender(),
      () => undefined,
    ),
    false,
  );
  assert.equal(harness.nextItemQueueCalls.length, 1);
});

test("keeps accepted capture responses independent of notification delivery", async () => {
  for (const options of [
    { runtimeSendMessageError: new Error("no receiver") },
    { runtimeSendMessageThrows: new Error("runtime unavailable") },
  ]) {
    const harness = createWorkerHarness(options);
    const request = harness.send(
      harness.createCaptureMessage({
        type: harness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
        variationNumbers: [44],
      }),
      harness.createCaptureSender(),
    );

    assert.deepEqual(await request.response, {
      ok: true,
      data: { status: "accepted" },
    });
    assert.equal(harness.runtimeSendMessages.length, 1);
    assert.equal(harness.consoleErrors.length, 0);
  }
});

test("emits the capture notification only after persistence resolves", async () => {
  const dispatchStarted = createDeferred();
  const releaseDispatch = createDeferred();
  const harness = createWorkerHarness({
    async beforeCaptureDispatch() {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
    },
  });
  const request = harness.send(
    harness.createCaptureMessage({
      type: harness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [44],
    }),
    harness.createCaptureSender(),
  );

  await dispatchStarted.promise;
  assert.equal(request.getResponseCount(), 0);
  assert.equal(harness.runtimeSendMessages.length, 0);

  releaseDispatch.resolve();
  await request.response;
  assert.equal(harness.runtimeSendMessages.length, 1);
});

test("notifies only after the capture boundary accepts persistence", async () => {
  const nonAcceptedHarness = createWorkerHarness({
    captureDispatchResult: { status: "ignored" },
  });
  const nonAcceptedRequest = nonAcceptedHarness.send(
    nonAcceptedHarness.createCaptureMessage({
      type: nonAcceptedHarness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [44],
    }),
    nonAcceptedHarness.createCaptureSender(),
  );

  assert.deepEqual(await nonAcceptedRequest.response, {
    ok: true,
    data: { status: "ignored" },
  });
  assert.equal(nonAcceptedHarness.runtimeSendMessages.length, 0);

  const employeeHarness = createWorkerHarness();
  const employeeRequest = employeeHarness.send(
    employeeHarness.createMessage({ type: "get_state" }),
  );

  assert.deepEqual(await employeeRequest.response, {
    ok: true,
    data: { state: null, result: null },
  });
  assert.equal(employeeHarness.runtimeSendMessages.length, 0);
});

test("authenticates the exact top-frame LIVE product dashboard", async () => {
  const harness = createWorkerHarness();
  const message = harness.createCaptureMessage({
    type: harness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
    variationNumbers: [44],
  });
  const requests = [
    harness.send(
      message,
      harness.createCaptureSender({ id: "another-extension" }),
    ),
    harness.send(
      message,
      harness.createCaptureSender({
        url: "https://example.com/streamer/live/product/dashboard",
      }),
    ),
    harness.send(
      message,
      harness.createCaptureSender({
        url: "https://shop.tiktok.com/streamer/live/event/dashboard",
      }),
    ),
    harness.send(message, harness.createCaptureSender({ frameId: 1 })),
    harness.send(message, harness.createCaptureSender({ tab: null })),
    harness.send(message),
  ];

  for (const request of requests) {
    assert.deepEqual(await request.response, {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message:
          "Only the top-level TikTok LIVE product dashboard can submit capture events.",
      },
    });
  }

  assert.equal(harness.captureDispatchCalls.length, 0);
  assert.equal(harness.runtimeSendMessages.length, 0);
});

test("rejects capture payloads containing stream identity or extra data", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    {
      channel: harness.captureProtocol.MESSAGE_CHANNEL,
      version: harness.captureProtocol.MESSAGE_VERSION,
      event: {
        type: harness.captureProtocol.EVENT_TYPES.PAYMENT_COMPLETE,
        streamId: "content-controlled-stream",
        variationNumber: 44,
        soldPriceCents: 700,
      },
    },
    harness.createCaptureSender(),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "INVALID_CAPTURE_MESSAGE",
      message: "Capture event payment_complete has an invalid shape.",
    },
  });
  assert.equal(harness.captureDispatchCalls.length, 0);
  assert.equal(harness.runtimeSendMessages.length, 0);
});

test("serializes known capture failures without exposing internals", async () => {
  const harness = createWorkerHarness({ captureDispatchError: "known" });
  const request = harness.send(
    harness.createCaptureMessage({
      type: harness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [44],
    }),
    harness.createCaptureSender(),
  );
  const response = await request.response;

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "CAPTURE_PERSISTENCE_FAILED",
      message: "Could not persist capture.",
    },
  });
  assert.equal("stack" in response.error, false);
  assert.equal("cause" in response.error, false);
  assert.equal(harness.runtimeSendMessages.length, 0);
});

test("hides unexpected capture failures from the dashboard", async () => {
  const harness = createWorkerHarness({ captureDispatchError: "unexpected" });
  const request = harness.send(
    harness.createCaptureMessage({
      type: harness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [44],
    }),
    harness.createCaptureSender(),
  );
  const response = await request.response;

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "The capture command could not be completed.",
    },
  });
  assert.equal(JSON.stringify(response).includes("sensitive"), false);
  assert.equal(harness.consoleErrors.length, 1);
  assert.equal(harness.runtimeSendMessages.length, 0);
});

test("orders capture and stream lifecycle messages through one worker FIFO", async () => {
  const startStarted = createDeferred();
  const releaseStart = createDeferred();
  const startFirstHarness = createWorkerHarness({
    usePreparedState: true,
    async beforeStreamDispatch(command) {
      if (
        command.type ===
        startFirstHarness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM
      ) {
        startStarted.resolve();
        await releaseStart.promise;
      }
    },
  });
  const startRequest = startFirstHarness.send(
    startFirstHarness.createStreamMessage({
      type:
        startFirstHarness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
  );
  const captureAfterStart = startFirstHarness.send(
    startFirstHarness.createCaptureMessage({
      type: startFirstHarness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [43],
    }),
    startFirstHarness.createCaptureSender(),
  );

  await startStarted.promise;
  assert.equal(startFirstHarness.captureDispatchCalls.length, 0);
  releaseStart.resolve();
  await Promise.all([startRequest.response, captureAfterStart.response]);
  assert.equal(startFirstHarness.captureDispatchCalls.length, 1);

  const captureStarted = createDeferred();
  const releaseCapture = createDeferred();
  const captureFirstHarness = createWorkerHarness({
    async beforeCaptureDispatch() {
      captureStarted.resolve();
      await releaseCapture.promise;
    },
  });
  const captureRequest = captureFirstHarness.send(
    captureFirstHarness.createCaptureMessage({
      type:
        captureFirstHarness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [44],
    }),
    captureFirstHarness.createCaptureSender(),
  );
  const endRequest = captureFirstHarness.send(
    captureFirstHarness.createStreamMessage({
      type:
        captureFirstHarness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
      streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    }),
  );

  await captureStarted.promise;
  assert.equal(captureFirstHarness.streamDispatchCalls.length, 0);
  releaseCapture.resolve();
  await Promise.all([captureRequest.response, endRequest.response]);
  assert.deepEqual(
    captureFirstHarness.streamDispatchCalls.map(({ type }) => type),
    [
      captureFirstHarness.streamCoordinatorModule.COMMAND_TYPES
        .GET_STREAM_SESSION,
      captureFirstHarness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
    ],
  );

  const endStarted = createDeferred();
  const releaseEnd = createDeferred();
  const endFirstHarness = createWorkerHarness({
    async beforeStreamDispatch() {
      endStarted.resolve();
      await releaseEnd.promise;
    },
  });
  const firstEndRequest = endFirstHarness.send(
    endFirstHarness.createStreamMessage({
      type: endFirstHarness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
      streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    }),
  );
  const laterCaptureRequest = endFirstHarness.send(
    endFirstHarness.createCaptureMessage({
      type: endFirstHarness.captureProtocol.EVENT_TYPES.OBSERVE_VARIATIONS,
      variationNumbers: [45],
    }),
    endFirstHarness.createCaptureSender(),
  );

  await endStarted.promise;
  assert.equal(endFirstHarness.captureDispatchCalls.length, 0);
  releaseEnd.resolve();
  await Promise.all([firstEndRequest.response, laterCaptureRequest.response]);
  assert.equal(endFirstHarness.captureDispatchCalls.length, 1);
});

test("normal End saves and finalizes a report before clearing the active session", async () => {
  const activeSession = {
    streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-08T20:00:00.000Z",
    identitySource: "local_session",
  };
  const reportSaveStarted = createDeferred();
  const releaseReportSave = createDeferred();
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    nextItemQueueClearResult: { status: "cleared" },
    usePreparedState: true,
    async beforeReportPrepare() {
      reportSaveStarted.resolve();
      await releaseReportSave.promise;
    },
  });
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
      streamId: activeSession.streamId,
    }),
  );

  await reportSaveStarted.promise;
  assert.deepEqual(
    harness.streamDispatchCalls.map(({ type }) => type),
    [harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION],
  );
  releaseReportSave.resolve();
  const response = await request.response;

  assert.deepEqual(response, {
    ok: true,
    data: {
      state: { version: 1, activeSession: null },
      result: {
        status: "ended",
        reportId:
          "stream-report:11111111-1111-4111-8111-111111111111",
        reportLifecycleStatus: "finalized",
      },
    },
  });
  assert.deepEqual(
    harness.reportCalls
      .filter(({ type }) => ["prepare", "finalize"].includes(type))
      .map(({ type }) => type),
    ["prepare", "finalize"],
  );
  assert.equal(
    harness.reportCalls.find(({ type }) => type === "prepare").input.startedAt,
    activeSession.startedAt,
  );
  assert.deepEqual(harness.nextItemQueueCalls, [
    { type: "clear_for_stream", streamId: activeSession.streamId },
  ]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.next-item-queue",
      version: 1,
      event: { type: "queue_changed" },
    },
  ]);
});

test("End without report skips report creation and ends only the local tracker stream", async () => {
  const activeSession = {
    streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-08T20:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    nextItemQueueClearResult: { status: "cleared" },
    usePreparedState: true,
  });
  const request = harness.send(
    harness.createStreamMessage({
      type:
        harness.streamCoordinatorModule.COMMAND_TYPES
          .END_STREAM_WITHOUT_REPORT,
      streamId: activeSession.streamId,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: {
      state: { version: 1, activeSession: null },
      result: {
        status: "ended_without_report",
        reportId: null,
        reportLifecycleStatus: null,
      },
    },
  });
  assert.deepEqual(
    harness.reportCalls
      .filter(({ type }) => ["discard", "prepare", "finalize"].includes(type))
      .map(({ type }) => type),
    ["discard"],
  );
  assert.deepEqual(
    harness.streamDispatchCalls.map(({ type }) => type),
    [
      harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION,
      harness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM_WITHOUT_REPORT,
    ],
  );
  assert.deepEqual(harness.nextItemQueueCalls, [
    { type: "clear_for_stream", streamId: activeSession.streamId },
  ]);
});

test("a report save failure leaves the stream active and exposes End without report", async () => {
  const activeSession = {
    streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-08T20:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    nextItemQueueClearResult: { status: "cleared" },
    usePreparedState: true,
    reportPrepareError: "known",
  });
  const failed = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
      streamId: activeSession.streamId,
    }),
  );

  assert.deepEqual(await failed.response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not save the stream report.",
    },
  });
  assert.deepEqual(
    harness.streamDispatchCalls.map(({ type }) => type),
    [harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION],
  );
  assert.deepEqual(harness.nextItemQueueCalls, []);

  const fallback = harness.send(
    harness.createStreamMessage({
      type:
        harness.streamCoordinatorModule.COMMAND_TYPES
          .END_STREAM_WITHOUT_REPORT,
      streamId: activeSession.streamId,
    }),
  );

  assert.deepEqual(await fallback.response, {
    ok: true,
    data: {
      state: { version: 1, activeSession: null },
      result: {
        status: "ended_without_report",
        reportId: null,
        reportLifecycleStatus: null,
      },
    },
  });
  assert.deepEqual(harness.nextItemQueueCalls, [
    { type: "clear_for_stream", streamId: activeSession.streamId },
  ]);
});

test("End without report removes a pending draft left by a failed session End", async () => {
  const activeSession = {
    streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-08T20:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    usePreparedState: true,
    endStreamDispatchError: "known",
    endStreamFailureCount: 1,
  });
  const normalEnd = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
      streamId: activeSession.streamId,
    }),
  );

  assert.equal((await normalEnd.response).ok, false);
  assert.deepEqual(
    harness.reportCalls
      .filter(({ type }) => ["prepare", "discard"].includes(type))
      .map(({ type }) => type),
    ["prepare"],
  );

  const fallback = harness.send(
    harness.createStreamMessage({
      type:
        harness.streamCoordinatorModule.COMMAND_TYPES
          .END_STREAM_WITHOUT_REPORT,
      streamId: activeSession.streamId,
    }),
  );
  const response = await fallback.response;

  assert.equal(response.ok, true);
  assert.equal(response.data.result.status, "ended_without_report");
  assert.equal(response.data.result.reportId, null);
  assert.deepEqual(
    harness.reportCalls
      .filter(({ type }) => ["prepare", "discard"].includes(type))
      .map(({ type }) => type),
    ["prepare", "discard"],
  );
});

test("a post-End finalization failure returns the saved pending report for restart repair", async () => {
  const activeSession = {
    streamId: "local-stream:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-08T20:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    usePreparedState: true,
    reportFinalizeError: true,
  });
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.END_STREAM,
      streamId: activeSession.streamId,
    }),
  );
  const response = await request.response;

  assert.equal(response.ok, true);
  assert.equal(response.data.state.activeSession, null);
  assert.equal(response.data.result.reportLifecycleStatus, "pending_end");
  assert.equal(harness.consoleErrors.length, 1);
});

test("report reads and archive mutations enforce exact extension senders", async () => {
  const harness = createWorkerHarness();
  const message = harness.createReportMessage({ type: "list_reports" });
  const archivedListMessage = harness.createReportMessage({
    type: "list_archived_reports",
  });
  const reportId =
    "stream-report:11111111-1111-4111-8111-111111111111";
  const sidePanelRead = harness.send(message);
  const reportPageRead = harness.send(
    archivedListMessage,
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=test`,
    }),
  );
  const reportPageGet = harness.send(
    harness.createReportMessage({ type: "get_report", reportId }),
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${encodeURIComponent(reportId)}`,
    }),
  );
  const dashboardRead = harness.send(message, harness.createCaptureSender());

  assert.deepEqual(await sidePanelRead.response, {
    ok: true,
    data: { reports: [] },
  });
  assert.deepEqual(await reportPageRead.response, {
    ok: true,
    data: { reports: [] },
  });
  assert.deepEqual(await reportPageGet.response, {
    ok: true,
    data: {
      reportId: null,
      lifecycleStatus: null,
      displayName: null,
      report: null,
    },
  });
  assert.deepEqual(await dashboardRead.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Only the extension side panel and packaged report page can read stream reports.",
    },
  });

  for (const type of [
    "archive_reports",
    "restore_reports",
    "delete_archived_reports",
  ]) {
    const mutation = harness.createReportMessage({
      type,
      reportIds: [reportId],
    });
    const sidePanelMutation = harness.send(mutation);
    const reportPageMutation = harness.send(
      mutation,
      harness.createSender({ url: `${harness.reportPageUrl}#saved` }),
    );

    assert.deepEqual(await sidePanelMutation.response, {
      ok: true,
      data: { reportIds: [reportId] },
    });
    assert.deepEqual(await reportPageMutation.response, {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message: "The packaged report page has read-only report access.",
      },
    });
  }

  const renameMessage = harness.createReportMessage({
    type: "rename_report",
    reportId,
    displayName: "August launch stream",
  });
  const sidePanelRename = harness.send(renameMessage);
  const reportPageRename = harness.send(
    renameMessage,
    harness.createSender({ url: `${harness.reportPageUrl}#saved` }),
  );

  assert.deepEqual(await sidePanelRename.response, {
    ok: true,
    data: {
      reportId,
      displayName: "August launch stream",
    },
  });
  assert.deepEqual(await reportPageRename.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message: "The packaged report page has read-only report access.",
    },
  });

  const unrelatedExtensionPage = harness.send(
    harness.createReportMessage({
      type: "archive_reports",
      reportIds: [reportId],
    }),
    harness.createSender({
      url: `chrome-extension://${harness.extensionId}/other.html`,
    }),
  );
  assert.deepEqual(await unrelatedExtensionPage.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Only the extension side panel and packaged report page can read stream reports.",
    },
  });
  const dashboardMutation = harness.send(
    harness.createReportMessage({
      type: "delete_archived_reports",
      reportIds: [reportId],
    }),
    harness.createCaptureSender(),
  );
  assert.deepEqual(await dashboardMutation.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Only the extension side panel and packaged report page can read stream reports.",
    },
  });
});

test("report mapping-correction commands enforce the exact packaged report page", async () => {
  const harness = createWorkerHarness();
  const reportId =
    "stream-report:11111111-1111-4111-8111-111111111111";
  const loadMessage = harness.createReportMessage({
    type: "get_offline_editor_data",
    reportId,
  });
  const changes = [
    {
      variationNumber: 10,
      expectedStatus: "payment_complete",
      expectedSku: "TEE-M",
      sku: "TEE-L",
    },
  ];
  const saveMessage = harness.createReportMessage({
    type: "save_offline_editor_mappings",
    reportId,
    changes,
  });
  const reportSender = harness.createSender({
    url: `${harness.reportPageUrl}?reportId=${encodeURIComponent(reportId)}`,
  });
  const unrelatedSender = harness.createSender({
    url: `chrome-extension://${harness.extensionId}/other.html`,
  });
  const removedEditorSender = harness.createSender({
    url:
      `chrome-extension://${harness.extensionId}/report/offline-editor.html` +
      `?reportId=${encodeURIComponent(reportId)}`,
  });
  const reportLoad = harness.send(loadMessage, reportSender);
  const sidePanelLoad = harness.send(loadMessage);
  const dashboardLoad = harness.send(
    loadMessage,
    harness.createCaptureSender(),
  );
  const unrelatedLoad = harness.send(loadMessage, unrelatedSender);
  const removedEditorLoad = harness.send(loadMessage, removedEditorSender);
  const reportSave = harness.send(saveMessage, reportSender);
  const sidePanelSave = harness.send(saveMessage);
  const dashboardSave = harness.send(
    saveMessage,
    harness.createCaptureSender(),
  );
  const unrelatedSave = harness.send(saveMessage, unrelatedSender);
  const removedEditorSave = harness.send(saveMessage, removedEditorSender);

  const loadResponse = await reportLoad.response;
  assert.equal(loadResponse.ok, true);
  assert.equal(loadResponse.data.reportId, reportId);
  assert.equal(loadResponse.data.eligibility.status, "editable");

  for (const request of [
    sidePanelLoad,
    dashboardLoad,
    unrelatedLoad,
    removedEditorLoad,
  ]) {
    assert.deepEqual(await request.response, {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message: "Only the packaged report page can load correction data.",
      },
    });
  }

  assert.equal((await reportSave.response).ok, true);

  for (const request of [
    sidePanelSave,
    dashboardSave,
    unrelatedSave,
    removedEditorSave,
  ]) {
    assert.deepEqual(await request.response, {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message: "Only the packaged report page can save mapping corrections.",
      },
    });
  }

  assert.equal(
    harness.reportCalls.filter(
      (call) => call.type === "load_offline_editor",
    ).length,
    1,
  );
  assert.deepEqual(
    harness.reportCalls.find(
      (call) => call.type === "correct_offline_mappings",
    ).input,
    { reportId, changes },
  );
  assert.equal(
    harness.reportCalls.some((call) => call.type === "repair"),
    false,
  );
  assert.equal(harness.dispatchCalls.length, 0);
  assert.equal(harness.captureDispatchCalls.length, 0);
  assert.equal(harness.nextItemQueueCalls.length, 0);
  assert.equal(harness.inventoryImportCalls.length, 0);
  assert.equal(harness.runtimeSendMessages.length, 0);
  assert.equal(harness.streamDispatchCalls.length, 2);
  assert.ok(harness.streamDispatchCalls.every(
    (command) =>
      command.type ===
        harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION,
  ));
});

test("active tracker state blocks report mapping saves without side effects", async () => {
  const activeSession = {
    streamId: "local-stream:99999999-9999-4999-8999-999999999999",
    startedAt: "2026-08-29T19:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({ initialActiveSession: activeSession });
  const reportId =
    "stream-report:11111111-1111-4111-8111-111111111111";
  const sender = harness.createSender({
    url: `${harness.reportPageUrl}?reportId=${reportId}`,
  });
  const load = harness.send(
    harness.createReportMessage({
      type: "get_offline_editor_data",
      reportId,
    }),
    sender,
  );
  const save = harness.send(
    harness.createReportMessage({
      type: "save_offline_editor_mappings",
      reportId,
      changes: [
        {
          variationNumber: 10,
          expectedStatus: "payment_complete",
          expectedSku: "TEE-M",
          sku: "TEE-L",
        },
      ],
    }),
    sender,
  );

  assert.deepEqual((await load.response).data.eligibility, {
    status: "blocked",
    code: "ACTIVE_STREAM_ALREADY_EXISTS",
    reason: "End the active tracker stream before editing a report.",
  });
  assert.deepEqual(await save.response, {
    ok: false,
    error: {
      code: "ACTIVE_STREAM_ALREADY_EXISTS",
      message: "End the active tracker stream before editing a report.",
    },
  });
  assert.equal(
    harness.reportCalls.some(
      (call) => call.type === "correct_offline_mappings",
    ),
    false,
  );
  assert.equal(
    harness.reportCalls.some((call) => call.type === "repair"),
    false,
  );
  assert.equal(harness.dispatchCalls.length, 0);
  assert.equal(harness.inventoryImportCalls.length, 0);
  assert.equal(harness.streamDispatchCalls.length, 2);
  assert.ok(harness.streamDispatchCalls.every(
    (command) =>
      command.type ===
        harness.streamCoordinatorModule.COMMAND_TYPES.GET_STREAM_SESSION,
  ));
});

function createPaymentCorrectionFixture(options = {}) {
  const streamId =
    "local-stream:11111111-1111-4111-8111-111111111111";
  const reportId =
    "stream-report:11111111-1111-4111-8111-111111111111";
  const baselineId =
    "inventory-baseline:11111111-1111-4111-8111-111111111111";
  const reconciliationState = {
    version: 7,
    activeInventoryBaselineId: options.activeBaselineId ?? baselineId,
    inventoryBaselines: [],
    streams: [
      {
        streamId,
        inventoryBaselineId: baselineId,
        variations: [],
      },
      ...(options.laterStream === true
        ? [{
            streamId:
              "local-stream:22222222-2222-4222-8222-222222222222",
            inventoryBaselineId: baselineId,
            variations: [],
          }]
        : []),
    ],
  };
  const record = {
    reportId,
    lifecycleStatus: "finalized",
    report: {
      reportId,
      completedSales: [],
      inventory: [{
        sku: "KOREA-TEE-OS",
        item: "korea",
        style: "tee",
        size: "OS",
        unitCostCents: 500,
      }],
      itemPerformance: [{
        sku: "KOREA-TEE-OS",
        soldQuantity: 0,
      }],
      totals: {
        paymentFixingCount: options.paymentFixingCount ?? 1,
      },
      metadata: {
        streamId,
        inventoryBaselineId: baselineId,
        startedAt: "2026-08-19T10:00:00.000Z",
        endedAt: "2026-08-19T12:00:00.000Z",
        generatedAt: "2026-08-19T12:00:00.000Z",
      },
    },
  };

  return { baselineId, reconciliationState, record, reportId, streamId };
}

test("lists post-End payment-fixing orders only from the packaged report page", async () => {
  const fixture = createPaymentCorrectionFixture();
  const orders = [{
    variationNumber: 299,
    observedPaymentStatus: "payment_failed",
    mapped: true,
    sku: "TEST-SKU",
    item: "Test item",
    style: "",
    size: "OS",
  }];
  const harness = createWorkerHarness({
    statefulReconciliation: true,
    initialReconciliationState: fixture.reconciliationState,
    paymentReportRecord: fixture.record,
    paymentFixingOrders: orders,
  });
  const message = harness.createReportMessage({
    type: "list_payment_fixing_orders",
    reportId: fixture.reportId,
  });
  const fromReport = harness.send(
    message,
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    }),
  );
  const fromSidePanel = harness.send(message);

  assert.deepEqual(await fromReport.response, {
    ok: true,
    data: { reportId: fixture.reportId, orders },
  });
  assert.deepEqual(await fromSidePanel.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Only the packaged report page can correct ended-stream report data.",
    },
  });
});

test("resolves an eligible latest report canonically before replacing its snapshot", async () => {
  const fixture = createPaymentCorrectionFixture();
  const replacement = {
    ...fixture.record,
    report: {
      ...fixture.record.report,
      corrected: true,
    },
  };
  const harness = createWorkerHarness({
    statefulReconciliation: true,
    initialReconciliationState: fixture.reconciliationState,
    paymentReportRecord: fixture.record,
    replacementReportRecord: replacement,
  });
  const request = harness.send(
    harness.createReportMessage({
      type: "resolve_payment_fixing_order",
      reportId: fixture.reportId,
      variationNumber: 299,
      resolution: "payment_complete",
      soldPriceCents: 2800,
    }),
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    }),
  );

  assert.deepEqual(await request.response, { ok: true, data: replacement });
  assert.deepEqual(
    harness.dispatchCalls.find(
      (call) => call.type === "resolve_payment_fixing_order_internal",
    ),
    {
      type: "resolve_payment_fixing_order_internal",
      streamId: fixture.streamId,
      variationNumber: 299,
      resolution: "payment_complete",
      soldPriceCents: 2800,
    },
  );
  const replacementCall = harness.reportCalls.find(
    (call) => call.type === "replace_finalized",
  );

  assert.equal(replacementCall.input.reportId, fixture.reportId);
  assert.deepEqual(
    replacementCall.input.reconciliationState,
    fixture.reconciliationState,
  );
});

test("a report reload repairs a state-first payment resolution after report persistence failed", async () => {
  const fixture = createPaymentCorrectionFixture();
  const replacement = {
    ...fixture.record,
    report: {
      ...fixture.record.report,
      totals: { paymentFixingCount: 0 },
      corrected: true,
    },
  };
  const harness = createWorkerHarness({
    statefulReconciliation: true,
    initialReconciliationState: fixture.reconciliationState,
    paymentReportRecord: fixture.record,
    paymentFixingOrdersSequence: [[]],
    replacementReportRecord: replacement,
    reportReplacementError: "known",
    reportReplacementFailureCount: 1,
  });
  const sender = harness.createSender({
    url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
  });
  const firstAttempt = harness.send(
    harness.createReportMessage({
      type: "resolve_payment_fixing_order",
      reportId: fixture.reportId,
      variationNumber: 299,
      resolution: "canceled",
      soldPriceCents: null,
    }),
    sender,
  );

  assert.deepEqual(await firstAttempt.response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not save the corrected stream report.",
    },
  });
  assert.equal(
    harness.dispatchCalls.filter(
      (call) => call.type === "resolve_payment_fixing_order_internal",
    ).length,
    1,
  );

  const reloaded = harness.send(
    harness.createReportMessage({
      type: "get_report",
      reportId: fixture.reportId,
    }),
    sender,
  );

  assert.deepEqual(await reloaded.response, { ok: true, data: replacement });
  assert.equal(
    harness.reportCalls.filter(
      (call) => call.type === "replace_finalized",
    ).length,
    2,
  );
  assert.equal(
    harness.dispatchCalls.filter(
      (call) => call.type === "resolve_payment_fixing_order_internal",
    ).length,
    1,
  );
});

test("GET keeps a valid saved report readable when reconciliation is absent or fails", async () => {
  const fixture = createPaymentCorrectionFixture();

  for (const unavailableOptions of [
    {
      statefulReconciliation: true,
      initialReconciliationState: null,
    },
    { dispatchError: "known" },
  ]) {
    const harness = createWorkerHarness({
      paymentReportRecord: fixture.record,
      ...unavailableOptions,
    });
    const request = harness.send(
      harness.createReportMessage({
        type: "get_report",
        reportId: fixture.reportId,
      }),
      harness.createSender({
        url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
      }),
    );

    assert.deepEqual(await request.response, {
      ok: true,
      data: fixture.record,
    });
    assert.equal(
      harness.reportCalls.some((call) => call.type === "replace_finalized"),
      false,
    );
  }
});

test("GET with no fixing orders returns the saved report without reading canonical state", async () => {
  const fixture = createPaymentCorrectionFixture({ paymentFixingCount: 0 });
  const harness = createWorkerHarness({
    dispatchError: "known",
    paymentReportRecord: fixture.record,
  });
  const request = harness.send(
    harness.createReportMessage({
      type: "get_report",
      reportId: fixture.reportId,
    }),
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: true,
    data: fixture.record,
  });
  assert.equal(
    harness.dispatchCalls.some((call) => call.type === "get_state"),
    false,
  );
  assert.equal(
    harness.reportCalls.some((call) => call.type === "get_latest"),
    false,
  );
  assert.equal(
    harness.reportCalls.some((call) => call.type === "replace_finalized"),
    false,
  );
});

test("hides unsafe payment controls and rejects stale payment mutations", async () => {
  for (const unsafe of [
    { activeBaselineId:
      "inventory-baseline:99999999-9999-4999-8999-999999999999" },
    { laterStream: true },
  ]) {
    const fixture = createPaymentCorrectionFixture(unsafe);
    const harness = createWorkerHarness({
      statefulReconciliation: true,
      initialReconciliationState: fixture.reconciliationState,
      paymentReportRecord: fixture.record,
      paymentFixingOrders: [{ variationNumber: 299 }],
    });
    const sender = harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    });
    const listed = harness.send(
      harness.createReportMessage({
        type: "list_payment_fixing_orders",
        reportId: fixture.reportId,
      }),
      sender,
    );
    const resolved = harness.send(
      harness.createReportMessage({
        type: "resolve_payment_fixing_order",
        reportId: fixture.reportId,
        variationNumber: 299,
        resolution: "canceled",
        soldPriceCents: null,
      }),
      sender,
    );

    assert.deepEqual(await listed.response, {
      ok: true,
      data: { reportId: fixture.reportId, orders: [] },
    });
    const resolutionResponse = await resolved.response;

    assert.equal(resolutionResponse.ok, false);
    assert.equal(
      resolutionResponse.error.code,
      unsafe.laterStream === true
        ? "REPORT_NOT_LATEST_STREAM"
        : "REPORT_INVENTORY_BASELINE_STALE",
    );
    assert.equal(
      harness.reportCalls.some((call) => call.type === "replace_finalized"),
      false,
    );
  }
});

test("blocks payment correction during an active stream and for non-newest reports", async () => {
  const fixture = createPaymentCorrectionFixture();
  const newer = {
    ...fixture.record,
    reportId: "stream-report:22222222-2222-4222-8222-222222222222",
    report: {
      ...fixture.record.report,
      reportId: "stream-report:22222222-2222-4222-8222-222222222222",
    },
  };

  for (const harnessOptions of [
    {
      initialActiveSession: {
        streamId: fixture.streamId,
        startedAt: "2026-08-19T10:00:00.000Z",
      },
    },
    { latestReportRecord: newer },
  ]) {
    const harness = createWorkerHarness({
      statefulReconciliation: true,
      initialReconciliationState: fixture.reconciliationState,
      paymentReportRecord: fixture.record,
      ...harnessOptions,
    });
    const sender = harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    });
    const listed = harness.send(
      harness.createReportMessage({
        type: "list_payment_fixing_orders",
        reportId: fixture.reportId,
      }),
      sender,
    );
    const resolved = harness.send(
      harness.createReportMessage({
        type: "resolve_payment_fixing_order",
        reportId: fixture.reportId,
        variationNumber: 299,
        resolution: "canceled",
        soldPriceCents: null,
      }),
      sender,
    );

    assert.deepEqual(await listed.response, {
      ok: true,
      data: { reportId: fixture.reportId, orders: [] },
    });
    const resolutionResponse = await resolved.response;

    assert.equal(resolutionResponse.ok, false);
    assert.equal(
      resolutionResponse.error.code,
      harnessOptions.initialActiveSession
        ? "ACTIVE_STREAM_ALREADY_EXISTS"
        : "REPORT_NOT_LATEST",
    );
  }
});

test("lists every saved-report SKU during an active stream without reading canonical state", async () => {
  const fixture = createPaymentCorrectionFixture({ paymentFixingCount: 0 });
  fixture.record.report.inventory.push({
    sku: "UNSOLD-HAT-OS",
    item: "hat",
    style: "",
    size: "OS",
    unitCostCents: 300,
  });
  fixture.record.report.itemPerformance[0].soldQuantity = 69;
  fixture.record.report.itemPerformance.push({
    sku: "UNSOLD-HAT-OS",
    soldQuantity: 0,
  });
  const harness = createWorkerHarness({
    dispatchError: "known",
    initialActiveSession: {
      streamId: "local-stream:99999999-9999-4999-8999-999999999999",
      startedAt: "2026-08-20T10:00:00.000Z",
    },
    paymentReportRecord: fixture.record,
  });
  const message = harness.createReportMessage({
    type: "list_report_unit_costs",
    reportId: fixture.reportId,
  });
  const fromReport = harness.send(
    message,
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    }),
  );
  const fromSidePanel = harness.send(message);

  assert.deepEqual(await fromReport.response, {
    ok: true,
    data: {
      reportId: fixture.reportId,
      skus: [
        {
          sku: "KOREA-TEE-OS",
          item: "korea",
          style: "tee",
          size: "OS",
          unitCostCents: 500,
          completedSaleCount: 69,
        },
        {
          sku: "UNSOLD-HAT-OS",
          item: "hat",
          style: "",
          size: "OS",
          unitCostCents: 300,
          completedSaleCount: 0,
        },
      ],
    },
  });
  assert.deepEqual(await fromSidePanel.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message:
        "Only the packaged report page can correct ended-stream report data.",
    },
  });
  assert.equal(
    harness.dispatchCalls.some((call) =>
      ["get_state", "calculate_summary_internal"].includes(call.type)
    ),
    false,
  );
});

test("updates any selected report directly while a newer stream is active", async () => {
  const fixture = createPaymentCorrectionFixture({ paymentFixingCount: 0 });
  const replacement = {
    ...fixture.record,
    report: {
      ...fixture.record.report,
      inventory: [{ sku: "KOREA-TEE-OS", unitCostCents: 625 }],
      correctedCost: true,
    },
  };
  const harness = createWorkerHarness({
    dispatchError: "known",
    initialActiveSession: {
      streamId: "local-stream:99999999-9999-4999-8999-999999999999",
      startedAt: "2026-08-20T10:00:00.000Z",
    },
    paymentReportRecord: fixture.record,
    latestReportRecord: {
      reportId: "stream-report:99999999-9999-4999-8999-999999999999",
      lifecycleStatus: "finalized",
      report: { reportId: "stream-report:99999999-9999-4999-8999-999999999999" },
    },
    unitCostCorrectedReportRecord: replacement,
  });
  const response = harness.send(
    harness.createReportMessage({
      type: "update_report_unit_cost",
      reportId: fixture.reportId,
      sku: "KOREA-TEE-OS",
      unitCostCents: 625,
    }),
    harness.createSender({
      url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
    }),
  );

  assert.deepEqual(await response.response, { ok: true, data: replacement });
  assert.deepEqual(
    harness.reportCalls.find((call) => call.type === "correct_unit_cost"),
    {
      type: "correct_unit_cost",
      input: {
        reportId: fixture.reportId,
        sku: "KOREA-TEE-OS",
        unitCostCents: 625,
      },
    },
  );
  assert.equal(
    harness.dispatchCalls.some((call) => call.type === "get_state"),
    false,
  );
  assert.equal(
    harness.reportCalls.some((call) => call.type === "get_latest"),
    false,
  );
  assert.equal(
    harness.reportCalls.some((call) => call.type === "replace_finalized"),
    false,
  );
});

test("a failed report-only unit-cost save leaves the saved report readable and canonical state untouched", async () => {
  const fixture = createPaymentCorrectionFixture({ paymentFixingCount: 0 });
  const harness = createWorkerHarness({
    dispatchError: "known",
    paymentReportRecord: fixture.record,
    reportUnitCostCorrectionError: "known",
  });
  const sender = harness.createSender({
    url: `${harness.reportPageUrl}?reportId=${fixture.reportId}`,
  });
  const update = harness.send(
    harness.createReportMessage({
      type: "update_report_unit_cost",
      reportId: fixture.reportId,
      sku: "KOREA-TEE-OS",
      unitCostCents: 625,
    }),
    sender,
  );

  assert.deepEqual(await update.response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not save the corrected stream report.",
    },
  });
  const reloaded = harness.send(
    harness.createReportMessage({
      type: "get_report",
      reportId: fixture.reportId,
    }),
    sender,
  );
  assert.deepEqual(await reloaded.response, {
    ok: true,
    data: fixture.record,
  });
  assert.equal(
    harness.dispatchCalls.some((call) => call.type === "get_state"),
    false,
  );
});

test("ignores unrelated runtime messages", async () => {
  const harness = createWorkerHarness();
  const request = harness.send({ channel: "another-feature" });

  assert.equal(request.returnValue, false);
  await Promise.resolve();
  assert.equal(request.getResponseCount(), 0);
  assert.equal(harness.dispatchCalls.length, 0);
});

test("rejects malformed and unsupported message envelopes before dispatch", async () => {
  const harness = createWorkerHarness();
  const malformed = harness.send(
    harness.createMessage({ type: "get_state" }, { extra: true }),
  );
  const unsupported = harness.send(
    harness.createMessage({ type: "get_state" }, { version: 2 }),
  );

  assert.equal(malformed.returnValue, true);
  assert.equal(unsupported.returnValue, true);
  assert.deepEqual(await malformed.response, {
    ok: false,
    error: {
      code: "INVALID_MESSAGE",
      message: "The reconciliation message has an invalid shape.",
    },
  });
  assert.deepEqual(await unsupported.response, {
    ok: false,
    error: {
      code: "UNSUPPORTED_MESSAGE_VERSION",
      message: "Reconciliation message version 2 is not supported.",
    },
  });
  assert.equal(harness.dispatchCalls.length, 0);
});

test("accepts commands only from the exact extension side-panel page", async () => {
  const harness = createWorkerHarness();
  const message = harness.createMessage({ type: "get_state" });
  const wrongId = harness.send(
    message,
    harness.createSender({ id: "another-extension" }),
  );
  const wrongPage = harness.send(
    message,
    harness.createSender({
      url: `chrome-extension://${harness.extensionId}/popup.html`,
    }),
  );
  const contentScript = harness.send(
    message,
    harness.createSender({
      url: "https://shop.tiktok.com/streamer/live/product/dashboard",
    }),
  );

  for (const request of [wrongId, wrongPage, contentScript]) {
    assert.deepEqual(await request.response, {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message: "This extension context cannot issue reconciliation commands.",
      },
    });
  }

  assert.equal(harness.dispatchCalls.length, 0);
});

test("keeps capture-owned reconciliation commands disconnected from the side panel", async () => {
  const harness = createWorkerHarness();
  const requests = [
    harness.send(
      harness.createMessage({
        type: harness.coordinatorModule.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
        streamId: "stream-1",
        variationNumber: 1,
        soldPriceCents: 4800,
      }),
    ),
    harness.send(
      harness.createMessage({
        type: harness.coordinatorModule.COMMAND_TYPES.OBSERVE_VARIATIONS,
        streamId: "stream-1",
        variationNumbers: [1],
      }),
    ),
    harness.send(
      harness.createMessage({
        type:
          harness.coordinatorModule.COMMAND_TYPES.OBSERVE_PAYMENT_STATUSES,
        streamId: "stream-1",
        statuses: [
          {
            variationNumber: 1,
            observedPaymentStatus: "payment_processing",
          },
        ],
      }),
    ),
    harness.send(
      harness.createMessage({
        type:
          harness.coordinatorModule.COMMAND_TYPES.OBSERVE_ATTRIBUTED_GMV,
        streamId: "stream-1",
        attributedGmvDisplay: "$4.64K",
      }),
    ),
    harness.send(
      harness.createMessage({
        type:
          harness.coordinatorModule.COMMAND_TYPES
            .OBSERVE_BIDDING_VARIATION,
        streamId: "stream-1",
        variationNumber: 2,
      }),
    ),
  ];

  for (const request of requests) {
    assert.deepEqual(await request.response, {
      ok: false,
      error: {
        code: "UNAUTHORIZED_MESSAGE_SENDER",
        message: "Captured TikTok events cannot be issued by the side panel.",
      },
    });
  }
  assert.equal(harness.dispatchCalls.length, 0);
});

test("pins and forwards employee mutations only for the active stream", async () => {
  const activeSession = {
    streamId: "local-stream:66666666-6666-4666-8666-666666666666",
    startedAt: "2026-08-08T22:00:00.000Z",
    identitySource: "local_session",
  };
  const commandFactories = [
    (types) => ({
      type: types.MAP_VARIATION,
      streamId: activeSession.streamId,
      variationNumber: 203,
      sku: "TEST-SKU",
    }),
    (types) => ({
      type: types.UNMAP_VARIATION,
      streamId: activeSession.streamId,
      variationNumber: 203,
    }),
  ];

  for (const createCommand of commandFactories) {
    const harness = createWorkerHarness({ initialActiveSession: activeSession });
    const command = createCommand(harness.coordinatorModule.COMMAND_TYPES);
    const request = harness.send(harness.createMessage(command));

    assert.deepEqual(await request.response, {
      ok: true,
      data: { state: null, result: null },
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(harness.dispatchCalls)),
      [
        {
          type:
            harness.coordinatorModule.COMMAND_TYPES
              .PIN_STREAM_TO_INVENTORY_BASELINE,
          streamId: activeSession.streamId,
        },
        command,
      ],
    );
  }
});

test("employee mapping refreshes retained cost with a lightweight invalidation", async () => {
  const activeSession = {
    streamId: "local-stream:66666666-6666-4666-8666-666666666666",
    startedAt: "2026-08-08T22:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    liveBidSyncResult: { status: "accepted" },
  });
  const command = {
    type: harness.coordinatorModule.COMMAND_TYPES.MAP_VARIATION,
    streamId: activeSession.streamId,
    variationNumber: 203,
    sku: "TEST-SKU",
  };

  assert.deepEqual(
    await harness.send(harness.createMessage(command)).response,
    { ok: true, data: { state: null, result: null } },
  );
  assert.deepEqual(harness.liveBidSyncCalls, [
    { streamId: activeSession.streamId, state: null },
  ]);
  assert.deepEqual(harness.runtimeSendMessages, [
    {
      channel: "tiktok-live-tracker.live-bid",
      version: 1,
      event: { type: "live_bid_changed" },
    },
  ]);
});

test("retained-cost storage failure cannot reject a saved employee mapping", async () => {
  const activeSession = {
    streamId: "local-stream:66666666-6666-4666-8666-666666666666",
    startedAt: "2026-08-08T22:00:00.000Z",
    identitySource: "local_session",
  };
  const harness = createWorkerHarness({
    initialActiveSession: activeSession,
    liveBidSyncError: new Error("session storage unavailable"),
  });
  const command = {
    type: harness.coordinatorModule.COMMAND_TYPES.UNMAP_VARIATION,
    streamId: activeSession.streamId,
    variationNumber: 203,
  };

  assert.deepEqual(
    await harness.send(harness.createMessage(command)).response,
    { ok: true, data: { state: null, result: null } },
  );
  assert.equal(harness.liveBidSyncCalls.length, 1);
  assert.equal(harness.runtimeSendMessages.length, 0);
});

test("rejects employee mutations when no tracker stream is active", async () => {
  const harness = createWorkerHarness();
  const command = {
    type: harness.coordinatorModule.COMMAND_TYPES.MAP_VARIATION,
    streamId: harness.activeStreamId,
    variationNumber: 203,
    sku: "TEST-SKU",
  };
  const request = harness.send(harness.createMessage(command));

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "NO_ACTIVE_STREAM",
      message:
        "Start or resume a tracker stream before changing inventory mappings.",
    },
  });
  assert.equal(harness.dispatchCalls.length, 0);
});

test("rejects employee mutations for a caller-selected historical stream", async () => {
  const harness = createWorkerHarness({
    initialActiveSession: {
      streamId: "local-stream:66666666-6666-4666-8666-666666666666",
      startedAt: "2026-08-08T22:00:00.000Z",
      identitySource: "local_session",
    },
  });
  const command = {
    type: harness.coordinatorModule.COMMAND_TYPES.UNMAP_VARIATION,
    streamId: "local-stream:77777777-7777-4777-8777-777777777777",
    variationNumber: 203,
  };
  const request = harness.send(harness.createMessage(command));

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "ACTIVE_STREAM_MISMATCH",
      message:
        "The requested inventory change does not belong to the active tracker stream.",
    },
  });
  assert.equal(harness.dispatchCalls.length, 0);
});

test("does not forward an employee mutation when active-stream pinning fails", async () => {
  const harness = createWorkerHarness({
    initialActiveSession: {
      streamId: "local-stream:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-08T20:00:00.000Z",
      identitySource: "local_session",
    },
    pinDispatchError: "known",
    pinFailureCount: 1,
  });
  const command = {
    type: harness.coordinatorModule.COMMAND_TYPES.MAP_VARIATION,
    streamId: harness.activeStreamId,
    variationNumber: 203,
    sku: "TEST-SKU",
  };
  const request = harness.send(harness.createMessage(command));

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not pin stream inventory.",
    },
  });
  assert.deepEqual(
    harness.dispatchCalls.map((candidate) => candidate.type),
    [
      harness.coordinatorModule.COMMAND_TYPES
        .PIN_STREAM_TO_INVENTORY_BASELINE,
    ],
  );
});

test("serializes known failures without exposing Error internals", async () => {
  const harness = createWorkerHarness({
    dispatchError: "known",
    initialActiveSession: {
      streamId: "local-stream:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-08T20:00:00.000Z",
      identitySource: "local_session",
    },
  });
  const request = harness.send(
    harness.createMessage({
      type: "map_variation",
      streamId: harness.activeStreamId,
      variationNumber: 203,
      sku: "TEST-SKU",
    }),
  );
  const response = await request.response;

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "STORAGE_WRITE_FAILED",
      message: "Could not save.",
    },
  });
  assert.equal("stack" in response.error, false);
  assert.equal("cause" in response.error, false);
  assert.equal(harness.consoleErrors.length, 0);
});

test("hides unexpected failures and logs them only in the worker", async () => {
  const harness = createWorkerHarness({
    dispatchError: "unexpected",
    initialActiveSession: {
      streamId: "local-stream:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-08T20:00:00.000Z",
      identitySource: "local_session",
    },
  });
  const request = harness.send(
    harness.createMessage({
      type: "map_variation",
      streamId: harness.activeStreamId,
      variationNumber: 203,
      sku: "TEST-SKU",
    }),
  );
  const response = await request.response;

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "The reconciliation command could not be completed.",
    },
  });
  assert.equal(JSON.stringify(response).includes("sensitive"), false);
  assert.equal(harness.consoleErrors.length, 1);
});

test("fails closed when local storage access cannot be restricted", async () => {
  const accessError = new Error("access-level failure");
  const harness = createWorkerHarness({ accessLevelError: accessError });
  const request = harness.send(
    harness.createMessage({ type: "get_state" }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "STORAGE_ACCESS_RESTRICTION_FAILED",
      message: "Canonical storage access could not be secured.",
    },
  });
  assert.equal(harness.dispatchCalls.length, 0);
  assert.equal(harness.consoleErrors.length, 1);
  assert.equal(harness.consoleErrors[0][1], accessError);
});
