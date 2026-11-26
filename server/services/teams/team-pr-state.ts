/**
 * What NarraFork knows about a ready item's pull request (G), without running gh: the record (the
 * newest `work.pr_opened` in the repository pull requests go to now: number, URL, repository,
 * base; no columns), the last state read from GitHub (an in-memory cache per item, 20 s fresh,
 * filled by `team-merge-pr.ts`), and the summary cards and the drawer show. A pull request is
 * named by its repository and number together ({@link PrRef}): the record, the cache and every
 * transition event (`work.pr_closed`, `work.pr_checks`, `work.pr_queued`) are matched on both, so
 * a same-numbered pull request of another repository never inherits their state. Whether one is
 * closed for the item is the newer of its `work.pr_opened` / `work.pr_closed`: a pull request
 * reopened (or retargeted back) on GitHub is recorded opened again and recovers. A leaf module so
 * `team-merge.ts` can build summaries without importing the PR jobs.
 */
import {
	TEAM_PR_CHECK_FAILURES_MAX,
	TEAM_PR_MERGEABLE_STATES,
	type TeamPrChecks,
	type TeamPrMergeBlocker,
	type TeamPrMergeMethod,
	type TeamPrMergeState,
	type TeamWorkPullRequest,
} from "@shared/project-teams";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { teamWorkEvents } from "../../db/schema";
import { hotSafe } from "../../lib/hot-safe";
import type { GhCheck, GhPrView, GhRepo } from "./team-gh";

/** How long a read pull request state is fresh. */
export const PR_STATUS_TTL_MS = 20_000;
const CACHE_MAX = 500;
/** Events of one kind (or the opened/closed pair) one lookup reads, newest first. */
const EVENTS_SCANNED = 20;

/** A pull request as GitHub names it: its repository and its number there. */
export interface PrRef extends GhRepo {
	number: number;
}

/** `host/owner/repo` lowercased (GitHub names are case-insensitive). */
export const repositoryKey = (target: GhRepo) =>
	`${target.host}/${target.owner}/${target.repo}`.toLowerCase();

/** The pull request an item has, from its newest `work.pr_opened`. */
export interface PullRequestRecord {
	number: number;
	url: string;
	host: string;
	owner: string;
	repo: string;
	/** The base it targets. */
	base: string | null;
	/** The head it was opened (or found) with. */
	head: string | null;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The newest events of `kinds` of an item (one indexed, bounded read). */
function newestEvents(itemId: string, kinds: readonly string[]) {
	return db
		.select({
			kind: teamWorkEvents.kind,
			detail: teamWorkEvents.detailJson,
			createdAt: teamWorkEvents.createdAt,
		})
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), inArray(teamWorkEvents.kind, [...kinds])))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(EVENTS_SCANNED)
		.all();
}

/**
 * The item's pull request record in `target` (the repository pull requests go to now; any
 * repository when null), or null when none was opened there.
 */
export function latestPullRequest(
	itemId: string,
	target: GhRepo | null = null,
): PullRequestRecord | null {
	for (const row of newestEvents(itemId, ["work.pr_opened"])) {
		const record = row.detail ? recordOf(row.detail) : null;
		if (record && (!target || repositoryKey(record) === repositoryKey(target))) return record;
	}
	return null;
}

function recordOf(detail: Record<string, unknown>): PullRequestRecord | null {
	const number = detail.pr;
	const url = str(detail.url);
	const repository = str(detail.repository);
	if (typeof number !== "number" || !Number.isSafeInteger(number) || !url || !repository)
		return null;
	const [host, owner, repo] = repository.split("/");
	if (!host || !owner || !repo) return null;
	return { number, url, host, owner, repo, base: str(detail.base), head: str(detail.head) };
}

/**
 * The repository an event's detail is about: its `repository`, else (events recorded before they
 * carried one) the `host/owner/repo` of its pull request URL.
 */
function eventRepository(detail: Record<string, unknown>): string | null {
	const repository = str(detail.repository);
	if (repository) return repository.toLowerCase();
	const url = str(detail.url);
	if (!url) return null;
	try {
		const parsed = new URL(url);
		const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
		return owner && repo ? `${parsed.hostname}/${owner}/${repo}`.toLowerCase() : null;
	} catch {
		return null;
	}
}

/** Whether an event's detail is about pull request `ref` (its repository and number). */
export function aboutPullRequest(detail: Record<string, unknown>, ref: PrRef): boolean {
	return detail.pr === ref.number && eventRepository(detail) === repositoryKey(ref);
}

/** The newest event of `kind` about pull request `ref` of an item (its detail), or null. */
export function latestPrEvent(
	itemId: string,
	kind: "work.pr_checks" | "work.pr_queued" | "work.pr_closed" | "work.pr_pushed",
	ref: PrRef,
): Record<string, unknown> | null {
	for (const row of newestEvents(itemId, [kind]))
		if (row.detail && aboutPullRequest(row.detail, ref)) return row.detail;
	return null;
}

/**
 * Whether pull request `ref` is closed for the item: its newest `work.pr_closed` is newer than its
 * newest `work.pr_opened` (a reopen recorded since recovers it). The closing event, or null.
 */
export function prClosedForItem(
	itemId: string,
	ref: PrRef,
): { detail: Record<string, unknown>; at: string } | null {
	for (const row of newestEvents(itemId, ["work.pr_opened", "work.pr_closed"])) {
		if (!row.detail || !aboutPullRequest(row.detail, ref)) continue;
		return row.kind === "work.pr_closed" ? { detail: row.detail, at: row.createdAt } : null;
	}
	return null;
}

/** A time to record an event at that sorts after `after` (an ISO time), now or later. */
export function timeAfter(after: string | null | undefined, now = Date.now()): string {
	const floor = after ? Date.parse(after) + 1 : 0;
	return new Date(Math.max(now, Number.isFinite(floor) ? floor : 0)).toISOString();
}

// ── The read state ──────────────────────────────────────────────────────────

/** A pull request's state as last read. */
export interface PrStatus {
	number: number;
	url: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	headSha: string | null;
	mergeState: TeamPrMergeState | null;
	review: TeamWorkPullRequest["review"];
	checks: TeamPrChecks | null;
	autoMerge: boolean;
	mergeCommit: string | null;
	baseRef: string | null;
}

interface CacheEntry {
	/** The pull request read: `host/owner/repo#number` ({@link refKey}). */
	key: string;
	status: PrStatus | null;
	error: string | null;
	at: number;
	refreshing: boolean;
}

const cache = hotSafe("narrafork.teams.prStatus", () => new Map<string, CacheEntry>());

const refKey = (ref: PrRef) => `${repositoryKey(ref)}#${ref.number}`;

/** The cached state of an item's pull request `ref` (any age), or null. */
export function peekPrStatus(itemId: string, ref: PrRef): Readonly<CacheEntry> | null {
	const entry = cache.get(itemId);
	return entry && entry.key === refKey(ref) ? entry : null;
}

/** Whether the cached state of `ref` was read less than `ttl` (20 s) ago. */
export function prStatusFresh(
	itemId: string,
	ref: PrRef,
	now = Date.now(),
	ttl = PR_STATUS_TTL_MS,
): boolean {
	const entry = peekPrStatus(itemId, ref);
	return !!entry && entry.at > 0 && now - entry.at < ttl;
}

function put(itemId: string, entry: CacheEntry): void {
	cache.delete(itemId);
	cache.set(itemId, entry);
	while (cache.size > CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** Record a read (or its failure) of an item's pull request. */
export function storePrStatus(
	itemId: string,
	ref: PrRef,
	value: { status: PrStatus } | { error: string },
): void {
	const previous = peekPrStatus(itemId, ref);
	put(itemId, {
		key: refKey(ref),
		status: "status" in value ? value.status : (previous?.status ?? null),
		error: "error" in value ? value.error.slice(0, 300) : null,
		at: Date.now(),
		refreshing: false,
	});
}

/** Mark a read of `pr` as running (or done) for the drawer. */
export function markPrRefreshing(itemId: string, ref: PrRef, refreshing: boolean): void {
	const previous = peekPrStatus(itemId, ref);
	put(itemId, {
		key: refKey(ref),
		status: previous?.status ?? null,
		error: previous?.error ?? null,
		at: previous?.at ?? 0,
		refreshing,
	});
}

/** A read of the item's pull request ended (whatever it found): the drawer stops polling. */
export function endPrRefreshing(itemId: string): void {
	const entry = cache.get(itemId);
	if (entry?.refreshing) put(itemId, { ...entry, refreshing: false });
}

/** Forget an item's read state (it was merged, returned or a new pull request opened). */
export function forgetPrStatus(itemId: string): void {
	cache.delete(itemId);
}

export function resetPrStatusForTests(): void {
	cache.clear();
}

/** A read `gh pr view` (+ checks) as the cached state. */
export function prStatusOf(view: GhPrView, number: number, checks: TeamPrChecks | null): PrStatus {
	return {
		number,
		url: view.url,
		state: view.state,
		isDraft: view.isDraft,
		headSha: view.headRefOid,
		mergeState: view.mergeStateStatus ?? null,
		review: view.reviewDecision ?? null,
		checks,
		autoMerge: view.autoMerge,
		mergeCommit: view.mergeCommit?.oid ?? null,
		baseRef: view.baseRefName ?? null,
	};
}

/** `gh pr checks` as bucket counts, the state, and at most 10 failures (name and link). */
export function summarizeChecks(checks: readonly GhCheck[]): TeamPrChecks {
	const summary: TeamPrChecks = {
		state: "none",
		pass: 0,
		fail: 0,
		pending: 0,
		skipping: 0,
		total: checks.length,
		failures: [],
	};
	for (const check of checks) {
		const bucket = check.bucket.toLowerCase();
		if (bucket === "pass") summary.pass++;
		else if (bucket === "fail" || bucket === "cancel") {
			summary.fail++;
			if (summary.failures.length < TEAM_PR_CHECK_FAILURES_MAX)
				summary.failures.push({
					name: (check.workflow ? `${check.workflow} / ${check.name}` : check.name).slice(0, 200),
					link: safeLink(check.link ?? null),
				});
		} else if (bucket === "skipping") summary.skipping++;
		else summary.pending++;
	}
	summary.state =
		summary.fail > 0
			? "failing"
			: summary.pending > 0
				? "pending"
				: summary.total > 0
					? "passing"
					: "none";
	return summary;
}

/** An http(s) link only (a check's link is shown as an anchor). */
function safeLink(link: string | null): string | null {
	if (!link) return null;
	try {
		const url = new URL(link);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
	} catch {
		return null;
	}
}

// ── The summary ─────────────────────────────────────────────────────────────

/** Why 「合并 PR」 is not offered for this state (null: it is). */
export function prMergeBlocker(input: {
	status: PrStatus | null;
	headSha: string | null;
	queued: boolean;
	methods: readonly TeamPrMergeMethod[];
}): TeamPrMergeBlocker | null {
	const { status } = input;
	if (!status) return "checking";
	if (status.state === "CLOSED") return "closed";
	if (status.state === "MERGED") return null;
	if (input.queued) return "queued";
	if (!sameHead(status.headSha, input.headSha)) return "head_stale";
	if (status.isDraft || status.mergeState === "DRAFT") return "draft";
	if (input.methods.length === 0) return "no_method";
	switch (status.mergeState) {
		case "BLOCKED":
			return "blocked";
		case "BEHIND":
			return "behind";
		case "DIRTY":
			return "dirty";
		case null:
		case "UNKNOWN":
			return "unknown";
		default:
			return TEAM_PR_MERGEABLE_STATES.includes(status.mergeState) ? null : "unknown";
	}
}

/**
 * Whether GitHub queued the merge of `pr` at `headSha`: auto-merge is on, or a merge NarraFork
 * asked for was accepted at that head (`work.pr_queued`) while the pull request is still open.
 */
/**
 * Whether two heads are the same commit; a board card carries its head abbreviated (12
 * characters), so a prefix of at least that much counts.
 */
export function sameHead(a: unknown, b: unknown): boolean {
	if (typeof a !== "string" || typeof b !== "string" || a.length < 12 || b.length < 12)
		return false;
	return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

export function prQueued(
	itemId: string,
	ref: PrRef,
	status: PrStatus | null,
	headSha: string | null,
) {
	if (!status || status.state !== "OPEN") return false;
	if (status.autoMerge) return true;
	const queued = latestPrEvent(itemId, "work.pr_queued", ref);
	return !!queued && sameHead(queued.head, headSha) && sameHead(status.headSha, headSha);
}

/**
 * The pull request part of a ready item's merge summary, from the record and the cache (no gh):
 * null when the item has none.
 */
export function pullRequestSummary(input: {
	itemId: string;
	headSha: string | null;
	methods: readonly TeamPrMergeMethod[];
	/** The caller may merge (a member, the item ready, nothing else in the way). */
	mayMerge: boolean;
	/** The caller may ask for a read (a member with project write). */
	member?: boolean;
	/**
	 * The repository pull requests go to now: only a pull request there is the item's (one of a
	 * repository origin pointed to before is not; 「发起 PR」 opens one in this one). Null: none.
	 */
	target: GhRepo | null;
	record?: PullRequestRecord | null;
}): TeamWorkPullRequest | null {
	if (!input.target) return null;
	const record =
		input.record === undefined ? latestPullRequest(input.itemId, input.target) : input.record;
	if (!record || repositoryKey(record) !== repositoryKey(input.target)) return null;
	const entry = peekPrStatus(input.itemId, record);
	const read = entry?.status ?? null;
	// Taken as closed for this item (merged at an older head, retargeted, closed), until GitHub
	// shows it open on the item's base again (recorded opened again): 「重新发起 PR」.
	const closedForItem = !!prClosedForItem(input.itemId, record);
	const status: PrStatus | null =
		read && closedForItem && read.state !== "CLOSED" ? { ...read, state: "CLOSED" } : read;
	const queued = prQueued(input.itemId, record, status, input.headSha);
	const blocker = prMergeBlocker({
		status,
		headSha: input.headSha,
		queued,
		methods: input.methods,
	});
	const headMatches = status
		? sameHead(status.headSha, input.headSha)
		: sameHead(record.head, input.headSha);
	return {
		number: record.number,
		url: status?.url ?? record.url,
		repository: `${record.host}/${record.owner}/${record.repo}`,
		state: status?.state ?? (closedForItem ? "CLOSED" : null),
		isDraft: status?.isDraft ?? false,
		headMatches,
		mergeState: status?.mergeState ?? null,
		review: status?.review ?? null,
		checks: status?.checks ?? null,
		queued,
		checkedAt: entry && entry.at > 0 ? new Date(entry.at).toISOString() : null,
		refreshing: entry?.refreshing ?? false,
		error: entry?.error ?? null,
		methods: [...input.methods],
		canMergePr: input.mayMerge && blocker === null && status?.state === "OPEN",
		mergeBlocker: closedForItem && !status ? "closed" : blocker,
		canRefresh: input.member === true,
	};
}
