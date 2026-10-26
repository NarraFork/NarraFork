import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FILE_PANEL_PAGE_BYTES } from "@shared/file-reference";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import puppeteer from "puppeteer-core";
import type * as Fixture from "../../scripts/smoke-editor-raw-fixture";
import type { FixtureAsset } from "../../scripts/smoke-monaco-large-file-bundle";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { createToken, verifyToken } from "../lib/auth";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";
import { getDeviceConnectionGeneration } from "../services/device-connection-service";
import { createRemoteBackend } from "../services/device-remote-backend";
import { getEditorDocumentService } from "../services/editor-document-runtime";
import { editorFileSubscriptions } from "../services/editor-file-subscription";
import { handleNarratorWS, type NarratorClientMessage } from "../websocket/narrator-ws";
import { resolveWSData, type WSData } from "../websocket/ws-handler";
import { createEditorDocumentRoutes } from "./editor-documents";
import { editorHostColdBrowserAcceptance } from "./editor-host-cold-browser-acceptance";
import { denyHostEditorHelpers, nativeEditorFixture } from "./editor-native-fixture";
import { createFileReferenceRoutes } from "./narrator-file-references";

type RawWindow = Window & { rawFixture: typeof Fixture };
const CHROME =
	process.env.NF_TEST_CHROMIUM_PATH ??
	process.env.PUPPETEER_EXECUTABLE_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Fixture-only bounded sampling, never a production API/store scan. */
async function fixtureBytes(
	directory: string,
	depth = 0,
	kind: "all" | "stage" | "temporary" = "all",
): Promise<number> {
	if (depth > 8) throw new Error("Fixture resource tree depth exceeded");
	const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	if (entries.length > 512) throw new Error("Fixture resource tree entries exceeded");
	let bytes = 0;
	for (const entry of entries) {
		const path = join(directory, entry.name);
		try {
			if (entry.isDirectory()) bytes += await fixtureBytes(path, depth + 1, kind);
			else if (
				kind === "all" ||
				(kind === "stage" && entry.name.endsWith(".body")) ||
				(kind === "temporary" &&
					(entry.name.endsWith(".tmp") || entry.name.startsWith(".nf-editor-")))
			)
				bytes += (await lstat(path)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return bytes;
}

test.each([
	"local",
	"remote",
] as const)("Chrome production writer, ordinary Host or verified authenticated executor WS (%s)", async (device) => {
	const processGuard = denyHostEditorHelpers();
	const hostHelperDiagnostics = () => ({
		processes: processGuard.starts,
		peak: processGuard.starts,
		roots: processGuard.starts,
		queued: 0,
	});
	const project = resolve(import.meta.dir, "../.."),
		root = await mkdtemp(join(testEnvironment.isolatedHome, "native-browser-"));
	const bundleRoot = await mkdtemp(join(project, ".tmp-narrafork-home.native-browser-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const target = join(workspace, "twenty.txt");
	const original = Buffer.alloc(20 * 1024 * 1024 - 1, 65);
	// A realistic large source: bounded lines exercise the 100k-line plaintext profile.
	// The separate raw browser suite retains the 20 MiB single-long-line boundary.
	for (let offset = 127; offset < original.length; offset += 128) original[offset] = 10;
	original[0] = 97;
	original[1] = 10;
	await writeFile(target, original);
	await chmod(target, 0o640);
	const initialInode = (await lstat(target)).ino;
	const fixture = await nativeEditorFixture(root, workspace);
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
			defaultDeviceId: device === "remote" ? fixture.deviceId : "local",
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const token = await createToken(userId);
	const browserSockets = new Set<Parameters<typeof handleNarratorWS.open>[0]>();
	const heartbeat = setInterval(() => {
		for (const socket of browserSockets) socket.send(JSON.stringify({ type: "ping" }));
	}, 30_000);
	let server: Bun.Server<WSData> | undefined;
	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	let commits = 0,
		documentCreates = 0,
		contentReads = 0,
		bodyPublications = 0,
		pageReads = 0;
	let legacyHost: "missing" | "text-v1" | undefined;
	let failDraftAnchors = false;
	let stopSampling = false;
	let sampler: Promise<void> | undefined;
	let samplingFailure: unknown;
	const samples: {
		fd: number;
		storedBytes: number;
		tempBytes: number;
		retainedStageBytes: number;
		reservedBytes: number;
		helpers: ReturnType<typeof hostHelperDiagnostics>;
		subscriptions: typeof editorFileSubscriptions.diagnostics;
		streams: {
			active: number;
			queued: number;
			streams: number;
			windowBytes: number;
			workers: number;
		};
	}[] = [];
	try {
		if (device === "remote") await fixture.start();
		// Local uses the production Host writer; no helper preparation/probe.
		const service = getEditorDocumentService();
		const app = new Hono();
		// Same synthetic HTTP identity boundary as existing browser fixtures; WS authentication is real.
		app.use("*", async (c, next) => {
			c.set("user", { sub: userId, role: "user", iat: 1, exp: 9999999999 });
			await next();
		});
		app.route(
			"/api/narrators",
			createEditorDocumentRoutes(() => service),
		);
		app.route("/api/narrators/:id/file-references", createFileReferenceRoutes());
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
			timeout: 60_000,
			maxOutputBytes: 65536,
		});
		if (built.exitCode) throw new Error(`Native Chrome bundle failed: ${built.stderr}`);
		if (Bun.file(manifestPath).size > 1024 * 1024) throw new Error("Fixture manifest budget");
		const data = (await Bun.file(manifestPath).json()) as {
			html: string;
			assets: [string, FixtureAsset][];
		};
		const assets = new Map(data.assets);
		server = Bun.serve<WSData>({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request, server) {
				const url = new URL(request.url),
					path = url.pathname;
				if (path === "/ws/narrator") {
					const verified = await verifyToken(url.searchParams.get("token") ?? "");
					if (verified.sub !== userId) return new Response("Denied", { status: 403 });
					const data = resolveWSData(
						url,
						{ userId, username: userId, avatarColor: null, avatarImageId: null, role: "user" },
						undefined,
						{
							sessionExp: verified.exp,
							sessionUserId: verified.sub,
							sessionId: verified.sid,
						},
					);
					if (data && server.upgrade(request, { data })) return;
					return new Response("Upgrade refused", { status: 400 });
				}
				if (path === "/fixture-config")
					return Response.json({
						narratorId,
						token,
						deviceId: device === "remote" ? fixture.deviceId : "local",
					});
				if (path.startsWith("/api/")) {
					if (legacyHost && path.endsWith("/editor-documents/capabilities"))
						return legacyHost === "missing"
							? new Response(null, { status: 404 })
							: Response.json({ protocols: ["text-v1"] });
					if (failDraftAnchors && request.method === "POST" && path.endsWith("/draft-anchors"))
						return Response.json(
							{ error: "Fixture checkpoint persistence unavailable" },
							{ status: 503 },
						);
					if (request.method === "POST" && path.endsWith("/editor-documents")) documentCreates++;
					if (request.method === "POST" && /\/raw-reads\/[^/]+$/.test(path)) bodyPublications++;
					if (path.endsWith("/content")) contentReads++;
					if (path.endsWith("/page")) pageReads++;
					if (path.endsWith("/commit")) commits++;
					return app.fetch(request);
				}
				if (path === "/")
					return new Response(data.html, { headers: { "Content-Type": "text/html" } });
				const asset = assets.get(path);
				return asset
					? new Response(Bun.file(asset.path), { headers: { "Content-Type": asset.mime } })
					: new Response("not found", { status: 404 });
			},
			websocket: {
				open(ws) {
					if (ws.data.channel === "narrator") {
						const socket = ws as Parameters<typeof handleNarratorWS.open>[0];
						browserSockets.add(socket);
						handleNarratorWS.open(socket);
					}
				},
				async message(ws, frame) {
					if (ws.data.channel === "narrator")
						await handleNarratorWS.message(
							ws as Parameters<typeof handleNarratorWS.message>[0],
							JSON.parse(String(frame)) as NarratorClientMessage,
						);
				},
				close(ws) {
					if (ws.data.channel === "narrator") {
						const socket = ws as Parameters<typeof handleNarratorWS.close>[0];
						browserSockets.delete(socket);
						handleNarratorWS.close(socket);
					}
				},
			},
		});
		browser = await puppeteer.launch({
			executablePath: CHROME,
			headless: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
			timeout: 15_000,
		});
		const page = await browser.newPage();
		await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture, {
			timeout: 30_000,
		});
		const cdp = await page.createCDPSession();
		await cdp.send("HeapProfiler.collectGarbage");
		const baseline = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		const sample = async () => {
			if (samples.length >= 2048) throw new Error("Fixture sample budget exceeded");
			samples.push({
				fd: (await readdir("/proc/self/fd")).length,
				storedBytes: await fixtureBytes(getNarraforkHome()),
				tempBytes:
					(await fixtureBytes(getNarraforkHome(), 0, "temporary")) +
					(await fixtureBytes(root, 0, "temporary")),
				retainedStageBytes:
					(await fixtureBytes(getNarraforkHome(), 0, "stage")) +
					(await fixtureBytes(root, 0, "stage")),
				reservedBytes: service.diagnostics.reservedBytes,
				helpers: hostHelperDiagnostics(),
				subscriptions: editorFileSubscriptions.diagnostics,
				streams: service.diagnostics.streams,
			});
		};
		await sample();
		sampler = (async () => {
			while (!stopSampling) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				if (!stopSampling) await sample();
			}
		})().catch((error) => {
			samplingFailure = error;
		});
		const coldStarted = performance.now(),
			coldPublications = bodyPublications,
			coldFrames = fixture.rawChunks;
		await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.restoreCold(path),
			target,
		);
		await page
			.waitForFunction(
				() => {
					const state = (window as unknown as RawWindow).rawFixture.state();
					return (
						state.views.views === 2 && state.disk.subscriptions === 1 && state.registry.loads === 0
					);
				},
				// Cold restore includes metadata preflight + body: each keeps its own 30 s IO budget.
				{ timeout: 60_000 },
			)
			.catch(async (error) => {
				console.error(
					"EDITOR_NATIVE_COLD_STATE",
					JSON.stringify(
						await page.evaluate(() => ({
							state: (window as unknown as RawWindow).rawFixture.state(),
							messages: [...document.querySelectorAll(".mantine-Text-root")]
								.slice(0, 10)
								.map((node) => (node.textContent ?? "").slice(0, 256)),
						})),
					),
				);
				throw error;
			});
		if (device === "remote") {
			expect(bodyPublications - coldPublications).toBeGreaterThanOrEqual(640);
			expect(bodyPublications - coldPublications).toBeLessThan(1280);
			expect(fixture.maxRawCredit).toBeLessThanOrEqual(16384);
			console.info(
				"EDITOR_REMOTE_COLD_PUBLICATIONS",
				JSON.stringify({
					bytes: original.length,
					coldMs: Math.round(performance.now() - coldStarted),
					httpPublications: bodyPublications - coldPublications,
					peerFramesIncludingMetadata: fixture.rawChunks - coldFrames,
					maximumPeerCredit: fixture.maxRawCredit,
					streamWindow: 256 * 1024,
					deadlineMs: 30000,
				}),
			);
		}
		expect(editorFileSubscriptions.diagnostics.resources).toBe(1);
		const restored = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		expect(restored.registry.tabs).toBe(1000);
		expect(restored.registry.workingCopies).toBe(1);
		expect(restored.registry.docs).toBe(1);
		expect(restored.registry.visibleConsumers).toBe(2);
		expect(restored.models).toBe(1);
		const opened = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.adoptVisible(),
		);
		expect(opened.session?.capabilities).toMatchObject({
			rawSave: true,
			stage: true,
			durableApply: device === "remote",
			durableQuery: true,
		});
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.edit("Z"));
		const saved = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.saveRaw());
		if (saved.session?.phase !== "idle" || saved.dirty) {
			console.error(
				"EDITOR_NATIVE_SAVE_FAILURE",
				JSON.stringify({
					device,
					dirty: saved.dirty,
					phase: saved.session?.phase,
					error: saved.session?.error?.slice(0, 512),
					receiptError: saved.session?.receiptError?.slice(0, 512),
					applies: fixture.applies,
					childLogs: fixture.logs,
				}),
			);
		}
		expect(saved.session?.phase).toBe("idle");
		expect(saved.dirty).toBe(false);
		const expected = Buffer.concat([Buffer.from("Z"), original]);
		expect(hash(await readFile(target))).toBe(hash(expected));
		if (device === "remote") expect((await lstat(target)).ino).not.toBe(initialInode);
		else {
			expect((await lstat(target)).ino).toBe(initialInode);
			expect(fixture.applies).toBe(0);
			expect(hostHelperDiagnostics()).toMatchObject({ processes: 0, roots: 0, queued: 0 });
		}
		expect((await lstat(target)).mode & 0o777).toBe(0o640);
		expect(commits).toBe(1);
		if (device === "remote") {
			const before = getDeviceConnectionGeneration(fixture.deviceId);
			if (before === null) throw new Error("Fixture device disconnected unexpectedly");
			const stale = createRemoteBackend(fixture.deviceId, {
				connectionGeneration: before,
				defaultCwd: workspace,
				platform: { os: "linux", arch: "amd64" },
			});
			// A one-byte replacement keeps the same 20 MiB budget for another actual save.
			await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.rawBatch([
					{
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
						text: "Y",
					},
				]),
			);
			fixture.dropSuccess();
			const unknown = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.saveRaw(),
			);
			expect(unknown.session?.phase).toBe("unknown");
			expect(fixture.applies).toBe(2);
			await fixture.reconnect();
			expect(getDeviceConnectionGeneration(fixture.deviceId)).not.toBe(before);
			expect(stale.supportsEditorDurableWrite).toBe(false);
			const reconciled = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.reconcileRaw(),
			);
			expect(reconciled.session?.phase).toBe("idle");
			expect(reconciled.dirty).toBe(false);
			expect(fixture.applies).toBe(2);
			expect(commits).toBe(2);
			await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.rawBatch([
					{
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
						text: "D",
					},
				]),
			);
			const dirtyBeforeRestart = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.state(),
			);
			await fixture.restart();
			const retained = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.refresh(),
			);
			expect(retained.lifetime).toBe(dirtyBeforeRestart.lifetime);
			expect(retained.session?.version).toEqual(dirtyBeforeRestart.session?.version);
			expect(retained.session?.baseHash).toBe(dirtyBeforeRestart.session?.baseHash);
			expect(retained.dirty).toBe(true);
			expect(retained.session?.invalidated).not.toBe(true);
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.reconnectHost());
			await page.waitForFunction(
				() => (window as unknown as RawWindow).rawFixture.state().connected,
				{ timeout: 15_000 },
			);
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.restoredTabs(false));
			await page.waitForFunction(
				() => (window as unknown as RawWindow).rawFixture.state().views.views === 0,
				{ timeout: 5000 },
			);
			const hidden = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
			expect(hidden.disk.subscriptions).toBe(0);
			expect(hidden.dirty).toBe(true);
			expect(hidden.models).toBe(1);
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.restoredTabs());
			await page.waitForFunction(
				() => (window as unknown as RawWindow).rawFixture.state().views.views === 2,
				{ timeout: 15_000 },
			);
			await page.evaluate(() => {
				const f = (window as unknown as RawWindow).rawFixture;
				f.undo();
				f.redo();
			});
			expect(
				(await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state())).lifetime,
			).toBe(dirtyBeforeRestart.lifetime);
			await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.rawBatch([
					{
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
						text: "X",
					},
				]),
			);
			const nextSave = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.saveRaw(),
			);
			if (nextSave.dirty)
				console.error(
					"EDITOR_NATIVE_RECONNECT_SAVE",
					JSON.stringify({
						session: nextSave.session,
						disk: nextSave.disk,
						docId: nextSave.docId,
						invalidations: nextSave.invalidations,
						commits,
						applies: fixture.applies,
					}),
				);
			expect(nextSave.session?.phase).toBe("idle");
			expect(nextSave.dirty).toBe(false);
			expect(fixture.applies).toBe(3);
			expect(commits).toBe(3);
			await fixture.reconnect(true);
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());
			const readonly = await page.evaluate(
				(path) => (window as unknown as RawWindow).rawFixture.open(path),
				target,
			);
			expect(readonly.session?.capabilities).toMatchObject({
				stage: false,
				durableApply: false,
				durableQuery: false,
				writeUnavailableReason: "durable_executor_unavailable",
			});
		}
		if (device === "remote") await fixture.reconnect(false);
		const pollTarget = join(workspace, "ignored.txt");
		await writeFile(pollTarget, "one\n");
		await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.open(path),
			pollTarget,
		);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.restoredTabs());
		await page.waitForFunction(
			() => {
				const state = (window as unknown as RawWindow).rawFixture.state();
				return (
					state.views.views === 2 &&
					state.observing &&
					state.disk.running === 0 &&
					state.disk.pending === 0
				);
			},
			{ timeout: 10_000 },
		);
		// A real Bash writer in a non-Git workspace emits no NarraFork/Git hint.
		// The authorized shared Host poll must discover this same-size rewrite.
		const bashWrite = async (text: "two" | "new") => {
			const result = await safeSpawn({
				cmd: ["bash", "-c", `printf '${text}\\n' > "$1"`, "editor-fixture", pollTarget],
				timeout: 5000,
				maxOutputBytes: 1024,
			});
			expect(result.exitCode).toBe(0);
		};
		await bashWrite("two");
		const twoHash = hash(Buffer.from("two\n"));
		await page.waitForFunction(
			(expected) =>
				(window as unknown as RawWindow).rawFixture.state().session?.baseHash === expected,
			{ timeout: 20_000 },
			twoHash,
		);
		expect(
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.fingerprint()),
		).toBe(twoHash);
		const pollClean = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.state(),
		);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.edit("mine "));
		await bashWrite("new");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForFunction(
			() =>
				(window as unknown as RawWindow).rawFixture.state().session?.externalDisk === "modified",
			{ timeout: 10_000 },
		);
		const pollDirty = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.state(),
		);
		expect(pollDirty.dirty).toBe(true);
		expect(pollDirty.lifetime).toBe(pollClean.lifetime);
		expect(pollDirty.session?.baseHash).toBe(twoHash);
		expect(
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.fingerprint()),
		).toBe(hash(Buffer.from("mine two\n")));
		if (device === "remote") {
			const draftTarget = join(workspace, "draft-utf16.txt");
			const diskBytes = Buffer.from("\ufeff首\r\n正文\r下一\nend", "utf16le");
			const draftBytes = Buffer.from("\ufeffD首\r\n正文\r下一\nend", "utf16le");
			await writeFile(draftTarget, diskBytes);
			await page.evaluate(
				(path) => (window as unknown as RawWindow).rawFixture.openDefault(path),
				draftTarget,
			);
			await page.waitForFunction(
				() => (window as unknown as RawWindow).rawFixture.state().views.views === 1,
				{ timeout: 10_000 },
			);
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.adoptVisible());
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.edit("D"));
			failDraftAnchors = true;
			expect(
				await page.evaluate(() => (window as unknown as RawWindow).rawFixture.checkpointRaw()),
			).toHaveLength(0);
			await page.waitForSelector("[data-editor-backup-incomplete]", { timeout: 10_000 });
			failDraftAnchors = false;
			const checkpoint = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.checkpointRaw(),
			);
			expect(checkpoint).toHaveLength(1);
			expect(checkpoint[0]?.anchor?.anchorId).toBeTruthy();
			expect(checkpoint[0]?.protocol).toBe("raw-v2");
			expect(checkpoint[0]?.encoding).toBe("utf-16le");
			page.once("dialog", (dialog) => {
				expect(dialog.type()).toBe("beforeunload");
				void dialog.accept();
			});
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture, {
				timeout: 30_000,
			});
			await page.evaluate(
				(path) => (window as unknown as RawWindow).rawFixture.openDefault(path),
				draftTarget,
			);
			await page.waitForSelector("[data-editor-draft-restore]:not([disabled])", {
				timeout: 15_000,
			});
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.adoptVisible());
			await page.click("[data-editor-draft-restore]");
			await page.waitForFunction(
				() => (window as unknown as RawWindow).rawFixture.state().session?.restoredDraft,
				{ timeout: 15_000 },
			);
			const restoredDraft = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.encodeRaw(),
			);
			expect(restoredDraft.rawDigest).toBe(hash(draftBytes));
			expect(restoredDraft.state.dirty).toBe(true);
			expect(hash(await readFile(draftTarget))).toBe(hash(diskBytes));
			const savedDraft = await page.evaluate(() =>
				(window as unknown as RawWindow).rawFixture.saveRaw(),
			);
			expect(savedDraft.dirty).toBe(false);
			expect(hash(await readFile(draftTarget))).toBe(hash(draftBytes));
			console.info(
				"EDITOR_REMOTE_DRAFT_REFRESH",
				JSON.stringify({
					completeCheckpoint: true,
					realPageRefresh: true,
					encoding: "utf-16le",
					bomAndMixedEolPreserved: true,
					restoredDirty: true,
					actualGoApplies: fixture.applies,
				}),
			);
			await fixture.reconnect(false, true);
			const legacyTarget = join(workspace, "legacy-only.txt");
			await writeFile(legacyTarget, "legacy-safe\n");
			const previousReads = fixture.reads,
				previousRaw = fixture.rawOpens,
				previousCreates = documentCreates;
			await page.evaluate(
				(path) => (window as unknown as RawWindow).rawFixture.openDefault(path),
				legacyTarget,
			);
			await page.waitForFunction(
				() =>
					(window as unknown as RawWindow).rawFixture
						.state()
						.viewSamples.some((view) => view.prefix === "legacy-safe"),
				{ timeout: 15_000 },
			);
			const legacy = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
			expect(legacy.viewReadOnly).toEqual([true]);
			expect(documentCreates).toBe(previousCreates);
			expect(fixture.reads).toBeGreaterThan(previousReads);
			expect(fixture.rawOpens).toBe(previousRaw);
			console.info(
				"EDITOR_LEGACY_EXECUTOR_PREVIEW",
				JSON.stringify({
					defaultFilePanel: true,
					rawReadFeatureRemoved: true,
					authenticatedGoReads: fixture.reads - previousReads,
					rawOpens: fixture.rawOpens - previousRaw,
					documentCreates: documentCreates - previousCreates,
					readonly: true,
				}),
			);
			await fixture.reconnect(false, false);
		} else {
			const legacyTarget = join(workspace, "legacy-large.txt");
			await writeFile(legacyTarget, "A".repeat(2 * 1024 * 1024));
			for (const mode of ["missing", "text-v1"] as const) {
				legacyHost = mode;
				const beforeCreates = documentCreates,
					beforeContents = contentReads,
					beforePages = pageReads;
				await page.evaluate(
					(path) => (window as unknown as RawWindow).rawFixture.openDefault(path),
					legacyTarget,
				);
				await page.waitForFunction(
					() =>
						!!document.querySelector("pre") ||
						(window as unknown as RawWindow).rawFixture.state().models > 0,
					{ timeout: 15_000 },
				);
				expect(
					await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state().models),
				).toBe(0);
				const pageLength = await page.$eval("pre", (node) => node.textContent?.length ?? 0);
				expect(pageLength).toBeGreaterThan(0);
				expect(pageLength).toBeLessThanOrEqual(FILE_PANEL_PAGE_BYTES);
				expect(documentCreates).toBe(beforeCreates);
				expect(contentReads).toBe(beforeContents);
				expect(pageReads).toBe(beforePages + 1);
				console.info(
					"EDITOR_OLD_HOST_PAGED",
					JSON.stringify({
						mode,
						defaultFilePanel: true,
						models: 0,
						boundedPageCharacters: pageLength,
						documentCreates: 0,
						fullContents: 0,
					}),
				);
			}
			legacyHost = undefined;
		}
		await page.evaluate(
			(path) => (window as unknown as RawWindow).rawFixture.open(path),
			pollTarget,
		);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.restoredTabs());
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().views.views === 2,
			{ timeout: 15_000 },
		);
		const beforeRevoke = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.state(),
		);
		db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, narratorId)).run();
		editorFileSubscriptions.hint(narratorId);
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().session?.invalidated === true,
			{ timeout: 10_000 },
		);
		const revoked = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		expect(revoked.length).toBe(beforeRevoke.length);
		expect(revoked.lifetime).toBe(beforeRevoke.lifetime);
		expect(revoked.disk.subscriptions).toBe(0);
		const beforeClose = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.state(),
		);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());
		const end = Date.now() + 5000;
		while (editorFileSubscriptions.diagnostics.references || hostHelperDiagnostics().processes) {
			if (Date.now() > end) throw new Error("Native subscription/helper cleanup did not settle");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		stopSampling = true;
		await sampler;
		if (samplingFailure) throw samplingFailure;
		await sample();
		await cdp.send("HeapProfiler.collectGarbage");
		const final = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		expect(final.registry.workingCopies).toBe(0);
		expect(final.models).toBe(0);
		expect(final.views.views).toBe(0);
		expect(final.disk).toEqual({ copies: 0, running: 0, pending: 0, timers: 0, subscriptions: 0 });
		expect(samples.at(-1)?.streams.active).toBe(0);
		expect(samples.at(-1)?.streams.streams).toBe(0);
		expect(samples.at(-1)?.tempBytes).toBe(0);
		// Acked terminal receipts/stage capabilities retain their frozen seven-day
		// bounded cache; they are not active streams or leaked replacement temp files.
		expect(samples.at(-1)?.retainedStageBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
		console.info(
			"EDITOR_NATIVE_CHROMIUM",
			JSON.stringify({
				device,
				binarySha256: fixture.binarySha256,
				bytes: expected.length,
				commits,
				actualExecutorApplies: fixture.applies,
				savedMode: (await lstat(target)).mode & 0o777,
				resources: {
					samples: samples.length,
					baseline: samples[0],
					final: samples.at(-1),
					peakFd: Math.max(...samples.map((sample) => sample.fd)),
					peakStoredBytes: Math.max(...samples.map((sample) => sample.storedBytes)),
					peakTempBytes: Math.max(...samples.map((sample) => sample.tempBytes)),
					peakReservedBytes: Math.max(...samples.map((sample) => sample.reservedBytes)),
					peakStreams: Math.max(...samples.map((sample) => sample.streams.active)),
					peakWindow: Math.max(...samples.map((sample) => sample.streams.windowBytes)),
					peakReferences: Math.max(...samples.map((sample) => sample.subscriptions.references)),
					peakHelpers: Math.max(...samples.map((sample) => sample.helpers.peak)),
					sampledPeakHelperProcesses: Math.max(
						...samples.map((sample) => sample.helpers.processes),
					),
					browserBaseline: { heap: baseline.heap, tasks: baseline.maxLongTaskMs },
					browserRestored: {
						heap: restored.heap,
						tasks: restored.maxLongTaskMs,
						registry: restored.registry,
						views: restored.views,
						disk: restored.disk,
						codecs: restored.codecs,
					},
					browserBeforeClose: { heap: beforeClose.heap, tasks: beforeClose.maxLongTaskMs },
					browserFinal: {
						heap: final.heap,
						tasks: final.maxLongTaskMs,
						codecs: final.codecs,
						save: final.save,
					},
				},
			}),
		);
		if (device === "local")
			await editorHostColdBrowserAcceptance({
				root,
				project,
				manifest: manifestPath,
				distributionUrl: fixture.distributionUrl,
				browser,
				original,
			});
	} finally {
		clearInterval(heartbeat);
		stopSampling = true;
		await sampler;
		await browser?.close();
		await server?.stop(true);
		await fixture.dispose();
		processGuard.restore();
		await rm(root, { recursive: true, force: true });
		await rm(bundleRoot, { recursive: true, force: true });
	}
}, 240_000);
