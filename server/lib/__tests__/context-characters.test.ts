import { describe, expect, test } from "bun:test";
import {
	measureMessageCharacters,
	measureSerializedCharacters,
	measureSummaryCharacters,
} from "../context-characters";

describe("persisted context characters", () => {
	test("counts UTF-16 code units, not tokens, Unicode points or bytes", () => {
		const text = "中😀\n";
		expect(measureSummaryCharacters(text)).toBe(4);
		expect(measureSummaryCharacters(null)).toBe(0);
		expect(measureSummaryCharacters()).toBe(0);
		expect(measureMessageCharacters("user", [{ type: "text", text }], text)).toEqual({
			segments: [{ category: "user", chars: 4 }],
		});
	});

	test("tools use a fixed compact JSON representation", () => {
		expect(measureSerializedCharacters({ text: "中😀", count: 2 })).toBe(
			JSON.stringify({ text: "中😀", count: 2 }).length,
		);
		expect(measureSerializedCharacters("hello")).toBe(JSON.stringify("hello").length);
		expect(measureSerializedCharacters(null)).toBe(0);
		expect(measureSerializedCharacters(undefined)).toBe(0);
		expect(measureSerializedCharacters({ data: "ordinary text" })).toBe(
			JSON.stringify({ data: "ordinary text" }).length,
		);
	});

	test("binary and base64 payloads cannot dominate JSON counts", () => {
		const payload = {
			text: "visible",
			imageBase64: "x".repeat(10000),
			image: { type: "image", source: { type: "base64", data: "x".repeat(10000) } },
			inlineData: { data: "x".repeat(10000) },
			url: "data:image/png;base64,AAAA",
			bytes: new Uint8Array(10000),
			buffer: Buffer.alloc(10000),
		};
		expect(measureSerializedCharacters(payload)).toBe(JSON.stringify({ text: "visible" }).length);
	});

	test("attachments are separate from prompt text and never read disk references", () => {
		expect(
			measureMessageCharacters(
				"user",
				[
					{ type: "text", text: "ask" },
					{ type: "file_reference", snapshotText: "saved content" },
					{ type: "text_file", content: "attached" },
					{ type: "text_file", filePath: "/does-not-exist", size: 999999 },
					{ type: "image", source: { type: "base64", data: "x".repeat(10000) } },
				],
				"ask",
			),
		).toEqual({
			segments: [
				{ category: "user", chars: 3 },
				{ category: "attachment", chars: "saved contentattached".length },
			],
		});
	});

	test("persisted text attachment counters are accepted without treating byte sizes as characters", () => {
		expect(
			measureMessageCharacters("user", [
				{ type: "text_file", filePath: "/missing", size: 10000, contentChars: 4 },
				{ type: "text_file", filePath: "/also-missing", chars: 2 },
				{ type: "text_file", contentChars: -1 },
				{ type: "text_file", contentChars: Number.NaN },
				{ type: "text_file", contentChars: 1.5 },
			]),
		).toEqual({ segments: [{ category: "attachment", chars: 6 }] });
	});

	test("reasoning is assistant text, native model projections are system text", () => {
		expect(
			measureMessageCharacters("assistant", [
				{ type: "reasoning", text: "thought", translatedText: "not model-facing" },
				{ type: "thinking", thinking: "more" },
				{ type: "text", text: "answer" },
			]),
		).toEqual({ segments: [{ category: "assistant", chars: 17 }] });
		expect(
			measureMessageCharacters("sys", [
				{ type: "system_injection", modelText: "projection", body: { text: "UI" } },
			]),
		).toEqual({ segments: [{ category: "system", chars: 10 }] });
	});

	test("tool duplicates, global summary duplicates and UI state do not count", () => {
		const blocks = [
			{ type: "tool_use", input: { prompt: "x".repeat(1000) } },
			{ type: "tool_result", content: "x".repeat(1000) },
			{ type: "compact", status: "compacted", summary: "global summary" },
			{ type: "redacted_thinking", data: "x".repeat(1000) },
			{ type: "info", message: "UI only" },
			{ type: "error", message: "UI failure" },
		];
		expect(measureMessageCharacters("assistant", blocks, "duplicated preview")).toEqual({
			segments: [],
		});
		expect(measureMessageCharacters("disp", [{ type: "text", text: "UI" }])).toEqual({
			segments: [],
		});
		expect(measureMessageCharacters("user", null, "legacy fallback")).toEqual({
			segments: [{ category: "user", chars: 15 }],
		});
	});

	test("tool markers preserve interleaved chronology without owning duplicated tool bytes", () => {
		expect(
			measureMessageCharacters("assistant", [
				{ type: "text", text: "before" },
				{ type: "tool_use", id: "tool", input: { command: "large input" } },
				{ type: "text", text: "after" },
			]),
		).toEqual({
			segments: [
				{ category: "assistant", chars: 6 },
				{ category: "toolCall", chars: 0, toolUseId: "tool" },
				{ category: "assistant", chars: 5 },
			],
		});
	});

	test("segment summary counts only its successful new content", () => {
		expect(
			measureMessageCharacters("user", [
				{ type: "segment_compact", status: "compacted", summary: "small" },
			]),
		).toEqual({ segments: [{ category: "summary", chars: 5 }] });
		for (const status of ["compacting", "failed"]) {
			expect(
				measureMessageCharacters("user", [
					{ type: "segment_compact", status, summary: "not active" },
				]),
			).toEqual({ segments: [] });
		}
	});
});

test("accepted file path hints contribute characters without counting referenced disk bytes", () => {
	const hint = "\n\n<attached_files>\nreport.txt /uploads/report.txt\n</attached_files>";
	const blocks = [
		{ type: "text", text: "read it" },
		{ type: "text_file", filePath: "/does-not-exist" },
	];
	expect(measureMessageCharacters("user", blocks, `read it${hint}`)).toEqual({
		segments: [
			{ category: "user", chars: 7 },
			{ category: "attachment", chars: hint.length },
		],
	});
	expect(measureMessageCharacters("user", blocks, "read it")).toEqual({
		segments: [{ category: "user", chars: 7 }],
	});
});
test("new flat bodies, reasoning aliases and tool markers retain their character metadata", () => {
	expect(measureMessageCharacters("user", [], "new body")).toEqual({
		segments: [{ category: "user", chars: 8 }],
	});
	expect(
		measureMessageCharacters("assistant", [
			{ type: "thinking", text: "thought" },
			{ type: "tool_use", toolUseId: "alias" },
			{ type: "text", text: "done" },
		]),
	).toEqual({
		segments: [
			{ category: "assistant", chars: 7 },
			{ category: "toolCall", chars: 0, toolUseId: "alias" },
			{ category: "assistant", chars: 4 },
		],
	});
});
