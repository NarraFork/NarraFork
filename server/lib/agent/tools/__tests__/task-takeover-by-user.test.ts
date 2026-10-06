import { describe, expect, mock, spyOn, test } from "bun:test";
import * as subagent from "@server/services/narrator-subagent";
import type { AgentConfig, ToolContext } from "../../types";
import { agentTool } from "../task";

function context(): ToolContext {
	return {
		narratorId: "takeover-tool-test-parent",
		cwd: "/worktree",
		signal: new AbortController().signal,
		locale: "en",
		currentToolUseId: "takeover-tool-use",
		toolCallBinding: { toolCallId: "takeover-tool-row", attempt: 1 },
		updateExecutionLease: {
			kind: "resumable",
			setNarratorId: mock(() => {}),
			transfer: mock(() => true),
			release: mock(() => {}),
		},
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

describe("Agent takeover_by_user tool contract", () => {
	test("both parameter schemas expose an optional boolean with takeover semantics", () => {
		for (const value of [true, false]) {
			const parsed = agentTool.parameters.parse({ takeover_by_user: value });
			expect(parsed).toMatchObject({ takeover_by_user: value });
		}
		expect(agentTool.parameters.safeParse({}).success).toBe(true);
		expect(agentTool.parameters.safeParse({ takeover_by_user: "true" }).success).toBe(false);
		const schemas = [agentTool.rawJsonSchema, agentTool.getRawJsonSchema?.({} as AgentConfig)];
		for (const raw of schemas) {
			const schema = raw as {
				properties: Record<string, { type: string; description: string }>;
				required?: string[];
			};
			expect(schema.properties.takeover_by_user.type).toBe("boolean");
			expect(schema.required ?? []).not.toContain("takeover_by_user");
			expect(schema.properties.takeover_by_user.description).toContain("returns immediately");
			expect(schema.properties.takeover_by_user.description).toContain("does not notify or wake");
			expect(schema.properties.takeover_by_user.description).toContain(
				"Do not automatically Await",
			);
		}
	});

	test("explicit background flags do not disable user takeover", async () => {
		const runner = spyOn(subagent, "runSubagent").mockResolvedValue("User takeover is active.");
		try {
			for (const background of [true, false]) {
				await agentTool.execute(
					{ prompt: "Continue with user", takeover_by_user: true, run_in_background: background },
					context(),
				);
				expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({
					takeoverByUser: true,
					background,
				});
			}
		} finally {
			runner.mockRestore();
		}
	});

	for (const takeoverByUser of [true, false, undefined]) {
		test(`forwards ${String(takeoverByUser)} without requiring run_in_background`, async () => {
			const output =
				"<background_task_id>taken-over-agent</background_task_id>\nUser takeover is active.";
			const runner = spyOn(subagent, "runSubagent").mockResolvedValue(output);
			try {
				const ctx = context();
				const result = await agentTool.execute(
					{
						prompt: "Work on the initial request",
						description: "Start human collaboration",
						subagent_type: "general",
						...(takeoverByUser === undefined ? {} : { takeover_by_user: takeoverByUser }),
					},
					ctx,
				);
				expect(result.isError).toBeFalsy();
				expect(result.output).toBe(output);
				expect(runner).toHaveBeenCalledTimes(1);
				expect(runner.mock.calls[0]?.[0]).toMatchObject({
					parentNarratorId: ctx.narratorId,
					toolUseId: ctx.currentToolUseId,
					toolCallBinding: ctx.toolCallBinding,
					takeoverByUser: takeoverByUser === true,
					background: false,
				});
			} finally {
				runner.mockRestore();
			}
		});
	}
});
