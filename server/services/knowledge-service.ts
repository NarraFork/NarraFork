import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { knowledgeCollections, knowledgeEntries, knowledgeRevisions } from "../db/schema";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	canWriteMain,
	type Principal,
	type PrincipalCaps,
	resolvePrincipalCaps,
} from "./knowledge-acl";

type Format = "markdown" | "text" | "json";

function toAclEntry(e: {
	id: string;
	collectionId: string;
	ownerUserId?: string | null;
	classificationLevel?: string | null;
	controlledTagsJson?: unknown;
	reviewTagsJson?: unknown;
}): AclEntry {
	return {
		id: e.id,
		collectionId: e.collectionId,
		ownerUserId: e.ownerUserId,
		classificationLevel: e.classificationLevel,
		controlledTagsJson: e.controlledTagsJson,
		reviewTagsJson: e.reviewTagsJson,
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

/** True for SQLite UNIQUE-constraint violations (used to convert TOCTOU slug/version races). */
function isUniqueConstraintError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

/**
 * Load an entry + its collection and assert the principal may READ it.
 * Throws NotFoundError (not a 403) on any miss so we never leak existence of
 * entries the caller cannot see. Returns the loaded entry row + resolved caps
 * so callers can reuse them (e.g. for a subsequent write check).
 */
async function loadReadableEntry(
	entryId: string,
	principal: Principal,
): Promise<{ entry: typeof knowledgeEntries.$inferSelect; caps: PrincipalCaps }> {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, entryId),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", entryId);
	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, entry.collectionId),
	});
	const caps = await resolvePrincipalCaps(principal);
	const aclCol: AclCollection = {
		id: entry.collectionId,
		defaultLevel: collection?.defaultLevel ?? "public",
	};
	if (!(await canRead(caps, toAclEntry(entry), aclCol))) {
		throw new NotFoundError("Knowledge entry", entryId);
	}
	return { entry, caps };
}

/**
 * Like loadReadableEntry but additionally asserts WRITE-main capability
 * (admin / owner / write grant). Used by metadata edit + delete paths so a
 * read-only or unauthorized principal cannot mutate an entry.
 */
async function loadWritableEntry(
	entryId: string,
	principal: Principal,
): Promise<typeof knowledgeEntries.$inferSelect> {
	const { entry, caps } = await loadReadableEntry(entryId, principal);
	if (!canWriteMain(caps, toAclEntry(entry))) {
		throw new ValidationError(
			"You do not have permission to modify this entry; submit a draft for review instead",
		);
	}
	return entry;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Slugify a title into a URL-safe slug (lowercase alnum + hyphens). Falls back to a short id. */
function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 200);
	return slug || generateId(8);
}

/** Remove FTS5 special chars to prevent injection (mirrors search-service). */
function sanitizeQuery(query: string): string {
	return query.replace(/['"*(){}[\]^~@:;!&|,<>\\]/g, "").trim();
}

/** Build an FTS5 prefix query from sanitized input.
 *  match="and" (default) requires all terms; match="or" matches any term
 *  (used for passive injection, where the input is a natural-language sentence). */
function buildFtsQuery(safeQuery: string, match: "and" | "or" = "and"): string {
	const terms = safeQuery
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => `"${w}"*`);
	return terms.join(match === "or" ? " OR " : " ");
}

function parseTags(tagsJson: unknown): string[] {
	if (Array.isArray(tagsJson)) return tagsJson.filter((t): t is string => typeof t === "string");
	return [];
}

// ═══════════════════════════════════════════════════════════════════════
// Collections
// ═══════════════════════════════════════════════════════════════════════

async function listCollections(projectId?: string) {
	if (projectId) {
		return db.query.knowledgeCollections.findMany({
			where: eq(knowledgeCollections.projectId, projectId),
			orderBy: (c, { asc }) => [asc(c.name)],
		});
	}
	return db.query.knowledgeCollections.findMany({
		orderBy: (c, { asc }) => [asc(c.name)],
	});
}

async function createCollection(input: {
	name: string;
	slug?: string;
	description?: string;
	projectId?: string;
}) {
	const slug = input.slug ?? slugify(input.name);
	const existing = await db.query.knowledgeCollections.findFirst({
		where: input.projectId
			? and(
					eq(knowledgeCollections.projectId, input.projectId),
					eq(knowledgeCollections.slug, slug),
				)
			: eq(knowledgeCollections.slug, slug),
	});
	if (existing) throw new ValidationError(`Collection slug already exists: ${slug}`);

	const id = generateId();
	const now = nowIso();
	try {
		const [created] = await db
			.insert(knowledgeCollections)
			.values({
				id,
				name: input.name,
				slug,
				description: input.description ?? null,
				projectId: input.projectId ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return created;
	} catch (err) {
		if (isUniqueConstraintError(err)) {
			throw new ValidationError(`Collection slug already exists: ${slug}`);
		}
		throw err;
	}
}

async function getCollection(id: string) {
	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, id),
	});
	if (!collection) throw new NotFoundError("Knowledge collection", id);
	return collection;
}

async function updateCollection(id: string, input: { name?: string; description?: string | null }) {
	await getCollection(id);
	await db
		.update(knowledgeCollections)
		.set({
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			updatedAt: nowIso(),
		})
		.where(eq(knowledgeCollections.id, id));
	return getCollection(id);
}

async function deleteCollection(id: string) {
	await getCollection(id);
	await db.delete(knowledgeCollections).where(eq(knowledgeCollections.id, id));
	return { ok: true as const };
}

// ═══════════════════════════════════════════════════════════════════════
// Entries + revisions
// ═══════════════════════════════════════════════════════════════════════

/** Hard cap on rows returned by any single list query (main-thread safety). */
const LIST_MAX_LIMIT = 200;
const LIST_DEFAULT_LIMIT = 100;

/** Columns safe to return in list views — explicitly EXCLUDES the large
 *  currentContent / metadataJson blobs so they're never read off disk in bulk. */
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

async function listEntries(opts: { collectionId?: string; tag?: string; limit?: number }) {
	const limit = Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
	const rows = await db.query.knowledgeEntries.findMany({
		where: opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
		// SQL-layer column projection: the large currentContent/metadataJson blobs
		// are never selected, so list views can't pull big bodies into the main thread.
		columns: ENTRY_LIST_COLUMNS,
		orderBy: (e, { desc: d }) => [d(e.updatedAt)],
		limit,
	});
	const tag = opts.tag;
	return tag ? rows.filter((r) => parseTags(r.tagsJson).includes(tag)) : rows;
}

async function getEntry(id: string, opts: { withContent?: boolean; principal?: Principal } = {}) {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, id),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", id);

	// ACL: when a principal is supplied, enforce dual-axis read access.
	// Unauthorized → treat as not found (don't leak existence).
	if (opts.principal) {
		const collection = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, entry.collectionId),
		});
		const caps = await resolvePrincipalCaps(opts.principal);
		const aclCol: AclCollection = {
			id: entry.collectionId,
			defaultLevel: collection?.defaultLevel ?? "public",
		};
		if (!(await canRead(caps, toAclEntry(entry), aclCol))) {
			throw new NotFoundError("Knowledge entry", id);
		}
	}

	if (opts.withContent) return entry;
	const { currentContent: _omit, ...rest } = entry;
	return rest;
}

async function createEntry(input: {
	collectionId: string;
	title: string;
	slug?: string;
	content?: string;
	format?: Format;
	tags?: string[];
	metadata?: Record<string, unknown>;
	changeNote?: string;
	authorUserId?: string;
}) {
	// Ensure collection exists
	await getCollection(input.collectionId);

	const slug = input.slug ?? slugify(input.title);
	const dup = await db.query.knowledgeEntries.findFirst({
		where: and(
			eq(knowledgeEntries.collectionId, input.collectionId),
			eq(knowledgeEntries.slug, slug),
		),
	});
	if (dup) throw new ValidationError(`Entry slug already exists in collection: ${slug}`);

	const entryId = generateId();
	const revisionId = generateId();
	const now = nowIso();
	const content = input.content ?? "";
	const format = input.format ?? "markdown";

	try {
		db.transaction((tx) => {
			// Insert the entry first: revisions.entryId has an FK to entries, and
			// entries.currentRevisionId has no FK (avoids a circular dependency), so this order
			// satisfies both constraints.
			tx.insert(knowledgeEntries)
				.values({
					id: entryId,
					collectionId: input.collectionId,
					title: input.title,
					slug,
					currentRevisionId: revisionId,
					currentContent: content,
					tagsJson: input.tags ?? [],
					metadataJson: input.metadata ?? null,
					status: "active",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			tx.insert(knowledgeRevisions)
				.values({
					id: revisionId,
					entryId,
					version: 1,
					format,
					content,
					contentHash: hashContent(content),
					changeNote: input.changeNote ?? null,
					authorUserId: input.authorUserId ?? null,
					createdAt: now,
				})
				.run();
		});
	} catch (err) {
		// Lost the slug race between the pre-check and insert → surface as a clean
		// validation error instead of a raw SQLite constraint failure.
		if (isUniqueConstraintError(err)) {
			throw new ValidationError(`Entry slug already exists in collection: ${slug}`);
		}
		throw err;
	}

	return getEntry(entryId, { withContent: true });
}

async function updateEntryMeta(
	id: string,
	input: {
		title?: string;
		tags?: string[];
		metadata?: Record<string, unknown>;
		status?: "active" | "archived";
	},
	principal: Principal,
) {
	await loadWritableEntry(id, principal);
	await db
		.update(knowledgeEntries)
		.set({
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.tags !== undefined ? { tagsJson: input.tags } : {}),
			...(input.metadata !== undefined ? { metadataJson: input.metadata } : {}),
			...(input.status !== undefined ? { status: input.status } : {}),
			updatedAt: nowIso(),
		})
		.where(eq(knowledgeEntries.id, id));
	return getEntry(id, { withContent: true, principal });
}

async function deleteEntry(id: string, principal: Principal) {
	await loadWritableEntry(id, principal);
	await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, id));
	return { ok: true as const };
}

/** Set an entry's ACL attributes (classification level, controlled tags, review tags, owner). */
async function updateEntryAcl(
	id: string,
	input: {
		classificationLevel?: string | null;
		controlledTags?: string[];
		reviewTags?: string[];
		ownerUserId?: string | null;
	},
) {
	await getEntry(id);
	await db
		.update(knowledgeEntries)
		.set({
			...(input.classificationLevel !== undefined
				? { classificationLevel: input.classificationLevel }
				: {}),
			...(input.controlledTags !== undefined ? { controlledTagsJson: input.controlledTags } : {}),
			...(input.reviewTags !== undefined ? { reviewTagsJson: input.reviewTags } : {}),
			...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
			updatedAt: nowIso(),
		})
		.where(eq(knowledgeEntries.id, id));
	return getEntry(id, { withContent: true });
}

/**
 * Append a new revision directly to main (copy-on-write), switching currentRevision + currentContent.
 *
 * This is the DIRECT-WRITE fast path and is gated: only admin / entry owner / holders of a write
 * grant may use it. Regular users must go through the draft → submit → review → merge workflow
 * (knowledge-branch-service) so the global revision is never changed without review.
 */
async function addRevision(
	entryId: string,
	input: {
		content: string;
		format?: Format;
		changeNote?: string;
		authorUserId?: string;
		principal?: Principal;
	},
) {
	const entryRow = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, entryId),
	});
	if (!entryRow) throw new NotFoundError("Knowledge entry", entryId);

	// Gate direct main writes. When a principal is supplied, enforce write capability.
	if (input.principal) {
		const caps = await resolvePrincipalCaps(input.principal);
		if (!canWriteMain(caps, toAclEntry(entryRow))) {
			throw new ValidationError(
				"Direct edits require write permission; submit a draft for review instead",
			);
		}
	}

	const revisionId = generateId();
	const now = nowIso();
	const format = input.format ?? "markdown";

	// Compute the next version INSIDE the transaction so the MAX(version) read and
	// the insert are atomic — two concurrent writers can't both pick the same
	// version. The unique index (entry_id, version) is the last line of defence;
	// withDbRetry handles the rare lost race by retrying with a fresh max.
	const version = await withDbRetry(
		async () =>
			db.transaction((tx) => {
				const row = tx
					.select({ v: knowledgeRevisions.version })
					.from(knowledgeRevisions)
					.where(eq(knowledgeRevisions.entryId, entryId))
					.orderBy(desc(knowledgeRevisions.version))
					.limit(1)
					.get();
				const nextVersion = (row?.v ?? 0) + 1;
				tx.insert(knowledgeRevisions)
					.values({
						id: revisionId,
						entryId,
						version: nextVersion,
						format,
						content: input.content,
						contentHash: hashContent(input.content),
						changeNote: input.changeNote ?? null,
						authorUserId: input.authorUserId ?? null,
						baseRevisionId: null,
						createdAt: now,
					})
					.run();
				tx.update(knowledgeEntries)
					.set({
						currentRevisionId: revisionId,
						currentContent: input.content,
						updatedAt: now,
					})
					.where(eq(knowledgeEntries.id, entryId))
					.run();
				return nextVersion;
			}),
		{ label: "knowledge.addRevision", maxRetries: 5 },
	);

	return { entryId, revisionId, version };
}

async function listRevisions(entryId: string, principal: Principal, opts: { limit?: number } = {}) {
	// Enforces dual-axis read ACL on the parent entry (throws NotFound if unreadable).
	await loadReadableEntry(entryId, principal);
	const limit = Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
	// NOTE: `content` is still returned here because the frontend diff view reads
	// it directly from the history list. Bounding the row count via LIMIT is the
	// main-thread safeguard; moving to metadata-only + on-demand body fetch is a
	// coordinated frontend change (tracked for the frontend phase).
	return db.query.knowledgeRevisions.findMany({
		where: eq(knowledgeRevisions.entryId, entryId),
		orderBy: [desc(knowledgeRevisions.version)],
		limit,
	});
}

async function getRevision(revisionId: string, principal: Principal) {
	const rev = await db.query.knowledgeRevisions.findFirst({
		where: eq(knowledgeRevisions.id, revisionId),
	});
	if (!rev) throw new NotFoundError("Knowledge revision", revisionId);
	// A revision is only readable if its parent entry is readable. Enforce ACL on
	// the entry; unreadable → NotFound (don't leak the revision's existence/content).
	await loadReadableEntry(rev.entryId, principal);
	return rev;
}

// ═══════════════════════════════════════════════════════════════════════
// Search (FTS5 with LIKE fallback for short queries)
// ═══════════════════════════════════════════════════════════════════════

interface EntryRow {
	id: string;
	collection_id: string;
	title: string;
	slug: string;
	tags_json: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	snippet?: string;
}

function mapRow(row: EntryRow) {
	return {
		id: row.id,
		collectionId: row.collection_id,
		title: row.title,
		slug: row.slug,
		tags: parseTags(row.tags_json ? JSON.parse(row.tags_json) : []),
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		snippet: row.snippet ?? "",
	};
}

/** Max rows any search call may return (hard cap on top of caller's limit). */
const SEARCH_MAX_LIMIT = 100;
/** Tighter cap for the unindexed short-query fallback to bound its scan cost. */
const SHORT_QUERY_FALLBACK_LIMIT = 50;

/** Whether a sanitized query can use the trigram FTS index.
 *  The trigram tokenizer requires ≥3 characters to form a token — this holds
 *  for CJK too (verified: 2 Han chars never match trigram FTS). Shorter queries
 *  must use the LIKE fallback. */
function canUseFts(safe: string): boolean {
	return safe.length >= 3;
}

function search(opts: {
	q?: string;
	collectionId?: string;
	/** Restrict to collections in this project PLUS global (project_id IS NULL) collections. */
	projectId?: string;
	tag?: string;
	limit?: number;
	match?: "and" | "or";
}) {
	const limit = Math.min(opts.limit ?? 30, SEARCH_MAX_LIMIT);
	const query = (opts.q ?? "").trim();
	const safe = sanitizeQuery(query);

	// Project-isolation clause: when a projectId is given, restrict entries to
	// collections belonging to that project OR global collections (project_id IS NULL).
	// Keeps a narrator from surfacing knowledge scoped to OTHER projects.
	const projectClause = opts.projectId
		? `AND e.collection_id IN (
				SELECT id FROM knowledge_collections WHERE project_id = ? OR project_id IS NULL
			)`
		: "";

	let rows: EntryRow[];

	if (canUseFts(safe)) {
		// FTS path: join FTS rowid back to the entries table.
		const ftsQuery = buildFtsQuery(safe, opts.match ?? "and");
		const params: (string | number | null)[] = [
			ftsQuery,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(limit);
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  snippet(knowledge_entries_fts, 1, '[', ']', '...', 96) as snippet
				 FROM knowledge_entries_fts
				 JOIN knowledge_entries e ON e.rowid = knowledge_entries_fts.rowid
				 WHERE knowledge_entries_fts MATCH ?
				   AND (? IS NULL OR e.collection_id = ?)
				   ${projectClause}
				 ORDER BY rank LIMIT ?`,
			)
			.all(...params) as EntryRow[];
	} else {
		// Short-query fallback (1-2 chars, e.g. a 2-character CJK term that the
		// trigram index can't tokenize). We still match against current_content so
		// short CJK terms find body matches, but with a TIGHT limit so the
		// unindexed scan can't run away on the main thread.
		const fallbackLimit = Math.min(limit, SHORT_QUERY_FALLBACK_LIMIT);
		const like = `%${query}%`;
		const params: (string | number | null)[] = [
			query,
			like,
			like,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(fallbackLimit);
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  substr(COALESCE(e.current_content, e.title), 1, 240) as snippet
				 FROM knowledge_entries e
				 WHERE (? = '' OR e.title LIKE ? OR e.current_content LIKE ?)
				   AND (? IS NULL OR e.collection_id = ?)
				   ${projectClause}
				 ORDER BY e.updated_at DESC LIMIT ?`,
			)
			.all(...params) as EntryRow[];
	}

	const mapped = rows.map(mapRow);
	const tag = opts.tag;
	return tag ? mapped.filter((r) => r.tags.includes(tag)) : mapped;
}

/**
 * Filter a list of entry-like rows (must carry id + collectionId) down to those the
 * principal can read, per dual-axis ACL. Used to post-filter list/search results.
 */
async function filterReadable<T extends { id: string; collectionId?: string }>(
	principal: Principal | undefined,
	rows: T[],
): Promise<T[]> {
	if (!principal) return rows;
	const caps = await resolvePrincipalCaps(principal);
	if (caps.isAdmin) return rows;

	// Batch-load the entries (with ACL fields) + their collections' default levels.
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) return rows;
	const entries = await db.query.knowledgeEntries.findMany({
		where: (e, { inArray }) => inArray(e.id, ids),
	});
	const entryById = new Map(entries.map((e) => [e.id, e]));
	const colIds = [...new Set(entries.map((e) => e.collectionId))];
	const cols = await db.query.knowledgeCollections.findMany({
		where: (c, { inArray }) => inArray(c.id, colIds),
	});
	const defaultLevelByCol = new Map(cols.map((c) => [c.id, c.defaultLevel]));

	const out: T[] = [];
	for (const r of rows) {
		const e = entryById.get(r.id);
		if (!e) continue;
		const ok = await canRead(caps, toAclEntry(e), {
			id: e.collectionId,
			defaultLevel: defaultLevelByCol.get(e.collectionId) ?? "public",
		});
		if (ok) out.push(r);
	}
	return out;
}

export const knowledgeService = {
	listCollections,
	createCollection,
	getCollection,
	updateCollection,
	deleteCollection,
	listEntries,
	getEntry,
	createEntry,
	updateEntryMeta,
	updateEntryAcl,
	deleteEntry,
	addRevision,
	listRevisions,
	getRevision,
	search,
	filterReadable,
};
