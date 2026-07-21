export type UpdateCoordinationPhase =
	| "idle"
	| "draining"
	| "draining_background_bash"
	| "quiescing_tools"
	| "restarting";

export interface UpdateCoordinationCounts {
	phase?: UpdateCoordinationPhase;
	pendingExecutionCount?: number;
	pendingBackgroundBashCount?: number;
	pendingOrdinaryExecutionCount?: number;
	resumableExecutionCount?: number;
	pausedToolCount?: number;
}

export function resolveUpdateCoordinationCounts(counts: UpdateCoordinationCounts) {
	const legacyPendingCount = counts.pendingExecutionCount ?? 0;
	const hasGranularCounts =
		counts.pendingBackgroundBashCount !== undefined ||
		counts.pendingOrdinaryExecutionCount !== undefined ||
		counts.resumableExecutionCount !== undefined;
	let pendingBackgroundBashCount = counts.pendingBackgroundBashCount ?? 0;
	let pendingOrdinaryExecutionCount = counts.pendingOrdinaryExecutionCount ?? 0;

	// A legacy total cannot truthfully describe both drain phases. Attribute it only when
	// the phase identifies the currently blocking class; otherwise preserve it as a total.
	if (!hasGranularCounts) {
		if (counts.phase === "draining" || counts.phase === "draining_background_bash") {
			pendingBackgroundBashCount = legacyPendingCount;
		} else if (counts.phase === "quiescing_tools") {
			pendingOrdinaryExecutionCount = legacyPendingCount;
		}
	}

	return {
		pendingExecutionCount:
			counts.pendingExecutionCount ??
			pendingBackgroundBashCount +
				pendingOrdinaryExecutionCount +
				(counts.resumableExecutionCount ?? 0),
		pendingBackgroundBashCount,
		pendingOrdinaryExecutionCount,
		resumableExecutionCount: counts.resumableExecutionCount ?? 0,
		pausedToolCount: counts.pausedToolCount ?? 0,
	};
}

export function shouldShowUpdateScheduleButton(options: {
	canRestartIntoUpdate: boolean;
	applySucceeded: boolean;
	coordinationFailed: boolean;
}): boolean {
	return options.canRestartIntoUpdate && (!options.applySucceeded || options.coordinationFailed);
}
