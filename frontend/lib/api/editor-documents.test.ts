import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EDITOR_METADATA_MAX_BYTES, EDITOR_TRANSFER_MAX_BYTES } from "@shared/editor-document";
import { editorDocumentApi, readEditorBody } from "./editor-documents";

const originalFetch = globalThis.fetch;
let storage: PropertyDescriptor | undefined;
beforeEach(() => {
	storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null, setItem() {}, removeItem() {} },
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (storage) Object.defineProperty(globalThis, "localStorage", storage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
function mockFetch(fn: (url: string, options?: RequestInit) => Response | Promise<Response>) {
	globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) =>
		fn(String(url), options)) as typeof fetch;
}

describe("bounded editor document transport", () => {
	test("coalesces tiny chunks while preserving UTF-8 boundaries", async () => {
		const bytes = new TextEncoder().encode("中文𝄞\n");
		let offset = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (offset === bytes.length) controller.close();
					else controller.enqueue(bytes.slice(offset, ++offset));
				},
			}),
		);
		expect(await (await readEditorBody(response, 1024)).text()).toBe("中文𝄞\n");
	});
	test("rejects and cancels an oversized declared body before collecting it", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "Content-Length": "1025" } },
		);
		await expect(readEditorBody(response, 1024)).rejects.toThrow("byte budget");
		expect(cancelled).toBe(true);
	});
	test("rejects an overflowing stream without Content-Length", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(1025));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
		await expect(readEditorBody(response, 1024)).rejects.toThrow("byte budget");
		expect(cancelled).toBe(true);
	});
	test("does not accept a truncated body as an intact version", async () => {
		await expect(
			readEditorBody(new Response("short", { headers: { "Content-Length": "10" } }), 1024),
		).rejects.toThrow("length mismatch");
		mockFetch(() => new Response("short"));
		await expect(editorDocumentApi.source("n", "d", "version", undefined, 10)).rejects.toThrow(
			"version metadata",
		);
	});
	test("compressed Content-Length is not compared with Fetch decoded bytes", async () => {
		const response = new Response("decoded source", {
			headers: { "Content-Length": "3", "Content-Encoding": "gzip" },
		});
		expect(await (await readEditorBody(response, 1024)).text()).toBe("decoded source");
	});
	test("abort cancels a blocked reader even if the mock transport ignores cancellation", async () => {
		let cancelled = false;
		const controller = new AbortController();
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
		);
		const pending = readEditorBody(response, 1024, controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		expect(cancelled).toBe(true);
	});
	test("create uses the source narrator, encoded identity and explicit reader origin", async () => {
		let sent = "";
		let body = "";
		mockFetch((url, options) => {
			sent = url;
			body = String(options?.body);
			return Response.json({ docId: "d" });
		});
		expect(
			await editorDocumentApi.create("child/id", {
				path: "/work/中文.md",
				deviceId: "local",
				origin: "reference",
			}),
		).toMatchObject({ docId: "d" });
		expect(sent).toEndWith("/api/narrators/child%2Fid/editor-documents");
		expect(JSON.parse(body)).toEqual({
			path: "/work/中文.md",
			deviceId: "local",
			origin: "reference",
		});
	});
	test("source requests an immutable version and returns plain text instead of JSON", async () => {
		let sent = "";
		mockFetch((url) => {
			sent = url;
			return new Response("a\nb\n");
		});
		expect(await editorDocumentApi.source("n", "d/a", "v?1", undefined, 4)).toBe("a\nb\n");
		expect(sent).toContain("/editor-documents/d%2Fa/content?version=v%3F1");
	});
	test("conflict preview is explicitly partial and cancels the remaining version stream", async () => {
		let cancelled = false;
		mockFetch(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("abcdefghij"));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Length": "10000000" } },
				),
		);
		expect(await editorDocumentApi.sourcePreview("n", "d", "immutable", undefined, 4)).toEqual({
			content: "abcd",
			truncated: true,
		});
		expect(cancelled).toBe(true);
	});
	test("small conflict preview is complete, while full download preserves all normalized bytes", async () => {
		mockFetch(() => new Response("中文\n"));
		expect(await editorDocumentApi.sourcePreview("n", "d", "v")).toEqual({
			content: "中文\n",
			truncated: false,
		});
		expect(await (await editorDocumentApi.sourceBlob("n", "d", "v")).text()).toBe("中文\n");
	});
	test("upload sends the Blob directly, not JSON escaped text", async () => {
		const blob = new Blob(['{"quoted":"\\n"}']);
		let sent: RequestInit | undefined;
		mockFetch((_url, options) => {
			sent = options;
			return Response.json({ uploadId: "u", state: "sealed" });
		});
		expect(await editorDocumentApi.upload("n", "d", "u", blob)).toEqual({
			uploadId: "u",
			state: "sealed",
		});
		expect(sent?.body).toBe(blob);
		expect(new Headers(sent?.headers).get("Content-Type")).toBe("application/octet-stream");
	});
	test("metadata oversize is rejected before sending a request", async () => {
		let requests = 0;
		mockFetch(() => {
			requests++;
			return Response.json({});
		});
		await expect(
			editorDocumentApi.create("n", {
				origin: "legacy",
				path: "x".repeat(EDITOR_METADATA_MAX_BYTES + 1),
			}),
		).rejects.toThrow("byte budget");
		expect(requests).toBe(0);
	});
	test("session expiry and confirmation tokens survive as structured errors", async () => {
		mockFetch(() =>
			Response.json({ code: "EDITOR_SESSION_EXPIRED", error: "expired" }, { status: 410 }),
		);
		await expect(editorDocumentApi.getUpload("n", "d", "u")).rejects.toMatchObject({
			status: 410,
			data: { code: "EDITOR_SESSION_EXPIRED" },
		});
		mockFetch(() =>
			Response.json(
				{ code: "NEEDS_CONFIRMATION", confirmationToken: "token", physicalPath: "/outside" },
				{ status: 409 },
			),
		);
		await expect(editorDocumentApi.commit("n", "d", "u")).rejects.toMatchObject({
			status: 409,
			data: { confirmationToken: "token" },
		});
	});
	test("error bodies are bounded too", async () => {
		mockFetch(() =>
			Response.json({ error: "x".repeat(EDITOR_METADATA_MAX_BYTES) }, { status: 500 }),
		);
		await expect(
			editorDocumentApi.create("n", { path: "/work/a", origin: "legacy" }),
		).rejects.toThrow("byte budget");
	});
	test("pending commit is observable and is never automatically posted twice", async () => {
		const requests: string[] = [];
		mockFetch((url, options) => {
			requests.push(`${options?.method} ${url}`);
			return Response.json({ status: "committing", operationId: "op" });
		});
		expect(await editorDocumentApi.commit("n", "d", "u")).toEqual({
			status: "committing",
			operationId: "op",
		});
		expect(requests).toHaveLength(1);
		await editorDocumentApi.operation("n", "op");
		expect(requests[1]).toEndWith("GET /api/narrators/n/editor-operations/op");
	});
	test("editor transfer limits do not silently become unbounded", () => {
		expect(EDITOR_TRANSFER_MAX_BYTES).toBe(64 * 1024 * 1024);
	});
});
