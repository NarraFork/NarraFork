import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDPSessionEvent } from "puppeteer-core";
import type { BrowserSession } from "../session";

// Import only after isolating settings/log writes from real user data. No module mocks.
const home = await mkdtemp(join(tmpdir(), "nf-memory-unit-"));
const previousHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { memoryMetrics } = await import("../memory");
const { cancelMemoryJob, runMemoryJob, waitForMemory } = await import("../memory-job");
const { MEMORY_CLEANUP_TIMEOUT_MS } = await import("../memory-constants");
// Puppeteer's public rolled-up d.ts strips this internal, real runtime symbol.
const disconnectedEvent = (CDPSessionEvent as typeof CDPSessionEvent & { Disconnected: symbol })
	.Disconnected;
afterAll(async () => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	await rm(home, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeClient extends EventEmitter {
	commands: string[] = [];
	timeouts: number[] = [];
	detaches = 0;
	heap: Record<string, number> = { usedSize: 100, totalSize: 200 };
	metrics = [
		{ name: "Documents", value: 1 },
		{ name: "Frames", value: 2 },
		{ name: "Nodes", value: 30 },
		{ name: "JSEventListeners", value: 4 },
	];
	hook?: (method: string) => Promise<void>;
	async send(method: string, _params: unknown, options: { timeout: number }) {
		this.commands.push(method);
		this.timeouts.push(options.timeout);
		await this.hook?.(method);
		if (method === "Runtime.getHeapUsage") return this.heap;
		if (method === "Performance.getMetrics") return { metrics: this.metrics };
		return {};
	}
	async detach() {
		this.detaches++;
	}
}
class FakePage extends EventEmitter {
	client = new FakeClient();
	frame = {};
	closed = false;
	creates = 0;
	pending?: Promise<FakeClient>;
	url() {
		return "data:text/html,memory-fixture";
	}
	mainFrame() {
		return this.frame;
	}
	isClosed() {
		return this.closed;
	}
	createCDPSession() {
		this.creates++;
		return this.pending ?? Promise.resolve(this.client);
	}
}
function fixture() {
	const page = new FakePage();
	const session = {
		id: "fake-memory-session",
		page,
		lastActivity: 0,
	} as unknown as BrowserSession;
	return { page, client: page.client, session };
}
function cleaned(page: FakePage, session: BrowserSession) {
	expect(session.memoryJob).toBeUndefined();
	for (const event of ["close", "error", "framenavigated"]) {
		expect(page.listenerCount(event)).toBe(0);
	}
	expect(page.client.listenerCount(disconnectedEvent)).toBe(0);
}

describe("memoryMetrics with fake page/CDP", () => {
	test("returns bounded metrics, touches session, and defaults GC off", async () => {
		const { page, client, session } = fixture();
		const result = await memoryMetrics(session);
		expect(result).toMatchObject({
			JSHeapUsedSize: 100,
			JSHeapTotalSize: 200,
			Documents: 1,
			Frames: 2,
			Nodes: 30,
			JSEventListeners: 4,
			collectGarbage: false,
			url: page.url(),
		});
		expect(Number.isFinite(Date.parse(result.timestamp))).toBe(true);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(session.lastActivity).toBeGreaterThan(0);
		expect(client.commands).toEqual([
			"Performance.enable",
			"Runtime.getHeapUsage",
			"Performance.getMetrics",
		]);
		expect(client.detaches).toBe(1);
		cleaned(page, session);
	});

	test("missing, negative and nonfinite values are null, genuine zero stays zero", async () => {
		const { client, session } = fixture();
		client.heap = { usedSize: Number.NaN };
		client.metrics = [
			{ name: "Documents", value: 0 },
			{ name: "Nodes", value: -1 },
			{ name: "Frames", value: Number.POSITIVE_INFINITY },
		];
		expect(await memoryMetrics(session)).toMatchObject({
			JSHeapUsedSize: null,
			JSHeapTotalSize: null,
			Documents: 0,
			Frames: null,
			Nodes: null,
			JSEventListeners: null,
		});
	});

	test("explicit GC occurs before metrics commands", async () => {
		const { client, session } = fixture();
		expect((await memoryMetrics(session, { collectGarbage: true })).collectGarbage).toBe(true);
		expect(client.commands).toEqual([
			"HeapProfiler.collectGarbage",
			"Performance.enable",
			"Runtime.getHeapUsage",
			"Performance.getMetrics",
		]);
	});

	test("one deadline covers all commands, with decreasing CDP budgets", async () => {
		const { page, client, session } = fixture();
		client.hook = async () => {
			await Bun.sleep(35);
		};
		const started = Date.now();
		await expect(memoryMetrics(session, { collectGarbage: true, timeout: 80 })).rejects.toThrow(
			"timed out",
		);
		expect(Date.now() - started).toBeLessThan(500);
		expect(client.commands).not.toContain("Performance.getMetrics");
		expect(client.timeouts[1]).toBeLessThan(client.timeouts[0] ?? 0);
		cleaned(page, session);
	});

	test("abort during a pending command releases lock and permits subsequent sampling", async () => {
		const { page, client, session } = fixture();
		const waiting = deferred<void>();
		client.hook = () => waiting.promise;
		const controller = new AbortController();
		const operation = memoryMetrics(session, { signal: controller.signal });
		await Bun.sleep(0);
		controller.abort();
		await expect(operation).rejects.toThrow("cancelled");
		cleaned(page, session);
		waiting.reject(new Error("late protocol rejection"));
		client.hook = undefined;
		expect((await memoryMetrics(session)).JSHeapUsedSize).toBe(100);
	});

	test("already aborted signal allocates no CDP session", async () => {
		const { page, session } = fixture();
		await expect(
			memoryMetrics(session, { signal: AbortSignal.abort(new Error("stop")) }),
		).rejects.toThrow("stop");
		expect(page.creates).toBe(0);
		cleaned(page, session);
	});

	test("busy session rejects immediately; protocol failure sanitizes and restores admission", async () => {
		const { page, client, session } = fixture();
		const waiting = deferred<void>();
		client.hook = () => waiting.promise;
		const first = memoryMetrics(session);
		await Bun.sleep(0);
		await expect(memoryMetrics(session)).rejects.toThrow("already active");
		expect(page.creates).toBe(1);
		waiting.reject(new Error("secret ws://credentials"));
		await expect(first).rejects.toThrow("failed during metrics");
		cleaned(page, session);
		client.hook = undefined;
		await memoryMetrics(session);
	});

	test("late CDP creation after timeout is detached without leaked listeners", async () => {
		const { page, client, session } = fixture();
		const pending = deferred<FakeClient>();
		page.pending = pending.promise;
		await expect(memoryMetrics(session, { timeout: 25 })).rejects.toThrow("timed out");
		cleaned(page, session);
		expect(client.detaches).toBe(0);
		pending.resolve(client);
		await Bun.sleep(0);
		expect(client.detaches).toBe(1);
	});

	for (const event of ["Disconnected", "close", "error", "framenavigated"] as const) {
		test(`${event} cancels pending sampling and removes temporary listeners`, async () => {
			const { page, client, session } = fixture();
			const waiting = deferred<void>();
			client.hook = () => waiting.promise;
			const operation = memoryMetrics(session);
			await Bun.sleep(0);
			if (event === "Disconnected") {
				expect(typeof disconnectedEvent).toBe("symbol");
				client.emit(disconnectedEvent);
			} else page.emit(event, page.frame);
			await expect(operation).rejects.toThrow(
				event === "framenavigated"
					? "navigated"
					: event === "Disconnected"
						? "disconnected"
						: "closed",
			);
			waiting.resolve();
			cleaned(page, session);
		});
	}

	test("already closed page fails before creating a CDP resource", async () => {
		const { page, session } = fixture();
		page.closed = true;
		await expect(memoryMetrics(session)).rejects.toThrow("closed");
		expect(page.creates).toBe(0);
		cleaned(page, session);
	});

	test("subframe navigation does not cancel the main target", async () => {
		const { page, client, session } = fixture();
		client.hook = async () => {
			page.emit("framenavigated", {});
		};
		await memoryMetrics(session);
		cleaned(page, session);
	});
});

describe("memory job lifecycle", () => {
	test("cancel waits for cleanup completion, marks closed and rejects new jobs", async () => {
		const { session } = fixture();
		const cleanup = deferred<void>();
		const operation = runMemoryJob(session, 1_000, undefined, async (signal) => {
			try {
				await waitForMemory(new Promise<void>(() => {}), signal);
			} finally {
				await cleanup.promise;
			}
		});
		const rejection = operation.then(
			() => new Error("Expected cancellation"),
			(error: unknown) => error,
		);
		const done = session.memoryJob?.done;
		let cancelled = false;
		const cancellation = cancelMemoryJob(session).then(() => {
			cancelled = true;
		});
		await Bun.sleep(0);
		expect(cancelled).toBe(false);
		expect(session.memoryDiagnosticsClosed).toBe(true);
		await expect(runMemoryJob(session, 100, undefined, async () => 1)).rejects.toThrow("closing");
		cleanup.resolve();
		await Promise.all([cancellation, done]);
		expect(String(await rejection)).toContain("session closed");
		expect(session.memoryJob).toBeUndefined();
	});

	test(
		"cancellation of an uncooperative job is bounded",
		async () => {
			const { session } = fixture();
			const pending = deferred<void>();
			const operation = runMemoryJob(session, 10_000, undefined, () => pending.promise);
			const start = Date.now();
			await cancelMemoryJob(session);
			expect(Date.now() - start).toBeLessThan(MEMORY_CLEANUP_TIMEOUT_MS + 1_000);
			expect(session.memoryJob?.controller.signal.aborted).toBe(true);
			pending.resolve();
			await operation;
			expect(session.memoryJob).toBeUndefined();
		},
		MEMORY_CLEANUP_TIMEOUT_MS + 3_000,
	);

	test("no-job cancellation is idempotent and timeout releases a cooperative job", async () => {
		const { session } = fixture();
		await expect(
			runMemoryJob(session, 20, undefined, (signal) =>
				waitForMemory(new Promise<void>(() => {}), signal),
			),
		).rejects.toThrow("timed out");
		expect(session.memoryJob).toBeUndefined();
		await cancelMemoryJob(session);
		await cancelMemoryJob(session);
		expect(session.memoryDiagnosticsClosed).toBe(true);
	});
});
