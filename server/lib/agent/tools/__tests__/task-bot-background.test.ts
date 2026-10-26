import { describe, expect, mock, spyOn, test } from "bun:test";
import * as subagent from "@server/services/narrator-subagent";
import type { ToolContext } from "../../types";
import { agentTool } from "../task";

function context(bot: boolean): ToolContext {
	return {
		narratorId: "bot-background-test-parent",
		cwd: "/worktree",
		signal: new AbortController().signal,
		locale: "en",
		currentToolUseId: "bot-background-tool-use",
		toolCallBinding: { toolCallId: "bot-background-tool-row", attempt: 1 },
		updateExecutionLease: {
			kind: "resumable",
			setNarratorId: mock(() => {}),
			transfer: mock(() => true),
			release: mock(() => {}),
		},
		requestPermission: async () => ({ behavior: "allow" }),
		bot,
	};
}

describe("Agent from a bot", () => {
	test("always runs in the background, whatever the call asks for", async () => {
		const runner = spyOn(subagent, "runSubagent").mockResolvedValue("started");
		try {
			for (const run_in_background of [false, true, undefined]) {
				await agentTool.execute(
					{
						prompt: "Investigate",
						...(run_in_background === undefined ? {} : { run_in_background }),
					},
					context(true),
				);
				expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({ background: true });
			}
		} finally {
			runner.mockRestore();
		}
	});

	test("an ordinary narrator keeps the foreground default", async () => {
		const runner = spyOn(subagent, "runSubagent").mockResolvedValue("done");
		try {
			await agentTool.execute({ prompt: "Investigate" }, context(false));
			expect(runner.mock.calls.at(-1)?.[0]).toMatchObject({ background: false });
		} finally {
			runner.mockRestore();
		}
	});
});
