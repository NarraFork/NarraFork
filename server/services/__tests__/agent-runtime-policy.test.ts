import { describe, expect, test } from "bun:test";
import { awaitTool, listRunningAwaits } from "@server/lib/agent/tools/await";
import { sendTool } from "@server/lib/agent/tools/send";
import type { AgentConfig, ToolContext } from "@server/lib/agent/types";
import {
	isRuntimeToolAllowed,
	type RuntimePolicyInput,
	resolveRuntimePolicy,
	runtimeAwaitTargets,
	runtimeInteractionHint,
} from "../agent-runtime/policy";
import {
	assertSubagentCanAwaitAgent,
	assertSubagentSendIsAsync,
	SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR,
	SUBAGENT_SEND_ASYNC_ONLY_ERROR,
} from "../subagent-communication-policy";
import { resolveToolFilter, runtimeToolFilter } from "../subagent-tools";

const profiles: RuntimePolicyInput[] = [
	{ variant: "primary" },
	...["general", "explore", "plan", "review", "search", "missing-custom"].map((subagentType) => ({
		variant: "subagent" as const,
		subagentType,
	})),
	{
		variant: "subagent",
		subagentType: "custom",
		customDefinition: { toolAccess: "readOnly", customTools: [] },
	},
	{
		variant: "subagent",
		subagentType: "custom",
		customDefinition: { toolAccess: "general", customTools: [] },
	},
	{
		variant: "subagent",
		subagentType: "custom",
		customDefinition: {
			toolAccess: "custom",
			customTools: [
				"Send",
				"Await",
				"AskUserQuestion",
				"Agent",
				"Task",
				"ContinueTask",
				"ForkNarrator",
				"EnterPlanMode",
				"ExitPlanMode",
				"Write",
			],
		},
	},
];

describe("shared capability projections", () => {
	for (const [index, input] of profiles.entries()) {
		test(`${index}: ${input.variant}/${input.subagentType ?? "default"}: tools, schemas, hints and service guards agree`, () => {
			const policy = resolveRuntimePolicy(input);
			const child = input.variant === "subagent";
			const config = { parentNarratorId: child ? "parent" : undefined } as AgentConfig;
			const custom = input.customDefinition
				? {
						...input.customDefinition,
						customTools: [...input.customDefinition.customTools],
						name: "custom",
						description: "test",
						defaultModel: "",
						prompt: "test",
						location: "test",
					}
				: undefined;
			const filter = child
				? resolveToolFilter(input.subagentType ?? "general", custom)
				: runtimeToolFilter(policy);
			expect(filter?.(sendTool)).toBe(true);
			expect(filter?.(awaitTool)).toBe(true);
			for (const name of [
				"Agent",
				"Task",
				"ContinueTask",
				"ForkNarrator",
				"EnterPlanMode",
				"ExitPlanMode",
			]) {
				const tool = { ...sendTool, name };
				expect(filter?.(tool)).toBe(!child);
				expect(filter?.(tool)).toBe(isRuntimeToolAllowed(policy, name));
			}
			const sendProperties = sendTool.getRawJsonSchema?.(config).properties as Record<
				string,
				unknown
			>;
			const awaitProperties = awaitTool.getRawJsonSchema?.(config).properties as {
				type: { enum: string[] };
			};
			expect(Boolean(sendProperties.await)).toBe(policy.capabilities.sendAwait);
			expect(awaitProperties.type.enum).toEqual(runtimeAwaitTargets(policy));
			expect(awaitProperties.type.enum).toContain("question");
			const sendGuard = () => assertSubagentSendIsAsync(child, true);
			const awaitGuard = () => assertSubagentCanAwaitAgent(child);
			if (child) {
				expect(sendGuard).toThrow(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
				expect(awaitGuard).toThrow(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
				expect(policy.capabilities.askUserQuestion).toBe("async-only");
				expect(filter?.({ ...sendTool, name: "AskUserQuestion" })).toBe(true);
				expect(policy.capabilities.spawnAgent).toBe(false);
				expect(policy.capabilities.planApproval).toBe(false);
				expect(policy.capabilities.stopHooks).toBe(false);
				expect(runtimeInteractionHint(policy, "en")).toContain("async: true");
				expect(runtimeInteractionHint(policy, "zh-CN")).toContain("仅可等待自己的问题");
			} else {
				expect(sendGuard).not.toThrow();
				expect(awaitGuard).not.toThrow();
				expect(runtimeInteractionHint(policy, "en")).toBe("");
			}
		});
	}

	test("inherited readOnly narrows custom MCP and file access without widening its allowlist", () => {
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			readOnly: true,
			customDefinition: { toolAccess: "custom", customTools: ["Read", "Write", "mcp__test__read"] },
		});
		expect(policy.tools.readOnly).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Read")).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "Grep")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "mcp__test__read", "readOnly")).toBe(true);
		for (const behavior of ["readWrite", "allow", "ask", "deny", null, undefined]) {
			expect(isRuntimeToolAllowed(policy, "mcp__test__read", behavior)).toBe(false);
		}
		expect(isRuntimeToolAllowed(policy, "mcp__test__other", "readOnly")).toBe(false);
	});

	test("missing custom definition and built-in readOnly cannot be upgraded by a custom override", () => {
		for (const subagentType of ["missing", "explore", "plan", "review"]) {
			const policy = resolveRuntimePolicy({
				variant: "subagent",
				subagentType,
				customDefinition:
					subagentType === "missing" ? null : { toolAccess: "general", customTools: [] },
			});
			expect(policy.tools.readOnly).toBe(true);
			expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
			expect(isRuntimeToolAllowed(policy, "mcp__test__write", "readWrite")).toBe(false);
			expect(isRuntimeToolAllowed(policy, "mcp__test__read", "readOnly")).toBe(true);
		}
	});

	test("policy snapshots custom tool names rather than sharing mutable configuration", () => {
		const customTools = ["Read"];
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			customDefinition: { toolAccess: "custom", customTools },
		});
		customTools.push("Write");
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(Object.isFrozen(policy.capabilities)).toBe(true);
		expect(Object.isFrozen(policy.tools.builtin)).toBe(true);
	});

	test("direct tool execution rejects legacy synchronous child inputs before service work or wait registration", async () => {
		const ctx = {
			narratorId: "child",
			parentNarratorId: "parent",
			currentToolUseId: "policy-denied",
			signal: new AbortController().signal,
		} as ToolContext;
		expect(
			sendTool.parameters.safeParse({ id: "sibling", message: "hello", await: true }).success,
		).toBe(true);
		const send = await sendTool.execute({ id: "sibling", message: "hello", await: true }, ctx);
		expect(send.isError).toBe(true);
		expect(send.output).toContain(SUBAGENT_SEND_ASYNC_ONLY_ERROR);
		expect(awaitTool.parameters.safeParse({ type: "agent", id: "sibling" }).success).toBe(true);
		const result = await awaitTool.execute({ type: "agent", id: "sibling" }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain(SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR);
		expect(listRunningAwaits().some((entry) => entry.toolUseId === ctx.currentToolUseId)).toBe(
			false,
		);
	});
});
