import type { RuntimePolicy } from "./agent-runtime/policy";

/** Service-side guards for the same capability decisions the tool schemas project. */

export const SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR =
	'"Watch({ type: "agent" })" is not available under this runtime policy. Use asynchronous Send({ id, message }) instead.';

/** Reject an agent-to-agent Await from a caller whose ceiling has no awaitAgent. */
export function assertRuntimeCanAwaitAgent(policy: RuntimePolicy): void {
	if (!policy.capabilities.watchAgent) {
		throw new Error(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
	}
}
