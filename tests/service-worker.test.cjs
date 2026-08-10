const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const captureProtocol = require("../extension/shared/capture-protocol.js");
const inventoryImportProtocol = require(
  "../extension/shared/inventory-import-protocol.js"
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
  let requestedPanelBehavior = null;
  let storeOptions = null;
  let coordinatorOptions = null;
  let streamStoreOptions = null;
  let streamCoordinatorOptions = null;
  let captureIntegrationOptions = null;
  let inventoryImportOptions = null;
  let remainingPinFailures = options.pinFailureCount ?? 0;
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

  class FakeCaptureIntegrationError extends Error {
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
  };
  const storageModule = {
    ReconciliationStorageError: FakeStorageError,
    createReconciliationStateStore(receivedOptions) {
      storeOptions = receivedOptions;
      return stateStore;
    },
  };
  const coordinator = {
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
      PIN_STREAM_TO_INVENTORY_BASELINE:
        "pin_stream_to_inventory_baseline",
      OBSERVE_ATTRIBUTED_GMV: "observe_attributed_gmv",
      OBSERVE_BIDDING_VARIATION: "observe_bidding_variation",
      OBSERVE_PAYMENT_STATUSES: "observe_payment_statuses",
      OBSERVE_VARIATIONS: "observe_variations",
      MAP_VARIATION: "map_variation",
      MARK_UNPAID: "mark_unpaid",
      RECORD_PAYMENT_COMPLETE: "record_payment_complete",
      UNMAP_VARIATION: "unmap_variation",
      UNDO_MARK_UNPAID: "undo_mark_unpaid",
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
        command.type === streamCoordinatorModule.COMMAND_TYPES.END_STREAM
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
    },
    StreamSessionCoordinatorError: FakeStreamCoordinatorError,
    createStreamSessionCoordinator(receivedOptions) {
      streamCoordinatorOptions = receivedOptions;
      return streamCoordinator;
    },
  };
  const captureEventIntegration = {
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
    TikTokLiveTrackerStreamSession: streamSession,
    TikTokLiveTrackerStreamSessionStorage: streamStorageModule,
    TikTokLiveTrackerStreamSessionCoordinator: streamCoordinatorModule,
    TikTokLiveTrackerCaptureProtocol: captureProtocol,
    TikTokLiveTrackerCaptureIntegration: captureIntegrationModule,
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
      storage: { local: storageArea },
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
    getInventoryImportOptions: () => inventoryImportOptions,
    imports,
    inventoryImportCalls,
    inventoryImportProtocol,
    listeners,
    reconciliation,
    runtimeSendMessages,
    send,
    sidePanelUrl,
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
    "shared/stream-session.js",
    "shared/stream-session-storage.js",
    "shared/stream-session-coordinator.js",
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
        "Inventory baselines can be created only through a confirmed Sheet import.",
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
        "Inventory baselines can be created only through a confirmed Sheet import.",
    },
  });
  assert.deepEqual(harness.streamDispatchCalls, []);
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

test("does not allow inactive mock initialization to bypass Sheet import", async () => {
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
  assert.equal(captureFirstHarness.streamDispatchCalls.length, 1);

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

test("rejects manual unpaid commands because Live payment outcomes are automatic", async () => {
  const activeSession = {
    streamId: "local-stream:66666666-6666-4666-8666-666666666666",
    startedAt: "2026-08-08T22:00:00.000Z",
    identitySource: "local_session",
  };

  for (const typeName of ["MARK_UNPAID", "UNDO_MARK_UNPAID"]) {
    const harness = createWorkerHarness({ initialActiveSession: activeSession });
    const request = harness.send(
      harness.createMessage({
        type: harness.coordinatorModule.COMMAND_TYPES[typeName],
        streamId: activeSession.streamId,
        variationNumber: 203,
      }),
    );

    assert.deepEqual(await request.response, {
      ok: false,
      error: {
        code: "MANUAL_UNPAID_DISABLED",
        message:
          "Live payment failures and cancellations are tracked automatically from TikTok.",
      },
    });
    assert.equal(harness.dispatchCalls.length, 0);
  }
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
