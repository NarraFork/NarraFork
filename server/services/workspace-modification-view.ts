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
 */
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../db";
import { fileAttributions, narrators, narratorToolCalls } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { normalizeWorkspacePath } from "./git-workspace";

/**
 * Row cap for a single view query.
 *
 * A long-running workspace accumulates unbounded attribution history, and the
 * panel only ever renders a recent window. The cap is applied in SQL so a large
 * workspace cannot turn this into a full-table read.
 */
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 2000;

/** How the change was made. */
export type ModificationAction = "write" | "edit" | "bash" | "external";

export interface ModificationActor {
	narratorId: string | null;
	/** Narrator title, for display. Null for external changes. */
	narratorTitle: string | null;
	/** Subagent type when the actor was a subagent, else null. */
	subagentType: string | null;
}

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
	/** Distinct actors that touched this file, most recent first. */
	actors: ModificationActor[];
	/** Whether any change to this file came from outside the tool path. */
	hasExternalChange: boolean;
	/** Whether any change to this file lacks confident attribution. */
	hasImpreciseAttribution: boolean;
}

export interface WorkspaceModificationView {
	workspacePath: string;
	deviceId: string;
	/** Newest-first change list, capped by `limit`. */
	timeline: ModificationEvent[];
	/** Per-file rollup of the same events. */
	byFile: FileModificationGroup[];
	/** True when older events exist beyond the returned window. */
	hasMore: boolean;
	/** Distinct actors seen in the returned window. */
	actors: ModificationActor[];
}

export interface WorkspaceModificationViewOptions {
	deviceId?: string;
	/** Max events to return (clamped to {@link MAX_EVENT_LIMIT}). */
	limit?: number;
	/** Restrict to changes at or after this ISO timestamp. */
	since?: string;
	/** Restrict to changes at or before this ISO timestamp. */
	until?: string;
	/** Restrict to a single actor; `"external"` selects unattributed changes. */
	narratorId?: string | "external";
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

/** Resolve narrator titles for display in one query. */
async function loadNarratorTitles(narratorIds: string[]): Promise<Map<string, string | null>> {
	if (narratorIds.length === 0) return new Map();
	const rows = await db
		.select({ id: narrators.id, title: narrators.title })
		.from(narrators)
		.where(inArray(narrators.id, narratorIds));
	return new Map(rows.map((row) => [row.id, row.title ?? null]));
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

	// Fetch one extra row to decide `hasMore` without a separate COUNT.
	const rows = await db
		.select({
			id: fileAttributions.id,
			filePath: fileAttributions.filePath,
			narratorId: fileAttributions.narratorId,
			subagentType: fileAttributions.subagentType,
			action: fileAttributions.action,
			toolName: fileAttributions.toolName,
			toolUseId: fileAttributions.toolUseId,
			changedAt: fileAttributions.changedAt,
		})
		.from(fileAttributions)
		.where(and(...conditions))
		.orderBy(desc(fileAttributions.changedAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const windowRows = hasMore ? rows.slice(0, limit) : rows;

	const titles = await loadNarratorTitles([
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
		const actor: ModificationActor = {
			narratorId: row.narratorId,
			narratorTitle: row.narratorId ? (titles.get(row.narratorId) ?? null) : null,
			subagentType: row.subagentType,
		};
		const precise = isPreciseAction(action);

		timeline.push({
			id: row.id,
			filePath: row.filePath,
			action,
			toolName: row.toolName,
			toolUseId: row.toolUseId,
			changedAt: row.changedAt,
			actor,
			treeHashAfter: row.toolUseId ? (treeHashes.get(row.toolUseId) ?? null) : null,
			preciseAttribution: precise,
		});

		actors.set(actorKey(actor), actor);

		// Rows arrive newest-first, so the first sighting of a file is its latest change.
		let group = byFile.get(row.filePath);
		if (!group) {
			group = {
				filePath: row.filePath,
				changeCount: 0,
				lastChangedAt: row.changedAt,
				actors: [],
				hasExternalChange: false,
				hasImpreciseAttribution: false,
			};
			byFile.set(row.filePath, group);
		}
		group.changeCount++;
		if (action === "external") group.hasExternalChange = true;
		if (!precise) group.hasImpreciseAttribution = true;
		if (!group.actors.some((existing) => actorKey(existing) === actorKey(actor))) {
			group.actors.push(actor);
		}
	}

	return {
		workspacePath: key,
		deviceId,
		timeline,
		byFile: [...byFile.values()].sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt)),
		hasMore,
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
