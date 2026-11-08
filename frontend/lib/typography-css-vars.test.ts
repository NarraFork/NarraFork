/**
 * The `--nf-type-*` variables on <html> follow the reader's typography — published once, then
 * kept current on every change, so a slider drag in the 外观 panel previews in the outline as it
 * does in the transcript.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { TYPOGRAPHY_CSS_VARS, typographyCssVariables } from "@shared/pretext-layout/typography-css";
import { parseHTML } from "linkedom";

const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const previous = (globalThis as { document?: unknown }).document;
(globalThis as { document?: unknown }).document = document;
afterAll(() => {
	(globalThis as { document?: unknown }).document = previous;
});

const { applyTypographyCssVars, ensureTypographyCssVars, TYPE_ROLE_STYLE } = await import(
	"./typography-css-vars"
);

const root = () => document.documentElement as unknown as HTMLElement;
const read = (name: string) => root().style.getPropertyValue(name);

beforeEach(() => {
	resetTypographyForTest();
});

describe("typography CSS variables on <html>", () => {
	it("writes every variable with its current value", () => {
		const el = document.createElement("div") as unknown as HTMLElement;
		applyTypographyCssVars(el);
		for (const [name, value] of Object.entries(typographyCssVariables())) {
			expect(el.style.getPropertyValue(name), name).toBe(value);
		}
	});

	it("publishes on install and follows every later change (the slider preview)", () => {
		ensureTypographyCssVars();
		expect(read(TYPOGRAPHY_CSS_VARS.bodyLine)).toBe(`${typographyMetrics().line.body}px`);
		expect(read(TYPOGRAPHY_CSS_VARS.bodyLine)).toBe("24px");

		setTypography({ fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 });
		expect(read(TYPOGRAPHY_CSS_VARS.bodySize)).toBe("16.1px");
		expect(read(TYPOGRAPHY_CSS_VARS.bodyLine)).toBe(`${typographyMetrics().line.body}px`);
		expect(read(TYPOGRAPHY_CSS_VARS.letterSpacing)).toBe("0.02em");

		// Installing again is a no-op (one subscription, however many surfaces ask).
		ensureTypographyCssVars();
		setTypography({ lineHeightScalePercent: 100 });
		expect(read(TYPOGRAPHY_CSS_VARS.bodyLine)).toBe(`${typographyMetrics().line.body}px`);
	});

	it("gives Mantine text the role's variables, never numbers of its own", () => {
		for (const style of Object.values(TYPE_ROLE_STYLE)) {
			for (const value of Object.values(style)) expect(value).toMatch(/^var\(--nf-type-/);
		}
		expect(TYPE_ROLE_STYLE.body.lineHeight).toBe(`var(${TYPOGRAPHY_CSS_VARS.bodyLine})`);
		// A permission card's textarea: xs text on the row the height model counts (D49).
		expect(TYPE_ROLE_STYLE.textarea.lineHeight).toBe(`var(${TYPOGRAPHY_CSS_VARS.xsBaseLine})`);
		expect(TYPE_ROLE_STYLE.textarea.fontSize).toBe(`var(${TYPOGRAPHY_CSS_VARS.xsSize})`);
	});
});
