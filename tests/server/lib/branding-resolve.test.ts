import { describe, expect, test } from "bun:test";
import {
	BRAND_NAME_MAX_LENGTH,
	DEFAULT_BRAND_ICON_COLOR,
	DEFAULT_BRAND_NAME,
	normalizeBrandIconColor,
	normalizeBrandName,
	parseHexColor,
	recolorBrandSvg,
	resolveBranding,
} from "@shared/branding";

describe("normalizeBrandName", () => {
	test("trims and collapses internal whitespace", () => {
		expect(normalizeBrandName("  Work   Instance \n")).toBe("Work Instance");
	});

	test("strips control characters", () => {
		// Control characters would break the single-line header layout and could pad a
		// name past the length bound without being visible.
		expect(normalizeBrandName("Work\u0000\u001bInstance\u007f")).toBe("Work Instance");
	});

	test("truncates to the display bound", () => {
		const long = "x".repeat(BRAND_NAME_MAX_LENGTH + 10);
		expect(normalizeBrandName(long)).toHaveLength(BRAND_NAME_MAX_LENGTH);
	});

	test("measures length AFTER collapsing, so padding cannot smuggle characters in", () => {
		const padded = `${" ".repeat(20)}${"y".repeat(BRAND_NAME_MAX_LENGTH)}${" ".repeat(20)}`;
		expect(normalizeBrandName(padded)).toBe("y".repeat(BRAND_NAME_MAX_LENGTH));
	});

	test("blank and non-string input yield an empty string", () => {
		expect(normalizeBrandName("   ")).toBe("");
		expect(normalizeBrandName(undefined)).toBe("");
		expect(normalizeBrandName(null)).toBe("");
	});
});

describe("normalizeBrandIconColor", () => {
	test("lowercases and expands the short form", () => {
		expect(normalizeBrandIconColor("#ABC")).toBe("#aabbcc");
		expect(normalizeBrandIconColor("#E64980")).toBe("#e64980");
	});

	test("accepts surrounding whitespace", () => {
		expect(normalizeBrandIconColor("  #e64980 ")).toBe("#e64980");
	});

	test("rejects anything that is not a hex triplet", () => {
		// Read paths treat "" as "not configured" and fall back — see the module header
		// on why this never throws.
		for (const bad of ["red", "e64980", "#12345", "#gggggg", "rgb(1,2,3)", ""]) {
			expect(normalizeBrandIconColor(bad)).toBe("");
		}
	});
});

describe("parseHexColor", () => {
	test("returns 8-bit components", () => {
		expect(parseHexColor("#4c6ef5")).toEqual([0x4c, 0x6e, 0xf5]);
		expect(parseHexColor("#fff")).toEqual([255, 255, 255]);
	});

	test("returns null for unparseable input", () => {
		expect(parseHexColor("nope")).toBeNull();
	});
});

describe("resolveBranding", () => {
	test("absent input resolves to the NarraFork defaults and is not customized", () => {
		const resolved = resolveBranding(undefined);
		expect(resolved).toEqual({
			name: DEFAULT_BRAND_NAME,
			iconColor: DEFAULT_BRAND_ICON_COLOR,
			customized: false,
		});
	});

	test("a name equal to the default is not customized", () => {
		// Storing "NarraFork" explicitly must not switch on the attribution line, which
		// only exists to credit NarraFork when the name no longer says so.
		expect(resolveBranding({ name: "NarraFork" }).customized).toBe(false);
		expect(resolveBranding({ name: " NarraFork " }).customized).toBe(false);
	});

	test("a colour equal to the default is not customized", () => {
		expect(resolveBranding({ iconColor: "#4C6EF5" }).customized).toBe(false);
	});

	test("either field differing marks it customized", () => {
		expect(resolveBranding({ name: "Home" }).customized).toBe(true);
		expect(resolveBranding({ iconColor: "#e64980" }).customized).toBe(true);
	});

	test("invalid stored values fall back rather than propagating", () => {
		const resolved = resolveBranding({ name: "   ", iconColor: "not-a-colour" });
		expect(resolved.name).toBe(DEFAULT_BRAND_NAME);
		expect(resolved.iconColor).toBe(DEFAULT_BRAND_ICON_COLOR);
		expect(resolved.customized).toBe(false);
	});
});

describe("recolorBrandSvg", () => {
	const svg = '<svg><rect fill="#4c6ef5"/><circle fill="#fff"/></svg>';

	test("substitutes the accent fill and leaves white alone", () => {
		expect(recolorBrandSvg(svg, "#e64980")).toBe(
			'<svg><rect fill="#e64980"/><circle fill="#fff"/></svg>',
		);
	});

	test("returns the input unchanged for the default colour", () => {
		expect(recolorBrandSvg(svg, DEFAULT_BRAND_ICON_COLOR)).toBe(svg);
	});

	test("an unparseable colour leaves the SVG at the default rather than corrupting the fill", () => {
		expect(recolorBrandSvg(svg, "javascript:alert(1)")).toBe(svg);
	});
});
