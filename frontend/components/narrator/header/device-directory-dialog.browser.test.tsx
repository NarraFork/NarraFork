import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import type * as Fixture from "./device-directory-dialog.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

beforeAll(async () => {
	if (!existsSync(executablePath))
		throw new Error(`Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`);
	const bundle = await Bun.build({
		entrypoints: [
			new URL("./device-directory-dialog.browser-fixture.tsx", import.meta.url).pathname,
		],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	if (!script) throw new Error("Fixture has no JavaScript output");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 30,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8">
					<meta name="viewport" content="width=device-width,initial-scale=1">
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					<style>html,body { margin: 0; height: 100%; }</style>
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

async function openPage(width: number, height: number) {
	if (!browser || !server) throw new Error("Browser fixture not initialized");
	const page = await browser.newPage();
	const errors: string[] = [];
	const unexpectedRequests: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.origin !== server?.url.origin || url.pathname.startsWith("/api/"))
			unexpectedRequests.push(url.href);
	});
	await page.setViewport({ width, height });
	await page.goto(server.url.origin, { waitUntil: "networkidle0", timeout: 30_000 });
	await page.waitForSelector('[data-dir-index="179"]', { timeout: 10_000 });
	return { page, errors, unexpectedRequests };
}

async function clickButton(page: Page, text: string) {
	const button = await page.waitForFunction(
		(label) => [...document.querySelectorAll("button")].find((item) => item.textContent === label),
		{},
		text,
	);
	const element = button.asElement() as ElementHandle<HTMLButtonElement> | null;
	if (!element) throw new Error(`Missing button: ${text}`);
	await element.click();
	await button.dispose();
}

for (const [width, height] of [
	[1024, 768],
	[390, 844],
	[760, 480],
]) {
	test(`device directory dialog scrolls to its last row with reachable actions at ${width}x${height}`, async () => {
		const { page, errors, unexpectedRequests } = await openPage(width, height);
		try {
			const report = await page.evaluate(() => {
				const viewport = document.querySelector<HTMLElement>(".mantine-ScrollArea-viewport");
				const last = document.querySelector<HTMLElement>('[data-dir-index="179"]');
				if (!viewport || !last) throw new Error("Missing directory list");
				viewport.scrollTop = viewport.scrollHeight;
				const viewportRect = viewport.getBoundingClientRect();
				const lastRect = last.getBoundingClientRect();
				const buttons = [...document.querySelectorAll("button")].filter((button) =>
					["Select This Directory", "Switch to Fixture device", "Cancel"].includes(
						button.textContent ?? "",
					),
				);
				return {
					rowCount: document.querySelectorAll("[data-dir-index]").length,
					height: viewport.clientHeight,
					scrollHeight: viewport.scrollHeight,
					scrollTop: viewport.scrollTop,
					lastVisible:
						lastRect.top >= viewportRect.top - 1 && lastRect.bottom <= viewportRect.bottom + 1,
					buttons: buttons.map((button) => {
						const rect = button.getBoundingClientRect();
						const hit = document.elementFromPoint(
							rect.left + rect.width / 2,
							rect.top + rect.height / 2,
						);
						return {
							visible:
								rect.top >= 0 &&
								rect.bottom <= innerHeight &&
								rect.left >= 0 &&
								rect.right <= innerWidth,
							reachable: !!hit && button.contains(hit),
						};
					}),
				};
			});
			expect(report.rowCount).toBe(180);
			expect(report.height).toBeGreaterThan(0);
			expect(report.scrollHeight).toBeGreaterThan(report.height);
			expect(report.scrollTop).toBeGreaterThan(0);
			expect(report.lastVisible).toBe(true);
			expect(report.buttons).toHaveLength(4);
			for (const button of report.buttons) {
				expect(button.visible).toBe(true);
				expect(button.reachable).toBe(true);
			}
			await clickButton(page, "Select This Directory");
			expect(
				await page.evaluate(
					() =>
						[...document.querySelectorAll("button")].find(
							(button) => button.textContent === "Switch to Fixture device",
						)?.disabled,
				),
			).toBe(false);
			expect(errors).toEqual([]);
			expect(unexpectedRequests).toEqual([]);
		} finally {
			await page.close();
		}
	}, 30_000);
}

for (const [path, submit] of [
	["C:\\Users\\Fixture\\Project", "Enter"],
	["/remote/projects/with spaces", "Go"],
]) {
	test(`manual ${submit} navigation requests only the submitted path and fails closed`, async () => {
		const { page, errors, unexpectedRequests } = await openPage(1024, 768);
		try {
			const input = await page.waitForSelector('input[aria-label="Enter path..."]');
			if (!input) throw new Error("Missing editable path input");
			await input.click({ clickCount: 3 });
			await input.type(path);
			// A real browser keyboard round trip lets React finish each keystroke.
			expect(
				await page.evaluate(() => (window as unknown as FixtureWindow).fixture.requests),
			).toEqual([null]);
			if (submit === "Enter") await input.press("Enter");
			else await clickButton(page, "Go");
			await page.waitForFunction(
				(expected) =>
					document.querySelector<HTMLInputElement>('input[aria-label="Enter path..."]')?.value ===
						expected && document.querySelectorAll("[data-dir-index]").length === 180,
				{},
				path,
			);
			expect(
				await page.evaluate(() => (window as unknown as FixtureWindow).fixture.requests),
			).toEqual([null, path]);
			const missing = path.includes("\\") ? "C:\\missing\\directory" : "/missing/directory";
			await input.click({ clickCount: 3 });
			await input.type(missing);
			await input.press("Enter");
			await page.waitForFunction(() => document.body.textContent?.includes("Directory not found:"));
			const failed = await page.evaluate(() => ({
				rows: document.querySelectorAll("[data-dir-index]").length,
				selectDisabled: [...document.querySelectorAll("button")].find(
					(button) => button.textContent === "Select This Directory",
				)?.disabled,
				confirmDisabled: [...document.querySelectorAll("button")].find(
					(button) => button.textContent === "Switch to Fixture device",
				)?.disabled,
				switches: (window as unknown as FixtureWindow).fixture.switches,
				requests: (window as unknown as FixtureWindow).fixture.requests,
			}));
			expect(failed.rows).toBe(0);
			expect(failed.selectDisabled).toBe(true);
			expect(failed.confirmDisabled).toBe(true);
			expect(failed.switches).toEqual([]);
			expect(failed.requests).toEqual([null, path, missing]);
			expect(errors).toEqual([]);
			expect(unexpectedRequests).toEqual([]);
		} finally {
			await page.close();
		}
	}, 30_000);
}

for (const base of ["/remote/home", "C:\\Users\\Fixture"]) {
	test(`typing filters the listing without remote requests at ${base}`, async () => {
		const { page, errors, unexpectedRequests } = await openPage(390, 844);
		try {
			const input = await page.waitForSelector('input[aria-label="Enter path..."]');
			if (!input) throw new Error("Missing editable path input");
			const fill = async (value: string) => {
				await input.click({ clickCount: 3 });
				await input.press("Backspace");
				await input.type(value);
			};
			await fill(base);
			await input.press("Enter");
			await page.waitForFunction(
				(path) => (window as unknown as FixtureWindow).fixture.requests.includes(path),
				{},
				base,
			);
			await page.waitForFunction(
				() => document.querySelectorAll("[data-dir-index]").length === 180,
			);
			const requests = await page.evaluate(
				() => (window as unknown as FixtureWindow).fixture.requests,
			);
			const sep = base.includes("\\") ? "\\" : "/";
			for (const filter of ["DIRECTORY-17", `${base}${sep}directory-17`]) {
				await fill(filter);
				const names = await page.$$eval("[data-dir-index]", (rows) =>
					rows.map((row) => row.textContent),
				);
				expect(names).toHaveLength(10);
				expect(names.every((name) => name?.startsWith("directory-17"))).toBe(true);
			}
			await fill("no-such-match");
			expect(await page.$$eval("[data-dir-index]", (rows) => rows.length)).toBe(0);
			expect(await page.evaluate(() => document.body.textContent)).toContain(
				"No matching directories.",
			);
			await fill("");
			expect(await page.$$eval("[data-dir-index]", (rows) => rows.length)).toBe(180);
			expect(
				await page.evaluate(() => (window as unknown as FixtureWindow).fixture.requests),
			).toEqual(requests);
			await fill("directory-17");
			// Keyboard indices must refer to the filtered rows, not the original list.
			await page.focus('[role="group"][aria-label="Directories"]');
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("Enter");
			await page.waitForFunction(
				(path) => (window as unknown as FixtureWindow).fixture.requests.includes(path),
				{},
				`${base}${sep}directory-170`,
			);
			expect(errors).toEqual([]);
			expect(unexpectedRequests).toEqual([]);
		} finally {
			await page.close();
		}
	}, 30_000);
}
