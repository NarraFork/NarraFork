import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import type { ToolContext } from "../../agent/types";
import type { BrowserSession } from "../session";

// All modules/settings/logs use disposable data. Chrome is launched by this test process;
// never reconnect to a server endpoint, use a persisted handoff or touch real user sessions.
const home = await mkdtemp(join(tmpdir(), "nf-memory-integration-"));
const previousHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { getBrowser, closeBrowser } = await import("../pool");
const {
	createSession,
	closeSession,
	cleanupNarrator,
	closeAllSessions,
	getSession,
	listSessions,
	getAllSessionStats,
	snapshotSessionsForHandoff,
} = await import("../session");
const { memoryMetrics, heapSnapshot } = await import("../memory");
const { browserTool } = await import("../../agent/tools/browser");
const { runMemoryJob, waitForMemory } = await import("../memory-job");
let ownedBrowser: Browser | undefined;
try {
	ownedBrowser = await getBrowser(true);
} catch (error) {
	if (!(error instanceof Error) || !error.message.startsWith("Could not find Chrome/Chromium.")) {
		await rm(home, { recursive: true, force: true });
		throw error;
	}
	console.warn("SKIP browser memory integration: Chrome/Chromium is not installed");
}
const chromeTest = ownedBrowser ? test : test.skip;
const fixtureUrl = `data:text/html,${encodeURIComponent("<!doctype html><title>controlled-memory-fixture</title><button>fixture</button>")}`;
async function session() {
	return createSession(`test-memory-${crypto.randomUUID()}`, fixtureUrl, true);
}
async function waitUntil(check: () => boolean) {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Memory lifecycle cleanup exceeded deadline");
		await Bun.sleep(10);
	}
}
function pendingJob(target: BrowserSession) {
	let finished = false;
	let wasOpenDuringCleanup = false;
	const operation = runMemoryJob(target, 10_000, undefined, async (signal) => {
		try {
			await waitForMemory(new Promise<void>(() => {}), signal);
		} finally {
			wasOpenDuringCleanup = !target.page.isClosed();
			await Bun.sleep(10);
			finished = true;
		}
	});
	// Attach a rejection observer immediately, before invoking any shutdown path.
	const settled = operation.then(
		() => new Error("Expected diagnostic cancellation"),
		(error: unknown) => error,
	);
	return { settled, finished: () => finished, wasOpen: () => wasOpenDuringCleanup };
}
async function cancelled(job: ReturnType<typeof pendingJob>, target: BrowserSession) {
	expect(await job.settled).toBeInstanceOf(Error);
	expect(String(await job.settled)).toContain("session closed");
	expect(job.finished()).toBe(true);
	expect(job.wasOpen()).toBe(true);
	expect(target.memoryJob).toBeUndefined();
	expect(target.memoryDiagnosticsClosed).toBe(true);
}
afterAll(async () => {
	try {
		await closeAllSessions();
		await closeBrowser();
	} finally {
		if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

describe("browser memory with owned Chrome", () => {
	chromeTest(
		"memory tool refuses another narrator's existing session",
		async () => {
			const target = await session();
			try {
				const ctx = { narratorId: "other-narrator" } as ToolContext;
				for (const action of ["memory_metrics", "heap_snapshot"]) {
					const result = await browserTool.execute({ action, session_id: target.id }, ctx);
					expect(result.isError).toBe(true);
					expect(result.output).toContain("Session not found");
				}
				expect(target.memoryJob).toBeUndefined();
			} finally {
				await closeSession(target.narratorId, target.id);
			}
		},
		20_000,
	);

	chromeTest(
		"tool dispatch samples owned session and rejects custom snapshot file_path",
		async () => {
			const target = await session();
			try {
				const ctx = { narratorId: target.narratorId } as ToolContext;
				const metrics = await browserTool.execute(
					{
						action: "memory_metrics",
						session_id: target.id,
						collect_garbage: true,
					},
					ctx,
				);
				expect(metrics.isError).not.toBe(true);
				expect(metrics.output).toContain("Forced GC: true");
				expect(metrics.metadata?.memoryMetrics).toMatchObject({ collectGarbage: true });
				const custom = await browserTool.execute(
					{
						action: "heap_snapshot",
						session_id: target.id,
						file_path: join(home, "not-allowed"),
					},
					ctx,
				);
				expect(custom.isError).toBe(true);
				expect(custom.output).toContain("file_path is not supported");
			} finally {
				await closeSession(target.narratorId, target.id);
			}
		},
		20_000,
	);
	chromeTest(
		"samples retained allocation and exports a valid heap snapshot without blocking timers",
		async () => {
			const target = await session();
			const savePath = join(home, "controlled.heapsnapshot");
			let ticks = 0;
			let timer: ReturnType<typeof setInterval> | undefined;
			try {
				const before = await memoryMetrics(target, { collectGarbage: true });
				await target.page.evaluate(() => {
					(globalThis as unknown as { retainedMemory: object[] }).retainedMemory = Array.from(
						{ length: 30_000 },
						(_, index) => ({ index, marker: `retained-${index}` }),
					);
				});
				const after = await memoryMetrics(target, { collectGarbage: true });
				expect(before.JSHeapUsedSize).not.toBeNull();
				expect(after.JSHeapUsedSize).toBeGreaterThan(before.JSHeapUsedSize ?? 0);
				expect(after.JSHeapTotalSize).toBeGreaterThanOrEqual(after.JSHeapUsedSize ?? 0);
				expect(after.Documents).toBeGreaterThan(0);
				timer = setInterval(() => {
					ticks++;
				}, 5);
				const result = await heapSnapshot(target, savePath, 64 * 1024 * 1024, {
					collectGarbage: true,
					timeout: 60_000,
				});
				clearInterval(timer);
				expect(ticks).toBeGreaterThan(1);
				expect(result.fileSize).toBeGreaterThan(0);
				expect((await stat(savePath)).size).toBe(result.fileSize);
				const snapshot = JSON.parse(await readFile(savePath, "utf8"));
				expect(snapshot.snapshot.meta.node_fields).toContain("type");
				expect(snapshot.snapshot.node_count).toBeGreaterThan(0);
				expect(snapshot.nodes.length).toBeGreaterThan(0);
				expect(snapshot.edges.length).toBeGreaterThan(0);
				expect(snapshot.strings).toContain("retainedMemory");
				expect(Object.keys(result).sort()).toEqual(["durationMs", "fileSize", "timestamp", "url"]);
				expect(JSON.stringify(result)).not.toContain(ownedBrowser?.wsEndpoint() ?? "ws://");
				expect(target.memoryJob).toBeUndefined();
			} finally {
				clearInterval(timer);
				await closeSession(target.narratorId, target.id);
				await rm(savePath, { force: true });
			}
		},
		90_000,
	);

	chromeTest(
		"closeSession cancels and awaits diagnostics before context close",
		async () => {
			const target = await session();
			const job = pendingJob(target);
			expect(await closeSession(target.narratorId, target.id)).toBe(true);
			await cancelled(job, target);
			expect(target.page.isClosed()).toBe(true);
			expect(getSession(target.narratorId, target.id)).toBeUndefined();
		},
		20_000,
	);

	chromeTest(
		"cleanupNarrator cancels diagnostics before closing its contexts",
		async () => {
			const target = await session();
			const job = pendingJob(target);
			await cleanupNarrator(target.narratorId);
			await cancelled(job, target);
			expect(target.page.isClosed()).toBe(true);
		},
		20_000,
	);

	for (const preserve of [false, true]) {
		chromeTest(
			`closeAllSessions preserve=${preserve} cancels; handles are absent from public metadata`,
			async () => {
				const target = await session();
				try {
					const job = pendingJob(target);
					for (const metadata of [
						listSessions(target.narratorId),
						getAllSessionStats(),
						snapshotSessionsForHandoff(),
					]) {
						const serialized = JSON.stringify(metadata);
						expect(serialized).not.toContain("memoryJob");
						expect(serialized).not.toContain("memoryDiagnosticsClosed");
						expect(serialized).not.toContain("controller");
					}
					expect(await closeAllSessions({ preserve })).toBe(1);
					await cancelled(job, target);
					expect(target.page.isClosed()).toBe(!preserve);
					expect(getAllSessionStats().totalSessions).toBe(0);
					if (preserve) expect(await target.page.title()).toBe("controlled-memory-fixture");
				} finally {
					await target.context.close().catch(() => {});
				}
			},
			20_000,
		);
	}

	chromeTest(
		"expired session cancels diagnostics, removes registry and then closes context",
		async () => {
			const target = await session();
			const job = pendingJob(target);
			// Deterministic expiry: no global clocks or 60s cleanup-interval mocks.
			target.lastActivity = Date.now() - target.ttlMs - 1;
			expect(getSession(target.narratorId, target.id)).toBeUndefined();
			await cancelled(job, target);
			await waitUntil(() => target.page.isClosed());
			expect(listSessions(target.narratorId)).toEqual([]);
		},
		20_000,
	);
});
