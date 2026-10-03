# TikTok Live Tracker: Claude Code instructions

Claude-only companion to the shared rules in `AGENTS.md`, imported below. Those rules
apply to Claude sessions exactly as written; where `AGENTS.md`, the README, or the
handoff says "Codex", read it as including Claude Code. Keep this file durable: commit
hashes, test counts, and feature history belong in `docs/LLM_HANDOFF.txt`.

@AGENTS.md

## Session start on any device

1. Read `README.md` and `docs/LLM_HANDOFF.txt`. Consult `docs/architecture.md` for
   data contracts and `docs/capture-development.md` for capture and manual checks.
2. Check `git status`, `git branch --show-current`, and `git log --oneline -10`.
   Note uncommitted work. Do not pull, switch branches, or stash.
3. The handoff is a dated snapshot. Its header can lag behind Git, for example by
   calling committed work uncommitted. Current code, tests, and Git win; report
   any drift you notice instead of acting on stale notes.
4. Then wait for the task. Reading the docs does not authorize work.

## What travels between devices

- Through Git: source, docs, `AGENTS.md`, and this file.
- Not through Git: Claude conversation history, Claude auto-memory under
  `~/.claude/projects/`, Chrome tracker data and reports, OAuth state, `node_modules/`,
  `dist/`, `tmp/`, and `scratch/`.
- Put durable project context in `docs/LLM_HANDOFF.txt`, never only in Claude memory:
  decisions, known issues, test results, and unfinished authorized work. Shared
  working rules go in `AGENTS.md`; Claude-specific rules go here.
- On a new device: Node >= 22.2.0, `npm ci --include=dev`, then `node --test`. In
  Windows PowerShell, use `npm.cmd`. Start Claude Code at the repository root and
  run `/memory` to confirm that this file and its `AGENTS.md` import loaded.
- The README section "Shared Codex instructions and switching devices" describes
  the device-switch routine. The user runs it; Claude runs it only when asked.

## Working with this user

- Keep replies short and lead with the verdict. Say what is confirmed and what is
  suspected. Never present a guessed TikTok DOM change as the established cause.
- Stay strictly in scope and do not bundle improvements. Requests to explain,
  review, plan, or write a prompt are read-only.
- Node tests are synthetic evidence only. List the native Chrome, TikTok, Sheets,
  layout, and PDF checks the user still needs to do manually.

## Claude tool boundaries

- Do not use Claude in Chrome, the built-in browser, or computer use on the TikTok
  dashboard, `chrome://extensions`, the extension, or Chrome profiles unless the
  user explicitly asks. The user does browser, layout, keyboard, and PDF checks.
- Do not read the inventory Sheet or real reports through Google Drive/Sheets
  connectors, web fetches, or any other route. Do not publish artifacts or docs
  that contain seller, buyer, or report data.
- Put temporary files in Claude's scratchpad, not the repo's `tmp/` or `scratch/`.
  Those folders hold the user's QA artifacts; never clean them up.
- Even in auto mode, do not stage, commit, or push without explicit authorization
  in the current request. For "git me commands", output the code block and do not
  run it. Never bypass sandbox or permission prompts to make a command run.

## Codebase orientation

- `extension/` is a plain JavaScript/HTML/CSS Manifest V3 extension. It has no
  build step, no framework, and no npm runtime dependencies. jsPDF, AutoTable, and
  the DejaVu fonts are vendored in `extension/vendor/`. The only npm package is
  `fflate`, a dev dependency used for release packaging.
- Every module is an IIFE that assigns `globalThis.TikTokLiveTracker<Name>` and
  `module.exports`. Chrome loads it through script lists; Node tests `require` it.
  Load order matters. When adding or renaming a module, update every relevant
  list: `manifest.json` content scripts, `service-worker.js` `importScripts`, and
  the `<script>` tags in `tagger/sidepanel.html` and `report/report.html`.
- Data flow: rendered dashboard DOM → `capture/` content scripts → validated
  runtime message → `service-worker.js` (sender checks, FIFO) →
  `shared/*-coordinator.js` → `chrome.storage` → change notification → side panel
  (`tagger/`) and report page (`report/`) through their `*-client.js` modules.
- The worker owns storage and every authoritative mutation. UI code never reads or
  writes `chrome.storage` directly.

## Invariants that are easy to break

- **Terminology:** "SKU #N" in the UI is TikTok's numbered auction entry, which the
  code calls `variation` / `variationNumber`. A bare "SKU" is the seller's exact
  inventory code, such as `TEE-M`. Only the user-facing wording was changed;
  internal names, keys, selectors, protocols, and saved data deliberately still use
  "variation". Do not rename them.
- An auction's identity is `(streamId, variationNumber)`. Money is stored as
  integer cents. Payment status and item mapping are independent.
- Storage schema/state versions, protocol versions, and the manifest version are
  separate. Do not bump one because another changed. Never treat invalid saved data
  as empty, and never migrate or clear it as a shortcut.
- Capture selectors and badge allowlists fail closed. Do not widen them (whole-page
  matching, new status aliases, cancellation timers) without evidence and a request.
- Keep the manifest's `key`, extension ID, OAuth client, scopes, permissions, and
  version unchanged.
- The report-library caps and End's save-the-report-first ordering are safeguards,
  not bugs. The handoff's known-issues section documents problems; it does not
  authorize fixes.

## Commands

```sh
npm ci --include=dev               # fresh clone or lockfile change
node --test                        # full offline suite; run after any code change
node --test tests/<name>.test.cjs  # focused file; the handoff's tests section lists groups
git diff --check                   # whitespace and newline check before handing back
npm run package                    # release ZIP; only when asked
```

Tests use Node's built-in `node:test` (`tests/*.test.cjs`) with synthetic fixtures,
fake timers, and lightweight DOM fakes or `vm` contexts; there is no DOM library.

## After a change

- Run the focused tests, the full `node --test`, and `git diff --check`. Report the
  real counts and any failures.
- Update the docs the change affects. Use `README.md` for user-facing behavior,
  `docs/architecture.md` for contracts, and `docs/capture-development.md` for
  capture and manual checks. In `docs/LLM_HANDOFF.txt`, update the snapshot header,
  decisions, test results, and remaining manual checks.
- List the remaining manual Chrome checks separately, and leave the commit to the user.
