/// <reference types="vite/client" />
import type * as Monaco from "monaco-editor/editor/editor.api";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FixtureData, FixtureSpec } from "./smoke-monaco-large-file-data";
import type { FullFixture } from "./smoke-monaco-large-file-full";

// All non-public Monaco access is confined to this read-only test oracle. Never force
// whole-document tokenization: doing so changes the performance being measured.
interface TokenProbe {
	getCount(): number;
	getStandardTokenType(index: number): number;
	getClassName(index: number): string;
}
interface ProbeModel {
	tokenization?: { getLineTokens(line: number): TokenProbe };
}
type Handle = {
	getEditor(): Monaco.editor.IStandaloneCodeEditor | null;
	getModel(): Monaco.editor.ITextModel | null;
	undo(): void;
	redo(): void;
	focus(): void;
};
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Benchmark editor or DOM handle is unavailable");
	return value;
}
const host = required(document.getElementById("root"));
let api: typeof Monaco;
let handle: Handle;
let root: Root | undefined;
let full: FullFixture | undefined;
let fixture: FixtureData;
let spec: FixtureSpec;
let editor: Monaco.editor.IStandaloneCodeEditor;
let model: Monaco.editor.ITextModel;
let mode = "kernel";
let readyMs = 0;
let languageMs = 0;
let fetchMs = 0;
let resourceMs = 0;
let searchRequests = 0;
let metadataEvents = 0;
let metadataContainsText = false;
let renderComponent: (() => void) | undefined;
const extraModels: Monaco.editor.ITextModel[] = [];
const extraRoots: Root[] = [];
const longTasks: { start: number; duration: number }[] = [];
let phaseStart = 0;
let phaseStartLength = 0;
let inputArmed = false;
let lastKeyTime = 0;
const inputFrames: number[] = [];
const observer = new PerformanceObserver((list) => {
	for (const item of list.getEntries())
		if (longTasks.length < 2000) longTasks.push({ start: item.startTime, duration: item.duration });
});
observer.observe({ type: "longtask", buffered: true });
document.addEventListener(
	"keydown",
	(event) => {
		if (inputArmed && event.key.length === 1) {
			lastKeyTime = performance.now();
			// Two rAF callbacks bracket at least one paint opportunity. This is an upper
			// bound, not a claim that JS can directly observe compositor presentation.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => inputFrames.push(performance.now() - lastKeyTime)),
			);
		}
	},
	true,
);
const frames = async (count = 2) => {
	for (let i = 0; i < count; i++)
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const filePathFor = (language: FixtureSpec["language"]) =>
	`/bench/中文.${{ javascript: "js", typescript: "ts", json: "json", python: "py", markdown: "md" }[language]}`;
function ready(next: Handle | null) {
	if (!next) return;
	handle = next;
	editor = required(next.getEditor());
	model = required(next.getModel());
}
function tokenEvidence(blockIndex: number) {
	const startLine = fixture.firstLine + blockIndex * fixture.blockLines;
	const oracle = api.editor.tokenize(fixture.block, spec.language);
	const actual = [];
	let matching = true;
	for (let offset = 0; offset < fixture.blockLines; offset++) {
		const expected = [
			...new Set(
				(oracle[offset] ?? []).map((token) =>
					/comment/.test(token.type)
						? 1
						: /string/.test(token.type)
							? 2
							: /regexp/.test(token.type)
								? 3
								: 0,
				),
			),
		];
		const tokens = (model as unknown as ProbeModel).tokenization?.getLineTokens(startLine + offset);
		const types = tokens
			? [
					...new Set(
						Array.from({ length: tokens.getCount() }, (_, index) =>
							tokens.getStandardTokenType(index),
						),
					),
				]
			: [];
		const classes = tokens
			? [
					...new Set(
						Array.from({ length: tokens.getCount() }, (_, index) => tokens.getClassName(index)),
					),
				]
			: [];
		if (expected.some((type) => !types.includes(type))) matching = false;
		actual.push({ line: startLine + offset, expected, types, classes });
	}
	const spans = Array.from(
		document.querySelectorAll<HTMLElement>(".view-lines .view-line span[class*='mtk']"),
	).slice(0, 200);
	const colors = [
		...new Set(
			spans.filter((span) => span.textContent?.trim()).map((span) => getComputedStyle(span).color),
		),
	];
	const oracleTypes = [
		...new Set(
			oracle
				.flat()
				.map((token) => token.type)
				.filter(Boolean),
		),
	];
	const plain = actual.every(
		(line) => line.classes.length <= 1 && line.types.every((type) => type === 0),
	);
	return {
		pass: matching && !plain && colors.length > 1 && oracleTypes.length > 1,
		actual,
		colors,
		oracleTypes,
		startLine,
		visible: editor
			.getVisibleRanges()
			.some((range) => range.startLineNumber <= startLine && range.endLineNumber >= startLine),
	};
}
async function color(blockIndex: number, timeout: number, jump = true) {
	const start = performance.now();
	if (jump) editor.revealLineNearTop(fixture.firstLine + blockIndex * fixture.blockLines);
	let evidence = tokenEvidence(blockIndex);
	while ((!evidence.pass || !evidence.visible) && performance.now() - start < timeout) {
		await frames();
		evidence = tokenEvidence(blockIndex);
	}
	return { ...evidence, ms: performance.now() - start };
}
const bench = {
	async open(nextSpec: FixtureSpec, nextMode: string, gpu = false) {
		spec = nextSpec;
		mode = nextMode;
		const fetchStart = performance.now();
		fixture = await fetch(
			`/fixture?id=${encodeURIComponent(spec.id)}${mode === "full" ? "&metadata=1" : ""}`,
			{ signal: AbortSignal.timeout(30_000) },
		).then((response) => response.json());
		fetchMs = performance.now() - fetchStart;
		const start = performance.now();
		if (mode === "kernel") {
			const { loadMonaco } = await import(
				"../frontend/components/narrator/file-editor/monaco-loader"
			);
			const { loadMonacoLanguage } = await import(
				"../frontend/components/narrator/file-editor/monaco-languages"
			);
			const { monacoEditorOptions } = await import(
				"../frontend/components/narrator/file-editor/monaco-profile"
			);
			api = await loadMonaco();
			const languageStart = performance.now();
			await loadMonacoLanguage(api, filePathFor(spec.language));
			languageMs = performance.now() - languageStart;
			resourceMs = performance.now() - start;
			// Set the optimization policy BEFORE model creation, as Monaco reads the
			// global creation options when deciding whether to disable tokenization.
			editor = api.editor.create(host, {
				...monacoEditorOptions(false, false, !!spec.longLine),
				theme: "vs-dark",
				fontFamily: "monospace",
			});
			model = api.editor.createModel(fixture.content, spec.language);
			editor.setModel(model);
			handle = {
				getEditor: () => editor,
				getModel: () => model,
				undo: () => editor.trigger("bench", "undo", null),
				redo: () => editor.trigger("bench", "redo", null),
				focus: () => editor.focus(),
			};
		} else if (mode === "component") {
			const { MonacoEditor } = await import(
				"../frontend/components/narrator/file-editor/MonacoEditor"
			);
			const { MantineProvider } = await import("@mantine/core");
			await import("@mantine/core/styles.css");
			const { loadMonaco } = await import(
				"../frontend/components/narrator/file-editor/monaco-loader"
			);
			const { loadMonacoLanguage } = await import(
				"../frontend/components/narrator/file-editor/monaco-languages"
			);
			const filePath = `/bench/中文.${{ javascript: "js", typescript: "ts", json: "json", python: "py", markdown: "md" }[spec.language]}`;
			api = await loadMonaco();
			const languageStart = performance.now();
			await loadMonacoLanguage(api, filePath);
			languageMs = performance.now() - languageStart;
			resourceMs = performance.now() - start;
			root = createRoot(host);
			renderComponent = () =>
				required(root).render(
					createElement(
						MantineProvider,
						{ forceColorScheme: "dark" },
						createElement(MonacoEditor, {
							initialValue: fixture.content,
							documentKey: `bench-${spec.id}`,
							filePath,
							onReady: ready,
							onSearchRequested: () => {
								searchRequests++;
							},
							onDocumentChange: (status: unknown) => {
								metadataEvents++;
								metadataContainsText ||= JSON.stringify(status).length > 16_384;
							},
						}),
					),
				);
			renderComponent();
			while (!editor && performance.now() - start < 30_000) await frames();
			if (!editor) throw new Error("MonacoEditor onReady timeout");
		} else {
			const { mountFullFixture } = await import("./smoke-monaco-large-file-full");
			api = await import("monaco-editor/editor/editor.api");
			resourceMs = performance.now() - start;
			full = await mountFullFixture(host, filePathFor(spec.language));
			editor = full.editor;
			model = full.model;
			renderComponent = full.render;
			handle = {
				getEditor: () => editor,
				getModel: () => model,
				undo: () => editor.trigger("bench", "undo", null),
				redo: () => editor.trigger("bench", "redo", null),
				focus: () => editor.focus(),
			};
		}
		if (gpu) editor.updateOptions({ experimentalGpuAcceleration: "on" });
		handle.focus();
		await frames();
		readyMs = full ? performance.now() - full.acquiredAt : performance.now() - start - resourceMs;
		const firstColor = spec.longLine ? null : await color(0, 2000, false);
		// Release the JS fixture copy after creation, while keeping the small oracle.
		fixture.content = "";
		return {
			readyMs,
			readyIncludingResourcesMs: performance.now() - start,
			fullMountMs: full?.mountMs,
			resourceMs,
			fetchMs,
			languageMs,
			firstColor,
			lineCount: model.getLineCount(),
			utf16Length: model.getValueLength(),
			readOnly: editor.getOption(api.editor.EditorOption.readOnly),
			language: model.getLanguageId(),
			modelId: model.id,
		};
	},
	async colors() {
		if (spec.longLine) return { degradedLongLine: true };
		return {
			middle: await color(Math.floor(fixture.blockCount / 2), 4000),
			tail: await color(fixture.blockCount - 1, 4000),
		};
	},
	async beginInput() {
		editor.setPosition({ lineNumber: Math.min(3, model.getLineCount()), column: 1 });
		editor.revealPosition(required(editor.getPosition()));
		handle.focus();
		await frames();
		inputFrames.length = 0;
		inputArmed = true;
		phaseStart = performance.now();
		phaseStartLength = model.getValueLength();
	},
	inputCount: () => inputFrames.length,
	async endInput() {
		inputArmed = false;
		await frames();
		return {
			samples: inputFrames.slice(),
			insertedCharacters: model.getValueLength() - phaseStartLength,
			longTasks: longTasks.filter((task) => task.start >= phaseStart),
			duration: performance.now() - phaseStart,
		};
	},
	async scroll(count: number) {
		const start = performance.now();
		let previous = start;
		const samples: number[] = [];
		const tops: number[] = [];
		for (let index = 0; index < count; index++) {
			if (spec.longLine) editor.setScrollLeft(editor.getScrollLeft() + 80);
			else editor.setScrollTop(editor.getScrollTop() + 80);
			await frames(1);
			const now = performance.now();
			samples.push(now - previous);
			previous = now;
			if (index % 20 === 0)
				tops.push(spec.longLine ? editor.getScrollLeft() : editor.getScrollTop());
		}
		await frames();
		return { samples, tops, longTasks: longTasks.filter((task) => task.start >= start) };
	},
	async functions() {
		const beforeId = model.id;
		const beforeEditor = editor;
		const beforeLength = model.getValueLength();
		editor.setPosition({ lineNumber: 1, column: 1 });
		editor.pushUndoStop();
		editor.executeEdits("bench", [{ range: new api.Range(1, 1, 1, 1), text: "功能😀" }]);
		editor.pushUndoStop();
		const afterEdit = model.getValueLength();
		handle.undo();
		await frames();
		const undo = model.getValueLength() === beforeLength;
		handle.redo();
		await frames();
		const redo = model.getValueLength() === afterEdit;
		handle.undo();
		if (renderComponent) {
			renderComponent();
			await frames();
		}
		const instancePreserved = beforeId === model.id && beforeEditor === handle.getEditor();
		const longLineEnd = spec.longLine ? model.getLineMaxColumn(1) : null;
		let longLineProtection: Record<string, boolean> | null = null;
		if (spec.longLine && mode !== "kernel") {
			const toggle = required(
				host.querySelector<HTMLButtonElement>("[data-monaco-long-line-toggle]"),
			);
			const original = model.getValue();
			const revision = model.getVersionId();
			const alternative = model.getAlternativeVersionId();
			const selection = required(editor.getSelection());
			const canUndo = model.canUndo();
			const canRedo = model.canRedo();
			const protectedByDefault = editor.getRawOptions().stopRenderingLineAfter === 10_000;
			editor.setSelection(model.getFullModelRange());
			editor.focus();
			editor.trigger("fixture", "editor.action.clipboardCopyAction", null);
			await frames();
			const copyComplete = (await navigator.clipboard.readText()) === original;
			editor.setSelection(selection);
			toggle.click();
			await frames();
			const fullDisplay = editor.getRawOptions().stopRenderingLineAfter === -1;
			toggle.click();
			await frames();
			longLineProtection = {
				protectedByDefault,
				copyComplete,
				fullDisplay,
				protectionRestored: editor.getRawOptions().stopRenderingLineAfter === 10_000,
				modelPreserved: editor.getModel() === model && model.getValue() === original,
				historyPreserved:
					model.getVersionId() === revision &&
					model.getAlternativeVersionId() === alternative &&
					model.canUndo() === canUndo &&
					model.canRedo() === canRedo,
				selectionPreserved: required(editor.getSelection()).equalsSelection(selection),
			};
		}
		if (spec.longLine) {
			editor.setPosition({ lineNumber: 1, column: model.getLineMaxColumn(1) });
			editor.revealPosition(required(editor.getPosition()));
			await frames();
		}
		return {
			editApplied: afterEdit === beforeLength + 4,
			undo,
			redo,
			instancePreserved,
			metadataEvents,
			metadataContainsText,
			longLineEnd,
			longLineProtection,
			horizontalScroll: editor.getScrollLeft(),
			searchRequests,
		};
	},
	imeState: () => ({
		line: model.getLineContent(required(editor.getPosition()).lineNumber).slice(0, 400),
		revision: model.getVersionId(),
	}),
	async threeFiles() {
		const start = performance.now();
		const snapshot = model.createSnapshot();
		const chunks: string[] = [];
		let chunk = snapshot.read();
		while (chunk !== null) {
			chunks.push(chunk);
			chunk = snapshot.read();
		}
		const text = chunks.join("");
		if (mode === "kernel") {
			for (let i = 0; i < 2; i++)
				extraModels.push(
					api.editor.createModel(
						text.replaceAll("answer", `value${i}`),
						spec.language,
						api.Uri.parse(`inmemory://bench/background-${i}`),
					),
				);
		} else {
			const { MonacoEditor } = await import(
				"../frontend/components/narrator/file-editor/MonacoEditor"
			);
			const { MantineProvider } = await import("@mantine/core");
			for (let i = 0; i < 2; i++) {
				const container = document.createElement("div");
				container.style.cssText = "position:absolute;inset:0;visibility:hidden;pointer-events:none";
				document.body.append(container);
				const backgroundRoot = createRoot(container);
				extraRoots.push(backgroundRoot);
				backgroundRoot.render(
					createElement(
						MantineProvider,
						{ forceColorScheme: "dark" },
						createElement(MonacoEditor, {
							initialValue: text.replaceAll("answer", `value${i}`),
							documentKey: `background-${spec.id}-${i}`,
							filePath: filePathFor(spec.language),
							visible: false,
							onReady: (next) => {
								const nextModel = next?.getModel();
								if (nextModel) extraModels.push(nextModel);
							},
						}),
					),
				);
			}
			while (extraModels.length < 2 && performance.now() - start < 30_000) await frames();
			if (extraModels.length !== 2) throw new Error("Background editor initialization timeout");
		}
		await frames();
		return {
			ms: performance.now() - start,
			modelCount: api.editor.getModels().length,
			scope:
				mode === "kernel"
					? "3 models, one editor"
					: "3 real Monaco components with distinct content: one visible and two hidden; not 3 application dock tabs",
			bytesUtf16: [model, ...extraModels].reduce(
				(total, item) => total + item.getValueLength() * 2,
				0,
			),
		};
	},
	fullState: () => full?.state(),
	fullDiagnostics: () => full?.diagnostics(),
	prepareFullSave: () => full?.prepareSave(),
	saveFull: () => full?.save(),
	previewFull: () => full?.preview(),
	stats: () => ({
		fullState: full?.state(),
		longTasks: longTasks.slice(),
		resources: performance
			.getEntriesByType("resource")
			.slice(-200)
			.map((entry) => ({
				name: entry.name.replace(location.origin, ""),
				duration: entry.duration,
			})),
		searchRequests,
	}),
	dispose() {
		observer.disconnect();
		if (full) full.dispose();
		else root?.unmount();
		if (!root && !full) {
			editor?.dispose();
			model?.dispose();
		}
		for (const extraRoot of extraRoots) extraRoot.unmount();
		for (const item of extraModels) if (!item.isDisposed()) item.dispose();
	},
};
declare global {
	interface Window {
		__monacoBench: typeof bench;
	}
}
window.__monacoBench = bench;
