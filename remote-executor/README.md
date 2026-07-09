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

## Register a device

1. In NarraFork: **Settings → Remote Devices → Add device**. Choose the
   *reverse dial* connection mode (recommended; works behind NAT).
2. Copy the one-time registration token (shown only once).

## Run (reverse dial — recommended)

```sh
narrafork-executor \
  --server wss://your-narrafork-host/ws/device \
  --device <device-slug> \
  --token rdev_xxxxxxxx \
  --allow-root /home/you/projects
```

Configuration can also come from environment variables
(`NARRAFORK_EXECUTOR_SERVER`, `NARRAFORK_EXECUTOR_DEVICE`,
`NARRAFORK_EXECUTOR_TOKEN`, `NARRAFORK_EXECUTOR_ALLOW_ROOTS`,
`NARRAFORK_EXECUTOR_LISTEN`) or a JSON file passed with `--config`.
Precedence: flags > env > file.

## Run (direct mode — NarraFork connects to the executor)

When the executor has a reachable address but NarraFork cannot accept inbound
device connections, use direct mode. The executor listens and NarraFork dials
it. Register the device with connection mode **direct** and set its WebSocket
URL to the executor's listen address (e.g. `ws://executor-host:7900/ws/device`).

```sh
narrafork-executor --listen :7900 --allow-root /home/you/projects
```

In direct mode the NarraFork server supplies the device identity when it
connects, so `--device` / `--token` are optional on the executor side.

### Flags

| Flag | Description |
|------|-------------|
| `--server` | NarraFork device WebSocket URL (`wss://host/ws/device`) |
| `--device` | Device slug or id from the registration |
| `--token` | Registration token (`rdev_…`) |
| `--allow-root` | Comma-separated path prefixes the executor may access. **Strongly recommended** — without it the executor can read/write anything the OS user can. |
| `--cwd` | Default working directory reported to the server |
| `--insecure` | Skip TLS certificate verification (self-signed servers only) |

## Security notes

- A remote executor exposes shell + filesystem access to the NarraFork server.
  Always set `--allow-root` to constrain the reachable paths.
- Prefer `wss://` (TLS). The registration token authenticates the device; it is
  hashed at rest on the server and can be rotated or revoked from the UI.
- Revoking a device (or rotating its token) immediately drops the live
  connection.

## Capabilities

- Filesystem primitives (stat/read/write/mkdirp/list/exists)
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
which also bounds the paths a transfer may read or write.
