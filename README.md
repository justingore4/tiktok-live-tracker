# TikTok Live Tracker

A browser-based tool for tracking TikTok LIVE auction sales. TikTok supplies the
completed sale and final price, an employee identifies the physical item, and the
tracker combines those facts to calculate inventory and gross profit.

> **Project status:** early browser prototype. The tracker now observes the live
> **Sold items** panel, records its variation numbers under the active local tracker
> stream, and persists sanitized payment-status changes plus exact green
> `Payment complete` prices through the service worker.
> An open Live session side panel refetches saved state as those records change, without
> requiring a TikTok-page refresh or panel reopen. Before Start, an employee can now
> authorize read-only Google Sheets access, preview and confirm the exact `Inventory`
> tab, and save it as a new immutable local baseline. A dedicated employee work queue,
> verified TikTok stream identity, outbound Sheets export, and end-of-stream reporting
> are not implemented yet.

## How it works

Each auction has a sequential variation number such as `#203`. Based on the seller's
current workflow, variation numbers restart for each stream, and each variation
represents one auction of one physical item.

While the item is on screen, an employee selects its item, style, and size from the
tracker's inventory menu. The tracker stores that selection as a mapping; it does not
enter a price or perform any action on TikTok. Clicking the selected inventory card
again removes only that item mapping and leaves TikTok's payment result unchanged.

The tracker counts the sale only after TikTok shows the final price with the green
`Payment complete` badge in the **Sold items** panel:

> A sale counts, gross profit is recorded, and stock decreases **only when TikTok shows
> payment complete and the variation is mapped to an inventory item**.

A real TikTok `Payment complete` event is authoritative and cannot be undone by this
extension. Employees can correct the mapped inventory item, but they cannot reverse
TikTok's payment state.

The tagger also shows the latest observed Sold Items badge independently as **Payment
processing**, **Payment fixing**, **Payment failed**, **Canceled**, **Payment complete**, or
**Unrecognized payment status**. Only processing and fixing create a pending inventory
reservation. Not-yet-observed, failed, unrecognized, and unpriced-complete records keep
their selected item linked without showing pending or reducing available stock. None of
these observations decrement remaining inventory.

An exact TikTok **Canceled** badge is canonical and terminal for inventory allocation. It
keeps the variation linked to its selected item for history, releases that reservation,
and never counts the cancellation as a sale, revenue, or profit. If a later priced
**Payment complete** arrives, TikTok's completion wins: the tracker commits the sale and
shows a warning that inventory was counted. The local **Mark unpaid after buffer** control
remains an undoable fallback for a mapped nonterminal variation when TikTok's exact
Canceled badge was not captured. If the item is auctioned again, the employee maps its new
variation number.

## Current implementation

### Implemented and tested

- A Manifest V3 Chrome extension whose isolated capture script is available only on the
  exact `https://shop.tiktok.com` host and activates only on the exact TikTok LIVE
  dashboard path.
- A responsive Chrome side-panel prototype with mock inventory, search, processing/fixing reservations,
  sold-out states, one-click item mapping and unmapping, and a current/previous
  variation selector. Inventory cards show remaining stock separately from pending
  reservations.
- A **Live session** mode with explicit Start, Resume, and End controls. Its worker-made
  local stream ID survives side-panel, browser, and service-worker restarts, while End
  keeps reconciliation history and does not act on TikTok LIVE.
- Restoration of mappings, unpaid decisions, reservations, and prior variation records
  after the side panel or browser is reopened.
- Loading, saving, retry, and fail-closed error states that keep the last successfully
  saved view visible when a command fails.
- An in-memory lifecycle demo for variations `#200` through `#203`. It keeps on-screen
  variation `#203` distinct from the previous variation being reviewed, and previous
  mappings can be corrected directly from the same inventory cards.
- Offline controls that can simulate payment completion, undo only that variation's
  simulated completion, expire its payment buffer, **Mark unpaid**, and **Undo unpaid**.
- Engine-derived final price, unit cost, gross profit/loss, and inventory results after
  a simulated completed payment.
- A read-only `MutationObserver` capture probe with bounded scheduling so ordinary
  dashboard updates cannot indefinitely postpone scans while the page is executing.
- SPA lifecycle recovery that responds to route and page-resume signals, uses a 250 ms
  fallback check, and cleans up or restarts the observer and scheduler when the route or
  Sold Items root changes.
- A live-validated Sold Items boundary that requires exactly one visible
  `[data-tid="m4b_space"]` root. Capture stops and retries when that selector is missing
  or ambiguous, and sale parsing never scans the video, Chat, analytics, or the rest of
  the dashboard.
- Strict row-local matching for exact `Variation: #N` labels and exact
  `[data-tid="m4b_tag"]` badges. The allowlist recognizes `Payment processing`,
  `Payment fixing`, `Payment failed`, `Canceled`, and `Payment complete`; any other nonempty badge is
  stored only as `unrecognized`, never as raw page text. Generic tag counts and generated
  CSS classes are not capture inputs. Incidental buyer and product text in the same row
  is never selected as a field, logged raw, transmitted, or saved.
- A strict capture protocol and runtime client that send only observed variation numbers
  and sanitized payment-status codes, plus a completed variation's integer-cent price.
  The page sends no stream ID, buyer data, raw badge text, or DOM content.
- A worker-owned capture integration that authorizes only the top-level product
  dashboard, resolves the active local stream itself, and persists observations and
  payment changes through the serialized reconciliation coordinator.
- A data-free capture-state invalidation sent only after the worker accepts a durable
  capture update. An open Live session side panel validates and coalesces those notices,
  then refetches canonical state so new variations and payment changes appear live
  without trusting page-supplied state.
- Ack-based delivery with retry and bounded backoff. Repeated DOM scans, page reloads,
  and service-worker restarts remain idempotent for the same local stream.
- A pure capture-event registry that keeps diagnostic page-load and verified-stream
  scopes separate. Canonical stream assignment is instead performed by the worker.
- A parser for variation number, final US-dollar price, and `Payment complete` text.
- An offline reconciliation engine that:
  - stores immutable inventory baselines and pins each tracker stream to exactly one;
  - scopes stock, pending reservations, and committed costs to the pinned baseline so a
    later physical recount does not subtract historical sales twice;
  - accepts employee mapping and payment events in either order;
  - prevents identical events from deducting inventory twice;
  - calculates remaining inventory, completed GMV, and gross profit;
  - reserves pending units separately from completed sales;
  - treats exact `Canceled` as a terminal inventory-allocation result that preserves the
    item link, releases its reservation, and contributes no sale or money;
  - lets a later priced completion override cancellation with a visible conflict warning;
  - supports mapping corrections, click-again unmapping, **Mark unpaid**, and undoing
    the local unpaid mark;
  - applies completed historical corrections atomically by restoring the old SKU,
    decrementing the new SKU, and recalculating its cost snapshot and gross profit;
  - surfaces unmapped sales, conflicting prices, and inventory shortages;
  - keeps auctions distinct by `(streamId, variationNumber)`.
- A versioned persistence adapter that validates and saves detached reconciliation
  snapshots, reports typed storage/corruption/version errors, and never silently
  replaces corrupt or future-version data. Reconciliation state is version 4, with strict
  version-1 through version-3 migration into one deterministic legacy baseline; the outer
  storage envelope remains schema version 1.
- A service-worker coordinator that loads stored state once per worker lifetime,
  processes commands in order, saves before publishing changes, and keeps the last good
  state when a command or write fails. Baseline creation is blocked while a local tracker
  stream is active.
- A browser-managed Google OAuth import flow that reads only the selected spreadsheet's
  exact `Inventory` tab with the read-only Sheets scope. The side panel accepts a Sheet
  ID or safe `docs.google.com` sharing link, displays a detached normalized preview and
  summary, and creates an immutable baseline only after explicit confirmation.
- A race-safe confirmation boundary: previews are short-lived and worker-memory-only;
  confirmation re-reads the Sheet and rejects a changed or expired preview without
  importing partial data. Import, Start, and active-stream checks share the worker's
  serialized command queue.
- A separate versioned active-stream record and coordinator. The worker generates its
  `local-stream:<uuid>` identity, saves it before reporting Start, restores it for Resume,
  requires the expected ID before End so a stale panel cannot end a newer session, and
  verifies or repairs the active stream's immutable baseline pin on Start and Resume. A
  guarded Retry also repairs an older active session whose reconciliation state was
  never initialized, without replacing any existing canonical data.
- A strict tagger runtime client and controller that send only mapping, unmapping,
  mark-unpaid, and undo-unpaid commands through that coordinator. The tagger never
  accesses browser storage directly and cannot create authoritative payment-complete
  events.
- Automated capture, parser, reconciliation, persistence, service-worker, and tagger
  tests using Node's built-in test runner.

### Not implemented yet

- A richer prioritized employee work queue beyond the current newest-captured-variation
  auto-follow behavior. A selected Sold Items row remains a recorded row, not a claim
  about the auction currently bidding.
- Visible capture connection, retry, and queue-drained status.
- Verified transition timing for TikTok's nonterminal **Payment processing**, **Payment
  fixing**, **Payment failed**, and unrecognized labels. Processing/fixing reserve a mapped
  unit; failed and unrecognized remain mapped but unreserved.
- A verified TikTok room/session identity and automatic association of the local tracker
  stream with the correct real TikTok LIVE.
- Google Sheets results export. The implemented Google connection is pre-stream,
  read-only inventory import only.
- End-of-stream analytics and live-stream validation.

## Development roadmap

1. Build the offline tagger interface in three focused stages:
   1. **Completed:** interface foundation;
   2. **Completed:** item-mapping workflow;
   3. **Completed:** payment lifecycle controls and testing.
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
   2. **Completed:** attach read-only Sold Items observations to the active local stream
      and persist variation numbers and payment changes through the worker;
   3. **Completed:** refetch persisted capture changes in real time, auto-follow each new
      higher variation, and display its observed TikTok payment status independently of
      inventory mapping. A prioritized queue, visible capture status, verified TikTok
      stream identity, and broader live validation remain next.
5. Connect Google Sheets inventory in three focused stages:
   1. **Completed:** define the exact inventory contract, atomic validation boundary,
      opening-baseline semantics, and a Google Sheets-compatible CSV template;
   2. **Completed:** version immutable inventory baselines, pin each tracker stream to
      one baseline, and scope stock, reservations, costs, and corrections to that pin;
      and
   3. **Completed:** authorize read-only access, preview and confirm the selected Sheet,
      and initialize a new immutable inventory baseline.
6. Export reconciled results to Google Sheets.
7. Add end-of-stream reconciliation and analytics reporting.

## Project layout

| Path | Purpose | Status |
| --- | --- | --- |
| `extension/manifest.json` | Extension configuration and dashboard entry point | Implemented |
| `extension/service-worker.js` | Side-panel setup and canonical-state message boundary | Tagger, session, capture, and Sheets import coordination implemented |
| `extension/capture/` | Root-scoped Sold Items observation and retrying runtime client | Live capture integration implemented |
| `extension/shared/capture-*.js` | Strict page-to-worker protocol and active-stream binding | Implemented |
| `extension/shared/sale-parser.js` | Completed-sale text parsing | Implemented |
| `extension/shared/inventory-sheet-import.js` | Pure Google Sheets inventory validation and detached preview contract | Implemented |
| `extension/shared/google-sheets-inventory-import.js` | Worker-owned OAuth, fixed-range Sheet read, preview nonce, and confirmation adapter | Implemented; real OAuth client ID required per build |
| `extension/shared/inventory-import-protocol.js` | Strict side-panel-to-worker inventory-import message boundary | Implemented |
| `extension/shared/reconciliation.js` | Versioned inventory baselines, stream pins, payment, and gross-profit rules | Implemented |
| `extension/shared/reconciliation-storage.js` | Versioned state validation and storage adapter | Implemented in service worker |
| `extension/shared/reconciliation-coordinator.js` | Serialized canonical-state commands and persistence | Implemented in service worker |
| `extension/shared/stream-session*.js` | Versioned active-stream state, storage, and serialized lifecycle commands | Implemented in service worker |
| `extension/tagger/` | Sheets preview/confirmation, live-refreshed variation history, inventory picker, active-stream controls, and persistence clients | Import and capture refetch implemented; prioritized queue pending |
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
6. Click the extension's toolbar icon to open the tagger side panel.

For a shipped build, configure the OAuth client against the final Chrome Web Store item
ID, not a temporary unpacked ID. Use the Store item's public key when a stable matching
unpacked-development ID is required. The checked-in placeholder intentionally makes a
misconfigured build fail before requesting Google authorization.

If this Chrome profile previously used the old saved `demo-stream` prototype, its test
mappings still exist by design and can affect shared inventory. Before the first real
stream test, remove the unpacked extension from `chrome://extensions` and load it again,
or clear its local extension storage, only if you intentionally want to discard that
prototype data. There is no silent reset.

7. In Google Sheets, create a spreadsheet from
   [`docs/google-sheets-inventory-template.csv`](docs/google-sheets-inventory-template.csv):
   use **File -> Import -> Upload**, import the CSV into the workbook, and rename the tab
   exactly `Inventory`. Keep the exact six headers and replace the dummy rows with the
   physical opening count and unit cost for each SKU. Share the spreadsheet with the
   Google account that will authorize the extension if it does not already own it.
8. With no local tracker stream active, paste the Sheet ID or its HTTPS
   `docs.google.com` sharing link into **Google Sheets inventory**, then select **Connect
   and preview**. Google should request only read-only spreadsheet access.
9. Review every normalized row plus the opening-unit and opening-cost totals. Select
   **Confirm inventory baseline** only when they match the physical stock. Confirmation
   re-reads the `Inventory` tab; if anything changed after preview, nothing is imported
   and a fresh preview is required. An import supports at most 1,000 inventory rows;
   larger Sheets fail as a whole rather than rendering or importing a partial list.
10. Select **Start stream**. A new live tracker stream now requires a confirmed imported
    baseline; offline demo inventory cannot satisfy Start. The worker starts the local
    stream and permanently pins it to that baseline. This does not start TikTok LIVE.
    Until capture records a Sold Items row, confirm the variation selector waits for one
    and inventory mapping is unavailable.
11. Close and reopen the side panel. Select **Resume active stream** and confirm the same
    local stream is restored without creating a fake live variation.
12. Switch to **Offline demo**. Open the variation dropdown and confirm it lists current
    variation `#203` plus seeded history `#202`, `#201`, and `#200`.
13. Select `#202`, confirm the banner says **Reviewing previous variation**, then select a
    different inventory card and confirm its completed-sale inventory and profit update.
14. Return to `#203`, map `Stussy tee - black, L`, and confirm it shows **Item selected**
    with `5 left` and no pending count. The Offline demo starts with no pending inventory.
15. Simulate a `$48.00` completed payment and confirm `$48.00`, `+$36.00 profit`, and
    `4 left`; then use **Undo simulated payment** and confirm the item remains selected,
    returns to `5 left`, and still has no pending count.
16. Test **Simulate payment buffer expired**, **Mark unpaid after buffer**, and **Undo
    unpaid**. Switch back to **Live session** and confirm none of the demo-only payment
    changes altered the saved data.
17. Keep that local stream active, open
    `https://shop.tiktok.com/streamer/live/product/dashboard`, and refresh the dashboard
    once after loading or reloading the unpacked extension.
18. Open DevTools and confirm the Console contains the exact active route:

   ```text
   [TikTok Live Tracker] Capture probe active on /streamer/live/product/dashboard.
   ```

19. Keep the active Live session side panel open. In **LIVE auctions → Sold items**,
    note two or more visible variation numbers and confirm those exact numbers appear
    in the variation selector after the capture scan settles. Do not refresh TikTok,
    close the panel, or choose Resume again.
20. Select one recorded variation, then wait for a newer Sold Items variation. Confirm
    the new number appears in the selector and becomes the displayed variation
    automatically. Under **TikTok payment**, confirm its exact observed state appears as
    `Payment processing`, `Payment fixing`, `Payment failed`, `Canceled`, or `Payment
    complete` and changes live without refreshing. A status-only update must keep that
    variation selected. Processing and fixing must reserve a mapped unit and show it as
    pending without reducing remaining stock. Failed, unrecognized, not-yet-observed, and
    unpriced `Payment complete` must keep any item selection without pending inventory.
    Exact `Canceled` must keep the item link, release any reservation, and leave remaining
    stock and money unchanged. For priced `Payment complete`, also confirm the captured
    final price appears even before an inventory item is selected. If a priced completion follows `Canceled`, confirm the
    sale commits and the warning says TikTok completion won and inventory was counted. Do
    not use Chat, the video auction card, or analytics as a comparison source.
21. Map one captured **Payment processing** or **Payment fixing** variation to `Stussy tee - black, L` and wait for the save.
    Reopen and Resume once to confirm the mapping and pending reservation are durable.
    Correct it to another available card, then click that selected card again; confirm
    both the correction and **No item selected** state survive another reopen.
22. Use **Mark unpaid after TikTok's buffer** on a mapped, non-completed test variation,
    reopen the panel, and confirm the unpaid state was restored. Use **Undo unpaid** and
    confirm that change also survives reopen.
23. Use TikTok's own navigation to leave the dashboard and return without reloading the
    tab; confirm capture becomes active again. Put the tab in the background, return to
    it, and confirm a later Sold Items change is still captured.
24. Open End while the stream still contains an inventory-reserved processing/fixing
    mapping and a completed sale without an item. Confirm that both remain visible as
    unresolved records but neither blocks the End confirmation. Cancel End once, then
    confirm it; TikTok LIVE must remain unaffected and captured order history must remain
    saved. Ended streams cannot yet be reopened for corrections in this prototype. Before
    the next TikTok LIVE, reload the dashboard, confirm Sold Items belongs to the new
    stream rather than showing stale rows, and only then start a new local tracker stream.

The capture boundary must resolve to exactly one visible
`[data-tid="m4b_space"]` element. If TikTok renders zero or multiple visible matches,
capture fails closed and retries instead of scanning elsewhere. See
[Capture development notes](docs/capture-development.md) for the read-only root diagnostic
and the remaining live-stream checks.

Live-session identity and employee changes survive side-panel reloads and service-worker
restarts. The local ID is tracker-owned and is not yet a verified TikTok room ID.
Offline-demo changes still reset when that disposable demo is recreated or the panel is
reloaded.

**Undo simulated payment** only restores the private, in-memory offline demo. **Undo
unpaid** only removes the employee's local unpaid mark. Neither control acts on TikTok or
can reverse a captured completed payment.

## Credentials and privacy

The extension uses Chrome-managed user OAuth. Its manifest requests only
`https://www.googleapis.com/auth/spreadsheets.readonly`, the `identity` permission, and
the exact `https://sheets.googleapis.com/*` API host. That Google scope can read
spreadsheets the connected account is allowed to open; this implementation makes a GET
request only for the employee-selected spreadsheet ID and the fixed
`'Inventory'!A:ZZZ` range. It has no Sheets write scope.

The OAuth client ID in the manifest is public build configuration, not a secret. Replace
the checked-in placeholder with a Chrome Extension OAuth client tied to the exact
extension ID. Chrome obtains and caches the access token; the service worker uses it only
for the Sheets API request. The token never enters side-panel messages, DOM, extension
storage, repository files, or application logs. `config/.env.example` is not read by the
extension, and no service-account private key belongs in a browser bundle.

Never commit `.env` files, access tokens, private keys, or client inventory. Capture
runtime messages contain only variation numbers, allowlisted payment-status codes, and,
for completed payments, the final price in integer cents. They contain no page-supplied
stream ID, raw badge text, buyer information, product text, or DOM content. The trusted
worker binds those facts to the active local tracker stream. TikTok sale data is not sent
to Google Sheets, and the live tracker does not depend on Google after the baseline is
confirmed locally. Results export is not implemented.

The inventory template contains only stable SKU, employee-facing item/style/size,
physical quantity on hand at import, and unit cost. It intentionally excludes buyer,
variation, payment, stream, and credential data. The quantity is a confirmed opening
stock baseline; it is not a running value to edit after each sale. The importer validates
every row and shows a detached preview before one explicit confirmation appends and
activates the entire baseline. It never mutates an existing baseline. Preview tokens and
normalized preview rows live only in worker/panel memory; a worker restart, expiration,
authorization loss, or changed Sheet requires a fresh preview. Only the confirmed
normalized baseline and its non-secret fingerprint are saved locally.

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
