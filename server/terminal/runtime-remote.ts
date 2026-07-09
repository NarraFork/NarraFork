/**
 * Remote terminal runtime — a TerminalRuntime backed by a PTY on a remote
 * executor device. Spawn/write/resize/kill are forwarded as PTY RPCs; terminal
 * output arrives via the long-lived pty.open stream and is delivered through the
 * spawn options' onData callback.
 */

import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { sendRpc } from "../services/device-connection-service";
import type { TerminalRuntime, TerminalSpawnOptions } from "./runtime";

export function spawnRemotePty(deviceId: string, opts: TerminalSpawnOptions): TerminalRuntime {
	const ptyId = `pty_${generateId()}`;
	const abort = new AbortController();
	let exitedResolve: (code: number | null) => void = () => {};
	const exitedPromise = new Promise<number | null>((resolve) => {
		exitedResolve = resolve;
	});
	let exited = false;

	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(opts.env)) {
		if (v !== undefined) env[k] = v;
	}

	const decoder = new TextDecoder();

	// pty.open is long-lived: stream carries output, resolution carries exit code.
	sendRpc(
		deviceId,
		"pty.open",
		{
			ptyId,
			cmd: opts.cmd,
			cwd: opts.cwd,
			cols: opts.cols,
			rows: opts.rows,
			env,
		},
		{
			signal: abort.signal,
			// PTY sessions are long-lived: no timeout, and excluded from the
			// per-device short-RPC concurrency cap.
			longLived: true,
			onStream: (_channel, chunk) => {
				opts.onData(decoder.decode(chunk));
			},
		},
	).then(
		(result) => {
			exited = true;
			exitedResolve((result as { exitCode: number | null })?.exitCode ?? null);
		},
		(err) => {
			exited = true;
			logger.debug("Remote PTY session ended", {
				deviceId,
				ptyId,
				error: err instanceof Error ? err.message : String(err),
			});
			exitedResolve(null);
		},
	);

	return {
		write(data: string | Uint8Array) {
			if (exited) return;
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
			void sendRpc(deviceId, "pty.write", {
				ptyId,
				dataB64: Buffer.from(bytes).toString("base64"),
			}).catch(() => {
				// PTY may have exited between checks — ignore.
			});
		},
		resize(cols: number, rows: number) {
			if (exited) return;
			void sendRpc(deviceId, "pty.resize", { ptyId, cols, rows }).catch(() => {
				// ignore
			});
		},
		close() {
			// Closing the runtime aborts the long pty.open RPC (which kills the PTY).
			abort.abort();
		},
		kill() {
			void sendRpc(deviceId, "pty.kill", { ptyId }).catch(() => {
				// ignore
			});
			abort.abort();
		},
		get pid() {
			// Remote PTYs don't expose a local pid.
			return null;
		},
		get exited() {
			return exitedPromise;
		},
	};
}
