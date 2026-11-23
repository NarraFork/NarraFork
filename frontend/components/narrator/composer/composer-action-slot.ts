/**
 * Which right-hand action cluster the composer row paints.
 *
 * The text input itself is ALWAYS mounted — including for a running subagent
 * that is not yet taken over. Product docs and `use-narrator-send` treat
 * "queue a message at the next tool boundary" as a first-class control that
 * sits lighter than takeover; unmounting the textarea until takeover would
 * delete that path and force every mid-run correction through takeover.
 *
 * Slot meanings:
 * - `takeover` — empty composer + canTakeover → paint the takeover button as
 *   the primary action (instead of interrupt/send). Typing flips this to
 *   `primary` so the user can queue without taking over.
 * - `taken-over` — user is driving the subagent: primary action + stop-takeover.
 * - `primary` — ordinary send/interrupt/retry/queue cluster.
 */
export type ComposerActionSlot = "takeover" | "taken-over" | "primary";

export function resolveComposerActionSlot(input: {
	canTakeover: boolean;
	isTakenOver: boolean;
	hasInput: boolean;
	hasAttachments: boolean;
	editing: boolean;
}): ComposerActionSlot {
	if (input.isTakenOver) return "taken-over";
	if (input.canTakeover && !input.hasInput && !input.hasAttachments && !input.editing) {
		return "takeover";
	}
	return "primary";
}

/**
 * Whether the composer may offer takeover instead of Stop.
 *
 * Takeover holds the result a run delivers to its caller, so the server refuses it
 * for a session that delivers nowhere ("This session does not deliver a result").
 * Painting takeover there would hide Stop and leave a running subagent with no
 * working control. `deliversResult` is absent on older servers; treat that as unknown
 * and keep the previous behaviour.
 */
export function resolveCanTakeover(input: {
	isSubagent: boolean;
	isActive: boolean;
	isTakenOver: boolean;
	retryRecoveryAllowsInterrupt: boolean;
	deliversResult: unknown;
}): boolean {
	return (
		input.isSubagent &&
		input.isActive &&
		!input.isTakenOver &&
		input.retryRecoveryAllowsInterrupt &&
		input.deliversResult !== false
	);
}
