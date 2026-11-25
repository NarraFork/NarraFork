/**
 * Merging a ready work item back into its base (M), on a member's request from the team page.
 *
 * Hard constraint: never obstruct anyone's work. NarraFork never switches a branch, never touches
 * a working tree or an index, never leaves merge or conflict state in a checkout, and never moves
 * a checked-out base with `update-ref`. The git runs in a background job (the route records
 * `work.merge_requested` and answers 202), with timeouts, outside any SQLite transaction; one
 * in-memory mutex per project serializes merges there (nothing else waits on it) and one job per
 * item runs at a time. While a job holds an item, 退回 and the coordinator's review, ready, sync
 * and cancel are refused with 409 `TEAM_WORK_ITEM_MERGING` (`team-merge-guard.ts`).
 *
 * The local flow (`team-git-write.ts`), used whenever origin is not on GitHub:
 *  1. the item is ready, its team active, its worker not running, its branch tip still the head
 *     recorded at ready, the base a local branch, git ≥ 2.38 (the knowledge check is not run
 *     again: the head was checked at ready);
 *  2. OLD = the base; a head already inside it is merged as it is;
 *  3. `merge-tree --write-tree OLD head` (conflicts: `work.merge_failed {code: "conflict"}` with at
 *     most 50 files, the coordinator told; nothing written anywhere);
 *  4. `commit-tree` (a merge commit, the clicking person's identity, `-S` when signing is on),
 *     parked at `refs/narrafork/team-merges/<itemId>`;
 *  5. `git fetch . M:refs/heads/<base>`: fast-forwarded → `work.merged {detectedBy:
 *     "local_merge"}`, the private ref deleted, the coordinator told; refused as not a
 *     fast-forward → once more from 2, then `TEAM_MERGE_BASE_MOVED`; refused because the base is
 *     checked out → `work.merge_prepared` (the merge waits at the private ref).
 * A prepared merge is fast-forwarded only on an explicit 「在该目录中快进」 (`requestFastForward`):
 * `merge --ff-only` in that checkout, every hook off, under the checkout's worktree lock (500 ms
 * try), and only when the checkout is exactly where the merge was computed (HEAD on the base, the
 * base still OLD, no operation in progress, no index lock, no session running there, no filter
 * or hooks directory of its own). Otherwise the person runs the copyable command, and ancestry
 * notices the merge.
 *
 * A crash between moving the base and recording the merge heals by ancestry (the background pass
 * in `team-overlap.ts`, or the next request); private refs of items no longer ready are pruned at
 * startup and after each job.
 *
 * When origin is on GitHub the PR flow decides (a later PR): until then the action is disabled
 * (`github_pending`), never replaced by a local merge.
 */
import {
	TEAM_MERGE_CONFLICTS_MAX,
	TEAM_MERGE_REF_PREFIX,
	type TeamFastForwardBlocker,
	type TeamMergeDisabledReason,
	type TeamMergeMode,
	type TeamMergePhase,
	type TeamWorkMergeOutcome,
	type TeamWorkMergeResponse,
	type TeamWorkMergeSummary,
	type TeamWorkMergeView,
} from "@shared/project-teams";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
	narrators,
	projects,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
	terminals,
	users,
} from "../../db/schema";
import { AsyncMutex, worktreeLock } from "../../lib/async-mutex";
import { AppError, NotFoundError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { resolveUserGitIdentityEnv } from "../../lib/git-identity";
import { hotSafe } from "../../lib/hot-safe";
import { getUserLanguage, type Locale } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { oneLine } from "../../lib/prompts/team-coordinator-notes";
import {
	canonicalCheckout,
	fastForwardCheckout,
	fastForwardCommand,
	gitVersion,
	inspectCheckout,
	peekGitVersion,
	supportsMergeTree,
	teamRepoGit,
} from "./team-git-write";
import { hostingOf, peekHosting } from "./team-hosting";
import { claimMerging, isMerging, releaseMerging } from "./team-merge-guard";
import { deliverMergeNote, markMergedByLocalMerge, recordWorkEvent } from "./work-items";

type WorkItemRow = typeof teamWorkItems.$inferSelect;

/** How long a running job may take in all before it gives up (its git has its own timeouts). */
const JOB_DEADLINE_MS = 10 * 60_000;
/** Sessions in a checkout scanned for the fast-forward's "nothing runs there" check. */
const CHECKOUT_SESSIONS_SCAN = 200;
const CHECKOUT_TERMINALS_SCAN = 50;
/** How long a prepared checkout's inspection is reused by the drawer. */
const INSPECTION_TTL_MS = 15_000;

const RUNNING = new Set(["working", "waiting"]);

/** Escape LIKE metacharacters for a prefix bound with `ESCAPE '\'`. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);
/** Events after which an earlier merge outcome no longer applies. */
const OUTCOME_KINDS = [
	"work.ready",
	"work.returned",
	"work.merge_requested",
	"work.merge_failed",
	"work.merge_prepared",
] as const;

interface MergeJob {
	itemId: string;
	teamId: string;
	projectId: string;
	job: "merge" | "fast_forward";
	phase: TeamMergePhase;
	startedAt: number;
}

const state = hotSafe("narrafork.teams.mergeJobs", () => ({
	jobs: new Map<string, MergeJob>(),
	running: new Set<Promise<void>>(),
	inspections: new Map<
		string,
		{
			at: number;
			key: string;
			blocker: TeamFastForwardBlocker | null;
			running: number;
			terminals: number;
		}
	>(),
}));
const projectLocks = hotSafe("narrafork.teams.mergeLocks", () => new AsyncMutex());

/** The job running for an item, if any. */
export function mergeJobOf(itemId: string): Readonly<MergeJob> | null {
	return state.jobs.get(itemId) ?? null;
}

/** Wait for every running job (tests and shutdown). */
export async function settleMergeJobs(): Promise<void> {
	while (state.running.size > 0) await Promise.allSettled([...state.running]);
}

export function resetMergeJobsForTests(): void {
	for (const itemId of state.jobs.keys()) releaseMerging(itemId);
	state.jobs.clear();
	state.inspections.clear();
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** A failed job's error as the event records it. */
class MergeFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The newest merge outcome of an item since it became ready (or was returned, or a new merge was
 * asked for): one indexed read of its events, newest first, at most one row.
 */
export function readMergeOutcome(itemId: string): TeamWorkMergeOutcome | null {
	const row = db
		.select({
			kind: teamWorkEvents.kind,
			detail: teamWorkEvents.detailJson,
			at: teamWorkEvents.createdAt,
		})
		.from(teamWorkEvents)
		.where(
			and(eq(teamWorkEvents.workItemId, itemId), inArray(teamWorkEvents.kind, [...OUTCOME_KINDS])),
		)
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get();
	if (!row) return null;
	const detail = row.detail ?? {};
	if (row.kind === "work.merge_failed") {
		const conflicts = Array.isArray(detail.conflicts)
			? detail.conflicts.filter((file): file is string => typeof file === "string")
			: undefined;
		return {
			kind: "failed",
			code: str(detail.code) ?? "TEAM_MERGE_FAILED",
			message: str(detail.message),
			...(conflicts ? { conflicts: conflicts.slice(0, TEAM_MERGE_CONFLICTS_MAX) } : {}),
			...(detail.more === true ? { more: true } : {}),
			at: row.at,
		};
	}
	if (row.kind === "work.merge_prepared") {
		const mergeCommit = str(detail.mergeCommit);
		const baseSha = str(detail.baseSha);
		const checkedOutAt = str(detail.checkedOutAt);
		if (!mergeCommit || !baseSha || !checkedOutAt) return null;
		return { kind: "prepared", mergeCommit, baseSha, checkedOutAt, at: row.at };
	}
	return null;
}

/** The repository a project's merges run in: the project's directory. */
function repositoryOf(projectId: string): string | null {
	return (
		db
			.select({ gitPath: projects.gitPath })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1)
			.get()?.gitPath ?? null
	);
}

/** How the item would be merged now, from the cached hosting (never waits). */
export function mergeModeOf(projectId: string): TeamMergeMode {
	const repo = repositoryOf(projectId);
	if (!repo) return "local";
	const hosting = peekHosting(repo);
	if (!hosting) return "checking";
	return hosting.kind === "github" ? "github" : "local";
}

/** A base given as a remote-tracking ref (`origin/main`): a local merge cannot move it. */
export function isRemoteTrackingBase(base: string): boolean {
	return (
		base.startsWith("refs/remotes/") || base.startsWith("remotes/") || base.startsWith("origin/")
	);
}

/**
 * A ready item's merge state as cards show it, without git: the job table, the newest outcome
 * event, the cached hosting and git version.
 */
export function mergeSummaryOf(input: {
	item: Pick<WorkItemRow, "id" | "state" | "baseRef" | "projectId">;
	baseBranch: string;
	teamActive: boolean;
	workerRunning: boolean;
	member: boolean;
	outcome?: TeamWorkMergeOutcome | null;
	mode?: TeamMergeMode;
}): TeamWorkMergeSummary {
	const job = state.jobs.get(input.item.id) ?? null;
	const outcome = input.outcome === undefined ? readMergeOutcome(input.item.id) : input.outcome;
	const mode = input.mode ?? mergeModeOf(input.item.projectId);
	const base = input.item.baseRef ?? input.baseBranch;
	const version = peekGitVersion();
	let reason: TeamMergeDisabledReason | null = null;
	if (input.item.state !== "ready") reason = "not_ready";
	else if (!input.teamActive) reason = "team_archived";
	else if (job || isMerging(input.item.id)) reason = "merging";
	else if (input.workerRunning) reason = "worker_running";
	else if (mode === "checking") reason = "checking";
	else if (mode === "github") reason = "github_pending";
	else if (isRemoteTrackingBase(base)) reason = "base_remote";
	else if (version !== undefined && !supportsMergeTree(version)) reason = "git_too_old";
	return {
		mode,
		phase: job?.phase ?? null,
		job: job?.job ?? null,
		outcome:
			outcome?.kind === "prepared"
				? "prepared"
				: outcome?.kind === "failed"
					? outcome.code === "conflict"
						? "conflict"
						: "failed"
					: null,
		canMerge: input.member && reason === null,
		disabledReason: reason,
	};
}

/**
 * Sessions running in a person's checkout (the directory or below, outside its `.worktrees/`),
 * by status, and NarraFork terminals open there (a warning only). Bounded scans.
 */
async function checkoutActivity(
	dir: string,
	options: { backgroundTasks: boolean },
): Promise<{ running: number; terminals: number }> {
	const root = await canonicalCheckout(dir);
	const prefix = `${root.replace(/\/+$/, "")}/`;
	const pattern = `${escapeLike(prefix)}%`;
	const nested = `${escapeLike(`${prefix}.worktrees/`)}%`;
	const rows = db
		.select({ id: narrators.id, status: narrators.status })
		.from(narrators)
		.where(
			and(
				or(eq(narrators.cwd, root), sql`${narrators.cwd} like ${pattern} escape '\\'`),
				sql`${narrators.cwd} not like ${nested} escape '\\'`,
			),
		)
		.limit(CHECKOUT_SESSIONS_SCAN)
		.all();
	let running = 0;
	const { isNarratorRuntimeBusy } = await import("../narrator-session-state");
	for (const row of rows) {
		if (RUNNING.has(row.status) || isNarratorRuntimeBusy(row.id)) {
			running++;
			continue;
		}
		if (options.backgroundTasks) {
			const { backgroundTaskService } = await import("../background-task-service");
			if ((await backgroundTaskService.countActiveByParent(row.id)) > 0) running++;
		}
	}
	const open = db
		.select({ id: terminals.id })
		.from(terminals)
		.where(or(eq(terminals.cwd, root), sql`${terminals.cwd} like ${pattern} escape '\\'`))
		.limit(CHECKOUT_TERMINALS_SCAN)
		.all();
	return { running, terminals: open.length };
}

/** The drawer's check of a prepared checkout, reused for a few seconds. */
async function inspectPrepared(
	itemId: string,
	base: string,
	prepared: Extract<TeamWorkMergeOutcome, { kind: "prepared" }>,
): Promise<{ blocker: TeamFastForwardBlocker | null; running: number; terminals: number }> {
	const key = `${prepared.mergeCommit}:${prepared.baseSha}:${prepared.checkedOutAt}`;
	const cached = state.inspections.get(itemId);
	if (cached && cached.key === key && Date.now() - cached.at < INSPECTION_TTL_MS) return cached;
	const blocker = await inspectCheckout(prepared.checkedOutAt, base, prepared.baseSha);
	const activity = await checkoutActivity(prepared.checkedOutAt, { backgroundTasks: false }).catch(
		() => ({ running: 0, terminals: 0 }),
	);
	const entry = {
		at: Date.now(),
		key,
		blocker: blocker ?? (activity.running > 0 ? ("sessions_running" as const) : null),
		running: activity.running,
		terminals: activity.terminals,
	};
	state.inspections.set(itemId, entry);
	if (state.inspections.size > 200) {
		const oldest = state.inspections.keys().next().value;
		if (oldest !== undefined) state.inspections.delete(oldest);
	}
	return entry;
}

/** A ready item's merge state in the drawer: the summary, the outcome in full, the fast-forward. */
export async function mergeViewOf(input: {
	item: WorkItemRow;
	baseBranch: string;
	teamActive: boolean;
	workerRunning: boolean;
	member: boolean;
}): Promise<TeamWorkMergeView> {
	const outcome = readMergeOutcome(input.item.id);
	const summary = mergeSummaryOf({ ...input, outcome });
	const view: TeamWorkMergeView = { ...summary, detail: outcome };
	if (outcome?.kind === "prepared") {
		const base = input.item.baseRef ?? input.baseBranch;
		const inspected = await inspectPrepared(input.item.id, base, outcome).catch(() => ({
			blocker: "unreadable" as const,
			running: 0,
			terminals: 0,
		}));
		view.fastForward = {
			available: inspected.blocker === null,
			blocker: inspected.blocker,
			runningSessions: inspected.running,
			terminals: inspected.terminals,
			command: fastForwardCommand(outcome.checkedOutAt, input.item.id),
		};
	}
	return view;
}

// ── Requests ────────────────────────────────────────────────────────────────

interface Requester {
	userId: string | null;
}

interface JobContext extends Requester {
	itemId: string;
	teamId: string;
	projectId: string;
}

function teamRow(teamId: string) {
	return db
		.select({
			status: projectTeams.status,
			baseBranch: projectTeams.baseBranch,
			projectId: projectTeams.projectId,
			coordinator: narrators.status,
		})
		.from(projectTeams)
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(eq(projectTeams.narratorId, teamId))
		.limit(1)
		.get();
}

function itemRow(teamId: string, itemId: string): WorkItemRow | null {
	return (
		db
			.select()
			.from(teamWorkItems)
			.where(and(eq(teamWorkItems.id, itemId), eq(teamWorkItems.teamId, teamId)))
			.limit(1)
			.get() ?? null
	);
}

function workerRunning(item: Pick<WorkItemRow, "workerNarratorId">): boolean {
	if (!item.workerNarratorId) return false;
	const worker = db
		.select({ status: narrators.status })
		.from(narrators)
		.where(eq(narrators.id, item.workerNarratorId))
		.limit(1)
		.get();
	return !!worker && RUNNING.has(worker.status);
}

/** The cheap checks a request makes before a job starts (the job checks again). */
function requireMergeable(teamId: string, itemId: string) {
	const team = teamRow(teamId);
	if (!team) throw new NotFoundError("Team", teamId);
	if (team.status !== "active" || team.coordinator === "archived")
		throw new AppError("This team is archived; nothing can change", 409, "TEAM_ARCHIVED");
	const item = itemRow(teamId, itemId);
	if (!item) throw new NotFoundError("Work item", itemId);
	if (item.state !== "ready")
		throw new AppError(
			`Work item ${item.id} is ${item.state}; only a ready item can be merged`,
			409,
			"TEAM_WORK_ITEM_NOT_READY",
		);
	if (isMerging(item.id) || state.jobs.has(item.id))
		throw new AppError(
			`Work item ${item.id} is being merged right now`,
			409,
			"TEAM_WORK_ITEM_MERGING",
		);
	if (workerRunning(item))
		throw new AppError(
			`The worker of work item ${item.id} is running; merge once it has stopped`,
			409,
			"TEAM_WORK_ITEM_WORKER_RUNNING",
		);
	return { team, item };
}

function startJob(
	context: JobContext,
	job: MergeJob["job"],
	run: (context: JobContext) => Promise<void>,
): TeamWorkMergeResponse {
	if (!claimMerging(context.itemId))
		throw new AppError(
			`Work item ${context.itemId} is being merged right now`,
			409,
			"TEAM_WORK_ITEM_MERGING",
		);
	const entry: MergeJob = {
		itemId: context.itemId,
		teamId: context.teamId,
		projectId: context.projectId,
		job,
		phase: "queued",
		startedAt: Date.now(),
	};
	state.jobs.set(context.itemId, entry);
	try {
		recordWorkEvent(db, {
			teamId: context.teamId,
			workItemId: context.itemId,
			kind: "work.merge_requested",
			actor: { kind: "person", id: context.userId },
			detail: { job, mode: "local" },
		});
	} catch (error) {
		state.jobs.delete(context.itemId);
		releaseMerging(context.itemId);
		throw error;
	}
	eventBus.emit({ type: "team:communication_changed", teamId: context.teamId });
	const work = (async () => {
		try {
			await projectLocks.acquire(context.projectId, () =>
				withDeadline(run(context), JOB_DEADLINE_MS),
			);
		} catch (error) {
			recordFailure(context, error);
		} finally {
			state.jobs.delete(context.itemId);
			state.inspections.delete(context.itemId);
			releaseMerging(context.itemId);
			eventBus.emit({ type: "team:communication_changed", teamId: context.teamId });
			void pruneProjectMergeRefs(context.projectId).catch((error) =>
				logger.debug("Team merge refs were not pruned", { error: String(error) }),
			);
		}
	})();
	state.running.add(work);
	void work.finally(() => state.running.delete(work));
	return { itemId: context.itemId, job, phase: "queued" };
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new MergeFailure("TEAM_MERGE_TIMEOUT", "The merge took too long")),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function setPhase(itemId: string, phase: TeamMergePhase): void {
	const job = state.jobs.get(itemId);
	if (job) job.phase = phase;
}

/** Record a failed job as `work.merge_failed` (never throws). */
function recordFailure(context: JobContext, error: unknown): void {
	const failure =
		error instanceof MergeFailure
			? error
			: error instanceof AppError
				? new MergeFailure(error.code ?? "TEAM_MERGE_FAILED", error.message)
				: new MergeFailure(
						"TEAM_MERGE_FAILED",
						error instanceof Error ? error.message : String(error),
					);
	if (!(error instanceof MergeFailure))
		logger.warn("Team merge failed", {
			workItemId: context.itemId,
			error: error instanceof Error ? error.message : String(error),
		});
	try {
		recordWorkEvent(db, {
			teamId: context.teamId,
			workItemId: context.itemId,
			kind: "work.merge_failed",
			actor: { kind: "person", id: context.userId },
			detail: { code: failure.code, message: failure.message.slice(0, 500), ...failure.extra },
		});
	} catch (recordError) {
		logger.warn("Team merge failure could not be recorded", { error: String(recordError) });
	}
}

/**
 * A member asks to merge a ready item (`POST …/work/:itemId/merge`, write access checked by the
 * route): cheap checks, `work.merge_requested`, then the job in the background (202).
 */
export function requestMerge(input: {
	teamId: string;
	itemId: string;
	userId: string | null;
}): TeamWorkMergeResponse {
	const { team, item } = requireMergeable(input.teamId, input.itemId);
	const base = item.baseRef ?? team.baseBranch;
	const mode = mergeModeOf(team.projectId);
	if (mode === "github")
		throw new AppError(
			"This project's origin is on GitHub: work items merge through a pull request, which NarraFork does not offer yet",
			409,
			"TEAM_MERGE_GITHUB_PENDING",
		);
	if (isRemoteTrackingBase(base))
		throw new AppError(
			`The base ${base} is a remote-tracking branch; a local merge can only move a local branch`,
			409,
			"TEAM_MERGE_BASE_REMOTE",
		);
	return startJob(
		{ itemId: item.id, teamId: input.teamId, projectId: team.projectId, userId: input.userId },
		"merge",
		runMerge,
	);
}

/** A member asks to fast-forward a prepared merge in the checkout the base is checked out in. */
export function requestFastForward(input: {
	teamId: string;
	itemId: string;
	userId: string | null;
}): TeamWorkMergeResponse {
	const { team, item } = requireMergeable(input.teamId, input.itemId);
	const outcome = readMergeOutcome(item.id);
	if (outcome?.kind !== "prepared")
		throw new AppError(
			`Work item ${item.id} has no prepared merge to fast-forward; merge it first`,
			409,
			"TEAM_MERGE_NOT_PREPARED",
		);
	return startJob(
		{ itemId: item.id, teamId: input.teamId, projectId: team.projectId, userId: input.userId },
		"fast_forward",
		runFastForward,
	);
}

// ── The jobs ────────────────────────────────────────────────────────────────

/** Re-read everything a job relies on, under the project's mutex. */
async function jobFacts(context: JobContext) {
	const team = teamRow(context.teamId);
	if (!team || team.status !== "active" || team.coordinator === "archived")
		throw new MergeFailure("TEAM_ARCHIVED", "The team was archived");
	const item = itemRow(context.teamId, context.itemId);
	if (!item) throw new MergeFailure("TEAM_WORK_ITEM_CHANGED", "The work item is gone");
	if (item.state !== "ready" || !item.headSha || !item.branchName)
		throw new MergeFailure(
			"TEAM_WORK_ITEM_NOT_READY",
			`The work item is ${item.state}; only a ready item can be merged`,
		);
	if (workerRunning(item))
		throw new MergeFailure(
			"TEAM_WORK_ITEM_WORKER_RUNNING",
			"The item's worker is running; merge once it has stopped",
		);
	const repo = repositoryOf(context.projectId);
	if (!repo) throw new MergeFailure("TEAM_PROJECT_NOT_GIT", "The project has no repository");
	const hosting = await hostingOf(repo);
	if (hosting.kind === "github")
		throw new MergeFailure(
			"TEAM_MERGE_GITHUB_PENDING",
			"Origin is on GitHub: this item merges through a pull request, not offered yet",
		);
	if (!supportsMergeTree(await gitVersion()))
		throw new MergeFailure(
			"TEAM_MERGE_GIT_TOO_OLD",
			"git 2.38 or newer is needed to merge without touching a working tree",
		);
	const base = item.baseRef ?? team.baseBranch;
	const git = teamRepoGit(repo);
	if (isRemoteTrackingBase(base) || !(await git.resolve(`refs/heads/${base}`)))
		throw new MergeFailure(
			isRemoteTrackingBase(base) ? "TEAM_MERGE_BASE_REMOTE" : "TEAM_BASE_UNRESOLVED",
			`The base ${base} is not a local branch of the repository`,
		);
	const tip = await git.resolve(`refs/heads/${item.branchName}`);
	if (tip !== item.headSha)
		throw new MergeFailure(
			"TEAM_WORK_ITEM_HEAD_MOVED",
			`The branch ${item.branchName} moved since it was marked ready (head ${item.headSha.slice(0, 12)}, now ${tip ? tip.slice(0, 12) : "missing"}); mark it ready again first`,
		);
	return { team, item, head: item.headSha, branch: item.branchName, base, repo, git };
}

async function personOf(userId: string | null): Promise<{ name: string | null; locale: Locale }> {
	if (!userId) return { name: null, locale: "en" };
	const row = db
		.select({ username: users.username })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)
		.get();
	const locale = await getUserLanguage(userId).catch(() => "en" as const);
	return { name: row?.username ?? null, locale: locale === "zh-CN" ? "zh-CN" : "en" };
}

/** Tell the coordinator; best effort. */
async function notify(
	context: JobContext,
	render: (locale: Locale, by: string | null) => string,
): Promise<void> {
	const person = await personOf(context.userId);
	await deliverMergeNote({
		teamId: context.teamId,
		text: render(person.locale, person.name),
		userId: context.userId,
	});
}

async function landed(
	context: JobContext,
	facts: { item: WorkItemRow; head: string; base: string; title: string; branch: string },
	mergeCommit: string | null,
	baseSha: string,
	detail: Record<string, unknown>,
): Promise<void> {
	const merged = markMergedByLocalMerge({
		itemId: facts.item.id,
		head: facts.head,
		base: baseSha,
		mergeCommit,
		expectedUpdatedAt: facts.item.updatedAt,
		actor: { kind: "person", id: context.userId },
		detail: { baseBranch: facts.base, ...detail },
	});
	if (!merged)
		throw new MergeFailure(
			"TEAM_WORK_ITEM_CHANGED",
			"The base now holds the merge, but the work item changed meanwhile; it is marked merged once its head is found in the base",
		);
	const { mergedNote } = await import("../../lib/prompts/team-lead");
	await notify(context, (locale, by) =>
		mergedNote(locale, {
			itemId: facts.item.id,
			title: facts.title,
			branch: facts.branch,
			base: facts.base,
			by,
			mergeCommit,
		}),
	);
}

async function runMerge(context: JobContext): Promise<void> {
	setPhase(context.itemId, "checking");
	const facts = await jobFacts(context);
	const { item, head, branch, base, git } = facts;
	const title = item.title;
	for (let attempt = 0; attempt < 2; attempt++) {
		const old = await git.resolve(`refs/heads/${base}`);
		if (!old) throw new MergeFailure("TEAM_BASE_UNRESOLVED", `The base ${base} is gone`);
		if (await git.isAncestor(head, old)) {
			await landed(context, { item, head, base, title, branch }, null, old, {
				alreadyInBase: true,
			});
			return;
		}
		setPhase(context.itemId, "merging");
		const merged = await git.mergeTree(old, head);
		if (!merged.clean) {
			const failure = new MergeFailure(
				"conflict",
				`${branch} conflicts with ${base} in ${merged.conflicts.length}${merged.more ? "+" : ""} file(s)`,
				{ conflicts: merged.conflicts, more: merged.more, base, baseSha: old, head },
			);
			recordFailure(context, failure);
			const { mergeConflictNote } = await import("../../lib/prompts/team-lead");
			await notify(context, (locale, by) =>
				mergeConflictNote(locale, {
					itemId: item.id,
					title,
					branch,
					base,
					by,
					conflicts: merged.conflicts,
					more: merged.more,
				}),
			);
			return;
		}
		const identity = await resolveUserGitIdentityEnv(context.userId).catch(() => null);
		const mergeCommit = await git.commitTree({
			tree: merged.tree,
			parents: [old, head],
			message: `Merge team work item: ${oneLine(title, 120)} (${branch})`,
			identity,
		});
		const existing = await git.resolve(`${TEAM_MERGE_REF_PREFIX}${item.id}`);
		await git.setPrivateRef(item.id, mergeCommit, existing);
		setPhase(context.itemId, "updating");
		const moved = await git.fastForwardBase(mergeCommit, base);
		if (moved.outcome === "updated") {
			const now = await git.resolve(`refs/heads/${base}`);
			if (now !== mergeCommit && !(now && (await git.isAncestor(mergeCommit, now))))
				throw new MergeFailure("TEAM_MERGE_BASE_MOVED", `${base} did not take the merge`);
			await landed(context, { item, head, base, title, branch }, mergeCommit, mergeCommit, {});
			await git.deletePrivateRef(item.id, mergeCommit);
			return;
		}
		if (moved.outcome === "checked_out") {
			const checkedOutAt = moved.path ?? (await git.checkedOutAt(base));
			if (!checkedOutAt)
				throw new MergeFailure(
					"TEAM_MERGE_FAILED",
					`${base} is checked out somewhere git did not name`,
				);
			recordWorkEvent(db, {
				teamId: context.teamId,
				workItemId: item.id,
				kind: "work.merge_prepared",
				actor: { kind: "person", id: context.userId },
				detail: { mergeCommit, baseSha: old, checkedOutAt, head, base },
			});
			return;
		}
		// Not a fast-forward: the base moved while the merge was computed. Once more.
	}
	throw new MergeFailure(
		"TEAM_MERGE_BASE_MOVED",
		`${base} kept moving while the merge was computed; try again`,
	);
}

async function runFastForward(context: JobContext): Promise<void> {
	setPhase(context.itemId, "checking");
	const facts = await jobFacts(context);
	const { item, head, branch, base, git } = facts;
	const outcome = readMergeOutcome(item.id);
	if (outcome?.kind !== "prepared")
		throw new MergeFailure("TEAM_MERGE_NOT_PREPARED", "There is no prepared merge any more");
	const privateRef = `${TEAM_MERGE_REF_PREFIX}${item.id}`;
	if ((await git.resolve(privateRef)) !== outcome.mergeCommit)
		throw new MergeFailure(
			"TEAM_MERGE_NOT_PREPARED",
			"The prepared merge commit is gone; prepare the merge again",
		);
	const now = await git.resolve(`refs/heads/${base}`);
	// The person ran the command (or merged) already: nothing left to fast-forward.
	if (now && (now === outcome.mergeCommit || (await git.isAncestor(outcome.mergeCommit, now)))) {
		await landed(
			context,
			{ item, head, base, title: item.title, branch },
			outcome.mergeCommit,
			now,
			{
				fastForwarded: "outside",
				checkedOutAt: outcome.checkedOutAt,
			},
		);
		await git.deletePrivateRef(item.id, outcome.mergeCommit);
		return;
	}
	const blocker = await inspectCheckout(outcome.checkedOutAt, base, outcome.baseSha);
	if (blocker)
		throw new MergeFailure(
			blocker === "stale" ? "TEAM_MERGE_STALE" : "TEAM_MERGE_CHECKOUT_BLOCKED",
			blocker === "stale"
				? `${base} moved since the merge was prepared; prepare it again`
				: `The checkout at ${outcome.checkedOutAt} cannot be fast-forwarded here (${blocker}); run the command yourself`,
			{ blocker },
		);
	const activity = await checkoutActivity(outcome.checkedOutAt, { backgroundTasks: true });
	if (activity.running > 0)
		throw new MergeFailure(
			"TEAM_MERGE_CHECKOUT_BUSY",
			`${activity.running} session(s) or background task(s) are running in ${outcome.checkedOutAt}`,
			{ blocker: "sessions_running", runningSessions: activity.running },
		);
	setPhase(context.itemId, "fast_forwarding");
	const locked = await worktreeLock.tryAcquire(
		outcome.checkedOutAt,
		() => fastForwardCheckout(outcome.checkedOutAt, privateRef),
		500,
	);
	if (!locked.acquired)
		throw new MergeFailure(
			"GIT_WORKSPACE_BUSY",
			"Git is busy in that checkout; retry after the current operation completes",
		);
	if (!locked.value.ok)
		throw new MergeFailure(
			"TEAM_MERGE_FAST_FORWARD_REFUSED",
			`git refused to fast-forward ${outcome.checkedOutAt}; nothing changed: ${locked.value.message}`,
			{ files: locked.value.files },
		);
	const after = await git.resolve(`refs/heads/${base}`);
	if (after !== outcome.mergeCommit)
		throw new MergeFailure("TEAM_MERGE_BASE_MOVED", `${base} did not take the merge`);
	await landed(
		context,
		{ item, head, base, title: item.title, branch },
		outcome.mergeCommit,
		outcome.mergeCommit,
		{ fastForwarded: "checkout", checkedOutAt: outcome.checkedOutAt },
	);
	await git.deletePrivateRef(item.id, outcome.mergeCommit);
}

// ── Private refs ────────────────────────────────────────────────────────────

const PRUNE_PROJECTS_MAX = 200;
const PRUNE_ITEMS_CHUNK = 200;

/**
 * Delete the private merge refs of one project's items that are no longer ready (merged,
 * cancelled, returned or gone), skipping items a job holds. Each delete names the value read.
 */
export async function pruneProjectMergeRefs(projectId: string): Promise<number> {
	const repo = repositoryOf(projectId);
	if (!repo) return 0;
	const git = teamRepoGit(repo);
	const refs = await git.listPrivateRefs();
	if (refs.length === 0) return 0;
	const ready = new Set<string>();
	for (let index = 0; index < refs.length; index += PRUNE_ITEMS_CHUNK) {
		const ids = refs.slice(index, index + PRUNE_ITEMS_CHUNK).map((ref) => ref.itemId);
		for (const row of db
			.select({ id: teamWorkItems.id })
			.from(teamWorkItems)
			.where(and(inArray(teamWorkItems.id, ids), eq(teamWorkItems.state, "ready")))
			.limit(PRUNE_ITEMS_CHUNK)
			.all())
			ready.add(row.id);
	}
	let pruned = 0;
	for (const ref of refs) {
		if (ready.has(ref.itemId) || isMerging(ref.itemId)) continue;
		if (await git.deletePrivateRef(ref.itemId, ref.commit)) pruned++;
	}
	return pruned;
}

/** Prune stale private refs of every project with teams (startup; bounded). */
export async function pruneStaleMergeRefs(): Promise<number> {
	const rows = db
		.selectDistinct({ projectId: projectTeams.projectId })
		.from(projectTeams)
		.limit(PRUNE_PROJECTS_MAX)
		.all();
	let pruned = 0;
	for (const row of rows)
		pruned += await pruneProjectMergeRefs(row.projectId).catch((error) => {
			logger.debug("Team merge refs of a project were not pruned", {
				projectId: row.projectId,
				error: String(error),
			});
			return 0;
		});
	if (pruned > 0) logger.info("Pruned stale team merge refs", { pruned });
	return pruned;
}

/** Startup: prune stale private refs once, a little after start. Returns the stop function. */
export function startTeamMergeMaintenance(): () => Promise<void> {
	let stopped = false;
	const timer = setTimeout(() => {
		if (stopped) return;
		void pruneStaleMergeRefs().catch((error) =>
			logger.warn("Team merge refs were not pruned", { error: String(error) }),
		);
	}, 30_000);
	return async () => {
		stopped = true;
		clearTimeout(timer);
	};
}
