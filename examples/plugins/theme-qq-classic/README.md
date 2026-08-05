# Classic Messenger (2007) — example theme with glossy chrome

A **theme-only** plugin recreating the look of a mid-2000s desktop instant
messenger: glossy blue gradient title bar, bevelled nine-slice controls, a tiled
sky-and-grid panel texture and a serif type stack.

Zero JS, zero code execution. Every visual is either a whitelisted design token
or a procedurally generated bitmap shipped in the package.

## What it demonstrates

| token group | used for |
| ----------- | -------- |
| `gradients` | title bar, sidebar wash, button faces, input and card surfaces |
| `frames`    | bevelled borders on buttons, icon buttons, inputs, cards, modals |
| `backgrounds` | the tiled `panel-tile.png` texture behind the main area |
| `textColors`  | white text on the dark title bar; ink-blue on button faces |
| `fontFamily`  | `serif`, which is what carries the era's typographic feel |
| `shadow`      | a soft `8px` drop shadow for the card/modal lift |

The gradient stack is what does most of the work. A single button face is three
stops — white at the top, a fast falloff at 48%, saturated blue at the bottom —
which is the "glass" look that era leaned on:

```jsonc
"button": { "from": "#ffffff", "via": "#e2f0fb", "viaAt": 48, "to": "#b6d6ef" }
```

## Where the art comes from

All five bitmaps are generated from primitives (gradients, bevel math, a seeded
scatter). Nothing is traced or copied from any product's UI assets:

- `frame-blue.png` — 48×48, 16px slice. Glossy blue bevel for cards and modals.
- `frame-button.png` — 24×24, 8px slice. Softer, thinner bevel for compact controls.
- `panel-tile.png` — 256×256, seamless. Vertical sky wash with a 32px grid.

`panel-tile.png` tiles because its grid pitch divides its size, so the theme can
declare `size: auto` + `repeat: repeat` and get an unbroken texture at any
window size.

## Authoring notes

The frame `width` is deliberately much smaller than the `slice` on interactive
controls (`5px` rendered from a `8px` slice). A frame paints inward without
reserving layout space, so a thick frame on a small button overlaps its label.
Cards and modals get the fuller `10`–`12px` treatment because they have the room.

Text colors are set per surface because the global `text` token cannot express
"white on the dark title bar, ink-blue on the light button faces" — they are
different surfaces with opposite contrast needs.

## Install

An administrator installs the package, then each user enables the theme under
**Settings → Appearance → Plugin Theme**. Enablement is per-user, so turning it
on does not change anyone else's session.

## Regenerating the art

The art is deterministic. Any image with a consistent border inset works for the
frames; keep the inset equal on all four sides so a single `slice` applies, and
keep any tile's feature pitch a divisor of its size so it stays seamless.
