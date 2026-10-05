import { describe, expect, test } from "bun:test";
import { getPrompt } from "../core";

describe("reflection prompt decision contract", () => {
	for (const key of ["dangerReflection", "exitPlanReflection"] as const) {
		test(`${key} allows one bounded correction and isolates main-assistant feedback`, () => {
			const en = getPrompt(key, "en");
			expect(en).toContain("at most two decision rounds");
			expect(en).toContain("at most one decision tool from the current allowlist");
			expect(en).toContain("internal tool result");
			expect(en).toContain("ends reflection immediately");
			expect(en).toContain("fail closed");
			expect(en).toContain("directly Edit files");
			expect(en).toContain("never instruct the main assistant to call reflection-only");
			expect(en).toContain("one-response permission-rule request");
			expect(en).not.toContain("exactly one response");

			const zh = getPrompt(key, "zh-CN");
			expect(zh).toContain("最多有两轮决策机会");
			expect(zh).toContain("每轮最多调用一个当前 allowlist 中的决策工具");
			expect(zh).toContain("内部 tool result");
			expect(zh).toContain("成功后立即结束反思");
			expect(zh).toContain("fail closed");
			expect(zh).toContain("直接 Edit 文件");
			expect(zh).toContain("不能要求主助手调用反思专用决策工具");
			expect(zh).toContain("严格限制优先");
			expect(zh).not.toContain("你只有一次回复机会");
		});
	}

	test("danger reflection retains both compatible text fallback decisions", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const prompt = getPrompt("dangerReflection", locale);
			expect(prompt).toContain(
				'<DangerDecision>{"action":"confirm","reflection":"..."}</DangerDecision>',
			);
			expect(prompt).toContain(
				'<DangerDecision>{"action":"cancel","reason":"..."}</DangerDecision>',
			);
		}
	});
});
