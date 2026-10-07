import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { FILE_PANEL_PAGE_BYTES, MAX_FILE_PANEL_BYTES } from "@shared/file-reference";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { fileReferenceApi } from "../../../lib/api/file-references";
import en from "../../../locales/en/narrator.json";
import { filePanelLoadPolicy, filePanelSizeLabel, LargeFileGate } from "./LargeFileGate";

const i18n = i18next.createInstance();
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let host: HTMLDivElement;
let info: ReturnType<typeof spyOn<typeof fileReferenceApi, "info">>;
let page: ReturnType<typeof spyOn<typeof fileReferenceApi, "page">>;
const confirm = mock(() => {});
const storage = new Map<string, string>();

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
	confirm.mockClear();
	storage.clear();
	info = spyOn(fileReferenceApi, "info").mockImplementation(async (_narrator, target) => ({
		target,
		fileName: "large.txt",
		size: 2 * 1024 ** 2,
	}));
	page = spyOn(fileReferenceApi, "page").mockImplementation(async (_narrator, target, offset) => ({
		target,
		fileName: "large.txt",
		size: 2 * 1024 ** 2,
		offset,
		nextOffset: offset + FILE_PANEL_PAGE_BYTES,
		content: `page at ${offset}`,
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

async function render(
	options: {
		confirmed?: boolean;
		filePath?: string;
		persistenceKey?: string;
		referenceOrigin?: boolean;
		legacyViewer?: boolean;
		deviceId?: string;
	} = {},
) {
	await act(async () => {
		root.render(
			<MantineProvider>
				<I18nextProvider i18n={i18n}>
					<LargeFileGate
						narratorId="n"
						filePath={options.filePath ?? "/large.txt"}
						deviceId={options.deviceId}
						referenceOrigin={options.referenceOrigin}
						legacyViewer={options.legacyViewer}
						confirmed={options.confirmed}
						persistenceKey={options.persistenceKey}
						onConfirm={confirm}
					>
						<div data-normal-viewer>ordinary viewer mounted</div>
					</LargeFileGate>
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}

async function click(label: string) {
	const button = [...host.querySelectorAll("button")].find((value) => value.textContent === label);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}

test("local legacy and scoped origins keep different metadata and page authorizers", async () => {
	await render({ confirmed: true });
	expect(info.mock.calls[0]?.[3]).toBe("legacy");
	expect(page.mock.calls[0]?.[4]).toBe("legacy");
	await render({ referenceOrigin: true, confirmed: true });
	expect(info.mock.calls.at(-1)?.[3]).toBe("reference");
	expect(page.mock.calls.at(-1)?.[4]).toBe("reference");
	await render({ deviceId: "remote", confirmed: true });
	expect(info.mock.calls.at(-1)?.[3]).toBe("reference");
	expect(page.mock.calls.at(-1)?.[4]).toBe("reference");
});

test("off-dock local viewers retain preview authorization without weakening references or remote", async () => {
	await render({ legacyViewer: true, confirmed: true });
	expect(info.mock.calls.at(-1)?.[3]).toBe("preview");
	expect(page.mock.calls.at(-1)?.[4]).toBe("preview");
	await render({ legacyViewer: true, referenceOrigin: true, confirmed: true });
	expect(info.mock.calls.at(-1)?.[3]).toBe("reference");
	expect(page.mock.calls.at(-1)?.[4]).toBe("reference");
	await render({ legacyViewer: true, deviceId: "remote", confirmed: true });
	expect(info.mock.calls.at(-1)?.[3]).toBe("reference");
	expect(page.mock.calls.at(-1)?.[4]).toBe("reference");
});

test("metadata revalidation does not remount the small editor on reference upgrade", async () => {
	info.mockResolvedValue({
		target: { deviceId: "local", path: "/large.txt" },
		fileName: "a.txt",
		size: 100,
	});
	await render();
	const editor = host.querySelector("[data-normal-viewer]");
	expect(editor).not.toBeNull();
	let complete: ((value: Awaited<ReturnType<typeof fileReferenceApi.info>>) => void) | undefined;
	info.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	await render({ referenceOrigin: true });
	expect(host.querySelector("[data-normal-viewer]")).toBe(editor);
	await act(async () =>
		complete?.({ target: { deviceId: "local", path: "/large.txt" }, fileName: "a.txt", size: 100 }),
	);
	expect(host.querySelector("[data-normal-viewer]")).toBe(editor);
});

test("size policy includes exact 1 MiB and 1 GiB boundaries", () => {
	expect(filePanelLoadPolicy(1024 ** 2)).toBe("auto");
	expect(filePanelLoadPolicy(1024 ** 2 + 1)).toBe("confirm");
	expect(filePanelLoadPolicy(MAX_FILE_PANEL_BYTES)).toBe("confirm");
	expect(filePanelLoadPolicy(MAX_FILE_PANEL_BYTES + 1)).toBe("blocked");
	expect(filePanelSizeLabel(MAX_FILE_PANEL_BYTES)).toBe("1.00 GiB");
});

test("opens a large file as metadata only, then reads bounded pages after explicit confirmation", async () => {
	await render();
	expect(host.textContent).toContain("large.txt");
	expect(host.textContent).toContain("2.00 MiB");
	expect(host.querySelector("[data-normal-viewer]")).toBeNull();
	expect(page).not.toHaveBeenCalled();
	await click("View anyway");
	expect(confirm).toHaveBeenCalledTimes(1);
	expect(page.mock.calls[0]?.[2]).toBe(0);
	expect(host.textContent).toContain("page at 0");
	await click("Next");
	expect(page.mock.calls[1]?.[2]).toBe(FILE_PANEL_PAGE_BYTES);
	expect(host.textContent).toContain(`page at ${FILE_PANEL_PAGE_BYTES}`);
	await click("Previous");
	expect(host.textContent).toContain("page at 0");
	expect(host.querySelector("[data-normal-viewer]")).toBeNull();
});

test("small files mount the existing viewer without a paged read", async () => {
	info.mockResolvedValue({
		target: { deviceId: "local", path: "/small.txt" },
		fileName: "small.txt",
		size: 1024,
	});
	await render();
	expect(host.querySelector("[data-normal-viewer]")).not.toBeNull();
	expect(page).not.toHaveBeenCalled();
});

test("over 1 GiB stays blocked even with a saved confirmation", async () => {
	info.mockResolvedValue({
		target: { deviceId: "local", path: "/large.txt" },
		fileName: "large.txt",
		size: MAX_FILE_PANEL_BYTES + 1,
	});
	await render({ confirmed: true });
	expect(host.textContent).toContain("1 GiB viewing limit");
	expect(host.textContent).not.toContain("View anyway");
	expect(page).not.toHaveBeenCalled();
});

test("saved pane confirmation loads pages, not the full editor", async () => {
	await render({ confirmed: true });
	expect(page).toHaveBeenCalledTimes(1);
	expect(host.querySelector("[data-normal-viewer]")).toBeNull();
});

test("drawer confirmation is scoped to the drawer identity", async () => {
	await render({ persistenceKey: "drawer:a" });
	await click("View anyway");
	expect(storage.get("drawer:a")).toBe("true");
	await render({ persistenceKey: "drawer:b", filePath: "/other.txt" });
	expect(host.textContent).toContain("View anyway");
	await render({ persistenceKey: "drawer:a", filePath: "/large.txt" });
	expect(host.textContent).toContain("page at 0");
});

test("resource changes cancel in-flight metadata and ignore its late response", async () => {
	let oldSignal: AbortSignal | undefined;
	let complete: ((value: Awaited<ReturnType<typeof fileReferenceApi.info>>) => void) | undefined;
	info.mockImplementationOnce((_narrator, _target, signal) => {
		oldSignal = signal;
		return new Promise((resolve) => {
			complete = resolve;
		});
	});
	await render();
	await render({ filePath: "/other.txt" });
	expect(oldSignal?.aborted).toBe(true);
	await act(async () =>
		complete?.({
			target: { deviceId: "local", path: "/large.txt" },
			fileName: "wrong.txt",
			size: 1,
		}),
	);
	expect(host.textContent).not.toContain("wrong.txt");
	expect(host.querySelector("[data-normal-viewer]")).toBeNull();
});

test("permission failures do not mount or read the file and can be retried", async () => {
	info.mockRejectedValueOnce(new Error("Read policy denies this file"));
	await render({ confirmed: true });
	expect(host.textContent).toContain("Read policy denies");
	expect(page).not.toHaveBeenCalled();
	expect(host.querySelector("[data-normal-viewer]")).toBeNull();
	await click("Retry");
	expect(page).toHaveBeenCalledTimes(1);
});

test("unmount aborts an in-flight page read", async () => {
	let signal: AbortSignal | undefined;
	page.mockImplementationOnce((_narrator, _target, _offset, value) => {
		signal = value;
		return new Promise(() => {});
	});
	await render({ confirmed: true });
	await act(async () => root.render(null));
	expect(signal?.aborted).toBe(true);
});
