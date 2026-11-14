import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { WorkerHandle } from "../../worker-runtime/lifecycle";
import { reserveDiagnostic } from "../diagnostic-admission";
import { heapSnapshot } from "../memory";
import { closeMemoryDiagnosticWorkers, memoryDiagnosticQueue } from "../memory-job";
import { MemoryProfileRecorder } from "../memory-profile-worker";
import { cancelMemoryProfile, createMemoryProfiler } from "../memory-profiler";
import { createSnapshotExporter } from "../memory-snapshot";
import * as snapshotCore from "../memory-snapshot-worker";
import { type BrowserSession, closeAllSessions, getAllSessionStats } from "../session";
import { acquireTraceLease } from "../tracing-lease";

const mainSnapshot = spyOn(snapshotCore, "runSnapshot").mockImplementation(async () => {
	throw new Error("Snapshot core ran on the main thread");
});
const mainProfile = spyOn(MemoryProfileRecorder.prototype, "command").mockImplementation(() => {
	throw new Error("Profile core ran on the main thread");
});
afterEach(() => {
	expect(mainSnapshot).not.toHaveBeenCalled();
	expect(mainProfile).not.toHaveBeenCalled();
});
afterAll(() => {
	mainSnapshot.mockRestore();
	mainProfile.mockRestore();
});

const entry = new URL("./memory-diagnostic-worker.fixture.ts", import.meta.url).href;
const nativeThread = WorkerHandle.thread.bind(WorkerHandle);
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing expected fixture resource");
	return value;
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 1500 && !predicate(); i++) await Bun.sleep(2);
	expect(predicate()).toBe(true);
}
function nativeFixture(behavior: string, delayStop = false, forceFixtureEntry = false) {
	let resume!: () => void;
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const handles: WorkerHandle<Worker>[] = [];
	let terminating = 0;
	const spy = spyOn(WorkerHandle, "thread").mockImplementation((path, options) => {
		const handle = nativeThread(forceFixtureEntry ? new URL(entry) : path, {
			...options,
			workerData: { behavior },
		});
		handles.push(handle);
		const terminate = handle.resource.terminate.bind(handle.resource);
		spyOn(handle.resource, "terminate").mockImplementation(async () => {
			terminating++;
			if (delayStop) await gate;
			return terminate();
		});
		return handle;
	});
	return {
		handles,
		resume,
		terminating: () => terminating,
		async dispose() {
			resume();
			await Promise.all(
				handles.map(async (handle) => {
					await handle.close().catch(() => {});
					await handle.exited;
				}),
			);
			spy.mockRestore();
		},
	};
}
async function profileFixture(
	behavior: string,
	delayStop = false,
	setup?: () => Promise<{ targetId: string; detach(): Promise<void> }>,
) {
	const root = await mkdtemp(join(tmpdir(), "nf-memory-native-"));
	const browser = Object.assign(new EventEmitter(), {
		connected: true,
		wsEndpoint: () => `ws://fixture-${crypto.randomUUID()}`,
	});
	// Endpoint identity must remain stable for the lease owner.
	const endpoint = browser.wsEndpoint();
	browser.wsEndpoint = () => endpoint;
	const page = Object.assign(new EventEmitter(), { isClosed: () => false, browser: () => browser });
	const session = {
		id: crypto.randomUUID(),
		narratorId: "native-owner",
		page,
		lastActivity: Date.now(),
		ttlMs: 60_000,
	} as unknown as BrowserSession;
	const native = nativeFixture(behavior, delayStop);
	const api = createMemoryProfiler({
		root,
		specifiers: () => [entry],
		setup: setup ?? (async () => ({ targetId: "exact-target", detach: async () => {} })),
		limits: {
			// Startup includes async directory creation before the Worker exists, even when unready.
			startTimeoutMs: 1000,
			stopTimeoutMs: 30,
			workerCleanupTimeoutMs: 30,
			replyGraceMs: 20,
			cleanupTimeoutMs: 30,
		},
	});
	return {
		root,
		browser,
		session,
		native,
		api,
		async dispose() {
			session.memoryJob?.controller.abort();
			native.resume();
			await native.dispose();
			await session.memoryJob?.done;
			browser.emit("disconnected");
			await rm(root, { recursive: true, force: true });
		},
	};
}

function snapshotOptions(savePath = "unused") {
	return {
		targetId: "exact",
		wsEndpoint: "ws://private-canary",
		savePath,
		maxBytes: 1024,
		collectGarbage: false,
		timeoutMs: 80,
		signal: new AbortController().signal,
	};
}

describe("browser memory worker physical ownership", () => {
	test("native creation failure is sanitized and never invokes a local snapshot implementation", async () => {
		const exporter = createSnapshotExporter({
			specifiers: () => [new URL("./absent-memory-worker.ts", import.meta.url).href],
		});
		await expect(exporter({ ...snapshotOptions(), timeoutMs: 1000 })).rejects.toThrow("(startup)");
		expect(memoryDiagnosticQueue.stats.active).toBe(0);
	});

	for (const behavior of ["no-ready", "run-failure", "snapshot-success"]) {
		test(`snapshot ${behavior} retains its lane and orphan files through delayed native terminate`, async () => {
			const root = await mkdtemp(join(tmpdir(), "nf-snapshot-native-"));
			const native = nativeFixture(behavior, true);
			let cleanup: Promise<void> | undefined;
			let exited = false;
			let removals = 0;
			try {
				const exporter = createSnapshotExporter({
					specifiers: () => [entry],
					cleanupMs: 15,
					unlink: async (path) => {
						expect(exited).toBe(true);
						removals++;
						await rm(path, { force: true });
					},
				});
				const pending = exporter({
					...snapshotOptions(join(root, "heap")),
					onCleanup: (done) => {
						cleanup = done;
					},
				});
				const assertion = expect(pending).rejects.toThrow(
					behavior === "run-failure" ? "(capture)" : "(timeout)",
				);
				await until(() => native.handles.length === 1);
				void native.handles[0].exited.then(() => {
					exited = true;
				});
				await assertion;
				expect(exited).toBe(false);
				expect(memoryDiagnosticQueue.stats.active).toBe(1);
				expect(removals).toBe(0);
				await expect(exporter(snapshotOptions())).rejects.toThrow("(busy)");
				expect(native.handles).toHaveLength(1);
				if (behavior !== "no-ready")
					expect((await stat(join(root, "heap"))).size).toBeGreaterThan(0);
				native.resume();
				await cleanup;
				expect(exited).toBe(true);
				expect(memoryDiagnosticQueue.stats.active).toBe(0);
				expect(removals).toBe(behavior === "no-ready" ? 0 : 2);
				expect(await readdir(root)).toEqual([]);
			} finally {
				await native.dispose();
				await cleanup;
				await rm(root, { recursive: true, force: true });
			}
		});
	}

	test("production heap snapshot retains the real session and diagnostic reservation through native exit", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-session-snapshot-native-"));
		const native = nativeFixture("run-failure", true, true);
		const client = Object.assign(new EventEmitter(), {
			send: async () => ({ targetInfo: { targetId: "exact" } }),
			detach: async () => {},
		});
		const page = Object.assign(new EventEmitter(), {
			url: () => "data:text/html,private-canary",
			mainFrame: () => ({}),
			isClosed: () => false,
			browser: () => ({ wsEndpoint: () => "ws://private-canary" }),
			createCDPSession: async () => client,
		});
		const session = {
			id: "session-owner",
			page,
			lastActivity: Date.now(),
		} as unknown as BrowserSession;
		const path = join(root, "heap");
		try {
			// Use the production exporter and production session wiring, replacing native construction only.
			const snapshot = heapSnapshot(session, path, 1024, { timeout: 10_000 }).catch(
				(error: Error) => error,
			);
			const done = required(session.memoryJob).done;
			await until(() => native.terminating() === 1);
			expect(session.memoryJob).toBeDefined();
			expect(memoryDiagnosticQueue.stats.active).toBe(1);
			expect(() => reserveDiagnostic("profile")).toThrow("diagnostic_busy");
			expect((await stat(path)).size).toBeGreaterThan(0);
			native.resume();
			expect(((await snapshot) as Error).message).toContain("(capture)");
			await done;
			expect(session.memoryJob).toBeUndefined();
			expect(await readdir(root)).toEqual([]);
			const profile = reserveDiagnostic("profile");
			profile();
		} finally {
			await native.dispose();
			await session.memoryJob?.done;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("profiler unready timeout retains session and slot until native exit", async () => {
		const f = await profileFixture("no-ready", true);
		try {
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow("(timeout)");
			expect(f.session.memoryJob).toBeDefined();
			expect(memoryDiagnosticQueue.stats.active).toBe(1);
			expect(f.native.handles).toHaveLength(1);
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow("(busy)");
			f.native.resume();
			await f.session.memoryJob?.done;
			expect(memoryDiagnosticQueue.stats.active).toBe(0);
			expect(f.session.memoryJob).toBeUndefined();
			const lease = acquireTraceLease(f.session.page.browser(), "after-unready");
			lease.confirmStopped();
		} finally {
			await f.dispose();
		}
	});

	test("cancel response timeout cannot release session, artifacts or unconfirmed Chrome trace lease", async () => {
		const f = await profileFixture("record", true);
		try {
			const view = await f.api.startMemoryProfile(f.session);
			const done = required(f.session.memoryJob).done;
			const dirs = await readdir(f.root);
			expect(dirs).toHaveLength(1);
			const raw = join(f.root, dirs[0], "private.raw");
			await expect(cancelMemoryProfile(f.session, required(view.profileId))).rejects.toThrow(
				"(timeout)",
			);
			expect(f.native.terminating()).toBe(1);
			expect(f.session.memoryJob).toBeDefined();
			expect(memoryDiagnosticQueue.stats.active).toBe(1);
			expect((await stat(raw)).size).toBeGreaterThan(0);
			expect(() => reserveDiagnostic("snapshot")).toThrow();
			expect(() => acquireTraceLease(f.session.page.browser(), "too-early")).toThrow(
				"(trace_busy)",
			);
			const reloaded = await import(`../memory-job.ts?reload=${crypto.randomUUID()}`);
			expect(reloaded.memoryDiagnosticQueue).toBe(memoryDiagnosticQueue);
			await expect(createSnapshotExporter()(snapshotOptions())).rejects.toThrow("(busy)");
			f.native.resume();
			await done;
			expect(f.session.memoryJob).toBeUndefined();
			expect(memoryDiagnosticQueue.stats.active).toBe(0);
			expect(await readdir(f.root)).toEqual([]);
			expect(() => acquireTraceLease(f.session.page.browser(), "after-thread-exit")).toThrow(
				"(trace_uncertain)",
			);
		} finally {
			await f.dispose();
		}
	});

	for (const behavior of ["crash", "no-ack"]) {
		test(`native profiler ${behavior} fails without replay and keeps trace uncertainty`, async () => {
			const f = await profileFixture(behavior);
			try {
				const view = await f.api.startMemoryProfile(f.session);
				const done = required(f.session.memoryJob).done;
				if (behavior === "no-ack") required(f.session.memoryProfile).stop();
				await done;
				expect(f.session.memoryProfile?.view).toMatchObject({
					state: "failed",
					stage: behavior === "crash" ? "worker" : "timeout",
				});
				expect(JSON.stringify(f.session.memoryProfile?.view)).not.toContain(
					"private-worker-error-canary",
				);
				expect(view.state).toBe("recording");
				expect(f.native.handles).toHaveLength(1);
				expect(memoryDiagnosticQueue.stats.active).toBe(0);
				expect(await readdir(f.root)).toEqual([]);
				expect(() => acquireTraceLease(f.session.page.browser(), "after-failure")).toThrow(
					"(trace_uncertain)",
				);
			} finally {
				await f.dispose();
			}
		});
	}

	test("session HMR and preserve close retain the active pending startup owner", async () => {
		let attached!: (target: { targetId: string; detach(): Promise<void> }) => void;
		let detached = false;
		const f = await profileFixture(
			"record",
			false,
			() =>
				new Promise((resolve) => {
					attached = resolve;
				}),
		);
		const sessions = Reflect.get(globalThis, Symbol.for("narrafork.browser.sessions"))
			.sessions as Map<string, Map<string, BrowserSession>>;
		sessions.set(f.session.narratorId, new Map([[f.session.id, f.session]]));
		try {
			const pending = f.api.startMemoryProfile(f.session);
			const failure = pending.catch((error: Error) => error);
			await until(() => typeof attached === "function");
			const reloaded = await import(`../session.ts?reload=${crypto.randomUUID()}`);
			expect(reloaded.getAllSessionStats).not.toBe(getAllSessionStats);
			expect(reloaded.getAllSessionStats().totalSessions).toBe(1);
			expect(reloaded.getAllSessionStats()).toEqual(getAllSessionStats());
			let closed = false;
			const closing = closeAllSessions({ preserve: true }).then((count) => {
				closed = true;
				return count;
			});
			expect(((await failure) as Error).message).toContain("(cancelled)");
			expect(closed).toBe(false);
			expect(f.session.memoryJob).toBeDefined();
			expect(f.native.handles).toHaveLength(0);
			attached({
				targetId: "late",
				detach: async () => {
					detached = true;
				},
			});
			expect(await closing).toBe(1);
			expect(detached).toBe(true);
			expect(f.native.handles).toHaveLength(0);
		} finally {
			attached?.({ targetId: "late", detach: async () => {} });
			await f.dispose();
			sessions.delete(f.session.narratorId);
		}
	});

	test("legacy HMR owner without native lifetime evidence fails closed even when counters are zero", async () => {
		const key = Symbol.for("narrafork.browser.memory-workers");
		const previous = Reflect.get(globalThis, key);
		try {
			Reflect.set(globalThis, key, {
				version: 1,
				queue: memoryDiagnosticQueue,
				jobs: new Set(),
				active: 0,
			});
			await expect(import(`../memory-job.ts?legacy=${crypto.randomUUID()}`)).rejects.toThrow(
				"ownership cannot be recovered",
			);
			expect(Reflect.get(globalThis, key).active).toBe(0);
		} finally {
			Reflect.set(globalThis, key, previous);
		}
	});

	test("production close refuses new work, awaits pending setup cleanup and stays closed across HMR", async () => {
		let attached!: (target: { targetId: string; detach(): Promise<void> }) => void;
		const f = await profileFixture(
			"record",
			false,
			() =>
				new Promise((resolve) => {
					attached = resolve;
				}),
		);
		try {
			const pending = f.api.startMemoryProfile(f.session);
			const failure = pending.catch((error: Error) => error);
			await until(() => typeof attached === "function");
			let closed = false;
			const closing = closeMemoryDiagnosticWorkers();
			void closing.then(() => {
				closed = true;
			});
			expect(closeMemoryDiagnosticWorkers()).toBe(closing);
			expect(((await failure) as Error).message).toContain("(cancelled)");
			expect(closed).toBe(false);
			await expect(createSnapshotExporter()(snapshotOptions())).rejects.toThrow("(busy)");
			attached({ targetId: "late", detach: async () => {} });
			await closing;
			expect(closed).toBe(true);
			expect(f.native.handles).toHaveLength(0);
			const reloaded = await import(`../memory-job.ts?closed=${crypto.randomUUID()}`);
			expect(reloaded.closeMemoryDiagnosticWorkers()).toBe(closing);
			await expect(f.api.startMemoryProfile(f.session)).rejects.toThrow("(closing)");
			await expect(createSnapshotExporter()(snapshotOptions())).rejects.toThrow("(busy)");
			expect(memoryDiagnosticQueue.stats.active).toBe(0);
		} finally {
			attached?.({ targetId: "late", detach: async () => {} });
			await f.dispose();
		}
	});
});
