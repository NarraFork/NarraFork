/**
 * Unified file-modification view for one workspace.
 *
 * A worktree is shared: several narrators, their subagents, and the user's own
 * terminal or editor all write to the same directory. Existing views are scoped to
 * a single narrator's recorded tool calls, so none of them can answer "how did this
 * directory get into its current state" — the question that matters before
 * reverting anything.
 *
 * This service is read-only and keyed by workspace path, never by chapter, so it
 * covers chapter-bound narrators, standalone narrators and subagents alike.
 *
 * Two projections over the same events:
 *   - timeline: one entry per change, newest first — "what happened here"
 *   - byFile:   one entry per file with its contributors — "who touched this file"
 *
 * A caller that only renders `byFile` should ask for it by name (`projection: "byFile"`):
 * the timeline is the heavier half of the response and the Git panel refetches on a timer.
 *
 * Windowing differs between the two entry shapes, and the difference is the point:
 * without a path list the window is global (newest N changes anywhere in the workspace),
 * with one it is PER PATH, so a file in the caller's list is never crowded out of the
 * rollup by a busier neighbour. See {@link PER_PATH_EVENT_LIMIT}.
 */
import { and, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import {
	type AttributionActor,
	EXTERNAL_ACTOR,
	resolveAttributionActors,
} from "./attribution-actors";
import { normalizeWorkspacePath } from "./git-workspace";

/**
 * Row cap for a single view query.
 *
 * A long-running workspace accumulates unbounded attribution history, and the
 * panel only ever renders a recent window. The cap is applied in SQL so a large
 * workspace cannot turn this into a full-table read.
 *
 * This is the GLOBAL window, used when no path list is given. With one it would be the
 * wrong shape — see {@link PER_PATH_EVENT_LIMIT}.
 */
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 2000;

/**
 * Rows kept per path when {@link WorkspaceModificationViewOptions.filePaths} is given.
 *
 * A single global `ORDER BY changed_at DESC LIMIT 500` is the wrong window for the Git
 * panel: it is spent on whichever files happen to be hottest. Measured on this
 * repository's own workspace — 50 548 attribution rows, hottest path alone holding 911 —
 * a 200-file diff let a handful of paths consume the whole window, so the rest were
 * absent from `byFile` entirely and the panel rendered no badge for them. That is
 * indistinguishable, client-side, from "nobody touched this file".
 *
 * 10 is enough for everything the rollup derives: the newest actor, the distinct-actor
 * list, and the three boolean flags. Only `changeCount` is affected, and it saturates
 * rather than lying about who wrote the file.
 */
const PER_PATH_EVENT_LIMIT = 10;

/**
 * Paths per per-path query.
 *
 * Each path contributes its own indexed sub-select, so a shard is one statement with
 * `PATHS_PER_SHARD` index seeks. Sharding bounds the statement size (SQLite's default
 * `SQLITE_MAX_COMPOUND_SELECT` is 500, and the parameter count grows with it) while
 * keeping the round-trip count low: 200 paths is 4 statements, not 200.
 */
const PATHS_PER_SHARD = 50;

/**
 * Path ceiling for one per-path query.
 *
 * The total row bound is `paths * PER_PATH_EVENT_LIMIT`, so the path count is what keeps it
 * finite. 400 covers the largest list a caller can legitimately build — `getStatusSummary`
 * caps `files` at 200, and each of those may contribute a pre-rename alias — while holding
 * the worst case at 4 000 metadata rows across 8 statements. Excess paths are dropped
 * rather than silently unbounding the query; the caller could not render them anyway.
 */
const MAX_QUERY_PATHS = 400;

/** How the change was made. */
export type ModificationAction = "write" | "edit" | "bash" | "external";

/**
 * Who made a change.
 *
 * Re-exported from the shared actor module rather than defined here: this used to be a
 * weaker parallel shape (title only, no subagent type or parent), and having two
 * definitions of "actor" is what let the Git panel and this view disagree about the same
 * writer.
 */
export type ModificationActor = AttributionActor;

export interface ModificationEvent {
	id: string;
	/** Workspace-relative path as recorded. */
	filePath: string;
	action: ModificationAction;
	toolName: string | null;
	toolUseId: string | null;
	changedAt: string;
	actor: ModificationActor;
	/**
	 * Workspace state recorded immediately after this change, when known.
	 * Present for tool calls that captured a boundary; null for changes with no
	 * snapshot (remote device, non-git workspace, or pre-feature history).
	 */
	treeHashAfter: string | null;
	/**
	 * False when this change cannot be attributed to one actor with confidence.
	 *
	 * True precision requires that no other writer touched the workspace inside this
	 * change's window. Short, targeted commands take the workspace write lock and so
	 * qualify; background tasks, unbounded scripts and external edits do not.
	 */
	preciseAttribution: boolean;
}

export interface FileModificationGroup {
	filePath: string;
	changeCount: number;
	lastChangedAt: string;
	/** Actor of the most recent change, i.e. the one a badge should name. */
	lastActor: ModificationActor;
	/** Distinct actors that touched this file, most recent first. */
	actors: ModificationActor[];
	/** Whether any change to this file came from outside the tool path. */
	hasExternalChange: boolean;
	/** Whether any change to this file lacks confident attribution. */
	hasImpreciseAttribution: boolean;
	/**
	 * Whether any change came from a session that has since been deleted.
	 *
	 * `narrator_id` is `ON DELETE SET NULL`, so a deleted session's rows keep no id.
	 * Without this flag they are indistinguishable from "no idea who did this".
	 */
	hasDeletedActor: boolean;
}

export interface WorkspaceModificationView {
	workspacePath: string;
	deviceId: string;
	/**
	 * Newest-first change list, capped by `limit`. Omitted when the caller asked for
	 * {@link WorkspaceModificationViewOptions.projection} `"byFile"`.
	 *
	 * Optional because it is the expensive half of the response: one object per change
	 * carrying an id, a tool-use id, a tree hash and a full actor. The Git panel refetches
	 * every 30 s and renders only `byFile`, so shipping the timeline there was per-viewer
	 * bandwidth nobody read — exactly what the project's "no large fields in a list
	 * response" rule forbids.
	 */
	timeline?: ModificationEvent[];
	/** Per-file rollup of the same events. */
	byFile: FileModificationGroup[];
	/** True when older events exist beyond the returned window. */
	hasMore: boolean;
	/**
	 * Rows that actually took part in the aggregation.
	 *
	 * `hasMore` alone cannot tell a client whether an absent file means "no attribution
	 * recorded" or "the window did not reach it": the per-path boundary filter runs after
	 * the window is drawn, so a full window can still aggregate to an empty `byFile`.
	 * This is the post-filter count, so `windowCount === 0` with `hasMore === true` is
	 * readable as "everything in the window predates its file's own boundary".
	 */
	windowCount?: number;
	/** Distinct actors seen in the returned window. */
	actors: ModificationActor[];
}

export interface WorkspaceModificationViewOptions {
	deviceId?: string;
	/**
	 * Max events to return (clamped to {@link MAX_EVENT_LIMIT}).
	 *
	 * Applies to the GLOBAL window only, i.e. when {@link filePaths} is absent.
	 */
	limit?: number;
	/** Restrict to changes at or after this ISO timestamp. */
	since?: string;
	/** Restrict to changes at or before this ISO timestamp. */
	until?: string;
	/** Restrict to a single actor; `"external"` selects unattributed changes. */
	narratorId?: string | "external";
	/**
	 * Restrict to these paths.
	 *
	 * The Git panel only renders the files in the current diff, so scanning the rest of
	 * a long-lived workspace's history would be work nobody displays. Bounded by SQL so
	 * the row cap is spent on relevant rows.
	 *
	 * Passing this switches the window from global to per path (see
	 * {@link PER_PATH_EVENT_LIMIT}), which makes {@link limit} inapplicable. Capped at
	 * {@link MAX_QUERY_PATHS}.
	 */
	filePaths?: string[];
	/**
	 * Per-path start boundary (ISO, UTC). A path absent from the map is unbounded.
	 *
	 * Used with {@link filePaths} to express "changes since each file's own last
	 * commit", which is what makes the view answer "who caused the current uncommitted
	 * state" rather than "who ever touched this file".
	 */
	sinceByPath?: Map<string, string>;
	/**
	 * Old path → current path, for files git reports as renamed.
	 *
	 * Attribution rows are recorded under the path that was written at the time, so
	 * everything a session did to a file BEFORE it was renamed sits under the old path.
	 * Without aliasing those rows are orphaned twice over: the old path is not in the
	 * current diff, so nothing renders them, and the new path's row has no history of its
	 * own — which reproduces the "Unknown" badge this view exists to remove.
	 *
	 * Aliasing is applied to the rollup and to the per-path boundary lookup, so a renamed
	 * file's window is the one git resolved for it, not the old path's.
	 */
	pathAliases?: Map<string, string>;
	/**
	 * Which projections to build. Defaults to `"all"` for backward compatibility.
	 *
	 * `"byFile"` omits {@link WorkspaceModificationView.timeline} from the response.
	 */
	projection?: "all" | "byFile";
}

/**
 * An action is precisely attributable only when the write window was serialized.
 *
 * `write`/`edit` hold the workspace write lock for their whole window, so they are
 * always exact. `bash` is only serialized for short targeted commands, and that
 * decision is not stored per row, so it is treated as imprecise here rather than
 * claimed falsely. `external` has no actor at all.
 */
function isPreciseAction(action: ModificationAction): boolean {
	return action === "write" || action === "edit";
}

/** Resolve post-change workspace boundaries for the tool calls in this window. */
async function loadTreeHashes(toolUseIds: string[]): Promise<Map<string, string | null>> {
	if (toolUseIds.length === 0) return new Map();
	const rows = await db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			treeHashAfter: narratorToolCalls.treeHashAfter,
		})
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.toolUseId, toolUseIds));
	return new Map(rows.map((row) => [row.toolUseId, row.treeHashAfter]));
}

function actorKey(actor: ModificationActor): string {
	return `${actor.narratorId ?? "external"}\u0000${actor.subagentType ?? ""}`;
}

/**
 * Whether a row falls inside its path's own start boundary.
 *
 * Each file's window begins at ITS last commit, not at a single repository-wide one: in
 * the NarraFork repository 90 of 127 changed files were last committed before HEAD (median
 * 164 hours earlier), so one shared boundary discarded real contributors. A path with no
 * entry has never been committed, and everything recorded for it belongs to the current
 * round.
 */
function isAfterPathBoundary(
	filePath: string,
	changedAt: string,
	sinceByPath: Map<string, string> | undefined,
): boolean {
	if (!sinceByPath) return true;
	const boundary = sinceByPath.get(filePath);
	return boundary === undefined || changedAt > boundary;
}

/**
 * Map a recorded path to the path it is displayed under.
 *
 * Identity for everything except a renamed file's old path. Applied before both the
 * boundary check and the rollup so a rename's two halves are one file throughout: git
 * resolved the boundary for the CURRENT path, and checking the old path against it would
 * either find no entry (keeping pre-rename history that belongs to an earlier commit) or,
 * worse, find an unrelated entry left over from a different file that once had that name.
 */
function resolveDisplayPath(filePath: string, aliases: Map<string, string> | undefined): string {
	return aliases?.get(filePath) ?? filePath;
}

/** Columns the view reads. Deliberately no content-bearing field — this feeds a list UI. */
const EVENT_COLUMNS = {
	id: fileAttributions.id,
	filePath: fileAttributions.filePath,
	narratorId: fileAttributions.narratorId,
	subagentType: fileAttributions.subagentType,
	action: fileAttributions.action,
	toolName: fileAttributions.toolName,
	toolUseId: fileAttributions.toolUseId,
	changedAt: fileAttributions.changedAt,
};

/** One attribution row as the aggregation consumes it. */
interface EventRow {
	id: string;
	filePath: string;
	narratorId: string | null;
	subagentType: string | null;
	action: string;
	toolName: string | null;
	toolUseId: string | null;
	changedAt: string;
}

/**
 * Fetch the newest {@link PER_PATH_EVENT_LIMIT} rows for each of `filePaths`.
 *
 * Written as a union of per-path sub-selects rather than a window function on purpose.
 * `ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY changed_at DESC)` expresses the
 * same intent but cannot use `idx_file_attr_device_workspace_file` for the ordering —
 * `EXPLAIN QUERY PLAN` reports `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, and on this
 * repository's workspace (50 548 rows, 200 paths) it measured 67 ms against 15 ms for the
 * union, which does a plain indexed `SEARCH` per path with no sort at all. 67 ms of
 * synchronous `bun:sqlite` work every 30 s per open chapter is exactly the main-thread
 * cost the project's rules exclude from a request path.
 *
 * Rows come back unordered across paths; the caller sorts. Each sub-select is itself
 * ordered and bounded, so the total is `filePaths.length * PER_PATH_EVENT_LIMIT` at most.
 */
async function selectPerPathRows(filePaths: string[], baseConditions: SQL[]): Promise<EventRow[]> {
	const rows: EventRow[] = [];
	for (let offset = 0; offset < filePaths.length; offset += PATHS_PER_SHARD) {
		const shard = filePaths.slice(offset, offset + PATHS_PER_SHARD);
		const parts = shard.map(
			(filePath) => sql`
				select * from (
					select
						${fileAttributions.id} as "id",
						${fileAttributions.filePath} as "filePath",
						${fileAttributions.narratorId} as "narratorId",
						${fileAttributions.subagentType} as "subagentType",
						${fileAttributions.action} as "action",
						${fileAttributions.toolName} as "toolName",
						${fileAttributions.toolUseId} as "toolUseId",
						${fileAttributions.changedAt} as "changedAt"
					from ${fileAttributions}
					where ${and(...baseConditions, eq(fileAttributions.filePath, filePath))}
					order by ${fileAttributions.changedAt} desc
					limit ${PER_PATH_EVENT_LIMIT}
				)`,
		);
		rows.push(...(await db.all<EventRow>(sql.join(parts, sql` union all `))));
	}
	return rows;
}

/** Row count per recorded path, used to tell a saturated per-path slice from a complete one. */
function countRowsPerPath(rows: EventRow[]): number[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.filePath, (counts.get(row.filePath) ?? 0) + 1);
	return [...counts.values()];
}

/**
 * Build the unified modification view for a workspace.
 *
 * Returns only metadata — never file contents — so it stays safe to call for a
 * list UI regardless of how large the changed files are.
 */
export async function getWorkspaceModificationView(
	workspacePath: string,
	options: WorkspaceModificationViewOptions = {},
): Promise<WorkspaceModificationView> {
	const deviceId = options.deviceId ?? LOCAL_DEVICE_ID;
	// Remote paths are stored verbatim; local ones are normalized for comparison.
	const key = deviceId === LOCAL_DEVICE_ID ? normalizeWorkspacePath(workspacePath) : workspacePath;
	const limit = Math.min(Math.max(options.limit ?? DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);

	const conditions = [
		eq(fileAttributions.deviceId, deviceId),
		eq(fileAttributions.workspacePath, key),
	];
	if (options.since) conditions.push(gte(fileAttributions.changedAt, options.since));
	if (options.until) conditions.push(lte(fileAttributions.changedAt, options.until));
	if (options.narratorId === "external") {
		conditions.push(eq(fileAttributions.action, "external"));
	} else if (options.narratorId) {
		conditions.push(eq(fileAttributions.narratorId, options.narratorId));
	}
	const wantTimeline = (options.projection ?? "all") === "all";
	// An explicitly empty path list means "no files of interest", which must return
	// nothing rather than degrading to the whole workspace.
	if (options.filePaths?.length === 0) {
		return {
			workspacePath: key,
			deviceId,
			...(wantTimeline ? { timeline: [] } : {}),
			byFile: [],
			hasMore: false,
			windowCount: 0,
			actors: [],
		};
	}

	let rows: EventRow[];
	let hasMore: boolean;
	if (options.filePaths) {
		// Per-path window: every requested file gets its own slice, so a hot file cannot
		// crowd the others out of the rollup (see PER_PATH_EVENT_LIMIT). `limit` does not
		// apply here — it describes a global window, and honouring it would reintroduce
		// exactly the crowding this branch exists to prevent.
		rows = await selectPerPathRows(options.filePaths.slice(0, MAX_QUERY_PATHS), conditions);
		rows.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
		// A path that filled its own slice may well have more behind it. This is a weaker
		// claim than the global window's — it means "some file has older history" — but it
		// is the honest one for a per-path window, and `windowCount` is what a client
		// should read to tell an empty result apart from an exhausted one.
		hasMore = countRowsPerPath(rows).some((count) => count >= PER_PATH_EVENT_LIMIT);
	} else {
		// Fetch one extra row to decide `hasMore` without a separate COUNT.
		const fetched = await db
			.select(EVENT_COLUMNS)
			.from(fileAttributions)
			.where(and(...conditions))
			.orderBy(desc(fileAttributions.changedAt))
			.limit(limit + 1);
		hasMore = fetched.length > limit;
		rows = hasMore ? fetched.slice(0, limit) : fetched;
	}

	// `hasMore` is decided before the per-path boundary filter: it answers "is there
	// older history beyond this window", which the filter does not change. The
	// post-filter size is reported separately as `windowCount`, because a full window
	// that filters down to nothing is otherwise indistinguishable from an empty one.
	const windowRows = rows.filter((row) =>
		isAfterPathBoundary(
			resolveDisplayPath(row.filePath, options.pathAliases),
			row.changedAt,
			options.sinceByPath,
		),
	);

	const actorsById = await resolveAttributionActors([
		...new Set(windowRows.flatMap((row) => (row.narratorId ? [row.narratorId] : []))),
	]);
	const treeHashes = await loadTreeHashes([
		...new Set(windowRows.flatMap((row) => (row.toolUseId ? [row.toolUseId] : []))),
	]);

	const timeline: ModificationEvent[] = [];
	const byFile = new Map<string, FileModificationGroup>();
	const actors = new Map<string, ModificationActor>();

	for (const row of windowRows) {
		const action = row.action as ModificationAction;
		// A row with no id is either an external edit or a deleted session's leftover
		// (`narrator_id` is ON DELETE SET NULL); `action` is what separates them.
		const actor: ModificationActor = row.narratorId
			? (actorsById.get(row.narratorId) ?? { ...EXTERNAL_ACTOR, narratorId: row.narratorId })
			: EXTERNAL_ACTOR;
		const precise = isPreciseAction(action);
		// A rename's pre-rename rows are recorded under the old path but belong to the file
		// as it exists now, which is the only path the client has to key on.
		const displayPath = resolveDisplayPath(row.filePath, options.pathAliases);

		if (wantTimeline) {
			timeline.push({
				id: row.id,
				// The timeline reports the path as recorded: it answers "what happened",
				// and "wrote src/old.ts, then renamed it" is the truthful sequence.
				filePath: row.filePath,
				action,
				toolName: row.toolName,
				toolUseId: row.toolUseId,
				changedAt: row.changedAt,
				actor,
				treeHashAfter: row.toolUseId ? (treeHashes.get(row.toolUseId) ?? null) : null,
				preciseAttribution: precise,
			});
		}

		actors.set(actorKey(actor), actor);

		// Rows arrive newest-first, so the first sighting of a file is its latest change.
		let group = byFile.get(displayPath);
		if (!group) {
			group = {
				filePath: displayPath,
				changeCount: 0,
				lastChangedAt: row.changedAt,
				lastActor: actor,
				actors: [],
				hasExternalChange: false,
				hasImpreciseAttribution: false,
				hasDeletedActor: false,
			};
			byFile.set(displayPath, group);
		}
		group.changeCount++;
		if (action === "external") group.hasExternalChange = true;
		if (!precise) group.hasImpreciseAttribution = true;
		// A tool action with no narrator means the session was deleted and the FK nulled.
		if (!row.narratorId && action !== "external") group.hasDeletedActor = true;
		// An id that resolved to a missing row is the same situation, seen from a row
		// that still carries the id.
		if (row.narratorId && !actor.exists) group.hasDeletedActor = true;
		if (!group.actors.some((existing) => actorKey(existing) === actorKey(actor))) {
			group.actors.push(actor);
		}
	}

	return {
		workspacePath: key,
		deviceId,
		...(wantTimeline ? { timeline } : {}),
		byFile: [...byFile.values()].sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt)),
		hasMore,
		windowCount: windowRows.length,
		actors: [...actors.values()],
	};
}

/**
 * Whether a time window contains changes that cannot be confidently attributed.
 *
 * Used to warn before a revert: a workspace rollback restores everything in the
 * window, so a change made by another actor — or by a command whose write set was
 * never serialized — would be discarded along with the intended target.
 */
export async function findImpreciseChanges(
	workspacePath: string,
	options: { deviceId?: string; since?: string; until?: string; excludeNarratorId?: string } = {},
): Promise<{
	hasImprecise: boolean;
	externalCount: number;
	otherActorCount: number;
	unserializedCount: number;
	sampleFilePaths: string[];
}> {
	const deviceId = options.deviceId ?? LOCAL_DEVICE_ID;
	const key = deviceId === LOCAL_DEVICE_ID ? normalizeWorkspacePath(workspacePath) : workspacePath;

	const conditions = [
		eq(fileAttributions.deviceId, deviceId),
		eq(fileAttributions.workspacePath, key),
	];
	if (options.since) conditions.push(gte(fileAttributions.changedAt, options.since));
	if (options.until) conditions.push(lte(fileAttributions.changedAt, options.until));

	const rows = await db
		.select({
			filePath: fileAttributions.filePath,
			narratorId: fileAttributions.narratorId,
			action: fileAttributions.action,
		})
		.from(fileAttributions)
		.where(and(...conditions))
		.orderBy(desc(fileAttributions.changedAt))
		.limit(MAX_EVENT_LIMIT);

	let externalCount = 0;
	let otherActorCount = 0;
	let unserializedCount = 0;
	const samples = new Set<string>();

	for (const row of rows) {
		const action = row.action as ModificationAction;
		let imprecise = false;
		if (action === "external") {
			externalCount++;
			imprecise = true;
		} else if (action === "bash") {
			// Bash is only serialized for short targeted commands, and that is not
			// recorded per row, so its change set is not provably its own.
			unserializedCount++;
			imprecise = true;
		}
		if (
			options.excludeNarratorId &&
			row.narratorId &&
			row.narratorId !== options.excludeNarratorId
		) {
			otherActorCount++;
			imprecise = true;
		}
		if (imprecise && samples.size < 10) samples.add(row.filePath);
	}

	return {
		hasImprecise: externalCount + otherActorCount + unserializedCount > 0,
		externalCount,
		otherActorCount,
		unserializedCount,
		sampleFilePaths: [...samples],
	};
}
