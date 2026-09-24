# Architecture

This document records the business rules and technical decisions that keep TikTok
sales, inventory, and gross profit consistent. It distinguishes the current
implementation from behavior that still requires a live-stream test.

## 1. Domain model

A **stream** is one live selling session. The seller auctions physical items through a
generic temporary listing, and TikTok assigns each auction a sequential **variation
number** such as `#203`.

Based on the seller's current workflow:

- Variation numbers restart for each stream.
- One variation represents one auction of one physical item.
- The current bid changes during bidding and is not the final sale price.
- A permanently unpaid item may be auctioned again under a new variation number.

The identity of an auction is therefore:

```text
(streamId, variationNumber)
```

Variation number alone is not safe because another stream can reuse it.

### Inventory entries, baselines, and SKUs

An inventory baseline contains one row for each unique item/style/size combination at a
confirmed physical-count instant. Every size therefore requires its own unique `sku`,
which is the reconciliation engine's stable identifier for that exact row. It does not
need to be a client-assigned SKU or a number.

For example, these are two separate inventory entries:

```text
Stussy tee / black / size L
Stussy tee / black / size M
```

The live interface groups rows by normalized item plus style for presentation only.
Normalization uses canonical Unicode, collapsed whitespace, and case-folding, and unit
cost is deliberately not part of the group key. A one-row group remains a direct-action
card; a multi-row group opens a naturally sorted size list whose options expose the exact
size, SKU, and per-size stock. The parent card shows aggregate stock. No grouped object is
persisted: mappings, reservations, sales, costs, reports, and Sheet handoffs continue to
reference the exact size-level SKU. Each tracker stream belongs to one
immutable physical-count baseline lineage. A later recount appends a different lineage
for future streams; it never rewrites the opening count or cost used by an active or
historical stream. During an active stream, a strict append-only Sheet refresh may derive
an expanded immutable snapshot in the same lineage. It may add new SKU rows only; all six
stored fields of every existing row must match. Every stream sharing the prior snapshot
is moved to the derived snapshot atomically so completed and reserved counts keep one
scope. A report-only cost correction changes one saved report without mutating canonical
inventory.

## 2. Payment and mapping are independent

TikTok decides whether an auction became a completed sale. The employee only identifies
which physical inventory entry was shown. These are separate state axes.

### TikTok payment state

The model deliberately keeps the latest sanitized Sold Items badge separate from
canonical sale truth:

| Observed status | Visible meaning |
| --- | --- |
| `not_observed` | No row-local payment badge has been captured yet |
| `payment_processing` | TikTok shows `Payment processing` |
| `order_processing` | TikTok shows `Order processing` |
| `payment_fixing` | TikTok shows `Payment fixing` |
| `payment_failed` | Legacy unresolved saved status, or a fresh failure badge explicitly accompanied by a cancellation countdown |
| `canceled` | Fresh terminal `Payment failed`, `Canceled`, or `Cancelled` |
| `payment_complete` | TikTok shows `Payment complete` |
| `unrecognized` | A nonempty tag was present but was not allowlisted; raw text is discarded |

The processing and fixing labels also recognize their three-period and Unicode-ellipsis
forms. `order_processing` remains unresolved and follows the same reservation rules as
`payment_processing`.

Canonical `paymentStatus` is `unknown`, `canceled`, or `payment_complete`. Processing,
fixing, failed, and unrecognized remain nonterminal observations under canonical
`unknown`. Every mapped canonical-unknown record reserves one unit immediately, including
the bidding/not-yet-observed state, processing, fixing, temporary failure, an
unrecognized badge, and a price-less completion observation. The reservation resolves
only at canonical priced completion or exact cancellation.
Fresh terminal `Payment failed`, `Canceled`, or `Cancelled` promotes it to canonical
`canceled`, preserves its item link for
history, and releases its reservation without counting a sale, revenue, cost, or profit.
Only a `Payment complete` badge with a parsed final price promotes the record to canonical
`payment_complete` and makes it eligible to drive Gross Item Sales, inventory, and profit.

### Employee mapping state

| State | Meaning |
| --- | --- |
| `unmapped` | No inventory entry has been selected |
| `mapped` | The variation is linked to a valid inventory `sku` |
| `marked_unpaid` | Legacy manual-unpaid state; version 1–6 snapshots normalize it before Live use, and version 7 rejects it |

The engine derives a user-facing auction status from both axes:

| Derived status | Meaning |
| --- | --- |
| `unmapped` | No completed payment and no inventory mapping |
| `mapped` | Legacy display state with inventory selected but no pending reservation |
| `pending` | Inventory is mapped and canonical payment truth is still unresolved |
| `marked_unpaid` | Legacy manual-unpaid state normalized during migration |
| `canceled` | TikTok canonically canceled the auction; its item link is retained, its reservation is released, and no sale is counted |
| `unmapped_completed` | TikTok shows payment complete, but the inventory item is unknown |
| `committed` | Payment is complete and the inventory item is mapped |

### The commit rule

> A priced canonical completion contributes to **Gross Item Sales**, completed-sales
> counts, and AOV whether mapped or unmapped. Committed revenue, inventory deduction,
> cost of goods, and gross profit additionally require a valid inventory mapping.

Consequences:

1. Mapping during bidding immediately reserves one unit. The reservation survives
   processing, fixing, temporary failure, unrecognized, not-yet-observed, and
   unpriced-complete observations until canonical payment truth resolves.
2. A captured terminal cancellation releases that reservation while retaining the SKU as
   historical attribution. The cancellation itself never contributes a sale or money.
3. A green-but-unmapped auction still contributes to Gross Item Sales and must be shown as
   an exception until an employee maps it.
4. Reprocessing the same completed event must update the same auction record rather
   than count a second sale.
5. Employee mappings pass through the service worker and are saved before the tagger
   displays them as successful. They are restored after the panel or service worker
   restarts. Live mode exposes no manual unpaid decision.
6. Canonical TikTok payment state moves from `unknown` to one terminal result:
   `canceled` or `payment_complete`. Once either result is stored, later contradictory
   payment observations cannot reverse it.
7. Clicking an already-selected inventory item removes only the mapping. Any pending
   reservation is released; a completed auction keeps its final price and contribution to Gross Item Sales
   but becomes `unmapped_completed` until it is tagged again. A canceled variation can be
   mapped, unmapped, or remapped only as reference attribution; those changes have no
   inventory or metric effect.

### Permanent payment failure and re-auction

When TikTok displays an exact row-local terminal `Payment failed`, `Canceled`, or
`Cancelled` badge:

1. The record becomes canonically `canceled` without employee action.
2. Any selected SKU remains linked for history, while its pending reservation is
   released. Remaining inventory, completed sales, revenue, cost, and profit stay
   unchanged. The employee may later map, correct, or clear that reference SKU without
   changing those values.
3. If the same physical item is auctioned again, TikTok assigns a new variation number.
4. The employee maps that new variation as a separate auction.

The Live tagger does not infer cancellation with a timer and exposes no **Mark unpaid** or
**Undo unpaid** action. It waits for a valid terminal `Payment failed`, `Canceled`, or
`Cancelled` badge. Processing, including both ellipsis aliases, remains unresolved.

The updated failure wording is translated only at the capture boundary. Existing
internal `payment_failed` records and historical reports are not migrated or reclassified.
A fresh `Payment failed` explicitly accompanied by visible same-order
`Transaction will cancel in MM:SS` detail retains legacy `payment_failed` instead.
Recognized truncated countdown text can use its full exact `title`; even `00:00` remains
a veto until the indicator disappears, not a timer-driven cancellation. The Sold Items
observer schedules relevant countdown detail changes through the existing rescan timing.
Ambiguous row/tag associations stay rejected, and completed sales cannot be reversed.

## 3. Reconciliation engine — implemented

`extension/shared/reconciliation.js` is a dependency-free, JSON-serializable business
rules module. The saved tagger uses its read model while the service-worker coordinator
owns persistent mapping and captured
variation, current-bidding, payment-status, payment-complete, and Attributed-GMV
operations.

The module also exposes a strict hydration boundary for data read from persistence. It
rebuilds a detached canonical state only after validating versions, inventory, streams,
auction relationships, money fields, statuses, and conflicts. Invalid persisted data is
rejected rather than passed into normal engine operations.

Implemented behavior includes:

- Appending validated, immutable inventory baselines from unique SKUs, confirmed opening
  quantities, and unit costs, then activating the newest baseline for future streams.
- Pinning each tracker stream to one physical-count baseline lineage and rejecting an
  arbitrary repin or recount. A validated live append derives a new immutable snapshot
  and atomically advances every stream sharing the old snapshot.
- Allowing two distinct baseline IDs to carry the same source fingerprint so two genuine
  physical recounts with equivalent contents remain separate business events. Reusing a
  baseline ID with identical contents is idempotent; reusing it with different contents
  is a conflict.
- Accepting employee mapping and completed-payment events in either order.
- Persisting processing, fixing, failed, and unrecognized as nonterminal observed statuses
  without changing money; a mapped canonical-unknown auction stays reserved regardless
  of which of those observations is latest.
- Promoting captured terminal cancellation to an allocation result that preserves the
  mapping, releases its reservation, and contributes no sale or money.
- Treating exact cancellation and priced completion as mutually exclusive terminal
  results; stale contradictory observations are ignored.
- Using `(streamId, variationNumber)` to keep auctions distinct.
- Ignoring an identical repeated payment event.
- Retaining the first completed price and warning about a later conflicting price.
- Allowing a mapping to be corrected before or after a sale commits.
- Allowing a mapping to be removed without erasing the variation or its authoritative
  payment data.
- Applying a committed historical mapping correction atomically: restore the old SKU,
  decrement the new SKU, replace the committed cost snapshot, and recalculate gross
  profit.
- Leaving remaining inventory and profit unchanged for pending, canceled, and
  marked-unpaid records.
- Tracking every mapped canonical-unknown auction as a pending reservation from bidding
  until completion or cancellation.
- Recording a real completed sale even if inventory becomes negative, while surfacing an
  oversold warning.
- Allowing inventory-affecting auctions to select an exhausted SKU and reporting the
  shortage as `Oversold by N` instead of disabling or rejecting the mapping. Canceled
  auctions can reference any SKU without creating or changing a shortage.
- Separating Gross Item Sales from mapped revenue and gross profit.
- Storing the latest sanitized TikTok Attributed GMV display on its stream without
  converting a rounded compact value into invented exact cents.
- Deriving the two **TikTok 6% Fees** display estimates from that sanitized aggregate only
  at presentation time, always marking them approximate and rounding to whole dollars;
  they never enter canonical sales, inventory, cost, or profit accounting.
- Deriving **Est. Profit After Fees** at presentation time as
  `(Total GMV * 0.94) - costOfGoodsCents`, subtracting mapped completed-sale COGS before
  rounding the signed result to an approximate whole dollar. Missing Total GMV produces
  an em dash, and unmapped completions produce a count-based incomplete warning.
- Storing one active bidding variation marker per stream, with no payment or inventory
  effect, and clearing it when Sold Items supplies payment truth for that variation.

All money is represented internally as integer cents. For example, `$48.00` becomes
`4800`. This avoids decimal rounding errors.

Inventory exposes two deliberately different quantities:

```text
remainingQuantity = quantityOnHandAtImport - completed sales under the pinned baseline
availableToTagQuantity = remainingQuantity - pending reservations
displayedAvailableQuantity = max(0, availableToTagQuantity)
oversoldQuantity = max(0, -availableToTagQuantity)
```

Every mapped canonical-unknown record contributes one pending reservation but does not
count as sold. Cards present the nonnegative available count after reservations, for
example `4 left` stacked above `1 pending` from an opening quantity of five. Exact
cancellation releases the reservation while retaining the item link as reference
history; later mapping, correction, or clearing changes only that reference. Priced
completion converts the reservation into a completed sale without double-counting it. A
zero-stock card remains selectable, never says **Sold out**, and reports `Oversold by N`
only for inventory-affecting allocations beyond the imported quantity.

### Baseline and summary scope

Inventory accounting follows the selected stream's pinned baseline:

- `inventoryScope: "inventory_baseline"` and `inventoryBaselineId` identify that scope.
- Completed sales and pending reservations from every stream pinned to that same baseline
  share its stock. Streams pinned to another baseline cannot affect it.
- With a requested stream, auction performance and financial totals use that stream while
  its inventory availability still includes all streams sharing its baseline. Without a
  stream filter, the summary uses the active baseline and its pinned streams.
- `completedGmvCents` includes every payment-complete auction, even if it is still
  unmapped.
- `auctionCount` counts every tracked variation in the requested stream regardless of its
  payment state, including active bidding, unknown, processing, fixing, failed, canceled,
  and completed variations.
- `totalSalesCount` counts each unique requested-stream variation whose latest observed
  outcome is `payment_complete`, `payment_failed`, or `canceled`. The active bidding
  marker and `not_observed`, `payment_processing`, `payment_fixing`, and `unrecognized`
  observations do not enter this metric's terminal outcome set.
- `completedPaymentCount` counts every uniquely priced canonical payment-complete auction
  in the requested stream, whether mapped or unmapped.
- `canceledOrderCount` counts each unique requested-stream variation only when its latest
  canonical outcome is exact terminal `canceled`. Active bidding and `not_observed`,
  `payment_processing`, `payment_fixing`, legacy `payment_failed`,
  `payment_complete`, and `unrecognized` observations are excluded. Inventory mapping
  does not affect this count.
- `paymentFixingCount` counts each unique requested-stream variation whose canonical
  payment status is still `unknown` and whose latest observed status is either
  `payment_fixing` or legacy unresolved `payment_failed`.
  `payment_processing`, active bidding/`not_observed`, `unrecognized`, completed, and
  canceled variations are excluded. A priced completion or exact cancellation removes
  the variation from this count automatically. Inventory mapping does not affect it.
- `committedRevenueCents` and gross profit include only mapped, payment-complete sales.
- `profitCents = committedRevenueCents - costOfGoodsCents`; each committed cost is the
  unit-cost snapshot from the Google Sheets baseline pinned to that sale's stream.
- `unmappedCompletedCount` identifies completed sales excluded from gross profit because
  they do not yet have an inventory match. Mapping, unmapping, or remapping recalculates
  both the subtotal and this incomplete count.
- `attributedGmvDisplay` is the latest sanitized TikTok aggregate for the requested
  stream, or `null` until observed. It remains display text because TikTok may render a
  rounded compact value such as `$4.64K` instead of exact cents.

Mapping, unmapping, late payment completion, and historical corrections always resolve
the SKU and committed unit-cost snapshot through the auction stream's original pin. A
later baseline may reuse the same SKU with a different opening quantity or unit cost, but
it cannot change historical inventory or profit. A report-only unit-cost correction does
not enter reconciliation state. A stream also cannot map a SKU that exists only in a
newer baseline.

The current state stores the latest mapping and status, not a full event-by-event
employee audit log.

## 4. Dashboard capture

### Confirmed current-auction, completed-sale, and aggregate sources

The bottom card over the video is the current-bidding source. The strict locator uses
the exact `auction-pin-card` class token as a boundary and releases the positive variation
number from exactly one visible direct-own-text value beginning with `#N`. Within that same
unique card, the live-bid locator separately accepts exactly one visible direct-own-text
value matching `Bids: $...` and converts it directly to positive integer cents. Neither
path releases raw text, item title, bidder, image, or other card content. The bid is a
temporary display estimate, never payment status or final-sale truth.

The current completed-sale source is the left-side **LIVE auctions → Sold items**
panel. The right-side Chat panel mixes unrelated chat, join, and bid activity and is not
used for completed-sale parsing.

The only additional dashboard source is the isolated **LIVE analytics → Attributed GMV**
metric. It supplies one aggregate display for the active local tracker stream; it is
never used to identify a variation, payment status, buyer, item, or final row price.

A completed row exposes these values as text:

```text
Example Buyer has won: $48.00
Variation: #250
Payment complete
```

### Current capture pipeline — implemented

The extension makes its isolated content script available only on the exact
`https://shop.tiktok.com` host so it is already present when TikTok changes views without
reloading the document. Capture remains inactive on every route except
`/streamer/live/product/dashboard`.

Live inspection found one visible `[data-tid="m4b_space"]` element containing the
left-side Sold Items history. The runtime now requires exactly one visible match. Zero,
multiple, or unsafe matches stop the capture session and are retried by the lifecycle
controller; the code never falls back to scanning the dashboard body for sale data.
Consequently, the right-side Chat, analytics, and video card are outside the
**individual-sale/payment** boundary. Sold Items rows can contain incidental buyer
and product text, but capture never selects those values as fields, logs the raw row,
transmits them, or persists them. Separate narrow locators read only the on-video current
variation number and sanitized current-bid cents plus the validated aggregate USD display;
none reads Sold Items rows or supplies payment/final-price truth.

Within that root, capture:

1. finds `span` elements whose complete whitespace-normalized text matches
   `Variation: #N` and records each positive integer variation;
2. associates an exact `[data-tid="m4b_tag"]` with one row-local variation label and
   maps its whole normalized text to an allowlisted status code or `unrecognized`;
3. climbs at most 12 ancestors without crossing the Sold Items root; canonical completion
   additionally requires the parser to find the same variation and one US-dollar price;
4. performs an immediate backfill scan, then coalesces root text and child-node changes
   with a 150 ms quiet delay and a non-resetting 1-second maximum wait;
5. observes only the Sold Items root for sale changes, while route, page-resume, body,
   and root-identity checks run separately so TikTok SPA replacement can rebind capture;
6. queues variation observations before sanitized payment-status and completed-price
   updates and marks them delivered only after the worker acknowledges them; and
7. requeues transient failures with a capped backoff. A sanitized Sold Items delivery
   outbox is scoped to the current document body and survives Sold Items root replacement,
   so parsed historical prices are not discarded while worker persistence is in flight.
   Route exit or body replacement discards that outbox; a replacement root is scanned
   from scratch, and canonical persistence makes repeated scans and worker restarts
   idempotent.

The current-bidding path is independently fail-closed. It requires exactly one visible
element with the `auction-pin-card` class token and exactly one visible descendant whose
direct own text begins with a positive `#N`. Missing or ambiguous cards and variation
values are ignored rather than guessed. It performs an immediate scan, observes only
that card, and rebinds through the same route/body lifecycle when TikTok replaces it. Bid
capture additionally requires exactly one visible descendant whose direct own text is a
canonical `Bids: $...` value; missing or ambiguous bid text does not suppress the valid
variation-identity observation. Auction-card mutations are coalesced with a 75 ms quiet
delay and a non-resetting 250 ms maximum wait. Its acknowledgement-based, same-body
outboxes retain only the newest undelivered variation identity and newest complete
`(variationNumber, bidPriceCents)` pair. Identity is queued before price, and a retry for
an older price cannot overwrite a newer bid or auction.

The Attributed GMV path is independently fail-closed. It requires exactly one visible
`#guide-Step-2` root (plus the explicitly allowlisted previously observed lowercase
`#guide-step-2` spelling), exactly one element whose own normalized text is
`Attributed GMV`, and exactly one canonical USD display in that label's immediately
following primary-value region. It accepts an exact display such as `$4,087.01` or a
compact display such as `$4.64K`; generated CSS classes, the later `Auction` detail row,
ambiguous matches, and arbitrary surrounding text are excluded. Its own root-scoped
observer and bounded scheduler run independently of Sold Items, so the aggregate can be
captured while the Sold Items root is unavailable.

The aggregate path also has an acknowledgement-based, same-body delivery outbox. It
keeps only the newest undelivered display, survives replacement or temporary absence of
the metric root, and retries transient failures with capped backoff. All three scoped
capture paths discard their page-scoped outboxes when the route is exited or
`document.body` is replaced; each independently backfills a newly discovered root.

The page-to-worker protocol has exactly six event shapes:

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

The content script does not send a stream ID, raw badge or auction-card text, buyer data,
product text, observation timestamp, source HTML, or any other DOM content. The bidding
identity event contains only the current variation number; the price event contains only
that positive number and a sanitized positive integer-cent bid. The aggregate event
contains only the allowlisted display, never the label, card text, detail row, or DOM.
The content script also cannot read extension storage.
The service worker accepts these messages only from the extension's top frame on the
exact product-dashboard URL. It resolves the active `local-stream:<uuid>` itself, then
submits an `observe_variations`, `observe_bidding_variation`,
`observe_payment_statuses`, `record_payment_complete`, or `observe_attributed_gmv`
command through the same
serialized, save-before-publish reconciliation boundary used by the tagger.

If no local tracker stream is active, or active-stream/reconciliation storage cannot be
verified, no canonical capture write occurs. The content script retains the current
body's undelivered sanitized facts and retries. The latest sanitized badge status is
stored with no inventory or profit effect. An exact green completion with a parsed price upgrades that
same `(local stream ID, variation number)` record; inventory and gross profit commit only
after an employee mapping also exists. An unpriced completed badge stays provisional and
can still be followed by another observed status. A repeated event is a no-op, while a
conflicting completed price preserves the first price and records a conflict.
An Attributed GMV observation updates only that stream's latest display and is a no-op
when it repeats the already saved value.
An accepted bidding observation creates the variation if needed, makes it the stream's
single active bidding marker, and leaves payment and inventory accounting unchanged. A
mapping made during bidding is the same durable `(streamId, variationNumber)` mapping
later used by Sold Items. The first payment-status or priced-completion truth for that
variation clears the bidding marker without removing its mapping.

An accepted bidding-price observation follows a deliberately separate lightweight path.
The worker resolves the active local stream and validates the pair against a cached active
bidding marker. It then replaces one stream-scoped display record in
`chrome.storage.session`; there is no reconciliation clone/save, bid history, or
`chrome.storage.local` report data on each price change. Canonical marker changes create a
new placeholder immediately, before its first price, while marker clearing retains the
last display record until another auction begins. Stale pairs for a different active
marker are ignored. Repeating the same pair is a no-op, and the most recent accepted pair
wins even if a later bid is lower. The active marker remains the canonical identity
boundary, while Sold Items remains the only authoritative final-price source.

Capture remains read-only with respect to TikTok. It does not click controls, alter the
page, infer payment failure, or contact Google Sheets.

### Local identity, page boundaries, and diagnostic deduplication

The worker-generated local tracker stream is the current canonical partition, not a
verified TikTok room ID. The page deliberately supplies no identity. One local tracker
stream must therefore correspond to one real TikTok LIVE. Keep it active through the
expected payment transitions and delivery retries. Before the next LIVE, reload the
dashboard, verify that Sold Items no longer shows the prior stream's rows, and only then
start the next local tracker stream. Reusing rendered old rows under a new local stream
can otherwise assign them to the wrong session.

`capture/capture-event-registry.js` provides page-load and verified-stream scope interfaces
for console diagnostics and conflict warnings. It is not the persistence
authority. Canonical deduplication occurs in reconciliation storage under
`(streamId, variationNumber)`, so a full refresh can safely backfill visible rows while
the same local tracker stream remains active. Capture does not supply a verified
TikTok-provided stream identity or automatically associate the page with a local session.

### Capture events and remaining live signals

| Dashboard fact | Current action | Status |
| --- | --- | --- |
| One `#N` value appears in the unique visible on-video `auction-pin-card` | Create/activate that bidding variation under the worker-resolved stream and select it in the open tagger | Implemented; sends only the number; selecting inventory for it immediately creates a reservation |
| One canonical `Bids: $...` value appears in that same uniquely identified card | Replace the single stream-scoped transient bid and targeted-update the live panel | Implemented; sends integer cents paired with the variation; never becomes final price or report data |
| Exact `Variation: #N` appears in Sold Items | Persist an unmapped, unknown-payment auction under the active local stream | Implemented |
| Exact processing or fixing payment badge appears | Persist its sanitized observed status and update the open tagger | Implemented; a mapped unit remains pending |
| Legacy failed badge with an explicit countdown, or an unrecognized badge appears | Persist its sanitized observed status and update the open tagger | Implemented; a mapped unit remains pending until completion or cancellation |
| Exact terminal `Payment failed`, `Canceled`, or `Cancelled` appears | Persist observed and canonical cancellation, retain any item link, and release its reservation | Implemented; no sale, revenue, cost, or profit is counted |
| Exact green `Payment complete` row appears | Persist its final price as authoritative payment truth | Implemented |
| Exact `Attributed GMV` metric appears under the unique analytics boundary | Persist only its sanitized exact/compact USD display under the worker-resolved active stream | Implemented; independent of Sold Items and no aggregate-to-cents conversion |
| A bidding-identity, Sold Items, or payment update is persisted | Invalidate and refetch the open tagger's canonical view; follow a changed active bidding marker only when the employee was already viewing the current auction, while retaining a historical selection as options update | Implemented; bidding identity is not sale truth |
| A validated live bid changes | Send a separate data-free notice, read the single transient record, and update only the live panel | Implemented; no reconciliation/report write or full inventory rerender |
| Processing changes to terminal `Payment failed` or priced `Payment complete` | Persist and display the final state live | Implemented; cancellation releases allocation, while priced completion commits when mapped |
| Any payment observation follows canonical `Canceled` | Ignore the stale contradiction | Implemented; cancellation is terminal |
| A fixing/processing badge appears | Display and persist the observation | Implemented; transition order and business meaning still require live validation |

### End-of-stream report snapshot — implemented

The current report does not perform a new privileged TikTok scrape at End. It creates a
strict projection of the already durable reconciliation state after all worker commands
ordered ahead of End have completed. The snapshot receives a
deterministic `stream-report:<uuid>` identity derived from its exact
`local-stream:<uuid>`, UTC start/end/generated timestamps, the pinned baseline ID, and
the last active-bidding marker. No buyer, Sheet ID, sharing link, token, or raw DOM text
enters the report.

Normal **End and create report** is one serialized lifecycle operation:

1. verify that the expected local stream is still active;
2. hydrate canonical reconciliation state and prepare the strict report;
3. durably save a `pending_end` report record before clearing the active-session pointer;
4. end that exact local stream; and
5. mark the same report record `finalized`.

The End confirmation offers **Keep stream active** and **End and create report** as
two full-width actions. If preparation or persistence fails, report-aware End fails
closed and leaves the stream active; resolve the error and retry the same report-saving
operation. A worker restart repairs a
`pending_end` record: it finalizes it when the matching stream is no longer active and
keeps it pending when the stream still exists. One stream has at most one report.

Business exceptions never block report creation. The strict report retains its internal
`completeness.status` (`final` or `provisional`) and stable reason codes: only a snapshot
with no active bidding marker, unresolved order, pending inventory reservation,
payment-error order, unmapped completed sale, reconciliation conflict, or oversold SKU
requiring recount receives the former value. The employee UI deliberately does not render
either state word or a completeness badge; it presents the specific attention notices and
End-readiness counts instead. Lifecycle `pending_end` remains internal recovery state.
These fields describe captured-data completeness; they do not claim that TikTok rendered
every historical Sold Items row.

The report retains these deliberately different measures:

- `completedGmvCents`: exact captured prices for all uniquely priced completed orders,
  mapped or unmapped, labeled **Gross Item Sales**;
- **AOV**, derived at presentation time as
  `round(completedGmvCents / completedPaymentCount)` cents, using the same uniquely priced
  current-stream completions as the completed-sales numerator. It includes mapped and
  unmapped completions; bidding, processing, fixing/temporary-failed, price-less, and
  canceled orders contribute to neither operand. A zero completion count renders `$0.00`
  rather than dividing by zero;
- `attributedGmvDisplay`: TikTok's last exact or compact display, labeled **TikTok
  Attributed GMV**, retained as text because it may be rounded and include buyer-paid
  shipping;
- **TikTok 6% Fees**, derived when the report is rendered from the frozen
  `attributedGmvDisplay`: **Fees paid:** is `Total GMV * 0.06` and **GMV after fees:** is
  `Total GMV * 0.94`. Both outputs are always prefixed by `≈` and rounded to the nearest
  whole dollar. Exact displays use their captured amount; compact displays use only the
  displayed magnitude, and a missing aggregate produces an em dash for both outputs. The
  figures are informational estimates, not stored accounting totals or net revenue;
- **Est. Profit After Fees**, derived at presentation time as
  94% of the parsed `attributedGmvDisplay` amount minus `costOfGoodsCents`. The 94% result
  stays unrounded until exact cent-based mapped completed COGS is subtracted, then the signed result is marked
  approximate and rounded to the nearest whole dollar. Missing GMV produces an em dash,
  and `unmappedCompletedCount` produces an explicit incomplete warning. Bidding,
  processing, fixing/temporary-failed, canceled, and unmapped completed orders add no
  unit cost. This is not a stored accounting total or true net profit;
- `completedPaymentCount/totalSalesCount`: completed orders over terminal-outcome sales,
  excluding the active bidding marker and nonterminal processing/fixing states;
- terminal canceled and still-fixing counts;
- `costOfGoodsCents` and `grossProfitCents` only for mapped completed sales, where gross
  profit is mapped revenue minus the unit costs saved in that report;
- completed-sale detail rows that retain unmapped completions with unavailable item/cost
  fields instead of hiding them; and
- an optional canceled-order detail collection retaining each canceled variation's mapped
  or unmapped reference SKU/item/style/size. Compatible legacy reports retain their
  aggregate canceled count but may not contain these row details.

The report page combines the completed-sale rows and available canceled-order references
in one collapsed **Item variations this stream** disclosure under the **Stream variations**
eyebrow. Its count is completed plus canceled variations, including legacy aggregate
cancellations whose row details are unavailable, and a **Status** column distinguishes the
two outcomes. Canceled rows expose reference identity only: sold price, unit cost, and
gross profit are unavailable, and the rows do not contribute to inventory or any metric.
Browser Print / Save as PDF temporarily expands the stream-variations and canceled-order
disclosures so all available rows print, then restores their independent screen states.
The report button and native browser print shortcuts share beforeprint/afterprint handling;
canceling or failing to open the print dialog does not leave the sections expanded.

A separate, initially collapsed **Canceled orders** disclosure directly below Stream
variations filters the same saved `canceledOrders` collection into six reference-only
columns: Variation, Status, SKU, Item, Style, and Size. Rows are sorted by variation
number, and use the same safe-text rendering and unmapped fallbacks as the combined
table, which remains unchanged. Above those details, a four-column summary shows
**SKU, Item, Style, Canceled**, grouping only the saved canceled-order references by
exact SKU. Each unique canceled variation contributes one count; saved report validation
already rejects duplicate variation numbers. SKU ordering is deterministic, with one
**Unmapped / Not selected / —** group last only when needed. Saved item/style text is
preserved, including blank styles; size-specific SKUs are never merged by product name.
The summary is hidden when no detail rows exist, including legacy reports; unavailable
historical detail is not treated as unmapped. The disclosure's header count retains legacy
aggregate cancellations;
missing legacy details produce a notice, never invented rows. Zero cancellations show
an empty-state message. Report refreshes after payment or mapping corrections update
both tables without resetting either disclosure's open state. Direct downloaded PDFs include
the combined variation table, the per-SKU cancellation summary when available, and the
six-column canceled-only table in that order,
independent of on-screen expansion. Both disclosures start collapsed on screen. This is presentation
only and adds no report schema, storage, accounting, or inventory-export changes.

Exact-SKU performance groups mapped completions by SKU, includes only mapped SKUs with
completed sales in that report stream, and sorts rows from highest gross profit to largest
loss. Its final **Gross profit/loss** column uses signed values with distinct green, red,
and neutral presentation for positive, negative, and zero results. Pending, canceled,
unmapped, and unsold entries are excluded. Combined product performance groups those same
SKU totals by exact employee-facing `item + style` across sizes. Both retain sold quantity,
revenue, COGS, and gross profit; top-sold and top-profitable results retain every tie. The
report page derives SKU gross margin as gross profit divided by mapped revenue, average
sale price as mapped completed-sale revenue divided by mapped completed units and rounded
to the nearest cent, and sell-through as current-stream mapped completed units divided by
that SKU's opening quantity, with the displayed rate capped at 100%. Oversold counts and
recount warnings remain uncapped.

The baseline-wide inventory handoff contains every pinned-baseline SKU with opening
quantity, current-stream sold quantity, all completed sales under the shared baseline,
pending reservations, signed calculated remaining quantity, available-after-reservation
quantity, oversold amount, and recount flag. The Sheet replacement value is:

```text
calculatedRemainingQuantity = openingQuantity - baselineSoldQuantity
replacementQuantity = max(0, calculatedRemainingQuantity)
```

Pending is intentionally separate and does not permanently reduce the replacement
value. When calculated inventory is negative, the report preserves that raw value and
oversold/recount warning while exporting zero. The on-screen/printed inventory table also
shows the saved unit cost for every SKU. Its short visible `Sold` header has the accessible
meaning "Sold since inventory baseline" and represents baseline-wide completed mapped
sales. Narrow screens keep the full table in a horizontal scroll region; print removes
that screen minimum width so all columns can fit the page. The retained Sheet handoff is
still a complete six-column table with the original `sku,item,style,size,unit_cost` plus
the replacement count under `quantity_on_hand_at_import`. CSV and tab-separated clipboard
serializers neutralize spreadsheet-formula prefixes while preserving valid Sheet values.

The extension-owned report page initially loads only the local saved record. It supports native
Chrome Print / Save as PDF and a Google Sheets-ready six-column CSV download. The
**Copy Updated Inventory** button now opens/closes the screen-only quantity handoff
form; it does not immediately copy or read a Sheet. **Check Sheet** explicitly reads
the chosen Sheet through the worker and the subsequent **Copy quantities** action builds
a single-column clipboard handoff in its current physical row order. It retains blank
spacers and reports the quantity-column starting cell for one values-only paste, leaving
other columns outside the operation. **Other options** opens a compact button group
with the unchanged six-column CSV download and **Copy Inventory No Formatting**, which
uses the existing full-table TSV clipboard helper for pasting at A1. Opening the group
does no I/O; Escape/outside click/actions close it. Hidden or busy actions are guarded,
and both clipboard paths share the report-edit/copy lock to prevent overlapping writes.
The redundant quantity dropdown heading and full-table explanation were removed.
The three screen-only correction sections have
different authority boundaries.
**Finish unresolved payments** exposes canonical-unresolved `payment_processing`,
`order_processing`, `payment_fixing`, or legacy `payment_failed` orders. Newly captured
terminal failures are canceled and excluded. Cancellation needs no price and releases the
reservation; completion requires a seller-verified positive final price and commits the
mapped unit. This canonical payment correction remains limited to the newest eligible
report while no tracker stream is active and its baseline/stream are still current.
**Correct Item Mapping** changes completed/canceled variation mappings only in the
selected finalized report. It requires no active tracker, no active bidding variation,
no unresolved payments or pending reservations, and at least one editable variation.
Unlike canonical payment correction, it is not restricted to the newest report. It
recalculates that report and its inventory handoff without changing canonical inventory,
other reports, or future streams.
**Correct SKU Unit Cost** is available on every finalized current or archived report. It
lists every SKU saved in that report's inventory, including unsold SKUs, accepts exact
nonnegative integer-cent costs, and requires confirmation. The worker replaces only that
same saved report while preserving its report/stream identity, timestamps, baseline
reference, lifecycle, and archive tier. Cost correction updates
completed-sale costs/profits, COGS, gross profit, margins, estimated profit after fees,
top-profit rankings, exact-SKU/product totals, and the six-column handoff; it does not
change payment facts, prices, quantities, GMV, AOV, fee estimates, canonical inventory,
other reports, the live tracker, or future streams. The stream-variations and canceled-order
disclosures start collapsed on screen. Printing temporarily expands both, includes all
their available rows, and restores the previous screen states afterward. The SKU performance table is part of the normal screen
and printed report output, and printed tables retain repeated column headers. The
screen-only unit-cost correction disclosure is the final report section. These are
employee-initiated local outputs, not Google API writes.

The seller reports that completed rows remain scrollable during a stream, but broader
live testing must still determine whether the entire list is always rendered or
virtualized. No underlying TikTok API or network payload has been selected. The current
capture can only report facts that reached durable reconciliation state before End.

## 5. Employee tagger — Live session implemented

The tagger is a Chrome side-panel interface. The employee can browse variations in the
dropdown or find an existing captured/preset number with **Var #**, and selects inventory
through item cards and exact-size choices rather than typing a hidden SKU.
The adjacent **‹ / ›** buttons select the nearest lower/higher existing number through
the same selection workflow. They include assigned and empty future presets, skip missing
numbers, and never wrap, extend a range, or change assignments. No selected entry or no
neighbor disables the relevant arrow. Current capture/preset/save/session safeguards
apply to both rendering and click handling. The row and badge center stay fixed; only
the Var # field's width/inset compress when needed to fit the arrows at narrow widths.

The Chrome side panel is a single **Live session** employee workspace. It requires a
persistent local active stream, restores the last durable reconciliation state, persists
mapping corrections, and displays loading, saving, success, and retryable error states.

Before Start, Live session presents Google Sheets inventory import followed by the local
Start controls. Once a stream is started or resumed, the logo/title header is hidden and
the compact capture-health row sits above the Variation selector. Inventory and
Performance Metrics use single-line section headings. The Local stream session section
is the last substantive section and shows a small status dot plus
`Tracker Active | Started [formatted session start]`, followed by **End Stream Tracking**.
The active view has no separate Active pill, persistence explanation, or restored-data
footer. Setup and Resume/End-only screens retain their lifecycle context. Genuine
save/error status remains available; removing routine footer text does not suppress it.
After End, the inactive side panel shows up to five recent reports under
**STREAM REPORT RECORDS**. Each record
shows its tracking-start timestamp as the default name, completed/total sales, and exact Gross Item Sales,
then opens the
same extension report page in a new tab. **View archived reports** switches to a managed
archive of up to 25 additional records; archived records remain openable and therefore
retain the report page's PDF and inventory-download actions. **Back to Business Records**
returns to the five current slots. Report-list Retry refetches the canonical library; the
panel does not read `chrome.storage` directly.

Each current record's **More actions** menu offers Download PDF, Rename, Archive, and
Delete. Delete uses the same separate permanent-delete confirmation as archived reports;
no intermediate archive operation is required. The compact dialog contains only its
**Delete report forever?** title (including the count for multiple reports) and **Cancel** /
**Delete forever** buttons. It has no warning paragraph; cancellation, focus restoration,
busy safeguards, and the recent/archived deletion routes remain unchanged.
Renaming changes neither the canonical report snapshot nor
its immutable report/stream IDs; the display name survives reload, archive, restore, and
report-only corrections. The report cover shows that name (or the tracking-start timestamp fallback),
while its footer retains the stream reference. Archived
selection mode supports Select/Select all/Clear selection, atomic **Restore selected**
into currently available recent-report slots, and **Delete selected** behind an
explicit permanent-delete confirmation. Restore rejects the entire selection when it is
larger than the available slot count. Archive deletion applies only to archived records;
canceling confirmation or any failed worker command changes nothing.

Direct PDF export is a read-only side-panel workflow. `report/report-downloads.js`
snapshots IDs, loads all records through the existing report client, normalizes and
sanitizes final filenames, then rejects the whole batch on case-insensitive collisions.
`report/report-pdf.js` reuses report-page presentation and summary calculations to
render a local, selectable-text PDF with bundled jsPDF/AutoTable and embedded DejaVu Sans.
All printed tables are included in direct exports, with repeated headings and no editing
controls. Browser print temporarily expands both variation disclosures and restores their
on-screen state after printing or canceling.
The report page's document title uses the saved display name and the shared direct-PDF
filename sanitizer (without the `.pdf` suffix), so Chrome's Save as PDF suggests the
same base filename. Initial renders and confirmed renames update the title; unsaved
drafts, failed saves, and stale rename responses cannot replace it. The report button
still waits for name persistence before printing. Default names retain the tracking-start
fallback; inventory CSV filenames remain timestamp-based.
Dependency versions, official sources, hashes, and licenses are in `extension/vendor/`.
Unsupported font glyphs cause a visible per-report failure rather than dropped content.

The `downloads` permission is used only to create PDF downloads, watch their terminal
events, and query each newly created download by its own ID to cover event races.
`conflictAction: "uniquify"` protects existing disk files; it does not bypass the earlier
within-batch collision rejection. Each file must reach Chrome's `complete` state before
it is counted as downloaded. Load/preflight failure prevents all downloads; per-file
generation/start/interruption failures are reported individually and the remaining files
continue. Concurrent clicks in the panel are rejected, and report mutations in that
panel are disabled until export finishes. Selection changes do not alter the snapshot.
Keep that panel open for the job: this is not a background queue and does not resume
after closing/reloading it. No storage writes, export-state schema, data migration,
automatic deletion, or report-limit changes are introduced. PDFs are not restorable
backups. All downloads and font loading remain local to the extension.

Shared tagger behavior includes:

- An accessible, select-only variation combobox controlling a top-layer listbox of
  canonical stream records from the current-bidding and Sold Items paths. Each option is
  formatted `#N - <payment state> - <selected item or no selection>` with separate
  visual segments and one complete accessible label. Bidding, processing, fixing, and
  temporary failure use the warning tone; cancellation uses danger; completion uses
  success; and other payment states remain neutral. In this control only, processing and
  completion are shortened to `processing` and `complete`. The item segment uses success whenever
  an item is selected, including for a canceled reference, and displays `no selection` in
  orange otherwise.
  These tones supplement the visible wording and accessible label rather than replacing it.
- Pointer, Enter/Space, F4, arrows, Home/End, Page Up/Page Down, Escape, and Tab behavior is
  implemented without making individual options extra tab stops. The fixed top-layer
  listbox aligns to the trigger, chooses above or below based on available space, remains
  within the viewport, and provides contained vertical scrolling for long histories.
- Stable variation identity with automatic selection of the next active bidding marker
  while the employee is following the current auction. A manually selected historical
  variation stays selected while newer markers and status changes continue being captured.
  While the listbox is open, only its visible option view and scroll position are frozen;
  the latest requested view replaces any older deferred view and is applied once on close.
- Responsive, employee-facing inventory cards using the stream's pinned Google Sheets
  inventory baseline. Rows with the same normalized item and style form one presentation
  card even when size quantities or unit costs differ. A singleton preserves direct click
  behavior. A multi-size card initially renders **Choose size**, then renders only the
  preferred exact size label after selection; its top-layer listbox orders numeric sizes
  naturally and shows every option's SKU, stock, and Selected/Live/Queued roles.
- A compact **Add new SKUs from updated Sheet** action that appears only in a
  loaded active workspace. It accepts the same Sheet link/ID, reads `Inventory!A:F`, and
  adds only new SKU identities. The form alone is busy during the request; capture and
  the rest of the live workspace remain active.
- Search across item, style, size, and SKU. Search operates on complete presentation
  groups, so a match in one underlying row keeps every size available in that card.
- Engine-derived remaining, pending, available, and oversold states. A grouped card
  aggregates those quantities across its size rows, while each listbox option preserves
  the exact size-level stock display. Mapping during bidding shows a pending reservation
  until completion or cancellation. Zero-stock sizes remain enabled and show `Oversold
  by N` when over-allocated.
- Direct mapping and correction of a singleton, or exact-size mapping and correction from
  a multi-size list, on the selected current or previous variation. Choosing the exact
  selected SKU again removes that mapping; choosing another size remaps to its SKU.
- One stream-scoped next-item queue driven by inventory-card `contextmenu` input. For a
  multi-size card, right-click opens the same frozen size list in context-action mode and
  the following left-click chooses the exact SKU. On the current/newest variation, that
  SKU maps current when it is unmapped; once current has any mapping, it toggles exactly
  one queued SKU and never changes that mapping. While a historical variation is
  displayed, the distinct right-click path maps or remaps the worker-verified
  current/newest variation and cannot mutate the queue; choosing its existing SKU unmaps
  that current variation. Ordinary left-click continues to map or unmap only the
  displayed captured variation; uncaptured preset gestures are described separately below.
  Historical selection, the mapped current/newest variation, and a
  pre-existing queue are exposed independently through green, blue, and red card-outline
  roles, including combined outlines when different sizes in one card have multiple
  roles. Exact option badges disambiguate those sizes.
- A separate visible **TikTok payment** row for processing, fixing, failed, canceled,
  complete, unrecognized, or not-yet-observed state, independent of the **Inventory tag**
  row.
- A canceled result that keeps its item reference visible, reports that its reservation
  was released and stock stayed unchanged, and keeps every inventory card interactive so
  the employee can map, correct, or clear that reference without affecting accounting.
- A **Payment complete - item needed** exception when shared state receives payment before
  the employee mapping; choosing an item immediately commits that sale.
- A compact, permanently reserved sale-results grid that prevents inventory-list layout
  shifts: unavailable values render as dashes, the final price appears when captured,
  mapped unit cost and remaining inventory appear when an item is assigned, and gross
  profit/loss appears after both the final price and committed cost are known.
- A bottom **Metrics** section labels `totals.completedGmvCents` as **Gross Item Sales**:
  the stream-scoped sum of sold prices from priced `Payment complete` records, whether
  mapped or unmapped. An **AOV** card derives
  `round(totals.completedGmvCents / totals.completedPaymentCount)` cents, so it uses that
  same stream-scoped set of uniquely priced completions, remains independent of inventory
  mapping, and renders `$0.00` when the completion count is zero. Bidding, processing,
  fixing/temporary-failed, price-less, and canceled orders are excluded. A separate
  **Total GMV** card mirrors TikTok's captured
  `totals.attributedGmvDisplay`, which includes buyer-paid shipping. The two values remain
  distinct rather than estimating shipping from their difference; compact dashboard text
  such as `$4.64K` remains compact instead of being presented as an exact cent value. A
  combined **TikTok 6% Fees** card parses that same display only for two presentation-time
  estimates: **Fees paid:** is 6% and **GMV after fees:** is 94%. Both render with `≈` and
  nearest-whole-dollar rounding, whether the source display was exact or compact. A
  missing Total GMV renders an em dash for each line. These figures do not account for
  refunds, discounts, taxes, shipping treatment, other TikTok fees, or seller expenses,
  and never feed sales, COGS, gross profit, or inventory. An **Est. Profit After Fees**
  card uses the same parsed Total GMV but keeps its 94% amount unrounded until subtracting
  `totals.costOfGoodsCents` for mapped completed sales, then displays the signed result as
  an approximate whole dollar. It shows an em dash without Total GMV and an explicit
  incomplete-sale count while `totals.unmappedCompletedCount` is nonzero. Bidding,
  processing, fixing/temporary-failed, canceled, and unmapped completed orders add no
  COGS. The estimate excludes refunds, discounts, taxes, shipping expenses, advertising,
  labor, other platform charges, and other business costs, so it is not true net profit.
  A
  **Completed Sales/Total Sales** card renders
  `totals.completedPaymentCount/totals.totalSalesCount`. The numerator counts each uniquely
  priced canonical completion whether mapped or unmapped. The denominator counts unique
  current-stream variations whose latest observed outcome is `payment_complete`,
  `payment_failed`, or `canceled`; active bidding and `not_observed`, processing, fixing,
  or unrecognized observations are excluded. One compact order-status card renders
  `totals.canceledOrderCount` beside **Canceled Orders:** and
  `totals.paymentFixingCount` beside **Payment Errors:**. The canceled count includes a
  unique current-stream variation only after captured terminal cancellation; active bidding,
  `not_observed`, processing, fixing, temporary failed, completed, and unrecognized
  variations are excluded. The payment-error count includes canonical-unresolved
  variations whose latest observation is `payment_fixing` or legacy `payment_failed`;
  processing, bidding/`not_observed`, unrecognized, completed, and canceled variations are
  excluded. Completion or cancellation clears the payment-error count automatically, and
  neither value depends on inventory mapping. A **Gross Profits** card
  renders `totals.profitCents`: mapped, completed sold-price revenue
  minus the committed Google Sheets unit-cost snapshots. Completed-but-unmapped sales are
  excluded and trigger a visible incomplete-count warning until inventory items are
  assigned. Historical unmapping, mapping, and remapping recalculate the subtotal and
  warning immediately. This basic figure excludes shipping, platform fees, taxes,
  discounts, refunds, and other expenses.
- Unmapping that releases pending reservations and returns
  a completed sale to the item-needed exception without changing its payment status or Gross Item Sales contribution.
- Mapping correction after completion, applied atomically by restoring the old SKU,
  decrementing the new SKU, and recalculating committed cost and profit.
- An inventory warning when a truthful historical correction produces negative stock.
- Every inventory entry remains selectable for bidding, pending, completed, and canceled
  orders, including at zero availability. A correction or new inventory allocation that
  exceeds stock produces an `Oversold by N` warning; a canceled reference mapping cannot
  create or change that warning.
- Accessible buttons, keyboard search controls, and a no-results state.

The Live session requires a persistent local tracker stream and an imported inventory
baseline. Before Start, the side panel asks the worker for import readiness. The Start
control remains unavailable until a confirmed active baseline has a nonempty Sheet
fingerprint, and the worker independently enforces the same requirement before creating
and durably saving a `local-stream:<uuid>` identity. It then pins that stream to the
baseline.

Reopening the panel offers Resume for the same identity; the worker verifies or repairs
its missing baseline association before returning the active session. Capture also
verifies that association before recording a fact. It cannot be changed arbitrarily.
The one exception is a worker-owned append-only operation: it requires the current
active stream and expected active baseline, validates a full exact superset, creates a
derived immutable snapshot, and advances every stream sharing the previous snapshot so
committed and reserved inventory remain continuous. Compatibility remains deliberately
narrow: an already-active legacy session may resume with its existing baseline, and a
fixed legacy recovery baseline is used only to repair a previously active legacy session whose
reconciliation record is truly absent. That recovery path cannot seed a new stream or
replace non-null canonical state.

End first freezes and durably archives the report described above, then clears only the
active-session pointer and finalizes the same report record. It does not delete the
stream, its pin, baselines, or reconciliation history, and it does not start or end
TikTok LIVE. Creating or activating a recount baseline is blocked while any local tracker
stream is active, so a session cannot cross a physical-count boundary. Adding brand-new
SKUs through the strict append-only action stays inside that same boundary. End is available for a
known active local stream, including before the inventory workspace is resumed and while
pending reservations or completed sales without items remain unresolved; those states
are retained as attention notices rather than blockers. If report persistence itself
fails, the normal action preserves the active stream and offers Retry without bypassing
report creation.
Saved-report management remains hidden during an active session. Check capacity before
Start: a capacity failure at End currently requires separate recovery/support to free
space, since Retry alone cannot reduce library usage.

Ended streams cannot be reopened in the tagger. The guarded payment-buffer correction is
limited to the newest safe report; report-only SKU-cost correction is available on any
finalized current or archived report.
Employees should finish mapping corrections and wait for expected capture retries when
practical. Report links appear after End and open the local printable page; no automatic
Google Sheet write occurs.

Every genuine tracker entry requests one viewport reset scoped to the current stream
and mounted controller. `setTrackerWorkspaceVisible` arms it only on a valid hidden-to-visible
transition: Start, Resume, remount, or recovery from an initial load that left the tracker
hidden. After the first successful workspace render, `restoreTrackerEntryViewport` focuses
the named tracker region with `preventScroll` and scrolls to the top immediately. It can
arm before the old root loading lock clears, but waits for ready, non-busy rendering before
scrolling. Connecting child controls remain locked except for the separate preset-planning
override or 1.3-second blue planning delay. Yellow Loading is a strict editing lock;
entry itself does not unlock either state.

Start and Resume no longer use the bottom session-status focus fallback or button-specific
viewport callbacks. A genuine entry also suppresses that fallback from an initial-load Retry.
The request is consumed before scrolling and canceled on hiding, errors, controller/session
changes, unmount, End confirmation, archive navigation, or page disposal. It is not armed
while showing an error or End confirmation. Repeated visible renders, delayed Start replies,
capture/readiness updates, and in-place refresh recovery do not schedule another reset.
Retry focus behavior is otherwise unchanged when the tracker was already visible.

The selector lists persisted variations for the active local stream together with any
uncaptured future presets. Actual mapping requires a captured variation; before the first
capture, future-preset assignment remains available as planning only once the existing
session/inventory safeguards permit it, including an explicit planning opt-in during
capture startup. Presets never turn the controller's
internal unrecorded startup placeholder into a real auction. Without intentional preset
browsing, the first canonical view selects the newest recorded variation. A non-null
`activeBiddingVariationNumber` is the effective current
variation. A changed marker takes focus only when the employee was already viewing the
previous current/latest variation. If the employee manually selects history, new
variations and status changes continue updating the closed combobox without taking focus;
the compact **Return to live item** action appears while history or a future preset is
selected, but only after at least one actual variation has been captured. It targets
the active bidding variation when present and otherwise the newest captured variation;
returning through it resumes automatic follow.
Selection navigation itself is local UI state and does not write to storage.

Capture adds the on-video bidding marker, Sold Items variations, sanitized payment
states, and completed prices to
durable reconciliation state under the worker-generated local stream ID. Once a capture
write succeeds, its data-free
invalidation causes an open Live session panel to refetch and render that canonical
record. The employee does not need to refresh TikTok, reopen the panel, or Resume again.
The panel calls only the persisted on-video marker the current bidding auction. It
auto-follows the next marker while the employee is viewing the current auction so the
item can be mapped before the sale reaches Sold Items. A historical selection remains
fixed while the combobox continues receiving newer variations. Opening its listbox locks
only the rendered options: canonical capture and saves continue, repeated refreshes retain
only the newest deferred view, and selecting or dismissing applies that view once before
normal rendering resumes. An open inventory size list likewise freezes its visible
options and card render during canonical or queue refresh; closing it applies the latest
deferred inventory view once. Its action target is pinned to the stream and selected/current
variation numbers present when it opened; if one changes before commit, the action is
rejected and the refreshed card must be reopened. The local ID remains distinct from a
verified TikTok room ID.

The compact capture-health files now implement startup readiness separately from
durable session/accounting state. A validated version-2 channel reports initial
core capture loading/ready/blank, scoped to a stream and browser document. Initial
Sold Items/bidding work must finish, but GMV is optional. Ready latches indefinitely;
later metric glitches, delivery activity, missing communication, or disconnections
do not demote green. A new session or actual new dashboard document resets startup.

Content stops health sampling and duplicate pulses after ready; context checks and
panel reads remain solely for session/document discovery and startup communication.
Strict sender, context, sequence, and request-age checks remain. No red badge,
auto-hide timer, all-path health test, or ongoing degradation threshold remains.
No readiness message writes business data or acknowledges a capture event. See
[startup-readiness rules](capture-development.md#capture-health-indicator).
Green means startup completed, not current connection or complete order capture.
The internal blank startup state displays a neutral, noninteractive **Reload Site**
disclaimer in the same badge slot; it does not automatically reload the dashboard.
The active badge's accessible description appears as a centered hover tooltip below the
badge instead of a cursor-positioned native title. Other phases retain their native
titles. The tooltip adds no layout height, focus target, or capture/interaction behavior.

The combobox updates from durable capture state and supports multi-variation navigation
and correction. It does not prioritize records needing attention. The isolated aggregate
analytics metric remains display-only and never prioritizes or identifies a sale.

## 6. Storage and sync — tagger and capture persistence integrated

### Browser storage

`extension/shared/reconciliation-storage.js` implements the first persistence layer. It
stores one reconciliation snapshot beneath the stable key
`tiktokLiveTracker.reconciliation` using this versioned envelope:

```text
{
  schemaVersion: 1,
  reconciliationState: {
  version: 7,
    activeInventoryBaselineId: "inventory-baseline:<uuid>",
    inventoryBaselines: [{
      baselineId: "inventory-baseline:<uuid>",
      sourceFingerprint: "fnv1a64:<fingerprint>" | null,
      inventory: [{
        sku,
        item,
        style,
        size,
        quantityOnHandAtImport,
        unitCostCents
      }]
    }],
    streams: [{
      streamId,
      inventoryBaselineId,
      attributedGmvDisplay: null | "$4.64K",
      activeBiddingVariationNumber: null | 252,
      variations
    }]
  }
}
```

The storage-envelope version is separate from the reconciliation-state version so each
can evolve deliberately. The adapter validates and detaches state before every write,
hydrates and validates every read, returns `null` only when the key is truly absent, and
reports malformed, unsupported, or failed reads and writes as typed errors. It never
silently clears or replaces corrupt or future-version data.

Reconciliation state is version 7. Report-only unit-cost correction does not alter this
state and requires neither a state-version migration nor a report-version migration. The
outer storage envelope deliberately remains schema version 1. Version 4 replaced the mutable top-level inventory array with an
append-only `inventoryBaselines` collection, an active-baseline pointer for future
streams, and an `inventoryBaselineId` association on every stream. The append-only live
inventory operation can advance a whole shared cohort to a derived immutable snapshot
without changing the persisted schema. Version 5 adds the
nullable, sanitized `attributedGmvDisplay` field to each stream. Version 6 adds the
nullable `activeBiddingVariationNumber`, which must reference a variation in the same
stream. Version 7 removes persisted manual unpaid decisions from the Live lifecycle.

Strict version-1 through version-6 snapshots are migrated in memory to detached
version-7 state. Version-1 through version-3 legacy `inventory` becomes one
deterministic baseline with `sourceFingerprint: null`; `name` becomes `item`, `style` is
blank, and `quantityReceived` becomes `quantityOnHandAtImport`. Every legacy stream is pinned to
that baseline. Payment migrations still infer version-1 observed status and promote an
exact version-2 observed `canceled` value to canonical cancellation. A valid version-4
baseline snapshot keeps its existing baseline pins and receives
`attributedGmvDisplay: null` on every stream. A valid version-5 snapshot retains its GMV
display and receives `activeBiddingVariationNumber: null`. During every version-1 through
version-6 migration, `mappingStatus: "marked_unpaid"` becomes `mapped` when the order has
a SKU or `unmapped` otherwise. Its canonical payment remains unresolved, so automatic
TikTok tracking and any mapped reservation resume without the removed manual Undo action.
Versions 3 through 6 could also contain the former
`payment_completed_after_canceled` conflict. Migration repairs that contradiction to
canonical terminal cancellation, clears its stale completed price and cost allocation,
and retains any SKU only as canceled reference history. Canonical version 7 rejects that
legacy conflict. Dangling bidding markers,
baseline, SKU, and committed-cost
relationships, malformed legacy data, and future versions all fail closed. The next real
mutation persists version 7 without changing the envelope.

Active-stream lifecycle is deliberately stored separately beneath
`tiktokLiveTracker.streamSession`:

```text
{
  schemaVersion: 1,
  sessionState: {
    version: 1,
    activeSession: null | {
      streamId: "local-stream:<uuid>",
      startedAt: "<UTC ISO timestamp>",
      identitySource: "local_session"
    }
  }
}
```

Keeping this pointer outside reconciliation state avoids coupling stream lifecycle to
auction-state migrations. Missing active-session storage means no tracker stream is
active; malformed or future data fails closed and is never replaced automatically.

End-of-stream reports use a third strict local envelope beneath
`tiktokLiveTracker.streamReports`:

```text
{
  schemaVersion: 3,
  records: [{
    reportId: "stream-report:<uuid>",
    lifecycleStatus: "pending_end" | "finalized",
    archived: true | false,
    displayName?: "optional employee-assigned title",
    report: { version: 1, ...strict frozen projection }
  }]
}
```

The store hydrates and validates the complete nested report, verifies that wrapper and
report identities agree, detaches every read/write, and never replaces malformed or
future data. Version-1 records migrate as non-archived records; version-2 records retain
their archive tier; both migrate to version 3 without inventing a custom display name.
Unknown future versions still fail closed.

Finalized reports remain immutable through the general report coordinator API. Narrow
internal replacement paths support post-End payment-buffer resolution and report-only
SKU unit-cost correction. Payment resolution retains its newest-report, inactive-tracker,
current-baseline, and last-canonical-stream guards because it mutates reconciliation
state. Unit-cost correction instead accepts any finalized current or archived report,
validates and reprices only the selected report's self-contained rows, and never consults
or mutates reconciliation state. Identical retries are idempotent; contradictory payment
outcomes fail closed. Replacement preserves whether the report is in the recent or
archived tier. Report renaming is a separate recent-report mutation on the
saved wrapper, so it cannot change calculations, exports, or report identity.

The finalized library has two tiers under a combined cap of approximately 4 MiB: no more
than five non-archived recent reports under **STREAM REPORT RECORDS** and no more than
25 archived records, with 30 total records. At most one non-archived `pending_end`
record temporarily stages the
report-aware End transaction. It is hidden from both employee lists, is never eligible for archive/restore/deletion,
does not consume one of the five finalized recent-report slots, and still counts
toward the total-record and byte caps. A small fixed allowance lets a valid near-cap
version-1 envelope acquire archive fields and reserves bounded room for optional report
names without data loss while keeping the effective enforced ceiling approximately 4 MiB.
The pre-stream capacity warning combines remaining total-record slots with actual UTF-8
JSON envelope bytes. Its read-only `get_library_capacity` command returns validated
`usedBytes`, `maxBytes`, `totalReports`, and `maxReports`, including staged pending records.
Measurement shares the save guard's envelope helper and exact `MAX_ARCHIVE_BYTES`, not a
rounded 4 MiB estimate or Chrome's total storage usage. Capacity inspection does not
repair pending reports or persist legacy migrations. The coordinator caches usage for
loaded records until a successful save changes them.

The side panel requests usage alongside its existing report lists, discards superseded
responses, and refreshes after worker report-mutation notifications without polling.
Missing or failed metadata uses the report-loading error path, never a zero-usage
fallback. Yellow starts at 80% used, red at 90%; three or fewer slots also warn red.
Combined warnings show both values, while either exhausted limit shows the full-library
message. Thresholds use unrounded usage and displayed percentages round down. The
compact, keyboard-accessible bubble remains beside View archived reports before Start,
not in the active tracker. It adds no Start restriction or automatic deletion. Even
below 80%, a large next report can exceed remaining capacity; the existing End-time save
guard remains authoritative.

The manifest requests `unlimitedStorage` to remove Chrome's normal
[`chrome.storage.local` quota](https://developer.chrome.com/docs/extensions/reference/api/storage#property-local)
for the extension's persisted data. The five-current/25-archived report limits and
`MAX_ARCHIVE_BYTES` remain application-enforced, independent of that permission.
This permission-only safeguard does not introduce a storage-schema change, migration,
pruning, or deletion. It also does not bound reconciliation history, eliminate the cost
of processing and saving that history, or prevent disk/resource failures.

Finalizing what would be a sixth
recent report atomically moves the oldest finalized recent report into archive when
capacity permits. Equal end times use report identity as the stable tie-break.

There is no automatic report deletion. If the archive already contains 25 reports, the
combined byte cap is reached, or no finalized current record can move, preparation fails
before the active stream is cleared and leaves every record intact. Manual archive,
multi-report restore, and permanent deletion are serialized worker operations.
Archive and restore are all-or-none; restore additionally rejects a selection larger
than the available recent-report slots. The `delete_reports` command accepts finalized
current or archived records; `delete_archived_reports` retains its archive-only guard.
Both reject pending recovery records and persist the complete selection atomically.
Deletion requires the separate employee confirmation in the panel. Clearing extension
storage or uninstalling the extension still deletes the complete in-extension library.
A PDF or CSV explicitly saved outside the extension is not part of that library.

The extension service worker now creates the adapter with `chrome.storage.local` and is
the sole canonical-state command owner. Its reconciliation coordinator:

- lazily loads saved state once per worker lifetime;
- represents a missing key as explicitly uninitialized rather than inventing inventory;
- accepts transitional one-time legacy recovery initialization, append-only baseline
  creation, explicit mapping, unmapping, worker-authorized
  Sold Items variation/payment-status observations, current-bidding observations,
  Attributed GMV observations, and completed payments;
- treats an identical replay of the same baseline ID as a no-op and rejects that ID if
  its contents differ;
- allows equivalent fingerprints under different baseline IDs because a later physical
  recount is a new baseline even when its normalized rows happen to match;
- serializes reads and mutations through one FIFO Promise queue;
- applies every mutation to a detached working copy;
- waits for that copy to save successfully before publishing it in memory; and
- retains the previous canonical state when validation, engine logic, or storage fails.

This ordering prevents simultaneous commands from overwriting one another and prevents
memory from getting ahead of disk. When an MV3 worker is suspended and later restarted,
the next command reloads the last durable snapshot.

A second FIFO coordinator owns `get_stream_session`, `start_stream`, and `end_stream`.
Only the worker can generate
the stream UUID and timestamp. Start is idempotent when a session already exists, and End
includes the expected active ID so a stale panel cannot close a newer session. A strict
report coordinator owns prepare/finalize/recovery plus authorized list/get reads. The
worker's shared outer FIFO composes report preparation, stream End, and report
finalization so concurrent capture, imports, or stale panels cannot interleave across the
snapshot boundary.

The service worker owns baseline pinning; the side panel cannot issue the pin command.
Start first verifies a nonempty imported active baseline, persists the session, and then
pins that stream while the shared outer FIFO excludes competing lifecycle/import work. If the pin
write is interrupted after the session save, a repeated Start, session GET used by
Resume, or capture delivery verifies and repairs the missing pin. A conflicting existing
pin fails closed. Baseline creation and replacement initialization are rejected while a
session is active, preventing the active pointer from changing during a stream. The sole
upgrade-recovery exception applies when an older saved active session has no
reconciliation state at all: Retry may create the fixed legacy recovery baseline and pin
that same saved stream ID. It never replaces nonnull, malformed, or future-version data.

Worker messages use strict versioned envelopes and return plain success or error data.
Only the exact extension side-panel page is authorized to issue employee/read and
inventory-import commands; it is explicitly forbidden from issuing variation,
current-bidding, payment-status, payment-complete, Attributed-GMV truth, a baseline pin,
or direct baseline creation. A separate strict live-bid read command lets that same
side-panel page request only the currently validated transient live-auction display
record.
The separate capture envelope is accepted only from the extension content script in the
top frame of the exact TikTok product-dashboard URL. The worker, not the page, supplies
the active local stream ID. A shared outer FIFO orders stream lifecycle, capture, and
tagger messages before their dedicated coordinators run. The report list/get envelope is
accepted only from the side panel or extension-owned report page; the dashboard content
script cannot enumerate or open local reports.

After an accepted capture command has completed its persistence boundary, the worker
sends a best-effort, data-free `capture_state_changed` invalidation. It contains no
canonical state, stream ID, variation number, price, buyer information, or DOM content.
The side panel accepts only the exact versioned invalidation from the extension service
worker, coalesces bursts, and issues a fresh canonical-state GET. The notification is a
refetch signal, never a second source of truth; failure to deliver it cannot turn an
already-successful capture write into a failure.

Live bid changes do not use that durable-state invalidation. The worker instead emits a
dedicated, data-free `live_bid_changed` notice. The panel validates its worker sender,
performs one lightweight transient read, rejects any stream/variation mismatch, and
updates only the compact bid/cost/profit panel. Active mapping, remapping, or unmapping
comes from the normal canonical view immediately and is also synchronized into the one
transient record so its cost/profit survives panel reopening after bidding ends. Reviewing
history never rebinds the panel to the selected historical record.
The panel stays mounted during an active local tracker stream. Before any detected auction
it shows `Variation # -` and dashes. A new canonical marker immediately replaces the prior
heading with `Variation #N` and clears its values until the first valid bid arrives. When
that marker clears, the panel keeps the last variation, bid, mapped unit cost, and derived
profit with a muted indicator until the next marker arrives. It never labels the retained
display as a previous auction, and reviewing history never rebinds it to the selected
historical record.

Local storage is restricted to trusted extension contexts so the dashboard content
script cannot read or write the canonical snapshot directly. State changes must pass
through the worker's validated command boundary.

Live-auction display storage is intentionally noncanonical: `chrome.storage.session`
contains at most one record pairing the stream and variation with nullable bid and mapped
unit-cost cents. It is synchronized from canonical mapping/marker state without storing bid
history, survives service-worker suspension and side-panel reopening, and is naturally
cleared by a browser restart before the content script reacquires the visible auction. It
is never copied into reconciliation history, inventory accounting, aggregate metrics, or
an end-of-stream report.

The side panel first uses dedicated import and stream-session client/controllers. With no
active session it offers Sheets import and keeps Start unavailable until the worker
reports a confirmed imported baseline. After a panel or browser restart it offers Resume;
while resumed it offers an inline-confirmed End. Malformed, corrupt, future-version, and
failed reads never trigger initialization or replacement. A guarded legacy recovery
runs only from Retry to repair an already-active session left by the older
session-before-inventory startup sequence. Only a successfully started or resumed and
pinned session mounts the persistent tagger controller, which renders inventory from the
stream's pinned baseline rather than a mutable global inventory array.

Live mapping and unmapping are sent to the worker with the selected
`(streamId, variationNumber)`. The UI keeps its last good view while a command
is saving, publishes only the worker's successfully persisted response, and offers retry
after safe errors. Capture invalidations use the same GET boundary, are serialized with
employee changes, and retain the last good view on refresh failure. Repeated notices are
coalesced, and one trailing refresh catches changes that arrive during a load or save.
A changed active bidding marker becomes the selected tagger view automatically only when
the employee was following the previous current/latest variation, so normal live tagging
continues without reopening the listbox. When the employee manually reviews history, new
markers, repeated markers, and payment/status changes update the closed combobox without
changing the selection. If the listbox is open, its rendered rows and scroll position stay
fixed while the newest canonical view is deferred, then applied once when the listbox
closes. While history or a future preset is selected and an actual captured variation
exists, a compact **Return to live item**
action targets the active bidding variation or, when no bidding marker exists, the newest
captured variation. Returning through it re-enables follow without issuing a mapping,
inventory, payment, or persistence mutation.
Reopening the panel still
rebuilds its view from the durable snapshot. The tagger never calls `chrome.storage`
directly.

The next-item queue follows the same worker-owned boundary. Its strict side-panel commands
include the expected active stream, current/newest variation, and SKU, but the worker
verifies all three against canonical reconciliation state before saving anything. The
current-view toggle command atomically chooses between mapping an unmapped current
variation and toggling the queue for an already mapped current variation. The separate
historical-view command maps or remaps current, unmaps it when the selected SKU is
repeated, and never reads or writes queue storage. This separation prevents historical UI state or
an intervening newer auction from redirecting a write or accidentally arming a queue.
Mapping current sends a data-free canonical-state invalidation while the historical
selection remains open. The session record contains only
`{streamId, sku, armedAfterVariationNumber}` in
`chrome.storage.session`. A queued SKU is considered only after a strictly newer
`observe_bidding_variation` has been saved; Sold Items backfill and payment/status updates
cannot consume it. The worker maps it only when that target remains unmapped, otherwise
keeps the existing manual mapping and clears the queue. Mapping precedes queue clearing,
so a worker interruption between those writes is idempotent on retry. Queue state survives
panel closure, dashboard reload, and worker suspension within the same stream, is cleared
after a successful End, and is naturally discarded by an extension reload or another
session-storage reset. Queue-change notices contain no stream, variation, SKU, inventory,
or DOM data and only tell the panel to refetch.

Manual queue snapshots additionally expose the existing stored
`armedAfterVariationNumber`, queue `streamId`, and the canonical stream's pinned
`baselineId`, alongside `queuedSku` and ephemeral `queueToken`. Empty snapshots have
all five fields null. These are read-only response metadata; queue storage, toggle,
mapping, and consumption contracts remain unchanged. A missing canonical pin fails
the snapshot read rather than inventing a target from the current UI.
An append-only import can repin that stream without changing its queue; the panel
refetches queue metadata once on the ready canonical baseline transition, not by polling.

`variation-presets-view.projectQueuedItem` composes after the preset projection and
adds one `queuedPreview` row at the original queue anchor + 1. It requires matching
stream/baseline, a recorded anchor that is still current, an uncaptured target, and
an exact inventory SKU. An assigned preset wins; an empty preset is overlaid rather
than duplicated. Rows are untracked, not recorded or editable presets, and temporary
rows do not enable or extend a preset range. The preview never moves forward just
because an old queue survived a newer capture or failed consumption.

`selectedQueuedVariationNumber` is panel-only navigation state. Selecting a preview
through the dropdown, exact search, or arrows marks its SKU for display only and
disables all inventory assignment routes, including stale cards and size/keyboard
events. Actual live identity/bid and accounting remain unchanged. Return to live
clears that selection and the Var # input normally. Existing `clearQueue` handles ×.
Queue refreshes re-render the selector; clearing restores an underlying empty preset
or removes the temporary row. Only a still-selected obsolete preview returns to live;
if its number was captured it becomes normal held-history selection instead. Later
navigation is never reversed by the old preview's disappearance. Failed reads retain
the last-known preview but invalidate clear permission until a successful refresh.
Preview rows are never persisted or passed to canonical reconciliation or reports.

The inventory queued presentation can also project an upcoming preset without
writing it into manual queue state. `variation-presets-view.getUpcomingAssignment`
requires matching stream and canonical `view.inventoryBaselineId`. During live
tracking, the selected recorded variation must be the actual active bidding variation,
with an assignment on exactly `activeBiddingVariationNumber + 1` that remains uncaptured.
Before any captures, a resumed local tracker can instead project the viewed future
preset's exact next placeholder. Both placeholders must exist in the enabled range,
and the next one must have an assignment. No selection means no implicit target.
Any recorded variation disables this pre-stream branch, even after bidding stops.
It never skips empty numbers. That projection drives the existing header/card/size-option red
states, including combined selected/queued styling; filtering cards does not hide
the header. A source discriminator and preset-specific tooltip/accessible labels
keep this distinct from a manual queue. After first capture, history/future views
retain the manual queue presentation only. Pre-stream labels explicitly describe
planning without reservations; future-card mouse gestures remain unchanged.

For a preset, the header clear control uses existing `set_preset_item` with null SKU,
expected stream/baseline/revision, and optional `expectedActiveBiddingVariationNumber`.
The protocol permits that extra field only for an exact immediate-next clear. The
coordinator verifies the actual active marker before and after repair inside the
worker FIFO, rejecting advances, skipped captures, or ended bidding even when the
preset revision has not changed. Clearing leaves the placeholder and every captured
mapping intact. The pre-stream projection instead returns `prestreamVariationNumber`
and sends `expectedPrestreamVariationNumber` with the existing null-SKU command.
That optional field is mutually exclusive with the live guard, clear-only, and
requires target = source + 1 within the preset range. The worker checks zero
canonical variations and no active bidding marker before/after repair. It cannot
be used to clear after capture starts, including a backfill elsewhere in the range.
The UI binds the source/target and navigation generation, ignores superseded replies
after capture notifications or canonical/baseline changes, and refreshes without
moving selection or focus. Manual clears still use `clearQueue` and its ephemeral token. The UI
validates rendered source/target/revision identities, applies strict capture editing
locks even during blue planning opt-in, serializes through existing preset busy
state, and refreshes authoritative state on failure or a superseded acknowledgement.
No new storage contract, inventory allocation, polling, or capture path is involved.

The tagger runtime client deliberately exposes no payment-complete command. The capture
runtime client has the inverse narrow authority: it may submit
only Sold Items variation numbers, one current bidding variation number, sanitized
payment-status codes, completed variation/price facts, and the sanitized Attributed GMV
display, never mappings, stream
lifecycle commands, raw badge or analytics text, or arbitrary state. The Sheets reader
is a separate worker-owned boundary used for pre-stream confirmation, explicit
active-stream SKU additions, and employee-requested report quantity-handoff checks.
The local report may serialize a six-column clipboard/CSV replacement table or a
verified row-aligned quantity column; outbound Google Sheets API writes are not
supported.

Captured pre-completion terminal cancellation is authoritative for allocation;
production refunds and post-completion cancellations are not supported and do not reverse
a `payment_complete` record.

### Future variation presets

`variation-presets-protocol.js`, `variation-presets-storage.js`, and
`variation-presets-coordinator.js` provide a separate, worker-owned planning domain.
The local key `tiktokLiveTracker.variationPresets.v1` contains
`{schemaVersion: 1, presets: {streamId, baselineId, revision, total, assignments}}`.
Assignments are ordered exact `{variationNumber, sku}` pairs; no canonical orders
or payment statuses are fabricated. The preset-only total is 1–1,000. Create rejects
totals below the highest captured number; real capture has no preset-based ceiling.

Planning is available before the first actual auction in a started/resumed local
session with confirmed inventory. Existing worker START and GET_STREAM_SESSION
paths already pin the prepared baseline without creating any captured variations;
no new baseline or synthetic payment/live marker is needed. The panel requests the
preset snapshot after its canonical workspace has successfully loaded (including
load retry), rather than racing that initial load. Existing capture-refresh reads
remain. Thus preset availability does not depend on a later capture notification
recovering an unsuccessful early preset read.

Connecting initially blocks planning, but the preset button remains available
once canonical inventory/session and preset data have loaded successfully. Clicking it
opts into panel-local startup planning and opens the existing input (or performs the
existing Reset presets action). `canUseVariationPresetData` retains independent save,
queue, import, session, error, and root-inert guards. `isCapturePlanningLocked` adds a
narrow exception for navigation and future assignments; live/history mapping, manual
queue controls, pins, imports, and unrelated editing retain `isCaptureInteractionLocked`.
An explicit event-target allowlist and nested inert regions protect both ordinary
controls and external popovers. Future cards and both ordinary/sequential size menus
retain their source context so capture cannot turn a delayed future action into a real
mapping. Worker revisions, serialization, queue-conflict clearing, and capture promotion
are reused unchanged.

Blue Connecting also enables the same planning-only exception automatically after
1.3 seconds, once local prerequisites are usable. This is a separate panel-local
timer, not a change to the badge's ten-second no-source grace or capture readiness.
`captureConnectingPlanning` binds to the resumed stream, mounted controller, and
planning-cycle epoch. It starts with that mounted blue attempt, counts time even if
local inventory is still loading, and waits for valid local data before activating.
Repeated renders and busy refreshes do not restart it; once active, saves may lock
controls without bringing back the tint. A newly enabled future view refreshes its
inventory-card disabled states without moving selection or focus. Yellow, green,
Reload Site, a new document/session, unmount, and disposal cancel the automatic scope;
stale callbacks cannot unlock a different cycle. First document identity discovery
does not restart the delay. Yellow remains strictly gray; the manual preset override
works only during blue and is never replaced by this timer.
Yellow revokes both manual and automatic planning scopes. Preset creation/reset,
navigation and assignment handlers reject yellow even if they receive stale events;
the CSS yellow tint ignores any leftover planning attribute. The existing readiness
signal ends yellow without an added timer or a new Sold Items/live-bidding gate.
Normal busy/save/error restrictions still apply after startup readiness changes.
On the existing unlock signal, previously disabled future-preset cards are rendered
once so they become usable without waiting for another capture. Already-interactive
blue planning skips that repaint; selection and keyboard focus are not moved.

The override is scoped to the current panel, stream, and dashboard load. The existing
health view controller exposes validated document identities through `onLoadChange`,
including same-phase document changes, without changing readiness or request timing.
First discovery binds the opt-in; a different non-null document or leaving the resumed
stream clears it. Rerenders, preset edits, and local busy states do not discard it.
Safe background refresh preserves already-open picker display/focus through the existing
picker exemption, but new submissions still require ready local data. Actual document
replacement dismisses the unsaved total editor to restore the opt-in button and rotates
a navigation/cycle epoch; late create/reset/sequential acknowledgements cannot steal
selection or focus. Accepted writes still complete through the existing coordinator.
The `data-capture-planning` attribute suppresses only capture tint; independent locks
still apply. Green and blank/Reload Site discard the exception and use normal rules.
No settings are persisted, no navigation/scroll reset is triggered by readiness, and
reopening during startup starts a fresh blue planning delay or permits manual opt-in again. Badge production, wording,
rendering, scheduling, and health thresholds are unchanged. Setup and
Resume-only screens still do not expose planning. Empty-view placeholders remain
outside canonical history and first actual capture uses normal preset promotion.

After a successful initial range creation before any capture, the panel selects future
**#1** so item planning can begin immediately. It verifies the canonical view with one
controller refresh, queued behind any existing refresh, and rechecks stream/controller,
baseline, acknowledged preset revision/total, navigation, and capture-notification state
before selecting. Failed verification, intervening capture or navigation, and a newer
reset/configuration cannot force #1. A save notification arriving before its matching
acknowledgement remains supported. This submit-only selection does not run on
ordinary reads, range extension, or creation during a captured stream.
Explicit Resume has a separate one-shot restoration: after the resumed controller's
canonical load and saved-preset read, select existing future **#1** only if no actual
variations have been captured. One additional canonical verification read after
presets arrive also covers delayed or missing capture notifications; an in-flight
guard prevents its own refresh from restarting verification. The intent binds to the newly mounted controller,
stream, navigation/capture/document/mutation generations, and the first loaded preset
configuration. Capture notifications invalidate it before the debounced view refresh;
navigation, reset/configuration changes, errors, or leaving the session cancel it.
An absent plan consumes the intent rather than selecting a subsequently created plan.
This display-only restoration does not change focus, scroll, capture readiness, or
interaction locks, and does not opt into startup planning. Later reads never re-arm it.
**Return to live item** stays hidden until at least one actual variation exists. An
unselected pre-capture dropdown opens at #1 without reordering its descending list; intentional future
selection and explicit Home/End navigation keep their existing behavior.

The side-panel-only protocol supports get/create/set-item/assign-next-item/reset. Mutations compare
stream, pinned baseline, and a durable UUID revision inside the coordinator FIFO
and the existing worker message FIFO. Reset saves a disabled revision tombstone so
late edits/resets cannot resurrect old plans or erase a new configuration. Missing
data means no presets; malformed stored data fails closed. Existing reconciliation,
session, report, and queue schemas remain unchanged.

An enabled preset snapshot can additionally contain `extensionAvailable: true`.
This optional, true-only field is stored in the same v1 preset envelope; old records
without it remain valid and require no migration. The coordinator latches it only
when the canonical `activeBiddingVariationNumber` exceeds the saved total. Highest
captured fallback values, historical backfill, and panel selection never establish
eligibility. The small durable latch is necessary because payment observations clear
the live bidding marker; extension must remain available after that and worker restart.
Metadata-only latching keeps the revision, range, and assignments unchanged.
The capture path also calls a serialized, latch-only readiness barrier before
canonical updates: if the first latch write failed, payment cannot erase the last
durable live marker before the existing retry can retain that proof. This barrier
does not promote presets or consume/clear a queue. Storage failures use the existing
capture error/retry path; classification, scheduling, and retry timing are unchanged.

With that latch, `create_presets` may extend an existing range. The worker requires
a strictly larger total at least as high as every captured variation, within the
unchanged 1,000 preset-only limit. It preserves remaining uncaptured assignments,
rotates the revision, and removes the old latch. A later actual live capture beyond
the new total can latch it again. Manual reset also removes the latch. Existing
stream/baseline scoping prevents it leaking to another tracker session. No canonical
schema, report content, accounting, or ordinary queue operation changes merely from
enabling or saving an extension.

The panel uses the durable latch or the same-stream actual live bidding marker for
the button label, never its selected variation or historical fallback. An open total
draft survives ordinary refreshes and is scoped to its originating configuration;
stale submissions are rejected rather than silently retried against a new range.
Escape or an outside click dismisses an unsaved total draft without changing the saved
range or assignments. Outside clicks do not cancel a save already in flight or steal
focus from the clicked control.
Delayed snapshots cannot undo a latched flag for the same revision. Successful
extension does not force a selection or label: latest authoritative capture may
already have overtaken the newly saved range.

`assign_next_preset_item` receives the displayed future source number, exact SKU,
and expected stream/baseline/revision. Inside the same FIFO it validates that the
source remains uncaptured, then chooses the source if empty or the first higher
empty uncaptured preset. It never wraps, expands the range, or overwrites a plan.
It reuses ordinary preset persistence and next-item queue-conflict handling, returning
`{presets, assignedVariationNumber}` only on success. Exhaustion raises
`NO_MORE_FUTURE_VARIATIONS` with no assignment write. Every successful assignment
rotates the existing revision, so duplicate or delayed requests cannot advance twice.
The dedicated client validates the returned target, assignment, identity, and revision.

Future-preset left-clicks use this command. Right-click instead sets/unsets the item
on the viewed preset, without advancing; the same exact SKU toggles off. Live and
captured-history click behavior is unchanged. Size-menu opening normalizes primary
`ordinary` intent to `preset_sequence` and secondary `context` to `preset_current`
only in a valid future view. Native primary activation and size-menu navigation use
the sequential action; ContextMenu/Shift+F10 use the current-preset action. Selecting
a size commits that stored intent, not a newly inferred action. Future card and
size-option accessible labels explain the swapped actions and planning-only effects.
Future-origin card and size-menu
context stays scoped to its original source/configuration, preventing a stale action
from falling through to live mapping after capture. The panel blocks overlapping
submissions and navigates only after a confirmed save if the originating view is
still current. Failure refreshes authoritative state without advancing or retrying
the old click. If plan persistence succeeds but queue clearing fails, the saved plan
remains repairable under the existing rules; an error never triggers a second assignment.

Capture first persists the real observation, then promotes any matching assignment
through the existing canonical mapping command without overwriting an actual
mapping. Only confirmed mapping persistence allows plan cleanup. A later read,
manual mapping operation, or End repairs an interrupted promotion before proceeding.
These are separate storage writes, not a cross-key transaction; repair is idempotent.
Uncaptured plans never enter reports, reservations, metrics, or inventory exports.

Specific presets win over the generic next-item queue. Before bidding queue
consumption, preset repair handles the captured target but defers the next-variation
queue restriction until the current queue has been consumed. Thus queue-for-#2 still
maps #2 before preset-#3 blocks future queuing. Queue conflict clearing uses the
ordinary coordinator/token invalidation and compares captured targets with the
queue's armed-after number, so older Sold Items backfill cannot erase a newer queue.
An already-due queue survives read repair if its current mapping save failed; the
ordinary bidding-capture retry can still apply it before future queuing is blocked.
Successful preset promotion marks the retained live projection dirty. The worker
refreshes it within its command FIFO, even when subsequent plan cleanup fails, so
new price events cannot be rejected against stale cached live identity or cost.
Right-click live mapping remains available. Data-free preset notifications reuse
existing refreshes; no new polling or capture timing is introduced.

The tagger's pure `variation-presets-view.js` projects untracked dropdown entries and
future selection without passing placeholders into canonical controllers. Preset
assignments use the dedicated client. Reset discards uncaptured plans based on actual
capture state, returns to the actual live/newest variation when one exists (otherwise
the waiting-for-live view), and restores the creation control. Presets survive
same-stream reloads and never apply to another baseline/session. Successful End
cleans up best-effort; failed End retains plans, and old scoped data cannot leak into
the next stream if cleanup fails.

### Google Sheets

Google Sheets is implemented as the inventory import source. The employee
authorizes a Google account through Chrome, supplies one spreadsheet ID, reviews the
normalized `Inventory` preview, and explicitly confirms it as a new durable local
baseline. The service worker owns authorization, network access, preview state, baseline
creation, and all active-stream checks; neither the dashboard content script nor the side
panel receives an access token.

Google Sheets is not the live transactional source of truth. Once confirmed, the local
baseline scope drives tagging, inventory, and basic profit without automatic Google
requests. An employee may explicitly re-read the same `Inventory!A:F` range during an
active stream to append new SKU rows under the strict rules below. At End, the tracker
saves its report locally first and offers a checked quantity-only clipboard handoff or
a Google Sheets-ready six-column replacement CSV. It does not call the Sheets write API.

The full-table actions under **Other options** are position-based, not a SKU lookup or
merge: duplicate the current `Inventory` tab as a backup before importing CSV with
**Replace current sheet** or pasting the six-column clipboard table at A1. The
**Copy Inventory No Formatting** button reuses exported
`report-page.js::copyUpdatedInventory(navigator, report, reportModule)` without changing
its TSV output. Neither action reads Google; both can reorder inventory into SKU order
without spacer rows and are not formatting-preserving exports.

The **Copy Updated Inventory** button opens the quantity-only workflow, which verifies
the chosen Sheet by exact SKU before preparing a positional single-column paste. Its fresh read retains the
first nonblank A:F header's physical row, the quantity column within A:F, and blank
A:F spacers through the last inventory row. G-only content does not select the header,
create inventory records, or extend the paste range. Nothing is inserted into canonical
inventory or saved reports;
report inventory remains SKU-sorted. The source Sheet ID/layout and prepared output
are transient, not new saved-data fields. Copying revalidates the report/context before
returning quantities, and a changed link or report invalidates the page's preparation.
The user must paste into the indicated cell using values-only paste and must not change
the Sheet between reading and pasting. Clipboard success cannot verify the destination
or protect against later Sheet edits. This is not automatic Google Sheets write-back.

Preparation and copy use strict report-page-only commands in the worker FIFO. A bounded
in-memory token expires after ten minutes (or restart), and retains an exact saved-report
and local-state signature. Copy rechecks it instead of trusting the rendered report.
The reader requests only `'Inventory'!A:F`, validates physical grid identity, and rejects
unsupported layouts or any merge touching A:F. Merges wholly within G+ are ignored.
The existing response/row/cell limits remain; A:F data beyond the 1,001-physical-row
bound is rejected, never clipped into a valid-looking partial handoff. Leading and
interior A:F blank rows retain their physical positions and count toward that bound.
Matching is an exact SKU set with saved item/style/size identity. Costs may differ but
remain import-format-valid.
The quantity handoff changes neither those costs nor saved report-only corrections.
Only the latest finalized report on the current verified imported baseline/latest
stream is eligible, with no active tracker or blocking unfinished/reconciliation issues.
The complete Sheet quantity vector must match either the report's baseline-opening
vector or its complete replacement vector. Mixed states, restocks, and intermediate
stream exports on a reused baseline require manual reconciliation; there is no
per-row guess or blind subtraction. An oversold report retains its recount warning
and existing zero-clamped replacement values.
Prepared output is plain numeric text with blank spacer lines and no formulas/header.
The quantity-only paste leaves every other column, including G+, outside the operation.
The clipboard write starts in the explicit user gesture with a promised text/plain
payload, released only after worker and page validation. Browser clipboard failure is
not reported as successful copying, and successful copying is not a confirmed paste.

## 7. Google Sheets inventory import contract

The canonical starter file is
[`google-sheets-inventory-template.csv`](google-sheets-inventory-template.csv). An
employee can import that file into Google Sheets or reproduce its exact six-column
header in an `Inventory` tab. This contract deliberately defines data and validation
separately from network access; the pure parser does not authorize Google or mutate
tracker state.

### `Inventory` tab

Only columns A:F are inventory input for preview, confirmation, active-stream SKU
additions, and quantity-handoff checks. Columns G+ are ignored, including formulas,
notes, and summaries; this does not add formula evaluation, generated totals, or Apps Script.
The first nonblank A:F row must contain these exact, case-sensitive headers. Column
order may vary within A:F, but missing, duplicate, or unknown headers in A:F make the
whole import invalid. A required header placed in G+ does not satisfy the contract.

| Column | Required value |
| --- | --- |
| `sku` | Uppercase key matching `^[A-Z0-9][A-Z0-9._-]{0,63}$`; unique in the confirmed baseline |
| `item` | Nonblank employee-facing product name up to 160 characters, such as `Stussy tee` |
| `style` | Optional color, design, or distinguishing style up to 160 characters, such as `black`; blank is valid when the item has no style variant |
| `size` | Nonblank size label up to 80 characters for this exact SKU row; every size needs a unique SKU |
| `quantity_on_hand_at_import` | Nonnegative safe integer representing the physical count when this baseline is confirmed |
| `unit_cost` | Nonnegative US-dollar decimal with no symbol and at most two fractional digits, such as `12.00` |

An all-blank A:F row is ignored for inventory, even if it has G+ content. In a data row,
every field except `style` is required. Formula cells in A:F are invalid: import values
are data and must never be evaluated by the tracker. The Google adapter reads
`userEnteredValue`, preserving formula cells for this
validation instead of supplying only an evaluated result. Leading and trailing
whitespace is trimmed from cells, and runs of whitespace
inside employee-facing item/style/size text are collapsed. Those display fields use one
canonical Unicode representation so visually equivalent labels cannot bypass duplicate
detection. SKU case, characters, and punctuation are never rewritten; the trimmed value
must already match the required syntax. `0` is valid for both quantity and unit cost.

A newly confirmed pre-stream baseline treats the latest Sheet as the source of truth and
may rename or reassign SKU and item/style/size values. That does not mutate an earlier
baseline or report: each prior stream retains the identifiers it originally used, and a
renamed row begins a separate history segment. Within each baseline, duplicate SKUs and
duplicate item/style/size combinations remain invalid after trimming and case-folding
employee-facing text. Active-stream extension remains append-only and cannot rename,
change, or remove any row already used by that stream.

Rows that intentionally repeat normalized item and style with different sizes are valid
and appear as one live inventory card. This UI grouping never merges the rows in the
baseline, report inventory table, SKU performance, accounting, or six-column Sheet
handoff.

`quantity_on_hand_at_import` is an **opening baseline**, not a lifetime quantity received
and not a value that the tracker writes down after each sale. It means the physical units
counted at the instant the employee confirms an import. The pure parser and version-7
engine both retain that meaning as the immutable `quantityOnHandAtImport` field:

```text
remainingQuantity = quantity_on_hand_at_import - completed mapped sales under this baseline
```

Pending reservations affect `availableToTagQuantity`, not the opening baseline or
remaining quantity. A later physical recount creates a new versioned baseline for a
future stream; it cannot overwrite the baseline lineage used by an active or historical
stream. Old sales remain scoped to their original lineage, so they are not subtracted
again from the fresh physical count. Recount-baseline creation is blocked while a local
tracker stream is active. A live append may add a new row with its own opening quantity,
but it cannot modify, rename, or remove any row already in that lineage.

`unit_cost` is the per-unit cost snapshot used for basic gross-profit calculations. The
adapter converts it exactly to the engine's integer `unitCostCents` value (`12.00`
becomes `1200`) and rejects values that cannot be represented as nonnegative safe integer
cents. If this imported value was wrong for a completed stream's analytics, any finalized
saved or archived report can explicitly correct its own copy. That report's dependent
financial rows and six-column handoff are rebuilt, while the immutable imported baseline,
canonical sales, other reports, and future streams retain the original cost.
Currency conversion, fees, tax, shipping, refunds, and weighted purchase lots are outside
this first contract.

### Atomic validation boundary

The pure preview parser validates the A:F header and every nonblank A:F row before any
inventory baseline may be appended. Validation includes required fields, types, SKU syntax and
uniqueness, duplicate item/style/size detection, and safe integer bounds. If any error
exists, the parser returns row-specific errors and commits nothing; the connection
adapter never partially imports valid rows from an invalid Sheet.

The normalized preview is detached data. Merely opening or previewing a Sheet must not
start a stream, activate a baseline, alter reconciliation state, or persist a partial
baseline. A separate explicit employee confirmation creates a fresh baseline identity,
appends the complete baseline, and activates it only for future streams; existing
baseline entries, quantities, costs, and identifiers remain immutable even when the new
baseline uses renamed identifiers. The live append operation is
separate: it accepts only a full order-independent superset, creates a derived immutable
snapshot, and advances every stream sharing the prior snapshot so its accounting scope
does not split. The
later report-only unit-cost correction is a separate saved-report operation, not an
import mutation.

For a valid two-dimensional `Inventory` value array, the pure parser returns a frozen,
detached preview with:

- a version for this import contract;
- normalized inventory rows using `sku`, `item`, `style`, `size`,
  `quantityOnHandAtImport`, and integer `unitCostCents`;
- a deterministic fingerprint of those normalized rows; and
- a summary containing the row count, total opening quantity, and total opening
  inventory cost in cents.

Invalid input produces one typed import error containing ordered row- and column-specific
issues for independently validated fields. Diagnostics that depend on an already-invalid
value may be omitted. The parser does not return a partial inventory array. Fingerprints
identify equivalent normalized previews at confirmation time; they are not credentials,
authorization proofs, baseline identities, or live inventory hashes. A report-only cost
correction changes neither the normalized baseline nor its saved source fingerprint. Two
separately confirmed recounts may therefore use different baseline IDs even when their
fingerprints are equal.

### Connected import boundary

The side panel accepts either the exact spreadsheet ID or a narrowly parsed HTTPS
`docs.google.com/spreadsheets/.../d/<id>` sharing link. It rejects credentials in URLs,
non-Google and lookalike hosts, insecure URLs, unexpected paths, and malformed IDs. Only
the extracted ID crosses the strict versioned inventory-import message boundary. The
worker accepts that boundary only from the exact extension side-panel URL; the dashboard
content script cannot read Sheets or create a baseline, and the general reconciliation
boundary refuses direct baseline-creation and baseline-extension commands from the panel.

The Manifest V3 worker uses `chrome.identity` and the public OAuth client configured in
`manifest.json`. It requests only
`https://www.googleapis.com/auth/spreadsheets.readonly` and fetches only
`https://sheets.googleapis.com`. The request is a GET for the selected spreadsheet's
fixed `'Inventory'!A:F` range, without a row cutoff that could hide later inventory.
It asks for grid `userEnteredValue` data so formulas within A:F remain distinguishable
and invalid rather than being accepted as their evaluated result. The adapter retains
the existing 1,001-physical-row bound, including the header, leading blanks, and interior
spacer rows; A:F data beyond it fails closed. G-only rows are not inventory and do not
extend the used inventory range. Response bytes, columns, cell slots, issue counts,
retries, and request duration retain their existing bounds before data reaches the
pure parser. An oversized or invalid inventory fails as a whole; it is never truncated
into an apparently confirmable baseline. API error bodies and raw Sheet
contents are not exposed to the side panel or application logs.

Preview and confirmation are distinct operations:

1. Preview checks that no local tracker stream is active, authorizes interactively,
   reads and validates `Inventory!A:F`, and returns detached normalized rows
   plus summary totals. It does not write reconciliation state.
2. A valid preview receives an opaque random nonce with a ten-minute expiration. The
   corresponding Sheet ID and normalized snapshot remain only in worker memory; the
   panel also keeps only detached preview data in memory. A worker or panel restart
   therefore requires a new preview.
3. Confirmation checks the nonce and active-stream state, obtains authorization without
   an interactive prompt, re-reads and re-validates the same fixed range, and compares the
   complete normalized snapshot rather than trusting the fingerprint alone. A changed,
   expired, invalid, or unavailable preview commits nothing and requires a fresh preview
   when appropriate.
4. Only an unchanged confirmation generates the worker-owned baseline UUID and invokes
   the internal atomic baseline-creation command. A same-worker retry is idempotent; if
   the worker restarts after persistence, import status discovers the already durable
   active baseline rather than relying on the lost preview.
5. During an active stream, **Add new SKUs from updated Sheet → Check and add**
   sends only the extracted Sheet ID. The worker derives the active stream and
   expected baseline itself, checks that stream before and after the network read,
   and passes the complete validated snapshot to the internal append-only command.
   Every existing row must match by SKU across all six
   fields; order may differ, but a rename, edit, or deletion rejects the whole operation.
   New rows are committed in one derived baseline and every stream sharing the prior
   baseline is advanced atomically. An exact no-change Sheet is a successful no-op.

Inventory import, active-stream lifecycle, capture, and baseline mutation commands share
one worker FIFO. Import checks active state before and after each network read, while
Start invalidates every pending preview and checks for a confirmed imported baseline
before persisting a session. Therefore a concurrent Start either uses the fully confirmed
baseline or wins first and causes the import to fail closed; a preview also cannot survive
a complete intervening Start/End cycle. Start cannot pin a detached preview or a
partially imported Sheet.

The side panel hides the pre-stream preview/confirmation controls while a stream is
active and exposes only the narrow append action after its saved workspace loads. Worker
checks remain authoritative.

### Inventory-import privacy boundary

The inventory contract contains no buyer identity, TikTok payment data, variation
numbers, stream identifiers, credentials, access tokens, or DOM text. Preview and
validation diagnostics identify the row and field without logging full Sheet contents.
The Google access token is received and used only inside the worker request path; it is
never sent through runtime messages, rendered, persisted by the application, or placed in
repository files. The selected normalized inventory baseline and its non-secret
fingerprint are stored locally. No variation, buyer, payment, sale, stream, or report data
is sent to Google. The end report's clipboard and CSV serializers run locally and only
after an employee action; they are not outbound Sheets API export.

The local report archive does contain business-sensitive inventory names/SKUs, unit
costs, counts, captured sale prices, aggregate payment counts, calculated profit, and
local stream timestamps. It deliberately excludes buyer identity, Sheet ID/link, OAuth
tokens, and raw DOM text. Native Print / Save as PDF and CSV download create files on the
employee's computer. Removing the extension or clearing its storage deletes the bounded
in-extension archive, so required reports must be saved externally before either action.

The tracker does not export a `Sales` tab. Its Google Sheets handoffs contain either the
six-column inventory replacement table or a checked quantity-only clipboard column.
Buyer fields are not part of the capture event.

Gross profit is the mapped completed sale price minus its pinned Google Sheets unit-cost
snapshot. It excludes platform fees, refunds, shipping, discounts, taxes, and other
expenses. It can be negative when the completed sale price is below unit cost.

## 8. Authentication and credential decision

The inventory importer uses **browser-only user OAuth**. `manifest.json` declares
`identity`, the read-only Sheets scope, the exact Sheets API host permission, and a
configured Google OAuth client of type **Chrome Extension**. The checked-in public
extension `key` pins `chrome.runtime.id` to `lmkljkejmicknleeldfgekbbgpnegcmo`, matching
that client's configured extension ID. Both the key and client ID are public
configuration; neither is a client secret or a private signing key.

The current workflow is private use by one to three personally known users on desktop
Chrome. Development and normal use load the working repository's `extension/` folder
unpacked. Another user can load a copy of that same folder, including one shared as a
ZIP and extracted first. Preserve the checked-in key and OAuth client ID when copying,
updating, or reloading the extension; do not create a new OAuth client per computer or
release. This workflow requires no Chrome Web Store publication, listing, or Store
assets. See the [README installation instructions](../README.md#load-the-extension-in-chrome)
for the operational setup rather than maintaining a separate build or installation guide
here.

Keep the Sheets API enabled and Google Auth Platform **Audience** set to **External /
Testing** for this setup. Add each authorizing Google account as a test user at the
project level; that list applies across the project's OAuth clients, not separately per
client, extension copy, or device. Testing authorizations expire seven days after consent
for this Sheets scope, so users must be prepared to authorize again. Google's
[audience documentation](https://support.google.com/cloud/answer/15549945?hl=en)
describes the limits and account restrictions.

The extension ID identifies the extension, not an employee, Google account, or computer.
`chrome.identity` manages Google authorization in Chrome; the chosen account still needs
access to the selected Sheet. Tracker state in `chrome.storage.local` belongs to that
extension installation in its Chrome profile. Copying the extension or signing into the
same Google account on another device does not copy or synchronize its local tracker
state.

A service-account private key must never be placed in the extension because the installed
bundle is readable on disk. `config/.env.example` is not consumed by the extension and
intentionally contains no service-account placeholders. The current architecture has no
backend or service account.

Google documents [OAuth verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en)
for qualifying personal-use and development/testing apps. The current private/testing
workflow does not include a Store release or an OAuth verification submission; reassess
verification requirements before expanding the audience. An exception from verification
is not an exception from the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
An accurate, accessible, published privacy policy and appropriate disclosures must still
explain Google data access, use, local storage, sharing, and deletion. Applicable Limited
Use and secure-data-handling requirements also remain in force. Keeping OAuth in Testing
does not establish compliance with those obligations.

## 9. Remaining live-validation questions

One live stream established the current product-dashboard route, exact variation labels,
and unique visible `[data-tid="m4b_space"]` Sold Items boundary. Later streams must still
answer these questions; offline fixtures alone cannot complete the validation:

- Do processing (including ellipses) and terminal `Payment failed` retain the reported
  meaning and safe row association across accounts? Does a legacy active countdown
  remain distinguishable without reading unrelated text?
- Do production transitions preserve the confirmed allocation rule across accounts: a
  mapped bidding item stays pending through processing, fixing, legacy failed,
  unrecognized, and price-less completion observations until a captured terminal
  cancellation or priced `Payment complete` resolves it?
- Does the observed `m4b_space` Sold Items identity remain unique across different
  accounts, streams, modes, scrolling states, and TikTok deployments?
- Do the exact visible `auction-pin-card` boundary, direct-own-text `#N` identity, and
  direct-own-text `Bids: $...` value remain unique and stable across accounts, modes,
  bid speeds, streams, and TikTok deployments?
- Is the Sold Items list virtualized or replaced as it grows, and can every earlier row
  be recovered by the initial/backfill scan?
- Does any relevant content live inside an iframe or shadow root?
- Does the implemented route/body/root recovery remain reliable under TikTok's live
  rendering?
- Do auctions with no bids appear in any trackable list?
- Does rendered-history backfill capture every completed sale before the local End
  snapshot, especially when Sold Items is virtualized?

The supported browser is desktop Chrome.

## 10. Implementation record

1. **Completed:** sale parser and read-only capture probe.
2. **Completed:** reconciliation engine and automated tests.
3. **Completed:** tagger foundation, grouped multi-size inventory cards with exact-SKU
   actions, mapping workflow, and captured payment lifecycle display.
4. **Completed:** versioned storage, service-worker coordination, tagger integration, and
   visible recovery.
5. **Capture hardening completed:** bounded scheduling, SPA lifecycle recovery, exact
   variation and badge targeting, unique visible Sold Items root narrowing, the isolated
   strict Attributed GMV locator, the unique visible on-video bidding-card locator, and
   scoped capture tests. Capture uses local tracker identity, not verified TikTok identity.
6. Capture-to-engine-to-tagger integration completed in three stages:
   1. **Completed:** persistent local active-stream sessions and Start/Resume/End UI;
   2. **Completed:** persist the on-video active bidding marker, Sold Items
      variation/payment facts, and the sanitized Attributed GMV display under the
      worker-resolved active local stream;
   3. **Completed:** data-free invalidations refresh the open tagger in real time,
      auto-follow each changed bidding variation before it sells while the employee is
      viewing the current auction, preserve a manually selected historical variation as
      newer options update, provide a mutation-free **Return to live item** action that
      falls back to the newest captured variation when no bid is active, and visibly
      update sanitized payment status and the Metrics section. Startup-readiness display
      is also implemented. Broader live validation remains required.
7. Google Sheets inventory connected in three stages:
   1. **Completed:** exact template, pure validation, detached preview, and opening
      baseline contract;
   2. **Completed:** immutable versioned inventory baselines, physical-count-lineage
      associations, baseline-scoped inventory/cost accounting, atomic append-only live
      SKU additions, report-only cost correction, and strict legacy migration; and
   3. **Completed:** browser OAuth, fixed-range Sheet reading, detached preview,
      employee confirmation, and durable import.
8. **Completed:** strict end-of-stream projection, report-aware End/recovery,
   two-tier local recent-report/archive library, printable/Save-as-PDF business page,
   exact SKU and combined
   product analytics, and six-column clipboard/CSV inventory handoff.

Broader real-stream report validation remains required, including the rendered-history
backfill check in the live-validation questions above.
