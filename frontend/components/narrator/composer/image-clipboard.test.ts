import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "../../../lib/api";
import {
	copyGeneratedImageToClipboard,
	ImageClipboardUnavailableError,
	isImageClipboardUnavailableError,
} from "./image-clipboard";

describe("copyGeneratedImageToClipboard", () => {
	const g = globalThis as typeof globalThis & {
		ClipboardItem?: unknown;
		navigator?: unknown;
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const descriptors = new Map(
		["fetch", "navigator", "ClipboardItem", "localStorage", "window"].map((key) => [
			key,
			Object.getOwnPropertyDescriptor(g, key),
		]),
	);

	afterEach(() => {
		mock.restore();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(g, key, descriptor);
			else Reflect.deleteProperty(g, key);
		}
	});

	test("constructs promised PNG and writes synchronously before fetching finishes", async () => {
		let finishFetch: ((response: Response) => void) | undefined;
		const pendingFetch = new Promise<Response>((resolve) => {
			finishFetch = resolve;
		});
		const items: Record<string, Blob | Promise<Blob>>[] = [];
		const write = mock(async () => {});
		Object.defineProperty(g, "window", { value: { isSecureContext: true }, configurable: true });
		Object.defineProperty(g, "navigator", { value: { clipboard: { write } }, configurable: true });
		Object.defineProperty(g, "ClipboardItem", {
			configurable: true,
			value: class {
				constructor(data: Record<string, Blob | Promise<Blob>>) {
					items.push(data);
				}
			},
		});
		Object.defineProperty(g, "fetch", { value: mock(() => pendingFetch), configurable: true });
		const copying = copyGeneratedImageToClipboard({ imageSrc: "blob:shown-image" });
		expect(items).toHaveLength(1);
		expect(Object.keys(items[0])).toEqual(["image/png"]);
		expect(items[0]["image/png"]).toBeInstanceOf(Promise);
		expect(write).toHaveBeenCalledTimes(1);
		const blob = new Blob(["png"], { type: "image/png" });
		finishFetch?.(new Response(blob));
		await copying;
		const result = await items[0]["image/png"];
		expect(result.type).toBe("image/png");
		expect(await result.text()).toBe("png");
	});

	test("only the capability guard creates a marked error before any fetch", async () => {
		const fetch = mock(async () => new Response());
		Object.defineProperty(g, "fetch", { value: fetch, configurable: true });
		Object.defineProperty(g, "window", { value: { isSecureContext: false }, configurable: true });
		let error: unknown;
		try {
			await copyGeneratedImageToClipboard({ imageSrc: "blob:image" });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ImageClipboardUnavailableError);
		expect(isImageClipboardUnavailableError(error)).toBe(true);
		// Identity marking does not rely on a realm-specific Error prototype.
		Object.setPrototypeOf(error as object, null);
		expect(isImageClipboardUnavailableError(error)).toBe(true);
		expect(isImageClipboardUnavailableError(new Error("Image clipboard is not supported"))).toBe(
			false,
		);
		expect(isImageClipboardUnavailableError(new DOMException("Denied", "NotAllowedError"))).toBe(
			false,
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("preserves the actual clipboard rejection, not a capability error", async () => {
		const denied = new DOMException("Denied", "NotAllowedError");
		Object.defineProperty(g, "window", { value: { isSecureContext: true }, configurable: true });
		Object.defineProperty(g, "navigator", {
			value: {
				clipboard: {
					write: async () => {
						throw denied;
					},
				},
			},
			configurable: true,
		});
		Object.defineProperty(g, "ClipboardItem", { value: class {}, configurable: true });
		Object.defineProperty(g, "fetch", {
			value: async () => new Response(new Blob(["png"], { type: "image/png" })),
			configurable: true,
		});
		await expect(copyGeneratedImageToClipboard({ imageSrc: "blob:image" })).rejects.toBe(denied);
		expect(isImageClipboardUnavailableError(denied)).toBe(false);
	});

	test("surfaces structured fs preview errors", async () => {
		Object.defineProperty(g, "navigator", {
			value: {
				clipboard: {
					write: async () => {},
				},
			},
			configurable: true,
		});
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "ClipboardItem", {
			value: class ClipboardItem {},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
						code: "FS_PREVIEW_TOO_LARGE",
						reason: "File too large to preview",
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
			await copyGeneratedImageToClipboard({ savedPath: "/tmp/large.png" });
			throw new Error("expected clipboard image fetch to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(413);
			expect((err as Error).message).toBe("File too large to preview");
			expect((err as ApiError).data?.code).toBe("FS_PREVIEW_TOO_LARGE");
		}
	});
});
