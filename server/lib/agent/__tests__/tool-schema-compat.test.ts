/**
 * Tool input-schema compatibility with Anthropic's Messages API.
 *
 * That API rejects `oneOf`/`allOf`/`anyOf` at the top level of a tool's `input_schema` and
 * fails the whole request rather than the offending tool, so the agent loop cannot start at
 * all. These cover both layers that prevent it: the flattened definition of the tool that
 * used a top-level union, and the provider-boundary flattening that catches everything else
 * (plugins, MCP servers, user configuration).
 */

import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "../../logger";
import { zodToJsonSchema } from "../tool-registry";
import { flattenTopLevelUnion } from "../tool-schema-compat";

describe("RequestPermissionRule definition", () => {
	test("no longer derives its model-facing schema from the Zod union", () => {
		// A regression here stays invisible until an Anthropic request 400s, and that error
		// names neither the tool nor the keyword — so the definition is pinned by source. All
		// other tools use plain objects; this was the only top-level union.
		const source = readFileSync(
			join(import.meta.dir, "..", "tools", "request-permission-rule.ts"),
			"utf-8",
		);
		expect(source).not.toContain("zodToJsonSchema(requestPermissionRuleSchema)");
		expect(source).toContain("rawJsonSchema: REQUEST_PERMISSION_RULE_JSON_SCHEMA");
	});
});

describe("flattenTopLevelUnion", () => {
	test("leaves a schema without a top-level union untouched", () => {
		const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
		expect(flattenTopLevelUnion(schema)).toBe(schema);
	});

	test("leaves a nested anyOf alone — only the top level is rejected", () => {
		const schema = {
			type: "object",
			properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } },
		};
		expect(flattenTopLevelUnion(schema)).toBe(schema);
	});

	test("turns the converter's discriminated-union output into a flat object", () => {
		// The exact shape the converter produces for such a schema — the regression that took
		// the agent loop down.
		const union = z.discriminatedUnion("ruleType", [
			z.object({ ruleType: z.literal("directoryWhitelist"), path: z.string() }).strict(),
			z.object({ ruleType: z.literal("commandBlacklist"), pattern: z.string() }).strict(),
		]);
		const converted = zodToJsonSchema(union);
		expect(Array.isArray(converted.anyOf)).toBe(true);

		const flattened = flattenTopLevelUnion(converted);
		const properties = flattened.properties as Record<string, unknown>;

		expect(flattened.type).toBe("object");
		expect("anyOf" in flattened).toBe(false);
		expect(Object.keys(properties).sort()).toEqual(["path", "pattern", "ruleType"]);
		// The discriminator collapses into the enum of the branches' literals.
		expect(properties.ruleType).toMatchObject({ enum: ["directoryWhitelist", "commandBlacklist"] });
	});

	test("required is the intersection, so a branch-only field never becomes mandatory", () => {
		const flattened = flattenTopLevelUnion({
			type: "object",
			anyOf: [
				{
					type: "object",
					properties: { a: { type: "string" }, b: { type: "string" } },
					required: ["a", "b"],
				},
				{
					type: "object",
					properties: { a: { type: "string" }, c: { type: "string" } },
					required: ["a", "c"],
				},
			],
		});
		expect(flattened.required).toEqual(["a"]);
	});

	const validator = (schema: Record<string, unknown>) =>
		z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);

	test.each(["anyOf", "oneOf"])("%s preserves heterogeneous property variants", (keyword) => {
		const flattened = flattenTopLevelUnion({
			[keyword]: [
				{
					type: "object",
					properties: { value: { type: "string", minLength: 2 } },
					required: ["value"],
				},
				{
					type: "object",
					properties: { value: { type: "number", minimum: 3 } },
					required: ["value"],
				},
			],
		});
		expect(flattened[keyword]).toBeUndefined();
		const validate = validator(flattened);
		for (const value of ["ok", 4]) expect(validate.safeParse({ value }).success).toBe(true);
		for (const value of ["x", 2, false]) expect(validate.safeParse({ value }).success).toBe(false);
	});

	test.each([
		[1, 2],
		[true, false],
		[1, "one"],
	])("preserves literal discriminators %j", (...values) => {
		const flattened = flattenTopLevelUnion({
			anyOf: values.map((value) => ({
				type: "object",
				properties: { kind: { const: value } },
				required: ["kind"],
			})),
		});
		expect((flattened.properties as Record<string, unknown>).kind).toEqual({ enum: values });
		const validate = validator(flattened);
		for (const kind of values) expect(validate.safeParse({ kind }).success).toBe(true);
		expect(validate.safeParse({ kind: "other" }).success).toBe(false);
	});

	test("does not collapse literal variants with distinct sibling constraints", () => {
		const flattened = flattenTopLevelUnion({
			anyOf: [
				{ type: "object", properties: { value: { type: "number", enum: [1, 2], minimum: 2 } } },
				{ type: "object", properties: { value: { type: "number", const: 3, minimum: 3 } } },
			],
		});
		expect((flattened.properties as Record<string, unknown>).value).toEqual({
			anyOf: [
				{ type: "number", enum: [1, 2], minimum: 2 },
				{ type: "number", const: 3, minimum: 3 },
			],
		});
		const validate = validator(flattened);
		for (const value of [2, 3]) expect(validate.safeParse({ value }).success).toBe(true);
		expect(validate.safeParse({ value: 4 }).success).toBe(false);
	});

	test("allOf unions required fields and intersects same-property enums", () => {
		const flattened = flattenTopLevelUnion({
			allOf: [
				{
					type: "object",
					properties: { a: { type: "string" }, kind: { enum: [1, 2] } },
					required: ["a", "kind"],
				},
				{
					type: "object",
					properties: { b: { type: "number" }, kind: { enum: [2, 3] } },
					required: ["b", "kind"],
				},
			],
		});
		expect(flattened.allOf).toBeUndefined();
		expect(flattened.required).toEqual(["a", "kind", "b"]);
		expect((flattened.properties as Record<string, unknown>).kind).toEqual({
			allOf: [{ enum: [1, 2] }, { enum: [2, 3] }],
		});
		const validate = validator(flattened);
		expect(validate.safeParse({ a: "ok", b: 1, kind: 2 }).success).toBe(true);
		for (const kind of [1, 3])
			expect(validate.safeParse({ a: "ok", b: 1, kind }).success).toBe(false);
		expect(validate.safeParse({ a: "ok", kind: 2 }).success).toBe(false);
	});

	test("keeps root fields, required, metadata and referenced definitions", () => {
		const schema = {
			type: "object",
			title: "Tool",
			description: "Shared constraints",
			minProperties: 2,
			$defs: { Name: { type: "string", minLength: 2 } },
			properties: { name: { $ref: "#/$defs/Name" }, value: { type: "number", minimum: 2 } },
			required: ["name"],
			anyOf: [
				{ type: "object", properties: { value: { enum: [1, 2] } }, required: ["value"] },
				{ type: "object", properties: { value: { const: 3 } }, required: ["value"] },
			],
		};
		const before = JSON.stringify(schema);
		const flattened = flattenTopLevelUnion(schema);
		expect(flattened).toMatchObject({
			title: "Tool",
			description: "Shared constraints",
			minProperties: 2,
			$defs: schema.$defs,
			required: ["name", "value"],
		});
		expect((flattened.properties as Record<string, unknown>).name).toEqual({
			$ref: "#/$defs/Name",
		});
		const validate = validator(flattened);
		for (const value of [2, 3])
			expect(validate.safeParse({ name: "ok", value }).success).toBe(true);
		expect(validate.safeParse({ name: "x", value: 2 }).success).toBe(false);
		expect(validate.safeParse({ name: "ok", value: 1 }).success).toBe(false);
		expect(validate.safeParse({ value: 2 }).success).toBe(false);
		expect(JSON.stringify(schema)).toBe(before);
	});

	test("flattens the actual converter's numeric discriminated union", () => {
		const union = z.discriminatedUnion("kind", [
			z.object({ kind: z.literal(1), value: z.string() }).strict(),
			z.object({ kind: z.literal(2), value: z.number() }).strict(),
		]);
		const converted = zodToJsonSchema(union);
		const flattened = flattenTopLevelUnion(converted);
		expect(flattened.anyOf).toBeUndefined();
		expect((flattened.properties as Record<string, unknown>).kind).toMatchObject({ enum: [1, 2] });
		const validate = validator(flattened);
		for (const input of [
			{ kind: 1, value: "ok" },
			{ kind: 2, value: 42 },
		]) {
			expect(union.safeParse(input).success).toBe(true);
			expect(validate.safeParse(input).success).toBe(true);
		}
		expect(validate.safeParse({ kind: 3, value: 42 }).success).toBe(false);
	});

	test("allOf retains root constraints and contradictory nested consts", () => {
		const flattened = flattenTopLevelUnion({
			properties: { name: { $ref: "#/$defs/Name" } },
			required: ["name"],
			$defs: { Name: { type: "string" } },
			allOf: [
				{ type: "object", properties: { kind: { const: true } }, required: ["kind"] },
				{ type: "object", properties: { kind: { const: false } } },
			],
		});
		expect(flattened.required).toEqual(["name", "kind"]);
		expect(flattened.$defs).toEqual({ Name: { type: "string" } });
		expect((flattened.properties as Record<string, unknown>).kind).toEqual({
			allOf: [{ const: true }, { const: false }],
		});
		const validate = validator(flattened);
		for (const kind of [true, false])
			expect(validate.safeParse({ name: "ok", kind }).success).toBe(false);
	});

	test("keeps closed root properties when no branch introduces fields", () => {
		const flattened = flattenTopLevelUnion({
			type: "object",
			additionalProperties: false,
			properties: { value: { type: "number" } },
			anyOf: [
				{ type: "object", properties: { value: { const: 1 } } },
				{ type: "object", properties: { value: { const: 2 } } },
			],
		});
		expect(flattened.additionalProperties).toBe(false);
		expect(validator(flattened).safeParse({ value: 2 }).success).toBe(true);
		expect(validator(flattened).safeParse({ value: 2, extra: 1 }).success).toBe(false);
	});

	test("retains both const and enum when they occur on one variant", () => {
		const first = { const: 1, enum: [2] };
		const second = { const: 3 };
		const flattened = flattenTopLevelUnion({
			anyOf: [
				{ type: "object", properties: { kind: first } },
				{ type: "object", properties: { kind: second } },
			],
		});
		expect((flattened.properties as Record<string, unknown>).kind).toEqual({
			anyOf: [first, second],
		});
	});

	test.each([
		"#/anyOf/0/properties/a",
		"#/properties/a/anyOf/0",
		"#%2FanyOf%2F0",
		"#",
	])("refuses to relocate local reference %s", (reference) => {
		const schema = {
			$defs: { Alias: { $ref: reference } },
			properties: { alias: { $ref: "#/$defs/Alias" } },
			anyOf: [{ type: "object", properties: { a: { type: "string" } } }],
		};
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(flattenTopLevelUnion(schema)).toBe(schema);
			expect(warn).toHaveBeenCalledWith(
				"Tool input_schema has a top-level union that could not be flattened",
				expect.objectContaining({ reason: "local reference target may be relocated" }),
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("unconstrained absent union properties do not lose legal values", () => {
		const flattened = flattenTopLevelUnion({
			anyOf: [
				{ type: "object", properties: { value: { type: "number" } } },
				{ type: "object", properties: { other: { type: "string" } } },
			],
		});
		expect(validator(flattened).safeParse({ value: false }).success).toBe(true);
	});

	test("preserves common closed-branch additionalProperties and annotations", () => {
		const flattened = flattenTopLevelUnion({
			anyOf: [
				{
					type: "object",
					title: "Tool",
					additionalProperties: false,
					properties: { kind: { const: 1 }, a: { type: "string" } },
				},
				{
					type: "object",
					title: "Tool",
					additionalProperties: false,
					properties: { kind: { const: 2 }, b: { type: "number" } },
				},
			],
		});
		expect(flattened.additionalProperties).toBe(false);
		expect(flattened.title).toBe("Tool");
		expect(validator(flattened).safeParse({ unknown: true }).success).toBe(false);
	});

	test("warns and returns original for unsafe object constraints", () => {
		const object = { type: "object", properties: { a: { type: "string" } } };
		const cases = [
			{ anyOf: [object], allOf: [object] },
			{ anyOf: [object], oneOf: [object] },
			{ anyOf: [] },
			{ anyOf: [true] },
			{ anyOf: [{ ...object, $ref: "#/$defs/Object" }] },
			{ anyOf: [{ ...object, minProperties: 1 }] },
			{
				anyOf: [
					{ ...object, title: "A" },
					{ ...object, title: "B" },
				],
			},
			{ anyOf: [{ ...object, additionalProperties: false }, object] },
			{ anyOf: [{ ...object, additionalProperties: { type: "string" } }] },
			{ additionalProperties: false, anyOf: [object] },
			{ additionalProperties: { type: "string" }, anyOf: [object] },
			{
				allOf: [
					{ ...object, additionalProperties: false },
					{ type: "object", properties: { b: { type: "number" } }, additionalProperties: false },
				],
			},
		];
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			for (const schema of cases) expect(flattenTopLevelUnion(schema)).toBe(schema);
			expect(warn).toHaveBeenCalledTimes(cases.length);
		} finally {
			warn.mockRestore();
		}
	});

	test("refuses to guess when a branch is not an object schema", () => {
		// A schema the API refuses is better than one describing the wrong arguments.
		const schema = { type: "object", anyOf: [{ type: "string" }, { type: "number" }] };
		expect(flattenTopLevelUnion(schema)).toBe(schema);
	});
});
