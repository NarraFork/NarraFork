import { describe, expect, test } from "bun:test";
import { NarraForkEventBus } from "../event-bus";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const event = {
	type: "narrator:status_changed",
	narratorId: "shutdown-test",
	status: "idle",
} as const;

describe("event bus shutdown ownership", () => {
	test("emit stays synchronous and drain includes nested asynchronous listeners", async () => {
		const bus = new NarraForkEventBus();
		const first = deferred();
		const second = deferred();
		let calls = 0;
		bus.onAny(async () => {
			calls++;
			if (calls === 1) {
				await first.promise;
				bus.emit(event);
			} else await second.promise;
		});
		bus.beginShutdown();
		expect(bus.emit(event)).toBeUndefined();
		expect(calls).toBe(1);
		let drained = false;
		const drain = bus.drainForShutdown(new AbortController().signal).then(() => {
			drained = true;
		});
		first.resolve();
		await first.promise;
		await Promise.resolve();
		expect(calls).toBe(2);
		expect(drained).toBe(false);
		second.resolve();
		await drain;
		expect(bus.getShutdownState().pending).toBe(0);
	});

	test("records synchronous and async failures only in the shutdown window", async () => {
		const bus = new NarraForkEventBus();
		const error = new Error("listener failed");
		bus.onAny(() => {
			throw error;
		});
		bus.emit(event);
		expect(bus.getShutdownState().failureCount).toBe(0);
		bus.beginShutdown();
		bus.onAny(async () => {
			throw new Error("async failed");
		});
		bus.emit(event);
		await bus.drainForShutdown(new AbortController().signal);
		expect(bus.getShutdownState()).toEqual({ pending: 0, failureCount: 2, firstError: error });
	});

	test("aborted drain retains actual pending ownership", async () => {
		const bus = new NarraForkEventBus();
		const gate = deferred();
		bus.onAny(() => gate.promise);
		bus.emit(event);
		const controller = new AbortController();
		const drain = bus.drainForShutdown(controller.signal);
		controller.abort(new Error("deadline"));
		await expect(drain).rejects.toThrow("deadline");
		expect(bus.getShutdownState().pending).toBe(1);
		gate.resolve();
		await bus.drainForShutdown(new AbortController().signal);
		expect(bus.getShutdownState().pending).toBe(0);
	});
});
