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

export type NarratorTrait =
	| "standalone"
	| "ask-in-passing"
	| "background"
	| "plan"
	| "knowledge-steward"
	| "scheduled";

/** Trait marking a Knowledge Steward narrator (a standalone knowledge-base management session). */
export const KNOWLEDGE_KIND_TRAIT = "knowledge-steward";

/** Whether the given traits mark this narrator as a Knowledge Steward. */
export function isKnowledgeStewardNarrator(raw: unknown): boolean {
	return parseTraits(raw).includes(KNOWLEDGE_KIND_TRAIT);
}

export const NARRATOR_DRAFT_TRAIT_PREFIX = "draft:";

export interface NarratorDraftTrait {
	text: string;
	updatedAt: string;
	updatedBy?: string | null;
	sourceId?: string | null;
}

/** Parse the JSON traits column (handles null / empty). */
export function parseTraits(raw: unknown): string[] {
	if (raw == null) return [];
	if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: [];
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

export function isDraftTrait(trait: string): boolean {
	return trait.startsWith(NARRATOR_DRAFT_TRAIT_PREFIX);
}

export function redactDraftTraits(raw: unknown): string[] {
	return parseTraits(raw).filter((trait) => !isDraftTrait(trait));
}

function encodeDraftTrait(payload: NarratorDraftTrait): string {
	return `${NARRATOR_DRAFT_TRAIT_PREFIX}${Buffer.from(JSON.stringify(payload), "utf-8").toString(
		"base64url",
	)}`;
}

function decodeDraftTrait(trait: string): NarratorDraftTrait | null {
	if (!trait.startsWith(NARRATOR_DRAFT_TRAIT_PREFIX)) return null;
	try {
		const json = Buffer.from(trait.slice(NARRATOR_DRAFT_TRAIT_PREFIX.length), "base64url").toString(
			"utf-8",
		);
		const parsed = JSON.parse(json) as Partial<NarratorDraftTrait>;
		if (typeof parsed.text !== "string" || typeof parsed.updatedAt !== "string") return null;
		return {
			text: parsed.text,
			updatedAt: parsed.updatedAt,
			updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
			sourceId: typeof parsed.sourceId === "string" ? parsed.sourceId : null,
		};
	} catch {
		return null;
	}
}

export function parseDraftTrait(raw: unknown): NarratorDraftTrait | null {
	for (const trait of parseTraits(raw)) {
		const draft = decodeDraftTrait(trait);
		if (draft?.text.trim()) return draft;
	}
	return null;
}

export function hasDraftTrait(raw: unknown): boolean {
	return parseDraftTrait(raw) != null;
}

export function upsertDraftTrait(raw: unknown, draft: NarratorDraftTrait | null): string[] {
	const traits = parseTraits(raw).filter((trait) => !isDraftTrait(trait));
	if (!draft?.text.trim()) return traits;
	return [...traits, encodeDraftTrait(draft)];
}

/** Check whether traits indicate the narrator is currently in plan mode. */
export function isPlanModeTrait(raw: unknown): boolean {
	return parseTraits(raw).includes("plan");
}
