// Independent browser fixture: no running application service, database or geometry stubs.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import puppeteer from "puppeteer-core";
import type { PreviewSmokeKind, PreviewSmokeOptions } from "./smoke-vlist-text-preview-fixture";

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const failures: string[] = [];
let checks = 0;
function check(pass: boolean, name: string, detail?: unknown) {
	checks++;
	if (!pass) failures.push(`${name}: ${JSON.stringify(detail).slice(0, 1200)}`);
	console.log(
		`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(detail).slice(0, 1200)}`}`,
	);
}
async function executable() {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
	const cache = join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache))
		for await (const path of new Bun.Glob("chrome/**/chrome").scan({ cwd: cache, absolute: true }))
			return path;
	for (const path of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"])
		if (existsSync(path)) return path;
	throw new Error("Chrome unavailable; set PUPPETEER_EXECUTABLE_PATH. No automatic downloads.");
}
try {
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "smoke-vlist-text-preview-fixture.tsx")],
		target: "browser",
		minify: true,
		splitting: true,
		define: {
			"process.env.NODE_ENV": '"production"',
			"import.meta.env": '{"BASE_URL":"/","DEV":false,"PROD":true}',
		},
	});
	if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n").slice(0, 8000));
	if (bundle.outputs.reduce((bytes, item) => bytes + item.size, 0) > 64 * 1024 * 1024)
		throw new Error("Fixture bundle exceeds 64MiB");
	const assets = new Map(bundle.outputs.map((asset) => [`/${basename(asset.path)}`, asset]));
	const html = `<!doctype html><html><head><meta charset="utf-8">${[...assets.keys()]
		.filter((path) => path.endsWith(".css"))
		.map((path) => `<link rel="stylesheet" href="${path}">`)
		.join("")}</head><body><div id="root"></div>${bundle.outputs
		.filter((asset) => asset.kind === "entry-point" && asset.path.endsWith(".js"))
		.map((asset) => `<script type="module" src="/${basename(asset.path)}"></script>`)
		.join("")}</body></html>`;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			if (path === "/api/user-preferences" || path === "/api/settings") return Response.json({});
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("isolated fixture", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath: await executable(),
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	const page = await browser.newPage();
	await page.setViewport({ width: 1000, height: 760 });
	page.on("pageerror", (error) => {
		if (failures.length < 50) failures.push(`Browser: ${String(error).slice(0, 1000)}`);
	});
	await page.goto(`http://127.0.0.1:${server.port}`, { timeout: 30000 });
	await page.waitForSelector("#smoke-list");
	const frame = () =>
		page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
	const snapshot = () => page.evaluate(() => window.__textPreviewSmoke.snapshot());
	for (const kind of [
		"incoming",
		"bash",
		"agent",
		"send",
		"reasoning",
	] satisfies PreviewSmokeKind[]) {
		for (const width of [280, 800]) {
			for (const theme of ["light", "dark"] as const) {
				const options: PreviewSmokeOptions = {
					kind,
					width,
					theme,
					live: kind === "reasoning",
					lod: width === 280 ? 1 : 5,
				};
				await page.evaluate((value) => window.__textPreviewSmoke.set(value), options);
				await frame();
				const preview = await snapshot();
				const label = `${kind}/${width}/${theme}`;
				check(
					preview.lines > 0 &&
						preview.lines < 40 &&
						preview.viewportHeights.every((height) => height <= 250),
					`${label} bounded real DOM`,
					preview,
				);
				check(
					preview.expanded.length === 1 &&
						preview.expanded[0] === false &&
						preview.buttonPositions[0] === (options.live ? "top" : "bottom"),
					`${label} uniform positioned entry`,
					preview,
				);
				check(
					preview.paintedBottom <= preview.rowHeight + 1,
					`${label} paint stays inside predicted row`,
					preview,
				);
				if (options.live) {
					await page.evaluate(() => window.__textPreviewSmoke.append());
					await frame();
					const updated = await snapshot();
					check(
						updated.text.includes("LATEST_刚刚到达") &&
							updated.lines < 40 &&
							updated.rowHeight === preview.rowHeight,
						`${label} advancing bounded live tail`,
						updated,
					);
				}
				await page.click("[data-vlist-text-preview-toggle]");
				await frame();
				const expanded = await snapshot();
				check(
					expanded.expanded[0] === true &&
						expanded.text.includes("HEAD_最初内容") &&
						expanded.text.includes("TAIL_完整末尾") &&
						expanded.lines > preview.lines,
					`${label} readonly inline full expansion`,
					expanded,
				);
				await page.click("[data-vlist-text-preview-toggle]");
				await frame();
				const collapsed = await snapshot();
				check(
					collapsed.expanded[0] === false &&
						collapsed.lines < 40 &&
						collapsed.rowHeight === preview.rowHeight,
					`${label} collapse restores geometry`,
					collapsed,
				);
			}
		}
	}
	await page.evaluate(() =>
		window.__textPreviewSmoke.set({
			kind: "incoming",
			width: 350,
			theme: "dark",
			live: false,
			lod: 1,
			short: true,
		}),
	);
	await frame();
	const short = await snapshot();
	check(
		short.expanded.length === 0 && short.text.includes("Short content stays unchanged."),
		"short text has no expansion chrome",
		short,
	);
	await page.evaluate(() =>
		window.__textPreviewSmoke.set({
			kind: "reasoning",
			width: 400,
			theme: "dark",
			live: false,
			lod: 5,
			sourceSoftBreaks: true,
		}),
	);
	await frame();
	const sourceBefore = await snapshot();
	const sourceScroll = await page.evaluate(() => {
		const source = document.querySelector<HTMLElement>("[data-vlist-markdown-source]");
		if (!source?.firstChild) throw new Error("Expected a raw source scrollport");
		source.scrollTop = source.scrollHeight;
		const text = source.textContent ?? "";
		const range = document.createRange();
		const start = text.lastIndexOf("LAST");
		if (start < 0) return { complete: false, scrollable: false, tailVisible: false };
		range.setStart(source.firstChild, start);
		range.setEnd(source.firstChild, start + 4);
		const tail = range.getBoundingClientRect();
		const viewport = source.getBoundingClientRect();
		return {
			complete: text === `${"word\n".repeat(20)}LAST`,
			scrollable:
				getComputedStyle(source).overflowY === "auto" && source.scrollHeight > source.clientHeight,
			tailVisible: tail.top >= viewport.top - 1 && tail.bottom <= viewport.bottom + 1,
		};
	});
	check(
		sourceScroll.complete && sourceScroll.scrollable && sourceScroll.tailVisible,
		"short reasoning source can scroll to its last raw line",
		sourceScroll,
	);
	check(
		sourceBefore.expanded.length === 0 && (await snapshot()).rowHeight === sourceBefore.rowHeight,
		"source scroll does not add a disclosure or change predicted row height",
		sourceBefore,
	);
	console.log(JSON.stringify({ checks, failures }, null, 2));
	if (failures.length) process.exitCode = 1;
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await browser?.close();
	server?.stop(true);
}
