import { afterEach, describe, expect, mock, test } from "bun:test";
import { downloadImageSource } from "./image-actions";

describe("downloadImageSource", () => {
	const g = globalThis as typeof globalThis & {
		document?: Document;
		fetch: typeof fetch;
	};
	const descriptors = new Map(
		["document", "fetch", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(g, key)]),
	);

	afterEach(() => {
		mock.restore();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(g, key, descriptor);
			else Reflect.deleteProperty(g, key);
		}
	});

	function installBrowser() {
		const denied = new TypeError("CORS denied");
		const click = mock(() => {});
		const anchor = { href: "", download: "", click, remove() {} };
		const createElement = mock(() => anchor);
		Object.defineProperty(g, "window", {
			value: { location: { origin: "https://app.example" } },
			configurable: true,
		});
		Object.defineProperty(g, "document", {
			value: { createElement, body: { appendChild: () => anchor } },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: mock(async () => {
				throw denied;
			}),
			configurable: true,
		});
		return { denied, click, anchor, createElement };
	}

	test("strict fallback propagates CORS failure without creating or clicking a link", async () => {
		const { denied, click, createElement } = installBrowser();
		await expect(
			downloadImageSource({
				imageSrc: "https://images.example/photo.png",
				filename: "photo.png",
				allowUnverifiedDirectFallback: false,
			}),
		).rejects.toBe(denied);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(createElement).not.toHaveBeenCalled();
		expect(click).not.toHaveBeenCalled();
	});

	test("explicit download retains its existing cross-origin direct fallback by default", async () => {
		const { click, anchor } = installBrowser();
		await downloadImageSource({
			imageSrc: "https://images.example/photo.png",
			filename: "photo.png",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
		expect(anchor.href).toBe("https://images.example/photo.png");
		expect(anchor.download).toBe("photo.png");
	});

	for (const src of [
		"blob:shown-image",
		"data:image/png;base64,AA==",
		"https://app.example/photo.png",
	]) {
		test(`strict download preserves direct ${src} without fetch`, async () => {
			const { click, anchor } = installBrowser();
			const downloading = downloadImageSource({
				imageSrc: src,
				filename: "photo.png",
				allowUnverifiedDirectFallback: false,
			});
			expect(click).toHaveBeenCalledTimes(1);
			expect(anchor.href).toBe(src);
			expect(fetch).not.toHaveBeenCalled();
			await downloading;
		});
	}

	test("starts blob downloads synchronously without refetching", async () => {
		let clicked = false;
		let downloadedFilename = "";
		let fetchCalled = false;
		const anchor = {
			href: "",
			download: "",
			click() {
				clicked = true;
				downloadedFilename = this.download;
			},
			remove() {},
		};
		Object.defineProperty(g, "document", {
			value: {
				createElement: () => anchor,
				body: { appendChild: () => anchor },
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () => {
				fetchCalled = true;
				return new Response(null, { status: 500 });
			},
			configurable: true,
		});

		const downloadPromise = downloadImageSource({
			imageSrc: "blob:shown-image",
			filename: "scan.png",
		});
		expect(clicked).toBe(true);
		expect(downloadedFilename).toBe("scan.png");
		expect(fetchCalled).toBe(false);
		await downloadPromise;
	});
});
