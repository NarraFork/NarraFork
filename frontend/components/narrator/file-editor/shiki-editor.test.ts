import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { history, undo, undoDepth } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { FILE_HIGHLIGHT_OPTIONS, MAX_FILE_HIGHLIGHT_CODE_CHARS } from "../highlight-cache";
import {
	type EditorTokenLoader,
	ShikiEditorHighlighter,
	setShikiDecorations,
	shikiDecorations,
	tokensToDecorations,
} from "./shiki-editor";

let core: Awaited<ReturnType<typeof createHighlighterCore>>;
beforeAll(async () => {
	core = await createHighlighterCore({
		engine: createOnigurumaEngine(import("shiki/wasm")),
		langs: [import("shiki/langs/typescript.mjs"), import("shiki/langs/json.mjs")],
		themes: [
			import("shiki/themes/github-dark-default.mjs"),
			import("shiki/themes/github-light-default.mjs"),
		],
	});
});
afterAll(() => core.dispose());

const active: ShikiEditorHighlighter[] = [];
afterEach(() => {
	for (const highlighter of active.splice(0)) highlighter.destroy();
});

const realLoader: EditorTokenLoader = async (code, language, theme) =>
	core.codeToTokens(code, { lang: language, theme, ...FILE_HIGHLIGHT_OPTIONS }).tokens;
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function fakeView(code: string) {
	let highlighter: ShikiEditorHighlighter | undefined;
	let changes = 0;
	let state = EditorState.create({ doc: code, extensions: [history(), shikiDecorations] });
	const view: Pick<EditorView, "state" | "dispatch"> = {
		get state() {
			return state;
		},
		dispatch: ((...specs: (Transaction | TransactionSpec)[]) => {
			const transaction = specs[0] instanceof Transaction ? specs[0] : state.update(...specs);
			state = transaction.state;
			if (transaction.docChanged) changes++;
			highlighter?.update(transaction);
		}) as EditorView["dispatch"],
	};
	return {
		view,
		changes: () => changes,
		attach(loader = realLoader, language = "typescript", theme = "github-dark-default") {
			highlighter?.destroy();
			highlighter = new ShikiEditorHighlighter(view, {
				language,
				theme,
				loadTokens: loader,
				delayMs: 0,
			});
			active.push(highlighter);
			return highlighter;
		},
	};
}

function marks(decorations: DecorationSet) {
	const result: { from: number; to: number; style: string }[] = [];
	for (const cursor = decorations.iter(); cursor.value; cursor.next()) {
		result.push({ from: cursor.from, to: cursor.to, style: cursor.value.spec.attributes.style });
	}
	return result;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const SOURCE = 'const value = "中文\\n";\n/* comment\n * continued */\nconsole.log(value);\n';

describe("Shiki editor decorations", () => {
	test("real grammar produces multiple colours for source beyond the chat preview cap", async () => {
		const source = SOURCE.repeat(350);
		expect(source.length).toBeGreaterThan(20_000);
		const { view, attach, changes } = fakeView(source);
		attach();
		await nextTick();
		const ranges = marks(view.state.field(shikiDecorations));
		expect(ranges.length).toBeGreaterThan(100);
		expect(new Set(ranges.map((range) => range.style)).size).toBeGreaterThan(2);
		expect(view.state.doc.toString()).toBe(source);
		expect(changes()).toBe(0);
	});

	test("UTF-16, tabs, CRLF, multiline comments and the trailing blank line stay aligned", () => {
		const doc = EditorState.create({ doc: '\tconst name = "中文𝄞";\r\n/* a\r\nb */\r\n' }).doc;
		const tokens = core.codeToTokens(doc.toString(), {
			lang: "typescript",
			theme: "github-dark-default",
		}).tokens;
		const ranges = marks(tokensToDecorations(doc, tokens));
		expect(ranges.length).toBeGreaterThan(4);
		expect(ranges.map((range) => doc.sliceString(range.from, range.to)).join("")).toBe(
			doc.toString().replaceAll("\n", ""),
		);
		expect(ranges.every((range) => range.to <= doc.length)).toBe(true);
	});

	test("font styles apply without treating Shiki's unset flag as all styles", () => {
		const doc = EditorState.create({ doc: "abc" }).doc;
		const ranges = marks(
			tokensToDecorations(doc, [
				[
					{ content: "a", fontStyle: 1 | 2 | 4 },
					{ content: "b", fontStyle: -1, color: "#123456" },
					{ content: "c" },
				],
			]),
		);
		expect(ranges).toHaveLength(2);
		expect(ranges[0].style).toBe("font-style:italic;font-weight:bold;text-decoration:underline");
		expect(ranges[1].style).toBe("color:#123456");
	});

	test("rejects mismatched tokens instead of colouring unrelated text", () => {
		const doc = EditorState.create({ doc: "abc\nx" }).doc;
		expect(tokensToDecorations(doc, [[{ content: "xyz" }], [{ content: "x" }]]).size).toBe(0);
		expect(tokensToDecorations(doc, [[{ content: "abc" }]]).size).toBe(0);
	});

	test("maps marks on edits while highlight transactions preserve selection and undo", async () => {
		const fixture = fakeView("const count = 1;");
		fixture.attach();
		await nextTick();
		fixture.view.dispatch({ changes: { from: 0, insert: "// note\n" }, selection: { anchor: 8 } });
		expect(marks(fixture.view.state.field(shikiDecorations))[0].from).toBe(8);
		const depth = undoDepth(fixture.view.state);
		await nextTick();
		expect(fixture.view.state.selection.main.anchor).toBe(8);
		expect(undoDepth(fixture.view.state)).toBe(depth);
		expect(fixture.changes()).toBe(1);
		expect(undo(fixture.view)).toBe(true);
		expect(fixture.view.state.doc.toString()).toBe("const count = 1;");
	});

	test("rejects stale effect payloads even when old and new document lengths match", () => {
		const { view } = fakeView("const a = 1;");
		const doc = view.state.doc;
		const decorations = tokensToDecorations(doc, [[{ content: doc.toString(), color: "red" }]]);
		view.dispatch({ changes: { from: 6, to: 7, insert: "b" } });
		view.dispatch({ effects: setShikiDecorations.of({ doc, decorations }) });
		expect(view.state.field(shikiDecorations).size).toBe(0);
	});
});

describe("Shiki async editor lifecycle", () => {
	test("debounces edits and does not tokenize cursor-only updates", async () => {
		const fixture = fakeView("let a = 1;");
		const requests: string[] = [];
		fixture.attach(async (code, ...rest) => {
			requests.push(code);
			return realLoader(code, ...rest);
		});
		fixture.view.dispatch({ changes: { from: 8, to: 9, insert: "2" } });
		fixture.view.dispatch({ changes: { from: 8, to: 9, insert: "3" } });
		await nextTick();
		expect(requests).toEqual(["let a = 3;"]);
		fixture.view.dispatch({ selection: { anchor: 5 } });
		await nextTick();
		expect(requests).toHaveLength(1);
	});

	test("discards a late result after editing, including equal-length replacements", async () => {
		const fixture = fakeView("const a = 1;");
		const pending = deferred<Awaited<ReturnType<EditorTokenLoader>>>();
		let signal: AbortSignal | undefined;
		fixture.attach(async (_code, _language, _theme, currentSignal) => {
			signal = currentSignal;
			return pending.promise;
		});
		await nextTick();
		fixture.view.dispatch({ changes: { from: 6, to: 7, insert: "b" } });
		expect(signal?.aborted).toBe(true);
		pending.resolve([[{ content: "const a = 1;", color: "red" }]]);
		await nextTick();
		expect(fixture.view.state.field(shikiDecorations).size).toBe(0);
		expect(fixture.view.state.doc.toString()).toBe("const b = 1;");
	});

	test("theme changes keep the document and selection but replace token colours", async () => {
		const fixture = fakeView(SOURCE);
		fixture.attach();
		await nextTick();
		const dark = marks(fixture.view.state.field(shikiDecorations));
		const doc = fixture.view.state.doc;
		fixture.view.dispatch({ selection: { anchor: 5 } });
		fixture.attach(realLoader, "typescript", "github-light-default");
		await nextTick();
		expect(marks(fixture.view.state.field(shikiDecorations))).not.toEqual(dark);
		expect(fixture.view.state.doc).toBe(doc);
		expect(fixture.view.state.selection.main.anchor).toBe(5);
		expect(fixture.changes()).toBe(0);
	});

	test("a late dark-theme result cannot overwrite a newer light-theme highlight", async () => {
		const fixture = fakeView(SOURCE);
		const pending = deferred<Awaited<ReturnType<EditorTokenLoader>>>();
		fixture.attach(() => pending.promise);
		await nextTick();
		fixture.attach(realLoader, "typescript", "github-light-default");
		await nextTick();
		const light = marks(fixture.view.state.field(shikiDecorations));
		expect(light.length).toBeGreaterThan(0);
		pending.resolve(
			await realLoader(SOURCE, "typescript", "github-dark-default", new AbortController().signal),
		);
		await nextTick();
		expect(marks(fixture.view.state.field(shikiDecorations))).toEqual(light);
	});

	test("does not dispatch after the editor unmounts", async () => {
		const fixture = fakeView(SOURCE);
		const pending = deferred<Awaited<ReturnType<EditorTokenLoader>>>();
		const highlighter = fixture.attach(() => pending.promise);
		await nextTick();
		const state = fixture.view.state;
		highlighter.destroy();
		pending.resolve(
			await realLoader(SOURCE, "typescript", "github-dark-default", new AbortController().signal),
		);
		await nextTick();
		expect(fixture.view.state).toBe(state);
	});

	test("plaintext and oversized documents stay complete without invoking Shiki", async () => {
		for (const [source, language] of [
			[SOURCE, "text"],
			["x".repeat(MAX_FILE_HIGHLIGHT_CODE_CHARS + 1), "typescript"],
		]) {
			const fixture = fakeView(source);
			let requests = 0;
			fixture.attach(async () => {
				requests++;
				return null;
			}, language);
			await nextTick();
			expect(requests).toBe(0);
			expect(fixture.view.state.doc.toString()).toBe(source);
			expect(fixture.view.state.field(shikiDecorations).size).toBe(0);
		}
	});

	test("a failed grammar load clears old colours without changing the editable buffer", async () => {
		const fixture = fakeView(SOURCE);
		fixture.attach();
		await nextTick();
		expect(fixture.view.state.field(shikiDecorations).size).toBeGreaterThan(0);
		fixture.attach(async () => {
			throw new Error("chunk unavailable");
		});
		await nextTick();
		expect(fixture.view.state.doc.toString()).toBe(SOURCE);
		expect(fixture.view.state.field(shikiDecorations).size).toBe(0);
		expect(fixture.changes()).toBe(0);
	});
});
