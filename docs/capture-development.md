# Capture development notes

These notes describe the scoped TikTok LIVE on-video bidding, Sold Items, and Attributed
GMV boundaries, the current page-to-worker capture pipeline, and the checks that remain
for broader live validation.

## Confirmed live dashboard details

Live inspection on August 8, 2026 confirmed:

- Origin: `https://shop.tiktok.com`
- Path: `/streamer/live/product/dashboard`
- The only individual-sale capture source is the left-side **LIVE auctions → Sold items**
  history.
- A selected row contained an exact `span` label such as `Variation: #37`.
- The nearest useful stable boundary was `[data-tid="m4b_space"]`.
- The inspected page had exactly one visible `m4b_space` root, 47 exact variation labels,
  and 48 generic `[data-tid="m4b_tag"]` elements.
- The current auction appeared in exactly one visible element with the semantic
  `auction-pin-card` class token. One visible descendant had direct own text beginning
  with the current positive variation number, such as `#237 ITEMS SHOWN ON SCREEN...`.
  Another visible descendant had direct own text in the form `Bids: $28.00`.
- A payment badge is an exact `[data-tid="m4b_tag"]`; the inspected completed row used
  the whole normalized text `Payment complete` and contained a final dollar price.
- During TikTok's correction buffer, the exact `m4b_tag` text is `Payment failed` and
  capture stores the sanitized `payment_failed` status. If the correction window expires,
  the exact badge changes to `Canceled` and capture stores the distinct `canceled` status.
  The final row can also retain separate `Payment failed` detail text beside that badge;
  classification uses the exact `m4b_tag`, so the row still resolves to canonical
  `canceled`. A fixed payment can instead settle as `Payment complete` before cancellation.
- The capture allowlist also recognizes the requested whole-label values
  `Payment processing` and `Payment fixing`. Their exact spelling and
  transition order still need confirmation during live use.
- The aggregate **Attributed GMV** card is inside the exact visible `#guide-Step-2`
  analytics boundary. Its label is the complete own text `Attributed GMV`, and its
  primary value can be exact (for example `$4,087.01`) or compact (for example `$4.64K`).

The unequal variation/tag counts matter: capture cannot treat every `m4b_tag` as an
auction payment. It associates a tag with exactly one row-local variation label. Unknown
nonempty tag text is reduced to `unrecognized`; raw tag text is never transmitted or
saved. A canonical completion additionally requires the shared parser to resolve that
same variation and one price.

Generated CSS classes are not selectors. The exact `auction-pin-card` class token is a
narrow current-auction boundary. Within it, only the unique direct-own-text variation and
unique direct-own-text `Bids: $...` value are capture fields. The bid is converted to
positive integer cents immediately; raw bid/card text, title, bidder, image, and other
text are never released. Right-side Chat is not a capture source, and analytics is
never scanned for individual sales. Sold Items rows can contain incidental buyer names,
avatars, and product text,
but those values are never selected as fields, logged raw, transmitted, or persisted.
The separate analytics locator is limited to one exact root, label, and primary-value
relationship and releases only a canonical USD display; it never releases surrounding
card text or DOM.

`Payment processing`, `Payment fixing`, `Payment failed`, and unrecognized labels remain
nonterminal observations. Mapping the bidding variation immediately creates a pending
inventory reservation. That reservation remains through processing, fixing, temporary
failure, an unrecognized badge, not-yet-observed state, or a price-less completion.
Exact `Canceled` is a canonical terminal allocation result that releases the reservation,
keeps any item link as reference history, and counts no sale, revenue, cost, or profit.
The employee may later map, correct, or clear that reference item without reserving or
subtracting inventory and without changing any metric.
The implemented dashboard reads outside Sold Items are only the sanitized current
bidding variation number, its sanitized transient bid-price cents, and the isolated
aggregate Attributed GMV display.

## Current capture pipeline

The content script is available only on the exact TikTok Shop host and stays dormant
outside `/streamer/live/product/dashboard`. On that route, its Sold Items path:

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
payment badges are parsed outside the unique root. There is no fallback body scan for
individual sales.

An independent Attributed GMV path requires exactly one visible `#guide-Step-2` root.
The previously observed lowercase `#guide-step-2` spelling is an explicit fallback; no
case-insensitive, substring, or generated-class selector widens the boundary. Inside the
root, the locator requires exactly one visible element whose own normalized text is
`Attributed GMV`, then reads exactly one allowlisted USD display from that label's
immediately following primary-value region. This deliberately excludes the later
`Auction` detail row and fails closed for missing, duplicate, ambiguous, malformed, or
unsafe matches. The metric root has its own immediate scan, bounded scheduler, and
root-scoped mutation observer, so it updates live even if Sold Items is unavailable.

An independent current-bidding path requires exactly one visible element with the
`auction-pin-card` class token. Within that card it requires exactly one visible
descendant whose direct own text begins with a positive `#N`; it never searches aggregate
descendant text or uses TikTok's generated class names. Missing, duplicate, ambiguous,
or unsafe matches fail closed. A bid observation separately requires exactly one visible
descendant whose direct own text matches canonical `Bids: $...` formatting. Missing or
ambiguous bid text does not suppress a valid variation-identity observation. The card has
its own immediate scan, 75 ms quiet / 250 ms maximum bounded scheduler, root-scoped
observer, and latest-value delivery queues, so a newly shown auction and rapidly changing
bid can reach the tracker before the auction appears in Sold Items.

### Runtime message boundary

The page sends one of six strict event shapes:

```text
{ type: "observe_variations", variationNumbers: [37, 38, ...] }
{ type: "observe_bidding_variation", variationNumber: 39 }
{ type: "observe_bidding_price", variationNumber: 39, bidPriceCents: 2800 }
{ type: "observe_payment_statuses", statuses: [
    { variationNumber: 37, observedPaymentStatus: "payment_fixing" }, ...
] }
{ type: "payment_complete", variationNumber: 37, soldPriceCents: 700 }
{ type: "observe_attributed_gmv", attributedGmvDisplay: "$4.64K" }
```

It sends no `streamId`, raw payment or auction-card text, buyer identity, product title,
observation timestamp, source HTML, or other DOM content. The bidding-identity event
contains only the positive variation number. The live-bid event contains only that number
and a sanitized positive integer-cent price. The aggregate event contains only a canonical
exact/compact USD display, never the analytics label, surrounding text, or detail row.
The content script also cannot access canonical extension storage.

The service worker accepts capture messages only from the extension content script in
the top frame of the exact product-dashboard URL. It resolves the currently active
`local-stream:<uuid>` itself and persists:

- every observed variation as an unmapped auction;
- the latest active on-video bidding variation as one nullable stream marker;
- the latest sanitized observed payment status for each variation;
- exact `Canceled` as canonical cancellation for inventory allocation;
- every exact green completion with a parsed price as authoritative payment truth; and
- the latest sanitized Attributed GMV display on the worker-resolved active stream.

Live bid prices deliberately do not enter that reconciliation write list. After resolving
the active stream and validating the pair against its cached canonical bidding marker, the
worker replaces one tiny live-auction display record in `chrome.storage.session`. The
record pairs the stream and variation with nullable bid and mapped unit-cost cents. A new
marker writes a placeholder before its first bid; clearing the marker retains the latest
record until another auction starts. The worker does not clone/save reconciliation, append
bid history, or write report/accounting data for each bid. A stale variation pair is
ignored.

A bidding observation creates the canonical auction if needed but does not itself create
a payment, sale, or inventory change. Mapping that record while bidding immediately
creates its pending reservation. The first Sold Items payment-status observation or priced
completion for it clears the active marker without removing the mapping, so the selected
item carries forward into reconciliation.

Observed processing, fixing, failed, or unrecognized status does not count a sale or
change profit. Every mapped unresolved order remains pending regardless of which of those
observations is latest. Exact cancellation preserves the item link as reference history,
releases its pending allocation, and contributes no sales, revenue, cost, or profit.
Mapping, correcting, or clearing the canceled reference after that point changes only the
recorded item attribution. A completed payment contributes to Gross Item
Sales, but inventory and gross profit commit only after the employee maps the variation to
an inventory item. A complete badge whose price is temporarily unavailable remains a
provisional displayed observation and keeps any existing reservation; later status
changes are still accepted until a priced completion is durably saved. Exact cancellation
and priced completion are terminal mutually exclusive results, so later contradictory
observations are ignored. Repeated observations are no-ops. A conflicting later completed price retains the
first price and creates a reconciliation conflict.

The Metrics section keeps ten different current-stream values. **Gross Item Sales** is
the exact integer-cent sum of every priced `Payment complete` order, including completed
orders that are still unmapped. **Total GMV** mirrors TikTok's latest Attributed GMV text
without expanding a rounded value such as `$4.64K` into invented cents. Per the product
requirement, TikTok's aggregate includes buyer-paid shipping, so these values are not
expected to match and their difference is not used to alter inventory or a sale.
One combined **TikTok 6% Fees** card derives two presentation-only estimates from that
same Total GMV display. **Fees paid:** is `Total GMV * 6%`, and **GMV after fees:** is
`Total GMV * 94%`. Both always display an approximate-equal sign and round to the nearest
whole dollar. An exact display uses its captured amount; a compact value such as `$4.64K`
uses only its displayed compact magnitude, so the calculation does not invent precision.
If Total GMV is unavailable, both lines show an em dash. These estimates are not
accounting totals or net revenue: they do not model refunds, discounts, taxes, shipping
treatment, other TikTok charges, or seller expenses, and they never alter canonical
sales, inventory, cost, or profit.
**Est. Profit After Fees** is derived at presentation time as
94% of the parsed Total GMV amount minus `totals.costOfGoodsCents`. The 94% amount remains
unrounded until the exact mapped completed-sale COGS is subtracted, then the signed result is prefixed with
`≈` and rounded to the nearest whole dollar. Missing Total GMV shows an em dash. A
count-based **Incomplete** warning remains while completed sales are unmapped because
their unit costs are unknown. Bidding, processing, fixing/temporary-failed, canceled,
and unmapped completed orders add no COGS. This estimate excludes refunds, discounts,
taxes, shipping expenses, ads, labor, other platform charges, and other business costs,
so it is not true net profit.
**AOV** divides that stream's `completedGmvCents` by its uniquely priced
`completedPaymentCount` and rounds the result to the nearest cent. The two operands use
the same mapped-or-unmapped completed-order population; bidding, processing,
fixing/temporary-failed, price-less, and canceled orders are excluded. A zero eligible
completion count displays `$0.00` rather than dividing by zero, and mapping corrections do
not change AOV.
**Completed Sales/Total Sales** shows the canonical count of uniquely priced
`Payment complete` orders over unique current-stream variations whose latest observed
outcome is `payment_complete`, `payment_failed`, or `canceled`. The numerator includes
completed orders that are still unmapped. The denominator excludes the active bidding
variation and `not_observed`, `payment_processing`, `payment_fixing`, and `unrecognized`
observations. One compact order-status card displays **Canceled Orders:** and
**Payment Fixing:**. Canceled Orders counts each unique current-stream variation only
after TikTok reports the exact terminal `Canceled` badge. Active bidding and
`not_observed`, processing, fixing, temporary `Payment failed`, completed, and
unrecognized variations are excluded. Payment Fixing counts each unique canonical-
unresolved variation whose latest observation is `Payment fixing` or temporary
`Payment failed` during the correction buffer. Processing, active bidding/`not_observed`,
unrecognized, completed, and canceled variations are excluded. Completion or exact
cancellation clears the variation from Payment Fixing automatically; neither status
count depends on inventory mapping.
**Gross Profits** is mapped
completed sold-price revenue minus the committed unit-cost snapshots
from the Google Sheets baseline pinned to those sales. Completed-but-unmapped sales are
excluded from this subtotal and trigger a count-based incomplete warning until mapped;
mapping corrections and remaps recalculate both. This basic figure excludes shipping,
platform fees, taxes, discounts, refunds, and other expenses.

At **End and create report**, the worker snapshots these durable stream totals together
with every completed-sale row, each canceled variation's mapped or unmapped reference
item, and every inventory row in the pinned baseline. It does not perform a last unbounded
DOM scan; capture deliveries already ordered ahead of End are included, while anything
TikTok did not render or the extension did not durably receive cannot be reconstructed by
the report. Compatible legacy reports retain the aggregate canceled count but may not have
canceled row details.

The collapsed **Item variations this stream** disclosure, under the **Stream variations**
eyebrow, combines completed and canceled rows in variation-number order and shows their
combined count. Its **Status** column identifies the outcome. Completed rows keep mapped
and unmapped sale detail; canceled rows keep only mapped or unmapped reference identity,
show no price, unit cost, or gross profit, and never affect inventory or any metric.
Exact-SKU analytics sum mapped completed units, revenue, saved unit cost, and gross profit
by SKU. Combined product analytics sum those same values by exact `item + style` across
sizes. Top sold is ranked by units and top profitable by gross profit, with all ties
preserved. SKU gross margin is gross profit divided by mapped revenue; sell-through is
that stream's mapped completed units divided by the baseline opening quantity.
The native **Profit/Loss by SKU** disclosure uses those same exact-SKU totals, includes
only mapped SKUs with completed sales in this report stream, and sorts from highest gross
profit to largest loss. Positive values are green, losses are red, and zero is neutral.
Pending, canceled, unmapped, and unsold entries are excluded. It starts collapsed on
screen and expands for print/PDF output.
The report's **AOV** uses the same current-stream formula and nearest-cent rounding as the
live card, and displays `$0.00` when no eligible completion exists.
The report also derives **TikTok 6% Fees** from its frozen Attributed GMV display using the
same 6%/94%, approximate-sign, whole-dollar, compact/exact, and missing-value rules as the
live card. It does not recalculate the fee estimate from Gross Item Sales.
The report derives **Est. Profit After Fees** from that same frozen display and the saved
mapped completed COGS total, without adding a serialized field or migration. It retains
the live card's rounding, signed-loss, missing-GMV, and incomplete-count behavior.

The inventory export is baseline-wide. For every SKU it keeps opening quantity,
current-stream completed allocations, completed allocations across all streams sharing
the baseline, pending reservations, signed calculated remaining, nonnegative
available-after-reservations, oversold amount, and a recount flag. The Google Sheets
replacement count is `max(0, opening - all baseline completed sales)`. Pending remains a
separate warning and does not permanently reduce that replacement count. A negative raw
result is retained as an oversold/recount notice while the copy/CSV value is clamped to
zero. A report-only cost correction changes that report handoff's `unit_cost` column but
never changes any quantity column or the canonical baseline.

The strict saved record retains internal completeness status and reason codes. An active
bidding variation, unresolved order, pending reservation, payment-fixing order, unmapped
completed sale, conflict, or oversold/recount condition adds a specific attention notice
but never blocks End. The employee UI does not show Final/Provisional state wording. The
report does not reopen its ended stream in the tagger. The newest safely eligible report
can instead resolve canonical-unresolved `Payment fixing` or temporary `Payment failed`
orders after End. Payment completion requires the seller-verified final sold price;
cancellation releases the reservation. Separately, every finalized current or archived
report exposes a collapsed unit-cost control listing every SKU saved in that report,
including unsold ones. It accepts nonnegative integer-cent values and requires
confirmation. A cost correction reprices only that report's mapped completed rows and
regenerates its dependent metrics and handoff. Canonical reconciliation, the inventory
baseline, other reports, live tracking, and future streams remain unchanged.

These captured facts hydrate into reconciliation state version 7. Report-only unit-cost
correction never enters that state and adds no persisted shape or migration. Each stream record has
an immutable inventory-baseline pin plus nullable `attributedGmvDisplay` and
`activeBiddingVariationNumber`, and capture
verifies or repairs the active stream's pin before applying a variation, payment, or
aggregate fact. Strict version-1 through version-3 snapshots migrate to one deterministic
legacy baseline and pin every legacy stream to it; a strict version-4 baseline snapshot
keeps its pins and receives `attributedGmvDisplay: null` for every stream. The outer
browser-storage envelope remains schema version 1. Malformed or dangling baseline, SKU,
cost, stream, and bidding-marker relationships fail closed. Strict version-5 snapshots
retain their GMV display and migrate with a null bidding marker, while version-6 snapshots
retain valid bidding markers. Across every version-1 through version-6 migration, a saved
Live `marked_unpaid` record becomes `mapped` when it has a SKU or `unmapped` otherwise so
its unresolved automatic TikTok lifecycle and reservation can resume. A legacy
completion-after-cancellation conflict becomes canonical terminal cancellation, with its
stale completed price and cost allocation cleared; canonical version 7 rejects that
contradiction. Versions 1 through 6 all migrate to the strict version-7 shape.

The content client marks an event delivered only after the worker acknowledges it. A
failed observation, payment, bidding number/price, or aggregate display is requeued with a
delay that backs off from one to five seconds. The Sold Items, current-bidding, and
Attributed GMV paths have separate sanitized delivery outboxes scoped to the current
document body. All survive their root
being replaced or temporarily unavailable. Historical Sold Items facts keep draining
while a replacement root receives a fresh backfill; the aggregate queue keeps only the
newest undelivered display so a stale retry cannot overwrite a newer value; the bidding
queues apply the same newest-value rule to variation identity and complete
`(variationNumber, bidPriceCents)` pairs. Identity is queued before price, intermediate
bids may be coalesced, and retry always targets the latest pair. Route exit or body
replacement discards all three outboxes, and persisted reconciliation state makes
repeated delivery safe.

If no local tracker stream is active, no nonempty active inventory baseline exists, or
saved session/state/pin cannot be verified, no canonical write occurs. The current
body's sanitized facts remain queued for retry while that route and body remain current.

After the worker accepts a capture fact through the durable reconciliation boundary, it
sends the open side panel a data-free `capture_state_changed` invalidation. The panel
validates the exact extension-worker message, coalesces bursts, and refetches canonical
state through its read client. The notice contains no stream ID, variation, price, buyer
information, DOM content, or snapshot. A notification delivery failure does not undo or
misreport the already-successful capture write.

An accepted live-bid change instead emits a dedicated data-free `live_bid_changed`
notification. The panel performs only a lightweight transient read and targeted update of
the live auction values; it does not refetch the full reconciliation snapshot or rerender
inventory for each bid. The panel stays visible while the Live tracker is active and while
history is selected. It begins at `Variation # -` with dashes, clears prior values as soon
as a new marker is captured, and retains that auction's last display with a muted indicator
after the marker clears. Mapping/remapping/unmapping recomputes unit cost and pre-fee live
gross profit (`bid - cost`) without changing business accounting. Sold Items remains
authoritative for the final price, all metrics, inventory accounting, and reports.

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
5. With no local tracker stream active, open the side panel, which defaults to **Live
   session**. Paste the Sheet ID or its
   HTTPS `docs.google.com` sharing link, and select **Connect and preview**. The manifest
   grants `identity`, the exact `https://sheets.googleapis.com/*` host, and only
   `https://www.googleapis.com/auth/spreadsheets.readonly`. That Google scope can read
   spreadsheets available to the connected account, but the importer requests only the
   selected ID and fixed whole-sheet `'Inventory'` range.
6. Verify the full normalized table, row count, opening-unit total, and opening-cost
   total. Select **Confirm inventory baseline**. Confirmation re-reads the Sheet before
   atomically saving a new durable local baseline; Start becomes available only after
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
  confirmed inventory and its non-secret source fingerprint are persisted locally.

After Start, inventory, reservations, payment reconciliation, and basic profit use the
local pinned baseline. The extension makes no live Google request and has no Sheets write
scope. After End, its local report can copy or download an exact six-column replacement
table for an employee to paste/import manually. A new physical recount is another
pre-stream import after End; it cannot alter the opening quantity, SKU identity, or pin
of an active or historical stream. A saved report's separate cost control edits only that
report and its copy/CSV handoff, even when the report is older or archived or another
stream is active.

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
3. Complete the inventory-import checks above, then remain in the default **Live session**
   and Start a local tracker stream from the confirmed baseline, or Resume the
   already-active stream.
   Before Start, confirm Google Sheets inventory appears before the local Start controls.
   After Start or Resume, confirm Variation is the first section below the header. The
   final substantive section should compact to the tracker-active date row, with the
   **Active** pill inside that row, followed by **End Stream Tracking**. Its redundant
   heading and safety note should be hidden only while actively tracking. A single
   saved-state indicator belongs in the footer; there should not be a duplicate status
   box below Metrics. Retryable saved-data errors must remain visible near the top. This
   does not start or control TikTok LIVE.
4. Open `https://shop.tiktok.com/streamer/live/product/dashboard`. Keep the video auction
   card visible and select TikTok's left-side **Sold items** view so all three scoped
   capture paths can be checked.
5. Open DevTools → **Console** and confirm:

   ```text
   [TikTok Live Tracker] Capture probe active on /streamer/live/product/dashboard.
   ```

6. Keep the active Live session side panel open during bidding. Confirm the variation
   number at the bottom of the video becomes the selected option formatted
   `#N - bidding - No item selected`. Map an inventory item and confirm the option retains
   `bidding` while its final segment changes to the selected item, style, and size.
7. Wait for TikTok to show a new auction. Confirm its variation becomes selected without
   opening the menu. Then confirm the prior auction remains in history when Sold Items
   supplies its payment truth, its item mapping persists, and `bidding` is replaced by
   the observed payment wording. Open and scroll the selector without choosing an option,
   then let another variation or payment-status update arrive. The native menu must remain
   open at the same scroll position while the worker continues saving capture data, and its
   visible options must remain unchanged until the employee closes it or makes a selection.
   Reopen it and confirm the newest variation and every deferred status or mapping label
   appear together. Repeat once with pointer input and once with the keyboard. Select a
   historical variation and confirm the compact
   **Return to live item** button appears below the selector. It must select the active
   bidding variation, or the newest captured variation when there is no active marker,
   then disappear and resume automatic follow. Confirm this navigation does not alter any
   mapping, inventory, payment, or persisted auction data. A later status-only update must
   not steal selection.
   Before the first auction, confirm the compact **Live auction** panel shows
   `Variation # -` and dashes. While bids arrive rapidly, confirm it reaches the newest
   visible price without stepping through stale queued values. On a new variation, verify
   its heading switches to `Variation #N` immediately and shows dashes until the first
   valid `Bids: $...` value rather than reusing the prior auction's data. Current bid must
   remain visible while unmapped, with dashes for unit cost and live gross profit. Map,
   remap, and unmap the active variation and confirm those two fields recompute immediately.
   Exercise below-cost, exact-cost, and above-cost bids and verify negative red, neutral
   zero, and positive green signed values. Select an older variation and verify the live
   panel continues tracking only the active auction. When the active marker clears, verify
   the panel retains the last variation number and values with a muted indicator, without
   the words `Previous auction`, until the next auction begins. The eventual Sold Items
   sold price must remain the only final price. Reopen the side panel, then allow the
   service worker to suspend/restart during another auction; verify the stream/variation-
   paired latest display is recovered without leaking another stream's auction data.
8. Keep a variation selected while its badge changes. Confirm the visible **TikTok
   payment** value changes live among **Payment processing**, **Payment fixing**,
   **Payment failed**, **Canceled**, and **Payment complete** without a page refresh or menu
   click. The selector must stay on that variation for status-only changes.
9. For `Payment complete`, confirm its final price is visible even before an inventory
   item is selected. Reopen and Resume once to verify the same number, status, and price
   remain durable.
   In **Metrics**, also confirm **Gross Item Sales** equals the exact sum of all priced
   completed orders while **Total GMV** mirrors TikTok's current **Attributed GMV** text,
   including a compact display such as `$4.64K`. The second value includes buyer-paid
   shipping per the product requirement and therefore need not equal the first. Change
   the TikTok metric without refreshing the page and confirm Total GMV updates live and
   survives a side-panel reopen. Confirm **TikTok 6% Fees** shows **Fees paid:** as Total
   GMV multiplied by 6% and **GMV after fees:** as Total GMV multiplied by 94%. For both an
   exact display and a compact display such as `$4.64K`, both outputs must use `≈` and
   round to the nearest whole dollar; with no captured GMV, both must show an em dash.
   Confirm the post-stream report preserves the same frozen estimates and that neither
   value changes sales, inventory, COGS, or profit. Confirm **AOV** equals Gross Item
   Sales divided by the uniquely priced completed-order count and is rounded to the
   nearest cent. It must
   include mapped and unmapped completions, ignore mapping corrections, exclude bidding,
   processing, fixing/temporary-failed, price-less, and canceled orders, and show `$0.00`
   before any eligible sale. Confirm the post-stream report preserves that same value and
   label. Confirm **Completed Sales/Total Sales** shows the number
   of uniquely priced canonical completions, including those still unmapped, over unique
   current-stream variations whose latest observed outcome is `payment_complete`,
   `payment_failed`, or `canceled`. Confirm the active bidding variation plus
   `not_observed`, processing, fixing, and unrecognized observations remain excluded, and
   mapping corrections do not change either count. In the combined order-status card,
   confirm **Canceled Orders:** increases once for each unique current-stream variation
   only when its row reaches exact terminal `Canceled`. Verify bidding, `not_observed`,
   processing, fixing, temporary failed, completed, and unrecognized variations remain
   excluded. Confirm **Payment Fixing:** includes unique canonical-unresolved variations
   while their latest observation is fixing or temporary failed, but excludes processing,
   bidding/`not_observed`, unrecognized, completed, and canceled variations. Verify a
   priced completion or exact cancellation removes the order from Payment Fixing, and
   only cancellation adds it to Canceled Orders. Inventory mapping must not change either
   status count. Confirm **Gross Profits** equals
   mapped completed sold-price revenue minus the pinned Google Sheets unit costs. Leave a
   completed order unmapped and confirm it is excluded while the warning shows one
   incomplete sale; map or remap it and confirm the subtotal and warning recalculate
   immediately. Confirm **Est. Profit After Fees** equals unrounded `Total GMV * 94%`
   minus mapped completed COGS, with only the final signed result rounded to an
   approximate whole dollar. Verify an unmapped completed sale appears in its explicit
   incomplete count, mapping or remapping recalculates it, and missing Total GMV shows an
   em dash. End tracking and confirm the report preserves the same result and warning.
10. Map the current bidding variation and confirm its card immediately reduces the
    displayed available count and reports one pending reservation. It must not count a
    sale or change profit. When that row moves through processing, fixing, temporary
    failed, unrecognized, or price-less completion, confirm the item and pending count
    remain unchanged.
11. When that row becomes exact `Canceled`, confirm the item link remains visible as
    reference history, its reservation is released, availability is restored, and sale
    count, revenue, cost, and profit do not change. Confirm every inventory card remains
    enabled. Map the canceled variation to another item, click that selected item again to
    clear it, then map it once more; each change must update its reference label in the
    variation dropdown without changing inventory or any metric. A canceled variation
    must not require resolution before End.
12. On an inventory-affecting variation, select an entry at zero availability. Confirm
    the card remains enabled, never says **Sold out**, and shows `Oversold by N`;
    assigning or canceling further pending orders must update N without double-counting
    completion.
13. Correct a historical completed variation to another SKU and confirm the old SKU is
    restored, the new SKU is decremented, and cost and gross profit recalculate together.
    Repeat these checks across later tracker streams and imported baselines.
14. Select **End Stream Tracking**. Confirm the dialog says **End and create the stream
    report?**, lists each pending, fixing, unmapped, conflicting, or oversold attention
    count without a Final/Provisional label, and does not block End for any of them. Select
    **Keep stream active** once, then reopen and select **End and create report**. The local
    stream must end only after its report is saved; TikTok LIVE must not change. If report
    persistence is deliberately failed, normal End must retain the active stream and
    expose **End without report** as the explicit fallback.
15. Confirm the report opens in a new extension tab. Verify its start/end timestamps,
    attention notices, captured performance totals, mapped and unmapped completed rows,
    exact-SKU table, combined item-and-style top performers across sizes, and ties. Confirm
    neither the report nor its side-panel archive link shows Final/Provisional wording.
    Confirm **Item variations this stream**, **Profit/Loss by SKU**, and **Definitions and
    limitations** start collapsed and expand on activation. The stream-variation count must
    remain visible in both table states and equal completed plus canceled totals. Confirm
    the **Status** column distinguishes completed and canceled rows; canceled rows retain
    their mapped or unmapped reference identity but have no sale price, unit cost, gross
    profit, inventory, or metric effect. A compatible older report may retain its canceled
    total while lacking canceled row details.
    Confirm the SKU profit/loss rows contain only mapped SKUs sold in this report stream,
    sort from highest profit to largest loss, and render positive, negative, and zero
    values in green, red, and neutral styles. Pending, canceled, unmapped, and unsold
    entries must not appear in that profit/loss section.
    Verify its updated inventory table includes every baseline SKU. Use **Print / Save as
    PDF** and Chrome's **Save as PDF** destination to save a durable copy outside the
    extension. Verify the PDF includes every available completed/canceled variation row,
    eligible SKU profit/loss row, and definition even when those sections were collapsed
    on screen.
    End a test stream with one mapped `Payment failed` or `Payment fixing` order. In
    **Finish unresolved payments**, cancel the confirmation once and verify nothing
    changes. Then mark it complete with an invalid price and confirm validation fails;
    enter the seller-verified final price, confirm, and verify pending/fixing clears while
    completed sales, inventory, COGS, profit, warnings, and CSV all recalculate. In a
    separate run, mark the order canceled and verify the reservation is released, Canceled
    Orders increases, and the order never enters completed sales. Confirm processing and
    other statuses never appear. Also confirm controls disappear for older reports, an
    older inventory baseline, a later End-without-report stream, or while a tracker is
    active.
    Fail report replacement after the canonical correction saves, then reload the report;
    confirm the read-time repair regenerates the report and does not ask for a second
    payment decision.
    Expand **Correct SKU Unit Cost** and verify every report inventory SKU appears, including one
    with no completed sale in this stream. Cancel a correction and confirm nothing changes.
    Correct a sold SKU and verify the same report recalculates completed-order unit cost
    and profit, COGS, gross profit/margin, Est. Profit After Fees, top-profit rankings,
    Profit/Loss by SKU, SKU/product performance, and the copy/CSV `unit_cost`. Prices,
    statuses, quantities, GMV, Gross Item Sales, AOV, and fees must not change. Correct an
    unsold SKU and verify current-stream financial totals remain unchanged while that
    report's handoff uses the new cost. Reload after the correction and confirm the same
    report retains the corrected value. Verify the unit-cost control remains available on
    older and archived finalized reports, after a newer stream exists, and while tracking
    is active. Confirm canonical inventory, other reports, and future streams retain the
    original cost. The payment-resolution section retains its stricter eligibility guards.
16. For the novice Google Sheets handoff, duplicate the current `Inventory` tab as a
    backup. In the report select **Copy Updated Inventory**, return to the original
    `Inventory` tab, click cell **A1**, and press **Ctrl+V** on Windows or **Cmd+V** on
    macOS. Before copying, verify the report table shows the saved unit cost for every SKU,
    including `$0.00`; its visible **Sold** header means completed mapped sales since the
    inventory baseline. On a narrow window, verify the table scrolls horizontally, and in
    print preview verify all columns remain visible with repeating headers. Then verify the
    copied/downloaded handoff still has the exact six headers and all rows. **Copy Updated
    Inventory** provides the complete six-column A1 paste table. Alternatively, download
    the matching CSV and use **File -> Import -> Upload -> Replace current sheet** only
    after making the backup. If a row is oversold, the exported count is zero but its raw
    shortage/recount warning remains; physically recount it. Review every attention notice
    before using the replacement counts.
17. Reopen the side panel and confirm **Business Records** lists the new report with its
    date, completed/total count, and Gross Item Sales. Open it, retry a simulated list failure, and
    restart Chrome/the worker to verify local recovery. Create six isolated test reports:
    only the newest five should remain in Business Records, while the oldest finalized
    one must move intact to **Archived stream reports**. Open that archived report and
    verify its Print/Save-as-PDF and inventory CSV actions still work.
18. Exercise **More actions -> Archive** on a current report. In the archive, use Select,
    Select all, and Clear selection. Restore a selection no larger than the available
    Business Records slots and verify every selected report moves atomically. Attempt an
    oversized restore and verify none moves. Select disposable archived records, choose
    **Delete selected**, cancel the confirmation once, then confirm and verify only the
    selected archived records are permanently deleted.
19. Fill five Business Records and 25 archived slots, or use a test fixture that reaches
    the combined cap of approximately 4 MiB. The next report-aware End must fail
    explicitly before ending the stream and preserve every record. Manual Archive must
    likewise fail without a mutation when archive capacity is unavailable. Delete
    selected archived test records and retry End, or deliberately choose **End without report**. No report may be silently
    pruned on any capacity path.

Only the persisted `activeBiddingVariationNumber` from the strict on-video card is called
the current bidding auction. A changed marker is selected automatically only while the
employee is viewing the previously current auction. While the employee reviews a
historical variation, new markers and status changes continue being captured but do not
change its selection. Visible selector-option mutations are deferred while its native menu
is open so a background refresh cannot close the menu or reset its scroll position. The
newest saved option state is applied when the employee selects or dismisses the menu. A
compact **Return to live item** action is visible only in that historical-review state. It
targets the active bidding variation when available and otherwise the newest captured
variation; selecting it resumes automatic follow without a mapping, inventory, payment,
or persistence mutation.
A richer prioritized queue across the persisted auction history remains future work.

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
  by confirmed Google Sheets import. The worker
  permanently pins the new stream to that imported baseline. Only an already-active
  legacy session with truly absent reconciliation state may use the narrow compatibility-repair
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
- Report-aware End is available for a known active local stream. Processing/fixing
  reservations, completed sales without items, and every other reconciliation exception
  do not block the confirmation; the readiness area lists them as attention counts. The
  employee can End without first resuming the inventory workspace.
- Normal End freezes and saves the local report before it clears the active stream. A
  report/storage failure leaves the stream active and exposes **End without report** as a
  deliberate recovery choice. Neither action ends TikTok LIVE. Ended streams cannot yet
  be reopened in the tagger, so employees should make corrections before End when
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
3. Confirm the route becomes active again and each scoped observer resumes only when its
   own unique visible boundary is available.
4. Put the tab in the background, return to it, and confirm a later Sold Items variation
   or payment-status transition appears in the still-open side panel.
5. If TikTok replaces the Sold Items root, confirm capture rebinds and the backfill does
   not duplicate inventory or Gross Item Sales.
6. If TikTok replaces the `auction-pin-card`, confirm the isolated current-bidding
   observer rebinds and the newest variation becomes current without duplicating a
   mapping or creating payment/inventory effects.
7. If TikTok replaces or temporarily removes `#guide-Step-2`, confirm the isolated metric
   observer rebinds and the newest Attributed GMV display wins over any older retry. A
   route exit or full body replacement must discard all three page-scoped delivery
   outboxes.

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
node --test .\tests\attributed-gmv-locator.test.cjs
node --test .\tests\bidding-variation-locator.test.cjs
node --test .\tests\capture-content.test.cjs
node --test .\tests\capture-protocol.test.cjs
node --test .\tests\capture-client.test.cjs
node --test .\tests\capture-integration.test.cjs
node --test .\tests\attributed-gmv-state.test.cjs
node --test .\tests\bidding-variation-state.test.cjs
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
  sanitized facts retry while the same dashboard route and document body remain active,
  including across a scoped-root replacement.
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

- a prioritized employee work queue across the now-live-refreshed, persisted bidding and
  Sold Items variations;
- visible capture connection, retry, and queue-drained state;
- the transition timing and color-independent meaning of processing, fixing, failed,
  unrecognized, and other additional payment labels; the product rule deliberately keeps
  every mapped unresolved order reserved until priced completion or exact `Canceled`;
- a stable TikTok-provided stream/session identifier across SPA navigation and full
  refresh that differs across two LIVE sessions;
- automatic protection against assigning stale rendered rows to a new local stream;
- whether `m4b_space` stays unique across accounts, modes, streams, scrolling, and TikTok
  releases;
- whether the exact visible `guide-Step-2` analytics identity, label/value relationship,
  and exact/compact USD display remain stable across accounts, modes, streams, and TikTok
  releases;
- whether the exact visible `auction-pin-card` token and direct-own-text `#N` relationship
  plus the direct-own-text `Bids: $...` value remain unique and stable across accounts,
  modes, bid speeds, streams, and TikTok releases;
- whether Sold Items is virtualized or replaced as it grows and whether every row reaches
  durable state before the report snapshot; and
- real-stream validation of root replacement, tab suspension, refresh, and a second LIVE.

Google Sheets OAuth, fixed-range reading, detached preview, explicit confirmation,
immutable baseline creation and stream pinning are now implemented before Start. This
inventory-only boundary does not expand capture authority: the content script still must
not read Sheet data, buyer identity, inventory mappings, or credentials, and it cannot
contact Google. Only the worker performs the selected pre-stream read. The report's local
clipboard/CSV handoff performs no Google request; automatic outbound Sheets writes and
any live Google dependency remain intentionally absent.

## Current limitations

- Parsing assumes English dashboard text and US-dollar formatting.
- Exact Sold Items variation labels and sanitized payment statuses are persisted. Only a
  priced `Payment complete` can commit a sale, inventory decrement, revenue, and profit.
  Exact `Canceled` is authoritative without counting a sale. A selected item is pending
  from bidding through processing, fixing, temporary failure, unrecognized, and
  price-less completion observations, and resolves only at cancellation or priced
  completion.
- The `m4b_space` selector has been observed on one real stream and still needs broader
  validation.
- The isolated `guide-Step-2` Attributed GMV boundary also needs broader live validation.
  Total GMV deliberately mirrors TikTok's possibly rounded display; it is not converted
  to exact cents or used for inventory accounting. The 6%/94% fee figures consequently
  remain explicitly approximate whole-dollar estimates derived from the displayed
  magnitude, not verified TikTok payouts, accounting totals, or net revenue.
- The local stream ID is tracker-owned, not TikTok-verified.
- The open tagger treats only the strict on-video marker as current bidding. It
  auto-displays the next changed marker while the current auction is selected, but keeps
  a manually selected historical variation in view while newer data continues being
  captured. An open native variation menu temporarily freezes its visible options and
  applies the newest saved option state after selection or dismissal. The same mapping
  remains attached when Sold Items payment truth arrives.
- There is no visible capture connection, retry, or queue-drained indicator yet.
- Browser or process suspension can delay scans and delivery retries.
- The retained live-auction display is temporary session state rather than reconciliation
  history. It survives service-worker suspension and side-panel reopening, but is
  reacquired from the visible auction card after a browser restart. It is not recoverable
  from reports and never replaces the Sold Items final price.
- A report is limited to facts durably captured before End. It cannot recover a Sold
  Items row TikTok did not render. Internal completeness metadata does not independently
  verify TikTok's full stream totals and is not shown as a customer-facing state label.
- The narrow canonical report correction can resolve fixing/temporary-failed payments
  only on the newest safe ended stream. Unit cost can be corrected in any finalized
  current or archived report, but only that report and its handoff change. Neither path
  reopens capture or edits mappings, and the report-only cost path never changes canonical
  inventory, other reports, or future streams. The employee must enter a seller-verified
  price for payment completion and explicitly confirm a nonnegative cost.
- Reports are stored locally as five Business Records plus as many as 25 archived records
  under a combined cap of approximately 4 MiB. Capacity never silently deletes an
  existing report; archive deletion is employee-selected and explicitly confirmed.
  Clearing extension storage or uninstalling removes the entire library, so save required
  PDF/CSV copies first. Reports contain local stream timestamps, inventory/SKU/cost/count
  data, captured sale prices and status aggregates, and profit, but no buyer, Sheet ID/link, token, or raw DOM text.
- Capture stores no buyer identity and contacts neither TikTok APIs nor Google Sheets.
  Its only analytics-derived value is the sanitized Attributed GMV display.
  The separate worker-owned importer contacts the Sheets API only before a stream is
  started or after it has ended.
