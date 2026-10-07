import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_SEARCH_BYTES,
	MAX_FILE_REFERENCE_SOURCE_BYTES,
} from "@shared/file-reference";
import { MAX_FILE_REFERENCE_IMAGE_BYTES } from "@shared/file-reference-image";
import { fileReferenceApi } from "./file-references";

const originalFetch = globalThis.fetch;
let previousStorage: PropertyDescriptor | undefined;
beforeEach(() => {
	previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null, setItem() {}, removeItem() {} },
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

function mockFetch(fn: (url: string, options?: RequestInit) => Response | Promise<Response>) {
	globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) =>
		fn(String(url), options)) as typeof fetch;
}

describe("file reference API contracts and budgets", () => {
	test("only explicit ordinary local panels use the legacy editor authorizer", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			return Response.json({ size: 100, content: "page" });
		});
		const local = { deviceId: "local", path: "/outside/a.txt" };
		await fileReferenceApi.info("n", local, undefined, "legacy");
		await fileReferenceApi.page("n", local, 0, undefined, "legacy");
		await fileReferenceApi.info("n", local, undefined, "reference");
		await fileReferenceApi.page("n", local, 0, undefined, "reference");
		await fileReferenceApi.info("n", { ...local, deviceId: "remote" }, undefined, "legacy");
		await fileReferenceApi.page("n", { ...local, deviceId: "remote" }, 0, undefined, "legacy");
		expect(urls.map((url) => new URL(url, "http://test").pathname)).toEqual([
			"/api/narrators/n/editor-documents/info",
			"/api/narrators/n/editor-documents/page",
			"/api/narrators/n/file-references/info",
			"/api/narrators/n/file-references/page",
			"/api/narrators/n/file-references/info",
			"/api/narrators/n/file-references/page",
		]);
	});
	test("only ordinary local viewers retain the fs preview authorizer", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			return Response.json({ size: 100, content: "page" });
		});
		await fileReferenceApi.info(
			"n",
			{ deviceId: "local", path: "/alias.txt" },
			undefined,
			"preview",
		);
		await fileReferenceApi.page(
			"n",
			{ deviceId: "local", path: "/alias.txt" },
			0,
			undefined,
			"preview",
		);
		await fileReferenceApi.info(
			"n",
			{ deviceId: "remote", path: "/alias.txt" },
			undefined,
			"preview",
		);
		await fileReferenceApi.page(
			"n",
			{ deviceId: "remote", path: "/alias.txt" },
			0,
			undefined,
			"preview",
		);
		expect(urls.map((url) => new URL(url, "http://test").pathname)).toEqual([
			"/api/fs/panel-info",
			"/api/fs/panel-page",
			"/api/narrators/n/file-references/info",
			"/api/narrators/n/file-references/page",
		]);
	});
	test("panel info and page encode explicit device paths and byte offsets", async () => {
		const urls: string[] = [];
		mockFetch((url) => {
			urls.push(url);
			return Response.json({ size: 100, content: "page" });
		});
		const target = { deviceId: "RemoteCase", path: "C:\\中文 files\\a.txt" };
		await fileReferenceApi.info("a/b", target);
		await fileReferenceApi.page("a/b", target, 262144);
		const info = new URL(urls[0], "http://test");
		const page = new URL(urls[1], "http://test");
		expect(info.pathname).toBe("/api/narrators/a%2Fb/file-references/info");
		expect(Object.fromEntries(page.searchParams)).toEqual({ ...target, offset: "262144" });
		for (const offset of [-1, 0.1, 1073741825])
			await expect(fileReferenceApi.page("n", target, offset)).rejects.toThrow(
				"Invalid file panel",
			);
		expect(urls).toHaveLength(2);
	});
	test("imagePreview encodes explicit targets and returns a typed binary Blob", async () => {
		let sentUrl = "";
		mockFetch((url) => {
			sentUrl = url;
			return new Response(new Uint8Array([0, 255, 1]), {
				headers: { "Content-Type": "image/png" },
			});
		});
		const image = await fileReferenceApi.imagePreview("a/b", {
			deviceId: "RemoteABC",
			path: "C:\\中文 files\\a.png",
		});
		expect(image).toBeInstanceOf(Blob);
		expect(image.type).toBe("image/png");
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
		const url = new URL(sentUrl, "http://test");
		expect(url.pathname).toBe("/api/narrators/a%2Fb/file-references/image-preview");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			deviceId: "RemoteABC",
			path: "C:\\中文 files\\a.png",
		});
	});
	test("imagePreview rejects oversized headers and chunked bodies with cancellation", async () => {
		for (const header of [false, true]) {
			let canceled = false;
			mockFetch(
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								if (!header) controller.enqueue(new Uint8Array(MAX_FILE_REFERENCE_IMAGE_BYTES + 1));
							},
							cancel() {
								canceled = true;
							},
						}),
						{
							headers: {
								"content-type": "image/png",
								...(header ? { "content-length": String(MAX_FILE_REFERENCE_IMAGE_BYTES + 1) } : {}),
							},
						},
					),
			);
			await expect(
				fileReferenceApi.imagePreview("n", { deviceId: "local", path: "/a.png" }),
			).rejects.toThrow("byte limit");
			expect(canceled).toBe(true);
		}
	});
	test("imagePreview permits SVG img blobs, rejects HTML and preserves API failures", async () => {
		mockFetch(() => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
		expect(
			(await fileReferenceApi.imagePreview("n", { deviceId: "local", path: "/a.svg" })).type,
		).toBe("image/svg+xml");
		mockFetch(() => new Response("<html/>", { headers: { "content-type": "text/html" } }));
		await expect(
			fileReferenceApi.imagePreview("n", { deviceId: "local", path: "/a.png" }),
		).rejects.toThrow("MIME");
		mockFetch(() => Response.json({ error: "DENIED", reason: "Read denied" }, { status: 403 }));
		await expect(
			fileReferenceApi.imagePreview("n", { deviceId: "local", path: "/a.png" }),
		).rejects.toMatchObject({ status: 403, message: "Read denied" });
	});
	test("imagePreview bounds JSON error bodies before parsing", async () => {
		let canceled = false;
		mockFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(MAX_FILE_REFERENCE_METADATA_BYTES + 1));
						},
						cancel() {
							canceled = true;
						},
					}),
					{ status: 403, headers: { "content-type": "application/json" } },
				),
		);
		await expect(
			fileReferenceApi.imagePreview("n", { deviceId: "local", path: "/a.png" }),
		).rejects.toThrow("byte limit");
		expect(canceled).toBe(true);
	});
	test("imagePreview abort cancels a stalled body", async () => {
		let canceled = false;
		const controller = new AbortController();
		mockFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull() {
							controller.abort(new Error("image canceled"));
						},
						cancel() {
							canceled = true;
						},
					}),
					{ headers: { "content-type": "image/png" } },
				),
		);
		await expect(
			fileReferenceApi.imagePreview("n", { deviceId: "local", path: "/a.png" }, controller.signal),
		).rejects.toThrow("image canceled");
		expect(canceled).toBe(true);
	});
	test("search encodes narrator, query, device and directory while forwarding cancellation", async () => {
		let sentUrl = "";
		let signal: AbortSignal | null | undefined;
		mockFetch((url, options) => {
			sentUrl = url;
			signal = options?.signal;
			return Response.json({ entries: [], truncated: false });
		});
		const controller = new AbortController();
		expect(
			await fileReferenceApi.search(
				"a/b",
				{ q: "中文 file", deviceId: "RemoteABC", directory: "C:\\work files" },
				controller.signal,
			),
		).toEqual({ entries: [], truncated: false });
		const url = new URL(sentUrl, "http://test");
		expect(url.pathname).toBe("/api/narrators/a%2Fb/file-references/search");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: "中文 file",
			deviceId: "RemoteABC",
			directory: "C:\\work files",
		});
		expect(signal).toBeDefined();
	});
	test("resolve sends targets and preview does not add unsupported selection parameters", async () => {
		const selection = { startLineNumber: 10, startColumn: 1, endLineNumber: 21, endColumn: 1 };
		const target = { deviceId: "RemoteABC", path: "/work/中文.ts", selection };
		const requests: Array<{ url: string; options?: RequestInit }> = [];
		mockFetch((url, options) => {
			requests.push({ url, options });
			return Response.json(
				url.includes("resolve")
					? { targets: [target] }
					: {
							target,
							content: "saved source",
							hash: "hash",
							encoding: "utf-8",
							fileName: "中文.ts",
						},
			);
		});
		expect(await fileReferenceApi.resolve("n1", [target])).toEqual({ targets: [target] });
		expect(requests[0]?.options?.method).toBe("POST");
		expect(JSON.parse(String(requests[0]?.options?.body))).toEqual({ targets: [target] });
		await fileReferenceApi.preview("n1", target);
		expect([...new URL(requests[1]?.url ?? "", "http://test").searchParams.keys()]).toEqual([
			"deviceId",
			"path",
		]);
	});
	test("oversized search bodies are canceled while streaming, not collected then truncated", async () => {
		let canceled = false;
		mockFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(MAX_FILE_REFERENCE_SEARCH_BYTES + 1));
						},
						cancel() {
							canceled = true;
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		await expect(fileReferenceApi.search("n1", { q: "src" })).rejects.toThrow("byte limit");
		expect(canceled).toBe(true);
	});
	test("preview enforces its escaped-JSON budget from headers before reading", async () => {
		let canceled = false;
		mockFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							canceled = true;
						},
					}),
					{
						headers: {
							"content-length": String(
								MAX_FILE_REFERENCE_SOURCE_BYTES * 6 + MAX_FILE_REFERENCE_METADATA_BYTES + 1,
							),
						},
					},
				),
		);
		await expect(fileReferenceApi.preview("n1", { deviceId: "local", path: "/a" })).rejects.toThrow(
			"byte limit",
		);
		expect(canceled).toBe(true);
	});
	test("cancel aborts an in-progress body reader even if the transport ignores the signal", async () => {
		let canceled = false;
		let fetched: (() => void) | undefined;
		const fetching = new Promise<void>((resolve) => {
			fetched = resolve;
		});
		mockFetch(() => {
			fetched?.();
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("{"));
					},
					cancel() {
						canceled = true;
					},
				}),
			);
		});
		const controller = new AbortController();
		const pending = fileReferenceApi.preview(
			"n1",
			{ deviceId: "local", path: "/a" },
			controller.signal,
		);
		await fetching;
		await Promise.resolve();
		controller.abort(new Error("cancelled by user"));
		await expect(pending).rejects.toThrow("cancelled by user");
		expect(canceled).toBe(true);
	});
	test("errors preserve status/details and oversized outgoing metadata never makes a request", async () => {
		let calls = 0;
		mockFetch(() => {
			calls++;
			return Response.json({ error: "READ_DENIED", reason: "Not readable" }, { status: 403 });
		});
		await expect(fileReferenceApi.search("n1", { q: "secret" })).rejects.toMatchObject({
			status: 403,
			message: "Not readable",
		});
		await expect(fileReferenceApi.search("n1", { q: "x".repeat(257) })).rejects.toThrow("limit");
		await expect(
			fileReferenceApi.resolve(
				"n1",
				Array.from({ length: 17 }, () => ({ deviceId: "local", path: "/a" })),
			),
		).rejects.toThrow("limit");
		expect(calls).toBe(1);
	});
});
