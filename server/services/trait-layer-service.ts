import { readQuery } from "@server/db/worker-read";
/**
 * Loads the upper trait layers (user, project, policy source) and resolves them
 * against a narrator's own traits.
 *
 * `lib/trait-resolution.ts` owns the merge; this service owns the I/O. It exists
 * separately because the resolver must stay pure and testable without a database.
 *
 * Caching: the two lookups are small, indexed, single-row reads, but some call
 * sites are hot (per tool-permission check). A short TTL keeps them cheap while
 * still letting a project/user trait edit take effect promptly; any write to
 * either layer invalidates explicitly, so the TTL is only a backstop rather than
 * the correctness mechanism.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects, userPreferences } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseRuntimePolicyTraits } from "../lib/runtime-policy-trait";
import {
	MAX_POLICY_SOURCE_DEPTH,
	policySourceIdOf,
	RUNTIME_SOURCE_COLUMNS,
} from "../lib/runtime-source";
import {
	type EnforcedTraitKeys,
	parseEnforcedKeys,
	type ResolvedTraitsResult,
	resolveLayeredTraits,
} from "../lib/trait-resolution";
import { type RuntimePolicy, resolveRuntimePolicy } from "./agent-runtime/policy";
import { resolveNarratorProjectId } from "./narrator-project";

/**
 * Per-layer locks. Separate instances because the layers are different rows with
 * independent concurrency; one shared lock would serialize unrelated edits.
 */
const projectTraitLock = new AsyncMutex();
const userTraitLock = new AsyncMutex();

const LAYER_CACHE_TTL_MS = 5_000;

interface CachedLayer {
	traits: string[];
	expiresAt: number;
}

const projectLayerCache = new Map<string, CachedLayer>();
const userLayerCache = new Map<string, CachedLayer>();

/** Bound the caches so a long-lived process cannot accumulate entries forever. */
const MAX_CACHE_ENTRIES = 500;

function readCache(cache: Map<string, CachedLayer>, key: string): string[] | null {
	const hit = cache.get(key);
	if (!hit) return null;
	if (hit.expiresAt <= Date.now()) {
		cache.delete(key);
		return null;
	}
	return hit.traits;
}

function writeCache(cache: Map<string, CachedLayer>, key: string, traits: string[]): void {
	if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
		// Drop the soonest-expiring entry rather than clearing the whole cache.
		let oldestKey: string | null = null;
		let oldestExpiry = Number.POSITIVE_INFINITY;
		for (const [candidate, value] of cache) {
			if (value.expiresAt < oldestExpiry) {
				oldestExpiry = value.expiresAt;
				oldestKey = candidate;
			}
		}
		if (oldestKey) cache.delete(oldestKey);
	}
	cache.set(key, { traits, expiresAt: Date.now() + LAYER_CACHE_TTL_MS });
}

/** Invalidate a project's cached trait layer. Call after any write. */
export function invalidateProjectTraitLayer(projectId: string): void {
	projectLayerCache.delete(projectId);
}

/** Invalidate a user's cached trait layer. Call after any write. */
export function invalidateUserTraitLayer(userId: string): void {
	userLayerCache.delete(userId);
}

/** Clear all cached layers. Test-only seam. */
export function resetTraitLayerCaches(): void {
	projectLayerCache.clear();
	userLayerCache.clear();
}

/**
 * `strict` is for capability resolution: a hard ceiling that cannot be read must
 * fail the caller instead of resolving as if the layer were empty.
 */
async function loadProjectTraits(
	projectId: string | null | undefined,
	strict = false,
): Promise<string[]> {
	if (!projectId) return [];
	const cached = readCache(projectLayerCache, projectId);
	if (cached) return cached;
	try {
		const row = await readQuery(
			db.query.projects.findFirst({
				where: eq(projects.id, projectId),
				columns: { traits: true },
			}),
		);
		const traits = Array.isArray(row?.traits) ? row.traits : [];
		writeCache(projectLayerCache, projectId, traits);
		return traits;
	} catch (error) {
		if (strict) throw error;
		// A failed upper-layer read must not break the session; degrade to
		// narrator-only traits, which is the pre-layering behaviour.
		logger.debug("Failed to load project trait layer", { projectId, error: String(error) });
		return [];
	}
}

async function loadUserTraits(
	userId: string | null | undefined,
	strict = false,
): Promise<string[]> {
	if (!userId) return [];
	const cached = readCache(userLayerCache, userId);
	if (cached) return cached;
	try {
		const row = await readQuery(
			db.query.userPreferences.findFirst({
				where: eq(userPreferences.userId, userId),
				columns: { traits: true },
			}),
		);
		const traits = Array.isArray(row?.traits) ? row.traits : [];
		writeCache(userLayerCache, userId, traits);
		return traits;
	} catch (error) {
		if (strict) throw error;
		logger.debug("Failed to load user trait layer", { userId, error: String(error) });
		return [];
	}
}

/**
 * Re-exported so the many existing importers keep working while there is exactly
 * one implementation. This module used to carry its own copy that preferred
 * `contextProjectId` over the chapter — the opposite of what the session layer
 * did. See `narrator-project.ts` for why the chapter wins.
 */
export { resolveNarratorProjectId };

export interface ResolveTraitsInput {
	/** The narrator's own traits column. */
	narratorTraits: unknown;
	/** Project layer, or null for a standalone narrator. */
	projectId?: string | null;
	/** Acting user, resolved per request like `fastModeDefault` is. */
	actingUserId?: string | null;
	/** Registered policy source (see {@link policySourceIdOf}); its effective traits narrow. */
	policySourceId?: string | null;
}

/** Re-exported: the one source rule (`lib/runtime-source.ts`). */

/**
 * Resolve the effective traits for a narrator across all layers.
 *
 * When no project, acting user or policy source applies, this returns the
 * narrator's traits unchanged, so standalone/unattended paths keep today's exact
 * behaviour. The source layer is always strict: a source that cannot be resolved
 * fails the call instead of silently dropping its boundaries.
 */
export async function resolveEffectiveTraits(
	input: ResolveTraitsInput,
): Promise<ResolvedTraitsResult> {
	return resolveLayers(input, false, []);
}

async function resolveLayers(
	input: ResolveTraitsInput,
	strict: boolean,
	chain: readonly string[],
): Promise<ResolvedTraitsResult> {
	const [projectTraits, userTraits, source] = await Promise.all([
		loadProjectTraits(input.projectId, strict),
		loadUserTraits(input.actingUserId, strict),
		input.policySourceId
			? resolveNarratorTraitsInChain(input.policySourceId, input.actingUserId ?? null, chain)
			: null,
	]);
	return resolveLayeredTraits({
		user: userTraits.length > 0 ? { traits: userTraits } : null,
		project: projectTraits.length > 0 ? { traits: projectTraits } : null,
		source: source ? { traits: source.traits } : null,
		narrator: { traits: input.narratorTraits },
	});
}

async function resolveNarratorTraitsInChain(
	narratorId: string,
	actingUserId: string | null,
	chain: readonly string[],
): Promise<ResolvedTraitsResult> {
	if (chain.includes(narratorId)) throw new Error("Policy source cycle detected");
	if (chain.length >= MAX_POLICY_SOURCE_DEPTH) throw new Error("Policy source chain is too deep");
	const row = await readQuery(
		db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: {
				...RUNTIME_SOURCE_COLUMNS,
				traits: true,
				chapterId: true,
				contextProjectId: true,
			},
		}),
	);
	if (!row) throw new NotFoundError("Narrator", narratorId);
	return resolveLayers(
		{
			// Every delegation stores its compiled template ceiling here at creation.
			narratorTraits: row.traits,
			projectId: await resolveNarratorProjectId(row),
			actingUserId,
			policySourceId: policySourceIdOf(row),
		},
		true,
		[...chain, narratorId],
	);
}

/**
 * Strict effective traits of a stored narrator, including its registered policy
 * source chain. This is the resolution capability decisions are made from: any
 * unreadable layer, missing source, cycle or over-deep chain throws.
 */
async function resolveNarratorEffectiveTraits(
	narratorId: string,
	actingUserId: string | null = null,
): Promise<ResolvedTraitsResult> {
	return resolveNarratorTraitsInChain(narratorId, actingUserId, []);
}

/**
 * Capability ceiling of a stored narrator: its own, project, user and policy-source
 * ceilings merged narrow-only. Throws when any of them cannot be read, so a
 * failure never runs a narrator without its ceiling.
 */
export async function resolveNarratorRuntimePolicy(
	narratorId: string,
	actingUserId: string | null = null,
): Promise<RuntimePolicy> {
	return (await resolveNarratorCapabilities(narratorId, actingUserId)).policy;
}

/** One strict resolution yielding both the effective traits and the ceiling derived from them. */
export async function resolveNarratorCapabilities(
	narratorId: string,
	actingUserId: string | null = null,
): Promise<{ traits: ResolvedTraitsResult; policy: RuntimePolicy }> {
	const traits = await resolveNarratorEffectiveTraits(narratorId, actingUserId);
	return { traits, policy: resolveRuntimePolicy(parseRuntimePolicyTraits(traits.traits)) };
}

// === Layer trait editing ===

export type EditableTraitLayer = "user" | "project";

export interface LayerTraitsView {
	layer: EditableTraitLayer;
	/** Raw traits array as stored for this layer. */
	traits: string[];
	/** Which trait keys this layer marks as enforced. */
	enforced: EnforcedTraitKeys;
}

async function readLayerTraits(layer: EditableTraitLayer, ownerId: string): Promise<string[]> {
	if (layer === "project") {
		const row = await readQuery(
			db.query.projects.findFirst({
				where: eq(projects.id, ownerId),
				columns: { traits: true },
			}),
		);
		if (!row) throw new NotFoundError("Project", ownerId);
		return Array.isArray(row.traits) ? row.traits : [];
	}
	const row = await readQuery(
		db.query.userPreferences.findFirst({
			where: eq(userPreferences.userId, ownerId),
			columns: { traits: true },
		}),
	);
	// A user with no preferences row yet simply has no traits.
	return Array.isArray(row?.traits) ? row.traits : [];
}

/** Read one editable layer's traits. */
export async function getLayerTraits(
	layer: EditableTraitLayer,
	ownerId: string,
): Promise<LayerTraitsView> {
	const traits = await readLayerTraits(layer, ownerId);
	return { layer, traits, enforced: parseEnforcedKeys(traits) };
}

/**
 * Apply a mutation to one layer's traits under that layer's own lock.
 *
 * Each layer has a separate lock: they are different rows with different
 * concurrency, and sharing one lock across layers would serialize unrelated
 * edits. Writes are always confined to a single layer, so resolution semantics
 * are unaffected.
 */
export async function updateLayerTraits(
	layer: EditableTraitLayer,
	ownerId: string,
	mutate: (current: string[]) => string[],
): Promise<LayerTraitsView> {
	const lock = layer === "project" ? projectTraitLock : userTraitLock;
	const traits = await lock.acquire(ownerId, async () => {
		const current = await readLayerTraits(layer, ownerId);
		const next = mutate(current);
		const now = new Date().toISOString();
		if (layer === "project") {
			await db
				.update(projects)
				.set({ traits: next, updatedAt: now })
				.where(eq(projects.id, ownerId));
		} else {
			// The preferences row may not exist yet for a user who never changed one.
			const existing = await readQuery(
				db.query.userPreferences.findFirst({
					where: eq(userPreferences.userId, ownerId),
					columns: { id: true },
				}),
			);
			if (existing) {
				await db
					.update(userPreferences)
					.set({ traits: next, updatedAt: now })
					.where(eq(userPreferences.userId, ownerId));
			} else {
				await db.insert(userPreferences).values({
					id: generateId(),
					userId: ownerId,
					traits: next,
					createdAt: now,
					updatedAt: now,
				});
			}
		}
		return next;
	});

	if (layer === "project") invalidateProjectTraitLayer(ownerId);
	else invalidateUserTraitLayer(ownerId);
	eventBus.emit({ type: "trait-layer:changed", layer, ownerId });
	return { layer, traits, enforced: parseEnforcedKeys(traits) };
}
