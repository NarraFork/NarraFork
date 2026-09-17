// Draft shape + defaults for the per-narrator context-threshold settings modal.
// Shared between NarratorPanel (which reads the effective values and runs the
// save mutation) and ContextThresholdSettingsModal (which owns the editing draft).

import { DEFAULT_CONTEXT_THRESHOLDS } from "@shared/context-thresholds";

export type ContextThresholdsDraft = {
	standard: { compactStart: number };
	large: { compactStart: number };
};

export type ContextManagementDraft = {
	contextThresholds: ContextThresholdsDraft;
	autoCompactKeepPairs: number;
};

export const DEFAULT_CONTEXT_THRESHOLDS_DRAFT: ContextThresholdsDraft = DEFAULT_CONTEXT_THRESHOLDS;
export const DEFAULT_AUTO_COMPACT_KEEP_PAIRS = 2;

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
				compactStart: Math.max(
					50,
					Math.min(100, Math.round(draft.contextThresholds.standard.compactStart)),
				),
			},
			large: {
				compactStart: Math.max(
					10,
					Math.min(100, Math.round(draft.contextThresholds.large.compactStart)),
				),
			},
		},
		autoCompactKeepPairs: Math.max(1, Math.min(25, Math.round(draft.autoCompactKeepPairs))),
	};
}
