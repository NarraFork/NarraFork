/**
 * create-narrator-plan-mode-prefill.ts — should the "start in plan mode" switch
 * show the instance default, and when must submit carry an explicit boolean.
 *
 * Two failure modes look identical in the UI and are silent in opposite directions:
 *
 *   - the switch always starts off while `agent.defaultStartInPlanMode` is on, so
 *     an untouched submit still creates a plan-mode narrator (the switch lied);
 *   - submit omits the field when the switch is off, and the server's
 *     `input.startInPlanMode ?? settings.agent.defaultStartInPlanMode` treats the
 *     omission as "use the default" — so unchecking the switch after a prefill
 *     is silently overridden.
 *
 * The setting may also resolve LATE (cold start). Adopting it only on the open
 * transition misses that first render forever; adopting it after the user has
 * already toggled re-imposes the default over an immediate preference.
 *
 * PURITY: no React, no DOM. The caller owns `userTouched` / `alreadyPrefilled`.
 */

export interface StartInPlanModePrefillState {
	/** Modal open state. Closing resets the per-open flags. */
	opened: boolean;
	/** The user flipped the switch this open. Settings must not write back after this. */
	userTouched: boolean;
	/** The caller's flag: a prefill already happened for this open. */
	alreadyPrefilled: boolean;
	/** Current switch value. */
	value: boolean;
	/** True once the settings query has resolved `agent.defaultStartInPlanMode`. */
	settingsKnown: boolean;
	/** `agent.defaultStartInPlanMode` from instance settings. */
	defaultStartInPlanMode: boolean;
}

export type StartInPlanModePrefillDecision =
	/** Closed: forget per-open flags so the next open can decide again. */
	| { kind: "reset" }
	/** Nothing to do this render (may become actionable once settings arrive). */
	| { kind: "idle" }
	/** The switch is settled — user's flip or a landed prefill. Stop trying. */
	| { kind: "markPrefilled" }
	/** Write the instance default and stop trying. */
	| { kind: "prefill"; value: boolean };

/**
 * Decide what to do with the switch on this render.
 *
 * Returning `idle` while `settingsKnown` is false is the whole point: the caller
 * keeps its flag unset and re-evaluates when the settings query lands, so a late
 * default still reaches the switch — unless the user already flipped it.
 */
export function resolveStartInPlanModePrefill(
	state: StartInPlanModePrefillState,
): StartInPlanModePrefillDecision {
	if (!state.opened) return { kind: "reset" };
	// An immediate preference (on OR off) owns the switch. Settings arriving later
	// must not rewrite what the user just chose.
	if (state.userTouched) return { kind: "markPrefilled" };
	if (state.alreadyPrefilled) return { kind: "idle" };
	if (!state.settingsKnown) return { kind: "idle" };
	// Already showing the instance default (including default-off on a fresh
	// false switch): settled, no write needed.
	if (state.value === state.defaultStartInPlanMode) return { kind: "markPrefilled" };
	return { kind: "prefill", value: state.defaultStartInPlanMode };
}

/**
 * Should submit carry `startInPlanMode` explicitly?
 *
 * Explicit is required once we know what the switch is supposed to mean — the
 * user flipped it, or the instance default is visible on it. Omitting then would
 * let the server fall back to the default and override a deliberate "off".
 *
 * Omit only while the switch still shows a placeholder (settings not yet loaded
 * and the user never touched it): the server default is then the least-wrong
 * answer, and matches the documented "follow settings" semantics.
 */
export function shouldSendStartInPlanMode(state: {
	userTouched: boolean;
	settingsKnown: boolean;
}): boolean {
	return state.userTouched || state.settingsKnown;
}
