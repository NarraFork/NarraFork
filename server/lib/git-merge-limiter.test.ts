import { describe, expect, test } from "bun:test";
import { GitMergeLimiter } from "./git-merge-limiter";

const deadline = () => Date.now() + 5000;

describe("compatibility merge slots", () => {
	test("validates concurrency and queue bounds", () => {
		expect(() => new GitMergeLimiter(0, 1)).toThrow();
		expect(() => new GitMergeLimiter(1, -1)).toThrow();
	});

	test("bounds both running work and queued requests, granting FIFO", async () => {
		const slots = new GitMergeLimiter(2, 2);
		const a = await slots.acquire(deadline());
		const b = await slots.acquire(deadline());
		const order: string[] = [];
		const c = slots.acquire(deadline()).then((release) => {
			order.push("c");
			return release;
		});
		const d = slots.acquire(deadline()).then((release) => {
			order.push("d");
			return release;
		});
		await expect(slots.acquire(deadline())).rejects.toThrow("queue is full");
		expect(order).toEqual([]);
		a();
		const releaseC = await c;
		expect(order).toEqual(["c"]);
		b();
		const releaseD = await d;
		expect(order).toEqual(["c", "d"]);
		releaseC();
		releaseD();
	});

	test("cancels a queued request and immediately frees its queue capacity", async () => {
		const slots = new GitMergeLimiter(1, 1);
		const first = await slots.acquire(deadline());
		const controller = new AbortController();
		const cancelled = slots.acquire(deadline(), controller.signal);
		controller.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		const next = slots.acquire(deadline());
		first();
		(await next)();
	});

	test("queue waiting consumes the original deadline and cannot leak a slot", async () => {
		const slots = new GitMergeLimiter(1, 1);
		const first = await slots.acquire(deadline());
		await expect(slots.acquire(Date.now() + 10)).rejects.toThrow("timed out");
		const next = slots.acquire(deadline());
		first();
		(await next)();
		(await slots.acquire(deadline()))();
	});

	test("release is idempotent and cannot over-admit another request", async () => {
		const slots = new GitMergeLimiter(1, 2);
		const first = await slots.acquire(deadline());
		const secondPromise = slots.acquire(deadline());
		first();
		first();
		const second = await secondPromise;
		let admitted = false;
		const third = slots.acquire(deadline()).then((release) => {
			admitted = true;
			return release;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(admitted).toBe(false);
		second();
		(await third)();
	});

	test("already cancelled or expired work never enters the queue", async () => {
		const slots = new GitMergeLimiter(1, 0);
		await expect(slots.acquire(deadline(), AbortSignal.abort())).rejects.toThrow("cancelled");
		await expect(slots.acquire(Date.now() - 1)).rejects.toThrow("timed out");
		(await slots.acquire(deadline()))();
	});
});
