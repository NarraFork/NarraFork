/**
 * Layered trait resolution.
 *
 * Traits used to live only on a narrator. They now resolve across three layers,
 * lowest priority first:
 *
 *   user  →  project  →  narrator
 *
 * A layer that omits a trait inherits it. A layer that declares one may override
 * it, but *how* an override composes depends on what the trait means — which is
 * why every trait declares a merge kind rather than sharing one global rule:
 *
 * - `restriction` (disabled tools, blocked skills): a limit. Merging accumulates,
 *   so a lower layer's limit is never silently dropped by a higher one.
 * - `grant` (subagent model pools, device authorization): an allowlist. A higher
 *   layer may narrow it but never widen it past the layer above, so an override
 *   is intersected with the accumulated upper bound.
 * - `preference` (device injection, UI-ish toggles): no safety meaning, so the
 *   nearest explicit value wins and `inherit` passes through.
 *
 * Orthogonally, restriction/grant entries carry `enforced`. An enforced entry is
 * a boundary that lower-priority layers cannot relax; a non-enforced one is just
 * a default that a higher layer may loosen. Both intents are real ("this project
 * forbids Bash" vs "this project usually doesn't need that skill"), so they are
 * represented separately instead of being collapsed into one strength.
 */

export const TRAIT_LAYERS = ["user", "project", "narrator"] as const;
export type TraitLayer = (typeof TRAIT_LAYERS)[number];

export type TraitMergeKind = "restriction" | "grant" | "preference";

/** Tri-state used by preference-kind traits and per-item overrides. */
export type TraitToggle = "inherit" | "on" | "off";

export function normalizeTraitToggle(value: unknown): TraitToggle {
	return value === "on" || value === "off" ? value : "inherit";
}

/**
 * One layer's declaration for a set-shaped trait.
 *
 * `items` is the full set this layer declares. `enforced` marks it as a boundary
 * rather than a default.
 */
export interface TraitSetEntry {
	items: readonly string[];
	enforced?: boolean;
}

/** Result of resolving a set-shaped trait across layers. */
export interface ResolvedTraitSet {
	/** Effective members after merging. */
	items: Set<string>;
	/** Members that a lower-priority layer may not remove. */
	enforced: Set<string>;
	/** Layers that contributed an explicit declaration, lowest first. */
	sources: TraitLayer[];
}

function emptyResolvedSet(): ResolvedTraitSet {
	return { items: new Set(), enforced: new Set(), sources: [] };
}

/**
 * Intersect with an optional upper bound. A `null` bound means "unbounded", so
 * the value passes through unchanged.
 */
function intersectSets(value: Set<string>, bound: Set<string> | null): Set<string> {
	if (bound === null) return value;
	const out = new Set<string>();
	for (const item of value) {
		if (bound.has(item)) out.add(item);
	}
	return out;
}

export type TraitLayerInput<T> = Partial<Record<TraitLayer, T | null | undefined>>;

function orderedLayers<T>(layers: TraitLayerInput<T>): Array<[TraitLayer, T]> {
	const out: Array<[TraitLayer, T]> = [];
	for (const layer of TRAIT_LAYERS) {
		const value = layers[layer];
		if (value === null || value === undefined) continue;
		out.push([layer, value]);
	}
	return out;
}

/**
 * Merge a restriction-kind trait.
 *
 * Restrictions accumulate: the effective set is the union across layers, so a
 * higher layer can add limits. A higher layer may *remove* a limit only when no
 * lower layer declared it as enforced — that is what makes `enforced: false` a
 * default and `enforced: true` a boundary.
 */
export function mergeRestrictionTrait(layers: TraitLayerInput<TraitSetEntry>): ResolvedTraitSet {
	const declared = orderedLayers(layers);
	if (declared.length === 0) return emptyResolvedSet();

	const enforced = new Set<string>();
	let items = new Set<string>();
	const sources: TraitLayer[] = [];

	for (const [layer, entry] of declared) {
		sources.push(layer);
		const declaredItems = new Set(entry.items);
		if (entry.enforced) {
			for (const item of declaredItems) enforced.add(item);
			// An enforced layer only ever tightens.
			items = new Set([...items, ...declaredItems]);
			continue;
		}
		// A non-enforced layer states the full set it wants, so items it omits are
		// dropped — except anything a lower layer pinned as enforced.
		items = new Set(declaredItems);
		for (const item of enforced) items.add(item);
	}

	for (const item of enforced) items.add(item);
	return { items, enforced, sources };
}

/**
 * Merge a grant-kind trait.
 *
 * Grants may only narrow going up. The accumulated set acts as an upper bound, so
 * a higher layer's declaration is intersected with it; an enforced layer pins
 * that bound so no later layer can exceed it.
 *
 * `undefined` upper bound (no layer has spoken yet) means "unbounded", which is
 * why the first declaring layer is taken verbatim.
 */
export function mergeGrantTrait(layers: TraitLayerInput<TraitSetEntry>): ResolvedTraitSet {
	const declared = orderedLayers(layers);
	if (declared.length === 0) return emptyResolvedSet();

	// `null` means "nobody has spoken yet", which is distinct from an explicit
	// empty grant. Both accumulators are only ever replaced via intersectSets, so
	// no layer can widen what a lower layer allowed.
	let items: Set<string> | null = null;
	let bound: Set<string> | null = null;
	const sources: TraitLayer[] = [];

	for (const [layer, entry] of declared) {
		sources.push(layer);
		const declared = new Set(entry.items);
		const next = intersectSets(intersectSets(declared, items), bound);
		items = next;
		if (entry.enforced) bound = intersectSets(next, bound);
	}

	return {
		items: items ?? new Set(),
		enforced: bound ?? new Set(),
		sources,
	};
}

/**
 * Merge a preference-kind trait expressed as a tri-state.
 *
 * The nearest explicit value wins; `inherit` defers to the layer below. Returns
 * `"inherit"` when no layer decided, so the caller can apply its own default.
 */
export function mergeToggleTrait(layers: TraitLayerInput<TraitToggle>): TraitToggle {
	let resolved: TraitToggle = "inherit";
	for (const [, value] of orderedLayers(layers)) {
		const toggle = normalizeTraitToggle(value);
		if (toggle !== "inherit") resolved = toggle;
	}
	return resolved;
}

/**
 * Merge a preference-kind trait whose value is an arbitrary enum/scalar.
 *
 * `null`/`undefined` means "inherit". The nearest explicit value wins.
 */
export function mergeValueTrait<T>(layers: TraitLayerInput<T>): T | null {
	let resolved: T | null = null;
	for (const [, value] of orderedLayers(layers)) {
		resolved = value;
	}
	return resolved;
}

/**
 * Merge a map of per-key tri-states (for example per-device injection overrides).
 *
 * Each key resolves independently under preference semantics.
 */
export function mergeToggleMapTrait(
	layers: TraitLayerInput<Readonly<Record<string, TraitToggle>>>,
): Record<string, TraitToggle> {
	const resolved: Record<string, TraitToggle> = {};
	for (const [, map] of orderedLayers(layers)) {
		for (const [key, value] of Object.entries(map)) {
			const toggle = normalizeTraitToggle(value);
			if (toggle === "inherit") continue;
			resolved[key] = toggle;
		}
	}
	return resolved;
}

/**
 * Whether a higher layer is allowed to remove `item` from a restriction trait.
 *
 * The API layer uses this to reject an edit up front instead of writing a value
 * that resolution would silently discard.
 */
export function canRelaxRestriction(resolved: ResolvedTraitSet, item: string): boolean {
	return !resolved.enforced.has(item);
}

/**
 * Whether a higher layer may add `item` to a grant trait.
 *
 * Adding beyond an enforced upper bound is not representable, so the UI should
 * refuse it rather than appear to succeed.
 */
export function canExtendGrant(resolved: ResolvedTraitSet, item: string): boolean {
	return resolved.enforced.size === 0 || resolved.enforced.has(item);
}
