/**
 * continue-tail.ts — which trailing row leaves the model owing the next turn.
 *
 * "Continue" is offered when the conversation ends on something the narrator has not
 * answered yet. Two row shapes qualify, and they used to be judged in two places with
 * two different answers:
 *
 *   `assistant` — a turn that stopped mid-flight (a tool call awaiting its result, a
 *                 truncated reply). This one was always recognized.
 *   `sys`       — a server-authored injection (a Dynamic Spec reminder, a finished
 *                 background task, a container coming up). An injection IS content
 *                 addressed to the narrator: every provider's history ends with a
 *                 trailing `sys` row as the latest input, so it is the CURRENT turn
 *                 rather than background. The
 *                 button, however, required `assistant`, so an injection landing last
 *                 left the reader with no way to say "go on" — neither Retry (which
 *                 wants a `user` tail) nor Continue appeared.
 *
 * A `user` tail is deliberately NOT continuable: that is Retry's case, and re-running
 * a human turn is a different operation with different history surgery.
 *
 * Shared rather than duplicated because the two sides answer the same question from
 * different data: the panel has a role string from the tail summary, the session
 * service walks stored rows. When they disagreed, the button and the endpoint disagreed
 * about whether there was anything to continue — a mismatch with no error to surface it.
 */

import { TEAM_DISBAND_NOTE_SOURCE, TEAM_UPGRADE_NOTE_SOURCE } from "./project-teams";

/** True when a row of this role leaves the next turn to the narrator. */
export function tailRoleAllowsContinue(role: string | null | undefined): boolean {
	return role === "assistant" || role === "sys";
}

/** True when this role is a server-authored injection row. */
export function isInjectionTailRole(role: string | null | undefined): boolean {
	return role === "sys";
}

/**
 * Injection sources that only inform the narrator and leave the next turn to the person: the
 * team conversion notes, written without a wake. A trailing row of these is not the
 * conversation's tail, so it never turns the send button into Continue; the row before it
 * decides, as it did before the note landed.
 */
const NON_TURN_INJECTION_SOURCES: ReadonlySet<string> = new Set([
	TEAM_UPGRADE_NOTE_SOURCE,
	TEAM_DISBAND_NOTE_SOURCE,
]);

/** True when a `sys` row holds only informational injections (`NON_TURN_INJECTION_SOURCES`). */
export function isNonTurnInjectionRow(
	role: string | null | undefined,
	elements: readonly unknown[],
): boolean {
	if (role !== "sys") return false;
	const injections = elements.filter(
		(element): element is { type: "system_injection"; source?: unknown } =>
			!!element &&
			typeof element === "object" &&
			(element as { type?: unknown }).type === "system_injection",
	);
	return (
		injections.length > 0 &&
		injections.every(
			(element) =>
				typeof element.source === "string" && NON_TURN_INJECTION_SOURCES.has(element.source),
		)
	);
}
