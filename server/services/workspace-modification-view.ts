/**
 * Bounded historical observations, never ownership of a net diff. The optional
 * currentDiff projection independently fingerprints live Git targets and verifies v2
 * receipts. Per-path windows prevent hot files crowding out quiet ones; completeness
 * describes recorded rows in the requested window, not all real filesystem writes.
 */
import { posix } from "node:path";
import { and, desc, eq, gte, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type {
	FileChangeActor,
	FileChangeAttributionGrade,
	FileChangeProjectionCompleteness,
} from "../../shared/file-change-protocol";
import { db } from "../db";
import {
	fileAttributions,
	fileChangeEffects,
	fileChangeOperations,
	narratorToolCalls,
} from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import {
	type AttributionActor,
	attributionActorKey,
	resolveAttributionActors,
	resolveEventAttributionActor,
	resolveHumanAttributionActors,
} from "./attribution-actors";
import { type CurrentDiffView, getGitCurrentDiffView } from "./git-current-diff-view";
import { normalizeWorkspacePath } from "./git-workspace";

const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 2000;
/** Display budget, NOT sufficient to prove a complete contributor list or absent flags. */
const PER_PATH_EVENT_LIMIT = 10;
const PATHS_PER_SHARD = 50;
/** 400 paths; each of at most three canonical/legacy workspace spellings gets 10+1
 * indexed rows. Merge those bounded slices before returning at most ten per path. */
const MAX_QUERY_PATHS = 400;

export type ModificationAction = "write" | "edit" | "bash" | "external" | "human";
export type ModificationActor = AttributionActor;

export interface ModificationEvent {
	id: string;
	filePath: string;
	action: ModificationAction;
	toolName: string | null;
	toolUseId: string | null;
	changedAt: string;
	actor: ModificationActor;
	/** A historical boundary alone proves neither execution nor exclusive ownership. */
	treeHashAfter: string | null;
	/** Compatibility field. v1 observations never satisfy v2 measured-effect prerequisites. */
	preciseAttribution: boolean;
	evidence: "legacy" | "v2" | "mixed";
	attributionGrade: FileChangeAttributionGrade;
}

export interface FileModificationGroup {
	filePath: string;
	/** Observed count; see completeness.countsLowerBound before treating it as a total. */
	changeCount: number;
	lastChangedAt: string;
	/** These two fields belong to the same newest observed event. */
	lastActor: ModificationActor;
	lastAction: ModificationAction;
	/** Known subjects plus unknown identity buckets, newest first; not current diff owners. */
	actors: ModificationActor[];
	/** True = observed, false = absent from a complete window, null = unknown. */
	hasExternalChange: boolean | null;
	hasImpreciseAttribution: boolean | null;
	hasDeletedActor: boolean | null;
	completeness: FileChangeProjectionCompleteness;
	evidence: "legacy" | "v2" | "mixed";
	attributionGrade: FileChangeAttributionGrade;
}

export interface WorkspaceModificationView {
	/** Top-level arrays are historical observations; current targets are a separate projection. */
	source?: "history";
	currentDiff?: CurrentDiffView;
	nextCursor?: { changedAt: string; rowId: string } | null;
	workspacePath: string;
	deviceId: string;
	/** Omitted for the list-only projection, which also skips tree-boundary lookups. */
	timeline?: ModificationEvent[];
	byFile: FileModificationGroup[];
	/** More rows or requested paths exist beyond the bounded query. */
	hasMore: boolean;
	/** Rows that survived per-path timestamp filtering. Independent of hasMore. */
	windowCount?: number;
	actors: ModificationActor[];
	completeness: FileChangeProjectionCompleteness;
	evidence: "legacy" | "v2" | "mixed";
	/** Timestamp filters are not fingerprints of HEAD/index/worktree epochs. */
	baselineStatus: "unverified";
}

export interface WorkspaceAttributionScope {
	workspacePath: string;
	/** Git-root-relative prefix of the recorded cwd. Empty for the root itself. */
	prefix: string;
	/** Remote tools record absolute filenames; this is the target-normalized Git root. */
	absoluteGitRoot?: string;
	absoluteSeparator?: "/" | "\\";
}

export interface WorkspaceModificationViewOptions {
	deviceId?: string;
	/** Trusted scope adapters only, never forwarded directly from HTTP input. */
	additionalScopes?: WorkspaceAttributionScope[];
	/** Candidate/probe budgets were exhausted, so absence in unvisited cwd scopes is unknown. */
	additionalScopesTruncated?: boolean;
	/** Opt-in independent live Git/effect projection; never inferred from a timestamp. */
	currentDiff?: boolean;
	signal?: AbortSignal;
	/** Stable historical pagination only. rowId is not a business ID or execution order. */
	cursor?: { changedAt: string; rowId: string };
	/** Global row budget; filePaths instead uses a separate budget per recorded path. */
	limit?: number;
	since?: string;
	until?: string;
	narratorId?: string | "external";
	/** Explicitly empty means no files; extra paths are reported as incomplete. */
	filePaths?: string[];
	/** Historical timestamp hint only; cannot establish current net-diff ownership. */
	sinceByPath?: Map<string, string>;
	/** Old recorded path -> current display path for renames. */
	pathAliases?: Map<string, string>;
	projection?: "all" | "byFile";
}

/** Compare canonical UTC values, including equivalent caller-supplied offsets. */
function utcTimestamp(value: string): string {
	return new Date(value).toISOString();
}

function addTimeConditions(conditions: SQL[], options: { since?: string; until?: string }): void {
	if (options.since) conditions.push(gte(fileAttributions.changedAt, utcTimestamp(options.since)));
	if (options.until) conditions.push(lte(fileAttributions.changedAt, utcTimestamp(options.until)));
}

/** Completeness of stored-row coverage, not evidence that unrecorded writes do not exist. */
function completeness(
	complete: boolean,
	actors: ModificationActor[],
): FileChangeProjectionCompleteness {
	return {
		fileHistoryComplete: complete,
		contributorsTruncated: !complete,
		countsLowerBound: !complete || actors.some((actor) => !actor.identityKnown),
		warningScanComplete: complete && actors.every((actor) => actor.deleted !== null),
		asOfRevision: null,
	};
}

/** Only a v2 effect -> operation -> actual tool-call PK can bind a boundary.
 * Provider toolUseIds are reusable across forks/retries; v1 therefore stays unknown. */
async function loadTreeHashes(effectIds: string[]): Promise<Map<string, string | null>> {
	if (effectIds.length === 0) return new Map();
	const rows = await db
		.select({ effectId: fileChangeEffects.id, treeHashAfter: narratorToolCalls.treeHashAfter })
		.from(fileChangeEffects)
		.innerJoin(fileChangeOperations, eq(fileChangeOperations.id, fileChangeEffects.operationId))
		.innerJoin(narratorToolCalls, eq(narratorToolCalls.id, fileChangeOperations.toolCallId))
		.where(inArray(fileChangeEffects.id, effectIds))
		.limit(MAX_QUERY_PATHS * PER_PATH_EVENT_LIMIT);
	return new Map(rows.map((row) => [row.effectId, row.treeHashAfter]));
}

function resolveDisplayPath(filePath: string, aliases: Map<string, string> | undefined): string {
	return aliases?.get(filePath) ?? filePath;
}

// SQLite's non-unique indexes end in rowid: stable keyset ties need no temp sort.
const EVENT_ROW_ID = sql<number>`${fileAttributions}.rowid`;
const SNAPSHOT_COLUMN = sql<
	string | null
>`case when length(cast(${fileAttributions.actorSnapshotJson} as blob)) <= 8192 then ${fileAttributions.actorSnapshotJson} else null end`;

function actorSnapshot(value: string | FileChangeActor | null): FileChangeActor | null {
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		if (
			!parsed ||
			!["human", "primary", "subagent", "external_unknown"].includes(parsed.kind) ||
			typeof parsed.subjectKey !== "string" ||
			!parsed.subjectKey ||
			(parsed.narratorId !== null && typeof parsed.narratorId !== "string") ||
			(parsed.userId !== null && typeof parsed.userId !== "string") ||
			typeof parsed.deleted !== "boolean"
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

const EVENT_COLUMNS = {
	id: fileAttributions.id,
	rowId: EVENT_ROW_ID,
	effectId: fileAttributions.effectId,
	actorSnapshotJson: SNAPSHOT_COLUMN,
	filePath: fileAttributions.filePath,
	narratorId: fileAttributions.narratorId,
	userId: fileAttributions.userId,
	subagentType: fileAttributions.subagentType,
	action: fileAttributions.action,
	toolName: fileAttributions.toolName,
	toolUseId: fileAttributions.toolUseId,
	changedAt: fileAttributions.changedAt,
};

type EventRow = {
	id: string;
	rowId: number;
	effectId: string | null;
	actorSnapshotJson: string | FileChangeActor | null;
	filePath: string;
	narratorId: string | null;
	userId: string | null;
	subagentType: string | null;
	action: string;
	toolName: string | null;
	toolUseId: string | null;
	changedAt: string;
};

/**
 * Each indexed sub-select reads n+1, keeping only n. No unbounded GROUP BY, window
 * function or all-history flag scan on the request thread. A missing flag in a
 * truncated slice is unknown until an indexed exact projection can supply it.
 */
function safeGitRootPath(path: string): string | null {
	if (!path || posix.isAbsolute(path)) return null;
	const normalized = posix.normalize(path);
	return normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

function recordedScopePath(path: string, scope?: WorkspaceAttributionScope): string {
	if (!scope) return path;
	const rootPath = safeGitRootPath(path);
	if (!rootPath) return "\0outside-workspace";
	if (scope.absoluteGitRoot) {
		const separator = scope.absoluteSeparator ?? "/";
		return `${scope.absoluteGitRoot.replace(/[\\/]$/, "")}${separator}${rootPath.replaceAll(
			"/",
			separator,
		)}`;
	}
	return posix.relative(`/${scope.prefix}`, `/${rootPath}`);
}

function displayScopePath(path: string, scope?: WorkspaceAttributionScope): string {
	if (!scope) return path;
	if (scope.absoluteGitRoot) {
		const root = scope.absoluteGitRoot.replace(/[\\/]$/, "");
		const separator = scope.absoluteSeparator ?? "/";
		if (path !== root && !path.startsWith(`${root}${separator}`)) return "\0outside-workspace";
		return (
			safeGitRootPath(
				path.slice(root.length + (path === root ? 0 : 1)).replaceAll(separator, "/"),
			) ?? "\0outside-workspace"
		);
	}
	if (posix.isAbsolute(path)) return "\0outside-workspace";
	const rootPath = posix.normalize(posix.join(scope.prefix, path));
	return rootPath === ".." || rootPath.startsWith("../") ? "\0outside-workspace" : rootPath;
}

async function selectPerPathRows(
	filePaths: string[],
	baseConditions: SQL[],
	workspaceKeys: string[],
	scopes: ReadonlyMap<string, WorkspaceAttributionScope>,
): Promise<{ rows: EventRow[]; truncatedPaths: Set<string> }> {
	const rows: EventRow[] = [];
	const truncatedPaths = new Set<string>();
	const counts = new Map<string, number>();
	const shardSize = Math.min(PATHS_PER_SHARD, Math.max(1, Math.floor(400 / workspaceKeys.length)));
	for (let offset = 0; offset < filePaths.length; offset += shardSize) {
		const shard = filePaths.slice(offset, offset + shardSize);
		const parts = shard.flatMap((filePath) =>
			workspaceKeys.map(
				(workspaceKey) => sql`
				select * from (
					select
						${fileAttributions.id} as "id",
						${EVENT_ROW_ID} as "rowId",
						${fileAttributions.effectId} as "effectId",
						${SNAPSHOT_COLUMN} as "actorSnapshotJson",
						${filePath} as "filePath",
						${fileAttributions.narratorId} as "narratorId",
						${fileAttributions.userId} as "userId",
						${fileAttributions.subagentType} as "subagentType",
						${fileAttributions.action} as "action",
						${fileAttributions.toolName} as "toolName",
						${fileAttributions.toolUseId} as "toolUseId",
						${fileAttributions.changedAt} as "changedAt"
					from ${fileAttributions}
					where ${and(...baseConditions, eq(fileAttributions.workspacePath, workspaceKey), eq(fileAttributions.filePath, recordedScopePath(filePath, scopes.get(workspaceKey))))}
					order by ${fileAttributions.changedAt} desc, ${EVENT_ROW_ID} desc
					limit ${PER_PATH_EVENT_LIMIT + 1}
				)`,
			),
		);
		const fetched = await db.all<EventRow>(sql.join(parts, sql` union all `));
		fetched.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || b.rowId - a.rowId);
		for (const row of fetched) {
			const count = (counts.get(row.filePath) ?? 0) + 1;
			counts.set(row.filePath, count);
			if (count > PER_PATH_EVENT_LIMIT) truncatedPaths.add(row.filePath);
			else rows.push(row);
		}
	}
	return { rows, truncatedPaths };
}

export async function getWorkspaceModificationView(
	workspacePath: string,
	options: WorkspaceModificationViewOptions = {},
): Promise<WorkspaceModificationView> {
	const deviceId = options.deviceId ?? LOCAL_DEVICE_ID;
	const key = deviceId === LOCAL_DEVICE_ID ? normalizeWorkspacePath(workspacePath) : workspacePath;
	const workspaceKeys = new Set([key]);
	const scopes = new Map(
		(options.additionalScopes ?? []).slice(0, 32).map((scope) => [scope.workspacePath, scope]),
	);
	for (const scope of scopes.keys()) workspaceKeys.add(scope);
	if (deviceId === LOCAL_DEVICE_ID) {
		try {
			const canonical = (
				await localBackend.resolvePathIdentity(workspacePath, { signal: options.signal })
			).canonicalPath;
			// v2 stores backend-native canonical roots; legacy uses normalized comparison keys.
			workspaceKeys.add(canonical);
			workspaceKeys.add(normalizeWorkspacePath(canonical));
		} catch {
			/* Historic rows remain readable after a workspace disappears. */
		}
	}
	const limit = Math.min(Math.max(options.limit ?? DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);
	const conditions = [eq(fileAttributions.deviceId, deviceId)];
	addTimeConditions(conditions, options);
	if (options.narratorId === "external") {
		conditions.push(eq(fileAttributions.action, "external"));
	} else if (options.narratorId) {
		conditions.push(eq(fileAttributions.narratorId, options.narratorId));
	}
	if (options.cursor) {
		const rowId = Number(options.cursor.rowId);
		if (!/^[1-9]\d*$/.test(options.cursor.rowId) || !Number.isSafeInteger(rowId))
			throw new Error("Invalid historical row cursor");
		const timestamp = utcTimestamp(options.cursor.changedAt);
		conditions.push(
			or(
				lt(fileAttributions.changedAt, timestamp),
				and(eq(fileAttributions.changedAt, timestamp), lt(EVENT_ROW_ID, rowId)),
			) as SQL,
		);
	}
	const wantTimeline = (options.projection ?? "all") === "all";
	const current = async () =>
		options.currentDiff
			? getGitCurrentDiffView(workspacePath, {
					deviceId,
					filePaths: options.filePaths
						? [
								...new Set(
									options.filePaths.map((path) => resolveDisplayPath(path, options.pathAliases)),
								),
							]
						: undefined,
					signal: options.signal,
				})
			: undefined;
	if (options.filePaths?.length === 0) {
		return {
			source: "history",
			currentDiff: await current(),
			nextCursor: null,
			workspacePath: key,
			deviceId,
			...(wantTimeline ? { timeline: [] } : {}),
			byFile: [],
			hasMore: false,
			windowCount: 0,
			actors: [],
			completeness: completeness(true, []),
			evidence: "legacy",
			baselineStatus: "unverified",
		};
	}

	let rows: EventRow[];
	let hasMore: boolean;
	const incompleteDisplayPaths = new Set<string>();
	if (options.filePaths) {
		const paths = [...new Set(options.filePaths)];
		const selected = await selectPerPathRows(
			paths.slice(0, MAX_QUERY_PATHS),
			conditions,
			[...workspaceKeys],
			scopes,
		);
		rows = selected.rows;
		rows.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || b.rowId - a.rowId);
		for (const path of [...selected.truncatedPaths, ...paths.slice(MAX_QUERY_PATHS)]) {
			incompleteDisplayPaths.add(resolveDisplayPath(path, options.pathAliases));
		}
		hasMore = incompleteDisplayPaths.size > 0 || options.additionalScopesTruncated === true;
	} else {
		// Each canonical/legacy spelling gets its own indexed bound; IN + global
		// ORDER BY would otherwise sort the entire history across workspace keys.
		const fetched = (
			await Promise.all(
				[...workspaceKeys].map(async (workspaceKey) => {
					const rows = await db
						.select(EVENT_COLUMNS)
						.from(fileAttributions)
						.where(and(...conditions, eq(fileAttributions.workspacePath, workspaceKey)))
						.orderBy(desc(fileAttributions.changedAt), desc(EVENT_ROW_ID))
						.limit(limit + 1);
					return rows
						.map((row) => ({
							...row,
							filePath: displayScopePath(row.filePath, scopes.get(workspaceKey)),
						}))
						.filter((row) => row.filePath !== "\0outside-workspace");
				}),
			)
		).flat();
		fetched.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || b.rowId - a.rowId);
		hasMore = fetched.length > limit || options.additionalScopesTruncated === true;
		rows = fetched.slice(0, limit);
	}

	// Preserve hasMore even if timestamp filtering removes every row: absence of a
	// badge must not make a capped query look complete (the M0 window disclosure).
	const boundaries = new Map(
		[...(options.sinceByPath ?? [])].map(([path, since]) => [path, utcTimestamp(since)]),
	);
	const windowRows = rows.filter((row) => {
		const boundary = boundaries.get(resolveDisplayPath(row.filePath, options.pathAliases));
		return boundary === undefined || row.changedAt > boundary;
	});
	const snapshots = new Map(
		windowRows.map((row) => [row.id, actorSnapshot(row.actorSnapshotJson)]),
	);
	const [actorsById, humansById, treeHashes] = await Promise.all([
		resolveAttributionActors([
			...new Set(
				windowRows.flatMap((row) => {
					const id = snapshots.get(row.id)?.narratorId ?? row.narratorId;
					return id ? [id] : [];
				}),
			),
		]),
		resolveHumanAttributionActors([
			...new Set(
				windowRows.flatMap((row) => {
					const id = snapshots.get(row.id)?.userId ?? row.userId;
					return id ? [id] : [];
				}),
			),
		]),
		wantTimeline
			? loadTreeHashes([
					...new Set(windowRows.flatMap((row) => (row.effectId ? [row.effectId] : []))),
				])
			: Promise.resolve(new Map<string, string | null>()),
	]);

	const timeline: ModificationEvent[] = [];
	const byFile = new Map<string, FileModificationGroup>();
	const actors = new Map<string, ModificationActor>();
	for (const row of windowRows) {
		const action = row.action as ModificationAction;
		const actor = resolveEventAttributionActor(
			{ ...row, actorSnapshot: snapshots.get(row.id) },
			actorsById,
			humansById,
		);
		const evidence = row.effectId ? ("v2" as const) : ("legacy" as const);
		const grade: FileChangeAttributionGrade = actor.identityKnown
			? "observed_ambiguous"
			: "unknown";
		const displayPath = resolveDisplayPath(row.filePath, options.pathAliases);
		if (wantTimeline) {
			timeline.push({
				id: row.id,
				filePath: row.filePath,
				action,
				toolName: row.toolName,
				toolUseId: row.toolUseId,
				changedAt: row.changedAt,
				actor,
				treeHashAfter: row.effectId ? (treeHashes.get(row.effectId) ?? null) : null,
				preciseAttribution: false,
				evidence,
				attributionGrade: grade,
			});
		}
		actors.set(attributionActorKey(actor), actor);
		let group = byFile.get(displayPath);
		if (!group) {
			const complete =
				!options.cursor &&
				(options.filePaths ? !incompleteDisplayPaths.has(displayPath) : !hasMore);
			group = {
				filePath: displayPath,
				changeCount: 0,
				lastChangedAt: row.changedAt,
				lastActor: actor,
				lastAction: action,
				actors: [],
				hasExternalChange: complete ? false : null,
				hasImpreciseAttribution: true,
				hasDeletedActor: complete ? false : null,
				completeness: completeness(complete, []),
				evidence,
				attributionGrade: grade,
			};
			byFile.set(displayPath, group);
		}
		if (group.evidence !== evidence) group.evidence = "mixed";
		group.changeCount++;
		if (action === "external") group.hasExternalChange = true;
		if (actor.deleted === true) group.hasDeletedActor = true;
		else if (actor.deleted === null && group.hasDeletedActor !== true) group.hasDeletedActor = null;
		if (
			!group.actors.some((existing) => attributionActorKey(existing) === attributionActorKey(actor))
		) {
			group.actors.push(actor);
		}
	}
	for (const group of byFile.values()) {
		group.completeness = completeness(group.completeness.fileHistoryComplete, group.actors);
	}
	const seenActors = [...actors.values()];
	const historyEvidence = new Set([...byFile.values()].map((group) => group.evidence));
	const lastRow = rows.at(-1);
	return {
		source: "history",
		currentDiff: await current(),
		nextCursor:
			!options.filePaths && hasMore && lastRow
				? { changedAt: lastRow.changedAt, rowId: String(lastRow.rowId) }
				: null,
		workspacePath: key,
		deviceId,
		...(wantTimeline ? { timeline } : {}),
		byFile: [...byFile.values()].sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt)),
		hasMore,
		windowCount: windowRows.length,
		actors: seenActors,
		completeness: completeness(!hasMore && !options.cursor, seenActors),
		evidence:
			historyEvidence.size > 1 ? "mixed" : (historyEvidence.values().next().value ?? "legacy"),
		baselineStatus: "unverified",
	};
}

export interface ImpreciseChangesReport {
	/** Conservative warning signal, NOT proof that a known other actor changed the window. */
	hasImprecise: boolean;
	externalCount: number;
	otherActorCount: number;
	unserializedCount: number;
	humanCount: number;
	/** Rows whose subject FK is missing. Never synthesize a narrator/user name. */
	unknownCount: number;
	/** Non-external v1 observations lack settled measured effects, even Write/Edit. */
	legacyCount: number;
	hasMore: boolean;
	windowCount: number;
	warningScanComplete: boolean;
	countsLowerBound: boolean;
	completeness: FileChangeProjectionCompleteness;
	sampleFilePaths: string[];
}

/** Bounded warning scan: reaching the cap can never silently become "no risk". */
export async function findImpreciseChanges(
	workspacePath: string,
	options: { deviceId?: string; since?: string; until?: string; excludeNarratorId?: string } = {},
): Promise<ImpreciseChangesReport> {
	const deviceId = options.deviceId ?? LOCAL_DEVICE_ID;
	const key = deviceId === LOCAL_DEVICE_ID ? normalizeWorkspacePath(workspacePath) : workspacePath;
	const conditions = [
		eq(fileAttributions.deviceId, deviceId),
		eq(fileAttributions.workspacePath, key),
	];
	addTimeConditions(conditions, options);
	const fetched = await db
		.select({
			filePath: fileAttributions.filePath,
			narratorId: fileAttributions.narratorId,
			userId: fileAttributions.userId,
			action: fileAttributions.action,
		})
		.from(fileAttributions)
		.where(and(...conditions))
		.orderBy(desc(fileAttributions.changedAt))
		.limit(MAX_EVENT_LIMIT + 1);
	const hasMore = fetched.length > MAX_EVENT_LIMIT;
	const rows = fetched.slice(0, MAX_EVENT_LIMIT);
	let externalCount = 0;
	let otherActorCount = 0;
	let unserializedCount = 0;
	let humanCount = 0;
	let unknownCount = 0;
	let legacyCount = 0;
	const samples = new Set<string>();
	for (const row of rows) {
		if (row.action === "external") externalCount++;
		else {
			legacyCount++;
			if (!(row.action === "human" ? row.userId : row.narratorId)) unknownCount++;
			if (row.action === "bash") unserializedCount++;
			if (row.action === "human") humanCount++;
		}
		if (
			options.excludeNarratorId &&
			row.narratorId &&
			row.narratorId !== options.excludeNarratorId
		) {
			otherActorCount++;
		}
		// Every legacy observation is uncertain. A Write/Edit action name is not a receipt.
		if (samples.size < 10) samples.add(row.filePath);
	}
	return {
		hasImprecise: hasMore || rows.length > 0,
		externalCount,
		otherActorCount,
		unserializedCount,
		humanCount,
		unknownCount,
		legacyCount,
		hasMore,
		windowCount: rows.length,
		warningScanComplete: !hasMore,
		countsLowerBound: hasMore,
		completeness: {
			fileHistoryComplete: !hasMore,
			contributorsTruncated: hasMore,
			countsLowerBound: hasMore,
			warningScanComplete: !hasMore,
			asOfRevision: null,
		},
		sampleFilePaths: [...samples],
	};
}
