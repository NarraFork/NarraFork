/** Text fallback unwraps explicit packaging without deleting prompt content. */
import { describe, expect, test } from "bun:test";
import { normalizeOptimizedPrompt } from "../prompt-optimize-output";

const ORIGINAL = "帮我写一个登录页面";

describe("leading thinking wrapper", () => {
	test("strips a complete leading thinking block", () => {
		const raw =
			"<thinking>用户想要一个登录页，我应该补充细节。</thinking>\n写一个登录页面，包含邮箱和密码字段。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面，包含邮箱和密码字段。");
	});

	test("strips a complete leading reasoning block", () => {
		const raw = "<reasoning>hmm</reasoning>写一个登录页面。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。");
	});

	test.each([
		"编写解析器，识别 <thinking>示例</thinking> 并保留后续文本。",
		"写一个登录页面。\n<thinking>此标签故意不闭合",
		"<thinking>待处理的未闭合标签",
	])("preserves thinking tags that are not a complete leading wrapper: %s", (raw) => {
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(raw);
	});

	test("a response that is only a thinking wrapper falls back to the draft", () => {
		expect(normalizeOptimizedPrompt("<thinking>nothing useful</thinking>", ORIGINAL)).toBe(
			ORIGINAL,
		);
	});
});

describe("fence wrapping", () => {
	test("unwraps a fence that encloses the whole payload", () => {
		expect(normalizeOptimizedPrompt("```text\n写一个登录页面。\n```", ORIGINAL)).toBe(
			"写一个登录页面。",
		);
	});

	test("unwraps a known preamble followed by a whole-payload fence", () => {
		const raw = "Here is the optimized prompt:\n\n```markdown\n写一个登录页面。\n```";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。");
	});

	test("does not discard text surrounding an embedded fence", () => {
		const raw = "实现安全查询，使用此示例：\n```sql\nSELECT 1\n```\n最后添加单元测试。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(raw);
	});

	test("does not extract a fence when trailing content follows it", () => {
		const body = "```markdown\n写一个登录页面。\n```\n\nLet me know!";
		expect(normalizeOptimizedPrompt(`Here is the optimized prompt:\n\n${body}`, ORIGINAL)).toBe(
			body,
		);
	});

	test("keeps separate fenced examples and the requirements between them", () => {
		const raw = "```sql\nSELECT 1\n```\n比较两个查询的性能。\n```sql\nSELECT 2\n```";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(raw);
	});

	test("keeps literal thinking tags inside a wrapped prompt", () => {
		const body = "识别 <think>示例</think>，保留 <thinking>未闭合标签。";
		expect(normalizeOptimizedPrompt(`\`\`\`text\n${body}\n\`\`\``, ORIGINAL)).toBe(body);
	});

	test("ignores an unterminated fence", () => {
		const raw = "写一个登录页面。\n```";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(raw);
	});
});

describe("explicit preamble removal", () => {
	test.each([
		"Optimized prompt:",
		"优化后的提示词：",
		"**优化后的提示词：**",
	])("drops a known label: %s", (label) => {
		expect(normalizeOptimizedPrompt(`${label}\n写一个登录页面。`, ORIGINAL)).toBe(
			"写一个登录页面。",
		);
	});

	test("keeps a new requirements heading even when the draft has no heading", () => {
		const raw = "需求：\n做一个登录页面，含表单校验。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(raw);
	});

	test("keeps a label the draft itself starts with", () => {
		const raw = "Optimized prompt:\n做一个登录页面，含表单校验。";
		expect(normalizeOptimizedPrompt(raw, "Optimized prompt:\n做个登录页")).toBe(raw);
	});

	test("keeps a colon line when nothing follows it", () => {
		expect(normalizeOptimizedPrompt("写一个登录页面：", ORIGINAL)).toBe("写一个登录页面：");
	});
});

describe("wrapping cleanup", () => {
	test("strips wrapping quotes", () => {
		expect(normalizeOptimizedPrompt('"写一个登录页面。"', ORIGINAL)).toBe("写一个登录页面。");
	});

	test.each(["", "   "])("returns the draft for a blank reply: %s", (raw) => {
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(ORIGINAL);
	});
});

describe("multi-segment drafts", () => {
	const draft =
		"<<<NF_a_0>>>\n写个登录页\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n加校验\n<<<NF_a_1_END>>>";

	test("preserves marker lines exactly", () => {
		const raw =
			"<<<NF_a_0>>>\n写一个登录页面\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n补充表单校验\n<<<NF_a_1_END>>>";
		expect(normalizeOptimizedPrompt(raw, draft)).toBe(raw);
	});

	test("keeps fences and literal thinking blocks inside segments", () => {
		const raw =
			"<<<NF_a_0>>>\n```sql\nSELECT 1\n```\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n识别 <think>示例</think>\n<<<NF_a_1_END>>>";
		expect(normalizeOptimizedPrompt(raw, draft)).toBe(raw);
	});

	test("strips a leading thinking wrapper without changing the segments", () => {
		expect(normalizeOptimizedPrompt(`<thinking>分段处理</thinking>\n${draft}`, draft)).toBe(draft);
	});
});
