# Duo (Light + Dark) — example dual theme-only plugin

A single **theme-only** plugin that carries two palettes in one theme and follows
the system light/dark setting automatically:

- **Light mode** — warm daylight: teal primary, cream canvas, terracotta accent.
- **Dark mode** — cool midnight: sky-cyan primary, near-black canvas, coral accent.

It ships no server and no UI view (zero JS, zero code execution). The host
compiles the whitelisted tokens into scoped Mantine CSS-variable overrides.

## How the dual theme works

The theme sets `colorScheme: "both"` and provides `light` and `dark` sub-token
sets under `tokens`. Top-level tokens (here `radius`) are a shared base applied
to both schemes; each sub-set overrides colors for its scheme. The host emits:

```
:root[data-plugin-theme="com.example.duo__duo"]                                  { --mantine-radius-*: … }
:root[data-plugin-theme="com.example.duo__duo"][data-mantine-color-scheme="light"] { light palette }
:root[data-plugin-theme="com.example.duo__duo"][data-mantine-color-scheme="dark"]  { dark palette }
```

So one selection in **Settings → Appearance → Plugin theme** tracks the system
(or your Light/Dark toggle) without needing two separate themes.

## Install & use

`theme-only` ⇒ **any logged-in user** can install and use it — no administrator,
no capability grant. Install by uploading the packaged `.zip` in
**Settings → Plugins → Install**, or select an already-present package on the
server. Then pick **Duo (Light + Dark)** in **Settings → Appearance → Plugin
theme**. Your choice is per-device and does not affect other users.
