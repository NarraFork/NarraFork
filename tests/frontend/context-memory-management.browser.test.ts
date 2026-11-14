import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import en from "../../frontend/locales/en/settings.json";
import zh from "../../frontend/locales/zh-CN/settings.json";
import { startMemoryBrowserServer } from "./context-memory-browser-server";

const executablePath = process.env.NF_TEST_CHROMIUM_PATH;
let browser: Browser | undefined;
let fixture: Awaited<ReturnType<typeof startMemoryBrowserServer>>;
beforeAll(async () => {
	if (!executablePath) return;
	fixture = await startMemoryBrowserServer();
	// Unlike USERPROFILE and os.homedir(), these survive Bun's parallel test preload.
	const accountHome =
		process.env.HOMEDRIVE && process.env.HOMEPATH
			? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
			: process.env.NARRAFORK_ORIGINAL_HOME;
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		// Edge resolves Windows known folders from USERPROFILE before enabling CDP.
		// Restore only the browser child's account path; Puppeteer still owns a fresh
		// temporary browser profile, and the server/database keep their isolated HOME.
		env: {
			...process.env,
			...(process.platform === "win32" && accountHome ? { USERPROFILE: accountHome } : {}),
		},
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.close();
});

async function click(page: Page, label: string, scope = "body") {
	const handle = await page.waitForFunction(
		(text, root) =>
			[...document.querySelectorAll<HTMLButtonElement>(`${root} button`)].find(
				(button) => button.textContent?.trim() === text && !button.disabled,
			),
		{ timeout: 5_000 },
		label,
		scope,
	);
	try {
		const button = handle.asElement();
		if (!button) throw new Error(`Missing button: ${label}`);
		await (await button.toElement("button")).click();
	} finally {
		await handle.dispose();
	}
}
async function textVisible(page: Page, text: string) {
	// Badge casing is CSS; match its DOM text rather than the transformed innerText.
	await page.waitForFunction((value) => document.body.textContent?.includes(value), {}, text);
}
async function layout(page: Page) {
	const measured = await page.evaluate(() => ({
		width: window.innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
		controls: [...document.querySelectorAll("button, input, select, textarea")]
			.map((element) => element.getBoundingClientRect())
			.filter((rect) => rect.width > 0 && rect.height > 0)
			.map((rect) => ({ left: rect.left, right: rect.right, width: rect.width })),
	}));
	expect(measured.scrollWidth).toBeLessThanOrEqual(measured.width + 1);
	expect(measured.controls.length).toBeGreaterThan(3);
	for (const control of measured.controls) {
		expect(control.left).toBeGreaterThanOrEqual(-1);
		expect(control.right).toBeLessThanOrEqual(measured.width + 1);
	}
}
async function capture(page: Page, name: string) {
	const directory = process.env.NF_MEMORY_SCREENSHOTS;
	if (!directory) return;
	await page.waitForFunction(() =>
		document.getAnimations().every((animation) => animation.playState !== "running"),
	);
	await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

for (const width of [1280, 390]) {
	for (const [lang, strings] of [
		["en", en],
		["zh-CN", zh],
	] as const) {
		test.skipIf(!executablePath)(
			`memory lifecycle in a real ${width}px browser (${lang}) with HTTP and SQLite`,
			async () => {
				if (!browser) throw new Error("Chromium did not start");
				fixture.reset();
				const page = await browser.newPage();
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(String(error)));
				page.setDefaultTimeout(5_000);
				try {
					await page.setViewport({
						width,
						height: 900,
						isMobile: width < 600,
						hasTouch: width < 600,
					});
					await page.goto(`${fixture.url}?lang=${lang}`, { waitUntil: "networkidle0" });
					const t = strings.memory;
					await textVisible(page, t.empty);
					await click(page, t.new);
					await page.type('[name="memoryKey"]', "reviewable-memory-".repeat(6));
					const content = `仅运行相关隔离测试。 ${"unbroken-memory-evidence-".repeat(24)} 私密正文结尾`;
					await page.type('[name="memoryContent"]', content);
					await layout(page);
					await click(page, t.saveCandidate);
					await page.waitForSelector('[name="memoryKey"]', { hidden: true });
					expect(fixture.state()).toMatchObject({ status: "candidate", version: 1, content });
					expect(await page.evaluate(() => document.body.innerText)).not.toContain("私密正文结尾");
					expect(
						fixture.requests.some((request) => /\/context-memory\/.+/.test(request.path)),
					).toBe(false);
					await layout(page);
					await capture(page, `memories-${width}-${lang}-list`);

					await click(page, t.review);
					await textVisible(page, "私密正文结尾");
					await textVisible(page, t.audit);
					await layout(page);
					await capture(page, `memories-${width}-${lang}-details`);
					await click(page, t.confirm);
					await textVisible(page, t.status.confirmed);
					expect(fixture.state()).toMatchObject({ status: "confirmed", version: 2 });
					expect(fixture.auditCount()).toBe(2);

					await click(page, t.edit);
					await page.waitForSelector('[name="memoryContent"]');
					await page.type('[name="memoryContent"]', " 已人工修订");
					await click(page, t.saveCandidate);
					await page.waitForSelector('[name="memoryContent"]', { hidden: true });
					await textVisible(page, t.status.candidate);
					expect(fixture.state()).toMatchObject({ status: "candidate", version: 3 });
					expect(fixture.state()?.content).toContain("已人工修订");
					await click(page, t.archive);
					await textVisible(page, t.status.archived);
					expect(fixture.state()).toMatchObject({ status: "archived", version: 4 });
					expect(fixture.auditCount()).toBe(4);
					const deletedId = fixture.state()?.id;

					await click(page, t.forget);
					await page.waitForSelector('[role="dialog"]', { visible: true });
					await layout(page);
					await capture(page, `memories-${width}-${lang}-forget`);
					await click(page, t.cancel, '[role="dialog"]');
					await page.waitForSelector('[role="dialog"]', { hidden: true });
					expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
					expect(fixture.state()).not.toBeNull();
					await click(page, t.forget);
					await page.waitForSelector('[role="dialog"]', { visible: true });
					await click(page, t.forget, '[role="dialog"]');
					await textVisible(page, t.empty);
					expect(fixture.state()).toBeNull();
					expect(fixture.auditCount()).toBe(0);
					expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
					const deletionIndex = fixture.requests.findIndex(
						(request) => request.method === "DELETE",
					);
					// Invalidation may recheck active private queries before the detail unmounts.
					// Only this deleted identity's GETs may return 404, after a successful delete.
					expect(fixture.requests[deletionIndex]?.status).toBe(200);
					expect(
						fixture.requests.filter(
							(request, index) =>
								request.status >= 400 &&
								!(
									index > deletionIndex &&
									request.method === "GET" &&
									request.status === 404 &&
									[
										`/api/context-memory/${deletedId}`,
										`/api/context-memory/${deletedId}/events`,
									].includes(request.path)
								),
						),
					).toEqual([]);
					expect(await page.evaluate(() => document.body.innerText)).not.toContain("私密正文结尾");
					expect(errors).toEqual([]);
				} finally {
					await page.close();
				}
			},
			30_000,
		);
	}
}
