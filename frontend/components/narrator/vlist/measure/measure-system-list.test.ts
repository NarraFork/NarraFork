import { describe, expect, it } from "bun:test";
import {
	KNOWLEDGE_HINT_BASE_HEIGHT,
	KNOWLEDGE_HINT_HEIGHT_PER_ENTRY,
	KNOWLEDGE_HINT_TAG,
	type KnowledgeHintData,
	knowledgeHintHeight,
	measureKnowledgeHint,
} from "./measure-system-list";

// knowledge_hint is a heading line + N truncated entry lines. Every line is
// clamped to a single line, so the height is a pure linear function of N and the
// single block is a PreparedFixedBlock with intrinsic height — accumulateFrame
// never touches pretext/canvas. No canvas stub required.

const entry = (i: number) => ({
	entryId: `e${i}`,
	title: `Entry ${i}`,
	summary: `Summary for entry ${i}`,
});

const D = (n: number, over: Partial<KnowledgeHintData> = {}): KnowledgeHintData => ({
	heading: `Referenced ${n} knowledge entries`,
	entries: Array.from({ length: n }, (_, i) => entry(i)),
	...over,
});

describe("measureKnowledgeHint — linear height in entry count", () => {
	it("N=0 → base height only (padding×2 + heading line) = 37px", () => {
		expect(KNOWLEDGE_HINT_BASE_HEIGHT).toBe(37);
		const r = measureKnowledgeHint(D(0), 800);
		expect(r.height).toBe(37);
	});

	it("N=1 → base + one entry row (line 17 + gap 2) = 56px", () => {
		expect(KNOWLEDGE_HINT_HEIGHT_PER_ENTRY).toBe(19);
		const r = measureKnowledgeHint(D(1), 800);
		expect(r.height).toBe(56);
	});

	it("N=2 → 37 + 2×19 = 75px", () => {
		const r = measureKnowledgeHint(D(2), 800);
		expect(r.height).toBe(75);
	});

	it("N=5 → 37 + 5×19 = 132px", () => {
		const r = measureKnowledgeHint(D(5), 800);
		expect(r.height).toBe(132);
	});

	it("height grows by exactly KNOWLEDGE_HINT_HEIGHT_PER_ENTRY (19) per entry", () => {
		for (let n = 0; n < 12; n++) {
			const cur = measureKnowledgeHint(D(n), 800).height;
			const next = measureKnowledgeHint(D(n + 1), 800).height;
			expect(next - cur).toBe(KNOWLEDGE_HINT_HEIGHT_PER_ENTRY);
			// the closed form matches the measured height
			expect(cur).toBe(knowledgeHintHeight(n));
			expect(cur).toBe(KNOWLEDGE_HINT_BASE_HEIGHT + n * KNOWLEDGE_HINT_HEIGHT_PER_ENTRY);
		}
	});

	it("knowledgeHintHeight clamps negative counts to the base height", () => {
		expect(knowledgeHintHeight(-3)).toBe(KNOWLEDGE_HINT_BASE_HEIGHT);
	});
});

describe("measureKnowledgeHint — height is independent of text content (truncate)", () => {
	it("height does NOT change with entry title length", () => {
		const short = measureKnowledgeHint(
			{ heading: "h", entries: [{ entryId: "a", title: "x" }] },
			800,
		);
		const long = measureKnowledgeHint(
			{
				heading: "h",
				entries: [{ entryId: "a", title: "a very long knowledge entry title ".repeat(40) }],
			},
			800,
		);
		expect(long.height).toBe(short.height);
		expect(long.height).toBe(56);
	});

	it("height does NOT change with heading length", () => {
		const short = measureKnowledgeHint(D(3, { heading: "h" }), 800);
		const long = measureKnowledgeHint(
			D(3, { heading: "a really long heading line ".repeat(30) }),
			800,
		);
		expect(long.height).toBe(short.height);
	});

	it("height does NOT change with summary text (Tooltip only, off-layout)", () => {
		const a = measureKnowledgeHint(
			{ heading: "h", entries: [{ entryId: "a", title: "t", summary: "s" }] },
			800,
		);
		const b = measureKnowledgeHint(
			{
				heading: "h",
				entries: [{ entryId: "a", title: "t", summary: "long summary ".repeat(100) }],
			},
			800,
		);
		expect(b.height).toBe(a.height);
	});

	it("height does NOT change with contentWidth (full-line clamp, width-free)", () => {
		const wide = measureKnowledgeHint(D(4), 2000);
		const narrow = measureKnowledgeHint(D(4), 60);
		expect(narrow.height).toBe(wide.height);
	});

	it("height does NOT change across LOD levels", () => {
		const heights = ([1, 2, 3, 4, 5, 6] as const).map(
			(lod) => measureKnowledgeHint(D(3), 800, lod).height,
		);
		expect(new Set(heights).size).toBe(1);
		expect(heights[0]).toBe(knowledgeHintHeight(3));
	});

	it("entries with only an entryId (no title) measure the same as titled ones", () => {
		const titled = measureKnowledgeHint(D(3), 800);
		const idOnly = measureKnowledgeHint(
			{ heading: "h", entries: [{ entryId: "a" }, { entryId: "b" }, { entryId: "c" }] },
			800,
		);
		expect(idOnly.height).toBe(titled.height);
	});
});

describe("measureKnowledgeHint — block/frame shape", () => {
	it("produces exactly one PreparedFixedBlock tagged knowledge_hint", () => {
		const r = measureKnowledgeHint(D(2), 800);
		expect(r.blocks).toHaveLength(1);
		const [block] = r.blocks;
		expect(block?.kind).toBe("fixed");
		if (block?.kind === "fixed") {
			expect(block.tag).toBe(KNOWLEDGE_HINT_TAG);
			expect(block.height).toBe(75);
		}
	});

	it("frame contentHeight equals the element height; usedWidth follows contentWidth", () => {
		const r = measureKnowledgeHint(D(2), 512);
		expect(r.frame.contentHeight).toBe(r.height);
		expect(r.usedWidth).toBe(512);
		expect(r.contentWidth).toBe(512);
	});

	it("carries the heading + entries payload on the block for the renderer", () => {
		const r = measureKnowledgeHint(
			{
				heading: "Referenced 2 entries",
				entries: [
					{ entryId: "k1", title: "Alpha", summary: "First" },
					{ entryId: "k2", title: "Beta" },
				],
			},
			800,
		);
		const [block] = r.blocks;
		if (block?.kind === "fixed") {
			expect(block.data?.heading).toBe("Referenced 2 entries");
			expect(block.data?.entries).toEqual([
				{ entryId: "k1", title: "Alpha", summary: "First" },
				{ entryId: "k2", title: "Beta", summary: undefined },
			]);
		}
	});
});
