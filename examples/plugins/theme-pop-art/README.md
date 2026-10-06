# Pop Art Themes (example theme-only plugin)

A **theme-only** NarraFork plugin: it contributes two high-saturation pop-art
color themes as whitelisted design tokens. It ships no server and no UI view, so
it is zero-JS and zero-code-execution — the host compiles the tokens into scoped
Mantine CSS-variable overrides.

Themes:
- **Pop Art** (light) — tomato-red primary, cream-yellow canvas.
- **Pop Art Night** (dark) — magenta primary, near-black canvas, neon accents.

## Install & use

Because this is a `theme-only` plugin, **any logged-in user** can install and
use it — no administrator and no capability grant required. The plugin system is
enabled by default (`settings.plugins.enabled`).

1. Package the folder into a `.zip` whose root contains `manifest.json`, and put
   it under the import root `~/.narrafork/plugin-imports/`:
   ```bash
   cd examples/plugins/theme-pop-art
   zip -r -X ~/.narrafork/plugin-imports/theme-pop-art.zip manifest.json sbom.spdx.json
   ```
2. In **Settings → Plugins**, click **Install** and enter `theme-pop-art.zip`.
3. Enable the plugin (the ▶ action in the list).
4. Go to **Settings → Appearance → Plugin theme** and pick **Pop Art** or
   **Pop Art Night**. Selecting a theme enables it for your account and applies
   it immediately. The choice is per-device and does not affect other users.

> Non-theme-only plugins (those with a `server` or `views`) still require an
> administrator to install and enable.
