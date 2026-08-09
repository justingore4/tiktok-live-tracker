# Capture development notes

These notes describe the live-validated TikTok LIVE Sold Items boundary, the current
page-to-worker capture pipeline, and the checks that remain for broader live validation.

## Confirmed live dashboard details

Live inspection on August 8, 2026 confirmed:

- Origin: `https://shop.tiktok.com`
- Path: `/streamer/live/product/dashboard`
- The only capture source is the left-side **LIVE auctions → Sold items** history.
- A selected row contained an exact `span` label such as `Variation: #37`.
- The nearest useful stable boundary was `[data-tid="m4b_space"]`.
- The inspected page had exactly one visible `m4b_space` root, 47 exact variation labels,
  and 48 generic `[data-tid="m4b_tag"]` elements.
- A payment badge is an exact `[data-tid="m4b_tag"]`; the inspected completed row used
  the whole normalized text `Payment complete` and contained a final dollar price.
- During TikTok's correction buffer, the exact `m4b_tag` text is `Payment failed` and
  capture stores the sanitized `payment_failed` status. If the correction window expires,
  the exact badge changes to `Canceled` and capture stores the distinct `canceled` status.
  A fixed payment can instead settle as `Payment complete`.
- The capture allowlist also recognizes the requested whole-label values
  `Payment processing` and `Payment fixing`. Their exact spelling and
  transition order still need confirmation during live use.

The unequal variation/tag counts matter: capture cannot treat every `m4b_tag` as an
auction payment. It associates a tag with exactly one row-local variation label. Unknown
nonempty tag text is reduced to `unrecognized`; raw tag text is never transmitted or
saved. A canonical completion additionally requires the shared parser to resolve that
same variation and one price.

Generated CSS classes are not selectors. The center video/current-auction card,
right-side Chat, and analytics are not capture sources. Sold Items rows can contain
incidental buyer names, avatars, and product text, but those values are never selected
as fields, logged raw, transmitted, or persisted.

`Payment processing`, `Payment fixing`, `Payment failed`, and unrecognized labels remain
nonterminal observations. Only exact `Payment processing` and `Payment fixing` create a
pending inventory reservation for a mapped item. Failed, unrecognized, not-yet-observed,
and price-less completion observations keep the item selection without showing or
consuming a pending reservation. Exact `Canceled` is a canonical terminal allocation
result that keeps any item link for history and counts no sale, revenue, cost, or profit.
No dashboard area outside Sold Items is a planned source.

## Current capture pipeline

The content script is available only on the exact TikTok Shop host and stays dormant
outside `/streamer/live/product/dashboard`. On that route it:

1. requires exactly one visible `[data-tid="m4b_space"]` Sold Items root;
2. fails closed and retries when zero, multiple, or unsafe roots are found;
3. scans only that root for `span` text matching the complete normalized pattern
   `Variation: #N`;
4. scans only that root for exact `[data-tid="m4b_tag"]` elements, associates each with
   one exact row-local variation label, and converts its whole normalized text to an
   allowlisted status code or `unrecognized`;
5. climbs at most 12 ancestors without crossing the root; a completion becomes canonical
   only when the shared parser finds the same variation and one final US-dollar price;
6. immediately backfills rendered variations, then observes only that root for text and
   child-node changes;
7. coalesces mutation bursts with a 150 ms quiet delay and a non-resetting 1-second
   maximum wait; and
8. uses route, page-resume, body, and root-identity checks to stop or rebind after TikTok
   SPA navigation and root replacement.

The lifecycle check can locate the root from the page, but no sale labels, prices, or
payment badges are parsed outside the unique root. There is no fallback body scan.

### Runtime message boundary

The page sends one of three strict event shapes:

```text
{ type: "observe_variations", variationNumbers: [37, 38, ...] }
{ type: "observe_payment_statuses", statuses: [
    { variationNumber: 37, observedPaymentStatus: "payment_fixing" }, ...
] }
{ type: "payment_complete", variationNumber: 37, soldPriceCents: 700 }
```

It sends no `streamId`, raw payment text, buyer identity, product title, observation
timestamp, source HTML, or other DOM content. The content script also cannot access
canonical extension storage.

The service worker accepts capture messages only from the extension content script in
the top frame of the exact product-dashboard URL. It resolves the currently active
`local-stream:<uuid>` itself and persists:

- every observed variation as an unmapped auction;
- the latest sanitized observed payment status for each variation;
- exact `Canceled` as canonical cancellation for inventory allocation; and
- every exact green completion with a parsed price as authoritative payment truth.

Observed processing, fixing, failed, or unrecognized status does not decrement remaining
inventory or change profit. Processing and fixing reserve a mapped unit; failed and
unrecognized observations keep the item selected without a pending reservation. Exact
cancellation preserves the item link and history without decrementing remaining stock or
contributing sales, revenue, cost, or profit. A completed payment contributes to completed
GMV, but inventory and gross profit commit only after the employee maps the variation to
an inventory item. A complete badge whose price is temporarily unavailable remains a
provisional displayed observation without a pending reservation; later status changes are
still accepted until a priced completion is durably saved. A later priced completion
overrides cancellation, commits a mapped sale, and creates a
`payment_completed_after_canceled` warning that TikTok's completion won and inventory was
counted. Repeated observations are no-ops. A conflicting later completed price retains the
first price and creates a reconciliation conflict.

These captured facts hydrate into reconciliation state version 4. Each stream record has
an immutable inventory-baseline pin, and capture verifies or repairs the active stream's
pin before applying a variation or payment fact. Strict version-1 through version-3
snapshots migrate to one deterministic legacy baseline and pin every legacy stream to
it, while the outer browser-storage envelope remains schema version 1. Malformed or
dangling baseline, SKU, cost, and stream relationships fail closed.

The content client marks an event delivered only after the worker acknowledges it. A
failed observation or payment is requeued with a delay that backs off from one to five
seconds while the same Sold Items root stays active. Root replacement triggers a fresh
backfill, and persisted reconciliation state makes that repeat safe.

If no local tracker stream is active, no nonempty active inventory baseline exists, or
saved session/state/pin cannot be verified, no canonical write occurs. The current
root's facts remain queued for retry.

After the worker accepts a capture fact through the durable reconciliation boundary, it
sends the open side panel a data-free `capture_state_changed` invalidation. The panel
validates the exact extension-worker message, coalesces bursts, and refetches canonical
state through its read client. The notice contains no stream ID, variation, price, buyer
information, DOM content, or snapshot. A notification delivery failure does not undo or
misreport the already-successful capture write.

The existing capture-event registry still deduplicates sanitized page-scoped Console
diagnostics. Those logs contain variation, payment status, price, the fixed page path,
source label, and local observation time; they contain no buyer or DOM content and do
not choose canonical identity. Only the worker binds capture facts to the active local
tracker stream.

## Configure and manually test Google Sheets inventory

The live tracker now requires one confirmed Google Sheets inventory baseline before a
new Start. The checked-in manifest intentionally contains
`REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`; a real Sheet request
fails closed until that public placeholder is replaced.

1. Load `extension` from `chrome://extensions` and copy its exact extension ID.
2. In a Google Cloud project, enable the Google Sheets API, configure the OAuth consent
   screen, and add the testing Google account as a test user when the app is in Testing.
3. Create an OAuth client of type **Chrome Extension** for that exact ID. Replace the
   placeholder under `oauth2.client_id` in `extension/manifest.json`, then reload the
   extension. No client secret, service-account key, `.env` value, or access token is
   required in the repository.
4. Import [`google-sheets-inventory-template.csv`](google-sheets-inventory-template.csv)
   into a Google spreadsheet, rename the tab exactly `Inventory`, preserve the six exact
   headers, and replace the dummy rows with the physical opening count and unit cost.
   Give the authorizing Google account read access.
5. With no local tracker stream active, open **Live session**, paste the Sheet ID or its
   HTTPS `docs.google.com` sharing link, and select **Connect and preview**. The manifest
   grants `identity`, the exact `https://sheets.googleapis.com/*` host, and only
   `https://www.googleapis.com/auth/spreadsheets.readonly`. That Google scope can read
   spreadsheets available to the connected account, but the importer requests only the
   selected ID and fixed whole-sheet `'Inventory'` range.
6. Verify the full normalized table, row count, opening-unit total, and opening-cost
   total. Select **Confirm inventory baseline**. Confirmation re-reads the Sheet before
   atomically saving a new immutable local baseline; Start becomes available only after
   that succeeds. The importer accepts at most 1,000 inventory rows beyond the header;
   an oversized Sheet is rejected without a partial preview or import.

Run these fail-closed checks before relying on the importer:

- Delete or rename a required header, duplicate a SKU, enter a formula, or use an invalid
  quantity. Preview must show bounded row/column diagnostics, import nothing, and leave
  Start unavailable when there was no earlier confirmed baseline.
- Create a valid preview, then change any cell before confirmation. Confirmation must
  report a stale preview, create no baseline, and require another preview.
- Create a preview, reload the extension worker or wait more than ten minutes, then try
  to confirm. The opaque preview nonce is memory-only, so a fresh preview is required.
- Revoke authorization or let it expire between preview and confirmation. Confirmation
  must not open an interactive prompt or import cached rows; reconnect and preview again.
- Begin preview/confirmation and Start close together. The worker FIFO must either finish
  confirmation before Start, start only from an already confirmed earlier baseline, or
  reject Start when no imported baseline exists. Any Start invalidates the pending
  preview, so it cannot be confirmed after a complete Start/End cycle. A partial preview
  must never become a stream baseline.
- After confirmation, close and reopen the panel. Import status must restore the locally
  saved baseline summary. Start a stream, then confirm the import controls are hidden and
  worker import commands are rejected until End.
- Inspect the side-panel and service-worker Console. Sheet rows, sharing links, Google
  access tokens, API error bodies, and credentials must not be logged. Only normalized
  confirmed inventory and its non-secret fingerprint are persisted locally.

After Start, inventory, reservations, payment reconciliation, and basic profit use the
local pinned baseline. The extension makes no live Google request and implements no
Google Sheets result export. A new physical recount is another pre-stream import after
End; it cannot alter the baseline pinned to an active or historical stream.

For distribution, the OAuth client must use the final Chrome Web Store item ID rather
than a temporary unpacked ID. The Store listing also needs accurate privacy disclosures
and a privacy policy. The read-only Sheets scope is sensitive, so Google may require OAuth
verification and Limited Use evidence before broad production access. A local consent
screen test-user run does not complete those release reviews.

## Load and test during a real stream

1. Open `chrome://extensions`, enable **Developer mode**, and load or reload this
   repository's `extension` directory.
2. Refresh any TikTok dashboard tab that was already open so it receives the current
   content scripts.
3. Complete the inventory-import checks above, then choose **Live session** and Start a
   local tracker stream from the confirmed baseline, or Resume the already-active stream.
   This does not start or control TikTok LIVE.
4. Open `https://shop.tiktok.com/streamer/live/product/dashboard` and select TikTok's
   left-side **Sold items** view.
5. Open DevTools → **Console** and confirm:

   ```text
   [TikTok Live Tracker] Capture probe active on /streamer/live/product/dashboard.
   ```

6. Keep the active Live session side panel open. Note several variation numbers visible
   in Sold Items and confirm those exact numbers appear in the variation selector after
   the capture scan and refetch settle. Do not refresh TikTok or reopen the panel.
7. Select one recorded variation, then wait for a newer Sold Items variation. Confirm the
   new number appears in the selector and becomes the displayed variation automatically.
   A later payment/status update to an existing row should not change the selection.
8. Keep a variation selected while its badge changes. Confirm the visible **TikTok
   payment** value changes live among **Payment processing**, **Payment fixing**,
   **Payment failed**, **Canceled**, and **Payment complete** without a page refresh or menu
   click. The selector must stay on that variation for status-only changes.
9. For `Payment complete`, confirm its final price is visible even before an inventory
   item is selected. Reopen and Resume once to verify the same number, status, and price
   remain durable.
10. On a mapped processing or fixing row, confirm its card keeps the full remaining
    quantity visible and reports the pending reservation separately. It must not count a
    sale or reduce remaining stock. When that same row changes to failed or unrecognized,
    confirm the item stays selected but the pending count disappears.
11. When that row becomes exact `Canceled`, confirm the item link remains visible, its
    reservation is released, and remaining stock, sale count, revenue, cost, and profit do
    not change. A canceled variation must not require resolution before End.
12. If a priced `Payment complete` later replaces `Canceled`, confirm TikTok's completion
    wins, the mapped unit moves from remaining to sold, revenue and gross profit commit,
    and a visible warning says inventory was counted.
13. Correct a historical completed variation to another SKU and confirm the old SKU is
    restored, the new SKU is decremented, and cost and gross profit recalculate together.
    Repeat these checks across later tracker streams and imported baselines.

The live refetch does not claim the newest saved variation is TikTok's current bidding
auction. It does automatically display a newly persisted higher variation for faster
tracking; status-only changes do not move the selection. A richer prioritized queue
based only on persisted Sold Items rows remains future work.

### Read-only root diagnostic

If the active message is missing or capture is not restoring variations, run this
read-only diagnostic in the dashboard Console:

```js
[...document.querySelectorAll('[data-tid="m4b_space"]')].map(
  (root, index) => ({
    index,
    variationCount: [...root.querySelectorAll("span")].filter((element) =>
      /^Variation\s*:\s*#\s*\d+$/i.test(element.textContent.trim()),
    ).length,
    paymentTagCount: root.querySelectorAll('[data-tid="m4b_tag"]').length,
    visible:
      root.getBoundingClientRect().width > 0 &&
      root.getBoundingClientRect().height > 0,
  }),
);
```

Expected: exactly one object has `visible: true`, and its variation count agrees with
the rendered Sold Items list. `paymentTagCount` may be larger; it is not a completion
count.

Do not paste scripts that modify the dashboard DOM during a real sale. Offline automated
tests provide synthetic DOM coverage.

## Local stream and page boundary

The worker-generated local stream ID is durable but is not a verified TikTok room ID.
Until a later identity stage finds such an ID, follow these rules:

- Use one local tracker stream for one real TikTok LIVE.
- Start preflights reconciliation state and requires a nonempty active baseline created
  by confirmed Google Sheets import. It never promotes offline-demo inventory. The worker
  permanently pins the new stream to that imported baseline. Only an already-active
  legacy session with truly absent reconciliation state may use the narrow mock-repair
  Retry path; that compatibility path cannot start a new session or replace saved state.
- Do not try to recount or activate another inventory baseline during a tracker stream.
  The worker rejects baseline creation while a session is active. End the session only
  after its capture and employee work is safely resolved; a later recount belongs to a
  new baseline and a future stream.
- A full dashboard refresh during that same LIVE is safe: visible rows are backfilled and
  canonical duplicates are ignored.
- There is no visible queue-drained indicator yet. When practical, keep the local tracker
  stream active until expected payment transitions appear and capture delivery has had
  time to finish or retry. If a tracker delivery error appears, leaving the session active
  through at least the capped retry interval helps preserve the late record, but this is
  operational guidance rather than an End prerequisite.
- End is always available for a known active local stream. Processing/fixing reservations,
  completed sales without items, and every other reconciliation state remain visible but
  do not block the confirmation. The employee can also End without first resuming the
  inventory workspace.
- Ending a local tracker stream does not delete captured history and does not end TikTok
  LIVE. It stops new capture for that local stream. Ended streams cannot yet be reopened
  in the tagger, so employees should make any corrections they still need before End when
  practical even though the UI does not enforce that workflow.
- Before the next TikTok LIVE, reload the dashboard, confirm Sold Items belongs to the
  new stream rather than displaying stale prior rows, and only then Start a new local
  tracker stream.

Starting a new local tracker stream while the old stream's Sold Items DOM is still
rendered can backfill those old rows under the new ID. Automatic prevention requires a
verified TikTok identity and belongs to a later stage.

## SPA lifecycle manual check

1. Start on the dashboard and confirm the capture-active Console message.
2. Use TikTok's own navigation to leave the dashboard, then return without refreshing.
3. Confirm the active message appears again only after the unique Sold Items root is
   available.
4. Put the tab in the background, return to it, and confirm a later Sold Items variation
   or payment-status transition appears in the still-open side panel.
5. If TikTok replaces the Sold Items root, confirm capture rebinds and the backfill does
   not duplicate inventory or GMV.

These checks exercise lifecycle recovery. They do not prove TikTok stream identity.

## Run the offline tests

Run every project test from the repository root:

```powershell
npm.cmd test
```

Run capture integration areas individually:

```powershell
node --test .\tests\sale-parser.test.cjs
node --test .\tests\sale-candidate-locator.test.cjs
node --test .\tests\capture-content.test.cjs
node --test .\tests\capture-protocol.test.cjs
node --test .\tests\capture-client.test.cjs
node --test .\tests\capture-integration.test.cjs
node --test .\tests\service-worker.test.cjs
node --test .\tests\active-stream-integration.test.cjs
node --test .\tests\inventory-baseline-integration.test.cjs
node --test .\tests\inventory-import-protocol.test.cjs
node --test .\tests\google-sheets-inventory-import.test.cjs
node --test .\tests\inventory-import-client.test.cjs
node --test .\tests\inventory-import-controller.test.cjs
```

These tests use fixtures and in-memory storage. They do not require TikTok, Google
Sheets network access, an OAuth client, or a live stream.

## Console troubleshooting

- If the active message is missing, confirm the origin and pathname, reload the unpacked
  extension, then refresh the dashboard tab once.
- If the root diagnostic returns zero visible matches, open TikTok's left Sold Items view
  and wait for it to render. Capture will retry.
- If it returns multiple visible matches, record the DOM state for diagnosis. Capture
  intentionally fails closed instead of guessing.
- `NO_ACTIVE_STREAM` means Start or Resume the extension's local tracker stream. Queued
  facts retry while the same root remains active.
- Missing/ambiguous Sold Items roots and the retryable `NO_ACTIVE_STREAM`,
  `STATE_NOT_INITIALIZED`, and transport states are reported as readable Console info,
  not Chrome extension errors. Chrome may retain older warning/error entries until
  **Clear all** is selected after reloading the extension.
- TikTok may log unrelated `404`, `ERR_BLOCKED_BY_CLIENT`, CSP, or cross-origin errors.
  Tracker errors begin with `[TikTok Live Tracker]`.
- The capture script makes no TikTok network request and never clicks or edits TikTok
  controls.

## Next live-validation checklist

The next capture stage should validate and implement:

- a prioritized employee work queue driven only by the now-live-refreshed, persisted Sold
  Items variations;
- visible capture connection, retry, and queue-drained state;
- the transition timing and color-independent meaning of processing, fixing, failed,
  unrecognized, and other additional payment labels; the current inventory rule reserves
  only processing/fixing, while exact `Canceled` already has canonical allocation
  semantics;
- a stable TikTok-provided stream/session identifier across SPA navigation and full
  refresh that differs across two LIVE sessions;
- automatic protection against assigning stale rendered rows to a new local stream;
- whether `m4b_space` stays unique across accounts, modes, streams, scrolling, and TikTok
  releases;
- whether Sold Items is virtualized or replaced as it grows and whether every row can be
  recovered for an end-of-stream pass; and
- real-stream validation of root replacement, tab suspension, refresh, and a second LIVE.

Google Sheets OAuth, fixed-range reading, detached preview, explicit confirmation,
immutable baseline creation, and stream pinning are now implemented before Start. This
inventory-only boundary does not expand capture authority: the content script still must
not read Sheet data, buyer identity, inventory mappings, or credentials, and it cannot
contact Google. Only the worker performs the selected pre-stream read. Outbound Sheets
export and any live Google dependency remain intentionally absent.

## Current limitations

- Parsing assumes English dashboard text and US-dollar formatting.
- Exact Sold Items variation labels and sanitized payment statuses are persisted. Only a
  priced `Payment complete` can commit a sale, inventory decrement, revenue, and profit.
  Exact `Canceled` is authoritative without counting a sale. Processing and fixing are
  the only observations that create pending reservations; failed and unrecognized remain
  mapped, nonterminal, and unreserved.
- The `m4b_space` selector has been observed on one real stream and still needs broader
  validation.
- The local stream ID is tracker-owned, not TikTok-verified.
- The open tagger auto-displays a newly captured higher variation but does not claim that
  it is TikTok's current bidding auction.
- There is no visible capture connection, retry, or queue-drained indicator yet.
- Browser or process suspension can delay scans and delivery retries.
- Capture stores no buyer identity and contacts neither TikTok APIs nor Google Sheets.
  The separate worker-owned importer contacts the Sheets API only before a stream is
  started or after it has ended.
