# TikTok Live Tracker

A tool for tracking live-stream sales in real time: an employee tags items as they
come up on stream, the tool watches for TikTok's payment confirmation, and only then
counts the sale — so revenue and inventory numbers match TikTok's actual completed orders.

## How it works

Sales are counted in two steps, not one:

1. **Tag** — the employee clicks an item while it's on screen. This links the TikTok
   item number (e.g. `#203`) to a style in the inventory sheet. The sale is now **pending**.
2. **Confirm** — the tool watches for that item number to turn green ("Payment complete")
   on the seller dashboard, then flips it to **sold**, records the profit, and
   decrements stock by one.

A tagged item that never goes green was never really a sale. It stays pending / unpaid,
and the unit returns to available stock.

> **Open question for the client:** when a payment fails for good, is the item
> re-auctioned later in the same stream, or is it gone? This decides whether
> `pending → failed` returns the unit to the available count and allows re-tagging
> under a new item number.

## Project layout

| Path | What lives here |
| --- | --- |
| `extension/` | The browser add-on — the core of the tool |
| `extension/manifest.json` | Browser permissions and entry points |
| `extension/capture/` | Reads sales + payment status off the seller dashboard |
| `extension/tagger/` | The click-to-tag menu the employee uses on stream |
| `extension/shared/` | Helpers used by both capture and tagger |
| `backend/` | **Optional** — only if reporting / sheet writes move server-side |
| `backend/sheets/` | Google Sheets connection (reads inventory, writes results) |
| `backend/logic/` | Profit and inventory math |
| `backend/report/` | End-of-stream report generator |
| `config/` | Settings and API keys — **git-ignored, never committed** |
| `docs/` | Notes, client-facing explanation, link to the Sheet template |

`backend/` is optional on purpose. A working first version can be just `extension/`
talking directly to Google Sheets — add the backend later if the browser-only setup
gets outgrown.

## Setup

_Not yet implemented._ Next build step is the Google Sheet template, since both
capture and tagger read from it.

Credentials go in `config/` (copy `config/.env.example` to `config/.env` and fill it in).
That folder is git-ignored so API keys never reach GitHub.

## Development

Built in VS Code. Recommended extensions are listed in `.vscode/extensions.json`.
