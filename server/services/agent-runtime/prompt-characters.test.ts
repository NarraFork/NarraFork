import { describe, expect, test } from "bun:test";
import { buildEffectiveSystemPrompt } from "../narrator-prompt";
import { buildSubagentSystemPrompt } from "../subagent-tools";
import { countRuntimeSystemCharacters } from "./prompt-characters";

describe("actual runtime system prompt characters", () => {
	test("primary prompt counts generated text and excludes the distinct summary", async () => {
		const summary = "摘要😀";
		const result = await buildEffectiveSystemPrompt({
			basePrompt: "实际系统",
			cwd: "/tmp",
			locale: "en",
			contextSummary: summary,
		});
		expect(result.summaryRange).toBeDefined();
		expect(countRuntimeSystemCharacters(result.prompt, summary, result.summaryRange)).toBe(
			(result.prompt?.length ?? 0) - summary.length,
		);
	});

	test("custom subagent counts its actual generated prompt and excludes exact summary text", async () => {
		const summary = "此前工作😀";
		const custom = "实际自定义角色指令";
		const prompt = await buildSubagentSystemPrompt(
			"character-count-fixture",
			"/tmp",
			"en",
			summary,
			custom,
		);
		expect(prompt).toContain(custom);
		expect(prompt.length).toBeGreaterThan(custom.length + summary.length);
		expect(countRuntimeSystemCharacters(prompt, summary)).toBe(prompt.length - summary.length);
		expect(countRuntimeSystemCharacters("## Conversation Context\n没有那个摘要", summary)).toBe(
			"## Conversation Context\n没有那个摘要".length,
		);
	});

	test("summary without a legacy cached count is still excluded; metadata constrains matching", () => {
		const summary = "shared";
		const prompt = `base ${summary} actual ${summary} suffix`;
		expect(countRuntimeSystemCharacters(prompt, summary)).toBe(prompt.length - summary.length);
		expect(countRuntimeSystemCharacters(prompt, summary, { start: 12, end: 15 })).toBe(
			prompt.length,
		);
		expect(countRuntimeSystemCharacters(null, summary)).toBe(0);
	});
});
