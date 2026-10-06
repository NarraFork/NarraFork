import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { editor, IPosition, IRange } from "monaco-editor/editor/editor.api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type MonacoDocumentStatus,
	MonacoEditor,
	type MonacoEditorHandle,
	type MonacoEditorProps,
} from "./MonacoEditor";
import * as searchPanel from "./MonacoSearchPanel";
import * as languages from "./monaco-languages";
import * as loader from "./monaco-loader";
import * as scroll from "./monaco-scroll";

class Signal<T> {
	listeners = new Set<(event: T) => void>();
	on = (listener: (event: T) => void) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	emit(event: T) {
		for (const listener of this.listeners) listener(event);
	}
}
class Model {
	version = 1;
	disposed = false;
	canUndo = () => this.version > 1;
	canRedo = () => false;
	changes = new Signal<editor.IModelContentChangedEvent>();
	onDidChangeContent = this.changes.on;
	constructor(public text: string) {}
	getLineCount = () => this.text.split("\n").length;
	getLineLength = (line: number) => this.text.split("\n")[line - 1].length;
	getLineMaxColumn = (line: number) => this.getLineLength(line) + 1;
	getVersionId = () => this.version;
	getAlternativeVersionId = () => this.version;
	getValueLength = () => this.text.length;
	getOffsetAt = (p: IPosition) =>
		this.text
			.split("\n")
			.slice(0, p.lineNumber - 1)
			.reduce((n, s) => n + s.length + 1, 0) +
		p.column -
		1;
	getPositionAt = (offset: number) => {
		const prefix = this.text.slice(0, offset).split("\n");
		return { lineNumber: prefix.length, column: prefix[prefix.length - 1].length + 1 };
	};
	setValue = mock((text: string) => {
		this.text = text;
		this.version++;
		this.changes.emit({
			changes: [],
			isFlush: true,
			isEolChange: false,
			isUndoing: false,
			isRedoing: false,
			eol: "\n",
			versionId: this.version,
			detailedReasonsChangeLengths: [],
		});
	});
	dispose = () => {
		this.disposed = true;
	};
}
class View {
	model: Model | null = null;
	disposed = false;
	selection: IRange = { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1 };
	cursor = new Signal<editor.ICursorSelectionChangedEvent>();
	focusEvent = new Signal<void>();
	mouse = new Signal<editor.IEditorMouseEvent>();
	onDidChangeCursorSelection = this.cursor.on;
	onDidFocusEditorText = this.focusEvent.on;
	onMouseDown = this.mouse.on;
	setModel = (model: Model) => {
		this.model = model;
	};
	getSelection = () => this.selection;
	setPosition = mock((p: IPosition) => {
		this.selection = {
			startLineNumber: p.lineNumber,
			startColumn: p.column,
			endLineNumber: p.lineNumber,
			endColumn: p.column,
		};
	});
	updateOptions = mock((_options: unknown) => {});
	layout = mock((_dimensions: unknown) => {});
	trigger = mock((_source: string, _command: string, _payload: unknown) => {});
	focus = mock(() => {});
	commands = new Map<number, () => void>();
	addCommand = (key: number, command: () => void) => this.commands.set(key, command);
	createDecorationsCollection = () => {
		let ranges: editor.IModelDeltaDecoration[] = [];
		return {
			set: (next: editor.IModelDeltaDecoration[]) => {
				ranges = next;
			},
			getRange: () => ranges[0]?.range ?? null,
			clear: () => {
				ranges = [];
			},
		};
	};
	dispose = () => {
		this.disposed = true;
	};
}

let root: Root;
let host: HTMLDivElement;
let views: View[];
let models: Model[];
let creationOrder: string[];
let handle: MonacoEditorHandle | null;
let statuses: MonacoDocumentStatus[];
const globals = new Map<string, PropertyDescriptor | undefined>();
let loadSpy: ReturnType<typeof spyOn<typeof loader, "loadMonaco">>;
let languageSpy: ReturnType<typeof spyOn<typeof languages, "loadMonacoLanguage">>;
const ready = mock((next: MonacoEditorHandle | null) => {
	handle = next;
});
const selectionChange = mock((_selection: unknown, _explicit: boolean) => {});
let api: loader.MonacoAPI;
let frames = new Map<number, FrameRequestCallback>();
let frameSequence = 0;
let themeColors: Record<string, string> | null = null;
function flushFrames(): void {
	for (let cycles = 0; frames.size; cycles++) {
		if (cycles > 4) throw new Error("Unbounded Monaco layout retry");
		const current = [...frames.values()];
		frames.clear();
		for (const frame of current) frame(0);
	}
}

let windowMouseUp: (() => void) | null = null;

beforeEach(() => {
	frames = new Map();
	frameSequence = 0;
	themeColors = null;
	windowMouseUp = null;
	const { window } = parseHTML("<html><body></body></html>");
	Object.defineProperty(window, "getComputedStyle", {
		configurable: true,
		value: () => ({
			getPropertyValue: (name: string) => (themeColors ? (themeColors[name] ?? "") : "#242424"),
			visibility: "visible",
		}),
	});
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
	const originalAdd = window.addEventListener.bind(window);
	const originalRemove = window.removeEventListener.bind(window);
	window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === "mouseup" && typeof listener === "function")
			windowMouseUp = () => listener(new Event("mouseup"));
		return originalAdd(type as keyof WindowEventMap, listener as EventListener);
	}) as typeof window.addEventListener;
	window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
		if (type === "mouseup") windowMouseUp = null;
		return originalRemove(type as keyof WindowEventMap, listener as EventListener);
	}) as typeof window.removeEventListener;
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		MutationObserver: window.MutationObserver,
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: FrameRequestCallback): number => {
			frames.set(++frameSequence, callback);
			return frameSequence;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = window.document.createElement("div");
	window.document.body.appendChild(host);
	root = createRoot(host);
	views = [];
	models = [];
	statuses = [];
	creationOrder = [];
	handle = null;
	ready.mockClear();
	selectionChange.mockClear();
	api = {
		Uri: { from: (parts: unknown) => parts },
		KeyMod: { CtrlCmd: 2048 },
		KeyCode: { KeyF: 36, KeyS: 49 },
		editor: {
			defineTheme(_name: string, theme: editor.IStandaloneThemeData) {
				for (const color of Object.values(theme.colors)) {
					if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color))
						throw new Error(`Illegal value for token color: ${color}`);
				}
			},
			setTheme() {},
			setModelLanguage() {},
			CursorChangeReason: { ContentFlush: 1, RecoverFromMarkers: 2 },
			MouseTargetType: { CONTENT_TEXT: 6, CONTENT_EMPTY: 7, GUTTER_LINE_NUMBERS: 2 },
			create: (_host: HTMLElement, options: editor.IStandaloneEditorConstructionOptions) => {
				expect(options.largeFileOptimizations).toBe(false);
				expect(options.model).toBeNull();
				creationOrder.push("editor");
				const view = new View();
				views.push(view);
				return view;
			},
			createModel: (text: string) => {
				creationOrder.push("model");
				const model = new Model(text);
				models.push(model);
				return model;
			},
		},
	} as unknown as loader.MonacoAPI;
	loadSpy = spyOn(loader, "loadMonaco").mockResolvedValue(api);
	languageSpy = spyOn(languages, "loadMonacoLanguage").mockImplementation(async (_api, path) =>
		languages.resolveMonacoLanguage(path),
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	loadSpy.mockRestore();
	languageSpy.mockRestore();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
async function render(
	overrides: Partial<MonacoEditorProps> = {},
	scheme: "light" | "dark" = "dark",
) {
	await act(async () => {
		root.render(
			<MantineProvider forceColorScheme={scheme}>
				<MonacoEditor
					initialValue={"one\ntwo"}
					documentKey="narrator/local/a.ts"
					filePath="a.ts"
					onReady={ready}
					onDocumentChange={(status) => statuses.push(status)}
					onSelectionChange={selectionChange}
					{...overrides}
				/>
			</MantineProvider>,
		);
	});
}

test.each([
	{
		name: "light shorthand",
		scheme: "light" as const,
		values: ["#fff", " #000 ", "#abc"],
		expected: ["#ffffff", "#000000", "#aabbcc"],
	},
	{
		name: "OLED shorthand with alpha",
		scheme: "dark" as const,
		values: ["#000", "#fff", "#789a"],
		expected: ["#000000", "#ffffff", "#778899aa"],
	},
	{
		name: "full hex",
		scheme: "dark" as const,
		values: ["#123456", "#abcdef", "#12345678"],
		expected: ["#123456", "#abcdef", "#12345678"],
	},
	{
		name: "invalid CSS fallback",
		scheme: "dark" as const,
		values: ["invalid", "var(--missing)", ""],
		expected: ["#242424", "#c9c9c9", "#828282"],
	},
])("normalizes $name theme colours before creating the editor", async ({
	scheme,
	values,
	expected,
}) => {
	const names = ["--mantine-color-body", "--mantine-color-text", "--mantine-color-dimmed"];
	themeColors = Object.fromEntries(names.map((name, index) => [name, values[index]]));
	const theme = spyOn(api.editor, "defineTheme");
	const onError = mock((_error: Error) => {});
	try {
		await render({ onError }, scheme);
		expect(handle?.getModel()).toBeTruthy();
		expect(onError).not.toHaveBeenCalled();
		expect(theme.mock.calls.at(-1)?.[1].colors).toMatchObject({
			"editor.background": expected[0],
			"editor.foreground": expected[1],
			"editorLineNumber.foreground": expected[2],
			"editorGutter.background": expected[0],
			"editorCursor.foreground": expected[1],
		});
		const model = handle?.getModel();
		await render({ onError }, scheme === "light" ? "dark" : "light");
		expect(handle?.getModel()).toBe(model);
		expect(onError).not.toHaveBeenCalled();
	} finally {
		theme.mockRestore();
	}
});

test("long-line display protection toggles without replacing text, cursor or history", async () => {
	const text = `${"x".repeat(20_000)}😀END`;
	await render({ initialValue: text });
	const model = models[0];
	const view = views[0];
	model.version = 4;
	view.setPosition({ lineNumber: 1, column: 51 });
	const selection = view.selection;
	const toggle = () => host.querySelector<HTMLButtonElement>("[data-monaco-long-line-toggle]");
	expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
	await act(async () => toggle()?.click());
	expect(view.updateOptions).toHaveBeenCalledWith({ stopRenderingLineAfter: -1 });
	expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
	await render({ initialValue: text, visible: false });
	await render({ initialValue: text, visible: true });
	expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
	await act(async () => toggle()?.click());
	expect(view.updateOptions).toHaveBeenCalledWith({ stopRenderingLineAfter: 10_000 });
	expect(models).toHaveLength(1);
	expect(model.text).toBe(text);
	expect(model.version).toBe(4);
	expect(model.setValue).not.toHaveBeenCalled();
	expect(view.selection).toBe(selection);
	expect(model.canUndo()).toBe(true);
	await act(async () => toggle()?.click());
	await render({ documentKey: "other-file", initialValue: text });
	expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
	await render({ initialValue: text });
	expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
	await act(async () => models.at(-1)?.setValue("short"));
	expect(toggle()).toBeNull();
});

for (const [label, cryptoValue] of [
	["randomUUID unavailable", {}],
	["crypto unavailable", undefined],
] as const) {
	test(`opens and isolates model URIs on HTTP when ${label}`, async () => {
		globals.set("crypto", Object.getOwnPropertyDescriptor(globalThis, "crypto"));
		Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoValue });
		const uri = spyOn(api.Uri, "from");
		const onError = mock((_error: Error) => {});
		await render({ onError });
		expect(handle?.getModel()).toBeTruthy();
		await render({ documentKey: "other/http/a.ts", onError });
		expect(models).toHaveLength(2);
		expect(onError).not.toHaveBeenCalled();
		const first = uri.mock.calls[0]?.[0].query;
		const second = uri.mock.calls[1]?.[0].query;
		expect(first).toStartWith("editor-");
		expect(second).toStartWith("editor-");
		expect(second).not.toBe(first);
		uri.mockRestore();
	});
}

test("navigation geometry is deferred, coalesced and discarded after a document revision changes", async () => {
	const visible = spyOn(scroll, "monacoHostVisible").mockReturnValue(true);
	const reveal = spyOn(scroll, "revealMonacoPosition").mockReturnValue(true);
	try {
		await render({
			selection: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 2 },
			navigationRequestId: "first",
		});
		await render({
			selection: { startLineNumber: 2, endLineNumber: 2, startColumn: 2, endColumn: 3 },
			navigationRequestId: "second",
		});
		expect(reveal).not.toHaveBeenCalled();
		flushFrames();
		expect(reveal).toHaveBeenCalledTimes(1);
		expect(reveal.mock.calls[0]?.[2]).toEqual({ lineNumber: 2, column: 2 });
		await render({
			selection: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 2 },
			navigationRequestId: "third",
		});
		models[0].version++; // A newer edit supersedes the coordinates captured by this request.
		flushFrames();
		expect(reveal).toHaveBeenCalledTimes(1);
	} finally {
		visible.mockRestore();
		reveal.mockRestore();
	}
});

test("wrapped geometry retries are bounded and navigation clear cancels queued reveal", async () => {
	const visible = spyOn(scroll, "monacoHostVisible").mockReturnValue(true);
	const reveal = spyOn(scroll, "revealMonacoPosition").mockReturnValue(false);
	try {
		await render({
			selection: { startLineNumber: 2, endLineNumber: 2, startColumn: 1, endColumn: 2 },
		});
		flushFrames();
		expect(reveal).toHaveBeenCalledTimes(3);
		await render({
			selection: { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 2 },
			navigationRequestId: "new",
		});
		await render({ selection: undefined });
		flushFrames();
		expect(reveal).toHaveBeenCalledTimes(3);
	} finally {
		visible.mockRestore();
		reveal.mockRestore();
	}
});

test("standalone readonly source CtrlF opens bounded Mantine fallback and closes without replacing model", async () => {
	const fallback = spyOn(searchPanel, "MonacoSearchPanel").mockImplementation(
		({ onClose, readOnly }) => (
			<button type="button" data-search-fallback data-read-only={readOnly} onClick={onClose}>
				Close search
			</button>
		),
	);
	try {
		await render({ readOnly: true });
		await act(async () => views[0].commands.get(2048 | 36)?.());
		expect(host.querySelectorAll("[data-search-fallback]")).toHaveLength(1);
		expect(fallback.mock.calls.at(-1)?.[0].readOnly).toBe(true);
		expect(fallback.mock.calls.at(-1)?.[0].editor).toBe(
			views[0] as unknown as editor.IStandaloneCodeEditor,
		);
		await act(async () => views[0].commands.get(2048 | 36)?.());
		expect(host.querySelectorAll("[data-search-fallback]")).toHaveLength(1);
		await act(async () =>
			(host.querySelector("[data-search-fallback]") as HTMLButtonElement).click(),
		);
		expect(host.querySelector("[data-search-fallback]")).toBeNull();
		expect(models).toHaveLength(1);
		expect(models[0].setValue).not.toHaveBeenCalled();
	} finally {
		fallback.mockRestore();
	}
});

test("external search ownership never duplicates fallback and internal search passes save callback", async () => {
	const save = mock(() => {});
	const external = mock(() => {});
	const fallback = spyOn(searchPanel, "MonacoSearchPanel").mockImplementation(() => (
		<div data-search-fallback />
	));
	try {
		await render({ onSave: save });
		await act(async () => views[0].commands.get(2048 | 36)?.());
		expect(fallback.mock.calls.at(-1)?.[0].onSave).toBe(save);
		await render({ onSave: save, onSearchRequested: external });
		expect(host.querySelector("[data-search-fallback]")).toBeNull();
		await act(async () => views[0].commands.get(2048 | 36)?.());
		expect(external).toHaveBeenCalledTimes(1);
		expect(host.querySelector("[data-search-fallback]")).toBeNull();
		expect(models).toHaveLength(1);
	} finally {
		fallback.mockRestore();
	}
});

test("retains model/view across edits, parent rerenders, theme and preview switches", async () => {
	await render();
	expect(creationOrder).toEqual(["editor", "model"]);
	const original = handle?.getModel();
	await act(async () => models[0].setValue("unsaved local edit"));
	await render({ visible: false }, "light");
	await render({ visible: true, lineWrapping: true });
	expect(models).toHaveLength(1);
	expect(views).toHaveLength(1);
	expect(handle?.getModel()).toBe(original);
	expect(models[0].text).toBe("unsaved local edit");
	expect(models[0].setValue).toHaveBeenCalledTimes(1);
	expect(statuses.at(-1)?.length).toBe(18);
	expect(Object.keys(statuses[0])).not.toContain("text");
	expect(ready).toHaveBeenCalledTimes(1);
});

test("only a changed initialValue explicitly reloads and emits fresh revision metadata", async () => {
	await render();
	await render({ initialValue: "reloaded" });
	expect(models[0].setValue).toHaveBeenCalledTimes(1);
	expect(statuses.at(-1)?.revision).toBe(2);
	expect(statuses.at(-1)?.length).toBe(8);
});

test("navigation clamps and leaves only a cursor, repeated request keeps ownership", async () => {
	const selection = { startLineNumber: 99, startColumn: 99, endLineNumber: 1, endColumn: 2 };
	await render({ selection, navigationRequestId: "first" });
	expect(views[0].selection).toEqual({
		startLineNumber: 1,
		startColumn: 2,
		endLineNumber: 1,
		endColumn: 2,
	});
	expect(selectionChange).toHaveBeenLastCalledWith(null, true);
	await render({ selection, navigationRequestId: "second" });
	expect(views[0].setPosition).toHaveBeenCalledTimes(2);
	expect(models[0].setValue).not.toHaveBeenCalled();
});

test("document-only cursor recovery does not acquire ownership, keyboard selection does", async () => {
	await render();
	const selected = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 };
	views[0].cursor.emit({ selection: selected, reason: 2 } as editor.ICursorSelectionChangedEvent);
	expect(selectionChange).toHaveBeenLastCalledWith(selected, false);
	views[0].cursor.emit({ selection: selected, reason: 3 } as editor.ICursorSelectionChangedEvent);
	expect(selectionChange).toHaveBeenLastCalledWith(selected, true);
});

test("mouse drag-select coalesces cursor events until pointer end", async () => {
	await render();
	const view = views[0];
	const mid = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 };
	const final = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 3 };
	view.mouse.emit({
		event: { leftButton: true },
		target: { type: api.editor.MouseTargetType.CONTENT_TEXT },
	} as editor.IEditorMouseEvent);
	await act(async () => {});
	selectionChange.mockClear();
	view.selection = mid;
	view.cursor.emit({ selection: mid, reason: 3 } as editor.ICursorSelectionChangedEvent);
	view.selection = final;
	view.cursor.emit({ selection: final, reason: 3 } as editor.ICursorSelectionChangedEvent);
	expect(selectionChange).not.toHaveBeenCalled();
	expect(windowMouseUp).toBeTruthy();
	windowMouseUp?.();
	expect(selectionChange).toHaveBeenCalledTimes(1);
	expect(selectionChange).toHaveBeenLastCalledWith(final, true);
});

test("shortcuts use latest callbacks and readonly blocks toolbar history commands", async () => {
	const save = mock(() => {});
	const search = mock(() => {});
	await render({ onSave: save, onSearchRequested: search });
	views[0].commands.get(2048 | 49)?.();
	views[0].commands.get(2048 | 36)?.();
	expect(save).toHaveBeenCalledTimes(1);
	expect(search).toHaveBeenCalledTimes(1);
	handle?.undo();
	expect(views[0].trigger).toHaveBeenLastCalledWith("toolbar", "undo", null);
	await render({ readOnly: true });
	handle?.redo();
	expect(views[0].trigger).toHaveBeenCalledTimes(1);
	expect(statuses.at(-1)?.canUndo).toBe(false);
});

test("unsupported grammar is reported and language changes do not replace the model", async () => {
	await render({ filePath: "data.unsupported" });
	expect(statuses.at(-1)?.languageSupported).toBe(false);
	await render({ filePath: "a.ts" });
	expect(statuses.at(-1)?.language).toBe("typescript");
	expect(statuses.at(-1)?.languageSupported).toBe(true);
	expect(models).toHaveLength(1);
});

test("imperative explicit reload reapplies navigation after the new document arrives", async () => {
	const selection = { startLineNumber: 2, endLineNumber: 2, startColumn: 1, endColumn: 2 };
	await render({ selection });
	await act(async () => models[0].setValue("a\nlonger"));
	expect(views[0].setPosition).toHaveBeenCalledTimes(2);
	expect(statuses.at(-1)?.revision).toBe(2);
});

test("late browser loader cannot create an editor after unmount", async () => {
	let resolve!: (api: loader.MonacoAPI) => void;
	loadSpy.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	await render();
	expect(models).toHaveLength(0);
	await act(async () => root.unmount());
	await act(async () => resolve(api));
	expect(models).toHaveLength(0);
	expect(ready).not.toHaveBeenCalled();
});

test("changing document identity disposes old model and unmount publishes null handle", async () => {
	await render();
	await render({ documentKey: "other/device/a.ts" });
	expect(models).toHaveLength(2);
	expect(models[0].disposed).toBe(true);
	expect(views[0].disposed).toBe(true);
	await act(async () => root.unmount());
	expect(handle).toBeNull();
	expect(models[1].disposed).toBe(true);
});
