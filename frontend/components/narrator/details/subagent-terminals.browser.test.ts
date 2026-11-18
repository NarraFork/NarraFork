/**
 * The subagent-terminals row of the details panel holds at phone width (360 px) in light and
 * dark, read-only and with open buttons, with a long subagent title and a long terminal name:
 * nothing reaches past the panel and the page never scrolls sideways. Measured in real
 * Chromium; a DOM-only test cannot see a shrink-proof flex item escaping its row.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import type * as Fixture from "./subagent-terminals.browser-fixture";

// This suite owns only an ephemeral static server and an ephemeral browser.
const cachedChromium =
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const executablePath = process.env.NF_TEST_CHROMIUM_PATH ?? cachedChromium;

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
type FixtureWindow = Window & { fixture: typeof Fixture };

beforeAll(async () => {
	if (!existsSync(executablePath))
		throw new Error(`Chromium unavailable at ${executablePath}; set NF_TEST_CHROMIUM_PATH`);
	mkdirSync("artifacts", { recursive: true });
	const bundle = await Bun.build({
		entrypoints: [new URL("./subagent-terminals.browser-fixture.tsx", import.meta.url).pathname],
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

test("the row fits at 360 px in light and dark, read-only and openable", async () => {
	if (!browser || !server) throw new Error("Browser fixture not initialized");
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	try {
		await page.setViewport({ width: 360, height: 640 });
		for (const scheme of ["light", "dark"])
			for (const canOpen of [false, true]) {
				await page.goto(`${server.url.origin}/?scheme=${scheme}&canOpen=${canOpen ? 1 : 0}`, {
					waitUntil: "networkidle0",
				});
				await page.waitForSelector('[data-testid="subagent-terminal-row"]');
				const report = await page.evaluate(() =>
					(window as unknown as FixtureWindow).fixture.overflowReport(),
				);
				expect(report?.rows).toBe(2);
				expect(report?.buttons).toBe(canOpen ? 2 : 0);
				expect(report?.escaping).toEqual([]);
				expect(report?.docScroll).toBe(0);
				await page.screenshot({
					path: `artifacts/subagent-terminals-360-${scheme}-${canOpen ? "open" : "readonly"}.png`,
				});
			}
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}, 60_000);
