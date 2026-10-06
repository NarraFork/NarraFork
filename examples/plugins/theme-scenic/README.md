# Scenic (Background) — example theme with a packaged background image

A **theme-only** plugin that paints a background image (bundled inside the
package, `assets/bg.png`) onto a controlled host region, with a readability
scrim and per-scheme variants.

- **Light mode** — bright canvas, light scrim over the image (opacity 0.85).
- **Dark mode** — deep canvas, dark scrim over the image (opacity 0.7).

Zero JS, zero code execution. The image ships in the package; the host serves it
from a same-origin, capability-checked endpoint and compiles the whitelisted
tokens into scoped CSS.

## How backgrounds work

A theme declares `backgrounds` under `tokens` (or under `light`/`dark`), keyed by
a **controlled region**:

| region   | paints |
| -------- | ------ |
| `body`   | page background |
| `app`    | the whole app shell |
| `main`   | the main content area |
| `navbar` | the sidebar |
| `header` | the top bar |

Each background sets `image` (a **package-relative path**, never a URL), plus
optional `size` / `position` / `repeat` / `overlay` (`none` \| `scrim-light` \|
`scrim-dark`) / `opacity` (0–1). The host:

1. serves the image from `/api/plugins/ui/<pluginId>/<version>/<hash>/theme-asset/<path>`
   (same-origin; authorized by the exact package hash + the plugin being enabled;
   only paths the theme declares are served);
2. builds that URL itself and emits `background-image: url("…")` scoped to the
   region's stable host class — plugins never write a raw `url()` and can't
   target arbitrary selectors;
3. layers the scrim above the image for text readability.

External URLs, traversal, and absolute paths are rejected. SVG images are served
with hardening headers (`Content-Security-Policy`, `nosniff`) so no script runs.

## Install & use

`theme-only` ⇒ any logged-in user can install and use it. Upload the packaged
`.zip` in **Settings → Plugins → Install**, enable it, then pick **Scenic
(Background)** in **Settings → Appearance → Plugin theme**.
