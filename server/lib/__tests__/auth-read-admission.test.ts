import { describe, expect, test } from "bun:test";
import { AuthReadAdmission, type AuthReadContext } from "../auth-read-admission";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) => error as Error,
	);

describe("AuthReadAdmission", () => {
	test("admits up to the concurrency limit and drains the rest FIFO", async () => {
		const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 4 });
		const gate = deferred();
		const order: string[] = [];
		const first = admission.run(async () => {
			order.push("a");
			await gate.promise;
			return "a";
		});
		const second = admission.run(async () => {
			order.push("b");
			return "b";
		});
		const third = admission.run(async () => {
			order.push("c");
			return "c";
		});
		await Bun.sleep(0);
		expect(admission.stats).toEqual({ active: 1, queued: 2 });
		gate.resolve();
		expect(await Promise.all([first, second, third])).toEqual(["a", "b", "c"]);
		expect(order).toEqual(["a", "b", "c"]);
		expect(admission.stats).toEqual({ active: 0, queued: 0 });
	});

	test("rejects with the overload error once the queue is full", async () => {
		const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 1 });
		const gate = deferred();
		const held = admission.run(() => gate.promise);
		const queued = admission.run(async () => 1);
		const error = await rejection(admission.run(async () => 2));
		expect(error?.name).toBe("DbReadTaskOverloadedError");
		gate.resolve();
		await held;
		expect(await queued).toBe(1);
	});

	test("an aborted waiter leaves the queue without running its read", async () => {
		const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 4 });
		const gate = deferred();
		const held = admission.run(() => gate.promise);
		const controller = new AbortController();
		let ran = false;
		const waiting = admission.run(
			async () => {
				ran = true;
			},
			{ signal: controller.signal },
		);
		controller.abort();
		expect((await rejection(waiting))?.name).toBe("AbortError");
		expect(admission.stats.queued).toBe(0);
		gate.resolve();
		await held;
		expect(ran).toBe(false);
	});

	test("cancels the running read and keeps its slot until the read settles", async () => {
		const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 4 });
		const controller = new AbortController();
		const readGate = deferred();
		let context: AuthReadContext | undefined;
		const running = admission.run(
			async (ctx) => {
				context = ctx;
				await readGate.promise;
			},
			{ signal: controller.signal },
		);
		await Bun.sleep(0);
		controller.abort();
		expect((await rejection(running))?.name).toBe("AbortError");
		expect(context?.signal.aborted).toBe(true);
		expect(admission.stats.active).toBe(1);
		readGate.resolve();
		await Bun.sleep(0);
		expect(admission.stats.active).toBe(0);
	});

	test("one deadline covers queueing and the read, and is passed to the read", async () => {
		const admission = new AuthReadAdmission({ concurrency: 1, maxQueued: 4, timeoutMs: 40 });
		const gate = deferred();
		const held = admission.run(() => gate.promise);
		let ran = false;
		const waiting = admission.run(async () => {
			ran = true;
		});
		expect((await rejection(waiting))?.name).toBe("DbReadTaskTimeoutError");
		expect((await rejection(held))?.name).toBe("DbReadTaskTimeoutError");
		gate.resolve();
		await Bun.sleep(0);
		expect(ran).toBe(false);

		let budget = 0;
		await admission.run(async (ctx) => {
			budget = ctx.timeoutMs;
		});
		expect(budget).toBeGreaterThan(0);
		expect(budget).toBeLessThanOrEqual(40);
	});

	test("propagates read failures unchanged", async () => {
		const admission = new AuthReadAdmission();
		const failure = new Error("worker crashed");
		expect(await rejection(admission.run(() => Promise.reject(failure)))).toBe(failure);
	});
});
