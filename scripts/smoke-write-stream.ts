// Own ephemeral server/profile. Never connects to the running application or its DB.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { percentile, type WriteStreamCase } from "./smoke-write-stream-data";
import type { WriteStreamSnapshot } from "./smoke-write-stream-fixture";

const root = resolve(import.meta.dir, "..");
const baseline = process.argv.includes("--baseline");
const quick = process.argv.includes("--quick");
const base = process.argv.includes("--subpath") ? "/nf/" : "/";
const sourceRoot = baseline ? join(root, ".narrafork/write-streaming-baseline") : root;
const reportDir = join(
	root,
	".narrafork",
	`write-streaming-${baseline ? "before" : "after"}-${Date.now()}`,
);
const errors: string[] = [];
const failedRequests: string[] = [];
const results: Array<{
	test: WriteStreamCase;
	snapshot?: WriteStreamSnapshot;
	keyP95?: number;
	keyMax?: number;
	fullText?: boolean;
	clipboard?: boolean;
	search?: boolean;
	settled?: WriteStreamSnapshot;
	pass?: boolean;
	error?: string;
	diagnostics?: unknown;
}> = [];
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let timedOut = false;
const deadline = setTimeout(() => {
	timedOut = true;
	void browser?.close();
	server?.stop(true);
}, 300_000);

async function chromePath() {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache))
		for await (const file of new Bun.Glob(
			"chrome/*/**/{chrome,chrome.exe,Google Chrome for Testing}",
		).scan({ cwd: cache, absolute: true }))
			return file;
	for (const file of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"])
		if (existsSync(file)) return file;
	throw new Error("Chrome unavailable; set PUPPETEER_EXECUTABLE_PATH. No automatic downloads.");
}

async function fixtureServer() {
	const entrypoints = [join(sourceRoot, "scripts/smoke-write-stream-fixture.tsx")];
	const storeFile = join(sourceRoot, "frontend/lib/text-document-store.ts");
	if (!baseline && existsSync(storeFile)) {
		entrypoints.push(storeFile);
		entrypoints.push(join(sourceRoot, "frontend/components/narrator/content/document-source.ts"));
	}
	if (!baseline)
		for await (const file of new Bun.Glob("**/*text-document*.worker.ts").scan({
			cwd: join(sourceRoot, "frontend"),
			absolute: true,
		}))
			entrypoints.push(file);
	const build = await Bun.build({
		entrypoints,
		target: "browser",
		minify: true,
		splitting: true,
		publicPath: base,
		tsconfig: join(sourceRoot, "tsconfig.json"),
		define: {
			"process.env.NODE_ENV": '"production"',
			"import.meta.env": JSON.stringify({ BASE_URL: base, DEV: false, PROD: true }),
		},
		plugins: [
			{
				name: "fixture-worker-urls",
				setup(builder) {
					builder.onLoad({ filter: /\.tsx?$/ }, async (args) => {
						const source = await Bun.file(args.path).text();
						// Bun's browser build does not rewrite Vite's new URL("*.worker.ts") convention.
						if (!source.includes(".worker.ts")) return undefined;
						return {
							contents: source.replace(/(["'])([^"']+\.worker)\.ts\1/g, "$1$2.js$1"),
							loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
						};
					});
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 12_000));
	if (build.outputs.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024)
		throw new Error("Fixture exceeds bundle budget");
	const assets = new Map(build.outputs.map((file) => [`${base}${basename(file.path)}`, file]));
	const entry = build.outputs.find(
		(file) =>
			file.kind === "entry-point" && basename(file.path) === "smoke-write-stream-fixture.js",
	);
	if (!entry) throw new Error("Missing fixture bundle");
	const storeEntry = build.outputs.find(
		(file) => file.kind === "entry-point" && basename(file.path) === "text-document-store.js",
	);
	const bridgeEntry = build.outputs.find(
		(file) => file.kind === "entry-point" && basename(file.path) === "document-source.js",
	);
	const html = `<!doctype html><html><head><base href="${base}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${[
		...assets.keys(),
	]
		.filter((key) => key.endsWith(".css"))
		.map((key) => `<link rel="stylesheet" href="${key}">`)
		.join(
			"",
		)}</head><body><div id="root"></div><script type="module" src="${base}${basename(entry.path)}"></script></body></html>`;
	const shiki = new Map<string, string>();
	for (const [part, names] of [
		["langs", ["typescript", "javascript"]],
		["themes", ["github-dark-default", "github-light-default"]],
	] as const)
		for (const name of names)
			shiki.set(
				`${base}shiki/${part}/${name}.mjs`,
				Bun.resolveSync(`@shikijs/${part}/${name}`, root),
			);
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024,
		async fetch(request) {
			if (request.method !== "GET") return new Response("read only", { status: 405 });
			const path = new URL(request.url).pathname;
			if (path === base) return new Response(html, { headers: { "content-type": "text/html" } });
			if (path === `${base}favicon.ico` || path === "/favicon.ico")
				return new Response(null, { status: 204 });
			if (path === `${base}fixture-info`)
				return Response.json({
					storeEntry: storeEntry ? `${base}${basename(storeEntry.path)}` : null,
					bridgeEntry: bridgeEntry ? `${base}${basename(bridgeEntry.path)}` : null,
				});
			if (path === `${base}api/user-preferences`) return Response.json({});
			if (path === `${base}api/settings`) return Response.json({ agent: {} });
			const grammar = shiki.get(path);
			if (grammar) {
				const file = Bun.file(grammar);
				if (file.size > 4 * 1024 * 1024) return new Response("oversized", { status: 413 });
				return new Response(file, { headers: { "content-type": "text/javascript" } });
			}
			const asset = assets.get(path);
			if (asset) return new Response(asset);
			if (failedRequests.length < 25) failedRequests.push(path.slice(0, 180));
			return new Response("isolated fixture", { status: 404 });
		},
	});
}

async function runCase(page: Page, test: WriteStreamCase) {
	const result: (typeof results)[number] = { test };
	results.push(result);
	let stage = "start";
	try {
		await page.evaluate((options) => window.__writeStreamAudit.start(options), test);
		await page.waitForFunction(() => window.__writeStreamAudit.snapshot().received > 0, {
			timeout: 10_000,
		});
		await page.waitForFunction(
			(minimum) => window.__writeStreamAudit.snapshot().received >= minimum,
			{ timeout: 90_000 },
			Math.floor(test.chars * 0.6),
		);
		if (!baseline) {
			const during = await page.evaluate(() => window.__writeStreamAudit.snapshot());
			if (during.bodyRows === 0 || during.bodyChars === 0)
				throw new Error(
					`Streaming content was not readable before completion: ${JSON.stringify(during)}`,
				);
		}
		await page.focus("#response-probe");
		const latencies: number[] = [];
		for (let i = 0; i < 40; i++) {
			const before = await page.evaluate(() => window.__writeStreamAudit.snapshot());
			if (before.done) break;
			const start = performance.now();
			await page.keyboard.type("x");
			latencies.push(performance.now() - start);
			await page.waitForFunction(
				(received) => {
					const state = window.__writeStreamAudit.snapshot();
					return state.done || state.received > received;
				},
				{ timeout: 30_000 },
				before.received,
			);
		}
		await page.waitForFunction(() => window.__writeStreamAudit.snapshot().done, {
			timeout: 90_000,
		});
		if (!baseline) {
			await page.waitForFunction(
				() => {
					const state = window.__writeStreamAudit.snapshot();
					return (
						state.bodyRows > 0 &&
						state.bodyChars > 0 &&
						state.highlightReady &&
						state.bodyColors >= 2
					);
				},
				{ timeout: 60_000 },
			);
		}
		result.snapshot = await page.evaluate(() => window.__writeStreamAudit.snapshot());
		result.keyP95 = percentile(latencies, 0.95);
		result.keyMax = Math.max(0, ...latencies);
		result.fullText = await page.evaluate(() => window.__writeStreamAudit.fullTextMatches());
		stage = "fullscreen viewport";
		await page.evaluate(() => window.__writeStreamAudit.showFullscreen());
		await page.waitForFunction(() => !!document.querySelector("#full [data-content-scrollport]"), {
			timeout: 20_000,
		});
		await page.evaluate(() => window.__writeStreamAudit.finish());
		await page.waitForFunction(
			() =>
				window.__writeStreamAudit.snapshot().received ===
				window.__writeStreamAudit.snapshot().expected,
			{ timeout: 10_000 },
		);
		if (!baseline) {
			await page.waitForFunction(
				() => {
					const state = window.__writeStreamAudit.snapshot();
					return state.highlightReady && state.bodyRows > 0 && state.bodyChars > 0;
				},
				{ timeout: 60_000 },
			);
			const body = "#card [data-document-code-body]";
			await page.focus(body);
			await page.keyboard.down("Control");
			await page.keyboard.press("a");
			await page.keyboard.press("c");
			await page.keyboard.up("Control");
			stage = "complete source clipboard";
			await page.waitForFunction(async () => window.__writeStreamAudit.clipboardMatches(), {
				timeout: 20_000,
			});
			result.clipboard = await page.evaluate(() => window.__writeStreamAudit.clipboardMatches());
			await page.keyboard.down("Control");
			await page.keyboard.press("f");
			await page.keyboard.up("Control");
			const find = '[aria-label="Find in full source"]';
			await page.waitForSelector(find, { timeout: 10_000 });
			await page.click(find);
			await page.keyboard.type(test.singleLine ? "entry-0-中文" : "entry0");
			await page.keyboard.press("Enter");
			stage = "full source search jump";
			await page.waitForFunction(() => window.__writeStreamAudit.viewport().scrollTop < 100, {
				timeout: 20_000,
			});
			result.search = true;
			await page.keyboard.press("Escape");
		}
		result.settled = await page.evaluate(() => window.__writeStreamAudit.snapshot());
		const steady = result.snapshot;
		result.pass =
			baseline ||
			(result.fullText &&
				result.clipboard &&
				result.search &&
				steady.mainHighlightCalls === 0 &&
				steady.bodyRows > 0 &&
				steady.bodyChars > 0 &&
				steady.bodyColors >= 2 &&
				steady.highlightReady &&
				steady.bodyAlerts.length === 0 &&
				steady.errors.length === 0 &&
				steady.maxNodes < 5_000 &&
				(result.keyP95 ?? 0) < 50 &&
				(result.keyMax ?? 0) < 200);
		if (!result.pass)
			await page.screenshot({ path: join(reportDir, `failure-${results.length}.png`) });
	} catch (error) {
		result.error = `${stage}: ${String(error)}`.slice(0, 4_000);
		result.pass = false;
		result.diagnostics = await page
			.evaluate(async () => ({
				snapshot: window.__writeStreamAudit.snapshot(),
				active: document.activeElement?.outerHTML.slice(0, 1_000),
				alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((node) =>
					node.textContent?.slice(0, 300),
				),
				body: document.querySelector("#card [data-document-code-body]")?.outerHTML.slice(0, 3_000),
				clipboard: await window.__writeStreamAudit.clipboardDiagnostic(),
				clipboardLength: await navigator.clipboard
					.readText()
					.then((value) => value.length)
					.catch(() => -1),
			}))
			.catch(() => undefined);
		await page
			.screenshot({ path: join(reportDir, `failure-${results.length}.png`) })
			.catch(() => {});
	}
	console.log(JSON.stringify(result));
}

try {
	await mkdir(reportDir, { recursive: true });
	server = await fixtureServer();
	browser = await puppeteer.launch({
		executablePath: await chromePath(),
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		protocolTimeout: 90_000,
	});
	await browser
		.defaultBrowserContext()
		.overridePermissions(`http://127.0.0.1:${server.port}`, [
			"clipboard-read",
			"clipboard-write",
			"clipboard-sanitized-write",
		]);
	const page = await browser.newPage();
	await page.setViewport({ width: 1200, height: 1000 });
	page.on("pageerror", (error) => {
		if (errors.length < 20) errors.push(String(error).slice(0, 4_000));
	});
	await page.goto(`http://127.0.0.1:${server.port}${base}`, {
		waitUntil: "networkidle0",
		timeout: 60_000,
	});
	await page.waitForFunction(() => !!window.__writeStreamAudit, { timeout: 20_000 });
	const tests: WriteStreamCase[] = quick
		? [
				{ chars: 30_000, chunkChars: 512, intervalMs: 50 },
				{ chars: 100_000, chunkChars: 2048, intervalMs: 50, singleLine: true },
			]
		: [
				{ chars: 10_000, chunkChars: 256, intervalMs: 50 },
				{ chars: 30_000, chunkChars: 512, intervalMs: 50 },
				{ chars: 100_000, chunkChars: 2048, intervalMs: 50, crlf: true },
				{ chars: 100_000, chunkChars: 2048, intervalMs: 50, singleLine: true, theme: "light" },
				{ chars: 1024 * 1024, chunkChars: 16_384, intervalMs: 50 },
			];
	const selected = process.argv.includes("--stress-single")
		? [{ chars: 1024 * 1024, chunkChars: 16_384, intervalMs: 50, singleLine: true }]
		: process.argv.includes("--one")
			? tests.slice(0, 1)
			: tests;
	for (const test of selected) {
		if (timedOut) break;
		await runCase(page, test);
	}
} catch (error) {
	errors.push(String(error).slice(0, 8_000));
} finally {
	clearTimeout(deadline);
	await browser?.close().catch(() => {});
	server?.stop(true);
	const report = JSON.stringify(
		{ baseline, base, timedOut, results, errors, failedRequests },
		null,
		2,
	);
	if (new TextEncoder().encode(report).byteLength > 2 * 1024 * 1024) {
		console.error("Report exceeds byte budget");
		process.exitCode = 1;
	} else {
		await Bun.write(join(reportDir, "report.json"), report);
		console.log(`Write streaming report: ${join(reportDir, "report.json")}`);
	}
	if (timedOut || errors.length || failedRequests.length || results.some((result) => !result.pass))
		process.exitCode = 1;
}
