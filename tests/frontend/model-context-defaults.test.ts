import { describe, expect, test } from "bun:test";
import { getModelDefaultContextWindow } from "../../frontend/components/providers/model-context-defaults";

describe("getModelDefaultContextWindow — Claude families", () => {
	test("4.6+ / 5 series get 1M", () => {
		for (const model of [
			"claude-sonnet-4.6",
			"claude-opus-4-6",
			"claude-opus-4.7",
			"claude-opus-4-8",
			"claude-sonnet-4.8",
			"claude-opus-5",
			"claude-sonnet-5",
		]) {
			expect(getModelDefaultContextWindow(model)).toBe(1_000_000);
		}
	});

	test("fable / mythos families get 1M", () => {
		expect(getModelDefaultContextWindow("claude-fable-5")).toBe(1_000_000);
		expect(getModelDefaultContextWindow("claude-mythos-5")).toBe(1_000_000);
		expect(getModelDefaultContextWindow("claude-mythos-preview")).toBe(1_000_000);
	});

	test("dated legacy ids are not misread as new versions", () => {
		// "claude-3-5-sonnet-20241022" previously parsed major 20241022 and was
		// auto-filled as 1M.
		expect(getModelDefaultContextWindow("claude-3-5-sonnet-20241022")).toBeNull();
		expect(getModelDefaultContextWindow("claude-3-opus-20240229")).toBeNull();
		expect(getModelDefaultContextWindow("claude-sonnet-4-20250514")).toBeNull();
	});

	test("pre-4.6 Claude models stay unset", () => {
		expect(getModelDefaultContextWindow("claude-sonnet-4.5")).toBeNull();
		expect(getModelDefaultContextWindow("claude-opus-4-5")).toBeNull();
	});

	test("provider-prefixed values resolve to the bare model", () => {
		expect(getModelDefaultContextWindow("anthropic:claude-opus-4-8")).toBe(1_000_000);
		expect(getModelDefaultContextWindow("anthropic:claude-3-5-sonnet-20241022")).toBeNull();
	});

	test("non-Claude heuristics are unchanged", () => {
		expect(getModelDefaultContextWindow("mimo-v2.5-pro")).toBe(1_048_576);
		expect(getModelDefaultContextWindow("deepseek-v4-pro")).toBe(1_000_000);
		expect(getModelDefaultContextWindow("gpt-5.4-mini")).toBe(272_000);
		expect(getModelDefaultContextWindow("gpt-4o")).toBeNull();
	});
});
