/**
 * Wiring of the spec document editor: which pane each mode mounts and what reaches the panel's
 * onChange. Monaco is the file editor's test double (real Monaco is covered by its Chromium
 * fixture) and the Tiptap editor is a stub that records its props; the rendered preview is the
 * real MarkdownContent. Round-trip fidelity of the Tiptap editor itself is covered headlessly in
 * spec-markdown-extensions.test.ts.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import {
	mountedTestModels,
	type TestEditorModel,
	TestMonacoEditor,
} from "../file-editor/file-editor-test-model";
import * as monacoComponent from "../file-editor/MonacoEditor";
import { SpecDocumentEditor } from "./SpecDocumentEditor";
import * as richComponent from "./SpecMarkdownEditor";
import type { SpecEditorMode } from "./spec-editor-mode";

const i18n = i18next.createInstance();
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let host: HTMLDivElement;
const restores: (() => void)[] = [];

// Installed once: the lazy import inside SpecDocumentEditor caches whatever it resolved first.
const richProps: { value: string; revisionKey: string }[] = [];
const richEditor = spyOn(richComponent, "SpecMarkdownEditor").mockImplementation((props) => {
	richProps.push({ value: props.value, revisionKey: props.revisionKey });
	return <div data-rich-test-editor />;
});

const changes: string[] = [];
let setServer: (revisionKey: string, value: string) => void = () => {};

function Harness({
	path,
	initial,
	preferredMode = "source",
}: {
	path: string;
	initial: string;
	preferredMode?: SpecEditorMode;
}) {
	const [doc, setDoc] = useState({ revisionKey: `spec://${path}:r1`, value: initial });
	const [mode, setMode] = useState<SpecEditorMode>(preferredMode);
	setServer = (revisionKey, value) => setDoc({ revisionKey, value });
	return (
		<SpecDocumentEditor
			documentKey={`spec://${path}`}
			path={path}
			value={doc.value}
			revisionKey={doc.revisionKey}
			onChange={(text) => {
				changes.push(text);
				setDoc((current) => ({ ...current, value: text }));
			}}
			dirty={changes.length > 0}
			onSave={() => {}}
			onReload={() => {}}
			isSaving={false}
			preferredMode={mode}
			onPreferredModeChange={setMode}
		/>
	);
}

async function mount(path: string, initial: string, preferredMode?: SpecEditorMode) {
	// A fresh root per mount, so the harness starts from `initial` like a newly opened panel.
	await act(async () => root?.unmount());
	mountedTestModels.clear();
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<Harness path={path} initial={initial} preferredMode={preferredMode} />
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	// Let lazy panes resolve.
	await act(async () => {});
}

function sourceEditor(): TestEditorModel | null {
	const key = host.querySelector("[data-monaco-test-editor]")?.getAttribute("data-document-key");
	return key ? (mountedTestModels.get(key) ?? null) : null;
}

function modeInputs() {
	return [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
		(input) => input.value,
	);
}

async function switchMode(mode: SpecEditorMode) {
	const input = host.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`);
	if (!input) throw new Error(`Missing mode ${mode}`);
	await act(async () => {
		input.checked = true;
		input.dispatchEvent(new Event("click", { bubbles: true }));
	});
	await act(async () => {});
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "getSelection", { value: () => null });
	const overrides = {
		window,
		document: window.document,
		navigator: { ...window.navigator, platform: "Linux", userAgent: "test" },
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		MutationObserver: window.MutationObserver,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		Event: window.Event,
		getSelection: () => null,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => "", whiteSpace: "pre" }),
		matchMedia: (media: string) => ({
			media,
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	if (!i18n.isInitialized)
		await i18n.init({
			lng: "en",
			resources: { en: { narrator: en } },
			react: { useSuspense: false },
		});
	const monaco = spyOn(monacoComponent, "MonacoEditor").mockImplementation(TestMonacoEditor);
	restores.push(() => monaco.mockRestore());
	changes.length = 0;
	richProps.length = 0;
	richEditor.mockClear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		host?.remove();
	} finally {
		root = undefined;
		for (const restore of restores.splice(0)) restore();
		for (const [key, descriptor] of originalGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originalGlobals.clear();
		mountedTestModels.clear();
	}
});

test("a markdown file opens in source mode and saves exactly what is typed", async () => {
	const text = "调用 snake_case，R&D，a < b\n\n| a | b |\n| --- | --- |\n| x \\| y | 2 |\n";
	await mount("design.md", text);
	expect(modeInputs()).toEqual(["source", "split", "rich"]);
	const editor = sourceEditor();
	expect(editor?.props.initialValue).toBe(text);
	expect(editor?.props.filePath).toBe("design.md");
	// Opening alone reports nothing, so nothing is marked dirty.
	expect(changes).toEqual([]);
	await act(async () => editor?.edit(`${text}新增 *.test.ts\n`));
	expect(changes).toEqual([`${text}新增 *.test.ts\n`]);
	expect(richEditor).not.toHaveBeenCalled();
});

test("non-markdown files and the behavior fence are plain text only", async () => {
	for (const path of ["notes.json", "behavior_fence"]) {
		await mount(path, '{"key_name": ["*"]}\n', "rich");
		expect(modeInputs()).toEqual([]);
		expect(host.textContent).toContain(en.spec.plainTextHint);
		expect(sourceEditor()?.props.initialValue).toBe('{"key_name": ["*"]}\n');
		expect(richEditor).not.toHaveBeenCalled();
	}
});

test("split mode keeps the same source editor and adds the rendered preview", async () => {
	await mount("design.md", "# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
	const before = sourceEditor();
	await switchMode("split");
	expect(sourceEditor()).toBe(before);
	expect(host.querySelector("table")?.textContent).toContain("1");
});

test("rich mode loads the WYSIWYG editor with the current text, unsaved edits included", async () => {
	await mount("design.md", "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
	await act(async () => sourceEditor()?.edit("| a | b |\n| --- | --- |\n| 1 | 3 |\n"));
	await switchMode("rich");
	expect(sourceEditor()).toBeNull();
	expect(host.querySelector("[data-rich-test-editor]")).not.toBeNull();
	expect(richProps.at(-1)?.value).toBe("| a | b |\n| --- | --- |\n| 1 | 3 |\n");
	expect(host.querySelector("[data-spec-rich-blocked]")).toBeNull();
});

test("rich mode on content it cannot keep renders read-only and offers source", async () => {
	const text = "段落\n\n<!-- 注释 -->\n\n- [ ] 待办\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
	await mount("design.md", text);
	await switchMode("rich");
	expect(richEditor).not.toHaveBeenCalled();
	expect(sourceEditor()).toBeNull();
	const notice = host.querySelector("[data-spec-rich-blocked]");
	expect(notice?.getAttribute("data-spec-rich-blocked")).toBe("html taskList");
	expect(notice?.textContent).toContain("HTML, task-list checkboxes");
	expect(host.querySelector("table")?.textContent).toContain("2");
	const back = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === en.spec.richBlockedSwitch,
	);
	await act(async () => {
		back?.dispatchEvent(new Event("click", { bubbles: true }));
	});
	expect(sourceEditor()?.props.initialValue).toBe(text);
	expect(changes).toEqual([]);
});

test("a preferred rich mode falls back to source for content it cannot keep", async () => {
	await mount("design.md", "![图](x.png)\n", "rich");
	expect(sourceEditor()?.props.initialValue).toBe("![图](x.png)\n");
	expect(richEditor).not.toHaveBeenCalled();
	await mount("design.md", "plain\n", "rich");
	expect(sourceEditor()).toBeNull();
	expect(richProps.at(-1)?.value).toBe("plain\n");
});

test("a save echo keeps the source document; new server text replaces it", async () => {
	await mount("design.md", "v1\n");
	const first = sourceEditor();
	await act(async () => first?.edit("v2\n"));
	// The save comes back as a new revision with the same text: same Monaco document.
	await act(async () => setServer("spec://design.md:r2", "v2\n"));
	expect(sourceEditor()).toBe(first);
	// An agent edit (or a reload) brings different text: Monaco gets a fresh document.
	await act(async () => setServer("spec://design.md:r3", "v3 by agent\n"));
	const second = sourceEditor();
	expect(second).not.toBe(first);
	expect(second?.props.initialValue).toBe("v3 by agent\n");
	expect(changes).toEqual(["v2\n"]);
});
