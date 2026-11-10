/**
 * The old Dynamic Spec cards in an outline session, laid out by Chromium (outline P2 PR 12a): the
 * fork-carryover and context-cleared cards keep the exact geometry the measure pass gave them and
 * that a spec session's card has (every button in the same box), "Clear" and "Reset Spec" paint
 * as disabled buttons do (the existing convention for a button without a handler) and do nothing
 * when clicked, a hover or tap on them says why in the reader's language, and "View tasks" still
 * opens the task board. In English and Chinese, light and dark, at phone width and wider.
 *
 * NF_SPEC_CARD_SHOTS=<dir> also writes a screenshot of each case there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import enNarrator from "../../../locales/en/narrator.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import type * as Fixture from "./spec-carryover-readonly.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const shots = process.env.NF_SPEC_CARD_SHOTS;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "spec-carryover-readonly.browser-fixture.tsx")],
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
	await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 });
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
	{ name: "en-light-360", options: { width: 360, scheme: "light", language: "en" } },
	{ name: "en-dark-720", options: { width: 720, scheme: "dark", language: "en" } },
	{ name: "zh-dark-360", options: { width: 360, scheme: "dark", language: "zh-CN" } },
	{ name: "zh-light-720", options: { width: 720, scheme: "light", language: "zh-CN" } },
];

const HINT = {
	en: enNarrator.specCarryoverOutlineReadonly,
	"zh-CN": zhNarrator.specCarryoverOutlineReadonly,
};

/** Hover the nth read-only button of the outline cards and read the tooltip it opens. */
async function hintOf(index: number): Promise<string> {
	const handles = await page.$$("[data-backend='outline'] [data-readonly-spec-action]");
	const handle = handles[index];
	if (!handle) throw new Error(`no read-only button ${index}`);
	await handle.hover();
	const tip = await page.waitForSelector("[role='tooltip']", { visible: true, timeout: 5_000 });
	const text = (await tip?.evaluate((node) => node.textContent ?? "")) ?? "";
	await page.mouse.move(0, 0);
	await page.waitForSelector("[role='tooltip']", { hidden: true, timeout: 5_000 });
	return text;
}

for (const { name, options } of CASES) {
	test(`old spec cards in an outline session: read-only in place (${name})`, async () => {
		await page.evaluate(
			(o) => (window as unknown as FixtureWindow).fixture.render(o),
			options as never,
		);
		const cards = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
		expect(cards.map((card) => card.backend)).toEqual([
			"spec",
			"spec",
			"outline",
			"outline",
			"none",
			"none",
		]);
		for (const card of cards) {
			// Painted exactly as measured, whatever the buttons' state.
			expect({ backend: card.backend, painted: card.painted }).toEqual({
				backend: card.backend,
				painted: card.measured,
			});
			expect(card.buttons).toHaveLength(3);
		}
		for (const at of [0, 1]) {
			const spec = cards[at] as Fixture.CardReport;
			const outline = cards[at + 2] as Fixture.CardReport;
			const none = cards[at + 4] as Fixture.CardReport;
			// No layout change: the same heights and the same button boxes.
			expect(outline.measured).toBe(spec.measured);
			const box = (b: Fixture.ButtonReport) => [b.text, b.x, b.y, b.width, b.height];
			expect(outline.buttons.map(box)).toEqual(spec.buttons.map(box));
			// "View tasks" is live; "Clear" and "Reset Spec" are disabled, painted as a button
			// without a handler is (the card with none injected), but reachable for the hint.
			const [view, clear, reset] = outline.buttons as Fixture.ButtonReport[];
			expect(view).toMatchObject({ disabled: false, ariaDisabled: null, dataDisabled: false });
			for (const [i, button] of [clear, reset].entries()) {
				expect(button).toMatchObject({ disabled: false, ariaDisabled: "true", dataDisabled: true });
				const native = none.buttons[i + 1] as Fixture.ButtonReport;
				expect(native.disabled).toBe(true);
				expect({ color: button?.color, background: button?.background }).toEqual({
					color: native.color,
					background: native.background,
				});
				expect(button?.cursor).toBe("not-allowed");
			}
		}

		// Clicking the read-only buttons does nothing; "View tasks" opens the board.
		const outlineButtons = await page.$$("[data-backend='outline'] button");
		for (const button of outlineButtons) await button.click();
		const ran = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.ran());
		expect(ran).toEqual(["outline:view", "outline:view"]);
		await page.mouse.move(0, 0);
		await page.waitForSelector("[role='tooltip']", { hidden: true, timeout: 5_000 });

		// The hint, in the reader's language, on both read-only buttons.
		expect(await hintOf(0)).toBe(HINT[options.language]);
		expect(await hintOf(3)).toBe(HINT[options.language]);

		if (shots) {
			mkdirSync(shots, { recursive: true });
			const shot = await page.$("#shot");
			await shot?.screenshot({ path: join(shots, `spec-cards-${name}.png`) });
			// With the hint open over "Clear", for the record.
			const [, clear] = await page.$$("[data-backend='outline'] button");
			await clear?.hover();
			await page.waitForSelector("[role='tooltip']", { visible: true, timeout: 5_000 });
			const area = await page.$("#shot");
			const bounds = await area?.boundingBox();
			if (bounds)
				await page.screenshot({
					path: join(shots, `spec-cards-${name}-hint.png`),
					clip: {
						x: bounds.x,
						y: bounds.y,
						width: bounds.width,
						height: Math.min(bounds.height, 900),
					},
				});
			await page.mouse.move(0, 0);
			await page.waitForSelector("[role='tooltip']", { hidden: true, timeout: 5_000 });
		}
	});
}
