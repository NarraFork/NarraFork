/**
 * The settings preview inlines the brand logo instead of fetching it, so that
 * dragging the colour picker responds instantly and never shows a cached or
 * already-saved colour. The cost is a second copy of the mark, and a copy can go
 * stale without any visible symptom: the preview would keep showing the old logo
 * while the real icons had changed.
 */

import { describe, expect, test } from "bun:test";

const SHIPPED_SVG = await Bun.file("frontend/public/favicon.svg").text();
const SECTION_SOURCE = await Bun.file("frontend/components/settings/BrandingSection.tsx").text();

/** Compare geometry only: the shipped file carries explanatory comments. */
function normalizeSvg(svg: string): string {
	return svg
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function extractInlinedSvg(source: string): string {
	const match = source.match(/const BRAND_LOGO_SVG = `([\s\S]*?)`;/);
	expect(match).not.toBeNull();
	return match?.[1] ?? "";
}

describe("settings preview logo", () => {
	test("is geometrically identical to the shipped favicon", () => {
		expect(normalizeSvg(extractInlinedSvg(SECTION_SOURCE))).toBe(normalizeSvg(SHIPPED_SVG));
	});

	test("carries the default accent colour, so recolouring has something to substitute", () => {
		// `recolorBrandSvg` replaces the literal default; an inlined copy already in some
		// other colour would silently stop responding to the picker.
		expect(extractInlinedSvg(SECTION_SOURCE)).toContain("#4c6ef5");
	});
});
