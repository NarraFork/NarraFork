import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_FILE_REFERENCE_IMAGE_BYTES } from "@shared/file-reference-image";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
