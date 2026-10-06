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
 *                 addressed to the narrator: every provider's history builder already
 *                 treats a trailing `sys` row as the CURRENT turn rather than as
 *                 background (see `buildAnthropicHistory`'s `trailingUserText`). The
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

/** True when a row of this role leaves the next turn to the narrator. */
export function tailRoleAllowsContinue(role: string | null | undefined): boolean {
	return role === "assistant" || role === "sys";
}

/** True when this role is a server-authored injection row. */
export function isInjectionTailRole(role: string | null | undefined): boolean {
	return role === "sys";
}
