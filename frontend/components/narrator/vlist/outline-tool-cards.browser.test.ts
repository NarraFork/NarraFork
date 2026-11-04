/**
 * Outline tool cards laid out by Chromium (PR-2): the measure pass predicts every card's height
 * from its row count and its bodies, so the painted card must be exactly that tall, and nothing
 * in it may reach into its padding or past it — folded and unfolded, with the raw fold open, at
 * phone width, and at a typography the reader enlarged. Also: every change row stays one line,
 * no chip upper-cases an id, and the change list links its blocks to the outline.
 *
 * NF_OUTLINE_CARD_SHOTS=<dir> also writes a screenshot of each case there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./outline-tool-cards.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_OUTLINE_CARD_SHOTS;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "outline-tool-cards.browser-fixture.tsx")],
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

const ENLARGED = { fontScalePercent: 130, lineHeightScalePercent: 120 };

const CASES: Array<{ name: string; options: Fixture.FixtureOptions }> = [];
for (const scene of ["edit", "legacy", "reads", "ask"]) {
	CASES.push({
		name: `${scene}-720`,
		options: { scene, width: 720, scheme: "dark", expanded: true },
	});
	CASES.push({
		name: `${scene}-360-light`,
		options: { scene, width: 360, scheme: "light", expanded: true },
	});
	CASES.push({
		name: `${scene}-720-enlarged`,
		options: { scene, width: 720, scheme: "dark", expanded: true, ...ENLARGED },
	});
}
CASES.push(
	{
		name: "edit-folded-720",
		options: { scene: "edit", width: 720, scheme: "dark", expanded: false },
	},
	{
		name: "edit-raw-open-720",
		options: { scene: "edit", width: 720, scheme: "dark", expanded: true, rawOpen: true },
	},
	{
		name: "edit-raw-open-360-enlarged",
		options: {
			scene: "edit",
			width: 360,
			scheme: "dark",
			expanded: true,
			rawOpen: true,
			...ENLARGED,
		},
	},
	{
		name: "ask-folded-360-enlarged",
		options: { scene: "ask", width: 360, scheme: "dark", expanded: false, ...ENLARGED },
	},
);

for (const { name, options } of CASES) {
	test(`outline tool cards: painted as measured, nothing spills (${name})`, async () => {
		await page.evaluate(
			(o) => (window as unknown as FixtureWindow).fixture.render(o),
			options as never,
		);
		const cards = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
		expect(cards.length).toBeGreaterThan(0);
		for (const card of cards) {
			const where = `${card.kind}: ${card.text.slice(0, 40)}`;
			// The measured height may be fractional (a markdown body); the box is laid out to it.
			expect({ where, off: Math.abs(card.painted - card.measured) <= 0.5 }).toEqual({
				where,
				off: true,
			});
			expect({ where, content: card.content <= Math.ceil(card.painted) }).toEqual({
				where,
				content: true,
			});
			// Nor into its padding: the measure pass reserved every line, at this typography.
			expect({ where, spill: card.spill }).toEqual({ where, spill: 0 });
			expect({ where, rowOverflow: card.rowOverflow }).toEqual({ where, rowOverflow: 0 });
			expect(card.scrollWidth).toBeLessThanOrEqual(card.width);
			// A case-sensitive id or alias is never upper-cased.
			expect({ where, upper: card.upperChips }).toEqual({ where, upper: [] });
		}
		if (options.scene === "edit" && options.expanded) {
			const [main] = cards;
			// The owner's screenshot: the task and the three notes, by title, as outline links.
			expect(main?.links).toEqual(
				expect.arrayContaining([
					"修复：排查中断后无重试按钮（只读，不改代码）",
					"已提交并推送 fix/retry-after-interrupt（3 个文件，+42 −7），CI 绿",
				]),
			);
			expect(main?.rows).toBe(5);
			expect(main?.text).not.toContain("MTBXWL1Y");
			expect(main?.text.includes("Committed #6")).toBe(options.rawOpen === true);
		}
		if (shots) {
			mkdirSync(shots, { recursive: true });
			const shot = await page.$("#shot");
			await shot?.screenshot({ path: join(shots, `outline-cards-${name}.png`) });
		}
	});
}
