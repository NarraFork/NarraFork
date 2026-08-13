import { and, count, desc, eq, getTableColumns, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narrators } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { pushPendingInjection } from "./parent-injection-queue";

// === Types ===

export type BackgroundTaskRecord = typeof backgroundTasks.$inferSelect;

export type BackgroundTaskEffectiveStatus =
	| BackgroundTaskRecord["status"]
	| "continued"
	| "child_running";

export interface BackgroundTaskSummary extends BackgroundTaskRecord {
	effectiveStatus: BackgroundTaskEffectiveStatus;
	currentNarratorStatus: string | null;
	activeChildTaskCount: number;
	canCancelActiveWork: boolean;
}

export interface BackgroundTaskTerminalVersion {
	status: Exclude<BackgroundTaskRecord["status"], "running">;
	completedAt: string;
}

export function getBackgroundTaskTerminalVersion(
	task: BackgroundTaskRecord | null | undefined,
): BackgroundTaskTerminalVersion | null {
	if (!task || task.type !== "agent" || task.status === "running" || !task.completedAt) {
		return null;
	}
	return { status: task.status, completedAt: task.completedAt };
}

export function resolveBackgroundTaskEffectiveStatus(input: {
	taskStatus: BackgroundTaskRecord["status"];
	currentNarratorStatus?: string | null;
	currentNarratorIsBackground?: boolean | null;
	currentNarratorBackgroundStatus?: string | null;
	currentNarratorSubstatus?: unknown;
	currentNarratorErrorMessage?: string | null;
	activeChildTaskCount?: number;
}): BackgroundTaskEffectiveStatus {
	if (input.taskStatus === "running") return "running";
	if (input.currentNarratorStatus === "working" || input.currentNarratorStatus === "waiting") {
		return "continued";
	}
	if ((input.activeChildTaskCount ?? 0) > 0) return "child_running";

	if (input.currentNarratorStatus === "idle") {
		const substatus = parseSubstatus(input.currentNarratorSubstatus);
		if (substatus.includes("timeout")) return "timeout";
		if (substatus.includes("unread") || input.currentNarratorBackgroundStatus === "completed") {
			return "completed";
		}
		if (
			substatus.includes("interrupted") ||
			input.currentNarratorBackgroundStatus === "cancelled"
		) {
			return "cancelled";
		}
		if (
			substatus.includes("error") ||
			input.currentNarratorErrorMessage ||
			input.currentNarratorBackgroundStatus === "failed"
		) {
			// Preserve a timeout when the current run itself ended with the timeout
			// marker. A stale timeout row with an ordinary unread/error narrator is
			// still reconciled from the current narrator state below.
			const errorText = input.currentNarratorErrorMessage?.toLowerCase() ?? "";
			if (
				input.taskStatus === "timeout" &&
				(input.currentNarratorIsBackground !== false ||
					substatus.includes("timeout") ||
					errorText.includes("timed out") ||
					errorText.includes("execution timeout"))
			) {
				return "timeout";
			}
			return "failed";
		}
	}

	return input.taskStatus;
}

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
/**
 * Max chars of `output` returned by the LIST path. The task drawer only shows a
 * preview (frontend caps at 4 000) and fetches full output via the dedicated
 * /output endpoint, so the list must never materialize the full column (up to
 * MAX_OUTPUT_BYTES per row) — that would violate the main-thread perf rule.
 */
const LIST_OUTPUT_PREVIEW_CHARS = 4_000;
/**
 * Hard cap for a single tail read (live buffer or stored column). Tail reads are
 * polled by the task panel while a command runs, so they must stay small and
 * must never join/materialize the whole buffer on the main thread.
 */
export const OUTPUT_TAIL_MAX_CHARS = 20_000;
/** Auto-cleanup completed tasks older than 30 minutes */
const CLEANUP_RETENTION_MS = 30 * 60_000;
/** Run cleanup at most once per 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * Truncate a string so that its UTF-8 byte length does not exceed `maxBytes`.
 * Uses TextEncoder to measure actual byte length and binary-searches for the
 * correct character boundary. Falls back to a conservative estimate for speed.
 */
function toWaitStatus(status: string): string {
	return status === "timeout" ? "timed_out" : status;
}

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
	/** Cached parentNarratorId per task (avoids DB lookup in appendOutput) */
	private parentNarratorCache: Map<string, string>;
	/** Last time cleanupCompleted was run */
	private lastCleanupAt: number;
	/** Throttle timers for WS output broadcasts (taskId → timer) */
	private outputBroadcastTimers: Map<string, ReturnType<typeof setTimeout>>;
	/** Terminal Agent task rows currently being continued in the foreground. */
	private activeAgentContinuations: Set<string>;
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
		this.parentNarratorCache = hotSafe(
			"narrafork:bg-task:parentNarratorCache",
			() => new Map<string, string>(),
		);
		this.lastCleanupAt = 0;
		this.outputBroadcastTimers = hotSafe(
			"narrafork:bg-task:outputBroadcastTimers",
			() => new Map<string, ReturnType<typeof setTimeout>>(),
		);
		this.activeAgentContinuations = hotSafe(
			"narrafork:bg-task:activeAgentContinuations",
			() => new Set<string>(),
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
		const existing = await this.getById(opts.id);
		if (existing) {
			const existingSubagentId = existing.subagentNarratorId ?? existing.id;
			if (
				existing.type !== "agent" ||
				existing.parentNarratorId !== opts.parentNarratorId ||
				existingSubagentId !== opts.subagentNarratorId
			) {
				throw new Error(`Background task id "${opts.id}" belongs to a different task`);
			}

			this.parentNarratorCache.set(opts.id, opts.parentNarratorId);
			if (existing.status === "running") return existing;

			const [restarted] = await db
				.update(backgroundTasks)
				.set({
					status: "running",
					command: null,
					exitCode: null,
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
					completedAt: null,
					updatedAt: now,
				})
				.where(and(eq(backgroundTasks.id, opts.id), eq(backgroundTasks.status, existing.status)))
				.returning();

			if (restarted) {
				this.outputChunks.delete(opts.id);
				this.outputByteCounts.delete(opts.id);
				const timer = this.outputBroadcastTimers.get(opts.id);
				if (timer) {
					clearTimeout(timer);
					this.outputBroadcastTimers.delete(opts.id);
				}
				this.maybeCleanup();
				return restarted;
			}

			const current = await this.getById(opts.id);
			if (current?.status === "running") return current;
			throw new Error(`Background task "${opts.id}" changed while restarting`);
		}

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
		this.maybeCleanup();
		return row as BackgroundTaskRecord;
	}

	// ── Status updates ──────────────────────────────────────────────────

	async markCompleted(
		taskId: string,
		output: string,
		exitCode?: number,
		expectedAbortController?: AbortController,
	): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
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
			this.cleanupRuntime(taskId, expectedAbortController);
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
		this.cleanupRuntime(taskId, expectedAbortController);
		return true;
	}

	async markFailed(
		taskId: string,
		error: string,
		exitCode?: number,
		expectedAbortController?: AbortController,
	): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
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
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:failed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			error: storedError,
			status: "failed",
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
		this.cleanupRuntime(taskId, expectedAbortController);
		return true;
	}

	async markTimedOut(
		taskId: string,
		error: string,
		exitCode?: number,
		expectedAbortController?: AbortController,
	): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
		const now = new Date().toISOString();
		const errorBytes = Buffer.byteLength(error, "utf-8");
		const truncated = errorBytes > MAX_OUTPUT_BYTES;
		const storedError = truncated ? truncateToBytes(error, MAX_OUTPUT_BYTES) : error;

		const [task] = await db
			.update(backgroundTasks)
			.set({
				status: "timeout",
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
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:failed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			error: storedError,
			status: "timeout",
		});

		if (task.type === "bash") {
			this.pushBashNotification(task.parentNarratorId, {
				id: task.id,
				type: "bash",
				title: task.title,
				alias: task.alias,
				status: "timeout",
				outputPreview: storedError
					? storedError.length > PREVIEW_LENGTH
						? `${storedError.slice(0, PREVIEW_LENGTH)}…`
						: storedError
					: "",
			});
		}

		this.broadcastStatus(task.parentNarratorId, taskId, "timeout", storedError, task.toolUseId);
		this.cleanupRuntime(taskId, expectedAbortController);
		return true;
	}

	async markCancelled(taskId: string, expectedAbortController?: AbortController): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
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
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:cancelled",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
		});

		this.broadcastStatus(task.parentNarratorId, taskId, "cancelled", storedOutput, task.toolUseId);
		this.cleanupRuntime(taskId, expectedAbortController);
		return true;
	}

	/**
	 * Persist the terminal result of a foreground continuation that originated
	 * from a terminal background-agent run. The version guard prevents an old
	 * continuation from overwriting a newer background run that reused the same
	 * subagent id.
	 */
	async finalizeResumedAgentTask(opts: {
		taskId: string;
		version: BackgroundTaskTerminalVersion;
		status: "completed" | "failed" | "cancelled" | "timeout";
		output: string;
	}): Promise<boolean> {
		const now = new Date().toISOString();
		const outputBytes = Buffer.byteLength(opts.output, "utf-8");
		const truncated = outputBytes > MAX_OUTPUT_BYTES;
		const storedOutput = truncated ? truncateToBytes(opts.output, MAX_OUTPUT_BYTES) : opts.output;
		const [task] = await db
			.update(backgroundTasks)
			.set({
				status: opts.status,
				output: storedOutput,
				outputBytes,
				outputTruncated: truncated,
				exitCode: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(backgroundTasks.id, opts.taskId),
					eq(backgroundTasks.type, "agent"),
					eq(backgroundTasks.status, opts.version.status),
					eq(backgroundTasks.completedAt, opts.version.completedAt),
				),
			)
			.returning();

		if (!task) return false;
		this.broadcastListStatus(task.parentNarratorId, task.id, opts.status, storedOutput);
		return true;
	}

	// ── Query ───────────────────────────────────────────────────────────

	async getById(taskId: string): Promise<BackgroundTaskRecord | null> {
		const row = await db.select().from(backgroundTasks).where(eq(backgroundTasks.id, taskId)).get();
		return row ?? null;
	}

	/**
	 * Read the TAIL of a task's output without materializing the whole buffer.
	 *
	 * A still-running bash task has no stored `output` column yet, so its tail is
	 * served from the in-memory chunk buffer — and only the chunks that cover the
	 * requested tail are joined, never the full (up to 12 MB) buffer. Terminal
	 * tasks read a SQL-side `substr` tail so the main thread never handles more
	 * than `maxChars` even for a 512 KB stored output.
	 */
	async readOutputTail(
		taskId: string,
		maxChars: number = OUTPUT_TAIL_MAX_CHARS,
	): Promise<{
		status: BackgroundTaskRecord["status"];
		type: BackgroundTaskRecord["type"];
		command: string | null;
		exitCode: number | null;
		tail: string;
		totalChars: number;
		truncated: boolean;
		/** True when the tail came from the live in-memory buffer. */
		live: boolean;
		startedAt: string;
		completedAt: string | null;
	} | null> {
		const limit = Math.max(1, Math.min(maxChars, OUTPUT_TAIL_MAX_CHARS));
		const row = await db
			.select({
				parentNarratorId: backgroundTasks.parentNarratorId,
				status: backgroundTasks.status,
				type: backgroundTasks.type,
				command: backgroundTasks.command,
				exitCode: backgroundTasks.exitCode,
				startedAt: backgroundTasks.startedAt,
				completedAt: backgroundTasks.completedAt,
				storedChars: sql<number>`coalesce(length(${backgroundTasks.output}), 0)`,
				// A negative start index makes substr() return the last N chars, so a
				// large stored output never crosses the JS boundary in full.
				storedTail: sql<string | null>`substr(${backgroundTasks.output}, ${-limit})`,
			})
			.from(backgroundTasks)
			.where(eq(backgroundTasks.id, taskId))
			.get();
		if (!row) return null;

		const buffered = row.status === "running" ? this.getOutputTailFromChunks(taskId, limit) : null;
		const tail = buffered ? buffered.tail : (row.storedTail ?? "");
		const totalChars = buffered ? buffered.totalChars : Number(row.storedChars) || 0;

		return {
			status: row.status,
			type: row.type,
			command: row.command,
			exitCode: row.exitCode,
			tail,
			totalChars,
			truncated: totalChars > tail.length,
			live: !!buffered,
			startedAt: row.startedAt,
			completedAt: row.completedAt,
		};
	}

	/**
	 * Join only the trailing `maxChars` of the in-memory chunk buffer. Returns
	 * null when no live buffer exists for the task (agent task, or a bash task
	 * whose runtime state was already cleaned up).
	 */
	private getOutputTailFromChunks(
		taskId: string,
		maxChars: number,
	): { tail: string; totalChars: number } | null {
		const chunks = this.outputChunks.get(taskId);
		if (!chunks) return null;
		let totalChars = 0;
		for (const chunk of chunks) totalChars += chunk.length;
		if (totalChars === 0) return { tail: "", totalChars: 0 };

		const parts: string[] = [];
		let remaining = maxChars;
		for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
			const chunk = chunks[i] as string;
			if (chunk.length <= remaining) {
				parts.push(chunk);
				remaining -= chunk.length;
			} else {
				parts.push(chunk.slice(chunk.length - remaining));
				remaining = 0;
			}
		}
		parts.reverse();
		return { tail: parts.join(""), totalChars };
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

	/**
	 * List tasks for a parent WITHOUT materializing each row's full `output`.
	 * The `output` column is replaced by a SQL-side `substr` preview so a parent
	 * with large accumulated outputs can't stall the JS main thread. `outputBytes`
	 * still reflects the true stored size; use `getById`/the /output endpoint for
	 * the complete text.
	 */
	async listByParent(parentNarratorId: string): Promise<BackgroundTaskRecord[]> {
		return this.listByParents([parentNarratorId]);
	}

	async listByParents(parentNarratorIds: string[]): Promise<BackgroundTaskRecord[]> {
		const parentIds = [...new Set(parentNarratorIds)].filter(Boolean);
		if (parentIds.length === 0) return [];
		const { output: _output, ...columns } = getTableColumns(backgroundTasks);
		return db
			.select({
				...columns,
				// substr keeps one extra char so the summary can detect truncation
				// even when byte and char counts diverge (multi-byte output).
				output: sql<
					string | null
				>`substr(${backgroundTasks.output}, 1, ${LIST_OUTPUT_PREVIEW_CHARS + 1})`,
			})
			.from(backgroundTasks)
			.where(inArray(backgroundTasks.parentNarratorId, parentIds))
			.orderBy(desc(backgroundTasks.createdAt))
			.all();
	}

	async listSummariesByParent(parentNarratorId: string): Promise<BackgroundTaskSummary[]> {
		return this.listSummariesByParents([parentNarratorId]);
	}

	async listSummariesByParents(parentNarratorIds: string[]): Promise<BackgroundTaskSummary[]> {
		const parentIds = [...new Set(parentNarratorIds)].filter(Boolean);
		if (parentIds.length === 0) return [];
		const tasks = await this.listByParents(parentIds);
		const agentIds = [
			...new Set(
				tasks
					.filter((task) => task.type === "agent")
					.map((task) => task.subagentNarratorId ?? task.id),
			),
		];
		if (agentIds.length === 0) {
			return tasks.map((task) => ({
				...task,
				effectiveStatus: task.status,
				currentNarratorStatus: null,
				activeChildTaskCount: 0,
				canCancelActiveWork: task.status === "running",
			}));
		}

		const [narratorRows, childRows] = await Promise.all([
			db
				.select({
					id: narrators.id,
					status: narrators.status,
					isBackground: narrators.isBackground,
					backgroundStatus: narrators.backgroundStatus,
					substatus: narrators.substatus,
					errorMessage: narrators.errorMessage,
				})
				.from(narrators)
				.where(inArray(narrators.id, agentIds))
				.all(),
			db
				.select({
					parentNarratorId: backgroundTasks.parentNarratorId,
					value: count(),
				})
				.from(backgroundTasks)
				.where(
					and(
						inArray(backgroundTasks.parentNarratorId, agentIds),
						eq(backgroundTasks.status, "running"),
					),
				)
				.groupBy(backgroundTasks.parentNarratorId)
				.all(),
		]);
		const narratorState = new Map(narratorRows.map((row) => [row.id, row]));
		const childCounts = new Map(
			childRows.map((row) => [row.parentNarratorId, Number(row.value) || 0]),
		);

		return tasks.map((task) => {
			const subagentNarratorId =
				task.type === "agent" ? (task.subagentNarratorId ?? task.id) : null;
			const currentNarrator = subagentNarratorId
				? (narratorState.get(subagentNarratorId) ?? null)
				: null;
			const currentNarratorStatus = currentNarrator?.status ?? null;
			const activeChildTaskCount = subagentNarratorId
				? (childCounts.get(subagentNarratorId) ?? 0)
				: 0;
			const effectiveStatus = resolveBackgroundTaskEffectiveStatus({
				taskStatus: task.status,
				currentNarratorStatus,
				currentNarratorIsBackground: currentNarrator?.isBackground,
				currentNarratorBackgroundStatus: currentNarrator?.backgroundStatus,
				currentNarratorSubstatus: currentNarrator?.substatus,
				currentNarratorErrorMessage: currentNarrator?.errorMessage,
				activeChildTaskCount,
			});
			return {
				...task,
				// A stale terminal row can carry the previous run's error text. Do not
				// show that text alongside a reconciled current-run status.
				output: effectiveStatus === task.status ? task.output : null,
				effectiveStatus,
				currentNarratorStatus,
				activeChildTaskCount,
				canCancelActiveWork:
					task.status === "running" || effectiveStatus === "continued" || activeChildTaskCount > 0,
			};
		});
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

		const cancelled = await this.markCancelled(taskId, ctrl);
		if (!cancelled) return false;
		if (task.type === "agent") {
			await this.markAgentNarratorCancelled(task);
		}
		return true;
	}

	async cancelRunningByParent(parentNarratorId: string): Promise<number> {
		let cancelled = 0;
		for (;;) {
			const running = await db
				.select({ id: backgroundTasks.id })
				.from(backgroundTasks)
				.where(
					and(
						eq(backgroundTasks.parentNarratorId, parentNarratorId),
						eq(backgroundTasks.status, "running"),
					),
				)
				.limit(100);
			if (running.length === 0) break;
			let pageProgress = 0;
			for (const task of running) {
				try {
					if (await this.cancel(task.id)) {
						cancelled++;
						pageProgress++;
					}
				} catch (err) {
					logger.warn("Failed to cancel child background task", {
						parentNarratorId,
						taskId: task.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			if (pageProgress === 0) break;
		}
		return cancelled;
	}

	registerAbortController(taskId: string, ctrl: AbortController): void {
		this.abortControllers.set(taskId, ctrl);
	}

	/**
	 * Silently end a background task row because the user took it over.
	 * Unlike markCancelled, this emits NO cancellation events/broadcasts — the
	 * subagent is now driven directly by the user (its narrator carries the
	 * taken_over state). Sets the row to "cancelled" so the await/background
	 * paths fall through to narrator-state handling and report it as taken over.
	 */
	async markTakenOver(taskId: string, expectedAbortController?: AbortController): Promise<void> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return;
		const now = new Date().toISOString();
		await db
			.update(backgroundTasks)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.status, "running")));
		this.cleanupRuntime(taskId, expectedAbortController);
	}

	unregisterAbortController(taskId: string, ctrl?: AbortController): void {
		if (ctrl && this.abortControllers.get(taskId) !== ctrl) return;
		this.abortControllers.delete(taskId);
	}

	/**
	 * Restore a taken-over background task row to its terminal result after the
	 * user stops takeover. The row was set to "cancelled" by markTakenOver during
	 * takeover; this rewrites it to completed/failed with the real output so the
	 * parent's Await path returns the actual result instead of a stale cancel.
	 * Emits NO events/broadcasts — the completion notification is pushed by
	 * finalizeTakenOverBackgroundSubagent.
	 */
	async finalizeTakenOver(taskId: string, hasError: boolean, output: string): Promise<void> {
		const now = new Date().toISOString();
		const outputBytes = Buffer.byteLength(output, "utf-8");
		const truncated = outputBytes > MAX_OUTPUT_BYTES;
		const storedOutput = truncated ? truncateToBytes(output, MAX_OUTPUT_BYTES) : output;
		await db
			.update(backgroundTasks)
			.set({
				status: hasError ? "failed" : "completed",
				output: storedOutput,
				outputBytes,
				outputTruncated: truncated,
				completedAt: now,
				updatedAt: now,
			})
			.where(eq(backgroundTasks.id, taskId));
		this.cleanupRuntime(taskId);
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
			return { status: toWaitStatus(task.status), output: task.output };
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
			const onFailed = (event: {
				taskId: string;
				error: string | null;
				status?: "failed" | "timeout";
			}) => {
				if (settled || event.taskId !== taskId) return;
				cleanup();
				resolve({ status: toWaitStatus(event.status ?? "failed"), output: event.error });
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
				status: task.output?.includes(text) ? "found" : toWaitStatus(task.status),
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

			const onFailed = (event: {
				taskId: string;
				error: string | null;
				status?: "failed" | "timeout";
			}) => {
				if (settled || event.taskId !== taskId) return;
				const output = event.error ?? "";
				cleanup();
				resolve({
					status: output.includes(text) ? "found" : toWaitStatus(event.status ?? "failed"),
					output,
				});
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
		// Only a short preview is needed here — never read the full output column.
		const rows = await db
			.select({
				id: backgroundTasks.id,
				type: backgroundTasks.type,
				title: backgroundTasks.title,
				alias: backgroundTasks.alias,
				status: backgroundTasks.status,
				outputPreview: sql<
					string | null
				>`substr(${backgroundTasks.output}, 1, ${PREVIEW_LENGTH + 1})`,
			})
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
			outputPreview: row.outputPreview
				? row.outputPreview.length > PREVIEW_LENGTH
					? `${row.outputPreview.slice(0, PREVIEW_LENGTH)}…`
					: row.outputPreview
				: "",
		}));
	}

	// ── Synchronous bash notification drain ─────────────────────────────

	/**
	 * Enqueue a finished bash task.
	 *
	 * Writes to the shared `parent-injection-queue` rather than a queue of its own: the
	 * turn boundary needs ONE order across bash completions, agent completions and
	 * `Send` reports, otherwise the drain has to invent a sequence (which is how a
	 * subagent's completion came to be shown before the message that preceded it).
	 */
	private pushBashNotification(
		parentNarratorId: string,
		notification: CompletedNotification,
	): void {
		pushPendingInjection(parentNarratorId, { kind: "bg_bash", task: notification });
	}

	// ── Recovery / continuation guards ──────────────────────────────────

	beginAgentContinuation(taskId: string): void {
		this.activeAgentContinuations.add(taskId);
	}

	endAgentContinuation(taskId: string): void {
		this.activeAgentContinuations.delete(taskId);
	}

	/** Cancel Agent task rows whose in-memory executor was lost in an unclean restart. */
	async recoverStaleAgentTasksAfterRestart(
		protectedTaskIds: ReadonlySet<string> = new Set(),
	): Promise<number> {
		const staleTasks = (
			await db
				.select({
					id: backgroundTasks.id,
					parentNarratorId: backgroundTasks.parentNarratorId,
					subagentNarratorId: backgroundTasks.subagentNarratorId,
				})
				.from(backgroundTasks)
				.where(and(eq(backgroundTasks.type, "agent"), eq(backgroundTasks.status, "running")))
				.all()
		).filter((task) => !protectedTaskIds.has(task.id));
		if (staleTasks.length === 0) return 0;

		const now = new Date().toISOString();
		const taskIds = staleTasks.map((task) => task.id);
		const narratorIds = [...new Set(staleTasks.map((task) => task.subagentNarratorId ?? task.id))];
		await db
			.update(backgroundTasks)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(
				and(
					inArray(backgroundTasks.id, taskIds),
					eq(backgroundTasks.type, "agent"),
					eq(backgroundTasks.status, "running"),
				),
			);
		await db
			.update(narrators)
			.set({
				isBackground: false,
				backgroundStatus: "cancelled",
				backgroundResult: "Background task was interrupted by a server restart.",
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(inArray(narrators.id, narratorIds));

		for (const task of staleTasks) {
			this.cleanupRuntime(task.id);
			eventBus.emit({
				type: "background_task:cancelled",
				taskId: task.id,
				parentNarratorId: task.parentNarratorId,
				taskType: "agent",
			});
		}
		logger.info("Recovered stale background Agent tasks after restart", {
			count: staleTasks.length,
		});
		return staleTasks.length;
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
		const deletableIds = rows
			.map((row) => row.id)
			.filter((taskId) => !this.activeAgentContinuations.has(taskId));

		if (deletableIds.length === 0) return 0;

		await db
			.delete(backgroundTasks)
			.where(
				and(
					inArray(backgroundTasks.id, deletableIds),
					ne(backgroundTasks.status, "running"),
					lt(backgroundTasks.completedAt, cutoff),
				),
			);

		for (const taskId of deletableIds) {
			this.cleanupRuntime(taskId);
		}

		logger.debug("Cleaned up completed background tasks", { deleted: deletableIds.length });
		return deletableIds.length;
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
			const cancelled = await this.markCancelled(task.id, ctrl);
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

	private ownsAbortController(taskId: string, expectedAbortController?: AbortController): boolean {
		return (
			!expectedAbortController || this.abortControllers.get(taskId) === expectedAbortController
		);
	}

	private cleanupRuntime(taskId: string, expectedAbortController?: AbortController): void {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return;
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

	/** Notify only the task-list surface without replaying the parent tool result. */
	private broadcastListStatus(
		parentNarratorId: string,
		taskId: string,
		status: string,
		output: string | null,
	): void {
		this.getBroadcastFn()
			.then((fn) => {
				if (!fn) return;
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
				logger.warn("Failed to broadcast resumed background task status", {
					taskId,
					status,
					error: err instanceof Error ? err.message : String(err),
				});
			});
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
				} else if (status === "failed" || status === "timeout") {
					fn(parentNarratorId, {
						type: "background_task_failed",
						narratorId: parentNarratorId,
						taskNarratorId: taskId,
						toolUseId: effectiveToolUseId,
						error: output ?? (status === "timeout" ? "Task timed out" : "Unknown error"),
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
