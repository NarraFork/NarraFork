/**
 * The upload lane of `VListImage` names the panel narrator as the reference context
 * whenever the image belongs to another narrator (a fork showing its source's image),
 * so the server can authorize a reader of the fork without access to the source.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImageViewerContext } from "../../../common/image-viewer-context";
import { VListImage, type VListImageRef } from "./vlist-image";

const globals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLDivElement;
let requests: Array<{ url: URL; options?: RequestInit }>;
let created: ReturnType<typeof spyOn<typeof URL, "createObjectURL">>;
let revoked: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		localStorage: { getItem: (key: string) => (key === "narrafork_token" ? "tok" : null) },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	requests = [];
	globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
		requests.push({ url: new URL(String(input), "http://test"), options });
		return new Response("image", { headers: { "content-type": "image/png" } });
	}) as typeof fetch;
	created = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:image");
	revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	created.mockRestore();
	revoked.mockRestore();
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

async function load(media: VListImageRef, narratorId: string) {
	await act(async () => {
		root.render(
			<ImageViewerContext.Provider value={{ open: () => {} }}>
				<VListImage media={media} narratorId={narratorId} maxHeight={200} />
			</ImageViewerContext.Provider>,
		);
	});
	expect(requests).toHaveLength(1);
	expect(new Headers(requests[0].options?.headers).get("Authorization")).toBe("Bearer tok");
	expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:image");
	return requests[0].url;
}

describe("VListImage upload lane", () => {
	test("an image of the panel's own narrator is fetched without a reference context", async () => {
		const url = await load({ imageId: "img", filename: "a.png" }, "panel");
		expect(url.pathname).toBe("/api/uploads/panel/img");
		expect(url.search).toBe("");
	});

	test("an explicit owner equal to the panel narrator adds no context", async () => {
		const url = await load({ imageId: "img", uploadNarratorId: "panel" }, "panel");
		expect(url.pathname).toBe("/api/uploads/panel/img");
		expect(url.search).toBe("");
	});

	test("a fork's inherited image names the fork as the reference context", async () => {
		const url = await load({ imageId: "img", uploadNarratorId: "source" }, "fork");
		expect(url.pathname).toBe("/api/uploads/source/img");
		expect(url.searchParams.get("referencingNarratorId")).toBe("fork");
	});
});
