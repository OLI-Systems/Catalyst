# Handoff Notes

Keep a dated list of progress and next steps, then copy it.

**Use it when:** Leave a useful handoff for the next session.

![Handoff Notes render preview](../../assets/screenshots/handoff-notes.png)

*Screenshot of this mod's render tree in the fixture preview, with sample data. This is not a capture of the Claude Code application. [How previews are made](../../docs/SCREENSHOTS.md).*

## Install and open

```sh
claude plugin marketplace add whyashthakker/awesome-claude-code-mods
claude plugin install handoff-notes@awesome-claude-code-mods
```

Run `/reload-plugins` in an existing session, then `/handoff-notes`. Use Tab and Enter to operate controls; Esc closes the pane. Terminal and Desktop Code tab supported; pane UI is unavailable in `claude -p` and the VS Code chat panel.

Try the source without installing:

```sh
claude --plugin-dir ./mods/handoff-notes
```

Example: open `/handoff-notes` and enter `Done: API parser. Next: verify empty responses.` in its input.

## Access and behavior

Stores user-entered items in this plugin’s local store, partitioned by workspace path. Each item has a separate key. No file writes or network. Uses the clipboard.

Module variables reset on hot reload. Workspace collections persist in Claude Code's local plugin store and reload when reopened. Deleting an item removes only that item's store key. Collections show the latest 100 items; concurrent changes to the same item use last-write-wins behavior. All display output is bounded; viewers may truncate long content to 9,000 characters. Relative file paths and Git commands use the session working directory.

## Verify

Tested with Claude Code **2.1.288**. Minimum documented mods version: **2.1.287**. The API can change; validate against your installed version.

```sh
claude plugin validate mods/handoff-notes --strict
claude plugin test mods/handoff-notes
```

Tests cover plugin commands, pane isolation, both UI surfaces, and the behavior described in `tests/register.test.ts`. Drawing tests validate element trees; they do not verify pixels painted by the native apps. [Validation details](../../docs/VALIDATION.md).

MIT licensed. No runtime packages or build step required.
