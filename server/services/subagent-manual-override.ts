// === Manual override state ===
// When a foreground subagent is interrupted, the parent narrator blocks until
// the user explicitly clicks "Update Conclusion" from the subagent page.
// Normally this map is resolved by the update-conclusion API endpoint, giving
// the user full control over when to return results. A user hard-interrupt may
// also resolve it so the parent narrator does not remain blocked forever.

export interface ManualOverrideResult {
	finalText: string;
	hasError: boolean;
	interrupted?: boolean;
}

export interface ManualOverrideEntry {
	resolve: (result: ManualOverrideResult) => void;
	parentSignal: AbortSignal;
	parentNarratorId: string;
	toolUseId: string;
	/** The subagent ID that was active when manual override started. */
	subagentId: string;
}

let _manualOverrides: Map<string, ManualOverrideEntry> | undefined;
export function getManualOverrideMap() {
	if (!_manualOverrides) _manualOverrides = new Map();
	return _manualOverrides;
}

/** Check if a subagent is in manual override (parent blocked, waiting for update-conclusion). */
export function isManualOverride(subagentId: string): boolean {
	return getManualOverrideMap().has(subagentId);
}

/** Maximum time to wait for manual override before timing out (2 hours). */
export const MANUAL_OVERRIDE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Conclusion watchers: for subagents that have already completed (done/error)
 * and whose result was already returned to the parent narrator. When the user
 * later continues operating the subagent and clicks "Update Conclusion",
 * we register a watcher that will update the parent's tool_call outputJson
 * when the subagent next completes.
 */
export interface ConclusionWatcher {
	parentNarratorId: string;
	toolUseId: string;
}

let _conclusionWatchers: Map<string, ConclusionWatcher> | undefined;
export function getConclusionWatchersMap() {
	if (!_conclusionWatchers) _conclusionWatchers = new Map();
	return _conclusionWatchers;
}

/**
 * Block until the user clicks "Update Conclusion" (or parent is interrupted / timeout).
 * Used by both runSubagent and continueSubagent when the subagent is interrupted.
 */
export function waitForManualOverride(
	subagentId: string,
	parentSignal: AbortSignal,
	parentNarratorId: string,
	toolUseId: string,
): Promise<ManualOverrideResult> {
	return new Promise<ManualOverrideResult>((resolve) => {
		// Shared cleanup: clear timeout and remove the abort listener to avoid leaks.
		const cleanup = () => {
			clearTimeout(timeoutId);
			parentSignal.removeEventListener("abort", onParentAbort);
		};

		const timeoutId = setTimeout(() => {
			const entry = getManualOverrideMap().get(subagentId);
			if (entry) {
				getManualOverrideMap().delete(subagentId);
				cleanup();
				resolve({
					finalText: "Manual override timed out after 2 hours",
					hasError: true,
				});
			}
		}, MANUAL_OVERRIDE_TIMEOUT_MS);

		getManualOverrideMap().set(subagentId, {
			resolve: (result) => {
				cleanup();
				resolve(result);
			},
			parentSignal,
			parentNarratorId,
			toolUseId,
			subagentId,
		});

		// If parent narrator is interrupted, abandon the manual override
		const onParentAbort = () => {
			const entry = getManualOverrideMap().get(subagentId);
			if (entry) {
				getManualOverrideMap().delete(subagentId);
				cleanup();
				resolve({
					finalText: "Parent narrator interrupted",
					hasError: true,
				});
			}
		};
		if (parentSignal.aborted) {
			onParentAbort();
		} else {
			parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
	});
}

/**
 * Resolve a manual-override subagent's blocked Promise.
 * Called from the update-conclusion API when the user clicks "Update Conclusion".
 */
export function resolveManualOverride(
	subagentId: string,
	finalText: string,
	hasError: boolean,
): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({ finalText, hasError });
	return true;
}

/** Hard-interrupt a manual-override subagent and unblock its parent tool call. */
export function interruptManualOverride(subagentId: string): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({
		finalText: "Subagent interrupted by user",
		hasError: false,
		interrupted: true,
	});
	return true;
}

/** Abandon a manual-override subagent (e.g. parent interrupted). */
export function abandonManualOverride(subagentId: string): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return false;
	getManualOverrideMap().delete(subagentId);
	entry.resolve({ finalText: "Manual override abandoned", hasError: true });
	return true;
}

// === Conclusion watcher public API ===

/** Register a watcher for an already-completed subagent's next conclusion. */
export function registerConclusionWatcher(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
): void {
	getConclusionWatchersMap().set(subagentId, { parentNarratorId, toolUseId });
}

/** Remove a conclusion watcher. */
export function removeConclusionWatcher(subagentId: string): boolean {
	return getConclusionWatchersMap().delete(subagentId);
}

/** Get the conclusion watcher for a subagent (if any). */
export function getConclusionWatcher(subagentId: string): ConclusionWatcher | undefined {
	return getConclusionWatchersMap().get(subagentId);
}
