/**
 * Shared shapes for the background-task list surface.
 *
 * The list used to be polled (3 s while open, 10 s while closed) and returned
 * EVERY task a parent narrator had ever spawned. A long-lived narrator
 * accumulates hundreds of long-finished tasks, so that meant re-reading and
 * re-serializing hundreds of KB of dead rows every few seconds on the main
 * thread. This module defines the paged + versioned replacement: pages are
 * cursor-driven, and steady-state refreshes arrive as WS deltas.
 */

import type { ToolProgressPayload } from "./tool-progress";

/** Default page size for the cursor-paged list. */
export const BACKGROUND_TASK_LIST_PAGE_SIZE = 30;
/** Hard cap for a client-requested page size. */
export const BACKGROUND_TASK_LIST_MAX_PAGE_SIZE = 50;
/**
 * Cap for the first page's `activeTasks` set.
 *
 * Active tasks are returned in full (not paged) because the panel's whole job is
 * to show what is still running, and "still running" cannot be expressed as a
 * SQL ordering — `continued` / `child_running` are derived from narrator state.
 * The cap keeps that unpaged read bounded anyway; `activeTruncated` tells the
 * client the set was cut rather than letting it silently under-report.
 */
export const BACKGROUND_TASK_ACTIVE_LIMIT = 200;
/**
 * Max chars of `output` any LIST row may carry. The panel only renders a
 * preview and fetches full output from the dedicated /output endpoint, so the
 * list must never materialize a whole stored output (up to 512 KB per row).
 */
export const BACKGROUND_TASK_LIST_OUTPUT_PREVIEW_CHARS = 4_000;
/**
 * Above this many removals in one cleanup pass, a delta degrades to
 * `invalidate` instead of listing ids — a big reap is not worth a big frame.
 */
export const BACKGROUND_TASK_DELTA_MAX_REMOVE_IDS = 50;

/**
 * The kinds of work a background task row can represent.
 *
 * `transfer` rows are a PROJECTION of a `device_transfer_tasks` row, which owns
 * the transfer's durable state. They exist here only so a device transfer shows
 * up in the places a narrator's background work is expected: Await, the task
 * drawer, and completion notifications.
 */
export type BackgroundTaskType = "bash" | "agent" | "transfer";

/**
 * One row of the task list, normalized so the unified `background_tasks` table
 * and the legacy `narrators.is_background` rows have a single shape. The
 * normalization used to live in the frontend (`toUnifiedTasks`), which meant
 * every consumer had to know both field sets.
 */
export interface BackgroundTaskListItem {
	id: string;
	type: BackgroundTaskType;
	/** Raw persisted status of the row. */
	status: string;
	/**
	 * Status after reconciliation against the current narrator state. May be
	 * `continued` or `child_running`, neither of which exists in the DB enum.
	 */
	effectiveStatus: string;
	currentNarratorStatus: string | null;
	activeChildTaskCount: number;
	canCancelActiveWork: boolean;
	command: string | null;
	exitCode: number | null;
	toolUseId: string | null;
	subagentNarratorId: string | null;
	subagentType: string | null;
	alias: string | null;
	title: string | null;
	/** Preview only — truncated server-side. Use the /output endpoint for the full text. */
	output: string | null;
	/** True size of what the task produced (bytes), regardless of what is stored. */
	outputBytes: number;
	/**
	 * The STORED output is shorter than what the task produced (it exceeded the
	 * 512 KB storage cap). Distinct from `outputPreviewTruncated`: this one means
	 * bytes are gone for good, so even the /output endpoint cannot return them.
	 */
	outputTruncated: boolean;
	/**
	 * The `output` field above is a cut-down preview of the stored value.
	 *
	 * Kept separate from `outputTruncated` because conflating them makes a row look
	 * permanently lossy when the full text is in fact one request away — and cannot
	 * be derived from `outputBytes > output.length`, which is a byte/char comparison
	 * that is simply wrong for multi-byte output.
	 */
	outputPreviewTruncated: boolean;
	startedAt: string;
	completedAt: string | null;
	createdAt: string;
	/** True when this row came from the legacy `narrators.is_background` path. */
	legacy: boolean;
	/**
	 * `transfer` rows only: the live byte progress, JOINED from the owning
	 * `device_transfer_tasks` row at read time.
	 *
	 * Deliberately not a stored column on `background_tasks`. Progress changes
	 * every 500ms while a transfer runs; persisting it in both tables would mean
	 * two rows that must agree on a fast-moving value, and the projection exists
	 * precisely to avoid that.
	 */
	progress?: ToolProgressPayload;
}

export interface BackgroundTaskListPage {
	/**
	 * Identifies the server process that produced this list. A restart changes it,
	 * which tells the client its cached pages and version are meaningless.
	 */
	listEpoch: string;
	/** Monotonic per-parent list version; deltas carry the next value. */
	version: number;
	/** Count of tasks still doing work (includes derived continued/child_running). */
	activeCount: number;
	/** First page only: the full active set, capped at BACKGROUND_TASK_ACTIVE_LIMIT. */
	activeTasks?: BackgroundTaskListItem[];
	/** True when `activeTasks` hit the cap. */
	activeTruncated?: boolean;
	/** Cursor window over ALL tasks (active and terminal), newest first. */
	tasks: BackgroundTaskListItem[];
	nextCursor: string | null;
}

/**
 * Incremental list update pushed over the narrator WebSocket.
 *
 * `upsert` carries the whole row rather than a status patch so a client that has
 * never seen the task (a brand-new one) and a client that has (a status change)
 * take the same path.
 */
export interface BackgroundTaskListDelta {
	listEpoch: string;
	version: number;
	activeCount: number;
	upsert?: BackgroundTaskListItem;
	removeIds?: string[];
	/**
	 * The change cannot be expressed incrementally (bulk reap, restart recovery).
	 * The client must refetch the first page.
	 */
	invalidate?: boolean;
}

/**
 * A live progress update for one `transfer` row.
 *
 * Deliberately NOT a `BackgroundTaskListDelta`. That channel is strictly ordered:
 * the client refetches the whole first page whenever a version number is skipped
 * (see applyBackgroundTaskDelta). Progress arrives ~2×/s per active transfer, so
 * routing it through there would (a) make every dropped frame trigger a full
 * refetch, and (b) cost an activeCount query per frame.
 *
 * This frame carries no version because it needs none: each payload is a complete
 * snapshot, so a lost frame is corrected by the next one. It only ever updates a
 * row the client already has — it can neither insert, remove nor reorder.
 */
export interface BackgroundTaskProgressFrame {
	/** Must match the client's cached epoch, else the row set is meaningless. */
	listEpoch: string;
	taskId: string;
	progress: ToolProgressPayload;
}

/**
 * Whether a (possibly derived) status means the task still has work outstanding.
 *
 * `paused` counts as ACTIVE even though nothing is executing. A paused transfer
 * holds a resume checkpoint and is waiting on a decision — treating it as
 * terminal would drop it out of the active set and out of the drawer's running
 * count, i.e. a transfer the user deliberately paused would quietly vanish and
 * only reappear if they went looking through the full history.
 */
export function isBackgroundTaskActiveStatus(status: string): boolean {
	return (
		status === "running" ||
		status === "paused" ||
		status === "continued" ||
		status === "child_running"
	);
}

/** Descending `(createdAt, id)` comparator — the list's single ordering. */
export function compareBackgroundTaskListItemsDesc(
	a: Pick<BackgroundTaskListItem, "createdAt" | "id">,
	b: Pick<BackgroundTaskListItem, "createdAt" | "id">,
): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? 1 : -1;
}
