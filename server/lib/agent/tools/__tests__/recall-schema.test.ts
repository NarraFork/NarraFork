import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { recallParameters } from "../recall-schema";

const valid = [
	{ action: "search", query: "requirements", roles: ["user"], origins: ["user"], sort: "oldest" },
	{
		action: "search",
		query: ["requirements", "constraints"],
		narrator_id: "other",
		all_narrators: true,
	},
	{
		action: "read_conversation",
		direction: "newer",
		roles: ["user"],
		origins: ["unknown", "user"],
	},
	{ action: "read_conversation", direction: "older", cursor: 0, limit: 1 },
	{ action: "read_conversation", message_id: "saved-message", include_tool_calls: true },
	{ action: "read_message", message_id: "saved-message", offset: 4, max_chars: 20000 },
	{ action: "read_tool_call", tool_call_id: "saved-use", part: "input", offset: 8000 },
];
for (const example of valid) {
	test(`accepts the documented ${example.action} recipe ${JSON.stringify(example)}`, () => {
		expect(recallParameters.safeParse(example).success).toBe(true);
	});
}

const invalid = [
	{ action: "guess" },
	{ action: "search" },
	{ action: "search", query: "" },
	{ action: "search", query: [] },
	{ action: "search", query: Array.from({ length: 11 }, () => "keyword") },
	{ action: "search", query: "x".repeat(513) },
	{ action: "search", query: "keyword", roles: [] },
	{ action: "search", query: "keyword", roles: ["human"] },
	{ action: "search", query: "keyword", origins: [null] },
	{ action: "search", query: "keyword", limit: 1.5 },
	{ action: "search", query: "keyword", limit: 51 },
	{ action: "search", query: "keyword", offset: 1 },
	{ action: "search", query: "keyword", from: "2026-01-01", time_range: "7d" },
	{ action: "read_conversation", cursor: -1 },
	{ action: "read_conversation", direction: "around" },
	{ action: "read_conversation", message_id: "anchor", cursor: 3 },
	{ action: "read_conversation", message_id: "anchor", direction: "older" },
	{ action: "read_message" },
	{ action: "read_message", message_id: "anchor", limit: 20 },
	{ action: "read_message", message_id: "anchor", max_chars: 20001 },
	{ action: "read_tool_call" },
	{ action: "read_tool_call", tool_call_id: "tool", query: "keyword" },
	{ action: "read_tool_call", tool_call_id: "tool", part: "answers" },
	{ action: "read_tool_call", tool_call_id: "tool", id: "wrong-field" },
];
for (const example of invalid) {
	test(`rejects ambiguous/invalid arguments ${JSON.stringify(example).slice(0, 150)}`, () => {
		expect(recallParameters.safeParse(example).success).toBe(false);
	});
}

test("provider schema stays a root object and exposes integer budgets and provenance enums", () => {
	const schema = z.toJSONSchema(recallParameters);
	expect(schema.type).toBe("object");
	expect(schema).not.toHaveProperty("anyOf");
	expect(schema).not.toHaveProperty("oneOf");
	expect(schema).not.toHaveProperty("allOf");
	expect(schema.additionalProperties).toBe(false);
	expect(schema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
	expect(schema.properties?.max_chars).toMatchObject({ type: "integer", maximum: 20000 });
	expect(schema.properties?.origins).toMatchObject({
		type: "array",
		items: { enum: ["user", "assistant", "system", "unknown"] },
	});
});
