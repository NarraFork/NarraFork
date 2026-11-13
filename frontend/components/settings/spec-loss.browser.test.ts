/**
 * The swallowed-content findings (outline P2 PR 12c) in real Chromium: the admin section and the
 * Spec panel's notice, at a phone's width and a desktop's, light and dark, English and Chinese.
 *
 * What must hold:
 *  - the admin section says how the scan is doing, starts one on "Scan now" (asked once), and
 *    lists the findings of one status a page at a time, each with its session, file and what was
 *    lost; a finding of a session still in Dynamic Spec cannot be attached and says why;
 *  - the lost content is read on demand, in a box that scrolls by itself;
 *  - attaching asks first (cancelling does nothing), then asks the server once; the finding
 *    leaves the open list and is listed as attached with a link to its block; dismissing asks the
 *    server once, and a dismissed finding can be reopened;
 *  - the Spec panel of a session with findings shows one line with their number and the same
 *    list on demand, on the task board of an imported session and over the files of one that
 *    still keeps Dynamic Spec; a reader who may not write gets no decision buttons; a session
 *    without findings has no line;
 *  - nothing scrolls sideways at 360 px.
 *
 * The suite owns only an ephemeral static server and browser; the API is the fixture's
 * in-memory stand-in (`spec-loss.browser-fixture.tsx`). No fixed sleeps: every wait is for a
 * condition. Assertions do not depend on CJK glyph widths or line counts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import narratorEn from "../../locales/en/narrator.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import type * as Fixture from "./spec-loss.browser-fixture";

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

/** A directory to save screenshots to (optional, for looking at the layout by eye). */
const SHOTS = process.env.NF_SPEC_LOSS_SHOTS ?? null;

type FixtureWindow = Window & { fixture: typeof Fixture };

async function shot(page: Page, name: string): Promise<void> {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
	if (!existsSync(executablePath))
		throw new Error(`Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./spec-loss.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	if (!script) throw new Error("Browser fixture bundle has no JavaScript output");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1">
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					<style>html,body { margin: 0; }</style>
					</head><body><div id="root"></div><script type="module">
					window.fixture = await import(${JSON.stringify(script)});
					</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
}, 60_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

async function open(
	width: number,
	options: Parameters<typeof Fixture.mount>[0],
): Promise<{ page: Page; errors: string[] }> {
	if (!browser || !server) throw new Error("Browser fixture not initialized");
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.origin !== server?.url.origin) errors.push(`unexpected request: ${url.href}`);
	});
	await page.setViewport({ width, height: 800 });
	await page.goto(server.url.href, { waitUntil: "networkidle0" });
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
	await page.evaluate(
		(opts) => (window as unknown as FixtureWindow).fixture.mount(opts),
		options as never,
	);
	return { page, errors };
}

async function noSidewaysScroll(page: Page): Promise<void> {
	const report = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.overflow());
	expect(report.offenders).toEqual([]);
	expect(report.scroll).toBeLessThanOrEqual(report.client);
}

const en = narratorEn.spec.loss;
const zh = narratorZh.spec.loss;

const rows = (page: Page) =>
	page.$$eval('[data-testid="spec-loss-row"]', (els) =>
		els.map((el) => el.getAttribute("data-finding")),
	);

const calls = (page: Page) =>
	page.evaluate(() => [...(window as unknown as FixtureWindow).fixture.calls]);

const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent ?? "");

async function dialogGone(page: Page): Promise<void> {
	await page.waitForFunction(
		() =>
			!document.querySelector('[role="dialog"]') &&
			!document.querySelector(".mantine-Modal-overlay"),
	);
}

/** Toasts close by themselves; one may lie over a button at a phone's width. */
async function toastsGone(page: Page): Promise<void> {
	await page.waitForFunction(() => !document.querySelector(".mantine-Notification-root"));
}

async function pressInDialog(page: Page, label: string): Promise<void> {
	const buttons = await page.$$('[role="dialog"] button');
	const labels = await Promise.all(buttons.map((b) => b.evaluate((el) => el.textContent)));
	const button = buttons[labels.indexOf(label)];
	if (!button) throw new Error(`No "${label}" button in ${labels.join(", ")}`);
	await button.click();
}

test("the admin section: the scan, the findings a page at a time, read, attach, dismiss, reopen", async () => {
	for (const [width, scheme] of [
		[360, "light"],
		[1280, "dark"],
	] as const) {
		const { page, errors } = await open(width, { view: "admin", lang: "en", scheme });
		await page.waitForSelector('[data-testid="spec-loss-row"]');
		expect(await text(page, '[data-testid="spec-loss-admin"]')).toContain(en.admin.title);
		const status = await text(page, '[data-testid="spec-loss-scan-status"]');
		expect(status).toContain("Sessions looked at: 12; new findings: 3.");
		expect(await text(page, '[data-testid="spec-loss-status-open"]')).toBe(
			`${en.status.open} (26)`,
		);
		expect(await text(page, '[data-testid="spec-loss-status-dismissed"]')).toBe(
			`${en.status.dismissed} (1)`,
		);
		expect((await rows(page)).length).toBe(20);
		await noSidewaysScroll(page);
		await shot(page, `loss-admin-${width}-${scheme}`);

		// The next page.
		await page.click('[data-testid="spec-loss-more"]');
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid="spec-loss-row"]').length === 26,
		);
		expect(await page.$('[data-testid="spec-loss-more"]')).toBeNull();

		// Scan now: asked once, then shown as running and the button rests.
		await page.click('[data-testid="spec-loss-scan-now"]');
		await page.waitForFunction(
			(running) =>
				document.querySelector('[data-testid="spec-loss-scan-status"]')?.textContent === running,
			{},
			en.admin.scanRunning,
		);
		expect(await calls(page)).toEqual(["scan"]);
		expect(
			await page.$eval(
				'[data-testid="spec-loss-scan-now"]',
				(el) => (el as HTMLButtonElement).disabled,
			),
		).toBe(true);

		// f001 is of a session still in Dynamic Spec: it says so and cannot be attached.
		const spec = '[data-finding="f001"]';
		expect(await text(page, `${spec} [data-testid="spec-loss-not-imported"]`)).toBe(en.notImported);
		expect(
			await page.$eval(
				`${spec} [data-testid="spec-loss-attach"]`,
				(el) => (el as HTMLButtonElement).disabled,
			),
		).toBe(true);
		expect(await text(page, `${spec} [data-testid="spec-loss-what"]`)).toContain(
			"lost: 2 tables, 1 image",
		);

		// f000 is of the imported session. Its lost content, on demand.
		const row = '[data-finding="f000"]';
		expect(await page.$(`${row} [data-testid="spec-loss-not-imported"]`)).toBeNull();
		await page.click(`${row} [data-testid="spec-loss-view"]`);
		await page.waitForFunction(
			(selector) => document.querySelector(`${selector} pre`)?.textContent?.includes("alpha"),
			{},
			row,
		);
		// Opened (the collapse laid it out).
		await page.waitForFunction(
			(selector) => (document.querySelector(`${selector} pre`)?.clientWidth ?? 0) > 0,
			{},
			row,
		);
		// The wide table scrolls in its own box, not the page.
		const box = await page.$eval(`${row} pre`, (el) => ({
			scroll: el.scrollWidth,
			client: el.clientWidth,
			overflow: getComputedStyle(el).overflowX,
		}));
		expect(box.overflow).toBe("auto");
		if (width === 360) expect(box.scroll).toBeGreaterThan(box.client);
		await noSidewaysScroll(page);
		await shot(page, `loss-admin-detail-${width}-${scheme}`);

		// Attach: asked first; cancelling does nothing.
		await page.click(`${row} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		const dialog = await text(page, '[role="dialog"]');
		expect(dialog).toContain(en.attachTitle);
		expect(dialog).toContain("Nothing else on the page changes");
		await noSidewaysScroll(page);
		const cancel = (await page.$$('[role="dialog"] button')).at(-2);
		const labels = await page.$$eval('[role="dialog"] button', (els) =>
			els.map((el) => el.textContent),
		);
		const cancelLabel = labels.find((label) => label && label !== en.attach);
		if (!cancel || !cancelLabel) throw new Error(`No cancel button in ${labels.join(", ")}`);
		await pressInDialog(page, cancelLabel);
		await dialogGone(page);
		expect(await calls(page)).toEqual(["scan", "detail:f000"]);

		await page.click(`${row} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		await pressInDialog(page, en.attach);
		await page.waitForFunction((selector) => !document.querySelector(selector), {}, row);
		await dialogGone(page);
		expect(await calls(page)).toEqual(["scan", "detail:f000", "attach:f000"]);
		await page.waitForFunction(
			(label) =>
				document.querySelector('[data-testid="spec-loss-status-attached"]')?.textContent === label,
			{},
			`${en.status.attached} (1)`,
		);

		// Dismiss another: asked once, no dialog.
		await toastsGone(page);
		await page.click('[data-finding="f002"] [data-testid="spec-loss-dismiss"]');
		await page.waitForFunction(() => !document.querySelector('[data-finding="f002"]'));
		expect((await calls(page)).at(-1)).toBe("dismiss:f002");

		// Attached: listed with a link to its block, nothing more to decide.
		await page.click('[data-testid="spec-loss-status-attached"] label');
		await page.waitForSelector(`${row}[data-status="attached"]`);
		expect(
			await page.$eval(`${row} [data-testid="spec-loss-open-block"]`, (el) =>
				el.getAttribute("href"),
			),
		).toEndWith("/outline/space-1/block-1");
		expect(await page.$(`${row} [data-testid="spec-loss-attach"]`)).toBeNull();
		expect(await page.$(`${row} [data-testid="spec-loss-dismiss"]`)).toBeNull();

		// Dismissed: can be reopened.
		await page.click('[data-testid="spec-loss-status-dismissed"] label');
		await page.waitForSelector('[data-finding="f002"][data-status="dismissed"]');
		await toastsGone(page);
		await page.click('[data-finding="f002"] [data-testid="spec-loss-reopen"]');
		await page.waitForFunction(() => !document.querySelector('[data-finding="f002"]'));
		expect((await calls(page)).at(-1)).toBe("reopen:f002");
		await noSidewaysScroll(page);
		expect(errors).toEqual([]);
		await page.close();
	}

	// Chinese, at a phone's width.
	const { page, errors } = await open(360, { view: "admin", lang: "zh-CN", scheme: "dark" });
	await page.waitForSelector('[data-testid="spec-loss-row"]');
	expect(await text(page, '[data-testid="spec-loss-admin"]')).toContain(zh.admin.title);
	expect(await text(page, '[data-testid="spec-loss-status-open"]')).toBe(`${zh.status.open} (26)`);
	expect(await text(page, '[data-finding="f001"] [data-testid="spec-loss-what"]')).toContain(
		zh.kind.table_other.replace("{{count}}", "2"),
	);
	await noSidewaysScroll(page);
	await shot(page, "loss-admin-360-dark-zh");
	expect(errors).toEqual([]);
	await page.close();
}, 90_000);

test("the Spec panel: one line with the number, the list on demand; read-only for a reader; none without findings", async () => {
	// An imported session, on its task board: its findings can be attached.
	{
		const { page, errors } = await open(360, { view: "panel", lang: "en", scheme: "light" });
		await page.waitForSelector(
			'[data-testid="outline-tasks-panel"] [data-testid="spec-loss-notice"]',
		);
		const mine = 9; // f000, f003, … f024 are the first session's.
		expect(await text(page, '[data-testid="spec-loss-notice"]')).toContain(
			en.notice.replace("{{n}}", String(mine)),
		);
		expect(await page.$('[data-testid="spec-loss-row"]')).toBeNull();
		await page.click('[data-testid="spec-loss-notice-toggle"]');
		await page.waitForFunction(
			(n) => document.querySelectorAll('[data-testid="spec-loss-row"]').length === n,
			{},
			mine,
		);
		expect(await text(page, '[data-testid="spec-loss-notice"]')).toContain(en.explain);
		expect(
			await page.$eval(
				'[data-finding="f000"] [data-testid="spec-loss-attach"]',
				(el) => (el as HTMLButtonElement).disabled,
			),
		).toBe(false);
		await noSidewaysScroll(page);
		await shot(page, "loss-panel-board-360-light");
		await toastsGone(page);
		await page.click('[data-finding="f000"] [data-testid="spec-loss-dismiss"]');
		await page.waitForFunction(
			(line) =>
				document.querySelector('[data-testid="spec-loss-notice"]')?.textContent?.includes(line),
			{},
			en.notice.replace("{{n}}", String(mine - 1)),
		);
		expect(await calls(page)).toEqual(["dismiss:f000"]);
		expect(errors).toEqual([]);
		await page.close();
	}
	// A session that still keeps Dynamic Spec, over its files, read by someone who may not write.
	{
		const { page, errors } = await open(1280, {
			view: "panel",
			lang: "zh-CN",
			scheme: "dark",
			narratorId: "s002",
			canAct: false,
		});
		await page.waitForSelector('[data-testid="spec-loss-notice"]');
		expect(await page.$('[data-testid="outline-tasks-panel"]')).toBeNull();
		await page.click('[data-testid="spec-loss-notice-toggle"]');
		await page.waitForSelector('[data-testid="spec-loss-row"]');
		expect(await page.$('[data-testid="spec-loss-attach"]')).toBeNull();
		expect(await page.$('[data-testid="spec-loss-dismiss"]')).toBeNull();
		expect(await page.$('[data-testid="spec-loss-not-imported"]')).toBeNull();
		// Reading the lost content is still offered.
		expect(await text(page, '[data-testid="spec-loss-view"]')).toBe(zh.view);
		await noSidewaysScroll(page);
		await shot(page, "loss-panel-files-1280-dark-zh");
		expect(errors).toEqual([]);
		await page.close();
	}
	// No findings: no line.
	{
		const { page, errors } = await open(360, {
			view: "panel",
			lang: "en",
			scheme: "light",
			empty: true,
		});
		await page.waitForSelector('[data-testid="outline-tasks-legacy"]');
		expect(await page.$('[data-testid="spec-loss-notice"]')).toBeNull();
		expect(errors).toEqual([]);
		await page.close();
	}
}, 60_000);
