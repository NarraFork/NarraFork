/**
 * Older-history auto-load decision helpers for the narrator message lists.
 *
 * Kept dependency-free (no React / UI imports) so the logic is unit testable in
 * isolation under `bun test`. Extracted from chunk-scroll-utils.ts: these are
 * consumed by every list implementation, while the rest of that module is
 * chunk-window specific.
 */

export const OLDER_HISTORY_INTENT_TIMEOUT_MS = 2_500;

/**
 * Resolve the persisted preference without briefly enabling auto-load while its
 * query is still pending. If the query has finished without data (for example a
 * request failure), fall back to the server/database default of enabled.
 */
export function resolveOlderHistoryAutoLoadEnabled(
	preference: boolean | undefined,
	preferenceLoading: boolean,
): boolean {
	return preference ?? !preferenceLoading;
}

export interface OlderHistoryAutoLoadInput {
	intentAt: number | null;
	now: number;
	autoLoadEnabled: boolean;
	hasOlder: boolean;
	expanding: boolean;
	atBottom: boolean;
	scrollTop: number;
	triggerPx: number;
	intentTimeoutMs?: number;
}

export interface OlderHistoryAutoLoadDecision {
	shouldLoad: boolean;
	/** Retained while the user is still travelling upward; cleared on expiry/bottom/load. */
	nextIntentAt: number | null;
}

/**
 * Decide whether a near-top scroll may expand older history. Scroll events alone
 * are insufficient: a recent explicit user gesture toward history is required.
 */
export function resolveOlderHistoryAutoLoad({
	intentAt,
	now,
	autoLoadEnabled,
	hasOlder,
	expanding,
	atBottom,
	scrollTop,
	triggerPx,
	intentTimeoutMs = OLDER_HISTORY_INTENT_TIMEOUT_MS,
}: OlderHistoryAutoLoadInput): OlderHistoryAutoLoadDecision {
	if (intentAt == null) return { shouldLoad: false, nextIntentAt: null };
	const intentAge = now - intentAt;
	if (intentAge < 0 || intentAge > intentTimeoutMs || atBottom) {
		return { shouldLoad: false, nextIntentAt: null };
	}
	if (!autoLoadEnabled || !hasOlder || expanding || scrollTop > triggerPx) {
		return { shouldLoad: false, nextIntentAt: intentAt };
	}
	return { shouldLoad: true, nextIntentAt: null };
}
