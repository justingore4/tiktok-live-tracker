# Capture development notes

These notes describe the live-validated TikTok LIVE Sold Items boundary, the current
page-to-worker capture pipeline, and the checks that remain for prompt 3.

## Confirmed live dashboard details

Live inspection on August 8, 2026 confirmed:

- Origin: `https://shop.tiktok.com`
- Path: `/streamer/live/product/dashboard`
- The only capture source is the left-side **LIVE auctions → Sold items** history.
- A selected row contained an exact `span` label such as `Variation: #37`.
- The nearest useful stable boundary was `[data-tid="m4b_space"]`.
- The inspected page had exactly one visible `m4b_space` root, 47 exact variation labels,
  and 48 generic `[data-tid="m4b_tag"]` elements.
- A completed row uses an `m4b_tag` whose own normalized text is exactly
  `Payment complete` and contains a final dollar price.

The unequal variation/tag counts matter: capture cannot treat every `m4b_tag` as a
completed payment. It requires the tag's own exact green-badge text and a row that the
shared parser resolves to one variation number and one price.

Generated CSS classes are not selectors. The center video/current-auction card,
right-side Chat, and analytics are not capture sources. Sold Items rows can contain
incidental buyer names, avatars, and product text, but those values are never selected
as fields, logged raw, transmitted, or persisted.

TikTok's yellow payment-warning state remains unverified. No dashboard area outside
Sold Items is a planned capture source.

## Current capture pipeline

The content script is available only on the exact TikTok Shop host and stays dormant
outside `/streamer/live/product/dashboard`. On that route it:

1. requires exactly one visible `[data-tid="m4b_space"]` Sold Items root;
2. fails closed and retries when zero, multiple, or unsafe roots are found;
3. scans only that root for `span` text matching the complete normalized pattern
   `Variation: #N`;
4. scans only that root for exact `[data-tid="m4b_tag"]` elements whose own normalized
   text is `Payment complete`, ignoring case;
5. climbs at most 12 ancestors without crossing the root and accepts a completion only
   when the shared parser finds one variation number and one final US-dollar price;
6. immediately backfills rendered variations, then observes only that root for text and
   child-node changes;
7. coalesces mutation bursts with a 150 ms quiet delay and a non-resetting 1-second
   maximum wait; and
8. uses route, page-resume, body, and root-identity checks to stop or rebind after TikTok
   SPA navigation and root replacement.

The lifecycle check can locate the root from the page, but no sale labels, prices, or
payment badges are parsed outside the unique root. There is no fallback body scan.

### Runtime message boundary

The page sends one of two strict event shapes:

```text
{ type: "observe_variations", variationNumbers: [37, 38, ...] }
{ type: "payment_complete", variationNumber: 37, soldPriceCents: 700 }
```

It sends no `streamId`, buyer identity, product title, observation timestamp, source HTML,
or other DOM content. The content script also cannot access canonical extension storage.

The service worker accepts capture messages only from the extension content script in
the top frame of the exact product-dashboard URL. It resolves the currently active
`local-stream:<uuid>` itself and persists:

- every observed variation as an unmapped auction with unknown payment state; and
- every exact green completion as an authoritative final price for that same auction.

An observation alone does not change inventory or profit. A completed payment contributes
to completed GMV, but inventory and gross profit commit only after the employee maps the
variation to an inventory item. Repeated observations and identical payments are no-ops.
A conflicting later price retains the first price and creates a reconciliation conflict.

The content client marks an event delivered only after the worker acknowledges it. A
failed observation or payment is requeued with a delay that backs off from one to five
seconds while the same Sold Items root stays active. Root replacement triggers a fresh
backfill, and persisted reconciliation state makes that repeat safe.

If no local tracker stream is active, or saved session/state cannot be verified, no
canonical write occurs. The current root's facts remain queued for retry.

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

## Load and test during a real stream

1. Open `chrome://extensions`, enable **Developer mode**, and load or reload this
   repository's `extension` directory.
2. Refresh any TikTok dashboard tab that was already open so it receives the current
   content scripts.
3. Open the extension side panel, choose **Live session**, and Start or Resume one local
   tracker stream. This does not start or control TikTok LIVE.
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
8. When a noted row receives the exact green `Payment complete` badge, select that row in
   the menu and confirm the open panel shows its final price and **Payment complete - item
   needed** state. Then reopen and Resume once to verify the same number, price, and state
   remain durable. Item tagging and Google Sheets can be tested in later development.

The live refetch intentionally does not declare the newest saved variation to be
TikTok's current auction or automatically move an employee away from the order being
reviewed. A prioritized employee queue based only on persisted Sold Items rows remains
future work.

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
Until prompt 3 finds such an ID, follow these rules:

- Use one local tracker stream for one real TikTok LIVE.
- A full dashboard refresh during that same LIVE is safe: visible rows are backfilled and
  canonical duplicates are ignored.
- Keep the local tracker stream active until expected green payment transitions have
  appeared and capture delivery has had time to finish or retry. There is no visible
  queue-drained indicator yet. If a tracker delivery error appears, leave the session
  active through at least the capped retry interval and verify that the open panel
  receives the expected record before using End.
- Ending a local tracker stream does not delete captured history and does not end TikTok
  LIVE, but ended streams cannot yet be reopened in the tagger.
- Before the next TikTok LIVE, reload the dashboard, confirm Sold Items belongs to the
  new stream rather than displaying stale prior rows, and only then Start a new local
  tracker stream.

Starting a new local tracker stream while the old stream's Sold Items DOM is still
rendered can backfill those old rows under the new ID. Automatic prevention requires a
verified TikTok identity and belongs to prompt 3.

## SPA lifecycle manual check

1. Start on the dashboard and confirm the capture-active Console message.
2. Use TikTok's own navigation to leave the dashboard, then return without refreshing.
3. Confirm the active message appears again only after the unique Sold Items root is
   available.
4. Put the tab in the background, return to it, and confirm a later Sold Items variation
   or green transition appears in the still-open side panel.
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
```

These tests use fixtures and in-memory storage. They do not require TikTok, Google
Sheets, or a live stream.

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

## Prompt 3 live-validation checklist

Prompt 3 should validate and implement:

- a prioritized employee work queue driven only by the now-live-refreshed, persisted Sold
  Items variations;
- visible capture connection, retry, and queue-drained state;
- the exact text, DOM, and business meaning of TikTok's yellow payment-warning and final
  failed-payment states;
- a stable TikTok-provided stream/session identifier across SPA navigation and full
  refresh that differs across two LIVE sessions;
- automatic protection against assigning stale rendered rows to a new local stream;
- whether `m4b_space` stays unique across accounts, modes, streams, scrolling, and TikTok
  releases;
- whether Sold Items is virtualized or replaced as it grows and whether every row can be
  recovered for an end-of-stream pass; and
- real-stream validation of root replacement, tab suspension, refresh, and a second LIVE.

Google Sheets integration is a later stage and is not part of this capture prompt.

## Current limitations

- Parsing assumes English dashboard text and US-dollar formatting.
- Only exact Sold Items variation labels and exact green completed payments are
  authoritative. Capture does not infer a failure from missing or non-green tags.
- The `m4b_space` selector has been observed on one real stream and still needs broader
  validation.
- The local stream ID is tracker-owned, not TikTok-verified.
- The open tagger refetches on durable capture invalidations but does not automatically
  treat the newest captured variation as TikTok's current auction.
- There is no visible capture connection, retry, or queue-drained indicator yet.
- Browser or process suspension can delay scans and delivery retries.
- Capture stores no buyer identity and contacts neither TikTok APIs nor Google Sheets.
