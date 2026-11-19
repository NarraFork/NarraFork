/**
 * Who is changing what across a project's teams, and the project's exclusive paths
 * (docs/PROJECT_TEAMS-PLAN.md §二.5 "独占路径", §二.10; X).
 *
 * CHANGED PATHS. Every active work item (not merged or cancelled, worktree recorded, team active)
 * carries the paths its branch changed since its merge base with the base (`changed_paths_json`,
 * at most 2,000 paths and 128 KiB; past that only its top-level entries, directories ending in
 * `/`) and the head they were computed at (`changed_paths_at_sha`). A background pass keeps them
 * current: every two minutes a sweep of at most {@link TEAM_CHANGED_PATHS_BATCH} items resuming
 * after the last item it looked at, and when a worker's run ends a pass over that worker's items
 * only. An item whose head did not move is not listed again. Each pass stops at
 * {@link PASS_DEADLINE_MS}. An item whose own attempt had a real share of that time (more than
 * 10 s of it left when it started) and still timed out counts as failed, the sweep goes on after
 * it, and it is skipped for the next {@link HUNG_BACKOFF_PASSES} passes, so a hung git never
 * stalls the refreshes; an item that merely started late ends the pass and is looked at first
 * by the next one. Git runs
 * only through the hardened, read-only `team-git.ts` (one `teamGit` per item per pass; a diff of
 * two commits reads no working tree, index or filter); never on a request path. The pass writes
 * only the two path columns, never `updated_at`, so it never makes a coordinator's own change
 * look concurrent.
 *
 * LANDED ITEMS. There is no merge action yet, so the pass also notices a `ready` item that landed
 * (`mergeIfLanded`, checked every pass even when the head did not move): the head recorded at
 * `work.ready`, whose changed paths there were not empty, is inside the base branch, the item's
 * branch ref is that head or also inside the base (no commit made after ready is dropped), and
 * its worker is not running. It becomes `merged` (`work.merged`, `detectedBy: ancestry`), which
 * releases its exclusive lock and drops it from the overlaps; `merged` is permanent, even if the
 * base is rewound later. An item in any other state is never merged this way, whatever its
 * worktree's HEAD points at. LIMITS: a squash or rebase merge (the head itself never reaches the
 * base) and a base that moved only on the remote (the local base branch of this repository is
 * what is read) are not detected; such an item stays open until it is cancelled, and a person can
 * release its lock. A ready item whose branch was reset or rewritten (it no longer contains the
 * head recorded at ready) keeps that recorded head and any lock it holds until it is cancelled
 * or a person releases the lock; the team status flags it.
 *
 * OVERLAPS. Per project, the stored paths of at most {@link TEAM_OVERLAP_PROJECT_ITEMS} active
 * items of active teams are compared: an item with at most {@link TEAM_OVERLAP_COMPARE_PATHS}
 * paths path by path, a larger (or collapsed) one by top-level entry. The result is an in-memory
 * index per project (item ids and paths only), built off the request path, one item at a time
 * with a yield in between: by the pass when stored paths change, by the team status, or in the
 * background when a person's request finds it stale (the request is answered from the last index,
 * marked stale). Titles, states and team names are read when the index is shown, so a finished
 * item drops out at once. A NEW overlap between two teams is recorded once per pair as
 * `work.overlap` on both items (at most {@link NEW_PAIRS_PER_PASS} pairs a pass, the rest on the
 * next one) and told to both coordinators, each at most once per
 * {@link TEAM_OVERLAP_NOTICE_INTERVAL_MS}; a coordinator a person stopped is not woken for it.
 *
 * WHO SEES WHAT. A person sees a team's items whole when they are a member (may write to its
 * coordinator), the team name and item title when they may read the coordinator, and only
 * "another team" otherwise; an overlap no involved team of which they can read is not listed,
 * and items they cannot see are not counted. In a coordinator's conversation (team status,
 * notices, a refused `work.ready`) another team's name and titles appear only when everyone who
 * can read this coordinator can read that one.
 *
 * EXCLUSIVE PATHS. A project lists path globs in `chapter_settings.teams.exclusivePaths` (nothing
 * by default; `dir/` and a bare name without glob characters cover everything under them). An
 * item whose changes touch one takes the project's exclusive lock at `work.ready`
 * (`exclusive_key`, unique per project: the unique index makes the take atomic); a second item is
 * refused readiness naming the holder. The lock goes with the holder's merge (as detected above)
 * or cancellation, with its team's archiving, or when a person with project manage access
 * releases it (recorded, and the holder's coordinator is told).
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
import { and, asc, desc, eq, gt, inArray, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../../db";
import {
	narrators,
	narratorWorktreeResources,
	projects,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
	users,
} from "../../db/schema";
import { AppError, NotFoundError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import type { Locale } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { getTeamOverlapLabels } from "../../lib/prompts/team-coordinator-notes";
import { canReadNarrator, canWriteNarrator, type NarratorPrincipal } from "../narrator-acl";
import { canReadProject } from "../project-acl";
import { type ChangedPaths, teamGit } from "./team-git";
import { markMergedByAncestry, recordWorkEvent, type WorkActor } from "./work-items";

const FINISHED = [...TEAM_WORK_ITEM_FINISHED_STATES];
/** Overlap entries one index keeps (the count of all is kept beside them). */
const INDEX_ENTRIES_MAX = 1000;
/** `work.overlap` events of one item read to tell whether a pair was already recorded. */
const PAIR_EVENT_SCAN = 200;
/** New cross-team pairs recorded per pass; the rest are recorded by the next pass. */
export const NEW_PAIRS_PER_PASS = 50;
/** Paths named per pair in an event or a notice, each cut to {@link PATH_SAMPLE_CHARS}. */
const PAIR_PATH_SAMPLE = 5;
const PATH_SAMPLE_CHARS = 300;
/** Lines one pending notice keeps per team, and the notice's UTF-8 budget. */
const NOTICE_LINES_MAX = 20;
export const NOTICE_MAX_BYTES = 4 * 1024;
/** Locks one project lists (one key today). */
const LOCKS_LISTED = 10;
/** A pass stops looking at more items after this long and resumes there next time. */
export const PASS_DEADLINE_MS = 60_000;
/** Passes an item a pass timed out on is skipped for. */
export const HUNG_BACKOFF_PASSES = 5;
/**
 * An item is treated as hung only when its own attempt started with more than this share of the
 * pass's time left (10 s of 60 s); one that started late just ends the pass.
 */
const HUNG_SHARE_OF_DEADLINE = 1 / 6;
/** Pair visits between two yields while pairing overlap entries. */
const PAIR_VISITS_PER_YIELD = 5000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
const samplePath = (path: string) =>
	path.length > PATH_SAMPLE_CHARS ? `${path.slice(0, PATH_SAMPLE_CHARS - 1)}…` : path;

// ─────────────────────────────────────────────────────────────────────────────
// Exclusive paths: the project setting and matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One exclusive path as stored: `./` dropped, and a trailing `/` (a directory) made `dir/**`.
 * A bare name without glob characters (`drizzle`) is matched as itself and everything under it.
 */
export function normalizeExclusivePath(pattern: string): string {
	const trimmed = pattern.trim().replace(/^(\.\/)+/, "");
	return trimmed.endsWith("/") ? `${trimmed.replace(/\/+$/, "")}/**` : trimmed;
}

/** Whether a pattern is made of `*` and `**` segments only (it matches everything): too broad. */
export function exclusivePathMatchesEverything(pattern: string): boolean {
	const segments = normalizeExclusivePath(pattern).split("/").filter(Boolean);
	return segments.every((segment) => /^\*+$/.test(segment));
}

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
		.map(normalizeExclusivePath)
		.filter((glob) => glob.length > 0 && !exclusivePathMatchesEverything(glob))
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

const GLOB_MAGIC = /[*?[\]{}!]/;

/**
 * Whether one stored changed path touches one exclusive path. A pattern without glob characters
 * names a file or a directory: it touches itself and everything under it. A collapsed top-level
 * directory (`dir/`) counts when the pattern could match anything under it — its first segment
 * matches the directory or starts with `**` — so a collapsed item errs toward taking the lock.
 */
export function pathTouchesGlob(path: string, pattern: string): boolean {
	const normalized = normalizeExclusivePath(pattern);
	if (!normalized) return false;
	const collapsed = path.endsWith(TEAM_CHANGED_DIR_SUFFIX);
	const plain = collapsed ? path.slice(0, -TEAM_CHANGED_DIR_SUFFIX.length) : path;
	if (!GLOB_MAGIC.test(normalized)) {
		if (plain === normalized || plain.startsWith(`${normalized}/`)) return true;
		// `drizzle/meta/x.json` collapsed to `drizzle/` may hold it.
		return collapsed && normalized.startsWith(`${plain}/`);
	}
	if (!collapsed) return glob(normalized).match(path);
	const first = normalized.split("/")[0] ?? "";
	if (first.startsWith("**")) return true;
	return normalized.includes("/") && glob(first).match(plain);
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
 * every signed-in user; `project` by everyone inside the project gate. Every reader of a
 * non-public coordinator has passed that gate except its owner, who reads it by ownership alone:
 * so the owner must still read the project (`ownerReadsProject`). A private coordinator is never
 * named to another team.
 */
export function teamDetailsVisibleAcross(
	viewer: { visibility: string; ownerReadsProject: boolean },
	other: { visibility: string },
): boolean {
	if (other.visibility === "public") return true;
	return (
		other.visibility === "project" && viewer.visibility !== "public" && viewer.ownerReadsProject
	);
}

interface CoordinatorFacts {
	id: string;
	title: string;
	visibility: string;
	ownerUserId: string | null;
	projectId: string | null;
}

function coordinatorsOf(teamIds: readonly string[]): Map<string, CoordinatorFacts> {
	const ids = [...new Set(teamIds)];
	if (ids.length === 0) return new Map();
	return new Map(
		db
			.select({
				id: narrators.id,
				title: narrators.title,
				visibility: narrators.visibility,
				ownerUserId: narrators.ownerUserId,
				projectId: projectTeams.projectId,
			})
			.from(narrators)
			.leftJoin(projectTeams, eq(projectTeams.narratorId, narrators.id))
			.where(inArray(narrators.id, ids))
			.all()
			.map((row) => [row.id, { ...row, title: row.title ?? "" }]),
	);
}

/** Whether a coordinator's owner may still read its project (no owner: admin-managed, yes). */
async function ownerReadsProject(coordinator: CoordinatorFacts): Promise<boolean> {
	if (!coordinator.ownerUserId) return true;
	if (!coordinator.projectId) return false;
	const project = db
		.select({ id: projects.id, ownerUserId: projects.ownerUserId, visibility: projects.visibility })
		.from(projects)
		.where(eq(projects.id, coordinator.projectId))
		.limit(1)
		.get();
	if (!project) return false;
	const user = db
		.select({ role: users.role })
		.from(users)
		.where(eq(users.id, coordinator.ownerUserId))
		.limit(1)
		.get();
	return canReadProject(project, {
		userId: coordinator.ownerUserId,
		isAdmin: user?.role === "admin",
	});
}

/** The other teams (of these) whose name and titles may appear in `viewerTeamId`'s conversation. */
async function namedTeamsFor(
	viewerTeamId: string,
	otherTeamIds: readonly string[],
): Promise<Map<string, CoordinatorFacts>> {
	const coordinators = coordinatorsOf([viewerTeamId, ...otherTeamIds]);
	const viewer = coordinators.get(viewerTeamId);
	const named = new Map<string, CoordinatorFacts>();
	if (!viewer) return named;
	const facts = {
		visibility: viewer.visibility,
		ownerReadsProject: await ownerReadsProject(viewer),
	};
	for (const id of new Set(otherTeamIds)) {
		const other = coordinators.get(id);
		if (other && id !== viewerTeamId && teamDetailsVisibleAcross(facts, other))
			named.set(id, other);
	}
	return named;
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
export async function describeHolderFor(
	viewerTeamId: string,
	holder: ExclusiveHolder,
): Promise<string> {
	if (holder.teamId === viewerTeamId) return `your work item "${holder.title}" (${holder.id})`;
	const other = (await namedTeamsFor(viewerTeamId, [holder.teamId])).get(holder.teamId);
	if (other) return `team "${other.title}"'s work item "${holder.title}" (${holder.state})`;
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

/** Clear one item's lock and record why. Synchronous: shares the caller's transaction. */
function releaseLock(
	executor: Pick<typeof db, "insert" | "update">,
	item: { id: string; teamId: string; exclusiveKey: string },
	actor: WorkActor,
	detail: Record<string, unknown>,
): boolean {
	const rows = executor
		.update(teamWorkItems)
		.set({ exclusiveKey: null })
		.where(and(eq(teamWorkItems.id, item.id), eq(teamWorkItems.exclusiveKey, item.exclusiveKey)))
		.returning({ id: teamWorkItems.id })
		.all();
	if (rows.length !== 1) return false;
	recordWorkEvent(executor, {
		teamId: item.teamId,
		workItemId: item.id,
		kind: "work.exclusive_released",
		actor,
		detail: { key: item.exclusiveKey, ...detail },
	});
	return true;
}

/**
 * A person with project manage access releases the project's lock from its holder: recorded on
 * the holder's team as `work.exclusive_released` (forced) and told to the holder's coordinator
 * (a row without a wake). The holder keeps its state.
 */
export async function forceReleaseExclusiveLock(input: {
	projectId: string;
	workItemId: string;
	userId: string;
	reason?: string;
}): Promise<{ released: boolean; key: string | null }> {
	assertSqlite();
	const item = db
		.select({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			title: teamWorkItems.title,
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
	const reason = input.reason?.trim().slice(0, 500) || null;
	const released = db.transaction((tx) =>
		releaseLock(
			tx,
			{ id: item.id, teamId: item.teamId, exclusiveKey: key },
			{ kind: "person", id: input.userId },
			{ forced: true, reason },
		),
	);
	if (!released) return { released: false, key: null };
	logger.info("Team exclusive lock force-released", { workItemId: item.id, key });
	invalidateProjectOverlaps(input.projectId);
	try {
		const locale = await coordinatorLocale(item.teamId);
		const text = getTeamOverlapLabels(locale).releasedNotice(oneLine(item.title), reason);
		await (job.notify ?? defaultNotify)({ teamId: item.teamId, text, locale, wake: false });
	} catch (error) {
		logger.warn("Team lock release notice failed", { teamId: item.teamId, error: String(error) });
	}
	return { released: true, key };
}

/** Release the locks a team's items hold (its coordinator was archived). Returns how many. */
export function releaseLocksOfTeam(teamId: string, reason: string): number {
	if (activeDatabaseBackend !== "sqlite") return 0;
	const held = db
		.select({
			id: teamWorkItems.id,
			teamId: teamWorkItems.teamId,
			projectId: teamWorkItems.projectId,
			exclusiveKey: teamWorkItems.exclusiveKey,
		})
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), isNotNull(teamWorkItems.exclusiveKey)))
		.limit(LOCKS_LISTED)
		.all();
	let released = 0;
	for (const row of held) {
		const ok = db.transaction((tx) =>
			releaseLock(
				tx,
				{ id: row.id, teamId: row.teamId, exclusiveKey: row.exclusiveKey as string },
				{ kind: "system", id: null },
				{ forced: false, reason },
			),
		);
		if (ok) {
			released++;
			invalidateProjectOverlaps(row.projectId);
		}
	}
	return released;
}

/** Backstop of the sweep: locks still held by items of archived teams (at most 10 a pass). */
function releaseLocksOfArchivedTeams(): number {
	const rows = db
		.select({ teamId: teamWorkItems.teamId })
		.from(teamWorkItems)
		.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(
			and(
				isNotNull(teamWorkItems.exclusiveKey),
				or(eq(projectTeams.status, "archived"), eq(narrators.status, "archived")),
			),
		)
		.limit(LOCKS_LISTED)
		.all();
	let released = 0;
	for (const teamId of new Set(rows.map((row) => row.teamId)))
		released += releaseLocksOfTeam(teamId, "team_archived");
	return released;
}

function assertSqlite(): void {
	if (activeDatabaseBackend !== "sqlite")
		throw new AppError("Teams are available on SQLite only", 503, "TEAMS_BACKEND_UNAVAILABLE");
}

/** Items of active teams only: the team row is active and its coordinator not archived. */
const teamIsLive = () => and(eq(projectTeams.status, "active"), ne(narrators.status, "archived"));

// ─────────────────────────────────────────────────────────────────────────────
// Changed paths: reading git, storing the columns
// ─────────────────────────────────────────────────────────────────────────────

/** One worktree's git as the pass needs it (one per item per pass). */
export interface ChangedPathsGit {
	head(): Promise<string | null>;
	resolve(ref: string): Promise<string | null>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	changed(baseRef: string): Promise<ChangedPaths | null>;
}

/** Where changed paths come from: the hardened git of `team-git.ts` (tests replace it). */
export type ChangedPathsSource = (worktree: string) => ChangedPathsGit;

const hardenedSource: ChangedPathsSource = (worktree) => {
	const git = teamGit(worktree);
	return {
		head: () => git.resolveCommit("HEAD"),
		resolve: (ref) => git.resolveCommit(ref),
		isAncestor: (ancestor, descendant) => git.isAncestor(ancestor, descendant),
		changed: (baseRef) => git.changedPaths(baseRef),
	};
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
	return source()(worktree).changed(baseRef);
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
			atSha: teamWorkItems.changedPathsAtSha,
		})
		.from(teamWorkItems)
		.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.innerJoin(
			narratorWorktreeResources,
			eq(narratorWorktreeResources.id, teamWorkItems.worktreeResourceId),
		)
		.where(and(where, teamIsLive(), eq(narratorWorktreeResources.deviceId, "local")))
		.orderBy(asc(teamWorkItems.id))
		.limit(limit)
		.all()
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

export type RefreshOutcome = "updated" | "unchanged" | "merged" | "failed";

/**
 * Whether a `ready` item landed: all of
 *  1. it is `ready` (never queued, in progress or in review);
 *  2. the evidence recorded at `work.ready`: its head there is the item's recorded head, and the
 *     changed paths computed there were not empty (never derived again later);
 *  3. its worker is not running;
 *  4. that head is an ancestor of the base, and the item's BRANCH (`refs/heads/<branch>`, never
 *     the worktree's HEAD) is that head or also inside the base — commits made after ready are
 *     never dropped.
 * Then it is merged, if it is still exactly what was read (checked in the transaction).
 */
async function mergeIfLanded(target: RefreshTarget, git: ChangedPathsGit): Promise<boolean> {
	const item = db
		.select({
			state: teamWorkItems.state,
			headSha: teamWorkItems.headSha,
			updatedAt: teamWorkItems.updatedAt,
			branch: teamWorkItems.branchName,
			worker: teamWorkItems.workerNarratorId,
		})
		.from(teamWorkItems)
		.where(eq(teamWorkItems.id, target.id))
		.limit(1)
		.get();
	if (!item || item.state !== "ready" || !item.headSha || !item.branch) {
		job.readyRewound.delete(target.id);
		return false;
	}
	const tip = await git.resolve(`refs/heads/${item.branch}`);
	// The branch no longer holds the head recorded at ready (reset or rewritten): flagged in the
	// team status; the item keeps that head and its lock until cancelled or force-released.
	const rewound =
		tip !== null && tip !== item.headSha && !(await git.isAncestor(item.headSha, tip));
	if (rewound) job.readyRewound.add(target.id);
	else job.readyRewound.delete(target.id);
	if (!tip || rewound) return false;
	const ready = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, target.id), eq(teamWorkEvents.kind, "work.ready")))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get()?.detail;
	const count = ready?.changedPathCount;
	if (ready?.head !== item.headSha || typeof count !== "number" || count <= 0) return false;
	if (item.worker) {
		const worker = db
			.select({ status: narrators.status })
			.from(narrators)
			.where(eq(narrators.id, item.worker))
			.limit(1)
			.get();
		if (worker && worker.status !== "idle" && worker.status !== "archived") return false;
	}
	const base = await git.resolve(target.baseRef);
	if (!base || !(await git.isAncestor(item.headSha, base))) return false;
	if (tip !== item.headSha && !(await git.isAncestor(tip, base))) return false;
	return markMergedByAncestry({
		itemId: target.id,
		head: item.headSha,
		base,
		expectedHeadSha: item.headSha,
		expectedUpdatedAt: item.updatedAt,
	});
}

async function refreshTarget(target: RefreshTarget): Promise<RefreshOutcome> {
	try {
		const git = source()(target.worktree);
		const head = await git.head();
		if (!head) return "failed";
		let outcome: RefreshOutcome = "unchanged";
		if (head !== target.atSha) {
			const changed = await git.changed(target.baseRef);
			if (!changed) return "failed";
			if (storeChangedPaths(db, target.id, changed)) outcome = "updated";
		}
		// Landed? Checked every pass: the base moves without the item's head moving.
		return (await mergeIfLanded(target, git)) ? "merged" : outcome;
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
	/** Start a turn when the coordinator is idle (never for one a person stopped). */
	wake: boolean;
}
type NoticeDelivery = (input: OverlapNoticeInput) => Promise<void>;

/** Pinned across `--hot` reloads. */
const job = hotSafe("narrafork.teams.overlap", () => ({
	clock: realClock as OverlapClock,
	notify: null as NoticeDelivery | null,
	deadlineMs: PASS_DEADLINE_MS,
	/** The sweep resumes after this item id (null: from the start). */
	cursor: null as string | null,
	/** Items to look at first (their worker's run just ended). */
	pending: new Set<string>(),
	running: null as Promise<BatchResult> | null,
	/** Whether the running pass is a sweep, and whether a sweep was asked for during another. */
	runningSweep: false,
	sweepAfter: false,
	/** Passes so far, and item id → the pass number until which a hung item is skipped. */
	passNumber: 0,
	backoff: new Map<string, number>(),
	/** Ready items whose branch no longer contains the head recorded at ready. */
	readyRewound: new Set<string>(),
	stop: null as (() => void) | null,
	indexes: new Map<string, OverlapIndex>(),
	computing: new Map<string, Promise<OverlapIndex>>(),
	/** Projects whose stored paths changed since their index was built. */
	stale: new Set<string>(),
	/** Projects with new cross-team pairs not recorded yet (over the per-pass cap). */
	pairBacklog: new Set<string>(),
	lastNoticeAt: new Map<string, number>(),
	queuedNotices: new Map<string, NoticeLine[]>(),
}));

/** Replace the clock and the notice delivery (tests); nulls restore production. */
export function setOverlapSeamsForTests(seams: {
	clock?: OverlapClock | null;
	notify?: NoticeDelivery | null;
	deadlineMs?: number | null;
}): void {
	if (seams.clock !== undefined) job.clock = seams.clock ?? realClock;
	if (seams.notify !== undefined) job.notify = seams.notify;
	if (seams.deadlineMs !== undefined) job.deadlineMs = seams.deadlineMs ?? PASS_DEADLINE_MS;
}

/** Forget every cursor, index and notice (tests). */
export function resetOverlapStateForTests(): void {
	job.cursor = null;
	job.pending.clear();
	job.indexes.clear();
	job.computing.clear();
	job.stale.clear();
	job.pairBacklog.clear();
	job.lastNoticeAt.clear();
	job.queuedNotices.clear();
	job.backoff.clear();
	job.readyRewound.clear();
	job.sweepAfter = false;
}

/** The sweep's resume point (tests). */
export function overlapCursor(): string | null {
	return job.cursor;
}

/** Mark a project's index stale: the next builder rebuilds it from the stored paths. */
export function invalidateProjectOverlaps(projectId: string): void {
	job.stale.add(projectId);
}

export interface BatchResult {
	/** Items looked at (at most {@link TEAM_CHANGED_PATHS_BATCH}). */
	looked: number;
	updated: number;
	/** Items found landed in the base and marked merged. */
	merged: number;
	failed: number;
	/** The sweep reached the last active item and starts over next time. */
	wrapped: boolean;
	/** The pass hit {@link PASS_DEADLINE_MS} and stopped early (its place is kept). */
	deadline: boolean;
	/** Cross-team pairs newly recorded. */
	newPairs: number;
}

/**
 * One background pass. A sweep (the timer, and the default) looks at the items whose worker just
 * ended a run and then the next items after the cursor, together at most
 * {@link TEAM_CHANGED_PATHS_BATCH}; a pending-only pass (a worker's run ended) looks at the queued
 * items only. Then the overlaps of the projects whose stored paths changed (or that have pairs
 * left over), their new cross-team pairs, and the notices due. One pass at a time: a call while
 * one runs shares its result; items queued meanwhile get one more pending-only pass.
 */
export function runChangedPathsPass(options: { sweep?: boolean } = {}): Promise<BatchResult> {
	const sweep = options.sweep !== false;
	if (job.running) {
		// A sweep asked for during a pending-only pass is not answered by it: one follows.
		if (sweep && !job.runningSweep) job.sweepAfter = true;
		return job.running;
	}
	job.runningSweep = sweep;
	const run = (async () => {
		try {
			return await passOnce(sweep);
		} finally {
			job.running = null;
			if (job.sweepAfter) {
				job.sweepAfter = false;
				void runChangedPathsPass().catch((error) =>
					logger.warn("Team changed paths pass failed", { error: String(error) }),
				);
			} else if (job.pending.size > 0) {
				void runChangedPathsPass({ sweep: false }).catch((error) =>
					logger.warn("Team changed paths pass failed", { error: String(error) }),
				);
			}
		}
	})();
	job.running = run;
	return run;
}

/** Settle within the time left, or report that the deadline passed first. */
async function withinDeadline<T>(work: Promise<T>, remainingMs: number): Promise<T | "deadline"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"deadline">((resolve) => {
		timer = setTimeout(() => resolve("deadline"), remainingMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function passOnce(sweep: boolean): Promise<BatchResult> {
	const result: BatchResult = {
		looked: 0,
		updated: 0,
		merged: 0,
		failed: 0,
		wrapped: false,
		deadline: false,
		newPairs: 0,
	};
	if (activeDatabaseBackend !== "sqlite") return result;
	const deadlineAt = job.clock.now() + job.deadlineMs;
	const passNumber = ++job.passNumber;
	if (job.backoff.size > 1000) job.backoff.clear();
	if (sweep) {
		try {
			releaseLocksOfArchivedTeams();
		} catch (error) {
			logger.warn("Archived teams' locks could not be released", { error: String(error) });
		}
	}
	const pending = [...job.pending].slice(0, TEAM_CHANGED_PATHS_BATCH);
	for (const id of pending) job.pending.delete(id);
	const first = pending.length
		? refreshTargets(and(inArray(teamWorkItems.id, pending), activeWithWorktree()), pending.length)
		: [];
	const room = sweep ? TEAM_CHANGED_PATHS_BATCH - first.length : 0;
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
	const projectsTouched = new Set<string>();
	const targets = [...first, ...next];
	let lastSwept: string | null = null;
	for (const [index, target] of targets.entries()) {
		const swept = index >= first.length;
		const skipUntil = job.backoff.get(target.id);
		if (skipUntil !== undefined) {
			if (passNumber < skipUntil) {
				if (swept) lastSwept = target.id;
				continue;
			}
			job.backoff.delete(target.id);
		}
		const remaining = deadlineAt - job.clock.now();
		const outcome = await withinDeadline(refreshTarget(target), remaining);
		// Out of time. Pending items not looked at are left to the sweep (re-queueing them would
		// start another pass at once).
		if (outcome === "deadline") {
			result.deadline = true;
			// Started with little time left: not this item's fault. The next pass starts with it.
			if (remaining <= job.deadlineMs * HUNG_SHARE_OF_DEADLINE) break;
			// It had a real share of the time: it counts as failed, the sweep resumes after it,
			// and it is skipped for a few passes.
			result.looked++;
			result.failed++;
			if (swept) lastSwept = target.id;
			job.backoff.set(target.id, passNumber + 1 + HUNG_BACKOFF_PASSES);
			break;
		}
		result.looked++;
		if (swept) lastSwept = target.id;
		if (outcome === "updated" || outcome === "merged") projectsTouched.add(target.projectId);
		if (outcome === "updated") result.updated++;
		else if (outcome === "merged") result.merged++;
		else if (outcome === "failed") result.failed++;
		await yieldToEventLoop();
		if (job.clock.now() >= deadlineAt && index < targets.length - 1) {
			result.deadline = true;
			break;
		}
	}
	if (room > 0) {
		if (result.deadline) job.cursor = lastSwept ?? job.cursor;
		else {
			result.wrapped = next.length < room;
			job.cursor = result.wrapped ? null : (next.at(-1)?.id ?? null);
		}
	}
	for (const projectId of [...new Set([...projectsTouched, ...job.pairBacklog])].sort()) {
		job.pairBacklog.delete(projectId);
		try {
			const index = await ensureProjectOverlaps(projectId);
			result.newPairs += (await recordNewCrossTeamPairs(index)).recorded;
		} catch (error) {
			logger.warn("Team overlaps could not be computed", { projectId, error: String(error) });
		}
	}
	await flushNotices();
	return result;
}

/** Look at a worker's items on a pending-only pass, and start one. */
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
	void runChangedPathsPass({ sweep: false }).catch((error) =>
		logger.warn("Team changed paths pass failed", { error: String(error) }),
	);
}

/**
 * Start the background pass: a sweep every {@link TEAM_CHANGED_PATHS_INTERVAL_MS}, a pass over a
 * worker's items after its run ends, and a coordinator's archiving releases its team's lock.
 * Idempotent across `--hot` reloads. Returns the stop function.
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
	const onStatus = (event: { narratorId: string; status: string }) => {
		if (stopped || activeDatabaseBackend !== "sqlite" || event.status !== "archived") return;
		try {
			releaseLocksOfTeam(event.narratorId, "team_archived");
		} catch (error) {
			logger.warn("Archived team's lock could not be released", { error: String(error) });
		}
	};
	let off = () => {};
	void import("../../lib/event-bus").then(({ eventBus }) => {
		if (stopped) return;
		eventBus.on("narrator:subagent_completed", onCompleted);
		eventBus.on("narrator:status_changed", onStatus);
		off = () => {
			eventBus.off("narrator:subagent_completed", onCompleted);
			eventBus.off("narrator:status_changed", onStatus);
		};
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

/** The overlap entries of these items' stored paths; yields after every item. */
export async function computeOverlapEntries(
	items: ReadonlyArray<{ id: string; paths: readonly string[] }>,
): Promise<IndexEntry[]> {
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
		await yieldToEventLoop();
	}
	const byPath = new Map<string, { kind: "file" | "dir"; items: Set<string> }>();
	const add = (path: string, kind: "file" | "dir", ids: Iterable<string>) => {
		const entry = byPath.get(path) ?? { kind, items: new Set<string>() };
		for (const id of ids) entry.items.add(id);
		byPath.set(path, entry);
	};
	let visited = 0;
	for (const [path, ids] of files) {
		if (ids.size >= 2) add(path, "file", ids);
		if (++visited % PAIR_VISITS_PER_YIELD === 0) await yieldToEventLoop();
	}
	// A coarse item compares by top-level entry with every other item.
	for (const [top, entry] of tops)
		if (entry.coarse && entry.items.size >= 2)
			add(top, top.endsWith(TEAM_CHANGED_DIR_SUFFIX) ? "dir" : "file", entry.items);
	const entries = [...byPath.entries()].map(([path, entry]) => ({
		path,
		kind: entry.kind,
		items: [...entry.items].sort(),
	}));
	await yieldToEventLoop();
	return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function computeProjectOverlaps(projectId: string): Promise<OverlapIndex> {
	const rows = db
		.select({ id: teamWorkItems.id, teamId: teamWorkItems.teamId })
		.from(teamWorkItems)
		.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(
			and(
				eq(teamWorkItems.projectId, projectId),
				notInArray(teamWorkItems.state, FINISHED),
				teamIsLive(),
			),
		)
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
	const entries = await computeOverlapEntries(items);
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

function isFresh(projectId: string, index: OverlapIndex | undefined): index is OverlapIndex {
	return (
		index !== undefined &&
		!job.stale.has(projectId) &&
		job.clock.now() - Date.parse(index.computedAt) < TEAM_CHANGED_PATHS_INTERVAL_MS
	);
}

/**
 * The project's overlap index: the cached one unless the stored paths changed since or it is
 * older than one pass interval; otherwise rebuilt (one build at a time per project). Background
 * callers only (the pass, the team status): a person's request uses {@link peekProjectOverlaps}.
 */
export async function ensureProjectOverlaps(projectId: string): Promise<OverlapIndex> {
	const cached = job.indexes.get(projectId);
	if (isFresh(projectId, cached)) return cached;
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

/**
 * The last index of a project without building on the caller's path: when it is missing or stale
 * a rebuild is started in the background and the last one (or none) is returned, marked stale.
 */
export function peekProjectOverlaps(projectId: string): {
	index: OverlapIndex | null;
	stale: boolean;
} {
	const cached = job.indexes.get(projectId);
	if (isFresh(projectId, cached)) return { index: cached, stale: false };
	void ensureProjectOverlaps(projectId).catch((error) =>
		logger.warn("Team overlaps could not be computed", { projectId, error: String(error) }),
	);
	return { index: cached ?? null, stale: true };
}

interface LiveItem {
	id: string;
	teamId: string;
	title: string;
	state: TeamWorkItemState;
	branch: string | null;
	exclusiveKey: string | null;
}

/** The index's items as they are now; finished ones and archived teams' are left out. */
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
			.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
			.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
			.where(
				and(
					inArray(teamWorkItems.id, ids),
					notInArray(teamWorkItems.state, FINISHED),
					teamIsLive(),
				),
			)
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
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, "work.overlap")))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(PAIR_EVENT_SCAN)
		.all();
	const told = new Set<string>();
	for (const row of rows) {
		const other = row.detail?.with;
		if (typeof other === "string") told.add(other);
	}
	return told;
}

/**
 * Record each cross-team pair of the index not recorded before: one `work.overlap` event on
 * each item (`with`, `withTeam`, a few paths cut short), and a notice line queued for each
 * coordinator. At most {@link NEW_PAIRS_PER_PASS} pairs per call; when more are left the project
 * is kept for the next pass. Pairing yields every {@link PAIR_VISITS_PER_YIELD} pair visits and
 * stops collecting a pair's paths once it has {@link PAIR_PATH_SAMPLE}.
 */
export async function recordNewCrossTeamPairs(
	index: OverlapIndex,
): Promise<{ recorded: number; more: boolean }> {
	const live = liveItemsOf(index);
	const entries = liveEntries(index, live);
	// Numbered items: a pair is one number, not a string built per visit.
	const ids = [...live.keys()].sort();
	const number = new Map(ids.map((id, i) => [id, i]));
	const width = ids.length + 1;
	const teamOf = ids.map((id) => live.get(id)?.teamId ?? "");
	const told = new Set<number>();
	for (const [i, id] of ids.entries()) {
		for (const other of toldPairs(id)) {
			const j = number.get(other);
			if (j !== undefined) told.add(Math.min(i, j) * width + Math.max(i, j));
		}
		if (i % 10 === 9) await yieldToEventLoop();
	}
	const found = new Map<number, string[]>();
	let visits = 0;
	for (const entry of entries) {
		const nums = entry.items
			.map((id) => number.get(id))
			.filter((n): n is number => n !== undefined)
			.sort((a, b) => a - b);
		for (let x = 0; x < nums.length; x++) {
			const a = nums[x] as number;
			for (let y = x + 1; y < nums.length; y++) {
				const b = nums[y] as number;
				if (++visits % PAIR_VISITS_PER_YIELD === 0) await yieldToEventLoop();
				if (teamOf[a] === teamOf[b]) continue;
				const key = a * width + b;
				if (told.has(key)) continue;
				const paths = found.get(key);
				if (!paths) found.set(key, [samplePath(entry.path)]);
				else if (paths.length < PAIR_PATH_SAMPLE) paths.push(samplePath(entry.path));
			}
		}
	}
	const keys = [...found.keys()].sort((x, y) => x - y);
	let recorded = 0;
	const system: WorkActor = { kind: "system", id: null };
	for (const key of keys.slice(0, NEW_PAIRS_PER_PASS)) {
		const a = live.get(ids[Math.floor(key / width)] as string) as LiveItem;
		const b = live.get(ids[key % width] as string) as LiveItem;
		const paths = found.get(key) ?? [];
		const at = new Date(job.clock.now()).toISOString();
		db.transaction((tx) => {
			recordWorkEvent(tx, {
				teamId: a.teamId,
				workItemId: a.id,
				kind: "work.overlap",
				actor: system,
				detail: { with: b.id, withTeam: b.teamId, paths },
				at,
			});
			recordWorkEvent(tx, {
				teamId: b.teamId,
				workItemId: b.id,
				kind: "work.overlap",
				actor: system,
				detail: { with: a.id, withTeam: a.teamId, paths },
				at,
			});
		});
		queueNotice(a.teamId, { itemId: a.id, otherItemId: b.id, otherTeamId: b.teamId, paths });
		queueNotice(b.teamId, { itemId: b.id, otherItemId: a.id, otherTeamId: a.teamId, paths });
		recorded++;
	}
	const more = keys.length > NEW_PAIRS_PER_PASS;
	if (more) job.pairBacklog.add(index.projectId);
	return { recorded, more };
}

function queueNotice(teamId: string, line: NoticeLine): void {
	const lines = job.queuedNotices.get(teamId) ?? [];
	if (lines.length < NOTICE_LINES_MAX) lines.push(line);
	job.queuedNotices.set(teamId, lines);
}

/** The coordinator's state as a notice needs it: active, and whether it may be woken. */
function coordinatorNoticeState(teamId: string): { active: boolean; wake: boolean } {
	const row = db
		.select({
			status: projectTeams.status,
			coordinator: narrators.status,
			lastStop: narrators.lastStopReason,
		})
		.from(projectTeams)
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(eq(projectTeams.narratorId, teamId))
		.limit(1)
		.get();
	const active = row?.status === "active" && row.coordinator !== "archived";
	// A coordinator a person stopped (or that failed) stays stopped: the row waits for its next run.
	return { active, wake: active && row?.lastStop === "normal" };
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

const oneLine = (value: string, max = 80) => {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The notice text for one coordinator, at most {@link NOTICE_MAX_BYTES}. */
export async function renderOverlapNotice(
	teamId: string,
	lines: NoticeLine[],
	locale: Locale,
): Promise<string> {
	const t = getTeamOverlapLabels(locale);
	const ids = lines.flatMap((line) => [line.itemId, line.otherItemId]);
	const titles = new Map(
		ids.length
			? db
					.select({ id: teamWorkItems.id, title: teamWorkItems.title })
					.from(teamWorkItems)
					.where(inArray(teamWorkItems.id, ids))
					.all()
					.map((row) => [row.id, row.title])
			: [],
	);
	const named = await namedTeamsFor(
		teamId,
		lines.map((line) => line.otherTeamId),
	);
	const head = t.noticeHeading;
	const tail = t.noticeAdvice;
	let used = utf8Bytes(head) + utf8Bytes(tail) + 2;
	const body: string[] = [];
	for (const [index, line] of lines.entries()) {
		const other = named.get(line.otherTeamId);
		const text = t.noticeLine(
			oneLine(titles.get(line.itemId) ?? line.itemId),
			other ? oneLine(other.title) : null,
			other ? oneLine(titles.get(line.otherItemId) ?? "") : null,
			line.paths.map(samplePath).join(t.separator),
		);
		const more = t.more(lines.length - index);
		if (used + utf8Bytes(text) + 1 + utf8Bytes(more) + 1 > NOTICE_MAX_BYTES) {
			body.push(more);
			break;
		}
		body.push(text);
		used += utf8Bytes(text) + 1;
	}
	return [head, ...body, tail].join("\n");
}

async function defaultNotify(input: OverlapNoticeInput): Promise<void> {
	const { deliverInjection } = await import("../narrator-injection");
	await deliverInjection(input.teamId, {
		content: input.text,
		source: "team_overlap",
		body: { kind: "prose", text: input.text },
		role: "sys",
		schedule: input.wake ? "wakeIfIdle" : "none",
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
		const state = coordinatorNoticeState(teamId);
		if (lines.length === 0 || !state.active) continue;
		job.lastNoticeAt.set(teamId, now);
		try {
			const locale = await coordinatorLocale(teamId);
			await (job.notify ?? defaultNotify)({
				teamId,
				text: await renderOverlapNotice(teamId, lines, locale),
				locale,
				wake: state.wake,
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
 * the lock. Never builds on the request: the last index is shown (marked stale while a rebuild
 * runs in the background). Bounded: one `IN` read of the index's items (≤ 100), one of their
 * teams. Items of teams the person cannot read are neither shown nor counted.
 */
export async function readProjectOverlaps(
	projectId: string,
	principal: NarratorPrincipal,
	options: { canManageProject: boolean },
): Promise<TeamOverlapResponse> {
	assertSqlite();
	const { index, stale } = peekProjectOverlaps(projectId);
	const live = index ? liveItemsOf(index) : new Map<string, LiveItem>();
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
	for (const entry of index ? liveEntries(index, live) : []) {
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
		// For the release call only; a client never shows it for a holder it cannot see.
		...(options.canManageProject ? { holderId: row.id } : {}),
	}));
	return {
		computedAt: index?.computedAt ?? null,
		stale,
		activeItems: [...live.values()].filter(
			(item) => (teams.get(item.teamId)?.access ?? "hidden") !== "hidden",
		).length,
		activeItemsCapped: index?.capped ?? false,
		entries: visible.slice(0, TEAM_OVERLAP_LIST_LIMIT),
		moreEntries: Math.max(0, visible.length - TEAM_OVERLAP_LIST_LIMIT),
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
	/** This team's ready items whose branch no longer contains the head recorded at ready. */
	rewound: string[];
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
	const named = await namedTeamsFor(teamId, [
		...[...live.values()].map((item) => item.teamId),
		...(holder ? [holder.teamId] : []),
	]);
	const lines = entries.slice(0, limit).map((entry) => {
		const mine: string[] = [];
		const others: Array<{ team: string | null; title: string | null }> = [];
		for (const id of entry.items) {
			const item = live.get(id) as LiveItem;
			if (item.teamId === teamId) mine.push(oneLine(item.title));
			else {
				const other = named.get(item.teamId);
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
		return { path: samplePath(entry.path), kind: entry.kind, mine, others };
	});
	let lock: TeamOverlapStatus["lock"] = null;
	if (holder) {
		if (holder.teamId === teamId) lock = { mine: true, title: oneLine(holder.title), team: null };
		else {
			const other = named.get(holder.teamId);
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
	const rewound = [...live.values()]
		.filter(
			(item) => item.teamId === teamId && item.state === "ready" && job.readyRewound.has(item.id),
		)
		.map((item) => oneLine(item.title))
		.sort()
		.slice(0, limit);
	return { lines, total: entries.length, lock, unlocked, rewound };
}
