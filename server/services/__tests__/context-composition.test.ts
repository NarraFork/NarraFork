import { expect, test } from "bun:test";
import type { ContextSegment } from "@shared/context-composition";
import { readContextSegments } from "../context-composition-projection";

test("statistics reader validates categories and numeric metadata only", () => {
	expect(
		readContextSegments(
			JSON.stringify({
				segments: [
					{ category: "user", chars: 12.5 },
					{ category: "assistant", chars: -4 },
					{ category: "invented", chars: 50 },
					{ category: "attachment", chars: "secret" },
					{ category: "other", text: "never projected", tokens: 99 },
					null,
				],
			}),
		),
	).toEqual([
		{ category: "user", chars: 12 },
		{ category: "assistant", chars: 0 },
	]);
});

test("zero-character tool markers preserve lookup identity while other private fields are discarded", () => {
	expect(
		readContextSegments(
			JSON.stringify({
				segments: [
					{
						category: "toolCall",
						chars: 0,
						toolUseId: "call-1",
						toolName: "secret",
						input: "secret",
					},
					{ category: "assistant", chars: 3, toolUseId: "not-a-marker" },
				],
			}),
		),
	).toEqual([
		{ category: "toolCall", chars: 0, toolUseId: "call-1" },
		{ category: "assistant", chars: 3 },
	]);
});

test("legacy/malformed statistics remain zero without reconstructing text", () => {
	for (const json of [
		null,
		"invalid json",
		"{}",
		JSON.stringify({ content: "huge historical body" }),
	])
		expect(readContextSegments(json)).toEqual([]);
});

test("persisted page arrays and message metadata envelopes share the same reader", () => {
	const segments: ContextSegment[] = [
		{ category: "summary", chars: 10 },
		{ category: "toolDefinition", chars: 9 },
	];
	expect(readContextSegments(JSON.stringify(segments))).toEqual(segments);
	expect(readContextSegments(JSON.stringify({ segments }))).toEqual(segments);
});
