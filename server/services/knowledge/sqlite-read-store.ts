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
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { db, sqlite } from "../../db";
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
import { readDomainTask, readQuery, readQueryFirst } from "../../db/worker-read";
import { KNOWLEDGE_ENTRY_DETAIL_TOO_LARGE } from "../../lib/db-worker/knowledge-entry-query";
import { runReadTask, WorkersUnavailableError } from "../../lib/db-worker/pool";
import { AppError } from "../../lib/errors";
import type {
	AclEventReadRow,
	KeywordInjectionCandidateRow,
	KnowledgeEntryLinkRow,
	KnowledgeEntryListFilter,
	KnowledgeEntryListOrder,
	KnowledgeEntryListRow,
	KnowledgeEntryRow,
	KnowledgeReadStore,
	KnowledgeRevisionRow,
	KnowledgeSubmissionRoutingRow,
} from "./read-store";
import { readKnowledgeIds, readKnowledgePages } from "./sqlite-read-pages";
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

/**
 * WHERE for the ordered browse list: SQL-side filters + the keyset predicate of the order.
 * `level` is the effective level (own level, else the collection's default — a small `IN`
 * subselect over collections).
 */
function entryListWhere(filter: KnowledgeEntryListFilter, order: KnowledgeEntryListOrder) {
	const level = filter.level;
	let keyset: ReturnType<typeof or>;
	if (order.sort === "title") {
		const after = order.after;
		keyset = after
			? or(
					gt(knowledgeEntries.title, after.title),
					and(eq(knowledgeEntries.title, after.title), gt(knowledgeEntries.id, after.id)),
				)
			: undefined;
	} else {
		const after = order.after;
		keyset = after
			? or(
					lt(knowledgeEntries.updatedAt, after.updatedAt),
					and(eq(knowledgeEntries.updatedAt, after.updatedAt), lt(knowledgeEntries.id, after.id)),
				)
			: undefined;
	}
	return and(
		filter.collectionId ? eq(knowledgeEntries.collectionId, filter.collectionId) : undefined,
		filter.status ? eq(knowledgeEntries.status, filter.status) : undefined,
		level
			? or(
					eq(knowledgeEntries.classificationLevel, level),
					and(
						isNull(knowledgeEntries.classificationLevel),
						inArray(
							knowledgeEntries.collectionId,
							db
								.select({ id: knowledgeCollections.id })
								.from(knowledgeCollections)
								.where(eq(knowledgeCollections.defaultLevel, level)),
						),
					),
				)
			: undefined,
		keyset,
	);
}

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

function personalInjectionWhere(opts: {
	userId: string;
	collectionId?: string;
	projectId?: string;
}) {
	return and(
		eq(knowledgeDrafts.authorUserId, opts.userId),
		eq(knowledgeDrafts.status, "active"),
		isNull(knowledgeDrafts.entryId),
		isNotNull(knowledgeDrafts.keywordsJson),
		opts.collectionId ? eq(knowledgeDrafts.targetCollectionId, opts.collectionId) : undefined,
		opts.projectId
			? or(
					isNull(knowledgeDrafts.targetCollectionId),
					inArray(
						knowledgeDrafts.targetCollectionId,
						db
							.select({ id: knowledgeCollections.id })
							.from(knowledgeCollections)
							.where(
								or(
									eq(knowledgeCollections.projectId, opts.projectId),
									isNull(knowledgeCollections.projectId),
								),
							),
					),
				)
			: undefined,
	);
}

function keywordSignatureQuery(opts: { collectionId?: string; projectId?: string }) {
	return db
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
}

const signatureReadOptions = { maxRows: 1, diagnosticSource: "knowledge.keyword-signature" };

export const sqliteKnowledgeReadStore: KnowledgeReadStore = {
	async listPersonalEntries(opts, options = {}) {
		const { content, ...columns } = getTableColumns(knowledgeDrafts);
		return readQuery(
			db
				.select({ ...columns, contentLength: sql<number>`length(${content})` })
				.from(knowledgeDrafts)
				.where(
					and(
						eq(knowledgeDrafts.authorUserId, opts.userId),
						opts.status ? eq(knowledgeDrafts.status, opts.status) : undefined,
					),
				)
				.orderBy(desc(knowledgeDrafts.updatedAt))
				.limit(Math.max(1, Math.min(opts.limit, 200))),
			{ ...options, executionPolicy: "worker-required" },
		);
	},
	async getEntryRevisionPointers(ids, options = {}) {
		if (!ids.length) return [];
		return readQuery(
			db
				.select({ id: knowledgeEntries.id, currentRevisionId: knowledgeEntries.currentRevisionId })
				.from(knowledgeEntries)
				.where(inArray(knowledgeEntries.id, ids))
				.limit(200),
			{ ...options, executionPolicy: "worker-required" },
		);
	},
	async getPersonalEntryById(id, options = {}) {
		return (
			(await readQueryFirst(
				db.query.knowledgeDrafts.findMany({ limit: 1, where: eq(knowledgeDrafts.id, id) }),
				{ ...options, executionPolicy: "worker-required" },
			)) ?? null
		);
	},
	async getEntryById(entryId, options = {}) {
		const row = await readDomainTask(
			sqlite,
			"knowledgeEntryDetail",
			{ entryId },
			{ ...options, executionPolicy: "worker-required" },
		);
		if (!row) return null;
		return {
			...row,
			tagsJson: row.tagsJson === null ? null : JSON.parse(row.tagsJson),
			keywordsJson: row.keywordsJson === null ? null : JSON.parse(row.keywordsJson),
			metadataJson: row.metadataJson === null ? null : JSON.parse(row.metadataJson),
			controlledTagsJson:
				row.controlledTagsJson === null ? null : JSON.parse(row.controlledTagsJson),
			reviewTagsJson: row.reviewTagsJson === null ? null : JSON.parse(row.reviewTagsJson),
		};
	},

	async getEntryDetailById(entryId, signal, options = {}) {
		signal ??= options.signal;
		signal?.throwIfAborted();
		if (!sqlite.filename || sqlite.filename === ":memory:" || sqlite.inTransaction) {
			throw new WorkersUnavailableError("requires_committed_file");
		}
		try {
			return await runReadTask<KnowledgeEntryRow | null>(
				sqlite.filename,
				{ kind: "knowledgeEntryDetail", entryId },
				{ ...options, signal, timeoutMs: options.timeoutMs ?? 10_000 },
			);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === KNOWLEDGE_ENTRY_DETAIL_TOO_LARGE) {
				throw new AppError(err.message, 413, KNOWLEDGE_ENTRY_DETAIL_TOO_LARGE);
			}
			throw err;
		}
	},

	async getEntryAclById(entryId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeEntries.findMany({
				limit: 1,
				where: eq(knowledgeEntries.id, entryId),
				columns: ENTRY_ACL_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async getEntryGraphById(entryId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeEntries.findMany({
				limit: 1,
				where: eq(knowledgeEntries.id, entryId),
				columns: ENTRY_GRAPH_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async getEntriesAclByIds(entryIds, options = {}) {
		if (entryIds.length > 100)
			return readKnowledgeIds(entryIds, (ids) =>
				sqliteKnowledgeReadStore.getEntriesAclByIds(ids, options),
			);
		if (entryIds.length === 0) return [];
		return readQuery(
			db.query.knowledgeEntries.findMany({
				where: inArray(knowledgeEntries.id, entryIds),
				columns: ENTRY_ACL_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async getEntriesGraphByIds(entryIds, options = {}) {
		if (entryIds.length > 100)
			return readKnowledgeIds(entryIds, (ids) =>
				sqliteKnowledgeReadStore.getEntriesGraphByIds(ids, options),
			);
		if (entryIds.length === 0) return [];
		return readQuery(
			db.query.knowledgeEntries.findMany({
				where: inArray(knowledgeEntries.id, entryIds),
				columns: ENTRY_GRAPH_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listEntries(opts, options = {}) {
		const after = opts.after;
		return readQuery(
			db.query.knowledgeEntries.findMany({
				where: and(
					opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
					after
						? or(
								lt(knowledgeEntries.updatedAt, after.updatedAt),
								and(
									eq(knowledgeEntries.updatedAt, after.updatedAt),
									lt(knowledgeEntries.id, after.id),
								),
							)
						: undefined,
				),
				columns: ENTRY_LIST_COLUMNS,
				orderBy: (e, { desc: d }) => [d(e.updatedAt), d(e.id)],
				limit: opts.limit,
			}),
			{ ...options, executionPolicy: "worker-required" },
		) as Promise<KnowledgeEntryListRow[]>;
	},

	async listEntriesOrdered(opts, options = {}) {
		const { limit, order, ...filter } = opts;
		return readQuery(
			db.query.knowledgeEntries.findMany({
				where: entryListWhere(filter, order),
				columns: ENTRY_LIST_COLUMNS,
				orderBy:
					order.sort === "title"
						? [asc(knowledgeEntries.title), asc(knowledgeEntries.id)]
						: [desc(knowledgeEntries.updatedAt), desc(knowledgeEntries.id)],
				limit,
			}),
			{ ...options, executionPolicy: "worker-required" },
		) as Promise<KnowledgeEntryListRow[]>;
	},

	async findEntryBySlug(collectionId, slug, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeEntries.findMany({
				limit: 1,
				where: and(
					eq(knowledgeEntries.collectionId, collectionId),
					eq(knowledgeEntries.slug, slug),
				),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async getCollectionById(collectionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeCollections.findMany({
				limit: 1,
				where: eq(knowledgeCollections.id, collectionId),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return (row as KnowledgeCollectionRow | undefined) ?? null;
	},

	async getCollectionAclById(collectionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeCollections.findMany({
				limit: 1,
				where: eq(knowledgeCollections.id, collectionId),
				columns: COLLECTION_ACL_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async getCollectionSummaryById(collectionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeCollections.findMany({
				limit: 1,
				where: eq(knowledgeCollections.id, collectionId),
				columns: COLLECTION_SUMMARY_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async getCollectionsAclByIds(collectionIds, options = {}) {
		if (collectionIds.length > 100)
			return readKnowledgeIds(collectionIds, (ids) =>
				sqliteKnowledgeReadStore.getCollectionsAclByIds(ids, options),
			);
		if (collectionIds.length === 0) return [];
		return readQuery(
			db.query.knowledgeCollections.findMany({
				where: inArray(knowledgeCollections.id, collectionIds),
				columns: COLLECTION_ACL_COLUMNS,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listCollections(opts, options = {}) {
		return readQuery(
			db.query.knowledgeCollections.findMany({
				where: opts.projectId ? eq(knowledgeCollections.projectId, opts.projectId) : undefined,
				orderBy: (c, { asc: a }) => [a(c.name)],
				limit: opts.limit,
			}),
			{ ...options, executionPolicy: "worker-required" },
		) as Promise<KnowledgeCollectionRow[]>;
	},

	async findCollectionBySlug(opts, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeCollections.findMany({
				limit: 1,
				where: opts.projectId
					? and(
							eq(knowledgeCollections.projectId, opts.projectId),
							eq(knowledgeCollections.slug, opts.slug),
						)
					: eq(knowledgeCollections.slug, opts.slug),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async collectionExists(collectionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeCollections.findMany({
				limit: 1,
				where: eq(knowledgeCollections.id, collectionId),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row !== undefined;
	},

	async getRevisionById(revisionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeRevisions.findMany({
				limit: 1,
				where: eq(knowledgeRevisions.id, revisionId),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return (row as KnowledgeRevisionRow | undefined) ?? null;
	},

	async getRevisionEntryId(revisionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeRevisions.findMany({
				limit: 1,
				where: eq(knowledgeRevisions.id, revisionId),
				columns: { id: true, entryId: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async listRevisionMeta(entryId, limit, options = {}) {
		const rows = await readQuery(
			db
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
				.limit(limit),
			{ ...options, executionPolicy: "worker-required" },
		);
		return rows.map((row) => ({ ...row, contentLength: Number(row.contentLength) }));
	},

	async userExists(userId, options = {}) {
		const row = await readQueryFirst(
			db.query.users.findMany({ limit: 1, where: eq(users.id, userId), columns: { id: true } }),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row !== undefined;
	},

	async getUserRoleById(userId, options = {}) {
		const row = await readQueryFirst(
			db.query.users.findMany({
				limit: 1,
				where: eq(users.id, userId),
				columns: { id: true, role: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async getUsernameById(userId, options = {}) {
		const row = await readQueryFirst(
			db.query.users.findMany({
				limit: 1,
				where: eq(users.id, userId),
				columns: { username: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async listUsernamesByIds(userIds, options = {}) {
		if (userIds.length > 100)
			return readKnowledgeIds(userIds, (ids) =>
				sqliteKnowledgeReadStore.listUsernamesByIds(ids, options),
			);
		if (userIds.length === 0) return [];
		return readQuery(
			db.query.users.findMany({
				where: inArray(users.id, userIds),
				columns: { id: true, username: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listUserIdsAndRoles(opts, options = {}) {
		return readQuery(
			db.query.users.findMany({
				where: opts.role ? eq(users.role, opts.role as "admin" | "user") : undefined,
				columns: { id: true, role: true },
				...(opts.limit !== undefined ? { limit: opts.limit } : {}),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listExistingUserIds(userIds, options = {}) {
		if (userIds.length > 100)
			return readKnowledgeIds(userIds, (ids) =>
				sqliteKnowledgeReadStore.listExistingUserIds(ids, options),
			);
		if (userIds.length === 0) return [];
		return readQuery(
			db.query.users.findMany({
				where: inArray(users.id, userIds),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listUsersDetailed(options = {}) {
		return readQuery(
			db.query.users.findMany({
				columns: { id: true, username: true, role: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listKnowledgeLevels(options = {}) {
		return readQuery(
			db.query.knowledgeLevels.findMany({ orderBy: (l, { asc: a }) => [a(l.rank)] }),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async getKnowledgeLevelById(levelId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeLevels.findMany({ limit: 1, where: eq(knowledgeLevels.id, levelId) }),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async findKnowledgeLevelByName(name, excludeId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeLevels.findMany({
				limit: 1,
				where: excludeId
					? and(eq(knowledgeLevels.name, name), ne(knowledgeLevels.id, excludeId))
					: eq(knowledgeLevels.name, name),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async findKnowledgeLevelByRank(rank, excludeId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeLevels.findMany({
				limit: 1,
				where: excludeId
					? and(eq(knowledgeLevels.rank, rank), ne(knowledgeLevels.id, excludeId))
					: eq(knowledgeLevels.rank, rank),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async knowledgeLevelInUse(levelName, options = {}) {
		// Levels are referenced BY NAME from entries, collections (both axes) and
		// clearance credentials — the same four probes the delete guard always ran.
		const [entryRef, collectionDefaultRef, collectionClassRef, grantRef] = await Promise.all([
			readQueryFirst(
				db.query.knowledgeEntries.findMany({
					limit: 1,
					where: eq(knowledgeEntries.classificationLevel, levelName),
					columns: { id: true },
				}),
				{ ...options, executionPolicy: "worker-required" },
			),
			readQueryFirst(
				db.query.knowledgeCollections.findMany({
					limit: 1,
					where: eq(knowledgeCollections.defaultLevel, levelName),
					columns: { id: true },
				}),
				{ ...options, executionPolicy: "worker-required" },
			),
			readQueryFirst(
				db.query.knowledgeCollections.findMany({
					limit: 1,
					where: eq(knowledgeCollections.classificationLevel, levelName),
					columns: { id: true },
				}),
				{ ...options, executionPolicy: "worker-required" },
			),
			readQueryFirst(
				db.query.aclGrants.findMany({
					limit: 1,
					where: and(eq(aclGrants.domainKind, "clearance"), eq(aclGrants.domainValue, levelName)),
					columns: { id: true },
				}),
				{ ...options, executionPolicy: "worker-required" },
			),
		]);
		return Boolean(entryRef || collectionDefaultRef || collectionClassRef || grantRef);
	},

	async listKnowledgeTags(collectionId, options = {}) {
		if (collectionId) {
			return readQuery(
				db.query.knowledgeTags.findMany({
					where: eq(knowledgeTags.collectionId, collectionId),
				}),
				{ ...options, executionPolicy: "worker-required" },
			);
		}
		return readQuery(db.query.knowledgeTags.findMany(), {
			...options,
			executionPolicy: "worker-required",
		});
	},

	async getKnowledgeTagById(tagId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeTags.findMany({ limit: 1, where: eq(knowledgeTags.id, tagId) }),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async listKnowledgeTagTypes(options = {}) {
		return readQuery(
			db.query.knowledgeTagTypes.findMany({
				orderBy: (tt, { asc: a }) => [a(tt.sortOrder), a(tt.createdAt)],
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async getKnowledgeTagTypeById(tagTypeId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeTagTypes.findMany({ limit: 1, where: eq(knowledgeTagTypes.id, tagTypeId) }),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async listKnowledgeAclGrantRows(opts, options = {}) {
		const principals = opts?.principals;
		if (principals && principals.length > 100) {
			const rows = new Map<
				string,
				Awaited<ReturnType<KnowledgeReadStore["listKnowledgeAclGrantRows"]>>[number]
			>();
			for (let offset = 0; offset < principals.length; offset += 100) {
				for (const row of await sqliteKnowledgeReadStore.listKnowledgeAclGrantRows(
					{
						...opts,
						principals: principals.slice(offset, offset + 100),
					},
					options,
				))
					rows.set(row.id, row);
			}
			return [...rows.values()];
		}
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
		return readQuery(
			db.query.aclGrants.findMany({
				columns: GRANT_COLUMNS,
				where: and(knowledgeGrantScopeWhere(), principalClause),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async getAclGrantById(grantId, options = {}) {
		const row = await readQueryFirst(
			db.query.aclGrants.findMany({
				limit: 1,
				columns: GRANT_COLUMNS,
				where: eq(aclGrants.id, grantId),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row ?? null;
	},

	async findEntryLink(input, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeEntryLinks.findMany({
				limit: 1,
				where: and(
					eq(knowledgeEntryLinks.fromEntryId, input.fromEntryId),
					eq(knowledgeEntryLinks.toEntryId, input.toEntryId),
					eq(knowledgeEntryLinks.linkType, input.linkType as never),
				),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return (row as KnowledgeEntryLinkRow | undefined) ?? null;
	},

	async getEntryLinkById(linkId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeEntryLinks.findMany({
				limit: 1,
				where: eq(knowledgeEntryLinks.id, linkId),
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return (row as KnowledgeEntryLinkRow | undefined) ?? null;
	},

	async listEntryLinks(entryId, direction, options = {}) {
		const rows = await readQuery(
			db.query.knowledgeEntryLinks.findMany({
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
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return rows as KnowledgeEntryLinkRow[];
	},

	async listEntryLinksTouching(entryIds, limit, options = {}) {
		if (entryIds.length === 0) return [];
		const rows = await readQuery(
			db.query.knowledgeEntryLinks.findMany({
				where: or(
					inArray(
						knowledgeEntryLinks.fromEntryId,
						sql`(select value from json_each(${JSON.stringify(entryIds)}))`,
					),
					inArray(
						knowledgeEntryLinks.toEntryId,
						sql`(select value from json_each(${JSON.stringify(entryIds)}))`,
					),
				),
				limit,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return rows as KnowledgeEntryLinkRow[];
	},

	async getSubmissionRoutingById(submissionId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeSubmissions.findMany({
				limit: 1,
				where: eq(knowledgeSubmissions.id, submissionId),
				columns: {
					id: true,
					entryId: true,
					collectionId: true,
					submitterUserId: true,
					status: true,
				},
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return (row as KnowledgeSubmissionRoutingRow | undefined) ?? null;
	},

	async listActiveDraftHolderIds(entryId, limit, options = {}) {
		return readQuery(
			db.query.knowledgeDrafts.findMany({
				where: and(
					eq(knowledgeDrafts.entryId, entryId),
					inArray(knowledgeDrafts.status, ["active"]),
					isNotNull(knowledgeDrafts.baseRevisionId),
				),
				columns: { authorUserId: true },
				limit,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async findActivePersonalEntryId(entryId, authorUserId, options = {}) {
		const row = await readQueryFirst(
			db.query.knowledgeDrafts.findMany({
				limit: 1,
				where: and(
					eq(knowledgeDrafts.entryId, entryId),
					eq(knowledgeDrafts.authorUserId, authorUserId),
					eq(knowledgeDrafts.status, "active"),
				),
				columns: { id: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return row?.id ?? null;
	},

	async listActivePersonalEntriesForEntries(entryIds, authorUserId, options = {}) {
		if (entryIds.length > 100)
			return readKnowledgeIds(entryIds, (ids) =>
				sqliteKnowledgeReadStore.listActivePersonalEntriesForEntries(ids, authorUserId, options),
			);
		if (entryIds.length === 0) return [];
		const rows = await readQuery(
			db.query.knowledgeDrafts.findMany({
				where: and(
					inArray(knowledgeDrafts.entryId, entryIds),
					eq(knowledgeDrafts.authorUserId, authorUserId),
					eq(knowledgeDrafts.status, "active"),
				),
				columns: { id: true, entryId: true, baseRevisionId: true },
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return rows.flatMap((r) =>
			r.entryId ? [{ id: r.id, entryId: r.entryId, baseRevisionId: r.baseRevisionId }] : [],
		);
	},

	async listKnowledgeAclEventRows(opts, options = {}) {
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
		const rows = await readQuery(
			db.query.aclEvents.findMany({
				where: and(...conds),
				orderBy: (e, { desc: d }) => [d(e.createdAt), d(e.id)],
				limit: opts.limit,
			}),
			{ ...options, executionPolicy: "worker-required" },
		);
		return rows as AclEventReadRow[];
	},

	async listPersonalKeywordInjectionCandidates(opts, options = {}) {
		return readKnowledgePages(
			opts.limit,
			100,
			(offset, pageSize) =>
				db
					.select({
						id: knowledgeDrafts.id,
						collectionId: sql<string>`coalesce(${knowledgeDrafts.targetCollectionId}, '')`.as(
							"collection_id",
						),
						title: sql<string>`coalesce(${knowledgeDrafts.title}, '')`.as("title"),
						// Worker column metadata needs distinct names for both NULL projections.
						currentRevisionId: sql<null>`null`.as("current_revision_id"),
						tagsJson: sql<null>`null`.as("tags_json"),
						keywordsJson: knowledgeDrafts.keywordsJson,
						updatedAt: knowledgeDrafts.updatedAt,
					})
					.from(knowledgeDrafts)
					.where(personalInjectionWhere(opts))
					.orderBy(desc(knowledgeDrafts.updatedAt), knowledgeDrafts.id)
					.limit(pageSize)
					.offset(offset),
			options,
		);
	},
	async personalKeywordInjectionSignature(opts, options = {}) {
		const row = await readQueryFirst(
			db
				.select({
					cnt: sql<number>`count(*)`,
					maxUpdated: sql<string>`coalesce(max(${knowledgeDrafts.updatedAt}), '')`,
				})
				.from(knowledgeDrafts)
				.where(personalInjectionWhere(opts)),
			{
				...options,
				...signatureReadOptions,
				executionPolicy: "worker-required",
				signal: opts.signal ?? options.signal,
			},
		);
		return `${Number(row?.cnt ?? 0)}:${row?.maxUpdated ?? ""}`;
	},
	async personalInjectionSnippets(userId, ids, maxChars, options = {}) {
		if (!ids.length) return [];
		return readQuery(
			db
				.select({
					id: knowledgeDrafts.id,
					snippet: sql<string>`substr(${knowledgeDrafts.content}, 1, ${maxChars})`,
				})
				.from(knowledgeDrafts)
				.where(
					and(
						eq(knowledgeDrafts.authorUserId, userId),
						eq(knowledgeDrafts.status, "active"),
						isNull(knowledgeDrafts.entryId),
						inArray(knowledgeDrafts.id, ids),
					),
				),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listKeywordInjectionCandidates(opts, options = {}) {
		const rows = await readKnowledgePages(
			opts.limit,
			100,
			(offset, pageSize) =>
				db
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
					.orderBy(desc(knowledgeEntries.updatedAt), asc(knowledgeEntries.id))
					.limit(pageSize)
					.offset(offset),
			options,
		);
		return rows as KeywordInjectionCandidateRow[];
	},

	async keywordInjectionCandidatesSignature(opts, options = {}) {
		const row = await readQueryFirst(keywordSignatureQuery(opts), {
			...options,
			...signatureReadOptions,
			executionPolicy: "worker-required",
			signal: opts.signal ?? options.signal,
		});
		return `${Number(row?.cnt ?? 0)}:${row?.maxUpdated ?? ""}`;
	},

	async snippetsByEntryIds(entryIds, maxChars, options = {}) {
		if (entryIds.length === 0) return [];
		return readQuery(
			db
				.select({
					id: knowledgeEntries.id,
					snippet: sql<
						string | null
					>`substr(coalesce(${knowledgeEntries.currentContent}, ${knowledgeEntries.title}), 1, ${maxChars})`,
				})
				.from(knowledgeEntries)
				.where(inArray(knowledgeEntries.id, entryIds)),
			{ ...options, executionPolicy: "worker-required" },
		);
	},

	async listInjectedEntryIds(narratorId, compactSeq, options = {}) {
		const rows = await readQuery(
			db
				.select({
					entryId: knowledgeInjectionEvents.entryId,
					personalEntryId: knowledgeInjectionEvents.personalEntryId,
				})
				.from(knowledgeInjectionEvents)
				.where(
					and(
						eq(knowledgeInjectionEvents.narratorId, narratorId),
						eq(knowledgeInjectionEvents.compactSeq, compactSeq),
					),
				),
			{ ...options, executionPolicy: "worker-required" },
		);
		return rows.map((row) =>
			row.personalEntryId ? `personal:${row.personalEntryId}` : `global:${row.entryId}`,
		);
	},
};

export const sqliteKnowledgeInjectionReads = {
	listKeywordInjectionCandidates: (
		...args: Parameters<KnowledgeReadStore["listKeywordInjectionCandidates"]>
	) => sqliteKnowledgeReadStore.listKeywordInjectionCandidates(...args),
	keywordInjectionCandidatesSignature: (
		...args: Parameters<KnowledgeReadStore["keywordInjectionCandidatesSignature"]>
	) => sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature(...args),
	snippetsByEntryIds: (...args: Parameters<KnowledgeReadStore["snippetsByEntryIds"]>) =>
		sqliteKnowledgeReadStore.snippetsByEntryIds(...args),
	listInjectedEntryIds: (...args: Parameters<KnowledgeReadStore["listInjectedEntryIds"]>) =>
		sqliteKnowledgeReadStore.listInjectedEntryIds(...args),
};
