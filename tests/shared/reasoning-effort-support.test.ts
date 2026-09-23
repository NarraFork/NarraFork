import { describe, expect, test } from "bun:test";
import {
	bareModelForEffort,
	claudeVersionAtLeast,
	GENERIC_REASONING_EFFORT_TIERS,
	isPreEffortClaudeModel,
	mapGenericReasoningEffort,
	matchesReasoningEffortBlocklist,
	modelAcceptsReasoningEffort,
	parseClaudeModel,
} from "../../shared/reasoning-effort-support";

describe("parseClaudeModel", () => {
	test("parses the modern family-first shape", () => {
		expect(parseClaudeModel("claude-sonnet-4.6")).toEqual({
			family: "sonnet",
			major: 4,
			minor: 6,
		});
		expect(parseClaudeModel("claude-opus-4-8")).toEqual({ family: "opus", major: 4, minor: 8 });
		expect(parseClaudeModel("claude-opus-5")).toEqual({ family: "opus", major: 5, minor: 0 });
	});

	test("parses the legacy family-last shape", () => {
		// Needed under the blacklist policy: an unparsed Claude 3.x id would be
		// treated as an unknown model and wrongly receive the effort parameter.
		expect(parseClaudeModel("claude-3-5-sonnet-20241022")).toEqual({
			family: "sonnet",
			major: 3,
			minor: 5,
		});
		expect(parseClaudeModel("claude-3-opus-20240229")).toEqual({
			family: "opus",
			major: 3,
			minor: 0,
		});
		expect(parseClaudeModel("claude-3-7-sonnet-20250219")).toEqual({
			family: "sonnet",
			major: 3,
			minor: 7,
		});
	});

	test("never reads a date suffix as a version", () => {
		expect(parseClaudeModel("claude-sonnet-4-20250514")).toEqual({
			family: "sonnet",
			major: 4,
			minor: 0,
		});
		// The dangerous case: major 20241022 would make Claude 3.5 look newest.
		expect(parseClaudeModel("claude-3-5-sonnet-20241022")?.major).toBe(3);
	});

	test("treats mythos preview as a 5-series model", () => {
		expect(parseClaudeModel("claude-mythos-preview")).toEqual({
			family: "mythos",
			major: 5,
			minor: 0,
		});
	});

	test("returns null for third-party ids", () => {
		for (const model of ["GLM-5.1", "kimi-k2.6", "MiniMax-M3", "gpt-5.5", "deepseek-v4-pro"]) {
			expect(parseClaudeModel(model)).toBeNull();
		}
	});

	test("does not read a bare version as a legacy Claude id", () => {
		// The legacy pattern is anchored on the literal "claude" so a third-party
		// id containing a family word cannot trip it.
		expect(parseClaudeModel("my-3-5-sonnet-clone")).toBeNull();
	});
});

describe("claudeVersionAtLeast", () => {
	test("compares major then minor", () => {
		const v = { family: "opus" as const, major: 4, minor: 6 };
		expect(claudeVersionAtLeast(v, 4, 6)).toBe(true);
		expect(claudeVersionAtLeast(v, 4, 7)).toBe(false);
		expect(claudeVersionAtLeast(v, 3, 9)).toBe(true);
	});
});

describe("isPreEffortClaudeModel", () => {
	test("excludes Sonnet/Opus below 4.6", () => {
		for (const model of [
			"claude-sonnet-4.5",
			"claude-opus-4-5",
			"claude-sonnet-4-20250514",
			"claude-3-7-sonnet-20250219",
			"claude-3-5-sonnet-20241022",
			"claude-3-opus-20240229",
		]) {
			expect(isPreEffortClaudeModel(model)).toBe(true);
		}
	});

	test("allows Sonnet/Opus 4.6 and up", () => {
		for (const model of ["claude-sonnet-4.6", "claude-opus-4-6", "claude-opus-5"]) {
			expect(isPreEffortClaudeModel(model)).toBe(false);
		}
	});

	test("allows Haiku 4+ but not Haiku 3.x", () => {
		// Haiku was never in Anthropic's effort docs, but an omission is not a
		// documented rejection — only the pre-thinking 3.x generation is excluded.
		expect(isPreEffortClaudeModel("claude-haiku-4.5")).toBe(false);
		expect(isPreEffortClaudeModel("claude-haiku-4-6")).toBe(false);
		expect(isPreEffortClaudeModel("claude-3-5-haiku-20241022")).toBe(true);
	});

	test("never excludes fable/mythos or third-party models", () => {
		for (const model of ["claude-fable-5", "claude-mythos-preview", "GLM-5.1", "kimi-k2.6"]) {
			expect(isPreEffortClaudeModel(model)).toBe(false);
		}
	});
});

describe("matchesReasoningEffortBlocklist", () => {
	test("matches a plain pattern as a case-insensitive substring", () => {
		expect(matchesReasoningEffortBlocklist("GLM-5.1", [{ pattern: "glm" }])).toBe(true);
		expect(matchesReasoningEffortBlocklist("glm-5.1", [{ pattern: "GLM" }])).toBe(true);
		expect(matchesReasoningEffortBlocklist("kimi-k2.6", [{ pattern: "glm" }])).toBe(false);
	});

	test("skips disabled entries and blank patterns", () => {
		expect(matchesReasoningEffortBlocklist("GLM-5.1", [{ pattern: "glm", enabled: false }])).toBe(
			false,
		);
		expect(matchesReasoningEffortBlocklist("GLM-5.1", [{ pattern: "   " }])).toBe(false);
	});

	test("compiles a slash-wrapped pattern as a regex", () => {
		expect(matchesReasoningEffortBlocklist("kimi-k2.6", [{ pattern: "/^kimi-/" }])).toBe(true);
		expect(matchesReasoningEffortBlocklist("my-kimi-fork", [{ pattern: "/^kimi-/" }])).toBe(false);
	});

	test("an invalid regex never matches instead of throwing", () => {
		// This runs inside a request path, so a bad user pattern must not throw.
		expect(() => matchesReasoningEffortBlocklist("GLM-5.1", [{ pattern: "/[/" }])).not.toThrow();
		expect(matchesReasoningEffortBlocklist("GLM-5.1", [{ pattern: "/[/" }])).toBe(false);
	});

	test("handles an empty or missing list", () => {
		expect(matchesReasoningEffortBlocklist("GLM-5.1", [])).toBe(false);
		expect(matchesReasoningEffortBlocklist("GLM-5.1", undefined)).toBe(false);
		expect(matchesReasoningEffortBlocklist("", [{ pattern: "glm" }])).toBe(false);
	});
});

describe("bareModelForEffort", () => {
	test("strips a routing channel segment", () => {
		// The backend peels only ONE prefix off `nug:anthropic:GLM-5.1`, leaving the
		// channel attached, while the frontend reads `GLM-5.1` from the catalog.
		expect(bareModelForEffort("anthropic:GLM-5.1")).toBe("GLM-5.1");
		expect(bareModelForEffort("anthropic:claude-opus-5")).toBe("claude-opus-5");
		expect(bareModelForEffort("codex:gpt-5.5")).toBe("gpt-5.5");
		expect(bareModelForEffort("responses:GLM-5.1")).toBe("GLM-5.1");
		expect(bareModelForEffort("openai:GLM-5.1")).toBe("GLM-5.1");
	});

	test("is idempotent on an already-bare id", () => {
		expect(bareModelForEffort("GLM-5.1")).toBe("GLM-5.1");
		expect(bareModelForEffort("claude-opus-4-6")).toBe("claude-opus-4-6");
	});

	test("leaves an unknown colon segment alone", () => {
		// Only the known channel names are stripped, so a third-party id that
		// happens to contain a colon keeps its shape.
		expect(bareModelForEffort("vendor:some-model")).toBe("vendor:some-model");
	});
});

describe("modelAcceptsReasoningEffort", () => {
	test("accepts third-party models by default", () => {
		// The regression this policy fixes: these were hidden by the old whitelist.
		for (const model of ["GLM-5.1", "kimi-k2.6", "MiniMax-M3", "Qwen3.6-Plus", "mimo-v2.5-pro"]) {
			expect(modelAcceptsReasoningEffort(model)).toBe(true);
		}
	});

	test("respects the built-in pre-effort Claude rule", () => {
		expect(modelAcceptsReasoningEffort("claude-sonnet-4.5")).toBe(false);
		expect(modelAcceptsReasoningEffort("claude-opus-4-6")).toBe(true);
	});

	test("respects the user blocklist", () => {
		expect(modelAcceptsReasoningEffort("GLM-5.1", [{ pattern: "glm" }])).toBe(false);
		expect(modelAcceptsReasoningEffort("kimi-k2.6", [{ pattern: "glm" }])).toBe(true);
	});

	test("matches a blocklist entry through a routing channel prefix", () => {
		// The gateway bug: an anchored pattern hid the tier menu (frontend sees the
		// bare id) while the request path still sent the parameter, so the only
		// user-facing escape hatch did nothing.
		expect(modelAcceptsReasoningEffort("anthropic:GLM-5.1", [{ pattern: "/^glm/" }])).toBe(false);
		expect(modelAcceptsReasoningEffort("GLM-5.1", [{ pattern: "/^glm/" }])).toBe(false);
		expect(modelAcceptsReasoningEffort("responses:kimi-k2.6", [{ pattern: "/^kimi-/" }])).toBe(
			false,
		);
	});

	test("applies the built-in Claude rule through a channel prefix too", () => {
		// A pre-4.6 Claude routed through a channel must stay excluded, or the
		// official API 400s on output_config.effort.
		expect(modelAcceptsReasoningEffort("anthropic:claude-sonnet-4.5")).toBe(false);
		expect(modelAcceptsReasoningEffort("anthropic:claude-sonnet-4.5")).toBe(false);
		expect(modelAcceptsReasoningEffort("anthropic:claude-opus-4-6")).toBe(true);
	});

	test("rejects an empty model id", () => {
		expect(modelAcceptsReasoningEffort(undefined)).toBe(false);
		expect(modelAcceptsReasoningEffort("")).toBe(false);
	});
});

describe("mapGenericReasoningEffort", () => {
	test("passes through tiers on the generic ladder", () => {
		expect(mapGenericReasoningEffort("GLM-5.1", "low")).toBe("low");
		expect(mapGenericReasoningEffort("GLM-5.1", "medium")).toBe("medium");
		expect(mapGenericReasoningEffort("GLM-5.1", "high")).toBe("high");
		expect(mapGenericReasoningEffort("GLM-5.1", "max")).toBe("max");
	});

	test("preserves xhigh for models without declared tiers", () => {
		expect(mapGenericReasoningEffort("GLM-5.1", "xhigh")).toBe("xhigh");
	});

	test("passes none through so reasoning can be disabled explicitly", () => {
		expect(mapGenericReasoningEffort("GLM-5.1", "none")).toBe("none");
	});

	test("returns undefined when no effort is set or the model is excluded", () => {
		expect(mapGenericReasoningEffort("GLM-5.1", undefined)).toBeUndefined();
		expect(mapGenericReasoningEffort("GLM-5.1", "")).toBeUndefined();
		expect(mapGenericReasoningEffort("GLM-5.1", "high", [{ pattern: "glm" }])).toBeUndefined();
		expect(mapGenericReasoningEffort("claude-sonnet-4.5", "high")).toBeUndefined();
	});

	test("honors an exclusion reached through a channel prefix", () => {
		// Same normalization as modelAcceptsReasoningEffort, so the completions /
		// responses request paths cannot bypass a blocklist entry.
		expect(
			mapGenericReasoningEffort("responses:GLM-5.1", "high", [{ pattern: "/^glm/" }]),
		).toBeUndefined();
		expect(mapGenericReasoningEffort("responses:GLM-5.1", "high")).toBe("high");
	});

	test("the generic ladder exposes all reasoning tiers", () => {
		expect(GENERIC_REASONING_EFFORT_TIERS).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
});
