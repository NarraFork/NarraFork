import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const copyImageMock = mock(async () => {});
const downloadImageMock = mock(async () => {});
const realReactI18nextModule = { ...(await import("react-i18next")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../../lib/image-actions", () => ({
	copyImageSourceToClipboard: copyImageMock,
	downloadImageSource: downloadImageMock,
}));
mock.module("@mantine/notifications", () => ({
	notifications: { show: () => {} },
}));

// Two modules since the hook was split out of the provider (a non-component export made
// the provider an invalid Fast Refresh boundary — see `image-viewer-context.ts`). Both are
// still imported dynamically, after the `mock.module` calls above have been registered.
const { ImageViewerProvider } = await import("./ImageViewerProvider");
const { useImageViewer } = await import("./image-viewer-context");
const { ImageViewer } = await import("./ImageViewer");
const { PanZoomStage } = await import("./PanZoomStage");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
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
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	Object.assign(window, {
		requestAnimationFrame,
		cancelAnimationFrame,
		matchMedia,
		innerWidth: 1024,
		innerHeight: 768,
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
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

function ViewerLauncher() {
	const openImage = useImageViewer();
	return (
		<button type="button" onClick={() => openImage({ src: "data:image/png;base64,AA==" })}>
			open
		</button>
	);
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	copyImageMock.mockClear();
	downloadImageMock.mockClear();
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.restore();
});

async function openContextMenu() {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<ImageViewerProvider>
					<ViewerLauncher />
				</ImageViewerProvider>
			</MantineProvider>,
		);
	});
	const launcher = document.body.querySelector("button");
	await act(async () => launcher?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const image = document.body.querySelector("img");
	const contextMenuEvent = new MouseEvent("contextmenu", { bubbles: true });
	Object.defineProperties(contextMenuEvent, {
		clientX: { value: 40 },
		clientY: { value: 40 },
	});
	await act(async () => image?.dispatchEvent(contextMenuEvent));
}

async function clickAction(label: string) {
	const button = document.querySelector(`[aria-label="${label}"]`);
	expect(button).not.toBeNull();
	await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function key(target: EventTarget, value: string, extra = {}) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: value, ...extra });
	await act(async () => target.dispatchEvent(event));
}

function focus(element: Element) {
	// linkedom does not implement activeElement/focus tracking.
	Object.defineProperty(document, "activeElement", { configurable: true, value: element });
}

describe("embedded image viewer", () => {
	test("shares toolbar actions, rotation/reset and panel sizing without locking body", async () => {
		document.body.style.overflow = "auto";
		const fullscreen = mock(() => {});
		const error = mock(() => {});
		await act(async () =>
			root?.render(
				<MantineProvider>
					<ImageViewer
						embedded
						options={{ src: "blob:panel", filename: "photo.png" }}
						onFullscreen={fullscreen}
						onError={error}
					/>
				</MantineProvider>,
			),
		);
		expect(document.body.style.overflow).toBe("auto");
		const stage = document.querySelector('[data-panzoom-mode="embedded"]') as HTMLElement;
		expect(stage.style.position).toBe("relative");
		expect(stage.style.height).toBe("100%");
		const image = document.querySelector("img") as HTMLImageElement;
		expect(image.style.maxWidth).toBe("100cqw");
		expect(image.style.maxHeight).toBe("100cqh");
		await clickAction("imageViewer_zoomIn");
		expect(stage.textContent).toContain("125%");
		await clickAction("imageViewer_rotateRight");
		expect(image.parentElement?.style.transform).toContain("rotate(90deg)");
		await clickAction("imageViewer_reset");
		expect(image.parentElement?.style.transform).toContain("scale(1) rotate(0deg)");
		await clickAction("imageViewer_fullscreen");
		expect(fullscreen).toHaveBeenCalledTimes(1);
		await clickAction("imageViewer_copy");
		expect(copyImageMock).toHaveBeenCalledWith({ imageSrc: "blob:panel", savedPath: undefined });
		await clickAction("imageViewer_download");
		expect(downloadImageMock).toHaveBeenCalledWith({
			imageSrc: "blob:panel",
			filename: "photo.png",
			savedPath: undefined,
		});
		await act(async () => image.dispatchEvent(new Event("error")));
		expect(error).toHaveBeenCalledTimes(1);
	});

	test("canvas drag and wheel share transforms without dismissing the panel", async () => {
		const close = mock(() => {});
		await act(async () =>
			root?.render(
				<MantineProvider>
					<ImageViewer embedded options={{ src: "blob:panel" }} onClose={close} />
				</MantineProvider>,
			),
		);
		const image = document.querySelector("img") as HTMLImageElement;
		const canvas = image.parentElement?.parentElement as HTMLElement;
		const pointer = async (type: string, x: number, y: number) => {
			const event = new Event(type, { bubbles: true });
			Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
			await act(async () => canvas.dispatchEvent(event));
		};
		await pointer("pointerdown", 10, 20);
		await pointer("pointermove", 40, 60);
		await pointer("pointerup", 40, 60);
		expect(image.parentElement?.style.transform).toContain("translate(30px, 40px)");
		const wheel = new Event("wheel", { bubbles: true, cancelable: true });
		Object.assign(wheel, { deltaY: -100, clientX: 0, clientY: 0 });
		await act(async () => canvas.dispatchEvent(wheel));
		expect(document.querySelector('[data-panzoom-mode="embedded"]')?.textContent).toContain("116%");
		expect(close).not.toHaveBeenCalled();
	});

	test("shortcuts require panel focus, ignore inputs/modifiers, and yield to fullscreen", async () => {
		await act(async () =>
			root?.render(
				<MantineProvider>
					<PanZoomStage embedded enableRotateKey>
						<input />
						<span>content</span>
					</PanZoomStage>
				</MantineProvider>,
			),
		);
		const stage = document.querySelector('[data-panzoom-mode="embedded"]') as HTMLElement;
		await key(window, "+");
		expect(stage.textContent).toContain("100%");
		focus(stage);
		await key(stage, "+");
		expect(stage.textContent).toContain("125%");
		await key(stage, "+", { ctrlKey: true });
		await key(stage, "+", { metaKey: true });
		await key(stage, "+", { altKey: true });
		const input = stage.querySelector("input") as HTMLInputElement;
		focus(input);
		await key(input, "+");
		expect(stage.textContent).toContain("125%");
		focus(stage);
		const overlay = document.createElement("div");
		overlay.dataset.panzoomMode = "fullscreen";
		document.body.appendChild(overlay);
		await key(stage, "+");
		expect(stage.textContent).toContain("125%");
		overlay.remove();
		await key(stage, "0");
		expect(stage.textContent).toContain("100%");
	});
});

describe("fullscreen stage compatibility", () => {
	test("arbitrary diagram content retains global shortcuts and scroll locking", async () => {
		const close = mock(() => {});
		document.body.style.overflow = "scroll";
		await act(async () =>
			root?.render(
				<MantineProvider>
					<PanZoomStage onClose={close}>
						<svg role="img" aria-label="diagram">
							<title>diagram</title>
						</svg>
					</PanZoomStage>
				</MantineProvider>,
			),
		);
		expect(document.body.style.overflow).toBe("hidden");
		await key(window, "+");
		expect(document.querySelector('[data-panzoom-mode="fullscreen"]')?.textContent).toContain(
			"125%",
		);
		await key(window, "Escape");
		expect(close).toHaveBeenCalledTimes(1);
		await act(async () => root?.unmount());
		root = undefined;
		expect(document.body.style.overflow).toBe("scroll");
	});
});

describe("fullscreen URL ownership", () => {
	test("releases owned URLs on replacement, close and unmount, not caller URLs", async () => {
		let count = 0;
		const create = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:owned-${++count}`);
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		let open: ReturnType<typeof useImageViewer> = () => {};
		function Capture() {
			open = useImageViewer();
			return null;
		}
		try {
			document.body.style.overflow = "auto";
			await act(async () =>
				root?.render(
					<MantineProvider>
						<ImageViewerProvider>
							<Capture />
						</ImageViewerProvider>
					</MantineProvider>,
				),
			);
			const blob = new Blob(["image"]);
			await act(async () => open({ src: "blob:panel", blob }));
			expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:owned-1");
			expect(document.body.style.overflow).toBe("hidden");
			// Unmounting the source panel does not unmount the provider's overlay.
			await act(async () =>
				root?.render(
					<MantineProvider>
						<ImageViewerProvider>{null}</ImageViewerProvider>
					</MantineProvider>,
				),
			);
			expect(revoke).not.toHaveBeenCalled();
			await act(async () => open({ src: "blob:panel-2", blob }));
			expect(revoke).toHaveBeenCalledWith("blob:owned-1");
			expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:owned-2");
			await key(window, "Escape");
			expect(revoke).toHaveBeenCalledWith("blob:owned-2");
			expect(document.body.style.overflow).toBe("auto");
			await act(async () => open({ src: "blob:panel", blob }));
			await act(async () => root?.unmount());
			root = undefined;
			expect(revoke).toHaveBeenCalledWith("blob:owned-3");
			expect(revoke).toHaveBeenCalledTimes(3);
			expect(create).toHaveBeenCalledTimes(3);
		} finally {
			create.mockRestore();
			revoke.mockRestore();
		}
	});
});

describe("ImageViewerProvider context menu", () => {
	test("runs the copy action", async () => {
		await openContextMenu();
		const copyItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
			(item) => item.textContent === "imageViewer_copy",
		);
		await act(async () => copyItem?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(copyImageMock).toHaveBeenCalledTimes(1);
	});

	test("runs the download action", async () => {
		await openContextMenu();
		const downloadItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
			(item) => item.textContent === "imageViewer_download",
		);
		await act(async () => downloadItem?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(downloadImageMock).toHaveBeenCalledTimes(1);
	});
});
