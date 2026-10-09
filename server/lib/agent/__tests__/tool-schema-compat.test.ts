/**
 * Tool input-schema compatibility with Anthropic's Messages API.
 *
 * That API rejects `oneOf`/`allOf`/`anyOf` at the top level of a tool's `input_schema` and
 * fails the whole request rather than the offending tool, so the agent loop cannot start at
 * all. These cover both layers that prevent it: the flattened definition of the tool that
 * used a top-level union, and the provider-boundary flattening that catches everything else
 * (plugins, MCP servers, user configuration).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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

	test("refuses to guess when a branch is not an object schema", () => {
		// A schema the API refuses is better than one describing the wrong arguments.
		const schema = { type: "object", anyOf: [{ type: "string" }, { type: "number" }] };
		expect(flattenTopLevelUnion(schema)).toBe(schema);
	});
});
