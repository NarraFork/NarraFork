/**
 * Unix terminal runtime — wraps Bun.Terminal + Bun.spawn.
 *
 * Only available on POSIX systems (Linux, macOS).
 */

import type { TerminalRuntime, TerminalSpawnOptions } from "./runtime";

export function spawnBunTerminal(opts: TerminalSpawnOptions): TerminalRuntime {
	const pty = new Bun.Terminal({
		cols: opts.cols,
		rows: opts.rows,
		data(_term, data) {
			const text = typeof data === "string" ? data : new TextDecoder().decode(data);
			if (text) opts.onData(text);
		},
	});

	const proc = Bun.spawn(opts.cmd, {
		cwd: opts.cwd,
		env: opts.env as Record<string, string>,
		terminal: pty,
	});

	return {
		write(data: string | Uint8Array) {
			if (typeof data === "string") {
				pty.write(new TextEncoder().encode(data));
			} else {
				pty.write(data);
			}
		},
		resize(cols: number, rows: number) {
			pty.resize(cols, rows);
		},
		close() {
			pty.close();
		},
		kill() {
			proc.kill();
		},
		get pid() {
			return proc.pid;
		},
		get exited() {
			return proc.exited;
		},
	};
}
