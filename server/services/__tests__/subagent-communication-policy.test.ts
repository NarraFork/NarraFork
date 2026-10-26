import { describe, expect, test } from "bun:test";
import { awaitTool } from "../../lib/agent/tools/await";
import { sendTool } from "../../lib/agent/tools/send";
import type { AgentConfig } from "../../lib/agent/types";
import { compileDelegationPolicy, resolveRuntimePolicy } from "../agent-runtime/policy";
import {
	assertRuntimeCanAwaitAgent,
	SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
} from "../subagent-communication-policy";

// Capability, not role: a delegated ceiling withholds sync waits, an undeclared one keeps them.
const delegated = resolveRuntimePolicy([compileDelegationPolicy({ template: "general" })]);
const undeclared = resolveRuntimePolicy([]);

describe("communication capability policy", () => {
	test("rejects agent Await without the awaitAgent capability", () => {
		expect(() => assertRuntimeCanAwaitAgent(delegated)).toThrow(
			SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
		);
	});

	test("keeps agent Await available when the capability is present", () => {
		expect(() => assertRuntimeCanAwaitAgent(undeclared)).not.toThrow();
	});

	test("hides synchronous agent options from schemas under a delegated ceiling", () => {
		// A parent id alone never changes the schema; only the attached ceiling does.
		const subagentConfig = { runtimePolicy: delegated } as AgentConfig;
		const primaryConfig = { parentNarratorId: "parent", runtimePolicy: undeclared } as AgentConfig;
		const subagentSendProperties = (sendTool.getRawJsonSchema?.(subagentConfig).properties ??
			{}) as Record<string, unknown>;
		const primarySendProperties = (sendTool.getRawJsonSchema?.(primaryConfig).properties ??
			{}) as Record<string, unknown>;
		const subagentAwaitProperties = (awaitTool.getRawJsonSchema?.(subagentConfig).properties ??
			{}) as Record<string, unknown>;
		const primaryAwaitProperties = (awaitTool.getRawJsonSchema?.(primaryConfig).properties ??
			{}) as Record<string, unknown>;

		// Send never waits for a reply, under any ceiling.
		for (const properties of [subagentSendProperties, primarySendProperties]) {
			expect(properties.await).toBeUndefined();
			expect(properties.timeout).toBeUndefined();
			expect(properties.replyTo).toBeUndefined();
		}
		// The invariant is that "agent" is hidden from subagents — NOT that the list is
		// exactly one entry. Non-agent wait targets (bash, and a background device
		// transfer) are deliberately available to subagents: a subagent that starts a
		// background transfer must be able to wait for its own work.
		const subagentAwaitTypes = (subagentAwaitProperties.type as { enum?: unknown[] }).enum ?? [];
		expect(subagentAwaitTypes).not.toContain("agent");
		expect(subagentAwaitTypes).toContain("bash");
		expect(subagentAwaitTypes).toContain("transfer");
		// Own-question waits are independent of question creation: P5 enables async
		// creation, while a custom allowlist may still withhold AskUserQuestion.
		expect(subagentAwaitTypes).toContain("question");
		// Asserted as a SUPERSET plus the agent-only check, not as an exact list. The exact
		// form pinned the wait-target vocabulary itself, so adding a target that subagents
		// are also allowed failed here without any invariant being broken.
		const primaryAwaitTypes = (primaryAwaitProperties.type as { enum?: unknown[] }).enum ?? [];
		expect(primaryAwaitTypes).toContain("agent");
		for (const type of subagentAwaitTypes) {
			expect(primaryAwaitTypes).toContain(type);
		}
	});
});
