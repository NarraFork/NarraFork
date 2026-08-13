/**
 * injection-cadence.test.ts — the "every N completed tool calls" gate.
 *
 * This replaces three hand-rolled counters that disagreed on the empty case (a cadence
 * that comes due but produces nothing). The tests below pin the resolution of that
 * disagreement, because getting it wrong is not a cosmetic bug: the losing behaviour
 * re-reads a spec file from SQLite on the main thread for every subsequent tool call,
 * for the life of the session.
 */

import { describe, expect, it } from "bun:test";
import { InjectionCadence, normalizeCadenceInterval } from "../injection-cadence";

/** A cadence with a fixed interval. */
const fixed = (interval: number, initial = 0) => new InjectionCadence(() => interval, initial);

describe("InjectionCadence — firing", () => {
	it("fires once the interval has elapsed, not before", () => {
		const cadence = fixed(3);
		expect(cadence.due(1)).toBe(false);
		expect(cadence.due(2)).toBe(false);
		expect(cadence.due(3)).toBe(true);
	});

	it("fires again only after another full interval", () => {
		const cadence = fixed(3);
		expect(cadence.due(3)).toBe(true);
		expect(cadence.due(4)).toBe(false);
		expect(cadence.due(5)).toBe(false);
		expect(cadence.due(6)).toBe(true);
	});

	it("fires at most once per tick, so a per-tool-result caller is safe", () => {
		// The gate is consumed by asking. Two producers checking the same tick (or one
		// producer checked twice) must not both fire.
		const cadence = fixed(2);
		expect(cadence.due(2)).toBe(true);
		expect(cadence.due(2)).toBe(false);
	});

	it("handles a jump larger than the interval without firing repeatedly", () => {
		// Parallel tool groups can advance the count by several at once.
		const cadence = fixed(3);
		expect(cadence.due(10)).toBe(true);
		expect(cadence.due(11)).toBe(false);
		expect(cadence.due(13)).toBe(true);
	});

	it("an interval of 1 fires on every tick", () => {
		const cadence = fixed(1);
		expect(cadence.due(1)).toBe(true);
		expect(cadence.due(2)).toBe(true);
		expect(cadence.due(3)).toBe(true);
	});
});

describe("InjectionCadence — the empty case", () => {
	it("spends the tick even when the caller produces nothing", () => {
		// THE bug this helper removes. `subagent-executor` advanced its marker only after
		// a successful build, so an empty spec left the cadence permanently due and hit
		// SQLite on every following tool result. Asking is consuming.
		const cadence = fixed(5);
		expect(cadence.due(5)).toBe(true); // caller then finds nothing to inject
		expect(cadence.due(6)).toBe(false); // must NOT still be due
		expect(cadence.due(9)).toBe(false);
		expect(cadence.due(10)).toBe(true);
	});
});

describe("InjectionCadence — disabled", () => {
	it("never fires when the interval is the documented off value", () => {
		const cadence = fixed(-1);
		for (const n of [1, 5, 100, 10_000]) expect(cadence.due(n)).toBe(false);
	});

	it("never fires on zero, which would otherwise mean every tick", () => {
		// Not a configured value, but a mis-set config can produce it and "fire on every
		// tool result" is never the intent.
		const cadence = fixed(0);
		expect(cadence.due(1)).toBe(false);
		expect(cadence.due(50)).toBe(false);
	});

	it("does not consume ticks while disabled, so enabling later starts clean", () => {
		let interval = -1;
		const cadence = new InjectionCadence(() => interval);
		expect(cadence.due(50)).toBe(false);
		interval = 3;
		// The marker never moved, so it is immediately due — correct: the operator just
		// turned this on and expects the next boundary to deliver.
		expect(cadence.due(51)).toBe(true);
	});
});

describe("InjectionCadence — live interval", () => {
	it("re-reads the interval on every check so a settings change lands at once", () => {
		let interval = 10;
		const cadence = new InjectionCadence(() => interval);
		expect(cadence.due(5)).toBe(false);
		interval = 4;
		expect(cadence.due(5)).toBe(true);
	});

	it("a lengthened interval defers the next fire from the last one", () => {
		let interval = 2;
		const cadence = new InjectionCadence(() => interval);
		expect(cadence.due(2)).toBe(true);
		interval = 8;
		expect(cadence.due(4)).toBe(false);
		expect(cadence.due(10)).toBe(true);
	});
});

describe("InjectionCadence — resumed sessions", () => {
	it("starts from the persisted count instead of treating history as overdue", () => {
		// Callers persist the completed-tool count across loop runs. Starting from 0
		// would make a resumed session fire on its very first tool result.
		const cadence = fixed(15, 100);
		expect(cadence.due(101)).toBe(false);
		expect(cadence.due(114)).toBe(false);
		expect(cadence.due(115)).toBe(true);
	});

	it("rebase moves the marker without firing", () => {
		// For the caller that learns its true starting count only on the first tool
		// result (narrator-session initialises its markers lazily).
		const cadence = fixed(5);
		cadence.rebase(40);
		expect(cadence.lastFired).toBe(40);
		expect(cadence.due(42)).toBe(false);
		expect(cadence.due(45)).toBe(true);
	});

	it("exposes the last fired tick for persistence", () => {
		const cadence = fixed(4);
		expect(cadence.lastFired).toBe(0);
		cadence.due(7);
		expect(cadence.lastFired).toBe(7);
	});
});

describe("InjectionCadence — external marker storage", () => {
	it("reads and writes the caller's marker instead of owning one", () => {
		// What `narrator-session` needs: the marker lives on the ActiveNarrator so it
		// survives across loop passes, which each rebuild the agent config.
		const store = { marker: 0 };
		const cadence = new InjectionCadence(() => 3, {
			get: () => store.marker,
			set: (count) => {
				store.marker = count;
			},
		});
		expect(cadence.due(2)).toBe(false);
		expect(store.marker).toBe(0);
		expect(cadence.due(3)).toBe(true);
		expect(store.marker).toBe(3);
	});

	it("a rebuilt cadence resumes from the stored marker, not from zero", () => {
		// The actual regression this guards: a per-pass cadence object that restarted at
		// zero would fire on the first tool result of every pass.
		const store = { marker: 0 };
		const storage = {
			get: () => store.marker,
			set: (count: number) => {
				store.marker = count;
			},
		};
		expect(new InjectionCadence(() => 5, storage).due(5)).toBe(true);
		// New object, same storage — as happens on the next loop pass.
		expect(new InjectionCadence(() => 5, storage).due(6)).toBe(false);
		expect(new InjectionCadence(() => 5, storage).due(10)).toBe(true);
	});

	it("rebase writes through to the caller's storage", () => {
		const store = { marker: 0 };
		const cadence = new InjectionCadence(() => 5, {
			get: () => store.marker,
			set: (count) => {
				store.marker = count;
			},
		});
		cadence.rebase(40);
		expect(store.marker).toBe(40);
		expect(cadence.due(42)).toBe(false);
	});

	it("two cadences sharing one tick stream keep separate markers", () => {
		// The tasks digest and the behaviour fence both live on the ActiveNarrator but in
		// different fields; crossing them would let one consume the other's ticks.
		const store = { tasks: 0, fence: 0 };
		const tasks = new InjectionCadence(() => 3, {
			get: () => store.tasks,
			set: (c) => {
				store.tasks = c;
			},
		});
		const fence = new InjectionCadence(() => 5, {
			get: () => store.fence,
			set: (c) => {
				store.fence = c;
			},
		});
		for (let n = 1; n <= 6; n++) {
			tasks.due(n);
			fence.due(n);
		}
		expect(store.tasks).toBe(6);
		expect(store.fence).toBe(5);
	});
});

describe("InjectionCadence — independence", () => {
	it("two cadences on different intervals do not consume each other's ticks", () => {
		// The Dynamic Spec digest and the behaviour fence share a tick stream but must
		// fire on their own schedules — this is why they get separate instances.
		const tasks = fixed(3);
		const fence = fixed(5);
		const firedTasks: number[] = [];
		const firedFence: number[] = [];
		for (let n = 1; n <= 15; n++) {
			if (tasks.due(n)) firedTasks.push(n);
			if (fence.due(n)) firedFence.push(n);
		}
		expect(firedTasks).toEqual([3, 6, 9, 12, 15]);
		expect(firedFence).toEqual([5, 10, 15]);
	});
});

describe("normalizeCadenceInterval", () => {
	it("keeps positive integers", () => {
		expect(normalizeCadenceInterval(15)).toBe(15);
		expect(normalizeCadenceInterval(1)).toBe(1);
	});

	it("floors a fractional value to match the integer counter", () => {
		expect(normalizeCadenceInterval(4.7)).toBe(4);
	});

	it("maps every off-ish value to -1", () => {
		for (const value of [-1, 0, -50, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
			expect(normalizeCadenceInterval(value as number)).toBe(-1);
		}
	});
});
