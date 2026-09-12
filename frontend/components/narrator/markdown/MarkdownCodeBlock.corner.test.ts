/**
 * MarkdownCodeBlock.corner.test.ts — a fenced block that LEADS a ContentViewer
 * body must not hide its copy button under the viewer's own action bar.
 *
 * The bug: `ContentViewer` parks a sticky action bar (source / wrap / copy /
 * fullscreen) at the body's top-right corner with `z-index: 2`, while
 * `MarkdownCodeBlock` pins its per-panel copy button to the same corner at
 * `z-index: 1`. When the markdown body OPENS with a fenced block the two land on
 * identical pixels, and since the bar deliberately wins the stacking order the
 * panel's copy button was completely covered — the block looked like it had no
 * copy affordance at all.
 *
 * This is a CSS-only repair (a `:first-child` rule shifting the button clear of
 * the bar's strip), so there is no component behaviour to assert. The rule itself
 * is the contract, and it is easy to delete during unrelated CSS cleanup — hence a
 * test that reads the stylesheet.
 *
 * The virtual-list path has the same collision and the same fix, asserted
 * behaviourally in `vlist/render/RenderMarkdown.codecopy.test.tsx`. Both must dodge
 * the SAME strip width, which is what the final assertion here pins.
 */

import { describe, expect, it } from "bun:test";

const CSS = await Bun.file(
	new URL("./MarkdownContent.module.css", import.meta.url).pathname,
).text();

/** The declaration block of the first rule whose selector matches `pattern`. */
function ruleBody(pattern: RegExp): string {
	const match = CSS.match(new RegExp(`${pattern.source}[^{]*\\{([^}]*)\\}`));
	return match?.[1] ?? "";
}

describe("leading fenced block vs the ContentViewer action bar", () => {
	it("pins an ordinary panel's copy button to its own top-right corner", () => {
		// The baseline the override below flips; if this moves, that rule moves too.
		const base = ruleBody(/\.codeCopy/);
		expect(base).toContain("top: 4px");
		expect(base).toContain("right: 4px");
	});

	it("moves the copy button of a body's FIRST code block to the bottom corner", () => {
		const moved = ruleBody(/> \.codeBlock:first-child \.codeCopy/);
		expect(moved).not.toBe("");
		expect(moved).toContain("bottom: 4px");
		// `top` must be released, or the button would be pinned to both edges and
		// stretch down the whole panel.
		expect(moved).toContain("top: auto");
	});

	it("moves it vertically, not sideways", () => {
		// Sideways was the first attempt and looked wrong: five grey icons in one
		// strip, two of them copy glyphs with different scopes (this block vs the
		// whole message). The horizontal inset must stay at the inherited 4px.
		const moved = ruleBody(/> \.codeBlock:first-child \.codeCopy/);
		expect(moved).not.toContain("right:");
		expect(moved).not.toContain("left:");
	});

	it("scopes the move to a ContentViewer body, so a bare markdown block keeps its corner", () => {
		// `MarkdownContent` also renders WITHOUT a ContentViewer (compact summaries,
		// reasoning bodies). No action bar there, so nothing to dodge.
		const selector = CSS.match(/\[data-content-block\][^{]*\.codeCopy/)?.[0] ?? "";
		expect(selector).toContain("[data-content-block]");
		expect(selector).toContain(":first-child");
	});

	it("resolves the same collision the virtual list resolves", async () => {
		// Both renderers must agree on WHERE a colliding button goes, or the two
		// paths would look different for identical content. The vlist decides from
		// measured geometry; this path can only express the tall-panel case in CSS
		// (see the note in the stylesheet about the `hidden` outcome).
		const { resolveCodeCopyPlacement } = await import("../vlist/vlist-content-view-float");
		expect(resolveCodeCopyPlacement(0, 200)).toBe("bottom-right");
		expect(ruleBody(/> \.codeBlock:first-child \.codeCopy/)).toContain("bottom:");
	});

	it("documents the single-line panel gap instead of pretending to handle it", () => {
		// CSS cannot branch on a box's height, so the vlist's `hidden` outcome has no
		// equivalent here. An earlier draft "handled" it with an @supports block that
		// did nothing — the honest note must stay, and the fake guard must not return.
		expect(CSS).not.toContain("@supports (height: 1px)");
		expect(CSS).toContain("resolveCodeCopyPlacement");
	});
});
