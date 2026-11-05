/**
 * `auto:<logical model>` model values (docs/PROVIDER-SOURCING-DESIGN.md §4.1).
 *
 * A model value is either `<service prefix>:<upstream model>`, which pins that service,
 * or `auto:<catalog model id>`, which lets routing choose among every service that
 * offers the model. `auto` is a reserved prefix: no provider may use it.
 *
 * Pure text and rules only, so the host, the frontend and plugins share one definition.
 */

export const AUTO_MODEL_PREFIX = "auto";

/** The `auto:` value for a catalog model id. */
export function autoModelValue(modelId: string): string {
	return `${AUTO_MODEL_PREFIX}:${modelId}`;
}

/** The catalog model id of an `auto:` value, or null for anything else. */
export function parseAutoModelValue(value: string | null | undefined): string | null {
	const raw = value?.trim();
	if (!raw?.startsWith(`${AUTO_MODEL_PREFIX}:`)) return null;
	const modelId = raw.slice(AUTO_MODEL_PREFIX.length + 1).trim();
	return modelId || null;
}

export function isAutoModelValue(value: string | null | undefined): boolean {
	return parseAutoModelValue(value) !== null;
}

/** One `auto:` model for the picker, sources in the order routing would try them now. */
export interface AutoModelInfo {
	/** `auto:<modelId>`. */
	value: string;
	modelId: string;
	/** Catalog display name. */
	name: string;
	sources: Array<{
		/** `<prefix>:<upstream model>`; selecting it pins this provider. */
		value: string;
		provider: string;
		available: boolean;
		subscription: boolean;
	}>;
}

/** How a provider's model matched its catalog entry; only strong matches join `auto`. */
export type AutoMatch = "exact" | "alias" | "suffix" | "prefix" | "none";

export interface AutoCandidateInput {
	/** Full `<prefix>:<upstream model>` value. */
	value: string;
	/** The provider prefix. */
	provider: string;
	/** Catalog model id the value resolved to, when it did. */
	modelId?: string;
	matchedVia: AutoMatch;
}

/**
 * The provider models that serve `auto:<modelId>`, one per provider, in input order.
 *
 * - Only exact and alias matches count: a dated suffix or a longest-prefix match only
 *   borrows parameters and may be a different model.
 * - When one provider offers several upstream ids for the same model, an exact match wins,
 *   then the lowest id, so the choice is stable.
 */
export function autoCandidates(
	modelId: string,
	inputs: readonly AutoCandidateInput[],
): AutoCandidateInput[] {
	const byProvider = new Map<string, AutoCandidateInput>();
	const order: string[] = [];
	for (const input of inputs) {
		if (input.modelId !== modelId) continue;
		if (input.matchedVia !== "exact" && input.matchedVia !== "alias") continue;
		const current = byProvider.get(input.provider);
		if (!current) {
			byProvider.set(input.provider, input);
			order.push(input.provider);
			continue;
		}
		const better =
			(input.matchedVia === "exact" && current.matchedVia !== "exact") ||
			(input.matchedVia === current.matchedVia && input.value < current.value);
		if (better) byProvider.set(input.provider, input);
	}
	return order.map((provider) => byProvider.get(provider) as AutoCandidateInput);
}
