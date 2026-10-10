import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import type { FileTarget } from "@shared/file-reference";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fileReferenceApi } from "../../../lib/api/file-references";
import {
	FilePanelNavigationProvider,
	type FilePanelOpener,
} from "../file-panel/file-panel-navigation";
import {
	type UseInternalFileViewerResult,
	useInternalFileViewer,
} from "./use-internal-file-viewer";

let root: Root;
let host: HTMLElement;
let viewer: UseInternalFileViewerResult;
let resolve: ReturnType<typeof spyOn<typeof fileReferenceApi, "resolve">>;
let notify: ReturnType<typeof spyOn<typeof notifications, "show">>;
const originals = new Map<string, PropertyDescriptor | undefined>();
const t = (key: string) => key;
const local = { deviceId: "local", path: "/work/a.txt" };
const selection = { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 2 };

function Probe({ preview = false }: { preview?: boolean }) {
	viewer = useInternalFileViewer({ narratorId: "source-narrator", isWorkspacePreview: preview, t });
	return <output>{viewer.internalFileViewerPath}</output>;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	resolve = spyOn(fileReferenceApi, "resolve").mockImplementation(async (_narrator, targets) => ({
		targets,
	}));
	notify = spyOn(notifications, "show").mockImplementation(() => "notification");
});

afterEach(async () => {
	await act(async () => root.unmount());
	resolve.mockRestore();
	notify.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function mount(open?: FilePanelOpener, preview = false) {
	await act(async () =>
		root.render(
			<FilePanelNavigationProvider value={open}>
				<Probe preview={preview} />
			</FilePanelNavigationProvider>,
		),
	);
}

async function openReference(target: FileTarget = local) {
	await act(async () => viewer.handleOpenReferencedFile(target));
}

test("close actions reject unsaved/busy files until saving or reload releases the guard", async () => {
	await mount();
	await act(async () => viewer.handleOpenFilePanel?.(local.path));
	viewer.onFileEditorDirtyChange(true);
	for (let attempt = 0; attempt < 3; attempt++) {
		await act(async () => {
			expect(viewer.setInternalFileViewerPath(null)).toBe(false);
		});
		expect(viewer.internalFileViewerPath).toBe(local.path);
	}
	expect(notify).toHaveBeenCalledTimes(3);
	expect(notify.mock.calls[0]?.[0]).toMatchObject({ message: "fileEditor.unsavedBlockExit" });
	viewer.onFileEditorDirtyChange(false);
	await act(async () => {
		expect(viewer.setInternalFileViewerPath(null)).toBe(true);
	});
	expect(viewer.internalFileViewerPath).toBeNull();
	expect(viewer.internalFileViewerTarget).toBeNull();
});

test("plain and resolved file replacement cannot discard the current scoped draft", async () => {
	await mount();
	await openReference({ ...local, selection });
	const target = viewer.internalFileViewerTarget;
	viewer.onFileEditorDirtyChange(true);
	await act(async () => viewer.handleOpenFilePanel?.("/work/b.txt"));
	await openReference({ deviceId: "local", path: "/work/c.txt" });
	await openReference({ deviceId: "remote", path: local.path });
	expect(viewer.internalFileViewerPath).toBe(local.path);
	expect(viewer.internalFileViewerTarget).toBe(target);
	expect(notify).toHaveBeenCalledTimes(3);
});

test("same-file navigation preserves the draft and updates its highlight without downgrading scope", async () => {
	await mount();
	await openReference();
	const firstId = viewer.internalFileViewerTarget?.highlightRequestId;
	viewer.onFileEditorDirtyChange(true);
	await openReference({ ...local, selection });
	expect(viewer.internalFileViewerTarget?.selection).toEqual(selection);
	expect(viewer.internalFileViewerTarget?.highlightRequestId).not.toBe(firstId);
	const target = viewer.internalFileViewerTarget;
	await act(async () => viewer.handleOpenFilePanel?.(local.path));
	expect(viewer.internalFileViewerTarget).toBe(target);
	expect(notify).not.toHaveBeenCalled();
});

test("an in-flight reference must recheck the exit guard after resolving", async () => {
	await mount();
	await openReference();
	let finish!: (value: { targets: FileTarget[] }) => void;
	resolve.mockImplementationOnce(
		() =>
			new Promise((accept) => {
				finish = accept;
			}),
	);
	const pending = viewer.handleOpenReferencedFile({ deviceId: "local", path: "/work/b.txt" });
	viewer.onFileEditorDirtyChange(true);
	await act(async () => {
		finish({ targets: [{ deviceId: "local", path: "/work/b.txt" }] });
		await pending;
	});
	expect(viewer.internalFileViewerPath).toBe(local.path);
	expect(notify).toHaveBeenCalledTimes(1);
});

test("closing a clean drawer cancels pending navigation so it cannot reopen later", async () => {
	await mount();
	await openReference();
	let finish!: (value: { targets: FileTarget[] }) => void;
	resolve.mockImplementationOnce(
		() =>
			new Promise((accept) => {
				finish = accept;
			}),
	);
	const pending = viewer.handleOpenReferencedFile({ deviceId: "local", path: "/work/b.txt" });
	const signal = resolve.mock.calls.at(-1)?.[2];
	await act(async () => {
		expect(viewer.setInternalFileViewerPath(null)).toBe(true);
	});
	expect(signal?.aborted).toBe(true);
	await act(async () => {
		finish({ targets: [{ deviceId: "local", path: "/work/b.txt" }] });
		await pending;
	});
	expect(viewer.internalFileViewerPath).toBeNull();
});

test("dock navigation retains source authority and remains independent of drawer guards", async () => {
	const open = mock((..._args: Parameters<FilePanelOpener>) => {});
	await mount(open);
	viewer.onFileEditorDirtyChange(true);
	await openReference({ ...local, selection });
	expect(open).toHaveBeenCalledWith(local.path, undefined, {
		fileNarratorId: "source-narrator",
		deviceId: "local",
		selection,
		highlightRequestId: expect.any(String),
		referenceOrigin: true,
	});
	expect(viewer.internalFileViewerPath).toBeNull();
	expect(notify).not.toHaveBeenCalled();
});

test("workspace previews do not expose a file drawer", async () => {
	await mount(undefined, true);
	expect(viewer.handleOpenFilePanel).toBeUndefined();
	expect(viewer.canOpenReferencedFile).toBe(false);
	await openReference();
	expect(viewer.internalFileViewerPath).toBeNull();
});
