import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { EditorCommitResult, EditorDocumentDescriptor } from "@shared/editor-document";
import type { FileReferenceEditorSelection, FileSelection } from "@shared/file-reference";
import type { DockviewApi, IDockviewPanelProps, SerializedDockview } from "dockview-react";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { ApiError, api } from "../../../lib/api";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { fileReferenceApi } from "../../../lib/api/file-references";
import en from "../../../locales/en/narrator.json";
import { createDetachedPanelDockValue } from "../../graph/dock/detached-panel-context";
import {
	makePanelEntry,
	parseDetachedNodes,
	serializeDetachedNodes,
} from "../../graph/dock/detached-panels";
import { readPanelSubject } from "../../graph/dock/tab-detach";
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
import { stripIdentityFromLayout, stripNavigationFromLayout } from "../panels/layout-envelope";
import type { FilePanelParams } from "../panels/panel-kind";
import { WorkspaceDockStore } from "../workspace/workspace-dock";
import * as snapshots from "./editor-worker-client";
import { FileEditorContent, type FileEditorContentProps } from "./FileEditorContent";
import {
	mountedTestModels,
	type TestEditorModel,
	TestMonacoEditor,
} from "./file-editor-test-model";

// Only the Monaco browser boundary/worker transport and I/O are mocked. The real
// component, session controller, dock ownership and preview renderer run below.
// Real Monaco tokenization/navigation/IME/search are covered by the Chromium fixture.
import * as monacoComponent from "./MonacoEditor";
import * as searchComponent from "./MonacoSearchPanel";

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
let read: ReturnType<typeof spyOn<typeof editorDocumentApi, "source">>;
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
		navigator: window.navigator,
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
	const release = spyOn(editorDocumentApi, "release").mockResolvedValue({});
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
async function mount(props: Partial<FileEditorContentProps> = {}) {
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<FileEditorContent
						filePath={source.target.path}
						narratorId="narrator"
						referenceOrigin
						selection={selection}
						onDirtyChange={dirty}
						onFileReferenceSelectionChange={publish}
						{...props}
					/>
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
	for (const lifecycle of ["live", "restored", "detached"] as const)
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
			} else if (lifecycle === "detached") {
				const subject = readPanelSubject(params);
				if (!subject?.resourceId) throw new Error("Missing drag resource");
				const entry = makePanelEntry("file", subject.resourceId);
				const nodes = parseDetachedNodes(
					serializeDetachedNodes([
						{ id: "detached", x: 0, y: 0, w: 480, h: 360, pendingPanels: [entry] },
					]),
				);
				const restored = nodes[0]?.pendingPanels?.[0];
				if (!restored?.filePath) throw new Error("Missing detached file");
				params = { ...restored, panelType: "file", filePath: restored.filePath };
			}
			const hostSelections = mock((_next: FileReferenceEditorSelection | null) => {});
			const hostDock = {
				narratorId: "parent",
				openFilePanel: open,
				setFileReferenceSelection: hostSelections,
			} as unknown as NarratorDockContextValue;
			const dock =
				lifecycle === "detached"
					? createDetachedPanelDockValue({
							narratorId: "parent",
							chapterId: "chapter",
							sourceDock: hostDock,
							apiRef,
						})
					: hostDock;
			const props = {
				params,
				api: {
					id: panel.id,
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
			expect(create).toHaveBeenCalledWith(
				"child",
				{ deviceId: "local", path: filePath, origin: "reference" },
				expect.any(AbortSignal),
			);
			const model = [...mountedTestModels.values()][0];
			expect(model.text).toBe("a\nb\n");
			await edit(model, "child draft");
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
	await edit(model, "strict draft");
	await click(iconButton("device-floppy"));
	expect(await upload.mock.calls[0]?.[3].text()).toBe("strict draft");
	expect(beginUpload.mock.calls[0]?.[0]).toBe("child");
});

test("model identity includes source narrator and canonical authorized path", async () => {
	create.mockResolvedValue({
		...descriptor,
		target: { deviceId: "local", path: "/canonical/a.txt" },
	});
	const model = await mount({ filePath: "/alias/a.txt", narratorId: "child" });
	expect(JSON.parse(model.props.documentKey)).toEqual(["child", "local", "/canonical/a.txt"]);
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

test("local legacy-origin narrator files still use the authorized large-file session", async () => {
	await mount({ referenceOrigin: false });
	expect(create.mock.calls[0]?.[1].origin).toBe("legacy");
	expect(preview).not.toHaveBeenCalled();
	expect(legacyWrite).not.toHaveBeenCalled();
});

test("reference upgrade does not reload a reused dirty model", async () => {
	const model = await mount({ referenceOrigin: false });
	await edit(model, "draft");
	expect(await mount({ referenceOrigin: true })).toBe(model);
	expect(create).toHaveBeenCalledTimes(1);
	expect(model.text).toBe("draft");
	await click(iconButton("refresh"));
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

test("scoped files with no narrator never fall back to broad/local readers", async () => {
	await expect(mount({ narratorId: undefined, deviceId: "remote-device" })).rejects.toThrow(
		en["fileEditor.missingContext"],
	);
	expect(preview).not.toHaveBeenCalled();
	expect(create).not.toHaveBeenCalled();
	expect(legacyWrite).not.toHaveBeenCalled();
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
