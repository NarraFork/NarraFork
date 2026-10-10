import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Browser, launch } from "puppeteer-core";

async function chromePath() {
	const configured = process.env.NF_TEST_CHROMIUM_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
	if (configured) return configured;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache)) {
		for await (const path of new Bun.Glob("chrome/*/**/chrome").scan({
			cwd: cache,
			absolute: true,
		}))
			return path;
	}
	return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(
		existsSync,
	);
}
const chrome = await chromePath();
if (!chrome) console.warn("SKIP WCO overlay layout regression: Chrome is unavailable");

(chrome ? test : test.skip)(
	"WCO overlays reserve the titlebar once, preserve bottom actions and leave ordinary/embedded surfaces unchanged",
	async () => {
		const build = await Bun.build({
			entrypoints: [join(import.meta.dir, "wco-overlay.browser-fixture.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8_000));
		if (build.outputs.reduce((bytes, output) => bytes + output.size, 0) > 32 * 1024 * 1024)
			throw new Error("WCO fixture exceeds 32MiB");
		const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
		const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${build.outputs
			.filter((output) => output.path.endsWith(".css"))
			.map((output) => `<link rel="stylesheet" href="/${basename(output.path)}">`)
			.join("")}</head><body><div id="root"></div>${build.outputs
			.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
			.map((output) => `<script type="module" src="/${basename(output.path)}"></script>`)
			.join("")}</body></html>`;
		// Fresh loopback server/profile, never the running application or user data.
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: 1024,
			fetch(request) {
				if (request.method !== "GET") return new Response(null, { status: 405 });
				const path = new URL(request.url).pathname;
				if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
				return new Response(assets.get(path) ?? null, { status: assets.has(path) ? 200 : 404 });
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
			page.setDefaultTimeout(5_000);
			for (const width of [1000, 480]) {
				await page.setViewport({ width, height: 600 });
				for (const kind of [
					"fullscreen",
					"native",
					"headerless",
					"drawer-left",
					"drawer-right",
					"drawer-top",
					"drawer-bottom",
					"ordinary",
					"panzoom",
					"embedded",
				]) {
					await page.goto(`http://127.0.0.1:${server.port}/?kind=${kind}`, { timeout: 15_000 });
					const surface = kind.startsWith("drawer-")
						? ".nf-drawer-inner"
						: kind === "panzoom" || kind === "embedded"
							? "[data-panzoom-mode]"
							: ".nf-modal-content";
					await page.waitForSelector(surface, { visible: true });
					const measure = () =>
						page.evaluate((selector) => {
							const element = document.querySelector(selector);
							if (!element) throw new Error(`Missing ${selector}`);
							const rect = element.getBoundingClientRect();
							const footer = document.getElementById("footer")?.getBoundingClientRect();
							const button = document.querySelector("button")?.getBoundingClientRect();
							return {
								top: rect.top,
								bottom: rect.bottom,
								height: rect.height,
								footerBottom: footer?.bottom,
								buttonTop: button?.top,
							};
						}, surface);
					const baseline = await measure();
					for (const side of ["left", "right"]) {
						await page.evaluate((nextSide) => {
							const root = document.documentElement;
							root.setAttribute("data-nf-wco", nextSide);
							// Headless is not an installed PWA: inject its reported geometry only.
							root.style.setProperty("--nf-wco-strip-height", "40px");
						}, side);
						const layout = await measure();
						if (kind === "ordinary" || kind === "embedded") {
							expect(layout).toEqual(baseline);
						} else {
							expect(layout.top).toBe(kind === "panzoom" ? 0 : 40);
							expect(layout.bottom).toBeCloseTo(600, 3);
							if (layout.buttonTop != null) expect(layout.buttonTop).toBeGreaterThanOrEqual(40);
							if (layout.footerBottom != null) expect(layout.footerBottom).toBeLessThanOrEqual(600);
						}
					}
					if (kind === "fullscreen" || kind === "headerless" || kind.startsWith("drawer-")) {
						await page.evaluate(() => {
							document.documentElement.style.setProperty("--nf-wco-strip-height", "60px");
							document.documentElement.style.setProperty("--app-viewport-bottom", "420px");
						});
						const resized = await measure();
						expect(resized.top).toBe(60);
						expect(resized.bottom).toBeCloseTo(420, 3);
						expect(resized.footerBottom).toBeLessThanOrEqual(420);
						await page.evaluate(() => {
							document.documentElement.style.removeProperty("--app-viewport-bottom");
						});
					}
					await page.evaluate(() => document.documentElement.removeAttribute("data-nf-wco"));
					expect(await measure()).toEqual(baseline);
					if (kind === "fullscreen" || kind.startsWith("drawer-")) {
						await page.evaluate(() =>
							document.documentElement.setAttribute("data-nf-wco", "right"),
						);
						await page.click('button[aria-label="Close fixture"]');
						expect(await page.evaluate(() => document.documentElement.dataset.closed)).toBe("true");
					}
				}
			}
		} finally {
			await browser?.close();
			await server.stop(true);
		}
	},
	60_000,
);
