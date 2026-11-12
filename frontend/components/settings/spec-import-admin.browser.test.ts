/**
 * The Dynamic Spec import's admin view and the Spec panel's read-only line (outline P2 PR 12b2),
 * in real Chromium, at a phone's width and a desktop's, light and dark, English and Chinese.
 *
 * What must hold:
 *  - the admin view shows the mode, a count per state, and one state's sessions with what may be
 *    done to each; "Load more" reads the next page; moving a session back asks first and, once
 *    confirmed, asks the server once and the row leaves the state's list; re-importing a moved-
 *    back session asks the server once;
 *  - the old Spec files of a session the import moved carry the read-only line with a link to its
 *    task page; a session created in the outline has none;
 *  - nothing scrolls sideways at 360 px.
 *
 * The suite owns only an ephemeral static server and browser; the API is the fixture's
 * in-memory stand-in (`spec-import-admin.browser-fixture.tsx`). No fixed sleeps: every wait is
 * for a condition. Assertions do not depend on CJK glyph widths or line counts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import narratorEn from "../../locales/en/narrator.json";
import en from "../../locales/en/settings.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import zh from "../../locales/zh-CN/settings.json";
import type * as Fixture from "./spec-import-admin.browser-fixture";

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

/** A directory to save screenshots to (optional, for looking at the layout by eye). */
const SHOTS = process.env.NF_SPEC_IMPORT_SHOTS ?? null;

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
		entrypoints: [new URL("./spec-import-admin.browser-fixture.tsx", import.meta.url).pathname],
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

const rows = (page: Page) =>
	page.$$eval('[data-testid="spec-import-admin-row"]', (els) =>
		els.map((el) => el.getAttribute("data-narrator")),
	);

test("the admin view: counts, a state's sessions a page at a time, move back and re-import", async () => {
	for (const [width, scheme] of [
		[360, "light"],
		[1280, "dark"],
	] as const) {
		const { page, errors } = await open(width, { view: "admin", lang: "en", scheme });
		await page.waitForSelector('[data-testid="spec-import-admin-row"]');
		expect(await page.$eval('[data-testid="spec-import-admin-mode"]', (el) => el.textContent)).toBe(
			en.specImportAdminMode.auto,
		);
		// "Needs attention" first, with its count; the other states with theirs.
		expect(
			await page.$eval('[data-testid="spec-import-state-attention"]', (el) => el.textContent),
		).toBe(`${en.specImportAdminState.attention} (3)`);
		expect(
			await page.$eval('[data-testid="spec-import-state-imported"]', (el) => el.textContent),
		).toBe(`${en.specImportAdminState.imported} (25)`);
		expect((await rows(page)).length).toBe(3);
		const reasons = await page.$$eval('[data-testid="spec-import-admin-reason"]', (els) =>
			els.map((el) => el.textContent),
		);
		expect(reasons[0]).toContain(
			narratorEn.spec.specImportReason.kept_blocks.replace("{{n}}", "3"),
		);
		await noSidewaysScroll(page);

		// The imported ones: 20, then the other 5.
		await page.click('[data-testid="spec-import-state-imported"] label');
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid="spec-import-admin-row"]').length === 20,
		);
		expect(await page.$$('[data-testid="spec-import-admin-reimport"]')).toHaveLength(0);
		await page.click('[data-testid="spec-import-admin-more"]');
		await page.waitForFunction(
			() => document.querySelectorAll('[data-testid="spec-import-admin-row"]').length === 25,
		);
		expect(await page.$('[data-testid="spec-import-admin-more"]')).toBeNull();
		await noSidewaysScroll(page);

		// Move the first back: asked first; cancelling does nothing.
		const first = (await rows(page))[0] as string;
		await page.click(`[data-narrator="${first}"] [data-testid="spec-import-admin-revert"]`);
		await page.waitForSelector('[role="dialog"]');
		const dialog = await page.$eval('[role="dialog"]', (el) => el.textContent ?? "");
		expect(dialog).toContain(en.specImportAdminRevertTitle);
		expect(dialog).toContain("Nothing in the outline or in Dynamic Spec is deleted");
		await noSidewaysScroll(page);
		await shot(page, `admin-confirm-${width}-${scheme}`);
		const buttons = await page.$$('[role="dialog"] button');
		const labels = await Promise.all(buttons.map((b) => b.evaluate((el) => el.textContent)));
		const confirmButton = buttons[labels.indexOf(en.specImportAdminRevert)];
		if (!confirmButton) throw new Error(`No confirm button in ${labels.join(", ")}`);
		await confirmButton.click();
		await page.waitForFunction(
			(id) => !document.querySelector(`[data-narrator="${id}"]`),
			{},
			first,
		);
		expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.calls)).toEqual([
			`revert:${first}`,
		]);
		await page.waitForFunction(
			(label) =>
				document.querySelector('[data-testid="spec-import-state-reverted"]')?.textContent === label,
			{},
			`${en.specImportAdminState.reverted} (2)`,
		);

		// Moved back: re-import from there (once the dialog and its overlay are gone).
		await page.waitForFunction(
			() =>
				!document.querySelector('[role="dialog"]') &&
				!document.querySelector(".mantine-Modal-overlay"),
		);
		await page.click('[data-testid="spec-import-state-reverted"] label');
		await page.waitForSelector(
			`[data-narrator="${first}"] [data-testid="spec-import-admin-reimport"]`,
		);
		await page.click(`[data-narrator="${first}"] [data-testid="spec-import-admin-reimport"]`);
		await page.waitForFunction(
			(id) => !document.querySelector(`[data-narrator="${id}"]`),
			{},
			first,
		);
		expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.calls)).toEqual([
			`revert:${first}`,
			`reimport:${first}`,
		]);
		await noSidewaysScroll(page);
		expect(errors).toEqual([]);
		await page.close();
	}

	// Chinese, at a phone's width.
	const { page, errors } = await open(360, { view: "admin", lang: "zh-CN", scheme: "dark" });
	await page.waitForSelector('[data-testid="spec-import-admin-row"]');
	expect(await page.$eval('[data-testid="spec-import-admin"]', (el) => el.textContent)).toContain(
		zh.specImportAdminTitle,
	);
	expect(
		await page.$eval('[data-testid="spec-import-state-attention"]', (el) => el.textContent),
	).toBe(`${zh.specImportAdminState.attention} (3)`);
	await noSidewaysScroll(page);
	await shot(page, "admin-360-dark-zh");
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);

test("the old Spec files of a moved session: the read-only line and its link; none for one created in the outline", async () => {
	for (const [width, scheme, lang] of [
		[360, "light", "en"],
		[1280, "dark", "zh-CN"],
	] as const) {
		const { page, errors } = await open(width, { view: "panel", lang, scheme });
		await page.waitForSelector('[data-testid="outline-tasks-legacy"]');
		await page.click('[data-testid="outline-tasks-legacy"]');
		await page.waitForSelector('[data-testid="spec-moved-notice"]');
		const spec = lang === "en" ? narratorEn.spec : narratorZh.spec;
		const notice = await page.$eval('[data-testid="spec-moved-notice"]', (el) => el.textContent);
		expect(notice).toContain(spec.specImportMovedTitle);
		expect(notice).toContain(spec.specImportMovedBody);
		const link = await page.$eval('[data-testid="spec-moved-open"]', (el) => ({
			text: el.textContent,
			href: el.getAttribute("href"),
		}));
		expect(link.text).toBe(spec.specImportMovedOpen);
		expect(link.href).toEndWith("/outline/space-1/page-1");
		// The old files below it are read-only: no editor, a way back to the board.
		await page.waitForSelector('[data-testid="spec-tasks-readonly"]');
		expect(await page.$('[data-testid="outline-tasks-back"]')).not.toBeNull();
		await noSidewaysScroll(page);
		await shot(page, `panel-${width}-${scheme}-${lang}`);
		expect(errors).toEqual([]);
		await page.close();
	}
	const { page, errors } = await open(360, {
		view: "panel",
		lang: "en",
		scheme: "light",
		switched: false,
	});
	await page.waitForSelector('[data-testid="outline-tasks-legacy"]');
	await page.click('[data-testid="outline-tasks-legacy"]');
	await page.waitForSelector('[data-testid="spec-tasks-readonly"]');
	expect(await page.$('[data-testid="spec-moved-notice"]')).toBeNull();
	expect(errors).toEqual([]);
	await page.close();
}, 60_000);
