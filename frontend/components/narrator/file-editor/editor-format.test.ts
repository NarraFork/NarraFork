import { expect, test } from "bun:test";
import type { editor } from "monaco-editor/editor/editor.api";
import { EditorFormatHistory } from "./editor-format";
import {
	type EditorEolTag,
	eolBytes,
	eolTags,
	spliceEols,
	tagBlock,
	uniformEols,
} from "./editor-format-rope";

test("persistent compact tags match random splices and retain every old root", () => {
	let seed = 271828;
	const random = (n: number) => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed % n;
	};
	let tags: EditorEolTag[] = Array.from({ length: 100_000 }, () => (random(3) + 1) as EditorEolTag),
		root = tagBlock(Uint8Array.from(tags));
	const original = root,
		originalTags = tags.slice();
	for (let i = 0; i < 3000; i++) {
		const start = random(tags.length + 1),
			removed = Math.min(random(20), tags.length - start),
			count = random(20),
			tag = (random(3) + 1) as EditorEolTag;
		const prior = root,
			before = tags;
		root = spliceEols(root, start, removed, count, tag);
		tags = before.slice();
		tags.splice(start, removed, ...Array.from({ length: count }, () => tag));
		if (i % 100 === 0) {
			expect([...eolTags(prior)]).toEqual(before);
			expect([...eolTags(root)]).toEqual(tags);
		}
		expect(root.height).toBeLessThan(40);
	}
	const skew = (root: typeof original): number =>
		root.kind === "branch"
			? Math.max(Math.abs(root.left.height - root.right.height), skew(root.left), skew(root.right))
			: 0;
	expect(skew(root)).toBeLessThan(2);
	expect([...eolTags(original)]).toEqual(originalTags);
	expect(eolBytes(original)).toBeLessThan(150_000);
});
const change = (
	start: number,
	end: number,
	text: string,
	rangeOffset = start,
): editor.IModelContentChange => ({
	range: { startLineNumber: start, endLineNumber: end, startColumn: 1, endColumn: 1 },
	rangeOffset,
	rangeLength: 1,
	text,
});
const event = (changes: editor.IModelContentChange[], undo = false, redo = false) =>
	({ changes, isUndoing: undo, isRedoing: redo }) as editor.IModelContentChangedEvent;
test("same tick multi-cursor, undo immediately, branch cannot reuse abandoned redo root", () => {
	const original = tagBlock(Uint8Array.of(2, 1, 3)),
		history = new EditorFormatHistory(original, 1, 1);
	history.change(event([change(1, 2, ""), change(3, 4, "\n\n", 9)]), 2, 3);
	expect([...eolTags(history.root)]).toEqual([1, 1, 1]);
	history.change(event([], true), 1, 3);
	expect(history.root).toBe(original);
	history.change(event([], false, true), 2, 3);
	expect([...eolTags(history.root)]).toEqual([1, 1, 1]);
	history.change(event([], true), 1, 3);
	history.change(event([change(2, 3, "\n")]), 3, 3);
	expect(() => history.change(event([], false, true), 2, 3)).toThrow(
		"EDITOR_FORMAT_UNDO_UNAVAILABLE",
	);
});
test("budget-crossing edit preserves full current root before disabling history", () => {
	const history = new EditorFormatHistory(tagBlock(Uint8Array.of(2, 3)), 1, 1, {
		bytes: 8 * 1024 * 1024,
		roots: 1,
	});
	history.change(event([change(1, 2, "\n\n")]), 2, 3);
	expect([...eolTags(history.root)]).toEqual([1, 1, 3]);
	expect(history.protected).toBe(true);
	expect(() => history.change(event([], true), 1, 2)).toThrow("EDITOR_FORMAT_UNDO_UNAVAILABLE");
});
test("actual 50k history root limit protects the crossing edit without duplicating a uniform root", () => {
	const root = uniformEols(2, 1),
		history = new EditorFormatHistory(root, 1, 2);
	for (let i = 2; i <= 50_000; i++) history.change(event([change(1, 1, "text")]), i, 1);
	expect(history.protected).toBe(false);
	expect(history.bytes).toBeLessThan(8 * 1024 * 1024);
	history.change(event([change(1, 1, "\n")]), 50_001, 2);
	expect(history.protected).toBe(true);
	expect([...eolTags(history.root)]).toEqual([2, 2]);
});
test("actual 8MiB sidecar history budget keeps complete current mixed format", () => {
	const expected = Uint8Array.from({ length: 100_000 }, (_, i) => (i % 3) + 1),
		history = new EditorFormatHistory(tagBlock(expected), 1, 1);
	let edits = 0;
	while (!history.protected && edits < 30_000) {
		const index = (edits * 7919) % expected.length;
		expected[index] = 1;
		history.change(event([change(index + 1, index + 2, "\n")]), ++edits + 1, expected.length);
	}
	expect(history.protected).toBe(true);
	expect(edits).toBeLessThan(30_000);
	expect(Uint8Array.from(eolTags(history.root))).toEqual(expected);
});
test("uniform million newlines is constant storage, text-only edits share root", () => {
	const root = uniformEols(2, 1_000_000),
		history = new EditorFormatHistory(root, 1, 2);
	for (let i = 2; i < 100; i++) history.change(event([change(1, 1, "text")]), i, root.count);
	expect(history.root).toBe(root);
	expect(eolBytes(root)).toBe(64);
	expect(history.bytes).toBeLessThan(6000);
});
