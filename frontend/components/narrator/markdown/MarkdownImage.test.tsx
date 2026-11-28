import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_FILE_REFERENCE_IMAGE_BYTES } from "@shared/file-reference-image";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImageViewerContext, type ImageViewerOptions } from "../../common/image-viewer-context";
import {
	FileReferenceScopeProvider,
	type FileReferenceScopeValue,
} from "../composer/FileReferenceScope";
import { MarkdownContent } from "./MarkdownContent";

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
let saved: Map<string, PropertyDescriptor | undefined>;
let root: Root;
let container: HTMLDivElement;
const originalFetch = globalThis.fetch;
let requests: Array<{ url: URL; options?: RequestInit }>;
let created: ReturnType<typeof spyOn<typeof URL, "createObjectURL">>;
let revoked: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;
let response: () => Response;

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
	response = () =>
		new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
	globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
		requests.push({ url: new URL(String(input), "http://test"), options });
		return response();
	}) as typeof fetch;
	let id = 0;
	created = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++id}`);
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

async function render(src: string, scope: FileReferenceScopeValue = {}) {
	await act(async () => {
		root.render(
			<FileReferenceScopeProvider value={scope}>
				<MarkdownContent text={`![截图](${src})`} />
			</FileReferenceScopeProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
const localScope = { context: { deviceId: "local", cwd: "/repo/docs" } };

/** Render an arbitrary tree under the same scope provider the real panels supply. */
async function renderNode(node: ReactElement, scope: FileReferenceScopeValue = {}) {
	await act(async () => {
		root.render(<FileReferenceScopeProvider value={scope}>{node}</FileReferenceScopeProvider>);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function click(node: Element | null) {
	await act(async () => {
		node?.dispatchEvent(new window.Event("click", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("Markdown inline images in the rendered preview", () => {
	// A rendered document's picture is the natural place to click for a closer look, so
	// the preview hands the bytes to the shared fullscreen viewer instead of making people
	// find a toolbar button first.
	test("clicking a rendered picture opens the viewer with the read bytes", async () => {
		const opens: ImageViewerOptions[] = [];
		await renderNode(
			<ImageViewerContext.Provider value={{ open: (options) => opens.push(options) }}>
				<MarkdownContent text={"![截图](./images/中文%20截图.png)"} />
			</ImageViewerContext.Provider>,
			localScope,
		);
		const image = container.querySelector("img");
		expect(image?.style.cursor).toBe("zoom-in");
		await click(image);
		expect(opens).toHaveLength(1);
		// `blob` is what makes the enlarged view survive this component unmounting: the
		// viewer mints its own URL from the bytes rather than borrowing ours.
		expect(opens[0].src).toBe("blob:test-1");
		expect(opens[0].blob?.size).toBe(3);
		expect(opens[0].blob?.type).toBe("image/png");
		expect(opens[0].filename).toBe("中文 截图.png");
		expect(opens[0].alt).toBe("截图");
	});

	test("the preview URL is still released even after the picture was enlarged", async () => {
		const opens: ImageViewerOptions[] = [];
		await renderNode(
			<ImageViewerContext.Provider value={{ open: (options) => opens.push(options) }}>
				<MarkdownContent text={"![截图](./images/a.png)"} />
			</ImageViewerContext.Provider>,
			localScope,
		);
		await click(container.querySelector("img"));
		await act(async () => root.render(null));
		// Ours is revoked; the blob handed over keeps working in the viewer.
		expect(revoked).toHaveBeenCalledWith("blob:test-1");
		expect(opens[0].blob?.size).toBe(3);
	});

	test("without a mounted viewer the picture still renders and is not clickable", async () => {
		await render("images/a.png", localScope);
		const image = container.querySelector("img");
		expect(image?.getAttribute("src")).toBe("blob:test-1");
		// No provider means no enlarge target; the cursor must not promise one.
		expect(image?.style.cursor).toBe("");
		await click(image);
		expect(requests).toHaveLength(1);
	});
});

describe("pictures embedded in a document preview", () => {
	const documentPath = "/repo/design/spec.docx";
	const assetLink = (id: string) =>
		`![](nf-doc-asset:?doc=${encodeURIComponent(documentPath)}&id=${id})`;

	test("resolves a document asset through the document endpoint", async () => {
		await renderNode(<MarkdownContent text={assetLink("a1")} />, localScope);
		expect(requests).toHaveLength(1);
		expect(requests[0].url.pathname).toBe("/api/fs/document-asset");
		expect(requests[0].url.searchParams.get("path")).toBe(documentPath);
		expect(requests[0].url.searchParams.get("id")).toBe("a1");
		expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test-1");
	});

	test("clicking an embedded picture enlarges it with the bytes it already has", async () => {
		const opens: ImageViewerOptions[] = [];
		await renderNode(
			<ImageViewerContext.Provider value={{ open: (options) => opens.push(options) }}>
				<MarkdownContent text={assetLink("a1")} />
			</ImageViewerContext.Provider>,
			localScope,
		);
		await click(container.querySelector("img"));
		expect(opens).toHaveLength(1);
		expect(opens[0].src).toBe("blob:test-1");
		// Same contract as a repository image: the viewer owns its own URL from the bytes.
		expect(opens[0].blob?.size).toBe(3);
	});

	test("a failed asset read keeps the alt text instead of a broken image", async () => {
		response = () => Response.json({ error: "unknown asset" }, { status: 400 });
		await renderNode(<MarkdownContent text={assetLink("a9")} />, localScope);
		expect(container.querySelector("img")).toBeNull();
	});

	test("releases the object URL when the document preview unmounts", async () => {
		await renderNode(<MarkdownContent text={assetLink("a1")} />, localScope);
		await act(async () => root.render(null));
		expect(revoked).toHaveBeenCalledWith("blob:test-1");
	});
});

describe("Markdown repository images", () => {
	test("resolves encoded relative images from the document directory and sends auth", async () => {
		await render("../images/中文%20截图.png", localScope);
		expect(requests).toHaveLength(1);
		expect(requests[0].url.pathname).toBe("/api/fs/preview");
		expect(requests[0].url.searchParams.get("path")).toBe("/repo/images/中文 截图.png");
		expect(new Headers(requests[0].options?.headers).get("authorization")).toBe(
			"Bearer test-token",
		);
		expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test-1");
	});
	test("scoped images keep remote device and Windows directory identity", async () => {
		await render("./images/a.png", {
			narratorId: "n/1",
			context: { deviceId: "RemoteABC", cwd: "C:\\repo\\docs" },
		});
		expect(requests[0].url.pathname).toBe("/api/narrators/n%2F1/file-references/image-preview");
		expect(requests[0].url.searchParams.get("deviceId")).toBe("RemoteABC");
		expect(requests[0].url.searchParams.get("path")).toBe("C:/repo/docs/images/a.png");
	});
	test("external URLs stay unchanged without a file request", async () => {
		await render("https://example.com/a.png?x=1#part", localScope);
		expect(requests).toHaveLength(0);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"https://example.com/a.png?x=1#part",
		);
	});
	test("missing context or remote narrator never falls back to server files or web routes", async () => {
		await render("images/a.png", { context: null });
		await render("images/a.png", { context: { deviceId: "remote", cwd: "/repo" } });
		expect(requests).toHaveLength(0);
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("截图");
	});
	test("denied, non-image and oversized responses show alt without URL fallback", async () => {
		for (const failure of [
			() => Response.json({ error: "denied" }, { status: 403 }),
			() => new Response("html", { headers: { "content-type": "text/html" } }),
			() =>
				new Response("big", {
					headers: {
						"content-type": "image/png",
						"content-length": String(MAX_FILE_REFERENCE_IMAGE_BYTES + 1),
					},
				}),
		]) {
			response = failure;
			await render(`image-${requests.length}.png`, localScope);
			expect(container.querySelector("img")).toBeNull();
			expect(container.textContent).toContain("截图");
		}
		expect(created).not.toHaveBeenCalled();
	});
	test("unmount cancels pending reads and ignores late responses", async () => {
		let signal: AbortSignal | null | undefined;
		let finish: ((response: Response) => void) | undefined;
		globalThis.fetch = ((_input: unknown, options?: RequestInit) => {
			signal = options?.signal;
			return new Promise<Response>((resolve) => {
				finish = resolve;
			});
		}) as typeof fetch;
		await render("pending.png", localScope);
		expect(signal?.aborted).toBe(false);
		await act(async () => root.render(null));
		expect(signal?.aborted).toBe(true);
		await act(async () => {
			finish?.(response());
		});
		expect(created).not.toHaveBeenCalled();
	});
	test("path changes and unmount release each Blob URL", async () => {
		await render("a.png", localScope);
		await render("b.png", localScope);
		expect(revoked).toHaveBeenCalledWith("blob:test-1");
		expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test-2");
		await act(async () => root.render(null));
		expect(revoked).toHaveBeenCalledWith("blob:test-2");
	});
});
