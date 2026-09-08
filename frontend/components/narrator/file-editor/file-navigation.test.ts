import { describe, expect, test } from "bun:test";
import { history, undo, undoDepth } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { FileSelection } from "@shared/file-reference";
import { editorFileSelection, fileSelectionRange, navigateFileSelection } from "./CodeMirrorEditor";
import { fileEditorReferenceSelection } from "./FileEditorContent";
import {
	fileNavigationGutterMarker,
	fileNavigationHighlight,
	fileNavigationHighlightExtension,
	setFileNavigationHighlight,
} from "./file-navigation-highlight";
import { applyEdit, initialEditorState, saveSucceeded } from "./save-state";

const selection: FileSelection = {
	startLineNumber: 2,
	startColumn: 2,
	endLineNumber: 3,
	endColumn: 1,
};

function fakeView(source: string) {
	let state = EditorState.create({
		doc: source,
		extensions: [history(), fileNavigationHighlightExtension],
	});
	const transactions: Transaction[] = [];
	const view: Pick<EditorView, "state" | "dispatch"> = {
		get state() {
			return state;
		},
		dispatch: ((...specs: (Transaction | TransactionSpec)[]) => {
			const transaction = specs[0] instanceof Transaction ? specs[0] : state.update(...specs);
			transactions.push(transaction);
			state = transaction.state;
		}) as EditorView["dispatch"],
	};
	return { view, transactions };
}

describe("file editor navigation", () => {
	test("uses one-based UTF-16 columns and an exclusive range end", () => {
		const doc = EditorState.create({ doc: "first\n中文𝄞\nlast" }).doc;
		const range = fileSelectionRange(doc, selection);
		expect(doc.sliceString(range.main.from, range.main.to)).toBe("文𝄞\n");
		const state = EditorState.create({ doc, selection: range });
		expect(editorFileSelection(state)).toEqual(selection);
	});

	test("clamps a removed line or long column to the current buffer", () => {
		const doc = EditorState.create({ doc: "a\nb" }).doc;
		const range = fileSelectionRange(doc, { ...selection, startColumn: 80, endLineNumber: 100 });
		expect(range.main.from).toBe(doc.length);
		expect(range.main.to).toBe(doc.length);
	});

	test("a repeat navigation dispatches again without losing dirty text or undo", () => {
		const { view, transactions } = fakeView("first\nsecond\nlast");
		view.dispatch({ changes: { from: 0, insert: "dirty " } });
		const doc = view.state.doc;
		const depth = undoDepth(view.state);
		navigateFileSelection(view, selection);
		view.dispatch({ selection: { anchor: 0 } });
		navigateFileSelection(view, selection);
		expect(transactions.filter((item) => item.effects.length > 0)).toHaveLength(2);
		expect(view.state.doc).toBe(doc);
		expect(undoDepth(view.state)).toBe(depth);
		expect(editorFileSelection(view.state)).toBeNull();
		expect(view.state.selection.main.from).toBe(fileSelectionRange(doc, selection).main.from);
		expect(view.state.field(fileNavigationHighlight)?.range).toEqual({
			from: fileSelectionRange(doc, selection).main.from,
			to: fileSelectionRange(doc, selection).main.to,
		});
		expect(undo(view)).toBe(true);
		expect(view.state.doc.toString()).toBe("first\nsecond\nlast");
	});

	test("navigation markers survive clicks and real text selections without becoming excerpts", () => {
		const { view, transactions } = fakeView("first\nsecond\nlast");
		navigateFileSelection(view, selection);
		const highlight = view.state.field(fileNavigationHighlight);
		expect(highlight).not.toBeNull();
		expect(editorFileSelection(view.state)).toBeNull();
		expect(transactions.at(-1)?.annotation(Transaction.addToHistory)).toBe(false);
		view.dispatch({ selection: { anchor: 0 } });
		expect(view.state.field(fileNavigationHighlight)).toBe(highlight);
		view.dispatch({ selection: { anchor: 0, head: 3 } });
		expect(view.state.field(fileNavigationHighlight)).toBe(highlight);
		expect(editorFileSelection(view.state)).toEqual({
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 1,
			endColumn: 4,
		});
	});

	test("colors only target gutter lines and uses two non-text boundary decorations", () => {
		const { view } = fakeView("first\nsecond\nthird\nfourth\nlast");
		navigateFileSelection(view, { ...selection, startColumn: 1, endLineNumber: 5 });
		const highlight = view.state.field(fileNavigationHighlight);
		const marker = (line: number) =>
			fileNavigationGutterMarker(highlight, view.state.doc.line(line).from);
		expect(marker(1)).toBeNull();
		expect(marker(2)?.elementClass).toBe("cm-file-navigation-start");
		expect(marker(3)).not.toBeNull();
		expect(marker(3)?.toDOM).toBeUndefined();
		expect(marker(4)?.elementClass).toBe("cm-file-navigation-end");
		expect(marker(5)).toBeNull();
		expect(highlight?.boundaries.size).toBe(2);
	});

	test("exclusive ends, blank lines, point targets and stale EOF coordinates get correct boundaries", () => {
		const { view } = fakeView("first\n\nlast\n");
		for (const [target, line] of [
			[{ ...selection, startColumn: 1 }, 2],
			[{ ...selection, startColumn: 1, endLineNumber: 2 }, 2],
			[{ ...selection, startLineNumber: 99, endLineNumber: 100 }, 4],
		] as const) {
			navigateFileSelection(view, target);
			const highlight = view.state.field(fileNavigationHighlight);
			expect(highlight?.firstLine).toBe(view.state.doc.line(line).from);
			expect(highlight?.lastLine).toBe(view.state.doc.line(line).from);
			expect(highlight?.boundaries.size).toBe(1);
			expect(
				fileNavigationGutterMarker(highlight, view.state.doc.line(line).from)?.elementClass,
			).toBe("cm-file-navigation-start cm-file-navigation-end");
		}
	});

	test("markers follow edits and undo, then are replaced or explicitly cleared", () => {
		const { view } = fakeView("first\nsecond\nlast");
		navigateFileSelection(view, selection);
		view.dispatch({ changes: { from: 0, insert: "new\n" } });
		expect(view.state.field(fileNavigationHighlight)?.firstLine).toBe(view.state.doc.line(3).from);
		expect(undo(view)).toBe(true);
		expect(view.state.field(fileNavigationHighlight)?.firstLine).toBe(view.state.doc.line(2).from);
		navigateFileSelection(view, {
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 1,
			endColumn: 1,
		});
		expect(view.state.field(fileNavigationHighlight)?.firstLine).toBe(0);
		expect(
			fileNavigationGutterMarker(
				view.state.field(fileNavigationHighlight),
				view.state.doc.line(2).from,
			),
		).toBeNull();
		view.dispatch({ effects: setFileNavigationHighlight.of(null) });
		expect(view.state.field(fileNavigationHighlight)).toBeNull();
	});

	test("a huge target stores just its endpoints and uses on-demand gutter markers", () => {
		const { view } = fakeView("line\n".repeat(100_000));
		navigateFileSelection(view, {
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 100_001,
			endColumn: 1,
		});
		const highlight = view.state.field(fileNavigationHighlight);
		expect(highlight?.boundaries.size).toBe(2);
		expect(fileNavigationGutterMarker(highlight, view.state.doc.line(50_000).from)).not.toBeNull();
		expect(fileNavigationGutterMarker(highlight, view.state.doc.line(100_001).from)).toBeNull();
		expect(view.state.selection.main.empty).toBe(true);
	});

	test("cursor-only selections do not masquerade as file excerpts", () => {
		expect(editorFileSelection(EditorState.create({ doc: "a" }))).toBeNull();
	});

	test("component navigation is independent of document replacement and view creation", async () => {
		const source = await Bun.file(new URL("./CodeMirrorEditor.tsx", import.meta.url)).text();
		expect(source.match(/new EditorView\(/g)).toHaveLength(1);
		expect(source).toContain("[selection, navigationRequestId, value]");
		expect(source).toContain("}, [value]);");
		expect(source.indexOf("navigateFileSelection(view, selection)")).toBeGreaterThan(
			source.indexOf("}, [value]);"),
		);
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

	test("legacy editing uses the original saved-hash reader without reloading on origin upgrades", async () => {
		const source = await Bun.file(new URL("./FileEditorContent.tsx", import.meta.url)).text();
		expect(source).toContain('referenceOriginRef.current || deviceId !== "local"');
		expect(source).toContain("/fs/edit-source?path=");
		expect(source).toContain("{ signal: controller.signal }");
		expect(source).toContain("}, [deviceId, filePath, narratorId, setState]);");
		expect(source).toContain("initialEditorState(editorText(res.content), res.hash)");
	});

	test("publishes only the saved hash and flags an unsaved selection", () => {
		const saved = initialEditorState("saved", "saved-hash");
		const dirty = applyEdit(saved, "unsaved");
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
