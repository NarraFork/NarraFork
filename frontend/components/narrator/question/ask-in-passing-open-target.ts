/**
 * ask-in-passing-open-target.ts — where a "顺便提问" answer should be opened.
 *
 * The answer to an aside is a SEPARATE narrator, and both places that reach it
 * (the pending card once its question is sent, and the resolved card's arrow)
 * used to `navigate()` to `/narrators/$id`. On a desktop dock that is the wrong
 * host: asking something in passing is by definition a side errand, and leaving
 * the page to read the answer discards the conversation the reader was in —
 * scroll position, the composer draft, and the very context the aside was about.
 *
 * A dockview surface already knows how to hold a second session beside the chat
 * (`openSubagentPanel`, used by subagent rows), and an ask-in-passing narrator is
 * exactly that shape: a read-only child conversation forked from one message. So
 * the rule is in-surface first, route as fallback:
 *
 *   - dock present  → open (or focus) a session panel next to the chat;
 *   - no dock       → navigate, as before. This is the mobile narrator page and
 *     the workspace preview, where there is no secondary area to put a panel in.
 *
 * The decision is a pure function so both call sites and the vlist bridge share
 * one behaviour, and so the "prefer the dock" half can be tested without mounting
 * a dockview surface.
 */

/** The two hosts an ask-in-passing answer can be opened in. */
export type AskInPassingOpenPlan =
	| { mode: "dock"; targetNarratorId: string }
	| { mode: "route"; targetNarratorId: string }
	| { mode: "none" };

export interface AskInPassingOpenInputs {
	/** The narrator that holds the answer; absent for legacy resolved cards. */
	targetNarratorId: string | null | undefined;
	/**
	 * Whether the surrounding surface can host a session panel beside the chat.
	 * True exactly when the dock context exposes `openSubagentPanel`.
	 */
	canOpenInDock: boolean;
}

/**
 * Decide how to open an ask-in-passing answer.
 *
 * A missing target yields `"none"` rather than a route to nowhere: pre-existing
 * resolved cards were written before `targetNarratorId` was persisted, and
 * navigating to an empty id would leave the reader on a broken page instead of
 * simply having an inert card.
 */
export function resolveAskInPassingOpenPlan(inputs: AskInPassingOpenInputs): AskInPassingOpenPlan {
	const targetNarratorId = inputs.targetNarratorId?.trim();
	if (!targetNarratorId) return { mode: "none" };
	return inputs.canOpenInDock
		? { mode: "dock", targetNarratorId }
		: { mode: "route", targetNarratorId };
}
