/**
 * The swallowed-content findings (outline P2 PR 12c) in real Chromium: the admin section and the
 * Spec panel's notice, at a phone's width and a desktop's, light and dark, English and Chinese.
 *
 * What must hold:
 *  - the admin section says how the scan is doing (with what it attached), starts one on "Scan
 *    now" (asked once), and lists the findings of one status a page at a time, each with its
 *    session, file and what was lost;
 *  - a finding that is not on its page says why: the session is still in Dynamic Spec (nothing
 *    to attach to, no attach offered), the page's cap, a page that is gone;
 *  - the lost content is read on demand, in a box that scrolls by itself;
 *  - a person's attach of a left-out finding asks first (cancelling does nothing), then asks the
 *    server once; an attached finding links to its block and is dismissed after a question (its
 *    block goes with it), an open one without; a dismissal that kept the block says so and
 *    still links to it; a dismissed finding can be reopened;
 *  - the Spec panel of a session with findings shows one line with how many are attached and
 *    how many are not, and the same list on demand, on the task board of an imported session and
 *    over the files of one that still keeps Dynamic Spec; a reader who may not write gets no
 *    decision buttons; a session without findings has no line;
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

async function chip(page: Page, status: "open" | "attached" | "dismissed"): Promise<void> {
	await page.click(`[data-testid="spec-loss-status-${status}"] label`);
}

const chipText = (page: Page, status: string, label: string) =>
	page.waitForFunction(
		(selector, wanted) => document.querySelector(selector)?.textContent === wanted,
		{},
		`[data-testid="spec-loss-status-${status}"]`,
		label,
	);

test("the admin section: the scan, the findings a page at a time, why not attached, read, attach, dismiss, reopen", async () => {
	for (const [width, scheme] of [
		[360, "light"],
		[1280, "dark"],
	] as const) {
		const { page, errors } = await open(width, { view: "admin", lang: "en", scheme });
		await page.waitForSelector('[data-testid="spec-loss-row"]');
		expect(await text(page, '[data-testid="spec-loss-admin"]')).toContain(en.admin.title);
		expect(await text(page, '[data-testid="spec-loss-scan-status"]')).toContain(
			"Sessions looked at: 12; new findings: 3; attached: 2.",
		);
		await chipText(page, "open", `${en.status.open} (25)`);
		await chipText(page, "attached", `${en.status.attached} (9)`);
		await chipText(page, "dismissed", `${en.status.dismissed} (2)`);
		expect((await rows(page)).length).toBe(20);
		await noSidewaysScroll(page);
		await shot(page, `loss-admin-${width}-${scheme}`);

		// The next page.
		await page.click('[data-testid="spec-loss-more"]');
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid="spec-loss-row"]').length === 25,
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
		expect(await text(page, `${spec} [data-testid="spec-loss-why"]`)).toBe(en.why.not_imported);
		expect(
			await page.$eval(
				`${spec} [data-testid="spec-loss-attach"]`,
				(el) => (el as HTMLButtonElement).disabled,
			),
		).toBe(true);
		expect(await text(page, `${spec} [data-testid="spec-loss-what"]`)).toContain(
			"lost: 2 tables, 1 image",
		);
		// Of the imported session, two were left out, each with its reason.
		expect(await text(page, '[data-finding="f030"] [data-testid="spec-loss-why"]')).toBe(
			en.why.no_page,
		);
		const row = '[data-finding="f027"]';
		expect(await text(page, `${row} [data-testid="spec-loss-why"]`)).toBe(en.why.page_cap);

		// Its lost content, on demand.
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

		// A person's attach of what was left out: asked first; cancelling does nothing.
		await page.click(`${row} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		const dialog = await text(page, '[role="dialog"]');
		expect(dialog).toContain(en.attachTitle);
		expect(dialog).toContain("Nothing else on the page changes");
		await noSidewaysScroll(page);
		const labels = await page.$$eval('[role="dialog"] button', (els) =>
			els.map((el) => el.textContent),
		);
		const cancelLabel = labels.find((label) => label && label !== en.attach);
		if (!cancelLabel) throw new Error(`No cancel button in ${labels.join(", ")}`);
		await pressInDialog(page, cancelLabel);
		await dialogGone(page);
		expect(await calls(page)).toEqual(["scan", "detail:f027"]);

		await page.click(`${row} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		await pressInDialog(page, en.attach);
		await page.waitForFunction((selector) => !document.querySelector(selector), {}, row);
		await dialogGone(page);
		expect(await calls(page)).toEqual(["scan", "detail:f027", "attach:f027"]);
		await chipText(page, "attached", `${en.status.attached} (10)`);

		// An open finding is dismissed without a question: there is no block to go with it.
		await toastsGone(page);
		await page.click('[data-finding="f002"] [data-testid="spec-loss-dismiss"]');
		await page.waitForFunction(() => !document.querySelector('[data-finding="f002"]'));
		expect((await calls(page)).at(-1)).toBe("dismiss:f002");

		// Attached: a link to its block; no attach; dismissed after a question.
		await chip(page, "attached");
		const on = '[data-finding="f000"]';
		await page.waitForSelector(`${on}[data-status="attached"]`);
		expect(
			await page.$eval(`${on} [data-testid="spec-loss-open-block"]`, (el) =>
				el.getAttribute("href"),
			),
		).toEndWith("/outline/space-1/block-0");
		expect(await page.$(`${on} [data-testid="spec-loss-attach"]`)).toBeNull();
		expect(await page.$(`${on} [data-testid="spec-loss-why"]`)).toBeNull();
		await toastsGone(page);
		await page.click(`${on} [data-testid="spec-loss-dismiss"]`);
		await page.waitForSelector('[role="dialog"]');
		const question = await text(page, '[role="dialog"]');
		expect(question).toContain(en.dismissTitle);
		expect(question).toContain("unless someone edited it or wrote under it");
		await noSidewaysScroll(page);
		await pressInDialog(page, en.dismiss);
		await page.waitForFunction((selector) => !document.querySelector(selector), {}, on);
		await dialogGone(page);
		expect((await calls(page)).at(-1)).toBe("dismiss:f000");

		// One whose block someone wrote in: dismissed, the block kept, and said so.
		await toastsGone(page);
		await page.click('[data-finding="f003"] [data-testid="spec-loss-dismiss"]');
		await page.waitForSelector('[role="dialog"]');
		await pressInDialog(page, en.dismiss);
		await page.waitForFunction(
			(message) => document.body.textContent?.includes(message),
			{},
			en.done.dismissKept,
		);
		await dialogGone(page);

		// Dismissed: the kept block is still linked; either can be reopened.
		await chip(page, "dismissed");
		await page.waitForSelector('[data-finding="f003"][data-status="dismissed"]');
		expect(
			await page.$eval('[data-finding="f003"] [data-testid="spec-loss-open-block"]', (el) =>
				el.getAttribute("href"),
			),
		).toEndWith("/outline/space-1/block-3");
		expect(await page.$(`${on} [data-testid="spec-loss-open-block"]`)).toBeNull();
		expect(await page.$(`${on} [data-testid="spec-loss-dismiss"]`)).toBeNull();
		await toastsGone(page);
		await page.click(`${on} [data-testid="spec-loss-reopen"]`);
		await page.waitForFunction((selector) => !document.querySelector(selector), {}, on);
		expect((await calls(page)).at(-1)).toBe("reopen:f000");
		await noSidewaysScroll(page);
		expect(errors).toEqual([]);
		await page.close();
	}

	// Chinese, at a phone's width.
	const { page, errors } = await open(360, { view: "admin", lang: "zh-CN", scheme: "dark" });
	await page.waitForSelector('[data-testid="spec-loss-row"]');
	expect(await text(page, '[data-testid="spec-loss-admin"]')).toContain(zh.admin.title);
	await chipText(page, "open", `${zh.status.open} (25)`);
	expect(await text(page, '[data-finding="f001"] [data-testid="spec-loss-what"]')).toContain(
		zh.kind.table_other.replace("{{count}}", "2"),
	);
	expect(await text(page, '[data-finding="f001"] [data-testid="spec-loss-why"]')).toBe(
		zh.why.not_imported,
	);
	await noSidewaysScroll(page);
	await shot(page, "loss-admin-360-dark-zh");
	expect(errors).toEqual([]);
	await page.close();
}, 120_000);

test("the Spec panel: one line with the numbers, the list on demand; read-only for a reader; none without findings", async () => {
	// An imported session, on its task board: most of its findings are on their pages.
	{
		const { page, errors } = await open(360, { view: "panel", lang: "en", scheme: "light" });
		await page.waitForSelector(
			'[data-testid="outline-tasks-panel"] [data-testid="spec-loss-notice"]',
		);
		const line = (attached: number, left: number) =>
			en.notice.replace("{{attached}}", String(attached)).replace("{{open}}", String(left));
		expect(await text(page, '[data-testid="spec-loss-notice"]')).toContain(line(9, 4));
		expect(await page.$('[data-testid="spec-loss-row"]')).toBeNull();
		await page.click('[data-testid="spec-loss-notice-toggle"]');
		// The ones that are not attached first.
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid="spec-loss-row"]').length === 4,
		);
		expect(await text(page, '[data-testid="spec-loss-notice"]')).toContain(en.explain);
		await chip(page, "attached");
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid="spec-loss-row"]').length === 9,
		);
		expect(
			await page.$('[data-finding="f000"] [data-testid="spec-loss-open-block"]'),
		).not.toBeNull();
		await noSidewaysScroll(page);
		await shot(page, "loss-panel-board-360-light");
		await page.click('[data-finding="f000"] [data-testid="spec-loss-dismiss"]');
		await page.waitForSelector('[role="dialog"]');
		await pressInDialog(page, en.dismiss);
		await page.waitForFunction(
			(wanted) =>
				document.querySelector('[data-testid="spec-loss-notice"]')?.textContent?.includes(wanted),
			{},
			line(8, 4),
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
		// Why it is not on a page is said to a reader too, and the content can be read.
		expect(await text(page, '[data-testid="spec-loss-why"]')).toBe(zh.why.not_imported);
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

test("what no pass attaches: the behavior page asks with its own warning; other kinds are listed; a deleted block is said", async () => {
	for (const [lang, strings, scheme] of [
		["en", en, "light"],
		["zh-CN", zh, "dark"],
	] as const) {
		const { page, errors } = await open(360, { view: "admin", lang, scheme });
		await page.waitForSelector('[data-testid="spec-loss-row"]');
		await page.click('[data-testid="spec-loss-more"]');
		const rule = '[data-finding="f901"]';
		const listed = '[data-finding="f902"]';
		await page.waitForSelector(rule);
		// Each says why it is only listed.
		expect(await text(page, `${rule} [data-testid="spec-loss-why"]`)).toBe(strings.why.rule_page);
		expect(await text(page, `${listed} [data-testid="spec-loss-why"]`)).toBe(strings.why.list_only);
		expect(await text(page, `${rule} [data-testid="spec-loss-path"]`)).toBe("behavior_fence");
		await noSidewaysScroll(page);
		await shot(page, `loss-listed-360-${scheme}-${lang}`);

		// The behavior page: a warning of its own; cancelling asks the server nothing.
		await page.click(`${rule} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		const warning = await text(page, '[role="dialog"]');
		expect(warning).toContain(strings.attachRuleTitle);
		expect(warning).toContain(strings.attachRuleConfirm);
		expect(warning).not.toContain(strings.attachTitle);
		await noSidewaysScroll(page);
		await shot(page, `loss-rule-confirm-360-${scheme}-${lang}`);
		const labels = await page.$$eval('[role="dialog"] button', (els) =>
			els.map((el) => el.textContent),
		);
		const cancelLabel = labels.find((label) => label && label !== strings.attachRule);
		if (!cancelLabel) throw new Error(`No cancel button in ${labels.join(", ")}`);
		await pressInDialog(page, cancelLabel);
		await dialogGone(page);
		expect(await calls(page)).toEqual([]);
		expect(await page.$(rule)).not.toBeNull();
		// Confirmed: the request says so.
		await page.click(`${rule} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		await pressInDialog(page, strings.attachRule);
		await page.waitForFunction((selector) => !document.querySelector(selector), {}, rule);
		await dialogGone(page);
		expect(await calls(page)).toEqual(["attach:f901:rule"]);

		// Content that is not tables: the ordinary question, no rule confirmation sent.
		await toastsGone(page);
		await page.click(`${listed} [data-testid="spec-loss-attach"]`);
		await page.waitForSelector('[role="dialog"]');
		const question = await text(page, '[role="dialog"]');
		expect(question).toContain(strings.attachTitle);
		expect(question).not.toContain(strings.attachRuleConfirm);
		await pressInDialog(page, strings.attach);
		await page.waitForFunction((selector) => !document.querySelector(selector), {}, listed);
		await dialogGone(page);
		expect(await calls(page)).toEqual(["attach:f901:rule", "attach:f902"]);

		// A finding whose block was deleted on the page: dismissed, and it says how.
		await chip(page, "dismissed");
		const deleted = '[data-finding="f903"]';
		await page.waitForSelector(`${deleted}[data-status="dismissed"]`);
		expect(await text(page, `${deleted} [data-testid="spec-loss-why"]`)).toBe(
			strings.why.block_deleted,
		);
		// One a person dismissed says nothing more.
		expect(await page.$('[data-finding="f900"] [data-testid="spec-loss-why"]')).toBeNull();
		expect(await page.$(`${deleted} [data-testid="spec-loss-reopen"]`)).not.toBeNull();
		await noSidewaysScroll(page);
		expect(errors).toEqual([]);
		await page.close();
	}
}, 90_000);
