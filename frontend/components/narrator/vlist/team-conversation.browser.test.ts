/**
 * Real Chromium acceptance of team mode in the coordinator conversation (the team page only):
 * the fixture runs `buildPretextDocumentLayout` with the team transform, the real measure
 * registry and renderElement, with the chip and divider text from the team page's own rules and
 * the real zh-CN locale.
 *
 *  - every row (chips, dividers, the cards around them) paints exactly its measured height, at a
 *    phone and a desktop width and at a larger font scale, with no sideways overflow;
 *  - consecutive work.create calls are ONE chip 「创建工作项 ×4」, a failed ready call marks its
 *    chip, a call waiting on a permission keeps its card, and dividers sit at their time;
 *  - a real click on a chip opens it onto the ordinary tool cards and folds it back.
 *
 * NF_TEAM_CONVERSATION_SHOTS=<dir> writes optional screenshots; missing Chromium is a failure.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./team-conversation.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
type Report = ReturnType<typeof Fixture.report>;
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_TEAM_CONVERSATION_SHOTS;
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "team-conversation.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("team fixture bundle missing");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 20,
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
		timeout: 20_000,
		protocolTimeout: 20_000,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	page.setDefaultNavigationTimeout(20_000);
	await page.goto(`http://127.0.0.1:${server.port}/`);
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function render(options: Fixture.FixtureOptions): Promise<Report> {
	await page.setViewport({ width: options.width, height: 900, deviceScaleFactor: 1 });
	await page.evaluate(
		(value) => (window as unknown as FixtureWindow).fixture.render(value),
		options,
	);
	return report();
}

async function report(): Promise<Report> {
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settle());
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

function assertGeometry(value: Report): void {
	expect(Math.abs(value.documentHeight - value.manifestHeight)).toBeLessThan(0.5);
	expect(value.pageOverflow).toBeLessThanOrEqual(0);
	for (const row of value.rows) {
		expect({ key: row.key, delta: Math.abs(row.painted - row.measured) < 0.5 }).toEqual({
			key: row.key,
			delta: true,
		});
		expect(row.scrollWidth).toBeLessThanOrEqual(row.width + 1);
		if (row.kind === "team-chip" || row.kind === "team-event")
			expect(row.textHeight).toBeLessThanOrEqual(row.textLineHeight + 1);
	}
}

async function screenshot(name: string): Promise<void> {
	if (!shots) return;
	mkdirSync(shots, { recursive: true });
	const shot = await page.$("#shot");
	if (!shot) throw new Error("screenshot surface missing");
	await shot.screenshot({ path: join(shots, `team-conversation-${name}.png`) });
}

/** The fixture's local clock for an event `minute`s after its base time (same machine zone). */
function clock(minute: number): string {
	const date = new Date(Date.parse("2026-11-27T02:00:00.000Z") + minute * 60_000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const teamRows = (value: Report) =>
	value.rows
		.filter(
			(row) => row.kind === "team-chip" || row.kind === "team-event" || row.kind === "tool-call",
		)
		.map((row) => (row.kind === "tool-call" ? `card:${row.key}` : row.text));

for (const [width, fontScale] of [
	[360, 100],
	[640, 100],
	[640, 130],
] as const) {
	test(`${width}px at ${fontScale}%: chips and dividers paint at their measured height`, async () => {
		const value = await render({ width, fontScale });
		assertGeometry(value);
		expect(teamRows(value)).toEqual([
			"创建工作项 ×4",
			"设定回访",
			`${clock(10)} · 「修复导出 CSV 时区错误」评审通过`,
			`${clock(10)} · 「结账页改用新支付 SDK」已通过 PR #42 合并`,
			"标为就绪 ×2",
			"card:tool-use-p1",
			`${clock(30)} · 「订单金额统一两位小数」被退回`,
		]);
		const ready = value.rows.find((row) => row.text.startsWith("标为就绪"));
		expect(ready?.error).toBe(true);
		await screenshot(`${width}-${fontScale}`);
	});
}

test("a real click opens a chip onto the ordinary tool cards and folds it back", async () => {
	await render({ width: 640 });
	expect(
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.clickChip("创建工作项")),
	).toBe(true);
	const open = await report();
	assertGeometry(open);
	const chip = open.rows.find((row) => row.text.startsWith("创建工作项"));
	expect(chip?.expanded).toBe("true");
	const index = open.rows.findIndex((row) => row === chip);
	expect(open.rows.slice(index + 1, index + 5).map((row) => row.key)).toEqual([
		"tool-use-c0",
		"tool-use-c1",
		"tool-use-c2",
		"tool-use-c3",
	]);
	await screenshot("expanded");
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.clickChip("创建工作项"));
	const closed = await report();
	assertGeometry(closed);
	expect(closed.rows.some((row) => row.key === "tool-use-c0")).toBe(false);
	expect(closed.rows.find((row) => row.text.startsWith("创建工作项"))?.expanded).toBe("false");
});
