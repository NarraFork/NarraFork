import { describe, expect, test } from "bun:test";
import {
	historyPreparationFailure,
	ModelHistoryPreparation,
	ModelHistoryTimeoutError,
} from "./model-history-preparation";

function harness(
	options: { deadline?: number; signal?: AbortSignal; timeoutMs?: number | null } = {},
) {
	let now = 100_000;
	const pending = new Map<number, { at: number; callback: () => void }>();
	let id = 0;
	const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const preparation = new ModelHistoryPreparation({
		narratorId: "budget-test",
		kind: "rebuild",
		...options,
		warn: (message, fields) => logs.push({ message, fields }),
		stallTimeBetween: () => ({ stalledMs: 200, maxStallMs: 120 }),
		clock: {
			wall: () => now,
			monotonic: () => now - 100_000,
			schedule(callback, delay) {
				const key = ++id;
				pending.set(key, { at: now + delay, callback });
				return () => {
					pending.delete(key);
				};
			},
		},
	});
	return {
		preparation,
		logs,
		pending,
		advance(ms: number, fire = true) {
			now += ms;
			if (fire)
				for (const [key, task] of pending)
					if (task.at <= now) {
						pending.delete(key);
						task.callback();
					}
		},
	};
}

describe("model history preparation budget", () => {
	test("observation-only phases do not introduce cancellation checkpoints", () => {
		const controller = new AbortController();
		const error = new Error("already interrupted");
		controller.abort(error);
		const h = harness({ signal: controller.signal, timeoutMs: null });
		expect(() => h.preparation.recordPhase("tools")).not.toThrow();
		h.advance(12);
		expect(() => h.preparation.recordPhase("systemPrompt")).not.toThrow();
		expect(() => h.preparation.phase("epoch")).toThrow(error);
		h.preparation.finish(error);
		expect(h.logs[0]?.fields).toMatchObject({
			outcome: "cancelled",
			phaseDurationsMs: { tools: 12, systemPrompt: 0 },
		});
	});
	test("10 seconds observes once without cancelling; 10–30 second success closes the same ID", () => {
		const h = harness();
		h.preparation.phase("queue");
		h.advance(9999);
		h.preparation.check();
		expect(h.logs).toHaveLength(0);
		h.advance(1);
		expect(h.logs).toHaveLength(1);
		expect(h.preparation.signal.aborted).toBe(false);
		h.preparation.phase("read");
		h.preparation.count("refs", 3);
		h.advance(12_000);
		h.preparation.check();
		h.preparation.finish();
		expect(h.logs).toHaveLength(2);
		expect(h.logs[1]?.fields).toMatchObject({
			preparationId: h.preparation.preparationId,
			outcome: "success",
			elapsedMs: 22_000,
			phaseDurationsMs: { queue: 10_000, read: 12_000 },
			counts: { refs: 3 },
			stalledMs: 200,
		});
		expect(h.logs[0]?.fields.preparationId).toBe(h.logs[1]?.fields.preparationId);
		expect(h.pending.size).toBe(0);
	});

	test("phase transitions share a single 30 second deadline and cancel supported IO", () => {
		const h = harness();
		h.advance(8000);
		h.preparation.phase("projection");
		expect(h.preparation.deadline).toBe(130_000);
		h.advance(21_999);
		h.preparation.check();
		h.advance(1);
		expect(h.preparation.signal.aborted).toBe(true);
		expect(() => h.preparation.check()).toThrow(ModelHistoryTimeoutError);
		h.preparation.finish(h.preparation.signal.reason);
		expect(h.logs.at(-1)?.fields.outcome).toBe("timeout");
		expect(h.pending.size).toBe(0);
	});

	test("late event-loop observation is recovered at a phase boundary and deduplicated", () => {
		const h = harness();
		h.advance(15_000, false);
		h.preparation.phase("attachments");
		expect(h.logs).toHaveLength(1);
		h.advance(0);
		h.preparation.finish();
		expect(h.logs).toHaveLength(2);
		expect(h.logs.at(-1)?.fields.outcome).toBe("success");
		expect(h.pending.size).toBe(0);
	});

	test("late completion observes even when no timer or phase callback ran", () => {
		const h = harness();
		h.advance(12_000, false);
		h.preparation.finish();
		h.preparation.finish();
		expect(h.logs).toHaveLength(2);
		expect(h.pending.size).toBe(0);
	});

	test("shorter external deadlines remain authoritative", () => {
		const h = harness({ deadline: 103_000 });
		h.advance(3000);
		expect(() => h.preparation.check()).toThrow("30s budget");
		h.preparation.finish(h.preparation.signal.reason);
		expect(h.logs).toHaveLength(1);
		expect(h.logs[0]?.fields.outcome).toBe("timeout");
		expect(h.pending.size).toBe(0);
	});

	test("user cancellation wins at deadline and is never classified as fallback timeout", () => {
		const controller = new AbortController();
		const h = harness({ signal: controller.signal });
		const error = new Error("secret user text");
		controller.abort(error);
		expect(h.pending.size).toBe(0);
		h.advance(30_000, false);
		expect(() => h.preparation.check()).toThrow(error);
		h.preparation.finish(error);
		expect(historyPreparationFailure(error)).toEqual({
			preparationId: h.preparation.preparationId,
			outcome: "cancelled",
		});
		expect(JSON.stringify(h.logs)).not.toContain(error.message);
		expect(h.pending.size).toBe(0);
	});

	test("unlimited preparation classifies wrapped source timeouts and preserves their cause", () => {
		const h = harness({ timeoutMs: null });
		const timeout = new ModelHistoryTimeoutError();
		const reader = new Error("Reader failed", { cause: timeout });
		const wrapper = new Error("Epoch publication failed", { cause: reader });
		h.preparation.finish(wrapper);
		expect(h.preparation.deadline).toBe(Infinity);
		expect(h.preparation.signal.aborted).toBe(false);
		expect(wrapper.cause).toBe(reader);
		expect(reader.cause).toBe(timeout);
		expect(h.logs.at(-1)?.fields.outcome).toBe("timeout");
		expect(historyPreparationFailure(wrapper)).toEqual({
			preparationId: h.preparation.preparationId,
			outcome: "timeout",
		});
		expect(historyPreparationFailure(new Error("Delivery failed", { cause: wrapper }))).toEqual(
			historyPreparationFailure(wrapper),
		);
		expect(h.pending.size).toBe(0);
	});

	test("cause inspection bounds deep chains and terminates cycles", () => {
		const timedOut = harness({ timeoutMs: null });
		const timeout = new ModelHistoryTimeoutError();
		timedOut.preparation.finish(timeout);
		let deep: Error = timeout;
		for (let index = 0; index < 32; index++) deep = new Error("Wrapped", { cause: deep });
		expect(historyPreparationFailure(deep)).toBeUndefined();
		const bounded = harness({ timeoutMs: null });
		bounded.preparation.finish(deep);
		expect(historyPreparationFailure(deep)?.outcome).toBe("failed");
		const first = new Error("First");
		const second = new Error("Second", { cause: first });
		Object.defineProperty(first, "cause", { value: second });
		expect(historyPreparationFailure(first)).toBeUndefined();
		const cyclic = harness({ timeoutMs: null });
		cyclic.preparation.finish(first);
		expect(historyPreparationFailure(second)?.outcome).toBe("failed");
		expect(cyclic.pending.size).toBe(0);
	});

	test("cause inspection leaves accessors unread", () => {
		const h = harness({ timeoutMs: null });
		const error = new Error("Accessor cause");
		let reads = 0;
		Object.defineProperty(error, "cause", {
			get() {
				reads++;
				throw new Error("Cause getter must stay unread");
			},
		});
		h.preparation.finish(error);
		expect(historyPreparationFailure(error)?.outcome).toBe("failed");
		expect(reads).toBe(0);
		expect(h.pending.size).toBe(0);
	});

	test("user cancellation takes precedence over a wrapped source timeout", () => {
		const controller = new AbortController();
		const h = harness({ timeoutMs: null, signal: controller.signal });
		const wrapper = new Error("Reader failed", { cause: new ModelHistoryTimeoutError() });
		controller.abort(new Error("User stopped"));
		h.preparation.finish(wrapper);
		expect(historyPreparationFailure(wrapper)?.outcome).toBe("cancelled");
		expect(h.logs.at(-1)?.fields.outcome).toBe("cancelled");
		expect(h.pending.size).toBe(0);
	});

	test("fast success is quiet; failure logs only identifiers, whitelisted counters and classification", () => {
		const fast = harness();
		fast.preparation.finish();
		expect(fast.logs).toHaveLength(0);
		expect(fast.pending.size).toBe(0);
		const failed = harness();
		const error = new Error("secret SQL parameters and prompt");
		failed.preparation.finish(error);
		expect(failed.logs[0]?.fields.outcome).toBe("failed");
		expect(JSON.stringify(failed.logs)).not.toContain(error.message);
		expect(failed.pending.size).toBe(0);
	});

	test("unlimited preparation observes once and progresses beyond the default budget", () => {
		const h = harness({ timeoutMs: null });
		expect(h.preparation.deadline).toBe(Infinity);
		// Only the observation timer is registered; Infinity must not reach setTimeout.
		expect(h.pending.size).toBe(1);
		expect([...h.pending.values()].every((task) => Number.isFinite(task.at))).toBe(true);
		h.advance(45_000);
		h.preparation.phase("projection");
		expect(h.preparation.signal.aborted).toBe(false);
		expect(h.logs).toHaveLength(1);
		h.preparation.finish();
		expect(h.logs.at(-1)?.fields.outcome).toBe("success");
		expect(h.pending.size).toBe(0);
	});

	test("unlimited preparation retains explicit source deadlines", () => {
		const h = harness({ timeoutMs: null, deadline: 103_000 });
		expect(h.preparation.deadline).toBe(103_000);
		h.advance(3000);
		expect(h.preparation.signal.aborted).toBe(true);
		expect(() => h.preparation.check()).toThrow(ModelHistoryTimeoutError);
		h.preparation.finish(h.preparation.signal.reason);
		expect(h.logs.at(-1)?.fields.outcome).toBe("timeout");
		expect(h.pending.size).toBe(0);
	});

	test("unlimited preparation propagates cancellation and releases observation", () => {
		const controller = new AbortController();
		const h = harness({ timeoutMs: null, signal: controller.signal });
		const error = new Error("User cancelled history preparation");
		controller.abort(error);
		expect(h.preparation.signal.reason).toBe(error);
		expect(() => h.preparation.check()).toThrow(error);
		expect(h.pending.size).toBe(0);
		h.preparation.finish(error);
		expect(historyPreparationFailure(error)?.outcome).toBe("cancelled");
	});

	test("unlimited preparation finish releases observation and parent listener", () => {
		const controller = new AbortController();
		const h = harness({ timeoutMs: null, signal: controller.signal });
		h.preparation.finish();
		h.preparation.finish();
		expect(h.pending.size).toBe(0);
		controller.abort();
		expect(h.preparation.signal.aborted).toBe(false);
		h.advance(60_000);
		expect(h.logs).toHaveLength(0);
	});

	test("a throwing observation sink preserves progress, cancellation and the original failure", () => {
		let now = 100_000;
		const controller = new AbortController();
		const preparation = new ModelHistoryPreparation({
			narratorId: "throwing-observer",
			kind: "projection",
			timeoutMs: null,
			signal: controller.signal,
			warn: () => {
				throw new Error("diagnostic sink failed");
			},
			clock: {
				wall: () => now,
				monotonic: () => now,
				schedule: () => () => {},
			},
		});
		now += 45_000;
		expect(() => preparation.phase("projection")).not.toThrow();
		expect(preparation.signal.aborted).toBe(false);
		const cancelled = new Error("original cancellation");
		controller.abort(cancelled);
		expect(() => preparation.check()).toThrow(cancelled);
		expect(() => preparation.finish(cancelled)).not.toThrow();
		expect(historyPreparationFailure(cancelled)?.outcome).toBe("cancelled");
	});

	test("completion removes the parent's cancellation listener", () => {
		const controller = new AbortController();
		const h = harness({ signal: controller.signal });
		h.preparation.finish();
		controller.abort();
		expect(h.preparation.signal.aborted).toBe(false);
		expect(h.pending.size).toBe(0);
	});
});
