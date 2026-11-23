import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ToolEditPreview } from "@shared/tool-edit-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { toolCallDetailQueryKey } from "../../../lib/api/narrators";
import en from "../../../locales/en/narrator.json";
import { mountedTestModels, TestMonacoEditor } from "../file-editor/file-editor-test-model";
import * as monacoBoundary from "../file-editor/MonacoEditor";
import { ToolEditFileViewer } from "./ToolEditFileViewer";
import type { ToolEditReference } from "./tool-edit-reference";

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");

const reference: ToolEditReference = {
	narratorId: "reader",
	toolUseId: "reused-sdk",
	toolCallId: "edit-one",
	messageId: "msg-one",
	deviceId: "HistoricalRemote",
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
let editorSpy: ReturnType<typeof spyOn<typeof monacoBoundary, "MonacoEditor">>;

beforeEach(async () => {
	editorSpy = spyOn(monacoBoundary, "MonacoEditor").mockImplementation(TestMonacoEditor);
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
	editorSpy.mockRestore();
	client.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
	disposeCanvas();
});

async function mount(data: ToolEditPreview | null = preview, ref = reference, request = "first") {
	if (data)
		client.setQueryData(
			[
				...toolCallDetailQueryKey(ref.narratorId, ref.toolUseId, ref),
				"file-edit-preview",
				ref.deviceId,
			],
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
	const element = host.querySelector<HTMLElement>("[data-monaco-test-editor]");
	const model = element && mountedTestModels.get(element.dataset.documentKey ?? "");
	if (!model) throw new Error("Missing historical Monaco model");
	return model;
}

test.each([
	undefined,
	"",
	"  ",
	"local",
])("restored history resource with device=%s makes zero content requests and masks cached snapshots", async (deviceId) => {
	const fetch = spyOn(globalThis, "fetch");
	try {
		const ref = { ...reference, deviceId };
		client.setQueryData(
			[...toolCallDetailQueryKey(ref.narratorId, ref.toolUseId, ref), "file-edit-preview"],
			preview,
		);
		await mount(preview, ref);
		expect(fetch).not.toHaveBeenCalled();
		expect(editorSpy).not.toHaveBeenCalled();
		expect(host.querySelector("[role=tab]")).toBeNull();
		expect(host.textContent).not.toContain("HistoricalRemote");
		expect(host.textContent).not.toContain("first");
		expect(host.textContent).toContain(
			en[
				deviceId === "local"
					? "editPreview.reason.unsupported"
					: "editPreview.reason.identity_unverified"
			],
		);
	} finally {
		fetch.mockRestore();
	}
});

test("a verified remote target keeps the existing historical preview HTTP request", async () => {
	const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify(preview), {
			headers: { "Content-Type": "application/json" },
		}),
	);
	try {
		await mount(null);
		await act(async () => {
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		const url = new URL(String(fetch.mock.calls[0]?.[0]), "https://test.invalid");
		expect(url.pathname).toBe("/api/narrators/reader/tool-calls/reused-sdk/file-edit-preview");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			toolCallId: "edit-one",
			messageId: "msg-one",
		});
		expect(host.textContent).toContain("HistoricalRemote");
	} finally {
		fetch.mockRestore();
	}
});

test("mismatched local content cannot appear in a remote historical resource", async () => {
	await mount({ ...preview, deviceId: "local" });
	expect(host.querySelector(".nf-diff-view")).toBeNull();
	expect(host.textContent).toContain(en["editPreview.reason.identity_unverified"]);
	expect(host.textContent).not.toContain("first");
});

test("switches exact old/new versions, marks their own ranges and keeps both read-only", async () => {
	await mount();
	expect(host.textContent).toContain("HistoricalRemote");
	expect(host.textContent).not.toContain("/display-only/a.txt");
	expect(host.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Diff");
	await tab("Old");
	const oldView = editor();
	expect(oldView.getValue()).toBe("first\nold\nlast\n");
	expect(oldView.props.readOnly).toBe(true);
	expect(oldView.selected).toBeNull();
	expect(oldView.navigation?.startLineNumber).toBe(2);
	expect(oldView.navigation?.endLineNumber).toBe(3);
	await tab("New");
	const newView = editor();
	expect(newView.getValue()).toBe("first\nnew\nextra\nlast\n");
	expect(newView.props.readOnly).toBe(true);
	expect(newView.navigation?.endLineNumber).toBe(4);
	await act(async () => newView.select(null));
	await mount(preview, reference, "again");
	expect(editor()).toBe(newView);
	expect(newView.navigation?.startLineNumber).toBe(2);
	await tab("Diff");
	expect(host.querySelector("[data-monaco-test-editor]")).toBeNull();
});

test("missing one side never becomes an empty file or a fabricated diff", async () => {
	await mount({ ...preview, before: { status: "unavailable", reason: "missing_evidence" } });
	expect(host.textContent).toContain(en["editPreview.reason.missing_evidence"]);
	await tab("Old");
	expect(host.querySelector("[data-monaco-test-editor]")).toBeNull();
	await tab("New");
	expect(editor().getValue()).toBe("first\nnew\nextra\nlast\n");
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
	expect(editor().getValue()).toBe("other version");
});
