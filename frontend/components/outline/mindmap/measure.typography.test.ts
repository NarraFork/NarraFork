/**
 * Mind-map nodes are measured with the conversation's typography (外观 · 排版): the body,
 * heading, inline-code and code-block metrics the transcript measures with, at MEASURE time.
 * `mindmap.css` paints nodes with the same values (the `--nf-type-*` variables), so a node is
 * drawn at the size it was measured; the browser test (`OutlineTypography.browser.test.ts`)
 * checks the paint, this checks the inputs.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { headingMetrics, typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { installCanvasStub } from "../../narrator/vlist/measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const {
	bodySize,
	clearMeasureCache,
	hasMeasured,
	MAP_FONT_FAMILY,
	mapType,
	measureKey,
	NODE,
	nodeSize,
} = await import("./measure");

beforeEach(() => {
	resetTypographyForTest();
	clearMeasureCache();
});

const plain = (ref: string, label: string | null) => label ?? ref;
const LARGER = { fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 };

describe("mind-map node typography", () => {
	it("measures with the conversation's body, heading and code metrics", () => {
		const m = typographyMetrics();
		const t = mapType();
		expect(t.px).toBe(m.size.sm);
		expect(t.lineH).toBe(m.line.body);
		expect(t.lineH).toBe(24); // the default line box: the old 120%
		expect(t.codeFont).toContain(`${m.size.xs}px`);
		expect(t.codeBlockFont).toContain(`${m.codeSize}px`);
		expect(t.codeBlockLineH).toBe(m.line.code);
		for (const level of [1, 2, 3] as const) {
			expect(t.heading[level]).toEqual({
				px: headingMetrics(level).size,
				lineH: headingMetrics(level).lineHeight,
			});
		}
	});

	it("gives a one-line body, a heading and a code block their line boxes", () => {
		const t = mapType();
		expect(bodySize("短句 short").h).toBe(t.lineH);
		expect(bodySize("## 结论").h).toBe(t.heading[2].lineH);
		expect(bodySize("```\na\nb\n```").h).toBe(2 * t.codeBlockLineH + 8);
		// A node is never shorter than one body line plus its frame.
		expect(nodeSize({ w: 10, h: 0 }, false).h).toBe(NODE.padY * 2 + t.lineH + NODE.border * 2);
	});

	it("follows a change of setting at measure time", () => {
		const before = bodySize("背景：用户中断回合后没有重试按钮。Mixed English 与中文混排。");
		setTypography(LARGER);
		const t = mapType();
		expect(t.px).toBeCloseTo(16.1, 10);
		expect(t.lineH).toBe(typographyMetrics().line.body);
		const after = bodySize("背景：用户中断回合后没有重试按钮。Mixed English 与中文混排。");
		expect(after.h % t.lineH).toBe(0);
		expect(after.h).toBeGreaterThan(before.h);
	});

	it("reserves the trailing letter spacing CSS adds to every line fragment", async () => {
		const { measureRichInlineStats, prepareRichInline } = await import(
			"@chenglou/pretext/rich-inline"
		);
		const text = "letter spacing 字距";
		setTypography({ letterSpacingPercent: 10 });
		const font = `${mapType().px}px ${MAP_FONT_FAMILY}`;
		const spacing = 1.4; // 10% of 14px
		// pretext spaces BETWEEN graphemes; CSS also after the last one of each line.
		const pretextOnly = measureRichInlineStats(
			prepareRichInline([{ text, font, letterSpacing: spacing }]),
			10_000,
		).maxLineWidth;
		const unspaced = measureRichInlineStats(prepareRichInline([{ text, font }]), 10_000);
		expect(pretextOnly).toBeGreaterThan(unspaced.maxLineWidth);
		expect(bodySize(text).w).toBeCloseTo(pretextOnly + spacing, 5);
	});

	it("keys the cache by the setting, and drops it when the setting changes", () => {
		const key = measureKey("同一段文字", plain).key;
		bodySize("同一段文字");
		expect(hasMeasured("同一段文字")).toBe(true);
		setTypography(LARGER);
		expect(measureKey("同一段文字", plain).key).not.toBe(key);
		expect(hasMeasured("同一段文字")).toBe(false);
		// Mentions keep their own part of the key after the setting's.
		expect(measureKey("见 [[a1|甲]]", plain).key).toContain("甲");
	});
});
