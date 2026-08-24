import {
	BACKGROUND_TASK_ACTIVE_LIMIT,
	BACKGROUND_TASK_DELTA_MAX_REMOVE_IDS,
	BACKGROUND_TASK_LIST_MAX_PAGE_SIZE,
	BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS,
	BACKGROUND_TASK_LIST_PAGE_SIZE,
	type BackgroundTaskListDelta,
	type BackgroundTaskListItem,
	type BackgroundTaskListPage,
	compareBackgroundTaskListItemsDesc,
	isBackgroundTaskActiveStatus,
} from "@shared/background-task-list";
import {
	and,
	type Column,
	count,
	desc,
	eq,
	getTableColumns,
	inArray,
	lt,
	ne,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { escapeLikeNeedle } from "../lib/sql-like";
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
const LIST_OUTPUT_PREVIEW_CHARS = BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS;
/**
 * Hard cap for a single tail read (live buffer or stored column). Tail reads are
 * polled by the task panel while a command runs, so they must stay small and
 * must never join/materialize the whole buffer on the main thread.
 */
export const OUTPUT_TAIL_MAX_CHARS = 20_000;
/**
 * Cap for the "how many rows did I leave out" count reported by the bounded team
 * view.
 *
 * A precise total would be an unbounded `COUNT(*)` over a table that grows with
 * every task the team has ever spawned — exactly the read the bounded view exists
 * to avoid. The cap keeps the scan bounded and the caller reports `500+` rather
 * than pretending to know more.
 */
const TEAM_OMITTED_COUNT_CAP = 500;
/** Auto-cleanup completed tasks older than 30 minutes */
const CLEANUP_RETENTION_MS = 30 * 60_000;
/** Run cleanup at most once per 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60_000;

/**
 * Identifies THIS server process to task-list clients.
 *
 * List versions are per-process counters rather than persisted columns: their
 * only job is to tell a client whether the deltas it received form an unbroken
 * chain since the page it holds. Persisting them would add a SQLite write to
 * every status transition to answer a question that does not survive a restart
 * anyway. After a restart the epoch differs, which the client reads as "drop
 * everything and refetch" — the same conclusion, without the writes.
 *
 * `hotSafe` so a dev-server hot reload cannot mint a new epoch (and thus force
 * every open panel to refetch) while the sockets stay up.
 */
export const BACKGROUND_TASK_LIST_EPOCH = hotSafe("narrafork:bg-task:listEpoch", () =>
	generateShortId(),
);

/**
 * Max parents tracked in the list-version map.
 *
 * Eviction loses a parent's version, so its next broadcast restarts at 1. A
 * client holding a higher version therefore sees the counter go BACKWARDS, which
 * `applyBackgroundTaskDelta` treats as `version-reset` → refetch: one extra HTTP
 * request, never a silently stale list. That client-side branch is what makes
 * eviction safe — if a lower version were dismissed as a duplicate instead, every
 * later frame would be dropped too and the panel would freeze with no signal.
 */
const MAX_TRACKED_LIST_VERSIONS = 500;

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

// === List paging ===

/** Opaque page cursor: the `(createdAt, id)` coordinate of the last row served. */
export interface BackgroundTaskListCursor {
	createdAt: string;
	id: string;
}

export function encodeBackgroundTaskListCursor(cursor: BackgroundTaskListCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

export function decodeBackgroundTaskListCursor(
	raw: string | undefined | null,
): BackgroundTaskListCursor | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as {
			createdAt?: unknown;
			id?: unknown;
		};
		if (
			typeof parsed.createdAt !== "string" ||
			!parsed.createdAt ||
			typeof parsed.id !== "string" ||
			!parsed.id
		) {
			throw new Error("invalid cursor payload");
		}
		return { createdAt: parsed.createdAt, id: parsed.id };
	} catch {
		throw new ValidationError("Invalid background task list cursor");
	}
}

function clampListLimit(limit: number | undefined): number {
	if (limit == null || !Number.isFinite(limit)) return BACKGROUND_TASK_LIST_PAGE_SIZE;
	return Math.min(Math.max(Math.trunc(limit), 1), BACKGROUND_TASK_LIST_MAX_PAGE_SIZE);
}

/**
 * `(createdAt, id) < cursor` in descending order.
 *
 * Written as an explicit tuple comparison rather than `createdAt < x` alone
 * because ISO timestamps collide freely — several tasks created inside the same
 * millisecond are routine, and a timestamp-only cursor would skip every sibling
 * after the first when a page boundary landed in the middle of such a group.
 */
function listCursorCondition(cursor: BackgroundTaskListCursor, createdAt: Column, id: Column) {
	return or(
		lt(createdAt, cursor.createdAt),
		and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)),
	);
}

/**
 * Cut a list preview and report whether it was cut.
 *
 * The SQL side already fetched `LIST_OUTPUT_PREVIEW_CHARS + 1` chars, so the
 * extra char is exactly the signal that more exists — that is why the query asks
 * for one more than it intends to serve.
 */
function toListPreview(output: string | null | undefined): {
	preview: string | null;
	truncated: boolean;
} {
	if (!output) return { preview: null, truncated: false };
	if (output.length <= LIST_OUTPUT_PREVIEW_CHARS) return { preview: output, truncated: false };
	return { preview: `${output.slice(0, LIST_OUTPUT_PREVIEW_CHARS)}…`, truncated: true };
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
	/**
	 * Monotonic list version per parent narrator. Insertion-ordered and bounded by
	 * MAX_TRACKED_LIST_VERSIONS; see that constant for why eviction is safe.
	 */
	private listVersions: Map<string, number>;
	/** Cached broadcastToNarrator reference (lazy-loaded once) */
	private _broadcastFn:
		| ((id: string, msg: import("../websocket/narrator-ws-types").NarratorServerMessage) => void)
		| null;
	/** Cached in-process liveness probe (lazy-loaded once; see getLivenessFn). */
	private _livenessFn: ((narratorId: string) => boolean) | null;

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
		this.listVersions = hotSafe("narrafork:bg-task:listVersions", () => new Map<string, number>());
		this._broadcastFn = null;
		this._livenessFn = null;
	}

	// ── List version / delta broadcast ──────────────────────────────────

	/** Current list version for a parent (0 = nothing broadcast in this process yet). */
	getListVersion(parentNarratorId: string): number {
		return this.listVersions.get(parentNarratorId) ?? 0;
	}

	/** Reset the tracked versions. Test-only — production relies on the epoch. */
	resetListVersionsForTests(): void {
		this.listVersions.clear();
	}

	private bumpListVersion(parentNarratorId: string): number {
		const next = (this.listVersions.get(parentNarratorId) ?? 0) + 1;
		// Re-insert so the map stays insertion-ordered by recency of use, which is
		// what makes the eviction below drop the least recently active parent.
		this.listVersions.delete(parentNarratorId);
		this.listVersions.set(parentNarratorId, next);
		while (this.listVersions.size > MAX_TRACKED_LIST_VERSIONS) {
			const oldest = this.listVersions.keys().next();
			if (oldest.done) break;
			this.listVersions.delete(oldest.value);
		}
		return next;
	}

	/**
	 * Push an incremental list update to the parent's subscribers.
	 *
	 * Every caller goes through here rather than broadcasting directly, so the
	 * version bump and the frame can never disagree: a bumped version whose frame
	 * was dropped would leave every client permanently one behind, and each would
	 * then refetch on every subsequent delta.
	 */
	private async broadcastListDelta(
		parentNarratorId: string,
		delta: Omit<BackgroundTaskListDelta, "listEpoch" | "version" | "activeCount">,
	): Promise<void> {
		const fn = await this.getBroadcastFn();
		if (!fn) return;
		let activeCount = 0;
		try {
			activeCount = await this.countActiveByParent(parentNarratorId);
		} catch (err) {
			logger.warn("Failed to count active background tasks for list delta", {
				parentNarratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		fn(parentNarratorId, {
			type: "background_task_list_delta",
			narratorId: parentNarratorId,
			listEpoch: BACKGROUND_TASK_LIST_EPOCH,
			version: this.bumpListVersion(parentNarratorId),
			activeCount,
			...delta,
		});
	}

	/**
	 * Broadcast the current state of one row. Reads the row back from the DB so
	 * the frame carries exactly what a fresh page would, including the derived
	 * `effectiveStatus` — a delta that disagreed with the paged endpoint would
	 * make the panel flip between two answers depending on which arrived last.
	 */
	private async broadcastTaskUpsert(parentNarratorId: string, taskId: string): Promise<void> {
		try {
			const [item] = await this.listItemsByIds([taskId]);
			if (!item) {
				await this.broadcastListDelta(parentNarratorId, { removeIds: [taskId] });
				return;
			}
			await this.broadcastListDelta(parentNarratorId, { upsert: item });
		} catch (err) {
			logger.warn("Failed to broadcast background task list delta", {
				parentNarratorId,
				taskId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Fire-and-forget wrapper for the synchronous mark* paths. */
	private queueTaskUpsert(parentNarratorId: string, taskId: string): void {
		void this.broadcastTaskUpsert(parentNarratorId, taskId);
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
		// Creation must push a delta: with polling gone, a new task that emits
		// nothing simply never appears in the panel until something else does.
		this.queueTaskUpsert(opts.parentNarratorId, opts.id);
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
				this.queueTaskUpsert(opts.parentNarratorId, opts.id);
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
		this.queueTaskUpsert(opts.parentNarratorId, opts.id);
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

	/**
	 * Bounded team view over BASH tasks, for the `TeamStatus` tool.
	 *
	 * `listSummariesByParents` is unbounded: it returns every row every parent in
	 * the team has ever spawned. That is survivable for the panel (which pages) but
	 * not for a tool whose output goes into the model's context — a long-lived
	 * narrator accumulates tasks continuously, so the listing grew without limit
	 * and eventually dominated the turn it was supposed to inform.
	 *
	 * Shape of the answer, and why:
	 * - Running rows come first and in full (capped). "What is still running" is the
	 *   question the tool exists to answer, and it cannot be expressed as an
	 *   ordering over `createdAt`.
	 * - Terminal rows are included only as a short recent tail. They are context, not
	 *   the answer, and `cleanupCompleted` already deletes them after 30 minutes —
	 *   so the tail is bounded in age as well as in count.
	 * - `omitted` reports what was left out, capped at TEAM_OMITTED_COUNT_CAP. A
	 *   silent cut would let the model conclude the team is idle when it is not.
	 *
	 * `query` searches alias/title/command across ALL rows (running and terminal),
	 * because an explicit search is a request to look past the default window.
	 *
	 * Only bash rows: agent members are listed from `narrators` (a background agent
	 * row and its narrator row are the same entity, and the narrator row is the one
	 * carrying status/title), so returning agent task rows here would double-list
	 * them. This also means no liveness overlay is needed — `continued` /
	 * `child_running` are derived for agent rows only.
	 *
	 * `output` is never read: the tool prints no output text, and the column holds
	 * up to 512 KB per row.
	 */
	async listTeamBashTasks(input: {
		parentNarratorIds: string[];
		/** Max rows returned in total (running + terminal tail). */
		limit: number;
		/** Max terminal rows included when no `query` is given. */
		recentTerminalLimit: number;
		/** Free-text needle over alias / title / command. */
		query?: string;
	}): Promise<{
		tasks: BackgroundTaskSummary[];
		/** Rows matching the filter that were left out. */
		omitted: number;
		/** `omitted` hit TEAM_OMITTED_COUNT_CAP and is a lower bound. */
		omittedCapped: boolean;
	}> {
		const parentIds = [...new Set(input.parentNarratorIds)].filter(Boolean);
		if (parentIds.length === 0) return { tasks: [], omitted: 0, omittedCapped: false };

		const limit = Math.max(1, Math.trunc(input.limit));
		const needle = escapeLikeNeedle(input.query);
		const scope = [
			inArray(backgroundTasks.parentNarratorId, parentIds),
			eq(backgroundTasks.type, "bash"),
		];
		if (needle) {
			const like = `%${needle}%`;
			const match = or(
				sql`${backgroundTasks.alias} LIKE ${like} ESCAPE '\\'`,
				sql`${backgroundTasks.title} LIKE ${like} ESCAPE '\\'`,
				sql`${backgroundTasks.command} LIKE ${like} ESCAPE '\\'`,
			);
			if (match) scope.push(match);
		}

		// The preview column is deliberately replaced by NULL rather than omitted:
		// `reconcileSummaries` spreads whole rows, so the field has to exist.
		const { output: _output, ...columns } = getTableColumns(backgroundTasks);
		const selection = { ...columns, output: sql<string | null>`null` };

		// A search is a request to look past the default window, so it gets the whole
		// budget for terminal rows instead of the short tail.
		const terminalLimit = needle ? limit : Math.max(0, Math.trunc(input.recentTerminalLimit));

		const [runningRows, terminalRows] = await Promise.all([
			db
				.select(selection)
				.from(backgroundTasks)
				.where(and(...scope, eq(backgroundTasks.status, "running")))
				.orderBy(desc(backgroundTasks.createdAt), desc(backgroundTasks.id))
				.limit(limit + 1)
				.all(),
			terminalLimit === 0
				? Promise.resolve([])
				: db
						.select(selection)
						.from(backgroundTasks)
						.where(and(...scope, ne(backgroundTasks.status, "running")))
						.orderBy(desc(backgroundTasks.createdAt), desc(backgroundTasks.id))
						.limit(terminalLimit + 1)
						.all(),
		]);

		// Running rows keep their priority even when they overflow the budget: a
		// truncated running set is still the most useful answer available.
		const shownRunning = runningRows.slice(0, limit);
		const terminalBudget = Math.max(0, limit - shownRunning.length);
		const shownTerminal = terminalRows.slice(0, Math.min(terminalBudget, terminalLimit));
		const rows = [...shownRunning, ...shownTerminal];

		// `offset` counts rows in the scope, not the specific ones shown, so skipping
		// `rows.length` yields the correct remainder even though the shown set
		// reorders running rows ahead of newer terminal ones.
		const omitted = await this.countTeamBashTasks(scope, rows.length);

		return {
			tasks: await this.reconcileSummaries(rows as BackgroundTaskRecord[]),
			omitted: Math.min(omitted, TEAM_OMITTED_COUNT_CAP),
			omittedCapped: omitted > TEAM_OMITTED_COUNT_CAP,
		};
	}

	/**
	 * How many matching rows exist beyond the first `skip`, capped.
	 *
	 * Written as a bounded id scan rather than `COUNT(*)` so a team with thousands
	 * of historical rows cannot turn a tool call into a full-table aggregate — the
	 * caller only needs "and N more", and beyond the cap "500+" is as actionable as
	 * an exact figure.
	 */
	private async countTeamBashTasks(scope: ReturnType<typeof and>[], skip: number): Promise<number> {
		const rows = await db
			.select({ id: backgroundTasks.id })
			.from(backgroundTasks)
			.where(and(...scope))
			.orderBy(desc(backgroundTasks.createdAt), desc(backgroundTasks.id))
			.limit(TEAM_OMITTED_COUNT_CAP + 1)
			.offset(skip)
			.all();
		return rows.length;
	}

	async listSummariesByParent(parentNarratorId: string): Promise<BackgroundTaskSummary[]> {
		return this.listSummariesByParents([parentNarratorId]);
	}

	async listSummariesByParents(parentNarratorIds: string[]): Promise<BackgroundTaskSummary[]> {
		const parentIds = [...new Set(parentNarratorIds)].filter(Boolean);
		if (parentIds.length === 0) return [];
		return this.reconcileSummaries(await this.listByParents(parentIds));
	}

	/**
	 * Reconcile persisted task rows against current narrator state.
	 *
	 * Split out of `listSummariesByParents` so the paged endpoint, the delta
	 * broadcaster and `TeamStatus` all derive `effectiveStatus` the same way. When
	 * these diverged, a delta could report `completed` for a row the paged endpoint
	 * called `continued`, and which one the panel showed depended on arrival order.
	 */
	private async reconcileSummaries(
		tasks: BackgroundTaskRecord[],
	): Promise<BackgroundTaskSummary[]> {
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

	// ── Paged list surface ──────────────────────────────────────────────

	/**
	 * In-process liveness that the DB cannot see: a subagent whose agent loop is
	 * running right now reads as terminal in `background_tasks` (and `narrators`
	 * status can lag behind reality), so a purely persisted reconcile reports it as
	 * finished.
	 *
	 * This lives in the service rather than in the route because `activeCount`,
	 * `activeTasks`, the paged rows and the delta upserts must all agree. While the
	 * route applied it alone, a row could render as `continued` while the badge next
	 * to it said 0, and a delta could hand the client a `completed` row for a
	 * subagent the page had just called active.
	 *
	 * Lazily imported and cached like `getBroadcastFn`: narrator-session imports
	 * this service, so a static import would close a cycle.
	 */
	private async getLivenessFn(): Promise<((narratorId: string) => boolean) | null> {
		if (this._livenessFn) return this._livenessFn;
		try {
			const { isNarratorActive, isLoopRunning } = await import("./narrator-session");
			this._livenessFn = (narratorId: string) =>
				isNarratorActive(narratorId) || isLoopRunning(narratorId);
			return this._livenessFn;
		} catch {
			return null;
		}
	}

	/** Overlay in-process liveness onto reconciled rows. */
	private async applyLiveness(items: BackgroundTaskListItem[]): Promise<BackgroundTaskListItem[]> {
		if (items.length === 0) return items;
		const isLive = await this.getLivenessFn();
		if (!isLive) return items;
		return items.map((item) => {
			if (item.type !== "agent") return item;
			if (!isLive(item.subagentNarratorId ?? item.id)) return item;
			return {
				...item,
				effectiveStatus: item.status === "running" ? "running" : "continued",
				currentNarratorStatus: "working",
				canCancelActiveWork: true,
			};
		});
	}

	private toListItem(summary: BackgroundTaskSummary): BackgroundTaskListItem {
		const preview = toListPreview(summary.output);
		return {
			id: summary.id,
			type: summary.type,
			status: summary.status,
			effectiveStatus: summary.effectiveStatus,
			currentNarratorStatus: summary.currentNarratorStatus,
			activeChildTaskCount: summary.activeChildTaskCount,
			canCancelActiveWork: summary.canCancelActiveWork,
			command: summary.command,
			exitCode: summary.exitCode,
			toolUseId: summary.toolUseId,
			subagentNarratorId: summary.subagentNarratorId,
			subagentType: summary.subagentType,
			alias: summary.alias,
			title: summary.title,
			output: preview.preview,
			outputBytes: summary.outputBytes,
			outputTruncated: summary.outputTruncated,
			outputPreviewTruncated: preview.truncated,
			startedAt: summary.startedAt,
			completedAt: summary.completedAt,
			createdAt: summary.createdAt,
			legacy: false,
		};
	}

	/**
	 * Fetch specific rows as list items (used by the delta broadcaster).
	 * Bounded by the caller; never called with an unbounded id set.
	 */
	private async listItemsByIds(taskIds: string[]): Promise<BackgroundTaskListItem[]> {
		const ids = [...new Set(taskIds)].filter(Boolean);
		if (ids.length === 0) return [];
		const { output: _output, ...columns } = getTableColumns(backgroundTasks);
		const rows = await db
			.select({
				...columns,
				output: sql<
					string | null
				>`substr(${backgroundTasks.output}, 1, ${LIST_OUTPUT_PREVIEW_CHARS + 1})`,
			})
			.from(backgroundTasks)
			.where(inArray(backgroundTasks.id, ids))
			.all();
		const summaries = await this.reconcileSummaries(rows);
		return this.applyLiveness(summaries.map((summary) => this.toListItem(summary)));
	}

	/**
	 * Legacy background rows: subagents recorded before the unified table existed.
	 *
	 * `backgroundResult` is read through `substr` for the same reason `output` is —
	 * this path used to return the whole column, and a single parent's history came
	 * to ~600 KB of long-finished results that the panel re-fetched every few
	 * seconds.
	 *
	 * Rows that ALSO have a unified task row are excluded. This is not only about
	 * old data: every background subagent alive today writes both
	 * (`narrators.is_background = 1` in subagent-runner/subagent-detach, then
	 * `createAgentTask` with the same id), so without this the current path yields
	 * each running subagent twice — double-counting `activeCount`, halving the
	 * effective page size, and letting the legacy projection (no alias, no
	 * toolUseId, no child count, no cancel affordance) win the client-side dedupe
	 * whenever the narrator row happens to sort first.
	 */
	private async listLegacyRows(
		parentNarratorId: string,
		opts: {
			cursor?: BackgroundTaskListCursor;
			limit: number;
			activeOnly?: boolean;
			/** Skip the preview column entirely; for count-only callers. */
			omitOutput?: boolean;
		},
	): Promise<BackgroundTaskListItem[]> {
		const conditions = [
			eq(narrators.parentNarratorId, parentNarratorId),
			eq(narrators.isBackground, true),
			notExists(
				db
					.select({ one: sql`1` })
					.from(backgroundTasks)
					.where(eq(backgroundTasks.id, narrators.id)),
			),
		];
		if (opts.activeOnly) conditions.push(eq(narrators.backgroundStatus, "running"));
		const cursorCondition = opts.cursor
			? listCursorCondition(opts.cursor, narrators.createdAt, narrators.id)
			: undefined;
		const rows = await db
			.select({
				id: narrators.id,
				subagentType: narrators.subagentType,
				backgroundStatus: narrators.backgroundStatus,
				backgroundResult: opts.omitOutput
					? sql<string | null>`null`
					: sql<
							string | null
						>`substr(${narrators.backgroundResult}, 1, ${LIST_OUTPUT_PREVIEW_CHARS + 1})`,
				backgroundResultChars: sql<number>`coalesce(length(${narrators.backgroundResult}), 0)`,
				backgroundCompletedAt: narrators.backgroundCompletedAt,
				status: narrators.status,
				createdAt: narrators.createdAt,
				title: narrators.title,
			})
			.from(narrators)
			.where(cursorCondition ? and(...conditions, cursorCondition) : and(...conditions))
			.orderBy(desc(narrators.createdAt), desc(narrators.id))
			.limit(opts.limit)
			.all();

		return rows.map((row) => {
			const status = row.backgroundStatus ?? row.status;
			const chars = Number(row.backgroundResultChars) || 0;
			const preview = toListPreview(row.backgroundResult);
			return {
				id: row.id,
				type: "agent" as const,
				status,
				effectiveStatus: status,
				currentNarratorStatus: row.status,
				activeChildTaskCount: 0,
				canCancelActiveWork: status === "running",
				command: null,
				exitCode: null,
				toolUseId: null,
				subagentNarratorId: row.id,
				subagentType: row.subagentType,
				alias: null,
				title: row.title,
				output: preview.preview,
				outputBytes: chars,
				// The legacy path stores whatever the subagent returned, uncapped — so
				// nothing was lost at write time, only at preview time.
				outputTruncated: false,
				outputPreviewTruncated: preview.truncated,
				startedAt: row.createdAt,
				completedAt: row.backgroundCompletedAt,
				createdAt: row.createdAt,
				legacy: true,
			};
		});
	}

	private async listUnifiedItems(
		parentNarratorId: string,
		opts: { cursor?: BackgroundTaskListCursor; limit: number; activeOnly?: boolean },
	): Promise<BackgroundTaskListItem[]> {
		const conditions = [eq(backgroundTasks.parentNarratorId, parentNarratorId)];
		if (opts.activeOnly) conditions.push(eq(backgroundTasks.status, "running"));
		const cursorCondition = opts.cursor
			? listCursorCondition(opts.cursor, backgroundTasks.createdAt, backgroundTasks.id)
			: undefined;
		const { output: _output, ...columns } = getTableColumns(backgroundTasks);
		const rows = await db
			.select({
				...columns,
				output: sql<
					string | null
				>`substr(${backgroundTasks.output}, 1, ${LIST_OUTPUT_PREVIEW_CHARS + 1})`,
			})
			.from(backgroundTasks)
			.where(cursorCondition ? and(...conditions, cursorCondition) : and(...conditions))
			.orderBy(desc(backgroundTasks.createdAt), desc(backgroundTasks.id))
			.limit(opts.limit)
			.all();
		const summaries = await this.reconcileSummaries(rows);
		return this.applyLiveness(summaries.map((summary) => this.toListItem(summary)));
	}

	/**
	 * Count tasks still doing work.
	 *
	 * Deliberately NOT `count(*) where status='running'`: a terminal row whose
	 * subagent was resumed in the foreground reads as `continued`, and a finished
	 * row whose subagent still has children running reads as `child_running`. Both
	 * are exactly what the panel badge exists to surface, and both are invisible to
	 * the raw status column. The candidate set is bounded by the active limit, so
	 * this never degrades into a full-table reconcile.
	 *
	 * `omitOutput` because this runs on EVERY delta broadcast: reading the preview
	 * column here would materialize up to 200 × 4 KB of strings on the main thread
	 * per frame only to return their count.
	 */
	async countActiveByParent(parentNarratorId: string): Promise<number> {
		const active = await this.listActiveItems(parentNarratorId, { omitOutput: true });
		return active.items.length;
	}

	/**
	 * The active set: every row whose reconciled status is still doing work.
	 *
	 * Candidates are the `running` rows plus all agent rows (only agent rows can
	 * derive `continued`/`child_running`), capped at the active limit + 1 so the
	 * caller can report truncation instead of silently under-counting.
	 *
	 * With `omitOutput` the rows come back without any preview text — valid only
	 * for callers that just count them, never for the ones that serve `activeTasks`.
	 */
	private async listActiveItems(
		parentNarratorId: string,
		opts?: { omitOutput?: boolean },
	): Promise<{ items: BackgroundTaskListItem[]; truncated: boolean }> {
		const limit = BACKGROUND_TASK_ACTIVE_LIMIT + 1;
		const { output: _output, ...columns } = getTableColumns(backgroundTasks);
		const [candidateRows, legacyActive] = await Promise.all([
			db
				.select({
					...columns,
					output: opts?.omitOutput
						? sql<string | null>`null`
						: sql<
								string | null
							>`substr(${backgroundTasks.output}, 1, ${LIST_OUTPUT_PREVIEW_CHARS + 1})`,
				})
				.from(backgroundTasks)
				.where(
					and(
						eq(backgroundTasks.parentNarratorId, parentNarratorId),
						or(eq(backgroundTasks.status, "running"), eq(backgroundTasks.type, "agent")),
					),
				)
				.orderBy(desc(backgroundTasks.createdAt), desc(backgroundTasks.id))
				.limit(limit)
				.all(),
			this.listLegacyRows(parentNarratorId, {
				limit,
				activeOnly: true,
				omitOutput: opts?.omitOutput,
			}),
		]);
		const summaries = await this.reconcileSummaries(candidateRows);
		// Liveness BEFORE the filter: a terminal row whose loop is running again is
		// exactly the `continued` case the active set exists to surface, and filtering
		// on the persisted status first would drop it.
		const unifiedActive = await this.applyLiveness(
			summaries.map((summary) => this.toListItem(summary)),
		);
		const items = unifiedActive
			.filter((item) => isBackgroundTaskActiveStatus(item.effectiveStatus))
			.concat(legacyActive.filter((item) => isBackgroundTaskActiveStatus(item.effectiveStatus)))
			.sort(compareBackgroundTaskListItemsDesc);
		const truncated = items.length > BACKGROUND_TASK_ACTIVE_LIMIT;
		return {
			items: truncated ? items.slice(0, BACKGROUND_TASK_ACTIVE_LIMIT) : items,
			truncated,
		};
	}

	/**
	 * One cursor page of a parent's task list, newest first.
	 *
	 * Unified and legacy rows are two descending streams merged under one
	 * comparator, so a single `(createdAt, id)` cursor addresses both — a
	 * per-source cursor pair would have to be threaded through the client for no
	 * added precision.
	 *
	 * The version is read AFTER the rows so a delta that lands mid-query cannot be
	 * reported as already included: a client that refetches once too often is
	 * correct, one that skips a delta is not.
	 */
	async listPageByParent(
		parentNarratorId: string,
		opts?: { cursor?: string; limit?: number },
	): Promise<BackgroundTaskListPage> {
		const limit = clampListLimit(opts?.limit);
		const cursor = decodeBackgroundTaskListCursor(opts?.cursor);
		const isFirstPage = !cursor;

		// limit + 1 on each stream: the merge may take all of its rows from one
		// side, so both must be able to supply a full page plus the lookahead that
		// decides `nextCursor`.
		const [unified, legacy, active] = await Promise.all([
			this.listUnifiedItems(parentNarratorId, { cursor, limit: limit + 1 }),
			this.listLegacyRows(parentNarratorId, { cursor, limit: limit + 1 }),
			isFirstPage
				? this.listActiveItems(parentNarratorId)
				: Promise.resolve({ items: [] as BackgroundTaskListItem[], truncated: false }),
		]);

		const merged = [...unified, ...legacy].sort(compareBackgroundTaskListItemsDesc);
		const hasMore = merged.length > limit;
		const tasks = hasMore ? merged.slice(0, limit) : merged;
		const last = tasks.at(-1);

		return {
			listEpoch: BACKGROUND_TASK_LIST_EPOCH,
			version: this.getListVersion(parentNarratorId),
			activeCount: isFirstPage
				? active.items.length
				: await this.countActiveByParent(parentNarratorId),
			...(isFirstPage ? { activeTasks: active.items, activeTruncated: active.truncated } : {}),
			tasks,
			nextCursor:
				hasMore && last
					? encodeBackgroundTaskListCursor({ createdAt: last.createdAt, id: last.id })
					: null,
		};
	}

	/**
	 * Resolve an `Await({type:"agent"})` target (task id, alias, or subagent id) to
	 * the subagent narrator id.
	 *
	 * Exists so a tool card does not have to fetch the whole task list to learn one
	 * id — that lookup was the second polling source on this surface.
	 */
	async resolveSubagentNarratorId(
		parentNarratorId: string,
		target: string,
	): Promise<string | null> {
		if (!target) return null;
		const row = await db
			.select({ id: backgroundTasks.id, subagentNarratorId: backgroundTasks.subagentNarratorId })
			.from(backgroundTasks)
			.where(
				and(
					eq(backgroundTasks.parentNarratorId, parentNarratorId),
					eq(backgroundTasks.type, "agent"),
					or(
						eq(backgroundTasks.id, target),
						eq(backgroundTasks.alias, target),
						eq(backgroundTasks.subagentNarratorId, target),
					),
				),
			)
			.orderBy(desc(backgroundTasks.createdAt))
			.get();
		if (row) return row.subagentNarratorId ?? row.id;

		// Legacy path: the subagent narrator itself carries the background marker.
		const legacy = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(
				and(
					eq(narrators.parentNarratorId, parentNarratorId),
					eq(narrators.isBackground, true),
					eq(narrators.id, target),
				),
			)
			.get();
		return legacy?.id ?? null;
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
		const [updated] = await db
			.update(backgroundTasks)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.status, "running")))
			.returning({ parentNarratorId: backgroundTasks.parentNarratorId });
		this.cleanupRuntime(taskId, expectedAbortController);
		// No cancellation frame here (takeover is not a cancellation the user asked
		// for), but the LIST still changed: the row left `running`. Without this the
		// panel keeps showing a running task the user is now driving by hand.
		if (updated) this.queueTaskUpsert(updated.parentNarratorId, taskId);
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
		const [updated] = await db
			.update(backgroundTasks)
			.set({
				status: hasError ? "failed" : "completed",
				output: storedOutput,
				outputBytes,
				outputTruncated: truncated,
				completedAt: now,
				updatedAt: now,
			})
			.where(eq(backgroundTasks.id, taskId))
			.returning({ parentNarratorId: backgroundTasks.parentNarratorId });
		this.cleanupRuntime(taskId);
		if (updated) this.queueTaskUpsert(updated.parentNarratorId, taskId);
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

	/**
	 * Cancel background task rows whose in-memory executor was lost in an unclean
	 * restart.
	 *
	 * ## Why BOTH types, and why bash used to leak
	 *
	 * A `running` row only means something while the process/executor that owns it is
	 * alive in THIS process: the row is the durable half, the executor is the half that
	 * actually reports the terminal state. An unclean exit destroys the second half and
	 * leaves the first, so every surviving `running` row is a lie that nothing else will
	 * ever correct.
	 *
	 * This used to filter `type = "agent"`, which left `type = "bash"` rows pinned at
	 * `running` forever: the child process is gone, so no `markCompleted` will ever fire;
	 * `Await` waits out its full timeout on an event that cannot arrive; and
	 * `cleanupCompleted`'s `ne(status, "running")` refuses to reap them, so they
	 * accumulate for the lifetime of the database. (`killAll` only runs on the graceful
	 * shutdown path, which is exactly the path that does NOT leave stale rows.)
	 *
	 * Bash rows are unconditionally stale, never protected: `narrator_tool_continuations`
	 * has no `background_bash` kind, so a background command has no resume path — nothing
	 * can re-adopt a dead child process. Only agent rows can appear in
	 * `protectedTaskIds` (from `background_agent` continuations), because a subagent CAN
	 * be resumed from persisted state.
	 *
	 * ## Why this cancels rather than delivering a completion
	 *
	 * A restart is an environment event, not a result the model asked for, so this
	 * deliberately does NOT push an injection — it mirrors `markCancelled`, which also
	 * only emits and broadcasts. The row reaching a terminal state is what unblocks
	 * `Await` (via the `cancelled` event) and what makes the row reapable; the parent's
	 * timeline is not owed a bubble for a server bounce.
	 */
	async recoverStaleTasksAfterRestart(
		protectedTaskIds: ReadonlySet<string> = new Set(),
	): Promise<number> {
		const staleTasks = (
			await db
				.select({
					id: backgroundTasks.id,
					type: backgroundTasks.type,
					parentNarratorId: backgroundTasks.parentNarratorId,
					subagentNarratorId: backgroundTasks.subagentNarratorId,
				})
				.from(backgroundTasks)
				.where(eq(backgroundTasks.status, "running"))
				.all()
		)
			// Only an agent row can be protected — see the note above on why a bash row
			// has no resume path to protect.
			.filter((task) => task.type === "bash" || !protectedTaskIds.has(task.id));
		if (staleTasks.length === 0) return 0;

		const now = new Date().toISOString();
		const taskIds = staleTasks.map((task) => task.id);
		await db
			.update(backgroundTasks)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(and(inArray(backgroundTasks.id, taskIds), eq(backgroundTasks.status, "running")));

		// Only agent tasks carry a subagent narrator whose background fields describe the
		// run; a bash task has no narrator row of its own to reset.
		const narratorIds = [
			...new Set(
				staleTasks
					.filter((task) => task.type === "agent")
					.map((task) => task.subagentNarratorId ?? task.id),
			),
		];
		if (narratorIds.length > 0) {
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
		}

		for (const task of staleTasks) {
			this.cleanupRuntime(task.id);
			eventBus.emit({
				type: "background_task:cancelled",
				taskId: task.id,
				parentNarratorId: task.parentNarratorId,
				taskType: task.type,
			});
		}
		// One invalidate per parent rather than per-row upserts: recovery rewrites a
		// whole cohort at once, and the clients that care were disconnected across
		// the restart anyway (their epoch already differs).
		for (const parentNarratorId of new Set(staleTasks.map((task) => task.parentNarratorId))) {
			void this.broadcastListDelta(parentNarratorId, { invalidate: true }).catch(() => {});
		}
		let bashCount = 0;
		for (const task of staleTasks) if (task.type === "bash") bashCount++;
		logger.info("Recovered stale background tasks after restart", {
			count: staleTasks.length,
			bash: bashCount,
			agent: staleTasks.length - bashCount,
		});
		return staleTasks.length;
	}

	/**
	 * @deprecated Use {@link recoverStaleTasksAfterRestart}, which also reaps stale
	 * `bash` rows. Kept as a thin alias so an out-of-tree caller does not silently lose
	 * the agent cleanup it already depends on.
	 */
	async recoverStaleAgentTasksAfterRestart(
		protectedTaskIds: ReadonlySet<string> = new Set(),
	): Promise<number> {
		return this.recoverStaleTasksAfterRestart(protectedTaskIds);
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
			.select({ id: backgroundTasks.id, parentNarratorId: backgroundTasks.parentNarratorId })
			.from(backgroundTasks)
			.where(and(ne(backgroundTasks.status, "running"), lt(backgroundTasks.completedAt, cutoff)))
			.all();
		const deletable = rows.filter((row) => !this.activeAgentContinuations.has(row.id));

		if (deletable.length === 0) return 0;

		const deletableIds = deletable.map((row) => row.id);
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

		// Tell each affected parent's subscribers which rows disappeared. A reap the
		// client never hears about leaves rows in the panel that no longer exist and
		// whose cancel/output actions now 404.
		const byParent = new Map<string, string[]>();
		for (const row of deletable) {
			const ids = byParent.get(row.parentNarratorId);
			if (ids) ids.push(row.id);
			else byParent.set(row.parentNarratorId, [row.id]);
		}
		for (const [parentNarratorId, ids] of byParent) {
			void this.broadcastListDelta(
				parentNarratorId,
				ids.length > BACKGROUND_TASK_DELTA_MAX_REMOVE_IDS
					? { invalidate: true }
					: { removeIds: ids },
			).catch(() => {});
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
		this.queueTaskUpsert(parentNarratorId, taskId);
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
		// The list delta is what keeps the task panel current now that it no longer
		// polls; the frames below drive the message-stream tool card, which is a
		// separate consumer with a separate shape.
		this.queueTaskUpsert(parentNarratorId, taskId);
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
