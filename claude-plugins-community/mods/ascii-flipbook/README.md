# ASCII Flipbook

Play a local text animation whose frames are separated by a form feed.

**Use it when:** Preview ASCII storyboards in a pane without a video decoder.

![ASCII Flipbook render preview](../../assets/screenshots/ascii-flipbook.png)

*Screenshot of this mod's render tree in the fixture preview, with sample data. This is not a capture of the Claude Code application. [How previews are made](../../docs/SCREENSHOTS.md).*

## Install and open

```sh
claude plugin marketplace add whyashthakker/awesome-claude-code-mods
claude plugin install ascii-flipbook@awesome-claude-code-mods
```

Run `/reload-plugins` in an existing session, then `/ascii-flipbook`. Use Tab and Enter to operate controls; Esc closes the pane. Terminal and Desktop Code tab supported; pane UI is unavailable in `claude -p` and the VS Code chat panel.

Try the source without installing:

```sh
claude --plugin-dir ./mods/ascii-flipbook
```

Example: open `/ascii-flipbook` and enter `animation.txt` in its input.

## Access and behavior

Reads a chosen text animation (up to 128 KiB), uses a 2 fps timer. No ffmpeg, audio, video decoding, or network.

Module variables reset on hot reload. All display output is bounded; viewers may truncate long content to 9,000 characters. Relative file paths and Git commands use the session working directory.

## Verify

Tested with Claude Code **2.1.288**. Minimum documented mods version: **2.1.287**. The API can change; validate against your installed version.

```sh
claude plugin validate mods/ascii-flipbook --strict
claude plugin test mods/ascii-flipbook
```

Tests cover plugin commands, pane isolation, both UI surfaces, and the behavior described in `tests/register.test.ts`. Drawing tests validate element trees; they do not verify pixels painted by the native apps. [Validation details](../../docs/VALIDATION.md).

MIT licensed. No runtime packages or build step required.
