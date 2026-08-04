/**
 * narrator-mount-column.guard.test.ts — The narrator content column must be ONE
 * width for the whole mount.
 *
 * Opening a narrator used to step through three widths, with two visible jumps:
 *
 *   1. an 860px centered skeleton — the exact list seeded `contentWidth` with
 *      NARRATOR_CENTERED_COLUMN_MAX_WIDTH (a 0-guard fallback, not a real width) and
 *      the loading placeholder PAINTED it, whatever the reader's preference;
 *   2. the measured width, 140ms late — the first measurement went through
 *      `resolveWidthSettle`, which saw an ordinary observer callback and deferred for
 *      WIDTH_SETTLE_DELAY_MS;
 *   3. ~15px narrower — the loaded document became taller than the viewport, the
 *      vertical scrollbar appeared, and `clientWidth` (content-box) dropped.
 *
 * Every one of those is a WIRING property: the widths are correct at each step, so no
 * unit test on the pure resolvers can see the sequence. They are asserted on the
 * wiring instead.
 *
 * A fourth source sat above the list: the panel skeleton and the lazy-chunk fallback
 * laid their skeletons out with Mantine padding while the list used px, so those
 * placeholders could differ from the column that replaced them. The guard therefore
 * also pins that all three placeholder hosts share ONE column helper — and that the
 * skeleton component itself owns no width, so nothing nests two caps.
 *
 * Zero-runtime, filesystem-only.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NARRATOR_DIR = import.meta.dir;
const FRONTEND_ROOT = resolve(NARRATOR_DIR, "..", "..");

function read(...segments: string[]): string {
	return readFileSync(join(...segments), "utf8");
}

const shell = () => read(NARRATOR_DIR, "vlist", "PretextExactMessageList.tsx");
const panel = () => read(NARRATOR_DIR, "NarratorPanel.tsx");
const panelSkeleton = () => read(NARRATOR_DIR, "NarratorPanelSkeleton.tsx");
const messageSkeleton = () => read(NARRATOR_DIR, "NarratorMessageListSkeleton.tsx");
const column = () => read(FRONTEND_ROOT, "lib", "narrator-content-column.ts");

/** The vlist placeholder element's inline style block. */
function placeholderStyle(source: string): string {
	const marker = source.indexOf("data-pretext-exact-status");
	expect(marker).toBeGreaterThan(-1);
	const start = source.indexOf("style={{", marker);
	expect(start).toBeGreaterThan(marker);
	const end = source.indexOf("}}", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("mount column: the loading placeholder never paints a measured width", () => {
	it("lays the vlist placeholder out from the shared helper, not contentWidth", () => {
		const style = placeholderStyle(shell());
		expect(style).toContain("narratorColumnPlaceholderStyle(centeredColumn)");
		// Reading the measured width here is what painted the sentinel geometry.
		expect(style).not.toContain("contentWidth");
		// And its gutter comes from the helper too, not a local padding.
		expect(style).not.toContain("PAGE_PADDING");
	});

	it("keeps the vlist gutter and the placeholder gutter on ONE constant", () => {
		// A local literal here is how the two would drift: the rows measure against
		// clientWidth minus PAGE_PADDING, the placeholder pads by the shared constant.
		expect(shell()).toMatch(/const\s+PAGE_PADDING\s*=\s*NARRATOR_COLUMN_GUTTER_PX\s*;/);
	});
});

describe("mount column: the scrollbar cannot change the measured width", () => {
	it("reserves the scrollbar gutter on the list viewport", () => {
		const source = shell();
		const viewport = source.indexOf("data-pretext-exact-message-list");
		expect(viewport).toBeGreaterThan(-1);
		// The style block precedes the marker attribute on the same element.
		const style = source.slice(source.lastIndexOf("style={{", viewport), viewport);
		expect(style).toContain('overflow: "auto"');
		expect(style).toContain('scrollbarGutter: "stable"');
	});
});

describe("mount column: one owner for the placeholder width", () => {
	it("routes all three placeholder hosts through the same helper", () => {
		// The list's own document-loading placeholder...
		expect(shell()).toContain("narratorColumnPlaceholderStyle(centeredColumn)");
		// ...the panel-level skeleton (narrator record still loading)...
		expect(panelSkeleton()).toContain("narratorColumnPlaceholderStyle(centeredColumn)");
		// ...and the lazy-chunk Suspense fallback.
		expect(panel()).toContain("narratorColumnPlaceholderStyle(narratorCenteredColumn)");
	});

	it("keeps the skeleton component itself free of any width", () => {
		// The helper is the SINGLE owner of the cap. A width on the skeleton would nest
		// a second constraint inside its host's, and the two could disagree.
		const source = messageSkeleton();
		expect(source).not.toContain("maxWidth");
		expect(source).not.toContain("narratorColumnPlaceholderStyle");
		expect(source).not.toContain("NARRATOR_CENTERED_COLUMN_MAX_WIDTH");
	});

	it("keeps no Mantine padding on the placeholder hosts", () => {
		// `px="md"` is a rem gutter; the rows measure in px. Identical at the default
		// root font size, divergent at any other — which is a width jump on mount.
		const skeletonBody = panelSkeleton().slice(panelSkeleton().indexOf("Message area skeleton"));
		const messageArea = skeletonBody.slice(0, skeletonBody.indexOf("Status bar skeleton"));
		expect(messageArea).not.toContain('px="md"');
		expect(messageArea).not.toContain('py="sm"');
	});

	it("derives the helper's geometry in px from the shared gutter", () => {
		const source = column();
		const fn = source.slice(source.indexOf("export function narratorColumnPlaceholderStyle("));
		expect(fn).toContain("NARRATOR_CENTERED_COLUMN_MAX_WIDTH + NARRATOR_COLUMN_GUTTER_PX * 2");
		// A CSS `calc` with a spacing token here would reintroduce the rem/px split.
		expect(fn).not.toContain("var(--mantine-spacing");
		expect(fn).not.toContain("calc(");
	});
});
