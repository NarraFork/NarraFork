import { describe, expect, test } from "bun:test";
import {
	applyBackground,
	checkBackgroundUrl,
	DEFAULT_BACKGROUND,
	MIN_OPACITY,
	parseBackgroundChoice,
	switchBackgroundSource,
} from "./app-background";

function stubRoot() {
	const props = new Map<string, string>();
	const attrs = new Map<string, string>();
	return {
		style: {
			setProperty: (name: string, value: string) => props.set(name, value),
			removeProperty: (name: string) => props.delete(name),
		},
		setAttribute: (name: string, value: string) => attrs.set(name, value),
		removeAttribute: (name: string) => attrs.delete(name),
		get: (name: string) => props.get(name),
		attr: (name: string) => attrs.get(name),
	} as unknown as HTMLElement & {
		get: (n: string) => string | undefined;
		attr: (n: string) => string | undefined;
	};
}

describe("background image", () => {
	test("accepts http(s) and rejects everything else", () => {
		expect(checkBackgroundUrl("https://example.com/a.png")).toEqual({ ok: true });
		expect(checkBackgroundUrl("http://example.com/a.gif")).toEqual({ ok: true });
		expect(checkBackgroundUrl("javascript:alert(1)")).toEqual({ ok: false, reason: "protocol" });
		expect(checkBackgroundUrl("data:image/png;base64,AAAA")).toEqual({
			ok: false,
			reason: "protocol",
		});
		expect(checkBackgroundUrl("example.com/a.png")).toEqual({ ok: false, reason: "protocol" });
		expect(checkBackgroundUrl("")).toEqual({ ok: false, reason: "empty" });
		expect(checkBackgroundUrl("https://example.com/a b.png")).toEqual({ ok: true });
	});

	test("rejects a URL that could close the css declaration", () => {
		expect(checkBackgroundUrl('https://example.com/a".png')).toEqual({
			ok: false,
			reason: "malformed",
		});
		expect(checkBackgroundUrl("https://example.com/a\\.png")).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	test("parsing clamps numbers and disables an unusable url", () => {
		expect(parseBackgroundChoice(null)).toEqual(DEFAULT_BACKGROUND);
		expect(
			parseBackgroundChoice({ enabled: true, url: "javascript:alert(1)", opacity: 999, scrim: -5 }),
		).toEqual({ ...DEFAULT_BACKGROUND, opacity: 100, scrim: 0, enabled: false, url: "" });
		expect(
			parseBackgroundChoice({ enabled: true, url: "https://x.test/a.png", opacity: 1 }),
		).toEqual({
			...DEFAULT_BACKGROUND,
			enabled: true,
			source: "url",
			url: "https://x.test/a.png",
			opacity: MIN_OPACITY,
		});
	});

	test("switching source keeps the other source's configuration", () => {
		// Regression: picking a file used to blank `url`, so switching back to "URL" had
		// nothing to load and the wallpaper silently stopped appearing.
		const withUrl = parseBackgroundChoice({ enabled: true, url: "https://x.test/a.png" });
		const toFile = switchBackgroundSource({ ...withUrl, fileName: "a.png" }, "file");
		expect(toFile.url).toBe("https://x.test/a.png");
		expect(toFile.enabled).toBe(true);
		const back = switchBackgroundSource(toFile, "url");
		expect(back.url).toBe("https://x.test/a.png");
		expect(back.enabled).toBe(true);
	});

	test("switching to an empty source disables it instead of painting nothing", () => {
		expect(switchBackgroundSource(DEFAULT_BACKGROUND, "file").enabled).toBe(false);
		expect(switchBackgroundSource(DEFAULT_BACKGROUND, "url").enabled).toBe(false);
	});

	test("applying writes the variables, clearing removes them", () => {
		const root = stubRoot() as ReturnType<typeof stubRoot>;
		applyBackground(root as unknown as HTMLElement, {
			enabled: true,
			source: "url",
			url: "https://example.com/wall paper.png",
			opacity: 80,
			scrim: 60,
			blur: 10,
		});
		expect(root.attr("data-nf-bg")).toBe("on");
		// Spaces are legal inside a quoted url(); only quotes/backslashes need escaping.
		expect(root.get("--nf-bg-image")).toBe('url("https://example.com/wall paper.png")');
		expect(root.get("--nf-bg-pane-opacity")).toBe("80%");
		expect(root.get("--nf-bg-scrim")).toBe("60%");
		expect(root.get("--nf-bg-blur")).toBe("10px");
		expect(root.get("--nf-bg-body-opacity")).toBe("62%");

		applyBackground(root as unknown as HTMLElement, { ...DEFAULT_BACKGROUND });
		expect(root.attr("data-nf-bg")).toBeUndefined();
		expect(root.get("--nf-bg-image")).toBeUndefined();
	});
});
