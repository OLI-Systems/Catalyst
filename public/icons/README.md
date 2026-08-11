# Catalyst — Logo Assets

The mark is a **benzene ring with a pulsing active site**. The hexagon is the workspace; the dot above it is the agent attached to it. Reads as chemistry, doesn't shout it.

## Files

### SVG (master — edit these)

| File | Use |
|---|---|
| `catalyst-mark.svg` | Mark only, transparent, accent color. For inline use against your own background. |
| `catalyst-mark-square.svg` | Mark on dark rounded-square tile. App icon. |
| `catalyst-mark-light.svg` | Mark on white tile, darker cyan for contrast. App icon on light backgrounds. |
| `catalyst-wordmark.svg` | Mark + "CATALYST" wordmark in mono. Use for splash screens, docs, headers. |

### PNG (rendered for raster contexts)

| File | Size | Use |
|---|---|---|
| `catalyst-mark-192.png` | 192×192 | PWA manifest (small) |
| `catalyst-mark-256.png` | 256×256 | General |
| `catalyst-mark-512.png` | 512×512 | PWA manifest (large), iOS app icon |
| `catalyst-mark-1024.png` | 1024×1024 | macOS app icon, hi-res displays |
| `catalyst-mark-transparent.png` | 256×256 | Transparent BG — for use against any color |
| `catalyst-wordmark.png` | 1080×240 | Splash / hero / docs |

## Where to drop these in the Catalyst app

```
catalyst-mark-192.png   →  public/icons/icon-192.png
catalyst-mark-512.png   →  public/icons/icon-512.png
catalyst-mark-256.png   →  public/icons/icon-256.png (if your manifest uses it)
```

Then update `public/manifest.json` to point at these. Its `name` / `short_name` are already `Catalyst`.

The favicon in `public/index.html` is currently inline SVG — replace the SVG data URI in that `<link rel="icon">` with the contents of `catalyst-mark-square.svg` (URL-encoded) or just point it at `/icons/icon-192.png`.

## Color tokens

- **Accent (dark theme):** `#38bdf8`
- **Accent (light theme):** `#0284c7`
- **Dark BG (tile):** `#05070c`
- **Light BG (tile):** `#ffffff`
- **Text on dark:** `#eaf1f9`

The mark uses `currentColor` so you can recolor the SVG by setting the parent's `color`.
