import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import * as imageActions from "../../lib/image-actions";
import { ImageViewer } from "./ImageViewer";

// Keep image-actions and image-clipboard real: only browser boundaries are mocked.
const i18n = createInstance();
await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { common: {} } } });
const globalKeys = [
	"window",
	"location",
	"isSecureContext",
	"document",
	"navigator",
	"Event",
	"MouseEvent",
	"HTMLElement",
	"Element",
	"Node",
	"ResizeObserver",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
	"ClipboardItem",
	"Image",
	"fetch",
] as const;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let root: Root;
let container: HTMLDivElement;
let canvasEncodingFailure = false;
const anchorClick = mock(() => {});
const write = mock(async (items: TestClipboardItem[]) => {
	await Promise.all(Object.values(items[0].data));
});
class TestClipboardItem {
	static supports(type: string) {
		return type === "image/png";
	}
	constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
}
class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

beforeEach(() => {
	descriptors = new Map(
		globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
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
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		innerWidth: 1024,
		innerHeight: 768,
		location: { origin: "https://app.example" },
	});
	Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: { clipboard: { write } },
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: () => ({}),
		IS_REACT_ACT_ENVIRONMENT: true,
		ClipboardItem: TestClipboardItem,
		fetch: mock(async () => new Response(new Blob(["png"], { type: "image/png" }))),
	});
	write.mockReset();
	write.mockImplementation(async (items) => {
		await Promise.all(Object.values(items[0].data));
	});
	anchorClick.mockReset();
	anchorClick.mockImplementation(() => {});
	canvasEncodingFailure = false;
	const createElement = document.createElement.bind(document);
	spyOn(document, "createElement").mockImplementation(
		(tag: string, options?: ElementCreationOptions) => {
			if (tag === "canvas" && canvasEncodingFailure)
				return {
					getContext: () => ({ drawImage() {} }),
					toBlob: (callback: BlobCallback) => callback(null),
				} as unknown as HTMLCanvasElement;
			const element = createElement(tag, options);
			if (tag === "a") element.click = anchorClick;
			return element;
		},
	);
	spyOn(notifications, "show").mockImplementation(() => "test-notification");
	spyOn(imageActions, "downloadImageSource");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	mock.restore();
	for (const [key, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function copy(src = "blob:shown-image", action = "imageViewer_copy") {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<ImageViewer embedded options={{ src, filename: "photo.png" }} />
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	const button = container.querySelector(`[aria-label="${action}"]`);
	expect(button).not.toBeNull();
	await act(async () => {
		button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}
function expectFailedWithoutDownload() {
	expect(notifications.show).toHaveBeenCalledWith({
		color: "red",
		message: "imageViewer_copyFailed",
	});
	expect(notifications.show).toHaveBeenCalledTimes(1);
	expect(imageActions.downloadImageSource).not.toHaveBeenCalled();
	expect(anchorClick).not.toHaveBeenCalled();
}

describe("ImageViewer copy with real image helpers", () => {
	test("secure clipboard permission rejection is red and never downloads", async () => {
		write.mockImplementation(async () => {
			throw new DOMException("User denied", "NotAllowedError");
		});
		await copy();
		expect(write).toHaveBeenCalledTimes(1);
		expectFailedWithoutDownload();
	});
	test("secure clipboard lost activation is red and never downloads", async () => {
		write.mockImplementation(async () => {
			throw new DOMException("Activation expired", "NotAllowedError");
		});
		await copy();
		expectFailedWithoutDownload();
	});
	test("ClipboardItem constructor failure is red and never downloads", async () => {
		Object.defineProperty(globalThis, "ClipboardItem", {
			configurable: true,
			value: class {
				constructor() {
					throw new TypeError("Invalid binary clipboard item");
				}
			},
		});
		await copy();
		expect(write).not.toHaveBeenCalled();
		expectFailedWithoutDownload();
	});
	test("fetch failure is red and never downloads", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
		await copy();
		expectFailedWithoutDownload();
	});
	test("binary encoding failure is red and never downloads", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new Blob(["jpeg"], { type: "image/jpeg" })),
		);
		spyOn(URL, "createObjectURL").mockReturnValue("blob:convert");
		spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		Object.defineProperty(globalThis, "Image", {
			configurable: true,
			value: class {
				naturalWidth = 1;
				naturalHeight = 1;
				onload?: () => void;
				set src(_value: string) {
					queueMicrotask(() => this.onload?.());
				}
			},
		});
		canvasEncodingFailure = true;
		await copy();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:convert");
		expectFailedWithoutDownload();
	});
	test("invalid inline data is red and never downloads", async () => {
		await copy("data:text/plain;base64,AA==");
		expectFailedWithoutDownload();
	});
	for (const missing of ["http", "write", "ClipboardItem"] as const) {
		test(`${missing} capability missing downloads with yellow unavailable message`, async () => {
			if (missing === "http") Object.defineProperty(window, "isSecureContext", { value: false });
			if (missing === "write")
				Object.defineProperty(globalThis, "navigator", { value: { clipboard: {} } });
			if (missing === "ClipboardItem") Reflect.deleteProperty(globalThis, "ClipboardItem");
			await copy();
			expect(write).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
			expect(anchorClick).toHaveBeenCalledTimes(1);
			expect(imageActions.downloadImageSource).toHaveBeenCalledTimes(1);
			expect(notifications.show).toHaveBeenCalledWith({
				color: "yellow",
				message: "imageViewer_copyUnavailableDownloaded",
			});
		});
	}
	for (const missing of ["http", "write", "ClipboardItem"] as const) {
		test(`${missing} with cross-origin CORS denial is red and never navigates`, async () => {
			if (missing === "http") Object.defineProperty(window, "isSecureContext", { value: false });
			if (missing === "write")
				Object.defineProperty(globalThis, "navigator", { value: { clipboard: {} } });
			if (missing === "ClipboardItem") Reflect.deleteProperty(globalThis, "ClipboardItem");
			spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("CORS denied"));
			await copy("https://images.example/photo.png");
			expect(write).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(imageActions.downloadImageSource).toHaveBeenCalledTimes(1);
			expect(anchorClick).not.toHaveBeenCalled();
			expect(notifications.show).toHaveBeenCalledWith({
				color: "red",
				message: "imageViewer_copyFailed",
			});
			expect(notifications.show).toHaveBeenCalledTimes(1);
		});
	}
	for (const src of ["data:image/png;base64,AA==", "https://app.example/photo.png"]) {
		test(`HTTP capability fallback for ${src} remains a yellow direct download`, async () => {
			Object.defineProperty(window, "isSecureContext", { value: false });
			await copy(src);
			expect(fetch).not.toHaveBeenCalled();
			expect(anchorClick).toHaveBeenCalledTimes(1);
			expect(notifications.show).toHaveBeenCalledWith({
				color: "yellow",
				message: "imageViewer_copyUnavailableDownloaded",
			});
		});
	}
	test("explicit Download retains the existing cross-origin direct-link fallback", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("CORS denied"));
		await copy("https://images.example/photo.png", "imageViewer_download");
		expect(imageActions.downloadImageSource).toHaveBeenCalledTimes(1);
		expect(anchorClick).toHaveBeenCalledTimes(1);
		expect(notifications.show).not.toHaveBeenCalled();
	});
	test("capability fallback download failure is red", async () => {
		Object.defineProperty(window, "isSecureContext", { value: false });
		anchorClick.mockImplementation(() => {
			throw new Error("Download blocked");
		});
		await copy();
		expect(anchorClick).toHaveBeenCalledTimes(1);
		expect(notifications.show).toHaveBeenCalledWith({
			color: "red",
			message: "imageViewer_copyFailed",
		});
		expect(notifications.show).toHaveBeenCalledTimes(1);
	});
	test("successful binary copy stays teal without downloading", async () => {
		await copy();
		expect(write).toHaveBeenCalledTimes(1);
		expect(imageActions.downloadImageSource).not.toHaveBeenCalled();
		expect(anchorClick).not.toHaveBeenCalled();
		expect(notifications.show).toHaveBeenCalledWith({
			color: "teal",
			message: "imageViewer_copySuccess",
		});
	});
});
