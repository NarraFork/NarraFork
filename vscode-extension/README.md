# NarraFork for VS Code

A front end only. This extension does **not** contain a NarraFork backend — it connects to
one you are already running on the same machine and renders its UI in an editor panel.
Works in desktop VS Code and in browser-based editors such as code-server.

## Requirements

A running NarraFork backend. Start it however you normally do (`bun run start`, or the
released binary); the extension attaches to it.

## Install

```bash
bun scripts/package-vscode-extension.ts     # writes dist/narrafork-vscode-<version>.vsix
code --install-extension dist/narrafork-vscode-<version>.vsix
```

The version is taken from the repo's root `package.json`, so the extension and the backend
always report the same number.

## Usage

| Command | Effect |
|---|---|
| `NarraFork: Open Panel` | Open the panel, or focus it if already open (never reloads it) |
| `NarraFork: Reconnect` | Re-run discovery and reload the panel |
| `NarraFork: Sign Out` | Forget the stored token and sign out of the panel |
| `NarraFork: Open in Browser` | Open the same UI in an external browser |

`Reconnect` reloads the webview, so anything in flight (a streaming response, unsent input) is
discarded — use it when the backend moved or restarted. `Open Panel` deliberately never does
that.

The status bar shows the connection state and the port it found. Clicking it opens the
panel.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `narrafork.serverUrl` | `""` | Backend base URL. When set, **only** this address is tried. |
| `narrafork.openOnStartup` | `false` | Open the panel when the window loads. |

Leaving `serverUrl` empty enables discovery: the extension reads `server.port` from
`~/.narrafork/settings.json` (honouring `NARRAFORK_HOME`), then falls back to port 7778,
probing `/api/health` at each candidate.

Setting it explicitly disables the fallbacks on purpose. Falling back after you named an
address would connect you to a *different* backend while reporting success.

## Sign-in

You log in inside the panel, exactly as in a browser. The extension then keeps the session
token in VS Code's SecretStorage (the OS keychain), so later panels resume the session
instead of asking again. The token is never written to `settings.json` and never logged.

`NarraFork: Sign Out` removes the stored copy **and** ends the session in the panel, which
reloads back to the login screen. Both halves are required: the panel authenticates with its
own copy on the backend's origin, so clearing only the keychain would leave you logged in and
the next token renewal would simply repopulate it.

## How it connects

The panel is a thin webview that frames the SPA served by your backend. Loading the UI from
the backend — rather than bundling a copy — keeps the UI and API at the same version and
keeps the vsix small. The trade-off is that the panel needs a reachable backend; there is
no offline mode.

The URL the webview loads comes from `vscode.env.asExternalUri`, which resolves differently
per environment:

- **desktop**: loopback, unchanged;
- **code-server**: `<code-server-root>/proxy/<port>/`, a path-stripping proxy;
- **Remote SSH / dev containers / tunnels**: a forwarded address.

The backend supports all three because its front end resolves every URL against the mount
prefix rather than the origin root (`frontend/lib/base-path.ts` plus the `<base href>` the
server injects). That work also makes a plain reverse-proxy subpath deployment possible.

## Troubleshooting

**Status bar shows `⚠ NarraFork`.** Nothing answered `/api/health`. Hover it to see which
addresses were tried. Start the backend, or set `narrafork.serverUrl`.

**Panel is blank in code-server.** Check the *NarraFork* output channel for the URL it
loaded. code-server's proxy also requires its own authentication, so the browser session
must be logged in to code-server itself.

**Signed out unexpectedly.** The backend rotates the session token as it nears expiry, and
the panel reports each new value to the extension. If you see repeated sign-outs, check the
output channel for `ignored a token-changed message`.

## Development

```bash
cd vscode-extension
bun install
bun run watch            # incremental compile
bun run typecheck
```

Then press <kbd>F5</kbd> in VS Code with this folder open to launch an Extension
Development Host.

Tests for the parts that do not touch the `vscode` API live in the repo root's suite
(`tests/vscode-extension/`) and run with `bun test`.
