import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { FILE_PANEL_PAGE_BYTES, MAX_FILE_PANEL_BYTES } from "@shared/file-reference";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { fileReferenceApi } from "../../../lib/api/file-references";
import en from "../../../locales/en/narrator.json";
import type { FileEditorContentProps } from "../file-editor/FileEditorContent";
import type { FileViewerContentProps } from "../file-viewer/FileViewerContent";
import type { FilePanelContentProps } from "./FilePanelContent";

// Only the rendering/I/O leaves are replaced; routing and the metadata/page gate are real.
let editorProps: FileEditorContentProps | undefined;
let viewerProps: FileViewerContentProps | undefined;
let editorMounts = 0;
let viewerMounts = 0;
mock.module("../file-editor/FileEditorContent", () => ({
	FileEditorContent: (props: FileEditorContentProps) => {
		editorProps = props;
		useEffect(() => {
			editorMounts++;
		}, []);
		return <div data-editor />;
	},
}));
mock.module("../file-viewer/FileViewerContent", () => ({
	FileViewerContent: (props: FileViewerContentProps) => {
		viewerProps = props;
		useEffect(() => {
			viewerMounts++;
		}, []);
		return <div data-viewer />;
	},
}));
const { FilePanelContent } = await import("./FilePanelContent");
const i18n = i18next.createInstance();
const globals = new Map<string, PropertyDescriptor | undefined>();
const storage = new Map<string, string>();
let root: Root;
let host: HTMLDivElement;
let info: ReturnType<typeof spyOn<typeof fileReferenceApi, "info">>;
let page: ReturnType<typeof spyOn<typeof fileReferenceApi, "page">>;

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		MutationObserver: window.MutationObserver,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
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
	editorProps = undefined;
	viewerProps = undefined;
	editorMounts = 0;
	viewerMounts = 0;
	storage.clear();
	info = spyOn(fileReferenceApi, "info").mockImplementation(async (_narrator, target) => ({
		target,
		fileName: "file.txt",
		size: 100,
	}));
	page = spyOn(fileReferenceApi, "page").mockImplementation(async (_narrator, target, offset) => ({
		target,
		fileName: "file.txt",
		size: 2 * 1024 ** 2,
		offset,
		nextOffset: offset + FILE_PANEL_PAGE_BYTES,
		content: "bounded page",
	}));
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	info.mockRestore();
	page.mockRestore();
	for (const [key, value] of globals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

async function render(props: Partial<FilePanelContentProps> = {}) {
	await act(async () => {
		root.render(
			<MantineProvider>
				<I18nextProvider i18n={i18n}>
					<FilePanelContent filePath="/file.txt" narratorId="source" {...props} />
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}

const selection = { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 4 };

test("text routes through the real gate and forwards source scope and editor callbacks", async () => {
	const onSelection = mock(() => {});
	const onDirty = mock(() => {});
	await render({
		deviceId: "remote",
		referenceOrigin: true,
		selection,
		navigationRequestId: "nav1",
		onFileReferenceSelectionChange: onSelection,
		onDirtyChange: onDirty,
	});
	expect(host.querySelector("[data-editor]")).not.toBeNull();
	expect(host.querySelector("[data-viewer]")).toBeNull();
	expect(editorProps).toMatchObject({
		filePath: "/file.txt",
		narratorId: "source",
		deviceId: "remote",
		referenceOrigin: true,
		selection,
		navigationRequestId: "nav1",
		onFileReferenceSelectionChange: onSelection,
		onDirtyChange: onDirty,
	});
	editorProps?.onFileReferenceSelectionChange?.(null, true);
	editorProps?.onDirtyChange?.(true);
	expect(onSelection).toHaveBeenCalledWith(null, true);
	expect(onDirty).toHaveBeenCalledWith(true);
	expect(info.mock.calls[0]?.[0]).toBe("source");
	expect(info.mock.calls[0]?.[1]).toEqual({ deviceId: "remote", path: "/file.txt" });
	expect(info.mock.calls[0]?.[3]).toBe("reference");
});

for (const filePath of ["/image.PNG", "/document.pdf"]) {
	test(`${filePath} routes to binary viewer with target callback and highlight mapping`, async () => {
		const open = mock(() => {});
		const publish = mock(() => {});
		await render({
			filePath,
			narratorId: "origin",
			deviceId: "remote",
			referenceOrigin: true,
			selection,
			navigationRequestId: "nav2",
			onOpenFileTarget: open,
			onFileReferenceSelectionChange: publish,
		});
		expect(host.querySelector("[data-viewer]")).not.toBeNull();
		expect(host.querySelector("[data-editor]")).toBeNull();
		expect(info).not.toHaveBeenCalled();
		expect(viewerProps).toMatchObject({
			filePath,
			narratorId: "origin",
			deviceId: "remote",
			referenceOrigin: true,
			selection,
			highlightRequestId: "nav2",
			onOpenFileTarget: open,
			onFileReferenceSelectionChange: publish,
		});
		const target = { deviceId: "remote", path: "/next.txt", selection };
		viewerProps?.onOpenFileTarget?.(target);
		viewerProps?.onFileReferenceSelectionChange?.(null);
		expect(open).toHaveBeenCalledWith(target);
		expect(publish).toHaveBeenCalledWith(null);
	});
}

test("navigation and reference-origin upgrades preserve editor identity; source changes remount", async () => {
	await render({ navigationRequestId: "first" });
	const editor = host.querySelector("[data-editor]");
	await render({ deviceId: "local", navigationRequestId: "second", selection });
	expect(host.querySelector("[data-editor]")).toBe(editor);
	expect(editorProps?.navigationRequestId).toBe("second");
	expect(editorProps?.selection).toBe(selection);
	await render({ referenceOrigin: true, navigationRequestId: "third" });
	expect(editorMounts).toBe(1);
	await render({ narratorId: "other" });
	expect(editorMounts).toBe(2);
	await render({ deviceId: "remote" });
	expect(editorMounts).toBe(3);
	await render({ deviceId: "remote", filePath: "/other.txt" });
	expect(editorMounts).toBe(4);
});

test("binary navigation preserves viewer identity", async () => {
	await render({ filePath: "/image.png", navigationRequestId: "first" });
	const viewer = host.querySelector("[data-viewer]");
	await render({ filePath: "/image.png", navigationRequestId: "second", selection });
	expect(host.querySelector("[data-viewer]")).toBe(viewer);
	expect(viewerMounts).toBe(1);
	expect(viewerProps?.highlightRequestId).toBe("second");
});

test("large local text stays gated, uses legacy not preview, and confirms bounded pages", async () => {
	info.mockImplementation(async (_narrator, target) => ({
		target,
		fileName: "file.txt",
		size: 2 * 1024 ** 2,
	}));
	const confirm = mock(() => {});
	await render({ onConfirm: confirm, persistenceKey: "pane:source" });
	expect(info.mock.calls[0]?.[3]).toBe("legacy");
	expect(editorMounts).toBe(0);
	expect(page).not.toHaveBeenCalled();
	const button = [...host.querySelectorAll("button")].find(
		(value) => value.textContent === "View anyway",
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
	expect(confirm).toHaveBeenCalledTimes(1);
	expect(storage.get("pane:source")).toBe("true");
	expect(page.mock.calls[0]?.[4]).toBe("legacy");
	expect(host.textContent).toContain("bounded page");
	expect(editorMounts).toBe(0);
});

test("confirmed remote large files use reference pages and oversized files remain blocked", async () => {
	info.mockImplementation(async (_narrator, target) => ({
		target,
		fileName: "file.txt",
		size: 2 * 1024 ** 2,
	}));
	await render({ deviceId: "remote", confirmed: true });
	expect(page.mock.calls[0]?.[4]).toBe("reference");
	expect(editorMounts).toBe(0);
	info.mockImplementation(async (_narrator, target) => ({
		target,
		fileName: "too-big.txt",
		size: MAX_FILE_PANEL_BYTES + 1,
	}));
	await render({ filePath: "/too-big.txt", confirmed: true });
	expect(host.textContent).toContain("1 GiB viewing limit");
	expect(page).toHaveBeenCalledTimes(1);
	expect(editorMounts).toBe(0);
});
