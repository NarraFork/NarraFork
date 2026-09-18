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
 *   - global search (chapters / messages / narrators) matches the whole query as ONE PHRASE;
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

/** Global search (chapter descriptions, message bodies, narrator titles): unmarked excerpt. */
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
	text: string;
	strategy: SearchStrategy;
	limit: number;
	viewer: SearchViewer;
}

/**
 * Search inside one narrator's own timeline.
 *
 * `inheritedScopes` widens the search across a lazy fork's ancestry. Empty reproduces
 * single-narrator behaviour exactly.
 */
export interface TimelineSearchQuery {
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
	authorUserId: string;
	/** Draft lifecycle status that shadows the committed version. */
	draftStatus: string;
}

/** Which entries one author currently shadows with a draft. */
export interface ShadowedEntryQuery {
	authorUserId: string;
	draftStatus: string;
	limit: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export interface ChapterSearchRow {
	id: string;
	title: string | null;
	description: string | null;
	status: string | null;
	role: string | null;
	projectName: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	snippet: string;
	rank: RelevanceRank;
}

export interface MessageSearchRow {
	id: string;
	narratorId: string | null;
	narratorTitle: string | null;
	chapterId: string | null;
	chapterTitle: string | null;
	projectName: string | null;
	model: string | null;
	messageRole: string | null;
	createdAt: string | null;
	snippet: string;
	/** Leading body text, used when the backend produced no excerpt. */
	preview: string;
	rank: RelevanceRank;
}

export interface NarratorSearchRow {
	id: string;
	title: string | null;
	chapterId: string | null;
	chapterTitle: string | null;
	projectName: string | null;
	status: string | null;
	model: string | null;
	lastMessageAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	snippet: string;
	rank: RelevanceRank;
}

export interface TimelineSearchRow {
	messageId: string;
	/** Position in the narrator's timeline, so a client can jump to the hit. */
	seq: number;
	role: string;
	snippet: string;
	preview: string;
	createdAt: string;
}

export interface RecallMessageRow {
	messageId: string;
	narratorId: string;
	narratorTitle: string | null;
	chapterId: string | null;
	role: string;
	createdAt: string;
	snippet: string;
}

export interface KnowledgeSearchRow {
	id: string;
	collectionId: string;
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
