import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { nativeDocumentCaretOffset } from "./document-caret";

function setup() {
	const { document } = parseHTML(
		'<html><body><div id="root"><span data-source-start="500" data-source-end="509">ab😀cdאבג</span><span data-source-start="520" data-source-end="524"><span data-source-start="521" data-source-end="523">中文</span></span></div><input id="outside" /></body></html>',
	);
	const root = document.getElementById("root");
	if (!root) throw new Error("missing root");
	return {
		document,
		root,
		native: document as unknown as {
			caretPositionFromPoint?: (
				x: number,
				y: number,
			) => { offsetNode: Node; offset: number } | null;
			caretRangeFromPoint?: (
				x: number,
				y: number,
			) => { startContainer: Node; startOffset: number } | null;
		},
	};
}

describe("native visible glyph source-offset selection", () => {
	test("uses native UTF-16 caret offsets for emoji/bidi glyphs instead of worker logical x", () => {
		const { root, native } = setup();
		const text = root.firstElementChild?.firstChild;
		if (!text) throw new Error("missing visible text");
		native.caretPositionFromPoint = () => ({ offsetNode: text, offset: 4 });
		expect(nativeDocumentCaretOffset(root, 180, 10)).toBe(504);
		native.caretPositionFromPoint = () => ({ offsetNode: text, offset: 8 });
		expect(nativeDocumentCaretOffset(root, 10, 10)).toBe(508);
	});
	test("nested token/tab fragments map through their own exact raw source start", () => {
		const { root, native } = setup();
		const inner = root.querySelector("[data-source-start='521']");
		if (!inner?.firstChild) throw new Error("missing nested fragment");
		native.caretPositionFromPoint = () => ({ offsetNode: inner.firstChild as Node, offset: 1 });
		expect(nativeDocumentCaretOffset(root, 50, 10)).toBe(522);
	});
	test("Range-only browsers have the same source mapping, and outside/input hits are ignored", () => {
		const { document, root, native } = setup();
		const text = root.firstElementChild?.firstChild;
		if (!text) throw new Error("missing visible text");
		native.caretRangeFromPoint = () => ({ startContainer: text, startOffset: 5 });
		expect(nativeDocumentCaretOffset(root, 30, 10)).toBe(505);
		const outside = document.getElementById("outside");
		if (!outside) throw new Error("missing input");
		native.caretRangeFromPoint = () => ({ startContainer: outside, startOffset: 0 });
		expect(nativeDocumentCaretOffset(root, 30, 10)).toBeUndefined();
	});
	test("unsupported native APIs leave the explicit worker-grapheme fallback available", () => {
		const { root } = setup();
		expect(nativeDocumentCaretOffset(root, 10, 10)).toBeUndefined();
	});
});
