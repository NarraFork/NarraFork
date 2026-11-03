/**
 * The structured-output contract for prompt optimization.
 *
 * Two halves are pinned here: the JSON Schema handed to providers (the fields
 * the model may produce) and the whitelist reader that decides what may reach
 * the composer or the summary popup. The reader is the trust boundary, so its
 * rejections matter as much as its successes.
 */
import { describe, expect, test } from "bun:test";
import {
	getOptimizeOutputSchema,
	OPTIMIZE_SUMMARY_FIELD,
	readOptimizeResult,
} from "../prompt-optimize";

describe("optimize output schema", () => {
	test("declares the body and summary fields, closed and required", () => {
		const schema = getOptimizeOutputSchema();
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["optimizedPrompt", "reasoningSummary"]);
		expect(schema.additionalProperties).toBe(false);
		expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
			"optimizedPrompt",
			"reasoningSummary",
		]);
	});

	test("the summary field name matches the exported constant", () => {
		// The route and the provider-layer `summaryField` both use this constant;
		// a drift here would silently stop the summary from being lifted.
		expect(OPTIMIZE_SUMMARY_FIELD).toBe("reasoningSummary");
		const schema = getOptimizeOutputSchema();
		expect(schema.properties as Record<string, unknown>).toHaveProperty(OPTIMIZE_SUMMARY_FIELD);
	});

	test("both fields are strings", () => {
		const properties = getOptimizeOutputSchema().properties as Record<
			string,
			{ type: string; description: string }
		>;
		expect(properties.optimizedPrompt.type).toBe("string");
		expect(properties.reasoningSummary.type).toBe("string");
	});

	test("the summary description forbids restating the prompt", () => {
		const properties = getOptimizeOutputSchema().properties as Record<
			string,
			{ description: string }
		>;
		// The constraint lives in the description because JSON Schema cannot say
		// "do not repeat the body".
		expect(properties.reasoningSummary.description.toLowerCase()).toContain("never restate");
		expect(properties.reasoningSummary.description).toContain("100");
	});
});

describe("readOptimizeResult", () => {
	test("returns both fields when present", () => {
		expect(
			readOptimizeResult({
				optimizedPrompt: "写一个登录页面。",
				reasoningSummary: "补充了字段与校验要求。",
			}),
		).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验要求。",
		});
	});

	test("summary is optional: a payload without it still yields the prompt", () => {
		expect(readOptimizeResult({ optimizedPrompt: "写一个登录页面。" })).toEqual({
			optimizedPrompt: "写一个登录页面。",
		});
	});

	test("a blank summary collapses to absent", () => {
		expect(
			readOptimizeResult({ optimizedPrompt: "写一个登录页面。", reasoningSummary: "   " }),
		).toEqual({ optimizedPrompt: "写一个登录页面。" });
	});

	test("trims surrounding whitespace on both fields", () => {
		expect(
			readOptimizeResult({
				optimizedPrompt: "  写一个登录页面。\n",
				reasoningSummary: "  补充校验。 ",
			}),
		).toEqual({ optimizedPrompt: "写一个登录页面。", reasoningSummary: "补充校验。" });
	});

	test("ignores extra fields instead of surfacing them", () => {
		// A leaky relay that appends its own analysis must not reach the composer
		// or the popup.
		const payload = {
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充校验。",
			reasoning: "the user probably wants validation",
			thinking: "<long private reasoning>",
		};
		expect(readOptimizeResult(payload)).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充校验。",
		});
	});

	test("rejects an empty body field", () => {
		// Blank is not a usable optimization: the caller must fall through to the
		// text path rather than blank the user's composer.
		expect(readOptimizeResult({ optimizedPrompt: "   ", reasoningSummary: "x" })).toBeUndefined();
	});

	test("rejects a missing body field even when the summary is present", () => {
		expect(readOptimizeResult({ reasoningSummary: "补充校验。" })).toBeUndefined();
	});

	test("rejects a non-string summary", () => {
		expect(
			readOptimizeResult({ optimizedPrompt: "写一个登录页面。", reasoningSummary: 42 }),
		).toBeUndefined();
	});

	test("rejects a non-string body field", () => {
		expect(readOptimizeResult({ optimizedPrompt: 42 })).toBeUndefined();
	});

	test("rejects non-object payloads", () => {
		expect(readOptimizeResult("写一个登录页面。")).toBeUndefined();
		expect(readOptimizeResult(null)).toBeUndefined();
		expect(readOptimizeResult(undefined)).toBeUndefined();
		expect(readOptimizeResult(["写一个登录页面。"])).toBeUndefined();
	});
});
