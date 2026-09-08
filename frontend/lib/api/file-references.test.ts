import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_SEARCH_BYTES,
	MAX_FILE_REFERENCE_SOURCE_BYTES,
} from "@shared/file-reference";
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
