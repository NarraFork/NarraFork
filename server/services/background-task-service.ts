import {
	BACKGROUND_TASK_ACTIVE_LIMIT,
	BACKGROUND_TASK_DELTA_MAX_REMOVE_IDS,
	BACKGROUND_TASK_LIST_MAX_PAGE_SIZE,
	BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS,
	BACKGROUND_TASK_LIST_PAGE_SIZE,
	type BackgroundTaskActiveCounts,
	type BackgroundTaskKind,
	type BackgroundTaskListDelta,
	type BackgroundTaskListItem,
	type BackgroundTaskListPage,
	type BackgroundTaskType,
	compareBackgroundTaskListItemsDesc,
	isBackgroundTaskActiveStatus,
} from "@shared/background-task-list";
import type { ToolProgressPayload } from "@shared/tool-progress";
import {
	and,
	asc,
	type Column,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	like,
	lt,
	lte,
	ne,
	notExists,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import { backgroundTasks, deviceTransferTasks, narrators, narratorToolCalls } from "../db/schema";
import { BASH_TOOL_NAME } from "../lib/agent/tool-name";
import type { ToolCallBinding, ToolExecutionTarget } from "../lib/agent/types";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { escapeLikeNeedle } from "../lib/sql-like";
import type { RuntimeTx } from "./agent-runtime/mailbox-types";
import {
	getRuntimePublicationService,
	type PublicationEvent,
	type PublicationRun,
	publicationEvent,
	runtimePublication,
	taskPublicationRun,
} from "./agent-runtime/publication";
import { resolveRuntimeQueueBackend } from "./agent-runtime/runtime-queue-port";
import { runAtomicWrite } from "./agent-runtime/runtime-write";
import { discardBackgroundBashResult, prepareBackgroundBashResult } from "./background-bash-result";
import { TRANSFER_RESTART_PAUSE_NOTICE } from "./device-transfer-task-store";

// === Types ===

export type BackgroundTaskRecord = typeof backgroundTasks.$inferSelect;

export type BackgroundTaskEffectiveStatus =
	| BackgroundTaskRecord["status"]
	| "continued"
	| "child_running"
	| "taken_over";

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
	if (parseSubstatus(input.currentNarratorSubstatus).includes("taken_over")) return "taken_over";
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
	terminalResultReceived?: boolean;
	publicationRun?: PublicationRun;
	sourceResultRef?: string;
}

/** Derive the receipt from the SAME row that supplied the terminal output. */
function terminalWaitReceipt(task: {
	id: string;
	type: string;
	parentNarratorId: string;
	logicalRunId: string | null;
}): Pick<WaitResult, "terminalResultReceived" | "publicationRun"> {
	return {
		terminalResultReceived: true,
		...(task.logicalRunId && task.type !== "transfer"
			? { publicationRun: taskPublicationRun(task) }
			: {}),
	};
}

export interface CompletedNotification {
	id: string;
	type: BackgroundTaskType;
	title: string | null;
	alias: string | null;
	status: string;
	outputPreview: string;
	/** Initiating user of the completed execution, never inferred from its parent. */
	userId?: string | null;
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

/**
 * Whether a row's own status means there is still work a cancel could stop.
 *
 * `paused` is included: the owning `device_transfer_tasks` row accepts `cancel`
 * from `paused` (it discards the resume checkpoint), so reporting a paused
 * transfer as uncancellable would hide an action the backend supports and leave
 * the user with a stuck card and no way to discard it.
 */
function isCancellableTaskStatus(status: string): boolean {
	return status === "running" || status === "paused";
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
		runtimePublication.setLegacyRuntimeAdmissionReader("bash", (source) => {
			if (!this.abortControllers.has(source.taskId) && !this.killHandlers.has(source.taskId))
				return undefined;
			const task = db
				.select({
					parentNarratorId: backgroundTasks.parentNarratorId,
					startedAt: backgroundTasks.startedAt,
				})
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, source.taskId))
				.get();
			if (!task || task.parentNarratorId !== source.recipientId) return undefined;
			return { ...source, startedAtMs: Date.parse(task.startedAt) };
		});
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

	/**
	 * Install a broadcast sink directly. Test-only.
	 *
	 * `getBroadcastFn` lazily imports `narrator-ws` and CACHES the result, so with
	 * `mock.module` the first resolution wins for the whole process — two test files
	 * mocking that module observe each other's sink depending on execution order.
	 * Injecting here removes the ordering dependency. Pass null to restore the
	 * lazy-import behaviour.
	 */
	setBroadcastFnForTests(
		fn:
			| ((id: string, msg: import("../websocket/narrator-ws-types").NarratorServerMessage) => void)
			| null,
	): void {
		this._broadcastFn = fn;
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
		refreshAncestors = true,
	): Promise<void> {
		const fn = await this.getBroadcastFn();
		if (!fn) return;
		let counts: BackgroundTaskActiveCounts;
		try {
			counts = await this.countActiveKindsByParent(parentNarratorId);
		} catch (err) {
			logger.warn("Failed to count active background tasks for list delta", {
				parentNarratorId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Unknown is not zero: preserve the last known occupancy and version.
			return;
		}
		fn(parentNarratorId, {
			type: "background_task_list_delta",
			narratorId: parentNarratorId,
			listEpoch: BACKGROUND_TASK_LIST_EPOCH,
			version: this.bumpListVersion(parentNarratorId),
			...counts,
			...delta,
		});
		// Separate tiny frame for count-only consumers (sidebar badges, narrator
		// list): they filter by message type client-side and should not have to
		// parse full delta payloads. Same delivery scope as the delta itself.
		fn(parentNarratorId, {
			type: "background_task_count_changed",
			narratorId: parentNarratorId,
			activeBackgroundTaskCount: counts.activeCount,
			activeBackgroundWorkCount: counts.activeWorkCount,
			activeBackgroundServiceCount: counts.activeServiceCount,
		});
		if (refreshAncestors) await this.refreshAncestorTaskLists(parentNarratorId);
	}

	/** Child work can change an idle ancestor's agent projection to child_running. */
	private async refreshAncestorTaskLists(narratorId: string): Promise<void> {
		const visited = new Set<string>();
		// Bound corrupt/cyclic ancestry as well as legitimate deeply nested teams.
		for (let depth = 0; depth < 32 && !visited.has(narratorId); depth++) {
			visited.add(narratorId);
			const narrator = await db
				.select({ parentNarratorId: narrators.parentNarratorId, type: narrators.type })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get();
			const parentId = narrator?.parentNarratorId;
			if (narrator?.type !== "subagent" || !parentId || visited.has(parentId)) return;
			// Unified projections may have a task id different from the narrator id;
			// legacy subagents use their narrator id as the list row id.
			const projection = await db
				.select({ id: backgroundTasks.id })
				.from(backgroundTasks)
				.where(
					and(
						eq(backgroundTasks.parentNarratorId, parentId),
						eq(backgroundTasks.type, "agent"),
						eq(backgroundTasks.subagentNarratorId, narratorId),
					),
				)
				.limit(1)
				.get();
			await this.broadcastTaskUpsert(parentId, projection?.id ?? narratorId, false);
			narratorId = parentId;
		}
	}

	/**
	 * Broadcast the current state of one row. Reads the row back from the DB so
	 * the frame carries exactly what a fresh page would, including the derived
	 * `effectiveStatus` — a delta that disagreed with the paged endpoint would
	 * make the panel flip between two answers depending on which arrived last.
	 */
	private async broadcastTaskUpsert(
		parentNarratorId: string,
		taskId: string,
		refreshAncestors = true,
	): Promise<void> {
		try {
			// Callers may supply either the task id or its subagent narrator id.
			// Prefer a direct task match, and keep both lookups in the requested parent.
			let [unified] = await this.listItemsByIds(parentNarratorId, [taskId]);
			if (!unified) {
				const projection = await db
					.select({ id: backgroundTasks.id })
					.from(backgroundTasks)
					.where(
						and(
							eq(backgroundTasks.parentNarratorId, parentNarratorId),
							eq(backgroundTasks.type, "agent"),
							eq(backgroundTasks.subagentNarratorId, taskId),
						),
					)
					.limit(1)
					.get();
				if (projection) {
					[unified] = await this.listItemsByIds(parentNarratorId, [projection.id]);
				}
			}
			const item =
				unified ?? (await this.listLegacyRows(parentNarratorId, { ids: [taskId], limit: 1 }))[0];
			if (!item) {
				await this.broadcastListDelta(parentNarratorId, { removeIds: [taskId] }, refreshAncestors);
				return;
			}
			await this.broadcastListDelta(parentNarratorId, { upsert: item }, refreshAncestors);
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

	/**
	 * Push live byte progress for a transfer's projection row.
	 *
	 * Bypasses `broadcastListDelta` deliberately — see BackgroundTaskProgressFrame.
	 * Two costs are avoided: bumping the ordered version (where a dropped frame
	 * forces a full page refetch) and the `countActiveByParent` query that every
	 * delta performs. At ~2 frames/s per active transfer both would be paid
	 * continuously for a value that is self-correcting.
	 *
	 * Silently does nothing when no projection exists (an admin transfer from the
	 * devices page), which is the same no-op the rest of this path takes.
	 */
	async broadcastTransferProgress(
		transferTaskId: string,
		progress: ToolProgressPayload,
	): Promise<void> {
		const row = await this.getByTransferTaskId(transferTaskId);
		if (!row) return;
		const fn = await this.getBroadcastFn();
		if (!fn) return;
		fn(row.parentNarratorId, {
			type: "background_task_progress",
			narratorId: row.parentNarratorId,
			listEpoch: BACKGROUND_TASK_LIST_EPOCH,
			taskId: row.id,
			progress,
		});
	}

	/**
	 * Push a delta for a row whose STORED state did not change, but whose derived
	 * `effectiveStatus` did.
	 *
	 * `continued` and `child_running` are computed from narrator/runtime state, not
	 * from the task row, so a subagent resumed by hand produces no write here and
	 * therefore no delta. The list is purely delta-driven (there is deliberately no
	 * poll left to paper over a missing frame), so without this the panel keeps
	 * rendering the row's last stored status — a taken-over task reads "cancelled"
	 * for the entire manual continuation.
	 *
	 * Accepts a task id or subagent narrator id; the broadcaster resolves the latter
	 * to its agent projection within this parent before publishing the row.
	 *
	 * Exposed rather than left private because the caller that knows a continuation
	 * started/ended is the subagent runner, and the alternative (having the runner
	 * touch the row just to trigger a broadcast) would overwrite the terminal
	 * version guard `finalizeResumedAgentTask` relies on.
	 */
	notifyDerivedStatusChanged(parentNarratorId: string, taskId: string): void {
		this.queueTaskUpsert(parentNarratorId, taskId);
	}

	// ── Create ──────────────────────────────────────────────────────────

	/**
	 * Validate a background bash binding against `narratorToolCalls`. Shared by
	 * the SQLite transaction path and the PG pre-flight path.
	 */
	private validateBashBinding(
		opts: {
			parentNarratorId: string;
			toolUseId?: string;
			executionTarget?: ToolExecutionTarget;
		},
		binding: ToolCallBinding,
	): void {
		const source = db
			.select({
				narratorId: narratorToolCalls.narratorId,
				toolName: narratorToolCalls.toolName,
				toolUseId: narratorToolCalls.toolUseId,
				status: narratorToolCalls.status,
				executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
				executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
				isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
				executionAttempt: narratorToolCalls.executionAttempt,
				executionStartedAt: narratorToolCalls.executionStartedAt,
				executionDeviceId: narratorToolCalls.executionDeviceId,
				executionCwd: narratorToolCalls.executionCwd,
				executionPathFlavor: narratorToolCalls.executionPathFlavor,
				runtimeGeneration: narratorToolCalls.runtimeGeneration,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, binding.toolCallId))
			.limit(1)
			.get();
		if (
			!source ||
			source.narratorId !== opts.parentNarratorId ||
			source.toolName !== BASH_TOOL_NAME ||
			source.executionIdentityVersion !== 1 ||
			source.executionOriginToolCallId !== null ||
			source.isFileHistoryCheckpoint ||
			source.status !== "running" ||
			!source.executionStartedAt ||
			source.executionAttempt !== binding.attempt ||
			(opts.toolUseId !== undefined && source.toolUseId !== opts.toolUseId)
		) {
			throw new ValidationError("Background Bash binding is not an actual running attempt");
		}
		const target = opts.executionTarget;
		if (
			target &&
			(source.executionDeviceId !== target.deviceId ||
				source.executionCwd !== target.cwd ||
				source.executionPathFlavor !== (target.pathFlavor ?? null) ||
				source.runtimeGeneration !== (target.runtimeGeneration ?? null) ||
				target.backendKind !== (target.deviceId === "local" ? "local" : "remote"))
		) {
			throw new ValidationError("Background Bash execution target does not match its binding");
		}
	}

	async createBashTask(opts: {
		id: string;
		parentNarratorId: string;
		command: string;
		backgroundKind?: BackgroundTaskKind;
		toolUseId?: string;
		/** Exact, already-claimed execution. Omitted by legacy/direct callers. */
		toolCallBinding?: ToolCallBinding;
		executionTarget?: ToolExecutionTarget;
		alias?: string;
		title?: string;
	}): Promise<BackgroundTaskRecord> {
		const binding = opts.toolCallBinding;
		if (
			binding !== undefined &&
			(typeof binding?.toolCallId !== "string" ||
				!binding.toolCallId ||
				!Number.isSafeInteger(binding.attempt) ||
				binding.attempt <= 0)
		) {
			throw new ValidationError("Invalid background Bash execution binding");
		}
		const now = new Date().toISOString();

		// PG path: async facade atomically creates task row + reserves publication slots.
		if (resolveRuntimeQueueBackend() === "postgres") {
			if (binding) this.validateBashBinding(opts, binding);
			const taskRow: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId"> = {
				id: opts.id,
				parentNarratorId: opts.parentNarratorId,
				type: "bash",
				backgroundKind: opts.backgroundKind ?? "task",
				status: "running",
				command: opts.command,
				toolUseId: opts.toolUseId ?? null,
				toolCallId: binding?.toolCallId ?? null,
				executionAttempt: binding?.attempt ?? null,
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
			const pub = getRuntimePublicationService();
			const run = await pub.startBashRun({
				taskId: opts.id,
				recipientId: opts.parentNarratorId,
				taskRow,
			});
			void run; // logicalRunId now persisted by the PG composite
			this.outputChunks.set(opts.id, []);
			this.parentNarratorCache.set(opts.id, opts.parentNarratorId);
			this.queueTaskUpsert(opts.parentNarratorId, opts.id);
			this.maybeCleanup();
			return taskRow as BackgroundTaskRecord;
		}

		// SQLite path: existing synchronous transaction.
		const publicationRun = runtimePublication.newBashRun(opts.id, opts.parentNarratorId);
		const row: typeof backgroundTasks.$inferInsert = {
			id: opts.id,
			logicalRunId: publicationRun.logicalRunId,
			parentNarratorId: opts.parentNarratorId,
			type: "bash",
			backgroundKind: opts.backgroundKind ?? "task",
			status: "running",
			command: opts.command,
			toolUseId: opts.toolUseId ?? null,
			// No binding means no v2 execution evidence. Never infer an attempt from
			// a provider id: it can be reused across messages and narrators.
			toolCallId: binding?.toolCallId ?? null,
			executionAttempt: binding?.attempt ?? null,
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
		// A short synchronous transaction keeps validation and insertion together.
		// This records provenance only: it cannot claim/replay a call, prove the
		// process exited, or authorize writes after cancellation/restart.
		runAtomicWrite(db, "background-task.create", (tx) => {
			runtimePublication.reserve(publicationRun, tx);
			if (binding) this.validateBashBinding(opts, binding);
			const inserted = tx
				.insert(backgroundTasks)
				.values(row)
				.onConflictDoNothing({
					target: [backgroundTasks.toolCallId, backgroundTasks.executionAttempt],
				})
				.returning({ id: backgroundTasks.id })
				.get();
			// Returning an existing task would still let the caller spawn a second
			// process. The unique actual-attempt constraint must instead fail closed.
			if (!inserted) {
				throw new ValidationError("Background Bash task already exists for this execution attempt");
			}
		});
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
		const pub = getRuntimePublicationService();

		// ── Existing task: restart path ──────────────────────────────────
		// Check existence BEFORE any publication call to avoid creating a run
		// for a task that will be restarted (which needs the existing run, not
		// a new one). Use the named readBackgroundTask on PG to avoid the
		// SQLite-only getById.
		const existingRaw =
			pub.backend === "postgres"
				? await pub.readBackgroundTask(opts.id)
				: await this.getById(opts.id);
		// On PG, readBackgroundTask returns a bounded subset; cast to the
		// full record type — the restart branch only reads type/status/
		// parentNarratorId/subagentNarratorId and the "already running"
		// early return just needs the same identity fields.
		const existing = existingRaw as BackgroundTaskRecord | null;
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

			// Restart: get the EXISTING run (getAgentRun reads narrators through
			// the queue adapter on PG; on SQLite it's a sync read), then CAS the
			// task row back to "running" via the named restartAgentTask composite.
			const publicationRun = await pub.getAgentRun(opts.subagentNarratorId, opts.parentNarratorId);
			const restarted = await pub.restartAgentTask({
				taskId: opts.id,
				logicalRunId: publicationRun.logicalRunId,
				subagentNarratorId: opts.subagentNarratorId,
				subagentType: opts.subagentType,
				toolUseId: opts.toolUseId,
				alias: opts.alias,
				title: opts.title,
				expectedStatus: existing.status,
				now,
			});

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
				return {
					...existing,
					...opts,
					status: "running",
					logicalRunId: publicationRun.logicalRunId,
					command: null,
					exitCode: null,
					output: null,
					outputBytes: 0,
					outputTruncated: false,
					notified: false,
					startedAt: now,
					completedAt: null,
					updatedAt: now,
				} as BackgroundTaskRecord;
			}

			const current = await this.getById(opts.id);
			if (current?.status === "running") return current;
			throw new Error(`Background task "${opts.id}" changed while restarting`);
		}

		// ── New task: atomic run + task projection ───────────────────────
		// startAgentRun handles BOTH cases internally: if the narrator already
		// has a logicalRunId it reuses it; otherwise it creates a new run.
		// With taskRow, the background_tasks INSERT is in the SAME section as
		// the slot reservation — no double logical-run creation.
		// On PG: one withPgRetry composite transaction.
		// On SQLite: startAgentRun wraps runAtomicWrite; taskRow is accepted
		// but the SQLite wrapper ignores it (callers insert via their own
		// runAtomicWrite for backward compat with the sync path).
		const taskRow: Omit<typeof backgroundTasks.$inferInsert, "logicalRunId"> = {
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
		const publicationRun = await pub.startAgentRun({
			narratorId: opts.subagentNarratorId,
			parentNarratorId: opts.parentNarratorId,
			taskRow,
		});
		// On SQLite, startAgentRun ignores taskRow — insert the task row
		// in the legacy sync path.
		if (pub.backend === "sqlite") {
			runAtomicWrite(db, "background-task.createAgentTask", (tx) => {
				tx.insert(backgroundTasks)
					.values({ ...taskRow, logicalRunId: publicationRun.logicalRunId })
					.run();
			});
		}
		this.parentNarratorCache.set(opts.id, opts.parentNarratorId);
		this.queueTaskUpsert(opts.parentNarratorId, opts.id);
		this.maybeCleanup();
		return { ...taskRow, logicalRunId: publicationRun.logicalRunId } as BackgroundTaskRecord;
	}

	/**
	 * Create the `background_tasks` PROJECTION of a device transfer.
	 *
	 * The transfer itself is owned by a `device_transfer_tasks` row, which holds the
	 * resume checkpoint, the run generation and the byte progress. This row exists
	 * only so the transfer appears where a narrator's background work is expected:
	 * `Await`, the task drawer, and completion notifications.
	 *
	 * Idempotent per transfer generation. The runner calls this from `claim`, and a
	 * resumed transfer claims again under a new generation — re-inserting would give
	 * one transfer several drawer rows, all but one of them permanently stale. A
	 * resume instead REVIVES the existing row, which is also what keeps a resumed
	 * transfer at its original place in the list rather than jumping to the top as
	 * though it were new work.
	 */
	async createTransferTask(opts: {
		parentNarratorId: string;
		transferTaskId: string;
		title: string;
		toolUseId?: string;
		alias?: string;
	}): Promise<BackgroundTaskRecord> {
		const now = new Date().toISOString();
		const existing = await this.getByTransferTaskId(opts.transferTaskId);
		if (existing) {
			// A resumed transfer: clear the terminal-ish state its previous run left so
			// the drawer stops showing "paused" (and its restart notice) while bytes are
			// moving again.
			const [revived] = await db
				.update(backgroundTasks)
				.set({
					status: "running",
					output: null,
					completedAt: null,
					notified: false,
					// Backfilled, never overwritten: a row created before the alias was carried
					// here has none, and that is the row a restarted transfer resumes into —
					// exactly when the model's handle has to resolve from the database.
					...(opts.alias && !existing.alias ? { alias: opts.alias } : {}),
					updatedAt: now,
				})
				.where(eq(backgroundTasks.id, existing.id))
				.returning();
			this.parentNarratorCache.set(existing.id, existing.parentNarratorId);
			this.queueTaskUpsert(existing.parentNarratorId, existing.id);
			return (revived ?? existing) as BackgroundTaskRecord;
		}

		const row: typeof backgroundTasks.$inferInsert = {
			id: `bgtx_${generateShortId()}`,
			parentNarratorId: opts.parentNarratorId,
			type: "transfer",
			status: "running",
			transferTaskId: opts.transferTaskId,
			toolUseId: opts.toolUseId ?? null,
			alias: opts.alias ?? null,
			title: opts.title,
			// Progress deliberately never lands in `output` — it is joined from the
			// owning row at read time. `output` carries only the final summary.
			output: null,
			outputBytes: 0,
			outputTruncated: false,
			notified: false,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await db.insert(backgroundTasks).values(row);
		this.parentNarratorCache.set(row.id, opts.parentNarratorId);
		this.queueTaskUpsert(opts.parentNarratorId, row.id);
		this.maybeCleanup();
		return row as BackgroundTaskRecord;
	}

	/** The projection row for a transfer, if one exists. */
	async getByTransferTaskId(transferTaskId: string): Promise<BackgroundTaskRecord | null> {
		const [row] = await db
			.select()
			.from(backgroundTasks)
			.where(eq(backgroundTasks.transferTaskId, transferTaskId))
			.limit(1)
			.all();
		return row ?? null;
	}

	/**
	 * A transfer stopped but is RESUMABLE.
	 *
	 * Emits no lifecycle event and pushes no notification: `paused` is not an
	 * outcome. Signalling completion here would unblock a waiting `Await` with a
	 * terminal answer for work that is still pending, and mark the row `notified`
	 * so the eventual real completion is never announced.
	 */
	async markTransferPaused(transferTaskId: string, reason: string | null): Promise<void> {
		const existing = await this.getByTransferTaskId(transferTaskId);
		if (!existing || existing.status !== "running") return;
		const now = new Date().toISOString();
		await db
			.update(backgroundTasks)
			.set({
				status: "paused",
				// No completedAt: it has not completed, and stamping one makes the row
				// eligible for age-based reaping while the transfer is still resumable.
				output: reason,
				updatedAt: now,
			})
			.where(and(eq(backgroundTasks.id, existing.id), eq(backgroundTasks.status, "running")));
		this.queueTaskUpsert(existing.parentNarratorId, existing.id);
	}

	/**
	 * A transfer reached a terminal state. Routes to the ordinary bash-style
	 * terminal paths so `Await`, the notification drain and the drawer all behave
	 * exactly as they do for any other background task.
	 */
	async finishTransferTask(
		transferTaskId: string,
		outcome:
			| { status: "completed"; summary: string }
			| { status: "failed"; error: string }
			| { status: "cancelled" },
	): Promise<void> {
		const existing = await this.getByTransferTaskId(transferTaskId);
		// Only a live row transitions. A cancel already recorded by the drawer, or a
		// second terminal report from a racing generation, must not overwrite it.
		if (!existing || (existing.status !== "running" && existing.status !== "paused")) return;

		// The mark* methods all guard on `status = "running"` (their job is to refuse
		// overwriting a terminal row), so a PAUSED row would silently fail to
		// transition — a cancelled or restarted-then-cancelled transfer would sit in
		// the drawer as "paused" forever with no error anywhere. Lift it back to
		// `running` first, under the same guard, so the terminal write applies.
		if (existing.status === "paused") {
			const now = new Date().toISOString();
			const [lifted] = await db
				.update(backgroundTasks)
				.set({ status: "running", updatedAt: now })
				.where(and(eq(backgroundTasks.id, existing.id), eq(backgroundTasks.status, "paused")))
				.returning();
			// Lost the race to another writer; whatever it wrote is authoritative.
			if (!lifted) return;
		}

		if (outcome.status === "completed") {
			await this.markCompleted(existing.id, outcome.summary);
			return;
		}
		if (outcome.status === "failed") {
			await this.markFailed(existing.id, outcome.error);
			return;
		}
		await this.markCancelled(existing.id);
	}

	// ── Status updates ──────────────────────────────────────────────────

	/** Spill captured Bash output before the row budget or terminal transaction applies. */
	private async prepareTerminalBashOutput(taskId: string, output?: string | null) {
		const current =
			resolveRuntimeQueueBackend() === "postgres"
				? await getRuntimePublicationService().readBackgroundTask(taskId)
				: db
						.select({ type: backgroundTasks.type, status: backgroundTasks.status })
						.from(backgroundTasks)
						.where(eq(backgroundTasks.id, taskId))
						.get();
		if (current?.type !== "bash" || current.status !== "running") return undefined;
		return prepareBackgroundBashResult(taskId, output ?? "");
	}

	/** A failed response need not mean the terminal commit rolled back. */
	private async discardUnpublishedBashOutput(taskId: string, outputPath?: string) {
		if (!outputPath) return;
		try {
			const task = await this.getById(taskId);
			if (task?.output?.includes(outputPath)) return;
			await discardBackgroundBashResult(outputPath);
		} catch {
			// If commit state cannot be established, keep the file for timed cleanup.
		}
	}
	private async transitionTerminalTask(
		taskId: string,
		setFields: Record<string, unknown>,
		fullOutput?: string | null,
		deferPublication = false,
	): Promise<BackgroundTaskRecord | undefined> {
		const prepared = await this.prepareTerminalBashOutput(
			taskId,
			fullOutput ?? (setFields.output as string | null | undefined),
		);
		// On spill failure retain the bounded original row so Await remains a fallback.
		const fields = prepared?.outputPath
			? { ...setFields, output: prepared.content, outputTruncated: true }
			: prepared && setFields.output == null
				? { ...setFields, output: prepared.content }
				: setFields;
		try {
			const task = await this.commitPreparedTerminalTask(
				taskId,
				fields,
				fullOutput,
				deferPublication,
			);
			if (!task) await this.discardUnpublishedBashOutput(taskId, prepared?.outputPath);
			return task;
		} catch (error) {
			await this.discardUnpublishedBashOutput(taskId, prepared?.outputPath);
			throw error;
		}
	}
	private async commitPreparedTerminalTask(
		taskId: string,
		setFields: Record<string, unknown>,
		fullOutput?: string | null,
		deferPublication = false,
	): Promise<BackgroundTaskRecord | undefined> {
		if (resolveRuntimeQueueBackend() === "postgres") {
			// B4 fix: use the named PG composite — CAS update + publication commit
			// in one withPgRetry transaction. No two-phase read-update gap.
			const pub = getRuntimePublicationService();
			const eventKind = publicationEvent(
				(setFields.status as string) ?? "completed",
			) as PublicationEvent;
			const text = fullOutput ?? "(no output)";
			const taskType = (setFields.type as string) ?? "task";
			const taskAlias = (setFields.alias as string | null) ?? null;
			const taskTitle = (setFields.title as string | null) ?? null;
			const summary = `[System] Background ${taskType} "${taskTitle ?? taskAlias ?? taskId}" (ID: ${taskAlias ?? taskId}) ${setFields.status}. Use Await({ type: "${taskType}", id: "${taskAlias ?? taskId}" }) to read the stored result.`;
			const task = await pub.commitTerminalTransition({
				taskId,
				setFields,
				fullOutput: text,
				summary,
				eventKind: eventKind as Exclude<PublicationEvent, "started">,
				deferPublication,
			});
			// The composite returns partial fields; cast to BackgroundTaskRecord
			// (callers access parentNarratorId, type, title, alias, toolUseId, id).
			return task as BackgroundTaskRecord | undefined;
		}
		return this.commitTerminalTask(
			taskId,
			(tx) =>
				tx
					.update(backgroundTasks)
					.set(setFields)
					.where(and(eq(backgroundTasks.id, taskId), eq(backgroundTasks.status, "running")))
					.returning()
					.get(),
			fullOutput,
			deferPublication,
		);
	}

	/**
	 * The terminal CAS and its durable notification must succeed or roll back together.
	 * SQLite-only: the `write` callback receives a sync transaction handle.
	 */
	private commitTerminalTask(
		taskId: string,
		write: (tx: RuntimeTx) => BackgroundTaskRecord | undefined,
		fullOutput?: string | null,
		deferPublication = false,
	) {
		const task = runAtomicWrite(db, "background-task.commitTerminalTask", (tx) => {
			const before = tx
				.select({
					id: backgroundTasks.id,
					type: backgroundTasks.type,
					parentNarratorId: backgroundTasks.parentNarratorId,
					logicalRunId: backgroundTasks.logicalRunId,
				})
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, taskId))
				.get();
			if (before && before.type !== "transfer" && !before.logicalRunId) {
				runtimePublication.store.registerLegacyRunningRunSlots(
					{
						producerKind: before.type,
						taskId,
						recipientId: before.parentNarratorId,
					},
					{ kind: "runtime" },
					{},
					tx,
				);
			}
			const task = write(tx);
			if (!task || task.type === "transfer" || deferPublication) return task;
			const run = taskPublicationRun(task);
			const resultRef = runtimePublication.persistResult(
				run,
				fullOutput ?? task.output ?? "(no output)",
				tx,
			);
			if (
				task.type === "bash" &&
				task.backgroundKind === "service" &&
				task.status === "cancelled"
			) {
				// Explicit service stop settles Await and the list without scheduling a new parent turn.
				runtimePublication.store.consumeAwaitedTerminal(run, tx);
				return task;
			}
			runtimePublication.commit(
				{
					...run,
					eventKind: publicationEvent(task.status),
					resultRef,
					summary: `[System] Background ${task.type} "${task.title ?? task.alias ?? task.id}" (ID: ${task.alias ?? task.id}) ${task.status}. Use Await({ type: "${task.type}", id: "${task.alias ?? task.id}" }) to read the stored result.`,
				},
				tx,
			);
			return task;
		});
		if (task) runtimePublication.schedule();
		return task;
	}

	async markCompleted(
		taskId: string,
		output: string,
		exitCode?: number,
		expectedAbortController?: AbortController,
		publicationOptions?: { deferPublication?: boolean },
	): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
		const now = new Date().toISOString();
		const outputBytes = Buffer.byteLength(output, "utf-8");
		const truncated = outputBytes > MAX_OUTPUT_BYTES;
		const storedOutput = truncated ? truncateToBytes(output, MAX_OUTPUT_BYTES) : output;

		const task = await this.transitionTerminalTask(
			taskId,
			{
				status: "completed",
				output: storedOutput,
				outputBytes,
				outputTruncated: truncated,
				exitCode: exitCode ?? null,
				completedAt: now,
				updatedAt: now,
			},
			output,
			publicationOptions?.deferPublication,
		);

		if (!task) {
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:completed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			...terminalWaitReceipt(task),
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
		publicationOptions?: { deferPublication?: boolean },
	): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
		const now = new Date().toISOString();
		// Truncate error output the same way as markCompleted
		const errorBytes = Buffer.byteLength(error, "utf-8");
		const truncated = errorBytes > MAX_OUTPUT_BYTES;
		const storedError = truncated ? truncateToBytes(error, MAX_OUTPUT_BYTES) : error;

		const task = await this.transitionTerminalTask(
			taskId,
			{
				status: "failed",
				output: storedError,
				outputBytes: errorBytes,
				outputTruncated: truncated,
				exitCode: exitCode ?? null,
				completedAt: now,
				updatedAt: now,
			},
			error,
			publicationOptions?.deferPublication,
		);

		if (!task) {
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:failed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			...terminalWaitReceipt(task),
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
		publicationOptions?: { deferPublication?: boolean },
	): Promise<boolean> {
		if (!this.ownsAbortController(taskId, expectedAbortController)) return false;
		const now = new Date().toISOString();
		const errorBytes = Buffer.byteLength(error, "utf-8");
		const truncated = errorBytes > MAX_OUTPUT_BYTES;
		const storedError = truncated ? truncateToBytes(error, MAX_OUTPUT_BYTES) : error;

		const task = await this.transitionTerminalTask(
			taskId,
			{
				status: "timeout",
				output: storedError,
				outputBytes: errorBytes,
				outputTruncated: truncated,
				exitCode: exitCode ?? null,
				completedAt: now,
				updatedAt: now,
			},
			error,
			publicationOptions?.deferPublication,
		);

		if (!task) {
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:failed",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			...terminalWaitReceipt(task),
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

		if (resolveRuntimeQueueBackend() === "postgres") {
			// PG path: named cancel composite — CAS + publication intent in one section.
			const pub = getRuntimePublicationService();
			const prepared = await this.prepareTerminalBashOutput(taskId, output);
			let task: Awaited<ReturnType<typeof pub.cancelTask>>;
			try {
				task = await pub.cancelTask({
					taskId,
					capturedOutput: prepared?.outputPath ? prepared.content : storedOutput,
					capturedOutputBytes: outputBytes,
					capturedTruncated: !!prepared?.outputPath || truncated,
					now,
				});
			} catch (error) {
				await this.discardUnpublishedBashOutput(taskId, prepared?.outputPath);
				throw error;
			}
			if (!task) await this.discardUnpublishedBashOutput(taskId, prepared?.outputPath);
			if (!task) {
				this.cleanupRuntime(taskId, expectedAbortController);
				return false;
			}
			// In-memory side effects after the composite commits.
			eventBus.emit({
				type: "background_task:cancelled",
				taskId,
				parentNarratorId: task.parentNarratorId,
				taskType: task.type as BackgroundTaskType,
				...terminalWaitReceipt(task),
				output: task.output,
			});
			this.broadcastStatus(
				task.parentNarratorId,
				taskId,
				"cancelled",
				storedOutput,
				task.toolUseId,
			);
			this.cleanupRuntime(taskId, expectedAbortController);
			return true;
		}

		const setFields: Record<string, unknown> = {
			status: "cancelled",
			completedAt: now,
			updatedAt: now,
		};
		if (storedOutput !== null) {
			setFields.output = storedOutput;
			setFields.outputBytes = outputBytes;
			setFields.outputTruncated = truncated;
		}
		const task = await this.transitionTerminalTask(taskId, setFields, output);

		if (!task) {
			this.cleanupRuntime(taskId, expectedAbortController);
			return false;
		}

		eventBus.emit({
			type: "background_task:cancelled",
			taskId,
			parentNarratorId: task.parentNarratorId,
			taskType: task.type,
			...terminalWaitReceipt(task),
			output: task.output,
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

	/** Called only inside the exact parent conclusion transaction, before its outbox intent. */
	commitResumedPublicationTask(
		taskId: string,
		logicalRunId: string,
		status: "completed" | "failed" | "cancelled" | "timeout",
		output: string,
		tx: RuntimeTx,
	): void {
		const now = new Date().toISOString();
		const outputBytes = Buffer.byteLength(output);
		const outputTruncated = outputBytes > MAX_OUTPUT_BYTES;
		const storedOutput = outputTruncated ? truncateToBytes(output, MAX_OUTPUT_BYTES) : output;
		tx.update(backgroundTasks)
			.set({
				status,
				output: storedOutput,
				outputBytes,
				outputTruncated,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(backgroundTasks.id, taskId),
					eq(backgroundTasks.type, "agent"),
					eq(backgroundTasks.logicalRunId, logicalRunId),
				),
			)
			.run();
		tx.update(narrators)
			.set({
				backgroundStatus:
					status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
				backgroundResult: storedOutput,
				backgroundCompletedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(narrators.id, taskId),
					eq(narrators.logicalRunId, logicalRunId),
					eq(narrators.isBackground, true),
				),
			)
			.run();
	}

	/** Control-plane completion follows the successful exact-origin commit, never its preparation. */
	async announcePersistedAgentTerminal(taskId: string, logicalRunId?: string): Promise<void> {
		const task = await this.getById(taskId);
		if (
			!task ||
			task.type !== "agent" ||
			task.status === "running" ||
			(logicalRunId && task.logicalRunId !== logicalRunId)
		)
			return;
		if (task.status === "completed")
			eventBus.emit({
				type: "background_task:completed",
				taskId,
				parentNarratorId: task.parentNarratorId,
				taskType: "agent",
				...terminalWaitReceipt(task),
				output: task.output ?? "",
			});
		else if (task.status === "cancelled")
			eventBus.emit({
				type: "background_task:cancelled",
				taskId,
				parentNarratorId: task.parentNarratorId,
				taskType: "agent",
				...terminalWaitReceipt(task),
				output: task.output,
			});
		else
			eventBus.emit({
				type: "background_task:failed",
				taskId,
				parentNarratorId: task.parentNarratorId,
				taskType: "agent",
				...terminalWaitReceipt(task),
				status: task.status === "timeout" ? "timeout" : "failed",
				error: task.output ?? "",
			});
		this.broadcastStatus(task.parentNarratorId, taskId, task.status, task.output, task.toolUseId);
	}

	// ── Query ───────────────────────────────────────────────────────────

	async getById(taskId: string): Promise<BackgroundTaskRecord | null> {
		if (resolveRuntimeQueueBackend() === "postgres") {
			// PG path: route through the named bounded read in the publication facade.
			// Avoids the SQLite-only synchronous `.get()` on the fail-closed PG handle.
			return getRuntimePublicationService().readBackgroundTask(taskId);
		}
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
	 * Occupancy is a bounded graph, not a raw running-row count: an idle child
	 * can own an idle grandchild which still owns a bash/paused transfer. Only
	 * small metadata columns are read; no historical task outputs are loaded.
	 * Budget exhaustion throws (and logs) rather than publishing a false zero.
	 */
	private async descendantOccupancy(rootIds: string[]): Promise<{
		childCounts: Map<string, number>;
		occupied: Set<string>;
	}> {
		const maxNodes = 4_096;
		const maxRows = 8_192;
		const maxDepth = 32;
		const budgetMs = 150;
		const startedAt = performance.now();
		const visited = new Set(rootIds);
		const children = new Map<string, Set<string>>();
		const parents = new Map<string, Set<string>>();
		const ownTasks = new Map<string, Set<string>>();
		const occupied = new Set<string>();
		const isLive = await this.getLivenessFn();
		let rowCount = 0;
		const fail = (reason: string): never => {
			logger.warn("Background task descendant occupancy budget exceeded", {
				reason,
				roots: rootIds.length,
				nodes: visited.size,
				rows: rowCount,
				elapsedMs: performance.now() - startedAt,
			});
			throw new Error(`Background task descendant occupancy incomplete: ${reason}`);
		};
		const checkBudget = () => {
			if (visited.size > maxNodes) fail("node limit");
			if (rowCount > maxRows) fail("row limit");
			if (performance.now() - startedAt > budgetMs) fail("time limit");
		};
		const link = (parent: string, child: string) => {
			if (parent === child) return;
			if (!children.has(parent)) children.set(parent, new Set());
			children.get(parent)?.add(child);
			if (!parents.has(child)) parents.set(child, new Set());
			parents.get(child)?.add(parent);
		};
		// Indexed existence probes discard terminal historical leaves BEFORE they
		// enter the graph budget. Idle intermediates remain candidates, including
		// an arbitrarily old ancestor of live work within the depth/node limits.
		const hasDescendants = sql<boolean>`exists(select 1 from ${narrators} as occupancy_child
			where occupancy_child.parent_narrator_id = ${narrators.id}
			and occupancy_child.type = 'subagent')`;
		const hasActiveTasks = sql<boolean>`exists(select 1 from ${backgroundTasks}
			where ${backgroundTasks.parentNarratorId} = ${narrators.id}
			and ${backgroundTasks.status} in ('running', 'paused')
			and not (${backgroundTasks.type} = 'bash' and coalesce(${backgroundTasks.backgroundKind}, 'task') = 'service'))`;
		let frontier = [...visited];
		for (let depth = 0; frontier.length > 0; depth++) {
			checkBudget();
			if (depth >= maxDepth) fail("depth limit");
			const next = new Set<string>();
			// Keep IN lists small even for a wide team; LIMIT + 1 detects truncation.
			for (let offset = 0; offset < frontier.length; offset += 128) {
				checkBudget();
				const batch = frontier.slice(offset, offset + 128);
				// In-memory-only liveness gets a bounded parent-index probe. Do not sort
				// historical siblings: parent/createdAt has no all-subagent index. Reserve
				// half the remaining row budget for persisted work across remaining parents.
				const probeLimit = Math.min(
					BACKGROUND_TASK_ACTIVE_LIMIT + 1,
					Math.floor((maxRows - rowCount) / (2 * (frontier.length - offset))),
				);
				const probeIds = sql.join(
					batch.map(
						(parentId) => sql`
					select id from (select id from ${narrators}
					where ${narrators.parentNarratorId} = ${parentId}
					limit ${probeLimit}) as occupancy_probe`,
					),
					sql` union all `,
				);
				const livenessProbe = sql<boolean>`${narrators.id} in (${probeIds})`;
				// Dead probes consume only the row budget, never the graph-node budget.
				const rowLimit = maxRows - rowCount;
				const rows = await db
					.select({
						id: narrators.id,
						parentNarratorId: narrators.parentNarratorId,
						status: narrators.status,
						backgroundStatus: narrators.backgroundStatus,
						substatus: narrators.substatus,
						potentialWork: sql<boolean>`${hasDescendants} or ${hasActiveTasks}`,
						// Both identities are indexed; EXISTS never loads terminal history.
						hasProjection: sql<boolean>`exists(select 1 from ${backgroundTasks} where
							${backgroundTasks.id} = ${narrators.id} or
							(${backgroundTasks.type} = 'agent' and ${backgroundTasks.subagentNarratorId} = ${narrators.id}))`,
					})
					.from(narrators)
					.where(
						and(
							inArray(narrators.parentNarratorId, batch),
							eq(narrators.type, "subagent"),
							or(
								inArray(narrators.status, ["working", "waiting"]),
								eq(narrators.backgroundStatus, "running"),
								like(narrators.substatus, '%"taken_over"%'),
								hasActiveTasks,
								hasDescendants,
								isLive && probeLimit > 0 ? livenessProbe : undefined,
							),
						),
					)
					.limit(rowLimit + 1)
					.all();
				rowCount += rows.length;
				if (rows.length > rowLimit) fail("child query limit");
				for (const row of rows) {
					if (!row.parentNarratorId) continue;
					const active =
						row.status === "working" ||
						row.status === "waiting" ||
						(row.backgroundStatus === "running" && !row.hasProjection) ||
						parseSubstatus(row.substatus).includes("taken_over") ||
						isLive?.(row.id);
					if (!active && !row.potentialWork) continue;
					link(row.parentNarratorId, row.id);
					if (active) occupied.add(row.id);
					if (!visited.has(row.id)) {
						visited.add(row.id);
						next.add(row.id);
					}
				}
				checkBudget();
				const tasks = await db
					.select({
						id: backgroundTasks.id,
						parentNarratorId: backgroundTasks.parentNarratorId,
						type: backgroundTasks.type,
						subagentNarratorId: backgroundTasks.subagentNarratorId,
					})
					.from(backgroundTasks)
					.where(
						and(
							inArray(backgroundTasks.parentNarratorId, batch),
							inArray(backgroundTasks.status, ["running", "paused"]),
							sql`not (${backgroundTasks.type} = 'bash' and coalesce(${backgroundTasks.backgroundKind}, 'task') = 'service')`,
						),
					)
					.limit(maxRows - rowCount + 1)
					.all();
				rowCount += tasks.length;
				for (const task of tasks) {
					if (task.type === "agent") {
						const child = task.subagentNarratorId ?? task.id;
						link(task.parentNarratorId, child);
						occupied.add(child);
						if (!visited.has(child)) {
							visited.add(child);
							next.add(child);
						}
					} else {
						if (!ownTasks.has(task.parentNarratorId))
							ownTasks.set(task.parentNarratorId, new Set());
						ownTasks.get(task.parentNarratorId)?.add(task.id);
						occupied.add(task.parentNarratorId);
					}
				}
				checkBudget();
			}
			frontier = [...next];
		}
		// Work-seeded reachability converges once per node, including cyclic data.
		const queue = [...occupied];
		for (let index = 0; index < queue.length; index++) {
			for (const parent of parents.get(queue[index]) ?? []) {
				if (occupied.has(parent)) continue;
				occupied.add(parent);
				queue.push(parent);
			}
		}
		const childCounts = new Map<string, number>();
		for (const id of visited) {
			let value = ownTasks.get(id)?.size ?? 0;
			for (const child of children.get(id) ?? []) {
				if (occupied.has(child)) value++;
			}
			childCounts.set(id, value);
		}
		checkBudget();
		return { childCounts, occupied };
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
				canCancelActiveWork: isCancellableTaskStatus(task.status),
			}));
		}

		const [narratorRows, { childCounts }] = await Promise.all([
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
			this.descendantOccupancy(agentIds),
		]);
		const narratorState = new Map(narratorRows.map((row) => [row.id, row]));

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
					isCancellableTaskStatus(task.status) ||
					effectiveStatus === "continued" ||
					activeChildTaskCount > 0,
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
		const withProgress = await this.applyTransferProgress(items);
		const isLive = await this.getLivenessFn();
		if (!isLive) return withProgress;
		return withProgress.map((item) => {
			if (item.type !== "agent") return item;
			if (!isLive(item.subagentNarratorId ?? item.id)) return item;
			return {
				...item,
				effectiveStatus:
					item.effectiveStatus === "taken_over"
						? "taken_over"
						: item.status === "running"
							? "running"
							: "continued",
				currentNarratorStatus: "working",
				canCancelActiveWork: true,
			};
		});
	}

	/**
	 * Attach live byte progress to `transfer` rows by JOINING the owning
	 * `device_transfer_tasks` rows.
	 *
	 * Read-time rather than stored: progress changes every 500ms, and persisting it
	 * on the projection too would create two rows that must agree on a fast-moving
	 * value. Placed inside `applyLiveness` because that is the one funnel every list
	 * path already passes through (paged rows, the active set, and delta upserts) —
	 * attaching it anywhere else would give some surfaces a bar and others none.
	 *
	 * Bounded: only the transfer rows already in `items` are looked up, and only
	 * their small numeric columns. Terminal rows are skipped — a finished transfer's
	 * bar would sit at 100% saying nothing its summary does not.
	 */
	private async applyTransferProgress(
		items: BackgroundTaskListItem[],
	): Promise<BackgroundTaskListItem[]> {
		const transferRows = items.filter(
			(item) => item.type === "transfer" && isBackgroundTaskActiveStatus(item.effectiveStatus),
		);
		if (transferRows.length === 0) return items;
		const projectionIds = transferRows.map((item) => item.id);
		const owners = await db
			.select({
				projectionId: backgroundTasks.id,
				direction: deviceTransferTasks.direction,
				bytesTransferred: deviceTransferTasks.bytesTransferred,
				totalBytes: deviceTransferTasks.totalBytes,
				filesTransferred: deviceTransferTasks.filesTransferred,
				totalFiles: deviceTransferTasks.totalFiles,
				currentFile: deviceTransferTasks.currentFile,
				startedAt: deviceTransferTasks.startedAt,
				updatedAt: deviceTransferTasks.updatedAt,
			})
			.from(backgroundTasks)
			.innerJoin(deviceTransferTasks, eq(backgroundTasks.transferTaskId, deviceTransferTasks.id))
			.where(inArray(backgroundTasks.id, projectionIds))
			.all();
		if (owners.length === 0) return items;
		const byProjection = new Map(owners.map((row) => [row.projectionId, row]));
		return items.map((item) => {
			const owner = byProjection.get(item.id);
			if (!owner) return item;
			const progress: ToolProgressPayload = {
				completed: owner.bytesTransferred,
				// Omitted rather than zeroed when unknown: a `total: 0` lets the client
				// compute 0% and paint a bar frozen at zero, which reads as a stalled
				// transfer instead of an unmeasurable one.
				...(owner.totalBytes != null && owner.totalBytes > 0 ? { total: owner.totalBytes } : {}),
				...(owner.totalFiles != null && owner.totalFiles > 1
					? { itemsDone: owner.filesTransferred, itemsTotal: owner.totalFiles }
					: {}),
				...(owner.currentFile ? { currentItem: owner.currentFile } : {}),
				// Elapsed spans the CURRENT run only (startedAt is re-stamped on resume),
				// so a transfer paused overnight does not report an overnight-long elapsed
				// and therefore a near-zero rate.
				...(owner.startedAt
					? {
							elapsedMs: Math.max(
								0,
								new Date(owner.updatedAt).getTime() - new Date(owner.startedAt).getTime(),
							),
						}
					: {}),
				phase: owner.direction,
			};
			return { ...item, progress };
		});
	}

	private toListItem(summary: BackgroundTaskSummary): BackgroundTaskListItem {
		const preview = toListPreview(summary.output);
		return {
			id: summary.id,
			type: summary.type,
			backgroundKind: summary.type === "bash" ? (summary.backgroundKind ?? "task") : "task",
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
	private async listItemsByIds(
		parentNarratorId: string,
		taskIds: string[],
	): Promise<BackgroundTaskListItem[]> {
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
			.where(
				and(
					eq(backgroundTasks.parentNarratorId, parentNarratorId),
					inArray(backgroundTasks.id, ids),
				),
			)
			.all();
		const summaries = await this.reconcileSummaries(rows);
		return this.applyLiveness(summaries.map((summary) => this.toListItem(summary)));
	}

	/**
	 * Narrator fallback: legacy background tasks, foreground children, and resumed
	 * children whose background projection has already been reaped.
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
			ids?: string[];
			/** Skip the preview column entirely; for count-only callers. */
			omitOutput?: boolean;
		},
	): Promise<BackgroundTaskListItem[]> {
		const occupancy = opts.activeOnly ? await this.descendantOccupancy([parentNarratorId]) : null;
		const occupiedIds = occupancy ? [...occupancy.occupied] : [];
		const conditions = [
			eq(narrators.parentNarratorId, parentNarratorId),
			// Execution mode is temporary, not membership: user continuations clear
			// isBackground, and foreground agents never set it in the first place.
			or(eq(narrators.isBackground, true), like(narrators.variant, "subagent:%")),
			notExists(
				db
					.select({ one: sql`1` })
					.from(backgroundTasks)
					.where(
						or(
							eq(backgroundTasks.id, narrators.id),
							and(
								eq(backgroundTasks.type, "agent"),
								eq(backgroundTasks.subagentNarratorId, narrators.id),
							),
						),
					),
			),
		];
		if (opts.ids) conditions.push(inArray(narrators.id, opts.ids));
		if (opts.activeOnly)
			conditions.push(
				or(
					eq(narrators.backgroundStatus, "running"),
					inArray(narrators.status, ["working", "waiting"]),
					like(narrators.substatus, '%"taken_over"%'),
					occupiedIds.length > 0 ? inArray(narrators.id, occupiedIds) : undefined,
				),
			);
		const cursorCondition = opts.cursor
			? listCursorCondition(opts.cursor, narrators.createdAt, narrators.id)
			: undefined;
		const rows = await db
			.select({
				id: narrators.id,
				subagentType: narrators.subagentType,
				substatus: narrators.substatus,
				errorMessage: narrators.errorMessage,
				isBackground: narrators.isBackground,
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

		const { childCounts } =
			occupancy ?? (await this.descendantOccupancy(rows.map((row) => row.id)));
		return this.applyLiveness(
			rows.map((row) => {
				const activeChildTaskCount = childCounts.get(row.id) ?? 0;
				const status =
					row.backgroundStatus ??
					(row.status === "working" || row.status === "waiting" ? "running" : "completed");
				const effectiveStatus = resolveBackgroundTaskEffectiveStatus({
					taskStatus: status as BackgroundTaskRecord["status"],
					currentNarratorStatus: row.status,
					currentNarratorIsBackground: row.isBackground,
					currentNarratorBackgroundStatus: row.backgroundStatus,
					currentNarratorSubstatus: row.substatus,
					currentNarratorErrorMessage: row.errorMessage,
					activeChildTaskCount,
				});
				const chars = Number(row.backgroundResultChars) || 0;
				const preview = toListPreview(row.backgroundResult);
				return {
					id: row.id,
					type: "agent" as const,
					backgroundKind: "task" as const,
					status,
					effectiveStatus,
					currentNarratorStatus: row.status,
					activeChildTaskCount,
					canCancelActiveWork:
						isCancellableTaskStatus(status) ||
						effectiveStatus === "continued" ||
						activeChildTaskCount > 0,
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
			}),
		);
	}

	private async listUnifiedItems(
		parentNarratorId: string,
		opts: {
			cursor?: BackgroundTaskListCursor;
			limit: number;
			activeOnly?: boolean;
			serviceOnly?: boolean;
			omitOutput?: boolean;
		},
	): Promise<BackgroundTaskListItem[]> {
		const conditions = [eq(backgroundTasks.parentNarratorId, parentNarratorId)];
		if (opts.activeOnly) conditions.push(inArray(backgroundTasks.status, ["running", "paused"]));
		if (opts.serviceOnly) {
			conditions.push(
				eq(backgroundTasks.type, "bash"),
				eq(backgroundTasks.backgroundKind, "service"),
			);
		}
		const cursorCondition = opts.cursor
			? listCursorCondition(opts.cursor, backgroundTasks.createdAt, backgroundTasks.id)
			: undefined;
		const { output: _output, ...columns } = getTableColumns(backgroundTasks);
		const rows = await db
			.select({
				...columns,
				output: opts.omitOutput
					? sql<string | null>`null`
					: sql<
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
		return (await this.countActiveKindsByParent(parentNarratorId)).activeCount;
	}

	async countActiveKindsByParent(parentNarratorId: string): Promise<BackgroundTaskActiveCounts> {
		return (
			(await this.countActiveKindsByParentBatch([parentNarratorId])).get(parentNarratorId) ?? {
				activeCount: 0,
				activeWorkCount: 0,
				activeServiceCount: 0,
			}
		);
	}

	/**
	 * Batch variant of `countActiveByParent` for list surfaces (RecentTabs
	 * snapshot, GET /api/narrators) that render one badge per narrator.
	 *
	 * The per-parent candidate cap is applied in SQL via a window function: the
	 * `type='agent'` predicate matches every historical agent row forever, so
	 * capping in JS after an uncapped read would materialize a narrator's whole
	 * agent history on the main thread. Reconcile + liveness semantics are shared
	 * with the single-parent path so a sidebar badge and the panel badge can
	 * never disagree, and the result is capped at BACKGROUND_TASK_ACTIVE_LIMIT
	 * per parent for the same reason `listActiveItems` truncates.
	 */
	async countActiveByParentBatch(parentNarratorIds: string[]): Promise<Map<string, number>> {
		const counts = await this.countActiveKindsByParentBatch(parentNarratorIds);
		return new Map(
			[...counts]
				.filter(([, value]) => value.activeCount > 0)
				.map(([id, value]) => [id, value.activeCount]),
		);
	}

	async countActiveKindsByParentBatch(
		parentNarratorIds: string[],
	): Promise<Map<string, BackgroundTaskActiveCounts>> {
		const result = new Map<string, BackgroundTaskActiveCounts>();
		const counts = new Map<string, number>();
		const services = new Map<string, number>();
		const ids = [...new Set(parentNarratorIds.filter((id) => typeof id === "string" && id))];
		if (ids.length === 0) return result;
		if (ids.length > 4_096) {
			logger.warn("Background task batch count root limit exceeded", { roots: ids.length });
			throw new Error("Background task batch count incomplete: root limit");
		}

		const cap = BACKGROUND_TASK_ACTIVE_LIMIT + 1;
		const candidateSq = db
			.select({
				id: backgroundTasks.id,
				parentNarratorId: backgroundTasks.parentNarratorId,
				type: backgroundTasks.type,
				status: backgroundTasks.status,
				subagentNarratorId: backgroundTasks.subagentNarratorId,
				backgroundKind: backgroundTasks.backgroundKind,
				rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${backgroundTasks.parentNarratorId}, (${backgroundTasks.type} = 'bash' and coalesce(${backgroundTasks.backgroundKind}, 'task') = 'service') ORDER BY ${backgroundTasks.createdAt} DESC, ${backgroundTasks.id} DESC)`.as(
					"rn",
				),
			})
			.from(backgroundTasks)
			.where(
				and(
					inArray(backgroundTasks.parentNarratorId, ids),
					or(
						eq(backgroundTasks.status, "running"),
						eq(backgroundTasks.status, "paused"),
						eq(backgroundTasks.type, "agent"),
					),
				),
			)
			.as("candidates");
		const candidateRows = await db
			.select({
				id: candidateSq.id,
				parentNarratorId: candidateSq.parentNarratorId,
				type: candidateSq.type,
				backgroundKind: candidateSq.backgroundKind,
				status: candidateSq.status,
				subagentNarratorId: candidateSq.subagentNarratorId,
			})
			.from(candidateSq)
			.where(lte(candidateSq.rn, cap))
			.limit(16_385)
			.all();
		const serviceCandidateCount = candidateRows.filter(
			(row) => row.type === "bash" && row.backgroundKind === "service",
		).length;
		if (serviceCandidateCount > 8_192 || candidateRows.length - serviceCandidateCount > 8_192) {
			logger.warn("Background task batch count candidate limit exceeded", {
				roots: ids.length,
				rows: candidateRows.length,
			});
			throw new Error("Background task batch count incomplete: candidate limit");
		}

		// Reconcile agent rows against their subagent narrators' current state —
		// same inputs as reconcileSummaries, but count-only (no list items built).
		const agentIds = [
			...new Set(
				candidateRows
					.filter((row) => row.type === "agent")
					.map((row) => row.subagentNarratorId ?? row.id),
			),
		];
		const narratorState = new Map<
			string,
			{
				status: string;
				isBackground: boolean | null;
				backgroundStatus: string | null;
				substatus: string | null;
				errorMessage: string | null;
			}
		>();
		const { childCounts, occupied } = await this.descendantOccupancy([...ids, ...agentIds]);
		if (agentIds.length > 0) {
			const narratorRows = await db
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
				.all();
			for (const row of narratorRows) narratorState.set(row.id, row);
		}

		const isLive = await this.getLivenessFn();
		// Same overlay as applyLiveness, minus transfer progress (which never
		// changes whether a row counts as active).
		const liveEffectiveStatus = (row: {
			type: string;
			status: string;
			subagentNarratorId: string | null;
			id: string;
			effectiveStatus: string;
		}): string => {
			if (!isLive || row.type !== "agent") return row.effectiveStatus;
			if (!isLive(row.subagentNarratorId ?? row.id)) return row.effectiveStatus;
			if (row.effectiveStatus === "taken_over") return "taken_over";
			return row.status === "running" ? "running" : "continued";
		};

		for (const row of candidateRows) {
			const subagentNarratorId = row.type === "agent" ? (row.subagentNarratorId ?? row.id) : null;
			const currentNarrator = subagentNarratorId
				? (narratorState.get(subagentNarratorId) ?? null)
				: null;
			const effectiveStatus = liveEffectiveStatus({
				...row,
				effectiveStatus: resolveBackgroundTaskEffectiveStatus({
					taskStatus: row.status,
					currentNarratorStatus: currentNarrator?.status ?? null,
					currentNarratorIsBackground: currentNarrator?.isBackground,
					currentNarratorBackgroundStatus: currentNarrator?.backgroundStatus,
					currentNarratorSubstatus: currentNarrator?.substatus,
					currentNarratorErrorMessage: currentNarrator?.errorMessage,
					activeChildTaskCount: subagentNarratorId ? (childCounts.get(subagentNarratorId) ?? 0) : 0,
				}),
			});
			if (isBackgroundTaskActiveStatus(effectiveStatus as BackgroundTaskEffectiveStatus)) {
				const bucket = row.type === "bash" && row.backgroundKind === "service" ? services : counts;
				bucket.set(row.parentNarratorId, (bucket.get(row.parentNarratorId) ?? 0) + 1);
			}
		}

		// Same legacy candidates and per-parent cap/order as listLegacyRows.
		// The bounded graph also discovers idle legacy ancestors of live work.
		const occupiedIds = [...occupied];
		const legacySq = db
			.select({
				id: narrators.id,
				parentNarratorId: narrators.parentNarratorId,
				status: narrators.status,
				isBackground: narrators.isBackground,
				backgroundStatus: narrators.backgroundStatus,
				substatus: narrators.substatus,
				errorMessage: narrators.errorMessage,
				rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${narrators.parentNarratorId} ORDER BY ${narrators.createdAt} DESC, ${narrators.id} DESC)`.as(
					"rn",
				),
			})
			.from(narrators)
			.where(
				and(
					inArray(narrators.parentNarratorId, ids),
					or(eq(narrators.isBackground, true), like(narrators.variant, "subagent:%")),
					notExists(
						db
							.select({ one: sql`1` })
							.from(backgroundTasks)
							.where(
								or(
									eq(backgroundTasks.id, narrators.id),
									and(
										eq(backgroundTasks.type, "agent"),
										eq(backgroundTasks.subagentNarratorId, narrators.id),
									),
								),
							),
					),
					or(
						eq(narrators.backgroundStatus, "running"),
						inArray(narrators.status, ["working", "waiting"]),
						like(narrators.substatus, '%"taken_over"%'),
						occupiedIds.length > 0 ? inArray(narrators.id, occupiedIds) : undefined,
					),
				),
			)
			.as("legacy_candidates");
		const legacyRows = await db.select().from(legacySq).where(lte(legacySq.rn, cap)).all();
		for (const row of legacyRows) {
			if (!row.parentNarratorId) continue;
			const status =
				row.backgroundStatus ??
				(row.status === "working" || row.status === "waiting" ? "running" : "completed");
			const effectiveStatus = liveEffectiveStatus({
				id: row.id,
				type: "agent",
				status,
				subagentNarratorId: row.id,
				effectiveStatus: resolveBackgroundTaskEffectiveStatus({
					taskStatus: status as BackgroundTaskRecord["status"],
					currentNarratorStatus: row.status,
					currentNarratorIsBackground: row.isBackground,
					currentNarratorBackgroundStatus: row.backgroundStatus,
					currentNarratorSubstatus: row.substatus,
					currentNarratorErrorMessage: row.errorMessage,
					activeChildTaskCount: childCounts.get(row.id) ?? 0,
				}),
			});
			if (isBackgroundTaskActiveStatus(effectiveStatus as BackgroundTaskEffectiveStatus)) {
				counts.set(row.parentNarratorId, (counts.get(row.parentNarratorId) ?? 0) + 1);
			}
		}

		// Independent caps prevent long-lived services from hiding active work.
		for (const parentId of ids) {
			const activeWorkCount = Math.min(counts.get(parentId) ?? 0, BACKGROUND_TASK_ACTIVE_LIMIT);
			const activeServiceCount = Math.min(
				services.get(parentId) ?? 0,
				BACKGROUND_TASK_ACTIVE_LIMIT,
			);
			result.set(parentId, {
				activeCount: activeWorkCount + activeServiceCount,
				activeWorkCount,
				activeServiceCount,
			});
		}
		return result;
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
		const [candidateRows, legacyActive, serviceActive] = await Promise.all([
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
						sql`not (${backgroundTasks.type} = 'bash' and coalesce(${backgroundTasks.backgroundKind}, 'task') = 'service')`,
						or(
							eq(backgroundTasks.status, "running"),
							// A paused transfer is still active work (see
							// isBackgroundTaskActiveStatus). Omitting it here would make the
							// candidate set disagree with the predicate that filters it,
							// which is the silent kind of bug: the row simply never appears.
							eq(backgroundTasks.status, "paused"),
							eq(backgroundTasks.type, "agent"),
						),
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
			this.listUnifiedItems(parentNarratorId, {
				limit,
				activeOnly: true,
				serviceOnly: true,
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
		const truncated =
			items.length > BACKGROUND_TASK_ACTIVE_LIMIT ||
			serviceActive.length > BACKGROUND_TASK_ACTIVE_LIMIT;
		return {
			items: [
				...items.slice(0, BACKGROUND_TASK_ACTIVE_LIMIT),
				...serviceActive.slice(0, BACKGROUND_TASK_ACTIVE_LIMIT),
			].sort(compareBackgroundTaskListItemsDesc),
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

		// The first page already has the bounded active snapshot. A second async
		// count read could combine newer counts with older rows and a stale version.
		const serviceCount = active.items.filter(
			(item) => item.type === "bash" && item.backgroundKind === "service",
		).length;
		const counts = isFirstPage
			? {
					activeCount: active.items.length,
					activeWorkCount: active.items.length - serviceCount,
					activeServiceCount: serviceCount,
				}
			: await this.countActiveKindsByParent(parentNarratorId);
		return {
			listEpoch: BACKGROUND_TASK_LIST_EPOCH,
			version: this.getListVersion(parentNarratorId),
			...counts,
			...(isFirstPage ? { activeTasks: active.items, activeTruncated: active.truncated } : {}),
			tasks,
			nextCursor:
				hasMore && last
					? encodeBackgroundTaskListCursor({ createdAt: last.createdAt, id: last.id })
					: null,
		};
	}

	/**
	 * Bounded snapshot for pre-paging clients still open after a server upgrade.
	 *
	 * They request the list without limit/cursor and unconditionally map both
	 * `tasks` and `legacySubagentTasks`. Legacy rows are already normalized into
	 * `tasks`, so an empty compatibility array prevents a successful HTTP response
	 * from throwing in their queryFn. They also cannot read `activeTasks` or page
	 * older history: include the capped active set alongside the first page, not
	 * the entire history. Keep the cursor from that original page unchanged.
	 */
	async listLegacySnapshotByParent(
		parentNarratorId: string,
	): Promise<BackgroundTaskListPage & { legacySubagentTasks: never[] }> {
		const page = await this.listPageByParent(parentNarratorId);
		const byId = new Map(page.tasks.map((task) => [task.id, task]));
		// The active read is fresher and wins if a row appears in both sets.
		for (const task of page.activeTasks ?? []) byId.set(task.id, task);
		return {
			...page,
			tasks: [...byId.values()].sort(compareBackgroundTaskListItemsDesc),
			legacySubagentTasks: [],
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

	/** Synchronous signal for process-exit handlers racing with cancellation publication. */
	isCancellationRequested(taskId: string): boolean {
		return this.abortControllers.get(taskId)?.signal.aborted ?? false;
	}

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
		if (resolveRuntimeQueueBackend() === "postgres") {
			// PG path: named bounded read of running tasks, then cancel each through
			// the cancelTask composite (which handles CAS + publication atomically).
			const pub = getRuntimePublicationService();
			let cancelled = 0;
			let afterId: string | undefined;
			for (;;) {
				const page = await pub.readRunningStaleTasks(afterId);
				if (page.length === 0) break;
				const running = page.filter(
					(t) => t.parentNarratorId === parentNarratorId && t.type !== "transfer",
				);
				afterId = page.at(-1)?.id;
				for (const task of running) {
					const now = new Date().toISOString();
					const result = await pub.cancelTask({
						taskId: task.id,
						capturedOutput: null,
						capturedOutputBytes: 0,
						capturedTruncated: false,
						now,
					});
					if (result) {
						cancelled++;
						if (result.type === "agent") {
							await pub.cancelAgentNarrator({
								narratorId: task.subagentNarratorId ?? task.id,
								now,
							});
						}
						const ctrl = this.abortControllers.get(task.id);
						if (ctrl) {
							try {
								ctrl.abort();
							} catch {
								/* already aborted */
							}
						}
						const killHandler = this.killHandlers.get(task.id);
						if (killHandler) {
							try {
								killHandler();
							} catch (err) {
								logger.warn("Kill handler error during cancel", {
									taskId: task.id,
									error: err instanceof Error ? err.message : String(err),
								});
							}
						}
						eventBus.emit({
							type: "background_task:cancelled",
							taskId: task.id,
							parentNarratorId: result.parentNarratorId,
							taskType: result.type as BackgroundTaskType,
							...terminalWaitReceipt(result),
							output: result.output,
						});
						this.cleanupRuntime(task.id);
					}
				}
				if (running.length < 100) break;
			}
			return cancelled;
		}
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
		// Named bounded composite on both backends: PG uses withPgRetry, SQLite
		// uses runAtomicWrite. Takeover intentionally emits no cancellation event.
		const pub = getRuntimePublicationService();
		const updated = await pub.markTakenOver({ taskId, now });
		this.cleanupRuntime(taskId, expectedAbortController);
		// The LIST still changed: the row left `running`.
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
		// Named bounded composite on both backends: CAS cancelled → terminal,
		// durable result publication, and retry/transaction semantics stay aligned.
		const pub = getRuntimePublicationService();
		const updated = await pub.finalizeTakeover({ taskId, hasError, output, now });
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
			return {
				status: toWaitStatus(task.status),
				output: task.output,
				...terminalWaitReceipt(task),
			};
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

			const onCompleted = (event: {
				taskId: string;
				output: string | null;
				publicationRun?: PublicationRun;
			}) => {
				if (settled || event.taskId !== taskId) return;
				cleanup();
				resolve({
					status: "completed",
					output: event.output,
					terminalResultReceived: true,
					publicationRun: event.publicationRun,
				});
			};
			const onFailed = (event: {
				taskId: string;
				error: string | null;
				status?: "failed" | "timeout";
				publicationRun?: PublicationRun;
			}) => {
				if (settled || event.taskId !== taskId) return;
				cleanup();
				resolve({
					status: toWaitStatus(event.status ?? "failed"),
					output: event.error,
					terminalResultReceived: true,
					publicationRun: event.publicationRun,
				});
			};
			const onCancelled = (event: {
				taskId: string;
				output?: string | null;
				publicationRun?: PublicationRun;
			}) => {
				if (settled || event.taskId !== taskId) return;
				const output = event.output === undefined ? this.getOutputBuffer(taskId) : event.output;
				cleanup();
				resolve({
					status: "cancelled",
					output,
					terminalResultReceived: event.output !== undefined,
					publicationRun: event.publicationRun,
				});
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

			// Terminal events are not replayed to late listeners. Re-read after subscribing
			// to close the gap between the initial check and listener registration.
			void this.getById(taskId)
				.then((fresh) => {
					if (settled || !fresh || fresh.status === "running") return;
					cleanup();
					resolve({
						status: toWaitStatus(fresh.status),
						output: fresh.output,
						...terminalWaitReceipt(fresh),
					});
				})
				.catch(() => {
					// Live lifecycle listeners remain authoritative if the recheck fails.
				});
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
				...terminalWaitReceipt(task),
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

			const onCompleted = (event: {
				taskId: string;
				output: string | null;
				publicationRun?: PublicationRun;
			}) => {
				if (settled || event.taskId !== taskId) return;
				const output = event.output ?? "";
				cleanup();
				resolve({
					status: output.includes(text) ? "found" : "completed",
					output,
					terminalResultReceived: true,
					publicationRun: event.publicationRun,
				});
			};

			const onFailed = (event: {
				taskId: string;
				error: string | null;
				status?: "failed" | "timeout";
				publicationRun?: PublicationRun;
			}) => {
				if (settled || event.taskId !== taskId) return;
				const output = event.error ?? "";
				cleanup();
				resolve({
					status: output.includes(text) ? "found" : toWaitStatus(event.status ?? "failed"),
					output,
					terminalResultReceived: true,
					publicationRun: event.publicationRun,
				});
			};

			const onCancelled = (event: {
				taskId: string;
				output?: string | null;
				publicationRun?: PublicationRun;
			}) => {
				if (settled || event.taskId !== taskId) return;
				const finalBuf = event.output === undefined ? this.getOutputBuffer(taskId) : event.output;
				cleanup();
				resolve({
					status: finalBuf?.includes(text) ? "found" : "cancelled",
					output: finalBuf,
					terminalResultReceived: event.output !== undefined,
					publicationRun: event.publicationRun,
				});
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

			// Output/terminal events are not replayed to late listeners. Re-read both the
			// persisted row and the live tail after subscribing to close that gap.
			void this.getById(taskId)
				.then((fresh) => {
					if (settled || !fresh) return;
					if (fresh.status !== "running") {
						const output = fresh.output ?? "";
						cleanup();
						resolve({
							status: output.includes(text) ? "found" : toWaitStatus(fresh.status),
							output: fresh.output,
							...terminalWaitReceipt(fresh),
						});
						return;
					}
					const currentBuf = this.getOutputBuffer(taskId) ?? "";
					if (currentBuf.includes(text)) {
						cleanup();
						resolve({ status: "found", output: currentBuf });
					}
				})
				.catch(() => {
					// Live output/lifecycle listeners remain authoritative if the recheck fails.
				});
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
					// "Not running" is NOT the same as "finished": a paused transfer is
					// stopped but resumable. Notifying on it would tell the model a
					// transfer completed when in fact it is waiting to be resumed — and
					// because the row is then marked `notified`, the REAL completion would
					// never be announced.
					notInArray(backgroundTasks.status, ["running", "paused"]),
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
		// Result + intent already committed in commitTerminalTask. This is only a wake hint.
		void parentNarratorId;
		void notification;
		runtimePublication.schedule();
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
		afterId?: string,
	): Promise<number> {
		// PG path: named bounded read through the publication facade.
		// SQLite path: direct synchronous select (preserves existing behavior).
		const page =
			resolveRuntimeQueueBackend() === "postgres"
				? await getRuntimePublicationService().readRunningStaleTasks(afterId)
				: await db
						.select({
							id: backgroundTasks.id,
							type: backgroundTasks.type,
							parentNarratorId: backgroundTasks.parentNarratorId,
							subagentNarratorId: backgroundTasks.subagentNarratorId,
							logicalRunId: backgroundTasks.logicalRunId,
							toolCallId: backgroundTasks.toolCallId,
							executionAttempt: backgroundTasks.executionAttempt,
						})
						.from(backgroundTasks)
						.where(
							and(
								eq(backgroundTasks.status, "running"),
								afterId ? gt(backgroundTasks.id, afterId) : undefined,
							),
						)
						.orderBy(asc(backgroundTasks.id))
						.limit(101)
						.all();
		const scanned = page.slice(0, 100);
		const nextPage = async () => {
			if (page.length <= 100) return 0;
			await new Promise<void>((resolve) => setImmediate(resolve));
			return this.recoverStaleTasksAfterRestart(protectedTaskIds, scanned.at(-1)?.id);
		};
		const staleTasks = scanned
			// Only an agent row can be protected — see the note above on why a bash row
			// has no resume path to protect.
			.filter((task) => task.type === "bash" || !protectedTaskIds.has(task.id));
		if (staleTasks.length === 0) return nextPage();

		const now = new Date().toISOString();
		// A transfer is the one kind that SURVIVES a restart. Its owning
		// `device_transfer_tasks` row keeps a resume checkpoint and is itself recovered
		// as `paused` (see DeviceTransferTaskStore.recoverInterrupted), so cancelling
		// the projection would make the drawer say "cancelled" about a transfer the user
		// can still resume — the two halves would disagree about the same transfer, and
		// the drawer is the half the user reads.
		const transferIds = staleTasks.filter((t) => t.type === "transfer").map((t) => t.id);
		const endedIds = staleTasks.filter((t) => t.type !== "transfer").map((t) => t.id);

		if (transferIds.length > 0) {
			if (resolveRuntimeQueueBackend() === "postgres") {
				const pub = getRuntimePublicationService();
				for (const taskId of transferIds)
					await pub.pauseStaleTransfer({
						taskId,
						now,
						notice: TRANSFER_RESTART_PAUSE_NOTICE,
					});
			} else {
				await db
					.update(backgroundTasks)
					.set({
						status: "paused",
						// No completedAt: the task has not completed, and stamping one would
						// make `cleanupCompleted`'s age filter eligible to reap a live transfer.
						updatedAt: now,
						output: TRANSFER_RESTART_PAUSE_NOTICE,
					})
					.where(
						and(inArray(backgroundTasks.id, transferIds), eq(backgroundTasks.status, "running")),
					);
			}
		}
		if (endedIds.length > 0) {
			for (const task of staleTasks) {
				if (task.type === "transfer") continue;
				const text =
					task.type === "bash"
						? "Execution outcome unknown after restart; the command was not rerun."
						: "Background task was interrupted by a server restart.";
				const eventKind = (task.type === "bash" ? "failed" : "cancelled") as "failed" | "cancelled";

				// PG path: one named terminal-transition composite owns the CAS and intent.
				// Never touch the SQLite Drizzle handle on this branch: a successful task update
				// followed by a failed publication would otherwise leave a non-atomic terminal.
				if (resolveRuntimeQueueBackend() === "postgres") {
					const pub = getRuntimePublicationService();
					await pub.recoverStaleTask({
						taskId: task.id,
						text,
						eventKind,
						now,
					});
					continue;
				}

				// SQLite path: existing synchronous transaction.
				const producerKind = task.type as "agent" | "bash";
				runAtomicWrite(db, "background-task.recoverStaleTask", (tx) => {
					const source = {
						producerKind,
						taskId: task.id,
						recipientId: task.parentNarratorId,
					};
					const run = task.logicalRunId
						? taskPublicationRun(task)
						: task.type === "bash" && !task.toolCallId && !task.executionAttempt
							? runtimePublication.store.registerLegacyUnknownBashFailure(source, tx)
							: runtimePublication.store.registerLegacyRunningRunSlots(
									source,
									{ kind: "persisted_task" },
									{},
									tx,
								);
					tx.update(backgroundTasks)
						.set({
							status: task.type === "bash" ? "failed" : "cancelled",
							output: text,
							outputBytes: Buffer.byteLength(text),
							completedAt: now,
							updatedAt: now,
						})
						.where(and(eq(backgroundTasks.id, task.id), eq(backgroundTasks.status, "running")))
						.run();
					runtimePublication.commit(
						{
							...run,
							eventKind,
							resultRef: runtimePublication.persistResult(run, text, tx),
							summary: text,
						},
						tx,
					);
				});
			}
			if (resolveRuntimeQueueBackend() === "postgres") getRuntimePublicationService().schedule();
			else runtimePublication.schedule();
		}

		// Only agent tasks carry a subagent narrator whose background fields describe the
		// run; a bash task has no narrator row of its own to reset.
		const narratorIds = [
			...new Set(
				staleTasks
					.filter((task) => task.type === "agent")
					.map((task) => task.subagentNarratorId ?? task.id),
			),
		];
		if (narratorIds.length > 0 && resolveRuntimeQueueBackend() !== "postgres") {
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
			// A paused transfer emits NOTHING here. The `cancelled` event is what
			// unblocks a waiting `Await`, and answering "cancelled" for a transfer that
			// is merely paused would tell the model the transfer is over. An Await that
			// waits out its timeout is recoverable; a wrong terminal answer is not.
			if (task.type === "transfer") continue;
			// Recovery may register a legacy run. Read its terminal output/run together
			// rather than pairing a new registration with the pre-recovery snapshot.
			const recovered = await this.getById(task.id);
			if (!recovered || recovered.status === "running") continue;
			const receipt = terminalWaitReceipt(recovered);
			if (recovered.status === "completed") {
				eventBus.emit({
					type: "background_task:completed",
					taskId: recovered.id,
					parentNarratorId: recovered.parentNarratorId,
					taskType: recovered.type,
					output: recovered.output,
					...receipt,
				});
			} else if (recovered.status === "failed" || recovered.status === "timeout") {
				eventBus.emit({
					type: "background_task:failed",
					taskId: recovered.id,
					parentNarratorId: recovered.parentNarratorId,
					taskType: recovered.type,
					status: recovered.status,
					error: recovered.output,
					...receipt,
				});
			} else {
				eventBus.emit({
					type: "background_task:cancelled",
					taskId: recovered.id,
					parentNarratorId: recovered.parentNarratorId,
					taskType: recovered.type,
					output: recovered.output,
					...receipt,
				});
			}
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
			agent: staleTasks.length - bashCount - transferIds.length,
			// Reported separately because these were PAUSED, not cancelled — the log is
			// how an operator tells "work was destroyed" from "work is resumable".
			transferPaused: transferIds.length,
		});
		return staleTasks.length + (await nextPage());
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
	 *
	 * B6 fix: on the PostgreSQL backend, the entire select + publication filter +
	 * delete runs inside a named composite (one withPgRetry transaction). On SQLite,
	 * the original sync path is preserved.
	 */
	async cleanupCompleted(olderThanMs: number = CLEANUP_RETENTION_MS): Promise<number> {
		const cutoff = new Date(Date.now() - olderThanMs).toISOString();

		if (resolveRuntimeQueueBackend() === "postgres") {
			// B6 fix: use the named PG composite. The activeAgentContinuations
			// filter is applied post-composite (it's in-memory state, not a DB
			// predicate).
			const pub = getRuntimePublicationService();
			const results = await pub.cleanupTasks({
				cutoff,
				limit: 100,
				excludedStatuses: ["running", "paused"],
				excludedNarratorStatuses: ["working", "waiting"],
				subagentPath: "subagentNarratorId",
			});
			const filtered = results.filter((r) => !this.activeAgentContinuations.has(r.id));
			if (filtered.length === 0) return 0;
			for (const row of filtered) this.cleanupRuntime(row.id);
			this.broadcastCleanupDelta(filtered);
			logger.debug("Cleaned up completed background tasks (PG)", {
				deleted: filtered.length,
			});
			return filtered.length;
		}

		// A bounded source-retention pass. Pending outbox/mailbox pointers keep their result alive.
		const rows = await db
			.select({
				id: backgroundTasks.id,
				logicalRunId: backgroundTasks.logicalRunId,
				parentNarratorId: backgroundTasks.parentNarratorId,
				type: backgroundTasks.type,
			})
			.from(backgroundTasks)
			.where(
				and(
					// `paused` is excluded alongside `running`: a paused transfer is
					// resumable work, not a finished row. Reaping it would delete the
					// drawer entry for a transfer the user can still continue — and since
					// the owning device_transfer_tasks row survives, the transfer would
					// resume with no task card anywhere.
					notInArray(backgroundTasks.status, ["running", "paused"]),
					lt(backgroundTasks.completedAt, cutoff),
					// A takeover temporarily cancels the projection, not the work. Keep
					// it while the child is held/running so its finalizer retains a row.
					notExists(
						db
							.select({ one: sql`1` })
							.from(narrators)
							.where(
								and(
									eq(
										narrators.id,
										sql`coalesce(${backgroundTasks.subagentNarratorId}, ${backgroundTasks.id})`,
									),
									or(
										inArray(narrators.status, ["working", "waiting"]),
										like(narrators.substatus, '%"taken_over"%'),
										like(narrators.substatus, '%"manual_override"%'),
									),
								),
							),
					),
				),
			)
			.limit(100)
			.all();
		// SQLite path: sync hasPendingSource.
		const pub = getRuntimePublicationService();
		const deletable: typeof rows = [];
		for (const row of rows) {
			if (this.activeAgentContinuations.has(row.id)) continue;
			if (!row.logicalRunId || row.type === "transfer") {
				deletable.push(row);
				continue;
			}
			const pending =
				pub.backend === "sqlite"
					? runtimePublication.hasPendingSource(taskPublicationRun(row))
					: await pub.hasPendingSource(taskPublicationRun(row));
			if (!pending) deletable.push(row);
		}

		if (deletable.length === 0) return 0;

		const deletableIds = deletable.map((row) => row.id);
		await db.delete(backgroundTasks).where(
			and(
				inArray(backgroundTasks.id, deletableIds),
				notInArray(backgroundTasks.status, ["running", "paused"]),
				lt(backgroundTasks.completedAt, cutoff),
				// A takeover temporarily cancels the projection, not the work. Keep
				// it while the child is held/running so its finalizer retains a row.
				notExists(
					db
						.select({ one: sql`1` })
						.from(narrators)
						.where(
							and(
								eq(
									narrators.id,
									sql`coalesce(${backgroundTasks.subagentNarratorId}, ${backgroundTasks.id})`,
								),
								or(
									inArray(narrators.status, ["working", "waiting"]),
									like(narrators.substatus, '%"taken_over"%'),
									like(narrators.substatus, '%"manual_override"%'),
								),
							),
						),
				),
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
		const fallbackParents = new Set(
			deletable.filter((row) => row.type === "agent").map((row) => row.parentNarratorId),
		);
		for (const [parentNarratorId, ids] of byParent) {
			void this.broadcastListDelta(
				parentNarratorId,
				// Reaped agents still have a narrator fallback; do not tell the client
				// to remove an item that the next page query will return again.
				fallbackParents.has(parentNarratorId) || ids.length > BACKGROUND_TASK_DELTA_MAX_REMOVE_IDS
					? { invalidate: true }
					: { removeIds: ids },
			).catch(() => {});
		}

		logger.debug("Cleaned up completed background tasks", { deleted: deletableIds.length });
		return deletableIds.length;
	}

	/** Broadcast cleanup deltas to affected parent narrators (shared by PG and SQLite paths). */
	private broadcastCleanupDelta(
		rows: ReadonlyArray<{ id: string; parentNarratorId: string; type: string }>,
	): void {
		const byParent = new Map<string, string[]>();
		for (const row of rows) {
			const ids = byParent.get(row.parentNarratorId);
			if (ids) ids.push(row.id);
			else byParent.set(row.parentNarratorId, [row.id]);
		}
		const fallbackParents = new Set(
			rows.filter((row) => row.type === "agent").map((row) => row.parentNarratorId),
		);
		for (const [parentNarratorId, ids] of byParent) {
			void this.broadcastListDelta(
				parentNarratorId,
				fallbackParents.has(parentNarratorId) || ids.length > BACKGROUND_TASK_DELTA_MAX_REMOVE_IDS
					? { invalidate: true }
					: { removeIds: ids },
			).catch(() => {});
		}
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
		const pub = getRuntimePublicationService();
		await pub.cancelAgentNarrator({ narratorId: subagentNarratorId, now });
		if (pub.backend === "sqlite") {
			const { narratorService } = await import("./narrator-service");
			await narratorService.updateStatus(subagentNarratorId, "idle", {
				substatus: ["interrupted"],
				skipErrorMessage: true,
			});
		}

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
