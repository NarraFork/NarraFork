import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import type { editor as Monaco } from "monaco-editor";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { EditorSearchClient } from "./editor-worker-client";
import { MonacoSearchPanel } from "./MonacoSearchPanel";

const originals = new Map<string, PropertyDescriptor | undefined>();
const i18n = i18next.createInstance();
let root: Root;
let host: HTMLDivElement;
let instance: Monaco.IStandaloneCodeEditor;
const closed = mock(() => {});
const saved = mock(() => {});
const focused = mock(() => {});
const selected = mock((_range: unknown) => {});
const executed = mock((_source: string, _edits: unknown[]) => true);
const stopped = mock(() => true);
let search: ReturnType<typeof spyOn<typeof EditorSearchClient.prototype, "search">>;
let replace: ReturnType<typeof spyOn<typeof EditorSearchClient.prototype, "replace">>;

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.defineProperty(window.HTMLInputElement.prototype, "select", {
		configurable: true,
		value() {},
	});
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		MutationObserver: window.MutationObserver,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	if (!i18n.isInitialized)
		await i18n.init({
			lng: "en",
			resources: {
				en: {
					narrator: {
						fileEditor: {
							search: "Search",
							searchPhrases: {},
							searchErrors: {
								EDITOR_INVALID_REGEX: "Invalid expression",
								EDITOR_WORKER_ERROR: "Search failed",
							},
							searchWorking: "Searching",
							searchCancel: "Cancel",
							searchMatchCount: "{{count}}{{suffix}} matches",
						},
					},
				},
			},
			react: { useSuspense: false },
		});
	for (const fn of [closed, saved, focused, selected, executed, stopped]) fn.mockClear();
	const disposable = () => ({ dispose() {} });
	const model = {
		getVersionId: () => 1,
		getValueLength: () => 7,
		isDisposed: () => false,
		onDidChangeContent: disposable,
		getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
		getOffsetAt: (position: { column: number }) => position.column - 1,
	};
	instance = {
		getModel: () => model,
		getRawOptions: () => ({ readOnly: false }),
		onDidChangeModel: disposable,
		onDidChangeModelContent: disposable,
		createDecorationsCollection: () => ({ clear() {}, set() {} }),
		getSelection: () => ({
			getStartPosition: () => ({ lineNumber: 1, column: 1 }),
			getEndPosition: () => ({ lineNumber: 1, column: 1 }),
			isEmpty: () => true,
		}),
		setSelection: selected,
		setSelections() {},
		revealRangeInCenterIfOutsideViewport() {},
		focus: focused,
		pushUndoStop: stopped,
		executeEdits: executed,
	} as unknown as Monaco.IStandaloneCodeEditor;
	search = spyOn(EditorSearchClient.prototype, "search").mockResolvedValue({
		matches: [{ offset: 0, length: 3 }],
		count: 2,
		more: false,
	});
	replace = spyOn(EditorSearchClient.prototype, "replace").mockResolvedValue({
		revision: 1,
		edits: [{ offset: 0, length: 3, text: "x" }],
		length: 5,
		utf8Bytes: 5,
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	search?.mockRestore();
	replace?.mockRestore();
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
async function mount(readOnly = false) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<MonacoSearchPanel
						editor={instance}
						onClose={closed}
						readOnly={readOnly}
						onSave={saved}
					/>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
}
function input(name: string): HTMLInputElement {
	const node = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
	if (!node) throw new Error(`missing ${name}`);
	return node;
}
async function change(name: string, value: string) {
	const node = input(name);
	const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
	if (!propsKey) throw new Error("missing React input props");
	const props = (node as unknown as Record<string, { onChange: (event: unknown) => void }>)[
		propsKey
	];
	await act(async () => props.onChange({ currentTarget: { value } }));
}
async function key(name: string, keyValue: string, patch: Record<string, unknown> = {}) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: keyValue, keyCode: keyValue === "Enter" ? 13 : 27, ...patch });
	await act(async () => {
		input(name).dispatchEvent(event);
	});
	return event;
}

test("Mantine fields, Enter/ShiftEnter navigation, initial offset zero and Escape", async () => {
	await mount();
	expect(host.querySelector('[role="search"]')).not.toBeNull();
	expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
	await change("search", "abc");
	await key("search", "Enter");
	expect(search.mock.calls.at(-1)?.[1]).toBe(0);
	expect(search.mock.calls.at(-1)?.[2]).toBe(false);
	expect(selected).toHaveBeenCalledTimes(1);
	await key("search", "Enter", { shiftKey: true });
	expect(search.mock.calls.at(-1)?.[2]).toBe(true);
	await key("search", "Escape");
	expect(closed).toHaveBeenCalledTimes(1);
	expect(focused).toHaveBeenCalledTimes(1);
});

test("immediate Enter owns navigation beyond the automatic search debounce", async () => {
	await mount();
	let finish:
		| ((value: {
				matches: { offset: number; length: number }[];
				count: number;
				more: boolean;
		  }) => void)
		| undefined;
	search.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await change("search", "abc");
	await key("search", "Enter");
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 200));
	});
	expect(search).toHaveBeenCalledTimes(1);
	expect(search.mock.calls[0][3]?.aborted).toBe(false);
	await act(async () => {
		finish?.({ matches: [{ offset: 0, length: 3 }], count: 2, more: false });
	});
	expect(selected).toHaveBeenCalledTimes(1);
});

test("Ctrl/Cmd+S in panel saves once, prevents Save Page, and respects IME/readOnly", async () => {
	await mount();
	expect((await key("search", "s", { ctrlKey: true, keyCode: 83 })).defaultPrevented).toBe(true);
	expect((await key("replace", "s", { metaKey: true, keyCode: 83 })).defaultPrevented).toBe(true);
	expect(saved).toHaveBeenCalledTimes(2);
	await key("search", "s", { ctrlKey: true, keyCode: 83, isComposing: true });
	expect(saved).toHaveBeenCalledTimes(2);
	await mount(true);
	expect((await key("search", "s", { ctrlKey: true, keyCode: 83 })).defaultPrevented).toBe(true);
	expect(saved).toHaveBeenCalledTimes(2);
});

test("replacement is one undo transaction; composition Enter never replaces", async () => {
	await mount();
	await change("search", "abc");
	await change("replace", "x");
	await key("replace", "Enter");
	expect(replace).toHaveBeenCalledTimes(1);
	expect(executed).toHaveBeenCalledTimes(1);
	expect(stopped).toHaveBeenCalledTimes(2);
	replace.mockClear();
	executed.mockClear();
	stopped.mockClear();
	await key("replace", "Enter", { isComposing: true });
	await key("replace", "Enter", { keyCode: 229 });
	expect(replace).not.toHaveBeenCalled();
	expect(executed).not.toHaveBeenCalled();
	await mount(true);
	expect(host.querySelector('input[name="replace"]')).toBeNull();
});

test("invalid expressions are visible and late-query results never move selection", async () => {
	await mount();
	search.mockRejectedValueOnce(new Error("EDITOR_INVALID_REGEX"));
	await change("search", "[");
	await key("search", "Enter");
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid expression");
	let resolve:
		| ((result: {
				matches: { offset: number; length: number }[];
				count: number;
				more: boolean;
		  }) => void)
		| undefined;
	search.mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	await change("search", "abc");
	await key("search", "Enter");
	await change("search", "xyz");
	await act(async () => resolve?.({ matches: [{ offset: 0, length: 3 }], count: 1, more: false }));
	expect(selected).not.toHaveBeenCalled();
});
