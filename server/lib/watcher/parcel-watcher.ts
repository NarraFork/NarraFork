/**
 * Parcel Watcher — recursive file watcher backed by @parcel/watcher.
 *
 * Modelled after VS Code's `ParcelWatcher` class
 * (`vs/platform/files/node/watcher/parcel/parcelWatcher.ts`).
 *
 * One `subscribe()` call per worktree root replaces hundreds of `fs.watch()`
 * handles, reducing inotify usage from O(directories) to O(1) per worktree.
 */

import { type Stats, unwatchFile, watchFile } from "node:fs";
import parcelWatcher from "@parcel/watcher";
import { logger } from "../logger";
import { coalesceEvents } from "./event-coalescer";
import { FileChangeType, type IFileChange } from "./types";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_RESTARTS = 3;
const EVENT_AGGREGATE_DELAY = 75;
const THROTTLE_CHUNK_SIZE = 500;
const THROTTLE_DELAY = 200;
const THROTTLE_MAX_BUFFER = 30_000;
const SUSPENDED_POLL_INTERVAL = 5007;

/** Map parcel event types to our FileChangeType. */
const PARCEL_TYPE_MAP: Record<parcelWatcher.EventType, FileChangeType> = {
	create: FileChangeType.ADDED,
	update: FileChangeType.UPDATED,
	delete: FileChangeType.DELETED,
};

/**
 * Default directories excluded at the kernel level (passed to @parcel/watcher
 * `ignore` option so inotify watches are never registered for them).
 */
const DEFAULT_EXCLUDES: readonly string[] = [
	"**/.git/**",
	"**/node_modules/**",
	"**/.next/**",
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/__pycache__/**",
	"**/.cache/**",
	"**/.parcel-cache/**",
	"**/.turbo/**",
	"**/.nuxt/**",
	"**/.output/**",
	"**/.svelte-kit/**",
	"**/target/**",
	"**/.venv/**",
	"**/venv/**",
	"**/vendor/**",
	"**/.gradle/**",
	"**/.idea/**",
	"**/.vscode/**",
	"**/coverage/**",
	"**/.nyc_output/**",
	"**/.pytest_cache/**",
	"**/.mypy_cache/**",
	"**/.ruff_cache/**",
	"**/.tox/**",
	"**/.worktrees/**",
];

// ── ParcelWatcherInstance ───────────────────────────────────────────────────

/**
 * Represents a single active @parcel/watcher subscription for one worktree.
 */
export class ParcelWatcherInstance {
	private _stopped = false;
	get stopped(): boolean {
		return this._stopped;
	}

	constructor(
		readonly path: string,
		readonly restarts: number,
		private readonly subscription: parcelWatcher.AsyncSubscription,
		private readonly worker: RunOnceWorker<IFileChange>,
	) {}

	/** Feed raw parcel events into the aggregation worker. */
	handleEvents(events: parcelWatcher.Event[]): void {
		if (this._stopped) return;
		for (const evt of events) {
			const type = PARCEL_TYPE_MAP[evt.type];
			if (type !== undefined) {
				this.worker.work({ type, path: evt.path });
			}
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
			// Drop oldest events to stay within budget
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
		// Flush remaining
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
 * Manages @parcel/watcher subscriptions for multiple worktree roots.
 *
 * Each worktree gets a single recursive watcher. Events flow through:
 *   parcel callback → RunOnceWorker (75ms aggregate) → coalesce → ThrottledEmitter → consumer callback
 *
 * If a watched path is deleted, the watcher enters a suspended state and
 * polls with `fs.watchFile()` until the path reappears (matching VS Code's
 * `BaseWatcher.suspendWatchRequest` pattern).
 */
export class ParcelRecursiveWatcher {
	private readonly instances = new Map<string, ParcelWatcherInstance>();
	private readonly suspended = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
	private enospcWarned = false;

	private readonly throttledEmitter: ThrottledEmitter;

	constructor(private readonly onEvents: (path: string, events: IFileChange[]) => void) {
		this.throttledEmitter = new ThrottledEmitter(
			THROTTLE_CHUNK_SIZE,
			THROTTLE_DELAY,
			THROTTLE_MAX_BUFFER,
			(events) => {
				// Group events by worktree root and dispatch
				const byRoot = new Map<string, IFileChange[]>();
				for (const evt of events) {
					// Find which watched root this event belongs to
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
	}

	get activeCount(): number {
		return this.instances.size;
	}

	get activePaths(): string[] {
		return [...this.instances.keys()];
	}

	/** Start watching a worktree root recursively. */
	async watch(rootPath: string, extraExcludes: string[] = []): Promise<void> {
		if (this.instances.has(rootPath)) return;

		// Clear any suspended poll for this path
		this.unsuspend(rootPath);

		await this.startWatching(rootPath, extraExcludes, 0);
	}

	/** Stop watching a worktree root. */
	async unwatch(rootPath: string): Promise<void> {
		this.unsuspend(rootPath);

		const instance = this.instances.get(rootPath);
		if (instance) {
			this.instances.delete(rootPath);
			await instance.stop();
			logger.debug("[ParcelWatcher] stopped", { path: rootPath });
		}
	}

	/** Stop all watchers. */
	async shutdown(): Promise<void> {
		// Clear all suspended polls
		for (const [path] of this.suspended) {
			this.unsuspend(path);
		}

		const stops: Promise<void>[] = [];
		for (const [path, instance] of this.instances) {
			this.instances.delete(path);
			stops.push(instance.stop());
		}
		await Promise.allSettled(stops);

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

		try {
			const worker = new RunOnceWorker<IFileChange>((rawEvents) => {
				this.handleAggregatedEvents(rootPath, rawEvents);
			}, EVENT_AGGREGATE_DELAY);

			const subscription = await parcelWatcher.subscribe(
				rootPath,
				(error, events) => {
					if (error) {
						this.onError(rootPath, extraExcludes, error, restarts);
						return;
					}
					const instance = this.instances.get(rootPath);
					if (instance && !instance.stopped) {
						instance.handleEvents(events);
					}
				},
				{ ignore },
			);

			const instance = new ParcelWatcherInstance(rootPath, restarts, subscription, worker);
			this.instances.set(rootPath, instance);

			logger.debug("[ParcelWatcher] started", {
				path: rootPath,
				restarts,
			});
		} catch (error) {
			this.onError(rootPath, extraExcludes, error, restarts);
		}
	}

	private handleAggregatedEvents(rootPath: string, rawEvents: IFileChange[]): void {
		if (rawEvents.length === 0) return;

		// Coalesce: merge CREATE+DELETE, deduplicate nested DELETEs, etc.
		const coalesced = coalesceEvents(rawEvents);
		if (coalesced.length === 0) return;

		// Detect root deletion
		const rootDeleted = coalesced.some(
			(e) => e.type === FileChangeType.DELETED && e.path === rootPath,
		);

		// Feed into throttled emitter
		const worked = this.throttledEmitter.work(coalesced);
		if (!worked) {
			logger.warn("[ParcelWatcher] event buffer overflow, some events dropped", {
				path: rootPath,
				pending: this.throttledEmitter.pending,
			});
		}

		// If root was deleted, suspend and poll for recovery
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

		// ENOSPC: inotify limit reached — warn once, don't restart
		if (msg.includes("No space left on device") || msg.includes("ENOSPC")) {
			if (!this.enospcWarned) {
				this.enospcWarned = true;
				logger.error("[ParcelWatcher] inotify limit reached (ENOSPC)", { path: rootPath });
			}
			return;
		}

		// EMFILE: too many open files — don't restart
		if (msg.includes("EMFILE")) {
			logger.error("[ParcelWatcher] too many open files (EMFILE)", { path: rootPath });
			return;
		}

		// Other errors: attempt restart up to MAX_RESTARTS
		if (restarts < MAX_RESTARTS) {
			logger.warn("[ParcelWatcher] restarting after error", {
				path: rootPath,
				error: msg,
				restart: restarts + 1,
			});

			// Stop current instance, then restart after a short delay
			const instance = this.instances.get(rootPath);
			if (instance) {
				this.instances.delete(rootPath);
				instance.stop().catch(() => {});
			}

			setTimeout(() => {
				if (!this.instances.has(rootPath)) {
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
		}
	}

	/**
	 * When the watched root directory is deleted, stop the watcher and
	 * fall back to `fs.watchFile()` polling to detect when it reappears.
	 * This mirrors VS Code's `BaseWatcher.suspendWatchRequest` pattern.
	 */
	private onRootDeleted(rootPath: string): void {
		logger.warn("[ParcelWatcher] watched root deleted, suspending", { path: rootPath });

		// Stop the parcel watcher
		const instance = this.instances.get(rootPath);
		if (instance) {
			this.instances.delete(rootPath);
			instance.stop().catch(() => {});
		}

		// Start polling with fs.watchFile
		const callback = (curr: Stats, _prev: Stats) => {
			// ctimeMs === 0 && ino === 0 means path does not exist
			if (curr.ctimeMs !== 0 || curr.ino !== 0) {
				logger.info("[ParcelWatcher] watched root reappeared, resuming", { path: rootPath });
				this.unsuspend(rootPath);
				// Re-start watching
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
