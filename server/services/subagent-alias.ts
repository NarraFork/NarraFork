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

function getOrCreateRegistry(narratorId: string): AliasRegistry {
	const map = getAliasRegistryMap();
	let reg = map.get(narratorId);
	if (!reg) {
		reg = { aliasToId: new Map(), idToAlias: new Map() };
		map.set(narratorId, reg);
	}
	return reg;
}

/** Slugify a string for use as an alias. */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
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

	let base = desiredAlias ? slugify(desiredAlias) : slugify(realId);
	if (!base) base = "task";

	let alias = base;
	let suffix = 2;
	let conflicted = false;
	while (reg.aliasToId.has(alias)) {
		alias = `${base}-${suffix}`;
		suffix++;
		conflicted = true;
	}

	reg.aliasToId.set(alias, realId);
	reg.idToAlias.set(realId, alias);
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
