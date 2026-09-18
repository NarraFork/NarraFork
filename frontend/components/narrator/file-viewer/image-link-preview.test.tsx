import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { FileTarget } from "@shared/file-reference";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realI18next = { ...(await import("react-i18next")) };
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { fileReferenceApi } = await import("../../../lib/api/file-references");
const { ImageViewerContext } = await import("../../common/image-viewer-context");
const { BinaryFilePreview } = await import("./FileViewerContent");

let root: Root;
let host: HTMLDivElement;
const openFullscreen = mock(() => {});
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const createUrl = mock(() => "blob:panel-preview");
const revokeUrl = mock(() => {});
let previewSpy: ReturnType<typeof spyOn<typeof fileReferenceApi, "imagePreview">>;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	Object.assign(window, {
		matchMedia,
		requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(fn, 0),
		cancelAnimationFrame: clearTimeout,
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: clearTimeout,
		getComputedStyle: () => ({}),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	openFullscreen.mockClear();
	createUrl.mockClear();
	revokeUrl.mockClear();
	URL.createObjectURL = createUrl;
	URL.revokeObjectURL = revokeUrl;
	previewSpy = spyOn(fileReferenceApi, "imagePreview");
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	previewSpy.mockRestore();
	URL.createObjectURL = originalCreate;
	URL.revokeObjectURL = originalRevoke;
});

afterAll(() => {
	mock.module("react-i18next", () => realI18next);
	mock.restore();
});

async function renderPreview(
	deviceId: string,
	readerMode: "scoped" | "missing-context" = "scoped",
) {
	await act(async () => {
		root.render(
			<MantineProvider>
				<ImageViewerContext.Provider value={{ open: openFullscreen }}>
					<BinaryFilePreview
						filePath="/work/photo.png"
						previewType="image"
						narratorId={readerMode === "scoped" ? "source-narrator" : undefined}
						deviceId={deviceId}
						readerMode={readerMode}
					/>
				</ImageViewerContext.Provider>
			</MantineProvider>,
		);
	});
}

describe("image links in file panels", () => {
	for (const deviceId of ["local", "remote-device"]) {
		test(`uses scoped reader and shared controls for ${deviceId}`, async () => {
			const blob = new Blob(["image bytes"], { type: "image/png" });
			previewSpy.mockResolvedValue(blob);
			await renderPreview(deviceId);
			expect(previewSpy).toHaveBeenCalledWith(
				"source-narrator",
				{ deviceId, path: "/work/photo.png" },
				expect.any(AbortSignal),
			);
			expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:panel-preview");
			expect(host.querySelector('[aria-label="imageViewer_rotateRight"]')).not.toBeNull();
			expect(host.querySelector('[aria-label="imageViewer_zoomIn"]')).not.toBeNull();
			const fullscreen = host.querySelector('[aria-label="imageViewer_fullscreen"]');
			expect(fullscreen).not.toBeNull();
			await act(async () => fullscreen?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect(openFullscreen).toHaveBeenCalledWith({
				src: "blob:panel-preview",
				blob,
				filename: "photo.png",
				alt: "photo.png",
			});
		});
	}

	test("missing narrator context fails without making any image request", async () => {
		await renderPreview("remote-device", "missing-context");
		expect(previewSpy).not.toHaveBeenCalled();
		expect(host.textContent).toContain("fileReferences.missingContext");
		expect(createUrl).not.toHaveBeenCalled();
	});

	test("a rejected scoped read stays an error rather than using the local reader", async () => {
		previewSpy.mockRejectedValue(new Error("Read denied"));
		await renderPreview("remote-device");
		expect(host.textContent).toContain("Read denied");
		expect(createUrl).not.toHaveBeenCalled();
	});

	test("unmount aborts in-flight reads and late results cannot create URLs", async () => {
		let finish!: (blob: Blob) => void;
		let signal: AbortSignal | undefined;
		previewSpy.mockImplementation((_id: string, _target: FileTarget, nextSignal?: AbortSignal) => {
			signal = nextSignal;
			return new Promise<Blob>((resolve) => {
				finish = resolve;
			});
		});
		await renderPreview("remote-device");
		await act(async () => root.render(null));
		expect(signal?.aborted).toBe(true);
		await act(async () => finish(new Blob(["late"])));
		expect(createUrl).not.toHaveBeenCalled();
	});

	test("unmount releases the panel URL", async () => {
		previewSpy.mockResolvedValue(new Blob(["image"]));
		await renderPreview("local");
		await act(async () => root.render(null));
		expect(revokeUrl).toHaveBeenCalledWith("blob:panel-preview");
	});
});
