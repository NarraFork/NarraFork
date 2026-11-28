import { fileURLToPath } from "node:url";
import { logger } from "../logger";
import { envWithAmbientProxy } from "../net/proxy-env";
import { WorkerHandle } from "../worker-runtime/lifecycle";
import { TaskQueue } from "../worker-runtime/queue";
import type { IFileChange } from "./types";
import {
	WATCHER_WORKER_FLAG,
	type WatcherParentMessage,
	type WatcherWorkerMessage,
} from "./worker-protocol";

type WatcherHealthCode =
	| "native_disabled"
	| "unwatch_failed"
	| "ready"
	| "stdout_read_failed"
	| "stderr_read_failed"
	| "stderr_output"
	| "invalid_message"
	| "worker_log"
	| "worker_error"
	| "exited"
	| "resubscribed"
	| "resubscribe_failed"
	| "session_disabled"
	| "stopped"
	| "all_stopped"
	| "subscribe_skipped"
	| "subscribed"
	| "event_overflow"
	| "inotify_limit"
	| "fd_limit"
	| "unavailable"
	| "restart_requested"
	| "restart_failed"
	| "restart_exhausted"
	| "root_deleted"
	| "root_reappeared"
	| "resume_failed"
	| "suspend_watch_failed";

/** Native watcher health never forwards worker log bodies, paths or error text to server logs. */
export function reportWatcherHealth(
	code: WatcherHealthCode,
	level: "debug" | "info" | "warn" | "error" = "debug",
	counts: {
		bytes?: number;
		active?: number;
		restartAttempts?: number;
		restart?: number;
		pending?: number;
		count?: number;
		pid?: number;
		fatal?: boolean;
	} = {},
): void {
	const data: Record<string, string | number | boolean> = { code };
	for (const key of [
		"bytes",
		"active",
		"restartAttempts",
		"restart",
		"pending",
		"count",
		"pid",
	] as const) {
		const value = counts[key];
		if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
	}
	if (typeof counts.fatal === "boolean") data.fatal = counts.fatal;
	try {
		logger[level]("Parcel watcher health", data);
	} catch {
		/* Advisory only; never skip stop/exit. */
	}
}

export interface WorkerSubscription {
	unsubscribe(): Promise<void>;
}

/**
 * Bun.spawn `stdin: "pipe"` returns a FileSink (write/flush/end), not a Web
 * WritableStream. The WritableStream shape is the bug that left native watch
 * commands undelivered (`getWriter is not a function`).
 */
export interface WorkerStdinSink {
	write(chunk: Uint8Array): number | Promise<number>;
	flush(): number | Promise<number>;
	end(error?: Error): number | Promise<number>;
}

const ENABLE_NATIVE_WATCHER_ENV = "NARRAFORK_ENABLE_NATIVE_WATCHER";
const WORKER_READY_TIMEOUT_MS = 3000;
const WATCH_ACK_TIMEOUT_MS = 5000;
const UNWATCH_ACK_TIMEOUT_MS = 2000;
const MAX_WORKER_RESTARTS = 3;
const WORKER_RESTART_DELAY_MS = 800;

let nativeWatcherDisabledLogged = false;
let requestCounter = 0;

export function isNativeWatcherEnabled(): boolean {
	return process.env[ENABLE_NATIVE_WATCHER_ENV] === "1";
}

function nextRequestId(prefix: string): string {
	requestCounter++;
	return `${prefix}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function isCompiledRuntime(): boolean {
	return import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/");
}

function buildWorkerCommand(): string[] {
	if (isCompiledRuntime()) {
		return [process.execPath, WATCHER_WORKER_FLAG];
	}
	return [
		process.execPath,
		fileURLToPath(new URL("../../index.ts", import.meta.url)),
		WATCHER_WORKER_FLAG,
	];
}

/**
 * The worker is another NarraFork process, so it re-runs
 * `neutralizeAmbientProxyEnv()` on startup. Handing it this process' already
 * blanked proxy values would make it snapshot "no ambient proxy"; the real
 * values are restored so its snapshot matches ours.
 */
function cloneEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(envWithAmbientProxy())) {
		if (value !== undefined) env[key] = value;
	}
	env.NARRAFORK_WATCHER_WORKER = "1";
	return env;
}

export function isThenable(value: unknown): value is PromiseLike<number> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PromiseLike<number>).then === "function"
	);
}

/** Encode one parent command as a JSONL line for worker stdin. */
export function encodeWorkerCommand(message: WatcherParentMessage): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

/**
 * Write one JSONL command through a Bun FileSink.
 *
 * FileSink.write/flush may return either a number or a Promise; both are
 * accepted. Never call `getWriter()` — that is WritableStream, not FileSink.
 */
export async function writeFileSinkCommand(
	stdin: WorkerStdinSink,
	data: Uint8Array,
): Promise<void> {
	const written = stdin.write(data);
	if (isThenable(written)) await written;
	const flushed = stdin.flush();
	if (isThenable(flushed)) await flushed;
}

/** End a FileSink without throwing if it is already closed. */
export function endWorkerStdin(stdin: WorkerStdinSink): void {
	if (typeof stdin.end !== "function") return;
	try {
		const result = stdin.end();
		if (isThenable(result)) void Promise.resolve(result).catch(() => {});
	} catch {
		// already closed or broken
	}
}

/**
 * Accept only the FileSink shape. A WritableStream (or anything without
 * write+flush) must not be used — that was the production failure mode.
 */
export function asWorkerStdinSink(stdin: unknown): WorkerStdinSink | undefined {
	if (!stdin || typeof stdin !== "object") return undefined;
	const candidate = stdin as Partial<WorkerStdinSink>;
	if (typeof candidate.write !== "function" || typeof candidate.flush !== "function") {
		return undefined;
	}
	if (typeof (stdin as { getWriter?: unknown }).getWriter === "function") {
		return undefined;
	}
	return stdin as WorkerStdinSink;
}

interface PendingRequest {
	description: string;
	resolve: (message: WatcherWorkerMessage) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ActiveWatchRequest {
	rootPath: string;
	ignore: string[];
}

interface ReadyWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class ParcelWorkerClient {
	private proc: ReturnType<typeof Bun.spawn> | undefined;
	private startPromise: Promise<void> | undefined;
	private readyWaiter: ReadyWaiter | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly active = new Map<string, ActiveWatchRequest>();
	private readonly writes = new TaskQueue({
		concurrency: 1,
		maxQueued: 64,
		maxQueuedBytes: 4 * 1024 * 1024,
	});
	private handle: WorkerHandle<ReturnType<typeof Bun.spawn>> | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private readers: Promise<void> = Promise.resolve();
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private shuttingDown = false;
	private restartAttempts = 0;
	private disabledReason: string | undefined;

	constructor(
		private readonly onEvents: (rootPath: string, events: IFileChange[]) => void,
		private readonly onUnavailable: (reason: string) => void,
	) {}

	async watch(rootPath: string, ignore: string[]): Promise<WorkerSubscription> {
		if (!isNativeWatcherEnabled()) {
			if (!nativeWatcherDisabledLogged) {
				nativeWatcherDisabledLogged = true;
				reportWatcherHealth("native_disabled", "warn");
			}
			throw new Error("native watcher disabled");
		}

		if (this.disabledReason) {
			throw new Error(`native watcher disabled for this session: ${this.disabledReason}`);
		}

		await this.ensureStarted();
		await this.sendWatch(rootPath, ignore, WATCH_ACK_TIMEOUT_MS);
		this.active.set(rootPath, { rootPath, ignore });

		return {
			unsubscribe: () => this.unwatch(rootPath),
		};
	}

	async unwatch(rootPath: string): Promise<void> {
		this.active.delete(rootPath);
		if (!this.proc || this.shuttingDown) return;

		const requestId = nextRequestId("unwatch");
		try {
			await this.request(
				{ type: "unwatch", requestId, id: rootPath },
				UNWATCH_ACK_TIMEOUT_MS,
				`unwatch ${rootPath}`,
			);
		} catch {
			reportWatcherHealth("unwatch_failed");
		}
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shuttingDown = true;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		this.active.clear();
		this.rejectReady(new Error("watcher worker shutting down"));
		this.clearAllPending(new Error("watcher worker shutting down"));
		const handle = this.handle;
		// Arm escalation before any potentially blocked stdin flush/startup wait.
		const timer = setTimeout(() => this.killWorker(), 500);
		this.shutdownPromise = (async () => {
			try {
				if (handle) {
					await Promise.race([this.send({ type: "shutdown" }).catch(() => {}), handle.exited]);
					this.closeStdin();
				}
				const drained = this.writes.close();
				await this.startPromise?.catch(() => {});
				if (handle) await handle.exited;
				await drained;
				await this.readers;
			} finally {
				clearTimeout(timer);
			}
		})();
		return this.shutdownPromise;
	}

	/**
	 * Create an ACK pending, send the command, await the ACK.
	 *
	 * send() used to leave the pending entry behind when stdin write failed
	 * immediately; the 5s timer then rejected with no listener. On any send
	 * failure the pending is settled right away (timer cleared, promise
	 * rejected) so nothing is left to fire later as an unhandled rejection.
	 */
	private async request(
		message: Extract<WatcherParentMessage, { requestId: string }>,
		timeoutMs: number,
		description: string,
	): Promise<WatcherWorkerMessage> {
		const requestId = message.requestId;
		const pending = this.createPending(requestId, timeoutMs, description);

		try {
			await this.send(message);
		} catch (error) {
			const sendError = error instanceof Error ? error : new Error(String(error));
			this.rejectPending(requestId, sendError);
			throw sendError;
		}

		try {
			return await pending;
		} catch (error) {
			if (String(error).includes("timed out")) {
				this.disableForSession(description);
			}
			throw error;
		}
	}

	private async sendWatch(rootPath: string, ignore: string[], timeoutMs: number): Promise<void> {
		const requestId = nextRequestId("watch");
		await this.request(
			{ type: "watch", requestId, id: rootPath, path: rootPath, ignore },
			timeoutMs,
			`watch ${rootPath}`,
		);
	}

	private async ensureStarted(): Promise<void> {
		if (this.shuttingDown) throw new Error("watcher worker shutting down");
		if (this.proc) return;
		if (this.disabledReason) {
			throw new Error(`native watcher disabled for this session: ${this.disabledReason}`);
		}
		if (!this.startPromise) {
			this.startPromise = this.startWorker().finally(() => {
				this.startPromise = undefined;
			});
		}
		return this.startPromise;
	}

	private async startWorker(): Promise<void> {
		const command = buildWorkerCommand();
		if (this.shuttingDown) throw new Error("watcher worker shutting down");

		const readyPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("watcher worker ready timed out"));
			}, WORKER_READY_TIMEOUT_MS);
			this.readyWaiter = { resolve, reject, timer };
		});

		try {
			const handle = WorkerHandle.subprocess(command, {
				cwd: process.cwd(),
				env: cloneEnv(),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			this.handle = handle;
			this.proc = handle.resource;
		} catch (error) {
			this.rejectReady(error instanceof Error ? error : new Error(String(error)));
			await readyPromise.catch(() => {});
			throw error;
		}

		const proc = this.proc;
		this.readers = Promise.all([
			this.readStdout(proc.stdout as ReadableStream<Uint8Array> | null, proc),
			this.readStderr(proc.stderr as ReadableStream<Uint8Array> | null, proc),
		]).then(() => {});
		void this.handle?.exited.then((code) => this.handleExit(proc, code));

		try {
			await readyPromise;
			this.restartAttempts = 0;
			reportWatcherHealth("ready", "debug", { pid: proc.pid });
		} catch (error) {
			this.disableForSession(String(error));
			throw error;
		}
	}

	private async readStdout(
		stream: ReadableStream<Uint8Array> | null,
		proc: ReturnType<typeof Bun.spawn>,
	): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (Buffer.byteLength(buffer) > 1024 * 1024) {
					this.disableForSession("worker line limit exceeded");
					await reader.cancel().catch(() => {});
					return;
				}
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line) this.handleLine(line);
					newlineIndex = buffer.indexOf("\n");
				}
			}
			buffer += decoder.decode();
			if (buffer.trim()) this.handleLine(buffer.trim());
		} catch {
			if (this.proc === proc && !this.shuttingDown) {
				reportWatcherHealth("stdout_read_failed", "warn");
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async readStderr(
		stream: ReadableStream<Uint8Array> | null,
		proc: ReturnType<typeof Bun.spawn>,
	): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (Buffer.byteLength(buffer) > 1024 * 1024) {
					this.disableForSession("worker line limit exceeded");
					await reader.cancel().catch(() => {});
					return;
				}
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line)
						reportWatcherHealth("stderr_output", "debug", { bytes: Buffer.byteLength(line) });
					newlineIndex = buffer.indexOf("\n");
				}
			}
			buffer += decoder.decode();
			if (buffer.trim())
				reportWatcherHealth("stderr_output", "debug", { bytes: Buffer.byteLength(buffer) });
		} catch {
			if (this.proc === proc && !this.shuttingDown) {
				reportWatcherHealth("stderr_read_failed", "warn");
			}
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(line: string): void {
		let message: WatcherWorkerMessage;
		try {
			message = JSON.parse(line) as WatcherWorkerMessage;
		} catch {
			reportWatcherHealth("invalid_message", "warn", { bytes: Buffer.byteLength(line) });
			return;
		}

		switch (message.type) {
			case "ready":
				this.resolveReady();
				reportWatcherHealth("ready", "debug", { pid: message.pid });
				break;
			case "watch_ack":
			case "unwatch_ack":
			case "pong":
				this.resolvePending(message.requestId, message);
				break;
			case "events":
				this.onEvents(message.path, message.events);
				break;
			case "log": {
				const level =
					message.level === "error"
						? "error"
						: message.level === "warn"
							? "warn"
							: message.level === "info"
								? "info"
								: "debug";
				reportWatcherHealth("worker_log", level, { bytes: Buffer.byteLength(message.message) });
				break;
			}
			case "error":
				if (message.requestId) {
					this.rejectPending(message.requestId, new Error(message.error));
				} else {
					reportWatcherHealth("worker_error", "warn", { fatal: message.fatal });
					this.notifyUnavailable(message.error);
					if (message.fatal) this.killWorker();
				}
				break;
		}
	}

	private createPending(
		requestId: string,
		timeoutMs: number,
		description: string,
	): Promise<WatcherWorkerMessage> {
		if (this.pending.size >= 64) return Promise.reject(new Error("watcher request queue full"));
		const promise = new Promise<WatcherWorkerMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`${description} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(requestId, { description, resolve, reject, timer });
		});
		// Mark handled immediately: abort/shutdown/timeout may reject before the
		// caller awaits (send failed first). Callers still observe the rejection
		// via their own await; this only prevents the global unhandled-rejection
		// path that the orphaned ACK timers used to hit.
		promise.catch(() => {});
		return promise;
	}

	private resolvePending(requestId: string, message: WatcherWorkerMessage): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(message);
	}

	private rejectPending(requestId: string, error: Error): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	private clearAllPending(error: Error): void {
		for (const [requestId, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(requestId);
		}
	}

	private resolveReady(): void {
		const ready = this.readyWaiter;
		if (!ready) return;
		this.readyWaiter = undefined;
		clearTimeout(ready.timer);
		ready.resolve();
	}

	private rejectReady(error: Error): void {
		const ready = this.readyWaiter;
		if (!ready) return;
		this.readyWaiter = undefined;
		clearTimeout(ready.timer);
		ready.reject(error);
	}

	private getFileSink(): WorkerStdinSink | undefined {
		return asWorkerStdinSink(this.proc?.stdin);
	}

	private closeStdin(): void {
		const stdin = this.getFileSink();
		if (!stdin) return;
		endWorkerStdin(stdin);
	}

	private async send(message: WatcherParentMessage): Promise<void> {
		const data = encodeWorkerCommand(message);
		if (data.byteLength > 1024 * 1024) throw new Error("watcher command limit exceeded");
		const handle = this.handle;
		await this.writes.run(
			async () => {
				if (!handle || this.handle !== handle)
					throw new Error("watcher process no longer available");
				const stdin = asWorkerStdinSink(handle.resource.stdin);
				if (!stdin) throw new Error("watcher worker stdin is not available");
				await Promise.race([
					writeFileSinkCommand(stdin, data),
					handle.exited.then(() => {
						throw new Error("watcher process exited during write");
					}),
				]);
			},
			{ bytes: data.byteLength, deadlineAt: Infinity },
		);
	}

	private handleExit(proc: ReturnType<typeof Bun.spawn>, code: number): void {
		if (this.proc !== proc) return;
		this.closeStdin();
		this.proc = undefined;
		this.handle = undefined;
		this.rejectReady(new Error(`watcher worker exited before ready with code ${code}`));
		this.clearAllPending(new Error(`watcher worker exited with code ${code}`));

		if (this.shuttingDown) return;

		const reason = `watcher worker exited with code ${code}`;
		reportWatcherHealth("exited", "warn", {
			active: this.active.size,
			restartAttempts: this.restartAttempts,
		});
		this.notifyUnavailable(reason);

		if (
			this.active.size > 0 &&
			!this.disabledReason &&
			this.restartAttempts < MAX_WORKER_RESTARTS
		) {
			this.restartAttempts++;
			this.restartTimer = setTimeout(() => {
				this.restartTimer = undefined;
				void this.resubscribeAll();
			}, WORKER_RESTART_DELAY_MS);
		}
	}

	private async resubscribeAll(): Promise<void> {
		if (this.shuttingDown || this.disabledReason || this.active.size === 0) return;
		const requests = [...this.active.values()];
		try {
			await this.ensureStarted();
			for (const request of requests) {
				if (!this.active.has(request.rootPath)) continue;
				await this.sendWatch(request.rootPath, request.ignore, WATCH_ACK_TIMEOUT_MS);
			}
			reportWatcherHealth("resubscribed", "info", { count: requests.length });
		} catch (error) {
			reportWatcherHealth("resubscribe_failed", "warn");
			this.notifyUnavailable(String(error));
		}
	}

	private disableForSession(reason: string): void {
		if (this.disabledReason) return;
		this.disabledReason = reason;
		reportWatcherHealth("session_disabled", "warn");
		this.clearAllPending(new Error(`native watcher disabled for this session: ${reason}`));
		this.notifyUnavailable(reason);
		this.killWorker();
	}

	private notifyUnavailable(reason: string): void {
		try {
			this.onUnavailable(reason);
		} catch {
			/* Advisory callback cannot skip kill/restart. */
		}
	}

	private killWorker(): void {
		const handle = this.handle;
		if (!handle) return;
		this.closeStdin();
		void handle.close().catch(() => {});
	}
}
