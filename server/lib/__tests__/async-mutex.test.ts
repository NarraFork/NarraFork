import { describe, expect, test } from "bun:test";
import { AsyncMutex } from "../async-mutex";

/** A promise plus its resolver, for driving lock timing deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AsyncMutex.tryAcquire", () => {
	test("runs immediately when the lock is free", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.tryAcquire("k", async () => "done", 1000);
		expect(result).toEqual({ acquired: true, value: "done" });
		// The key is released, not leaked.
		expect(mutex.isLocked("k")).toBe(false);
	});

	test("waits for the current holder and then runs", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const order: string[] = [];

		const holding = mutex.acquire("k", async () => {
			order.push("holder-start");
			await holder.promise;
			order.push("holder-end");
		});

		// Give the holder a chance to take the lock before the attempt starts.
		await sleep(5);
		const attempt = mutex.tryAcquire(
			"k",
			async () => {
				order.push("waiter");
				return "ok";
			},
			1000,
		);

		holder.resolve();
		await holding;
		expect(await attempt).toEqual({ acquired: true, value: "ok" });
		// Serialization held: the waiter never overlapped the holder.
		expect(order).toEqual(["holder-start", "holder-end", "waiter"]);
	});

	test("gives up without running fn when the holder outlasts the deadline", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		let ran = false;

		const holding = mutex.acquire("k", async () => {
			await holder.promise;
		});
		await sleep(5);

		const result = await mutex.tryAcquire(
			"k",
			async () => {
				ran = true;
			},
			30,
		);

		expect(result.acquired).toBe(false);
		// The whole point of the bounded attempt: the caller is not blocked, and the
		// guarded work is skipped rather than run out of order.
		expect(ran).toBe(false);

		holder.resolve();
		await holding;
	});

	test("a timed-out attempt does not release waiters queued behind the holder", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const order: string[] = [];

		const holding = mutex.acquire("k", async () => {
			order.push("holder-start");
			await holder.promise;
			order.push("holder-end");
		});
		await sleep(5);

		// A regular waiter queues behind the holder.
		const queued = mutex.acquire("k", async () => {
			order.push("queued");
		});

		// A bounded attempt times out while both are still pending. If it had
		// enqueued itself first and then abandoned its slot, `queued` would have been
		// let through while the holder was still running.
		const timedOut = await mutex.tryAcquire("k", async () => order.push("should-not-run"), 30);
		expect(timedOut.acquired).toBe(false);
		expect(order).toEqual(["holder-start"]);

		holder.resolve();
		await holding;
		await queued;
		expect(order).toEqual(["holder-start", "holder-end", "queued"]);
	});

	test("concurrent attempts on a free lock still run one at a time", async () => {
		const mutex = new AsyncMutex();
		let active = 0;
		let maxActive = 0;

		const body = async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await sleep(10);
			active--;
		};

		const results = await Promise.all([
			mutex.tryAcquire("k", body, 1000),
			mutex.tryAcquire("k", body, 1000),
			mutex.tryAcquire("k", body, 1000),
		]);

		expect(results.every((r) => r.acquired)).toBe(true);
		expect(maxActive).toBe(1);
		expect(mutex.isLocked("k")).toBe(false);
	});

	test("releases the lock when fn throws", async () => {
		const mutex = new AsyncMutex();
		await expect(
			mutex.tryAcquire(
				"k",
				async () => {
					throw new Error("boom");
				},
				1000,
			),
		).rejects.toThrow("boom");
		expect(mutex.isLocked("k")).toBe(false);
		// A later attempt is not blocked by the failed one.
		expect(await mutex.tryAcquire("k", async () => "after", 1000)).toEqual({
			acquired: true,
			value: "after",
		});
	});

	test("different keys never contend", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const holding = mutex.acquire("a", async () => {
			await holder.promise;
		});
		await sleep(5);

		// Zero timeout on an unrelated key must still succeed.
		expect(await mutex.tryAcquire("b", async () => "b-ok", 0)).toEqual({
			acquired: true,
			value: "b-ok",
		});

		holder.resolve();
		await holding;
	});

	test("a zero timeout fails fast on a held lock", async () => {
		const mutex = new AsyncMutex();
		const holder = deferred();
		const holding = mutex.acquire("k", async () => {
			await holder.promise;
		});
		await sleep(5);

		const started = Date.now();
		const result = await mutex.tryAcquire("k", async () => "nope", 0);
		expect(result.acquired).toBe(false);
		expect(Date.now() - started).toBeLessThan(50);

		holder.resolve();
		await holding;
	});
});
