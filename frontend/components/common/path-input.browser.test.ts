/**
 * PathInput's suggestion dropdown and long-path display in Chromium (production component and
 * CSS; the browse API is stubbed with a configurable delay):
 *
 *   - opened upwards in a dialog, the suggestions never cover the submit button below, which
 *     takes the first click;
 *   - suggestions that arrive after the field lost focus do not pop back open;
 *   - Escape closes the suggestions, not the dialog;
 *   - an unfocused long path shows its end (where sibling folders differ), with the full path
 *     as the tooltip.
 *
 * Run: NF_TEST_CHROMIUM_PATH=/usr/bin/google-chrome \
 *        bun test --isolate frontend/components/common/path-input.browser.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./path-input.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture; browseDelay: number };

const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";

const LONG_PREFIX = "/tmp/claude-0/-home-user-NarraFork/13582635-c8be-5e3d-9f41-f14f8cb5ad58/repos";

const STUBS: Record<string, string> = {
	platform: `export const useFileSystemCapability=()=>({browse:{supported:true},mkdir:{supported:false}});`,
	api: `export const api={fsBrowse:async(dir)=>{await new Promise(r=>setTimeout(r,window.browseDelay||0));const names=["acme-app","alpha","notes","plain-folder"];return{path:dir,sep:"/",entries:names.map(name=>({name,path:(dir==="/"?"":dir)+"/"+name,isSymlink:false}))};},fsMkdir:async()=>{throw new Error("no mkdir");}};`,
};

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./path-input.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "path-input-stubs",
				setup(builder) {
					builder.onResolve({ filter: /\/hooks\/usePlatform$/ }, () => ({
						path: "platform",
						namespace: "stub",
					}));
					builder.onResolve({ filter: /\/lib\/api$/ }, () => ({ path: "api", namespace: "stub" }));
					builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
						loader: "js",
						contents: STUBS[args.path] ?? "",
					}));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script) throw new Error("Fixture bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}</head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
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
	position: "top" | "bottom",
	initial = "",
	delay = 0,
): Promise<{ page: Page; errors: string[] }> {
	if (!browser || !server) throw new Error("Fixture unavailable");
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.setViewport({ width: 1440, height: 900 });
	await page.goto(server.url.origin, { waitUntil: "networkidle0" });
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
	await page.evaluate(
		(where, value, ms) => {
			(window as unknown as FixtureWindow).browseDelay = ms;
			(window as unknown as FixtureWindow).fixture.start(where, value);
		},
		position,
		initial,
		delay,
	);
	await page.waitForSelector("input[title], input");
	return { page, errors };
}

const directoryInput = (page: Page) =>
	page.waitForSelector('[role="dialog"] input:not([data-testid])');

const listbox = (page: Page) =>
	page.evaluate(() => {
		const box = document.querySelector('[role="listbox"]');
		if (!box || box.getClientRects().length === 0) return null;
		const rect = box.getBoundingClientRect();
		return { top: rect.top, bottom: rect.bottom };
	});

async function settle(page: Page, ms = 0) {
	if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}

test("suggestions opened upwards leave the submit button below free for the first click", async () => {
	const { page, errors } = await open("top");
	try {
		const input = await directoryInput(page);
		await input?.type(`${LONG_PREFIX}/a`);
		await page.waitForSelector('[role="listbox"] [role="option"]', { visible: true });
		await settle(page, 300);
		const menu = await listbox(page);
		const submit = await page.$eval('[data-testid="submit"]', (button) => {
			const rect = button.getBoundingClientRect();
			return { top: rect.top, bottom: rect.bottom };
		});
		const field = await input?.boundingBox();
		expect(menu).not.toBeNull();
		// Above the field, so nothing of it reaches the button.
		expect(menu?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((field?.y ?? 0) + 1);
		expect(menu?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThan(submit.top);
		await page.click('[data-testid="submit"]');
		await settle(page, 100);
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.submitCount()),
		).toBe(1);
		expect(await listbox(page)).toBeNull();
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 20_000);

test("suggestions that arrive after the field lost focus stay closed", async () => {
	const { page, errors } = await open("bottom", "", 600);
	try {
		const input = await directoryInput(page);
		await input?.type(`${LONG_PREFIX}/no`);
		// Leave before the (slow) browse answers.
		await page.click('[data-testid="name"]');
		await settle(page, 1_200);
		expect(await listbox(page)).toBeNull();
		await page.click('[data-testid="submit"]');
		expect(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.submitCount()),
		).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 20_000);

test("Escape closes the suggestions but not the dialog", async () => {
	const { page, errors } = await open("bottom");
	try {
		const input = await directoryInput(page);
		await input?.type(`${LONG_PREFIX}/a`);
		await page.waitForSelector('[role="listbox"] [role="option"]', { visible: true });
		await page.keyboard.press("Escape");
		await settle(page, 300);
		expect(await listbox(page)).toBeNull();
		expect(await page.$('[role="dialog"]')).not.toBeNull();
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 20_000);

test("an unfocused long path shows its end and carries the full path as its tooltip", async () => {
	const path = `${LONG_PREFIX}/plain-folder`;
	const { page, errors } = await open("bottom", path);
	try {
		const input = await directoryInput(page);
		await settle(page, 100);
		const read = () =>
			page.evaluate(() => {
				const field = document.querySelector<HTMLInputElement>(
					'[role="dialog"] input:not([data-testid])',
				);
				if (!field) throw new Error("missing input");
				return {
					title: field.title,
					scrollLeft: field.scrollLeft,
					maxScroll: field.scrollWidth - field.clientWidth,
				};
			});
		const before = await read();
		expect(before.title).toBe(path);
		expect(before.maxScroll).toBeGreaterThan(0);
		expect(before.scrollLeft).toBeGreaterThanOrEqual(before.maxScroll - 1);
		// Editing starts wherever the caret goes; leaving the field shows the end again.
		await input?.click();
		await page.keyboard.press("Home");
		await settle(page);
		expect((await read()).scrollLeft).toBe(0);
		await page.click('[data-testid="name"]');
		await settle(page, 100);
		const after = await read();
		expect(after.scrollLeft).toBeGreaterThanOrEqual(after.maxScroll - 1);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 20_000);
