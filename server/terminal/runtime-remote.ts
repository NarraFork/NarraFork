/** Remote terminal runtime backed by a PTY on a remote executor device. */
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	sendRpc as defaultSendRpc,
	type SendRpcOptions,
} from "../services/device-connection-service";
import type { TerminalRuntime, TerminalSpawnOptions } from "./runtime";

export const REMOTE_PTY_READY_FEATURE = "pty.ready-stream.v1";
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_QUEUED_WRITE_BYTES = 1024 * 1024;
const VALID_OUTPUT_CHANNELS = new Set(["pty"]);

type SendRpc = (
	deviceId: string,
	method: Parameters<typeof defaultSendRpc>[1],
	params: Record<string, unknown>,
	opts?: SendRpcOptions,
) => Promise<unknown>;

export interface RemotePtyDependencies {
	sendRpc?: SendRpc;
	readyTimeoutMs?: number;
	maxQueuedWriteBytes?: number;
}

export function spawnRemotePty(
	deviceId: string,
	opts: TerminalSpawnOptions,
	deps: RemotePtyDependencies = {},
): TerminalRuntime {
	const sendRpc = deps.sendRpc ?? defaultSendRpc;
	const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const maxQueuedWriteBytes = deps.maxQueuedWriteBytes ?? DEFAULT_MAX_QUEUED_WRITE_BYTES;
	const ptyId = `pty_${generateId()}`;
	const abort = new AbortController();
	let exitedResolve: (code: number | null) => void = () => {};
	const exitedPromise = new Promise<number | null>((resolve) => {
		exitedResolve = resolve;
	});
	let readyResolve: () => void = () => {};
	let readyReject: (error: Error) => void = () => {};
	const readyPromise = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	let exited = false;
	let ready = false;
	let readySettled = false;
	const queuedWrites: Uint8Array[] = [];
	let queuedWriteBytes = 0;
	let queuedResize: { cols: number; rows: number } | null = null;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(opts.env)) if (value !== undefined) env[key] = value;
	const decoder = new TextDecoder();

	const clearQueuedInput = () => {
		queuedWrites.length = 0;
		queuedWriteBytes = 0;
		queuedResize = null;
	};
	let readyTimer: ReturnType<typeof setTimeout> | null = null;
	const clearReadyTimer = () => {
		if (readyTimer) clearTimeout(readyTimer);
		readyTimer = null;
	};
	const resolveReady = () => {
		if (readySettled) return;
		readySettled = true;
		ready = true;
		clearReadyTimer();
		readyResolve();
	};
	const rejectReady = (error: Error) => {
		if (readySettled) return;
		readySettled = true;
		clearReadyTimer();
		readyReject(error);
	};
	const sendWrite = (bytes: Uint8Array) =>
		sendRpc(deviceId, "pty.write", {
			ptyId,
			dataB64: Buffer.from(bytes).toString("base64"),
		});
	const flushQueuedInput = () => {
		const writes = queuedWrites.splice(0);
		queuedWriteBytes = 0;
		for (const bytes of writes) void sendWrite(bytes).catch(() => {});
		if (queuedResize) {
			void sendRpc(deviceId, "pty.resize", { ptyId, ...queuedResize }).catch(() => {});
			queuedResize = null;
		}
	};
	const finishExited = (code: number | null, readyError?: Error) => {
		if (exited) return;
		exited = true;
		clearReadyTimer();
		clearQueuedInput();
		if (!ready) rejectReady(readyError ?? new Error("Remote PTY exited before becoming ready"));
		const tail = decoder.decode();
		if (tail) opts.onData(tail);
		exitedResolve(code);
	};
	const abortBeforeReady = (error: Error, kill: boolean) => {
		if (exited) return;
		if (kill) void sendRpc(deviceId, "pty.kill", { ptyId }).catch(() => {});
		abort.abort();
		finishExited(null, error);
	};

	readyTimer = setTimeout(() => {
		abortBeforeReady(new Error(`Remote PTY did not become ready within ${readyTimeoutMs}ms`), true);
	}, readyTimeoutMs);

	sendRpc(
		deviceId,
		"pty.open",
		{ ptyId, cmd: opts.cmd, cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env },
		{
			signal: abort.signal,
			longLived: true,
			onStream: (channel, chunk) => {
				if (exited) return;
				if (channel === "pty_ready") {
					if (!ready) {
						resolveReady();
						flushQueuedInput();
					}
					return;
				}
				if (!VALID_OUTPUT_CHANNELS.has(channel)) return;
				const text = decoder.decode(chunk, { stream: true });
				if (text) opts.onData(text);
			},
		},
	).then(
		(result) => {
			finishExited((result as { exitCode: number | null })?.exitCode ?? null);
		},
		(error) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			finishExited(null, normalized);
			logger.debug("Remote PTY session ended", { deviceId, ptyId, error: normalized.message });
		},
	);

	return {
		write(data) {
			if (exited) return;
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
			if (!ready) {
				if (queuedWriteBytes + bytes.byteLength > maxQueuedWriteBytes) {
					abortBeforeReady(
						new Error(
							`Remote PTY input queue exceeded ${maxQueuedWriteBytes} bytes before readiness`,
						),
						true,
					);
					return;
				}
				queuedWrites.push(Uint8Array.from(bytes));
				queuedWriteBytes += bytes.byteLength;
			} else {
				void sendWrite(bytes).catch(() => {});
			}
		},
		resize(cols, rows) {
			if (exited) return;
			if (!ready) queuedResize = { cols, rows };
			else void sendRpc(deviceId, "pty.resize", { ptyId, cols, rows }).catch(() => {});
		},
		close() {
			if (!ready) {
				abortBeforeReady(new Error("Remote PTY was closed before becoming ready"), false);
				return;
			}
			clearReadyTimer();
			abort.abort();
		},
		kill() {
			if (!ready) {
				abortBeforeReady(new Error("Remote PTY was killed before becoming ready"), true);
				return;
			}
			clearReadyTimer();
			void sendRpc(deviceId, "pty.kill", { ptyId }).catch(() => {});
			abort.abort();
		},
		get pid() {
			return null;
		},
		get exited() {
			return exitedPromise;
		},
		get ready() {
			return readyPromise;
		},
	};
}
