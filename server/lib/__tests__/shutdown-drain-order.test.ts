import { describe, expect, test } from "bun:test";
import {
	drainShutdownEffects,
	runShutdownDatabaseTail,
	ShutdownActivityTracker,
	shutdownStep,
	waitForShutdownWork,
} from "../shutdown-activity";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	const tracker = new ShutdownActivityTracker();
	tracker.markDrainComplete();
	const order: string[] = [];
	const hooks = {
		drainProducers: async (_signal: AbortSignal) => {
			order.push("producers");
		},
		drainEffects: async (_signal: AbortSignal) => {
			order.push("effects");
		},
		teardown: async () => {
			order.push("teardown");
		},
		closeProjects: async () => {
			order.push("projects");
		},
		drainReadPool: async () => {
			order.push("pool");
		},
		forceReadPool: () => {
			order.push("force");
		},
		closeDatabase: async () => {
			order.push("database");
		},
	};
	return { tracker, order, hooks };
}

describe("shutdown database drain order", () => {
	test("final tool result and derived effects finish before pool teardown", async () => {
		const { tracker, order, hooks } = fixture();
		const toolResult = deferred();
		const event = deferred();
		const entered = deferred();
		hooks.drainProducers = async (signal) => {
			entered.resolve();
			await waitForShutdownWork(toolResult.promise, signal);
			order.push("tool_result read");
		};
		hooks.drainEffects = async (signal) => {
			await waitForShutdownWork(event.promise, signal);
			order.push("derived event read");
		};
		const shutdown = runShutdownDatabaseTail(tracker, hooks);
		await entered.promise;
		expect(order).toEqual([]);
		toolResult.resolve();
		await toolResult.promise;
		expect(order).not.toContain("pool");
		event.resolve();
		await shutdown;
		expect(order).toEqual([
			"tool_result read",
			"derived event read",
			"teardown",
			"derived event read",
			"projects",
			"pool",
			"database",
		]);
		expect(tracker.isCleanShutdown()).toBe(true);
	});

	test("joint drain rechecks work spawned into an earlier collection", async () => {
		let pending = 0;
		let passes = 0;
		await drainShutdownEffects(
			[
				{
					drain: async () => {
						pending = 0;
						passes++;
					},
					state: () => ({ pending, failureCount: 0 }),
				},
				{
					drain: async () => {
						if (passes === 1) pending++;
					},
					state: () => ({ pending: 0, failureCount: 0 }),
				},
			],
			new AbortController().signal,
		);
		expect(passes).toBe(2);
	});

	test("producer failure and forced pool exit cannot certify clean shutdown", async () => {
		const { tracker, hooks, order } = fixture();
		hooks.drainProducers = async () => {
			throw new Error("persist failed");
		};
		hooks.drainReadPool = async () => {
			throw new Error("worker stuck");
		};
		await runShutdownDatabaseTail(tracker, hooks);
		expect(order).toContain("force");
		expect(tracker.isCleanShutdown()).toBe(false);
	});

	test("timeout aborts the drain loop and remains degraded", async () => {
		const tracker = new ShutdownActivityTracker();
		tracker.markDrainComplete();
		const never = deferred();
		let stopped = false;
		const outcome = await shutdownStep(
			tracker,
			"effects",
			async (signal) => {
				try {
					await waitForShutdownWork(never.promise, signal);
				} finally {
					stopped = true;
				}
			},
			5,
		);
		await Promise.resolve();
		expect(outcome).toBe("timeout");
		expect(stopped).toBe(true);
		expect(tracker.isCleanShutdown()).toBe(false);
	});

	test("a timed out pool uses the forced exit and still closes the runtime dirty", async () => {
		const { tracker, hooks, order } = fixture();
		const pool = deferred();
		hooks.drainReadPool = () => pool.promise;
		hooks.forceReadPool = () => {
			order.push("force");
			pool.resolve();
		};
		await runShutdownDatabaseTail(tracker, hooks, (t, label, fn) => shutdownStep(t, label, fn, 5));
		expect(order.slice(-2)).toEqual(["force", "database"]);
		expect(tracker.summary().degradedSteps).toEqual([
			{ label: "dbWorkerPool.drain", outcome: "timeout" },
		]);
		expect(tracker.isCleanShutdown()).toBe(false);
	});

	test("failed teardown cannot bypass the pool and runtime cleanup", async () => {
		const { tracker, hooks, order } = fixture();
		hooks.teardown = async () => {
			throw new Error("teardown failed");
		};
		await runShutdownDatabaseTail(tracker, hooks);
		expect(order.slice(-3)).toEqual(["projects", "pool", "database"]);
		expect(tracker.isCleanShutdown()).toBe(false);
	});

	test("listener failure is surfaced even with no pending work", async () => {
		await expect(
			drainShutdownEffects(
				[
					{
						drain: async () => {},
						state: () => ({
							pending: 0,
							failureCount: 1,
							firstError: new Error("listener failed"),
						}),
					},
				],
				new AbortController().signal,
			),
		).rejects.toThrow("listener failed");
	});
});
