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
observed payment-tag attribute, requires that badge's own normalized text to equal
`Payment complete`, and climbs to the smallest candidate row without crossing its active
capture boundary. It accepts the row only when the shared parser finds exactly one
variation and one sold price.

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
5. filters text and child-node mutation batches for changes that can affect the confirmed
   payment tag or its row, then sends only relevant work to the bounded scheduler;
6. accepts only the exact `[data-tid="m4b_tag"]` attribute with badge text that normalizes
   to `Payment complete`, ignoring case;
7. searches at most 12 ancestors, never parsing, accepting, or crossing the dashboard
   body boundary;
8. validates and returns the smallest candidate row with the pure shared parser;
9. logs a normalized event with `streamId: null` only when variation number, final price,
   and payment-complete status are present;
10. ignores an identical event already seen in the unverified page scope, including a
    route exit and re-entry in that document; and
11. warns instead of replacing the first price if the same variation later appears with
    a different completed price.

The scheduler waits 150 ms for a quiet moment so a short burst produces one scan. A
non-resetting 1-second maximum wait also forces a scan while chat, viewer counts, or other
dashboard elements keep changing continuously. Either timer closes the same batch, so it
cannot double-scan. The initial scan still runs immediately after observation begins.

`capture/sale-candidate-locator.js` contains the DOM targeting and mutation relevance
rules. It uses `textContent`, the one inspected `data-tid`, exact badge text, parser
invariants, and a hard ancestor boundary rather than generated CSS classes, panel heading
text, or positional selectors. Added subtrees and character changes related to a payment
tag or its row are relevant, including removals that can make previously ambiguous text
valid. Unrelated, lookalike, outside-boundary, and detached changes are ignored. If
mutation inspection is malformed or throws, the filter requests a scan so an
optimization cannot silently disable capture.

`capture/capture-event-registry.js` provides separate page and verified-stream scopes.
The verified-stream behavior is covered offline, including identical variation numbers in
different streams, but the registry does not discover or invent an ID. The live runtime
uses an unverified page scope, warns once about that limitation, and emits
`streamIdentityStatus: "unverified"` with `dedupeScope: "page_load"`.

The side panel now has a separate persistent local tracker session with a worker-generated
`local-stream:<uuid>` ID. That ID survives panel and browser restarts and safely separates
employee mappings between tracker sessions, but the content script cannot read or use it
yet. It must not be described as a verified TikTok stream ID. Connecting read-only
capture events to that active local session is the next integration prompt.

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
5. Open the side panel, choose **Live session**, and Start or Resume the local tracker
   stream. These controls do not start TikTok LIVE.
6. Open the TikTok LIVE dashboard.
7. Refresh the dashboard if it was already open.
8. Open DevTools → **Console** and look for:

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
node --test .\tests\sale-candidate-locator.test.cjs
node --test .\tests\capture-event-registry.test.cjs
node --test .\tests\capture-scheduler.test.cjs
node --test .\tests\capture-content.test.cjs
node --test .\tests\reconciliation.test.cjs
node --test .\tests\stream-session.test.cjs
node --test .\tests\stream-session-storage.test.cjs
node --test .\tests\stream-session-coordinator.test.cjs
node --test .\tests\stream-session-client.test.cjs
node --test .\tests\stream-session-controller.test.cjs
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

These checks verify lifecycle recovery, not stream identity. The tested registry can use
a verified stream scope, but the runtime remains page-scoped until a TikTok ID is
validated during a live stream.

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

The first accepted sale in a page load also produces one tracker warning that TikTok
stream identity is unverified. That warning is expected in the current probe.

Expected tracker output:

```text
[TikTok Live Tracker] Completed sale detected
```

The logged object should contain:

```text
variationNumber: 999999
soldPriceCents: 4800
paymentStatus: "payment_complete"
streamId: null
streamIdentityStatus: "unverified"
dedupeScope: "page_load"
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

## Blocking live-stream validation checklist

The next real stream must verify the following before canonical stream identity or Sold
items root narrowing is implemented:

- the DOM structure and stable selector for the current variation while bidding;
- the exact text and structure of the yellow payment-warning state;
- whether yellow-to-green produces observable text or child-node mutations;
- a unique, stable Sold items container using a non-generated attribute or ARIA
  relationship rather than generated classes or element position;
- that the candidate container excludes the right-side Chat panel, current-auction card,
  and analytics, and survives new rows, scrolling, and SPA re-entry;
- whether rows are virtualized, replaced, or placed in an iframe/shadow root;
- a TikTok-provided stream/session identifier that stays stable across route re-entry and
  full refresh, but differs across two real streams;
- real-stream validation of route exit/re-entry, page resume, and any body replacement;
- stream identity and deduplication behavior across dashboard refresh and a second stream;
- whether auctions with no bids appear in a trackable location; and
- whether every completed row remains recoverable for an end-of-stream pass.

## Current limitations

- Parsing currently assumes English dashboard text and US-dollar formatting.
- The capture event contains variation, price in cents, payment status, source, page,
  observation time, `streamId: null`, and explicit unverified page-scope metadata; it
  intentionally omits buyer information.
- Verified-stream registry behavior is tested, but no TikTok stream ID has been observed
  or validated. Runtime deduplication remains in memory for one page load and is not safe
  across multiple streams by itself.
- A durable local tracker stream now exists, but capture remains console-only and is not
  authorized to attach events to it until the next integration stage.
- The confirmed payment-tag candidate rules are implemented, but the page-wide dashboard
  body remains a provisional boundary until the live checklist proves a narrower root.
- Mutation relevance currently covers added nodes and character-data changes. The actual
  yellow-to-green transition and any relevant attribute-only change still require live
  validation.
- The bounded scheduler prevents ordinary mutation traffic from starving capture, but
  browsers may still delay timers when a tab or process is suspended.
