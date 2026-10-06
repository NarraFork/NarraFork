import { resolveRuntimePolicy } from "./agent-runtime/policy";

/** Legacy service adapters: trusted caller identity is resolved by the communication
 * service; capability decisions share the tool-schema policy without loading services. */

export const SUBAGENT_SEND_ASYNC_ONLY_ERROR =
	"Subagents may only use asynchronous Send. Do not set await=true; send a later Send message instead.";

export const SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR =
	'"Await({ type: "agent" })" is not available to subagents. Use asynchronous Send({ id, message }) instead.';

/** Reject a reply-waiting Send issued by a subagent. */
export function assertSubagentSendIsAsync(
	callerIsSubagent: boolean,
	shouldAwait: boolean | undefined,
): void {
	const policy = resolveRuntimePolicy({ variant: callerIsSubagent ? "subagent" : "primary" });
	if (!policy.capabilities.sendAwait && shouldAwait === true) {
		throw new Error(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
	}
}

/** Reject an agent-to-agent Await issued by a subagent. */
export function assertSubagentCanAwaitAgent(callerIsSubagent: boolean): void {
	const policy = resolveRuntimePolicy({ variant: callerIsSubagent ? "subagent" : "primary" });
	if (!policy.capabilities.awaitAgent) {
		throw new Error(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
	}
}
