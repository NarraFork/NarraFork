/**
 * Parcel watcher coordinator.
 *
 * VS Code runs @parcel/watcher in a separate file-watcher process. NarraFork
 * follows the same safety boundary: the main server never loads the native
 * addon directly. It talks to `parcel-watcher-worker.ts` via JSONL and falls
 * back to git-status polling when the worker is disabled or unhealthy.
 */

import { type Stats, unwatchFile, watchFile } from "node:fs";

import { logger } from "../logger";
import { coalesceEvents } from "./event-coalescer";
import { DEFAULT_EXCLUDES, isIgnoredEventPath } from "./parcel-ignore";
import {
	isNativeWatcherEnabled,
	ParcelWorkerClient,
	type WorkerSubscription,
} from "./parcel-worker-client";
import { FileChangeType, type IFileChange } from "./types";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_RESTARTS = 3;
const EVENT_AGGREGATE_DELAY = 75;
const THROTTLE_CHUNK_SIZE = 500;
const THROTTLE_DELAY = 200;
const THROTTLE_MAX_BUFFER = 30_000;
const SUSPENDED_POLL_INTERVAL = 5007;

// ── ParcelWatcherInstance ───────────────────────────────────────────────────

/** Represents one native worker subscription for a worktree root. */
export class ParcelWatcherInstance {
	private _stopped = false;
	get stopped(): boolean {
		return this._stopped;
	}

	constructor(
		readonly path: string,
		readonly restarts: number,
		private readonly subscription: WorkerSubscription,
		private readonly worker: RunOnceWorker<IFileChange>,
	) {}

	/** Feed worker-normalized file events into the aggregation worker. */
	handleEvents(events: IFileChange[]): void {
		if (this._stopped) return;
		for (const evt of events) {
			if (isIgnoredEventPath(this.path, evt.path)) continue;
			this.worker.work(evt);
		}
	}

	async stop(): Promise<void> {
		if (this._stopped) return;
		this._stopped = true;
		this.worker.flush();
		this.worker.dispose();
		try {
			await this.subscription.unsubscribe();
		} catch {
			// subscription may already be dead
		}
	}
}

// ── ThrottledEmitter ────────────────────────────────────────────────────────

/**
 * Throttled event emitter — ported from VS Code's `ThrottledWorker`.
 *
 * Processes events in chunks of `maxChunkSize`, resting `delayMs` between
 * chunks. If the internal buffer exceeds `maxBuffer`, new events are dropped
 * and a warning is emitted.
 */
class ThrottledEmitter {
	private buffer: IFileChange[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private _pending = 0;

	get pending(): number {
		return this._pending;
	}

	constructor(
		private readonly maxChunkSize: number,
		private readonly delayMs: number,
		private readonly maxBuffer: number,
		private readonly handler: (events: IFileChange[]) => void,
	) {}

	/** Returns false if events were dropped due to buffer overflow. */
	work(events: IFileChange[]): boolean {
		this.buffer.push(...events);
		this._pending = this.buffer.length;

		if (this.buffer.length > this.maxBuffer) {
			this.buffer = this.buffer.slice(-this.maxBuffer);
			this._pending = this.buffer.length;
			this.scheduleFlush();
			return false;
		}

		this.scheduleFlush();
		return true;
	}

	private scheduleFlush(): void {
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => this.flush(), this.delayMs);
	}

	private flush(): void {
		this.timer = undefined;
		if (this.buffer.length === 0) return;

		const chunk = this.buffer.splice(0, this.maxChunkSize);
		this._pending = this.buffer.length;
		this.handler(chunk);

		if (this.buffer.length > 0) {
			this.scheduleFlush();
		}
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.buffer.length > 0) {
			this.handler(this.buffer.splice(0));
		}
		this._pending = 0;
	}
}

// ── RunOnceWorker ───────────────────────────────────────────────────────────

/**
 * Aggregates events over a short delay then flushes them as a batch.
 * Equivalent to VS Code's `RunOnceWorker`.
 */
class RunOnceWorker<T> {
	private buffer: T[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly handler: (items: T[]) => void,
		private readonly delayMs: number,
	) {}

	work(item: T): void {
		this.buffer.push(item);
		if (this.timer === undefined) {
			this.timer = setTimeout(() => this.flush(), this.delayMs);
		}
	}

	flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.buffer.length > 0) {
			const items = this.buffer.splice(0);
			this.handler(items);
		}
	}

	dispose(): void {
		this.flush();
	}
}

// ── ParcelRecursiveWatcher ──────────────────────────────────────────────────

/**
 * Manages native watcher subscriptions for multiple worktree roots.
 *
 * Each native subscription lives in a separate worker process. Events flow:
 *   worker parcel callback → worker coalesce/throttle → main RunOnceWorker
 *   → main coalesce/throttle → consumer callback.
 */
export class ParcelRecursiveWatcher {
	private readonly instances = new Map<string, ParcelWatcherInstance>();
	private readonly requestedPaths = new Set<string>();
	private readonly pendingWorkerEvents = new Map<string, IFileChange[]>();
	private readonly suspended = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
	private enospcWarned = false;

	private readonly throttledEmitter: ThrottledEmitter;
	private readonly workerClient: ParcelWorkerClient;

	constructor(
		private readonly onEvents: (path: string, events: IFileChange[]) => void,
		private readonly onBackendUnavailable?: (reason: string) => void,
	) {
		this.throttledEmitter = new ThrottledEmitter(
			THROTTLE_CHUNK_SIZE,
			THROTTLE_DELAY,
			THROTTLE_MAX_BUFFER,
			(events) => {
				const byRoot = new Map<string, IFileChange[]>();
				for (const evt of events) {
					for (const rootPath of this.instances.keys()) {
						if (evt.path === rootPath || evt.path.startsWith(`${rootPath}/`)) {
							let arr = byRoot.get(rootPath);
							if (!arr) {
								arr = [];
								byRoot.set(rootPath, arr);
							}
							arr.push(evt);
							break;
						}
					}
				}
				for (const [rootPath, rootEvents] of byRoot) {
					this.onEvents(rootPath, rootEvents);
				}
			},
		);

		this.workerClient = new ParcelWorkerClient(
			(rootPath, events) => this.onWorkerEvents(rootPath, events),
			(reason) => this.handleBackendUnavailable(reason),
		);
	}

	get activeCount(): number {
		return this.instances.size;
	}

	get activePaths(): string[] {
		return [...this.instances.keys()];
	}

	get nativeEnabled(): boolean {
		return isNativeWatcherEnabled();
	}

	/** Start watching a worktree root recursively. */
	async watch(rootPath: string, extraExcludes: string[] = []): Promise<void> {
		this.requestedPaths.add(rootPath);
		if (this.instances.has(rootPath)) return;
		this.unsuspend(rootPath);
		await this.startWatching(rootPath, extraExcludes, 0);
	}

	/** Stop watching a worktree root. */
	async unwatch(rootPath: string): Promise<void> {
		this.requestedPaths.delete(rootPath);
		this.unsuspend(rootPath);
		this.pendingWorkerEvents.delete(rootPath);

		const instance = this.instances.get(rootPath);
		if (instance) {
			this.instances.delete(rootPath);
			await instance.stop();
			logger.debug("[ParcelWatcher] stopped", { path: rootPath });
		} else {
			await this.workerClient.unwatch(rootPath);
		}
	}

	/** Stop all watchers. */
	async shutdown(): Promise<void> {
		for (const [path] of this.suspended) {
			this.unsuspend(path);
		}
		this.requestedPaths.clear();
		this.pendingWorkerEvents.clear();

		const stops: Promise<void>[] = [];
		for (const [path, instance] of this.instances) {
			this.instances.delete(path);
			stops.push(instance.stop());
		}
		await Promise.allSettled(stops);
		await this.workerClient.shutdown().catch(() => {});

		this.throttledEmitter.dispose();
		logger.debug("[ParcelWatcher] all watchers shut down");
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private async startWatching(
		rootPath: string,
		extraExcludes: string[],
		restarts: number,
	): Promise<void> {
		const ignore = [...DEFAULT_EXCLUDES, ...extraExcludes];

		if (!isNativeWatcherEnabled()) {
			logger.debug("[ParcelWatcher] skipped native worker subscribe", { path: rootPath, restarts });
			this.handleBackendUnavailable("native watcher disabled");
			return;
		}

		try {
			if (!this.requestedPaths.has(rootPath)) return;
			const worker = new RunOnceWorker<IFileChange>((rawEvents) => {
				this.handleAggregatedEvents(rootPath, rawEvents);
			}, EVENT_AGGREGATE_DELAY);

			const subscription = await this.workerClient.watch(rootPath, ignore);
			if (!this.requestedPaths.has(rootPath)) {
				await subscription.unsubscribe();
				worker.dispose();
				return;
			}
			const instance = new ParcelWatcherInstance(rootPath, restarts, subscription, worker);
			this.instances.set(rootPath, instance);
			const pendingEvents = this.pendingWorkerEvents.get(rootPath);
			if (pendingEvents) {
				this.pendingWorkerEvents.delete(rootPath);
				instance.handleEvents(pendingEvents);
			}

			logger.debug("[ParcelWatcher] started", {
				path: rootPath,
				restarts,
			});
		} catch (error) {
			this.onError(rootPath, extraExcludes, error, restarts);
		}
	}

	private onWorkerEvents(rootPath: string, events: IFileChange[]): void {
		if (!this.requestedPaths.has(rootPath)) return;

		const instance = this.instances.get(rootPath);
		if (instance && !instance.stopped) {
			instance.handleEvents(events);
			return;
		}

		const pendingEvents = this.pendingWorkerEvents.get(rootPath);
		if (pendingEvents) {
			pendingEvents.push(...events);
		} else {
			this.pendingWorkerEvents.set(rootPath, [...events]);
		}
	}

	private handleAggregatedEvents(rootPath: string, rawEvents: IFileChange[]): void {
		if (rawEvents.length === 0) return;

		const coalesced = coalesceEvents(rawEvents);
		if (coalesced.length === 0) return;

		const rootDeleted = coalesced.some(
			(e) => e.type === FileChangeType.DELETED && e.path === rootPath,
		);

		const worked = this.throttledEmitter.work(coalesced);
		if (!worked) {
			logger.warn("[ParcelWatcher] event buffer overflow, some events dropped", {
				path: rootPath,
				pending: this.throttledEmitter.pending,
			});
		}

		if (rootDeleted) {
			this.onRootDeleted(rootPath);
		}
	}

	private onError(
		rootPath: string,
		extraExcludes: string[],
		error: unknown,
		restarts: number,
	): void {
		const msg = String(error);

		if (msg.includes("No space left on device") || msg.includes("ENOSPC")) {
			if (!this.enospcWarned) {
				this.enospcWarned = true;
				logger.error("[ParcelWatcher] inotify limit reached (ENOSPC)", { path: rootPath });
			}
			this.handleBackendUnavailable(msg);
			return;
		}

		if (msg.includes("EMFILE")) {
			logger.error("[ParcelWatcher] too many open files (EMFILE)", { path: rootPath });
			this.handleBackendUnavailable(msg);
			return;
		}

		if (
			msg.includes("native watcher disabled") ||
			msg.includes("disabled for this session") ||
			msg.includes("timed out")
		) {
			logger.warn("[ParcelWatcher] native backend unavailable", { path: rootPath, error: msg });
			this.handleBackendUnavailable(msg);
			return;
		}

		if (restarts < MAX_RESTARTS) {
			logger.warn("[ParcelWatcher] restarting after error", {
				path: rootPath,
				error: msg,
				restart: restarts + 1,
			});

			const instance = this.instances.get(rootPath);
			if (instance) {
				this.instances.delete(rootPath);
				instance.stop().catch(() => {});
			}

			setTimeout(() => {
				if (this.requestedPaths.has(rootPath) && !this.instances.has(rootPath)) {
					this.startWatching(rootPath, extraExcludes, restarts + 1).catch((err) => {
						logger.error("[ParcelWatcher] restart failed", {
							path: rootPath,
							error: String(err),
						});
					});
				}
			}, 800);
		} else {
			logger.error("[ParcelWatcher] gave up restarting after max attempts", {
				path: rootPath,
				error: msg,
			});
			this.handleBackendUnavailable(msg);
		}
	}

	private handleBackendUnavailable(reason: string): void {
		this.onBackendUnavailable?.(reason);
	}

	/**
	 * When the watched root directory is deleted, stop the watcher and fall back
	 * to fs.watchFile() polling to detect when it reappears. This mirrors VS
	 * Code's `BaseWatcher.suspendWatchRequest` pattern.
	 */
	private onRootDeleted(rootPath: string): void {
		logger.warn("[ParcelWatcher] watched root deleted, suspending", { path: rootPath });

		const instance = this.instances.get(rootPath);
		if (instance) {
			this.instances.delete(rootPath);
			instance.stop().catch(() => {});
		}

		const callback = (curr: Stats, _prev: Stats) => {
			if (curr.ctimeMs !== 0 || curr.ino !== 0) {
				logger.info("[ParcelWatcher] watched root reappeared, resuming", { path: rootPath });
				this.unsuspend(rootPath);
				if (!this.requestedPaths.has(rootPath)) return;
				this.startWatching(rootPath, [], 0).catch((err) => {
					logger.error("[ParcelWatcher] failed to resume after root reappeared", {
						path: rootPath,
						error: String(err),
					});
				});
			}
		};

		try {
			watchFile(rootPath, { persistent: false, interval: SUSPENDED_POLL_INTERVAL }, callback);
			this.suspended.set(rootPath, {});
		} catch (error) {
			logger.warn("[ParcelWatcher] fs.watchFile() failed for suspended path", {
				path: rootPath,
				error: String(error),
			});
		}
	}

	private unsuspend(rootPath: string): void {
		const entry = this.suspended.get(rootPath);
		if (!entry) return;
		try {
			unwatchFile(rootPath);
		} catch {
			// ignore
		}
		this.suspended.delete(rootPath);
	}
}

export { isNativeWatcherEnabled };
