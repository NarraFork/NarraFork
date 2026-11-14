import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser } from "puppeteer-core";
import type * as Fixture from "./InlineComposerEditor.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	// Build only the real editor fixture, not either application bundle.
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("./InlineComposerEditor.browser-fixture.tsx", import.meta.url)),
		],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"', __NF_REMOTE_BUILD__: "true" },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script) throw new Error("Editor bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head>${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}</head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "content-type": "text/html" } },
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
}, 30_000);

test("compiled remote editor never emits DOM network loads for API or external image resources", async () => {
	if (!browser || !server) throw new Error("Missing fixture");
	const page = await browser.newPage();
	const requests: string[] = [];
	const errors: string[] = [];
	page.on("request", (request) => requests.push(request.url()));
	page.on("pageerror", (error) => errors.push(String(error)));
	try {
		await page.goto(server.url.origin);
		await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture?.ready());
		await page.evaluate(() => {
			(window as unknown as FixtureWindow).fixture.load({
				version: 1,
				paragraphs: [{ children: [{ type: "attachment", id: "node", assetId: "image" }] }],
				assets: [{ id: "image", kind: "image", name: "image.png", mimeType: "image/png", size: 4 }],
			});
		});
		for (const source of [
			"/api/uploads/session/image",
			"/same-origin.png",
			"https://external.invalid/image.png",
			"//external.invalid/image.png",
		]) {
			await page.evaluate(
				(value) => (window as unknown as FixtureWindow).fixture.resources([["image", value]]),
				source,
			);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			expect(await page.$("[data-composer-asset-id=image] img")).toBeNull();
		}
		const data =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=";
		await page.evaluate(
			(value) => (window as unknown as FixtureWindow).fixture.resources([["image", value]]),
			data,
		);
		await page.waitForFunction(
			() => !!document.querySelector("[data-composer-asset-id=image] img"),
		);
		expect(
			await page.$eval("[data-composer-asset-id=image] img", (image) => image.getAttribute("src")),
		).toBe(data);
		expect(
			requests.filter(
				(url) =>
					url.includes("/api/") ||
					url.includes("external.invalid") ||
					url.includes("same-origin.png"),
			),
		).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 30_000);
