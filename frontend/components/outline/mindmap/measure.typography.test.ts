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
import { parseToPM } from "../editor/convert";

beforeAll(() => {
	installCanvasStub();
});

const {
	bodySize,
	checkIconPx,
	clearMeasureCache,
	frameTail,
	frameWidth,
	hasMeasured,
	MAP_FONT_FAMILY,
	mapType,
	measureBody,
	measureKey,
	measureStats,
	storeMeasured,
	NODE,
	nodeSize,
} = await import("./measure");

beforeEach(() => {
	resetTypographyForTest();
	clearMeasureCache();
});

const plain = (ref: string, label: string | null) => label ?? ref;
// Tests explicitly exercise the same pure core that production runs only in the Worker.
const measuredSize = (content: string) => measureBody(parseToPM(content).node);
const LARGER = { fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 };

describe("mind-map node typography", () => {
	it("serves cold bodies as fixed placeholders without exact measuring or caching fake sizes", () => {
		const before = measureStats.misses;
		const cold = bodySize("## [[target|标题]] `code` Mixed 文本".repeat(100), plain);
		expect(cold).toEqual({ w: NODE.maxBody, h: mapType().lineH });
		expect(bodySize("short")).toEqual(cold);
		expect(hasMeasured("short")).toBe(false);
		expect(measureStats.misses).toBe(before);
		const key = measureKey("short", plain).key;
		storeMeasured([[key, 80, 48]]);
		expect(bodySize("short")).toEqual({ w: 80, h: 48 });
		expect(measureStats.misses).toBe(before);
	});

	it("collects mention dependencies without parsing and resolves by identity, not position", () => {
		const { labels } = measureKey(
			"`[[fake]]` [[a\\*b|甲]] [[real|乙]]",
			(ref, label) => `${ref}:${label}`,
		);
		expect(labels[JSON.stringify(["a*b", "甲"])]).toBe("a*b:甲");
		expect(labels[JSON.stringify(["real", "乙"])]).toBe("real:乙");
	});

	it("measures with the conversation's body and code metrics", () => {
		const m = typographyMetrics();
		const t = mapType();
		expect(t.px).toBe(m.size.sm);
		expect(t.lineH).toBe(m.line.body);
		expect(t.lineH).toBe(24); // the default line box: the old 120%
		expect(t.codeFont).toContain(`${m.size.xs}px`);
		expect(t.codeBlockFont).toContain(`${m.codeSize}px`);
		expect(t.codeBlockLineH).toBe(m.line.code);
	});

	it("measures a heading inside a node as body text in bold: never larger than a task's title", () => {
		const t = mapType();
		// The conversation's headings are larger than its body: that size is not used here.
		expect(headingMetrics(1).size).toBeGreaterThan(t.px);
		for (const level of [1, 2, 3]) {
			const heading = measuredSize(`${"#".repeat(level)} Delivery and conclusions`);
			expect(heading.h).toBe(t.lineH);
			// The same width as the same words in bold body text, whatever the level.
			expect(heading.w).toBe(measuredSize("**Delivery and conclusions**").w);
		}
	});

	it("gives a one-line body, a heading and a code block their line boxes", () => {
		const t = mapType();
		expect(measuredSize("短句 short").h).toBe(t.lineH);
		expect(measuredSize("## 结论").h).toBe(t.lineH);
		expect(measuredSize("```\na\nb\n```").h).toBe(2 * t.codeBlockLineH + 8);
		// A node is never shorter than one body line plus its frame.
		expect(nodeSize({ w: 10, h: 0 }, false).h).toBe(NODE.padY * 2 + t.lineH + NODE.border * 2);
	});

	it("measures a task's checkbox column as CSS draws it: the icon follows the body size", () => {
		// `--nf-outline-icon` (outline-icons.css): body + 2, between 12 and 24 (16 by default).
		expect(checkIconPx()).toBe(16);
		expect(frameWidth(false)).toBe(NODE.gutter);
		// One marker: a task's checkbox column stands where the bullet would be, after the arrow.
		expect(frameWidth(true)).toBe(NODE.part + 16 + NODE.checkGap);
		expect(frameWidth(true)).toBe(frameWidth(false) - NODE.part + 16 + NODE.checkGap);
		// The focus handle the bullet would be follows a task's body.
		expect(frameTail(false)).toBe(0);
		expect(frameTail(true)).toBe(NODE.part);
		const widthOf = (task: boolean) => nodeSize({ w: 100, h: 0 }, task).w;
		expect(widthOf(true) - widthOf(false)).toBe(16 + NODE.checkGap);
		setTypography(LARGER);
		expect(checkIconPx()).toBeCloseTo(mapType().px + 2, 10);
		setTypography({ fontScalePercent: 180 });
		expect(checkIconPx()).toBe(24);
		setTypography({ fontScalePercent: 70 });
		expect(checkIconPx()).toBe(12);
	});

	it("follows a change of setting at measure time", () => {
		const before = measuredSize("背景：用户中断回合后没有重试按钮。Mixed English 与中文混排。");
		setTypography(LARGER);
		const t = mapType();
		expect(t.px).toBeCloseTo(16.1, 10);
		expect(t.lineH).toBe(typographyMetrics().line.body);
		const after = measuredSize("背景：用户中断回合后没有重试按钮。Mixed English 与中文混排。");
		expect(after.h % t.lineH).toBe(0);
		expect(after.h).toBeGreaterThan(before.h);
	});

	it("counts letter spacing once per grapheme, the last one included, as CSS does", async () => {
		const { measureRichInlineStats, prepareRichInline } = await import(
			"@chenglou/pretext/rich-inline"
		);
		const text = "letter spacing 字距";
		setTypography({ letterSpacingPercent: 10 });
		const font = `${mapType().px}px ${MAP_FONT_FAMILY}`;
		const spacing = 1.4; // 10% of 14px
		const spaced = measureRichInlineStats(
			prepareRichInline([{ text, font, letterSpacing: spacing }]),
			10_000,
		).maxLineWidth;
		const unspaced = measureRichInlineStats(prepareRichInline([{ text, font }]), 10_000);
		// pretext already adds a unit after every grapheme, the last one too (its
		// `lineEndFitAdvance`): exactly CSS `letter-spacing`…
		expect(spaced - unspaced.maxLineWidth).toBeCloseTo([...text].length * spacing, 5);
		// …so a node measures what pretext measures, with nothing added on top (adding the
		// trailing unit again made nodes taller or shorter than drawn).
		expect(measuredSize(text).w).toBeCloseTo(spaced, 5);
		setTypography({ letterSpacingPercent: -5 });
		const tight = measureRichInlineStats(
			prepareRichInline([{ text, font, letterSpacing: -0.7 }]),
			10_000,
		).maxLineWidth;
		expect(measuredSize(text).w).toBeCloseTo(tight, 5);
	});

	it("measures a code block line with the same spacing arithmetic", async () => {
		const { measureNaturalWidth, prepareWithSegments } = await import("@chenglou/pretext");
		setTypography({ letterSpacingPercent: 10 });
		const line = "const canRetry = true;";
		const font = mapType().codeBlockFont;
		const natural = measureNaturalWidth(
			prepareWithSegments(line, font, { letterSpacing: 1.1 }), // 10% of 11px
		);
		expect(measuredSize(`\`\`\`\n${line}\n\`\`\``).w).toBeCloseTo(
			Math.min(NODE.maxBody, natural + 16),
			5,
		);
	});

	it("adds nothing to a word kept with its CJK closing punctuation, at any letter spacing", async () => {
		const { measureRichInlineStats, prepareRichInline } = await import(
			"@chenglou/pretext/rich-inline"
		);
		// Short enough for one line: the node is exactly as wide as the text, with no extra
		// spaced grapheme (a zero-width joiner before `；` was counted as one).
		const text = "接 aborted；继续 abc）好";
		for (const letterSpacingPercent of [-5, 25]) {
			setTypography({ letterSpacingPercent });
			const font = `${mapType().px}px ${MAP_FONT_FAMILY}`;
			const letterSpacing = (mapType().px * letterSpacingPercent) / 100;
			const plainWidth = measureRichInlineStats(
				prepareRichInline([{ text, font, letterSpacing }]),
				10_000,
			).maxLineWidth;
			expect(measuredSize(text).w).toBeCloseTo(plainWidth, 5);
		}
	});

	it("moves a chip right after punctuation to the next line whole, as the browser does", async () => {
		const { measureRichInlineStats, prepareRichInline } = await import(
			"@chenglou/pretext/rich-inline"
		);
		// The stub gives every character 0.6 em: 8.4 px in the 14 px body, 7.2 px in 12 px code.
		// 28 characters (235.2 px) leave room for `cod` but not `code` on the first line.
		const before = `${"中".repeat(27)}：`;
		const after = ` ${"文".repeat(27)}`;
		const t = mapType();
		const sans = `${t.px}px ${MAP_FONT_FAMILY}`;
		// rich-inline alone fills the first line with `cod`, and the rest fits on a second line…
		const split = measureRichInlineStats(
			prepareRichInline([
				{ text: before, font: sans },
				{ text: "code", font: t.codeFont, extraWidth: 6 },
				{ text: after, font: sans },
			]),
			NODE.maxBody,
		);
		expect(split.lineCount).toBe(2);
		// …while the browser wraps before `code`: the second line then overflows into a third.
		expect(measuredSize(`${before}\`code\`${after}`).h).toBe(3 * t.lineH);
	});

	it("leaves the punctuation after a chip wider than a line in the text", async () => {
		const { measureRichInlineStats, prepareRichInline } = await import(
			"@chenglou/pretext/rich-inline"
		);
		// A chip with no space that is wider than a line wraps anywhere in the browser: its
		// punctuation is not a width reserved on every line it spans (that cost a line here).
		const chip = "a".repeat(63);
		const tail = "，后接中文。";
		const t = mapType();
		const sans = `${t.px}px ${MAP_FONT_FAMILY}`;
		const asText = measureRichInlineStats(
			prepareRichInline([
				{ text: chip, font: t.codeFont, extraWidth: 6 },
				{ text: tail, font: sans },
			]),
			NODE.maxBody,
		);
		expect(asText.lineCount).toBe(2);
		expect(measuredSize(`\`${chip}\`${tail}`).h).toBe(2 * t.lineH);
	});

	it("keys the cache by the setting, and drops it when the setting changes", () => {
		const key = measureKey("同一段文字", plain).key;
		storeMeasured([[key, 100, 24]]);
		expect(hasMeasured("同一段文字")).toBe(true);
		setTypography(LARGER);
		expect(measureKey("同一段文字", plain).key).not.toBe(key);
		expect(hasMeasured("同一段文字")).toBe(false);
		// Mentions keep their own part of the key after the setting's.
		expect(measureKey("见 [[a1|甲]]", plain).key).toContain("甲");
	});
});
