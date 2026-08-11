# Catalyst Welcome Port — Integration Guide

This patches your existing welcome screen with the refined design **without changing `app.js` or `server.js`**.

Everything hooks into the existing DOM via MutationObservers, so the real WebSocket data flow keeps working untouched.

---

## What's in this folder

| File | Purpose |
|---|---|
| `welcome-port.css` | All the new styles (scoped to `.welcome[data-port="v1"]` so it can't bleed) |
| `welcome-port.js`  | DOM enhancer: builds the new hero, filter, recent chips, and re-skins repo cards & the CLI picker |

---

## Steps (3 actions)

### 1. Copy the two files into `public/`

```
port/welcome-port.css  →  public/welcome-port.css
port/welcome-port.js   →  public/welcome-port.js
```

### 2. Wire them into `public/index.html`

In the `<head>`, **after** the existing `<link rel="stylesheet" href="style.css">`:

```html
<link rel="stylesheet" href="welcome-port.css">
```

At the bottom of `<body>`, **after** `<script src="app.js"></script>`:

```html
<script src="welcome-port.js" defer></script>
```

That's it. No app.js, no server.js, no HTML structure changes.

### 3. Restart and verify

```
npm start
```

Open `http://localhost:4200/`. You should see:

- New centered hero with a glowing `C_` mark
- Bigger folder bar with focus glow
- "Recent" chips row (populated as you click repos — backed by `localStorage`)
- Filter input in the "Git Repositories" section head with live count (`21/21`)
- Refined repo cards with status dots & tighter typography
- When a repo is selected: a monogram badge + breadcrumb path + tech-colored stack tags

---

## How it works (so you can extend it)

The enhancer hooks two MutationObservers:

- **`#repoGrid`** — every time `app.js` adds repo cards, we walk them and split `.repo-card-tech` (`Node.js · React · TypeScript`) into individual `<span data-tech-chip="...">` elements. The CSS in `welcome-port.css` colors each chip by tech (TypeScript blue, React cyan, .NET purple, etc).

- **`#repoInfoPanel`** — when `app.js` populates the CLI picker info, we wrap the name in a monogram + breadcrumb path row. Tags get a `data-tech="..."` attribute so the same color rules apply.

The filter input filters cards client-side using `display:none`. No backend changes.

---

## What's NOT included yet (and why)

These need backend data your current `scanRepoInfo` doesn't return:

- **Repo snapshot section** (branch, ahead/behind, last commit, branch count, open PR count) — needs `git` data per repo on scan
- **Activity sparkline** — needs `git log --since='14 days ago'` aggregation per repo
- **"Last opened" timestamps on cards** — needs a session history table

When you're ready to wire those, the CSS already supports them. Just have `scanRepoInfo` return a richer `repoInfo` object and the JS will surface it.

---

## Easy rollback

To turn the port off without removing the files, just delete the two new lines from `index.html`. Everything reverts to the original `style.css` rules.
