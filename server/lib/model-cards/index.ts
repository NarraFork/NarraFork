/**
 * Effective model cards = builtin seed data overlaid with the user's edits.
 *
 * ## Storage: only the difference is persisted
 *
 * `settings.agent.modelCards` holds *deltas*, not whole cards. A saved entry
 * carries its `modelKey` plus only the fields that differ from the builtin card,
 * and a card identical to its builtin counterpart is not stored at all.
 *
 * The consequence, which is the reason for choosing it: upgrading NarraFork
 * picks up new builtin values (a vendor price change, a widened window) for
 * every field the user never touched, while each field the user *did* set stays
 * pinned across upgrades. The cost is that a field edited to coincidentally
 * equal the current builtin value is indistinguishable from an untouched one, so
 * it will follow future builtin changes. The card editor surfaces per-field
 * provenance so that is visible rather than surprising.
 *
 * Deleting a builtin card stores a tombstone (`deleted: true`). Builtin cards
 * are code, so without one the next load would resurrect the card.
 */

import {
	buildModelCardIndex,
	cardContextWindow,
	cardEffortLevels,
	cardMaxCompletionTokens,
	type ModelCard,
	type ModelCardMatch,
	type ModelCardPricing,
	normalizeModelCardKey,
	resolveModelCardField,
} from "@shared/model-card";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { BUILTIN_MODEL_CARDS } from "./builtin";

export { BUILTIN_MODEL_CARDS };

/**
 * Marker attached to a merged card recording which fields the user set.
 *
 * Non-enumerable so it never reaches settings.json or an API response: it is
 * derivation metadata, and persisting it would turn a transient detail into
 * stored state that later has to be migrated.
 */
const USER_FIELDS = Symbol("narrafork.modelCard.userFields");

interface CardWithProvenance extends ModelCard {
	[USER_FIELDS]?: ReadonlySet<string>;
}

/** Whether the given field of a merged card carries a user-set value. */
export function isUserSetField(card: ModelCard | undefined, field: string): boolean {
	return (card as CardWithProvenance | undefined)?.[USER_FIELDS]?.has(field) ?? false;
}

/** Fields a user delta may carry, beyond the identifying key. */
const OVERRIDABLE_FIELDS = [
	"displayName",
	"family",
	"notes",
	"aliases",
	"matchPrefixes",
	"contextWindow",
	"maxCompletionTokens",
	"effortLevels",
	"officialPricing",
] as const;

type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

/** Which fields of an effective card came from the user rather than the builtin. */
export interface ModelCardProvenance {
	modelKey: string;
	/** True when no builtin card exists for this key. */
	userCreated: boolean;
	/** Fields explicitly set by the user. */
	overriddenFields: OverridableField[];
}

export interface EffectiveModelCards {
	cards: ModelCard[];
	provenance: Map<string, ModelCardProvenance>;
}

function builtinByKey(): Map<string, ModelCard> {
	const map = new Map<string, ModelCard>();
	for (const card of BUILTIN_MODEL_CARDS) {
		map.set(normalizeModelCardKey(card.modelKey), card);
	}
	return map;
}

/**
 * Deep-ish equality for card field values: primitives, string arrays and the
 * flat pricing object are all that can appear.
 *
 * `undefined` and an empty array compare equal on purpose — the editor sends
 * `[]` for a cleared list, and treating that as different from "absent" would
 * persist a delta that changes nothing and then pin the field forever.
 */
function fieldValuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const aEmpty = a === undefined || a === null || (Array.isArray(a) && a.length === 0);
	const bEmpty = b === undefined || b === null || (Array.isArray(b) && b.length === 0);
	if (aEmpty && bEmpty) return true;
	if (aEmpty !== bEmpty) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => item === b[i]);
	}
	if (typeof a === "object" && typeof b === "object") {
		const aRec = a as Record<string, unknown>;
		const bRec = b as Record<string, unknown>;
		const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
		for (const key of keys) {
			// A pricing field left at 0 and one left absent both mean "no price".
			const aVal = aRec[key] ?? 0;
			const bVal = bRec[key] ?? 0;
			if (aVal !== bVal) return false;
		}
		return true;
	}
	return false;
}

/**
 * Merge builtin cards with the stored user deltas.
 *
 * Field-level overlay, not whole-card replacement: a delta that only carries a
 * price must not erase the builtin card's window.
 */
export function mergeModelCards(userCards: readonly ModelCard[] = []): EffectiveModelCards {
	const builtins = builtinByKey();
	const provenance = new Map<string, ModelCardProvenance>();
	const merged = new Map<string, ModelCard>();

	for (const [key, card] of builtins) {
		merged.set(key, { ...card });
	}

	for (const raw of userCards) {
		const key = normalizeModelCardKey(raw.modelKey);
		if (!key) continue;
		const builtin = builtins.get(key);

		if (raw.deleted) {
			merged.delete(key);
			continue;
		}

		const base: CardWithProvenance = builtin ? { ...builtin } : { modelKey: key };
		const overridden: OverridableField[] = [];
		for (const field of OVERRIDABLE_FIELDS) {
			const value = raw[field];
			if (value === undefined) continue;
			// Record the override even when the value equals the builtin: the delta
			// is on disk, so the user did set it. `diffModelCards` is what decides
			// whether it is worth keeping.
			overridden.push(field);
			// biome-ignore lint/suspicious/noExplicitAny: field-generic assignment
			(base as any)[field] = value;
		}
		base.modelKey = key;
		base.builtin = Boolean(builtin);
		// Non-enumerable: keeps the marker out of JSON.stringify, and therefore out
		// of both settings.json and the HTTP response.
		Object.defineProperty(base, USER_FIELDS, {
			value: new Set<string>(overridden),
			enumerable: false,
		});
		merged.set(key, base);
		provenance.set(key, {
			modelKey: key,
			userCreated: !builtin,
			overriddenFields: overridden,
		});
	}

	return { cards: [...merged.values()], provenance };
}

/**
 * Reduce a full set of effective cards back to the minimal deltas worth storing.
 *
 * Returns cards carrying `modelKey` plus only the fields that differ from their
 * builtin counterpart, tombstones for deleted builtins, and complete cards for
 * user-created keys.
 */
export function diffModelCards(effective: readonly ModelCard[]): ModelCard[] {
	const builtins = builtinByKey();
	const out: ModelCard[] = [];
	const seen = new Set<string>();

	for (const card of effective) {
		const key = normalizeModelCardKey(card.modelKey);
		if (!key) continue;
		seen.add(key);
		const builtin = builtins.get(key);

		if (!builtin) {
			// User-created: store it whole, minus the builtin marker.
			const { builtin: _builtin, ...rest } = card;
			out.push({ ...rest, modelKey: key });
			continue;
		}

		const delta: ModelCard = { modelKey: key };
		let changed = false;
		for (const field of OVERRIDABLE_FIELDS) {
			if (fieldValuesEqual(card[field], builtin[field])) continue;
			// biome-ignore lint/suspicious/noExplicitAny: field-generic assignment
			(delta as any)[field] = card[field];
			changed = true;
		}
		if (changed) out.push(delta);
	}

	// A builtin key absent from the effective set was deleted.
	for (const key of builtins.keys()) {
		if (!seen.has(key)) out.push({ modelKey: key, deleted: true });
	}

	return out;
}

// ---------------------------------------------------------------------------
// Resolution against the effective set
// ---------------------------------------------------------------------------

/**
 * Cached index over the effective cards.
 *
 * Rebuilt only when the card set changes, rather than on every lookup:
 * the window is resolved on each streamed usage event, and rebuilding a ~60-card
 * index there would be pure waste.
 */
let cachedSource: readonly ModelCard[] | undefined;
let cachedCards: ModelCard[] | undefined;
let cachedIndex: ReturnType<typeof buildModelCardIndex> | undefined;

/**
 * Keyed on the identity of the user-card array, not on a revision counter.
 *
 * A counter would have to come from the settings module, which imports the
 * consumer of this one — the resulting cycle is why identity is used instead.
 * Every path that changes the cards assigns a fresh array (the settings route
 * assigns the validated result; a reload replaces the whole `agent` object), so
 * identity moves exactly when the data does. In-place mutation would not be
 * observed, hence {@link invalidateModelCardCache} for that case.
 */
function ensureIndex(userCards: readonly ModelCard[]) {
	if (cachedIndex && cachedSource === userCards) {
		return { index: cachedIndex, cards: cachedCards ?? [] };
	}
	const { cards } = mergeModelCards(userCards);
	cachedCards = cards;
	cachedIndex = buildModelCardIndex(cards);
	cachedSource = userCards;
	return { index: cachedIndex, cards };
}

/** Drop the memoized index (tests, and any in-place settings mutation). */
export function invalidateModelCardCache(): void {
	cachedSource = undefined;
	cachedCards = undefined;
	cachedIndex = undefined;
}

export interface ModelCardResolution<T> {
	value: T;
	card: ModelCard;
	matchedVia: ModelCardMatch;
}

/**
 * Resolve one field for a model against the effective cards.
 *
 * Field-wise rather than card-wise, because cards are sparse: the card that
 * matches an id is often not the one that answers a given question. See
 * `resolveModelCardField` for the concrete failure this avoids.
 */
function resolveField<T>(
	model: string | undefined,
	userCards: readonly ModelCard[],
	extract: (card: ModelCard) => T | undefined,
): ModelCardResolution<T> | null {
	const { index } = ensureIndex(userCards);
	return resolveModelCardField(model, index, extract);
}

/** The effective cards, for API responses and the settings UI. */
export function getEffectiveModelCards(userCards: readonly ModelCard[] = []): ModelCard[] {
	return ensureIndex(userCards).cards;
}

/**
 * Context window (tokens) asserted by a card, plus who set it.
 *
 * `userSet` distinguishes an edited card from untouched builtin seed data. The
 * caller needs it because Anthropic's 1M official-API floor must apply to
 * builtin values (preserving pre-card behaviour) but yield to a user's explicit
 * smaller number.
 */
export function modelCardContextWindow(
	model: string | undefined,
	userCards: readonly ModelCard[],
): { contextWindow: number; userSet: boolean } | null {
	const hit = resolveField(model, userCards, cardContextWindow);
	if (!hit) return null;
	return {
		contextWindow: hit.value,
		userSet: isUserSetField(hit.card, "contextWindow"),
	};
}

/** Max completion tokens asserted by a card, or null. */
export function modelCardMaxCompletionTokens(
	model: string | undefined,
	userCards: readonly ModelCard[],
): number | null {
	return resolveField(model, userCards, cardMaxCompletionTokens)?.value ?? null;
}

/** Reasoning tiers asserted by a card (never containing `none`), or null. */
export function modelCardEffortLevels(
	model: string | undefined,
	userCards: readonly ModelCard[],
): ReasoningEffort[] | null {
	return resolveField(model, userCards, cardEffortLevels)?.value ?? null;
}

/**
 * Official reference prices asserted by a card, or null.
 *
 * Resolved as one unit rather than field by field: mixing the input price of one
 * card with the output price of another would produce a rate pair no vendor ever
 * published. A card counts as pricing this model only if it names a non-zero
 * input or output price.
 */
export function modelCardPricing(
	model: string | undefined,
	userCards: readonly ModelCard[],
): ModelCardPricing | null {
	return (
		resolveField(model, userCards, (card) => {
			const pricing = card.officialPricing;
			if (!pricing) return undefined;
			const hasAny = (pricing.input ?? 0) > 0 || (pricing.output ?? 0) > 0;
			return hasAny ? pricing : undefined;
		})?.value ?? null
	);
}
