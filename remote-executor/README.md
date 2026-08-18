# NarraFork Remote Executor

A lightweight remote executor for NarraFork, written in Go. Deploy it on a
machine where running NarraFork itself is impractical; a narrator's file and
command tools (Read / Write / Edit / Glob / Grep / Bash) can then execute on
that machine.

The binary is **statically linked** (CGO disabled), so one build per CPU
architecture runs on any OS of the same arch without external dependencies.

## Build

```sh
make build        # host platform → ./narrafork-executor
make dist         # all platforms → ./dist/
make test         # run tests
```

Manual static build:

```sh
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o narrafork-executor ./cmd/narrafork-executor
```

## Install (recommended: one command)

You do not need to build or fetch the binary yourself. NarraFork mirrors published
executor releases and generates a single install command:

1. In NarraFork: **Settings → Remote Devices → Add device**. Choose the
   *reverse dial* connection mode (recommended; works behind NAT).
2. Pick the target platform and whether to install a machine-wide service or a
   user-level one, then copy the generated command.
3. Paste it on the target machine. It downloads the matching binary from your
   NarraFork instance, verifies its SHA-256, collects the device key, writes the
   config, and installs the service.

```sh
# Unix (the exact command, including its one-time ticket, comes from NarraFork)
sh -c "$(curl -fsSL 'https://your-narrafork-host/api/executor/install/linux-amd64?ticket=…')"
```

The key is never written into the command or the script, and never passed as a
command-line argument: the script fetches it once and stores it in a 0600 file
(ACL-restricted on Windows). Because the target machine only has to reach NarraFork
itself, this also works on hosts with no route to the public update server.

### What the install command is, security-wise

The command embeds a **short-lived enrollment ticket**, and that ticket can be
exchanged for the device key. So the command is a credential — treat it like one.
Three properties bound the risk:

- It expires in minutes.
- The key exchange works **once**, and performing it **rotates the device key**. If
  someone else runs your command first, your own run fails outright rather than
  quietly sharing a working key.
- NarraFork records when and from where the key was collected, shown on the device.

Because the key does cross the wire at that moment, automatic collection requires
**https**, a **loopback** address, or a **private network** where an admin has
allowed it (the checkbox at the bottom of **Settings → Remote Devices**, stored as
`devices.allowPlaintextEnrollmentOnPrivateNetwork`). Plaintext http on a publicly
routable address is always refused, whatever that setting says. "Private network"
here means a literal private IP address — a hostname is never eligible, because the
server cannot verify which network a name resolves to.

### Manual key entry

Choosing *Enter the key manually* in the install dialog produces a script that
contains no credential at all and prompts for the key instead (input hidden). It
requires a terminal and a human, and it works over plaintext http on any address.
Use it when automatic collection is unavailable, or when you would rather the
script be freely forwardable.

Stored keys are hashed and cannot be read back, so the install dialog offers to
issue one for this path — which replaces whatever key the device was using. Update
the token file on the device accordingly if it was already enrolled.

Everything below documents the fully manual path: building from source and wiring
up the flags yourself.

## Register a device manually

1. In NarraFork: **Settings → Remote Devices → Add device**. Choose the
   *reverse dial* connection mode (recommended; works behind NAT).
2. Copy the one-time registration token (shown only once).

## Run (reverse dial — recommended)

```sh
narrafork-executor \
  --server wss://your-narrafork-host/ws/device \
  --device <device-slug> \
  --token-file /path/to/device-token \
  --allow-root /home/you/projects
```

Configuration can also come from environment variables
(`NARRAFORK_EXECUTOR_SERVER`, `NARRAFORK_EXECUTOR_DEVICE`,
`NARRAFORK_EXECUTOR_TOKEN`, `NARRAFORK_EXECUTOR_TOKEN_FILE`,
`NARRAFORK_EXECUTOR_TOKEN_STDIN`, `NARRAFORK_EXECUTOR_ALLOW_ROOTS`,
`NARRAFORK_EXECUTOR_LISTEN`, `NARRAFORK_EXECUTOR_TLS_CERT`,
`NARRAFORK_EXECUTOR_TLS_KEY`, `NARRAFORK_EXECUTOR_DISABLE_SHELL`) or a JSON file
passed with `--config`. Precedence is flags > environment > config file. Within
one layer, configure exactly one of token, token-file, or token-stdin.

## Run (direct mode — NarraFork connects to the executor)

When the executor has a reachable address but NarraFork cannot accept inbound
device connections, use direct mode. The executor listens and NarraFork dials
it. Register the device with connection mode **direct** and set its WebSocket
URL to the executor's listen address (e.g. `wss://executor-host:7900/ws/device`).

```sh
narrafork-executor \
  --listen 0.0.0.0:7900 \
  --tls-cert /path/to/executor.crt \
  --tls-key /path/to/executor.key \
  --device <device-slug> \
  --token-file /path/to/device-token \
  --allow-root /home/you/projects
```

Direct mode uses nonce/HMAC mutual authentication, so the executor still needs
its registered device reference and token. A non-loopback listener must also use
TLS; bind to `127.0.0.1` or `[::1]` only when NarraFork connects locally.

### Flags

| Flag | Description |
|------|-------------|
| `--server` | NarraFork device WebSocket URL (`wss://host/ws/device`) |
| `--listen` | Direct-mode listen address. Non-loopback addresses require `--tls-cert` and `--tls-key`. |
| `--device` | Device slug or id from the registration |
| `--token` | Registration token (`rdev_…`). Avoid for long-running services because process arguments and shell history may expose it. |
| `--token-file` | Read the token from a permission-restricted regular file. `-` remains a compatibility alias for stdin. |
| `--token-stdin` | Read the token once from stdin at startup; useful with a secret manager or supervisor credential pipe. |
| `--tls-cert` / `--tls-key` | Direct-mode TLS certificate and private key PEM files. |
| `--allow-root` | Comma-separated roots for structured filesystem/transfer/search paths and Git/command working directories. Symlink/junction targets are resolved before containment checks. **This is not a process sandbox.** |
| `--disable-shell` | Disable the general `exec.start` (Bash) and `pty.open` command surfaces. Git and filesystem RPCs remain available. |
| `--cwd` | Default working directory reported to the server |
| `--insecure` | Skip TLS certificate verification (self-signed reverse-dial servers only) |

### Token input

Prefer a regular file readable only by the executor account:

```sh
install -m 600 /dev/null /path/to/device-token
# Paste the one-time token into /path/to/device-token using a secure editor.
narrafork-executor ... --token-file /path/to/device-token
```

On Unix, token files with group/other permissions are rejected. Token input is
limited to 4 KiB and must contain one non-whitespace token. For a secret manager
or service supervisor, pipe the secret without putting it in argv:

```sh
secret-manager read narrafork/device-token | narrafork-executor ... --token-stdin
```

`--token-file -` remains compatible with older scripts, but `--token-stdin` is
preferred because the intent is explicit. Token sources in the same config layer
are mutually exclusive; a command-line source overrides environment, which
overrides the JSON config file.

## Security notes

- A remote executor exposes filesystem and, by default, shell/PTY access to the
  NarraFork server. Run it as a dedicated least-privilege OS account.
- Direct mode permits unencrypted `ws://` only when `--listen` uses a loopback IP
  literal such as `127.0.0.1` or `[::1]`. Wildcards, LAN addresses, and hostnames
  including `localhost` require a certificate/key pair and TLS 1.2 or newer.
- Keep registration tokens out of argv and shell history. Prefer a mode-0600
  token file or `--token-stdin`; plaintext token environment/config fields are
  retained for compatibility but provide a weaker secret boundary.
- `--allow-root` protects structured filesystem, transfer, and search paths and
  validates the initial working directory used by Git and command RPCs.
  Configured roots, existing paths, and the nearest existing ancestor of create
  targets are resolved before the containment check, so a symlink or Windows
  junction cannot redirect those checked paths outside an allowed root.
  Recursive glob/transfer scans do not follow directory symlinks.
- **`--allow-root` is not a Bash or PTY sandbox.** For `exec.start` and
  `pty.open`, it validates only the initial working directory. Command text can
  still use absolute paths, change directory, create links, launch other
  programs, access the network, and otherwise exercise every permission of the
  executor's OS account.
- Use `--disable-shell` to remove the general Bash and PTY surfaces. Filesystem,
  search, transfer, and Git RPCs remain; Git/search binaries and their arguments
  are not an OS sandbox. Use a container, VM, dedicated account, and OS
  permissions when the NarraFork server or local users are not fully trusted.
  The path guard is also not designed to defeat a hostile same-user local
  process racing filesystem names between validation and the operating-system
  call.
- Prefer `wss://` (TLS). The registration token authenticates the device; it is
  hashed at rest on the server and can be rotated or revoked from the UI.
- Revoking a device (or rotating its token) immediately drops the live
  connection.

## Service templates

`deploy/` holds templates for running the executor as a managed service. The
generated installer produces equivalent units automatically; these are for manual
installs and for reviewing what the installer will do.

| File | Platform | Scope |
|------|----------|-------|
| `narrafork-executor.service` | Linux (systemd) | machine-wide, dedicated account |
| `narrafork-executor.user.service` | Linux (systemd) | per-user (`systemctl --user`) |
| `com.narrafork.executor.plist` | macOS (launchd) | LaunchDaemon or LaunchAgent |

On Windows, install as a service with `sc.exe`/`New-Service`, or register a
scheduled task at logon for a user-level install.

## Releasing

`bun scripts/release-executor.ts <version>` cross-compiles all six targets,
computes each binary's SHA-256, and publishes them plus a manifest
(`narrafork-executor-manifest.json`) to the update server's public tools channel.
Binaries upload before the manifest, so a manifest never references an artifact
that is not yet present. Use `--dry-run` to build and digest without uploading, or
`--platform=<os>-<arch>` to publish a single target.

## Capabilities

- Filesystem primitives (stat/read/write/remove/mkdirp/list/exists)
- Glob and ripgrep-backed grep
- Streaming command execution (process-group kill + timeout)
- Read-only git status/diff
- Interactive PTY terminals (Unix; Windows ConPTY not yet supported)
- **High-performance file transfer**: bidirectional (upload/download), chunked
  with per-chunk CRC-32C, resumable (crash/disconnect continues from the last
  durable chunk), parallel multi-chunk, and recursive directory transfer. File
  bytes travel as raw binary WebSocket frames (no base64 overhead).
- Direct connection mode (`--listen`) in addition to reverse dial

### File transfer

Transfers are driven from NarraFork (the Agent's `TransferFile` tool or the
device management UI). The executor exposes the `transfer.*` RPCs plus a binary
chunk-frame data plane; no extra configuration is needed beyond `--allow-root`,
which resolves and bounds the structured paths a transfer may read or write.
