import { describe, expect, it } from "bun:test";
import { getCategory, getCategoryColor, getSummary } from "./tool-display";

describe("ContextAsk classification", () => {
	it("is its own category, not generic", () => {
		// Generic is what made the folded row read `ContextAsk · ContextAsk`.
		expect(getCategory("ContextAsk")).toBe("contextAsk");
		expect(getCategoryColor("contextAsk")).not.toBe("gray");
	});

	it("shares indigo with await/taskOutput (auxiliary session reads)", () => {
		expect(getCategoryColor("contextAsk")).toBe(getCategoryColor("await"));
		expect(getCategoryColor("contextAsk")).not.toBe(getCategoryColor("send"));
	});
});

describe("ContextAsk header summary", () => {
	const input = {
		id: "follow-model-runtime",
		questions: ["是否已收到主agent授权？", "当前阻塞是什么？", "实施到哪一步？"],
	};

	it("names the target and the question count", () => {
		expect(getSummary("ContextAsk", input)).toBe("follow-model-runtime · 3 questions");
	});

	it("never repeats the tool name", () => {
		const text = getSummary("ContextAsk", input);
		expect(text).not.toContain("ContextAsk");
	});

	it("prefers the resolved target title over the raw selector", () => {
		const metadata = { target: { id: "UscgG1vLFnxzyKyaUOIfR", title: "model-runtime" } };
		expect(getSummary("ContextAsk", { id: "UscgG1vLFnxzyKyaUOIfR" }, metadata)).toBe(
			"model-runtime · status summary",
		);
	});

	it("shortens a bare nanoid selector", () => {
		const text = getSummary("ContextAsk", { id: "UscgG1vLFnxzyKyaUOIfR" });
		expect(text.startsWith("UscgG1vL")).toBe(true);
		expect(text).not.toContain("UscgG1vLFnxzyKyaUOIfR");
	});

	it("shows the live char counter while streaming instead of the question tally", () => {
		const metadata = { _streamingOutput: "1240" };
		expect(getSummary("ContextAsk", input, metadata)).toBe("follow-model-runtime · 1240 chars");
		expect(
			getSummary("ContextAsk", input, metadata, {
				contextAskOutputChars: "{count} 字符",
			}),
		).toBe("follow-model-runtime · 1240 字符");
	});

	it("ignores non-numeric streaming output", () => {
		const metadata = { _streamingOutput: "thinking…" };
		expect(getSummary("ContextAsk", input, metadata)).toBe("follow-model-runtime · 3 questions");
	});

	it("localizes the question-count and status-summary fragments", () => {
		expect(
			getSummary("ContextAsk", input, undefined, {
				contextAskQuestions: "{count} 个问题",
			}),
		).toBe("follow-model-runtime · 3 个问题");
		expect(
			getSummary("ContextAsk", { id: "a" }, undefined, {
				contextAskStatusSummary: "状态摘要",
			}),
		).toBe("a · 状态摘要");
	});
});
