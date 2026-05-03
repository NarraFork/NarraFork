/**
 * Narrator variant & traits utilities.
 *
 * - **variant** (mutually exclusive identity, immutable after creation):
 *   `"primary"` | `"subagent:explore"` | `"subagent:plan"` | `"subagent:general"` | `"subagent:review"` | `"subagent:<custom>"`
 *
 * - **traits** (stackable tags, JSON string[] column):
 *   `"standalone"` | `"ask-in-passing"` | `"background"` plus dynamic state tags
 *   such as `"pipeline:<base64url-json>"`.
 */

// ---------------------------------------------------------------------------
// Variant helpers
// ---------------------------------------------------------------------------

const SUBAGENT_PREFIX = "subagent:";

/** Build a subagent variant string from a subagent type name. */
export function subagentVariant(subagentType: string): string {
	return `${SUBAGENT_PREFIX}${subagentType}`;
}

/** Check whether a variant represents a subagent (any kind). */
export function isSubagentVariant(variant: string): boolean {
	return variant.startsWith(SUBAGENT_PREFIX);
}

/**
 * Extract the subagent type from a variant string.
 * Returns `null` for primary narrators.
 */
export function getSubagentType(variant: string): string | null {
	return variant.startsWith(SUBAGENT_PREFIX) ? variant.slice(SUBAGENT_PREFIX.length) : null;
}

/** Check whether a variant is a read-only subagent (explore or plan). */
export function isReadOnlySubagentVariant(variant: string): boolean {
	return variant === "subagent:explore" || variant === "subagent:plan";
}

// ---------------------------------------------------------------------------
// Substatus helpers
// ---------------------------------------------------------------------------

/** Parse the JSON substatus column (handles null / string / array). */
export function parseSubstatus(raw: unknown): string[] {
	if (raw == null) return [];
	if (Array.isArray(raw)) return raw as string[];
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

// ---------------------------------------------------------------------------
// Trait helpers
// ---------------------------------------------------------------------------

export type NarratorTrait = "standalone" | "ask-in-passing" | "background";

/** Parse the JSON traits column (handles null / empty). */
export function parseTraits(raw: unknown): string[] {
	if (raw == null) return [];
	if (Array.isArray(raw)) return raw as string[];
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

export function hasTrait(traits: string[], trait: NarratorTrait): boolean {
	return traits.includes(trait);
}

export function addTrait(traits: string[], trait: NarratorTrait): string[] {
	return traits.includes(trait) ? traits : [...traits, trait];
}

export function removeTrait(traits: string[], trait: NarratorTrait): string[] {
	return traits.filter((t) => t !== trait);
}
