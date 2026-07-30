import { describe, expect, test } from "bun:test";
import {
	declaresEffortBetaFlags,
	mapEffortParam,
	supportsAnthropic1mContext,
	supportsEffort,
	supportsThinking,
	supportsXhighEffort,
} from "../../../server/lib/agent/anthropic-provider";

describe("Anthropic effort capability detection", () => {
	test("4.6 models accept effort but not the xhigh tier", () => {
		for (const model of ["claude-opus-4-6", "claude-opus-4.6", "claude-sonnet-4.6"]) {
			expect(supportsEffort(model)).toBe(true);
			expect(supportsXhighEffort(model)).toBe(false);
		}
	});

	test("4.7 / 4.8 / 5 series and fable/mythos support effort with xhigh", () => {
		const models = [
			"claude-opus-4-7",
			"claude-opus-4.7",
			"claude-opus-4-8",
			"claude-opus-4.8",
			"claude-sonnet-4.8",
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"claude-mythos-5",
			"claude-mythos-preview",
		];
		for (const model of models) {
			expect(supportsEffort(model)).toBe(true);
			expect(supportsXhighEffort(model)).toBe(true);
		}
	});

	test("pre-4.6 Claude is the built-in exclusion", () => {
		// The one family known to hard 400 on output_config.effort. Everything
		// else is opt-out via the user blocklist, not opt-in.
		for (const model of [
			"claude-sonnet-4.5",
			"claude-opus-4-5",
			"claude-3-7-sonnet-20250219",
			"claude-3-5-sonnet-20241022",
		]) {
			expect(supportsEffort(model)).toBe(false);
		}
		expect(supportsXhighEffort("claude-sonnet-4.5")).toBe(false);
	});

	test("third-party models on an Anthropic-compatible relay accept effort", () => {
		// The regression this blacklist policy fixes: these ids can never match a
		// Claude version, so the old whitelist hid the tier menu for all of them.
		for (const model of [
			"GLM-5.1",
			"glm-4.7",
			"kimi-k2.6",
			"MiniMax-M3",
			"Qwen3.6-Plus",
			"deepseek-v4-pro",
			"mimo-v2.5-pro",
		]) {
			expect(supportsEffort(model)).toBe(true);
		}
	});

	test("effort beta flags stay narrower than the effort parameter", () => {
		// Anthropic-specific beta names: a generic relay may reject unknown flags,
		// and does not need them to honor output_config.effort.
		expect(declaresEffortBetaFlags("claude-opus-4-6")).toBe(true);
		expect(declaresEffortBetaFlags("claude-opus-5")).toBe(true);
		expect(declaresEffortBetaFlags("claude-sonnet-4.5")).toBe(false);
		expect(declaresEffortBetaFlags("GLM-5.1")).toBe(false);
		expect(declaresEffortBetaFlags("kimi-k2.6")).toBe(false);
	});

	test("future major versions are treated as at least as capable", () => {
		// Two-digit majors must still parse — the digit bound exists to reject
		// date runs, not real version numbers.
		expect(supportsEffort("claude-opus-50")).toBe(true);
		expect(supportsXhighEffort("claude-opus-50")).toBe(true);
	});

	test("family-last dated ids never parse their date as a version", () => {
		// The dangerous regression: an unbounded major segment turns
		// "claude-3-5-sonnet-20241022" into major 20241022, which would enable
		// adaptive thinking, the effort parameter and a 1M window on Claude 3.x.
		for (const model of ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]) {
			expect(supportsThinking(model)).toBe(false);
			expect(supportsEffort(model)).toBe(false);
			expect(supportsXhighEffort(model)).toBe(false);
			expect(supportsAnthropic1mContext(model)).toBe(false);
		}
	});

	test("family-first dated ids fall back to minor 0", () => {
		for (const model of ["claude-sonnet-4-20250514", "claude-opus-4-20250514"]) {
			expect(supportsEffort(model)).toBe(false);
			expect(supportsXhighEffort(model)).toBe(false);
			// Claude 4 families have always supported extended thinking.
			expect(supportsThinking(model)).toBe(true);
		}
	});

	test("thinking is recognized for the 5 series and fable/mythos", () => {
		for (const model of [
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"claude-mythos-5",
			"claude-mythos-preview",
		]) {
			expect(supportsThinking(model)).toBe(true);
		}
		// Claude 3.7 Sonnet and DeepSeek keep their existing support.
		expect(supportsThinking("claude-3-7-sonnet-20250219")).toBe(true);
		expect(supportsThinking("deepseek-v4-pro")).toBe(true);
		// Claude 3.5 has no extended thinking.
		expect(supportsThinking("claude-3-5-haiku-20241022")).toBe(false);
	});
});

describe("mapEffortParam", () => {
	test("passes every tier through on models with xhigh", () => {
		expect(mapEffortParam("claude-opus-4.8", "low")).toBe("low");
		expect(mapEffortParam("claude-opus-4.8", "medium")).toBe("medium");
		expect(mapEffortParam("claude-opus-4.8", "high")).toBe("high");
		expect(mapEffortParam("claude-opus-4.8", "xhigh")).toBe("xhigh");
		expect(mapEffortParam("claude-opus-4.8", "max")).toBe("max");
		expect(mapEffortParam("claude-sonnet-5", "xhigh")).toBe("xhigh");
	});

	test("clamps xhigh to max on 4.6, which has no xhigh tier", () => {
		expect(mapEffortParam("claude-opus-4-6", "xhigh")).toBe("max");
		expect(mapEffortParam("claude-sonnet-4.6", "xhigh")).toBe("max");
		expect(mapEffortParam("claude-opus-4-6", "high")).toBe("high");
		expect(mapEffortParam("claude-opus-4-6", "max")).toBe("max");
	});

	test("returns undefined when thinking is disabled or unset", () => {
		expect(mapEffortParam("claude-opus-4.8", "none")).toBeUndefined();
		expect(mapEffortParam("claude-opus-4.8", undefined)).toBeUndefined();
		expect(mapEffortParam("claude-opus-4.8", "")).toBeUndefined();
	});

	test("keeps the full ladder for non-Claude models", () => {
		// We have no tier table for a third-party model, so xhigh must pass
		// through rather than being rewritten to max on a guess.
		expect(mapEffortParam("GLM-5.1", "xhigh")).toBe("xhigh");
		expect(mapEffortParam("kimi-k2.6", "max")).toBe("max");
		expect(mapEffortParam("MiniMax-M3", "low")).toBe("low");
	});
});

describe("supportsAnthropic1mContext", () => {
	test("covers 4.6+, the 5 series and fable/mythos", () => {
		for (const model of [
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"claude-mythos-5",
			"claude-mythos-preview",
		]) {
			expect(supportsAnthropic1mContext(model)).toBe(true);
		}
	});

	test("keeps the whole Sonnet 4 family on 1M", () => {
		// The official request path sends context-1m-2025-08-07, which exists for
		// Sonnet 4's 1M window. Narrowing this would drop them back to 200k.
		expect(supportsAnthropic1mContext("claude-sonnet-4-20250514")).toBe(true);
		expect(supportsAnthropic1mContext("claude-sonnet-4-5")).toBe(true);
		expect(supportsAnthropic1mContext("claude-sonnet-4.5")).toBe(true);
	});

	test("leaves Opus 4 / 4.5 and Claude 3.x off the 1M list", () => {
		expect(supportsAnthropic1mContext("claude-opus-4-20250514")).toBe(false);
		expect(supportsAnthropic1mContext("claude-opus-4-5")).toBe(false);
		expect(supportsAnthropic1mContext("claude-3-opus-20240229")).toBe(false);
	});

	test("accepts provider-prefixed model ids", () => {
		expect(supportsAnthropic1mContext("anthropic:claude-opus-4-8")).toBe(true);
		expect(supportsAnthropic1mContext("anthropic:claude-3-opus-20240229")).toBe(false);
	});
});
