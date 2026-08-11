# Catalyst

**An IDE for the AI-first world.** Catalyst is a desktop workspace for running
multiple AI coding CLIs — Claude Code, Codex, Gemini CLI — across all of your git
repositories from a single window.

It doesn't wrap or re-implement any AI. It spawns the real CLI in a
pseudo-terminal and bridges it to a full terminal in the UI, with the branch, the
diff and the work item beside it.

**[See what it does →](https://oli-systems.github.io/Catalyst/)**

---

## Install

Grab the latest build from
**[Releases](https://github.com/OLI-Systems/Catalyst/releases/latest)**.

| Platform | File | Notes |
|---|---|---|
| Windows x64 | `Catalyst_<version>_x64-setup.exe` | Installs per-user — no administrator prompt. |
| macOS (Apple Silicon) | `Catalyst_<version>_aarch64.dmg` | Not notarized yet; see below. |

macOS builds are unsigned, so Gatekeeper blocks the first launch. Clear the
quarantine flag once:

```sh
xattr -dr com.apple.quarantine /Applications/Catalyst.app
```

Node.js ships inside the app, so there is nothing else to install for the app
itself.

### Prerequisites

- **Git** on your `PATH`.
- **At least one agent CLI.** Catalyst detects what you have and can install a
  missing one for you from **Settings → AI CLI**:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm i -g @anthropic-ai/claude-code`
  - [Codex](https://github.com/openai/codex) — `npm i -g @openai/codex`
  - [Gemini CLI](https://github.com/google/gemini-cli) — `npm i -g @google/gemini-cli`
- **Azure DevOps PAT** (optional) for work-item integration and PR creation.

## Updates

Catalyst checks GitHub Releases on launch and offers a newer build when there is
one. Every release is signed and the signature is verified before anything is
installed.

**Settings → Updates** shows the installed version, checks again on demand, and
installs a pending update with **Install & Restart**.

## Themes

Twenty themes, light and dark — Midnight, Nord, Dracula, Monokai, Rosé, Sand, VS
Light, Newsprint and more. Each one retints the whole window (sidebar, cards,
terminal, status bar) rather than a subset. Font family and size are configurable
too, under **Settings → Appearance**.

---

## How it works

Catalyst is a [Tauri v2](https://v2.tauri.app) shell around a local Node server.
The Rust shell spawns a bundled Node runtime as a "sidecar", waits for the
server's readiness line on stdout, then points its window at `http://localhost:<port>`.
The server picks a free port, so nothing conflicts if 4200 is taken.

```
Tauri window (WKWebView / WebView2)
   │  navigates to http://localhost:<port>
   ▼
Node sidecar — Express + WebSocket  ──node-pty──▶  claude / codex / gemini
   │                                                (real CLI processes)
   └─ git operations, Azure DevOps REST, repo scanning
```

Inside the page, terminals are xterm.js views bridged to PTYs over a WebSocket:

```
Browser (xterm.js)  <--WebSocket-->  Server (node-pty)  <--PTY-->  AI CLI process
     |                                    |
     | keystrokes, paste, images          | stdin/stdout/stderr
     | resize events                      | process lifecycle
     v                                    v
  Terminal UI                        claude / codex / gemini
```

**Session flow**

1. You select a repository and click an agent.
2. The server spawns that CLI via `node-pty` with the repo as its working directory.
3. A WebSocket bridges the browser's xterm.js terminal to the PTY.
4. Keystrokes go to the process as stdin; its output streams back in real time.
5. Extra terminals can be added per session (a plain shell, or another CLI).
6. Closing a tab kills the PTY.

**Image paste** — the browser encodes the image, the server writes it to a temp
file and types that path into the CLI's stdin. Temp images older than an hour are
cleaned up.

**Work items** — enter an Azure DevOps ID and the server fetches the title,
description, acceptance criteria and comments. **Start with task** sends that
context to the agent as a prompt, and can set the item to *In Progress*.

## Features

### Sessions
- Multiple agents in parallel tabs (up to eight)
- Inner split terminals within a session — a plain shell or another CLI
- Pin tabs to auto-launch on startup
- Reconnect with output-buffer replay

### Git
- Branch display with auto-refresh, switching and creation
- Pull, push, and PR creation
- Changed-file list with an inline Monaco diff viewer
- Optional worktree isolation so your main checkout stays untouched

### Repo intelligence
- Background stack detection on scan — Node.js, .NET/C#, Python, Go, Rust, Java,
  React, Express, TypeScript, Angular, Vue, Next.js
- Dev-environment detection — Docker, VS Code, Azure Pipelines, GitHub Actions,
  Visual Studio
- Per-repo results cached under `~/.catalyst/repos/`
- CLI availability detection with install prompts

### Terminal
- xterm.js with WebGL rendering
- Copy (`Ctrl+Shift+C`), paste (`Ctrl+V`), and `Ctrl+C/Z/L/D/A/E/U/W`
- Image paste
- Clickable links

### UI
- Command palette (`Ctrl+Shift+P`), Zen mode (`Ctrl+Shift+Z`)
- File explorer, status bar, script runner
- Twenty themes plus font controls

## Configuration

Settings live in `~/.catalyst/`:

- `sessions.json` — root directory, theme, Azure org/project
- `repos/` — per-repo build config and cached stack metadata

Access tokens are **not** stored here — they go to the OS credential store
(Windows Credential Manager, macOS Keychain). **Settings → Reset Catalyst** wipes
both the directory and the stored tokens.

> Installs that predate the rename kept this data under a differently-named
> directory. Catalyst moves it to `~/.catalyst` on first run, so existing
> settings and cached repo data carry over untouched.

---

## Build from source

**Prerequisites:** Node 18+, Rust (stable, via [rustup](https://rustup.rs)), and
platform build tools — VS Build Tools on Windows, Xcode Command Line Tools on
macOS. See [MACOS.md](MACOS.md) for macOS specifics.

```sh
npm install          # postinstall stages the Node sidecar runtime
npm run tauri:dev    # desktop app, hot-reloading server
npm run tauri:build  # installer under src-tauri/target/release/bundle/
```

To run just the server in a browser, without the desktop shell:

```sh
npm start            # then open the URL it prints (http://localhost:4200 by default)
```

Signing keys are only needed to produce an *updatable* build. Without
`TAURI_SIGNING_PRIVATE_KEY` set, `npm run tauri:build` fails because
`createUpdaterArtifacts` is enabled — pass `--bundles nsis` plus a throwaway key
(see `.github/workflows/ci.yml`) for a local unsigned build.

## Releasing

`.github/workflows/release.yml` builds and publishes on a version tag.

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json` (all three must match).
2. Commit, then tag and push:

   ```sh
   git tag v1.0.1
   git push origin v1.0.1
   ```

The workflow builds the Windows installer and the macOS bundle, signs the updater
artifacts, and publishes a release with the `latest.json` the in-app updater
reads.

### One-time repository setup

| What | Where | Why |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Settings → Secrets → Actions | Signs updater artifacts. Must match the `pubkey` in `src-tauri/tauri.conf.json`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Same | Only if the key has a password. |
| Pages source = **GitHub Actions** | Settings → Pages | Lets `pages.yml` deploy `site/`. |

To generate a keypair:

```sh
npx tauri signer generate -w ~/.tauri/catalyst.key
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/catalyst.key
```

Then put the matching `.key.pub` contents into `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`. **Keep the private key safe** — losing it means
existing installs can no longer verify updates.

## Project layout

```
server.js              Express + WebSocket server, sessions, git, Azure DevOps
lib/
  paths.js             ~/.catalyst location + one-time migration of older data
  session-manager.js   PTY session lifecycle
  session-store.js     Persistent settings
  repo-store.js        Per-repo settings and cached metadata
  credential-store.js  PATs via OS credential store
  worktree-manager.js  Git worktree isolation
public/                Single-page UI — app.js, style.css, desktop-shim.js
src-tauri/             Tauri v2 desktop shell (Rust) + bundling config
build/                 Sidecar staging and installer art scripts
site/                  GitHub Pages showcase
.github/workflows/     CI, release, and Pages automation
```

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 (Rust), WebView2 / WKWebView |
| Server | Node.js, Express 5, `ws` |
| Terminal | node-pty, xterm.js (WebGL) |
| Frontend | Vanilla HTML/CSS/JS |
| Diffs | Monaco Editor |
| Updates | `tauri-plugin-updater` against GitHub Releases |

## License

MIT © OLI Systems
