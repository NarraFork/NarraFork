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
import { generateId } from "../lib/id";

/** A user's role as stored on the JWT/users table. */
export type Role = "admin" | "user";

export interface Principal {
	userId: string;
	role: Role;
}

/** Aggregated capabilities of a principal, resolved from grants. */
export interface PrincipalCaps {
	userId: string;
	role: Role;
	isAdmin: boolean;
	/** Max clearance rank the principal holds (public = 0 baseline). */
	clearanceRank: number;
	/** Tag ids the principal may access (compartment grants). */
	grantedTagIds: Set<string>;
	/** Whether the principal holds any write grant (collection-scoped or global). */
	hasWriteGrant: boolean;
	/** Tag ids the principal may review (review grants). */
	reviewTagIds: Set<string>;
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
	for (const g of grants) {
		if (g.canWrite) caps.hasWriteGrant = true;
		if (g.grantType === "clearance" && g.clearanceLevel) {
			caps.clearanceRank = Math.max(caps.clearanceRank, levels.get(g.clearanceLevel) ?? 0);
		} else if (g.grantType === "tag" && g.tagId) {
			caps.grantedTagIds.add(g.tagId);
		} else if (g.grantType === "review" && g.tagId) {
			caps.reviewTagIds.add(g.tagId);
		}
	}
	return caps;
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

	const need = await rankOf(collection.classificationLevel);
	if (caps.clearanceRank < need) return false;

	const controlled = asStringArray(collection.controlledTagsJson);
	for (const t of controlled) {
		if (!caps.grantedTagIds.has(t)) return false;
	}
	return true;
}

/** Can the principal WRITE into / create entries in this collection? admin / owner / write grant. */
export function canWriteCollection(caps: PrincipalCaps, collection: AclCollection): boolean {
	if (caps.isAdmin) return true;
	if (collection.ownerUserId && collection.ownerUserId === caps.userId) return true;
	return caps.hasWriteGrant;
}

/** Can the principal manage (rename / delete / set ACL on) the collection? admin / owner only. */
export function isCollectionOwnerOrAdmin(caps: PrincipalCaps, collection: AclCollection): boolean {
	if (caps.isAdmin) return true;
	return !!collection.ownerUserId && collection.ownerUserId === caps.userId;
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

	const levelName = entry.classificationLevel ?? collection.defaultLevel;
	const need = await rankOf(levelName);
	if (caps.clearanceRank < need) return false;

	const controlled = asStringArray(entry.controlledTagsJson);
	for (const t of controlled) {
		if (!caps.grantedTagIds.has(t)) return false;
	}
	return true;
}

/** Can the principal WRITE main directly (bypass review)? owner / admin / write grant. */
export function canWriteMain(caps: PrincipalCaps, entry: AclEntry): boolean {
	if (caps.isAdmin) return true;
	if (entry.ownerUserId && entry.ownerUserId === caps.userId) return true;
	return caps.hasWriteGrant;
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
	return reviewTags.every((t) => caps.reviewTagIds.has(t));
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
) {
	const existing = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, id),
		columns: { id: true },
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

async function createGrant(input: {
	collectionId?: string;
	principalType: "user" | "role";
	principalId: string;
	grantType: "clearance" | "tag" | "review";
	clearanceLevel?: string;
	tagId?: string;
	canWrite?: boolean;
}) {
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
	return row;
}

async function deleteGrant(id: string) {
	await db.delete(knowledgeGrants).where(eq(knowledgeGrants.id, id));
	return { ok: true as const };
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
		};
		const applicable = [...(userGrants.get(userId) ?? []), ...(roleGrants.get(role) ?? [])];
		for (const g of applicable) {
			if (g.canWrite) caps.hasWriteGrant = true;
			if (g.grantType === "clearance" && g.clearanceLevel) {
				caps.clearanceRank = Math.max(caps.clearanceRank, levels.get(g.clearanceLevel) ?? 0);
			} else if (g.grantType === "tag" && g.tagId) {
				caps.grantedTagIds.add(g.tagId);
			} else if (g.grantType === "review" && g.tagId) {
				caps.reviewTagIds.add(g.tagId);
			}
		}
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
	canRead,
	canReadCollection,
	canWriteCollection,
	isCollectionOwnerOrAdmin,
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
	getUserAcl,
	setUserAcl,
	purgeUserGrants,
	getEntryAccessibleUsers,
};
