/**
 * Shared reasoning-effort tier definitions and the single downgrade ("clamp")
 * function used by both frontend and backend.
 *
 * There is exactly one downgrade semantic across the whole app: when a desired
 * tier is not supported by the target model, pick the nearest supported tier by
 * rank distance, and on a tie prefer the HIGHER tier ("就近、并列偏高").
 */

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** Ordered ranks; higher number = more reasoning. */
export const REASONING_EFFORT_RANK: Record<ReasoningEffort, number> = {
	none: 0,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 5,
};

/** All tiers in ascending rank order. */
export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Clamp a desired reasoning effort onto the tiers a model actually supports.
 *
 * Rules:
 *   - empty `supported` → return `desired` unchanged (nothing to clamp to)
 *   - `desired` ∈ `supported` → return it unchanged
 *   - otherwise pick the supported tier with the smallest rank distance to
 *     `desired`; on a tie, prefer the HIGHER tier (并列偏高). This also naturally
 *     clamps a `desired` above the highest available tier down to that highest
 *     tier, and a `desired` below the lowest available tier up to the lowest.
 */
export function clampReasoningEffort(
	desired: ReasoningEffort,
	supported: readonly ReasoningEffort[],
): ReasoningEffort {
	if (supported.length === 0) return desired;
	if (supported.includes(desired)) return desired;

	const target = REASONING_EFFORT_RANK[desired];
	let best: ReasoningEffort = supported[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const tier of supported) {
		const dist = Math.abs(REASONING_EFFORT_RANK[tier] - target);
		// Strictly smaller distance wins; equal distance prefers the higher tier.
		if (
			dist < bestDist ||
			(dist === bestDist && REASONING_EFFORT_RANK[tier] > REASONING_EFFORT_RANK[best])
		) {
			best = tier;
			bestDist = dist;
		}
	}
	return best;
}
