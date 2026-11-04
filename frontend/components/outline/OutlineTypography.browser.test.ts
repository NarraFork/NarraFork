/**
 * The outline uses the conversation's typography (owner decision: 「大纲照搬对话的数值」), in
 * Chromium, against the real outline routes and live sessions.
 *
 * For the default setting and for 115% font / 110% line height / +2% letter spacing:
 *
 *   - the live editor, the mind map's nodes and the read-only tree (history) paint each role —
 *     body, page title, headings, inline code, code block — with exactly the size, line box and
 *     letter spacing the transcript measures that role with (`typographyMetrics()` /
 *     `headingMetrics()`, read in the page);
 *   - the mind map, which measures its nodes with pretext before drawing them, draws every node
 *     at the height it measured (`nodeAccuracy`) and no node's text overflows its box — including
 *     after the setting changed while the page was open (cache keys, Worker requests and the
 *     line box all follow the setting).
 *
 * Mixed Chinese/English text throughout. With `NF_TYPOGRAPHY_SHOTS=<dir>` set, the editor, the
 * map and the tree are also saved as screenshots in both themes.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { eq, max } from "drizzle-orm";
import { db } from "../../../server/db";
import { outlineCommits } from "../../../server/db/schema";
import { seedPage } from "./editor/outline-live-harness.browser-fixture";
import {
	type MapEditor,
	type MapHarness,
	openHost,
	resetMap,
	settled,
	startMapHarness,
	stopMapHarness,
} from "./outline-mindmap-harness.browser-fixture";

let h: MapHarness;

beforeAll(async () => {
	h = await startMapHarness();
}, 60_000);

afterAll(async () => {
	await stopMapHarness(h);
});

afterEach(async () => {
	await resetMap(h);
});

const SHOTS = process.env.NF_TYPOGRAPHY_SHOTS;

const LINES = [
	"背景：用户中断回合后，消息气泡上没有「重试」按钮，只能重新输入。Mixed English 与中文混排，一句足够长的话用来观察换行后的行距是否舒适。",
	"## 结论与后续",
	"[ ] 修复：排查中断后无重试按钮（只读，不改代码）",
	"  根因：中断后 `status` 停在 `aborted`，重试按钮只在 `failed` 时显示",
	"  已提交并推送 fix/retry-after-interrupt（3 个文件，+42 −7），CI 绿",
	"[x] 复现：Anthropic 通道中断后刷新页面",
	'```ts\nconst canRetry = status === "failed" || status === "aborted";\n```',
	"重试按钮的显示条件改成 failed 或 aborted；aborted 时文案是「继续」。The label reads Continue.",
];

const SETTINGS = {
	default: { fontScalePercent: 100, lineHeightScalePercent: 100, letterSpacingPercent: 0 },
	larger: { fontScalePercent: 115, lineHeightScalePercent: 110, letterSpacingPercent: 2 },
} as const;

type Expected = Awaited<ReturnType<typeof expectedOf>>;

async function expectedOf(e: MapEditor) {
	return e.call((f) => f.expectedTypography());
}

async function frames(e: MapEditor, n = 3): Promise<void> {
	for (let i = 0; i < n; i++) await e.call((f) => f.afterPaint());
}

/** The computed style of `selector` is the role's: size, px line box and letter spacing. */
async function expectRole(
	e: MapEditor,
	selector: string,
	role: { size: number; line?: number; spacing?: number },
	label: string,
): Promise<void> {
	const got = await e.call((f, s) => f.computedType(s as never), selector);
	expect(got, `${label}: ${selector} not found`).not.toBeNull();
	if (!got) return;
	expect(got.size, `${label} font size`).toBeCloseTo(role.size, 2);
	if (role.line !== undefined) expect(got.line, `${label} line height`).toBe(role.line);
	if (role.spacing !== undefined) {
		expect(got.spacing, `${label} letter spacing`).toBeCloseTo(role.spacing, 2);
	}
}

async function shoot(e: MapEditor, name: string): Promise<void> {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	for (const scheme of ["light", "dark"] as const) {
		await e.page.evaluate(
			(s) => document.documentElement.setAttribute("data-mantine-color-scheme", s),
			scheme,
		);
		await frames(e, 2);
		await e.page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
	}
	await e.page.evaluate(() =>
		document.documentElement.setAttribute("data-mantine-color-scheme", "dark"),
	);
}

async function expectEditor(e: MapEditor, x: Expected): Promise<void> {
	const pm = ".nf-outline-editor .nf-outline-scroller .ProseMirror";
	await expectRole(e, `${pm} > .ob-block > .ob-content > :first-child`, x.h3, "title");
	await expectRole(e, `${pm} .ob-children .ob-block > .ob-content > p`, x.body, "body");
	await expectRole(e, `${pm} .ob-content h2`, x.h2, "heading");
	await expectRole(e, `${pm} .ob-content p code`, x.code, "inline code");
	await expectRole(e, `${pm} .ob-content pre`, x.codeBlock, "code block");
}

async function expectMap(e: MapEditor, x: Expected, label: string): Promise<void> {
	await e.call((f) => f.setView("map"));
	await settled(e);
	await e.call((f) => f.mapFit());
	await e.call((f) => f.mapFlush());
	await frames(e);
	await expectRole(e, ".mm-node .mm-body > p", x.body, `${label} node body`);
	await expectRole(e, ".mm-node .mm-body > h2", x.h2, `${label} node heading`);
	const accuracy = await e.call((f) => f.nodeAccuracy());
	expect(accuracy.checked, label).toBeGreaterThanOrEqual(LINES.length);
	// Measured with pretext, drawn by CSS: the same height, to the pixel.
	expect(accuracy.maxDiffH, `${label} measured vs drawn node height`).toBeLessThanOrEqual(1);
	expect(accuracy.overH, label).toBe(0);
	expect(await e.call((f) => f.nodeOverflow()), `${label} node text overflow`).toEqual([]);
}

async function seqOf(spaceId: string): Promise<number> {
	const [row] = await db
		.select({ seq: max(outlineCommits.seq) })
		.from(outlineCommits)
		.where(eq(outlineCommits.spaceId, spaceId));
	return Number(row?.seq ?? 0);
}

for (const [name, setting] of Object.entries(SETTINGS)) {
	test(`${name}: the editor, the map and the history tree paint the conversation's roles`, async () => {
		const { pageId } = await seedPage(h, "重试按钮排查", LINES);
		const e = await openHost(h, "page", pageId, { width: 960, height: 760 });
		await e.call((f, s) => f.applyTypography(s as never), setting);
		await frames(e);
		const x = await expectedOf(e);
		if (name === "default") {
			// The conversation's defaults, with the line box at the old 120%.
			expect(x.body).toEqual({ size: 14, line: 24, spacing: 0 });
			expect(x.h3).toMatchObject({ size: 22, line: 37 });
		} else {
			expect(x.body.size).toBeCloseTo(16.1, 5);
			expect(x.body.line).toBe(Math.round(16.1 * 1.45 * 1.32));
			expect(x.body.spacing).toBeCloseTo(16.1 * 0.02, 5);
		}

		await expectEditor(e, x);
		await shoot(e, `after-outline-editor-${name}`);

		await expectMap(e, x, name);
		await shoot(e, `after-outline-map-${name}`);

		// History (as of the seeding commit): the read-only tree, with the same values.
		await e.call((f) => f.setView("outline"));
		await settled(e);
		const seq = await seqOf(h.space.id);
		await e.call((f, s) => f.showAsOf(s as never), seq);
		await e.page.waitForSelector("[data-block-id] .nf-type-scope", { timeout: 10_000 });
		await frames(e);
		await expectRole(e, ".nf-type-scope h3", x.h3, "tree title");
		await expectRole(e, "[data-block-id] .nf-type-scope", x.body, "tree body");
		await expectRole(e, "[data-block-id] .nf-type-scope h2", x.h2, "tree heading");
		await expectRole(e, "[data-block-id] .nf-type-scope code", x.code, "tree inline code");
		await shoot(e, `after-outline-tree-${name}`);
		expect(e.errors).toEqual([]);
	}, 90_000);
}

test("changing the setting with the map open re-measures every node (no stale size is drawn)", async () => {
	const { pageId } = await seedPage(h, "重试按钮排查", LINES);
	const e = await openHost(h, "page", pageId, { width: 960, height: 760 });
	await expectMap(e, await expectedOf(e), "before the change");
	// As a slider drag does: the setting moves while the map is on screen.
	await e.call((f, s) => f.applyTypography(s as never), SETTINGS.larger);
	await e.call((f) => f.mapFlush());
	await frames(e);
	await expectMap(e, await expectedOf(e), "after the change");
	// And back: the sizes measured under the first setting are not served again stale.
	await e.call((f, s) => f.applyTypography(s as never), SETTINGS.default);
	await e.call((f) => f.mapFlush());
	await frames(e);
	await expectMap(e, await expectedOf(e), "back to the default");
	expect(e.errors).toEqual([]);
}, 90_000);

test("a change of setting measures the page ahead again, so the next switch to the map finds the sizes", async () => {
	const { pageId } = await seedPage(h, "重试按钮排查", LINES);
	const e = await openHost(h, "page", pageId, { width: 960, height: 760 });
	await e.call((f) => f.prewarmDone());
	const posted = (await e.call((f) => f.mapStats())).prewarm.posted;
	// In the outline view, as from the 外观 panel: once the setting is still, the Worker is sent
	// every body again under the new setting.
	await e.call((f, s) => f.applyTypography(s as never), SETTINGS.larger);
	await e.page.waitForFunction(
		(n) =>
			(
				window as unknown as { fixture: { mapStats(): { prewarm: { posted: number } } } }
			).fixture.mapStats().prewarm.posted >= n,
		{ timeout: 5_000, polling: 50 },
		posted + LINES.length,
	);
	await e.call((f) => f.prewarmDone());
	const misses = (await e.call((f) => f.mapStats())).measure.misses;
	await e.call((f) => f.setView("map"));
	await settled(e);
	await e.call((f) => f.mapFlush());
	// Laid out from the Worker's sizes: nothing measured on the main thread…
	expect((await e.call((f) => f.mapStats())).measure.misses).toBe(misses);
	// …and they are the sizes for the new setting.
	await expectMap(e, await expectedOf(e), "after the Worker re-measured");
	expect(e.errors).toEqual([]);
}, 90_000);

/**
 * Texts where the map's measurement and the browser's line breaking can part ways: punctuation
 * the browser keeps on a chip's line (closing after, opening before), a body that starts with a
 * chip, bold and italic runs next to punctuation, headings, a code block.
 */
const SWEEP_LINES = [
	"根因：中断后 `status` 停在 `aborted`，重试按钮只在 `failed` 时显示",
	"`inline code at the start` then 中文混排继续写一段足够长的话，看换行。",
	"（`status`）在括号里，`aborted`。结尾也有「`failed`」和 `x`, `y`; `z`!",
	"**加粗**，接着是*斜体*。Mixed, punctuation; after: runs! 还有（括号）与「引号」。",
	"重试按钮的显示条件改成 failed 或 aborted；aborted 时文案是「继续」。The label reads Continue.",
	"## 结论与后续",
	"# 一级标题 with English words that wrap around",
	"### 三级标题：`code` 在标题里",
	'```ts\nconst canRetry = status === "failed" || status === "aborted";\nreturn canRetry;\n```',
	"背景：用户中断回合后，消息气泡上没有「重试」按钮，只能重新输入。Mixed English 与中文混排。",
];

test("every node is drawn at its measured height across font × letter spacing × line height", async () => {
	const { pageId } = await seedPage(h, "排版扫描 sweep", SWEEP_LINES);
	const e = await openHost(h, "page", pageId, { width: 1600, height: 1200 });
	await e.call((f) => f.setView("map"));
	await settled(e);
	const failures: string[] = [];
	let checked = 0;
	for (const fontScalePercent of [70, 100, 115, 130, 180]) {
		for (const letterSpacingPercent of [-5, 0, 2, 10, 25]) {
			for (const lineHeightScalePercent of [60, 100, 185]) {
				const setting = { fontScalePercent, letterSpacingPercent, lineHeightScalePercent };
				await e.call((f, s) => f.applyTypography(s as never), setting);
				// Skip the settle wait (the Worker round trip): every node is measured now.
				await e.call((f) => f.mapTypographySettled());
				await e.call((f) => f.mapFit());
				await e.call((f) => f.mapFlush());
				const accuracy = await e.call((f) => f.nodeAccuracy());
				// At the line-height floor (72% of the Mantine ratios) a heading's line box is smaller
				// than its font's content box (h1: 1.3 × 0.72 < 1), as the transcript's old floor
				// allowed too: the content box overhangs the node by a few px there although the
				// node is exactly its measured height. Horizontal overflow is checked everywhere.
				const overflow = (await e.call((f) => f.nodeOverflow())).filter(
					(o) => o.overW > 0 || (lineHeightScalePercent >= 100 && o.overH > 0),
				);
				checked += accuracy.checked;
				if (accuracy.maxDiffH > 1 || accuracy.overH > 0 || overflow.length > 0) {
					failures.push(
						`${JSON.stringify(setting)}: maxDiffH ${accuracy.maxDiffH}, ${accuracy.overH} off, overflow ${JSON.stringify(overflow)}`,
					);
				}
			}
		}
	}
	// Every node of every setting was on screen and checked.
	expect(checked).toBe(75 * (SWEEP_LINES.length + 1));
	expect(failures).toEqual([]);
	expect(e.errors).toEqual([]);
}, 180_000);
