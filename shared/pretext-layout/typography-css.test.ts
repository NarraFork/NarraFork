/**
 * typography-css.test.ts — the `--nf-type-*` variables are the height model's numbers, as CSS.
 *
 * The outline (editor, read-only tree, task board) is laid out by the browser and the mind map
 * is painted by CSS after pretext measured it; they all take the conversation's typography from
 * these variables. A variable that drifts from `typographyMetrics()` — a ratio where the model
 * rounded a px line box, a size rounded differently from the font string — shows up as nodes
 * that outgrow their measured boxes and an outline whose text no longer matches the transcript.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { headingMetrics, typographyMetrics } from "./pretext-fonts";
import { resetTypographyForTest, setTypography } from "./typography";
import { headingCssVar, TYPOGRAPHY_CSS_VARS, typographyCssVariables } from "./typography-css";

beforeEach(() => {
	resetTypographyForTest();
});

const V = TYPOGRAPHY_CSS_VARS;

function expectMatchesMetrics(vars: Record<string, string>): void {
	const m = typographyMetrics();
	expect(vars[V.bodySize]).toBe(`${m.size.sm}px`);
	expect(vars[V.bodyLine]).toBe(`${m.line.body}px`);
	expect(vars[V.xsSize]).toBe(`${m.size.xs}px`);
	expect(vars[V.xsLine]).toBe(`${m.line.xs}px`);
	expect(vars[V.codeSize]).toBe(`${m.size.xs}px`);
	expect(vars[V.codeBlockSize]).toBe(`${m.codeSize}px`);
	expect(vars[V.codeBlockLine]).toBe(`${m.line.code}px`);
	expect(vars[V.paragraphGap]).toBe(`${m.margin.paragraph}px`);
	for (const level of [1, 2, 3, 4, 5, 6] as const) {
		const h = headingMetrics(level);
		expect(vars[headingCssVar(level, "size")]).toBe(`${h.size}px`);
		expect(vars[headingCssVar(level, "line")]).toBe(`${h.lineHeight}px`);
	}
	// The size strings are the ones the measured font shorthands carry, so canvas and CSS
	// resolve the very same size.
	expect(m.font.body).toContain(vars[V.bodySize] as string);
	expect(m.font.inlineCode).toContain(vars[V.codeSize] as string);
}

describe("typography CSS variables", () => {
	it("publish the conversation's defaults, with the line box at the old 120%", () => {
		const vars = typographyCssVariables();
		expectMatchesMetrics(vars);
		expect(vars).toMatchObject({
			[V.fontScale]: "1",
			[V.lineScale]: "1.2",
			[V.letterSpacing]: "0em",
			[V.blockScale]: "1",
			[V.bodySize]: "14px",
			[V.bodyLine]: "24px", // round(14 × 1.45 × 1.2); was 20
			[V.xsSize]: "12px",
			[V.xsLine]: "20px", // round(12 × 1.4 × 1.2); was 17
			[V.codeBlockSize]: "11px",
			[V.codeBlockLine]: "20px", // round(11 × 1.55 × 1.2); was 17
			[headingCssVar(1, "size")]: "34px",
			[headingCssVar(1, "line")]: "53px",
			[headingCssVar(3, "size")]: "22px",
			[headingCssVar(3, "line")]: "37px",
		});
	});

	it("follow every knob: 115% font, 110% line height, +2% letter spacing", () => {
		setTypography({ fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 });
		const vars = typographyCssVariables();
		expectMatchesMetrics(vars);
		expect(vars[V.fontScale]).toBe("1.15");
		expect(Number(vars[V.lineScale])).toBeCloseTo(1.32, 10);
		expect(vars[V.letterSpacing]).toBe("0.02em");
		expect(vars[V.bodySize]).toBe("16.1px");
		expect(vars[V.bodyLine]).toBe(`${Math.round(16.1 * 1.45 * 1.32)}px`);
		// The em spacing resolves to the px the transcript measures each run with.
		expect(16.1 * 0.02).toBeCloseTo(typographyMetrics().letterSpacing.body, 10);
	});

	it("publish line boxes as whole pixels, never ratios", () => {
		for (const setting of [
			{ fontScalePercent: 70, lineHeightScalePercent: 60 },
			{ fontScalePercent: 133, lineHeightScalePercent: 117 },
			{ fontScalePercent: 180, lineHeightScalePercent: 185 },
		]) {
			setTypography(setting);
			const vars = typographyCssVariables();
			for (const [name, value] of Object.entries(vars)) {
				if (!name.endsWith("-line")) continue;
				expect(value, name).toMatch(/^\d+px$/);
			}
			expectMatchesMetrics(vars);
		}
	});

	it("block spacing moves only the block knob's variables", () => {
		const before = typographyCssVariables();
		setTypography({ paragraphScalePercent: 150 });
		const after = typographyCssVariables();
		for (const [name, value] of Object.entries(after)) {
			if (name === V.blockScale || name === V.paragraphGap) continue;
			expect(value, name).toBe(before[name] as string);
		}
		expect(after[V.blockScale]).toBe("1.5");
	});
});
