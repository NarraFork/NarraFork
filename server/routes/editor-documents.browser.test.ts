// Run alone: taskset -c 4-7 bun test server/routes/editor-documents.browser.test.ts
// Real browser -> standalone production bundle + real Hono routes/service -> durable disk IO.
// This is the editor fixture bundle, NOT the full application/PWA build.
// Identity injection is synthetic, like editor-documents.test.ts: NOT production JWT coverage.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer, { type Browser, type KeyInput } from "puppeteer-core";
import type {} from "../../scripts/smoke-editor-real-io-fixture";
import type {
	buildFixtureBundle,
	FixtureAsset,
} from "../../scripts/smoke-monaco-large-file-bundle";
import type { EditorCommitResult } from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { fileChangeOperations, narrators, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { EditorDocumentService } from "../services/editor-document-service";
import { LocalFileChangeRuntime } from "../services/file-change-runtime";
import { createEditorDocumentRoutes } from "./editor-documents";

const CHROME = "/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const MiB = 1024 * 1024;
const PREFIX = "/* REAL_IO_SNAPSHOT */";
const DURING_SAVE = "/* TYPED_DURING_SAVE */";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (bytes: Uint8Array) => ({ bytes: bytes.byteLength, sha256: sha256(bytes) });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function sourceBytes() {
	// Exactly 20 MiB minus 1 KiB; ~151k short lines, with UTF-8 away from ASCII boundaries.
	const header = Buffer.from('export const greeting = "中文🙂";\n');
	const footer = Buffer.from('\nexport const endMarker = "末尾🚀";\n');
	const line = Buffer.from(`// ${"bounded typescript fixture ".repeat(5)}\n`);
	const room = 20 * MiB - 1024 - header.length - footer.length;
	const repeated = Buffer.from(line.toString().repeat(Math.floor(room / line.length)));
	return Buffer.concat([
		header,
		repeated,
		Buffer.from(`//${" ".repeat((room % line.length) - 2)}`),
		footer,
	]);
}

if (!existsSync(CHROME))
	console.info("SKIP editor real IO browser test: specified Chromium missing");

test.skipIf(!existsSync(CHROME))(
	"production bundle Chromium saves immutable 20 MiB snapshots through real routes and durable human IO",
	async () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
		expect(testEnvironment.narraforkHome).not.toBe(testEnvironment.realNarraforkHome);
		const started = performance.now();
		const deadline = new AbortController();
		// 105s work budget leaves 15s for finally teardown within the 120s test limit.
		const timeout = setTimeout(
			() => deadline.abort(new Error("Real IO work budget: 105s")),
			105_000,
		);
		const stopSampling = new AbortController();
		const commitEntered = deferred();
		const releaseCommit = deferred();
		let root: string | undefined;
		let bundleRoot: string | undefined;
		let builder: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
		let builderStopped = true;
		let service: EditorDocumentService | undefined;
		let backend: ReturnType<typeof Bun.serve> | undefined;
		let browser: Browser | undefined;
		let sampler: Promise<void> | undefined;
		let duringCommit = false;
		let duringDurable = false;
		const health: { ms: number; duringCommit: boolean; duringDurable: boolean }[] = [];
		const diagnostics: string[] = [];
		const note = (text: string) => {
			if (diagnostics.length < 12) diagnostics.push(text.slice(0, 400));
		};
		const bounded = async <T>(promise: Promise<T>): Promise<T> => {
			deadline.signal.throwIfAborted();
			let abort!: () => void;
			try {
				return await Promise.race([
					promise,
					new Promise<never>((_, reject) => {
						abort = () => reject(deadline.signal.reason);
						deadline.signal.addEventListener("abort", abort, { once: true });
					}),
				]);
			} finally {
				deadline.signal.removeEventListener("abort", abort);
			}
		};
		try {
			await bounded(
				(async () => {
					root = await mkdtemp(join(testEnvironment.isolatedHome, "editor-browser-"));
					const workspace = join(root, "workspace");
					await mkdir(workspace);
					const path = join(workspace, "twenty-mib.ts");
					const outside = join(root, "outside.ts");
					const original = sourceBytes();
					const firstGolden = Buffer.concat([Buffer.from(PREFIX), original]);
					const finalGolden = Buffer.concat([Buffer.from(DURING_SAVE), firstGolden]);
					expect(original.length).toBe(20 * MiB - 1024);
					expect(finalGolden.length).toBeLessThan(20 * MiB);
					const originalText = original.toString("utf8");
					const lines = originalText.split("\n");
					expect(lines.length).toBeLessThanOrEqual(300_000);
					expect(lines.every((line) => line.length <= 160)).toBe(true);
					await writeFile(path, original);
					await writeFile(outside, "outside boundary sentinel\n");
					const userId = generateId();
					const intruderId = generateId();
					const narratorId = generateId();
					const now = new Date().toISOString();
					for (const id of [userId, intruderId])
						db.insert(users)
							.values({ id, username: id, passwordHash: "synthetic", role: "user", createdAt: now })
							.run();
					db.insert(narrators)
						.values({
							id: narratorId,
							cwd: workspace,
							ownerUserId: userId,
							visibility: "private",
							createdAt: now,
							updatedAt: now,
						})
						.run();
					const runtime = new LocalFileChangeRuntime({
						db,
						privateRoot: testEnvironment.narraforkHome,
					});
					const documents = new EditorDocumentService({
						root: join(root, "transfers"),
						execute: (request) => runtime.executeEditor(request),
					});
					service = documents;
					const app = new Hono();
					app.use("*", async (c, next) => {
						c.set("user", {
							sub: c.req.header("x-fixture-user") === intruderId ? intruderId : userId,
							role: "user",
							iat: 1,
							exp: 9999999999,
						});
						await next();
					});
					let commits = 0;
					app.use("/api/narrators/*", async (c, next) => {
						if (c.req.method === "POST" && c.req.path.endsWith("/commit")) {
							commits++;
							duringCommit = true;
							if (commits === 1) {
								// Timing barrier ONLY: the sealed upload, route, service and runtime stay real.
								commitEntered.resolve();
								await bounded(releaseCommit.promise);
							}
							duringDurable = true;
							try {
								await next();
							} finally {
								duringDurable = false;
								duringCommit = false;
							}
						} else await next();
					});
					app.get("/api/fixture/config", (c) => c.json({ path, narratorId }));
					app.get("/api/health", (c) => c.json({ ok: true, fixture: narratorId }));
					app.route(
						"/api/narrators",
						createEditorDocumentRoutes(() => documents),
					);
					app.onError((error, c) =>
						c.json(
							{ error: error.message, code: error instanceof AppError ? error.code : "ERROR" },
							error instanceof AppError ? (error.statusCode as 400) : 500,
						),
					);
					const project = resolve(import.meta.dir, "../..");
					// Keep the HTML entry INSIDE Vite root: an entry in preload's /tmp HOME would
					// emit ../ paths. This unique, gitignored directory belongs only to this test.
					bundleRoot = await mkdtemp(join(project, ".tmp-narrafork-home.editor-browser-bundle-"));
					const manifestPath = join(bundleRoot, "manifest.json");
					const htmlEntry =
						'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Isolated real IO</title><link rel="icon" href="data:,"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/scripts/smoke-editor-real-io-fixture.tsx"></script></body></html>';
					deadline.signal.throwIfAborted();
					// A subprocess makes the production build cancellable. Promise.race around
					// in-process Vite would keep writing after the deadline/finally cleanup.
					builder = Bun.spawn(
						[
							process.execPath,
							"--eval",
							`import { buildFixtureBundle } from ${JSON.stringify(join(project, "scripts/smoke-monaco-large-file-bundle.ts"))};
const bundle = await buildFixtureBundle(${JSON.stringify(project)}, ${JSON.stringify(bundleRoot)}, "/", ${JSON.stringify(htmlEntry)});
const manifest = JSON.stringify({ ...bundle, assets: [...bundle.assets] });
if (Buffer.byteLength(manifest) > 1024 * 1024) throw new Error("Fixture manifest exceeded 1 MiB");
await Bun.write(${JSON.stringify(manifestPath)}, manifest);`,
						],
						{
							cwd: project,
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
							signal: deadline.signal,
							timeout: 60_000,
							killSignal: "SIGKILL",
							maxBuffer: 64 * 1024,
						},
					);
					builderStopped = false;
					const [exitCode, stdout, stderr] = await bounded(
						Promise.all([
							builder.exited.then((code) => {
								builderStopped = true;
								return code;
							}),
							new Response(builder.stdout).text(),
							new Response(builder.stderr).text(),
						]),
					);
					if (exitCode !== 0)
						throw new Error(`Fixture production build failed (${exitCode}): ${stderr || stdout}`);
					deadline.signal.throwIfAborted();
					const manifest = Bun.file(manifestPath);
					if (manifest.size > MiB) throw new Error("Fixture manifest exceeded 1 MiB");
					const bundle: Omit<Awaited<ReturnType<typeof buildFixtureBundle>>, "assets"> & {
						assets: [string, FixtureAsset][];
					} = await manifest.json();
					deadline.signal.throwIfAborted();
					const assets = new Map(bundle.assets);
					backend = Bun.serve({
						hostname: "127.0.0.1",
						port: 0,
						maxRequestBodySize: 24 * MiB,
						fetch(request) {
							const { pathname } = new URL(request.url);
							if (pathname === "/api" || pathname.startsWith("/api/")) return app.fetch(request);
							if (request.method !== "GET" && request.method !== "HEAD")
								return new Response("Method not allowed", { status: 405 });
							if (pathname === "/")
								return new Response(request.method === "HEAD" ? null : bundle.html, {
									headers: {
										"Content-Type": "text/html; charset=utf-8",
										"Content-Security-Policy":
											"default-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'",
									},
								});
							// Exact build-manifest allowlist: never resolve request paths against disk,
							// expose sources/HOME, or fall back to a Vite dev server / SPA entry.
							const asset = assets.get(pathname);
							if (!asset) return new Response("Not found", { status: 404 });
							return new Response(request.method === "HEAD" ? null : Bun.file(asset.path), {
								headers: {
									"Content-Type": asset.mime,
									"Content-Length": String(asset.bytes),
									"X-Content-Type-Options": "nosniff",
								},
							});
						},
					});
					const backendOrigin = `http://127.0.0.1:${backend.port}`;
					const origin = backendOrigin;
					browser = await bounded(
						puppeteer.launch({
							executablePath: CHROME,
							userDataDir: join(root, "chrome-profile"),
							headless: true,
							dumpio: false,
							timeout: 15_000,
							protocolTimeout: 15_000,
							args: [
								"--no-sandbox",
								"--disable-dev-shm-usage",
								"--disable-gpu",
								"--disable-background-networking",
								"--disable-component-update",
								"--no-first-run",
							],
						}),
					);
					const page = await browser.newPage();
					page.setDefaultTimeout(20_000);
					await page.setViewport({ width: 1280, height: 800 });
					let requestCount = 0;
					let offOriginCount = 0;
					let workerCount = 0;
					let contentResponses = 0;
					let httpErrors = 0;
					page.on("pageerror", (error) => note(String(error)));
					page.on("console", (message) => {
						// Network errors are counted separately, including exactly two intentional refusals.
						if (
							message.type() === "error" &&
							!message.text().startsWith("Failed to load resource:")
						)
							note(message.text());
					});
					// Passive observation only. Request interception can deadlock module Workers.
					page.on("request", (request) => {
						requestCount++;
						if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin)
							offOriginCount++;
					});
					page.on("workercreated", () => {
						workerCount++;
					});
					page.on("response", (response) => {
						if (response.status() >= 400) httpErrors++;
						if (response.url().includes("/content?version=") && response.status() === 200)
							contentResponses++;
					});
					sampler = (async () => {
						while (!stopSampling.signal.aborted && health.length < 2400) {
							const sampleStarted = performance.now();
							const overlap = duringCommit;
							const durableOverlap = duringDurable;
							const response = await fetch(`${backendOrigin}/api/health`, {
								signal: AbortSignal.any([
									stopSampling.signal,
									deadline.signal,
									AbortSignal.timeout(2000),
								]),
							});
							try {
								if (response.status !== 200) throw new Error(`Health HTTP ${response.status}`);
								const body = await response.json();
								if (body.fixture !== narratorId || body.ok !== true)
									throw new Error("Wrong backend");
							} finally {
								await response.body?.cancel().catch(() => {});
							}
							health.push({
								ms: performance.now() - sampleStarted,
								duringCommit: overlap,
								duringDurable: durableOverlap,
							});
							await delay(50, undefined, { signal: stopSampling.signal });
						}
					})().catch((error) => {
						if (!stopSampling.signal.aborted) {
							note(`health: ${String(error)}`);
							deadline.abort(error);
						}
					});
					await bounded(page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 }));
					await bounded(page.waitForFunction(() => window.__editorRealIo?.state().ready));
					const initial = await page.evaluate(() => window.__editorRealIo.state());
					expect(initial.dirty).toBe(false);
					expect(initial.length).toBe(originalText.length);
					expect(initial.lines).toBe(lines.length);
					expect(await page.evaluate(() => window.__editorRealIo.fingerprint())).toEqual(
						fingerprint(original),
					);
					const refusals = await page.evaluate(
						async ({ narratorId, intruderId, path, outside }) => {
							const post = async (target: string, user?: string) => {
								const response = await fetch(`/api/narrators/${narratorId}/editor-documents`, {
									method: "POST",
									headers: {
										"content-type": "application/json",
										...(user ? { "x-fixture-user": user } : {}),
									},
									body: JSON.stringify({ path: target, origin: "reference", deviceId: "local" }),
									signal: AbortSignal.timeout(5000),
								});
								await response.arrayBuffer();
								return response.status;
							};
							return { acl: await post(path, intruderId), boundary: await post(outside) };
						},
						{ narratorId, intruderId, path, outside },
					);
					expect(refusals).toEqual({ acl: 404, boundary: 403 });
					const ctrl = async (key: KeyInput) => {
						await page.keyboard.down("Control");
						try {
							await page.keyboard.press(key);
						} finally {
							await page.keyboard.up("Control");
						}
					};
					await page.evaluate(() => window.__editorRealIo.focus());
					await ctrl("Home");
					await page.keyboard.type(PREFIX);
					await page.waitForFunction(() => window.__editorRealIo.state().dirty);
					const firstRevision = await page.evaluate(() => window.__editorRealIo.state().revision);
					const readCommitResponse = async (index: number) => {
						await bounded(
							page.waitForFunction(
								(index) => {
									const response = window.__editorRealIo.commitResponse(index);
									return response && (response.body !== null || response.error !== null);
								},
								{ timeout: 20_000 },
								index,
							),
						);
						const response = await page.evaluate(
							(index) => window.__editorRealIo.commitResponse(index),
							index,
						);
						if (!response || response.error || response.body === null)
							throw new Error(response?.error ?? "Missing browser commit receipt");
						return { status: response.status, body: response.body };
					};
					await ctrl("s");
					await bounded(commitEntered.promise);
					await ctrl("Home");
					await page.keyboard.type(DURING_SAVE);
					const during = await page.evaluate(() => window.__editorRealIo.state());
					expect(during.revision).toBeGreaterThan(firstRevision);
					expect(during.firstLine.startsWith(DURING_SAVE + PREFIX)).toBe(true);
					expect(during.dirty).toBe(true);
					expect((await readFile(path)).equals(original)).toBe(true);
					releaseCommit.resolve();
					const firstResponse = await readCommitResponse(0);
					expect(firstResponse.status).toBe(200);
					const firstReceipt: EditorCommitResult = JSON.parse(firstResponse.body);
					expect(firstReceipt).toMatchObject({
						status: "saved",
						bytes: firstGolden.length,
						hash: sha256(firstGolden),
						snapshotRevision: firstRevision,
					});
					// Boolean comparison avoids dumping a 20 MiB diff if the byte assertion fails.
					expect((await readFile(path)).equals(firstGolden)).toBe(true);
					await page.waitForFunction(() => {
						const save = document.querySelector<HTMLButtonElement>('[aria-label="Save"]');
						return window.__editorRealIo.state().dirty && save && !save.disabled;
					});
					expect(await page.evaluate(() => window.__editorRealIo.fingerprint())).toEqual(
						fingerprint(finalGolden),
					);
					const secondRevision = await page.evaluate(() => window.__editorRealIo.state().revision);
					await ctrl("s");
					const secondResponse = await readCommitResponse(1);
					expect(secondResponse.status).toBe(200);
					const secondReceipt: EditorCommitResult = JSON.parse(secondResponse.body);
					expect(secondReceipt).toMatchObject({
						status: "saved",
						bytes: finalGolden.length,
						hash: sha256(finalGolden),
						snapshotRevision: secondRevision,
					});
					expect(secondReceipt.operationId).not.toBe(firstReceipt.operationId);
					expect((await readFile(path)).equals(finalGolden)).toBe(true);
					await page.waitForFunction(() => !window.__editorRealIo.state().dirty);
					const beforeReload = await page.evaluate(() => window.__editorRealIo.state().revision);
					const contentBeforeReload = contentResponses;
					await page.click('[aria-label="Reload from disk"]');
					await page.waitForFunction(
						(previous) => {
							const state = window.__editorRealIo.state();
							return state.revision > previous && !state.dirty;
						},
						{},
						beforeReload,
					);
					expect(contentResponses).toBeGreaterThan(contentBeforeReload);
					expect(await page.evaluate(() => window.__editorRealIo.fingerprint())).toEqual(
						fingerprint(finalGolden),
					);
					const finalState = await page.evaluate(() => window.__editorRealIo.state());
					expect(finalState.lines).toBe(lines.length);
					expect(finalState.length).toBe(originalText.length + PREFIX.length + DURING_SAVE.length);
					expect(finalState.dirty).toBe(false);
					expect(await readFile(outside, "utf8")).toBe("outside boundary sentinel\n");
					const operations = db
						.select({
							sourceKind: fileChangeOperations.sourceKind,
							sourceId: fileChangeOperations.sourceId,
							actorSubjectKey: fileChangeOperations.actorSubjectKey,
							actorJson: fileChangeOperations.actorJson,
							settlement: fileChangeOperations.settlement,
							executionOutcome: fileChangeOperations.executionOutcome,
						})
						.from(fileChangeOperations)
						.where(eq(fileChangeOperations.narratorId, narratorId))
						.limit(3)
						.all();
					expect(operations).toHaveLength(2);
					for (const receipt of [firstReceipt, secondReceipt])
						expect(
							operations.find((operation) => operation.sourceId === receipt.operationId),
						).toMatchObject({
							sourceKind: "editor",
							actorSubjectKey: `user:${userId}`,
							actorJson: { kind: "human", userId, narratorId: null },
							settlement: "settled",
							executionOutcome: "succeeded",
						});
					expect(commits).toBe(2);
					expect(workerCount).toBeGreaterThan(0);
					expect(offOriginCount).toBe(0);
					expect(httpErrors).toBe(2);
					expect(health.length).toBeGreaterThan(2);
					expect(health.some((sample) => sample.duringCommit)).toBe(true);
					expect(health.some((sample) => sample.duringDurable)).toBe(true);
					expect(Math.max(...health.map((sample) => sample.ms))).toBeLessThan(2000);
					deadline.signal.throwIfAborted();
					expect(diagnostics).toEqual([]);
					console.info(
						JSON.stringify({
							test: "editor-real-io",
							bundle: bundle.metadata,
							identity: "synthetic (not production JWT coverage)",
							sourceBytes: original.length,
							finalBytes: finalGolden.length,
							lines: lines.length,
							durableHumanOperations: operations.length,
							workerCount,
							requestCount,
							healthSamples: health.length,
							healthDuringDurable: health.filter((sample) => sample.duringDurable).length,
							healthMaxMs: Math.round(Math.max(...health.map((sample) => sample.ms))),
							elapsedMs: Math.round(performance.now() - started),
						}),
					);
					await page.evaluate(() => window.__editorRealIo.dispose());
				})(),
			);
		} catch (error) {
			if (diagnostics.length) console.error(`Real IO diagnostics: ${JSON.stringify(diagnostics)}`);
			throw error;
		} finally {
			clearTimeout(timeout);
			deadline.abort(new Error("Fixture teardown"));
			stopSampling.abort();
			releaseCommit.resolve();
			const cleanupErrors: string[] = [];
			const cleanup = async (name: string, action: () => Promise<unknown>) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						action(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error(`${name}: teardown exceeded 4s`)), 4000);
						}),
					]);
				} catch (error) {
					cleanupErrors.push(String(error).slice(0, 300));
				} finally {
					clearTimeout(timer);
				}
			};
			// Three bounded phases leave room below the 120s total. Always attempt all teardown.
			await Promise.all([
				cleanup("health sampler", async () => sampler),
				cleanup("browser", async () => {
					// Only the browser spawned by THIS fixture may be force-closed.
					const process = browser?.process();
					const kill = setTimeout(() => process?.kill("SIGKILL"), 3000);
					try {
						await browser?.close();
					} finally {
						clearTimeout(kill);
					}
				}),
				cleanup("production builder", async () => {
					if (builder && !builderStopped) {
						// Only this fixture's child process; never touch running application/matrix jobs.
						builder.kill("SIGKILL");
						await builder.exited;
						builderStopped = true;
					}
				}),
				cleanup("Bun server and streams", async () => backend?.stop(true)),
			]);
			await cleanup("document service", async () => service?.dispose());
			await Promise.all([
				cleanup("temporary fixture", async () => {
					if (root) await rm(root, { recursive: true, force: true });
				}),
				cleanup("temporary bundle", async () => {
					// If child shutdown failed, leave evidence rather than race an active writer.
					if (!builderStopped) throw new Error("Builder still running; bundle directory retained");
					if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
				}),
			]);
			expect(cleanupErrors).toEqual([]);
		}
	},
	120_000,
);
