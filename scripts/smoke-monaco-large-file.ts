// bun scripts/smoke-monaco-large-file.ts --mode=kernel [--cases=typescript-20] [--cold=10] [--keys=100]
// Full acceptance is intentionally separate from the minimal kernel/component gate.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { createServer, type ViteDevServer } from "vite";
import { buildFixtureBundle, fixtureHtml } from "./smoke-monaco-large-file-bundle";
import { createFixture, type FixtureSpec, MiB, matrix } from "./smoke-monaco-large-file-data";
import type {} from "./smoke-monaco-large-file-fixture";
import { createFullProtocolFixture } from "./smoke-monaco-large-file-protocol";

const root = join(import.meta.dir, "..");
const option = (name: string, fallback: string) =>
	process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const numberOption = (name: string, fallback: number, max: number) => {
	const value = Number(option(name, String(fallback)));
	if (!Number.isInteger(value) || value < 1 || value > max)
		throw new Error(`--${name} must be 1..${max}`);
	return value;
};
const mode = option("mode", "kernel");
const bundleMode = option("bundle", "development");
if (!["development", "production"].includes(bundleMode))
	throw new Error("--bundle must be development or production");
const base = option("base", "/");
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base))
	throw new Error("--base must be a safe slash-terminated path, e.g. /monaco-fixture/");
const gpu = option("gpu", "off") === "on";
if (!["kernel", "component", "full"].includes(mode))
	throw new Error("mode must be kernel/component/full");
const coldCount = numberOption("cold", 10, 10);
const keyCount = numberOption("keys", 100, 100);
const scrollCount = numberOption("frames", 180, 600);
const selected = option("cases", "all").split(",");
const cases =
	selected[0] === "all"
		? matrix.filter((item) => !item.stress)
		: matrix.filter((item) => selected.includes(item.id));
if (!cases.length || (selected[0] !== "all" && cases.length !== selected.length))
	throw new Error(`Unknown case; use ${matrix.map((item) => item.id).join(",")}`);
const reportDir = join(
	root,
	".narrafork",
	`monaco-perf-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(reportDir, { recursive: true });
const reports: unknown[] = [];
const failures: string[] = [];
let browser: Browser | undefined;
let server: ViteDevServer | undefined;
let screenshotCount = 0;
let performanceFailures = 0;
let aborted = false;
const fullProtocol = createFullProtocolFixture(base, keyCount);
let productionBundle: Awaited<ReturnType<typeof buildFixtureBundle>> | undefined;
const goals = {
	readyP95Ms: 2000,
	inputP95Ms: 50,
	scrollP95Ms: 25,
	interactionLongTasksOver100: 0,
	heapDeltaBytes: 512 * MiB,
	firstColorMs: 1000,
	randomColorMs: 2000,
};
const p95 = (values: number[]) =>
	values.length
		? ([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? null)
		: null;
const readOptional = (path: string) => {
	try {
		return readFileSync(path, "utf8").slice(0, 4096).trim();
	} catch {
		return null;
	}
};
const hardware = {
	platform: os.platform(),
	arch: os.arch(),
	cpuModel: os.cpus()[0]?.model,
	logicalCPUs: os.cpus().length,
	availableParallelism: os.availableParallelism(),
	cpuAffinity:
		readOptional("/proc/self/status")?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null,
	memoryLimit: "No per-run 16GiB limit; physical/cgroup memory reported separately",
	totalMemoryBytes: os.totalmem(),
	freeMemoryBytes: os.freemem(),
	loadAverage: os.loadavg(),
	cgroupCPU: readOptional("/sys/fs/cgroup/cpu.max"),
	cgroupMemory: readOptional("/sys/fs/cgroup/memory.max"),
	bun: Bun.version,
	monaco: JSON.parse(readFileSync(join(root, "node_modules/monaco-editor/package.json"), "utf8"))
		.version,
};
const writeBounded = async (name: string, value: unknown) => {
	const json = JSON.stringify(value, null, 2);
	if (Buffer.byteLength(json) > 8 * MiB) throw new Error(`Report ${name} exceeds 8MiB hard bound`);
	await writeFile(join(reportDir, name), json);
};
const cleanup = async () => {
	await browser?.close().catch(() => {});
	await server?.close().catch(() => {});
};
const deadline = setTimeout(() => {
	aborted = true;
	failures.push("Global 40-minute deadline");
	void writeBounded("timeout.json", { failures, completed: reports.length }).finally(cleanup);
}, 40 * 60_000);
process.once("SIGINT", () => {
	aborted = true;
	void cleanup();
});
process.once("SIGTERM", () => {
	aborted = true;
	void cleanup();
});
async function heap(cdp: CDPSession) {
	const result = await cdp.send("Runtime.getHeapUsage");
	return result.usedSize + (result.backingStorageSize ?? 0);
}
async function keyboard(page: Page) {
	await page.evaluate(() => window.__monacoBench.beginInput());
	for (let index = 0; index < keyCount; index++) {
		await page.keyboard.press("x");
		await page.waitForFunction(
			(count) => window.__monacoBench.inputCount() >= count,
			{ timeout: 5000, polling: "raf" },
			index + 1,
		);
	}
	return page.evaluate(() => window.__monacoBench.endInput());
}
async function fullChecks(page: Page) {
	const searchStart = await page.evaluate(() => performance.now());
	await page.waitForSelector('input[name="search"]');
	await page.click('input[name="search"]');
	await page.type('input[name="search"]', "SEARCH_TARGET");
	let search = false;
	try {
		await page.waitForFunction(
			() => /[1-9][0-9]*[+]? matches/.test(window.__monacoBench.fullState()?.searchText ?? ""),
			{ timeout: 5000 },
		);
		search = true;
	} catch {
		/* preserve failed search evidence */
	}
	const searchMs = await page.evaluate((start) => performance.now() - start, searchStart);
	const searchState = await page.evaluate(() => window.__monacoBench.fullState());
	const searchDiagnostics = await page.evaluate(() => window.__monacoBench.fullDiagnostics());
	await page.keyboard.press("Enter");
	let navigation = false;
	try {
		await page.waitForFunction(
			() => window.__monacoBench.fullState()?.selectedText === "SEARCH_TARGET",
			{ timeout: 3000 },
		);
		navigation = true;
	} catch {
		/* navigation is distinct from the search result */
	}
	await page.click('input[name="search"]');
	const cancelStart = await page.evaluate(() => performance.now());
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => !window.__monacoBench.fullState()?.searchVisible, {
		timeout: 5000,
	});
	const closeMs = await page.evaluate((start) => performance.now() - start, cancelStart);
	await page.evaluate(() => window.__monacoBench.prepareFullSave());
	const saveRevision = await page.evaluate(() => window.__monacoBench.fullState()?.revision);
	const saveStart = await page.evaluate(() => performance.now());
	await page.evaluate(() => window.__monacoBench.saveFull());
	const saveInput = await keyboard(page);
	let saved = false;
	try {
		await page.waitForFunction(
			async () => {
				const data = await fetch("/bench/state").then((response) => response.json());
				return data.commits > 0;
			},
			{ timeout: 30_000, polling: 100 },
		);
		saved = true;
	} catch {
		/* retain save errors as evidence */
	}
	const saveMs = await page.evaluate((start) => performance.now() - start, saveStart);
	const protocol = await page.evaluate(() =>
		fetch("/bench/state").then((response) => response.json()),
	);
	const preview = await page.evaluate(() => window.__monacoBench.previewFull());
	const state = await page.evaluate(() => window.__monacoBench.fullState());
	return {
		search,
		searchMs,
		navigation,
		searchState,
		searchDiagnostics,
		closeMs,
		saved,
		saveMs,
		saveInput,
		saveInputP95: p95(saveInput.samples),
		snapshotRevisionPreserved: protocol.savedRevision === saveRevision && !!state?.dirty,
		protocol,
		preview,
		state,
		scope:
			"Real FileEditorContent + transport decoder + Worker search/snapshot; isolated protocol stub, not production IO/ACL",
		cancellationScope:
			"Escape closes search UI; pathological in-flight cancellation still requires separate coverage",
	};
}
async function sample(spec: FixtureSpec, iteration: number, origin: string) {
	if (!browser || aborted) throw new Error("Browser unavailable/aborted");
	const context = await browser.createBrowserContext();
	if (spec.longLine)
		await context.overridePermissions(origin, ["clipboard-read", "clipboard-write"]);
	const page = await context.newPage();
	page.setDefaultTimeout(30_000);
	page.setDefaultNavigationTimeout(60_000);
	await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
	await page.setCacheEnabled(false);
	// Never pause requests: interception can perturb worker boot/ACK timing.
	await page.setRequestInterception(false);
	let requestsObserved = 0;
	const unexpectedRequests: string[] = [];
	page.on("request", (request) => {
		requestsObserved++;
		const url = request.url();
		if (
			!url.startsWith("blob:") &&
			!url.startsWith("data:") &&
			new URL(url).origin !== origin &&
			unexpectedRequests.length < 20
		)
			unexpectedRequests.push(url.slice(0, 500));
	});
	const cdp = await page.createCDPSession();
	const errors: string[] = [];
	page.on("pageerror", (error) => {
		if (errors.length < 20) errors.push(String(error).slice(0, 1000));
	});
	page.on("console", (message) => {
		if (message.type() === "error" && errors.length < 20)
			errors.push(message.text().slice(0, 1000));
	});
	const heapSamples: number[] = [];
	const traceEvents: Record<string, unknown>[] = [];
	let traceDropped = 0;
	let tracing = false;
	cdp.on("Tracing.dataCollected", ({ value }) => {
		for (const event of value) {
			if (traceEvents.length >= 16_000) {
				traceDropped++;
				continue;
			}
			traceEvents.push({
				name: event.name,
				cat: event.cat,
				ph: event.ph,
				ts: event.ts,
				dur: event.dur,
				pid: event.pid,
				tid: event.tid,
			});
		}
	});
	const workerSessions = new Map<import("puppeteer-core").Target, CDPSession>();
	let workerTargetsSeen = 0;
	const attachWorker = async (target: import("puppeteer-core").Target) => {
		if (
			!["other", "service_worker", "shared_worker"].includes(target.type()) ||
			!/worker/i.test(target.url())
		)
			return;
		try {
			const session = await target.createCDPSession();
			workerSessions.set(target, session);
			workerTargetsSeen++;
		} catch {
			/* worker may already have exited */
		}
	};
	browser.on("targetcreated", attachWorker);
	const totalHeap = async () => {
		const main = await heap(cdp);
		const workers = await Promise.all(
			[...workerSessions.values()].map((session) => heap(session).catch(() => 0)),
		);
		return main + workers.reduce((sum, value) => sum + value, 0);
	};
	let sampling = false;
	const sampler = setInterval(() => {
		if (sampling || heapSamples.length >= 600) return;
		sampling = true;
		void totalHeap()
			.then((value) => heapSamples.push(value))
			.catch(() => {})
			.finally(() => {
				sampling = false;
			});
	}, 100);
	try {
		await page.goto(`${origin}${base}`, { waitUntil: "load" });
		await page.waitForFunction(() => !!window.__monacoBench);
		await cdp.send("HeapProfiler.collectGarbage");
		const heapBaseline = await heap(cdp);
		const opened = await page.evaluate(
			(s, m, g) => window.__monacoBench.open(s, m, g),
			spec,
			mode,
			gpu,
		);
		const colors = await page.evaluate(() => window.__monacoBench.colors());
		if (iteration === 0) {
			await cdp.send("Tracing.start", {
				categories: "devtools.timeline,blink.user_timing",
				transferMode: "ReportEvents",
				bufferUsageReportingInterval: 250,
			});
			tracing = true;
		}
		const input = await keyboard(page);
		const scroll = await page.evaluate((count) => window.__monacoBench.scroll(count), scrollCount);
		if (tracing) {
			const stopped = new Promise<void>((resolve) =>
				cdp.once("Tracing.tracingComplete", () => resolve()),
			);
			await cdp.send("Tracing.end");
			await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
			tracing = false;
			await writeBounded(`${spec.id}-${iteration}-trace.json`, {
				traceEvents,
				traceDropped,
				scope: "Input and scroll only, first cold sample; args omitted for bounded evidence",
			});
		}
		const functions = await page.evaluate(() => window.__monacoBench.functions());
		await page.keyboard.down("Control");
		await page.keyboard.press("f");
		await page.keyboard.up("Control");
		// CDP composition exercises browser composition events and actual model text,
		// not a synthetic React handler. OS candidate-window usability remains manual.
		await page.evaluate(() => window.__monacoBench.beginInput());
		const imeBefore = await page.evaluate(() => window.__monacoBench.imeState());
		await cdp.send("Input.imeSetComposition", {
			text: "中文输入",
			selectionStart: 4,
			selectionEnd: 4,
		});
		await cdp.send("Input.insertText", { text: "中文输入" });
		const imeAfter = await page.evaluate(() => window.__monacoBench.imeState());
		const ime = {
			pass: imeAfter.line.includes("中文输入") && imeAfter.revision > imeBefore.revision,
			beforeRevision: imeBefore.revision,
			afterRevision: imeAfter.revision,
			scope: "CDP composition; OS candidate UI not tested",
		};
		if (mode === "full" && iteration === 0) {
			traceEvents.length = 0;
			traceDropped = 0;
			await cdp.send("Tracing.start", {
				categories: "devtools.timeline,blink.user_timing",
				transferMode: "ReportEvents",
			});
			tracing = true;
		}
		const fullResult = mode === "full" ? await fullChecks(page) : null;
		if (tracing && mode === "full") {
			const stopped = new Promise<void>((resolve) =>
				cdp.once("Tracing.tracingComplete", () => resolve()),
			);
			await cdp.send("Tracing.end");
			await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
			tracing = false;
			await writeBounded(`${spec.id}-${iteration}-full-trace.json`, {
				traceEvents,
				traceDropped,
				scope: "Real search, snapshot/save, concurrent keyboard and preview; protocol fixture only",
			});
		}
		const heapSinglePeak = Math.max(heapBaseline, await totalHeap(), ...heapSamples);
		let threeFiles = null;
		if (spec.id === "typescript-20" && iteration === 0) {
			const openedThree = await page.evaluate(() => window.__monacoBench.threeFiles());
			const foregroundInput = await keyboard(page);
			threeFiles = {
				...openedThree,
				foregroundInput,
				inputP95: p95(foregroundInput.samples),
				heapBytes: await totalHeap(),
				scope: openedThree.scope,
			};
		}
		const stats = await page.evaluate(() => window.__monacoBench.stats());
		const gates = {
			ready: opened.readyMs <= goals.readyP95Ms && !opened.readOnly,
			firstColor: spec.longLine
				? null
				: !!opened.firstColor?.pass &&
					opened.readyMs + (opened.firstColor?.ms ?? 0) <= goals.firstColorMs,
			randomColor: spec.longLine
				? null
				: "middle" in colors &&
					!!colors.middle?.pass &&
					!!colors.tail?.pass &&
					colors.middle.ms <= goals.randomColorMs &&
					colors.tail.ms <= goals.randomColorMs,
			input:
				(p95(input.samples) ?? Infinity) <= goals.inputP95Ms &&
				input.insertedCharacters === keyCount,
			scroll: (p95(scroll.samples) ?? Infinity) <= goals.scrollP95Ms,
			longTasks: [...input.longTasks, ...scroll.longTasks].every((task) => task.duration <= 100),
			heap: heapSinglePeak - heapBaseline <= goals.heapDeltaBytes,
			functions:
				functions.editApplied &&
				functions.undo &&
				functions.redo &&
				functions.instancePreserved &&
				!functions.metadataContainsText &&
				ime.pass,
			longLineProtection:
				spec.longLine && mode !== "kernel"
					? !!functions.longLineProtection &&
						Object.values(functions.longLineProtection).every(Boolean)
					: null,
			searchShortcut:
				mode === "component"
					? stats.searchRequests > 0
					: mode === "full"
						? (fullResult?.navigation ?? false)
						: null,
			fullSearch: fullResult ? fullResult.search && fullResult.searchMs <= 1000 : null,
			fullSave: fullResult ? fullResult.saved : null,
			fullSaveSnapshot: fullResult ? fullResult.snapshotRevisionPreserved : null,
			fullSavedBytes: fullResult ? fullResult.protocol.exactScriptedBytes === true : null,
			fullSaveInput: fullResult
				? (fullResult.saveInputP95 ?? Infinity) <= 50 &&
					fullResult.saveInput.insertedCharacters === keyCount &&
					fullResult.saveInput.longTasks.every((task) => task.duration <= 100)
				: null,
			fullPreview: fullResult?.preview?.supported
				? !!fullResult.preview.modelPreserved && !!fullResult.preview.revisionPreserved
				: null,
			threeFilesForeground: threeFiles
				? (threeFiles.inputP95 ?? Infinity) <= 50 &&
					threeFiles.foregroundInput.insertedCharacters === keyCount &&
					threeFiles.foregroundInput.longTasks.every((task) => task.duration <= 100)
				: null,
			errors: errors.length === 0,
			isolatedNetwork: unexpectedRequests.length === 0,
		};
		if (Object.values(gates).some((pass) => pass === false)) performanceFailures++;
		const result = {
			id: spec.id,
			iteration,
			mode,
			spec,
			opened,
			colors,
			input,
			scroll,
			functions,
			ime,
			threeFiles,
			fullResult,
			heapBaseline,
			heapSinglePeak,
			heapDelta: heapSinglePeak - heapBaseline,
			heapSamples: heapSamples.slice(),
			workerTargetsSeen,
			requestsObserved,
			unexpectedRequests,
			workerURLs: [...workerSessions.keys()].map((target) => target.url().replace(origin, "")),
			stats,
			errors,
			gates,
			p95: { input: p95(input.samples), scroll: p95(scroll.samples) },
		};
		if (
			screenshotCount < 4 &&
			(iteration === 0 || Object.values(gates).some((pass) => pass === false))
		) {
			screenshotCount++;
			await page.screenshot({ path: join(reportDir, `${screenshotCount}-${spec.id}.png`) });
		}
		await writeBounded(`${spec.id}-${iteration}.json`, result);
		console.log(
			JSON.stringify({
				id: spec.id,
				iteration,
				readyMs: Math.round(opened.readyMs),
				inputP95: result.p95.input,
				scrollP95: result.p95.scroll,
				heapMiB: Math.round(result.heapDelta / MiB),
				failed: Object.entries(gates)
					.filter(([, pass]) => pass === false)
					.map(([name]) => name),
			}),
		);
		await page.evaluate(() => window.__monacoBench.dispose());
		return result;
	} finally {
		clearInterval(sampler);
		browser?.off("targetcreated", attachWorker);
		if (tracing) await cdp.send("Tracing.end").catch(() => {});
		await context.close();
	}
}
try {
	if (bundleMode === "production") {
		productionBundle = await buildFixtureBundle(root, reportDir, base);
		await writeBounded("bundle.json", productionBundle.metadata);
	}
	server = await createServer({
		configFile: false,
		root,
		base,
		logLevel: "error",
		clearScreen: false,
		cacheDir: join(reportDir, "vite-cache"),
		server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, fs: { allow: [root] } },
		resolve: {
			alias: {
				"@frontend": join(root, "frontend"),
				"@server": join(root, "server"),
				"@shared": join(root, "shared"),
			},
		},
		esbuild: { jsx: "automatic" },
		optimizeDeps: {
			noDiscovery: true,
			include: productionBundle
				? []
				: [
						"react",
						"react-dom/client",
						"react/jsx-runtime",
						"react/jsx-dev-runtime",
						"@mantine/core",
						"@mantine/hooks",
						"@tabler/icons-react",
						"react-i18next",
						"i18next",
						"lang-map",
					],
		},
		plugins: [
			{
				name: "isolated-monaco-benchmark",
				resolveId(id) {
					if (
						id.endsWith("/file-editor/MonacoEditor") &&
						!existsSync(join(root, "frontend/components/narrator/file-editor/MonacoEditor.tsx"))
					)
						return "\0monaco-not-ready";
				},
				load(id) {
					if (id === "\0monaco-not-ready")
						return 'export function MonacoEditor(){ throw new Error("MonacoEditor not ready") }';
				},
				configureServer(vite) {
					vite.middlewares.use((request, response, next) => {
						const url = new URL(request.url ?? "/", "http://127.0.0.1");
						const path =
							base !== "/" && url.pathname.startsWith(base)
								? `/${url.pathname.slice(base.length)}`
								: url.pathname;
						if (path.startsWith("/api/") || path.startsWith("/bench/")) {
							void fullProtocol
								.handle(request, response)
								.then((handled) => {
									if (!handled) next();
								})
								.catch((error) => {
									response.statusCode = 500;
									response.end(JSON.stringify({ error: String(error).slice(0, 500) }));
								});
							return;
						}
						if (path === "/" || path === "/index.html") {
							response.setHeader("Content-Type", "text/html");
							response.setHeader(
								"Content-Security-Policy",
								"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'",
							);
							response.end(productionBundle?.html ?? fixtureHtml(base));
						} else if (path === "/favicon.ico") {
							response.statusCode = 204;
							response.end();
						} else if (path === "/fixture") {
							const spec = matrix.find((item) => item.id === url.searchParams.get("id"));
							if (!spec) {
								response.statusCode = 404;
								response.end();
								return;
							}
							response.setHeader("Content-Type", "application/json");
							response.setHeader("Cache-Control", "no-store");
							fullProtocol.reset(spec);
							const fixture = createFixture(spec);
							if (url.searchParams.get("metadata") === "1") fixture.content = "";
							response.end(JSON.stringify(fixture));
						} else if (productionBundle) {
							const asset =
								productionBundle.assets.get(url.pathname) ??
								productionBundle.assets.get(`${base}${path.slice(1)}`);
							if (!asset) {
								response.statusCode = 404;
								response.end("Unknown production fixture asset");
								return;
							}
							response.setHeader("Content-Type", asset.mime);
							response.setHeader("Content-Length", asset.bytes);
							response.setHeader("Cache-Control", "no-store");
							const stream = createReadStream(asset.path, { highWaterMark: 64 * 1024 });
							stream.on("error", () => {
								response.statusCode = 500;
								response.end("Fixture asset read failed");
							});
							response.on("close", () => stream.destroy());
							stream.pipe(response);
						} else next();
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("No loopback server address");
	const origin = `http://127.0.0.1:${address.port}`;
	browser = await puppeteer.launch({
		executablePath:
			process.env.PUPPETEER_EXECUTABLE_PATH ??
			"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome",
		headless: true,
		timeout: 30_000,
		protocolTimeout: 60_000,
		args: [
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--enable-precise-memory-info",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
		],
	});
	await writeBounded("environment.json", {
		hardware,
		bundleMode,
		base,
		bundle: productionBundle?.metadata,
		requestInterception: false,
		requestPolicy: "CSP self and passive request observation only",
		browser: await browser.version(),
		browserArgs: browser.process()?.spawnargs,
		browserPid: browser.process()?.pid,
		browserCpuAffinity:
			readOptional(`/proc/${browser.process()?.pid}/status`)?.match(
				/^Cpus_allowed_list:\s*(.+)$/m,
			)?.[1] ?? null,
		requestedCases: cases.map((spec) => spec.id),
		viewport: { width: 1440, height: 1000, dpr: 1 },
		coldDefinition:
			"new browser context + cache disabled; shared Chrome process and Vite transforms; no CPU throttle",
		timerDefinition:
			"input keydown to second requestAnimationFrame; paint-opportunity upper bound, not compositor timestamp",
		heapDefinition:
			"CDP Runtime.getHeapUsage usedSize + backingStorageSize of page and discovered worker targets sampled at 100ms; not browser RSS; short peaks or undiscovered workers may be missed",
		goals,
		coldCount,
		gpu,
		keyCount,
		scrollCount,
		mode,
	});
	for (const spec of cases) {
		const samples: Awaited<ReturnType<typeof sample>>[] = [];
		for (let iteration = 0; iteration < coldCount; iteration++) {
			if (aborted) break;
			try {
				samples.push(await sample(spec, iteration, origin));
			} catch (error) {
				const message = `${spec.id}/${iteration}: ${String(error).slice(0, 2000)}`;
				failures.push(message);
				await writeBounded(`${spec.id}-${iteration}-error.json`, { message });
				console.error(message);
				break;
			}
		}
		const result = {
			id: spec.id,
			completed: samples.length,
			requested: coldCount,
			readyP95: p95(samples.map((item) => item.opened.readyMs)),
			inputP95: p95(samples.flatMap((item) => item.input.samples)),
			scrollP95: p95(samples.flatMap((item) => item.scroll.samples)),
			maximumHeapDelta: Math.max(0, ...samples.map((item) => item.heapDelta)),
			failingGates: [
				...new Set(
					samples.flatMap((item) =>
						Object.entries(item.gates)
							.filter(([, pass]) => pass === false)
							.map(([name]) => name),
					),
				),
			],
			sampleFiles: samples.map((item) => `${spec.id}-${item.iteration}.json`),
		};
		reports.push(result);
		await writeBounded("summary.json", {
			mode,
			bundleMode,
			base,
			hardware,
			goals,
			reports,
			failures,
			aborted,
			requestedCases: cases.map((spec) => spec.id),
			acceptance: "NOT full application acceptance",
			limitations: [
				productionBundle
					? "Standalone Vite production fixture bundle; full application/PWA packaging remains separate coverage"
					: "Independent Vite dev fixture; no production packaging evidence",
				mode === "full"
					? "Frontend transport, search, snapshot/save and preview use a bounded protocol stub; production filesystem IO, ACL, conflict, backend health/WS and pathological in-flight cancellation remain untested"
					: "Application transport/search/save/conflict/preview/backend health/WS and cancellation are not exercised",
				"3-file test: kernel uses models; component/full use three Monaco components (two hidden), not three application dock tabs",
				"OS IME candidate interaction requires manual test",
				`Process CPU affinity: ${hardware.cpuAffinity ?? "unavailable"}; no synthetic CPU throttle or per-run 16GiB memory limit`,
				"Cold contexts share a browser and Vite transform cache",
				...(coldCount < 10 ? ["Fewer than 10 cold samples: not acceptance"] : []),
				...(keyCount < 100 ? ["Fewer than 100 keyboard samples: not acceptance"] : []),
			],
		});
	}
} catch (error) {
	failures.push(String(error).slice(0, 2000));
	await writeBounded("fatal.json", { failures });
} finally {
	clearTimeout(deadline);
	await cleanup();
}
console.log(
	JSON.stringify({ reportDir, completedCases: reports.length, errors: failures.length, mode }),
);
if (failures.length || performanceFailures || aborted) process.exitCode = 1;
