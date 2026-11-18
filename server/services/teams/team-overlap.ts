/**
 * Who is changing what across a project's teams, and the project's exclusive paths
 * (docs/PROJECT_TEAMS-PLAN.md §二.5 "独占路径", §二.10; X).
 *
 * CHANGED PATHS. Every active work item (not merged or cancelled, worktree recorded) carries the
 * paths its branch changed since its merge base with the base (`changed_paths_json`, at most
 * 2,000 paths and 128 KiB; past that only its top-level entries, directories ending in `/`) and
 * the head they were computed at (`changed_paths_at_sha`). A background pass keeps them current:
 * when a worker's run ends (its items first) and every two minutes, at most
 * {@link TEAM_CHANGED_PATHS_BATCH} items per pass, resuming after the last item it looked at.
 * An item whose head did not move is not listed again. Git runs only through the hardened,
 * read-only `team-git.ts` (a diff of two commits: no working tree, index or filter is read);
 * never on a request path. The pass writes only the two path columns, never `updated_at`, so it
 * never makes a coordinator's own change look concurrent.
 *
 * OVERLAPS. Per project, the stored paths of at most {@link TEAM_OVERLAP_PROJECT_ITEMS} active
 * items are compared: an item with at most {@link TEAM_OVERLAP_COMPARE_PATHS} paths path by path,
 * a larger (or collapsed) one by top-level entry. The result is an in-memory index per project
 * (item ids and paths only): rebuilt by the pass when stored paths change, otherwise on demand,
 * one item read at a time with a yield in between. Titles, states and team names are read when
 * the index is shown, so a finished item drops out at once. A NEW overlap between two teams is
 * recorded once per pair as `work.overlap` on both items and told to both coordinators, each at
 * most once per {@link TEAM_OVERLAP_NOTICE_INTERVAL_MS} (what waits is told with the next one).
 *
 * WHO SEES WHAT. A person sees a team's items whole when they are a member (may write to its
 * coordinator), the team name and item title when they may read the coordinator, and only
 * "another team" otherwise; an overlap no involved team of which they can read is not listed.
 * In a coordinator's conversation (team status, notices, a refused `work.ready`) another team's
 * name and titles appear only when everyone who can read this coordinator can read that one.
 *
 * EXCLUSIVE PATHS. A project lists path globs in `chapter_settings.teams.exclusivePaths` (nothing
 * by default). An item whose changes touch one takes the project's exclusive lock at `work.ready`
 * (`exclusive_key`, unique per project: the unique index makes the take atomic); a second item is
 * refused readiness naming the holder. The lock goes with the holder's merge or cancellation, or
 * a person with project manage access releases it (recorded).
 *
 * SQLite only, like the rest of the team surface.
 */

import {
	TEAM_CHANGED_DIR_SUFFIX,
	TEAM_CHANGED_PATHS_BATCH,
	TEAM_CHANGED_PATHS_INTERVAL_MS,
	TEAM_EXCLUSIVE_LOCK_KEY,
	TEAM_EXCLUSIVE_PATH_MAX_LENGTH,
	TEAM_EXCLUSIVE_PATHS_MAX,
	TEAM_OVERLAP_COMPARE_PATHS,
	TEAM_OVERLAP_LIST_LIMIT,
	TEAM_OVERLAP_NOTICE_INTERVAL_MS,
	TEAM_OVERLAP_PROJECT_ITEMS,
	TEAM_WORK_ITEM_FINISHED_STATES,
	type TeamExclusiveLockView,
	type TeamOverlapAccess,
	type TeamOverlapEntry,
	type TeamOverlapItemRef,
	type TeamOverlapResponse,
	type TeamWorkItemState,
} from "@shared/project-teams";
import { and, asc, desc, eq, gt, inArray, isNotNull, notInArray } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../../db";
import {
	narrators,
	narratorWorktreeResources,
	projects,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
} from "../../db/schema";
import { AppError, NotFoundError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import type { Locale } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { getTeamOverlapLabels } from "../../lib/prompts/team-coordinator-notes";
import { canReadNarrator, canWriteNarrator, type NarratorPrincipal } from "../narrator-acl";
import { type ChangedPaths, teamGit } from "./team-git";
import { recordWorkEvent, type WorkActor } from "./work-items";

const FINISHED = [...TEAM_WORK_ITEM_FINISHED_STATES];
/** Overlap entries one index keeps (the count of all is kept beside them). */
const INDEX_ENTRIES_MAX = 1000;
/** `work.overlap` events of one item looked at to tell whether a pair was already told. */
const PAIR_EVENT_SCAN = 200;
/** New cross-team pairs recorded per pass; the rest wait for the next pass. */
const NEW_PAIRS_PER_PASS = 50;
/** Paths named per pair in an event or a notice. */
const PAIR_PATH_SAMPLE = 5;
/** Lines one pending notice keeps per team. */
const NOTICE_LINES_MAX = 20;
/** Locks one project lists (one key today). */
const LOCKS_LISTED = 10;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─────────────────────────────────────────────────────────────────────────────
// Exclusive paths: the project setting and matching
// ─────────────────────────────────────────────────────────────────────────────

/** The exclusive path globs of a project setting value (`chapter_settings`), sanitized. */
export function exclusivePathsOf(chapterSettings: unknown): string[] {
	let value = chapterSettings;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	const teams = (value as { teams?: { exclusivePaths?: unknown } } | null)?.teams;
	const list = teams?.exclusivePaths;
	if (!Array.isArray(list)) return [];
	return list
		.filter(
			(glob): glob is string =>
				typeof glob === "string" &&
				glob.trim().length > 0 &&
				glob.length <= TEAM_EXCLUSIVE_PATH_MAX_LENGTH,
		)
		.map((glob) => glob.trim())
		.slice(0, TEAM_EXCLUSIVE_PATHS_MAX);
}

/** The project's exclusive path globs (primary-key read). */
export function projectExclusivePaths(projectId: string): string[] {
	const row = db
		.select({ settings: projects.chapterSettings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
		.get();
	return exclusivePathsOf(row?.settings);
}

const globCache = new Map<string, InstanceType<typeof Bun.Glob>>();
function glob(pattern: string) {
	let compiled = globCache.get(pattern);
	if (!compiled) {
		compiled = new Bun.Glob(pattern);
		if (globCache.size > 500) globCache.clear();
		globCache.set(pattern, compiled);
	}
	return compiled;
}

/**
 * Whether one stored changed path touches one glob. A collapsed top-level directory (`dir/`)
 * counts when the glob could match anything under it — its first segment matches the directory
 * or starts with `**` — so a collapsed item errs toward taking the lock.
 */
export function pathTouchesGlob(path: string, pattern: string): boolean {
	const normalized = pattern.replace(/^\.\//, "");
	if (!path.endsWith(TEAM_CHANGED_DIR_SUFFIX)) return glob(normalized).match(path);
	const dir = path.slice(0, -TEAM_CHANGED_DIR_SUFFIX.length);
	const first = normalized.split("/")[0] ?? "";
	if (first.startsWith("**")) return true;
	return normalized.includes("/") && glob(first).match(dir);
}

/** The changed paths that touch an exclusive glob (at most `limit`, in order). */
export function exclusiveHits(
	paths: readonly string[],
	globs: readonly string[],
	limit = PAIR_PATH_SAMPLE,
): string[] {
	if (globs.length === 0) return [];
	const hits: string[] = [];
	for (const path of paths) {
		if (globs.some((pattern) => pathTouchesGlob(path, pattern))) hits.push(path);
		if (hits.length >= limit) break;
	}
	return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Who may see another team in a coordinator's conversation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether another team's name and item titles may appear in a coordinator's conversation:
 * everyone who can read the viewer's coordinator can read the other's. `public` is readable by
 * every signed-in user; `project` by everyone inside the project gate, which every reader of a
 * non-public coordinator has passed. A private coordinator is never named to another team.
 */
export function teamDetailsVisibleAcross(
	viewer: { visibility: string },
	other: { visibility: string },
): boolean {
	if (other.visibility === "public") return true;
	return other.visibility === "project" && viewer.visibility !== "public";
}

interface CoordinatorFacts {
	id: string;
	title: string;
	visibility: string;
}

function coordinatorsOf(teamIds: readonly string[]): Map<string, CoordinatorFacts> {
	const ids = [...new Set(teamIds)];
	if (ids.length === 0) return new Map();
	return new Map(
		db
			.select({ id: narrators.id, title: narrators.title, visibility: narrators.visibility })
			.from(narrators)
			.where(inArray(narrators.id, ids))
			.all()
			.map((row) => [row.id, { id: row.id, title: row.title ?? "", visibility: row.visibility }]),
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The exclusive lock
// ─────────────────────────────────────────────────────────────────────────────

export interface ExclusiveHolder {
	id: string;
	teamId: string;
	title: string;
	state: TeamWorkItemState;
}

/** The item holding a project's lock, or null. */
export function exclusiveHolder(
	projectId: string,
	key: string = TEAM_EXCLUSIVE_LOCK_KEY,
): ExclusiveHolder | null {
	return (
		db
			.select({
				id: teamWorkItems.id,
				teamId: teamWorkItems.teamId,
				title: teamWorkItems.title,
				state: teamWorkItems.state,
			})
			.from(teamWorkItems)
			.where(and(eq(teamWorkItems.projectId, projectId), eq(teamWorkItems.exclusiveKey, key)))
			.limit(1)
			.get() ?? null
	);
}

/** The holder as a coordinator of `viewerTeamId` may read it (agent-facing, English). */
export function describeHolderFor(viewerTeamId: string, holder: ExclusiveHolder): string {
	if (holder.teamId === viewerTeamId) return `your work item "${holder.title}" (${holder.id})`;
	const coordinators = coordinatorsOf([viewerTeamId, holder.teamId]);
	const viewer = coordinators.get(viewerTeamId);
	const other = coordinators.get(holder.teamId);
	if (viewer && other && teamDetailsVisibleAcross(viewer, other))
		return `team "${other.title}"'s work item "${holder.title}" (${holder.state})`;
	return `a work item of another team (${holder.state})`;
}

/** Whether an error is the exclusive lock's unique index refusing a second holder. */
export function isExclusiveConflict(error: unknown): boolean {
	// The driver's error may arrive wrapped by the query builder: look down the cause chain.
	for (let current = error, depth = 0; current && depth < 5; depth++) {
		const text = current instanceof Error ? current.message : String(current);
		if (/UNIQUE constraint failed/i.test(text) && text.includes("exclusive_key")) return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

/**
 * A person with project manage access releases the project's lock from its holder (recorded on
 * the holder's team as `work.exclusive_released`, forced). The holder keeps its state.
 */
export function forceReleaseExclusiveLock(input: {
	projectId: string;
	workItemId: string;
	userId: string;
	reason?: string;
}): { released: boolean; key: string | null } {
	assertSqlite();
	const item = db
		.select({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			exclusiveKey: teamWorkItems.exclusiveKey,
		})
		.from(teamWorkItems)
		.where(
			and(eq(teamWorkItems.id, input.workItemId), eq(teamWorkItems.projectId, input.projectId)),
		)
		.limit(1)
		.get();
	if (!item) throw new NotFoundError("Work item", input.workItemId);
	if (!item.exclusiveKey) return { released: false, key: null };
	const key = item.exclusiveKey;
	const actor: WorkActor = { kind: "person", id: input.userId };
	const released = db.transaction((tx) => {
		const rows = tx
			.update(teamWorkItems)
			.set({ exclusiveKey: null })
			.where(and(eq(teamWorkItems.id, item.id), eq(teamWorkItems.exclusiveKey, key)))
			.returning({ id: teamWorkItems.id })
			.all();
		if (rows.length !== 1) return false;
		recordWorkEvent(tx, {
			teamId: item.teamId,
			workItemId: item.id,
			kind: "work.exclusive_released",
			actor,
			detail: { key, forced: true, reason: input.reason?.trim().slice(0, 500) || null },
		});
		return true;
	});
	if (released) logger.info("Team exclusive lock force-released", { workItemId: item.id, key });
	return { released, key: released ? key : null };
}

function assertSqlite(): void {
	if (activeDatabaseBackend !== "sqlite")
		throw new AppError("Teams are available on SQLite only", 503, "TEAMS_BACKEND_UNAVAILABLE");
}

// ─────────────────────────────────────────────────────────────────────────────
// Changed paths: reading git, storing the columns
// ─────────────────────────────────────────────────────────────────────────────

/** Where changed paths come from: the hardened git of `team-git.ts` (tests replace it). */
export interface ChangedPathsSource {
	head(worktree: string): Promise<string | null>;
	changed(worktree: string, baseRef: string): Promise<ChangedPaths | null>;
}

const hardenedSource: ChangedPathsSource = {
	head: (worktree) => teamGit(worktree).resolveCommit("HEAD"),
	changed: (worktree, baseRef) => teamGit(worktree).changedPaths(baseRef),
};

let sourceOverride: ChangedPathsSource | null = null;

/** Replace the git source (tests); null restores the hardened git. */
export function setChangedPathsSourceForTests(next: ChangedPathsSource | null): void {
	sourceOverride = next;
}

const source = () => sourceOverride ?? hardenedSource;

/** Read an item's changed paths now (hardened git). Null when they cannot be read. */
export async function readChangedPaths(
	worktree: string,
	baseRef: string,
): Promise<ChangedPaths | null> {
	return source().changed(worktree, baseRef);
}

/**
 * Store an item's changed paths. Only the two path columns: `updated_at` is the coordinator's
 * concurrency token and a background refresh must not move it. A finished item is left alone.
 */
export function storeChangedPaths(
	executor: Pick<typeof db, "update">,
	itemId: string,
	changed: Pick<ChangedPaths, "paths" | "head">,
): boolean {
	const rows = executor
		.update(teamWorkItems)
		.set({ changedPathsJson: changed.paths, changedPathsAtSha: changed.head })
		.where(and(eq(teamWorkItems.id, itemId), notInArray(teamWorkItems.state, FINISHED)))
		.returning({ id: teamWorkItems.id, projectId: teamWorkItems.projectId })
		.all();
	const row = rows[0];
	if (row) invalidateProjectOverlaps(row.projectId);
	return Boolean(row);
}

interface RefreshTarget {
	id: string;
	projectId: string;
	baseRef: string;
	worktree: string;
	atSha: string | null;
}

function refreshTargets(where: ReturnType<typeof and>, limit: number): RefreshTarget[] {
	return db
		.select({
			id: teamWorkItems.id,
			projectId: teamWorkItems.projectId,
			itemBase: teamWorkItems.baseRef,
			teamBase: projectTeams.baseBranch,
			worktree: narratorWorktreeResources.worktreePath,
			deviceId: narratorWorktreeResources.deviceId,
			atSha: teamWorkItems.changedPathsAtSha,
		})
		.from(teamWorkItems)
		.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.innerJoin(
			narratorWorktreeResources,
			eq(narratorWorktreeResources.id, teamWorkItems.worktreeResourceId),
		)
		.where(where)
		.orderBy(asc(teamWorkItems.id))
		.limit(limit)
		.all()
		.filter((row) => row.deviceId === "local")
		.map((row) => ({
			id: row.id,
			projectId: row.projectId,
			baseRef: row.itemBase ?? row.teamBase,
			worktree: row.worktree,
			atSha: row.atSha,
		}));
}

const activeWithWorktree = () =>
	and(notInArray(teamWorkItems.state, FINISHED), isNotNull(teamWorkItems.worktreeResourceId));

export type RefreshOutcome = "updated" | "unchanged" | "failed";

async function refreshTarget(target: RefreshTarget): Promise<RefreshOutcome> {
	try {
		const head = await source().head(target.worktree);
		if (!head) return "failed";
		if (head === target.atSha) return "unchanged";
		const changed = await source().changed(target.worktree, target.baseRef);
		if (!changed) return "failed";
		return storeChangedPaths(db, target.id, changed) ? "updated" : "unchanged";
	} catch (error) {
		logger.debug("Team changed paths could not be read", {
			workItemId: target.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return "failed";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The background pass
// ─────────────────────────────────────────────────────────────────────────────

interface IndexEntry {
	path: string;
	kind: "file" | "dir";
	/** Item ids, sorted. */
	items: string[];
}

export interface OverlapIndex {
	projectId: string;
	computedAt: string;
	/** Active items looked at, and whether more exist. */
	activeItems: number;
	capped: boolean;
	/** Item id → team id, for every item looked at. */
	teams: Map<string, string>;
	/** Sorted by path; at most {@link INDEX_ENTRIES_MAX}. */
	entries: IndexEntry[];
	entriesTotal: number;
	/** Items whose stored paths touch the project's exclusive paths (as set when built). */
	exclusive: Set<string>;
}

interface NoticeLine {
	itemId: string;
	otherItemId: string;
	otherTeamId: string;
	paths: string[];
}

export interface OverlapClock {
	now(): number;
	every(ms: number, fn: () => void): () => void;
}

const realClock: OverlapClock = {
	now: () => Date.now(),
	every(ms, fn) {
		const timer = setInterval(fn, ms);
		timer.unref?.();
		return () => clearInterval(timer);
	},
};

export interface OverlapNoticeInput {
	teamId: string;
	text: string;
	locale: Locale;
}
type NoticeDelivery = (input: OverlapNoticeInput) => Promise<void>;

/** Pinned across `--hot` reloads. */
const job = hotSafe("narrafork.teams.overlap", () => ({
	clock: realClock as OverlapClock,
	notify: null as NoticeDelivery | null,
	/** The pass resumes after this item id (null: from the start). */
	cursor: null as string | null,
	/** Items to look at first (their worker's run just ended). */
	pending: new Set<string>(),
	running: null as Promise<BatchResult> | null,
	stop: null as (() => void) | null,
	indexes: new Map<string, OverlapIndex>(),
	computing: new Map<string, Promise<OverlapIndex>>(),
	/** Projects whose stored paths changed since their index was built. */
	stale: new Set<string>(),
	lastNoticeAt: new Map<string, number>(),
	queuedNotices: new Map<string, NoticeLine[]>(),
}));

/** Replace the clock and the notice delivery (tests); nulls restore production. */
export function setOverlapSeamsForTests(seams: {
	clock?: OverlapClock | null;
	notify?: NoticeDelivery | null;
}): void {
	if (seams.clock !== undefined) job.clock = seams.clock ?? realClock;
	if (seams.notify !== undefined) job.notify = seams.notify;
}

/** Forget every cursor, index and notice (tests). */
export function resetOverlapStateForTests(): void {
	job.cursor = null;
	job.pending.clear();
	job.indexes.clear();
	job.computing.clear();
	job.stale.clear();
	job.lastNoticeAt.clear();
	job.queuedNotices.clear();
}

/** The pass's resume point (tests). */
export function overlapCursor(): string | null {
	return job.cursor;
}

/** Drop a project's index: the next reader rebuilds it from the stored paths. */
export function invalidateProjectOverlaps(projectId: string): void {
	job.stale.add(projectId);
}

export interface BatchResult {
	/** Items looked at (at most {@link TEAM_CHANGED_PATHS_BATCH}). */
	looked: number;
	updated: number;
	failed: number;
	/** The pass reached the last active item and starts over next time. */
	wrapped: boolean;
	/** Cross-team pairs newly recorded. */
	newPairs: number;
}

/**
 * One background pass: the items whose worker just ended a run, then the next items after the
 * cursor, together at most {@link TEAM_CHANGED_PATHS_BATCH}; then the overlaps of the projects
 * whose stored paths changed, their new cross-team pairs, and the notices due. One pass at a
 * time: a call while one runs shares its result; items queued meanwhile get one more pass.
 */
export function runChangedPathsPass(): Promise<BatchResult> {
	if (job.running) return job.running;
	const run = (async () => {
		try {
			return await passOnce();
		} finally {
			job.running = null;
			if (job.pending.size > 0) {
				void runChangedPathsPass().catch((error) =>
					logger.warn("Team changed paths pass failed", { error: String(error) }),
				);
			}
		}
	})();
	job.running = run;
	return run;
}

async function passOnce(): Promise<BatchResult> {
	const result: BatchResult = { looked: 0, updated: 0, failed: 0, wrapped: false, newPairs: 0 };
	if (activeDatabaseBackend !== "sqlite") return result;
	const pending = [...job.pending].slice(0, TEAM_CHANGED_PATHS_BATCH);
	for (const id of pending) job.pending.delete(id);
	const first = pending.length
		? refreshTargets(and(inArray(teamWorkItems.id, pending), activeWithWorktree()), pending.length)
		: [];
	const room = TEAM_CHANGED_PATHS_BATCH - first.length;
	const next =
		room > 0
			? refreshTargets(
					and(
						activeWithWorktree(),
						job.cursor ? gt(teamWorkItems.id, job.cursor) : undefined,
						first.length ? notInArray(teamWorkItems.id, pending) : undefined,
					),
					room,
				)
			: [];
	if (room > 0) {
		result.wrapped = next.length < room;
		job.cursor = result.wrapped ? null : (next.at(-1)?.id ?? null);
	}
	const projectsTouched = new Set<string>();
	for (const target of [...first, ...next]) {
		result.looked++;
		const outcome = await refreshTarget(target);
		if (outcome === "updated") {
			result.updated++;
			projectsTouched.add(target.projectId);
		} else if (outcome === "failed") result.failed++;
		await yieldToEventLoop();
	}
	for (const projectId of [...projectsTouched].sort()) {
		try {
			const index = await ensureProjectOverlaps(projectId);
			result.newPairs += recordNewCrossTeamPairs(index);
		} catch (error) {
			logger.warn("Team overlaps could not be computed", { projectId, error: String(error) });
		}
	}
	await flushNotices();
	return result;
}

/** Look at a worker's items first on the next pass, and start one. */
export function refreshItemsOfWorker(workerNarratorId: string): void {
	if (activeDatabaseBackend !== "sqlite") return;
	const rows = db
		.select({ id: teamWorkItems.id })
		.from(teamWorkItems)
		.where(
			and(
				eq(teamWorkItems.workerNarratorId, workerNarratorId),
				notInArray(teamWorkItems.state, FINISHED),
			),
		)
		.limit(10)
		.all();
	if (rows.length === 0) return;
	for (const row of rows) job.pending.add(row.id);
	void runChangedPathsPass().catch((error) =>
		logger.warn("Team changed paths pass failed", { error: String(error) }),
	);
}

/**
 * Start the background pass: every {@link TEAM_CHANGED_PATHS_INTERVAL_MS}, and after a team
 * subagent's run ends (its items first). Idempotent across `--hot` reloads. Returns the stop.
 */
export function startTeamOverlapJob(): () => void {
	job.stop?.();
	let stopped = false;
	const tick = () => {
		if (stopped) return;
		void runChangedPathsPass().catch((error) =>
			logger.warn("Team changed paths pass failed", { error: String(error) }),
		);
	};
	const cancelTimer = job.clock.every(TEAM_CHANGED_PATHS_INTERVAL_MS, tick);
	const onCompleted = (event: { narratorId: string }) => {
		if (stopped || activeDatabaseBackend !== "sqlite") return;
		try {
			refreshItemsOfWorker(event.narratorId);
		} catch (error) {
			logger.warn("Team changed paths refresh failed", { error: String(error) });
		}
	};
	let off = () => {};
	void import("../../lib/event-bus").then(({ eventBus }) => {
		if (stopped) return;
		eventBus.on("narrator:subagent_completed", onCompleted);
		off = () => eventBus.off("narrator:subagent_completed", onCompleted);
	});
	const stop = () => {
		stopped = true;
		cancelTimer();
		off();
		if (job.stop === stop) job.stop = null;
	};
	job.stop = stop;
	return stop;
}

// ─────────────────────────────────────────────────────────────────────────────
// Computing the overlaps of a project
// ─────────────────────────────────────────────────────────────────────────────

const topLevel = (path: string) => {
	const slash = path.indexOf("/");
	return slash < 0 ? path : path.slice(0, slash + 1);
};

/** Pure: the overlap entries of these items' stored paths. */
export function computeOverlapEntries(
	items: ReadonlyArray<{ id: string; paths: readonly string[] }>,
): IndexEntry[] {
	const byPath = new Map<string, { kind: "file" | "dir"; items: Set<string> }>();
	const add = (path: string, kind: "file" | "dir", ids: Iterable<string>) => {
		const entry = byPath.get(path) ?? { kind, items: new Set<string>() };
		for (const id of ids) entry.items.add(id);
		byPath.set(path, entry);
	};
	const files = new Map<string, Set<string>>();
	const tops = new Map<string, { items: Set<string>; coarse: boolean }>();
	for (const item of items) {
		const coarse =
			item.paths.length > TEAM_OVERLAP_COMPARE_PATHS ||
			item.paths.some((path) => path.endsWith(TEAM_CHANGED_DIR_SUFFIX));
		for (const path of item.paths) {
			if (!coarse) {
				const set = files.get(path) ?? new Set<string>();
				set.add(item.id);
				files.set(path, set);
			}
			const top = topLevel(path);
			const entry = tops.get(top) ?? { items: new Set<string>(), coarse: false };
			entry.items.add(item.id);
			if (coarse) entry.coarse = true;
			tops.set(top, entry);
		}
	}
	for (const [path, ids] of files) if (ids.size >= 2) add(path, "file", ids);
	// A coarse item compares by top-level entry with every other item.
	for (const [top, entry] of tops)
		if (entry.coarse && entry.items.size >= 2)
			add(top, top.endsWith(TEAM_CHANGED_DIR_SUFFIX) ? "dir" : "file", entry.items);
	return [...byPath.entries()]
		.map(([path, entry]) => ({ path, kind: entry.kind, items: [...entry.items].sort() }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function computeProjectOverlaps(projectId: string): Promise<OverlapIndex> {
	const rows = db
		.select({ id: teamWorkItems.id, teamId: teamWorkItems.teamId })
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.projectId, projectId), notInArray(teamWorkItems.state, FINISHED)))
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(TEAM_OVERLAP_PROJECT_ITEMS + 1)
		.all();
	const looked = rows.slice(0, TEAM_OVERLAP_PROJECT_ITEMS);
	const items: Array<{ id: string; paths: string[] }> = [];
	const globs = projectExclusivePaths(projectId);
	const exclusive = new Set<string>();
	// One item's paths (≤ 128 KiB) per read, with a yield between: never one large read.
	for (const row of looked) {
		const stored = db
			.select({ paths: teamWorkItems.changedPathsJson })
			.from(teamWorkItems)
			.where(eq(teamWorkItems.id, row.id))
			.limit(1)
			.get();
		const paths = Array.isArray(stored?.paths)
			? stored.paths.filter((path): path is string => typeof path === "string")
			: [];
		if (paths.length) items.push({ id: row.id, paths });
		if (exclusiveHits(paths, globs, 1).length) exclusive.add(row.id);
		await yieldToEventLoop();
	}
	const entries = computeOverlapEntries(items);
	return {
		projectId,
		computedAt: new Date(job.clock.now()).toISOString(),
		activeItems: looked.length,
		capped: rows.length > TEAM_OVERLAP_PROJECT_ITEMS,
		teams: new Map(looked.map((row) => [row.id, row.teamId])),
		entries: entries.slice(0, INDEX_ENTRIES_MAX),
		entriesTotal: entries.length,
		exclusive,
	};
}

/**
 * The project's overlap index: the cached one unless the stored paths changed since or it is
 * older than one pass interval; otherwise rebuilt (one build at a time per project).
 */
export async function ensureProjectOverlaps(projectId: string): Promise<OverlapIndex> {
	const cached = job.indexes.get(projectId);
	const fresh =
		cached &&
		!job.stale.has(projectId) &&
		job.clock.now() - Date.parse(cached.computedAt) < TEAM_CHANGED_PATHS_INTERVAL_MS;
	if (cached && fresh) return cached;
	const inFlight = job.computing.get(projectId);
	if (inFlight) return inFlight;
	job.stale.delete(projectId);
	const build = computeProjectOverlaps(projectId)
		.then((index) => {
			job.indexes.set(projectId, index);
			return index;
		})
		.finally(() => job.computing.delete(projectId));
	job.computing.set(projectId, build);
	return build;
}

interface LiveItem {
	id: string;
	teamId: string;
	title: string;
	state: TeamWorkItemState;
	branch: string | null;
	exclusiveKey: string | null;
}

/** The index's items as they are now; finished ones are left out. */
function liveItemsOf(index: OverlapIndex): Map<string, LiveItem> {
	const ids = [...index.teams.keys()];
	if (ids.length === 0) return new Map();
	return new Map(
		db
			.select({
				id: teamWorkItems.id,
				teamId: teamWorkItems.teamId,
				title: teamWorkItems.title,
				state: teamWorkItems.state,
				branch: teamWorkItems.branchName,
				exclusiveKey: teamWorkItems.exclusiveKey,
			})
			.from(teamWorkItems)
			.where(and(inArray(teamWorkItems.id, ids), notInArray(teamWorkItems.state, FINISHED)))
			.all()
			.map((row) => [row.id, row]),
	);
}

/** The index's entries restricted to live items (at least two left). */
function liveEntries(index: OverlapIndex, live: Map<string, LiveItem>): IndexEntry[] {
	return index.entries.flatMap((entry) => {
		const items = entry.items.filter((id) => live.has(id));
		return items.length >= 2 ? [{ ...entry, items }] : [];
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// New cross-team pairs: events and notices
// ─────────────────────────────────────────────────────────────────────────────

function toldPairs(itemId: string): Set<string> {
	const rows = db
		.select({ kind: teamWorkEvents.kind, detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.workItemId, itemId))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(PAIR_EVENT_SCAN)
		.all();
	const told = new Set<string>();
	for (const row of rows) {
		const other = row.kind === "work.overlap" ? row.detail?.with : undefined;
		if (typeof other === "string") told.add(other);
	}
	return told;
}

/**
 * Record each cross-team pair of the index not recorded before: one `work.overlap` event on
 * each item (`with`, `withTeam`, a few paths), and a notice line queued for each coordinator.
 * At most {@link NEW_PAIRS_PER_PASS} pairs per call. Returns how many were recorded.
 */
export function recordNewCrossTeamPairs(index: OverlapIndex): number {
	const live = liveItemsOf(index);
	const pairs = new Map<string, { a: string; b: string; paths: string[] }>();
	for (const entry of liveEntries(index, live)) {
		for (let i = 0; i < entry.items.length; i++)
			for (let j = i + 1; j < entry.items.length; j++) {
				const a = entry.items[i] as string;
				const b = entry.items[j] as string;
				if (live.get(a)?.teamId === live.get(b)?.teamId) continue;
				const key = `${a}\u0000${b}`;
				const pair = pairs.get(key) ?? { a, b, paths: [] };
				if (pair.paths.length < PAIR_PATH_SAMPLE) pair.paths.push(entry.path);
				pairs.set(key, pair);
			}
	}
	const told = new Map<string, Set<string>>();
	const toldOf = (id: string) => {
		let set = told.get(id);
		if (!set) {
			set = toldPairs(id);
			told.set(id, set);
		}
		return set;
	};
	let recorded = 0;
	const system: WorkActor = { kind: "system", id: null };
	for (const pair of [...pairs.values()].sort((x, y) =>
		x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1,
	)) {
		if (recorded >= NEW_PAIRS_PER_PASS) break;
		if (toldOf(pair.a).has(pair.b) || toldOf(pair.b).has(pair.a)) continue;
		const a = live.get(pair.a) as LiveItem;
		const b = live.get(pair.b) as LiveItem;
		const at = new Date(job.clock.now()).toISOString();
		db.transaction((tx) => {
			recordWorkEvent(tx, {
				teamId: a.teamId,
				workItemId: a.id,
				kind: "work.overlap",
				actor: system,
				detail: { with: b.id, withTeam: b.teamId, paths: pair.paths },
				at,
			});
			recordWorkEvent(tx, {
				teamId: b.teamId,
				workItemId: b.id,
				kind: "work.overlap",
				actor: system,
				detail: { with: a.id, withTeam: a.teamId, paths: pair.paths },
				at,
			});
		});
		toldOf(pair.a).add(pair.b);
		toldOf(pair.b).add(pair.a);
		queueNotice(a.teamId, {
			itemId: a.id,
			otherItemId: b.id,
			otherTeamId: b.teamId,
			paths: pair.paths,
		});
		queueNotice(b.teamId, {
			itemId: b.id,
			otherItemId: a.id,
			otherTeamId: a.teamId,
			paths: pair.paths,
		});
		recorded++;
	}
	return recorded;
}

function queueNotice(teamId: string, line: NoticeLine): void {
	const lines = job.queuedNotices.get(teamId) ?? [];
	if (lines.length < NOTICE_LINES_MAX) lines.push(line);
	job.queuedNotices.set(teamId, lines);
}

/** Whether the team is active and its coordinator not archived. */
function teamIsActive(teamId: string): boolean {
	const row = db
		.select({ status: projectTeams.status, coordinator: narrators.status })
		.from(projectTeams)
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(eq(projectTeams.narratorId, teamId))
		.limit(1)
		.get();
	return row?.status === "active" && row.coordinator !== "archived";
}

async function coordinatorLocale(teamId: string): Promise<Locale> {
	try {
		const { activeNarrators } = await import("../narrator-session-state");
		const locale = activeNarrators.get(teamId)?.locale;
		return locale === "zh-CN" ? "zh-CN" : "en";
	} catch {
		return "en";
	}
}

/** The notice text for one coordinator. Pure given the rows it reads. */
export function renderOverlapNotice(teamId: string, lines: NoticeLine[], locale: Locale): string {
	const t = getTeamOverlapLabels(locale);
	const titles = new Map(
		db
			.select({ id: teamWorkItems.id, title: teamWorkItems.title })
			.from(teamWorkItems)
			.where(
				inArray(
					teamWorkItems.id,
					lines.flatMap((line) => [line.itemId, line.otherItemId]),
				),
			)
			.all()
			.map((row) => [row.id, row.title]),
	);
	const coordinators = coordinatorsOf([teamId, ...lines.map((line) => line.otherTeamId)]);
	const viewer = coordinators.get(teamId);
	const body = lines.map((line) => {
		const other = coordinators.get(line.otherTeamId);
		const visible = viewer && other && teamDetailsVisibleAcross(viewer, other);
		return t.noticeLine(
			oneLine(titles.get(line.itemId) ?? line.itemId),
			visible ? oneLine(other.title) : null,
			visible ? oneLine(titles.get(line.otherItemId) ?? "") : null,
			line.paths.join(t.separator),
		);
	});
	return [t.noticeHeading, ...body, t.noticeAdvice].join("\n");
}

const oneLine = (value: string, max = 80) => {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

async function defaultNotify(input: OverlapNoticeInput): Promise<void> {
	const { deliverInjection } = await import("../narrator-injection");
	await deliverInjection(input.teamId, {
		content: input.text,
		source: "team_overlap",
		body: { kind: "prose", text: input.text },
		role: "sys",
		schedule: "wakeIfIdle",
		locale: input.locale,
	});
}

/** Tell each coordinator its queued new overlaps, at most once per notice interval. */
export async function flushNotices(): Promise<number> {
	let sent = 0;
	const now = job.clock.now();
	for (const teamId of [...job.queuedNotices.keys()].sort()) {
		const last = job.lastNoticeAt.get(teamId);
		if (last !== undefined && now - last < TEAM_OVERLAP_NOTICE_INTERVAL_MS) continue;
		const lines = job.queuedNotices.get(teamId) ?? [];
		job.queuedNotices.delete(teamId);
		if (lines.length === 0 || !teamIsActive(teamId)) continue;
		job.lastNoticeAt.set(teamId, now);
		try {
			const locale = await coordinatorLocale(teamId);
			await (job.notify ?? defaultNotify)({
				teamId,
				text: renderOverlapNotice(teamId, lines, locale),
				locale,
			});
			sent++;
		} catch (error) {
			logger.warn("Team overlap notice failed", { teamId, error: String(error) });
		}
	}
	return sent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading: "who is changing what" for a person
// ─────────────────────────────────────────────────────────────────────────────

async function teamAccessFor(
	teamIds: readonly string[],
	principal: NarratorPrincipal,
): Promise<Map<string, { access: TeamOverlapAccess; name: string }>> {
	const ids = [...new Set(teamIds)];
	if (ids.length === 0) return new Map();
	const rows = db
		.select({
			id: narrators.id,
			ownerUserId: narrators.ownerUserId,
			visibility: narrators.visibility,
			writeAudience: narrators.writeAudience,
			type: narrators.type,
			aclRootNarratorId: narrators.aclRootNarratorId,
			contextProjectId: narrators.contextProjectId,
			title: narrators.title,
		})
		.from(narrators)
		.where(inArray(narrators.id, ids))
		.all();
	const result = new Map<string, { access: TeamOverlapAccess; name: string }>();
	for (const row of rows) {
		const access: TeamOverlapAccess = (await canWriteNarrator(row, principal))
			? "member"
			: (await canReadNarrator(row, principal))
				? "reader"
				: "hidden";
		result.set(row.id, { access, name: row.title ?? "" });
	}
	return result;
}

function itemRef(
	item: LiveItem,
	team: { access: TeamOverlapAccess; name: string } | undefined,
): TeamOverlapItemRef {
	const access = team?.access ?? "hidden";
	if (access === "hidden") return { access };
	const base = { access, teamId: item.teamId, teamName: team?.name ?? "", title: item.title };
	return access === "member"
		? {
				...base,
				id: item.id,
				state: item.state,
				branch: item.branch,
				exclusiveKey: item.exclusiveKey,
			}
		: base;
}

/** Sort key of a ref: members' items first, then readers', then hidden; by team and title. */
const refOrder = (ref: TeamOverlapItemRef) =>
	`${ref.access === "member" ? 0 : ref.access === "reader" ? 1 : 2}\u0000${ref.teamName ?? ""}\u0000${ref.title ?? ""}\u0000${ref.id ?? ""}`;

/**
 * "Who is changing what" in a project, as this person may see it, plus the exclusive paths and
 * the lock. Bounded: one index (≤ 100 items), one `IN` read of those items, one of their teams.
 */
export async function readProjectOverlaps(
	projectId: string,
	principal: NarratorPrincipal,
	options: { canManageProject: boolean },
): Promise<TeamOverlapResponse> {
	assertSqlite();
	const index = await ensureProjectOverlaps(projectId);
	const live = liveItemsOf(index);
	const holderRows = db
		.select({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			title: teamWorkItems.title,
			state: teamWorkItems.state,
			branch: teamWorkItems.branchName,
			exclusiveKey: teamWorkItems.exclusiveKey,
		})
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.projectId, projectId), isNotNull(teamWorkItems.exclusiveKey)))
		.orderBy(asc(teamWorkItems.exclusiveKey))
		.limit(LOCKS_LISTED)
		.all();
	const teams = await teamAccessFor(
		[...[...live.values()].map((item) => item.teamId), ...holderRows.map((row) => row.teamId)],
		principal,
	);
	const visible: TeamOverlapEntry[] = [];
	for (const entry of liveEntries(index, live)) {
		const refs = entry.items.map((id) => {
			const item = live.get(id) as LiveItem;
			return itemRef(item, teams.get(item.teamId));
		});
		if (refs.every((ref) => ref.access === "hidden")) continue;
		refs.sort((a, b) => (refOrder(a) < refOrder(b) ? -1 : refOrder(a) > refOrder(b) ? 1 : 0));
		visible.push({ path: entry.path, kind: entry.kind, items: refs });
	}
	const locks: TeamExclusiveLockView[] = holderRows.map((row) => ({
		key: row.exclusiveKey as string,
		holder: itemRef(row, teams.get(row.teamId)),
		canRelease: options.canManageProject,
		...(options.canManageProject ? { holderId: row.id } : {}),
	}));
	return {
		computedAt: index.computedAt,
		activeItems: index.activeItems,
		activeItemsCapped: index.capped,
		entries: visible.slice(0, TEAM_OVERLAP_LIST_LIMIT),
		moreEntries:
			Math.max(0, visible.length - TEAM_OVERLAP_LIST_LIMIT) +
			Math.max(0, index.entriesTotal - index.entries.length),
		exclusivePaths: projectExclusivePaths(projectId),
		locks,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading: the team status section of one coordinator
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamOverlapStatusLine {
	path: string;
	kind: "file" | "dir";
	/** This team's item titles, sorted. */
	mine: string[];
	/** Other teams' items: team name and title, or null for both when not shown. */
	others: Array<{ team: string | null; title: string | null }>;
}

export interface TeamOverlapStatus {
	lines: TeamOverlapStatusLine[];
	/** All overlaps involving this team (lines may be fewer). */
	total: number;
	/** The project's lock: who holds it, as this coordinator may read it; null when free. */
	lock: { mine: boolean; title: string | null; team: string | null } | null;
	/** This team's items touching exclusive paths without holding the lock (titles). */
	unlocked: string[];
}

/** The status section of one team: its overlaps (at most `limit`), the lock. */
export async function teamOverlapStatus(
	teamId: string,
	projectId: string,
	limit: number,
): Promise<TeamOverlapStatus> {
	const index = await ensureProjectOverlaps(projectId);
	const live = liveItemsOf(index);
	const entries = liveEntries(index, live).filter((entry) =>
		entry.items.some((id) => live.get(id)?.teamId === teamId),
	);
	const holder = exclusiveHolder(projectId);
	const coordinators = coordinatorsOf([
		teamId,
		...[...live.values()].map((item) => item.teamId),
		...(holder ? [holder.teamId] : []),
	]);
	const viewer = coordinators.get(teamId);
	const shown = (otherTeamId: string) => {
		const other = coordinators.get(otherTeamId);
		return viewer && other && teamDetailsVisibleAcross(viewer, other) ? other : null;
	};
	const lines = entries.slice(0, limit).map((entry) => {
		const mine: string[] = [];
		const others: Array<{ team: string | null; title: string | null }> = [];
		for (const id of entry.items) {
			const item = live.get(id) as LiveItem;
			if (item.teamId === teamId) mine.push(oneLine(item.title));
			else {
				const other = shown(item.teamId);
				others.push(
					other
						? { team: oneLine(other.title, 60), title: oneLine(item.title) }
						: { team: null, title: null },
				);
			}
		}
		mine.sort();
		others.sort((a, b) => {
			const ka = `${a.team === null ? 1 : 0}${a.team ?? ""}\u0000${a.title ?? ""}`;
			const kb = `${b.team === null ? 1 : 0}${b.team ?? ""}\u0000${b.title ?? ""}`;
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		return { path: entry.path, kind: entry.kind, mine, others };
	});
	let lock: TeamOverlapStatus["lock"] = null;
	if (holder) {
		if (holder.teamId === teamId) lock = { mine: true, title: oneLine(holder.title), team: null };
		else {
			const other = shown(holder.teamId);
			lock = other
				? { mine: false, title: oneLine(holder.title), team: oneLine(other.title, 60) }
				: { mine: false, title: null, team: null };
		}
	}
	const unlocked = [...live.values()]
		.filter((item) => item.teamId === teamId && !item.exclusiveKey && index.exclusive.has(item.id))
		.map((item) => oneLine(item.title))
		.sort()
		.slice(0, limit);
	return { lines, total: entries.length, lock, unlocked };
}
