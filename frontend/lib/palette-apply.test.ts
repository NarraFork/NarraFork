import { describe, expect, test } from "bun:test";
import { accentRampOverride, applyPalette, buildPaletteCss, paletteCssFor } from "./palette-apply";
import { DEFAULT_PALETTE } from "./palette-presets";

function stubRoot() {
	const removed: string[] = [];
	const set: string[] = [];
	return {
		style: {
			setProperty: (name: string) => set.push(name),
			removeProperty: (name: string) => removed.push(name),
		},
		removed,
		set,
	} as unknown as HTMLElement & { removed: string[]; set: string[] };
}

describe("palette application", () => {
	test("the default choice injects no palette CSS", () => {
		expect(buildPaletteCss(DEFAULT_PALETTE)).toBe("");
		expect(paletteCssFor(DEFAULT_PALETTE, null)).toBe("");
		expect(accentRampOverride(DEFAULT_PALETTE, null)).toBeNull();
	});

	test("slate is opt-in and does not override OLED dark slots", () => {
		const css = buildPaletteCss({ ...DEFAULT_PALETTE, neutral: "slate" });
		expect(css).toContain("#111113");
		expect(css).toContain("--mantine-color-dark-7: #111113;");
		expect(css).toContain(':root[data-mantine-color-scheme="dark"]:not([data-oled="true"])');
		expect(css).not.toContain("--mantine-color-indigo-");
		expect(accentRampOverride({ ...DEFAULT_PALETTE, neutral: "slate" }, null)).toBeNull();
	});

	test("a plugin theme suppresses both the neutral sheet and the accent override", () => {
		const choice = { ...DEFAULT_PALETTE, neutral: "slate" as const, accent: "rose" as const };
		expect(paletteCssFor(choice, "com.example.theme")).toBe("");
		expect(accentRampOverride(choice, "com.example.theme")).toBeNull();
		expect(accentRampOverride(choice, null)).toHaveLength(10);
	});

	test("applyPalette clears inline dark and indigo and does not write them back", () => {
		const root = stubRoot();
		applyPalette(root, { ...DEFAULT_PALETTE, neutral: "slate" }, null);
		expect(root.removed).toContain("--mantine-color-dark-6");
		expect(root.removed).toContain("--mantine-color-dark-7");
		expect(root.removed).toContain("--mantine-color-indigo-6");
		expect(root.set).toEqual([]);
	});
});
