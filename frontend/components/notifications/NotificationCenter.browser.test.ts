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
if (!chrome) console.warn("SKIP notification focus regression: Chrome is unavailable");

(chrome ? test : test.skip)(
	"notification radio clicks and custom-answer focus survive background reconciliation",
	async () => {
		const build = await Bun.build({
			entrypoints: [join(import.meta.dir, "NotificationCenter.browser-fixture.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8_000));
		if (build.outputs.reduce((bytes, output) => bytes + output.size, 0) > 32 * 1024 * 1024)
			throw new Error("Notification fixture exceeds 32MiB");
		const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
		const html = `<!doctype html><html><head>${build.outputs
			.filter((output) => output.path.endsWith(".css"))
			.map((output) => `<link rel="stylesheet" href="/${basename(output.path)}">`)
			.join("")}</head><body><div id="root"></div>${build.outputs
			.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
			.map((output) => `<script type="module" src="/${basename(output.path)}"></script>`)
			.join("")}</body></html>`;
		// Isolated loopback fixture: never touch the running application or user data.
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
			await page.goto(`http://127.0.0.1:${server.port}`, { timeout: 15_000 });
			await page.locator('[data-attention-id] button[aria-expanded="false"]').click();
			await page.waitForSelector('input[type="radio"]');
			await page.evaluate(() => window.__notificationFixture.refresh());
			await page.waitForFunction(() => window.__notificationFixture.fetching());
			expect(await page.$eval("fieldset", (node) => node.disabled)).toBe(false);
			await page.locator('input[type="radio"][value="A"]').click();
			expect(
				await page.$eval('input[value="A"]', (input) => (input as HTMLInputElement).checked),
			).toBe(true);
			await page.locator('input[type="radio"][value="B"]').click();
			expect(
				await page.$eval('input[value="B"]', (input) => (input as HTMLInputElement).checked),
			).toBe(true);
			await page.locator("textarea").click();
			await page.keyboard.type("Half an answer");
			await page.evaluate(() => window.__notificationFixture.finish());
			await page.waitForFunction(() => !window.__notificationFixture.fetching());
			expect(await page.$eval("textarea", (input) => document.activeElement === input)).toBe(true);
			// A second refresh starts while typing, not only before focusing the form.
			await page.evaluate(() => window.__notificationFixture.refresh());
			await page.waitForFunction(() => window.__notificationFixture.fetching());
			await page.keyboard.type(" and the rest");
			expect(
				await page.$eval("textarea", (input) => ({
					focused: document.activeElement === input,
					value: input.value,
				})),
			).toEqual({ focused: true, value: "Half an answer and the rest" });
			await page.evaluate(() => window.__notificationFixture.finish());
		} finally {
			await browser?.close();
			await server.stop(true);
		}
	},
	30_000,
);
