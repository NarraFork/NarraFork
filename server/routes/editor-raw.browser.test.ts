import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import iconv from "iconv-lite";
import puppeteer from "puppeteer-core";
import type * as Fixture from "../../scripts/smoke-editor-raw-fixture";
import type {
	buildFixtureBundle,
	FixtureAsset,
} from "../../scripts/smoke-monaco-large-file-bundle";
import { EDITOR_IO_TIMEOUT_MS } from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import { EditorDocumentService } from "../services/editor-document-service";
import { LocalFileChangeRuntime } from "../services/file-change-runtime";
import { createEditorDocumentRoutes } from "./editor-documents";

const CHROME =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
type RawWindow = Window & {
	rawFixture: Pick<
		typeof Fixture,
		| "open"
		| "state"
		| "dualViews"
		| "fingerprint"
		| "reload"
		| "edit"
		| "undo"
		| "page"
		| "close"
		| "windowsControl"
		| "refresh"
		| "mixedStart"
		| "mixedAddRaw"
		| "mixedInspect"
		| "focusV1"
		| "saveV1"
		| "beginHiddenLoad"
		| "loadingViews"
	>;
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

test("Chrome146 production raw path: 20MiB, dual-view candidate swap, digests, edit race and >1M paging", async () => {
	expect(existsSync(CHROME)).toBe(true);
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "raw-browser-"));
	const project = resolve(import.meta.dir, "../..");
	const bundleRoot = await mkdtemp(join(project, ".tmp-narrafork-home.raw-browser-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const userId = generateId(),
		narratorId = generateId(),
		now = new Date().toISOString();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			ownerUserId: userId,
			cwd: workspace,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const runtime = new LocalFileChangeRuntime({ db, privateRoot: testEnvironment.narraforkHome });
	const makeService = () =>
		new EditorDocumentService({
			root: join(root, "transfers"),
			execute: (request) => runtime.executeEditor(request),
		});
	let service = makeService();
	const app = new Hono();
	app.use("*", async (context, next) => {
		context.set("user", { sub: userId, role: "user", iat: 1, exp: 9999999999 });
		await next();
	});
	app.route(
		"/api/narrators",
		createEditorDocumentRoutes(() => service),
	);
	const large = join(workspace, "large.ts"),
		paged = join(workspace, "paged.ts");
	const fd = await open(large, "w");
	try {
		const block = Buffer.alloc(65536, 65);
		for (let offset = 0; offset < 20 * 1024 * 1024; offset += block.length) await fd.write(block);
	} finally {
		await fd.close();
	}
	await writeFile(paged, "\n".repeat(1_000_001));
	let server: ReturnType<typeof Bun.serve> | undefined;
	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	let tamper = false,
		pause = false;
	const entered = deferred(),
		released = deferred();
	let slowBody:
		| { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
		| undefined;
	let slowClose:
		| { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
		| undefined;
	let documentCreates = 0,
		expiredProbes = 0,
		blockDisk = false;
	let peakRss = process.memoryUsage().rss;
	const sample = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 25);
	try {
		const html =
			'<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/smoke-editor-raw-fixture.tsx"></script></body></html>';
		const manifestPath = join(bundleRoot, "manifest.json");
		const built = await safeSpawn({
			cmd: [
				process.execPath,
				"--eval",
				`import { buildFixtureBundle } from ${JSON.stringify(join(project, "scripts/smoke-monaco-large-file-bundle.ts"))}; const bundle = await buildFixtureBundle(${JSON.stringify(project)}, ${JSON.stringify(bundleRoot)}, "/", ${JSON.stringify(html)}); const manifest = JSON.stringify({ ...bundle, assets: [...bundle.assets] }); if (Buffer.byteLength(manifest) > 1024 * 1024) throw new Error("Fixture manifest limit"); await Bun.write(${JSON.stringify(manifestPath)}, manifest);`,
			],
			cwd: project,
			timeout: 60000,
			maxOutputBytes: 65536,
		});
		if (built.exitCode) throw new Error(`Raw browser fixture build failed: ${built.stderr}`);
		const manifest = Bun.file(manifestPath);
		if (manifest.size > 1024 * 1024) throw new Error("Fixture manifest limit");
		const data = (await manifest.json()) as Omit<
			Awaited<ReturnType<typeof buildFixtureBundle>>,
			"assets"
		> & { assets: [string, FixtureAsset][] };
		const bundle = { ...data, assets: new Map(data.assets) };
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// Production uses 255s; Bun's default 10s cuts off legal raw preflights under CI load.
			// Keep this fixture bounded by the editor client's existing per-request deadline.
			idleTimeout: EDITOR_IO_TIMEOUT_MS / 1000,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/fixture-config") return Response.json({ narratorId });
				if (path.startsWith("/api/")) {
					if (request.method === "POST" && path.endsWith("/editor-documents")) documentCreates++;
					if (blockDisk && path.endsWith("/disk-state"))
						return Response.json({ error: "fixture paused probe" }, { status: 503 });
					if (slowBody && request.method === "POST" && /\/raw-reads\/[^/]+$/.test(path)) {
						const gate = slowBody;
						gate.entered.resolve();
						await gate.release.promise;
					}
					if (slowClose && request.method === "DELETE" && /\/raw-reads\/[^/]+$/.test(path)) {
						const gate = slowClose;
						gate.entered.resolve();
						await gate.release.promise;
					}
					if (pause && request.method === "POST" && /\/raw-reads\/[^/]+$/.test(path)) {
						pause = false;
						entered.resolve();
						await released.promise;
					}
					const response = await app.fetch(request);
					if (path.endsWith("/disk-state") && response.status === 410) expiredProbes++;
					if (
						tamper &&
						request.method === "POST" &&
						path.endsWith("/editor-documents") &&
						response.ok
					) {
						const metadata = await response.json();
						return Response.json({ ...metadata, textDigest: "0".repeat(64) });
					}
					return response;
				}
				if (path === "/")
					return new Response(bundle.html, { headers: { "Content-Type": "text/html" } });
				const asset = bundle.assets.get(path);
				return asset
					? new Response(Bun.file(asset.path), { headers: { "Content-Type": asset.mime } })
					: new Response("not found", { status: 404 });
			},
		});
		browser = await puppeteer.launch({
			executablePath: CHROME,
			headless: true,
			userDataDir: join(root, "chrome"),
			args: [
				"--no-sandbox",
				"--disable-dev-shm-usage",
				"--disable-background-networking",
				"--no-first-run",
			],
			timeout: 15000,
			protocolTimeout: 60000,
		});
		expect(await browser.version()).toContain("146.");
		const page = await browser.newPage();
		await page.setViewport({ width: 1200, height: 800 });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		const initial = await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.open(path),
			large,
		);
		expect(initial.session?.loaded).toBe(true);
		expect(initial.length).toBe(20 * 1024 * 1024);
		expect(initial.language).toBe("plaintext");
		expect(initial.languages).toEqual(["plaintext"]);
		expect(initial.codecs.workers).toBe(0);
		expect(initial.searchMirrors).toBe(0);
		expect(service.streams.diagnostics.active).toBe(0);
		const expectedHash = createHash("sha256");
		const block = Buffer.alloc(65536, 65);
		for (let at = 0; at < 20 * 1024 * 1024; at += block.length) expectedHash.update(block);
		expect(
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.fingerprint()),
		).toBe(expectedHash.digest("hex"));
		// Each view reauthorizes with a full-file preflight before sharing the model.
		// Give that I/O its existing request budget, separately from Monaco readiness.
		const viewCreateStatuses: number[] = [];
		const viewsAuthorized = page.waitForResponse(
			(response) => {
				if (
					response.request().method() !== "POST" ||
					new URL(response.url()).pathname !== `/api/narrators/${narratorId}/editor-documents`
				)
					return false;
				viewCreateStatuses.push(response.status());
				if (!response.ok()) throw new Error(`View authorization failed: ${response.status()}`);
				return viewCreateStatuses.length === 2;
			},
			{ timeout: EDITOR_IO_TIMEOUT_MS },
		);
		try {
			await Promise.all([
				viewsAuthorized,
				page.evaluate(() => (window as unknown as RawWindow).rawFixture.dualViews()),
			]);
			await page.waitForFunction(
				() => (window as unknown as RawWindow).rawFixture.state().views.views === 2,
				{ timeout: 15000 },
			);
		} catch (error) {
			console.error("raw-browser-dual-views", {
				viewCreateStatuses,
				source: service.streams.diagnostics,
				pageErrors: errors.slice(-5).map((message) => message.slice(0, 1000)),
			});
			throw error;
		}
		await writeFile(large, "\ufeffnew\r\n\ufeff😀\rbody\n");
		const next = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.reload());
		expect(next.length).toBe("new\n\ufeff😀\nbody\n".length);
		expect(next.disposal.every(Boolean)).toBe(true);
		const installedHash = next.session?.baseHash;
		await writeFile(large, "another valid\n");
		tamper = true;
		const rejected = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.reload(),
		);
		expect(rejected.session?.baseHash).toBe(installedHash);
		expect(rejected.length).toBe(next.length);
		expect(rejected.models).toBe(1);
		tamper = false;
		pause = true;
		const reload = page.evaluate(() => (window as unknown as RawWindow).rawFixture.reload());
		await entered.promise;
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.edit("DRAFT"));
		released.resolve();
		const raced = await reload;
		expect(raced.session?.baseHash).toBe(installedHash);
		expect(raced.length).toBe(next.length + 5);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.undo());
		expect(
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state().length),
		).toBe(next.length);
		await writeFile(large, "\n".repeat(1_000_001));
		const toPaged = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.reload());
		expect(toPaged.session?.paged).toBe(true);
		expect(toPaged.models).toBe(0);
		expect(toPaged.disposal.every(Boolean)).toBe(true);
		await page.waitForFunction(() => document.querySelectorAll("pre").length === 2, {
			timeout: 10000,
		});
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.dualViews(false));
		await page.waitForFunction(
			() =>
				document.querySelectorAll("pre").length === 0 &&
				(window as unknown as RawWindow).rawFixture.state().registry.visibleConsumers === 0,
			{ timeout: 5000 },
		);
		expect(service.streams.diagnostics.active).toBe(0);
		await writeFile(large, "small again\n");
		const fromPaged = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.reload(),
		);
		expect(fromPaged.session?.paged).toBe(false);
		expect(fromPaged.length).toBe("small again\n".length);
		expect(fromPaged.models).toBe(1);
		const bigLines = await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.open(path),
			paged,
		);
		expect(bigLines.session?.paged).toBe(true);
		expect(bigLines.models).toBe(0);
		expect(bigLines.length).toBe(0);
		const firstPage = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.page());
		expect(firstPage.text.length).toBe(2000);
		expect(firstPage.done).toBe(false);
		for (const [encoding, bom] of [
			["utf-8", true],
			["utf-16le", true],
			["utf-16be", true],
			["utf-16le", false],
			["utf-16be", false],
			["gbk", false],
			["gb18030", false],
		] as const) {
			const body =
				"A".repeat(encoding.startsWith("utf-16") ? (bom ? 32764 : 32765) : 65531) +
				(encoding === "gbk" ? "中\r\n字\r尾\n" : "😀\r\n\ufeff中\r尾\n");
			const encoded = iconv.encode((bom ? "\ufeff" : "") + body, encoding);
			const path = join(workspace, `${encoding}-${bom}.txt`);
			await writeFile(path, encoded);
			const loaded = await page.evaluate(
				({ path, hint }) => (window as unknown as RawWindow).rawFixture.open(path, hint),
				{ path, hint: encoding === "gbk" || encoding === "gb18030" ? encoding : undefined },
			);
			expect(loaded.session?.loaded).toBe(true);
			expect(loaded.session?.encoding).toBe(encoding);
			expect(
				await page.evaluate(() => (window as unknown as RawWindow).rawFixture.fingerprint()),
			).toBe(
				createHash("sha256")
					.update(body.replace(/\r\n|\r/g, "\n"))
					.digest("hex"),
			);
		}
		const threshold = join(workspace, "threshold.ts");
		await writeFile(threshold, "x\n".repeat(100000));
		const profiled = await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.open(path),
			threshold,
		);
		expect(profiled.language).toBe("plaintext");
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());

		// Configure Windows before the first Monaco import, then prove the control
		// really defaults to CRLF (Linux native Chrome with simulated platform only).
		const win = await browser.newPage();
		win.on("pageerror", (error) => errors.push(String(error)));
		await win.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, "userAgent", {
				configurable: true,
				get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/146.0.0.0",
			});
			Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Win32" });
		});
		await win.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle0" });
		await win.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		const control = await win.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.windowsControl(),
		);
		expect(control).toEqual({ eol: "\r\n", length: 4 });
		const windowsFile = join(workspace, "windows.txt");
		await writeFile(windowsFile, "\ufeffa\r\nb\n😀\r");
		const windowsLoaded = await win.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.open(path),
			windowsFile,
		);
		expect(windowsLoaded.session?.loaded).toBe(true);
		expect(windowsLoaded.eol).toBe("\n");
		expect(windowsLoaded.length).toBe("a\nb\n😀\n".length);
		await win.evaluate(() => (window as unknown as RawWindow).rawFixture.close());
		await win.close();

		// Real FilePanelContent + LargeFileGate + RecoveryBoundary on both protocols.
		const mixed = join(workspace, "mixed-protocol.txt"),
			originalMixed = "shared disk baseline\n";
		await writeFile(mixed, originalMixed);
		await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.mixedStart(path),
			mixed,
		);
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().views.views === 1,
		);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.edit("DRAFT"));
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.mixedAddRaw());
		await page.waitForFunction(() => {
			const state = (window as unknown as RawWindow).rawFixture.state();
			return state.views.views === 2 && state.models === 2;
		});
		const isolated = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.mixedInspect(),
		);
		expect(isolated.v1?.invalidated).not.toBe(true);
		expect(isolated.sharedModel).toBe(false);
		expect(isolated.v1Text).toContain("DRAFT");
		expect(isolated.rawText).toBe(originalMixed);
		expect(isolated.raw.protocol).toBe("raw-v2");
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.focusV1());
		await page.keyboard.type("MORE");
		const saved = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.saveV1());
		expect(saved?.phase).toBe("idle");
		expect(saved?.invalidated).not.toBe(true);
		expect(await readFile(mixed, "utf8")).toContain("MORE");
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());

		// Cold service restart -> real disk-state 410 -> single-descriptor renewal.
		await page.evaluate((path) => (window as unknown as RawWindow).rawFixture.open(path), paged);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.dualViews());
		await page.waitForFunction(() => document.querySelectorAll("pre").length === 2);
		const oldPaging = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.state(),
		);
		await page.$$eval("button", (buttons) =>
			(buttons.find((button) => button.textContent === "Next page") as HTMLButtonElement).click(),
		);
		await page.waitForFunction(() => document.body.textContent?.includes("2000 /"));
		await service.dispose();
		service = makeService();
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForFunction(
			(old) => {
				const state = (window as unknown as RawWindow).rawFixture.state();
				return (
					state.docId !== old &&
					state.pageDocId === state.docId &&
					document.querySelectorAll("pre").length === 2
				);
			},
			{},
			oldPaging.docId,
		);
		expect(expiredProbes).toBeGreaterThan(0);
		const renewed = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		expect(renewed.session?.baseHash).toBe(oldPaging.session?.baseHash);
		expect(renewed.models).toBe(0);
		await page.$$eval("button", (buttons) =>
			(buttons.find((button) => button.textContent === "Next page") as HTMLButtonElement).click(),
		);
		await page.waitForFunction(() => document.body.textContent?.includes("4000 /"));
		await page.$$eval("button", (buttons) =>
			(buttons.find((button) => button.textContent === "First page") as HTMLButtonElement).click(),
		);
		await page.waitForFunction(() => !document.body.textContent?.includes("4000 /"));
		// A changed source is not silently rebased by renewal.
		blockDisk = true;
		await service.dispose();
		service = makeService();
		await writeFile(paged, "x\n".repeat(1_000_001));
		const changedPage = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.refresh(),
		);
		expect(changedPage.session?.baseHash).toBe(oldPaging.session?.baseHash);
		await page.waitForFunction(() =>
			document.body.textContent?.includes("Reload before viewing another page"),
		);
		expect(await page.$$eval("pre", (nodes) => nodes.length)).toBe(0);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.reload());
		await page.waitForFunction(() => document.querySelectorAll("pre").length === 2);
		blockDisk = false;
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());

		const hidden = join(workspace, "hidden.txt");
		await writeFile(hidden, "A".repeat(1024 * 1024));
		const bodyGate = { entered: deferred(), release: deferred() };
		slowBody = bodyGate;
		await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.beginHiddenLoad(path),
			hidden,
		);
		await bodyGate.entered.promise;
		// The first body request does not prove both async panel leases have attached.
		// Establish a shared live candidate before testing that hiding one preserves it.
		await page.waitForFunction(() => {
			const state = (window as unknown as RawWindow).rawFixture.state();
			return (
				state.registry.visibleConsumers === 2 &&
				state.registry.workingCopies === 1 &&
				state.codecs.workers === 1
			);
		});
		await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.loadingViews(false, true),
		);
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().registry.visibleConsumers === 1,
		);
		// Stream/worker registration settles asynchronously around the body gate: CI
		// saw 0 (not registered yet) and 2 (prior stream not torn down yet) here.
		let activeStreams = -1;
		let codecWorkers = -1;
		for (let attempt = 0; attempt < 100 && (activeStreams !== 1 || codecWorkers !== 1); attempt++) {
			activeStreams = service.streams.diagnostics.active;
			codecWorkers = await page.evaluate(
				() => (window as unknown as RawWindow).rawFixture.state().codecs.workers,
			);
			if (activeStreams !== 1 || codecWorkers !== 1)
				await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(activeStreams).toBe(1);
		expect(codecWorkers).toBe(1);
		await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.loadingViews(false, false),
		);
		await page.waitForFunction(() => {
			const state = (window as unknown as RawWindow).rawFixture.state();
			return (
				state.registry.visibleConsumers === 0 &&
				state.codecs.workers === 0 &&
				state.models === 0 &&
				!state.registry.pinReasons.candidate
			);
		});
		let remainingStreams = -1;
		for (let attempt = 0; attempt < 100 && remainingStreams !== 0; attempt++) {
			remainingStreams = service.streams.diagnostics.active;
			if (remainingStreams !== 0) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(remainingStreams).toBe(0);
		bodyGate.release.resolve();
		slowBody = undefined;
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.loadingViews(true, true));
		await page.waitForFunction(() => {
			const state = (window as unknown as RawWindow).rawFixture.state();
			return state.models === 1 && state.views.views === 2;
		});
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());
		// Reveal while the cancelled stream's close ACK is deliberately still pending.
		const rapidBody = { entered: deferred(), release: deferred() },
			rapidClose = { entered: deferred(), release: deferred() };
		slowBody = rapidBody;
		slowClose = rapidClose;
		await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.beginHiddenLoad(path),
			hidden,
		);
		await rapidBody.entered.promise;
		// Both panels must finish acquiring before the hide. A panel still inside
		// readMode has no lease; hiding aborts that controller, and the later reveal
		// posts a new document. Monaco views stay at 0 until the held raw body
		// installs a model, so the signal is visible consumers, not view count.
		await page.waitForFunction(() => {
			const state = (window as unknown as RawWindow).rawFixture.state();
			return state.registry.workingCopies >= 1 && state.registry.visibleConsumers === 2;
		});
		await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.loadingViews(false, false),
		);
		await rapidClose.entered.promise;
		const beforeRetry = documentCreates;
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.loadingViews(true, true));
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().registry.visibleConsumers === 2,
		);
		expect(documentCreates).toBe(beforeRetry);
		rapidClose.release.resolve();
		slowClose = undefined;
		rapidBody.release.resolve();
		slowBody = undefined;
		await page.waitForFunction(() => {
			const state = (window as unknown as RawWindow).rawFixture.state();
			return state.models === 1 && state.views.views === 2 && state.codecs.workers === 0;
		});
		expect(documentCreates).toBeGreaterThan(beforeRetry);
		expect(service.streams.diagnostics.active).toBe(0);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());
		const final = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		expect(final.models).toBe(0);
		expect(final.codecs.workers).toBe(0);
		expect(final.views.views).toBe(0);
		expect(errors).toEqual([]);
		console.info(
			"raw-browser-acceptance",
			JSON.stringify({
				browser: await browser.version(),
				peakServerRss: peakRss,
				largeModelLoad: initial.modelLoad,
				largeBrowserHeap: initial.heap,
				browserHeap: final.heap,
				maxLongTaskMs: final.maxLongTaskMs,
				disposal: final.disposal,
				source: service.streams.diagnostics,
				workerCounters: await service.streams.workers.counters(),
			}),
		);
	} finally {
		released.resolve();
		slowBody?.release.resolve();
		slowClose?.release.resolve();
		clearInterval(sample);
		await browser?.close();
		server?.stop(true);
		await service.dispose();
		await rm(root, { recursive: true, force: true });
		await rm(bundleRoot, { recursive: true, force: true });
	}
}, 120000);
