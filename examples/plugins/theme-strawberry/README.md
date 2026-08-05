# Strawberry Fields — example theme with a wallpaper and dual schemes

A **theme-only** plugin with a soft candy-pink identity: a tiled berry wallpaper
behind the main area, rounded gradient controls, generous shadows, and a full
light/dark pair that follows the system setting.

Zero JS, zero code execution. All art is procedurally generated and ships in the
package.

## What it demonstrates

This is the "everything together" example — it exercises every token group at
once, and shows how they interact:

| token group | used for |
| ----------- | -------- |
| `gradients` | header, sidebar, button, hover, card and input surfaces (per scheme) |
| `backgrounds` | the tiled `berry-tile.png` wallpaper plus a readability scrim |
| `frames`    | rounded candy bevel on cards, modals and buttons |
| `textColors`  | readable text on the saturated header and on button faces |
| `shadow`      | a pronounced `14px` lift, which suits the soft palette |
| `light`/`dark` | two complete palettes under one theme |

### Wallpaper plus gradient on one surface

The main area declares **both** a background image and a gradient. They share the
CSS `background-image` property, so the host composes them into one layer stack
rather than letting one erase the other:

```
scrim (readability wash)   ← top
berry-tile.png
gradient (base wash)       ← bottom
```

The scrim is what keeps text readable over the wallpaper. Light mode uses
`scrim-light` at `0.82`, dark uses `scrim-dark` at `0.88` — the dark variant needs
a heavier wash because the berry art is bright.

### Base tokens plus per-scheme overrides

Structural choices that don't depend on the color scheme (`radius`, `shadow`,
`fontFamily`, and the frame geometry) sit at the top level and apply to both
schemes. Only the colors are duplicated into `light` and `dark`. That keeps the
two palettes from drifting apart structurally.

## Where the art comes from

- `berry-tile.png` — 320×320, seamless. A pink vertical gradient with 26
  procedurally scattered berries. Placement uses a fixed seed, and distances wrap
  around the tile edges, so it repeats without visible seams.
- `frame-candy.png` — 32×32, 10px slice. Rounded pink bevel with a transparent
  center, so the card's own gradient shows through.

This is a synthetic stand-in for the photographic backdrop the community themes
use. It reproduces the palette and visual density, not anyone's artwork — a
packaged theme must not ship a real person's likeness or another product's assets.

## Readability is the theme author's job

A wallpaper plus themed text is the easiest way to make an unreadable UI. Two
things matter:

1. **Always pair a background image with a scrim** on any surface that holds text.
2. **Style a surface completely.** An early version of this theme set a gradient
   on `card` but not `input`, which left dark-mode inputs as light boxes under
   light text. If you theme a surface's background, check its text color too.

## Install

An administrator installs the package, then each user enables the theme under
**Settings → Appearance → Plugin Theme**. Enablement is per-user.

## Regenerating the art

Keep any tile's feature placement wrap-aware (compute distances modulo the tile
size) or the repeat will show seams. For the frame, keep the border inset equal on
all four sides so a single `slice` value applies.
