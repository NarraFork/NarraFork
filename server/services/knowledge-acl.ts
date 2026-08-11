import { and, eq, ne } from "drizzle-orm";
import { db } from "../db";
import {
	knowledgeCollections,
	knowledgeEntries,
	knowledgeGrants,
	knowledgeLevels,
	knowledgeTags,
	knowledgeTagTypes,
	users,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { recordKnowledgeAclEvent } from "./knowledge-audit";

/** A user's role as stored on the JWT/users table. */
export type Role = "admin" | "user";

export interface Principal {
	userId: string;
	role: Role;
}

/** Aggregated capabilities of a principal, resolved from grants. */
export interface CollectionScopedCaps {
	clearanceRank: number;
	grantedTagIds: Set<string>;
	hasWriteGrant: boolean;
	reviewTagIds: Set<string>;
}

export interface PrincipalCaps {
	userId: string;
	role: Role;
	isAdmin: boolean;
	/** Global max clearance rank (public = 0 baseline). */
	clearanceRank: number;
	/** Globally granted controlled tag ids. */
	grantedTagIds: Set<string>;
	/** Whether the principal holds a global write grant. */
	hasWriteGrant: boolean;
	/** Globally granted review tag ids. */
	reviewTagIds: Set<string>;
	/** Collection-scoped grants, kept separate so authority never leaks across collections. */
	collectionScopes?: Map<string, CollectionScopedCaps>;
}

/** Minimal entry shape needed for access decisions. */
export interface AclEntry {
	id: string;
	collectionId: string;
	ownerUserId?: string | null;
	classificationLevel?: string | null;
	controlledTagsJson?: unknown;
	reviewTagsJson?: unknown;
}

export interface AclCollection {
	id: string;
	defaultLevel: string;
	/** Classification level gating access to the collection ITSELF (null = public). */
	classificationLevel?: string | null;
	/** Controlled tag ids required to read the collection (compartment axis). */
	controlledTagsJson?: unknown;
	/** Collection owner — short-circuits read and may write/manage the collection. */
	ownerUserId?: string | null;
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Cache the level name→rank map briefly; levels rarely change.
let levelCache: { at: number; map: Map<string, number> } | null = null;
const LEVEL_TTL_MS = 30_000;

async function levelRankMap(): Promise<Map<string, number>> {
	if (levelCache && Date.now() - levelCache.at < LEVEL_TTL_MS) return levelCache.map;
	const rows = await db.query.knowledgeLevels.findMany();
	const map = new Map<string, number>();
	// public always resolves to 0 even if not seeded.
	map.set("public", 0);
	for (const r of rows) map.set(r.name, r.rank);
	levelCache = { at: Date.now(), map };
	return map;
}

/** Invalidate the level cache (call after mutating knowledge_levels). */
export function invalidateLevelCache(): void {
	levelCache = null;
}

async function rankOf(levelName: string | null | undefined): Promise<number> {
	const map = await levelRankMap();
	// No level specified → public baseline (0). This is the documented default
	// for entries/collections that never set a classification.
	if (!levelName) return 0;
	const rank = map.get(levelName);
	// Fail-CLOSED: an unknown level name (deleted level, typo, stale reference)
	// must NOT silently downgrade to public. Treat it as maximally restricted so
	// only admins/owners (who short-circuit canRead) can read it.
	if (rank === undefined) return Number.POSITIVE_INFINITY;
	return rank;
}

function emptyCollectionCaps(): CollectionScopedCaps {
	return {
		clearanceRank: 0,
		grantedTagIds: new Set(),
		hasWriteGrant: false,
		reviewTagIds: new Set(),
	};
}

function effectiveCapsForCollection(
	caps: PrincipalCaps,
	collectionId: string,
): CollectionScopedCaps {
	const scoped = caps.collectionScopes?.get(collectionId);
	return {
		clearanceRank: Math.max(caps.clearanceRank, scoped?.clearanceRank ?? 0),
		grantedTagIds: new Set([...caps.grantedTagIds, ...(scoped?.grantedTagIds ?? [])]),
		hasWriteGrant: caps.hasWriteGrant || scoped?.hasWriteGrant === true,
		reviewTagIds: new Set([...caps.reviewTagIds, ...(scoped?.reviewTagIds ?? [])]),
	};
}

function applyGrantToCaps(
	caps: PrincipalCaps,
	grant: typeof knowledgeGrants.$inferSelect,
	levels: Map<string, number>,
): void {
	const target = grant.collectionId
		? (() => {
				let scoped = caps.collectionScopes?.get(grant.collectionId as string);
				if (!scoped) {
					scoped = emptyCollectionCaps();
					caps.collectionScopes ??= new Map();
					caps.collectionScopes.set(grant.collectionId as string, scoped);
				}
				return scoped;
			})()
		: caps;
	if (grant.canWrite) target.hasWriteGrant = true;
	if (grant.grantType === "clearance" && grant.clearanceLevel) {
		target.clearanceRank = Math.max(target.clearanceRank, levels.get(grant.clearanceLevel) ?? 0);
	} else if (grant.grantType === "tag" && grant.tagId) {
		target.grantedTagIds.add(grant.tagId);
	} else if (grant.grantType === "review" && grant.tagId) {
		target.reviewTagIds.add(grant.tagId);
	}
}

/** Resolve a principal's aggregated capabilities from all applicable grants. */
export async function resolvePrincipalCaps(principal: Principal): Promise<PrincipalCaps> {
	const isAdmin = principal.role === "admin";
	const caps: PrincipalCaps = {
		userId: principal.userId,
		role: principal.role,
		isAdmin,
		clearanceRank: 0,
		grantedTagIds: new Set(),
		hasWriteGrant: false,
		reviewTagIds: new Set(),
	};
	if (isAdmin) {
		// Admin short-circuits all axes; ranks/tags are not consulted.
		caps.clearanceRank = Number.POSITIVE_INFINITY;
		caps.hasWriteGrant = true;
		return caps;
	}

	// Grants targeting this user or their role.
	const grants = await db.query.knowledgeGrants.findMany({
		where: (g, { or, eq: e, and: a }) =>
			or(
				a(e(g.principalType, "user"), e(g.principalId, principal.userId)),
				a(e(g.principalType, "role"), e(g.principalId, principal.role)),
			),
	});

	const levels = await levelRankMap();
	for (const grant of grants) applyGrantToCaps(caps, grant, levels);
	return caps;
}

/** Hard cap on users considered by {@link resolveCapsForAllUsers}. */
export const BATCH_CAPS_USER_LIMIT = 200;
/**
 * Hard cap on grant rows aggregated in one batch resolution. `knowledge_grants` is an
 * admin-managed table that stays small; exceeding this means the batch decision could
 * be incomplete, so the caller degrades to admins only rather than guessing.
 */
const BATCH_CAPS_GRANT_LIMIT = 5000;

export interface BatchCaps {
	/** userId → aggregated caps, ready for canRead / canReview / canWriteCollection. */
	byUserId: Map<string, PrincipalCaps>;
	/**
	 * True when the population had to be narrowed to admins (too many users or too
	 * many grants to aggregate on the main thread). Callers should treat the result
	 * as "admins only" rather than "nobody else qualifies".
	 */
	truncated: boolean;
}

/**
 * Resolve caps for a BOUNDED population of users in a fixed number of queries.
 *
 * This is the batch counterpart of {@link resolvePrincipalCaps} — same aggregation
 * (user grants ∪ role grants, admin short-circuit), but without the per-user query
 * that would turn a fan-out into N+1 main-thread SQLite reads. Decisions are still
 * made by the canRead / canReview / canWriteCollection predicates; this only builds
 * their input.
 *
 * When the user table exceeds `limit`, or the grant table exceeds the aggregation cap,
 * the population degrades to admins only and `truncated` is set.
 */
export async function resolveCapsForAllUsers(
	limit: number = BATCH_CAPS_USER_LIMIT,
): Promise<BatchCaps> {
	const cap = Math.max(1, Math.min(limit, BATCH_CAPS_USER_LIMIT));
	// limit + 1 detects "more than the cap" without a COUNT(*) over the whole table.
	let rows = await db.query.users.findMany({
		columns: { id: true, role: true },
		limit: cap + 1,
	});
	let truncated = rows.length > cap;

	const grants = await db.query.knowledgeGrants.findMany({ limit: BATCH_CAPS_GRANT_LIMIT + 1 });
	if (grants.length > BATCH_CAPS_GRANT_LIMIT) truncated = true;

	if (truncated) {
		rows = await db.query.users.findMany({
			columns: { id: true, role: true },
			where: eq(users.role, "admin"),
			limit: cap,
		});
	}

	const userGrants = new Map<string, typeof grants>();
	const roleGrants = new Map<string, typeof grants>();
	if (!truncated) {
		for (const g of grants) {
			const bucket = g.principalType === "user" ? userGrants : roleGrants;
			const arr = bucket.get(g.principalId);
			if (arr) arr.push(g);
			else bucket.set(g.principalId, [g]);
		}
	}

	const levels = await levelRankMap();
	const byUserId = new Map<string, PrincipalCaps>();
	for (const u of rows) {
		const role = u.role as Role;
		const isAdmin = role === "admin";
		const caps: PrincipalCaps = {
			userId: u.id,
			role,
			isAdmin,
			// Mirrors resolvePrincipalCaps' admin short-circuit exactly.
			clearanceRank: isAdmin ? Number.POSITIVE_INFINITY : 0,
			grantedTagIds: new Set(),
			hasWriteGrant: isAdmin,
			reviewTagIds: new Set(),
			collectionScopes: new Map(),
		};
		if (!isAdmin) {
			for (const grant of [...(userGrants.get(u.id) ?? []), ...(roleGrants.get(role) ?? [])]) {
				applyGrantToCaps(caps, grant, levels);
			}
		}
		byUserId.set(u.id, caps);
	}
	return { byUserId, truncated };
}

/** Anonymous baseline caps: may read only public, no controlled tags, no write/review. */
function anonymousCaps(): PrincipalCaps {
	return {
		userId: "",
		role: "user",
		isAdmin: false,
		clearanceRank: 0,
		grantedTagIds: new Set(),
		hasWriteGrant: false,
		reviewTagIds: new Set(),
	};
}

/**
 * Resolve caps from a userId alone (the user who triggered the current agent loop turn).
 * Centralizes the null/anonymous branch so callers (tools, injection) never special-case it.
 *   - userId null/empty  → anonymous baseline (public only)
 *   - user not found     → anonymous baseline
 *   - otherwise          → role looked up from `users`, then full resolvePrincipalCaps
 */
export async function resolveCapsByUserId(
	userId: string | null | undefined,
): Promise<PrincipalCaps> {
	if (!userId) return anonymousCaps();
	const row = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { id: true, role: true },
	});
	if (!row) return anonymousCaps();
	return resolvePrincipalCaps({ userId: row.id, role: row.role });
}

/**
 * Can the principal READ this collection? Dual-axis AND (same shape as entry canRead):
 *   clearance >= collection level  AND  collection controlled tags ⊆ granted tags.
 * admin / collection owner short-circuit. A collection with no level (null → public)
 * and no controlled tags is readable by everyone (backward-compatible default).
 */
export async function canReadCollection(
	caps: PrincipalCaps,
	collection: AclCollection,
): Promise<boolean> {
	if (caps.isAdmin) return true;
	if (collection.ownerUserId && collection.ownerUserId === caps.userId) return true;

	const effective = effectiveCapsForCollection(caps, collection.id);
	const need = await rankOf(collection.classificationLevel);
	if (effective.clearanceRank < need) return false;

	const controlled = asStringArray(collection.controlledTagsJson);
	for (const t of controlled) {
		if (!effective.grantedTagIds.has(t)) return false;
	}
	return true;
}

/** Can the principal WRITE into / create entries in this collection? admin / owner / write grant. */
export function canWriteCollection(caps: PrincipalCaps, collection: AclCollection): boolean {
	if (caps.isAdmin) return true;
	if (collection.ownerUserId && collection.ownerUserId === caps.userId) return true;
	return effectiveCapsForCollection(caps, collection.id).hasWriteGrant;
}

/** Can the principal manage (rename / delete / set ACL on) the collection? admin / owner only. */
export function isCollectionOwnerOrAdmin(caps: PrincipalCaps, collection: AclCollection): boolean {
	if (caps.isAdmin) return true;
	return !!collection.ownerUserId && collection.ownerUserId === caps.userId;
}

/**
 * Can the principal CLASSIFY the entry (set its level / controlled tags / review tags)?
 * admin or the entry owner only — deliberately NOT write-grant holders: being allowed to
 * write content is not authority to change who may see it. Mirrors isCollectionOwnerOrAdmin
 * on the collection side. Callers must run the read gate (canRead) first.
 */
export function isEntryOwnerOrAdmin(caps: PrincipalCaps, entry: AclEntry): boolean {
	if (caps.isAdmin) return true;
	return !!entry.ownerUserId && entry.ownerUserId === caps.userId;
}

/**
 * Can the principal READ this entry? Collection gate AND entry dual-axis AND:
 *   1. canReadCollection (the collection is itself an access boundary), THEN
 *   2. clearance >= entry level  AND  entry controlled tags ⊆ granted tags.
 * The collection gate runs first: owning an entry does NOT bypass the collection's
 * classification. admin short-circuits everything.
 */
export async function canRead(
	caps: PrincipalCaps,
	entry: AclEntry,
	collection: AclCollection,
): Promise<boolean> {
	if (caps.isAdmin) return true;

	// Collection is a prerequisite access boundary (decision: collection-first).
	if (!(await canReadCollection(caps, collection))) return false;

	if (entry.ownerUserId && entry.ownerUserId === caps.userId) return true;

	const effective = effectiveCapsForCollection(caps, entry.collectionId);
	const levelName = entry.classificationLevel ?? collection.defaultLevel;
	const need = await rankOf(levelName);
	if (effective.clearanceRank < need) return false;

	const controlled = asStringArray(entry.controlledTagsJson);
	for (const t of controlled) {
		if (!effective.grantedTagIds.has(t)) return false;
	}
	return true;
}

/** Can the principal WRITE main directly (bypass review)? owner / admin / write grant. */
export function canWriteMain(caps: PrincipalCaps, entry: AclEntry): boolean {
	if (caps.isAdmin) return true;
	if (entry.ownerUserId && entry.ownerUserId === caps.userId) return true;
	return effectiveCapsForCollection(caps, entry.collectionId).hasWriteGrant;
}

/**
 * Can the principal REVIEW changes to this entry?
 * admin / owner / holds review grant for EVERY review tag of the entry.
 */
export function canReview(caps: PrincipalCaps, entry: AclEntry): boolean {
	if (caps.isAdmin) return true;
	if (entry.ownerUserId && entry.ownerUserId === caps.userId) return true;
	const reviewTags = asStringArray(entry.reviewTagsJson);
	// No review tags configured → only admin/owner may review (conservative).
	if (reviewTags.length === 0) return false;
	const effective = effectiveCapsForCollection(caps, entry.collectionId);
	return reviewTags.every((t) => effective.reviewTagIds.has(t));
}

/** Resolve which entries are readable, for batch filtering. */
export async function readableEntryFilter(
	caps: PrincipalCaps,
	entries: AclEntry[],
	collections: Map<string, AclCollection>,
): Promise<AclEntry[]> {
	const out: AclEntry[] = [];
	for (const e of entries) {
		const col = collections.get(e.collectionId);
		if (!col) continue;
		if (await canRead(caps, e, col)) out.push(e);
	}
	return out;
}

// ─── Admin CRUD: levels / tags / grants ─────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

async function listLevels() {
	return db.query.knowledgeLevels.findMany({ orderBy: (l, { asc }) => [asc(l.rank)] });
}

async function createLevel(input: { name: string; rank: number; label?: string }) {
	const [row] = await db
		.insert(knowledgeLevels)
		.values({
			id: generateId(),
			name: input.name,
			rank: input.rank,
			label: input.label ?? null,
			createdAt: nowIso(),
		})
		.returning();
	invalidateLevelCache();
	return row;
}

async function updateLevel(
	id: string,
	input: { name?: string; rank?: number; label?: string | null },
): Promise<typeof knowledgeLevels.$inferSelect> {
	const existing = await db.query.knowledgeLevels.findFirst({
		where: eq(knowledgeLevels.id, id),
	});
	if (!existing) throw new NotFoundError("Knowledge level", id);

	const renaming = input.name !== undefined && input.name !== existing.name;
	const reranking = input.rank !== undefined && input.rank !== existing.rank;

	// Pre-check unique constraints (name + rank both have UNIQUE indexes) so we
	// surface a clean 400 instead of leaking a raw SQLite constraint error as a 500.
	if (renaming) {
		const clash = await db.query.knowledgeLevels.findFirst({
			where: and(eq(knowledgeLevels.name, input.name as string), ne(knowledgeLevels.id, id)),
			columns: { id: true },
		});
		if (clash) throw new ValidationError(`Level name already in use: ${input.name}`);
	}
	if (reranking) {
		const clash = await db.query.knowledgeLevels.findFirst({
			where: and(eq(knowledgeLevels.rank, input.rank as number), ne(knowledgeLevels.id, id)),
			columns: { id: true },
		});
		if (clash) throw new ValidationError(`Level rank already in use: ${input.rank}`);
	}

	const updates: Partial<typeof knowledgeLevels.$inferInsert> = {};
	if (input.name !== undefined) updates.name = input.name;
	if (input.rank !== undefined) updates.rank = input.rank;
	if (input.label !== undefined) updates.label = input.label;

	// Apply the level row update AND any reference renames in a SINGLE transaction.
	// Levels are referenced BY NAME (not id) from entries/collections/grants, so a
	// partial write (references renamed but the level row not, or vice versa) would
	// make rankOf() fail-closed on the dangling name and abruptly lock those entries
	// to admin-only. Atomicity keeps the name in lock-step with its references.
	db.transaction((tx) => {
		if (renaming) {
			const newName = input.name as string;
			tx.update(knowledgeEntries)
				.set({ classificationLevel: newName })
				.where(eq(knowledgeEntries.classificationLevel, existing.name))
				.run();
			tx.update(knowledgeCollections)
				.set({ defaultLevel: newName })
				.where(eq(knowledgeCollections.defaultLevel, existing.name))
				.run();
			tx.update(knowledgeCollections)
				.set({ classificationLevel: newName })
				.where(eq(knowledgeCollections.classificationLevel, existing.name))
				.run();
			tx.update(knowledgeGrants)
				.set({ clearanceLevel: newName })
				.where(eq(knowledgeGrants.clearanceLevel, existing.name))
				.run();
		}
		tx.update(knowledgeLevels).set(updates).where(eq(knowledgeLevels.id, id)).run();
	});

	const row = await db.query.knowledgeLevels.findFirst({ where: eq(knowledgeLevels.id, id) });
	invalidateLevelCache();
	if (!row) throw new NotFoundError("Knowledge level", id);
	return row;
}

async function deleteLevel(
	id: string,
): Promise<{ ok: true } | { ok: false; reason: string; refs?: number }> {
	const level = await db.query.knowledgeLevels.findFirst({
		where: eq(knowledgeLevels.id, id),
	});
	if (!level) return { ok: false, reason: "not_found" };
	// "public" is the baseline level relied on throughout the ACL logic.
	if (level.name === "public") return { ok: false, reason: "builtin" };

	// Reference check: levels are referenced BY NAME (not id) from these places.
	// Deleting a still-referenced level would, under fail-closed rankOf, abruptly
	// lock every referencing entry/collection to admin-only — so refuse and surface it.
	const [entryRefs, collectionDefaultRefs, collectionClassRefs, grantRefs] = await Promise.all([
		db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.classificationLevel, level.name),
			columns: { id: true },
		}),
		db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.defaultLevel, level.name),
			columns: { id: true },
		}),
		db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.classificationLevel, level.name),
			columns: { id: true },
		}),
		db.query.knowledgeGrants.findFirst({
			where: eq(knowledgeGrants.clearanceLevel, level.name),
			columns: { id: true },
		}),
	]);
	if (entryRefs || collectionDefaultRefs || collectionClassRefs || grantRefs) {
		return { ok: false, reason: "in_use" };
	}

	await db.delete(knowledgeLevels).where(eq(knowledgeLevels.id, id));
	invalidateLevelCache();
	return { ok: true };
}

/**
 * Set a collection's ACL attributes (classification level, controlled tags, owner).
 * Mirrors updateEntryAcl on the entry side. Caller is responsible for authorization
 * (admin-only at the route/tool layer).
 */
async function updateCollectionAcl(
	id: string,
	input: {
		classificationLevel?: string | null;
		controlledTags?: string[];
		ownerUserId?: string | null;
	},
	/** Who is making the change — recorded in the ACL audit trail. Optional so internal/seed
	 *  paths and tests can call this without inventing an actor. */
	actor?: { userId?: string | null; role?: string | null },
) {
	// Read the BEFORE state for the audit diff (small, ACL-only projection — no content).
	const existing = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, id),
		columns: {
			id: true,
			classificationLevel: true,
			controlledTagsJson: true,
			ownerUserId: true,
		},
	});
	if (!existing) throw new Error("Knowledge collection not found");
	await db
		.update(knowledgeCollections)
		.set({
			...(input.classificationLevel !== undefined
				? { classificationLevel: input.classificationLevel }
				: {}),
			...(input.controlledTags !== undefined ? { controlledTagsJson: input.controlledTags } : {}),
			...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
			updatedAt: nowIso(),
		})
		.where(eq(knowledgeCollections.id, id));
	// Post-write: this changed who can read a whole collection, so it is exactly the kind of
	// change that must be answerable after the fact. Level names + tag ids only.
	recordKnowledgeAclEvent({
		actorUserId: actor?.userId ?? null,
		actorRole: actor?.role ?? null,
		eventType: "collection_acl_updated",
		targetType: "collection",
		targetId: id,
		detail: {
			before: {
				classificationLevel: existing.classificationLevel,
				controlledTags: existing.controlledTagsJson ?? [],
				ownerUserId: existing.ownerUserId,
			},
			after: {
				classificationLevel:
					input.classificationLevel !== undefined
						? input.classificationLevel
						: existing.classificationLevel,
				controlledTags:
					input.controlledTags !== undefined
						? input.controlledTags
						: (existing.controlledTagsJson ?? []),
				ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : existing.ownerUserId,
			},
		},
	});
	return db.query.knowledgeCollections.findFirst({ where: eq(knowledgeCollections.id, id) });
}

async function listTags(collectionId?: string) {
	if (collectionId) {
		return db.query.knowledgeTags.findMany({
			where: eq(knowledgeTags.collectionId, collectionId),
		});
	}
	return db.query.knowledgeTags.findMany();
}

async function createTag(input: {
	name: string;
	collectionId?: string;
	controlled?: boolean;
	typeId?: string;
}) {
	const [row] = await db
		.insert(knowledgeTags)
		.values({
			id: generateId(),
			name: input.name,
			collectionId: input.collectionId ?? null,
			typeId: input.typeId ?? null,
			controlled: input.controlled ?? false,
			createdAt: nowIso(),
		})
		.returning();
	return row;
}

async function updateTag(
	id: string,
	input: { name?: string; controlled?: boolean; typeId?: string | null },
) {
	await db
		.update(knowledgeTags)
		.set({
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.controlled !== undefined ? { controlled: input.controlled } : {}),
			...(input.typeId !== undefined ? { typeId: input.typeId } : {}),
		})
		.where(eq(knowledgeTags.id, id));
	return db.query.knowledgeTags.findFirst({ where: eq(knowledgeTags.id, id) });
}

async function deleteTag(id: string) {
	await db.delete(knowledgeTags).where(eq(knowledgeTags.id, id));
	return { ok: true as const };
}

// ─── Tag types ───
async function listTagTypes() {
	return db.query.knowledgeTagTypes.findMany({
		orderBy: (tt, { asc }) => [asc(tt.sortOrder), asc(tt.createdAt)],
	});
}

async function createTagType(input: { name: string; sortOrder?: number }) {
	const [row] = await db
		.insert(knowledgeTagTypes)
		.values({
			id: generateId(),
			name: input.name,
			builtin: false,
			sortOrder: input.sortOrder ?? 100,
			createdAt: nowIso(),
		})
		.returning();
	return row;
}

async function updateTagType(id: string, input: { name?: string; sortOrder?: number }) {
	await db
		.update(knowledgeTagTypes)
		.set({
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
		})
		.where(eq(knowledgeTagTypes.id, id));
	return db.query.knowledgeTagTypes.findFirst({ where: eq(knowledgeTagTypes.id, id) });
}

async function deleteTagType(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	const tt = await db.query.knowledgeTagTypes.findFirst({
		where: eq(knowledgeTagTypes.id, id),
	});
	if (!tt) return { ok: false, reason: "not_found" };
	if (tt.builtin) return { ok: false, reason: "builtin" };
	// Tags referencing this type get typeId set to null via FK onDelete: "set null".
	await db.delete(knowledgeTagTypes).where(eq(knowledgeTagTypes.id, id));
	return { ok: true };
}

async function listGrants(opts: { principalType?: string; principalId?: string } = {}) {
	const ptype = opts.principalType as "user" | "role" | undefined;
	return db.query.knowledgeGrants.findMany({
		where: (g, { and: a, eq: e }) => {
			const conds = [];
			if (ptype) conds.push(e(g.principalType, ptype));
			if (opts.principalId) conds.push(e(g.principalId, opts.principalId));
			return conds.length ? a(...conds) : undefined;
		},
	});
}

/** Detect a SQLite UNIQUE-index violation without depending on the driver's error class. */
function isUniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /UNIQUE constraint failed/i.test(message);
}

async function createGrant(
	input: {
		collectionId?: string;
		principalType: "user" | "role";
		principalId: string;
		grantType: "clearance" | "tag" | "review";
		clearanceLevel?: string;
		tagId?: string;
		canWrite?: boolean;
	},
	/** Who is granting — recorded in the ACL audit trail. */
	actor?: { userId?: string | null; role?: string | null },
) {
	try {
		const [row] = await db
			.insert(knowledgeGrants)
			.values({
				id: generateId(),
				collectionId: input.collectionId ?? null,
				principalType: input.principalType,
				principalId: input.principalId,
				grantType: input.grantType,
				clearanceLevel: input.clearanceLevel ?? null,
				tagId: input.tagId ?? null,
				canWrite: input.canWrite ?? false,
				createdAt: nowIso(),
			})
			.returning();
		emitAclChanged(input.principalType, input.principalId, "grant_added");
		recordKnowledgeAclEvent({
			actorUserId: actor?.userId ?? null,
			actorRole: actor?.role ?? null,
			eventType: "grant_added",
			subjectType: input.principalType,
			subjectId: input.principalId,
			targetType: "grant",
			targetId: row?.id ?? null,
			detail: {
				grantType: input.grantType,
				clearanceLevel: input.clearanceLevel ?? null,
				tagId: input.tagId ?? null,
				collectionId: input.collectionId ?? null,
				canWrite: input.canWrite ?? false,
			},
		});
		return row;
	} catch (error) {
		// `idx_kgrant_unique_tuple` makes the (collection, principal, grantType, tag)
		// tuple unique, so a duplicate create must surface as a client error rather
		// than bubbling a raw SQLite error into a generic 500.
		if (isUniqueConstraintError(error)) {
			throw new ValidationError("A grant already exists for this principal, grant type and scope");
		}
		throw error;
	}
}

async function deleteGrant(id: string, actor?: { userId?: string | null; role?: string | null }) {
	// Read the row BEFORE deleting: afterwards there is nothing left to route the notification by
	// or to describe in the audit entry, and a revocation is precisely what an audit trail is for.
	const existing = await db.query.knowledgeGrants.findFirst({
		where: eq(knowledgeGrants.id, id),
		columns: {
			principalType: true,
			principalId: true,
			grantType: true,
			clearanceLevel: true,
			tagId: true,
			collectionId: true,
		},
	});
	await db.delete(knowledgeGrants).where(eq(knowledgeGrants.id, id));
	if (existing) {
		emitAclChanged(existing.principalType, existing.principalId, "grant_removed");
		recordKnowledgeAclEvent({
			actorUserId: actor?.userId ?? null,
			actorRole: actor?.role ?? null,
			eventType: "grant_removed",
			subjectType: existing.principalType,
			subjectId: existing.principalId,
			targetType: "grant",
			targetId: id,
			detail: {
				grantType: existing.grantType,
				clearanceLevel: existing.clearanceLevel,
				tagId: existing.tagId,
				collectionId: existing.collectionId,
			},
		});
	}
	return { ok: true as const };
}

/**
 * Cap on users notified for a ROLE-scoped authorization change.
 *
 * A role grant affects everyone holding that role, so the fan-out is bounded the same way the
 * drift notification is: past the cap some clients keep a stale badge until their next refetch,
 * which is far better than an unbounded scan on every grant edit.
 */
const ACL_NOTIFY_MAX_USERS = 200;

/**
 * Announce that a principal's knowledge authorization changed.
 *
 * Only user ids and a coarse reason cross the bus — never level names or tag ids. The client
 * refetches through the ACL-checked endpoints, so this cannot become a channel for learning which
 * compartments exist. Failure is swallowed: a stale badge must never fail the grant edit itself.
 */
function emitAclChanged(
	principalType: "user" | "role",
	principalId: string,
	reason: "grant_added" | "grant_removed" | "user_acl_replaced",
): void {
	void (async () => {
		let userIds: string[];
		if (principalType === "user") {
			userIds = [principalId];
		} else {
			// Role grant → everyone with that role, bounded.
			const rows = await db.query.users.findMany({
				where: (u, { eq: e }) => e(u.role, principalId as "admin" | "user"),
				columns: { id: true },
				limit: ACL_NOTIFY_MAX_USERS,
			});
			userIds = rows.map((r) => r.id);
		}
		if (userIds.length === 0) return;
		eventBus.emit({ type: "knowledge:acl_changed", userIds, reason });
	})().catch((err) => {
		logger.warn("knowledge ACL notification failed", {
			principalType,
			reason,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

/** Per-user outcome of a bulk grant. `skipped` = the identical grant already existed. */
export interface BulkGrantResult {
	userId: string;
	status: "granted" | "skipped" | "failed";
	grantId?: string;
	reason?: string;
}

/**
 * Grant ONE credential to MANY users in a single transaction.
 *
 * Shape rationale: one credential × many users (not an arbitrary matrix) keeps the write
 * bounded and the result table readable. The route caps `userIds` at 200 (Zod), and every
 * referenced entity is validated BEFORE the transaction opens so the transaction body stays
 * short — no validation queries are issued while holding the write lock.
 *
 * Atomicity: the whole batch commits or nothing does. A non-existent user or an already-held
 * identical grant does NOT fail the batch (they are reported per-user as `failed` / `skipped`);
 * only an infrastructure error aborts and rolls back, so a partial half-state is impossible.
 * Callers are responsible for authorization (admin-only at the route layer).
 */
async function bulkGrant(
	input: {
		collectionId?: string;
		userIds: string[];
		grantType: "clearance" | "tag" | "review";
		clearanceLevel?: string;
		tagId?: string;
		canWrite?: boolean;
	},
	/** Who is granting — recorded as ONE audit row for the whole batch. */
	actor?: { userId?: string | null; role?: string | null },
): Promise<{
	ok: true;
	granted: number;
	skipped: number;
	failed: number;
	results: BulkGrantResult[];
}> {
	// Collapse duplicates while preserving the caller's ordering, so the response rows line
	// up with the submitted list and a repeated id can't insert the same grant twice.
	const userIds = [...new Set(input.userIds)];

	// ── Pre-transaction validation (bounded, indexed lookups) ──
	if (input.grantType === "clearance") {
		const level = await db.query.knowledgeLevels.findFirst({
			where: eq(knowledgeLevels.name, input.clearanceLevel as string),
			columns: { id: true },
		});
		if (!level) throw new ValidationError(`Unknown clearance level: ${input.clearanceLevel}`);
	} else {
		const tag = await db.query.knowledgeTags.findFirst({
			where: eq(knowledgeTags.id, input.tagId as string),
			columns: { id: true },
		});
		if (!tag) throw new NotFoundError("Knowledge tag", input.tagId ?? "");
	}
	if (input.collectionId) {
		const col = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, input.collectionId),
			columns: { id: true },
		});
		if (!col) throw new NotFoundError("Knowledge collection", input.collectionId);
	}

	// Existence check for the target users, in ONE query rather than N.
	const existing = await db.query.users.findMany({
		where: (u, { inArray }) => inArray(u.id, userIds),
		columns: { id: true },
	});
	const knownUsers = new Set(existing.map((u) => u.id));

	// Already-held identical grants → reported as skipped instead of duplicated. Scoped to the
	// candidate users so this stays a bounded read (index: idx_kgrant_principal).
	const heldGrants = await db.query.knowledgeGrants.findMany({
		where: (g, { and: a, eq: e, inArray }) =>
			a(
				e(g.principalType, "user"),
				inArray(g.principalId, userIds),
				e(g.grantType, input.grantType),
			),
	});
	const alreadyHeld = new Set(
		heldGrants
			.filter(
				(g) =>
					(g.collectionId ?? null) === (input.collectionId ?? null) &&
					(input.grantType === "clearance"
						? g.clearanceLevel === input.clearanceLevel
						: g.tagId === input.tagId) &&
					g.canWrite === (input.canWrite ?? false),
			)
			.map((g) => g.principalId),
	);

	const now = nowIso();
	const results: BulkGrantResult[] = [];
	const toInsert: (typeof knowledgeGrants.$inferInsert)[] = [];
	for (const userId of userIds) {
		if (!knownUsers.has(userId)) {
			results.push({ userId, status: "failed", reason: "user_not_found" });
			continue;
		}
		if (alreadyHeld.has(userId)) {
			results.push({ userId, status: "skipped", reason: "already_granted" });
			continue;
		}
		const id = generateId();
		toInsert.push({
			id,
			collectionId: input.collectionId ?? null,
			principalType: "user",
			principalId: userId,
			grantType: input.grantType,
			clearanceLevel: input.grantType === "clearance" ? (input.clearanceLevel ?? null) : null,
			tagId: input.grantType === "clearance" ? null : (input.tagId ?? null),
			canWrite: input.canWrite ?? false,
			createdAt: now,
		});
		results.push({ userId, status: "granted", grantId: id });
	}

	// Single transaction: either every row lands or none does.
	if (toInsert.length > 0) {
		db.transaction((tx) => {
			for (const g of toInsert) tx.insert(knowledgeGrants).values(g).run();
		});
		// One event for the whole batch (all targets are users here) rather than N events.
		const grantedUserIds = results.filter((r) => r.status === "granted").map((r) => r.userId);
		if (grantedUserIds.length > 0) {
			eventBus.emit({
				type: "knowledge:acl_changed",
				userIds: grantedUserIds.slice(0, ACL_NOTIFY_MAX_USERS),
				reason: "grant_added",
			});
			// One audit row for the batch, listing the affected subjects. Recording N rows for one
			// admin action would bury the actual event in noise.
			recordKnowledgeAclEvent({
				actorUserId: actor?.userId ?? null,
				actorRole: actor?.role ?? null,
				eventType: "grants_bulk_added",
				detail: {
					grantType: input.grantType,
					clearanceLevel: input.clearanceLevel ?? null,
					tagId: input.tagId ?? null,
					collectionId: input.collectionId ?? null,
					canWrite: input.canWrite ?? false,
					grantedUserIds,
				},
			});
		}
	}

	return {
		ok: true,
		granted: results.filter((r) => r.status === "granted").length,
		skipped: results.filter((r) => r.status === "skipped").length,
		failed: results.filter((r) => r.status === "failed").length,
		results,
	};
}

/**
 * Read a collection's ACL attributes for admin UI echo-back: the classification level gating
 * the collection itself, the controlled tag compartment, and the owner. Small, fixed column
 * projection — never returns entry bodies or counts of unreadable content.
 */
async function getCollectionAcl(id: string): Promise<{
	collectionId: string;
	name: string;
	slug: string;
	defaultLevel: string;
	classificationLevel: string | null;
	controlledTags: string[];
	ownerUserId: string | null;
	ownerUsername: string | null;
}> {
	const col = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, id),
		columns: {
			id: true,
			name: true,
			slug: true,
			defaultLevel: true,
			classificationLevel: true,
			controlledTagsJson: true,
			ownerUserId: true,
		},
	});
	if (!col) throw new NotFoundError("Knowledge collection", id);
	// Resolve the owner's display name so the UI doesn't have to fetch the whole user list
	// just to render one id.
	const owner = col.ownerUserId
		? await db.query.users.findFirst({
				where: eq(users.id, col.ownerUserId),
				columns: { username: true },
			})
		: null;
	return {
		collectionId: col.id,
		name: col.name,
		slug: col.slug,
		defaultLevel: col.defaultLevel,
		classificationLevel: col.classificationLevel ?? null,
		controlledTags: asStringArray(col.controlledTagsJson),
		ownerUserId: col.ownerUserId ?? null,
		ownerUsername: owner?.username ?? null,
	};
}

// ─── Per-user ACL management (convenience over knowledge_grants principalType=user) ───

/** Read a user's aggregated ACL: clearance level name + granted tag ids + review tag ids. */
async function getUserAcl(userId: string): Promise<{
	clearanceLevel: string | null;
	tagIds: string[];
	reviewTagIds: string[];
	canWrite: boolean;
}> {
	const grants = await db.query.knowledgeGrants.findMany({
		where: and(eq(knowledgeGrants.principalType, "user"), eq(knowledgeGrants.principalId, userId)),
	});
	const levels = await levelRankMap();
	let clearanceLevel: string | null = null;
	let bestRank = -1;
	const tagIds: string[] = [];
	const reviewTagIds: string[] = [];
	let canWrite = false;
	for (const g of grants) {
		if (g.canWrite) canWrite = true;
		if (g.grantType === "clearance" && g.clearanceLevel) {
			const r = levels.get(g.clearanceLevel) ?? 0;
			if (r > bestRank) {
				bestRank = r;
				clearanceLevel = g.clearanceLevel;
			}
		} else if (g.grantType === "tag" && g.tagId) {
			tagIds.push(g.tagId);
		} else if (g.grantType === "review" && g.tagId) {
			reviewTagIds.push(g.tagId);
		}
	}
	return { clearanceLevel, tagIds, reviewTagIds, canWrite };
}

/**
 * Replace a user's ACL: clears existing user grants, then inserts the new set.
 * clearanceLevel null = no clearance grant. Done in a transaction.
 */
async function setUserAcl(
	userId: string,
	input: {
		clearanceLevel?: string | null;
		tagIds?: string[];
		reviewTagIds?: string[];
		canWrite?: boolean;
	},
	/** Who is replacing this user's ACL — recorded in the ACL audit trail. */
	actor?: { userId?: string | null; role?: string | null },
): Promise<{ ok: true }> {
	const now = nowIso();
	const newGrants: (typeof knowledgeGrants.$inferInsert)[] = [];
	if (input.clearanceLevel) {
		newGrants.push({
			id: generateId(),
			collectionId: null,
			principalType: "user",
			principalId: userId,
			grantType: "clearance",
			clearanceLevel: input.clearanceLevel,
			tagId: null,
			canWrite: input.canWrite ?? false,
			createdAt: now,
		});
	}
	for (const tagId of input.tagIds ?? []) {
		newGrants.push({
			id: generateId(),
			collectionId: null,
			principalType: "user",
			principalId: userId,
			grantType: "tag",
			clearanceLevel: null,
			tagId,
			canWrite: false,
			createdAt: now,
		});
	}
	for (const tagId of input.reviewTagIds ?? []) {
		newGrants.push({
			id: generateId(),
			collectionId: null,
			principalType: "user",
			principalId: userId,
			grantType: "review",
			clearanceLevel: null,
			tagId,
			canWrite: false,
			createdAt: now,
		});
	}
	db.transaction((tx) => {
		tx.delete(knowledgeGrants)
			.where(
				and(eq(knowledgeGrants.principalType, "user"), eq(knowledgeGrants.principalId, userId)),
			)
			.run();
		for (const g of newGrants) tx.insert(knowledgeGrants).values(g).run();
	});
	// Replace-in-place: the user's whole credential set may have moved in either direction.
	emitAclChanged("user", userId, "user_acl_replaced");
	recordKnowledgeAclEvent({
		actorUserId: actor?.userId ?? null,
		actorRole: actor?.role ?? null,
		eventType: "user_acl_replaced",
		subjectType: "user",
		subjectId: userId,
		// This is a wholesale replacement, so record the resulting credential set rather than a
		// diff — level names and tag ids only.
		detail: {
			clearanceLevel: input.clearanceLevel ?? null,
			tagIds: input.tagIds ?? [],
			reviewTagIds: input.reviewTagIds ?? [],
			canWrite: input.canWrite ?? false,
		},
	});
	return { ok: true };
}

/** Remove ALL grants for a user (called when the user is deleted). */
async function purgeUserGrants(userId: string): Promise<void> {
	await db
		.delete(knowledgeGrants)
		.where(and(eq(knowledgeGrants.principalType, "user"), eq(knowledgeGrants.principalId, userId)));
}

/**
 * List users who can access an entry, along with the reason (admin / owner / dual-axis match).
 * Returns at most 100 users to avoid unbounded queries.
 */
async function getEntryAccessibleUsers(entryId: string): Promise<
	{
		userId: string;
		username: string;
		role: string;
		reason: "admin" | "owner" | "grant";
	}[]
> {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, entryId),
		columns: {
			id: true,
			collectionId: true,
			ownerUserId: true,
			classificationLevel: true,
			controlledTagsJson: true,
		},
	});
	if (!entry) return [];

	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, entry.collectionId),
		columns: {
			id: true,
			defaultLevel: true,
			classificationLevel: true,
			controlledTagsJson: true,
			ownerUserId: true,
		},
	});
	if (!collection) return [];

	const allUsers = await db.query.users.findMany({
		columns: { id: true, username: true, role: true },
	});

	const aclCol: AclCollection = {
		id: collection.id,
		defaultLevel: collection.defaultLevel,
		classificationLevel: collection.classificationLevel,
		controlledTagsJson: collection.controlledTagsJson,
		ownerUserId: collection.ownerUserId,
	};
	const aclEntry: AclEntry = {
		id: entry.id,
		collectionId: entry.collectionId,
		ownerUserId: entry.ownerUserId,
		classificationLevel: entry.classificationLevel,
		controlledTagsJson: entry.controlledTagsJson,
	};

	const results: {
		userId: string;
		username: string;
		role: string;
		reason: "admin" | "owner" | "grant";
	}[] = [];

	// Load ALL grants once and aggregate caps in memory, instead of calling
	// resolvePrincipalCaps per user (which issues one grants query each → N+1).
	const allGrants = await db.query.knowledgeGrants.findMany();
	const levels = await levelRankMap();
	const userGrants = new Map<string, typeof allGrants>();
	const roleGrants = new Map<string, typeof allGrants>();
	for (const g of allGrants) {
		const bucket = g.principalType === "user" ? userGrants : roleGrants;
		const arr = bucket.get(g.principalId);
		if (arr) arr.push(g);
		else bucket.set(g.principalId, [g]);
	}

	// Reproduce resolvePrincipalCaps' aggregation over a user's grants ∪ role grants.
	const capsFor = (userId: string, role: Role): PrincipalCaps => {
		const caps: PrincipalCaps = {
			userId,
			role,
			isAdmin: false,
			clearanceRank: 0,
			grantedTagIds: new Set(),
			hasWriteGrant: false,
			reviewTagIds: new Set(),
			collectionScopes: new Map(),
		};
		const applicable = [...(userGrants.get(userId) ?? []), ...(roleGrants.get(role) ?? [])];
		for (const grant of applicable) applyGrantToCaps(caps, grant, levels);
		return caps;
	};

	for (const u of allUsers) {
		if (results.length >= 100) break;
		if (u.role === "admin") {
			results.push({ userId: u.id, username: u.username, role: u.role, reason: "admin" });
			continue;
		}
		const isOwner =
			(entry.ownerUserId && entry.ownerUserId === u.id) ||
			(collection.ownerUserId && collection.ownerUserId === u.id);
		if (isOwner) {
			results.push({ userId: u.id, username: u.username, role: u.role, reason: "owner" });
			continue;
		}
		const caps = capsFor(u.id, u.role as Role);
		if (await canRead(caps, aclEntry, aclCol)) {
			results.push({ userId: u.id, username: u.username, role: u.role, reason: "grant" });
		}
	}
	return results;
}

export const knowledgeAcl = {
	resolvePrincipalCaps,
	resolveCapsByUserId,
	resolveCapsForAllUsers,
	canRead,
	canReadCollection,
	canWriteCollection,
	isCollectionOwnerOrAdmin,
	isEntryOwnerOrAdmin,
	canWriteMain,
	canReview,
	readableEntryFilter,
	invalidateLevelCache,
	listLevels,
	createLevel,
	updateLevel,
	deleteLevel,
	updateCollectionAcl,
	listTags,
	createTag,
	updateTag,
	deleteTag,
	listTagTypes,
	createTagType,
	updateTagType,
	deleteTagType,
	listGrants,
	createGrant,
	deleteGrant,
	bulkGrant,
	getCollectionAcl,
	getUserAcl,
	setUserAcl,
	purgeUserGrants,
	getEntryAccessibleUsers,
};
