import { describe, expect, it } from "bun:test";
import type {
	PreparedBlock,
	PreparedCodeBlock,
	PreparedFixedBlock,
	PreparedInlineBlock,
	PreparedUnknownBlock,
} from "./prepared-block";
import { accumulateFrame } from "./prepared-block";

const base = {
	marginTop: 0,
	contentLeft: 0,
	quoteRailLefts: [],
	markerText: null,
	markerLeft: null,
	markerClassName: null,
};

function inline(marginTop = 0): PreparedInlineBlock {
	return {
		...base,
		marginTop,
		kind: "inline",
		flow: {} as PreparedInlineBlock["flow"],
		lineHeight: 20,
		classNames: [],
		hrefs: [],
		fonts: [],
	};
}

function code(marginTop = 0): PreparedCodeBlock {
	return {
		...base,
		marginTop,
		kind: "code",
		prepared: {} as PreparedCodeBlock["prepared"],
		lineHeight: 18,
		lang: "ts",
	};
}

function fixed(marginTop = 0): PreparedFixedBlock {
	return { ...base, marginTop, kind: "fixed", height: 10, tag: "badge" };
}

function unknown(marginTop = 0): PreparedUnknownBlock {
	return { ...base, marginTop, kind: "unknown", placeholderHeight: 20, tag: "katex" };
}

describe("shared PreparedBlock frame math", () => {
	it("accumulates inline, code, fixed, and unknown blocks without DOM", () => {
		const blocks: PreparedBlock[] = [inline(2), code(3), fixed(1), unknown()];
		const frame = accumulateFrame(
			blocks,
			640,
			(block) =>
				block.kind === "inline"
					? { lineCount: 2, maxLineWidth: 240 }
					: { lineCount: 3, maxLineWidth: 180 },
			{
				codePaddingY: 4,
				codePaddingX: 8,
				codeLangExtraTop: 5,
			},
		);
		expect(frame.contentHeight).toBe(143);
		expect(frame.blocks.map((block) => [block.top, block.height])).toEqual([
			[2, 40],
			[45, 67],
			[113, 10],
			[123, 20],
		]);
		expect(frame.usedWidth).toBe(240);
	});

	it("adds quote padding only to quoted inline blocks", () => {
		const block = { ...inline(), quoteRailLefts: [10] };
		const frame = accumulateFrame([block], 320, () => ({ lineCount: 1, maxLineWidth: 100 }), {
			quotePaddingY: 6,
			quoteMarginTop: 3,
		});
		expect(frame.contentHeight).toBe(35);
	});

	it("a fixed block reports its displayWidth into usedWidth (shrink-wrap support)", () => {
		// An aspect-fitted image knows its painted width from data; without it the
		// bubble would shrink-wrap to the caption and clip the picture.
		const withWidth: PreparedFixedBlock = { ...fixed(0), displayWidth: 460 };
		const frame = accumulateFrame([withWidth], 640, () => ({ lineCount: 1, maxLineWidth: 0 }));
		expect(frame.usedWidth).toBe(460);
		expect(frame.blocks[0]?.usedWidth).toBe(460);
	});

	it("a fixed block without displayWidth contributes no width (legacy behaviour)", () => {
		const frame = accumulateFrame([fixed(0)], 640, () => ({ lineCount: 1, maxLineWidth: 0 }));
		expect(frame.usedWidth).toBe(0);
	});
});
