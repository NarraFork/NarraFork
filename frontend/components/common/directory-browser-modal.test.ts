import { describe, expect, test } from "bun:test";
import {
	DIRECTORY_BROWSER_HEIGHT,
	DIRECTORY_BROWSER_MODAL_STYLES,
	DIRECTORY_BROWSER_ROOT_STYLE,
} from "./directory-browser-modal";

const MODAL_HOSTS = [
	"./DirectoryPicker.tsx",
	"./PathInputWithBrowse.tsx",
	"./DirListEditor.tsx",
	"../permissions/TargetPathInput.tsx",
] as const;

const BROWSERS = ["./DirectoryPicker.tsx", "../permissions/RemoteDirectoryBrowser.tsx"] as const;

async function readSource(path: string): Promise<string> {
	return await Bun.file(new URL(path, import.meta.url)).text();
}

describe("directory browser modal sizing", () => {
	test("height is expressed in dvh, never vh", () => {
		// On mobile `vh` resolves against the large viewport (browser chrome retracted), so
		// a `vh`-sized modal overhangs the visible area while the URL bar is showing.
		expect(DIRECTORY_BROWSER_HEIGHT).toContain("dvh");
		expect(DIRECTORY_BROWSER_HEIGHT).not.toMatch(/\d+vh/);
	});

	test("an unbroken flex chain carries the height from modal content to the panes", () => {
		// Mantine gives the body no height of its own, so without this chain a percentage
		// height inside resolves against an indefinite parent and collapses to content size
		// — the reason the panes previously needed hardcoded pixel heights.
		expect(DIRECTORY_BROWSER_MODAL_STYLES.content.height).toBe(DIRECTORY_BROWSER_HEIGHT);
		for (const style of [
			DIRECTORY_BROWSER_MODAL_STYLES.content,
			DIRECTORY_BROWSER_MODAL_STYLES.body,
		]) {
			expect(style.display).toBe("flex");
			expect(style.flexDirection).toBe("column");
		}
		// Body and root must both be able to shrink below their content, so the inner
		// scroll areas absorb a long listing instead of the modal growing past its box.
		for (const style of [DIRECTORY_BROWSER_MODAL_STYLES.body, DIRECTORY_BROWSER_ROOT_STYLE]) {
			expect(style.flex).toBe(1);
			expect(style.minHeight).toBe(0);
		}
	});

	test("the body height is never derived by subtracting an assumed header height", () => {
		// `calc(height - 60px)` encodes Mantine's `min-height: 60px` header as if it were
		// fixed. A modal title that wraps on a narrow phone makes the header taller and
		// pushes the body past the modal's own cap — measured as the footer overflowing.
		const serialized = JSON.stringify(DIRECTORY_BROWSER_MODAL_STYLES);
		expect(serialized).not.toContain("calc");
		expect(serialized).not.toContain("60px");
	});

	test("no scroll pane in a browser takes a fixed pixel height", async () => {
		// The portrait bug: the listing pane was pinned to a fixed pixel height, so it
		// stopped short of the modal's bottom edge and left dead space below the last
		// folder while the list itself still had to scroll (measured 280px at 412x915).
		//
		// Asserted over *every* ScrollArea in these files rather than against a located
		// listing pane: the anchor for "which one is the listing" is a comment, and a
		// test that silently falls back to the first match when that comment is reworded
		// stops guarding anything. Both panes here are meant to derive their height, so
		// the blanket rule is both simpler and stricter.
		for (const path of BROWSERS) {
			const source = await readSource(path);
			const openTags = source.match(/<ScrollArea[^>]*>/g) ?? [];
			expect(openTags.length).toBeGreaterThan(0);
			for (const tag of openTags) {
				// Checked per prop rather than across the whole tag so a breakpoint-
				// conditional height (`h={isWide ? "100%" : 350}`) is caught too: that is
				// exactly the shape this bug had, and a tag-wide digit scan cannot tell its
				// `350` from the `1` in `flex: 1`. Percentages are the allowed numeric form.
				const sizingProps = tag.match(/\b(?:h|mah|mih)=(?:\{[^}]*\}|"[^"]*")/g) ?? [];
				for (const prop of sizingProps) {
					expect(prop).not.toMatch(/\d+(?![\d%])/);
				}
			}
			// `Autosize` caps at its `mah` and would reintroduce the same shortfall.
			expect(source).not.toContain("ScrollArea.Autosize");
		}
	});

	test("every modal host shares one sizing source", async () => {
		// Four separate components mount this browser. When each inlined its own body
		// styles, a sizing fix had to be repeated four times and silently regressed
		// wherever it was missed.
		for (const host of MODAL_HOSTS) {
			const source = await readSource(host);
			expect(source).toContain("DIRECTORY_BROWSER_MODAL_STYLES");
			expect(source).not.toContain('maxHeight: "85vh"');
		}
	});
});
