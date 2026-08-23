/**
 * Auxiliary calls (titles, summaries, reflections) force `reasoningEffort: "none"`
 * to stay cheap. Some endpoints refuse that outright:
 *
 *   Anthropic API error 400: Reasoning is mandatory for this endpoint and cannot
 *   be disabled.
 *
 * Without a fallback the whole feature fails — a session keeps its provisional
 * title forever — even though the model itself is perfectly usable.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { isReasoningMandatoryError } from "../error-handling";
import type { GenerateOptions } from "../provider";
import {
	modelRequiresReasoning,
	resetReasoningMandatoryModels,
	withReasoningMandatoryFallback,
} from "../reasoning-mandatory-fallback";
import { ApiError } from "../types";

const MANDATORY_MESSAGE =
	"Anthropic API error 400: Reasoning is mandatory for this endpoint and cannot be disabled.";

beforeEach(() => {
	resetReasoningMandatoryModels();
});

describe("isReasoningMandatoryError", () => {
	test("matches the observed Anthropic 400", () => {
		expect(isReasoningMandatoryError(new ApiError(400, MANDATORY_MESSAGE))).toBe(true);
	});

	test("matches the phrase through diagnostics text", () => {
		expect(
			isReasoningMandatoryError({
				message: "Provider API error 400",
				diagnostics: { responseSnippet: "reasoning cannot be disabled for this model" },
			}),
		).toBe(true);
	});

	test("does not match unrelated reasoning parameter errors", () => {
		// A real parameter mistake must keep failing: the caller's response to a
		// match is to silently re-send with reasoning ON.
		expect(
			isReasoningMandatoryError(
				new ApiError(400, "Anthropic API error 400: reasoning_effort: unexpected value 'ultra'"),
			),
		).toBe(false);
		expect(isReasoningMandatoryError(new ApiError(400, "thinking.budget_tokens too small"))).toBe(
			false,
		);
	});

	test("tolerates non-object throws", () => {
		expect(isReasoningMandatoryError("reasoning is mandatory here")).toBe(true);
		expect(isReasoningMandatoryError(undefined)).toBe(false);
	});
});

describe("withReasoningMandatoryFallback", () => {
	test("retries without a reasoning preference and succeeds", async () => {
		const seen: Array<GenerateOptions | undefined> = [];
		const result = await withReasoningMandatoryFallback(
			"anthropic:claude-opus-4-8",
			{ reasoningEffort: "none", maxOutputTokens: 64 },
			async (options) => {
				seen.push(options);
				if (options?.reasoningEffort === "none") throw new ApiError(400, MANDATORY_MESSAGE);
				return "Refactor the parser";
			},
		);

		expect(result).toBe("Refactor the parser");
		expect(seen).toHaveLength(2);
		// The retry drops only the reasoning preference — no tier is substituted,
		// since we know nothing about which tiers this endpoint accepts.
		expect(seen[1]).toEqual({ maxOutputTokens: 64 });
		expect("reasoningEffort" in (seen[1] ?? {})).toBe(false);
	});

	test("skips the doomed first attempt for a model already known to require reasoning", async () => {
		const seen: Array<GenerateOptions | undefined> = [];
		const run = async (options: GenerateOptions | undefined): Promise<string> => {
			seen.push(options);
			if (options?.reasoningEffort === "none") throw new ApiError(400, MANDATORY_MESSAGE);
			return "ok";
		};

		await withReasoningMandatoryFallback("p:m", { reasoningEffort: "none" }, run);
		expect(modelRequiresReasoning("p:m")).toBe(true);

		await withReasoningMandatoryFallback("p:m", { reasoningEffort: "none" }, run);
		// First call: rejected attempt + retry. Second call: retry shape only.
		expect(seen).toHaveLength(3);
		expect(seen[2]).toEqual({});
	});

	test("learns per model id, not globally", async () => {
		await withReasoningMandatoryFallback("p:strict", { reasoningEffort: "none" }, async (o) => {
			if (o?.reasoningEffort === "none") throw new ApiError(400, MANDATORY_MESSAGE);
			return "ok";
		});
		expect(modelRequiresReasoning("p:strict")).toBe(true);
		expect(modelRequiresReasoning("p:other")).toBe(false);
	});

	test("re-throws unrelated errors without retrying", async () => {
		let calls = 0;
		await expect(
			withReasoningMandatoryFallback("p:m", { reasoningEffort: "none" }, async () => {
				calls++;
				throw new ApiError(429, "Provider API error 429: rate limit");
			}),
		).rejects.toThrow("rate limit");
		expect(calls).toBe(1);
		expect(modelRequiresReasoning("p:m")).toBe(false);
	});

	test("leaves an explicit non-none effort untouched", async () => {
		// Only a forced "none" is ours to rewrite; any other value is the user's
		// choice, so a mandatory-reasoning 400 there is a real error.
		let calls = 0;
		await expect(
			withReasoningMandatoryFallback("p:m", { reasoningEffort: "low" }, async () => {
				calls++;
				throw new ApiError(400, MANDATORY_MESSAGE);
			}),
		).rejects.toThrow(MANDATORY_MESSAGE);
		expect(calls).toBe(1);
	});

	test("propagates the second failure when the retry also fails", async () => {
		await expect(
			withReasoningMandatoryFallback("p:m", { reasoningEffort: "none" }, async (o) => {
				if (o?.reasoningEffort === "none") throw new ApiError(400, MANDATORY_MESSAGE);
				throw new ApiError(500, "Provider API error 500: upstream exploded");
			}),
		).rejects.toThrow("upstream exploded");
	});
});
