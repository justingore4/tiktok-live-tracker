# Capture development notes

These notes describe what has been verified on the TikTok LIVE dashboard, what the
current read-only probe does, and what must be checked during the next real stream.

## Confirmed dashboard details

- Origin: `https://shop.tiktok.com`
- Path: `/streamer/live/event/dashboard`
- An inspected completed row exposed these values as DOM text:
  - `Example Buyer has won: $48.00`
  - `Variation: #250`
  - `Payment complete`
- The inspected payment badge had `data-tid="m4b_tag"`.
- The extension startup message has been confirmed on the blank offline dashboard.

Generated CSS class names are not treated as stable selectors. The probe begins with the
observed payment-tag attribute, climbs to the smallest candidate row, and accepts it only
when the shared parser finds exactly one variation and one sold price.

Only the completed green row has been inspected in enough detail to implement capture.
The current-auction and yellow-warning DOM structures remain unknown.

## Current capture probe

The extension content script:

1. is available only on the exact `https://shop.tiktok.com` host but remains inactive
   outside the exact `/streamer/live/event/dashboard` path;
2. checks its route and document body at startup, on route and page-resume signals, and
   with a 250 ms fallback;
3. starts once on the dashboard, attaches its observer, and then performs an initial scan
   of rendered payment-tag candidates;
4. disconnects its observer and disposes its scheduler when the route is left, restarting
   them when the dashboard is re-entered or the document body is replaced;
5. watches text and child-node changes with a bounded, coalesced
   `MutationObserver` scheduler;
6. validates candidate rows with the pure shared parser;
7. logs a normalized event only when variation number, final price, and the exact text
   `Payment complete` are present;
8. ignores an identical event already seen during the current page load, including a
   route exit and re-entry in that document; and
9. warns instead of replacing the first price if the same variation later appears with
   a different completed price.

The scheduler waits 150 ms for a quiet moment so a short burst produces one scan. A
non-resetting 1-second maximum wait also forces a scan while chat, viewer counts, or other
dashboard elements keep changing continuously. Either timer closes the same batch, so it
cannot double-scan. The initial scan still runs immediately after observation begins.

TikTok can change routes with its History API without reloading the page or emitting a
single dependable browser event. Route and resume signals therefore provide immediate
checks when available, while the 250 ms fallback catches silent history changes and body
replacement. Repeated checks are idempotent: one body has at most one active capture
observer and scheduler. This recovery uses ordinary content-script browser APIs and adds
no extension permission.

It remains disconnected outside the dashboard path. It does not modify the TikTok page,
click TikTok controls, decrement inventory, persist sales, connect to the reconciliation
engine, or contact Google Sheets.

## Load the probe in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension` directory.
5. Open the TikTok LIVE dashboard.
6. Refresh the dashboard if it was already open.
7. Open DevTools → **Console** and look for:

   ```text
   [TikTok Live Tracker] Capture probe active on /streamer/live/event/dashboard.
   ```

On a blank offline dashboard, the startup message without a completed-sale event is the
expected result.

After changing extension code, reload the unpacked extension. A tab that was already open
before that extension reload must be refreshed once to receive the new content script.
Afterward, navigating away from and back to the dashboard as an SPA no longer requires a
refresh. Load and verify the extension before the next live stream; refreshing a
historical stream after it has ended may replace the old dashboard contents with a blank
page.

## Run the offline tests

Run every project test from the repository root:

```powershell
npm.cmd test
```

Run one area by itself:

```powershell
node --test .\tests\sale-parser.test.cjs
node --test .\tests\capture-scheduler.test.cjs
node --test .\tests\capture-content.test.cjs
node --test .\tests\reconciliation.test.cjs
```

These tests use fixtures and sample inventory. They do not require TikTok, Google Sheets,
or a live stream.

## SPA lifecycle manual check

1. Start on the dashboard and confirm the capture-active Console message.
2. Use TikTok's own navigation to leave the dashboard, then return without refreshing.
3. Run the optional capture simulation with a new variation and confirm exactly one
   completed-sale event after re-entry.
4. Repeat the navigation cycle and confirm capture restarts without duplicate observers
   or duplicate events. Automated tests also exercise document-body replacement; do not
   force a body replacement during a live sale.
5. Put the dashboard tab in the background, return to it, and confirm a new simulated or
   real completed row is still detected.

These checks verify lifecycle recovery, not stream identity. Variation-only deduplication
still lasts only for the current document and is addressed in the next capture-hardening
stage.

## Optional offline capture simulation

The blank dashboard cannot produce a real completed row, but a temporary local DOM row
can verify that the observer and parser work together.

In the dashboard's DevTools Console, run:

```js
const testRow = document.createElement("div");
testRow.id = "tlt-offline-test-row";
testRow.innerHTML = `
  <p>Test Buyer has won: $48.00</p>
  <span>Variation: #999999</span>
  <span data-tid="m4b_tag">
    <span>Payment complete</span>
  </span>
`;
document.body.append(testRow);
```

Chrome may block pasted Console code as a self-XSS precaution. If prompted, read the
warning and manually type `allow pasting` only when you understand and trust the code.

Expected tracker output:

```text
[TikTok Live Tracker] Completed sale detected
```

The logged object should contain:

```text
variationNumber: 999999
soldPriceCents: 4800
paymentStatus: "payment_complete"
```

Remove the temporary row afterward:

```js
document.getElementById("tlt-offline-test-row")?.remove();
```

This changes only the local rendered page and disappears on refresh. It does not send a
request to TikTok. Because capture deduplication lasts for the page load, use a different
test variation number or refresh before repeating the simulation.

## Console troubleshooting

- TikTok may log its own `404`, `ERR_BLOCKED_BY_CLIENT`, or cross-origin policy errors.
  The current tracker probe makes no network requests, so those errors are not produced
  by its capture code.
- If the tracker startup message is missing, reload the extension and then refresh the
  tab once so the updated content script is installed in that document.
- TikTok may navigate between views as a single-page application (SPA). Capture now stops
  off-route and restarts after dashboard re-entry without a refresh. If it does not,
  record the before/after URLs and tracker Console messages for diagnosis rather than
  relying on refresh as the normal workaround.

## Live-stream validation checklist

The next real stream must verify:

- the DOM structure and stable selector for the current variation while bidding;
- the exact text and structure of the yellow payment-warning state;
- whether yellow-to-green produces observable text or child-node mutations;
- a narrower, stable Sold items container for observation;
- whether rows are virtualized, replaced, or placed in an iframe/shadow root;
- a reliable TikTok stream/session identifier;
- real-stream validation of route exit/re-entry, page resume, and any body replacement;
- stream identity and deduplication behavior across dashboard refresh and a second stream;
- whether auctions with no bids appear in a trackable location; and
- whether every completed row remains recoverable for an end-of-stream pass.

## Current limitations

- Parsing currently assumes English dashboard text and US-dollar formatting.
- The capture event contains variation, price in cents, payment status, source, page, and
  observation time; it intentionally omits buyer information.
- The probe does not emit a stream ID.
- Deduplication is in memory and uses variation number only, so it resets on refresh and
  is not safe across multiple streams by itself.
- The page-wide observer and payment-tag candidate selector are provisional until the
  live checklist is complete.
- The bounded scheduler prevents ordinary mutation traffic from starving capture, but
  browsers may still delay timers when a tab or process is suspended.
