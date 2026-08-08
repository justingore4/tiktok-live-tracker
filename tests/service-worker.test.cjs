const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const workerSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "service-worker.js"),
  "utf8",
);

function createWorkerHarness(options = {}) {
  const imports = [];
  const listeners = [];
  const dispatchCalls = [];
  const streamDispatchCalls = [];
  const consoleErrors = [];
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
  const sidePanelUrl =
    `chrome-extension://${extensionId}/tagger/sidepanel.html`;
  let requestedPanelBehavior = null;
  let storeOptions = null;
  let coordinatorOptions = null;
  let streamStoreOptions = null;
  let streamCoordinatorOptions = null;

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

  const reconciliation = {
    ReconciliationError: FakeReconciliationError,
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

      if (options.dispatchError === "known") {
        throw new FakeStorageError("STORAGE_WRITE_FAILED", "Could not save.");
      }

      if (options.dispatchError === "unexpected") {
        throw new Error("sensitive failure details");
      }

      return options.dispatchResult ?? { state: null, result: null };
    },
  };
  const coordinatorModule = {
    MESSAGE_CHANNEL: "tiktok-live-tracker.reconciliation",
    MESSAGE_VERSION: 1,
    COMMAND_TYPES: {
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

      if (options.streamDispatchError === "known") {
        throw new FakeStreamStorageError(
          "STORAGE_WRITE_FAILED",
          "Could not save stream.",
        );
      }

      if (options.streamDispatchError === "unexpected") {
        throw new Error("sensitive stream failure details");
      }

      return options.streamDispatchResult ?? {
        state: { version: 1, activeSession: null },
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
  const sandbox = {
    importScripts(...relativePaths) {
      imports.push(...relativePaths);
    },
    TikTokLiveTrackerReconciliation: reconciliation,
    TikTokLiveTrackerReconciliationStorage: storageModule,
    TikTokLiveTrackerReconciliationCoordinator: coordinatorModule,
    TikTokLiveTrackerStreamSession: streamSession,
    TikTokLiveTrackerStreamSessionStorage: streamStorageModule,
    TikTokLiveTrackerStreamSessionCoordinator: streamCoordinatorModule,
    crypto: {
      randomUUID() {
        return "11111111-1111-4111-8111-111111111111";
      },
    },
    chrome: {
      storage: { local: storageArea },
      runtime: {
        id: extensionId,
        getURL(relativePath) {
          return `chrome-extension://${extensionId}/${relativePath}`;
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
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
    coordinator,
    coordinatorModule,
    createStreamMessage,
    createMessage,
    createSender,
    dispatchCalls,
    streamDispatchCalls,
    extensionId,
    getCoordinatorOptions: () => coordinatorOptions,
    getPanelBehavior: () => requestedPanelBehavior,
    getStorageAccess: () => requestedStorageAccess,
    getStoreOptions: () => storeOptions,
    getStreamCoordinatorOptions: () => streamCoordinatorOptions,
    getStreamStoreOptions: () => streamStoreOptions,
    imports,
    listeners,
    reconciliation,
    send,
    sidePanelUrl,
    stateStore,
    streamCoordinator,
    streamCoordinatorModule,
    streamSession,
    streamStateStore,
    storageArea,
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
  assert.deepEqual(harness.streamDispatchCalls, [command]);
  assert.deepEqual(harness.dispatchCalls, []);
});

test("rejects stream-session commands from the dashboard content script", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createStreamMessage({
      type: harness.streamCoordinatorModule.COMMAND_TYPES.START_STREAM,
    }),
    harness.createSender({
      url: "https://shop.tiktok.com/streamer/live/event/dashboard",
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
  const harness = createWorkerHarness({ streamDispatchError: "known" });
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
      url: "https://shop.tiktok.com/streamer/live/event/dashboard",
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

test("keeps captured payment commands disconnected from the side panel", async () => {
  const harness = createWorkerHarness();
  const request = harness.send(
    harness.createMessage({
      type: harness.coordinatorModule.COMMAND_TYPES.RECORD_PAYMENT_COMPLETE,
      streamId: "stream-1",
      variationNumber: 1,
      soldPriceCents: 4800,
    }),
  );

  assert.deepEqual(await request.response, {
    ok: false,
    error: {
      code: "UNAUTHORIZED_MESSAGE_SENDER",
      message: "Captured TikTok payment events are not connected yet.",
    },
  });
  assert.equal(harness.dispatchCalls.length, 0);
});

test("forwards an employee unmap command without changing it", async () => {
  const harness = createWorkerHarness();
  const command = {
    type: harness.coordinatorModule.COMMAND_TYPES.UNMAP_VARIATION,
    streamId: "stream-1",
    variationNumber: 203,
  };
  const request = harness.send(harness.createMessage(command));

  assert.deepEqual(await request.response, {
    ok: true,
    data: { state: null, result: null },
  });
  assert.deepEqual(harness.dispatchCalls, [command]);
});

test("serializes known failures without exposing Error internals", async () => {
  const harness = createWorkerHarness({ dispatchError: "known" });
  const request = harness.send(
    harness.createMessage({ type: "map_variation" }),
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
  const harness = createWorkerHarness({ dispatchError: "unexpected" });
  const request = harness.send(
    harness.createMessage({ type: "map_variation" }),
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
