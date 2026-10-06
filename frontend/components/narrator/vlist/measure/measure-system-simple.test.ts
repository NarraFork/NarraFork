import { describe, expect, it } from "bun:test";
import {
	COMPACT_CARD_HEIGHT,
	MERGE_SUMMARY_CARD_HEIGHT,
	measureSystemSimpleCard,
	SEGMENT_COMPACT_CARD_HEIGHT,
	SYSTEM_SIMPLE_CARD_HEIGHTS,
	type SystemSimpleData,
	type SystemSimpleKind,
} from "./measure-system-simple";

// These cards are all single-line / clamped: every block is a PreparedFixedBlock
// with an intrinsic height, so accumulateFrame never touches pretext/canvas. No
// canvas stub required.

const D = (over: Partial<SystemSimpleData> = {}): SystemSimpleData => ({ text: "x", ...over });

describe("measureSystemSimpleCard — fixed per-kind heights", () => {
	it("compact = 25px (centered single line, py=4 + xs line 17)", () => {
		expect(COMPACT_CARD_HEIGHT).toBe(25);
		const r = measureSystemSimpleCard("compact", D(), 800);
		expect(r.height).toBe(25);
	});

	it("segment_compact = 25px (centered single line)", () => {
		expect(SEGMENT_COMPACT_CARD_HEIGHT).toBe(25);
		const r = measureSystemSimpleCard("segment_compact", D(), 800);
		expect(r.height).toBe(25);
	});

	it("merge_summary = 37px (Paper p=xs + lineClamp=1)", () => {
		expect(MERGE_SUMMARY_CARD_HEIGHT).toBe(37);
		const r = measureSystemSimpleCard("merge_summary", D(), 800);
		expect(r.height).toBe(37);
	});

	// `review_feedback` is deliberately absent: it is a `system-text` card now, because a
	// verdict plus a findings list has to wrap and to carry an action button, and this
	// module's single clamped line could express neither. Its geometry is pinned in
	// measure-system-text.test.ts instead.

	it("SYSTEM_SIMPLE_CARD_HEIGHTS lookup matches the measured height for every kind", () => {
		const kinds: SystemSimpleKind[] = ["compact", "segment_compact", "merge_summary"];
		for (const kind of kinds) {
			const r = measureSystemSimpleCard(kind, D(), 640);
			expect(r.height).toBe(SYSTEM_SIMPLE_CARD_HEIGHTS[kind]);
		}
	});
});

describe("measureSystemSimpleCard — height is independent of content", () => {
	it("height does NOT change with text length (truncate / lineClamp=1)", () => {
		const short = measureSystemSimpleCard("merge_summary", D({ text: "a" }), 800);
		const long = measureSystemSimpleCard(
			"merge_summary",
			D({ text: "a really long merge summary line ".repeat(50) }),
			800,
		);
		expect(long.height).toBe(short.height);
	});

	it("center-row height does NOT change with very long text", () => {
		const short = measureSystemSimpleCard("compact", D({ text: "compacted" }), 800);
		const long = measureSystemSimpleCard("compact", D({ text: "compacting · ".repeat(80) }), 800);
		expect(long.height).toBe(short.height);
		expect(long.height).toBe(25);
	});

	it("height does NOT change with contentWidth (full-line clamp, width-free)", () => {
		const wide = measureSystemSimpleCard("merge_summary", D({ text: "task text" }), 2000);
		const narrow = measureSystemSimpleCard("merge_summary", D({ text: "task text" }), 60);
		expect(narrow.height).toBe(wide.height);
	});

	it("height does NOT change across LOD levels", () => {
		const heights = ([1, 2, 3, 4, 5] as const).map(
			(lod) => measureSystemSimpleCard("merge_summary", D(), 800, lod).height,
		);
		expect(new Set(heights).size).toBe(1);
		expect(heights[0]).toBe(37);
	});

	it("optional flags (hasAvatar / status) are height-neutral", () => {
		const plain = measureSystemSimpleCard("merge_summary", D(), 800);
		const decorated = measureSystemSimpleCard(
			"merge_summary",
			D({ hasAvatar: true, color: "indigo" }),
			800,
		);
		expect(decorated.height).toBe(plain.height);

		const compacting = measureSystemSimpleCard("segment_compact", D({ status: "compacting" }), 800);
		const compacted = measureSystemSimpleCard("segment_compact", D({ status: "compacted" }), 800);
		expect(compacting.height).toBe(compacted.height);
	});
});

describe("measureSystemSimpleCard — block/frame shape", () => {
	it("produces exactly one PreparedFixedBlock tagged with the kind", () => {
		const r = measureSystemSimpleCard("compact", D(), 800);
		expect(r.blocks).toHaveLength(1);
		const [block] = r.blocks;
		expect(block?.kind).toBe("fixed");
		if (block?.kind === "fixed") {
			expect(block.tag).toBe("compact");
			expect(block.height).toBe(25);
		}
	});

	it("frame contentHeight equals the element height; usedWidth follows contentWidth", () => {
		const r = measureSystemSimpleCard("merge_summary", D(), 512);
		expect(r.frame.contentHeight).toBe(r.height);
		expect(r.usedWidth).toBe(512);
		expect(r.contentWidth).toBe(512);
	});

	it("carries the render payload on the block for the renderer", () => {
		const r = measureSystemSimpleCard(
			"merge_summary",
			D({ text: "do X", hasAvatar: true, color: "indigo" }),
			800,
		);
		const [block] = r.blocks;
		if (block?.kind === "fixed") {
			expect(block.data).toMatchObject({
				text: "do X",
				hasAvatar: true,
				color: "indigo",
			});
		}
	});
});
