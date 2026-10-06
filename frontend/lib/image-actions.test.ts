import { afterEach, describe, expect, test } from "bun:test";
import { downloadImageSource } from "./image-actions";

describe("downloadImageSource", () => {
	const g = globalThis as typeof globalThis & {
		document?: Document;
		fetch: typeof fetch;
	};
	const originalDocument = g.document;
	const originalFetch = g.fetch;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalDocument === undefined) {
			Reflect.deleteProperty(g, "document");
		} else {
			Object.defineProperty(g, "document", { value: originalDocument, configurable: true });
		}
	});

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
