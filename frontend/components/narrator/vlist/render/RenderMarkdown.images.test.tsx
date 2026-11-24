import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImageViewerContext, type ImageViewerOptions } from "../../../common/image-viewer-context";
import {
	FileReferenceScopeProvider,
	type FileReferenceScopeValue,
} from "../../composer/FileReferenceScope";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { MARKDOWN_CONSTANTS } from "../parse-markdown";
import { hasUnpredictableBlock } from "../vlist-unpredictable-blocks";

let measureMarkdown: typeof import("../measure/measure-markdown").measureMarkdown;
let RenderMarkdown: typeof import("./RenderMarkdown").RenderMarkdown;
let disposeCanvas: () => void;
const globals = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Text",
	"localStorage",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalFetch = globalThis.fetch;
let saved: Map<string, PropertyDescriptor | undefined>;
let root: Root;
let container: HTMLDivElement;
let requests: Array<{ url: URL; options?: RequestInit }>;
let response: () => Response | Promise<Response>;
let created: ReturnType<typeof spyOn<typeof URL, "createObjectURL">>;
let revoked: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;
let opens: ImageViewerOptions[];
let reports: number[];

beforeAll(async () => {
	disposeCanvas = installCanvasStub();
	({ measureMarkdown } = await import("../measure/measure-markdown"));
	({ RenderMarkdown } = await import("./RenderMarkdown"));
});
afterAll(() => disposeCanvas());
beforeEach(() => {
	saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const name of globals) {
		const value =
			name === "IS_REACT_ACT_ENVIRONMENT"
				? true
				: name === "localStorage"
					? { getItem: () => "test-token" }
					: window[name as keyof typeof window];
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	requests = [];
	opens = [];
	reports = [];
	response = picture;
	globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
		requests.push({ url: new URL(String(input), "http://test"), options });
		return response();
	}) as typeof fetch;
	let id = 0;
	created = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fixed-image-${++id}`);
	revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	created.mockRestore();
	revoked.mockRestore();
	globalThis.fetch = originalFetch;
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

function picture() {
	return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
}

const scope: FileReferenceScopeValue = {
	narratorId: "n/1",
	context: { deviceId: "remote-PC", cwd: "C:/historical/docs" },
};

async function render(markdown: string, fileScope = scope, width = 390) {
	const measured = measureMarkdown(markdown, width);
	expect(hasUnpredictableBlock(measured.blocks)).toBe(false);
	await act(async () => {
		root.render(
			<MantineProvider>
				<FileReferenceScopeProvider value={fileScope}>
					<ImageViewerContext.Provider value={{ open: (options) => opens.push(options) }}>
						<RenderMarkdown
							measured={measured}
							onUnknownHeight={(height) => reports.push(height)}
						/>
					</ImageViewerContext.Provider>
				</FileReferenceScopeProvider>
			</MantineProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return measured;
}

function slot(): HTMLElement {
	const value = container.querySelector<HTMLElement>("[data-vlist-markdown-image]");
	if (!value) throw new Error("Markdown image slot did not render");
	return value;
}

/** These are model/paint assertions; the paired Chromium suite verifies actual pixel geometry. */
function geometry() {
	return {
		body: container.querySelector<HTMLElement>("[data-md-body]")?.style.height,
		slots: [...container.querySelectorAll<HTMLElement>("[data-vlist-markdown-image]")].map((node) =>
			node.getAttribute("style"),
		),
		text: [...container.querySelectorAll<HTMLElement>("[data-vlist-inline-block]")].map((node) =>
			node.getAttribute("style"),
		),
	};
}

async function imageEvent(type: string) {
	await act(async () => {
		container.querySelector("img")?.dispatchEvent(new window.Event(type, { bubbles: true }));
	});
}

test("real Markdown parsing and measurement paint each authored image in a fixed slot", async () => {
	const measured = await render(
		'before ![wide](https://example.com/wide.png "title") after\n\n![](https://example.com/tall.png)',
	);
	expect(MARKDOWN_CONSTANTS.IMAGE_PREVIEW_HEIGHT).toBe(200);
	expect(container.querySelectorAll("[data-vlist-markdown-image]")).toHaveLength(2);
	expect(container.querySelectorAll("img")).toHaveLength(2);
	expect(slot().style.height).toBe("200px");
	expect(container.querySelector("img")?.getAttribute("title")).toBe("title");
	expect(container.querySelector("img")?.style.objectFit).toBe("contain");
	expect(container.querySelector("img")?.style.height).toBe("200px");
	expect(container.textContent).toContain("before");
	expect(container.textContent).toContain("after");
	expect(container.querySelector<HTMLElement>("[data-md-body]")?.style.height).toBe(
		`${measured.frame.contentHeight}px`,
	);
	expect(requests).toHaveLength(0);
	expect(reports).toEqual([]);
});

test("a delayed historical-device read only changes pixels, and clicking hands bytes to the viewer", async () => {
	let finish: ((value: Response) => void) | undefined;
	response = () => new Promise<Response>((resolve) => (finish = resolve));
	await render("before\n\n![截图](./images/a.png)\n\nafter");
	expect(slot().textContent).toBe("截图");
	expect(container.querySelector("img")).toBeNull();
	expect(requests).toHaveLength(1);
	expect(requests[0].url.pathname).toBe("/api/narrators/n%2F1/file-references/image-preview");
	expect(requests[0].url.searchParams.get("deviceId")).toBe("remote-PC");
	expect(requests[0].url.searchParams.get("path")).toBe("C:/historical/docs/images/a.png");
	expect(new Headers(requests[0].options?.headers).get("authorization")).toBe("Bearer test-token");
	const before = geometry();
	await act(async () => finish?.(picture()));
	expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixed-image-1");
	await imageEvent("load");
	expect(geometry()).toEqual(before);
	expect(reports).toEqual([]);
	await imageEvent("click");
	expect(opens).toHaveLength(1);
	expect(opens[0].blob?.size).toBe(3);
	expect(opens[0].filename).toBe("a.png");
	await act(async () => root.render(null));
	expect(revoked).toHaveBeenCalledWith("blob:fixed-image-1");
	expect(opens[0].blob?.size).toBe(3);
});

test("denied scoped reads retain the alt and slot instead of using an unscoped fallback", async () => {
	response = () => Response.json({ error: "denied" }, { status: 403 });
	await render("![denied](images/a.png)");
	expect(slot().style.height).toBe("200px");
	expect(slot().textContent).toBe("denied");
	expect(container.querySelector("img")).toBeNull();
	expect(requests).toHaveLength(1);
	expect(requests[0].url.pathname).toContain("/file-references/image-preview");
	expect(created).not.toHaveBeenCalled();
	expect(reports).toEqual([]);
});

test("decode errors keep the same geometry, never retry, and a different image can render", async () => {
	await render("before\n\n![bad image](https://example.com/bad.png)\n\nafter");
	const before = geometry();
	await imageEvent("error");
	expect(container.querySelector("img")).toBeNull();
	expect(slot().textContent).toBe("bad image");
	expect(geometry()).toEqual(before);
	await render("before\n\n![bad image](https://example.com/bad.png)\n\nafter");
	expect(container.querySelector("img")).toBeNull();
	await render("before\n\n![good image](https://example.com/good.png)\n\nafter");
	expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/good.png");
	expect(geometry()).toEqual(before);
	expect(requests).toHaveLength(0);
	expect(reports).toEqual([]);
});

test("unmount aborts reads; remounting preserves the reservation and ignores the old response", async () => {
	const pending: Array<(value: Response) => void> = [];
	response = () => new Promise<Response>((resolve) => pending.push(resolve));
	const markdown = "before\n\n![remount](images/a.png)\n\nafter";
	await render(markdown);
	const before = geometry();
	const signal = requests[0].options?.signal;
	await act(async () => root.render(null));
	expect(signal?.aborted).toBe(true);
	await render(markdown);
	expect(geometry()).toEqual(before);
	await act(async () => pending[0](picture()));
	expect(created).not.toHaveBeenCalled();
	await act(async () => pending[1](picture()));
	expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixed-image-1");
	expect(geometry()).toEqual(before);
	expect(reports).toEqual([]);
});

test("missing device scope and unsafe URLs cannot become relative web requests", async () => {
	await render("![missing](images/a.png)", { context: null });
	expect(slot().textContent).toBe("missing");
	expect(slot().style.height).toBe("200px");
	expect(container.querySelector("img")).toBeNull();
	await render("![unsafe](javascript:alert%281%29)");
	expect(container.querySelector("img")).toBeNull();
	expect(requests).toHaveLength(0);
	expect(created).not.toHaveBeenCalled();
});

test("list and quote decoration survive an image-only list item without changing its height", async () => {
	const measured = await render("> - ![quoted](https://example.com/quote.png)\n> - following item");
	const block = measured.blocks.find((value) => value.kind === "fixed");
	expect(block?.contentLeft).toBeGreaterThan(0);
	expect(block?.quoteRailLefts.length).toBeGreaterThan(0);
	expect(slot().style.height).toBe("200px");
	expect(slot().querySelector(".vlist-marker--bullet")).not.toBeNull();
	expect(container.textContent).toContain("following item");
	expect(reports).toEqual([]);
});

test("explicit image links retain their device/path query instead of using the current directory", async () => {
	await render("![explicit](nf-file://open?device=ExplicitPC&path=%2Frepo%2Fimages%2Fa.png)", {
		narratorId: "n/1",
		context: null,
	});
	expect(requests).toHaveLength(1);
	expect(requests[0].url.searchParams.get("deviceId")).toBe("ExplicitPC");
	expect(requests[0].url.searchParams.get("path")).toBe("/repo/images/a.png");
	expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixed-image-1");
	expect(slot().style.height).toBe("200px");
});
