/**
 * SQLite implementation of `KnowledgeReadStore`.
 *
 * These are the queries the knowledge services always ran, moved behind the port
 * verbatim: same projections (the narrow ones stay narrow — the ACL/list/notify
 * shapes exist to keep content blobs off the main thread), same orderings, same
 * limits. The PostgreSQL implementation of the same port lives in
 * `postgres-read-store.ts`; what the two share is the SECTION CONTENT — the same
 * rows in the same order — never the driver shapes.
 *
 * Two translation notes for readers comparing against the pre-port code:
 *
 *   - The keyword-injection reads used to be raw `sqlite.prepare(...)` statements.
 *     They are Drizzle queries here because everything they used is portable
 *     (`substr`, `count`, `max`, `coalesce`, a `project_id` subselect), and dropping
 *     the raw handle is what removes this surface from the dialect ledger.
 *   - JSON columns (`tags_json`, `keywords_json`, `controlled_tags_json`, …) arrive
 *     PARSED (the schema's json mode), which the port's `unknown` row fields state
 *     explicitly; the raw statements used to return strings the service parsed.
 */
import { and, desc, eq, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
	aclEvents,
	aclGrants,
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeEntryLinks,
	knowledgeInjectionEvents,
	knowledgeLevels,
	knowledgeRevisions,
	knowledgeSubmissions,
	knowledgeTags,
	knowledgeTagTypes,
	users,
} from "../../db/schema";
import type {
	AclEventReadRow,
	KeywordInjectionCandidateRow,
	KnowledgeEntryLinkRow,
	KnowledgeEntryListRow,
	KnowledgeEntryRow,
	KnowledgeReadStore,
	KnowledgeRevisionRow,
	KnowledgeSubmissionRoutingRow,
} from "./read-store";
import type { KnowledgeCollectionRow } from "./write-store";

const ENTRY_ACL_COLUMNS = {
	id: true,
	collectionId: true,
	ownerUserId: true,
	classificationLevel: true,
	controlledTagsJson: true,
	reviewTagsJson: true,
} as const;

const ENTRY_GRAPH_COLUMNS = {
	...ENTRY_ACL_COLUMNS,
	title: true,
	slug: true,
} as const;

const ENTRY_LIST_COLUMNS = {
	id: true,
	collectionId: true,
	title: true,
	slug: true,
	currentRevisionId: true,
	tagsJson: true,
	classificationLevel: true,
	controlledTagsJson: true,
	reviewTagsJson: true,
	ownerUserId: true,
	status: true,
	createdAt: true,
	updatedAt: true,
} as const;

const COLLECTION_ACL_COLUMNS = {
	id: true,
	defaultLevel: true,
	classificationLevel: true,
	controlledTagsJson: true,
	ownerUserId: true,
} as const;

const COLLECTION_SUMMARY_COLUMNS = {
	...COLLECTION_ACL_COLUMNS,
	name: true,
	slug: true,
} as const;

const GRANT_COLUMNS = {
	id: true,
	scopeType: true,
	scopeId: true,
	principalType: true,
	principalId: true,
	capability: true,
	domainKind: true,
	domainValue: true,
	createdAt: true,
} as const;

/** Knowledge-scoped grant rows: the two scopes the knowledge ACL lives in. */
function knowledgeGrantScopeWhere() {
	return or(eq(aclGrants.scopeType, "global"), eq(aclGrants.scopeType, "knowledge_collection"));
}

/** The project scope clause shared by the two keyword-injection reads: entries in
 *  this project's collections plus global (project_id IS NULL) ones. */
function projectScopeClause(projectId: string | undefined) {
	if (!projectId) return undefined;
	return inArray(
		knowledgeEntries.collectionId,
		db
			.select({ id: knowledgeCollections.id })
			.from(knowledgeCollections)
			.where(
				or(eq(knowledgeCollections.projectId, projectId), isNull(knowledgeCollections.projectId)),
			),
	);
}

// Compatibility for callers whose contract is still synchronous. These methods are
// reachable only through the binding's explicit SQLite capability check.
export const sqliteKnowledgeInjectionReads = {
	listKeywordInjectionCandidates(opts: {
		collectionId?: string;
		projectId?: string;
		limit: number;
	}) {
		return db
			.select({
				id: knowledgeEntries.id,
				collectionId: knowledgeEntries.collectionId,
				title: knowledgeEntries.title,
				currentRevisionId: knowledgeEntries.currentRevisionId,
				tagsJson: knowledgeEntries.tagsJson,
				keywordsJson: knowledgeEntries.keywordsJson,
				updatedAt: knowledgeEntries.updatedAt,
			})
			.from(knowledgeEntries)
			.where(
				and(
					eq(knowledgeEntries.status, "active"),
					isNotNull(knowledgeEntries.currentKeywords),
					opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
					projectScopeClause(opts.projectId),
				),
			)
			.orderBy(desc(knowledgeEntries.updatedAt))
			.limit(opts.limit)
			.all();
	},
	keywordInjectionCandidatesSignature(opts: { collectionId?: string; projectId?: string }) {
		const row = db
			.select({
				cnt: sql<number>`count(*)`,
				maxUpdated: sql<string>`coalesce(max(${knowledgeEntries.updatedAt}), '')`,
			})
			.from(knowledgeEntries)
			.where(
				and(
					eq(knowledgeEntries.status, "active"),
					isNotNull(knowledgeEntries.currentKeywords),
					opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
					projectScopeClause(opts.projectId),
				),
			)
			.get();
		return `${Number(row?.cnt ?? 0)}:${row?.maxUpdated ?? ""}`;
	},
	snippetsByEntryIds(ids: string[], maxChars: number) {
		if (!ids.length) return [];
		return db
			.select({
				id: knowledgeEntries.id,
				snippet: sql<
					string | null
				>`substr(coalesce(${knowledgeEntries.currentContent}, ${knowledgeEntries.title}), 1, ${maxChars})`,
			})
			.from(knowledgeEntries)
			.where(inArray(knowledgeEntries.id, ids))
			.all();
	},
	listInjectedEntryIds(narratorId: string, compactSeq: number) {
		return db
			.select({ entryId: knowledgeInjectionEvents.entryId })
			.from(knowledgeInjectionEvents)
			.where(
				and(
					eq(knowledgeInjectionEvents.narratorId, narratorId),
					eq(knowledgeInjectionEvents.compactSeq, compactSeq),
				),
			)
			.all()
			.map((row) => row.entryId);
	},
};

export const sqliteKnowledgeReadStore: KnowledgeReadStore = {
	async getEntryById(entryId) {
		const row = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
		});
		return (row as KnowledgeEntryRow | undefined) ?? null;
	},

	async getEntryAclById(entryId) {
		const row = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
			columns: ENTRY_ACL_COLUMNS,
		});
		return row ?? null;
	},

	async getEntryGraphById(entryId) {
		const row = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
			columns: ENTRY_GRAPH_COLUMNS,
		});
		return row ?? null;
	},

	async getEntriesAclByIds(entryIds) {
		if (entryIds.length === 0) return [];
		return db.query.knowledgeEntries.findMany({
			where: inArray(knowledgeEntries.id, entryIds),
			columns: ENTRY_ACL_COLUMNS,
		});
	},

	async getEntriesGraphByIds(entryIds) {
		if (entryIds.length === 0) return [];
		return db.query.knowledgeEntries.findMany({
			where: inArray(knowledgeEntries.id, entryIds),
			columns: ENTRY_GRAPH_COLUMNS,
		});
	},

	async listEntries(opts) {
		return db.query.knowledgeEntries.findMany({
			where: opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
			columns: ENTRY_LIST_COLUMNS,
			orderBy: (e, { desc: d }) => [d(e.updatedAt)],
			limit: opts.limit,
		}) as Promise<KnowledgeEntryListRow[]>;
	},

	async findEntryBySlug(collectionId, slug) {
		const row = await db.query.knowledgeEntries.findFirst({
			where: and(eq(knowledgeEntries.collectionId, collectionId), eq(knowledgeEntries.slug, slug)),
			columns: { id: true },
		});
		return row ?? null;
	},

	async getCollectionById(collectionId) {
		const row = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, collectionId),
		});
		return (row as KnowledgeCollectionRow | undefined) ?? null;
	},

	async getCollectionAclById(collectionId) {
		const row = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, collectionId),
			columns: COLLECTION_ACL_COLUMNS,
		});
		return row ?? null;
	},

	async getCollectionSummaryById(collectionId) {
		const row = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, collectionId),
			columns: COLLECTION_SUMMARY_COLUMNS,
		});
		return row ?? null;
	},

	async getCollectionsAclByIds(collectionIds) {
		if (collectionIds.length === 0) return [];
		return db.query.knowledgeCollections.findMany({
			where: inArray(knowledgeCollections.id, collectionIds),
			columns: COLLECTION_ACL_COLUMNS,
		});
	},

	async listCollections(opts) {
		return db.query.knowledgeCollections.findMany({
			where: opts.projectId ? eq(knowledgeCollections.projectId, opts.projectId) : undefined,
			orderBy: (c, { asc: a }) => [a(c.name)],
			limit: opts.limit,
		}) as Promise<KnowledgeCollectionRow[]>;
	},

	async findCollectionBySlug(opts) {
		const row = await db.query.knowledgeCollections.findFirst({
			where: opts.projectId
				? and(
						eq(knowledgeCollections.projectId, opts.projectId),
						eq(knowledgeCollections.slug, opts.slug),
					)
				: eq(knowledgeCollections.slug, opts.slug),
			columns: { id: true },
		});
		return row ?? null;
	},

	async collectionExists(collectionId) {
		const row = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, collectionId),
			columns: { id: true },
		});
		return row !== undefined;
	},

	async getRevisionById(revisionId) {
		const row = await db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, revisionId),
		});
		return (row as KnowledgeRevisionRow | undefined) ?? null;
	},

	async getRevisionEntryId(revisionId) {
		const row = await db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, revisionId),
			columns: { id: true, entryId: true },
		});
		return row ?? null;
	},

	async listRevisionMeta(entryId, limit) {
		const rows = await db
			.select({
				id: knowledgeRevisions.id,
				entryId: knowledgeRevisions.entryId,
				version: knowledgeRevisions.version,
				format: knowledgeRevisions.format,
				contentHash: knowledgeRevisions.contentHash,
				changeNote: knowledgeRevisions.changeNote,
				authorUserId: knowledgeRevisions.authorUserId,
				baseRevisionId: knowledgeRevisions.baseRevisionId,
				createdAt: knowledgeRevisions.createdAt,
				contentLength: sql<number>`length(${knowledgeRevisions.content})`,
			})
			.from(knowledgeRevisions)
			.where(eq(knowledgeRevisions.entryId, entryId))
			.orderBy(desc(knowledgeRevisions.version))
			.limit(limit);
		return rows.map((row) => ({ ...row, contentLength: Number(row.contentLength) }));
	},

	async userExists(userId) {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true },
		});
		return row !== undefined;
	},

	async getUserRoleById(userId) {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, role: true },
		});
		return row ?? null;
	},

	async getUsernameById(userId) {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { username: true },
		});
		return row ?? null;
	},

	async listUserIdsAndRoles(opts) {
		return db.query.users.findMany({
			where: opts.role ? eq(users.role, opts.role as "admin" | "user") : undefined,
			columns: { id: true, role: true },
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
		});
	},

	async listExistingUserIds(userIds) {
		if (userIds.length === 0) return [];
		return db.query.users.findMany({
			where: inArray(users.id, userIds),
			columns: { id: true },
		});
	},

	async listUsersDetailed() {
		return db.query.users.findMany({
			columns: { id: true, username: true, role: true },
		});
	},

	async listKnowledgeLevels() {
		return db.query.knowledgeLevels.findMany({ orderBy: (l, { asc: a }) => [a(l.rank)] });
	},

	async getKnowledgeLevelById(levelId) {
		const row = await db.query.knowledgeLevels.findFirst({
			where: eq(knowledgeLevels.id, levelId),
		});
		return row ?? null;
	},

	async findKnowledgeLevelByName(name, excludeId) {
		const row = await db.query.knowledgeLevels.findFirst({
			where: excludeId
				? and(eq(knowledgeLevels.name, name), ne(knowledgeLevels.id, excludeId))
				: eq(knowledgeLevels.name, name),
			columns: { id: true },
		});
		return row ?? null;
	},

	async findKnowledgeLevelByRank(rank, excludeId) {
		const row = await db.query.knowledgeLevels.findFirst({
			where: excludeId
				? and(eq(knowledgeLevels.rank, rank), ne(knowledgeLevels.id, excludeId))
				: eq(knowledgeLevels.rank, rank),
			columns: { id: true },
		});
		return row ?? null;
	},

	async knowledgeLevelInUse(levelName) {
		// Levels are referenced BY NAME from entries, collections (both axes) and
		// clearance credentials — the same four probes the delete guard always ran.
		const [entryRef, collectionDefaultRef, collectionClassRef, grantRef] = await Promise.all([
			db.query.knowledgeEntries.findFirst({
				where: eq(knowledgeEntries.classificationLevel, levelName),
				columns: { id: true },
			}),
			db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.defaultLevel, levelName),
				columns: { id: true },
			}),
			db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.classificationLevel, levelName),
				columns: { id: true },
			}),
			db.query.aclGrants.findFirst({
				where: and(eq(aclGrants.domainKind, "clearance"), eq(aclGrants.domainValue, levelName)),
				columns: { id: true },
			}),
		]);
		return Boolean(entryRef || collectionDefaultRef || collectionClassRef || grantRef);
	},

	async listKnowledgeTags(collectionId) {
		if (collectionId) {
			return db.query.knowledgeTags.findMany({
				where: eq(knowledgeTags.collectionId, collectionId),
			});
		}
		return db.query.knowledgeTags.findMany();
	},

	async getKnowledgeTagById(tagId) {
		const row = await db.query.knowledgeTags.findFirst({
			where: eq(knowledgeTags.id, tagId),
		});
		return row ?? null;
	},

	async listKnowledgeTagTypes() {
		return db.query.knowledgeTagTypes.findMany({
			orderBy: (tt, { asc: a }) => [a(tt.sortOrder), a(tt.createdAt)],
		});
	},

	async getKnowledgeTagTypeById(tagTypeId) {
		const row = await db.query.knowledgeTagTypes.findFirst({
			where: eq(knowledgeTagTypes.id, tagTypeId),
		});
		return row ?? null;
	},

	async listKnowledgeAclGrantRows(opts) {
		const principals = opts?.principals;
		const principalClause =
			principals && principals.length > 0
				? or(
						...principals.map((p) =>
							and(
								eq(aclGrants.principalType, p.principalType as "user" | "role"),
								eq(aclGrants.principalId, p.principalId),
							),
						),
					)
				: undefined;
		return db.query.aclGrants.findMany({
			columns: GRANT_COLUMNS,
			where: and(knowledgeGrantScopeWhere(), principalClause),
		});
	},

	async getAclGrantById(grantId) {
		const row = await db.query.aclGrants.findFirst({
			columns: GRANT_COLUMNS,
			where: eq(aclGrants.id, grantId),
		});
		return row ?? null;
	},

	async findEntryLink(input) {
		const row = await db.query.knowledgeEntryLinks.findFirst({
			where: and(
				eq(knowledgeEntryLinks.fromEntryId, input.fromEntryId),
				eq(knowledgeEntryLinks.toEntryId, input.toEntryId),
				eq(knowledgeEntryLinks.linkType, input.linkType as never),
			),
		});
		return (row as KnowledgeEntryLinkRow | undefined) ?? null;
	},

	async getEntryLinkById(linkId) {
		const row = await db.query.knowledgeEntryLinks.findFirst({
			where: eq(knowledgeEntryLinks.id, linkId),
		});
		return (row as KnowledgeEntryLinkRow | undefined) ?? null;
	},

	async listEntryLinks(entryId, direction) {
		const rows = await db.query.knowledgeEntryLinks.findMany({
			where:
				direction === "out"
					? eq(knowledgeEntryLinks.fromEntryId, entryId)
					: direction === "in"
						? eq(knowledgeEntryLinks.toEntryId, entryId)
						: or(
								eq(knowledgeEntryLinks.fromEntryId, entryId),
								eq(knowledgeEntryLinks.toEntryId, entryId),
							),
			orderBy: (l, { desc: d }) => [d(l.createdAt)],
		});
		return rows as KnowledgeEntryLinkRow[];
	},

	async listEntryLinksTouching(entryIds, limit) {
		if (entryIds.length === 0) return [];
		const rows = await db.query.knowledgeEntryLinks.findMany({
			where: or(
				inArray(knowledgeEntryLinks.fromEntryId, entryIds),
				inArray(knowledgeEntryLinks.toEntryId, entryIds),
			),
			limit,
		});
		return rows as KnowledgeEntryLinkRow[];
	},

	async getSubmissionRoutingById(submissionId) {
		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
			columns: {
				id: true,
				entryId: true,
				collectionId: true,
				submitterUserId: true,
				status: true,
			},
		});
		return (row as KnowledgeSubmissionRoutingRow | undefined) ?? null;
	},

	async listActiveDraftHolderIds(entryId, limit) {
		return db.query.knowledgeDrafts.findMany({
			where: and(
				eq(knowledgeDrafts.entryId, entryId),
				inArray(knowledgeDrafts.status, ["active"]),
				isNotNull(knowledgeDrafts.baseRevisionId),
			),
			columns: { authorUserId: true },
			limit,
		});
	},

	async listKnowledgeAclEventRows(opts) {
		const conds = [like(aclEvents.scopeType, "knowledge%")];
		if (opts.eventType) conds.push(eq(aclEvents.eventType, opts.eventType));
		if (opts.subjectId) conds.push(eq(aclEvents.subjectId, opts.subjectId));
		if (opts.scopeId) conds.push(eq(aclEvents.scopeId, opts.scopeId));
		if (opts.actorUserId) conds.push(eq(aclEvents.actorUserId, opts.actorUserId));
		if (opts.cursor) {
			// Strictly "older than the cursor": either an earlier timestamp, or the same
			// timestamp with a smaller id (the tie-breaker that makes the order total).
			conds.push(
				or(
					lt(aclEvents.createdAt, opts.cursor.createdAt),
					and(eq(aclEvents.createdAt, opts.cursor.createdAt), lt(aclEvents.id, opts.cursor.id)),
				) as never,
			);
		}
		const rows = await db.query.aclEvents.findMany({
			where: and(...conds),
			orderBy: (e, { desc: d }) => [d(e.createdAt), d(e.id)],
			limit: opts.limit,
		});
		return rows as AclEventReadRow[];
	},

	async listKeywordInjectionCandidates(opts) {
		const rows = await db
			.select({
				id: knowledgeEntries.id,
				collectionId: knowledgeEntries.collectionId,
				title: knowledgeEntries.title,
				currentRevisionId: knowledgeEntries.currentRevisionId,
				tagsJson: knowledgeEntries.tagsJson,
				keywordsJson: knowledgeEntries.keywordsJson,
				updatedAt: knowledgeEntries.updatedAt,
			})
			.from(knowledgeEntries)
			.where(
				and(
					eq(knowledgeEntries.status, "active"),
					isNotNull(knowledgeEntries.currentKeywords),
					opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
					projectScopeClause(opts.projectId),
				),
			)
			.orderBy(desc(knowledgeEntries.updatedAt))
			.limit(opts.limit);
		return rows as KeywordInjectionCandidateRow[];
	},

	async keywordInjectionCandidatesSignature(opts) {
		const rows = await db
			.select({
				cnt: sql<number>`count(*)`,
				maxUpdated: sql<string>`coalesce(max(${knowledgeEntries.updatedAt}), '')`,
			})
			.from(knowledgeEntries)
			.where(
				and(
					eq(knowledgeEntries.status, "active"),
					isNotNull(knowledgeEntries.currentKeywords),
					opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
					projectScopeClause(opts.projectId),
				),
			);
		const row = rows[0];
		return `${Number(row?.cnt ?? 0)}:${row?.maxUpdated ?? ""}`;
	},

	async snippetsByEntryIds(entryIds, maxChars) {
		if (entryIds.length === 0) return [];
		return db
			.select({
				id: knowledgeEntries.id,
				snippet: sql<
					string | null
				>`substr(coalesce(${knowledgeEntries.currentContent}, ${knowledgeEntries.title}), 1, ${maxChars})`,
			})
			.from(knowledgeEntries)
			.where(inArray(knowledgeEntries.id, entryIds));
	},

	async listInjectedEntryIds(narratorId, compactSeq) {
		const rows = await db
			.select({ entryId: knowledgeInjectionEvents.entryId })
			.from(knowledgeInjectionEvents)
			.where(
				and(
					eq(knowledgeInjectionEvents.narratorId, narratorId),
					eq(knowledgeInjectionEvents.compactSeq, compactSeq),
				),
			);
		return rows.map((row) => row.entryId);
	},
};
