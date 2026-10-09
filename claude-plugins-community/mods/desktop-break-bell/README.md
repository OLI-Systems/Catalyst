# Desktop Break Bell

Set an adjustable countdown with a visual progress chart and toast.

**Use it when:** Remember a break during a long desktop session.

![Desktop Break Bell fixture preview](../../assets/screenshots/desktop-break-bell.png)

*Desktop-surface native test-kit tree, painted in a browser fixture preview with sample data. This is not a Claude Desktop app capture. [Provenance](../../docs/SCREENSHOTS.md).*

## Install and open

Requires Claude Code 2.1.287+ in the **Claude Desktop Code tab**; tested with 2.1.288's native test kit. Chat/Cowork tabs do not host this API. WSL Desktop sessions do not support plugins. No runtime packages or build step.

Install the current checkout immediately from a terminal in this repository:

```sh
claude plugin marketplace add .
claude plugin install desktop-break-bell@awesome-claude-code-mods
```

Or install the published collection:

```sh
claude plugin marketplace add whyashthakker/awesome-claude-code-mods
claude plugin install desktop-break-bell@awesome-claude-code-mods
```

Start a new **local Code session** in Claude Desktop, or run `/reload-plugins` in an open Code session, then `/desktop-break-bell`. Click controls or use Tab and Enter; Esc closes the pane. Non-Desktop commands return a compatibility explanation. [Desktop setup and all 20 mods](../../docs/DESKTOP.md).

## Access and behavior

Uses a local one-second clock and one completion toast; memory only, reset on reload. Does not play audio or send an OS notification.

Histories begin at load and reset on reload; no earlier activity is reconstructed. Store keys use the workspace directory; saved items are local to this plugin. Files/processes use session cwd. Stored content and clipboard exports can contain private information. No model calls, automatic prompt submissions, or permission approvals.

## Verify

```sh
claude plugin validate mods/desktop-break-bell --strict
claude plugin test mods/desktop-break-bell
```

Native tests cover command opening, pane isolation, Desktop controls at two widths, unsupported surfaces, error/empty states, and preview capture. These checks validate element trees and callbacks; native Desktop painting and keyboard acceptance remain a manual check. [Validation](../../docs/VALIDATION.md).

MIT licensed, with source and tests included.
