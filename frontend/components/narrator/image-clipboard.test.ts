import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "../../lib/api";
import { copyGeneratedImageToClipboard } from "./image-clipboard";

describe("copyGeneratedImageToClipboard", () => {
	const g = globalThis as typeof globalThis & {
		ClipboardItem?: unknown;
		navigator?: unknown;
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalNavigator = g.navigator;
	const originalClipboardItem = g.ClipboardItem;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalNavigator === undefined) {
			Reflect.deleteProperty(g, "navigator");
		} else {
			Object.defineProperty(g, "navigator", { value: originalNavigator, configurable: true });
		}
		if (originalClipboardItem === undefined) {
			Reflect.deleteProperty(g, "ClipboardItem");
		} else {
			Object.defineProperty(g, "ClipboardItem", {
				value: originalClipboardItem,
				configurable: true,
			});
		}
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
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
