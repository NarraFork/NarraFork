import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { applyThemeColor, installThemeColorSync, resolveThemeColor } from "./theme-color-sync";

/**
 * A linkedom realm whose `getComputedStyle` answers from a mutable map, keyed by
 * element: header → body → html. linkedom has no style engine, so each test
 * states the computed background directly.
 */
function themeRealm(backgrounds: { header?: string; body?: string; html?: string } = {}) {
	const { window: domWindow, document: domDocument } = parseHTML(
		`<!doctype html><html><head>
			<meta name="theme-color" content="#1a1b1e" media="(prefers-color-scheme: dark)" />
			<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
		</head><body><div class="nf-app-shell"><header class="mantine-AppShell-header"></header></div></body></html>`,
	);
	const header = domDocument.querySelector(".mantine-AppShell-header");

	const frames = new Set<FrameRequestCallback>();
	Object.defineProperties(domWindow, {
		getComputedStyle: {
			configurable: true,
			writable: true,
			value: (element: Element) => ({
				backgroundColor:
					element === header
						? (backgrounds.header ?? "")
						: element === domDocument.body
							? (backgrounds.body ?? "")
							: (backgrounds.html ?? ""),
			}),
		},
		requestAnimationFrame: {
			configurable: true,
			writable: true,
			value: (callback: FrameRequestCallback) => {
				frames.add(callback);
				return frames.size;
			},
		},
		cancelAnimationFrame: {
			configurable: true,
			writable: true,
			value: () => frames.clear(),
		},
	});

	return {
		window: domWindow as unknown as Window,
		document: domDocument as unknown as Document,
		header,
		/** Mutable: later reads answer with the current values. */
		backgrounds,
		metas: () => [...domDocument.querySelectorAll('meta[name="theme-color"]')],
		flushFrames() {
			for (const callback of [...frames]) {
				frames.delete(callback);
				callback(0);
			}
		},
	};
}

afterEach(() => mock.restore());

describe("resolveThemeColor", () => {
	test("reads the header's background first — it is the surface the WCO buttons overlay", () => {
		const realm = themeRealm({ header: "rgb(26, 27, 30)", body: "rgb(9, 9, 9)" });
		expect(resolveThemeColor(realm.window, realm.document)).toBe("rgb(26, 27, 30)");
	});

	test("falls back to body, then <html>, past transparent or missing backgrounds", () => {
		const realm = themeRealm({ header: "rgba(0, 0, 0, 0)", body: "rgb(9, 9, 9)" });
		expect(resolveThemeColor(realm.window, realm.document)).toBe("rgb(9, 9, 9)");

		const noBody = themeRealm({ header: "", body: "rgba(0,0,0,0)", html: "rgb(1, 2, 3)" });
		expect(resolveThemeColor(noBody.window, noBody.document)).toBe("rgb(1, 2, 3)");
	});

	test("returns null when every layer is transparent", () => {
		const realm = themeRealm({});
		expect(resolveThemeColor(realm.window, realm.document)).toBe(null);
	});
});

describe("applyThemeColor", () => {
	test("writes BOTH media-scoped metas, so the OS-scheme pick matches either way", () => {
		const realm = themeRealm();
		applyThemeColor(realm.document, "rgb(9, 9, 9)");
		expect(realm.metas().map((m) => m.getAttribute("content"))).toEqual([
			"rgb(9, 9, 9)",
			"rgb(9, 9, 9)",
		]);
	});
});

describe("installThemeColorSync", () => {
	test("applies the colour on the first frame", () => {
		const realm = themeRealm({ header: "rgb(26, 27, 30)" });
		const dispose = installThemeColorSync(realm.window, realm.document);
		realm.flushFrames();
		expect(realm.metas().map((m) => m.getAttribute("content"))).toEqual([
			"rgb(26, 27, 30)",
			"rgb(26, 27, 30)",
		]);
		dispose();
	});

	test("does not touch the metas when no usable background exists", () => {
		const realm = themeRealm({});
		const dispose = installThemeColorSync(realm.window, realm.document);
		realm.flushFrames();
		expect(realm.metas().map((m) => m.getAttribute("content"))).toEqual(["#1a1b1e", "#ffffff"]);
		dispose();
	});

	test("re-syncs when a watched attribute moves (scheme, OLED, plugin theme)", async () => {
		const realm = themeRealm({ header: "rgb(26, 27, 30)" });
		const dispose = installThemeColorSync(realm.window, realm.document);
		realm.flushFrames();

		// The plugin theme switched and repainted the shell; the attribute move is
		// the only signal, so it must trigger a re-read of the computed colour.
		// MutationObserver callbacks are microtasks, so yield before flushing.
		realm.backgrounds.header = "rgb(40, 10, 60)";
		realm.document.documentElement.setAttribute("data-plugin-theme", "pop-art");
		await new Promise((resolve) => setTimeout(resolve, 0));
		realm.flushFrames();
		expect(realm.metas()[0]?.getAttribute("content")).toBe("rgb(40, 10, 60)");
		dispose();
	});

	test("stops observing after dispose", async () => {
		const realm = themeRealm({ header: "rgb(26, 27, 30)" });
		const dispose = installThemeColorSync(realm.window, realm.document);
		realm.flushFrames();
		dispose();

		realm.backgrounds.header = "rgb(0, 0, 0)";
		realm.document.documentElement.setAttribute("data-oled", "true");
		await new Promise((resolve) => setTimeout(resolve, 0));
		realm.flushFrames();
		expect(realm.metas()[0]?.getAttribute("content")).toBe("rgb(26, 27, 30)");
	});
});
