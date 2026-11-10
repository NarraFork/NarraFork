/**
 * Task notices laid out by Chromium (PR-1): the measure pass predicts every card's height from
 * its line count alone (each line is a single truncated line), so the painted card must be
 * exactly that tall and nothing in it may spill past the box — folded and unfolded, at phone
 * width, and at a typography the reader enlarged (the line height follows `typographyMetrics`,
 * the badges do not). Also: no Markdown debris reaches the reader.
 *
 * 任务树可读性 PR B adds the updates of the current-tasks view that say what changed: their
 * heading is a sentence ("Finished “…”, started “…”, and 4 more") that keeps the folded line,
 * the counts come second, and unfolded the changed rows are marked. They are checked in zh-CN
 * and in English, light and dark, at 328 / 360 / 720 px. What is asserted about WIDTHS (a
 * heading cut or whole, how much of the line it takes) is asserted on the English fixture only:
 * its text is Latin, so it does not depend on a CJK font being installed where the test runs.
 *
 * NF_TASK_NOTICE_SHOTS=<dir> also writes a screenshot of each case there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./task-notice.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_TASK_NOTICE_SHOTS;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "task-notice.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("fixture bundle missing");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const html = `<!doctype html><html><head><meta charset="utf-8">${styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	page = await browser.newPage();
	await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
	await page.goto(`http://127.0.0.1:${server.port}/`);
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture, {
		timeout: 20_000,
	});
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

/** The task's title on a folded line keeps at least this much width, at any width tested. */
const MIN_TASK_WIDTH = 48;

const ENLARGED = { fontScalePercent: 130, lineHeightScalePercent: 120 } as const;

/** Index of the first of the five notices that say what changed (after the eight older cards). */
const CHANGES_AT = 8;

/** What the change notices read as, per language. */
const COPY = {
	"zh-CN": {
		changed: "完成『补并发回归测试』，开始『修刷新令牌的竞态』，另有 4 项变化",
		one: "开始『修刷新令牌的竞态』",
		refreshed: "任务列表已刷新",
		first: "当前任务",
		emptied: "完成『补并发回归测试』",
		counts: "进行中 2 · 等待 1 · 待办 3",
		empty: "当前任务列表为空",
		statuses: ["进行中", "完成", "待办", "待办", "进行中", "进行中", "进行中", "等待中", "待办"],
		note: "新加",
	},
	en: {
		changed: "Finished “Add the regression tests”, started “Fix the refresh race”, and 4 more",
		one: "Started “Fix the refresh race”",
		refreshed: "Task list refreshed",
		first: "Current tasks",
		emptied: "Finished “Add the regression tests”",
		counts: "2 in progress · 1 waiting · 3 to do",
		empty: "The current task list is empty",
		statuses: [
			"In progress",
			"Done",
			"To do",
			"To do",
			"In progress",
			"In progress",
			"In progress",
			"Waiting",
			"To do",
		],
		note: "added",
	},
} as const;

/**
 * The notices that say what changed (`cards` from {@link CHANGES_AT} on): the sentence, the
 * counts, the marked rows; in English also how the folded line shares its width.
 */
function expectChangeNotices(all: Fixture.CardReport[], options: Fixture.FixtureOptions): void {
	const locale = options.locale ?? "zh-CN";
	const copy = COPY[locale];
	const [changed, one, refreshed, first, emptied] = all.slice(CHANGES_AT);
	if (!changed || !one || !refreshed || !first || !emptied)
		throw new Error("change notices missing");
	expect([changed.title, one.title, refreshed.title, first.title, emptied.title]).toEqual([
		copy.changed,
		copy.one,
		copy.refreshed,
		copy.first,
		copy.emptied,
	]);
	// A list that was only refreshed asks nothing of the reader: no emphasis on its heading.
	expect([changed.titleWeight, refreshed.titleWeight, first.titleWeight]).toEqual([
		"600",
		"400",
		"600",
	]);
	// A sentence the line may cut is whole in its tooltip; the plain headings carry none.
	expect(changed.titleTooltip).toBe(copy.changed);
	expect(first.titleTooltip).toBeNull();
	// The inner width the card lays its line out in (the shell's narrow rule reads the same).
	const narrow = options.width - 20 < 420;
	if (options.expanded) {
		for (const card of [changed, one, refreshed, first, emptied]) {
			expect({ title: card.title, rows: card.rows }).toEqual({
				title: card.title,
				rows: card.measuredRows,
			});
		}
		// The finished task and the new to-do first, then the list; four of them changed.
		expect(changed.rows).toBe(7);
		expect(changed.statuses).toEqual([...copy.statuses]);
		expect(changed.changedRows).toBe(4);
		expect(changed.paintedMarks).toBe(4);
		expect(changed.text).toContain(copy.note);
		// Marked or not, the rows of one card start at the same inset.
		expect(new Set(changed.rowInsets).size).toBe(1);
		expect(changed.rowInsets[0]).toBeGreaterThan(0);
		expect(one.changedRows).toBe(1);
		// Nothing changed: no row is marked, and the rows keep the edge they always had.
		for (const card of [refreshed, first]) {
			expect(card.changedRows).toBe(0);
			expect(card.paintedMarks).toBe(0);
			expect(new Set(card.rowInsets)).toEqual(new Set([0]));
		}
		// The last task finished: its one row is worth unfolding for.
		expect(emptied.rows).toBe(1);
		expect(emptied.changedRows).toBe(1);
		return;
	}
	for (const card of [changed, one, refreshed, first, emptied]) expect(card.rows).toBe(0);
	// The folded line of a change notice names no task of its own (the sentence does): the first
	// view of an epoch still does, as every view row did.
	expect(changed.foldedTaskWidth).toBe(-1);
	expect(first.foldedTaskWidth).toBeGreaterThanOrEqual(MIN_TASK_WIDTH);
	// The counts are in the line for whoever can see them, in words; whether they are DRAWN is
	// a matter of room (below, on Latin text).
	expect([changed.leadText, one.leadText, refreshed.leadText, emptied.leadText]).toEqual([
		copy.counts,
		copy.counts,
		copy.counts,
		copy.empty,
	]);
	// Never a stub: counts that are drawn are drawn whole (the others wrap out of the line).
	for (const card of [changed, one, refreshed, emptied]) expect(card.leadTruncated).toBe(false);
	if (locale !== "en") return;
	// Widths, on Latin text only (see the file's header).
	const enlarged = (options.fontScalePercent ?? 100) > 100;
	if (narrow) {
		// A phone: the long sentence is cut by the line it fills (far past the 45% a heading
		// beside a task is held to) and leaves the counts no room; the short heading of a
		// refreshed list stands whole.
		expect(changed.titleTruncated).toBe(true);
		expect(changed.titleWidth).toBeGreaterThan(changed.width * 0.7);
		expect(changed.leadShown).toBe(false);
		expect(refreshed.titleTruncated).toBe(false);
	} else if (!enlarged) {
		// Room for the sentence: it is whole and wider than the old cap. The counts come after
		// a heading that leaves them room, whole.
		expect(changed.titleTruncated).toBe(false);
		expect(changed.titleWidth).toBeGreaterThan(changed.width * 0.45);
		expect(one.titleTruncated).toBe(false);
		expect(one.leadShown).toBe(true);
		expect(refreshed.leadShown).toBe(true);
	}
	// A heading beside a task keeps giving way to it, as before.
	expect(first.titleWidth).toBeLessThanOrEqual(Math.ceil(first.width * 0.45));
}

const CASES: Array<{ name: string; options: Fixture.FixtureOptions }> = [
	{ name: "folded-720-dark", options: { width: 720, expanded: false, scheme: "dark" } },
	{ name: "folded-360-dark", options: { width: 360, expanded: false, scheme: "dark" } },
	{ name: "folded-328-light", options: { width: 328, expanded: false, scheme: "light" } },
	{
		name: "folded-360-enlarged",
		options: {
			width: 360,
			expanded: false,
			scheme: "dark",
			fontScalePercent: 130,
			lineHeightScalePercent: 120,
		},
	},
	{
		name: "folded-328-enlarged",
		options: {
			width: 328,
			expanded: false,
			scheme: "dark",
			fontScalePercent: 130,
			lineHeightScalePercent: 120,
		},
	},
	{
		name: "folded-720-enlarged",
		options: {
			width: 720,
			expanded: false,
			scheme: "dark",
			fontScalePercent: 130,
			lineHeightScalePercent: 120,
		},
	},
	{ name: "unfolded-720-light", options: { width: 720, expanded: true, scheme: "light" } },
	{ name: "unfolded-360-dark", options: { width: 360, expanded: true, scheme: "dark" } },
	{
		name: "unfolded-720-enlarged",
		options: {
			width: 720,
			expanded: true,
			scheme: "dark",
			fontScalePercent: 130,
			lineHeightScalePercent: 120,
		},
	},
	// English (Latin text: the width assertions of the change notices run on these).
	{
		name: "en-folded-720-light",
		options: { width: 720, expanded: false, scheme: "light", locale: "en" },
	},
	{
		name: "en-folded-720-dark",
		options: { width: 720, expanded: false, scheme: "dark", locale: "en" },
	},
	{
		name: "en-folded-360-light",
		options: { width: 360, expanded: false, scheme: "light", locale: "en" },
	},
	{
		name: "en-folded-328-dark",
		options: { width: 328, expanded: false, scheme: "dark", locale: "en" },
	},
	{
		name: "en-folded-328-enlarged",
		options: { width: 328, expanded: false, scheme: "light", locale: "en", ...ENLARGED },
	},
	{
		name: "en-folded-720-enlarged",
		options: { width: 720, expanded: false, scheme: "dark", locale: "en", ...ENLARGED },
	},
	{
		name: "en-unfolded-720-dark",
		options: { width: 720, expanded: true, scheme: "dark", locale: "en" },
	},
	{
		name: "en-unfolded-360-light",
		options: { width: 360, expanded: true, scheme: "light", locale: "en" },
	},
	{
		name: "en-unfolded-328-dark",
		options: { width: 328, expanded: true, scheme: "dark", locale: "en" },
	},
	{
		name: "en-unfolded-328-enlarged",
		options: { width: 328, expanded: true, scheme: "light", locale: "en", ...ENLARGED },
	},
	// zh-CN at the widths and schemes the older cases leave out.
	{ name: "folded-720-light", options: { width: 720, expanded: false, scheme: "light" } },
	{ name: "unfolded-328-light", options: { width: 328, expanded: true, scheme: "light" } },
];

for (const { name, options } of CASES) {
	test(`task notices: painted as measured, nothing spills (${name})`, async () => {
		await page.evaluate(
			(o) => (window as unknown as FixtureWindow).fixture.render(o),
			options as never,
		);
		const cards = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
		// Written before anything is asserted, so a failing case leaves its picture.
		if (shots) {
			mkdirSync(shots, { recursive: true });
			const shot = await page.$("#shot");
			await shot?.screenshot({ path: join(shots, `task-notice-${name}.png`) });
		}
		expect(cards.map((card) => card.kind)).toEqual([
			"tasks_notice",
			"tasks_notice",
			"tasks_notice",
			"tasks_notice",
			"tasks_notice",
			"origin_notice",
			"tasks_notice",
			"tasks_notice",
			// 任务树可读性 PR B: the view's updates that say what changed.
			"tasks_notice",
			"tasks_notice",
			"tasks_notice",
			"tasks_notice",
			"tasks_notice",
		]);
		for (const card of cards) {
			expect({ kind: card.kind, painted: card.painted }).toEqual({
				kind: card.kind,
				painted: card.measured,
			});
			expect(card.content).toBeLessThanOrEqual(card.painted);
			// Nor into its padding: the measure pass reserved every line, at this typography.
			expect(card.spill).toBeLessThanOrEqual(0.5);
			expect(card.scrollWidth).toBeLessThanOrEqual(card.width);
			expect(card.lineOverflow).toBeLessThanOrEqual(0.5);
			// No Markdown reaches the reader.
			expect(card.text).not.toContain("######");
			expect(card.text).not.toContain("\\");
			expect(card.text).not.toContain("`");
		}
		expectChangeNotices(cards, options);
		// The older cards' copy is asserted in zh-CN (their fixture text is Chinese).
		if ((options.locale ?? "zh-CN") !== "zh-CN") return;
		// The interrupt guard keeps its close button in its heading line.
		expect(cards[2]?.closeButtons).toBe(1);
		// Outline P2 PR 9b. The view with tasks the session's subagents are doing: unfolded, each
		// of them carries the 「委派中」 chip, after the work in progress; folded, the line counts
		// them where it has room for its tail. The notice of tasks finished elsewhere is titled by
		// who finished them, each row its status change.
		const [delegated, finished] = [cards[6], cards[7]];
		expect(finished?.title).toBe("发布准备 结束了本会话建的 3 个任务");
		if (options.expanded) {
			expect(delegated?.statuses).toEqual(["进行中", "委派中", "委派中", "等待中", "待办"]);
			expect(delegated?.text).toContain("修复刷新令牌的竞态");
			expect(delegated?.text).toContain("给重试按钮补端到端用例");
			expect(finished?.statuses).toEqual(["进行中", "完成"]);
		} else if (options.width >= 420) {
			expect(delegated?.text).toContain("委派中 2");
		}
		if (options.expanded) {
			// Unfolded cards are taller than one line; the folded ones are all one line.
			expect(cards[1]?.measured).toBeGreaterThan(cards[4]?.measured ?? 0);
		} else {
			const tallest = Math.max(...cards.slice(0, 5).map((card) => card.measured));
			expect(tallest).toBe(cards[4]?.measured);
			// Every folded line that names a task still shows it, at phone width too. (The fifth
			// card, an empty list, names none.)
			for (const card of cards.slice(0, 4)) {
				expect({ text: card.text.slice(0, 24), width: card.foldedTaskWidth }).toEqual({
					text: card.text.slice(0, 24),
					width: expect.any(Number),
				});
				expect(card.foldedTaskWidth).toBeGreaterThanOrEqual(MIN_TASK_WIDTH);
			}
			expect(cards[4]?.foldedTaskWidth).toBe(-1);
			// No lead is cut to a stub ("2…"): beside a task it is left out on a phone, and shown
			// whole on a wider line.
			for (const card of cards) expect(card.leadTruncated).toBe(false);
			if (options.width >= 420) {
				expect(cards[2]?.lead).toBe(true);
				// The turn-end tail ("还没勾成完成") stays readable beside its long title: the title
				// is truncated first.
				const turnEnd = cards[0];
				expect(turnEnd?.tailWidth ?? -1).toBeGreaterThanOrEqual(2 * (turnEnd?.tailFontPx ?? 0));
			} else {
				expect(cards[2]?.lead).toBe(false);
				expect(cards[0]?.tailWidth).toBe(-1);
			}
		}
	});
}
