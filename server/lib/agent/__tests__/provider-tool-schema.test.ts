import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { AnthropicProvider } from "../anthropic-provider";
import { CodexProvider } from "../codex-provider";
import { GeminiInteractionsProvider } from "../gemini-interactions-provider";
import { GeminiProvider } from "../gemini-provider";
import { sanitizeGeminiSchema } from "../gemini-tool-schema";
import { OpenAIProvider } from "../openai-provider";
import { RemoteProviderAdapter } from "../remote-provider-adapter";
import type { ResolvedToolDefinition } from "../types";

const config = {
	id: "schema-fixture",
	name: "Schema fixture",
	prefix: "fixture",
	apiKey: "test-key",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "fixture-model",
};

function freezeDeep<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

function tool(rawJsonSchema: Record<string, unknown>): ResolvedToolDefinition {
	return {
		name: "Fixture",
		description: "Schema fixture",
		parameters: z.object({}).passthrough(),
		rawJsonSchema,
		execute: async () => ({ output: "unused" }),
	};
}

const nestedSchema = {
	type: "object",
	properties: {
		input: {
			type: "array",
			items: {
				type: "object",
				properties: { value: { type: "string", minLength: 2 } },
				required: ["value"],
			},
		},
	},
	required: ["input"],
};
const dynamicSchema = {
	type: "object",
	properties: {
		labels: { type: "object", additionalProperties: { type: "string" } },
		options: { type: "object", additionalProperties: true },
		closed: { type: "object", additionalProperties: false },
	},
	additionalProperties: { type: "number" },
};
const annotatedSchema = {
	type: "object",
	"x-custom": { root: true },
	properties: {
		"x-custom": { type: "string", "x-widget": "secret" },
		default: { type: "number", deprecated: true },
		items: {
			type: "array",
			items: { type: "string", "x-format": "widget" },
		},
	},
};
const fixtures: [string, Record<string, unknown>][] = [
	["nested", nestedSchema],
	["empty schema", {}],
	["empty object", { type: "object", properties: {} }],
	["dynamic fields", dynamicSchema],
	["dynamic root", { type: "object", additionalProperties: true }],
	["custom annotations", annotatedSchema],
];

// These are serialized real formatTools results, not hand-built wire declarations.
// No upstream service is contacted; protocol acceptance beyond these fixtures is not asserted.
describe("raw tool schema wire boundaries", () => {
	const adapters = [
		{
			name: "OpenAI Responses",
			provider: new OpenAIProvider({ ...config, apiMode: "responses" }),
			declaration: (schema: unknown) => ({
				type: "function",
				name: "Fixture",
				description: "Schema fixture",
				parameters: schema,
				strict: false,
			}),
		},
		{
			name: "OpenAI Completions",
			provider: new OpenAIProvider({ ...config, apiMode: "completions" }),
			declaration: (schema: unknown) => ({
				type: "function",
				function: { name: "Fixture", description: "Schema fixture", parameters: schema },
			}),
		},
		{
			name: "Codex",
			provider: new CodexProvider(),
			declaration: (schema: unknown) => ({
				type: "function",
				name: "Fixture",
				description: "Schema fixture",
				parameters: schema,
				strict: false,
			}),
		},
		{
			name: "Anthropic",
			provider: new AnthropicProvider(config),
			declaration: (schema: Record<string, unknown>) => ({
				name: "Fixture",
				description: "Schema fixture",
				input_schema: {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					...schema,
				},
			}),
		},
		{
			name: "Remote",
			provider: new RemoteProviderAdapter({
				providerTypeId: "fixture/provider",
				providerInstanceId: "fixture",
				providerPrefix: "fixture",
				config: {},
				modelCatalog: new Map(),
				rpc: {
					chat: async () => {
						throw new Error("unexpected RPC");
					},
					generate: async () => {
						throw new Error("unexpected RPC");
					},
				},
			}),
			declaration: (schema: unknown) => ({
				name: "Fixture",
				description: "Schema fixture",
				inputSchema: schema,
			}),
		},
	];
	for (const adapter of adapters) {
		for (const [name, fixture] of fixtures) {
			test(`${adapter.name}: ${name} is preserved without mutating the catalog`, () => {
				const source = freezeDeep(structuredClone(fixture));
				const wire = JSON.parse(JSON.stringify(adapter.provider.formatTools([tool(source)])));
				expect(wire).toEqual([adapter.declaration(fixture)]);
				expect(source).toEqual(fixture);
			});
		}
	}
});

describe("Gemini shared Schema projection", () => {
	const projectedFixtures: [
		string,
		Record<string, unknown>,
		Record<string, unknown> | undefined,
	][] = [
		["nested", nestedSchema, nestedSchema],
		["empty schema", {}, undefined],
		["empty object", { type: "object", properties: {} }, undefined],
		[
			"dynamic fields",
			dynamicSchema,
			{
				type: "object",
				properties: {
					labels: { type: "object" },
					options: { type: "object" },
					closed: { type: "object" },
				},
			},
		],
		// Existing parameters protocol cannot express arbitrary root keys; do not
		// silently switch to parametersJsonSchema or fabricate a string schema.
		["dynamic root", { type: "object", additionalProperties: true }, undefined],
		[
			"custom annotations",
			annotatedSchema,
			{
				type: "object",
				properties: {
					"x-custom": { type: "string" },
					default: { type: "number" },
					items: { type: "array", items: { type: "string" } },
				},
			},
		],
	];
	for (const [name, fixture, projected] of projectedFixtures) {
		test(`${name}: both transports keep their existing wire envelope`, () => {
			const source = freezeDeep(structuredClone(fixture));
			const declaration = {
				name: "Fixture",
				description: "Schema fixture",
				...(projected ? { parameters: projected } : {}),
			};
			const generate = new GeminiProvider(config).formatTools([tool(source)]);
			const interactions = new GeminiInteractionsProvider(config).formatTools([tool(source)]);
			expect(JSON.parse(JSON.stringify(generate))).toEqual([
				{ functionDeclarations: [declaration] },
			]);
			expect(JSON.parse(JSON.stringify(interactions))).toEqual([
				{ type: "function", ...declaration },
			]);
			expect(source).toEqual(fixture);
		});
	}

	test("keeps existing const, enum, and combinator projection", () => {
		const source = freezeDeep({
			type: "object",
			properties: {
				text: { type: "string", const: "yes" },
				number: { type: "number", const: 3, enum: [1, 3] },
				flag: { type: "boolean", enum: [true, false] },
				choice: { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "number" }] },
				combined: { allOf: [{ type: "string" }, { minLength: 2 }] },
			},
		});
		expect(sanitizeGeminiSchema(source)).toEqual({
			type: "object",
			properties: {
				text: { type: "string", enum: ["yes"] },
				number: { type: "number" },
				flag: { type: "boolean" },
				choice: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "number" }] },
				combined: { anyOf: [{ type: "string" }, { minLength: 2 }] },
			},
		});
	});

	test("filters Schema keys, not example data or property names, and owns its output", () => {
		const source = freezeDeep({
			type: "object",
			required: ["$ref"],
			properties: { $ref: { type: "string" } },
			example: { $ref: "literal", "x-custom": { default: true } },
			"x-custom": { remove: true },
		});
		const output = sanitizeGeminiSchema(source);
		expect(output).toEqual({
			type: "object",
			required: ["$ref"],
			properties: { $ref: { type: "string" } },
			example: source.example,
		});
		(output.required as string[]).push("new");
		(output.example as Record<string, unknown>).extra = true;
		expect(source.required).toEqual(["$ref"]);
		expect(source.example).not.toHaveProperty("extra");
	});

	test("does not invent types or resolve references outside the existing projection", () => {
		expect(
			sanitizeGeminiSchema({
				type: "object",
				properties: { value: { $ref: "#/$defs/value" } },
				$defs: { value: { type: "number" } },
			}),
		).toEqual({ type: "object", properties: { value: {} } });
	});
});
