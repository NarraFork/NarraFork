import { describe, expect, test } from "bun:test";
import { interleaveWakeups, STREAM_WAKEUP, WakeSignal } from "../stream-wakeups";

function controllableSource<T>() {
	const pending: Array<PromiseWithResolvers<IteratorResult<T>>> = [];
	let returned = false;
	const iterator: AsyncIterator<T> = {
		next: () => {
			const next = Promise.withResolvers<IteratorResult<T>>();
			pending.push(next);
			return next.promise;
		},
		return: async () => {
			returned = true;
			return { done: true, value: undefined };
		},
	};
	return {
		source: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<T>,
		emit: (value: T) => pending.shift()?.resolve({ done: false, value }),
		end: () => pending.shift()?.resolve({ done: true, value: undefined }),
		get reads() {
			return pending.length;
		},
		get returned() {
			return returned;
		},
	};
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("interleaveWakeups", () => {
	test("passes events through in order and yields a wakeup while the source is idle", async () => {
		const src = controllableSource<string>();
		const wake = new WakeSignal();
		const iterator = interleaveWakeups(src.source, wake)[Symbol.asyncIterator]();

		const first = iterator.next();
		await tick();
		src.emit("a");
		expect(await first).toEqual({ done: false, value: "a" });

		const second = iterator.next();
		await tick();
		wake.notify();
		expect(await second).toEqual({ done: false, value: STREAM_WAKEUP });

		// The read that was in flight during the wakeup is reused, not re-requested.
		const third = iterator.next();
		await tick();
		expect(src.reads).toBe(1);
		src.emit("b");
		expect(await third).toEqual({ done: false, value: "b" });

		const fourth = iterator.next();
		await tick();
		src.end();
		expect(await fourth).toEqual({ done: true, value: undefined });
	});

	test("notifications raised while the consumer is busy coalesce into one wakeup", async () => {
		const src = controllableSource<string>();
		const wake = new WakeSignal();
		wake.notify();
		wake.notify();
		const iterator = interleaveWakeups(src.source, wake)[Symbol.asyncIterator]();

		expect(await iterator.next()).toEqual({ done: false, value: STREAM_WAKEUP });
		const next = iterator.next();
		await tick();
		src.emit("a");
		expect(await next).toEqual({ done: false, value: "a" });
	});

	test("leaving during a pending read does not wait for the source", async () => {
		const src = controllableSource<string>();
		const wake = new WakeSignal();
		const iterator = interleaveWakeups(src.source, wake)[Symbol.asyncIterator]();
		const first = iterator.next();
		await tick();
		wake.notify();
		await first;

		// The source never answers its pending read; return() must still settle.
		expect(await iterator.return?.(undefined)).toEqual({ done: true, value: undefined });
		await tick();
		expect(src.returned).toBe(true);
	});
});
