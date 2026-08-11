# Building Catalyst on macOS

Catalyst is a Tauri v2 desktop app that bundles a Node backend as a "sidecar":
a copy of the Node runtime named with the target triple (e.g.
`catalyst-server-aarch64-apple-darwin`) plus a staged production backend under
`src-tauri/sidecar/` shipped as a Tauri resource. The Rust shell launches the
sidecar, reads its stdout for a readiness line, and points a WKWebView window at
the local server.

## Prerequisites

- **macOS 10.15+** (Catalina or later).
- **Xcode Command Line Tools**: `xcode-select --install`
- **Rust** (stable, via [rustup](https://rustup.rs)): `rustup toolchain install stable`
- **Node 18+** — the *same* Node binary you run `npm install` with becomes the
  bundled sidecar runtime, so use a Node you trust for production (a `brew`- or
  `nvm`-managed Node 18/20 LTS is fine).

## Build & run

1. **Install dependencies:**

   ```sh
   npm install
   ```

   The `postinstall` hook (`build/prepare-sidecar-bin.js`) copies the running
   Node binary into `src-tauri/binaries/` as `catalyst-server-<triple>`, where
   `<triple>` is `aarch64-apple-darwin` (Apple Silicon) or `x86_64-apple-darwin`
   (Intel). No `.exe` extension on macOS; the executable bit is set via `chmod`.

2. **Run in development:**

   ```sh
   npm run tauri:dev
   ```

3. **Produce a release bundle:**

   ```sh
   npm run tauri:build
   ```

   Output lands under `src-tauri/target/release/bundle/`:
   - `bundle/macos/Catalyst.app`
   - `bundle/dmg/Catalyst_<version>_<arch>.dmg`

   The `beforeBuildCommand` (`build/stage-sidecar.js`) assembles
   `src-tauri/sidecar/` (server + lib + public + production `node_modules`) and
   trims node-pty prebuilds down to the `darwin-*` set. `npm install` on macOS
   fetches the darwin node-pty prebuild automatically.

`bundle.targets` is `["nsis", "app", "dmg"]`. Tauri only builds targets
applicable to the host OS, so on macOS this produces the `.app` + `.dmg` and
ignores `nsis`; on Windows it produces only the NSIS installer.

## What's cross-platform

- **Credential storage** uses the macOS Keychain via the `security` CLI.
- **Shells** use `/bin/bash` plus the user's `$SHELL`.
- **Command detection** uses `command -v`.
- **PATH** includes the Homebrew prefix `/opt/homebrew/bin`.
- **CLI installers** use Homebrew on macOS.

## Known limitations

- **Must build on a Mac.** You cannot cross-build the `.app` or the darwin
  sidecar from Windows — the sidecar is a copy of the host's Node binary and the
  `.app`/`.dmg` bundlers require macOS tooling.
- **Unsigned builds trigger Gatekeeper.** A locally built `.app`/`.dmg` is not
  codesigned, so first launch is blocked. To open it:
  - Right-click the app → **Open** → confirm, **or**
  - Clear the quarantine attribute:

    ```sh
    xattr -dr com.apple.quarantine /path/to/Catalyst.app
    ```

- **Custom title-bar controls** are used on macOS as well (the window has
  `decorations: false`). Native traffic-light controls are a possible future
  enhancement.

## Distribution

For distribution outside your own machine you must **codesign and notarize** the
app (Apple Developer ID). This is not required for local use. See Tauri's macOS
signing documentation:
<https://v2.tauri.app/distribute/sign/macos/>
