/**
 * Cross-platform terminal runtime — wraps bun-pty (Rust portable-pty + Bun FFI).
 *
 * Works on Linux, macOS, and Windows (ConPTY).
 * Used as the default on Windows and as a fallback on Unix when Bun.Terminal
 * is unavailable.
 */

import { spawn as ptySpawn } from "bun-pty";
import type { TerminalRuntime, TerminalSpawnOptions } from "./runtime";

export function spawnPortablePty(opts: TerminalSpawnOptions): TerminalRuntime {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(opts.env)) {
		if (v !== undefined) env[k] = v;
	}

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
		},
		get pid() {
			return pty.pid;
		},
		get exited() {
			return exitPromise;
		},
	};
}
