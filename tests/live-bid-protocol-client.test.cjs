const assert = require("node:assert/strict");
const test = require("node:test");

const liveBidProtocol = require("../extension/shared/live-bid-protocol.js");
const liveBidClientModule = require("../extension/tagger/live-bid-client.js");

test("live-bid protocol keeps GET and its invalidation exact and data-free", () => {
  const message = liveBidProtocol.createLiveBidMessage();

  assert.deepEqual(message, {
    channel: "tiktok-live-tracker.live-bid",
    version: 1,
    command: { type: "get_live_bid" },
  });
  assert.deepEqual(liveBidProtocol.validateLiveBidMessage(message), {
    type: "get_live_bid",
  });

  const notification = liveBidProtocol.createLiveBidChangedNotification();
  assert.deepEqual(notification, {
    channel: "tiktok-live-tracker.live-bid",
    version: 1,
    event: { type: "live_bid_changed" },
  });
  assert.equal(
    liveBidProtocol.isLiveBidChangedNotification(notification),
    true,
  );
  assert.equal(
    liveBidProtocol.isLiveBidChangedNotification({
      ...notification,
      bidPriceCents: 2800,
    }),
    false,
  );
});

test("live-bid client returns only the exact retained auction projection", async () => {
  const calls = [];
  const client = liveBidClientModule.createLiveBidClient({
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        return {
          ok: true,
          data: {
            liveAuction: {
              variationNumber: 203,
              bidPriceCents: 2800,
              unitCostCents: 1200,
            },
          },
        };
      },
    },
    protocol: liveBidProtocol,
  });

  assert.deepEqual(await client.getLiveBid(), {
    liveAuction: {
      variationNumber: 203,
      bidPriceCents: 2800,
      unitCostCents: 1200,
    },
  });
  assert.deepEqual(calls, [liveBidProtocol.createLiveBidMessage()]);
});

test("live-bid client fails closed on extra response data", async () => {
  const client = liveBidClientModule.createLiveBidClient({
    runtime: {
      async sendMessage() {
        return {
          ok: true,
          data: {
            liveAuction: {
              variationNumber: 203,
              bidPriceCents: 2800,
              unitCostCents: 1200,
              buyer: "must not cross boundary",
            },
          },
        };
      },
    },
    protocol: liveBidProtocol,
  });

  await assert.rejects(
    () => client.getLiveBid(),
    (error) =>
      error instanceof liveBidClientModule.LiveBidClientError &&
      error.code === "INVALID_RESPONSE",
  );
});

test("live-bid client accepts a strict bidless and unmapped placeholder", async () => {
  const client = liveBidClientModule.createLiveBidClient({
    runtime: {
      async sendMessage() {
        return {
          ok: true,
          data: {
            liveAuction: {
              variationNumber: 204,
              bidPriceCents: null,
              unitCostCents: null,
            },
          },
        };
      },
    },
    protocol: liveBidProtocol,
  });

  assert.deepEqual(await client.getLiveBid(), {
    liveAuction: {
      variationNumber: 204,
      bidPriceCents: null,
      unitCostCents: null,
    },
  });
});
