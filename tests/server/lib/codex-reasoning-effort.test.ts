import { afterEach, describe, expect, test } from "bun:test";
import {
	normalizeCodexReasoningEffort,
	resolveCodexRequestReasoningEffort,
} from "../../../server/lib/agent/openai-provider";
import { settings } from "../../../server/lib/settings";

/**
 * GPT-6 Astra rejects `none` upstream: reasoning is mandatory on every request,
 * including internal title/summary utility calls that never pass through the
 * narrator UI. NarraFork therefore remaps `none` to the lowest accepted tier
 * instead of sending it. Nothing flags a regression here — the request just
 * starts failing upstream — so the remap is pinned by these tests.
 */

const originalDefaultEffort = settings.agent.defaultReasoningEffort;

afterEach(() => {
	settings.agent.defaultReasoningEffort = originalDefaultEffort;
});

describe("normalizeCodexReasoningEffort — Astra mandatory reasoning", () => {
	test("none is remapped to low for gpt-6-astra", () => {
		expect(normalizeCodexReasoningEffort("gpt-6-astra", "none")).toBe("low");
	});

	test("the remap applies to provider-prefixed spellings too", () => {
		expect(normalizeCodexReasoningEffort("codex:gpt-6-astra", "none")).toBe("low");
	});

	test("other Codex models keep none verbatim", () => {
		expect(normalizeCodexReasoningEffort("gpt-5.5", "none")).toBe("none");
		expect(normalizeCodexReasoningEffort("gpt-5.6-sol", "none")).toBe("none");
	});

	test("Astra's real tiers pass through unclamped", () => {
		expect(normalizeCodexReasoningEffort("gpt-6-astra", "low")).toBe("low");
		expect(normalizeCodexReasoningEffort("gpt-6-astra", "max")).toBe("max");
	});
});

describe("resolveCodexRequestReasoningEffort — the value actually sent", () => {
	test("an explicit none never reaches the wire for Astra", () => {
		expect(resolveCodexRequestReasoningEffort("gpt-6-astra", "none")).toBe("low");
	});

	test("a configured default of none is remapped for Astra", () => {
		settings.agent.defaultReasoningEffort = "none";
		expect(resolveCodexRequestReasoningEffort("gpt-6-astra")).toBe("low");
		// …while a reasoning-optional model still honours it.
		expect(resolveCodexRequestReasoningEffort("gpt-5.5")).toBe("none");
	});

	test("the built-in fallback default stays valid for Astra", () => {
		settings.agent.defaultReasoningEffort = undefined;
		expect(resolveCodexRequestReasoningEffort("gpt-6-astra")).toBe("max");
	});
});
