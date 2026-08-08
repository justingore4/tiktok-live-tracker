# TikTok Live Tracker

A browser-based tool for tracking TikTok LIVE auction sales. TikTok supplies the
completed sale and final price, an employee identifies the physical item, and the
tracker combines those facts to calculate inventory and gross profit.

> **Project status:** early browser prototype. The completed-sale parser, read-only
> dashboard capture probe with SPA lifecycle recovery, reconciliation engine, tagger
> lifecycle demo, and local saved-session recovery are implemented and tested. Employee
> mappings and unpaid corrections persist through the service worker; TikTok payment
> capture and Google Sheets are not connected yet.

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

If payment permanently fails after TikTok's payment buffer, the employee can mark the
variation unpaid. Remaining inventory stays unchanged because that auction never counted
as a sale, while its pending reservation is released so the item can be tagged again. If
the item is auctioned again, the employee maps its new variation number.

## Current implementation

### Implemented and tested

- A Manifest V3 Chrome extension whose isolated capture script is available only on the
  exact `https://shop.tiktok.com` host and activates only on the exact TikTok LIVE
  dashboard path.
- A responsive Chrome side-panel prototype with mock inventory, search, reservations,
  sold-out states, one-click item mapping and unmapping, and a current/previous
  variation selector.
- A **Saved session** mode that restores mappings, unpaid decisions, reservations, and
  prior variation records after the side panel or browser is reopened.
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
  document body changes.
- A parser for variation number, final US-dollar price, and `Payment complete` text.
- An offline reconciliation engine that:
  - accepts employee mapping and payment events in either order;
  - prevents identical events from deducting inventory twice;
  - calculates remaining inventory, completed GMV, and gross profit;
  - reserves pending units separately from completed sales;
  - supports mapping corrections, click-again unmapping, **Mark unpaid**, and undoing
    the local unpaid mark;
  - surfaces unmapped sales, conflicting prices, and inventory shortages;
  - keeps auctions distinct by `(streamId, variationNumber)`.
- A versioned persistence adapter that validates and saves detached reconciliation
  snapshots, reports typed storage/corruption/version errors, and never silently
  replaces corrupt or future-version data.
- A service-worker coordinator that loads stored state once per worker lifetime,
  processes commands in order, saves before publishing changes, and keeps the last good
  state when a command or write fails.
- A strict tagger runtime client and controller that send only mapping, unmapping,
  mark-unpaid, and undo-unpaid commands through that coordinator. The tagger never
  accesses browser storage directly and cannot create authoritative payment-complete
  events.
- Automated parser, reconciliation, persistence, service-worker, and tagger tests using
  Node's built-in test runner.

### Not implemented yet

- Real TikTok payment events driving the tagger interface.
- A live, capture-fed variation queue; the current history selector uses seeded demo
  variations only.
- Automatic detection of the current variation while bidding.
- Detection of TikTok's yellow payment-warning state.
- Persistent stream identity and automatic creation of a fresh saved session for each
  real TikTok LIVE.
- Google Sheets inventory import and results export.
- A connection between the capture probe and reconciliation engine.
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
3. **In progress:** bounded capture scheduling and SPA lifecycle recovery are
   implemented; stream identity, selector narrowing, and real-stream validation remain.
4. Connect captured TikTok events to the reconciliation engine and tagger.
5. Create the Google Sheet template and choose the authentication approach.
6. Import inventory from Google Sheets and export reconciled results.
7. Add end-of-stream reconciliation and analytics reporting.

## Project layout

| Path | Purpose | Status |
| --- | --- | --- |
| `extension/manifest.json` | Extension configuration and dashboard entry point | Implemented |
| `extension/service-worker.js` | Side-panel setup and canonical-state message boundary | Coordinator implemented |
| `extension/capture/` | Read-only TikTok dashboard observation | Scheduling and SPA recovery implemented |
| `extension/shared/sale-parser.js` | Completed-sale text parsing | Implemented |
| `extension/shared/reconciliation.js` | Inventory, payment, and gross-profit rules | Implemented |
| `extension/shared/reconciliation-storage.js` | Versioned state validation and storage adapter | Implemented in service worker |
| `extension/shared/reconciliation-coordinator.js` | Serialized canonical-state commands and persistence | Implemented in service worker |
| `extension/tagger/` | Employee queue, inventory picker, and saved-session controller | Persistence connected; live capture pending |
| `backend/` | Optional future server-side Sheets/reporting code | Placeholder |
| `config/` | Backend-only credential placeholders, if a backend is selected | Not in use |
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
5. Click the extension's toolbar icon to open the tagger side panel.
6. In **Saved session**, wait for the status to say **Saved locally**.
7. Select `Stussy tee - black, L` for variation `#203`; wait for the save to finish.
8. Close and reopen the side panel. Confirm `#203` is still mapped and shows one pending
   reservation.
9. Select another available inventory card, wait for it to save, then reopen the panel
   once more and confirm the correction was restored.
10. Click the selected inventory card again, wait for it to save, and confirm the
    variation shows **No item selected** after reopening. Select an item again to
    continue.
11. Use **Mark unpaid after TikTok's buffer**, reopen the panel, and confirm the unpaid
    state was restored. Use **Undo unpaid** and confirm that change also survives reopen.
12. Switch to **Offline demo**. Open the variation dropdown and confirm it lists current
    variation `#203` plus seeded history `#202`, `#201`, and `#200`.
13. Select `#202`, confirm the banner says **Reviewing previous variation**, then select a
    different inventory card and confirm its completed-sale inventory and profit update.
14. Return to `#203`, map `Stussy tee - black, L`, and confirm it shows **Waiting for
    payment** and `4 available · 1 pending`.
15. Simulate a `$48.00` completed payment and confirm `$48.00`, `+$36.00 profit`, and
    `4 remaining`; then use **Undo simulated payment** and confirm the pending state
    returns.
16. Test **Simulate payment buffer expired**, **Mark unpaid after buffer**, and **Undo
    unpaid**. Switch back to **Saved session** and confirm none of the demo-only payment
    changes altered the saved data.
17. Open `https://shop.tiktok.com/streamer/live/event/dashboard`.
18. Open DevTools and confirm the Console contains:

   ```text
   [TikTok Live Tracker] Capture probe active
   ```

19. Use TikTok's own navigation to leave the dashboard and return without reloading the
    tab; confirm capture becomes active again without duplicate completed-sale events.
20. Put the tab in the background, return to it, and confirm capture remains active. Body
    replacement and repeated re-entry are also covered by the offline capture tests.

On a blank offline dashboard, the startup message is the expected result. See
[Capture development notes](docs/capture-development.md) for an optional simulated-sale
test and the remaining live-stream checks.

Saved-session employee changes survive side-panel reloads and service-worker restarts.
Offline-demo changes still reset when that disposable demo is recreated or the panel is
reloaded.

**Undo simulated payment** only restores the private, in-memory offline demo. **Undo
unpaid** only removes the employee's local unpaid mark. Neither control acts on TikTok or
can reverse a captured completed payment.

## Credentials and privacy

No Google credentials are needed for the current offline prototype. Google Sheets
authentication is deliberately unresolved until the Sheets stage:

- A browser-only version should use user OAuth and must not contain a service-account
  private key.
- A service-account key is only appropriate in an optional backend that keeps it away
  from the extension.

Never commit `.env` files, access tokens, private keys, or client data. The current
capture probe logs only variation number, price in integer cents, and payment status; it
does not store buyer names or contact Google Sheets.

## Documentation

- [Architecture](docs/architecture.md) — business rules, data model, and planned system
  design.
- [Capture development notes](docs/capture-development.md) — confirmed dashboard details,
  local testing, and the next live-stream checklist.
