# Env Example

List variable names and missing placeholders in an example env file.

**Use it when:** Review setup requirements without reading your real .env.

![Env Example render preview](../../assets/screenshots/env-example.png)

*Screenshot of this mod's render tree in the fixture preview, with sample data. This is not a capture of the Claude Code application. [How previews are made](../../docs/SCREENSHOTS.md).*

## Install and open

```sh
claude plugin marketplace add whyashthakker/awesome-claude-code-mods
claude plugin install env-example@awesome-claude-code-mods
```

Run `/reload-plugins` in an existing session, then `/env-example`. Use Tab and Enter to operate controls; Esc closes the pane. Terminal and Desktop Code tab supported; pane UI is unavailable in `claude -p` and the VS Code chat panel.

Try the source without installing:

```sh
claude --plugin-dir ./mods/env-example
```

Example: open `/env-example` and enter `.env.example` in its input.

## Access and behavior

Reads only paths named env example, sample, or template (up to 256 KiB). Displays variable names and placeholder presence; no values.

Module variables reset on hot reload. All display output is bounded; viewers may truncate long content to 9,000 characters. Relative file paths and Git commands use the session working directory.

## Verify

Tested with Claude Code **2.1.288**. Minimum documented mods version: **2.1.287**. The API can change; validate against your installed version.

```sh
claude plugin validate mods/env-example --strict
claude plugin test mods/env-example
```

Tests cover plugin commands, pane isolation, both UI surfaces, and the behavior described in `tests/register.test.ts`. Drawing tests validate element trees; they do not verify pixels painted by the native apps. [Validation details](../../docs/VALIDATION.md).

MIT licensed. No runtime packages or build step required.
