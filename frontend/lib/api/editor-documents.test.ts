import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EDITOR_METADATA_MAX_BYTES, EDITOR_TRANSFER_MAX_BYTES } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import { editorDocumentApi, readEditorBody } from "./editor-documents";

const rawDocument = (text = "abcdef") => {
	const codec = new EditorStreamCodec("utf-8");
	codec.push(new TextEncoder().encode(text), true);
	return {
		...codec.finish(),
		docId: "doc",
		versionHandle: "version",
		target: { deviceId: "local", path: "/a.txt" },
	};
};

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

test.each([
	"raw",
	"v1",
	"older",
] as const)("explicit protocol negotiation interoperates with %s server without reinterpreting hashes", async (mode) => {
	const requests: { url: string; body?: unknown }[] = [];
	mockFetch((url, options) => {
		requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
		if (new URL(url, "http://fixture").pathname.endsWith("/capabilities"))
			return mode === "older"
				? new Response(null, { status: 404 })
				: Response.json(
						mode === "raw"
							? { protocols: ["text-v1", "raw-v2"], readMode: "raw-v2" }
							: { protocols: ["text-v1"] },
					);
		return Response.json(
			mode === "raw" ? rawDocument() : { docId: "v1", baseHash: "decoded-only" },
		);
	});
	const selected = await editorDocumentApi.readMode("n", { path: "/a", origin: "legacy" });
	const result = await editorDocumentApi.create("n", {
		path: "/a",
		origin: "legacy",
		...(selected === "raw-v2" ? { protocol: "raw-v2" as const } : {}),
	});
	expect(requests).toHaveLength(2);
	expect(requests[1].body).toEqual(
		mode === "raw"
			? { path: "/a", origin: "legacy", protocol: "raw-v2" }
			: { path: "/a", origin: "legacy" },
	);
	expect(result.protocol === "raw-v2").toBe(mode === "raw");
});

test.each([
	403, 422, 500,
])("negotiated raw provider failure %s is never downgraded to a v1 writer", async (status) => {
	let posts = 0;
	mockFetch((url) => {
		if (new URL(url, "http://fixture").pathname.endsWith("/capabilities"))
			return Response.json({ protocols: ["raw-v2", "text-v1"], readMode: "raw-v2" });
		posts++;
		return Response.json(
			{ error: "Capability unavailable", code: "EDITOR_PROVIDER_UNSUPPORTED" },
			{ status },
		);
	});
	await expect(
		editorDocumentApi.create("n", { path: "/a", origin: "legacy", protocol: "raw-v2" }),
	).rejects.toThrow("Capability unavailable");
	expect(posts).toBe(1);
});

test("remote read negotiation uses the actual file scope and never offers a v1 writer", async () => {
	let observed = "";
	mockFetch((url) => {
		observed = url;
		return Response.json({ protocols: ["text-v1", "raw-v2"], readMode: "bounded-preview" });
	});
	expect(
		await editorDocumentApi.readMode("file-narrator", {
			path: "/remote/file",
			deviceId: "device",
			origin: "reference",
		}),
	).toBe("bounded-preview");
	const url = new URL(observed, "http://fixture");
	expect(url.pathname).toBe("/api/narrators/file-narrator/editor-documents/capabilities");
	expect(Object.fromEntries(url.searchParams)).toEqual({
		path: "/remote/file",
		deviceId: "device",
		origin: "reference",
	});
	mockFetch(() => Response.json({ error: "Read denied" }, { status: 403 }));
	await expect(
		editorDocumentApi.readMode("file-narrator", {
			path: "/remote/file",
			deviceId: "device",
			origin: "reference",
		}),
	).rejects.toThrow("Read denied");
});

test("an explicit raw create rejects and releases an old Host's text descriptor before any body read", async () => {
	const calls: string[] = [];
	mockFetch((url, options) => {
		calls.push(`${options?.method} ${url}`);
		return options?.method === "DELETE"
			? new Response(null, { status: 204 })
			: Response.json({
					docId: "legacy",
					baseHash: "decoded",
					target: { deviceId: "local", path: "/a" },
				});
	});
	await expect(
		editorDocumentApi.create("n", { path: "/a", origin: "legacy", protocol: "raw-v2" }),
	).rejects.toThrow("Raw editor protocol unavailable");
	expect(calls).toEqual([
		"POST /api/narrators/n/editor-documents",
		"DELETE /api/narrators/n/editor-documents/legacy",
	]);
});

describe("bounded editor document transport", () => {
	test("raw pull credit waits for real consumer completion and never materializes a body Blob", async () => {
		let pulls = 0,
			closed = 0,
			entered!: () => void,
			resume!: () => void;
		const first = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			resume = resolve;
		});
		mockFetch((_url, options) => {
			if (options?.method === "DELETE") {
				closed++;
				return new Response(null, { status: 204 });
			}
			const input = JSON.parse(String(options?.body));
			if (input.versionHandle) return Response.json({ readId: "read" });
			pulls++;
			expect(input.maxBytes).toBe(3);
			return new Response(input.offset ? "def" : "abc", {
				headers: { "x-editor-eof": input.offset ? "1" : "0" },
			});
		});
		let text = "";
		const loading = editorDocumentApi.rawSource(
			"n",
			rawDocument(),
			async (bytes) => {
				text += new TextDecoder().decode(bytes);
				if (pulls === 1) {
					entered();
					await paused;
				}
			},
			new AbortController().signal,
			() => 3,
		);
		await first;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(pulls).toBe(1);
		resume();
		await loading;
		expect(pulls).toBe(2);
		expect(text).toBe("abcdef");
		expect(closed).toBe(1);
	});
	test("raw cancellation closes a blocked body reader and releases its read context", async () => {
		let closed = 0,
			cancelled = false,
			entered!: () => void;
		const reading = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mockFetch((_url, options) => {
			if (options?.method === "DELETE") {
				closed++;
				return new Response(null, { status: 204 });
			}
			if (JSON.parse(String(options?.body)).versionHandle) return Response.json({ readId: "read" });
			entered();
			return new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "x-editor-eof": "0" } },
			);
		});
		const controller = new AbortController();
		const loading = editorDocumentApi.rawSource(
			"n",
			rawDocument(),
			async () => {},
			controller.signal,
		);
		await reading;
		controller.abort(new Error("raw abort"));
		await expect(loading).rejects.toThrow("raw abort");
		expect(cancelled).toBe(true);
		expect(closed).toBe(1);
	});
	for (const failure of ["credit", "eof", "length"] as const)
		test(`raw transport rejects ${failure} and closes its context`, async () => {
			let closed = 0;
			mockFetch((_url, options) => {
				if (options?.method === "DELETE") {
					closed++;
					return new Response(null, { status: 204 });
				}
				if (JSON.parse(String(options?.body)).versionHandle)
					return Response.json({ readId: "read" });
				return new Response(failure === "credit" ? "1234567" : "abc", {
					headers: failure === "eof" ? {} : { "x-editor-eof": "1" },
				});
			});
			await expect(
				editorDocumentApi.rawSource(
					"n",
					rawDocument(),
					async () => {},
					new AbortController().signal,
					() => 6,
				),
			).rejects.toThrow();
			expect(closed).toBe(1);
		});
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
	test("recovery discovery requests only an authorized owner scope without a current file path or body", async () => {
		let sent = "";
		let request: RequestInit | undefined;
		mockFetch((url, options) => {
			sent = url;
			request = options;
			return Response.json({ recoveryKey: "owner-proof" });
		});
		expect(
			await editorDocumentApi.recoveryScope("child/id", { deviceId: "local", origin: "reference" }),
		).toEqual({ recoveryKey: "owner-proof" });
		expect(sent).toContain("/api/narrators/child%2Fid/editor-documents/recovery-scope?");
		const query = new URL(sent, "http://localhost").searchParams;
		expect([...query.keys()].sort()).toEqual(["deviceId", "origin"]);
		expect(query.get("deviceId")).toBe("local");
		expect(query.get("origin")).toBe("reference");
		expect(request?.body).toBeUndefined();
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
