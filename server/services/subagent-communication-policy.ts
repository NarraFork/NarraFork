import type { RuntimePolicy } from "./agent-runtime/policy";

/** Service-side guards for the same capability decisions the tool schemas project. */

export const SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR =
	'"Await({ type: "agent" })" is not available to subagents. Use asynchronous Send({ id, message }) instead.';

/** Reject an agent-to-agent Await from a caller whose ceiling has no awaitAgent. */
export function assertRuntimeCanAwaitAgent(policy: RuntimePolicy): void {
	if (!policy.capabilities.awaitAgent) {
		throw new Error(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
	}
}
