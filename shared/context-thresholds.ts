/**
 * Single source of truth for context-management thresholds shared by the
 * backend agent loop and the settings UI. Percentages express when context
 * compaction begins, split by the model's context-window
 * tier (standard vs large).
 */

/** One tier's compaction trigger percentage (0–100). */
export interface ContextThresholdTier {
	/** Trigger context compaction at this context-usage percentage. */
	compactStart: number;
}

/** Compaction thresholds for both context-window tiers. */
export interface ContextThresholds {
	/** Standard models (context window at or below the large-tier boundary). */
	standard: ContextThresholdTier;
	/** Large-context models (context window above the large-tier boundary). */
	large: ContextThresholdTier;
}

/**
 * Default thresholds. Large-context models compact earlier (75%) because the
 * same percentage of a much larger token budget is far more expensive to
 * summarize, while standard models can safely run closer to full (95%).
 * Frozen so shared consumers cannot mutate the canonical values.
 */
export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = Object.freeze({
	standard: Object.freeze({ compactStart: 95 }),
	large: Object.freeze({ compactStart: 75 }),
}) as ContextThresholds;

/** A fresh, deeply-mutable copy of {@link DEFAULT_CONTEXT_THRESHOLDS}. */
export function cloneDefaultContextThresholds(): ContextThresholds {
	return {
		standard: { ...DEFAULT_CONTEXT_THRESHOLDS.standard },
		large: { ...DEFAULT_CONTEXT_THRESHOLDS.large },
	};
}
