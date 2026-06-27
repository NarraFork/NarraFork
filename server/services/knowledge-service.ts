import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { knowledgeCollections, knowledgeEntries, knowledgeRevisions } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	canWriteMain,
	type Principal,
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

async function listEntries(opts: { collectionId?: string; tag?: string }) {
	const rows = await db.query.knowledgeEntries.findMany({
		where: opts.collectionId ? eq(knowledgeEntries.collectionId, opts.collectionId) : undefined,
		orderBy: (e, { desc: d }) => [d(e.updatedAt)],
	});
	const tag = opts.tag;
	const filtered = tag ? rows.filter((r) => parseTags(r.tagsJson).includes(tag)) : rows;
	// List view omits the (potentially large) currentContent body.
	return filtered.map(({ currentContent: _omit, ...rest }) => rest);
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
) {
	await getEntry(id);
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
	return getEntry(id, { withContent: true });
}

async function deleteEntry(id: string) {
	await getEntry(id);
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

	const latest = await db.query.knowledgeRevisions.findFirst({
		where: eq(knowledgeRevisions.entryId, entryId),
		orderBy: [desc(knowledgeRevisions.version)],
	});
	const nextVersion = (latest?.version ?? 0) + 1;
	const revisionId = generateId();
	const now = nowIso();
	const format = input.format ?? "markdown";

	db.transaction((tx) => {
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
	});

	return { entryId, revisionId, version: nextVersion };
}

async function listRevisions(entryId: string) {
	await getEntry(entryId);
	return db.query.knowledgeRevisions.findMany({
		where: eq(knowledgeRevisions.entryId, entryId),
		orderBy: [desc(knowledgeRevisions.version)],
	});
}

async function getRevision(revisionId: string) {
	const rev = await db.query.knowledgeRevisions.findFirst({
		where: eq(knowledgeRevisions.id, revisionId),
	});
	if (!rev) throw new NotFoundError("Knowledge revision", revisionId);
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

function search(opts: {
	q?: string;
	collectionId?: string;
	tag?: string;
	limit?: number;
	match?: "and" | "or";
}) {
	const limit = opts.limit ?? 30;
	const query = (opts.q ?? "").trim();
	const safe = sanitizeQuery(query);

	let rows: EntryRow[];

	if (safe.length >= 3) {
		// FTS path: join FTS rowid back to the entries table.
		const ftsQuery = buildFtsQuery(safe, opts.match ?? "and");
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  snippet(knowledge_entries_fts, 1, '[', ']', '...', 96) as snippet
				 FROM knowledge_entries_fts
				 JOIN knowledge_entries e ON e.rowid = knowledge_entries_fts.rowid
				 WHERE knowledge_entries_fts MATCH ?
				   AND (? IS NULL OR e.collection_id = ?)
				 ORDER BY rank LIMIT ?`,
			)
			.all(ftsQuery, opts.collectionId ?? null, opts.collectionId ?? null, limit) as EntryRow[];
	} else {
		// LIKE fallback for short/empty queries.
		const like = `%${query}%`;
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  substr(COALESCE(e.current_content, e.title), 1, 240) as snippet
				 FROM knowledge_entries e
				 WHERE (? = '' OR e.title LIKE ? OR e.current_content LIKE ?)
				   AND (? IS NULL OR e.collection_id = ?)
				 ORDER BY e.updated_at DESC LIMIT ?`,
			)
			.all(
				query,
				like,
				like,
				opts.collectionId ?? null,
				opts.collectionId ?? null,
				limit,
			) as EntryRow[];
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
