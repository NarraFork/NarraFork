/** Real Chromium only: no running NarraFork/database, no skipped browser regressions. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./markdown-images.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
type Report = ReturnType<typeof Fixture.report>;
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let page: Page;
const errors: string[] = [];

function gate() {
	const started = Promise.withResolvers<URL>();
	const response = Promise.withResolvers<Response>();
	return { started, response, calls: 0 };
}
const gates = new Map<string, ReturnType<typeof gate>>();
const svg = (portrait: boolean) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 120 : 2400}" height="${portrait ? 1600 : 120}"><rect width="100%" height="100%" fill="#5278c4"/></svg>`;

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "markdown-images.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("Image fixture entry missing");
	const css = [...assets.keys()].filter((path) => path.endsWith(".css"));
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 20,
		async fetch(request) {
			const url = new URL(request.url);
			const key = url.searchParams.get("path") ?? url.pathname;
			const pending = gates.get(key);
			if (pending) {
				pending.calls++;
				pending.started.resolve(url);
				return (await pending.response.promise).clone();
			}
			if (url.pathname === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
			const asset = assets.get(url.pathname);
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
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(`http://127.0.0.1:${server.port}/`);
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
}, 60_000);

afterEach(() => {
	for (const pending of gates.values())
		pending.response.resolve(new Response("closed", { status: 410 }));
	gates.clear();
});

afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

async function report(): Promise<Report> {
	await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settle());
	return page.evaluate(() => (window as unknown as FixtureWindow).fixture.report());
}

async function mount(value: boolean) {
	await page.evaluate(
		(mounted) => (window as unknown as FixtureWindow).fixture.mount(mounted),
		value,
	);
	return report();
}

function geometry(value: Report, baseline?: Report) {
	expect(value.rowHeights).toHaveLength(value.measuredHeights.length);
	for (const [index, height] of value.rowHeights.entries()) {
		// Chromium quantizes layout coordinates to 1/64px.
		expect(Math.abs(height - (value.measuredHeights[index] ?? 0))).toBeLessThan(0.02);
	}
	expect(value.prepared).toContainEqual({ kind: "fixed", tag: "markdown-image" });
	expect(value.prepared.some((block) => block.kind === "unknown")).toBe(false);
	expect(value.unknownHeights).toEqual([]);
	expect(value.overflow).toBe(0);
	for (const slot of value.slots) {
		expect(slot.height).toBe(200);
		expect(slot.height).toBe(value.previewHeight);
		expect(slot.position).toBe("absolute");
		expect(slot.contained).toBe(true);
	}
	if (baseline) {
		expect(value.rowHeights).toEqual(baseline.rowHeights);
		expect(value.sentinel).toBe(baseline.sentinel);
		expect(value.scrollHeight).toBe(baseline.scrollHeight);
		expect(value.scrollTop).toBe(baseline.scrollTop);
	}
	expect(errors).toEqual([]);
}

let serial = 0;
async function scene(width: number, scoped = false) {
	const name = `image-${++serial}.svg`;
	const key = scoped ? `/historical/workspace/${name}` : `/images/${name}`;
	const pending = gate();
	gates.set(key, pending);
	const src = scoped ? `./${name}` : `http://127.0.0.1:${server?.port}${key}`;
	await page.setViewport({ width, height: 700, deviceScaleFactor: 1 });
	await page.evaluate((options) => (window as unknown as FixtureWindow).fixture.render(options), {
		width,
		src,
		scoped,
	});
	const request = await pending.started.promise;
	const initial = await report();
	expect(initial.slots).toHaveLength(1);
	expect(initial.slots[0]?.loaded).toBe(false);
	geometry(initial);
	return { pending, src, initial, request };
}

async function loaded() {
	await page.waitForFunction(
		() => (window as unknown as FixtureWindow).fixture.report().slots[0]?.loaded,
	);
	return report();
}

for (const width of [390, 800]) {
	for (const scoped of [false, true]) {
		for (const portrait of [false, true]) {
			test(`${width}px ${scoped ? "scoped" : "URL"} ${portrait ? "portrait" : "landscape"}: delayed load, viewer and hot remount keep geometry`, async () => {
				const { pending, src, initial, request } = await scene(width, scoped);
				if (scoped) {
					expect(request.pathname).toBe(
						"/api/narrators/image-fixture/file-references/image-preview",
					);
					expect(request.searchParams.get("deviceId")).toBe("local");
				}
				pending.response.resolve(
					new Response(svg(portrait), {
						headers: { "content-type": "image/svg+xml", "cache-control": "public,max-age=3600" },
					}),
				);
				const ready = await loaded();
				geometry(ready, initial);
				expect(ready.slots[0]?.title).toBe("preview title");
				expect(ready.slots[0]?.naturalWidth).toBe(portrait ? 120 : 2400);
				expect(ready.slots[0]?.naturalHeight).toBe(portrait ? 1600 : 120);
				await page.click("[data-vlist-markdown-image] img");
				const opened = (await report()).opens[0];
				const imageSrc = ready.slots[0]?.src;
				if (!opened || !imageSrc) throw new Error("Loaded image did not open the viewer");
				expect(opened.src).toBe(imageSrc);
				expect(opened.alt).toBe("preview alt");
				expect(opened.hasBlob).toBe(scoped);
				if (!scoped) expect(opened.src).toBe(src);
				for (let repeat = 0; repeat < 2; repeat++) {
					const absent = await mount(false);
					expect(absent.slots).toHaveLength(0);
					geometry(absent, initial);
					geometry(await mount(true), initial);
					geometry(await loaded(), initial);
				}
				// Actual browser HTTP cache, not a fake image or mocked reader cache.
				expect(pending.calls).toBe(1);
			}, 15_000);
		}

		test(`${width}px ${scoped ? "scoped" : "URL"}: delayed error preserves the 200px slot through remount`, async () => {
			const { pending, initial, request } = await scene(width, scoped);
			const response = page.waitForResponse((value) => value.url() === request.href);
			pending.response.resolve(
				new Response("missing image", { status: 404, headers: { "cache-control": "no-store" } }),
			);
			await response;
			await page.waitForFunction(() => {
				const slot = (window as unknown as FixtureWindow).fixture.report().slots[0];
				return slot && (slot.text === "preview alt" || slot.complete);
			});
			const failed = await report();
			geometry(failed, initial);
			expect(failed.slots[0]?.loaded).toBe(false);
			geometry(await mount(false), initial);
			geometry(await mount(true), initial);
			geometry(await report(), initial);
		}, 15_000);
	}

	test(`${width}px: unmount aborts a pending scoped reader; late response cannot move spacers`, async () => {
		const { pending, initial } = await scene(width, true);
		const absent = await mount(false);
		geometry(absent, initial);
		expect(absent.abortedReads).toBeGreaterThan(0);
		pending.response.resolve(
			new Response(svg(true), {
				headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
			}),
		);
		const late = await report();
		geometry(late, initial);
		expect(late.slots).toHaveLength(0);
		expect(late.opens).toEqual([]);
		geometry(await mount(true), initial);
		geometry(await loaded(), initial);
	}, 15_000);
}
