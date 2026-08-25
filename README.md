# TikTok Live Tracker

A browser-based tool for tracking TikTok LIVE auction sales. TikTok supplies the
completed sale and final price, an employee identifies the physical item, and the
tracker combines those facts to calculate inventory and gross profit.

> **Project status:** early browser prototype. The tracker now reads the current
> bidding variation number and bid price from the on-video auction card and observes the live
> **Sold items** panel for sale and payment truth under the active local tracker
> stream. It persists sanitized payment-status changes plus exact green
> `Payment complete` prices through the service worker.
> An open Live session side panel refetches saved state as those records change, without
> requiring a TikTok-page refresh or panel reopen. Before Start, an employee can now
> authorize read-only Google Sheets access, preview and confirm the exact `Inventory`
> tab, and save it as an immutable local inventory baseline. The tracker also mirrors TikTok's
> isolated **Attributed GMV** display under the active stream. Ending tracking now freezes
> a local business report, opens a printable/Save-as-PDF page, and provides a complete
> six-column Inventory table plus a Google Sheets-ready CSV. A dedicated employee work
> queue beyond the single next-item shortcut, verified TikTok stream identity, and
> automatic Google Sheets writes are not implemented yet.

## How it works

Each auction has a sequential variation number such as `#203`. Based on the seller's
current workflow, variation numbers restart for each stream, and each variation
represents one auction of one physical item.

While the item is on screen, an employee selects its item, style, and size from the
tracker's inventory menu. The tracker stores that selection as a mapping; it does not
enter a price or perform any action on TikTok. Clicking the selected inventory card
again removes only that item mapping and leaves TikTok's payment result unchanged.
On the current/newest variation, right-click maps it when it has no item and then toggles
one SKU for automatic mapping to the next newer live variation. While an older variation
is displayed, right-click instead maps, corrects, or unmaps only the current/newest
variation and never changes the queue; left-click continues to edit the displayed
historical variation.

The tracker counts the sale only after TikTok shows the final price with the green
`Payment complete` badge in the **Sold items** panel:

> A sale counts, gross profit is recorded, and stock decreases **only when TikTok shows
> payment complete and the variation is mapped to an inventory item**.

A real TikTok `Payment complete` event is authoritative and cannot be undone by this
extension. Employees can correct the mapped inventory item, but they cannot reverse
TikTok's payment state.

The tagger also shows the latest observed Sold Items badge independently as **Payment
processing**, **Payment fixing**, **Payment failed**, **Canceled**, **Payment complete**, or
**Unrecognized payment status**. Selecting inventory during bidding immediately reserves
one unit. That reservation stays pending through processing, fixing, temporary payment
failure, an unrecognized badge, or a temporarily price-less completion. It resolves only
when TikTok captures a priced **Payment complete** or the exact terminal **Canceled**
badge.

An exact TikTok **Canceled** badge is canonical and terminal for inventory allocation. It
keeps the variation linked to its selected item for history, releases that reservation,
restores the unit to availability, and never counts the cancellation as a sale, revenue,
or profit. While reviewing a canceled variation, the employee can map, correct, or clear
its item as a reference showing what was auctioned. Those reference-only changes never
reserve or subtract stock and never change any metric. Live mode has no manual mark-unpaid
or undo-unpaid control; TikTok's exact payment lifecycle is authoritative. If the item is
auctioned again, the employee maps its new variation number.

## Current implementation

### Implemented and tested

- A Manifest V3 Chrome extension whose isolated capture script is available only on the
  exact `https://shop.tiktok.com` host and activates only on the exact TikTok LIVE
  dashboard path.
- A responsive Chrome side-panel prototype with imported Google Sheets inventory, search, pending reservations,
  zero-stock and oversold states, one-click item mapping and unmapping, and an accessible
  current/previous variation combobox and listbox. The active on-video auction is labeled
  `bidding` and can be mapped before the sale reaches Sold Items. Payment wording is yellow
  for bidding, processing, fixing, and temporary failure; red for cancellation; green for
  completion; and neutral for other states. The separate item segment is green whenever an
  item is selected, including for a canceled reference, and orange when no item is selected.
  While the employee is viewing the current auction, the next auction is selected
  automatically. A manually selected historical variation stays selected while newer
  auctions continue being captured. Opening the listbox freezes only its visible options
  and scroll position; capture and persistence continue, and the newest queued option view
  is applied once when the employee selects or dismisses the listbox. Inventory cards show
  remaining stock separately from pending reservations.
- A one-item **next variation** shortcut on those inventory cards. On the current/newest
  variation, right-click maps it when unmapped; after it has any mapping, right-click
  queues or unqueues that SKU without changing the current selection. While history
  remains displayed, right-click maps or remaps the worker-verified current/newest
  variation; right-clicking its selected SKU again unmaps it. This action cannot create,
  replace, or clear a queue. Left-click always maps or unmaps the variation actually
  displayed. During historical review, the displayed mapping stays green, the mapped
  current/newest variation stays blue even between auctions, and a shared SKU uses a
  split green/blue outline. A pre-existing queue remains active and red. The queue survives
  side-panel closure, TikTok page reload, and service-worker suspension within the same
  tracker stream, applies only to the next genuinely newer live bidding variation, never
  overwrites an existing mapping, and is cleared by End or an extension reload.
- An active-stream **Add new SKUs from Sheet** action for unplanned items. The employee
  adds the rows to the same `Inventory` tab, pastes that Sheet link or ID, and explicitly
  checks and adds them without ending tracking. The Sheet must be a complete append-only
  snapshot: row order may change, but every existing SKU and its item, style, size,
  opening quantity, and unit cost must be unchanged. Only brand-new SKU rows are accepted.
  A successful update preserves every captured variation, payment state, mapping,
  completed count, and pending reservation; a mismatch or changed stream saves nothing.
  Keep the TikTok dashboard open until the bounded Sheet check finishes because worker
  writes and End briefly queue behind that request, then catch up in order.
- A compact **Live auction** panel that stays visible throughout an active local tracker
  stream, including while an employee reviews an older variation. A newly detected
  on-video auction immediately changes its heading to `Variation #N` and clears the prior
  values until its first valid bid arrives. Once mapped, it also shows the pinned unit cost
  and pre-fee live gross profit (`current bid - unit cost`), with negative, break-even, and
  positive results styled distinctly. When bidding ends, the panel retains that auction's
  last variation, bid, cost, and profit until the next auction begins; before any auction
  has been detected it shows `Variation # -` and dashes. This temporary display never
  changes final sale, inventory, metric, or report accounting.
- A bottom **Metrics** section showing **Gross Item Sales** as the current-stream sum of
  sold prices from every priced `Payment complete` order, including completed orders
  that still need an item. **AOV** is that exact Gross Item Sales total divided by the
  number of uniquely priced `Payment complete` orders in the same tracker stream, rounded
  to the nearest cent and displayed as `$0.00` when there are none. It includes mapped and
  unmapped completions and excludes bidding, processing, fixing/temporary-failed,
  price-less, and canceled orders. A separate **Total GMV** card mirrors TikTok's captured
  Attributed GMV display, which includes buyer-paid shipping. One combined **TikTok 6%
  Fees** card derives two display-only estimates from that same Total GMV: **Fees paid:**
  is `Total GMV * 6%`, and **GMV after fees:** is `Total GMV * 94%`. Both always use the
  approximate-equal sign and round to the nearest whole dollar. An exact TikTok display is
  calculated from its captured amount, a compact display such as `$4.64K` is calculated
  only from that displayed compact magnitude, and a missing Total GMV shows an em dash.
  These estimates are not accounting or net-revenue figures and do not change sales,
  inventory, COGS, or profit.
  **Est. Profit After Fees** calculates `Total GMV * 94% - mapped completed COGS`
  without first rounding the 94% amount, then shows the final result as an approximate
  whole dollar. It can show a loss, displays an em dash when Total GMV is unavailable,
  and gives an explicit count-based **Incomplete** warning while completed sales still
  need inventory items. Bidding, processing, fixing/temporary-failed, canceled, and
  unmapped completed orders add no unit cost to this estimate.
  **Completed Sales/Total Sales** shows the number of uniquely priced canonical
  `Payment complete` orders over unique current-stream variations whose latest observed
  outcome is `Payment complete`, `Payment failed`, or `Canceled`. The numerator includes
  mapped and unmapped completions. Active bidding variations and `Not observed`,
  `Payment processing`, `Payment fixing`, or unrecognized statuses are excluded from the
  denominator. One compact order-status card contains **Canceled Orders:** and
  **Payment Fixing:**. Canceled Orders counts each unique current-stream variation only
  after TikTok reports the exact terminal `Canceled` badge. It excludes active bidding,
  `Not observed`, processing, fixing, temporary `Payment failed`, completed, and
  unrecognized variations. Payment Fixing counts unique unresolved variations whose
  latest badge is either `Payment fixing` or the temporary `Payment failed` shown during
  TikTok's correction buffer. It excludes processing, active bidding, `Not observed`,
  unrecognized, completed, and canceled variations, and clears an order from the count
  when it reaches either terminal result. Neither count depends on inventory mapping.
  **Gross Profits** is the sold-price
  revenue from mapped, completed orders minus their pinned Google Sheets unit costs.
  Completed orders without an inventory match are excluded from that subtotal and produce
  an incomplete-count warning until they are mapped.
- A **Live session** workspace with explicit Start, Resume, and End controls. The
  worker-made local stream ID
  survives side-panel, browser, and service-worker restarts, while End keeps
  reconciliation history and does not act on TikTok LIVE.
- An explicit **End Stream Tracking** flow. Its confirmation offers the normal
  **End and create report** action plus a smaller **End without report** choice. Normal
  End projects the current durable stream and baseline into one strict local report
  before the active-session pointer is cleared, then opens its extension-owned report
  page. Unresolved payment states, pending reservations, unmapped completed sales,
  capture conflicts, an active bidding marker, or oversold inventory never block report
  creation; they appear as explicit attention notices and counts in the report.
- A two-tier local report library. **Business Records** keeps up to five current reports;
  **Archived stream reports** keeps up to 25 more, subject to a conservative combined cap
  of approximately 4 MiB in `chrome.storage.local`. Saving a sixth Business Record
  atomically moves the oldest finalized one into archive when space permits—nothing is
  silently deleted.
  If all five current slots and 25 archive slots are occupied, the archive byte cap is
  reached, or no finalized record can move safely, report-aware End fails before clearing
  the active stream and preserves every existing report. The employee can free archive
  space and retry, or deliberately use **End without report**.
- Current and archived reports open the same local report page, where they can be printed
  or saved as a PDF and can copy/download the formula-injection-safe Google Sheets
  inventory handoff. Every finalized current or archived report also includes a collapsed
  **Correct SKU Unit Cost** control for every SKU in that report's inventory baseline,
  including unsold SKUs. After confirmation, the worker updates only that saved report,
  recalculates its dependent metrics, and refreshes its Sheet handoff. Canonical inventory,
  other saved reports, the live tracker, and future streams remain unchanged. The newest
  safely correctable report also lists orders that ended in
  TikTok's `Payment fixing` or temporary `Payment failed` buffer: after tracking has ended,
  the employee can confirm terminal cancellation or enter the seller-verified final price
  and mark the order complete. The worker updates canonical inventory/payment state and
  regenerates the same report rather than editing display text alone. Current reports can
  be archived manually when space permits.
  Archived reports can be restored only into available Business Records slots, with a
  multi-selection restore performed atomically. Archive deletion supports Select, Select
  all, Clear selection, and one explicit permanent-delete confirmation; canceling or a
  failed request changes nothing. The **Item variations this stream** section is collapsed
  by default for screen browsing and remains collapsed in printed/PDF output unless the
  user opens **Show details** before printing. The screen-only **Correct SKU Unit Cost**
  disclosure appears at the bottom of the report.
- End-of-stream analytics containing captured completed/canceled/fixing counts, exact
  **Gross Item Sales**, its completed-sale **AOV**, TikTok's last
  Attributed GMV display, its approximate **TikTok 6% Fees** breakdown and **Est. Profit
  After Fees**, mapped COGS and gross profit, combined completed/canceled stream-variation
  rows, exact-SKU performance, combined item-and-style product performance across sizes,
  and all ties for top sold and top profitable entries. The baseline-wide inventory
  handoff retains
  opening, sold, pending, calculated, oversold, and recount details for every SKU.
- Restoration of mappings, reservations, and prior variation records after the side
  panel or browser is reopened. Older saved manual-unpaid records are normalized back
  into the automatic TikTok payment lifecycle during migration.
- Loading, saving, retry, and fail-closed error states that keep the last successfully
  saved view visible when a command fails.
- A read-only `MutationObserver` capture probe with bounded scheduling so ordinary
  dashboard updates cannot indefinitely postpone scans while the page is executing.
- SPA lifecycle recovery that responds to route and page-resume signals, uses a 250 ms
  fallback check, and cleans up or restarts the observer and scheduler when the route or
  any scoped root changes. Sanitized, same-body delivery outboxes keep already parsed
  Sold Items facts, the newest bidding variation/bid pair, and the newest Attributed GMV
  display draining across root replacement; leaving the route or replacing the body
  discards those page-scoped queues.
- A live-validated Sold Items boundary that requires exactly one visible
  `[data-tid="m4b_space"]` root. Capture stops and retries when that selector is missing
  or ambiguous, and individual-sale parsing never scans the video, Chat, analytics, or
  the rest of the dashboard. A separate analytics-metric locator is restricted to the
  exact visible `#guide-Step-2` boundary (with an explicitly allowlisted lowercase ID
  fallback), one exact `Attributed GMV` label, and that label's primary value region.
- A separate fail-closed current-auction locator that requires exactly one visible
  `auction-pin-card` class-token boundary and one visible direct-own-text value beginning
  with `#N`. Within that same unique card, live-bid capture separately requires exactly
  one visible direct-own-text value matching `Bids: $...`. It releases only the positive
  variation number and sanitized positive integer cents; it never releases raw card text,
  item title, bidder, image, or other content, and the bid is never sale/payment truth.
- Strict row-local matching for exact `Variation: #N` labels and exact
  `[data-tid="m4b_tag"]` badges. The allowlist recognizes `Payment processing`,
  `Payment fixing`, `Payment failed`, `Canceled`, and `Payment complete`; any other nonempty badge is
  stored only as `unrecognized`, never as raw page text. Generic tag counts and generated
  CSS classes are not capture inputs. Incidental buyer and product text in the same row
  is never selected as a field, logged raw, transmitted, or saved.
- A strict six-event capture protocol and runtime client that send only observed
  Sold Items variation numbers, the current bidding variation number, sanitized
  payment-status codes, a completed variation's integer-cent price, a current
  `(variation number, bid-price cents)` pair, or one canonical exact/compact USD
  Attributed GMV display. The page sends no
  stream ID, buyer data, raw badge, auction-card, or analytics text, source HTML, or other
  DOM content.
- A worker-owned capture integration that authorizes only the top-level product
  dashboard, resolves the active local stream itself, and persists observations and
  payment changes through the serialized reconciliation coordinator.
- A data-free capture-state invalidation sent only after the worker accepts a durable
  capture update. An open Live session side panel validates and coalesces those notices,
  then refetches canonical state so new variations and payment changes appear live
  without trusting page-supplied state.
- A separate data-free live-bid invalidation after the worker accepts a transient bid.
  The panel responds with one lightweight live-bid read and updates only the compact live
  values; rapid bids do not trigger a full reconciliation refetch or inventory rerender.
- Ack-based delivery with retry and bounded backoff. Repeated DOM scans, page reloads,
  and service-worker restarts remain idempotent for the same local stream.
- A pure capture-event registry that keeps diagnostic page-load and verified-stream
  scopes separate. Canonical stream assignment is instead performed by the worker.
- A parser for variation number, final US-dollar price, and `Payment complete` text.
- An offline reconciliation engine that:
  - stores immutable inventory snapshots and assigns each tracker stream to one
    physical-count baseline lineage;
  - scopes stock, pending reservations, and committed costs to that lineage so a
    later physical recount does not subtract historical sales twice;
  - derives an expanded immutable snapshot for a strict active-stream SKU append and
    advances the entire shared lineage without changing any existing row or allocation;
  - accepts employee mapping and payment events in either order;
  - prevents identical events from deducting inventory twice;
  - calculates remaining inventory, Gross Item Sales, and gross profit;
  - reserves a selected unit from bidding until priced completion or cancellation,
    separately from completed sales;
  - treats exact `Canceled` as a terminal inventory-allocation result that preserves the
    item link, releases its reservation, and contributes no sale or money;
  - treats cancellation as terminal for payment while allowing later mapping, correction,
    or click-again unmapping only as a reference to the auctioned item;
  - guarantees canceled reference mappings never reserve or subtract inventory and never
    contribute sales, revenue, COGS, profit, AOV, or product-performance metrics;
  - keeps payment results exclusively dependent on captured TikTok truth;
  - applies completed historical corrections atomically by restoring the old SKU,
    decrementing the new SKU, and recalculating its cost snapshot and gross profit;
  - keeps zero-stock inventory selectable and surfaces `Oversold by N` instead of
    disabling the card;
  - surfaces unmapped sales, conflicting prices, and inventory shortages;
  - keeps auctions distinct by `(streamId, variationNumber)`.
- A versioned persistence adapter that validates and saves detached reconciliation
  snapshots, reports typed storage/corruption/version errors, and never silently
  replaces corrupt or future-version data. Reconciliation state is version 7 and stores
  the sanitized Attributed GMV display plus the nullable active bidding variation per
  stream, with strict version-1 through version-6 migration. Any legacy saved Live
  `marked_unpaid` record migrates back to a mapped or unmapped unresolved order so
  automatic TikTok payment tracking resumes. Legacy completion-after-cancellation
  conflicts migrate to terminal cancellation and release their stale sale allocation;
  the outer storage envelope remains schema version 1.
- A service-worker coordinator that loads stored state once per worker lifetime,
  processes commands in order, saves before publishing changes, and keeps the last good
  state when a command or write fails. Full recount-baseline creation is blocked while a
  local tracker stream is active; the separate append-only action can derive and verify
  an expanded baseline for that active stream without changing existing rows.
- A browser-managed Google OAuth import flow that reads only the selected spreadsheet's
  exact `Inventory` tab with the read-only Sheets scope. The side panel accepts a Sheet
  ID or safe `docs.google.com` sharing link, displays a detached normalized preview and
  summary, and creates an immutable opening baseline only after explicit confirmation.
  During tracking, the employee may paste the same reference again to append validated
  new SKUs; neither flow writes to Google Sheets.
- A race-safe confirmation boundary: previews are short-lived and worker-memory-only;
  confirmation re-reads the Sheet and rejects a changed or expired preview without
  importing partial data. Import, Start, and active-stream checks share the worker's
  serialized command queue.
- A separate versioned active-stream record and coordinator. The worker generates its
  `local-stream:<uuid>` identity, saves it before reporting Start, restores it for Resume,
  requires the expected ID before End so a stale panel cannot end a newer session, and
  verifies or repairs the active stream's inventory-baseline association on Start and
  Resume. A validated append-only Sheet update moves the entire shared baseline cohort to
  one derived immutable snapshot so prior allocations remain in the same count scope. A
  guarded Retry also repairs an older active session whose reconciliation state was
  never initialized, without replacing any existing canonical data.
- A strict tagger runtime client and controller that send employee mutations through
  that coordinator. Live UI and its runtime protocol expose mapping and unmapping only;
  no manual-unpaid command exists. The tagger never
  accesses browser storage directly and cannot create authoritative payment-complete
  events.
- Automated capture, parser, reconciliation, persistence, service-worker, and tagger
  tests using Node's built-in test runner.

### End-of-stream report calculations

The saved report is generated from the durable data captured when the employee confirms
**End and create report**. The newest safe report can resolve an unfinished
fixing/failed-buffer payment from canonical state. Separately, any finalized current or
archived report can receive a report-only SKU unit-cost correction. Both operations
preserve the same report identity and archive tier, but a cost correction changes only
the selected saved report and its handoff; it does not change canonical inventory, other
reports, the live tracker, or future streams. Its figures are deliberately separate:

- **TikTok Attributed GMV** is the last exact or compact display captured from TikTok.
  It may be rounded and, per the product requirement, can include buyer-paid shipping.
- **TikTok 6% Fees** is a two-line estimate derived from that frozen Attributed GMV
  display. **Fees paid:** is `Total GMV * 6%`; **GMV after fees:** is
  `Total GMV * 94%`. Both are prefixed with `≈` and rounded to the nearest whole dollar,
  even when TikTok supplied exact cents. Exact displays use that captured amount; compact
  displays such as `$4.64K` use only their displayed compact magnitude and therefore do
  not imply unavailable precision. A report with no captured Total GMV displays an em
  dash for both values. This simple estimate does not account for refunds, discounts,
  taxes, shipping treatment, other TikTok charges, or any seller expense, so it is not an
  accounting statement or net revenue.
- **Est. Profit After Fees** is `(Total GMV * 94%) - mapped completed COGS`, with
  the 94% amount kept unrounded until after exact cent-based COGS is subtracted. The final
  result is prefixed with `≈` and rounded to the nearest whole dollar; losses remain
  negative, and missing Total GMV displays an em dash. Only unit costs saved in this
  report for mapped completed sales are subtracted. Unmapped completed sales produce an
  **Incomplete**
  warning with their count, while bidding, processing, fixing/temporary-failed, and
  canceled orders contribute no COGS. This is an operational estimate, not true net
  profit: it does not model refunds, discounts, taxes, shipping expenses, ads, labor,
  other platform charges, or other business costs.
- **Gross Item Sales** is the exact sum of captured sold prices for every uniquely
  priced `Payment complete` order, including completed orders with no inventory mapping.
- **AOV** is `Gross Item Sales / completed Payment-complete sales`, rounded to the
  nearest cent. Its count is the same uniquely priced, stream-scoped completion count used
  by the completed-sales numerator, so mapped and unmapped completions contribute while
  bidding, processing, fixing/temporary-failed, price-less, and canceled orders do not.
  With no eligible completed sales, AOV is `$0.00`.
- **Completed / Total sales** is uniquely priced completed orders over unique variations
  whose latest captured outcome is complete, temporary failed, or canceled. The active
  bidding item, processing, fixing, not-observed, and unrecognized states are excluded.
- **COGS** is the sum of the seller unit costs saved for mapped completed sales, including
  any report-only unit-cost correction applied to this report. **Gross
  profit** is their sold-price revenue minus COGS; it is not net profit and excludes
  platform fees, shipping labels, refunds, ads, taxes, and other expenses. Unmapped
  completed sales remain in Gross Item Sales and the stream-variations table but cannot
  contribute COGS or gross profit.
- The collapsed **Item variations this stream** disclosure, labeled **Stream variations**,
  combines completed and canceled variations in variation-number order. Its count is the
  combined number of completed and canceled variations, and its **Status** column
  identifies each row. Completed rows retain their captured sale and mapped cost/profit detail.
  Canceled rows show the mapped or unmapped reference item but use no sale price, unit
  cost, or gross profit and never affect inventory or any metric. Compatible older reports
  retain their aggregate canceled count even when canceled row details are unavailable.
  Printing preserves this disclosure's current state, so rows appear in the PDF only when
  the user opens **Show details** first.
- **Exact-SKU performance** groups mapped completed sales by SKU, lists only mapped SKUs
  with at least one completed sale in that report stream, and sorts rows from highest gross
  profit to largest loss. Its final **Gross profit/loss** column uses signed values:
  positive values are green, losses are red, and zero is neutral. Pending, canceled,
  unmapped, and unsold entries are excluded. **Product performance** groups those same
  sales by `item + style` across all sizes/SKUs. Most-sold ranks use completed units;
  most-profitable ranks use gross profit; every tie is retained. **Avg. sale price** is
  that SKU's mapped completed-sale revenue divided by its mapped completed units, rounded
  to the nearest cent for display.
- **Gross margin** is SKU gross profit divided by SKU mapped revenue. **Sell-through** is
  the current stream's mapped completed units for that SKU divided by its opening
  quantity in the pinned baseline.

The inventory handoff covers every row in the pinned baseline, not only SKUs sold during
the stream. The report table displays every SKU's saved unit cost (including `$0.00`),
and its compact **Sold** column means completed mapped sales since the inventory baseline,
not only sales from the report's stream. Its calculated remaining count is opening
quantity minus all completed mapped sales across every stream pinned to that baseline.
Pending reservations are shown separately and reduce only the displayed
available-after-reservations amount. The Sheet replacement count is `max(0, calculated
remaining)`. If the raw calculated amount is negative, the report preserves that negative
result as an oversold/recount warning while exporting zero so Google Sheets never receives
a negative quantity. The copy and CSV actions remain the exact six-column Sheet handoff.

The report retains strict completeness metadata and reason codes internally, but the
employee UI does not display a Final/Provisional state label. Instead, it lists the
specific captured conditions that need attention: an active bidding marker, unresolved
order, pending reservation, payment-fixing order, unmapped completed sale,
reconciliation conflict, or oversold/recount warning. Those conditions never prevent the
employee from ending local tracking, but inventory and profit figures should be reviewed
before updating the Sheet.

### Not implemented yet

- A richer prioritized employee work queue beyond the current bidding-variation
  auto-follow behavior, which pauses while an employee reviews history.
- Visible capture connection, retry, and queue-drained status.
- Verified transition timing for TikTok's nonterminal **Payment processing**, **Payment
  fixing**, **Payment failed**, and unrecognized labels. Product behavior deliberately
  keeps any selected unit reserved until priced completion or exact cancellation.
- A verified TikTok room/session identity and automatic association of the local tracker
  stream with the correct real TikTok LIVE.
- Automatic Google Sheets writes. The Google connection supports pre-stream import and
  explicit active-stream SKU additions, but always remains read-only; the report instead
  provides a local six-column copy/CSV handoff.
- General Post-End editing or reopening an ended stream in the tagger. The report page can
  resolve fixing/temporary-failed payments only on the newest safe report. Any finalized
  saved or archived report can correct its own SKU unit costs, but it cannot edit mappings,
  captured prices for existing completions, quantities, SKU identity, canonical inventory,
  other reports, or future streams.
- Broader real-stream validation of report completeness when TikTok virtualizes or stops
  rendering earlier Sold Items rows.

## Development roadmap

1. Build the tagger interface in three focused stages:
   1. **Completed:** interface foundation;
   2. **Completed:** item-mapping workflow;
   3. **Completed:** captured payment lifecycle display and testing.
2. Persist canonical stream state in browser storage in three focused stages:
   1. **Completed:** versioned storage envelope, strict hydration, and adapter tests;
   2. **Completed:** coordinate serialized state updates through the extension service
      worker;
   3. **Completed:** connect the tagger to saved state and verify refresh/restart
      recovery.
3. **Capture hardening completed:** bounded scheduling, SPA lifecycle recovery,
   candidate validation, root-scoped observation, and scoped event-registry tests are
   implemented. Verified TikTok stream identity and broader real-stream validation
   remain open.
4. Connect captured TikTok events to the reconciliation engine and tagger in three
   focused stages:
   1. **Completed:** create persistent local active-stream sessions with Start, Resume,
      and End controls;
   2. **Completed:** attach read-only on-video bidding and Sold Items observations to the
      active local stream and persist current variation, payment, and sale changes through
      the worker;
   3. **Completed:** refetch persisted capture changes in real time, auto-follow each new
      active bidding variation before it sells while the employee is already viewing the
      current auction, and display its later observed TikTok payment status independently
      of inventory mapping. Reviewing history pauses automatic switching without pausing
      capture and exposes a compact **Return to live item** action. Visible option changes
      are deferred only while the accessible variation listbox is open, then applied once
      from the newest saved view when it closes. The return action targets the active
      bidding variation when one exists, otherwise the newest captured variation, and resumes automatic follow
      without changing any auction or inventory data. A prioritized queue, visible capture
      status, verified TikTok
      stream identity, and broader live validation remain next.
5. Connect Google Sheets inventory in three focused stages:
   1. **Completed:** define the exact inventory contract, atomic validation boundary,
      opening-baseline semantics, and a Google Sheets-compatible CSV template;
   2. **Completed:** version immutable inventory baselines, scope each stream's stock,
      reservations, and costs to one physical-count lineage, and support atomic
      append-only live SKU additions; and
   3. **Completed:** authorize read-only access, preview and confirm the selected Sheet,
      and initialize a new immutable inventory baseline.
6. **Completed:** freeze an end-of-stream business report with narrowly guarded payment
   and unit-cost correction, retain five Business Records plus a managed 25-report
   archive, render SKU and product analytics, and
   provide printable/PDF plus exact six-column copy/CSV inventory handoffs.
7. Optionally add automatic Google Sheets writes after the local report remains the
   durable source of truth.

## Project layout

| Path | Purpose | Status |
| --- | --- | --- |
| `extension/manifest.json` | Extension configuration and dashboard entry point | Implemented |
| `extension/service-worker.js` | Side-panel setup and canonical-state message boundary | Tagger, session, capture, Sheets import, and report lifecycle coordination implemented |
| `extension/capture/` | Scoped on-video bidding, Sold Items, and Attributed GMV observation plus retrying runtime delivery | Live capture integration implemented |
| `extension/shared/capture-*.js` | Strict page-to-worker protocol and active-stream binding | Implemented |
| `extension/shared/sale-parser.js` | Completed-sale text parsing | Implemented |
| `extension/shared/inventory-sheet-import.js` | Pure Google Sheets inventory validation and detached preview contract | Implemented |
| `extension/shared/google-sheets-inventory-import.js` | Worker-owned OAuth, fixed-range Sheet read, preview nonce, and confirmation adapter | Implemented; real OAuth client ID required per build |
| `extension/shared/inventory-import-protocol.js` | Strict side-panel-to-worker inventory-import message boundary | Implemented |
| `extension/shared/reconciliation.js` | Versioned inventory baselines, stream pins, payment, and gross-profit rules | Implemented |
| `extension/shared/reconciliation-storage.js` | Versioned state validation and storage adapter | Implemented in service worker |
| `extension/shared/reconciliation-coordinator.js` | Serialized canonical-state commands and persistence | Implemented in service worker |
| `extension/shared/stream-session*.js` | Versioned active-stream state, storage, and serialized lifecycle commands | Implemented in service worker |
| `extension/shared/stream-report*.js` | Strict report projection, protocol, two-tier local record store, and serialized lifecycle | Implemented in service worker |
| `extension/tagger/` | Sheets preview/confirmation, live-refreshed variation history, inventory picker, active-stream/report controls, and persistence clients | Import, capture refetch, and report archive implemented; prioritized queue pending |
| `extension/report/` | Locally loaded printable report, PDF/browser print action, analytics, and inventory copy/CSV handoff | Implemented |
| `backend/` | Optional future server-side Sheets/reporting code | Placeholder |
| `config/` | Security note for any future optional backend configuration | Not used by the extension |
| `docs/` | Architecture and capture-development notes | In progress |
| `tests/` | Offline parser, reconciliation, persistence, worker, and tagger tests | Implemented |

The first version is intended to remain browser-only if secure Google OAuth is
sufficient. The optional backend is reserved for needs such as server-managed
credentials, webhooks, multi-device coordination, or heavier reporting.

## Development setup

### Prerequisites

- Google Chrome
- Node.js and npm
- Git
- Visual Studio Code or another code editor

No npm packages or Python environment are currently required.

### Run the offline tests

From the repository root:

```powershell
npm.cmd test
```

PowerShell uses `npm.cmd` here to avoid systems that block the `npm.ps1` wrapper.

### Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension` directory.
5. Copy the extension ID shown on `chrome://extensions`. Google OAuth must be configured
   for this exact ID before a real Sheet can be read:
   1. In a Google Cloud project, enable the **Google Sheets API**.
   2. Configure the OAuth consent screen. While the app is in Testing, add the employee's
      Google account as a test user.
   3. Create an OAuth client whose application type is **Chrome Extension** and whose
      extension/item ID exactly matches the ID copied above.
   4. Replace
      `REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com` in
      `extension/manifest.json` with that public client ID. Do not add a client secret.
   5. Select **Reload** for the extension on `chrome://extensions`.
6. Click the extension's toolbar icon to open the Live session tagger side panel.

For a shipped build, configure the OAuth client against the final Chrome Web Store item
ID, not a temporary unpacked ID. Use the Store item's public key when a stable matching
unpacked-development ID is required. The checked-in placeholder intentionally makes a
misconfigured build fail before requesting Google authorization.

7. In Google Sheets, create a spreadsheet from
   [`docs/google-sheets-inventory-template.csv`](docs/google-sheets-inventory-template.csv):
   use **File -> Import -> Upload**, import the CSV into the workbook, and rename the tab
   exactly `Inventory`. Keep the exact six headers and replace the dummy rows with the
   physical opening count and unit cost for each SKU. Share the spreadsheet with the
   Google account that will authorize the extension if it does not already own it.
8. With no local tracker stream active, confirm **Google Sheets inventory** appears before
   the **Local stream session** Start controls. Paste the Sheet ID or its HTTPS
   `docs.google.com` sharing link into **Google Sheets inventory**, then select **Connect
   and preview**. Google should request only read-only spreadsheet access.
9. Review every normalized row plus the opening-unit and opening-cost totals. Select
   **Confirm inventory baseline** only when they match the physical stock. Confirmation
   re-reads the `Inventory` tab; if anything changed after preview, nothing is imported
   and a fresh preview is required. An import supports at most 1,000 inventory rows;
   larger Sheets fail as a whole rather than rendering or importing a partial list.
10. Select **Start stream**. A new live tracker stream requires a confirmed imported
    baseline. The worker starts the local
    stream in that baseline's inventory scope. This does not start TikTok LIVE.
    Until capture records an on-video bidding variation or a Sold Items row, confirm the
    variation selector waits for a live auction variation and inventory mapping is
    unavailable. After Start, confirm the Variation workspace is the first section below
    the header. The compact active-session section should be the last substantive section:
    it shows the tracker-active date row with its **Active** pill and the **End Stream
    Tracking** button, without repeating the section heading or safety note. The single
    saved-state footer indicator follows it.

    To add an unplanned item during this stream, first append its new unique-SKU row to
    the same Sheet without editing or deleting any existing row. In the Inventory heading,
    select **Add new SKUs from Sheet**, paste the same link or ID, and select **Check and
    add**. Wait for the success message before mapping that SKU. Reordered rows are safe;
    a changed existing SKU, item, style, size, opening quantity, or unit cost rejects the
    entire update and preserves the tracker exactly as it was.
11. Close and reopen the side panel. Select **Resume active stream** and confirm the same
    local stream is restored without creating a fake live variation.
12. Keep that local stream active, open
    `https://shop.tiktok.com/streamer/live/product/dashboard`, and refresh the dashboard
    once after loading or reloading the unpacked extension.
13. Open DevTools and confirm the Console contains the exact active route:

   ```text
   [TikTok Live Tracker] Capture probe active on /streamer/live/product/dashboard.
   ```

14. Keep the active Live session side panel open while an auction is running. Confirm the
    variation shown in the card at the bottom of the video appears automatically as
    `#N - bidding - no selection`. Its variation number and separators remain neutral,
    `bidding` is yellow, and `no selection` is orange. Select its inventory item before
    bidding ends and confirm the same option keeps yellow `bidding` but replaces the final
    segment with the green item, style, and size. Payment processing displays `processing`
    in yellow, payment completion displays `complete` in green, and fixing and temporary
    failure remain yellow; cancellation remains red. A mapped
    canceled row must combine a red payment segment with a green item segment, while an
    unmapped canceled row combines red with orange. The selector eyebrow should read
    **Live auction variations**. When
    TikTok starts the next auction, its number must become current without opening the
    menu. Then open and scroll the listbox without choosing an option while another
    variation or payment-status update arrives. The listbox must remain open at the same
    scroll position while capture continues; close it or choose an option, then reopen it
    and confirm the single newest option view contains all deferred text and variations.
    Verify mouse selection and the keyboard controls: Enter/Space opens or selects, arrow
    keys move one row, Page Up/Page Down move ten rows, Home/End move to a boundary,
    Escape or F4 dismisses, and Tab closes while continuing normal focus navigation. At a
    narrow side-panel width, confirm the listbox stays inside the viewport, opens above or
    below as space permits, scrolls vertically, and truncates long item text without hiding
    any row. Manually select a previous variation and confirm later updates do not replace
    that historical selection.
    Confirm a compact **Return to live item** button appears below the selector;
    select it and verify the active bidding variation becomes selected. If there is no
    active bidding marker, verify it instead selects the newest captured variation. The
    button must disappear after returning, must not change any mapping, inventory, payment,
    or persisted auction data, and automatic switching must resume for the following
    auction. Do not refresh TikTok, close the panel, or choose Resume again.
    Before TikTok exposes any live variation, confirm the compact **Live auction** panel is
    present with `Variation # -` and dashes. During fast bidding, confirm it reaches the
    latest bid without visibly stepping through stale intermediate prices. A new variation
    must immediately show `Variation #N` with dashes until its first valid `Bids: $...`
    value rather than reusing the prior auction's data. With no item mapped, current bid
    remains visible while unit cost and live gross profit show dashes. Map, remap, and unmap
    the active auction and confirm those two values update immediately. Verify `bid - unit
    cost` is red and negative below cost, neutral at zero, and green with a plus sign above
    cost. Select an older variation and confirm the panel remains tied to the active auction
    and continues updating. When the bidding marker clears, the panel must retain the last
    variation number, bid, cost, and profit with a muted indicator and no `Previous auction`
    label until the next auction starts. The eventual Sold Items final price remains
    authoritative. Reopen the panel and allow the service worker to suspend/restart during
    an auction; confirm the stream-paired latest display is recovered without showing data
    from another variation or stream.
15. In **LIVE auctions → Sold items**, confirm completed and payment-state variations
    remain in the same selector. When the active bidding variation reaches Sold Items,
    its existing mapping must remain attached while the `bidding` marker clears and its
    payment wording takes over. Under **TikTok payment**, confirm its exact observed state appears as
    `Payment processing`, `Payment fixing`, `Payment failed`, `Canceled`, or `Payment
    complete` and changes live without refreshing. A status-only update must keep that
    variation selected. Mapping during bidding must immediately show one pending unit and
    reduce the displayed available count by one. Processing, fixing, temporary failed,
    unrecognized, not-yet-observed, and unpriced `Payment complete` observations must keep
    that reservation. Exact `Canceled` must keep the item link as reference history,
    release the reservation, restore availability, and leave money unchanged. While that
    canceled variation is selected, inventory cards must remain enabled so its reference
    item can be mapped, corrected, or cleared. Confirm each reference-only change updates
    the dropdown item label without changing inventory or any live metric. For
    priced `Payment complete`, confirm the pending label disappears, the captured final
    price appears, and the sale permanently consumes the selected unit.
    Use the video auction card only to validate the current variation number; do not use
    it, Chat, or analytics to validate payment status, final price, or an individual sale.
    Separately, confirm **Gross Item Sales** equals the exact sum of all priced completed
    orders and **Total GMV** mirrors TikTok's **Attributed GMV** text, including compact
    text such as `$4.64K`. Per the product requirement, Total GMV includes buyer-paid
    shipping, so the two metrics are not expected to match. Confirm the combined
    **TikTok 6% Fees** card shows **Fees paid:** as Total GMV multiplied by 6% and **GMV
    after fees:** as Total GMV multiplied by 94%. Both values must use `≈` and nearest-
    dollar rounding for exact and compact GMV displays, and both must show an em dash when
    Total GMV is unavailable. Confirm the same frozen estimates appear in the post-stream
    report and never affect Gross Item Sales, COGS, gross profit, or inventory. Confirm
    **AOV** equals
    Gross Item Sales divided by the uniquely priced completed-order count, rounded to the
    nearest cent. Verify it includes mapped and unmapped completions, remains unchanged by
    mapping corrections, excludes bidding, processing, fixing/temporary-failed,
    price-less, and canceled orders, and displays `$0.00` before the first eligible sale.
    Confirm
    **Completed Sales/Total Sales** shows the uniquely priced canonical completed-order
    count over unique current-stream variations whose latest observed outcome is
    `Payment complete`, `Payment failed`, or `Canceled`. Verify the active bidding item and
    `Not observed`, `Payment processing`, `Payment fixing`, and unrecognized statuses do
    not enter the denominator. Verify mapping, unmapping, or remapping does not change
    either count. In the combined order-status card, confirm **Canceled Orders:** counts
    each unique current-stream variation only after its row changes to the exact terminal
    `Canceled` badge. Verify active bidding, `Not observed`, processing, fixing, temporary
    `Payment failed`, completed, and unrecognized variations do not enter this count.
    Confirm **Payment Fixing:** counts a unique unresolved order while its latest badge is
    `Payment fixing` or temporary `Payment failed`, but not while it is processing,
    bidding, `Not observed`, unrecognized, completed, or canceled. Verify that row leaves
    Payment Fixing and enters Canceled Orders when TikTok reaches `Canceled`, or simply
    leaves Payment Fixing when payment completes. Mapping or not mapping an item must not
    affect either status count. Confirm **Gross Profits** equals mapped completed sold-price
    revenue minus the pinned Google Sheets unit costs.
    If a completed order has no inventory item, confirm it is excluded from that subtotal
    and the card reports how many completed sales still need items. Map or remap one and
    confirm the subtotal and warning recalculate immediately.
16. Map an item during bidding, confirm `1 pending`, then let TikTok move it through
    processing and temporary failed. Switch away and back, then reopen and Resume once;
    the mapping and reservation must remain durable throughout. If TikTok completes it,
    confirm pending disappears while one unit remains consumed. On a different test
    variation, wait for exact `Canceled` and confirm its pending unit is restored
    automatically with no employee action.
17. On any inventory-affecting variation, select a SKU already showing `0 left`. Confirm
    the card stays enabled, never says **Sold out**, and reports `Oversold by 1`. Assign
    that SKU again and confirm the warning increments. Canceling one pending order must
    reduce or remove its oversold amount. Review that canceled variation and select the
    same SKU as its reference item; confirm the card stays interactive while its displayed
    stock, oversold warning, and every metric remain unchanged.
18. Use TikTok's own navigation to leave the dashboard and return without reloading the
    tab; confirm capture becomes active again. Put the tab in the background, return to
    it, and confirm a later Sold Items change is still captured.
19. Open **End Stream Tracking** while the stream still contains a pending inventory
    reservation and a completed sale without an item. Confirm the readiness text explains
    both attention items by count and that neither condition blocks End. Select
    **Keep stream active** once and verify tracking continues. Open it again and select
    **End and create report**. TikTok LIVE must remain unaffected, the local stream must
    end only after its report is saved, and the new report must open in a separate tab.
    If report creation or local storage fails, normal End must leave the active stream in
    place and offer the explicit **End without report** recovery action. Repeat with a
    disposable tracker stream and choose the small **End without report** action directly
    from the confirmation; tracking must end without adding or opening a report.
20. In the report, verify its attention notices match the unresolved conditions. A clean
    stream with no active bidding marker, unresolved/fixing order, pending reservation,
    unmapped completed sale, conflict, or oversold/recount condition must show no
    attention notice. Expand **Item variations this stream** and verify its combined count
    equals the report's completed plus canceled totals. Confirm its **Status** column
    distinguishes the completed and canceled rows, mapped and unmapped completions remain
    present, and canceled rows retain their reference item without a sale price, unit cost,
    gross profit, inventory, or metric effect. A compatible older report may retain its
    canceled total without having canceled row details. Verify the SKU and combined product
    rankings retain ties and the inventory table contains every SKU from the pinned
    baseline.
    With **Item variations this stream** collapsed, use **Print / Save as PDF** and confirm
    its rows stay omitted. Open **Show details** and print again to confirm the rows are
    included. Choose Chrome's **Save as PDF** destination and save a copy outside the
    extension if the report must be retained.
    For a newest test report containing one `Payment fixing` or temporary
    `Payment failed` order, verify **Finish unresolved payments** appears. Cancel one
    confirmation and verify nothing changes. Mark a mapped test order complete only after
    entering its seller-verified final price, then confirm completed totals, inventory,
    COGS, profit, warnings, and exports regenerate together. In a separate run, mark the
    order canceled and verify its reservation returns to availability. Processing orders,
    older reports/baselines, reports followed by another tracker stream, and reports viewed
    while tracking is active must never expose these controls.
    In current and archived finalized reports, expand **Correct SKU Unit Cost**. Verify its
    selector includes every report inventory SKU, including unsold SKUs. Correct a sold
    SKU and confirm the
    same report recalculates completed-order cost/profit, COGS, gross profit, margin,
    Est. Profit After Fees, top-profit rankings, SKU performance gross profit/loss values,
    and the Sheet handoff
    without changing prices, status counts, quantities, Gross Item Sales, AOV, or fees.
    Correct an unsold SKU and confirm this report's financial metrics stay unchanged while
    its handoff cost changes. Cancel one confirmation and verify nothing changes. Confirm
    the same control remains available on older and archived finalized reports, after a
    newer stream exists, and while another stream is active. Verify canonical inventory,
    other reports, and future streams keep their original cost.
21. To replace the Sheet counts, open **Show instructions +** in the Google Sheets handoff
    if needed, then first duplicate the Google Sheets **Inventory** tab as a backup. In the
    report select **Copy Updated Inventory**, return to the original
    **Inventory** tab, click cell **A1** (the first cell in the upper-left corner), and
    press **Ctrl+V** on Windows or **Cmd+V** on macOS. Verify the pasted rectangle has the
    exact six headers `sku`, `item`, `style`, `size`, `quantity_on_hand_at_import`, and
    `unit_cost`, and that every row aligns with its SKU. **Copy Updated Inventory**
    provides the complete six-column handoff; paste that table at A1 rather than copying
    individual values from the report.
22. As an alternative, select **Download Updated Inventory CSV**, then use Google Sheets
    **File -> Import -> Upload** and choose **Replace current sheet** only after making the
    backup. The CSV is formula-injection-safe and preserves the valid six-column Sheet
    values. A replacement quantity is clamped to zero when calculated inventory is
    negative; review the report's raw oversold amount and physically recount that SKU
    instead of treating the zero as proof that stock was exact. Do not use replacement
    counts without resolving or manually reviewing every attention notice.
23. Return to the side panel after End. Confirm **Business Records** lists the saved
    report with its date, completed/total count, and Gross Item Sales. Open it and verify the same PDF
    and inventory-download actions remain available. End enough isolated test streams to
    create six reports: Business Records must retain the newest five and automatically
    move the oldest finalized report into **Archived stream reports**, without deleting
    or changing it. Open that archived report and verify its report/PDF/CSV output is
    unchanged.
24. Use **More actions** on a Business Record to archive it manually. The action must fail
    without changing anything if the 25 archive slots or shared byte cap are full. With
    an open Business Records slot, select archived reports and use **Restore selected**;
    the complete selection must move back atomically. If the selection is larger than the
    number of open slots, no selected report may move. Exercise **Select all** and **Clear
    selection**, then choose **Delete selected**. Cancel the confirmation once and verify
    nothing changes; confirm it only for disposable test records and verify only those
    archived records are permanently removed.
25. At five Business Records plus 25 archived reports—or when the combined cap of
    approximately 4 MiB is reached—attempt another report-aware End. It must show an
    explicit storage-full error, preserve all 30 records, and leave the local tracker
    stream active for retry. Free
    archived space and retry, or deliberately choose **End without report**. No capacity
    path may silently delete a report. Before the next TikTok LIVE, reload the dashboard,
    confirm Sold Items belongs to the new stream rather than stale rows, import/confirm
    the updated `Inventory` baseline, and only then start a new local tracker stream.

The capture boundary must resolve to exactly one visible
`[data-tid="m4b_space"]` element. If TikTok renders zero or multiple visible matches,
capture fails closed and retries instead of scanning elsewhere. See
[Capture development notes](docs/capture-development.md) for the read-only root diagnostic
and the remaining live-stream checks.

Live-session identity and employee changes survive side-panel reloads and service-worker
restarts. The local ID is tracker-owned and is not yet a verified TikTok room ID. The
tagger has no manual unpaid or payment-undo controls; TikTok's captured payment truth is
authoritative.

## Credentials and privacy

The extension uses Chrome-managed user OAuth. Its manifest requests only
`https://www.googleapis.com/auth/spreadsheets.readonly`, the `identity` permission, and
the exact `https://sheets.googleapis.com/*` API host. That Google scope can read
spreadsheets the connected account is allowed to open; this implementation makes a GET
request only for the employee-selected spreadsheet ID and the fixed
whole `'Inventory'` worksheet range. It has no Sheets write scope.

The OAuth client ID in the manifest is public build configuration, not a secret. Replace
the checked-in placeholder with a Chrome Extension OAuth client tied to the exact
extension ID. Chrome obtains and caches the access token; the service worker uses it only
for the Sheets API request. The token never enters side-panel messages, DOM, extension
storage, repository files, or application logs. `config/.env.example` is not read by the
extension, and no service-account private key belongs in a browser bundle.

Never commit `.env` files, access tokens, private keys, or client inventory. Capture
runtime messages contain only variation numbers (including the one currently bidding),
allowlisted payment-status codes, the sanitized Attributed GMV display, and, for
completed payments, the final price in integer cents. The live-bid event adds only the
current variation number and sanitized positive integer-cent bid. Messages contain no
page-supplied stream ID, raw badge or auction-card text, buyer information, product text,
or DOM content. The trusted worker binds those facts to the active local tracker stream.
Only one stream-scoped live-bid record is kept in `chrome.storage.session`; it is not
reconciliation history and is excluded from reports and permanent accounting.
TikTok sale and report data is not sent to Google Sheets, and the live tracker does not
depend on Google after the baseline is confirmed locally. The report's copy and CSV
actions prepare a local clipboard payload or file only after the employee chooses them;
there is no Sheets write request.

The inventory template contains only stable SKU, employee-facing item/style/size,
physical quantity on hand at import, and unit cost. It intentionally excludes buyer,
variation, payment, stream, and credential data. The quantity is a confirmed opening
stock baseline; it is not a running value to edit after each sale. The importer validates
every row and shows a detached preview before one explicit confirmation appends and
activates the entire immutable baseline. Imports never overwrite an existing baseline.
Preview tokens and
normalized preview rows live only in worker/panel memory; a worker restart, expiration,
authorization loss, or changed Sheet requires a fresh preview. Only the confirmed
normalized baseline and its non-secret source fingerprint are saved locally. A later
report-only unit-cost correction updates neither that baseline nor its fingerprint.

End-of-stream reports are also stored only in `chrome.storage.local`. A report contains
the local stream reference and timestamps, inventory SKUs/item/style/size, unit costs and
quantities, captured sale prices/status aggregates, calculated profit, and report
notices. It contains no buyer identity, Google Sheet ID or sharing link, OAuth token, or
raw TikTok DOM text. Printing/Save as PDF and CSV download create local files only when
the employee requests them; the extension does not upload those files.

The library retains up to five Business Records and 25 archived reports within a combined
cap of approximately 4 MiB. It never silently prunes an archived record to make room.
Permanent archive deletion requires an explicit employee selection and confirmation; it
cannot be undone by the tracker. Removing the unpacked extension or clearing its extension
storage still deletes the entire in-extension library. Save required PDF or CSV files outside the
extension before deleting reports, uninstalling, or clearing storage. Files already
saved to the computer are independent of extension storage.

A public Chrome Web Store release needs a matching production OAuth client, an accurate
privacy policy and Store data-use disclosures, and compliance with Google's Limited Use
requirements. Because the read-only Sheets scope is sensitive, Google may require OAuth
app verification before broad production use. Passing local tests with a consent-screen
test user does not complete either Store review or OAuth verification.

## Documentation

- [Architecture](docs/architecture.md) — business rules, data model, and planned system
  design.
- [Capture development notes](docs/capture-development.md) — confirmed dashboard details,
  local testing, and the next live-stream checklist.
- [Google Sheets inventory template](docs/google-sheets-inventory-template.csv) — exact
  six-column, CSV-compatible opening-inventory contract with dummy example rows.
