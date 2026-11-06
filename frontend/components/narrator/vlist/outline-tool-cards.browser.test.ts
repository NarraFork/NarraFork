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
for (const width of [360, 720]) {
	CASES.push({
		name: `longspace-${width}`,
		options: { scene: "longspace", width, scheme: "light", expanded: true },
	});
}
// A drilled-in card on a phone is narrower than the phone: English words are the longest.
for (const width of [300, 320]) {
	CASES.push({
		name: `longspace-${width}-en`,
		options: { scene: "longspace", width, scheme: "dark", expanded: true, lang: "en" },
	});
}
// Folded answers at 720: English, enlarged type, an answer longer than the line.
for (const scene of ["answers", "longanswer"]) {
	for (const lang of ["en", "zh-CN"] as const) {
		for (const big of [false, true]) {
			if (scene === "answers" && lang === "zh-CN" && !big) continue; // `answers-folded-720`
			CASES.push({
				name: `${scene}-folded-720-${lang}${big ? "-enlarged" : ""}`,
				options: {
					scene,
					width: 720,
					scheme: "dark",
					expanded: false,
					lang,
					...(big ? ENLARGED : {}),
				},
			});
		}
	}
}
CASES.push(
	{
		name: "pending-360-en-enlarged",
		options: {
			scene: "pending",
			width: 360,
			scheme: "dark",
			expanded: true,
			lang: "en",
			...ENLARGED,
		},
	},
	{
		name: "pending-360",
		options: { scene: "pending", width: 360, scheme: "dark", expanded: true },
	},
	{
		name: "edit-360-en-enlarged",
		options: { scene: "edit", width: 360, scheme: "dark", expanded: true, lang: "en", ...ENLARGED },
	},
);
CASES.push(
	{
		name: "answers-360",
		options: { scene: "answers", width: 360, scheme: "dark", expanded: true },
	},
	{
		name: "answers-360-enlarged",
		options: { scene: "answers", width: 360, scheme: "dark", expanded: true, ...ENLARGED },
	},
	{
		name: "answers-folded-720",
		options: { scene: "answers", width: 720, scheme: "dark", expanded: false },
	},
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
			// No chip is pushed off its row's one line, or cut at its edge.
			expect({ where, hidden: card.hiddenChips }).toEqual({ where, hidden: [] });
			// A short id (an alias, a change's label) is never truncated: half of one names nothing.
			expect({ where, cut: card.cutIds }).toEqual({ where, cut: [] });
		}
		if (options.scene === "longspace") {
			const [read, edit] = cards;
			const en = options.lang === "en";
			// A long project name gives way: the past version and the cut read still show.
			expect(read?.text).toContain(en ? "as of #5" : "截至 #5");
			expect(read?.text).toContain(en ? "more not shown" : "未全部显示");
			expect(read?.text).toContain("NarraFork outline display");
			// An untitled block on the path is named in the reader's language.
			expect(read?.text).toContain(
				en ? "Design › untitled › Retry design notes" : "Design › 无标题 › Retry design notes",
			);
			expect(edit?.text).toContain("Prj9Atlas");
			// A block that was not a task before is "not a task", not "no longer a task".
			if (!en) {
				expect(edit?.text).toContain("不是任务");
				expect(edit?.text).not.toContain("不再是任务");
			}
		}
		if (options.scene === "answers" && options.expanded) {
			const [notice] = cards;
			// Each answer has its own row, readable beside nothing else.
			expect(notice?.answers.map((a) => a.text)).toEqual([
				"→ 选 2. 消息气泡右上角；采纳了你的建议",
				"→ “先只修 Anthropic，Codex 下周”",
			]);
			for (const answer of notice?.answers ?? []) expect(answer.width).toBeGreaterThan(100);
		}
		if ((options.scene === "answers" || options.scene === "longanswer") && !options.expanded) {
			const [notice] = cards;
			const tail = notice?.tail ?? { width: 0, full: 1 };
			// Folded: the answer has the line's room beside the long question: all of it when it
			// fits in a little under half the line, and at least that much when it is longer.
			expect(tail.width).toBeGreaterThanOrEqual(
				Math.min(tail.full, Math.floor(0.45 * (notice?.width ?? 0))),
			);
			if (options.scene === "answers") expect(tail.width).toBe(tail.full);
		}
		if (options.scene === "pending") {
			const [waiting, held] = cards;
			// A decision still waiting (for its approval, or running) is what it asks for, never a
			// failure: no red row, the header says it is being written.
			expect(waiting?.text).not.toMatch(/Could not|未能/);
			expect(waiting?.text).toMatch(/Writing: |写入中：/);
			// An older held edit says it waits for confirmation, never that it was done.
			expect(held?.text).toMatch(/^OutlineEdit(Awaiting confirmation: |待确认：)/);
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
