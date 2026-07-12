import { describe, expect, test } from "bun:test";
import {
	hasStructuredReasoning,
	parseReasoningSegments,
	type ReasoningSegment,
} from "../reasoning-segments";

/** Join codex-style parts the way openai-provider persists them. */
function joinParts(parts: string[]): string {
	return parts.join("\n\n");
}

function titles(segments: ReasoningSegment[]): (string | null)[] {
	return segments.map((s) => s.title);
}

describe("parseReasoningSegments — codex parity", () => {
	test("splits header and body when both present", () => {
		const segments = parseReasoningSegments("**High level plan**\n\nWe should fix the bug next.");
		expect(segments).toEqual([
			{ title: "High level plan", body: "We should fix the bug next.", isEmpty: false },
		]);
	});

	test("marks pure <!-- --> placeholder bodies as empty", () => {
		const segments = parseReasoningSegments(
			joinParts([
				"**Checking the first thing**\n\n<!-- -->",
				"**Checking the second thing**\n\n<!-- -->",
			]),
		);
		expect(titles(segments)).toEqual(["Checking the first thing", "Checking the second thing"]);
		expect(segments.every((s) => s.isEmpty)).toBe(true);
	});

	test("preserves bold content after an empty placeholder part", () => {
		const segments = parseReasoningSegments(
			joinParts(["**Status**\n\n<!-- -->", "**Important conclusion**", "<!-- -->"]),
		);
		// A trailing bare placeholder seals the last titled step without adding
		// a phantom untitled step; placeholder-only bodies normalize to "".
		expect(titles(segments)).toEqual(["Status", "Important conclusion"]);
		expect(segments[0]).toEqual({ title: "Status", body: "", isEmpty: true });
		expect(segments[1]).toEqual({ title: "Important conclusion", body: "", isEmpty: true });
	});

	test("does not treat inline-bold `**Result:** keep this` as a title", () => {
		const segments = parseReasoningSegments(
			joinParts(["**Status**\n\n<!-- -->", "**Result:** keep **this**"]),
		);
		expect(titles(segments)).toEqual(["Status", null]);
		expect(segments[1].body).toBe("**Result:** keep **this**");
		expect(segments[1].isEmpty).toBe(false);
	});

	test("keeps title after a leading empty part", () => {
		const segments = parseReasoningSegments(
			joinParts(["**Status**\n\n<!-- -->", "**Checking tests**\n\nTests passed"]),
		);
		expect(segments).toEqual([
			{ title: "Status", body: "", isEmpty: true },
			{ title: "Checking tests", body: "Tests passed", isEmpty: false },
		]);
	});

	test("drops empty part after real content (marked empty)", () => {
		const segments = parseReasoningSegments(
			joinParts(["**Plan**\n\ndone", "**Checking tests**\n\n<!-- -->"]),
		);
		expect(segments).toEqual([
			{ title: "Plan", body: "done", isEmpty: false },
			{ title: "Checking tests", body: "", isEmpty: true },
		]);
	});

	test("preserves a literal <!-- --> inside real prose", () => {
		const segments = parseReasoningSegments("**Plan**\n\nUse `<!-- -->` in JSX.");
		expect(segments).toEqual([{ title: "Plan", body: "Use `<!-- -->` in JSX.", isEmpty: false }]);
	});

	test("falls back to a single untitled step when no header is present", () => {
		const segments = parseReasoningSegments("High level reasoning without a header");
		expect(segments).toEqual([
			{ title: null, body: "High level reasoning without a header", isEmpty: false },
		]);
		expect(hasStructuredReasoning(segments)).toBe(false);
	});

	test("leading untitled body followed by titled steps", () => {
		const segments = parseReasoningSegments(
			joinParts(["Some preamble thought.", "**Digging in**\n\nlooked at the code"]),
		);
		expect(titles(segments)).toEqual([null, "Digging in"]);
		expect(segments[0].body).toBe("Some preamble thought.");
		expect(hasStructuredReasoning(segments)).toBe(true);
	});

	test("groups multiple body paragraphs under one title", () => {
		const segments = parseReasoningSegments(
			"**Analysis**\n\nFirst paragraph.\n\nSecond paragraph.",
		);
		expect(segments).toEqual([
			{ title: "Analysis", body: "First paragraph.\n\nSecond paragraph.", isEmpty: false },
		]);
	});

	test("handles CRLF blank-line separators", () => {
		const segments = parseReasoningSegments("**Step one**\r\n\r\nbody one\r\n\r\n**Step two**");
		expect(titles(segments)).toEqual(["Step one", "Step two"]);
	});

	test("empty input yields no segments", () => {
		expect(parseReasoningSegments("")).toEqual([]);
		expect(hasStructuredReasoning([])).toBe(false);
	});
});
