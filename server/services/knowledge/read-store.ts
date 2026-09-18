/**
 * The knowledge base's READ capability, stated without a dialect.
 *
 * WHY THIS PORT EXISTS
 * --------------------
 * The write port (`write-store.ts`) covers the atomic sections; everything else in the
 * knowledge services used to read through the shared SQLite handle (`db.query.*` and a
 * few raw statements in knowledge-service). That worked while one process meant one
 * database. With the PostgreSQL backend the `db` handle is a fail-closed proxy, so
 * every one of those reads would throw — and worse, a write committed through the PG
 * store followed by a read from SQLite would be a textbook write/read split: the
 * update "succeeded", the read-back answered from the other database.
 *
 * So the reads the knowledge services need are stated here once, in domain terms:
 * what goes in, what comes out, which projections are deliberately narrow. Each
 * operation is a single bounded query (or a fixed small batch of them); there are no
 * transactions on the read side, and no method may branch on which backend is
 * answering — the two implementations differ in dialect, never in semantics.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a generic query executor and not a DAO over every knowledge table. A read that
 * no service needs has no method here; the list below is exactly the read surface of
 * knowledge-service / knowledge-link-service / knowledge-acl / knowledge-notify /
 * knowledge-audit, no wider.
 *
 * PROJECTIONS ARE PART OF THE CONTRACT
 * ------------------------------------
 * Several methods return deliberately narrow rows (the ACL gate fields, the list-view
 * columns, the notify routing scalars). Those projections are load-bearing: they keep
 * `currentContent`-sized blobs off the main thread on list/filter paths. A caller
 * that needs the full row asks for the full-row method; implementations must not
 * silently widen a narrow one.
 */

import type { KnowledgeCollectionRow } from "./write-store";

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (plain data, field-identical across backends)
// ─────────────────────────────────────────────────────────────────────────────

/** The full entry row — the shape `getEntry`-style reads return, content included. */
export interface KnowledgeEntryRow {
	id: string;
	collectionId: string;
	title: string;
	slug: string;
	currentRevisionId: string | null;
	currentContent: string | null;
	currentKeywords: string | null;
	tagsJson: unknown;
	keywordsJson: unknown;
	metadataJson: unknown;
	classificationLevel: string | null;
	controlledTagsJson: unknown;
	reviewTagsJson: unknown;
	ownerUserId: string | null;
	status: string;
	createdAt: string;
	updatedAt: string;
}

/** The dual-axis gate fields of an entry. Never widened: this runs on every
 *  list/search/filter decision, where reading a body blob per candidate is the
 *  failure mode the performance rules forbid. */
export interface KnowledgeEntryAclRow {
	id: string;
	collectionId: string;
	ownerUserId: string | null;
	classificationLevel: string | null;
	controlledTagsJson: unknown;
	reviewTagsJson: unknown;
}

/** The ACL fields plus the two display fields a graph/link endpoint renders. */
export interface KnowledgeEntryGraphRow extends KnowledgeEntryAclRow {
	title: string;
	slug: string;
}

/** The list-view projection: everything a listing renders, never the content blob. */
export interface KnowledgeEntryListRow {
	id: string;
	collectionId: string;
	title: string;
	slug: string;
	currentRevisionId: string | null;
	tagsJson: unknown;
	classificationLevel: string | null;
	controlledTagsJson: unknown;
	reviewTagsJson: unknown;
	ownerUserId: string | null;
	status: string;
	createdAt: string;
	updatedAt: string;
}

/** The collection's dual-axis gate fields (fail-closed inputs to the ACL layer). */
export interface KnowledgeCollectionAclRow {
	id: string;
	defaultLevel: string;
	classificationLevel: string | null;
	controlledTagsJson: unknown;
	ownerUserId: string | null;
}

/** The ACL fields plus the display fields the admin ACL echo-back returns. */
export interface KnowledgeCollectionSummaryRow extends KnowledgeCollectionAclRow {
	name: string;
	slug: string;
}

/** A full revision row, content included (the diff view fetches these one at a time). */
export interface KnowledgeRevisionRow {
	id: string;
	entryId: string;
	version: number;
	format: string;
	content: string;
	contentHash: string;
	changeNote: string | null;
	authorUserId: string | null;
	baseRevisionId: string | null;
	createdAt: string;
}

/** Revision metadata for history lists: the body is projected away, its LENGTH is
 *  computed in SQL so the UI can show sizes without reading N full documents. */
export interface KnowledgeRevisionMetaRow {
	id: string;
	entryId: string;
	version: number;
	format: string;
	contentHash: string;
	changeNote: string | null;
	authorUserId: string | null;
	baseRevisionId: string | null;
	createdAt: string;
	contentLength: number;
}

export interface KnowledgeLevelRow {
	id: string;
	name: string;
	rank: number;
	label: string | null;
	createdAt: string;
}

export interface KnowledgeTagRow {
	id: string;
	collectionId: string | null;
	typeId: string | null;
	name: string;
	controlled: boolean;
	createdAt: string;
}

export interface KnowledgeTagTypeRow {
	id: string;
	name: string;
	builtin: boolean;
	sortOrder: number;
	createdAt: string;
}

export interface KnowledgeEntryLinkRow {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: string;
	label: string | null;
	toRevisionId: string | null;
	createdByUserId: string | null;
	createdAt: string;
}

/** One `acl_grants` row as the knowledge ACL layer consumes it (pre-fold shape —
 *  the knowledge-vocabulary projection stays in `knowledge-acl.ts`). */
export interface AclGrantReadRow {
	id: string;
	scopeType: string;
	scopeId: string | null;
	principalType: string;
	principalId: string;
	capability: string;
	domainKind: string | null;
	domainValue: string | null;
	createdAt: string;
}

/** One `acl_events` row. Read side of the audit trail; writes go through the write
 *  store (`insertAclAuditEvent`) so both sides of the trail follow the same backend. */
export interface AclEventReadRow {
	id: string;
	actorUserId: string | null;
	actorRole: string | null;
	eventType: string;
	subjectType: string | null;
	subjectId: string | null;
	scopeType: string;
	scopeId: string | null;
	outcome: string;
	detailJson: unknown;
	createdAt: string;
}

/** The routing scalars of a submission — deliberately WITHOUT `proposedContent`. */
export interface KnowledgeSubmissionRoutingRow {
	id: string;
	entryId: string | null;
	collectionId: string | null;
	submitterUserId: string;
	status: string;
}

/** One keyword-injection candidate: metadata + keyword JSON, never the body. The
 *  JSON columns arrive already parsed (both drivers decode them); the consumer
 *  filters empty keyword sets. */
export interface KeywordInjectionCandidateRow {
	id: string;
	collectionId: string;
	title: string;
	currentRevisionId: string | null;
	tagsJson: unknown;
	keywordsJson: unknown;
	updatedAt: string;
}

export type LinkListDirection = "out" | "in" | "both";

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeReadStore {
	// ── entries ──
	/** Full row by id, or null. The caller decides whether the content blob is needed. */
	getEntryById(entryId: string): Promise<KnowledgeEntryRow | null>;
	/** The ACL gate fields of one entry, or null. */
	getEntryAclById(entryId: string): Promise<KnowledgeEntryAclRow | null>;
	/** The ACL + display fields of one entry (link/graph endpoint), or null. */
	getEntryGraphById(entryId: string): Promise<KnowledgeEntryGraphRow | null>;
	/** Batch: ACL fields of many entries (the filterReadable projection). */
	getEntriesAclByIds(entryIds: string[]): Promise<KnowledgeEntryAclRow[]>;
	/** Batch: ACL + display fields of many entries (graph traversal preload). */
	getEntriesGraphByIds(entryIds: string[]): Promise<KnowledgeEntryGraphRow[]>;
	/** List-view rows, newest-updated first, bounded by `limit`. */
	listEntries(opts: { collectionId?: string; limit: number }): Promise<KnowledgeEntryListRow[]>;
	/** The slug pre-check before an entry insert. Only the id crosses back. */
	findEntryBySlug(collectionId: string, slug: string): Promise<{ id: string } | null>;

	// ── collections ──
	/** Full row by id, or null. */
	getCollectionById(collectionId: string): Promise<KnowledgeCollectionRow | null>;
	/** The ACL gate fields of one collection, or null. */
	getCollectionAclById(collectionId: string): Promise<KnowledgeCollectionAclRow | null>;
	/** The ACL fields plus name/slug (admin ACL echo-back), or null. */
	getCollectionSummaryById(collectionId: string): Promise<KnowledgeCollectionSummaryRow | null>;
	/** Batch: ACL fields of many collections. */
	getCollectionsAclByIds(collectionIds: string[]): Promise<KnowledgeCollectionAclRow[]>;
	/** All collections (optionally of one project), name-ordered, bounded by `limit`. */
	listCollections(opts: { projectId?: string; limit: number }): Promise<KnowledgeCollectionRow[]>;
	/**
	 * The slug pre-check before a collection insert. `projectId: null` matches by slug
	 * alone (the historical global-collection pre-check; the unique index is
	 * (project_id, slug) and treats NULLs as distinct, so the last line of defence for
	 * the global race is the write store's conflict vocabulary).
	 */
	findCollectionBySlug(opts: {
		projectId: string | null;
		slug: string;
	}): Promise<{ id: string } | null>;
	/** Existence probe for FK-style validation. */
	collectionExists(collectionId: string): Promise<boolean>;

	// ── revisions ──
	/** Full row by id (content included — single-row diff reads), or null. */
	getRevisionById(revisionId: string): Promise<KnowledgeRevisionRow | null>;
	/** The (id, entryId) pair of a revision — the link-pin ownership check. */
	getRevisionEntryId(revisionId: string): Promise<{ id: string; entryId: string } | null>;
	/** History list: metadata only, version-descending, `contentLength` from SQL. */
	listRevisionMeta(entryId: string, limit: number): Promise<KnowledgeRevisionMetaRow[]>;

	// ── users (the knowledge services only ever need identity columns) ──
	userExists(userId: string): Promise<boolean>;
	getUserRoleById(userId: string): Promise<{ id: string; role: string } | null>;
	getUsernameById(userId: string): Promise<{ username: string } | null>;
	/** Bounded user listing for batch cap resolution / role-scoped notify fan-out. */
	listUserIdsAndRoles(opts: {
		role?: string;
		limit?: number;
	}): Promise<{ id: string; role: string }[]>;
	/** Which of the given user ids exist (bulk-grant pre-validation, one query). */
	listExistingUserIds(userIds: string[]): Promise<{ id: string }[]>;
	/** The admin "who can read this entry" population: id + username + role. */
	listUsersDetailed(): Promise<{ id: string; username: string; role: string }[]>;

	// ── levels / tags / tag types (ACL admin reads) ──
	/** Every level, rank-ascending (the rank map and the admin list share this). */
	listKnowledgeLevels(): Promise<KnowledgeLevelRow[]>;
	getKnowledgeLevelById(levelId: string): Promise<KnowledgeLevelRow | null>;
	/** Name uniqueness pre-check; `excludeId` keeps a rename from clashing with itself. */
	findKnowledgeLevelByName(name: string, excludeId?: string): Promise<{ id: string } | null>;
	/** Rank uniqueness pre-check; same self-exclusion rule. */
	findKnowledgeLevelByRank(rank: number, excludeId?: string): Promise<{ id: string } | null>;
	/**
	 * Whether any entry, collection (either axis) or clearance credential still names
	 * this level. Levels are referenced BY NAME, so deleting a referenced one would
	 * fail `rankOf` closed and lock that content to admins — the service refuses on
	 * `true`.
	 */
	knowledgeLevelInUse(levelName: string): Promise<boolean>;
	listKnowledgeTags(collectionId?: string): Promise<KnowledgeTagRow[]>;
	getKnowledgeTagById(tagId: string): Promise<KnowledgeTagRow | null>;
	listKnowledgeTagTypes(): Promise<KnowledgeTagTypeRow[]>;
	getKnowledgeTagTypeById(tagTypeId: string): Promise<KnowledgeTagTypeRow | null>;

	// ── grants (read side of the unified `acl_grants` table) ──
	/**
	 * Every KNOWLEDGE-scoped grant row (`global` + `knowledge_collection` scopes —
	 * project/narrator memberships of the same principal are other scopes and never
	 * returned), optionally narrowed to any of the given principals (OR-ed). The
	 * knowledge-vocabulary folding stays in the service.
	 */
	listKnowledgeAclGrantRows(opts?: {
		principals?: { principalType: string; principalId: string }[];
	}): Promise<AclGrantReadRow[]>;
	getAclGrantById(grantId: string): Promise<AclGrantReadRow | null>;

	// ── entry links ──
	findEntryLink(input: {
		fromEntryId: string;
		toEntryId: string;
		linkType: string;
	}): Promise<KnowledgeEntryLinkRow | null>;
	getEntryLinkById(linkId: string): Promise<KnowledgeEntryLinkRow | null>;
	/** Links touching one entry, newest first. */
	listEntryLinks(entryId: string, direction: LinkListDirection): Promise<KnowledgeEntryLinkRow[]>;
	/** One graph-traversal hop: every link whose either endpoint is in `entryIds`,
	 *  bounded by `limit` (the per-hop fan-out cap). */
	listEntryLinksTouching(entryIds: string[], limit: number): Promise<KnowledgeEntryLinkRow[]>;

	// ── notification routing ──
	/** The routing scalars of a submission (never the proposed content), or null. */
	getSubmissionRoutingById(submissionId: string): Promise<KnowledgeSubmissionRoutingRow | null>;
	/** Authors holding an ACTIVE draft pinned to a base revision of this entry —
	 *  the drift-notification population, bounded by `limit`. */
	listActiveDraftHolderIds(entryId: string, limit: number): Promise<{ authorUserId: string }[]>;

	// ── audit read ──
	/**
	 * Knowledge-scoped audit rows, newest first, keyset-paginated on
	 * `(createdAt, id)`: `cursor` names the last row of the previous page and only
	 * strictly-older rows come back. The caller passes `limit + 1` and detects
	 * "there is more" itself. Only `knowledge%` scopes are read — this is the
	 * knowledge audit view, and leaking other domains' events into it would be a
	 * disclosure, not a feature.
	 */
	listKnowledgeAclEventRows(opts: {
		limit: number;
		eventType?: string;
		subjectId?: string;
		scopeId?: string;
		actorUserId?: string;
		cursor?: { createdAt: string; id: string };
	}): Promise<AclEventReadRow[]>;

	// ── passive keyword injection ──
	/**
	 * Active entries that carry keywords: the injection candidate scan. Metadata and
	 * keyword JSON only — never the body — ordered newest-updated first and bounded
	 * by `limit`. `projectId` narrows to that project's collections plus global ones.
	 */
	listKeywordInjectionCandidates(opts: {
		collectionId?: string;
		projectId?: string;
		limit: number;
	}): Promise<KeywordInjectionCandidateRow[]>;
	/**
	 * The change-detection signature of the same candidate set (`count:maxUpdatedAt`
	 * from one indexed aggregate), so callers can reuse a compiled matcher until the
	 * set actually changes.
	 */
	keywordInjectionCandidatesSignature(opts: {
		collectionId?: string;
		projectId?: string;
	}): Promise<string>;
	/** Bounded body prefixes for the final injected hits only. */
	snippetsByEntryIds(
		entryIds: string[],
		maxChars: number,
	): Promise<{ id: string; snippet: string | null }[]>;
	/** Entries already injected for (narrator, compactSeq) — the dedupe read. */
	listInjectedEntryIds(narratorId: string, compactSeq: number): Promise<string[]>;
}
