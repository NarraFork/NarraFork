import { expect, spyOn, test } from "bun:test";
import { toDatabaseReadUnavailablePayload } from "../app-error-response";
import { AuthReadAdmission } from "../auth-read-admission";

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function outcome<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	);
}
const code = (error: unknown) => (error as { code?: string })?.code;

test("FIFO admission bounds active work and never shares or retains read results", async () => {
	const admission = new AuthReadAdmission({ concurrency: 2, maxQueued: 4 });
	const work = Array.from({ length: 4 }, () => gate<number>());
	const started: number[] = [];
	const reads = work.map((item, index) =>
		admission.run(() => {
			started.push(index);
			return item.promise;
		}),
	);
	await Promise.resolve();
	expect(started).toEqual([0, 1]);
	expect(admission.stats).toEqual({ active: 2, queued: 2 });
	work[1].resolve(1);
	expect(await reads[1]).toBe(1);
	work[2].resolve(2);
	expect(await reads[2]).toBe(2);
	expect(started.slice(0, 3)).toEqual([0, 1, 2]);
	work[3].resolve(3);
	work[0].resolve(0);
	expect(await Promise.all(reads)).toEqual([0, 1, 2, 3]);
	let calls = 0;
	const read = () => admission.run(async () => ++calls);
	expect(await Promise.all([read(), read()])).toEqual([1, 2]);
	expect(await read()).toBe(3);
});

test("full queue rejects with the existing transient 503 code and accepts no extra callback", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1 });
	const held = gate<number>();
	const first = admission.run(() => held.promise);
	const second = admission.run(async () => 2);
	let extraCalls = 0;
	const rejected = await outcome(admission.run(async () => ++extraCalls));
	try {
		expect(code(rejected.error)).toBe("DB_READ_TASK_OVERLOADED");
		expect(toDatabaseReadUnavailablePayload(rejected.error)?.messageCode).toBe(
			"DATABASE_READ_UNAVAILABLE",
		);
		expect(extraCalls).toBe(0);
		expect(admission.stats).toEqual({ active: 1, queued: 1 });
	} finally {
		held.resolve(1);
		await Promise.all([first, second]);
	}
});

test("queued abort removes its waiter without executing a read; pre-aborted calls allocate nothing", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1 });
	const held = gate<number>();
	const first = admission.run(() => held.promise);
	const controller = new AbortController();
	let calls = 0;
	const canceled = outcome(admission.run(async () => ++calls, { signal: controller.signal }));
	controller.abort();
	expect(code((await canceled).error)).toBe("DB_READ_ABORTED");
	expect(admission.stats).toEqual({ active: 1, queued: 0 });
	expect(
		code((await outcome(admission.run(async () => ++calls, { signal: controller.signal }))).error),
	).toBe("DB_READ_ABORTED");
	expect(calls).toBe(0);
	const next = admission.run(async () => ++calls);
	held.resolve(1);
	await first;
	expect(await next).toBe(1);
});

test("aborting active work settles the caller but keeps its slot until the original read settles", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1 });
	const held = gate<number>();
	const controller = new AbortController();
	const first = outcome(admission.run(() => held.promise, { signal: controller.signal }));
	await Promise.resolve();
	let nextStarted = false;
	const second = admission.run(async () => {
		nextStarted = true;
		return 2;
	});
	controller.abort();
	expect(code((await first).error)).toBe("DB_READ_ABORTED");
	expect(nextStarted).toBe(false);
	expect(admission.stats).toEqual({ active: 1, queued: 1 });
	held.resolve(1);
	expect(await second).toBe(2);
});

test("one absolute deadline covers queued and running work; expired waiters never dispatch", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1, timeoutMs: 20 });
	const held = gate<number>();
	const first = outcome(admission.run(() => held.promise));
	let calls = 0;
	const queued = outcome(admission.run(async () => ++calls));
	try {
		expect(code((await queued).error)).toBe("DB_READ_TASK_TIMEOUT");
		expect(code((await first).error)).toBe("DB_READ_TASK_TIMEOUT");
		expect(calls).toBe(0);
		expect(admission.stats).toEqual({ active: 1, queued: 0 });
		const later = admission.run(async () => ++calls);
		held.resolve(1);
		expect(await later).toBe(1);
	} finally {
		held.resolve(1);
	}
});

test("admission does not reset a queued caller's absolute deadline when its read starts", async () => {
	let now = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1, timeoutMs: 1_000 });
	const firstRead = gate<number>();
	const nextRead = gate<number>();
	const nextStarted = gate<void>();
	const first = admission.run(() => firstRead.promise);
	const next = outcome(
		admission.run(() => {
			nextStarted.resolve();
			return nextRead.promise;
		}),
	);
	try {
		now = 999;
		firstRead.resolve(1);
		expect(await first).toBe(1);
		await nextStarted.promise;
		now = 1_001;
		nextRead.resolve(2);
		expect(code((await next).error)).toBe("DB_READ_TASK_TIMEOUT");
	} finally {
		firstRead.resolve(1);
		nextRead.resolve(2);
		clock.mockRestore();
	}
});

test("production limits admit two reads and at most 64 FIFO waiters", async () => {
	const admission = new AuthReadAdmission();
	const release = gate<number>();
	let calls = 0;
	const reads = Array.from({ length: 66 }, () =>
		admission.run(() => {
			calls++;
			return release.promise;
		}),
	);
	try {
		await Promise.resolve();
		expect(calls).toBe(2);
		expect(admission.stats).toEqual({ active: 2, queued: 64 });
		expect(code((await outcome(admission.run(async () => 0))).error)).toBe(
			"DB_READ_TASK_OVERLOADED",
		);
	} finally {
		release.resolve(1);
		await Promise.all(reads);
	}
	expect(calls).toBe(66);
});

test("native storage errors and synchronous failures release capacity unchanged", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1 });
	const failure = new Error("test storage failure");
	const first = outcome(
		admission.run(() => {
			throw failure;
		}),
	);
	const second = admission.run(async () => 2);
	expect((await first).error).toBe(failure);
	expect(await second).toBe(2);
	expect(await admission.run(async () => 3)).toBe(3);
});

test("caller abort reaches the read context while the original read still owns its slot", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1 });
	const held = gate<number>();
	const caller = new AbortController();
	let downstream: AbortSignal | undefined;
	let deadline: number | undefined;
	const deadlineAt = Date.now() + 5_000;
	const result = outcome(
		admission.run(
			(context) => {
				downstream = context.signal;
				deadline = context.deadlineAt;
				return held.promise;
			},
			{ signal: caller.signal, deadlineAt },
		),
	);
	await Promise.resolve();
	expect(deadline).toBe(deadlineAt);
	expect(downstream).not.toBe(caller.signal);
	caller.abort();
	expect(code((await result).error)).toBe("DB_READ_ABORTED");
	expect(downstream?.aborted).toBe(true);
	expect(admission.stats.active).toBe(1);
	held.resolve(1);
	await admission.run(async () => 2);
	expect(admission.stats.queued).toBe(0);
});

test("admission timeout aborts downstream with the same absolute deadline and waits for settle", async () => {
	const admission = new AuthReadAdmission({ concurrency: 1, timeoutMs: 20 });
	const held = gate<number>();
	let downstream: AbortSignal | undefined;
	let deadlineAt = 0;
	const before = Date.now();
	const result = outcome(
		admission.run((context) => {
			downstream = context.signal;
			deadlineAt = context.deadlineAt;
			return held.promise;
		}),
	);
	expect(code((await result).error)).toBe("DB_READ_TASK_TIMEOUT");
	expect(downstream?.aborted).toBe(true);
	expect(deadlineAt).toBeGreaterThanOrEqual(before + 20);
	expect(admission.stats.active).toBe(1);
	held.resolve(1);
	await admission.run(async () => 2);
});

test("expired or invalid absolute budgets never execute or enter the queue", async () => {
	const admission = new AuthReadAdmission();
	let calls = 0;
	for (const deadlineAt of [Date.now() - 1, Number.NaN, Infinity]) {
		const result = await outcome(admission.run(async () => ++calls, { deadlineAt }));
		expect(code(result.error)).toBe(
			Number.isFinite(deadlineAt) ? "DB_READ_TASK_TIMEOUT" : "DB_READ_INVALID",
		);
	}
	expect(calls).toBe(0);
	expect(admission.stats).toEqual({ active: 0, queued: 0 });
});

test("queued read gets its original deadline, not a fresh execution budget", async () => {
	let now = 10_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const admission = new AuthReadAdmission({ concurrency: 1, timeoutMs: 1_000 });
	const held = gate<number>();
	const first = admission.run(() => held.promise);
	const deadlineAt = now + 900;
	let receivedDeadline = 0;
	const second = admission.run(
		async (context) => {
			receivedDeadline = context.deadlineAt;
			return 2;
		},
		{ deadlineAt },
	);
	try {
		now += 800;
		held.resolve(1);
		await first;
		expect(await second).toBe(2);
		expect(receivedDeadline).toBe(deadlineAt);
	} finally {
		held.resolve(1);
		clock.mockRestore();
	}
});

/** The pre-context gate's fields and waiter closures, including its old finally contract. */
class LegacyAdmission {
	private active = 0;
	private queue: { start(): void }[] = [];
	private concurrency = 1;
	maxQueued = 4;
	timeoutMs = 1_000;

	run<T>(read: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const waiter = {
				start: () => {
					this.active++;
					void read()
						.then(resolve, reject)
						.finally(() => {
							this.active--;
							this.drain();
						});
				},
			};
			if (this.active < this.concurrency) waiter.start();
			else this.queue.push(waiter);
		});
	}

	private drain(): void {
		while (this.active < this.concurrency && this.queue.length) this.queue.shift()?.start();
	}
}

test("hot upgrade keeps legacy active/queued ownership and gives only new reads a cancel context", async () => {
	const old = new LegacyAdmission();
	const active = gate<number>();
	const queued = gate<number>();
	const calls: string[] = [];
	const first = old.run(() => {
		calls.push("old-active");
		return active.promise;
	});
	const second = old.run(() => {
		calls.push("old-queued");
		return queued.promise;
	});
	const upgraded = AuthReadAdmission.upgrade(old as unknown as AuthReadAdmission);
	expect(upgraded as unknown).toBe(old);
	expect(upgraded.stats).toEqual({ active: 1, queued: 1 });
	const caller = new AbortController();
	const held = gate<number>();
	let downstream: AbortSignal | undefined;
	const next = outcome(
		upgraded.run(
			(context) => {
				calls.push("new");
				downstream = context.signal;
				expect(context.deadlineAt).toBeGreaterThan(Date.now());
				return held.promise;
			},
			{ signal: caller.signal },
		),
	);
	expect(upgraded.stats).toEqual({ active: 1, queued: 2 });
	active.resolve(1);
	await first;
	await Promise.resolve();
	expect(calls).toEqual(["old-active", "old-queued"]);
	queued.resolve(2);
	await second;
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toEqual(["old-active", "old-queued", "new"]);
	caller.abort();
	expect(code((await next).error)).toBe("DB_READ_ABORTED");
	expect(downstream?.aborted).toBe(true);
	expect(upgraded.stats.active).toBe(1);
	held.resolve(3);
	expect(await upgraded.run(async () => 4)).toBe(4);
	await Promise.resolve();
	expect(upgraded.stats).toEqual({ active: 0, queued: 0 });
});

test("module reload upgrades the existing hotSafe key with old work still in flight", async () => {
	const key = Symbol.for("narrafork.authReadAdmission");
	const pinned = globalThis as unknown as Record<symbol, unknown>;
	const previous = pinned[key];
	const old = new LegacyAdmission();
	const active = gate<number>();
	const queued = gate<number>();
	const first = old.run(() => active.promise);
	const second = old.run(() => queued.promise);
	pinned[key] = old;
	try {
		const modulePath = "../auth-read-admission?legacy-inflight-upgrade";
		const reloaded = (await import(modulePath)).authReadAdmission as AuthReadAdmission;
		expect(reloaded as unknown).toBe(old);
		expect(reloaded.stats).toEqual({ active: 1, queued: 1 });
		const third = reloaded.run(async (context) => {
			expect(context.signal.aborted).toBe(false);
			return 3;
		});
		active.resolve(1);
		queued.resolve(2);
		expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
		await Promise.resolve();
		expect(reloaded.stats).toEqual({ active: 0, queued: 0 });
	} finally {
		active.resolve(1);
		queued.resolve(2);
		await Promise.all([first, second]);
		pinned[key] = previous;
	}
});
