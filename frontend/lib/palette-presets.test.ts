import { describe, expect, test } from "bun:test";
import {
	ACCENT_PRESETS,
	contrastRatio,
	DEFAULT_PALETTE,
	hexToOklch,
	NEUTRAL_PRESETS,
	oklchToHex,
	parsePaletteChoice,
	relativeLuminance,
	resolvePalette,
} from "./palette-presets";

const HEX = /^#[0-9a-f]{6}$/;

describe("palette presets", () => {
	test("default is the literal token palette", () => {
		const { ink, paper, accent } = resolvePalette(DEFAULT_PALETTE);
		expect(ink["ink-950"]).toBe("#0b0e14");
		expect(ink["ink-900"]).toBe("#191d26");
		expect(paper["paper-50"]).toBe("#f6f7f9");
		expect(accent[6]).toBe("#4c6ef5");
	});

	test("every preset keeps the surface hierarchy and the contrast floors", () => {
		for (const preset of NEUTRAL_PRESETS) {
			const { ink, paper } = resolvePalette({
				...DEFAULT_PALETTE,
				neutral: preset.id,
			});
			for (const value of [...Object.values(ink), ...Object.values(paper)]) {
				expect(value).toMatch(HEX);
			}
			// Dark: darker step first; the ladder must stay ordered.
			const order = ["ink-950", "ink-900", "ink-850", "ink-800", "ink-700", "ink-600"];
			for (let i = 1; i < order.length; i += 1) {
				expect(relativeLuminance(ink[order[i]])).toBeGreaterThan(
					relativeLuminance(ink[order[i - 1]]),
				);
			}
			expect(contrastRatio(ink["ink-100"], ink["ink-900"])).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(ink["ink-300"], ink["ink-900"])).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(ink["ink-600"], ink["ink-900"])).toBeGreaterThanOrEqual(3);
			expect(contrastRatio(ink["ink-900"], ink["ink-950"])).toBeGreaterThan(1.1);

			expect(contrastRatio(paper["paper-900"], paper["paper-0"])).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(paper["paper-600"], paper["paper-0"])).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(paper["paper-500"], paper["paper-0"])).toBeGreaterThanOrEqual(3);
		}
	});

	test("custom neutral survives every hue, including pathological picks", () => {
		for (let hue = 0; hue < 360; hue += 30) {
			const hex = oklchToHex(0.6, 0.2, hue);
			const { ink, paper } = resolvePalette({
				...DEFAULT_PALETTE,
				neutral: "custom",
				neutralCustom: hex,
			});
			expect(contrastRatio(ink["ink-100"], ink["ink-900"])).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(ink["ink-300"], ink["ink-900"])).toBeGreaterThanOrEqual(4.5);
			expect(contrastRatio(ink["ink-600"], ink["ink-900"])).toBeGreaterThanOrEqual(3);
			expect(contrastRatio(paper["paper-600"], paper["paper-0"])).toBeGreaterThanOrEqual(4.5);
		}
		for (const extreme of ["#000000", "#ffffff", "#ffff00", "#00ff00"]) {
			const { ink } = resolvePalette({
				...DEFAULT_PALETTE,
				neutral: "custom",
				neutralCustom: extreme,
			});
			expect(contrastRatio(ink["ink-100"], ink["ink-900"])).toBeGreaterThanOrEqual(4.5);
		}
	});

	test("custom neutral takes the hue but not the user's brightness", () => {
		// A near-black and a near-white pick must both produce the same surface luminance
		// ladder, otherwise picking a colour would also silently change the contrast design.
		const dark = resolvePalette({
			...DEFAULT_PALETTE,
			neutral: "custom",
			neutralCustom: "#1a0b2e",
		});
		const light = resolvePalette({
			...DEFAULT_PALETTE,
			neutral: "custom",
			neutralCustom: "#e0d4ff",
		});
		const delta = Math.abs(
			relativeLuminance(dark.ink["ink-900"]) - relativeLuminance(light.ink["ink-900"]),
		);
		expect(delta).toBeLessThan(0.01);
	});

	test("accent ramp always carries a white label on the dark filled shade", () => {
		for (const preset of ACCENT_PRESETS) {
			const { accent } = resolvePalette({ ...DEFAULT_PALETTE, accent: preset.id });
			expect(accent).toHaveLength(10);
			for (const value of accent) expect(value).toMatch(HEX);
			expect(contrastRatio("#ffffff", accent[8])).toBeGreaterThanOrEqual(4.5);
		}
		for (let hue = 0; hue < 360; hue += 45) {
			const hex = oklchToHex(0.7, 0.18, hue);
			const { accent } = resolvePalette({
				...DEFAULT_PALETTE,
				accent: "custom",
				accentCustom: hex,
			});
			expect(contrastRatio("#ffffff", accent[8])).toBeGreaterThanOrEqual(4.5);
		}
	});

	test("hexToOklch round-trips within a rounding step", () => {
		for (const hex of ["#0b0e14", "#191d26", "#f6f7f9", "#4c6ef5"]) {
			const { L, C, H } = hexToOklch(hex);
			expect(oklchToHex(L, C, H)).toBe(hex);
		}
	});

	test("parsePaletteChoice repairs junk without throwing", () => {
		expect(parsePaletteChoice(null)).toEqual(DEFAULT_PALETTE);
		expect(parsePaletteChoice({ neutral: "nope", accent: 42 })).toEqual(DEFAULT_PALETTE);
		expect(parsePaletteChoice({ neutral: "custom", neutralCustom: "red", accent: "teal" })).toEqual(
			{
				...DEFAULT_PALETTE,
				neutral: "custom",
				accent: "teal",
			},
		);
	});
});
