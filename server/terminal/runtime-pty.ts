/**
 * Cross-platform terminal runtime — wraps bun-pty (Rust portable-pty + Bun FFI).
 *
 * Works on Linux, macOS, and Windows (ConPTY).
 * Used as the default on Windows and as a fallback on Unix when Bun.Terminal
 * is unavailable.
 */

import { clearInheritableHandlesBeforeSpawn } from "../lib/win-handle-guard";
import type { TerminalRuntime, TerminalSpawnOptions } from "./runtime";

/**
 * bun-pty resolves its Rust shared library (`librust_pty`) at import time via FFI, and throws
 * when the library is absent. Importing it eagerly therefore turns an optional terminal backend
 * into a hard startup requirement — including on Linux/macOS, where `Bun.Terminal` is used and
 * this module is never called. A bundler that cannot follow the FFI/dlopen edge (Electrobun's,
 * for instance) then breaks server startup entirely.
 *
 * Requiring it lazily keeps the failure where it belongs: at the point a portable PTY is
 * actually requested, reported to the caller that asked for one.
 */
type PtySpawn = typeof import("bun-pty").spawn;

let ptySpawnFn: PtySpawn | null = null;

function loadPtySpawn(): PtySpawn {
	if (ptySpawnFn) return ptySpawnFn;
	// Synchronous require: callers are synchronous, and this must throw in their call frame.
	const mod = require("bun-pty") as { spawn: PtySpawn };
	ptySpawnFn = mod.spawn;
	return ptySpawnFn;
}

export function spawnPortablePty(opts: TerminalSpawnOptions): TerminalRuntime {
	const ptySpawn = loadPtySpawn();
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(opts.env)) {
		if (v !== undefined) env[k] = v;
	}

	clearInheritableHandlesBeforeSpawn();
	const pty = ptySpawn(opts.cmd[0], opts.cmd.slice(1), {
		name: "xterm-256color",
		cols: opts.cols,
		rows: opts.rows,
		cwd: opts.cwd,
		env,
	});

	const exitPromise = new Promise<number | null>((resolve) => {
		pty.onExit((e) => resolve(e.exitCode));
	});

	pty.onData((data) => opts.onData(data));

	return {
		write(data: string | Uint8Array) {
			pty.write(typeof data === "string" ? data : new TextDecoder().decode(data));
		},
		resize(cols: number, rows: number) {
			pty.resize(cols, rows);
		},
		close() {
			// bun-pty has no explicit close — kill is the cleanup path
		},
		kill() {
			pty.kill();
			// On Windows, pty.kill() only terminates the direct child (ConPTY host).
			// Shell processes and their children (e.g. cmd.exe → node.exe) may survive.
			// Use taskkill /T /F to recursively kill the entire process tree.
			if (process.platform === "win32" && pty.pid) {
				try {
					Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pty.pid)], {
						stdio: ["ignore", "ignore", "ignore"],
					});
				} catch {
					/* best effort — process may already be gone */
				}
			}
		},
		get pid() {
			return pty.pid;
		},
		get exited() {
			return exitPromise;
		},
	};
}
