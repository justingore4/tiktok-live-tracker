# TikTok Live Tracker: shared development instructions

These repository rules apply on Windows and macOS, regardless of Codex account.

## Starting work

- At the start of a new session, read `README.md` and `docs/LLM_HANDOFF.txt`.
  Consult `docs/architecture.md` and `docs/capture-development.md` when relevant.
- Before editing, inspect `git status`, the current branch, recent commits, and
  existing changes. Do not assume `main` or a clean worktree.
- Verify behavior against current code and tests. Another account's conversation
  history is not a source of project context; documentation can become outdated.
- Documentation provides context, not permission to begin unrelated work.

## Scope and safety

- Follow the requested scope and wait when asked not to begin. Explanations,
  reviews, prompts, and requests for Git commands do not authorize implementation
  or execution of the proposed commands; relevant read-only inspection is allowed.
- Preserve unrelated work. Do not commit, push, switch branches, discard changes,
  or perform destructive Git operations without explicit authorization.
- Do not access real reports, Chrome profiles, live tracker state, Sheet contents,
  or credentials without explicit authorization. Never commit secrets or seller data.
- Preserve extension identity, manifest settings/version, permissions, OAuth
  configuration, saved-data contracts, and existing safeguards unless a change is
  explicitly authorized. Do not clear or migrate user data as a shortcut.

## Development and verification

- Reuse the existing architecture and dependencies. Keep authoritative mutations
  in the worker/coordinator workflow, not direct side-panel storage access.
- Use Node.js **22.2.0 or newer**, as specified in `package.json`. For a fresh clone
  or changed lockfile, install locked dependencies with `npm ci --include=dev`.
  Development dependencies are needed for the full test suite.
- After code changes, run relevant focused tests and the full `node --test` suite
  from the repository root. Report failures or checks that could not run honestly.
- Use synthetic fixtures and isolated test environments. Automated passes are not
  proof of native browser behavior; identify remaining manual checks separately.
- Chrome loads `extension/`, which contains `manifest.json`; no frontend build is
  needed. Reload the extension and dashboard to test updated capture scripts.
- Use repository-relative paths and shell-appropriate commands for Windows/macOS.
  In PowerShell, `npm.cmd` can be used instead of the `npm.ps1` wrapper. Never weaken
  security settings or bypass permissions merely to make a command run. Preserve LF
  normalization from `.gitattributes` and avoid newline-only changes.

## Documentation and handoff

- Update relevant documentation with material behavior changes. Keep implementation
  details, important decisions, known issues, test results, and unfinished authorized
  work in `docs/LLM_HANDOFF.txt`; do not add speculative roadmaps or feature suggestions.
- Keep these instructions concise and durable. Commit hashes, test counts, and feature
  history belong in the handoff, not this file.
- Git synchronizes source and documentation, not Chrome's saved inventory, sessions,
  or reports. Follow the README's device-switch routine only when authorized; do not
  automatically pull, commit, or push as a side effect of reading these instructions.
