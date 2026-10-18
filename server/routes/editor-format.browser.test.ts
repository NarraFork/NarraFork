import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import iconv from "iconv-lite";
import puppeteer from "puppeteer-core";
import type * as Fixture from "../../scripts/smoke-editor-raw-fixture";
import type {
	buildFixtureBundle,
	FixtureAsset,
} from "../../scripts/smoke-monaco-large-file-bundle";
import type { EditorRawEncoding } from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import {
	executeAtomicEditorFileChange,
	queryEditorOperation,
} from "../services/editor-document-runtime";
import {
	type EditorDocumentDependencies,
	EditorDocumentService,
} from "../services/editor-document-service";
import { createEditorDocumentRoutes } from "./editor-documents";
import { nativeEditorFixture } from "./editor-native-fixture";

const CHROME =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
type RawWindow = Window & { rawFixture: typeof Fixture };
test("Chrome146 raw encoder/Monaco format/undo/spool/chunk/save/recovery through production atomic helper", async () => {
	const project = resolve(import.meta.dir, "../.."),
		root = await mkdtemp(join(testEnvironment.isolatedHome, "format-browser-")),
		bundleRoot = await mkdtemp(join(project, ".tmp-narrafork-home.format-browser-")),
		workspace = join(root, "workspace");
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
	let writes = 0,
		commits = 0,
		unknown = false,
		lostChunk = false,
		chunkRetries = 0;
	let pause:
		| { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }
		| undefined;
	const native = await nativeEditorFixture(root, workspace);
	// Real verified precompiled helper; the HTTP identity is synthetic like the existing fixture.
	const execute: EditorDocumentDependencies["execute"] = async (request) => {
		const gate = pause;
		pause = undefined;
		if (gate) {
			gate.entered.resolve();
			await gate.released.promise;
		}
		const completed = await executeAtomicEditorFileChange(request);
		writes++;
		return completed;
	};
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute,
		rawWriter: {
			execute,
			queryOperation: queryEditorOperation,
		},
	});
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 1, exp: 9999999999 });
		await next();
	});
	app.route(
		"/api/narrators",
		createEditorDocumentRoutes(() => service),
	);
	let server: ReturnType<typeof Bun.serve> | undefined,
		browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	try {
		const manifestPath = join(bundleRoot, "manifest.json"),
			html =
				'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/smoke-editor-raw-fixture.tsx"></script></body></html>';
		const built = await safeSpawn({
			cmd: [
				process.execPath,
				"--eval",
				`import { buildFixtureBundle } from ${JSON.stringify(join(project, "scripts/smoke-monaco-large-file-bundle.ts"))}; const bundle = await buildFixtureBundle(${JSON.stringify(project)}, ${JSON.stringify(bundleRoot)}, "/", ${JSON.stringify(html)}); await Bun.write(${JSON.stringify(manifestPath)}, JSON.stringify({ ...bundle, assets: [...bundle.assets] }));`,
			],
			cwd: project,
			timeout: 60000,
			maxOutputBytes: 65536,
		});
		if (built.exitCode) throw new Error(`Format fixture build failed: ${built.stderr}`);
		const data = (await Bun.file(manifestPath).json()) as Omit<
				Awaited<ReturnType<typeof buildFixtureBundle>>,
				"assets"
			> & { assets: [string, FixtureAsset][] },
			assets = new Map(data.assets);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/fixture-config") return Response.json({ narratorId });
				if (path.startsWith("/api/")) {
					if (path.endsWith("/commit")) commits++;
					if (unknown && path.includes("/editor-operations/"))
						return Response.json({ operationId: path.split("/").at(-1), status: "uncertain" });
					const response = await app.fetch(request);
					if (request.method === "PUT" && path.includes("/chunks/") && lostChunk) {
						lostChunk = false;
						chunkRetries++;
						return Response.json({ error: "lost-reply" }, { status: 503 });
					}
					if (unknown && path.endsWith("/commit") && response.ok)
						return Response.json({ error: "lost-commit" }, { status: 503 });
					return response;
				}
				if (path === "/")
					return new Response(data.html, { headers: { "Content-Type": "text/html" } });
				const asset = assets.get(path);
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
		const page = await browser.newPage(),
			errors: string[] = [];
		page.on("dialog", (dialog) => {
			void dialog.accept();
		});
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.setViewport({ width: 1200, height: 800 });
		await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		async function call<K extends keyof typeof Fixture>(
			method: K,
			...args: Parameters<(typeof Fixture)[K]>
		) {
			return (await page.evaluate(
				({ method, args }) =>
					((window as unknown as RawWindow).rawFixture[method] as (...args: unknown[]) => unknown)(
						...args,
					),
				{ method, args },
			)) as Awaited<ReturnType<(typeof Fixture)[K]>>;
		}
		let formats = 0;
		for (const encoding of [
			"utf-8",
			"utf-16le",
			"utf-16be",
			"gbk",
			"gb18030",
		] as EditorRawEncoding[])
			for (const bom of encoding.startsWith("utf") ? [false, true] : [false])
				for (const ending of ["\n", "\r\n", "\r", "mixed"]) {
					const text = (
							encoding === "gbk" ? "a中文\r\nb\rc\nz\n" : "a中文🙂\r\nb\ufeff\rc\nz\n"
						).replace(/\r\n|\r|\n/g, (match) => (ending === "mixed" ? match : ending)),
						bytes = iconv.encode((bom ? "\ufeff" : "") + text, encoding),
						path = join(workspace, `format-${formats++}.txt`);
					await writeFile(path, bytes);
					const state = await call("open", path, encoding);
					expect(state.session?.loaded).toBe(true);
					const unchanged = await call("encodeRaw");
					expect(state.session?.codecSafe).toBe(true);
					expect(unchanged.data).toEqual([...bytes]);
					expect(unchanged.rawDigest).toBe(hash(bytes));
					await call("rawBatch", [
						{
							range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
							text: "Q",
						},
					]);
					const changed = await call("encodeRaw"),
						golden = iconv.encode(`${bom ? "\ufeff" : ""}Q${text.slice(1)}`, encoding);
					expect(changed.data).toEqual([...golden]);
					expect(changed.state.dirty).toBe(true);
					const undone = await call("undoAndEncode");
					expect(undone.data).toEqual([...bytes]);
					expect(undone.state.dirty).toBe(false);
					expect(undone.state.save.activeWorkers).toBe(0);
					await call("redo");
					await call("saveRaw");
					expect(await readFile(path)).toEqual(Buffer.from(golden));
				}
		const mixed = join(workspace, "mixed.txt"),
			original = Buffer.from("a\r\nb\rc\nz\n");
		await writeFile(mixed, original);
		await call("open", mixed);
		await call("dualViews");
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().views.views === 2,
		);
		await call("rawBatch", [
			{ range: { startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 1 }, text: "" },
		]);
		await call("rawBatch", [
			{ range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, text: "\n" },
		]);
		const equivalent = await call("verifyRaw");
		expect(equivalent.dirty).toBe(true);
		expect(equivalent.format).toEqual([1, 3, 1, 1]);
		await call("undoAndEncode");
		const originalAgain = await call("undoAndEncode");
		expect(originalAgain.data).toEqual([...original]);
		expect(originalAgain.state.dirty).toBe(false);
		await call("rawBatch", [
			{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: "X" },
			{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 }, text: "Y" },
		]);
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("X\r\nb\rY\nz\n")]);
		await call("undoAndEncode");
		await call("rawBatch", [
			{
				range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 },
				text: "branch",
			},
		]);
		const branch = await call("redo");
		expect(branch.format).toEqual([2, 3, 1, 1]);
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("a\r\nbranch\rc\nz\n")]);
		await call("dualViews", false);
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().views.views === 0,
		);
		await call("dualViews", true);
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().views.views === 2,
		);
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("a\r\nbranch\rc\nz\n")]);
		await call("budgetNextEdit");
		await call("rawBatch", [
			{
				range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
				text: "keep\n",
			},
		]);
		const protectedState = await call("state");
		expect(protectedState.session?.formatProtected).toBe(true);
		expect(protectedState.viewReadOnly).toEqual([true, true]);
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("keep\na\r\nbranch\rc\nz\n")]);
		const checkpointPath = join(workspace, "checkpoint.txt");
		await writeFile(checkpointPath, original);
		await call("open", checkpointPath);
		await call("edit", "draft\n");
		const checkpoint = await call("checkpointRaw");
		expect(checkpoint).toHaveLength(1);
		expect(checkpoint[0]?.protocol).toBe("raw-v2");
		const changedDisk = Buffer.from("disk changed\r\nfresh\n");
		await writeFile(checkpointPath, changedDisk);
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		await call("open", checkpointPath);
		await call("dualViews");
		await page.waitForSelector("[data-editor-draft-restore]:not([disabled])");
		await page.click("[data-editor-draft-restore]");
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().session?.restoredDraft === true,
		);
		const restored = await call("state");
		expect(restored.dirty).toBe(true);
		expect(restored.session?.restoredDraft).toBe(true);
		expect(restored.session?.restoredDiskChanged).toBe(true);
		expect(restored.session?.baseHash).toBe(hash(original));
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("draft\na\r\nb\rc\nz\n")]);
		const beforeLifetime = restored.lifetime;
		expect((await call("saveRaw")).session?.conflict).not.toBeNull();
		expect(await readFile(checkpointPath)).toEqual(changedDisk);
		await page.waitForFunction(() =>
			[...document.querySelectorAll("button")].some(
				(button) => button.textContent?.trim() === "Keep my version" && !button.disabled,
			),
		);
		await page.$$eval("button", (buttons) =>
			buttons
				.find((button) => button.textContent?.trim() === "Keep my version" && !button.disabled)
				?.click(),
		);
		await call("saveRaw");
		await writeFile(checkpointPath, Buffer.from("reload\r\nfile\n"));
		const replaced = await call("reload");
		expect(replaced.lifetime).not.toBe(beforeLifetime);
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("reload\r\nfile\n")]);
		await writeFile(mixed, original);
		await call("open", mixed);
		await call("edit", "A");
		const gate = { entered: deferred(), released: deferred() };
		pause = gate;
		const firstSave = call("saveRaw");
		await gate.entered.promise;
		await call("edit", "B");
		await call("saveRaw");
		gate.released.resolve();
		await firstSave;
		await page.waitForFunction(
			() =>
				!(window as unknown as RawWindow).rawFixture.state().dirty &&
				(window as unknown as RawWindow).rawFixture.state().session?.phase === "idle",
		);
		expect(await readFile(mixed)).toEqual(Buffer.from("BAa\r\nb\rc\nz\n"));
		await call("edit", "U");
		unknown = true;
		const beforeCommits = commits,
			unresolved = await call("saveRaw");
		expect(unresolved.session?.phase).toBe("unknown");
		await call("saveRaw");
		expect(commits).toBe(beforeCommits + 1);
		unknown = false;
		await call("reconcileRaw");
		expect((await call("state")).dirty).toBe(false);
		expect(commits).toBe(beforeCommits + 1);
		const outside = join(root, "outside.txt");
		await writeFile(outside, original);
		await call("open", outside);
		await call("edit", "confirm");
		const confirmation = await call("saveRaw");
		expect(confirmation.session?.confirmation).not.toBeNull();
		const encodingCount = confirmation.save.startedWorkers;
		await call("confirmRaw");
		expect((await call("state")).save.startedWorkers).toBe(encodingCount);
		expect(await readFile(outside)).toEqual(Buffer.from("confirma\r\nb\rc\nz\n"));
		const ramPath = join(workspace, "ram.txt");
		await writeFile(ramPath, original);
		await call("open", ramPath);
		await call("edit", "RAM");
		await page.evaluate(() => {
			Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
		});
		expect((await call("encodeRaw")).storage).toBe("memory");
		lostChunk = true;
		await call("saveRaw");
		expect(chunkRetries).toBe(1);
		expect(await readFile(ramPath)).toEqual(Buffer.from("RAMa\r\nb\rc\nz\n"));
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		const uniformPath = join(workspace, "uniform-checkpoint.txt");
		await writeFile(uniformPath, "x\r\nz\r\n");
		await call("open", uniformPath);
		await call("edit", "uniform\n");
		const uniformCheckpoint = await call("checkpointRaw");
		expect(uniformCheckpoint[0]?.format?.codec).toBe("eol-uniform-v1");
		expect(JSON.stringify(uniformCheckpoint[0]?.format).length).toBeLessThan(256);
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		await call("open", uniformPath);
		await call("dualViews");
		await page.waitForSelector("[data-editor-draft-restore]:not([disabled])");
		await page.click("[data-editor-draft-restore]");
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().session?.restoredDraft === true,
		);
		expect((await call("encodeRaw")).data).toEqual([...Buffer.from("uniform\r\nx\r\nz\r\n")]);
		await call("saveRaw");
		const quotaPath = join(workspace, "quota.txt"),
			quotaOriginal = Buffer.from(`${"A".repeat(400_000)}\r\nz\n`);
		await writeFile(quotaPath, quotaOriginal);
		await call("open", quotaPath);
		await call("edit", "quota");
		await page.evaluate(() => {
			const add = IDBObjectStore.prototype.add;
			IDBObjectStore.prototype.add = function (value, key) {
				if (this.name === "chunks" && Array.isArray(key) && key[1] === 1)
					throw new DOMException("fixture quota", "QuotaExceededError");
				return add.call(this, value, key);
			};
		});
		expect((await call("encodeRaw")).storage).toBe("memory");
		await call("saveRaw");
		expect(await readFile(quotaPath)).toEqual(Buffer.concat([Buffer.from("quota"), quotaOriginal]));
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		const fragmentedPath = join(workspace, "fragmented.txt"),
			fragmentedGolden = Buffer.from(`${"yx".repeat(10_000)}${"x".repeat(20_000)}`);
		await writeFile(fragmentedPath, "x".repeat(40_000));
		await call("open", fragmentedPath);
		const fragmentation = await call("fragmentedEdits");
		expect(fragmentation.appliedEdits).toBe(10_000);
		const fragmented = await call("encodeRaw", true);
		expect(fragmented.chunks).toBe(1);
		expect(fragmented.rawDigest).toBe(hash(fragmentedGolden));
		await call("saveRaw");
		expect(await readFile(fragmentedPath)).toEqual(fragmentedGolden);
		const gbkPath = join(workspace, "unrepresentable.txt"),
			gbkOriginal = iconv.encode("中文\r\n", "gbk");
		await writeFile(gbkPath, gbkOriginal);
		await call("open", gbkPath, "gbk");
		await call("edit", "🙂");
		const beforeInvalid = commits,
			invalid = await call("saveRaw");
		expect(invalid.session?.error).toContain("EDITOR_ENCODING_UNREPRESENTABLE");
		expect(invalid.dirty).toBe(true);
		expect(commits).toBe(beforeInvalid);
		expect(await readFile(gbkPath)).toEqual(Buffer.from(gbkOriginal));
		const badPath = join(workspace, "bad-sidecar.txt");
		await writeFile(badPath, original);
		await call("open", badPath);
		await call("edit", "draft\n");
		const badCheckpoint = await call("checkpointRaw");
		expect(badCheckpoint[0]?.format?.codec).toBe("eol-tags-v1");
		// Corrupt only after the original writer has gone, so unload flush cannot repair it.
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		await page.evaluate(async (path) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const open = indexedDB.open("narrafork-editor-drafts", 1);
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			const rows = await new Promise<{ generation: string; scope: { canonicalPath: string } }[]>(
				(resolve, reject) => {
					const request = db.transaction("metadata").objectStore("metadata").getAll();
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				},
			);
			const row = rows.find((row) => row.scope.canonicalPath === path);
			if (!row) throw new Error("Missing corrupt fixture draft");
			const tx = db.transaction("chunks", "readwrite");
			tx.objectStore("chunks").delete([row.generation, 1024]);
			await new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onabort = () => reject(tx.error);
			});
			db.close();
		}, badPath);
		await call("open", badPath);
		await call("dualViews");
		await page.waitForSelector("[data-editor-draft-restore]:not([disabled])");
		await page.click("[data-editor-draft-restore]");
		await page.waitForFunction(() => {
			const row = document.querySelector("[data-editor-local-draft]");
			return (
				row &&
				!row.querySelector("[data-editor-draft-restore]") &&
				!!row.querySelector("[data-editor-draft-export]")
			);
		});
		expect((await call("state")).dirty).toBe(false);
		const downloads = join(root, "downloads");
		await mkdir(downloads);
		const cdp = await page.createCDPSession();
		await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
		await page.click("[data-editor-local-draft] [data-editor-draft-export]");
		const exportedPath = join(downloads, "editor-recovered-draft.bin"),
			expectedExport = Uint8Array.from(Buffer.concat([Buffer.from("draft\n"), original])),
			exportDeadline = Date.now() + 5000;
		while (
			(!(await Bun.file(exportedPath).exists()) ||
				Bun.file(exportedPath).size !== expectedExport.length) &&
			Date.now() < exportDeadline
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(new Uint8Array(await Bun.file(exportedPath).arrayBuffer())).toEqual(expectedExport);
		await cdp.detach();
		const markerPath = join(workspace, "marker-failure.txt");
		await writeFile(markerPath, original);
		await call("open", markerPath);
		await call("edit", "marker");
		await call("checkpointRaw");
		await page.evaluate(() => {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (value, key) {
				if (
					this.name === "metadata" &&
					(value as { operation?: { status?: string } }).operation?.status === "query-first"
				)
					throw new DOMException("marker fixture failure", "QuotaExceededError");
				return put.call(this, value, key);
			};
		});
		unknown = true;
		const markerCommits = commits,
			markerUnknown = await call("saveRaw");
		expect(markerUnknown.session?.phase).toBe("unknown");
		expect(markerUnknown.session?.backupIncomplete).toBe(true);
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		await call("open", markerPath);
		await call("dualViews");
		await page.waitForSelector("[data-editor-draft-query]");
		expect(await page.$("[data-editor-draft-restore]")).toBeNull();
		await page.click("[data-editor-draft-query]");
		await page.waitForSelector('[data-editor-draft-receipt="uncertain"]');
		unknown = false;
		await page.click("[data-editor-draft-query]");
		await page.waitForSelector('[data-editor-draft-receipt="saved"]');
		expect(commits).toBe(markerCommits + 1);
		expect(await readFile(markerPath)).toEqual(Buffer.from("markera\r\nb\rc\nz\n"));
		const windowsPath = join(workspace, "two-windows.txt");
		await writeFile(windowsPath, original);
		await call("open", windowsPath);
		await call("edit", "A\n");
		const firstWindowDraft = await call("checkpointRaw");
		const second = await browser.newPage();
		await second.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "load" });
		await second.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture);
		const secondWindowDraft = await second.evaluate(async (path) => {
			const fixture = (window as unknown as RawWindow).rawFixture;
			await fixture.open(path);
			fixture.edit("B\n");
			return fixture.checkpointRaw();
		}, windowsPath);
		expect(firstWindowDraft[0]?.modelLifetime).not.toBe(secondWindowDraft[0]?.modelLifetime);
		expect(firstWindowDraft[0]?.revision).toBe(secondWindowDraft[0]?.revision);
		const readWindowDrafts = () =>
			second.evaluate(async (path) => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open("narrafork-editor-drafts", 1);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				const rows = await new Promise<
					{ writerId: string; modelLifetime: string; scope: { canonicalPath: string } }[]
				>((resolve, reject) => {
					const request = db.transaction("metadata").objectStore("metadata").getAll();
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				db.close();
				return rows
					.filter((row) => row.scope.canonicalPath === path)
					.map((row) => ({ writerId: row.writerId, modelLifetime: row.modelLifetime }));
			}, windowsPath);
		expect(new Set((await readWindowDrafts()).map((row) => row.writerId)).size).toBe(2);
		await call("saveRaw");
		const remainingWindowDrafts = await readWindowDrafts();
		expect(remainingWindowDrafts).toHaveLength(1);
		expect(remainingWindowDrafts[0]?.modelLifetime).toBe(secondWindowDraft[0]?.modelLifetime);
		const secondBytes = await second.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.encodeRaw(),
		);
		expect(secondBytes.data).toEqual([...Buffer.concat([Buffer.from("B\n"), original])]);
		expect(await readFile(windowsPath)).toEqual(Buffer.concat([Buffer.from("A\n"), original]));
		await second.close();
		const large = join(workspace, "twenty.txt"),
			largeBytes = Buffer.alloc(20 * 1024 * 1024, 65);
		await writeFile(large, largeBytes);
		await call("open", large);
		const twenty = await call("encodeRaw");
		expect(twenty.bytes).toBe(largeBytes.length);
		expect(twenty.chunks).toBe(80);
		expect(twenty.rawDigest).toBe(hash(largeBytes));
		expect(twenty.state.searchMirrors).toBe(0);
		await call("rawBatch", [
			{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: "B" },
		]);
		await call("saveRaw");
		largeBytes[0] = 66;
		expect(hash(await readFile(large))).toBe(hash(largeBytes));
		const beforeGrowth = commits;
		await call("rawBatch", [
			{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: "中" },
		]);
		const growth = await call("saveRaw");
		expect(growth.session?.error).toContain("EDITOR_RAW_LIMIT");
		expect(growth.dirty).toBe(true);
		expect(commits).toBe(beforeGrowth);
		expect(hash(await readFile(large))).toBe(hash(largeBytes));
		expect(errors).toEqual([]);
		const final = await call("state");
		expect(final.save.activeWorkers).toBe(0);
		expect(final.codecs.workers).toBe(0);
		console.info(
			"EDITOR_FORMAT_CHROME146",
			JSON.stringify({
				formats,
				writes,
				commits,
				chunkRetries,
				finalWorkers: final.save,
				heap: final.heap,
				streams: service.streams.diagnostics,
			}),
		);
		await call("close");
	} finally {
		pause?.released.resolve();
		await browser?.close();
		server?.stop(true);
		await service.dispose();
		await native.dispose();
		await rm(bundleRoot, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
}, 240_000);
