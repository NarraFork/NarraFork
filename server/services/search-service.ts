import { db } from "../db";
import { knowledgeService } from "./knowledge-service";
import { searchStore } from "./search/backend";
import { canUseIndex, globalStrategy, sanitizeQuery } from "./search/query";
import {
	CONVERSATION_MESSAGE_SCOPE,
	type EntitySearchQuery,
	type InheritedSearchScope,
	type MessageSearchRow,
	type MessageSearchScope,
	type NarratorSearchRow,
	type SearchFilters,
	type SearchSort,
	type SearchStrategy,
	type SessionAggregateRow,
	type SessionHitRef,
} from "./search/types";

export { sanitizeQuery } from "./search/query";
export type { InheritedSearchScope, MessageSearchScope, SearchFilters } from "./search/types";

/** One matching message inside a grouped conversation hit. */
export interface MessageHit {
	id: string;
	snippet: string;
	messageRole?: string;
	createdAt?: string;
	blockId?: string;
}

export interface SearchResult {
	type: "message" | "narrator" | "knowledge";
	id: string;
	title?: string;
	snippet: string;
	narratorId?: string;
	narratorTitle?: string;
	projectName?: string;
	status?: string;
	model?: string;
	messageRole?: string;
	/** Knowledge hits: the collection the entry lives in. */
	collectionId?: string;
	collectionName?: string;
	tags?: string[];
	createdAt?: string;
	updatedAt?: string;
	lastMessageAt?: string | null;
	matchField?: string;
	matchScore: number;
	/** Message hits: the block the match is in, when it is known. */
	blockId?: string;
	/**
	 * Message hits are grouped per narrator: the result is the narrator's best hit, `hits`
	 * holds its first few matches (best first, the best one included) and `hitCount` how many
	 * matched among the candidates read. `hitCountIsLowerBound` means the candidate window
	 * filled up, so the narrator may have more.
	 */
	hits?: MessageHit[];
	hitCount?: number;
	hitCountIsLowerBound?: boolean;
}

interface SearchOptions {
	signal?: AbortSignal;
	sort?: SearchSort;
	query: string;
	entities: string[];
	limit?: number;
	/**
	 * The searching user, so narrator and message hits are limited to what they may
	 * read. Required rather than optional: an omitted principal used to mean "see
	 * everything", and a caller that simply forgot would silently reopen the leak.
	 */
	principal: { userId: string; isAdmin: boolean };
	/** Which conversation content to search. Defaults to {@link CONVERSATION_MESSAGE_SCOPE}. */
	scope?: MessageSearchScope;
}

/** Matches shown per grouped narrator. */
export const MESSAGE_HITS_PER_GROUP = 3;
/** Message candidates read per requested group, so one long session cannot fill the page. */
const MESSAGE_CANDIDATES_PER_GROUP = 5;
/** Ceiling on message candidates per search, whatever the limit. */
const MAX_MESSAGE_CANDIDATES = 500;

/** How many message rows to read for `limit` groups. */
export function messageCandidateLimit(limit: number): number {
	return Math.min(limit * MESSAGE_CANDIDATES_PER_GROUP, MAX_MESSAGE_CANDIDATES);
}

export interface MessageHitGroup {
	/** The narrator's best hit, in the order the rows arrived. */
	best: MessageSearchRow;
	hits: MessageSearchRow[];
	hitCount: number;
}

/**
 * Group message rows by narrator, keeping the store's order.
 *
 * Rows arrive best first (by rank or by time), so a group's first row is its best hit and
 * groups come out in the order of their best hits. At most `limit` groups and
 * `hitsPerGroup` hits per group are kept; `hitCount` still counts every row of the group.
 * A row without a narrator is its own group.
 */
export function groupMessageHits(
	rows: readonly MessageSearchRow[],
	limit: number,
	hitsPerGroup = MESSAGE_HITS_PER_GROUP,
): MessageHitGroup[] {
	const groups = new Map<string, MessageHitGroup>();
	for (const row of rows) {
		const key = row.narratorId ?? `message:${row.id}`;
		const group = groups.get(key);
		if (group) {
			group.hitCount += 1;
			if (group.hits.length < hitsPerGroup) group.hits.push(row);
		} else if (groups.size < limit) {
			groups.set(key, { best: row, hits: [row], hitCount: 1 });
		}
	}
	return [...groups.values()];
}

export interface NarratorMessageSearchResult {
	messageId: string;
	seq: number;
	role: string;
	snippet: string;
	preview: string;
	createdAt: string;
	/** The block the match is in, when it is known. */
	blockId?: string;
}

/**
 * Which retrieval path a sanitized query must take.
 *
 * The threshold itself lives in `search/query.ts` (it is shared with the knowledge service).
 * The mapping to a strategy stays on this side because the score bands below are calibrated
 * to it: a backend that chose for itself would change scores with no caller aware of it.
 */
function strategyFor(safeQuery: string): SearchStrategy {
	return canUseIndex(safeQuery) ? "index" : "substring";
}

/**
 * The retrieval path for global (session and narrator) search, which matches each term on
 * its own: the index whenever any term can use it. See `globalQueryTerms`.
 */
function globalStrategyFor(safeQuery: string): SearchStrategy {
	return globalStrategy(safeQuery);
}

/**
 * Relevance rank → display score, with a per-entity fallback.
 *
 * `null` means the backend had no relevance signal (the substring path), which is why the
 * caller supplies the flat band. The curve is deliberately NOT normalized inside the backend:
 * it is shared product behaviour, so two backends must not be able to disagree about which
 * hit sorts first while both "passing".
 */
function scoreFromRank(rank: number | null, fallback: number): number {
	if (rank === null) return fallback;
	return Math.max(0, Math.round(1000 - rank * 1000));
}

/**
 * Collection display names for knowledge hits, batch-loaded by id.
 *
 * One query for the whole result page rather than per row: a knowledge search can
 * return up to the hard cap, and the collection name is only used as a badge.
 */
async function collectionNameMap(collectionIds: string[]): Promise<Map<string, string>> {
	const ids = [...new Set(collectionIds.filter(Boolean))];
	if (ids.length === 0) return new Map();
	const rows = await db.query.knowledgeCollections.findMany({
		where: (c, { inArray }) => inArray(c.id, ids),
		columns: { id: true, name: true },
	});
	return new Map(rows.map((r) => [r.id, r.name]));
}

/** Shared ordering for entity results and separately resolved knowledge hits. */
export function sortSearchResults(
	results: SearchResult[],
	sort: SearchSort = "relevance",
): SearchResult[] {
	return results.sort((a, b) => {
		if (sort !== "time" && b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
		const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? b.lastMessageAt ?? "") || 0;
		const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? a.lastMessageAt ?? "") || 0;
		return bTime - aTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Sectioned global search
// ─────────────────────────────────────────────────────────────────────────────

/** The sections the search page shows, in display order. */
export const SEARCH_SECTIONS = ["sessions", "knowledge"] as const;
export type SearchSection = (typeof SEARCH_SECTIONS)[number];

/**
 * Candidate windows per section. A section is ranked over its whole window and paged by
 * offset, so its total is exact up to the window and reported as a lower bound beyond it.
 * Every window is a bounded read in the search worker; nothing here grows with the corpus.
 */
const SESSION_AGGREGATE_CAP = 1000;
const SESSION_TITLE_CAP = 200;
const KNOWLEDGE_CAP = 100;
/** Hits listed under each session by default; more are paged on request. */
export const HITS_PER_SESSION = 3;
/**
 * A session's hits are listed newest first whatever the section's sort: they sit next to
 * their times, and expanding a card then continues down the same timeline.
 */
const SESSION_HIT_ORDER = "time" as const;
/** Ceiling on one page of a single session's hits. */
const MAX_SESSION_HITS_PAGE = 50;

/** A message hit shown under its session. */
export interface SessionHit {
	id: string;
	snippet: string;
	messageRole?: string;
	createdAt?: string;
	blockId?: string;
	/** Set when the hit is in a tool call, so the client can jump to that tool's row. */
	toolUseId?: string;
	toolName?: string;
}

/** One session (narrator) matching the query by its title, its messages, or both. */
export interface SessionResult {
	type: "session";
	id: string;
	title?: string;
	narratorType?: string;
	subagentType?: string;
	status?: string;
	projectId?: string;
	projectName?: string;
	/** Latest hit, or the session's own last activity when only the title matched. */
	lastActivityAt?: string;
	titleMatch: boolean;
	hitCount: number;
	hits: SessionHit[];
	/** 0..1, relevance sort only; meaningful within the sessions section alone. */
	score: number;
}

export interface SectionPage<T> {
	items: T[];
	/** Matches in the section's candidate window. */
	total: number;
	/** The window filled up, so there may be more than `total`. */
	totalIsLowerBound: boolean;
	nextCursor: string | null;
	/**
	 * Set when the search was limited to this many recent days on its own (a query of only
	 * short terms, see {@link sessionSearchWindow}), so the page can offer the full history.
	 */
	recentDays?: number;
}

export interface SectionSearchResponse {
	sessions?: SectionPage<SessionResult>;
	knowledge?: SectionPage<SearchResult>;
}

/** Opaque page cursor: an offset into the section's ranked window. */
export function encodeSearchCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

/** The offset a cursor names; anything malformed reads as the first page. */
export function decodeSearchCursor(cursor: string | undefined): number {
	if (!cursor) return 0;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		const offset = Number(parsed?.o);
		return Number.isInteger(offset) && offset >= 0 ? offset : 0;
	} catch {
		return 0;
	}
}

function pageOf<T>(ranked: readonly T[], offset: number, limit: number, capped: boolean) {
	const items = ranked.slice(offset, offset + limit);
	const end = offset + items.length;
	return {
		items,
		total: ranked.length,
		totalIsLowerBound: capped,
		nextCursor: end < ranked.length ? encodeSearchCursor(end) : null,
	};
}

/** A session before ranking: its message aggregate, its title hit, or both merged. */
export interface SessionCandidate {
	narratorId: string;
	title: string | null;
	type: string | null;
	subagentType: string | null;
	status: string | null;
	projectId: string | null;
	projectName: string | null;
	bestRank: number | null;
	hitCount: number;
	lastHitAt: string | null;
	/** The session's own last activity, for title-only matches. */
	activityAt: string | null;
	titleMatch: boolean;
}

/** Merge message aggregates and title hits into one candidate per narrator. */
export function mergeSessionCandidates(
	aggregates: readonly SessionAggregateRow[],
	titleHits: readonly NarratorSearchRow[],
): SessionCandidate[] {
	const byId = new Map<string, SessionCandidate>();
	for (const row of aggregates) {
		byId.set(row.narratorId, {
			narratorId: row.narratorId,
			title: row.title,
			type: row.type,
			subagentType: row.subagentType,
			status: row.status,
			projectId: row.projectId,
			projectName: row.projectName,
			bestRank: row.bestRank,
			hitCount: row.hitCount,
			lastHitAt: row.lastHitAt,
			activityAt: row.lastMessageAt ?? row.updatedAt ?? row.createdAt,
			titleMatch: false,
		});
	}
	for (const row of titleHits) {
		const existing = byId.get(row.id);
		if (existing) {
			existing.titleMatch = true;
			continue;
		}
		byId.set(row.id, {
			narratorId: row.id,
			title: row.title,
			type: row.type,
			subagentType: row.subagentType,
			status: row.status,
			projectId: row.projectId,
			projectName: row.projectName,
			bestRank: null,
			hitCount: 0,
			lastHitAt: null,
			activityAt: row.lastMessageAt ?? row.updatedAt ?? row.createdAt,
			titleMatch: true,
		});
	}
	return [...byId.values()];
}

/** When a session last showed activity relevant to this search. */
export function sessionActivityAt(candidate: SessionCandidate): string | null {
	return candidate.lastHitAt ?? candidate.activityAt;
}

/**
 * Score weights: message relevance, title match, hit count, recency. They sum to 1.
 *
 * Message relevance weighs least on purpose. Every hit already contains the query, so the
 * best hit's rank mostly measures message length, and min-max scaling stretches even a tiny
 * spread to the full 0..1 range; given more weight it let one short old message outrank an
 * active session that matches throughout.
 */
const SESSION_WEIGHTS = { relevance: 0.15, title: 0.3, hits: 0.3, recency: 0.25 } as const;
/** Recency halves every this many days. */
const RECENCY_HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Rank sessions for one sort, returning each with its score.
 *
 * Relevance blends four signals, each scaled to 0..1 within this candidate set, so ranks
 * from different backends or indexes never have to be comparable in absolute terms:
 * - message relevance: the best hit's rank, min-max scaled (lower rank is better);
 * - title match: whether the session title contains the query;
 * - hit count: log-scaled against the most-hit session;
 * - recency: halves every {@link RECENCY_HALF_LIFE_DAYS} days since the latest activity.
 * Time sorts by that latest activity, newest first. Ties break by narrator id.
 */
export function rankSessions(
	candidates: readonly SessionCandidate[],
	sort: SearchSort,
	now: number = Date.now(),
): Array<{ candidate: SessionCandidate; score: number }> {
	const ranks = candidates.flatMap((c) => (c.bestRank === null ? [] : [c.bestRank]));
	const minRank = Math.min(...ranks);
	const maxRank = Math.max(...ranks);
	const maxHits = Math.max(1, ...candidates.map((c) => c.hitCount));
	const timeOf = (c: SessionCandidate) => Date.parse(sessionActivityAt(c) ?? "") || 0;
	const scored = candidates.map((candidate) => {
		const relevance =
			candidate.bestRank === null
				? 0
				: maxRank > minRank
					? (maxRank - candidate.bestRank) / (maxRank - minRank)
					: 1;
		const hits = Math.log1p(candidate.hitCount) / Math.log1p(maxHits);
		const time = timeOf(candidate);
		const ageDays = time ? Math.max(0, now - time) / DAY_MS : Number.POSITIVE_INFINITY;
		const recency = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
		const score =
			SESSION_WEIGHTS.relevance * relevance +
			SESSION_WEIGHTS.title * (candidate.titleMatch ? 1 : 0) +
			SESSION_WEIGHTS.hits * hits +
			SESSION_WEIGHTS.recency * recency;
		return { candidate, score, time };
	});
	scored.sort((a, b) => {
		const primary = sort === "time" ? b.time - a.time : b.score - a.score;
		if (primary !== 0) return primary;
		const id = a.candidate.narratorId;
		const other = b.candidate.narratorId;
		return id < other ? -1 : id > other ? 1 : 0;
	});
	return scored.map(({ candidate, score }) => ({ candidate, score }));
}

function toSessionHit(row: MessageSearchRow): SessionHit {
	return {
		id: row.id,
		snippet: row.snippet || row.preview || "",
		...(row.messageRole ? { messageRole: row.messageRole } : {}),
		...(row.createdAt ? { createdAt: row.createdAt } : {}),
		...(row.blockId ? { blockId: row.blockId } : {}),
		...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
		...(row.toolName ? { toolName: row.toolName } : {}),
	};
}

export interface SectionSearchOptions {
	query: string;
	sections: readonly SearchSection[];
	sort?: SearchSort;
	scope?: MessageSearchScope;
	filters?: SearchFilters;
	principal: { userId: string; isAdmin: boolean };
	/** Page size per section. */
	limits: Partial<Record<SearchSection, number>>;
	/** Continues one section; ignored unless exactly one section is requested. */
	cursor?: string;
	/** Search all of history even when the query would otherwise be limited to recent days. */
	fullHistory?: boolean;
	signal?: AbortSignal;
}

/** Days a session search of only short terms covers unless asked for more. */
export const SHORT_QUERY_RECENT_DAYS = 90;

/**
 * The filters a session search runs with, and whether it limited itself.
 *
 * A query made only of terms too short for the index (most two-character Chinese words)
 * takes the unindexed path, which reads every message in range. Unless the caller set a
 * lower time bound or asked for the full history, such a search covers the last
 * {@link SHORT_QUERY_RECENT_DAYS} days, which the `(narrator_id, created_at)` index turns into
 * a range scan per session instead of a read of every message. The bound is rounded down to
 * the UTC day, so repeated searches share one cache entry and one plan.
 */
export function sessionSearchWindow(
	safeQuery: string,
	filters: SearchFilters | undefined,
	fullHistory: boolean | undefined,
	now: number = Date.now(),
): { filters: SearchFilters | undefined; recentDays?: number } {
	if (fullHistory || filters?.from || globalStrategy(safeQuery) === "index") return { filters };
	const from = new Date(
		Math.floor(now / DAY_MS) * DAY_MS - SHORT_QUERY_RECENT_DAYS * DAY_MS,
	).toISOString();
	return { filters: { ...filters, from }, recentDays: SHORT_QUERY_RECENT_DAYS };
}

/** The shared part of every entity query a sectioned search makes. */
function entityBase(
	options: Pick<SectionSearchOptions, "sort" | "scope" | "filters" | "principal" | "signal">,
	safeQuery: string,
): Omit<EntitySearchQuery, "limit"> {
	return {
		text: safeQuery,
		strategy: globalStrategyFor(safeQuery),
		sort: options.sort ?? "relevance",
		viewer: options.principal,
		scope: options.scope ?? CONVERSATION_MESSAGE_SCOPE,
		filters: options.filters,
		signal: options.signal,
	};
}

/** Whether an ISO time falls inside the filter's inclusive bounds. */
function withinTime(time: string | undefined, filters: SearchFilters | undefined): boolean {
	if (!filters?.from && !filters?.to) return true;
	if (!time) return false;
	if (filters.from && time < filters.from) return false;
	if (filters.to && time > filters.to) return false;
	return true;
}

/** A session search's ranked candidates, reused by its pages and expanded cards. */
interface RankedSessions {
	ranked: Array<{ candidate: SessionCandidate; score: number }>;
	capped: boolean;
	/** The newest hits of each session with message hits, by reference. */
	latestHits: Map<string, SessionHitRef[]>;
	recentDays?: number;
}

/**
 * How long one search's ranked sessions serve its later requests: the overview, the tab,
 * each page and each expanded card. A common term matches across most of the corpus, and
 * re-running the search per page cost a full index scan each time; within this window a
 * page reads only its own hits by id. New messages show up once it lapses, as with the
 * client's own cache.
 */
const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_ENTRIES = 32;
/** A session's hits kept for paging its expanded card; further pages query directly. */
const EXPANDED_HITS_CACHED = 200;

const sessionCache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Forget every cached session search (tests, and anything that must see writes at once). */
export function clearSessionSearchCache(): void {
	sessionCache.clear();
}

/**
 * The value cached under `key`, computing it at most once per TTL however many requests
 * ask at the same time. A computation that fails is dropped, and a caller whose own request
 * is still live retries once when it was another caller's cancellation that failed it.
 */
async function cachedSessionSearch<T>(
	key: string,
	signal: AbortSignal | undefined,
	compute: () => Promise<T>,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const now = Date.now();
		let entry = sessionCache.get(key);
		if (!entry || now - entry.at > SESSION_CACHE_TTL_MS) {
			const created = { at: now, value: compute() as Promise<unknown> };
			created.value.catch(() => {
				if (sessionCache.get(key) === created) sessionCache.delete(key);
			});
			sessionCache.delete(key);
			sessionCache.set(key, created);
			for (const [old, value] of sessionCache) {
				if (sessionCache.size <= SESSION_CACHE_ENTRIES) break;
				if (value !== created) sessionCache.delete(old);
			}
			entry = created;
		}
		try {
			return (await entry.value) as T;
		} catch (error) {
			if (attempt > 0 || signal?.aborted) throw error;
		}
	}
}

/** Cache identity of a session search: everything that changes its candidates. */
function sessionCacheKey(base: Omit<EntitySearchQuery, "limit">): string {
	return JSON.stringify([
		base.viewer.userId,
		base.viewer.isAdmin,
		base.text,
		base.strategy,
		base.sort,
		base.scope,
		base.filters ?? null,
	]);
}

async function rankedSessions(
	options: SectionSearchOptions,
	safeQuery: string,
): Promise<RankedSessions> {
	const window = sessionSearchWindow(safeQuery, options.filters, options.fullHistory);
	const base = entityBase({ ...options, filters: window.filters }, safeQuery);
	return cachedSessionSearch(`sessions:${sessionCacheKey(base)}`, options.signal, async () => {
		const [aggregates, titleHits] = await Promise.all([
			searchStore.searchSessionAggregates({
				...base,
				limit: SESSION_AGGREGATE_CAP,
				latestHits: HITS_PER_SESSION,
			}),
			searchStore.searchNarrators({ ...base, limit: SESSION_TITLE_CAP }),
		]);
		return {
			ranked: rankSessions(mergeSessionCandidates(aggregates, titleHits), base.sort ?? "relevance"),
			capped: aggregates.length >= SESSION_AGGREGATE_CAP || titleHits.length >= SESSION_TITLE_CAP,
			latestHits: new Map(aggregates.map((row) => [row.narratorId, row.latestHits])),
			...(window.recentDays ? { recentDays: window.recentDays } : {}),
		};
	});
}

async function searchSessionSection(
	options: SectionSearchOptions,
	safeQuery: string,
	offset: number,
	limit: number,
): Promise<SectionPage<SessionResult>> {
	const sessions = await rankedSessions(options, safeQuery);
	const page = pageOf(sessions.ranked, offset, limit, sessions.capped);
	const refs = page.items.flatMap(
		({ candidate }) => sessions.latestHits.get(candidate.narratorId) ?? [],
	);
	const hitRows =
		refs.length === 0
			? []
			: await searchStore.searchSessionHitDetails({
					text: safeQuery,
					refs,
					signal: options.signal,
				});
	const hitsBySession = new Map<string, SessionHit[]>();
	for (const row of hitRows) {
		if (!row.narratorId) continue;
		const list = hitsBySession.get(row.narratorId) ?? [];
		list.push(toSessionHit(row));
		hitsBySession.set(row.narratorId, list);
	}
	return {
		...page,
		...(sessions.recentDays ? { recentDays: sessions.recentDays } : {}),
		items: page.items.map(({ candidate, score }) => ({
			type: "session" as const,
			id: candidate.narratorId,
			title: candidate.title ?? undefined,
			narratorType: candidate.type ?? undefined,
			subagentType: candidate.subagentType ?? undefined,
			status: candidate.status ?? undefined,
			projectId: candidate.projectId ?? undefined,
			projectName: candidate.projectName ?? undefined,
			lastActivityAt: sessionActivityAt(candidate) ?? undefined,
			titleMatch: candidate.titleMatch,
			hitCount: candidate.hitCount,
			hits: hitsBySession.get(candidate.narratorId) ?? [],
			score: Math.round(score * 1000) / 1000,
		})),
	};
}

export const searchService = {
	async search(options: SearchOptions): Promise<SearchResult[]> {
		const {
			query,
			entities,
			limit = 50,
			principal,
			sort = "relevance",
			scope = CONVERSATION_MESSAGE_SCOPE,
		} = options;
		const results: SearchResult[] = [];

		// Sanitize: remove FTS5 special chars to prevent injection
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return results;

		const strategy = globalStrategyFor(safeQuery);
		// One query object for every entity search: the viewer travels with it, so a branch
		// cannot accidentally run ungated.
		const base = {
			text: safeQuery,
			strategy,
			limit,
			sort,
			viewer: principal,
			signal: options.signal,
			scope,
		};

		if (entities.includes("messages")) {
			const candidateLimit = messageCandidateLimit(limit);
			const rows = await searchStore.searchMessages({ ...base, limit: candidateLimit });
			const fallbackScore = strategy === "index" ? 700 : 500;
			for (const group of groupMessageHits(rows, limit)) {
				const row = group.best;
				results.push({
					type: "message",
					id: row.id,
					narratorId: row.narratorId ?? undefined,
					narratorTitle: row.narratorTitle ?? undefined,
					projectName: row.projectName ?? undefined,
					model: row.model ?? undefined,
					messageRole: row.messageRole ?? undefined,
					createdAt: row.createdAt ?? undefined,
					matchField: "message",
					matchScore: scoreFromRank(row.rank, fallbackScore),
					snippet: row.snippet || row.preview || "",
					...(row.blockId ? { blockId: row.blockId } : {}),
					hits: group.hits.map((hit) => ({
						id: hit.id,
						snippet: hit.snippet || hit.preview || "",
						...(hit.messageRole ? { messageRole: hit.messageRole } : {}),
						...(hit.createdAt ? { createdAt: hit.createdAt } : {}),
						...(hit.blockId ? { blockId: hit.blockId } : {}),
					})),
					hitCount: group.hitCount,
					hitCountIsLowerBound: rows.length >= candidateLimit,
				});
			}
		}

		if (entities.includes("narrators")) {
			for (const row of await searchStore.searchNarrators(base)) {
				results.push({
					type: "narrator",
					id: row.id,
					title: row.title ?? undefined,
					projectName: row.projectName ?? undefined,
					status: row.status ?? undefined,
					model: row.model ?? undefined,
					createdAt: row.createdAt ?? undefined,
					updatedAt: row.updatedAt ?? undefined,
					lastMessageAt: row.lastMessageAt,
					matchField: "title",
					matchScore: scoreFromRank(row.rank, strategy === "index" ? 820 : 620),
					snippet: row.snippet || row.title || "",
				});
			}
		}

		return sortSearchResults(results, sort);
	},

	/**
	 * The search page's sectioned search: sessions and knowledge, each ranked within itself
	 * and paged on its own.
	 *
	 * Sessions merge title matches with message hits rolled up per narrator, so a session
	 * appears once however many of its messages match. Knowledge keeps its store's own
	 * order. `cursor` continues a single requested section.
	 */
	async searchSections(options: SectionSearchOptions): Promise<SectionSearchResponse> {
		const safeQuery = sanitizeQuery(options.query);
		const response: SectionSearchResponse = {};
		if (!safeQuery) return response;
		const offset = options.sections.length === 1 ? decodeSearchCursor(options.cursor) : 0;
		const limitOf = (section: SearchSection) =>
			Math.max(1, Math.min(options.limits[section] ?? 10, 100));
		const base = entityBase(options, safeQuery);

		await Promise.all(
			options.sections.map(async (section) => {
				if (section === "sessions") {
					response.sessions = await searchSessionSection(
						options,
						safeQuery,
						offset,
						limitOf(section),
					);
				} else {
					const rows = await searchService.searchKnowledge({
						query: safeQuery,
						limit: KNOWLEDGE_CAP,
						sort: base.sort,
						principal: options.principal,
						projectId: options.filters?.projectId,
						signal: options.signal,
					});
					const results = rows.filter((row) => withinTime(row.updatedAt, options.filters));
					response.knowledge = pageOf(
						results,
						offset,
						limitOf(section),
						rows.length >= KNOWLEDGE_CAP,
					);
				}
			}),
		);
		return response;
	},

	/**
	 * More hits of one session, newest first, for expanding its result card. Gated, scoped
	 * and filtered exactly like the section that listed the session.
	 */
	async searchSessionHits(
		options: Omit<SectionSearchOptions, "sections" | "limits"> & {
			narratorId: string;
			limit?: number;
		},
	): Promise<{ hits: SessionHit[]; nextCursor: string | null }> {
		const safeQuery = sanitizeQuery(options.query);
		if (!safeQuery) return { hits: [], nextCursor: null };
		const offset = decodeSearchCursor(options.cursor);
		const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_SESSION_HITS_PAGE));
		const window = sessionSearchWindow(safeQuery, options.filters, options.fullHistory);
		const base = entityBase({ ...options, filters: window.filters }, safeQuery);
		const query = {
			...base,
			sort: SESSION_HIT_ORDER,
			limit,
			narratorIds: [options.narratorId],
		};
		// One extra row tells whether another page exists. The first pages come from one
		// read of the session's newest hits, so paging an expanded card searches once.
		const rows =
			offset + limit < EXPANDED_HITS_CACHED
				? (
						await cachedSessionSearch(
							`hits:${options.narratorId}:${sessionCacheKey(base)}`,
							options.signal,
							() => searchStore.searchSessionHits({ ...query, perSession: EXPANDED_HITS_CACHED }),
						)
					).slice(offset, offset + limit + 1)
				: await searchStore.searchSessionHits({ ...query, perSession: limit + 1, offset });
		const hits = rows.slice(0, limit).map(toSessionHit);
		return {
			hits,
			nextCursor: rows.length > limit ? encodeSearchCursor(offset + limit) : null,
		};
	},

	/**
	 * Knowledge-base entries as global-search results.
	 *
	 * Kept separate from `search()` because its visibility gate differs in kind: knowledge
	 * visibility is a dual-axis (clearance + controlled tag) check that reads grants, so it
	 * cannot be expressed as a SQL fragment the way the narrator gate is. The
	 * matched rows are post-filtered by `knowledgeService.filterReadable`, which
	 * fails closed — the same gate the knowledge routes use.
	 *
	 * Results carry `updatedAt`, so the "newest" sort in the UI orders them
	 * alongside the other entity types without special-casing.
	 */
	async searchKnowledge(options: {
		query: string;
		limit?: number;
		signal?: AbortSignal;
		sort?: "time" | "relevance";
		principal: { userId: string; isAdmin: boolean };
		/** Restrict to this project's collections plus global ones. */
		projectId?: string;
	}): Promise<SearchResult[]> {
		const { query, limit = 50, principal } = options;
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return [];

		// The caller's own personal versions shadow the committed one, mirroring what
		// they see in the knowledge UI: a hit on text they only have locally must not
		// be reported against the main body it replaced.
		const rows = await knowledgeService.search({
			q: safeQuery,
			limit,
			signal: options.signal,
			sort: options.sort,
			projectId: options.projectId,
			draftUserId: principal.userId || undefined,
		});
		if (rows.length === 0) return [];

		const readable = await knowledgeService.filterReadable(
			principal.userId
				? { userId: principal.userId, role: principal.isAdmin ? "admin" : "user" }
				: undefined,
			rows,
		);
		if (readable.length === 0) return [];

		const collectionNames = await collectionNameMap(
			readable.flatMap((r) => (r.collectionId ? [r.collectionId] : [])),
		);
		const safeQueryLower = safeQuery.toLowerCase();
		return readable.map((row) => ({
			type: "knowledge" as const,
			id: row.id,
			title: row.title,
			collectionId: row.collectionId ?? undefined,
			collectionName: row.collectionId ? collectionNames.get(row.collectionId) : undefined,
			tags: row.tags,
			status: row.status,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			matchField: row.title?.toLowerCase().includes(safeQueryLower) ? "title" : "content",
			// Knowledge search returns rank-ordered rows without exposing the raw rank,
			// so score by position within a band that keeps titles above body matches.
			matchScore: strategyFor(safeQuery) === "index" ? 780 : 540,
			snippet: row.snippet || row.title || "",
		}));
	},

	/**
	 * Full-text search within a single narrator's own conversation history.
	 * Returns messages on this narrator's timeline (newest first) with the `seq`
	 * needed to jump to each result. Bounded by `limit` (hard cap 100).
	 *
	 * `inheritedScopes` widens the search across a lazy fork's ancestry: a fork
	 * only materializes refs after its parent's last compact, so older history is
	 * still owned by an ancestor. Each scope carries the seq bound that ancestor
	 * was inherited up to, which keeps out messages the ancestor produced *after*
	 * the fork diverged. Callers obtain these from `resolveLazyLineage`; passing
	 * none reproduces the single-narrator behaviour exactly.
	 */
	async searchNarratorMessages(
		narratorId: string,
		query: string,
		limit = 60,
		inheritedScopes: InheritedSearchScope[] = [],
	): Promise<NarratorMessageSearchResult[]> {
		const safeQuery = sanitizeQuery(query);
		if (!safeQuery) return [];

		return searchStore.searchTimeline({
			narratorId,
			text: safeQuery,
			strategy: globalStrategyFor(safeQuery),
			limit: Math.min(Math.max(1, limit), 100),
			inheritedScopes,
		});
	},
};
