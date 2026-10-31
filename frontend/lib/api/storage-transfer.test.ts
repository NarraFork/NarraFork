import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, setToken } from "./client";
import { saveExport, type TransferSelection } from "./storage-transfer";

const g = globalThis as typeof globalThis & { localStorage?: Storage };
const originalLocalStorage = g.localStorage;

afterEach(() => {
	if (originalLocalStorage === undefined) {
		Reflect.deleteProperty(g, "localStorage");
	} else {
		Object.defineProperty(g, "localStorage", {
			value: originalLocalStorage,
			configurable: true,
		});
	}
});

function installMapLocalStorage(): void {
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
}

const selection: TransferSelection = { requests: true, sessions: false, providers: true };

function zipStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("saveExport", () => {
	beforeEach(() => {
		installMapLocalStorage();
	});

	test("先弹出保存位置，再把响应体写入文件，不经过 Blob", async () => {
		setToken("nfs_export");
		const order: string[] = [];
		const chunks: Uint8Array[] = [];
		let aborted = false;
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				chunks.push(chunk);
			},
			abort() {
				aborted = true;
			},
		});
		let exportUrl = "";
		let authorization = "";
		const result = await saveExport(selection, {
			showSaveFilePicker: async () => {
				order.push("picker");
				return {
					createWritable: async () => {
						order.push("writable");
						return writable;
					},
				};
			},
			fetch: async (input, init) => {
				order.push("fetch");
				exportUrl = String(input);
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return new Response(zipStream("zip-bytes"));
			},
			openDownload: () => {
				throw new Error("picker path must not fall back to a ticket");
			},
		});

		expect(result).toBe("saved");
		expect(order).toEqual(["picker", "writable", "fetch"]);
		expect(exportUrl).toBe("/api/storage/export?requests=1&sessions=0&providers=1");
		expect(authorization).toBe("Bearer nfs_export");
		expect(new TextDecoder().decode(chunks[0])).toBe("zip-bytes");
		expect(aborted).toBe(false);
	});

	test("用户取消保存对话框时不发请求", async () => {
		let fetched = false;
		const result = await saveExport(selection, {
			showSaveFilePicker: async () => {
				throw new DOMException("The user aborted a request.", "AbortError");
			},
			fetch: async () => {
				fetched = true;
				return new Response(null);
			},
		});
		expect(result).toBe("cancelled");
		expect(fetched).toBe(false);
	});

	test("导出失败时丢掉尚未提交的文件，并带上错误码", async () => {
		let aborted = false;
		const writable = new WritableStream<Uint8Array>({
			abort() {
				aborted = true;
			},
		});
		const error = await saveExport(selection, {
			showSaveFilePicker: async () => ({
				createWritable: async () => writable,
			}),
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: "The export request is invalid",
						code: "VALIDATION_ERROR",
						messageCode: "EXPORT_PARAMS_INVALID",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
		}).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(aborted).toBe(true);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).data?.messageCode).toBe("EXPORT_PARAMS_INVALID");
	});

	test("没有文件选择 API 时改走一次性下载地址", async () => {
		setToken("nfs_export");
		let opened = "";
		const result = await saveExport(selection, {
			showSaveFilePicker: null,
			fetch: async (input, init) => {
				expect(String(input)).toBe("/api/storage/export/ticket");
				expect(init?.method).toBe("POST");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer nfs_export");
				expect(init?.body).toBe(JSON.stringify(selection));
				return new Response(JSON.stringify({ ticket: "ticket/with space" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			openDownload: (url) => {
				opened = url;
			},
		});
		expect(result).toBe("saved");
		expect(opened).toBe("/api/storage/export/download?ticket=ticket%2Fwith%20space");
	});

	test("保存 API 在非安全上下文被拒绝时改走票据", async () => {
		let opened = "";
		const result = await saveExport(selection, {
			showSaveFilePicker: async () => {
				throw new DOMException("secure context required", "SecurityError");
			},
			fetch: async () =>
				new Response(JSON.stringify({ ticket: "abc" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			openDownload: (url) => {
				opened = url;
			},
		});
		expect(result).toBe("saved");
		expect(opened).toBe("/api/storage/export/download?ticket=abc");
	});
});
