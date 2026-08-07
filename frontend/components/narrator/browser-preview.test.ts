import { describe, expect, it } from "bun:test";
import {
	getBrowserPreviewNavigationUrl,
	translateBrowserPreviewCoordinate,
} from "./browser-preview";

const viewport = { width: 1280, height: 900 };

describe("getBrowserPreviewNavigationUrl", () => {
	it("allows HTTP pages to navigate in the current tab", () => {
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
