/**
 * Task notices laid out by Chromium (PR-1): the measure pass predicts every card's height from
 * its line count alone (each line is a single truncated line), so the painted card must be
 * exactly that tall and nothing in it may spill past the box — folded and unfolded, at phone
 * width, and at a typography the reader enlarged (the line height follows `typographyMetrics`,
 * the badges do not). Also: no Markdown debris reaches the reader.
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

const CASES: Array<{ name: string; options: Fixture.FixtureOptions }> = [
	{ name: "folded-720-dark", options: { width: 720, expanded: false, scheme: "dark" } },
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
];

for (const { name, options } of CASES) {
	test(`task notices: painted as measured, nothing spills (${name})`, async () => {
		await page.evaluate(
			(o) => (window as unknown as FixtureWindow).fixture.render(o),
			options as never,
		);
		const cards = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
		expect(cards.map((card) => card.kind)).toEqual([
			"task_notice",
			"task_notice",
			"task_notice",
			"task_notice",
			"task_notice",
			"origin_notice",
		]);
		for (const card of cards) {
			expect({ kind: card.kind, painted: card.painted }).toEqual({
				kind: card.kind,
				painted: card.measured,
			});
			expect(card.content).toBeLessThanOrEqual(card.painted);
			expect(card.scrollWidth).toBeLessThanOrEqual(card.width);
			// No Markdown reaches the reader.
			expect(card.text).not.toContain("######");
			expect(card.text).not.toContain("\\");
			expect(card.text).not.toContain("`");
		}
		if (options.expanded) {
			// Unfolded cards are taller than one line; the folded ones are all one line.
			expect(cards[1]?.measured).toBeGreaterThan(cards[4]?.measured ?? 0);
		} else {
			const tallest = Math.max(...cards.slice(0, 5).map((card) => card.measured));
			expect(tallest).toBe(cards[4]?.measured);
		}
		if (shots) {
			mkdirSync(shots, { recursive: true });
			const shot = await page.$("#shot");
			await shot?.screenshot({ path: join(shots, `task-notice-${name}.png`) });
		}
	});
}
