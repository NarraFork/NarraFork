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
		// `detached` calls setsid() on POSIX, which is what actually gives the child
		// a CONTROLLING terminal — not just a PTY on its stdio. Without it the child
		// gets /dev/pts/N as stdin/stdout but stays in our session, so:
		//   - `/dev/tty` cannot be opened, so anything that reads a secret straight
		//     from the terminal (sudo, ssh, git credential prompts, gpg) fails
		//     instead of prompting. This was the visible bug: sudo in a terminal
		//     was unusable whenever dtach was missing.
		//   - bash prints "cannot set terminal process group / no job control in
		//     this shell" and Ctrl-C kills nothing, because there is no foreground
		//     process group to signal.
		//   - closing the PTY sends no SIGHUP, so the shell and its children leak.
		//     (Verified: without setsid a killed terminal left `sleep` children
		//     alive; with it, shell and children exit.)
		//
		// The name is misleading here: this does not detach the child's lifetime
		// from ours in any way that matters, because its stdio IS our PTY. Closing
		// the PTY hangs up the session, which is exactly the cleanup we want.
		detached: true,
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
