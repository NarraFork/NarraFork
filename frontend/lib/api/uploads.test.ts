import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import {
	ApiError,
	getToken,
	postBodyWithProgress,
	postFormDataWithProgress,
	setToken,
} from "./client";
import { api, getUploadedImageUrl } from "./index";

describe("attachment staging and upload transport", () => {
	const originalFetch = globalThis.fetch;
	const originalXHR = globalThis.XMLHttpRequest;
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const xhrRequests: UploadXHR[] = [];
	const fetchRequests: Array<{ url: string; init: RequestInit }> = [];
	let respondXHR: (xhr: UploadXHR) => void;
	let respondFetch: (url: string, init: RequestInit) => Promise<Response>;

	class UploadXHR {
		url = "";
		body?: Blob | FormData;
		headers = new Headers();
		status = 200;
		statusText = "OK";
		responseText = "";
		upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
		onload = () => {};
		onerror = () => {};
		ontimeout = () => {};
		onabort = () => {};

		open(method: string, url: string) {
			expect(method).toBe("POST");
			this.url = url;
		}
		setRequestHeader(key: string, value: string) {
			this.headers.set(key, value);
		}
		getAllResponseHeaders() {
			return "content-type: application/json\r\nx-upload-test: yes";
		}
		send(body: Blob | FormData) {
			this.body = body;
			xhrRequests.push(this);
			respondXHR(this);
		}
		abort() {
			this.onabort();
		}
		reply(body: unknown, status = 200) {
			this.status = status;
			this.responseText = JSON.stringify(body);
			this.onload();
		}
	}

	beforeEach(() => {
		xhrRequests.length = 0;
		fetchRequests.length = 0;
		respondXHR = (xhr) => xhr.reply({ uploadId: `upload-${xhrRequests.length}` });
		respondFetch = async () => Response.json({ ok: true });
		Object.defineProperty(globalThis, "localStorage", {
			value: { getItem: () => null },
			configurable: true,
		});
		Object.defineProperty(globalThis, "XMLHttpRequest", { value: UploadXHR, configurable: true });
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: (url: unknown, init: RequestInit) => {
				fetchRequests.push({ url: String(url), init });
				return respondFetch(String(url), init);
			},
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "fetch", { value: originalFetch, configurable: true });
		if (originalXHR) {
			Object.defineProperty(globalThis, "XMLHttpRequest", {
				value: originalXHR,
				configurable: true,
			});
		} else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
		if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	function largeFile(name: string) {
		const file = new File(["small fixture"], name, { type: "text/plain" });
		// Exercise the size boundary without allocating a large body.
		Object.defineProperty(file, "size", { value: 16 * 1024 * 1024 + 1 });
		return file;
	}

	const paths = ["send", "queue", "edit"] as const;
	function submit(path: (typeof paths)[number], files: File[], signal?: AbortSignal) {
		if (path === "send") {
			return api.sendNarratorMessage("n", "hello", [], files, false, undefined, signal);
		}
		if (path === "queue")
			return api.updateBufferedMessage("n", "m", "hello", { newTextFiles: files });
		return api.editAndRegenerate("n", "m", "hello", { newTextFiles: files });
	}

	test.each(paths)("%s preserves interleaved inline/staged positions", async (path) => {
		const files = [
			new File(["a"], "a.txt"),
			largeFile("大文件.txt"),
			new File(["b"], "b.txt"),
			largeFile("second.txt"),
		];
		await submit(path, files);
		const form =
			path === "send"
				? xhrRequests.at(-1)?.body
				: fetchRequests.find((request) => request.init.method !== "DELETE")?.init.body;
		expect(form).toBeInstanceOf(FormData);
		const body = form as FormData;
		expect(body.getAll("textFiles").map((file) => (file as File).name)).toEqual(["a.txt", "b.txt"]);
		expect(JSON.parse(String(body.get("stagedAttachments")))).toEqual([
			{ uploadId: "upload-1", index: 1 },
			{ uploadId: "upload-2", index: 3 },
		]);
		expect(xhrRequests[0].headers.get("x-attachment-filename")).toBe(
			encodeURIComponent("大文件.txt"),
		);
		expect(xhrRequests[0].headers.get("content-type")).toBe("application/octet-stream");
	});

	test.each(paths)("%s cleans earlier stages when the second large file fails", async (path) => {
		respondXHR = (xhr) => {
			if (xhrRequests.length === 2) xhr.reply({ reason: "stage rejected" }, 413);
			else xhr.reply({ uploadId: "first" });
		};
		await expect(submit(path, [largeFile("one.txt"), largeFile("two.txt")])).rejects.toThrow(
			"stage rejected",
		);
		expect(fetchRequests.map((request) => [request.url, request.init.method])).toEqual([
			["/api/narrator-attachments/n/first", "DELETE"],
		]);
		expect(xhrRequests).toHaveLength(2);
	});

	// The send toast prints err.message, so actionable staging refusals must be
	// mapped to localized messages rather than surfacing the server's English.
	// i18next is not initialized in this environment (t() returns ""), so the
	// message text is asserted via the translation call, and the keys separately
	// against both locale files.
	test.each([
		["ATTACHMENT_TOO_LARGE", "narrator:attachmentTooLargeForUpload"],
		["ATTACHMENT_STAGING_FULL", "narrator:attachmentStagingFull"],
	])("%s is surfaced as the localized %s message", async (code, key) => {
		const translate = spyOn(i18next, "t").mockImplementation(
			((k: string, opts?: { name?: string }) => `${k}|${opts?.name ?? ""}`) as typeof i18next.t,
		);
		try {
			respondXHR = (xhr) => xhr.reply({ error: "server english", code }, 413);
			const error = await submit("send", [largeFile("big.log")]).catch((err: unknown) => err);
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).message).toBe(`${key}|big.log`);
			expect((error as ApiError).status).toBe(413);
			expect((error as ApiError).data?.code).toBe(code);
		} finally {
			translate.mockRestore();
		}
	});

	test("staging error messages exist in both locales with the name placeholder", async () => {
		for (const locale of ["en", "zh-CN"]) {
			const messages = (await Bun.file(
				new URL(`../../locales/${locale}/narrator.json`, import.meta.url),
			).json()) as Record<string, string>;
			for (const key of ["attachmentTooLargeForUpload", "attachmentStagingFull"]) {
				expect(messages[key]).toContain("{{name}}");
			}
		}
	});

	test("an unrecognized staging error keeps the server message", async () => {
		respondXHR = (xhr) => xhr.reply({ error: "disk on fire", code: "SOMETHING_ELSE" }, 500);
		await expect(submit("send", [largeFile("big.log")])).rejects.toThrow("disk on fire");
	});

	test.each(paths)("%s cleans stages after the final request returns an error", async (path) => {
		respondXHR = (xhr) =>
			xhr.body instanceof FormData
				? xhr.reply({ reason: "message rejected" }, 409)
				: xhr.reply({ uploadId: "first" });
		respondFetch = async (_url, init) =>
			init.method === "DELETE"
				? Response.json({ ok: true })
				: Response.json({ reason: "message rejected" }, { status: 409 });
		await expect(submit(path, [largeFile("one.txt")])).rejects.toThrow("message rejected");
		expect(
			fetchRequests
				.filter((request) => request.init.method === "DELETE")
				.map((request) => request.url),
		).toEqual(["/api/narrator-attachments/n/first"]);
	});

	test.each(paths)("%s cleans stages after a final network failure", async (path) => {
		respondXHR = (xhr) =>
			xhr.body instanceof FormData ? xhr.onerror() : xhr.reply({ uploadId: "first" });
		respondFetch = async (_url, init) => {
			if (init.method === "DELETE") return Response.json({ ok: true });
			throw new Error("Network request failed");
		};
		await expect(submit(path, [largeFile("one.txt")])).rejects.toThrow("Network request failed");
		expect(fetchRequests.some((request) => request.init.method === "DELETE")).toBe(true);
	});

	test.each([
		"failure",
		"cancel",
	] as const)("hanging cleanup never delays %s recovery", async (mode) => {
		const controller = new AbortController();
		respondXHR = (xhr) => {
			if (xhrRequests.length === 1) xhr.reply({ uploadId: "first" });
			else if (mode === "cancel") controller.abort();
			else xhr.reply({ reason: "second failed" }, 413);
		};
		respondFetch = () => new Promise(() => {});
		const pending = submit("send", [largeFile("one.txt"), largeFile("two.txt")], controller.signal);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await expect(
				Promise.race([
					pending,
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error("cleanup blocked")), 100);
					}),
				]),
			).rejects.toThrow(mode === "cancel" ? "Upload cancelled" : "second failed");
		} finally {
			clearTimeout(timer);
		}
		const cleanup = fetchRequests[0];
		expect(cleanup.init.method).toBe("DELETE");
		expect(cleanup.init.signal).toBeInstanceOf(AbortSignal);
		expect(cleanup.init.signal).not.toBe(controller.signal);
		expect(cleanup.init.signal?.aborted).toBe(false);
	});

	test.each([
		false,
		true,
	])("shared XHR preserves header/progress/response behavior (multipart=%s)", async (multipart) => {
		const progress: number[] = [];
		respondXHR = (xhr) => {
			xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent);
			xhr.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 } as ProgressEvent);
			xhr.reply({ ok: true });
		};
		const options = {
			headers: { "Content-Type": "text/plain", Authorization: "Bearer test" },
			onProgress: (fraction: number) => progress.push(fraction),
		};
		const response = multipart
			? await postFormDataWithProgress("/upload", new FormData(), options)
			: await postBodyWithProgress("/upload", new Blob(["hello"]), options);
		expect(xhrRequests[0].headers.get("content-type")).toBe(multipart ? null : "text/plain");
		expect(xhrRequests[0].headers.get("authorization")).toBe("Bearer test");
		expect(progress).toEqual([0.5]);
		expect(response.headers.get("x-upload-test")).toBe("yes");
		expect(await response.json()).toEqual({ ok: true });
	});

	test.each([
		false,
		true,
	])("shared XHR handles cancellation before and during upload (multipart=%s)", async (multipart) => {
		const upload = (signal: AbortSignal) =>
			multipart
				? postFormDataWithProgress("/upload", new FormData(), { signal })
				: postBodyWithProgress("/upload", new Blob(["hello"]), { signal });
		const before = new AbortController();
		before.abort();
		await expect(upload(before.signal)).rejects.toMatchObject({ data: { code: "UPLOAD_ABORTED" } });
		expect(xhrRequests).toHaveLength(0);
		const during = new AbortController();
		respondXHR = () => during.abort();
		await expect(upload(during.signal)).rejects.toMatchObject({ data: { code: "UPLOAD_ABORTED" } });
	});
});

describe("upload APIs", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	test("surfaces structured avatar upload unauthorized errors", async () => {
		const store = new Map<string, string>();
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => {
					store.set(key, value);
				},
				removeItem: (key: string) => {
					store.delete(key);
				},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						code: "UNAUTHORIZED",
						reason: "Authentication required",
					}),
					{
						status: 401,
						statusText: "Unauthorized",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		setToken("avatar-token");

		try {
			await api.uploadAvatar(new File(["avatar"], "avatar.png", { type: "image/png" }));
			throw new Error("expected avatar upload to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(401);
			expect((err as Error).message).toBe("Authentication required");
			expect((err as ApiError).data?.code).toBe("UNAUTHORIZED");
		}
		expect(getToken()).toBeNull();
	});

	test("surfaces structured notification sound upload errors", async () => {
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						code: "UPLOAD_FAILED",
						reason: "Notification sound exceeds the allowed size",
					}),
					{
						status: 413,
						statusText: "Payload Too Large",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		try {
			await api.uploadNotificationSound(new File(["sound"], "ding.mp3", { type: "audio/mpeg" }));
			throw new Error("expected notification sound upload to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(413);
			expect((err as Error).message).toBe("Notification sound exceeds the allowed size");
			expect((err as ApiError).data?.code).toBe("UPLOAD_FAILED");
		}
	});

	test("uploaded image URLs carry a reference context only for another owner's image", () => {
		expect(getUploadedImageUrl("owner", "img")).toBe("/api/uploads/owner/img");
		expect(getUploadedImageUrl("owner", "img", "owner")).toBe("/api/uploads/owner/img");
		expect(getUploadedImageUrl("source", "img", "fork")).toBe(
			"/api/uploads/source/img?referencingNarratorId=fork",
		);
		expect(getUploadedImageUrl("a/b", "c?d", "e&f")).toBe(
			"/api/uploads/a%2Fb/c%3Fd?referencingNarratorId=e%26f",
		);
	});
});
