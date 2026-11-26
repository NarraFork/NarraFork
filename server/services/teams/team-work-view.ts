/**
 * The redesigned team page's reads of one work item's branch (R): its size for the work list
 * (`+/-` and file count), the drawer's detail (commits ahead, changed files, review rounds, its
 * own timeline) and one file's diff, read only when the drawer asks for it.
 *
 * Git is read through `team-git.ts` only (hardened, read-only, 60 s and capped output), never
 * the working tree: a live item is read in its worktree from its HEAD commit against the merge
 * base with its base; a finished item, whose worktree may be gone and whose head is then inside
 * the base, from the merge base and head its `work.ready` event recorded, in the project's
 * repository. An item with neither has no known size (null). Sizes are cached in memory for a
 * short while per item, so the polling page does not run git for every refetch.
 *
 * Access is the coordinator's ACL (`loadTeamForAccess`): readers see sizes, files and diffs, as
 * they see the board. SQLite only, like the rest of the team surface.
 */
import {
	TEAM_EVENT_DETAIL_PREVIEW_CHARS,
	TEAM_RETURNABLE_STATES,
	TEAM_REVIEW_SUMMARIES_TOTAL_CHARS,
	TEAM_WORK_DIFF_MAX_BYTES,
	TEAM_WORK_EVENTS_LIMIT,
	TEAM_WORK_FILES_LIMIT,
	TEAM_WORK_RETURNED_EVENT_KIND,
	TEAM_WORK_STATS_IDS_MAX,
	type TeamActivityEvent,
	type TeamEventActorKind,
	type TeamPrMergeMethod,
	type TeamReviewVerdict,
	type TeamWorkDiffStat,
	type TeamWorkFileChange,
	type TeamWorkFileDiff,
	type TeamWorkItemDetail,
	type TeamWorkMergeResponse,
	type TeamWorkPrRefreshResponse,
	type TeamWorkReturnResponse,
	type TeamWorkReviewRound,
	type TeamWorkStatsResponse,
} from "@shared/project-teams";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { narrators, teamWorkEvents, teamWorkItems, users } from "../../db/schema";
import { GitError, NotFoundError, ValidationError } from "../../lib/errors";
import { getUserLanguage } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import type { NarratorPrincipal } from "../narrator-acl";
import {
	eventDetail,
	readBoardItem,
	readReviewDetailText,
	returnedReasonColumns,
	reviewHeadColumns,
} from "./team-board";
import { teamGit } from "./team-git";
import {
	canMergeInProject,
	mergeViewOf,
	requestFastForward,
	requestMerge,
	requestPrMerge,
} from "./team-merge";
import { loadTeamForAccess } from "./team-service";
import { compareRefFor } from "./team-work-start";
import { readDependents } from "./work-item-dependencies";
import { diffStatOf, returnWorkItem, worktreePathOf } from "./work-items";

type WorkItemRow = typeof teamWorkItems.$inferSelect;

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Where an item's branch is read: a repository directory and two full commit SHAs. */
interface DiffTarget {
	cwd: string;
	from: string;
	to: string;
}

/** The newest `work.ready` facts of an item: its head and merge base at readiness. */
function readyFacts(itemId: string): { head: string; mergeBase: string } | null {
	const rows = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, "work.ready")))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.all();
	const detail = rows[0]?.detail;
	const head = detail?.head;
	const fork = detail?.mergeBase;
	return typeof head === "string" && SHA.test(head) && typeof fork === "string" && SHA.test(fork)
		? { head, mergeBase: fork }
		: null;
}

/**
 * Where to read an item's branch, or null when it cannot be read: a live item with a recorded
 * worktree from its HEAD against the merge base with its base; otherwise (finished, or its
 * worktree gone) what its newest `work.ready` recorded, in the project's repository.
 */
async function diffTarget(
	item: WorkItemRow,
	baseBranch: string,
	repository: string | null,
): Promise<DiffTarget | null> {
	const finished = item.state === "merged" || item.state === "cancelled";
	const worktree = finished ? null : worktreePathOf(item);
	if (worktree) {
		const git = teamGit(worktree);
		const head = await git.resolveCommit("HEAD");
		// W: an item started from origin/<base> is compared with it (only its own commits count).
		const base = await git.resolveCommit(
			await compareRefFor(item.id, item.baseRef ?? baseBranch, (ref) => git.resolveCommit(ref)),
		);
		if (head && base) {
			const fork = await git.mergeBase(head, base);
			if (fork) return { cwd: worktree, from: fork, to: head };
		}
		return null;
	}
	const facts = readyFacts(item.id);
	if (!facts || !repository) return null;
	return { cwd: repository, from: facts.mergeBase, to: facts.head };
}

// ── Sizes ───────────────────────────────────────────────────────────────────

/** How long a size is reused before git is asked again. */
const STAT_TTL_MS = 20_000;
/**
 * Most sizes kept (oldest dropped first). Each keeps its totals and at most
 * {@link TEAM_WORK_FILES_LIMIT} files (what the drawer lists), never the whole listing: at
 * most 200 × 300 short records.
 */
const STAT_CACHE_MAX = 200;
/** Sizes read at once by one request. */
const STAT_CONCURRENCY = 4;

interface CachedStat {
	at: number;
	/** The item's `updated_at` when read: any change of the item reads again. */
	version: string;
	value: TeamWorkDiffStat | null;
	/** The first {@link TEAM_WORK_FILES_LIMIT} files of the listing. */
	files: TeamWorkFileChange[];
	/** The listing had more files than kept, or was cut at its byte cap. */
	filesMore: boolean;
	target: DiffTarget | null;
}

const statCache = new Map<string, CachedStat>();

/** Forget every cached size (tests). */
export function resetWorkStatCacheForTests(): void {
	statCache.clear();
}

async function readStat(
	item: WorkItemRow,
	baseBranch: string,
	repository: string | null,
	now = Date.now(),
): Promise<CachedStat> {
	const cached = statCache.get(item.id);
	if (cached && cached.version === item.updatedAt && now - cached.at < STAT_TTL_MS) return cached;
	let entry: CachedStat;
	try {
		const target = await diffTarget(item, baseBranch, repository);
		const numstat = target ? await teamGit(target.cwd).numstat(target.from, target.to) : null;
		entry = {
			at: now,
			version: item.updatedAt,
			value: numstat ? diffStatOf(numstat) : null,
			files: numstat ? numstat.files.slice(0, TEAM_WORK_FILES_LIMIT) : [],
			filesMore: numstat
				? numstat.files.length > TEAM_WORK_FILES_LIMIT || numstat.truncated
				: false,
			target,
		};
	} catch (error) {
		logger.debug("Team work item size could not be read", {
			workItemId: item.id,
			error: error instanceof Error ? error.message : String(error),
		});
		entry = {
			at: now,
			version: item.updatedAt,
			value: null,
			files: [],
			filesMore: false,
			target: null,
		};
	}
	statCache.delete(item.id);
	statCache.set(item.id, entry);
	while (statCache.size > STAT_CACHE_MAX) {
		const oldest = statCache.keys().next().value;
		if (oldest === undefined) break;
		statCache.delete(oldest);
	}
	return entry;
}

/** Run `work` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return results;
}

/**
 * The sizes of up to {@link TEAM_WORK_STATS_IDS_MAX} items of a team (primary-key `IN` read,
 * then bounded git per item, a few at a time). Ids of other teams' items are left out.
 */
export async function readWorkStats(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	ids: readonly string[],
): Promise<TeamWorkStatsResponse> {
	const unique = [...new Set(ids)];
	if (unique.length > TEAM_WORK_STATS_IDS_MAX)
		throw new ValidationError(`At most ${TEAM_WORK_STATS_IDS_MAX} work items at a time`);
	const { team, coordinator } = await loadTeamForAccess(teamId, principal, "read", projectId);
	if (unique.length === 0) return { stats: {} };
	const rows = db
		.select()
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), inArray(teamWorkItems.id, unique)))
		.limit(TEAM_WORK_STATS_IDS_MAX)
		.all();
	const repository = await repositoryOf(coordinator.id);
	const read = await mapLimited(rows, STAT_CONCURRENCY, (row) =>
		readStat(row, team.baseBranch, repository),
	);
	const stats: TeamWorkStatsResponse["stats"] = {};
	rows.forEach((row, index) => {
		stats[row.id] = read[index]?.value ?? null;
	});
	return { stats };
}

/** The project's repository the coordinator works in (its cwd), by primary key. */
async function repositoryOf(coordinatorId: string): Promise<string | null> {
	const row = db
		.select({ cwd: narrators.cwd })
		.from(narrators)
		.where(eq(narrators.id, coordinatorId))
		.limit(1)
		.get();
	return row?.cwd ?? null;
}

// ── The drawer ──────────────────────────────────────────────────────────────

function requireItem(teamId: string, itemId: string): WorkItemRow {
	const row = db
		.select()
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.id, itemId), eq(teamWorkItems.teamId, teamId)))
		.limit(1)
		.get();
	if (!row) throw new NotFoundError("Work item", itemId);
	return row;
}

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Characters of long review details one drawer read reads past the page: about what
 * {@link TEAM_REVIEW_SUMMARIES_TOTAL_CHARS} of findings take when every character JSON-escapes
 * to six. Past it (or once that many findings are collected) older long reviews keep only their
 * round, verdict and count.
 */
export const TEAM_REVIEW_DETAILS_READ_CHARS = TEAM_REVIEW_SUMMARIES_TOTAL_CHARS * 6;

/**
 * The item's newest events (index `(work_item_id, created_at, id)`), returned oldest first.
 * A review whose detail is past the preview (long findings) comes with its head only; its
 * findings are then read by primary key, newest first, until the drawer has
 * {@link TEAM_REVIEW_SUMMARIES_TOTAL_CHARS} of findings or {@link TEAM_REVIEW_DETAILS_READ_CHARS}
 * were read. `unreadSummaries` names the reviews whose findings were left unread.
 */
function itemEvents(itemId: string): {
	events: TeamActivityEvent[];
	more: boolean;
	unreadSummaries: ReadonlySet<string>;
} {
	const rows = db
		.select({
			id: teamWorkEvents.id,
			kind: teamWorkEvents.kind,
			actorKind: teamWorkEvents.actorKind,
			actorId: teamWorkEvents.actorId,
			detailLength: sql<number | null>`length(${teamWorkEvents.detailJson})`,
			detail: sql<
				string | null
			>`case when length(${teamWorkEvents.detailJson}) <= ${TEAM_EVENT_DETAIL_PREVIEW_CHARS} then ${teamWorkEvents.detailJson} end`,
			...returnedReasonColumns,
			...reviewHeadColumns,
			createdAt: teamWorkEvents.createdAt,
		})
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.workItemId, itemId))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(TEAM_WORK_EVENTS_LIMIT + 1)
		.all();
	const page = rows.slice(0, TEAM_WORK_EVENTS_LIMIT).reverse();
	const people = new Set<string>();
	const agents = new Set<string>();
	for (const row of page) {
		if (!row.actorId) continue;
		if (row.actorKind === "person") people.add(row.actorId);
		else if (row.actorKind === "agent") agents.add(row.actorId);
	}
	const names = new Map<string, string>();
	if (people.size > 0)
		for (const user of db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(inArray(users.id, [...people]))
			.all())
			names.set(`person:${user.id}`, user.username);
	if (agents.size > 0)
		for (const agent of db
			.select({ id: narrators.id, title: narrators.title })
			.from(narrators)
			.where(inArray(narrators.id, [...agents]))
			.all())
			if (agent.title) names.set(`agent:${agent.id}`, agent.title);
	const events: TeamActivityEvent[] = page.map((row) => ({
		id: row.id,
		kind: row.kind,
		workItemId: itemId,
		workItemTitle: null,
		actorKind: row.actorKind as TeamEventActorKind,
		actorId: row.actorId,
		actorName: row.actorId ? (names.get(`${row.actorKind}:${row.actorId}`) ?? null) : null,
		...eventDetail(row),
		createdAt: row.createdAt,
	}));
	// Newest first, as the drawer spends its findings budget (`capReviewSummaries`).
	const unreadSummaries = new Set<string>();
	let collected = 0;
	let read = 0;
	for (let index = page.length - 1; index >= 0; index--) {
		const row = page[index];
		const event = events[index];
		if (!row || !event || event.kind !== "work.review") continue;
		if (row.reviewHead === null) {
			const summary = event.detail?.summary;
			if (typeof summary === "string") collected += summary.length;
			continue;
		}
		if (collected >= TEAM_REVIEW_SUMMARIES_TOTAL_CHARS || read >= TEAM_REVIEW_DETAILS_READ_CHARS) {
			unreadSummaries.add(event.id);
			continue;
		}
		const text = readReviewDetailText(row.id);
		read += text?.length ?? 0;
		const full = eventDetail({ ...row, reviewDetail: text });
		events[index] = { ...event, ...full };
		const summary = full.detail?.summary;
		if (typeof summary === "string") collected += summary.length;
	}
	return { events, more: rows.length > TEAM_WORK_EVENTS_LIMIT, unreadSummaries };
}

/** Rounds whose findings the read left unread lost them to the drawer's total cap. */
function markUnreadSummaries(
	rounds: TeamWorkReviewRound[],
	unread: ReadonlySet<string>,
): TeamWorkReviewRound[] {
	if (unread.size === 0) return rounds;
	return rounds.map((round) =>
		unread.has(round.eventId) ? { ...round, summary: null, summaryClipped: true } : round,
	);
}

/** The review rounds among an item's events: agents' reviews and people's returns. */
export function reviewRounds(events: readonly TeamActivityEvent[]): TeamWorkReviewRound[] {
	const rounds: TeamWorkReviewRound[] = [];
	for (const event of events) {
		if (event.kind !== "work.review" && event.kind !== TEAM_WORK_RETURNED_EVENT_KIND) continue;
		const detail = event.detail ?? {};
		const verdict: TeamReviewVerdict = detail.verdict === "clear" ? "clear" : "blocker";
		const reason = typeof detail.reason === "string" ? detail.reason : null;
		rounds.push({
			eventId: event.id,
			round: num(detail.round) ?? rounds.length + 1,
			verdict,
			findings: num(detail.findings),
			by: event.actorKind,
			actorId: event.actorId,
			actorName: event.actorName,
			reason: event.kind === TEAM_WORK_RETURNED_EVENT_KIND ? reason : null,
			summary:
				event.kind === "work.review" && typeof detail.summary === "string" && detail.summary
					? detail.summary
					: null,
			at: event.createdAt,
		});
	}
	return rounds;
}

/**
 * Keep the findings text one drawer sends within `budget` characters: the newest rounds keep
 * theirs whole, the first that does not fit is cut, older ones go without (`summaryClipped`).
 */
export function capReviewSummaries(
	rounds: TeamWorkReviewRound[],
	budget = TEAM_REVIEW_SUMMARIES_TOTAL_CHARS,
): TeamWorkReviewRound[] {
	let left = budget;
	const capped = [...rounds];
	for (let index = capped.length - 1; index >= 0; index--) {
		const round = capped[index];
		if (!round?.summary) continue;
		if (round.summary.length <= left) {
			left -= round.summary.length;
			continue;
		}
		const cut = left > 1 ? `${round.summary.slice(0, left - 1)}…` : null;
		left = 0;
		capped[index] = { ...round, summary: cut, summaryClipped: true };
	}
	return capped;
}

/** The timeline does not repeat the findings the review rounds already carry. */
function withoutSummary(event: TeamActivityEvent): TeamActivityEvent {
	if (event.kind !== "work.review" || !event.detail || !("summary" in event.detail)) return event;
	const { summary: _summary, ...detail } = event.detail;
	return { ...event, detail };
}

/**
 * The drawer of one work item: its card, the base it merges into, how many commits it is ahead,
 * its size and changed files (at most {@link TEAM_WORK_FILES_LIMIT}), its review rounds and its
 * own timeline. Readers may read it; `canReturn` says whether this caller may return it now.
 */
export async function readWorkItemDetail(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
): Promise<TeamWorkItemDetail> {
	const { team, coordinator, access } = await loadTeamForAccess(
		teamId,
		principal,
		"read",
		projectId,
	);
	const row = requireItem(teamId, itemId);
	const item = readBoardItem(teamId, itemId);
	if (!item) throw new NotFoundError("Work item", itemId);
	const base = row.baseRef ?? team.baseBranch;
	const stat = await readStat(row, team.baseBranch, await repositoryOf(coordinator.id));
	let aheadBy: number | null = null;
	if (stat.target) {
		const target = stat.target;
		aheadBy = await teamGit(target.cwd)
			.countCommitsNotIn(target.to, [target.from])
			.catch(() => null);
	}
	const { events, more, unreadSummaries } = itemEvents(itemId);
	const files = stat.files;
	const dependents = readDependents(teamId, itemId);
	const teamActive = team.status === "active" && coordinator.status !== "archived";
	// M: a ready item's merge (job phase, newest outcome, the prepared checkout's state).
	const merge =
		row.state === "ready"
			? await mergeViewOf({
					item: row,
					baseBranch: team.baseBranch,
					teamActive,
					workerRunning: item.worker?.status === "working" || item.worker?.status === "waiting",
					member: access === "write" && (await canMergeInProject(team.projectId, principal)),
				})
			: undefined;
	return {
		item,
		base,
		aheadBy,
		stat: stat.value,
		files,
		filesMore: stat.filesMore,
		diffAvailable: stat.target !== null,
		reviews: capReviewSummaries(markUnreadSummaries(reviewRounds(events), unreadSummaries)),
		events: events.map(withoutSummary),
		eventsMore: more,
		canReturn: access === "write" && teamActive && TEAM_RETURNABLE_STATES.includes(row.state),
		...(merge ? { merge } : {}),
		dependents: dependents.items,
		dependentsMore: dependents.more,
	};
}

/**
 * One changed file's diff for the drawer, cut at {@link TEAM_WORK_DIFF_MAX_BYTES}. The path is
 * a literal repository-relative path (never a pathspec pattern) and only the branch's own change
 * is read (merge base → head): a path it did not change has an empty diff and is not found.
 */
export async function readWorkFileDiff(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
	path: string,
): Promise<TeamWorkFileDiff> {
	const { team, coordinator } = await loadTeamForAccess(teamId, principal, "read", projectId);
	const row = requireItem(teamId, itemId);
	const stat = await readStat(row, team.baseBranch, await repositoryOf(coordinator.id));
	if (!stat.target) throw new NotFoundError("Changed file", path);
	const target = stat.target;
	const diff = await teamGit(target.cwd)
		.fileDiff(target.from, target.to, path, TEAM_WORK_DIFF_MAX_BYTES)
		.catch((error) => {
			// A path that is not repository-relative is refused before git runs.
			if (error instanceof GitError) throw new NotFoundError("Changed file", path);
			throw error;
		});
	if (!diff.text && !diff.truncated) throw new NotFoundError("Changed file", path);
	return { path, text: diff.text, truncated: diff.truncated };
}

// ── Return ──────────────────────────────────────────────────────────────────

/**
 * A member returns a work item in review or ready with a reason (`work-items.ts:returnWorkItem`):
 * write access on the coordinator (an onlooker gets 403, a stranger 404); the coordinator's note
 * is written in the person's language and names them.
 */
export async function returnWorkItemAsPerson(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
	reason: string,
): Promise<TeamWorkReturnResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	const userId = principal.userId || null;
	const person = userId
		? db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1).get()
		: undefined;
	const result = await returnWorkItem({
		teamId,
		itemId,
		reason,
		actor: { kind: "person", id: userId },
		actorName: person?.username ?? null,
		locale: userId ? await getUserLanguage(userId) : "en",
	});
	statCache.delete(itemId);
	const item = readBoardItem(teamId, result.item.id);
	if (!item) throw new NotFoundError("Work item", itemId);
	return { item, delivered: result.delivered };
}

// ── Merge ───────────────────────────────────────────────────────────────────

/**
 * A member merges a ready item into its base (`team-merge.ts`): the same access as 退回 (write
 * on the coordinator; an onlooker gets 403, a stranger 404). Accepted at once; the git runs in a
 * background job whose phase and outcome the drawer reads.
 */
export async function requestMergeAsPerson(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
): Promise<TeamWorkMergeResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	const result = requestMerge({ teamId, itemId, userId: principal.userId || null });
	statCache.delete(itemId);
	return result;
}

/**
 * G: a member merges a ready item's pull request on GitHub (`team-merge-pr.ts`): the same access
 * as the merge; accepted at once, the job runs in the background.
 */
export async function requestPrMergeAsPerson(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
	method: TeamPrMergeMethod | undefined,
): Promise<TeamWorkMergeResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	const result = requestPrMerge({ teamId, itemId, userId: principal.userId || null, method });
	statCache.delete(itemId);
	return result;
}

/**
 * G: the drawer opened on a ready item with a pull request: read it from GitHub unless it was
 * read in the last 20 s (members, as the merge).
 */
export async function requestPrRefreshAsPerson(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
): Promise<TeamWorkPrRefreshResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	const { requestPrRefresh } = await import("./team-merge-pr");
	return requestPrRefresh({ teamId, itemId });
}

/** A member fast-forwards a prepared merge in the checkout its base is checked out in. */
export async function requestFastForwardAsPerson(
	teamId: string,
	principal: NarratorPrincipal,
	projectId: string,
	itemId: string,
): Promise<TeamWorkMergeResponse> {
	await loadTeamForAccess(teamId, principal, "write", projectId);
	return requestFastForward({ teamId, itemId, userId: principal.userId || null });
}
