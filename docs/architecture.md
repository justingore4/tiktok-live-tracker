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
| `payment_fixing` | TikTok shows `Payment fixing` |
| `payment_failed` | TikTok shows `Payment failed` during its correction buffer |
| `canceled` | TikTok shows `Canceled` after the correction window expires |
| `payment_complete` | TikTok shows `Payment complete` |
| `unrecognized` | A nonempty tag was present but was not allowlisted; raw text is discarded |

Canonical `paymentStatus` is `unknown`, `canceled`, or `payment_complete`. Processing,
fixing, failed, and unrecognized remain nonterminal observations under canonical
`unknown`. Every mapped canonical-unknown record reserves one unit immediately, including
the bidding/not-yet-observed state, processing, fixing, temporary failure, an
unrecognized badge, and a price-less completion observation. The reservation resolves
only at canonical priced completion or exact cancellation.
Exact `Canceled` promotes the record to canonical `canceled`, preserves its item link for
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

> Count revenue, record gross profit, and decrement stock **if and only if** TikTok
> shows payment complete and the variation is mapped to an inventory entry.

Consequences:

1. Mapping during bidding immediately reserves one unit. The reservation survives
   processing, fixing, temporary failure, unrecognized, not-yet-observed, and
   unpriced-complete observations until canonical payment truth resolves.
2. Exact `Canceled` releases that reservation automatically while retaining the SKU as
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

When TikTok changes the exact row-local badge to `Canceled` after the buyer's payment
buffer expires:

1. The record becomes canonically `canceled` without employee action.
2. Any selected SKU remains linked for history, while its pending reservation is
   released. Remaining inventory, completed sales, revenue, cost, and profit stay
   unchanged. The employee may later map, correct, or clear that reference SKU without
   changing those values.
3. If the same physical item is auctioned again, TikTok assigns a new variation number.
4. The employee maps that new variation as a separate auction.

The Live tagger does not infer cancellation with a timer and exposes no **Mark unpaid** or
**Undo unpaid** action. It waits for TikTok's exact `Canceled` badge.

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
- Promoting exact `Canceled` to a canonical terminal allocation result that preserves the
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
  `payment_processing`, `payment_fixing`, temporary `payment_failed`,
  `payment_complete`, and `unrecognized` observations are excluded. Inventory mapping
  does not affect this count.
- `paymentFixingCount` counts each unique requested-stream variation whose canonical
  payment status is still `unknown` and whose latest observed status is either
  `payment_fixing` or temporary `payment_failed` during TikTok's correction buffer.
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

The current state stores the latest mapping and status. A full event-by-event employee
audit log can be added as a separate persistent event-log feature if the client requires
one.

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

`capture/capture-event-registry.js` still provides page-load and future verified-stream
scopes for console diagnostics and conflict warnings. It is not the persistence
authority. Canonical deduplication occurs in reconciliation storage under
`(streamId, variationNumber)`, so a full refresh can safely backfill visible rows while
the same local tracker stream remains active. A stable TikTok-provided stream identity
and automatic page-to-session association remain later identity work.

### Capture events and remaining live signals

| Dashboard fact | Current action | Status |
| --- | --- | --- |
| One `#N` value appears in the unique visible on-video `auction-pin-card` | Create/activate that bidding variation under the worker-resolved stream and select it in the open tagger | Implemented; sends only the number; selecting inventory for it immediately creates a reservation |
| One canonical `Bids: $...` value appears in that same uniquely identified card | Replace the single stream-scoped transient bid and targeted-update the live panel | Implemented; sends integer cents paired with the variation; never becomes final price or report data |
| Exact `Variation: #N` appears in Sold Items | Persist an unmapped, unknown-payment auction under the active local stream | Implemented |
| Exact processing or fixing payment badge appears | Persist its sanitized observed status and update the open tagger | Implemented; a mapped unit remains pending |
| Exact failed or unrecognized payment badge appears | Persist its sanitized observed status and update the open tagger | Implemented; a mapped unit remains pending until completion or cancellation |
| Exact `Canceled` badge appears | Persist observed and canonical cancellation, retain any item link, and release its reservation | Implemented; no sale, revenue, cost, or profit is counted |
| Exact green `Payment complete` row appears | Persist its final price as authoritative payment truth | Implemented |
| Exact `Attributed GMV` metric appears under the unique analytics boundary | Persist only its sanitized exact/compact USD display under the worker-resolved active stream | Implemented; independent of Sold Items and no aggregate-to-cents conversion |
| A bidding-identity, Sold Items, or payment update is persisted | Invalidate and refetch the open tagger's canonical view; follow a changed active bidding marker only when the employee was already viewing the current auction, while retaining a historical selection as options update | Implemented; bidding identity is not sale truth |
| A validated live bid changes | Send a separate data-free notice, read the single transient record, and update only the live panel | Implemented; no reconciliation/report write or full inventory rerender |
| Exact `Payment failed` changes to `Canceled` or `Payment complete` | Persist and display each distinct state live | Implemented; cancellation releases allocation, while priced completion commits when mapped |
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

The End confirmation also exposes a deliberate **End without report** action that skips
report preparation and persistence. If preparation or persistence fails, normal
report-aware End fails closed and leaves the stream active with the same no-report action
available for recovery, so a local-storage problem can never trap the employee in an
active tracker session. A worker restart repairs a
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
Print/PDF preserves the disclosure's user-selected state, so a collapsed variation table
stays collapsed and an explicitly opened table prints in full.

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

The extension-owned report page loads only the local saved record. It supports native
Chrome Print / Save as PDF, a Google Sheets-ready six-column CSV download, and a matching
full-table clipboard copy for pasting at A1. Its handoff instructions start collapsed
behind a screen toggle beside those two actions, while print styling includes the full
instructions. The two screen-only correction disclosures have different authority
boundaries.
**Finish unresolved payments** exposes only canonical-unresolved `payment_fixing` or
temporary `payment_failed` orders. Cancellation needs no price and releases the
reservation; completion requires a seller-verified positive final price and commits the
mapped unit. This canonical payment correction remains limited to the newest eligible
report while no tracker stream is active and its baseline/stream are still current.
**Correct SKU Unit Cost** is available on every finalized current or archived report. It
lists every SKU saved in that report's inventory, including unsold SKUs, accepts exact
nonnegative integer-cent costs, and requires confirmation. The worker replaces only that
same saved report while preserving its report/stream identity, timestamps, baseline
reference, lifecycle, and archive tier. Cost correction updates
completed-sale costs/profits, COGS, gross profit, margins, estimated profit after fees,
top-profit rankings, exact-SKU/product totals, and the six-column handoff; it does not
change payment facts, prices, quantities, GMV, AOV, fee estimates, canonical inventory,
other reports, the live tracker, or future streams. The stream-variations disclosure starts
collapsed on screen. Printing preserves its state and includes its rows only when the
employee opened **Show details**. The SKU performance table is part of the normal screen
and printed report output, and printed tables retain repeated column headers. The
screen-only unit-cost correction disclosure is the final report section. These are
employee-initiated local outputs, not Google API writes.

The seller reports that completed rows remain scrollable during a stream, but broader
live testing must still determine whether the entire list is always rendered or
virtualized. No underlying TikTok API or network payload has been selected. The current
capture can only report facts that reached durable reconciliation state before End.

## 5. Employee tagger — Live session implemented

The tagger is a Chrome side-panel interface based on the current mockup. The employee
should never type a variation number or interact with the hidden SKU.

The Chrome side panel is a single **Live session** employee workspace. It requires a
persistent local active stream, restores the last durable reconciliation state, persists
mapping corrections, and displays loading, saving, success, and retryable error states.

Before Start, Live session presents Google Sheets inventory import followed by the local
Start controls. Once a stream is started or resumed, the tracker workspace and Variation
selector move directly below the header. The Local stream session section containing End
is the last substantive section, followed by one saved-state footer indicator. While the
stream is actively tracking, that section compacts to its tracker-active date row, moves
the **Active** pill into the row, hides the redundant heading and safety note, and retains
the **End Stream Tracking** action. Setup, resume, loading, and error states retain the
full lifecycle context. A duplicate saved-status box is intentionally omitted. Retryable
error alerts remain available near the top so failures are not hidden by that layout.
After End, the inactive side panel shows up to five **Business Records**. Each record
shows its tracking-start timestamp as the default name, completed/total sales, and exact Gross Item Sales,
then opens the
same extension report page in a new tab. **View archived reports** switches to a managed
archive of up to 25 additional records; archived records remain openable and therefore
retain the report page's PDF and inventory-download actions. **Back to Business Records**
returns to the five current slots. Report-list Retry refetches the canonical library; the
panel does not read `chrome.storage` directly.

Each current record's **More actions** menu can assign an optional local display name or
move that record into archive. Renaming changes neither the canonical report snapshot nor
its immutable report/stream IDs; the display name survives reload, archive, restore, and
report-only corrections. The report cover shows that name (or the tracking-start timestamp fallback),
while its footer retains the stream reference. Archived
selection mode supports Select/Select all/Clear selection, atomic **Restore selected**
into currently available Business Records slots, and **Delete selected** behind an
explicit permanent-delete confirmation. Restore rejects the entire selection when it is
larger than the available slot count. Archive deletion applies only to archived records;
canceling confirmation or any failed worker command changes nothing.

Direct PDF export is a read-only side-panel workflow. `report/report-downloads.js`
snapshots IDs, loads all records through the existing report client, normalizes and
sanitizes final filenames, then rejects the whole batch on case-insensitive collisions.
`report/report-pdf.js` reuses report-page presentation and summary calculations to
render a local, selectable-text PDF with bundled jsPDF/AutoTable and embedded DejaVu Sans.
All printed tables are included in direct exports, with repeated headings and no editing
controls; browser print still preserves the on-screen variation disclosure state.
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
- A compact **Add new SKUs from Sheet** action that appears only in a loaded active
  workspace. It accepts the same Sheet link/ID, reads the complete `Inventory` tab, and
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
  displayed variation. Historical selection, the mapped current/newest variation, and a
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
  unique current-stream variation only after exact terminal `Canceled`; active bidding,
  `not_observed`, processing, fixing, temporary failed, completed, and unrecognized
  variations are excluded. The payment-error count includes canonical-unresolved
  variations whose latest observation is `payment_fixing` or temporary `payment_failed`;
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
fails, the normal action preserves the active stream and offers an explicit **End
without report** fallback.

Ended streams cannot be reopened in the tagger. The guarded payment-buffer correction is
limited to the newest safe report; report-only SKU-cost correction is available on any
finalized current or archived report.
Employees should finish mapping corrections and wait for expected capture retries when
practical. Report links appear after End and open the local printable page; no automatic
Google Sheet write occurs.

The live selector lists only persisted variations for the active local stream and keeps
mapping unavailable until at least one such record exists. If the controller still holds
its internal unrecorded startup placeholder, the first canonical view selects the newest
recorded variation. A non-null `activeBiddingVariationNumber` is the effective current
variation. A changed marker takes focus only when the employee was already viewing the
previous current/latest variation. If the employee manually selects history, new
variations and status changes continue updating the closed combobox without taking focus;
the compact **Return to live item** action appears while history is selected. It targets
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

Next tagger work includes:

- Turn the live-refreshed variation history into a prioritized queue of records needing
  attention.
- Prioritize completed-but-unmapped sales and capture-generated conflicts as they arrive.
- Display capture connection/delivery state and extend current-bidding auto-follow into a
  prioritized queue without reading Chat or widening either strict dashboard boundary.
  The isolated aggregate analytics metric remains display-only and never prioritizes or
  identifies a sale.

The production tagger is planned as a queue rather than a blocking modal so an employee
can catch up when multiple variations need attention. The current combobox updates from
durable capture state and proves multi-variation navigation and correction, but it is not
yet a prioritized work queue.

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
outcomes fail closed. Replacement preserves whether the report is in Business Records or
Archived Reports. Report renaming is a separate active-Business-Record mutation on the
saved wrapper, so it cannot change calculations, exports, or report identity.

The finalized library has two tiers under a combined cap of approximately 4 MiB: no more
than five non-archived **Business Records** and no more than 25 archived records, with 30
total records. At most one non-archived `pending_end` record temporarily stages the
report-aware End transaction. It is hidden from both employee lists, is never eligible for archive/restore/deletion,
does not consume one of the five finalized Business Records slots, and still counts
toward the total-record and byte caps. A small fixed allowance lets a valid near-cap
version-1 envelope acquire archive fields and reserves bounded room for optional report
names without data loss while keeping the effective enforced ceiling approximately 4 MiB.
The manifest requests `unlimitedStorage` to remove Chrome's normal
[`chrome.storage.local` quota](https://developer.chrome.com/docs/extensions/reference/api/storage#property-local)
for the extension's persisted data. The five-current/25-archived report limits and
`MAX_ARCHIVE_BYTES` remain application-enforced, independent of that permission.
This permission-only safeguard does not introduce a storage-schema change, migration,
pruning, or deletion. It also does not bound reconciliation history, eliminate the cost
of processing and saving that history, or prevent disk/resource failures.

Finalizing what would be a sixth
Business Record atomically moves the oldest finalized Business Record into archive when
capacity permits. Equal end times use report identity as the stable tie-break.

There is no automatic report deletion. If the archive already contains 25 reports, the
combined byte cap is reached, or no finalized current record can move, preparation fails
before the active stream is cleared and leaves every record intact. Manual archive,
multi-report restore, and archived-only deletion are serialized worker operations.
Archive and restore are all-or-none; restore additionally rejects a selection larger
than the available Business Records slots. Permanent deletion accepts only archived
records and requires the separate employee confirmation in the panel. Clearing extension
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

A second FIFO coordinator owns `get_stream_session`, `start_stream`, `end_stream`, and
the explicit `end_stream_without_report` recovery command. Only the worker can generate
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
closes. While history is selected, a compact **Return to live item**
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

The tagger runtime client deliberately exposes no payment-complete command. The capture
runtime client has the inverse narrow authority: it may submit
only Sold Items variation numbers, one current bidding variation number, sanitized
payment-status codes, completed variation/price facts, and the sanitized Attributed GMV
display, never mappings, stream
lifecycle commands, raw badge or analytics text, or arbitrary state. The Sheets reader
is a separate worker-owned boundary used for pre-stream confirmation and explicit
active-stream SKU additions. The local report may serialize a
six-column clipboard/CSV replacement table, but outbound Google Sheets API writes belong
to a later stage.

Exact pre-completion `Canceled` is authoritative for allocation;
production refunds or post-completion cancellations still require their own future event
rather than reversing a `payment_complete` record.

### Google Sheets

Google Sheets is implemented as the inventory import source. The employee
authorizes a Google account through Chrome, supplies one spreadsheet ID, reviews the
normalized `Inventory` preview, and explicitly confirms it as a new durable local
baseline. The service worker owns authorization, network access, preview state, baseline
creation, and all active-stream checks; neither the dashboard content script nor the side
panel receives an access token.

Google Sheets is not the live transactional source of truth. Once confirmed, the local
baseline scope drives tagging, inventory, and basic profit without automatic Google
requests. An employee may explicitly re-read the same full `Inventory` tab during an
active stream to append new SKU rows under the strict rules below. At End, the tracker
saves its report locally first and can copy or download a
Google Sheets-ready six-column replacement table. It does not call the Sheets write API.
A future automatic-sync stage must keep the local report as its durable source, then
batch and retry writes so a temporary connection problem cannot interrupt tagging or
erase the report.

The novice handoff is position-based, not a SKU lookup or merge: duplicate the current
`Inventory` tab as a backup, use **Copy Updated Inventory**, click the original tab's A1
cell, and paste the full six-column rectangle. The matching CSV alternative is imported
with **Replace current sheet** only after that backup.

## 7. Google Sheets inventory import contract

The canonical starter file is
[`google-sheets-inventory-template.csv`](google-sheets-inventory-template.csv). An
employee can import that file into Google Sheets or reproduce its exact six-column
header in an `Inventory` tab. This contract deliberately defines data and validation
separately from network access; the pure parser does not authorize Google or mutate
tracker state.

### `Inventory` tab

The first nonblank row must contain these exact, case-sensitive headers. Column order may
vary, but missing, duplicate, or unknown headers make the whole import invalid.

| Column | Required value |
| --- | --- |
| `sku` | Uppercase key matching `^[A-Z0-9][A-Z0-9._-]{0,63}$`; unique in the confirmed baseline |
| `item` | Nonblank employee-facing product name up to 160 characters, such as `Stussy tee` |
| `style` | Optional color, design, or distinguishing style up to 160 characters, such as `black`; blank is valid when the item has no style variant |
| `size` | Nonblank size label up to 80 characters for this exact SKU row; every size needs a unique SKU |
| `quantity_on_hand_at_import` | Nonnegative safe integer representing the physical count when this baseline is confirmed |
| `unit_cost` | Nonnegative US-dollar decimal with no symbol and at most two fractional digits, such as `12.00` |

An all-blank row is ignored. In a data row, every field except `style` is required.
Formula cells are invalid: import values are data and must never be evaluated by the
tracker. The Google adapter reads `userEnteredValue`, preserving formula cells for this
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

The pure preview parser validates the header and every nonblank row before any inventory
baseline may be appended. Validation includes required fields, types, SKU syntax and
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
fixed whole-sheet `'Inventory'` range. It asks for grid `userEnteredValue` data so formulas
remain distinguishable and invalid rather than being accepted as their evaluated result.
The adapter accepts at most 1,000 inventory rows beyond the header. Response bytes,
columns, cell slots, issue counts, retries, and request duration are also bounded before
data reaches the pure parser. An oversized or invalid Sheet fails as a whole; it is never
truncated into an apparently confirmable baseline. API error bodies and raw Sheet
contents are not exposed to the side panel or application logs.

Preview and confirmation are distinct operations:

1. Preview checks that no local tracker stream is active, authorizes interactively,
   reads and validates the complete `Inventory` tab, and returns detached normalized rows
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
5. During an active stream, **Add new SKUs from Sheet** sends only the extracted Sheet ID.
   The worker derives the active stream and expected baseline itself, checks that stream
   before and after the network read, and passes the complete validated snapshot to the
   internal append-only command. Every existing row must match by SKU across all six
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

### `Sales` tab

| Column | Source or meaning |
| --- | --- |
| `stream_id` | Verified TikTok session identifier; export remains blocked while it is unknown |
| `variation_no` | TikTok's `Variation: #N` value |
| `sold_price` | Final price from a payment-complete row |
| `payment_status` | Canonical `unknown`, `canceled`, or `payment_complete` sale truth |
| `observed_payment_status` | Latest sanitized Sold Items status: not observed, processing, fixing, failed, canceled, complete, or unrecognized |
| `mapping_status` | Current saved state uses `unmapped` or `mapped`; legacy v1-v6 `marked_unpaid` is normalized during migration |
| `status` | Derived engine status such as `mapped`, `pending`, `canceled`, `unmapped_completed`, or `committed` |
| `sku` | Employee-selected inventory key; blank while unmapped |
| `unit_cost` | Cost snapshot used for the current mapping |
| `gross_profit` | Final completed sale price minus unit cost |
| `observed_at` | When the extension observed the event; not guaranteed to be TikTok's exact sale time |
| `conflict` | Optional warning requiring review |

Buyer fields are not part of the current capture event. They can be added later only if
the client needs them and the privacy/retention requirements are defined.

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
intentionally contains no service-account placeholders. A future backend could own a
service account only as a separately secured and documented architecture.

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

- Do `Payment processing` and `Payment fixing`
  exactly match production text across accounts/locales, and what transitions are valid?
- Do production transitions preserve the confirmed allocation rule across accounts: a
  mapped bidding item stays pending through processing, fixing, temporary failed,
  unrecognized, and price-less completion observations until exact `Canceled` or priced
  `Payment complete` resolves it?
- Does the observed `m4b_space` Sold Items identity remain unique across different
  accounts, streams, modes, scrolling states, and TikTok deployments?
- Do the exact visible `auction-pin-card` boundary, direct-own-text `#N` identity, and
  direct-own-text `Bids: $...` value remain unique and stable across accounts, modes,
  bid speeds, streams, and TikTok deployments?
- Is the Sold Items list virtualized or replaced as it grows, and can every earlier row
  be recovered by the initial/backfill scan?
- Does any relevant content live inside an iframe or shadow root?
- What stable TikTok-provided value identifies one stream, survives route re-entry and a
  full refresh, and differs across two streams?
- Does the implemented route/body/root recovery remain reliable under TikTok's live
  rendering?
- Can a verified TikTok ID safely automate the local-session boundary across a full
  refresh and a second stream?
- Do auctions with no bids appear in any trackable list?
- Does rendered-history backfill capture every completed sale before the local End
  snapshot, especially when Sold Items is virtualized?

Browser support beyond Chrome is a later decision.

## 10. Development sequence

1. **Completed:** sale parser and read-only capture probe.
2. **Completed:** reconciliation engine and automated tests.
3. **Completed:** tagger foundation, grouped multi-size inventory cards with exact-SKU
   actions, mapping workflow, and captured payment lifecycle display.
4. **Completed:** versioned storage, service-worker coordination, tagger integration, and
   visible recovery.
5. **Capture hardening completed:** bounded scheduling, SPA lifecycle recovery, exact
   variation and badge targeting, unique visible Sold Items root narrowing, the isolated
   strict Attributed GMV locator, the unique visible on-video bidding-card locator, and
   scoped capture tests. Verified TikTok identity remains open.
6. Capture-to-engine-to-tagger integration in three stages:
   1. **Completed:** persistent local active-stream sessions and Start/Resume/End UI;
   2. **Completed:** persist the on-video active bidding marker, Sold Items
      variation/payment facts, and the sanitized Attributed GMV display under the
      worker-resolved active local stream;
   3. **Completed:** data-free invalidations refresh the open tagger in real time,
      auto-follow each changed bidding variation before it sells while the employee is
      viewing the current auction, preserve a manually selected historical variation as
      newer options update, provide a mutation-free **Return to live item** action that
      falls back to the newest captured variation when no bid is active, and visibly
      update sanitized payment status and the Metrics section. A prioritized work queue,
      visible capture state, TikTok identity,
      and broader live validation remain next.
7. Connect Google Sheets inventory in three stages:
   1. **Completed:** exact template, pure validation, detached preview, and opening
      baseline contract;
   2. **Completed:** immutable versioned inventory baselines, physical-count-lineage
      associations, baseline-scoped inventory/cost accounting, atomic append-only live
      SKU additions, report-only cost correction, and strict legacy migration; and
   3. **Completed:** browser OAuth, fixed-range Sheet reading, detached preview,
      employee confirmation, and durable import.
8. **Completed:** strict end-of-stream projection, report-aware End/recovery,
   two-tier local Business Records/archive library, printable/Save-as-PDF business page,
   exact SKU and combined
   product analytics, and six-column clipboard/CSV inventory handoff.
9. Optional automatic Google Sheets writes, broader real-stream report validation, and
   release hardening.
