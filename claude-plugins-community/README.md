# Community mods

A pinned copy of [awesome-claude-code-mods](https://github.com/whyashthakker/awesome-claude-code-mods)
by Yash Thakker and contributors, MIT-licensed (see `LICENSE`), at commit
`c53a70b8787c4270029af9648d6eb7054c6c29c3` (2026-10-03).

Catalyst registers this folder with Claude Code as the `catalyst-community`
marketplace and installs nothing from it by itself: each mod is switched on or off
in **Settings → Mods**. The only change from upstream is the marketplace name in
`.claude-plugin/marketplace.json`, so it cannot clash with a checkout of the
upstream repository added under its own name.

## What was checked before vendoring

`claude plugin validate --strict` passes for all 70, and its report of what each
one calls was reviewed:

- No network requests, model calls, file writes, permission approvals, or
  rewritten tool calls or prompts.
- Processes: read-only `git --no-pager` commands only (`blame`, `branch -vv`,
  `check-ignore`, `diff --cached`, `grep`, `log`, `stash list/show`, `status`,
  `worktree list`).
- `turn.step` hooks forward the response unchanged and read its usage.
- `$.prompt.fill` (prompt-shelf, desktop-file-desk, desktop-prompt-builder) puts
  text in the composer without sending it.
- Notes-style mods keep what you type in Claude Code's plugin store.
- The 20 `desktop-*` mods draw only in the Claude Desktop app's Code tab.

## Updating

Re-copy `mods/`, `catalog.json` and `LICENSE` from a newer upstream commit, set the
marketplace name back to `catalyst-community`, re-run the checks above, and update
the commit here.
