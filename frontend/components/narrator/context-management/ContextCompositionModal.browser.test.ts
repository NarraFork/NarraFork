import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ContextComposition, groupContextSegments } from "@shared/context-composition";
import { type Browser, launch } from "puppeteer-core";

async function chromePath() {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache)) {
		for await (const path of new Bun.Glob("chrome/*/**/chrome").scan({
			cwd: cache,
			absolute: true,
		}))
			return path;
	}
	return ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
}
const chrome = await chromePath();
const segments = [
	{ category: "system" as const, chars: 100 },
	{ category: "user" as const, chars: 100 },
	{ category: "assistant" as const, chars: 100 },
	{ category: "user" as const, chars: 100 },
];
const data: ContextComposition = {
	generation: "fixture",
	segments,
	totals: groupContextSegments(segments),
	totalChars: 400,
	nextCursor: null,
	pending: false,
};
(chrome ? test : test.skip)(
	"真实浏览器：中英桌面和手机布局、排序切换与键盘选择",
	async () => {
		const build = await Bun.build({
			entrypoints: [join(import.meta.dir, "ContextCompositionModal.browser-fixture.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8000));
		if (build.outputs.reduce((bytes, output) => bytes + output.size, 0) > 16 * 1024 * 1024)
			throw new Error("Fixture bundle exceeds budget");
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
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: 1024,
			fetch(request) {
				if (request.method !== "GET") return new Response(null, { status: 405 });
				const path = new URL(request.url).pathname;
				if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
				if (path === "/api/narrators/fixture/context-composition") {
					requests++;
					return Response.json(data);
				}
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
				timeout: 15000,
			});
			const page = await browser.newPage();
			for (const language of ["zh-CN", "en"]) {
				for (const width of [360, 1100]) {
					await page.setViewport({ width, height: 800 });
					await page.goto(`http://127.0.0.1:${server.port}/?lang=${language}`, { timeout: 15000 });
					await page.waitForSelector('[data-testid="context-composition-bar"]', {
						visible: true,
						timeout: 5000,
					});
					const layout = await page.evaluate(() => {
						const bar = document.querySelector('[data-testid="context-composition-bar"]');
						if (!bar) throw new Error("Missing character bar");
						const bounds = bar.getBoundingClientRect();
						return {
							count: bar.querySelectorAll("button").length,
							width: bounds.width,
							contained: bounds.left >= 0 && bounds.right <= innerWidth,
							filled:
								Array.from(bar.querySelectorAll("button")).reduce(
									(total, button) => total + button.getBoundingClientRect().width,
									0,
								) / bounds.width,
							noThreshold: !document.querySelector('[data-testid="context-composition-threshold"]'),
							noDisclaimer: !/(估算|不完整|免责声明|estimated|incomplete|tokens)/i.test(
								document.body.innerText,
							),
						};
					});
					expect(layout.count).toBe(3);
					expect(layout.width).toBeGreaterThan(200);
					expect(layout.contained).toBe(true);
					expect(layout.filled).toBeCloseTo(1, 2);
					expect(layout.noThreshold).toBe(true);
					expect(layout.noDisclaimer).toBe(true);
					const sequenceId = await page.$eval('input[value="sequence"]', (input) => input.id);
					await page.click(`label[for="${sequenceId}"]`);
					await page.waitForFunction(
						() =>
							document.querySelectorAll('[data-testid="context-composition-bar"] button').length ===
							4,
					);
					await page.focus('[data-testid="context-composition-bar"] button');
					await page.keyboard.press("Enter");
					await page.waitForSelector('[role="status"]', { visible: true, timeout: 5000 });
				}
			}
			expect(requests).toBe(4);
		} finally {
			await browser?.close();
			server.stop(true);
		}
	},
	60000,
);
