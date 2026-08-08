# TikTok Live Tracker

A browser-based tool for tracking TikTok LIVE auction sales. TikTok supplies the
completed sale and final price, an employee identifies the physical item, and the
tracker combines those facts to calculate inventory and gross profit.

> **Project status:** early offline prototype. The completed-sale parser, read-only
> dashboard capture probe, and reconciliation engine are implemented and tested. They
> are not connected to a tagger interface, persistent storage, or Google Sheets yet.

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

If payment permanently fails after TikTok's payment buffer, the employee can mark the
variation unpaid. Inventory remains unchanged because that auction never counted as a
sale. If the item is auctioned again, the employee maps its new variation number.

## Current implementation

### Implemented and tested

- A Manifest V3 Chrome extension that loads on the TikTok LIVE dashboard.
- A read-only `MutationObserver` capture probe for rendered completed-sale rows.
- A parser for variation number, final US-dollar price, and `Payment complete` text.
- An offline reconciliation engine that:
  - accepts employee mapping and payment events in either order;
  - prevents identical events from deducting inventory twice;
  - calculates remaining inventory, completed GMV, and gross profit;
  - supports mapping corrections, **Mark unpaid**, and undo;
  - surfaces unmapped sales, conflicting prices, and inventory shortages;
  - keeps auctions distinct by `(streamId, variationNumber)`.
- Automated parser and reconciliation tests using Node's built-in test runner.

### Not implemented yet

- The employee-facing tagger interface.
- Automatic detection of the current variation while bidding.
- Detection of TikTok's yellow payment-warning state.
- Persistent browser storage or recovery after a refresh/crash.
- Google Sheets inventory import and results export.
- A connection between the capture probe and reconciliation engine.
- End-of-stream analytics and live-stream validation.

## Development roadmap

1. Build the offline tagger interface in three focused stages:
   1. interface foundation;
   2. item-mapping workflow;
   3. payment lifecycle controls and testing.
2. Persist canonical stream state in browser storage.
3. Connect captured TikTok events to the reconciliation engine and tagger.
4. Create the Google Sheet template and choose the authentication approach.
5. Import inventory from Google Sheets and export reconciled results.
6. Validate current-auction, yellow-warning, and completed-sale behavior during a live
   stream.
7. Add end-of-stream reconciliation and analytics reporting.

## Project layout

| Path | Purpose | Status |
| --- | --- | --- |
| `extension/manifest.json` | Extension configuration and dashboard entry point | Implemented |
| `extension/capture/` | Read-only TikTok dashboard observation | Probe implemented |
| `extension/shared/sale-parser.js` | Completed-sale text parsing | Implemented |
| `extension/shared/reconciliation.js` | Inventory, payment, and gross-profit rules | Implemented |
| `extension/tagger/` | Employee queue and inventory picker | Planned |
| `backend/` | Optional future server-side Sheets/reporting code | Placeholder |
| `config/` | Backend-only credential placeholders, if a backend is selected | Not in use |
| `docs/` | Architecture and capture-development notes | In progress |
| `tests/` | Offline parser and reconciliation tests | Implemented |

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

### Load the capture probe in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension` directory.
5. Open or refresh `https://shop.tiktok.com/streamer/live/event/dashboard`.
6. Open DevTools and confirm the Console contains:

   ```text
   [TikTok Live Tracker] Capture probe active
   ```

On a blank offline dashboard, the startup message is the expected result. See
[Capture development notes](docs/capture-development.md) for an optional simulated-sale
test and the remaining live-stream checks.

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
