import { describe, expect, test } from "bun:test";
import { hasCredentialBoundReasoning } from "../reasoning-credentials";

describe("hasCredentialBoundReasoning", () => {
	test("Claude families are strict at every version", () => {
		for (const model of [
			"claude-sonnet-5",
			"claude-sonnet-4-20250514",
			"claude-opus-4.8",
			"claude-haiku-5",
			"claude-fable-5",
			"claude-mythos-5",
			"claude-mythos-preview",
			// Old generations never emit thinking blocks, but they are still
			// Anthropic upstreams — the strict path is a safe no-op there.
			"claude-3-5-haiku-20241022",
			"claude-3-7-sonnet-20250219",
		]) {
			expect(hasCredentialBoundReasoning(model)).toBe(true);
		}
	});

	test("OpenAI official ids are strict", () => {
		for (const model of [
			"gpt-5.6-sol",
			"gpt-5.3-codex",
			"gpt-4o",
			"chatgpt-4o-latest",
			"o1",
			"o3",
			"o3-mini",
			"o4-mini",
		]) {
			expect(hasCredentialBoundReasoning(model)).toBe(true);
		}
	});

	test("relay models are not strict", () => {
		for (const model of [
			"deepseek-v4-pro",
			"deepseek-chat",
			"GLM-5.1",
			"kimi-k2.6",
			"MiniMax-M3",
			"Qwen3.6-Plus",
			"mimo-v2.5-pro",
			"llama-3.3-70b",
		]) {
			expect(hasCredentialBoundReasoning(model)).toBe(false);
		}
	});

	test("a remaining NUG channel segment does not flip the classification", () => {
		expect(hasCredentialBoundReasoning("anthropic:GLM-5.1")).toBe(false);
		expect(hasCredentialBoundReasoning("responses:GLM-5.1")).toBe(false);
		expect(hasCredentialBoundReasoning("anthropic:claude-sonnet-5")).toBe(true);
		expect(hasCredentialBoundReasoning("openai:gpt-5.6-sol")).toBe(true);
	});

	test("openai-prefixed relay ids stay non-strict once the channel is peeled", () => {
		// `openai:` is a NUG channel segment, not a model id: a gateway routing
		// GLM through its openai-compatible endpoint must not become strict.
		expect(hasCredentialBoundReasoning("openai:GLM-5.1")).toBe(false);
		// But a bare OpenAI id reached through that same channel stays strict.
		expect(hasCredentialBoundReasoning("openai:o3-mini")).toBe(true);
	});

	test("o-prefixed third-party ids are not strict", () => {
		// The o-series pattern anchors on a digit right after `o`, so `opus`
		// and friends cannot trip it.
		for (const model of ["opt-125m", "olmo-2", "openai-compatible-relay"]) {
			expect(hasCredentialBoundReasoning(model)).toBe(false);
		}
	});
});
