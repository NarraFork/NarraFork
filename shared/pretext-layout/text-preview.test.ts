import { describe, expect, test } from "bun:test";
import type { MeasuredElement } from "./prepared-block";
import { constrainTextPreview, selectTextPreview, TEXT_PREVIEW_MAX_CHARS } from "./text-preview";

function measured(heights: number[]): MeasuredElement {
	let top = 0;
	return {
		height: heights.reduce((sum, h) => sum + h, 0),
		contentWidth: 300,
		usedWidth: 300,
		blocks: heights.map((height) => ({
			kind: "fixed",
			height,
			tag: "test",
			marginTop: 0,
			contentLeft: 0,
			quoteRailLefts: [],
			markerText: null,
			markerLeft: null,
			markerClassName: null,
		})),
		frame: {
			contentHeight: heights.reduce((sum, h) => sum + h, 0),
			usedWidth: 300,
			blocks: heights.map((height, index) => {
				const frame = { index, top, height, usedWidth: 300 };
				top += height;
				return frame;
			}),
		},
	};
}
const metadata = {
	sourceText: "full",
	previewText: "full",
	charCount: 4,
	expanded: false,
	direction: "head" as const,
	plainText: false,
	sourceStart: 0,
};

describe("bounded text source selection", () => {
	test("short input is unchanged and expanded returns the complete original", () => {
		expect(selectTextPreview("hello")).toEqual({ text: "hello", start: 0, truncated: false });
		const source = "abc".repeat(9000);
		expect(selectTextPreview(source, true).text).toBe(source);
		expect(selectTextPreview(source).text.length).toBe(TEXT_PREVIEW_MAX_CHARS);
		expect(selectTextPreview(source, false, "tail").start).toBe(
			source.length - TEXT_PREVIEW_MAX_CHARS,
		);
	});
	test("head and tail never split a surrogate pair", () => {
		const source = `${"x".repeat(TEXT_PREVIEW_MAX_CHARS - 1)}😀`;
		expect(selectTextPreview(source).text).toBe("x".repeat(TEXT_PREVIEW_MAX_CHARS - 1));
		const tail = `😀${"x".repeat(TEXT_PREVIEW_MAX_CHARS - 1)}`;
		expect(selectTextPreview(tail, false, "tail").text).toBe(
			"x".repeat(TEXT_PREVIEW_MAX_CHARS - 1),
		);
	});
});

describe("visible-only frame model", () => {
	test("short bodies reserve no button or whitespace", () => {
		const result = constrainTextPreview(measured([20]), metadata, 240, 17);
		expect(result.height).toBe(20);
		expect(result.textPreview?.buttonHeight).toBe(0);
		expect(result.textPreview?.clipped).toBe(false);
	});
	test("head drops hidden blocks and crops the intersecting block", () => {
		const result = constrainTextPreview(measured([100, 500, 100]), metadata, 240, 17);
		expect(result.height).toBe(261);
		expect(result.blocks).toHaveLength(2);
		expect(result.frame.blocks.map((f) => f.height)).toEqual([100, 140]);
		expect(result.frame.blocks[1]?.renderLimited).toBe(true);
	});
	test("tail carries the local render offset and newest block", () => {
		const result = constrainTextPreview(
			measured([100, 500, 100]),
			{ ...metadata, direction: "tail" },
			240,
			17,
		);
		expect(result.blocks).toHaveLength(2);
		expect(result.frame.blocks[0]?.renderOffset).toBe(360);
		expect(result.frame.blocks[0]?.height).toBe(140);
		expect(result.frame.blocks[1]?.top).toBe(140);
	});
	test("expanded restores full geometry and always leaves a collapse button", () => {
		const result = constrainTextPreview(
			measured([100, 500]),
			{ ...metadata, expanded: true },
			240,
			17,
		);
		expect(result.frame.contentHeight).toBe(600);
		expect(result.height).toBe(621);
		expect(result.frame.blocks[1]?.renderLimited).toBe(false);
		const shortened = constrainTextPreview(
			measured([20]),
			{ ...metadata, expanded: true },
			240,
			17,
		);
		expect(shortened.textPreview?.buttonHeight).toBe(21);
	});
});
