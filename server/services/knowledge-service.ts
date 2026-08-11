import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { knowledgeCollections, knowledgeEntries, knowledgeRevisions, users } from "../db/schema";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
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
import { recordKnowledgeAclEvent } from "./knowledge-audit";
import { emitEntryDrifted } from "./knowledge-notify";

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
 *  (used for passive injection, where the input is a natural-language sentence).
 *  field, when set, restricts the match to a single FTS column (e.g. "current_keywords"
 *  so passive injection only fires on author-declared keywords, never body text). */
function buildFtsQuery(safeQuery: string, match: "and" | "or" = "and", field?: string): string {
	const terms = safeQuery
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => `"${w}"*`);
	if (terms.length === 0) return "";
	const joined = terms.join(match === "or" ? " OR " : " ");
	// FTS5 column filter: `{col} : (expr)` restricts the whole expression to one column.
	return field ? `{${field}} : (${joined})` : joined;
}

function parseTags(tagsJson: unknown): string[] {
	if (Array.isArray(tagsJson)) return tagsJson.filter((t): t is string => typeof t === "string");
	return [];
}

/**
 * Normalize author-declared keywords before persisting.
 * Trims, drops empties/dupes (case-insensitive), and applies a LENIENT minimum length
 * (latin < settings.knowledge.minKeywordLen, CJK < 2) purely to keep single-character
 * noise out of passive injection. This is a soft floor, NOT a hard validation rule —
 * keyword quality is steered by the tool prompts, so nothing here rejects a write.
 */
function normalizeKeywords(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const minLatin = Math.max(settings.knowledge.minKeywordLen ?? 3, 2);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const kw = item.trim();
		if (!kw) continue;
		const key = kw.toLowerCase();
		if (seen.has(key)) continue;
		const hasCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(kw);
		if (hasCjk) {
			if (kw.length < 2) continue;
		} else if (kw.length < minLatin) {
			continue;
		}
		seen.add(key);
		out.push(kw);
	}
	return out;
}

/** Join normalized keywords into the space-separated mirror stored in current_keywords. */
function keywordsMirror(keywords: string[]): string | null {
	return keywords.length > 0 ? keywords.join(" ") : null;
}

/** Escape LIKE wildcards (% _) and the escape char itself so user-typed wildcards
 *  match literally instead of broadening the pattern. Pair with `ESCAPE '\'` in SQL. */
function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Collections
// ═══════════════════════════════════════════════════════════════════════

/**
 * Hard cap on collections returned by one list call.
 *
 * A deployment has tens of collections, not thousands, so this ceiling is never reached in
 * practice — it exists because an unbounded `findMany` on the main thread is the shape the
 * performance rules forbid outright, not because the row count is expected to be large. The
 * per-row ACL filter below makes the cost of a pathological table worse than a plain scan.
 */
const COLLECTION_LIST_MAX = 500;

async function listCollections(projectId?: string, principal?: Principal) {
	const rows = projectId
		? await db.query.knowledgeCollections.findMany({
				where: eq(knowledgeCollections.projectId, projectId),
				orderBy: (c, { asc }) => [asc(c.name)],
				limit: COLLECTION_LIST_MAX,
			})
		: await db.query.knowledgeCollections.findMany({
				orderBy: (c, { asc }) => [asc(c.name)],
				limit: COLLECTION_LIST_MAX,
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
	// Load the row BEFORE deleting: the audit detail describes the gate that existed, and after
	// the delete there is nothing left to read it from.
	const collection = principal
		? (await assertCanManageCollection(id, principal)).collection
		: await getCollection(id);
	await db.delete(knowledgeCollections).where(eq(knowledgeCollections.id, id));
	// Deleting a collection cascades to every entry in it — the single most destructive act on this
	// surface, and reachable by a collection owner rather than admin only. Redacted as everywhere
	// else: the gate (level name, tag ids) and the owner, never entry titles or content.
	recordKnowledgeAclEvent({
		actorUserId: principal?.userId ?? null,
		actorRole: principal?.role ?? null,
		eventType: "collection_deleted",
		targetType: "collection",
		targetId: id,
		detail: {
			projectId: collection.projectId ?? null,
			ownerUserId: collection.ownerUserId ?? null,
			classificationLevel: collection.classificationLevel ?? null,
			defaultLevel: collection.defaultLevel,
			controlledTags: collection.controlledTagsJson ?? [],
		},
	});
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
	const previousOwnerUserId = (await getCollection(id)).ownerUserId ?? null;
	await db
		.update(knowledgeCollections)
		.set({ ownerUserId: newOwnerUserId, updatedAt: nowIso() })
		.where(eq(knowledgeCollections.id, id));
	// Ownership is an ACL short-circuit, so this silently changed what both parties can see.
	eventBus.emit({
		type: "knowledge:owner_transferred",
		targetType: "collection",
		targetId: id,
		previousOwnerUserId,
		newOwnerUserId,
	});
	recordKnowledgeAclEvent({
		actorUserId: principal.userId ?? null,
		actorRole: principal.role ?? null,
		eventType: "collection_owner_transferred",
		subjectType: newOwnerUserId ? "user" : null,
		subjectId: newOwnerUserId,
		targetType: "collection",
		targetId: id,
		detail: { previousOwnerUserId, newOwnerUserId },
	});
	return { ok: true as const, collectionId: id, ownerUserId: newOwnerUserId };
}

// ═══════════════════════════════════════════════════════════════════════
// Entries + revisions
// ═══════════════════════════════════════════════════════════════════════

/** Hard cap on rows returned by any single list query (main-thread safety). */
const LIST_MAX_LIMIT = 200;

const LIST_DEFAULT_LIMIT = 100;

/** The only entry columns the dual-axis read gate needs (see `toAclEntry`). Narrower than
 *  ENTRY_LIST_COLUMNS: ACL filtering never renders a row, it only decides visibility, so it
 *  must not pull title/slug — let alone the currentContent blob — off disk for every
 *  candidate. Used by `filterReadable`, which every list and search response passes through. */
const ENTRY_ACL_COLUMNS = {
	id: true,
	collectionId: true,
	ownerUserId: true,
	classificationLevel: true,
	controlledTagsJson: true,
	reviewTagsJson: true,
} as const;

/** The only collection columns the collection gate needs (see `toAclCollection`). */
const COLLECTION_ACL_COLUMNS = {
	id: true,
	defaultLevel: true,
	classificationLevel: true,
	controlledTagsJson: true,
	ownerUserId: true,
} as const;

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

async function getEntry(
	id: string,
	opts: { withContent?: boolean; principal?: Principal; projectId?: string } = {},
) {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, id),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", id);

	// Project context is an independent boundary from user ACL. Admin/owner may
	// bypass the knowledge ACL, but never another narrator's project context.
	const collection =
		opts.principal || opts.projectId
			? await db.query.knowledgeCollections.findFirst({
					where: eq(knowledgeCollections.id, entry.collectionId),
				})
			: undefined;
	if (opts.projectId && collection?.projectId && collection.projectId !== opts.projectId) {
		throw new NotFoundError("Knowledge entry", id);
	}

	// ACL: when a principal is supplied, enforce dual-axis read access.
	// Unauthorized → treat as not found (don't leak existence).
	if (opts.principal) {
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
	keywords?: string[];
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
	const keywords = normalizeKeywords(input.keywords);

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
					currentKeywords: keywordsMirror(keywords),
					tagsJson: input.tags ?? [],
					keywordsJson: keywords,
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
		keywords?: string[];
		metadata?: Record<string, unknown>;
		status?: "active" | "archived";
	},
	principal: Principal,
) {
	await loadWritableEntry(id, principal);
	const keywords = input.keywords !== undefined ? normalizeKeywords(input.keywords) : undefined;
	await db
		.update(knowledgeEntries)
		.set({
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.tags !== undefined ? { tagsJson: input.tags } : {}),
			...(keywords !== undefined
				? { keywordsJson: keywords, currentKeywords: keywordsMirror(keywords) }
				: {}),
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
	const previousOwnerUserId =
		(
			await db.query.knowledgeEntries.findFirst({
				where: eq(knowledgeEntries.id, id),
				columns: { ownerUserId: true },
			})
		)?.ownerUserId ?? null;
	await db
		.update(knowledgeEntries)
		.set({ ownerUserId: newOwnerUserId, updatedAt: nowIso() })
		.where(eq(knowledgeEntries.id, id));
	// Both parties' effective access just changed (owner is an ACL short-circuit).
	eventBus.emit({
		type: "knowledge:owner_transferred",
		targetType: "entry",
		targetId: id,
		previousOwnerUserId,
		newOwnerUserId,
	});
	recordKnowledgeAclEvent({
		actorUserId: principal.userId ?? null,
		actorRole: principal.role ?? null,
		eventType: "entry_owner_transferred",
		subjectType: newOwnerUserId ? "user" : null,
		subjectId: newOwnerUserId,
		targetType: "entry",
		targetId: id,
		detail: { previousOwnerUserId, newOwnerUserId },
	});
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
	/** Who is making the change — recorded in the ACL audit trail. Optional so internal paths and
	 *  tests can call this without inventing an actor. */
	actor?: { userId?: string | null; role?: string | null },
) {
	// BEFORE state for the audit diff. Classification + tags + owner only; no content.
	const before = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, id),
		columns: {
			classificationLevel: true,
			controlledTagsJson: true,
			reviewTagsJson: true,
			ownerUserId: true,
		},
	});
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
	// Changing an entry's level or controlled tags changes who may read it — the single most
	// audit-worthy operation in the knowledge base. Names/ids only, never the body.
	recordKnowledgeAclEvent({
		actorUserId: actor?.userId ?? null,
		actorRole: actor?.role ?? null,
		eventType: "entry_acl_updated",
		targetType: "entry",
		targetId: id,
		detail: {
			before: {
				classificationLevel: before?.classificationLevel ?? null,
				controlledTags: before?.controlledTagsJson ?? [],
				reviewTags: before?.reviewTagsJson ?? [],
				ownerUserId: before?.ownerUserId ?? null,
			},
			// Only the fields actually supplied were changed; the rest carry over.
			changed: {
				...(input.classificationLevel !== undefined
					? { classificationLevel: input.classificationLevel }
					: {}),
				...(input.controlledTags !== undefined ? { controlledTags: input.controlledTags } : {}),
				...(input.reviewTags !== undefined ? { reviewTags: input.reviewTags } : {}),
				...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
			},
		},
	});
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

	// Post-commit: main moved, so anyone else holding an active personal version of this entry is
	// now based on a stale revision. They previously had no way to learn this without opening the
	// entry's draft tab. Author excluded — they made the change.
	//
	// Only ids cross the bus; the listener resolves who is affected (see knowledge-notify).
	emitEntryDrifted(entryId, input.authorUserId ?? null);

	return { entryId, revisionId, version };
}

/**
 * Version history for an entry — METADATA ONLY.
 *
 * `content` is deliberately projected away: a history list of N versions of a large document used
 * to ship N full bodies in one response, which is exactly the "list endpoints must not read big
 * fields" rule. `contentLength` is computed in SQL so the UI can still show size, and the diff
 * view fetches the two versions it actually compares via `getRevision`.
 */
async function listRevisions(entryId: string, principal: Principal, opts: { limit?: number } = {}) {
	// Enforces dual-axis read ACL on the parent entry (throws NotFound if unreadable).
	await loadReadableEntry(entryId, principal);
	const limit = Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
	return db.query.knowledgeRevisions.findMany({
		where: eq(knowledgeRevisions.entryId, entryId),
		columns: {
			id: true,
			entryId: true,
			version: true,
			format: true,
			contentHash: true,
			changeNote: true,
			authorUserId: true,
			authorNarratorId: true,
			baseRevisionId: true,
			createdAt: true,
		},
		extras: (r, { sql }) => ({
			contentLength: sql<number>`length(${r.content})`.as("content_length"),
		}),
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
	/** Set by the draft search branch — 1 when the draft's fork point is behind main. */
	drifted?: number | boolean;
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
		drifted: !!row.drifted,
	};
}

/** Max rows any search call may return (hard cap on top of caller's limit). */
const SEARCH_MAX_LIMIT = 100;
/** Tighter cap for the unindexed short-query fallback to bound its scan cost. */
const SHORT_QUERY_FALLBACK_LIMIT = 50;
/** Personal-entry status that shadows the main version (mirror of branch service). */
const ACTIVE_DRAFT_STATUS = "active";
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
			 WHERE author_user_id = ? AND status = ? AND entry_id IS NOT NULL
			 LIMIT ?`,
		)
		.all(draftUserId, ACTIVE_DRAFT_STATUS, DRAFT_SHADOW_MAX) as { entry_id: string }[];
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
	/** Restrict the FTS match to a single column (e.g. "current_keywords" for passive injection). */
	field?: string;
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
		const ftsQuery = buildFtsQuery(safe, opts.match ?? "and", opts.field);
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
	// can't tokenize). Matches with a TIGHT limit so the unindexed scan can't run away on
	// the main thread. When field is restricted (passive injection → "current_keywords"),
	// only that column is matched so body text never triggers a hit.
	const fallbackLimit = Math.min(limit, SHORT_QUERY_FALLBACK_LIMIT);
	const like = `%${escapeLike(query)}%`;
	const matchExpr =
		opts.field === "current_keywords"
			? `e.current_keywords LIKE ? ESCAPE '\\'`
			: `e.title LIKE ? ESCAPE '\\' OR e.current_content LIKE ? ESCAPE '\\'`;
	const params: (string | number | null)[] = [query];
	// One LIKE param for the keyword-only column, two for the title+content default.
	if (opts.field === "current_keywords") params.push(like);
	else params.push(like, like);
	params.push(opts.collectionId ?? null, opts.collectionId ?? null);
	if (opts.projectId) params.push(opts.projectId);
	params.push(...excludeParams);
	params.push(fallbackLimit);
	return sqlite
		.prepare(
			`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
			  e.created_at, e.updated_at,
			  substr(COALESCE(e.current_content, e.title), 1, 240) as snippet
			 FROM knowledge_entries e
			 WHERE (? = '' OR ${matchExpr})
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
			ACTIVE_DRAFT_STATUS,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(limit);
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  (d.base_revision_id IS NOT NULL AND d.base_revision_id != e.current_revision_id) as drifted,
				  snippet(knowledge_drafts_fts, 1, '[', ']', '...', 96) as snippet
				 FROM knowledge_drafts_fts
				 JOIN knowledge_drafts d ON d.rowid = knowledge_drafts_fts.rowid
				 JOIN knowledge_entries e ON e.id = d.entry_id
				 WHERE knowledge_drafts_fts MATCH ?
				   AND d.author_user_id = ?
				   AND d.status = ?
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
			ACTIVE_DRAFT_STATUS,
			opts.collectionId ?? null,
			opts.collectionId ?? null,
		];
		if (opts.projectId) params.push(opts.projectId);
		params.push(fallbackLimit);
		rows = sqlite
			.prepare(
				`SELECT e.id, e.collection_id, e.title, e.slug, e.tags_json, e.status,
				  e.created_at, e.updated_at,
				  (d.base_revision_id IS NOT NULL AND d.base_revision_id != e.current_revision_id) as drifted,
				  substr(COALESCE(d.content, e.title), 1, 240) as snippet
				 FROM knowledge_drafts d
				 JOIN knowledge_entries e ON e.id = d.entry_id
				 WHERE (? = '' OR e.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')
				   AND d.author_user_id = ?
				   AND d.status = ?
				   AND (? IS NULL OR e.collection_id = ?)
				   ${projectClause}
				 ORDER BY d.updated_at DESC LIMIT ?`,
			)
			.all(...params) as EntryRow[];
	}
	for (const r of rows) r.fromDraft = true;
	return rows;
}

function parseStringArrayJson(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
}

/**
 * Hard cap for the passive-injection dictionary scan. The scan reads only lightweight
 * metadata + keyword JSON (never full content) and is project/collection scoped when
 * possible. The compiled Aho-Corasick matcher is cached per scope (see
 * knowledge-injection.ts) and only rebuilt when keywordInjectionCandidatesSignature
 * changes, so this full read runs on cache-miss / candidate-set change, not per turn.
 */
const KEYWORD_INJECTION_CANDIDATE_LIMIT = 5000;

function listKeywordInjectionCandidates(opts: { collectionId?: string; projectId?: string } = {}) {
	const projectClause = opts.projectId
		? `AND e.collection_id IN (
				SELECT id FROM knowledge_collections WHERE project_id = ? OR project_id IS NULL
			)`
		: "";
	const params: (string | number | null)[] = [opts.collectionId ?? null, opts.collectionId ?? null];
	if (opts.projectId) params.push(opts.projectId);
	params.push(KEYWORD_INJECTION_CANDIDATE_LIMIT);
	const rows = sqlite
		.prepare(
			`SELECT e.id, e.collection_id, e.title, e.current_revision_id, e.tags_json, e.keywords_json, e.updated_at
			 FROM knowledge_entries e
			 WHERE e.status = 'active'
			   AND e.current_keywords IS NOT NULL
			   AND (? IS NULL OR e.collection_id = ?)
			   ${projectClause}
			 ORDER BY e.updated_at DESC LIMIT ?`,
		)
		.all(...params) as {
		id: string;
		collection_id: string;
		title: string;
		tags_json: string | null;
		keywords_json: string | null;
		updated_at: string;
		current_revision_id: string | null;
	}[];

	return rows
		.map((row) => ({
			id: row.id,
			collectionId: row.collection_id,
			title: row.title,
			entryRevisionId: row.current_revision_id,
			tags: parseStringArrayJson(row.tags_json),
			keywords: parseStringArrayJson(row.keywords_json),
			updatedAt: row.updated_at,
		}))
		.filter((row) => row.keywords.length > 0);
}

/**
 * Cheap change-detection signature for a scope's keyword-injection candidate set.
 *
 * Returns `count:maxUpdatedAt` computed with a single indexed aggregate (no row
 * materialization, no JSON parse). Any insert/update/keyword change bumps
 * `max(updated_at)`, and any delete/insert changes `count`, so callers can reuse a
 * built Aho-Corasick matcher until this signature changes — keeping the hot passive
 * injection path off the 5000-row read + trie rebuild on every tool output.
 */
function keywordInjectionCandidatesSignature(
	opts: { collectionId?: string; projectId?: string } = {},
): string {
	const projectClause = opts.projectId
		? `AND e.collection_id IN (
				SELECT id FROM knowledge_collections WHERE project_id = ? OR project_id IS NULL
			)`
		: "";
	const params: (string | null)[] = [opts.collectionId ?? null, opts.collectionId ?? null];
	if (opts.projectId) params.push(opts.projectId);
	const row = sqlite
		.prepare(
			`SELECT COUNT(*) as cnt, COALESCE(MAX(e.updated_at), '') as max_updated
			 FROM knowledge_entries e
			 WHERE e.status = 'active'
			   AND e.current_keywords IS NOT NULL
			   AND (? IS NULL OR e.collection_id = ?)
			   ${projectClause}`,
		)
		.get(...params) as { cnt: number; max_updated: string };
	return `${row.cnt}:${row.max_updated}`;
}

/** Fetch bounded snippets only for final injected hits, avoiding large-field reads in the scan. */
const SNIPPETS_LOOKUP_MAX = 100;
function snippetsByEntryIds(entryIds: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const ids = entryIds.slice(0, SNIPPETS_LOOKUP_MAX);
	if (ids.length === 0) return out;
	const placeholders = ids.map(() => "?").join(",");
	const rows = sqlite
		.prepare(
			`SELECT id, substr(COALESCE(current_content, title), 1, 512) as snippet
			 FROM knowledge_entries WHERE id IN (${placeholders})`,
		)
		.all(...ids) as { id: string; snippet: string | null }[];
	for (const row of rows) out.set(row.id, row.snippet ?? "");
	return out;
}

type KnowledgeInjectionSource = "user_message" | "tool_output" | "system_continuation";

function listInjectedEntryIds(narratorId: string, compactSeq: number): Set<string> {
	const rows = sqlite
		.prepare(
			`SELECT entry_id FROM knowledge_injection_events
			 WHERE narrator_id = ? AND compact_seq = ?`,
		)
		.all(narratorId, compactSeq) as { entry_id: string }[];
	return new Set(rows.map((row) => row.entry_id));
}

function recordInjectionEvents(input: {
	narratorId: string;
	compactSeq: number;
	source: KnowledgeInjectionSource;
	triggerMessageId?: string | null;
	triggerToolCallId?: string | null;
	hits: Array<{
		entryId: string;
		entryRevisionId?: string | null;
		summary?: string | null;
	}>;
}): void {
	if (input.hits.length === 0) return;
	const now = nowIso();
	const stmt = sqlite.prepare(
		`INSERT OR IGNORE INTO knowledge_injection_events
		 (id, narrator_id, compact_seq, entry_id, entry_revision_id, source,
		  trigger_message_id, trigger_tool_call_id, summary, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const tx = sqlite.transaction(() => {
		for (const hit of input.hits) {
			stmt.run(
				generateId(),
				input.narratorId,
				input.compactSeq,
				hit.entryId,
				hit.entryRevisionId ?? null,
				input.source,
				input.triggerMessageId ?? null,
				input.triggerToolCallId ?? null,
				hit.summary ?? null,
				now,
			);
		}
	});
	tx();
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

	// No draft context → plain main-version search. A column-restricted match (field) also
	// forces the main-only path: the drafts FTS has no matching column and personal drafts
	// should not shadow searches over main-version-only indexes.
	if (!opts.draftUserId || opts.field) {
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
		// ACL-only projection: this runs on every list/search response, so it must not read
		// the currentContent blob (or any render field) just to decide visibility.
		columns: ENTRY_ACL_COLUMNS,
	});
	const entryById = new Map(entries.map((e) => [e.id, e]));
	const colIds = [...new Set(entries.map((e) => e.collectionId))];
	const cols = await db.query.knowledgeCollections.findMany({
		where: (c, { inArray }) => inArray(c.id, colIds),
		columns: COLLECTION_ACL_COLUMNS,
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
	listKeywordInjectionCandidates,
	keywordInjectionCandidatesSignature,
	snippetsByEntryIds,
	listInjectedEntryIds,
	recordInjectionEvents,
	filterReadable,
};
