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
