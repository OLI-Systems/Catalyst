# TODO Finder

Find TODO, FIXME, and HACK notes in tracked files.

**Use it when:** Build a quick backlog from the code already in your repo.

![TODO Finder render preview](../../assets/screenshots/todo-finder.png)

*Screenshot of this mod's render tree in the fixture preview, with sample data. This is not a capture of the Claude Code application. [How previews are made](../../docs/SCREENSHOTS.md).*

## Install and open

```sh
claude plugin marketplace add whyashthakker/awesome-claude-code-mods
claude plugin install todo-finder@awesome-claude-code-mods
```

Run `/reload-plugins` in an existing session, then `/todo-finder`. Use Tab and Enter to operate controls; Esc closes the pane. Terminal and Desktop Code tab supported; pane UI is unavailable in `claude -p` and the VS Code chat panel.

Try the source without installing:

```sh
claude --plugin-dir ./mods/todo-finder
```

## Access and behavior

Runs read-only git grep on request. Tracked files only; requires Git.

Module variables reset on hot reload. All display output is bounded; viewers may truncate long content to 9,000 characters. Relative file paths and Git commands use the session working directory.

## Verify

Tested with Claude Code **2.1.288**. Minimum documented mods version: **2.1.287**. The API can change; validate against your installed version.

```sh
claude plugin validate mods/todo-finder --strict
claude plugin test mods/todo-finder
```

Tests cover plugin commands, pane isolation, both UI surfaces, and the behavior described in `tests/register.test.ts`. Drawing tests validate element trees; they do not verify pixels painted by the native apps. [Validation details](../../docs/VALIDATION.md).

MIT licensed. No runtime packages or build step required.
