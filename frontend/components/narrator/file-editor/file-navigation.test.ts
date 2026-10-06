import { describe, expect, test } from "bun:test";
import type { FileSelection } from "@shared/file-reference";
import type { editor, IPosition, IRange } from "monaco-editor/editor/editor.api";
import { fileEditorReferenceSelection } from "./FileEditorContent";
import {
	MonacoNavigationHighlight,
	monacoFileSelection,
	monacoFileSelectionRange,
	monacoNavigationLines,
} from "./monaco-navigation";
import { applyEdit, initialEditorState, saveSucceeded } from "./save-state";

const selection: FileSelection = {
	startLineNumber: 2,
	startColumn: 2,
	endLineNumber: 3,
	endColumn: 1,
};
function model(source: string) {
	const lines = source.split("\n");
	const starts = [0];
	for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1);
	return {
		getLineCount: () => lines.length,
		getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
		getOffsetAt: (position: IPosition) => starts[position.lineNumber - 1] + position.column - 1,
		getPositionAt: (offset: number): IPosition => {
			let line = lines.length - 1;
			while (line > 0 && starts[line] > offset) line--;
			return { lineNumber: line + 1, column: offset - starts[line] + 1 };
		},
	};
}
function fixture() {
	const collections: { items: editor.IModelDeltaDecoration[] }[] = [];
	const view = {
		createDecorationsCollection: () => {
			const state = { items: [] as editor.IModelDeltaDecoration[] };
			collections.push(state);
			return {
				set: (items: editor.IModelDeltaDecoration[]) => {
					state.items = items;
				},
				getRange: () => state.items[0]?.range ?? null,
				clear: () => {
					state.items = [];
				},
			};
		},
	} as unknown as editor.IStandaloneCodeEditor;
	return { highlight: new MonacoNavigationHighlight(view), collections };
}

describe("file editor navigation (Monaco migration)", () => {
	test("one-based UTF-16 columns retain the exact exclusive-end excerpt", () => {
		const text = "first\n中文𝄞\nlast";
		const doc = model(text);
		const range = monacoFileSelectionRange(doc, selection);
		const from = doc.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
		const to = doc.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
		expect(text.slice(from, to)).toBe("文𝄞\n");
		expect(monacoFileSelection(range)).toEqual(selection);
	});
	test("removed lines and oversized columns clamp to the current EOF", () => {
		expect(
			monacoFileSelectionRange(model("a\nb"), {
				...selection,
				startColumn: 80,
				endLineNumber: 100,
			}),
		).toEqual({ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 2 });
	});
	test("navigation does not mutate document, selection or undo history APIs", () => {
		const { highlight, collections } = fixture();
		// The fixture exposes decorations only: calling a text/selection/undo API would throw.
		highlight.set(selection);
		highlight.set(selection);
		expect(collections[0].items[0].range).toEqual(selection);
		expect(monacoFileSelection({ ...selection, endLineNumber: 2, endColumn: 2 })).toBeNull();
	});
	test("only the target gutter and two boundary lines are painted, not a text selection", () => {
		const { highlight, collections } = fixture();
		highlight.set({ ...selection, startColumn: 1, endLineNumber: 5 });
		const paint = collections[1].items;
		expect(paint).toHaveLength(3);
		expect(paint[0].range).toEqual({
			startLineNumber: 2,
			startColumn: 1,
			endLineNumber: 4,
			endColumn: 1,
		});
		expect(paint[0].options.marginClassName).toBe("nf-monaco-navigation-gutter");
		expect(paint[1].options.className).toBe("nf-monaco-navigation-start");
		expect(paint[2].options.className).toBe("nf-monaco-navigation-end");
		expect(paint.every((item) => item.options.isWholeLine)).toBe(true);
		expect(paint.every((item) => item.options.inlineClassName === undefined)).toBe(true);
	});
	test("blank lines, point references, exclusive ends and stale EOF have single boundaries", () => {
		const { highlight, collections } = fixture();
		for (const [target, line] of [
			[{ ...selection, startColumn: 1 }, 2],
			[{ ...selection, startColumn: 1, endLineNumber: 2 }, 2],
			[{ ...selection, startLineNumber: 99, endLineNumber: 100 }, 4],
		] as const) {
			const range = monacoFileSelectionRange(model("first\n\nlast\n"), target);
			highlight.set(range);
			expect(monacoNavigationLines(range)).toEqual({ first: line, last: line });
			expect(collections[1].items).toHaveLength(2);
			expect(collections[1].items[1].options.className).toBe(
				"nf-monaco-navigation-start nf-monaco-navigation-end",
			);
		}
	});
	test("refresh follows Monaco tracked edits/undo, replacement and explicit clear", () => {
		const { highlight, collections } = fixture();
		highlight.set(selection);
		// Monaco owns edit/undo mapping. Refresh must read the current tracked range, not a cached input.
		for (const delta of [1, 0]) {
			collections[0].items[0].range = {
				...selection,
				startLineNumber: 2 + delta,
				endLineNumber: 3 + delta,
			};
			highlight.refresh();
			expect(collections[1].items[0].range.startLineNumber).toBe(2 + delta);
		}
		const point: IRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
		highlight.set(point);
		expect(collections[1].items[0].range).toEqual(point);
		highlight.set(null);
		expect(collections.every((item) => item.items.length === 0)).toBe(true);
	});
	test("300k-line reference remains constant-size and excludes its exclusive final line", () => {
		const { highlight, collections } = fixture();
		highlight.set({ startLineNumber: 1, startColumn: 1, endLineNumber: 300_001, endColumn: 1 });
		expect(collections[0].items).toHaveLength(1);
		expect(collections[1].items).toHaveLength(3);
		expect(collections[1].items[0].range.endLineNumber).toBe(300_000);
		highlight.dispose();
		expect(collections.every((item) => item.items.length === 0)).toBe(true);
	});
});

describe("saved-file selection bridge", () => {
	test("selection labels retain POSIX literal backslashes but split Windows separators", () => {
		const state = initialEditorState("saved", "hash");
		expect(fileEditorReferenceSelection(state, "local", "/work/a\\b.md", selection)?.label).toBe(
			"a\\b.md",
		);
		expect(fileEditorReferenceSelection(state, "Windows", "C:\\work\\b.md", selection)?.label).toBe(
			"b.md",
		);
	});
	test("publishes only the saved hash and flags an unsaved selection", () => {
		const dirty = applyEdit(initialEditorState("saved", "saved-hash"), "unsaved");
		const reference = fileEditorReferenceSelection(dirty, "local", "/repo/a.ts", selection);
		expect(reference).toEqual({
			target: { deviceId: "local", path: "/repo/a.ts", selection },
			label: "a.ts",
			expectedHash: "saved-hash",
			dirty: true,
		});
		expect(reference).not.toHaveProperty("content");
		expect(
			fileEditorReferenceSelection(
				saveSucceeded(dirty, "unsaved", "new-hash"),
				"local",
				"/repo/a.ts",
				selection,
			)?.dirty,
		).toBe(false);
	});
	test("typing during save stays dirty even when the saved hash advances", () => {
		const state = saveSucceeded(
			applyEdit(initialEditorState("old", "hash"), "newer"),
			"new",
			"new-hash",
		);
		expect(fileEditorReferenceSelection(state, "local", "/repo/a.ts", selection)).toMatchObject({
			dirty: true,
			expectedHash: "new-hash",
		});
	});
	test("unknown versions or absent selections cannot become saved excerpts", () => {
		expect(
			fileEditorReferenceSelection(initialEditorState("new", null), "local", "/new", selection),
		).toBeNull();
		expect(
			fileEditorReferenceSelection(initialEditorState("saved", "hash"), "local", "/saved", null),
		).toBeNull();
	});
});
