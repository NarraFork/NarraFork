import { describe, expect, it } from "bun:test";
import { projectTreeForLite } from "../tool-io-projection";

// biome-ignore lint/suspicious/noExplicitAny: test builds provider-shaped JSON trees
function msg(overrides: Record<string, unknown>): any {
	return {
		id: "m1",
		role: "assistant",
		contentJson: [],
		toolCalls: [],
		children: [],
		...overrides,
	};
}

describe("projectTreeForLite (low-LOD field projection)", () => {
	it("drops a Bash tool body but keeps header hints (command + description)", () => {
		const command = "x".repeat(5000);
		const [projected] = projectTreeForLite([
			msg({
				contentJson: [
					{
						type: "tool_use",
						id: "t1",
						name: "Bash",
						inputJson: { command, description: "build the project" },
						outputJson: { _text: "y".repeat(9000) },
					},
				],
				toolCalls: [
					{
						toolUseId: "t1",
						toolName: "Bash",
						inputJson: { command, description: "build the project" },
						outputJson: { _text: "y".repeat(9000) },
					},
				],
			}),
		]);

		const block = projected.contentJson[0];
		expect(block.inputJson._truncated).toBe(true);
		// Header hints survive so the collapsed card still shows the summary.
		expect(block.inputJson._hints.command).toContain("x");
		expect(block.inputJson._hints.description).toBe("build the project");
		// Body chars are not shipped.
		expect(block.inputJson.preview).toBe("");
		expect(block.outputJson._truncated).toBe(true);

		const tc = projected.toolCalls[0];
		expect(tc.inputJson._truncated).toBe(true);
		expect(tc.inputJson._hints.command).toContain("x");
		expect(tc.outputJson._truncated).toBe(true);
	});

	it("keeps grep/glob header fields for the search card", () => {
		const [projected] = projectTreeForLite([
			msg({
				contentJson: [
					{
						type: "tool_use",
						id: "g1",
						name: "Grep",
						inputJson: {
							pattern: "needle",
							path: "/repo/src",
							glob: "*.ts",
							body: "z".repeat(4000),
						},
					},
				],
				toolCalls: [],
			}),
		]);
		const block = projected.contentJson[0];
		expect(block.inputJson._truncated).toBe(true);
		expect(block.inputJson._hints.pattern).toBe("needle");
		expect(block.inputJson._hints.path).toBe("/repo/src");
		expect(block.inputJson._hints.glob).toBe("*.ts");
	});

	it("keeps a Read file_path hint", () => {
		const [projected] = projectTreeForLite([
			msg({
				contentJson: [
					{
						type: "tool_use",
						id: "r1",
						name: "Read",
						inputJson: { file_path: "/repo/src/index.ts", offset: 10, limit: 40 },
					},
				],
			}),
		]);
		const hints = projected.contentJson[0].inputJson._hints;
		expect(hints.file_path).toBe("/repo/src/index.ts");
		expect(hints.offset).toBe(10);
		expect(hints.limit).toBe(40);
	});

	it("preserves inline-detail tools (ExitPlanMode, AskUserQuestion, Agent) intact", () => {
		const plan = "p".repeat(6000);
		const [projected] = projectTreeForLite([
			msg({
				contentJson: [
					{ type: "tool_use", id: "e1", name: "ExitPlanMode", inputJson: { plan } },
					{
						type: "tool_use",
						id: "q1",
						name: "AskUserQuestion",
						inputJson: {
							questions: [{ header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
						},
					},
					{
						type: "tool_use",
						id: "a1",
						name: "Agent",
						inputJson: { subagent_type: "explore", prompt: "long".repeat(2000) },
					},
				],
			}),
		]);
		const [plan1, ask1, agent1] = projected.contentJson;
		expect(plan1.inputJson.plan).toBe(plan);
		expect(ask1.inputJson.questions[0].options).toHaveLength(2);
		expect(agent1.inputJson.prompt.length).toBeGreaterThan(1000);
	});

	it("preserves spec://tasks.json Write input (Todo card renders inline)", () => {
		const tasksJson = JSON.stringify({ tasks: [{ text: "do", status: "doing" }] });
		const [projected] = projectTreeForLite([
			msg({
				contentJson: [
					{
						type: "tool_use",
						id: "w1",
						name: "Write",
						inputJson: { file_path: "spec://tasks.json", content: tasksJson },
					},
				],
			}),
		]);
		expect(projected.contentJson[0].inputJson.content).toBe(tasksJson);
	});

	it("never touches reasoning blocks or assistant text", () => {
		const reasoning = "thought ".repeat(3000);
		const text = "answer ".repeat(3000);
		const [projected] = projectTreeForLite([
			msg({
				contentJson: [
					{ type: "reasoning", id: "re1", text: reasoning },
					{ type: "text", text },
				],
			}),
		]);
		expect(projected.contentJson[0].text).toBe(reasoning);
		expect(projected.contentJson[1].text).toBe(text);
	});

	it("recurses into inline (non-subagent) children", () => {
		const [projected] = projectTreeForLite([
			msg({
				id: "parent",
				contentJson: [{ type: "tool_use", id: "p1", name: "Read", inputJson: { file_path: "/a" } }],
				children: [
					msg({
						id: "child",
						contentJson: [
							{
								type: "tool_use",
								id: "c1",
								name: "Bash",
								inputJson: { command: "q".repeat(5000) },
							},
						],
					}),
				],
			}),
		]);
		expect(projected.children[0].contentJson[0].inputJson._truncated).toBe(true);
	});
});
