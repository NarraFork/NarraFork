// Draft shape + defaults for the per-narrator context-threshold settings modal.
// Shared between NarratorPanel (which reads the effective values and runs the
// save mutation) and ContextThresholdSettingsModal (which owns the editing draft).

export type ContextThresholdsDraft = {
	standard: { pruneStart: number; compactStart: number };
	large: { pruneStart: number; compactStart: number };
};

export type ContextManagementDraft = {
	contextThresholds: ContextThresholdsDraft;
	autoCompactKeepPairs: number;
	autoCompactPruneThreshold: number;
	minPruneRatio: number;
};

export const DEFAULT_CONTEXT_THRESHOLDS_DRAFT: ContextThresholdsDraft = {
	standard: { pruneStart: 95, compactStart: 99 },
	large: { pruneStart: 95, compactStart: 99 },
};
export const DEFAULT_AUTO_COMPACT_KEEP_PAIRS = 2;
export const DEFAULT_AUTO_COMPACT_PRUNE_THRESHOLD = 80;
export const DEFAULT_MIN_PRUNE_RATIO = 30;

/**
 * Clamp + round a raw draft into the persisted ranges. Kept next to the modal so
 * both the save path and any future callers share one definition of "valid".
 */
export function normalizeContextManagementDraft(
	draft: ContextManagementDraft,
): ContextManagementDraft {
	return {
		contextThresholds: {
			standard: {
				pruneStart: Math.max(
					50,
					Math.min(100, Math.round(draft.contextThresholds.standard.pruneStart)),
				),
				compactStart: Math.max(
					50,
					Math.min(100, Math.round(draft.contextThresholds.standard.compactStart)),
				),
			},
			large: {
				pruneStart: Math.max(
					10,
					Math.min(100, Math.round(draft.contextThresholds.large.pruneStart)),
				),
				compactStart: Math.max(
					10,
					Math.min(100, Math.round(draft.contextThresholds.large.compactStart)),
				),
			},
		},
		autoCompactKeepPairs: Math.max(1, Math.min(25, Math.round(draft.autoCompactKeepPairs))),
		autoCompactPruneThreshold: Math.max(
			0,
			Math.min(100, Math.round(draft.autoCompactPruneThreshold)),
		),
		minPruneRatio: Math.max(0, Math.min(100, Math.round(draft.minPruneRatio))),
	};
}
