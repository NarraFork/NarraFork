import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub before importing pretext-backed code.
beforeAll(() => {
	installCanvasStub();
});

describe("resolveWebSearchQuery / isWebSearchSearching", () => {
	it("prefers block.query, falls back to joined queries", async () => {
		const { resolveWebSearchQuery } = await import("./measure-web-search");
		expect(resolveWebSearchQuery({ query: "hello" })).toBe("hello");
		expect(resolveWebSearchQuery({ queries: ["a", "b"] })).toBe("a, b");
		expect(resolveWebSearchQuery({ queries: [] })).toBeNull();
		expect(resolveWebSearchQuery({})).toBeNull();
	});

	it("treats non-completed status as searching", async () => {
		const { isWebSearchSearching } = await import("./measure-web-search");
		expect(isWebSearchSearching({ status: "searching" })).toBe(true);
		expect(isWebSearchSearching({ status: "completed" })).toBe(false);
		expect(isWebSearchSearching({})).toBe(false);
	});
});

describe("measureWebSearch", () => {
	it("renders a short completed search as a single fixed-height row", async () => {
		const { measureWebSearch, MEASURE_WEB_SEARCH_CONSTANTS } = await import("./measure-web-search");
		const r = measureWebSearch({ query: "cats", status: "completed", label: "Searched" }, 600);
		const c = MEASURE_WEB_SEARCH_CONSTANTS;
		// Single line → row height is the icon lane (18) since text line (17) is shorter.
		expect(r.height).toBe(c.WEB_SEARCH_VERTICAL_CHROME + c.WEB_SEARCH_ICON_SIZE);
	});

	it("wraps a long query into more lines as width shrinks", async () => {
		const { measureWebSearch } = await import("./measure-web-search");
		const longQuery =
			"a very long search query that keeps going and going well beyond a single visual line";
		const wide = measureWebSearch({ query: longQuery, status: "completed" }, 2000);
		const narrow = measureWebSearch({ query: longQuery, status: "completed" }, 120);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("height grows in multiples of the xs text line height when wrapped", async () => {
		const { measureWebSearch, MEASURE_WEB_SEARCH_CONSTANTS } = await import("./measure-web-search");
		const c = MEASURE_WEB_SEARCH_CONSTANTS;
		const longQuery = "word ".repeat(40).trim();
		const narrow = measureWebSearch({ query: longQuery, status: "completed" }, 150);
		const textHeight = narrow.height - c.WEB_SEARCH_VERTICAL_CHROME;
		// Wrapped text dominates the icon lane → multiple of the line height.
		expect(textHeight % c.WEB_SEARCH_TEXT_LINE_HEIGHT).toBe(0);
		expect(textHeight).toBeGreaterThan(c.WEB_SEARCH_TEXT_LINE_HEIGHT);
	});

	it("reserves an extra loader lane while searching (narrower text area)", async () => {
		const { measureWebSearch, webSearchChromeLeft, MEASURE_WEB_SEARCH_CONSTANTS } = await import(
			"./measure-web-search"
		);
		const c = MEASURE_WEB_SEARCH_CONSTANTS;
		// Searching lane is wider (icon + gap + loader + gap) than completed (icon + gap).
		expect(webSearchChromeLeft(true)).toBe(
			c.WEB_SEARCH_ICON_SIZE +
				c.WEB_SEARCH_GROUP_GAP +
				c.WEB_SEARCH_LOADER_SIZE +
				c.WEB_SEARCH_GROUP_GAP,
		);
		expect(webSearchChromeLeft(false)).toBe(c.WEB_SEARCH_ICON_SIZE + c.WEB_SEARCH_GROUP_GAP);
	});

	it("is a full-width block (not shrink-wrapped)", async () => {
		const { measureWebSearch } = await import("./measure-web-search");
		const r = measureWebSearch({ query: "cats", status: "completed" }, 600);
		expect(r.usedWidth).toBe(600);
	});

	it("prepareWebSearchMeasurer parses once and re-measures at widths", async () => {
		const { prepareWebSearchMeasurer } = await import("./measure-web-search");
		const measure = prepareWebSearchMeasurer({
			query: "a fairly long recurring search phrase repeated for wrapping",
			status: "completed",
		});
		const wide = measure(2000);
		const narrow = measure(140);
		expect(narrow.height).toBeGreaterThanOrEqual(wide.height);
	});
});
