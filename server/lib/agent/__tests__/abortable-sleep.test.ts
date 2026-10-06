import { describe, expect, test } from "bun:test";
import { abortableSleep } from "../abortable-sleep";

/**
 * An `AbortSignal` does not expose its listener count, so leak assertions go through a
 * stand-in that records `addEventListener` / `removeEventListener` and can still be handed to
 * the function under test. It reproduces only what `abortableSleep` uses.
 */
class RecordingSignal implements Pick<AbortSignal, "aborted"> {
	aborted = false;
	private listeners = new Set<() => void>();
	addCalls = 0;
	removeCalls = 0;

	addEventListener(_type: "abort", listener: () => void): void {
		this.addCalls++;
		this.listeners.add(listener);
	}

	removeEventListener(_type: "abort", listener: () => void): void {
		this.removeCalls++;
		this.listeners.delete(listener);
	}

	/** Listeners still attached — the quantity that used to grow without bound. */
	get liveListeners(): number {
		return this.listeners.size;
	}

	abort(): void {
		this.aborted = true;
		for (const listener of [...this.listeners]) {
			this.listeners.delete(listener);
			listener();
		}
	}

	asSignal(): AbortSignal {
		return this as unknown as AbortSignal;
	}
}

describe("abortableSleep", () => {
	test("resolves immediately when the signal is ALREADY aborted, attaching nothing", async () => {
		const signal = new RecordingSignal();
		signal.aborted = true;
		await abortableSleep(60_000, signal.asSignal());
		expect(signal.addCalls).toBe(0);
		expect(signal.liveListeners).toBe(0);
	});

	test("resolves early when aborted mid-wait", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const sleeping = abortableSleep(30_000, controller.signal);
		controller.abort();
		await sleeping;
		// The point is that it did not wait out the 30s timer.
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("waits roughly the requested duration when not aborted", async () => {
		const controller = new AbortController();
		const started = Date.now();
		await abortableSleep(40, controller.signal);
		expect(Date.now() - started).toBeGreaterThanOrEqual(30);
	});

	/**
	 * The regression: `{ once: true }` self-removes only when the event FIRES, and the timer
	 * winning is the common case. Every completed sleep left a listener on a signal that lives
	 * as long as the session, while a retry path may sleep unboundedly often.
	 */
	test("removes its abort listener after the timer wins", async () => {
		const signal = new RecordingSignal();
		await abortableSleep(1, signal.asSignal());
		expect(signal.addCalls).toBe(1);
		expect(signal.removeCalls).toBe(1);
		expect(signal.liveListeners).toBe(0);
	});

	test("does not accumulate listeners across many sleeps on ONE signal", async () => {
		const signal = new RecordingSignal();
		for (let i = 0; i < 200; i++) await abortableSleep(0, signal.asSignal());
		expect(signal.addCalls).toBe(200);
		// The invariant: attached listeners do not grow with the number of sleeps.
		expect(signal.liveListeners).toBe(0);
	});

	test("an abort after the timer already fired does not resolve twice or throw", async () => {
		const signal = new RecordingSignal();
		await abortableSleep(1, signal.asSignal());
		// The listener is gone, so this is a no-op rather than a call into a stale closure.
		expect(() => signal.abort()).not.toThrow();
		expect(signal.liveListeners).toBe(0);
	});
});
