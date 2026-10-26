/**
 * Search contract types — the business vocabulary every search backend speaks.
 *
 * WHAT THIS FILE MAY NOT CONTAIN
 * ------------------------------
 * Nothing here may name a driver, a Drizzle table, a transaction, a prepared statement, an
 * FTS5 expression or a positional-parameter list. Those are the SQLite implementation's
 * business (`sqlite-store.ts`). This file is what a second backend has to satisfy, so if a
 * PostgreSQL author has to read `sqlite-store.ts` to understand a field, the field is wrong.
 *
 * WHY THE QUERY SHAPES ARE NOT UNIFIED
 * ------------------------------------
 * Four call sites search text today and they do NOT agree on recall:
 *
 *   - global search (messages / narrators) matches each whitespace-separated term as a
 *     PREFIX, all required; terms too short for the trigram index are checked as substrings
 *     on the rows the indexed terms select (`globalQueryTerms`);
 *   - the narrator timeline and Recall match each whitespace-separated term as a PREFIX;
 *   - knowledge matches prefixes too, but supports any-term matching and a field restriction;
 *   - the substring fallbacks disagree on wildcard escaping: knowledge escapes `%`/`_` typed
 *     by the user, the other three deliberately do not (a user-typed `%` widens their match).
 *
 * Collapsing those into one query type would silently change which rows come back and in
 * which order — the kind of regression that looks like "search feels different" and is never
 * traced to a refactor. So each operation keeps its own descriptor, and the differences are
 * recorded here rather than discovered later. Unifying them is a product decision, not a
 * porting decision.
 */

/** The user a search runs on behalf of. Never optional: an absent viewer used to mean
 *  "see everything", and a caller that simply forgot would silently reopen a leak. */
export interface SearchViewer {
	userId: string;
	isAdmin: boolean;
}

/**
 * Which retrieval path an operation must take.
 *
 * `index` is the backend's full-text index; `substring` is the unindexed contains-match a
 * short needle needs (SQLite's trigram tokenizer cannot form a token below three
 * characters, which holds for CJK too). The CALLER decides, because the threshold is a
 * product rule with observable consequences — result scores differ per path — and because a
 * backend that silently chose for itself could change recall without any caller noticing.
 */
export type SearchStrategy = "index" | "substring";

/** Candidate ordering must be applied before limiting the result set. */
export type SearchSort = "time" | "relevance";

/**
 * Backend-reported relevance for a row, lower being a better match.
 *
 * `null` on substring paths, which have no relevance signal at all — callers score those
 * from a flat band instead. Deliberately NOT normalized here: the caller's scoring curve is
 * calibrated against the raw value, so rescaling it in the port would move every result.
 */
export type RelevanceRank = number | null;

/**
 * One ancestor a lazily-forked narrator still borrows older refs from.
 *
 * `upperBoundSeq` is exclusive — refs at or above it were produced by that ancestor after
 * the fork diverged and must not surface in the child's search.
 */
export interface InheritedSearchScope {
	narratorId: string;
	upperBoundSeq: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snippet shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How each operation's excerpt is marked up.
 *
 * Recorded in the contract rather than buried in the backend's snippet call because
 * consumers parse it: the Recall tool's output format relies on `>>>`/`<<<`, and the
 * knowledge UI on `[`/`]`. A backend that emitted plain text instead would produce output
 * that still looks fine in a test assertion on `.length` and is wrong in the product.
 */
export interface SnippetFormat {
	/** Inserted before a matched term. Empty means "do not mark matches". */
	readonly open: string;
	/** Inserted after a matched term. */
	readonly close: string;
	/** Stands in for text elided around the excerpt. */
	readonly ellipsis: string;
	/** Roughly how many tokens of context the excerpt carries. */
	readonly tokens: number;
}

/** Global search (message bodies, narrator titles): unmarked excerpt. */
export const GLOBAL_SNIPPET: SnippetFormat = {
	open: "",
	close: "",
	ellipsis: "...",
	tokens: 96,
};

/** A narrator's own timeline: a tighter excerpt, shown inline in a jump list. */
export const TIMELINE_SNIPPET: SnippetFormat = {
	open: "",
	close: "",
	ellipsis: "...",
	tokens: 32,
};

/** Recall hands its output to a model, so matches are marked explicitly. */
export const RECALL_SNIPPET: SnippetFormat = {
	open: ">>>",
	close: "<<<",
	ellipsis: "...",
	tokens: 64,
};

/** Knowledge entries and drafts, whose UI renders the brackets as highlights. */
export const KNOWLEDGE_SNIPPET: SnippetFormat = {
	open: "[",
	close: "]",
	ellipsis: "...",
	tokens: 96,
};

/** Characters of raw body text carried alongside a hit as a fallback preview. */
export const PREVIEW_CHARS = 240;

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A global-search query over one entity type.
 *
 * `text` is already sanitized by the caller and is non-empty. `viewer` is what the backend
 * gates on; it must NOT be applied after the rows come back, because a hit carries a title
 * and a body excerpt — post-filtering would mean the excerpt was already computed from
 * content the viewer may not read.
 */
export interface EntitySearchQuery {
	signal?: AbortSignal;
	sort?: SearchSort;
	text: string;
	strategy: SearchStrategy;
	limit: number;
	viewer: SearchViewer;
	/** Which conversation content message and narrator hits may come from. Omitted means
	 *  {@link FULL_MESSAGE_SCOPE}. */
	scope?: MessageSearchScope;
	/** Narrowing filters; values are always bound, never interpolated. */
	filters?: SearchFilters;
}

/**
 * Narrowing filters for global search. Time bounds are inclusive ISO strings compared against
 * the entity's activity time: a message's creation, a narrator's last activity.
 */
export interface SearchFilters {
	/** The narrator's project, by the `resolveNarratorProjectId` rule. */
	projectId?: string;
	from?: string;
	to?: string;
	/** Only narrators this user owns. */
	ownerUserId?: string;
}

/**
 * Which kinds of conversation content global search looks at.
 *
 * Each flag widens the search beyond what people wrote and read in a primary session. Off,
 * the search skips text that repeats elsewhere or that nobody typed: a subagent's working
 * notes (its result already lands in the parent), injected context such as knowledge hints
 * (the entry itself is a knowledge hit), and tool calls with their output.
 */
export interface MessageSearchScope {
	/** Subagent narrators: their messages, and their titles in narrator search. */
	subagents: boolean;
	/** System-written rows: injections, reminders, compact markers, automation prompts. */
	system: boolean;
	/** Tool calls and their results. */
	tools: boolean;
	/** Archived narrators. */
	archived: boolean;
}

/** Everything, which is what global search matched before scopes existed. */
export const FULL_MESSAGE_SCOPE: MessageSearchScope = Object.freeze({
	subagents: true,
	system: true,
	tools: true,
	archived: true,
});

/** The global search default: what people wrote and read in primary sessions. */
export const CONVERSATION_MESSAGE_SCOPE: MessageSearchScope = Object.freeze({
	subagents: false,
	system: false,
	tools: false,
	archived: false,
});

/**
 * Message hits rolled up per narrator, for session-level global search.
 *
 * `query.limit` caps the number of narrators returned. Rows come best first: by best hit
 * rank for relevance (then by hit count and recency), by latest hit for time (see
 * {@link orderSessionAggregates}). Every hit the narrator has counts, not only those within
 * a window. The same pass names each narrator's `latestHits` newest hits, so listing a page
 * of sessions with their hits needs no second search.
 */
export interface SessionAggregateQuery extends EntitySearchQuery {
	/** Newest hits to name per narrator, at most {@link MAX_LATEST_SESSION_HITS}. */
	latestHits?: number;
}

/** Ceiling on {@link SessionAggregateQuery.latestHits}. */
export const MAX_LATEST_SESSION_HITS = 10;

/** One hit of a session, by reference: what {@link SessionHitDetailsQuery} reads back. */
export interface SessionHitRef {
	id: string;
	/** The matching block when only a block matched; read for its excerpt. */
	blockId: string | null;
	createdAt: string | null;
}

/**
 * Hits already found by a session search, read back by id for display: no search runs.
 * `text` picks the excerpt window; rows come back in `refs` order, missing ids dropped.
 */
export interface SessionHitDetailsQuery {
	signal?: AbortSignal;
	text: string;
	refs: readonly SessionHitRef[];
}

/** The top hits of each of a few narrators. */
export interface SessionHitsQuery extends EntitySearchQuery {
	/** The narrators to read hits for; a bounded page, not a corpus. */
	narratorIds: readonly string[];
	/** Hits returned per narrator, after skipping `offset` of them. */
	perSession: number;
	offset?: number;
}

/**
 * Search inside one narrator's own timeline.
 *
 * `inheritedScopes` widens the search across a lazy fork's ancestry. Empty reproduces
 * single-narrator behaviour exactly.
 */
export interface TimelineSearchQuery {
	signal?: AbortSignal;
	narratorId: string;
	text: string;
	strategy: SearchStrategy;
	limit: number;
	inheritedScopes: readonly InheritedSearchScope[];
}

/**
 * Recall's message search.
 *
 * `narratorId: null` means "across every narrator", which is a wider capability the tool
 * gates on user approval before it ever reaches here. `createdFrom`/`createdTo` are
 * inclusive ISO bounds.
 */
export interface RecallSearchQuery {
	signal?: AbortSignal;
	text: string;
	strategy: SearchStrategy;
	limit: number;
	narratorId: string | null;
	createdFrom?: string;
	createdTo?: string;
	/** Characters of body text the substring path returns as its excerpt. */
	previewChars: number;
}

/** Match all terms, or any one of them. Any-term matching exists for passive injection,
 *  whose input is a natural-language sentence rather than a deliberate query. */
export type KnowledgeMatchMode = "and" | "or";

/**
 * A knowledge search over committed entries or over one author's drafts.
 *
 * Two needles, because the two paths historically use different input: the index path
 * matches the SANITIZED query, the substring path matches the caller's TRIMMED RAW query
 * (so a term containing an FTS operator still matches literally). An empty `substringText`
 * means "match every row", which is how the knowledge UI lists recent entries.
 */
export interface KnowledgeSearchQuery {
	signal?: AbortSignal;
	sort?: SearchSort;
	indexText: string;
	substringText: string;
	strategy: SearchStrategy;
	limit: number;
	collectionId?: string;
	/** Restrict to collections in this project PLUS project-less (global) collections. */
	projectId?: string;
	match: KnowledgeMatchMode;
	/**
	 * Restrict matching to one index field instead of title + body.
	 *
	 * An identifier the backend maps to its own column, NOT raw query text: backends must
	 * reject a name they do not recognize rather than interpolate it. Only
	 * `current_keywords` is used today (passive injection, which must never fire on body
	 * text).
	 */
	field?: string;
	/** Entry ids to leave out, because the caller supplies them from another search. */
	excludeEntryIds?: readonly string[];
}

/** A knowledge search over the drafts of one author. */
export interface KnowledgeDraftSearchQuery extends KnowledgeSearchQuery {
	/** Internal opt-in: include this author's active standalone personal entries. */
	includeStandalone?: boolean;
	authorUserId: string;
	/** Draft lifecycle status that shadows the committed version. */
	draftStatus: string;
}

/** Which entries one author currently shadows with a draft. */
export interface ShadowedEntryQuery {
	signal?: AbortSignal;
	authorUserId: string;
	draftStatus: string;
	limit: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageSearchRow {
	id: string;
	narratorId: string | null;
	narratorTitle: string | null;
	/** Name of the narrator's project (the `resolveNarratorProjectId` rule), if it has one. */
	projectName: string | null;
	model: string | null;
	messageRole: string | null;
	createdAt: string | null;
	snippet: string;
	/** Leading body text, used when the backend produced no excerpt. */
	preview: string;
	rank: RelevanceRank;
	/**
	 * The block the match is in, when the backend indexes blocks (docs/BLOCK_STORAGE-DESIGN.md
	 * §4.6). Absent for envelopes without blocks, substring matches and backends without a
	 * block index; the hit still names its message.
	 */
	blockId?: string;
	/** The tool call a tool-block hit belongs to, so a client can jump to that tool's row. */
	toolUseId?: string;
	/** That tool call's tool name. */
	toolName?: string;
}

export interface NarratorSearchRow {
	id: string;
	title: string | null;
	type: string | null;
	subagentType: string | null;
	/** The narrator's project id, by the same rule as {@link MessageSearchRow.projectName}. */
	projectId: string | null;
	/** See {@link MessageSearchRow.projectName}. */
	projectName: string | null;
	status: string | null;
	model: string | null;
	lastMessageAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	snippet: string;
	rank: RelevanceRank;
}

/** One narrator's message hits, with what a session result needs to show it. */
export interface SessionAggregateRow {
	narratorId: string;
	/** Best (lowest) relevance rank among the hits; null on the substring path. */
	bestRank: RelevanceRank;
	hitCount: number;
	lastHitAt: string | null;
	title: string | null;
	type: string | null;
	subagentType: string | null;
	status: string | null;
	projectId: string | null;
	projectName: string | null;
	lastMessageAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	/** The newest hits, newest first, when the query asked for them. */
	latestHits: SessionHitRef[];
}

/**
 * The order {@link SessionAggregateQuery} promises, shared by the stores so both backends
 * cut the same window: relevance by best rank (unranked last), then hit count, then the
 * latest hit; time by the latest hit. The narrator id breaks ties.
 */
export function orderSessionAggregates(
	rows: SessionAggregateRow[],
	sort: SearchSort | undefined,
	limit: number,
): SessionAggregateRow[] {
	const byTime = (a: SessionAggregateRow, b: SessionAggregateRow) => {
		const x = a.lastHitAt ?? "";
		const y = b.lastHitAt ?? "";
		return x < y ? 1 : x > y ? -1 : 0;
	};
	const byId = (a: SessionAggregateRow, b: SessionAggregateRow) =>
		a.narratorId < b.narratorId ? -1 : a.narratorId > b.narratorId ? 1 : 0;
	const compare =
		sort === "time"
			? (a: SessionAggregateRow, b: SessionAggregateRow) => byTime(a, b) || byId(a, b)
			: (a: SessionAggregateRow, b: SessionAggregateRow) =>
					(a.bestRank === null ? 1 : 0) - (b.bestRank === null ? 1 : 0) ||
					(a.bestRank ?? 0) - (b.bestRank ?? 0) ||
					b.hitCount - a.hitCount ||
					byTime(a, b) ||
					byId(a, b);
	return rows.sort(compare).slice(0, Math.max(0, limit));
}

export interface TimelineSearchRow {
	messageId: string;
	/** Position in the narrator's timeline, so a client can jump to the hit. */
	seq: number;
	role: string;
	snippet: string;
	preview: string;
	createdAt: string;
	/** See {@link MessageSearchRow.blockId}. */
	blockId?: string;
}

export interface RecallMessageRow {
	messageId: string;
	narratorId: string;
	narratorTitle: string | null;
	role: string;
	createdAt: string;
	snippet: string;
}

export interface KnowledgeSearchRow {
	id: string;
	/** Standalone rows use this id with KnowledgeRead, never a global entry id. */
	personalEntryId?: string;
	collectionId: string | null;
	title: string;
	slug: string;
	/**
	 * The entry's stored tag list, still encoded.
	 *
	 * Left encoded on purpose: the knowledge service parses tags the same way for its
	 * non-search paths, and a second parser inside a backend is exactly the kind of copy
	 * that drifts once and then reports different tags depending on how a row was reached.
	 */
	tagsJson: string | null;
	status: string;
	createdAt: string;
	updatedAt: string;
	snippet: string;
	/** True when this row reflects the caller's own draft rather than the committed version. */
	fromDraft: boolean;
	/** True when the draft forked from a revision the committed version has since moved past. */
	drifted: boolean;
}

/** The newest-hit count a query asked for, within bounds. */
export function latestHitCount(query: SessionAggregateQuery): number {
	return Math.max(0, Math.min(Math.trunc(query.latestHits ?? 0), MAX_LATEST_SESSION_HITS));
}

/**
 * Fold a store's per-hit aggregate rows (columns `narrator_id`, `hit_id`, `hit_block_id`,
 * `hit_created_at`; a narrator's rows contiguous, newest hit first) into one row per narrator
 * with up to `latest` hit refs. `toAggregate` maps a row's narrator-level columns.
 */
export function groupSessionAggregates(
	rows: readonly Record<string, unknown>[],
	latest: number,
	toAggregate: (row: Record<string, unknown>) => SessionAggregateRow,
): SessionAggregateRow[] {
	const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
	const byNarrator = new Map<string, SessionAggregateRow>();
	for (const row of rows) {
		const narratorId = String(row.narrator_id ?? "");
		let aggregate = byNarrator.get(narratorId);
		if (!aggregate) {
			aggregate = { ...toAggregate(row), latestHits: [] };
			byNarrator.set(narratorId, aggregate);
		}
		const id = text(row.hit_id);
		if (id && aggregate.latestHits.length < latest) {
			aggregate.latestHits.push({
				id,
				blockId: text(row.hit_block_id),
				createdAt: text(row.hit_created_at),
			});
		}
	}
	return [...byNarrator.values()];
}
