# Framed (Nine-Slice) — example theme with bitmap border art

A **theme-only** plugin that uses a packaged bitmap (`assets/frame.png`) as the
border of controlled host targets: buttons, icon buttons, inputs, cards and
modals. The art is stretched as a nine-slice, so corners stay crisp at any
control size.

Zero JS, zero code execution. The plugin declares only whitelisted design
tokens; the host serves the image from a same-origin, capability-checked endpoint
and compiles the tokens into scoped CSS.

## How frames work

A theme declares `frames` under `tokens` (or under `light`/`dark`), keyed by a
**controlled target**:

| target        | frames |
| ------------- | ------ |
| `button`      | buttons (normal state) |
| `buttonHover` | buttons on hover (excludes disabled) |
| `actionIcon`  | icon buttons |
| `card`        | cards |
| `paper`       | generic surfaces |
| `modal`       | modal content |
| `navbar`      | the sidebar |
| `header`      | the top bar |
| `input`       | text inputs |

Each frame sets:

| field    | meaning |
| -------- | ------- |
| `image`  | **package-relative path** to a raster image, never a URL |
| `slice`  | inset (1–64 px) from each edge of the *source image* that forms the corners and edges |
| `width`  | rendered thickness in px (1–64), defaults to `slice` |
| `repeat` | `stretch` \| `repeat` \| `round` \| `space` — how edges tile between corners |
| `fill`   | `true` to also paint the image's middle region as the element background |

### Authoring the art

`slice` describes the *source image*; `width` describes the *rendered result*.
This example ships a 48×48 PNG with a 16px border band, so `slice: 16` divides it
into a clean 3×3 grid.

Keeping them separate is the important part. A frame paints **inward** from the
element's edge without reserving layout space (see below), so on a small control
a thick frame will overlap the label. That's why this theme slices at 16 but
renders buttons and inputs at `width: 5`–`6`, and only lets roomier surfaces
(cards, modals) use the full-weight `width: 14`.

Start from `width` ≈ `slice` for large surfaces, and scale `width` down for
compact controls.

## Why frames can't break the layout

The host compiles a frame to exactly one thing:

```css
:root[data-plugin-theme="com.example.framed__framed"] .mantine-Button-root {
	border-style: solid;
	border-width: 0;
	border-image-source: url("/api/plugins/ui/.../theme-asset/assets/frame.png");
	border-image-slice: 16;
	border-image-width: 6px;
	border-image-repeat: stretch;
}
```

`border-width` is always `0`, and the visual thickness rides on
`border-image-width`. A zero border reserves no space, so the content box is
untouched and a theme can never reflow the app. Neither a non-zero
`border-width` nor `border-image-outset` is expressible in the token schema —
outset paints outside the border box and gets clipped by any `overflow: hidden`
ancestor, so it would be unreliable rather than useful.

## Security boundary

Same shape as theme backgrounds:

- **No raw CSS.** `slice`/`width` are clamped integers, `repeat` is an enum,
  `fill` is a boolean. No plugin string reaches the stylesheet.
- **No arbitrary selectors.** Targets are a fixed enum mapped to stable host
  classes.
- **No external requests.** The plugin supplies a package-relative path; the host
  builds the same-origin URL at compile time. External URLs would leak the user's
  IP and online status.
- **Raster only.** `.png` `.jpg` `.jpeg` `.webp` `.gif` `.avif`. SVG is excluded
  because the asset endpoint is unauthenticated and same-origin, so an active
  content type would become script delivery.
- **Bounded output.** Each compiled theme has a hard CSS size cap; exceeding it
  drops the theme instead of emitting a truncated stylesheet.

## Install

Themes install like any other plugin (an administrator installs the package),
then each user enables the ones they want under **Settings → Appearance →
Plugin Theme**. Enablement is per-user: turning this theme on does not change
anyone else's session.

## Regenerating the art

`assets/frame.png` is a 48×48 RGBA PNG with a 16px bevelled band and a
transparent center. Any image with a consistent border inset works; keep the
inset equal on all four sides so a single `slice` value applies.
