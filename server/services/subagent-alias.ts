import { eq } from "drizzle-orm";
import { AsyncMutex } from "../lib/async-mutex";

// === Background task alias registry ===
// Provides human-readable aliases for background tasks (both Agent and Bash).
// Scoped per parent narrator — aliases are unique within a narrator's session.
// Maps: narratorId → Map<alias, realId> and realId → alias (bidirectional).

interface AliasRegistry {
	aliasToId: Map<string, string>;
	idToAlias: Map<string, string>;
}

let _aliasRegistries: Map<string, AliasRegistry> | undefined;
function getAliasRegistryMap() {
	if (!_aliasRegistries) _aliasRegistries = new Map();
	return _aliasRegistries;
}

const subagentAliasRegistrationLock = new AsyncMutex();

async function loadAliasDb() {
	const [{ db }, schema] = await Promise.all([import("../db"), import("../db/schema")]);
	return { db, backgroundTasks: schema.backgroundTasks, narrators: schema.narrators };
}

function getOrCreateRegistry(narratorId: string): AliasRegistry {
	const map = getAliasRegistryMap();
	let reg = map.get(narratorId);
	if (!reg) {
		reg = { aliasToId: new Map(), idToAlias: new Map() };
		map.set(narratorId, reg);
	}
	return reg;
}

function setRegistryAlias(reg: AliasRegistry, realId: string, alias: string): void {
	const existing = reg.idToAlias.get(realId);
	if (existing && existing !== alias) reg.aliasToId.delete(existing);
	reg.aliasToId.set(alias, realId);
	reg.idToAlias.set(realId, alias);
}

/**
 * Highest `-N` suffix tried before giving up on a readable alias.
 *
 * Reaching this means hundreds of same-named agents under one parent, which no
 * real workflow produces. The bound exists so a pathological `isTaken` (one that
 * answers true for everything) cannot spin the main thread forever; callers get a
 * still-unique, still-resolvable id-based alias instead of a hang.
 */
const MAX_ALIAS_SUFFIX = 1000;

function uniqueAliasFrom(base: string, isTaken: (alias: string) => boolean, fallbackSeed: string) {
	let alias = base;
	let suffix = 2;
	while (isTaken(alias)) {
		if (suffix > MAX_ALIAS_SUFFIX) {
			// Fall back to something unique by construction rather than keep counting.
			// The seed is the real narrator id, so the result stays a valid selector.
			return { alias: `${base}-${shortAgentId(fallbackSeed)}`, conflicted: true };
		}
		alias = `${base}-${suffix}`;
		suffix++;
	}
	return { alias, conflicted: alias !== base };
}

/** Slugify a string for use as an alias. */
export const SUBAGENT_ALIAS_TRAIT_PREFIX = "subagent-alias:";

/**
 * How much of a narrator id to keep when no readable name is available.
 *
 * Defined here rather than in `subagent-label` because the alias fallback below
 * needs it and this is the lower-level module (`subagent-label` imports from
 * here, so the dependency cannot go the other way).
 */
const SHORT_ID_CHARS = 8;

/**
 * A short, still-resolvable stand-in for a narrator id.
 *
 * A prefix is deliberate: `subagentMatchesSelector` accepts `id.startsWith(...)`,
 * so this remains a valid Await/Send selector. The previous fallback slugified the
 * WHOLE id, which both leaked 21 opaque characters into the prompt and — being
 * lowercased — no longer matched the id it came from.
 */
export function shortAgentId(subagentId: string): string {
	return subagentId.slice(0, SHORT_ID_CHARS);
}

/**
 * Base name for an alias: the caller's desired name when it is a real name, else
 * a short id. `desiredAlias` is often defaulted to the narrator id by callers
 * (recovery does `title || subagentId`), so an id passed here is treated as "no
 * name given" rather than slugified into prompt-visible gibberish.
 */
function aliasBaseFor(subagentId: string, desiredAlias?: string): string {
	if (desiredAlias && desiredAlias !== subagentId) {
		const slug = slugifyTaskAlias(desiredAlias);
		if (slug) return slug;
	}
	return shortAgentId(subagentId) || "task";
}

export function slugifyTaskAlias(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

function getPersistedAliasTraits(traits: unknown): string[] {
	return Array.isArray(traits)
		? traits.filter(
				(trait): trait is string =>
					typeof trait === "string" && trait.startsWith(SUBAGENT_ALIAS_TRAIT_PREFIX),
			)
		: [];
}

export function getPersistedSubagentAliases(traits: unknown): string[] {
	return getPersistedAliasTraits(traits)
		.map((trait) => trait.slice(SUBAGENT_ALIAS_TRAIT_PREFIX.length))
		.filter(Boolean);
}

export interface SubagentSelectorCandidate {
	id: string;
	title?: string | null;
	traits?: unknown;
}

/**
 * Match user-facing subagent selectors consistently across execution and
 * permission preflight paths. Supports real IDs, ID prefixes, exact titles,
 * slugified titles, and aliases persisted in narrator traits.
 */
export function subagentMatchesSelector(
	candidate: SubagentSelectorCandidate,
	selector: string,
): boolean {
	const normalized = selector.trim();
	if (!normalized) return false;
	const titleAlias = candidate.title ? slugifyTaskAlias(candidate.title) : "";
	return (
		candidate.id === normalized ||
		candidate.id.startsWith(normalized) ||
		candidate.title === normalized ||
		titleAlias === normalized ||
		getPersistedSubagentAliases(candidate.traits).includes(normalized)
	);
}

export async function persistSubagentAlias(
	parentNarratorId: string,
	subagentId: string,
	alias: string,
): Promise<void> {
	const { db, narrators } = await loadAliasDb();
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, subagentId),
		columns: { parentNarratorId: true, traits: true },
	});
	if (!row || row.parentNarratorId !== parentNarratorId) return;

	const currentTraits = Array.isArray(row.traits)
		? row.traits.filter((trait): trait is string => typeof trait === "string")
		: [];
	const nextTraits = [
		...currentTraits.filter((trait) => !trait.startsWith(SUBAGENT_ALIAS_TRAIT_PREFIX)),
		`${SUBAGENT_ALIAS_TRAIT_PREFIX}${alias}`,
	];
	await db
		.update(narrators)
		.set({ traits: nextTraits, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, subagentId));
}

async function getPersistedTakenAliases(
	parentNarratorId: string,
	excludeSubagentId: string,
): Promise<Set<string>> {
	const { db, backgroundTasks, narrators } = await loadAliasDb();
	const siblings = await db.query.narrators.findMany({
		where: eq(narrators.parentNarratorId, parentNarratorId),
		columns: { id: true, title: true, traits: true },
	});
	const tasks = await db.query.backgroundTasks.findMany({
		where: eq(backgroundTasks.parentNarratorId, parentNarratorId),
		columns: { id: true, alias: true, subagentNarratorId: true },
	});
	const taken = new Set<string>();
	for (const sibling of siblings) {
		if (sibling.id === excludeSubagentId) continue;
		taken.add(sibling.id);
		const titleAlias = sibling.title ? slugifyTaskAlias(sibling.title) : "";
		if (titleAlias) taken.add(titleAlias);
		for (const alias of getPersistedSubagentAliases(sibling.traits)) taken.add(alias);
	}
	for (const task of tasks) {
		if (task.subagentNarratorId === excludeSubagentId) continue;
		taken.add(task.id);
		if (task.alias) taken.add(task.alias);
	}
	return taken;
}

export interface SubagentAliasPersistenceAdapter {
	getTakenAliases(parentNarratorId: string, excludeSubagentId: string): Promise<Set<string>>;
	persistAlias(parentNarratorId: string, subagentId: string, alias: string): Promise<void>;
}

const defaultSubagentAliasPersistenceAdapter: SubagentAliasPersistenceAdapter = {
	getTakenAliases: getPersistedTakenAliases,
	persistAlias: persistSubagentAlias,
};

let subagentAliasPersistenceAdapter = defaultSubagentAliasPersistenceAdapter;

export function setSubagentAliasPersistenceAdapterForTests(
	adapter?: SubagentAliasPersistenceAdapter,
): void {
	subagentAliasPersistenceAdapter = adapter ?? defaultSubagentAliasPersistenceAdapter;
}

/**
 * Register and persist a subagent alias. Unlike the in-memory registry, this
 * checks already-persisted sibling aliases/title aliases so aliases remain
 * resolvable after the parent narrator session ends or the server restarts.
 */
export async function registerAndPersistSubagentAlias(
	parentNarratorId: string,
	subagentId: string,
	desiredAlias?: string,
): Promise<{ alias: string; conflicted: boolean }> {
	return subagentAliasRegistrationLock.acquire(parentNarratorId, async () => {
		const reg = getOrCreateRegistry(parentNarratorId);
		const existing = reg.idToAlias.get(subagentId);
		const base = existing || aliasBaseFor(subagentId, desiredAlias);
		const persistedTaken = await subagentAliasPersistenceAdapter.getTakenAliases(
			parentNarratorId,
			subagentId,
		);
		const isTaken = (candidate: string) => {
			const memoryOwner = reg.aliasToId.get(candidate);
			return (
				persistedTaken.has(candidate) || (memoryOwner !== undefined && memoryOwner !== subagentId)
			);
		};
		const { alias, conflicted } =
			existing && !isTaken(existing)
				? { alias: existing, conflicted: false }
				: uniqueAliasFrom(base, isTaken, subagentId);

		setRegistryAlias(reg, subagentId, alias);
		await subagentAliasPersistenceAdapter.persistAlias(parentNarratorId, subagentId, alias);
		return { alias, conflicted: conflicted || alias !== base };
	});
}

/**
 * Register a background task alias. If the desired alias is taken,
 * appends an incrementing suffix (-2, -3, ...).
 * Returns the final unique alias and whether a conflict occurred.
 */
export function registerTaskAlias(
	narratorId: string,
	realId: string,
	desiredAlias?: string,
): { alias: string; conflicted: boolean } {
	const reg = getOrCreateRegistry(narratorId);

	// Already registered
	const existing = reg.idToAlias.get(realId);
	if (existing) return { alias: existing, conflicted: false };

	const base = aliasBaseFor(realId, desiredAlias);
	const { alias, conflicted } = uniqueAliasFrom(
		base,
		(candidate) => reg.aliasToId.has(candidate),
		realId,
	);
	setRegistryAlias(reg, realId, alias);
	return { alias, conflicted };
}

/**
 * Resolve an alias or real ID to the actual task/subagent ID.
 * Checks alias registry first, then returns the input as-is (assumed to be a real ID).
 */
export function resolveTaskAlias(narratorId: string, aliasOrId: string): string {
	const reg = getAliasRegistryMap().get(narratorId);
	if (!reg) return aliasOrId;
	return reg.aliasToId.get(aliasOrId) ?? aliasOrId;
}

/** Get the alias for a real ID (if registered). */
export function getTaskAlias(narratorId: string, realId: string): string | undefined {
	return getAliasRegistryMap().get(narratorId)?.idToAlias.get(realId);
}

/** Clean up alias registry for a narrator. */
export function clearAliasRegistry(narratorId: string): void {
	getAliasRegistryMap().delete(narratorId);
}
