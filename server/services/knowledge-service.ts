import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import type { KnowledgeEntryRow } from "./knowledge/read-store";
import {
	knowledgeReadStore,
	knowledgeWriteStore,
	synchronousKnowledgeInjectionReads,
} from "./knowledge/store";
import { type KnowledgeCollectionRow, WriteConflictError } from "./knowledge/write-store";
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
	resolveCapsByUserId,
	resolvePrincipalCaps,
} from "./knowledge-acl";
import { recordKnowledgeAclEvent } from "./knowledge-audit";
import { emitEntryDrifted } from "./knowledge-notify";
import { searchStore } from "./search/backend";
import { canUseIndex, sanitizeQuery } from "./search/query";
import type { KnowledgeSearchRow, SearchStrategy } from "./search/types";

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

/**
 * Uniqueness conflicts reach this service as PORT VOCABULARY (`WriteConflictError`),
 * never as driver text: the write store's implementations classify them structurally
 * (SQLite extended result codes / SQLSTATE 23505 via `server/db/pg-errors.ts`) and
 * translate before the error crosses the boundary. The service — the only code that
 * knows whether "already exists" is a validation error — maps it to a clean 400.
 */

/**
 * Load an entry + its collection and assert the principal may READ it.
 * Throws NotFoundError (not a 403) on any miss so we never leak existence of
 * entries the caller cannot see. Returns the loaded entry row + resolved caps
 * so callers can reuse them (e.g. for a subsequent write check).
 */
async function loadReadableEntry(
	entryId: string,
	principal: Principal,
): Promise<{ entry: KnowledgeEntryRow; caps: PrincipalCaps }> {
	const entry = await knowledgeReadStore.getEntryById(entryId);
	if (!entry) throw new NotFoundError("Knowledge entry", entryId);
	const collection = await knowledgeReadStore.getCollectionById(entry.collectionId);
	const caps = await resolvePrincipalCaps(principal);
	// Same fail-closed rule as `filterReadable`: `collectionId` is NOT NULL behind a
	// cascading FK, so a missing collection row is an anomaly, not an unclassified entry.
	// Defaulting to a public gate here would disclose the entry exactly when its
	// collection's classification cannot be read.
	if (!collection) throw new NotFoundError("Knowledge entry", entryId);
	if (!(await canRead(caps, toAclEntry(entry), toAclCollection(collection)))) {
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
): Promise<KnowledgeEntryRow> {
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

// LIKE-wildcard escaping now lives with the statements that pair it with `ESCAPE '\'`
// (`services/search/sqlite-expressions.ts`). Keeping a copy here would be a second spelling
// of the same rule with no statement to enforce it against.

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
	const rows = await knowledgeReadStore.listCollections({
		...(projectId !== undefined ? { projectId } : {}),
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
	const existing = await knowledgeReadStore.findCollectionBySlug({
		projectId: input.projectId ?? null,
		slug,
	});
	if (existing) throw new ValidationError(`Collection slug already exists: ${slug}`);

	const id = generateId();
	const now = nowIso();
	try {
		return await knowledgeWriteStore.createCollection({
			id,
			name: input.name,
			slug,
			description: input.description ?? null,
			projectId: input.projectId ?? null,
			ownerUserId: input.ownerUserId ?? null,
			now,
		});
	} catch (err) {
		if (err instanceof WriteConflictError) {
			throw new ValidationError(`Collection slug already exists: ${slug}`);
		}
		throw err;
	}
}

async function getCollection(id: string) {
	const collection = await knowledgeReadStore.getCollectionById(id);
	if (!collection) throw new NotFoundError("Knowledge collection", id);
	return collection;
}

/** Assert the principal may manage (rename / delete / set-ACL / transfer) the collection: admin or owner.
 *  Collection-gate first (canReadCollection), then admin/owner. Returns the loaded row + caps. */
async function assertCanManageCollection(
	id: string,
	principal: Principal,
): Promise<{ collection: KnowledgeCollectionRow; caps: PrincipalCaps }> {
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
	await knowledgeWriteStore.updateCollectionFields({
		collectionId: id,
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.description !== undefined ? { description: input.description } : {}),
		now: nowIso(),
	});
	return getCollection(id);
}

async function deleteCollection(id: string, principal?: Principal) {
	// Load the row BEFORE deleting: the audit detail describes the gate that existed, and after
	// the delete there is nothing left to read it from.
	const collection = principal
		? (await assertCanManageCollection(id, principal)).collection
		: await getCollection(id);
	await knowledgeWriteStore.deleteCollection({ collectionId: id });
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
	if (!(await knowledgeReadStore.userExists(userId))) {
		throw new ValidationError(`User not found: ${userId}`);
	}
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
	await knowledgeWriteStore.updateCollectionFields({
		collectionId: id,
		ownerUserId: newOwnerUserId,
		now: nowIso(),
	});
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

// The column projections these reads use (ACL gate fields, list view, graph
// endpoints) live with the read stores — `knowledge/sqlite-read-store.ts` and its
// PostgreSQL twin — so the narrowing rule ("never the content blob on a list/filter
// path") is stated once per backend instead of per call site.

async function listEntries(opts: { collectionId?: string; tag?: string; limit?: number }) {
	const limit = Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
	// SQL-layer column projection happens in the read store: the large
	// currentContent/metadataJson blobs are never selected, so list views can't pull
	// big bodies into the main thread.
	const rows = await knowledgeReadStore.listEntries({
		...(opts.collectionId !== undefined ? { collectionId: opts.collectionId } : {}),
		limit,
	});
	const tag = opts.tag;
	return tag ? rows.filter((r) => parseTags(r.tagsJson).includes(tag)) : rows;
}

async function getEntry(
	id: string,
	opts: { withContent?: boolean; principal?: Principal; projectId?: string } = {},
) {
	const entry = await knowledgeReadStore.getEntryById(id);
	if (!entry) throw new NotFoundError("Knowledge entry", id);

	// Project context is an independent boundary from user ACL. Admin/owner may
	// bypass the knowledge ACL, but never another narrator's project context.
	const collection =
		opts.principal || opts.projectId
			? await knowledgeReadStore.getCollectionById(entry.collectionId)
			: undefined;
	if (opts.projectId && collection?.projectId && collection.projectId !== opts.projectId) {
		throw new NotFoundError("Knowledge entry", id);
	}

	// ACL: when a principal is supplied, enforce dual-axis read access.
	// Unauthorized → treat as not found (don't leak existence).
	if (opts.principal) {
		const caps = await resolvePrincipalCaps(opts.principal);
		// Fail closed on a missing collection row: it cannot mean "unclassified" for a
		// NOT NULL FK, so a public default would disclose the entry precisely when its
		// gate is unverifiable.
		if (!collection) throw new NotFoundError("Knowledge entry", id);
		if (!(await canRead(caps, toAclEntry(entry), toAclCollection(collection)))) {
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
	const dup = await knowledgeReadStore.findEntryBySlug(input.collectionId, slug);
	if (dup) throw new ValidationError(`Entry slug already exists in collection: ${slug}`);

	const entryId = generateId();
	const revisionId = generateId();
	const now = nowIso();
	const content = input.content ?? "";
	const format = input.format ?? "markdown";
	const keywords = normalizeKeywords(input.keywords);

	try {
		await knowledgeWriteStore.createEntryWithFirstRevision({
			entryId,
			revisionId,
			collectionId: input.collectionId,
			title: input.title,
			slug,
			content,
			format,
			contentHash: hashContent(content),
			currentKeywords: keywordsMirror(keywords),
			tagsJson: input.tags ?? [],
			keywordsJson: keywords,
			metadataJson: input.metadata ?? null,
			// Default the owner to the creator so they retain read/write/review
			// authority over their own entry without a separate grant.
			ownerUserId: input.ownerUserId ?? input.authorUserId ?? null,
			changeNote: input.changeNote ?? null,
			authorUserId: input.authorUserId ?? null,
			now,
		});
	} catch (err) {
		// Lost the slug race between the pre-check and insert → surface as a clean
		// validation error instead of a raw constraint failure.
		if (err instanceof WriteConflictError) {
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
	await knowledgeWriteStore.updateEntryMeta({
		entryId: id,
		...(input.title !== undefined ? { title: input.title } : {}),
		...(input.tags !== undefined ? { tagsJson: input.tags } : {}),
		...(keywords !== undefined
			? { keywordsJson: keywords, currentKeywords: keywordsMirror(keywords) }
			: {}),
		...(input.metadata !== undefined ? { metadataJson: input.metadata } : {}),
		...(input.status !== undefined ? { status: input.status } : {}),
		now: nowIso(),
	});
	return getEntry(id, { withContent: true, principal });
}

async function deleteEntry(id: string, principal: Principal) {
	await loadWritableEntry(id, principal);
	await knowledgeWriteStore.deleteEntry({ entryId: id });
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
): Promise<{ entry: KnowledgeEntryRow; caps: PrincipalCaps }> {
	const entry = await knowledgeReadStore.getEntryById(id);
	if (!entry) throw new NotFoundError("Knowledge entry", id);
	const caps = await resolvePrincipalCaps(principal);
	const collection = await knowledgeReadStore.getCollectionById(entry.collectionId);
	// Fail closed on a missing collection row (see getEntry): unverifiable gate, not a
	// public one.
	if (!collection) throw new NotFoundError("Knowledge entry", id);
	const aclCol = toAclCollection(collection);
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
	const previousOwnerUserId = (await knowledgeReadStore.getEntryAclById(id))?.ownerUserId ?? null;
	await knowledgeWriteStore.updateEntryAclFields({
		entryId: id,
		ownerUserId: newOwnerUserId,
		now: nowIso(),
	});
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
	const before = await knowledgeReadStore.getEntryAclById(id);
	await getEntry(id);
	await knowledgeWriteStore.updateEntryAclFields({
		entryId: id,
		...(input.classificationLevel !== undefined
			? { classificationLevel: input.classificationLevel }
			: {}),
		...(input.controlledTags !== undefined ? { controlledTagsJson: input.controlledTags } : {}),
		...(input.reviewTags !== undefined ? { reviewTagsJson: input.reviewTags } : {}),
		...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
		now: nowIso(),
	});
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
	const entryRow = await knowledgeReadStore.getEntryById(entryId);
	if (!entryRow) throw new NotFoundError("Knowledge entry", entryId);

	// Gate direct main writes. When a principal is supplied, enforce the COLLECTION READ
	// boundary (this path does NOT go through loadReadableEntry, so it must re-check the
	// collection itself — otherwise a global write-grant holder could write into a
	// collection they cannot even read) and then the existing entry write authority
	// (admin / entry owner / write grant via canWriteMain).
	if (input.principal) {
		const caps = await resolvePrincipalCaps(input.principal);
		const collection = await knowledgeReadStore.getCollectionById(entryRow.collectionId);
		// Fail closed on a missing collection row (see getEntry).
		if (!collection) throw new NotFoundError("Knowledge entry", entryId);
		const aclCol = toAclCollection(collection);
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

	// The version is claimed by the write store under the entry row's allocation
	// authority (see knowledge/revision-version.ts): SQLite claims MAX(version)+1
	// inside the same single-writer transaction; PostgreSQL takes the entry row lock
	// first. Neither backend performs an unguarded check-then-insert, so two
	// concurrent writers can't both pick the same version.
	const { version } = await knowledgeWriteStore.appendRevision({
		entryId,
		revisionId,
		content: input.content,
		format,
		contentHash: hashContent(input.content),
		changeNote: input.changeNote ?? null,
		authorUserId: input.authorUserId ?? null,
		now,
	});

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
	return knowledgeReadStore.listRevisionMeta(entryId, limit);
}

async function getRevision(revisionId: string, principal: Principal) {
	const rev = await knowledgeReadStore.getRevisionById(revisionId);
	if (!rev) throw new NotFoundError("Knowledge revision", revisionId);
	// A revision is only readable if its parent entry is readable. Enforce ACL on
	// the entry; unreadable → NotFound (don't leak the revision's existence/content).
	await loadReadableEntry(rev.entryId, principal);
	return rev;
}

// ═══════════════════════════════════════════════════════════════════════
// Search (FTS5 with LIKE fallback for short queries)
// ═══════════════════════════════════════════════════════════════════════

function mapRow(row: KnowledgeSearchRow) {
	return {
		id: row.id,
		collectionId: row.collectionId,
		title: row.title,
		slug: row.slug,
		// Tags stay encoded across the search port and are parsed here, so a row reached
		// through search reports the same tags as a row reached any other way.
		tags: parseTags(row.tagsJson ? JSON.parse(row.tagsJson) : []),
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		snippet: row.snippet,
		fromDraft: row.fromDraft,
		drifted: row.drifted,
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

type SearchOpts = {
	signal?: AbortSignal;
	q?: string;
	collectionId?: string;
	/** Restrict to collections in this project PLUS global (project_id IS NULL) collections. */
	projectId?: string;
	tag?: string;
	limit?: number;
	match?: "and" | "or";
	sort?: "time" | "relevance";
	/** Restrict the FTS match to a single column (e.g. "current_keywords" for passive injection). */
	field?: string;
	/** When set, the caller's own active drafts shadow the main version (working-copy view). */
	draftUserId?: string;
};

/**
 * The two needles a knowledge search carries, and which retrieval path it takes.
 *
 * The two differ on purpose and always have: the index path matches the SANITIZED query,
 * while the substring path matches the caller's TRIMMED RAW query, so a term containing an
 * FTS operator still matches literally there. Deriving both in one place keeps that
 * distinction from being re-decided (differently) in each branch.
 *
 * The substring path keeps a tighter result limit because contains-matches can be broad.
 * SQLite executes the scan in a read worker; the limit bounds the transferred results.
 */
function searchNeedles(opts: SearchOpts, limit: number) {
	const raw = (opts.q ?? "").trim();
	const safe = sanitizeQuery(raw);
	const strategy: SearchStrategy = canUseIndex(safe) ? "index" : "substring";
	return {
		signal: opts.signal,
		indexText: safe,
		substringText: raw,
		strategy,
		limit: strategy === "index" ? limit : Math.min(limit, SHORT_QUERY_FALLBACK_LIMIT),
	};
}

/** Search the MAIN (committed) versions, optionally excluding shadowed entries. */
async function searchMain(
	opts: SearchOpts,
	limit: number,
	excludeEntryIds: string[],
): Promise<KnowledgeSearchRow[]> {
	return searchStore.searchKnowledgeEntries({
		...searchNeedles(opts, limit),
		sort: opts.sort,
		collectionId: opts.collectionId,
		projectId: opts.projectId,
		match: opts.match ?? "and",
		field: opts.field,
		excludeEntryIds,
	});
}

/** Search the caller's own ACTIVE drafts (title de-normalized + content). Rows come back
 *  tagged `fromDraft`, with `drifted` set when the draft's base revision is behind main. */
async function searchDrafts(
	opts: SearchOpts,
	draftUserId: string,
	limit: number,
): Promise<KnowledgeSearchRow[]> {
	return searchStore.searchKnowledgeDrafts({
		...searchNeedles(opts, limit),
		sort: opts.sort,
		collectionId: opts.collectionId,
		projectId: opts.projectId,
		match: opts.match ?? "and",
		authorUserId: draftUserId,
		draftStatus: ACTIVE_DRAFT_STATUS,
	});
}

function parseStringArrayJson(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter((value): value is string => typeof value === "string");
	}
	if (typeof raw !== "string" || !raw) return [];
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
	const rows = synchronousKnowledgeInjectionReads().listKeywordInjectionCandidates({
		...(opts.collectionId !== undefined ? { collectionId: opts.collectionId } : {}),
		...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
		limit: KEYWORD_INJECTION_CANDIDATE_LIMIT,
	});

	return rows
		.map((row) => ({
			id: row.id,
			collectionId: row.collectionId,
			title: row.title,
			entryRevisionId: row.currentRevisionId,
			tags: parseStringArrayJson(row.tagsJson),
			keywords: parseStringArrayJson(row.keywordsJson),
			updatedAt: row.updatedAt,
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
	return synchronousKnowledgeInjectionReads().keywordInjectionCandidatesSignature({
		...(opts.collectionId !== undefined ? { collectionId: opts.collectionId } : {}),
		...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
	});
}

/** Fetch bounded snippets only for final injected hits, avoiding large-field reads in the scan. */
const SNIPPETS_LOOKUP_MAX = 100;
/**
 * Prefix of the body read per hit.
 *
 * Sized above the ~320-char excerpt on purpose: the consumer STRIPS Markdown
 * (`knowledgeExcerpt`), so a heading line, a frontmatter block or an opening code fence
 * can consume much of the prefix without contributing a single displayed character. At
 * 512 an entry whose body opened with a fenced snippet produced an empty excerpt. Still
 * a small, indexed, bounded read — at most `maxInjectedEntries` (3) rows per turn.
 */
const SNIPPET_SOURCE_CHARS = 1536;
function snippetsByEntryIds(entryIds: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const ids = entryIds.slice(0, SNIPPETS_LOOKUP_MAX);
	if (ids.length === 0) return out;
	const rows = synchronousKnowledgeInjectionReads().snippetsByEntryIds(ids, SNIPPET_SOURCE_CHARS);
	for (const row of rows) out.set(row.id, row.snippet ?? "");
	return out;
}

type KnowledgeInjectionSource = "user_message" | "tool_output" | "system_continuation";

function listInjectedEntryIds(narratorId: string, compactSeq: number): Set<string> {
	const ids = synchronousKnowledgeInjectionReads().listInjectedEntryIds(narratorId, compactSeq);
	return new Set(ids);
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
	// Not awaited ON PURPOSE: the SQLite store executes its section synchronously
	// inside the call, so the rows are durable before this returns (the historical
	// contract the agent-runtime callers rely on), and the Promise only shapes the
	// boundary. The dedupe on (narrator, compact_seq, entry) is ON CONFLICT DO
	// NOTHING — the portable spelling both backends share.
	//
	// Failures are logged, never thrown: before the port this function threw
	// synchronously and every caller swallowed the error into a warn — recording
	// must not fail the turn it describes. With the store being Promise-shaped the
	// swallow moves here so an un-awaited rejection can never crash the process.
	void knowledgeWriteStore
		.recordInjectionEvents({
			narratorId: input.narratorId,
			compactSeq: input.compactSeq,
			source: input.source,
			triggerMessageId: input.triggerMessageId ?? null,
			triggerToolCallId: input.triggerToolCallId ?? null,
			now: nowIso(),
			hits: input.hits.map((hit) => ({
				id: generateId(),
				entryId: hit.entryId,
				entryRevisionId: hit.entryRevisionId ?? null,
				summary: hit.summary ?? null,
			})),
		})
		.catch((err) => {
			logger.warn("Failed to record knowledge injection events", {
				narratorId: input.narratorId,
				error: String(err),
			});
		});
}

async function search(opts: SearchOpts) {
	const limit = Math.min(opts.limit ?? 30, SEARCH_MAX_LIMIT);

	// Project isolation (`opts.projectId`) is applied by the search backend: entries are
	// restricted to that project's collections plus global ones, which keeps a narrator from
	// surfacing knowledge scoped to OTHER projects.

	// No draft context → plain main-version search. A column-restricted match (field) also
	// forces the main-only path: the drafts FTS has no matching column and personal drafts
	// should not shadow searches over main-version-only indexes.
	if (!opts.draftUserId || opts.field) {
		const rows = await searchMain(opts, limit, []);
		const mapped = rows.map(mapRow);
		const tag = opts.tag;
		return tag ? mapped.filter((r) => r.tags.includes(tag)) : mapped;
	}

	// Working-copy view: the caller's active drafts shadow the main version. The shadowed
	// set (their draft entry ids) is excluded from the main search and supplied by the draft
	// search instead — the two sets are identical, so the results never overlap (no dedup).
	const shadowedEntryIds = await searchStore.listShadowedEntryIds({
		signal: opts.signal,
		authorUserId: opts.draftUserId,
		draftStatus: ACTIVE_DRAFT_STATUS,
		limit: DRAFT_SHADOW_MAX,
	});

	// Fast path: the user has no active drafts → nothing to shadow. Fall back to the plain
	// main-version search (one cheap indexed lookup above instead of a second FTS query).
	// This keeps the hot passive-injection path cheap for the common no-draft case.
	if (shadowedEntryIds.length === 0) {
		const rows = await searchMain(opts, limit, []);
		const mapped = rows.map(mapRow);
		const tag = opts.tag;
		return tag ? mapped.filter((r) => r.tags.includes(tag)) : mapped;
	}

	const draftRows = await searchDrafts(opts, opts.draftUserId, limit);
	const mainRows = await searchMain(opts, limit, shadowedEntryIds);

	// Relevance preserves draft-first ordering. Recency must merge both bounded,
	// time-ordered result sets before truncating, or old drafts crowd out newer main hits.
	const merged = [...draftRows, ...mainRows];
	if (opts.sort === "time") {
		merged.sort((a, b) => {
			const time = b.updatedAt.localeCompare(a.updatedAt);
			return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		});
	}
	const mapped = merged.map(mapRow);
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
	// No identity → the anonymous baseline (public only), NOT an unfiltered pass-through.
	// This used to return `rows`, which meant a caller that forgot to resolve a principal
	// silently disclosed every classified entry it had matched. Anonymous callers now see
	// exactly what a logged-out reader may see, and a wiring mistake fails closed.
	const caps =
		opts.caps ??
		(principal ? await resolvePrincipalCaps(principal) : await resolveCapsByUserId(null));
	if (caps.isAdmin) return rows;

	// Batch-load the entries (with ACL fields) + their collections' default levels.
	const ids = rows.map((r) => r.id);
	if (ids.length === 0) return rows;
	// ACL-only projections in the read store: this runs on every list/search response,
	// so it must not read the currentContent blob (or any render field) just to decide
	// visibility.
	const entries = await knowledgeReadStore.getEntriesAclByIds(ids);
	const entryById = new Map(entries.map((e) => [e.id, e]));
	const colIds = [...new Set(entries.map((e) => e.collectionId))];
	const cols = await knowledgeReadStore.getCollectionsAclByIds(colIds);
	// Cache the FULL collection row (not just defaultLevel) so the collection gate
	// in canRead has classificationLevel / controlledTags / owner — otherwise the
	// gate silently degrades to public (iron rule A).
	const colById = new Map(cols.map((c) => [c.id, c]));

	const out: T[] = [];
	for (const r of rows) {
		const e = entryById.get(r.id);
		if (!e) continue;
		const col = colById.get(e.collectionId);
		// A missing collection row must NOT degrade to a public gate. `collectionId` is
		// NOT NULL with a cascading FK, so an absent row means the batch read failed or
		// raced a delete — never "this entry is unclassified". Treating it as public would
		// hand out the collection's contents precisely when we cannot verify its gate.
		if (!col) continue;
		if (await canRead(caps, toAclEntry(e), toAclCollection(col))) out.push(r);
	}
	return out;
}

/** Promise-shaped injection seam. The legacy synchronous API remains for the
 * narrator/runtime callers not yet migrated; these methods always follow the live
 * read binding and are usable on both engines. */
export const knowledgeInjectionReads = {
	async listKeywordInjectionCandidates(opts: { collectionId?: string; projectId?: string } = {}) {
		const rows = await knowledgeReadStore.listKeywordInjectionCandidates({
			...opts,
			limit: KEYWORD_INJECTION_CANDIDATE_LIMIT,
		});
		return rows
			.map((row) => ({
				id: row.id,
				collectionId: row.collectionId,
				title: row.title,
				entryRevisionId: row.currentRevisionId,
				tags: parseStringArrayJson(row.tagsJson),
				keywords: parseStringArrayJson(row.keywordsJson),
				updatedAt: row.updatedAt,
			}))
			.filter((row) => row.keywords.length > 0);
	},
	keywordInjectionCandidatesSignature(opts: { collectionId?: string; projectId?: string } = {}) {
		return knowledgeReadStore.keywordInjectionCandidatesSignature(opts);
	},
	async snippetsByEntryIds(ids: string[]) {
		const rows = await knowledgeReadStore.snippetsByEntryIds(
			ids.slice(0, SNIPPETS_LOOKUP_MAX),
			SNIPPET_SOURCE_CHARS,
		);
		return new Map(rows.map((row) => [row.id, row.snippet ?? ""]));
	},
	async listInjectedEntryIds(narratorId: string, compactSeq: number) {
		return new Set(await knowledgeReadStore.listInjectedEntryIds(narratorId, compactSeq));
	},
};

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
