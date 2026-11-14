import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	type PoolWorker,
	WorkerPool,
	type WorkerPoolOptions,
	type WorkerTaskContext,
	type WorkerTaskTiming,
} from "./pool";

const gates = new Set<() => void>();
const pools = new Set<{ close(): Promise<void> }>();
const requests = new Set<Promise<unknown>>();

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	gates.add(open);
	return { promise, open };
}

function observed<T>(promise: Promise<T>): Promise<T> {
	requests.add(promise);
	void promise.catch(() => {});
	return promise;
}

function aborted(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

class FakeWorker implements PoolWorker<number, string> {
	closed = false;
	stopped = false;
	closeCalls = 0;
	readonly closeStarted = gate();
	readonly runs: { request: number; context: WorkerTaskContext }[] = [];
	onRun?: (request: number, context: WorkerTaskContext) => Promise<string>;
	onClose?: () => Promise<void>;
	private closing?: Promise<void>;

	constructor(readonly id: number) {}

	async run(request: number, context: WorkerTaskContext): Promise<string> {
		this.runs.push({ request, context });
		if (this.closed) throw new Error("Dispatch to a closed worker");
		return this.onRun ? this.onRun(request, context) : `${this.id}:${request}`;
	}

	close(): Promise<void> {
		this.closeCalls++;
		if (this.closing) return this.closing;
		this.closed = true;
		this.closeStarted.open();
		this.closing = Promise.resolve()
			.then(() => this.onClose?.())
			.then(() => {
				this.stopped = true;
			});
		return this.closing;
	}
}

type TestOptions = Partial<Omit<WorkerPoolOptions<number, string>, "create">> & {
	create?: (context: WorkerTaskContext, id: number) => Promise<FakeWorker>;
};

function setup(options: TestOptions = {}) {
	const workers: FakeWorker[] = [];
	let createCalls = 0;
	const pool = new WorkerPool<number, string>({
		concurrency: 1,
		...options,
		create: async (context) => {
			const id = ++createCalls;
			const worker = options.create ? await options.create(context, id) : new FakeWorker(id);
			workers.push(worker);
			return worker;
		},
	});
	pools.add(pool);
	return {
		pool,
		workers,
		get createCalls() {
			return createCalls;
		},
	};
}

afterEach(async () => {
	for (const open of gates) open();
	await Promise.allSettled([...pools].map((pool) => pool.close()));
	await Promise.allSettled([...requests]);
	gates.clear();
	pools.clear();
	requests.clear();
});

describe("WorkerPool reuse and admission", () => {
	test("sequential jobs reuse one worker", async () => {
		const { pool, workers } = setup();
		await expect(pool.run(1)).resolves.toBe("1:1");
		await expect(pool.run(2)).resolves.toBe("1:2");
		expect(workers).toHaveLength(1);
		expect(workers[0]?.runs.map((run) => run.request)).toEqual([1, 2]);
		expect(workers[0]?.closeCalls).toBe(0);
		expect(pool.stats).toMatchObject({ active: 0, workers: 1, idle: 1, created: 1, reused: 1 });
	});

	test("concurrent jobs claim different workers and a third job waits", async () => {
		const entered = [gate(), gate()];
		const finish = gate();
		const fixture = setup({
			concurrency: 2,
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = async (request) => {
					entered[id - 1]?.open();
					await finish.promise;
					return `${id}:${request}`;
				};
				return worker;
			},
		});
		const first = observed(fixture.pool.run(1));
		const second = observed(fixture.pool.run(2));
		const third = observed(fixture.pool.run(3));
		await Promise.all(entered.map((entry) => entry.promise));
		expect(fixture.createCalls).toBe(2);
		expect(fixture.workers.map((worker) => worker.runs.length)).toEqual([1, 1]);
		expect(fixture.pool.stats).toMatchObject({ active: 2, queued: 1, workers: 2 });
		finish.open();
		await Promise.all([first, second, third]);
		expect(fixture.createCalls).toBe(2);
		expect(fixture.workers.reduce((sum, worker) => sum + worker.runs.length, 0)).toBe(3);
	});

	test("starting workers reserve capacity before becoming ready", async () => {
		const starting = [gate(), gate()];
		const ready = gate();
		const fixture = setup({
			concurrency: 2,
			create: async (_context, id) => {
				starting[id - 1]?.open();
				await ready.promise;
				return new FakeWorker(id);
			},
		});
		const pending = [1, 2, 3, 4].map((n) => observed(fixture.pool.run(n)));
		await Promise.all(starting.map((entry) => entry.promise));
		expect(fixture.createCalls).toBe(2);
		expect(fixture.pool.stats).toMatchObject({ active: 2, starting: 2, workers: 0, queued: 2 });
		ready.open();
		await Promise.all(pending);
		expect(fixture.createCalls).toBe(2);
	});

	test("queue byte limits and queued cancellation do not close active workers", async () => {
		const entered = gate();
		const finish = gate();
		const fixture = setup({
			maxQueuedBytes: 4,
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = async (request) => {
					entered.open();
					await finish.promise;
					return `${id}:${request}`;
				};
				return worker;
			},
		});
		const active = observed(fixture.pool.run(1));
		await entered.promise;
		const controller = new AbortController();
		const waiting = observed(fixture.pool.run(2, { signal: controller.signal, bytes: 4 }));
		await expect(fixture.pool.run(3, { bytes: 1 })).rejects.toMatchObject({
			code: "TASK_QUEUE_FULL",
		});
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.workers[0]?.closeCalls).toBe(0);
		expect(fixture.pool.stats.queuedBytes).toBe(0);
		finish.open();
		await active;
	});

	test("one-shot workers really exit before another job can start", async () => {
		const exit = gate();
		const firstWorker = new FakeWorker(1);
		firstWorker.onClose = () => exit.promise;
		const fixture = setup({
			reuse: false,
			create: async (_context, id) => (id === 1 ? firstWorker : new FakeWorker(id)),
		});
		const first = observed(fixture.pool.run(1));
		const second = observed(fixture.pool.run(2));
		await firstWorker.closeStarted.promise;
		expect(fixture.createCalls).toBe(1);
		expect(fixture.pool.stats).toMatchObject({ active: 1, queued: 1, workers: 1, retiring: 1 });
		exit.open();
		await expect(first).resolves.toBe("1:1");
		await expect(second).resolves.toBe("2:2");
		expect(fixture.workers.every((worker) => worker.stopped && worker.closeCalls === 1)).toBe(true);
		expect(fixture.pool.stats.workers).toBe(0);
	});
});

describe("WorkerPool warmup", () => {
	test("concurrent warmup calls share one startup and do not dispatch work", async () => {
		const entered = gate();
		const ready = gate();
		const fixture = setup({
			concurrency: 2,
			create: async (_context, id) => {
				entered.open();
				await ready.promise;
				return new FakeWorker(id);
			},
		});
		const first = observed(fixture.pool.warmup());
		const second = observed(fixture.pool.warmup());
		expect(second).toBe(first);
		await entered.promise;
		expect(fixture.createCalls).toBe(1);
		ready.open();
		await first;
		expect(fixture.workers[0]?.runs).toHaveLength(0);
		await expect(fixture.pool.run(7)).resolves.toBe("1:7");
		expect(fixture.createCalls).toBe(1);
	});

	test("warmup does not join a busy pool's real task queue", async () => {
		const entered = gate();
		const finish = gate();
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = async () => {
					entered.open();
					await finish.promise;
					return "done";
				};
				return worker;
			},
		});
		const active = observed(fixture.pool.run(1));
		await entered.promise;
		const queued = observed(fixture.pool.run(2));
		await fixture.pool.warmup();
		expect(fixture.pool.stats.queued).toBe(1);
		expect(fixture.createCalls).toBe(1);
		finish.open();
		await Promise.all([active, queued]);
	});

	test("one-shot pools do not create workers for warmup", async () => {
		const fixture = setup({ reuse: false });
		await fixture.pool.warmup();
		expect(fixture.createCalls).toBe(0);
	});

	test("failed warmup is not cached forever or retried as a business task", async () => {
		const failure = new Error("startup failed");
		const fixture = setup({
			create: async (_context, id) => {
				if (id === 1) throw failure;
				return new FakeWorker(id);
			},
		});
		await expect(fixture.pool.warmup()).rejects.toBe(failure);
		expect(fixture.createCalls).toBe(1);
		await fixture.pool.warmup();
		expect(fixture.createCalls).toBe(2);
		expect(fixture.workers[0]?.runs).toHaveLength(0);
	});
});

describe("WorkerPool failures and deadlines", () => {
	test("a domain validation rejection keeps a healthy worker reusable", async () => {
		const validation = new Error("selection stale");
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = async (request) => {
					if (request === 1) throw validation;
					return `${id}:${request}`;
				};
				return worker;
			},
		});
		await expect(fixture.pool.run(1)).rejects.toBe(validation);
		await expect(fixture.pool.run(2)).resolves.toBe("1:2");
		expect(fixture.createCalls).toBe(1);
		expect(fixture.workers[0]?.closeCalls).toBe(0);
	});

	test("transport failure retires its worker without replaying the dispatched job", async () => {
		const failure = new Error("transport failed");
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = async (request) => {
					if (id === 1) {
						worker.closed = true;
						throw failure;
					}
					return `${id}:${request}`;
				};
				return worker;
			},
		});
		await expect(fixture.pool.run(1)).rejects.toBe(failure);
		expect(fixture.createCalls).toBe(1);
		expect(fixture.workers[0]?.runs.map((run) => run.request)).toEqual([1]);
		expect(fixture.workers[0]?.stopped).toBe(true);
		await expect(fixture.pool.run(2)).resolves.toBe("2:2");
	});

	test("failed startup releases admission but is not retried inside the call", async () => {
		const failure = new Error("no worker entry");
		const fixture = setup({
			create: async (_context, id) => {
				if (id === 1) throw failure;
				return new FakeWorker(id);
			},
		});
		await expect(fixture.pool.run(1)).rejects.toBe(failure);
		expect(fixture.createCalls).toBe(1);
		expect(fixture.pool.stats).toMatchObject({ active: 0, starting: 0, workers: 0 });
		await expect(fixture.pool.run(2)).resolves.toBe("2:2");
	});

	test("a factory returning an unusable worker cannot dispatch", async () => {
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.closed = true;
				return worker;
			},
		});
		await expect(fixture.pool.run(1)).rejects.toMatchObject({ code: "WORKER_POOL_UNAVAILABLE" });
		expect(fixture.createCalls).toBe(1);
		expect(fixture.workers[0]?.runs).toHaveLength(0);
		expect(fixture.workers[0]?.stopped).toBe(true);
	});

	test("cancellation before admission creates no worker", async () => {
		const fixture = setup();
		const reason = new Error("already cancelled");
		await expect(fixture.pool.run(1, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
		expect(fixture.createCalls).toBe(0);
		expect(fixture.pool.stats.active).toBe(0);
	});

	test("cancelling an uncooperative run stops its worker and waits for actual exit", async () => {
		const entered = gate();
		const exit = gate();
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				if (id === 1) {
					worker.onRun = () => {
						entered.open();
						return new Promise<string>(() => {});
					};
					worker.onClose = () => exit.promise;
				}
				return worker;
			},
		});
		const controller = new AbortController();
		const active = observed(fixture.pool.run(1, { signal: controller.signal }));
		await entered.promise;
		const next = observed(fixture.pool.run(2));
		const reason = new Error("caller cancelled");
		controller.abort(reason);
		const worker = fixture.workers[0];
		if (!worker) throw new Error("worker was not created");
		await worker.closeStarted.promise;
		expect(fixture.createCalls).toBe(1);
		expect(fixture.pool.stats).toMatchObject({ active: 1, queued: 1, retiring: 1 });
		expect(worker.stopped).toBe(false);
		exit.open();
		await expect(active).rejects.toBe(reason);
		await expect(next).resolves.toBe("2:2");
		expect(worker.closeCalls).toBe(1);
	});

	test("a late result from a retired task cannot settle a later request", async () => {
		const entered = gate();
		let deliverLate!: (value: string) => void;
		const late = new Promise<string>((resolve) => {
			deliverLate = resolve;
		});
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				if (id === 1)
					worker.onRun = () => {
						entered.open();
						return late;
					};
				return worker;
			},
		});
		const controller = new AbortController();
		const first = observed(fixture.pool.run(1, { signal: controller.signal }));
		await entered.promise;
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(fixture.pool.run(2)).resolves.toBe("2:2");
		deliverLate("stale result");
		await expect(fixture.pool.run(3)).resolves.toBe("2:3");
		expect(fixture.createCalls).toBe(2);
		expect(fixture.workers[0]?.stopped).toBe(true);
	});

	test("startup cancellation waits for the factory's cleanup", async () => {
		const entered = gate();
		const exit = gate();
		const fixture = setup({
			create: async (context, id) => {
				const worker = new FakeWorker(id);
				if (id !== 1) return worker;
				worker.onClose = () => exit.promise;
				entered.open();
				try {
					await aborted(context.signal);
				} finally {
					await worker.close();
				}
				return worker;
			},
		});
		const controller = new AbortController();
		const first = observed(fixture.pool.run(1, { signal: controller.signal }));
		await entered.promise;
		const next = observed(fixture.pool.run(2));
		controller.abort();
		// A cancelled factory remains the owner of its not-yet-ready resource.
		await Promise.resolve();
		expect(fixture.pool.stats).toMatchObject({ active: 1, starting: 1, queued: 1 });
		expect(fixture.createCalls).toBe(1);
		exit.open();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(next).resolves.toBe("2:2");
	});

	test("a worker becoming ready after cancellation is closed without running", async () => {
		const entered = gate();
		const ready = gate();
		const exit = gate();
		const lateWorker = new FakeWorker(1);
		lateWorker.onClose = () => exit.promise;
		const fixture = setup({
			create: async () => {
				entered.open();
				await ready.promise;
				return lateWorker;
			},
		});
		const controller = new AbortController();
		const first = observed(fixture.pool.run(1, { signal: controller.signal }));
		await entered.promise;
		controller.abort();
		ready.open();
		await lateWorker.closeStarted.promise;
		expect(lateWorker.runs).toHaveLength(0);
		expect(fixture.pool.stats.starting).toBe(0);
		exit.open();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(lateWorker.stopped).toBe(true);
	});

	test("execution deadline stops a hung worker, not just the response promise", async () => {
		const entered = gate();
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = () => {
					entered.open();
					return new Promise<string>(() => {});
				};
				return worker;
			},
		});
		const result = observed(fixture.pool.run(1, { deadlineAt: Date.now() + 50 }));
		await entered.promise;
		await expect(result).rejects.toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
		expect(fixture.workers[0]?.stopped).toBe(true);
		expect(fixture.pool.stats.active).toBe(0);
	});

	test("the original deadline reaches startup and execution unchanged", async () => {
		const seen: WorkerTaskContext[] = [];
		const fixture = setup({
			create: async (context, id) => {
				seen.push(context);
				const worker = new FakeWorker(id);
				worker.onRun = async (_request, running) => {
					seen.push(running);
					return "done";
				};
				return worker;
			},
		});
		const deadlineAt = Date.now() + 5_000;
		await fixture.pool.run(1, { deadlineAt });
		expect(seen.map((context) => context.deadlineAt)).toEqual([deadlineAt, deadlineAt]);
		expect(seen[0]?.signal).toBe(seen[1]?.signal);
	});

	test("an expired budget after readiness cannot dispatch a task", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const fixture = setup({
				create: async (_context, id) => {
					now += 1_001;
					return new FakeWorker(id);
				},
			});
			await expect(fixture.pool.run(1, { deadlineAt: now + 1_000 })).rejects.toMatchObject({
				code: "TASK_QUEUE_TIMEOUT",
			});
			expect(fixture.workers[0]?.runs).toHaveLength(0);
			expect(fixture.workers[0]?.stopped).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("WorkerPool retirement and shutdown", () => {
	test("idle retirement must finish before its worker can be replaced", async () => {
		const exit = gate();
		const fixture = setup({
			idleTimeoutMs: 15,
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				if (id === 1) worker.onClose = () => exit.promise;
				return worker;
			},
		});
		await fixture.pool.run(1);
		const worker = fixture.workers[0];
		if (!worker) throw new Error("worker was not created");
		await worker.closeStarted.promise;
		const next = observed(fixture.pool.run(2));
		await Promise.resolve();
		expect(fixture.createCalls).toBe(1);
		expect(fixture.pool.stats).toMatchObject({ workers: 1, retiring: 1, starting: 0 });
		exit.open();
		await expect(next).resolves.toBe("2:2");
		expect(worker.stopped).toBe(true);
	});

	test("a dead idle worker is not borrowed for another task", async () => {
		const fixture = setup();
		await fixture.pool.run(1);
		const worker = fixture.workers[0];
		if (!worker) throw new Error("worker was not created");
		worker.closed = true;
		await expect(fixture.pool.run(2)).resolves.toBe("2:2");
		expect(worker.runs).toHaveLength(1);
		expect(worker.closeCalls).toBe(1);
	});

	test("an unsuccessful close is not freed capacity", async () => {
		const failure = new Error("exit could not be confirmed");
		const fixture = setup({
			idleTimeoutMs: 15,
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onClose = async () => {
					throw failure;
				};
				return worker;
			},
		});
		await fixture.pool.run(1);
		const worker = fixture.workers[0];
		if (!worker) throw new Error("worker was not created");
		await worker.closeStarted.promise;
		await expect(fixture.pool.run(2)).rejects.toBe(failure);
		expect(fixture.createCalls).toBe(1);
		expect(fixture.pool.stats).toMatchObject({ workers: 1, retiring: 1, active: 0 });
		await expect(fixture.pool.close()).rejects.toBe(failure);
		expect(worker.closeCalls).toBe(1);
	});

	test("close rejects waiters and cancels active work without dispatching queued tasks", async () => {
		const entered = gate();
		const exit = gate();
		const fixture = setup({
			create: async (_context, id) => {
				const worker = new FakeWorker(id);
				worker.onRun = () => {
					entered.open();
					return new Promise<string>(() => {});
				};
				worker.onClose = () => exit.promise;
				return worker;
			},
		});
		const active = observed(fixture.pool.run(1));
		await entered.promise;
		const waiting = observed(fixture.pool.run(2));
		const closing = observed(fixture.pool.close());
		expect(fixture.pool.close()).toBe(closing);
		await expect(waiting).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
		await expect(fixture.pool.run(3)).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
		await expect(fixture.pool.warmup()).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
		expect(fixture.createCalls).toBe(1);
		expect(fixture.pool.stats).toMatchObject({ active: 1, queued: 0, closed: true });
		exit.open();
		await expect(active).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
		await closing;
		expect(fixture.pool.stats.workers).toBe(0);
		expect(fixture.workers[0]?.runs.map((run) => run.request)).toEqual([1]);
		expect(fixture.workers[0]?.closeCalls).toBe(1);
	});

	test("close owns workers that become ready after shutdown starts", async () => {
		const entered = gate();
		const ready = gate();
		const fixture = setup({
			create: async (_context, id) => {
				entered.open();
				await ready.promise;
				return new FakeWorker(id);
			},
		});
		const result = observed(fixture.pool.run(1));
		await entered.promise;
		const closing = observed(fixture.pool.close());
		expect(fixture.pool.stats.starting).toBe(1);
		ready.open();
		await expect(result).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
		await closing;
		expect(fixture.workers[0]?.stopped).toBe(true);
		expect(fixture.workers[0]?.runs).toHaveLength(0);
		expect(fixture.pool.stats).toMatchObject({ workers: 0, starting: 0, active: 0 });
	});

	test("late startup cleanup failures cannot make shutdown look successful", async () => {
		const entered = gate();
		const ready = gate();
		const failure = new Error("late worker is not stopped");
		const fixture = setup({
			create: async (_context, id) => {
				entered.open();
				await ready.promise;
				const worker = new FakeWorker(id);
				worker.onClose = async () => {
					throw failure;
				};
				return worker;
			},
		});
		const result = observed(fixture.pool.run(1));
		await entered.promise;
		const closing = observed(fixture.pool.close());
		ready.open();
		await expect(result).rejects.toBe(failure);
		await expect(closing).rejects.toBe(failure);
		expect(fixture.pool.stats.workers).toBe(1);
	});

	test("finished jobs detach their caller's abort listener", async () => {
		const fixture = setup();
		const controller = new AbortController();
		await fixture.pool.run(1, { signal: controller.signal });
		const oldContext = fixture.workers[0]?.runs[0]?.context;
		controller.abort();
		expect(oldContext?.signal.aborted).toBe(false);
		await expect(fixture.pool.run(2)).resolves.toBe("1:2");
		expect(fixture.workers[0]?.closeCalls).toBe(0);
	});

	test("an empty pool closes without creating a worker", async () => {
		const fixture = setup();
		await fixture.pool.close();
		expect(fixture.createCalls).toBe(0);
		await expect(fixture.pool.run(1)).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
	});
});

for (const idleTimeoutMs of [0, -1, 0.5, Number.NaN, 2_147_483_648]) {
	test(`rejects an invalid idle TTL ${idleTimeoutMs}`, () => {
		expect(() => setup({ idleTimeoutMs })).toThrow(RangeError);
	});
}

describe("WorkerPool fixed diagnostics", () => {
	test("separates queue, ready, execution and confirmed-close phases", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const finishClose = gate();
		const worker = new FakeWorker(1);
		const timings: Readonly<WorkerTaskTiming>[] = [];
		worker.onRun = async () => {
			now += 20;
			return "complete";
		};
		worker.onClose = async () => {
			now += 30;
			await finishClose.promise;
		};
		const { pool } = setup({
			reuse: false,
			create: async () => {
				now += 10;
				return worker;
			},
			onTaskComplete: (timing) => timings.push(timing),
		});
		try {
			const result = observed(pool.run(1, { requestId: "existing-rpc-id" }));
			await worker.closeStarted.promise;
			expect(timings).toEqual([]);
			expect(pool.stats).toMatchObject({ active: 1, retiring: 1, failed: 0 });
			finishClose.open();
			expect(await result).toBe("complete");
			expect(timings).toEqual([
				{
					requestId: "existing-rpc-id",
					kind: "task",
					outcome: "ok",
					reused: false,
					queueMs: 0,
					readyMs: 10,
					execMs: 20,
					closeMs: 30,
					totalMs: 60,
				},
			]);
			expect(worker.runs[0]?.context.requestId).toBe("existing-rpc-id");
		} finally {
			finishClose.open();
			clock.mockRestore();
		}
	});

	test("records waiting separately from reused-worker execution", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const started = gate();
		const finish = gate();
		const timings: Readonly<WorkerTaskTiming>[] = [];
		const { pool, workers } = setup({ onTaskComplete: (timing) => timings.push(timing) });
		try {
			await pool.warmup();
			timings.length = 0;
			workers[0].onRun = async (request) => {
				if (request === 1) {
					started.open();
					await finish.promise;
				}
				return String(request);
			};
			const first = observed(pool.run(1, { requestId: "first" }));
			await started.promise;
			now = 10;
			const second = observed(pool.run(2, { requestId: "second" }));
			now = 25;
			finish.open();
			await first;
			await second;
			expect(timings.find((timing) => timing.requestId === "second")).toMatchObject({
				reused: true,
				queueMs: 15,
				readyMs: 0,
				execMs: 0,
				closeMs: 0,
				totalMs: 15,
			});
			expect(pool.stats).toMatchObject({ created: 1, reused: 2, failed: 0 });
		} finally {
			finish.open();
			clock.mockRestore();
		}
	});

	test("the next worker's startup is not charged to the previous worker's close", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const started = gate();
		const finish = gate();
		const timings: Readonly<WorkerTaskTiming>[] = [];
		const { pool } = setup({
			reuse: false,
			create: async (_context, id) => {
				now += 10;
				const worker = new FakeWorker(id);
				worker.onRun = async (request) => {
					if (request === 1) {
						started.open();
						await finish.promise;
					}
					now += 20;
					return String(request);
				};
				worker.onClose = async () => {
					now += 30;
				};
				return worker;
			},
			onTaskComplete: (timing) => timings.push(timing),
		});
		try {
			const first = observed(pool.run(1, { requestId: "first" }));
			await started.promise;
			const second = observed(pool.run(2, { requestId: "second" }));
			finish.open();
			await first;
			await second;
			expect(timings.find((timing) => timing.requestId === "first")).toMatchObject({
				queueMs: 0,
				readyMs: 10,
				execMs: 20,
				closeMs: 30,
			});
			expect(timings.find((timing) => timing.requestId === "second")).toMatchObject({
				queueMs: 50,
				readyMs: 10,
				execMs: 20,
				closeMs: 30,
			});
		} finally {
			finish.open();
			clock.mockRestore();
		}
	});
	test("cancellation at readiness records actual cleanup as close, without dispatch", async () => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const creating = gate();
		const ready = gate();
		const controller = new AbortController();
		const reason = new Error("cancel before dispatch");
		const worker = new FakeWorker(1);
		const timings: Readonly<WorkerTaskTiming>[] = [];
		worker.onClose = async () => {
			now += 30;
		};
		const { pool } = setup({
			create: async () => {
				creating.open();
				await ready.promise;
				now = 20;
				return worker;
			},
			onTaskComplete: (timing) => timings.push(timing),
		});
		try {
			const result = observed(pool.run(1, { signal: controller.signal }));
			await creating.promise;
			controller.abort(reason);
			ready.open();
			await expect(result).rejects.toBe(reason);
			expect(worker.runs).toHaveLength(0);
			expect(worker.stopped).toBe(true);
			expect(timings[0]).toMatchObject({
				outcome: "error",
				readyMs: 20,
				execMs: 0,
				closeMs: 30,
				totalMs: 50,
			});
		} finally {
			ready.open();
			clock.mockRestore();
		}
	});
	test("coalesced warmup failure is counted and reported once", async () => {
		const failure = new Error("startup failed");
		const timings: Readonly<WorkerTaskTiming>[] = [];
		const { pool } = setup({
			create: async (_context, id) => {
				if (id === 1) throw failure;
				return new FakeWorker(id);
			},
			onTaskComplete: (timing) => timings.push(timing),
		});
		const first = observed(pool.warmup());
		expect(pool.warmup()).toBe(first);
		await expect(first).rejects.toBe(failure);
		expect(pool.stats).toMatchObject({ failed: 1, created: 0, active: 0 });
		expect(timings).toHaveLength(1);
		expect(timings[0]).toMatchObject({ kind: "warmup", outcome: "error", reused: false });
		expect(await pool.run(1)).toBe("2:1");
		expect(pool.stats).toMatchObject({ failed: 1, created: 1 });
	});

	for (const stage of ["startup", "execution", "close"] as const) {
		test(`${stage} failure counts once and never records private error details`, async () => {
			const failure = new Error("private body /secret/path");
			const timings: Readonly<WorkerTaskTiming>[] = [];
			const { pool } = setup({
				reuse: stage !== "close",
				create: async () => {
					if (stage === "startup") throw failure;
					const worker = new FakeWorker(1);
					if (stage === "execution")
						worker.onRun = async () => {
							throw failure;
						};
					if (stage === "close")
						worker.onClose = async () => {
							throw failure;
						};
					return worker;
				},
				onTaskComplete: (timing) => timings.push(timing),
			});
			await expect(pool.run(1)).rejects.toBe(failure);
			expect(pool.stats.failed).toBe(1);
			expect(timings).toHaveLength(1);
			expect(timings[0]?.outcome).toBe("error");
			expect(JSON.stringify(timings)).not.toContain("private");
			expect(JSON.stringify(timings)).not.toContain("/secret/path");
		});
	}

	test("admission and closed-pool rejection do not masquerade as execution", async () => {
		const started = gate();
		const finish = gate();
		const timings: Readonly<WorkerTaskTiming>[] = [];
		const { pool, workers } = setup({
			maxQueued: 0,
			onTaskComplete: (timing) => timings.push(timing),
		});
		await pool.warmup();
		workers[0].onRun = async () => {
			started.open();
			await finish.promise;
			return "done";
		};
		const active = observed(pool.run(1));
		await started.promise;
		await expect(pool.run(2, { requestId: "rejected" })).rejects.toMatchObject({
			code: "TASK_QUEUE_FULL",
		});
		expect(timings.find((timing) => timing.requestId === "rejected")).toMatchObject({
			outcome: "error",
			readyMs: 0,
			execMs: 0,
			closeMs: 0,
		});
		finish.open();
		await active;
		await pool.close();
		await expect(pool.run(3)).rejects.toMatchObject({ code: "WORKER_POOL_CLOSED" });
		expect(pool.stats.failed).toBe(2);
	});

	test("fixed summaries never inspect payloads and generate independent opaque IDs", async () => {
		const payload = {
			secret: "must-not-be-logged",
			toJSON() {
				throw new Error("payload serialized");
			},
		};
		const timings: Readonly<WorkerTaskTiming>[] = [];
		const requestIds: string[] = [];
		let closed = false;
		const pool = new WorkerPool<typeof payload, string>({
			concurrency: 1,
			create: async () => ({
				get closed() {
					return closed;
				},
				run: async (request, context) => {
					expect(request).toBe(payload);
					requestIds.push(context.requestId);
					return "done";
				},
				close: async () => {
					closed = true;
				},
			}),
			onTaskComplete: (timing) => timings.push(timing),
		});
		pools.add(pool);
		await pool.run(payload);
		await pool.run(payload);
		expect(requestIds.every((id) => id.length === 21)).toBe(true);
		expect(new Set(requestIds).size).toBe(2);
		expect(timings.map((timing) => timing.requestId)).toEqual(requestIds);
		expect(JSON.stringify(timings)).not.toContain("must-not-be-logged");
		expect(Object.keys(timings[0] ?? {}).sort()).toEqual([
			"closeMs",
			"execMs",
			"kind",
			"outcome",
			"queueMs",
			"readyMs",
			"requestId",
			"reused",
			"totalMs",
		]);
	});

	test("diagnostic sink failures cannot change task outcomes", async () => {
		const { pool, workers } = setup({
			onTaskComplete: () => {
				throw new Error("logger failed");
			},
		});
		expect(await pool.run(1)).toBe("1:1");
		expect(pool.stats.failed).toBe(0);
		const failure = new Error("validation failed");
		workers[0].onRun = async () => {
			throw failure;
		};
		await expect(pool.run(2)).rejects.toBe(failure);
		expect(pool.stats.failed).toBe(1);
	});

	test("queued jobs and their completion logs retain each caller's async trace context", async () => {
		const trace = new AsyncLocalStorage<string>();
		const started = gate();
		const finish = gate();
		const running: (string | undefined)[] = [];
		const completed: (string | undefined)[] = [];
		const { pool } = setup({
			create: async () => {
				const worker = new FakeWorker(1);
				worker.onRun = async (request) => {
					running.push(trace.getStore());
					if (request === 1) {
						started.open();
						await finish.promise;
					}
					return String(request);
				};
				return worker;
			},
			onTaskComplete: () => {
				completed.push(trace.getStore());
			},
		});
		const first = trace.run("parent-a", () => observed(pool.run(1)));
		await started.promise;
		const second = trace.run("parent-b", () => observed(pool.run(2)));
		finish.open();
		await first;
		await second;
		expect(running).toEqual(["parent-a", "parent-b"]);
		expect(completed).toEqual(["parent-a", "parent-b"]);
	});
});
