/**
 * Communication rules that prevent subagents from creating synchronous wait chains.
 *
 * Keep this module dependency-free so the same policy can be enforced by Send,
 * Await, and unit tests without loading the full narrator communication service.
 */

export const SUBAGENT_SEND_ASYNC_ONLY_ERROR =
	"Subagents may only use asynchronous Send. Do not set await=true; send a later Send message instead.";

export const SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR =
	'"Await({ type: "agent" })" is not available to subagents. Use asynchronous Send({ id, message }) instead.';

/** Reject a reply-waiting Send issued by a subagent. */
export function assertSubagentSendIsAsync(
	callerIsSubagent: boolean,
	shouldAwait: boolean | undefined,
): void {
	if (callerIsSubagent && shouldAwait === true) {
		throw new Error(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
	}
}

/** Reject an agent-to-agent Await issued by a subagent. */
export function assertSubagentCanAwaitAgent(callerIsSubagent: boolean): void {
	if (callerIsSubagent) {
		throw new Error(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
	}
}
