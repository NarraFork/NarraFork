/**
 * create-narrator-cwd-prefill.ts — should the cwd field be pre-filled, and with what.
 *
 * Extracted from the modal because the interesting part is a TIMING question, and
 * timing is what a rendered-component test is worst at pinning down: the settings
 * query usually has not resolved when the modal first opens on a cold start, so the
 * default project directory arrives one or two renders LATE. An effect that fires
 * only on the open transition skips that first render and never returns, which
 * leaves the field showing a placeholder while an empty submit lands somewhere else
 * — the exact "the setting does nothing" impression the prefill exists to remove.
 *
 * PURITY: no React, no DOM. The caller owns the `alreadyPrefilled` flag; this decides.
 */

export interface CwdPrefillState {
	/** Modal open state. Closing resets the decision. */
	opened: boolean;
	/** The caller's flag: a prefill already happened for this open. */
	alreadyPrefilled: boolean;
	/** Entry-point directory supplied by the caller, if any. */
	initialCwd?: string;
	/** Current field value. */
	cwd: string;
	/** `paths.defaultProjectDir` from instance settings; "" until the query resolves. */
	defaultProjectDir: string;
}

export type CwdPrefillDecision =
	/** Closed: forget that a prefill happened so the next open can decide again. */
	| { kind: "reset" }
	/** Nothing to do this render (may become actionable once settings arrive). */
	| { kind: "idle" }
	/** The field is settled — the caller's own value or the user's typing. Stop trying. */
	| { kind: "markPrefilled" }
	/** Write this value and stop trying. */
	| { kind: "prefill"; value: string };

/**
 * Decide what to do with the cwd field on this render.
 *
 * Returning `idle` while `defaultProjectDir` is still empty is the whole point: the
 * caller keeps its flag unset and re-evaluates when the settings query lands, so a
 * late default still reaches the field.
 */
export function resolveCwdPrefill(state: CwdPrefillState): CwdPrefillDecision {
	if (!state.opened) return { kind: "reset" };
	if (state.alreadyPrefilled) return { kind: "idle" };
	// A caller-supplied directory owns the field; a separate effect adopts it.
	if (state.initialCwd) return { kind: "idle" };
	// Non-empty means the user typed, or a prefill already landed. Either way this is
	// settled and must not be overwritten — clearing the field deliberately must not
	// snap back.
	if (state.cwd) return { kind: "markPrefilled" };
	if (!state.defaultProjectDir) return { kind: "idle" };
	return { kind: "prefill", value: state.defaultProjectDir };
}
