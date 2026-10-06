import { getEffectiveNarratorDisplay, type StatusAccent } from "../../../lib/status-registry";

export function withQueueSubstatus(
	substatus: string[],
	position?: number,
	queueDepth?: number,
	queueMessage?: string,
): string[] {
	const nextSubstatus = substatus.filter(
		(s) =>
			!s.startsWith("queue_position:") &&
			!s.startsWith("queue_depth:") &&
			!s.startsWith("queue_message:"),
	);
	const safePosition = typeof position === "number" && Number.isFinite(position) ? position : null;
	if (safePosition != null && safePosition > 0) {
		const safeDepth =
			typeof queueDepth === "number" && Number.isFinite(queueDepth) ? Math.max(0, queueDepth) : 0;
		nextSubstatus.push(`queue_position:${safePosition}`, `queue_depth:${safeDepth}`);
	}
	if (queueMessage && safePosition !== 0) {
		nextSubstatus.push(`queue_message:${encodeURIComponent(queueMessage)}`);
	}
	return nextSubstatus;
}

const STATUS_BAR_SUBSTATUS_PRIORITY = [
	"error",
	// Without this the label falls back to the base status ("Waiting"), which
	// reads as "waiting for you" instead of "waiting for the model".
	"model_unavailable",
	// Same argument: an exhausted quota window is also the machine waiting.
	"quota_exhausted",
	"interrupted",
	"suspended",
	"manual_override",
	"reflecting",
	"unread",
] as const;

const LEGACY_TERMINAL_STATUS_TO_SUBSTATUS: Record<string, string> = {
	done: "unread",
	error: "error",
	interrupted: "interrupted",
};

export type NarratorStatusBarSource = {
	id?: unknown;
	status?: unknown;
	substatus?: unknown;
};

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/**
 * What the work indicator's single text slot is currently about.
 *
 * The status row has exactly two places that can talk about compaction: this
 * primary slot and an appended "· background compact · N chars" suffix. Keeping
 * the choice in one pure function is what makes them mutually exclusive; when
 * the decision lived in two independent JSX conditions the row could render the
 * same phrase (and the same progress fragment) twice.
 */
export type NarratorWorkIndicatorPrimary =
	| "retrying"
	| "blocking_compact"
	| "model_unavailable"
	| "quota_exhausted"
	| "spec_task"
	| "waiting"
	| "reflecting"
	| "planning"
	| "background_compact"
	| "thinking";

export type NarratorWorkIndicatorPlan = {
	primary: NarratorWorkIndicatorPrimary;
	/**
	 * Whether to append the short background-compact suffix. Guaranteed never to
	 * be true while `primary` is already `"background_compact"`, so the phrase and
	 * its progress fragment appear at most once per row.
	 */
	showBackgroundCompactSuffix: boolean;
	/**
	 * Whether to append the red "compact failed" suffix. The failure state is
	 * cleared the moment a new compact starts or succeeds, so the suffix can
	 * never sit next to a live compact phrase — the state machine, not this
	 * function, owns that exclusion.
	 */
	showCompactFailureSuffix: boolean;
};

/**
 * Decide what the work indicator says and whether the background-compact suffix
 * is needed.
 *
 * The `primary` order mirrors the label chain the status bar has always used, so
 * this function only removes the duplicate — it does not re-rank any state.
 *
 * The suffix exists for "the primary slot is busy describing something else
 * while a background compaction keeps running". That is independent of whether
 * the turn is still active: a finished turn with a current spec task must still
 * report the compaction somewhere, which is why `isWorking` is deliberately not
 * an input here.
 */
export function planNarratorWorkIndicator(input: {
	isRetrying: boolean;
	isBlockingCompacting: boolean;
	isBackgroundCompacting: boolean;
	isWaitingForModel: boolean;
	/** Waiting for an exhausted quota window to reset. Same "machine is waiting" slot. */
	isWaitingForQuota: boolean;
	hasSpecTask: boolean;
	isReflecting: boolean;
	isWaiting: boolean;
	isPlanning: boolean;
	/** A compact failed and the failure has not been superseded yet. */
	hasCompactFailure: boolean;
}): NarratorWorkIndicatorPlan {
	const primary: NarratorWorkIndicatorPrimary = input.isReflecting
		? "reflecting"
		: input.isRetrying
			? "retrying"
			: input.isBlockingCompacting
				? "blocking_compact"
				: input.isWaitingForModel
					? "model_unavailable"
					: input.isWaitingForQuota
						? "quota_exhausted"
						: input.hasSpecTask
							? "spec_task"
							: input.isWaiting
								? "waiting"
								: input.isPlanning
									? "planning"
									: input.isBackgroundCompacting
										? "background_compact"
										: "thinking";
	return {
		primary,
		showBackgroundCompactSuffix:
			input.isBackgroundCompacting &&
			// Blocking compaction owns the primary slot and is the thing actually
			// holding the turn up; a second compact line would just compete with it.
			!input.isBlockingCompacting &&
			primary !== "background_compact",
		// The failure suffix reports the LAST run, so it must not dress up as
		// progress on a CURRENT one: while any compact is live the state machine
		// has already cleared the failure, making this guard a pure backstop.
		showCompactFailureSuffix:
			input.hasCompactFailure && !input.isBlockingCompacting && !input.isBackgroundCompacting,
	};
}

export function getNarratorStatusBarDisplay(options: {
	panelNarratorId: string;
	narrator: NarratorStatusBarSource;
	liveSubstatus: string[];
}): StatusAccent & { labelKey: string } {
	const ownsNarrator =
		typeof options.narrator.id !== "string" || options.narrator.id === options.panelNarratorId;
	let status =
		ownsNarrator && typeof options.narrator.status === "string" ? options.narrator.status : "idle";
	let displaySubstatus = ownsNarrator
		? options.liveSubstatus.length > 0
			? options.liveSubstatus
			: stringArray(options.narrator.substatus)
		: [];
	const legacySubstatus = LEGACY_TERMINAL_STATUS_TO_SUBSTATUS[status];
	if (legacySubstatus) {
		status = "idle";
		if (!displaySubstatus.includes(legacySubstatus)) {
			displaySubstatus = [...displaySubstatus, legacySubstatus];
		}
	}
	const activeSubstatus = STATUS_BAR_SUBSTATUS_PRIORITY.find((tag) =>
		displaySubstatus.includes(tag),
	);
	const effective = getEffectiveNarratorDisplay(status, displaySubstatus);
	return {
		color: effective.color || "gray",
		accentShade: effective.accentShade,
		labelKey: activeSubstatus ? `status_${activeSubstatus}` : `status_${status}`,
	};
}
