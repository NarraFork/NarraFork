/**
 * What NarraFork knows about a ready item's pull request (G), without running gh: the record (the
 * newest `work.pr_opened`: number, URL, repository, base; no columns), the last state read from
 * GitHub (an in-memory cache per item, 20 s fresh, filled by `team-merge-pr.ts`), and the
 * summary cards and the drawer show. A leaf module so `team-merge.ts` can build summaries without
 * importing the PR jobs.
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
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { teamWorkEvents } from "../../db/schema";
import { hotSafe } from "../../lib/hot-safe";
import type { GhCheck, GhPrView } from "./team-gh";

/** How long a read pull request state is fresh. */
export const PR_STATUS_TTL_MS = 20_000;
const CACHE_MAX = 500;

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

/** The item's pull request record (one indexed read), or null when none was opened. */
export function latestPullRequest(itemId: string): PullRequestRecord | null {
	const row = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, "work.pr_opened")))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get();
	const detail = row?.detail;
	if (!detail) return null;
	const number = detail.pr;
	const url = str(detail.url);
	const repository = str(detail.repository);
	if (typeof number !== "number" || !Number.isSafeInteger(number) || !url || !repository)
		return null;
	const [host, owner, repo] = repository.split("/");
	if (!host || !owner || !repo) return null;
	return { number, url, host, owner, repo, base: str(detail.base), head: str(detail.head) };
}

/** The newest event of `kind` about pull request `pr` of an item (its detail), or null. */
export function latestPrEvent(
	itemId: string,
	kind: "work.pr_checks" | "work.pr_queued" | "work.pr_closed" | "work.pr_pushed",
	pr?: number,
): Record<string, unknown> | null {
	const row = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, kind)))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get();
	const detail = row?.detail ?? null;
	if (!detail) return null;
	if (pr !== undefined && detail.pr !== pr) return null;
	return detail;
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
	pr: number;
	status: PrStatus | null;
	error: string | null;
	at: number;
	refreshing: boolean;
}

const cache = hotSafe("narrafork.teams.prStatus", () => new Map<string, CacheEntry>());

/** The cached state of an item's pull request `pr` (any age), or null. */
export function peekPrStatus(itemId: string, pr: number): Readonly<CacheEntry> | null {
	const entry = cache.get(itemId);
	return entry && entry.pr === pr ? entry : null;
}

/** Whether the cached state of `pr` is fresh (read less than 20 s ago). */
export function prStatusFresh(itemId: string, pr: number, now = Date.now()): boolean {
	const entry = peekPrStatus(itemId, pr);
	return !!entry && entry.at > 0 && now - entry.at < PR_STATUS_TTL_MS;
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
	pr: number,
	value: { status: PrStatus } | { error: string },
): void {
	const previous = peekPrStatus(itemId, pr);
	put(itemId, {
		pr,
		status: "status" in value ? value.status : (previous?.status ?? null),
		error: "error" in value ? value.error.slice(0, 300) : null,
		at: Date.now(),
		refreshing: false,
	});
}

/** Mark a read of `pr` as running (or done) for the drawer. */
export function markPrRefreshing(itemId: string, pr: number, refreshing: boolean): void {
	const previous = peekPrStatus(itemId, pr);
	put(itemId, {
		pr,
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
	if (!input.headSha || status.headSha !== input.headSha) return "head_stale";
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
export function prQueued(itemId: string, status: PrStatus | null, headSha: string | null) {
	if (!status || status.state !== "OPEN") return false;
	if (status.autoMerge) return true;
	const queued = latestPrEvent(itemId, "work.pr_queued", status.number);
	return !!queued && queued.head === headSha && status.headSha === headSha;
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
	record?: PullRequestRecord | null;
}): TeamWorkPullRequest | null {
	const record = input.record === undefined ? latestPullRequest(input.itemId) : input.record;
	if (!record) return null;
	const entry = peekPrStatus(input.itemId, record.number);
	const status = entry?.status ?? null;
	const queued = prQueued(input.itemId, status, input.headSha);
	const blocker = prMergeBlocker({
		status,
		headSha: input.headSha,
		queued,
		methods: input.methods,
	});
	const headMatches = status
		? !!input.headSha && status.headSha === input.headSha
		: !!input.headSha && record.head === input.headSha;
	return {
		number: record.number,
		url: status?.url ?? record.url,
		state: status?.state ?? null,
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
		mergeBlocker: blocker,
	};
}
