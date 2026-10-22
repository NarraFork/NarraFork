import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	EditorCommitResult,
	EditorDocumentDescriptor,
	EditorOperationResult,
	EditorSaveResult,
} from "@shared/editor-document";
import type { FileReferenceEditorSelection, FileSelection } from "@shared/file-reference";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DockviewApi, IDockviewPanelProps, SerializedDockview } from "dockview-react";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import * as viewport from "../../../hooks/useMobileViewport";
import * as apiModule from "../../../lib/api";
import { ApiError, api } from "../../../lib/api";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { fileReferenceApi } from "../../../lib/api/file-references";
import * as fileDownload from "../../../lib/file-download";
import en from "../../../locales/en/narrator.json";
import {
	FileReferenceScopeProvider,
	type FileReferenceScopeValue,
} from "../composer/FileReferenceScope";
import {
	NarratorDockContext,
	type NarratorDockContextValue,
	NarratorDockProvider,
	useNarratorDockContext,
} from "../dock/NarratorDockContext";
import { FileDockPanel, useFilePanelSelectionPublisher } from "../dock/panels";
import {
	type FilePanelOpener,
	useFilePanelSourceOpener,
} from "../file-panel/file-panel-navigation";
import {
	FileViewerContent,
	type FileViewerContentProps,
	MAX_FILE_VIEWER_TEXT_CHARS,
} from "../file-viewer/FileViewerContent";
import { NarratorPanelVisibilityProvider } from "../narrator-panel-visibility";
import { stripIdentityFromLayout, stripNavigationFromLayout } from "../panels/layout-envelope";
import type { FilePanelParams } from "../panels/panel-kind";
import { WorkspaceDockStore } from "../workspace/workspace-dock";
import { editorDocumentRegistry } from "./editor-document-registry";
import * as snapshots from "./editor-worker-client";
import * as workingCopies from "./editor-working-copy";
import { FileEditorContent, type FileEditorContentProps } from "./FileEditorContent";
import { mountedTestModels, TestEditorModel, TestMonacoEditor } from "./file-editor-test-model";
// Only the Monaco browser boundary/worker transport and I/O are mocked. The real
// component, session controller, dock ownership and preview renderer run below.
// Real Monaco tokenization/navigation/IME/search are covered by the Chromium fixture.
import * as monacoComponent from "./MonacoEditor";
import * as searchComponent from "./MonacoSearchPanel";
import * as monacoScroll from "./monaco-scroll";

const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");

const i18n = i18next.createInstance();
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let host: HTMLDivElement;
const selection: FileSelection = {
	startLineNumber: 2,
	startColumn: 1,
	endLineNumber: 2,
	endColumn: 2,
};
const source = Object.freeze({
	target: { deviceId: "local", path: "/work/a.txt" },
	fileName: "a.txt",
	content: "a\r\nb\r\n",
	encoding: "utf-16le",
	hash: "raw-server-byte-hash",
});
const descriptor: EditorDocumentDescriptor = {
	docId: "doc",
	target: source.target,
	versionHandle: "v1",
	baseHash: source.hash,
	encoding: source.encoding,
	eol: "CRLF",
	sourceBytes: 12,
	utf8Bytes: 4,
};
let preview: ReturnType<typeof spyOn<typeof fileReferenceApi, "preview">>;
let create: ReturnType<typeof spyOn<typeof editorDocumentApi, "create">>;
let readMode: ReturnType<typeof spyOn<typeof editorDocumentApi, "readMode">>;
let read: ReturnType<typeof spyOn<typeof editorDocumentApi, "source">>;
let release: ReturnType<typeof spyOn<typeof editorDocumentApi, "release">>;
let beginUpload: ReturnType<typeof spyOn<typeof editorDocumentApi, "createUpload">>;
let upload: ReturnType<typeof spyOn<typeof editorDocumentApi, "upload">>;
let commit: ReturnType<typeof spyOn<typeof editorDocumentApi, "commit">>;
let legacyWrite: ReturnType<typeof spyOn<typeof api, "fsWrite">>;
const restores: (() => void)[] = [];
const dirty = mock((_value: boolean) => {});
const publish = mock((_value: FileReferenceEditorSelection | null) => {});
const confirmReload = mock((_message: string) => true);
let uploadedRevision = 0;

beforeEach(async () => {
	originalGlobals.set(
		"OffscreenCanvas",
		Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas"),
	);
	installCanvasStub();
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "getSelection", { value: () => null });
	Object.defineProperty(window.document, "hasFocus", { value: () => false });
	Object.defineProperty(window.HTMLInputElement.prototype, "select", {
		configurable: true,
		value() {},
	});
	const overrides = {
		window,
		confirm: confirmReload,
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
	const factory = spyOn(workingCopies, "createWorkingCopyModel").mockImplementation(
		async (filePath, documentKey) =>
			new TestEditorModel({ filePath, documentKey, initialValue: "" }).getModel(),
	);
	restores.push(() => factory.mockRestore());
	const monaco = spyOn(monacoComponent, "MonacoEditor").mockImplementation(TestMonacoEditor);
	const search = spyOn(searchComponent, "MonacoSearchPanel").mockImplementation(({ readOnly }) => (
		<div data-editor-search-panel data-read-only={readOnly} />
	));
	restores.push(
		() => monaco.mockRestore(),
		() => search.mockRestore(),
	);
	dirty.mockClear();
	publish.mockClear();
	confirmReload.mockReset();
	confirmReload.mockReturnValue(true);
	const info = spyOn(fileReferenceApi, "info").mockImplementation(async (_narrator, target) => ({
		target,
		fileName: "a.txt",
		size: 12,
	}));
	restores.push(() => info.mockRestore());
	preview = spyOn(fileReferenceApi, "preview").mockResolvedValue(source);
	readMode = spyOn(editorDocumentApi, "readMode").mockResolvedValue("raw-v2");
	create = spyOn(editorDocumentApi, "create").mockImplementation(async (_narrator, input) => ({
		...descriptor,
		target: { deviceId: input.deviceId ?? "local", path: input.path },
	}));
	read = spyOn(editorDocumentApi, "source").mockResolvedValue("a\nb\n");
	beginUpload = spyOn(editorDocumentApi, "createUpload").mockImplementation(
		async (_narrator, _doc, input) => {
			uploadedRevision = input.snapshotRevision;
			return { uploadId: "upload", state: "uploading" };
		},
	);
	upload = spyOn(editorDocumentApi, "upload").mockResolvedValue({
		uploadId: "upload",
		state: "sealed",
	});
	commit = spyOn(editorDocumentApi, "commit").mockImplementation(async () => ({
		status: "saved",
		operationId: "op",
		hash: "saved-byte-hash",
		bytes: 12,
		snapshotRevision: uploadedRevision,
	}));
	legacyWrite = spyOn(api, "fsWrite").mockRejectedValue(new Error("Legacy writes are forbidden"));
	release = spyOn(editorDocumentApi, "release").mockResolvedValue({});
	const cancel = spyOn(editorDocumentApi, "cancelUpload").mockResolvedValue({ state: "cancelled" });
	const encoder = spyOn(snapshots, "encodeEditorSnapshot").mockImplementation(
		async (snapshot, signal) => {
			signal?.throwIfAborted();
			const chunks: string[] = [];
			for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) chunks.push(chunk);
			return new Blob(chunks);
		},
	);
	for (const spy of [
		preview,
		readMode,
		create,
		read,
		beginUpload,
		upload,
		commit,
		legacyWrite,
		release,
		cancel,
		encoder,
	])
		restores.push(() => spy.mockRestore());
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		editorDocumentRegistry.shutdown();
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
test("default raw preference honors a legacy executor's authorized bounded-preview capability", async () => {
	readMode.mockResolvedValue("bounded-preview");
	const model = await mount({ deviceId: "remote", rawProtocol: true });
	expect(readMode).toHaveBeenCalled();
	expect(preview).toHaveBeenCalledWith(
		"narrator",
		{ deviceId: "remote", path: source.target.path },
		expect.any(AbortSignal),
	);
	expect(create).not.toHaveBeenCalled();
	expect(beginUpload).not.toHaveBeenCalled();
	expect(model.props.readOnly).toBe(true);
});

async function mount(
	props: Partial<FileEditorContentProps> = {},
	referenceScope: FileReferenceScopeValue = {},
) {
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<FileReferenceScopeProvider value={referenceScope}>
						<FileEditorContent
							rawProtocol={false}
							filePath={source.target.path}
							narratorId="narrator"
							referenceOrigin
							selection={selection}
							onDirtyChange={dirty}
							onFileReferenceSelectionChange={publish}
							{...props}
						/>
					</FileReferenceScopeProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	const key = host.querySelector("[data-monaco-test-editor]")?.getAttribute("data-document-key");
	const model = key ? mountedTestModels.get(key) : null;
	if (!model) throw new Error(`Editor missing: ${host.textContent}`);
	return model;
}
function iconButton(icon: string) {
	const button = host.querySelector(`.tabler-icon-${icon}`)?.closest("button");
	if (!button) throw new Error(`Missing ${icon} button`);
	return button;
}
async function click(button: HTMLButtonElement) {
	await act(async () => {
		button.dispatchEvent(new Event("click", { bubbles: true }));
	});
}
async function edit(model: TestEditorModel, text: string) {
	await act(async () => {
		model.edit(text);
		model.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 });
	});
}
function currentSelection() {
	return publish.mock.calls.at(-1)?.[0];
}
function expectClean(hash: string, hasSelection = true) {
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
	expect(host.textContent).not.toContain(en["fileEditor.unsaved"]);
	expect(iconButton("device-floppy").disabled).toBe(true);
	if (hasSelection) expect(currentSelection()).toMatchObject({ expectedHash: hash, dirty: false });
	else expect(currentSelection()).toBeNull();
}
async function switchFileMode(mode: "raw" | "preview" | "node" | "split") {
	const input = host.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`);
	if (!input) throw new Error(`Missing mode ${mode}`);
	await act(async () => {
		input.checked = true;
		input.dispatchEvent(new Event("click", { bubbles: true }));
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { resolve, promise };
}
test("gutter quote uses this document and clicked range, never the shared selection", async () => {
	const addReference = mock((_reference: unknown) => {});
	const model = await mount(
		{},
		{
			addReference,
			selection: {
				target: { deviceId: "other-device", path: "/other/file", selection },
				label: "other",
				expectedHash: "other-hash",
				dirty: false,
			},
		},
	);
	expect(model.props.quoteSelectionDisabledReason).toBeNull();
	const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 };
	model.props.onQuoteSelection?.(range);
	expect(addReference).toHaveBeenCalledTimes(1);
	expect(addReference.mock.calls[0][0]).toEqual({
		id: expect.any(String),
		...source.target,
		label: "a.txt",
		selection: range,
		expectedHash: source.hash,
	});
	model.props.onQuoteSelection?.(range);
	expect(addReference.mock.calls[1][0]).not.toEqual(addReference.mock.calls[0][0]);
	model.props.onQuoteSelection?.({ ...range, endLineNumber: 1, endColumn: 1 });
	expect(addReference).toHaveBeenCalledTimes(2);
});

test("simultaneous panes quote independent files into their own composer scopes", async () => {
	const addA = mock((_reference: unknown) => {});
	const addB = mock((_reference: unknown) => {});
	create.mockImplementation(async (_narrator, input) => ({
		...descriptor,
		target: { deviceId: "local", path: input.path },
		baseHash: `hash:${input.path}`,
	}));
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<FileReferenceScopeProvider value={{ narratorId: "composer-a", addReference: addA }}>
						<FileEditorContent
							rawProtocol={false}
							filePath="/work/a.txt"
							narratorId="source-a"
							onFileReferenceSelectionChange={publish}
						/>
					</FileReferenceScopeProvider>
					<FileReferenceScopeProvider value={{ narratorId: "composer-b", addReference: addB }}>
						<FileEditorContent
							rawProtocol={false}
							filePath="/work/b.txt"
							narratorId="source-b"
							onFileReferenceSelectionChange={publish}
						/>
					</FileReferenceScopeProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	const [a, b] = [...mountedTestModels.values()];
	await act(async () => b.select(selection));
	expect(currentSelection()).toMatchObject({ target: { path: "/work/b.txt" } });
	a.props.onQuoteSelection?.(selection);
	b.props.onQuoteSelection?.(selection);
	expect(addA).toHaveBeenCalledTimes(1);
	expect(addB).toHaveBeenCalledTimes(1);
	expect(addA.mock.calls[0][0]).toMatchObject({
		path: "/work/a.txt",
		expectedHash: "hash:/work/a.txt",
	});
	expect(addB.mock.calls[0][0]).toMatchObject({
		path: "/work/b.txt",
		expectedHash: "hash:/work/b.txt",
	});
});

test("gutter quote hard-rejects edits/save-start before React commits, then uses saved hash", async () => {
	const addReference = mock((_reference: unknown) => {});
	const model = await mount({}, { addReference });
	const quote = model.props.onQuoteSelection;
	expect(quote).toBeFunction();
	await act(async () => {
		model.edit("changed\nb\n");
		quote?.(selection);
		expect(addReference).not.toHaveBeenCalled();
	});
	expect(model.props.quoteSelectionDisabledReason).toBe(en.quote.fileUnsaved);
	const pending = deferred<EditorCommitResult>();
	commit.mockImplementation(() => pending.promise);
	await act(async () => {
		model.props.onSave?.();
		model.undo(); // Clean baseline still cannot be quoted during an in-flight save.
		quote?.(selection);
		expect(addReference).not.toHaveBeenCalled();
	});
	expect(model.props.quoteSelectionDisabledReason).toBe(en["fileEditor.saveTask"]);
	await act(async () => model.redo());
	await act(async () =>
		pending.resolve({
			status: "saved",
			operationId: "op",
			hash: "quoted-saved-hash",
			bytes: 12,
			snapshotRevision: uploadedRevision,
		}),
	);
	expect(model.props.quoteSelectionDisabledReason).toBeNull();
	quote?.(selection);
	expect(addReference.mock.calls[0][0]).toMatchObject({ expectedHash: "quoted-saved-hash" });
});

test("gutter quote immediately rejects a reload and resumes only after the same read completes", async () => {
	const addReference = mock((_reference: unknown) => {});
	const model = await mount({}, { addReference });
	const quote = model.props.onQuoteSelection;
	const pending = deferred<string>();
	read.mockImplementation(() => pending.promise);
	await act(async () => {
		iconButton("refresh").dispatchEvent(new Event("click", { bubbles: true }));
		quote?.(selection);
		expect(addReference).not.toHaveBeenCalled();
	});
	expect(model.props.quoteSelectionDisabledReason).toBeTruthy();
	await act(async () => pending.resolve("reloaded\nb\n"));
	expect(model.props.quoteSelectionDisabledReason).toBeNull();
	quote?.(selection);
	expect(addReference).toHaveBeenCalledTimes(1);
});

test("gutter quote rejects a loaded document without a saved hash", async () => {
	const addReference = mock((_reference: unknown) => {});
	create.mockResolvedValue({ ...descriptor, baseHash: "" });
	const model = await mount({}, { addReference });
	expect(model.props.quoteSelectionDisabledReason).toBe(
		i18n.t("quote.fileUnavailable", { ns: "narrator" }),
	);
	model.props.onQuoteSelection?.(selection);
	expect(addReference).not.toHaveBeenCalled();
});

test("shared working-copy gutter quote uses the authorized canonical target", async () => {
	const addReference = mock((_reference: unknown) => {});
	const target = { deviceId: "local", path: "/canonical/resolved.txt" };
	create.mockResolvedValue({ ...descriptor, target });
	const model = await mount({}, { addReference });
	model.props.onQuoteSelection?.(selection);
	expect(addReference.mock.calls[0][0]).toMatchObject({
		...target,
		label: "resolved.txt",
		selection,
		expectedHash: descriptor.baseHash,
	});
});

test("gutter quote rejects the retired working copy synchronously", async () => {
	const addReference = mock((_reference: unknown) => {});
	const model = await mount({}, { addReference });
	const quote = model.props.onQuoteSelection;
	await act(async () => {
		editorDocumentRegistry.invalidateNarrator("narrator", "source context retired");
		quote?.(selection);
		expect(addReference).not.toHaveBeenCalled();
	});
});

test("remote readonly gutter quote uses canonical target and matching response hash", async () => {
	const addReference = mock((_reference: unknown) => {});
	const target = { deviceId: "remote-source", path: "C:/canonical/a.txt" };
	preview.mockResolvedValue({ ...source, target, hash: "remote-byte-hash" });
	const model = await mount({ deviceId: "remote-request" }, { addReference });
	expect(model.props.readOnly).toBe(true);
	expect(model.props.quoteSelectionDisabledReason).toBeNull();
	model.props.onQuoteSelection?.(selection);
	expect(addReference.mock.calls[0][0]).toMatchObject({
		...target,
		selection,
		expectedHash: "remote-byte-hash",
	});
});

test("gutter quote is absent without an owning composer and disposed callbacks cannot retarget", async () => {
	const noReceiver = await mount();
	expect(noReceiver.props.onQuoteSelection).toBeUndefined();
	const first = mock((_reference: unknown) => {});
	const second = mock((_reference: unknown) => {});
	const a = await mount({}, { addReference: first });
	const staleQuote = a.props.onQuoteSelection;
	const b = await mount({ filePath: "/work/b.txt" }, { addReference: second });
	staleQuote?.(selection);
	expect(first).not.toHaveBeenCalled();
	expect(second).not.toHaveBeenCalled();
	b.props.onQuoteSelection?.(selection);
	expect(second.mock.calls[0][0]).toMatchObject({ path: "/work/b.txt", expectedHash: source.hash });
});

async function mountViewer(
	props: Partial<FileViewerContentProps> = {},
	referenceScope: FileReferenceScopeValue = {},
) {
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<FileReferenceScopeProvider value={referenceScope}>
						<FileViewerContent
							filePath={source.target.path}
							narratorId="source-narrator"
							referenceOrigin
							selection={selection}
							{...props}
						/>
					</FileReferenceScopeProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	const key = host.querySelector("[data-monaco-test-editor]")?.getAttribute("data-document-key");
	const model = key ? mountedTestModels.get(key) : null;
	if (!model) throw new Error(`Viewer missing: ${host.textContent}`);
	return model;
}

test("legacy/mobile readonly viewer quotes matching canonical target/hash into its own scope", async () => {
	const addReference = mock((_reference: unknown) => {});
	const target = { deviceId: "remote-canonical", path: "C:/canonical/view.txt" };
	preview.mockResolvedValue({ ...source, target, hash: "viewer-byte-hash" });
	const model = await mountViewer(
		{ deviceId: "remote" },
		{ narratorId: "owning-composer", addReference },
	);
	expect(model.props.readOnly).toBe(true);
	expect(model.props.quoteSelectionDisabledReason).toBeNull();
	model.props.onQuoteSelection?.(selection);
	expect(addReference.mock.calls[0][0]).toEqual({
		id: expect.any(String),
		...target,
		selection,
		label: "view.txt",
		expectedHash: "viewer-byte-hash",
	});
	expect(preview.mock.calls[0][0]).toBe("source-narrator");
});

test("readonly viewer has no gutter action without a receiver and rejects a missing saved hash", async () => {
	const absent = await mountViewer();
	expect(absent.props.onQuoteSelection).toBeUndefined();
	const addReference = mock((_reference: unknown) => {});
	preview.mockResolvedValue({ ...source, hash: "" });
	const noHash = await mountViewer({ filePath: "/work/no-hash.txt" }, { addReference });
	expect(noHash.props.quoteSelectionDisabledReason).toBe(
		i18n.t("quote.fileUnavailable", { ns: "narrator" }),
	);
	noHash.props.onQuoteSelection?.(selection);
	expect(addReference).not.toHaveBeenCalled();
});

test("viewer reload and identity switch reject retained callbacks instead of mixing sources", async () => {
	const addReference = mock((_reference: unknown) => {});
	const model = await mountViewer({}, { addReference });
	const oldQuote = model.props.onQuoteSelection;
	const pending = deferred<typeof source>();
	preview.mockImplementation(() => pending.promise);
	await click(iconButton("refresh"));
	oldQuote?.(selection);
	expect(addReference).not.toHaveBeenCalled();
	await act(async () => pending.resolve(source));
	const b = await mountViewer({ filePath: "/work/b.txt" }, { addReference });
	oldQuote?.(selection);
	expect(addReference).not.toHaveBeenCalled();
	// This response deliberately canonicalizes back to a.txt; never pair its hash with b.txt.
	b.props.onQuoteSelection?.(selection);
	expect(addReference.mock.calls[0][0]).toMatchObject({
		path: "/work/a.txt",
		expectedHash: source.hash,
	});
});

test("disposed viewer callbacks cannot publish into an owning composer", async () => {
	const addReference = mock((_reference: unknown) => {});
	const model = await mountViewer({}, { addReference });
	const quote = model.props.onQuoteSelection;
	await act(async () => {
		root?.unmount();
		root = undefined;
	});
	quote?.(selection);
	expect(addReference).not.toHaveBeenCalled();
});

test("legacy local previews keep their reader policy and reject truncated/unhashed quote attempts", async () => {
	const addReference = mock((_reference: unknown) => {});
	const fetch = spyOn(apiModule, "authorizedFetch").mockResolvedValue(
		new Response("x".repeat(MAX_FILE_VIEWER_TEXT_CHARS + 1)),
	);
	restores.push(() => fetch.mockRestore());
	const model = await mountViewer({ referenceOrigin: false }, { addReference });
	expect(fetch.mock.calls[0][0]).toBe("/api/fs/preview?path=%2Fwork%2Fa.txt");
	expect(preview).not.toHaveBeenCalled();
	expect(model.props.readOnly).toBe(true);
	expect(model.props.quoteSelectionDisabledReason).toBe(
		i18n.t("quote.fileUnavailable", { ns: "narrator" }),
	);
	model.props.onQuoteSelection?.(selection);
	expect(addReference).not.toHaveBeenCalled();
});

function OwnedEditor({ filePath }: { filePath: string }) {
	const onFileReferenceSelectionChange = useFilePanelSelectionPublisher();
	return (
		<FileEditorContent
			filePath={filePath}
			narratorId="narrator"
			referenceOrigin
			onFileReferenceSelectionChange={onFileReferenceSelectionChange}
		/>
	);
}

for (const switchToA of [true, false])
	test(`pending B save ${switchToA ? "cannot steal A's selection" : "refreshes B's owned selection"}`, async () => {
		let shared: FileReferenceEditorSelection | null = null;
		const pending = deferred<EditorCommitResult>();
		commit.mockImplementation(() => pending.promise);
		function Pair({ showB }: { showB: boolean }) {
			const [fileReferenceSelection, setFileReferenceSelection] =
				useState<FileReferenceEditorSelection | null>(null);
			shared = fileReferenceSelection;
			return (
				<NarratorDockContext.Provider
					value={
						{
							narratorId: "narrator",
							fileReferenceSelection,
							setFileReferenceSelection,
						} as NarratorDockContextValue
					}
				>
					<OwnedEditor filePath="/work/a.txt" />
					{showB && <OwnedEditor filePath="/work/b.txt" />}
				</NarratorDockContext.Provider>
			);
		}
		async function renderPair(showB: boolean) {
			await act(async () =>
				root?.render(
					<I18nextProvider i18n={i18n}>
						<MantineProvider env="test">
							<Pair showB={showB} />
						</MantineProvider>
					</I18nextProvider>,
				),
			);
		}
		await renderPair(true);
		const [a, b] = [...mountedTestModels.values()];
		await edit(b, "changed B\n");
		expect(shared).toMatchObject({ target: { path: "/work/b.txt" }, dirty: true });
		await click(host.querySelectorAll<HTMLButtonElement>('button[aria-label="Save"]')[1]);
		if (switchToA) await act(async () => a.select(selection));
		await act(async () =>
			pending.resolve({
				status: "saved",
				operationId: "op",
				hash: "saved-B",
				bytes: 10,
				snapshotRevision: uploadedRevision,
			}),
		);
		expect(shared).toMatchObject(
			switchToA
				? { target: { path: "/work/a.txt" }, expectedHash: source.hash, dirty: false }
				: { target: { path: "/work/b.txt" }, expectedHash: "saved-B", dirty: false },
		);
		await act(async () => b.select(selection));
		expect(shared).toMatchObject({
			target: { path: "/work/b.txt" },
			expectedHash: "saved-B",
			dirty: false,
		});
		await act(async () => a.select(selection));
		await renderPair(false);
		expect(shared).toMatchObject({ target: { path: "/work/a.txt" } });
	});

test("old narrator publication cannot update or clear the new narrator's selection", async () => {
	let publishFromPanel: ReturnType<typeof useFilePanelSelectionPublisher> | undefined;
	const setSelection = mock((_next: FileReferenceEditorSelection | null) => {});
	const next: FileReferenceEditorSelection = {
		target: { deviceId: "local", path: "/work/a.txt", selection },
		label: "a.txt",
		expectedHash: source.hash,
		dirty: false,
	};
	function Probe() {
		publishFromPanel = useFilePanelSelectionPublisher();
		return null;
	}
	async function renderNarrator(narratorId: string) {
		await act(async () =>
			root?.render(
				<NarratorDockContext.Provider
					value={
						{
							narratorId,
							fileReferenceSelection: next,
							setFileReferenceSelection: setSelection,
						} as unknown as NarratorDockContextValue
					}
				>
					<Probe />
				</NarratorDockContext.Provider>,
			),
		);
	}
	await renderNarrator("old");
	const stalePublish = publishFromPanel;
	if (!stalePublish) throw new Error("Missing publisher");
	stalePublish(next, true);
	setSelection.mockClear();
	await renderNarrator("new");
	stalePublish({ ...next, expectedHash: "late-save" });
	stalePublish(null);
	stalePublish(next, true);
	expect(setSelection).not.toHaveBeenCalled();
	publishFromPanel?.(next, true);
	expect(setSelection).toHaveBeenCalledWith(next);
});

for (const surface of ["focus", "workspace"] as const)
	for (const lifecycle of ["live", "restored"] as const)
		test(`${surface} ${lifecycle} child file reads/writes as child while publishing selection to host`, async () => {
			const filePath = "/work/b/a.txt";
			create.mockImplementation(async (narratorId, input) => {
				const cwd = narratorId === "child" ? "/work/b/" : "/work/a/";
				if (!input.path.startsWith(cwd)) throw new ApiError("Forbidden outside cwd", 403);
				return { ...descriptor, target: { deviceId: "local", path: input.path } };
			});
			const panels = new Map<
				string,
				{
					id: string;
					params: FilePanelParams | { panelType: "narrator"; narratorId: string };
					api: object;
				}
			>();
			if (surface === "workspace")
				panels.set("parent-host", {
					id: "parent-host",
					params: { panelType: "narrator", narratorId: "parent" },
					api: { location: { type: "grid" }, setActive() {} },
				});
			const hostCount = panels.size;
			const apiRef = {
				current: {
					getPanel: (id: string) => panels.get(id),
					get panels() {
						return [
							// Workspace resources need their owning narrator cell to exist.
							{
								id: "parent-cell",
								params: { panelType: "narrator", narratorId: "parent" },
								api: { location: { type: "grid" } },
							},
							...panels.values(),
						];
					},
					groups: [],
					addPanel: ({ id, params }: { id: string; params: FilePanelParams }) => {
						const panel = {
							id,
							params,
							api: {
								location: { type: "grid" },
								setActive() {},
								updateParameters(next: FilePanelParams) {
									panel.params = next;
								},
							},
						};
						panels.set(id, panel);
					},
				} as unknown as DockviewApi,
			};
			const store = new WorkspaceDockStore(apiRef);
			let open: FilePanelOpener = (path, name, options) =>
				store.openFilePanel("parent", path, name, options);
			if (surface === "focus") {
				const captured: { current: NarratorDockContextValue | null } = { current: null };
				function Capture() {
					captured.current = useNarratorDockContext();
					return null;
				}
				renderToString(
					<NarratorDockProvider narratorId="parent">
						<Capture />
					</NarratorDockProvider>,
				);
				if (!captured.current?.openFilePanel) throw new Error("Missing focus opener");
				captured.current.apiRef.current = apiRef.current;
				open = captured.current.openFilePanel;
			}
			let childOpen: FilePanelOpener | undefined;
			function Child() {
				childOpen = useFilePanelSourceOpener(open, "child-panel", "child");
				return null;
			}
			renderToString(<Child />);
			childOpen?.(filePath, undefined, { referenceOrigin: true, selection });
			const panel = [...panels.values()].find(
				(candidate) =>
					candidate.params.panelType === "file" && candidate.params.fileNarratorId === "child",
			);
			if (!panel) throw new Error("Missing child file panel");
			childOpen?.(filePath, undefined, { referenceOrigin: true, selection });
			expect(panels.size).toBe(hostCount + 1);
			open(filePath, undefined, { referenceOrigin: true });
			expect(panels.size).toBe(hostCount + 2);
			expect(panel.params).toMatchObject({ hostNarratorId: "parent", fileNarratorId: "child" });
			let params = panel.params as unknown as FilePanelParams;
			if (lifecycle === "restored") {
				const layout = { panels: { file: { params } } } as unknown as SerializedDockview;
				params = JSON.parse(
					JSON.stringify(
						(surface === "focus" ? stripIdentityFromLayout : stripNavigationFromLayout)(layout),
					),
				).panels.file.params;
			}
			const hostSelections = mock((_next: FileReferenceEditorSelection | null) => {});
			const addReference = mock((_reference: unknown) => {});
			const hostDock = {
				narratorId: "parent",
				openFilePanel: open,
				setFileReferenceSelection: hostSelections,
				addFileReference: addReference,
			} as unknown as NarratorDockContextValue;
			const dock = hostDock;
			const props = {
				params,
				api: {
					id: panel.id,
					isVisible: true,
					onDidVisibilityChange: () => ({ dispose() {} }),
					title: "a.txt",
					close() {},
					setTitle() {},
					updateParameters() {},
					getWindow: () => window,
					group: { id: "group", element: host },
				},
				containerApi: {
					onWillDragPanel: () => ({ dispose() {} }),
					onWillDragGroup: () => ({ dispose() {} }),
				},
			} as unknown as IDockviewPanelProps<FilePanelParams>;
			await act(async () =>
				root?.render(
					<I18nextProvider i18n={i18n}>
						<MantineProvider env="test">
							<NarratorDockContext.Provider value={dock}>
								<FileDockPanel {...props} />
							</NarratorDockContext.Provider>
						</MantineProvider>
					</I18nextProvider>,
				),
			);
			// The shared entry adds one lazy boundary; flush its resolved import before
			// asserting the actual child-authorized editor session was opened.
			await act(async () => {
				await import("../file-panel/FilePanelContent");
			});
			expect(create).toHaveBeenCalledWith(
				"child",
				{
					deviceId: "local",
					path: filePath,
					origin: "reference",
					protocol: "raw-v2",
					encodingHint: undefined,
				},
				expect.any(AbortSignal),
			);
			const model = [...mountedTestModels.values()][0];
			expect(model.text).toBe("a\nb\n");
			model.props.onQuoteSelection?.(selection);
			expect(addReference).toHaveBeenCalledTimes(1);
			expect(addReference.mock.calls[0][0]).toMatchObject({
				deviceId: "local",
				path: filePath,
				selection,
				expectedHash: source.hash,
			});
			await edit(model, "child draft");
			model.props.onQuoteSelection?.(selection);
			expect(addReference).toHaveBeenCalledTimes(1);
			expect(hostSelections.mock.calls.at(-1)?.[0]).toMatchObject({
				target: { path: filePath },
				dirty: true,
			});
			await click(iconButton("device-floppy"));
			expect(beginUpload.mock.calls[0]?.[0]).toBe("child");
			expect(upload.mock.calls[0]?.[0]).toBe("child");
			expect(await upload.mock.calls[0]?.[3].text()).toBe("child draft");
			expect(legacyWrite).not.toHaveBeenCalled();
		});

test("StrictMode effect replay still loads an editable session and releases abandoned authorization", async () => {
	create.mockImplementation(async () => ({
		...descriptor,
		docId: `strict-${create.mock.calls.length}`,
		resourceKey: "strict-scope",
	}));
	await act(async () =>
		root?.render(
			<StrictMode>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<FileEditorContent filePath="/work/a.txt" narratorId="child" referenceOrigin />
					</MantineProvider>
				</I18nextProvider>
			</StrictMode>,
		),
	);
	const model = [...mountedTestModels.values()][0];
	expect(model?.text).toBe("a\nb\n");
	expect(readMode).toHaveBeenCalledTimes(2);
	expect(readMode.mock.calls[0]?.[2]?.aborted).toBe(true);
	expect(create).toHaveBeenCalledTimes(1);
	expect(read).toHaveBeenCalledTimes(1);
	expect(workingCopies.createWorkingCopyModel).toHaveBeenCalledTimes(1);
	expect(release).not.toHaveBeenCalled();
	await edit(model, "strict draft");
	await click(iconButton("device-floppy"));
	expect(await upload.mock.calls[0]?.[3].text()).toBe("strict draft");
	expect(beginUpload.mock.calls[0]?.[0]).toBe("child");
	await act(async () => root?.render(null));
	expect(model.disposed).toBe(false);
	expect(editorDocumentRegistry.diagnostics().pinReasons).toEqual({});
	editorDocumentRegistry.invalidateNarrator("child", "retired clean test context");
	await act(async () => {});
	expect(model.disposed).toBe(true);
	expect(release).toHaveBeenCalledWith("child", "strict-1");
});

for (const currentFailure of ["none", "deleted", "forbidden"] as const)
	test(`reopening after scope invalidation exposes authorized recovery when current create is ${currentFailure}`, async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(["auth", "me"], { id: "receipt-user" });
		client.setQueryData(["workspaceContext", "receipt-source"], { contextKey: "old", revision: 1 });
		const discovery = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
			recoveryKey: "receipt-user-scope",
		});
		restores.push(() => discovery.mockRestore());
		create.mockResolvedValue({
			...descriptor,
			docId: "old-receipt-doc",
			resourceKey: "old-receipt-context",
			recoveryKey: "receipt-user-scope",
		});
		const pending = deferred<EditorCommitResult>();
		commit.mockReturnValue(pending.promise);
		const receipt = spyOn(editorDocumentApi, "operation").mockResolvedValue({
			status: "uncertain",
			operationId: "old-operation",
		});
		restores.push(() => receipt.mockRestore());
		const renderEditor = async () =>
			act(async () =>
				root?.render(
					<QueryClientProvider client={client}>
						<I18nextProvider i18n={i18n}>
							<MantineProvider env="test">
								<FileEditorContent
									filePath="/work/receipt.txt"
									narratorId="receipt-source"
									referenceOrigin
								/>
							</MantineProvider>
						</I18nextProvider>
					</QueryClientProvider>,
				),
			);
		await renderEditor();
		const old = [...mountedTestModels.values()][0];
		await edit(old, "retained unsaved body");
		await click(iconButton("device-floppy"));
		expect(commit).toHaveBeenCalledTimes(1);
		await act(async () => {
			client.setQueryData(["workspaceContext", "receipt-source"], {
				contextKey: "new",
				revision: 2,
			});
		});
		await act(async () => root?.render(null));
		await act(async () => {
			pending.resolve({
				status: "saved",
				operationId: "old-operation",
				hash: "old-save-hash",
				snapshotRevision: old.revision,
				bytes: 21,
			});
		});
		receipt.mockResolvedValue({
			status: "saved",
			operationId: "old-operation",
			result: {
				status: "saved",
				diskOutcome: "applied",
				historyStatus: "unavailable",
				operationId: "old-operation",
				hash: "old-save-hash",
				snapshotRevision: old.revision,
				bytes: 21,
			},
		});
		if (currentFailure === "none")
			create.mockResolvedValue({
				...descriptor,
				docId: "new-receipt-doc",
				resourceKey: "new-receipt-context",
				recoveryKey: "receipt-user-scope",
			});
		else
			create.mockRejectedValue(
				new ApiError(currentFailure, currentFailure === "deleted" ? 404 : 403),
			);
		await renderEditor();
		const current = [...mountedTestModels.values()][0];
		expect(host.querySelector("[data-editor-retained-draft]")).not.toBeNull();
		expect(discovery).toHaveBeenCalledWith(
			"receipt-source",
			{ deviceId: "local", origin: "reference" },
			expect.any(AbortSignal),
		);
		if (currentFailure === "none") {
			expect(current).not.toBe(old);
			expect(current.text).toBe("a\nb\n");
		} else {
			expect(current).toBeUndefined();
			expect(host.textContent).toContain(currentFailure);
		}
		expect(receipt).not.toHaveBeenCalled();
		const check = [
			...host.querySelectorAll<HTMLButtonElement>("[data-editor-retained-draft] button"),
		].find((button) => button.textContent === en["fileEditor.checkSave"]);
		expect(check).toBeDefined();
		await click(check as HTMLButtonElement);
		expect(receipt).toHaveBeenCalledWith("receipt-source", "old-operation");
		expect(host.querySelector('[data-editor-retired-receipt="saved"]')).not.toBeNull();
		expect(host.querySelector("[data-editor-history-unavailable]")?.textContent).toBe(
			en.revertPlanHistoryUnavailable,
		);
		expect(old.text).toBe("retained unsaved body");
		expect(old.disposed).toBe(false);
		if (current) {
			expect(current.text).toBe("a\nb\n");
			expect(current.props.readOnly).toBe(false);
		}
		const saveDraft = spyOn(fileDownload, "saveBlobAsFile").mockImplementation(() => {});
		restores.push(() => saveDraft.mockRestore());
		const download = [
			...host.querySelectorAll<HTMLButtonElement>("[data-editor-retained-draft] button"),
		].find((button) => button.textContent === en["fileEditor.downloadRetainedDraft"]);
		await click(download as HTMLButtonElement);
		expect(await saveDraft.mock.calls[0]?.[0].text()).toBe("retained unsaved body");
		const discard = [
			...host.querySelectorAll<HTMLButtonElement>("[data-editor-retained-draft] button"),
		].find((button) => button.textContent === en["fileEditor.discardRetainedDraft"]);
		confirmReload.mockReturnValue(false);
		await click(discard as HTMLButtonElement);
		expect(old.disposed).toBe(false);
		expect(host.querySelector("[data-editor-retained-draft]")).not.toBeNull();
		confirmReload.mockReturnValue(true);
		await click(discard as HTMLButtonElement);
		expect(old.disposed).toBe(true);
		if (current) {
			expect(current.disposed).toBe(false);
			expect(current.text).toBe("a\nb\n");
		}
		expect(host.querySelector("[data-editor-retained-draft]")).toBeNull();
		expect(commit).toHaveBeenCalledTimes(1);
		await act(async () => root?.render(null));
		client.clear();
	});

async function renderRecoveryFile(filePath: string, narratorId: string) {
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<FileEditorContent filePath={filePath} narratorId={narratorId} referenceOrigin />
				</MantineProvider>
			</I18nextProvider>,
		),
	);
}

for (const access of ["different-user", "revoked"] as const)
	test(`failed current create never exposes a retained draft when independent recovery is ${access}`, async () => {
		const narratorId = `recovery-${access}`;
		const filePath = `/work/${narratorId}.txt`;
		create.mockResolvedValue({
			...descriptor,
			resourceKey: `${narratorId}-original`,
			recoveryKey: `${narratorId}-owner`,
			target: { deviceId: "local", path: filePath },
		});
		const proof = spyOn(editorDocumentApi, "recoveryScope");
		restores.push(() => proof.mockRestore());
		if (access === "revoked") proof.mockRejectedValue(new ApiError("Recovery denied", 403));
		else proof.mockResolvedValue({ recoveryKey: "another-owner" });
		await renderRecoveryFile(filePath, narratorId);
		expect(proof).toHaveBeenCalledTimes(1);
		proof.mockClear(); // reopening must obtain a fresh proof, coalesced across both recovery owners
		const old = [...mountedTestModels.values()][0];
		await edit(old, "PRIVATE RETAINED DRAFT");
		await act(async () => root?.render(null));
		create.mockRejectedValue(new ApiError("Current file refused", 403));
		await renderRecoveryFile(filePath, narratorId);
		expect(proof).toHaveBeenCalledTimes(1);
		expect(host.querySelector("[data-editor-retained-draft]")).toBeNull();
		expect(mountedTestModels.size).toBe(0);
		expect(host.textContent).not.toContain("PRIVATE RETAINED DRAFT");
		expect(host.textContent).not.toContain(en["fileEditor.downloadRetainedDraft"]);
		expect(old.text).toBe("PRIVATE RETAINED DRAFT");
		expect(old.disposed).toBe(false);
	});

test("late independent recovery proof cannot expose the old draft after the panel changes path", async () => {
	const narratorId = "recovery-late-panel";
	const oldPath = "/work/old-private.txt";
	const nextPath = "/work/new-file.txt";
	let refused = false;
	create.mockImplementation(async (_narrator, input) => {
		if (refused && input.path === oldPath) throw new ApiError("Old path refused", 403);
		return {
			...descriptor,
			resourceKey: `${narratorId}:${input.path}`,
			recoveryKey: "late-panel-owner",
			target: { deviceId: "local", path: input.path },
		};
	});
	const pending = deferred<{ recoveryKey: string }>();
	const proof = spyOn(editorDocumentApi, "recoveryScope").mockReturnValue(pending.promise);
	restores.push(() => proof.mockRestore());
	await renderRecoveryFile(oldPath, narratorId);
	expect(proof).toHaveBeenCalledTimes(1);
	proof.mockClear();
	const old = [...mountedTestModels.values()][0];
	await edit(old, "PRIVATE LATE DRAFT");
	await act(async () => root?.render(null));
	refused = true;
	await renderRecoveryFile(oldPath, narratorId);
	expect(proof).toHaveBeenCalledTimes(1);
	await renderRecoveryFile(nextPath, narratorId);
	await act(async () => {
		pending.resolve({ recoveryKey: "late-panel-owner" });
	});
	expect(proof.mock.calls[0]?.[2]?.aborted).toBe(true);
	expect(host.querySelector("[data-editor-retained-draft]")).toBeNull();
	const current = [...mountedTestModels.values()][0];
	expect(current.text).toBe("a\nb\n");
	expect(current.props.filePath).toBe(nextPath);
	expect(old.text).toBe("PRIVATE LATE DRAFT");
	expect(old.disposed).toBe(false);
});

for (const hostKind of ["file-panel", "standalone"] as const)
	for (const infoFailure of ["deleted", "denied", "revoked"] as const)
		test(`real ${hostKind} host recovers an owned draft outside a LargeFileGate whose info is ${infoFailure}`, async () => {
			const { FilePanelContent } = await import("../file-panel/FilePanelContent");
			const router = await import("@tanstack/react-router");
			const windowLayout = await import("../../StandaloneWindowLayout");
			const ws = await import("../../../lib/narrator-ws-manager");
			const navigate = spyOn(router, "useNavigate").mockImplementation(() => async () => {});
			const title = spyOn(windowLayout, "useStandaloneWindowTitle").mockImplementation(() => {});
			const connect = spyOn(ws.narratorWSManager, "connect").mockImplementation(() => {});
			const disconnect = spyOn(ws.narratorWSManager, "disconnect").mockImplementation(() => {});
			restores.push(
				() => navigate.mockRestore(),
				() => title.mockRestore(),
				() => connect.mockRestore(),
				() => disconnect.mockRestore(),
			);
			const { StandalonePanelWindow } = await import("../../window/StandalonePanelWindow");
			const narratorId = `host-${hostKind}-${infoFailure}`;
			const filePath = `/work/${narratorId}.txt`;
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false, staleTime: Infinity } },
			});
			for (const id of [narratorId, "display-host"])
				client.setQueryData(["narrators", id], { id, title: id });
			const info = spyOn(fileReferenceApi, "info").mockResolvedValue({
				target: { deviceId: "local", path: filePath },
				fileName: "host.txt",
				size: 12,
			});
			const page = spyOn(fileReferenceApi, "page").mockRejectedValue(
				new Error("Failed gate must not read pages"),
			);
			restores.push(() => page.mockRestore());
			const discovery = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
				recoveryKey: `${narratorId}-owner`,
			});
			restores.push(() => discovery.mockRestore());
			create.mockResolvedValue({
				...descriptor,
				docId: `${narratorId}-doc`,
				resourceKey: `${narratorId}-resource`,
				recoveryKey: `${narratorId}-owner`,
				target: { deviceId: "local", path: filePath },
			});
			const pending = deferred<EditorCommitResult>();
			commit.mockReturnValue(pending.promise);
			const receipt = spyOn(editorDocumentApi, "operation").mockImplementation(async () => ({
				status: "saved",
				operationId: `${narratorId}-operation`,
				result: {
					status: "saved",
					operationId: `${narratorId}-operation`,
					hash: "saved",
					snapshotRevision: uploadedRevision,
					bytes: 19,
				},
			}));
			restores.push(() => receipt.mockRestore());
			const renderHost = async () =>
				act(async () =>
					root?.render(
						<QueryClientProvider client={client}>
							<I18nextProvider i18n={i18n}>
								<MantineProvider env="test">
									{hostKind === "file-panel" ? (
										<FilePanelContent filePath={filePath} narratorId={narratorId} referenceOrigin />
									) : (
										<StandalonePanelWindow
											descriptor={{
												panelType: "file",
												filePath,
												fileNarratorId: narratorId,
												hostNarratorId: "display-host",
												referenceOrigin: true,
											}}
										/>
									)}
								</MantineProvider>
							</I18nextProvider>
						</QueryClientProvider>,
					),
				);
			await renderHost();
			expect(discovery).toHaveBeenCalledTimes(1);
			discovery.mockClear();
			const old = [...mountedTestModels.values()][0];
			expect(old).toBeDefined();
			await edit(old, "PRIVATE HOST DRAFT");
			await click(iconButton("device-floppy"));
			await act(async () => root?.render(null));
			info.mockRejectedValue(
				new ApiError(`Host info ${infoFailure}`, infoFailure === "deleted" ? 404 : 403),
			);
			if (infoFailure === "revoked")
				discovery.mockRejectedValue(new ApiError("Recovery ACL revoked", 403));
			create.mockRejectedValue(new Error("Gate must not create a current document"));
			await renderHost();
			expect(info).toHaveBeenCalledTimes(2);
			expect(info.mock.calls[1]?.[0]).toBe(narratorId);
			expect(host.textContent).toContain(`Host info ${infoFailure}`);
			if (infoFailure === "revoked") {
				expect(host.querySelector("[data-editor-retained-draft]")).toBeNull();
				expect(host.textContent).not.toContain(en["fileEditor.downloadRetainedDraft"]);
				expect(discovery).toHaveBeenCalledTimes(1);
				expect(create).toHaveBeenCalledTimes(1);
				expect(read).toHaveBeenCalledTimes(1);
				expect(page).not.toHaveBeenCalled();
				await act(async () =>
					pending.resolve({
						status: "saved",
						operationId: `${narratorId}-operation`,
						hash: "saved",
						snapshotRevision: uploadedRevision,
						bytes: 19,
					}),
				);
				expect(receipt).not.toHaveBeenCalled();
				expect(old.text).toBe("PRIVATE HOST DRAFT");
				expect(old.disposed).toBe(false);
				await act(async () => root?.render(null));
				client.clear();
				return;
			}
			expect(host.querySelector("[data-editor-retained-draft]")).not.toBeNull();
			expect(discovery).toHaveBeenCalledTimes(1);
			expect(discovery.mock.calls[0]?.[0]).toBe(narratorId);
			const retainedEntry = [
				...(Reflect.get(editorDocumentRegistry, "entries") as Set<{
					copy: workingCopies.EditorWorkingCopy;
					references: number;
					viewReferences: number;
				}>),
			].find((entry) => entry.copy.model === old.getModel());
			expect(retainedEntry?.references).toBe(1);
			expect(retainedEntry?.viewReferences).toBe(0);
			expect(workingCopies.createWorkingCopyModel).toHaveBeenCalledTimes(1);
			expect(create).toHaveBeenCalledTimes(1);
			expect(read).toHaveBeenCalledTimes(1);
			expect(page).not.toHaveBeenCalled();
			expect(mountedTestModels.size).toBe(0);
			await act(async () =>
				pending.resolve({
					status: "saved",
					operationId: `${narratorId}-operation`,
					hash: "saved",
					snapshotRevision: uploadedRevision,
					bytes: 19,
				}),
			);
			expect(receipt).not.toHaveBeenCalled();
			const check = [
				...host.querySelectorAll<HTMLButtonElement>("[data-editor-retained-draft] button"),
			].find((button) => button.textContent === en["fileEditor.checkSave"]);
			expect(check).toBeDefined();
			await click(check as HTMLButtonElement);
			expect(receipt).toHaveBeenCalledTimes(1);
			expect(host.querySelector('[data-editor-retired-receipt="saved"]')).not.toBeNull();
			expect(old.text).toBe("PRIVATE HOST DRAFT");
			const downloaded = spyOn(fileDownload, "saveBlobAsFile").mockImplementation(() => {});
			restores.push(() => downloaded.mockRestore());
			const download = [
				...host.querySelectorAll<HTMLButtonElement>("[data-editor-retained-draft] button"),
			].find((button) => button.textContent === en["fileEditor.downloadRetainedDraft"]);
			await click(download as HTMLButtonElement);
			expect(await downloaded.mock.calls[0]?.[0].text()).toBe("PRIVATE HOST DRAFT");
			const discard = [
				...host.querySelectorAll<HTMLButtonElement>("[data-editor-retained-draft] button"),
			].find((button) => button.textContent === en["fileEditor.discardRetainedDraft"]);
			await click(discard as HTMLButtonElement);
			expect(old.disposed).toBe(true);
			expect(commit).toHaveBeenCalledTimes(1);
			expect(host.querySelector("[data-editor-retained-draft]")).toBeNull();
			await act(async () => root?.render(null));
			client.clear();
		});

test("real FilePanelContent normal reopen has one recovery discovery and reuses the dirty model and undo", async () => {
	const { FilePanelContent } = await import("../file-panel/FilePanelContent");
	create.mockImplementation(async () => ({
		...descriptor,
		docId: `normal-host-${create.mock.calls.length}`,
		resourceKey: "normal-host-resource",
		recoveryKey: "normal-host-owner",
	}));
	const discovery = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
		recoveryKey: "normal-host-owner",
	});
	restores.push(() => discovery.mockRestore());
	const renderHost = async () =>
		act(async () =>
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<FilePanelContent
							filePath="/work/normal-host.txt"
							narratorId="normal-host-source"
							referenceOrigin
						/>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
	await renderHost();
	expect(discovery).toHaveBeenCalledTimes(1);
	discovery.mockClear();
	const old = [...mountedTestModels.values()][0];
	await edit(old, "same dirty draft");
	await act(async () => root?.render(null));
	await renderHost();
	const current = [...mountedTestModels.values()][0];
	expect(current).toBe(old);
	expect(current.text).toBe("same dirty draft");
	expect(current.props.readOnly).toBe(false);
	expect(host.querySelector("[data-editor-retained-draft]")).toBeNull();
	expect(discovery).toHaveBeenCalledTimes(1);
	expect(create).toHaveBeenCalledTimes(2);
	expect(read).toHaveBeenCalledTimes(1);
	expect(workingCopies.createWorkingCopyModel).toHaveBeenCalledTimes(1);
	await act(async () => current.undo());
	expect(current.text).toBe("a\nb\n");
	await act(async () => root?.render(null));
	expect(current.disposed).toBe(false);
	expect(editorDocumentRegistry.diagnostics().pinReasons).toEqual({});
	editorDocumentRegistry.invalidateNarrator("normal-host-source", "retired clean context");
	await act(async () => {});
	expect(current.disposed).toBe(true);
});

test("execution context changes visibly freeze the old dirty model without loading a new scope", async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { id: "verified-user" });
	client.setQueryData(["workspaceContext", "child"], { contextKey: "scope-a", revision: 1 });
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<FileEditorContent filePath="/work/a.txt" narratorId="child" referenceOrigin />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	const model = [...mountedTestModels.values()][0];
	await edit(model, "old-context-draft");
	await act(async () => {
		client.setQueryData(["workspaceContext", "child"], { contextKey: "scope-b", revision: 2 });
	});
	expect(model.text).toBe("old-context-draft");
	expect(model.props.readOnly).toBe(true);
	expect(host.textContent).toContain(en["fileEditor.identityChanged"]);
	expect(create).toHaveBeenCalledTimes(1);
	expect(model.disposed).toBe(false);
	await act(async () => root?.render(null));
	client.clear();
});

test("a principal cache switch authorizes a new consumer without exposing or disposing the prior dirty draft", async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { id: "first-user" });
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<FileEditorContent filePath="/work/a.txt" narratorId="child" referenceOrigin />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	const model = [...mountedTestModels.values()][0];
	await edit(model, "first-user-draft");
	await act(async () => {
		client.setQueryData(["auth", "me"], { id: "second-user" });
	});
	const current = [...mountedTestModels.values()][0];
	expect(current).not.toBe(model);
	expect(current.text).toBe("a\nb\n");
	expect(model.text).toBe("first-user-draft");
	expect(model.disposed).toBe(false);
	expect(create).toHaveBeenCalledTimes(2);
	await act(async () => root?.render(null));
	client.clear();
});

test("model identity uses the server-authorized opaque resource rather than a client path", async () => {
	create.mockResolvedValue({
		...descriptor,
		resourceKey: "authorized-child-canonical-scope",
		target: { deviceId: "local", path: "/canonical/a.txt" },
	});
	const model = await mount({ filePath: "/alias/a.txt", narratorId: "child" });
	expect(model.props.documentKey).toBe("authorized-child-canonical-scope");
});

test("large conflicts use bounded immutable prefixes and worker diff, never truncate the draft", async () => {
	const prefixRead = spyOn(editorDocumentApi, "sourcePreview").mockResolvedValue({
		content: "disk-prefix",
		truncated: true,
	});
	const difference = spyOn(snapshots, "computeEditorConflictDiff").mockResolvedValue({
		lines: [],
		truncated: true,
	});
	restores.push(
		() => prefixRead.mockRestore(),
		() => difference.mockRestore(),
	);
	const model = await mount();
	const text = "x".repeat(1024 * 1024 + 1);
	await edit(model, text);
	const flatten = spyOn(model, "getValue");
	restores.push(() => flatten.mockRestore());
	commit.mockRejectedValueOnce(
		new ApiError("Stale", 409, {
			code: "STALE_WRITE",
			currentHash: "winning",
			conflictVersionHandle: "immutable-conflict",
			encoding: "utf-8",
			size: text.length,
		}),
	);
	await click(iconButton("device-floppy"));
	expect(prefixRead).toHaveBeenCalledWith(
		"narrator",
		"doc",
		"immutable-conflict",
		expect.any(AbortSignal),
	);
	expect(difference.mock.calls[0]?.[0]).toBe("disk-prefix");
	expect(difference.mock.calls[0]?.[1].length).toBe(32768);
	expect(host.textContent).toContain(i18n.t("fileEditor.conflictDiffLimited", { ns: "narrator" }));
	expect(host.textContent).toContain("Download full conflict version");
	expect(flatten).not.toHaveBeenCalled();
	expect(model.text).toBe(text);
	expect(currentSelection()?.expectedHash).toBe(source.hash);
	const mine = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === en["fileEditor.conflictKeepMine"],
	);
	if (!mine) throw new Error("Missing keep-mine choice");
	await click(mine);
	expect(model.text).toBe(text);
	expect(currentSelection()?.expectedHash).toBe("winning");
	await click(iconButton("device-floppy"));
	expect(await upload.mock.calls.at(-1)?.[3].text()).toBe(text);
});

test("conflict preview failure preserves draft and prevents an unseen keep-mine decision", async () => {
	const prefixRead = spyOn(editorDocumentApi, "sourcePreview").mockRejectedValue(
		new Error("conflict source unavailable"),
	);
	restores.push(() => prefixRead.mockRestore());
	const model = await mount();
	await edit(model, "mine");
	commit.mockRejectedValueOnce(
		new ApiError("Stale", 409, {
			code: "STALE_WRITE",
			currentHash: "winning",
			conflictVersionHandle: "immutable-conflict",
			encoding: "utf-8",
			size: 9,
		}),
	);
	await click(iconButton("device-floppy"));
	expect(host.textContent).toContain("conflict source unavailable");
	const mine = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === en["fileEditor.conflictKeepMine"],
	);
	expect(mine?.disabled).toBe(true);
	expect(model.text).toBe("mine");
	expect(currentSelection()?.expectedHash).toBe(source.hash);
});

test("reference CRLF loads clean with raw hash/encoding, preserving source narrator and reference authorization", async () => {
	const model = await mount();
	expectClean(source.hash, false);
	expect(model.selected).toBeNull();
	expect(model.text).toBe("a\nb\n");
	expect(create.mock.calls[0]?.[1].origin).toBe("reference");
	expect(preview).not.toHaveBeenCalled();
	await act(async () => model.select(selection));
	expect(currentSelection()?.target.selection).toEqual(selection);
	await edit(model, "a\nchanged\n");
	expect(currentSelection()).toMatchObject({ expectedHash: source.hash, dirty: true });
	await click(iconButton("device-floppy"));
	expect(beginUpload.mock.calls[0]?.[2]).toMatchObject({
		baseHash: source.hash,
		encoding: source.encoding,
	});
	expect(await upload.mock.calls[0]?.[3].text()).toBe("a\nchanged\n");
	expectClean("saved-byte-hash");
});

test("editor toolbar shows the full path and truncates its right end", async () => {
	await mount();
	const path = host.querySelector<HTMLElement>(`[title="${source.target.path}"]`);
	expect(path?.textContent).toBe(source.target.path);
	expect(path?.getAttribute("data-truncate")).toBe("end");
	expect(path?.style.minWidth).toBe("0");
	expect(path?.style.flex).toBe("1");
});

test("mobile toolbar puts the path on its own row and keeps all actions scrollable", async () => {
	const mobileViewport = spyOn(viewport, "useMobileViewport").mockReturnValue(true);
	restores.push(() => mobileViewport.mockRestore());
	await mount({ referenceOrigin: false });
	const path = host.querySelector<HTMLElement>(`[title="${source.target.path}"]`);
	expect(path?.parentElement?.style.flexBasis).toBe("100%");
	const actions = iconButton("copy").parentElement;
	expect(actions?.style.width).toBe("max-content");
	expect(actions?.parentElement?.style.overflowX).toBe("auto");
	for (const icon of [
		"download",
		"device-floppy",
		"arrow-back-up",
		"arrow-forward-up",
		"search",
		"text-wrap",
		"refresh",
	])
		expect(iconButton(icon)).not.toBeNull();
});

test("typing publishes the exit guard before React commits the updated toolbar", async () => {
	const model = await mount();
	await act(async () => {
		model.edit("new unsaved draft");
		expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	});
});

test("editor toolbar copies the complete file path with feedback", async () => {
	const writeText = mock(async (_text: string) => {});
	const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
	restores.push(() => {
		if (previous) Object.defineProperty(navigator, "clipboard", previous);
		else Reflect.deleteProperty(navigator, "clipboard");
	});
	await mount();
	await click(iconButton("copy"));
	expect(writeText.mock.calls).toEqual([[source.target.path]]);
	expect(host.querySelector(".tabler-icon-check")).not.toBeNull();
});

test("editor downloads disk bytes without saving or changing the unsaved draft", async () => {
	const blob = new Blob(["complete disk bytes"]);
	const download = spyOn(api, "fsDownload").mockResolvedValue({ blob, fileName: "served.txt" });
	const saveBlob = spyOn(fileDownload, "saveBlobAsFile").mockImplementation(() => {});
	restores.push(
		() => download.mockRestore(),
		() => saveBlob.mockRestore(),
	);
	const model = await mount({ referenceOrigin: false });
	await edit(model, "unsaved draft");
	await click(iconButton("download"));
	expect(download.mock.calls).toEqual([[source.target.path]]);
	expect(saveBlob.mock.calls).toEqual([[blob, "served.txt"]]);
	expect(model.getValue()).toBe("unsaved draft");
	expect(commit).not.toHaveBeenCalled();
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
});

test("scoped editor keeps path copying but does not expose broad local downloads", async () => {
	await mount();
	expect(iconButton("copy")).not.toBeNull();
	expect(host.querySelector(".tabler-icon-download")).toBeNull();
});

test("local legacy-origin narrator files still use the authorized large-file session", async () => {
	await mount({ referenceOrigin: false });
	expect(create.mock.calls[0]?.[1].origin).toBe("legacy");
	expect(preview).not.toHaveBeenCalled();
	expect(legacyWrite).not.toHaveBeenCalled();
});

test("reference upgrade creates a new authority without rebinding or discarding the old dirty model", async () => {
	const model = await mount({ referenceOrigin: false });
	await edit(model, "draft");
	const referenceModel = await mount({ referenceOrigin: true });
	expect(referenceModel).not.toBe(model);
	expect(create).toHaveBeenCalledTimes(2);
	expect(model.text).toBe("draft");
	expect(model.disposed).toBe(false);
	expect(referenceModel.text).toBe("a\nb\n");
	expect(create.mock.calls[1]?.[1].origin).toBe("reference");
});

test("navigation passes independent highlights without taking text selection ownership", async () => {
	const model = await mount();
	expect(model.navigation).toEqual(selection);
	expect(model.selected).toBeNull();
	await act(async () =>
		model.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }),
	);
	expect(model.navigation).toEqual(selection);
	expect(await mount({ navigationRequestId: "again" })).toBe(model);
	expect(model.selected).toBeNull();
	expect(model.navigation).toEqual(selection);
	await mount({ selection: undefined, navigationRequestId: "file-only" });
	expect(model.navigation).toBeUndefined();
	expectClean(source.hash, false);
});

test("explicit reload resets model only once and installs new hash without resetting initialValue", async () => {
	const model = await mount();
	await edit(model, "unsaved");
	const setValue = spyOn(model, "setValue");
	const seed = model.props.initialValue;
	create.mockResolvedValue({ ...descriptor, baseHash: "reload-hash" });
	read.mockResolvedValue("c\nd\n");
	await click(iconButton("refresh"));
	expect(setValue).toHaveBeenCalledTimes(1);
	expect(model.props.initialValue).toBe(seed);
	expect(model.text).toBe("c\nd\n");
	expectClean("reload-hash", false);
	setValue.mockRestore();
});

test("reload from disk keeps markdown preview mode and re-renders the new content", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await switchFileMode("preview");
	expect(host.querySelector("[data-file-editor-preview]")).not.toBeNull();
	create.mockResolvedValue({ ...descriptor, baseHash: "reload-hash" });
	read.mockResolvedValue("# Reloaded heading\n");
	await click(iconButton("refresh"));
	const body = host.querySelector("[data-file-editor-preview]");
	expect(body).not.toBeNull();
	expect(body?.textContent).toContain("Reloaded heading");
	expect(model.text).toBe("# Reloaded heading\n");
	expectClean("reload-hash", false);
});

test("reload from disk keeps json node mode and re-renders the new content", async () => {
	const model = await mount({ filePath: "/work/a.json", selection: undefined });
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")).not.toBeNull();
	create.mockResolvedValue({ ...descriptor, baseHash: "reload-hash" });
	read.mockResolvedValue('{"reloaded":true}');
	await click(iconButton("refresh"));
	const body = host.querySelector("[data-file-editor-preview]");
	expect(body).not.toBeNull();
	expect(body?.textContent).toContain("reloaded");
	expect(model.text).toBe('{"reloaded":true}');
	expectClean("reload-hash", false);
});

test("reload keeps the current preview on screen until the reloaded content is ready", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await edit(model, "# Before reload");
	await switchFileMode("preview");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("Before reload");
	create.mockResolvedValue({ ...descriptor, baseHash: "reload-hash" });
	const gate = deferred<string>();
	read.mockReturnValue(gate.promise);
	await click(iconButton("refresh"));
	// While the disk read is still in flight, the old rendering stays mounted:
	// no loader flash, no unmounted preview.
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("Before reload");
	gate.resolve("# After reload");
	await act(async () => {});
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("After reload");
	expect(model.text).toBe("# After reload");
});

test("split mode keeps the editor interactive beside a live-updating preview", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await edit(model, "# Split heading");
	await switchFileMode("split");
	const sourceBox = host.querySelector("[data-file-editor-source]");
	expect(sourceBox?.hasAttribute("inert")).toBe(false);
	const previewBox = host.querySelector("[data-file-editor-preview]");
	expect(previewBox).not.toBeNull();
	expect(previewBox?.textContent).toContain("Split heading");
	// Split previews stamp data-line anchors on block elements for line-based
	// scroll sync (plain preview mode does not).
	expect(previewBox?.querySelector("[data-line]")).not.toBeNull();
	// Split is a live view: edits regenerate the preview after a short debounce.
	await edit(model, "# Edited live");
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 400));
	});
	expect(previewBox?.textContent).toContain("Edited live");
	expect(model.text).toBe("# Edited live");
});

test("set-as-default link saves the mode and the next panel opens with it", async () => {
	const store = new Map<string, string>();
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	restores.push(() => {
		if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		},
	});
	const defaultLink = () =>
		[...host.querySelectorAll("button")].find(
			(el) => el.textContent === en["fileEditor.setAsDefaultMode"],
		) as HTMLButtonElement | undefined;
	await mount({ filePath: "/work/a.md", selection: undefined });
	// raw IS the saved default, so no link is offered.
	expect(defaultLink()).toBeUndefined();
	await switchFileMode("split");
	const link = defaultLink();
	expect(link).toBeDefined();
	await act(async () => {
		link?.dispatchEvent(new Event("click", { bubbles: true }));
	});
	expect(store.get("narrafork_file_editor_mode")).toBe("split");
	expect(defaultLink()).toBeUndefined();
	// A fresh component (same panel reopened later) initializes from the saved default.
	await act(async () => root?.render(null));
	await mount({ filePath: "/work/a.md", selection: undefined });
	expect(host.querySelector("[data-file-editor-source]")?.hasAttribute("inert")).toBe(false);
	expect(host.querySelector("[data-file-editor-preview]")).not.toBeNull();
	expect(defaultLink()).toBeUndefined();
});

test("cancelled reload keeps dirty document, selection and undo history without reading", async () => {
	const model = await mount();
	await edit(model, "unsaved");
	const selected = model.selected;
	const history = model.undoEntries;
	confirmReload.mockReturnValue(false);
	await click(iconButton("refresh"));
	expect(confirmReload).toHaveBeenCalledWith(en["fileEditor.confirmReload"]);
	expect(create).toHaveBeenCalledTimes(1);
	expect(model.text).toBe("unsaved");
	expect(model.selected).toBe(selected);
	expect(model.undoEntries).toBe(history);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
});

test("failed reload retains mounted model and saveable draft", async () => {
	const model = await mount();
	await edit(model, "keep draft");
	read.mockRejectedValue(new Error("network unavailable"));
	await click(iconButton("refresh"));
	expect(host.textContent).toContain("network unavailable");
	expect([...mountedTestModels.values()][0]).toBe(model);
	expect(model.text).toBe("keep draft");
	expect(iconButton("device-floppy").disabled).toBe(false);
	await click(iconButton("device-floppy"));
	expect(await upload.mock.calls[0]?.[3].text()).toBe("keep draft");
});

test("late reload cannot replace queued input and restores editability after failure", async () => {
	const model = await mount();
	const pending = deferred<string>();
	read.mockImplementation(() => pending.promise);
	await click(iconButton("refresh"));
	expect(model.props.readOnly).toBe(true);
	await edit(model, "input while loading");
	await act(async () => pending.resolve("late disk"));
	expect(model.text).toBe("input while loading");
	expect(model.props.readOnly).toBe(false);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
});

test("remote files read only through the narrator-scoped bounded reference read", async () => {
	const remote = { ...source, target: { deviceId: "remote-device", path: "/work/a.txt" } };
	preview.mockResolvedValue(remote);
	const model = await mount({ deviceId: "remote-device" });
	expect(preview).toHaveBeenCalledWith(
		"narrator",
		{ deviceId: "remote-device", path: "/work/a.txt" },
		expect.any(AbortSignal),
	);
	expect(model.text).toBe("a\nb\n");
	expect(model.props.readOnly).toBe(true);
	expect(host.textContent).toContain(en["fileEditor.remoteBudget"]);
	// No editor-document session, host reader, disk probe or write path is reachable.
	expect(create).not.toHaveBeenCalled();
	expect(read).not.toHaveBeenCalled();
	expect(host.querySelector(".tabler-icon-device-floppy")).toBeNull();
	await edit(model, "attempt");
	expect(beginUpload).not.toHaveBeenCalled();
	expect(legacyWrite).not.toHaveBeenCalled();
});

test("a refused remote bounded read is reported, never replaced by a host read", async () => {
	preview.mockRejectedValue(
		new ApiError("Source file exceeds 1 MiB; partial references are not accepted", 413, {
			code: "FILE_REFERENCE_SOURCE_TOO_LARGE",
		}),
	);
	await expect(mount({ deviceId: "remote-device" })).rejects.toThrow(
		"partial references are not accepted",
	);
	expect(create).not.toHaveBeenCalled();
	expect(read).not.toHaveBeenCalled();
	expect(legacyWrite).not.toHaveBeenCalled();
});

test("scoped files with no narrator never fall back to broad/local readers", async () => {
	await expect(mount({ narratorId: undefined, deviceId: "remote-device" })).rejects.toThrow(
		en["fileEditor.missingContext"],
	);
	expect(preview).not.toHaveBeenCalled();
	expect(create).not.toHaveBeenCalled();
	expect(legacyWrite).not.toHaveBeenCalled();
});

test("real hidden grace aborts a deferred baseline hash and reveal retries to clear the dirty close guard", async () => {
	const nativeTimeout = globalThis.setTimeout;
	const nativeClear = globalThis.clearTimeout;
	const timers = new Map<ReturnType<typeof setTimeout>, { ms: number; callback: () => void }>();
	const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		ms?: number,
	) => {
		if (ms !== 750 && ms !== 1000) return nativeTimeout(callback, ms);
		const timer = nativeTimeout(() => {}, 60_000);
		timers.set(timer, { ms, callback });
		return timer;
	}) as typeof setTimeout);
	const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((
		timer: ReturnType<typeof setTimeout>,
	) => {
		timers.delete(timer);
		nativeClear(timer);
	}) as typeof clearTimeout);
	const flush = async (ms: number) =>
		act(async () => {
			for (const [timer, task] of [...timers])
				if (task.ms === ms) {
					timers.delete(timer);
					nativeClear(timer);
					task.callback();
				}
		});
	const visibleHost = spyOn(monacoScroll, "monacoHostVisible").mockReturnValue(true);
	const hash = spyOn(snapshots, "hashEditorSnapshot").mockImplementation(async (snapshot) => {
		let text = "";
		for (let chunk = snapshot.read(); chunk !== null; chunk = snapshot.read()) text += chunk;
		return text;
	});
	restores.push(() => {
		for (const timer of timers.keys()) nativeClear(timer);
		timeoutSpy.mockRestore();
		clearSpy.mockRestore();
		visibleHost.mockRestore();
		hash.mockRestore();
	});
	let hashSignal: AbortSignal | undefined;
	hash.mockImplementationOnce(async (snapshot, signal) => {
		expect(snapshot.read()).toBe("a\nb\n");
		hashSignal = signal;
		return new Promise((_resolve, reject) =>
			signal?.addEventListener("abort", () => reject(new DOMException("hidden", "AbortError")), {
				once: true,
			}),
		);
	});
	const renderVisible = async (visible: boolean) =>
		act(async () =>
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<NarratorPanelVisibilityProvider value={visible}>
							<FileEditorContent
								filePath="/work/hash-hide.txt"
								narratorId="child"
								referenceOrigin
								onDirtyChange={dirty}
							/>
						</NarratorPanelVisibilityProvider>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
	await renderVisible(true);
	const model = [...mountedTestModels.values()][0];
	Object.assign(model, { getDomNode: () => host });
	await edit(model, "c\nd\n");
	await edit(model, "a\nb\n");
	await flush(750);
	expect(hash).toHaveBeenCalledTimes(1);
	await renderVisible(false);
	expect(hashSignal?.aborted).toBe(false);
	await flush(1000);
	expect(hashSignal?.aborted).toBe(true);
	await flush(750);
	expect(hash).toHaveBeenCalledTimes(1);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	expect(model.disposed).toBe(false);
	await renderVisible(true);
	await flush(750);
	expect(hash).toHaveBeenCalledTimes(3);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
	expect(model.undoEntries).toHaveLength(2);
	expect(create).toHaveBeenCalledTimes(1);
	expect(read).toHaveBeenCalledTimes(1);
});

test("retry after a view-independent model loader failure releases the failed lease and authorizes again", async () => {
	spyOn(workingCopies, "createWorkingCopyModel").mockRejectedValueOnce(
		new Error("Monaco unavailable"),
	);
	await expect(mount()).rejects.toThrow("Monaco unavailable");
	const retryButton = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Retry",
	);
	if (!retryButton) throw new Error("Missing loader retry button");
	await click(retryButton);
	expect([...mountedTestModels.values()]).toHaveLength(1);
	expect(create).toHaveBeenCalledTimes(2);
	expect(read).toHaveBeenCalledTimes(1);
	expect(release).toHaveBeenCalled();
});

test("hiding a pending authorization cancels it and a late descriptor never starts a model or source read", async () => {
	let resolve!: (value: EditorDocumentDescriptor) => void;
	create.mockReturnValueOnce(
		new Promise((done) => {
			resolve = done;
		}),
	);
	const renderVisible = async (visible: boolean) =>
		act(async () =>
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<NarratorPanelVisibilityProvider value={visible}>
							<FileEditorContent filePath="/work/pending.txt" narratorId="child" referenceOrigin />
						</NarratorPanelVisibilityProvider>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
	await renderVisible(true);
	const signal = create.mock.calls[0]?.[2];
	await renderVisible(false);
	expect(signal?.aborted).toBe(true);
	await act(async () => resolve(descriptor));
	expect(read).not.toHaveBeenCalled();
	expect(workingCopies.createWorkingCopyModel).not.toHaveBeenCalled();
	expect(release).toHaveBeenCalledWith("child", "doc");
	await renderVisible(true);
	expect(read).toHaveBeenCalledTimes(1);
	expect([...mountedTestModels.values()]).toHaveLength(1);
});

test("hidden real panel keeps the dirty close/unload guard without continuing preview work", async () => {
	const renderVisible = async (visible: boolean) =>
		act(async () =>
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<NarratorPanelVisibilityProvider value={visible}>
							<FileEditorContent
								filePath="/work/hidden.md"
								narratorId="child"
								referenceOrigin
								onDirtyChange={dirty}
							/>
						</NarratorPanelVisibilityProvider>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
	await renderVisible(true);
	const model = [...mountedTestModels.values()][0];
	await edit(model, "# hidden dirty");
	await switchFileMode("split");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("hidden dirty");
	await renderVisible(false);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	expect(model.props.visible).toBe(false);
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).not.toContain(
		"hidden dirty",
	);
	const beforeUnload = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(beforeUnload);
	expect(beforeUnload.defaultPrevented).toBe(true);
	expect(create).toHaveBeenCalledTimes(1);
	await renderVisible(true);
	expect([...mountedTestModels.values()][0]).toBe(model);
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("hidden dirty");
});

test("hidden recovery discovery is deferred, but a visible failed gate still exposes the original safe draft", async () => {
	const { FilePanelContent } = await import("../file-panel/FilePanelContent");
	create.mockResolvedValue({
		...descriptor,
		resourceKey: "old-hidden-binding",
		recoveryKey: "verified-hidden-owner",
	});
	const old = await mount({ filePath: "/work/hidden-recovery.txt", narratorId: "child" });
	await edit(old, "never bind this old draft to a new resource");
	await act(async () => editorDocumentRegistry.invalidateNarrator("child", "workspace changed"));
	await act(async () => root?.render(null));
	create.mockClear();
	const scope = spyOn(editorDocumentApi, "recoveryScope").mockResolvedValue({
		recoveryKey: "verified-hidden-owner",
	});
	const info = spyOn(fileReferenceApi, "info").mockRejectedValue(
		new ApiError("deleted current file", 404),
	);
	restores.push(
		() => scope.mockRestore(),
		() => info.mockRestore(),
	);
	const renderVisible = async (visible: boolean) =>
		act(async () =>
			root?.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<FilePanelContent
							filePath="/work/hidden-recovery.txt"
							narratorId="child"
							referenceOrigin
							visible={visible}
						/>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
	await renderVisible(false);
	expect(info).not.toHaveBeenCalled();
	expect(create).not.toHaveBeenCalled();
	expect(scope).not.toHaveBeenCalled();
	expect(old.disposed).toBe(false);
	await renderVisible(true);
	expect(host.querySelector("[data-editor-retained-draft]")).not.toBeNull();
	expect(host.textContent).toContain("deleted current file");
	expect(create).not.toHaveBeenCalled();
	expect(scope).toHaveBeenCalledTimes(1);
	expect(old.text).toBe("never bind this old draft to a new resource");
});

for (const extension of ["txt", "md", "json"] as const)
	test(`${extension} source inherits hidden dock visibility while preserving model/selection/history`, async () => {
		const model = await mount({ filePath: `/work/draft.${extension}`, selection: undefined });
		const layer = host.querySelector<HTMLElement>("[data-file-editor-source]");
		if (!layer) throw new Error("No source");
		await edit(model, "unsaved draft\n");
		const selected = model.selected;
		const history = model.undoEntries;
		for (let cycle = 0; cycle < 2; cycle++) {
			host.style.visibility = "hidden";
			expect(layer.style.visibility).toBe("inherit");
			if (extension !== "txt") {
				await switchFileMode(extension === "md" ? "preview" : "node");
				expect(layer.style.visibility).toBe("hidden");
				expect(layer.hasAttribute("inert")).toBe(true);
				await switchFileMode("raw");
				expect(host.style.visibility).toBe("hidden");
			}
			host.style.visibility = "";
			expect(layer.style.visibility).toBe("inherit");
			expect(layer.hasAttribute("inert")).toBe(false);
			expect([...mountedTestModels.values()][0]).toBe(model);
			expect(model.selected).toBe(selected);
			expect(model.undoEntries).toBe(history);
		}
		expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(upload).not.toHaveBeenCalled();
	});

for (const extension of ["md", "json"] as const)
	test(`${extension} explicit preview snapshots unsaved text without losing model or history`, async () => {
		read.mockResolvedValue(extension === "md" ? "# Saved" : '{"name":"Saved"}');
		const model = await mount({ filePath: `/work/a.${extension}`, selection: undefined });
		const draft =
			extension === "md"
				? "# Draft heading\n\n**bold draft**"
				: '{"name":"Draft value","nested":{"enabled":true}}';
		await edit(model, draft);
		const selected = model.selected;
		const history = model.undoEntries;
		await switchFileMode(extension === "md" ? "preview" : "node");
		const body = host.querySelector("[data-file-editor-preview]");
		expect(body?.textContent).toContain(extension === "md" ? "Draft heading" : "Draft value");
		if (extension === "md") expect(body?.querySelector("h1")?.textContent).toBe("Draft heading");
		else expect(body?.querySelector('[role="tree"]')).not.toBeNull();
		await switchFileMode("raw");
		expect(model.selected).toBe(selected);
		expect(model.undoEntries).toBe(history);
		expect(create).toHaveBeenCalledTimes(1);
		await act(async () => model.undo());
		expect(model.text).toContain("Saved");
	});

test("preview text is a fixed snapshot, not a per-key renderer", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await edit(model, "# Preview snapshot");
	await switchFileMode("preview");
	await act(async () => model.edit("# New unrendered text"));
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain(
		"Preview snapshot",
	);
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).not.toContain(
		"New unrendered text",
	);
});

test("oversized JSON refuses only preview and saves the complete blob beyond the legacy 1 MiB cap", async () => {
	const model = await mount({ filePath: "/work/a.json", selection: undefined });
	const text = JSON.stringify({ text: "x".repeat(1024 * 1024) });
	await edit(model, text);
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain(
		en["fileEditor.previewTooLarge"],
	);
	await switchFileMode("raw");
	expect(model.text).toBe(text);
	await click(iconButton("device-floppy"));
	expect(await upload.mock.calls[0]?.[3].text()).toBe(text);
	expect(legacyWrite).not.toHaveBeenCalled();
});

test("invalid JSON can be fixed without dropping the model", async () => {
	const model = await mount({ filePath: "/work/a.json", selection: undefined });
	await edit(model, '{"name":');
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("not valid json");
	await switchFileMode("raw");
	await edit(model, '{"name":"fixed"}');
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("fixed");
	expect(create).toHaveBeenCalledTimes(1);
});

test("line references preserve preview switch and new navigation returns to same model", async () => {
	const model = await mount({ filePath: "/work/a.md", navigationRequestId: "first" });
	await switchFileMode("preview");
	expect(host.querySelector("[data-file-editor-preview]")).not.toBeNull();
	expect(await mount({ filePath: "/work/a.md", navigationRequestId: "second" })).toBe(model);
	expect(host.querySelector("[data-file-editor-preview]")).toBeNull();
	expect(create).toHaveBeenCalledTimes(1);
});

test("search from preview returns to source without replacing draft", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await edit(model, "# draft");
	await switchFileMode("preview");
	await click(iconButton("search"));
	expect(host.querySelector("[data-file-editor-preview]")).toBeNull();
	expect(host.querySelector("[data-editor-search-panel]")).not.toBeNull();
	expect(model.text).toBe("# draft");
	expect(create).toHaveBeenCalledTimes(1);
});

test("ordinary text exposes no preview switch; search/wrapping retain model and undo history", async () => {
	const model = await mount();
	expect(host.querySelector('input[type="radio"]')).toBeNull();
	await edit(model, "find me\nfind me");
	const selected = model.selected;
	const history = model.undoEntries;
	await click(iconButton("text-wrap"));
	expect(model.props.lineWrapping).toBe(true);
	expect(iconButton("text-wrap").getAttribute("aria-pressed")).toBe("true");
	await click(iconButton("search"));
	expect(model.selected).toBe(selected);
	expect(model.undoEntries).toBe(history);
	expect(host.querySelector("[data-editor-search-panel]")).not.toBeNull();
});

test("undo/redo buttons restore dirty state and keyboard undo updates toolbar", async () => {
	const model = await mount();
	const back = iconButton("arrow-back-up");
	const forward = iconButton("arrow-forward-up");
	expect(back.disabled).toBe(true);
	expect(forward.disabled).toBe(true);
	await edit(model, "edited");
	expect(back.disabled).toBe(false);
	await click(back);
	expect(model.text).toBe("a\nb\n");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
	expect(forward.disabled).toBe(false);
	await click(forward);
	expect(model.text).toBe("edited");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	await act(async () => model.undo());
	await edit(model, "new branch");
	expect(forward.disabled).toBe(true);
});

test("preview disables history buttons without dropping undo stack", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await edit(model, "# draft");
	await switchFileMode("preview");
	expect(iconButton("arrow-back-up").disabled).toBe(true);
	await switchFileMode("raw");
	expect(iconButton("arrow-back-up").disabled).toBe(false);
	await click(iconButton("arrow-back-up"));
	expect(model.text).toBe("a\nb\n");
});

test("remote JSON remains scoped/read-only with source/node/search and explicit 1 MiB budget", async () => {
	preview.mockResolvedValue({ ...source, content: '{"remote":"read-only value"}' });
	const model = await mount({
		filePath: "/work/a.json",
		deviceId: "remote-device",
		selection: undefined,
	});
	expect(preview.mock.calls[0]?.[0]).toBe("narrator");
	expect(preview.mock.calls[0]?.[1].deviceId).toBe("remote-device");
	expect(create).not.toHaveBeenCalled();
	expect(host.textContent).toContain("1 MiB");
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain(
		"read-only value",
	);
	await switchFileMode("raw");
	await click(iconButton("search"));
	expect(model.props.readOnly).toBe(true);
	expect(host.querySelector(".tabler-icon-device-floppy")).toBeNull();
	expect(iconButton("arrow-back-up").disabled).toBe(true);
	expect(iconButton("arrow-forward-up").disabled).toBe(true);
	expect(host.querySelector("[data-editor-search-panel]")?.getAttribute("data-read-only")).toBe(
		"true",
	);
	expect(upload).not.toHaveBeenCalled();
});

test("search-panel save delegates to the same immutable snapshot handler", async () => {
	const model = await mount();
	await edit(model, "draft from search");
	await click(iconButton("search"));
	const search = spyOn(searchComponent, "MonacoSearchPanel");
	const props = search.mock.calls.at(-1)?.[0];
	expect(props?.onSave).toBeDefined();
	await act(async () => {
		props?.onSave?.();
	});
	expect(await upload.mock.calls[0]?.[3].text()).toBe("draft from search");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
});

for (const large of [false, true]) {
	for (const recovery of [false, true]) {
		test(`${large ? "large" : "small"} ${recovery ? "polled" : "direct"} save warns about missing history while keeping saved state`, async () => {
			const show = spyOn(notifications, "show").mockReturnValue("history-gap");
			restores.push(() => show.mockRestore());
			const pendingCommit = deferred<EditorCommitResult>();
			const pendingOperation = deferred<EditorOperationResult>();
			commit.mockImplementation(() =>
				recovery
					? Promise.resolve({ status: "committing", operationId: "op" })
					: pendingCommit.promise,
			);
			const operation = spyOn(editorDocumentApi, "operation").mockImplementation(
				() => pendingOperation.promise,
			);
			restores.push(() => operation.mockRestore());
			const model = await mount();
			const text = large ? "x".repeat(1024 * 1024 + 1) : "saved snapshot";
			await edit(model, text);
			await click(iconButton("device-floppy"));
			expect(show).not.toHaveBeenCalled();
			const result: EditorSaveResult = {
				status: "saved",
				historyStatus: "unavailable",
				operationId: "op",
				hash: "history-gap-hash",
				snapshotRevision: uploadedRevision,
				bytes: text.length,
			};
			await act(async () => {
				if (recovery) pendingOperation.resolve({ status: "saved", operationId: "op", result });
				else pendingCommit.resolve(result);
			});
			expectClean("history-gap-hash");
			expect(model.text).toBe(text);
			expect(await upload.mock.calls[0]?.[3].text()).toBe(text);
			expect(show).toHaveBeenCalledTimes(1);
			expect(show.mock.calls[0][0]).toMatchObject({
				title: "a.txt",
				color: "yellow",
				message: en.revertPlanHistoryUnavailable,
			});
			expect(commit).toHaveBeenCalledTimes(1);
			expect(operation).toHaveBeenCalledTimes(recovery ? 1 : 0);
			await edit(model, "next draft");
			expect(model.text).toBe("next draft");
			expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
			expect(iconButton("device-floppy").disabled).toBe(false);
			expect(show).toHaveBeenCalledTimes(1);
			expect(legacyWrite).not.toHaveBeenCalled();
		});
	}
}

test.each([
	"complete",
	undefined,
] as const)("saved %s history avoids a fabricated history warning", async (historyStatus) => {
	const show = spyOn(notifications, "show").mockReturnValue("unused");
	restores.push(() => show.mockRestore());
	commit.mockImplementation(async () => ({
		status: "saved",
		historyStatus,
		operationId: "op",
		hash: "saved",
		snapshotRevision: uploadedRevision,
		bytes: 5,
	}));
	const model = await mount();
	await edit(model, "saved");
	await click(iconButton("device-floppy"));
	expectClean("saved");
	expect(show).not.toHaveBeenCalled();
});

test("input immediately followed by two save shortcuts captures newest version once", async () => {
	const model = await mount();
	await act(async () => {
		model.edit("latest keystroke");
		model.props.onSave?.();
		model.props.onSave?.();
	});
	expect(upload).toHaveBeenCalledTimes(1);
	expect(await upload.mock.calls[0]?.[3].text()).toBe("latest keystroke");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
});

for (const undo of [false, true])
	test(`${undo ? "undo to old baseline" : "typing"} during save retains draft and blocks exit`, async () => {
		const pending = deferred<EditorCommitResult>();
		commit.mockImplementation(() => pending.promise);
		const model = await mount();
		await edit(model, "sent");
		await click(iconButton("device-floppy"));
		if (undo) await act(async () => model.undo());
		else await edit(model, "newer draft");
		expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
		const unload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);
		await act(async () =>
			pending.resolve({
				status: "saved",
				operationId: "op",
				hash: "saved",
				snapshotRevision: uploadedRevision,
				bytes: 4,
			}),
		);
		expect(model.text).toBe(undo ? "a\nb\n" : "newer draft");
		expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
		expect(iconButton("device-floppy").disabled).toBe(false);
	});

test("ordinary typing never flattens model, changes initialValue, or republishes stable dirty selection", async () => {
	const model = await mount();
	await edit(model, "already dirty");
	const seed = model.props.initialValue;
	publish.mockClear();
	const flatten = spyOn(model, "getValue");
	const snapshot = spyOn(model, "createSnapshot");
	await act(async () => model.edit("already dirty!"));
	expect(flatten).not.toHaveBeenCalled();
	expect(snapshot).not.toHaveBeenCalled();
	expect(model.props.initialValue).toBe(seed);
	expect(publish).not.toHaveBeenCalled();
	flatten.mockRestore();
	snapshot.mockRestore();
});

test("beforeunload allows clean document and protects dirty edits", async () => {
	const model = await mount();
	const clean = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(clean);
	expect(clean.defaultPrevented).toBe(false);
	await edit(model, "dirty");
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
});

test("preview save shortcut ignores composition and otherwise submits immutable draft", async () => {
	const model = await mount({ filePath: "/work/a.md", selection: undefined });
	await edit(model, "# Draft");
	await switchFileMode("preview");
	const body = host.querySelector("[data-file-editor-preview]");
	if (!body) throw new Error("No preview");
	for (const composing of [true, false]) {
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "s", ctrlKey: true, isComposing: composing });
		await act(async () => {
			body.dispatchEvent(event);
		});
		expect(upload).toHaveBeenCalledTimes(composing ? 0 : 1);
	}
});
