import { describe, expect, it } from "bun:test";
import {
	getBrowserPreviewExpandedWidth,
	getBrowserPreviewNavigationUrl,
	openBrowserPreviewNavigation,
	translateBrowserPreviewCoordinate,
} from "./browser-preview";

const viewport = { width: 1280, height: 900 };

describe("getBrowserPreviewNavigationUrl", () => {
	it("allows HTTP pages to be rendered as navigation links", () => {
		expect(getBrowserPreviewNavigationUrl("https://example.com/docs?q=1")).toBe(
			"https://example.com/docs?q=1",
		);
		expect(getBrowserPreviewNavigationUrl("http://localhost:3000/path")).toBe(
			"http://localhost:3000/path",
		);
	});

	it("keeps non-web browser session URLs as non-clickable text", () => {
		expect(getBrowserPreviewNavigationUrl("javascript:alert(1)")).toBeNull();
		expect(getBrowserPreviewNavigationUrl("data:text/html,hello")).toBeNull();
		expect(getBrowserPreviewNavigationUrl("not a url")).toBeNull();
	});
});

describe("openBrowserPreviewNavigation", () => {
	it("forces web URLs into a new isolated browsing context", () => {
		const calls: Array<[string, string, string]> = [];
		const opened = openBrowserPreviewNavigation(
			"https://example.com/docs",
			(url, target, features) => calls.push([url, target, features]),
		);

		expect(opened).toBe(true);
		expect(calls).toEqual([["https://example.com/docs", "_blank", "noopener,noreferrer"]]);
	});

	it("does not invoke the opener for unsafe URLs", () => {
		let called = false;
		expect(
			openBrowserPreviewNavigation("javascript:alert(1)", () => {
				called = true;
			}),
		).toBe(false);
		expect(called).toBe(false);
	});
});

describe("getBrowserPreviewExpandedWidth", () => {
	it("caps the enlarged preview at the screenshot viewport width", () => {
		expect(getBrowserPreviewExpandedWidth(1280)).toBe("min(100%, 1280px)");
		expect(getBrowserPreviewExpandedWidth(1920.4)).toBe("min(100%, 1920px)");
	});

	it("falls back safely for invalid viewport widths", () => {
		expect(getBrowserPreviewExpandedWidth(0)).toBe("100%");
		expect(getBrowserPreviewExpandedWidth(Number.NaN)).toBe("100%");
	});
});

describe("translateBrowserPreviewCoordinate", () => {
	it("maps an inline scaled preview back to the remote browser viewport", () => {
		expect(
			translateBrowserPreviewCoordinate(
				{ left: 100, top: 50, width: 640, height: 450 },
				viewport,
				420,
				275,
			),
		).toEqual({ x: 640, y: 450 });
	});

	it("maps a larger fullscreen preview with the same coordinates", () => {
		expect(
			translateBrowserPreviewCoordinate(
				{ left: 0, top: 0, width: 1920, height: 1350 },
				viewport,
				960,
				675,
			),
		).toEqual({ x: 640, y: 450 });
	});

	it("clamps edge coordinates and rejects invalid dimensions", () => {
		expect(
			translateBrowserPreviewCoordinate(
				{ left: 10, top: 20, width: 320, height: 225 },
				viewport,
				400,
				-20,
			),
		).toEqual({ x: 1279, y: 0 });
		expect(
			translateBrowserPreviewCoordinate({ left: 0, top: 0, width: 0, height: 100 }, viewport, 0, 0),
		).toBeNull();
	});
});
