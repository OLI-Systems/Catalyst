# Code signing

Two different things get called "signing" here, and conflating them causes
confusion, so they are kept separate throughout:

| | What it protects | Status |
|---|---|---|
| **Updater signing** | That an update came from us and was not tampered with | **Done** — every release is signed and the app verifies before installing |
| **OS code signing** | That Windows and macOS recognise the publisher | **Not done** — this is what causes the warnings users see |

Updater signing already works and is unrelated to the warnings. Everything below
is about the second row.

## What users currently hit

**Windows.** Chrome downloads the installer completely, then refuses to name it,
leaving `Unconfirmed <n>.crdownload` in the downloads folder. The bytes are
intact — verified by comparing SHA-256 against the release asset — but a file
that appears not to have downloaded reads as a broken release. SmartScreen also
warns on first run.

Until the installer is signed, releases publish a **`.zip` containing the
installer** and the download page links that instead. Browsers do not apply the
same reputation checks to archives, so the download behaves normally. The `.exe`
is still published for anyone who prefers it.

**macOS.** Gatekeeper blocks the first launch of an unsigned, un-notarized app.
Right-click → Open, or `xattr -dr com.apple.quarantine`, gets past it. See
[MACOS.md](MACOS.md).

## Why not just make a certificate

A self-signed certificate does not help. Authenticode trust has to chain to a
root in the Microsoft Trusted Root Program, so a self-signed signature fails
validation on every machine but the one that created it:

```
Status:        UnknownError
StatusMessage: A certificate chain processed, but terminated in a root
               certificate which is not trusted by the trust provider
```

That is *worse* than shipping unsigned — an invalid signature is a stronger
negative signal than an absent one. The CI signing path was nevertheless
validated end to end against a throwaway self-signed certificate (import →
thumbprint → config overlay → `signtool` → `Successfully signed`), so the
plumbing is known to work and only needs a real certificate.

## Getting a real certificate for free

[SignPath Foundation](https://signpath.org/) provides free code signing to
qualifying open-source projects, with an OV certificate whose private key stays
in their HSM. Their [conditions](https://signpath.org/terms.html) map onto
Catalyst as follows.

### Already satisfied

- [x] **OSI-approved license, no commercial dual-licensing** — MIT
- [x] **Public repository, actively maintained, already released** — releases from v1.0.0
- [x] **No proprietary components** — all dependencies are open source
- [x] **Functionality documented on the download page** — the [Pages site](https://oli-systems.github.io/Catalyst/)
- [x] **Code signing policy on the project homepage** — the *Code signing* section of that page
- [x] **Verifiable automated builds from repository source** — `.github/workflows/release.yml`
      builds on a version tag; nothing is built or uploaded from a maintainer's machine
- [x] **Enforced metadata on signed binaries** — Tauri stamps product name and
      version from `tauri.conf.json`
- [x] **No telemetry, no bundled unwanted software, clean uninstall** — the app
      contacts GitHub only to check for a newer release
- [x] **Not a hacking or vulnerability-scanning tool**

### Needs a decision before applying

- [ ] **Nominate the three roles they require:**
  - *Authors* — may change source without review
  - *Reviewers* — must approve external contributions
  - *Approvers* — authorize each signing request
- [ ] **Enable MFA** for every team member, on both GitHub and SignPath
- [ ] **Company-backed project.** Catalyst is published under OLI Systems. Their
      terms do not list corporate backing as a disqualifier, but the program is
      aimed at community open source, so this is the one point most likely to
      draw a question. Worth stating plainly in the application rather than
      leaving them to discover it.

Applications take from a few days to a few weeks.

## When a certificate arrives

The release workflow is already wired and needs no code change — only secrets:

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | base64 of the code-signing `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the `.pfx` export password |

`Configure Windows signing` imports the certificate, reads its thumbprint and
passes it to the bundler as a config overlay, so the thumbprint never lands in
the repository. With the secrets absent the step logs that it is publishing
unsigned and the build proceeds unchanged.

SignPath does not hand over a `.pfx` — signing happens through their service, so
that integration replaces the step rather than filling in its secrets.

Then reverse the two workarounds:

1. Delete the `Publish a zipped installer` step from `release.yml`.
2. In `site/index.html`, remove the `/-setup\.zip$/` entry from `PREFER.win` so
   the signed `.exe` becomes the preferred download again, and restore the
   Windows install-card copy.

For macOS, see *Optional: signed and notarized macOS builds* in
[README.md](README.md) — that path needs a paid Apple Developer membership and
has no free equivalent.
