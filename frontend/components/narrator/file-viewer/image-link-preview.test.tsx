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

/** The pan/zoom canvas → transform wrapper → picture chain inside an embedded preview. */
function picture(): HTMLImageElement {
	const img = host.querySelector("img");
	expect(img).not.toBeNull();
	return img as HTMLImageElement;
}
function canvas(): HTMLElement {
	return picture().parentElement?.parentElement as HTMLElement;
}
/** Dispatch a pointer gesture; `target` decides whether it counts as "on the content". */
async function gesture(target: Element, steps: Array<[string, number, number]>) {
	for (const [type, x, y] of steps) {
		const event = new Event(type, { bubbles: true });
		Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
		await act(async () => target.dispatchEvent(event));
	}
}

describe("clicking a picture in the file browser", () => {
	test("opens the enlarged preview with the same picture", async () => {
		const blob = new Blob(["image bytes"], { type: "image/png" });
		previewSpy.mockResolvedValue(blob);
		await renderPreview("local");
		// The pointer affordance announces it: `cursor` is inherited by the picture.
		expect(canvas().style.cursor).toBe("zoom-in");
		await gesture(picture(), [
			["pointerdown", 10, 20],
			["pointerup", 10, 20],
		]);
		expect(openFullscreen).toHaveBeenCalledTimes(1);
		expect(openFullscreen).toHaveBeenCalledWith({
			src: "blob:panel-preview",
			blob,
			filename: "photo.png",
			alt: "photo.png",
		});
	});

	test("panning the picture is a drag, not a click, so it never opens", async () => {
		previewSpy.mockResolvedValue(new Blob(["image bytes"], { type: "image/png" }));
		await renderPreview("local");
		await gesture(picture(), [
			["pointerdown", 10, 20],
			["pointermove", 40, 60],
			["pointerup", 40, 60],
		]);
		expect(openFullscreen).not.toHaveBeenCalled();
		expect(picture().parentElement?.style.transform).toContain("translate(30px, 40px)");
	});

	test("a click on the empty canvas around the picture does not open it", async () => {
		previewSpy.mockResolvedValue(new Blob(["image bytes"], { type: "image/png" }));
		await renderPreview("local");
		const backdrop = canvas();
		await gesture(backdrop, [
			["pointerdown", 0, 0],
			["pointerup", 0, 0],
		]);
		expect(openFullscreen).not.toHaveBeenCalled();
	});
});

describe("non-image files keep their existing behaviour", () => {
	async function renderPdf() {
		const realFetch = globalThis.fetch;
		// The legacy `/api/fs/preview` path is an authenticated fetch, so it reads the
		// stored token; this scaffold only needs "no token" rather than real storage.
		const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => null, setItem() {}, removeItem() {} },
		});
		const fetchMock = mock(
			async () =>
				new Response(new Blob(["pdf bytes"], { type: "application/pdf" }), {
					status: 200,
					headers: { "content-type": "application/pdf" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await act(async () => {
			root.render(
				<MantineProvider>
					<ImageViewerContext.Provider value={{ open: openFullscreen }}>
						{/* Legacy reader = the plain /api/fs/preview path used by non-reference panels. */}
						<BinaryFilePreview filePath="/work/manual.pdf" previewType="pdf" readerMode="legacy" />
					</ImageViewerContext.Provider>
				</MantineProvider>,
			);
		});
		// The preview reads the response body as a stream, so let those ticks settle.
		for (let attempt = 0; attempt < 20 && !host.querySelector("iframe"); attempt++) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		}
		return () => {
			globalThis.fetch = realFetch;
			if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
			else Reflect.deleteProperty(globalThis, "localStorage");
		};
	}

	test("a PDF stays an iframe with no zoom stage and no click-to-enlarge", async () => {
		const restoreFetch = await renderPdf();
		try {
			expect(host.querySelector("iframe")).not.toBeNull();
			expect(host.querySelector("img")).toBeNull();
			// No pan/zoom stage, so no wheel zoom and no zoom controls either.
			expect(host.querySelector("[data-panzoom-mode]")).toBeNull();
			expect(host.querySelector('[aria-label="imageViewer_zoomIn"]')).toBeNull();
			expect(openFullscreen).not.toHaveBeenCalled();
			expect(previewSpy).not.toHaveBeenCalled();
		} finally {
			restoreFetch();
		}
	});
});
