/**
 * An outline plan's ExitPlanMode card laid out by Chromium (plan readability): by default the
 * reader sees the root and the two levels under it, deeper levels folded with their child count
 * and long text clamped; a node, a text and 「全部展开 / 全部收起」 open and fold it; and at every
 * step the card is exactly as tall as the measure said — after an approval too, with the approval
 * form under the plan — in English and Chinese, light and dark, at 720 and 360 px (no sideways
 * scroll on a phone), and at a typography the reader enlarged.
 *
 * NF_PLAN_TREE_SHOTS=<dir> also writes a screenshot of each case there (and of the old card).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./outline-plan-tree.browser-fixture";

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
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

async function click(selector: string): Promise<Fixture.CardReport> {
	const clicked = await page.evaluate(
		(s) => (window as unknown as FixtureWindow).fixture.click(s),
		selector,
	);
	if (!clicked) throw new Error(`nothing to click: ${selector}`);
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.steady());
	return await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

async function shot(name: string): Promise<void> {
	if (!shots) return;
	mkdirSync(shots, { recursive: true });
	const el = await page.$("#shot");
	await el?.screenshot({ path: join(shots, `${name}.png`) });
}

/**
 * The card is exactly as tall as measured, nothing reaches past it, no row text past its row, the
 * toolbar line clear of the rows, no sideways scroll.
 */
function expectExact(card: Fixture.CardReport) {
	expect(Math.abs(card.painted - card.measured)).toBeLessThanOrEqual(0.5);
	expect(card.spill).toBeLessThanOrEqual(0.5);
	expect(card.rowSpill).toBeLessThanOrEqual(0.5);
	expect(card.toolbarOverlap).toBeLessThanOrEqual(0.5);
	expect(card.overflowX).toBe(false);
}

const ENLARGED = { fontScalePercent: 130, lineHeightScalePercent: 120 };

describe("the overview: the root and two levels", () => {
	for (const lang of ["zh-CN", "en"] as const) {
		for (const scheme of ["dark", "light"] as const) {
			for (const width of [720, 360]) {
				test(`legacy plan, ${lang}, ${scheme}, ${width}px`, async () => {
					const card = await render({ scene: "legacy", lang, scheme, width });
					await shot(`legacy-${lang}-${scheme}-${width}`);
					expectExact(card);
					// Depth 0, 1 and 2 show; nothing deeper.
					expect(Math.max(...card.rows.map((r) => r.depth))).toBe(2);
					expect(card.rows.filter((r) => r.depth === 1).map((r) => r.key)).toEqual([
						"r.0",
						"r.1",
						"r.2",
						"r.3",
						"r.4",
					]);
					// The level-2 tasks with details are folded, each with its child count.
					const phase1 = card.rows.filter((r) => r.key.startsWith("r.1."));
					expect(phase1.map((r) => [r.key, r.open, r.badge])).toEqual([
						["r.1.0", "0", "+3"],
						["r.1.1", "0", "+2"],
						["r.1.2", "0", "+1"],
					]);
					// The giant root paragraph shows two lines and an ellipsis.
					const root = card.rows[0] as Fixture.PlanRowReport;
					expect(root.key).toBe("r");
					expect(root.lines).toBe(2);
					expect(root.ellipsis).toBe(true);
					expect(card.toolbar).toBe(
						lang === "zh-CN"
							? "大纲 · 默认显示两层 · 共 27 块"
							: "Outline · two levels by default · 27 blocks",
					);
					expect(card.allLabel).toBe(lang === "zh-CN" ? "全部展开" : "Expand all");
					expect(card.markdownBlocks).toBe(0);
				});
			}
		}
	}

	test("a laid-out plan reads as its outline, nothing clamped", async () => {
		const card = await render({ scene: "structured", lang: "zh-CN", scheme: "dark", width: 720 });
		await shot("structured-zh-CN-dark-720");
		expectExact(card);
		expect(card.rows.every((r) => !r.ellipsis)).toBe(true);
		expect(card.rows.filter((r) => r.depth === 1).map((r) => r.text)).toEqual([
			"目标",
			"验收",
			"边界与取舍",
			"阶段1：去掉固定时间拒绝",
			"阶段2：界面提示",
			"阶段3：测试与回归",
		]);
		expect(card.rows.find((r) => r.text === "清除模型历史链路的固定时间拒绝")?.badge).toBe("+3");
	});

	test("enlarged type, a phone's width: still exact, still no sideways scroll", async () => {
		const card = await render({
			scene: "legacy",
			lang: "zh-CN",
			scheme: "light",
			width: 360,
			...ENLARGED,
		});
		await shot("legacy-zh-CN-light-360-enlarged");
		expectExact(card);
		expect(Math.max(...card.rows.map((r) => r.depth))).toBe(2);
	});
});

describe("opening and folding", () => {
	test("a node, its text, everything, and back; exact at each step", async () => {
		let card = await render({ scene: "legacy", lang: "zh-CN", scheme: "dark", width: 720 });
		const folded = card.measured;
		// Open the first task of phase 1 by its arrow: its three details appear, it loses its badge.
		card = await click('[data-plan-row="r.1.0"] [data-plan-toggle]');
		expectExact(card);
		expect(card.rows.filter((r) => r.key.startsWith("r.1.0.")).map((r) => r.depth)).toEqual([
			3, 3, 3,
		]);
		expect(card.rows.find((r) => r.key === "r.1.0")?.badge).toBeNull();
		expect(card.measured).toBeGreaterThan(folded);
		// Fold it again by its arrow.
		card = await click('[data-plan-row="r.1.0"] [data-plan-toggle]');
		expectExact(card);
		expect(card.measured).toBe(folded);
		// The badge opens a node too.
		card = await click('[data-plan-row="r.1.1"] [data-plan-badge]');
		expect(card.rows.filter((r) => r.key.startsWith("r.1.1.")).length).toBe(2);
		expectExact(card);
		card = await click('[data-plan-row="r.1.1"] [data-plan-toggle]');
		// The root's text opens whole on a click, and clamps again.
		card = await click('[data-plan-row="r"] [data-plan-text]');
		expectExact(card);
		const whole = card.rows[0] as Fixture.PlanRowReport;
		expect(whole.ellipsis).toBe(false);
		expect(whole.lines).toBeGreaterThan(2);
		card = await click('[data-plan-row="r"] [data-plan-text]');
		expect((card.rows[0] as Fixture.PlanRowReport).lines).toBe(2);
		expect(card.measured).toBe(folded);
		// 「全部展开」: every level, every text whole; 「全部收起」 is the overview again.
		card = await click("[data-plan-all]");
		await shot("legacy-zh-CN-dark-720-all");
		expectExact(card);
		expect(card.allLabel).toBe("全部收起");
		expect(card.toolbar).toBe("大纲 · 已全部展开 · 共 27 块");
		expect(card.rows.length).toBe(27);
		expect(card.rows.some((r) => r.ellipsis)).toBe(false);
		expect(card.rows.every((r) => r.badge === null)).toBe(true);
		// Past 0.85 × the viewport the box scrolls, as the markdown plan did.
		expect(card.box && card.box.scrollHeight > card.box.clientHeight).toBe(true);
		card = await click("[data-plan-all]");
		expectExact(card);
		expect(card.allLabel).toBe("全部展开");
		expect(card.measured).toBe(folded);
	});
});

describe("the approval card", () => {
	for (const [lang, scheme, width] of [
		["zh-CN", "dark", 720],
		["en", "light", 720],
		["zh-CN", "light", 360],
		["en", "dark", 360],
	] as const) {
		test(`waiting for a decision: overview above the form, exact, ${lang} ${scheme} ${width}px`, async () => {
			let card = await render({ scene: "legacy", lang, scheme, width, approval: true });
			await shot(`approval-${lang}-${scheme}-${width}`);
			expect(card.approval).toBe(true);
			expectExact(card);
			expect(Math.max(...card.rows.map((r) => r.depth))).toBe(2);
			card = await click('[data-plan-row="r.1.0"] [data-plan-toggle]');
			expectExact(card);
			expect(card.rows.filter((r) => r.key.startsWith("r.1.0.")).length).toBe(3);
			card = await click("[data-plan-all]");
			expectExact(card);
			expect(card.approval).toBe(true);
		});
	}
});

describe("before (the old card, for the screenshots)", () => {
	test("the same plan as a markdown body, everything open", async () => {
		const card = await render({ scene: "before", lang: "zh-CN", scheme: "dark", width: 720 });
		await shot("before-zh-CN-dark-720");
		expect(card.rows.length).toBe(0);
		expect(card.markdownBlocks).toBe(1);
	});
});
