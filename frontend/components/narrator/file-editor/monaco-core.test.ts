import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { editor, IPosition } from "monaco-editor/editor/editor.api";
import { resolveMonacoLanguage } from "./monaco-languages";
import { loadMonaco } from "./monaco-loader";
import {
	MonacoNavigationHighlight,
	monacoFileSelection,
	monacoFileSelectionRange,
	monacoNavigationLines,
} from "./monaco-navigation";
import {
	MONACO_LONG_LINE_LIMIT,
	MonacoLongLineTracker,
	monacoEditorOptions,
} from "./monaco-profile";

function textModel(text: string) {
	const lines = text.split("\n");
	return {
		getLineCount: () => lines.length,
		getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
		getOffsetAt: (p: IPosition) =>
			lines.slice(0, p.lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + p.column - 1,
		getPositionAt: (offset: number) => {
			let line = 0;
			while (line < lines.length - 1 && offset > lines[line].length) {
				offset -= lines[line].length + 1;
				line++;
			}
			return { lineNumber: line + 1, column: offset + 1 };
		},
	};
}
const range = (startLineNumber: number, endLineNumber: number, startColumn = 1, endColumn = 1) => ({
	startLineNumber,
	startColumn,
	endLineNumber,
	endColumn,
});
function change(startLine: number, endLine: number, text: string): editor.IModelContentChange {
	return { range: range(startLine, endLine), rangeLength: 0, rangeOffset: 0, text };
}
function event(
	changes: editor.IModelContentChange[],
	isFlush = false,
): editor.IModelContentChangedEvent {
	return {
		changes,
		isFlush,
		isUndoing: false,
		isRedoing: false,
		eol: "\n",
		versionId: 2,
		isEolChange: false,
		detailedReasonsChangeLengths: [],
	};
}

describe("Monaco browser boundary and profile", () => {
	test("component can be imported in pure Bun without evaluating Monaco CSS", async () => {
		const { MonacoEditor } = await import("./MonacoEditor");
		expect(typeof MonacoEditor).toBe("function");
		if (typeof window === "undefined")
			await expect(loadMonaco()).rejects.toThrow("requires a browser");
	});
	test("creation settings bound rendering and retain tokenization, without semantic services", () => {
		const options = monacoEditorOptions(false, true, false);
		expect(options.model).toBeNull();
		expect(options.largeFileOptimizations).toBe(false);
		expect(options.stopRenderingLineAfter).toBe(MONACO_LONG_LINE_LIMIT);
		expect(options.maxTokenizationLineLength).toBe(MONACO_LONG_LINE_LIMIT);
		expect(options.wordWrap).toBe("on");
		expect(options.wordBasedSuggestions).toBe("off");
		expect(options["semanticHighlighting.enabled"]).toBe(false);
		expect(monacoEditorOptions(true, true, true).wordWrap).toBe("off");
		expect(monacoEditorOptions(true, false, false).readOnly).toBe(true);
	});
	test("large-file configuration precedes model construction, hot edits never flatten text", async () => {
		const source = await readFile(new URL("./MonacoEditor.tsx", import.meta.url), "utf8");
		expect(source.indexOf("api.editor.create(host")).toBeLessThan(
			source.indexOf("api.editor.createModel("),
		);
		expect(source).not.toContain("model.getValue()");
		expect(source).not.toContain("model.getLinesContent()");
		expect(source).toContain("getValueLength()");
		const loader = await readFile(new URL("./monaco-loader.ts", import.meta.url), "utf8");
		expect(loader).not.toContain("register.all");
		expect(loader).toContain('new URL("./monaco.worker.ts", import.meta.url)');
		expect(loader).not.toContain("cdn");
	});
});

describe("language migration", () => {
	for (const [path, language] of [
		["组件.tsx", "typescript"],
		["C:\\demo\\app.cjs", "javascript"],
		["app.py", "python"],
		["README.md", "markdown"],
		["settings.jsonc", "json"],
		["Dockerfile.prod", "dockerfile"],
		[".bashrc", "shell"],
		["readme.txt", "plaintext"],
		["config.yml", "yaml"],
		["index.mdx", "mdx"],
	]) {
		test(`${path} maps to ${language}`, () =>
			expect(resolveMonacoLanguage(path)).toEqual({ language, languageSupported: true }));
	}
	test("unknown grammars are explicitly unsupported, not silently treated as supported text", () => {
		expect(resolveMonacoLanguage("custom.unknown")).toEqual({
			language: "plaintext",
			languageSupported: false,
		});
		expect(resolveMonacoLanguage("Cargo.toml").languageSupported).toBe(false);
	});
});

describe("navigation and selection", () => {
	test("clamps stale, reversed and UTF-16 coordinates without allocating document text", () => {
		const model = textModel("中文🙂\nend");
		expect(monacoFileSelectionRange(model, range(99, -1, 99, -2))).toEqual(range(1, 2, 1, 4));
		expect(monacoFileSelectionRange(model, range(1, 1, 3, 5))).toEqual(range(1, 1, 3, 5));
		expect(monacoFileSelectionRange(model, range(Number.NaN, 2, Number.NaN, 999))).toEqual(
			range(1, 2, 1, 4),
		);
	});
	test("exclusive end at next line start excludes next gutter and boundary", () => {
		expect(monacoNavigationLines(range(2, 5))).toEqual({ first: 2, last: 4 });
		expect(monacoNavigationLines(range(2, 2))).toEqual({ first: 2, last: 2 });
		expect(monacoNavigationLines(range(2, 5, 1, 2))).toEqual({ first: 2, last: 5 });
	});
	test("a cursor is not a selected file reference", () => {
		expect(monacoFileSelection(range(2, 2, 3, 3))).toBeNull();
		expect(monacoFileSelection(null)).toBeNull();
		expect(monacoFileSelection(range(1, 3))).toEqual(range(1, 3));
	});
	test("300k-line references use at most four decorations, no selection mutation", () => {
		const collections: { decorations: editor.IModelDeltaDecoration[] }[] = [];
		const view = {
			createDecorationsCollection: () => {
				const state = { decorations: [] as editor.IModelDeltaDecoration[] };
				collections.push(state);
				return {
					set: (items: editor.IModelDeltaDecoration[]) => {
						state.decorations = items;
					},
					getRange: () => state.decorations[0]?.range ?? null,
					clear: () => {
						state.decorations = [];
					},
				};
			},
		} as unknown as editor.IStandaloneCodeEditor;
		const highlight = new MonacoNavigationHighlight(view);
		highlight.set(range(1, 300_000, 1, 2));
		expect(collections.reduce((n, state) => n + state.decorations.length, 0)).toBe(4);
		expect(collections[1].decorations[0].options.marginClassName).toBe(
			"nf-monaco-navigation-gutter",
		);
		highlight.set(null);
		expect(collections.every((state) => state.decorations.length === 0)).toBe(true);
	});
});

describe("incremental long-line budget", () => {
	test("typing inspects only changed lines, not 300k untouched lines", () => {
		let reads = 0;
		const model = {
			getLineCount: () => 300_000,
			getLineLength: () => {
				reads++;
				return 30;
			},
		};
		const tracker = new MonacoLongLineTracker(model);
		expect(reads).toBe(300_000);
		reads = 0;
		tracker.update(event([change(150_000, 150_000, "x")]));
		expect(reads).toBe(1);
		expect(tracker.hasLongLine).toBe(false);
	});
	test("1MiB lines are detected and removal restores wrapping eligibility", () => {
		let lengths = [10, 1024 * 1024, 20];
		const tracker = new MonacoLongLineTracker({
			getLineCount: () => lengths.length,
			getLineLength: (line) => lengths[line - 1],
		});
		expect(tracker.hasLongLine).toBe(true);
		lengths = [10, 20];
		tracker.update(event([change(2, 3, "")]));
		expect(tracker.hasLongLine).toBe(false);
		lengths = [10, MONACO_LONG_LINE_LIMIT + 1, 20];
		tracker.update(event([change(2, 2, `${"x".repeat(MONACO_LONG_LINE_LIMIT + 1)}\n`)]));
		expect(tracker.hasLongLine).toBe(true);
	});
	test("multi-cursor line shifts keep existing long lines and flush resets them", () => {
		let lengths = [1, 20_000, 1, 1];
		const tracker = new MonacoLongLineTracker({
			getLineCount: () => lengths.length,
			getLineLength: (line) => lengths[line - 1],
		});
		lengths = [1, 1, 20_000, 1, 1, 1];
		tracker.update(event([change(4, 4, "\n"), change(1, 1, "\n")]));
		expect(tracker.hasLongLine).toBe(true);
		lengths = [1];
		tracker.update(event([], true));
		expect(tracker.hasLongLine).toBe(false);
	});
});
