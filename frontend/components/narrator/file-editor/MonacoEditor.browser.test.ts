import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build, createServer, type ViteDevServer } from "vite";
import type { fixture } from "./MonacoEditor.browser-fixture";
import type { fixture as workerFixture } from "./monaco-worker-policy.browser-fixture";

type FixtureWindow = Window & { monacoQuoteFixture: typeof fixture };
type WorkerFixtureWindow = Window & { monacoWorkerFixture: typeof workerFixture };
const root = resolve(import.meta.dir, "../../../..");
const cacheDir = resolve(root, ".narrafork", `monaco-quote-test-${crypto.randomUUID()}`);
let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let origin: string;
let builtEntry = "";
const builtAssets = new Map<string, { body: string | Uint8Array; contentType: string }>();
const selected = { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 7 };
const button = '[data-editor="0"] [data-monaco-quote-selection]';

beforeAll(async () => {
	const executablePath =
		process.env.NF_TEST_CHROMIUM_PATH ??
		process.env.PUPPETEER_EXECUTABLE_PATH ??
		"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	// Exercise the private arity/shape checks against production minification, not only Vite dev.
	// In-memory output: no app config, route generation, backend or production build artifacts.
	const outputs = await build({
		configFile: false,
		root,
		base: "/worker-policy-build/",
		logLevel: "error",
		build: {
			write: false,
			target: "esnext",
			minify: true,
			rollupOptions: {
				input: resolve(
					root,
					"frontend/components/narrator/file-editor/monaco-worker-policy.browser-fixture.ts",
				),
			},
		},
	});
	if (!("output" in outputs)) throw new Error("Expected one isolated Monaco browser build");
	for (const output of outputs.output) {
		if (output.type === "chunk" && output.isEntry) builtEntry = output.fileName;
		builtAssets.set(`/worker-policy-build/${output.fileName}`, {
			body: output.type === "chunk" ? output.code : output.source,
			contentType: output.fileName.endsWith(".css") ? "text/css" : "text/javascript",
		});
	}
	if (!builtEntry) throw new Error("Missing isolated Monaco production entry");
	// Vite must transform Monaco's real new-URL module worker; no app config/backend/database.
	server = await createServer({
		configFile: false,
		root,
		logLevel: "error",
		clearScreen: false,
		cacheDir,
		server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
		resolve: {
			alias: { "@frontend": resolve(root, "frontend"), "@shared": resolve(root, "shared") },
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
				"i18next",
				"react-i18next",
			],
		},
		plugins: [
			{
				name: "isolated-monaco-quote-fixture",
				configureServer(vite) {
					vite.middlewares.use((request, response, next) => {
						const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
						const builtAsset = builtAssets.get(path);
						if (builtAsset) {
							response.setHeader("Content-Type", builtAsset.contentType);
							response.end(builtAsset.body);
						} else if (path === "/worker-policy-production") {
							response.setHeader("Content-Type", "text/html");
							response.end(
								`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/worker-policy-build/${builtEntry}"></script></body></html>`,
							);
						} else if (path === "/monaco-policy-rejected-handshake.js") {
							response.setHeader("Content-Type", "text/javascript");
							response.end(`self.onmessage = ({ data: request }) => {
								if (request?.type !== 0) return;
								self.postMessage({type: 1, vsWorker: request.vsWorker, seq: request.req,
									err: request.method === '$ping'
										? {$isError: true, name: 'Error', message: 'injected handshake rejection'}
										: undefined});
							};`);
						} else if (path === "/worker-policy") {
							response.setHeader("Content-Type", "text/html");
							response.end(
								'<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/frontend/components/narrator/file-editor/monaco-worker-policy.browser-fixture.ts"></script></body></html>',
							);
						} else if (path === "/") {
							response.setHeader("Content-Type", "text/html");
							response.setHeader(
								"Content-Security-Policy",
								"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:",
							);
							response.end(
								'<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="/frontend/components/narrator/file-editor/MonacoEditor.browser-fixture.tsx"></script></body></html>',
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
	if (!address || typeof address === "string") throw new Error("Missing isolated loopback port");
	origin = `http://127.0.0.1:${address.port}`;
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		timeout: 20_000,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
	});
}, 60_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		await server?.close();
		await rm(cacheDir, { recursive: true, force: true });
	}
});
async function frames(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
	);
}
async function snapshot(page: Page, index = 0) {
	return page.evaluate(
		(i) => (window as unknown as FixtureWindow).monacoQuoteFixture.snapshot(i),
		index,
	);
}
async function withPage(run: (page: Page) => Promise<void>) {
	if (!browser) throw new Error("Browser unavailable");
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => {
		if (errors.length < 20) errors.push(String(error));
	});
	page.setDefaultTimeout(15_000);
	await page.setViewport({ width: 1100, height: 700 });
	try {
		await page.goto(origin);
		await page.waitForFunction(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture?.ready(),
		);
		await frames(page);
		await run(page);
		expect((await snapshot(page)).errors).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await page.close();
	}
}

test("real Monaco glyph quote preserves code geometry, selection, undo and the originating editor", async () => {
	await withPage(async (page) => {
		const before = await snapshot(page);
		await page.evaluate(
			(range) => (window as unknown as FixtureWindow).monacoQuoteFixture.select(0, range),
			selected,
		);
		await frames(page);
		const shown = await snapshot(page);
		expect(shown.button?.visible).toBe(true);
		if (!shown.button || shown.button.lineNumberLeft === undefined)
			throw new Error("Missing glyph button or line-number geometry");
		expect(shown.button.right).toBeLessThanOrEqual(shown.button.lineNumberLeft);
		expect(shown.contentLeft).toBe(before.contentLeft);
		expect(shown.modelId).toBe(before.modelId);
		expect((await snapshot(page, 1)).button).toBeNull();
		if (process.env.NF_TEST_MONACO_QUOTE_PREVIEW === "1")
			await page.screenshot({ path: resolve(root, ".narrafork/monaco-quote-preview.png") });
		await page.click(button);
		await frames(page);
		const after = await snapshot(page);
		expect(after.selection).toEqual(selected);
		expect(after.value).toBe(before.value);
		expect(after.version).toBe(before.version);
		expect(after.alternativeVersion).toBe(before.alternativeVersion);
		expect(after.canUndo).toBe(before.canUndo);
		expect(after.contentLeft).toBe(before.contentLeft);
		expect(after.quotes).toEqual([{ index: 0, selection: selected }]);
		// A separate editor's native Tab indentation must never dispatch a quote.
		await page.evaluate(() => (window as unknown as FixtureWindow).monacoQuoteFixture.focus(1));
		await page.keyboard.press("Tab");
		await frames(page);
		expect((await snapshot(page, 1)).value).toMatch(/^\s+second editor/);
		expect((await snapshot(page)).quotes).toHaveLength(1);
		await page.keyboard.down("Control");
		await page.keyboard.press("z");
		await page.keyboard.up("Control");
		expect((await snapshot(page, 1)).value).toBe("second editor\nno selection");
	});
}, 60_000);

test("readonly quotes, disabled/latest reason and callback removal retain the same model", async () => {
	await withPage(async (page) => {
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.configure({ readOnly: true }),
		);
		await frames(page);
		await page.evaluate(
			(range) => (window as unknown as FixtureWindow).monacoQuoteFixture.select(0, range),
			selected,
		);
		await frames(page);
		const before = await snapshot(page);
		await page.click(button);
		expect((await snapshot(page)).quotes).toEqual([{ index: 0, selection: selected }]);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.configure({
				readOnly: true,
				reason: "Save before quoting",
			}),
		);
		await frames(page);
		expect((await snapshot(page)).button).toMatchObject({
			disabled: true,
			title: "Save before quoting",
		});
		await page.click(button);
		expect((await snapshot(page)).quotes).toHaveLength(1);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.configure({
				readOnly: true,
				reason: null,
			}),
		);
		await frames(page);
		await page.click(button);
		expect((await snapshot(page)).quotes).toHaveLength(2);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.configure({ callback: false }),
		);
		await frames(page);
		const after = await snapshot(page);
		expect(after.button).toBeNull();
		expect(after.modelId).toBe(before.modelId);
		expect(after.contentLeft).toBe(before.contentLeft);
		expect(after.selection).toEqual(selected);
	});
}, 30_000);

test("native range widget follows long selection scrolling/folding and is removed on collapse, owner switch and unmount", async () => {
	await withPage(async (page) => {
		const range = { startLineNumber: 2, startColumn: 1, endLineNumber: 100, endColumn: 10 };
		await page.evaluate(
			(selection) => (window as unknown as FixtureWindow).monacoQuoteFixture.select(0, selection),
			range,
		);
		await frames(page);
		const before = await snapshot(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.scroll(0, 800),
		);
		await frames(page);
		const scrolled = await snapshot(page);
		expect(scrolled.button?.visible).toBe(true);
		expect(scrolled.selection).toEqual(range);
		expect(scrolled.contentLeft).toBe(before.contentLeft);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.fold(0, 30, 70),
		);
		await frames(page);
		const folded = await snapshot(page);
		expect(folded.button?.visible).toBe(true);
		if (folded.contentHeight === undefined || scrolled.contentHeight === undefined)
			throw new Error("Missing native content height");
		expect(folded.contentHeight).toBeLessThan(scrolled.contentHeight);
		expect(folded.selection).toEqual(range);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.scroll(0, 4000),
		);
		await frames(page);
		expect((await snapshot(page)).button?.visible ?? false).toBe(false);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.select(0, {
				startLineNumber: 1,
				endLineNumber: 1,
				startColumn: 1,
				endColumn: 1,
			}),
		);
		await frames(page);
		expect((await snapshot(page)).button).toBeNull();
		await page.evaluate(
			(selection) => (window as unknown as FixtureWindow).monacoQuoteFixture.select(0, selection),
			selected,
		);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.configure({ owner: "new-file" }),
		);
		await frames(page);
		const changed = await snapshot(page);
		expect(changed.modelId).not.toBe(before.modelId);
		expect(changed.button).toBeNull();
		await page.evaluate(
			(selection) => (window as unknown as FixtureWindow).monacoQuoteFixture.select(0, selection),
			selected,
		);
		await frames(page);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.configure({
				owner: "new-file",
				mounted: false,
			}),
		);
		await frames(page);
		expect(await page.$(button)).toBeNull();
		expect((await snapshot(page)).modelId).toBeUndefined();
	});
}, 30_000);

for (const deployment of ["development", "production"] as const) {
	for (const path of ["service", "standalone"] as const) {
		for (const mode of ["healthy", "construct", "disabled", "handshake", "crash"] as const) {
			test(`strict Monaco ${deployment} ${path} ${mode}: real Worker RPC, no synchronous instance`, async () => {
				if (!browser) throw new Error("Browser unavailable");
				const page = await browser.newPage();
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(String(error)));
				try {
					await page.goto(
						`${origin}/worker-policy${deployment === "production" ? "-production" : ""}`,
					);
					await page.waitForFunction(() =>
						Boolean((window as unknown as WorkerFixtureWindow).monacoWorkerFixture),
					);
					const result = await page.evaluate(
						(input) =>
							(window as unknown as WorkerFixtureWindow).monacoWorkerFixture.run(
								input.mode,
								input.path,
							),
						{ mode, path },
					);
					expect(result.synchronousInstances).toBe(0);
					expect(result.originalFallbackCalls).toBe(0);
					expect(result.workerCleared).toBe(true);
					expect(result.modelManagerCleared).toBe(true);
					if (mode === "healthy" || mode === "crash") {
						if (path === "service") {
							expect(result.firstResult).toMatchObject([{ url: "https://example.com/first" }]);
						} else {
							expect(result.firstResult).toEqual({
								dom: "undefined",
								text: ["visit https://example.com/first"],
							});
						}
					}
					if (mode === "healthy") {
						expect(result.failure).toBeUndefined();
						if (path === "service") {
							expect(result.secondResult).toMatchObject([{ url: "https://example.com/second" }]);
						} else {
							expect(result.secondResult).toEqual({
								dom: "undefined",
								text: ["updated https://example.com/second"],
							});
						}
					} else {
						expect(result.failure?.name).toBe("MonacoWorkerUnavailableError");
						expect(result.failure?.message).toContain("Monaco Worker unavailable");
						if (mode === "crash") expect(result.failure?.cause).toContain("timed out after 1000ms");
					}
					if (mode === "construct" || mode === "disabled") expect(result.created).toBe(0);
					else {
						expect(result.created).toBe(1);
						expect(result.terminated).toBeGreaterThanOrEqual(1);
					}
					// Let Chromium dispatch unhandledrejection/pageerror before closing this page.
					await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 0)));
					expect(errors).toEqual([]);
				} finally {
					await page.close();
				}
			}, 30_000);
		}
	}
}

test("Vite serves the production Monaco module worker with a live handler", async () => {
	await withPage(async (page) => {
		const workerPromise = new Promise<import("puppeteer-core").WebWorker>((done, reject) => {
			const timeout = setTimeout(() => reject(new Error("Monaco worker did not start")), 10_000);
			page.once("workercreated", (worker) => {
				clearTimeout(timeout);
				done(worker);
			});
		});
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).monacoQuoteFixture.startWorker(),
		);
		const worker = await workerPromise;
		expect(worker.url()).toContain("monaco.worker.ts");
		let initialized: { handler: string; dom: string } | undefined;
		const deadline = Date.now() + 10_000;
		do {
			initialized = await worker.evaluate(() => ({
				handler: typeof self.onmessage,
				dom: typeof (self as unknown as { document?: unknown }).document,
			}));
			if (initialized.handler === "function") break;
			// A freshly created CDP worker context can precede even its timer globals.
			await new Promise((done) => setTimeout(done, 25));
		} while (Date.now() < deadline);
		expect(initialized).toEqual({ handler: "function", dom: "undefined" });
	});
}, 30_000);
