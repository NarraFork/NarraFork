import { afterEach, beforeEach, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { MantineProvider } from "@mantine/core";
import type { ToolEditPreview } from "@shared/tool-edit-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { toolCallDetailQueryKey } from "../../lib/api/narrators";
import en from "../../locales/en/narrator.json";
import { fileNavigationHighlight } from "./file-editor/file-navigation-highlight";
import { ToolEditFileViewer } from "./ToolEditFileViewer";
import type { ToolEditReference } from "./tool-edit-reference";
import { installCanvasStub } from "./vlist/measure/test-canvas-stub";

const reference: ToolEditReference = {
	narratorId: "reader",
	toolUseId: "reused-sdk",
	toolCallId: "edit-one",
	messageId: "msg-one",
};
const preview: ToolEditPreview = {
	toolCallId: "edit-one",
	toolUseId: "reused-sdk",
	filePath: "/recorded/a.txt",
	deviceId: "HistoricalRemote",
	before: { status: "available", content: "first\nold\nlast\n" },
	after: { status: "available", content: "first\nnew\nextra\nlast\n" },
	location: { startLine: 2, endLine: 2, newEndLine: 3 },
	source: "evidence",
};
const globals = new Map<string, PropertyDescriptor | undefined>();
const i18n = i18next.createInstance();
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let disposeCanvas: () => void;

beforeEach(async () => {
	disposeCanvas = installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "getSelection", { value: () => null });
	Object.defineProperty(window.document, "hasFocus", { value: () => false });
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		MutationObserver: window.MutationObserver,
		Event: window.Event,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		getSelection: () => null,
		getComputedStyle: () => ({ getPropertyValue: () => "", whiteSpace: "pre" }),
		matchMedia: (media: string) => ({
			media,
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
		fetch: () => {
			throw new Error("Historical viewer must not fetch the current file");
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	if (!i18n.isInitialized)
		await i18n.init({
			lng: "en",
			resources: { en: { narrator: en } },
			react: { useSuspense: false },
		});
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
	disposeCanvas();
});

async function mount(data = preview, ref = reference, request = "first") {
	client.setQueryData(
		[...toolCallDetailQueryKey(ref.narratorId, ref.toolUseId, ref), "file-edit-preview"],
		data,
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<ToolEditFileViewer
							reference={ref}
							filePath="/display-only/a.txt"
							navigationRequestId={request}
						/>
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
}
async function tab(label: string) {
	const button = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=tab]")).find(
		(element) => element.textContent === label,
	);
	if (!button) throw new Error(`Missing tab ${label}`);
	await act(async () => {
		button.dispatchEvent(new Event("click", { bubbles: true }));
	});
}
function editor() {
	const element = host.querySelector<HTMLElement>(".cm-editor");
	if (!element) throw new Error("Missing historical editor");
	const view = EditorView.findFromDOM(element);
	if (!view) throw new Error("Missing CodeMirror view");
	return view;
}

test("switches exact old/new versions, marks their own ranges and keeps both read-only", async () => {
	await mount();
	expect(host.textContent).toContain("HistoricalRemote");
	expect(host.textContent).not.toContain("/display-only/a.txt");
	expect(host.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Diff");
	await tab("Old");
	const oldView = editor();
	expect(oldView.state.doc.toString()).toBe("first\nold\nlast\n");
	expect(oldView.state.readOnly).toBe(true);
	expect(oldView.state.selection.main.empty).toBe(true);
	expect(oldView.state.field(fileNavigationHighlight)?.lastLine).toBe(
		oldView.state.doc.line(2).from,
	);
	await tab("New");
	const newView = editor();
	expect(newView.state.doc.toString()).toBe("first\nnew\nextra\nlast\n");
	expect(newView.state.readOnly).toBe(true);
	expect(newView.state.field(fileNavigationHighlight)?.lastLine).toBe(
		newView.state.doc.line(3).from,
	);
	await act(async () => newView.dispatch({ selection: { anchor: 0 } }));
	await mount(preview, reference, "again");
	expect(editor()).toBe(newView);
	expect(newView.state.selection.main.from).toBe(newView.state.doc.line(2).from);
	await tab("Diff");
	expect(host.querySelector(".cm-editor")).toBeNull();
});

test("missing one side never becomes an empty file or a fabricated diff", async () => {
	await mount({ ...preview, before: { status: "unavailable", reason: "missing_evidence" } });
	expect(host.textContent).toContain(en["editPreview.reason.missing_evidence"]);
	await tab("Old");
	expect(host.querySelector(".cm-editor")).toBeNull();
	await tab("New");
	expect(editor().state.doc.toString()).toBe("first\nnew\nextra\nlast\n");
});

test("absent files are distinct from unavailable data; a reused SDK id cannot retain another edit", async () => {
	await mount({ ...preview, before: { status: "absent", content: "" } });
	await tab("Old");
	expect(host.textContent).toContain(en["editPreview.absent"]);
	await mount(
		{
			...preview,
			toolCallId: "edit-two",
			after: { status: "available", content: "other version" },
		},
		{ ...reference, toolCallId: "edit-two" },
	);
	expect(host.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Diff");
	await tab("New");
	expect(editor().state.doc.toString()).toBe("other version");
});
