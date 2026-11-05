import { describe, expect, test } from "bun:test";
import { titlebarMarksFor, WCO_TITLEBAR_ROW_SELECTOR } from "./wco-titlebar";

const root = { top: 0, left: 250, right: 1400 };

describe("WCO title-bar rows", () => {
	test("a header on the page's top edge is in the title bar; one below is not", () => {
		expect(titlebarMarksFor({ top: 0, left: 250, right: 900 }, root)).toEqual({
			row: true,
			end: false,
			start: true,
		});
		expect(titlebarMarksFor({ top: 41, left: 900, right: 1400 }, root).row).toBe(false);
	});

	test("the header reaching the right edge is the one that clears the window buttons", () => {
		expect(titlebarMarksFor({ top: 0.4, left: 900, right: 1399.6 }, root)).toEqual({
			row: true,
			end: true,
			start: false,
		});
		// Not on the top edge: never pads for the buttons, even at the right edge.
		expect(titlebarMarksFor({ top: 300, left: 900, right: 1400 }, root).end).toBe(false);
	});

	test("covers chat and panel headers and dockview tab strips", () => {
		for (const part of [
			"[data-narrator-header-layout]",
			".nf-panel-header",
			".dv-tabs-and-actions-container",
		]) {
			expect(WCO_TITLEBAR_ROW_SELECTOR).toContain(part);
		}
	});

	test("wco.css drags from title-bar rows, keeps controls clickable, pads the edge row", async () => {
		const css = await Bun.file(new URL("../styles/wco.css", import.meta.url)).text();
		expect(css).toMatch(/\[data-nf-titlebar-row\] \{[^}]*-webkit-app-region: drag/);
		expect(css).toMatch(/\[data-nf-titlebar-row\]\s*:is\([^)]*button[^)]*\) \{[^}]*no-drag/);
		expect(css).toMatch(/\[data-nf-titlebar-end\] \{[^}]*--nf-wco-inset-right/);
		expect(css).toMatch(
			/:has\(\[data-nf-wco-titlebar\]\) \.nf-wco-main-strip \{[^}]*display: none/,
		);
		const page = await Bun.file(
			new URL("../routes/narrators/$narratorId.tsx", import.meta.url),
		).text();
		expect(page).toContain("data-nf-wco-titlebar=");
		expect(page).toContain("useWcoTitlebarRows(pageBoxRef");
	});
});
