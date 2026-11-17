/**
 * The work item lifecycle of a project team (docs/PROJECT_TEAMS-PLAN.md §二.4, §二.9, §二.14; P3).
 *
 * A work item is one branch and one worktree. Its worktree is made through the existing creation
 * path (`NarratorWorktreeService.prepare` + `create`, under the coordinator's workspace) and
 * removed only through the existing removal channel (`planRemoval` + `remove`, PR #493) — this
 * module never runs `git worktree` itself and never deletes a branch. The item row records the
 * worktree resource, so cleanup deletes only what a record names.
 *
 * Every state change, review verdict, base sync, cleanup, check-in and decision appends one
 * `team_work_events` row naming its person or agent. Each statement is a primary-key or index
 * lookup bounded by a LIMIT; git runs through `gitService` with its read bounds, and the merge
 * of a base sync through its bounded merge.
 *
 * SQLite only, like the rest of the team surface.
 */

import { createHash } from "node:crypto";
import type { WorktreeRemovalPlan, WorktreeRemovalResult } from "@shared/narrator-worktrees";
import {
	TEAM_BRIEF_MAX_BYTES,
	TEAM_CHECKIN_MAX_MINUTES,
	TEAM_CHECKIN_MIN_MINUTES,
	TEAM_DECISION_MAX_BYTES,
	TEAM_DEFAULT_WORK_KIND,
	TEAM_EVENT_DETAIL_MAX_BYTES,
	TEAM_ISOLATED_WORK_KIND,
	TEAM_WORK_ITEM_FINISHED_STATES,
	TEAM_WORK_LIST_LIMIT,
	TEAM_WORK_TITLE_MAX_LENGTH,
	type TeamEventKind,
	type TeamReviewVerdict,
	type TeamWorkEventKind,
	type TeamWorkItemState,
} from "@shared/project-teams";
import { and, asc, desc, eq, gte, inArray, isNotNull, notInArray } from "drizzle-orm";
import { activeDatabaseBackend, db } from "../../db";
import {
	narratorWorktreeResources,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
} from "../../db/schema";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors";
import type { GitIdentityEnv } from "../../lib/git-identity";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { gitService } from "../git-service";
import type { NarratorPrincipal } from "../narrator-acl";

type WorkItemRow = typeof teamWorkItems.$inferSelect;
type Executor = Pick<typeof db, "insert" | "select" | "update">;

/** Who changed something: a person (user id), an agent (narrator id) or the system. */
export interface WorkActor {
	kind: "person" | "agent" | "system";
	id: string | null;
}

/** How long one check-in event is looked back for at startup (the longest delay). */
const CHECKIN_LOOKBACK_MS = TEAM_CHECKIN_MAX_MINUTES * 60_000;
/** Paths named in a sync's conflict-risk report. */
const SYNC_REPORTED_PATHS = 20;
/** Retries of an isolated item's cleanup while its subagent's run is still unwinding. */
const SETTLE_RETRY_DELAYS_MS = [250, 1000, 3000, 10_000] as const;
const SETTLE_BLOCKERS_TO_RETRY = new Set([
	"WORKTREE_REMOVAL_DEPENDENT_RUNNING",
	"WORKTREE_REMOVAL_BUSY",
]);

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * The worktree side effects of a work item, each through the existing worktree service. The
 * production adapter (`work-item-ports.ts`) binds them to the coordinator's workspace; tests
 * replace them.
 */
export interface WorkItemWorktreePorts {
	/** Create a new branch and its worktree; returns the created checkout's path. */
	createWorktree(input: {
		coordinatorId: string;
		principal: NarratorPrincipal;
		requestId: string;
		branchName: string;
		baseRef: string;
		signal: AbortSignal;
	}): Promise<{ path: string }>;
	/** The removal channel's read-only plan for one path. */
	planRemoval(input: {
		coordinatorId: string;
		principal: NarratorPrincipal;
		path: string;
		signal: AbortSignal;
	}): Promise<WorktreeRemovalPlan>;
	/** The removal channel's destructive step; never deletes a branch. */
	removeWorktree(input: {
		coordinatorId: string;
		principal: NarratorPrincipal;
		path: string;
		expectedRevision: number;
		force?: boolean;
		confirmedLoss?: ConfirmedLoss;
		signal: AbortSignal;
	}): Promise<WorktreeRemovalResult>;
	/** Whether a session is running right now (a base sync never merges under a running worker). */
	isNarratorRunning(narratorId: string): boolean;
	/** The principal an automatic cleanup acts as (the person who started the item). */
	principalOf(userId: string): Promise<NarratorPrincipal>;
	/** The git identity of a server-side merge commit. */
	gitIdentity(input: {
		userId: string | null;
		coordinatorId: string;
	}): Promise<GitIdentityEnv | null>;
}

/** The loss a person confirmed for a forced removal, copied exactly from a refusal. */
export interface ConfirmedLoss {
	head: string | null;
	dirtyFileCount: number;
	unreachableCommits: number;
}

let portsOverride: WorkItemWorktreePorts | null = null;

/** Replace the ports (tests). Null restores production. Returns the previous override. */
export function setWorkItemPortsForTests(
	next: WorkItemWorktreePorts | null,
): WorkItemWorktreePorts | null {
	const previous = portsOverride;
	portsOverride = next;
	return previous;
}

async function ports(): Promise<WorkItemWorktreePorts> {
	if (portsOverride) return portsOverride;
	return (await import("./work-item-ports")).productionWorkItemPorts;
}

// ── Records ─────────────────────────────────────────────────────────────────

function assertSqlite(): void {
	if (activeDatabaseBackend !== "sqlite")
		throw new AppError("Teams are available on SQLite only", 503, "TEAMS_BACKEND_UNAVAILABLE");
}

/** Append one event. Synchronous so it can share the caller's transaction. */
export function recordWorkEvent(
	executor: Pick<typeof db, "insert">,
	event: {
		teamId: string;
		workItemId: string | null;
		kind: TeamWorkEventKind | TeamEventKind;
		actor: WorkActor;
		detail?: Record<string, unknown> | null;
		at?: string;
	},
): string {
	const id = generateId();
	const detail = event.detail ?? null;
	const detailJson =
		detail === null
			? null
			: utf8Bytes(JSON.stringify(detail)) <= TEAM_EVENT_DETAIL_MAX_BYTES
				? detail
				: { truncated: true };
	executor
		.insert(teamWorkEvents)
		.values({
			id,
			teamId: event.teamId,
			workItemId: event.workItemId,
			kind: event.kind,
			actorKind: event.actor.kind,
			actorId: event.actor.id,
			detailJson,
			createdAt: event.at ?? new Date().toISOString(),
		})
		.run();
	return id;
}

interface TeamRecord {
	teamId: string;
	projectId: string;
	baseBranch: string;
	status: string;
	brief: string;
}

/** The team a coordinator leads, or a 404-style error for any other session. */
export function requireCoordinatedTeam(coordinatorId: string): TeamRecord {
	assertSqlite();
	const row = db
		.select({
			teamId: projectTeams.narratorId,
			projectId: projectTeams.projectId,
			baseBranch: projectTeams.baseBranch,
			status: projectTeams.status,
			brief: projectTeams.brief,
		})
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, coordinatorId))
		.limit(1)
		.get();
	if (!row)
		throw new AppError(
			"Only a team coordinator can use the Team tool",
			403,
			"TEAM_COORDINATOR_REQUIRED",
		);
	return row;
}

function requireActiveTeam(coordinatorId: string): TeamRecord {
	const team = requireCoordinatedTeam(coordinatorId);
	if (team.status === "archived")
		throw new AppError("This team is archived; nothing can change", 409, "TEAM_ARCHIVED");
	return team;
}

/** A work item of this team, or NotFound (another team's item is not found either). */
export function requireWorkItem(teamId: string, itemId: string): WorkItemRow {
	const row = db
		.select()
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.id, itemId), eq(teamWorkItems.teamId, teamId)))
		.limit(1)
		.get();
	if (!row) throw new NotFoundError("Work item", itemId);
	return row;
}

function isFinished(state: TeamWorkItemState): boolean {
	return TEAM_WORK_ITEM_FINISHED_STATES.includes(state);
}

function requireLive(item: WorkItemRow): void {
	if (isFinished(item.state))
		throw new AppError(
			`Work item ${item.id} is ${item.state}; it cannot change any more`,
			409,
			"TEAM_WORK_ITEM_FINISHED",
		);
}

/** The recorded worktree path of an item, or null when none is recorded. */
export function worktreePathOf(item: Pick<WorkItemRow, "worktreeResourceId">): string | null {
	if (!item.worktreeResourceId) return null;
	const row = db
		.select({ path: narratorWorktreeResources.worktreePath })
		.from(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.id, item.worktreeResourceId))
		.limit(1)
		.get();
	return row?.path ?? null;
}

function requireWorktree(item: WorkItemRow): string {
	const path = worktreePathOf(item);
	if (!path)
		throw new AppError(
			`Work item ${item.id} has no recorded worktree`,
			409,
			"TEAM_WORK_ITEM_NO_WORKTREE",
		);
	return path;
}

/** Move an item's state only if it is still what was read: concurrent changes lose cleanly. */
function updateItem(
	executor: Executor,
	item: WorkItemRow,
	patch: Partial<typeof teamWorkItems.$inferInsert>,
	at: string,
): void {
	const updated = executor
		.update(teamWorkItems)
		.set({ ...patch, updatedAt: at })
		.where(
			and(
				eq(teamWorkItems.id, item.id),
				eq(teamWorkItems.state, item.state),
				eq(teamWorkItems.updatedAt, item.updatedAt),
			),
		)
		.returning({ id: teamWorkItems.id })
		.all();
	if (updated.length !== 1)
		throw new AppError(
			`Work item ${item.id} changed meanwhile; read it again`,
			409,
			"TEAM_WORK_ITEM_CHANGED",
		);
}

// ── The item as the tool returns it ─────────────────────────────────────────

export interface WorkItemView {
	id: string;
	title: string;
	kind: string;
	state: TeamWorkItemState;
	branch: string | null;
	baseRef: string | null;
	worktree: string | null;
	headSha: string | null;
	worker: string | null;
	reviewRounds: number;
	lastReview: TeamReviewVerdict | null;
}

export function viewWorkItem(item: WorkItemRow): WorkItemView {
	return {
		id: item.id,
		title: item.title,
		kind: item.kind,
		state: item.state,
		branch: item.branchName,
		baseRef: item.baseRef,
		worktree: worktreePathOf(item),
		headSha: item.headSha,
		worker: item.workerNarratorId,
		reviewRounds: item.reviewRounds,
		lastReview: item.lastReview,
	};
}

/** The team's work items, open ones first (by creation), at most {@link TEAM_WORK_LIST_LIMIT}. */
export function listWorkItems(coordinatorId: string): {
	items: WorkItemView[];
	more: boolean;
} {
	const team = requireCoordinatedTeam(coordinatorId);
	const finished = [...TEAM_WORK_ITEM_FINISHED_STATES];
	const open = db
		.select()
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, team.teamId), notInArray(teamWorkItems.state, finished)))
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(TEAM_WORK_LIST_LIMIT + 1)
		.all();
	const room = TEAM_WORK_LIST_LIMIT - Math.min(open.length, TEAM_WORK_LIST_LIMIT);
	const done =
		room > 0
			? db
					.select()
					.from(teamWorkItems)
					.where(and(eq(teamWorkItems.teamId, team.teamId), inArray(teamWorkItems.state, finished)))
					.orderBy(desc(teamWorkItems.updatedAt), desc(teamWorkItems.id))
					.limit(room + 1)
					.all()
			: [];
	const rows = [...open.slice(0, TEAM_WORK_LIST_LIMIT), ...done.slice(0, room)];
	return {
		items: rows.map(viewWorkItem),
		more: open.length > TEAM_WORK_LIST_LIMIT || done.length > room,
	};
}

// ── Create ──────────────────────────────────────────────────────────────────

/** A branch name for an item: `team/<title slug>-<8 hex of the item id>`. */
export function workItemBranchName(itemId: string, title: string): string {
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/g, "") || "work";
	return `team/${slug}-${createHash("sha256").update(itemId).digest("hex").slice(0, 8)}`;
}

export interface CreateWorkItemInput {
	coordinatorId: string;
	title: string;
	/** `isolated` for `Agent({ isolation: "worktree" })`; default kind otherwise. */
	kind?: string;
	/** Who asked: the coordinator agent (its id) — the person behind its turn is `principal`. */
	actor: WorkActor;
	principal: NarratorPrincipal;
	signal: AbortSignal;
}

/**
 * Create a work item: its branch (from the team's base branch) and worktree through the existing
 * creation path, then the row and its event. The worktree is made first: if the row could not be
 * written afterwards, the worktree is still recorded by the worktree registry, never orphaned.
 */
export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRow> {
	const team = requireActiveTeam(input.coordinatorId);
	const title = input.title.trim();
	if (!title) throw new ValidationError("A work item needs a title");
	if (title.length > TEAM_WORK_TITLE_MAX_LENGTH)
		throw new ValidationError(
			`A work item title is at most ${TEAM_WORK_TITLE_MAX_LENGTH} characters`,
		);
	const id = generateId();
	const branchName = workItemBranchName(id, title);
	const kind = input.kind ?? TEAM_DEFAULT_WORK_KIND;
	const port = await ports();
	const created = await port.createWorktree({
		coordinatorId: team.teamId,
		principal: input.principal,
		requestId: `team-${id}`,
		branchName,
		baseRef: team.baseBranch,
		signal: input.signal,
	});
	const resource = db
		.select({ id: narratorWorktreeResources.id })
		.from(narratorWorktreeResources)
		.where(
			and(
				eq(narratorWorktreeResources.deviceId, "local"),
				eq(narratorWorktreeResources.worktreePath, created.path),
			),
		)
		.limit(1)
		.get();
	if (!resource)
		throw new AppError(
			`The worktree at ${created.path} was created but has no resource record; it was not attached to a work item`,
			500,
			"TEAM_WORKTREE_UNRECORDED",
		);
	const head = await gitService.resolveCommit(created.path, "HEAD").catch(() => null);
	const now = new Date().toISOString();
	db.transaction((tx) => {
		tx.insert(teamWorkItems)
			.values({
				id,
				teamId: team.teamId,
				projectId: team.projectId,
				title,
				kind,
				state: kind === TEAM_ISOLATED_WORK_KIND ? "in_progress" : "queued",
				branchName,
				baseRef: team.baseBranch,
				worktreeResourceId: resource.id,
				headSha: head,
				createdBy: input.principal.userId || null,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		recordWorkEvent(tx, {
			teamId: team.teamId,
			workItemId: id,
			kind: "work.created",
			actor: input.actor,
			detail: {
				title,
				kind,
				branch: branchName,
				baseRef: team.baseBranch,
				worktree: created.path,
				head,
			},
			at: now,
		});
	});
	logger.info("Team work item created", { teamId: team.teamId, workItemId: id, branchName });
	return requireWorkItem(team.teamId, id);
}

/**
 * Record the first-level subagent working on an item (the one an `Agent` call just created in
 * its worktree). An item already worked on keeps its worker; a queued one starts.
 */
export function attachWorker(
	teamId: string,
	itemId: string,
	workerNarratorId: string,
	actor: WorkActor,
): void {
	const item = requireWorkItem(teamId, itemId);
	requireLive(item);
	if (item.workerNarratorId) return;
	const now = new Date().toISOString();
	db.transaction((tx) => {
		updateItem(
			tx,
			item,
			{
				workerNarratorId,
				...(item.state === "queued" ? { state: "in_progress" as const } : {}),
			},
			now,
		);
		recordWorkEvent(tx, {
			teamId,
			workItemId: item.id,
			kind: "work.started",
			actor,
			detail: { worker: workerNarratorId, from: item.state },
			at: now,
		});
	});
}

/** The live item whose recorded worktree is exactly `path`, for an `Agent({ workdir })`. */
export function workItemAtWorktree(teamId: string, path: string): WorkItemRow | null {
	const row = db
		.select({ item: teamWorkItems })
		.from(teamWorkItems)
		.innerJoin(
			narratorWorktreeResources,
			eq(narratorWorktreeResources.id, teamWorkItems.worktreeResourceId),
		)
		.where(
			and(
				eq(teamWorkItems.teamId, teamId),
				notInArray(teamWorkItems.state, [...TEAM_WORK_ITEM_FINISHED_STATES]),
				eq(narratorWorktreeResources.deviceId, "local"),
				eq(narratorWorktreeResources.worktreePath, path),
			),
		)
		.limit(1)
		.get();
	return row?.item ?? null;
}

// ── Review, ready, cancel ───────────────────────────────────────────────────

export interface RecordReviewInput {
	coordinatorId: string;
	itemId: string;
	verdict: TeamReviewVerdict;
	findings: number;
	/** The reviewing subagent (narrator id when it resolved, else the selector given). */
	reviewer: string | null;
	actor: WorkActor;
}

/**
 * Record one review round. A blocker sends the item back to work (its author fixes it: the
 * coordinator `Send`s the findings to `workerNarratorId`); a clear verdict leaves it in review,
 * waiting for `work.ready`.
 */
export async function recordReview(
	input: RecordReviewInput,
): Promise<{ item: WorkItemRow; round: number }> {
	const team = requireActiveTeam(input.coordinatorId);
	const item = requireWorkItem(team.teamId, input.itemId);
	requireLive(item);
	if (!Number.isSafeInteger(input.findings) || input.findings < 0)
		throw new ValidationError("findings must be a non-negative integer");
	const path = worktreePathOf(item);
	const head = path ? await gitService.resolveCommit(path, "HEAD").catch(() => null) : null;
	const round = item.reviewRounds + 1;
	const now = new Date().toISOString();
	const state: TeamWorkItemState = input.verdict === "blocker" ? "in_progress" : "in_review";
	db.transaction((tx) => {
		updateItem(
			tx,
			item,
			{ reviewRounds: round, lastReview: input.verdict, state, ...(head ? { headSha: head } : {}) },
			now,
		);
		recordWorkEvent(tx, {
			teamId: team.teamId,
			workItemId: item.id,
			kind: "work.review",
			actor: input.actor,
			detail: {
				round,
				verdict: input.verdict,
				findings: input.findings,
				reviewer: input.reviewer,
				head,
				from: item.state,
				to: state,
			},
			at: now,
		});
	});
	return { item: requireWorkItem(team.teamId, item.id), round };
}

/** The head of the newest review round of an item, from its events (bounded scan). */
function lastReviewedHead(itemId: string): string | null {
	const rows = db
		.select({ kind: teamWorkEvents.kind, detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.workItemId, itemId))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(50)
		.all();
	const review = rows.find((row) => row.kind === "work.review");
	const head = review?.detail?.head;
	return typeof head === "string" ? head : null;
}

/**
 * Mark an item ready: its newest review round is clear and its worktree has no uncommitted
 * change. Commits made after that review do not block (soft, like every coordinator rule) but
 * are counted in the result, so the coordinator sees when it should review again.
 */
export async function markReady(input: {
	coordinatorId: string;
	itemId: string;
	actor: WorkActor;
}): Promise<{ item: WorkItemRow; commitsSinceReview: number | null }> {
	const team = requireActiveTeam(input.coordinatorId);
	const item = requireWorkItem(team.teamId, input.itemId);
	requireLive(item);
	if (item.lastReview !== "clear")
		throw new AppError(
			item.reviewRounds === 0
				? `Work item ${item.id} has no review yet; record a clear review round first`
				: `The newest review of work item ${item.id} found blockers; have the author fix them and review again`,
			409,
			"TEAM_WORK_ITEM_NOT_REVIEWED",
		);
	const path = requireWorktree(item);
	const dirty = await gitService.getUncommittedChanges(path);
	if (dirty.count > 0 || !dirty.exact)
		throw new AppError(
			`Work item ${item.id} has uncommitted changes in its worktree; the author commits them first`,
			409,
			"TEAM_WORK_ITEM_DIRTY",
		);
	const head = await gitService.resolveCommit(path, "HEAD");
	const reviewed = lastReviewedHead(item.id);
	let commitsSinceReview: number | null = null;
	if (head && reviewed && head !== reviewed)
		commitsSinceReview = await gitService
			.countCommitsNotIn(path, head, [reviewed])
			.catch(() => null);
	else if (head && reviewed) commitsSinceReview = 0;
	const now = new Date().toISOString();
	db.transaction((tx) => {
		updateItem(tx, item, { state: "ready", ...(head ? { headSha: head } : {}) }, now);
		recordWorkEvent(tx, {
			teamId: team.teamId,
			workItemId: item.id,
			kind: "work.ready",
			actor: input.actor,
			detail: { head, reviewedHead: reviewed, commitsSinceReview, from: item.state },
			at: now,
		});
	});
	return { item: requireWorkItem(team.teamId, item.id), commitsSinceReview };
}

/** Cancel an item. Its worktree stays recorded until `cleanup` removes it. */
export function cancelWorkItem(input: {
	coordinatorId: string;
	itemId: string;
	reason?: string;
	actor: WorkActor;
}): WorkItemRow {
	const team = requireActiveTeam(input.coordinatorId);
	const item = requireWorkItem(team.teamId, input.itemId);
	requireLive(item);
	const now = new Date().toISOString();
	db.transaction((tx) => {
		updateItem(tx, item, { state: "cancelled" }, now);
		recordWorkEvent(tx, {
			teamId: team.teamId,
			workItemId: item.id,
			kind: "work.cancelled",
			actor: input.actor,
			detail: { from: item.state, reason: input.reason?.slice(0, 500) ?? null },
			at: now,
		});
	});
	return requireWorkItem(team.teamId, item.id);
}

// ── Base sync ───────────────────────────────────────────────────────────────

export type SyncOutcome =
	| { outcome: "up_to_date"; baseSha: string; head: string }
	| { outcome: "merged"; baseSha: string; head: string; previousHead: string }
	| {
			outcome: "handed_off";
			reason:
				| "overlap"
				| "uncommitted"
				| "worker_running"
				| "unrelated"
				| "too_many_paths"
				| "merge_failed";
			baseSha: string;
			head: string;
			/** Paths both sides changed (at most 20), for `overlap`. */
			paths: string[];
			/** The subagent that brings the base in itself. */
			worker: string | null;
	  };

/** Paths of one side that collide with the other: the same path, or a file vs. a directory. */
export function overlappingPaths(ours: readonly string[], theirs: readonly string[]): string[] {
	const theirSet = new Set(theirs);
	const theirDirs = new Set<string>();
	for (const path of theirs) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) theirDirs.add(parts.slice(0, i).join("/"));
	}
	const out: string[] = [];
	for (const path of ours) {
		const parts = path.split("/");
		let hit = theirSet.has(path) || theirDirs.has(path);
		for (let i = 1; !hit && i < parts.length; i++) hit = theirSet.has(parts.slice(0, i).join("/"));
		if (hit) out.push(path);
	}
	return out.sort();
}

/**
 * Bring the team's base branch into the item's branch.
 *
 * Done server-side with a merge commit only when nothing can conflict: the worktree is clean,
 * the worker is not running, and the two sides changed disjoint paths since their merge base
 * (exact listings, no rename detection). Anything else is handed to the item's subagent and the
 * branch is left as it was — never a rebase, never a reset, never a force.
 */
export async function syncWorkItem(input: {
	coordinatorId: string;
	itemId: string;
	actor: WorkActor;
	/** The person behind the coordinator's turn, for the merge commit's identity. */
	userId: string | null;
}): Promise<SyncOutcome> {
	const team = requireActiveTeam(input.coordinatorId);
	const item = requireWorkItem(team.teamId, input.itemId);
	requireLive(item);
	const path = requireWorktree(item);
	const baseRef = item.baseRef ?? team.baseBranch;
	const baseSha = await gitService.resolveCommit(path, baseRef);
	if (!baseSha)
		throw new AppError(`The base ${baseRef} does not name a commit`, 409, "TEAM_BASE_UNRESOLVED");
	const head = await gitService.resolveCommit(path, "HEAD");
	if (!head)
		throw new AppError("The work item's branch has no commit", 409, "TEAM_HEAD_UNRESOLVED");
	const port = await ports();

	const record = (result: SyncOutcome) => {
		const now = new Date().toISOString();
		db.transaction((tx) => {
			if (result.outcome === "merged") updateItem(tx, item, { headSha: result.head }, now);
			recordWorkEvent(tx, {
				teamId: team.teamId,
				workItemId: item.id,
				kind: "work.sync",
				actor: input.actor,
				detail: { ...result, baseRef },
				at: now,
			});
		});
		return result;
	};
	const handOff = (
		reason: Extract<SyncOutcome, { outcome: "handed_off" }>["reason"],
		paths: string[] = [],
	) =>
		record({
			outcome: "handed_off",
			reason,
			baseSha,
			head,
			paths: paths.slice(0, SYNC_REPORTED_PATHS),
			worker: item.workerNarratorId,
		});

	if (await gitService.isAncestor(path, baseSha, head))
		return record({ outcome: "up_to_date", baseSha, head });
	if (item.workerNarratorId && port.isNarratorRunning(item.workerNarratorId))
		return handOff("worker_running");
	const dirty = await gitService.getUncommittedChanges(path);
	if (dirty.count > 0 || !dirty.exact) return handOff("uncommitted");
	const mergeBase = await gitService.getMergeBase(path, head, baseSha);
	if (!mergeBase) return handOff("unrelated");
	const [ours, theirs] = await Promise.all([
		gitService.getChangedPaths(path, mergeBase, head),
		gitService.getChangedPaths(path, mergeBase, baseSha),
	]);
	if (!ours.exact || !theirs.exact) return handOff("too_many_paths");
	const overlap = overlappingPaths(ours.paths, theirs.paths);
	if (overlap.length > 0) return handOff("overlap", overlap);
	const identity = await port.gitIdentity({ userId: input.userId, coordinatorId: team.teamId });
	const merged = await gitService.mergeCommitNoFastForward(
		path,
		baseSha,
		`Merge ${baseRef} into ${item.branchName ?? "the work item branch"}`,
		identity,
	);
	if (!merged.merged) return handOff("merge_failed");
	return record({ outcome: "merged", baseSha, head: merged.head, previousHead: head });
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export type CleanupOutcome =
	| { outcome: "removed" | "already_absent"; path: string; branch: string | null }
	| {
			outcome: "refused";
			path: string;
			code: string;
			/** What removing would lose; a person confirms exactly this to force. */
			loss?: ConfirmedLoss;
			blockers?: string[];
	  };

/**
 * Remove a finished (merged or cancelled) item's worktree through the removal channel. Its
 * branch is never deleted. Losing uncommitted files or unmerged commits needs `force` with the
 * loss a person confirmed, copied exactly from the refusal that reported it.
 */
export async function cleanupWorkItem(input: {
	coordinatorId: string;
	itemId: string;
	principal: NarratorPrincipal;
	force?: boolean;
	confirmedLoss?: ConfirmedLoss;
	actor: WorkActor;
	signal: AbortSignal;
}): Promise<CleanupOutcome> {
	const team = requireCoordinatedTeam(input.coordinatorId);
	const item = requireWorkItem(team.teamId, input.itemId);
	if (!isFinished(item.state))
		throw new AppError(
			`Work item ${item.id} is ${item.state}; only a merged or cancelled item's worktree is cleaned up (cancel it first)`,
			409,
			"TEAM_WORK_ITEM_NOT_FINISHED",
		);
	if (input.force && !input.confirmedLoss)
		throw new ValidationError("force must carry the confirmed loss, copied from the refusal");
	const path = requireWorktree(item);
	const port = await ports();
	const plan = await port.planRemoval({
		coordinatorId: team.teamId,
		principal: input.principal,
		path,
		signal: input.signal,
	});
	const loss: ConfirmedLoss = {
		head: plan.worktree.head,
		dirtyFileCount: plan.worktree.dirtyFileCount,
		unreachableCommits: plan.worktree.unreachableCommits,
	};
	const refuse = (code: string, extra: { loss?: ConfirmedLoss; blockers?: string[] } = {}) => {
		const result: CleanupOutcome = { outcome: "refused", path, code, ...extra };
		recordWorkEvent(db, {
			teamId: team.teamId,
			workItemId: item.id,
			kind: "work.cleanup",
			actor: input.actor,
			detail: { ...result },
		});
		return result;
	};
	if (plan.status === "blocked")
		return refuse(plan.blockers[0]?.code ?? "WORKTREE_REMOVAL_BLOCKED", {
			blockers: plan.blockers.map((blocker) => blocker.code),
		});
	// A recorded item worktree is always registered; an unregistered path is not this item's.
	if (plan.confirmations.includes("acknowledgeUnregistered"))
		return refuse("TEAM_WORKTREE_NOT_RECORDED");
	const needsForce = plan.confirmations.includes("force");
	if (needsForce && !input.force) return refuse("WORKTREE_REMOVAL_FORCE_REQUIRED", { loss });
	let removed: WorktreeRemovalResult;
	try {
		removed = await port.removeWorktree({
			coordinatorId: team.teamId,
			principal: input.principal,
			path,
			expectedRevision: plan.expectedRevision,
			...(needsForce ? { force: true, confirmedLoss: input.confirmedLoss } : {}),
			signal: input.signal,
		});
	} catch (error) {
		if (error instanceof AppError) {
			const changed = (error.details as { plan?: WorktreeRemovalPlan } | undefined)?.plan;
			return refuse(
				error.code,
				changed
					? {
							loss: {
								head: changed.worktree.head,
								dirtyFileCount: changed.worktree.dirtyFileCount,
								unreachableCommits: changed.worktree.unreachableCommits,
							},
						}
					: {},
			);
		}
		throw error;
	}
	if (removed.outcome === "failed") return refuse(removed.error?.code ?? "WORKTREE_REMOVAL_FAILED");
	const result: CleanupOutcome = {
		outcome: removed.outcome,
		path,
		branch: item.branchName,
	};
	const now = new Date().toISOString();
	db.transaction((tx) => {
		// The resource row is gone (its FK already set this NULL); say so explicitly anyway.
		tx.update(teamWorkItems)
			.set({ worktreeResourceId: null, updatedAt: now })
			.where(eq(teamWorkItems.id, item.id))
			.run();
		recordWorkEvent(tx, {
			teamId: team.teamId,
			workItemId: item.id,
			kind: "work.cleanup",
			actor: input.actor,
			detail: { ...result, forced: needsForce, branchKept: true },
			at: now,
		});
	});
	return result;
}

// ── Isolated items: clean when the run ends with nothing ────────────────────

/**
 * After the subagent of an `isolated` item ends a run: no commit beyond the base and no
 * uncommitted change means nothing was done, so the worktree is removed through the removal
 * channel (never forced) and the item cancelled. Anything else leaves the item in progress.
 * Returns what happened (tests); never throws.
 */
export async function settleIsolatedWorkItem(
	workerNarratorId: string,
	options: { retry?: boolean; signal?: AbortSignal } = {},
): Promise<"cleaned" | "kept" | "skipped" | "none"> {
	if (activeDatabaseBackend !== "sqlite") return "none";
	const item = db
		.select()
		.from(teamWorkItems)
		.where(
			and(
				eq(teamWorkItems.workerNarratorId, workerNarratorId),
				eq(teamWorkItems.kind, TEAM_ISOLATED_WORK_KIND),
				eq(teamWorkItems.state, "in_progress"),
				isNotNull(teamWorkItems.worktreeResourceId),
			),
		)
		.limit(1)
		.get();
	if (!item) return "none";
	return settleItem(item, options);
}

/**
 * An isolated item whose subagent never started (the Agent call failed after the item was made):
 * settled the same way, so its untouched worktree does not linger.
 */
export async function settleUnstartedIsolatedItem(
	teamId: string,
	itemId: string,
): Promise<"cleaned" | "kept" | "skipped" | "none"> {
	const item = db
		.select()
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.id, itemId), eq(teamWorkItems.teamId, teamId)))
		.limit(1)
		.get();
	if (
		!item ||
		item.kind !== TEAM_ISOLATED_WORK_KIND ||
		item.workerNarratorId ||
		item.state !== "in_progress" ||
		!item.worktreeResourceId
	)
		return "none";
	return settleItem(item, { retry: false });
}

async function settleItem(
	item: WorkItemRow,
	options: { retry?: boolean; signal?: AbortSignal },
): Promise<"cleaned" | "kept" | "skipped" | "none"> {
	const signal = options.signal ?? new AbortController().signal;
	try {
		const path = worktreePathOf(item);
		if (!path) return "none";
		const baseSha = await gitService.resolveCommit(path, item.baseRef ?? "HEAD");
		const head = await gitService.resolveCommit(path, "HEAD");
		if (!baseSha || !head) return "kept";
		const commits = await gitService.countCommitsNotIn(path, head, [baseSha]);
		const dirty = await gitService.getUncommittedChanges(path);
		if (commits > 0 || dirty.count > 0 || !dirty.exact) return "kept";
		const actor: WorkActor = { kind: "agent", id: item.teamId };
		if (!item.createdBy) {
			recordWorkEvent(db, {
				teamId: item.teamId,
				workItemId: item.id,
				kind: "work.cleanup",
				actor,
				detail: { outcome: "skipped", auto: true, code: "TEAM_NO_PERSON" },
			});
			return "skipped";
		}
		const port = await ports();
		const principal = await port.principalOf(item.createdBy);
		for (let attempt = 0; ; attempt++) {
			const plan = await port.planRemoval({
				coordinatorId: item.teamId,
				principal,
				path,
				signal,
			});
			const blocker = plan.blockers[0]?.code;
			if (
				blocker &&
				options.retry !== false &&
				SETTLE_BLOCKERS_TO_RETRY.has(blocker) &&
				attempt < SETTLE_RETRY_DELAYS_MS.length
			) {
				await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_DELAYS_MS[attempt]));
				continue;
			}
			if (plan.status !== "ready" || plan.confirmations.length > 0) {
				recordWorkEvent(db, {
					teamId: item.teamId,
					workItemId: item.id,
					kind: "work.cleanup",
					actor,
					detail: {
						outcome: "skipped",
						auto: true,
						code: blocker ?? plan.confirmations[0] ?? "WORKTREE_REMOVAL_BLOCKED",
					},
				});
				return "skipped";
			}
			const removed = await port.removeWorktree({
				coordinatorId: item.teamId,
				principal,
				path,
				expectedRevision: plan.expectedRevision,
				signal,
			});
			if (removed.outcome === "failed") {
				recordWorkEvent(db, {
					teamId: item.teamId,
					workItemId: item.id,
					kind: "work.cleanup",
					actor,
					detail: { outcome: "skipped", auto: true, code: removed.error?.code ?? "FAILED" },
				});
				return "skipped";
			}
			const now = new Date().toISOString();
			const current = requireWorkItem(item.teamId, item.id);
			db.transaction((tx) => {
				updateItem(tx, current, { state: "cancelled", worktreeResourceId: null }, now);
				recordWorkEvent(tx, {
					teamId: item.teamId,
					workItemId: item.id,
					kind: "work.cleanup",
					actor,
					detail: {
						outcome: removed.outcome,
						auto: true,
						path,
						branch: item.branchName,
						branchKept: true,
					},
					at: now,
				});
				recordWorkEvent(tx, {
					teamId: item.teamId,
					workItemId: item.id,
					kind: "work.cancelled",
					actor,
					detail: { from: current.state, reason: "no_changes", auto: true },
					at: now,
				});
			});
			return "cleaned";
		}
	} catch (error) {
		logger.warn("Isolated work item settle failed", {
			workItemId: item.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return "kept";
	}
}

// ── Brief and decisions ─────────────────────────────────────────────────────

export function readBrief(coordinatorId: string): string {
	return requireCoordinatedTeam(coordinatorId).brief;
}

/** Replace the team brief (≤ 4 KB); recorded as `team.brief` with the agent as actor. */
export function updateBrief(input: { coordinatorId: string; text: string; actor: WorkActor }): {
	bytes: number;
	changed: boolean;
} {
	const team = requireActiveTeam(input.coordinatorId);
	const bytes = utf8Bytes(input.text);
	if (bytes > TEAM_BRIEF_MAX_BYTES)
		throw new ValidationError(
			`The team brief is at most ${TEAM_BRIEF_MAX_BYTES} bytes (this text is ${bytes})`,
		);
	if (input.text === team.brief) return { bytes, changed: false };
	const now = new Date().toISOString();
	db.transaction((tx) => {
		tx.update(projectTeams)
			.set({ brief: input.text, updatedAt: now })
			.where(eq(projectTeams.narratorId, team.teamId))
			.run();
		recordWorkEvent(tx, {
			teamId: team.teamId,
			workItemId: null,
			kind: "team.brief",
			actor: input.actor,
			detail: { bytes },
			at: now,
		});
	});
	return { bytes, changed: true };
}

/** Record a decision the coordinator took on people's behalf (`team.decision`, `summary`). */
export function recordDecision(input: {
	coordinatorId: string;
	text: string;
	itemId?: string;
	actor: WorkActor;
}): string {
	const team = requireActiveTeam(input.coordinatorId);
	const summary = input.text.trim();
	if (!summary) throw new ValidationError("A decision needs its text");
	if (utf8Bytes(summary) > TEAM_DECISION_MAX_BYTES)
		throw new ValidationError(`A decision is at most ${TEAM_DECISION_MAX_BYTES} bytes`);
	if (input.itemId) requireWorkItem(team.teamId, input.itemId);
	return recordWorkEvent(db, {
		teamId: team.teamId,
		workItemId: input.itemId ?? null,
		kind: "team.decision",
		actor: input.actor,
		detail: { summary },
	});
}

// ── Check-ins ───────────────────────────────────────────────────────────────

export interface CheckinClock {
	now(): number;
	after(ms: number, fn: () => void): () => void;
}

const realClock: CheckinClock = {
	now: () => Date.now(),
	after(ms, fn) {
		const timer = setTimeout(fn, ms);
		// A waiting check-in never keeps the process alive.
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

type CheckinWake = (input: {
	teamId: string;
	minutes: number;
	note: string | null;
	locale: string;
}) => Promise<void>;

const checkins = {
	clock: realClock,
	wake: null as CheckinWake | null,
	/** One pending check-in per team: a new one replaces it. */
	pending: new Map<string, { eventId: string; cancel: () => void }>(),
};

/** Replace the clock and the wake (tests); nulls restore production. */
export function setCheckinSeamsForTests(seams: {
	clock?: CheckinClock | null;
	wake?: CheckinWake | null;
}): void {
	if (seams.clock !== undefined) checkins.clock = seams.clock ?? realClock;
	if (seams.wake !== undefined) checkins.wake = seams.wake;
}

export function resetCheckinsForTests(): void {
	for (const pending of checkins.pending.values()) pending.cancel();
	checkins.pending.clear();
}

/** Pending check-ins (tests and status). */
export function pendingCheckinCount(teamId?: string): number {
	return teamId ? (checkins.pending.has(teamId) ? 1 : 0) : checkins.pending.size;
}

async function defaultCheckinWake(input: {
	teamId: string;
	minutes: number;
	note: string | null;
	locale: string;
}): Promise<void> {
	const { checkinText } = await import("../../lib/prompts/team-lead");
	const text = checkinText(input.locale === "zh-CN" ? "zh-CN" : "en", input.minutes, input.note);
	const { deliverInjection } = await import("../narrator-injection");
	await deliverInjection(input.teamId, {
		content: text,
		source: "team_checkin",
		body: { kind: "prose", text },
		schedule: "wakeIfIdle",
	});
}

function arm(
	teamId: string,
	eventId: string,
	dueAt: number,
	minutes: number,
	note: string | null,
	locale: string,
): void {
	checkins.pending.get(teamId)?.cancel();
	const cancel = checkins.clock.after(Math.max(0, dueAt - checkins.clock.now()), () => {
		const current = checkins.pending.get(teamId);
		if (current?.eventId !== eventId) return;
		checkins.pending.delete(teamId);
		recordWorkEvent(db, {
			teamId,
			workItemId: null,
			kind: "team.checkin",
			actor: { kind: "system", id: null },
			detail: { fired: eventId },
		});
		void (checkins.wake ?? defaultCheckinWake)({ teamId, minutes, note, locale }).catch((error) => {
			logger.warn("Team check-in wake failed", { teamId, error: String(error) });
		});
	});
	checkins.pending.set(teamId, { eventId, cancel });
}

/**
 * Schedule one wake-up of the coordinator after `minutes` (1 minute to 1 day). A team has at
 * most one pending check-in: scheduling another replaces it. The schedule is recorded as a
 * `team.checkin` event (`dueAt`), so a restart re-arms it.
 */
export function scheduleCheckin(input: {
	coordinatorId: string;
	minutes: number;
	note?: string;
	locale: string;
	actor: WorkActor;
}): { dueAt: string; replaced: boolean } {
	const team = requireActiveTeam(input.coordinatorId);
	if (
		!Number.isInteger(input.minutes) ||
		input.minutes < TEAM_CHECKIN_MIN_MINUTES ||
		input.minutes > TEAM_CHECKIN_MAX_MINUTES
	)
		throw new ValidationError(
			`minutes must be a whole number from ${TEAM_CHECKIN_MIN_MINUTES} to ${TEAM_CHECKIN_MAX_MINUTES}`,
		);
	const note = input.note?.trim().slice(0, 500) || null;
	const dueAtMs = checkins.clock.now() + input.minutes * 60_000;
	const dueAt = new Date(dueAtMs).toISOString();
	const replaced = checkins.pending.has(team.teamId);
	const eventId = recordWorkEvent(db, {
		teamId: team.teamId,
		workItemId: null,
		kind: "team.checkin",
		actor: input.actor,
		detail: { dueAt, minutes: input.minutes, note, locale: input.locale },
	});
	arm(team.teamId, eventId, dueAtMs, input.minutes, note, input.locale);
	return { dueAt, replaced };
}

/**
 * Re-arm the check-ins a restart dropped: per active team, its newest `team.checkin` event of
 * the last day, unless that event is a firing. A due time already passed fires at once.
 * Bounded: at most 500 teams, and per team a `(team_id, created_at)` range of one day.
 */
export function rearmCheckins(): number {
	if (activeDatabaseBackend !== "sqlite") return 0;
	const since = new Date(checkins.clock.now() - CHECKIN_LOOKBACK_MS).toISOString();
	const teams = db
		.select({ id: projectTeams.narratorId })
		.from(projectTeams)
		.where(eq(projectTeams.status, "active"))
		.orderBy(asc(projectTeams.narratorId))
		.limit(500)
		.all();
	let armed = 0;
	for (const team of teams) {
		const newest = db
			.select({ id: teamWorkEvents.id, detail: teamWorkEvents.detailJson })
			.from(teamWorkEvents)
			.where(
				and(
					eq(teamWorkEvents.teamId, team.id),
					eq(teamWorkEvents.kind, "team.checkin"),
					gte(teamWorkEvents.createdAt, since),
				),
			)
			.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
			.limit(1)
			.get();
		const detail = newest?.detail;
		if (!newest || !detail || typeof detail.dueAt !== "string" || detail.fired) continue;
		const dueAt = Date.parse(detail.dueAt);
		if (Number.isNaN(dueAt)) continue;
		arm(
			team.id,
			newest.id,
			dueAt,
			typeof detail.minutes === "number" ? detail.minutes : 0,
			typeof detail.note === "string" ? detail.note : null,
			typeof detail.locale === "string" ? detail.locale : "en",
		);
		armed++;
	}
	return armed;
}

// ── Startup ─────────────────────────────────────────────────────────────────

/**
 * Follow subagent runs of team coordinators: when the first-level subagent of an isolated item
 * ends a run, settle the item. Also re-arms pending check-ins. Returns the stop function.
 */
export function startTeamWorkLifecycle(): () => void {
	let stopped = false;
	const onCompleted = (event: { narratorId: string; parentNarratorId: string }) => {
		if (stopped || activeDatabaseBackend !== "sqlite") return;
		try {
			const team = db
				.select({ id: projectTeams.narratorId })
				.from(projectTeams)
				.where(eq(projectTeams.narratorId, event.parentNarratorId))
				.limit(1)
				.get();
			if (!team) return;
		} catch {
			return;
		}
		void settleIsolatedWorkItem(event.narratorId);
	};
	let off = () => {};
	void import("../../lib/event-bus").then(({ eventBus }) => {
		if (stopped) return;
		eventBus.on("narrator:subagent_completed", onCompleted);
		off = () => eventBus.off("narrator:subagent_completed", onCompleted);
	});
	try {
		rearmCheckins();
	} catch (error) {
		logger.warn("Team check-ins could not be re-armed", { error: String(error) });
	}
	return () => {
		stopped = true;
		off();
	};
}
