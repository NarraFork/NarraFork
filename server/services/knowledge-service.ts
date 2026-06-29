import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { knowledgeCollections, knowledgeEntries, knowledgeRevisions, users } from "../db/schema";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	canReadCollection,
	canWriteCollection,
	canWriteMain,
	isCollectionOwnerOrAdmin,
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

/**
 * Map a collection row to the AclCollection shape used by the ACL layer.
 * MUST be used at every AclCollection construction point so the collection-gate
 * fields (classificationLevel / controlledTagsJson / ownerUserId) are never dropped
 * to undefined (which would silently degrade the gate to public). See plan iron rule A.
 */
function toAclCollection(c: {
	id: string;
	defaultLevel: string;
	classificationLevel?: string | null;
	controlledTagsJson?: unknown;
	ownerUserId?: string | null;
}): AclCollection {
	return {
		id: c.id,
		defaultLevel: c.defaultLevel,
		classificationLevel: c.classificationLevel,
		controlledTagsJson: c.controlledTagsJson,
		ownerUserId: c.ownerUserId,
	};
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
	const aclCol: AclCollection = collection
		? toAclCollection(collection)
		: { id: entry.collectionId, defaultLevel: "public" };
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

/** Escape LIKE wildcards (% _) and the escape char itself so user-typed wildcards
 *  match literally instead of broadening the pattern. Pair with `ESCAPE '\'` in SQL. */
function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Collections
// ═══════════════════════════════════════════════════════════════════════

async function listCollections(projectId?: string, principal?: Principal) {
	const rows = projectId
		? await db.query.knowledgeCollections.findMany({
				where: eq(knowledgeCollections.projectId, projectId),
				orderBy: (c, { asc }) => [asc(c.name)],
			})
		: await db.query.knowledgeCollections.findMany({
				orderBy: (c, { asc }) => [asc(c.name)],
			});
	// When a principal is supplied, hide collections they cannot read (don't leak
	// existence of restricted collections). admin sees all.
	if (!principal) return rows;
	const caps = await resolvePrincipalCaps(principal);
	if (caps.isAdmin) return rows;
	const out: typeof rows = [];
	for (const c of rows) {
		if (await canReadCollection(caps, toAclCollection(c))) out.push(c);
	}
	return out;
}

async function createCollection(input: {
	name: string;
	slug?: string;
	description?: string;
	projectId?: string;
	/** Collection owner — defaults to null. Set to the creating user to activate the owner short-circuit. */
	ownerUserId?: string | null;
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
				ownerUserId: input.ownerUserId ?? null,
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

/** Assert the principal may manage (rename / delete / set-ACL / transfer) the collection: admin or owner.
 *  Collection-gate first (canReadCollection), then admin/owner. Returns the loaded row + caps. */
async function assertCanManageCollection(
	id: string,
	principal: Principal,
): Promise<{ collection: typeof knowledgeCollections.$inferSelect; caps: PrincipalCaps }> {
	const collection = await getCollection(id);
	const caps = await resolvePrincipalCaps(principal);
	// Unreadable → NotFound (don't leak); readable-but-not-manager → Validation.
	if (!(await canReadCollection(caps, toAclCollection(collection)))) {
		throw new NotFoundError("Knowledge collection", id);
	}
	if (!isCollectionOwnerOrAdmin(caps, toAclCollection(collection))) {
		throw new ValidationError("You do not have permission to manage this collection");
	}
	return { collection, caps };
}

async function updateCollection(
	id: string,
	input: { name?: string; description?: string | null },
	principal?: Principal,
) {
	if (principal) await assertCanManageCollection(id, principal);
	else await getCollection(id);
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

async function deleteCollection(id: string, principal?: Principal) {
	if (principal) await assertCanManageCollection(id, principal);
	else await getCollection(id);
	await db.delete(knowledgeCollections).where(eq(knowledgeCollections.id, id));
	return { ok: true as const };
}

/** Verify a user id exists (transfer target must be a real user). */
async function assertUserExists(userId: string): Promise<void> {
	const row = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { id: true },
	});
	if (!row) throw new ValidationError(`User not found: ${userId}`);
}

/**
 * Transfer collection ownership. Authorization: admin or current owner (collection-gate first).
 * Only admin may set owner to null (abandon → unowned); a non-admin owner must transfer to a
 * specific existing user. Returns a lightweight result (no principal-gated readback).
 */
async function transferCollectionOwner(
	id: string,
	newOwnerUserId: string | null,
	principal: Principal,
) {
	const { caps } = await assertCanManageCollection(id, principal);
	if (newOwnerUserId === null) {
		if (!caps.isAdmin) {
			throw new ValidationError(
				"Owners cannot abandon ownership; transfer to a specific user (only an admin may set no owner)",
			);
		}
	} else {
		await assertUserExists(newOwnerUserId);
	}
	await db
		.update(knowledgeCollections)
		.set({ ownerUserId: newOwnerUserId, updatedAt: nowIso() })
		.where(eq(knowledgeCollections.id, id));
	return { ok: true as const, collectionId: id, ownerUserId: newOwnerUserId };
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
		const aclCol: AclCollection = collection
			? toAclCollection(collection)
			: { id: entry.collectionId, defaultLevel: "public" };
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
	/** Initial owner. Defaults to the creating user (authorUserId) so the
	 *  owner short-circuit in canRead/canWriteMain/canReview is meaningful. */
	ownerUserId?: string | null;
	/** When provided, enforce that the principal may READ + WRITE the target collection. */
	principal?: Principal;
}) {
	// Ensure collection exists (and capture it for the collection-write gate).
	const collection = await getCollection(input.collectionId);

	// Collection gate: creating an entry requires both read access to the collection
	// (don't leak existence) and write capability (admin / collection owner / write grant).
	if (input.principal) {
		const caps = await resolvePrincipalCaps(input.principal);
		const aclCol = toAclCollection(collection);
		if (!(await canReadCollection(caps, aclCol))) {
			throw new NotFoundError("Knowledge collection", input.collectionId);
		}
		if (!canWriteCollection(caps, aclCol)) {
			throw new ValidationError("You do not have permission to create entries in this collection");
		}
	}

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
					// Default the owner to the creator so they retain read/write/review
					// authority over their own entry without a separate grant.
					ownerUserId: input.ownerUserId ?? input.authorUserId ?? null,
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

/**
 * Assert the principal may MANAGE (transfer ownership of) the entry. Collection-gate first
 * (canReadCollection), then admin OR current entry owner. Deliberately does NOT include
 * write-grant holders: writing content is not the same as changing ownership. Any miss →
 * NotFoundError (don't leak existence of entries the caller cannot manage).
 */
async function assertCanManageEntry(
	id: string,
	principal: Principal,
): Promise<{ entry: typeof knowledgeEntries.$inferSelect; caps: PrincipalCaps }> {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, id),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", id);
	const caps = await resolvePrincipalCaps(principal);
	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, entry.collectionId),
	});
	const aclCol: AclCollection = collection
		? toAclCollection(collection)
		: { id: entry.collectionId, defaultLevel: "public" };
	// Collection gate first: someone locked out of the collection cannot manage entries in it,
	// even if they happen to be the entry owner (collection is the access boundary).
	if (!(await canReadCollection(caps, aclCol))) {
		throw new NotFoundError("Knowledge entry", id);
	}
	if (!caps.isAdmin && entry.ownerUserId !== caps.userId) {
		throw new NotFoundError("Knowledge entry", id);
	}
	return { entry, caps };
}

/**
 * Transfer entry ownership. Authorization: admin or current owner (collection-gate first).
 * Only admin may set owner to null (abandon → unowned). Returns a lightweight result and does
 * NOT read the entry back through a principal-gated path (the previous owner loses their owner
 * short-circuit after transfer, so a gated readback could wrongly throw NotFound after a
 * successful write).
 */
async function transferEntryOwner(id: string, newOwnerUserId: string | null, principal: Principal) {
	const { caps } = await assertCanManageEntry(id, principal);
	if (newOwnerUserId === null) {
		if (!caps.isAdmin) {
			throw new ValidationError(
				"Owners cannot abandon ownership; transfer to a specific user (only an admin may set no owner)",
			);
		}
	} else {
		await assertUserExists(newOwnerUserId);
	}
	await db
		.update(knowledgeEntries)
		.set({ ownerUserId: newOwnerUserId, updatedAt: nowIso() })
		.where(eq(knowledgeEntries.id, id));
	return { ok: true as const, entryId: id, ownerUserId: newOwnerUserId };
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

	// Gate direct main writes. When a principal is supplied, enforce the COLLECTION READ
	// boundary (this path does NOT go through loadReadableEntry, so it must re-check the
	// collection itself — otherwise a global write-grant holder could write into a
	// collection they cannot even read) and then the existing entry write authority
	// (admin / entry owner / write grant via canWriteMain).
	if (input.principal) {
		const caps = await resolvePrincipalCaps(input.principal);
		const collection = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, entryRow.collectionId),
		});
		const aclCol: AclCollection = collection
			? toAclCollection(collection)
			: { id: entryRow.collectionId, defaultLevel: "public" };
		// Collection unreadable → NotFound (don't leak existence of restricted collections).
		if (!(await canReadCollection(caps, aclCol))) {
			throw new NotFoundError("Knowledge entry", entryId);
		}
		// Write authority: entry-level (admin / entry owner / write grant) OR collection
		// owner. canWriteMain already covers admin/owner/write-grant; canWriteCollection
		// additionally lets the collection owner write entries in their own collection.
		if (!canWriteMain(caps, toAclEntry(entryRow)) && !canWriteCollection(caps, aclCol)) {
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
	/** Set by the draft search branch — this row reflects the caller's own draft. */
	fromDraft?: boolean;
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
		fromDraft: row.fromDraft ?? false,
	};
}

/** Max rows any search call may return (hard cap on top of caller's limit). */
const SEARCH_MAX_LIMIT = 100;
/** Tighter cap for the unindexed short-query fallback to bound its scan cost. */
const SHORT_QUERY_FALLBACK_LIMIT = 50;
/** Active draft statuses that shadow the main version (mirror of branch service). */
const ACTIVE_DRAFT_STATUSES = ["draft", "pending_review", "changes_requested"] as const;
/** Hard cap on how many of a user's drafts participate in a single shadowed search. */
const DRAFT_SHADOW_MAX = 200;

/** Whether a sanitized query can use the trigram FTS index.
 *  The trigram tokenizer requires ≥3 characters to form a token — this holds
 *  for CJK too (verified: 2 Han chars never match trigram FTS). Shorter queries
 *  must use the LIKE fallback. */
function canUseFts(safe: string): boolean {
	return safe.length >= 3;
}

/** Entry ids the given user has an ACTIVE draft on — these get shadowed by the draft. */
function activeDraftEntryIds(draftUserId: string): string[] {
	const rows = sqlite
		.prepare(
			`SELECT DISTINCT entry_id FROM knowledge_drafts
			 WHERE author_user_id = ? AND status IN (?, ?, ?)
			 LIMIT ?`,
		)
		.all(draftUserId, ...ACTIVE_DRAFT_STATUSES, DRAFT_SHADOW_MAX) as { entry_id: string }[];
	return rows.map((r) => r.entry_id);
}

/** Build `AND e.id NOT IN (?,?,…)` + its bound params. Empty set → no clause, no params.
 *  The ids are bound as positional params (never interpolated) to prevent injection. */
function buildExcludeClause(excludeEntryIds: string[]): { clause: string; params: string[] } {
	if (excludeEntryIds.length === 0) return { clause: "", params: [] };
	const placeholders = excludeEntryIds.map(() => "?").join(",");
	return { clause: `AND e.id NOT IN (${placeholders})`, params: excludeEntryIds };
}

type SearchOpts = {
	q?: string;
	collectionId?: string;
	/** Restrict to collections in this project PLUS global (project_id IS NULL) collections. */
	projectId?: string;
	tag?: string;
	limit?: number;
	match?: "and" | "or";
	/** When set, the caller's own active drafts shadow the main version (working-copy view). */
	draftUserId?: string;
};

/** Search the MAIN (committed) versions, optionally excluding shadowed entries. */
function searchMain(
	opts: SearchOpts,
	limit: number,
	projectClause: string,
	excludeEntryIds: string[],
): EntryRow[] {
	const query = (opts.q ?? "").trim();
	const safe = sanitizeQuery(query);
	const { clause: excludeClause, params: excludeParams } = buildExcludeClause(excludeEntryIds);

	if (canUseFts(safe)) {
		const ftsQuery = buildFtsQuery(safe, opts.match ?? "and");
		const params: (string | number | null)[] = [
			ftsQuery,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(...excludeParams);
		params.push(limit);
		return sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  snippet(knowledge_entries_fts, 1, '[', ']', '...', 96) as snippet
				 FROM knowledge_entries_fts
				 JOIN knowledge_entries e ON e.rowid = knowledge_entries_fts.rowid
				 WHERE knowledge_entries_fts MATCH ?
				   AND (? IS NULL OR e.collection_id = ?)
				   ${projectClause}
				   ${excludeClause}
				 ORDER BY rank LIMIT ?`,
			)
			.all(...params) as EntryRow[];
	}

	// Short-query fallback (1-2 chars, e.g. a 2-character CJK term that the trigram index
	// can't tokenize). Matches title+current_content with a TIGHT limit so the unindexed
	// scan can't run away on the main thread.
	const fallbackLimit = Math.min(limit, SHORT_QUERY_FALLBACK_LIMIT);
	const like = `%${escapeLike(query)}%`;
	const params: (string | number | null)[] = [
		query,
		like,
		like,
		opts.collectionId ?? null,
		opts.collectionId ?? null,
	];
	if (opts.projectId) params.push(opts.projectId);
	params.push(...excludeParams);
	params.push(fallbackLimit);
	return sqlite
		.prepare(
			`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
			  e.created_at, e.updated_at,
			  substr(COALESCE(e.current_content, e.title), 1, 240) as snippet
			 FROM knowledge_entries e
			 WHERE (? = '' OR e.title LIKE ? ESCAPE '\\' OR e.current_content LIKE ? ESCAPE '\\')
			   AND (? IS NULL OR e.collection_id = ?)
			   ${projectClause}
			   ${excludeClause}
			 ORDER BY e.updated_at DESC LIMIT ?`,
		)
		.all(...params) as EntryRow[];
}

/** Search the caller's own ACTIVE drafts (title de-normalized + content). Rows are tagged
 *  fromDraft. JOINs the FTS rowid back to knowledge_drafts.rowid, then to the parent entry. */
function searchDrafts(
	opts: SearchOpts,
	draftUserId: string,
	limit: number,
	projectClause: string,
): EntryRow[] {
	const query = (opts.q ?? "").trim();
	const safe = sanitizeQuery(query);
	let rows: EntryRow[];

	if (canUseFts(safe)) {
		const ftsQuery = buildFtsQuery(safe, opts.match ?? "and");
		const params: (string | number | null)[] = [
			ftsQuery,
			draftUserId,
			...ACTIVE_DRAFT_STATUSES,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(limit);
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  snippet(knowledge_drafts_fts, 1, '[', ']', '...', 96) as snippet
				 FROM knowledge_drafts_fts
				 JOIN knowledge_drafts d ON d.rowid = knowledge_drafts_fts.rowid
				 JOIN knowledge_entries e ON e.id = d.entry_id
				 WHERE knowledge_drafts_fts MATCH ?
				   AND d.author_user_id = ?
				   AND d.status IN (?, ?, ?)
				   AND (? IS NULL OR e.collection_id = ?)
				   ${projectClause}
				 ORDER BY rank LIMIT ?`,
			)
			.all(...params) as EntryRow[];
	} else {
		const fallbackLimit = Math.min(limit, SHORT_QUERY_FALLBACK_LIMIT);
		const like = `%${escapeLike(query)}%`;
		const params: (string | number | null)[] = [
			query,
			like,
			like,
			draftUserId,
			...ACTIVE_DRAFT_STATUSES,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(fallbackLimit);
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  substr(COALESCE(d.content, e.title), 1, 240) as snippet
				 FROM knowledge_drafts d
				 JOIN knowledge_entries e ON e.id = d.entry_id
				 WHERE (? = '' OR e.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')
				   AND d.author_user_id = ?
				   AND d.status IN (?, ?, ?)
				   AND (? IS NULL OR e.collection_id = ?)
				   ${projectClause}
				 ORDER BY d.updated_at DESC LIMIT ?`,
			)
			.all(...params) as EntryRow[];
	}
	for (const r of rows) r.fromDraft = true;
	return rows;
}

function search(opts: SearchOpts) {
	const limit = Math.min(opts.limit ?? 30, SEARCH_MAX_LIMIT);

	// Project-isolation clause: when a projectId is given, restrict entries to
	// collections belonging to that project OR global collections (project_id IS NULL).
	// Keeps a narrator from surfacing knowledge scoped to OTHER projects.
	const projectClause = opts.projectId
		? `AND e.collection_id IN (
				SELECT id FROM knowledge_collections WHERE project_id = ? OR project_id IS NULL
			)`
		: "";

	// No draft context → plain main-version search (unchanged behaviour for routes/injection).
	if (!opts.draftUserId) {
		const rows = searchMain(opts, limit, projectClause, []);
		const mapped = rows.map(mapRow);
		const tag = opts.tag;
		return tag ? mapped.filter((r) => r.tags.includes(tag)) : mapped;
	}

	// Working-copy view: the caller's active drafts shadow the main version. The shadowed
	// set (their draft entry ids) is excluded from the main search and supplied by the draft
	// search instead — the two sets are identical, so the results never overlap (no dedup).
	const shadowedEntryIds = activeDraftEntryIds(opts.draftUserId);

	// Fast path: the user has no active drafts → nothing to shadow. Fall back to the plain
	// main-version search (one cheap indexed lookup above instead of a second FTS query).
	// This keeps the hot passive-injection path cheap for the common no-draft case.
	if (shadowedEntryIds.length === 0) {
		const rows = searchMain(opts, limit, projectClause, []);
		const mapped = rows.map(mapRow);
		const tag = opts.tag;
		return tag ? mapped.filter((r) => r.tags.includes(tag)) : mapped;
	}

	const draftRows = searchDrafts(opts, opts.draftUserId, limit, projectClause);
	const mainRows = searchMain(opts, limit, projectClause, shadowedEntryIds);

	// Draft hits first, then main hits; truncate to the caller's limit.
	const mapped = [...draftRows, ...mainRows].map(mapRow);
	const tag = opts.tag;
	const filtered = tag ? mapped.filter((r) => r.tags.includes(tag)) : mapped;
	return filtered.slice(0, limit);
}

/**
 * Filter a list of entry-like rows (must carry id + collectionId) down to those the
 * principal can read, per dual-axis ACL. Used to post-filter list/search results.
 */
/**
 * Filter a list of entry-like rows (must carry id + collectionId) down to those the
 * principal can read, per dual-axis ACL. Used to post-filter list/search results.
 *
 * `opts.caps` lets hot callers (e.g. passive injection) pass already-resolved caps
 * to avoid a redundant grant lookup; when omitted, caps are resolved from `principal`.
 */
async function filterReadable<T extends { id: string; collectionId?: string }>(
	principal: Principal | undefined,
	rows: T[],
	opts: { caps?: PrincipalCaps } = {},
): Promise<T[]> {
	if (!principal) return rows;
	const caps = opts.caps ?? (await resolvePrincipalCaps(principal));
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
	// Cache the FULL collection row (not just defaultLevel) so the collection gate
	// in canRead has classificationLevel / controlledTags / owner — otherwise the
	// gate silently degrades to public (iron rule A).
	const colById = new Map(cols.map((c) => [c.id, c]));

	const out: T[] = [];
	for (const r of rows) {
		const e = entryById.get(r.id);
		if (!e) continue;
		const col = colById.get(e.collectionId);
		const aclCol: AclCollection = col
			? toAclCollection(col)
			: { id: e.collectionId, defaultLevel: "public" };
		if (await canRead(caps, toAclEntry(e), aclCol)) out.push(r);
	}
	return out;
}

export const knowledgeService = {
	listCollections,
	createCollection,
	getCollection,
	updateCollection,
	deleteCollection,
	transferCollectionOwner,
	listEntries,
	getEntry,
	createEntry,
	updateEntryMeta,
	updateEntryAcl,
	deleteEntry,
	transferEntryOwner,
	addRevision,
	listRevisions,
	getRevision,
	search,
	filterReadable,
};
