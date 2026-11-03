/**
 * Mapping a `responseFormat` onto each provider's wire shape, and reporting
 * degradation when a payload cannot be parsed as the requested structure.
 *
 * The provider wire assertions live in the provider tests; this file pins the
 * shared helpers those adapters build on.
 */
import { describe, expect, test } from "bun:test";
import type { ResponseFormat } from "../provider";
import {
	geminiResponseSchema,
	openAIChatResponseFormat,
	openAIResponsesTextFormat,
	parseStructuredJsonText,
	parseToolArguments,
	structuredResult,
	unsupportedResponseFormatReason,
} from "../response-format";

const FORMAT: ResponseFormat = {
	type: "json_schema",
	name: "demo",
	schema: {
		type: "object",
		properties: { optimizedPrompt: { type: "string", description: "the prompt" } },
		required: ["optimizedPrompt"],
		additionalProperties: false,
	},
	strict: true,
};

describe("OpenAI mapping", () => {
	test("chat completions uses response_format.json_schema", () => {
		expect(openAIChatResponseFormat(FORMAT)).toEqual({
			type: "json_schema",
			json_schema: { name: "demo", schema: FORMAT.schema, strict: true },
		});
	});

	test("responses uses text.format instead", () => {
		expect(openAIResponsesTextFormat(FORMAT)).toEqual({
			format: { type: "json_schema", name: "demo", schema: FORMAT.schema, strict: true },
		});
	});

	test("strict is omitted only when explicitly disabled", () => {
		const loose = { ...FORMAT, strict: false } as ResponseFormat;
		expect(openAIChatResponseFormat(loose).json_schema).not.toHaveProperty("strict");
	});
});

describe("Gemini mapping", () => {
	test("drops keywords the Gemini schema dialect rejects", () => {
		const projected = geminiResponseSchema(FORMAT.schema);
		expect(projected).not.toHaveProperty("additionalProperties");
		expect(projected.required).toEqual(["optimizedPrompt"]);
	});

	test("projects nested property schemas too", () => {
		const projected = geminiResponseSchema(FORMAT.schema) as {
			properties: Record<string, Record<string, unknown>>;
		};
		expect(projected.properties.optimizedPrompt).toEqual({
			type: "string",
			description: "the prompt",
		});
	});

	test("is idempotent", () => {
		const once = geminiResponseSchema(FORMAT.schema);
		expect(geminiResponseSchema(once)).toEqual(once);
	});
});

describe("parsing", () => {
	test("parses a plain JSON object", () => {
		expect(parseStructuredJsonText('{"optimizedPrompt":"hi"}')).toEqual({
			optimizedPrompt: "hi",
		});
	});

	test("parses a fenced JSON object", () => {
		expect(parseStructuredJsonText('```json\n{"optimizedPrompt":"hi"}\n```')).toEqual({
			optimizedPrompt: "hi",
		});
	});

	test("returns undefined for prose", () => {
		expect(parseStructuredJsonText("Here is your prompt: hi")).toBeUndefined();
	});

	test("finds the object behind a leading sentence", () => {
		// Relays that honour the schema but not the framing still return the object.
		expect(parseStructuredJsonText('Here you go:\n{"optimizedPrompt":"hi"}')).toEqual({
			optimizedPrompt: "hi",
		});
	});

	test("finds the object when a trailing note follows it", () => {
		expect(
			parseStructuredJsonText('{"optimizedPrompt":"hi"}\n\nLet me know if you need more.'),
		).toEqual({ optimizedPrompt: "hi" });
	});

	test("ignores braces inside JSON strings when balancing", () => {
		// A naive scan would stop at the `}` inside the string and truncate.
		expect(parseStructuredJsonText('note: {"optimizedPrompt":"use {braces} here"} done')).toEqual({
			optimizedPrompt: "use {braces} here",
		});
	});

	test("does not parse a bare array as a structured object", () => {
		expect(parseStructuredJsonText("prose [1,2,3] more")).toBeUndefined();
	});

	test("returns undefined for non-object JSON", () => {
		expect(parseStructuredJsonText("[1,2,3]")).toBeUndefined();
		expect(parseStructuredJsonText('"hi"')).toBeUndefined();
	});

	test("parses accumulated tool arguments", () => {
		expect(parseToolArguments('{"optimizedPrompt":"hi"}')).toEqual({ optimizedPrompt: "hi" });
		expect(parseToolArguments("")).toBeUndefined();
		expect(parseToolArguments("not json")).toBeUndefined();
	});
});

describe("degradation reporting", () => {
	test("nothing is reported when no format was requested", () => {
		expect(structuredResult(undefined, "prose", "OpenAI")).toEqual({});
		expect(structuredResult({}, "prose", "OpenAI")).toEqual({});
	});

	test("structured is set when the payload parses", () => {
		expect(
			structuredResult({ responseFormat: FORMAT }, '{"optimizedPrompt":"hi"}', "OpenAI"),
		).toEqual({
			structured: { optimizedPrompt: "hi" },
		});
	});

	test("a non-JSON payload reports degradation rather than silence", () => {
		const result = structuredResult({ responseFormat: FORMAT }, "just prose", "OpenAI");
		expect(result.structured).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("OpenAI");
	});

	test("adapters without a native mode have a reason string", () => {
		expect(unsupportedResponseFormatReason("Remote executor")).toContain("Remote executor");
	});
});
