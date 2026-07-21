import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const { ImageViewerProvider, useImageViewer } = await import("./ImageViewerProvider");

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
