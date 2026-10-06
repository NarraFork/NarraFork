import { describe, expect, test } from "bun:test";
import { awaitTool } from "../../lib/agent/tools/await";
import { sendTool } from "../../lib/agent/tools/send";
import type { AgentConfig } from "../../lib/agent/types";
import {
	assertSubagentCanAwaitAgent,
	assertSubagentSendIsAsync,
	SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
	SUBAGENT_SEND_ASYNC_ONLY_ERROR,
} from "../subagent-communication-policy";

describe("subagent communication policy", () => {
	test("rejects await=true for every Send issued by a subagent", () => {
		expect(() => assertSubagentSendIsAsync(true, true)).toThrow(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
	});

	test("allows asynchronous Send from a subagent", () => {
		expect(() => assertSubagentSendIsAsync(true, false)).not.toThrow();
		expect(() => assertSubagentSendIsAsync(true, undefined)).not.toThrow();
	});

	test("does not change primary narrator Send behavior", () => {
		expect(() => assertSubagentSendIsAsync(false, true)).not.toThrow();
	});

	test("rejects agent Await from subagents", () => {
		expect(() => assertSubagentCanAwaitAgent(true)).toThrow(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
	});

	test("keeps agent Await available to primary narrators", () => {
		expect(() => assertSubagentCanAwaitAgent(false)).not.toThrow();
	});

	test("hides synchronous agent options from subagent model schemas", () => {
		const subagentConfig = { parentNarratorId: "parent" } as AgentConfig;
		const primaryConfig = {} as AgentConfig;
		const subagentSendProperties = (sendTool.getRawJsonSchema?.(subagentConfig).properties ??
			{}) as Record<string, unknown>;
		const primarySendProperties = (sendTool.getRawJsonSchema?.(primaryConfig).properties ??
			{}) as Record<string, unknown>;
		const subagentAwaitProperties = (awaitTool.getRawJsonSchema?.(subagentConfig).properties ??
			{}) as Record<string, unknown>;
		const primaryAwaitProperties = (awaitTool.getRawJsonSchema?.(primaryConfig).properties ??
			{}) as Record<string, unknown>;

		expect(subagentSendProperties.await).toBeUndefined();
		expect(subagentSendProperties.timeout).toBeUndefined();
		expect(primarySendProperties.await).toBeDefined();
		expect(primarySendProperties.timeout).toBeDefined();
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
