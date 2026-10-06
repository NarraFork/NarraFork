/**
 * PostgreSQL implementation of `KnowledgeReadStore`.
 *
 * Same read surface as `sqlite-read-store.ts`, different engine — and deliberately
 * not the same code: what the two implementations share is the port
 * (`read-store.ts`) and the SECTION CONTENT (same projections, orderings and
 * limits), never the driver shapes. The handle here is the injected
 * `BunSQLDatabase` from the composition seam; this module opens no connection and
 * imports nothing from the SQLite side.
 *
 * Dialect notes:
 *   - Reads are plain bounded queries, so no `withPgRetry` wrapping: the retry unit
 *     is the atomic WRITE section (see `pg-retry.ts`); a failed read is simply
 *     re-issued by the caller's own retry policy if it has one.
 *   - `count(*)` is BIGINT in PostgreSQL and arrives as a string/BigInt depending on
 *     the driver; the signature query casts to `::int` and the mapping still runs
 *     through `Number(...)`, matching the SQLite string shape exactly.
 *   - The relational-query API (`db.query.*`) does not exist on a schemaless
 *     `BunSQLDatabase`; every read is `select().from().where()` over the PG schema.
 */

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
} from "@server/db/postgres-schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type {
	AclEventReadRow,
	AclGrantReadRow,
	KeywordInjectionCandidateRow,
	KnowledgeCollectionAclRow,
	KnowledgeCollectionSummaryRow,
	KnowledgeEntryAclRow,
	KnowledgeEntryGraphRow,
	KnowledgeEntryLinkRow,
	KnowledgeEntryListRow,
	KnowledgeEntryRow,
	KnowledgeLevelRow,
	KnowledgeReadStore,
	KnowledgeRevisionRow,
	KnowledgeSubmissionRoutingRow,
	KnowledgeTagRow,
	KnowledgeTagTypeRow,
} from "./read-store";
import type { KnowledgeCollectionRow } from "./write-store";

type PgDb = BunSQLDatabase;

const ENTRY_ACL_SELECT = {
	id: knowledgeEntries.id,
	collectionId: knowledgeEntries.collectionId,
	ownerUserId: knowledgeEntries.ownerUserId,
	classificationLevel: knowledgeEntries.classificationLevel,
	controlledTagsJson: knowledgeEntries.controlledTagsJson,
	reviewTagsJson: knowledgeEntries.reviewTagsJson,
} as const;

const ENTRY_GRAPH_SELECT = {
	...ENTRY_ACL_SELECT,
	title: knowledgeEntries.title,
	slug: knowledgeEntries.slug,
} as const;

const ENTRY_LIST_SELECT = {
	id: knowledgeEntries.id,
	collectionId: knowledgeEntries.collectionId,
	title: knowledgeEntries.title,
	slug: knowledgeEntries.slug,
	currentRevisionId: knowledgeEntries.currentRevisionId,
	tagsJson: knowledgeEntries.tagsJson,
	classificationLevel: knowledgeEntries.classificationLevel,
	controlledTagsJson: knowledgeEntries.controlledTagsJson,
	reviewTagsJson: knowledgeEntries.reviewTagsJson,
	ownerUserId: knowledgeEntries.ownerUserId,
	status: knowledgeEntries.status,
	createdAt: knowledgeEntries.createdAt,
	updatedAt: knowledgeEntries.updatedAt,
} as const;

const COLLECTION_ACL_SELECT = {
	id: knowledgeCollections.id,
	defaultLevel: knowledgeCollections.defaultLevel,
	classificationLevel: knowledgeCollections.classificationLevel,
	controlledTagsJson: knowledgeCollections.controlledTagsJson,
	ownerUserId: knowledgeCollections.ownerUserId,
} as const;

const COLLECTION_SUMMARY_SELECT = {
	...COLLECTION_ACL_SELECT,
	name: knowledgeCollections.name,
	slug: knowledgeCollections.slug,
} as const;

const GRANT_SELECT = {
	id: aclGrants.id,
	scopeType: aclGrants.scopeType,
	scopeId: aclGrants.scopeId,
	principalType: aclGrants.principalType,
	principalId: aclGrants.principalId,
	capability: aclGrants.capability,
	domainKind: aclGrants.domainKind,
	domainValue: aclGrants.domainValue,
	createdAt: aclGrants.createdAt,
} as const;

export function createPostgresKnowledgeReadStore(db: PgDb): KnowledgeReadStore {
	/** Knowledge-scoped grant rows: the two scopes the knowledge ACL lives in. */
	const knowledgeGrantScopeWhere = () =>
		or(eq(aclGrants.scopeType, "global"), eq(aclGrants.scopeType, "knowledge_collection"));

	/** The project scope clause shared by the two keyword-injection reads. */
	const projectScopeClause = (projectId: string | undefined) => {
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
	};

	return {
		async getEntryById(entryId) {
			const rows = await db
				.select()
				.from(knowledgeEntries)
				.where(eq(knowledgeEntries.id, entryId))
				.limit(1);
			return (rows[0] as KnowledgeEntryRow | undefined) ?? null;
		},

		async getEntryAclById(entryId) {
			const rows = await db
				.select(ENTRY_ACL_SELECT)
				.from(knowledgeEntries)
				.where(eq(knowledgeEntries.id, entryId))
				.limit(1);
			return (rows[0] as KnowledgeEntryAclRow | undefined) ?? null;
		},

		async getEntryGraphById(entryId) {
			const rows = await db
				.select(ENTRY_GRAPH_SELECT)
				.from(knowledgeEntries)
				.where(eq(knowledgeEntries.id, entryId))
				.limit(1);
			return (rows[0] as KnowledgeEntryGraphRow | undefined) ?? null;
		},

		async getEntriesAclByIds(entryIds) {
			if (entryIds.length === 0) return [];
			const rows = await db
				.select(ENTRY_ACL_SELECT)
				.from(knowledgeEntries)
				.where(inArray(knowledgeEntries.id, entryIds));
			return rows as KnowledgeEntryAclRow[];
		},

		async getEntriesGraphByIds(entryIds) {
			if (entryIds.length === 0) return [];
			const rows = await db
				.select(ENTRY_GRAPH_SELECT)
				.from(knowledgeEntries)
				.where(inArray(knowledgeEntries.id, entryIds));
			return rows as KnowledgeEntryGraphRow[];
		},

		async listEntries(opts) {
			const rows = await db
				.select(ENTRY_LIST_SELECT)
				.from(knowledgeEntries)
				.where(opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined)
				.orderBy(desc(knowledgeEntries.updatedAt))
				.limit(opts.limit);
			return rows as KnowledgeEntryListRow[];
		},

		async findEntryBySlug(collectionId, slug) {
			const rows = await db
				.select({ id: knowledgeEntries.id })
				.from(knowledgeEntries)
				.where(
					and(eq(knowledgeEntries.collectionId, collectionId), eq(knowledgeEntries.slug, slug)),
				)
				.limit(1);
			return rows[0] ?? null;
		},

		async getCollectionById(collectionId) {
			const rows = await db
				.select()
				.from(knowledgeCollections)
				.where(eq(knowledgeCollections.id, collectionId))
				.limit(1);
			return (rows[0] as KnowledgeCollectionRow | undefined) ?? null;
		},

		async getCollectionAclById(collectionId) {
			const rows = await db
				.select(COLLECTION_ACL_SELECT)
				.from(knowledgeCollections)
				.where(eq(knowledgeCollections.id, collectionId))
				.limit(1);
			return (rows[0] as KnowledgeCollectionAclRow | undefined) ?? null;
		},

		async getCollectionSummaryById(collectionId) {
			const rows = await db
				.select(COLLECTION_SUMMARY_SELECT)
				.from(knowledgeCollections)
				.where(eq(knowledgeCollections.id, collectionId))
				.limit(1);
			return (rows[0] as KnowledgeCollectionSummaryRow | undefined) ?? null;
		},

		async getCollectionsAclByIds(collectionIds) {
			if (collectionIds.length === 0) return [];
			const rows = await db
				.select(COLLECTION_ACL_SELECT)
				.from(knowledgeCollections)
				.where(inArray(knowledgeCollections.id, collectionIds));
			return rows as KnowledgeCollectionAclRow[];
		},

		async listCollections(opts) {
			const rows = await db
				.select()
				.from(knowledgeCollections)
				.where(opts.projectId ? eq(knowledgeCollections.projectId, opts.projectId) : undefined)
				.orderBy(asc(knowledgeCollections.name))
				.limit(opts.limit);
			return rows as KnowledgeCollectionRow[];
		},

		async findCollectionBySlug(opts) {
			const rows = await db
				.select({ id: knowledgeCollections.id })
				.from(knowledgeCollections)
				.where(
					opts.projectId
						? and(
								eq(knowledgeCollections.projectId, opts.projectId),
								eq(knowledgeCollections.slug, opts.slug),
							)
						: eq(knowledgeCollections.slug, opts.slug),
				)
				.limit(1);
			return rows[0] ?? null;
		},

		async collectionExists(collectionId) {
			const rows = await db
				.select({ id: knowledgeCollections.id })
				.from(knowledgeCollections)
				.where(eq(knowledgeCollections.id, collectionId))
				.limit(1);
			return rows.length > 0;
		},

		async getRevisionById(revisionId) {
			const rows = await db
				.select()
				.from(knowledgeRevisions)
				.where(eq(knowledgeRevisions.id, revisionId))
				.limit(1);
			return (rows[0] as KnowledgeRevisionRow | undefined) ?? null;
		},

		async getRevisionEntryId(revisionId) {
			const rows = await db
				.select({ id: knowledgeRevisions.id, entryId: knowledgeRevisions.entryId })
				.from(knowledgeRevisions)
				.where(eq(knowledgeRevisions.id, revisionId))
				.limit(1);
			return rows[0] ?? null;
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
			const rows = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			return rows.length > 0;
		},

		async getUserRoleById(userId) {
			const rows = await db
				.select({ id: users.id, role: users.role })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			return rows[0] ?? null;
		},

		async getUsernameById(userId) {
			const rows = await db
				.select({ username: users.username })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			return rows[0] ?? null;
		},

		async listUserIdsAndRoles(opts) {
			const base = db
				.select({ id: users.id, role: users.role })
				.from(users)
				.where(opts.role ? eq(users.role, opts.role) : undefined);
			const rows = await (opts.limit !== undefined ? base.limit(opts.limit) : base);
			return rows;
		},

		async listExistingUserIds(userIds) {
			if (userIds.length === 0) return [];
			return db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
		},

		async listUsersDetailed() {
			return db.select({ id: users.id, username: users.username, role: users.role }).from(users);
		},

		async listKnowledgeLevels() {
			const rows = await db.select().from(knowledgeLevels).orderBy(asc(knowledgeLevels.rank));
			return rows as KnowledgeLevelRow[];
		},

		async getKnowledgeLevelById(levelId) {
			const rows = await db
				.select()
				.from(knowledgeLevels)
				.where(eq(knowledgeLevels.id, levelId))
				.limit(1);
			return (rows[0] as KnowledgeLevelRow | undefined) ?? null;
		},

		async findKnowledgeLevelByName(name, excludeId) {
			const rows = await db
				.select({ id: knowledgeLevels.id })
				.from(knowledgeLevels)
				.where(
					excludeId
						? and(eq(knowledgeLevels.name, name), ne(knowledgeLevels.id, excludeId))
						: eq(knowledgeLevels.name, name),
				)
				.limit(1);
			return rows[0] ?? null;
		},

		async findKnowledgeLevelByRank(rank, excludeId) {
			const rows = await db
				.select({ id: knowledgeLevels.id })
				.from(knowledgeLevels)
				.where(
					excludeId
						? and(eq(knowledgeLevels.rank, rank), ne(knowledgeLevels.id, excludeId))
						: eq(knowledgeLevels.rank, rank),
				)
				.limit(1);
			return rows[0] ?? null;
		},

		async knowledgeLevelInUse(levelName) {
			// Levels are referenced BY NAME from entries, collections (both axes) and
			// clearance credentials — the same four probes the delete guard always ran.
			const [entryRef, collectionDefaultRef, collectionClassRef, grantRef] = await Promise.all([
				db
					.select({ id: knowledgeEntries.id })
					.from(knowledgeEntries)
					.where(eq(knowledgeEntries.classificationLevel, levelName))
					.limit(1),
				db
					.select({ id: knowledgeCollections.id })
					.from(knowledgeCollections)
					.where(eq(knowledgeCollections.defaultLevel, levelName))
					.limit(1),
				db
					.select({ id: knowledgeCollections.id })
					.from(knowledgeCollections)
					.where(eq(knowledgeCollections.classificationLevel, levelName))
					.limit(1),
				db
					.select({ id: aclGrants.id })
					.from(aclGrants)
					.where(and(eq(aclGrants.domainKind, "clearance"), eq(aclGrants.domainValue, levelName)))
					.limit(1),
			]);
			return (
				entryRef.length > 0 ||
				collectionDefaultRef.length > 0 ||
				collectionClassRef.length > 0 ||
				grantRef.length > 0
			);
		},

		async listKnowledgeTags(collectionId) {
			const rows = await db
				.select()
				.from(knowledgeTags)
				.where(collectionId ? eq(knowledgeTags.collectionId, collectionId) : undefined);
			return rows as KnowledgeTagRow[];
		},

		async getKnowledgeTagById(tagId) {
			const rows = await db
				.select()
				.from(knowledgeTags)
				.where(eq(knowledgeTags.id, tagId))
				.limit(1);
			return (rows[0] as KnowledgeTagRow | undefined) ?? null;
		},

		async listKnowledgeTagTypes() {
			const rows = await db
				.select()
				.from(knowledgeTagTypes)
				.orderBy(asc(knowledgeTagTypes.sortOrder), asc(knowledgeTagTypes.createdAt));
			return rows as KnowledgeTagTypeRow[];
		},

		async getKnowledgeTagTypeById(tagTypeId) {
			const rows = await db
				.select()
				.from(knowledgeTagTypes)
				.where(eq(knowledgeTagTypes.id, tagTypeId))
				.limit(1);
			return (rows[0] as KnowledgeTagTypeRow | undefined) ?? null;
		},

		async listKnowledgeAclGrantRows(opts) {
			const principals = opts?.principals;
			const principalClause =
				principals && principals.length > 0
					? or(
							...principals.map((p) =>
								and(
									eq(aclGrants.principalType, p.principalType),
									eq(aclGrants.principalId, p.principalId),
								),
							),
						)
					: undefined;
			const rows = await db
				.select(GRANT_SELECT)
				.from(aclGrants)
				.where(and(knowledgeGrantScopeWhere(), principalClause));
			return rows as AclGrantReadRow[];
		},

		async getAclGrantById(grantId) {
			const rows = await db
				.select(GRANT_SELECT)
				.from(aclGrants)
				.where(eq(aclGrants.id, grantId))
				.limit(1);
			return (rows[0] as AclGrantReadRow | undefined) ?? null;
		},

		async findEntryLink(input) {
			const rows = await db
				.select()
				.from(knowledgeEntryLinks)
				.where(
					and(
						eq(knowledgeEntryLinks.fromEntryId, input.fromEntryId),
						eq(knowledgeEntryLinks.toEntryId, input.toEntryId),
						eq(knowledgeEntryLinks.linkType, input.linkType),
					),
				)
				.limit(1);
			return (rows[0] as KnowledgeEntryLinkRow | undefined) ?? null;
		},

		async getEntryLinkById(linkId) {
			const rows = await db
				.select()
				.from(knowledgeEntryLinks)
				.where(eq(knowledgeEntryLinks.id, linkId))
				.limit(1);
			return (rows[0] as KnowledgeEntryLinkRow | undefined) ?? null;
		},

		async listEntryLinks(entryId, direction) {
			const rows = await db
				.select()
				.from(knowledgeEntryLinks)
				.where(
					direction === "out"
						? eq(knowledgeEntryLinks.fromEntryId, entryId)
						: direction === "in"
							? eq(knowledgeEntryLinks.toEntryId, entryId)
							: or(
									eq(knowledgeEntryLinks.fromEntryId, entryId),
									eq(knowledgeEntryLinks.toEntryId, entryId),
								),
				)
				.orderBy(desc(knowledgeEntryLinks.createdAt));
			return rows as KnowledgeEntryLinkRow[];
		},

		async listEntryLinksTouching(entryIds, limit) {
			if (entryIds.length === 0) return [];
			const rows = await db
				.select()
				.from(knowledgeEntryLinks)
				.where(
					or(
						inArray(knowledgeEntryLinks.fromEntryId, entryIds),
						inArray(knowledgeEntryLinks.toEntryId, entryIds),
					),
				)
				.limit(limit);
			return rows as KnowledgeEntryLinkRow[];
		},

		async getSubmissionRoutingById(submissionId) {
			const rows = await db
				.select({
					id: knowledgeSubmissions.id,
					entryId: knowledgeSubmissions.entryId,
					collectionId: knowledgeSubmissions.collectionId,
					submitterUserId: knowledgeSubmissions.submitterUserId,
					status: knowledgeSubmissions.status,
				})
				.from(knowledgeSubmissions)
				.where(eq(knowledgeSubmissions.id, submissionId))
				.limit(1);
			return (rows[0] as KnowledgeSubmissionRoutingRow | undefined) ?? null;
		},

		async listActiveDraftHolderIds(entryId, limit) {
			return db
				.select({ authorUserId: knowledgeDrafts.authorUserId })
				.from(knowledgeDrafts)
				.where(
					and(
						eq(knowledgeDrafts.entryId, entryId),
						inArray(knowledgeDrafts.status, ["active"]),
						isNotNull(knowledgeDrafts.baseRevisionId),
					),
				)
				.limit(limit);
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
			const rows = await db
				.select()
				.from(aclEvents)
				.where(and(...conds))
				.orderBy(desc(aclEvents.createdAt), desc(aclEvents.id))
				.limit(opts.limit);
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
					// PG's count(*) is BIGINT; cast so the string the signature is built from
					// is the same plain decimal the SQLite driver produced.
					cnt: sql<number>`count(*)::int`,
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
}
