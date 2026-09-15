# TikTok Live Tracker

A private Chrome side-panel extension for tagging TikTok LIVE auction variations,
tracking inventory, and saving post-stream reports. It reads the visible TikTok
dashboard and imports inventory from Google Sheets. Tracker state and reports stay
in the local Chrome profile; there is no application backend or cross-device sync.

The extension is intended for one tracker session and one dashboard per computer.
Separate computers keep separate inventory baselines, sessions, and reports.

## Load the extension in Chrome

1. Put the `extension/` folder in a permanent location. Recipients need only this
   folder, not the whole repository or Node.js.
2. In Chrome, open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Confirm the extension ID is **`lmkljkejmicknleeldfgekbbgpnegcmo`**.
5. Open the TikTok dashboard, refresh it if it was already open, and click the
   extension's toolbar action to open the tracker.

Use current desktop Chrome on Windows or macOS; the manifest minimum is Chrome 114.
Keep the manifest's public key and matching OAuth client unchanged so each install
uses the same permanent extension ID. No Chrome Web Store publication or **Pack
extension** step is part of this private installation workflow.

### Google Sheets access

The manifest already contains the configured Chrome Extension OAuth client and the
read-only `spreadsheets.readonly` scope. The Google Cloud project owner must keep
the Sheets API enabled, use **External / Testing**, and add each connecting Google
account under **Audience → Test users**. That account also needs access to the Sheet.

Test users are configured for the project, not individually for each OAuth client.
Sheets authorizations in Testing generally expire after seven days, so users may
need to reconnect. See [Google's audience and testing documentation](https://support.google.com/cloud/answer/15549945?hl=en).

The extension does **not** write inventory back to Google Sheets. Use the report's
copy or CSV export to update the Sheet manually.

## Start and run a stream

1. Prepare a Google Sheet with a tab named **Inventory**. Use the
   [inventory template](docs/google-sheets-inventory-template.csv) and these six headers:

   ```csv
   sku,item,style,size,quantity_on_hand_at_import,unit_cost
   ```

   Each size needs its own unique SKU. Enter the opening physical stock count and
   unit cost for each row.
2. In the tracker, paste the Sheet link or ID, choose **Connect and preview**, review
   the inventory, and confirm the baseline.
3. Open `https://shop.tiktok.com/streamer/live/product/dashboard`. Keep the relevant
   **LIVE auctions / Sold items** content available for capture.
4. Choose **Start stream tracking**. Returning to an existing local session uses
   **Resume stream tracking**; it does not create a new session.
5. Assign inventory items to variations as they appear. Review unresolved payments,
   unmapped sales, and stock warnings before ending.
6. Choose **End Stream Tracking → End and create report** to save the report and
   end local tracking. This does not end the TikTok broadcast. If the report cannot
   be saved, tracking stays active; resolve the error and retry.

Closing the panel does not end the session. After reloading/updating the extension,
refresh the TikTok dashboard to load its current capture scripts.

To append inventory during tracking, first update the same Sheet, then use
**Add new SKUs from updated Sheet → Check and add**. Existing SKU values must remain
unchanged; this workflow adds new SKUs, not edits to existing stock or costs.

### Inventory controls

- Enter a captured or preset variation number in **Var #** and press Enter to review it.
  Typing alone does not switch variations.
- Search filters by SKU, item, style, or size. Cards group matching item/style rows;
  choosing a size still selects its exact SKU.
- Left-click selects or unmaps the item for the viewed variation.
- On the live variation, right-click maps an unassigned variation; if it is already
  mapped, right-click toggles the next-item queue.
- While viewing history, right-click targets the live/newest variation without
  changing the historical selection or the queue.
- The queue holds one SKU for the next genuinely newer bidding variation and does
  not overwrite an existing mapping.
- The red inventory-header badge shows that queued item even when search hides
  its card. Its **×** clears only the queue, not an item mapping.
- **Return to live item** resumes following the newest variation.
- Pins move cards to the front. Otherwise cards retain their original order;
  completing a sale does not reorder them.

A mapped bidding or unresolved variation reserves one unit. A completed, priced sale
counts toward revenue even if it has no item assigned, but inventory consumption,
cost of goods, and gross profit require a mapping. A terminal cancellation releases
the reservation. Newly captured **Payment failed**, **Canceled**, or **Cancelled**
means canceled. **Payment processing** stays unresolved until a final status is
captured or manually resolved; the tracker has no five-minute cancellation timer.
Older saved `payment_failed` records, and legacy failure badges accompanied by an
explicit cancellation countdown, remain unresolved rather than being reclassified.

### Plan items ahead with presets

After confirming inventory, start or resume the local tracker session. You can do
this before TikTok LIVE begins. Once the existing loading state finishes and the
tracker is ungrayed, choose **Preset items** above the Variation selector—even with
no live auction or captured variations yet. The **Reload Site** state does not block
planning; Connecting/Loading and other save/error safeguards still do. Enter
the total numbered range for this stream and press Enter: **200 means #1–#200**, not
200 additional variations. The preset-only limit is **1,000**; the total cannot be
below the highest captured variation. Real capture can continue beyond the range.
Before submitting, press Escape or click outside the total field to discard the
draft and return to **Preset items** without saving.

When you first save presets before any variations have been captured, **#1** opens
automatically so you can immediately select its item. If capture or your view changes
while saving, the tracker keeps that newer view instead. Extending presets or
reopening the panel does not automatically select #1.
Choose other **untracked** variations from the dropdown or Var #. Before the first
capture, an unselected dropdown opens at **#1**; an existing selection is preserved.
Normal live/history behavior and the dropdown's newest-first order stay unchanged.
These are planning placeholders: no stock is reserved or deducted and no order is
added to reports until the variation is actually captured. Capture then applies the
ordinary mapping/payment rules. **Return to live item** stays hidden until a real
variation is captured. After that, it appears when reviewing an earlier variation
or future preset and resumes live following when clicked.

While viewing a future preset, right-click an item to plan faster: if the current
preset is empty, it receives the item and stays selected. Otherwise, the worker
assigns the next higher empty, uncaptured preset and opens it after saving. Already
assigned or captured variations are skipped. For multi-size items, choose the exact
size from the picker. Right-click never replaces or unassigns a future assignment.
When no later empty preset remains, it makes no changes and announces **No more
future variations.** Left-click still changes or clears the current future item.
Live and captured historical views retain their existing right-click behavior.

A preset on the next variation disables next-item queuing and clears an existing
conflicting queue. It does not disable right-click mapping of the live variation.
An empty preset range alone does not disable queuing.

The bubble becomes **Reset presets** after saving. Reset removes all uncaptured
placeholders and their planned assignments, preserves captured variations and
mappings, and returns to live. While live capture is within the preset range, reset
first to choose another total.

If actual live capture exceeds the total (for example, #101 after presetting 100),
the bubble automatically becomes **Preset items** again. Enter a larger total to
extend the range without deleting skipped, still-uncaptured assignments or changing
your selected variation. This is not an automatic reset. At #100 the bubble still
says **Reset presets**; browsing future entries or historical backfill alone never
unlocks extension. Extension remains available after the live item finishes and the
panel reopens. The 1,000 preset limit still applies: beyond it, normal tracking
continues but another preset range cannot be created within the supported limit.

Presets survive
refresh/reopening for the same stream, but never carry into a new stream or inventory
baseline. Changing presets is unavailable during initial loading or another save.

### Capture startup badge

| Badge | Meaning |
| --- | --- |
| Blue — Connecting | Waiting for initial capture communication. |
| Yellow — Loading | Core capture is initialized and its initial deliveries are finishing. |
| Green — Capture active | Startup completed for this tracking session/dashboard page. |
| Neutral — Reload Site | Startup could not be established; reload the TikTok dashboard. |

Green stays green after startup, including during missing GMV, website glitches,
delivery activity, or disconnections. It is a readiness indicator, **not an ongoing
connection or completeness check**. A new session or newly loaded dashboard document
starts another cycle; ordinary updates and reopening the panel do not restart yellow.

Blue and yellow show a spinner, dim the tracker, and lock editing except scrolling
and **End Stream Tracking** with its confirmation controls. Capture and retries
continue. Green/Reload Site remove only this startup lock; other save/error safeguards
remain. Missing GMV does not block startup. There is no red badge or auto-hide timer.
Setup and Resume/End-only screens do not show the row. Reduced-motion settings
stop spinner rotation.

If the active variation stops updating, reload the website or extension. See
[startup-readiness details](docs/capture-development.md#capture-health-indicator).

## Post-stream reports

Reports include the saved name and tracking dates, notices, performance metrics,
SKU results, variation details, and updated inventory. The default report name uses
the **tracking-start time**. Rename current reports in Business Records or edit the
name at the top of the report. Restore an archived report to Business Records before
renaming it.

### Library and downloads

- **Business Records** holds up to **5** recent reports; **Archived Reports** holds
  up to **25** more. Saving beyond five recent reports archives the oldest finalized
  report when there is room. Older reports are **never automatically deleted**.
- The combined library also has an approximately **4 MiB** serialized-data limit.
  Large reports can reach it before all 30 slots are used.
- Before starting a stream, the capacity bubble beside **View archived reports**
  warns about both report slots and saved-library size. Storage warnings start yellow
  at 80% used and turn red at 90%. Three or fewer remaining slots trigger a red
  warning; when both limits are close, the bubble combines them.
  Usage includes pending reports and the same serialized-data overhead as the save
  safeguard. Download needed reports, then deliberately delete unwanted archived
  reports to free space; archiving alone does not free space. Even below 80%, a large
  new report may exceed the remaining space, so this is not a guarantee it will fit.
- If the library cannot accept a report, the normal End action fails without ending
  the session. Free report space before starting: saved-report management is hidden
  during tracking. If capacity blocks End, contact the maintainer for recovery; Retry
  alone does not free space. Do not clear extension storage or uninstall to recover.
- Each report's three-dot menu offers **Download PDF**. Archived Reports supports
  checkboxes, **Select all**, **Clear selection**, and **Download selected**.
- To remove a recent report without archiving it first, choose **Delete** in its
  three-dot menu, then **Delete forever** in the confirmation dialog. Cancel keeps
  the report. Archived reports use the same permanent-delete confirmation.
- Bulk downloads create one PDF per report, with progress and failure reporting.
  Keep the panel open until the job finishes; closing/reloading it does not resume
  unfinished exports as a background job.
  Filenames use sanitized report names. Case-insensitive duplicate filenames within
  the selected batch block all downloads until the reports are renamed or deselected.
  Individual reports can be downloaded again; existing files are not overwritten.
- Direct PDFs are generated locally with bundled libraries and include all report
  tables and variation rows. No report data is uploaded for PDF generation.
- **Print / Save as PDF** remains available through Chrome's print dialog. For that
  path, open **Show details** first if the collapsed variation table should be printed.
  Use browser printing when the bundled PDF fonts cannot represent a report's text.

### Report corrections

These actions have different effects:

- **Finish unresolved payments** resolves eligible temporary payment errors on the
  newest eligible report, with no active tracker and the same current inventory
  baseline/session. This changes the underlying payment and inventory state and
  regenerates the report.
- **Correct Item Mapping** changes completed/canceled variation mappings in an
  eligible finalized report, with no active tracker or unresolved/pending report
  conditions. Changes apply to that saved report and its inventory export only,
  not the tracker's inventory, other reports, or future streams.
- **Correct SKU Unit Cost** changes costs in a finalized current or archived report,
  including unsold SKUs, and recalculates that report and its inventory export.
  It does not change the tracker's inventory, other reports, or future streams.

### Update inventory in Google Sheets

1. Review report notices and corrections. Duplicate the Google Sheet's **Inventory**
   tab as a backup.
2. In the report, choose **Copy Updated Inventory**.
3. Return to the original **Inventory** tab, click **A1**, and paste with **Ctrl+V**
   on Windows or **Cmd+V** on macOS.
4. Keep the complete six-column export in its exported order. Alternatively use
   **Download Updated Inventory CSV** for a full-table replacement.

Pasting replaces cells by position; it does not merge or look up rows by SKU.
Do not apply an older report over newer stock changes without reconciling them.
Pending reservations are separate from completed sales. Oversold exports clamp the
replacement quantity to zero, but the shortage still needs a physical recount.

### Reading the metrics

**Gross Item Sales** and **AOV** use captured, priced completed orders, including
unmapped ones. Cost of goods and gross profit depend on mapped completed sales;
missing mappings make those inventory/profit results incomplete.

**TikTok Attributed GMV** is the captured dashboard display and may be rounded or
include shipping. The 6% fee and after-fee figures are approximate estimates based
on that GMV, not actual settled fees or net profit.

## Data safety and current limits

- Sessions, inventory, mappings, and reports are stored in this Chrome profile.
  Sharing the extension folder or syncing Git does not transfer them.
- `unlimitedStorage` removes Chrome's normal `storage.local` quota. It does not
  remove the report-library limits or growing history/memory/performance costs.
- There is no full backup/restore feature. PDFs and CSVs are useful exports, not
  restorable copies of editable tracker data. Uninstalling the extension removes
  its local storage; see [Chrome's storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage).
- Capture reads the supported dashboard's rendered content, not an authoritative
  TikTok order API. Missing/changed/virtualized content can limit what is captured.
  Green confirms startup readiness, not ongoing connection or complete capture.
- There is no verified TikTok room/session identity, automatic Google Sheets
  write-back, multi-item queue, cross-device data sync, or automatic extension update.

### Credentials and privacy

The manifest public key and OAuth client ID are public configuration. Never include
a private `.pem` key, downloaded credentials, tokens, or real seller data in a release
or commit. Google authentication uses Chrome's identity flow.

Private installation and OAuth Testing do not waive Google's user-data policy,
including the privacy-policy requirement. See the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).
No public-store listing is needed for the installation workflow above.

## Develop and share updates

Development requires Git and Node.js **22.2 or newer** (Windows execution tested with
Node 24). From the repository root, install the pinned development dependency once
after cloning, or after the lockfile changes:

```sh
npm ci
```

Run the full offline suite independently with:

```sh
node --test
```

Tests use synthetic fixtures; real TikTok capture, Google authorization, Chrome
downloads, and Windows/macOS layout still need appropriate manual checks.
The [developer checklist](docs/capture-development.md) contains detailed procedures.

For work across Mac and PC, commit and push before switching computers, then use
`git pull --ff-only` on the other computer. The committed `.gitattributes` normalizes
text files to LF.

### Package a release

```sh
npm run package
```

This validates the current working-tree extension, runs `node --test`, and creates
`dist/TikTok-Live-Tracker-<manifest version>.zip`. With the current version, that is
`dist/TikTok-Live-Tracker-1.0.0.zip`. The ZIP contains **extension/manifest.json** and
the complete extension folder, including PDF libraries, fonts, and licenses. Only
the ZIP filename gets the version; the folder inside stays **extension**.

The packager copies file bytes unchanged, checks the ZIP's entries/checksums/extracted
bytes against the source snapshot, and stops if source files change during the run.
It excludes OS junk, rejects symlinks/unsafe paths and detected keys or credentials,
and refuses to overwrite an existing same-version ZIP. Move/remove that artifact
yourself or deliberately update the manifest version before packaging again. Use a
local disk supporting hard links (such as NTFS or APFS) for atomic no-overwrite output.
Generated ZIPs and `dist/` stay outside Git.

The only packaging dependency is development-only
[fflate 0.8.3 (MIT)](https://github.com/101arrowz/fflate/releases/tag/v0.8.3), pinned in
`package-lock.json`; it is not added to the extension. Static resource checks cover
manifest references, literal HTML/CSS/JavaScript paths, and the current dynamically
named PDF fonts. They do not replace browser testing of arbitrary dynamic paths.
Secret scanning is a precaution, not a guarantee; review the folder before sharing.

Packaging automates ZIP preparation only. It does not transfer reports, touch Chrome
profiles, install updates, or change the extension's version or identity. The code is
cross-platform; a macOS packaging/extraction smoke test remains a manual check.

To distribute the update:

1. Keep the existing public key and OAuth client. When releasing a new version,
   update the version metadata deliberately; do not generate a new identity.
2. Run **npm run package** and send the resulting ZIP to recipients.
3. Finish any active tracking before updating. Replace the installed folder's code
   with the new contents, keeping the same folder path and extension ID. Avoid an
   accidental nested `extension/extension/` directory.
4. Click **Reload** on the existing extension at `chrome://extensions`, then refresh
   the TikTok dashboard. **Do not uninstall and reinstall** to update.

The current storage implementation preserves saved data across ordinary code
replacement/reload with the same extension identity and Chrome profile.

## Further documentation

- [Architecture and data contracts](docs/architecture.md)
- [Capture pipeline, setup details, and manual validation](docs/capture-development.md)
- [Google Sheets inventory template](docs/google-sheets-inventory-template.csv)
