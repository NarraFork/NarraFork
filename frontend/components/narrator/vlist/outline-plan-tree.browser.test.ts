/**
 * An outline plan's ExitPlanMode card laid out by Chromium (plan readability), in the owner's
 * format: by default the reader sees the title, the background paragraph whole under it, the big
 * and small points, each small point's implementation details as ONE preview line (its first
 * detail's first line, an ellipsis and 「还有 N 条 ▸」), and the notable points whole. A preview
 * line, a row's quick control, Alt+click or Alt+Enter on an arrow open everything inside a node
 * and close it again; the arrow opens one level; 「全部展开 / 全部收起」 the whole plan. At every
 * step the card is exactly as tall as the measure said — after an approval too, with the
 * approval form under the plan — in English and Chinese, light and dark, at 720 and 360 px (no
 * sideways scroll on a phone), and at a typography the reader enlarged. A plan written before
 * the format gets the same depth rules; the inbox's DOM tree shows the same view.
 *
 * NF_PLAN_TREE_SHOTS=<dir> also writes a screenshot of each case there (and of the old card).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { serializeMarkdownOutline } from "@shared/outline";
import { parseMarkdownOutline } from "@shared/outline/md-outline";
import { NOTABLE_POINTS_TITLE, planStructureIssues } from "@shared/outline-plan-structure";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./outline-plan-tree.browser-fixture";
import { FORMAT_EN, FORMAT_ZH } from "./outline-plan-tree.browser-plans";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_PLAN_TREE_SHOTS;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "outline-plan-tree.browser-fixture.tsx")],
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
			// The approval form's queries have no server here: they fail, as when one is unreachable.
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

async function render(options: Fixture.FixtureOptions): Promise<Fixture.CardReport> {
	await page.setViewport({
		width: Math.max(options.width + 32, 360),
		height: 900,
		deviceScaleFactor: 2,
	});
	await page.evaluate(
		(o) => (window as unknown as FixtureWindow).fixture.render(o),
		options as never,
	);
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.steady());
	if (options.scene.startsWith("inbox")) return null as unknown as Fixture.CardReport;
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

async function click(selector: string, alt = false): Promise<Fixture.CardReport> {
	const clicked = await page.evaluate(
		(s, a) => (window as unknown as FixtureWindow).fixture.click(s, a),
		selector,
		alt,
	);
	if (!clicked) throw new Error(`nothing to click: ${selector}`);
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.steady());
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

/** Focus `selector` and press `key` on the real keyboard (Alt held with `alt`). */
async function press(selector: string, key: "Enter" | "Space", alt = false) {
	const focused = await page.evaluate(
		(s) => (window as unknown as FixtureWindow).fixture.focus(s),
		selector,
	);
	if (!focused) throw new Error(`nothing to focus: ${selector}`);
	const before = await page.evaluate(() =>
		(window as unknown as FixtureWindow).fixture.commitCount(),
	);
	if (alt) await page.keyboard.down("Alt");
	await page.keyboard.press(key);
	if (alt) await page.keyboard.up("Alt");
	await page.evaluate((b) => (window as unknown as FixtureWindow).fixture.afterCommit(b), before);
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.steady());
}

async function decisions(): Promise<number> {
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.decisionCount());
}

async function focusedAt() {
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.focused());
}

/** Enter on the page itself (nothing focused): where the waiting permission's shortcut lives. */
async function enterOnPage(): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press("Enter");
}

async function report(): Promise<Fixture.CardReport> {
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

async function inbox(): Promise<Fixture.InboxReport> {
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.inboxReport());
}

async function shot(name: string): Promise<void> {
	if (!shots) return;
	mkdirSync(shots, { recursive: true });
	const el = await page.$("#shot");
	await el?.screenshot({ path: join(shots, `${name}.png`) });
}

/**
 * The card is exactly as tall as measured, nothing reaches past it, no row text past its row, no
 * preview past its row, the toolbar line clear of the rows, no sideways scroll.
 */
function expectExact(card: Fixture.CardReport) {
	expect(Math.abs(card.painted - card.measured)).toBeLessThanOrEqual(0.5);
	expect(card.spill).toBeLessThanOrEqual(0.5);
	expect(card.rowSpill).toBeLessThanOrEqual(0.5);
	expect(card.previewSpill).toBeLessThanOrEqual(0.5);
	expect(card.toolbarOverlap).toBeLessThanOrEqual(0.5);
	expect(card.overflowX).toBe(false);
}

const ENLARGED = { fontScalePercent: 130, lineHeightScalePercent: 120 };
const row = (card: { rows: Fixture.PlanRowReport[] }, key: string) =>
	card.rows.find((r) => r.key === key) as Fixture.PlanRowReport;
const keys = (card: { rows: Fixture.PlanRowReport[] }) => card.rows.map((r) => r.key);

/** The default view of the format plan: what the owner's preview shows. */
const DEFAULT_KEYS = [
	"r",
	"r.0",
	"r.1",
	"r.1.0",
	"r.1.1",
	"r.1.2",
	"r.2",
	"r.2.0",
	"r.2.1",
	"r.3",
	"r.3.0",
	"r.3.1",
	"r.4",
	"r.4.0",
	"r.4.1",
	"r.4.2",
];

const WORDS = {
	"zh-CN": {
		big: ["阶段 1：去掉固定时间拒绝", "阶段 2：界面提示", "阶段 3：验收与回归", "特别值得注意的点"],
		more: (n: number) => `还有 ${n} 条 ▸`,
		toolbar: "大纲 · 共 30 块",
		toolbarAll: "大纲 · 已全部展开 · 共 30 块",
		expandAll: "全部展开",
		collapseAll: "全部收起",
		first: "删除 deadline 传播和超时 reject",
	},
	en: {
		big: [
			"Phase 1: remove the fixed-time refusal",
			"Phase 2: the notice",
			"Phase 3: acceptance and regressions",
			"Notable points",
		],
		more: (n: number) => `${n} more ▸`,
		toolbar: "Outline · 30 blocks",
		toolbarAll: "Outline · all 30 blocks shown",
		expandAll: "Expand all",
		collapseAll: "Collapse all",
		first: "Drop the deadline",
	},
} as const;

describe("the plans of this test", () => {
	test("the formatted ones pass the submission check", () => {
		for (const plan of [FORMAT_ZH, FORMAT_EN]) {
			let n = 0;
			const toNode = (
				item: (typeof plan)["children"][number],
			): Parameters<typeof planStructureIssues>[0] => ({
				sid: `S${n++}`,
				content: item.content,
				task: item.task,
				children: item.children.map(toNode),
			});
			// Round-tripped through the markdown the card parses.
			const [parsed] = parseMarkdownOutline(serializeMarkdownOutline([plan])).items;
			expect(planStructureIssues(toNode(parsed as typeof plan)).issues).toEqual([]);
		}
		expect(FORMAT_ZH.children.at(-1)?.content).toBe(NOTABLE_POINTS_TITLE["zh-CN"]);
		expect(FORMAT_EN.children.at(-1)?.content).toBe(NOTABLE_POINTS_TITLE.en);
	});
});

describe("the default view, in the plan format", () => {
	for (const lang of ["zh-CN", "en"] as const) {
		for (const scheme of ["dark", "light"] as const) {
			for (const width of [720, 360]) {
				test(`${lang}, ${scheme}, ${width}px`, async () => {
					const card = await render({ scene: "format", lang, scheme, width });
					await shot(`format-${lang}-${scheme}-${width}`);
					expectExact(card);
					const words = WORDS[lang];
					expect(keys(card)).toEqual(DEFAULT_KEYS);
					// The title, then the background: whole, no arrow, no marker.
					expect(row(card, "r").ellipsis).toBe(false);
					const bg = row(card, "r.0");
					expect([bg.role, bg.arrow, bg.marker, bg.ellipsis, bg.subtree]).toEqual([
						"background",
						false,
						false,
						false,
						null,
					]);
					expect(bg.lines).toBeGreaterThan(width === 360 ? 4 : 1);
					// The big points, the notable points last.
					expect(
						card.rows.filter((r) => r.depth === 1 && r.role !== "background").map((r) => r.text),
					).toEqual([...words.big]);
					// Each small point with details: one preview line, an ellipsis and how many more.
					const p = row(card, "r.1.0").preview;
					expect(p?.label).toBe(words.more(4));
					expect(p?.ellipsis).toBe(true);
					expect(p?.text.startsWith(words.first.slice(0, 6))).toBe(true);
					expect(row(card, "r.1.1").preview?.label).toBe(words.more(2));
					expect(row(card, "r.2.0").preview?.label).toBe(words.more(1));
					expect(row(card, "r.1.2").preview?.label ?? null).toBe(
						// A lone short detail shows whole when it fits on the line.
						row(card, "r.1.2").preview?.ellipsis ? (lang === "en" ? "Expand ▸" : "展开 ▸") : null,
					);
					expect(row(card, "r.2.1").preview).toBeNull();
					// The small points carry their quick control; leaves and the title do not.
					expect(row(card, "r.1").subtree).toBe("expand");
					expect(row(card, "r.1.0").subtree).toBe("expand");
					expect(row(card, "r.2.1").subtree).toBeNull();
					expect(row(card, "r").subtree).toBeNull();
					// The notable points: their items whole.
					const notable = card.rows.filter((r) => r.key.startsWith("r.4."));
					expect(notable.every((r) => r.role === "notableItem" && !r.ellipsis)).toBe(true);
					expect(Math.max(...card.rows.map((r) => r.depth))).toBe(2);
					expect(card.toolbar).toBe(words.toolbar);
					expect(card.allLabel).toBe(words.expandAll);
					expect(card.markdownBlocks).toBe(0);
				});
			}
		}
	}

	test("enlarged type, a phone's width: still exact, still no sideways scroll", async () => {
		const card = await render({
			scene: "format",
			lang: "zh-CN",
			scheme: "light",
			width: 360,
			...ENLARGED,
		});
		await shot("format-zh-CN-light-360-enlarged");
		expectExact(card);
		expect(keys(card)).toEqual(DEFAULT_KEYS);
	});
});

describe("opening and closing", () => {
	test("a preview line opens the small point's details, each whole with its children; its quick control closes them", async () => {
		let card = await render({ scene: "format", lang: "zh-CN", scheme: "dark", width: 720 });
		const folded = card.measured;
		card = await click('[data-plan-row="r.1.0"] [data-plan-preview]');
		await shot("format-zh-CN-dark-720-details");
		expectExact(card);
		expect(keys(card).filter((k) => k.startsWith("r.1.0."))).toEqual([
			"r.1.0.0",
			"r.1.0.1",
			"r.1.0.2",
			"r.1.0.3",
			"r.1.0.3.0",
			"r.1.0.4",
		]);
		expect(row(card, "r.1.0").preview).toBeNull();
		expect(row(card, "r.1.0").open).toBe("1");
		expect(row(card, "r.1.0").subtree).toBe("collapse");
		// The long first detail shows whole: no ellipsis, more than one line.
		expect(row(card, "r.1.0.0").ellipsis).toBe(false);
		expect(row(card, "r.1.0.0").lines).toBeGreaterThan(1);
		// The other small points keep their one line.
		expect(row(card, "r.1.1").preview?.label).toBe("还有 2 条 ▸");
		card = await click('[data-plan-row="r.1.0"] [data-plan-subtree]');
		expectExact(card);
		expect(keys(card)).toEqual(DEFAULT_KEYS);
		expect(card.measured).toBe(folded);
	});

	test("the arrow opens one level: a detail with children previews in turn", async () => {
		let card = await render({ scene: "format", lang: "zh-CN", scheme: "dark", width: 720 });
		const folded = card.measured;
		card = await click('[data-plan-row="r.1.0"] [data-plan-toggle]');
		expectExact(card);
		expect(keys(card).filter((k) => k.startsWith("r.1.0."))).toEqual([
			"r.1.0.0",
			"r.1.0.1",
			"r.1.0.2",
			"r.1.0.3",
			"r.1.0.4",
		]);
		expect(row(card, "r.1.0.3").preview?.text).toBe("新调用方用它决定要不要发界面提示");
		expect(row(card, "r.1.0.3").preview?.label).toBeNull();
		card = await click('[data-plan-row="r.1.0"] [data-plan-toggle]');
		expect(card.measured).toBe(folded);
		// A big point's arrow closes it: its first small point previews in its place.
		card = await click('[data-plan-row="r.2"] [data-plan-toggle]');
		expectExact(card);
		expect(keys(card).some((k) => k.startsWith("r.2."))).toBe(false);
		expect(row(card, "r.2").preview).toMatchObject({
			text: "读取慢时在会话头部显示提示",
			label: "还有 1 条 ▸",
		});
	});

	test("Alt+click on an arrow: everything inside the node, then back", async () => {
		let card = await render({ scene: "format", lang: "en", scheme: "light", width: 720 });
		const folded = card.measured;
		card = await click('[data-plan-row="r.1"] [data-plan-toggle]', true);
		await shot("format-en-light-720-subtree");
		expectExact(card);
		const inside = keys(card).filter((k) => k.startsWith("r.1."));
		expect(inside).toHaveLength(13);
		expect(card.rows.filter((r) => r.key.startsWith("r.1")).every((r) => r.preview === null)).toBe(
			true,
		);
		expect(row(card, "r.1").subtree).toBe("collapse");
		// The other big points are as they were.
		expect(row(card, "r.2.0").preview?.label).toBe("1 more ▸");
		card = await click('[data-plan-row="r.1"] [data-plan-toggle]', true);
		expectExact(card);
		expect(card.measured).toBe(folded);
		expect(keys(card)).toEqual(DEFAULT_KEYS);
	});

	test("from the keyboard: Alt+Enter on an arrow, Enter on a preview, Space on a quick control", async () => {
		await render({ scene: "format", lang: "zh-CN", scheme: "dark", width: 360 });
		const folded = (await report()).measured;
		await press('[data-plan-row="r.3"] [data-plan-toggle]', "Enter", true);
		let card = await report();
		expectExact(card);
		expect(keys(card)).toContain("r.3.0.1");
		expect(row(card, "r.3").open).toBe("1");
		await press('[data-plan-row="r.3"] [data-plan-toggle]', "Enter", true);
		card = await report();
		expect(card.measured).toBe(folded);
		// Enter on a preview line opens the small point's details.
		await press('[data-plan-row="r.1.1"] [data-plan-preview]', "Enter");
		card = await report();
		expectExact(card);
		expect(keys(card)).toContain("r.1.1.2");
		// Space on its quick control closes them.
		await press('[data-plan-row="r.1.1"] [data-plan-subtree]', "Space");
		card = await report();
		expectExact(card);
		expect(card.measured).toBe(folded);
		// A plain Enter on an arrow opens one level only.
		await press('[data-plan-row="r.1.0"] [data-plan-toggle]', "Enter");
		card = await report();
		expect(keys(card)).toContain("r.1.0.3");
		expect(keys(card)).not.toContain("r.1.0.3.0");
	});

	test("「全部展开 / 全部收起」: every block whole, then the default view", async () => {
		let card = await render({ scene: "format", lang: "zh-CN", scheme: "dark", width: 720 });
		const folded = card.measured;
		card = await click('[data-plan-row="r.1.0"] [data-plan-preview]');
		card = await click("[data-plan-all]");
		await shot("format-zh-CN-dark-720-all");
		expectExact(card);
		expect(card.allLabel).toBe("全部收起");
		expect(card.toolbar).toBe("大纲 · 已全部展开 · 共 30 块");
		expect(card.rows).toHaveLength(30);
		expect(card.rows.some((r) => r.ellipsis || r.preview)).toBe(false);
		expect(card.rows.filter((r) => r.subtree).every((r) => r.subtree === "collapse")).toBe(true);
		// Past 0.85 × the viewport the box scrolls, as the markdown plan did.
		expect(card.box && card.box.scrollHeight > card.box.clientHeight).toBe(true);
		// Closing one node there: no longer all open; 「全部展开」 again opens it.
		card = await click('[data-plan-row="r.2"] [data-plan-toggle]');
		expect(card.allLabel).toBe("全部展开");
		card = await click("[data-plan-all]");
		expect(card.allLabel).toBe("全部收起");
		card = await click("[data-plan-all]");
		expectExact(card);
		expect(card.allLabel).toBe("全部展开");
		expect(card.measured).toBe(folded);
		expect(keys(card)).toEqual(DEFAULT_KEYS);
	});
});

describe("a plan written before the format", () => {
	for (const [lang, scheme, width] of [
		["zh-CN", "dark", 720],
		["en", "light", 360],
	] as const) {
		test(`the same depth rules, ${lang} ${scheme} ${width}px`, async () => {
			let card = await render({ scene: "legacy", lang, scheme, width });
			await shot(`legacy-${lang}-${scheme}-${width}`);
			expectExact(card);
			// The giant root paragraph shows three lines and an ellipsis.
			expect(row(card, "r").lines).toBe(3);
			expect(row(card, "r").ellipsis).toBe(true);
			// Its first block has children: not a background, a big point.
			expect(row(card, "r.0").role).toBe("point");
			expect(Math.max(...card.rows.map((r) => r.depth))).toBe(2);
			expect(card.rows.filter((r) => r.depth === 1).map((r) => r.key)).toEqual([
				"r.0",
				"r.1",
				"r.2",
				"r.3",
				"r.4",
			]);
			// The long bullets of the boundaries are points: clamped at three lines at a phone's width.
			if (width === 360) expect(card.rows.some((r) => r.depth === 2 && r.ellipsis)).toBe(true);
			// The tasks with details preview them.
			expect(row(card, "r.1.0").preview?.label).toBe(lang === "zh-CN" ? "还有 2 条 ▸" : "2 more ▸");
			// The root's text opens whole, and clamps again.
			const folded = card.measured;
			card = await click('[data-plan-row="r"] [data-plan-text]');
			expectExact(card);
			expect(row(card, "r").ellipsis).toBe(false);
			expect(row(card, "r").lines).toBeGreaterThan(3);
			card = await click('[data-plan-row="r"] [data-plan-text]');
			expect(card.measured).toBe(folded);
			card = await click("[data-plan-all]");
			if (lang === "zh-CN") await shot("legacy-zh-CN-dark-720-all");
			expectExact(card);
			expect(card.rows).toHaveLength(27);
			card = await click("[data-plan-all]");
			expect(card.measured).toBe(folded);
		});
	}
});

describe("the approval card", () => {
	for (const [lang, scheme, width] of [
		["zh-CN", "dark", 720],
		["en", "light", 720],
		["zh-CN", "light", 360],
		["en", "dark", 360],
	] as const) {
		test(`waiting for a decision: the plan above the form, exact, ${lang} ${scheme} ${width}px`, async () => {
			let card = await render({ scene: "format", lang, scheme, width, approval: true });
			await shot(`approval-${lang}-${scheme}-${width}`);
			expect(card.approval).toBe(true);
			expectExact(card);
			expect(keys(card)).toEqual(DEFAULT_KEYS);
			card = await click('[data-plan-row="r.1.0"] [data-plan-preview]');
			expectExact(card);
			expect(keys(card)).toContain("r.1.0.3.0");
			card = await click('[data-plan-row="r.2"] [data-plan-subtree]');
			expectExact(card);
			expect(keys(card)).toContain("r.2.0.1");
			card = await click("[data-plan-all]");
			expectExact(card);
			expect(card.approval).toBe(true);
		});
	}
});

describe("the inbox's tree", () => {
	for (const [lang, scheme, width] of [
		["zh-CN", "dark", 720],
		["en", "light", 360],
	] as const) {
		test(`the same view, ${lang} ${scheme} ${width}px`, async () => {
			await render({ scene: "inbox", lang, scheme, width });
			await shot(`inbox-${lang}-${scheme}-${width}`);
			let tree = await inbox();
			expect(tree.overflowX).toBe(false);
			expect(tree.previewSpill).toBeLessThanOrEqual(0.5);
			expect(keys(tree)).toEqual(DEFAULT_KEYS);
			expect(row(tree, "r.0").role).toBe("background");
			const words = WORDS[lang];
			expect(row(tree, "r.1.0").preview?.label).toBe(words.more(4));
			expect(row(tree, "r.1.0").preview?.text.endsWith("…")).toBe(true);
			expect(tree.allLabel).toBe(words.expandAll);
			// The preview, Alt+click and the quick control, as on the card.
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.click(
					'[data-plan-row="r.1.0"] + [data-plan-preview]',
				),
			);
			tree = await inbox();
			expect(keys(tree)).toContain("r.1.0.3.0");
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.click(
					'[data-plan-row="r.1.0"] [data-plan-subtree]',
				),
			);
			tree = await inbox();
			expect(keys(tree)).toEqual(DEFAULT_KEYS);
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.click(
					'[data-plan-row="r.2"] [data-plan-toggle]',
					true,
				),
			);
			tree = await inbox();
			expect(keys(tree)).toContain("r.2.0.1");
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.click("[data-testid=outline-plan-tree-all]"),
			);
			tree = await inbox();
			expect(tree.rows).toHaveLength(30);
			expect(tree.allLabel).toBe(words.collapseAll);
			expect(tree.overflowX).toBe(false);
		});
	}
});

describe("the keyboard: a control's Enter and Space are its own (review round 1 B1, S4)", () => {
	test("on the approval card, under the panel's shortcut: nothing decides but the page's Enter", async () => {
		await render({
			scene: "format",
			lang: "zh-CN",
			scheme: "dark",
			width: 720,
			approval: true,
			keyboard: true,
		});
		expect(await decisions()).toBe(0);
		// The arrow: closes, then opens again.
		await press('[data-plan-row="r.1"] [data-plan-toggle]', "Enter");
		let card = await report();
		expect(row(card, "r.1").open).toBe("0");
		await press('[data-plan-row="r.1"] [data-plan-toggle]', "Space");
		card = await report();
		expect(row(card, "r.1").open).toBe("1");
		// A preview line: everything inside the small point; the focus goes to its quick control.
		await press('[data-plan-row="r.1.0"] [data-plan-preview]', "Enter");
		card = await report();
		expectExact(card);
		expect(keys(card)).toContain("r.1.0.3.0");
		expect(await focusedAt()).toEqual({ row: "r.1.0", control: "subtree:collapse" });
		// The quick control, where the focus now is: back to one line.
		await press('[data-plan-row="r.1.0"] [data-plan-subtree]', "Enter");
		card = await report();
		expect(row(card, "r.1.0").preview?.label).toBe("还有 4 条 ▸");
		// 「全部展开」 and back.
		await press("[data-plan-all]", "Enter");
		card = await report();
		expect(card.allLabel).toBe("全部收起");
		await press("[data-plan-all]", "Enter");
		card = await report();
		expect(card.allLabel).toBe("全部展开");
		expect(keys(card)).toEqual(DEFAULT_KEYS);
		expect(await decisions()).toBe(0);
		// Enter on the page itself is still the shortcut: the plan is decided (executed as a draft).
		await enterOnPage();
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture.decisionCount() === 1,
			{ timeout: 5000, polling: 20 },
		);
	});

	test("in the inbox, under a session panel's shortcut: the same", async () => {
		await render({ scene: "inbox", lang: "en", scheme: "light", width: 720, keyboard: true });
		const before = await decisions();
		await press('[data-plan-row="r.2"] [data-plan-toggle]', "Enter");
		expect(row(await inbox(), "r.2").open).toBe("0");
		await press('[data-plan-row="r.1.0"] + [data-plan-preview]', "Enter");
		let tree = await inbox();
		expect(keys(tree)).toContain("r.1.0.3.0");
		expect(await focusedAt()).toEqual({ row: "r.1.0", control: "subtree:collapse" });
		await press('[data-plan-row="r.1.0"] [data-plan-subtree]', "Space");
		tree = await inbox();
		expect(keys(tree)).not.toContain("r.1.0.0");
		await press("[data-testid=outline-plan-tree-all]", "Enter");
		tree = await inbox();
		expect(tree.allLabel).toBe("Collapse all");
		await press('[data-plan-row="r.3"] [data-plan-toggle]', "Enter", true);
		expect(await decisions()).toBe(before);
		await enterOnPage();
		await page.waitForFunction(
			(n) => (window as unknown as FixtureWindow).fixture.decisionCount() === n,
			{ timeout: 5000, polling: 20 },
			before + 1,
		);
	});
});

describe("clicks and names", () => {
	test("a Ctrl/Cmd/Shift click is the list's selection, not a toggle", async () => {
		let card = await render({ scene: "format", lang: "en", scheme: "light", width: 720 });
		const folded = card.measured;
		for (const key of ["Control", "Shift"] as const) {
			await page.keyboard.down(key);
			await page.click('[data-plan-row="r.1"] [data-plan-toggle]');
			await page.click('[data-plan-row="r.1.0"] [data-plan-preview]');
			await page.keyboard.up(key);
		}
		card = await report();
		expect(card.measured).toBe(folded);
		expect(keys(card)).toEqual(DEFAULT_KEYS);
	});

	test("the quick control keeps its name; its state is aria-expanded; no arrow in a name", async () => {
		await render({ scene: "format", lang: "zh-CN", scheme: "dark", width: 720 });
		const read = () =>
			page.evaluate(() => {
				const quick = document.querySelector('[data-plan-row="r.1.0"] [data-plan-subtree]');
				const preview = document.querySelector('[data-plan-row="r.1.1"] [data-plan-preview]');
				const arrow = document.querySelector('[data-plan-row="r.1"] [data-plan-toggle]');
				return {
					quick: [quick?.getAttribute("aria-label"), quick?.getAttribute("aria-expanded")],
					preview: preview?.getAttribute("aria-label"),
					arrow: [arrow?.getAttribute("aria-label"), arrow?.getAttribute("aria-expanded")],
					all: document.querySelector("[data-plan-all]")?.hasAttribute("aria-pressed"),
				};
			});
		expect(await read()).toEqual({
			quick: ["展开/收起「清除模型历史链路的固定时间拒绝」里的全部", "false"],
			preview:
				"展开这一项里的全部: 回放超过 10 秒只记 warn，不再拒绝，结果照常回放给模型和界面 (还有 2 条)",
			arrow: ["阶段 1：去掉固定时间拒绝", "true"],
			all: false,
		});
		await click('[data-plan-row="r.1.0"] [data-plan-subtree]');
		expect((await read()).quick).toEqual([
			"展开/收起「清除模型历史链路的固定时间拒绝」里的全部",
			"true",
		]);
	});

	test("the box scrolls with the list's overlay scrollbars; the quick controls stay clear of it", async () => {
		await render({ scene: "format", lang: "zh-CN", scheme: "dark", width: 720 });
		// Not scrolling: the quick controls reach the box's inner edge.
		const edge = () =>
			page.evaluate(() => {
				const port = document.querySelector<HTMLElement>(
					"[data-plan-box] [data-content-scrollport]",
				);
				const quick = [
					...document.querySelectorAll<HTMLElement>("[data-card] [data-plan-subtree]"),
				];
				if (!port || quick.length === 0) return null;
				const right = port.getBoundingClientRect().right;
				return Math.min(...quick.map((q) => right - q.getBoundingClientRect().right));
			});
		expect(await edge()).toBeLessThan(8);
		const card = await click("[data-plan-all]");
		expectExact(card);
		expect(card.box && card.box.scrollHeight > card.box.clientHeight).toBe(true);
		const widths = await page.evaluate(() => {
			const port = document.querySelector<HTMLElement>("[data-plan-box] [data-content-scrollport]");
			return port
				? [port.clientWidth, port.offsetWidth, getComputedStyle(port).scrollbarWidth]
				: null;
		});
		expect(widths?.[0]).toBe(widths?.[1]);
		expect(widths?.[2]).toBe("none");
		// Scrolling: every quick control is clear of the scrollbar's 8px strip.
		expect(await edge()).toBeGreaterThanOrEqual(8);
	});

	test("the arrow's whole 24px target is the arrow's (the marker lets clicks through)", async () => {
		await render({ scene: "format", lang: "en", scheme: "light", width: 720 });
		const hit = await page.evaluate(() => {
			const arrow = document.querySelector<HTMLElement>('[data-plan-row="r.1"] [data-plan-toggle]');
			if (!arrow) return null;
			const r = arrow.getBoundingClientRect();
			const at = document.elementFromPoint(r.right - 1, r.top + r.height / 2);
			return { width: Math.round(r.width), arrow: !!at && arrow.contains(at) };
		});
		expect(hit).toEqual({ width: 24, arrow: true });
	});

	test("a held key toggles once", async () => {
		await render({ scene: "format", lang: "en", scheme: "light", width: 720 });
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.focus(
				'[data-plan-row="r.1"] [data-plan-toggle]',
			),
		);
		const before = await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.commitCount(),
		);
		await page.keyboard.down("Enter");
		await page.evaluate((b) => (window as unknown as FixtureWindow).fixture.afterCommit(b), before);
		// The key held: the browser repeats it once more (a toggle per keydown would open it again).
		await page.keyboard.down("Enter");
		await page.keyboard.up("Enter");
		await page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
		);
		expect(row(await report(), "r.1").open).toBe("0");
	});
});

describe("the inbox's text controls (review round 1 S5)", () => {
	test("only a text longer than its clamp is a control; a short point's is not", async () => {
		await render({ scene: "inbox", lang: "zh-CN", scheme: "dark", width: 360 });
		let tree = await inbox();
		// The format plan's points are short: none of them is a control.
		expect(tree.rows.filter((r) => r.textToggles)).toEqual([]);
		await render({ scene: "inbox-legacy", lang: "zh-CN", scheme: "dark", width: 360 });
		tree = await inbox();
		const toggles = tree.rows.filter((r) => r.textToggles).map((r) => r.key);
		expect(toggles).toContain("r");
		expect(toggles).not.toContain("r.1.2");
		// A click shows it whole; Enter clamps it again.
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.click('[data-plan-row="r"] [data-plan-text]'),
		);
		await page.waitForFunction(
			() =>
				document
					.querySelector('[data-inbox] [data-plan-row="r"] [data-plan-text]')
					?.getAttribute("aria-expanded") === "true",
			{ timeout: 5000, polling: 20 },
		);
		await press('[data-plan-row="r"] [data-plan-text]', "Enter");
		expect(
			await page.evaluate(() =>
				document
					.querySelector('[data-inbox] [data-plan-row="r"] [data-plan-text]')
					?.getAttribute("aria-expanded"),
			),
		).toBe("false");
	});
});

describe("before (the old card, for the screenshots)", () => {
	test("the same plan as a markdown body, everything open", async () => {
		const card = await render({ scene: "before", lang: "zh-CN", scheme: "dark", width: 720 });
		await shot("before-zh-CN-dark-720");
		expect(card.rows.length).toBe(0);
		expect(card.markdownBlocks).toBe(1);
	});
});
