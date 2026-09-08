import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { settings } from "../../../settings";
import type { AgentConfig, ToolContext, ToolUpdateExecutionLease } from "../../types";

const runCalls: Array<Record<string, unknown>> = [];
let agentTool: typeof import("../task").agentTool;
let realNarratorSubagent: typeof import("@server/services/narrator-subagent");

beforeAll(async () => {
	realNarratorSubagent = await import("@server/services/narrator-subagent");
	mock.module("@server/services/narrator-subagent", () => ({
		...realNarratorSubagent,
		runSubagent: mock(async (input: Record<string, unknown>) => {
			runCalls.push(input);
			// The runner already writes the alias into the tag and registers it.
			return "<subagent_id>inspect-lease</subagent_id>\n\ndone";
		}),
	}));
	({ agentTool } = await import("../task"));
});

afterAll(() => {
	mock.module("@server/services/narrator-subagent", () => realNarratorSubagent);
	mock.restore();
});

describe("Agent task tool", () => {
	test("schema advertises fixed global tiers but never invents one for unconfigured models", () => {
		settings.agent.subagentAllowedModels = {
			explore: ["p:legacy"],
			plan: [],
			general: [],
			review: ["p:review"],
			search: ["p:search"],
		};
		settings.agent.subagentModelReasoningEfforts = {
			review: { "p:review": "high" },
			search: { "p:search": "none" },
			explore: { "p:not-in-pool": "max" },
		};
		const schema = agentTool.rawJsonSchema as {
			properties: Record<string, { description: string }>;
		};
		expect(schema.properties.model.description).toContain("p:review [fixed reasoning_effort=high]");
		expect(schema.properties.model.description).toContain("p:search [fixed reasoning_effort=none]");
		expect(schema.properties.model.description).not.toContain("p:legacy [fixed");
		expect(schema.properties.model.description).not.toContain("p:not-in-pool");
		expect(schema.properties.reasoning_effort.description).toContain("overrides this parameter");
		expect(agentTool.parameters.safeParse({ reasoning_effort: "none" }).success).toBe(true);
		expect(agentTool.parameters.safeParse({ reasoning_effort: "invalid" }).success).toBe(false);
	});

	test("custom effective pool description takes precedence over global metadata", () => {
		settings.agent.subagentAllowedModels = { explore: ["p:global"], plan: [], general: [] };
		settings.agent.subagentModelReasoningEfforts = { explore: { "p:global": "high" } };
		const custom = "explore: p:custom [fixed reasoning_effort=medium]";
		const schema = agentTool.getRawJsonSchema?.({
			subagentModelRestrictionDescription: custom,
		} as AgentConfig) as { properties: Record<string, { description: string }> };
		expect(schema.properties.model.description).toContain(custom);
		expect(schema.properties.model.description).not.toContain("p:global");
	});

	test("passes the executeTool lease into the subagent runner for transfer", async () => {
		const updateExecutionLease: ToolUpdateExecutionLease = {
			kind: "resumable",
			setNarratorId: mock(() => {}),
			transfer: mock(() => true),
			release: mock(() => {}),
		};
		const ctx: ToolContext = {
			narratorId: "parent-narrator",
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			currentToolUseId: "agent-tool-use",
			toolCallBinding: { toolCallId: "agent-row-1", attempt: 1 },
			updateExecutionLease,
			requestPermission: async () => ({ behavior: "allow" }),
		};

		const result = await agentTool.execute(
			{
				prompt: "inspect the lease path",
				description: "inspect lease",
				subagent_type: "general",
			},
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(runCalls).toHaveLength(1);
		expect(runCalls[0]).toMatchObject({
			parentNarratorId: "parent-narrator",
			toolUseId: "agent-tool-use",
			toolCallBinding: ctx.toolCallBinding,
			updateExecutionLease,
		});
		expect(updateExecutionLease.transfer).not.toHaveBeenCalled();
	});

	// The subagent acts for whoever triggered this parent turn. Dropping the id
	// made the child anonymous, so "inherit" preferences (fast mode) fell back to
	// the disabled default no matter what the user had configured.
	test("forwards the triggering user so inherited preferences resolve", async () => {
		runCalls.length = 0;
		const ctx: ToolContext = {
			narratorId: "parent-narrator",
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			currentToolUseId: "agent-tool-use-2",
			toolCallBinding: { toolCallId: "agent-row-2", attempt: 1 },
			userId: "user-42",
			updateExecutionLease: {
				kind: "resumable",
				setNarratorId: mock(() => {}),
				transfer: mock(() => true),
				release: mock(() => {}),
			},
			requestPermission: async () => ({ behavior: "allow" }),
		};

		await agentTool.execute({ prompt: "check preference plumbing", subagent_type: "general" }, ctx);

		expect(runCalls[0]).toMatchObject({ userId: "user-42" });
	});

	// The tool used to re-write the runner's `<subagent_id>` tag to swap in an
	// alias. The runner now emits the alias itself, so a second rewrite here would
	// only be able to corrupt it — the output must pass through verbatim.
	test("passes the runner's aliased result tag through unchanged", async () => {
		const ctx: ToolContext = {
			narratorId: "parent-narrator",
			cwd: "/worktree",
			signal: new AbortController().signal,
			locale: "en",
			currentToolUseId: "agent-tool-use-3",
			toolCallBinding: { toolCallId: "agent-row-3", attempt: 1 },
			updateExecutionLease: {
				kind: "resumable",
				setNarratorId: mock(() => {}),
				transfer: mock(() => true),
				release: mock(() => {}),
			},
			requestPermission: async () => ({ behavior: "allow" }),
		};

		const result = await agentTool.execute(
			{ prompt: "check the tag", description: "inspect lease", subagent_type: "general" },
			ctx,
		);

		expect(result.output).toBe("<subagent_id>inspect-lease</subagent_id>\n\ndone");
	});
});
