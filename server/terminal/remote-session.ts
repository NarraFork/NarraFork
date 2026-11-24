/**
 * Remote terminal runtime backed by a durable executor session
 * (`session.durable.v1`, see docs/GENERAL_EXECUTOR-DESIGN.md).
 *
 * Unlike `runtime-remote.ts` (pty.open), the shell belongs to the executor
 * process: losing the device connection or restarting NarraFork only detaches.
 * Output is numbered by byte offset; this runtime remembers how far it has
 * consumed and resumes with `session.attach { since }` once the device is back,
 * so nothing is shown twice and a missing range is reported, never skipped.
 * Input carries a `writeId` and is sent in order, so a write retried after a
 * reconnect reaches the shell exactly once.
 */
import { SESSION_DURABLE_FEATURE } from "../lib/agent/execution/rpc-types";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	DeviceConnectionChangedError,
	DeviceOfflineError,
	isDeviceOnline as defaultIsDeviceOnline,
	sendRpc as defaultSendRpc,
	type SendRpcOptions,
} from "../services/device-connection-service";
import type { TerminalRuntime } from "./runtime";

export { SESSION_DURABLE_FEATURE };

const DEFAULT_MAX_QUEUED_WRITE_BYTES = 1024 * 1024;

type SendRpc = (
	deviceId: string,
	method: Parameters<typeof defaultSendRpc>[1],
	params: Record<string, unknown>,
	opts?: SendRpcOptions,
) => Promise<unknown>;

export interface RemoteSessionDependencies {
	sendRpc?: SendRpc;
	isDeviceOnline?: (deviceId: string) => boolean;
	maxQueuedWriteBytes?: number;
}

export interface RemoteSessionOptions {
	/** Present to start a new session; absent to resume an existing one. */
	open?: { cmd: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number };
	/** First unseen output byte when resuming (0 for a new session). */
	since: number;
	onData: (data: string, streamSeq: number) => void;
}

export interface RemoteSessionRuntime extends TerminalRuntime {
	/** Stop reading without stopping the shell (shutdown/restart). */
	detach(): void;
	/** Output bytes consumed so far. */
	readonly consumedSeq: number;
}

/** Executor session id for a terminal: deterministic, so a restart can find it again. */
export function terminalSessionId(terminalId: string): string {
	return `nf-term-${terminalId}`;
}

/** A transport loss the executor survives: wait for the device and resume. */
function isConnectionLoss(error: unknown): boolean {
	return error instanceof DeviceOfflineError || error instanceof DeviceConnectionChangedError;
}

/** Bytes at the end of `bytes` that start an unfinished UTF-8 sequence. */
export function utf8IncompleteTail(bytes: Uint8Array): number {
	for (let back = 1; back <= Math.min(3, bytes.length); back++) {
		const byte = bytes[bytes.length - back];
		if ((byte & 0xc0) === 0x80) continue;
		const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return back < needed ? back : 0;
	}
	return 0;
}

/**
 * Kills requested while a device was offline, delivered when it reconnects.
 * Without this, killing a terminal whose device is away would orphan its shell.
 */
const pendingKills = new Map<string, Set<string>>();
let pendingKillListener: ((event: { deviceId: string; status: string }) => void) | undefined;

function queueKill(deviceId: string, sessionId: string, sendRpc: SendRpc) {
	let set = pendingKills.get(deviceId);
	if (!set) {
		set = new Set();
		pendingKills.set(deviceId, set);
	}
	set.add(sessionId);
	if (pendingKillListener) return;
	pendingKillListener = (event) => {
		if (event.status !== "online") return;
		const ids = pendingKills.get(event.deviceId);
		if (!ids) return;
		pendingKills.delete(event.deviceId);
		for (const id of ids) {
			void sendRpc(event.deviceId, "session.kill", { sessionId: id })
				.then(() => sendRpc(event.deviceId, "session.release", { sessionId: id }))
				.catch((error) =>
					logger.warn("Deferred remote session kill failed", {
						deviceId: event.deviceId,
						sessionId: id,
						error: String(error),
					}),
				);
		}
	};
	eventBus.on("device:status", pendingKillListener);
}

/** Test hook: forget deferred kills and their listener. */
export function resetRemoteSessionStateForTests(): void {
	pendingKills.clear();
	if (pendingKillListener) eventBus.off("device:status", pendingKillListener);
	pendingKillListener = undefined;
}

export function spawnRemoteSession(
	deviceId: string,
	sessionId: string,
	opts: RemoteSessionOptions,
	deps: RemoteSessionDependencies = {},
): RemoteSessionRuntime {
	const sendRpc = deps.sendRpc ?? defaultSendRpc;
	const isDeviceOnline = deps.isDeviceOnline ?? defaultIsDeviceOnline;
	const maxQueuedWriteBytes = deps.maxQueuedWriteBytes ?? DEFAULT_MAX_QUEUED_WRITE_BYTES;
	const rpcOpts = { requiredFeatures: [SESSION_DURABLE_FEATURE] };

	let consumed = opts.since;
	let carry = new Uint8Array(0);
	const decoder = new TextDecoder();
	let stopped = false; // detached, killed or exited: no more reads
	let exited = false;
	let attach: AbortController | undefined;
	// Readers, the write pump and resize may all wait for the device at once.
	const onlineWaiters = new Set<() => void>();
	const wakeWaiters = () => {
		const waiters = [...onlineWaiters];
		onlineWaiters.clear();
		for (const wake of waiters) wake();
	};
	let pendingResize: { cols: number; rows: number } | undefined;

	let exitedResolve: (code: number | null) => void = () => {};
	const exitedPromise = new Promise<number | null>((resolve) => {
		exitedResolve = resolve;
	});

	const onStatus = (event: { deviceId: string; status: string }) => {
		if (event.deviceId !== deviceId) return;
		if (event.status === "online") wakeWaiters();
	};
	const onRevoked = (event: { deviceId: string }) => {
		if (event.deviceId === deviceId) finish(null, "the device was revoked");
	};
	eventBus.on("device:status", onStatus);
	eventBus.on("device:revoked", onRevoked);

	const stopListening = () => {
		eventBus.off("device:status", onStatus);
		eventBus.off("device:revoked", onRevoked);
		wakeWaiters();
	};

	function finish(code: number | null, reason?: string) {
		if (exited) return;
		exited = true;
		stopped = true;
		attach?.abort();
		stopListening();
		writeQueue.length = 0;
		queuedBytes = 0;
		if (reason) logger.info("Remote terminal session ended", { deviceId, sessionId, reason });
		exitedResolve(code);
	}

	function waitUntilOnline(): Promise<void> {
		if (isDeviceOnline(deviceId)) return Promise.resolve();
		if (stopped) return Promise.resolve();
		return new Promise<void>((resolve) => {
			onlineWaiters.add(resolve);
		});
	}

	function emitData(chunk: Uint8Array) {
		const joined = new Uint8Array(carry.length + chunk.length);
		joined.set(carry);
		joined.set(chunk, carry.length);
		consumed += chunk.length;
		const tail = utf8IncompleteTail(joined);
		carry = joined.slice(joined.length - tail);
		const text = decoder.decode(joined.subarray(0, joined.length - tail));
		if (text) opts.onData(text, consumed - carry.length);
	}

	function onStream(channel: string, chunk: Uint8Array) {
		if (stopped) return;
		if (channel === "session.data") {
			emitData(chunk);
			return;
		}
		if (channel === "session.gap") {
			let gap: { from?: number; to?: number } = {};
			try {
				gap = JSON.parse(new TextDecoder().decode(chunk));
			} catch {
				return;
			}
			if (typeof gap.to !== "number" || gap.to <= consumed) return;
			const missing = gap.to - consumed;
			// The partial character before the hole can never be completed.
			carry = new Uint8Array(0);
			consumed = gap.to;
			opts.onData(
				`\r\n\x1b[2m[NarraFork: ${missing} bytes of output were not retained by the device]\x1b[0m\r\n`,
				consumed,
			);
		}
	}

	async function readLoop() {
		while (!stopped) {
			await waitUntilOnline();
			if (stopped) return;
			attach = new AbortController();
			try {
				const result = (await sendRpc(
					deviceId,
					"session.attach",
					{ sessionId, since: consumed },
					{ ...rpcOpts, signal: attach.signal, longLived: true, onStream },
				)) as { exitCode?: number };
				if (stopped) return;
				const tail = decoder.decode();
				if (tail) opts.onData(tail, consumed);
				void sendRpc(deviceId, "session.release", { sessionId }, rpcOpts).catch(() => {});
				finish(typeof result?.exitCode === "number" ? result.exitCode : null);
				return;
			} catch (error) {
				if (stopped) return;
				if (isConnectionLoss(error)) {
					// The shell keeps running on the device; resume once it reconnects.
					if (isDeviceOnline(deviceId)) await new Promise((r) => setTimeout(r, 250));
					continue;
				}
				// Unknown session (executor restarted), unsupported executor, bad sequence.
				finish(null, error instanceof Error ? error.message : String(error));
				return;
			}
		}
	}

	// Input: one in-flight write at a time keeps order; each keeps its writeId
	// across retries so the executor applies it once.
	const writeQueue: { writeId: string; bytes: Uint8Array }[] = [];
	let queuedBytes = 0;
	let pumping = false;
	async function pumpWrites() {
		if (pumping) return;
		pumping = true;
		try {
			while (writeQueue.length > 0 && !stopped) {
				const next = writeQueue[0];
				try {
					await waitUntilOnline();
					if (stopped) return;
					await sendRpc(
						deviceId,
						"session.write",
						{
							sessionId,
							writeId: next.writeId,
							dataB64: Buffer.from(next.bytes).toString("base64"),
						},
						rpcOpts,
					);
				} catch (error) {
					if (isConnectionLoss(error)) continue;
					logger.warn("Remote terminal input dropped", {
						deviceId,
						sessionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				writeQueue.shift();
				queuedBytes -= next.bytes.byteLength;
			}
		} finally {
			pumping = false;
		}
	}

	async function sendResize() {
		while (pendingResize && !stopped) {
			const size = pendingResize;
			try {
				await waitUntilOnline();
				if (stopped) return;
				await sendRpc(deviceId, "session.resize", { sessionId, ...size }, rpcOpts);
				if (pendingResize === size) pendingResize = undefined;
			} catch (error) {
				if (!isConnectionLoss(error)) {
					pendingResize = undefined;
					return;
				}
			}
		}
	}

	let readyPromise: Promise<void>;
	if (opts.open) {
		readyPromise = sendRpc(
			deviceId,
			"session.open",
			{ sessionId, kind: "pty", ...opts.open },
			rpcOpts,
		).then(() => {
			void readLoop();
		});
		readyPromise.catch((error) =>
			finish(null, `open failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	} else {
		readyPromise = Promise.resolve();
		void readLoop();
	}

	return {
		write(data) {
			if (stopped) return;
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
			if (queuedBytes + bytes.byteLength > maxQueuedWriteBytes) {
				logger.warn("Remote terminal input dropped: queue full while the device is away", {
					deviceId,
					sessionId,
					queuedBytes,
				});
				return;
			}
			writeQueue.push({ writeId: generateId(), bytes: Uint8Array.from(bytes) });
			queuedBytes += bytes.byteLength;
			void pumpWrites();
		},
		resize(cols, rows) {
			if (stopped) return;
			const active = pendingResize !== undefined;
			pendingResize = { cols, rows };
			if (!active) void sendResize();
		},
		detach() {
			stopped = true;
			attach?.abort();
			stopListening();
		},
		close() {
			this.detach();
		},
		kill() {
			if (exited) return;
			if (isDeviceOnline(deviceId)) {
				void sendRpc(deviceId, "session.kill", { sessionId }, rpcOpts)
					.then(() => sendRpc(deviceId, "session.release", { sessionId }, rpcOpts))
					.catch((error) => {
						if (isConnectionLoss(error)) queueKill(deviceId, sessionId, sendRpc);
					});
			} else {
				queueKill(deviceId, sessionId, sendRpc);
			}
			finish(-1);
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
		get consumedSeq() {
			return consumed;
		},
	};
}
