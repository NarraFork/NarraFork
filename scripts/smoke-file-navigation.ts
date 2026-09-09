// bun scripts/smoke-file-navigation.ts [--expect-bug]
// Isolated Chrome/profile + loopback Vite fixture only. Never starts or touches the application.
// Uses Monaco public APIs and real Dockview/DOM geometry; CM private measurement tracing was removed.
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer, type ViteDevServer } from "vite";
import type { NavigationSnapshot } from "./smoke-file-navigation-fixture";

const project = join(import.meta.dir, "..");
const reportDir = join(
	project,
	".narrafork",
	`file-navigation-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const expectBug = process.argv.includes("--expect-bug");
if (process.argv.includes("--trace-measure"))
	throw new Error("--trace-measure was removed: the Monaco fixture uses public APIs only");
const checks: {
	name: string;
	pass: boolean;
	before: NavigationSnapshot;
	after: NavigationSnapshot;
}[] = [];
const errors: string[] = [];
const network: string[] = [];
const workerEvents: { url: string; state: string; handler?: string }[] = [];
let browser: Browser | undefined;
let server: ViteDevServer | undefined;
let screenshotCount = 0;
let timedOut = false;
let requests = 0;
let quickEnterDelayMs: number | null = null;
const stable = (before: NavigationSnapshot, after: NavigationSnapshot) =>
	Math.abs(before.header.top - after.header.top) <= 1 &&
	Math.abs(before.tab.top - after.tab.top) <= 1 &&
	Math.abs(before.tab.left - after.tab.left) <= 1 &&
	before.window.top === after.window.top &&
	before.window.left === after.window.left &&
	before.ancestors.every(
		(ancestor, index) =>
			Math.abs(ancestor.top - (after.ancestors[index]?.top ?? Infinity)) <= 1 &&
			Math.abs(ancestor.left - (after.ancestors[index]?.left ?? Infinity)) <= 1,
	);
const snapshot = (page: Page) => page.evaluate(() => window.__fileNavigation.snapshot());
const frames = (page: Page) => page.evaluate(() => window.__fileNavigation.frames());
async function check(
	page: Page,
	name: string,
	before: NavigationSnapshot,
	after: NavigationSnapshot,
	target = true,
) {
	const searchMatch =
		name === "search-first" || name === "search-repeat" || name === "readonly-source-search-first";
	const pass =
		stable(before, after) &&
		(!target || after.target.visible) &&
		after.active === "file" &&
		after.editor.visible &&
		before.editor.docLength === after.editor.docLength &&
		before.editor.modelId === after.editor.modelId &&
		before.editor.revision === after.editor.revision &&
		before.editor.canUndo === after.editor.canUndo &&
		(!name.startsWith("readonly") || after.editor.readOnly) &&
		(!name.endsWith("touch-scroll") || after.editor.top > before.editor.top + 20) &&
		(name !== "touch-horizontal" || after.editor.left > before.editor.left + 20) &&
		(!name.startsWith("long-line") || after.editor.left > 1000) &&
		(searchMatch
			? after.editor.selectionText === "SEARCH_TARGET"
			: after.editor.selectionText === "");
	checks.push({ name, pass, before, after });
	console.log(
		JSON.stringify({
			name,
			pass,
			header: [before.header.top, after.header.top],
			tab: [before.tab.top, after.tab.top],
			shell: [
				before.ancestors.find((a) => a.name === "shell")?.top,
				after.ancestors.find((a) => a.name === "shell")?.top,
			],
			editor: [before.editor.top, after.editor.top],
			horizontal: after.editor.left,
			targetVisible: after.target.visible,
			sameModel: before.editor.modelId === after.editor.modelId,
		}),
	);
	if ((!pass || name === "first-open") && screenshotCount < 6)
		await page.screenshot({ path: join(reportDir, `${++screenshotCount}-${name}.png`) });
}
await mkdir(reportDir, { recursive: true });
const deadline = setTimeout(() => {
	timedOut = true;
	process.exitCode = 2;
	void browser?.close();
	void server?.close();
	writeFileSync(
		join(reportDir, "timeout.json"),
		JSON.stringify({ timedOut, completedChecks: checks.length, errors }),
	);
	setTimeout(() => process.exit(2), 2000);
}, 118_000);
try {
	// Vite, rather than Bun.build, is necessary to exercise local new-URL worker entries.
	// configFile:false avoids all application build hooks and backend/database initialization.
	server = await createServer({
		configFile: false,
		root: project,
		logLevel: "error",
		clearScreen: false,
		cacheDir: join(reportDir, "vite-cache"),
		server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [project] } },
		resolve: {
			alias: { "@frontend": join(project, "frontend"), "@shared": join(project, "shared") },
		},
		esbuild: { jsx: "automatic" },
		optimizeDeps: {
			noDiscovery: true,
			include: [
				"react",
				"react-dom/client",
				"react/jsx-runtime",
				"react/jsx-dev-runtime",
				"@mantine/core",
				"@mantine/hooks",
				"@tabler/icons-react",
				"dockview-react",
				"i18next",
				"react-i18next",
			],
		},
		plugins: [
			{
				name: "isolated-monaco-navigation",
				configureServer(vite) {
					vite.middlewares.use((request, response, next) => {
						const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
						if (path === "/") {
							response.setHeader("Content-Type", "text/html");
							response.setHeader(
								"Content-Security-Policy",
								"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:",
							);
							response.end(
								'<!doctype html><html><head><meta charset="utf-8"><title>Monaco file navigation regression</title></head><body><div id="root"></div><script type="module" src="/scripts/smoke-file-navigation-fixture.tsx"></script></body></html>',
							);
						} else if (path === "/favicon.ico") {
							response.statusCode = 204;
							response.end();
						} else next();
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("No isolated loopback address");
	const origin = `http://127.0.0.1:${address.port}`;
	browser = await puppeteer.launch({
		executablePath:
			process.env.PUPPETEER_EXECUTABLE_PATH ??
			"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome",
		headless: true,
		timeout: 20_000,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
	});
	const page = await browser.newPage();
	page.on("workercreated", (worker) => {
		if (workerEvents.length >= 24) return;
		const event = { url: worker.url().slice(0, 500), state: "created", handler: "pending" };
		workerEvents.push(event);
		void worker
			.evaluate(async () => {
				const deadline = performance.now() + 5000;
				while (typeof self.onmessage !== "function" && performance.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 50));
				return JSON.stringify({
					handler: typeof self.onmessage,
					postMessage: typeof self.postMessage,
					document: typeof (self as unknown as { document?: unknown }).document,
				});
			})
			.then((handler) => {
				event.handler = handler;
			})
			.catch((error) => {
				event.state = String(error).slice(0, 500);
			});
	});
	page.on("workerdestroyed", (worker) => {
		if (workerEvents.length < 24)
			workerEvents.push({ url: worker.url().slice(0, 500), state: "destroyed" });
	});
	page.setDefaultTimeout(10_000);
	await page.setViewport({ width: 1100, height: 800 });
	// Chrome/Puppeteer Fetch interception stalls ESM worker startup even when every
	// request is continued. Enforce same-origin resources with CSP, and observe only.
	page.on("request", (request) => {
		requests++;
		if (requests > 15_000) {
			if (errors.length < 30) errors.push("Fixture request limit exceeded");
			void page.close();
		} else if (!request.url().startsWith(`${origin}/`) && !request.url().startsWith("data:")) {
			if (network.length < 20) network.push(request.url().slice(0, 250));
		}
	});
	page.on("console", (message) => {
		if (message.type() === "error" && errors.length < 30)
			errors.push(message.text().slice(0, 4000));
	});
	page.on("pageerror", (error) => {
		if (errors.length < 20) errors.push(String(error).slice(0, 1000));
	});
	async function reset(
		options: {
			readOnly?: boolean;
			wrapping?: boolean;
			longLine?: boolean;
			internalSearch?: boolean;
		} = {},
	) {
		await page.goto(origin, { waitUntil: "networkidle0", timeout: 20_000 });
		await page.waitForFunction(
			() => window.__fileNavigation?.ready && !!document.querySelector(".monaco-editor"),
		);
		await page.evaluate((value) => window.__fileNavigation.configure(value), options);
		await frames(page);
		return snapshot(page);
	}
	async function open(line: number, column = 1) {
		await page.evaluate((value) => window.__fileNavigation.open(value.line, value.column), {
			line,
			column,
		});
		await frames(page);
		return snapshot(page);
	}
	const initial = await reset();
	const first = await open(100);
	await check(page, "first-open", initial, first);
	await page.evaluate(() => window.__fileNavigation.activate());
	await frames(page);
	const control = await snapshot(page);
	await check(page, "activation-only-control", first, control);
	await check(page, "repeat-same-position", control, await open(100));
	await reset();
	await open(100);
	await page.evaluate(() => window.__fileNavigation.hide());
	await frames(page);
	const hiddenControl = await snapshot(page);
	if (hiddenControl.editor.visible) errors.push("Hidden Dockview tab forces Monaco visible");
	await page.evaluate(() => window.__fileNavigation.activate());
	await frames(page);
	await check(page, "hidden-activation-only-control", hiddenControl, await snapshot(page));
	const differentInitial = await reset();
	const differentFirst = await open(40);
	await check(page, "different-first", differentInitial, differentFirst);
	await check(page, "different-position", differentFirst, await open(160));
	await reset();
	await open(100);
	await page.evaluate(() => window.__fileNavigation.hide());
	await frames(page);
	const hidden = await snapshot(page);
	if (hidden.editor.visible) errors.push("Hidden editor remains visible before reopen");
	await check(page, "hidden-tab-reopen", hidden, await open(100));
	const readOnlyInitial = await reset({ readOnly: true, wrapping: true });
	const readOnlyFirst = await open(100, 35);
	await check(page, "readonly-wrap-first", readOnlyInitial, readOnlyFirst);
	await check(page, "readonly-wrap-repeat", readOnlyFirst, await open(100, 35));
	const longInitial = await reset({ longLine: true });
	const longFirst = await open(60, 1800);
	await check(page, "long-line-first", longInitial, longFirst);
	await check(page, "long-line-repeat", longFirst, await open(60, 1800));
	const near = await open(60, 2);
	await check(page, "cross-column-return-left", longFirst, near);
	if (near.editor.left >= longFirst.editor.left)
		errors.push("Cross-column navigation did not return left");
	await check(page, "long-line-cross-column-right", near, await open(60, 2000));
	const searchInitial = await reset({ readOnly: true });
	await page.evaluate(() => window.__fileNavigation.search());
	await page.waitForSelector('input[name="search"]');
	await frames(page);
	const searchOpened = await snapshot(page);
	await check(page, "search-panel-open", searchInitial, searchOpened, false);
	await page.type('input[name="search"]', "SEARCH_TARGET");
	await page.waitForFunction(
		() =>
			/[1-9][0-9]* matches/.test(
				document.querySelector("[data-editor-panel]")?.textContent ?? "",
			) || !!document.querySelector('[data-editor-search-panel] [role="alert"]'),
		{ timeout: 35_000 },
	);
	const searchError = await page.$eval(
		"[data-editor-search-panel]",
		(element) => element.querySelector('[role="alert"]')?.textContent,
	);
	if (searchError) throw new Error(`Worker search failed: ${searchError}`);
	await page.keyboard.press("Enter");
	await frames(page);
	const searchFirst = await snapshot(page);
	await check(page, "search-first", searchOpened, searchFirst);
	await page.keyboard.press("Enter");
	await frames(page);
	await check(page, "search-repeat", searchFirst, await snapshot(page));
	const sourceInitial = await reset({ readOnly: true, internalSearch: true });
	await page.evaluate(() => {
		window.__fileNavigation.search();
		window.__fileNavigation.focus();
	});
	await page.keyboard.down("Control");
	await page.keyboard.press("f");
	await page.keyboard.up("Control");
	await page.waitForSelector('input[name="search"]');
	await frames(page);
	const sourceOpened = await snapshot(page);
	await check(page, "readonly-source-search-open", sourceInitial, sourceOpened, false);
	const sourceUI = await page.evaluate(() => ({
		count: document.querySelectorAll("[data-editor-search-panel]").length,
		replace: !!document.querySelector('input[name="replace"]'),
	}));
	if (sourceUI.count !== 1 || sourceUI.replace)
		errors.push(
			"Standalone readonly CtrlF must show exactly one search panel without replace controls",
		);
	await page.$eval('input[name="search"]', (node) => {
		const input = node as HTMLInputElement;
		input.addEventListener("input", () => {
			input.dataset.lastInputAt = String(performance.now());
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter")
				input.dataset.enterDelay = String(performance.now() - Number(input.dataset.lastInputAt));
		});
	});
	await page.type('input[name="search"]', "SEARCH_TARGET");
	await page.keyboard.press("Enter");
	await page.waitForFunction(
		() => window.__fileNavigation.snapshot().editor.selectionText === "SEARCH_TARGET",
		{ timeout: 35_000 },
	);
	await frames(page);
	quickEnterDelayMs = await page.$eval('input[name="search"]', (input) =>
		Number((input as HTMLInputElement).dataset.enterDelay),
	);
	if (!(quickEnterDelayMs >= 0 && quickEnterDelayMs < 150))
		errors.push(`Fast Enter not exercised: ${quickEnterDelayMs}ms`);
	await check(page, "readonly-source-search-first", sourceOpened, await snapshot(page));
	// Enable touch BEFORE reloading: Monaco detects touch support during module initialization.
	await page.setViewport({ width: 1100, height: 800, hasTouch: true });
	const touchSession = await page.createCDPSession();
	for (const [name, options, horizontal] of [
		["touch-scroll", {}, false],
		["readonly-touch-scroll", { readOnly: true }, false],
		["touch-horizontal", { longLine: true }, true],
	] as const) {
		const before = await reset(options);
		const origin = await page.$eval(".monaco-editor .view-lines", (element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.left + 350, y: rect.top + 250 };
		});
		await touchSession.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ ...origin, id: 1 }],
		});
		for (let step = 1; step <= 8; step++) {
			await touchSession.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [
					{
						id: 1,
						x: origin.x - (horizontal ? step * 20 : 0),
						y: origin.y - (horizontal ? 0 : step * 20),
					},
				],
			});
			await frames(page);
		}
		await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await frames(page);
		await check(page, name, before, await snapshot(page), false);
	}
	await touchSession.detach();
	const bugConfirmed =
		checks.some((item) => item.name === "activation-only-control" && item.pass) &&
		checks.some((item) => item.name === "first-open" && item.pass) &&
		checks.some((item) => item.name === "repeat-same-position" && !stable(item.before, item.after));
	const passed =
		errors.length === 0 &&
		network.length === 0 &&
		(expectBug ? bugConfirmed : checks.every((item) => item.pass));
	if (!passed) process.exitCode = 1;
	console.log(
		`Result: ${passed ? "PASS" : "FAIL"}; expectBug=${expectBug}; bugConfirmed=${bugConfirmed}`,
	);
} catch (error) {
	errors.push(String(error).slice(0, 4000));
	process.exitCode = 2;
	const page = (await browser?.pages())?.at(-1);
	if (page && screenshotCount < 6) {
		await page
			.screenshot({ path: join(reportDir, `${++screenshotCount}-failure.png`) })
			.catch(() => {});
		const detail = await page
			.evaluate(() => ({
				search: document.querySelector("[data-editor-search-panel]")?.textContent?.slice(0, 2500),
				query: (document.querySelector('input[name="search"]') as HTMLInputElement | null)?.value,
			}))
			.catch(() => null);
		errors.push(JSON.stringify(detail));
		for (const worker of page.workers().slice(0, 4)) {
			const status = await worker
				.evaluate(() => ({ handler: typeof self.onmessage, href: self.location.href }))
				.catch((failure) => ({ failure: String(failure).slice(0, 300) }));
			errors.push(JSON.stringify({ worker: worker.url().slice(0, 500), status }));
		}
	}
} finally {
	await browser?.close();
	await server?.close();
	clearTimeout(deadline);
	const report = JSON.stringify(
		{
			editor: "Monaco public API",
			fixture: "Real Dockview and worker-backed Mantine search",
			expectBug,
			timedOut,
			requests,
			checks,
			errors,
			blockedNetwork: network,
			workerEvents,
			quickEnterDelayMs,
			screenshotCount,
		},
		null,
		2,
	);
	if (Buffer.byteLength(report) > 2 * 1024 * 1024) {
		process.exitCode = 2;
		await Bun.write(
			join(reportDir, "report.json"),
			JSON.stringify({ errors: ["Report exceeds 2MiB"], timedOut }),
		);
	} else await Bun.write(join(reportDir, "report.json"), report);
	console.log(`Report: ${reportDir}/report.json`);
	if (errors.length) console.error(errors.join("\n"));
}
