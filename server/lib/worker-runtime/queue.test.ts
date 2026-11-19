import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	TaskQueue,
	type TaskQueueAdmission,
	TaskQueueError,
	type TaskQueueOptions,
	type TaskQueuePermit,
} from "./queue";

const queues = new Set<TaskQueue>();
const permits = new Set<TaskQueuePermit>();

function queue(options: Partial<TaskQueueOptions> = {}): TaskQueue {
	const created = new TaskQueue({ concurrency: 1, ...options });
	queues.add(created);
	return created;
}

function acquire(q: TaskQueue, options?: TaskQueueAdmission): Promise<TaskQueuePermit> {
	const pending = q.acquire(options).then((permit) => {
		permits.add(permit);
		return permit;
	});
	// Keep fixture cleanup from obscuring the original assertion if a test fails early.
	void pending.catch(() => {});
	return pending;
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

afterEach(async () => {
	const closing = [...queues].map((q) => q.close());
	for (const permit of permits) permit.release();
	await Promise.all(closing);
	queues.clear();
	permits.clear();
});

describe("TaskQueue admission", () => {
	test("reserves slots synchronously before callers await them", async () => {
		const q = queue({ concurrency: 2 });
		const first = acquire(q);
		const second = acquire(q);
		const third = acquire(q, { bytes: 7 });
		expect(q.stats).toEqual({
			activeBytes: 0,
			active: 2,
			queued: 1,
			queuedBytes: 7,
			closed: false,
		});
		(await first).release();
		expect(q.stats).toEqual({
			activeBytes: 7,
			active: 2,
			queued: 0,
			queuedBytes: 0,
			closed: false,
		});
		(await third).release();
		(await second).release();
		expect(q.stats.active).toBe(0);
	});

	test("unkeyed jobs are admitted FIFO and release is idempotent", async () => {
		const q = queue();
		const first = await acquire(q);
		const order: number[] = [];
		const second = acquire(q).then((permit) => {
			order.push(2);
			return permit;
		});
		const third = acquire(q).then((permit) => {
			order.push(3);
			return permit;
		});
		first.release();
		first.release();
		const p2 = await second;
		expect(order).toEqual([2]);
		expect(q.stats.active).toBe(1);
		expect(q.stats.queued).toBe(1);
		p2.release();
		(await third).release();
		expect(order).toEqual([2, 3]);
	});

	test("enforces the waiting item limit without taking another slot", async () => {
		const q = queue({ maxQueued: 1 });
		const first = await acquire(q);
		const second = acquire(q);
		await expect(acquire(q)).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		expect(q.stats.active).toBe(1);
		expect(q.stats.queued).toBe(1);
		first.release();
		(await second).release();
	});

	test("zero waiting capacity still admits an immediate job", async () => {
		const q = queue({ maxQueued: 0, maxQueuedBytes: 0 });
		const first = await acquire(q, { bytes: 1_000 });
		await expect(acquire(q)).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		expect(q.stats.queuedBytes).toBe(0);
		first.release();
		(await acquire(q)).release();
	});

	test("bounds waiting bytes and recovers them when one waiter is cancelled", async () => {
		const q = queue({ maxQueuedBytes: 10 });
		const first = await acquire(q);
		const controller = new AbortController();
		const second = acquire(q, { bytes: 6, signal: controller.signal });
		const third = acquire(q, { bytes: 4 });
		await expect(acquire(q, { bytes: 1 })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		expect(q.stats.queuedBytes).toBe(10);
		const reason = new Error("remove one waiter");
		controller.abort(reason);
		await expect(second).rejects.toBe(reason);
		expect(q.stats.queuedBytes).toBe(4);
		const fourth = acquire(q, { bytes: 6 });
		expect(q.stats.queuedBytes).toBe(10);
		first.release();
		(await third).release();
		(await fourth).release();
		expect(q.stats.queuedBytes).toBe(0);
	});

	test("keeps waiting byte accounting precise when a large job can start immediately", async () => {
		const q = queue({ concurrency: 2, maxActivePerKey: 1, maxQueuedBytes: 16 });
		const first = await acquire(q, { key: "a" });
		const second = acquire(q, { key: "a", bytes: 6 });
		const other = await acquire(q, { key: "b", bytes: Number.MAX_SAFE_INTEGER });
		expect(q.stats.queuedBytes).toBe(6);
		other.release();
		first.release();
		(await second).release();
		expect(q.stats.queuedBytes).toBe(0);
	});

	test("enforces per-key activity without blocking another eligible key", async () => {
		const q = queue({ concurrency: 2, maxActivePerKey: 1 });
		const a1 = await acquire(q, { key: "a" });
		const a2 = acquire(q, { key: "a" });
		const b1 = await acquire(q, { key: "b" });
		expect(q.stats).toEqual({
			activeBytes: 0,
			active: 2,
			queued: 1,
			queuedBytes: 0,
			closed: false,
		});
		b1.release();
		expect(q.stats.active).toBe(1);
		expect(q.stats.queued).toBe(1);
		a1.release();
		(await a2).release();
	});

	test("per-key waiting limits are independent and recover after cancellation", async () => {
		const q = queue({ maxQueued: 4, maxQueuedPerKey: 1 });
		const first = await acquire(q);
		const controller = new AbortController();
		const a1 = acquire(q, { key: "a", signal: controller.signal });
		await expect(acquire(q, { key: "a" })).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
		const b1 = acquire(q, { key: "b" });
		controller.abort();
		await expect(a1).rejects.toMatchObject({ name: "AbortError" });
		const a2 = acquire(q, { key: "a" });
		first.release();
		(await b1).release();
		(await a2).release();
	});

	test("keyed callers rotate instead of monopolizing a one-slot queue", async () => {
		const q = queue();
		const a1 = await acquire(q, { key: "a" });
		const a2 = acquire(q, { key: "a" });
		const a3 = acquire(q, { key: "a" });
		let bStarted = false;
		const b1 = acquire(q, { key: "b" }).then((permit) => {
			bStarted = true;
			return permit;
		});
		a1.release();
		const pb = await b1;
		expect(bStarted).toBe(true);
		expect(q.stats.queued).toBe(2);
		pb.release();
		(await a2).release();
		(await a3).release();
	});
});

describe("TaskQueue existing active byte budgets", () => {
	test("reserves active bytes synchronously and admits fitting waiters without exceeding the cap", async () => {
		const q = queue({ concurrency: 3, maxActiveBytes: 10 });
		const first = await acquire(q, { bytes: 8 });
		const second = await acquire(q, { bytes: 2 });
		const larger = acquire(q, { bytes: 7 });
		const smaller = acquire(q, { bytes: 1 });
		expect(q.stats).toEqual({
			active: 2,
			activeBytes: 10,
			queued: 2,
			queuedBytes: 8,
			closed: false,
		});
		second.release();
		const smallPermit = await smaller;
		expect(q.stats).toEqual({
			active: 2,
			activeBytes: 9,
			queued: 1,
			queuedBytes: 7,
			closed: false,
		});
		first.release();
		const largePermit = await larger;
		expect(q.stats).toEqual({
			active: 2,
			activeBytes: 8,
			queued: 0,
			queuedBytes: 0,
			closed: false,
		});
		smallPermit.release();
		largePermit.release();
		largePermit.release();
		expect(q.stats.activeBytes).toBe(0);
	});

	test("byte-fit admission retains the existing per-key active limits", async () => {
		const q = queue({ concurrency: 3, maxActiveBytes: 10, maxActivePerKey: 1 });
		const a = await acquire(q, { key: "a", bytes: 6 });
		const b = await acquire(q, { key: "b", bytes: 4 });
		const sameKey = acquire(q, { key: "a", bytes: 1 });
		const otherKey = acquire(q, { key: "c", bytes: 4 });
		b.release();
		const c = await otherKey;
		expect(q.stats).toMatchObject({ active: 2, activeBytes: 10, queued: 1, queuedBytes: 1 });
		a.release();
		const nextA = await sameKey;
		expect(q.stats).toMatchObject({ active: 2, activeBytes: 5, queued: 0 });
		c.release();
		nextA.release();
		expect(q.stats.activeBytes).toBe(0);
	});

	test("cancellation and close retain active bytes until actual resource release", async () => {
		const q = queue({ concurrency: 2, maxActiveBytes: 10 });
		const activeController = new AbortController();
		const queuedController = new AbortController();
		const active = await acquire(q, {
			bytes: 8,
			signal: activeController.signal,
			deadlineAt: Infinity,
		});
		const cancelled = acquire(q, {
			bytes: 3,
			signal: queuedController.signal,
			deadlineAt: Infinity,
		});
		const waiting = acquire(q, { bytes: 4, deadlineAt: Infinity });
		const reason = new Error("resource cleanup pending");
		activeController.abort(reason);
		expect(active.signal.reason).toBe(reason);
		expect(q.stats).toMatchObject({ active: 1, activeBytes: 8, queued: 2, queuedBytes: 7 });
		queuedController.abort(reason);
		expect(await cancelled.catch((error: unknown) => error)).toBe(reason);
		expect(q.stats).toMatchObject({ activeBytes: 8, queued: 1, queuedBytes: 4 });
		let closed = false;
		const closing = q.close().then(() => {
			closed = true;
		});
		expect(await waiting.catch((error: unknown) => error)).toMatchObject({
			code: "TASK_QUEUE_CLOSED",
		});
		expect(closed).toBe(false);
		expect(q.stats).toMatchObject({ active: 1, activeBytes: 8, queued: 0, queuedBytes: 0 });
		active.release();
		await closing;
		expect(closed).toBe(true);
		expect(q.stats.activeBytes).toBe(0);
	});

	test("an impossible byte reservation fails before queueing and zero budgets still admit controls", async () => {
		const q = queue({ concurrency: 2, maxActiveBytes: 4 });
		const result = await acquire(q, { bytes: 5 }).catch((error: unknown) => error);
		expect(result).toMatchObject({ code: "TASK_QUEUE_FULL" });
		expect(q.stats).toEqual({
			active: 0,
			activeBytes: 0,
			queued: 0,
			queuedBytes: 0,
			closed: false,
		});
		const controls = queue({ maxActiveBytes: 0 });
		const active = await acquire(controls);
		expect(await acquire(controls, { bytes: 1 }).catch((error: unknown) => error)).toMatchObject({
			code: "TASK_QUEUE_FULL",
		});
		active.release();
	});

	test("an omitted or infinite cap keeps independent active and waiting byte accounting", async () => {
		for (const cap of [undefined, Infinity]) {
			const q = queue({ concurrency: 2, maxActiveBytes: cap, maxQueuedBytes: 0 });
			const first = await acquire(q, { bytes: 100 });
			const second = await acquire(q, { bytes: 200 });
			expect(q.stats).toMatchObject({ active: 2, activeBytes: 300, queuedBytes: 0 });
			first.release();
			second.release();
			expect(q.stats.activeBytes).toBe(0);
		}
	});
});

describe("TaskQueue independent waiting deadlines", () => {
	test("an immediate grant never consumes a 1ms or zero waiting budget", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => (now += 100));
		const timers = spyOn(globalThis, "setTimeout");
		try {
			const q = queue({ maxQueued: 0 });
			for (const waitTimeoutMs of [0, 1]) {
				const permit = await acquire(q, { waitTimeoutMs, deadlineAt: Infinity });
				expect(permit.deadlineAt).toBe(Infinity);
				expect(permit.signal.aborted).toBe(false);
				permit.release();
			}
			expect(await q.run(() => "really started", { waitTimeoutMs: 1, deadlineAt: Infinity })).toBe(
				"really started",
			);
			expect(timers).not.toHaveBeenCalled();
		} finally {
			timers.mockRestore();
			clock.mockRestore();
		}
	});

	test("only a real waiter times out and returns its queued bytes, not the active resource", async () => {
		const q = queue();
		const active = await acquire(q, { bytes: 8, deadlineAt: Infinity });
		const timedOut = await acquire(q, { bytes: 3, waitTimeoutMs: 10, deadlineAt: Infinity }).catch(
			(error: unknown) => error,
		);
		expect(timedOut).toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
		expect(q.stats).toMatchObject({ active: 1, activeBytes: 8, queued: 0, queuedBytes: 0 });
		expect(active.signal.aborted).toBe(false);
		active.release();
	});

	test("grant clears the wait timer while the independent overall deadline stays armed", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			const q = queue();
			const active = await acquire(q, { deadlineAt: Infinity });
			const waiting = acquire(q, { waitTimeoutMs: 1_000, deadlineAt: now + 5_000 });
			expect(timers.mock.calls.map((call) => call[1])).toEqual([5_000, 1_000]);
			const waitTimer = timers.mock.results[1]?.value;
			active.release();
			const admitted = await waiting;
			expect(clear).toHaveBeenCalledWith(waitTimer);
			now += 2_000;
			const waitCallback = timers.mock.calls[1]?.[0];
			if (typeof waitCallback === "function") waitCallback();
			expect(admitted.signal.aborted).toBe(false);
			now += 3_001;
			const overallCallback = timers.mock.calls[0]?.[0];
			if (typeof overallCallback === "function") overallCallback();
			expect(admitted.signal.reason).toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
			expect(q.stats.active).toBe(1);
			admitted.release();
		} finally {
			clear.mockRestore();
			timers.mockRestore();
			clock.mockRestore();
		}
	});

	test("an expired wait cannot be granted before its timer runs", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const q = queue();
			const active = await acquire(q, { deadlineAt: Infinity });
			const expired = acquire(q, { deadlineAt: Infinity, waitTimeoutMs: 10, bytes: 5 });
			const next = acquire(q, { deadlineAt: Infinity, waitTimeoutMs: 100, bytes: 2 });
			now += 11;
			active.release();
			expect(await expired.catch((error: unknown) => error)).toMatchObject({
				code: "TASK_QUEUE_TIMEOUT",
			});
			const admitted = await next;
			expect(q.stats).toMatchObject({ active: 1, activeBytes: 2, queued: 0, queuedBytes: 0 });
			expect(admitted.signal.aborted).toBe(false);
			admitted.release();
		} finally {
			clock.mockRestore();
		}
	});

	test("zero wait refuses blocked work and close still waits for actual active release", async () => {
		const q = queue();
		const active = await acquire(q, { deadlineAt: Infinity });
		expect(
			await acquire(q, { waitTimeoutMs: 0, deadlineAt: Infinity }).catch((error: unknown) => error),
		).toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
		const waiting = acquire(q, { waitTimeoutMs: 1_000, deadlineAt: Infinity, bytes: 3 });
		let closed = false;
		const closing = q.close().then(() => {
			closed = true;
		});
		expect(await waiting.catch((error: unknown) => error)).toMatchObject({
			code: "TASK_QUEUE_CLOSED",
		});
		expect(q.stats).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 });
		expect(closed).toBe(false);
		active.release();
		await closing;
	});
});

describe("TaskQueue cancellation and deadlines", () => {
	test("an already-aborted caller never reserves a slot", async () => {
		const q = queue();
		const reason = new Error("already cancelled");
		await expect(acquire(q, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
		expect(q.stats).toEqual({
			activeBytes: 0,
			active: 0,
			queued: 0,
			queuedBytes: 0,
			closed: false,
		});
	});

	test("a queued timeout removes only that waiter's bytes", async () => {
		const q = queue();
		const active = await acquire(q);
		const expires = acquire(q, { deadlineAt: Date.now() + 30, bytes: 8 });
		const next = acquire(q, { bytes: 3 });
		await expect(expires).rejects.toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
		expect(q.stats).toEqual({
			activeBytes: 0,
			active: 1,
			queued: 1,
			queuedBytes: 3,
			closed: false,
		});
		active.release();
		(await next).release();
	});

	test("cancelling active work signals it but does not release its slot", async () => {
		const q = queue();
		const controller = new AbortController();
		const active = await acquire(q, { signal: controller.signal });
		const next = acquire(q);
		const reason = new Error("stop worker");
		controller.abort(reason);
		expect(active.signal.aborted).toBe(true);
		expect(active.signal.reason).toBe(reason);
		expect(q.stats.active).toBe(1);
		expect(q.stats.queued).toBe(1);
		active.release();
		(await next).release();
	});

	test("the same absolute deadline remains armed after admission", async () => {
		const q = queue();
		const deadlineAt = Date.now() + 30;
		const active = await acquire(q, { deadlineAt });
		const timedOut = new Promise<void>((resolve) => {
			if (active.signal.aborted) resolve();
			else active.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		await timedOut;
		expect(active.deadlineAt).toBe(deadlineAt);
		expect(active.signal.reason).toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
		expect(q.stats.active).toBe(1);
		active.release();
	});

	test("an expired waiter cannot dispatch before its timer callback runs", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const q = queue();
			const active = await acquire(q);
			const expired = acquire(q, { deadlineAt: now + 1_000, bytes: 5 });
			const next = acquire(q, { deadlineAt: now + 10_000, bytes: 2 });
			now += 1_001;
			active.release();
			await expect(expired).rejects.toMatchObject({ code: "TASK_QUEUE_TIMEOUT" });
			expect(q.stats.queuedBytes).toBe(0);
			(await next).release();
		} finally {
			clock.mockRestore();
		}
	});

	test("draining many expired jobs is iterative rather than recursively pumping", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const q = queue({ maxQueued: 4_000 });
			const active = await acquire(q);
			const expired = Array.from({ length: 4_000 }, () =>
				acquire(q, { deadlineAt: now + 1_000 }).catch((error: unknown) => error),
			);
			now += 1_001;
			active.release();
			expect((await Promise.all(expired)).every((error) => error instanceof TaskQueueError)).toBe(
				true,
			);
			expect(q.stats.active).toBe(0);
			expect(q.stats.queued).toBe(0);
		} finally {
			clock.mockRestore();
		}
	});

	test("admission preserves a deadline rather than starting another timeout", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const q = queue();
			const active = await acquire(q);
			const deadlineAt = now + 2_000;
			const waiting = acquire(q, { deadlineAt });
			now += 1_000;
			active.release();
			const admitted = await waiting;
			expect(admitted.deadlineAt).toBe(deadlineAt);
			admitted.release();
		} finally {
			clock.mockRestore();
		}
	});

	test("release detaches abort forwarding and is harmless after a later caller abort", async () => {
		const q = queue();
		const controller = new AbortController();
		const active = await acquire(q, { signal: controller.signal });
		active.release();
		controller.abort();
		expect(active.signal.aborted).toBe(false);
		expect(q.stats.active).toBe(0);
	});

	test("captures the caller signal even if its options object is later reused", async () => {
		const q = queue();
		const original = new AbortController();
		const replacement = new AbortController();
		const options: TaskQueueAdmission = { signal: original.signal };
		const active = await acquire(q, options);
		options.signal = replacement.signal;
		const reason = new Error("original caller cancelled");
		original.abort(reason);
		expect(active.signal.reason).toBe(reason);
		active.release();
	});

	test("explicit +Infinity arms no overall timer while omitted deadlines keep their default", async () => {
		let now = 10_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const timers = spyOn(globalThis, "setTimeout");
		try {
			const q = queue({ timeoutMs: 1 });
			const first = await acquire(q, { deadlineAt: Infinity });
			const waiting = acquire(q, { deadlineAt: Infinity, bytes: 9 });
			expect(timers).not.toHaveBeenCalled();
			now += 9_000_000_000;
			expect(first.signal.aborted).toBe(false);
			first.release();
			const next = await waiting;
			expect(next.deadlineAt).toBe(Infinity);
			expect(next.signal.aborted).toBe(false);
			expect(q.stats).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 });
			next.release();
			const defaulted = await acquire(q);
			expect(defaulted.deadlineAt).toBe(now + 1);
			expect(timers).toHaveBeenCalledTimes(1);
			expect(timers.mock.calls[0]?.[1]).toBe(1);
			defaulted.release();
			const result = await q.run(() => "phase-owned", { deadlineAt: Infinity });
			expect(result).toBe("phase-owned");
			expect(timers).toHaveBeenCalledTimes(1);
		} finally {
			timers.mockRestore();
			clock.mockRestore();
		}
	});

	test("unbounded leases still enforce cancellation, backpressure and the close release barrier", async () => {
		const q = queue({ maxQueued: 1, maxQueuedBytes: 3 });
		const activeController = new AbortController();
		const waitingController = new AbortController();
		const active = await acquire(q, { deadlineAt: Infinity, signal: activeController.signal });
		const waiting = acquire(q, {
			deadlineAt: Infinity,
			signal: waitingController.signal,
			bytes: 3,
		});
		const full = await acquire(q, { deadlineAt: Infinity }).catch((error: unknown) => error);
		expect(full).toMatchObject({ code: "TASK_QUEUE_FULL" });
		const cancelled = new Error("cancel queued phase");
		waitingController.abort(cancelled);
		expect(await waiting.catch((error: unknown) => error)).toBe(cancelled);
		expect(q.stats).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 });
		const rejectedOnClose = acquire(q, { deadlineAt: Infinity, bytes: 3 });
		const reason = new Error("stop active resource");
		activeController.abort(reason);
		expect(active.signal.reason).toBe(reason);
		let closed = false;
		const closing = q.close().then(() => {
			closed = true;
		});
		expect(await rejectedOnClose.catch((error: unknown) => error)).toMatchObject({
			code: "TASK_QUEUE_CLOSED",
		});
		expect(closed).toBe(false);
		expect(q.stats.active).toBe(1);
		active.release();
		await closing;
		expect(closed).toBe(true);
		expect(q.stats.active).toBe(0);
	});
	test("long deadlines do not overflow setTimeout into an immediate expiry", async () => {
		const q = queue();
		const timers = spyOn(globalThis, "setTimeout");
		try {
			const active = await acquire(q, { deadlineAt: Date.now() + 3_000_000_000 });
			expect(timers.mock.calls[0]?.[1]).toBe(2_147_483_647);
			expect(active.signal.aborted).toBe(false);
			active.release();
		} finally {
			timers.mockRestore();
		}
	});
});

describe("TaskQueue run and close", () => {
	test("run releases on success and synchronous failure", async () => {
		const q = queue();
		await expect(q.run(() => 42)).resolves.toBe(42);
		expect(q.stats.active).toBe(0);
		const reason = new Error("dispatch failed");
		await expect(
			q.run(() => {
				throw reason;
			}),
		).rejects.toBe(reason);
		expect(q.stats.active).toBe(0);
	});

	test("run does not invoke work cancelled just after immediate admission", async () => {
		const q = queue();
		const controller = new AbortController();
		let invoked = false;
		const result = q.run(
			() => {
				invoked = true;
			},
			{ signal: controller.signal },
		);
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(invoked).toBe(false);
		expect(q.stats.active).toBe(0);
	});

	test("run waits for resource cleanup after cancellation before admitting the next job", async () => {
		const q = queue();
		const controller = new AbortController();
		const entered = deferred();
		const cleanupEntered = deferred();
		const cleanup = deferred();
		const result = q.run(
			async (permit) => {
				const aborted = new Promise<void>((resolve) => {
					permit.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				entered.resolve();
				try {
					await aborted;
					permit.signal.throwIfAborted();
				} finally {
					cleanupEntered.resolve();
					await cleanup.promise;
				}
			},
			{ signal: controller.signal },
		);
		try {
			await entered.promise;
			const next = acquire(q);
			const reason = new Error("cancel but wait for worker exit");
			controller.abort(reason);
			await cleanupEntered.promise;
			expect(q.stats.active).toBe(1);
			expect(q.stats.queued).toBe(1);
			cleanup.resolve();
			await expect(result).rejects.toBe(reason);
			(await next).release();
		} finally {
			cleanup.resolve();
			await result.catch(() => {});
		}
	});

	test("close rejects waiting work and drains active work without auto-cancelling it", async () => {
		const q = queue();
		const active = await acquire(q);
		const queued = acquire(q, { bytes: 8 });
		const reason = new Error("service shutting down");
		const closing = q.close(reason);
		expect(q.close()).toBe(closing);
		await expect(queued).rejects.toBe(reason);
		await expect(acquire(q)).rejects.toBe(reason);
		expect(active.signal.aborted).toBe(false);
		expect(q.stats).toEqual({ activeBytes: 0, active: 1, queued: 0, queuedBytes: 0, closed: true });
		let drained = false;
		void closing.then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		active.release();
		await closing;
		expect(drained).toBe(true);
	});

	test("an empty queue closes immediately and cannot restart", async () => {
		const q = queue();
		await q.close();
		await expect(acquire(q)).rejects.toMatchObject({ code: "TASK_QUEUE_CLOSED" });
	});
});

describe("TaskQueue configuration", () => {
	for (const options of [
		{ concurrency: 0 },
		{ concurrency: 1.5 },
		{ maxQueued: -1 },
		{ maxQueuedBytes: Number.POSITIVE_INFINITY },
		{ maxActiveBytes: -1 },
		{ maxActiveBytes: Number.NaN },
		{ maxActiveBytes: 0.5 },
		{ maxActiveBytes: Number.NEGATIVE_INFINITY },
		{ timeoutMs: 0 },
		{ maxActivePerKey: 0 },
		{ maxQueuedPerKey: -1 },
	]) {
		test(`rejects invalid limits ${JSON.stringify(options)}`, () => {
			expect(() => new TaskQueue({ concurrency: 1, ...options })).toThrow(RangeError);
		});
	}

	test("invalid sizes and deadlines do not change capacity", async () => {
		const q = queue();
		await expect(acquire(q, { bytes: -1 })).rejects.toBeInstanceOf(RangeError);
		for (const waitTimeoutMs of [-1, 0.5, NaN, Infinity, -Infinity])
			await expect(acquire(q, { waitTimeoutMs })).rejects.toBeInstanceOf(RangeError);
		await expect(acquire(q, { deadlineAt: Number.NaN })).rejects.toBeInstanceOf(RangeError);
		await expect(acquire(q, { deadlineAt: Number.NEGATIVE_INFINITY })).rejects.toBeInstanceOf(
			RangeError,
		);
		await expect(acquire(q, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
			code: "TASK_QUEUE_TIMEOUT",
		});
		expect(q.stats.active).toBe(0);
		expect(q.stats.queued).toBe(0);
	});
});
