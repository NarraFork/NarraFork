import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { undo, undoDepth } from "@codemirror/commands";
import { getSearchQuery, SearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { MantineProvider } from "@mantine/core";
import type { FileReferenceEditorSelection, FileSelection } from "@shared/file-reference";
import type { DockviewApi, IDockviewPanelProps, SerializedDockview } from "dockview-react";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { ApiError, api } from "../../../lib/api";
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
import { type FilePanelOpener, useFilePanelSourceOpener } from "../file-panel-navigation";
import { stripIdentityFromLayout, stripNavigationFromLayout } from "../panels/layout-envelope";
import type { FilePanelParams } from "../panels/panel-kind";
import { installCanvasStub } from "../vlist/measure/test-canvas-stub";
import { WorkspaceDockStore } from "../workspace/workspace-dock";
import { FileEditorContent, type FileEditorContentProps } from "./FileEditorContent";
import { fileNavigationHighlight } from "./file-navigation-highlight";

// Mount the real FileEditorContent AND CodeMirrorEditor. Only I/O is stubbed;
// the document normalization, external-value effects and callbacks are real.
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
let preview: ReturnType<typeof spyOn<typeof fileReferenceApi, "preview">>;
let write: ReturnType<typeof spyOn<typeof api, "fsWrite">>;
const dirty = mock((_value: boolean) => {});
const publish = mock((_value: FileReferenceEditorSelection | null) => {});
const confirmReload = mock((_message: string) => true);

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
	// linkedom has no layout engine. Leave layout RAFs pending (and discard on
	// teardown); CodeMirror document transactions and React effects run normally.
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
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
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
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
	dirty.mockClear();
	publish.mockClear();
	confirmReload.mockReset();
	confirmReload.mockReturnValue(true);
	preview = spyOn(fileReferenceApi, "preview").mockResolvedValue(source);
	write = spyOn(api, "fsWrite").mockResolvedValue({
		ok: true,
		path: source.target.path,
		encoding: source.encoding,
		hash: "saved-byte-hash",
		bytesWritten: 12,
	});
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
		preview?.mockRestore();
		write?.mockRestore();
		for (const [key, descriptor] of originalGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originalGlobals.clear();
	}
});

async function mount(props: Partial<FileEditorContentProps> = {}) {
	await act(async () => {
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
		);
	});
	const element = host.querySelector<HTMLElement>(".cm-editor");
	if (!element) throw new Error(`Editor missing: ${host.textContent}`);
	const view = EditorView.findFromDOM(element);
	if (!view) throw new Error("CodeMirror view missing");
	return view;
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

for (const switchToA of [true, false]) {
	test(`pending B save ${switchToA ? "cannot steal A's selection" : "refreshes B's owned selection"}`, async () => {
		let shared: FileReferenceEditorSelection | null = null;
		let resolveSave!: (result: Awaited<ReturnType<typeof api.fsWrite>>) => void;
		write.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSave = resolve;
				}),
		);
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
		const views = Array.from(host.querySelectorAll<HTMLElement>(".cm-editor"), (element) => {
			const view = EditorView.findFromDOM(element);
			if (!view) throw new Error("CodeMirror view missing");
			return view;
		});
		const [a, b] = views;
		await edit(b, "changed B\n");
		expect(shared).toMatchObject({ target: { path: "/work/b.txt" }, dirty: true });
		const saveB = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Save"]')[1];
		if (!saveB) throw new Error("B save button missing");
		await click(saveB);
		expect(write).toHaveBeenCalledTimes(1);
		if (switchToA) await act(async () => a.dispatch({ selection: { anchor: 0, head: 1 } }));
		await act(async () =>
			resolveSave({
				ok: true,
				path: "/work/b.txt",
				encoding: source.encoding,
				hash: "saved-B",
				bytesWritten: 10,
			}),
		);
		expect(shared).toMatchObject(
			switchToA
				? { target: { path: "/work/a.txt" }, expectedHash: source.hash, dirty: false }
				: { target: { path: "/work/b.txt" }, expectedHash: "saved-B", dirty: false },
		);
		// Identical range is still a new user selection event and must reclaim B.
		await act(async () => b.dispatch({ selection: { anchor: 0, head: 1 } }));
		expect(shared).toMatchObject({
			target: { path: "/work/b.txt" },
			expectedHash: "saved-B",
			dirty: false,
		});
		await act(async () => a.dispatch({ selection: { anchor: 0, head: 1 } }));
		await renderPair(false);
		expect(shared).toMatchObject({ target: { path: "/work/a.txt" } });
	});
}

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
	if (!stalePublish) throw new Error("Publisher missing");
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

function currentSelection() {
	return publish.mock.calls.at(-1)?.[0];
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
async function edit(view: EditorView, text: string) {
	await act(async () => {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
		view.dispatch({ selection: { anchor: 0, head: 1 } });
	});
}
function expectClean(hash: string, hasSelection = true) {
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
	expect(host.textContent).not.toContain(en["fileEditor.unsaved"]);
	expect(iconButton("device-floppy").disabled).toBe(true);
	if (hasSelection) expect(currentSelection()).toMatchObject({ expectedHash: hash, dirty: false });
	else expect(currentSelection()).toBeNull();
}

for (const surface of ["focus", "workspace"] as const) {
	for (const lifecycle of ["live", "restored", "detached"] as const) {
		test(`${surface} ${lifecycle} child file reads/writes as child while publishing selection to host`, async () => {
			const filePath = "/work/b/a.txt";
			preview.mockImplementation(async (narratorId, target) => {
				// Model the server's cwd authorization: parent /work/a cannot read child /work/b.
				const cwd = narratorId === "child" ? "/work/b/" : "/work/a/";
				if (!target.path.startsWith(cwd)) throw new ApiError("Forbidden outside cwd", 403);
				return { ...source, target };
			});
			const panels = new Map<string, { id: string; params: FilePanelParams; api: object }>();
			const apiRef = {
				current: {
					getPanel: (id: string) => panels.get(id),
					get panels() {
						return [...panels.values()];
					},
					addPanel: ({ id, params }: { id: string; params: FilePanelParams }) => {
						const panel = {
							id,
							params,
							api: {
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
			const panel = [...panels.values()][0];
			if (!panel) throw new Error("Missing child file panel");
			childOpen?.(filePath, undefined, { referenceOrigin: true, selection });
			expect(panels.size).toBe(1);
			open(filePath, undefined, { referenceOrigin: true });
			expect(panels.size).toBe(2); // Same device/path, different read authority: don't reuse the child editor.
			expect(panel.params).toMatchObject({ hostNarratorId: "parent", fileNarratorId: "child" });
			let params = panel.params;
			if (lifecycle === "restored") {
				const layout = { panels: { file: { params } } } as unknown as SerializedDockview;
				const strip = surface === "focus" ? stripIdentityFromLayout : stripNavigationFromLayout;
				params = JSON.parse(JSON.stringify(strip(layout))).panels.file.params;
			} else if (lifecycle === "detached") {
				// Use the real native-tab → pending entry → persisted detached-node pipeline.
				const subject = readPanelSubject(params);
				if (!subject?.resourceId) throw new Error("Missing drag resource");
				const entry = makePanelEntry("file", subject.resourceId);
				const nodes = parseDetachedNodes(
					serializeDetachedNodes([
						{
							id: "detached",
							x: 0,
							y: 0,
							w: 480,
							h: 360,
							pendingPanels: [entry],
						},
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
			await act(async () => {
				root?.render(
					<I18nextProvider i18n={i18n}>
						<MantineProvider env="test">
							<NarratorDockContext.Provider value={dock}>
								<FileDockPanel {...props} />
							</NarratorDockContext.Provider>
						</MantineProvider>
					</I18nextProvider>,
				);
			});
			expect(preview).toHaveBeenCalledWith(
				"child",
				{ deviceId: "local", path: filePath },
				expect.any(AbortSignal),
			);
			const element = host.querySelector<HTMLElement>(".cm-editor");
			if (!element) throw new Error(`Editor not mounted: ${host.textContent}`);
			const view = EditorView.findFromDOM(element);
			if (!view) throw new Error("Missing CodeMirror view");
			expect(view.state.doc.toString()).toBe("a\nb\n");
			await edit(view, "child draft");
			expect(hostSelections.mock.calls.at(-1)?.[0]).toMatchObject({
				target: { path: filePath },
				dirty: true,
			});
			await click(iconButton("device-floppy"));
			expect(write.mock.calls[0]?.[0]).toMatchObject({
				narratorId: "child",
				path: filePath,
				content: "child draft",
			});
		});
	}
}

test("reference CRLF load is clean, selection-ready, and retains raw hash/encoding on real edits", async () => {
	const view = await mount();
	expect(preview).toHaveBeenCalledWith(
		"narrator",
		{ deviceId: "local", path: source.target.path },
		expect.any(AbortSignal),
	);
	expect(view.state.doc.toString()).toBe("a\nb\n");
	expect(dirty.mock.calls.every(([value]) => !value)).toBe(true);
	// File navigation highlights its range without creating an editable selection.
	expectClean(source.hash, false);
	expect(view.state.selection.main.empty).toBe(true);
	await act(async () => view.dispatch({ selection: { anchor: 2, head: 3 } }));
	expect(currentSelection()?.target.selection).toEqual(selection);
	expect(write).not.toHaveBeenCalled();
	expect(source.content).toBe("a\r\nb\r\n");
	await edit(view, "a\nchanged\n");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	expect(currentSelection()).toMatchObject({ expectedHash: source.hash, dirty: true });
	expect(iconButton("device-floppy").disabled).toBe(false);
	await click(iconButton("device-floppy"));
	expect(write.mock.calls[0]?.[0]).toMatchObject({
		content: "a\nchanged\n",
		baseHash: source.hash,
		encoding: source.encoding,
	});
	expectClean("saved-byte-hash");
});

test("mounted navigation paints the gutter and boundaries independently of text selection", async () => {
	const view = await mount();
	const highlight = view.state.field(fileNavigationHighlight);
	const markedGutters = () => host.querySelectorAll(".cm-file-navigation-gutter .cm-gutterElement");
	const markedLine = () =>
		view.contentDOM.querySelector(".cm-file-navigation-start.cm-file-navigation-end");
	expect(view.state.selection.main.empty).toBe(true);
	expect(markedGutters()).toHaveLength(1);
	expect(markedGutters()[0]?.classList.contains("cm-file-navigation-start")).toBe(true);
	expect(markedGutters()[0]?.classList.contains("cm-file-navigation-end")).toBe(true);
	expect(markedGutters()[0]?.textContent).toBe("");
	expect(
		Array.from(host.querySelectorAll(".cm-lineNumbers .cm-gutterElement")).some(
			(item) => item.textContent === "2",
		),
	).toBe(true);
	expect(markedLine()?.textContent).toBe("b");
	await act(async () => view.dispatch({ selection: { anchor: 0 } }));
	expect(view.state.field(fileNavigationHighlight)).toBe(highlight);
	expect(markedGutters()).toHaveLength(1);
	await act(async () => view.dispatch({ selection: { anchor: 0, head: 1 } }));
	expect(view.state.field(fileNavigationHighlight)).toBe(highlight);
	expect(currentSelection()?.target.selection?.startLineNumber).toBe(1);
	expect(markedLine()?.textContent).toBe("b");
	const repeated = await mount({ navigationRequestId: "again" });
	expect(repeated).toBe(view);
	expect(view.state.selection.main.empty).toBe(true);
	expect(markedGutters()).toHaveLength(1);
	await mount({ selection: undefined, navigationRequestId: "file-only" });
	expect(view.state.field(fileNavigationHighlight)).toBeNull();
	expect(markedGutters()).toHaveLength(0);
	expect(markedLine()).toBeNull();
	expectClean(source.hash, false);
});

test("explicit CRLF reload replaces the dirty document with an LF baseline and the new raw hash", async () => {
	const view = await mount();
	await edit(view, "unsaved");
	preview.mockResolvedValue({ ...source, content: "c\r\nd\r\n", hash: "reload-byte-hash" });
	dirty.mockClear();
	await click(iconButton("refresh"));
	expect(preview).toHaveBeenCalledTimes(2);
	expect(view.state.doc.toString()).toBe("c\nd\n");
	expect(dirty.mock.calls.every(([value]) => !value)).toBe(true);
	expectClean("reload-byte-hash", false);
	expect(write).not.toHaveBeenCalled();
});

test("cancelled reload keeps the dirty buffer, selection and undo history without reading", async () => {
	const view = await mount();
	await edit(view, "unsaved");
	const doc = view.state.doc;
	const selected = view.state.selection;
	const depth = undoDepth(view.state);
	confirmReload.mockReturnValue(false);
	await click(iconButton("refresh"));
	expect(confirmReload).toHaveBeenCalledWith(en["fileEditor.confirmReload"]);
	expect(preview).toHaveBeenCalledTimes(1);
	expect(view.state.doc).toBe(doc);
	expect(view.state.selection).toBe(selected);
	expect(undoDepth(view.state)).toBe(depth);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
});

test("reload failure keeps the editor mounted and its dirty buffer saveable", async () => {
	const view = await mount();
	await edit(view, "keep this draft");
	preview.mockRejectedValue(new Error("network unavailable"));
	await click(iconButton("refresh"));
	expect(host.textContent).toContain("network unavailable");
	expect(host.querySelector(".cm-editor")).toBe(view.dom);
	expect(view.state.doc.toString()).toBe("keep this draft");
	expect(iconButton("device-floppy").disabled).toBe(false);
	await click(iconButton("device-floppy"));
	expect(write.mock.calls[0]?.[0].content).toBe("keep this draft");
});

test("a late reload cannot overwrite an edit made after the read started", async () => {
	const view = await mount();
	let finish!: (value: Awaited<ReturnType<typeof fileReferenceApi.preview>>) => void;
	preview.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await click(iconButton("refresh"));
	expect(view.state.readOnly).toBe(true);
	// Simulate an already queued input transaction, despite the loading lock.
	await edit(view, "new input while loading");
	await act(async () => finish({ ...source, content: "late disk response" }));
	expect(view.state.doc.toString()).toBe("new input while loading");
	expect(view.state.readOnly).toBe(false);
	expect(host.textContent).toContain(en["fileEditor.changedDuringReload"]);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
});

test("scoped files without narrator context never fall back to another reader", async () => {
	await expect(mount({ narratorId: undefined, deviceId: "remote-device" })).rejects.toThrow(
		en["fileEditor.missingContext"],
	);
	expect(preview).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
	expect(host.querySelector(".cm-editor")).toBeNull();
});

async function switchFileMode(mode: "raw" | "preview" | "node") {
	const input = host.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`);
	if (!input) throw new Error(`Missing file mode ${mode}`);
	await act(async () => {
		input.checked = true;
		input.dispatchEvent(new Event("click", { bubbles: true }));
	});
}

for (const extension of ["txt", "md", "json"] as const) {
	test(`${extension} source inherits dock tab visibility without replacing editor state`, async () => {
		const view = await mount({ filePath: `/work/draft.${extension}`, selection: undefined });
		const sourceElement = host.querySelector<HTMLElement>("[data-file-editor-source]");
		if (!sourceElement) throw new Error("Source layer missing");
		await edit(view, "unsaved draft\n");
		const doc = view.state.doc;
		const selected = view.state.selection;
		const history = undoDepth(view.state);

		// Model Dockview's always-rendered ancestor. LinkeDOM has no layout engine:
		// assert the inheritance contract, not simulated computed visibility.
		for (let cycle = 0; cycle < 2; cycle++) {
			host.style.visibility = "hidden";
			expect(sourceElement.style.visibility).toBe("inherit");
			if (extension !== "txt") {
				await switchFileMode(extension === "md" ? "preview" : "node");
				expect(sourceElement.style.visibility).toBe("hidden");
				expect(sourceElement.hasAttribute("inert")).toBe(true);
				await switchFileMode("raw");
				expect(host.style.visibility).toBe("hidden");
				expect(sourceElement.style.visibility).toBe("inherit");
			}
			host.style.visibility = "";
			expect(sourceElement.style.visibility).toBe("inherit");
			expect(sourceElement.hasAttribute("inert")).toBe(false);
			expect(host.querySelector(".cm-editor")).toBe(view.dom);
			expect(view.state.doc).toBe(doc);
			expect(view.state.selection).toBe(selected);
			expect(undoDepth(view.state)).toBe(history);
		}
		expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
		expect(preview).toHaveBeenCalledTimes(1);
		expect(write).not.toHaveBeenCalled();
	});
}

for (const extension of ["md", "json"] as const) {
	test(`${extension} preview renders the unsaved buffer without losing editor state or reading again`, async () => {
		const filePath = `/work/draft.${extension}`;
		preview.mockResolvedValue({
			...source,
			content: extension === "md" ? "# Saved" : '{"name":"Saved"}',
		});
		const view = await mount({ filePath, selection: undefined });
		const sourceElement = host.querySelector<HTMLElement>("[data-file-editor-source]");
		expect(sourceElement?.style.visibility).toBe("inherit");
		expect(host.querySelector("[data-file-editor-preview]")).toBeNull();
		const draft =
			extension === "md"
				? "# Draft heading\n\n**bold draft**"
				: '{"name":"Draft value","nested":{"enabled":true}}';
		await edit(view, draft);
		const doc = view.state.doc;
		const selected = view.state.selection;
		const history = undoDepth(view.state);
		await switchFileMode(extension === "md" ? "preview" : "node");
		const body = host.querySelector("[data-file-editor-preview]");
		expect(body).not.toBeNull();
		expect(body?.textContent).toContain(extension === "md" ? "Draft heading" : "Draft value");
		if (extension === "md") expect(body?.querySelector("h1")?.textContent).toBe("Draft heading");
		else expect(body?.querySelector('[role="tree"]')).not.toBeNull();
		expect(sourceElement?.style.visibility).toBe("hidden");
		expect(sourceElement?.hasAttribute("inert")).toBe(true);
		expect(host.querySelector(".cm-editor")).toBe(view.dom);
		await switchFileMode("raw");
		expect(sourceElement?.style.visibility).toBe("inherit");
		expect(view.state.doc).toBe(doc);
		expect(view.state.selection).toBe(selected);
		expect(undoDepth(view.state)).toBe(history);
		expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
		expect(preview).toHaveBeenCalledTimes(1);
		expect(write).not.toHaveBeenCalled();
		await act(async () => {
			undo(view);
		});
		expect(view.state.doc.toString()).toContain("Saved");
	});
}

test("read-only JSON keeps both source and node views without enabling writes", async () => {
	preview.mockResolvedValue({ ...source, content: '{"remote":"read-only value"}' });
	const view = await mount({
		filePath: "/work/a.json",
		deviceId: "remote-device",
		selection: undefined,
	});
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain(
		"read-only value",
	);
	await switchFileMode("raw");
	expect(view.state.readOnly).toBe(true);
	expect(host.querySelector(".tabler-icon-device-floppy")).toBeNull();
	expect(preview).toHaveBeenCalledTimes(1);
	expect(write).not.toHaveBeenCalled();
});

test("oversized unsaved JSON declines rendering without truncating the editor", async () => {
	preview.mockResolvedValue({ ...source, content: "{}" });
	const view = await mount({ filePath: "/work/a.json", selection: undefined });
	// Keep individual lines bounded: linkedom has no layout for CM's long-line gaps.
	const text = JSON.stringify(
		{ values: Array.from({ length: 2048 }, () => "x".repeat(512)) },
		null,
		2,
	);
	await edit(view, text);
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain(
		en["fileEditor.previewTooLarge"],
	);
	await switchFileMode("raw");
	expect(view.state.doc.toString()).toBe(text);
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	expect(preview).toHaveBeenCalledTimes(1);
});

test("invalid JSON can be corrected by switching back without dropping the buffer", async () => {
	preview.mockResolvedValue({ ...source, content: '{"name":"saved"}' });
	const view = await mount({ filePath: "/work/a.json", selection: undefined });
	await edit(view, '{"name":');
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("not valid json");
	expect(view.state.doc.toString()).toBe('{"name":');
	await switchFileMode("raw");
	await edit(view, '{"name":"fixed"}');
	await switchFileMode("node");
	expect(host.querySelector("[data-file-editor-preview]")?.textContent).toContain("fixed");
	expect(preview).toHaveBeenCalledTimes(1);
});

test("line references keep the preview switch and new navigation returns to the same editor", async () => {
	const filePath = "/work/a.md";
	const view = await mount({ filePath, navigationRequestId: "first" });
	await switchFileMode("preview");
	expect(host.querySelector("[data-file-editor-preview]")).not.toBeNull();
	const again = await mount({ filePath, navigationRequestId: "second" });
	expect(again).toBe(view);
	expect(host.querySelector("[data-file-editor-preview]")).toBeNull();
	expect(preview).toHaveBeenCalledTimes(1);
});

test("search from preview returns to source without replacing the document", async () => {
	const view = await mount({ filePath: "/work/a.md", selection: undefined });
	await switchFileMode("preview");
	await click(iconButton("search"));
	expect(host.querySelector("[data-file-editor-preview]")).toBeNull();
	expect(searchPanelOpen(view.state)).toBe(true);
	expect(preview).toHaveBeenCalledTimes(1);
});

test("ordinary text does not expose irrelevant preview modes", async () => {
	await mount();
	expect(host.querySelector('input[type="radio"]')).toBeNull();
});

test("search and wrapping preserve the document, selection and undo history", async () => {
	const view = await mount();
	await edit(view, "find me\nfind me");
	const doc = view.state.doc;
	const selected = view.state.selection;
	const depth = undoDepth(view.state);
	await click(iconButton("text-wrap"));
	// linkedom has no computed layout; the extension's DOM class is observable.
	expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
	expect(iconButton("text-wrap").getAttribute("aria-pressed")).toBe("true");
	await click(iconButton("search"));
	expect(searchPanelOpen(view.state)).toBe(true);
	expect(view.state.doc).toBe(doc);
	expect(view.state.selection).toBe(selected);
	expect(undoDepth(view.state)).toBe(depth);
	expect(preview).toHaveBeenCalledTimes(1);
});

function searchPanelElement() {
	const panel = host.querySelector<HTMLElement>("[data-editor-search-panel]");
	if (!panel) throw new Error("Custom search panel missing");
	return panel;
}

async function setQuery(view: EditorView, search: string, replace = "", regexp = false) {
	await act(async () =>
		view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search, replace, regexp })) }),
	);
}

async function searchKey(
	target: HTMLElement,
	key: string,
	options: { shiftKey?: boolean; isComposing?: boolean } = {},
) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, {
		key,
		keyCode: key === "Enter" ? 13 : key === "Escape" ? 27 : 0,
		...options,
	});
	await act(async () => {
		target.dispatchEvent(event);
	});
	return event;
}

test("search uses Mantine inputs/buttons and real replacements remain undoable", async () => {
	preview.mockResolvedValue({ ...source, content: "cat cat dog" });
	const view = await mount({ selection: undefined });
	await click(iconButton("search"));
	const panel = searchPanelElement();
	expect(panel.querySelector("input[main-field]")?.className).toContain("mantine-TextInput-input");
	expect(panel.querySelector(".mantine-Checkbox-input")).not.toBeNull();
	expect(panel.querySelector(".cm-textfield, .cm-button, .cm-search")).toBeNull();
	await setQuery(view, "cat", "fox");
	expect(panel.querySelector<HTMLInputElement>("input[name=search]")?.value).toBe("cat");
	expect(panel.querySelector<HTMLInputElement>("input[name=replace]")?.value).toBe("fox");
	const replaceButton = Array.from(panel.querySelectorAll("button")).find(
		(button) => button.textContent === "replace all",
	);
	if (!replaceButton) throw new Error("Replace-all button missing");
	expect(replaceButton.className).toContain("mantine-Button-root");
	await click(replaceButton);
	expect(view.state.doc.toString()).toBe("fox fox dog");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	await act(async () => {
		undo(view);
	});
	expect(view.state.doc.toString()).toBe("cat cat dog");
});

test("custom search handles Enter, Shift+Enter and Escape but not composition Enter", async () => {
	preview.mockResolvedValue({ ...source, content: "cat cat dog" });
	const view = await mount({ selection: undefined });
	const open = view.state
		.facet(keymap)
		.flat()
		.find((binding) => binding.key === "Mod-f")?.run;
	await act(async () => {
		open?.(view);
	});
	await setQuery(view, "cat");
	const input = searchPanelElement().querySelector<HTMLInputElement>("input[main-field]");
	if (!input) throw new Error("Find input missing");
	const composing = await searchKey(input, "Enter", { isComposing: true });
	expect(composing.defaultPrevented).toBe(false);
	expect(view.state.selection.main.empty).toBe(true);
	expect((await searchKey(input, "Enter")).defaultPrevented).toBe(true);
	expect(view.state.selection.main.from).toBe(0);
	expect(view.state.selection.main.to).toBe(3);
	await searchKey(input, "Enter");
	expect(view.state.selection.main.from).toBe(4);
	await searchKey(input, "Enter", { shiftKey: true });
	expect(view.state.selection.main.from).toBe(0);
	expect((await searchKey(input, "Escape")).defaultPrevented).toBe(true);
	expect(searchPanelOpen(view.state)).toBe(false);
	expect(host.querySelector("[data-editor-search-panel]")).toBeNull();
	expect(view.state.doc.toString()).toBe("cat cat dog");
});

test("invalid regex is explained and replacement actions are disabled", async () => {
	const view = await mount();
	await click(iconButton("search"));
	await setQuery(view, "[", "replacement", true);
	const panel = searchPanelElement();
	expect(getSearchQuery(view.state).valid).toBe(false);
	expect(panel.textContent).toContain(en["fileEditor.searchInvalidRegex"]);
	const input = panel.querySelector("input[main-field]");
	expect(input?.getAttribute("aria-invalid")).toBe("true");
	const replacement = Array.from(panel.querySelectorAll("button")).find(
		(button) => button.textContent === "replace all",
	);
	expect(replacement?.disabled).toBe(true);
	expect(view.state.doc.toString()).toBe("a\nb\n");
});

test("read-only search uses the same Mantine UI but offers no replacement controls", async () => {
	const view = await mount({ deviceId: "remote-device" });
	await click(iconButton("search"));
	const panel = searchPanelElement();
	expect(panel.querySelector(".mantine-TextInput-input")).not.toBeNull();
	expect(panel.querySelector("input[name=replace]")).toBeNull();
	expect(view.contentDOM.getAttribute("tabindex")).toBe("0");
	expect(panel.textContent).not.toContain("replace all");
	await setQuery(view, "b");
	const next = panel.querySelector<HTMLButtonElement>('button[aria-label="next"]');
	if (!next) throw new Error("Next match button missing");
	await click(next);
	expect(view.state.doc.toString()).toBe("a\nb\n");
	expect(write).not.toHaveBeenCalled();
});

test("an input followed immediately by Ctrl+S sends the newest buffer exactly once", async () => {
	const view = await mount();
	const save = view.state
		.facet(keymap)
		.flat()
		.find((binding) => binding.key === "Mod-s")?.run;
	expect(save).toBeDefined();
	await act(async () => {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "latest keystroke" } });
		save?.(view);
		save?.(view);
	});
	expect(write).toHaveBeenCalledTimes(1);
	expect(write.mock.calls[0]?.[0].content).toBe("latest keystroke");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(false);
});

test("typing during a save is preserved and remains dirty after the response", async () => {
	let finish!: (result: Awaited<ReturnType<typeof api.fsWrite>>) => void;
	write.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const view = await mount();
	await edit(view, "sent version");
	await click(iconButton("device-floppy"));
	await edit(view, "newer unsaved version");
	await act(async () =>
		finish({
			ok: true,
			path: source.target.path,
			encoding: source.encoding,
			hash: "saved",
			bytesWritten: 12,
		}),
	);
	expect(view.state.doc.toString()).toBe("newer unsaved version");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	expect(iconButton("device-floppy").disabled).toBe(false);
});

test("undoing to the old baseline during a save still blocks panel exit and unload", async () => {
	let finish!: (result: Awaited<ReturnType<typeof api.fsWrite>>) => void;
	write.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const view = await mount();
	await edit(view, "sent version");
	await click(iconButton("device-floppy"));
	await act(async () => {
		undo(view);
	});
	expect(view.state.doc.toString()).toBe("a\nb\n");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
	await act(async () =>
		finish({
			ok: true,
			path: source.target.path,
			encoding: source.encoding,
			hash: "saved",
			bytesWritten: 12,
		}),
	);
	// Disk now contains the sent version; the undo is a new unsaved edit.
	expect(view.state.doc.toString()).toBe("a\nb\n");
	expect(dirty.mock.calls.at(-1)?.[0]).toBe(true);
	expect(iconButton("device-floppy").disabled).toBe(false);
});

test("remote files use the scoped reader and a read-only editor with no save action", async () => {
	const view = await mount({ deviceId: "remote-device" });
	expect(preview).toHaveBeenCalledWith(
		"narrator",
		{ deviceId: "remote-device", path: source.target.path },
		expect.any(AbortSignal),
	);
	expect(view.state.readOnly).toBe(true);
	expect(view.state.facet(EditorView.editable)).toBe(false);
	expect(host.querySelector(".tabler-icon-device-floppy")).toBeNull();
	expect(write).not.toHaveBeenCalled();
});

test("controlled input echoes do not flatten the document a second time", async () => {
	const view = await mount();
	const transaction = view.state.update({ changes: { from: 0, insert: "typed" } });
	const stringify = spyOn(transaction.state.doc, "toString");
	try {
		await act(async () => view.dispatch(transaction));
		expect(stringify).toHaveBeenCalledTimes(1);
	} finally {
		stringify.mockRestore();
	}
});

test("stable selection metadata is not republished on every dirty keystroke", async () => {
	const view = await mount();
	await edit(view, "already dirty");
	publish.mockClear();
	await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }));
	expect(publish).not.toHaveBeenCalled();
	await act(async () => undo(view));
});

test("beforeunload protects dirty edits and permits a clean buffer", async () => {
	const view = await mount();
	const clean = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(clean);
	expect(clean.defaultPrevented).toBe(false);
	await edit(view, "unsaved");
	const dirtyEvent = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(dirtyEvent);
	expect(dirtyEvent.defaultPrevented).toBe(true);
});

for (const choice of ["conflictTakeTheirs", "conflictKeepMine"] as const) {
	test(`CRLF conflict ${choice} adopts an LF baseline without changing the winning hash`, async () => {
		const view = await mount();
		await edit(view, "same\ntext\n");
		const theirText = choice === "conflictTakeTheirs" ? "theirs\r\ntext\r\n" : "same\r\ntext\r\n";
		write.mockRejectedValue(
			new ApiError("Conflict", 409, {
				currentContent: theirText,
				currentHash: "winning-byte-hash",
			}),
		);
		await click(iconButton("device-floppy"));
		expect(currentSelection()).toMatchObject({ expectedHash: source.hash, dirty: true });
		const button = Array.from(host.querySelectorAll("button")).find(
			(item) => item.textContent === en[`fileEditor.${choice}`],
		);
		if (!button) throw new Error("Conflict choice missing");
		dirty.mockClear();
		await click(button);
		expect(view.state.doc.toString()).toBe(theirText.replaceAll("\r\n", "\n"));
		expect(dirty.mock.calls.every(([value]) => !value)).toBe(true);
		expectClean("winning-byte-hash", choice === "conflictKeepMine");
		await edit(view, "different\ntext\n");
		expect(currentSelection()).toMatchObject({ expectedHash: "winning-byte-hash", dirty: true });
	});
}
