import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Browser, launch } from "puppeteer-core";
import type { ReflectionFixtureOptions } from "./PlanReflectionStatusControl.browser-fixture";

async function ownedChromePath(): Promise<string | undefined> {
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
	if (existsSync(cache)) {
		for await (const path of new Bun.Glob("chrome/*/**/chrome").scan({
			cwd: cache,
			absolute: true,
		})) {
			return path;
		}
	}
	return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(
		existsSync,
	);
}
const chrome = await ownedChromePath();
if (!chrome)
	console.warn("SKIP reflection layout regression: no owned Chrome executable available");

(chrome ? test : test.skip)(
	"real layout keeps localized reflection controls reachable at 320/400px and restores them inline",
	async () => {
		const build = await Bun.build({
			entrypoints: [join(import.meta.dir, "PlanReflectionStatusControl.browser-fixture.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8_000));
		if (build.outputs.reduce((bytes, output) => bytes + output.size, 0) > 32 * 1024 * 1024) {
			throw new Error("Reflection fixture bundle exceeds 32MiB");
		}
		const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
		const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${[
			...assets.keys(),
		]
			.filter((path) => path.endsWith(".css"))
			.map((path) => `<link rel="stylesheet" href="${path}">`)
			.join("")}</head><body style="margin:0"><div id="root"></div>${build.outputs
			.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
			.map((output) => `<script type="module" src="/${basename(output.path)}"></script>`)
			.join("")}</body></html>`;
		// Fresh loopback fixture, browser and profile: never use an application service or a persisted endpoint.
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: 1024,
			fetch(request) {
				if (request.method !== "GET") return new Response(null, { status: 405 });
				const path = new URL(request.url).pathname;
				if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
				const asset = assets.get(path);
				return asset ? new Response(asset) : new Response(null, { status: 404 });
			},
		});
		let browser: Browser | undefined;
		try {
			browser = await launch({
				executablePath: chrome,
				headless: true,
				args: ["--no-sandbox", "--disable-dev-shm-usage"],
				timeout: 15_000,
			});
			const page = await browser.newPage();
			await page.setViewport({ width: 1000, height: 600 });
			await page.goto(`http://127.0.0.1:${server.port}`, { timeout: 15_000 });
			await page.waitForFunction(() => Boolean(window.__reflectionFixture), { timeout: 5_000 });
			for (const language of ["en", "zh-CN"] as const) {
				for (const width of [320, 400]) {
					const options: Partial<ReflectionFixtureOptions> = {
						language,
						width,
						effective: false,
						globalDefault: true,
						disabled: false,
					};
					await page.evaluate((next) => window.__reflectionFixture?.setOptions(next), options);
					await page.waitForFunction(
						(next) => {
							const panel = document.getElementById("panel");
							if (!panel) return false;
							return (
								panel.getBoundingClientRect().width === next.width &&
								panel.dataset.language === next.language &&
								panel.dataset.effective === "off"
							);
						},
						{ timeout: 5_000 },
						options,
					);
					// Toolbar cache invalidation and ResizeObserver measurements are coalesced
					// into animation frames. Do not click an intermediate remounted menu.
					await page.evaluate(
						() =>
							new Promise<void>((resolve) => {
								let remaining = 3;
								const frame = () => {
									if (--remaining === 0) resolve();
									else requestAnimationFrame(frame);
								};
								requestAnimationFrame(frame);
							}),
					);
					try {
						await page.waitForFunction(
							() =>
								!document.querySelector('[data-toolbar-action="plan-reflection"]') &&
								Boolean(document.querySelector('[data-testid="narrator-status-more"]')),
							{ timeout: 5_000 },
						);
					} catch (error) {
						console.error(
							"Reflection layout did not collapse",
							{ language, width },
							await page.evaluate(() =>
								[
									...document.querySelectorAll(
										'[data-testid="narrator-status-bar-content"], [data-testid="narrator-status-toolbar"], [data-toolbar-leading], [data-toolbar-action], [data-testid="narrator-status-more"]',
									),
								].map((element) => ({
									name:
										element.getAttribute("data-testid") ??
										element.getAttribute("data-toolbar-action") ??
										"leading",
									width: element.getBoundingClientRect().width,
									text: element.textContent?.slice(0, 100),
								})),
							),
						);
						throw error;
					}
					const layout = await page.evaluate(() => {
						const rowElement = document.querySelector(
							'[data-testid="narrator-status-bar-content"]',
						);
						const moreElement = document.querySelector('[data-testid="narrator-status-more"]');
						if (!rowElement || !moreElement)
							throw new Error("Missing status row or overflow entry");
						const row = rowElement.getBoundingClientRect();
						const more = moreElement.getBoundingClientRect();
						return {
							height: row.height,
							reachable: more.left >= row.left && more.right <= row.right,
						};
					});
					expect(layout.height).toBe(30);
					expect(layout.reachable).toBe(true);
					await page.locator('[data-testid="narrator-status-more"]').setTimeout(5_000).click();
					const label = language === "en" ? "Reflection approval off" : "反思批准已关闭";
					const selector = `input[aria-label="${label}"]`;
					await page.waitForSelector(selector, { visible: true, timeout: 5_000 });
					expect(await page.$eval(selector, (input) => input.closest("button") === null)).toBe(
						true,
					);
					await page.locator(selector).setTimeout(5_000).click();
					await page.waitForFunction(
						() => window.__reflectionFixture?.changes.at(-1) === "inherit",
					);

					await page.evaluate(() => window.__reflectionFixture?.setOptions({ width: 800 }));
					await page.waitForFunction(
						() =>
							document.getElementById("panel")?.getBoundingClientRect().width === 800 &&
							Boolean(document.querySelector('[data-toolbar-action="plan-reflection"] input')),
						{ timeout: 5_000 },
					);
					const controlInsideRow = await page.evaluate(() => {
						const rowElement = document.querySelector(
							'[data-testid="narrator-status-bar-content"]',
						);
						const controlElement = document.querySelector(
							'[data-toolbar-action="plan-reflection"]',
						);
						if (!rowElement || !controlElement)
							throw new Error("Missing restored reflection action");
						const row = rowElement.getBoundingClientRect();
						const control = controlElement.getBoundingClientRect();
						return control.left >= row.left && control.right <= row.right;
					});
					expect(controlInsideRow).toBe(true);
				}
			}
			await page.evaluate(() =>
				window.__reflectionFixture?.setOptions({ width: 320, disabled: true }),
			);
			await page.waitForFunction(
				() => !document.querySelector('[data-toolbar-action="plan-reflection"]'),
			);
			await page.locator('[data-testid="narrator-status-more"]').setTimeout(5_000).click();
			await page.waitForSelector('input[aria-label="反思批准已开启"]', { visible: true });
			expect(
				await page.$eval(
					'input[aria-label="反思批准已开启"]',
					(input) => (input as HTMLInputElement).disabled,
				),
			).toBe(true);
			expect(await page.evaluate(() => window.__reflectionFixture?.changes)).toEqual(
				Array(4).fill("inherit"),
			);
		} finally {
			await browser?.close();
			await server.stop(true);
		}
	},
	60_000,
);
