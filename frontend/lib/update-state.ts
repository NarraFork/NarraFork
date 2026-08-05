export type UpdateCoordinationPhase =
	| "idle"
	| "draining"
	| "draining_background_bash"
	| "quiescing_tools"
	| "restarting";

/** One reason the scheduled update cannot restart yet, as reported by the coordinator. */
export interface UpdateWaitBlocker {
	kind: "background_bash" | "ordinary" | "response" | "tool_start_grant" | "pre_admission";
	narratorId?: string;
	toolUseId?: string;
	waitingMs: number;
}

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

/** Instructions the server returns for a manually applied update. */
export interface UpdateInstructions {
	manual: boolean;
	command?: string;
	newBinaryPath?: string;
	updatePath?: string;
	message: string;
}

/**
 * Shape of `GET /api/update/status` — prepared-update metadata plus coordination state.
 *
 * Only fields the server actually returns belong here. Declaring extra optional fields makes
 * the UI look like it handles cases that can never happen (dead branches that always read
 * `undefined`), so capability flags that live on `/api/platform` stay out of this type.
 */
export interface PreparedUpdateStatus {
	ready: boolean;
	updateFile?: string;
	canAutoRestart: boolean;
	newBinaryPath?: string;
	updatePath?: string;
	placed?: boolean;
	version?: string;
	phase?: UpdateCoordinationPhase;
	scheduled?: boolean;
	targetVersion?: string;
	pendingExecutionCount?: number;
	pendingBackgroundBashCount?: number;
	pendingOrdinaryExecutionCount?: number;
	resumableExecutionCount?: number;
	pausedToolCount?: number;
	cancelRequested?: boolean;
	blockers?: UpdateWaitBlocker[];
	error?: string;
	errorKind?: "failed" | "cancelled";
	instructions?: UpdateInstructions;
}

/** Poll rate while an update is actively draining and the phase changes second to second. */
export const UPDATE_STATUS_ACTIVE_POLL_MS = 1000;
/**
 * Low-frequency fallback so a schedule started in another tab (or before a reload) is noticed
 * without a per-second request when nothing is happening.
 */
export const UPDATE_STATUS_IDLE_POLL_MS = 20_000;

export interface UpdateStatusPollInput {
	status: PreparedUpdateStatus | undefined;
	/** When the current `status` value was received. */
	dataUpdatedAt: number;
	/** Ignore a coordination error recorded before this timestamp. */
	errorSinceMs?: number | null;
	/** A local apply call just reported a scheduled update, before the first poll confirms it. */
	assumeScheduled?: boolean;
}

/**
 * Decide the status poll interval.
 *
 * Two things must hold. An update that is actually draining needs second-level updates, because
 * every phase transition is user-visible and the waits have no deadline. Everything else must
 * still be polled slowly rather than not at all: the schedule can be started from another tab,
 * and a reload resets local state, so a hard `false` would leave the UI permanently stale.
 * Polling only stops when a *current* coordination error says the attempt is over.
 */
export function resolveUpdateStatusPollInterval(input: UpdateStatusPollInput): number | false {
	const { status, dataUpdatedAt, errorSinceMs = null, assumeScheduled = false } = input;
	const statusErrorIsCurrent =
		!!status?.error && (errorSinceMs === null || dataUpdatedAt >= errorSinceMs);
	if (statusErrorIsCurrent && !status?.scheduled && !assumeScheduled) return false;
	return assumeScheduled || status?.scheduled === true
		? UPDATE_STATUS_ACTIVE_POLL_MS
		: UPDATE_STATUS_IDLE_POLL_MS;
}

/** Whether a scheduled update exists, so ambient UI must stay mounted and polling. */
export function hasActiveUpdateSchedule(status: PreparedUpdateStatus | undefined): boolean {
	return status?.scheduled === true;
}

export interface ScheduledUpdatePill {
	labelKey: string;
	tooltipKey: string;
	/** Show a spinner instead of a clock: the restart is actively in progress. */
	busy: boolean;
}

/**
 * Decide what the header pill should say about a scheduled update.
 *
 * Returns null when nothing is scheduled, so the caller falls back to the ordinary
 * "update available" pill. The waits behind each phase are unbounded, which is exactly why the
 * phase is worth surfacing: the user should be able to tell "waiting on my own work" apart from
 * "the new version is starting".
 */
export function resolveScheduledUpdatePill(
	status:
		| {
				scheduled?: boolean;
				phase?: UpdateCoordinationPhase;
				cancelRequested?: boolean;
		  }
		| undefined,
): ScheduledUpdatePill | null {
	if (!status?.scheduled) return null;
	if (status.cancelRequested) {
		return {
			labelKey: "updatePillCancelling",
			tooltipKey: "updatePillCancellingTooltip",
			busy: true,
		};
	}
	switch (status.phase) {
		case "restarting":
			return {
				labelKey: "updatePillRestarting",
				tooltipKey: "updatePillRestartingTooltip",
				busy: true,
			};
		case "draining":
		case "draining_background_bash":
		case "quiescing_tools":
			return {
				labelKey: "updatePillWaiting",
				tooltipKey: "updatePillWaitingTooltip",
				busy: false,
			};
		default:
			return {
				labelKey: "updatePillScheduled",
				tooltipKey: "updatePillScheduledTooltip",
				busy: false,
			};
	}
}

export function shouldShowUpdateScheduleButton(options: {
	canRestartIntoUpdate: boolean;
	applySucceeded: boolean;
	coordinationFailed: boolean;
}): boolean {
	return options.canRestartIntoUpdate && (!options.applySucceeded || options.coordinationFailed);
}
