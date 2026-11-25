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
 *
 * Stopping and releasing the executor session is not this runtime's job: the
 * terminal service does it from durable state (`terminals.executor_session_id`)
 * once it has persisted what it needs, so neither a restart nor an offline
 * device can leave a shell orphaned.
 */
import type * as RpcTypes from "../lib/agent/execution/rpc-types";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import type { SendRpcOptions } from "../services/device-connection-service";
// Namespace import, read at call time: modules that partially mock the device
// connection service still load this one.
import * as deviceConnections from "../services/device-connection-service";
import type { TerminalRuntime } from "./runtime";

/**
 * Same value as `rpc-types.ts`, checked at compile time; defined here so a test
 * that partially mocks rpc-types cannot break loading this module.
 */
export const SESSION_DURABLE_FEATURE: typeof RpcTypes.SESSION_DURABLE_FEATURE =
	"session.durable.v1";

const DEFAULT_MAX_QUEUED_WRITE_BYTES = 1024 * 1024;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

type SendRpc = (
	deviceId: string,
	method: Parameters<typeof deviceConnections.sendRpc>[1],
	params: Record<string, unknown>,
	opts?: SendRpcOptions,
) => Promise<unknown>;

export interface RemoteSessionDependencies {
	sendRpc?: SendRpc;
	isDeviceOnline?: (deviceId: string) => boolean;
	maxQueuedWriteBytes?: number;
	/** How long an open that lost its reply may wait for the device to reconcile it. */
	openTimeoutMs?: number;
}

/**
 * `session.open` was sent but neither its result nor a confirmation arrived:
 * the shell may be running on the device. The caller must keep a cleanup
 * intent for the session instead of forgetting it.
 */
export class RemoteSessionOpenUnknownError extends Error {
	constructor(sessionId: string, cause: string) {
		super(
			`Remote terminal session ${sessionId} may have started, but its start was not confirmed: ${cause}`,
		);
		this.name = "RemoteSessionOpenUnknownError";
	}
}

export interface RemoteSessionOptions {
	/** Present to start a new session; absent to resume an existing one. */
	open?: { cmd: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number };
	/** First unseen output byte when resuming (0 for a new session). */
	since: number;
	onData: (data: string, streamSeq: number) => void;
	/**
	 * Output was lost before `streamSeq`. Called before the visible notice and
	 * any later output are delivered through onData.
	 */
	onGap?: (missingBytes: number, streamSeq: number) => void;
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

/**
 * A transport loss the executor survives: wait for the device and resume.
 * Matched by name (`DeviceOfflineError`, `DeviceConnectionChangedError`).
 */
export function isConnectionLoss(error: unknown): boolean {
	const name = error instanceof Error ? error.name : "";
	return name === "DeviceOfflineError" || name === "DeviceConnectionChangedError";
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

export function spawnRemoteSession(
	deviceId: string,
	sessionId: string,
	opts: RemoteSessionOptions,
	deps: RemoteSessionDependencies = {},
): RemoteSessionRuntime {
	const sendRpc: SendRpc =
		deps.sendRpc ??
		((deviceId, method, params, options) =>
			deviceConnections.sendRpc(deviceId, method, params, options));
	const isDeviceOnline =
		deps.isDeviceOnline ?? ((deviceId: string) => deviceConnections.isDeviceOnline(deviceId));
	const maxQueuedWriteBytes = deps.maxQueuedWriteBytes ?? DEFAULT_MAX_QUEUED_WRITE_BYTES;
	const openTimeoutMs = deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
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
			opts.onGap?.(missing, consumed);
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
				// Not released here: the owner releases after persisting the final state.
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

	/** Resolves true once the device is online, false after `ms` or when stopped. */
	function waitOnlineWithin(ms: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), ms);
			void waitUntilOnline().then(() => {
				clearTimeout(timer);
				resolve(!stopped && isDeviceOnline(deviceId));
			});
		});
	}

	/**
	 * A lost reply does not mean the shell did not start. Retry once the device is
	 * back: "already exists" then proves the earlier open landed and is adopted.
	 */
	async function openSession(open: NonNullable<RemoteSessionOptions["open"]>) {
		const deadline = Date.now() + openTimeoutMs;
		let sent = false;
		for (;;) {
			try {
				await sendRpc(deviceId, "session.open", { sessionId, kind: "pty", ...open }, rpcOpts);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (sent && message.includes("already exists")) return;
				if (!isConnectionLoss(error)) throw error;
				sent = true;
				const remaining = deadline - Date.now();
				if (remaining <= 0 || !(await waitOnlineWithin(remaining)))
					throw new RemoteSessionOpenUnknownError(sessionId, message);
			}
		}
	}

	let readyPromise: Promise<void>;
	if (opts.open) {
		readyPromise = openSession(opts.open).then(() => {
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
			// Stops reading only: the terminal service stops and releases the
			// executor session from its persisted cleanup intent.
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
