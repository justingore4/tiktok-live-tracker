# TikTok Live Tracker

A browser-based tool for tracking TikTok LIVE auction sales. TikTok supplies the
completed sale and final price, an employee identifies the physical item, and the
tracker combines those facts to calculate inventory and gross profit.

> **Project status:** early offline prototype. The completed-sale parser, read-only
> dashboard capture probe, reconciliation engine, and in-memory tagger lifecycle demo
> are implemented and tested. The service worker now owns a versioned, serialized
> persistent-state coordinator, but the tagger and capture probe do not send it commands
> yet. Google Sheets is not connected.

## How it works

Each auction has a sequential variation number such as `#203`. Based on the seller's
current workflow, variation numbers restart for each stream, and each variation
represents one auction of one physical item.

While the item is on screen, an employee selects its item, style, and size from the
tracker's inventory menu. The tracker stores that selection as a mapping; it does not
enter a price or perform any action on TikTok.

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

- A Manifest V3 Chrome extension that loads on the TikTok LIVE dashboard.
- A responsive Chrome side-panel prototype with mock inventory, search, reservations,
  sold-out states, one-click item mapping, and a current/previous variation selector.
- An in-memory lifecycle demo for variations `#200` through `#203`. It keeps on-screen
  variation `#203` distinct from the previous variation being reviewed, and previous
  mappings can be corrected directly from the same inventory cards.
- Offline controls that can simulate payment completion, undo only that variation's
  simulated completion, expire its payment buffer, **Mark unpaid**, and **Undo unpaid**.
- Engine-derived final price, unit cost, gross profit/loss, and inventory results after
  a simulated completed payment.
- A read-only `MutationObserver` capture probe for rendered completed-sale rows.
- A parser for variation number, final US-dollar price, and `Payment complete` text.
- An offline reconciliation engine that:
  - accepts employee mapping and payment events in either order;
  - prevents identical events from deducting inventory twice;
  - calculates remaining inventory, completed GMV, and gross profit;
  - reserves pending units separately from completed sales;
  - supports mapping corrections, **Mark unpaid**, and undoing the local unpaid mark;
  - surfaces unmapped sales, conflicting prices, and inventory shortages;
  - keeps auctions distinct by `(streamId, variationNumber)`.
- A versioned persistence adapter that validates and saves detached reconciliation
  snapshots, reports typed storage/corruption/version errors, and never silently
  replaces corrupt or future-version data.
- A service-worker coordinator that loads stored state once per worker lifetime,
  processes commands in order, saves before publishing changes, and keeps the last good
  state when a command or write fails.
- Automated parser, reconciliation, persistence, service-worker, and tagger tests using
  Node's built-in test runner.

### Not implemented yet

- Real TikTok payment events driving the tagger interface.
- A live, capture-fed variation queue; the current history selector uses seeded demo
  variations only.
- Automatic detection of the current variation while bidding.
- Detection of TikTok's yellow payment-warning state.
- Tagger connection to persistent state and visible recovery after a refresh, crash, or
  browser restart.
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
   3. connect the tagger to saved state and verify refresh/restart recovery.
3. Harden and live-validate capture scheduling, stream identity, and dashboard selectors.
4. Connect captured TikTok events to the reconciliation engine and tagger.
5. Create the Google Sheet template and choose the authentication approach.
6. Import inventory from Google Sheets and export reconciled results.
7. Add end-of-stream reconciliation and analytics reporting.

## Project layout

| Path | Purpose | Status |
| --- | --- | --- |
| `extension/manifest.json` | Extension configuration and dashboard entry point | Implemented |
| `extension/service-worker.js` | Side-panel setup and canonical-state message boundary | Coordinator implemented |
| `extension/capture/` | Read-only TikTok dashboard observation | Probe implemented |
| `extension/shared/sale-parser.js` | Completed-sale text parsing | Implemented |
| `extension/shared/reconciliation.js` | Inventory, payment, and gross-profit rules | Implemented |
| `extension/shared/reconciliation-storage.js` | Versioned state validation and storage adapter | Implemented in service worker |
| `extension/shared/reconciliation-coordinator.js` | Serialized canonical-state commands and persistence | Implemented in service worker |
| `extension/tagger/` | Employee queue and inventory picker | In-memory lifecycle demo implemented |
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
5. Click the extension's toolbar icon to open the demo tagger side panel.
6. Open the variation dropdown and confirm it lists current variation `#203` plus demo
   history `#202`, `#201`, and `#200` with their statuses.
7. Select `#202`, confirm the banner says **Reviewing previous variation**, then select a
   different inventory card and confirm its completed-sale inventory and profit update.
8. Select **Return to on-screen variation #203**.
9. Select `Stussy tee - black, L` and confirm it shows **Selected**, **Waiting for
   payment**, and `4 available · 1 pending`.
10. Leave the simulated price at `$48.00` and select **Simulate payment complete**.
11. Confirm the result shows `$48.00`, `+$36.00 profit`, and `4 remaining`.
12. Select **Undo simulated payment** and confirm the result disappears, **Waiting for
    payment** returns, and the item shows `4 available · 1 pending`.
13. Simulate payment again, select a different inventory card, and confirm the old
    inventory count is restored while the new count and profit are recalculated.
14. Reload the extension to reset the in-memory demo, map an item, then test **Simulate
    payment buffer expired**, **Mark unpaid after buffer**, and **Undo unpaid**.
15. While marked unpaid, use **Simulate payment complete** to confirm a late TikTok
    payment still counts and displays a conflict warning.
16. Open or refresh `https://shop.tiktok.com/streamer/live/event/dashboard`.
17. Open DevTools and confirm the Console contains:

   ```text
   [TikTok Live Tracker] Capture probe active
   ```

On a blank offline dashboard, the startup message is the expected result. See
[Capture development notes](docs/capture-development.md) for an optional simulated-sale
test and the remaining live-stream checks.

Closing or reloading the side panel resets changes back to the seeded demo history. The
worker coordinator is not connected to the tagger until persistence prompt 3/3.

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
