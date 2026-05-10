import { logger } from "../logger";
import type { IFileChange } from "./types";
import {
	WATCHER_WORKER_FLAG,
	type WatcherParentMessage,
	type WatcherWorkerMessage,
} from "./worker-protocol";

export interface WorkerSubscription {
	unsubscribe(): Promise<void>;
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
	return [process.execPath, "server/index.ts", WATCHER_WORKER_FLAG];
}

function cloneEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.NARRAFORK_WATCHER_WORKER = "1";
	return env;
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
	private writeQueue: Promise<void> = Promise.resolve();
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
				logger.warn("[ParcelWatcher] native worker disabled; using fallback polling", {
					enableWith: `${ENABLE_NATIVE_WATCHER_ENV}=1`,
				});
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
		const pending = this.createPending(requestId, UNWATCH_ACK_TIMEOUT_MS, `unwatch ${rootPath}`);
		try {
			await this.send({ type: "unwatch", requestId, id: rootPath });
			await pending;
		} catch (error) {
			logger.debug("[ParcelWatcher] worker unwatch failed", {
				path: rootPath,
				error: String(error),
			});
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.active.clear();
		for (const [requestId, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("watcher worker shutting down"));
			this.pending.delete(requestId);
		}

		if (this.proc) {
			try {
				await this.send({ type: "shutdown" });
			} catch {
				// ignored: worker may already be gone
			}
			setTimeout(() => this.killWorker(), 500);
		}
	}

	private async sendWatch(rootPath: string, ignore: string[], timeoutMs: number): Promise<void> {
		const requestId = nextRequestId("watch");
		const pending = this.createPending(requestId, timeoutMs, `watch ${rootPath}`);
		try {
			await this.send({ type: "watch", requestId, id: rootPath, path: rootPath, ignore });
			await pending;
		} catch (error) {
			const msg = String(error);
			if (msg.includes("timed out")) {
				this.disableForSession(`watch request timed out for ${rootPath}`);
			}
			throw error;
		}
	}

	private async ensureStarted(): Promise<void> {
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
		this.shuttingDown = false;

		const readyPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("watcher worker ready timed out"));
			}, WORKER_READY_TIMEOUT_MS);
			this.readyWaiter = { resolve, reject, timer };
		});

		try {
			this.proc = Bun.spawn(command, {
				cwd: process.cwd(),
				env: cloneEnv(),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			this.readyWaiter = undefined;
			throw error;
		}

		const proc = this.proc;
		void this.readStdout(proc.stdout as ReadableStream<Uint8Array> | null, proc);
		void this.readStderr(proc.stderr as ReadableStream<Uint8Array> | null, proc);
		void proc.exited.then((code) => this.handleExit(proc, code));

		try {
			await readyPromise;
			this.restartAttempts = 0;
			logger.debug("[ParcelWatcher] worker process ready", { pid: proc.pid, command });
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
		} catch (error) {
			if (this.proc === proc && !this.shuttingDown) {
				logger.warn("[ParcelWatcher] worker stdout reader failed", { error: String(error) });
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
				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line) logger.debug(line);
					newlineIndex = buffer.indexOf("\n");
				}
			}
			buffer += decoder.decode();
			if (buffer.trim()) logger.debug(buffer.trim());
		} catch (error) {
			if (this.proc === proc && !this.shuttingDown) {
				logger.warn("[ParcelWatcher] worker stderr reader failed", { error: String(error) });
			}
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(line: string): void {
		let message: WatcherWorkerMessage;
		try {
			message = JSON.parse(line) as WatcherWorkerMessage;
		} catch (error) {
			logger.warn("[ParcelWatcher] invalid worker message", { line, error: String(error) });
			return;
		}

		switch (message.type) {
			case "ready":
				this.resolveReady();
				logger.debug("[ParcelWatcher] worker reported ready", {
					pid: message.pid,
					backend: message.backend,
				});
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
				const level = message.level === "trace" ? "debug" : message.level;
				logger[level](message.message, message.data ?? {});
				break;
			}
			case "error":
				if (message.requestId) {
					this.rejectPending(message.requestId, new Error(message.error));
				} else {
					logger.warn("[ParcelWatcher] worker error", {
						id: message.id,
						error: message.error,
						fatal: message.fatal,
					});
					this.onUnavailable(message.error);
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
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`${description} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(requestId, { description, resolve, reject, timer });
		});
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

	private async send(message: WatcherParentMessage): Promise<void> {
		const data = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
		const next = this.writeQueue
			.catch(() => {})
			.then(async () => {
				const stdin = this.proc?.stdin as WritableStream<Uint8Array> | undefined;
				if (!stdin) throw new Error("watcher worker stdin is not available");
				const writer = stdin.getWriter();
				try {
					await writer.write(data);
				} finally {
					writer.releaseLock();
				}
			});
		this.writeQueue = next;
		return next;
	}

	private handleExit(proc: ReturnType<typeof Bun.spawn>, code: number): void {
		if (this.proc !== proc) return;
		this.proc = undefined;
		this.writeQueue = Promise.resolve();
		this.rejectReady(new Error(`watcher worker exited before ready with code ${code}`));
		for (const [requestId, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`watcher worker exited during ${pending.description}`));
			this.pending.delete(requestId);
		}

		if (this.shuttingDown) return;

		const reason = `watcher worker exited with code ${code}`;
		logger.warn("[ParcelWatcher] worker process exited", {
			code,
			active: this.active.size,
			restartAttempts: this.restartAttempts,
		});
		this.onUnavailable(reason);

		if (
			this.active.size > 0 &&
			!this.disabledReason &&
			this.restartAttempts < MAX_WORKER_RESTARTS
		) {
			this.restartAttempts++;
			setTimeout(() => {
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
			logger.info("[ParcelWatcher] worker restarted and subscriptions restored", {
				count: requests.length,
			});
		} catch (error) {
			logger.warn("[ParcelWatcher] worker resubscribe failed", { error: String(error) });
			this.onUnavailable(String(error));
		}
	}

	private disableForSession(reason: string): void {
		if (this.disabledReason) return;
		this.disabledReason = reason;
		logger.warn("[ParcelWatcher] native worker disabled for this session", { reason });
		this.onUnavailable(reason);
		this.killWorker();
	}

	private killWorker(): void {
		const proc = this.proc;
		if (!proc) return;
		try {
			proc.kill();
		} catch {
			// already gone
		}
	}
}
