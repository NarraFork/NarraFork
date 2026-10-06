import { describe, expect, it } from "bun:test";
import {
	NARRATOR_CENTERED_COLUMN_MAX_WIDTH,
	NARRATOR_COLUMN_GUTTER_PX,
	narratorColumnPlaceholderStyle,
	resolveNarratorColumnMaxWidth,
	resolveNarratorColumnWidth,
} from "./narrator-content-column";

describe("resolveNarratorColumnWidth", () => {
	it("fills the viewport (minus gutters) when the cap is off", () => {
		// Default behaviour: parity with the chunked path, which has never capped.
		expect(resolveNarratorColumnWidth(1600, 16, false)).toBe(1568);
		expect(resolveNarratorColumnWidth(600, 16, false)).toBe(568);
	});

	it("caps at the reading width when the option is on", () => {
		expect(resolveNarratorColumnWidth(1600, 16, true)).toBe(NARRATOR_CENTERED_COLUMN_MAX_WIDTH);
		// Narrower than the cap → the viewport still wins (no overflow).
		expect(resolveNarratorColumnWidth(600, 16, true)).toBe(568);
	});

	it("never returns a non-positive width for an unmeasured viewport", () => {
		// clientWidth 0 before first layout must not produce a 0/negative measure width.
		expect(resolveNarratorColumnWidth(0, 16, false)).toBe(1);
		expect(resolveNarratorColumnWidth(0, 16, true)).toBe(1);
		expect(resolveNarratorColumnWidth(20, 16, false)).toBe(1);
	});
});

describe("resolveNarratorColumnMaxWidth", () => {
	it("is undefined when off so the wrapper keeps filling the viewport", () => {
		expect(resolveNarratorColumnMaxWidth(false, "var(--mantine-spacing-md)")).toBeUndefined();
	});

	it("adds both gutters back so the inner column measures the reading width", () => {
		expect(resolveNarratorColumnMaxWidth(true, "var(--mantine-spacing-md)")).toBe(
			`calc(${NARRATOR_CENTERED_COLUMN_MAX_WIDTH}px + var(--mantine-spacing-md) * 2)`,
		);
	});
});

/**
 * The placeholder column and the real row column must resolve to the SAME content
 * width, because a mount paints the former and then replaces it with the latter.
 *
 * This is the mechanical guarantee behind that: both are computed here, from one
 * gutter constant, in px. The failure it rules out is a placeholder laid out with a
 * rem gutter (Mantine spacing) while the rows measure against `clientWidth` in px —
 * identical at the default root font size, divergent at any other, and the
 * divergence shows up as a width jump on every mount.
 */
describe("narratorColumnPlaceholderStyle", () => {
	/** Content width the placeholder's box model yields inside `viewportWidth`. */
	function placeholderContentWidth(viewportWidth: number, centered: boolean): number {
		const style = narratorColumnPlaceholderStyle(centered);
		// border-box + width:100% → the outer box is the viewport, capped by maxWidth.
		const outer = Math.min(viewportWidth, (style.maxWidth as number) ?? viewportWidth);
		return outer - Number(style.paddingLeft) - Number(style.paddingRight);
	}

	it("resolves to the same content width the rows are measured with", () => {
		for (const viewportWidth of [360, 600, 900, 1200, 1600, 2400]) {
			for (const centered of [false, true]) {
				expect(placeholderContentWidth(viewportWidth, centered)).toBe(
					resolveNarratorColumnWidth(viewportWidth, NARRATOR_COLUMN_GUTTER_PX, centered),
				);
			}
		}
	});

	it("caps at the reading width when centered, and fills the viewport when not", () => {
		expect(placeholderContentWidth(1600, true)).toBe(NARRATOR_CENTERED_COLUMN_MAX_WIDTH);
		expect(placeholderContentWidth(1600, false)).toBe(1600 - NARRATOR_COLUMN_GUTTER_PX * 2);
	});

	it("centers itself and states its box model explicitly", () => {
		const style = narratorColumnPlaceholderStyle(true);
		expect(style.margin).toBe("0 auto");
		// Not inherited from a global reset: the cap adds both gutters back, so a
		// content-box reading would make the placeholder two gutters too wide.
		expect(style.boxSizing).toBe("border-box");
		expect(style.width).toBe("100%");
	});

	it("leaves the cap off entirely when the preference is off", () => {
		expect(narratorColumnPlaceholderStyle(false).maxWidth).toBeUndefined();
	});
});
