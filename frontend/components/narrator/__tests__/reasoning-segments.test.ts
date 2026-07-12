import { describe, expect, test } from "bun:test";
import {
	type ContentBlockLike,
	getReasoningEncryptionState,
	groupReasoningRuns,
	hasStructuredReasoning,
	parseReasoningSegments,
	type ReasoningSegment,
	resolveReasoningRunActionIndices,
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

describe("groupReasoningRuns", () => {
	const r = (text = "**T**\n\n<!-- -->"): ContentBlockLike => ({ type: "reasoning", text });
	const think = (text = "hmm"): ContentBlockLike => ({ type: "thinking", thinking: text });
	const text = (t: string): ContentBlockLike => ({ type: "text", text: t });
	const tool = (): ContentBlockLike => ({ type: "tool_use" });

	test("merges three adjacent reasoning blocks into one terminal run", () => {
		const { runs, skip } = groupReasoningRuns([r(), r(), r()]);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toEqual({
			startIndex: 0,
			endIndex: 2,
			indices: [0, 1, 2],
			isLastContent: true,
		});
		expect([...skip]).toEqual([1, 2]);
	});

	test("reasoning split by a tool call stays as two independent runs", () => {
		const { runs, skip } = groupReasoningRuns([r(), tool(), r(), r()]);
		expect(runs).toHaveLength(2);
		expect(runs[0]).toMatchObject({ startIndex: 0, endIndex: 0, isLastContent: false });
		expect(runs[1]).toMatchObject({ startIndex: 2, endIndex: 3, isLastContent: true });
		expect([...skip]).toEqual([3]);
	});

	test("run followed by non-empty text is not the last content", () => {
		const { runs } = groupReasoningRuns([r(), r(), text("Done")]);
		expect(runs).toHaveLength(1);
		expect(runs[0].isLastContent).toBe(false);
	});

	test("run followed only by an empty text block is still the last content", () => {
		const { runs } = groupReasoningRuns([r(), text("   ")]);
		expect(runs[0].isLastContent).toBe(true);
	});

	test("merges adjacent reasoning and thinking blocks together", () => {
		const { runs, skip } = groupReasoningRuns([think(), r(), think()]);
		expect(runs).toHaveLength(1);
		expect(runs[0].indices).toEqual([0, 1, 2]);
		expect([...skip]).toEqual([1, 2]);
	});

	test("no reasoning blocks yields no runs", () => {
		const { runs, skip } = groupReasoningRuns([text("hi"), tool()]);
		expect(runs).toEqual([]);
		expect(skip.size).toBe(0);
	});

	test("two runs separated by text, first non-terminal, second terminal", () => {
		const { runs } = groupReasoningRuns([r(), text("mid"), r()]);
		expect(runs).toHaveLength(2);
		expect(runs[0].isLastContent).toBe(false);
		expect(runs[1].isLastContent).toBe(true);
	});

	test("uses complete message blocks when a rendered segment hides later tool and text", () => {
		const first = r("**First**\n\n<!-- -->");
		const { runs } = groupReasoningRuns([first], {
			originalIndices: [0],
			allBlocks: [first, tool(), text("Done")],
		});
		expect(runs).toHaveLength(1);
		expect(runs[0].isLastContent).toBe(false);
	});

	test("does not merge locally adjacent blocks that were separated in the original message", () => {
		const first = r("first");
		const second = r("second");
		const { runs, skip } = groupReasoningRuns([first, second], {
			originalIndices: [0, 2],
			allBlocks: [first, { type: "redacted_thinking" }, second],
		});
		expect(runs).toHaveLength(2);
		expect(runs[0]).toMatchObject({ indices: [0], isLastContent: false });
		expect(runs[1]).toMatchObject({ indices: [1], isLastContent: true });
		expect(skip.size).toBe(0);
	});
});

describe("resolveReasoningRunActionIndices", () => {
	test("anchors selection at the first block, rolls back to the last, and deletes descending", () => {
		expect(resolveReasoningRunActionIndices([6, 4, 5, 5])).toEqual({
			anchorIndex: 4,
			rollbackIndex: 6,
			deleteIndices: [6, 5, 4],
		});
	});
});

describe("getReasoningEncryptionState", () => {
	const encrypted = (): ContentBlockLike => ({
		type: "reasoning",
		providerMetadata: { openai: { reasoningEncryptedContent: "ciphertext" } },
	});

	test("distinguishes fully and partially encrypted reasoning runs", () => {
		expect(getReasoningEncryptionState([encrypted()])).toBe("only");
		expect(
			getReasoningEncryptionState([{ type: "reasoning", text: "visible reasoning" }, encrypted()]),
		).toBe("partial");
	});

	test("ignores encryption metadata when the same block has visible text", () => {
		expect(
			getReasoningEncryptionState([
				{
					type: "reasoning",
					text: "visible reasoning",
					providerMetadata: { openai: { reasoningEncryptedContent: "ciphertext" } },
				},
			]),
		).toBe("none");
	});
});
