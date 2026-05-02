import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narrators } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";

// === Types ===

export type BackgroundTaskRecord = typeof backgroundTasks.$inferSelect;

export interface WaitResult {
	status: string;
	output: string | null;
}

export interface CompletedNotification {
	id: string;
	type: "bash" | "agent";
	title: string | null;
	alias: string | null;
	status: string;
	outputPreview: string;
}

// === Constants ===

const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB stored in DB
/** Max in-memory output buffer per task (defensive cap — callers should truncate earlier) */
const MAX_MEMORY_OUTPUT_BYTES = 12 * 1024 * 1024; // 12 MB
const PREVIEW_LENGTH = 200;
/** Auto-cleanup completed tasks older than 30 minutes */
const CLEANUP_RETENTION_MS = 30 * 60_000;
/** Run cleanup at most once per 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * Truncate a string so that its UTF-8 byte length does not exceed `maxBytes`.
 * Uses TextEncoder to measure actual byte length and binary-searches for the
 * correct character boundary. Falls back to a conservative estimate for speed.
 */
function truncateToBytes(str: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(str);
	if (encoded.byteLength <= maxBytes) return str;
	// Decode the truncated bytes back to a string, which automatically
	// handles multi-byte character boundaries (incomplete sequences are dropped).
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	return decoder.decode(encoded.slice(0, maxBytes));
}

// === Service ===

class BackgroundTaskService {
	/** Abort controllers for running tasks (bash process abort, agent loop abort) */
	private abortControllers: Map<string, AbortController>;
	/** Kill handlers for bash processes (sends SIGTERM/SIGKILL) */
	private killHandlers: Map<string, () => void>;
	/** In-memory output chunk buffers for streaming bash output (joined on read) */
	private outputChunks: Map<string, string[]>;
	/** Accumulated byte length per task (for enforcing MAX_MEMORY_OUTPUT_BYTES) */
	private outputByteCounts: Map<string, number>;
	/** In-memory sync notification queue for completed bash tasks (keyed by parentNarratorId) */
	private bashNotificationQueue: Map<string, CompletedNotification[]>;
	/** Cached parentNarratorId per task (avoids DB lookup in appendOutput) */
	private parentNarratorCache: Map<string, string>;
	/** Last time cleanupCompleted was run */
	private lastCleanupAt: number;
	/** Throttle timers for WS output broadcasts (taskId → timer) */
	private outputBroadcastTimers: Map<string, ReturnType<typeof setTimeout>>;
	/** Cached broadcastToNarrator reference (lazy-loaded once) */
	private _broadcastFn:
		| ((id: string, msg: import("../websocket/narrator-ws-types").NarratorServerMessage) => void)
		| null;

	constructor() {
		this.abortControllers = hotSafe(
			"narrafork:bg-task:abortControllers",
			() => new Map<string, AbortController>(),
		);
		this.killHandlers = hotSafe(
			"narrafork:bg-task:killHandlers",
			() => new Map<string, () => void>(),
		);
		this.outputChunks = hotSafe(
			"narrafork:bg-task:outputChunks",
			() => new Map<string, string[]>(),
		);
		this.outputByteCounts = hotSafe(
			"narrafork:bg-task:outputByteCounts",
			() => new Map<string, number>(),
		);
		this.bashNotificationQueue = hotSafe(
			"narrafork:bg-task:bashNotificationQueue",
			() => new Map<string, CompletedNotification[]>(),
		);
		this.parentNarratorCache = hotSafe(
			"narrafork:bg-task:parentNarratorCache",
			() => new Map<string, string>(),
		);
		this.lastCleanupAt = 0;
		this.outputBroadcastTimers = hotSafe(
			"narrafork:bg-task:outputBroadcastTimers",
			() => new Map<string, ReturnType<typeof setTimeout>>(),
		);
		this._broadcastFn = null;
	}

	// ── Create ──────────────────────────────────────────────────────────

	async createBashTask(opts: {
		id: string;
		parentNarratorId: string;
		command: string;
		toolUseId?: string;
		alias?: string;
		title?: string;
	}): Promise<BackgroundTaskRecord> {
		const now = new Date().toISOString();
		const row: typeof backgroundTasks.$inferInsert = {
			id: opts.id,
			parentNarratorId: opts.parentNarratorId,
			type: "bash",
			status: "running",
			command: opts.command,
			toolUseId: opts.toolUseId ?? null,
			alias: opts.alias ?? null,
			title: opts.title ?? null,
			output: null,
			outputBytes: 0,
			outputTruncated: false,
			notified: false,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(backgroundTasks).values(row);
		this.outputChunks.set(opts.id, []);
		this.parentNarratorCache.set(opts.id, opts.parentNarratorId);
		this.maybeCleanup();
		return row as BackgroundTaskRecord;
	}

	async createAgentTask(opts: {
		id: string;
		parentNarratorId: string;
		subagentNarratorId: string;
		subagentType: string;
		toolUseId?: string;
		alias?: string;
		title?: string;
	}): Promise<BackgroundTaskRecord> {
		const now = new Date().toISOString();
		const row: typeof backgroundTasks.$inferInsert = {
			id: opts.id,
			parentNarratorId: opts.parentNarratorId,
			type: "agent",
			status: "running",
			subagentNarratorId: opts.subagentNarratorId,
			subagentType: opts.subagentType,
			toolUseId: opts.toolUseId ?? null,
			alias: opts.alias ?? null,
			title: opts.title ?? null,
			output: null,
			outputBytes: 0,
			outputTruncated: false,
			notified: false,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(backgroundTasks).values(row);
		this.parentNarratorCache.set(opts.id, opts.parentNarratorId);
		return row as BackgroundTaskRecord;
	}

	// ── Status updates ──────────────────────────────────────────────────

	async markCompleted(taskId: string, output: string, exitCode?: number): Promise<boolean> {
		const now = new Date().toISOString();
		const outputBytes = Buffer.byteLength(output, "utf-8");
		const truncated = outputBytes > MAX_OUTPUT_BYTES;
		const storedOutput = truncated ? truncateToBytes(output, MAX_OUTPUT_BYTES) : output;

		const [task] = await db
			.update(backgroundTasks)
			.set({
				status: "completed",
				output: storedOutput,
				outputBytes,
				outputTruncated: truncated,
				exitCode: exitCode ?? null,
				completedAt: now,
				updatedAt: now,
			})
			.where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.status, "running")))
			.returning();

		if (!task) {
			this.cleanupRuntime(taskId);
			return false;
		}

		eventBus.emit({
			type: "background_task:completed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			output: storedOutput,
		});

		// Push to sync notification queue for bash tasks
		if (task.type === "bash") {
			this.pushBashNotification(task.parentNarratorId, {
				id: task.id,
				type: "bash",
				title: task.title,
				alias: task.alias,
				status: "completed",
				outputPreview: storedOutput
					? storedOutput.length > PREVIEW_LENGTH
						? `${storedOutput.slice(0, PREVIEW_LENGTH)}…`
						: storedOutput
					: "",
			});
		}

		this.broadcastStatus(task.parentNarratorId, taskId, "completed", storedOutput, task.toolUseId);
		this.cleanupRuntime(taskId);
		return true;
	}

	async markFailed(taskId: string, error: string, exitCode?: number): Promise<boolean> {
		const now = new Date().toISOString();
		// Truncate error output the same way as markCompleted
		const errorBytes = Buffer.byteLength(error, "utf-8");
		const truncated = errorBytes > MAX_OUTPUT_BYTES;
		const storedError = truncated ? truncateToBytes(error, MAX_OUTPUT_BYTES) : error;

		const [task] = await db
			.update(backgroundTasks)
			.set({
				status: "failed",
				output: storedError,
				outputBytes: errorBytes,
				outputTruncated: truncated,
				exitCode: exitCode ?? null,
				completedAt: now,
				updatedAt: now,
			})
			.where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.status, "running")))
			.returning();

		if (!task) {
			this.cleanupRuntime(taskId);
			return false;
		}

		eventBus.emit({
			type: "background_task:failed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			error: storedError,
		});

		// Push to sync notification queue for bash tasks
		if (task.type === "bash") {
			this.pushBashNotification(task.parentNarratorId, {
				id: task.id,
				type: "bash",
				title: task.title,
				alias: task.alias,
				status: "failed",
				outputPreview: storedError
					? storedError.length > PREVIEW_LENGTH
						? `${storedError.slice(0, PREVIEW_LENGTH)}…`
						: storedError
					: "",
			});
		}

		this.broadcastStatus(task.parentNarratorId, taskId, "failed", storedError, task.toolUseId);
		this.cleanupRuntime(taskId);
		return true;
	}

	async markCancelled(taskId: string): Promise<boolean> {
		const now = new Date().toISOString();
		const output = this.getOutputBuffer(taskId);
		const outputBytes = output ? Buffer.byteLength(output, "utf-8") : 0;
		const truncated = outputBytes > MAX_OUTPUT_BYTES;
		const storedOutput = output
			? truncated
				? truncateToBytes(output, MAX_OUTPUT_BYTES)
				: output
			: null;

		const [task] = await db
			.update(backgroundTasks)
			.set({
				status: "cancelled",
				...(storedOutput !== null
					? { output: storedOutput, outputBytes, outputTruncated: truncated }
					: {}),
				completedAt: now,
				updatedAt: now,
			})
			.where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.status, "running")))
			.returning();

		if (!task) {
			this.cleanupRuntime(taskId);
			return false;
		}

		eventBus.emit({
			type: "background_task:cancelled",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
		});

		this.broadcastStatus(task.parentNarratorId, taskId, "cancelled", storedOutput, task.toolUseId);
		this.cleanupRuntime(taskId);
		return true;
	}

	// ── Query ───────────────────────────────────────────────────────────

	async getById(taskId: string): Promise<BackgroundTaskRecord | null> {
		const row = await db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		return row ?? null;
	}

	/**
	 * Look up a background task by its alias within a specific parent narrator scope.
	 * Falls back to a global alias search if parentNarratorId is not provided.
	 * Used when the in-memory alias registry has been cleared (e.g. after agent loop ends).
	 */
	async getByAlias(alias: string, parentNarratorId?: string): Promise<BackgroundTaskRecord | null> {
		const conditions = [eq(backgroundTasks.alias, alias)];
		if (parentNarratorId) {
			conditions.push(eq(backgroundTasks.parentNarratorId, parentNarratorId));
		}
		const row = await db
			.select()
			.from(backgroundTasks)
			.where(and(...conditions))
			.orderBy(desc(backgroundTasks.createdAt))
			.get();
		return row ?? null;
	}

	/**
	 * Persist an alias to the background_tasks table so it survives
	 * in-memory registry cleanup across agent loop restarts.
	 */
	async updateAlias(taskId: string, alias: string): Promise<void> {
		await db
			.update(backgroundTasks)
			.set({ alias, updatedAt: new Date().toISOString() })
			.where(eq(backgroundTasks.id, taskId));
	}

	async listByParent(parentNarratorId: string): Promise<BackgroundTaskRecord[]> {
		return db
			.select()
			.from(backgroundTasks)
			.where(eq(backgroundTasks.parentNarratorId, parentNarratorId))
			.orderBy(desc(backgroundTasks.createdAt))
			.all();
	}

	// ── Operations ──────────────────────────────────────────────────────

	async cancel(taskId: string): Promise<boolean> {
		const task = await this.getById(taskId);
		if (!task || task.status !== "running") return false;

		const ctrl = this.abortControllers.get(taskId);
		if (ctrl) {
			try {
				ctrl.abort();
			} catch {
				// already aborted
			}
		}

		const killHandler = this.killHandlers.get(taskId);
		if (killHandler) {
			try {
				killHandler();
			} catch (err) {
				logger.warn("Kill handler error during cancel", {
					taskId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const cancelled = await this.markCancelled(taskId);
		if (!cancelled) return false;
		if (task.type === "agent") {
			await this.markAgentNarratorCancelled(task);
		}
		return true;
	}

	registerAbortController(taskId: string, ctrl: AbortController): void {
		this.abortControllers.set(taskId, ctrl);
	}

	registerKillHandler(taskId: string, handler: () => void): void {
		this.killHandlers.set(taskId, handler);
	}

	// ── Bash output management ──────────────────────────────────────────

	appendOutput(taskId: string, chunk: string): void {
		// Defensive cap: stop accumulating if we've exceeded the in-memory limit
		const currentBytes = this.outputByteCounts.get(taskId) ?? 0;
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		if (currentBytes >= MAX_MEMORY_OUTPUT_BYTES) return;
		this.outputByteCounts.set(taskId, currentBytes + chunkBytes);

		const chunks = this.outputChunks.get(taskId);
		if (chunks) {
			chunks.push(chunk);
		} else {
			this.outputChunks.set(taskId, [chunk]);
		}

		// Use cached parentNarratorId — no DB lookup needed
		const parentNarratorId = this.parentNarratorCache.get(taskId);
		if (parentNarratorId) {
			eventBus.emit({
				type: "background_task:output",
				taskId,
				parentNarratorId,
				chunk,
			});

			// Throttled WS broadcast — at most once per 2 seconds per task
			if (!this.outputBroadcastTimers.has(taskId)) {
				this.outputBroadcastTimers.set(
					taskId,
					setTimeout(() => {
						this.outputBroadcastTimers.delete(taskId);
						const totalBytes = (this.outputChunks.get(taskId) ?? []).reduce(
							(sum, c) => sum + Buffer.byteLength(c, "utf-8"),
							0,
						);
						this.getBroadcastFn().then((fn) => {
							if (fn) {
								fn(parentNarratorId, {
									type: "background_task_output",
									narratorId: parentNarratorId,
									taskId,
									outputBytes: totalBytes,
								});
							}
						});
					}, 2000),
				);
			}
		}
	}

	getOutputBuffer(taskId: string): string | null {
		const chunks = this.outputChunks.get(taskId);
		if (!chunks || chunks.length === 0) return null;
		return chunks.join("");
	}

	// ── Event-driven waiting ────────────────────────────────────────────

	async waitForCompletion(
		taskId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<WaitResult> {
		// Check if already done
		const task = await this.getById(taskId);
		if (task && task.status !== "running") {
			return { status: task.status, output: task.output };
		}

		return new Promise<WaitResult>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				eventBus.off("background_task:completed", onCompleted);
				eventBus.off("background_task:failed", onFailed);
				eventBus.off("background_task:cancelled", onCancelled);
				signal?.removeEventListener("abort", onAbort);
			};

			const onCompleted = (event: { taskId: string; output: string | null }) => {
				if (settled || event.taskId !== taskId) return;
				cleanup();
				resolve({ status: "completed", output: event.output });
			};
			const onFailed = (event: { taskId: string; error: string | null }) => {
				if (settled || event.taskId !== taskId) return;
				cleanup();
				resolve({ status: "failed", output: event.error });
			};
			const onCancelled = (event: { taskId: string }) => {
				if (settled || event.taskId !== taskId) return;
				const output = this.getOutputBuffer(taskId);
				cleanup();
				resolve({ status: "cancelled", output });
			};

			const onAbort = () => {
				cleanup();
				resolve({ status: "aborted", output: this.getOutputBuffer(taskId) });
			};

			eventBus.on("background_task:completed", onCompleted);
			eventBus.on("background_task:failed", onFailed);
			eventBus.on("background_task:cancelled", onCancelled);

			if (signal) {
				if (signal.aborted) {
					cleanup();
					resolve({ status: "aborted", output: this.getOutputBuffer(taskId) });
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			timer = setTimeout(() => {
				cleanup();
				resolve({ status: "timeout", output: this.getOutputBuffer(taskId) });
			}, timeoutMs);
		});
	}

	async waitForText(
		taskId: string,
		text: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<WaitResult> {
		// Check persisted state first. Completed tasks have already had their
		// in-memory output buffer cleaned up, so relying on the buffer would wait
		// until timeout and return empty output.
		const task = await this.getById(taskId);
		if (task && task.status !== "running") {
			return {
				status: task.output?.includes(text) ? "found" : task.status,
				output: task.output,
			};
		}

		// Check if already in buffer
		const buf = this.getOutputBuffer(taskId);
		if (buf?.includes(text)) {
			return { status: "found", output: buf };
		}

		return new Promise<WaitResult>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				eventBus.off("background_task:output", onOutput);
				eventBus.off("background_task:completed", onCompleted);
				eventBus.off("background_task:failed", onFailed);
				eventBus.off("background_task:cancelled", onCancelled);
				signal?.removeEventListener("abort", onAbort);
			};

			const onOutput = (event: { taskId: string }) => {
				if (settled || event.taskId !== taskId) return;
				const currentBuf = this.getOutputBuffer(taskId) ?? "";
				if (currentBuf.includes(text)) {
					cleanup();
					resolve({ status: "found", output: currentBuf });
				}
			};

			const onCompleted = (event: { taskId: string; output: string | null }) => {
				if (settled || event.taskId !== taskId) return;
				const output = event.output ?? "";
				cleanup();
				resolve({ status: output.includes(text) ? "found" : "completed", output });
			};

			const onFailed = (event: { taskId: string; error: string | null }) => {
				if (settled || event.taskId !== taskId) return;
				const output = event.error ?? "";
				cleanup();
				resolve({ status: output.includes(text) ? "found" : "failed", output });
			};

			const onCancelled = (event: { taskId: string }) => {
				if (settled || event.taskId !== taskId) return;
				const finalBuf = this.getOutputBuffer(taskId);
				cleanup();
				resolve({ status: finalBuf?.includes(text) ? "found" : "cancelled", output: finalBuf });
			};

			const onAbort = () => {
				cleanup();
				resolve({ status: "aborted", output: this.getOutputBuffer(taskId) });
			};

			eventBus.on("background_task:output", onOutput);
			eventBus.on("background_task:completed", onCompleted);
			eventBus.on("background_task:failed", onFailed);
			eventBus.on("background_task:cancelled", onCancelled);

			if (signal) {
				if (signal.aborted) {
					cleanup();
					resolve({ status: "aborted", output: this.getOutputBuffer(taskId) });
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			timer = setTimeout(() => {
				cleanup();
				resolve({ status: "timeout", output: this.getOutputBuffer(taskId) });
			}, timeoutMs);
		});
	}

	// ── Notification drain ──────────────────────────────────────────────

	async drainCompletedNotifications(parentNarratorId: string): Promise<CompletedNotification[]> {
		const rows = await db
			.select()
			.from(backgroundTasks)
			.where(
				and(
					eq(backgroundTasks.parentNarratorId, parentNarratorId),
					eq(backgroundTasks.notified, false),
					ne(backgroundTasks.status, "running"),
				),
			)
			.all();

		if (rows.length === 0) return [];

		// Batch-mark all as notified in a single UPDATE
		const now = new Date().toISOString();
		const ids = rows.map((r) => r.id);
		await db
			.update(backgroundTasks)
			.set({ notified: true, updatedAt: now })
			.where(inArray(backgroundTasks.id, ids));

		return rows.map((row) => ({
			id: row.id,
			type: row.type,
			title: row.title,
			alias: row.alias,
			status: row.status,
			outputPreview: row.output
				? row.output.length > PREVIEW_LENGTH
					? `${row.output.slice(0, PREVIEW_LENGTH)}…`
					: row.output
				: "",
		}));
	}

	// ── Synchronous bash notification drain ─────────────────────────────

	/**
	 * Drain completed bash task notifications synchronously from the in-memory queue.
	 * Used by getInjectedUserText (a sync callback) in the agent loop.
	 */
	drainBashNotificationsSync(parentNarratorId: string): CompletedNotification[] {
		const queue = this.bashNotificationQueue.get(parentNarratorId);
		if (!queue || queue.length === 0) return [];
		this.bashNotificationQueue.delete(parentNarratorId);
		return queue;
	}

	/** Push a bash task completion notification to the in-memory sync queue. */
	private pushBashNotification(
		parentNarratorId: string,
		notification: CompletedNotification,
	): void {
		const queue = this.bashNotificationQueue.get(parentNarratorId) ?? [];
		queue.push(notification);
		this.bashNotificationQueue.set(parentNarratorId, queue);
	}

	// ── Cleanup ─────────────────────────────────────────────────────────

	/**
	 * Delete completed/failed/cancelled tasks older than the given retention period.
	 * Uses a single SQL query with WHERE conditions — no N+1.
	 */
	async cleanupCompleted(olderThanMs: number = CLEANUP_RETENTION_MS): Promise<number> {
		const cutoff = new Date(Date.now() - olderThanMs).toISOString();
		// Count first, then delete — Drizzle's delete() returns void for SQLite
		const rows = await db
			.select({ id: backgroundTasks.id })
			.from(backgroundTasks)
			.where(and(ne(backgroundTasks.status, "running"), lt(backgroundTasks.completedAt, cutoff)))
			.all();

		if (rows.length === 0) return 0;

		await db
			.delete(backgroundTasks)
			.where(and(ne(backgroundTasks.status, "running"), lt(backgroundTasks.completedAt, cutoff)));

		for (const row of rows) {
			this.cleanupRuntime(row.id);
		}

		logger.debug("Cleaned up completed background tasks", { deleted: rows.length });
		return rows.length;
	}

	/** Trigger cleanup if enough time has passed since the last run. */
	private maybeCleanup(): void {
		const now = Date.now();
		if (now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
		this.lastCleanupAt = now;
		this.cleanupCompleted().catch((err) => {
			logger.warn("Background task cleanup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async killAll(): Promise<void> {
		// Cancel all running tasks in DB
		const running = await db
			.select()
			.from(backgroundTasks)
			.where(eq(backgroundTasks.status, "running"))
			.all();

		for (const task of running) {
			const ctrl = this.abortControllers.get(task.id);
			if (ctrl) {
				try {
					ctrl.abort();
				} catch {
					// already aborted
				}
			}

			const killHandler = this.killHandlers.get(task.id);
			if (killHandler) {
				try {
					killHandler();
				} catch (err) {
					logger.warn("Kill handler error during killAll", {
						taskId: task.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			// Use markCancelled to ensure events are emitted and waiters are notified
			const cancelled = await this.markCancelled(task.id);
			if (cancelled && task.type === "agent") {
				await this.markAgentNarratorCancelled(task);
			}
		}

		logger.info("Killed all background tasks", { count: running.length });
	}

	// ── Private helpers ─────────────────────────────────────────────────

	private async markAgentNarratorCancelled(task: BackgroundTaskRecord): Promise<void> {
		const subagentNarratorId = task.subagentNarratorId ?? task.id;
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				backgroundStatus: "cancelled",
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentNarratorId));
		const { narratorService } = await import("./narrator-service");
		await narratorService.updateStatus(subagentNarratorId, "idle", {
			substatus: ["interrupted"],
			skipErrorMessage: true,
		});

		eventBus.emit({
			type: "narrator:background_task_cancelled",
			narratorId: task.parentNarratorId,
			parentNarratorId: task.parentNarratorId,
			taskNarratorId: subagentNarratorId,
			toolUseId: task.toolUseId ?? "",
		});
	}

	private cleanupRuntime(taskId: string): void {
		this.abortControllers.delete(taskId);
		this.killHandlers.delete(taskId);
		this.outputChunks.delete(taskId);
		this.outputByteCounts.delete(taskId);
		this.parentNarratorCache.delete(taskId);
		const timer = this.outputBroadcastTimers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.outputBroadcastTimers.delete(taskId);
		}
	}

	/** Lazy-load and cache broadcastToNarrator to avoid circular dependency. */
	private async getBroadcastFn(): Promise<
		| ((id: string, msg: import("../websocket/narrator-ws-types").NarratorServerMessage) => void)
		| null
	> {
		if (this._broadcastFn) return this._broadcastFn;
		try {
			const { broadcastToNarrator } = await import("../websocket/narrator-ws");
			this._broadcastFn = broadcastToNarrator;
			return broadcastToNarrator;
		} catch {
			return null;
		}
	}

	private broadcastStatus(
		parentNarratorId: string,
		taskId: string,
		status: string,
		output: string | null,
		toolUseId: string | null,
	): void {
		const effectiveToolUseId = toolUseId ?? "";
		this.getBroadcastFn()
			.then((fn) => {
				if (!fn) return;
				if (status === "completed") {
					fn(parentNarratorId, {
						type: "background_task_completed",
						narratorId: parentNarratorId,
						taskNarratorId: taskId,
						toolUseId: effectiveToolUseId,
						resultPreview: output
							? output.length > PREVIEW_LENGTH
								? `${output.slice(0, PREVIEW_LENGTH)}…`
								: output
							: "",
					});
				} else if (status === "failed") {
					fn(parentNarratorId, {
						type: "background_task_failed",
						narratorId: parentNarratorId,
						taskNarratorId: taskId,
						toolUseId: effectiveToolUseId,
						error: output ?? "Unknown error",
					});
				} else if (status === "cancelled") {
					fn(parentNarratorId, {
						type: "background_task_cancelled",
						narratorId: parentNarratorId,
						taskNarratorId: taskId,
						toolUseId: effectiveToolUseId,
					});
				}
				// Also send the unified status_changed message for the frontend drawer
				fn(parentNarratorId, {
					type: "background_task_status_changed",
					narratorId: parentNarratorId,
					taskId,
					status,
					output: output
						? output.length > PREVIEW_LENGTH
							? `${output.slice(0, PREVIEW_LENGTH)}…`
							: output
						: null,
				});
			})
			.catch((err) => {
				logger.warn("Failed to broadcast background task status", {
					taskId,
					status,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}
}

export const backgroundTaskService = new BackgroundTaskService();
