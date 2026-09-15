/**
 * The file-modifications panel must follow the active colour scheme.
 *
 * `--mantine-color-dark-*` is a fixed palette ramp, not a semantic token: it
 * resolves to the same dark greys under both colour schemes. Using it for
 * chrome (borders, hover fills, surface backgrounds) leaves dark patches
 * stranded in light mode — which is exactly the bug this guards.
 *
 * Semantic tokens (`--mantine-color-default-border`, `-default-hover`, `-body`)
 * are re-resolved per scheme and are also the surface plugin themes override,
 * so they stay correct in light mode, dark mode and OLED mode alike.
 *
 * This asserts on source text rather than rendered output on purpose: the
 * offending values were inline `style` strings, so a grep-level contract is
 * what actually prevents the regression from coming back.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"frontend",
	"components",
	"narrator",
	"file-panel",
);

/** Every component that renders inside the "File modifications" panel. */
const PANEL_COMPONENTS = [
	"FileModificationsDrawer.tsx",
	"FileSummaryTab.tsx",
	"FileDeletePreviewTab.tsx",
	"FileApprovalTab.tsx",
];

/**
 * A bare `var(--mantine-color-dark-N)` reference. A `light-dark(...)` pair is
 * fine — there the dark ramp is only the dark-scheme branch — so the match is
 * checked against the enclosing line before it counts as a violation.
 */
const DARK_RAMP_VAR = /var\(--mantine-color-dark-\d\)/;

/** Lines that pin a colour to the dark ramp regardless of the active scheme. */
function findDarkRampViolations(source: string): string[] {
	return source
		.split("\n")
		.map((line, index) => ({ line, lineNo: index + 1 }))
		.filter(({ line }) => DARK_RAMP_VAR.test(line) && !line.includes("light-dark("))
		.map(({ lineNo, line }) => `${lineNo}: ${line.trim()}`);
}

describe("dark-ramp detection", () => {
	// Without these, the suite below could pass by simply never matching
	// anything. They pin the detector's behaviour against known-bad and
	// known-good inputs, using in-memory samples so no source file is touched.
	it("flags the inline styles this panel actually regressed on", () => {
		expect(findDarkRampViolations('border: "1px solid var(--mantine-color-dark-4)",')).toEqual([
			'1: border: "1px solid var(--mantine-color-dark-4)",',
		]);
		expect(findDarkRampViolations('backgroundColor: "var(--mantine-color-dark-7)",')).toEqual([
			'1: backgroundColor: "var(--mantine-color-dark-7)",',
		]);
	});

	it("reports each offending line with its line number", () => {
		const sample = [
			'const ok = "var(--mantine-color-default-border)";',
			'const bad = "var(--mantine-color-dark-5)";',
		].join("\n");
		expect(findDarkRampViolations(sample)).toEqual([
			'2: const bad = "var(--mantine-color-dark-5)";',
		]);
	});

	it("accepts semantic tokens and light-dark() pairs", () => {
		expect(
			findDarkRampViolations('borderBottom: "1px solid var(--mantine-color-default-border)"'),
		).toEqual([]);
		expect(findDarkRampViolations('backgroundColor: "var(--mantine-color-body)"')).toEqual([]);
		// A dark-ramp value is legitimate as the dark branch of a light-dark() pair.
		expect(
			findDarkRampViolations(
				'const BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";',
			),
		).toEqual([]);
	});
});

describe("file-modifications panel colour scheme", () => {
	for (const fileName of PANEL_COMPONENTS) {
		it(`${fileName} uses no scheme-independent dark palette variables`, () => {
			const source = readFileSync(join(COMPONENT_DIR, fileName), "utf8");
			expect(findDarkRampViolations(source)).toEqual([]);
		});
	}

	it("keeps the full-file preview surface on a scheme-aware background", () => {
		// This block renders raw file text, so an unreadable dark-on-dark (or
		// dark-on-light) surface is a legibility bug, not just a cosmetic one.
		const source = readFileSync(join(COMPONENT_DIR, "FileApprovalTab.tsx"), "utf8");
		expect(source).toContain('backgroundColor: "var(--mantine-color-body)"');
	});
});
