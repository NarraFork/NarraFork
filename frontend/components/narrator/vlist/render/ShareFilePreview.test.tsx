import { afterEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { SharePreviewRef } from "@shared/share-preview";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../../locales/en/narrator.json";
import { ImageViewerContext } from "../../../common/image-viewer-context";
import { ShareFilePreview } from "./ShareFilePreview";

let root: Root | undefined;
let host: HTMLElement;
const previous = new Map<string, PropertyDescriptor | undefined>();
const instance = i18next.createInstance();
await instance.init({
	lng: "en",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
});
const requests: string[] = [];
const mediaCalls: string[] = [];
let status = 200;
async function mount(
	kind: SharePreviewRef["kind"],
	filename: string,
	url = "/api/shares/test/preview",
) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [name, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		fetch: async (url: string) => {
			requests.push(url);
			return new Response("hello", { status });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<MantineProvider forceColorScheme="dark">
				<I18nextProvider i18n={instance}>
					<ImageViewerContext.Provider value={{ open() {} }}>
						<ShareFilePreview
							preview={{
								kind,
								filename,
								mime: "application/octet-stream",
								url,
								downloadUrl: "/api/shares/test",
							}}
							height={280}
						/>
					</ImageViewerContext.Provider>
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}
function button(label: string) {
	const result = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
	if (!result) throw new Error(`No button: ${label}`);
	return result;
}
afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	host?.remove();
	for (const [name, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	previous.clear();
	requests.length = 0;
	mediaCalls.length = 0;
	status = 200;
});

describe("ShareFilePreview lifecycle", () => {
	for (const kind of ["video", "audio"] as const)
		test(`${kind} waits for activation, uses a direct URL and releases playback on unmount`, async () => {
			await mount(kind, kind === "video" ? "x.mp4" : "x.mp3");
			expect(requests).toEqual([]);
			expect(host.querySelector(kind)).toBeNull();
			const before = host.firstElementChild?.getAttribute("style");
			await act(async () => button("Load preview").click());
			const media = host.querySelector(kind) as HTMLMediaElement;
			expect(media).not.toBeNull();
			expect(media.getAttribute("src")).toBe("/api/shares/test/preview");
			expect(media.getAttribute("preload")).toBe("metadata");
			expect(requests).toEqual(["/api/shares/test/preview-info"]);
			expect(host.firstElementChild?.getAttribute("style")).toBe(before);
			// Linkedom has no media engine: install methods only on this element, not the shared prototype.
			media.pause = () => {
				mediaCalls.push("pause");
			};
			media.load = () => {
				mediaCalls.push("load");
			};
			await act(async () => root?.unmount());
			root = undefined;
			expect(mediaCalls).toEqual(["pause", "load"]);
			expect(media.getAttribute("src")).toBeNull();
		});
	test("HTML is embedded in an opaque-origin sandbox and PDF uses the native viewer", async () => {
		await mount("html", "x.html");
		await act(async () => button("Load preview").click());
		expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
		expect(host.querySelector("iframe")?.getAttribute("referrerPolicy")).toBe("no-referrer");
	});
	test("unsupported types have an explicit notice and download, never an empty media box", async () => {
		await mount("unsupported", "x.zip");
		expect(host.textContent).toContain("cannot be previewed");
		expect(host.querySelector("a")?.getAttribute("href")).toBe("/api/shares/test");
		expect(requests).toEqual([]);
	});
	test("expired share errors are distinct from unsupported file errors", async () => {
		status = 404;
		await mount("video", "x.mp4");
		await act(async () => button("Load preview").click());
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("expired");
		expect(host.querySelector("video")).toBeNull();
	});
});
